import { api } from "../convex/_generated/api";
import {
  PM_INTERVALS,
  PM_LIMIT_OF,
  pmRoundStart,
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
  checkBuyFill,
  checkSellFill,
  closePosition,
  openPosition,
  settlePosition,
  type PaperPosition,
  type PaperSettings,
} from "@/lib/strategy/paper";
import { useAction, useMutation } from "convex/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** How often the real book is re-read. */
const BOOK_POLL_MS = 3_000;
const SYMBOL_OF_ASSET: Record<PmAsset, string> = { btc: "BTCUSDT", eth: "ETHUSDT" };

/**
 * The four markets this console runs.
 *
 * Both intervals are live and both were measured, and they fail in opposite
 * ways, which is exactly why they are kept apart:
 *
 *   5m   288 rounds/day/asset, exit fires 80%, survivors win 47%
 *   15m   96 rounds/day/asset, exit fires 91%, survivors win 76%
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
  journal: PaperJournalEntry[];
  perMarket: MarketStats[];
  totals: PaperTotals;
  now: number;
  settings: PaperSettings;
};

/**
 * The cheap side is the one we quote.
 *
 * DOWN is an exact complement of UP, so exactly one of the two asks is below
 * 0.50 at any moment, and the interval's limit is therefore always reachable
 * on one side without us forecasting anything.
 */
function candidateSide(upAsk: number | null): "up" | "down" {
  return upAsk !== null && upAsk < 0.5 ? "up" : "down";
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

  const fetchRound = useAction(api.polymarket.fetchRound);
  const logSignal = useMutation(api.signals.logSignal);
  const inFlight = useRef(false);

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
  useEffect(() => {
    setSessions((previous) => {
      const next: Partial<Record<MarketKey, PaperSession>> = {};
      for (const market of MARKETS) {
        const round = rounds[market.key];
        const start = starts[market.key] ?? 0;
        const limit = PM_LIMIT_OF[market.interval];
        const existing = previous[market.key];
        if (!existing || existing.roundStart !== start) {
          next[market.key] = empty(market.key, market.asset, market.interval, start, limit, stake);
          continue;
        }
        const session: PaperSession = { ...existing, stake, limit };
        if (round?.upAsk != null) {
          session.side = session.side ?? candidateSide(round.upAsk);
          session.ask = session.side === "up" ? round.upAsk : round.downAsk;
          session.bid = session.side === "up" ? round.upBid : round.downBid;
        }

        const book = { bid: session.bid, ask: session.ask, depthAtLimit: 0, now };
        const held = positions[market.key];

        if (session.state === "quoting") {
          const check = checkBuyFill(session.limit, book, settings);
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
      return next;
    });
  }, [rounds, now, starts, stake, settings, positions]);

  /** Grade a finished round on Polymarket's own published result. */
  const closeRound = useCallback(
    async (
      market: (typeof MARKETS)[number],
      session: PaperSession,
      round: PmRound | null | undefined,
    ) => {
      const upWon = await settledUp(round?.slug ?? "");
      if (upWon === null) return;
      const won = session.side === "up" ? upWon : !upWon;
      const open = positions[market.key];
      let pnl: number | null = null;
      if (open) {
        const settled = settlePosition(open, won, now, TRADE_FEE_RATE);
        setPositions((p) => ({ ...p, [market.key]: settled }));
        pnl = settled.pnl;
        setClosed((c) => ({
          ...c,
          [market.key]: [...(c[market.key] ?? []), { pnl: settled.pnl ?? 0, exited: false }],
        }));
      } else {
        setClosed((c) => ({
          ...c,
          [market.key]: [...(c[market.key] ?? []), { pnl: 0, exited: false }],
        }));
      }
      if (session.side) {
        const tokenId = session.side === "up" ? round?.upTokenId : round?.downTokenId;
        await logSignal({
          symbol: SYMBOL_OF_ASSET[market.asset],
          windowStart: session.roundStart,
          windowEnd: session.roundStart + market.interval * 60_000,
          marketSlug: round?.slug ?? undefined,
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
    },
    [logSignal, positions, now, settings.penetrationTicks],
  );

  const graded = useRef<Record<string, number>>({});
  useEffect(() => {
    for (const market of MARKETS) {
      const start = starts[market.key] ?? 0;
      const roundMs = market.interval * 60_000;
      if (now - start < roundMs) continue;
      if (graded.current[market.key] === start) continue;
      graded.current[market.key] = start;
      const session = sessions[market.key];
      if (!session || session.roundStart !== start) continue;
      if (session.state === "closed" || session.state === "held") continue;
      void closeRound(market, session, rounds[market.key]);
    }
  }, [now, starts, sessions, rounds, closeRound]);

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
        fills: stats.reduce((sum, s) => sum + s.fills, 0),
        exits: stats.reduce((sum, s) => sum + s.exits, 0),
        held: stats.reduce((sum, s) => sum + s.held, 0),
        wins: stats.reduce((sum, s) => sum + s.wins, 0),
        losses: stats.reduce((sum, s) => sum + s.losses, 0),
        best: all.length ? Math.max(...all.map((r) => r.pnl)) : null,
        worst: all.length ? Math.min(...all.map((r) => r.pnl)) : null,
      },
    };
  }, [closed]);

  return {
    sessions: sessions as Partial<Record<MarketKey, PaperSession>>,
    journal: [],
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
