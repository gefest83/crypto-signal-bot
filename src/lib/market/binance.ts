/**
 * Binance public market data feed.
 *
 * The console needs two things from the exchange: 1-minute candles for the
 * strategy and the latest traded price between candle closes. Public endpoints
 * are used, so no API keys are involved — and everything runs in the browser,
 * which also avoids the geo-restrictions that hit server-side calls.
 *
 * Reliability order: WebSocket stream first, REST polling as a fallback, and a
 * periodic REST resync while live so a dropped candle can never silently drift
 * the strategy.
 */

import { isMarketSymbol, type Candle, type MarketSymbol } from "./types";

const REST_BASES = [
  "https://data-api.binance.vision",
  "https://api.binance.com",
  "https://api-gcp.binance.com",
];

const WS_BASES = [
  "wss://data-stream.binance.vision/stream",
  "wss://stream.binance.com:9443/stream",
];

const KLINE_LIMIT = 200;

export type FeedStatus = "connecting" | "live" | "degraded" | "offline";

export type KlineQuery = {
  interval?: string;
  limit?: number;
  startTime?: number;
  endTime?: number;
};

type RestKline = [
  number,
  string,
  string,
  string,
  string,
  string,
  number,
  string,
  number,
  string,
  string,
  string,
];

function parseKline(row: RestKline): Candle {
  return {
    openTime: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
    closeTime: Number(row[6]),
    quoteVolume: Number(row[7]),
    trades: Number(row[8]),
    takerBuyBase: Number(row[9]),
    takerBuyQuote: Number(row[10]),
  };
}

function abortAfter(ms: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  };
}

/** Fetch 1-minute candles from the first reachable public REST endpoint. */
export async function fetchKlines(
  symbol: MarketSymbol,
  query: KlineQuery = {},
): Promise<Candle[]> {
  const params = new URLSearchParams({
    symbol,
    interval: query.interval ?? "1m",
    limit: String(query.limit ?? 20),
  });
  if (query.startTime !== undefined) params.set("startTime", String(query.startTime));
  if (query.endTime !== undefined) params.set("endTime", String(query.endTime));

  let lastError: unknown = null;
  for (const base of REST_BASES) {
    const timeout = abortAfter(8000);
    try {
      const response = await fetch(`${base}/api/v3/klines?${params.toString()}`, {
        signal: timeout.signal,
      });
      if (!response.ok) {
        lastError = new Error(`${base} responded ${response.status}`);
        continue;
      }
      const rows = (await response.json()) as RestKline[];
      return rows.map(parseKline);
    } catch (error) {
      lastError = error;
    } finally {
      timeout.clear();
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Binance klines unavailable for ${symbol}`);
}

export type MarketFeedHandlers = {
  /** Full candle history for a symbol (bootstrap + periodic resync). */
  onSnapshot: (symbol: MarketSymbol, candles: Candle[]) => void;
  /** A single candle was created or updated by the live stream. */
  onCandle: (symbol: MarketSymbol, candle: Candle) => void;
  /** Latest traded price, emitted roughly once per second. */
  onPrice: (symbol: MarketSymbol, price: number) => void;
  onStatus: (status: FeedStatus, detail?: string) => void;
};

export class MarketFeed {
  private symbols: MarketSymbol[];
  private handlers: MarketFeedHandlers;
  private socket: WebSocket | null = null;
  private baseIndex = 0;
  private attempts = 0;
  private resyncTimer: number | null = null;
  private pollTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private stopped = true;
  private mode: "socket" | "poll" = "socket";

  constructor(symbols: MarketSymbol[], handlers: MarketFeedHandlers) {
    this.symbols = symbols;
    this.handlers = handlers;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.mode = "socket";
    this.handlers.onStatus("connecting");
    void this.resync();
    this.openSocket();
    this.resyncTimer = window.setInterval(() => void this.resync(), 60_000);
  }

  stop() {
    this.stopped = true;
    this.clearTimers();
    if (this.socket) {
      this.socket.onclose = null;
      this.socket.onerror = null;
      this.socket.onmessage = null;
      try {
        this.socket.close();
      } catch {
        /* already closed */
      }
      this.socket = null;
    }
  }

  private clearTimers() {
    if (this.resyncTimer !== null) window.clearInterval(this.resyncTimer);
    if (this.pollTimer !== null) window.clearInterval(this.pollTimer);
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.resyncTimer = null;
    this.pollTimer = null;
    this.reconnectTimer = null;
  }

  private streamUrl() {
    const streams = this.symbols.flatMap((symbol) => {
      const lower = symbol.toLowerCase();
      return [`${lower}@kline_1m`, `${lower}@miniTicker`];
    });
    return `${WS_BASES[this.baseIndex % WS_BASES.length]}/stream?streams=${streams.join("/")}`;
  }

  private openSocket() {
    if (this.stopped || this.mode !== "socket") return;
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.streamUrl());
    } catch {
      this.fallbackToPolling();
      return;
    }
    this.socket = socket;

    const handshake = window.setTimeout(() => {
      if (this.socket === socket && socket.readyState !== WebSocket.OPEN) {
        socket.close();
      }
    }, 9000);

    socket.onopen = () => {
      window.clearTimeout(handshake);
      this.attempts = 0;
      this.handlers.onStatus("live");
    };
    socket.onmessage = (event: MessageEvent) => this.handleMessage(event.data);
    socket.onerror = () => window.clearTimeout(handshake);
    socket.onclose = () => {
      window.clearTimeout(handshake);
      if (this.stopped) return;
      this.attempts += 1;
      this.baseIndex += 1;
      if (this.attempts >= 3) {
        this.fallbackToPolling();
        return;
      }
      const delay = Math.min(1000 * 2 ** (this.attempts - 1), 6000);
      this.handlers.onStatus("connecting", "Переподключение к потоку…");
      this.reconnectTimer = window.setTimeout(() => this.openSocket(), delay);
    };
  }

  private fallbackToPolling() {
    if (this.stopped || this.mode === "poll") return;
    this.mode = "poll";
    if (this.socket) {
      this.socket.onclose = null;
      try {
        this.socket.close();
      } catch {
        /* ignore */
      }
      this.socket = null;
    }
    this.handlers.onStatus("degraded", "Поток недоступен — опрос REST каждые 3 с");
    void this.resync();
    this.pollTimer = window.setInterval(() => void this.resync(), 3000);
  }

  private async resync() {
    if (this.stopped) return;
    let failures = 0;
    for (const symbol of this.symbols) {
      try {
        const candles = await fetchKlines(symbol, { limit: KLINE_LIMIT });
        if (candles.length > 0) {
          this.handlers.onSnapshot(symbol, candles);
          this.handlers.onPrice(symbol, candles[candles.length - 1].close);
        }
      } catch {
        failures += 1;
      }
    }
    if (failures === this.symbols.length) {
      this.handlers.onStatus("offline", "Нет связи с Binance — проверь сеть");
    } else if (this.mode === "poll") {
      this.handlers.onStatus("degraded", "Поток недоступен — опрос REST каждые 3 с");
    }
  }

  private handleMessage(raw: unknown) {
    if (typeof raw !== "string") return;
    let payload: { stream?: string; data?: unknown };
    try {
      payload = JSON.parse(raw) as { stream?: string; data?: unknown };
    } catch {
      return;
    }
    const data = payload.data as Record<string, unknown> | undefined;
    if (!data || typeof data !== "object") return;

    const symbol = String(data.s ?? "").toUpperCase();
    if (!isMarketSymbol(symbol)) return;

    const eventType = String(data.e ?? "");
    if (eventType === "kline") {
      const k = data.k as Record<string, unknown> | undefined;
      if (!k) return;
      this.handlers.onCandle(symbol, {
        openTime: Number(k.t),
        open: Number(k.o),
        high: Number(k.h),
        low: Number(k.l),
        close: Number(k.c),
        volume: Number(k.v),
        closeTime: Number(k.T),
        quoteVolume: Number(k.q),
        trades: Number(k.n),
        takerBuyBase: Number(k.V),
        takerBuyQuote: Number(k.Q),
      });
      return;
    }

    if (eventType === "24hrMiniTicker") {
      const price = Number(data.c);
      if (Number.isFinite(price) && price > 0) {
        this.handlers.onPrice(symbol, price);
      }
    }
  }
}
