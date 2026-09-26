/**
 * The maker + breakeven-exit strategy is positive only if a resting sell at the
 * entry price can realistically fill. That is a claim about the real book, and
 * the real book is one HTTP call away — no collector, no waiting.
 *
 * This measures the live spread on the current 15-minute Up/Down markets, which
 * is exactly the quantity the backtest had to assume. If the spread is one
 * cent, a two-cent exit assumption is conservative and the edge is real. If it
 * is three cents or worse, the strategy dies where it stands.
 */
const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";
const INTERVAL = Number(process.argv[2] ?? 15);
const ROUND_S = INTERVAL * 60;

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { "User-Agent": "spread-study" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`${response.status}`);
  return response.json();
}

type Book = { bids: { price: string; size: string }[]; asks: { price: string; size: string }[] };

/** Spread and top-of-book depth on one side of a market, from the live CLOB. */
async function book(tokenId: string): Promise<{ spread: number; bid: number; ask: number } | null> {
  try {
    const b = (await getJson(`${CLOB}/book?token_id=${tokenId}`)) as Book;
    if (!b.bids?.length || !b.asks?.length) return null;
    const bid = Math.max(...b.bids.map((x) => Number(x.price)));
    const ask = Math.min(...b.asks.map((x) => Number(x.price)));
    return { bid, ask, spread: ask - bid };
  } catch {
    return null;
  }
}

console.log(`\n=== live CLOB book on ${INTERVAL}m Up/Down markets ===`);
console.log("sampling the current round for 45s, because these books thin out as a round ages\n");
console.log("  t+   BTC spread  bid/ask      depth@bid   ETH spread  bid/ask      depth@bid");

const start = Math.floor(Date.now() / 1000 / ROUND_S) * ROUND_S;
const endAt = Date.now() + 45_000;
let samples = 0;
const spreads: number[] = [];

while (Date.now() < endAt) {
  const rows: string[] = [];
  for (const asset of ["btc", "eth"]) {
    try {
      const events = (await getJson(`${GAMMA}/events?slug=${asset}-updown-${INTERVAL}m-${start}`)) as Record<
        string,
        unknown
      >[];
      const market = (events[0]?.markets as Record<string, unknown>[] | undefined)?.[0];
      const upToken = (JSON.parse(String(market?.clobTokenIds)) as string[])[0];
      const b = await book(upToken);
      if (!b) {
        rows.push("      (no book)            ");
        continue;
      }
      spreads.push(b.spread);
      rows.push(
        `  ${b.spread.toFixed(2)}   ${b.bid.toFixed(2)}/${b.ask.toFixed(2)}`.padEnd(26),
      );
    } catch {
      rows.push("      (unavailable)       ".padEnd(26));
    }
  }
  const elapsed = Math.round((Date.now() - start) / 1000);
  console.log(`  ${String(elapsed).padStart(3)}s ${rows[0]}${rows[1] ?? ""}`);
  samples += 1;
  await new Promise((r) => setTimeout(r, 5_000));
}

if (spreads.length) {
  const mean = spreads.reduce((a, b) => a + b, 0) / spreads.length;
  const sorted = [...spreads].sort((a, b) => a - b);
  console.log(
    `\n  ${samples} samples, ${spreads.length} books  mean spread ${mean.toFixed(3)}  ` +
      `median ${sorted[Math.floor(sorted.length / 2)].toFixed(2)}  max ${Math.max(...spreads).toFixed(2)}`,
  );
  console.log(
    `  the backtest assumed a 2c exit. A mean spread of ${mean.toFixed(2)} means that assumption is ` +
      `${mean <= 0.02 ? "CONSERVATIVE — the strategy survives it" : "TOO OPTIMISTIC — the edge is inside the spread"}`,
  );
}
void samples;
