/**
 * Suite for the pure profit guard (`gridProfitGuard.ts`).
 *
 * The guard exists because `drawdownPct` is 0 for every bot that is in profit, so a bot that
 * reached +5.8% and fell to +4.8% had no rule watching it at all. Tested directly rather than
 * through the analyzer: a stop rule that can only be exercised by mocking three exchange calls
 * is a stop rule nobody will ever regression-test.
 *
 * Run: npm test
 */

import {
  assessProfitGiveback,
  isBuyLevelFrozen,
  ratchetPeak,
  GRID_PROFIT_GIVEBACK_DEFAULTS,
} from '../gridProfitGuard';

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
// The ratchet
// ---------------------------------------------------------------------------

test('ratchet: a new high is recorded', () => {
  eq(ratchetPeak(2, 5.8), 5.8, 'the peak follows the best return');
});

test('ratchet: a lower return never lowers the peak', () => {
  eq(ratchetPeak(5.8, 4.8), 5.8, 'the peak is a high-water mark, not the current value');
  eq(ratchetPeak(5.8, -3), 5.8, 'and not even a loss erases it');
});

test('ratchet: undefined and negative both mean "never in profit", i.e. 0', () => {
  eq(ratchetPeak(undefined, -4), 0, 'a bot that only lost money has no peak to protect');
  eq(ratchetPeak(undefined, -0.01), 0, 'the same, however small the loss');
  eq(ratchetPeak(-2, 3), 3, 'and the sentinel is 0, not -2');
});

test('ratchet: it is idempotent — replaying the same tick changes nothing', () => {
  eq(ratchetPeak(ratchetPeak(5.8, 5.8), 5.8), 5.8, 'same input, same peak, every time');
});

// ---------------------------------------------------------------------------
// Arming
// ---------------------------------------------------------------------------

test('guard: a bot below the arming threshold is never armed', () => {
  const r = assessProfitGiveback({ peakPct: 2.9, currentPct: -5 });
  eq(r.armed, false, 'a peak under armPct does not arm the guard');
  eq(r.triggered, false, 'and a disarmed guard never fires, however far the bot falls');
  eq(r.bandPct, 0, 'a disarmed assessment reports no band to act on');
  eq(r.floorPct, 0, 'and no floor either');
});

test('guard: the guard arms exactly at the threshold', () => {
  eq(assessProfitGiveback({ peakPct: 3, currentPct: 3 }).armed, true, 'peak == armPct arms');
  eq(assessProfitGiveback({ peakPct: 2.99, currentPct: 3 }).armed, false, 'a hair below does not');
});

// ---------------------------------------------------------------------------
// The band
// ---------------------------------------------------------------------------

test('band: the ratio dominates on a large peak', () => {
  const r = assessProfitGiveback({ peakPct: 10, currentPct: 10 });
  near(r.bandPct, 4, 1e-9, '40% of a +10% peak is a 4 point band');
  near(r.floorPct, 6, 1e-9, 'so the floor sits at +6%');
});

test('band: the absolute floor dominates on a small peak', () => {
  const r = assessProfitGiveback({ peakPct: 3.1, currentPct: 3.1 });
  near(r.bandPct, 2, 1e-9, '40% of +3.1% is only 1.24, so the 2 point noise floor wins');
  near(r.floorPct, 1.1, 1e-9, 'and the floor lands at +1.1%');
});

test('band: a 1.7% giveback on a +5.8% peak is NOT a stop (the case that started this)', () => {
  const r = assessProfitGiveback({ peakPct: 5.8, currentPct: 5.07 });
  near(r.bandPct, 2.32, 1e-9, 'the band is 40% of the peak');
  near(r.floorPct, 3.48, 1e-9, 'the floor is +3.48%');
  eq(r.triggered, false, 'sitting at +5.07% is inside the band — this is float noise, not a reversal');
});

test('band: crossing the floor by one basis point fires', () => {
  eq(assessProfitGiveback({ peakPct: 5.8, currentPct: 3.49 }).triggered, false, 'just above the floor');
  eq(assessProfitGiveback({ peakPct: 5.8, currentPct: 3.48 }).triggered, true, 'on the floor itself');
  eq(assessProfitGiveback({ peakPct: 5.8, currentPct: 2 }).triggered, true, 'and below it');
});

test('band: giving everything back to zero is a stop', () => {
  eq(assessProfitGiveback({ peakPct: 5.8, currentPct: 0 }).triggered, true,
    'a bot that peaked at +5.8% and is back to 0 has failed — this is the whole point');
});

test('band: the trigger is monotone in the current return', () => {
  // Walk from +10% down to -10%: once fired it must never un-fire as the bot falls further.
  let seenTriggered = false;
  for (let cur = 10; cur >= -10; cur -= 0.01) {
    const r = assessProfitGiveback({ peakPct: 5.8, currentPct: cur });
    if (seenTriggered && !r.triggered) {
      throw new Error(`the guard un-fired at ${cur.toFixed(2)}% — a monotone rule must not oscillate`);
    }
    if (r.triggered) seenTriggered = true;
  }
  ok(seenTriggered, 'the walk must reach the triggered state at least once');
});

// ---------------------------------------------------------------------------
// The buy-ladder freeze
// ---------------------------------------------------------------------------

test('freeze: no freeze price means nothing is frozen', () => {
  eq(isBuyLevelFrozen(undefined, 1), false, 'an unused field must not freeze the ladder');
  eq(isBuyLevelFrozen(0, 1), false, 'and 0 is the "off" sentinel, not a price');
  eq(isBuyLevelFrozen(-5, 1), false, 'a negative price is not a freeze');
});

test('freeze: at or below the freeze price the buy is kept off the venue', () => {
  eq(isBuyLevelFrozen(1.2, 1.2), true, 'the boundary itself is frozen (at-or-below)');
  eq(isBuyLevelFrozen(1.2, 1.1), true, 'and everything under it');
  eq(isBuyLevelFrozen(1.2, 1.3), false, 'a buy above the freeze stays live, so the ladder can sell');
});

test('freeze: an unpriceable level is never frozen by accident', () => {
  eq(isBuyLevelFrozen(1.2, NaN), false, 'a NaN price must not invent a freeze');
  eq(isBuyLevelFrozen(NaN, 1), false, 'nor must a NaN threshold');
});

// ---------------------------------------------------------------------------
// Hostile input
// ---------------------------------------------------------------------------

test('input: NaN and nonsense fall back to the documented defaults', () => {
  const r = assessProfitGiveback({ peakPct: NaN, currentPct: NaN });
  eq(r.armed, false, 'an unmeasurable peak cannot arm a guard');
  eq(r.triggered, false, 'and cannot fire one');

  const d = GRID_PROFIT_GIVEBACK_DEFAULTS;
  near(assessProfitGiveback({ peakPct: 10, currentPct: 10, armPct: 0 }).bandPct, 10 * d.ratio, 1e-9,
    'armPct 0 is not a valid threshold and falls back to the default ratio');
  near(assessProfitGiveback({ peakPct: 10, currentPct: 10, ratio: 0 }).bandPct, 4, 1e-9,
    'ratio 0 would mean "never give back anything" — refused, default ratio used instead');
  near(assessProfitGiveback({ peakPct: 10, currentPct: 10, ratio: 5 }).bandPct, 4, 1e-9,
    'ratio > 1 would mean a negative floor — refused');
  near(assessProfitGiveback({ peakPct: 3.1, currentPct: 3.1, minBandPct: -9 }).bandPct, 1.24, 1e-9,
    'a negative floor band is clamped away, leaving the ratio band');
});

test('input: a negative peak is clamped to zero rather than arming a loser', () => {
  const r = assessProfitGiveback({ peakPct: -12, currentPct: -12 });
  eq(r.peakPct, 0, 'a peak can never be negative');
  eq(r.armed, false, 'so a losing bot cannot arm the guard');
});

test('input: the assessment is pure — same input, same answer', () => {
  const a = assessProfitGiveback({ peakPct: 5.8, currentPct: 3.4 });
  const b = assessProfitGiveback({ peakPct: 5.8, currentPct: 3.4 });
  eq(a.triggered, b.triggered, 'no clock, no randomness');
  eq(a.floorPct, b.floorPct, 'the floor is reproducible');
});

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
let failed = 0;
for (const t of tests) {
  try {
    t.fn();
    console.log(`  ok    ${t.name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL  ${t.name}\n        ${(err as Error).message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} grid-profit-guard tests passed`);
if (failed > 0) process.exit(1);
