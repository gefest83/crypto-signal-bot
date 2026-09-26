/**
 * Walk-forward validation for the Polymarket up/down round study.
 *
 * The trap this script exists to catch: a price band that looks profitable on
 * one window and dies on the next. So nothing here is chosen on the full
 * sample. Weeks are walked forward one at a time; the entry band is picked on
 * the weeks already seen, then applied, unadjusted, to the next week. The
 * headline number is the P&L of the walk-forward pass, not the in-sample one.
 *
 * Usage: bun scripts/walkforward.ts <interval> <days> [minPrice] [maxPrice]
 *   bun scripts/walkforward.ts 15 28            # engine direction, 15m
 *   bun scripts/walkforward.ts 15 28 0.7 0.8    # restrict to a price band
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG, evaluateSignal } from "../src/lib/strategy/engine";
import type { Candle, MarketSymbol } from "../src/lib/market/types";

type Asset = "btc" | "eth";
const indexes = new Map<MarketSymbol, Map<number, number>>();
const candlesOf = new Map<MarketSymbol, Candle[]>();

/** Binance 1m candles, cached by scripts/backtest-strategy.ts. */
function loadBinance(symbol: MarketSymbol, days: number): boolean {
  const file = join(import.meta.dir, ".cache", `${symbol}-${days}d.json`);
  if (!existsSync(file)) {
    console.log(`missing Binance cache ${file} — run backtest-strategy.ts first`);
    return false;
  }
  const candles = JSON.parse(readFileSync(file, "utf8")) as Candle[];
  const index = new Map<number, number>();
  candles.forEach((candle, i) => index.set(candle.openTime, i));
  indexes.set(symbol, index);
  candlesOf.set(symbol, candles);
  return true;
}

const INTERVAL = Number(process.argv[2] ?? 15);
const DAYS = Number(process.argv[3] ?? 28);
const MIN_PRICE = Number(process.argv[4] ?? 0);
const MAX_PRICE = Number(process.argv[5] ?? 1);
/** 20% into the round, same mark the live entry uses. */
const ENTRY_MS = Math.round(INTERVAL * 60 * 1000 * 0.2);
const ROUND_S = INTERVAL * 300;
const ASSETS: Asset[] = ["btc", "eth"];
const SYMBOL_OF: Record<Asset, MarketSymbol> = { btc: "BTCUSDT", eth: "ETHUSDT" };
/** Taker fee: shares x rate x p x (1-p) on a $1 stake = rate x (1 - price). */
const TAKER_FEE_RATE = 0.07;

type Sample = { t: number; p: number };
type Round = {
  asset: Asset;
  t0: number;
  upWon: boolean | null;
  samples: Sample[];
};
type Signal = { t0: number; asset: Asset; cost: number; payoff: number; won: boolean };

/** The price we would actually pay: first real quote at or after `at`. */
function priceAt(round: Round, atSeconds: number): number | null {
  const picked = round.samples.find((s) => s.t - round.t0 >= atSeconds);
  return picked ? picked.p : null;
}

const cacheFile = join(import.meta.dir, ".cache", `polymarket-${INTERVAL}m-cache.json`);
const cache: Round[] = existsSync(cacheFile)
  ? (JSON.parse(readFileSync(cacheFile, "utf8")) as Round[])
  : [];
if (cache.length === 0) {
  console.log(`no cache for ${INTERVAL}m — run scripts/polymarket-5m.ts ${INTERVAL} ${DAYS} engine first`);
  process.exit(1);
}

for (const asset of ASSETS) {
  if (!loadBinance(SYMBOL_OF[asset], DAYS)) process.exit(1);
}

/** Join real Binance candles with real Polymarket quotes, exactly as live. */
const signals: Signal[] = [];
for (const round of cache) {
  if (round.upWon === null) continue;
  const symbol = SYMBOL_OF[round.asset];
  const lookup = indexes.get(symbol);
  const candles = candlesOf.get(symbol);
  if (!lookup || !candles) continue;
  const i = lookup.get(round.t0 * 1000);
  if (i === undefined || i < 30 || i + INTERVAL >= candles.length) continue;

  const entry = priceAt(round, ENTRY_MS / 1000);
  if (entry === null) continue;

  const readout = evaluateSignal({
    symbol,
    candles: candles.slice(Math.max(0, i - 199), i + 1),
    price: candles[i].close,
    now: round.t0 * 1000 + ENTRY_MS,
    config: {
      ...DEFAULT_CONFIG,
      minEntryElapsedMs: ENTRY_MS,
      entryWindowMs: ENTRY_MS + 60_000,
      entryCutoffMs: ENTRY_MS + 120_000,
    },
  });
  if (!readout || readout.direction === "stand-aside") continue;

  const settled: "up" | "down" = round.upWon ? "up" : "down";
  const won = readout.direction === settled;
  const cost = readout.direction === "up" ? entry : 1 - entry;
  if (cost < MIN_PRICE || cost > MAX_PRICE) continue;
  signals.push({ t0: round.t0, asset: round.asset, cost, won, payoff: won ? 1 : 0 });
}

signals.sort((a, b) => a.t0 - b.t0);

if (signals.length === 0) {
  console.log("\nno signals line up with the rounds");
  process.exit(0);
}

const WEEK = 7 * 24 * 3600 * 1000;
const first = signals[0].t0 * 1000;
const weeks: Signal[][] = [];
for (const s of signals) {
  const index = Math.floor((s.t0 * 1000 - first) / WEEK);
  (weeks[index] ??= []).push(s);
}

const fee = (cost: number) => TAKER_FEE_RATE * (1 - cost);
const pnl = (s: Signal) => s.payoff - s.cost - fee(s.cost);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const se = (xs: number[]) =>
  xs.length < 2 ? 0 : Math.sqrt(mean(xs.map((x) => (x - mean(xs)) ** 2)) / xs.length);

const hit = (xs: Signal[]) => (xs.length ? (xs.filter((s) => s.won).length / xs.length) * 100 : 0);
const avgCost = (xs: Signal[]) => mean(xs.map((s) => s.cost));

console.log(`\n=== ${INTERVAL}m walk-forward · ${DAYS}d · band ${MIN_PRICE}-${MAX_PRICE} ===`);
console.log(`signals ${signals.length}  weeks ${weeks.length}`);
console.log(`full sample  hit ${hit(signals).toFixed(1)}%  cost ${avgCost(signals).toFixed(3)}  ` +
  `P&L ${mean(signals.map(pnl)).toFixed(3)} ± ${se(signals.map(pnl)).toFixed(3)}  (IN-SAMPLE)`);

console.log("\nper week:");
weeks.forEach((w, i) => {
  if (!w?.length) return;
  const d = new Date(w[0].t0 * 1000).toISOString().slice(0, 10);
  console.log(
    `  wk${String(i).padStart(2)} ${d}  n=${String(w.length).padStart(3)}  ` +
      `hit ${hit(w).toFixed(0).padStart(3)}%  cost ${avgCost(w).toFixed(3)}  P&L ${mean(w.map(pnl)).toFixed(3).padStart(7)}`,
  );
});

/**
 * The rule under test: only take the engine's call when it agrees with the
 * price band, where the band is re-chosen each step from the trailing history
 * and applied to the week that follows. No lookahead anywhere.
 */
console.log("\nwalk-forward band selection (rule fitted on past, applied to next week):");
let wfSignals = 0;
let wfPnl = 0;
let picks = 0;
for (let i = 1; i < weeks.length; i += 1) {
  const past = weeks.slice(0, i).flat().filter((s) => s);
  const next = weeks[i];
  if (!past.length || !next?.length) continue;

  let best = { lo: 0, hi: 1, ev: -Infinity };
  for (let lo = 0; lo <= 0.9; lo += 0.05) {
    for (let hi = lo + 0.05; hi <= 1.0001; hi += 0.05) {
      const inBand = past.filter((s) => s.cost >= lo && s.cost < hi);
      if (inBand.length < 20) continue;
      const ev = mean(inBand.map(pnl));
      if (ev > best.ev) best = { lo, hi, ev };
    }
  }
  const applied = next.filter((s) => s.cost >= best.lo && s.cost < best.hi);
  const ev = mean(applied.map(pnl));
  picks += 1;
  wfSignals += applied.length;
  wfPnl += applied.reduce((a, s) => a + pnl(s), 0);
  const d = new Date(next[0].t0 * 1000).toISOString().slice(0, 10);
  console.log(
    `  wk${String(i).padStart(2)} ${d}  band ${best.lo.toFixed(2)}-${best.hi.toFixed(2)}  ` +
      `n=${String(applied.length).padStart(3)}  P&L ${applied.length ? ev.toFixed(3).padStart(7) : "    n/a"}`,
  );
}

console.log(
  `\nWALK-FORWARD TOTAL: ${wfPnl >= 0 ? "+" : ""}${wfPnl.toFixed(2)} on ${wfSignals} trades ` +
    `(${picks} weeks) = ${wfSignals ? (wfPnl / wfSignals).toFixed(3) : "0.000"}/trade`,
);
console.log("a real edge here must survive this line; an in-sample-only edge does not");
