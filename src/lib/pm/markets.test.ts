import { describe, expect, it } from "vitest";

import { pmRoundStart, pmSlug } from "./markets";

/**
 * A regression guard, not a description.
 *
 * `pmRoundStart` takes MILLISECONDS and divides by 1000 itself. Two call sites
 * passed seconds anyway, so every round start landed in 1970: the console
 * asked Binance for candles around the epoch, got an empty response, and
 * reported "нет свечей за окно решения" on a market that was trading normally.
 *
 * The failure was silent in the worst way — the UI showed a confident message
 * rather than an error, and the elapsed clock read +1 788 808 854 seconds, which
 * is ~20 700 days and should have been obvious on sight.
 */
describe("pmRoundStart принимает миллисекунды", () => {
  it("округляет ближайший пятиминутный интервал, а не 1970 год", () => {
    // 2026-09-28T12:03:37Z — arbitrary, well away from any epoch boundary.
    const now = Date.parse("2026-09-28T12:03:37.000Z");
    const start = pmRoundStart(now, 5) * 1000;

    expect(start).toBeLessThanOrEqual(now);
    // Inside the round, never after it: elapsed time must be 0..300s.
    expect(now - start).toBeLessThan(300_000);
    expect(now - start).toBeGreaterThanOrEqual(0);
  });

  it("15-минутный раунд длиннее 5-минутного", () => {
    const now = Date.parse("2026-09-28T12:07:00.000Z");
    expect(pmRoundStart(now, 15)).toBeLessThanOrEqual(pmRoundStart(now, 5));
  });

  it("elapsed никогда не отрицательный и не в тысячи дней", () => {
    // The exact assertion the broken dashboard could not satisfy. A round
    // start computed in the wrong unit is ~1.8e9 seconds in the past.
    const now = Date.parse("2026-09-28T12:04:59.000Z");
    const elapsed = (now - pmRoundStart(now, 5) * 1000) / 1000;
    expect(elapsed).toBeGreaterThanOrEqual(0);
    expect(elapsed).toBeLessThan(300);
  });
});

describe("слаг рынка", () => {
  it("строится из секунд раунда, не из миллисекунд", () => {
    const now = Date.parse("2026-09-28T12:03:37.000Z");
    const startSec = pmRoundStart(now, 5);
    // Passing ms here would put a 13-digit number in the slug, which matches no
    // market and silently returns nothing.
    expect(pmSlug("btc", startSec, 5)).toMatch(/^btc-updown-5m-\d{10}$/);
    expect(pmSlug("eth", startSec, 15)).toMatch(/^eth-updown-15m-\d{10}$/);
  });
});
