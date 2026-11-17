/**
 * Suite for the pure stop-target derivation (`gridStopTargets.ts`).
 *
 * The invariants pinned here are the reason the module exists:
 *   - the stop PRICE is always OUTSIDE the band (a stop inside the band executes on the noise the
 *     grid is supposed to harvest — the 70-of-89 scar);
 *   - the take-profit has NO price, because a capture-based target cannot have one;
 *   - a geometry that cannot be described returns `ok:false` rather than zeroes, because a zeroed
 *     stop is a disabled stop.
 *
 * Run: npm test
 */

import { computeGridStopTargets, GRID_STOP_DEFAULTS } from '../gridStopTargets';

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

/** The live HYPE geometry that produced the incoherent -8% / +15% pair. */
const HYPE = { lowerPrice: 66.8, upperPrice: 70.22, leverage: 2 };

// ---------------------------------------------------------------------------
// The live case
// ---------------------------------------------------------------------------

test('HYPE: the band is read as +/-2.497% of the geometric mid', () => {
  const t = computeGridStopTargets(HYPE);
  near(t.bandHalfPct, 2.497, 0.01, 'geometric mid is the right centre for a ratio-spaced ladder');
});

test('HYPE: the stop lands just past the band edge, not 1.5% below it', () => {
  const t = computeGridStopTargets(HYPE);
  eq(t.ok, true, 'a real band must produce targets');
  near(t.stopLossPrice, 66.466, 0.001, 'lowerPrice - 0.5% buffer');
  ok(t.stopLossPrice < HYPE.lowerPrice, 'the stop price MUST be outside the band');
  near(t.stopLossPct, 5.99, 0.02, 'leverage x (bandHalf + buffer) = 2 x 2.997');
});

test('HYPE: the upper bound is a STOP, not a take-profit', () => {
  const t = computeGridStopTargets(HYPE);
  near(t.stopUpperPrice, 70.571, 0.001, 'upperPrice + 0.5% buffer');
  ok(t.stopUpperPrice > HYPE.upperPrice, 'the upper stop MUST be outside the band too');
  // This is the number the ENGINE already uses (assessRangeBreakout clamps tpTriggerPx here);
  // the $75.48 the UI showed was decoration and never reached execution.
  ok(t.stopUpperPrice < 75.48, 'and it is far tighter than the decorative $75.48');
});

test('HYPE: the take-profit is a PnL %, and has no price', () => {
  const t = computeGridStopTargets(HYPE);
  near(t.takeProfitPct, 8.99, 0.03, 'rewardMultiple x SL = 1.5 x 5.99');
  eq(t.takeProfitPrice, null, 'a capture-based target has no price - inventing $75.48 was the bug');
  ok(t.takeProfitPct > t.stopLossPct, 'risk:reward must be better than 1:1');
});

test('HYPE: compared with what was running live', () => {
  const t = computeGridStopTargets(HYPE);
  // The old SL price sat 4.8% BELOW the band; the old TP price sat 7.5% ABOVE it.
  ok(t.stopLossPrice > 63.6, 'the old -8% price ($63.60) sat far outside the structure');
  ok(t.stopLossPrice < 66.8, 'and yet still outside the band, which is the only defensible side');
  ok(t.takeProfitPct < 15, 'a +15% capture target was far beyond what the band can bank');
});

// ---------------------------------------------------------------------------
// The invariants that must hold for ANY geometry
// ---------------------------------------------------------------------------

test('invariant: the stop price is always outside the band, across a sweep', () => {
  const leverages = [1, 2, 3, 5, 10];
  const halfWidthsPct = [0.4, 0.95, 1.5, 2.5, 6, 12, 25];
  for (const lever of leverages) {
    for (const half of halfWidthsPct) {
      const lower = 100 * (1 - half / 100);
      const upper = 100 * (1 + half / 100);
      const t = computeGridStopTargets({ lowerPrice: lower, upperPrice: upper, leverage: lever });
      ok(t.ok, `${lever}x / ${half}% must be describable`);
      ok(
        t.stopLossPrice < lower,
        `${lever}x / ${half}%: stop ${t.stopLossPrice} must sit below the band bottom ${lower}`
      );
      ok(
        t.stopUpperPrice > upper,
        `${lever}x / ${half}%: upper stop ${t.stopUpperPrice} must sit above the band top ${upper}`
      );
      ok(t.takeProfitPct > t.stopLossPct, `${lever}x / ${half}%: TP must beat SL`);
      eq(t.takeProfitPrice, null, `${lever}x / ${half}%: TP never gets a price`);
    }
  }
});

test('invariant: a wider band or more leverage never produces a TIGHTER stop', () => {
  let prev = 0;
  for (const half of [1, 2, 3, 4, 6]) {
    const t = computeGridStopTargets({
      lowerPrice: 100 * (1 - half / 100),
      upperPrice: 100 * (1 + half / 100),
      leverage: 2,
    });
    ok(t.stopLossPct >= prev, `a wider band must not tighten the stop (${half}%)`);
    prev = t.stopLossPct;
  }
});

// ---------------------------------------------------------------------------
// The clamps, and why they exist
// ---------------------------------------------------------------------------

test('clamp min: a band too tight for its leverage is lifted to the noise floor', () => {
  // 1% half-band at 1x: raw = 1 x 1.5 = 1.5%, which is inside the float noise of any grid.
  const t = computeGridStopTargets({ lowerPrice: 99, upperPrice: 101, leverage: 1 });
  eq(t.clampedBy, 'min', 'the minimum must bind here');
  eq(t.stopLossPct, GRID_STOP_DEFAULTS.minSlPct, 'clamped up to the floor');
  ok(t.rationale.includes('minimul'), 'and the clamp is explained, never silent');
});

test('clamp max: a wide band at high leverage never reaches toward liquidation', () => {
  // 25% half-band at 10x: raw = 10 x 25.5 = 255%, which must not become a stop.
  const t = computeGridStopTargets({ lowerPrice: 75, upperPrice: 125, leverage: 10 });
  eq(t.clampedBy, 'max', 'the ceiling must bind here');
  eq(t.stopLossPct, GRID_STOP_DEFAULTS.maxSlPct, 'clamped down to the ceiling');
  ok(t.rationale.includes('lichidare'), 'and the reason names liquidation');
});

test('clamp none: an ordinary band reports no clamp', () => {
  const t = computeGridStopTargets(HYPE);
  eq(t.clampedBy, null, '2.5% band at 2x needs no clamp');
  ok(!t.rationale.includes('ridicat la minimul'), 'and says so by omission');
});

// ---------------------------------------------------------------------------
// Hostile input — never produce a disabled stop
// ---------------------------------------------------------------------------

test('input: an indescribable geometry returns ok:false and never zeroes a stop', () => {
  const bad = [
    { lowerPrice: 0, upperPrice: 100, leverage: 2 },
    { lowerPrice: 100, upperPrice: 100, leverage: 2 },
    { lowerPrice: 101, upperPrice: 100, leverage: 2 },
    { lowerPrice: NaN, upperPrice: 100, leverage: 2 },
    { lowerPrice: 99, upperPrice: 101, leverage: 0 },
  ];
  for (const b of bad) {
    const t = computeGridStopTargets(b);
    eq(t.ok, false, `${JSON.stringify(b)} must be refused`);
    ok(t.rationale.length > 0, 'a refusal must explain itself');
    eq(t.takeProfitPrice, null, 'and never invent a price');
  }
});

test('input: zero or nonsense tuning values fall back to the documented defaults', () => {
  const d = GRID_STOP_DEFAULTS;
  const base = computeGridStopTargets(HYPE);
  const tweaked = computeGridStopTargets({ ...HYPE, bufferPct: 0, rewardMultiple: 0 });
  eq(tweaked.stopLossPct, base.stopLossPct, 'bufferPct 0 falls back, so the stop does not jump');
  eq(tweaked.takeProfitPct, base.takeProfitPct, 'rewardMultiple 0 falls back');
  near(computeGridStopTargets({ ...HYPE, rewardMultiple: 2 }).takeProfitPct, base.stopLossPct * 2, 0.02,
    'but a real rewardMultiple is honoured');
  ok(d.rewardMultiple > 1, 'the default must express positive risk:reward');
});

test('input: the report is pure — same geometry, same answer', () => {
  const a = computeGridStopTargets(HYPE);
  const b = computeGridStopTargets(HYPE);
  eq(a.stopLossPct, b.stopLossPct, 'no clock, no randomness');
  eq(a.rationale, b.rationale, 'and the explanation is reproducible');
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
console.log(`\n${tests.length - failed}/${tests.length} grid-stop-targets tests passed`);
if (failed > 0) process.exit(1);
