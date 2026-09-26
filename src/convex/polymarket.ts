/**
 * Real 15-minute "Up or Down" rounds on Polymarket.
 *
 * The engine used to invent its own contract price, which is why the journal
 * showed a large simulated profit and a large real loss. Everything below is
 * read from Polymarket's public Gamma API, so the price the console shows is
 * the price the contract can actually be bought at.
 *
 * Market slug pattern: `<asset>-updown-15m-<intervalStartUnixSeconds>`,
 * resolved against Chainlink BTC/USD / ETH/USD.
 *
 * The two outcome tokens are exact complements, so the DOWN side is derived
 * from the UP side: whoever sells DOWN at x is buying UP at 1 - x.
 */

import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { api } from "./_generated/api";
import { action } from "./_generated/server";

const GAMMA = "https://gamma-api.polymarket.com";
/** 15-minute rounds. */
const ROUND_S = 900;

/** Polymarket's published outcome for a market slug, or null while unresolved. */
export async function settledUp(slug: string): Promise<boolean | null> {
  try {
    const response = await fetch(`${GAMMA}/events?slug=${slug}`);
    if (!response.ok) return null;
    const events = (await response.json()) as Record<string, unknown>[];
    const market = (events[0]?.markets as Record<string, unknown>[] | undefined)?.[0];
    if (!market) return null;
    const prices = JSON.parse(String(market.outcomePrices)) as string[];
    if (prices[0] === "1" && prices[1] === "0") return true;
    if (prices[0] === "0" && prices[1] === "1") return false;
  } catch {
    /* not resolved yet */
  }
  return null;
}

export const PM_ASSETS = ["btc", "eth"] as const;
export type PmAsset = (typeof PM_ASSETS)[number];

/** Interval start of the round that contains `now`, in unix seconds. */
export function pmRoundStart(nowMs: number): number {
  return Math.floor(nowMs / 1000 / ROUND_S) * ROUND_S;
}

export function pmSlug(asset: PmAsset, startSec: number): string {
  return `${asset}-updown-15m-${startSec}`;
}

export type PmRound = {
  asset: PmAsset;
  start: number;
  end: number;
  slug: string;
  title: string;
  upTokenId: string | null;
  downTokenId: string | null;
  /** Best bid/ask on the UP token, 0-1. */
  upBid: number | null;
  upAsk: number | null;
  /** Derived from the complement, 0-1. */
  downBid: number | null;
  downAsk: number | null;
  /**
   * Where the quote came from. The CLOB book is the only thing that reflects
   * what can actually be traded right now: Gamma's own `bestBid`/`bestAsk` on
   * the event lag behind the book by cents, which would make the console quote
   * a price nobody can buy at.
   */
  priceSource: "book" | "stale" | "none";
  closed: boolean;
  /** True when UP settled. null until the market resolves. */
  upWon: boolean | null;
};

const round2 = (value: number) => Math.round(value * 100) / 100;

const num = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const CLOB = "https://clob.polymarket.com";

/** Best bid/ask on a CLOB token, or nulls when that side of the book is empty. */
async function topOfBook(
  tokenId: string | null,
): Promise<{ bid: number | null; ask: number | null }> {
  if (!tokenId) return { bid: null, ask: null };
  try {
    const response = await fetch(`${CLOB}/book?token_id=${tokenId}`);
    if (!response.ok) return { bid: null, ask: null };
    const book = (await response.json()) as {
      bids?: { price: string }[];
      asks?: { price: string }[];
    };
    const bids = (book.bids ?? []).map((b) => num(b.price)).filter((p): p is number => p !== null);
    const asks = (book.asks ?? []).map((a) => num(a.price)).filter((p): p is number => p !== null);
    return {
      bid: bids.length > 0 ? Math.max(...bids) : null,
      ask: asks.length > 0 ? Math.min(...asks) : null,
    };
  } catch {
    return { bid: null, ask: null };
  }
}

/**
 * Fetch one round by asset and interval start.
 *
 * This is an ACTION, not a query: Convex only allows outbound `fetch` from
 * actions, and this handler reads Polymarket's live book. Resolves to a
 * PmRound with `upWon: null` while the market is running, and to a settled
 * `upWon` once Polymarket has published the result.
 */
export const fetchRound = action({
  args: {
    asset: v.union(v.literal("btc"), v.literal("eth")),
    start: v.number(),
  },
  handler: async (_ctx, args): Promise<PmRound | null> => {
    const slug = pmSlug(args.asset, args.start);
    const response = await fetch(`${GAMMA}/events?slug=${slug}`);
    if (!response.ok) return null;
    const events = (await response.json()) as Record<string, unknown>[];
    const event = events[0];
    if (!event) return null;

    const markets = (event.markets as Record<string, unknown>[] | undefined) ?? [];
    const market = markets[0];
    if (!market) return null;

    let upTokenId: string | null = null;
    let downTokenId: string | null = null;
    try {
      const ids = JSON.parse(String(market.clobTokenIds)) as string[];
      upTokenId = ids[0] ?? null;
      downTokenId = ids[1] ?? null;
    } catch {
      /* leave both null */
    }

    let upWon: boolean | null = null;
    try {
      const prices = JSON.parse(String(market.outcomePrices)) as string[];
      if (prices[0] === "1" && prices[1] === "0") upWon = true;
      else if (prices[0] === "0" && prices[1] === "1") upWon = false;
    } catch {
      /* not resolved yet */
    }

    const closed = Boolean(event.closed) || upWon !== null;

    // The live book is authoritative. Gamma's snapshot is only a fallback: it
    // was observed trailing the real book by several cents, and quoting it
    // would advertise an entry price that cannot be filled.
    const book = await topOfBook(upTokenId);
    const useBook = book.bid !== null && book.ask !== null;
    const upBid = useBook ? book.bid : num(market.bestBid);
    const upAsk = useBook ? book.ask : num(market.bestAsk);
    const priceSource: PmRound["priceSource"] = useBook
      ? "book"
      : upBid === null && upAsk === null
        ? "none"
        : "stale";

    return {
      asset: args.asset,
      start: args.start,
      end: args.start + ROUND_S,
      slug,
      title: String(event.title ?? slug),
      upTokenId,
      downTokenId,
      upBid,
      upAsk,
      // The outcome tokens are complements: DOWN's ask is 1 - UP's bid.
      downBid: upAsk === null ? null : round2(1 - upAsk),
      downAsk: upBid === null ? null : round2(1 - upBid),
      priceSource,
      closed,
      upWon,
    };
  },
});

/**
 * Grade every still-open call against Polymarket's published result.
 *
 * Lives in an action because it makes outbound requests; the writes go through
 * the `applyResolution` mutation, which re-checks ownership. The console calls
 * it on a timer, so the bot never invents an outcome — it reads the one the
 * exchange settled on.
 */
export const syncResolutions = action({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { resolved: 0 };

    const rows = await ctx.runQuery(api.signals.unresolvedSignals, {
      limit: args.limit ?? 20,
    });

    let resolved = 0;
    for (const row of rows) {
      if (row.outcome) continue;
      if (row.windowEnd + 5000 > Date.now()) continue;
      if (!row.marketSlug) continue;

      const upWon = await settledUp(row.marketSlug);
      if (upWon === null) continue;

      await ctx.runMutation(api.signals.applyResolution, { id: row._id, upWon });
      resolved += 1;
    }
    return { resolved };
  },
});
