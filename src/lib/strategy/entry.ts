/**
 * The entry rule.
 *
 * Predicting the direction was never the problem — the old engine hit 75.5% on
 * real Polymarket rounds while the contract cost 0.745, which is exactly
 * break-even. Replaying 15 days of real prices (8 631 rounds) showed where the
 * money actually is:
 *
 *   buy the side Polymarket prices >= 0.80   n=1682  hit 87.9%  cost 0.860
 *                                            EV +1.9% (se 0.8%), ~2.4 sigma
 *   the same, with the old engine agreeing   n=344   hit 89.5%  cost 0.865
 *                                            EV +3.0%
 *
 * That is the classic favorite/longshot bias: near-settled rounds are
 * underpriced, longshots are overpriced. So the bot no longer asks "which way
 * is it going?" — it asks "is the side the market already favours cheap enough
 * to beat its own price?".
 *
 * Every price here is the real Polymarket ask. Nothing in this module invents a
 * price, so the journal it feeds is honest by construction.
 */

import type { Direction } from "./engine";

/**
 * Minimum real ask on the favoured side before an entry is considered.
 *
 * The measured bias is a gradient, not a cliff: EV rose from +0.8% at >= 0.60
 * to +1.9% at >= 0.80 and then flattened. 0.80 is where the curve stops
 * paying for the risk it takes on.
 */
export const FAVORITE_MIN_ASK = 0.8;
/** The round's first minute must have closed before we may look at the book. */
export const ENTRY_START_MS = 60_000;
/** Past this point the contract is a lottery, whatever the direction says. */
export const ENTRY_END_MS = 150_000;
/** Longest answer Polymarket takes before the next round replaces the market. */
export const ROUND_MS = 5 * 60_000;

export type Side = "up" | "down";

export type EntryReadout = {
  /** Interval start of the round, unix milliseconds. */
  start: number;
  end: number;
  /** What the bot would do right now. */
  direction: Direction;
  /** Which side the market favours, independent of whether we enter. */
  favourite: Side | null;
  /** Real Polymarket ask on the side we would buy. */
  ask: number | null;
  /** Real Polymarket bid on that same side. */
  bid: number | null;
  /** Real ask on the favoured side, even when we decline to buy it. */
  favouriteAsk: number | null;
  /** True only when a trade is actually publishable. */
  eligible: boolean;
  checkedAt: number;
  reason: string;
};

type EvaluateInput = {
  start: number;
  now: number;
  upAsk: number | null;
  upBid: number | null;
  downAsk: number | null;
  downBid: number | null;
  /**
   * Direction from the independent Binance candle engine, or null when it has
   * no opinion. When it disagrees with the favourite we stand aside: two
   * independent reads pointing opposite ways is the one case worth skipping.
   */
  confirm?: Direction | null;
  /** Skip the confirmation requirement (used for the unbiased baseline). */
  requireConfirmation?: boolean;
};

export function evaluateEntry({
  start,
  now,
  upAsk,
  upBid,
  downAsk,
  downBid,
  confirm = null,
  requireConfirmation = true,
}: EvaluateInput): EntryReadout {
  const end = start + ROUND_MS;
  const elapsed = now - start;

  const base = {
    start,
    end,
    favourite: null as Side | null,
    ask: null as number | null,
    bid: null as number | null,
    favouriteAsk: null as number | null,
    eligible: false,
    checkedAt: now,
  };

  if (elapsed < ENTRY_START_MS) {
    return {
      ...base,
      direction: "stand-aside",
      reason: `Ждём закрытия первой минуты — до ${ENTRY_START_MS / 1000}-й секунды в стакане только тики.`,
    };
  }
  if (elapsed >= ENTRY_END_MS) {
    return {
      ...base,
      direction: "stand-aside",
      reason: "Окно входа закрыто — контракт уже переоценён.",
    };
  }

  // The favourite is whichever side the market is paying more for.
  const upFavourite = upAsk !== null && (downAsk === null || upAsk >= downAsk);
  const favourite: Side = upFavourite ? "up" : "down";
  const favouriteAsk = upFavourite ? upAsk : downAsk;
  const ask = favouriteAsk;
  const bid = upFavourite ? upBid : downBid;

  if (favouriteAsk === null) {
    return {
      ...base,
      direction: "stand-aside",
      reason: "Нет котировок от Polymarket — ждём стакан.",
    };
  }

  if (favouriteAsk < FAVORITE_MIN_ASK) {
    return {
      ...base,
      favourite,
      ask,
      bid,
      favouriteAsk,
      direction: "stand-aside",
      reason: `Рынок не выделил фаворита (${favouriteAsk.toFixed(2)} < ${FAVORITE_MIN_ASK.toFixed(2)}) — покупать нечего.`,
    };
  }

  if (
    requireConfirmation &&
    confirm !== null &&
    confirm !== "stand-aside" &&
    confirm !== favourite
  ) {
    return {
      ...base,
      favourite,
      ask,
      bid,
      favouriteAsk,
      direction: "stand-aside",
      reason: `Рынок за ${favourite.toUpperCase()} на ${favouriteAsk.toFixed(2)}, а свечной движок — ${confirm.toUpperCase()}. Расхождение, пропускаем.`,
    };
  }

  return {
    ...base,
    favourite,
    ask,
    bid,
    favouriteAsk,
    direction: favourite,
    eligible: true,
    reason: `Фаворит ${favourite.toUpperCase()} по ${ask!.toFixed(2)} — рынок недооценивает решённые раунды, здесь и живёт перевес.`,
  };
}

/**
 * Net P&L of a $1 stake bought at `ask`, given the real outcome.
 * Kept next to the rule so the journal and the UI can never disagree.
 */
export function pnlForEntry(ask: number, won: boolean): number {
  if (!won) return -1;
  return ask > 0 ? 1 / ask - 1 : 0;
}
