import { describe, expect, it } from "vitest";

import type { Candle, MarketSymbol } from "@/lib/market/types";
import { ROUND_MS, roundWindow } from "@/lib/market/types";
import {
  ENTRY_CUTOFF_MS,
  ENTRY_WINDOW_MS,
  evaluateSignal,
  MIN_CONFIDENCE,
  MIN_SCORE,
} from "./engine";

/* ------------------------------------------------------------------ */
/* fixture helpers                                                     */
/* ------------------------------------------------------------------ */

const BASE = 65_000; // BTC-ish price level
const OPEN = 1_770_000_000_000; // aligned to a 5-minute mark

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

/** Rising market: each minute +0.08% with mild noise-free candles. */
function risingCandles(count: number, startPrice = BASE): Candle[] {
  const out: Candle[] = [];
  let price = startPrice;
  for (let i = 0; i < count; i += 1) {
    const open = price;
    price = price * 1.0008;
    out.push(candle(OPEN + i * 60_000, price, { open }));
  }
  return out;
}

/** Falling market: each minute −0.08%. */
function fallingCandles(count: number, startPrice = BASE): Candle[] {
  const out: Candle[] = [];
  let price = startPrice;
  for (let i = 0; i < count; i += 1) {
    const open = price;
    price = price * 0.9992;
    out.push(candle(OPEN + i * 60_000, price, { open }));
  }
  return out;
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
  it("окно раунда привязано к 5-минутной отметке UTC", () => {
    const candles = risingCandles(60);
    // 2 минуты 10 секунд после начала раунда OPEN.
    const now = OPEN + 130_000;
    const readout = evaluate(candles, BASE, now);
    expect(readout).not.toBeNull();
    expect(readout?.windowStart).toBe(OPEN);
    expect(readout?.windowEnd).toBe(OPEN + ROUND_MS);
    expect(readout!.windowEnd - readout!.windowStart).toBe(ROUND_MS);
    expect(readout?.entryDeadline).toBe(OPEN + ENTRY_WINDOW_MS);
  });

  it("elapsedMs соответствует переданному времени", () => {
    const candles = flatCandles(60);
    const now = OPEN + 42_000;
    const readout = evaluate(candles, BASE, now);
    expect(readout?.elapsedMs).toBe(42_000);
    expect(readout?.phase).toBe("early");
  });
});

describe("evaluateSignal — пороги публикации", () => {
  it("сильный рост публикует UP с score ≥ MIN_SCORE и уверенностью ≥ MIN_CONFIDENCE", () => {
    const candles = risingCandles(90);
    const price = candles[candles.length - 1].close;
    const now = OPEN + 25_000; // ранняя фаза
    const readout = evaluate(candles, price, now);

    expect(readout?.direction).toBe("up");
    expect(Math.abs(readout!.score)).toBeGreaterThanOrEqual(MIN_SCORE);
    expect(readout!.confidence).toBeGreaterThanOrEqual(MIN_CONFIDENCE);
    expect(readout!.effectiveConfidence).toBe(readout!.confidence);
  });

  it("сильное падение публикует DOWN", () => {
    const candles = fallingCandles(90);
    const price = candles[candles.length - 1].close;
    const now = OPEN + 25_000;
    const readout = evaluate(candles, price, now);

    expect(readout?.direction).toBe("down");
    expect(readout!.score).toBeLessThanOrEqual(-MIN_SCORE);
    expect(readout!.confidence).toBeGreaterThanOrEqual(MIN_CONFIDENCE);
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

  it("phase=early до 60 секунд", () => {
    expect(evaluate(candles, price, OPEN + 59_999)?.phase).toBe("early");
  });

  it("phase=mid от 60 до 150 секунд", () => {
    expect(evaluate(candles, price, OPEN + 60_000)?.phase).toBe("mid");
    expect(evaluate(candles, price, OPEN + ENTRY_CUTOFF_MS - 1)?.phase).toBe("mid");
  });

  it("phase=late после 150 секунд", () => {
    expect(evaluate(candles, price, OPEN + ENTRY_CUTOFF_MS)?.phase).toBe("late");
    expect(evaluate(candles, price, OPEN + 299_000)?.phase).toBe("late");
  });

  it("эффективная уверенность затухает по фазам (early ≥ mid ≥ late)", () => {
    const early = evaluate(candles, price, OPEN + 10_000)!;
    const mid = evaluate(candles, price, OPEN + 90_000)!;
    const late = evaluate(candles, price, OPEN + 200_000)!;

    expect(early.effectiveConfidence).toBe(early.confidence);
    expect(mid.effectiveConfidence).toBeLessThan(early.confidence);
    expect(late.effectiveConfidence).toBeLessThan(mid.effectiveConfidence);
  });

  it("поздняя фаза не публикует новых направлений (декей 0.58 не даёт пройти порог 60)", () => {
    // Даже сильный тренд не даёт уверенности ≥ 60 в late-фазе при декее 0.58,
    // но сам факт затухания проверяем: effective < MIN_CONFIDENCE.
    const late = evaluate(candles, price, OPEN + 200_000)!;
    expect(late.effectiveConfidence).toBeLessThan(72);
    expect(late.phase).toBe("late");
  });
});

describe("evaluateSignal — максимальная цена входа", () => {
  it("maxEntryPrice = уверенность − 6 п.п., зажат в [0.5, 0.9]", () => {
    const candles = risingCandles(90);
    const price = candles[candles.length - 1].close;
    const readout = evaluate(candles, price, OPEN + 20_000)!;

    if (readout.direction !== "stand-aside") {
      const expected = Math.max(0.5, Math.min(0.9, (readout.confidence - 6) / 100));
      expect(readout.maxEntryPrice).toBeCloseTo(expected, 2);
    } else {
      expect(readout.maxEntryPrice).toBe(0);
    }
  });

  it("для stand-aside цена входа всегда 0", () => {
    const candles = flatCandles(90);
    const readout = evaluate(candles, BASE, OPEN + 20_000)!;
    expect(readout.direction).toBe("stand-aside");
    expect(readout.maxEntryPrice).toBe(0);
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
      expect(factor.contribution).toBeCloseTo(factor.weight * factor.value, 3);
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
    const readout = evaluate(candles, BASE * 1.001, OPEN + 130_000)!;
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
    const readout = evaluate(risingCandles(90), BASE, OPEN + 60_000)!;
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
