/**
 * Two structurally different ideas for the 15-minute rounds, neither of which
 * is "predict direction from candles".
 *
 * 1. ROUND-OPEN MISPRICING. At the instant a round opens, UP and DOWN must be
 *    worth exactly 0.50 each — by construction the round resolves on "up from
 *    the open". If Polymarket prints 0.42 a few seconds in, the market has
 *    mispriced a known-exactly-50/50 contract. That is a real inefficiency if
 *    it exists, and it needs no forecast at all.
 *
 * 2. CROSS-ASSET RESIDUAL. The BTC and ETH rounds with the same start are two
 *    separate markets for two near-identical 15-minute moves. Neither knows the
 *    other, and a human watching one of them can price the other. We predict
 *    ETH from BTC by a rolling regression fitted only on completed rounds, and
 *    trade the gap between that prediction and the ETH contract's own price.
 *
 * Both are measured with the same discipline as everything else: the threshold
 * is chosen on past rounds and applied to the next week, and every P&L is net
 * of the 7% Polymarket taker fee.
 *
 * Usage: bun scripts/mispricing.ts [interval] [days] [entryFraction]
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Candle, MarketSymbol } from "../src/lib/market/types";

const INTERVAL = Number(process.argv[2] ?? 15);
const DAYS = Number(process.argv[3] ?? 30);
const ENTRY_FRACTION = Number(process.argv[4] ?? 0.2);
const ROUND_MS = INTERVAL * 60 * 1000;
const ENTRY_MS = Math.round(ROUND_MS * ENTRY_FRACTION);
const TAKER_FEE_RATE = 0.07;
const ASSETS = ["btc", "eth"] as const;
type Asset = (typeof ASSETS)[number];
const SYMBOL_OF: Record<Asset, MarketSymbol> = { btc: "BTCUSDT", eth: "ETHUSDT" };

type Sample = { t: number; p: number };
type Round = { asset: Asset; t0: number; upWon: boolean | null; samples: Sample[] };

const cacheFile = join(import.meta.dir, ".cache", `polymarket-${INTERVAL}m-cache.json`);
if (!existsSync(cacheFile)) {
  console.log(`no cache — run scripts/polymarket-5m.ts ${INTERVAL} ${DAYS} engine`);
  process.exit(1);
}
const cache = JSON.parse(readFileSync(cacheFile, "utf8")) as Round[];

const candlesOf = new Map<MarketSymbol, Candle[]>();
for (const asset of ASSETS) {
  const file = join(import.meta.dir, ".cache", `${SYMBOL_OF[asset]}-${DAYS}d.json`);
  if (!existsSync(file)) {
    console.log(`missing Binance cache ${file} — run backtest-strategy.ts`);
    process.exit(1);
  }
  candlesOf.set(SYMBOL_OF[asset], JSON.parse(readFileSync(file, "utf8")) as Candle[]);
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const stdev = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
};
/** Standard normal CDF — the market's own model of a binary on a driftless walk. */
const phi = (z: number) => 0.5 * (1 + erf(z / Math.SQRT2));
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}
const takerFee = (price: number) => TAKER_FEE_RATE * (1 - price);

/** First real quote at or after `at` seconds into the round. */
const priceAt = (round: Round, at: number) => {
  const picked = round.samples.find((s) => s.t - round.t0 >= at);
  return picked ? picked.p : null;
};

// ---------------------------------------------------------------------------
// 1. Round-open mispricing
// ---------------------------------------------------------------------------
console.log(`\n=== ${INTERVAL}m · mispricing study · ${DAYS}d · entry t+${(ENTRY_FRACTION * 100).toFixed(0)}% ===`);

const openRows: { t0: number; openPrice: number; won: boolean }[] = [];
for (const round of cache) {
  if (round.upWon === null) continue;
  const first = round.samples[0];
  if (!first) continue;
  openRows.push({
    t0: round.t0,
    // How far the very first print sits from the 0.50 it must be worth.
    openPrice: first.p,
    won: round.upWon,
  });
}
openRows.sort((a, b) => a.t0 - b.t0);

console.log(`\n1) ROUND-OPEN PRICE — distribution of the first print`);
console.log(`   n=${openRows.length}  mean ${mean(openRows.map((r) => r.openPrice)).toFixed(4)}  ` +
  `sd ${stdev(openRows.map((r) => r.openPrice)).toFixed(4)}`);
console.log("   a contract that must be worth exactly 0.50 at t=0 would show mean 0.500, sd 0.000");
const off = openRows.filter((r) => Math.abs(r.openPrice - 0.5) > 0.03);
if (off.length) {
  console.log(`   prints more than 3c off 0.50: ${off.length} (${((off.length / openRows.length) * 100).toFixed(1)}%)`);
  const cheapUp = off.filter((r) => r.openPrice < 0.5);
  const cheapDown = off.filter((r) => r.openPrice > 0.5);
  const pUp = cheapUp.length ? cheapUp.filter((r) => r.won).length / cheapUp.length : 0;
  const pDown = cheapDown.length ? cheapDown.filter((r) => !r.won).length / cheapDown.length : 0;
  console.log(`   UP printed cheap  (<0.47): n=${cheapUp.length}  P(up) really won ${(pUp * 100).toFixed(1)}%  price ${mean(cheapUp.map((r) => r.openPrice)).toFixed(3)}  edge ${(pUp - mean(cheapUp.map((r) => r.openPrice))).toFixed(3)}`);
  console.log(`   DOWN printed cheap (>0.53): n=${cheapDown.length}  P(down) really won ${(pDown * 100).toFixed(1)}%  price ${mean(cheapDown.map((r) => 1 - r.openPrice)).toFixed(3)}  edge ${(pDown - mean(cheapDown.map((r) => 1 - r.openPrice))).toFixed(3)}`);
} else {
  console.log("   no meaningful open mispricing — the market opens every round at 0.50");
}

// ---------------------------------------------------------------------------
// 2. Cross-asset residual
// ---------------------------------------------------------------------------
type Obs = {
  t0: number;
  /** Normalised move so far, in sigmas of the full-round distribution. */
  sBtc: number;
  sEth: number;
  /** The same at round close, for fitting the regression on completed rounds. */
  finalBtc: number;
  finalEth: number;
  ethPrice: number;
  btcPrice: number;
  ethWon: boolean;
  /** Remaining volatility, in the same units as s, for the Φ conversion. */
  remSigma: number;
  /** Contract path after entry, for the breakeven-exit simulation. */
  ethPath: { dt: number; p: number }[];
};

function strikeOf(candles: Candle[], i: number, atMs: number): { s: number; sigma: number } | null {
  const entryBar = i + Math.max(0, Math.floor(atMs / 60_000) - 1);
  if (entryBar + 1 >= candles.length) return null;
  const perMin = stdev(candles.slice(i - 90, i).map((c) => Math.log(c.close / c.open)));
  if (perMin <= 0) return null;
  const scale = perMin * Math.sqrt(INTERVAL);
  const s = Math.log(candles[entryBar].close / candles[i].open) / scale;
  const done = Math.max(1, entryBar - i + 1);
  return { s, sigma: Math.sqrt(Math.max(0, 1 - done / INTERVAL)) };
}

const byT0 = new Map<number, Partial<Record<Asset, Round>>>();
for (const round of cache) {
  if (round.upWon === null) continue;
  byT0.set(round.t0, { ...(byT0.get(round.t0) ?? {}), [round.asset]: round });
}

const obs: Obs[] = [];
for (const [t0, pair] of byT0) {
  const btc = pair.btc;
  const eth = pair.eth;
  if (!btc || !eth) continue;
  const btcCandles = candlesOf.get("BTCUSDT")!;
  const ethCandles = candlesOf.get("ETHUSDT")!;
  const iBtc = btcCandles.findIndex((c) => c.openTime === t0 * 1000);
  const iEth = ethCandles.findIndex((c) => c.openTime === t0 * 1000);
  if (iBtc < 90 || iEth < 90 || iBtc + INTERVAL >= btcCandles.length || iEth + INTERVAL >= ethCandles.length) continue;

  const kb = strikeOf(btcCandles, iBtc, ENTRY_MS);
  const ke = strikeOf(ethCandles, iEth, ENTRY_MS);
  if (!kb || !ke || ke.sigma <= 0) continue;

  const ethPrice = priceAt(eth, ENTRY_MS / 1000);
  if (ethPrice === null) continue;

  // Completed-round values, for the regression.
  const perMinBtc = stdev(btcCandles.slice(iBtc - 90, iBtc).map((c) => Math.log(c.close / c.open)));
  const perMinEth = stdev(ethCandles.slice(iEth - 90, iEth).map((c) => Math.log(c.close / c.open)));
  const finalBtc = Math.log(btcCandles[iBtc + INTERVAL - 1].close / btcCandles[iBtc].open) / (perMinBtc * Math.sqrt(INTERVAL));
  const finalEth = Math.log(ethCandles[iEth + INTERVAL - 1].close / ethCandles[iEth].open) / (perMinEth * Math.sqrt(INTERVAL));

  obs.push({
    t0,
    sBtc: kb.s,
    sEth: ke.s,
    finalBtc,
    finalEth,
    ethPrice,
    btcPrice: priceAt(btc, ENTRY_MS / 1000) ?? 0.5,
    ethWon: eth.upWon!,
    remSigma: ke.sigma,
    ethPath: eth.samples
      .filter((x) => x.t - t0 > ENTRY_MS / 1000)
      .map((x) => ({ dt: x.t - t0, p: x.p })),
  });
}
obs.sort((a, b) => a.t0 - b.t0);

if (obs.length < 500) {
  console.log(`\n2) only ${obs.length} paired rounds — not enough, need 500+`);
  process.exit(0);
}

console.log(`\n2) CROSS-ASSET RESIDUAL — ETH predicted from BTC (rolling regression)`);
console.log(`   paired rounds n=${obs.length}`);

/** Fit finalEth = a + b·finalBtc on a trailing window of completed rounds. */
function fitRegression(sample: Obs[]) {
  const x = sample.map((o) => o.finalBtc);
  const y = sample.map((o) => o.finalEth);
  const mx = mean(x);
  const my = mean(y);
  const cov = sample.reduce((a, o) => a + (o.finalBtc - mx) * (o.finalEth - my), 0);
  const vx = sample.reduce((a, o) => a + (o.finalBtc - mx) ** 2, 0);
  return { a: my - (vx ? (cov / vx) * mx : 0), b: vx ? cov / vx : 1 };
}

const WINDOW = 400;
/** Model probability that ETH finishes up, and the contract's own price. */
const modelled = obs.map((o, i) => {
  if (i < WINDOW) return null;
  const { a, b } = fitRegression(obs.slice(i - WINDOW, i));
  const expectedFinal = a + b * o.sBtc;
  const residual = o.sEth - expectedFinal;
  return { ...o, prob: phi(residual / o.remSigma), edge: 0 };
});

const live = modelled.filter((x): x is Obs & { prob: number } => x !== null);
console.log(`   regression window ${WINDOW} completed rounds, fitted on the past only`);
console.log(`   ETH move is ${(fitRegression(obs).b).toFixed(2)}× BTC's — they are not the same trade`);

console.log("\n   predicted prob vs contract price, by prediction-error decile");
const sortedByEdge = [...live].sort((a, b) => a.prob - b.ethPrice);
const decile = Math.floor(sortedByEdge.length / 10);
for (let d = 0; d < 10; d += 1) {
  const slice = sortedByEdge.slice(d * decile, (d + 1) * decile);
  if (!slice.length) continue;
  const p = mean(slice.map((x) => x.prob));
  const price = mean(slice.map((x) => x.ethPrice));
  const real = slice.filter((x) => x.ethWon).length / slice.length;
  console.log(
    `     d${d}  n=${String(slice.length).padStart(3)}  model ${p.toFixed(3)}  price ${price.toFixed(3)}  ` +
      `real ${real.toFixed(3)}  model−price ${(p - price >= 0 ? "+" : "")}${(p - price).toFixed(3)}  model−real ${(p - real >= 0 ? "+" : "")}${(p - real).toFixed(3)}`,
  );
}

// ---------------------------------------------------------------------------
// 3. Walk-forward: trade when the model and the price disagree enough
// ---------------------------------------------------------------------------
console.log("\n3) WALK-FORWARD: threshold chosen on past rounds, applied to the next week");
const week = 7 * 24 * 3600 * 1000;
const first = live[0].t0 * 1000;
const spanWeeks = Math.ceil((live[live.length - 1].t0 * 1000 - first) / week);

type Trade = { cost: number; won: boolean; exited: boolean; pnl: number };

/** P&L of a $1 stake, with an optional breakeven exit during the round. */
function tradePnl(cost: number, won: boolean, useExit: boolean, path: { dt: number; p: number }[], dirUp: boolean): number {
  if (useExit) {
    // Sell back at cost the first time the contract is worth no more than we paid.
    // Realistically the fill lands within a tick, so we model it exactly at cost.
    const touched = path.some((x) => (dirUp ? x.p : 1 - x.p) <= cost);
    if (touched) return 0;
  }
  const gross = won ? 1 - cost : -cost;
  return gross - takerFee(cost);
}

let total = 0;
let trades = 0;
let exitTotal = 0;
let exitTrades = 0;
for (let w = 1; w < spanWeeks; w += 1) {
  const lo = first + w * week;
  const past = live.filter((x) => x.t0 * 1000 < lo);
  const next = live.filter((x) => x.t0 * 1000 >= lo && x.t0 * 1000 < lo + week);
  if (past.length < 300 || next.length < 20) continue;

  let best = { gap: 0.05, ev: -Infinity };
  for (let gap = 0.02; gap <= 0.3; gap += 0.02) {
    const picked = past
      .filter((x) => x.prob > x.ethPrice + gap || x.prob < x.ethPrice - gap)
      .map((x) => {
        const dirUp = x.prob > x.ethPrice;
        const cost = dirUp ? x.ethPrice : 1 - x.ethPrice;
        return tradePnl(cost, dirUp ? x.ethWon : !x.ethWon, false, x.ethPath, dirUp);
      });
    if (picked.length < 20) continue;
    const ev = mean(picked);
    if (ev > best.ev) best = { gap, ev };
  }

  const applied = next.filter((x) => x.prob > x.ethPrice + best.gap || x.prob < x.ethPrice - best.gap);
  const held: Trade[] = applied.map((x) => {
    const dirUp = x.prob > x.ethPrice;
    const cost = dirUp ? x.ethPrice : 1 - x.ethPrice;
    return { cost, won: dirUp ? x.ethWon : !x.ethWon, exited: false, pnl: tradePnl(cost, dirUp ? x.ethWon : !x.ethWon, false, x.ethPath, dirUp) };
  });
  const withExit: Trade[] = applied.map((x) => {
    const dirUp = x.prob > x.ethPrice;
    const cost = dirUp ? x.ethPrice : 1 - x.ethPrice;
    const won = dirUp ? x.ethWon : !x.ethWon;
    const exited = x.ethPath.some((s) => (dirUp ? s.p : 1 - s.p) <= cost);
    return { cost, won, exited, pnl: tradePnl(cost, won, true, x.ethPath, dirUp) };
  });

  total += held.reduce((a, t) => a + t.pnl, 0);
  trades += held.length;
  exitTotal += withExit.reduce((a, t) => a + t.pnl, 0);
  exitTrades += withExit.length;
  const h = held.length ? mean(held.map((t) => t.pnl)) : 0;
  const e = withExit.length ? mean(withExit.map((t) => t.pnl)) : 0;
  const nExit = withExit.filter((t) => t.exited).length;
  console.log(
    `   wk${w} gap≥${best.gap.toFixed(2)}  n=${String(held.length).padStart(3)}  ` +
      `hold ${h >= 0 ? "+" : ""}${h.toFixed(3)}  with breakeven exit ${e >= 0 ? "+" : ""}${e.toFixed(3)}  (${nExit} вышли в ноль)`,
  );
}

console.log(
  `\n   WALK-FORWARD, hold to resolution: ${total >= 0 ? "+" : ""}${total.toFixed(2)} on ${trades} trades = ` +
    `${trades ? (total / trades).toFixed(3) : "0.000"}/trade`,
);
console.log(
  `   WALK-FORWARD, breakeven exit:     ${exitTotal >= 0 ? "+" : ""}${exitTotal.toFixed(2)} on ${exitTrades} trades = ` +
    `${exitTrades ? (exitTotal / exitTrades).toFixed(3) : "0.000"}/trade`,
);
console.log("\n   the breakeven exit is optimistic: it assumes the fill lands exactly at cost,");
console.log("   which a 1-minute price series cannot show. Treat it as an upper bound.");
