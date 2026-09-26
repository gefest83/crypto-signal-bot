import { LogoDropdown } from "@/components/LogoDropdown";
import { MakerEdge } from "@/components/maker/MakerEdge";
import { MakerJournal } from "@/components/maker/MakerJournal";
import { MakerRound } from "@/components/maker/MakerRound";
import { MakerStats } from "@/components/maker/MakerStats";
import { MakerRules } from "@/components/maker/MakerRules";
import { PaperPanel } from "@/components/maker/PaperPanel";
import { Button } from "@/components/ui/button";
import type { PmInterval } from "../convex/polymarket";
import { useAuth } from "@/hooks/use-auth";
import {
  MARKETS,
  usePaperSession,
  type MarketStats,
  type PaperSession,
} from "@/hooks/use-paper-session";
import { DEFAULT_PAPER } from "@/lib/strategy/paper";
import {
  MIN_ORDER_SHARES,
  PM_LIMITS,
  STAKE_OPTIONS_USD,
  stakeOutcomes,
  type StakeUsd,
} from "@/lib/strategy/maker-exit";
import { cn } from "@/lib/utils";
import { LogOut } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";

/** The end of the round containing `now`, for one interval. */
function roundEnd(now: number, interval: PmInterval): number {
  const start = Math.floor(now / 1000 / (interval * 60)) * (interval * 60) * 1000;
  return start + interval * 60_000;
}

const PHASE_HINT: Record<string, string> = {
  quoting: "заявка в стакане",
  filled: "набито, держим",
  closing: "ждём выход",
  closed: "выход",
  held: "держали",
  missed: "не набилась",
};

/**
 * Order size, in real USDC.
 *
 * Polymarket sells dollars, not shares, and the smallest order the books take
 * is 5 SHARES, not dollars — at the 0.50 limit that is $2.50, so the options
 * start at $5. A $1 stake was never executable, and the risk on a real order
 * is the full stake plus 2%, which is the number every P&L here is measured
 * against.
 */
function StakeSwitch({
  stake,
  onSelect,
}: {
  stake: StakeUsd;
  onSelect: (next: StakeUsd) => void;
}) {
  const outcomes = stakeOutcomes(stake, PM_LIMITS[5]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[11px] text-muted-foreground">Стейк</span>
      {STAKE_OPTIONS_USD.map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => onSelect(option)}
          className={cn(
            "rounded-lg border px-3 py-1.5 font-mono text-xs transition-colors",
            option === stake
              ? "border-primary/40 bg-primary/5 text-foreground"
              : "border-border bg-card text-muted-foreground hover:bg-muted/50",
          )}
        >
          ${option}
        </button>
      ))}
      <span className="ms-auto font-mono text-[11px] text-muted-foreground">
        {outcomes.won.toFixed(2)} $ выигрыш · {outcomes.lost.toFixed(2)} $ проигрыш ·{" "}
        {outcomes.exited.toFixed(2)} $ выход
      </span>
      {stake === STAKE_OPTIONS_USD[0] && (
        <span className="text-[10px] text-muted-foreground/70">
          минимум биржи — {MIN_ORDER_SHARES} шар
        </span>
      )}
    </div>
  );
}

/**
 * One tab per market, all four of them.
 *
 * The tabs used to be BTC and ETH only, because there was only one interval
 * running. Now that both 5m and 15m are live, hiding them behind a single
 * "asset" switch would make it impossible to see which of the four a number
 * came from — and that distinction is the whole reason the markets are
 * measured separately. So every market gets its own tab, each labelled with
 * its interval and its own limit, because 0.50 and 0.35 are not the same trade.
 */
function MarketSwitch({
  active,
  onSelect,
  sessions,
  perMarket,
}: {
  active: string;
  onSelect: (key: string) => void;
  sessions: Partial<Record<string, PaperSession>>;
  perMarket: MarketStats[];
}) {
  const realisedOf = new Map(perMarket.map((s) => [s.key, s.realised]));
  const fillsOf = new Map(perMarket.map((s) => [s.key, s.fills]));

  return (
    <div className="flex flex-wrap items-center gap-2">
      {MARKETS.map((market) => {
        const isActive = market.key === active;
        const session = sessions[market.key];
        const limit = PM_LIMITS[market.interval];
        const realised = realisedOf.get(market.key) ?? 0;
        const fills = fillsOf.get(market.key) ?? 0;
        return (
          <button
            key={market.key}
            type="button"
            onClick={() => onSelect(market.key)}
            className={cn(
              "flex items-center gap-2.5 rounded-xl border px-3.5 py-2.5 transition-colors",
              isActive
                ? "border-primary/40 bg-primary/5"
                : "border-border bg-card hover:bg-muted/50",
            )}
          >
            <span className="text-sm font-semibold tracking-tight">
              {market.asset.toUpperCase()}
            </span>
            <span
              className={cn(
                "rounded px-1.5 py-0.5 font-mono text-[10px]",
                market.interval === 5
                  ? "bg-sky-500/15 text-sky-500"
                  : "bg-amber-500/15 text-amber-500",
              )}
            >
              {market.interval}m
            </span>
            <span className="font-mono text-[11px] text-muted-foreground">
              {PHASE_HINT[session?.state ?? "quoting"]}
            </span>
            <span className="font-mono text-xs tabular-nums text-muted-foreground">
              {session?.ask != null ? session.ask.toFixed(2) : "—"}
            </span>
            <span
              className={cn(
                "font-mono text-[11px] tabular-nums",
                fills === 0
                  ? "text-muted-foreground/60"
                  : realised >= 0
                    ? "text-emerald-500"
                    : "text-rose-500",
              )}
            >
              {fills === 0 ? "—" : `${realised >= 0 ? "+" : "−"}$${Math.abs(realised).toFixed(2)}`}
            </span>
            <span className="font-mono text-[10px] text-muted-foreground/60">
              {limit.toFixed(2)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export default function Dashboard() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const [market, setMarket] = useState<string>(MARKETS[0].key);
  const [stake, setStake] = useState<StakeUsd>(5);
  const paper = usePaperSession(stake, DEFAULT_PAPER);
  const selected = MARKETS.find((m) => m.key === market) ?? MARKETS[0];

  const handleSignOut = async () => {
    await signOut();
    navigate("/");
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-20 border-b border-border/70 bg-background/85 backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl items-center gap-3 px-4 py-3 sm:px-6">
          <LogoDropdown />
          <div className="min-w-0">
            <p className="text-sm leading-tight font-semibold tracking-tight">Maker Exit</p>
            <p className="truncate text-[11px] leading-tight text-muted-foreground">
              Вход без тейкерской комиссии · выход в безубыток · рынки 5m и 15m
            </p>
          </div>
          <div className="ms-auto flex items-center gap-3">
            <span className="hidden max-w-[180px] truncate text-xs text-muted-foreground sm:inline">
              {user?.email ?? user?.name ?? "Гость"}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={handleSignOut}
            >
              <LogOut className="size-3.5" />
              Выйти
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-6 sm:px-6 sm:py-8">
        <StakeSwitch stake={stake} onSelect={setStake} />
        <MarketSwitch
          active={market}
          onSelect={setMarket}
          sessions={paper.sessions}
          perMarket={paper.perMarket}
        />

        <MakerRound
          key={selected.key}
          label={`${selected.asset.toUpperCase()} ${selected.interval}m`}
          session={paper.sessions[selected.key]}
          now={paper.now}
          end={roundEnd(paper.now, selected.interval)}
        />

        <MakerStats stake={stake} />

        <div className="grid gap-5 lg:grid-cols-2 lg:items-start">
          <MakerEdge stake={stake} />
          <MakerRules />
        </div>

        <PaperPanel
          sessions={paper.sessions}
          perMarket={paper.perMarket}
          totals={paper.totals}
          now={paper.now}
          penetrationTicks={paper.settings.penetrationTicks}
        />

        <MakerJournal />

        <p className="pb-2 text-center text-[11px] leading-relaxed text-muted-foreground">
          Все переходы считаются по настоящему стакану Polymarket. Ордера не отправляются: консоль
          воспроизводит состояние стратегии, чтобы проверить её на живых данных.
        </p>
      </main>
    </div>
  );
}
