import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api } from "@/convex/_generated/api";
import { formatClock } from "@/lib/format";
import { pnlForEntry } from "@/lib/strategy/entry";
import { cn } from "@/lib/utils";
import { useMutation, useQuery } from "convex/react";
import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";

function OutcomeBadge({ outcome }: { outcome?: "win" | "loss" | "tie" }) {
  if (!outcome) {
    return (
      <Badge
        variant="outline"
        className="rounded-full border-warn/40 bg-warn-soft px-2 py-0.5 text-[10px] font-semibold text-warn-ink"
      >
        ждём
      </Badge>
    );
  }
  if (outcome === "win") {
    return (
      <Badge
        variant="outline"
        className="rounded-full border-up/30 bg-up-soft px-2 py-0.5 text-[10px] font-semibold text-up-ink"
      >
        в плюс
      </Badge>
    );
  }
  if (outcome === "loss") {
    return (
      <Badge
        variant="outline"
        className="rounded-full border-down/30 bg-down-soft px-2 py-0.5 text-[10px] font-semibold text-down-ink"
      >
        мимо
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="rounded-full border-border bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground"
    >
      ровно
    </Badge>
  );
}

const money = (value: number) => `${value > 0 ? "+" : ""}${value.toFixed(2)}`;

export function RoundHistory() {
  const stats = useQuery(api.signals.signalStats, {});
  const signals = useQuery(api.signals.recentSignals, { limit: 50 });
  const clearSignals = useMutation(api.signals.clearSignals);

  const rows = signals ?? [];
  const real = stats?.realTrades ?? 0;

  return (
    <section className="surface border border-border p-5 sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold tracking-tight">Журнал раундов</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Каждый вызов фиксируется один раз по реальному ask из стакана
            Polymarket и оценивается по резолву самого рынка. P&amp;L: при ставке
            $1 чистая прибыль равна 1 / цена − 1, проигрыш — −1.
          </p>
        </div>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="gap-2 text-muted-foreground"
              disabled={rows.length === 0}
            >
              <Trash2 className="size-3.5" />
              Очистить
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Очистить журнал?</AlertDialogTitle>
              <AlertDialogDescription>
                Все записанные вызовы и статистика будут удалены. Это не влияет на
                работу движка — следующие раунды запишутся заново.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Отмена</AlertDialogCancel>
              <AlertDialogAction onClick={() => void clearSignals({})}>
                Удалить всё
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </header>

      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-6">
        <div className="rounded-xl border border-border/70 bg-muted/40 px-4 py-3">
          <p className="text-[11px] tracking-wider text-muted-foreground uppercase">
            P&amp;L мейкер
          </p>
          <p
            className={cn(
              "mt-1 font-mono text-2xl font-semibold tabular-nums",
              (stats?.realPnl ?? 0) >= 0 ? "text-up-ink" : "text-down-ink",
            )}
          >
            {stats?.realPnl === undefined ? "—" : money(stats.realPnl)}
          </p>
          <p className="mt-1 text-[10px] text-muted-foreground">
            {real > 0 ? `${real} сделок · лимит, комиссии нет` : "пока нет сделок по стакану"}
          </p>
        </div>
        <div className="rounded-xl border border-border/70 bg-muted/40 px-4 py-3">
          <p className="text-[11px] tracking-wider text-muted-foreground uppercase">
            P&amp;L тейкер
          </p>
          <p
            className={cn(
              "mt-1 font-mono text-2xl font-semibold tabular-nums",
              (stats?.takerPnl ?? 0) >= 0 ? "text-up-ink" : "text-down-ink",
            )}
          >
            {stats?.takerPnl === undefined ? "—" : money(stats.takerPnl)}
          </p>
          <p className="mt-1 text-[10px] text-muted-foreground">
            пересечение спреда + комиссия 7%×(1−цена)
          </p>
        </div>
        <div className="rounded-xl border border-border/70 bg-muted/40 px-4 py-3">
          <p className="text-[11px] tracking-wider text-muted-foreground uppercase">
            Средняя цена
          </p>
          <p className="mt-1 font-mono text-2xl font-semibold tabular-nums">
            {stats?.avgAsk === null || stats?.avgAsk === undefined
              ? "—"
              : stats.avgAsk.toFixed(2)}
          </p>
          <p className="mt-1 text-[10px] text-muted-foreground">
            реальный ask, порог входа 0.80
          </p>
        </div>
        <div className="rounded-xl border border-border/70 bg-muted/40 px-4 py-3">
          <p className="text-[11px] tracking-wider text-muted-foreground uppercase">
            Точность
          </p>
          <p className="mt-1 font-mono text-2xl font-semibold tabular-nums">
            {stats?.winRate === null || stats?.winRate === undefined
              ? "—"
              : `${stats.winRate}%`}
          </p>
        </div>
        <div className="rounded-xl border border-border/70 bg-muted/40 px-4 py-3">
          <p className="text-[11px] tracking-wider text-muted-foreground uppercase">
            В плюс / мимо
          </p>
          <p className="mt-1 font-mono text-2xl font-semibold tabular-nums">
            <span className="text-up-ink">{stats?.wins ?? 0}</span>
            <span className="mx-1 text-muted-foreground/60">/</span>
            <span className="text-down-ink">{stats?.losses ?? 0}</span>
          </p>
        </div>
        <div className="rounded-xl border border-border/70 bg-muted/40 px-4 py-3">
          <p className="text-[11px] tracking-wider text-muted-foreground uppercase">
            Оценено
          </p>
          <p className="mt-1 font-mono text-2xl font-semibold tabular-nums">
            {stats?.resolved ?? 0}
          </p>
        </div>
      </div>

      {stats && stats.lastResults.length > 0 ? (
        <div className="mt-4 flex items-center gap-2">
          <span className="text-[11px] tracking-wider text-muted-foreground uppercase">
            последние
          </span>
          <div className="flex flex-wrap gap-1">
            {stats.lastResults.map((result, index) => (
              <span
                key={`${result}-${index}`}
                title={result}
                className={cn(
                  "size-2.5 rounded-full",
                  result === "win" && "bg-up",
                  result === "loss" && "bg-down",
                  result === "tie" && "bg-muted-foreground/40",
                )}
              />
            ))}
          </div>
        </div>
      ) : null}

      <div className="mt-5 overflow-hidden rounded-xl border border-border/70">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/40 hover:bg-muted/40">
              <TableHead className="text-[11px] tracking-wider uppercase">Раунд</TableHead>
              <TableHead className="text-[11px] tracking-wider uppercase">Актив</TableHead>
              <TableHead className="text-[11px] tracking-wider uppercase">Вызов</TableHead>
              <TableHead className="text-right text-[11px] tracking-wider uppercase">
                Ask / Bid
              </TableHead>
              <TableHead className="text-right text-[11px] tracking-wider uppercase">
                Источник
              </TableHead>
              <TableHead className="text-right text-[11px] tracking-wider uppercase">
                P&amp;L тейкер
              </TableHead>
              <TableHead className="text-right text-[11px] tracking-wider uppercase">
                Итог
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={7}
                  className="py-8 text-center text-sm text-muted-foreground"
                >
                  Журнал пуст. Первый вызов запишется, как только Polymarket
                  покажет фаворита дороже 0.80.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => {
                const ask = row.entryAsk ?? null;
                const bid = row.entryBid ?? null;
                const pnl =
                  row.outcome && ask
                    ? pnlForEntry(ask, row.outcome === "win", "taker")
                    : null;
                return (
                  <TableRow key={row._id}>
                    <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">
                      {formatClock(row.windowStart)} UTC
                    </TableCell>
                    <TableCell className="text-xs font-medium">
                      {row.symbol === "ETHUSDT" ? "ETH" : "BTC"}
                    </TableCell>
                    <TableCell>
                      <span
                        className={cn(
                          "inline-flex items-center gap-1 text-xs font-semibold",
                          row.direction === "up" ? "text-up-ink" : "text-down-ink",
                        )}
                      >
                        {row.direction === "up" ? (
                          <ArrowUp className="size-3.5" />
                        ) : (
                          <ArrowDown className="size-3.5" />
                        )}
                        {row.direction === "up" ? "UP" : "DOWN"}
                      </span>
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums">
                      {ask === null ? "—" : `${ask.toFixed(2)} / ${bid?.toFixed(2) ?? "—"}`}
                    </TableCell>
                    <TableCell className="text-right text-[11px] text-muted-foreground">
                      {ask === null ? "оценка" : "стакан"}
                    </TableCell>
                    <TableCell
                      className={cn(
                        "text-right font-mono text-xs tabular-nums",
                        pnl === null
                          ? "text-muted-foreground"
                          : pnl >= 0
                            ? "text-up-ink"
                            : "text-down-ink",
                      )}
                    >
                      {pnl === null ? "—" : money(pnl)}
                    </TableCell>
                    <TableCell className="text-right">
                      <OutcomeBadge outcome={row.outcome} />
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
