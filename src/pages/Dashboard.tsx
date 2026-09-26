import { LogoDropdown } from "@/components/LogoDropdown";
import { MakerEdge } from "@/components/maker/MakerEdge";
import { MakerJournal } from "@/components/maker/MakerJournal";
import { MakerRound } from "@/components/maker/MakerRound";
import { MakerRules } from "@/components/maker/MakerRules";
import { Button } from "@/components/ui/button";
import type { PmAsset } from "../convex/polymarket";
import { useAuth } from "@/hooks/use-auth";
import { useMakerSession, type MakerSession } from "@/hooks/use-maker-session";
import {
  DEFAULT_LIMIT,
  MIN_STAKE_USD,
  STAKE_OPTIONS_USD,
  stakeOutcomes,
  type StakeUsd,
} from "@/lib/strategy/maker-exit";
import { cn } from "@/lib/utils";
import { LogOut } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";

const ASSETS: { id: PmAsset; label: string }[] = [
  { id: "btc", label: "BTC" },
  { id: "eth", label: "ETH" },
];

const PHASE_HINT: Record<string, string> = {
  armed: "заявка в стакане",
  filled: "набито, держим",
  exited: "выход",
  held: "держали",
  missed: "не набито",
};

/**
 * Order size, in real USDC.
 *
 * Polymarket sells dollars, not shares, and the smallest order the books take
 * is $1. At the 0.50 limit that is 2 shares, so a $1 stake is not a small bet
 * — it is the full $1 at risk if the round goes against us, and it is the
 * number every P&L on this screen is measured against.
 */
function StakeSwitch({
  stake,
  onSelect,
}: {
  stake: StakeUsd;
  onSelect: (next: StakeUsd) => void;
}) {
  const outcomes = stakeOutcomes(stake, DEFAULT_LIMIT);

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
      {stake === MIN_STAKE_USD && (
        <span className="text-[10px] text-muted-foreground/70">минимальный размер заявки</span>
      )}
    </div>
  );
}

function AssetSwitch({
  asset,
  onSelect,
  sessions,
}: {
  asset: PmAsset;
  onSelect: (next: PmAsset) => void;
  sessions: Partial<Record<PmAsset, MakerSession>>;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {ASSETS.map((option) => {
        const active = option.id === asset;
        const session = sessions[option.id];
        return (
          <button
            key={option.id}
            type="button"
            onClick={() => onSelect(option.id)}
            className={cn(
              "flex items-center gap-3 rounded-xl border px-4 py-2.5 transition-colors",
              active
                ? "border-primary/40 bg-primary/5"
                : "border-border bg-card hover:bg-muted/50",
            )}
          >
            <span className="text-sm font-semibold tracking-tight">{option.label}</span>
            <span className="font-mono text-[11px] text-muted-foreground">
              {PHASE_HINT[session?.phase ?? "armed"]}
            </span>
            <span className="font-mono text-xs tabular-nums text-muted-foreground">
              {session?.ask != null ? session.ask.toFixed(2) : "—"}
            </span>
          </button>
        );
      })}
      <span className="ms-auto hidden text-[11px] text-muted-foreground sm:block">
        Лимит {DEFAULT_LIMIT.toFixed(2)} · вход без тейкерской комиссии · выход в безубыток
      </span>
    </div>
  );
}

export default function Dashboard() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const [asset, setAsset] = useState<PmAsset>("btc");
  const [stake, setStake] = useState<StakeUsd>(MIN_STAKE_USD);
  const maker = useMakerSession(DEFAULT_LIMIT, stake);

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
              Вход без тейкерской комиссии · выход в безубыток · 5-минутные раунды
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
        <AssetSwitch asset={asset} onSelect={setAsset} sessions={maker.sessions} />

        <MakerRound
          asset={asset.toUpperCase()}
          session={maker.sessions[asset]}
          now={maker.now}
          end={maker.end}
        />

        <div className="grid gap-5 lg:grid-cols-2 lg:items-start">
          <MakerEdge stake={stake} />
          <MakerRules />
        </div>

        <MakerJournal log={maker.log} />

        <p className="pb-2 text-center text-[11px] leading-relaxed text-muted-foreground">
          Все переходы считаются по настоящему стакану Polymarket. Ордера не отправляются: консоль
          воспроизводит состояние стратегии, чтобы проверить её на живых данных.
        </p>
      </main>
    </div>
  );
}
