/**
 * Pure lock logic for the signal console.
 *
 * A "lock" is the immutable record of the first qualified call of a round: the
 * console locks it the moment the engine publishes a directional readout and
 * never rewrites it for the rest of the round — that is what "call it early"
 * means. Extracted from the React hook so the rule is unit-testable.
 */

import type { MarketSymbol } from "@/lib/market/types";
import { MARKET_SYMBOLS } from "@/lib/market/types";
import type { SignalReadout } from "./engine";
import { ENTRY_CUTOFF_MS } from "./engine";

export type LocksMap = Partial<Record<MarketSymbol, SignalReadout>>;

/** A locked call is always directional — stand-aside can never be locked. */
export type QualifiedCall = SignalReadout & { direction: "up" | "down" };

/**
 * Given the current locks and fresh readouts, decide the next locks.
 *
 * Rules, per symbol:
 * - no readout yet (feed warming up) → keep whatever was locked;
 * - a lock already exists for this window → keep it, never rewrite;
 * - a directional readout before the entry cutoff → lock it;
 * - otherwise (stand-aside or too late) → nothing is locked.
 *
 * Returns the same object instance when nothing changed, so callers can skip
 * re-renders cheaply.
 */
export function nextLocks(
  current: LocksMap,
  readouts: LocksMap,
): { locks: LocksMap; lockedCalls: QualifiedCall[] } {
  const next: LocksMap = {};
  const lockedCalls: QualifiedCall[] = [];

  for (const symbol of MARKET_SYMBOLS) {
    const readout = readouts[symbol];
    const existing = current[symbol];

    if (!readout) {
      next[symbol] = existing;
      continue;
    }
    // Same round → keep the lock; a readout from an *older* window (stale
    // tick that raced ahead of the clock) must never overwrite it either.
    if (existing && readout.windowStart <= existing.windowStart) {
      next[symbol] = existing;
      continue;
    }
    // New round: only a call published before the entry cutoff can be locked.
    if (readout.direction !== "stand-aside" && readout.elapsedMs < ENTRY_CUTOFF_MS) {
      next[symbol] = readout;
      // Re-assert the narrowed direction so the journal gets "up" | "down".
      lockedCalls.push({ ...readout, direction: readout.direction });
    } else {
      next[symbol] = undefined;
    }
  }

  for (const symbol of MARKET_SYMBOLS) {
    if (next[symbol] !== current[symbol]) {
      return { locks: next, lockedCalls };
    }
  }
  return { locks: current, lockedCalls };
}
