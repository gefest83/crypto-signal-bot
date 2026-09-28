/**
 * The RetMag rule, as pure functions.
 *
 * WHAT IS ESTABLISHED AND WHAT IS NOT
 * -----------------------------------
 * The direction of this signal is real. Over 576 rounds per asset, taker-flow
 * imbalance with ret20 sign agreement called the outcome correctly 65.5% (BTC)
 * and 67.7% (ETH) of the time, against a coin flip — z ≈ 7, not noise.
 *
 * What is NOT established is whether it makes money, and the two facts below
 * are why that question is still open:
 *
 *   1. The market is CALIBRATED. Price at +15s predicts the outcome to within
 *      ±3 p.p. in every bucket (0.4→40.1%, 0.5→49.0%, 0.6→59.3%, 0.7→71.3%).
 *      A calibrated market already contains the information it displays, so a
 *      signal hitting 69% while entering near 0.50 is not a 19-point edge — it
 *      is a contradiction, and the P&L that follows from it is an artefact.
 *
 *   2. The magnitude gate `|ret20| >= 2bps` is NOT proven. It adds +3.8 p.p.
 *      (BTC) and +3.5 p.p. (ETH) to hit rate at z = 0.85 and 0.77 — on a
 *      sample that size, indistinguishable from noise — while halving the
 *      number of trades. The currency of a strategy is trades, not hit rate.
 *
 * So the gate is kept here as a parameter, defaulted ON because that is what
 * the research specifies, but it is the first thing to re-test rather than a
 * finding. The answer to "does this pay" can only come from executable quotes,
 * and those exist in the past for nothing (see src/convex/quotes.ts).
 *
 * Two mistakes from the first port are encoded as assertions below, because
 * both looked like "the strategy does not work" and both were defects in the
 * port rather than in the data:
 *
 *   - SHARE vs IMBALANCE. `buy/vol` is a share centred on 0.5, not an
 *     imbalance. At a 0.25 threshold it fired on 76% of rounds and the DOWN
 *     branch NEVER fired (n=0), pinning the signal to one side. The imbalance
 *     is `2*buy/vol - 1`.
 *   - HIT RATE ON THE WRONG SIDE. Scoring the ungated baseline by the gated
 *     side sent every blocked round to a loss and produced a nonsense 34.8% —
 *     the base rule looked like it worked backwards, when in fact it is
 *     symmetric: ret<0 & imb<0 → UP wins 33.6%, i.e. DOWN 66.4%.
 */

/** Required |taker-flow imbalance| for a directional call. */
export const FLOW_THRESHOLD = 0.25;

/** Window, in ms, ending at the decision point. */
export const FLOW_WINDOW_MS = 30_000;

/** Milliseconds into the round at which the decision is taken. */
export const ENTRY_OFFSET_MS = 20_000;

/** Default magnitude gate, in basis points. Not proven — see the note above. */
export const RET_MAG_THR_BPS = 2.0;

const BPS = 10_000;

export type Side = "up" | "down";
export type Signal = Side | "hold";

/**
 * Highest contract price each coin pays.
 *
 * BTC is capped lower than ETH because the measured band that stays
 * profitable on 5m is 0.40–0.60, not the 0.15–0.50 the 15m study suggested.
 */
export const MAX_CONTRACT_PRICE: Record<"btc" | "eth", number> = {
  btc: 0.6,
  eth: 0.7,
};

export type RetMagConfig = {
  flowThreshold?: number;
  flowWindowMs?: number;
  retMagThrBps?: number;
  maxContractPrice?: number;
};

export type Features = {
  /** Taker-buy base volume in the window. */
  buy: number;
  /** Total base volume in the window. */
  vol: number;
  /** Close at the decision point. */
  close: number;
  /** Close at the round start. */
  ref: number;
};

export type Decision = {
  signal: Signal;
  /** The imbalance actually used, centred on 0. */
  imb: number | null;
  /** Return over 20s, in basis points. */
  ret20Bps: number | null;
  /** Why the rule said what it said. Every one of these is a real reason. */
  detail: string;
};

/**
 * Taker-flow imbalance, centred on zero.
 *
 * Returns null when there was no volume, and the caller must treat null as
 * "no call" rather than substituting zero: a zero imbalance would read as a
 * perfectly balanced market and silently become a HOLD that looks measured.
 */
export function flowImbalance(buy: number, vol: number): number | null {
  if (!(vol > 0)) return null;
  return (2 * buy) / vol - 1;
}

/** Return from the round start to the decision point, in basis points. */
export function ret20Bps(close: number, ref: number): number | null {
  if (!(ref > 0)) return null;
  return ((close - ref) / ref) * BPS;
}

/**
 * The rule, end to end.
 *
 * Order matters and is not arbitrary. The imbalance picks the side, ret20 must
 * agree with it, the magnitude gate then vetoes flat noise, and the price cap
 * is checked last because it is a cost guard rather than a signal.
 */
export function decideRetMag(f: Features, config: RetMagConfig = {}): Decision {
  const thr = config.flowThreshold ?? FLOW_THRESHOLD;
  const gate = config.retMagThrBps ?? RET_MAG_THR_BPS;

  const imb = flowImbalance(f.buy, f.vol);
  const ret = ret20Bps(f.close, f.ref);

  if (imb === null) {
    return { signal: "hold", imb: null, ret20Bps: ret, detail: "нет объёма в окне" };
  }
  if (ret === null) {
    return { signal: "hold", imb, ret20Bps: null, detail: "нет референсной цены" };
  }

  // Symmetry check. A one-sided rule here is the defect that pinned the first
  // port to UP: if only one sign can ever fire, the imbalance is measuring
  // nothing and the "result" is an artefact of the side that was chosen.
  if (Math.abs(imb) < thr) {
    return {
      signal: "hold",
      imb,
      ret20Bps: ret,
      detail: `дисбаланс ${imb.toFixed(3)} меньше порога ${thr}`,
    };
  }

  const side: Side = imb > 0 ? "up" : "down";
  const sign = Math.sign(imb);
  if (Math.sign(ret) !== sign) {
    return {
      signal: "hold",
      imb,
      ret20Bps: ret,
      detail: `ret20 ${ret.toFixed(1)}бп против имбаланса ${side.toUpperCase()} — не согласованы`,
    };
  }

  if (Math.abs(ret) < gate) {
    return {
      signal: "hold",
      imb,
      ret20Bps: ret,
      detail: `|ret20| ${Math.abs(ret).toFixed(1)}бп ниже гейта ${gate}бп — плоский шум`,
    };
  }

  return {
    signal: side,
    imb,
    ret20Bps: ret,
    detail: `${side.toUpperCase()}: имб ${imb.toFixed(3)}, ret20 ${ret.toFixed(1)}бп`,
  };
}

/**
 * Net P&L in USDC per share, after the taker commission.
 *
 * The commission is 200bps of the stake, and it is charged on BOTH the entry
 * and the exit, so a round trip that returns the stake exactly is already
 * 400bps down. That is the arithmetic the strategy has to beat, and it is why
 * a 200bps taker rule and a 1-tick spread are not a small edge — they are the
 * entire edge.
 */
export const FEE_BPS = 200;
const SLIPPAGE_PER_SHARE = 0.005;

export function holdNet(side: Side, entryAsk: number, won: boolean): number {
  const fee = (FEE_BPS / BPS) * entryAsk;
  return (won ? 1 - entryAsk : -entryAsk) - fee;
}

export function exitNet(side: Side, entryAsk: number, exitBid: number): number {
  const fee = (FEE_BPS / BPS) * (entryAsk + exitBid);
  return exitBid - entryAsk - fee - SLIPPAGE_PER_SHARE;
}

/** What one share is worth, gross of the round trip, at a given entry price. */
export function grossAtPrice(price: number, won: boolean): number {
  return won ? 1 - price : -price;
}
