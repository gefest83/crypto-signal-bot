import { v } from "convex/values";

import { action } from "./_generated/server";

/**
 * Live RetMag evaluation, from real 1-second candles.
 *
 * WHY AN ACTION
 * -------------
 * Convex only allows outbound `fetch` from an action, and this handler reads
 * Binance's 1-second klines. They have to be 1-second: the decision is taken
 * 20 seconds into the round, and a 1-minute candle is a 60x coarser instrument
 * than the thing being measured. The local cache holds two days of 1s data and
 * thirty days of 1m, and that ratio — not the code — is what capped the
 * historical sample at 576 rounds per asset.
 *
 * FAIL-CLOSED, DELIBERATELY
 * ------------------------
 * The failure mode that matters here is not a crash, it is a plausible number
 * built from nothing. Two defaults are therefore non-negotiable:
 *
 *   - a missing candle yields `signal: "hold"` with `complete: false`, never a
 *     directional call. Substituting the last known close would produce a real
 *     looking decision from stale data;
 *   - an incomplete window is reported as such rather than computed on partial
 *     volume, because a 20-second imbalance measured over 8 seconds is a
 *     different quantity that happens to print a similar number.
 */

import {
  ENTRY_OFFSET_MS,
  FLOW_WINDOW_MS,
  MAX_CONTRACT_PRICE,
  decideRetMag,
} from "../lib/retmag/rule";

/**
 * Binance's public market-data host.
 *
 * NOT `api.binance.com`: that host answers 451 "Service unavailable from a
 * restricted location" to server-side requests, so a Convex action reading it
 * gets an empty object instead of candles. `data-api.binance.vision` is the
 * same public market-data API without the regional restriction, verified to
 * return 1-second klines. Verified 200 with real rows, not assumed.
 */
const BINANCE = "https://data-api.binance.vision/api/v3/klines";

type Candle = {
  openTime: number;
  close: number;
  volume: number;
  takerBuyBase: number;
};

async function fetchCandles(
  symbol: string,
  startMs: number,
  endMs: number,
): Promise<Candle[]> {
  const url = `${BINANCE}?symbol=${symbol}&interval=1s&startTime=${startMs}&endTime=${endMs}&limit=1000`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`binance ${response.status}`);
  const raw = (await response.json()) as unknown;
  // A restricted-location 451 comes back as a 200 with an object body, not an
  // array. Treating that as "no candles" would be right; treating it as an
  // array would throw somewhere much less obvious.
  if (!Array.isArray(raw)) throw new Error("binance вернул не массив свечей");
  return raw.map((row) => {
    const k = row as unknown[];
    return {
      openTime: Number(k[0]),
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: Number(k[5]),
      closeTime: Number(k[6]),
      takerBuyBase: Number(k[9]),
    } as Candle & { open: number; high: number; low: number; closeTime: number };
  });
}

export type LiveSignal = {
  asset: "btc" | "eth";
  symbol: string;
  roundStart: number;
  signal: "up" | "down" | "hold";
  imb: number | null;
  ret20Bps: number | null;
  detail: string;
  /** False when the window was short or a candle was missing. */
  complete: boolean;
  candles: number;
  /** Price at the decision point, for reference against the book. */
  spotAtDecision: number | null;
  spotAtStart: number | null;
};

const SYMBOL: Record<"btc" | "eth", string> = { btc: "BTCUSDT", eth: "ETHUSDT" };

/**
 * Evaluate the rule for one round.
 *
 * `roundStartMs` is the round's start; the decision point is +20s and the flow
 * window is the 30s ending there.
 */
export const evaluate = action({
  args: {
    asset: v.union(v.literal("btc"), v.literal("eth")),
    roundStartMs: v.number(),
  },
  handler: async (_ctx, args): Promise<LiveSignal> => {
    const symbol = SYMBOL[args.asset];
    const base: LiveSignal = {
      asset: args.asset,
      symbol,
      roundStart: Math.floor(args.roundStartMs / 1000),
      signal: "hold",
      imb: null,
      ret20Bps: null,
      detail: "",
      complete: false,
      candles: 0,
      spotAtDecision: null,
      spotAtStart: null,
    };

    const t = args.roundStartMs + ENTRY_OFFSET_MS;
    // A little margin on the left so the first candle of the window is present.
    const from = t - FLOW_WINDOW_MS - 2_000;

    let candles: Candle[];
    try {
      candles = await fetchCandles(symbol, from, t);
    } catch (error) {
      return { ...base, detail: `свечи не пришли: ${(error as Error).message}` };
    }

    if (candles.length === 0) {
      return { ...base, detail: "нет свечей за окно решения" };
    }

    // Window is half-open on the left: (t - 30s, t].
    const lo = t - FLOW_WINDOW_MS;
    const inWindow = candles.filter((c) => c.openTime > lo && c.openTime <= t);
    const atDecision = candles.filter((c) => c.openTime <= t).pop() ?? null;
    const atStart = candles.find((c) => c.openTime >= args.roundStartMs) ?? null;

    if (!atDecision || !atStart) {
      return {
        ...base,
        candles: candles.length,
        detail: "нет свечи на точке решения или на старте раунда",
      };
    }

    const buy = inWindow.reduce((s, c) => s + c.takerBuyBase, 0);
    const vol = inWindow.reduce((s, c) => s + c.volume, 0);

    // Short window is reported, never quietly computed on. A 30s imbalance
    // measured over 8s is a different quantity that prints a similar number.
    const expected = Math.floor(FLOW_WINDOW_MS / 1000);
    if (inWindow.length < expected * 0.8) {
      return {
        ...base,
        candles: candles.length,
        spotAtDecision: atDecision.close,
        spotAtStart: atStart.close,
        detail: `окно неполное: ${inWindow.length} из ~${expected} свечей`,
      };
    }

    const decision = decideRetMag(
      { buy, vol, close: atDecision.close, ref: atStart.close },
      { maxContractPrice: MAX_CONTRACT_PRICE[args.asset] },
    );

    return {
      ...base,
      signal: decision.signal,
      imb: decision.imb,
      ret20Bps: decision.ret20Bps,
      detail: decision.detail,
      complete: true,
      candles: candles.length,
      spotAtDecision: atDecision.close,
      spotAtStart: atStart.close,
    };
  },
});
