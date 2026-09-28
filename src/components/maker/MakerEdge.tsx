import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  EXIT_SLIPPAGE,
  MARKET_PROFILES,
  PM_LIMITS,
  TRADE_FEE_RATE,
  type StakeUsd,
} from "@/lib/strategy/maker-exit";
import { cn } from "@/lib/utils";
import { AlertTriangle, TrendingUp } from "lucide-react";

const usd = (v: number) => `${v < 0 ? "−" : "+"}$${Math.abs(v).toFixed(2)}`;

/**
 * Where the money actually comes from, per market.
 *
 * The left bar is the entry on its own and it loses badly on both markets:
 * the book fills our limit precisely when the round is going against us. The
 * right bar is the same fills with the exit, and that is the whole strategy.
 * Shown side by side because a result whose money comes from one specific
 * mechanism should not be presented without that mechanism next to it.
 */
export function MakerEdge({ stake }: { stake: StakeUsd }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <TrendingUp className="size-4" />
          Откуда берётся перевес
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-3">
          {([5, 15] as const).map((interval) => {
            const profile = MARKET_PROFILES[interval];
            const limit = PM_LIMITS[interval];
            const shares = stake / limit;
            const withExit = profile.grossPerShare * shares - stake * TRADE_FEE_RATE;
            const entryOnly =
              profile.entryOnly * shares - stake * TRADE_FEE_RATE;
            return (
              <div key={interval} className="rounded-lg border border-border/60 bg-card/40 p-3">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-xs font-semibold tracking-tight uppercase">
                    {profile.label} · лимит {limit.toFixed(2)} · стейк ${stake}
                  </span>
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {shares.toFixed(0)} шар
                  </span>
                </div>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <div className="rounded-md border border-rose-500/25 bg-rose-500/5 px-2.5 py-1.5">
                    <p className="text-[10px] tracking-wide text-rose-500/80 uppercase">
                      Вход без выхода
                    </p>
                    <p className="mt-0.5 font-mono text-base text-rose-500">{usd(entryOnly)}</p>
                    <p className="mt-0.5 text-[10px] leading-tight text-muted-foreground">
                      Лимит набивается тем, кто прав. Держать до расчёния нельзя.
                    </p>
                  </div>
                  <div className="rounded-md border border-emerald-500/25 bg-emerald-500/5 px-2.5 py-1.5">
                    <p className="text-[10px] tracking-wide text-emerald-500/80 uppercase">
                      Вход + выход
                    </p>
                    <p className="mt-0.5 font-mono text-base text-emerald-500">
                      {usd(withExit)}
                    </p>
                    <p className="mt-0.5 text-[10px] leading-tight text-muted-foreground">
                      Контракт возвращается к цене входа в{" "}
                      {(profile.exitRate * 100).toFixed(0)}% случаев, сделка закрывается с
                      убытком в комиссию.
                    </p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
          <p className="flex items-center gap-1.5 font-medium text-amber-500">
            <AlertTriangle className="size-3.5" />
            Что здесь не проверено
          </p>
          <p className="mt-1.5">
            Что продажа по лимиту вообще набирается, когда цена падает. Минутная история цен
            показывает, что контракт возвращается к уровню, но не показывает, что кто-то перебил
            ставку. В падающем рынке бьют биты, а не офферы. Это допущение держит на себе весь
            перевес: 80% сделок закрываются именно выходом, и каждый такой выход стоит 6-8% стейка.
          </p>
          <p className="mt-1.5">
            Допущение о {(EXIT_SLIPPAGE * 100).toFixed(0)}ц на выход консервативно: реальный спред
            этих рынков — 1 тик. Но запас тонкий: на 5m перевес обнуляется при 4ц на шар, на 15m —
            уже при 3ц. Выход по лимиту не бесплатный: 2ц на каждую шар плюс{" "}
            {(TRADE_FEE_RATE * 100).toFixed(0)}% от стейка, и на ${stake} это −$0.30 на 5m и
            −$0.39 на 15m.
          </p>
          <p className="mt-1.5">
            Направление не прогнозируется: на 80% срока раунда лучший предиктор ошибается меньше,
            чем на один тик. У рынка на этом рынке нет преимущества, которое можно забрать.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

export { cn };
