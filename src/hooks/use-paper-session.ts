import { api } from "../convex/_generated/api";
import {
  PM_LIMIT_OF,
  pmRoundStart,
  pmSlug,
  settledUp,
  type PmAsset,
  type PmInterval,
  type PmRound,
} from "@/lib/pm/markets";
import {
  DEFAULT_STAKE_USD,
  MARKET_PROFILES,
  TRADE_FEE_RATE,
  type StakeUsd,
} from "@/lib/strategy/maker-exit";
import {
  DEFAULT_PAPER,
  canRestBuy,
  checkBuyFill,
  checkSellFill,
  closePosition,
  openPosition,
  settlePosition,
  type FillCheck,
  type PaperPosition,
  type PaperSettings,
} from "@/lib/strategy/paper";
import { useAction, useMutation, useQuery } from "convex/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** How often the real book is re-read. */
const BOOK_POLL_MS = 3_000;
const SYMBOL_OF_ASSET: Record<PmAsset, string> = { btc: "BTCUSDT", eth: "ETHUSDT" };

/** Hard cap on rounds waiting for a published result. */
const MAX_PENDING = 24;

/** First retry delay, doubling each attempt up to GRADE_MAX_BACKOFF_MS. */
const GRADE_BASE_BACKOFF_MS = 5_000;
const GRADE_MAX_BACKOFF_MS = 120_000;

/** One finished round waiting for Polymarket to publish its result. */
type PendingGrade = {
  key: MarketKey;
  session: PaperSession;
  position: PaperPosition | null;
  round: PmRound | null;
  /** Failed attempts so far; drives the backoff. */
  attempts: number;
  /** Timestamp before which this entry is left alone. */
  nextTryAt: number;
};

/**
 * The four markets this console runs.
 *
 * Both intervals are live and both were measured, and they fail in opposite
 * ways, which is exactly why they are kept apart:
 *
 *   5m   288 rounds/day/asset, exit fires 81%, survivors win 73%, 2 bad days
 *   15m   96 rounds/day/asset, exit fires 91%, survivors win 76%, 8 bad days
 *
 * Averaging them would produce a number that describes neither. A separate
 * figure per market is the only honest way to see which one is actually
 * paying, and the total is reported alongside rather than instead.
 */
export const MARKETS: { asset: PmAsset; interval: PmInterval; key: string }[] = [
  { asset: "btc", interval: 5, key: "btc-5" },
  { asset: "eth", interval: 5, key: "eth-5" },
  { asset: "btc", interval: 15, key: "btc-15" },
  { asset: "eth", interval: 15, key: "eth-15" },
];

export type MarketKey = (typeof MARKETS)[number]["key"];

export type PaperState =
  /** Our bid is resting, waiting for a seller to actually reach it. */
  | "quoting"
  /** Filled. Holding, waiting for the price to come back. */
  | "filled"
  /** Filled, and we are working the exit. */
  | "closing"
  /** Given back. Flat, the round trip cost whatever the slippage was. */
  | "closed"
  /** The round resolved while we still held. Graded on the real result. */
  | "held"
  /** The round ended and the limit was never reached. */
  | "missed";

export type PaperSession = {
  key: string;
  asset: PmAsset;
  interval: PmInterval;
  roundStart: number;
  state: PaperState;
  side: "up" | "down" | null;
  limit: number;
  stake: number;
  ask: number | null;
  bid: number | null;
  /**
   * Whether the order has actually been RESTING in the book yet.
   *
   * This flag exists because two different questions were being asked with one
   * condition, and they are mutually exclusive. A resting buy needs the ask to
   * sit ABOVE our limit; a fill needs the ask to have fallen BELOW it. Asking
   * both of the same tick means asking for `ask > 0.50` and `ask <= 0.49` at
   * once, which is unsatisfiable — so the fill test could never pass and the
   * console reported zero trades forever while looking completely healthy.
   *
   * The order is armed the first tick the ask is above the limit, and stays
   * armed for the rest of the round. From then on a fill is a pure penetration
   * test, with no re-validation of whether the quote is still allowed to rest.
   * That is also the honest sequence: an order that was never in the book
   * cannot be filled by the market moving through it.
   */
  rested: boolean;
  shares: number | null;
  openedAfterMs: number | null;
  upWon: boolean | null;
  pnl: number | null;
  note: string;
};

export type PaperJournalEntry = PaperSession & { id: string; roundEnd: number };

/** Per-market tally, so a good 15m hour cannot hide a bleeding 5m one. */
export type MarketStats = {
  key: string;
  label: string;
  interval: PmInterval;
  /**
   * Rounds this market has actually been through, and how many of them the
   * order was RESTING in the book for. A market showing 400 rounds and 0
   * quotes is broken; 400 and 380 means the console is alive and the fills
   * simply are not coming. Without this pair, "no trades" is unreadable.
   */
  rounds: number;
  quoted: number;
  /** Rounds where the limit was actually reached. */
  fills: number;
  /** How many closed at breakeven, how many were held to settlement. */
  exits: number;
  held: number;
  missed: number;
  wins: number;
  losses: number;
  realised: number;
  /** Best and worst single trade, which is where the risk actually shows. */
  best: number | null;
  worst: number | null;
};

const zeroStats = (key: string, label: string, interval: PmInterval): MarketStats => ({
  key,
  label,
  interval,
  rounds: 0,
  quoted: 0,
  fills: 0,
  exits: 0,
  held: 0,
  missed: 0,
  wins: 0,
  losses: 0,
  realised: 0,
  best: null,
  worst: null,
});

export type PaperTotals = {
  /** Sum of every market. This is the headline number. */
  realised: number;
  rounds: number;
  quoted: number;
  fills: number;
  exits: number;
  held: number;
  wins: number;
  losses: number;
  best: number | null;
  worst: number | null;
};

export type PaperConsole = {
  sessions: Partial<Record<MarketKey, PaperSession>>;
  perMarket: MarketStats[];
  totals: PaperTotals;
  now: number;
  settings: PaperSettings;
  /**
   * Rounds read back from the database on mount.
   *
   * This exists to make the restore verifiable instead of assumed. "0 trades"
   * used to mean two completely different things — nothing was ever traded, or
   * the history failed to come back — and they looked identical. A non-zero
   * number here after a reload is the difference between the two.
   */
  storedRounds: number;
};

/**
 * The side we quote is the EXPENSIVE one, and that is not a preference.
 *
 * A buy limit at 0.50 can only rest while the ask is above 0.50. Quote the
 * cheap side instead and the order crosses the spread the instant it is sent,
 * filling at a price nobody chose. DOWN is an exact complement of UP, so
 * exactly one of the two asks is above 0.50, and that is the only side where
 * the limit is reachable without us forecasting anything.
 *
 * When neither side clears the limit — which happens when the round has run
 * far enough for the market to be decided — there is nothing to quote, and
 * the honest answer is to sit the round out.
 */
function quoteableSide(upAsk: number | null, limit: number): "up" | "down" | null {
  if (upAsk === null) return null;
  if (upAsk > limit + 1e-9) return "up";
  const downAsk = 1 - upAsk;
  return downAsk > limit + 1e-9 ? "down" : null;
}

/**
 * Whether anything a human could see actually changed.
 *
 * The console polls the book every few seconds, and most of those polls return
 * the same numbers. Committing a fresh object on each one turns the poll into
 * a render loop, so the state is only written when it genuinely differs.
 */
function sameSession(a: PaperSession, b: PaperSession): boolean {
  return (
    a.roundStart === b.roundStart &&
    a.state === b.state &&
    a.side === b.side &&
    a.limit === b.limit &&
    a.stake === b.stake &&
    a.ask === b.ask &&
    a.bid === b.bid &&
    a.rested === b.rested &&
    a.shares === b.shares &&
    a.openedAfterMs === b.openedAfterMs &&
    a.upWon === b.upWon &&
    a.pnl === b.pnl &&
    a.note === b.note
  );
}

const empty = (
  key: string,
  asset: PmAsset,
  interval: PmInterval,
  roundStart: number,
  limit: number,
  stake: number,
): PaperSession => ({
  key,
  asset,
  interval,
  roundStart,
  state: "quoting",
  side: null,
  limit,
  stake,
  ask: null,
  bid: null,
  rested: false,
  shares: null,
  openedAfterMs: null,
  upWon: null,
  pnl: null,
  note: "Ждём стакан.",
});

/**
 * Virtual maker trading on all four markets at once.
 *
 * This is deliberately the most pessimistic reading of the strategy the
 * backtest studied, and the gap between the two is the entire point:
 *
 *   - a fill needs the price to PENETRATE the limit by a tick, not touch it,
 *     because falling prices hit bids rather than lifting them
 *   - a fill is booked at our limit, never at the worse price that crossed us
 *   - the exit must penetrate too, symmetrically, which is where the backtest
 *     was most generous with itself
 *
 * Every one of those choices can only make the result WORSE, never better.
 * Nothing here sends an order or moves money.
 */
export function usePaperSession(
  stake: number = DEFAULT_STAKE_USD,
  settings: PaperSettings = DEFAULT_PAPER,
): PaperConsole {
  const [now, setNow] = useState(() => Date.now());
  const [rounds, setRounds] = useState<Partial<Record<MarketKey, PmRound | null>>>({});
  const [sessions, setSessions] = useState<Partial<Record<MarketKey, PaperSession>>>({});
  const [positions, setPositions] = useState<Partial<Record<MarketKey, PaperPosition>>>({});
  const [closed, setClosed] = useState<Record<MarketKey, { pnl: number; exited: boolean }[]>>({});

  /**
   * Liveness counters. Without these, a console that is working correctly and
   * a console that has silently stopped polling look identical from the
   * outside: both show zero trades. Counting the rounds that went by, and the
   * share of them where the order was genuinely resting, tells the two apart.
   */
  const [liveness, setLiveness] = useState<Record<string, { rounds: number; quoted: number }>>({});
  /** Bumped to re-drive the grading queue when a result lands late. */
  const [drainTick, setDrainTick] = useState(0);

  const fetchRound = useAction(api.polymarket.fetchRound);
  const logSignal = useMutation(api.signals.logSignal);
  const recordRound = useMutation(api.paper.recordRound);
  const archiveQuote = useMutation(api.paper.archiveQuote);
  const inFlight = useRef(false);

  /**
   * Archive the executable book while the round is still live.
   *
   * A mid sampled 90 seconds into a round says nothing about whether an entry
   * at +20s was reachable, and a resolved market's book is empty — measured, 99
   * bids and zero asks — so nothing about the past can be reconstructed. The
   * window below brackets the RetMag decision point and nothing else; outside
   * it the archive would be describing moments nobody could trade.
   *
   * The console already re-reads the book every few seconds, so this costs no
   * extra network traffic. Writes are fire-and-forget: a quote is supporting
   * evidence, and it must never be able to stall the trading loop.
   */
  const archiveWindow = useMemo(() => ({ from: 12_000, to: 45_000 }), []);
  // The effect itself lives below, next to `starts`, which it reads.
  void archiveQuote;


  /**
   * Restore the tally from the database on mount.
   *
   * The console used to hold every closed round in React state, so closing or
   * refreshing the tab reported zero trades and $0.00 — a track record that
   * resets on F5 cannot be used to judge a strategy. The stored rounds are
   * replayed into the same `closed`/`liveness` shapes the live path produces,
   * so everything downstream keeps reading one structure.
   *
   * The replay runs once. Re-running it on every render would append the same
   * history again, which is the mirror image of the bug it fixes.
   */
  const storedRounds = useQuery(api.paper.listRounds, {});

  /**
   * Persist one round the moment anything about it becomes a fact.
   *
   * The first version wrote to the database only from `closeRound`, which runs
   * when a round is GRADED — and grading is the step that depends on Polymarket
   * publishing a result, on the queue surviving its own backoff, and on the tab
   * still being open. An exit by limit, on the other hand, is booked in memory
   * the instant it happens. So a trade that was real, closed and shown on
   * screen could still vanish on reload if the tab closed before the round was
   * graded. That is the whole bug: the number on screen and the number on disk
   * were updated at different moments, and only one of them was durable.
   *
   * Writing at every bookable event removes the gap. The write is keyed on the
   * round itself, so a provisional row at rollover, a corrected row at the fill
   * and a final row at settlement all land on the SAME row instead of counting
   * as three separate trades.
   */
  const persistRound = useCallback(
    async (
      market: (typeof MARKETS)[number],
      session: PaperSession,
      position: PaperPosition | null,
      upWon?: boolean,
    ) => {
      await recordRound({
        marketKey: market.key,
        asset: market.asset,
        interval: market.interval,
        roundStart: session.roundStart,
        quoted: session.side !== null,
        filled: session.state === "filled" || session.state === "closed",
        exited: session.state === "closed",
        pnl: session.pnl ?? 0,
        entryPrice: position?.entryPrice,
        exitPrice: position?.exitPrice,
        stake: session.stake,
        shares: session.shares ?? undefined,
        upWon,
        note: session.note,
      }).catch((error: unknown) => {
        console.warn("[paper] could not persist the round", error);
      });
    },
    [recordRound],
  );

  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || !storedRounds) return;
    restored.current = true;
    if (storedRounds.length === 0) return;

    const byMarket: Record<string, { pnl: number; exited: boolean }[]> = {};
    const live: Record<string, { rounds: number; quoted: number }> = {};
    for (const row of storedRounds) {
      const bucket = (byMarket[row.marketKey] ??= []);
      bucket.push({ pnl: row.pnl ?? 0, exited: row.exited ?? false });
      const tally = (live[row.marketKey] ??= { rounds: 0, quoted: 0 });
      tally.rounds += 1;
      if (row.quoted) tally.quoted += 1;
    }
    setClosed((current) => {
      const merged: Record<string, { pnl: number; exited: boolean }[]> = { ...byMarket };
      for (const [key, rows] of Object.entries(current)) {
        merged[key] = [...(merged[key] ?? []), ...rows];
      }
      return merged;
    });
    setLiveness((current) => {
      const merged: Record<string, { rounds: number; quoted: number }> = { ...current };
      for (const [key, tally] of Object.entries(live)) {
        merged[key] = {
          rounds: (current[key]?.rounds ?? 0) + tally.rounds,
          quoted: (current[key]?.quoted ?? 0) + tally.quoted,
        };
      }
      return merged;
    });
  }, [storedRounds]);

  /**
   * Rounds that have ended but are not graded yet.
   *
   * A round cannot be graded the moment it rolls over: Polymarket publishes the
   * result a little later, and until it does, `settledUp` returns null. Grading
   * once and giving up would silently drop the round, which is exactly how a
   * console ends up reporting zero trades forever while looking perfectly
   * healthy. So the finished round waits here until the result is real.
   *
   * The queue is CAPPED and each entry BACKS OFF, and both are load-bearing.
   * Left unbounded, a result that never publishes turns this into a queue that
   * only grows, and a drain that walks all of it once a second — a few hundred
   * network calls a minute, which locks the tab solid. The oldest entry is
   * dropped rather than allowed to starve everything behind it, because the
   * rounds in front of it are the ones that actually describe the strategy.
   */
  const pending = useRef<PendingGrade[]>([]);

  // Each interval has its own clock: a 15m round is still running while the
  // 5m one has already rolled over twice.
  const starts = useMemo(() => {
    const map: Partial<Record<MarketKey, number>> = {};
    for (const market of MARKETS) {
      map[market.key] = pmRoundStart(now, market.interval) * 1000;
    }
    return map;
  }, [now]);
  const bucket = Math.floor(now / BOOK_POLL_MS);

  useEffect(() => {
    for (const market of MARKETS) {
      const start = starts[market.key];
      const round = rounds[market.key];
      if (!start || !round || !round.upAsk) continue;
      const elapsed = now - start;
      if (elapsed < archiveWindow.from || elapsed > archiveWindow.to) continue;
      void archiveQuote({
        roundStart: Math.floor(start / 1000),
        asset: market.asset,
        interval: market.interval,
        t: elapsed,
        upBid: round.upBid ?? undefined,
        upAsk: round.upAsk ?? undefined,
        downBid: round.downBid ?? undefined,
        downAsk: round.downAsk ?? undefined,
        priceSource: round.priceSource,
      }).catch((error: unknown) => {
        console.warn("[paper] quote archive failed", error);
      });
    }
  }, [archiveQuote, archiveWindow, now, rounds, starts]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    let cancelled = false;
    void Promise.all(
      MARKETS.map(async (market) => {
        const startSec = Math.floor((starts[market.key] ?? 0) / 1000);
        return [
          market.key,
          await fetchRound({ asset: market.asset, start: startSec, interval: market.interval }),
        ] as const;
      }),
    )
      .then((entries) => {
        if (cancelled) return;
        setRounds(Object.fromEntries(entries) as Partial<Record<MarketKey, PmRound | null>>);
      })
      .catch((error: unknown) => {
        console.warn("[paper] book refresh failed", error);
      })
      .finally(() => {
        inFlight.current = false;
      });
    return () => {
      cancelled = true;
    };
  }, [fetchRound, bucket, starts]);

  // The state machine, one pass per poll, per market.
  //
  // This used to hand a brand new object to `setSessions` on every single
  // pass, while `positions` sat in the dependency list. New object means a
  // changed dependency, which means the effect runs again, which allocates
  // another object — a render loop with no exit, and a white page. The state is
  // therefore committed ONLY when it actually differs, which is also the honest
  // behaviour: a market that is quietly sitting on a resting order has not
  // changed since the last poll and should not cost a render.
  useEffect(() => {
    const next: Partial<Record<MarketKey, PaperSession>> = {};
    for (const market of MARKETS) {
        const round = rounds[market.key];
        const start = starts[market.key] ?? 0;
        const limit = PM_LIMIT_OF[market.interval];
        const existing = sessions[market.key];
        if (!existing || existing.roundStart !== start) {
          // The round rolled over. The finished session is about to be thrown
          // away, so it goes to the grading queue first — keyed by its own
          // start, which makes a double push from StrictMode a no-op.
          if (existing) {
            const queued = pending.current.some(
              (item) => item.key === market.key && item.session.roundStart === existing.roundStart,
            );
            if (!queued) {
              pending.current.push({
                key: market.key,
                session: existing,
                position: positions[market.key] ?? null,
                round: rounds[market.key] ?? null,
                attempts: 0,
                nextTryAt: 0,
              });
              // Keep only the most recent rounds. A console that has been left
              // open overnight must not spend the morning grading last night's
              // backlog and stall on it.
              if (pending.current.length > MAX_PENDING) {
                pending.current.splice(0, pending.current.length - MAX_PENDING);
              }
              // A round that ended without a fill is a fact the moment the round
              // ends, and it does not need Polymarket to have settled anything.
              // Recording it here means the "watched but did not trade" evidence
              // survives even if grading never gets to run.
              void persistRound(market, existing, positions[market.key] ?? null);
            }
          }
          next[market.key] = empty(market.key, market.asset, market.interval, start, limit, stake);
          continue;
        }
        const session: PaperSession = { ...existing, stake, limit };
        if (round?.upAsk != null) {
          const side = session.side ?? quoteableSide(round.upAsk, session.limit);
          session.side = side;
          session.ask = side === "up" ? round.upAsk : side === "down" ? round.downAsk : null;
          session.bid = side === "up" ? round.upBid : side === "down" ? round.downBid : null;
        }

        const book = { bid: session.bid, ask: session.ask, depthAtLimit: 0, now };
        const held = positions[market.key];

        if (session.state === "quoting") {
          // Arming the order and filling it are DIFFERENT events, and they
          // need different conditions. This conflation is why the console
          // reported zero trades for ten hours straight: `canRestBuy` demands
          // ask > limit while `checkBuyFill` demands ask <= limit - tick, so
          // asking both of the same snapshot asked for a price that cannot
          // exist. The fill test was unreachable by construction.
          //
          // The order arms on the first tick where the ask is above the limit —
          // that is the tick it is genuinely resting in the book. Once armed
          // it stays armed, and a fill is then a pure penetration test on every
          // later tick, which is the only condition a real resting order
          // experiences. An order that was never resting cannot be filled.
          const armed = session.rested || canRestBuy(session.limit, session.ask).filled;
          if (armed) session.rested = true;

          const check: FillCheck = armed
            ? checkBuyFill(session.limit, book, settings)
            : {
                filled: false,
                reason:
                  session.ask == null
                    ? "Ждём котировку ask."
                    : canRestBuy(session.limit, session.ask).reason,
              };
          if (check.filled) {
            const order = {
              id: `${market.key}-${session.roundStart}`,
              side: "buy" as const,
              price: session.limit,
              stake: session.stake,
              placedAt: session.roundStart,
              status: "filled" as const,
              filledAt: now,
              fillPrice: check.fillPrice,
              reason: check.reason,
            };
            const position = openPosition(order, session.stake, TRADE_FEE_RATE);
            if (position) {
              setPositions((p) => ({ ...p, [market.key]: position }));
              session.state = "filled";
              session.shares = position.shares;
              session.openedAfterMs = now - session.roundStart;
              session.note = `Набито. ${check.reason}. ${position.shares.toFixed(2)} шар на $${session.stake}.`;
              // Record the fill now, not at the round's end. A position that
              // was filled and then lost to a reload is the most expensive kind
              // of lost trade: the entry was real and the money was committed.
              void persistRound(market, session, position);
            }
          } else if (session.ask == null) {
            session.note = "Ждём котировку ask.";
          } else if (session.rested) {
            session.note = `Заявка ${session.limit.toFixed(2)} в стакане. ${check.reason}.`;
          } else {
            session.note = `Ждём, когда ask уйдёт выше лимита ${session.limit.toFixed(2)}. ${check.reason}`;
          }
        } else if (session.state === "filled" && held) {
          session.state = "closing";
        } else if (session.state === "closing" && held) {
          const exit = checkSellFill(held.exitPrice, book, settings);
          if (exit.filled) {
            const settled = closePosition(held, exit.fillPrice, now, TRADE_FEE_RATE);
            setPositions((p) => ({ ...p, [market.key]: settled }));
            session.state = "closed";
            session.pnl = settled.pnl;
            session.note = `Выход. ${settled.reason}.`;
            setClosed((c) => ({
              ...c,
              [market.key]: [...(c[market.key] ?? []), { pnl: settled.pnl ?? 0, exited: true }],
            }));
            // Durable the instant the exit is real. Waiting for the round to be
            // graded leaves the trade living only in this tab's memory, which is
            // exactly what losing it on reload looks like from the outside.
            void persistRound(market, session, settled);
          } else {
            session.note = `Держим ${held.shares.toFixed(2)} шар. ${exit.reason}.`;
          }
        }
        next[market.key] = session;
    }

    // Commit only real changes. See the note above: allocating a new object
    // unconditionally is what turned this effect into a render loop.
    let changed = false;
    for (const market of MARKETS) {
      const before = sessions[market.key];
      const after = next[market.key];
      if (!before || !after || !sameSession(before, after)) {
        changed = true;
        break;
      }
    }
    if (changed) setSessions(next);
  }, [rounds, now, starts, stake, settings, positions, sessions, persistRound]);

  /**
   * Grade one finished round on Polymarket's own published result.
   *
   * Returns false while the result is still unpublished, and the caller keeps
   * the round queued. The position travels with the item rather than being
   * read from live state, because by grading time the market has already
   * rolled over to a new round and the live position is no longer this one.
   */
  /**
   * Persist one round, the moment anything about it becomes a fact.
   *
   * The first version wrote to the database only from `closeRound`, which runs
   * when a round is GRADED — and grading is the step that depends on Polymarket
   * publishing a result, on the queue surviving its own backoff, and on the tab
   * still being open. An exit by limit, on the other hand, is booked in memory
   * the instant it happens. So a trade that was real, closed, and shown on
   * screen could still vanish on reload if the tab closed before the round was
   * graded. That is the whole bug: the number on screen and the number on disk
   * were updated at different moments, and only one of them was durable.
   *
   * Writing at every bookable event removes the gap. The write is keyed on the
   * round, so a provisional row at rollover, a corrected row at exit and a
   * final row at settlement all land on the SAME row instead of three trades.
   */
  const closeRound = useCallback(
    async (item: (typeof pending.current)[number]): Promise<boolean> => {
      const { key, session, position, round } = item;
      const market = MARKETS.find((m) => m.key === key);
      if (!market) return true;
      // The round's own slug, derived from its start: the book has already
      // moved on, so `rounds[key]` is the wrong market by now.
      const slug = pmSlug(market.asset, Math.floor(session.roundStart / 1000), market.interval);
      const upWon = await settledUp(slug);
      if (upWon === null) return false;

      const open = position;
      if (open && open.status === "open") {
        const won = session.side === "up" ? upWon : !upWon;
        const settled = settlePosition(open, won, now, TRADE_FEE_RATE);
        setPositions((p) => ({ ...p, [key]: settled }));
        setClosed((c) => ({
          ...c,
          [key]: [...(c[key] ?? []), { pnl: settled.pnl ?? 0, exited: session.state === "closed" }],
        }));
      } else if (session.state === "closed") {
        // Already booked by the exit path; do not count it twice.
      } else {
        setClosed((c) => ({ ...c, [key]: [...(c[key] ?? []), { pnl: 0, exited: false }] }));
      }

      // Persist the round BEFORE the journal write below, on every path
      // including a round that never filled. The missed rounds are the evidence
      // that the console was watching, and without them a day of trading leaves
      // no trace at all.
      await persistRound(market, session, position ?? null, upWon);

      if (session.side) {
        const tokenId = session.side === "up" ? round?.upTokenId : round?.downTokenId;
        await logSignal({
          symbol: SYMBOL_OF_ASSET[market.asset],
          windowStart: session.roundStart,
          windowEnd: session.roundStart + market.interval * 60_000,
          marketSlug: slug,
          tokenId: tokenId ?? undefined,
          direction: session.side,
          entryLimitPrice: session.limit,
          entryAsk: session.ask ?? undefined,
          exited: session.state === "closed",
          notes: [
            `${market.interval}m paper: ${session.state}`,
            `проникновение ${settings.penetrationTicks} тик`,
          ],
        }).catch((error: unknown) => {
          console.warn("[paper] could not journal the trade", error);
        });
      }
      return true;
    },
    [logSignal, persistRound, now, settings.penetrationTicks],
  );

  /**
   * Drain the grading queue, and count each round exactly once.
   *
   * The liveness tally is bumped when the round is QUEUED, not when it grades
   * cleanly, because it answers "is the console watching?" — and the console is
   * watching whether or not Polymarket has published the result yet. Keyed by
   * the round's own start so a retry cannot inflate it.
   */
  const counted = useRef<Record<string, boolean>>({});
  useEffect(() => {
    if (pending.current.length === 0) return;
    for (const item of pending.current) {
      const id = `${item.key}@${item.session.roundStart}`;
      if (counted.current[id]) continue;
      counted.current[id] = true;
      setLiveness((l) => ({
        ...l,
        [item.key]: {
          rounds: (l[item.key]?.rounds ?? 0) + 1,
          quoted: (l[item.key]?.quoted ?? 0) + (item.session.side ? 1 : 0),
        },
      }));
    }
  });

  useEffect(() => {
    if (pending.current.length === 0) return;
    let cancelled = false;
    void (async () => {
      const stillWaiting: PendingGrade[] = [];
      let settledCount = 0;
      for (const item of pending.current) {
        if (cancelled) return;
        // Backoff: an entry nobody published is not worth re-asking every
        // second, and the wait is what keeps the request rate flat no matter
        // how long the tab stays open.
        if (item.nextTryAt > now) {
          stillWaiting.push(item);
          continue;
        }
        let ok = false;
        try {
          ok = await closeRound(item);
        } catch (error: unknown) {
          // A failed request is a retry, never a reason to tear the page down.
          console.warn("[paper] grading attempt failed", error);
        }
        if (ok) {
          settledCount += 1;
          continue;
        }
        item.attempts += 1;
        item.nextTryAt =
          now + Math.min(GRADE_BASE_BACKOFF_MS * 2 ** (item.attempts - 1), GRADE_MAX_BACKOFF_MS);
        stillWaiting.push(item);
      }
      if (cancelled) return;
      pending.current = stillWaiting;
      // Nudge ONLY when something was actually graded. Nudging unconditionally
      // re-runs this effect, which re-reads an unpublished round, which nudges
      // again — an unbounded render loop that hammers Gamma and freezes the tab.
      // An unpublished result is instead picked up by the next `now` tick.
      if (settledCount > 0) setDrainTick((t) => t + 1);
    })();
    return () => {
      cancelled = true;
    };
  }, [closeRound, now, drainTick]);

  // Per-market statistics, then the sum. Kept as two separate things on
  // purpose: a total that mixes a thick 15m edge with a thin 5m one hides
  // which of them is actually bleeding.
  const { perMarket, totals } = useMemo(() => {
    const stats = MARKETS.map((market) => {
      const rows = closed[market.key] ?? [];
      const filled = rows.filter((r) => r.pnl !== 0 || r.exited);
      const base = zeroStats(
        market.key,
        `${market.asset.toUpperCase()} ${market.interval}m`,
        market.interval,
      );
      base.rounds = liveness[market.key]?.rounds ?? 0;
      base.quoted = liveness[market.key]?.quoted ?? 0;
      base.missed = rows.filter((r) => !r.exited && r.pnl === 0).length;
      base.exits = rows.filter((r) => r.exited).length;
      base.held = filled.length - base.exits;
      base.fills = filled.length;
      base.wins = filled.filter((r) => r.pnl > 0).length;
      base.losses = filled.filter((r) => r.pnl < 0).length;
      base.realised = filled.reduce((sum, r) => sum + r.pnl, 0);
      base.best = filled.length ? Math.max(...filled.map((r) => r.pnl)) : null;
      base.worst = filled.length ? Math.min(...filled.map((r) => r.pnl)) : null;
      return base;
    });

    const all = stats.flatMap((s) => closed[s.key] ?? []).filter((r) => r.pnl !== 0 || r.exited);
    return {
      perMarket: stats,
      totals: {
        realised: stats.reduce((sum, s) => sum + s.realised, 0),
        rounds: stats.reduce((sum, s) => sum + s.rounds, 0),
        quoted: stats.reduce((sum, s) => sum + s.quoted, 0),
        fills: stats.reduce((sum, s) => sum + s.fills, 0),
        exits: stats.reduce((sum, s) => sum + s.exits, 0),
        held: stats.reduce((sum, s) => sum + s.held, 0),
        wins: stats.reduce((sum, s) => sum + s.wins, 0),
        losses: stats.reduce((sum, s) => sum + s.losses, 0),
        best: all.length ? Math.max(...all.map((r) => r.pnl)) : null,
        worst: all.length ? Math.min(...all.map((r) => r.pnl)) : null,
      },
    };
  }, [closed, liveness]);

  return {
    sessions: sessions as Partial<Record<MarketKey, PaperSession>>,
    perMarket,
    totals,
    now,
    settings,
    storedRounds: storedRounds?.length ?? 0,
  };
}

/** The measured expectation for one market, used to label the panels honestly. */
export function marketProfile(interval: PmInterval) {
  return MARKET_PROFILES[interval];
}
