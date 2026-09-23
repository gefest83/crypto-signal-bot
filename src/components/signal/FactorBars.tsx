import { formatSigned } from "@/lib/format";
import { MIN_SCORE, type SignalReadout } from "@/lib/strategy/engine";
import { cn } from "@/lib/utils";

const REGIME_LABEL: Record<string, string> = {
  normal: "Волатильность в норме",
  chop: "Рваный рынок",
  quiet: "Затишье",
};

function ScoreGauge({ score }: { score: number }) {
  const position = Math.max(0, Math.min(100, ((score + 1) / 2) * 100));
  const threshold = ((1 - MIN_SCORE) / 2) * 100;

  return (
    <div className="flex flex-col gap-2">
      <div className="relative h-2.5 w-full">
        <div className="absolute inset-0 rounded-full bg-[linear-gradient(90deg,var(--down),var(--muted)_50%,var(--up))] opacity-30" />
        <span
          className="absolute -inset-y-1 w-px bg-foreground/30"
          style={{ left: `${threshold}%` }}
        />
        <span
          className="absolute -inset-y-1 w-px bg-foreground/30"
          style={{ left: `${100 - threshold}%` }}
        />
        <span
          className={cn(
            "absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-card shadow-sm",
            score >= 0 ? "bg-up" : "bg-down",
          )}
          style={{ left: `${position}%` }}
        />
      </div>
      <div className="flex justify-between font-mono text-[10px] text-muted-foreground">
        <span>−1.00</span>
        <span>порог ±{MIN_SCORE.toFixed(2)}</span>
        <span>+1.00</span>
      </div>
    </div>
  );
}

export function FactorBars({ readout }: { readout: SignalReadout | null }) {
  const factors = readout?.factors ?? [];

  return (
    <section className="surface border border-border p-5 sm:p-6">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold tracking-tight">
            Из чего собран вызов
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Шесть независимых факторов голосуют, вес — доля в итоговом перевесе.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-full border border-border bg-muted px-2.5 py-0.5 font-mono text-[11px] tabular-nums">
            score {readout ? formatSigned(readout.score) : "—"}
          </span>
          <span className="rounded-full border border-border bg-muted px-2.5 py-0.5 text-[11px] text-muted-foreground">
            {readout ? REGIME_LABEL[readout.regime] : "—"}
          </span>
        </div>
      </header>

      <div className="mt-5">
        <ScoreGauge score={readout?.score ?? 0} />
      </div>

      <div className="mt-5 divide-y divide-border/60 border-t border-border/60">
        {factors.length === 0 ? (
          <p className="py-6 text-sm text-muted-foreground">
            Факторы появятся после первой загрузки свечей.
          </p>
        ) : (
          factors.map((factor) => {
            const magnitude = Math.min(50, Math.abs(factor.value) * 50);
            const left = factor.value >= 0 ? 50 : 50 - magnitude;
            return (
              <div key={factor.key} className="flex flex-col gap-2 py-3.5">
                <div className="flex items-baseline justify-between gap-4">
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-medium">{factor.label}</span>
                    <span className="font-mono text-[11px] text-muted-foreground">
                      вес {Math.round(factor.weight * 100)}%
                    </span>
                  </div>
                  <span
                    className={cn(
                      "font-mono text-sm tabular-nums",
                      factor.stance === "up" && "text-up-ink",
                      factor.stance === "down" && "text-down-ink",
                      factor.stance === "neutral" && "text-muted-foreground",
                    )}
                  >
                    {formatSigned(factor.contribution, 3)}
                  </span>
                </div>
                <div className="relative h-1.5 w-full rounded-full bg-muted">
                  <span className="absolute top-[-2px] left-1/2 h-2.5 w-px bg-border" />
                  <span
                    className={cn(
                      "absolute top-0 h-full rounded-full",
                      factor.stance === "up" && "bg-up",
                      factor.stance === "down" && "bg-down",
                      factor.stance === "neutral" && "bg-muted-foreground/40",
                    )}
                    style={{ left: `${left}%`, width: `${Math.max(magnitude, 0.5)}%` }}
                  />
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {factor.detail}
                </p>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
