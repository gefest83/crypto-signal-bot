import { RequireAuth } from "@/components/RequireAuth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/convex/_generated/api";
import { ARCHIVE_MARKETS, useQuoteArchive } from "@/hooks/use-quote-archive";
import { pmRoundStart } from "@/lib/pm/markets";
import { FLOW_THRESHOLD, RET_MAG_THR_BPS } from "@/lib/retmag/rule";
import { useAction, useQuery } from "convex/react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";

type Asset = "btc" | "eth";

const ASSETS: { asset: Asset; label: string; symbol: string; cap: string }[] = [
  { asset: "btc", label: "BTC", symbol: "BTCUSDT", cap: "0.60" },
  { asset: "eth", label: "ETH", symbol: "ETHUSDT", cap: "0.70" },
];

/** Rounds needed before "hit rate vs price" separates from noise. */
const ROUNDS_NEEDED = 300;

/**
 * The verdict, stated as what is actually known.
 *
 * This panel is the point of the project, so it sits above the live cards
 * rather than below them. The measured facts, in order of how much they matter:
 *
 *   - DIRECTION is real: 65.5% BTC / 67.7% ETH against a coin flip, z ≈ 7,
 *     over 576 rounds per asset;
 *   - the magnitude gate is NOT proven: +3.5 p.p. at z = 0.85, which on a
 *     sample that size is noise, while halving the number of trades;
 *   - the market is CALIBRATED within ±3 p.p. in every price bucket, so a 69%
 *     hit rate entering near 0.50 is a contradiction, not a 19-point edge.
 *
 * That last point is why no P&L is shown here. The honest P&L is not yet
 * computable: historical executable quotes do not exist for these tokens, and a
 * mid price nobody could trade produces a number that looks like an edge while
 * being an artefact of the measurement.
 */
function Verdict({ rounds, quotes }: { rounds: number; quotes: number }) {
  const progress = Math.min(1, rounds / ROUNDS_NEEDED);

  return (
    <Card className="border-amber-500/30 bg-amber-500/5">
      <CardHeader>
        <CardTitle className="text-base">Что установлено, а что нет</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <div className="grid gap-2 sm:grid-cols-3">
          <div className="rounded-md border border-emerald-500/25 bg-emerald-500/5 p-2.5">
            <p className="text-[10px] tracking-wide text-emerald-500/80 uppercase">
              подтверждено
            </p>
            <p className="mt-1 text-xs leading-relaxed text-foreground/90">
              Направление сигнала настоящее: <b>65.5% BTC / 67.7% ETH</b> против
              монетки, z ≈ 7.
            </p>
          </div>
          <div className="rounded-md border border-rose-500/25 bg-rose-500/5 p-2.5">
            <p className="text-[10px] tracking-wide text-rose-500/80 uppercase">
              не доказано
            </p>
            <p className="mt-1 text-xs leading-relaxed text-foreground/90">
              Гейт <b>|ret20| ≥ {RET_MAG_THR_BPS}бп</b>: +3.5 п.п. при z = 0.85 — шум, при
              этом вдвое режет сделки.
            </p>
          </div>
          <div className="rounded-md border border-amber-500/25 bg-amber-500/5 p-2.5">
            <p className="text-[10px] tracking-wide text-amber-500/80 uppercase">
              неизвестно
            </p>
            <p className="mt-1 text-xs leading-relaxed text-foreground/90">
              Зарабатывает ли. Рынок откалиброван (±3 п.п.), значит P&amp;L с mid — артефакт.
            </p>
          </div>
        </div>

        <div className="rounded-md border border-border/60 bg-card/40 p-2.5">
          <div className="flex items-baseline justify-between text-xs">
            <span className="text-muted-foreground">Накоплено исполнимых котировок</span>
            <span className="font-mono tabular-nums text-foreground">
              {rounds} / {ROUNDS_NEEDED} раундов
            </span>
          </div>
          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-amber-500 transition-all"
              style={{ width: `${progress * 100}%` }}
            />
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
            {quotes > 0
              ? `В архиве ${quotes} снимков стакана. Исторические исполненные сделки по этим токенам недоступны — книга закрытого рынка пуста, — поэтому ответ появится только из живого наблюдения. Держите вкладку открытой.`
              : "Архив пуст — вкладка ещё не наблюдала рынок. Снимки появятся в окне +12…+45с после старта раунда."}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

/** One market: its book right now, and what the rule says about it. */
function MarketCard({ asset, label, symbol, cap }: (typeof ASSETS)[number]) {
  const evaluate = useAction(api.retmag.evaluate);
  const { now, books, starts } = useQuoteArchive(ARCHIVE_MARKETS);
  const [live, setLive] = useState<Awaited<ReturnType<typeof evaluate>> | null>(null);
  const [busy, setBusy] = useState(false);

  const key = `${asset}-5`;
  const book = books[key] ?? null;
  const start = starts[key] ?? 0;
  const elapsed = start ? now - start : 0;
  const roundStart = useMemo(() => pmRoundStart(Math.floor(now / 1000), 5) * 1000, [now]);
  const roundId = Math.floor(roundStart / 1000);

  // The decision lands at +20s, so nothing is evaluated before then. Showing a
  // verdict earlier would be showing a guess dressed as a measurement.
  const ready = elapsed >= 20_000;
  const decided = live?.roundStart === roundId ? live : null;

  useEffect(() => {
    if (!ready || busy) return;
    setBusy(true);
    evaluate({ asset, roundStartMs: roundStart })
      .then((res) => setLive(res))
      .catch((error: unknown) => console.warn("[retmag] evaluate failed", error))
      .finally(() => setBusy(false));
  }, [asset, busy, evaluate, ready, roundStart]);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base">
            {label} <span className="text-muted-foreground">5m</span>
          </CardTitle>
          <Badge variant="outline" className="font-mono text-[11px]">
            +{(elapsed / 1000).toFixed(0)}с
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-2.5">
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-[11px]">
          <div className="flex justify-between">
            <dt className="text-muted-foreground">UP</dt>
            <dd className="tabular-nums">
              {book?.upAsk ?? "—"}/{book?.upBid ?? "—"}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted-foreground">DN</dt>
            <dd className="tabular-nums">
              {book?.downAsk ?? "—"}/{book?.downBid ?? "—"}
            </dd>
          </div>
        </dl>

        <div
          className={`rounded-md border px-2.5 py-2 ${
            decided?.signal && decided.signal !== "hold"
              ? "border-emerald-500/30 bg-emerald-500/10"
              : "border-border/60 bg-card/40"
          }`}
        >
          <p className="text-[10px] tracking-wide text-muted-foreground uppercase">сигнал</p>
          <p className="mt-0.5 font-mono text-sm font-semibold uppercase">
            {!ready ? "ждём +20с" : busy || !decided ? "считаем…" : decided.signal}
          </p>
          {decided && (
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{decided.detail}</p>
          )}
          {decided && !decided.complete && (
            <p className="mt-1 text-[11px] text-amber-500">Данные неполные — решение не засчитывается.</p>
          )}
          {decided?.imb != null && (
            <p className="mt-1 font-mono text-[10px] text-muted-foreground">
              imb {decided.imb.toFixed(3)} (порог {FLOW_THRESHOLD}) · ret20{" "}
              {decided.ret20Bps?.toFixed(1) ?? "—"}бп
            </p>
          )}
        </div>

        <p className="font-mono text-[10px] text-muted-foreground">
          {symbol} · потолок входа {cap}
        </p>
      </CardContent>
    </Card>
  );
}

function DashboardInner() {
  const stats = useQuery(api.quotes.archiveStats, {});

  return (
    <div className="mx-auto flex min-h-screen max-w-5xl flex-col gap-4 px-4 py-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">RetMag</h1>
          <p className="text-sm text-muted-foreground">
            Тейкер-сигнал на BTC/ETH Up/Down 5m. Проверяется на живых котировках.
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link to="/">На главную</Link>
        </Button>
      </header>

      <Verdict rounds={stats?.rounds ?? 0} quotes={stats?.quotes ?? 0} />

      <div className="grid gap-3 sm:grid-cols-2">
        {ASSETS.map((a) => (
          <MarketCard key={a.asset} {...a} />
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Правило</CardTitle>
        </CardHeader>
        <CardContent>
          <pre className="overflow-x-auto rounded-md bg-muted/40 p-3 font-mono text-[11px] leading-relaxed">
            {`t      = round_start + 20s
window = (t - 30s, t]
imb    = 2*buy/vol - 1        <- имбаланс, центрирован на 0
ret20  = (close@t - close@round_start) / close@round_start

|imb| >= ${FLOW_THRESHOLD}              -> сторона = sign(imb)
sign(ret20) == sign(imb)       -> обязательно
|ret20| >= ${RET_MAG_THR_BPS}бп             -> гейт, иначе HOLD
ask <= 0.60 (BTC) / 0.70 (ETH) -> потолок цены`}
          </pre>
        </CardContent>
      </Card>
    </div>
  );
}

export default function Dashboard() {
  return (
    <RequireAuth>
      <DashboardInner />
    </RequireAuth>
  );
}
