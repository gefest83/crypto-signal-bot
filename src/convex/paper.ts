import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

/**
 * Durable storage for the virtual maker console.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The console kept every closed round in React state, which is destroyed when
 * the tab closes. Refreshing the page therefore reported a fresh account: hours
 * of trades vanished and the P&L went back to $0.00, indistinguishable from a
 * console that had never traded at all. For a strategy whose entire claim is a
 * measured edge, a track record that resets on refresh is not evidence of
 * anything.
 *
 * The write is IDEMPOTENT on `(userId, marketKey, roundStart)`. That is the
 * important detail: rounds are graded by a queue that retries with backoff, and
 * React StrictMode double-invokes effects, so the same round reaches this
 * mutation more than once. Keyed on the round itself, a retry updates the
 * existing row instead of appending a second copy of the same trade — which
 * would quietly double the P&L.
 */
export const recordRound = mutation({
  args: {
    marketKey: v.string(),
    asset: v.union(v.literal("btc"), v.literal("eth")),
    interval: v.union(v.literal(5), v.literal(15)),
    roundStart: v.number(),
    quoted: v.boolean(),
    filled: v.optional(v.boolean()),
    exited: v.optional(v.boolean()),
    pnl: v.optional(v.number()),
    entryPrice: v.optional(v.number()),
    exitPrice: v.optional(v.number()),
    stake: v.optional(v.number()),
    shares: v.optional(v.number()),
    upWon: v.optional(v.boolean()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;

    const existing = await ctx.db
      .query("paperRounds")
      .withIndex("by_user_market_round", (q) =>
        q
          .eq("userId", userId)
          .eq("marketKey", args.marketKey)
          .eq("roundStart", args.roundStart),
      )
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, { ...args, userId });
      return existing._id;
    }
    return await ctx.db.insert("paperRounds", { ...args, userId, createdAt: Date.now() });
  },
});

/** Every stored round, oldest first, so the client can rebuild its whole tally. */
/**
 * Store one book snapshot, taken while the round is still live.
 *
 * Deliberately public — no auth. A quote is a fact about the market, and this
 * archive exists to make a backtest honest, not to describe who was watching.
 * Requiring a session would mean the archive only ever covers the periods
 * somebody happened to have a tab open, which is exactly the selection bias
 * that makes a measured edge unreproducible.
 *
 * Writes are capped per round below rather than trusting the client, because a
 * console left open on a stalled round would otherwise write thousands of rows
 * describing a single moment.
 */
export const archiveQuote = mutation({
  args: {
    roundStart: v.number(),
    asset: v.union(v.literal("btc"), v.literal("eth")),
    interval: v.union(v.literal(5), v.literal(15)),
    t: v.number(),
    upBid: v.optional(v.number()),
    upAsk: v.optional(v.number()),
    downBid: v.optional(v.number()),
    downAsk: v.optional(v.number()),
    priceSource: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const recent = await ctx.db
      .query("pmQuotes")
      .withIndex("by_round", (q) => q.eq("roundStart", args.roundStart))
      .take(1);
    for (const _ of recent) {
      const count = await ctx.db
        .query("pmQuotes")
        .withIndex("by_round", (q) => q.eq("roundStart", args.roundStart))
        .take(40);
      if (count.length >= 40) return null;
    }
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

export const listRounds = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    return await ctx.db
      .query("paperRounds")
      .withIndex("by_user_market_round")
      .filter((q) => q.eq(q.field("userId"), userId))
      .take(args.limit ?? 2000);
  },
});

/** Drop the stored history. Exposed so the console can be reset deliberately. */
export const clearRounds = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const rows = await ctx.db
      .query("paperRounds")
      .withIndex("by_user_market_round")
      .filter((q) => q.eq(q.field("userId"), userId))
      .take(5000);
    for (const row of rows) await ctx.db.delete(row._id);
    return rows.length;
  },
});
