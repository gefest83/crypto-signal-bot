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
import { formatClock, formatPrice } from "@/lib/format";
import { isMarketSymbol, SYMBOL_META } from "@/lib/market/types";
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

export function RoundHistory() {
  const stats = useQuery(api.signals.signalStats, {});
  const signals = useQuery(api.signals.recentSignals, { limit: 50 });
  const clearSignals = useMutation(api.signals.clearSignals);

  const rows = signals ?? [];

  return (
    <section className="surface border border-border p-5 sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold tracking-tight">Журнал раундов</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Каждый вызов фиксируется один раз и оценивается по реальному закрытию
            раунда. P&L считается по сохранённому лимиту цены контракта.
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

      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-5">
        <div className="rounded-xl border border-border/70 bg-muted/40 px-4 py-3">
          <p className="text-[11px] tracking-wider text-muted-foreground uppercase">
            Общий P&L
          </p>
          <p
            className={cn(
              "mt-1 font-mono text-2xl font-semibold tabular-nums",
              (stats?.totalPnl ?? 0) >= 0 ? "text-up-ink" : "text-down-ink",
            )}
          >
            {stats?.totalPnl === undefined
              ? "—"
              : `${stats.totalPnl > 0 ? "+" : ""}${stats.totalPnl.toFixed(2)}`}
          </p>
          <p className="mt-1 text-[10px] text-muted-foreground">
            {stats?.pnlReturnPct === null || stats?.pnlReturnPct === undefined
              ? "по лимиту входа"
              : `${stats.pnlReturnPct > 0 ? "+" : ""}${stats.pnlReturnPct}% · по лимиту входа`}
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
        <div className="rounded-xl border border-border/70 bg-muted/40 px-4 py-3">
          <p className="text-[11px] tracking-wider text-muted-foreground uppercase">
            Ждут оценки
          </p>
          <p className="mt-1 font-mono text-2xl font-semibold tabular-nums">
            {stats?.pending ?? 0}
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
              <TableHead className="text-[11px] tracking-wider uppercase">
                Раунд
              </TableHead>
              <TableHead className="text-[11px] tracking-wider uppercase">
                Актив
              </TableHead>
              <TableHead className="text-[11px] tracking-wider uppercase">
                Вызов
              </TableHead>
              <TableHead className="text-right text-[11px] tracking-wider uppercase">
                Увер.
              </TableHead>
              <TableHead className="text-right text-[11px] tracking-wider uppercase">
                Цена контракта
              </TableHead>
              <TableHead className="text-right text-[11px] tracking-wider uppercase">
                Откр. → закр.
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
                  Журнал пуст. Первый вызов запишется, как только появится перевес.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => {
                const asset = isMarketSymbol(row.symbol)
                  ? SYMBOL_META[row.symbol].asset
                  : row.symbol;
                return (
                  <TableRow key={row._id}>
                    <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">
                      {formatClock(row.windowStart)} UTC
                    </TableCell>
                    <TableCell className="text-xs font-medium">{asset}</TableCell>
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
                      {row.confidence}%
                    </TableCell>
                    <TableCell
                      className="text-right font-mono text-xs tabular-nums"
                      title="Лимит цены контракта, рассчитанный при фиксации сигнала"
                    >
                      {(row.entryLimitPrice ?? row.maxEntryPrice).toFixed(2)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                      {formatPrice(row.referencePrice)}
                      {row.closePrice ? ` → ${formatPrice(row.closePrice)}` : ""}
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
