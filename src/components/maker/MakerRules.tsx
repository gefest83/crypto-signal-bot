import {
  DEFAULT_LIMIT,
  EXIT_SLIPPAGE,
  LIMIT_MAX,
  LIMIT_MIN,
  MIN_STAKE_USD,
} from "@/lib/strategy/maker-exit";

const RULES: { index: string; title: string; body: string; items?: { label: string; value: string }[] }[] =
  [
    {
      index: "01",
      title: "Направление не прогнозируется",
      body: "Проверено на 5760 настоящих 15-минутных раундах. На 80% срока лучший из предикторов — расстояние от открытия раунда — даёт точность 93.2%, а рынок в этот момент ставит 94.0%. Ошибка меньше одного тика. Свечной движок убран из решений целиком.",
    },
    {
      index: "02",
      title: "Вход только лимитной заявкой",
      body: "Polymarket берёт с тейкера 7% × (1 − цена): при цене 0.30 это 4.9% ставки, то есть ровно величина перекоса, ради которого всё затевалось. Мейкер не платит ничего и получает 20% сборов обратно — поэтому весь перевес и есть вход без комиссии.",
      items: [
        { label: "Лимит", value: `${LIMIT_MIN}–${LIMIT_MAX}, рабочий ${DEFAULT_LIMIT.toFixed(2)}` },
        { label: "Заявка", value: `$${MIN_STAKE_USD} = ${(1 / DEFAULT_LIMIT).toFixed(2)} шар` },
        { label: "Комиссия тейкера при 0.30", value: "4.9%" },
        { label: "Комиссия мейкера", value: "0%" },
      ],
    },
    {
      index: "03",
      title: "Сторона выбирается по цене, а не по прогнозу",
      body: "Мы ставим лимит на ту сторону, за которую рынок платит больше. DOWN — точное дополнение UP, поэтому ровно один из двух ask всегда выше 0.50, и лимит 0.35 достижим всегда.",
    },
    {
      index: "04",
      title: "Выход — это возврат к цене входа",
      body: "Пока позиция открыта, мы не продаём её «на всякий случай»: ниже лимита покупателя нет, и продать нечего. Выход срабатывает ровно тогда, когда bid возвращается к нашей цене. Это единственное место, где стратегия зарабатывает.",
      items: [
        { label: "Возврат к лимиту", value: "91% случаев" },
        { label: "Удержавшиеся выигрывают", value: "76%" },
        { label: "Возврат удержавшихся", value: "9%" },
      ],
    },
    {
      index: "05",
      title: "Только настоящий стакан",
      body: "Gamma отдаёт котировку, отставшую на центы: на живом раунде в t+71с она показывала 0.52, пока стакан стоял на 0.15. Поэтому переходы считаются только по CLOB: набитие — это ask дошёл до лимита, выход — bid вернулся к лимиту. Mid не используется нигде.",
    },
    {
      index: "06",
      title: "Ничего не исполняется автоматически",
      body: "Ордера не отправляются. Консоль воспроизводит состояние стратегии по живому стакану и ведёт журнал, чтобы проверить главное допущение на настоящих данных. Это честнее, чем выдавать симуляцию за торговлю.",
      items: [
        { label: "Источник", value: "CLOB Polymarket" },
        { label: "Опрос стакана", value: "каждые 5 с" },
        { label: "Стоимость выхода", value: `${(EXIT_SLIPPAGE * 100).toFixed(0)}ц` },
      ],
    },
  ];

export function MakerRules() {
  return (
    <section className="surface border border-border p-5 sm:p-6">
      <header>
        <h2 className="text-sm font-semibold tracking-tight">Правила стратегии</h2>
        <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">
          Вход лимитом без комиссии, выход при возврате цены к уровню входа. Направление не
          прогнозируется — на этих рынках его не прогнозирует никто, включая рынок.
        </p>
      </header>

      <ol className="mt-5 flex flex-col gap-4">
        {RULES.map((rule) => (
          <li key={rule.index} className="flex gap-3">
            <span className="shrink-0 font-mono text-xs text-muted-foreground/70">
              {rule.index}
            </span>
            <div className="min-w-0">
              <h3 className="text-xs font-medium tracking-tight">{rule.title}</h3>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{rule.body}</p>
              {rule.items && (
                <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1">
                  {rule.items.map((item) => (
                    <div key={item.label} className="flex items-baseline gap-1.5">
                      <dt className="text-[10px] text-muted-foreground">{item.label}</dt>
                      <dd className="font-mono text-[11px]">{item.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
