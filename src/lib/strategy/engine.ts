/**
 * "Early Push" signal engine for Binance 5-minute Up/Down prediction rounds.
 *
 * Every prediction-market contract behaves the same way: you only get a real
 * edge at the very beginning of the round, because the contract price climbs
 * toward 1.00 as soon as the underlying starts moving. So the engine answers one
 * question, in the first seconds of a round:
 *
 *     "Is there enough evidence *right now* to call this round Up or Down?"
 *
 * The answer is a weighted vote of six independent 1-minute factors, filtered
 * by two guards (exhaustion + volatility regime) and decayed by how much of the
 * round has already elapsed. Standing aside is a valid, expected answer.
 *
 * Everything here is pure: same candles + same price => same signal. That makes
 * the strategy testable and keeps the React layer free of trading logic.
 */

import type { Candle, MarketSymbol } from "@/lib/market/types";
import { ROUND_MS, roundWindow } from "@/lib/market/types";

/** Best-entry window: the contract is still cheap, the call is still informed. */
export const ENTRY_WINDOW_MS = 60_000;
/** After this point a new entry has no edge left — the price already moved. */
export const ENTRY_CUTOFF_MS = 150_000;

/** Minimum absolute score required to publish a directional call. */
export const MIN_SCORE = 0.22;
/** Minimum confidence (before phase decay) required to publish a call. */
export const MIN_CONFIDENCE = 60;
/** Margin we insist on between our estimated probability and the contract entry price. */
export const EDGE_MARGIN_PP = 6;

/**
 * Priors for the estimated win probability that the entry-price gate uses.
 *
 * `confidence` is a strength / factor-agreement score on a 50–72 display scale
 * — it is NOT a probability. Treating it as one is what previously let the gate
 * buy after the contract had already repriced the move. `estimatedProbability`
 * is a separate quantity on a genuine 0–1 probability scale, used only to decide
 * the highest contract price at which the call still has positive expected value.
 *
 * The six factors re-measure the same recent impulse, so their raw vote
 * overstates the edge; the estimate stays deliberately close to a coin flip.
 * These are fixed priors for a 1-minute signal over a 5-minute round — they are
 * not fitted to any backtest.
 */
export const PROB_FLOOR = 0.5;
export const PROB_CEIL = 0.6;
/** |score| at which the estimate reaches PROB_CEIL; beyond it the estimate caps. */
export const PROB_SCORE_REF = 0.6;

/** Valid probability bounds for the entry-price gate. */
export const MIN_ENTRY_PRICE = 0.01;
export const MAX_ENTRY_PRICE = 0.99;

export type Direction = "up" | "down" | "stand-aside";
export type Phase = "early" | "mid" | "late";
export type Regime = "normal" | "chop" | "quiet";
export type Stance = "up" | "down" | "neutral";

export type Factor = {
  key: string;
  label: string;
  stance: Stance;
  /** Share of the total vote this factor can cast (weights sum to 1). */
  weight: number;
  /** Normalised reading in [-1, 1]; positive means "leans up". */
  value: number;
  /** weight * value — the actual contribution to the final score. */
  contribution: number;
  detail: string;
};

export type SignalReadout = {
  symbol: MarketSymbol;
  direction: Direction;
  /** Weighted vote in [-1, 1]. */
  score: number;
  /** Confidence before the entry-timing decay, 0-96. */
  confidence: number;
  /** Confidence that still applies in the current phase of the round. */
  effectiveConfidence: number;
  /**
   * Estimated win probability, on a genuine 0–1 scale. Separate from
   * `confidence` (strength/agreement) and used only for the entry-price gate.
   */
  estimatedProbability: number;
  factors: Factor[];
  regime: Regime;
  volatilityRatio: number;
  phase: Phase;
  elapsedMs: number;
  windowStart: number;
  windowEnd: number;
  entryDeadline: number;
  referencePrice: number;
  prevRoundClose: number;
  price: number;
  roundPnlPct: number;
  atrPct: number;
  rsi: number;
  /** Highest contract price at which the call still has a positive edge. */
  maxEntryPrice: number;
  notes: string[];
  evaluatedAt: number;
};

type EvaluateInput = {
  symbol: MarketSymbol;
  candles: Candle[];
  price: number;
  now: number;
};

/* ------------------------------------------------------------------ */
/* math helpers                                                        */
/* ------------------------------------------------------------------ */

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function ema(values: number[], period: number): number {
  if (values.length === 0) return 0;
  if (values.length < period) return mean(values);
  const k = 2 / (period + 1);
  let prev = mean(values.slice(0, period));
  for (let i = period; i < values.length; i += 1) {
    prev = values[i] * k + prev * (1 - k);
  }
  return prev;
}

function rsi(values: number[], period = 14): number {
  if (values.length <= period) return 50;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = period + 1; i < values.length; i += 1) {
    const diff = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
  }
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** Average 1-minute range as a fraction of price (ATR proxy on 1m candles). */
function averageRange(candles: Candle[]): number {
  if (candles.length === 0) return 0;
  return mean(candles.map((c) => (c.high - c.low) / c.close));
}

function rangePct(candle: Candle): number {
  return (candle.high - candle.low) / candle.close;
}

/** Volume-weighted average price of the given candles (typical price). */
function vwapOf(candles: Candle[]): number {
  let pv = 0;
  let volume = 0;
  for (const candle of candles) {
    const typical = (candle.high + candle.low + candle.close) / 3;
    pv += typical * candle.volume;
    volume += candle.volume;
  }
  if (volume === 0) return candles.length ? candles[candles.length - 1].close : 0;
  return pv / volume;
}

const signed = (value: number, digits = 2) =>
  `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(digits)}`;

/* ------------------------------------------------------------------ */
/* factors                                                             */
/* ------------------------------------------------------------------ */

const WEIGHTS = {
  momentum: 0.28,
  trend: 0.18,
  vwap: 0.14,
  flow: 0.14,
  acceleration: 0.12,
  gap: 0.14,
} as const;

function stanceOf(value: number): Stance {
  if (value > 0.05) return "up";
  if (value < -0.05) return "down";
  return "neutral";
}

function makeFactor(
  key: keyof typeof WEIGHTS,
  label: string,
  value: number,
  detail: string,
): Factor {
  const weight = WEIGHTS[key];
  const rounded = clamp(value, -1, 1);
  return {
    key,
    label,
    stance: stanceOf(rounded),
    weight,
    value: Math.round(rounded * 1000) / 1000,
    contribution: Math.round(rounded * weight * 1000) / 1000,
    detail,
  };
}

/* ------------------------------------------------------------------ */
/* engine                                                             */
/* ------------------------------------------------------------------ */

/**
 * Evaluate the current round. Returns `null` while there is not enough 1-minute
 * history to make a judgement (the console shows a warm-up state instead).
 */
export function evaluateSignal({
  symbol,
  candles,
  price,
  now,
}: EvaluateInput): SignalReadout | null {
  if (candles.length < 30 || !Number.isFinite(price) || price <= 0) return null;

  const { start: windowStart, end: windowEnd } = roundWindow(now);
  const elapsedMs = now - windowStart;
  const phase: Phase =
    elapsedMs < ENTRY_WINDOW_MS ? "early" : elapsedMs < ENTRY_CUTOFF_MS ? "mid" : "late";

  // Treat the live price as the current (forming) candle's close so the readout
  // reacts to ticks between candle closes — that is the whole point of calling
  // the round in the first seconds.
  const series = candles.slice();
  const lastIndex = series.length - 1;
  const last = series[lastIndex];
  series[lastIndex] = {
    ...last,
    close: price,
    high: Math.max(last.high, price),
    low: Math.min(last.low, price),
  };
  const closes = series.map((c) => c.close);

  const prevRoundClose =
    series.find((c) => c.openTime === windowStart - 60_000)?.close ??
    series[Math.max(0, lastIndex - 1)].close;
  const referencePrice =
    series.find((c) => c.openTime === windowStart)?.open ?? prevRoundClose;

  const atr = Math.max(averageRange(series.slice(-14)), 1e-6);
  const baseline = Math.max(
    median(series.slice(-60).map(rangePct)),
    1e-6,
  );
  const volatilityRatio = atr / baseline;

  const closeAt = (stepsBack: number) =>
    series[Math.max(0, series.length - 1 - stepsBack)].close;
  const roc = (stepsBack: number) => {
    const base = closeAt(stepsBack);
    return base === 0 ? 0 : (price - base) / base;
  };

  /* 1. Momentum across three horizons ------------------------------- */
  const momentumRaw = 0.5 * roc(1) + 0.3 * roc(3) + 0.2 * roc(5);
  const momentum = makeFactor(
    "momentum",
    "Импульс 1м / 3м / 5м",
    Math.tanh(momentumRaw / (atr * 1.6)),
    `${signed(momentumRaw * 100)}% против средней волатильности ${(atr * 100).toFixed(2)}%`,
  );

  /* 2. Trend structure (EMA 9 vs EMA 21) ---------------------------- */
  const fast = ema(closes, 9);
  const slow = ema(closes, 21);
  const separation = slow === 0 ? 0 : (fast - slow) / slow;
  const trend = makeFactor(
    "trend",
    "EMA 9 / EMA 21",
    Math.tanh(separation / (atr * 2.2)),
    `Разрыв ${signed(separation * 100)}% — ${
      separation > 0 ? "бычья" : "медвежья"
    } структура на 1м`,
  );

  /* 3. VWAP deviation, confirmed by its slope ----------------------- */
  const vwap = vwapOf(series.slice(-60));
  const deviation = vwap === 0 ? 0 : (price - vwap) / vwap;
  const vwapSlope = vwapOf(series.slice(-15)) - vwapOf(series.slice(-45, -15));
  const deviationSide = deviation === 0 ? 0 : Math.sign(deviation);
  const slopeSide = vwapSlope === 0 ? 0 : Math.sign(vwapSlope);
  const slopeAgrees = deviationSide !== 0 && deviationSide === slopeSide;
  const vwapValue =
    deviationSide *
    Math.tanh(Math.abs(deviation) / (atr * 2.5)) *
    (slopeAgrees ? 1 : 0.35);
  const vwapFactor = makeFactor(
    "vwap",
    "Отклонение от VWAP",
    vwapValue,
    `Цена ${deviation >= 0 ? "выше" : "ниже"} VWAP на ${Math.abs(
      deviation * 100,
    ).toFixed(3)}%, VWAP ${vwapSlope >= 0 ? "растёт" : "падает"}`,
  );

  /* 4. Order flow: share of taker buying --------------------------- */
  const flowWindow = series.slice(-3);
  const flowVolume = flowWindow.reduce((a, c) => a + c.volume, 0);
  const buyVolume = flowWindow.reduce((a, c) => a + c.takerBuyBase, 0);
  const buyRatio = flowVolume > 0 ? buyVolume / flowVolume : 0.5;
  const flow = makeFactor(
    "flow",
    "Поток тейкеров",
    clamp((buyRatio - 0.5) * 6, -1, 1),
    `Доля агрессивных покупок ${(buyRatio * 100).toFixed(1)}% за 3 минуты`,
  );

  /* 5. Momentum acceleration --------------------------------------- */
  const accelerationRaw = roc(1) - roc(3) / 3;
  const acceleration = makeFactor(
    "acceleration",
    "Ускорение импульса",
    0.7 * Math.tanh(accelerationRaw / (atr * 1.2)),
    accelerationRaw >= 0
      ? `Последняя минута быстрее средней — движение ${signed(accelerationRaw * 100)}%`
      : `Последняя минута слабее средней — движение ${signed(accelerationRaw * 100)}%`,
  );

  /* 6. Opening push of the current round --------------------------- */
  const gapRaw = prevRoundClose === 0 ? 0 : (price - prevRoundClose) / prevRoundClose;
  const gap = makeFactor(
    "gap",
    "Отрыв от открытия раунда",
    Math.tanh(gapRaw / (atr * 1.6)),
    `От цены открытия ${signed(gapRaw * 100)}% за ${Math.floor(elapsedMs / 1000)} с`,
  );

  const factors = [momentum, trend, vwapFactor, flow, acceleration, gap];
  const score = clamp(
    factors.reduce((acc, f) => acc + f.contribution, 0),
    -1,
    1,
  );

  /* Confidence: distance from neutral + how aligned the factors are -- */
  const directionSign = score >= 0 ? 1 : -1;
  const active = factors.filter((f) => Math.abs(f.value) >= 0.05);
  const activeWeight = active.reduce((a, f) => a + f.weight, 0) || 1;
  const agreement = clamp(
    active.reduce(
      (a, f) => a + (Math.sign(f.value) === directionSign ? f.weight : -f.weight),
      0,
    ) / activeWeight,
    -1,
    1,
  );

  // Confidence is a strength / agreement score, not a probability: it gates
  // publication only. The entry price is derived separately from
  // `estimatedProbability` below, so a strong recent impulse can no longer
  // masquerade as a high win probability at the gate.
  let confidence = 51 + 17 * Math.min(1, Math.abs(score) / 0.5) + 4 * agreement;

  /* Guard 1: do not chase an exhausted move ------------------------- */
  const rsiValue = rsi(closes, 14);
  const exhausted =
    (directionSign > 0 && rsiValue >= 76) || (directionSign < 0 && rsiValue <= 24);
  if (exhausted) confidence *= 0.85;

  /* Guard 2: volatility regime -------------------------------------- */
  const regime: Regime =
    volatilityRatio > 1.7 ? "chop" : volatilityRatio < 0.55 ? "quiet" : "normal";
  if (regime === "chop") confidence *= 0.86;
  if (regime === "quiet") confidence *= 0.92;

  confidence = clamp(confidence, 50, 72);
  const phaseMultiplier = phase === "early" ? 1 : phase === "mid" ? 0.82 : 0.58;
  const effectiveConfidence = clamp(confidence * phaseMultiplier, 0, 72);

  const qualified = Math.abs(score) >= MIN_SCORE && confidence >= MIN_CONFIDENCE;
  const direction: Direction = qualified
    ? score > 0
      ? "up"
      : "down"
    : "stand-aside";

  /* Estimated win probability — a real probability, unlike `confidence` ----- */
  // Monotone in signal strength, but it neither saturates at |score| = 0.5 nor
  // rewards factor agreement (which is inflated by the factors' shared input).
  const estimatedProbability =
    PROB_FLOOR +
    (PROB_CEIL - PROB_FLOOR) * clamp(Math.abs(score) / PROB_SCORE_REF, 0, 1);

  const maxEntryPrice =
    direction === "stand-aside"
      ? 0
      : clamp(
          Math.round((estimatedProbability - EDGE_MARGIN_PP / 100) * 100) / 100,
          MIN_ENTRY_PRICE,
          MAX_ENTRY_PRICE,
        );

  const roundPnlPct =
    referencePrice === 0 ? 0 : ((price - referencePrice) / referencePrice) * 100;

  /* Human-readable reasoning --------------------------------------- */
  const notes: string[] = [];
  if (phase === "early") {
    notes.push("Окно входа открыто: контракт ещё не переоценён.");
  } else if (phase === "mid") {
    notes.push("Лучшее окно входа прошло — цена контракта уже выросла.");
  } else {
    notes.push("Поздняя фаза: новый вход без перевеса, только наблюдение.");
  }

  if (direction === "stand-aside") {
    notes.push(
      `Перевес ${signed(score)} ниже порога ${MIN_SCORE.toFixed(2)} — раунд пропускаем.`,
    );
  } else {
    notes.push(
      `Согласие факторов ${Math.round((agreement + 1) * 50)}% · вес ${Math.round(
        activeWeight * 100,
      )}% от общего голоса.`,
    );
  }

  if (regime === "chop") {
    notes.push(
      `Волатильность ×${volatilityRatio.toFixed(2)} от нормы — риск ложного пробоя, размер позиции −30%.`,
    );
  } else if (regime === "quiet") {
    notes.push("Затишье: диапазон узкий, сделка может не дойти до цели.");
  }

  if (exhausted) {
    notes.push(
      `RSI(14) ${rsiValue.toFixed(0)} — движение растянуто, уверенность снижена.`,
    );
  }

  return {
    symbol,
    direction,
    score: Math.round(score * 1000) / 1000,
    confidence: Math.round(confidence),
    effectiveConfidence: Math.round(effectiveConfidence),
    estimatedProbability: Math.round(estimatedProbability * 1000) / 1000,
    factors,
    regime,
    volatilityRatio: Math.round(volatilityRatio * 100) / 100,
    phase,
    elapsedMs,
    windowStart,
    windowEnd,
    entryDeadline: windowStart + ENTRY_WINDOW_MS,
    referencePrice,
    prevRoundClose,
    price,
    roundPnlPct,
    atrPct: atr,
    rsi: rsiValue,
    maxEntryPrice,
    notes,
    evaluatedAt: now,
  };
}

export { ROUND_MS, roundWindow };

/** mm:ss until a timestamp, clamped at zero. */
export function countdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
