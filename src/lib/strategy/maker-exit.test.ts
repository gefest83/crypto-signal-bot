import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIMIT,
  DEFAULT_STAKE_USD,
  EXIT_SLIPPAGE,
  LIMIT_MAX,
  LIMIT_MIN,
  MIN_ORDER_SHARES,
  MIN_STAKE_USD,
  MARKET_INTERVAL_MIN,
  STAKE_OPTIONS_USD,
  TRADE_FEE_RATE,
  decideMakerAction,
  expectedPnlPerStake,
  feePerShare,
  makerPnl,
  planMakerTrade,
  requiredSurvivorWinRate,
  sharesForStake,
  stakeOutcomes,
  stakePnl,
} from "./maker-exit";

describe("рабочий диапазон лимита", () => {
  it("широкий, а не одна точка — иначе это подгонка", () => {
    expect(LIMIT_MIN).toBeLessThan(0.45);
    expect(LIMIT_MAX).toBeGreaterThan(0.55);
    expect(DEFAULT_LIMIT).toBeGreaterThan(LIMIT_MIN);
    expect(DEFAULT_LIMIT).toBeLessThan(LIMIT_MAX);
  });

  it("лимит по умолчанию — тот, что walk-forward выбирал каждую неделю", () => {
    // 5m markets moved the optimum up from 0.35 to 0.50: the exit fires less
    // often on shorter rounds, so the limit has to be where a caught exit pays
    // more and a missed one costs more.
    expect(DEFAULT_LIMIT).toBe(0.5);
  });

  it("рынок именно 5-минутный — ради частоты сделок", () => {
    expect(MARKET_INTERVAL_MIN).toBe(5);
  });
});

describe("размер заявки в долларах, а не в шарах", () => {
  it("минимальный размер заявки биржи — 5 шар, а не $1", () => {
    // `min_order_size` в живом стакане считается в шарах. На лимите 0.50
    // это $2.50 стейка. Заявка на $1 была бы отклонена целиком, то есть
    // стратегия в том виде, в каком её считали, не исполнилась бы ни разу.
    expect(MIN_ORDER_SHARES).toBe(5);
    expect(MIN_STAKE_USD).toBeCloseTo(2.5, 10);
    expect(DEFAULT_STAKE_USD).toBe(5);
    expect(STAKE_OPTIONS_USD[0]).toBe(5);
  });

  it("ни один предложенный размер не меньше биржевого минимума", () => {
    for (const option of STAKE_OPTIONS_USD) {
      expect(sharesForStake(option, DEFAULT_LIMIT)).toBeGreaterThanOrEqual(MIN_ORDER_SHARES);
    }
  });

  it("$5 по лимиту 0.50 — это 10 шар", () => {
    expect(sharesForStake(5, 0.5)).toBeCloseTo(10, 10);
  });

  it("проигрыш стоит полный стейк плюс комиссия 2%", () => {
    // 10 шар × (−0.50) = −5.00, и сверху 2% от $5 = −0.10. Итого −5.10.
    expect(stakePnl(5, 0.5, false, false)).toBeCloseTo(-5.1, 10);
  });

  it("выигрыш тоже платит комиссию — она не возвращается при победе", () => {
    // 10 шар × 0.50 = +5.00, минус 2% от $5.
    expect(stakePnl(5, 0.5, true, false)).toBeCloseTo(5 - 0.1, 10);
  });

  it("выход в ноль стоит проскальзывания и комиссии вместе", () => {
    // 10 шар × 0.02 проскальзывание = $0.20, плюс 2% от $5 = $0.10. Итого $0.30.
    expect(stakePnl(5, 0.5, false, true)).toBeCloseTo(-0.3, 10);
  });

  it("комиссия считается от стейка, а не от шар", () => {
    // 2% от цены покупки одной шары = 1 цент на шар при лимите 0.50.
    expect(feePerShare(0.5)).toBeCloseTo(0.01, 10);
  });

  it("масштабируется линейно: $10 и $25 — ровно в 2 и 5 раз от $5", () => {
    for (const won of [true, false]) {
      for (const exited of [true, false]) {
        expect(stakePnl(10, 0.5, won, exited)).toBeCloseTo(2 * stakePnl(5, 0.5, won, exited), 10);
        expect(stakePnl(25, 0.5, won, exited)).toBeCloseTo(5 * stakePnl(5, 0.5, won, exited), 10);
      }
    }
  });

  it("риск на сделку — это стейк плюс комиссия, и он известен заранее", () => {
    const outcomes = stakeOutcomes(25, 0.5);
    // $25 проигрывается целиком плюс 2% = −25.50. Хуже не бывает.
    expect(outcomes.lost).toBeCloseTo(-25.5, 8);
    expect(outcomes.won).toBeGreaterThan(0);
    // Выход всегда дешевле проигрыша.
    expect(outcomes.exited).toBeGreaterThan(outcomes.lost);
  });

  it("измеренный плюс переносится на $5 стейк и остаётся плюсом", () => {
    // $5 при лимите 0.50 — это 10 шар. 0.020 × 10 = +$0.20, минус 2% от $5
    // = −$0.10. Итого +$0.10 на сделку, то есть +2% от стейка.
    const perStake = expectedPnlPerStake(5, 0.5);
    expect(perStake).toBeCloseTo(0.02 * sharesForStake(5, 0.5) - 0.1, 10);
    expect(perStake).toBeCloseTo(0.1, 10);
    expect(perStake).toBeGreaterThan(0);
  });
});

describe("P&L по реальной цене", () => {
  it("комиссия 2% вычитается из закрытой по выходу сделки", () => {
    expect(makerPnl(0.35, false, true)).toBeCloseTo(-EXIT_SLIPPAGE - 0.007, 10);
  });

  it("удержавшаяся сделка платит полную ставку и комиссию", () => {
    expect(makerPnl(0.35, false, false)).toBeCloseTo(-0.35 - 0.007, 10);
    expect(makerPnl(0.35, true, false)).toBeCloseTo(0.65 - 0.007, 10);
  });

  it("«безубыточный» выход на деле стоит 2.7 цента на шар", () => {
    const plan = planMakerTrade("up", 0.35);
    expect(plan.roundTripCost).toBeCloseTo(EXIT_SLIPPAGE + TRADE_FEE_RATE * 0.35, 10);
    expect(plan.breakevenExit).toBe(0.35);
    expect(plan.winnerPayoff).toBeCloseTo(0.65, 10);
  });
});

describe("сколько должны выигрывать удержавшиеся сделки", () => {
  it("требуемая доля побед ниже измеренной — запас есть", () => {
    const needed = requiredSurvivorWinRate(0.35, 0.91);
    // 9% закрытых по выходу сделок теряют по 2 цента; выигрыш покрывает их.
    expect(needed).toBeGreaterThan(0);
    expect(needed).toBeLessThan(planMakerTrade("up", 0.35).survivorWinRate);
  });

  it("чем выше лимит, тем больше нужно от удержавшихся — выигрыш меньше", () => {
    // У победителя остаётся 1 − limit, поэтому дорогой вход требует большей
    // доли правильных удержавшихся сделок, чтобы окупить выходы.
    expect(requiredSurvivorWinRate(0.55, 0.91)).toBeGreaterThan(requiredSurvivorWinRate(0.2, 0.91));
  });

  it("комиссия поднимает планку выше, чем было без неё", () => {
    // Закрытая сделка стоила 2 цента, теперь 2.7 — и требуемая доля побед
    // удержавшихся выросла ровно на треть. Запас до измеренных 76% огромный.
    const withFee = requiredSurvivorWinRate(0.35, 0.09);
    const withoutFee = ((1 - 0.09) * EXIT_SLIPPAGE) / (0.09 * (1 - 0.35));
    expect(withFee).toBeCloseTo(withoutFee * 1.35, 10);
    expect(withFee).toBeLessThan(planMakerTrade("up", 0.35).survivorWinRate);
  });
});  describe("живое решение", () => {
  it("цена выше лимита — заявка стоит в стакане", () => {
    const d = decideMakerAction({ price: 0.62, holding: false });
    expect(d.action).toBe("rest");
    expect(d).toHaveProperty("limit", DEFAULT_LIMIT);
  });

  it("цена на лимите или ниже — не встаём впритык к спреду", () => {
    expect(decideMakerAction({ price: 0.42, holding: false }).action).toBe("wait");
    expect(decideMakerAction({ price: DEFAULT_LIMIT, holding: false }).action).toBe("wait");
  });

  it("после набития лимита и возврата цены — выход", () => {
    const d = decideMakerAction({ price: DEFAULT_LIMIT, holding: true });
    expect(d.action).toBe("exit");
    expect(d).toHaveProperty("limit", DEFAULT_LIMIT);
  });

  it("после набития лимита, пока цена ниже — держим, выход ещё не сработал", () => {
    // Это главная ошибка, которую легко допустить: продать «просто потому что
    // мы в позиции». Выход — это возврат к цене входа, а не сам факт входа.
    expect(decideMakerAction({ price: 0.2, holding: true }).action).toBe("hold");
  });

  it("возврат выше лимита тоже считается выходом", () => {
    expect(decideMakerAction({ price: 0.62, holding: true }).action).toBe("exit");
  });

  it("у каждого решения есть объяснение", () => {
    for (const input of [
      { price: 0.62, holding: false },
      { price: 0.42, holding: false },
      { price: DEFAULT_LIMIT, holding: true },
      { price: 0.1, holding: true },
    ]) {
      expect(decideMakerAction(input).reason.length).toBeGreaterThan(10);
    }
  });
});
