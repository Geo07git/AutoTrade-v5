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
import type { GridPlanRequest } from '../gridPlan';

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
