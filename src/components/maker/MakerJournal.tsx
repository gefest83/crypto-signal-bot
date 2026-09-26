import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { MakerLogEntry } from "@/hooks/use-maker-session";
import { History } from "lucide-react";

const LABEL: Record<MakerLogEntry["phase"], string> = {
  armed: "заявка стояла",
  filled: "не закрыта",
  exited: "выход в ноль",
  held: "держали до расчёта",
  missed: "лимит не набит",
};

/**
 * Closed maker trades, graded on Polymarket's own published result.
 *
 * A trade that was given back at its entry price is shown as a flat round trip,
 * not as a loss. That distinction is the whole strategy, and flattening it here
 * would be the same accounting error the backtest nearly shipped.
 */
export function MakerJournal({ log }: { log: MakerLogEntry[] }) {
  const closed = log.filter((entry) => entry.phase === "exited" || entry.phase === "held");
  const total = closed.reduce((sum, entry) => sum + (entry.pnl ?? 0), 0);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <History className="size-4" />
            Журнал сделок
          </CardTitle>
          {closed.length > 0 && (
            <span className="font-mono text-xs text-muted-foreground">
              {closed.length} закрыто ·{" "}
              <span className={total >= 0 ? "text-emerald-500" : "text-rose-500"}>
                {total >= 0 ? "+" : ""}
                {(total * 100).toFixed(1)}¢
              </span>
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {log.length === 0 ? (
          <p className="py-6 text-center text-xs leading-relaxed text-muted-foreground">
            Закрытых раундов пока нет. Журнал заполняется, когда лимит набирается и сделка
            закрывается — в среднем один раунд каждые 15 минут на актив.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-border/60">
            {log.map((entry) => {
              const when = new Date(entry.roundStart * 1000);
              return (
                <li key={entry.id} className="flex items-center gap-3 py-2.5 text-xs">
                  <span className="w-11 shrink-0 font-mono text-muted-foreground">
                    {when.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}
                  </span>
                  <span className="w-9 shrink-0 font-mono uppercase">
                    {entry.asset}
                    <span className="ml-1 text-muted-foreground">{entry.side ?? "—"}</span>
                  </span>
                  <span className="w-16 shrink-0 font-mono text-muted-foreground">
                    {entry.limit.toFixed(2)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {LABEL[entry.phase]}
                  </span>
                  <span
                    className={`shrink-0 font-mono ${
                      entry.pnl == null
                        ? "text-muted-foreground"
                        : entry.pnl >= 0
                          ? "text-emerald-500"
                          : "text-rose-500"
                    }`}
                  >
                    {entry.pnl == null
                      ? "—"
                      : `${entry.pnl >= 0 ? "+" : ""}${(entry.pnl * 100).toFixed(1)}¢`}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
