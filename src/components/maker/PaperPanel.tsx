import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { PaperJournalEntry, PaperSession, PaperTotals } from "@/hooks/use-paper-session";
import { MIN_STAKE_USD, TRADE_FEE_RATE } from "@/lib/strategy/maker-exit";
import { CircleDot, FlaskConical, Loader2, Minus, X } from "lucide-react";

const STATE_LABEL: Record<PaperSession["state"], string> = {
  quoting: "заявка в стакане",
  filled: "набито, держим",
  closing: "ждём выход",
  closed: "выход",
  held: "держали до расчёта",
  missed: "не набралась",
};

const ACTIVE: Partial<Record<PaperSession["state"], number>> = {
  quoting: 0,
  filled: 1,
  closing: 2,
  closed: 3,
  held: 3,
};

const usd = (v: number) => `${v < 0 ? "−" : "+"}$${Math.abs(v).toFixed(2)}`;

/**
 * The live virtual session.
 *
 * The screen is deliberately explicit about why it is stricter than the
 * backtest, because a number that looks better than its own assumptions is
 * worse than no number at all. Every fill shown here required the price to
 * move PAST the limit, not touch it — falling markets hit bids, and a resting
 * order last in the queue does not get filled by a price that merely arrives.
 */
export function PaperPanel({
  sessions,
  journal,
  totals,
  now,
  end,
  penetrationTicks,
}: {
  sessions: Partial<Record<string, PaperSession>>;
  journal: PaperJournalEntry[];
  totals: PaperTotals;
  now: number;
  end: number;
  penetrationTicks: number;
}) {
  const remaining = Math.max(0, end - now);
  const list = Object.values(sessions).filter(Boolean) as PaperSession[];

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <FlaskConical className="size-4" />
            Виртуальные сделки
          </CardTitle>
          <Badge variant="outline" className="font-mono text-[11px] text-muted-foreground">
            {Math.floor(remaining / 60_000)}:{String(Math.floor((remaining % 60_000) / 1000)).padStart(2, "0")}
            {" · "}
            проникновение {penetrationTicks} тик
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          {list.map((session) => {
            const step = ACTIVE[session.state] ?? 0;
            return (
              <div
                key={session.asset}
                className="rounded-lg border border-border/60 bg-card/40 px-3 py-2.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold uppercase">
                    {session.asset}
                    {session.side ? (
                      <span className="ms-2 font-mono text-muted-foreground">
                        {session.side.toUpperCase()} @ {session.limit.toFixed(2)}
                      </span>
                    ) : null}
                  </span>
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {STATE_LABEL[session.state]}
                  </span>
                </div>
                <div className="mt-2 flex items-center gap-1.5">
                  {[0, 1, 2, 3].map((i) => (
                    <span
                      key={i}
                      className={cn(
                        "h-1.5 flex-1 rounded-full",
                        i < step ? "bg-emerald-500/60" : i === step ? "bg-primary" : "bg-muted",
                      )}
                    />
                  ))}
                </div>
                <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                  {session.note}
                </p>
                {session.shares != null && (
                  <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                    {session.shares.toFixed(2)} шар · стейк ${session.stake}
                    {session.openedAfterMs != null &&
                      ` · вход на ${Math.floor(session.openedAfterMs / 1000)}с`}
                  </p>
                )}
                {session.pnl != null && (
                  <p
                    className={cn(
                      "mt-1 font-mono text-xs",
                      session.pnl >= 0 ? "text-emerald-500" : "text-rose-500",
                    )}
                  >
                    {usd(session.pnl)}
                  </p>
                )}
              </div>
            );
          })}
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Реализовано" value={usd(totals.realised)} tone={totals.realised >= 0 ? "up" : "down"} />
          <Stat label="Выходов" value={String(totals.closed)} />
          <Stat label="До расчёта" value={String(totals.held)} />
          <Stat
            label="Плюс / минус"
            value={`${totals.wins} / ${totals.losses}`}
          />
        </div>

        <p className="rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
          <span className="font-medium text-amber-500">Жёстче бэктеста по трём пунктам.</span> Набитие
          требует, чтобы ask прошёл на {penetrationTicks} тик ниже лимита, а не просто коснулся его:
          в падающем рынке биты выбивают биты, и заявка в конце очереди не набивается. Наполнение
          записывается по нашему лимиту, а не по цене, которой нас прошили. Выход проходит по тому
          же порогу — а в бэктесте он засчитывался в момент касания. Комиссия{" "}
          {(TRADE_FEE_RATE * 100).toFixed(0)}% от стейка платится дважды: на входе и на выходе.
          Минимальная заявка биржи — 5 шар, поэтому стейк от ${MIN_STAKE_USD} и риск на сделку
          вдвое выше того, что показывал прошлый расчёт.
        </p>

        {journal.length > 0 && (
          <ul className="flex flex-col divide-y divide-border/60">
            {journal.slice(0, 12).map((entry) => (
              <li key={entry.id} className="flex items-center gap-3 py-2 text-xs">
                <span className="w-11 shrink-0 font-mono text-muted-foreground">
                  {new Date(entry.roundStart * 1000).toLocaleTimeString("ru-RU", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
                <span className="w-9 shrink-0 font-mono uppercase">{entry.asset}</span>
                <span className="w-20 shrink-0 font-mono text-muted-foreground">
                  {entry.side ?? "—"} @ {entry.limit.toFixed(2)}
                </span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {STATE_LABEL[entry.state]}
                </span>
                <span
                  className={cn(
                    "shrink-0 font-mono",
                    entry.pnl == null
                      ? "text-muted-foreground"
                      : entry.pnl >= 0
                        ? "text-emerald-500"
                        : "text-rose-500",
                  )}
                >
                  {entry.pnl == null ? "—" : usd(entry.pnl)}
                </span>
              </li>
            ))}
          </ul>
        )}

        {journal.length === 0 && list.every((s) => s.state === "quoting") && (
          <p className="flex items-center justify-center gap-2 py-4 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Ждём набития. Заявки висят в стакане на {penetrationTicks}-тиковом проникновении.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" }) {
  return (
    <div className="rounded-lg border border-border/60 bg-card/40 px-3 py-2">
      <p className="text-[10px] tracking-wide text-muted-foreground uppercase">{label}</p>
      <p
        className={cn(
          "mt-0.5 font-mono text-sm",
          tone === "up" ? "text-emerald-500" : tone === "down" ? "text-rose-500" : "text-foreground",
        )}
      >
        {value}
      </p>
    </div>
  );
}

export { CircleDot, Minus, X };
