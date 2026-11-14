/**
 * Suite for the pure regime measures (`gridRegime.ts`).
 *
 * These two functions decide WHO gets scanned (efficiency ratio) and WHEN a bot is closed
 * (breakout confirmation). Both are pure, so they are tested directly rather than through the
 * analyzer — a stop rule that can only be exercised by mocking three exchange calls is a stop rule
 * nobody will ever regression-test.
 *
 * Run: npm test
 */

import {
  advanceOutsideBandState,
  assessRangeBreakout,
  efficiencyRatio,
  efficiencyRatioFromKlines,
  isDisplacedRegime,
  GRID_BREAKOUT_CONFIRM_MINUTES,
  GRID_BREAKOUT_MIN_BUFFER_PCT,
  GRID_ER_EXIT_BARS,
  GRID_ER_TREND_THRESHOLD,
  INITIAL_OUTSIDE_BAND_STATE,
} from '../gridRegime';
import type { Kline } from '../../../../shared/types';

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
const tests: { name: string; fn: () => void }[] = [];
const test = (name: string, fn: () => void) => tests.push({ name, fn });

const ok = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(msg);
};
const eq = (actual: unknown, expected: unknown, msg: string): void => {
  if (actual !== expected) throw new Error(`${msg} (expected ${String(expected)}, got ${String(actual)})`);
};
const near = (actual: number, expected: number, tol: number, msg: string): void => {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > tol) {
    throw new Error(`${msg} (expected ~${expected}, got ${actual})`);
  }
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A perfect two-way sawtooth: travels a lot, ends where it started. ER ~ 0. */
const chop = (n = 32, base = 100, ampPct = 0.5): number[] =>
  Array.from({ length: n }, (_, i) => (i % 2 === 0 ? base : base * (1 + ampPct / 100)));

/** A straight line from `base` to `base * (1 + totalPct/100)`: path === displacement. ER = 1. */
const ramp = (n = 32, base = 100, totalPct = 8): number[] =>
  Array.from({ length: n }, (_, i) => base * (1 + (totalPct / 100) * (i / (n - 1))));

const klines = (closes: number[]): Kline[] =>
  closes.map((c, i) => ({
    timestamp: 1_700_000_000_000 + i * 900_000,
    open: c,
    high: c * 1.001,
    low: c * 0.999,
    close: c,
    volume: 100,
  }));

// ---------------------------------------------------------------------------
// Efficiency ratio
// ---------------------------------------------------------------------------

test('ER: a sawtooth travels without going anywhere (the grid ideal)', () => {
  const er = efficiencyRatio(chop())!;
  ok(er !== null, 'ER must be measurable on a 32-bar window');
  ok(er < 0.1, `a clean sawtooth must read as oscillation, got ${er}`);
  ok(!isDisplacedRegime(er), 'oscillation must not be classified as displacement');
});

test('ER: a straight ramp is pure displacement (=1) and is refused', () => {
  const er = efficiencyRatio(ramp())!;
  near(er, 1, 0.02, 'a monotone ramp has path === displacement');
  ok(isDisplacedRegime(er), 'a ramp must be classified as displacement');
});

test('ER: the H/LINK/HYPE shape — a pump that then stalls — is still displacement', () => {
  // 24 bars straight up (+8%), then 8 bars flat: most of the path went one way.
  const closes = [...ramp(24, 100, 8), ...Array.from({ length: 8 }, () => 108)];
  const er = efficiencyRatio(closes)!;
  ok(er > GRID_ER_TREND_THRESHOLD, `an 8% pump must not read as chop, got ${er}`);
});

test('ER: needs at least 2 usable closes, and says so with null rather than 0', () => {
  eq(efficiencyRatio([]), null, 'empty series is unknown, not calm');
  eq(efficiencyRatio([100]), null, 'one close cannot describe a path');
  eq(efficiencyRatio([NaN, Infinity, -5]), null, 'unusable closes must not pass as calm');
});

test('ER: unknown is NOT a trend (a gate must not refuse on missing data)', () => {
  ok(!isDisplacedRegime(null), 'null ER must not refuse a candidate');
  ok(!isDisplacedRegime(0.39), 'just under the threshold is still oscillation');
  ok(isDisplacedRegime(0.41), 'just over the threshold is displacement');
});

test('ER: kline helper measures the LAST window, not the whole series', () => {
  // An old 8% rally followed by a long chop must read as chop over the trade window.
  const closes = [...ramp(40, 100, 8), ...chop(64, 108, 0.5)];
  const er = efficiencyRatioFromKlines(klines(closes), GRID_ER_EXIT_BARS)!;
  ok(er !== null && er < 0.2, `the window must be the recent tape, got ${er}`);
});

// ---------------------------------------------------------------------------
// Breakout confirmation
// ---------------------------------------------------------------------------

const band = (over: Record<string, unknown> = {}) => ({
  currentPx: 100,
  minPx: 95,
  maxPx: 105,
  ...over,
});

test('breakout: the buffer is at least 0.5% — a flat 0.15% was inside the noise', () => {
  const r = assessRangeBreakout(band({ currentPx: 105.1, configuredBufferPct: 0.15 }));
  eq(r.bufferPct, GRID_BREAKOUT_MIN_BUFFER_PCT, 'configured buffer below the floor is raised');
  // 105 * 1.005 = 105.525 -> 105.1 is outside the band but INSIDE the buffered break price.
  eq(r.outsideBand, true, '105.1 is outside the raw band');
  eq(r.beyondBuffer, false, '105.1 must not count as a breach under a 0.5% buffer');
});

test('breakout: the buffer scales with the 15m ATR (half an ATR)', () => {
  const r = assessRangeBreakout(band({ currentPx: 106, atrPct: 4, configuredBufferPct: 0.15 }));
  near(r.bufferPct, 2, 1e-9, '0.5 x ATR of 4% sets the buffer');
  eq(r.beyondBuffer, false, '106 is inside a 105 * 1.02 = 107.1 break price');
});

test('breakout: a single tick beyond the buffer does NOT stop (the 70-of-89 bug)', () => {
  const r = assessRangeBreakout(
    band({ currentPx: 106, efficiencyRatio: 0.2, adx: 18, adxEvalsAboveStop: 0, outsideMinutes: 0 })
  );
  eq(r.beyondBuffer, true, 'price is beyond the break price');
  eq(r.confirmed, false, 'a fresh breach with no corroboration must not confirm');
  eq(r.confirmedBy, null, 'nothing confirmed it');
});

test('breakout: persistence confirms it', () => {
  const r = assessRangeBreakout(band({ currentPx: 106, outsideMinutes: GRID_BREAKOUT_CONFIRM_MINUTES }));
  eq(r.confirmed, true, 'price outside the band for the full window is a confirmed breakout');
  eq(r.confirmedBy, 'PERSISTENCE', 'and the reason is the persistence window');
});

test('breakout: a decisive efficiency ratio confirms it without waiting', () => {
  const r = assessRangeBreakout(band({ currentPx: 106, outsideMinutes: 1, efficiencyRatio: 0.62 }));
  eq(r.confirmed, true, 'ER 0.62 is unambiguous displacement');
  eq(r.confirmedBy, 'EFFICIENCY', 'ER is the corroborating measure');
});

test('breakout: a persistent ADX confirms it; a single reading does not', () => {
  const persistent = assessRangeBreakout(
    band({ currentPx: 106, adx: 31, adxEvalsAboveStop: 3, outsideMinutes: 1, efficiencyRatio: 0.2 })
  );
  eq(persistent.confirmed, true, 'ADX 31 over 3 evaluations confirms');
  eq(persistent.confirmedBy, 'ADX', 'and the reason is the ADX stack');

  const single = assessRangeBreakout(
    band({ currentPx: 106, adx: 31, adxEvalsAboveStop: 1, outsideMinutes: 1, efficiencyRatio: 0.2 })
  );
  eq(single.confirmed, false, 'one noisy ADX reading must not confirm a breakout');
});

test('breakout: the venue stop never lets the band get WIDER than the held stop', () => {
  // OKX already holds a stop at 94.8, inside the buffered break price (95 * 0.995 = 94.525):
  // the bot must react there, not wait for the band buffer past a stop that has already fired.
  const r = assessRangeBreakout(band({ currentPx: 94.7, slTriggerPx: 94.8 }));
  near(r.lowerBreakPx, 94.8, 1e-9, 'the break price is clamped up to the trigger OKX holds');
  eq(r.side, 'BELOW', 'and price below it is a downside breach');
});

test('breakout: a degenerate band reports no breach instead of a division artefact', () => {
  const r = assessRangeBreakout({ currentPx: 100, minPx: 0, maxPx: 0 });
  eq(r.side, 'NONE', 'no band, no verdict');
  eq(r.beyondBuffer, false, 'and certainly no stop');
});

// ---------------------------------------------------------------------------
// False-break bookkeeping
// ---------------------------------------------------------------------------

test('false breaks: an excursion that comes back inside is counted once', () => {
  const t0 = 1_700_000_000_000;
  const out = advanceOutsideBandState(INITIAL_OUTSIDE_BAND_STATE, {
    currentPx: 106, // above maxPx 105
    minPx: 95,
    maxPx: 105,
    now: t0,
  });
  eq(out.sinceAt, t0, 'the excursion starts now');
  eq(out.outsideMinutes, 0, 'zero minutes so far');

  const still = advanceOutsideBandState(out, { currentPx: 106, minPx: 95, maxPx: 105, now: t0 + 600_000 });
  near(still.outsideMinutes, 10, 1e-6, 'ten minutes outside');
  eq(still.falseBreaks, 0, 'not a false break until it returns');

  const back = advanceOutsideBandState(still, { currentPx: 104, minPx: 95, maxPx: 105, now: t0 + 1_200_000 });
  eq(back.sinceAt, 0, 'the excursion is over');
  eq(back.outsideMinutes, 0, 'and the clock resets');
  eq(back.falseBreaks, 1, 'a 20 minute excursion that reverted is a false break');
});

test('false breaks: a long excursion that recovers is not counted as a wick', () => {
  const t0 = 1_700_000_000_000;
  const out = advanceOutsideBandState(INITIAL_OUTSIDE_BAND_STATE, {
    currentPx: 94, minPx: 95, maxPx: 105, now: t0,
  });
  const back = advanceOutsideBandState(out, {
    currentPx: 100, minPx: 95, maxPx: 105, now: t0 + 5 * 3_600_000, // 5 hours outside
  });
  eq(back.falseBreaks, 0, 'a 5h breakout that recovered is not a wick');
});

test('false breaks: counter is monotone and survives a missing price', () => {
  const t0 = 1_700_000_000_000;
  const seeded = { sinceAt: 0, outsideMinutes: 0, falseBreaks: 3 };
  const missing = advanceOutsideBandState(seeded, { currentPx: 0, minPx: 95, maxPx: 105, now: t0 });
  eq(missing.falseBreaks, 3, 'an unreadable price must not reset the tally');
  eq(missing.sinceAt, 0, 'nor start an excursion');
});

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
let failed = 0;
for (const t of tests) {
  try {
    t.fn();
    console.log(`  ok   ${t.name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${t.name}\n       ${(err as Error).message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
if (failed > 0) process.exit(1);
