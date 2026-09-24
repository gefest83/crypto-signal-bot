type Rule = {
  index: string;
  title: string;
  body: string;
  items?: { label: string; value: string }[];
};

const RULES: Rule[] = [
  {
    index: "01",
    title: "Вход только в первые 60 секунд",
    body: "Precision-режим не публикует сделку в mid или late фазе. Даже сильное движение после первой минуты не является входом: к этому моменту цена контракта уже успела среагировать.",
  },
  {
    index: "02",
    title: "Precision вместо высокой уверенности",
    body: "Для входа нужны одновременно: |score| от 0.22 до 0.40 без перегрева, confidence ≥ 55%, согласие ≥ 70%, минимум 4 из 6 факторов по направлению, режим normal и окно первых 60 секунд. Это резко сокращает число сделок, но убирает импульсные ложные входы.",
  },
  {
    index: "03",
    title: "Шесть факторов голосуют",
    body: "Итоговый перевес — взвешенная сумма независимых сигналов по 1-минутным свечам.",
    items: [
      { label: "Импульс 1м / 3м / 5м", value: "28%" },
      { label: "EMA 9 / EMA 21 (структура тренда)", value: "18%" },
      { label: "Отклонение от VWAP + наклон", value: "14%" },
      { label: "Поток тейкеров (доля агрессивных покупок)", value: "14%" },
      { label: "Отрыв от цены открытия раунда", value: "14%" },
      { label: "Ускорение импульса", value: "12%" },
    ],
  },
  {
    index: "04",
    title: "Фильтры качества",
    body: "Confidence не является вероятностью и не задаёт цену контракта. Вход разрешён только в early-фазе, при достаточном согласии факторов, нормальной волатильности и умеренном score; вероятность и max price рассчитываются отдельно.",
    items: [
      { label: "RSI(14) ≥ 76 или ≤ 24 — не догоняем растянутое движение", value: "×0.85" },
      { label: "Волатильность выше 1.7× медианы (рваный рынок)", value: "×0.86" },
      { label: "Волатильность ниже 0.55× медианы (затишье)", value: "×0.92" },
    ],
  },
  {
    index: "05",
    title: "Никаких входов после первой минуты",
    body: "После 60 секунд precision-сигнал может оставаться в интерфейсе как наблюдение, но не фиксируется как сделка и не пишется как исполненный вход в журнал.",
  },
  {
    index: "06",
    title: "Размер позиции и выход",
    body: "База — одна единица риска на вызов. Рваный рынок — минус 30% размера, растянутый RSI — минус 15%. Если отрыв от открытия раунда ушёл против вызова больше чем на 0.6 ATR, убыток фиксируется сразу, а не дожидается закрытия.",
  },
  {
    index: "07",
    title: "Пропуск раунда — тоже сделка",
    body: "Если перевеса нет, движок пишет «скип» и не заносит вызов в журнал. Точность считается только по реально опубликованным вызовам, поэтому дисциплина видна в статистике.",
  },
];

export function StrategyRules() {
  return (
    <section className="surface border border-border p-5 sm:p-6">
      <header>
        <h2 className="text-sm font-semibold tracking-tight">Правила стратегии</h2>
        <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">
          Стратегия «Early Push»: 5-минутный контракт Up/Down стоит дешёво только в
          самом начале раунда, поэтому вся работа движка — успеть оценить перевес
          раньше, чем цена контракта уедет.
        </p>
      </header>

      <div className="mt-5 grid gap-3 md:grid-cols-2">
        {RULES.map((rule) => (
          <article
            key={rule.index}
            className="rounded-xl border border-border/70 bg-muted/30 p-4"
          >
            <div className="flex items-baseline gap-2.5">
              <span className="font-mono text-[11px] text-muted-foreground">
                {rule.index}
              </span>
              <h3 className="text-sm font-medium">{rule.title}</h3>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              {rule.body}
            </p>
            {rule.items ? (
              <ul className="mt-3 flex flex-col gap-1.5 border-t border-border/60 pt-3">
                {rule.items.map((item) => (
                  <li
                    key={item.label}
                    className="flex items-baseline justify-between gap-3 text-xs"
                  >
                    <span className="text-muted-foreground">{item.label}</span>
                    <span className="shrink-0 font-mono text-foreground">
                      {item.value}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </article>
        ))}
      </div>
    </section>
  );
}
