import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

/**
 * Forward archive of executable quotes.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * A backtest on real money needs the price that could actually have been paid,
 * and that price does not exist in the past. Measured, not assumed:
 *
 *   - a resolved market's book is EMPTY — 99 bids and zero asks, so there was
 *     nothing to buy even if we had been watching;
 *   - `data-api/trades` returns `[]` for both the current and the daily
 *     market, so there is no executed-trade history for these tokens at all;
 *   - a 1-minute mid cannot resolve a 1-second decision, so the historical
 *     walk-forward can prove the price REACHED a level but says nothing about
 *     whether anyone was willing to sell into our bid there.
 *
 * So the only honest source is a book observed while it is live, which is what
 * this table collects. Every later question — did the signal beat the price it
 * was given, or did the price already contain it — is answerable ONLY from here.
 *
 * These rows are deliberately NOT per-user. A quote is a fact about the market,
 * identical for everyone, and duplicating it per account would make the archive
 * describe how many people were watching rather than what the market did.
 */

/** Ceiling on snapshots per (round, asset, interval). */
const MAX_PER_ROUND = 40;

/**
 * Store one book snapshot, taken while the round is still live.
 *
 * Deliberately public — no auth. The archive exists to make a backtest
 * honest, not to describe who was watching. Requiring a session would mean it
 * only ever covers the periods somebody happened to have a tab open, which is
 * precisely the selection bias that makes a measured edge unreproducible.
 *
 * The cap is enforced here rather than trusted from the client: a console left
 * open on a stalled round would otherwise write thousands of rows all
 * describing the same instant, and the analysis would treat that instant as
 * strong repeated evidence.
 */
export const archiveQuote = mutation({
  args: {
    roundStart: v.number(),
    asset: v.union(v.literal("btc"), v.literal("eth")),
    interval: v.union(v.literal(5), v.literal(15)),
    /** Milliseconds since the round started. */
    t: v.number(),
    upBid: v.optional(v.number()),
    upAsk: v.optional(v.number()),
    downBid: v.optional(v.number()),
    downAsk: v.optional(v.number()),
    priceSource: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("pmQuotes")
      .withIndex("by_round_asset", (q) =>
        q
          .eq("roundStart", args.roundStart)
          .eq("asset", args.asset)
          .eq("interval", args.interval),
      )
      .take(MAX_PER_ROUND + 1);

    // Capped PER ROUND AND PER MARKET. Indexing only on roundStart meant BTC
    // and ETH shared one budget, so whichever polled first could starve the
    // other — and a missing half of the sample reads exactly like a market
    // that stopped quoting.
    if (existing.length >= MAX_PER_ROUND) return null;

    return await ctx.db.insert("pmQuotes", { ...args, createdAt: Date.now() });
  },
});

/** Everything archived, oldest first. Read by the offline analysis script. */
export const listQuotes = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    return await ctx.db.query("pmQuotes").order("asc").take(args.limit ?? 5000);
  },
});

/**
 * How much has been collected, so the console can say "n rounds archived"
 * without reading the whole table.
 *
 * Round count is the number that matters, and it is counted DISTINCTLY: a
 * console polling every 3 seconds writes ~11 rows per round, so counting rows
 * would report roughly a hundredfold more "rounds" than actually happened and
 * make a thin sample look substantial.
 */
export const archiveStats = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("pmQuotes").take(5000);
    const rounds = new Set<string>();
    const perMarket: Record<string, number> = {};
    let firstT: number | null = null;
    let lastT: number | null = null;

    for (const row of rows) {
      rounds.add(`${row.roundStart}:${row.asset}:${row.interval}`);
      const m = `${row.asset}-${row.interval}`;
      perMarket[m] = (perMarket[m] ?? 0) + 1;
      if (firstT === null || row.createdAt < firstT) firstT = row.createdAt;
      if (lastT === null || row.createdAt > lastT) lastT = row.createdAt;
    }

    return {
      quotes: rows.length,
      rounds: rounds.size,
      perMarket,
      firstAt: firstT,
      lastAt: lastT,
    };
  },
});
