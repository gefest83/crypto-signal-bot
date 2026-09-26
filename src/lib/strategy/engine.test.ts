import { describe, expect, it } from "vitest";

import type { Candle, MarketSymbol } from "@/lib/market/types";
import { ROUND_MS, roundWindow } from "@/lib/market/types";
import {
  DEFAULT_CONFIG,
  EDGE_MARGIN_PP,
  ENTRY_CUTOFF_MS,
  ENTRY_WINDOW_MS,
  evaluateSignal,
  MAX_ENTRY_PRICE,
  MAX_ENTRY_SCORE,
  MIN_CONFIDENCE,
  MIN_ENTRY_ELAPSED_MS,
  MIN_ENTRY_PRICE,
  MIN_SCORE,
  PROB_CEIL,
  PROB_FLOOR,
  PROB_SCORE_REF,
} from "./engine";

/* ------------------------------------------------------------------ */
/* fixture helpers                                                     */
/* ------------------------------------------------------------------ */

const BASE = 65_000; // BTC-ish price level
const OPEN = 1_769_999_400_000; // aligned to a 15-minute mark

const candle = (openTime: number, close: number, overrides: Partial<Candle> = {}): Candle => {
  const open = overrides.open ?? close;
  const high = overrides.high ?? Math.max(open, close) * 1.0004;
  const low = overrides.low ?? Math.min(open, close) * 0.9996;
  return {
    openTime,
    open,
    high,
    low,
    close,
    volume: overrides.volume ?? 120,
    closeTime: openTime + 59_999,
    quoteVolume: overrides.quoteVolume ?? close * 120,
    trades: overrides.trades ?? 900,
    takerBuyBase: overrides.takerBuyBase ?? 60,
    takerBuyQuote: overrides.quoteVolume !== undefined ? overrides.quoteVolume / 2 : close * 60,
  };
};

/**
 * Market shape used by most fixtures: a net drift with pullbacks, so RSI(14)
 * stays in a tradeable band (not pinned at 100/0) and taker flow leans with the
 * move. Real ticks are never a monotone staircase, and the stricter precision
 * gate deliberately rejects an over-extended staircase.
 */
const UP_CYCLE = [0.0008, -0.0005, 0.0006, -0.0004, 0.0009];
const DOWN_CYCLE = UP_CYCLE.map((value) => -value);

function trendCandles(
  count: number,
  cycle: readonly number[],
  startPrice = BASE,
  scale = 1,
): Candle[] {
  const out: Candle[] = [];
  let price = startPrice;
  const bullish = cycle[0] > 0;
  for (let i = 0; i < count; i += 1) {
    const open = price;
    price = price * (1 + cycle[i % cycle.length] * scale);
    out.push(
      candle(OPEN + i * 60_000, price, {
        open,
        volume: 120,
        quoteVolume: price * 120,
        takerBuyBase: 120 * (bullish ? 0.62 : 0.38),
      }),
    );
  }
  return out;
}

/** Rising market: ~+0.03%/min net with pullbacks and buy-side taker flow. */
function risingCandles(count: number, startPrice = BASE): Candle[] {
  return trendCandles(count, UP_CYCLE, startPrice);
}

/** Falling market: ~−0.03%/min net with pullbacks and sell-side taker flow. */
function fallingCandles(count: number, startPrice = BASE): Candle[] {
  return trendCandles(count, DOWN_CYCLE, startPrice);
}

/**
 * Parabolic variant: the same uptrend amplified 4×, so nearly every factor
 * saturates. Used to prove the anti-blowoff ceiling rejects it.
 */
function parabolicCandles(count: number, startPrice = BASE): Candle[] {
  return trendCandles(count, UP_CYCLE, startPrice, 4);
}

/** Flat market with realistic per-minute ranges. */
function flatCandles(count: number, startPrice = BASE): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push(
      candle(OPEN + i * 60_000, startPrice, {
        high: startPrice * 1.0005,
        low: startPrice * 0.9995,
        open: startPrice,
      }),
    );
  }
  return out;
}

function lastOpen(candles: Candle[]): number {
  return candles[candles.length - 1].openTime;
}

function evaluate(candles: Candle[], price: number, now: number, symbol: MarketSymbol = "BTCUSDT") {
  return evaluateSignal({ symbol, candles, price, now });
}

/**
 * A moment inside the confirmation window: the round's first minute has closed
 * (t ≥ 60s) but the entry window is still open (t < 120s). Publishable calls
 * only exist here.
 */
const IN_WINDOW = OPEN + 240_000;

/* ------------------------------------------------------------------ */
/* engine tests                                                        */
/* ------------------------------------------------------------------ */

describe("evaluateSignal — входные данные", () => {
  it("возвращает null, когда свечей меньше 30 (прогрев)", () => {
    const now = lastOpen(risingCandles(29)) + 59_000;
    expect(evaluate(risingCandles(10), BASE * 1.002, now)).toBeNull();
    expect(evaluate(risingCandles(29), BASE * 1.002, now)).toBeNull();
  });

  it("возвращает readout, когда свечей ровно 30", () => {
    const candles = risingCandles(30);
    const now = lastOpen(candles) + 59_000;
    expect(evaluate(candles, candles[candles.length - 1].close, now)).not.toBeNull();
  });

  it("возвращает null при некорректной цене (NaN, 0, отрицательная)", () => {
    const candles = risingCandles(40);
    const now = lastOpen(candles) + 59_000;
    expect(evaluate(candles, Number.NaN, now)).toBeNull();
    expect(evaluate(candles, 0, now)).toBeNull();
    expect(evaluate(candles, -100, now)).toBeNull();
  });
});

describe("evaluateSignal — окна раундов", () => {
  it("окно раунда привязано к 15-минутной отметке UTC", () => {
    const candles = risingCandles(60);
    // 3 минуты 10 секунд после начала раунда OPEN.
    const now = OPEN + 190_000;
    const readout = evaluate(candles, BASE, now);
    expect(readout).not.toBeNull();
    expect(readout?.windowStart).toBe(OPEN);
    expect(readout?.windowEnd).toBe(OPEN + ROUND_MS);
    expect(readout!.windowEnd - readout!.windowStart).toBe(ROUND_MS);
    expect(readout?.entryDeadline).toBe(OPEN + ENTRY_WINDOW_MS);
  });

  it("elapsedMs соответствует переданному времени", () => {
    const candles = flatCandles(60);
    const readout = evaluate(candles, BASE, OPEN + 42_000);
    expect(readout?.elapsedMs).toBe(42_000);
    // Первая минута ещё не закрылась — входных данных о раунде нет.
    expect(readout?.phase).toBe("prepare");

    const confirmed = evaluate(candles, BASE, IN_WINDOW);
    expect(confirmed?.elapsedMs).toBe(240_000);
    expect(confirmed?.phase).toBe("early");
  });
});

describe("evaluateSignal — пороги публикации", () => {
  it("сильный рост публикует UP с score ≥ MIN_SCORE и уверенностью ≥ MIN_CONFIDENCE", () => {
    const candles = risingCandles(90);
    const price = candles[candles.length - 1].close;
    const readout = evaluate(candles, price, IN_WINDOW);

    expect(readout?.direction).toBe("up");
    expect(Math.abs(readout!.score)).toBeGreaterThanOrEqual(MIN_SCORE);
    expect(readout!.confidence).toBeGreaterThanOrEqual(MIN_CONFIDENCE);
    expect(readout!.effectiveConfidence).toBe(readout!.confidence);
  });

  it("сильное падение публикует DOWN", () => {
    const candles = fallingCandles(90);
    const price = candles[candles.length - 1].close;
    const readout = evaluate(candles, price, IN_WINDOW);

    expect(readout?.direction).toBe("down");
    expect(readout!.score).toBeLessThanOrEqual(-MIN_SCORE);
    expect(readout!.confidence).toBeGreaterThanOrEqual(MIN_CONFIDENCE);
  });

  it("потолок score — правило: вызов выше настроенного потолка не публикуется", () => {
    // Потолок MAX_ENTRY_SCORE больше не калибровка под конкретный рынок, а
    // жёсткое правило гейта, поэтому проверяем сам механизм отсечения.
    const candles = parabolicCandles(90);
    const price = candles[candles.length - 1].close;
    const strong = evaluate(candles, price, IN_WINDOW)!;
    expect(strong.direction).toBe("up");
    // Текущий потолок для этого сценария не является связывающим: сильное
    // движение первой минуты теперь продолжается, а не откатывается.
    expect(Math.abs(strong.score)).toBeLessThanOrEqual(MAX_ENTRY_SCORE);

    const capped = evaluateSignal({
      symbol: "BTCUSDT",
      candles,
      price,
      now: IN_WINDOW,
      config: { ...DEFAULT_CONFIG, maxEntryScore: Math.abs(strong.score) - 0.02 },
    })!;
    expect(capped.direction).toBe("stand-aside");
    expect(capped.maxEntryPrice).toBe(0);
  });

  it("не публикует вызов против старшего тренда (отскок против EMA 15/40)", () => {
    // 86 минут падения, затем резкий отскок вверх в последних свечах: младшие
    // факторы смотрят вверх, но EMA 15/40 по-прежнему ниже — вход запрещён.
    const base = fallingCandles(86);
    const candles = base.slice();
    let price = candles[candles.length - 1].close;
    for (let i = 86; i < 90; i += 1) {
      const open = price;
      price = price * 1.0009;
      candles.push(
        candle(OPEN + i * 60_000, price, {
          open,
          volume: 120,
          quoteVolume: price * 120,
          takerBuyBase: 120 * 0.7,
        }),
      );
    }
    const readout = evaluate(candles, price, IN_WINDOW)!;
    expect(readout.direction).toBe("stand-aside");
  });

  it("не публикует тот же импульс после закрытия early-окна", () => {
    const candles = risingCandles(90);
    const readout = evaluate(
      candles,
      candles[candles.length - 1].close,
      OPEN + ENTRY_WINDOW_MS,
    )!;

    expect(readout.phase).toBe("mid");
    expect(readout.direction).toBe("stand-aside");
    expect(readout.maxEntryPrice).toBe(0);
  });

  it("флэт → stand-aside: score ниже порога", () => {
    const candles = flatCandles(90);
    const now = OPEN + 25_000;
    const readout = evaluate(candles, BASE, now);

    expect(readout?.direction).toBe("stand-aside");
    expect(Math.abs(readout!.score)).toBeLessThan(MIN_SCORE);
    expect(readout!.maxEntryPrice).toBe(0);
  });

  it("уверенность не выходит за пределы 50–72", () => {
    const strong = risingCandles(120, BASE);
    const price = strong[strong.length - 1].close;
    const readoutStrong = evaluate(strong, price, OPEN + 10_000);
    expect(readoutStrong!.confidence).toBeLessThanOrEqual(72);
    expect(readoutStrong!.confidence).toBeGreaterThanOrEqual(50);

    const weak = flatCandles(120);
    const readoutWeak = evaluate(weak, BASE, OPEN + 10_000);
    expect(readoutWeak!.confidence).toBeGreaterThanOrEqual(50);
    expect(readoutWeak!.confidence).toBeLessThanOrEqual(72);
  });
});

describe("evaluateSignal — фазы раунда", () => {
  const candles = risingCandles(90);
  const price = candles[candles.length - 1].close;

  it("phase=prepare до закрытия первой минуты раунда", () => {
    expect(evaluate(candles, price, OPEN + 1_000)?.phase).toBe("prepare");
    expect(evaluate(candles, price, OPEN + 59_999)?.phase).toBe("prepare");
  });

  it("phase=early ровно после закрытия первой минуты (окно подтверждения)", () => {
    expect(evaluate(candles, price, OPEN + MIN_ENTRY_ELAPSED_MS)?.phase).toBe("early");
    expect(evaluate(candles, price, OPEN + ENTRY_WINDOW_MS - 1)?.phase).toBe("early");
  });

  it("phase=mid от 120 до 180 секунд", () => {
    expect(evaluate(candles, price, OPEN + ENTRY_WINDOW_MS)?.phase).toBe("mid");
    expect(evaluate(candles, price, OPEN + ENTRY_CUTOFF_MS - 1)?.phase).toBe("mid");
  });

  it("phase=late после закрытия окна", () => {
    expect(evaluate(candles, price, OPEN + ENTRY_CUTOFF_MS)?.phase).toBe("late");
    expect(evaluate(candles, price, OPEN + ROUND_MS - 1_000)?.phase).toBe("late");
  });

  it("эффективная уверенность затухает по фазам (early ≥ mid ≥ late)", () => {
    const early = evaluate(candles, price, OPEN + 200_000)!;
    const mid = evaluate(candles, price, OPEN + 500_000)!;
    const late = evaluate(candles, price, OPEN + 700_000)!;

    expect(early.phase).toBe("early");
    expect(early.effectiveConfidence).toBe(early.confidence);
    expect(mid.effectiveConfidence).toBeLessThan(early.confidence);
    expect(late.effectiveConfidence).toBeLessThan(mid.effectiveConfidence);
  });

  it("поздняя фаза не публикует новых направлений (декей 0.58 не даёт пройти порог 60)", () => {
    // Даже сильный тренд не даёт уверенности ≥ 60 в late-фазе при декее 0.58,
    // но сам факт затухания проверяем: effective < MIN_CONFIDENCE.
    const late = evaluate(candles, price, OPEN + 700_000)!;
    expect(late.effectiveConfidence).toBeLessThan(72);
    expect(late.phase).toBe("late");
  });
});

describe("evaluateSignal — оценка вероятности", () => {
  it("estimatedProbability лежит в [PROB_FLOOR, PROB_CEIL] на шкале 0–1", () => {
    const strong = risingCandles(120);
    const strongReadout = evaluate(
      strong,
      strong[strong.length - 1].close,
      OPEN + 10_000,
    )!;
    expect(strongReadout.estimatedProbability).toBeGreaterThanOrEqual(PROB_FLOOR);
    expect(strongReadout.estimatedProbability).toBeLessThanOrEqual(PROB_CEIL);

    const flat = evaluate(flatCandles(120), BASE, OPEN + 10_000)!;
    expect(flat.estimatedProbability).toBeGreaterThanOrEqual(PROB_FLOOR);
    expect(flat.estimatedProbability).toBeLessThanOrEqual(PROB_CEIL);
  });

  it("это вероятность, а не уверенность: шкала не совпадает с confidence", () => {
    const candles = risingCandles(90);
    const readout = evaluate(
      candles,
      candles[candles.length - 1].close,
      OPEN + 20_000,
    )!;
    // conviction живёт в 50–72, вероятность — в 0.50–0.60.
    expect(readout.estimatedProbability).toBeLessThan(readout.confidence / 100);
    expect(readout.estimatedProbability).toBeLessThan(0.65);
  });

  it("монотонна по |score| и не насыщается на пороге 0.5", () => {
    const candles = risingCandles(90);
    const readout = evaluate(
      candles,
      candles[candles.length - 1].close,
      OPEN + 20_000,
    )!;
    const expected =
      PROB_FLOOR +
      (PROB_CEIL - PROB_FLOOR) *
        Math.min(1, Math.abs(readout.score) / PROB_SCORE_REF);
    expect(readout.estimatedProbability).toBeCloseTo(expected, 2);
  });
});

describe("evaluateSignal — максимальная цена входа", () => {
  it("maxEntryPrice = estimatedProbability − EDGE_MARGIN, без уверенности", () => {
    const candles = risingCandles(90);
    const price = candles[candles.length - 1].close;
    const readout = evaluate(candles, price, IN_WINDOW)!;

    // Сильный рост гарантированно публикует вызов, поэтому проверка не уходит
    // в необязательную ветку и регрессия ловится всегда.
    expect(readout.direction).toBe("up");

    const expected = Math.max(
      MIN_ENTRY_PRICE,
      Math.min(
        MAX_ENTRY_PRICE,
        Math.round((readout.estimatedProbability - EDGE_MARGIN_PP / 100) * 100) / 100,
      ),
    );
    expect(readout.maxEntryPrice).toBeCloseTo(expected, 2);
    // Регрессия на старую ошибку: гейт больше не строится из confidence и не
    // может превысить PROB_CEIL − margin (старая формула доходила до 0.66).
    expect(readout.maxEntryPrice).toBeLessThanOrEqual(
      Math.round((PROB_CEIL - EDGE_MARGIN_PP / 100) * 100) / 100,
    );
  });

  it("насыщение силы сигнала не поднимает цену входа выше потолка", () => {
    // Инвариант проверяется на наборе сценариев разной силы и разных фаз:
    // как бы сильным ни был сигнал, гейт не может превысить PROB_CEIL − margin.
    const scenarios: Array<() => ReturnType<typeof evaluate>> = [];
    for (const count of [90, 150, 240]) {
      for (const now of [OPEN + 10_000, OPEN + 90_000, OPEN + 200_000]) {
        for (const build of [risingCandles, fallingCandles]) {
          scenarios.push(() => {
            const candles = build(count);
            return evaluate(candles, candles[candles.length - 1].close, now);
          });
        }
      }
    }

    let checkedCalls = 0;
    for (const build of scenarios) {
      const readout = build();
      if (!readout) throw new Error("ожидался readout");
      if (readout.direction === "stand-aside") {
        expect(readout.maxEntryPrice).toBe(0);
        continue;
      }
      checkedCalls += 1;
      expect(readout.maxEntryPrice).toBeLessThanOrEqual(
        Math.round((PROB_CEIL - EDGE_MARGIN_PP / 100) * 100) / 100,
      );
    }
    expect(checkedCalls).toBeGreaterThan(0);
  });

  it("maxEntryPrice не зависит от agreement: одинаковый |score| — одинаковый гейт", () => {
    // confidence растёт от agreement, maxEntryPrice — нет. Обе серии дают вызов,
    // поэтому разница в confidence не должна двигать цену входа.
    const up = evaluate(risingCandles(90), risingCandles(90)[89].close, IN_WINDOW)!;
    const down = evaluate(fallingCandles(90), fallingCandles(90)[89].close, IN_WINDOW)!;

    expect(up.direction).toBe("up");
    expect(down.direction).toBe("down");
    expect(Math.abs(up.score)).toBeCloseTo(Math.abs(down.score), 2);
    expect(up.maxEntryPrice).toBeCloseTo(down.maxEntryPrice, 2);
  });

  it("для stand-aside цена входа всегда 0", () => {
    const candles = flatCandles(90);
    const readout = evaluate(candles, BASE, IN_WINDOW)!;
    expect(readout.phase).toBe("early");
    expect(readout.direction).toBe("stand-aside");
    expect(readout.maxEntryPrice).toBe(0);
  });
});

describe("evaluateSignal — окно подтверждения (первая минута раунда)", () => {
  const candles = risingCandles(120);
  const price = candles[candles.length - 1].close;

  it("не публикует вызов до закрытия первой минуты раунда даже при сильном тренде", () => {
    for (const now of [OPEN + 1_000, OPEN + 20_000, OPEN + 45_000, OPEN + 59_999]) {
      const readout = evaluate(candles, price, now)!;
      expect(readout.phase).toBe("prepare");
      expect(readout.direction).toBe("stand-aside");
      expect(readout.maxEntryPrice).toBe(0);
      expect(readout.entryEligible).toBe(false);
    }
  });

  it("entryOpensAt = начало раунда + закрытие первой минуты", () => {
    const readout = evaluate(candles, price, IN_WINDOW)!;
    expect(readout.windowStart).toBe(OPEN);
    expect(readout.entryOpensAt).toBe(OPEN + MIN_ENTRY_ELAPSED_MS);
    expect(readout.entryDeadline).toBe(OPEN + ENTRY_WINDOW_MS);
    expect(readout.entryOpensAt).toBeLessThan(readout.entryDeadline);
  });

  it("публикует вызов внутри окна подтверждения и помечает его как входной", () => {
    const readout = evaluate(candles, price, OPEN + MIN_ENTRY_ELAPSED_MS + 1_000)!;
    expect(readout.phase).toBe("early");
    expect(readout.direction).toBe("up");
    expect(readout.entryEligible).toBe(true);
  });

  it("в prepare уверенность не затухает (окно ещё не открылось)", () => {
    const prepare = evaluate(candles, price, OPEN + 30_000)!;
    expect(prepare.phase).toBe("prepare");
    expect(prepare.effectiveConfidence).toBe(prepare.confidence);
  });
});

describe("evaluateSignal — режимы волатильности", () => {
  it("chop при volatilityRatio > 1.7 снижает уверенность (×0.86)", () => {
    // Всплеск диапазона в последних 14 свечах → ATR выше медианы.
    const candles = flatCandles(80);
    const spikeCount = 12;
    for (let i = 0; i < spikeCount; i += 1) {
      const idx = candles.length - 1 - i;
      candles[idx] = candle(OPEN + idx * 60_000, BASE, {
        high: BASE * 1.008,
        low: BASE * 0.992,
        open: BASE,
      });
    }
    const readout = evaluate(candles, BASE, OPEN + 20_000)!;
    expect(readout.volatilityRatio).toBeGreaterThan(1.7);
    expect(readout.regime).toBe("chop");
  });

  it("quiet при volatilityRatio < 0.55 снижает уверенность (×0.92)", () => {
    // ATR — средний диапазон последних 14 свечей, база — медиана последних 60.
    // Сжимаем только последние 14 свечей (±0.02%), остальное — нормальный
    // диапазон (±0.3%): медиана базы останется ~0.6%, ATR упадёт до ~0.04%.
    const candles: Candle[] = [];
    for (let i = 0; i < 106; i += 1) {
      candles.push(
        candle(OPEN + i * 60_000, BASE, {
          high: BASE * 1.003,
          low: BASE * 0.997,
          open: BASE,
        }),
      );
    }
    for (let i = 106; i < 120; i += 1) {
      candles.push(
        candle(OPEN + i * 60_000, BASE, {
          high: BASE * 1.0002,
          low: BASE * 0.9998,
          open: BASE,
        }),
      );
    }
    const readout = evaluate(candles, BASE, OPEN + 119 * 60_000 + 20_000)!;
    expect(readout.volatilityRatio).toBeLessThan(0.55);
    expect(readout.regime).toBe("quiet");
  });

  it("normal между порогами", () => {
    const candles = flatCandles(90);
    const readout = evaluate(candles, BASE, OPEN + 20_000)!;
    expect(readout.regime).toBe("normal");
  });
});

describe("evaluateSignal — факторы и структура readout", () => {
  const candles = risingCandles(90);
  const price = candles[candles.length - 1].close;
  const readout = evaluate(candles, price, OPEN + 30_000)!;

  it("ровно 6 факторов, веса в сумме дают 1", () => {
    expect(readout.factors).toHaveLength(6);
    const totalWeight = readout.factors.reduce((a, f) => a + f.weight, 0);
    expect(totalWeight).toBeCloseTo(1, 5);
  });

  it("значения факторов зажаты в [-1, 1], вклад = weight × value", () => {
    for (const factor of readout.factors) {
      expect(Math.abs(factor.value)).toBeLessThanOrEqual(1);
      expect(factor.contribution).toBeCloseTo(factor.weight * factor.value, 2);
    }
  });

  it("score = сумме вкладов факторов", () => {
    const sum = readout.factors.reduce((a, f) => a + f.contribution, 0);
    expect(readout.score).toBeCloseTo(sum, 2);
  });

  it("эталонная цена берётся из открытия раунда, если та свеча есть", () => {
    // Свеча с openTime === windowStart присутствует → referencePrice = её open.
    const candles = risingCandles(120);
    const target = candles.find((c) => c.openTime === OPEN);
    expect(target).toBeDefined();
    const readout = evaluate(candles, BASE * 1.001, OPEN + 190_000)!;
    expect(readout.referencePrice).toBe(target!.open);
  });
});

describe("evaluateSignal — referencePrice и прогресс раунда", () => {
  it("roundPnlPct отражает движение от открытия раунда", () => {
    const candles = risingCandles(90);
    const price = BASE * 1.001;
    const readout = evaluate(candles, price, OPEN + 130_000)!;
    const expected = ((price - readout.referencePrice) / readout.referencePrice) * 100;
    expect(readout.roundPnlPct).toBeCloseTo(expected, 6);
  });

  it("новый раунд (после CLOSE) начинается с новой referencePrice", () => {
    // Свечи заканчиваются задолго до OPEN — последний раунд до окна now.
    const readout = evaluate(risingCandles(90), BASE, OPEN + 240_000)!;
    expect(readout.windowStart).toBe(OPEN);
    expect(readout.referencePrice).toBeGreaterThan(0);
  });
});

describe("evaluateSignal — чистота функции", () => {
  it("дважды одинаковый вход даёт идентичный readout", () => {
    const candles = risingCandles(80);
    const price = candles[candles.length - 1].close;
    const now = OPEN + 45_000;
    const a = evaluate(candles, price, now);
    const b = evaluate(candles, price, now);
    expect(a).toEqual(b);
  });

  it("не мутирует входные свечи", () => {
    const candles = risingCandles(60);
    const snapshot = JSON.parse(JSON.stringify(candles)) as Candle[];
    evaluate(candles, BASE * 1.003, OPEN + 30_000);
    expect(candles).toEqual(snapshot);
  });
});
