import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { signalFactorValidator } from "./schema";

/**
 * The strategy journal.
 *
 * `logSignal` locks a call the moment the engine publishes it — a round is
 * written once and never rewritten, which is what makes the journal an honest
 * track record instead of a moving target. `resolveSignal` grades the locked
 * call against the real close of the round.
 */

export const logSignal = mutation({
  args: {
    symbol: v.string(),
    windowStart: v.number(),
    windowEnd: v.number(),
    direction: v.union(v.literal("up"), v.literal("down")),
    score: v.number(),
    confidence: v.number(),
    effectiveConfidence: v.number(),
    estimatedProbability: v.number(),
    maxEntryPrice: v.number(),
    entryLimitPrice: v.optional(v.number()),
    referencePrice: v.number(),
    regime: v.string(),
    phaseAtSignal: v.union(
      v.literal("early"),
      v.literal("mid"),
      v.literal("late"),
    ),
    entryDeadline: v.number(),
    factors: v.array(signalFactorValidator),
    notes: v.array(v.string()),
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

export const resolveSignal = mutation({
  args: {
    id: v.id("signals"),
    closePrice: v.number(),
  },
  handler: async (ctx, { id, closePrice }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const signal = await ctx.db.get(id);
    if (!signal || signal.userId !== userId) return null;
    if (signal.outcome) return signal.outcome;

    const moved = closePrice - signal.referencePrice;
    const settled = moved === 0 ? "tie" : moved > 0 ? "up" : "down";
    const outcome =
      settled === "tie" ? "tie" : settled === signal.direction ? "win" : "loss";

    await ctx.db.patch(id, { closePrice, outcome, resolvedAt: Date.now() });
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

export const signalStats = query({
  args: { symbol: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return {
        total: 0,
        resolved: 0,
        wins: 0,
        losses: 0,
        ties: 0,
        pending: 0,
        totalPnl: 0,
        winRate: null as number | null,
        lastResults: [] as ("win" | "loss" | "tie")[],
      };
    }
    const symbol = args.symbol;

    const rows = symbol
      ? await ctx.db
          .query("signals")
          .withIndex("by_user_symbol_window", (q) =>
            q.eq("userId", userId).eq("symbol", symbol),
          )
          .order("desc")
          .take(500)
      : await ctx.db
          .query("signals")
          .withIndex("by_user_window", (q) => q.eq("userId", userId))
          .order("desc")
          .take(500);

    let wins = 0;
    let losses = 0;
    let ties = 0;
    let pending = 0;
    let totalPnl = 0;
    const lastResults: ("win" | "loss" | "tie")[] = [];

    for (const row of rows) {
      if (!row.outcome) {
        pending += 1;
        continue;
      }
      if (row.outcome === "win") {
        wins += 1;
        const entryPrice = row.entryLimitPrice ?? row.maxEntryPrice;
        // A $1 stake buys 1 / entryPrice contracts. Subtract the $1
        // stake to report net profit rather than gross payout.
        totalPnl += entryPrice > 0 ? 1 / entryPrice - 1 : 0;
      } else if (row.outcome === "loss") {
        losses += 1;
        totalPnl -= 1;
      } else {
        ties += 1;
      }
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
    const rows = await ctx.db
      .query("signals")
      .withIndex("by_user_window", (q) => q.eq("userId", userId))
      .take(500);
    for (const row of rows) {
      await ctx.db.delete(row._id);
    }
    return rows.length;
  },
});
