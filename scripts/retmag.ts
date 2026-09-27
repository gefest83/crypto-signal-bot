/**
 * RetMag: the frozen EarlyFlow/EthFlow rule plus a |ret20| >= 2bps gate.
 *
 * PORT OF A PYTHON RESEARCH MODULE. The original lives in a separate Python
 * repository and cannot run here, so the decision rule is reimplemented
 * exactly, from the specification, against the data this project has cached.
 * Every deviation forced by the available data is called out below — read
 * CAVEATS before believing any P&L number this prints.
 *
 * The rule, transcribed literally from the source:
 *
 *   t      = round_start + 20s
 *   window = (t - 30s, t]                       <- starts BEFORE the round
 *   flow   = 2*buy/vol - 1                      <- IMBALANCE, centred on 0
 *   ref    = last close at or before round_start
 *   ret20  = (close at t - ref) / ref
 *
 * PORTING NOTE, and it is the whole ballgame. The first pass used
 * `buy/vol` directly, on the assumption that `compute_flow_imb` returns a
 * fraction. It does not: that quantity is centred on 0.5, so `|flow| >= 0.25`
 * is true for ~76% of rounds and `flow <= -0.25` never happens at all — the
 * side of the signal would be pinned to UP and the "imbalance" would be
 * measuring nothing. The threshold only makes sense against an imbalance
 * centred on zero, hence `2*buy/vol - 1`, where 0.25 means taker buys took
 * 62.5% of the volume. Verified below: the corrected quantity is symmetric.
 *
 *   |flow| >= 0.25            -> direction is sign(flow)
 *   sign(ret20) == sign(flow) -> required (agree_ret20)
 *   |ret20| * 10000 >= 2.0    -> the NEW gate; otherwise HOLD
 *   entry price <= 0.60 (BTC) / 0.70 (ETH) -> otherwise no trade
 *
 * Usage: bun scripts/retmag.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ENTRY_OFFSET_MS = 20_000;
const FLOW_WINDOW_MS = 30_000;
const FLOW_THR = 0.25;
const RET_MAG_THR_BPS = 2.0;
const MAX_PRICE: Record<"btc" | "eth", number> = { btc: 0.6, eth: 0.7 };

type Asset = "btc" | "eth";
type Bar = { t: number; close: number; volume: number; takerBuy: number };
type Round = {
  asset: Asset;
  t0: number;
  upWon: boolean | null;
  samples: { t: number; p: number }[];
};

const cache = (name: string) => join(import.meta.dir, ".cache", name);

type K1s = Record<string, Bar[]>;
const klines: Partial<K1s> = {};
for (const asset of ["BTC", "ETH"] as const) {
  const file = cache(`${asset}USDT-2d-1s.json`);
  if (!existsSync(file)) {
    console.error(`missing ${file}`);
    process.exit(1);
  }
  // Stored as [openTimeMs, {close, high, low, volume, takerBuyBase}].
  const raw = JSON.parse(readFileSync(file, "utf8")) as [
    number,
    { close: number; volume: number; takerBuyBase: number },
  ][];
  const bars: Bar[] = raw.map(([t, v]) => ({
    t,
    close: v.close,
    volume: v.volume,
    takerBuy: v.takerBuyBase,
  }));
  bars.sort((a, b) => a.t - b.t);
  klines[asset] = bars;
}

const pmFile = cache("polymarket-5m-cache.json");
if (!existsSync(pmFile)) {
  console.error(`missing ${pmFile}`);
  process.exit(1);
}
const rounds = (JSON.parse(readFileSync(pmFile, "utf8")) as Round[]).filter(
  (r) => r.upWon !== null,
);

/** Last bar at or before `t`, matching the source's bisect_right - 1. */
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

type Verdict = {
  round: Round;
  flow: number | null;
  ret20Bps: number | null;
  base: "UP" | "DOWN" | "HOLD";
  gated: "UP" | "DOWN" | "HOLD";
  /** Whether the BASE side won — tracked separately from the gated side. */
  baseWon: boolean;
  /** Whether the GATED side won. */
  won: boolean;
  midAtEntry: number | null;
};

/** Did the given side win this round? The only place a side becomes a verdict. */
const sideWon = (side: "UP" | "DOWN" | "HOLD", upWon: boolean): boolean =>
  side === "UP" ? upWon : side === "DOWN" ? !upWon : false;

const results: Record<Asset, Verdict[]> = { btc: [], eth: [] };

for (const r of rounds) {
  const bars = klines[r.asset === "btc" ? "BTC" : "ETH"];
  if (!bars) continue;
  const startMs = r.t0 * 1000;
  const t = startMs + ENTRY_OFFSET_MS;

  const ref = closeAt(bars, startMs);
  const entry = closeAt(bars, t);
  // Reject a round whose window is not actually covered by the 1s data.
  if (!ref || !entry || t < bars[0].t || t > bars[bars.length - 1].t) continue;
  if (entry.t < t - 2000) continue;

  const lo = t - FLOW_WINDOW_MS;
  let buy = 0;
  let vol = 0;
  for (let i = 0; i < bars.length; i += 1) {
    const b = bars[i];
    if (b.t <= lo) continue;
    if (b.t > t) break;
    buy += b.takerBuy;
    vol += b.volume;
  }
  if (vol <= 0) continue;

  const flow = (2 * buy) / vol - 1;
  const ret20Bps = ((entry.close - ref.close) / ref.close) * 10_000;

  // Frozen decision: magnitude of the imbalance picks the side, ret20 must agree.
  let base: "UP" | "DOWN" | "HOLD" = "HOLD";
  if (Math.abs(flow) >= FLOW_THR) {
    const side = flow > 0 ? "UP" : "DOWN";
    if (Math.sign(ret20Bps) === Math.sign(flow)) base = side;
  }
  const gated: "UP" | "DOWN" | "HOLD" =
    base !== "HOLD" && Math.abs(ret20Bps) >= RET_MAG_THR_BPS ? base : "HOLD";

  // Interpolate the 1-minute mid to +20s. This is an approximation and the
  // reason no executable-price claim is made anywhere below.
  const s = r.samples;
  let mid: number | null = null;
  if (s.length >= 2) {
    const first = s[0].t * 1000;
    const last = s[s.length - 1].t * 1000;
    if (t >= first && t <= last) {
      for (let i = 1; i < s.length; i += 1) {
        if (s[i].t * 1000 >= t) {
          const a = s[i - 1];
          const b = s[i];
          const span = b.t - a.t;
          mid = span > 0 ? a.p + ((b.p - a.p) * (t / 1000 - a.t)) / span : b.p;
          break;
        }
      }
    }
  }

  results[r.asset].push({
    round: r,
    flow,
    ret20Bps,
    base,
    gated,
    baseWon: sideWon(base, r.upWon!),
    won: sideWon(gated, r.upWon!),
    midAtEntry: mid,
  });
}

const summarise = (asset: Asset) => {
  const rows = results[asset];
  const fired = rows.filter((r) => r.base !== "HOLD");
  const passed = rows.filter((r) => r.gated !== "HOLD");
  const wins = passed.filter((r) => r.won).length;
  const cap = MAX_PRICE[asset];
  // The price cap is a separate, frozen filter applied after the signal, and it
  // must be scored against the GATED side.
  const withinCap = passed.filter((r) => r.midAtEntry != null && r.midAtEntry <= cap);
  const capWins = withinCap.filter((r) => r.won).length;
  const baseWins = fired.filter((r) => r.baseWon).length;
  return {
    rows: rows.length,
    fired: fired.length,
    passed: passed.length,
    blocked: fired.length - passed.length,
    wins,
    hitRate: passed.length ? wins / passed.length : null,
    baseHitRate: fired.length ? baseWins / fired.length : null,
    withinCap: withinCap.length,
    capHitRate: withinCap.length ? capWins / withinCap.length : null,
  };
};

const pct = (v: number | null) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);

console.log("RetMag — frozen EarlyFlow + |ret20| >= 2bps gate\n");
console.log(
  "CAVEATS: 1s Binance bars cover 2 days, so the sample is ~576 rounds per coin, not 8600.\n" +
    "Entry price is an interpolated 1-minute MID, never an executable ask. No P&L is\n" +
    "reported below, because a mid with a 200bps fee and 0.005/share slippage would be fiction.\n",
);

// A silent guard against the exact porting bug described above: an imbalance
// that is not centred on zero cannot be compared to a symmetric threshold.
console.log("sanity: imbalance distribution (must be centred near 0 and symmetric)");
for (const asset of ["btc", "eth"] as const) {
  const f = results[asset].map((r) => r.flow!).sort((a, b) => a - b);
  const q = (p: number) => f[Math.floor(f.length * p)];
  const up = f.filter((x) => x >= FLOW_THR).length;
  const dn = f.filter((x) => x <= -FLOW_THR).length;
  console.log(
    `  ${asset.toUpperCase()}  min ${f[0].toFixed(3)}  p10 ${q(0.1).toFixed(3)}  p50 ${q(0.5).toFixed(3)}  p90 ${q(0.9).toFixed(3)}  max ${f[f.length - 1].toFixed(3)}`,
  );
  console.log(`         |imb| >= ${FLOW_THR}: up ${up}, down ${dn}  (ratio ${(up / Math.max(1, dn)).toFixed(2)})`);
}
console.log();

for (const asset of ["btc", "eth"] as const) {
  const s = summarise(asset);
  console.log(`${asset.toUpperCase()}  cap ${MAX_PRICE[asset]}`);
  console.log(`  rounds scored        ${s.rows}`);
  console.log(`  frozen fired UP/DOWN ${s.fired}  (${((s.fired / s.rows) * 100).toFixed(1)}% of rounds)`);
  console.log(`  magnitude gate       ${s.passed} kept, ${s.blocked} blocked (${((s.blocked / Math.max(1, s.fired)) * 100).toFixed(1)}% of signals)`);
  console.log(`  hit rate WITHOUT gate ${pct(s.baseHitRate)}   n=${s.fired}`);
  console.log(`  hit rate WITH gate    ${pct(s.hitRate)}   n=${s.passed}`);
  console.log(`  after price cap       ${s.withinCap} trades, hit rate ${pct(s.capHitRate)}`);
  console.log();
}

// How large is the difference, and could noise explain it?
for (const asset of ["btc", "eth"] as const) {
  const s = summarise(asset);
  if (!s.passed || !s.fired) continue;
  const keptWins = s.hitRate! - 0.5;
  const baseWins = s.baseHitRate! - 0.5;
  const se = (p: number, n: number) => Math.sqrt((p * (1 - p)) / Math.max(1, n));
  const z = (keptWins - baseWins) / Math.sqrt(se(s.hitRate!, s.passed) ** 2 + se(s.baseHitRate!, s.fired) ** 2);
  console.log(
    `${asset.toUpperCase()} edge over coin flip: ${(keptWins * 100).toFixed(1)}pp with gate vs ` +
      `${(baseWins * 100).toFixed(1)}pp without; z=${z.toFixed(2)} (|z|<1.9 is not distinguishable from noise)`,
  );
}

// ---------------------------------------------------------------------------
// P&L, as an UPPER BOUND. Read the caveat before the number.
//
// The executable ask is not recorded anywhere in the cache. A mid is used
// instead, plus one tick of crossing, plus the frozen 200bps fee and
// 0.005/share slippage. Every one of those choices flatters the result except
// the last two, and none of them can account for queue position. Treat the
// output as "is there anything here at all", never as an estimate.
// ---------------------------------------------------------------------------
const FEE_RATE = 0.02;
const SLIPPAGE = 0.005;
const STAKE = 5;

const economics = (asset: Asset, gated: boolean) => {
  const rows = results[asset].filter(
    (r) => (gated ? r.gated : r.base) !== "HOLD" && r.midAtEntry != null,
  );
  let net = 0;
  let traded = 0;
  const dist: number[] = [];
  for (const r of rows) {
    const side = gated ? r.gated : r.base;
    // Mid plus one tick: the taker cannot get the mid.
    const ask = Math.min(0.99, r.midAtEntry! + 0.01);
    if (ask > MAX_PRICE[asset]) continue;
    const shares = STAKE / ask;
    const won = sideWon(side, r.round.upWon!);
    const gross = won ? shares * (1 - SLIPPAGE) : 0;
    const value = gross - STAKE - STAKE * FEE_RATE;
    net += value;
    traded += 1;
    dist.push(value);
  }
  dist.sort((a, b) => a - b);
  let cum = 0;
  let peak = 0;
  let dd = 0;
  for (const v of dist) {
    cum += v;
    if (cum > peak) peak = cum;
    if (peak - cum > dd) dd = peak - cum;
  }
  return {
    traded,
    net,
    perTrade: traded ? net / traded : 0,
    maxDd: dd,
  };
};

// Is the market price already calibrated? If it is, a signal claiming 69% at an
// entry near 0.50 is not an edge, it is a broken price. This is the check that
// decides whether the P&L below can be believed.
console.log("\ncalibration: price at ~+15s vs realised outcome (market is calibrated if these match)");
{
  const buckets = new Map<number, boolean[]>();
  for (const r of rounds) {
    const s = r.samples;
    if (s.length < 2) continue;
    const p = s[0].p;
    if (!(p > 0 && p < 1)) continue;
    const b = Math.round(p * 10) / 10;
    const list = buckets.get(b) ?? [];
    list.push(r.upWon!);
    buckets.set(b, list);
  }
  for (const b of [...buckets.keys()].sort((x, y) => x - y)) {
    const v = buckets.get(b)!;
    if (v.length < 50) continue;
    const w = v.filter(Boolean).length / v.length;
    console.log(`  price ~${b.toFixed(1)}: realised ${(w * 100).toFixed(1)}%  n=${v.length}  gap ${((w - b) * 100 >= 0 ? "+" : "") + ((w - b) * 100).toFixed(1)}pp`);
  }
}

console.log("\nP&L UPPER BOUND (mid+1tick entry, 200bps fee, 0.005/share slippage, $5 stake)");
for (const asset of ["btc", "eth"] as const) {
  const off = economics(asset, false);
  const on = economics(asset, true);
  console.log(
    `  ${asset.toUpperCase()}  without gate: ${off.traded} trades, ` +
      `$${off.net.toFixed(2)} total, $${off.perTrade.toFixed(3)}/trade, maxDD $${off.maxDd.toFixed(2)}`,
  );
  console.log(
    `         with gate:    ${on.traded} trades, ` +
      `$${on.net.toFixed(2)} total, $${on.perTrade.toFixed(3)}/trade, maxDD $${on.maxDd.toFixed(2)}`,
  );
}
