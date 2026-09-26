/**
 * Offline study of Polymarket's 5-minute BTC/ETH "Up or Down" markets using
 * REAL prices from Polymarket itself.
 *
 * Why this exists: the Binance-side strategy was graded against an invented
 * entry price. Here every entry price is the actual Polymarket price of the
 * contract at the moment we would have bought it, and every outcome is the
 * real resolution (Chainlink BTC/USD / ETH/USD, reported by Gamma). If a rule
 * cannot make money against these numbers, it cannot make money at all.
 *
 * Data sources (all public, no keys):
 *   Gamma  https://gamma-api.polymarket.com/events?slug=<slug>
 *   CLOB   https://clob.polymarket.com/prices-history?market=<upTokenId>&...
 *
 * Market slug pattern: btc-updown-5m-<intervalStartUnixSeconds>
 *
 * Run:
 *   bun scripts/polymarket-5m.ts 2
 *
 * Raw rounds are cached in scripts/.cache/polymarket-<days>d.json.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { evaluateSignal } from "../src/lib/strategy/engine";
import type { Candle, MarketSymbol } from "../src/lib/market/types";

const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";
const ROUND_S = 300;
const CACHE_DIR = join(import.meta.dir, ".cache");
const ASSETS = ["btc", "eth"] as const;
type Asset = (typeof ASSETS)[number];

type Sample = { t: number; p: number };
type Round = {
  asset: Asset;
  /** Interval start, unix seconds. */
  t0: number;
  /** null when the market did not resolve cleanly to 1/0. */
  upWon: boolean | null;
  samples: Sample[];
};

async function getJson(url: string, attempt = 0): Promise<unknown> {
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "polymarket-5m-study" },
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 429 && attempt < 4) {
      await sleep(400 * 2 ** attempt);
      return getJson(url, attempt + 1);
    }
    if (!response.ok) throw new Error(`${response.status} ${url}`);
    return await response.json();
  } catch (error) {
    if (attempt < 3) {
      await sleep(300 * 2 ** attempt);
      return getJson(url, attempt + 1);
    }
    throw error;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Run `fn` over `items` with bounded concurrency, preserving order. */
async function pool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function loadRound(asset: Asset, t0: number): Promise<Round> {
  const empty: Round = { asset, t0, upWon: null, samples: [] };
  let event: Record<string, unknown> | undefined;
  try {
    const events = (await getJson(
      `${GAMMA}/events?slug=${asset}-updown-5m-${t0}`,
    )) as Record<string, unknown>[];
    event = events[0];
  } catch {
    return empty;
  }
  if (!event) return empty;

  const markets = (event.markets as Record<string, unknown>[] | undefined) ?? [];
  const market = markets[0];
  if (!market) return empty;

  let upWon: boolean | null = null;
  try {
    const prices = JSON.parse(String(market.outcomePrices)) as string[];
    if (prices[0] === "1" && prices[1] === "0") upWon = true;
    else if (prices[0] === "0" && prices[1] === "1") upWon = false;
  } catch {
    /* unresolved or odd shape */
  }
  if (upWon === null) return empty;

  let upToken: string | undefined;
  try {
    upToken = (JSON.parse(String(market.clobTokenIds)) as string[])[0];
  } catch {
    return { ...empty, upWon };
  }
  if (!upToken) return { ...empty, upWon };

  try {
    const history = (await getJson(
      `${CLOB}/prices-history?market=${upToken}&startTs=${t0}&endTs=${t0 + ROUND_S}&fidelity=1`,
    )) as { history?: Sample[] };
    return { asset, t0, upWon, samples: history.history ?? [] };
  } catch {
    return { asset, t0, upWon, samples: [] };
  }
}

const CACHE_FILE = join(CACHE_DIR, "polymarket-5m-cache.json");

/**
 * Fetch any rounds in the window that are not cached yet and merge them into a
 * single growing cache. Re-running with a bigger window only downloads the new
 * days, so we can accumulate history in chunks that fit the command timeout.
 */
async function loadAll(days: number): Promise<Round[]> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const cache = new Map<string, Round>();
  if (existsSync(CACHE_FILE)) {
    for (const round of JSON.parse(readFileSync(CACHE_FILE, "utf8")) as Round[]) {
      cache.set(`${round.asset}-${round.t0}`, round);
    }
  }

  const nowS = Math.floor(Date.now() / 1000);
  // Leave the two most recent rounds out: they may not have resolved yet.
  const lastStart = Math.floor((nowS - 2 * ROUND_S) / ROUND_S) * ROUND_S;
  const firstStart = lastStart - days * 24 * 60 * 60;

  const jobs: { asset: Asset; t0: number; key: string }[] = [];
  for (let t0 = firstStart; t0 < lastStart; t0 += ROUND_S) {
    for (const asset of ASSETS) {
      const key = `${asset}-${t0}`;
      const cached = cache.get(key);
      if (cached && cached.upWon !== null) continue;
      jobs.push({ asset, t0, key });
    }
  }

  if (jobs.length > 0) {
    console.log(`fetching ${jobs.length} new rounds (window ${days}d)...`);
    let done = 0;
    await pool(jobs, 10, async ({ asset, t0, key }) => {
      cache.set(key, await loadRound(asset, t0));
      done += 1;
      if (done % 400 === 0) console.log(`  ${done}/${jobs.length}`);
    });
    writeFileSync(CACHE_FILE, JSON.stringify([...cache.values()]));
  }

  const result: Round[] = [];
  for (let t0 = firstStart; t0 < lastStart; t0 += ROUND_S) {
    for (const asset of ASSETS) {
      const round = cache.get(`${asset}-${t0}`);
      if (round) result.push(round);
    }
  }
  console.log(`window ${days}d: ${result.length} rounds (${result.filter((r) => r.upWon !== null).length} resolved)`);
  return result.filter((round) => round.upWon !== null);
}

/** The entry price we would actually have paid: the first quote at or after `at`. */
function priceAt(round: Round, atSeconds: number): number | null {
  const relative = round.samples.map((s) => ({ dt: s.t - round.t0, p: s.p }));
  const picked = relative.find((s) => s.dt >= atSeconds);
  if (!picked) return null;
  return picked.p;
}

function pct(value: number | null, digits = 1): string {
  return value === null ? "—" : `${value >= 0 ? "+" : ""}${(value * 100).toFixed(digits)}%`;
}

function analyse(rounds: Round[], entrySeconds: number) {
  const usable = rounds
    .map((round) => ({ round, p: priceAt(round, entrySeconds) }))
    .filter((row): row is { round: Round; p: number } => row.p !== null);

  console.log(
    `\n=== ${usable.length} rounds with a price at t+${entrySeconds}s ` +
      `(of ${rounds.length} resolved) ===`,
  );

  // EV of buying UP at the real price. EV of buying DOWN is the mirror image,
  // so one number covers both.
  let evUp = 0;
  let cheapWin = 0;
  let cheapTotal = 0;
  for (const { round, p } of usable) {
    const payoff = round.upWon ? 1 : 0;
    evUp += payoff - p;
    if (p < 0.5) {
      cheapTotal += 1;
      cheapWin += payoff;
    }
  }
  console.log(`EV of buying UP   at the real price: ${pct(evUp / usable.length)} per $1`);
  console.log(`EV of buying DOWN at the real price: ${pct(-evUp / usable.length)} per $1`);
  console.log(
    `when UP is cheap (<0.50): ${cheapWin}/${cheapTotal} = ${
      cheapTotal ? ((cheapWin / cheapTotal) * 100).toFixed(1) : "—"
    }% actually won`,
  );

  // Calibration: does the real price match the realised frequency?
  const bins = [
    [0, 0.2],
    [0.2, 0.35],
    [0.35, 0.5],
    [0.5, 0.65],
    [0.65, 0.8],
    [0.8, 1.01],
  ];
  console.log("\nprice bucket   rounds   market says   actually won   bias");
  for (const [lo, hi] of bins) {
    const rows = usable.filter(({ p }) => p >= lo && p < hi);
    if (rows.length === 0) continue;
    const avgPrice = rows.reduce((a, r) => a + r.p, 0) / rows.length;
    const wins = rows.filter((r) => r.round.upWon).length;
    const actual = wins / rows.length;
    console.log(
      [
        `${lo.toFixed(2)}-${hi.toFixed(2)}`.padEnd(14),
        String(rows.length).padStart(6),
        `${(avgPrice * 100).toFixed(1)}%`.padStart(13),
        `${(actual * 100).toFixed(1)}%`.padStart(14),
        pct(actual - avgPrice).padStart(7),
      ].join("  "),
    );
  }
}

const SYMBOL_OF: Record<Asset, MarketSymbol> = { btc: "BTCUSDT", eth: "ETHUSDT" };

/**
 * The real test: take the live engine's call at t+60s and pay the REAL
 * Polymarket price for that side. This mirrors the journal's two columns —
 * simulated P&L (the engine's own formula price) next to real P&L.
 */
function runEngineJoin(rounds: Round[], binanceDays: number) {
  for (const asset of ASSETS) {
    if (!loadBinance(SYMBOL_OF[asset], binanceDays)) return;
  }

  let signals = 0;
  let wins = 0;
  let realPnl = 0;
  let simPnl = 0;
  let costSum = 0;
  let simCostSum = 0;
  const rows: { cost: number; sim: number; payoff: number }[] = [];

  for (const round of rounds) {
    if (round.upWon === null) continue;
    const symbol = SYMBOL_OF[round.asset];
    const lookup = indexes.get(symbol);
    const candles = candlesOf.get(symbol);
    if (!lookup || !candles) continue;
    const i = lookup.get(round.t0 * 1000);
    if (i === undefined || i < 30 || i + 4 >= candles.length) continue;

    const entry = priceAt(round, 60);
    if (entry === null) continue;

    const readout = evaluateSignal({
      symbol,
      candles: candles.slice(Math.max(0, i - 199), i + 1),
      price: candles[i].close,
      now: round.t0 * 1000 + 60_000,
    });
    if (!readout || readout.direction === "stand-aside") continue;

    const settled: "up" | "down" = round.upWon ? "up" : "down";
    const payoff = readout.direction === settled ? 1 : 0;
    const realCost = readout.direction === "up" ? entry : 1 - entry;
    const simCost = readout.maxEntryPrice;

    signals += 1;
    wins += payoff;
    realPnl += payoff - realCost;
    simPnl += payoff - simCost;
    costSum += realCost;
    simCostSum += simCost;
    rows.push({ cost: realCost, sim: simCost, payoff });
  }

  if (signals === 0) {
    console.log("\nengine produced no call that lines up with the Polymarket rounds");
    return;
  }
  console.log(`\n=== engine call at t+60s, real Polymarket prices ===`);
  console.log(`signals          ${signals}`);
  console.log(`hit rate         ${((wins / signals) * 100).toFixed(1)}%`);
  console.log(`avg real price   ${(costSum / signals).toFixed(3)}`);
  console.log(`avg sim price    ${(simCostSum / signals).toFixed(3)}`);
  const sd = Math.sqrt(
    rows.reduce((a, r) => a + (r.payoff - r.cost - realPnl / signals) ** 2, 0) / signals,
  );
  console.log(`sim P&L ($1)     ${(simPnl / signals).toFixed(3)}/trade  total ${simPnl.toFixed(2)}`);
  console.log(
    `REAL P&L ($1)    ${(realPnl / signals).toFixed(3)}/trade  total ${realPnl.toFixed(2)}`,
  );
  console.log(
    `             ± se ${(sd / Math.sqrt(signals)).toFixed(3)}  (edge is significant only if |mean| > 2·se)`,
  );

  console.log("\nreal price bucket   n    hit rate   avg cost   EV/trade");
  for (const [lo, hi] of [
    [0, 0.5],
    [0.5, 0.6],
    [0.6, 0.7],
    [0.7, 0.8],
    [0.8, 1.01],
  ]) {
    const bucket = rows.filter((r) => r.cost >= lo && r.cost < hi);
    if (bucket.length === 0) continue;
    const ev = bucket.reduce((a, r) => a + r.payoff - r.cost, 0) / bucket.length;
    const win = bucket.filter((r) => r.payoff === 1).length / bucket.length;
    console.log(
      [
        `${lo.toFixed(2)}-${hi.toFixed(2)}`.padEnd(17),
        String(bucket.length).padStart(4),
        `${(win * 100).toFixed(1)}%`.padStart(10),
        (bucket.reduce((a, r) => a + r.cost, 0) / bucket.length).toFixed(3).padStart(10),
        `${ev >= 0 ? "+" : ""}${ev.toFixed(3)}`.padStart(10),
      ].join("   "),
    );
  }
}

const indexes = new Map<MarketSymbol, Map<number, number>>();
const candlesOf = new Map<MarketSymbol, Candle[]>();

/** Load the Binance 1m cache produced by scripts/backtest-strategy.ts. */
function loadBinance(symbol: MarketSymbol, days: number): boolean {
  const file = join(CACHE_DIR, `${symbol}-${days}d.json`);
  if (!existsSync(file)) {
    console.log(`missing Binance cache ${file}`);
    return false;
  }
  const candles = JSON.parse(readFileSync(file, "utf8")) as Candle[];
  const index = new Map<number, number>();
  candles.forEach((candle, i) => index.set(candle.openTime, i));
  indexes.set(symbol, index);
  candlesOf.set(symbol, candles);
  return true;
}

async function main() {
  const days = Number(process.argv[2] ?? 2);
  const rounds = await loadAll(days);
  console.log(`\n${rounds.length} resolved 5-minute rounds over ${days}d`);

  const withSamples = rounds.filter((r) => r.samples.length > 0);
  console.log(`${withSamples.length} carry a price path`);
  if (withSamples.length === 0) return;

  const first = withSamples[0];
  console.log("\nexample path:", first.asset, new Date(first.t0 * 1000).toISOString());
  for (const s of first.samples) {
    console.log(`   t+${String(s.t - first.t0).padStart(3)}s  up=${s.p}`);
  }

  if (process.argv[3] === "engine") {
    runEngineJoin(rounds, 30);
    return;
  }

  if (process.argv[3] === "favorite") {
    const at = Number(process.argv[4] ?? 60);
    const usable = rounds
      .map((round) => ({ round, p: priceAt(round, at) }))
      .filter((row): row is { round: Round; p: number } => row.p !== null);
    console.log(`\n=== buy the side priced >= X at t+${at}s (${usable.length} rounds) ===`);
    console.log("X       n     hit rate   avg cost   EV/trade      se");
    for (const th of [0.6, 0.7, 0.75, 0.8, 0.85, 0.9]) {
      const picks: { cost: number; payoff: number }[] = [];
      for (const { round, p } of usable) {
        if (p >= th) picks.push({ cost: p, payoff: round.upWon ? 1 : 0 });
        else if (1 - p >= th) picks.push({ cost: 1 - p, payoff: round.upWon ? 0 : 1 });
      }
      if (picks.length < 20) continue;
      const n = picks.length;
      const hit = picks.reduce((a, x) => a + x.payoff, 0) / n;
      const cost = picks.reduce((a, x) => a + x.cost, 0) / n;
      const ev = hit - cost;
      const sd = Math.sqrt(picks.reduce((a, x) => a + (x.payoff - hit) ** 2, 0) / n);
      console.log(
        [
          th.toFixed(2).padEnd(6),
          String(n).padStart(5),
          `${(hit * 100).toFixed(1)}%`.padStart(11),
          cost.toFixed(3).padStart(10),
          `${ev >= 0 ? "+" : ""}${ev.toFixed(4)}`.padStart(12),
          (sd / Math.sqrt(n)).toFixed(4).padStart(8),
        ].join("  "),
      );
    }
    // Stability: same rule (>= 0.80) split into time blocks and per asset.
    const TH = 0.8;
    const pick = (round: Round, p: number) =>
      p >= TH
        ? { cost: p, payoff: round.upWon ? 1 : 0 }
        : 1 - p >= TH
          ? { cost: 1 - p, payoff: round.upWon ? 0 : 1 }
          : null;
    const starts = usable.map((u) => u.round.t0).sort((a, b) => a - b);
    const span = starts[starts.length - 1] - starts[0] || 1;
    const blocks = 5;
    console.log(`\n--- rule >= ${TH}: stability ---`);
    for (let b = 0; b < blocks; b += 1) {
      const lo = starts[0] + (span * b) / blocks;
      const hi = starts[0] + (span * (b + 1)) / blocks;
      const picks = usable
        .filter((u) => u.round.t0 >= lo && u.round.t0 < hi)
        .map((u) => pick(u.round, u.p))
        .filter((x): x is { cost: number; payoff: number } => x !== null);
      if (picks.length === 0) continue;
      const n = picks.length;
      const ev = picks.reduce((a, x) => a + x.payoff - x.cost, 0) / n;
      const day = new Date(lo * 1000).toISOString().slice(5, 10);
      console.log(
        `  block ${b + 1} (from ${day})  n=${String(n).padStart(4)}  EV=${ev >= 0 ? "+" : ""}${ev.toFixed(4)}`,
      );
    }
    for (const asset of ASSETS) {
      const picks = usable
        .filter((u) => u.round.asset === asset)
        .map((u) => pick(u.round, u.p))
        .filter((x): x is { cost: number; payoff: number } => x !== null);
      if (picks.length === 0) continue;
      const ev = picks.reduce((a, x) => a + x.payoff - x.cost, 0) / picks.length;
      console.log(
        `  ${asset.toUpperCase()}  n=${String(picks.length).padStart(4)}  EV=${ev >= 0 ? "+" : ""}${ev.toFixed(4)}`,
      );
    }
    return;
  }

  if (process.argv[3] === "fills") {
    // The decisive question for a maker strategy: would a limit order at the
    // bid actually have been hit before the round resolved?
    //
    // We post at t+60 at the bid (last trade minus half a spread) on whichever
    // side is the favourite, then look at every later trade print in the round.
    // A print at or below our limit means someone sold into us.
    //
    // CAVEAT: prices-history is ~1-minute granularity, so we only observe ~3
    // prints after entry. This UNDERSTATES the fill rate; treat it as a floor.
    const ENTRY = 60;
    const FAVOURITE = 0.8;
    const at = Number(process.argv[4] ?? ENTRY);

    type Fill = { filled: boolean; cost: number; won: boolean; p0: number };
    const signals: Fill[] = [];

    for (const round of rounds) {
      if (round.upWon === null) continue;
      const samples = round.samples
        .map((s) => ({ dt: s.t - round.t0, p: s.p }))
        .sort((a, b) => a.dt - b.dt);
      const entry = samples.find((s) => s.dt >= at);
      if (!entry) continue;

      // Which side is the favourite, and what does that side cost?
      const up = entry.p >= 0.5;
      const side = up ? entry.p : 1 - entry.p;
      if (side < FAVOURITE) continue;

      const limit = Math.max(0.01, Math.round((side - 0.005) * 1000) / 1000);
      const later = samples.filter((s) => s.dt > entry.dt);
      const hit = later.some((s) => (up ? s.p : 1 - s.p) <= limit);
      signals.push({
        filled: hit,
        cost: limit,
        won: up === round.upWon,
        p0: side,
      });
    }

    const filled = signals.filter((s) => s.filled);
    const unfilled = signals.filter((s) => !s.filled);
    const pnl = (s: Fill) => (s.won ? 1 / s.cost - 1 : -1);
    const total = signals.length;
    const rate = (rows: Fill[]) =>
      rows.length === 0 ? "—" : `${((rows.filter((s) => s.won).length / rows.length) * 100).toFixed(1)}%`;

    console.log(`\n=== лимитная заявка на фаворита, вход t+${at}s ===`);
    console.log(`сигналов            ${total}`);
    console.log(`порог фаворита     ${FAVOURITE.toFixed(2)}`);
    console.log(`средняя цена входа ${(signals.reduce((a, s) => a + s.cost, 0) / total).toFixed(3)}`);
    console.log(`\nисполнено          ${filled.length} / ${total} = ${((filled.length / total) * 100).toFixed(1)}%  (нижняя оценка)`);
    console.log(`\nADVERSE SELECTION — сравнение двух групп:`);
    console.log(`  попадания среди НЕисполненных  ${rate(unfilled)}   (это базовая ставка фаворита)`);
    console.log(`  попадания среди ИСПОЛНЕННЫХ     ${rate(filled)}`);
    console.log(
      `  разница                        ${
        unfilled.length && filled.length
          ? `${(
              (filled.filter((s) => s.won).length / filled.length -
                unfilled.filter((s) => s.won).length / unfilled.length) *
                100
            ).toFixed(1)} п.п.`
          : "—"
      }`,
    );
    if (filled.length > 0) {
      const wins = filled.filter((s) => s.won).length;
      console.log(`попаданий среди исполненных ${wins}/${filled.length} = ${((wins / filled.length) * 100).toFixed(1)}%`);
      console.log(`\nP&L на исполненную сделку   ${(filled.reduce((a, s) => a + pnl(s), 0) / filled.length).toFixed(4)}`);
      console.log(`P&L на каждый сигнал        ${(filled.reduce((a, s) => a + pnl(s), 0) / total).toFixed(4)}  ← вот это и есть честный перевес`);
    } else {
      console.log("\nни одна заявка не была бы исполнена — перевес существует только на бумаге");
    }
    return;
  }

  if (process.argv[3] === "timing") {
    // Where along the round is the price cheapest relative to the outcome?
    // EV of buying UP at each available quote.
    for (const at of [0, 60, 120, 180, 240]) analyse(rounds, at);
    return;
  }

  analyse(rounds, 60);
  analyse(rounds, 90);
}

await main();
