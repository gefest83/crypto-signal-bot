import { api } from "@/convex/_generated/api";
import { pmRoundStart, type PmAsset, type PmRound } from "@/convex/polymarket";
import type { FeedStatus } from "@/lib/market/binance";
import { MARKET_SYMBOLS, type MarketSymbol } from "@/lib/market/types";
import { evaluateSignal, type SignalReadout } from "@/lib/strategy/engine";
import { ENTRY_END_MS, evaluateEntry, type EntryReadout } from "@/lib/strategy/entry";
import { useMutation, useQuery } from "convex/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMarketFeed } from "./use-market-feed";
import { useNow } from "./use-now";

export type RoundStatus = "warming" | "scanning" | "locked" | "closed";

/** Which Binance feed confirms (or contradicts) each Polymarket market. */
const ASSET_OF_SYMBOL: Record<MarketSymbol, PmAsset> = {
  BTCUSDT: "btc",
  ETHUSDT: "eth",
};
const SYMBOL_OF_ASSET: Record<PmAsset, MarketSymbol> = {
  btc: "BTCUSDT",
  eth: "ETHUSDT",
};
const ASSETS: PmAsset[] = ["btc", "eth"];

/** How often the Polymarket book is re-read, in milliseconds. */
const BOOK_POLL_MS = 5_000;
/** How often open calls are graded against Polymarket's published result. */
const RESOLVE_POLL_MS = 20_000;
const ROUND_MS = 5 * 60_000;

export type SignalConsole = {
  /** Real market state per asset, straight from Polymarket. */
  rounds: Partial<Record<PmAsset, PmRound | null>>;
  /** Live verdict per asset from the entry rule. */
  entries: Partial<Record<PmAsset, EntryReadout>>;
  /** Independent Binance candle read, used only as confirmation. */
  engine: Partial<Record<PmAsset, SignalReadout>>;
  /** The call that was locked for the current round, if any. */
  locks: Partial<Record<PmAsset, EntryReadout>>;
  status: Record<PmAsset, RoundStatus>;
  /** Binance spot price per symbol, context only. */
  spot: Partial<Record<MarketSymbol, number>>;
  feedStatus: FeedStatus;
  feedDetail: string;
  now: number;
  start: number;
  end: number;
};

export function useSignalConsole(): SignalConsole {
  const { candles, prices, status: feedStatus, detail: feedDetail } = useMarketFeed();
  const now = useNow(1000);
  // Polymarket slugs are keyed by interval start in unix SECONDS, while the
  // entry rule works in milliseconds — keep the two apart deliberately.
  const startSec = pmRoundStart(now);
  const start = startSec * 1000;
  const tick = Math.floor(now / BOOK_POLL_MS);

  const btcRound = useQuery(api.polymarket.pmRound, {
    asset: "btc",
    start: startSec,
    _tick: tick,
  });
  const ethRound = useQuery(api.polymarket.pmRound, {
    asset: "eth",
    start: startSec,
    _tick: tick,
  });
  const rounds = useMemo(
    () => ({ btc: btcRound ?? null, eth: ethRound ?? null }),
    [btcRound, ethRound],
  );

  const logSignal = useMutation(api.signals.logSignal);
  const syncResolutions = useMutation(api.signals.syncResolutions);

  /**
   * The Binance candle engine is no longer the decision — it is a second,
   * independent opinion used to veto an entry that contradicts it.
   */
  const engine = useMemo(() => {
    const map: Partial<Record<PmAsset, SignalReadout>> = {};
    for (const symbol of MARKET_SYMBOLS) {
      const asset = ASSET_OF_SYMBOL[symbol];
      const symbolCandles = candles[symbol];
      const price = prices[symbol];
      if (!symbolCandles || price === undefined) continue;
      const readout = evaluateSignal({ symbol, candles: symbolCandles, price, now });
      if (readout) map[asset] = readout;
    }
    return map;
  }, [candles, prices, now]);

  const confirmations = useMemo(() => {
    const map: Partial<Record<PmAsset, "up" | "down" | "stand-aside">> = {};
    for (const [asset, readout] of Object.entries(engine)) {
      map[asset as PmAsset] = readout.direction;
    }
    return map;
  }, [engine]);

  const entries = useMemo(() => {
    const map: Partial<Record<PmAsset, EntryReadout>> = {};
    for (const asset of ASSETS) {
      const round = rounds[asset];
      map[asset] = evaluateEntry({
        start,
        now,
        upAsk: round?.upAsk ?? null,
        upBid: round?.upBid ?? null,
        downAsk: round?.downAsk ?? null,
        downBid: round?.downBid ?? null,
        confirm: confirmations[asset] ?? null,
      });
    }
    return map;
  }, [rounds, confirmations, now, start]);

  /**
   * A lock is immutable for the rest of the round: the journal must record what
   * was actually callable at the time, not the best price seen later. State
   * (not a ref) so the console re-renders the moment a call is published.
   */
  const [locks, setLocks] = useState<Partial<Record<PmAsset, EntryReadout>>>({});
  const locksRef = useRef(locks);

  useEffect(() => {
    const previous = locksRef.current;
    const next: Partial<Record<PmAsset, EntryReadout>> = {};
    for (const asset of ASSETS) {
      const readout = entries[asset];
      const existing = previous[asset];
      if (!readout) {
        next[asset] = existing;
        continue;
      }
      // Same round → keep the lock; a stale readout must never rewrite it.
      if (existing && readout.start <= existing.start) {
        next[asset] = existing;
        continue;
      }
      if (!readout.eligible || readout.direction === "stand-aside" || readout.ask === null) {
        next[asset] = undefined;
        continue;
      }

      next[asset] = readout;
      const round = rounds[asset];
      const tokenId = readout.direction === "up" ? round?.upTokenId : round?.downTokenId;
      void logSignal({
        symbol: SYMBOL_OF_ASSET[asset],
        windowStart: readout.start,
        windowEnd: readout.end,
        marketSlug: round?.slug,
        tokenId: tokenId ?? undefined,
        direction: readout.direction,
        entryBid: readout.bid ?? undefined,
        entryAsk: readout.ask,
        entryLimitPrice: readout.ask,
        maxEntryPrice: readout.ask,
        phaseAtSignal: "early",
        notes: [readout.reason],
      }).catch((error: unknown) => {
        console.warn("[signal-console] could not journal the signal", error);
      });
    }

    const changed = ASSETS.some((asset) => next[asset] !== previous[asset]);
    if (changed) {
      locksRef.current = next;
      setLocks(next);
    }
  }, [entries, rounds, logSignal]);

  // Grade open calls against Polymarket's own result.
  const lastSyncRef = useRef(0);
  useEffect(() => {
    if (now - lastSyncRef.current < RESOLVE_POLL_MS) return;
    lastSyncRef.current = now;
    void syncResolutions({ limit: 20 }).catch((error: unknown) => {
      console.warn("[signal-console] could not sync resolutions", error);
    });
  }, [now, syncResolutions]);

  const status = useMemo(() => {
    const map = {} as Record<PmAsset, RoundStatus>;
    for (const asset of ASSETS) {
      const readout = entries[asset];
      if (!rounds[asset]) map[asset] = "warming";
      else if (locks[asset]) map[asset] = "locked";
      else if (readout && now - readout.start >= ENTRY_END_MS) map[asset] = "closed";
      else map[asset] = "scanning";
    }
    return map;
  }, [entries, rounds, locks, now]);

  return {
    rounds,
    entries,
    engine,
    locks,
    status,
    spot: prices,
    feedStatus,
    feedDetail,
    now,
    start,
    end: start + ROUND_MS,
  };
}
