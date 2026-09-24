import { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";
import { fetchKlines, type FeedStatus } from "@/lib/market/binance";
import {
  isMarketSymbol,
  MARKET_SYMBOLS,
  roundWindow,
  type MarketSymbol,
} from "@/lib/market/types";
import {
  evaluateSignal,
  ENTRY_CUTOFF_MS,
  type SignalReadout,
} from "@/lib/strategy/engine";
import { nextLocks } from "@/lib/strategy/locks";
import { useMutation, useQuery } from "convex/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMarketFeed } from "./use-market-feed";
import { useNow } from "./use-now";

export type RoundStatus = "warming" | "scanning" | "locked" | "closed";

export type SignalConsole = {
  feedStatus: FeedStatus;
  feedDetail: string;
  prices: Partial<Record<MarketSymbol, number>>;
  /** Live, un-locked read of the current round — recomputed every second. */
  readouts: Partial<Record<MarketSymbol, SignalReadout>>;
  /** The call that was locked for the current round, if any. */
  locks: Partial<Record<MarketSymbol, SignalReadout>>;
  status: Record<MarketSymbol, RoundStatus>;
  now: number;
  windowStart: number;
  windowEnd: number;
};

/**
 * The console brain.
 *
 * It keeps the live readout for every symbol so the engine can react to the
 * first seconds of a round, locks the first qualified call of each round (a
 * locked call is immutable — that is what "call it early" means), writes it to
 * the Convex journal, and later grades it against the real round close.
 */
export function useSignalConsole(): SignalConsole {
  const { candles, prices, status: feedStatus, detail: feedDetail } = useMarketFeed();
  const now = useNow(1000);

  const logSignal = useMutation(api.signals.logSignal);
  const resolveSignal = useMutation(api.signals.resolveSignal);
  const unresolved = useQuery(api.signals.unresolvedSignals, { limit: 20 });

  const readouts = useMemo(() => {
    const map: Partial<Record<MarketSymbol, SignalReadout>> = {};
    for (const symbol of MARKET_SYMBOLS) {
      const symbolCandles = candles[symbol];
      const price = prices[symbol];
      if (!symbolCandles || price === undefined) continue;
      const readout = evaluateSignal({ symbol, candles: symbolCandles, price, now });
      if (readout) map[symbol] = readout;
    }
    return map;
  }, [candles, prices, now]);

  const locksRef = useRef<Partial<Record<MarketSymbol, SignalReadout>>>({});
  const [locks, setLocks] = useState<Partial<Record<MarketSymbol, SignalReadout>>>({});

  useEffect(() => {
    const { locks: next, lockedCalls } = nextLocks(locksRef.current, readouts);
    if (next === locksRef.current) return;

    locksRef.current = next;
    setLocks(next);

    for (const readout of lockedCalls) {
      void logSignal({
        symbol: readout.symbol,
        windowStart: readout.windowStart,
        windowEnd: readout.windowEnd,
        direction: readout.direction,
        score: readout.score,
        confidence: readout.confidence,
        effectiveConfidence: readout.effectiveConfidence,
        estimatedProbability: readout.estimatedProbability,
        maxEntryPrice: readout.maxEntryPrice,
        entryLimitPrice: readout.maxEntryPrice,
        referencePrice: readout.referencePrice,
        regime: readout.regime,
        phaseAtSignal: readout.phase,
        entryDeadline: readout.entryDeadline,
        factors: readout.factors.map((factor) => ({ ...factor })),
        notes: readout.notes,
      }).catch((error: unknown) => {
        console.warn("[signal-console] could not journal the signal", error);
      });
    }
  }, [readouts, logSignal]);

  const resolvingRef = useRef<Set<string>>(new Set());

  const resolveOne = useCallback(
    async (signal: Doc<"signals">) => {
      if (!isMarketSymbol(signal.symbol)) return;
      const rows = await fetchKlines(signal.symbol, {
        startTime: signal.windowStart,
        endTime: signal.windowEnd - 1,
        limit: 5,
      });
      const closing =
        rows.find((candle) => candle.openTime === signal.windowEnd - 60_000) ??
        rows[rows.length - 1];
      if (!closing) return;
      await resolveSignal({ id: signal._id, closePrice: closing.close });
    },
    [resolveSignal],
  );

  useEffect(() => {
    if (!unresolved || unresolved.length === 0) return;
    for (const signal of unresolved) {
      if (signal.windowEnd + 4000 > now) continue;
      if (resolvingRef.current.has(signal._id)) continue;
      resolvingRef.current.add(signal._id);
      resolveOne(signal)
        .catch((error: unknown) => {
          console.warn("[signal-console] could not resolve a signal", error);
        })
        .finally(() => {
          resolvingRef.current.delete(signal._id);
        });
    }
  }, [unresolved, now, resolveOne]);

  const status = useMemo(() => {
    const map = {} as Record<MarketSymbol, RoundStatus>;
    for (const symbol of MARKET_SYMBOLS) {
      const readout = readouts[symbol];
      if (locks[symbol]) map[symbol] = "locked";
      else if (!readout) map[symbol] = "warming";
      else if (readout.elapsedMs >= ENTRY_CUTOFF_MS) map[symbol] = "closed";
      else map[symbol] = "scanning";
    }
    return map;
  }, [readouts, locks]);

  const first = readouts[MARKET_SYMBOLS[0]];
  const window = first
    ? { start: first.windowStart, end: first.windowEnd }
    : roundWindow(now);

  return {
    feedStatus,
    feedDetail,
    prices,
    readouts,
    locks,
    status,
    now,
    windowStart: window.start,
    windowEnd: window.end,
  };
}
