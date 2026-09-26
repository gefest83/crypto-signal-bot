/**
 * Decisive check on the maker + breakeven-exit result: does it survive paying
 * the spread on the exit?
 *
 * The backtest sold the contract back at exactly the price it bought at. A
 * resting sell at 0.35 does not fill at 0.35 — it fills at the bid, which is
 * below it. If the entire apparent edge is that one cent, the strategy is an
 * accounting error rather than a finding.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const INTERVAL = Number(process.argv[2] ?? 15);
const ENTRY_S = Math.round(INTERVAL * 60 * Number(process.argv[3] ?? 0.2));
const cache = (
  JSON.parse(
    readFileSync(join(import.meta.dir, ".cache", `polymarket-${INTERVAL}m-cache.json`), "utf8"),
  ) as { t0: number; upWon: boolean | null; samples: { t: number; p: number }[] }[]
).filter((r) => r.upWon !== null);

console.log(`\n${INTERVAL}m, limit rested from t+${ENTRY_S}s`);
console.log("  exit slippage = what the breakeven exit really costs, in ticks of 1c\n");
for (const limit of [0.25, 0.35, 0.5]) {
  for (const slip of [0, 0.01, 0.02]) {
    let n = 0;
    let gross = 0;
    let held = 0;
    let heldWin = 0;
    let exited = 0;
    for (const r of cache) {
      const path = r.samples.filter((s) => s.t - r.t0 >= ENTRY_S);
      if (!path.length) continue;
      const fill = path.findIndex((s) => s.p <= limit);
      if (fill === -1) continue;
      n += 1;
      if (path.slice(fill + 1).some((s) => s.p <= limit)) {
        exited += 1;
        gross -= slip;
        continue;
      }
      held += 1;
      if (r.upWon) heldWin += 1;
      gross += r.upWon ? 1 - limit : -limit;
    }
    console.log(
      `  limit ${limit.toFixed(2)}  slip ${(slip * 100).toFixed(0)}c  n=${String(n).padStart(4)}  ` +
        `exit ${((exited / n) * 100).toFixed(0).padStart(3)}%  held ${String(held).padStart(3)}  ` +
        `held-wins ${((heldWin / Math.max(1, held)) * 100).toFixed(0).padStart(3)}%  ` +
        `P&L ${(gross / n).toFixed(4)}`,
    );
  }
}
