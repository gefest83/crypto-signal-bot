/**
 * Can we predict the direction of a Polymarket 15-minute round better than the
 * market price already implies?
 *
 * The market price is the benchmark: it already embeds everything public about
 * spot. So the honest test is not "does my predictor win often" but "does the
 * predictor add information the price does not have". That means conditioning:
 * inside each price bucket, split rounds by the predictor and ask whether the
 * outcome rate moves more than the price implies. If the predictor is skilled,
 * the conditional edge is stable across price buckets and across time.
 *
 * All predictors are computable in real time at t+20% into the round, from
 * Binance 1m candles that were closed before the round started plus the live
 * move so far. None of them look ahead.
 *
 * Usage: bun scripts/direction-skill.ts [interval] [days] [entryFraction]
 *   entryFraction 0.2 = enter at 20% into the round, 0.8 = enter late.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Candle, MarketSymbol } from "../src/lib/market/types";

const INTERVAL = Number(process.argv[2] ?? 15);
const DAYS = Number(process.argv[3] ?? 30);
const ENTRY_FRACTION = Number(process.argv[4] ?? 0.2);
const ROUND_MS = INTERVAL * 60 * 1000;
const ENTRY_MS = Math.round(ROUND_MS * ENTRY_FRACTION);
const ASSETS = ["btc", "eth"] as const;
type Asset = (typeof ASSETS)[number];
const SYMBOL_OF: Record<Asset, MarketSymbol> = { btc: "BTCUSDT", eth: "ETHUSDT" };

type Sample = { t: number; p: number };
type Round = { asset: Asset; t0: number; upWon: boolean | null; samples: Sample[] };

type Row = {
  t0: number;
  asset: Asset;
  /** Real Polymarket price of UP at the entry mark. */
  price: number;
  won: boolean;
  /** Signed predictors, all in "probability-ish" units. */
  mom5: number;
  mom15: number;
  mom30: number;
  /** Striking distance: how far spot is from the round's open, in sigmas. */
  strike: number;
  /** Position inside the round's range so far, 0 = at the low, 1 = at the high. */
  rangePos: number;
};

function priceAt(round: Round, atSeconds: number): number | null {
  const picked = round.samples.find((s) => s.t - round.t0 >= atSeconds);
  return picked ? picked.p : null;
}

const cacheFile = join(import.meta.dir, ".cache", `polymarket-${INTERVAL}m-cache.json`);
if (!existsSync(cacheFile)) {
  console.log(`no cache — run scripts/polymarket-5m.ts ${INTERVAL} ${DAYS} engine`);
  process.exit(1);
}
const cache = JSON.parse(readFileSync(cacheFile, "utf8")) as Round[];

function candlesOf(symbol: MarketSymbol): Candle[] {
  const file = join(import.meta.dir, ".cache", `${symbol}-${DAYS}d.json`);
  if (!existsSync(file)) {
    console.log(`missing Binance cache ${file} — run backtest-strategy.ts`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(file, "utf8")) as Candle[];
}

const stdev = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
};

const rows: Row[] = [];
for (const round of cache) {
  if (round.upWon === null) continue;
  const candles = candlesOf(SYMBOL_OF[round.asset]);
  const start = round.t0 * 1000;
  const i = candles.findIndex((c) => c.openTime === start);
  // Need history before the round and the round's own bars up to the entry mark.
  if (i < 60 || i + INTERVAL + 1 >= candles.length) continue;

  const price = priceAt(round, ENTRY_MS / 1000);
  if (price === null) continue;

  // NO LOOKAHEAD: the last Binance bar we may touch is the one that closes at
  // the entry mark. Using a later bar would let the predictor see the move that
  // happens after the price we "paid" and would manufacture a fake edge.
  const entryBar = i + Math.max(0, Math.floor(ENTRY_MS / 60_000) - 1);
  if (entryBar + 1 >= candles.length) continue;
  const live = candles[entryBar].close;

  // Per-minute log returns over the last hour, used for the volatility scale.
  const recent = candles.slice(i - 60, i);
  const sigmaPerMin = stdev(recent.map((c) => Math.log(c.close / c.open)));
  if (sigmaPerMin <= 0) continue;

  // Momentum windows all END at the entry bar, never at i.
  const mom = (minutes: number) => {
    const back = candles[entryBar - minutes];
    if (!back) return 0;
    return Math.log(live / back.close) / (sigmaPerMin * Math.sqrt(minutes));
  };
  const mom5 = mom(5);
  const mom15 = mom(15);
  const mom30 = mom(30);
  // Striking distance uses only the move since the round opened, never the rest.
  const strike = Math.log(live / candles[i].open) / (sigmaPerMin * Math.sqrt(INTERVAL));

  // The round's range so far, also only up to the entry bar.
  const sofar = candles.slice(i, entryBar + 1);
  const hi = Math.max(...sofar.map((c) => c.high));
  const lo = Math.min(...sofar.map((c) => c.low));
  const rangePos = hi === lo ? 0.5 : (live - lo) / (hi - lo);

  rows.push({
    t0: round.t0,
    asset: round.asset,
    price,
    won: round.upWon,
    mom5,
    mom15,
    mom30,
    strike,
    rangePos,
  });
}

if (rows.length === 0) {
  console.log("no rows");
  process.exit(0);
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const PREDICTORS = ["mom5", "mom15", "mom30", "strike", "rangePos"] as const;
type Predictor = (typeof PREDICTORS)[number];

console.log(`\n=== ${INTERVAL}m direction skill · ${rows.length} rounds · ${DAYS}d · entry t+${(ENTRY_FRACTION * 100).toFixed(0)}% (t+${(ENTRY_MS / 1000).toFixed(0)}s) ===`);

console.log("\n1) raw predictor accuracy (picking the predictor's own direction)");
console.log("   a real edge here means well above the ~50% / break-even line");
for (const p of PREDICTORS) {
  const correct = rows.filter((r) => (r[p] > 0) === r.won).length;
  console.log(`   ${p.padEnd(9)} n=${String(rows.length).padStart(4)}  ${((correct / rows.length) * 100).toFixed(1)}%`);
}

console.log("\n2) unconditional P(up) — is the sample balanced at all?");
const base = (rows.filter((r) => r.won).length / rows.length) * 100;
console.log(`   P(up) = ${base.toFixed(1)}%`);

console.log("\n3) CONDITIONAL EDGE: outcome rate minus the price, by predictor tercile");
console.log("   this is the only number that matters — the price is the benchmark");
console.log("\n   predictor    tercile   n     P(up)   price   edge     P&L/trade (7% taker fee)");
for (const p of PREDICTORS) {
  const sorted = [...rows].sort((a, b) => a[p] - b[p]);
  const size = Math.floor(sorted.length / 3);
  for (const [name, slice] of [
    ["low", sorted.slice(0, size)],
    ["mid", sorted.slice(size, 2 * size)],
    ["high", sorted.slice(2 * size)],
  ] as const) {
    if (!slice.length) continue;
    const win = slice.filter((r) => r.won).length / slice.length;
    const price = mean(slice.map((r) => r.price));
    // Buy the predictor's side: UP when the predictor is positive.
    const pickUp = mean(slice.map((r) => (r[p] > 0 ? 1 : 0)));
    const cost = mean(slice.map((r) => (r[p] > 0 ? r.price : 1 - r.price)));
    const pnl = (pickUp * win + (1 - pickUp) * (1 - win)) - cost - 0.07 * (1 - cost);
    console.log(
      `   ${p.padEnd(11)} ${name.padEnd(9)} ${String(slice.length).padStart(4)}  ` +
        `${(win * 100).toFixed(1).padStart(5)}%  ${price.toFixed(3)}  ${(win * 100 - price * 100 >= 0 ? "+" : "")}${(win - price).toFixed(3)}  ${pnl >= 0 ? "+" : ""}${pnl.toFixed(3).padStart(6)}`,
    );
  }
  console.log("");
}

console.log("4) STABILITY: high tercile of each predictor, P&L per week");
console.log("   the rule is fixed (top third of the predictor), only the sample changes");
const week = 7 * 24 * 3600 * 1000;
const first = rows.reduce((a, r) => Math.min(a, r.t0 * 1000), Infinity);
const sorted = [...rows].sort((a, b) => a.t0 - b.t0);
const spanWeeks = Math.ceil((sorted[sorted.length - 1].t0 * 1000 - first) / week);

/** P&L of taking the predictor's own side on a slice, after the 7% taker fee. */
const slicePnl = (slice: Row[], p: (typeof PREDICTORS)[number]) => {
  if (!slice.length) return null;
  const pickUp = mean(slice.map((r) => (r[p] > 0 ? 1 : 0)));
  const win = slice.filter((r) => r.won).length / slice.length;
  const cost = mean(slice.map((r) => (r[p] > 0 ? r.price : 1 - r.price)));
  return { pnl: (pickUp * win + (1 - pickUp) * (1 - win)) - cost - 0.07 * (1 - cost), n: slice.length, cost };
};

for (const p of PREDICTORS) {
  const byValue = [...rows].sort((a, b) => a[p] - b[p]);
  const cutoff = byValue[Math.floor(byValue.length * 2 / 3)][p];
  const strong = sorted.filter((r) => r[p] >= cutoff);
  const line: string[] = [];
  for (let i = 0; i < spanWeeks; i += 1) {
    const lo = first + i * week;
    const got = slicePnl(strong.filter((r) => r.t0 * 1000 >= lo && r.t0 * 1000 < lo + week), p);
    if (!got || got.n < 8) continue;
    line.push(`wk${i}(${String(got.n).padStart(3)}):${got.pnl >= 0 ? "+" : ""}${got.pnl.toFixed(2)}`);
  }
  const all = slicePnl(strong, p);
  console.log(`   ${p.padEnd(9)} ${line.join(" ")}   all:${all?.pnl.toFixed(3)}  n=${strong.length}`);
}

console.log("\n5) COMBINED: predictors agreeing (strike>0 AND mom5>0), P&L per week");
const combo = (slice: Row[]) => slicePnl(slice, "strike");
const agree = sorted.filter((r) => r.strike > 0 && r.mom5 > 0);
const comboLine: string[] = [];
for (let i = 0; i < spanWeeks; i += 1) {
  const lo = first + i * week;
  const got = combo(agree.filter((r) => r.t0 * 1000 >= lo && r.t0 * 1000 < lo + week));
  if (!got || got.n < 8) continue;
  comboLine.push(`wk${i}(${String(got.n).padStart(3)}):${got.pnl >= 0 ? "+" : ""}${got.pnl.toFixed(2)}`);
}
console.log(`   strike+mom5 UP  ${comboLine.join(" ")}   n=${agree.length}`);
const comboAll = combo(agree);
if (comboAll) {
  console.log(
    `   cost ${comboAll.cost.toFixed(3)}  P&L ${comboAll.pnl >= 0 ? "+" : ""}${comboAll.pnl.toFixed(3)}/trade  ` +
      `total ${(comboAll.pnl * agree.length).toFixed(2)}`,
  );
}

console.log("\n6) WALK-FORWARD: strike threshold chosen on the past, applied to the next week");
console.log("   this is the number that decides whether any of the above is real");
{
  let total = 0;
  let trades = 0;
  for (let i = 1; i < spanWeeks; i += 1) {
    const lo = first + i * week;
    const past = sorted.filter((r) => r.t0 * 1000 < lo);
    const next = sorted.filter((r) => r.t0 * 1000 >= lo && r.t0 * 1000 < lo + week);
    if (past.length < 200 || next.length < 20) continue;
    let best = { cut: 0, ev: -Infinity };
    for (let cut = -0.2; cut <= 2; cut += 0.1) {
      const inBand = past.filter((r) => r.strike >= cut);
      if (inBand.length < 50) continue;
      const got = slicePnl(inBand, "strike");
      if (got && got.pnl > best.ev) best = { cut, ev: got.pnl };
    }
    const applied = next.filter((r) => r.strike >= best.cut);
    const got = slicePnl(applied, "strike");
    if (!got) continue;
    total += got.pnl * got.n;
    trades += got.n;
    console.log(
      `   wk${i} threshold ${best.cut.toFixed(1)}  n=${String(got.n).padStart(3)}  ` +
        `P&L ${got.pnl >= 0 ? "+" : ""}${got.pnl.toFixed(3).padStart(7)}`,
    );
  }
  console.log(
    `\n   WALK-FORWARD: ${total >= 0 ? "+" : ""}${total.toFixed(2)} on ${trades} trades = ` +
      `${trades ? (total / trades).toFixed(3) : "0.000"}/trade`,
  );
}
console.log("\n   stable = same sign every week. Flipping signs = noise, not a signal.");
