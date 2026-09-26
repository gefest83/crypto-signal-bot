import { describe, expect, it } from "vitest";
import {
  ENTRY_END_MS,
  ENTRY_START_MS,
  FAVORITE_MIN_ASK,
  evaluateEntry,
  limitPriceFor,
  pnlForEntry,
  takerFee,
} from "./entry";

const START = Date.UTC(2026, 8, 26, 12, 0, 0);
const at = (offsetMs: number) => START + offsetMs;

/** A round where the market has made UP the clear favourite. */
const upFavourite = {
  start: START,
  now: at(ENTRY_START_MS + 30_000),
  upAsk: 0.86,
  upBid: 0.85,
  downAsk: 0.15,
  downBid: 0.14,
};

describe("окно входа", () => {
  it("не заходит до закрытия первой минуты", () => {
    const readout = evaluateEntry({ ...upFavourite, now: at(ENTRY_START_MS - 1) });
    expect(readout.eligible).toBe(false);
    expect(readout.direction).toBe("stand-aside");
  });

  it("заходит сразу после закрытия первой минуты", () => {
    const readout = evaluateEntry({ ...upFavourite, now: at(ENTRY_START_MS) });
    expect(readout.eligible).toBe(true);
    expect(readout.direction).toBe("up");
  });

  it("не заходит после закрытия окна", () => {
    const readout = evaluateEntry({ ...upFavourite, now: at(ENTRY_END_MS) });
    expect(readout.eligible).toBe(false);
  });
});

describe("порог фаворита", () => {
  it("пропускает раунд без явного фаворита", () => {
    const readout = evaluateEntry({
      ...upFavourite,
      upAsk: FAVORITE_MIN_ASK - 0.01,
      upBid: FAVORITE_MIN_ASK - 0.02,
      downAsk: 1 - (FAVORITE_MIN_ASK - 0.01),
      downBid: 1 - (FAVORITE_MIN_ASK - 0.02),
    });
    expect(readout.eligible).toBe(false);
    expect(readout.reason).toContain("не выделил фаворита");
  });

  it("берёт ровно на пороге", () => {
    const readout = evaluateEntry({
      ...upFavourite,
      upAsk: FAVORITE_MIN_ASK,
      upBid: FAVORITE_MIN_ASK - 0.01,
    });
    expect(readout.eligible).toBe(true);
  });

  it("видит фаворита по цене, а не по тику направления", () => {
    const readout = evaluateEntry({
      start: START,
      now: at(ENTRY_START_MS + 30_000),
      upAsk: 0.2,
      upBid: 0.19,
      downAsk: 0.83,
      downBid: 0.82,
    });
    expect(readout.direction).toBe("down");
    expect(readout.ask).toBe(0.83);
  });

  it("молчит без котировок", () => {
    const readout = evaluateEntry({
      start: START,
      now: at(ENTRY_START_MS + 30_000),
      upAsk: null,
      upBid: null,
      downAsk: null,
      downBid: null,
    });
    expect(readout.eligible).toBe(false);
    expect(readout.reason).toContain("Нет котировок");
  });
});

describe("подтверждение свечным движком", () => {
  it("входит, когда движок согласился", () => {
    const readout = evaluateEntry({ ...upFavourite, confirm: "up" });
    expect(readout.eligible).toBe(true);
  });

  it("пропускает расхождение", () => {
    const readout = evaluateEntry({ ...upFavourite, confirm: "down" });
    expect(readout.eligible).toBe(false);
    expect(readout.reason).toContain("Расхождение");
  });

  it("считает отсутствие мнения не как противоречие", () => {
    const readout = evaluateEntry({ ...upFavourite, confirm: "stand-aside" });
    expect(readout.eligible).toBe(true);
  });

  it("без требования подтверждения берёт любой фаворит", () => {
    const readout = evaluateEntry({
      ...upFavourite,
      confirm: "down",
      requireConfirmation: false,
    });
    expect(readout.eligible).toBe(true);
  });
});

describe("торгуемость котировки", () => {
  it("не входит по отставшей котировке", () => {
    const readout = evaluateEntry({ ...upFavourite, tradable: false });
    expect(readout.eligible).toBe(false);
    expect(readout.reason).toContain("Стакан пуст");
  });

  it("входит, когда котировка из стакана", () => {
    const readout = evaluateEntry({ ...upFavourite, tradable: true });
    expect(readout.eligible).toBe(true);
  });
});

describe("цена лимита в вызове", () => {
  it("отдаётся вместе с вызовом", () => {
    const readout = evaluateEntry({
      start: START,
      now: at(ENTRY_START_MS + 30_000),
      upAsk: 0.2,
      upBid: 0.19,
      downAsk: 0.83,
      downBid: 0.82,
    });
    expect(readout.eligible).toBe(true);
    expect(readout.ask).toBe(0.83);
    expect(readout.limitPrice).toBe(0.82);
  });
});

describe("комиссии Polymarket", () => {
  it("тейкерская комиссия = 7% × (1 − цена)", () => {
    expect(takerFee(0.86)).toBeCloseTo(0.07 * 0.14, 6);
    expect(takerFee(0.8)).toBeCloseTo(0.07 * 0.2, 6);
    expect(takerFee(0.95)).toBeCloseTo(0.07 * 0.05, 6);
  });

  it("мейкер не платит ничего", () => {
    expect(pnlForEntry(0.86, true, "maker")).toBeCloseTo(1 / 0.86 - 1, 6);
    expect(pnlForEntry(0.86, false, "maker")).toBe(-1);
  });

  it("тейкер платит комиссию и на выигрыше, и на проигрыше", () => {
    expect(pnlForEntry(0.86, true, "taker")).toBeCloseTo(1 / 0.86 - 1 - 0.07 * 0.14, 6);
    expect(pnlForEntry(0.86, false, "taker")).toBeCloseTo(-1 - 0.07 * 0.14, 6);
  });
});

describe("цена лимитной заявки", () => {
  it("ставится в середину спреда, не пересекая ask", () => {
    expect(limitPriceFor(0.84, 0.88)).toBe(0.86);
  });

  it("при спреде в один тик встаёт в бид", () => {
    expect(limitPriceFor(0.85, 0.86)).toBe(0.85);
  });

  it("не придумывает цену без стакана", () => {
    expect(limitPriceFor(null, 0.86)).toBeNull();
    expect(limitPriceFor(0.85, null)).toBeNull();
  });
});

describe("P&L по реальной цене", () => {
  it("выигрыш платит 1/цена − 1", () => {
    expect(pnlForEntry(0.5, true)).toBeCloseTo(1);
    expect(pnlForEntry(0.86, true)).toBeCloseTo(1 / 0.86 - 1, 6);
  });

  it("проигрыш всегда −1", () => {
    expect(pnlForEntry(0.86, false)).toBe(-1);
  });
});
