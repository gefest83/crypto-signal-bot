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
  Handshake,
  Repeat,
  ShieldCheck,
  Target,
  Timer,
  Wallet,
} from "lucide-react";
import { useNavigate } from "react-router";

/** Why a plain limit order loses, and why the exit is the whole strategy. */
const MECHANISM = [
  {
    title: "Тейкер съедает перевес",
    body: "Polymarket берёт 7% × (1 − цена). При цене 0.30 это 4.9% ставки — ровно величина того перекоса, ради которого всё затевалось. Любая идея, купленная по рынку, умирает здесь.",
    icon: Banknote,
  },
  {
    title: "Мейкер платит ноль",
    body: "Лимитная заявка не пересекает спред и комиссию не платит. Тот же самый перекос перестаёт съедаться и становится всей прибылью.",
    icon: Wallet,
  },
  {
    title: "Вход убыточен. И это нормально",
    body: "Лимит набивается тем, кто прав: раунд проигрывает в −10.2 цента на сделку. Отбор не обойти — он и есть смысл лимитной заявки.",
    icon: ArrowDown,
  },
  {
    title: "Выход делает всю работу",
    body: "Контракт возвращается к цене входа в 91% случаев. В этот момент мы продаём и закрываем сделку почти в ноль, а убыток ограничен спредом, а не ставкой.",
    icon: Repeat,
  },
  {
    title: "Держатся только победители",
    body: "9% сделок не возвращаются к лимиту — именно они доходят до расчёта. И выигрывают в 76% случаев: вверх идёт тот, кто не откатился.",
    icon: ArrowUp,
  },
  {
    title: "Сторону выбирает цена",
    body: "Лимит ставится на ту сторону, за которую рынок платит больше. DOWN — точное дополнение UP, поэтому лимит 0.35 достижим всегда.",
    icon: Handshake,
  },
];

const ROUND_STEPS = [
  {
    time: "12:00:00",
    title: "Раунд открылся",
    body: "Контракт стоит около 0.50 с каждой стороны. Сторона выбрана: та, за которую платят больше.",
  },
  {
    time: "12:01:12",
    title: "Заявка в стакане",
    body: "Наш bid стоит на 0.35 и ждёт. Мы ничего не платим и ничего не рискуем, пока он там.",
  },
  {
    time: "12:04:31",
    title: "Ask дошёл до лимита",
    body: "Продавец исполнил нашу заявку. Позиция открыта — и мы её не держим из упрямства.",
  },
  {
    time: "12:07:02",
    title: "Цена вернулась к 0.35",
    body: "Bid снова на нашем уровне. Продаём, сделка закрыта за 2 цента против комиссии.",
  },
  {
    time: "12:14:00",
    title: "Расчёт",
    body: "Если цена так и не вернулась, держим до конца. Polymarket публикует результат, и он попадает в журнал.",
  },
];

const HONESTY = [
  {
    title: "Направление не прогнозируется",
    body: "На 80% срока раунда лучший предиктор — расстояние от открытия — даёт 93.2% точности. Рынок в этот момент ставит 94.0%. Ошибка меньше одного тика. Из десяти идей выжила одна, и она не про прогноз.",
    icon: Target,
  },
  {
    title: "Главное допущение не проверено",
    body: "Мы знаем, что цена возвращается к лимиту. Мы не знаем, что в этот момент кто-то перебил ставку. В падающем рынке биты бьют, а не офферы — и на этом стоит вся прибыль. Это первое, что проверяет консоль.",
    icon: AlertTriangle,
  },
  {
    title: "Ничего не исполняется автоматически",
    body: "Ордера не отправляются. Консоль воспроизводит состояние стратегии по живому стакану и ведёт журнал. Симуляцию, выданную за торговлю, мы уже проверяли — она врала в 15 раз.",
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

function MakerPreview() {
  return (
    <div className="surface relative overflow-hidden border border-border/70 bg-[linear-gradient(150deg,var(--primary-soft,var(--muted)),transparent_60%)] p-5 sm:p-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold tracking-tight">BTC</span>
          <span className="font-mono text-[11px] text-muted-foreground">12:00 – 12:15 UTC</span>
        </div>
        <Badge
          variant="outline"
          className="rounded-full border-sky-500/30 bg-sky-500/10 px-2.5 py-0.5 text-[10px] font-semibold tracking-wider text-sky-500"
        >
          ЗАЯВКА В СТАКАНЕ
        </Badge>
      </div>

      <div className="mt-6 flex items-center gap-5">
        <span className="relative flex size-14 items-center justify-center rounded-2xl border border-sky-500/25 bg-sky-500/10 text-sky-500">
          <span className="absolute inset-0 -z-10 animate-signal-pulse rounded-full bg-sky-500/25 blur-xl" />
          <Timer className="size-7" strokeWidth={2.4} />
        </span>
        <div>
          <p className="font-mono text-[3.25rem] leading-none font-semibold tracking-tight text-sky-500">
            0.35
          </p>
          <p className="mt-1.5 text-sm font-medium">Лимит на стороне UP</p>
        </div>
      </div>

      <div className="mt-6 grid grid-cols-3 gap-3">
        <div className="rounded-xl border border-border/70 bg-card/70 px-3 py-2.5">
          <p className="text-[10px] tracking-wider text-muted-foreground uppercase">Ask сейчас</p>
          <p className="mt-1 font-mono text-xl tabular-nums">0.62</p>
        </div>
        <div className="rounded-xl border border-border/70 bg-card/70 px-3 py-2.5">
          <p className="text-[10px] tracking-wider text-muted-foreground uppercase">Комиссия</p>
          <p className="mt-1 font-mono text-xl tabular-nums text-emerald-500">0%</p>
        </div>
        <div className="rounded-xl border border-border/70 bg-card/70 px-3 py-2.5">
          <p className="text-[10px] tracking-wider text-muted-foreground uppercase">Возврат</p>
          <p className="mt-1 font-mono text-xl tabular-nums">91%</p>
        </div>
      </div>

      <div className="mt-5">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div className="relative h-full w-[35%] overflow-hidden rounded-full bg-sky-500">
            <span className="absolute inset-y-0 w-14 animate-signal-sweep bg-[linear-gradient(90deg,transparent,var(--primary-foreground),transparent)] opacity-40" />
          </div>
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          Лимит в стакане · мы не платим комиссию и не держим позицию из упрямства
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
            <p className="text-sm leading-tight font-semibold tracking-tight">Maker Exit</p>
            <p className="truncate text-[11px] leading-tight text-muted-foreground">
              Вход без комиссии · выход в безубыток
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
              Polymarket · 15-минутные раунды Up/Down
            </span>
            <h1 className="mt-5 text-[2.5rem] leading-[1.05] font-semibold tracking-tight text-balance sm:text-5xl lg:text-[3.4rem]">
              Направление не угадать. Можно не платить комиссию и выйти в безубыток
            </h1>
            <p className="mt-5 max-w-xl text-sm leading-relaxed text-muted-foreground sm:text-base">
              Мы проверили 5760 настоящих 15-минутных раундов. Направление рынок
              знает лучше нас: на 80% срока лучший предиктор даёт 93.2%, а котировка —
              94.0%. Ошибка меньше тика. Зато перевес, который в этих раундах есть,
              съедала комиссия тейкера — целиком. Лимитная заявка её не платит, а
              выход по цене входа ограничивает убыток двумя центами.
            </p>

            <div className="mt-7 grid max-w-lg grid-cols-3 gap-3">
              {[
                { label: "P&L на сделку", value: "+2.1¢", tone: "text-emerald-500" },
                { label: "Проигрышных дней", value: "3 из 31" },
                { label: "Проверено раундов", value: "5760" },
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
            <MakerPreview />
          </motion.div>
        </div>
      </section>

      {/* mechanism */}
      <section id="mechanism" className="border-t border-border/60 py-20 sm:py-24">
        <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
          <SectionHeading
            eyebrow="Механизм"
            title="Почему вход убыточен, а стратегия зарабатывает"
            body="Это не прогноз и не сигнал. Это утверждение об исполнении: мы платим ноль комиссии, принимаем отрицательное качество входа как цену за право выйти без убытка."
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
            Maker Exit — вход лимитом без комиссии, выход в безубыток
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
