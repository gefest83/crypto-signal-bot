/**
 * Paper execution — a maker order that is booked, queued and filled against
 * the real order book without a single dollar changing hands.
 *
 * Why this exists
 * ---------------
 * The whole strategy rests on one claim that no amount of historical data can
 * check: that a resting bid at 0.50 actually gets filled when the price comes
 * down to it. The walk-forward used a minute-granularity mid, which proves the
 * price reached 0.50 and says nothing at all about whether anyone sold into
 * the bid. That is not a small gap — it is the entire edge.
 *
 * The live console that came before this file watched the same book and
 * declared a fill the moment the ask touched the limit. That is the generous
 * reading, and it is almost certainly wrong in a specific and expensive way:
 *
 *   THE QUEUE PROBLEM. When the price falls, resting bids are HIT, not lifted.
 *   If we were last in the queue at 0.50, every seller before us took the fill
 *   and we watched it happen. Assuming the fill is fine; assuming the fill
 *   requires being first in the queue, which we usually are not.
 *
 * So this file is deliberately pessimistic, and pessimism is the point:
 *
 *   - A fill requires the price to CROSS our level, not touch it. Ticks are
 *     0.01 on these markets, so we require one tick of penetration.
 *   - A resting order loses its queue position the moment it is stale, so a
 *     quote only counts if the level is still being quoted.
 *   - The exit must clear the same way. Claiming a breakeven exit at the
 *     instant the bid returns is how the backtest invented its own profits.
 *
 * Every one of these choices can only make the result WORSE, never better.
 * If the strategy survives them, it survives for real.
 */

/** Ticks on Polymarket's Up/Down books. Read from the book, not assumed. */
export const DEFAULT_TICK = 0.01;

/** What a paper trader is allowed to do, and what it is forbidden to assume. */
export type PaperSettings = {
  /**
   * Ticks the price must penetrate past our limit before we count a fill.
   *
   * Zero means "assume we are first in the queue", which is exactly the
   * assumption the historical study could not test. One tick is the honest
   * floor: a seller who hits 0.49 never touched the 0.50 bid queue at all, but
   * a seller who hits 0.48 certainly did.
   */
  penetrationTicks: number;
  /**
   * A quote older than this is treated as stale and cancelled. A limit that
   * has been resting for minutes in a moving market is not providing the
   * liquidity it claims to be.
   */
  maxQuoteAgeMs: number;
  /**
   * Whether a fill is credited when the level is crossed, or only when there
   * is also resting size at our own level. The second is stricter: if nothing
   * is queued at the limit, then nothing was ahead of us either, and we were
   * almost certainly first.
   */
  requireRestingSize: boolean;
};

export const DEFAULT_PAPER: PaperSettings = {
  penetrationTicks: 1,
  maxQuoteAgeMs: 90_000,
  requireRestingSize: false,
};

export type PaperSide = "buy" | "sell";

export type PaperOrder = {
  id: string;
  side: PaperSide;
  /** Price we quote. */
  price: number;
  /** USDC committed. */
  stake: number;
  placedAt: number;
  /** One of these ends the order. */
  status: "live" | "filled" | "cancelled" | "expired";
  filledAt: number | null;
  /** The price we actually got, which is never better than our limit. */
  fillPrice: number | null;
  /** Why it ended, in words, for the journal. */
  reason: string;
};

export type PaperPosition = {
  orderId: string;
  side: PaperSide;
  entryPrice: number;
  stake: number;
  shares: number;
  openedAt: number;
  /** The exit we would have quoted. */
  exitPrice: number;
  status: "open" | "closed" | "held_to_resolution";
  closedAt: number | null;
  exitPriceFilled: number | null;
  /** Realised P&L in USDC, including the 2% commission. */
  pnl: number | null;
  reason: string;
};

export type BookSnapshot = {
  /** Best bid on our side. */
  bid: number | null;
  /** Best ask on our side. */
  ask: number | null;
  /** USDC resting at exactly our limit. */
  depthAtLimit: number;
  now: number;
};

export type FillCheck =
  | { filled: false; reason: string }
  | { filled: true; fillPrice: number; reason: string };

/**
 * Does a resting bid at `limit` get hit by this book?
 *
 * The rule is penetration, not contact. Our order sits in the queue at
 * `limit`; a seller only takes it by trading at or below that level, and a
 * trade one tick under the limit is what an actual queue clearance looks like.
 * The moment the price merely TOUCHES the limit we have learned nothing, which
 * is the mistake the earlier console made and the reason its numbers could not
 * be trusted.
 */
export function checkBuyFill(
  limit: number,
  book: BookSnapshot,
  settings: PaperSettings = DEFAULT_PAPER,
  tick: number = DEFAULT_TICK,
): FillCheck {
  if (book.ask === null) {
    return { filled: false, reason: "нет котировки ask" };
  }
  if (settings.requireRestingSize && book.depthAtLimit <= 0) {
    return { filled: false, reason: "на нашем уровне никто не стоит" };
  }
  const penetrated = book.ask <= limit - settings.penetrationTicks * tick + 1e-9;
  if (!penetrated) {
    return {
      filled: false,
      reason: `ask ${book.ask.toFixed(2)} не пробивает лимит ${limit.toFixed(2)} на ${
        settings.penetrationTicks
      } тик`,
    };
  }
  // We are filled at our limit, never at the worse price that crossed us.
  return {
    filled: true,
    fillPrice: limit,
    reason: `ask дошёл до ${book.ask.toFixed(2)} — прошит лимит ${limit.toFixed(2)}`,
  };
}

/**
 * Does a resting sell at `limit` get lifted by this book?
 *
 * The mirror of the entry, and it matters just as much. The backtest's entire
 * profit came from exiting at breakeven, and it assumed the exit filled
 * whenever the bid came back to the entry price. Requiring penetration here
 * too is what turns that assumption into a number.
 */
export function checkSellFill(
  limit: number,
  book: BookSnapshot,
  settings: PaperSettings = DEFAULT_PAPER,
  tick: number = DEFAULT_TICK,
): FillCheck {
  if (book.bid === null) {
    return { filled: false, reason: "нет котировки bid" };
  }
  const penetrated = book.bid >= limit + settings.penetrationTicks * tick - 1e-9;
  if (!penetrated) {
    return {
      filled: false,
      reason: `bid ${book.bid.toFixed(2)} не пробивает выход ${limit.toFixed(2)} на ${
        settings.penetrationTicks
      } тик`,
    };
  }
  return {
    filled: true,
    fillPrice: limit,
    reason: `bid дошёл до ${book.bid.toFixed(2)} — прошит выход ${limit.toFixed(2)}`,
  };
}

/** A quote that has been resting too long is a liability, not an opportunity. */
export function isQuoteStale(placedAt: number, now: number, settings = DEFAULT_PAPER): boolean {
  return now - placedAt > settings.maxQuoteAgeMs;
}

/**
 * Open a paper position at the limit that was actually filled.
 *
 * The commission is charged here, once, exactly as the exchange charges it: a
 * flat 2% of the committed USDC, taken on entry and again on exit. Charging it
 * only on a loss, or only on a win, is the sort of small accounting kindness
 * that turns a losing strategy into a winning screenshot.
 */
export function openPosition(
  order: PaperOrder,
  stake: number,
  feeRate: number,
): PaperPosition | null {
  if (order.status !== "filled" || order.fillPrice === null) return null;
  const price = order.fillPrice;
  return {
    orderId: order.id,
    side: "buy",
    entryPrice: price,
    stake,
    shares: stake / price,
    openedAt: order.filledAt ?? order.placedAt,
    // The exit we can actually profit from, net of the fee we will pay on it.
    exitPrice: price,
    status: "open",
    closedAt: null,
    exitPriceFilled: null,
    pnl: null,
    reason: "",
  };
}

/** Close a position by selling shares back, paying the commission again. */
export function closePosition(
  position: PaperPosition,
  fillPrice: number,
  now: number,
  feeRate: number,
): PaperPosition {
  const proceeds = position.shares * fillPrice;
  const fees = position.stake * feeRate + proceeds * feeRate;
  return {
    ...position,
    status: "closed",
    closedAt: now,
    exitPriceFilled: fillPrice,
    pnl: proceeds - position.stake - fees,
    reason: `выход по ${fillPrice.toFixed(2)} против входа ${position.entryPrice.toFixed(2)}`,
  };
}

/** Settle a position the round resolved on, graded on the real outcome. */
export function settlePosition(
  position: PaperPosition,
  won: boolean,
  now: number,
  feeRate: number,
): PaperPosition {
  const proceeds = won ? position.shares : 0;
  const fees = position.stake * feeRate;
  return {
    ...position,
    status: "held_to_resolution",
    closedAt: now,
    exitPriceFilled: null,
    pnl: proceeds - position.stake - fees,
    reason: won
      ? `до расчёта, шара заплатила $1 — удержали победную`
      : `до расчёта, удержали проигрышную`,
  };
}

/** Realised P&L on a whole paper session, in USDC. */
export function sessionPnl(positions: PaperPosition[]): {
  realised: number;
  closed: number;
  held: number;
  wins: number;
  losses: number;
} {
  const done = positions.filter((p) => p.pnl !== null);
  return {
    realised: done.reduce((sum, p) => sum + (p.pnl ?? 0), 0),
    closed: done.filter((p) => p.status === "closed").length,
    held: done.filter((p) => p.status === "held_to_resolution").length,
    wins: done.filter((p) => (p.pnl ?? 0) > 0).length,
    losses: done.filter((p) => (p.pnl ?? 0) < 0).length,
  };
}
