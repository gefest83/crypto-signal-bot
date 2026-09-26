/**
 * The limit was chosen from a price series that contains no order book.
 *
 * The walk-forward says 0.35 pays, but it was computed from a minute-granularity
 * MID: it proves the price trades at 0.35, not that a dollar can be bought
 * there. A live book read settles it, and it settled it badly: on the side
 * that was quoteable 96% of the time, at least $1 actually rested at 0.35 in
 * only 4% of reads. The edge was priced on a level nobody was selling into.
 *
 * So this scans every limit in the profitable band against the real book and
 * asks the only question that matters for a maker:
 *
 *   for a $1 order resting at limit L, how often is BOTH true —
 *     1. at least $1 already offered at L, so a queue for us to sit behind
 *     2. the ask is at or below L, so a seller is actually crossing
 *
 * A limit that is cheap to reach but has no depth is not cheap, it is unusable.
 * A limit with depth but never reached is not a limit, it is a wall.
 *
 * The point is not to find a better number. It is to find out whether ANY
 * limit in the band clears the 2% commission with enough fills to be worth
 * running — and if none does, that is a finding worth more than the backtest.
 */
const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";
const INTERVAL = Number(process.argv[2] ?? 15);
const WATCH_S = Number(process.argv[3] ?? 150);
const ROUND_S = INTERVAL * 60;
const STAKE = 1;

/**
 * The profitable band the walk-forward found, and the measured EV per share at
 * each point, net of the 2% commission (from scripts/maker-breakeven.ts).
 *
 * A $1 stake buys 1 / limit of these shares, so the EV on a $1 stake is
 * evPerShare / limit − 0.02. The commission is subtracted on the STAKE, which
 * is why the numbers fall faster than the raw table does.
 */
const BAND: { limit: number; evPerShare: number }[] = [
  { limit: 0.2, evPerShare: 0.008 },
  { limit: 0.25, evPerShare: 0.007 },
  { limit: 0.3, evPerShare: 0.01 },
  { limit: 0.35, evPerShare: 0.013 },
  { limit: 0.4, evPerShare: 0.01 },
  { limit: 0.45, evPerShare: 0.011 },
  { limit: 0.5, evPerShare: 0.006 },
  { limit: 0.55, evPerShare: -0.001 },
];

/** Net EV on a $1 stake at a given limit, after the 2% fee. */
function evPerStake(limit: number, evPerShare: number): number {
  return evPerShare / limit - 0.02;
}

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { "User-Agent": "limit-scan" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`${response.status}`);
  return response.json();
}

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

type Level = { price: number; size: number };
type Book = { bids: Level[]; asks: Level[] };

async function book(tokenId: string): Promise<Book | null> {
  try {
    const raw = (await getJson(`${CLOB}/book?token_id=${tokenId}`)) as {
      bids?: { price: string; size: string }[];
      asks?: { price: string; size: string }[];
    };
    const parse = (
      rows: { price: string; size: string }[] | undefined,
      desc: boolean,
    ): Level[] =>
      (rows ?? [])
        .map((r) => ({ price: num(r.price), size: num(r.size) }))
        .filter((l): l is Level => l.price !== null && l.size !== null)
        .sort((a, b) => (desc ? b.price - a.price : a.price - b.price));
    const bids = parse(raw.bids, true);
    const asks = parse(raw.asks, false);
    if (!bids.length || !asks.length) return null;
    return { bids, asks };
  } catch {
    return null;
  }
}

type Round = { slug: string; up: string; down: string };

async function currentRound(asset: "btc" | "eth"): Promise<Round | null> {
  const start = Math.floor(Date.now() / 1000 / ROUND_S) * ROUND_S;
  const slug = `${asset}-updown-${INTERVAL}m-${start}`;
  const markets = (await getJson(`${GAMMA}/markets?slug=${slug}`)) as {
    slug?: string;
    outcomes?: string | string[];
    clobTokenIds?: string;
  }[];
  const market = markets[0];
  if (!market?.slug || !market.clobTokenIds) return null;
  const ids = JSON.parse(market.clobTokenIds) as string[];
  const raw = market.outcomes ?? [];
  const names = (typeof raw === "string" ? (JSON.parse(raw) as string[]) : raw) ?? [];
  const upIdx = names.findIndex((n) => n.toUpperCase() === "UP");
  const downIdx = names.findIndex((n) => n.toUpperCase() === "DOWN");
  const up = ids[upIdx >= 0 ? upIdx : 0];
  const down = ids[downIdx >= 0 ? downIdx : 1];
  if (!up || !down) return null;
  return { slug: market.slug, up, down };
}

/** USDC offered at exactly one price level. */
const at = (levels: Level[], price: number): number =>
  levels.filter((l) => Math.abs(l.price - price) < 1e-9).reduce((a, l) => a + l.size, 0);

/** USDC available if our bid at `price` is swept, down to the best bid. */
const sweep = (bids: Level[], price: number): number => {
  let total = 0;
  for (const l of bids) {
    if (l.price > price + 1e-9) break;
    total += l.size;
  }
  return total;
};

const ticks = BAND.map((b) => b.limit);

type Tally = {
  reads: number;
  /**
   * Our bid would have been hit. This is the ONLY fill condition, and it is
   * not "is there book at my level" — it is "did a seller trade at or below my
   * level". Our own bid creates that level; somebody else's resting bid at the
   * same price is irrelevant to whether WE get filled, because we were first
   * in the queue and the price traded through us.
   *
   * An earlier version of this script required depth at the limit as well and
   * reported 0% fills everywhere. That was wrong, and it was wrong in the
   * dangerous direction: the depth sits on the level precisely while the ask
   * is ABOVE it, and disappears the moment the ask reaches it. The two
   * conditions are mutually exclusive by construction, so their intersection
   * is always empty. Requiring both manufactured a dead strategy.
   */
  hit: number;
  /** USDC resting at the limit — the queue we would sit behind. */
  depthSum: number;
  depthReads: number;
  /** Total bid depth from the limit down to best bid. */
  sweepSum: number;
  /** Best ask seen, for context on how far the market is from the limit. */
  askSum: number;
};

const empty = (): Tally => ({
  reads: 0,
  hit: 0,
  depthSum: 0,
  depthReads: 0,
  sweepSum: 0,
  askSum: 0,
});

const tallies = new Map<string, Tally>();
for (const a of ["btc", "eth"]) {
  for (const s of ["UP", "DOWN"]) {
    for (const limit of ticks) {
      const key = `${a}-${s}-${limit}`;
      tallies.set(key, empty());
    }
  }
}

console.log(`\n=== is ANY limit in the band actually fillable? · ${INTERVAL}m Up/Down ===`);
console.log(`watching the live book for ${WATCH_S}s. A $${STAKE} order needs BOTH a $1 to rest`);
console.log(`at the limit and a seller crossing to it. One without the other is worthless.\n`);

const rounds: Record<string, Round | null> = {
  btc: await currentRound("btc"),
  eth: await currentRound("eth"),
};
if (!rounds.btc || !rounds.eth) {
  console.log("  could not resolve the current rounds");
  process.exit(1);
}

const t0 = Date.now();
let polls = 0;

while (Date.now() - t0 < WATCH_S * 1000) {
  for (const [asset, round] of Object.entries(rounds)) {
    if (!round) continue;
    for (const [side, tokenId] of [
      ["UP", round.up],
      ["DOWN", round.down],
    ] as const) {
      const b = await book(tokenId);
      if (!b) continue;
      const ask = b.asks[0].price;
      for (const limit of ticks) {
        const t = tallies.get(`${asset}-${side}-${limit}`)!;
        t.reads++;
        // Filled iff a seller traded at or below our limit.
        if (ask <= limit + 1e-9) t.hit++;
        const depth = at(b.bids, limit);
        t.depthSum += depth;
        if (depth > 0) t.depthReads++;
        t.sweepSum += sweep(b.bids, limit);
        t.askSum += ask;
      }
    }
  }
  polls++;
  await new Promise((r) => setTimeout(r, 2500));
}

const pct = (n: number, d: number) => (d ? (n / d) * 100 : 0);
const rpsPerDay = (INTERVAL === 15 ? 96 : 2880) * 2; // rounds per day × 2 assets

console.log(`\n=== ${polls} polls · ${rounds.btc.slug} ===`);
console.log(
  "\n  limit  asset  side    hit%   avgAsk  depth$   sweep$   EV/$1",
);
console.log("  " + "-".repeat(68));

for (const { limit, evPerShare } of BAND) {
  const ev = evPerStake(limit, evPerShare);
  for (const [asset, side] of [
    ["btc", "UP"],
    ["btc", "DOWN"],
    ["eth", "UP"],
    ["eth", "DOWN"],
  ] as const) {
    const t = tallies.get(`${asset}-${side}-${limit}`)!;
    if (!t.reads) continue;
    const hit = pct(t.hit, t.reads);
    if (hit === 0) continue;
    const avgDepth = t.depthReads ? t.depthSum / t.depthReads : 0;
    console.log(
      `  ${limit.toFixed(2)}   ${asset.toUpperCase().padEnd(4)}  ${side.padEnd(4)}  ` +
        `${hit.toFixed(0).padStart(5)}%  ${(t.askSum / t.reads).toFixed(2).padStart(6)}  ` +
        `${avgDepth.toFixed(0).padStart(6)}  ${(t.sweepSum / t.reads).toFixed(0).padStart(6)}  ` +
        `${(ev * 100 >= 0 ? "+" : "")}${(ev * 100).toFixed(1)}¢`,
    );
  }
}

// Money per day, not hit rate. A limit that fills 90% of the round but pays
// nothing after the commission is worth less than one that fills 30% and pays.
console.log(`\n=== what that implies at $${STAKE} per fill ===`);
console.log("  limit  hit%/round   fills/day   EV/$1   $/day");
console.log("  " + "-".repeat(48));

const ranked: { limit: number; ev: number; fills: number; perDay: number }[] = [];

for (const { limit, evPerShare } of BAND) {
  const ev = evPerStake(limit, evPerShare);
  let hits = 0;
  let reads = 0;
  for (const [asset, side] of [
    ["btc", "UP"],
    ["btc", "DOWN"],
    ["eth", "UP"],
    ["eth", "DOWN"],
  ] as const) {
    const t = tallies.get(`${asset}-${side}-${limit}`)!;
    hits += t.hit;
    reads += t.reads;
  }
  if (!reads) continue;
  const hitRate = hits / reads;
  const fillsPerDay = hitRate * rpsPerDay;
  const perDay = fillsPerDay * ev * STAKE;
  ranked.push({ limit, ev, fills: fillsPerDay, perDay });
  console.log(
    `  ${limit.toFixed(2)}    ${(hitRate * 100).toFixed(1).padStart(8)}%  ` +
      `${fillsPerDay.toFixed(1).padStart(9)}   ` +
      `${(ev * 100 >= 0 ? "+" : "")}${(ev * 100).toFixed(1)}¢  ` +
      `${perDay >= 0 ? "+" : "−"}$${Math.abs(perDay).toFixed(2)}`,
  );
}

const best = ranked.sort((a, b) => b.perDay - a.perDay)[0];
console.log(`\n  best of the band: limit ${best.limit.toFixed(2)} at ${best.perDay >= 0 ? "+" : "−"}$${Math.abs(best.perDay).toFixed(2)}/day`);

console.log(
  `\n  read: this counts a hit whenever the ask trades at or below the limit, which\n` +
    `  is the price crossing our resting bid. The remaining risk is queue position\n` +
    `  at the moment of the move, and whether we were resting at all — neither is\n` +
    `  observable from a book snapshot. Treat $/day as a ceiling.`,
);
