/**
 * Offline backtest harness for the "Early Push" 5-minute Up/Down strategy.
 *
 * Everything here is real: candles come from Binance's public REST API and every
 * round is replayed causally — the engine only ever sees data that had already
 * happened — then graded against the real close of the round (close vs the
 * round's opening price), exactly like the live journal grades it.
 *
 * Two replays are implemented, because they answer different questions:
 *
 *  - `snapshot` evaluates a round once, with a full first minute of information.
 *  - `live` reproduces the real console: it re-evaluates every second of the
 *    opening window using real 1-second prices and locks the FIRST qualifying
 *    call, with the forming 1-minute candle built up causally (high/low/volume
 *    accumulated second by second, never peeking at the finished minute).
 *
 * Run:
 *   bun scripts/backtest-strategy.ts baseline 30 lerp
 *   bun scripts/backtest-strategy.ts live 30
 *   bun scripts/backtest-strategy.ts sweep 30 close
 *
 * Cached klines live in scripts/.cache and are reused between runs.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  DEFAULT_CONFIG,
  evaluateSignal,
  type StrategyConfig,
} from "../src/lib/strategy/engine";
import type { Candle, MarketSymbol } from "../src/lib/market/types";

const MINUTE = 60_000;
const ROUND_MS = 5 * MINUTE;
const SYMBOLS: MarketSymbol[] = ["BTCUSDT", "ETHUSDT"];
const REST_BASE = "https://data-api.binance.vision";
const CACHE_DIR = join(import.meta.dir, ".cache");

type RestKline = [
  number,
  string,
  string,
  string,
  string,
  string,
  number,
  string,
  number,
  string,
  string,
  string,
];

function parseKline(row: RestKline): Candle {
  return {
    openTime: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
    closeTime: Number(row[6]),
    quoteVolume: Number(row[7]),
    trades: Number(row[8]),
    takerBuyBase: Number(row[9]),
    takerBuyQuote: Number(row[10]),
  };
}

type SecondBar = {
  close: number;
  high: number;
  low: number;
  volume: number;
  takerBuyBase: number;
};

async function paginate(
  symbol: MarketSymbol,
  interval: string,
  startMs: number,
  endMs: number,
  stepMs: number,
  onRows: (rows: RestKline[]) => void,
) {
  let cursor = startMs;
  while (cursor < endMs) {
    const url = `${REST_BASE}/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${cursor}&endTime=${endMs}&limit=1000`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${symbol} ${interval} responded ${response.status}`);
    const rows = (await response.json()) as RestKline[];
    if (rows.length === 0) break;
    onRows(rows);
    if (rows.length < 1000) break;
    cursor = Number(rows[rows.length - 1][0]) + stepMs;
    await new Promise((resolve) => setTimeout(resolve, 70));
  }
}

async function loadCandles(symbol: MarketSymbol, days: number): Promise<Candle[]> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const file = join(CACHE_DIR, `${symbol}-${days}d.json`);
  if (existsSync(file)) {
    return JSON.parse(readFileSync(file, "utf8")) as Candle[];
  }
  const end = Date.now() - 2 * MINUTE;
  const start = end - days * 24 * 60 * MINUTE;
  const candles: Candle[] = [];
  await paginate(symbol, "1m", start, end, MINUTE, (rows) => {
    for (const row of rows) candles.push(parseKline(row));
  });
  writeFileSync(file, JSON.stringify(candles));
  return candles;
}

async function loadSeconds(
  symbol: MarketSymbol,
  days: number,
): Promise<Map<number, SecondBar>> {
  mkdirSync(CACHE_DIR, { recursive: true });
  const file = join(CACHE_DIR, `${symbol}-${days}d-1s.json`);
  if (existsSync(file)) {
    return new Map(JSON.parse(readFileSync(file, "utf8")) as [number, SecondBar][]);
  }
  const end = Date.now() - 2000;
  const start = end - days * 24 * 60 * MINUTE;
  const bars = new Map<number, SecondBar>();
  await paginate(symbol, "1s", start, end, 1000, (rows) => {
    for (const row of rows) {
      bars.set(Number(row[0]), {
        close: Number(row[4]),
        high: Number(row[2]),
        low: Number(row[3]),
        volume: Number(row[5]),
        takerBuyBase: Number(row[9]),
      });
    }
  });
  writeFileSync(file, JSON.stringify([...bars.entries()]));
  return bars;
}

type RoundIndex = { index: number; symbol: MarketSymbol };

function indexRounds(candles: Candle[], symbol: MarketSymbol): RoundIndex[] {
  const rounds: RoundIndex[] = [];
  for (let i = 30; i + 4 < candles.length; i += 1) {
    const open = candles[i];
    if (open.openTime % ROUND_MS !== 0) continue;
    let contiguous = true;
    for (let k = 1; k <= 4; k += 1) {
      if (candles[i + k].openTime !== open.openTime + k * MINUTE) {
        contiguous = false;
        break;
      }
    }
    if (!contiguous) continue;
    rounds.push({ index: i, symbol });
  }
  return rounds;
}

type PriceMode = "lerp" | "close";

type RunStats = {
  signals: number;
  wins: number;
  losses: number;
  ties: number;
  rounds: number;
  accuracy: number | null;
};

function emptyStats(rounds: number): RunStats {
  return { signals: 0, wins: 0, losses: 0, ties: 0, rounds, accuracy: null };
}

function finish(stats: RunStats): RunStats {
  const decisive = stats.wins + stats.losses;
  stats.accuracy = decisive === 0 ? null : stats.wins / decisive;
  return stats;
}

function gradeRound(
  candles: Candle[],
  round: RoundIndex,
  direction: "up" | "down",
): { win: boolean; tie: boolean } {
  const reference = candles[round.index].open;
  const close = candles[round.index + 4].close;
  const moved = close - reference;
  if (moved === 0) return { win: false, tie: true };
  const settled: "up" | "down" = moved > 0 ? "up" : "down";
  return { win: settled === direction, tie: false };
}

function tap(stats: RunStats, result: { win: boolean; tie: boolean }) {
  stats.signals += 1;
  if (result.tie) stats.ties += 1;
  else if (result.win) stats.wins += 1;
  else stats.losses += 1;
}

/** The engine input for one round: 1-minute history ending on the forming candle. */
function historyFor(candles: Candle[], round: RoundIndex): Candle[] {
  return candles.slice(Math.max(0, round.index - 199), round.index + 1);
}

function snapshotCall(
  candles: Candle[],
  round: RoundIndex,
  offset: number,
  mode: PriceMode,
  config: StrategyConfig,
  invert: boolean,
): "up" | "down" | null {
  const opening = candles[round.index];
  const price =
    mode === "close"
      ? opening.close
      : opening.open + (opening.close - opening.open) * (offset / MINUTE);
  const readout = evaluateSignal({
    symbol: round.symbol,
    candles: historyFor(candles, round),
    price,
    now: opening.openTime + offset,
    config,
  });
  if (!readout || readout.direction === "stand-aside") return null;
  return invert ? (readout.direction === "up" ? "down" : "up") : readout.direction;
}

function backtestSnapshot(
  bySymbol: Map<MarketSymbol, Candle[]>,
  rounds: RoundIndex[],
  offset: number,
  mode: PriceMode,
  config: StrategyConfig,
  invert = false,
): RunStats {
  const stats = emptyStats(rounds.length);
  for (const round of rounds) {
    const candles = bySymbol.get(round.symbol)!;
    const call = snapshotCall(candles, round, offset, mode, config, invert);
    if (!call) continue;
    tap(stats, gradeRound(candles, round, call));
  }
  return finish(stats);
}

/**
 * Faithful replay of the live console: walk the opening window second by
 * second, keeping the forming 1-minute candle causal, and lock the first
 * directional call. Returns the lock second for every call so the distribution
 * of entry timing is visible.
 */
function backtestLive(
  bySymbol: Map<MarketSymbol, Candle[]>,
  seconds: Map<MarketSymbol, Map<number, SecondBar>>,
  rounds: RoundIndex[],
  config: StrategyConfig,
  fromSecond = 1,
  toSecond = 59,
): RunStats & { lockSeconds: number[] } {
  const stats = emptyStats(rounds.length);
  const lockSeconds: number[] = [];

  for (const round of rounds) {
    const candles = bySymbol.get(round.symbol)!;
    const sec = seconds.get(round.symbol)!;
    const opening = candles[round.index];
    const windowStart = opening.openTime;
    const history = historyFor(candles, round);

    // Causal accumulators: minute 1 while t < 60, minute 2 after it closes.
    let high1 = opening.open;
    let low1 = opening.open;
    let vol1 = 0;
    let buy1 = 0;
    let high2 = opening.close;
    let low2 = opening.close;
    let vol2 = 0;
    let buy2 = 0;

    for (let t = fromSecond; t <= toSecond; t += 1) {
      const bar = sec.get(windowStart + (t - 1) * 1000);
      if (!bar) continue;

      let series: Candle[];
      if (t < 60) {
        high1 = Math.max(high1, bar.high);
        low1 = Math.min(low1, bar.low);
        vol1 += bar.volume;
        buy1 += bar.takerBuyBase;
        // The forming first minute, as the websocket would describe it now.
        const formed: Candle = {
          ...opening,
          high: high1,
          low: low1,
          close: bar.close,
          volume: vol1,
          takerBuyBase: buy1,
          quoteVolume: bar.close * vol1,
        };
        series = history.slice(0, -1).concat(formed);
      } else {
        // The first minute is closed and present in `history` with real values;
        // only the second minute is still forming.
        high2 = Math.max(high2, bar.high);
        low2 = Math.min(low2, bar.low);
        vol2 += bar.volume;
        buy2 += bar.takerBuyBase;
        const forming: Candle = {
          openTime: windowStart + MINUTE,
          open: opening.close,
          high: high2,
          low: low2,
          close: bar.close,
          closeTime: windowStart + MINUTE + 59_999,
          volume: vol2,
          quoteVolume: bar.close * vol2,
          trades: 0,
          takerBuyBase: buy2,
          takerBuyQuote: 0,
        };
        series = history.concat(forming);
      }

      const readout = evaluateSignal({
        symbol: round.symbol,
        candles: series,
        price: bar.close,
        now: windowStart + t * 1000,
        config,
      });
      if (readout && readout.direction !== "stand-aside") {
        lockSeconds.push(t);
        tap(stats, gradeRound(candles, round, readout.direction));
        break;
      }
    }
  }
  return { ...finish(stats), lockSeconds };
}

function lockHistogram(lockSeconds: number[]): string {
  const buckets = new Map<number, number>();
  for (const second of lockSeconds) {
    const bucket = Math.floor(second / 10) * 10;
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([bucket, count]) => `${bucket}-${bucket + 9}s:${count}`)
    .join("  ");
}

function pct(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

const HEADER = [
  "config".padEnd(36),
  "sig".padStart(6),
  "acc".padStart(7),
  "win".padStart(5),
  "loss".padStart(5),
  "cover".padStart(7),
].join(" ");

function line(label: string, stats: RunStats): string {
  return [
    label.padEnd(36),
    String(stats.signals).padStart(6),
    pct(stats.accuracy).padStart(7),
    String(stats.wins).padStart(5),
    String(stats.losses).padStart(5),
    `${((stats.signals / stats.rounds) * 100).toFixed(1)}%`.padStart(7),
  ].join(" ");
}

function sweepGrid(): StrategyConfig[] {
  const configs: StrategyConfig[] = [];
  for (const minCushionAtr of [0.35, 0.6, 0.9, 1.2, 1.6]) {
    for (const minScore of [0.3, 0.4, 0.5]) {
      for (const minTrendSeparationAtr of [0.2, 0.35]) {
        for (const minAlignedFactors of [5, 6]) {
          for (const maxEntryScore of [0.62, 1]) {
            configs.push({
              ...DEFAULT_CONFIG,
              minCushionAtr,
              minScore,
              minTrendSeparationAtr,
              minAlignedFactors,
              maxEntryScore,
            });
          }
        }
      }
    }
  }
  return configs;
}

function describe(config: StrategyConfig): string {
  return `cush=${config.minCushionAtr} score=${config.minScore} align=${config.minAlignedFactors} trend=${config.minTrendSeparationAtr} max=${config.maxEntryScore}`;
}

async function main() {
  const command = process.argv[2] ?? "baseline";
  const days = Number(process.argv[3] ?? 30);
  const mode = (process.argv[4] as PriceMode) ?? "close";

  const bySymbol = new Map<MarketSymbol, Candle[]>();
  const rounds: RoundIndex[] = [];
  for (const symbol of SYMBOLS) {
    const candles = await loadCandles(symbol, days);
    bySymbol.set(symbol, candles);
    rounds.push(...indexRounds(candles, symbol));
  }

  if (command === "live") {
    const seconds = new Map<MarketSymbol, Map<number, SecondBar>>();
    for (const symbol of SYMBOLS) {
      const bars = await loadSeconds(symbol, Math.min(days, 2));
      seconds.set(symbol, bars);
      console.log(`${symbol}: ${bars.size} one-second bars`);
    }
    let first = Number.POSITIVE_INFINITY;
    let last = Number.NEGATIVE_INFINITY;
    for (const bars of seconds.values()) {
      for (const openTime of bars.keys()) {
        if (openTime < first) first = openTime;
        if (openTime > last) last = openTime;
      }
    }
    const inWindow = rounds.filter(
      (r) => bySymbol.get(r.symbol)![r.index].openTime >= first && bySymbol.get(r.symbol)![r.index].openTime + ROUND_MS <= last,
    );
    console.log(`${inWindow.length} rounds inside the 1-second window`);
    console.log(HEADER);

    const live = backtestLive(bySymbol, seconds, inWindow, DEFAULT_CONFIG);
    console.log(line("live replay (first qualifying second)", live));
    const sameRoundsSnapshot = backtestSnapshot(
      bySymbol,
      inWindow,
      58_000,
      "close",
      DEFAULT_CONFIG,
    );
    console.log(line("same rounds @58s (full 1st minute)", sameRoundsSnapshot));

    console.log("lock timing:", lockHistogram(live.lockSeconds));
    return;
  }

  if (command === "validatelive") {
    const seconds = new Map<MarketSymbol, Map<number, SecondBar>>();
    for (const symbol of SYMBOLS) {
      seconds.set(symbol, await loadSeconds(symbol, Math.min(days, 2)));
    }
    let first = Number.POSITIVE_INFINITY;
    let last = Number.NEGATIVE_INFINITY;
    for (const bars of seconds.values()) {
      for (const openTime of bars.keys()) {
        if (openTime < first) first = openTime;
        if (openTime > last) last = openTime;
      }
    }
    const inWindow = rounds.filter(
      (r) =>
        bySymbol.get(r.symbol)![r.index].openTime >= first &&
        bySymbol.get(r.symbol)![r.index].openTime + ROUND_MS <= last,
    );
    console.log(`${inWindow.length} rounds with real 1-second prices`);
    console.log(HEADER);

    // A: the old rule — lock the first qualifying second of the opening minute.
    // With the shipped config this must produce nothing: `prepare` blocks it.
    const oldRule = backtestLive(
      bySymbol,
      seconds,
      inWindow,
      { ...DEFAULT_CONFIG, minEntryElapsedMs: 0 },
      1,
      59,
    );
    console.log(line("A old rule: lock inside 1st minute", oldRule));

    // B: the shipped rule — only after the round's first minute closes.
    const confirmBase: StrategyConfig = DEFAULT_CONFIG;
    const proposed = backtestLive(bySymbol, seconds, inWindow, confirmBase, 60, 89);
    console.log(line("B shipped: confirmation window", proposed));
    console.log("B lock timing:", lockHistogram(proposed.lockSeconds));

    // Sensitivity of the shipped rule to the cushion, on the same rounds.
    console.log("\n-- shipped rule, cushion sensitivity (live replay) --");
    for (const minCushionAtr of [0.35, 0.5, 0.7, 0.9, 1.2]) {
      for (const maxEntryScore of [0.62, 0.9]) {
        const stats = backtestLive(
          bySymbol,
          seconds,
          inWindow,
          { ...confirmBase, minCushionAtr, maxEntryScore },
          60,
          89,
        );
        console.log(line(`cush=${minCushionAtr} max=${maxEntryScore}`, stats));
      }
    }
    return;
  }

  const offset = mode === "close" ? 58_000 : 30_000;
  console.log(`${rounds.length} rounds · offset ${offset / 1000}s · price=${mode}`);
  console.log(HEADER);

  if (command === "baseline") {
    console.log(
      line("baseline (shipped config)", backtestSnapshot(bySymbol, rounds, offset, mode, DEFAULT_CONFIG)),
    );
    console.log(
      line(
        "baseline inverted",
        backtestSnapshot(bySymbol, rounds, offset, mode, DEFAULT_CONFIG, true),
      ),
    );
    return;
  }

  if (command === "confirm") {
    // The proposed rule: the round's first 1-minute candle must have closed
    // before the engine is allowed to commit.
    const base: StrategyConfig = {
      ...DEFAULT_CONFIG,
      entryWindowMs: 120_000,
      entryCutoffMs: 180_000,
    };
    const offsetMs = 62_000;
    const confirmResults: { label: string; stats: RunStats }[] = [];
    for (const minCushionAtr of [0.35, 0.5, 0.7, 0.9, 1.2]) {
      for (const minScore of [0.3, 0.4, 0.5]) {
        for (const minAlignedFactors of [5, 6]) {
          for (const minTrendSeparationAtr of [0.2, 0.35]) {
            for (const maxEntryScore of [0.62, 1]) {
              const config = {
                ...base,
                minCushionAtr,
                minScore,
                minAlignedFactors,
                minTrendSeparationAtr,
                maxEntryScore,
              };
              confirmResults.push({
                label: describe(config),
                stats: backtestSnapshot(bySymbol, rounds, offsetMs, "close", config),
              });
            }
          }
        }
      }
    }
    console.log("\n-- cushion sweep (score=0.3 align=5 trend=0.2) --");
    for (const entry of confirmResults.filter((item) =>
      item.label.includes("score=0.3 align=5 trend=0.2"),
    )) {
      console.log(line(entry.label, entry.stats));
    }

    const rankedConfirm = confirmResults
      .filter((entry) => entry.stats.signals >= 100)
      .sort((a, b) => (b.stats.accuracy ?? 0) - (a.stats.accuracy ?? 0));
    console.log("\n-- blowoff ceiling at cush=0.5 (confirm window) --");
    for (const maxEntryScore of [0.62, 0.75, 0.9, 1]) {
      const stats = backtestSnapshot(
        bySymbol,
        rounds,
        offsetMs,
        "close",
        { ...base, minCushionAtr: 0.5, maxEntryScore },
      );
      console.log(line(`cush=0.5 max=${maxEntryScore}`, stats));
    }

    // Stability: does the chosen rule hold on both halves of the sample and on
    // each asset independently? A rule that only works in one window is noise.
    const chosen: StrategyConfig = {
      ...base,
      minCushionAtr: 0.5,
      maxEntryScore: 1,
    };
    const times = rounds.map((r) => bySymbol.get(r.symbol)![r.index].openTime);
    const mid = [...times].sort((a, b) => a - b)[Math.floor(times.length / 2)];
    const firstHalf = rounds.filter((r) => bySymbol.get(r.symbol)![r.index].openTime < mid);
    const secondHalf = rounds.filter((r) => bySymbol.get(r.symbol)![r.index].openTime >= mid);

    console.log("\n-- chosen rule (cush=0.5, confirm window) stability --");
    console.log(line("full sample", backtestSnapshot(bySymbol, rounds, offsetMs, "close", chosen)));
    console.log(line("first half", backtestSnapshot(bySymbol, firstHalf, offsetMs, "close", chosen)));
    console.log(line("second half", backtestSnapshot(bySymbol, secondHalf, offsetMs, "close", chosen)));
    for (const symbol of SYMBOLS) {
      console.log(
        line(
          symbol,
          backtestSnapshot(bySymbol, rounds.filter((r) => r.symbol === symbol), offsetMs, "close", chosen),
        ),
      );
    }

    console.log("\n-- top 10 by accuracy (>=100 signals) --");
    for (const entry of rankedConfirm.slice(0, 10)) {
      console.log(line(entry.label, entry.stats));
    }
    return;
  }

  if (command === "control") {
    // Engine-free control. The strategy's whole bet is "the round continues the
    // direction the opening minute moved". Measure that raw edge directly, with
    // no engine, no factors and no guards — so a mechanical edge ("the price is
    // already on one side of the round open, so it more often finishes there")
    // cannot hide behind a 73% headline.
    const rows: { move: number; settledUp: boolean }[] = [];
    for (const round of rounds) {
      const candles = bySymbol.get(round.symbol)!;
      const i = round.index;
      const atr = Math.max(
        candles
          .slice(Math.max(0, i - 14), i)
          .reduce((a, c) => a + (c.high - c.low) / c.close, 0) / 14,
        1e-6,
      );
      const firstMinuteMove = (candles[i].close - candles[i].open) / candles[i].open;
      const roundMove = candles[i + 4].close - candles[i].open;
      rows.push({ move: firstMinuteMove / atr, settledUp: roundMove > 0 });
    }
    const upRate = rows.filter((r) => r.settledUp).length / rows.length;
    console.log(`${rows.length} rounds · unconditional P(up) = ${(upRate * 100).toFixed(1)}%`);
    console.log(
      [
        "|1st-min move|".padEnd(16),
        "rounds".padStart(7),
        "continuation".padStart(13),
        "reversion".padStart(10),
      ].join(" "),
    );
    for (const k of [0, 0.25, 0.5, 0.75, 1, 1.5]) {
      const picked = rows.filter((r) => Math.abs(r.move) >= k);
      const contWin = picked.filter((r) => (r.move > 0) === r.settledUp).length;
      const revertWin = picked.length - contWin;
      console.log(
        [
          `>= ${k} ATR`.padEnd(16),
          String(picked.length).padStart(7),
          `${((contWin / picked.length) * 100).toFixed(1)}%`.padStart(13),
          `${((revertWin / picked.length) * 100).toFixed(1)}%`.padStart(10),
        ].join(" "),
      );
    }
    console.log(
      "\ncontinuation = betting the round finishes the way its 1st minute moved",
    );
    return;
  }

  const results: { label: string; stats: RunStats }[] = [];
  for (const config of sweepGrid()) {
    for (const invert of [false, true]) {
      results.push({
        label: `${invert ? "INV " : ""}${describe(config)}`,
        stats: backtestSnapshot(bySymbol, rounds, offset, mode, config, invert),
      });
    }
  }

  const ranked = results
    .filter((entry) => entry.stats.signals >= 40)
    .sort((a, b) => (b.stats.accuracy ?? 0) - (a.stats.accuracy ?? 0));

  for (const entry of ranked.slice(0, 30)) {
    console.log(line(entry.label, entry.stats));
  }
}

await main();
