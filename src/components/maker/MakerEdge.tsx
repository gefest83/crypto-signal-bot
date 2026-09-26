import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  BREAK_EVEN_EXIT_SLIPPAGE,
  DEFAULT_LIMIT,
  EXIT_SLIPPAGE,
  MEASURED_PER_SHARE,
  TRADE_FEE_RATE,
  expectedPnlPerStake,
  stakeOutcomes,
  type StakeUsd,
} from "@/lib/strategy/maker-exit";
import { AlertTriangle, TrendingUp } from "lucide-react";

const MEASURED = MEASURED_PER_SHARE;

/** USDC, signed, always readable at a glance. */
function usd(value: number): string {
  return `${value < 0 ? "−" : "+"}$${Math.abs(value).toFixed(2)}`;
}

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
export function MakerEdge({ stake }: { stake: StakeUsd }) {
  const outcomes = stakeOutcomes(stake, DEFAULT_LIMIT);
  const perStake = expectedPnlPerStake(stake, DEFAULT_LIMIT);
  const entryOnly = expectedPnlPerStake(stake, DEFAULT_LIMIT, MEASURED.pnlEntryOnly);

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
            <p className="mt-0.5 font-mono text-lg text-rose-500">{usd(entryOnly)}</p>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              На стейк ${stake}. Лимит набивается тем, кто прав: покупка и удержание до расчёния
              стоят полную ставку.
            </p>
          </div>
          <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 px-3 py-2.5">
            <p className="text-[10px] tracking-wide text-emerald-500/80 uppercase">
              Вход + выход в безубыток
            </p>
            <p className="mt-0.5 font-mono text-lg text-emerald-500">{usd(perStake)}</p>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              На стейк ${stake}. Контракт возвращается к цене входа, и сделка закрывается почти в
              ноль.
            </p>
          </div>
        </div>

        {/* What one real order is worth, in each of the three outcomes. */}
        <div className="rounded-lg border border-border/60 bg-card/40">
          <p className="border-b border-border/60 px-3 py-2 text-[10px] tracking-wide text-muted-foreground uppercase">
            Сделка на ${stake} по лимиту {DEFAULT_LIMIT.toFixed(2)} →{" "}
            {(1 / DEFAULT_LIMIT).toFixed(2)} шар
          </p>
          <dl className="grid grid-cols-3 divide-x divide-border/60">
            <div className="px-3 py-2">
              <dt className="text-[10px] text-muted-foreground">Держали, выиграли</dt>
              <dd className="mt-0.5 font-mono text-sm text-emerald-500">{usd(outcomes.won)}</dd>
            </div>
            <div className="px-3 py-2">
              <dt className="text-[10px] text-muted-foreground">Держали, проиграли</dt>
              <dd className="mt-0.5 font-mono text-sm text-rose-500">{usd(outcomes.lost)}</dd>
            </div>
            <div className="px-3 py-2">
              <dt className="text-[10px] text-muted-foreground">Вышли в ноль</dt>
              <dd className="mt-0.5 font-mono text-sm text-amber-500">{usd(outcomes.exited)}</dd>
            </div>
          </dl>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label={`P&L на сделку ($${stake})`} value={usd(perStake)} tone="up" />
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
              перебил ставку. В падающем рынке биты бьют, а не офферы — и на 5m это допущение
              держит на себе почти всю прибыль.
            </p>
            <p className="mt-1">
              Допущение о {(EXIT_SLIPPAGE * 100).toFixed(0)}ц на выход консервативно: реальный
              спред этих рынков — 1 тик. Комиссия {(TRADE_FEE_RATE * 100).toFixed(0)}% от
              стейка уже вычтена из всех цифр выше: на $1 это 2 цента с каждой сделки,
              независимо от исхода.
            </p>
            <p className="mt-1">
              <span className="font-medium text-amber-500">Самое хрупкое место здесь — 5m.</span>{" "}
              Удержавшиеся сделки выигрывают лишь 47% (на 15m было 76%), поэтому перевес держится
              почти целиком на выходе. Измерено: при проскальзывании{" "}
              {(EXIT_SLIPPAGE * 100).toFixed(0)}ц стратегия плюсовая, при{" "}
              {(BREAK_EVEN_EXIT_SLIPPAGE * 100).toFixed(0)}ц — уже ноль, при 6ц — минус. Если
              реальный выход будет дороже {(BREAK_EVEN_EXIT_SLIPPAGE * 100).toFixed(0)}ц на шар,
              стратегии нет.
            </p>
            <p className="mt-1">
              Направление не прогнозируется: на 80% срока раунда лучший предиктор ошибается
              меньше, чем на один тик, — у рынка на этом рынке нет преимущества, которое можно
              было бы забрать.
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export const MAKER_ROUNDS = MEASURED.rounds;
