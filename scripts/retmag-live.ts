/**
 * RetMag scored against the price you could ACTUALLY have paid.
 *
 * Companion to `retmag.ts`. That script settles the signal's direction but
 * prices it off an interpolated mid, which is why its P&L is an upper bound and
 * not a forecast: a market calibrated to +/-3pp cannot hand out 18pp.
 *
 * This one asks the only question that decides the trade:
 *
 *     did the signal beat the price, on rounds where a price existed?
 *
 * The input is `pmQuotes` — book snapshots the console archived while each
 * round was live, inside the +12s..+45s decision window. The Binance 1s bars are
 * re-fetched here rather than read from the old cache, because the archive only
 * covers recent rounds and the cached bars stopped days ago.
 *
 * Usage: bun scripts/retmag-live.ts [days]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REST = "https://api.binance.com";
const DEPLOY = process.env.CONVEX_URL ?? "";
const DAYS = Number(process.argv[2] ?? 3);

const ENTRY_OFFSET_MS = 20_000;
const FLOW_WINDOW_MS = 30_000;
const FLOW_THR = 0.25;
const RET_MAG_THR_BPS = 2.0;
const MAX_PRICE: Record<"btc" | "eth", number> = { btc: 0.6, eth: 0.7 };
const FEE_RATE = 0.02;
const SLIPPAGE = 0.005;
const STAKE = 5;

type Asset = "btc" | "eth";
type Bar = { t: number; close: number; volume: number; takerBuy: number };
type Quote = {
  roundStart: number;
  asset: Asset;
  interval: 5 | 15;
  t: number;
  upBid?: number;
  upAsk?: number;
  downBid?: number;
  downAsk?: number;
  priceSource?: string;
};

if (!DEPLOY) {
  console.error("set CONVEX_URL to the deployment to read pmQuotes");
  process.exit(1);
}

async function fetchQuotes(): Promise<Quote[]> {
  const { ConvexHttpClient } = await import("convex/browser");
  const { api } = await import("../src/convex/_generated/api");
  const client = new ConvexHttpClient(DEPLOY);
  return (await client.query(api.paper.listQuotes, { limit: 20000 })) as Quote[];
}

/** Fresh 1s bars, cached by day so repeated runs are cheap. */
async function loadSeconds(symbol: string, days: number): Promise<Bar[]> {
  const file = join(import.meta.dir, ".cache", `${symbol}USDT-live-1s.json`);
  if (existsSync(file)) {
    const cached = JSON.parse(readFileSync(file, "utf8")) as Bar[];
    // Only reuse if it reaches close to now; otherwise the archive and the
    // bars describe different days and the join is silently empty.
    const newest = cached.length ? cached[cached.length - 1].t : 0;
    if (newest > Date.now() - 30 * 60_000) return cached;
  }
  const end = Date.now() - 5_000;
  const start = end - days * 24 * 60 * 60_000;
  const bars: Bar[] = [];
  let cursor = start;
  while (cursor < end) {
    const url = `${REST}/api/v3/klines?symbol=${symbol}USDT&interval=1s&startTime=${cursor}&endTime=${end}&limit=1000`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${symbol} 1s responded ${res.status}`);
    const rows = (await res.json()) as number[][];
    if (rows.length === 0) break;
    for (const r of rows) {
      bars.push({
        t: Number(r[0]),
        close: Number(r[4]),
        volume: Number(r[5]),
        takerBuy: Number(r[9]),
      });
    }
    cursor = Number(rows[rows.length - 1][0]) + 1000;
    if (rows.length < 1000) break;
  }
  bars.sort((a, b) => a.t - b.t);
  writeFileSync(file, JSON.stringify(bars));
  return bars;
}

const closeAt = (bars: Bar[], t: number): Bar | null => {
  let lo = 0;
  let hi = bars.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].t <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found >= 0 ? bars[found] : null;
};

type Row = {
  side: "UP" | "DOWN";
  /** The ask actually paid, from the archived book. */
  ask: number;
  won: boolean;
  net: number;
};

const analyse = (asset: Asset, quotes: Quote[], bars: Bar[], useGate: boolean) => {
  const byRound = new Map<number, Quote[]>();
  for (const q of quotes) {
    if (q.asset !== asset) continue;
    const list = byRound.get(q.roundStart) ?? [];
    list.push(q);
    byRound.set(q.roundStart, list);
  }

  const rows: Row[] = [];
  let noQuote = 0;
  let noOutcome = 0;
  for (const [roundStart, list] of byRound) {
    const startMs = roundStart * 1000;
    const t = startMs + ENTRY_OFFSET_MS;
    const ref = closeAt(bars, startMs);
    const entry = closeAt(bars, t);
    if (!ref || !entry || t > bars[bars.length - 1].t) continue;

    const lo = t - FLOW_WINDOW_MS;
    let buy = 0;
    let vol = 0;
    for (const b of bars) {
      if (b.t <= lo) continue;
      if (b.t > t) break;
      buy += b.takerBuy;
      vol += b.volume;
    }
    if (vol <= 0) continue;
    const flow = (2 * buy) / vol - 1;
    const ret20 = ((entry.close - ref.close) / ref.close) * 10_000;
    if (Math.abs(flow) < FLOW_THR) continue;
    if (Math.sign(ret20) !== Math.sign(flow)) continue;
    if (useGate && Math.abs(ret20) < RET_MAG_THR_BPS) continue;
    const side: "UP" | "DOWN" = flow > 0 ? "UP" : "DOWN";

    // The executable price, nearest archived snapshot to the decision point.
    // If none exists, the round is recorded as untradeable and left out — the
    // whole point is that a mid can never stand in for this.
    let best: Quote | null = null;
    for (const q of list) {
      if (q.t > 40_000 || q.t < 10_000) continue;
      if (!best || Math.abs(q.t - ENTRY_OFFSET_MS) < Math.abs(best.t - ENTRY_OFFSET_MS)) best = q;
    }
    if (!best) {
      noQuote += 1;
      continue;
    }
    const ask = side === "UP" ? best.upAsk : best.downAsk;
    if (ask == null || ask > MAX_PRICE[asset]) {
      noQuote += 1;
      continue;
    }

    // Outcome comes from the Polymarket resolution for that exact round. An
    // unresolved round is DROPPED, never guessed.
    const upWon = roundStartUpWon(roundStart);
    if (upWon === null) {
      noOutcome += 1;
      continue;
    }
    const won = side === "UP" ? upWon : !upWon;
    const shares = STAKE / ask;
    const gross = won ? shares * (1 - SLIPPAGE) : 0;
    rows.push({ side, ask, won, net: gross - STAKE - STAKE * FEE_RATE });
  }
  return { rows, noQuote, noOutcome };
};

const upWonByRound = new Map<number, boolean>();
/**
 * The published outcome, or null if this round has not been seen resolved.
 *
 * It must be null and not `false`. Defaulting a missing outcome to DOWN counts
 * every unknown round as a loss, which produces a plausible-looking negative
 * result from nothing but missing data — the exact kind of quiet fiction this
 * whole exercise exists to eliminate.
 */
const roundStartUpWon = (roundStart: number): boolean | null => upWonByRound.get(roundStart) ?? null;

const main = async () => {
  const quotes = await fetchQuotes();
  if (quotes.length === 0) {
    console.log("pmQuotes is empty — nothing archived yet.");
    console.log("Open the dashboard and leave it running; rows appear within a round.");
    process.exit(0);
  }

  const pmFile = join(import.meta.dir, ".cache", "polymarket-5m-cache.json");
  if (existsSync(pmFile)) {
    const rounds = JSON.parse(readFileSync(pmFile, "utf8")) as {
      t0: number;
      upWon: boolean | null;
    }[];
    for (const r of rounds) if (r.upWon !== null) upWonByRound.set(r.t0, r.upWon);
  }

  console.log(`archived quotes: ${quotes.length}`);
  const rounds = new Set(quotes.map((q) => `${q.asset}@${q.roundStart}`));
  console.log(`distinct rounds:  ${rounds.size}`);
  const offsets = quotes.map((q) => q.t).sort((a, b) => a - b);
  console.log(
    `offsets into round: min ${offsets[0]}ms  p50 ${offsets[offsets.length >> 1]}ms  max ${offsets[offsets.length - 1]}ms`,
  );
  const withAsk = quotes.filter((q) => (q.upAsk ?? q.downAsk) != null).length;
  console.log(`quotes carrying an ask: ${withAsk}/${quotes.length} (${((withAsk / quotes.length) * 100).toFixed(0)}%)\n`);

  for (const asset of ["btc", "eth"] as const) {
    const bars = await loadSeconds(asset === "btc" ? "BTC" : "ETH", DAYS);
    for (const gate of [false, true]) {
      const { rows, noQuote, noOutcome } = analyse(asset, quotes, bars, gate);
      if (rows.length === 0) {
        console.log(
          `${asset.toUpperCase()} gate=${gate}: no tradeable rounds yet (no quote: ${noQuote}, no outcome: ${noOutcome})`,
        );
        continue;
      }
      const wins = rows.filter((r) => r.won).length;
      const net = rows.reduce((s, r) => s + r.net, 0);
      // The number that matters: accuracy against the price actually paid.
      const edge = rows.reduce((s, r) => s + (r.won ? 1 - r.ask : -r.ask), 0) / rows.length;
      console.log(
        `${asset.toUpperCase()} gate=${gate}: ${rows.length} trades, noQuote ${noQuote}, ` +
          `hit ${((wins / rows.length) * 100).toFixed(1)}%, edge vs price ${(edge * 100).toFixed(1)}pp, ` +
          `net $${net.toFixed(2)} ($${(net / rows.length).toFixed(3)}/trade)`,
      );
    }
  }
  console.log(
    "\nedge vs price is per $1 of stake, net of the 200bps fee and 0.005/share slippage,\n" +
      "using the archived ask. It is the honest number; a mid-based one is not.",
  );
};

void main();
