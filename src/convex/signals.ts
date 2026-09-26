import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { signalFactorValidator } from "./schema";

/**
 * The strategy journal.
 *
 * The old version of this file graded calls against a Binance close and
 * valued them at a price the engine invented for itself — which is how the
 * journal could show a large simulated profit while the real book lost money.
 *
 * Now a call is only ever written when the bot has a real Polymarket ask, the
 * real ask is stored alongside it, and the call is graded against Polymarket's
 * own published result for that market. No price in this file is estimated.
 *
 * Note the deliberate absence of `fetch` here: Convex only allows outbound
 * requests from actions, so reading Polymarket's resolution lives in
 * `polymarket.syncResolutions`, which calls `applyResolution` below.
 */

export const logSignal = mutation({
  args: {
    symbol: v.string(),
    windowStart: v.number(),
    windowEnd: v.number(),
    marketSlug: v.optional(v.string()),
    tokenId: v.optional(v.string()),
    direction: v.union(v.literal("up"), v.literal("down")),
    score: v.optional(v.number()),
    confidence: v.optional(v.number()),
    effectiveConfidence: v.optional(v.number()),
    estimatedProbability: v.optional(v.number()),
    maxEntryPrice: v.optional(v.number()),
    entryLimitPrice: v.optional(v.number()),
    entryBid: v.optional(v.number()),
    entryAsk: v.optional(v.number()),
    referencePrice: v.optional(v.number()),
    regime: v.optional(v.string()),
    phaseAtSignal: v.union(
      v.literal("early"),
      v.literal("mid"),
      v.literal("late"),
    ),
    entryDeadline: v.optional(v.number()),
    factors: v.optional(v.array(signalFactorValidator)),
    notes: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const existing = await ctx.db
      .query("signals")
      .withIndex("by_user_symbol_window", (q) =>
        q
          .eq("userId", userId)
          .eq("symbol", args.symbol)
          .eq("windowStart", args.windowStart),
      )
      .first();
    if (existing) return existing._id;

    return await ctx.db.insert("signals", {
      ...args,
      userId,
      createdAt: Date.now(),
    });
  },
});

/**
 * Apply one resolution read by the `syncResolutions` action.
 *
 * The action does the network read; this mutation does the write, so ownership
 * is re-checked here rather than trusted from the caller.
 */
export const applyResolution = mutation({
  args: { id: v.id("signals"), upWon: v.boolean() },
  handler: async (ctx, { id, upWon }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const signal = await ctx.db.get(id);
    if (!signal || signal.userId !== userId) return null;
    if (signal.outcome) return signal.outcome;
    const outcome = (upWon ? "up" : "down") === signal.direction ? "win" : "loss";
    await ctx.db.patch(id, { upWon, outcome, resolvedAt: Date.now() });
    return outcome;
  },
});

export const unresolvedSignals = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const rows = await ctx.db
      .query("signals")
      .withIndex("by_user_window", (q) => q.eq("userId", userId))
      .order("desc")
      .take(limit ?? 30);
    return rows.filter((row) => row.outcome === undefined);
  },
});

export const recentSignals = query({
  args: {
    symbol: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const symbol = args.symbol;
    const take = args.limit ?? 50;

    if (symbol) {
      return await ctx.db
        .query("signals")
        .withIndex("by_user_symbol_window", (q) =>
          q.eq("userId", userId).eq("symbol", symbol),
        )
        .order("desc")
        .take(take);
    }

    return await ctx.db
      .query("signals")
      .withIndex("by_user_window", (q) => q.eq("userId", userId))
      .order("desc")
      .take(take);
  },
});

/** The price a $1 stake was actually committed at. */
const paidAt = (row: { entryAsk?: number; entryLimitPrice?: number; maxEntryPrice?: number }) => {
  const price = row.entryAsk ?? row.entryLimitPrice ?? row.maxEntryPrice;
  return typeof price === "number" && price > 0 ? price : null;
};

export const signalStats = query({
  args: { symbol: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const empty = {
      total: 0,
      resolved: 0,
      wins: 0,
      losses: 0,
      ties: 0,
      pending: 0,
      totalPnl: 0,
      realPnl: 0,
      realTrades: 0,
      realWins: 0,
      avgAsk: null as number | null,
      winRate: null as number | null,
      lastResults: [] as ("win" | "loss" | "tie")[],
    };
    const userId = await getAuthUserId(ctx);
    if (!userId) return empty;
    const symbol = args.symbol;

    const rows = symbol
      ? await ctx.db
          .query("signals")
          .withIndex("by_user_symbol_window", (q) =>
            q.eq("userId", userId).eq("symbol", symbol),
          )
          .order("desc")
          .take(1000)
      : await ctx.db
          .query("signals")
          .withIndex("by_user_window", (q) => q.eq("userId", userId))
          .order("desc")
          .take(1000);

    let wins = 0;
    let losses = 0;
    let ties = 0;
    let pending = 0;
    let totalPnl = 0;
    let realPnl = 0;
    let realTrades = 0;
    let realWins = 0;
    let askSum = 0;
    const lastResults: ("win" | "loss" | "tie")[] = [];

    for (const row of rows) {
      if (!row.outcome) {
        pending += 1;
        continue;
      }
      // A $1 stake buys 1 / price contracts; the stake is subtracted so the
      // number is net profit, not gross payout.
      const price = paidAt(row);
      const pnl = price === null ? 0 : row.outcome === "win" ? 1 / price - 1 : -1;
      totalPnl += pnl;

      if (row.entryAsk !== undefined && row.entryAsk > 0) {
        realPnl += pnl;
        realTrades += 1;
        askSum += row.entryAsk;
        if (row.outcome === "win") realWins += 1;
      }

      if (row.outcome === "win") wins += 1;
      else if (row.outcome === "loss") losses += 1;
      else ties += 1;
      if (lastResults.length < 50) lastResults.push(row.outcome);
    }

    const resolved = wins + losses + ties;
    const decisive = wins + losses;

    return {
      total: rows.length,
      resolved,
      wins,
      losses,
      ties,
      pending,
      totalPnl: Math.round(totalPnl * 100) / 100,
      realPnl: Math.round(realPnl * 100) / 100,
      realTrades,
      realWins,
      avgAsk: realTrades > 0 ? Math.round((askSum / realTrades) * 1000) / 1000 : null,
      winRate: decisive === 0 ? null : Math.round((wins / decisive) * 1000) / 10,
      lastResults,
    };
  },
});

export const clearSignals = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    // Delete the whole journal, not just the newest slice: the accuracy shown in
    // the UI is measured over every stored row, so a partial clear would keep
    // diluting the current strategy with calls made by the previous one.
    const batchSize = 500;
    const maxRows = 5000;
    let deleted = 0;
    while (deleted < maxRows) {
      const rows = await ctx.db
        .query("signals")
        .withIndex("by_user_window", (q) => q.eq("userId", userId))
        .take(batchSize);
      if (rows.length === 0) break;
      for (const row of rows) {
        await ctx.db.delete(row._id);
      }
      deleted += rows.length;
      if (rows.length < batchSize) break;
    }
    return deleted;
  },
});
