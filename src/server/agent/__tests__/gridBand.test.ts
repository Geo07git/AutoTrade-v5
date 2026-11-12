/**
 * Regression suite for the constructed grid band (`gridBand.ts`).
 *
 * Two things are locked here, for different reasons:
 *
 *  1. THE PLACEMENT CONTRACT — a constructed band may move WHERE the window sits, but it must
 *     never change WHAT the scan ranked: width and step keep their values, so `crossingsPerHour`,
 *     `netPerGridPct` and `expectedFirstFillMin` stay true.
 *  2. THE GUARD — `inspectBandLegality` is the line the execution path leans on when it validates
 *     a band the MODEL wrote into the decision JSON. It must reject, not warn, and it must stay
 *     silent when the extremes are unknown (a missing 24h high is not evidence of a bad band).
 *
 * Run: npm test
 */

import {
  BAND_EXTREME_PROXIMITY_PCT,
  BAND_MIN_STEPS_FROM_EDGE,
  buildConstructedBand,
  buildSymmetricBand,
  inspectBandLegality,
  measureOscillationZone,
  type BandBar,
} from '../gridBand';

// ---------------------------------------------------------------------------
// Tiny runner (same pattern as agentUniverseScan.test.ts)
// ---------------------------------------------------------------------------

const registered: Array<{ name: string; fn: () => Promise<void> | void }> = [];
const test = (name: string, fn: () => Promise<void> | void) => registered.push({ name, fn });

const ok = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(msg);
};

const eq = (actual: unknown, expected: unknown, msg: string): void => {
  if (actual !== expected) {
    throw new Error(`${msg} (expected ${String(expected)}, got ${String(actual)})`);
  }
};

const near = (actual: number, expected: number, tolerance: number, msg: string): void => {
  if (!(Math.abs(actual - expected) <= tolerance)) {
    throw new Error(`${msg} (expected ~${expected}, got ${actual})`);
  }
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** `n` bars whose closes walk from `from` to `to`, with a flat 0.1% wick either side. */
function bars(from: number, to: number, n = 40): BandBar[] {
  return Array.from({ length: n }, (_, i) => {
    const close = from + ((to - from) * i) / (n - 1);
    return { high: close * 1.001, low: close * 0.999, close };
  });
}

/** Room on both sides: price 100, extremes at 80 / 130. */
const ROOMY = { low24h: 80, high24h: 130, price: 100, tickSz: 0.01, gridNum: 4 };
const ROOMY_BARS = bars(96, 104);

const isOnTick = (px: number, tick: number): boolean =>
  Math.abs(px / tick - Math.round(px / tick)) < 1e-6;

// ---------------------------------------------------------------------------
// Constants — the measured numbers, locked so a silent re-tune fails here
// ---------------------------------------------------------------------------

test('band: the proximity constant is the measured 1%, not the untested 2.5%', () => {
  // Measured against 261 live `_UM_XPERP` contracts: 2.5% admitted a legal window for only 16%
  // of them at a realistic 3.2% band width, which is an outage dressed as a guard.
  eq(BAND_EXTREME_PROXIMITY_PCT, 1, 'BAND_EXTREME_PROXIMITY_PCT must stay at the measured 1%');
  eq(BAND_MIN_STEPS_FROM_EDGE, 1, 'price must keep one full grid step inside each edge');
});

// ---------------------------------------------------------------------------
// Oscillation zone
// ---------------------------------------------------------------------------

test('zone: the centre ignores a single wick, the extremes do not', () => {
  const zone = measureOscillationZone([
    ...bars(100, 109, 10),
    { high: 200, low: 50, close: 104 },
  ]);

  eq(zone.count, 11, 'every usable bar is measured');
  eq(zone.stickHigh, 200, 'the wick extreme is reported as-is');
  eq(zone.stickLow, 50, 'the wick low is reported as-is');
  ok(
    zone.coreHigh < 110,
    `the robust zone must stay near the closes, got ${zone.coreHigh} - one wick dragged the band`
  );
  ok(zone.coreLow >= 100, `the robust low must stay near the closes, got ${zone.coreLow}`);
});

test('zone: empty or junk input is reported as unknown instead of guessed', () => {
  const empty = measureOscillationZone([]);
  eq(empty.count, 0, 'no bars means no measurement');
  eq(empty.coreLow, 0, 'and no invented centre');

  const junk = measureOscillationZone([
    { high: NaN, low: 1, close: 100 },
    { high: 2, low: 1, close: 0 },
  ] as BandBar[]);
  eq(junk.count, 0, 'non-finite or non-positive bars are dropped');
});

// ---------------------------------------------------------------------------
// The placement contract — width and step must NOT move
// ---------------------------------------------------------------------------

test('constructed: the window is legal, inside the 24h limits, and around the price', () => {
  const band = buildConstructedBand({ ...ROOMY, widthPct: 2, klines15m: ROOMY_BARS });

  ok(band.ok, `expected a legal window, got: ${band.reason}`);
  eq(band.method, 'CONSTRUCTED', 'a legal construction must not fall back');
  ok(
    band.minPx >= ROOMY.low24h * (1 + BAND_EXTREME_PROXIMITY_PCT / 100) - 1e-9,
    'the lower edge must clear the 24h low margin'
  );
  ok(
    band.maxPx <= ROOMY.high24h * (1 - BAND_EXTREME_PROXIMITY_PCT / 100) + 1e-9,
    'the upper edge must clear the 24h high margin'
  );
  ok(band.minPx < ROOMY.price && ROOMY.price < band.maxPx, 'the price must sit strictly inside');
});

test('constructed: the requested width and step survive placement', () => {
  const band = buildConstructedBand({ ...ROOMY, widthPct: 2, klines15m: ROOMY_BARS });

  ok(band.ok, `expected a legal window, got: ${band.reason}`);
  // Snapping is outward, so the band may grow by at most one tick per side — never shrink.
  near(band.widthPct, 2, 0.05, 'the band must keep the width the scan ranked');
  near(band.stepPct, band.widthPct / ROOMY.gridNum, 1e-3, 'the step must stay width / gridNum');
  ok(band.widthPct >= 2, `snapping must not shrink the band, got ${band.widthPct}%`);
});

test('constructed: both edges keep one full grid step away from the price', () => {
  const band = buildConstructedBand({ ...ROOMY, widthPct: 2, klines15m: ROOMY_BARS });

  ok(band.ok, `expected a legal window, got: ${band.reason}`);
  const stepPx = (ROOMY.price * band.stepPct) / 100;
  ok(
    ROOMY.price - band.minPx >= stepPx - 1e-9,
    `the lower side ${ROOMY.price - band.minPx} is under one step (${stepPx}) - a one-way ladder`
  );
  ok(
    band.maxPx - ROOMY.price >= stepPx - 1e-9,
    `the upper side ${band.maxPx - ROOMY.price} is under one step (${stepPx})`
  );
});

test('constructed: the edges land exactly on the tick grid', () => {
  const band = buildConstructedBand({ ...ROOMY, widthPct: 2, klines15m: ROOMY_BARS });

  ok(band.ok, `expected a legal window, got: ${band.reason}`);
  ok(isOnTick(band.minPx, ROOMY.tickSz), `${band.minPx} is not a multiple of ${ROOMY.tickSz}`);
  ok(isOnTick(band.maxPx, ROOMY.tickSz), `${band.maxPx} is not a multiple of ${ROOMY.tickSz}`);
});

test('constructed: an off-centre window reports the real adverse walk, not half the width', () => {
  // Price pinned to the top of the legal interval: the leverage ceiling must then survive the
  // LOWER side, so `maxSidePct` has to exceed half the band. This is the number fed to
  // `maxLeverageForBand`; using `halfRangePct` there would understate the walk.
  const band = buildConstructedBand({
    low24h: 80,
    high24h: 130,
    price: 100,
    tickSz: 0.01,
    gridNum: 4,
    widthPct: 2,
    klines15m: bars(90, 94), // the market lives well below the price
  });

  ok(band.ok, `expected a legal window, got: ${band.reason}`);
  eq(band.maxSidePct, Math.max(band.lowerSidePct, band.upperSidePct), 'maxSidePct is the larger side');
  ok(
    band.maxSidePct > band.widthPct / 2 + 1e-9,
    `an off-centre band must report a walk above half its width (${band.maxSidePct}% vs ${band.widthPct}%)`
  );
  ok(band.lowerSidePct !== band.upperSidePct, 'the offset window must not be reported as symmetric');
});

// ---------------------------------------------------------------------------
// Hard rule — the whole point of the module
// ---------------------------------------------------------------------------

test('constructed: a price within the margin of the 24h low is REFUSED', () => {
  // The scenario the rule exists for: a neutral grid on the 24h low breaks out on the next new
  // low and fills every level in one direction.
  const band = buildConstructedBand({
    low24h: 100,
    high24h: 200,
    price: 100.5,
    tickSz: 0.01,
    gridNum: 4,
    widthPct: 2,
    klines15m: bars(100, 101),
  });

  eq(band.ok, false, 'a band on the 24h low must never be built');
  eq(band.method, 'CONSTRUCTED', 'the refusal is the construction, not the fallback');
  ok(/minimul de 24h/i.test(band.reason || ''), `the refusal must name the low, got: ${band.reason}`);
});

test('constructed: a price within the margin of the 24h high is REFUSED', () => {
  const band = buildConstructedBand({
    low24h: 100,
    high24h: 200,
    price: 199.6,
    tickSz: 0.01,
    gridNum: 4,
    widthPct: 2,
    klines15m: bars(199, 200),
  });

  eq(band.ok, false, 'a band on the 24h high must never be built');
  ok(/maximul de 24h/i.test(band.reason || ''), `the refusal must name the high, got: ${band.reason}`);
});

test('constructed: a band wider than the legal window is refused, not narrowed', () => {
  // Narrowing the band to fit would change the step the scan ranked on, so the candidate goes.
  const band = buildConstructedBand({
    low24h: 100,
    high24h: 200,
    price: 150,
    tickSz: 0.01,
    gridNum: 4,
    widthPct: 120,
    klines15m: bars(140, 160),
  });

  eq(band.ok, false, 'an oversized band must be refused');
  ok(
    /nu încape|fereastra legală/i.test(band.reason || ''),
    `the refusal must say the band does not fit, got: ${band.reason}`
  );
  eq(band.minPx, 0, 'a refused band must not expose a lower edge');
  eq(band.maxPx, 0, 'a refused band must not expose an upper edge');
  eq(band.widthPct, 120, 'the journal keeps the width that was asked for, so the refusal is legible');
});

test('constructed: unknown 24h extremes disable the rule instead of guessing one', () => {
  const band = buildConstructedBand({
    price: 100,
    tickSz: 0.01,
    gridNum: 4,
    widthPct: 2,
    klines15m: ROOMY_BARS,
  });

  ok(band.ok, `a missing ticker extreme must not disqualify the candidate: ${band.reason}`);
  ok(
    band.notes.some((n) => /NU a putut fi aplicată/i.test(n)),
    `the journal must record the skipped rule, got: ${band.notes.join(' | ')}`
  );
});

test('constructed: when both the construction and the fallback fail, both reasons survive', () => {
  const band = buildConstructedBand({
    low24h: 99.9,
    high24h: 100.1,
    price: 100,
    tickSz: 0.01,
    gridNum: 4,
    widthPct: 2,
    klines15m: ROOMY_BARS,
  });

  eq(band.ok, false, 'a price inside both extremes cannot carry a band');
  ok(
    band.notes.some((n) => /bandă simetrică/i.test(n)),
    `the journal must keep the fallback refusal, got: ${band.notes.join(' | ')}`
  );
});

test('constructed: invalid input is refused with a reason, never with numbers', () => {
  const cases: Array<{ input: Parameters<typeof buildConstructedBand>[0]; why: string }> = [
    { input: { ...ROOMY, widthPct: 2, klines15m: ROOMY_BARS, price: 0 }, why: 'price 0' },
    { input: { ...ROOMY, widthPct: 0, klines15m: ROOMY_BARS }, why: 'width 0' },
    { input: { ...ROOMY, widthPct: 2, klines15m: ROOMY_BARS, gridNum: 1 }, why: 'gridNum 1' },
  ];
  for (const c of cases) {
    const band = buildConstructedBand(c.input);
    eq(band.ok, false, `${c.why} must be refused`);
    ok(!!band.reason, `${c.why} must carry a reason`);
    eq(band.maxPx, 0, `${c.why} must not return a band`);
  }
});

test('constructed: the symmetric fallback can be switched off explicitly', () => {
  const band = buildConstructedBand({
    low24h: 80,
    high24h: 100.5,
    price: 100,
    tickSz: 0.01,
    gridNum: 4,
    widthPct: 2,
    klines15m: ROOMY_BARS,
    allowSymmetricFallback: false,
  });

  eq(band.ok, false, 'the fallback must be genuinely disabled');
  eq(band.method, 'CONSTRUCTED', 'and the refusal must stay labelled as a construction');
});

// ---------------------------------------------------------------------------
// Symmetric band — the reference the constructed one is compared against
// ---------------------------------------------------------------------------

test('symmetric: the band is price x (1 -+ width/2), snapped outward, and labelled', () => {
  const band = buildSymmetricBand({
    price: 100,
    widthPct: 2,
    gridNum: 4,
    tickSz: 0.01,
    low24h: 80,
    high24h: 130,
  });

  ok(band.ok, `expected a legal symmetric band, got: ${band.reason}`);
  eq(band.method, 'SYMMETRIC_FALLBACK', 'the method must say which band was used');
  eq(band.minPx, 99, 'lower edge = price - width/2');
  eq(band.maxPx, 101, 'upper edge = price + width/2');
  near(band.lowerSidePct, 1, 1e-9, 'the symmetric band is centred');
  near(band.upperSidePct, 1, 1e-9, 'the symmetric band is centred');
});

test('symmetric: it is checked against the same hard rule as the construction', () => {
  const band = buildSymmetricBand({
    price: 100.5,
    widthPct: 2,
    gridNum: 4,
    tickSz: 0.01,
    low24h: 100,
    high24h: 200,
  });

  eq(band.ok, false, 'the fallback may not smuggle in a band the construction would refuse');
  ok(/24h/i.test(band.reason || ''), `the refusal must name the extreme, got: ${band.reason}`);
});

// ---------------------------------------------------------------------------
// The execution guard — a separate check on a band the MODEL wrote
// ---------------------------------------------------------------------------

test('guard: a legal band passes silently', () => {
  eq(
    inspectBandLegality({ price: 100, minPx: 99, maxPx: 101, low24h: 80, high24h: 130 }),
    null,
    'a legal band must not be refused'
  );
});

test('guard: an edge on the 24h low is rejected and explains the consequence', () => {
  const refusal = inspectBandLegality({
    price: 103,
    minPx: 99, // below low24h x 1.01 = 101
    maxPx: 107,
    low24h: 100,
    high24h: 200,
  });

  ok(!!refusal, 'an edge on the 24h low must be rejected');
  ok(/minimul de 24h/i.test(refusal!), `the message must name the low, got: ${refusal}`);
  ok(/nivelurile/i.test(refusal!), 'the message must explain the fill cascade');
});

test('guard: an edge on the 24h high is rejected', () => {
  const refusal = inspectBandLegality({
    price: 197,
    minPx: 192,
    maxPx: 199, // above high24h x 0.99 = 198
    low24h: 100,
    high24h: 200,
  });

  ok(!!refusal, 'an edge on the 24h high must be rejected');
  ok(/maximul de 24h/i.test(refusal!), `the message must name the high, got: ${refusal}`);
});

test('guard: unknown, zero or inverted extremes enforce nothing and reject nothing', () => {
  const base = { price: 100, minPx: 99, maxPx: 101 };
  eq(inspectBandLegality(base), null, 'no extremes supplied: nothing to enforce');
  eq(inspectBandLegality({ ...base, low24h: 0, high24h: 200 }), null, 'a 0 low is unknown, not a limit');
  eq(
    inspectBandLegality({ ...base, low24h: 200, high24h: 100 }),
    null,
    'inverted extremes are garbage, not a limit'
  );
});

test('guard: a band that does not contain the price is rejected even with unknown extremes', () => {
  ok(
    !!inspectBandLegality({ price: 100, minPx: 101, maxPx: 105 }),
    'a price below the band must be rejected'
  );
  ok(
    !!inspectBandLegality({ price: 110, minPx: 101, maxPx: 105 }),
    'a price above the band must be rejected'
  );
});

test('guard: a degenerate band is rejected before any extreme is consulted', () => {
  ok(!!inspectBandLegality({ price: 100, minPx: 101, maxPx: 101 }), 'a zero-width band is invalid');
  ok(!!inspectBandLegality({ price: 100, minPx: 0, maxPx: 101 }), 'a non-positive edge is invalid');
  ok(!!inspectBandLegality({ price: 100, minPx: NaN, maxPx: 101 }), 'NaN must not pass as legal');
});

test('guard: the proximity margin is overridable, and a stricter margin rejects more', () => {
  const input = { price: 101.5, minPx: 100.6, maxPx: 102.4, low24h: 100, high24h: 200 };
  // low24h x 1.01 = 101 > 100.6 -> rejected at the default 1% margin.
  ok(!!inspectBandLegality(input), 'the default margin must reject a lower edge under 101');
  eq(inspectBandLegality({ ...input, extremeProximityPct: 0 }), null, 'a 0% margin must accept it');
  ok(
    !!inspectBandLegality({ ...input, extremeProximityPct: 5 }),
    'a 5% margin must reject the same band'
  );
});

// ---------------------------------------------------------------------------

const run = async (): Promise<void> => {
  let failed = 0;
  for (const t of registered) {
    try {
      await t.fn();
      console.log(`  ok    ${t.name}`);
    } catch (err: any) {
      failed++;
      console.error(`  FAIL  ${t.name}`);
      console.error(`        ${err?.message || err}`);
    }
  }
  const total = registered.length;
  console.log(`\n${total - failed}/${total} grid-band tests passed`);
  if (failed > 0) process.exitCode = 1;
};

void run();
