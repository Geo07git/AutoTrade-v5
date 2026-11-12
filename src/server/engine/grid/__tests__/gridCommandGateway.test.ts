/**
 * Contract tests for the grid command gateway.
 *
 * The gateway's job is to make three failure modes structurally impossible:
 *   - sending twice after a timeout (double position),
 *   - calling a 2xx "success" without the venue confirming it,
 *   - mutating anything while the kill switch is engaged.
 *
 * Each of those has an explicit test below. The venue is a fake, so nothing here touches OKX.
 *
 * Run: npm test
 */

import {
  GridCommandGateway,
  isDefiniteRejection,
  toVenueParams,
  type GridVenuePort,
  type GridVenueOrderState,
} from '../GridCommandGateway';
import { GridIntentJournal, MemoryIntentStore } from '../GridIntentJournal';

import type { GridPlanRequest, DecidedGridGeometry } from '../gridPlan';

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------
const ok = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(msg);
};
const eq = (actual: unknown, expected: unknown, msg: string): void => {
  if (actual !== expected) throw new Error(`${msg} (expected ${expected}, got ${actual})`);
};

const tests: { name: string; fn: () => Promise<void> | void }[] = [];
const test = (name: string, fn: () => Promise<void> | void): void => {
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

interface FakeVenueState {
  createCalls: number;
  stopCalls: number;
  orderStateCalls: number;
  lastStopType?: string;
  lastParams?: Record<string, unknown>;
}

function makeHarness(opts: {
  createResult?: (call: number) => any;
  stopResult?: (call: number) => any;
  orderState?: (algoId: string, call: number) => GridVenueOrderState;
  killSwitch?: boolean;
  dryRun?: boolean;
} = {}) {
  const fake: FakeVenueState = { createCalls: 0, stopCalls: 0, orderStateCalls: 0 };
  let orderStateCall = 0;

  const venue: GridVenuePort = {
    async createGrid(params) {
      fake.createCalls += 1;
      fake.lastParams = params;
      if (opts.createResult) return opts.createResult(fake.createCalls);
      return { success: true, algoId: `grid_${fake.createCalls}` };
    },
    async stopGrid(algoId, stopType) {
      fake.stopCalls += 1;
      fake.lastStopType = stopType;
      if (opts.stopResult) return opts.stopResult(fake.stopCalls);
      return { success: true };
    },
    async getOrderState(algoId) {
      fake.orderStateCalls += 1;
      orderStateCall += 1;
      if (opts.orderState) return opts.orderState(algoId, orderStateCall);
      return { state: 'running' };
    },
  };

  const journal = new GridIntentJournal(new MemoryIntentStore(), { now: () => 1_700_000_000_000 });
  const gateway = new GridCommandGateway({
    journal,
    venue,
    gates: {
      isKillSwitchEngaged: () => opts.killSwitch === true,
      executionEnvironment: () => 'DEMO',
    },
    now: () => 1_700_000_000_000,
    dryRun: opts.dryRun,
    confirmAttempts: 2,
    confirmDelayMs: 0,
    sleep: async () => {},
  });
  return { gateway, journal, fake };
}

// ---------------------------------------------------------------------------
// Open — happy path
// ---------------------------------------------------------------------------

test('a confirmed open is journaled, confirmed and sent once', async () => {
  const { gateway, journal, fake } = makeHarness();
  const res = await gateway.openFromPlan(baseReq(), { runId: 'run-1' });

  eq(res.ok, true, 'the open succeeded');
  eq(res.codes.length, 0, 'no reason codes on success');
  eq(fake.createCalls, 1, 'exactly one create call');
  ok(!!res.algoId, 'the algoId is returned');
  eq(journal.find(res.intentId)?.state, 'CONFIRMED', 'the intent is confirmed');
  eq(journal.find(res.intentId)?.attempts, 1, 'one attempt recorded');
  eq(journal.find(res.intentId)?.algoId, res.algoId, 'the algoId is stored');

  const params = fake.lastParams as Record<string, unknown>;
  eq(params.executionVariant, 'AUTO_LIMIT', 'X-Perp goes through the limit-order path');
  eq(params.environment, 'DEMO', 'the configured environment is recorded, never flipped');
  eq(params.sz, '12.00', 'the margin is sent as a 2-decimal string');
});

test('the kill switch blocks opening and never touches the venue or the journal', async () => {
  const { gateway, journal, fake } = makeHarness({ killSwitch: true });
  const res = await gateway.openFromPlan(baseReq());

  eq(res.ok, false, 'refused');
  eq(res.codes[0], 'KILL_SWITCH_ENGAGED', 'with the right code');
  eq(fake.createCalls, 0, 'the venue was never called');
  eq(journal.list().length, 0, 'no intent was invented for a gate refusal');
});

test('a plan refusal is translated to reason codes without sending', async () => {
  const { gateway, journal, fake } = makeHarness();
  const res = await gateway.openFromPlan(baseReq({ totalCapUSDT: 0, committedUSDT: 40 }));

  eq(res.ok, false, 'refused');
  ok(res.codes.includes('DESK_CAP_EXCEEDED'), `expected a desk refusal, got ${res.codes.join(',')}`);
  eq(fake.createCalls, 0, 'nothing sent');
  eq(journal.list().length, 0, 'nothing journaled');
});

test('dry run validates everything and sends nothing', async () => {
  const { gateway, journal, fake } = makeHarness({ dryRun: true });
  const res = await gateway.openFromPlan(baseReq());

  eq(res.ok, true, 'the plan is valid');
  eq(res.codes[0], 'DRY_RUN', 'marked as a dry run');
  eq(fake.createCalls, 0, 'nothing sent');
  const intent = journal.find(res.intentId);
  eq(intent?.state, 'ABANDONED', 'abandoned on purpose, not left in flight');
  ok(intent?.reasonCodes.includes('DRY_RUN'), 'and labelled');
});

// ---------------------------------------------------------------------------
// Open — the dangerous paths
// ---------------------------------------------------------------------------

test('a thrown create is UNKNOWN and is never resent', async () => {
  const { gateway, journal, fake } = makeHarness({
    createResult: () => {
      throw new Error('timeout of 20000ms exceeded');
    },
  });

  const first = await gateway.openFromPlan(baseReq());
  eq(first.ok, false, 'not a success');
  eq(first.unknownOutcome, true, 'flagged unknown');
  ok(first.codes.includes('GATEWAY_UNKNOWN_OUTCOME'), 'with an explicit code');
  eq(journal.find(first.intentId)?.state, 'SUBMITTED_UNKNOWN', 'the journal says unknown');

  // The critical assertion: a retry loop cannot double the position.
  const second = await gateway.openFromPlan(baseReq());
  eq(second.ok, false, 'the resend is refused');
  eq(second.codes[0], 'INTENT_DUPLICATE', 'because the intent is unresolved');
  eq(second.unknownOutcome, true, 'and it still looks unknown to the caller');
  eq(fake.createCalls, 1, 'the venue was called exactly once');
});

test('a success without confirmation stays unknown', async () => {
  const { gateway, journal, fake } = makeHarness({
    orderState: () => ({ state: 'unknown', error: 'API_UNREACHABLE' }),
  });
  const res = await gateway.openFromPlan(baseReq());

  eq(res.ok, false, 'not confirmed');
  ok(res.codes.includes('CONFIRM_TIMEOUT'), 'confirmation timed out');
  eq(journal.find(res.intentId)?.state, 'SUBMITTED_UNKNOWN', 'still unknown, never confirmed');
  ok(fake.orderStateCalls >= 2, 'it polled more than once');

  const retry = await gateway.openFromPlan(baseReq());
  eq(retry.codes[0], 'INTENT_DUPLICATE', 'and cannot be resent');
});

test('a venue that reports the bot already stopped is not a confirmed open', async () => {
  const { gateway, journal } = makeHarness({ orderState: () => ({ state: 'stopped' }) });
  const res = await gateway.openFromPlan(baseReq());

  eq(res.ok, false, 'a stopped bot is not an open bot');
  eq(journal.find(res.intentId)?.state, 'SUBMITTED_UNKNOWN', 'unknown, for reconciliation');
});

test('a definite rejection is final and retryable', async () => {
  const { gateway, journal, fake } = makeHarness({
    createResult: () => ({ success: false, error: '51000 Parameter instId error' }),
  });

  const first = await gateway.openFromPlan(baseReq());
  eq(first.ok, false, 'rejected');
  eq(first.codes[0], 'GATEWAY_REJECTED', 'with a rejection code');
  eq(journal.find(first.intentId)?.state, 'REJECTED', 'journaled as rejected');

  const second = await gateway.openFromPlan(baseReq());
  eq(fake.createCalls, 2, 'a definite rejection may be retried');
  eq(journal.find(first.intentId)?.attempts, 2, 'the retry is counted');
  eq(second.ok, false, 'still rejected by the fake');
});

test('a success without an algoId is unknown, not success', async () => {
  const { gateway } = makeHarness({ createResult: () => ({ success: true }) });
  const res = await gateway.openFromPlan(baseReq());
  eq(res.ok, false, 'no algoId means we cannot manage it');
  eq(res.unknownOutcome, true, 'so it is unknown');
});

// ---------------------------------------------------------------------------
// Close
// ---------------------------------------------------------------------------

test('a confirmed close is journaled and confirmed', async () => {
  const { gateway, journal, fake } = makeHarness({
    orderState: () => ({ state: 'stopped' }),
  });
  const res = await gateway.closeGrid({ algoId: 'grid_9', instId: 'LINK-USD_UM_XPERP-310523' });

  eq(res.ok, true, 'closed');
  eq(fake.stopCalls, 1, 'one stop call');
  eq(fake.lastStopType, '1', 'default is stop, not close-position');
  eq(journal.find(res.intentId)?.state, 'CONFIRMED', 'confirmed');
});

test('closing is allowed while the kill switch is engaged', async () => {
  const { gateway, fake } = makeHarness({
    killSwitch: true,
    orderState: () => ({ state: 'stopped' }),
  });
  const res = await gateway.closeGrid({ algoId: 'grid_9', instId: 'LINK-USD_UM_XPERP-310523' });
  eq(res.ok, true, 'a kill switch that cannot flatten is not a kill switch');
  eq(fake.stopCalls, 1, 'the stop went out');
});

test('stop and close-position are distinct intents', async () => {
  const { gateway, fake } = makeHarness({ orderState: () => ({ state: 'stopped' }) });
  const a = await gateway.closeGrid({ algoId: 'grid_9', instId: 'X-USD_UM_XPERP-1', stopType: '1' });
  const b = await gateway.closeGrid({ algoId: 'grid_9', instId: 'X-USD_UM_XPERP-1', stopType: '2' });
  ok(a.intentId !== b.intentId, 'the stop type is part of the identity');
  eq(fake.stopCalls, 2, 'both operations reached the venue');
  eq(fake.lastStopType, '2', 'the second one closed the position');
});

test('an unknown close is never resent', async () => {
  const { gateway, journal, fake } = makeHarness({
    stopResult: () => {
      throw new Error('socket hang up');
    },
  });

  const first = await gateway.closeGrid({ algoId: 'grid_9', instId: 'X-USD_UM_XPERP-1' });
  eq(first.unknownOutcome, true, 'unknown');
  eq(journal.find(first.intentId)?.state, 'SUBMITTED_UNKNOWN', 'journaled as unknown');

  const second = await gateway.closeGrid({ algoId: 'grid_9', instId: 'X-USD_UM_XPERP-1' });
  eq(second.codes[0], 'INTENT_DUPLICATE', 'no double stop');
  eq(fake.stopCalls, 1, 'one stop call only');
});

test('closeGrid without identifiers is refused before anything else', async () => {
  const { gateway, fake } = makeHarness();
  const res = await gateway.closeGrid({ algoId: '', instId: '' });
  eq(res.ok, false, 'refused');
  eq(fake.stopCalls, 0, 'nothing sent');
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

test('isDefiniteRejection separates verdicts from transport noise', () => {
  for (const final of [
    '51000 Parameter instId error',
    '51008 Insufficient USDT margin',
    'Invalid grid number',
    'order size below the minimum',
  ]) {
    ok(isDefiniteRejection(final), `${final} must be final`);
  }
  for (const transient of [
    'timeout of 20000ms exceeded',
    'ECONNRESET',
    'socket hang up',
    'network unreachable',
    '',
  ]) {
    ok(!isDefiniteRejection(transient), `${transient || '(empty)'} must NOT be final`);
  }
});

test('toVenueParams carries the plan through unchanged', async () => {
  const { gateway, fake } = makeHarness();
  const res = await gateway.openFromPlan(baseReq({ instId: 'BTC-USDT-SWAP', lever: 1 }));
  const params = fake.lastParams as Record<string, any>;

  eq(params.instId, 'BTC-USDT-SWAP', 'instrument preserved');
  eq(params.lever, '1', 'leverage sent as a string');
  eq(params.runType, res.plan?.runType, 'run type comes from the plan');
  eq(params.gridNum, res.plan?.gridNum, 'level count comes from the plan');
  eq(params.minPx, res.plan?.minPx, 'band comes from the plan');
  eq(params.executionVariant, 'NATIVE_ALGO', 'a SWAP id uses the native algo');
  eq(
    toVenueParams(res.plan!, 'LIVE').geometryHash,
    res.plan!.geometryHash,
    'the geometry fingerprint travels with the order'
  );
});

test('unresolvedIntents() exposes exactly what a boot must reconcile', async () => {
  const { gateway, journal } = makeHarness({
    createResult: () => {
      throw new Error('timeout');
    },
  });
  await gateway.openFromPlan(baseReq());
  const unresolved = gateway.unresolvedIntents();
  eq(unresolved.length, 1, 'one unknown intent');
  eq(unresolved[0].state, 'SUBMITTED_UNKNOWN', 'and it is the unknown one');
  eq(journal.unresolved().length, 1, 'the journal agrees with the gateway');
});

// ---------------------------------------------------------------------------
// Decided geometry (the path the agent and the autopilot actually use)
// ---------------------------------------------------------------------------

const decidedGeometry = (over: Partial<DecidedGridGeometry> = {}): DecidedGridGeometry => ({
  instId: 'LINK-USD_UM_XPERP-310523',
  minPx: 95,
  maxPx: 105,
  gridNum: 4,
  runType: '1',
  lever: 2,
  szUSDT: 11.51,
  tickSz: 0.01,
  ...over,
});

test('a decided geometry is validated, sent once and confirmed', async () => {
  const { gateway, journal, fake } = makeHarness();
  const res = await gateway.openWithGeometry(decidedGeometry(), { runId: 'run-9' });

  eq(res.ok, true, 'the open succeeded');
  eq(fake.createCalls, 1, 'exactly one create');
  eq(journal.find(res.intentId)?.state, 'CONFIRMED', 'confirmed');
  const params = fake.lastParams as Record<string, unknown>;
  eq(params.minPx, 95, 'the DECIDED band is sent, not a re-derived one');
  eq(params.maxPx, 105, 'upper band unchanged');
  eq(params.gridNum, 4, 'level count unchanged — the agent ranked these 4 levels');
  eq(params.sz, '11.51', 'margin unchanged');
});

test('refusing bad decided geometry never reaches the venue', async () => {
  const cases: { geo: Partial<DecidedGridGeometry>; code: string }[] = [
    { geo: { maxPx: 90 }, code: 'GEOMETRY_INVALID' },
    { geo: { gridNum: 1 }, code: 'GEOMETRY_INVALID' },
    { geo: { lever: 0 }, code: 'LEVER_INVALID' },
    { geo: { szUSDT: 0 }, code: 'BUDGET_INVALID' },
  ];
  for (const c of cases) {
    const { gateway, fake } = makeHarness();
    const res = await gateway.openWithGeometry(decidedGeometry(c.geo));
    eq(res.ok, false, `${c.code}: refused`);
    ok(res.codes.includes(c.code as any), `${c.code}: correct code`);
    eq(fake.createCalls, 0, `${c.code}: nothing was sent`);
  }
});

test('the same geometry can be reopened after the previous grid finished', async () => {
  const { gateway, fake } = makeHarness();

  const first = await gateway.openWithGeometry(decidedGeometry());
  eq(first.ok, true, 'the first open succeeded');

  // Same band, same levels, later: a legitimately new bot, not a duplicate of a finished one.
  const second = await gateway.openWithGeometry(decidedGeometry());
  eq(second.ok, true, 'the second open is allowed');
  ok(second.intentId !== first.intentId, 'and gets its own intent');
  eq(fake.createCalls, 2, 'both were sent');
});

test('an UNRESOLVED identical geometry still blocks the send', async () => {
  const { gateway, journal, fake } = makeHarness({
    createResult: () => {
      throw new Error('timeout of 20000ms exceeded');
    },
  });

  const first = await gateway.openWithGeometry(decidedGeometry());
  eq(first.unknownOutcome, true, 'the first attempt is unknown');

  const second = await gateway.openWithGeometry(decidedGeometry());
  eq(second.ok, false, 'the retry is refused');
  ok(second.codes.includes('INTENT_DUPLICATE'), 'as a duplicate');
  eq(second.unknownOutcome, true, 'and the caller is told the outcome is unknown');
  eq(fake.createCalls, 1, 'the venue saw exactly ONE create');
  eq(journal.unresolved().length, 1, 'one unresolved intent remains for the reconciler');
});

test('the kill switch blocks the decided path too, before any journal entry', async () => {
  const { gateway, journal, fake } = makeHarness({ killSwitch: true });
  const res = await gateway.openWithGeometry(decidedGeometry());

  eq(res.ok, false, 'refused');
  ok(res.codes.includes('KILL_SWITCH_ENGAGED'), 'with the kill-switch code');
  eq(fake.createCalls, 0, 'nothing sent');
  eq(journal.list().length, 0, 'nothing journaled');
});

test('a locally decided refusal is final, not an unknown outcome', () => {
  // The env gate refuses BEFORE the network; treating that as "unknown" would leave the desk
  // waiting for a reconciliation that can never resolve anything.
  eq(isDefiniteRejection('ENV_FLIP_REQUIRED: nothing was sent'), true, 'coded refusal is final');
  eq(isDefiniteRejection('KILL_SWITCH_ENGAGED: blocked'), true, 'kill switch is final');
  eq(isDefiniteRejection('timeout of 20000ms exceeded'), false, 'a timeout is NOT final');
  eq(isDefiniteRejection('socket hang up'), false, 'a socket error is NOT final');
});

test('a machine-readable refusal keeps its own code and is never in flight', async () => {
  const { gateway, journal, fake } = makeHarness({
    createResult: () => ({
      success: false,
      error: 'ENV_FLIP_REQUIRED: LIVE is required but the app is configured for PAPER',
      refusal: { code: 'ENV_FLIP_REQUIRED' },
    }),
  });

  const first = await gateway.openWithGeometry(decidedGeometry());
  eq(first.ok, false, 'refused');
  eq(first.codes[0], 'ENV_FLIP_REQUIRED', 'the refusal code travels, not a generic rejection');
  eq(first.unknownOutcome, undefined, 'a local refusal is never an unknown outcome');
  eq(journal.find(first.intentId)?.state, 'REJECTED', 'journaled as rejected');
  ok(
    journal.find(first.intentId)?.reasonCodes.includes('ENV_FLIP_REQUIRED'),
    'and the code is in the journal'
  );
  eq(fake.createCalls, 1, 'the single call was refused locally, nothing more was sent');

  // Nothing is in flight, so the next attempt is allowed — and it must not be mistaken for a
  // duplicate of a grid that may exist.
  const second = await gateway.openWithGeometry(decidedGeometry());
  eq(fake.createCalls, 2, 'the retry reaches the venue');
  eq(second.codes[0], 'ENV_FLIP_REQUIRED', 'and is refused again for the same honest reason');
});

test('an unregistered refusal code degrades to GATEWAY_REJECTED instead of inventing one', async () => {
  const { gateway, journal } = makeHarness({
    createResult: () => ({ success: false, error: 'nope', refusal: { code: 'NOT_A_REAL_CODE' } }),
  });
  const res = await gateway.openWithGeometry(decidedGeometry());
  eq(res.codes[0], 'GATEWAY_REJECTED', 'unknown codes are not forwarded to the journal/UI');
  eq(journal.find(res.intentId)?.state, 'REJECTED', 'still a definite rejection');
});

test('venue overrides can add fields but never re-point the geometry', async () => {
  const { gateway, fake } = makeHarness();
  await gateway.openWithGeometry(decidedGeometry(), {
    venueOverrides: {
      slTriggerPx: 90,
      tpTriggerPx: 110,
      minPx: 1,
      maxPx: 999,
      gridNum: 99,
      instId: 'SOMEONE-ELSES-INSTRUMENT',
    },
  });
  const params = fake.lastParams as Record<string, unknown>;
  eq(params.slTriggerPx, 90, 'the stop-loss trigger is carried through');
  eq(params.tpTriggerPx, 110, 'the take-profit trigger is carried through');
  eq(params.minPx, 95, 'the validated band wins over a late override');
  eq(params.maxPx, 105, 'upper band wins too');
  eq(params.gridNum, 4, 'level count wins');
  eq(params.instId, 'LINK-USD_UM_XPERP-310523', 'the instrument cannot be swapped at the last moment');
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ok    ${t.name}`);
    } catch (err: any) {
      failed += 1;
      console.error(`  FAIL  ${t.name}`);
      console.error(`        ${err?.message || err}`);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  if (failed > 0) process.exitCode = 1;
})();
