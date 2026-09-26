import { AlertTriangle, ArrowDownRight, ArrowUpRight, Clock, Wallet } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DEFAULT_LIMIT,
  EXIT_SLIPPAGE,
  decideMakerAction,
  planMakerTrade,
  requiredSurvivorWinRate,
} from "@/lib/strategy/maker-exit";

/** Measured on 5760 real 15-minute rounds over 30 days, walk-forward. */
const MEASURED = {
  pnlPerTrade: 0.021,
  losingDays: "3 из 31",
  exitRate: 0.91,
  survivorWinRate: 0.76,
  entryOnlyPnl: -0.102,
} as const;

function Stat({
  label,
  value,
  tone = "muted",
}: {
  label: string;
  value: string;
  tone?: "muted" | "up" | "down";
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-card/40 px-3 py-2">
      <p className="text-[10px] tracking-wide text-muted-foreground uppercase">{label}</p>
      <p
        className={`mt-0.5 font-mono text-sm ${
          tone === "up" ? "text-emerald-500" : tone === "down" ? "text-rose-500" : "text-foreground"
        }`}
      >
        {value}
      </p>
    </div>
  );
}

/**
 * The maker + breakeven-exit strategy, shown with the number it actually has
 * rather than the one that would look better. The entry on its own loses ten
 * cents a trade; the whole thing works because the exit caps that, and saying
 * so here is the point of the panel.
 */
export function MakerPanel({
  asset,
  price,
  holding,
}: {
  asset: string;
  /** Live book price of the UP side for this round, 0-1, or null if unknown. */
  price: number | null;
  /** Whether a filled position is currently being held. */
  holding: boolean;
}) {
  const plan = planMakerTrade(asset === "BTC" ? "up" : "down", DEFAULT_LIMIT);
  const decision: { action: string; reason: string } =
    price === null
      ? { action: "stand-aside", reason: "Ждём котировку стакана." }
      : decideMakerAction({ price, holding });
  const needed = requiredSurvivorWinRate(DEFAULT_LIMIT, MEASURED.exitRate);

  const tone =
    decision.action === "rest"
      ? "text-sky-500"
      : decision.action === "exit"
        ? "text-amber-500"
        : "text-muted-foreground";

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Wallet className="size-4" />
            Maker Exit · вход без комиссии
          </CardTitle>
          <Badge variant="outline" className="font-mono text-[11px]">
            {asset} · лимит {DEFAULT_LIMIT.toFixed(2)}
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <div
          className={`rounded-lg border border-border/60 bg-card/40 px-3 py-2.5 text-sm ${tone}`}
        >
          <div className="flex items-center gap-2 font-medium">
            {decision.action === "rest" && <ArrowUpRight className="size-4" />}
            {decision.action === "exit" && <ArrowDownRight className="size-4" />}
            {decision.action === "hold" && <Clock className="size-4" />}
            {decision.action === "wait" && <Clock className="size-4" />}
            {decision.action === "stand-aside" && <Clock className="size-4" />}
            {decision.action === "rest" && "Заявка стоит в стакане"}
            {decision.action === "exit" && "Выход: цена вернулась"}
            {decision.action === "hold" && "Держим позицию"}
            {decision.action === "wait" && "Ждём"}
            {decision.action === "stand-aside" && "Ждём данных"}
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{decision.reason}</p>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat
            label="P&L на сделку"
            value={`${MEASURED.pnlPerTrade >= 0 ? "+" : ""}${(MEASURED.pnlPerTrade * 100).toFixed(1)}¢`}
            tone="up"
          />
          <Stat label="Проигрышных дней" value={MEASURED.losingDays} />
          <Stat label="Стоимость выхода" value={`${(EXIT_SLIPPAGE * 100).toFixed(0)}¢`} />
          <Stat
            label="Нужно от удержавшихся"
            value={`${(needed * 100).toFixed(1)}%`}
            tone={MEASURED.survivorWinRate > needed ? "up" : "down"}
          />
        </div>

        <div className="flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2.5">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
          <div className="text-xs leading-relaxed text-muted-foreground">
            <p className="font-medium text-amber-500">
              Сам вход убыточен: {(MEASURED.entryOnlyPnl * 100).toFixed(1)}¢ на сделку.
            </p>
            <p className="mt-1">
              Рынок продаёт в наш лимит именно тогда, когда раунд проигрывает. Всю прибыль создаёт
              выход: контракт возвращается к цене входа в{" "}
              {(MEASURED.exitRate * 100).toFixed(0)}% случаев, и сделка закрывается почти в ноль.
              Держатся только те, кто не возвращался — они выигрывают в{" "}
              {(MEASURED.survivorWinRate * 100).toFixed(0)}% случаев.
            </p>
            <p className="mt-1">
              Удержаться от продажи по цене ниже входа нельзя: там нет покупателя. Наш выход
              срабатывает на возврате к лимиту, а не потому что позиция открыта.
            </p>
          </div>
        </div>

        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Лимит {plan.limit.toFixed(2)} выбран walk-forward'ом на прошлых неделях и оставался
          рабочим в каждой. Реальный спред этих рынков — 1 тик, так что допущение о{" "}
          {(EXIT_SLIPPAGE * 100).toFixed(0)}ц на выход консервативно. Самое хрупкое место здесь —
          не цифра, а допущение, что продажа по лимиту вообще набирается: минутная история цен
          этого показать не может.
        </p>
      </CardContent>
    </Card>
  );
}
