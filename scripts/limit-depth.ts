/**
 * The question that decides whether this strategy exists at all.
 *
 * The walk-forward says the limit fills often, but it was computed from a
 * minute-granularity mid series: it proves the PRICE came down to 0.35, not
 * that anyone sold into a bid resting there. In a falling market bids get
 * hit and offers get lifted — the two are not the same event, and only the
 * second one pays us.
 *
 * So this reads the live CLOB book and answers the two questions the backtest
 * could not:
 *
 *   1. DEPTH AT 0.35 — how much USDC actually rests at the level we would quote.
 *      If that is $0 most of the time, a $1 order can never fill and the whole
 *      idea is a rounding error waiting to happen.
 *   2. TIME AT 0.35 — how long the ask spends at or below our limit. That is
 *      the window in which a taker would have crossed to us.
 *
 * A negative answer here is worth more than another backtest: it would mean the
 * strategy is dead on arrival, and no amount of historical P&L changes that.
 */
const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";
const INTERVAL = Number(process.argv[2] ?? 15);
const ROUND_S = INTERVAL * 60;
/** How long to watch. A full round is 15 minutes; a shorter sample is partial. */
const WATCH_S = Number(process.argv[3] ?? 170);
const LIMIT = 0.35;

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { "User-Agent": "depth-study" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`${response.status}`);
  return response.json();
}

const num = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

type Level = { price: number; size: number };
type Book = { bids: Level[]; asks: Level[] };

/** Full book on one token, sorted so index 0 is the best price. */
async function book(tokenId: string): Promise<Book | null> {
  try {
    const raw = (await getJson(`${CLOB}/book?token_id=${tokenId}`)) as {
      bids?: { price: string; size: string }[];
      asks?: { price: string; size: string }[];
    };
    const bids = (raw.bids ?? [])
      .map((b) => ({ price: num(b.price), size: num(b.size) }))
      .filter((b): b is Level => b.price !== null && b.size !== null)
      .sort((a, b) => b.price - a.price);
    const asks = (raw.asks ?? [])
      .map((a) => ({ price: num(a.price), size: num(a.size) }))
      .filter((a): a is Level => a.price !== null && a.size !== null)
      .sort((a, b) => a.price - b.price);
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
  // Gamma returns `outcomes` and `clobTokenIds` as JSON *strings*, and the
  // order of the two tokens is not guaranteed. Match on the names.
  const raw = market.outcomes ?? [];
  const names = (typeof raw === "string" ? (JSON.parse(raw) as string[]) : raw) ?? [];
  const upIdx = names.findIndex((n) => n.toUpperCase() === "UP");
  const downIdx = names.findIndex((n) => n.toUpperCase() === "DOWN");
  const up = ids[upIdx >= 0 ? upIdx : 0];
  const down = ids[downIdx >= 0 ? downIdx : 1];
  if (!up || !down) return null;
  return { slug: market.slug, up, down };
}

/** Size resting at exactly our limit, across the whole book. */
function depthAt(levels: Level[], limit: number): number {
  return levels
    .filter((l) => Math.abs(l.price - limit) < 1e-9)
    .reduce((a, l) => a + l.size, 0);
}

type Sample = {
  t: number;
  asset: string;
  side: string;
  bid: number;
  ask: number;
  bidDepth: number;
  askDepth: number;
  bestBid: number;
};

console.log(`\n=== who would actually fill our ${LIMIT} limit · ${INTERVAL}m Up/Down ===`);
console.log(
  `watching ${WATCH_S}s of the live book. The backtest proved the price reaches`,
);
console.log(
  `${LIMIT}; this checks whether SELLERS reach it, which is a different event.\n`,
);
console.log(
  "  t+    asset  side   bid   ask   spread  size@best bid",
);

const rounds: Record<string, Round | null> = {
  btc: await currentRound("btc"),
  eth: await currentRound("eth"),
};
if (!rounds.btc || !rounds.eth) {
  console.log(`  could not resolve the current rounds: ${JSON.stringify(
    Object.entries(rounds).map(([k, v]) => [k, v?.slug ?? null]),
  )}`);
  process.exit(1);
}

const startSec = Math.floor(Date.now() / 1000);
const samples: Sample[] = [];
const t0 = Date.now();
let crossings = 0;
let fills = 0;
let previousSide: Record<string, string> = {};

while (Date.now() - t0 < WATCH_S * 1000) {
  const now = Date.now();
  const elapsed = Math.floor((now - t0) / 1000);

  for (const [asset, round] of Object.entries(rounds)) {
    if (!round) continue;
    for (const [side, tokenId] of [
      ["UP", round.up],
      ["DOWN", round.down],
    ] as const) {
      const b = await book(tokenId);
      if (!b) continue;
      const bid = b.bids[0];
      const ask = b.asks[0];
      samples.push({
        t: elapsed,
        asset,
        side,
        bid: bid.price,
        ask: ask.price,
        bidDepth: depthAt(b.bids, LIMIT),
        askDepth: ask.size,
        bestBid: bid.price,
      });

      // A fill for us means somebody SOLD into our bid: the ask has to reach
      // down to our level. Count each crossing once, not every poll.
      const key = `${asset}-${side}`;
      if (ask.price <= LIMIT) {
        if (previousSide[key] !== "at") {
          crossings++;
          if (bid.size >= 1) fills++;
        }
        previousSide[key] = "at";
      } else {
        previousSide[key] = "away";
      }
    }
  }

  if (elapsed % 20 === 0 && samples.length) {
    const last = samples[samples.length - 1];
    console.log(
      `  ${String(elapsed).padStart(3)}s  ${last.asset}    ${last.side.padEnd(4)}  ` +
        `${last.bid.toFixed(2)}  ${last.ask.toFixed(2)}  ` +
        `${(last.ask - last.bid).toFixed(2).padStart(5)}   ` +
        `${last.bidDepth.toFixed(0).padStart(4)}`,
    );
  }

  await new Promise((r) => setTimeout(r, 3000));
}

const withDepth = samples.filter((s) => s.bidDepth > 0);
const atOrBelow = samples.filter((s) => s.ask <= LIMIT);
const thin = withDepth.filter((s) => s.bidDepth < 1);
const big = withDepth.filter((s) => s.bidDepth >= 10);

console.log(`\n=== VERDICT over ${samples.length} book reads ===`);
console.log(`  ask reached ≤ ${LIMIT}          ${atOrBelow.length} reads ` +
  `(${((atOrBelow.length / samples.length) * 100).toFixed(1)}%)`);
console.log(`  distinct crossings to ${LIMIT}   ${crossings}`);
console.log(`  $1+ actually resting at bid      ${withDepth.length} reads ` +
  `(${((withDepth.length / samples.length) * 100).toFixed(1)}%)`);
console.log(`  bid thinner than $1              ${thin.length} reads ` +
  `(${((thin.length / samples.length) * 100).toFixed(1)}%)`);
console.log(`  bid thicker than $10             ${big.length} reads`);

// The aggregate hides the only thing that matters: a 0.35 limit is only
// reachable on the CHEAP side, and on the expensive side it is never near.
// Averaging both together would report 37% "reached the limit" while the
// side we would actually quote on was nowhere near it.
console.log(`\n  split by side — only the cheap side can ever reach ${LIMIT}:`);
for (const [asset, side] of [
  ["btc", "UP"],
  ["btc", "DOWN"],
  ["eth", "UP"],
  ["eth", "DOWN"],
] as const) {
  const rows = samples.filter((s) => s.asset === asset && s.side === side);
  if (!rows.length) continue;
  const reached = rows.filter((s) => s.ask <= LIMIT).length;
  const depth = rows.filter((s) => s.bidDepth >= 1).length;
  // The only number that decides the strategy: our $1 can only rest at the
  // limit when somebody is already offering to sell into it.
  const fillable = rows.filter((s) => s.bidDepth >= 1).length;
  console.log(
    `    ${asset.toUpperCase().padEnd(4)} ${side.padEnd(4)} ` +
      `ask≤${LIMIT} ${String(reached).padStart(3)}/${rows.length} ` +
      `(${(rows.length ? (reached / rows.length) * 100 : 0).toFixed(0).padStart(3)}%)  ` +
      `$1+ at bid ${String(depth).padStart(3)}/${rows.length} ` +
      `(${(rows.length ? (fillable / rows.length) * 100 : 0).toFixed(0).padStart(3)}%)`,
  );
}

console.log(
  `\n  read: a $1 order fills only where at least $1 rests at the bid AND\n` +
    `  somebody crosses down to ${LIMIT}. Both have to be true at once.`,
);
