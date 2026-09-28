import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { Infer, v } from "convex/values";

// default user roles. can add / remove based on the project as needed
export const ROLES = {
  ADMIN: "admin",
  USER: "user",
  MEMBER: "member",
} as const;

export const roleValidator = v.union(
  v.literal(ROLES.ADMIN),
  v.literal(ROLES.USER),
  v.literal(ROLES.MEMBER),
);
export type Role = Infer<typeof roleValidator>;

/** One line of strategy reasoning stored next to every logged signal. */
export const signalFactorValidator = v.object({
  key: v.string(),
  label: v.string(),
  stance: v.union(v.literal("up"), v.literal("down"), v.literal("neutral")),
  weight: v.number(),
  value: v.number(),
  contribution: v.number(),
  detail: v.string(),
});

const schema = defineSchema(
  {
    // default auth tables using convex auth.
    ...authTables, // do not remove or modify

    // the users table is the default users table that is brought in by the authTables
    users: defineTable({
      name: v.optional(v.string()), // name of the user. do not remove
      image: v.optional(v.string()), // image of the user. do not remove
      email: v.optional(v.string()), // email of the user. do not remove
      emailVerificationTime: v.optional(v.number()), // email verification time. do not remove
      isAnonymous: v.optional(v.boolean()), // is the user anonymous. do not remove

      role: v.optional(roleValidator), // role of the user. do not remove
    }).index("email", ["email"]), // index for the email. do not remove or modify

    // add other tables here

    // Strategy journal: every directional call the engine publishes is locked
    // here once, then resolved against the real round close so the strategy can
    // be graded round by round.
    signals: defineTable({
      userId: v.id("users"),
      symbol: v.string(),
      windowStart: v.number(),
      windowEnd: v.number(),
      /** Polymarket market this call was priced against, e.g. btc-updown-15m-… */
      marketSlug: v.optional(v.string()),
      /** CLOB token id of the side that was bought. */
      tokenId: v.optional(v.string()),
      /** Real Polymarket bid/ask on that token at the moment of the call. */
      entryBid: v.optional(v.number()),
      entryAsk: v.optional(v.number()),
      direction: v.union(v.literal("up"), v.literal("down")),
      /**
       * Legacy candle-engine fields. Optional because the current entry rule is
       * driven by the real Polymarket book and produces none of them; kept so
       * historical rows stay readable.
       */
      score: v.optional(v.number()),
      confidence: v.optional(v.number()),
      effectiveConfidence: v.optional(v.number()),
      estimatedProbability: v.optional(v.number()),
      maxEntryPrice: v.optional(v.number()),
      /** The price cap calculated when the call was locked, if available. */
      entryLimitPrice: v.optional(v.number()),
      referencePrice: v.optional(v.number()),
      regime: v.optional(v.string()),
      /**
       * Legacy: the candle-engine phase at the time of the call. The maker
       * strategy has no phases — it rests a limit and manages the fill.
       */
      phaseAtSignal: v.optional(
        v.union(v.literal("early"), v.literal("mid"), v.literal("late")),
      ),
      entryDeadline: v.optional(v.number()),
      factors: v.optional(v.array(signalFactorValidator)),
      notes: v.optional(v.array(v.string())),
      createdAt: v.number(),
      closePrice: v.optional(v.number()),
      /**
       * Maker-exit strategy: the position was given back at the entry price
       * before the round resolved, so the trade is a flat round trip rather
       * than a win or a loss. The outcome is recorded as "tie".
       */
      exited: v.optional(v.boolean()),
      /** True when Polymarket settled the market on the UP token. */
      upWon: v.optional(v.boolean()),
      outcome: v.optional(
        v.union(v.literal("win"), v.literal("loss"), v.literal("tie")),
      ),
      resolvedAt: v.optional(v.number()),
    })
      .index("by_user_window", ["userId", "windowStart"])
      .index("by_user_symbol_window", ["userId", "symbol", "windowStart"]),

    // Executable quotes, archived FORWARD, one row per poll.
    //
    // A backtest on real money needs the price that could actually have been
    // paid, and that price does not exist in the past: a resolved market's book
    // is empty (measured — 99 bids, zero asks), and the trade endpoints return
    // nothing at all for these tokens. So the only honest source is a book we
    // watch while it is live, which is what this table is.
    //
    // These rows are deliberately NOT per-user. A quote is a fact about the
    // market, identical for everyone, and duplicating it per account would
    // make the archive describe how many people were watching rather than what
    // the market did.
    //
    // The window is the decision point: a RetMag entry is evaluated 20 seconds
    // into the round, so a mid sampled 90 seconds in says nothing about
    // whether the entry was reachable.
    pmQuotes: defineTable({
      /** Round this quote belongs to, unix seconds. */
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
      createdAt: v.number(),
    })
      .index("by_round", ["roundStart"])
      // Per round AND per market. Capping only on roundStart let BTC and ETH
      // share one budget, so whichever polled first could starve the other —
      // and a missing half of the sample is indistinguishable from a market
      // that stopped quoting.
      .index("by_round_asset", ["roundStart", "asset", "interval"]),
  },
  {
    schemaValidation: false,
  },
);

export default schema;
