import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { motion } from "framer-motion";
import {
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Banknote,
  CircleDollarSign,
  Repeat,
  ShieldCheck,
  Target,
  Timer,
  Wallet,
} from "lucide-react";
import { useNavigate } from "react-router";

/** How the rule works and what it has to beat. */
const MECHANISM = [
  {
    title: "Решение на +20 секунде",
    body: "Ровно в двадцатую секунду раунда берётся поток тайкер-покупок за 30 секунд до неё. Сторону задаёт знак дисбаланса, а движение цены за эти же 20 секунд обязано с ним совпадать.",
    icon: Timer,
  },
  {
    title: "Дисбаланс, а не доля",
    body: "Формула 2·buy/vol − 1 центрирована на нуле. Первая версия считала просто buy/vol — это доля с центром 0.5, и на пороге 0.25 ветка DOWN не срабатывала ни разу. Сигнал был прибит к одной стороне.",
    icon: Banknote,
  },
  {
    title: "Гейт отсекает шум",
    body: "Сделка не открывается, если цена за 20 секунд сдвинулась меньше чем на 2 базисных пункта. Но сам гейт не доказан: +3.5 п.п. при z = 0.85, то есть неотличимо от случайности.",
    icon: Wallet,
  },
  {
    title: "Рынок уже откалиброван",
    body: "Цена на +15 секунде предсказывает исход с точностью ±3 п.п. по всем бакетам: 0.5 → 49.0%, 0.6 → 59.3%. Значит попадание выше рынка — не подарок, а противоречие.",
    icon: Repeat,
  },
  {
    title: "Комиссия — это и есть преимущество",
    body: "200bps с каждой стороны плюс тик спреда — вот что сигнал обязан перекрыть. Круг, закрытый по той же цене, минус всегда. Поэтому P&L по mid-цене здесь обманчив.",
    icon: ArrowDown,
  },
  {
    title: "Проверяем на том, что можно купить",
    body: "Книга закрытого рынка пуста, истории исполненных сделок нет. Единственный честный источник — наблюдать стакан вживую ровно в момент, когда вход был возможен.",
    icon: ArrowUp,
  },
];

const ROUND_STEPS = [
  {
    time: "12:00:00",
    title: "Раунд открылся",
    body: "Стартовая цена фиксируется как точка отсчёта. Дальше важна не она сама, а движение за первые 20 секунд.",
  },
  {
    time: "12:00:20",
    title: "Считаем поток",
    body: "Суммируем тайкер-покупки за окно (t−30с, t]. Дисбаланс 2·buy/vol − 1 должен превысить 0.25 по модулю.",
  },
  {
    time: "12:00:20",
    title: "Сверяем знаки",
    body: "Движение цены за 20 секунд должно совпадать по знаку с дисбалансом. Расхождение — HOLD, без исключений.",
  },
  {
    time: "12:00:20",
    title: "Отсекаем плоский шум",
    body: "Если |ret20| меньше 2бп, сделка не открывается. Цена почти не двигалась — таймерный поток в это время ничего не значит.",
  },
  {
    time: "12:00:20",
    title: "Проверяем цену входа",
    body: "Спрос не выше 0.60 на BTC и 0.70 на ETH. Дороже — не входим: на такой цене ошибка съедает весь перевес.",
  },
  {
    time: "12:05:00",
    title: "Расчёт",
    body: "Победитель получает $1 за шар. Правило записывается в журнал вместе с тем ask, который был в момент решения.",
  },
];

const HONESTY = [
  {
    title: "Направление не прогнозируется",
    body: "На 80% срока раунда лучший предиктор — расстояние от открытия — даёт 93.2% точности. Рынок в этот момент ставит 94.0%. Ошибка меньше одного тика. Из десяти идей выжила одна, и она не про прогноз.",
    icon: Target,
  },
  {
    title: "Прибыль не установлена",
    body: "Направление настоящее, деньги — вопрос открытый. Рынок уже откалиброван, поэтому покупка по mid-цене даст правдоподобный P&L из чистого артефакта измерения. Показывать его было бы враньём с красивым числом.",
    icon: AlertTriangle,
  },
  {
    title: "Ничего не исполняется автоматически",
    body: "Ордера не отправляются. Консоль считает решение по живому стакану и пишет в архив снимки цен. Симуляцию, выданную за торговлю, мы уже проверяли — она врала в 15 раз.",
    icon: ShieldCheck,
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
      <CircleDollarSign className="size-4" strokeWidth={2.6} />
    </span>
  );
}

function SignalPreview() {
  return (
    <div className="surface relative overflow-hidden border border-border/70 bg-[linear-gradient(150deg,var(--primary-soft,var(--muted)),transparent_60%)] p-5 sm:p-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold tracking-tight">BTC</span>
          <span className="font-mono text-[11px] text-muted-foreground">Up/Down 5m</span>
        </div>
        <Badge
          variant="outline"
          className="rounded-full border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 text-[10px] font-semibold tracking-wider text-emerald-500"
        >
          РЕШЕНИЕ ПРИНЯТО
        </Badge>
      </div>

      <div className="mt-6 flex items-center gap-5">
        <span className="relative flex size-14 items-center justify-center rounded-2xl border border-emerald-500/25 bg-emerald-500/10 text-emerald-500">
          <span className="absolute inset-0 -z-10 animate-signal-pulse rounded-full bg-emerald-500/25 blur-xl" />
          <Timer className="size-7" strokeWidth={2.4} />
        </span>
        <div>
          <p className="font-mono text-[3.25rem] leading-none font-semibold tracking-tight text-emerald-500">
            UP
          </p>
          <p className="mt-1.5 text-sm font-medium">+20с от старта раунда</p>
        </div>
      </div>

      <div className="mt-6 grid grid-cols-3 gap-3">
        <div className="rounded-xl border border-border/70 bg-card/70 px-3 py-2.5">
          <p className="text-[10px] tracking-wider text-muted-foreground uppercase">Дисбаланс</p>
          <p className="mt-1 font-mono text-xl tabular-nums">+0.27</p>
        </div>
        <div className="rounded-xl border border-border/70 bg-card/70 px-3 py-2.5">
          <p className="text-[10px] tracking-wider text-muted-foreground uppercase">ret20</p>
          <p className="mt-1 font-mono text-xl tabular-nums">+3.9бп</p>
        </div>
        <div className="rounded-xl border border-border/70 bg-card/70 px-3 py-2.5">
          <p className="text-[10px] tracking-wider text-muted-foreground uppercase">Цена входа</p>
          <p className="mt-1 font-mono text-xl tabular-nums">0.50</p>
        </div>
      </div>

      <div className="mt-5">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div className="relative h-full w-[58%] overflow-hidden rounded-full bg-emerald-500">
            <span className="absolute inset-y-0 w-14 animate-signal-sweep bg-[linear-gradient(90deg,transparent,var(--primary-foreground),transparent)] opacity-40" />
          </div>
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          Правило поймало 65.5% против монетки (z ≈ 7). Зарабатывает ли — проверяется на живых
          котировках, а не на mid.
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
            <p className="text-sm leading-tight font-semibold tracking-tight">RetMag</p>
            <p className="truncate text-[11px] leading-tight text-muted-foreground">
              Дисбаланс потока · BTC/ETH Up/Down 5m
            </p>
          </div>
          <nav className="ms-6 hidden items-center gap-6 md:flex">
            {[
              { href: "#mechanism", label: "Механизм" },
              { href: "#round", label: "Раунд" },
              { href: "#discipline", label: "Честность" },
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
              Открыть консоль
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
              Сигнал, который ловит направление. И вопрос, зарабатывает ли он
            </h1>
            <p className="mt-5 max-w-xl text-sm leading-relaxed text-muted-foreground sm:text-base">
              Дисбаланс тайкер-потока на 20-й секунде раунда совпадает с исходом в
              65.5% случаев на BTC и 67.7% на ETH — против монетки это z ≈ 7, не шум.
              Дальше начинается сложное: рынок откалиброван с точностью ±3 п.п., поэтому
              попадание выше рыночной цены — не преимущество, а противоречие. Мы не
              показываем прибыль, потому что её пока не на чем считать: P&L по mid-цене
              здесь обманчив. Мы собираем живые котировки, на которых это можно проверить.
            </p>

            <div className="mt-7 grid max-w-lg grid-cols-3 gap-3">
              {[
                { label: "Попаданий BTC", value: "65.5%", tone: "text-emerald-500" },
                { label: "Против монетки", value: "z ≈ 7" },
                { label: "Проверено раундов", value: "576" },
              ].map((stat) => (
                <div
                  key={stat.label}
                  className="surface rounded-xl border border-border/70 px-3 py-2.5"
                >
                  <p className="text-[10px] tracking-wider text-muted-foreground uppercase">
                    {stat.label}
                  </p>
                  <p className={cn("mt-1 font-mono text-lg tabular-nums", stat.tone)}>
                    {stat.value}
                  </p>
                </div>
              ))}
            </div>

            <div className="mt-7 flex flex-wrap items-center gap-3">
              <Button type="button" onClick={openConsole} className="gap-2">
                Открыть консоль
                <ArrowRight className="size-4" />
              </Button>
              <Button type="button" variant="outline" onClick={openAuth}>
                Войти и смотреть раунды
              </Button>
            </div>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.1, ease: "easeOut" }}
          >
            <SignalPreview />
          </motion.div>
        </div>
      </section>

      {/* mechanism */}
      <section id="mechanism" className="border-t border-border/60 py-20 sm:py-24">
        <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
          <SectionHeading
            eyebrow="Механизм"
            title="Как принимается решение и что ему надо перекрыть"
            body="Правило смотрит на поток тайкер-покупок за 30 секунд до 20-й секунды раунда и требует, чтобы движение цены подтвердило его знаком. Дальше остаётся economics: 200bps комиссии с обеих сторон — это и есть тот перевес, который сигнал обязан превзойти."
          />

          <div className="mt-12 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
            {MECHANISM.map((item, index) => (
              <motion.article
                key={item.title}
                initial={{ opacity: 0, y: 12 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-60px" }}
                transition={{ duration: 0.35, delay: (index % 3) * 0.06, ease: "easeOut" }}
                className="surface rounded-2xl border border-border/70 p-5"
              >
                <span className="flex size-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  <item.icon className="size-4" />
                </span>
                <h3 className="mt-4 text-sm font-semibold tracking-tight">{item.title}</h3>
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{item.body}</p>
              </motion.article>
            ))}
          </div>
        </div>
      </section>

      {/* round */}
      <section id="round" className="border-t border-border/60 py-20 sm:py-24">
        <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
          <SectionHeading
            eyebrow="Раунд"
            title="Один раунд, шаг за шагом"
            body="Всё, что происходит, видно в консоли на настоящем стакане. Ни одного перехода по отставшей котировке."
          />

          <ol className="mt-12 flex flex-col gap-0">
            {ROUND_STEPS.map((step, index) => (
              <motion.li
                key={step.time}
                initial={{ opacity: 0, x: -8 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true, margin: "-60px" }}
                transition={{ duration: 0.3, delay: index * 0.05, ease: "easeOut" }}
                className="flex gap-5 border-l border-border/70 py-4 pl-5 last:pb-0"
              >
                <span className="font-mono text-xs text-muted-foreground">{step.time}</span>
                <div className="min-w-0">
                  <h3 className="text-sm font-medium tracking-tight">{step.title}</h3>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    {step.body}
                  </p>
                </div>
              </motion.li>
            ))}
          </ol>
        </div>
      </section>

      {/* discipline */}
      <section id="discipline" className="border-t border-border/60 py-20 sm:py-24">
        <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
          <SectionHeading
            eyebrow="Честность"
            title="Что проверено, а что нет"
            body="Проект живёт тем, что недоконченные части названы своими именами. Иначе через две недели мы бы снова искали прибыль там, где её нет."
          />

          <div className="mt-12 grid gap-5 lg:grid-cols-3">
            {HONESTY.map((item, index) => (
              <motion.article
                key={item.title}
                initial={{ opacity: 0, y: 12 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-60px" }}
                transition={{ duration: 0.35, delay: index * 0.06, ease: "easeOut" }}
                className="surface rounded-2xl border border-border/70 p-5"
              >
                <span className="flex size-9 items-center justify-center rounded-xl bg-muted text-foreground">
                  <item.icon className="size-4" />
                </span>
                <h3 className="mt-4 text-sm font-semibold tracking-tight">{item.title}</h3>
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{item.body}</p>
              </motion.article>
            ))}
          </div>
        </div>
      </section>

      {/* cta */}
      <section className="border-t border-border/60 py-20 sm:py-24">
        <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
          <div className="surface rounded-3xl border border-border/70 px-6 py-14 text-center sm:px-12">
            <h2 className="mx-auto max-w-2xl text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
              Стратегия, которая честно показывает свою уязвимость
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-sm leading-relaxed text-muted-foreground">
              Консоль ведёт журнал по живому стакану, чтобы проверить единственное
              допущение, на котором держится весь перевес. Если оно не выдержит —
              вы увидите это первым, а не через месяц.
            </p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <Button type="button" onClick={openAuth} className="gap-2">
                Начать наблюдение
                <ArrowRight className="size-4" />
              </Button>
              <Button type="button" variant="outline" onClick={openConsole}>
                Открыть консоль
              </Button>
            </div>
          </div>
        </div>
      </section>

      <footer className="border-t border-border/60 py-8">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-center gap-2 px-4 text-center sm:px-6">
          <p className="text-xs text-muted-foreground">
            RetMag — дисбаланс тайкер-потока на BTC/ETH Up/Down 5m
          </p>
          <p className="max-w-2xl text-[11px] leading-relaxed text-muted-foreground/80">
            Все расчёты сделаны по настоящим ценам Polymarket. Ордера не исполняются
            автоматически, а стратегия не является инвестиционной рекомендацией.
          </p>
        </div>
      </footer>
    </div>
  );
}
