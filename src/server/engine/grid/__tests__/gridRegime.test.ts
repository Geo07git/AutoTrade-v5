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
  choppinessIndex,
  efficiencyRatio,
  efficiencyRatioFromKlines,
  hasDirectionalPressure,
  refusesOpen,
  regimeSignals,
  isDisplacedRegime,
  wilderAdx,
  GRID_BREAKOUT_CONFIRM_MINUTES,
  GRID_BREAKOUT_MIN_BUFFER_PCT,
  GRID_ER_EXIT_BARS,
  GRID_ER_TREND_THRESHOLD,
  INITIAL_OUTSIDE_BAND_STATE,
} from '../gridRegime';
import { NeutralGridAnalyzer } from '../NeutralGridAnalyzer';
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
// ADX and Choppiness (the two numbers the agent used to fabricate as 0)
// ---------------------------------------------------------------------------

/** Bars with a real high/low envelope, so true range and directional movement exist. */
const barKlines = (closes: number[], rangePct = 0.4): Kline[] =>
  closes.map((c, i) => ({
    timestamp: 1_700_000_000_000 + i * 3_600_000,
    open: i > 0 ? closes[i - 1] : c,
    high: c * (1 + rangePct / 200),
    low: c * (1 - rangePct / 200),
    close: c,
    volume: 100,
  }));

test('ADX: a one-way tape has directional pressure, a sawtooth does not', () => {
  const trending = wilderAdx(barKlines(ramp(48, 100, 20)), 14)!;
  const sideways = wilderAdx(barKlines(chop(48)), 14)!;

  ok(trending !== null && sideways !== null, 'both fixtures must be measurable');
  ok(trending > 25, `a straight climb must read as a trend, got ${trending}`);
  ok(sideways <= 25, `a sawtooth must not read as a trend, got ${sideways}`);
  ok(hasDirectionalPressure(trending, null), 'high ADX alone is directional pressure');
  ok(!hasDirectionalPressure(sideways, null), 'a low ADX is not, on its own');
});

// ---------------------------------------------------------------------------
// The LIVE GATE predicate. Time-boxed experiment (7 days / 20 bots): refuse only when BOTH
// readings are hot, so a candidate that clears one of the two filters is allowed through.
// The label path keeps the OR on purpose - the two must not be confused, which is exactly what
// a single boolean function made impossible to express.
// ---------------------------------------------------------------------------
test('gate: refuses only when BOTH readings are hot (the experiment)', () => {
  ok(refusesOpen(47.2, 33.2), 'hot ADX + low chop = directional pressure, do not open');
  ok(!refusesOpen(47.2, 46.8), 'hot ADX with a healthy chop must NO LONGER refuse');
  ok(!refusesOpen(18, 33.2), 'calm ADX with a low chop must NO LONGER refuse');
  ok(!refusesOpen(18, 60), 'a calm tape is grid weather');
});

test('gate: an unmeasured reading is never evidence of a trend', () => {
  ok(!refusesOpen(null, 33.2), 'null ADX must not manufacture a refusal');
  ok(!refusesOpen(47.2, null), 'null chop must not manufacture a refusal');
  ok(!refusesOpen(null, null), 'nothing measured is not a trend');
});

test('gate: the label keeps the OR while the gate uses the AND', () => {
  // Loosening the gate must not silently change how a candidate is DESCRIBED: the panel would
  // start calling a calm tape 'TRENDING_RISK' the moment these two became one function again.
  ok(hasDirectionalPressure(47.2, 46.8), 'the label still flags a hot ADX on its own');
  ok(!refusesOpen(47.2, 46.8), 'while the gate lets it through');
  const s = regimeSignals(47.2, 46.8);
  ok(s.adxHot && !s.chopCold, 'the two readings must stay separately visible');
});

test('ADX: unusable input reports null, never a fabricated 20', () => {
  // The analyzer's static wrapper keeps returning 20 for its own contract; the pure function must
  // not, or a selection gate cannot tell "unknown" from "no pressure".
  eq(wilderAdx([], 14), null, 'no bars -> null');
  eq(wilderAdx(barKlines(chop(10)), 14), null, 'fewer bars than the period -> null');
});

test('ADX: the analyzer and the agent scan cannot drift apart (parity)', () => {
  // Two callers, two numbers on the same tape, is how a desk ends up arguing about which one is
  // real. Same fixture, same answer — the analyzer's `20` fallback is the only difference.
  for (const fixture of [barKlines(ramp(48, 100, 20)), barKlines(chop(48)), barKlines(chop(20))]) {
    eq(
      wilderAdx(fixture, 14),
      NeutralGridAnalyzer.computeWilderAdx14(fixture, 14),
      'gridRegime.wilderAdx and NeutalGridAnalyzer.computeWilderAdx14 must agree'
    );
  }
});

test('Choppiness: high on a range, low on a one-way move, null without data', () => {
  const ranging = choppinessIndex(barKlines(chop(48), 1.2), 14)!;
  const trending = choppinessIndex(barKlines(ramp(48, 100, 20), 1.2), 14)!;

  ok(ranging > trending, `a range must read choppier than a climb (${ranging} vs ${trending})`);
  ok(trending < 45, `a straight climb must read as directional, got ${trending}`);
  ok(ranging <= 95 && ranging >= 10, 'the index stays inside its clamp');
  eq(choppinessIndex(barKlines(chop(5)), 14), null, 'too few bars -> null, not 0');
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
