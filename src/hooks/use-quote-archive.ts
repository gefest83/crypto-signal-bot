/**
 * Forward archive of executable quotes.
 *
 * Why this exists
 * ---------------
 * A backtest on real money needs the price that could actually have been paid,
 * and that price does not exist in the past. Measured, not assumed:
 *
 *   - a resolved market's book is EMPTY — 99 bids and zero asks, nothing to buy;
 *   - `data-api/trades` returns `[]` for both the current and the daily market,
 *     so there is no executed-trade history for these tokens at all.
 *
 * A mid sampled after the round says nothing about whether an entry at +20s was
 * reachable either: a 1-minute mid cannot resolve a 1-second decision. So the
 * only honest source is a book we watch while it is live, and that is what this
 * hook produces.
 *
 * It is deliberately independent of any strategy. The rule that reads these
 * quotes may change, be rewritten, or be abandoned, but the market data does
 * not belong to the rule — and when the rule was torn down, taking the archive
 * with it would have destroyed the one thing that could still answer whether
 * anything works.
 *
 * The rows are NOT per-user. A quote is a fact about the market, identical for
 * everyone; duplicating it per account would make the archive describe how many
 * people were watching rather than what the market did.
 */

import { api } from "@/convex/_generated/api";
import { useAction, useMutation } from "convex/react";
import { useEffect, useMemo, useRef, useState } from "react";

import { pmRoundStart, type PmAsset, type PmInterval } from "@/lib/pm/markets";

/** How often the book is re-read. The archive window is 33s wide, so this
 *  yields ~11 snapshots per round at 5m — dense enough to see the price move
 *  across the decision point, sparse enough not to flood the database. */
const POLL_MS = 3_000;

/**
 * Milliseconds into the round that get archived.
 *
 * The decision is taken at +20s, so the window brackets it and nothing else.
 * Outside it the archive would describe moments at which no entry was
 * possible, and a strategy could quietly be credited with a fill it could
 * never have got.
 */
const ARCHIVE_FROM_MS = 12_000;
const ARCHIVE_TO_MS = 45_000;

export type ArchiveMarket = {
  asset: PmAsset;
  interval: PmInterval;
};

/** Both assets on the 5m book, which is where the rule is measured. */
export const ARCHIVE_MARKETS: ArchiveMarket[] = [
  { asset: "btc", interval: 5 },
  { asset: "eth", interval: 5 },
];

export type LiveBook = {
  upBid: number | null;
  upAsk: number | null;
  downBid: number | null;
  downAsk: number | null;
  priceSource: string | null;
};

export type ArchiveKey = string;

const keyOf = (m: ArchiveMarket) => `${m.asset}-${m.interval}`;

export function useQuoteArchive(markets: ArchiveMarket[] = ARCHIVE_MARKETS) {
  const fetchRound = useAction(api.polymarket.fetchRound);
  const archiveQuote = useMutation(api.quotes.archiveQuote);

  const [now, setNow] = useState(() => Date.now());
  const [books, setBooks] = useState<Record<ArchiveKey, LiveBook | null>>({});
  /** Rounds the hook has actually seen start, so a stalled clock is visible. */
  const [roundsSeen, setRoundsSeen] = useState(0);
  const inFlight = useRef(false);

  // One tick drives both the round clock and the window, so a snapshot and the
  // millisecond it describes can never disagree.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

  const starts = useMemo(() => {
    const map: Partial<Record<ArchiveKey, number>> = {};
    for (const m of markets) {
      map[keyOf(m)] = pmRoundStart(Math.floor(now / 1000), m.interval) * 1000;
    }
    return map;
  }, [markets, now]);

  // Read the book. Fire-and-forget on failure: a quote is evidence, and it must
  // never be able to stall the loop or throw away the previous good snapshot.
  useEffect(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    (async () => {
      const next: Record<ArchiveKey, LiveBook | null> = {};
      for (const m of markets) {
        const start = starts[keyOf(m)];
        if (!start) continue;
        try {
          const round = await fetchRound({ asset: m.asset, start: Math.floor(start / 1000), interval: m.interval });
          if (round) {
            next[keyOf(m)] = {
              upBid: round.upBid ?? null,
              upAsk: round.upAsk ?? null,
              downBid: round.downBid ?? null,
              downAsk: round.downAsk ?? null,
              priceSource: round.priceSource ?? null,
            };
          }
        } catch (error) {
          console.warn("[archive] book read failed", error);
        }
      }
      setBooks(next);
    })().finally(() => {
      inFlight.current = false;
    });
    return () => {};
  }, [fetchRound, markets, starts]);

  // Archive inside the window only.
  useEffect(() => {
    for (const m of markets) {
      const key = keyOf(m);
      const start = starts[key];
      const book = books[key];
      if (!start || !book || book.upAsk == null) continue;
      const elapsed = now - start;
      if (elapsed < ARCHIVE_FROM_MS || elapsed > ARCHIVE_TO_MS) continue;
      void archiveQuote({
        roundStart: Math.floor(start / 1000),
        asset: m.asset,
        interval: m.interval,
        t: elapsed,
        upBid: book.upBid ?? undefined,
        upAsk: book.upAsk ?? undefined,
        downBid: book.downBid ?? undefined,
        downAsk: book.downAsk ?? undefined,
        priceSource: book.priceSource ?? undefined,
      }).catch((error: unknown) => {
        console.warn("[archive] quote write failed", error);
      });
    }
  }, [archiveQuote, books, markets, now, starts]);

  // Count DISTINCT rounds, not ticks. Counting ticks would make a stalled clock
  // look busy, and "0 rounds" has to mean "never observed" rather than "not
  // counted yet" — that distinction is the whole point of a liveness counter.
  const seenRounds = useRef(new Set<number>());
  useEffect(() => {
    for (const m of markets) {
      const start = starts[keyOf(m)];
      if (start) seenRounds.current.add(Math.floor(start / 1000));
    }
    setRoundsSeen(seenRounds.current.size);
  }, [markets, starts]);

  const elapsedByMarket = useMemo(() => {
    const map: Partial<Record<ArchiveKey, number>> = {};
    for (const m of markets) {
      const start = starts[keyOf(m)];
      if (start) map[keyOf(m)] = now - start;
    }
    return map;
  }, [markets, now, starts]);

  return { now, books, starts, elapsedByMarket, roundsSeen, window: { from: ARCHIVE_FROM_MS, to: ARCHIVE_TO_MS } };
}
