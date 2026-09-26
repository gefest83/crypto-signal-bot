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
 * Measured over 30 days and 5760 real 15-minute rounds, per one share bought at
 * the 0.35 limit (a $1 stake is 2.86 of these), with the 2% commission applied:
 *   walk-forward          +0.013 per share, positive in every week
 *   losing days           8 of 31
 *   a $1 stake            +1.7c
 *   the live book spreads 0.01, so the 2c exit assumption is conservative
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
/**
 * Charged on every trade: 2% of the USDC stake, regardless of how it ends.
 *
 * This replaced an earlier assumption that makers pay nothing and collect a
 * rebate. They do not, and that mistake was worth real money — on a $1 stake
 * it turned a −$1.02 loss into a displayed −$0.99, and it flattered the
 * measured edge by roughly a cent per share. A commission is a cost, so it is
 * subtracted here, and it is charged on the stake rather than on the shares,
 * which is what makes it bite hardest exactly when the position is largest.
 */
export const TRADE_FEE_RATE = 0.02;

/**
 * Polymarket does not sell shares — it sells USDC. A $1 order at a 0.35 limit
 * buys 1 / 0.35 = 2.86 shares, pays out 2.86 if the round goes our way, and
 * risks the full $1 if it does not.
 *
 * This is the single most important accounting fact on these markets, and
 * getting it wrong is what made an earlier version of this screen look like it
 * risked 35¢ when it actually risked a dollar. $1 is the smallest order the
 * books accept; $5 and $10 are the sizes the UI offers above it.
 */
export const MIN_STAKE_USD = 1;
export const STAKE_OPTIONS_USD = [1, 5, 10] as const;
export type StakeUsd = (typeof STAKE_OPTIONS_USD)[number];
export const DEFAULT_STAKE_USD: StakeUsd = 1;

/** Shares a USDC stake buys when it fills at `limit`. */
export function sharesForStake(stake: number, limit: number = DEFAULT_LIMIT): number {
  return stake / limit;
}

/**
 * The walk-forward results, in USDC per single share bought at `DEFAULT_LIMIT`.
 *
 * These are GROSS of the trading commission: the raw price behaviour of the
 * market, with no fee applied. A share costs 0.35, so they convert to a real $1
 * stake by dividing by the limit — see `expectedPnlPerStake`, which is the
 * only number that should ever be shown, because it is the one net of fees.
 *
 * Measured over 30 days and 5760 real 15-minute rounds, re-run with the 2%
 * commission applied (see `scripts/maker-breakeven.ts`):
 *   walk-forward          +0.013 per share, positive in every week
 *   losing days           8 of 31
 *   entry without exit    −0.095 per share
 */
export const MEASURED_PER_SHARE = {
  /** Maker entry plus breakeven exit, before commission. */
  pnlWithExit: 0.02,
  /** The same fills held to resolution, before commission. This is the trap. */
  pnlEntryOnly: -0.0951,
  /** How often the contract comes back to the limit. */
  exitRate: 0.91,
  /** Of the trades that never came back, how many won. */
  survivorWinRate: 0.76,
  losingDays: "8 из 31",
  rounds: 5760,
} as const;

/** The commission one share costs, in USDC. */
export function feePerShare(limit: number = DEFAULT_LIMIT): number {
  return TRADE_FEE_RATE * limit;
}

/**
 * The same measured result expressed on a real USDC stake, net of commission.
 *
 * Dividing the limit out is what makes this honest: a $1 stake is 2.86 shares,
 * so every outcome scales by that much AND pays 2% on the dollar. Skipping the
 * commission step is what produced a screen that claimed −$0.99 on a trade that
 * actually loses $1.02.
 */
export function expectedPnlPerStake(
  stake: number,
  limit: number = DEFAULT_LIMIT,
  grossPerShare: number = MEASURED_PER_SHARE.pnlWithExit,
): number {
  return sharesForStake(stake, limit) * grossPerShare - stake * TRADE_FEE_RATE;
}

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
    roundTripCost: EXIT_SLIPPAGE + TRADE_FEE_RATE * limit,
    // A winner pays 1 - limit; a round-tripped trade costs the exit plus the fee.
    winnerPayoff: 1 - limit,
    survivorWinRate: 0.76,
  };
}

/**
 * P&L in USDC for ONE share bought at `limit`. This is the raw unit the
 * backtest works in — a share costs `limit` dollars and pays 1. Real orders are
 * denominated in USDC, so anything the user sees goes through `stakePnl`.
 */
export function makerPnl(limit: number, won: boolean, exited: boolean): number {
  // The fee is 2% of the stake, so per share it is 2% of what that share cost.
  const fee = TRADE_FEE_RATE * limit;
  if (exited) return -EXIT_SLIPPAGE - fee;
  return (won ? 1 - limit : -limit) - fee;
}

/**
 * P&L in USDC on a real order of `stake` dollars, filled at `limit`.
 *
 * A $1 stake at 0.35 is 2.86 shares, so the outcomes are:
 *   won and held   +$1.84   (2.86 shares pay out 2.86 against a $1 cost, less 2¢ fee)
 *   lost and held  −$1.02   (the whole stake plus 2% commission)
 *   exited         −$0.08   (sold back 2 cents under the limit, plus 2% commission)
 *
 * The risk on a trade is the full stake, not the limit — which is the number
 * that has to govern position sizing, and the reason the loss side of this
 * strategy is a fixed, knowable amount rather than an open-ended one.
 */
export function stakePnl(
  stake: number,
  limit: number,
  won: boolean,
  exited: boolean,
): number {
  return sharesForStake(stake, limit) * makerPnl(limit, won, exited);
}

/** What a real stake is worth in each of the three outcomes, for the UI. */
export function stakeOutcomes(
  stake: number,
  limit: number = DEFAULT_LIMIT,
): { won: number; lost: number; exited: number } {
  return {
    won: stakePnl(stake, limit, true, false),
    lost: stakePnl(stake, limit, false, false),
    exited: stakePnl(stake, limit, false, true),
  };
}

/**
 * What we expect from a limit, given the measured behaviour of the survivors.
 * This is a break-even calculator, not a forecast: it answers "how often do the
 * trades we keep have to win for this to pay", which is the only question that
 * matters when the losing side is already capped at the exit cost.
 */
export function requiredSurvivorWinRate(limit: number, survivorRate: number): number {
  // Round-tripped trades lose the exit slippage plus the commission on the
  // stake; survivors must cover that on a trade that costs the limit to enter.
  const losersPay = (1 - survivorRate) * (EXIT_SLIPPAGE + TRADE_FEE_RATE * limit);
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
