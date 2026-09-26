import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EXIT_SLIPPAGE, MAKER_REBATE } from "@/lib/strategy/maker-exit";
import { AlertTriangle, TrendingUp } from "lucide-react";

/** Measured on 5760 real 15-minute rounds over 30 days, walk-forward. */
const MEASURED = {
  pnlPerTrade: 0.021,
  losingDays: "3 из 31",
  exitRate: 0.91,
  survivorWinRate: 0.76,
  entryOnlyPnl: -0.102,
  rounds: 5760,
} as const;

function Stat({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" }) {
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
 * Why this strategy exists, shown as the two numbers it actually rests on.
 *
 * The left bar is the entry on its own and it loses ten cents a trade: the
 * market fills the limit precisely when the round is going against us. The
 * right bar is the same fills with the exit, and that is the whole strategy.
 * Putting them side by side is the most honest way to present a result whose
 * money comes from one specific mechanism.
 */
export function MakerEdge() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <TrendingUp className="size-4" />
          Откуда берётся перевес
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-rose-500/25 bg-rose-500/5 px-3 py-2.5">
            <p className="text-[10px] tracking-wide text-rose-500/80 uppercase">
              Вход без выхода
            </p>
            <p className="mt-0.5 font-mono text-lg text-rose-500">
              −{(Math.abs(MEASURED.entryOnlyPnl) * 100).toFixed(1)}¢
            </p>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              Лимит набивается тем, кто прав. Покупка и удержание до расчёния убыточны.
            </p>
          </div>
          <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 px-3 py-2.5">
            <p className="text-[10px] tracking-wide text-emerald-500/80 uppercase">
              Вход + выход в безубыток
            </p>
            <p className="mt-0.5 font-mono text-lg text-emerald-500">
              +{(MEASURED.pnlPerTrade * 100).toFixed(1)}¢
            </p>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              Контракт возвращается к цене входа, и сделка закрывается почти в ноль.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="P&L на сделку" value={`+${(MEASURED.pnlPerTrade * 100).toFixed(1)}¢`} tone="up" />
          <Stat label="Проигрышных дней" value={MEASURED.losingDays} />
          <Stat label="Возврат к лимиту" value={`${(MEASURED.exitRate * 100).toFixed(0)}%`} />
          <Stat
            label="Удержавшиеся выигрывают"
            value={`${(MEASURED.survivorWinRate * 100).toFixed(0)}%`}
          />
        </div>

        <div className="flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2.5">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
          <div className="text-[11px] leading-relaxed text-muted-foreground">
            <p className="font-medium text-amber-500">Что здесь не проверено</p>
            <p className="mt-1">
              Что продажа по лимиту вообще набирается, когда цена падает. Минутная история цен
              показывает, что контракт возвращается к лимиту в{" "}
              {(MEASURED.exitRate * 100).toFixed(0)}% случаев, но не показывает, что кто-то
              перебил ставку. В падающем рынке биты бьют, а не офферы — и это допущение держит на
              себе всю прибыль.
            </p>
            <p className="mt-1">
              Допущение о {(EXIT_SLIPPAGE * 100).toFixed(0)}ц на выход консервативно: реальный
              спред этих рынков — 1 тик, а ребейт мейкера добавляет{" "}
              {(MAKER_REBATE * 100).toFixed(2)}¢ к сделке.
            </p>
            <p className="mt-1">
              Направление не прогнозируется. На 80% срока раунда лучший из предикторов даёт 93.2%
              против 94.0% у рынка — ошибка меньше тика.
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export const MAKER_ROUNDS = MEASURED.rounds;
