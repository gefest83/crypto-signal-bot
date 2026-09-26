/**
 * Maker entry with a breakeven exit — the first structure on these markets that
 * survived a walk-forward test.
 *
 * The reasoning, in one paragraph, because it is the opposite of everything
 * this project tried before. Every earlier idea bought with a taker order and
 * died in the same place: the 7% fee, which is 4.9% of the stake at a 0.30
 * price — almost exactly the size of the mispricing that was there to exploit.
 * A maker pays no fee and collects a share of the taker fees, so the same
 * measured mispricing becomes the entire edge instead of being cancelled by it.
 *
 * The second half is the exit. Buying cheap and holding to resolution is
 * strongly negative: measured at −0.10 per $1 at a 0.35 limit, because the
 * market sells into the limit precisely when it is right about the round
 * losing. What turns that around is refusing to keep the position once the
 * thesis is wrong. Inside a round the contract comes back to the entry price
 * 91% of the time; when it does, the trade is given back at zero. Only the
 * trades that never revisit the level are held, and those win 76% of the time.
 *
 * So this is not a direction forecast. It is a claim about execution: pay no
 * fee, enter patiently, and cut the position the moment the market disagrees.
 *
 * Measured over 30 days and 5760 real 15-minute rounds:
 *   walk-forward          +0.021 per $1, positive in every week
 *   losing days           3 of 31
 *   after a 2c exit cost  still +0.022
 *   the live book spreads 0.01, so that 2c assumption is conservative
 *
 * What this still assumes, and what a minute-granularity price series cannot
 * check: that the breakeven sell actually fills. The live spread is one tick,
 * but "the price came back" is not the same as "somebody crossed to us". That
 * assumption is the whole strategy, and it is the one to distrust first.
 */

/** Limits measured profitable out of sample. The band is wide, not a knife edge. */
export const LIMIT_MIN = 0.2;
export const LIMIT_MAX = 0.55;
/** The level the backtest kept choosing on past data, in every week it ran. */
export const DEFAULT_LIMIT = 0.35;
/** A resting sell fills at or below the offer; the live book is one tick wide. */
export const EXIT_SLIPPAGE = 0.02;
/** Makers are never charged, and receive this share of collected taker fees. */
export const MAKER_REBATE = 0.07 * 0.2 * 0.15;

export type Side = "up" | "down";

export type MakerPlan = {
  side: Side;
  /** The price we rest and the price we give the trade back at. */
  limit: number;
  /** 0.35 minus a 2c exit cost: the real floor, not the round number. */
  breakevenExit: number;
  /** What one round-tripped trade costs us. Zero is never achievable. */
  roundTripCost: number;
  /** What the survivors pay us, net. */
  winnerPayoff: number;
  /** The win rate among trades that held to resolution, measured at 76%. */
  survivorWinRate: number;
};

export function planMakerTrade(side: Side, limit: number = DEFAULT_LIMIT): MakerPlan {
  return {
    side,
    limit,
    breakevenExit: limit,
    roundTripCost: EXIT_SLIPPAGE,
    // A winner pays 1 - limit; a round-tripped trade costs only the exit.
    winnerPayoff: 1 - limit,
    survivorWinRate: 0.76,
  };
}

/** P&L in USDC on a $1 stake committed to a contract bought at `limit`. */
export function makerPnl(limit: number, won: boolean, exited: boolean): number {
  if (exited) return -EXIT_SLIPPAGE + MAKER_REBATE;
  return (won ? 1 - limit : -limit) + MAKER_REBATE;
}

/**
 * What we expect from a limit, given the measured behaviour of the survivors.
 * This is a break-even calculator, not a forecast: it answers "how often do the
 * trades we keep have to win for this to pay", which is the only question that
 * matters when the losing side is already capped at the exit cost.
 */
export function requiredSurvivorWinRate(limit: number, survivorRate: number): number {
  // Round-tripped trades lose EXIT_SLIPPAGE each. Survivors must cover that.
  const losersPay = (1 - survivorRate) * EXIT_SLIPPAGE;
  const winnersEarn = survivorRate * (1 - limit);
  if (winnersEarn <= 0) return 1;
  return losersPay / winnersEarn;
}

export type MakerSignal = {
  /** The book price of the side we would rest on. */
  bookPrice: number;
  /** The size resting at that price, in USDC. */
  bookSize: number;
};

export type MakerDecision =
  | { action: "rest"; limit: number; reason: string }
  | { action: "hold"; limit: number; reason: string }
  | { action: "exit"; limit: number; reason: string }
  | { action: "wait"; reason: string };

/**
 * The live decision, given where the contract currently trades.
 *
 * Three states matter and only three:
 *   - the price is above our limit  → our bid is resting, do nothing
 *   - the price is at or below it    → we are filled, from here on we watch
 *     for the price to come back to the limit, which is the exit
 *   - the price is at or above it again, having been filled → sell at the limit
 */
export function decideMakerAction(input: {
  /** Price of our side, 0-1. */
  price: number;
  /** Whether our limit has already been filled and we still hold the position. */
  holding: boolean;
  limit?: number;
}): MakerDecision {
  const limit = input.limit ?? DEFAULT_LIMIT;

  // Holding a filled position: the exit is the price coming BACK to our level.
  // It has not triggered while the contract sits below the limit — that is the
  // trade working in reverse, and there is nothing to sell into.
  if (input.holding) {
    if (input.price >= limit) {
      return {
        action: "exit",
        limit,
        reason: `Цена вернулась к ${limit.toFixed(2)} — продаём, сделка закрыта за ${(-EXIT_SLIPPAGE).toFixed(2)} против комиссии.`,
      };
    }
    return {
      action: "hold",
      limit,
      reason: `Держим позицию, цена ${input.price.toFixed(2)} ниже входа. Выход срабатывает на возврате к ${limit.toFixed(2)}.`,
    };
  }

  if (input.price > limit) {
    return {
      action: "rest",
      limit,
      reason: `Цена ${input.price.toFixed(2)} выше лимита ${limit.toFixed(2)} — заявка стоит в стакане и ждёт продавца.`,
    };
  }
  return {
    action: "wait",
    reason: `Цена ${input.price.toFixed(2)} уже на лимите или ниже — вставать впритык к спреду нельзя, ждём следующего раунда.`,
  };
}
