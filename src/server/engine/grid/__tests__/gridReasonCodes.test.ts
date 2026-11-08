/**
 * Parity suite for the reason-code classifier.
 *
 * `classifyDecisionCodes()` re-derives the verdict the analyzer already made, so it MUST stay
 * in lockstep with `GridDecisionEngine.evaluate()`. The two are separate functions (the engine
 * keeps its long-standing prose reasons untouched), which means the only thing standing between
 * them and silent divergence is this file: one fixture per precedence rule, asserting
 *
 *     decisionForCode(codes[0]) === evaluate(...).decision
 *
 * A reordered or re-tuned rule on either side fails here immediately.
 *
 * Run: npm test
 */

import {
  GridDecisionEngine,
  DEFAULT_GRID_ANALYZER_THRESHOLDS,
} from '../GridBotAnalyzer';
import {
  classifyDecisionCodes,
  decisionForCode,
  isBudgetRefusal,
  isGridReasonCode,
  planRejectionToReasonCode,
  GRID_REASON_MESSAGES_RO,
  type GridDecisionCode,
} from '../gridReasonCodes';
import type {
  GridAnalyzerThresholds,
  GridBotAnalysisSnapshot,
  GridStagnationMetrics,
  OKXNativeGridBot,
} from '../../../../shared/types';

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------
const ok = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(msg);
};
const eq = (actual: unknown, expected: unknown, msg: string): void => {
  if (actual !== expected) throw new Error(`${msg} (expected ${expected}, got ${actual})`);
};

const tests: { name: string; fn: () => void }[] = [];
const test = (name: string, fn: () => void): void => {
  tests.push({ name, fn });
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A calm, mid-band, profitable-by-default bot. Every fixture overrides one field. */
function makeBot(over: Partial<OKXNativeGridBot> = {}): OKXNativeGridBot {
  return {
    algoId: 'grid_fixture',
    instId: 'LINK-USD_UM_XPERP-310523',
    algoOrdType: 'contract_grid',
    direction: 'neutral',
    environment: 'DEMO',
    state: 'running',
    minPx: 95,
    maxPx: 105,
    currentPx: 100,
    gridNum: 4,
    runType: '1',
    lever: 2,
    sz: 10,
    stopLossPct: 0,
    takeProfitPct: 0,
    stopOnRangeBreakout: true,
    slTriggerPx: undefined,
    tpTriggerPx: undefined,
    ...over,
  } as unknown as OKXNativeGridBot;
}

function makeSnapshot(
  over: {
    risk?: Partial<GridBotAnalysisSnapshot['risk']>;
    market?: Partial<GridBotAnalysisSnapshot['market']>;
    performance?: Partial<GridBotAnalysisSnapshot['performance']>;
    stagnation?: Partial<GridStagnationMetrics>;
  } = {}
): GridBotAnalysisSnapshot {
  const stagnation: GridStagnationMetrics = {
    level: 'ACTIVE',
    isStagnant: false,
    lastFillAt: 0,
    minutesSinceLastFill: 5,
    lastGridCycleCloseAt: 0,
    minutesSinceLastGridClose: 5,
    realizedPnlUSDT: 0,
    realizedPnlDelta30mUSDT: 0,
    realizedPnlDelta60mUSDT: 0,
    realizedPnlDelta120mUSDT: 0,
    floatPnlUSDT: 0,
    floatPnlDelta30mUSDT: 0,
    floatPnlDelta60mUSDT: 0,
    netRealizedProfitAfterCostsUSDT: 0,
    priceOscillationAmplitude60mPct: 0,
    priceOscillationAmplitude120mPct: 0,
    oscillationToGridStepRatio: 2,
    lockedCapitalUSDT: 10,
    capitalTurnover120mRatio: 1,
    capitalEfficiencyScore: 1,
    recoveryProspect: 'HIGH',
    continueOpportunityVerdict: 'ok',
    ...(over.stagnation as GridStagnationMetrics),
  } as GridStagnationMetrics;

  return {
    algoId: 'grid_fixture',
    instId: 'LINK-USD_UM_XPERP-310523',
    isNativeOKXBot: false,
    managedByTB5: true,
    state: 'running',
    decision: 'CONTINUE',
    decisionReason: '',
    riskLevel: 'LOW',
    reconciliationState: 'CONFIRMED_RUNNING',
    market: {
      adx: 15,
      adxConsecutiveAboveMonitor: 0,
      adxConsecutiveAboveStop: 0,
      trendPersistent: false,
      choppinessIndex: 50,
      chopConsecutiveBelowStop: 0,
      initialAtrPct: 1,
      currentAtrPct: 1,
      atrChangePct: 0,
      priceDirection: 'NEUTRAL',
      volume24hUSDT: 0,
      spreadBps: 1,
      orderBookDepthUSD: 0,
      orderBookImbalance: 0,
      fundingRatePct: 0,
      ...over.market,
    },
    performance: {
      gridProfitUSDT: 0,
      floatProfitUSDT: 0,
      totalPnlUSDT: 0,
      netYieldPct: 0,
      executedGrids: 0,
      activeGrids: 4,
      uptimeSec: 3600,
      estimatedFeesUSDT: 0,
      estimatedFundingCostUSDT: 0,
      netProfitAfterCostsUSDT: 0,
      ...over.performance,
    },
    risk: {
      distToLowerLimitPct: 5,
      distToUpperLimitPct: 5,
      // 20 % away from both edges: the calm case must not trip the range-edge warning.
      minDistToEdgePct: 20,
      accumulatedPositionUSD: 0,
      marginUsedUSDT: 10,
      liqPx: 60,
      distToLiqPct: 40,
      drawdownPct: 0,
      liquidityDegraded: false,
      ...over.risk,
    },
    stagnation,
    cadence: {
      lastReconcile30sAt: 0,
      lastPrice1mAt: 0,
      lastMarket5mAt: 0,
      lastFullEval15mAt: 0,
    },
    updatedAt: 1_700_000_000_000,
  } as GridBotAnalysisSnapshot;
}

const baseThresholds = (over: Partial<GridAnalyzerThresholds> = {}): GridAnalyzerThresholds => ({
  ...DEFAULT_GRID_ANALYZER_THRESHOLDS,
  ...over,
});

const engine = new GridDecisionEngine();

interface Fixture {
  name: string;
  bot?: Partial<OKXNativeGridBot>;
  snapshot?: Parameters<typeof makeSnapshot>[0];
  thresholds?: Partial<GridAnalyzerThresholds>;
  allowStagnationStop?: boolean;
  expected: GridDecisionCode;
}

/**
 * One fixture per rule, in the engine's own precedence order. If a fixture accidentally
 * satisfies an earlier rule, the expected code assertion fails — which is the point.
 */
const FIXTURES: Fixture[] = [
  { name: 'liquidation proximity', snapshot: { risk: { liqPx: 90, distToLiqPct: 3 } }, expected: 'RISK_LIQ_PROXIMITY' },
  { name: 'drawdown stop', snapshot: { risk: { drawdownPct: 9 } }, expected: 'RISK_DRAWDOWN_STOP' },
  { name: 'breakout confirmed', bot: { currentPx: 106 }, expected: 'RISK_RANGE_BREAKOUT_CONFIRMED' },
  { name: 'breakout inside buffer', bot: { currentPx: 105.05 }, expected: 'RISK_RANGE_BREAKOUT_BUFFER' },
  {
    name: 'trend confirmed on both indicators',
    snapshot: {
      market: { adx: 35, adxConsecutiveAboveStop: 2, choppinessIndex: 30, chopConsecutiveBelowStop: 2 },
    },
    expected: 'REGIME_TREND_CONFIRMED',
  },
  {
    name: 'trend with multi-indicator stress',
    snapshot: { market: { adx: 35, adxConsecutiveAboveStop: 2, atrChangePct: 60 } },
    expected: 'REGIME_TREND_MULTI_INDICATOR',
  },
  {
    name: 'trend on a single indicator when corroboration is off',
    snapshot: { market: { adx: 35, adxConsecutiveAboveStop: 2 } },
    thresholds: { requireMultiIndicatorForTrendStop: false },
    expected: 'REGIME_TREND_SINGLE_INDICATOR',
  },
  {
    name: 'stagnation 180m stop',
    snapshot: { stagnation: { level: 'STOP_180M', isStagnant: true } },
    expected: 'STAGNATION_180M',
  },
  {
    name: 'early stagnation stop on market deterioration',
    snapshot: { stagnation: { level: 'EARLY_STOP_MARKET', isStagnant: true } },
    expected: 'STAGNATION_EARLY_MARKET',
  },
  { name: 'drawdown warning', snapshot: { risk: { drawdownPct: 6 } }, expected: 'RISK_DRAWDOWN_WARNING' },
  { name: 'range edge warning', snapshot: { risk: { minDistToEdgePct: 5 } }, expected: 'RISK_RANGE_EDGE_WARNING' },
  {
    name: '120m opportunity review',
    snapshot: { stagnation: { level: 'REVIEW_120M', isStagnant: true } },
    expected: 'STAGNATION_120M_REVIEW',
  },
  {
    name: '60m no-fill warning',
    snapshot: { stagnation: { level: 'WARNING_60M', isStagnant: true } },
    expected: 'STAGNATION_60M_WARNING',
  },
  {
    name: 'adx monitor',
    snapshot: { market: { adx: 27, adxConsecutiveAboveMonitor: 3 } },
    expected: 'REGIME_ADX_MONITOR',
  },
  { name: 'atr spike monitor', snapshot: { market: { atrChangePct: 60 } }, expected: 'REGIME_ATR_SPIKE' },
  {
    name: 'chop monitor without stop conditions',
    snapshot: { market: { choppinessIndex: 30 } },
    expected: 'REGIME_CHOP_MONITOR',
  },
  {
    name: '30m stagnation monitor',
    snapshot: { stagnation: { level: 'MONITOR_30M', isStagnant: true } },
    expected: 'STAGNATION_30M_MONITOR',
  },
  {
    name: 'profitable hold',
    snapshot: { stagnation: { netRealizedProfitAfterCostsUSDT: 0.01 } },
    expected: 'HOLD_PROFITABLE',
  },
  { name: 'plain range hold', expected: 'HOLD_RANGE_NORMAL' },
  {
    name: 'stagnation stop suppressed by the caller',
    snapshot: { stagnation: { level: 'STOP_180M', isStagnant: true } },
    allowStagnationStop: false,
    expected: 'HOLD_RANGE_NORMAL',
  },
];

// ---------------------------------------------------------------------------
// Parity
// ---------------------------------------------------------------------------

test('every fixture classifies to the code the engine actually acts on', () => {
  for (const fx of FIXTURES) {
    const bot = makeBot(fx.bot);
    const snapshot = makeSnapshot(fx.snapshot);
    const thresholds = baseThresholds(fx.thresholds);
    const allow = fx.allowStagnationStop !== false;

    const codes = classifyDecisionCodes({ bot, snapshot, thresholds, allowStagnationStop: allow });
    ok(codes.length > 0, `${fx.name}: classifier returned no codes`);

    const actual = engine.evaluate(bot, snapshot, thresholds, allow);

    eq(codes[0], fx.expected, `${fx.name}: wrong code`);
    eq(
      decisionForCode(codes[0]),
      actual.decision,
      `${fx.name}: code says ${decisionForCode(codes[0])}, engine says ${actual.decision}`
    );
    ok(actual.reason.length > 0, `${fx.name}: the engine must still produce prose`);
  }
});

test('the classifier agrees with the engine across the whole fixture matrix', () => {
  // Cross every fixture with the multi-indicator toggle on and off: 42 independent comparisons.
  for (const requireMulti of [true, false]) {
    for (const fx of FIXTURES) {
      const bot = makeBot(fx.bot);
      const snapshot = makeSnapshot(fx.snapshot);
      const thresholds = baseThresholds({ ...fx.thresholds, requireMultiIndicatorForTrendStop: requireMulti });
      const codes = classifyDecisionCodes({ bot, snapshot, thresholds });
      const actual = engine.evaluate(bot, snapshot, thresholds, true);
      ok(
        decisionForCode(codes[0]) === actual.decision,
        `mismatch for "${fx.name}" (multi=${requireMulti}): ${codes[0]} vs ${actual.decision}`
      );
    }
  }
});

test('classifyDecisionCodes is deterministic and side-effect free', () => {
  const input = {
    bot: makeBot({ currentPx: 106 }),
    snapshot: makeSnapshot(),
    thresholds: baseThresholds(),
  };
  const a = classifyDecisionCodes(input);
  const b = classifyDecisionCodes(input);
  eq(JSON.stringify(a), JSON.stringify(b), 'same input must give the same codes');
  eq(input.bot.currentPx, 106, 'the input must not be mutated');
});

// ---------------------------------------------------------------------------
// Registry integrity
// ---------------------------------------------------------------------------

const ALL_DECISION_CODES: GridDecisionCode[] = [
  'RISK_LIQ_PROXIMITY',
  'RISK_DRAWDOWN_STOP',
  'RISK_RANGE_BREAKOUT_CONFIRMED',
  'RISK_RANGE_BREAKOUT_BUFFER',
  'REGIME_TREND_CONFIRMED',
  'REGIME_TREND_MULTI_INDICATOR',
  'REGIME_TREND_SINGLE_INDICATOR',
  'STAGNATION_180M',
  'STAGNATION_EARLY_MARKET',
  'RISK_DRAWDOWN_WARNING',
  'RISK_RANGE_EDGE_WARNING',
  'STAGNATION_120M_REVIEW',
  'STAGNATION_60M_WARNING',
  'REGIME_ADX_MONITOR',
  'REGIME_ATR_SPIKE',
  'REGIME_CHOP_MONITOR',
  'STAGNATION_30M_MONITOR',
  'HOLD_PROFITABLE',
  'HOLD_RANGE_NORMAL',
];

test('every decision code is labelled and mapped', () => {
  for (const code of ALL_DECISION_CODES) {
    ok(GRID_REASON_MESSAGES_RO[code], `${code} has no label`);
    ok(decisionForCode(code), `${code} has no decision`);
  }
  // The fixture list must cover the registry: a new rule without a fixture is a blind spot.
  const covered = new Set(FIXTURES.map((f) => f.expected));
  for (const code of ALL_DECISION_CODES) {
    ok(covered.has(code), `${code} has no parity fixture`);
  }
});

test('execution codes are labelled too', () => {
  for (const code of [
    'KILL_SWITCH_ENGAGED',
    'ENV_FLIP_REQUIRED',
    'CREDENTIALS_MISSING',
    'DRY_RUN',
    'NO_CAPITAL',
    'MAX_BOTS_REACHED',
    'DESK_CAP_EXCEEDED',
    'BUDGET_CAP_EXCEEDED',
    'BUDGET_BELOW_MIN',
    'PROBE_FAILED',
    'INTENT_DUPLICATE',
    'GATEWAY_REJECTED',
    'GATEWAY_UNKNOWN_OUTCOME',
    'CONFIRM_TIMEOUT',
  ] as const) {
    ok(GRID_REASON_MESSAGES_RO[code], `${code} has no label`);
  }
});

test('isGridReasonCode accepts every registered code and nothing else', () => {
  // This is the guard the UI and the journal rely on: a code that reaches the screen but that
  // no classifier can interpret is worse than no code at all.
  for (const code of ALL_DECISION_CODES) ok(isGridReasonCode(code), `${code} must validate`);
  ok(isGridReasonCode('GATEWAY_UNKNOWN_OUTCOME'), 'execution codes validate too');
  ok(isGridReasonCode('RECONCILE_UNAVAILABLE'), 'reconciliation verdicts validate');
  ok(!isGridReasonCode('NOT_A_CODE'), 'junk is rejected');
  ok(!isGridReasonCode(''), 'empty is rejected');
  ok(!isGridReasonCode(undefined), 'undefined is rejected');
  ok(!isGridReasonCode(42), 'non-strings are rejected');
});

test('plan refusals travel as execution codes and budget refusals are retryable', () => {
  eq(planRejectionToReasonCode('BUDGET_BELOW_MIN'), 'BUDGET_BELOW_MIN', 'spelling must survive');
  ok(isBudgetRefusal('BUDGET_BELOW_MIN'), 'below-minimum is retryable');
  ok(isBudgetRefusal('DESK_CAP_EXCEEDED'), 'desk cap is retryable');
  ok(isBudgetRefusal('BUDGET_CAP_EXCEEDED'), 'per-bot cap is retryable');
  ok(!isBudgetRefusal('EDGE_NEGATIVE'), 'an unprofitable grid is not a capital problem');
  ok(!isBudgetRefusal('RISK_DRAWDOWN_STOP'), 'a market verdict is not a capital problem');
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
