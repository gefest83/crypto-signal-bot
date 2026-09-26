import {
  EXIT_SLIPPAGE,
  MARKET_PROFILES,
  MIN_ORDER_SHARES,
  PM_LIMITS,
  TRADE_FEE_RATE,
} from "@/lib/strategy/maker-exit";

const RULES: { index: string; title: string; body: string; items?: { label: string; value: string }[] }[] =
  [
    {
      index: "01",
      title: "Направление не прогнозируется",
      body: "Проверено на 17277 настоящих 5-минутных раундах. На 80% срока лучший из предикторов — расстояние от открытия раунда — даёт точность ниже котировки рынка: ошибка меньше одного тика. Свечной движок убран из решений целиком.",
    },
    {
      index: "02",
      title: "Вход только лимитной заявкой",
      body: `Polymarket берёт с тейкера 7% × (1 − цена): при цене 0.30 это 4.9% ставки, то есть ровно величина перекоса, ради которого всё затевалось. Лимитная заявка этой комиссии не платит, но и не возвращает ничего — платит ${(TRADE_FEE_RATE * 100).toFixed(0)}% от стейка с каждой сделки, и платит дважды: на входе и на выходе.`,
      items: [
        { label: "Лимит 5m", value: PM_LIMITS[5].toFixed(2) },
        { label: "Лимит 15m", value: PM_LIMITS[15].toFixed(2) },
        { label: "Заявка", value: `от $${MIN_ORDER_SHARES * PM_LIMITS[5]} (${MIN_ORDER_SHARES} шар)` },
        { label: "Комиссия", value: `${(TRADE_FEE_RATE * 100).toFixed(0)}% × 2` },
      ],
    },
    {
      index: "03",
      title: "Сторона выбирается по цене, а не по прогнозу",
      body: "Мы ставим лимит на ту сторону, за которую рынок платит меньше. DOWN — точное дополнение UP, поэтому ровно один из двух ask всегда ниже 0.50, и лимит достижим на одной из сторон всегда.",
    },
    {
      index: "04",
      title: "Выход — это возврат к цене входа",
      body: "Пока позиция открыта, мы не продаём её «на всякий случай»: ниже лимита покупателя нет, и продать нечего. Выход срабатывает ровно тогда, когда bid возвращается к нашей цене. Это единственное место, где стратегия зарабатывает.",
      items: ([5, 15] as const).flatMap((interval) => {
        const profile = MARKET_PROFILES[interval];
        return [
          { label: `Возврат к лимиту ${profile.label}`, value: `${(profile.exitRate * 100).toFixed(0)}%` },
          {
            label: `Удержавшиеся берут ${profile.label}`,
            value: `${(profile.survivorWinRate * 100).toFixed(0)}%`,
          },
        ];
      }),
    },
    {
      index: "05",
      title: "Только настоящий стакан",
      body: "Gamma отдаёт котировку, отставшую на центы: на живом раунде в t+71с она показывала 0.52, пока стакан стоял на 0.15. Поэтому переходы считаются только по CLOB: набитие — это ask дошёл до лимита, выход — bid вернулся к лимиту. Mid не используется нигде.",
    },
    {
      index: "06",
      title: "Набитие требует проникновения, а не касания",
      body: "Заявка засчитывается взятой, только когда ask прошёл на тик ниже нашего лимита. Касание ничего не доказывает: в падающем рынке бьют биты, и заявка в конце очереди от касания не набирается. Выход проходит тем же порогом, хотя в бэктесте он засчитывался в момент касания.",
      items: [
        { label: "Источник", value: "CLOB Polymarket" },
        { label: "Опрос стакана", value: "каждые 3 с" },
        { label: "Порог набития", value: "1 тик за лимитом" },
        { label: "Стоимость выхода", value: `${(EXIT_SLIPPAGE * 100).toFixed(0)}ц` },
      ],
    },
    {
      index: "07",
      title: "Ничего не исполняется автоматически",
      body: "Ордера не отправляются и деньги не двигаются. Консоль держит виртуальные заявки на четырёх рынках по живому стакану и ведёт журнал, чтобы проверить главное допущение на настоящих данных. Это честнее, чем выдавать симуляцию за торговлю.",
      items: [
        { label: "Рынков", value: "4: BTC/ETH × 5m/15m" },
        { label: "Учёт", value: "раздельно и общий итог" },
        { label: "Минимум заявки", value: `${MIN_ORDER_SHARES} шар` },
      ],
    },
  ];

export function MakerRules() {
  return (
    <section className="surface border border-border p-5 sm:p-6">
      <header>
        <h2 className="text-sm font-semibold tracking-tight">Правила стратегии</h2>
        <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">
          Вход лимитом без тейкерской комиссии, выход при возврате цены к уровню входа.
          Направление не прогнозируется — на этих рынках его не прогнозирует никто, включая
          рынок. Работаем сразу на четырёх рынках (BTC и ETH, 5 и 15 минут), и считаем их
          раздельно: у 5м сделок больше, у 15м сделки качественнее, а среднее между ними не
          описывает ни один реальный рынок.
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
