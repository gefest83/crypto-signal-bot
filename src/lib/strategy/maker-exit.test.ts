import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIMIT,
  DEFAULT_STAKE_USD,
  EXIT_SLIPPAGE,
  LIMIT_MAX,
  LIMIT_MIN,
  MAKER_REBATE,
  MIN_STAKE_USD,
  STAKE_OPTIONS_USD,
  decideMakerAction,
  expectedPnlPerStake,
  makerPnl,
  planMakerTrade,
  requiredSurvivorWinRate,
  sharesForStake,
  stakeOutcomes,
  stakePnl,
} from "./maker-exit";

describe("рабочий диапазон лимита", () => {
  it("широкий, а не одна точка — иначе это подгонка", () => {
    expect(LIMIT_MIN).toBeLessThan(0.3);
    expect(LIMIT_MAX).toBeGreaterThan(0.5);
    expect(DEFAULT_LIMIT).toBeGreaterThan(LIMIT_MIN);
    expect(DEFAULT_LIMIT).toBeLessThan(LIMIT_MAX);
  });

  it("лимит по умолчанию — тот, что walk-forward выбирал каждую неделю", () => {
    expect(DEFAULT_LIMIT).toBe(0.35);
  });
});

describe("размер заявки в долларах, а не в шарах", () => {
  it("минимальный размер заявки — $1, и он же по умолчанию", () => {
    expect(MIN_STAKE_USD).toBe(1);
    expect(DEFAULT_STAKE_USD).toBe(1);
    expect(STAKE_OPTIONS_USD[0]).toBe(1);
  });

  it("$1 по лимиту 0.35 — это 2.86 шары, а не одна", () => {
    // Главная ошибка учёта: раньше юнитом считалась одна шара за 35 центов,
    // хотя Polymarket продаёт доллары и рискует весь стейк.
    expect(sharesForStake(1, 0.35)).toBeCloseTo(1 / 0.35, 10);
  });

  it("проигрыш стоит полный стейк, а не цену лимита", () => {
    // 2.86 шары × (−0.35) = −1.00
    expect(stakePnl(1, 0.35, false, false)).toBeCloseTo(-1 + MAKER_REBATE / 0.35, 10);
  });

  it("выигрыш приносит больше стейка, потому что шар больше доллара", () => {
    // 2.86 шары × 0.65 = +1.86
    expect(stakePnl(1, 0.35, true, false)).toBeCloseTo(1.857142857 + MAKER_REBATE / 0.35, 6);
  });

  it("выход в ноль стоит проскальзывания на каждый шар", () => {
    expect(stakePnl(1, 0.35, false, true)).toBeCloseTo(
      -EXIT_SLIPPAGE / 0.35 + MAKER_REBATE / 0.35,
      10,
    );
  });

  it("масштабируется линейно: $5 и $10 — ровно в 5 и 10 раз", () => {
    for (const won of [true, false]) {
      for (const exited of [true, false]) {
        expect(stakePnl(5, 0.35, won, exited)).toBeCloseTo(5 * stakePnl(1, 0.35, won, exited), 10);
        expect(stakePnl(10, 0.35, won, exited)).toBeCloseTo(10 * stakePnl(1, 0.35, won, exited), 10);
      }
    }
  });

  it("риск на сделку — это стейк, и он известен заранее", () => {
    const outcomes = stakeOutcomes(10, 0.35);
    // Проигрыш ограничен стейком и не может быть хуже.
    expect(outcomes.lost).toBeGreaterThan(-10.0001);
    expect(outcomes.won).toBeGreaterThan(0);
    // Выход всегда дешевле проигрыша.
    expect(outcomes.exited).toBeGreaterThan(outcomes.lost);
  });

  it("измеренный плюс переносится на $1 стейк без потери смысла", () => {
    // +2.1¢ на шару при 0.35 — это +6¢ на доллар стейка.
    expect(expectedPnlPerStake(1, 0.35)).toBeCloseTo(0.021 / 0.35, 10);
    expect(expectedPnlPerStake(1, 0.35)).toBeGreaterThan(0);
  });
});

describe("P&L по реальной цене", () => {
  it("мейкер не платит комиссию — платит только проскальзывание выхода", () => {
    // Закрытая по выходу сделка стоит ровно проскальзывание.
    expect(makerPnl(0.35, false, true)).toBeCloseTo(-EXIT_SLIPPAGE + MAKER_REBATE, 10);
  });

  it("удержавшаяся сделка платит полную ставку", () => {
    expect(makerPnl(0.35, false, false)).toBeCloseTo(-0.35 + MAKER_REBATE, 10);
    expect(makerPnl(0.35, true, false)).toBeCloseTo(0.65 + MAKER_REBATE, 10);
  });

  it("выход дороже, чем кажется, если считать от нуля", () => {
    // При лимите 0.35 «безубыточный» выход на деле стоит 2 цента.
    const plan = planMakerTrade("up", 0.35);
    expect(plan.roundTripCost).toBe(EXIT_SLIPPAGE);
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
});

describe("живое решение", () => {
  it("цена выше лимита — заявка стоит в стакане", () => {
    const d = decideMakerAction({ price: 0.5, holding: false });
    expect(d.action).toBe("rest");
    expect(d).toHaveProperty("limit", DEFAULT_LIMIT);
  });

  it("цена на лимите или ниже — не встаём впритык к спреду", () => {
    expect(decideMakerAction({ price: 0.34, holding: false }).action).toBe("wait");
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
    expect(decideMakerAction({ price: 0.42, holding: true }).action).toBe("exit");
  });

  it("у каждого решения есть объяснение", () => {
    for (const input of [
      { price: 0.5, holding: false },
      { price: 0.2, holding: false },
      { price: 0.35, holding: true },
      { price: 0.1, holding: true },
    ]) {
      expect(decideMakerAction(input).reason.length).toBeGreaterThan(10);
    }
  });
});
