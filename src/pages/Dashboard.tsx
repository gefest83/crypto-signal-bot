import { LogoDropdown } from "@/components/LogoDropdown";
import { FactorBars } from "@/components/signal/FactorBars";
import { MakerPanel } from "@/components/signal/MakerPanel";
import { RoundHistory } from "@/components/signal/RoundHistory";
import { SignalHero } from "@/components/signal/SignalHero";
import { StrategyRules } from "@/components/signal/StrategyRules";
import { Button } from "@/components/ui/button";
import type { PmAsset } from "@/convex/polymarket";
import { useAuth } from "@/hooks/use-auth";
import { useSignalConsole, type SignalConsole } from "@/hooks/use-signal-console";
import { formatPrice } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ArrowDown, ArrowUp, LogOut } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";

const ASSETS: { id: PmAsset; label: string; symbol: "BTCUSDT" | "ETHUSDT" }[] = [
  { id: "btc", label: "BTC", symbol: "BTCUSDT" },
  { id: "eth", label: "ETH", symbol: "ETHUSDT" },
];

const SPOT_SYMBOL = { btc: "BTCUSDT", eth: "ETHUSDT" } as const;

function AssetSwitch({
  asset,
  onSelect,
  state,
}: {
  asset: PmAsset;
  onSelect: (next: PmAsset) => void;
  state: SignalConsole;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {ASSETS.map((option) => {
        const active = option.id === asset;
        const lock = state.locks[option.id];
        const entry = state.entries[option.id];
        const lean = lock ? lock.direction : (entry?.favourite ?? null);

        return (
          <button
            key={option.id}
            type="button"
            onClick={() => onSelect(option.id)}
            className={cn(
              "flex items-center gap-3 rounded-xl border px-4 py-2.5 text-left transition-colors",
              active
                ? "border-primary/40 bg-primary/5"
                : "border-border bg-card hover:bg-muted/50",
            )}
          >
            <span className="text-sm font-semibold tracking-tight">{option.label}</span>
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold tracking-wide",
                lean === "up" && "border-up/25 bg-up-soft text-up-ink",
                lean === "down" && "border-down/25 bg-down-soft text-down-ink",
                !lean && "border-border bg-muted text-muted-foreground",
              )}
            >
              {lean ? (
                lean === "up" ? (
                  <ArrowUp className="size-3" />
                ) : (
                  <ArrowDown className="size-3" />
                )
              ) : null}
              {lock ? `${lock.direction === "up" ? "UP" : "DOWN"} ${lock.ask?.toFixed(2)}` : "скан"}
            </span>
            <span className="font-mono text-xs tabular-nums text-muted-foreground">
              {formatPrice(state.spot[SPOT_SYMBOL[option.id]])}
            </span>
          </button>
        );
      })}
      <span className="ms-auto hidden text-[11px] text-muted-foreground sm:block">
        Реальная цена Polymarket · вход только в фаворита ≥ 0.80
      </span>
    </div>
  );
}

export default function Dashboard() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const signalConsole = useSignalConsole();
  const [asset, setAsset] = useState<PmAsset>("btc");

  const symbol = SPOT_SYMBOL[asset];

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
            <p className="text-sm leading-tight font-semibold tracking-tight">
              Favourite Edge
            </p>
            <p className="truncate text-[11px] leading-tight text-muted-foreground">
              Реальный стакан Polymarket · 15-минутные раунды BTC и ETH
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
        <AssetSwitch asset={asset} onSelect={setAsset} state={signalConsole} />

        <SignalHero
          asset={asset}
          status={signalConsole.status[asset]}
          entry={signalConsole.entries[asset] ?? null}
          lock={signalConsole.locks[asset] ?? null}
          round={signalConsole.rounds[asset] ?? null}
          engine={signalConsole.engine[asset] ?? null}
          spot={signalConsole.spot[symbol]}
          now={signalConsole.now}
          windowStart={signalConsole.start}
          windowEnd={signalConsole.end}
          feedStatus={signalConsole.feedStatus}
          feedDetail={signalConsole.feedDetail}
        />

        <MakerPanel
          asset={symbol.replace("USDT", "")}
          price={signalConsole.rounds[asset]?.upAsk ?? null}
          holding={false}
        />

        <div className="grid gap-5 lg:grid-cols-2 lg:items-start">
          <FactorBars readout={signalConsole.engine[asset] ?? null} />
          <StrategyRules />
        </div>

        <RoundHistory />

        <p className="pb-2 text-center text-[11px] leading-relaxed text-muted-foreground">
          Все цены — настоящий стакан Polymarket. Ордера не отправляются: движок только
          считает перевес и ведёт журнал вызовов.
        </p>
      </main>
    </div>
  );
}
