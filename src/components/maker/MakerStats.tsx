import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  MARKET_PROFILES,
  PM_LIMITS,
  TRADE_FEE_RATE,
  type MarketProfile,
} from "@/lib/strategy/maker-exit";
import { cn } from "@/lib/utils";
import { BarChart3 } from "lucide-react";

const usd = (v: number) => `${v < 0 ? "−" : "+"}$${Math.abs(v).toFixed(2)}`;

/**
 * What each of the four markets was measured to be, before a single live
 * trade exists.
 *
 * These two columns are NOT interchangeable, and putting them side by side is
 * the point of this card. Run in isolation each looks fine:
 *
 *   5m   EV +0.018/шара   288 rounds/day/asset   3 trades a minute
 *   15m  EV +0.013/шара    96 rounds/day/asset   one trade every 15 min
 *
 * But the WAY they fail is opposite. On 5m the exit fires 80% of the time
 * and the survivors that must be held win 47% — a coin flip — so essentially
 * all of the edge is the exit, and 5m survives a 4c exit on sheer frequency
 * (288 rounds a day per asset). On 15m the exit fires 91% and the survivors
 * win 76%, so each trade is genuinely better — but the edge sits in reversion
 * happening OFTEN, which means an expensive exit kills it sooner: flat at 3c.
 * A blended average of the two would describe a market that does not exist.
 */
export function MakerStats({ stake }: { stake: number }) {
  const profiles = [MARKET_PROFILES[5], MARKET_PROFILES[15]];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <BarChart3 className="size-4" />
          Профили рынков
        </CardTitle>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Измерено на живых раундах: 5m — 17 277 раундов, 15m — 5 760. Считается по каждому рынку
          отдельно, потому что ведут они себя по-разному.
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          {profiles.map((profile) => (
            <ProfileCard key={profile.interval} profile={profile} stake={stake} />
          ))}
        </div>

        <div className="rounded-lg border border-border/60 bg-card/40 px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
          <span className="font-medium text-foreground">Почему не усреднять.</span> На 5m
          удержавшиеся сделки выигрывают 47% — это монетка, и весь перевес держится на выходе:{" "}
          {((MARKET_PROFILES[5].exitRate * 100) | 0)}% возвратов к лимиту. На 15m — 76% побед у
          удержавшихся и {((MARKET_PROFILES[15].exitRate * 100) | 0)}% возвратов, то есть сделка
          заметно качественнее. Но 15m тоньше на шару и{" "}
          <span className="font-medium text-foreground">
            обнуляется раньше — на {((MARKET_PROFILES[15].breakEvenSlippage * 100) | 0)}ц против{" "}
            {((MARKET_PROFILES[5].breakEvenSlippage * 100) | 0)}ц у 5m
          </span>
          : его перевес сидит в частоте возвратов, а не в их цене. Среднее этих двух не описывает ни
          один реальный рынок.
        </div>
      </CardContent>
    </Card>
  );
}

function ProfileCard({ profile, stake }: { profile: MarketProfile; stake: number }) {
  const limit = PM_LIMITS[profile.interval];
  const perStake = profile.grossPerShare * (stake / limit) - stake * TRADE_FEE_RATE;
  const outcomes = [
    { label: "держали, выиграли", value: stake * (1 - limit) - stake * TRADE_FEE_RATE, good: true },
    { label: "держали, проиграли", value: -stake * (1 + TRADE_FEE_RATE), good: false },
    {
      label: "вышли в ноль",
      value: -(stake / limit) * 0.02 - stake * TRADE_FEE_RATE,
      good: null,
    },
  ];

  return (
    <div className="rounded-lg border border-border/60 bg-card/40 px-3 py-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-semibold tracking-tight">{profile.label}</span>
        <span className="font-mono text-[10px] text-muted-foreground">
          лимит {limit.toFixed(2)} · {profile.rounds} раундов
        </span>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-[11px]">
        <Field label="EV/шара" value={`${profile.evPerShare >= 0 ? "+" : ""}${profile.evPerShare.toFixed(3)}`} tone={profile.evPerShare > 0 ? "up" : "down"} />
        <Field label={`P&L на $${stake}`} value={usd(perStake)} tone={perStake > 0 ? "up" : "down"} />
        <Field label="Возврат к лимиту" value={`${(profile.exitRate * 100).toFixed(0)}%`} />
        <Field
          label="Удержавшиеся берут"
          value={`${(profile.survivorWinRate * 100).toFixed(0)}%`}
          tone={profile.survivorWinRate > 0.6 ? "up" : "down"}
        />
        <Field label="Проигрышных дней" value={profile.losingDays} />
        <Field
          label="Обнуление при выходе"
          value={`${(profile.breakEvenSlippage * 100).toFixed(0)}ц`}
          tone="down"
        />
      </div>

      <div className="mt-2.5 border-t border-border/60 pt-2">
        <p className="text-[10px] text-muted-foreground">
          Сделка на ${stake}, {outcomes.length} исхода:
        </p>
        <ul className="mt-1 flex flex-col gap-0.5">
          {outcomes.map((outcome) => (
            <li key={outcome.label} className="flex items-baseline justify-between gap-2 text-[10px]">
              <span className="text-muted-foreground">{outcome.label}</span>
              <span
                className={cn(
                  "font-mono",
                  outcome.good === true
                    ? "text-emerald-500"
                    : outcome.good === false
                      ? "text-rose-500"
                      : "text-amber-500",
                )}
              >
                {usd(outcome.value)}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "up" | "down";
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={cn(
          tone === "up" ? "text-emerald-500" : tone === "down" ? "text-rose-500" : "text-foreground",
        )}
      >
        {value}
      </span>
    </div>
  );
}
