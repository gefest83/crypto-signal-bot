/**
 * Shared market data types for the Binance spot feed that backs the signal
 * engine. Everything the strategy needs is derived from 1-minute candles plus
 * the latest traded price, so these are the only shapes that cross modules.
 */

export const MARKET_SYMBOLS = ["BTCUSDT", "ETHUSDT"] as const;

export type MarketSymbol = (typeof MARKET_SYMBOLS)[number];

export const SYMBOL_META: Record<
  MarketSymbol,
  { asset: string; name: string; accent: string }
> = {
  BTCUSDT: { asset: "BTC", name: "Bitcoin", accent: "orange" },
  ETHUSDT: { asset: "ETH", name: "Ethereum", accent: "blue" },
};

/** A single 1-minute candle, already parsed into numbers. */
export type Candle = {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
  quoteVolume: number;
  trades: number;
  /** Base-asset volume bought by taker (market buy) orders — order-flow proxy. */
  takerBuyBase: number;
  takerBuyQuote: number;
};

/** Polymarket "Up or Down" rounds we trade are 15-minute, aligned to UTC quarter-hours. */
export const ROUND_MS = 15 * 60 * 1000;

export function roundWindow(now: number): { start: number; end: number } {
  const start = Math.floor(now / ROUND_MS) * ROUND_MS;
  return { start, end: start + ROUND_MS };
}

export function isMarketSymbol(value: string): value is MarketSymbol {
  return (MARKET_SYMBOLS as readonly string[]).includes(value);
}
