import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { PaperSession, PaperState } from "@/hooks/use-paper-session";
import { PM_LIMITS, TRADE_FEE_RATE } from "@/lib/strategy/maker-exit";
import { ArrowDown, ArrowUp, CircleDot, Loader2, Target, X } from "lucide-react";

/** Where the contract would have to travel for each transition to fire. */
const STEPS: { state: PaperState; label: string; hint: string }[] = [
  { state: "quoting", label: "Заявка в стакане", hint: "bid стоит и ждёт продавца" },
  { state: "filled", label: "Набито, держим", hint: "ждём возврата к цене входа" },
  { state: "closing", label: "Выход", hint: "цена вернулась, продаём" },
  { state: "held", label: "Держали до расчёта", hint: "цена не возвращалась" },
];

const ACTIVE_INDEX: Partial<Record<PaperState, number>> = {
  quoting: 0,
  filled: 1,
  closing: 2,
  closed: 2,
  held: 3,
};

const usd = (v: number) => `${v < 0 ? "−" : "+"}$${Math.abs(v).toFixed(2)}`;

/**
 * One market's live virtual session.
 *
 * The bar is the entire strategy on one axis: our limit, and where the real
 * book is relative to it. What matters is not a direction — there is none —
 * but whether the price ever travels PAST the limit, because a price that
 * merely touches it leaves the order last in the queue and the fill does not
 * happen. That is why the limit line is drawn separately from the shading:
 * reaching the shaded region is not enough.
 */
export function MakerRound({
  label,
  session,
  now,
  end,
}: {
  label: string;
  session: PaperSession | undefined;
  now: number;
  end: number;
}) {
  const remaining = Math.max(0, end - now);
  const progress = Math.min(1, Math.max(0, 1 - remaining / (15 * 60_000)));
  const active = ACTIVE_INDEX[session?.state ?? "quoting"] ?? 0;
  const up = session?.side === "up";
  const SideIcon = up ? ArrowUp : ArrowDown;

  const limit = session?.limit ?? 0.5;
  const limitPct = limit * 100;
  const askPct = session?.ask != null ? session.ask * 100 : null;
  const bidPct = session?.bid != null ? session.bid * 100 : null;

  // One tick past the limit is where the fill is credited, so the bar has to
  // show where that threshold is, not just where the limit is.
  const fillPct = Math.min(100, (limit - 0.01) * 100);

  return (
    <Card>
      <CardContent className="flex flex-col gap-5 p-5 sm:p-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Target className="size-4" />
            </span>
            <div>
              <h2 className="text-sm font-semibold tracking-tight">
                {label} · лимит {session?.limit.toFixed(2) ?? "—"}
              </h2>
              <p className="text-[11px] text-muted-foreground">
                {session?.side ? (
                  <span className="inline-flex items-center gap-1">
                    <SideIcon className="size-3" />
                    сторона {session.side.toUpperCase()}
                  </span>
                ) : (
                  "ждём стакан"
                )}
                {session && (
                  <span className="ms-2 font-mono">
                    стейк ${session.stake} · {(session.stake / session.limit).toFixed(2)} шар
                  </span>
                )}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {session && (
              <Badge
                variant="outline"
                className={cn(
                  "font-mono text-[11px]",
                  session.state === "closed" && "border-amber-500/30 text-amber-500",
                  session.state === "filled" && "border-sky-500/30 text-sky-500",
                )}
              >
                {session.state}
              </Badge>
            )}
            <span className="font-mono text-xs tabular-nums text-muted-foreground">
              {Math.floor(remaining / 60_000)}:
              {String(Math.floor((remaining % 60_000) / 1000)).padStart(2, "0")}
            </span>
          </div>
        </header>

        {/* The whole strategy on one bar: the limit, and where the book is. */}
        <div>
          <div className="relative h-14 overflow-hidden rounded-lg border border-border/60 bg-card/40">
            <div
              className="absolute inset-y-0 left-0 bg-primary/15"
              style={{ width: `${limitPct}%` }}
            />
            {/* The band a price must cross, not reach, for the fill to count. */}
            <div
              className="absolute inset-y-0 w-px bg-primary"
              style={{ left: `${fillPct}%` }}
              title={`порог набития ${(limit - 0.01).toFixed(2)}`}
            />
            <div
              className="absolute inset-y-0 w-px bg-primary/70"
              style={{ left: `${limitPct}%` }}
              title={`наш лимит ${limit.toFixed(2)}`}
            />
            {askPct !== null && (
              <div
                className="absolute top-2 size-2.5 -translate-x-1/2 rounded-full bg-up"
                style={{ left: `${askPct}%` }}
                title={`ask ${session?.ask?.toFixed(2)}`}
              />
            )}
            {bidPct !== null && (
              <div
                className="absolute bottom-2 size-2.5 -translate-x-1/2 rounded-full bg-down"
                style={{ left: `${bidPct}%` }}
                title={`bid ${session?.bid?.toFixed(2)}`}
              />
            )}
            <span className="absolute top-1.5 left-2 font-mono text-[10px] text-muted-foreground">
              0.00
            </span>
            <span className="absolute top-1.5 right-2 font-mono text-[10px] text-muted-foreground">
              1.00
            </span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 text-[10px] text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <span className="size-2 rounded-full bg-up" /> ask{" "}
              {session?.ask?.toFixed(2) ?? "—"}
            </span>
            <span>
              набитие при ask ≤ {(limit - 0.01).toFixed(2)} · лимит {limit.toFixed(2)}
            </span>
            <span className="inline-flex items-center gap-1">
              bid {session?.bid?.toFixed(2) ?? "—"}
              <span className="size-2 rounded-full bg-down" />
            </span>
          </div>
        </div>

        {/* Round progress. */}
        <div className="h-1 overflow-hidden rounded-full bg-muted">
          <div className="h-full bg-primary/60" style={{ width: `${progress * 100}%` }} />
        </div>

        {/* The state machine. */}
        <ol className="grid gap-2 sm:grid-cols-4">
          {STEPS.map((step, index) => {
            const done = index < active;
            const current = index === active;
            return (
              <li
                key={step.state}
                className={cn(
                  "rounded-lg border px-3 py-2 transition-colors",
                  current
                    ? "border-primary/40 bg-primary/5"
                    : done
                      ? "border-border bg-card/30"
                      : "border-border/50 bg-card/20",
                )}
              >
                <div className="flex items-center gap-1.5">
                  {done ? (
                    <CircleDot className="size-3.5 text-emerald-500" />
                  ) : current ? (
                    <Loader2 className="size-3.5 animate-spin text-primary" />
                  ) : (
                    <X className="size-3.5 text-muted-foreground/40" />
                  )}
                  <span
                    className={cn(
                      "text-[11px] font-medium",
                      current ? "text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {step.label}
                  </span>
                </div>
                <p className="mt-0.5 text-[10px] leading-tight text-muted-foreground">
                  {step.hint}
                </p>
              </li>
            );
          })}
        </ol>

        <p className="rounded-lg border border-border/60 bg-card/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
          {session?.note ?? "Загрузка стакана…"}
        </p>

        {session?.shares != null && (
          <p className="font-mono text-[11px] text-muted-foreground">
            {session.shares.toFixed(2)} шар по {session.limit.toFixed(2)} · комиссия{" "}
            {((session.stake * TRADE_FEE_RATE) * 100).toFixed(1)}¢ на входе
          </p>
        )}

        {session?.pnl != null && (
          <p className="font-mono text-xs text-muted-foreground">
            P&amp;L на ${session.stake}:{" "}
            <span className={session.pnl >= 0 ? "text-emerald-500" : "text-rose-500"}>
              {usd(session.pnl)}
            </span>
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export { PM_LIMITS };
