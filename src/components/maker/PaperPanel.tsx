import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { MarketStats, PaperSession, PaperState, PaperTotals } from "@/hooks/use-paper-session";
import { MARKET_PROFILES, MIN_ORDER_SHARES, TRADE_FEE_RATE } from "@/lib/strategy/maker-exit";
import { FlaskConical, Loader2, TrendingUp } from "lucide-react";

const STATE_LABEL: Record<PaperState, string> = {
  quoting: "заявка в стакане",
  filled: "набито, держим",
  closing: "ждём выход",
  closed: "выход",
  held: "держали до расчёта",
  missed: "не набралась",
};

const ACTIVE: Partial<Record<PaperState, number>> = {
  quoting: 0,
  filled: 1,
  closing: 2,
  closed: 3,
  held: 3,
};

const usd = (v: number) => `${v < 0 ? "−" : "+"}$${Math.abs(v).toFixed(2)}`;

/**
 * The live virtual session, per market and in total.
 *
 * Two things this screen is built to make impossible to get wrong:
 *
 *   1. EACH MARKET IS SCORED ON ITS OWN. 5m and 15m have opposite failure
 *      modes — 5m reverts less but its survivors are a coin flip, 15m reverts
 *      more and its survivors win 76% of the time. A single blended number
 *      would let a good 15m morning cover a bleeding 5m afternoon, which is
 *      exactly the mistake that hides a dying strategy.
 *
 *   2. THE TOTAL IS SHOWN, BUT NEXT TO THE PARTS. The sum is real money and
 *      it is the number that would land in a bank account, but it is only
 *      meaningful when you can see which of the four contributed it.
 *
 * Every fill on this screen required the price to move PAST the limit, not
 * touch it. A price that merely arrives leaves a resting order last in the
 * queue, and the backtest assumed otherwise everywhere it counted money.
 */
export function PaperPanel({
  sessions,
  perMarket,
  totals,
  now,
  penetrationTicks,
}: {
  sessions: Partial<Record<string, PaperSession>>;
  perMarket: MarketStats[];
  totals: PaperTotals;
  now: number;
  penetrationTicks: number;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <FlaskConical className="size-4" />
            Виртуальные сделки
          </CardTitle>
          <Badge variant="outline" className="font-mono text-[11px] text-muted-foreground">
            4 рынка · проникновение {penetrationTicks} тик
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {/* Per-market statistics, side by side. */}
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {perMarket.map((stats) => {
            const profile = MARKET_PROFILES[stats.interval];
            const session = sessions[stats.key];
            return (
              <div
                key={stats.key}
                className="rounded-lg border border-border/60 bg-card/40 px-3 py-2.5"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-xs font-semibold tracking-tight uppercase">
                    {stats.label}
                  </span>
                  <span className="font-mono text-[10px] text-muted-foreground">
                    лимит {profile.limit.toFixed(2)}
                  </span>
                </div>

                <p
                  className={cn(
                    "mt-1.5 font-mono text-lg tabular-nums",
                    stats.realised > 0
                      ? "text-emerald-500"
                      : stats.realised < 0
                        ? "text-rose-500"
                        : "text-muted-foreground",
                  )}
                >
                  {stats.fills > 0 ? usd(stats.realised) : "$0.00"}
                </p>

                <dl className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[10px] text-muted-foreground">
                  <div className="flex gap-1">
                    <dt>набито</dt>
                    <dd className="text-foreground">{stats.fills}</dd>
                  </div>
                  <div className="flex gap-1">
                    <dt>выходов</dt>
                    <dd className="text-foreground">{stats.exits}</dd>
                  </div>
                  <div className="flex gap-1">
                    <dt>до расчёта</dt>
                    <dd className="text-foreground">{stats.held}</dd>
                  </div>
                  <div className="flex gap-1">
                    <dt>не набилось</dt>
                    <dd className="text-foreground">{stats.missed}</dd>
                  </div>
                </dl>

                {stats.best != null && (
                  <p className="mt-1.5 font-mono text-[10px] text-muted-foreground">
                    лучшая {usd(stats.best)} · худшая {usd(stats.worst ?? 0)}
                  </p>
                )}

                {session && (
                  <div className="mt-2 flex items-center gap-1.5">
                    {[0, 1, 2, 3].map((i) => (
                      <span
                        key={i}
                        className={cn(
                          "h-1.5 flex-1 rounded-full",
                          i < (ACTIVE[session.state] ?? 0)
                            ? "bg-emerald-500/60"
                            : i === (ACTIVE[session.state] ?? 0)
                              ? "bg-primary"
                              : "bg-muted",
                        )}
                      />
                    ))}
                  </div>
                )}
                {session && (
                  <p className="mt-1.5 text-[10px] leading-tight text-muted-foreground">
                    {session.side ? `${session.side.toUpperCase()} · ` : ""}
                    {STATE_LABEL[session.state]}
                    {session.ask != null ? ` · ${session.ask.toFixed(2)}` : ""}
                  </p>
                )}
              </div>
            );
          })}
        </div>

        {/* The aggregate, presented as a sum of the four above it. */}
        <div className="rounded-lg border border-primary/25 bg-primary/5 px-3 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <TrendingUp className="size-4 text-primary" />
              <span className="text-xs font-semibold tracking-tight uppercase">
                Общий P&L по 4 рынкам
              </span>
            </div>
            <span
              className={cn(
                "font-mono text-xl tabular-nums",
                totals.realised > 0
                  ? "text-emerald-500"
                  : totals.realised < 0
                    ? "text-rose-500"
                    : "text-muted-foreground",
              )}
            >
              {totals.fills > 0 ? usd(totals.realised) : "$0.00"}
            </span>
          </div>
          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[11px] text-muted-foreground sm:grid-cols-4">
            <Row label="Сделок" value={String(totals.fills)} />
            <Row label="Выходов" value={String(totals.exits)} />
            <Row label="Плюс / минус" value={`${totals.wins} / ${totals.losses}`} />
            <Row
              label="Разброс"
              value={
                totals.best != null
                  ? `${usd(totals.worst ?? 0)} … ${usd(totals.best)}`
                  : "—"
              }
            />
          </dl>
          {totals.worst != null && totals.worst < 0 && (
            <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground/80">
              Худшая сделка — {usd(totals.worst)}: это полный стейк плюс комиссия, то есть риск
              на одну позицию. Он не растёт со временем, но и повторяется на каждой сделке без
              набития.
            </p>
          )}
        </div>

        <p className="rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
          <span className="font-medium text-amber-500">Жёстче бэктеста по трём пунктам.</span>{" "}
          Набитие требует, чтобы ask прошёл на {penetrationTicks} тик ниже лимита, а не просто
          коснулся его: в падающем рынке бьют биты, и заявка в конце очереди не набивается. Цена
          набития — наш лимит, а не та, которой нас прошили. Выход проходит тем же порогом, хотя
          в бэктесте он засчитывался в момент касания. Комиссия{" "}
          {(TRADE_FEE_RATE * 100).toFixed(0)}% от стейка платится дважды — на входе и на выходе.
          Минимум биржи — {MIN_ORDER_SHARES} шар, поэтому наименьший стейк $5, а риск на сделку
          $5.10, а не доллар.
        </p>

        {perMarket.every((s) => s.fills === 0) && (
          <p className="flex items-center justify-center gap-2 py-3 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Заявки висят в стакане на {penetrationTicks}-тиковом проникновении. Набитие будет
            засчитано, только когда цена пройдёт уровень, а не коснётся его. Обновлено {new Date(now).toLocaleTimeString("ru-RU")}.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt>{label}</dt>
      <dd className="text-foreground">{value}</dd>
    </div>
  );
}
