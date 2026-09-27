/**
 * Polymarket market vocabulary — shared by the Convex backend and the browser.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * These constants, the slug builder and the outcome reader are all pure: no
 * database, no auth, no server runtime. They used to live inside
 * `src/convex/polymarket.ts` next to the actions that use them, and the
 * browser imported them from there.
 *
 * That is the bug this file fixes. `src/convex/polymarket.ts` imports
 * `convex/server`, `convex/values` and `@convex-dev/auth/server` because it
 * has to define actions. A client component importing ANY value from it —
 * even a string constant — therefore pulls the whole Convex SERVER runtime
 * into the browser bundle. Vite then tries to pre-bundle `convex/server` for
 * the client, that request goes to the dev server, and it hangs: the preview
 * dies on a 504 before React ever mounts. A blank page with a clean
 * `tsc`, a clean `vitest` and a clean `vite build`, because none of those
 * three execute the client bundle in a browser.
 *
 * `import type` was never enough on its own, and the rule going forward is
 * simple: anything under `src/convex/` is server-only. If the browser needs
 * it, it lives here, and the Convex file imports it from here.
 */

const GAMMA = "https://gamma-api.polymarket.com";

/**
 * Rounds this console runs, in minutes. Both are listed by Polymarket and both
 * were measured: 5m is the frequent one with a thin edge, 15m is the slower one
 * with a thicker edge that survives a 4c exit. They behave differently enough
 * to be worth separating rather than averaging.
 */
export const PM_INTERVALS = [5, 15] as const;
export type PmInterval = (typeof PM_INTERVALS)[number];

export const PM_ASSETS = ["btc", "eth"] as const;
export type PmAsset = (typeof PM_ASSETS)[number];

/** The limit each interval was measured at. 5m moved up to 0.50; 15m sat at 0.35. */
export const PM_LIMIT_OF: Record<PmInterval, number> = { 5: 0.5, 15: 0.35 };

/** A market we can rest a limit on: one asset at one interval. */
export type PmMarket = `${PmAsset}-${PmInterval}`;

/** Interval start of the round that contains `now`, in unix seconds. */
export function pmRoundStart(nowMs: number, interval: PmInterval = 5): number {
  return Math.floor(nowMs / 1000 / (interval * 60)) * (interval * 60);
}

export function pmSlug(asset: PmAsset, startSec: number, interval: PmInterval = 5): string {
  return `${asset}-updown-${interval}m-${startSec}`;
}

/** Polymarket's published outcome for a market slug, or null while unresolved. */
export async function settledUp(slug: string): Promise<boolean | null> {
  if (!slug) return null;
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
