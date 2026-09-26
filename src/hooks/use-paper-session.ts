import { api } from "../convex/_generated/api";
import { pmRoundStart, settledUp, type PmAsset, type PmRound } from "../convex/polymarket";
import {
  DEFAULT_LIMIT,
  DEFAULT_STAKE_USD,
  MARKET_INTERVAL_MIN,
  TRADE_FEE_RATE,
} from "@/lib/strategy/maker-exit";
import {
  DEFAULT_PAPER,
  checkBuyFill,
  checkSellFill,
  closePosition,
  isQuoteStale,
  openPosition,
  sessionPnl,
  settlePosition,
  type PaperPosition,
  type PaperSettings,
} from "@/lib/strategy/paper";
import { useAction, useMutation } from "convex/react";
import { useCallback, useEffect, useRef, useState } from "react";

/** How often the real book is re-read. */
const BOOK_POLL_MS = 3_000;
const ROUND_MS = MARKET_INTERVAL_MIN * 60_000;
const ASSETS: PmAsset[] = ["btc", "eth"];
const SYMBOL_OF_ASSET: Record<PmAsset, string> = { btc: "BTCUSDT", eth: "ETHUSDT" };
/**
 * The exit we quote: the entry limit, because a breakeven exit is a limit exit.
 * Sitting above it would be taking profit on a trade we never expected to win.
 */
const EXIT_TICKS = 2;

export type PaperState = "quoting" | "filled" | "closing" | "closed" | "held" | "missed";

export type PaperSession = {
  asset: PmAsset;
  roundStart: number;
  state: PaperState;
  side: "up" | "down" | null;
  limit: number;
  stake: number;
  ask: number | null;
  bid: number | null;
  /** How far the ask has penetrated past our limit, in ticks. */
  penetration: number | null;
  shares: number | null;
  openedAfterMs: number | null;
  upWon: boolean | null;
  pnl: number | null;
  note: string;
};

export type PaperJournalEntry = PaperSession & { id: string; roundEnd: number };

export type PaperTotals = ReturnType<typeof sessionPnl>;

export type PaperConsole = {
  sessions: Partial<Record<PmAsset, PaperSession>>;
  journal: PaperJournalEntry[];
  totals: PaperTotals;
  now: number;
  start: number;
  end: number;
  settings: PaperSettings;
};

/**
 * The cheap side is the one we quote.
 *
 * DOWN is an exact complement of UP, so exactly one of the two asks is at or
 * below 0.50 at any moment, and a 0.50 limit is therefore always reachable on
 * one side without us forecasting anything.
 */
function candidateSide(upAsk: number | null): "up" | "down" {
  return upAsk !== null && upAsk < 0.5 ? "up" : "down";
}

const empty = (asset: PmAsset, roundStart: number, limit: number, stake: number): PaperSession => ({
  asset,
  roundStart,
  state: "quoting",
  side: null,
  limit,
  stake,
  ask: null,
  bid: null,
  penetration: null,
  shares: null,
  openedAfterMs: null,
  upWon: null,
  pnl: null,
  note: "Ждём стакан.",
});

/**
 * Virtual maker trading against the live book.
 *
 * This is deliberately the most pessimistic reading of the same strategy the
 * backtest studied, and the difference is the entire point:
 *
 *   - a fill needs the price to PENETRATE the limit by a tick, not touch it,
 *     because falling prices hit bids rather than lifting them
 *   - a fill is booked at our limit, never at the worse price that crossed us
 *   - a resting quote expires, because a stale order is not the liquidity it
 *     claims to be
 *   - the exit must penetrate too, symmetrically, which is where the backtest
 *     was most generous with itself
 *
 * Nothing here sends an order or moves money. It reads the same public CLOB
 * endpoints and books what a resting order would plausibly have achieved.
 */
export function usePaperSession(
  limit: number = DEFAULT_LIMIT,
  stake: number = DEFAULT_STAKE_USD,
  settings: PaperSettings = DEFAULT_PAPER,
): PaperConsole {
  const [now, setNow] = useState(() => Date.now());
  const [rounds, setRounds] = useState<Partial<Record<PmAsset, PmRound | null>>>({});
  const [sessions, setSessions] = useState<Partial<Record<PmAsset, PaperSession>>>({});
  const [journal, setJournal] = useState<PaperJournalEntry[]>([]);
  const [positions, setPositions] = useState<Partial<Record<PmAsset, PaperPosition>>>({});

  const fetchRound = useAction(api.polymarket.fetchRound);
  const logSignal = useMutation(api.signals.logSignal);
  const inFlight = useRef(false);

  const startSec = pmRoundStart(now);
  const start = startSec * 1000;
  const bucket = Math.floor(now / BOOK_POLL_MS);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    let cancelled = false;
    void Promise.all(ASSETS.map((asset) => fetchRound({ asset, start: startSec })))
      .then(([btc, eth]) => {
        if (cancelled) return;
        setRounds({ btc: btc ?? null, eth: eth ?? null });
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
  }, [fetchRound, startSec, bucket]);

  // The state machine, one pass per poll.
  useEffect(() => {
    setSessions((previous) => {
      const next: Partial<Record<PmAsset, PaperSession>> = {};
      for (const asset of ASSETS) {
        const round = rounds[asset];
        const existing = previous[asset];
        if (!existing || existing.roundStart !== start) {
          next[asset] = empty(asset, start, limit, stake);
          continue;
        }
        const session: PaperSession = { ...existing, stake };
        if (round?.upAsk != null) {
          session.side = session.side ?? candidateSide(round.upAsk);
          session.ask = session.side === "up" ? round.upAsk : round.downAsk;
          session.bid = session.side === "up" ? round.upBid : round.downBid;
        }

        const book = {
          bid: session.bid,
          ask: session.ask,
          depthAtLimit: 0,
          now,
        };
        const openPositionState = positions[asset];

        if (session.state === "quoting") {
          const check = checkBuyFill(session.limit, book, settings);
          if (check.filled) {
            const order = {
              id: `${asset}-${session.roundStart}`,
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
              setPositions((p) => ({ ...p, [asset]: position }));
              session.state = "filled";
              session.shares = position.shares;
              session.openedAfterMs = now - session.roundStart;
              session.note = `Набито. ${check.reason}. ${position.shares.toFixed(2)} шар на $${session.stake}.`;
            }
          } else {
            session.penetration = session.ask != null ? session.limit - session.ask : null;
            session.note =
              session.ask == null
                ? "Ждём котировку ask."
                : `Заявка ${session.limit.toFixed(2)} в стакане. ${check.reason}.`;
          }
        } else if (session.state === "filled" && openPositionState) {
          session.state = "closing";
        } else if (session.state === "closing" && openPositionState) {
          const exit = checkSellFill(openPositionState.exitPrice, book, settings);
          if (exit.filled) {
            const closed = closePosition(openPositionState, exit.fillPrice, now, TRADE_FEE_RATE);
            setPositions((p) => ({ ...p, [asset]: closed }));
            session.state = "closed";
            session.pnl = closed.pnl;
            session.note = `Выход. ${closed.reason}.`;
          } else {
            session.note = `Держим ${openPositionState.shares.toFixed(2)} шар. ${exit.reason}.`;
          }
        }
        next[asset] = session;
      }
      return next;
    });
  }, [rounds, now, start, limit, stake, settings, positions]);

  /**
   * Grade the round that just ended on Polymarket's own published result.
   * A position still open at the close becomes `held` and is settled at the
   * real resolution — never on our own guess about where the market went.
   */
  const closeRound = useCallback(
    async (asset: PmAsset, session: PaperSession, round: PmRound | null | undefined) => {
      if (session.upWon !== null) return;
      const upWon = await settledUp(round?.slug ?? "");
      if (upWon === null) return;
      const won = session.side === "up" ? upWon : !upWon;
      const held = positions[asset];
      let pnl: number | null = null;
      if (held) {
        const settled = settlePosition(held, won, now, TRADE_FEE_RATE);
        setPositions((p) => ({ ...p, [asset]: settled }));
        pnl = settled.pnl;
      }
      const entry: PaperJournalEntry = {
        ...session,
        id: `${asset}-${session.roundStart}`,
        roundEnd: session.roundStart + ROUND_MS,
        // A round can only end as held (we had a position) or missed (we did
        // not). A closed position never reaches here — it closed mid-round and
        // is already journalled by the state machine.
        state: held ? "held" : "missed",
        upWon,
        pnl,
        note: held
          ? `Держали до расчёта, ${session.side?.toUpperCase()} — ${won ? "выигрыш" : "убыток"}.`
          : "Заявка не набралась — сделки не было.",
      };
      setJournal((previous) => [entry, ...previous].slice(0, 60));

      if (session.side) {
        const tokenId = session.side === "up" ? round?.upTokenId : round?.downTokenId;
        await logSignal({
          symbol: SYMBOL_OF_ASSET[asset],
          windowStart: session.roundStart,
          windowEnd: session.roundStart + ROUND_MS,
          marketSlug: round?.slug ?? undefined,
          tokenId: tokenId ?? undefined,
          direction: session.side,
          entryLimitPrice: session.limit,
          entryAsk: session.ask ?? undefined,
          exited: session.state === "closed",
          notes: [entry.note, `paper: ${settings.penetrationTicks}-тиковое проникновение`],
        }).catch((error: unknown) => {
          console.warn("[paper] could not journal the trade", error);
        });
      }
    },
    [logSignal, positions, now, settings.penetrationTicks],
  );

  const graded = useRef<number>(0);
  useEffect(() => {
    if (now - start < ROUND_MS) return;
    if (graded.current === start) return;
    graded.current = start;
    for (const asset of ASSETS) {
      const session = sessions[asset];
      if (!session || session.roundStart !== start) continue;
      if (session.state === "closed" || session.state === "held") continue;
      void closeRound(asset, session, rounds[asset]);
    }
  }, [now, start, sessions, rounds, closeRound]);

  return {
    sessions,
    journal,
    totals: sessionPnl(
      ASSETS.map((asset) => positions[asset]).filter((p): p is PaperPosition => Boolean(p)),
    ),
    now,
    start,
    end: start + ROUND_MS,
    settings,
  };
}

/** Exported for the dashboard's explanation of what a live session is doing. */
export const PAPER_TICKET_SIZE = 5;
export { isQuoteStale, EXIT_TICKS };
