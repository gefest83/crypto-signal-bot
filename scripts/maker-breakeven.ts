/**
 * Maker entries with a breakeven exit — the one structure the taker fee cannot
 * kill.
 *
 * Everything measured so far lost money in the same place: the 7% taker fee.
 * At a longshot price of 0.30 it is 4.9% of the stake, and the measured
 * mispricing there is +4.6pp. The two almost exactly cancel, which is why
 * "buy the cheap side" has never survived. A maker pays no fee at all and
 * collects 20% of the taker fees, so the same 4.6pp becomes the whole edge.
 *
 * The second half of the structure is the exit. Inside a round the contract
 * price wanders; if it falls back to what we paid we sell and give the trade
 * back at zero. That caps the downside at roughly the maker's cost to leave,
 * so the losing trades stop being −1 and the strategy only needs its winners
 * to pay for the spread it crosses.
 *
 * CAVEAT, and it is a big one: prices-history is roughly 1-minute granularity
 * and it quotes a mid, not a book. A fill here means "the price printed at or
 * below our limit", which is better than reality — in the book we would need
 * the ask to reach us. So every number below is an UPPER BOUND, not an
 * estimate. The question this answers is only "is there enough here to be worth
 * building", and the bound answers that.
 *
 * Usage: bun scripts/maker-breakeven.ts [interval] [days] [entryFraction]
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const INTERVAL = Number(process.argv[2] ?? 15);
const DAYS = Number(process.argv[3] ?? 30);
const ENTRY_FRACTION = Number(process.argv[4] ?? 0.2);
const ROUND_MS = INTERVAL * 60 * 1000;
const ENTRY_S = Math.round((ROUND_MS / 1000) * ENTRY_FRACTION);
const ASSETS = ["btc", "eth"] as const;
type Asset = (typeof ASSETS)[number];

type Sample = { t: number; p: number };
type Round = { asset: Asset; t0: number; upWon: boolean | null; samples: Sample[] };

const cacheFile = join(import.meta.dir, ".cache", `polymarket-${INTERVAL}m-cache.json`);
if (!existsSync(cacheFile)) {
  console.log(`no cache — run scripts/polymarket-5m.ts ${INTERVAL} ${DAYS} engine`);
  process.exit(1);
}
const cache = (JSON.parse(readFileSync(cacheFile, "utf8")) as Round[]).filter(
  (r) => r.upWon !== null,
);

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

type Trade = {
  t0: number;
  asset: Asset;
  /** Limit we rested, and the side we took. */
  limit: number;
  up: boolean;
  cost: number;
  filled: boolean;
  /** Sold back at cost before the round resolved. */
  exited: boolean;
  won: boolean;
  pnl: number;
};

/**
 * Charged on every trade: 2% of the stake.
 *
 * This replaced a rebate assumption that was never checked against the real
 * fee schedule. At a 0.35 limit it is 0.7c per share, which is small enough to
 * look negligible and large enough to flip a marginal result — so it is applied
 * per share here exactly as `makerPnl` applies it in the app.
 */
const FEE_RATE = 0.02;
/**
 * What the breakeven exit really costs.
 *
 * Selling at 0.35 does not fill at 0.35 — it fills at the bid under it. This is
 * the single assumption that decides whether the strategy exists, so it is not
 * left at zero to flatter the result.
 */
const EXIT_SLIP = Number(process.argv[5] ?? 0.02);

/**
 * Walk one round: rest a limit on the chosen side, fill if the price reaches
 * it, then give the trade back the moment it no longer pays to hold.
 */
function simulate(round: Round, limit: number, up: boolean): Trade | null {
  const base: Trade = {
    t0: round.t0,
    asset: round.asset,
    limit,
    up,
    cost: limit,
    filled: false,
    exited: false,
    won: up ? round.upWon! : !round.upWon!,
    pnl: 0,
  };
  const path = round.samples.filter((s) => s.t - round.t0 >= ENTRY_S);
  if (!path.length) return null;

  const side = (p: number) => (up ? p : 1 - p);
  const fillIdx = path.findIndex((s) => side(s.p) <= limit);
  if (fillIdx === -1) return null;

  // From the fill onwards: bail the first time the contract is worth no more
  // than we paid, which is our breakeven exit.
  const exited = path.slice(fillIdx + 1).some((s) => side(s.p) <= limit);

  const gross = exited ? -EXIT_SLIP : base.won ? 1 - limit : -limit;
  return { ...base, filled: true, exited, pnl: gross - FEE_RATE * limit };
}

const LIMITS = [0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85];

console.log(`\n=== ${INTERVAL}m · maker + breakeven exit · ${DAYS}d · limit rest from t+${ENTRY_S}s ===`);
console.log(`   exit slippage ${(EXIT_SLIP * 100).toFixed(0)}c per round-tripped trade\n`);
console.log("   limit   side   fills   exit%   win%    P&L/trade   total      (net of 2% fee)");
console.log("   " + "-".repeat(78));

const results: { limit: number; up: boolean; trades: Trade[] }[] = [];
for (const up of [true, false]) {
  for (const limit of LIMITS) {
    const trades: Trade[] = [];
    for (const round of cache) {
      const got = simulate(round, limit, up);
      if (got) trades.push(got);
    }
    if (trades.length < 100) continue;
    results.push({ limit, up, trades });
    const exited = trades.filter((t) => t.exited).length;
    const won = trades.filter((t) => t.won).length;
    console.log(
      `   ${limit.toFixed(2)}    ${up ? "UP  " : "DOWN"}  ${String(trades.length).padStart(5)}  ` +
        `${((exited / trades.length) * 100).toFixed(0).padStart(4)}%  ${((won / trades.length) * 100).toFixed(1).padStart(5)}%  ` +
        `${(mean(trades.map((t) => t.pnl)) >= 0 ? "+" : "")}${mean(trades.map((t) => t.pnl)).toFixed(3).padStart(6)}      ` +
        `${(trades.reduce((a, t) => a + t.pnl, 0) >= 0 ? "+" : "")}${trades.reduce((a, t) => a + t.pnl, 0).toFixed(1).padStart(6)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Walk-forward: only trade a limit that paid on every earlier week
// ---------------------------------------------------------------------------
console.log("\n=== WALK-FORWARD: a limit is used only if it paid on all earlier weeks ===");
const week = 7 * 24 * 3600 * 1000;
const sorted = [...cache].sort((a, b) => a.t0 - b.t0);
const first = sorted[0].t0 * 1000;
const spanWeeks = Math.ceil((sorted[sorted.length - 1].t0 * 1000 - first) / week);

let total = 0;
let trades = 0;
for (let w = 1; w < spanWeeks; w += 1) {
  const lo = first + w * week;
  const past = sorted.filter((r) => r.t0 * 1000 < lo);
  const next = sorted.filter((r) => r.t0 * 1000 >= lo && r.t0 * 1000 < lo + week);
  if (past.length < 200 || next.length < 30) continue;

  let chosen: { limit: number; up: boolean; ev: number } | null = null;
  for (const up of [true, false]) {
    for (const limit of LIMITS) {
      const got = past.map((r) => simulate(r, limit, up)).filter((t): t is Trade => t !== null);
      if (got.length < 100) continue;
      const ev = mean(got.map((t) => t.pnl));
      if (!chosen || ev > chosen.ev) chosen = { limit, up, ev };
    }
  }
  if (!chosen) continue;

  const applied = next.map((r) => simulate(r, chosen.limit, chosen.up)).filter((t): t is Trade => t !== null);
  const pnl = applied.reduce((a, t) => a + t.pnl, 0);
  total += pnl;
  trades += applied.length;
  console.log(
    `   wk${w} limit ${chosen.limit.toFixed(2)} ${chosen.up ? "UP  " : "DOWN"}  ` +
      `past EV ${chosen.ev >= 0 ? "+" : ""}${chosen.ev.toFixed(3)}  →  n=${String(applied.length).padStart(4)}  ` +
      `P&L ${pnl >= 0 ? "+" : ""}${pnl.toFixed(1).padStart(7)}`,
  );
}

console.log(
  `\n   WALK-FORWARD TOTAL: ${total >= 0 ? "+" : ""}${total.toFixed(2)} on ${trades} trades = ` +
    `${trades ? (total / trades).toFixed(3) : "0.000"}/trade`,
);
console.log("   and remember: fills are assumed at the printed mid, not at our bid inside the spread.");

// ---------------------------------------------------------------------------
// 4. Decomposition: how much is the entry worth, and how much is the exit?
// ---------------------------------------------------------------------------
console.log("\n=== DECOMPOSITION at limit 0.35 — what actually makes the money ===");
for (const up of [true, false]) {
  const trades: Trade[] = [];
  for (const round of cache) {
    const got = simulate(round, 0.35, up);
    if (got) trades.push(got);
  }
  const wins = trades.filter((t) => t.won).length;
  // What the same fills would be worth with no exit at all.
  const holdOnly = mean(trades.map((t) => (t.won ? 1 - 0.35 : -0.35)));
  const withExit = mean(trades.map((t) => t.pnl));
  const exited = trades.filter((t) => t.exited);
  const held = trades.filter((t) => !t.exited);
  console.log(
    `   ${up ? "UP  " : "DOWN"}  fills ${trades.length}  win rate ${((wins / trades.length) * 100).toFixed(1)}%`,
  );
  console.log(`          hold to resolution: ${holdOnly >= 0 ? "+" : ""}${holdOnly.toFixed(4)}/trade`);
  console.log(`          with breakeven exit: ${withExit >= 0 ? "+" : ""}${withExit.toFixed(4)}/trade`);
  console.log(
    `          exited ${exited.length} at ~0  |  held ${held.length}, of which won ` +
      `${held.length ? ((held.filter((t) => t.won).length / held.length) * 100).toFixed(0) : 0}%`,
  );
  console.log(
    `          the entry alone is ${holdOnly < 0 ? "NEGATIVE" : "positive"}; ` +
      `${((withExit - holdOnly) * trades.length).toFixed(0)} of the total is the exit`,
  );
}

console.log("\n=== STABILITY: fixed rule 0.35, P&L per day ===");
for (const up of [true, false]) {
  const perDay = new Map<number, number>();
  for (const round of cache) {
    const got = simulate(round, 0.35, up);
    if (!got) continue;
    const day = Math.floor(round.t0 / 86400);
    perDay.set(day, (perDay.get(day) ?? 0) + got.pnl);
  }
  const daily = [...perDay.values()];
  const losing = daily.filter((d) => d < 0).length;
  const totalPnl = daily.reduce((a, b) => a + b, 0);
  const sorted = [...daily].sort((a, b) => a - b);
  const worstTenth = sorted.slice(0, Math.max(1, Math.floor(sorted.length * 0.1)));
  console.log(
    `   ${up ? "UP  " : "DOWN"}  days ${daily.length}  losing ${losing} (${((losing / daily.length) * 100).toFixed(0)}%)  ` +
      `best +${Math.max(...daily).toFixed(1)}  worst ${Math.min(...daily).toFixed(1)}  mean ${(totalPnl / daily.length).toFixed(2)}`,
  );
  console.log(
    `          total ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(1)}  |  ` +
      `drop the worst 10% of days and it is still ${(totalPnl - worstTenth.reduce((a, b) => a + b, 0)).toFixed(1)}`,
  );
}
