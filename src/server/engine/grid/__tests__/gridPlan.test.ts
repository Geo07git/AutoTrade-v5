/**
 * Regression suite for the grid plan builder (`buildGridPlan` / `deriveGridGeometry`).
 *
 * The invariant this file protects is single-source-of-truth geometry: the numbers the agent
 * scan RANKS must be the numbers the execution path SENDS. Two copies of the band/step/level
 * formula is the classic silent-drift bug (rank on one geometry, open on another), so the
 * parity test below compares `deriveGridGeometry()` against `computeAgentGridMetrics()`
 * across the ATR range and both fee tiers.
 *
 * Also locked here:
 *   - the band is sized on the HOLDING HORIZON (`z x ATR(1h) x sqrt(T)`) and the geometry
 *     reports the lifetime it actually buys, so a clamp cannot pass for the requested horizon;
 *   - integer-cent sizing (a 4-decimal OKX minimum must never be rounded down and refused);
 *   - the desk ceiling is never exceeded and never used as an excuse to inflate a plan;
 *   - the leverage ceiling in this module cannot drift from the agent's ceiling;
 *   - `geometryHash` is stable and sensitive to level count / leverage;
 *   - the module stays pure (no Date.now, no Math.random, no I/O).
 *
 * Run: npm test
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildGridPlan,
  deriveGridGeometry,
  geometryHash,
  gridStopLossPct,
  maxLeverageForBand,
  snapToTick,
  GRID_ATR_1H_PER_15M,
  GRID_DEFAULT_TARGET_HOLDING_HOURS,
  GRID_HOLDING_SIGMA_Z,
  GRID_MAX_HALF_RANGE_PCT,
  GRID_MIN_HALF_RANGE_PCT,
  GRID_PLAN_MAX_LEVERAGE,
  GRID_MIN_LEVELS,
  GRID_MAX_LEVELS,
  type GridPlan,
  type GridPlanRequest,
  type GridPlanRejection,
  type GridPlanResult,
} from '../gridPlan';
import { computeAgentGridMetrics, AGENT_SCAN_MAX_LEVERAGE } from '../../../agent/AgentUniverseScan';
import type { Kline } from '../../../../shared/types';

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------
const ok = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(msg);
};
const eq = (actual: unknown, expected: unknown, msg: string): void => {
  if (actual !== expected) throw new Error(`${msg} (expected ${expected}, got ${actual})`);
};

/**
 * Explicit type guard: `if (!res.ok)` does not narrow a union whose discriminant is a boolean
 * literal, so the guard is spelled out once and used everywhere below.
 */
const isRejection = (res: GridPlanResult): res is GridPlanRejection => !res.ok;

/** Unwrap a plan or fail loudly with the refusal codes. */
function mustPlan(res: GridPlanResult): GridPlan {
  if (isRejection(res)) {
    throw new Error(`plan refused: [${res.codes.join(',')}] ${res.detail}`);
  }
  return res.plan;
}

/** Unwrap a refusal or fail loudly. */
function mustReject(res: GridPlanResult): GridPlanRejection {
  if (!isRejection(res)) throw new Error('expected a refusal, got a plan');
  return res;
}

const tests: { name: string; fn: () => void }[] = [];
const test = (name: string, fn: () => void): void => {
  tests.push({ name, fn });
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseReq = (over: Partial<GridPlanRequest> = {}): GridPlanRequest => ({
  instId: 'LINK-USD_UM_XPERP-310523',
  currentPx: 100,
  tickSz: 0.01,
  atrPct: 1.2,
  spreadPct: 0.01,
  roundTripFeePct: 0.04,
  fundingRatePct: 0.01,
  lever: 2,
  budgetUSDT: 12,
  totalCapUSDT: 40,
  committedUSDT: 0,
  minInvestmentUSDT: 0,
  crossingsPerHour: 1.5,
  ...over,
});

/**
 * 20 flat bars whose true range is exactly `atrPct` % of close, so the ATR that
 * `computeAgentGridMetrics` derives is exactly the number handed to `deriveGridGeometry`.
 * Flat closes also mean zero path, i.e. the geometry is compared with no activity input.
 */
function barsWithExactAtr(atrPct: number, close = 100): Kline[] {
  const bars: Kline[] = [];
  for (let i = 0; i < 20; i++) {
    bars.push({
      timestamp: 1_700_000_000_000 + i * 900_000,
      open: close,
      high: close * (1 + atrPct / 200),
      low: close * (1 - atrPct / 200),
      close,
      volume: 1,
    } as Kline);
  }
  return bars;
}

// ---------------------------------------------------------------------------
// Parity: one geometry implementation
// ---------------------------------------------------------------------------

test('deriveGridGeometry matches the agent scan geometry on every ATR band', () => {
  for (const atrPct of [0.2, 0.5, 1, 1.2, 1.7, 2.5, 4, 8]) {
    for (const fee of [0.04, 0.08]) {
      const metrics = computeAgentGridMetrics({
        price: 100,
        klines15m: barsWithExactAtr(atrPct),
        spreadPct: 0,
        roundTripFeePct: fee,
      });
      ok(metrics, `metrics must exist for atr ${atrPct} / fee ${fee}`);
      const geo = deriveGridGeometry({
        atrPct: metrics!.atrPct,
        roundTripFeePct: fee,
        spreadPct: 0,
      });
      ok(geo, `geometry must exist for atr ${atrPct} / fee ${fee}`);

      eq(geo!.halfRangePct, metrics!.halfRangePct, `halfRangePct @ atr ${atrPct} / fee ${fee}`);
      eq(geo!.gridNum, metrics!.gridNum, `gridNum @ atr ${atrPct} / fee ${fee}`);
      eq(geo!.stepPct, metrics!.stepPct, `stepPct @ atr ${atrPct} / fee ${fee}`);
      eq(geo!.netPerGridPct, metrics!.netPerGridPct, `netPerGridPct @ atr ${atrPct} / fee ${fee}`);
    }
  }
});

test('the parity holds when the scan is given 1h regime bars', () => {
  // The fallback path above is only half the story: with real 1h bars the band comes from the
  // REGIME ATR, and the caller has to hand the same number to `deriveGridGeometry`. If the two
  // ever disagreed, the plan builder would size a band the scan did not rank.
  for (const atr15 of [0.3, 0.6, 1.1, 1.6]) {
    const atr1h = atr15 * 2.4;
    const metrics = computeAgentGridMetrics({
      price: 100,
      klines15m: barsWithExactAtr(atr15),
      klines1h: barsWithExactAtr(atr1h),
      spreadPct: 0,
      roundTripFeePct: 0.04,
    });
    ok(metrics, `metrics must exist for atr15 ${atr15} with 1h bars`);
    const geo = deriveGridGeometry({
      atrPct: metrics!.atrPct,
      atrPct1h: metrics!.atrPct1h,
      roundTripFeePct: 0.04,
      spreadPct: 0,
    });
    ok(geo, `geometry must exist for atr15 ${atr15} with 1h bars`);
    eq(geo!.atrPct1h, metrics!.atrPct1h, `atrPct1h @ atr15 ${atr15}`);
    eq(geo!.halfRangePct, metrics!.halfRangePct, `halfRangePct @ atr15 ${atr15}`);
    eq(geo!.gridNum, metrics!.gridNum, `gridNum @ atr15 ${atr15}`);
    eq(geo!.stepPct, metrics!.stepPct, `stepPct @ atr15 ${atr15}`);
    eq(
      geo!.expectedLifetimeHours,
      metrics!.expectedLifetimeHours,
      `expectedLifetimeHours @ atr15 ${atr15}`
    );
  }
});

test('the leverage ceiling cannot drift from the agent scan ceiling', () => {
  eq(GRID_PLAN_MAX_LEVERAGE, AGENT_SCAN_MAX_LEVERAGE, 'both ceilings must stay equal');
  eq(GRID_PLAN_MAX_LEVERAGE, 10, 'the neutral-grid ceiling is 10x by policy (owner-approved)');
});

// ---------------------------------------------------------------------------
// Risk unit: stop in % of MARGIN vs grid in % of PRICE
// ---------------------------------------------------------------------------

/**
 * Live data from the bots opened on 2026-11-10 (`.data/native_grid_bots.json`), all of which were
 * stopped at a loss 29-40 minutes after open because a 2% margin stop is a 0.2% price stop at 10x.
 */
const LIVE_BANDS = [
  { sym: 'XRP', halfRangePct: 1.11, stopWas: 2 },
  { sym: 'LTC', halfRangePct: 1.465, stopWas: 2 },
  { sym: 'MSTR', halfRangePct: 2.3, stopWas: 2 },
  { sym: 'SOXL', halfRangePct: 4.42, stopWas: 2 },
];

test('leverage is capped by the band so one walk to the edge fits under the guardrail', () => {
  const guard = 12;
  for (const b of LIVE_BANDS) {
    const levers = [1, 2, 5, 10, 20];
    for (const requested of levers) {
      const lev = maxLeverageForBand(b.halfRangePct, guard, requested);
      ok(lev >= 1, `${b.sym}: leverage must stay at least 1x`);
      ok(lev <= requested, `${b.sym}: the cap may only lower the requested leverage`);
      ok(
        lev * b.halfRangePct <= guard + 1e-9,
        `${b.sym}: ${lev}x x ${b.halfRangePct}% = ${(lev * b.halfRangePct).toFixed(
          1
        )}% of margin exceeds the ${guard}% guardrail`
      );
    }
  }
  // A wide band must NOT keep 10x: the whole point of the cap.
  eq(maxLeverageForBand(4.42, 12, 10), 2, 'SOXL (+-4.42%) cannot carry 10x under a 12% stop');
  eq(maxLeverageForBand(1.11, 12, 10), 10, 'XRP (+-1.11%) still gets the full 10x ceiling');
  eq(
    maxLeverageForBand(GRID_MIN_HALF_RANGE_PCT, 12, 10),
    6,
    'the tightest band the desk now allows (+-2%) carries 6x under a 12% guardrail'
  );
});

test('the grid stop always covers a full walk to the band edge', () => {
  for (const b of LIVE_BANDS) {
    const lev = maxLeverageForBand(b.halfRangePct, 12, 10);
    const sl = gridStopLossPct(b.halfRangePct, lev, b.stopWas, 12);
    ok(
      sl >= lev * b.halfRangePct - 1e-9,
      `${b.sym}: SL ${sl}% of margin is tighter than one band walk (${(
        lev * b.halfRangePct
      ).toFixed(2)}%) - the bot would be stopped inside its own range`
    );
    ok(sl <= 12, `${b.sym}: SL ${sl}% must not exceed the hard guardrail`);
  }
  // The model may tighten, never enough to be stopped by a single level.
  eq(gridStopLossPct(1.11, 10, 2, 12), 11.1, 'XRP @10x: the 2% request is floored at one band walk');
  eq(gridStopLossPct(1.11, 10, 2, 12), gridStopLossPct(1.11, 10, 0, 12), 'missing SL uses the floor');
  ok(
    gridStopLossPct(1.11, 10, 30, 12) === 12,
    'a request above the guardrail is clamped down to it, not accepted'
  );
});

test('a mid-vol tape gets a band sized on the horizon, with payable levels', () => {
  // The band used to be `1.6 x ATR(15m)` = 0.8% here, which is first touched in ~50 minutes at
  // any volatility: the level count then had to be capped just to keep the step above the fee
  // floor. The band is now the horizon's worth of hourly movement, and the levels follow it.
  const geo = deriveGridGeometry({ atrPct: 1.2, roundTripFeePct: 0.04 })!;
  ok(!!geo, 'geometry must exist for a 1.2% ATR');
  eq(
    geo.atrPct1h,
    1.2 * GRID_ATR_1H_PER_15M,
    'without 1h bars the regime is the sqrt(4)-scaled 15m ATR'
  );
  eq(
    geo.halfRangePct,
    4.58,
    `band = ${GRID_HOLDING_SIGMA_Z} x 2.4% x sqrt(${GRID_DEFAULT_TARGET_HOLDING_HOURS}h)`
  );
  eq(geo.gridNum, 20, 'a 9.16% wide band at a 0.48% target step saturates the 20-level cap');
  eq(geo.stepPct, 0.458, 'step = 2 x halfRange / gridNum');
  ok(geo.stepPct >= geo.feeFloorPct, 'the step must clear 3x the maker round-trip');
  ok(
    geo.expectedLifetimeHours >= 7,
    `the band must survive ~the 8h horizon, got ${geo.expectedLifetimeHours}h`
  );
});

test('an unclamped band lives exactly the horizon it was sized for', () => {
  // The contract that makes the horizon a real requirement instead of a comment: when neither
  // bound clamps the band, the median first touch lands ON the horizon. Anything else would mean
  // the sigma multiple and the first-passage constant disagree.
  for (const atr of [0.7, 1, 1.4]) {
    const raw = GRID_HOLDING_SIGMA_Z * atr * GRID_ATR_1H_PER_15M * Math.sqrt(GRID_DEFAULT_TARGET_HOLDING_HOURS);
    ok(raw > GRID_MIN_HALF_RANGE_PCT && raw < GRID_MAX_HALF_RANGE_PCT, `atr ${atr} must not clamp`);
    const geo = deriveGridGeometry({ atrPct: atr, roundTripFeePct: 0.04 })!;
    ok(
      Math.abs(geo.expectedLifetimeHours - GRID_DEFAULT_TARGET_HOLDING_HOURS) < 0.5,
      `atr ${atr}: ${geo.halfRangePct}% band lives ${geo.expectedLifetimeHours}h, not ${GRID_DEFAULT_TARGET_HOLDING_HOURS}h`
    );
  }
});

test('the horizon is a knob, and both clamps are reported honestly', () => {
  // 0.5% ATR(15m) -> 1.0% ATR(1h). At 8h the raw band is 1.91% and gets floored to 2.0%; at 24h
  // it is 3.30% and unclamped, so the two horizons can be compared on the same tape.
  const base = deriveGridGeometry({ atrPct: 0.5, roundTripFeePct: 0.04 })!;
  const long = deriveGridGeometry({ atrPct: 0.5, roundTripFeePct: 0.04, targetHoldingHours: 24 })!;
  ok(long.halfRangePct > base.halfRangePct, 'a longer horizon must widen the band');
  eq(long.targetHoldingHours, 24, 'the horizon must be reported, not silently defaulted');
  ok(
    Math.abs(long.expectedLifetimeHours - 24) < 1.5,
    `a 24h band must live ~24h, got ${long.expectedLifetimeHours}h`
  );

  // Floor (calm tape): the band is wider than the horizon asks, i.e. errors on the safe side.
  const calm = deriveGridGeometry({ atrPct: 0.2, roundTripFeePct: 0.04 })!;
  eq(calm.halfRangePct, GRID_MIN_HALF_RANGE_PCT, 'the floor is a floor, not a target');
  ok(
    calm.expectedLifetimeHours > GRID_DEFAULT_TARGET_HOLDING_HOURS,
    'the floor buys MORE than the horizon, which is the harmless direction'
  );

  // Ceiling (wild tape): the clamp shortens the life, and the number says so instead of pretending
  // an 8h band was delivered.
  const wild = deriveGridGeometry({ atrPct: 8, roundTripFeePct: 0.04 })!;
  eq(wild.halfRangePct, GRID_MAX_HALF_RANGE_PCT, 'the ceiling is still enforced');
  ok(
    wild.expectedLifetimeHours < 1,
    `a ceiling-clamped band is touched in minutes, reported as ${wild.expectedLifetimeHours}h`
  );
});

test('a band clamped to its minimum still yields a payable step', () => {
  // 0.2% ATR asks for a 2.0% band (the floor) and a 0.08% step, under 3x the fee. The level count
  // is capped at what the floor can pay, so the geometry stays valid instead of being refused:
  // the dead-tape case is then dropped by the horizon gate, not by arithmetic.
  const geo = deriveGridGeometry({ atrPct: 0.2, roundTripFeePct: 0.04 })!;
  eq(geo.halfRangePct, GRID_MIN_HALF_RANGE_PCT, 'the band cannot fall under the 2.0% minimum');
  ok(geo.gridNum >= GRID_MIN_LEVELS, 'the minimum level count still applies');
  ok(
    geo.stepPct >= geo.feeFloorPct,
    `step ${geo.stepPct}% must clear the ${geo.feeFloorPct}% fee floor`
  );
  ok(geo.netPerGridPct > 0, 'a payable step must leave a positive net edge');
});

test('geometry is unusable when ATR cannot describe a band', () => {
  for (const atr of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    eq(
      deriveGridGeometry({ atrPct: atr, roundTripFeePct: 0.04 }),
      null,
      `atr ${atr} -> no geometry`
    );
  }
});

// ---------------------------------------------------------------------------
// Level count and band
// ---------------------------------------------------------------------------

test('level count is always even and inside the supported bounds', () => {
  for (let atr = 0.05; atr <= 12; atr += 0.05) {
    const geo = deriveGridGeometry({ atrPct: atr, roundTripFeePct: 0.04, spreadPct: 0.01 });
    ok(geo, `geometry must exist for atr ${atr}`);
    eq(geo!.gridNum % 2, 0, `gridNum must be even at atr ${atr}`);
    ok(
      geo!.gridNum >= GRID_MIN_LEVELS && geo!.gridNum <= GRID_MAX_LEVELS,
      `gridNum ${geo!.gridNum} out of [${GRID_MIN_LEVELS}, ${GRID_MAX_LEVELS}] at atr ${atr}`
    );
    ok(geo!.stepPct > 0, `stepPct must be positive at atr ${atr}`);
  }
});

test('band and prices are snapped to the contract tick', () => {
  const tick = 0.0001;
  const plan = mustPlan(
    buildGridPlan(
      baseReq({
        instId: 'PUMP-USD_UM_XPERP-310404',
        currentPx: 0.0036242,
        tickSz: tick,
        atrPct: 1.2,
      })
    )
  );

  for (const px of [plan.minPx, plan.maxPx]) {
    const ticks = px / tick;
    ok(
      Math.abs(ticks - Math.round(ticks)) < 1e-6,
      `price ${px} is not a multiple of tick ${tick}`
    );
  }
  ok(plan.minPx > 0, 'minPx must stay positive');
  ok(plan.maxPx > plan.minPx, 'maxPx must sit above minPx');
  eq(
    plan.maxPx,
    snapToTick(0.0036242 * (1 + plan.halfRangePct / 100), tick),
    'maxPx is the +halfRange snap of the price'
  );
});

// ---------------------------------------------------------------------------
// Sizing: integer cents, never rounded down
// ---------------------------------------------------------------------------

test('a 4-decimal OKX minimum is cleared, not rounded down and refused', () => {
  const plan = mustPlan(buildGridPlan(baseReq({ budgetUSDT: 12, minInvestmentUSDT: 11.9108 })));
  eq(plan.minInvCents, 1192, 'the requirement rounds UP to 11.92');
  ok(plan.szCents >= plan.minInvCents, 'sz must clear the minimum in cents');
  ok(plan.szCents <= 1200, 'sz must stay inside the 12 USDT per-bot budget');
});

test('the printed numbers can never be identical when a grid is refused', () => {
  // The production bug: 11.9108 was rounded DOWN to 11.91, compared against the raw value and
  // refused while printing "$11.91 sub $11.91". Refusal must be justified in distinct cents.
  const res = mustReject(buildGridPlan(baseReq({ budgetUSDT: 11.9, minInvestmentUSDT: 11.9108 })));
  ok(res.codes.includes('BUDGET_BELOW_MIN'), `expected BUDGET_BELOW_MIN, got ${res.codes.join(',')}`);
  ok(res.detail.includes('11.9'), `the message must show the real request: ${res.detail}`);
  ok(res.detail.includes('11.92'), `the message must show the real requirement: ${res.detail}`);
});

test('a minimum the desk cannot afford is refused with a code, never silently shrunk', () => {
  const res = mustReject(buildGridPlan(baseReq({ budgetUSDT: 12, minInvestmentUSDT: 18.5 })));
  ok(
    res.codes.includes('BUDGET_BELOW_MIN'),
    `expected BUDGET_BELOW_MIN, got ${res.codes.join(',')}`
  );
  ok(res.detail.length > 0, 'a refusal must explain itself');
});

test('sz never exceeds the per-bot budget', () => {
  const plan = mustPlan(buildGridPlan(baseReq({ budgetUSDT: 12, minInvestmentUSDT: 5 })));
  eq(
    plan.szCents,
    1200,
    'the request is the size — the desk cap is not an invitation to spend it'
  );

  // A live minimum above the caller's budget must refuse, never raise the position.
  const raised = mustReject(buildGridPlan(baseReq({ budgetUSDT: 12, minInvestmentUSDT: 18.5 })));
  ok(
    raised.codes.includes('BUDGET_BELOW_MIN'),
    `a minimum above the per-bot cap must refuse, got ${raised.codes.join(',')}`
  );
});

test('the desk ceiling is enforced and never turns into a bigger position', () => {
  // 5 USDT left on the desk: the plan shrinks to what is available, never below the OKX floor.
  const partial = mustPlan(
    buildGridPlan(
      baseReq({ budgetUSDT: 12, committedUSDT: 35, totalCapUSDT: 40, minInvestmentUSDT: 0 })
    )
  );
  eq(partial.availableCapCents, 500, 'only 5 USDT was left');
  eq(partial.szCents, 500, 'sized to the remainder, not to the request');

  // Desk full: refuse instead of opening an unbudgeted bot.
  const full = mustReject(buildGridPlan(baseReq({ committedUSDT: 40, totalCapUSDT: 40 })));
  ok(
    full.codes.includes('DESK_CAP_EXCEEDED'),
    `expected DESK_CAP_EXCEEDED, got ${full.codes.join(',')}`
  );
});

test('a failed minimum probe neither rejects nor inflates', () => {
  const plan = mustPlan(buildGridPlan(baseReq({ budgetUSDT: 7.31, minInvestmentUSDT: 0 })));
  eq(plan.szCents, 731, 'sz is exactly the request');
  eq(plan.minInvCents, 0, 'no requirement was invented');
});

test('the 5 USDC floor is respected', () => {
  const plan = mustPlan(buildGridPlan(baseReq({ budgetUSDT: 1.2, minInvestmentUSDT: 0 })));
  eq(plan.szCents, 500, 'the OKX floor is 5 USDT');
});

test('a floor lift that would breach the desk remainder is refused', () => {
  const res = mustReject(
    buildGridPlan(baseReq({ budgetUSDT: 1.2, committedUSDT: 37.5, minInvestmentUSDT: 0 }))
  );
  ok(
    res.codes.includes('DESK_CAP_EXCEEDED') || res.codes.includes('BUDGET_BELOW_MIN'),
    `2.50 USDT cannot host a 5 USDT floor, got ${res.codes.join(',')}`
  );
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

test('unsafe leverage is refused', () => {
  // 10x is the approved ceiling; 11x and above (and a non-positive lever) are refused by the
  // plan builder itself, so a caller that forgets the agent's clamp cannot build an unsafe plan.
  for (const lever of [11, 20, 0]) {
    const res = mustReject(buildGridPlan(baseReq({ lever })));
    ok(
      res.codes.includes('LEVER_INVALID'),
      `expected LEVER_INVALID at ${lever}x, got ${res.codes.join(',')}`
    );
  }
});

test('invalid price and budget are refused before any probe is considered', () => {
  const badPrice = mustReject(buildGridPlan(baseReq({ currentPx: 0 })));
  ok(badPrice.codes.includes('PRICE_INVALID'), 'zero price must be PRICE_INVALID');
  const badBudget = mustReject(buildGridPlan(baseReq({ budgetUSDT: 0 })));
  ok(badBudget.codes.includes('BUDGET_INVALID'), 'zero budget must be BUDGET_INVALID');
});

test('a negative edge is refused with an economic code', () => {
  // 8% round-trip fee: no sane band can clear 3x that fee, so the grid cannot pay.
  const res = mustReject(buildGridPlan(baseReq({ atrPct: 1.2, roundTripFeePct: 8 })));
  ok(
    res.codes.includes('EDGE_NEGATIVE') || res.codes.includes('STEP_BELOW_FEE_FLOOR'),
    `expected an economic refusal, got ${res.codes.join(',')}`
  );
});

test('every refusal carries at least one code and a human detail', () => {
  const cases: GridPlanRequest[] = [
    baseReq({ currentPx: -1 }),
    baseReq({ lever: 11 }),
    baseReq({ budgetUSDT: -5 }),
    baseReq({ atrPct: 0 }),
    baseReq({ minInvestmentUSDT: 99 }),
    baseReq({ committedUSDT: 40 }),
  ];
  for (const req of cases) {
    const res = mustReject(buildGridPlan(req));
    ok(res.codes.length > 0, 'a refusal without a code cannot be acted on');
    ok(typeof res.detail === 'string' && res.detail.length > 0, 'a refusal needs a detail');
  }
});

// ---------------------------------------------------------------------------
// Execution variant
// ---------------------------------------------------------------------------

test('X-Perp plans default to the limit-order path, others to the native algo', () => {
  eq(
    mustPlan(buildGridPlan(baseReq())).variant,
    'AUTO_LIMIT',
    'X-Perp default is AUTO_LIMIT (51001)'
  );
  eq(
    mustPlan(buildGridPlan(baseReq({ instId: 'BTC-USDT-SWAP' }))).variant,
    'NATIVE_ALGO',
    'a SWAP id has no 51001 problem'
  );
  eq(
    mustPlan(buildGridPlan(baseReq({ preferNativeAlgo: true }))).variant,
    'AUTO_LIMIT',
    'the switch cannot resurrect a variant nothing can execute (native creation is gone)'
  );
});

// ---------------------------------------------------------------------------
// Geometry hash
// ---------------------------------------------------------------------------

test('geometryHash is stable across calls and float noise', () => {
  const h = (over: Partial<Parameters<typeof geometryHash>[0]> = {}) =>
    geometryHash({
      instId: 'LINK-USD_UM_XPERP-310523',
      minPx: 98.85,
      maxPx: 101.15,
      gridNum: 4,
      runType: '1',
      lever: 2,
      tickSz: 0.01,
      ...over,
    });
  eq(h(), h(), 'same geometry must hash the same');
  eq(h({ minPx: 98.8500000001 }), h(), 'sub-tick float noise must not change the hash');
});

test('geometryHash separates different geometries', () => {
  const base = {
    instId: 'LINK-USD_UM_XPERP-310523',
    minPx: 98.85,
    maxPx: 101.15,
    gridNum: 4,
    runType: '1' as const,
    lever: 2,
    tickSz: 0.01,
  };
  const h0 = geometryHash(base);
  ok(geometryHash({ ...base, gridNum: 6 }) !== h0, 'a different level count must not collide');
  ok(geometryHash({ ...base, lever: 1 }) !== h0, 'a different leverage must not collide');
  ok(geometryHash({ ...base, maxPx: 101.16 }) !== h0, 'a different band must not collide');
  ok(geometryHash({ ...base, runType: '2' }) !== h0, 'a different run type must not collide');
  ok(
    geometryHash({ ...base, instId: 'ETH-USD_UM_XPERP-310523' }) !== h0,
    'symbols must not collide'
  );
  eq(h0.length, 16, 'the digest is 16 hex chars (64 bits)');
});

// ---------------------------------------------------------------------------
// Purity
// ---------------------------------------------------------------------------

test('gridPlan.ts stays pure: no clock, no randomness, no I/O', () => {
  const src = readFileSync(fileURLToPath(new URL('../gridPlan.ts', import.meta.url)), 'utf8');
  // Strip comments so prose about "no Date.now()" does not trip the guard.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const forbidden of ['Date.now(', 'Math.random(', 'fetch(', 'process.env', 'require(']) {
    ok(!code.includes(forbidden), `gridPlan.ts must not use ${forbidden}`);
  }
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
let failed = 0;
for (const t of tests) {
  try {
    t.fn();
    console.log(`  ok    ${t.name}`);
  } catch (err: any) {
    failed += 1;
    console.error(`  FAIL  ${t.name}`);
    console.error(`        ${err?.message || err}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
if (failed > 0) process.exitCode = 1;
