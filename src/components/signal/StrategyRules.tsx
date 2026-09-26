type Rule = {
  index: string;
  title: string;
  body: string;
  items?: { label: string; value: string }[];
};

const RULES: Rule[] = [
  {
    index: "01",
    title: "Реальная цена вместо расчётной",
    body: "Раньше движок сам придумывал цену контракта формулой и по ней же показывал прибыль. На тех же раундах симулятор давал +24.6% на сделку, а реальный ask — около нуля. Теперь цена берётся из настоящего стакана Polymarket, и журнал считает P&L именно по ней.",
    items: [
      { label: "Источник цены", value: "стакан Polymarket" },
      { label: "Обновление котировки", value: "каждые 5 с" },
      { label: "Оценка исхода", value: "резолв рынка" },
    ],
  },
  {
    index: "02",
    title: "Угадывать направление — не вход в прибыль",
    body: "Свечной движок попадал в 75.5% раундов, но рынок брал за это 0.745 — ровно цена безубытка. За 15 дней на 8631 реальном раунде EV угадывания составил +1.0% ± 1.3%, то есть ноль. Направление рынок уже знает.",
  },
  {
    index: "03",
    title: "Единственный перекос, который пережил проверку",
    body: "Прогон 15 дней настоящих цен показал устойчивый перекос: рынок недооценивает почти решённые раунды и переоценивает лонгшоты. Покупка стороны с ask ≥ 0.80 даёт EV +1.9% при 1682 сделках, и +3.0%, если свечной движок смотрит в ту же сторону.",
    items: [
      { label: "Порог фаворита", value: "ask ≥ 0.80" },
      { label: "Попаданий при ask ≥ 0.80", value: "87.9%" },
      { label: "EV на сделку", value: "+1.9%" },
    ],
  },
  {
    index: "04",
    title: "Окно входа: 60–150 секунд",
    body: "До закрытия первой минуты в стакане только шум тиков. Дальше окно живёт 90 секунд: за это время фаворит обычно уже обозначился, но контракт ещё не превратился в лотерею.",
    items: [
      { label: "Первая минута закрыта (t ≥ 60 с)", value: "обязательно" },
      { label: "Окно входа 60–150 с", value: "вход разрешён" },
      { label: "После 150 секунд", value: "вход запрещён" },
    ],
  },
  {
    index: "05",
    title: "Свечной движок — только фильтр",
    body: "Шесть факторов по минутным свечам больше не назначают цену. Их единственная работа — не дать войти, когда они смотрят против фаворита рынка. Расхождение двух независимых читаний — единственный случай, который пропускается.",
    items: [
      { label: "Импульс 1м / 3м / 5м", value: "28%" },
      { label: "EMA 9 / EMA 21 (структура тренда)", value: "18%" },
      { label: "Отклонение от VWAP + наклон", value: "14%" },
      { label: "Поток тейкеров", value: "14%" },
      { label: "Отрыв от цены открытия раунда", value: "14%" },
      { label: "Ускорение импульса", value: "12%" },
    ],
  },
  {
    index: "06",
    title: "Честные ограничения",
    body: "Перевес +1.9% — это до спреда. Тик на этих рынках 0.01, то есть около 1.2% при цене 0.86, поэтому реальная часть сделки заметно меньше. Ликвидность отдельных раундов тонкая, и объём не масштабируется. Статистика 15 дней — это 2.4σ, а не гарантия.",
    items: [
      { label: "Тик / спред", value: "0.01" },
      { label: "Значимость на 15 днях", value: "2.4σ" },
      { label: "Источник исхода", value: "Chainlink" },
    ],
  },
  {
    index: "07",
    title: "Пропуск раунда — норма",
    body: "Фаворит есть примерно в трети раундов, а вход разрешён не в каждом из них. Отсутствие сделки — это позиция: журнал показывает среднюю реальную цену, чтобы перевес был виден рядом с ценой, по которой он и получен.",
  },
];

export function StrategyRules() {
  return (
    <section className="surface border border-border p-5 sm:p-6">
      <header>
        <h2 className="text-sm font-semibold tracking-tight">Правила стратегии</h2>
        <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">
          «Favourite Edge»: движок не угадывает направление — он покупает сторону,
          которую Polymarket уже считает фаворитом, но по цене ниже её реальной
          вероятности. Всё считается по настоящему стакану, без собственных
          оценок цены.
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
