/**
 * Real "Up or Down" rounds on Polymarket, at 5 and 15 minutes.
 *
 * The engine used to invent its own contract price, which is why the journal
 * showed a large simulated profit and a large real loss. Everything below is
 * read from Polymarket's public Gamma API, so the price the console shows is
 * the price the contract can actually be bought at.
 *
 * Market slug pattern: `<asset>-updown-<5|15>m-<intervalStartUnixSeconds>`,
 * resolved against Chainlink BTC/USD / ETH/USD.
 *
 * The two outcome tokens are exact complements, so the DOWN side is derived
 * from the UP side: whoever sells DOWN at x is buying UP at 1 - x.
 */

import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { api } from "./_generated/api";
import { action } from "./_generated/server";
// The pure market vocabulary lives outside src/convex on purpose: this file
// imports the Convex SERVER runtime, so a browser component importing any
// value from here drags `convex/server` into the client bundle and the preview
// dies on a 504. See src/lib/pm/markets.ts.
import {
  PM_ASSETS,
  PM_INTERVALS,
  PM_LIMIT_OF,
  pmRoundStart,
  pmSlug,
  settledUp,
  type PmAsset,
  type PmInterval,
  type PmMarket,
  type PmRound,
} from "../lib/pm/markets";

export {
  PM_ASSETS,
  PM_INTERVALS,
  PM_LIMIT_OF,
  pmRoundStart,
  pmSlug,
  settledUp,
};
export type { PmAsset, PmInterval, PmMarket, PmRound };

const GAMMA = "https://gamma-api.polymarket.com";

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
    interval: v.optional(v.union(v.literal(5), v.literal(15))),
  },
  handler: async (_ctx, args): Promise<PmRound | null> => {
    const interval = (args.interval ?? 5) as PmInterval;
    const roundS = interval * 60;
    const slug = pmSlug(args.asset, args.start, interval);
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
      end: args.start + roundS,
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
