import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAPER,
  EXIT_SLIPPAGE,
  canRestBuy,
  checkBuyFill,
  checkSellFill,
  closePosition,
  isQuoteStale,
  openPosition,
  quoteableSide,
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

  it("bid на тик выше лимита — выход исполняется, но на 2ц ниже уровня", () => {
    // Цена исполнения не равна лимиту: мы продаём В bid, который стоит под
    // восстановленным уровнем. Раньше здесь было ровно 0.48, и круг
    // возвращал стейк целиком.
    const d = checkSellFill(0.48, book({ bid: 0.49 }));
    expect(d.filled).toBe(true);
    if (d.filled) expect(d.fillPrice).toBeCloseTo(0.48 - EXIT_SLIPPAGE, 10);
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

describe("заявка должна уметь висеть в стакане, а не пересекать спред", () => {
  it("лимит на уровне ask или ниже ставить нельзя", () => {
    // Ровно этот баг стоил 32 одинаковых убытка по −$0.20: сторона выбиралась
    // дешёвой, её ask был НИЖЕ лимита, заявка пересекала спред и набиралась
    // мгновенно, а выход возвращал по той же цене. Итог — круг без события.
    expect(canRestBuy(0.5, 0.5).filled).toBe(false);
    expect(canRestBuy(0.5, 0.38).filled).toBe(false);
    expect(canRestBuy(0.5, 0.51).filled).toBe(true);
  });

  it("котируем дорогую сторону — только она может вместить лимит", () => {
    // DOWN — дополнение UP, поэтому ровно одна из двух сторон выше лимита.
    expect(quoteableSide(0.62, 0.5)).toBe("up");
    expect(quoteableSide(0.38, 0.5)).toBe("down");
    // Когда обе стороны ушли за лимит — раунд уже решён, торговать нечем.
    expect(quoteableSide(0.5, 0.5)).toBeNull();
  });

  it("ни одна из двух сторон не подходит, если ask == 0.50", () => {
    expect(quoteableSide(0.5, 0.5)).toBeNull();
  });
});

describe("выход платит проскальзывание, а не возвращает стейк", () => {
  it("продажа проходит на 2ц НИЖЕ восстановленного уровня", () => {
    // Вторая половина того же бага: выход засчитывался по цене входа, и
    // круг возвращал ровно стейк минус двойную комиссию.
    const d = checkSellFill(0.5, book({ bid: 0.51 }));
    expect(d.filled).toBe(true);
    if (d.filled) expect(d.fillPrice).toBeCloseTo(0.5 - EXIT_SLIPPAGE, 10);
  });

  it("круг на $5 по 0.50 стоит 30 центов, а не 20", () => {
    const position = openPosition(filledOrder({ price: 0.5, stake: 5 }), 5, 0.02)!;
    const closed = closePosition(position, 0.5 - EXIT_SLIPPAGE, 1_000_100, 0.02);
    // 10 шар × 0.48 = 4.80 против 5.00, минус 2% на входе и на выходе.
    expect(closed.pnl).toBeCloseTo(4.8 - 5 - 0.1 - 0.096, 10);
    expect(Math.abs(closed.pnl ?? 0)).toBeGreaterThan(0.25);
  });

  it("каждый круг стоит больше одной комиссии — иначе он не круг, а подарок", () => {
    // Минимально возможный убыток на круг обязан быть заметно больше 4%.
    for (const limit of [0.35, 0.5]) {
      const position = openPosition(filledOrder({ price: limit, stake: 5 }), 5, 0.02)!;
      const closed = closePosition(position, limit - EXIT_SLIPPAGE, 1_000_100, 0.02);
      expect(closed.pnl).toBeLessThan(-0.2);
    }
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
