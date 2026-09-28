import { describe, expect, it } from "vitest";

import {
  FLOW_THRESHOLD,
  MAX_CONTRACT_PRICE,
  decideRetMag,
  exitNet,
  flowImbalance,
  holdNet,
  ret20Bps,
} from "./rule";

/** 62.5% taker-buy: imbalance 0.25, exactly at the threshold. */
const buyers = (share: number) => ({ buy: share, vol: 1 });

describe("дисбаланс, а не доля", () => {
  it("имбаланс центрирован на нуле, а не на 0.5", () => {
    // The first port used buy/vol, which is a SHARE centred on 0.5. At a 0.25
    // threshold that fired on 76% of rounds and the DOWN branch never fired
    // at all (n=0), pinning the signal to UP. This assertion is the guard.
    expect(flowImbalance(0.625, 1)).toBeCloseTo(0.25, 10);
    expect(flowImbalance(0.5, 1)).toBeCloseTo(0, 10);
    expect(flowImbalance(0.375, 1)).toBeCloseTo(-0.25, 10);
  });

  it("обе стороны срабатывают симметрично", () => {
    // A rule that can only fire one way is not measuring imbalance. The very
    // first run had n=0 on the DOWN side and still reported a result.
    const up = decideRetMag({ ...buyers(0.7), close: 100.1, ref: 100 });
    const down = decideRetMag({ ...buyers(0.3), close: 99.9, ref: 100 });
    expect(up.signal).toBe("up");
    expect(down.signal).toBe("down");
  });

  it("нет объёма — это отсутствие сигнала, а не нулевой дисбаланс", () => {
    // Zero volume would read as a perfectly balanced market and become a HOLD
    // that looks measured rather than missing.
    expect(flowImbalance(0, 0)).toBeNull();
    expect(decideRetMag({ buy: 0, vol: 0, close: 100, ref: 100 }).signal).toBe("hold");
  });
});

describe("правило целиком", () => {
  it("ret20 должен совпадать по знаку с дисбалансом", () => {
    const disagree = decideRetMag({ ...buyers(0.7), close: 99.9, ref: 100 });
    expect(disagree.signal).toBe("hold");
    expect(disagree.detail).toMatch(/не согласованы/);
  });

  it("гейт величины блокирует плоский шум", () => {
    // +1.5bps is under the 2bps gate even though the imbalance fires.
    const flat = decideRetMag({ ...buyers(0.7), close: 100.015, ref: 100 });
    expect(flat.ret20Bps).toBeCloseTo(1.5, 6);
    expect(flat.signal).toBe("hold");
    expect(flat.detail).toMatch(/плоский шум/);
  });

  it("гейт выключается параметром, и тогда проходит", () => {
    const flat = decideRetMag({ ...buyers(0.7), close: 100.015, ref: 100 }, { retMagThrBps: 0 });
    expect(flat.signal).toBe("up");
  });

  it("порог по умолчанию соответствует исследованию", () => {
    expect(FLOW_THRESHOLD).toBe(0.25);
    expect(ret20Bps(100.05, 100)).toBeCloseTo(5, 6);
  });

  it("потолок цены у BTC ниже, чем у ETH", () => {
    // The band that stays profitable on 5m is 0.40-0.60, which is why BTC is
    // capped at 0.60 while the 15m study's 0.15-0.50 was inherited by ETH.
    expect(MAX_CONTRACT_PRICE.btc).toBeLessThan(MAX_CONTRACT_PRICE.eth);
    expect(MAX_CONTRACT_PRICE.btc).toBe(0.6);
  });
});

describe("экономика тейкера", () => {
  it("круг по одной цене минус: комиссия 200bps с двух сторон", () => {
    const net = exitNet("up", 0.5, 0.5);
    expect(net).toBeLessThan(0);
    // 2% of 0.50 is 1c per side, so 2c of commission in total, plus 0.5c of
    // slippage per share. Expressed against the entry price that is 4% — which
    // is the real bar: a taker round trip can never come out flat.
    expect(net).toBeCloseTo(-0.02 - 0.005, 6);
    expect(net / 0.5).toBeCloseTo(-0.05, 6);
  });

  it("удержание до расчёта платит комиссию один раз", () => {
    expect(holdNet("up", 0.5, true)).toBeCloseTo(0.5 - 0.01, 6);
    expect(holdNet("up", 0.5, false)).toBeCloseTo(-0.5 - 0.01, 6);
  });

  it("победа покрывает круг, проигрыш — нет", () => {
    // The bar the signal has to clear: a correct call at 0.50 nets +$0.49 a
    // share against -$0.20 for getting out and -$0.51 for a wrong one.
    expect(holdNet("up", 0.5, true)).toBeGreaterThan(0.4);
    expect(holdNet("up", 0.5, false)).toBeLessThan(-0.5);
  });
});
