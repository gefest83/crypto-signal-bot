import { api } from "../convex/_generated/api";
import { pmRoundStart, settledUp, type PmAsset, type PmRound } from "../convex/polymarket";
import {
  DEFAULT_LIMIT,
  DEFAULT_STAKE_USD,
  stakePnl,
  type Side,
} from "@/lib/strategy/maker-exit";
import { useAction, useMutation } from "convex/react";
import { useCallback, useEffect, useRef, useState } from "react";

/** How often the real Polymarket book is re-read. */
const BOOK_POLL_MS = 5_000;
/** Longest answer Polymarket takes before the next round replaces the market. */
const ROUND_MS = 15 * 60_000;
const ASSETS: PmAsset[] = ["btc", "eth"];
const SYMBOL_OF_ASSET: Record<PmAsset, string> = { btc: "BTCUSDT", eth: "ETHUSDT" };

/**
 * Where a maker trade is in its life. There is no "signal" here and no
 * direction call — the strategy rests one limit and then manages what happens.
 */
export type MakerPhase =
  /** Our bid is resting, waiting for a seller to come to it. */
  | "armed"
  /** Filled and holding, waiting for the price to come back to the limit. */
  | "filled"
  /** Given back at the entry price. The trade is closed and flat. */
  | "exited"
  /** The round ended while we still held. Graded on the real result. */
  | "held"
  /** The round ended and the limit was never filled. */
  | "missed";

export type MakerSession = {
  asset: PmAsset;
  roundStart: number;
  side: Side | null;
  limit: number;
  /** Real USDC committed to this round. Polymarket sells dollars, not shares. */
  stake: number;
  phase: MakerPhase;
  /** Our side's live book: what it costs to buy, what we could sell into. */
  ask: number | null;
  bid: number | null;
  /** When the limit was filled, measured from the round start. */
  filledAfterMs: number | null;
  /** The real result, once known. */
  upWon: boolean | null;
  /** P&L in USDC on the real stake, or null while the trade is still open. */
  pnl: number | null;
  note: string;
};

export type MakerLogEntry = MakerSession & { id: string; roundEnd: number; slug: string | null };

export type MakerConsole = {
  sessions: Partial<Record<PmAsset, MakerSession>>;
  log: MakerLogEntry[];
  now: number;
  start: number;
  end: number;
  limit: number;
  stake: number;
};

const emptySession = (
  asset: PmAsset,
  roundStart: number,
  limit: number,
  stake: number,
): MakerSession => ({
  asset,
  roundStart,
  side: null,
  limit,
  stake,
  phase: "armed",
  ask: null,
  bid: null,
  filledAfterMs: null,
  upWon: null,
  pnl: null,
  note: "Ждём котировку стакана.",
});

/**
 * The side worth quoting is whichever one the market pays more for. DOWN is an
 * exact complement of UP, so exactly one of the two asks is always at or above
 * 0.50 — and a 0.35 limit is therefore always reachable on one side.
 */
function candidateSide(upAsk: number | null): Side {
  return upAsk !== null && upAsk >= 0.5 ? "up" : "down";
}

/**
 * Runs one maker strategy per asset against the live Polymarket book.
 *
 * Both transitions use the real book rather than a mid, which makes the
 * console stricter than the offline study: a fill is only recorded when the ask
 * has actually reached our limit, and an exit only when the bid has actually
 * come back up to it. The live P&L shown here can therefore only be worse than
 * the backtest's +2.1¢, never better.
 */
export function useMakerSession(
  limit: number = DEFAULT_LIMIT,
  stake: number = DEFAULT_STAKE_USD,
): MakerConsole {
  const [now, setNow] = useState(() => Date.now());
  const [rounds, setRounds] = useState<Partial<Record<PmAsset, PmRound | null>>>({});
  const [sessions, setSessions] = useState<Partial<Record<PmAsset, MakerSession>>>({});
  const [log, setLog] = useState<MakerLogEntry[]>([]);

  const fetchRound = useAction(api.polymarket.fetchRound);
  const logSignal = useMutation(api.signals.logSignal);
  const inFlightRef = useRef(false);

  const startSec = pmRoundStart(now);
  const start = startSec * 1000;
  const bucket = Math.floor(now / BOOK_POLL_MS);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Read the real book. Only the book may act: Gamma's snapshot is stale by
  // cents, and the entire strategy is a claim about a fillable price.
  useEffect(() => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    let cancelled = false;
    void Promise.all(ASSETS.map((asset) => fetchRound({ asset, start: startSec })))
      .then(([btc, eth]) => {
        if (cancelled) return;
        setRounds({ btc: btc ?? null, eth: eth ?? null });
      })
      .catch((error: unknown) => {
        console.warn("[maker-session] could not refresh the Polymarket book", error);
      })
      .finally(() => {
        inFlightRef.current = false;
      });
    return () => {
      cancelled = true;
    };
  }, [fetchRound, startSec, bucket]);

  /**
   * The state machine, one pass per poll:
   *
   *   armed  + ask ≤ limit  → filled  (a seller has reached our bid)
   *   filled + bid ≥ limit  → exited  (a buyer has reached our offer)
   *   round over            → held / missed, graded on the real result
   */
  useEffect(() => {
    setSessions((previous) => {
      const next: Partial<Record<PmAsset, MakerSession>> = {};
      for (const asset of ASSETS) {
        const round = rounds[asset];
        const existing = previous[asset];
        if (!existing || existing.roundStart !== start) {
          next[asset] = emptySession(asset, start, limit, stake);
          continue;
        }
        const session: MakerSession = { ...existing, stake };

        if (round?.upAsk != null) {
          session.side = session.side ?? candidateSide(round.upAsk);
          session.ask = session.side === "up" ? round.upAsk : round.downAsk;
          session.bid = session.side === "up" ? round.upBid : round.downBid;
        }

        if (session.phase === "armed" && session.ask !== null && session.ask <= session.limit) {
          session.phase = "filled";
          session.filledAfterMs = now - start;
        } else if (
          session.phase === "filled" &&
          session.bid !== null &&
          session.bid >= session.limit
        ) {
          session.phase = "exited";
          session.pnl = stakePnl(session.stake, session.limit, false, true);
        }

        if (session.phase === "armed") {
          session.note =
            session.ask === null
              ? "Ждём котировку стакана."
              : `Цена ${session.ask.toFixed(2)} выше лимита ${session.limit.toFixed(2)} — заявка в стакане.`;
        } else if (session.phase === "filled") {
          session.note =
            session.bid === null
              ? "Держим позицию, ждём возврата к цене входа."
              : `Держим позицию: bid ${session.bid.toFixed(2)} ниже выхода ${session.limit.toFixed(2)}.`;
        } else if (session.phase === "exited") {
          session.note = `Цена вернулась к ${session.limit.toFixed(2)} — выход, сделка закрыта.`;
        }
        next[asset] = session;
      }
      return next;
    });
  }, [rounds, now, start, limit, stake]);

  /**
   * Close out the round that just ended. A trade still open at the close
   * becomes `held` and is graded on Polymarket's published result — never on
   * our own guess about where the market went.
   */
  const closeRound = useCallback(
    async (asset: PmAsset, session: MakerSession, round: PmRound | null | undefined) => {
      const phase: MakerPhase = session.phase === "filled" ? "held" : "missed";
      if (session.upWon !== null) return;
      const upWon = await settledUp(round?.slug ?? "");
      if (upWon === null) return;

      const won = session.side === "up" ? upWon : !upWon;
      const closed: MakerLogEntry = {
        ...session,
        id: `${asset}-${session.roundStart}`,
        roundEnd: session.roundStart + ROUND_MS,
        phase,
        upWon,
        slug: round?.slug ?? null,
        pnl: phase === "held" ? stakePnl(session.stake, session.limit, won, false) : null,
        note:
          phase === "held"
            ? `Держали $${session.stake} до расчёта, ${session.side?.toUpperCase()} — ${won ? "выигрыш" : "убыток"}.`
            : "Лимит не набрался — сделки не было.",
      };
      setLog((previous) => [closed, ...previous].slice(0, 40));

      if (closed.side) {
        const tokenId = closed.side === "up" ? round?.upTokenId : round?.downTokenId;
        await logSignal({
          symbol: SYMBOL_OF_ASSET[asset],
          windowStart: closed.roundStart,
          windowEnd: closed.roundEnd,
          marketSlug: closed.slug ?? undefined,
          tokenId: tokenId ?? undefined,
          direction: closed.side,
          entryLimitPrice: closed.limit,
          entryAsk: session.ask ?? undefined,
          exited: phase !== "held",
          notes: [closed.note],
        }).catch((error: unknown) => {
          console.warn("[maker-session] could not journal the trade", error);
        });
      }
    },
    [logSignal],
  );

  // Grade the round that has just ended, once, after the book has settled.
  const gradedRef = useRef<number>(0);
  useEffect(() => {
    if (now - start < ROUND_MS) return;
    if (gradedRef.current === start) return;
    gradedRef.current = start;
    for (const asset of ASSETS) {
      const previous = sessions[asset];
      if (!previous || previous.roundStart !== start) continue;
      if (previous.phase !== "filled" && previous.phase !== "armed") continue;
      void closeRound(asset, previous, rounds[asset]);
    }
  }, [now, start, sessions, rounds, closeRound]);

  return { sessions, log, now, start, end: start + ROUND_MS, limit, stake };
}
