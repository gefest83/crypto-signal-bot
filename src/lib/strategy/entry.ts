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
/** The round's first quarter must have passed before we look at the book. */
export const ENTRY_START_MS = 180_000;
/** Past this point the contract is a lottery, whatever the direction says. */
export const ENTRY_END_MS = 540_000;
/** Longest answer Polymarket takes before the next round replaces the market. */
export const ROUND_MS = 15 * 60_000;

/**
 * Polymarket taker fee rate for the crypto category.
 *
 * Their formula is `fee = shares × rate × p × (1 − p)`. With a $1 stake
 * (shares = 1 / p) that collapses to `fee = rate × (1 − p)` of the stake:
 * 1.40% at p = 0.80, 0.98% at p = 0.86, 0.35% at p = 0.95.
 *
 * This is why the whole edge only exists for makers: paying 0.98% of the stake
 * to cross a 1-cent spread would leave roughly +0.5% instead of +1.9%.
 */
export const TAKER_FEE_RATE = 0.07;
/** Makers are never charged, and receive this share of collected taker fees. */
export const MAKER_REBATE_SHARE = 0.2;
/** Price grid on these markets. */
export const PRICE_TICK = 0.01;

export type Execution = "maker" | "taker";

/** Taker fee in USDC for a $1 stake committed at `price`. */
export function takerFee(price: number): number {
  if (price <= 0 || price >= 1) return 0;
  return TAKER_FEE_RATE * (1 - price);
}

/**
 * The price to rest a maker order at: the midpoint, rounded down to the tick
 * so it never crosses the offer, and never below the current bid.
 */
export function limitPriceFor(bid: number | null, ask: number | null): number | null {
  if (bid === null || ask === null || ask <= bid) return null;
  const mid = (bid + ask) / 2;
  const price = Math.max(bid, Math.floor(mid / PRICE_TICK) * PRICE_TICK);
  return Math.round(price * 100) / 100;
}

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
  /** Where a maker order would rest: mid of the book, never crossing. */
  limitPrice: number | null;
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
  /**
   * Whether the quote came from the live order book. Polymarket's event
   * snapshot trails the real book by cents, so a call priced off a stale quote
   * would advertise an entry nobody can fill — those rounds are skipped.
   */
  tradable?: boolean;
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
  tradable = true,
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
    limitPrice: null as number | null,
    favouriteAsk: null as number | null,
    eligible: false,
    checkedAt: now,
  };

  if (elapsed < ENTRY_START_MS) {
    return {
      ...base,
      direction: "stand-aside",
      reason: `Ждём первые ${ENTRY_START_MS / 1000} секунд раунда — раньше в стакане только тики.`,
    };
  }
  if (elapsed >= ENTRY_END_MS) {
    return {
      ...base,
      direction: "stand-aside",
      reason: "Окно входа закрыто — контракт уже переоценён.",
    };
  }

  if (!tradable) {
    return {
      ...base,
      direction: "stand-aside",
      reason:
        "Стакан пуст — котировка Polymarket отстала от него на центы. Вход не публикуем: цена должна быть торгуемой.",
    };
  }

  // The favourite is whichever side the market is paying more for.
  const upFavourite = upAsk !== null && (downAsk === null || upAsk >= downAsk);
  const favourite: Side = upFavourite ? "up" : "down";
  const favouriteAsk = upFavourite ? upAsk : downAsk;
  const ask = favouriteAsk;
  const bid = upFavourite ? upBid : downBid;
  const limitPrice = limitPriceFor(bid, ask);

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
      limitPrice,
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
      limitPrice,
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
    limitPrice,
    favouriteAsk,
    direction: favourite,
    eligible: true,
    reason: `Фаворит ${favourite.toUpperCase()} по ${ask!.toFixed(2)} — рынок недооценивает решённые раунды, здесь и живёт перевес. Вход лимитом: тейкерская комиссия 7%×(1−цена) его бы уничтожила.`,
  };
}

/**
 * Net P&L of a $1 stake at `price`, given the real outcome.
 *
 * `maker` rests a limit order: no fee, and the price is the one we chose.
 * `taker` crosses the spread and also pays Polymarket's crypto taker fee, which
 * is charged whether the trade wins or loses.
 *
 * Kept next to the rule so the journal and the UI can never disagree.
 */
export function pnlForEntry(
  price: number,
  won: boolean,
  execution: Execution = "maker",
): number {
  if (price <= 0) return 0;
  const fee = execution === "taker" ? takerFee(price) : 0;
  return (won ? 1 / price - 1 : -1) - fee;
}
