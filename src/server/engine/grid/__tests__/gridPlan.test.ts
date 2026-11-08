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
  snapToTick,
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

test('the leverage ceiling cannot drift from the agent scan ceiling', () => {
  eq(GRID_PLAN_MAX_LEVERAGE, AGENT_SCAN_MAX_LEVERAGE, 'both ceilings must stay equal');
  eq(GRID_PLAN_MAX_LEVERAGE, 2, 'the neutral-grid ceiling is 2x by policy');
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
  for (const lever of [3, 5, 20]) {
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
    baseReq({ lever: 9 }),
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
    'NATIVE_ALGO',
    'an explicit probe result wins'
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
