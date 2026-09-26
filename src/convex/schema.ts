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
      /** Polymarket market this call was priced against, e.g. btc-updown-5m-… */
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
      phaseAtSignal: v.union(
        v.literal("early"),
        v.literal("mid"),
        v.literal("late"),
      ),
      entryDeadline: v.optional(v.number()),
      factors: v.optional(v.array(signalFactorValidator)),
      notes: v.optional(v.array(v.string())),
      createdAt: v.number(),
      closePrice: v.optional(v.number()),
      /** True when Polymarket settled the market on the UP token. */
      upWon: v.optional(v.boolean()),
      outcome: v.optional(
        v.union(v.literal("win"), v.literal("loss"), v.literal("tie")),
      ),
      resolvedAt: v.optional(v.number()),
    })
      .index("by_user_window", ["userId", "windowStart"])
      .index("by_user_symbol_window", ["userId", "symbol", "windowStart"]),
  },
  {
    schemaValidation: false,
  },
);

export default schema;
