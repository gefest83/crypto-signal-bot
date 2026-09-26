import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { motion } from "framer-motion";
import {
  Activity,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  BarChart3,
  Clock,
  Gauge,
  ShieldCheck,
  Timer,
  Waves,
  Zap,
} from "lucide-react";
import { useNavigate } from "react-router";

const FACTORS = [
  {
    weight: "28%",
    title: "Импульс 1м / 3м / 5м",
    body: "Три горизонта доходности на 1-минутных свечах, нормированные на текущую волатильность.",
    icon: Activity,
  },
  {
    weight: "18%",
    title: "Структура EMA 9 / 21",
    body: "Разрыв быстрой и медленной средней показывает, стоит ли за движением тренд.",
    icon: BarChart3,
  },
  {
    weight: "14%",
    title: "Отклонение от VWAP",
    body: "Цена против средневзвешенной по объёму и наклон самой VWAP за последний час.",
    icon: Waves,
  },
  {
    weight: "14%",
    title: "Поток тейкеров",
    body: "Доля агрессивных покупок в объёме — кто именно исполняет по рынку прямо сейчас.",
    icon: Zap,
  },
  {
    weight: "14%",
    title: "Отрыв от открытия раунда",
    body: "Сколько цена уже прошла от референсной цены раунда — именно её контракт и сравнивает.",
    icon: Timer,
  },
  {
    weight: "12%",
    title: "Ускорение импульса",
    body: "Последняя минута против средней за три: движение разгоняется или выдыхается.",
    icon: Gauge,
  },
];

const TIMELINE = [
  {
    time: "12:04:58",
    title: "Подготовка",
    body: "Движок держит в памяти последние 200 минутных свечей и каждые 5 секунд перечитывает стакан Polymarket по текущему 5-минутному рынку.",
  },
  {
    time: "12:05:00",
    title: "Раунд открылся",
    body: "Реальный bid/ask по контракту уже есть, но входить рано: первая минута — это шум тиков, а не информация.",
  },
  {
    time: "12:06:00",
    title: "Первая минута закрыта",
    body: "Окно входа открылось. Стакан читается по-настоящему: UP 0.15/0.16, значит фаворит — DOWN с ask 0.85.",
  },
  {
    time: "12:06:04",
    title: "Вызов зафиксирован",
    body: "DOWN по реальному ask 0.85. Свечной движок смотрит в ту же сторону, расхождения нет. Запись уходит в журнал и больше не меняется.",
  },
  {
    time: "12:07:30",
    title: "Окно закрыто",
    body: "После 150-й секунды новые входы запрещены: контракт уже отражает движение, перевес уходит рынку.",
  },
  {
    time: "12:10:00",
    title: "Расчёт",
    body: "Резолв рынка публикует итог — он и записывается в журнал. P&L считается по той цене, по которой вызов реально был бы куплен.",
  },
];

const DISCIPLINE = [
  {
    title: "Цена из стакана, а не из формулы",
    body: "Раньше движок сам придумывал цену контракта и по ней же показывал прибыль: на одних и тех же раундах симулятор давал +24.6% на сделку, а реальный ask — около нуля. Теперь в журнал попадает только настоящая цена.",
    icon: ShieldCheck,
  },
  {
    title: "Окно входа 60–150 секунд",
    body: "До закрытия первой минуты в стакане только шум. Дальше 90 секунд, за которые фаворит обычно уже обозначился, но контракт ещё не превратился в лотерею.",
    icon: Clock,
  },
  {
    title: "Пропуск раунда — часть системы",
    body: "Явного фаворита бывает примерно в трети раундов, а порога в 0.80 достигают не все. Отсутствие сделки — тоже позиция, и она видна в статистике.",
    icon: ArrowDown,
  },
  {
    title: "Пропуск раунда не считается провалом",
    body: "Вызовы ниже порога не публикуются и не портят статистику. Отсутствие сделки — тоже позиция.",
    icon: Gauge,
  },
];

function BrandMark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "flex size-9 items-center justify-center rounded-xl bg-foreground text-background",
        className,
      )}
    >
      <ArrowUp className="size-4" strokeWidth={2.6} />
    </span>
  );
}

function SignalPreview() {
  return (
    <div className="surface relative overflow-hidden border border-up/25 bg-[linear-gradient(150deg,var(--up-soft),transparent_60%)] p-5 sm:p-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold tracking-tight">BTC</span>
          <span className="font-mono text-[11px] text-muted-foreground">
            12:05 – 12:10 UTC
          </span>
        </div>          <Badge
          variant="outline"
          className="rounded-full border-up/30 bg-up-soft px-2.5 py-0.5 text-[10px] font-semibold tracking-wider text-up-ink"
        >
          ОКНО ПОДТВЕРЖДЕНИЯ
        </Badge>
      </div>

      <div className="mt-6 flex items-center gap-5">
        <span className="relative flex size-14 items-center justify-center rounded-2xl border border-up/25 bg-up-soft text-up-ink">
          <span className="absolute inset-0 -z-10 animate-signal-pulse rounded-full bg-up/25 blur-xl" />
          <ArrowUp className="size-7" strokeWidth={2.6} />
        </span>
        <div>
          <p className="font-mono text-[3.25rem] leading-none font-semibold tracking-tight text-up">
            UP
          </p>
          <p className="mt-1.5 text-sm font-medium">Прогноз роста на 5 минут</p>
        </div>
      </div>

      <div className="mt-6 grid grid-cols-3 gap-3">
        <div className="rounded-xl border border-border/70 bg-card/70 px-3 py-2.5">
          <p className="text-[10px] tracking-wider text-muted-foreground uppercase">
            Уверенность
          </p>
          <p className="mt-1 font-mono text-xl tabular-nums">74%</p>
        </div>
        <div className="rounded-xl border border-border/70 bg-card/70 px-3 py-2.5">
          <p className="text-[10px] tracking-wider text-muted-foreground uppercase">
            Вход до
          </p>
          <p className="mt-1 font-mono text-xl tabular-nums">0.52</p>
        </div>
        <div className="rounded-xl border border-border/70 bg-card/70 px-3 py-2.5">
          <p className="text-[10px] tracking-wider text-muted-foreground uppercase">
            Отрыв
          </p>
          <p className="mt-1 font-mono text-xl tabular-nums">0.7 ATR</p>
        </div>
      </div>

      <div className="mt-5">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div className="relative h-full w-[38%] overflow-hidden rounded-full bg-primary">
            <span className="absolute inset-y-0 w-14 animate-signal-sweep bg-[linear-gradient(90deg,transparent,var(--primary-foreground),transparent)] opacity-40" />
          </div>
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          6 факторов согласованы · рваного рынка нет · вызов записан в журнал
        </p>
      </div>
    </div>
  );
}

function SectionHeading({
  eyebrow,
  title,
  body,
}: {
  eyebrow: string;
  title: string;
  body?: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.4, ease: "easeOut" }}
      className="max-w-2xl"
    >
      <p className="text-[11px] font-semibold tracking-[0.18em] text-primary uppercase">
        {eyebrow}
      </p>
      <h2 className="mt-3 text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
        {title}
      </h2>
      {body ? (
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{body}</p>
      ) : null}
    </motion.div>
  );
}

export default function Landing() {
  const navigate = useNavigate();

  const openConsole = () => navigate("/dashboard");
  const openAuth = () => navigate("/auth?returnTo=%2Fdashboard");

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-30 border-b border-border/70 bg-background/85 backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl items-center gap-3 px-4 py-3 sm:px-6">
          <BrandMark />
          <div className="min-w-0">
            <p className="text-sm leading-tight font-semibold tracking-tight">
              Favourite Edge
            </p>
            <p className="truncate text-[11px] leading-tight text-muted-foreground">
              Реальный стакан Polymarket · 5 минут · BTC и ETH
            </p>
          </div>
          <nav className="ms-6 hidden items-center gap-6 md:flex">
            {[
              { href: "#signal", label: "Сигнал" },
              { href: "#engine", label: "Движок" },
              { href: "#round", label: "Пример раунда" },
              { href: "#discipline", label: "Дисциплина" },
            ].map((item) => (
              <a
                key={item.href}
                href={item.href}
                className="text-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                {item.label}
              </a>
            ))}
          </nav>
          <div className="ms-auto flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="hidden sm:inline-flex"
              onClick={openAuth}
            >
              Войти
            </Button>
            <Button type="button" size="sm" onClick={openConsole}>
              Открыть сигнал
            </Button>
          </div>
        </div>
      </header>

      {/* hero */}
      <section className="relative overflow-hidden">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[440px] stripe-grid opacity-60" />
        <div className="pointer-events-none absolute -top-40 left-1/2 h-[520px] w-[900px] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,var(--primary),transparent)] opacity-[0.07]" />
        <div className="relative mx-auto grid w-full max-w-6xl items-center gap-12 px-4 pt-16 pb-20 sm:px-6 lg:grid-cols-[1.08fr_1fr] lg:pt-24 lg:pb-28">
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, ease: "easeOut" }}
          >
            <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-[11px] font-medium text-muted-foreground">
              <span className="size-1.5 animate-signal-pulse rounded-full bg-up" />
              Polymarket · 5-минутные раунды Up/Down
            </span>
            <h1 className="mt-5 text-[2.5rem] leading-[1.05] font-semibold tracking-tight text-balance sm:text-5xl lg:text-[3.4rem]">
              Не угадываем направление — покупаем фаворита, когда рынок его недоплачивает
            </h1>
            <p className="mt-5 max-w-xl text-sm leading-relaxed text-muted-foreground sm:text-base">
              Свечной движок попадал в 75.5% раундов — но рынок брал за это
              0.745, то есть ровно цену безубытка. На 8631 реальном раунде за 15
              дней выяснилось другое: рынок недооценивает почти решённые раунды.
              Покупка стороны с ask ≥ 0.80 даёт EV +1.9% при 1682 сделках, и
              +3.0%, если свечной движок смотрит в ту же сторону.
            </p>
            <div className="mt-7 flex flex-wrap items-center gap-3">
              <Button
                type="button"
                size="lg"
                className="gap-2"
                onClick={openConsole}
              >
                Открыть консоль сигнала
                <ArrowRight className="size-4" />
              </Button>
              <Button
                type="button"
                size="lg"
                variant="outline"
                onClick={() => {
                  document
                    .getElementById("engine")
                    ?.scrollIntoView({ behavior: "smooth" });
                }}
              >
                Как считает движок
              </Button>
            </div>
            <p className="mt-6 text-xs leading-relaxed text-muted-foreground">
              Публичные данные Binance · API-ключи не нужны · ордера не отправляются
            </p>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.1, ease: "easeOut" }}
            id="signal"
          >
            <SignalPreview />
          </motion.div>
        </div>
      </section>

      {/* why timing */}
      <section className="border-t border-border/70 bg-card/50">
        <div className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
          <SectionHeading
            eyebrow="Где на самом деле живёт перевес"
            title="Точность без учёта цены — обман"
            body="Угадывать направление по споту бессмысленно: цена контракта следует за спотом за доли секунды и уже содержит этот сигнал. Единственное, что осталось, — поведенческий перекос самого рынка, и его видно на настоящих ценах."
          />
          <div className="mt-10 grid gap-4 md:grid-cols-3">
            {[
              {
                title: "Точность съедается ценой",
                body: "Наш движок попадал в 75.5% раундов при средней цене 0.745 — это ноль в пределах погрешности. Симулятор показывал +24.6% на сделку, потому что цену придумывал он сам.",
                icon: Clock,
              },
              {
                title: "Фаворит недооценён",
                body: "Сторона с ask ≥ 0.80 выигрывала в 87.9% случаев при средней цене 0.860. Перекос устойчив: 4 из 5 временных блоков и оба актива в плюсе.",
                icon: Activity,
              },
              {
                title: "Пропуск раунда — часть системы",
                body: "Фаворит есть примерно в трети раундов, порог проходит не каждый. Журнал показывает среднюю реальную цену, чтобы перевес был виден рядом с ценой, по которой он и получен.",
                icon: ShieldCheck,
              },
            ].map((item, index) => (
              <motion.article
                key={item.title}
                initial={{ opacity: 0, y: 12 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-60px" }}
                transition={{ duration: 0.35, delay: index * 0.05 }}
                className="surface border border-border p-5"
              >
                <span className="flex size-10 items-center justify-center rounded-xl border border-border bg-muted text-foreground">
                  <item.icon className="size-5" />
                </span>
                <h3 className="mt-4 text-sm font-semibold tracking-tight">
                  {item.title}
                </h3>
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  {item.body}
                </p>
              </motion.article>
            ))}
          </div>
        </div>
      </section>

      {/* engine */}
      <section id="engine" className="scroll-mt-20">
        <div className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
          <SectionHeading
            eyebrow="Движок"
            title="Шесть факторов, два фильтра, один вызов"
            body="Каждый фактор даёт нормализованный голос в диапазоне от −1 до +1. Итоговый перевес — взвешенная сумма; фильтры срезают уверенность, если движение растянуто или рынок рваный."
          />
          <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {FACTORS.map((factor, index) => (
              <motion.article
                key={factor.title}
                initial={{ opacity: 0, y: 12 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-60px" }}
                transition={{ duration: 0.35, delay: index * 0.04 }}
                className="surface flex flex-col gap-3 border border-border p-5"
              >
                <div className="flex items-center justify-between">
                  <span className="flex size-9 items-center justify-center rounded-lg border border-border bg-muted">
                    <factor.icon className="size-4" />
                  </span>
                  <span className="font-mono text-xs text-muted-foreground">
                    вес {factor.weight}
                  </span>
                </div>
                <h3 className="text-sm font-semibold tracking-tight">
                  {factor.title}
                </h3>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {factor.body}
                </p>
              </motion.article>
            ))}
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div className="surface border border-warn/25 bg-warn-soft/40 p-5">
              <p className="text-[11px] font-semibold tracking-[0.16em] text-warn-ink uppercase">
                Фильтр 1 · растяжение
              </p>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                RSI(14) выше 76 или ниже 24 — уверенность умножается на 0.85: движок
                не догоняет уже отработанное движение.
              </p>
            </div>
            <div className="surface border border-warn/25 bg-warn-soft/40 p-5">
              <p className="text-[11px] font-semibold tracking-[0.16em] text-warn-ink uppercase">
                Фильтр 2 · режим волатильности
              </p>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                Волатильность выше 1.7× медианы — ×0.86 и минус 30% размера. Ниже
                0.55× медианы — ×0.92: узкий диапазон редко даёт цель.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* example round */}
      <section id="round" className="scroll-mt-20 border-y border-border/70 bg-card/50">
        <div className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
          <SectionHeading
            eyebrow="Пример раунда"
            title="Как выглядят пять минут от открытия до расчёта"
            body="Один реальный сценарий по шагам: от подготовки данных до записи в журнал."
          />
          <ol className="mt-10 flex flex-col">
            {TIMELINE.map((step, index) => (
              <motion.li
                key={step.time}
                initial={{ opacity: 0, x: -8 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true, margin: "-60px" }}
                transition={{ duration: 0.3, delay: index * 0.04 }}
                className="grid grid-cols-[auto_1fr] gap-5 pb-6 last:pb-0"
              >
                <div className="flex flex-col items-center">
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {step.time}
                  </span>
                  <span
                    className={cn(
                      "mt-2 flex size-7 items-center justify-center rounded-full border font-mono text-[10px]",
                      index < 4
                        ? "border-up/30 bg-up-soft text-up-ink"
                        : "border-border bg-muted text-muted-foreground",
                    )}
                  >
                    {index + 1}
                  </span>
                  {index < TIMELINE.length - 1 ? (
                    <span className="mt-2 w-px flex-1 bg-border" />
                  ) : null}
                </div>
                <div className="pt-0.5 pb-1">
                  <h3 className="text-sm font-semibold tracking-tight">
                    {step.title}
                  </h3>
                  <p className="mt-1.5 max-w-xl text-xs leading-relaxed text-muted-foreground">
                    {step.body}
                  </p>
                </div>
              </motion.li>
            ))}
          </ol>
        </div>
      </section>

      {/* discipline */}
      <section id="discipline" className="scroll-mt-20">
        <div className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
          <SectionHeading
            eyebrow="Риск и дисциплина"
            title="Правила, которые защищают от главной ошибки"
            body="Главная ошибка на 5-минутных рынках — войти поздно, потому что «уже точно видно». Эти правила запрещают такие сделки заранее."
          />
          <div className="mt-10 grid gap-3 sm:grid-cols-2">
            {DISCIPLINE.map((item, index) => (
              <motion.article
                key={item.title}
                initial={{ opacity: 0, y: 12 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-60px" }}
                transition={{ duration: 0.35, delay: index * 0.04 }}
                className="surface flex gap-4 border border-border p-5"
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted">
                  <item.icon className="size-4" />
                </span>
                <div>
                  <h3 className="text-sm font-semibold tracking-tight">
                    {item.title}
                  </h3>
                  <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                    {item.body}
                  </p>
                </div>
              </motion.article>
            ))}
          </div>
        </div>
      </section>

      {/* final CTA */}
      <section className="border-t border-border/70">
        <div className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
          <div className="surface relative overflow-hidden border border-border px-6 py-12 text-center sm:px-12 sm:py-16">
            <div className="pointer-events-none absolute inset-x-0 top-0 h-full stripe-grid opacity-50" />
            <div className="relative">
              <h2 className="text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
                Один вызов Up/Down на раунд — и журнал, который проверяет стратегию
              </h2>
              <p className="mx-auto mt-4 max-w-xl text-sm leading-relaxed text-muted-foreground">
                Консоль показывает перевес, цену входа, факторы и таймер до конца
                окна. Каждый вызов фиксируется и оценивается по реальному закрытию
                раунда.
              </p>
              <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
                <Button
                  type="button"
                  size="lg"
                  className="gap-2"
                  onClick={openConsole}
                >
                  Открыть консоль сигнала
                  <ArrowRight className="size-4" />
                </Button>
                <Button type="button" size="lg" variant="ghost" onClick={openAuth}>
                  Войти по email
                </Button>
              </div>
            </div>
          </div>
        </div>
      </section>

      <footer className="border-t border-border/70">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-4 py-8 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div className="flex items-center gap-3">
            <BrandMark className="size-7" />
            <span className="text-xs text-muted-foreground">
              Favourite Edge — сигнальная стратегия для 5-минутных рынков Polymarket
            </span>
          </div>
          <p className="max-w-md text-[11px] leading-relaxed text-muted-foreground">
            Не финансовая рекомендация. Ордера не отправляются: инструмент считает
            перевес и ведёт журнал вызовов.
          </p>
        </div>
      </footer>
    </div>
  );
}
