import { useEffect, useRef, useState } from "react";
import { MarketFeed, type FeedStatus } from "@/lib/market/binance";
import {
  MARKET_SYMBOLS,
  type Candle,
  type MarketSymbol,
} from "@/lib/market/types";

export type MarketFeedState = {
  candles: Partial<Record<MarketSymbol, Candle[]>>;
  prices: Partial<Record<MarketSymbol, number>>;
  status: FeedStatus;
  detail: string;
  updatedAt: number;
};

const EMPTY: MarketFeedState = {
  candles: {},
  prices: {},
  status: "connecting",
  detail: "",
  updatedAt: 0,
};

/** Merge a streamed candle into the history (update last, or append new). */
function upsertCandle(list: Candle[], candle: Candle): Candle[] {
  const last = list[list.length - 1];
  if (!last) return [candle];
  if (candle.openTime === last.openTime) {
    if (
      last.close === candle.close &&
      last.high === candle.high &&
      last.low === candle.low &&
      last.volume === candle.volume
    ) {
      return list;
    }
    const next = list.slice(0, -1);
    next.push(candle);
    return next;
  }
  if (candle.openTime > last.openTime) {
    const next = list.concat(candle);
    return next.length > 280 ? next.slice(next.length - 280) : next;
  }
  return list;
}

/**
 * Live BTC/ETH 1-minute candles plus the latest traded price.
 *
 * One feed instance lives for the whole page, so switching assets in the
 * console never tears down the connection.
 */
export function useMarketFeed(): MarketFeedState {
  const [state, setState] = useState<MarketFeedState>(EMPTY);
  const feedRef = useRef<MarketFeed | null>(null);

  useEffect(() => {
    const feed = new MarketFeed([...MARKET_SYMBOLS], {
      onSnapshot: (symbol, candles) =>
        setState((prev) => ({
          ...prev,
          candles: { ...prev.candles, [symbol]: candles },
          prices: { ...prev.prices, [symbol]: candles[candles.length - 1].close },
          updatedAt: Date.now(),
        })),
      onCandle: (symbol, candle) =>
        setState((prev) => {
          const existing = prev.candles[symbol];
          if (!existing) return prev;
          const next = upsertCandle(existing, candle);
          if (next === existing) return prev;
          return {
            ...prev,
            candles: { ...prev.candles, [symbol]: next },
            updatedAt: Date.now(),
          };
        }),
      onPrice: (symbol, price) =>
        setState((prev) => {
          const existing = prev.candles[symbol];
          let candles = prev.candles;
          if (existing && existing.length > 0) {
            const last = existing[existing.length - 1];
            const patched: Candle = {
              ...last,
              close: price,
              high: Math.max(last.high, price),
              low: Math.min(last.low, price),
            };
            candles = {
              ...prev.candles,
              [symbol]: [...existing.slice(0, -1), patched],
            };
          }
          return {
            ...prev,
            candles,
            prices: { ...prev.prices, [symbol]: price },
            updatedAt: Date.now(),
          };
        }),
      onStatus: (status, detail) =>
        setState((prev) => ({ ...prev, status, detail: detail ?? "" })),
    });

    feedRef.current = feed;
    feed.start();
    return () => {
      feed.stop();
      feedRef.current = null;
    };
  }, []);

  return state;
}
