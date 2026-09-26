import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAPER,
  checkBuyFill,
  checkSellFill,
  closePosition,
  isQuoteStale,
  openPosition,
  sessionPnl,
  settlePosition,
  type BookSnapshot,
  type PaperOrder,
} from "./paper";

const book = (over: Partial<BookSnapshot> = {}): BookSnapshot => ({
  bid: 0.49,
  ask: 0.51,
  depthAtLimit: 0,
  now: 1_000_000,
  ...over,
});

const filledOrder = (over: Partial<PaperOrder> = {}): PaperOrder => ({
  id: "o1",
  side: "buy",
  price: 0.5,
  stake: 5,
  placedAt: 1_000_000,
  status: "filled",
  filledAt: 1_000_060,
  fillPrice: 0.5,
  reason: "",
  ...over,
});

describe("набитие лимита — контакт не считается набитием", () => {
  it("ask, коснувшийся лимита, НЕ набивает заявку", () => {
    // Это ровно то, что делал предыдущий консольный цикл, и именно из-за этого
    // его P&L нельзя было принимать. Цена дошла до нашего уровня, но никто в
    // нашу очередь не продал.
    const d = checkBuyFill(0.5, book({ ask: 0.5 }));
    expect(d.filled).toBe(false);
  });

  it("ровно один тик проникновения — набивает, это и есть порог", () => {
    // Продавец, взявший 0.49, дошёл до нашей очереди на 0.50 и прошёл её.
    const d = checkBuyFill(0.5, book({ ask: 0.49 }));
    expect(d.filled).toBe(true);
  });

  it("набивает по нашему лимиту, а не по той цене, которой нас прошили", () => {
    // Разница между 0.48 и 0.50 — это $0.20 на позицию. Взять худшую цену
    // значит нарисовать себе убыток, которого не было.
    const d = checkBuyFill(0.5, book({ ask: 0.48 }));
    expect(d.filled).toBe(true);
    if (d.filled) expect(d.fillPrice).toBe(0.5);
  });

  it("при нулевом проникновении поведение возвращается к оптимистичному", () => {
    // Явно выбранный нестрогий режим: полезно, чтобы увидеть разницу, но
    // режимом по умолчанию быть не должен.
    const d = checkBuyFill(0.5, book({ ask: 0.5 }), {
      ...DEFAULT_PAPER,
      penetrationTicks: 0,
    });
    expect(d.filled).toBe(true);
  });

  it("пустой стакан не набивает ничего", () => {
    expect(checkBuyFill(0.5, book({ ask: null })).filled).toBe(false);
  });

  it("в каждом решении есть причина", () => {
    const d = checkBuyFill(0.5, book({ ask: 0.5 }));
    expect("reason" in d && d.reason.length).toBeGreaterThan(10);
  });
});

describe("выход проходит по тому же правилу", () => {
  it("bid, вернувшийся ровно к лимиту, не считается выходом", () => {
    // Бэктест зарабатывал здесь всё. Контакт — не выход.
    const d = checkSellFill(0.48, book({ bid: 0.48 }));
    expect(d.filled).toBe(false);
  });

  it("bid на тик выше лимита — выход исполняется", () => {
    const d = checkSellFill(0.48, book({ bid: 0.49 }));
    expect(d.filled).toBe(true);
    if (d.filled) expect(d.fillPrice).toBe(0.48);
  });

  it("symметрия: вход и выход требуют одинакового проникновения", () => {
    // Асимметрия здесь была бы подгонкой: вход строгий, выход нет.
    const loose = { ...DEFAULT_PAPER, penetrationTicks: 0 };
    expect(checkBuyFill(0.5, book({ ask: 0.5 }), loose).filled).toBe(
      checkSellFill(0.5, book({ bid: 0.5 }), loose).filled,
    );
  });
});

describe("висящая заявка устаревает", () => {
  it("старая заявка снимается — она уже не та ликвидность", () => {
    expect(isQuoteStale(1_000_000, 1_000_000 + DEFAULT_PAPER.maxQuoteAgeMs - 1)).toBe(false);
    expect(isQuoteStale(1_000_000, 1_000_000 + DEFAULT_PAPER.maxQuoteAgeMs + 1)).toBe(true);
  });
});

describe("P&L виртуальной позиции", () => {
  it("вход без выхода стоит весь стейк плюс комиссию", () => {
    const position = openPosition(filledOrder(), 5, 0.02)!;
    expect(position.shares).toBeCloseTo(10, 10);
    const closed = settlePosition(position, false, 1_000_100, 0.02);
    // −5 стейк, минус 2% на вход, и ничего не вернулось.
    expect(closed.pnl).toBeCloseTo(-5.1, 10);
  });

  it("выход в ноль стоит спред плюс две комиссии, а не ноль", () => {
    const position = openPosition(filledOrder(), 5, 0.02)!;
    const closed = closePosition(position, 0.49, 1_000_100, 0.02);
    // 10 шар × 0.49 = 4.90 против 5.00 стейка, минус 2% на вход и на выход.
    expect(closed.pnl).toBeCloseTo(4.9 - 5 - 0.1 - 0.098, 10);
    expect(closed.pnl).toBeLessThan(0);
  });

  it("комиссия платится и на выигрыше тоже", () => {
    const position = openPosition(filledOrder(), 5, 0.02)!;
    const won = settlePosition(position, true, 1_000_100, 0.02);
    // 10 шар платят 10, минус стейк и комиссия на вход.
    expect(won.pnl).toBeCloseTo(10 - 5 - 0.1, 10);
  });

  it("закрытая позиция и позиция до расчёта считаются раздельно", () => {
    const position = openPosition(filledOrder(), 5, 0.02)!;
    const exited = closePosition(position, 0.49, 1_000_100, 0.02);
    const second = openPosition(filledOrder({ id: "o2" }), 5, 0.02)!;
    const held = settlePosition(second, true, 1_000_100, 0.02);
    const totals = sessionPnl([exited, held]);
    expect(totals.closed).toBe(1);
    expect(totals.held).toBe(1);
    expect(totals.realised).toBeCloseTo((exited.pnl ?? 0) + (held.pnl ?? 0), 10);
  });

  it("открытая позиция в итог не попадает", () => {
    const open = openPosition(filledOrder(), 5, 0.02)!;
    const totals = sessionPnl([open]);
    expect(totals.realised).toBe(0);
    expect(totals.closed + totals.held).toBe(0);
  });
});

describe("виртуальный режим честнее бэктеста, а не наоборот", () => {
  it("каждое правило может только ухудшить результат", () => {
    // Набитие по контакту (старый консольный стандарт) против проникновения.
    const contact = checkBuyFill(0.5, book({ ask: 0.5 }), {
      ...DEFAULT_PAPER,
      penetrationTicks: 0,
    });
    const penetrated = checkBuyFill(0.5, book({ ask: 0.5 }), DEFAULT_PAPER);
    expect(contact.filled).toBe(true);
    expect(penetrated.filled).toBe(false);
  });

  it("комиссия уменьшает P&L на каждом исходе, а не добавляет", () => {
    const position = openPosition(filledOrder(), 5, 0.02)!;
    const withFee = closePosition(position, 0.49, 1_000_100, 0.02).pnl ?? 0;
    const withoutFee = closePosition(position, 0.49, 1_000_100, 0).pnl ?? 0;
    expect(withFee).toBeLessThan(withoutFee);
  });
});
