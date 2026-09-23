import { LogoDropdown } from "@/components/LogoDropdown";
import { FactorBars } from "@/components/signal/FactorBars";
import { RoundHistory } from "@/components/signal/RoundHistory";
import { SignalHero } from "@/components/signal/SignalHero";
import { StrategyRules } from "@/components/signal/StrategyRules";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import {
  useSignalConsole,
  type SignalConsole,
} from "@/hooks/use-signal-console";
import { formatPrice } from "@/lib/format";
import { MARKET_SYMBOLS, SYMBOL_META, type MarketSymbol } from "@/lib/market/types";
import { cn } from "@/lib/utils";
import { ArrowDown, ArrowUp, LogOut } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";

function AssetSwitch({
  symbol,
  onSelect,
  state,
}: {
  symbol: MarketSymbol;
  onSelect: (next: MarketSymbol) => void;
  state: SignalConsole;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {MARKET_SYMBOLS.map((option) => {
        const meta = SYMBOL_META[option];
        const active = option === symbol;
        const lock = state.locks[option];
        const readout = state.readouts[option];
        const lean = lock
          ? lock.direction
          : readout
            ? readout.score >= 0
              ? "up"
              : "down"
            : null;

        return (
          <button
            key={option}
            type="button"
            onClick={() => onSelect(option)}
            className={cn(
              "flex items-center gap-3 rounded-xl border px-4 py-2.5 text-left transition-colors",
              active
                ? "border-primary/40 bg-primary/5"
                : "border-border bg-card hover:bg-muted/50",
            )}
          >
            <span className="text-sm font-semibold tracking-tight">
              {meta.asset}
            </span>
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
              {lock
                ? `${lock.direction === "up" ? "UP" : "DOWN"} ${lock.effectiveConfidence}%`
                : "скан"}
            </span>
            <span className="font-mono text-xs tabular-nums text-muted-foreground">
              {formatPrice(state.prices[option])}
            </span>
          </button>
        );
      })}
      <span className="ms-auto hidden text-[11px] text-muted-foreground sm:block">
        Один вызов на раунд · решение принимается в первые секунды
      </span>
    </div>
  );
}

export default function Dashboard() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const signalConsole = useSignalConsole();
  const [symbol, setSymbol] = useState<MarketSymbol>("BTCUSDT");

  const readout = signalConsole.readouts[symbol] ?? null;
  const locked = signalConsole.locks[symbol] ?? null;

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
              Early Push
            </p>
            <p className="truncate text-[11px] leading-tight text-muted-foreground">
              Сигнал Up/Down · 5-минутные раунды BTC и ETH
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
        <AssetSwitch symbol={symbol} onSelect={setSymbol} state={signalConsole} />

        <SignalHero
          symbol={symbol}
          status={signalConsole.status[symbol]}
          readout={readout}
          locked={locked}
          price={signalConsole.prices[symbol]}
          now={signalConsole.now}
          windowStart={signalConsole.windowStart}
          windowEnd={signalConsole.windowEnd}
          feedStatus={signalConsole.feedStatus}
          feedDetail={signalConsole.feedDetail}
        />

        <div className="grid gap-5 lg:grid-cols-2 lg:items-start">
          <FactorBars readout={readout} />
          <StrategyRules />
        </div>

        <RoundHistory />

        <p className="pb-2 text-center text-[11px] leading-relaxed text-muted-foreground">
          Early Push — инструмент для решений, а не финансовая рекомендация. Ордера
          не отправляются: движок только считает перевес и ведёт журнал вызовов.
        </p>
      </main>
    </div>
  );
}
