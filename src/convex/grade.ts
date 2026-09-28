import { v } from "convex/values";

import { api } from "./_generated/api";
import { action } from "./_generated/server";

import { pmSlug, settledUp } from "../lib/pm/markets";
import { FLOW_THRESHOLD, RET_MAG_THR_BPS } from "../lib/retmag/rule";

/**
 * Grade the archive against the real outcome of each round.
 *
 * WHY THIS EXISTS
 * ---------------
 * The console showed a signal and archived quotes but never showed an ANSWER.
 * Watching a rule decide is not evidence. The only number that decides whether
 * this is a business is the gap between how often the call was right and what
 * the entry price already paid for it:
 *
 *     edge = hit rate − average ask
 *
 * On a calibrated market that gap is the whole game. A rule that hits 69% while
 * entering near 0.50 is not a 19-point edge, it is a contradiction, and the
 * only way to tell those apart is to price the entry and the outcome against
 * each other on the SAME round.
 *
 * THE PRICE MUST BE AN ASK, NOT A MID
 * -----------------------------------
 * Grading on a mid is how the earlier walk-forward produced a beautiful P&L out
 * of a number nobody could pay. Here the entry is the real ask observed at the
 * decision point, and a round with no ask in the window is DROPPED rather than
 * filled in with an interpolated mid. A dropped round is counted, so a shrinking
 * sample is visible instead of silently absorbed.
 */
export const grade = action({
  args: {
    /** Only grade rounds older than this, so the last one is left to settle. */
    olderThanSec: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const olderThan = args.olderThanSec ?? 0;
    const limit = args.limit ?? 400;

    // A generous fetch: each round writes ~11 snapshots, so 40 rounds of book
    // is only a few hundred rows. The cap protects the action, not the result.
    const rows = await ctx.runQuery(api.quotes.listQuotes, { limit: 5000 });
    if (!rows || rows.length === 0) {
      // Same shape as a full grading run. An empty archive is a real state, not
      // a different response type, so the client has one thing to render.
      return { rounds: 0, signals: 0, wins: 0, noQuote: 0, noOutcome: 0, ...emptyStats() };
    }

    // Group by round, keeping the snapshot closest to the +20s decision point.
    // The rule trades at +20s, so grading it against a quote from +45s would be
    // measuring a different moment than the one the decision was made on.
    type Round = {
      roundStart: number;
      asset: "btc" | "eth";
      interval: 5 | 15;
      upAsk: number | null;
      downAsk: number | null;
      /** Distance of the stored snapshot from the decision point, in ms. */
      dist: number;
    };
    const rounds = new Map<string, Round>();
    for (const r of rows as QuoteRow[]) {
      if (r.roundStart > olderThan) continue;
      const key = `${r.roundStart}:${r.asset}:${r.interval}`;
      const dist = Math.abs(r.t - 20_000);
      const prev = rounds.get(key);
      if (!prev) {
        rounds.set(key, {
          roundStart: r.roundStart,
          asset: r.asset,
          interval: r.interval,
          upAsk: r.upAsk ?? null,
          downAsk: r.downAsk ?? null,
          dist,
        });
        continue;
      }
      // Keep the snapshot nearest +20s. The previous distance has to be stored
      // explicitly: recomputing it from the wrong row is what made this
      // comparison meaningless on the first pass.
      if (dist < prev.dist) {
        prev.upAsk = r.upAsk ?? prev.upAsk;
        prev.downAsk = r.downAsk ?? prev.downAsk;
        prev.dist = dist;
      }
    }

    const list = [...rounds.values()].slice(0, limit);

    let noQuote = 0;
    let noOutcome = 0;
    let signals = 0;
    let wins = 0;
    let askSum = 0;
    let pnlSum = 0;
    const buckets = new Map<string, { n: number; wins: number; askSum: number; pnlSum: number }>();

    for (const round of list) {
      const upWon = await settledUp(pmSlug(round.asset, round.roundStart, round.interval));
      if (upWon === null) {
        // Not settled yet. Counted, never assumed — treating an unknown outcome
        // as a loss is how an absence of data becomes a confident negative.
        noOutcome += 1;
        continue;
      }

      // The signal is not recomputed here: the archive holds the book, not the
      // 1-second Binance candles the rule reads. What IS reproducible from the
      // archive is the PRICE side of the question, so this grades entry price
      // against outcome, which is the number that was missing.
      const ask = upWon ? round.upAsk : round.downAsk;
      if (ask == null) {
        noQuote += 1;
        continue;
      }

      signals += 1;
      const won = upWon;
      if (won) wins += 1;
      askSum += ask;

      // Net per share: winner pays 1, loser pays 0, minus the 200bps taker
      // commission and the 0.5c slippage per share.
      const net = (won ? 1 - ask : -ask) - 0.02 * ask - 0.005;
      pnlSum += net;

      const b = Math.min(0.9, Math.floor(ask * 10) / 10).toFixed(1);
      const bucket = buckets.get(b) ?? { n: 0, wins: 0, askSum: 0, pnlSum: 0 };
      bucket.n += 1;
      if (won) bucket.wins += 1;
      bucket.askSum += ask;
      bucket.pnlSum += net;
      buckets.set(b, bucket);
    }

    const hitRate = signals > 0 ? wins / signals : null;
    const avgAsk = signals > 0 ? askSum / signals : null;
    const avgPnl = signals > 0 ? pnlSum / signals : null;

    return {
      rounds: list.length,
      signals,
      wins,
      noQuote,
      noOutcome,
      hitRate,
      avgAsk,
      avgPnl,
      // The verdict number. Zero means the price already contained the signal.
      edge: hitRate != null && avgAsk != null ? hitRate - avgAsk : null,
      thresholds: { flow: FLOW_THRESHOLD, retMag: RET_MAG_THR_BPS },
      buckets: [...buckets.entries()]
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([price, b]) => ({
          price: Number(price),
          n: b.n,
          hitRate: b.n > 0 ? b.wins / b.n : null,
          avgAsk: b.askSum / b.n,
          edge: b.n > 0 ? b.wins / b.n - b.askSum / b.n : null,
          avgPnl: b.pnlSum / b.n,
        })),
    };
  },
});

type QuoteRow = {
  roundStart: number;
  asset: "btc" | "eth";
  interval: 5 | 15;
  t: number;
  upAsk?: number;
  upBid?: number;
  downAsk?: number;
  downBid?: number;
};

function emptyStats() {
  return {
    hitRate: null as number | null,
    avgAsk: null as number | null,
    avgPnl: null as number | null,
    edge: null as number | null,
    buckets: [] as {
      price: number;
      n: number;
      hitRate: number | null;
      avgAsk: number;
      edge: number | null;
      avgPnl: number;
    }[],
  };
}
