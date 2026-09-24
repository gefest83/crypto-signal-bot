import { describe, expect, it } from "vitest";

import { MARKET_SYMBOLS } from "@/lib/market/types";
import type { SignalReadout } from "./engine";
import { ENTRY_CUTOFF_MS, ENTRY_WINDOW_MS } from "./engine";
import { nextLocks } from "./locks";

/* ------------------------------------------------------------------ */
/* fixture helpers                                                     */
/* ------------------------------------------------------------------ */

const WIN_A = 1_770_000_000_000; // окно раунда A
const WIN_B = WIN_A + 300_000; // следующий раунд

function readout(overrides: Partial<SignalReadout> = {}): SignalReadout {
  return {
    symbol: "BTCUSDT",
    direction: "up",
    score: 0.42,
    confidence: 65,
    effectiveConfidence: 65,
    estimatedProbability: 0.55,
    factors: [],
    regime: "normal",
    volatilityRatio: 1,
    phase: "early",
    elapsedMs: 20_000,
    windowStart: WIN_A,
    windowEnd: WIN_A + 300_000,
    entryDeadline: WIN_A + ENTRY_WINDOW_MS,
    referencePrice: 65_000,
    prevRoundClose: 64_900,
    price: 65_100,
    roundPnlPct: 0.15,
    atrPct: 0.0008,
    rsi: 55,
    maxEntryPrice: 0.59,
    entryEligible: true,

    notes: [],
    evaluatedAt: WIN_A + 20_000,
    ...overrides,
  };
}

const BTC = MARKET_SYMBOLS[0]; // BTCUSDT
const ETH = MARKET_SYMBOLS[1]; // ETHUSDT

/* ------------------------------------------------------------------ */
/* nextLocks                                                           */
/* ------------------------------------------------------------------ */

describe("nextLocks — базовые правила", () => {
  it("лочит первый квалифицированный вызов (direction ≠ stand-aside, до отсечки)", () => {
    const call = readout();
    const { locks, lockedCalls } = nextLocks({}, { [BTC]: call });
    expect(locks[BTC]).toBe(call);
    expect(lockedCalls.map((call) => call.symbol)).toEqual([BTC]);
  });

  it("не лочит stand-aside", () => {
    const aside = readout({ direction: "stand-aside", maxEntryPrice: 0 });
    const { locks, lockedCalls } = nextLocks({}, { [BTC]: aside });
    expect(locks[BTC]).toBeUndefined();
    expect(lockedCalls).toEqual([]);
  });

  it("не лочит вызов после отсечки 150с", () => {
    const late = readout({
      elapsedMs: ENTRY_CUTOFF_MS,
      phase: "late",
      entryEligible: false,
    });
    const { locks, lockedCalls } = nextLocks({}, { [BTC]: late });
    expect(locks[BTC]).toBeUndefined();
    expect(lockedCalls).toEqual([]);
  });

  it("не лочит вызов после первой минуты", () => {
    const almostLate = readout({
      elapsedMs: ENTRY_WINDOW_MS,
      phase: "mid",
      entryEligible: false,
    });
    const { locks, lockedCalls } = nextLocks({}, { [BTC]: almostLate });
    expect(locks[BTC]).toBeUndefined();
    expect(lockedCalls).toEqual([]);
  });

  it("не лочит вызов в mid-фазе даже при направленном движении", () => {
    const mid = readout({
      elapsedMs: 100_000,
      phase: "mid",
      entryEligible: false,
    });
    const { locks, lockedCalls } = nextLocks({}, { [BTC]: mid });
    expect(locks[BTC]).toBeUndefined();
    expect(lockedCalls).toEqual([]);
  });

  it("лочит down-вызовы так же, как up", () => {
    const down = readout({ direction: "down", score: -0.42 });
    const { locks, lockedCalls } = nextLocks({}, { [BTC]: down });
    expect(locks[BTC]).toBe(down);
    expect(lockedCalls.map((call) => call.symbol)).toEqual([BTC]);
  });
});

describe("nextLocks — неизменяемость лока", () => {
  it("повторные readouts того же раунда не переписывают лок", () => {
    const locked = readout({ score: 0.42 });
    const better = readout({ score: 0.8, confidence: 72, direction: "up" });

    const first = nextLocks({}, { [BTC]: locked });
    expect(first.locks[BTC]).toBe(locked);

    // Тот же windowStart → лок остаётся прежним объектом.
    const second = nextLocks(first.locks, { [BTC]: better });
    expect(second.locks[BTC]).toBe(locked);
    expect(second.lockedCalls).toEqual([]);
  });

  it("readout другого окна не затирает лок текущего раунда", () => {
    const locked = readout({ windowStart: WIN_A });
    const stale = readout({ windowStart: WIN_A - 300_000, elapsedMs: 10_000 });

    const { locks, lockedCalls } = nextLocks({ [BTC]: locked }, { [BTC]: stale });
    expect(locks[BTC]).toBe(locked);
    expect(lockedCalls).toEqual([]);
  });
});

describe("nextLocks — новый раунд", () => {
  it("лок прошлого раунда не переносится в новый", () => {
    const old = readout({ windowStart: WIN_A, windowEnd: WIN_A + 300_000 });
    const fresh = readout({
      windowStart: WIN_B,
      windowEnd: WIN_B + 300_000,
      direction: "stand-aside",
    });

    const { locks } = nextLocks({ [BTC]: old }, { [BTC]: fresh });
    // В новом раунде stand-aside → лока нет.
    expect(locks[BTC]).toBeUndefined();
  });

  it("в новом раунде снова можно залочить вызов", () => {
    const old = readout({ windowStart: WIN_A });
    const fresh = readout({
      windowStart: WIN_B,
      windowEnd: WIN_B + 300_000,
      evaluatedAt: WIN_B + 15_000,
    });

    const { locks, lockedCalls } = nextLocks({ [BTC]: old }, { [BTC]: fresh });
    expect(locks[BTC]).toBe(fresh);
    expect(lockedCalls.map((call) => call.symbol)).toEqual([BTC]);
  });
});

describe("nextLocks — два символа независимо", () => {
  it("лочит BTC и ETH независимо друг от друга", () => {
    const btc = readout({ symbol: BTC });
    const eth = readout({ symbol: ETH, direction: "down", score: -0.3 });

    const { locks, lockedCalls } = nextLocks({}, { [BTC]: btc, [ETH]: eth });
    expect(locks[BTC]).toBe(btc);
    expect(locks[ETH]).toBe(eth);
    expect(lockedCalls.map((call) => call.symbol)).toEqual([BTC, ETH]);
  });

  it("BTC залочен, ETH в это время stand-aside", () => {
    const btc = readout({ symbol: BTC });
    const eth = readout({ symbol: ETH, direction: "stand-aside", maxEntryPrice: 0 });

    const { locks } = nextLocks({ [BTC]: btc }, { [BTC]: btc, [ETH]: eth });
    expect(locks[BTC]).toBe(btc);
    expect(locks[ETH]).toBeUndefined();
  });

  it("прогрев одного символа не мешает локу другого", () => {
    const btc = readout({ symbol: BTC });
    const { locks, lockedCalls } = nextLocks({}, { [BTC]: btc });
    expect(locks[BTC]).toBe(btc);
    expect(locks[ETH]).toBeUndefined();
    expect(lockedCalls.map((call) => call.symbol)).toEqual([BTC]);

    // ETH появился позже — лочится независимо.
    const eth = readout({ symbol: ETH });
    const second = nextLocks(locks, { [BTC]: btc, [ETH]: eth });
    expect(second.locks[ETH]).toBe(eth);
    expect(second.lockedCalls.map((call) => call.symbol)).toEqual([ETH]);
  });
});

describe("nextLocks — без лишних перерисовок", () => {
  it("возвращает тот же объект, когда ничего не изменилось", () => {
    const locked = readout();
    const current = { [BTC]: locked } as Partial<Record<typeof BTC, SignalReadout>>;

    // Тот же readout → объект должен быть тем же (skip re-render).
    const { locks } = nextLocks(current, { [BTC]: locked });
    expect(locks).toBe(current);
  });

  it("отсутствие readout (прогрев) сохраняет существующий лок", () => {
    const locked = readout();
    const { locks } = nextLocks({ [BTC]: locked }, {});
    expect(locks[BTC]).toBe(locked);
  });

  it("после stand-aside в новом раунде лок очищается и стабилизируется", () => {
    const old = readout({ windowStart: WIN_A });
    const freshAside = readout({
      windowStart: WIN_B,
      direction: "stand-aside",
      maxEntryPrice: 0,
    });

    const first = nextLocks({ [BTC]: old }, { [BTC]: freshAside });
    expect(first.locks[BTC]).toBeUndefined();

    const second = nextLocks(first.locks, { [BTC]: freshAside });
    expect(second.locks).toBe(first.locks);
  });
});
