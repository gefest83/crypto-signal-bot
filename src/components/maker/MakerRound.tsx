import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { MakerPhase, MakerSession } from "@/hooks/use-maker-session";
import { DEFAULT_LIMIT, MARKET_INTERVAL_MIN } from "@/lib/strategy/maker-exit";
import { ArrowDown, ArrowUp, CircleDot, Loader2, Target, X } from "lucide-react";

const ROUND_MS = MARKET_INTERVAL_MIN * 60_000;

/** Where the contract would have to travel for each transition to fire. */
const STEPS: { phase: MakerPhase; label: string; hint: string }[] = [
  { phase: "armed", label: "Заявка в стакане", hint: "bid стоит и ждёт продавца" },
  { phase: "filled", label: "Набито, держим", hint: "ждём возврата к цене входа" },
  { phase: "exited", label: "Выход в ноль", hint: "цена вернулась к лимиту" },
  { phase: "held", label: "Держали до расчёта", hint: "цена не возвращалась" },
];

const ACTIVE_INDEX: Partial<Record<MakerPhase, number>> = {
  armed: 0,
  filled: 1,
  exited: 2,
  held: 3,
};

/**
 * The live state of one maker trade.
 *
 * The important thing this screen shows is not a direction — there is none. It
 * shows where the resting limit stands relative to the real book, and which of
 * the two transitions has fired. Everything on it is read from the live CLOB,
 * so a price that Gamma would quote stale is never used.
 */
export function MakerRound({
  asset,
  session,
  now,
  end,
}: {
  asset: string;
  session: MakerSession | undefined;
  now: number;
  end: number;
}) {
  const remaining = Math.max(0, end - now);
  const progress = 1 - remaining / ROUND_MS;
  const active = session ? (ACTIVE_INDEX[session.phase] ?? 0) : 0;
  const up = session?.side === "up";
  const SideIcon = up ? ArrowUp : ArrowDown;

  // Where our limit sits inside the 0-1 contract, as a bar position.
  const limitPct = (session?.limit ?? DEFAULT_LIMIT) * 100;
  const askPct = session?.ask != null ? session.ask * 100 : null;
  const bidPct = session?.bid != null ? session.bid * 100 : null;

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
                {asset} · лимит {session?.limit.toFixed(2) ?? "—"}
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
                    стейк ${session.stake} · {(1 / session.limit).toFixed(2)} шар
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
                  session.phase === "exited" && "border-amber-500/30 text-amber-500",
                  session.phase === "filled" && "border-sky-500/30 text-sky-500",
                )}
              >
                {session.phase}
              </Badge>
            )}
            <span className="font-mono text-xs tabular-nums text-muted-foreground">
              {Math.floor(remaining / 60_000)}:{String(Math.floor((remaining % 60_000) / 1000)).padStart(2, "0")}
            </span>
          </div>
        </header>

        {/* The whole strategy on one bar: the limit, and where the book is. */}
        <div>
          <div className="relative h-14 overflow-hidden rounded-lg border border-border/60 bg-card/40">
            <div
              className="absolute inset-y-0 left-0 bg-primary/15"
              style={{ width: `${Math.min(100, Math.max(0, limitPct))}%` }}
            />
            <div
              className="absolute inset-y-0 w-px bg-primary"
              style={{ left: `${limitPct}%` }}
              title={`наш лимит ${session?.limit.toFixed(2)}`}
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
          <div className="mt-1.5 flex items-center justify-between text-[10px] text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <span className="size-2 rounded-full bg-up" /> ask{" "}
              {session?.ask?.toFixed(2) ?? "—"}
            </span>
            <span>наш лимит {session?.limit.toFixed(2) ?? "—"}</span>
            <span className="inline-flex items-center gap-1">
              bid {session?.bid?.toFixed(2) ?? "—"}
              <span className="size-2 rounded-full bg-down" />
            </span>
          </div>
        </div>

        {/* Round progress. */}
        <div className="h-1 overflow-hidden rounded-full bg-muted">
          <div className="h-full bg-primary/60" style={{ width: `${Math.min(100, progress * 100)}%` }} />
        </div>

        {/* The state machine. */}
        <ol className="grid gap-2 sm:grid-cols-4">
          {STEPS.map((step, index) => {
            const done = index < active;
            const current = index === active;
            return (
              <li
                key={step.phase}
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
                <p className="mt-0.5 text-[10px] leading-tight text-muted-foreground">{step.hint}</p>
              </li>
            );
          })}
        </ol>

        <p className="rounded-lg border border-border/60 bg-card/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
          {session?.note ?? "Загрузка стакана Polymarket…"}
        </p>

        {session?.pnl != null && (
          <p className="font-mono text-xs text-muted-foreground">
            P&amp;L сделки на ${session.stake}:{" "}
            <span className={session.pnl >= 0 ? "text-emerald-500" : "text-rose-500"}>
              {session.pnl >= 0 ? "+" : "−"}$
              {Math.abs(session.pnl).toFixed(2)}
            </span>
          </p>
        )}
      </CardContent>
    </Card>
  );
}
