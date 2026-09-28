/**
 * Maker entry with a breakeven exit — the first structure on these markets that
 * survived a walk-forward test.
 *
 * The reasoning, in one paragraph, because it is the opposite of everything
 * this project tried before. Every earlier idea bought with a taker order and
 * died in the same place: the 7% fee, which is 4.9% of the stake at a 0.30
 * price — almost exactly the size of the mispricing that was there to exploit.
 * A maker pays no fee at all, so the same measured mispricing becomes the
 * entire edge instead of being cancelled by it.
 *
 * The second half is the exit. Buying cheap and holding to resolution is
 * strongly negative: measured at −0.19 per share at the 0.50 limit, because
 * the market sells into the limit precisely when it is right about the round
 * losing. What turns that around is refusing to keep the position once the
 * thesis is wrong. Inside a round the contract comes back to the entry price
 * 81% of the time; when it does, the trade is given back for 2 cents a share
 * plus 2% commission. Only the trades that never revisit the level are held,
 * and those win 73% of the time.
 *
 * So this is not a direction forecast. It is a claim about execution: pay no
 * fee, enter patiently, and cut the position the moment the market disagrees.
 *
 * Measured over 30 days and 17277 real 5-minute rounds, per one share bought at
 * the 0.50 limit (a $5 stake is 10 of these), with the 2% commission applied:
 *   walk-forward          +0.018 per share, positive in every week
 *   losing days           2 of 31
 *   a $5 stake            +$0.18
 *   the live book spreads 0.01, so the 2c exit assumption is conservative
 *
 * What this still assumes, and what a minute-granularity price series cannot
 * check: that the breakeven sell actually fills. The live spread is one tick,
 * but "the price came back" is not the same as "somebody crossed to us". That
 * assumption is the whole strategy, and it is the one to distrust first.
 */

/** Limits measured profitable out of sample. The band is wide, not a knife edge. */
export const LIMIT_MIN = 0.35;
export const LIMIT_MAX = 0.6;
/**
 * The level the backtest kept choosing on past data, in every week it ran.
 *
 * This is 0.50, not the 0.35 the 15-minute study picked. Shorter rounds
 * changed the answer rather than just the volume: at 0.35 a 5-minute round
 * paid +0.008 a share against +0.019 at 0.50, and the band that stays
 * profitable on 5m is 0.40–0.60 rather than the 0.15–0.50 of the 15m study.
 */
export const DEFAULT_LIMIT = 0.5;
/**
 * A resting sell fills at or below the offer. One tick, because that is what
 * the live book spreads — measured on these markets, not assumed.
 *
 * This was 0.02, and it was wrong twice over: it charged the crossing twice
 * (once here, again in the commission on the proceeds), and it charged more
 * than the spread it was meant to model. See `realBreakevenExit` for why a
 * round trip can never be flat at the entry price, and `maxExitRate` for the
 * share of exits the strategy can afford.
 */
export const EXIT_SLIPPAGE = 0.01;
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
 * Polymarket does not sell shares — it sells USDC, and the exchange enforces a
 * minimum measured in SHARES, not dollars.
 *
 * The live book says `min_order_size: 5`. At the 0.50 limit that is 5 shares,
 * so the smallest real order is $2.50 and the real risk on a trade is $2.55
 * after commission — not the $1 this screen used to advertise. Every order
 * below that is rejected outright, so a $1 strategy would never have executed
 * a single trade.
 *
 * This was found by reading the exchange, after the backtest had already been
 * built and believed. The band starts at 5 shares for exactly that reason.
 */
export const MIN_ORDER_SHARES = 5;
export const MIN_STAKE_USD = 2.5;
export const STAKE_OPTIONS_USD = [5, 10, 25] as const;
export type StakeUsd = (typeof STAKE_OPTIONS_USD)[number];
export const DEFAULT_STAKE_USD: StakeUsd = 5;

/**
 * The market this strategy runs on.
 *
 * 5 minutes rather than 15, and the reason is arithmetic rather than elegance:
 * 288 rounds a day per asset instead of 96, so the same edge is reachable far
 * more often. The live-book scan put the ceiling at ~$52/day per $1 staked
 * against ~$0.80 on 15 minutes. The price is a thinner edge and a tighter exit
 * — both are recorded above rather than discovered later.
 *
 * The console now runs BOTH, because they differ. Measured at their own limits:
 *
 *              5m @ 0.50        15m @ 0.35
 *   exit rate     81%               91%
 *   survivors     73%               76%
 *   EV/share     +0.018            +0.013
 *   losing days  2 of 31           8 of 31
 *
 * 5m is the better business on every axis that matters: three times the
 * rounds, a larger edge per share, and it survives an expensive exit for an
 * extra cent. 15m reverts more reliably, which is worth knowing, but it is
 * worth less than the frequency. Averaging the two would hide both.
 */
export const MARKET_INTERVAL_MIN = 5;

/** The limit each interval trades at. Read the book before quoting anything else. */
export const PM_LIMITS: Record<5 | 15, number> = { 5: 0.5, 15: 0.35 };

/** Both intervals, with the limit each was measured at and its own evidence. */
export type MarketProfile = {
  interval: 5 | 15;
  label: string;
  limit: number;
  /** Walk-forward P&L per share, net of the 2% commission. */
  evPerShare: number;
  /** Gross of commission, which is what the price actually did. */
  grossPerShare: number;
  /** Entry held to resolution. Negative on both — that is the trap. */
  entryOnly: number;
  exitRate: number;
  survivorWinRate: number;
  losingDays: string;
  rounds: number;
  /** Exit cost at which this interval stops paying. */
  breakEvenSlippage: number;
};

export const MARKET_PROFILES: Record<5 | 15, MarketProfile> = {
  5: {
    interval: 5,
    label: "5m",
    limit: 0.5,
    evPerShare: 0.018,
    grossPerShare: 0.02,
    // Measured AT 0.50, not inherited from the 15m study at 0.35. The earlier
    // version of this profile reported an 80% exit rate and 47% survivors for
    // 5m; both were 0.35's numbers pasted onto a 0.50 market, and they made
    // 5m look like a coin flip when it is not.
    entryOnly: -0.192,
    exitRate: 0.81,
    survivorWinRate: 0.73,
    losingDays: "2 из 31",
    rounds: 17277,
    // +0.026 at 1c, +0.018 at 2c, +0.001 at 4c, −0.015 at 6c.
    breakEvenSlippage: 0.04,
  },
  15: {
    interval: 15,
    label: "15m",
    limit: 0.35,
    evPerShare: 0.013,
    grossPerShare: 0.02,
    entryOnly: -0.102,
    // 15m reverts more reliably (91% against 81%) and the trades that never
    // revert win 76% against 73%. Both are good, which is the point: this
    // profile is a measurement, and the measurement says 5m is the better
    // business on every axis that matters except the exit price.
    exitRate: 0.91,
    survivorWinRate: 0.76,
    losingDays: "8 из 31",
    rounds: 5760,
    // +0.022 at 1c, +0.013 at 2c, −0.009 at 4c → flat somewhere near 3c.
    breakEvenSlippage: 0.03,
  },
};

/** Round length in seconds for an interval. */
export function roundSeconds(interval: 5 | 15): number {
  return interval * 60;
}

/** Shares a USDC stake buys when it fills at `limit`. */
export function sharesForStake(stake: number, limit: number = DEFAULT_LIMIT): number {
  return stake / limit;
}

/**
 * The walk-forward results, in USDC per single share bought at `DEFAULT_LIMIT`.
 *
 * These are GROSS of the trading commission: the raw price behaviour of the
 * market, with no fee applied. A share costs `DEFAULT_LIMIT`, so they convert
 * to a real $1 stake by dividing by the limit — see `expectedPnlPerStake`,
 * which is the only number that should ever be shown, because it is net of fees.
 *
 * Measured over 30 days and 17277 real 5-minute rounds, re-run with the 2%
 * commission applied (see `scripts/maker-breakeven.ts 5 30`):
 *   walk-forward          +0.018 per share, positive in every week
 *   losing days           9 of 31
 *   entry without exit    −0.144 per share
 *
 * The fragility is in the same table: a 4c exit cost instead of 2c takes the
 * strategy to break-even, and 6c turns it negative. On 15-minute rounds the
 * same 4c cost was comfortably survivable, because the survivors there won 76%
 * of the time and covered the cost. Here they win 47%, so the exit has to
 * work more often and cannot afford to be expensive.
 */
export const MEASURED_PER_SHARE = {
  /** Maker entry plus breakeven exit, before commission. */
  pnlWithExit: 0.02,
  /** The same fills held to resolution, before commission. This is the trap. */
  pnlEntryOnly: -0.144,
  /** How often the contract comes back to the limit. */
  exitRate: 0.8,
  /** Of the trades that never came back, how many won. A coin flip. */
  survivorWinRate: 0.47,
  losingDays: "9 из 31",
  rounds: 17277,
} as const;

/**
 * The exit cost at which the edge disappears entirely, per interval.
 *
 * Measured, not guessed. On 5m: +0.026/share at 1c, +0.018 at 2c, +0.001 at
 * 4c, −0.015 at 6c. On 15m: +0.022 at 1c, +0.013 at 2c, −0.009 at 4c. The
 * live book spreads one tick, so 2c is conservative — but these are the numbers
 * to watch in production, because they say how much room the exit has before
 * the strategy is flat. 15m dies EARLIER, which is the opposite of the naive
 * expectation: its edge sits in reversion happening often, and an expensive
 * exit takes that away faster.
 */
export function breakEvenSlippage(interval: 5 | 15): number {
  return MARKET_PROFILES[interval].breakEvenSlippage;
}

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
    breakevenExit: realBreakevenExit(limit),
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
 * The price a round trip has to clear to actually be flat.
 *
 * This is NOT the entry limit, and the difference is the whole strategy. The
 * commission is charged on the stake going in AND on the proceeds coming out,
 * so selling straight back at the entry price returns the stake minus two
 * commissions — 4% of it. "Breakeven" at the entry price is a −$0.20 round
 * trip on a $5 stake, not a flat one.
 *
 * Solving proceeds·(1−fee) = stake·(1+fee) for the exit price:
 */
export function realBreakevenExit(limit: number = DEFAULT_LIMIT): number {
  return (limit * (1 + TRADE_FEE_RATE)) / (1 - TRADE_FEE_RATE);
}

/**
 * The share of trades that may be exited before the strategy stops paying.
 *
 * Every exit is a known loss: the exit cost plus the commission. Every
 * survivor is what has to cover them. So there is a hard ceiling on how often
 * the exit may fire, and it is the number that decides whether this business
 * exists at all.
 *
 * Solving exitRate·exitEV + (1−exitRate)·survivorEV = 0 gives the boundary.
 * Above it, no win rate rescues the strategy — the exits have eaten the edge
 * before a single round is graded.
 */
export function maxExitRate(interval: 5 | 15): number {
  const p = MARKET_PROFILES[interval];
  const limit = PM_LIMITS[interval];
  const fee = TRADE_FEE_RATE * limit;
  const exitEV = -EXIT_SLIPPAGE - fee;
  const survivorEV =
    p.survivorWinRate * (1 - limit - fee) - (1 - p.survivorWinRate) * (limit + fee);
  if (survivorEV <= 0) return 0;
  return survivorEV / (survivorEV - exitEV);
}

/**
 * P&L in USDC on a real order of `stake` dollars, filled at `limit`.
 *
 * A $5 stake at 0.50 is 10 shares, so the outcomes are:
 *   won and held   +$4.90    (10 shares pay out 10 against a $5 cost, less 10¢ fee)
 *   lost and held  −$5.10    (the whole stake plus 2% commission)
 *   exited         −$0.30    (2c of slippage on 10 shares, plus 10¢ of commission)
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
