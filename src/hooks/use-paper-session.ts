import { api } from "../convex/_generated/api";
import {
  PM_INTERVALS,
  PM_LIMIT_OF,
  pmRoundStart,
  pmSlug,
  settledUp,
  type PmAsset,
  type PmInterval,
  type PmRound,
} from "../convex/polymarket";
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
import { useAction, useMutation } from "convex/react";
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
  const inFlight = useRef(false);

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
          // A limit at or above the ask is not a resting order. Quoting it
          // would manufacture an instant fill, and the round would round-trip
          // for a pure commission loss with no market event involved.
          const restable = canRestBuy(session.limit, session.ask);
          const check: FillCheck = restable.filled
            ? checkBuyFill(session.limit, book, settings)
            : { filled: false, reason: restable.reason };
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
            }
          } else {
            session.note =
              session.ask == null
                ? "Ждём котировку ask."
                : `Заявка ${session.limit.toFixed(2)} в стакане. ${check.reason}.`;
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
  }, [rounds, now, starts, stake, settings, positions, sessions]);

  /**
   * Grade one finished round on Polymarket's own published result.
   *
   * Returns false while the result is still unpublished, and the caller keeps
   * the round queued. The position travels with the item rather than being
   * read from live state, because by grading time the market has already
   * rolled over to a new round and the live position is no longer this one.
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
    [logSignal, now, settings.penetrationTicks],
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
  };
}

/** The measured expectation for one market, used to label the panels honestly. */
export function marketProfile(interval: PmInterval) {
  return MARKET_PROFILES[interval];
}
