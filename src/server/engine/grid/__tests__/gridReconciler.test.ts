/**
 * Contract tests for the grid reconciler.
 *
 * The reconciler is the counterpart of the gateway's "never resend" rule: it is the only thing
 * that can turn an unknown intent into a decision. Two properties matter most and have their own
 * tests here:
 *
 *   - a FAILED venue query resolves nothing (no ABANDONED, so no accidental resend);
 *   - ambiguity is reported, never guessed.
 *
 * The last block is the loop that actually matters in production: create times out → reconcile
 * → the desk may retry, and the venue saw exactly one live attempt at a time.
 *
 * Run: npm test
 */

import { GridReconciler, type GridReconcilePort, type GridVenueBot } from '../GridReconciler';
import { GridIntentJournal, MemoryIntentStore } from '../GridIntentJournal';
import { GridCommandGateway, type GridVenuePort } from '../GridCommandGateway';
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

const INST = 'LINK-USD_UM_XPERP-310523';
const NOW = 1_700_000_000_000;

const venuePort = (bots: GridVenueBot[] | Error): GridReconcilePort => ({
  async listVenueBots() {
    if (bots instanceof Error) throw bots;
    return bots;
  },
});

function makeJournal() {
  return new GridIntentJournal(new MemoryIntentStore(), { now: () => NOW });
}

/** An OPEN intent stuck in the network limbo the gateway leaves behind. */
function stuckOpen(
  journal: GridIntentJournal,
  opts: { algoId?: string; geometry?: boolean; instId?: string } = {}
) {
  const intent = journal.plan({
    action: 'OPEN',
    instId: opts.instId || INST,
    geometryHash: 'g1',
    szCents: 1_151,
    geometry: opts.geometry === false
      ? undefined
      : { minPx: 95, maxPx: 105, gridNum: 4, lever: 2, runType: '1' },
  });
  journal.transition(intent.intentId, 'SUBMITTING');
  journal.transition(intent.intentId, 'SUBMITTED_UNKNOWN', opts.algoId ? { algoId: opts.algoId } : {});
  return journal.find(intent.intentId)!;
}

function stuckClose(journal: GridIntentJournal, algoId = 'grid_9') {
  const intent = journal.plan({ action: 'CLOSE', instId: INST, geometryHash: `${algoId}:stop1` });
  journal.transition(intent.intentId, 'SUBMITTING', { algoId });
  journal.transition(intent.intentId, 'SUBMITTED_UNKNOWN', { algoId });
  return journal.find(intent.intentId)!;
}

const makeReconciler = (journal: GridIntentJournal, bots: GridVenueBot[] | Error) =>
  new GridReconciler({ journal, venue: venuePort(bots) });

// ---------------------------------------------------------------------------
// Venue down: the dangerous default
// ---------------------------------------------------------------------------

test('a failed venue query changes NOTHING and resolves nothing', async () => {
  const journal = makeJournal();
  const intent = stuckOpen(journal, { algoId: 'grid_1' });

  const report = await makeReconciler(journal, new Error('ECONNRESET')).reconcile();

  eq(report.available, false, 'the report says the venue was unavailable');
  eq(report.confirmed, 0, 'nothing confirmed');
  eq(report.abandoned, 0, 'nothing abandoned — that is what would allow a resend');
  eq(report.stillUnknown, 1, 'one intent still unknown');
  ok(report.codes.includes('RECONCILE_UNAVAILABLE'), 'with an explicit code');
  eq(journal.find(intent.intentId)?.state, 'SUBMITTED_UNKNOWN', 'the journal is untouched');
  eq(journal.canSubmit(intent.intentId), false, 'and it still cannot be resent');
});

test('a non-list answer is treated as unavailable, not as "no bots"', async () => {
  const journal = makeJournal();
  const intent = stuckOpen(journal, { algoId: 'grid_1' });
  const reconciler = new GridReconciler({
    journal,
    venue: { listVenueBots: async () => null as unknown as GridVenueBot[] },
  });

  const report = await reconciler.reconcile();
  eq(report.available, false, 'unavailable');
  eq(journal.find(intent.intentId)?.state, 'SUBMITTED_UNKNOWN', 'and nothing was concluded');
});

// ---------------------------------------------------------------------------
// OPEN
// ---------------------------------------------------------------------------

test('an open with a known algoId that the venue has is confirmed', async () => {
  const journal = makeJournal();
  const intent = stuckOpen(journal, { algoId: 'grid_1' });

  const report = await makeReconciler(journal, [
    { algoId: 'grid_1', instId: INST, state: 'running' },
  ]).reconcile();

  eq(report.confirmed, 1, 'one confirmation');
  eq(journal.find(intent.intentId)?.state, 'CONFIRMED', 'the intent is settled');
  eq(journal.find(intent.intentId)?.algoId, 'grid_1', 'the algoId is kept');
  ok(journal.find(intent.intentId)!.reasonCodes.includes('RECONCILED_CONFIRMED'), 'labelled');
});

test('an open whose algoId the venue does not know is abandoned and retryable', async () => {
  const journal = makeJournal();
  const intent = stuckOpen(journal, { algoId: 'grid_1' });

  await makeReconciler(journal, []).reconcile();

  eq(journal.find(intent.intentId)?.state, 'ABANDONED', 'proved absent');
  ok(journal.find(intent.intentId)!.reasonCodes.includes('RECONCILED_ABSENT'), 'labelled');
  eq(journal.canSubmit(intent.intentId), true, 'and now a retry is allowed');
});

test('an open without an algoId matches on instrument + geometry', async () => {
  const journal = makeJournal();
  const intent = stuckOpen(journal, {});

  await makeReconciler(journal, [
    // Same instrument, different geometry: must not be adopted.
    { algoId: 'grid_other', instId: INST, state: 'running', minPx: 90, maxPx: 110, gridNum: 8, lever: 2 },
    { algoId: 'grid_mine', instId: INST, state: 'running', minPx: 95, maxPx: 105, gridNum: 4, lever: 2 },
  ]).reconcile();

  const settled = journal.find(intent.intentId)!;
  eq(settled.state, 'CONFIRMED', 'the geometry match resolves it');
  eq(settled.algoId, 'grid_mine', 'and adopts the right bot, not the first one listed');
});

test('two identical candidates stay unknown instead of being guessed', async () => {
  const journal = makeJournal();
  const intent = stuckOpen(journal, {});

  const report = await makeReconciler(journal, [
    { algoId: 'grid_a', instId: INST, state: 'running', minPx: 95, maxPx: 105, gridNum: 4, lever: 2 },
    { algoId: 'grid_b', instId: INST, state: 'running', minPx: 95, maxPx: 105, gridNum: 4, lever: 2 },
  ]).reconcile();

  eq(report.stillUnknown, 1, 'still unknown');
  ok(report.codes.includes('RECONCILE_AMBIGUOUS'), 'with an ambiguity code');
  eq(journal.find(intent.intentId)?.state, 'SUBMITTED_UNKNOWN', 'the journal is not rewritten');
  eq(journal.find(intent.intentId)?.algoId, undefined, 'and no bot is adopted');
});

test('a legacy intent without geometry matches on instrument alone', async () => {
  const journal = makeJournal();
  const intent = stuckOpen(journal, { geometry: false });

  await makeReconciler(journal, [
    { algoId: 'grid_a', instId: INST, state: 'running' },
    { algoId: 'grid_b', instId: 'OTHER-USD_UM_XPERP-1', state: 'running' },
  ]).reconcile();

  eq(journal.find(intent.intentId)?.state, 'CONFIRMED', 'one candidate on the instrument is enough');
  eq(journal.find(intent.intentId)?.algoId, 'grid_a', 'and it is recorded');
});

// ---------------------------------------------------------------------------
// CLOSE
// ---------------------------------------------------------------------------

test('a close whose bot is gone is confirmed', async () => {
  const journal = makeJournal();
  const intent = stuckClose(journal, 'grid_9');

  await makeReconciler(journal, []).reconcile();

  eq(journal.find(intent.intentId)?.state, 'CONFIRMED', 'the stop took effect');
});

test('a close whose bot still runs is abandoned so a new stop may be issued', async () => {
  const journal = makeJournal();
  const intent = stuckClose(journal, 'grid_9');

  await makeReconciler(journal, [
    { algoId: 'grid_9', instId: INST, state: 'running' },
  ]).reconcile();

  eq(journal.find(intent.intentId)?.state, 'ABANDONED', 'the stop did not apply');
  ok(
    journal.find(intent.intentId)!.reasonCodes.includes('RECONCILED_STILL_RUNNING'),
    'and the code says why'
  );
  eq(journal.canSubmit(intent.intentId), true, 'a new stop is allowed');
});

// ---------------------------------------------------------------------------
// Mechanics
// ---------------------------------------------------------------------------

test('reconciling twice is a no-op the second time', async () => {
  const journal = makeJournal();
  const intent = stuckOpen(journal, { algoId: 'grid_1' });
  const reconciler = makeReconciler(journal, [{ algoId: 'grid_1', instId: INST, state: 'running' }]);

  const first = await reconciler.reconcile();
  const second = await reconciler.reconcile();

  eq(first.checked, 1, 'the first pass had work to do');
  eq(second.checked, 0, 'the second had none');
  eq(second.confirmed, 0, 'and changed nothing');
  eq(journal.find(intent.intentId)?.state, 'CONFIRMED', 'the verdict is stable');
});

test('oldest intents are reconciled first and the cycle is capped', async () => {
  const journal = makeJournal();
  const first = stuckOpen(journal, { algoId: 'grid_old' });
  const second = stuckOpen(journal, { algoId: 'grid_new', instId: 'OTHER-USD_UM_XPERP-1' });

  const reconciler = new GridReconciler({
    journal,
    venue: venuePort([]),
    maxPerCycle: 1,
  });
  const report = await reconciler.reconcile();

  eq(report.checked, 1, 'only one intent was examined');
  eq(journal.find(first.intentId)?.state, 'ABANDONED', 'the oldest one was resolved');
  eq(journal.find(second.intentId)?.state, 'SUBMITTED_UNKNOWN', 'the newer one waits its turn');
});

test('nothing to do is a clean empty report', async () => {
  const journal = makeJournal();
  const report = await makeReconciler(journal, []).reconcile();
  eq(report.checked, 0, 'no intents');
  eq(report.available, true, 'and the venue was never asked');
  eq(report.codes.length, 0, 'no codes');
});

// ---------------------------------------------------------------------------
// The loop that matters: create timeout → reconcile → retry
// ---------------------------------------------------------------------------

const planReq = (over: Partial<GridPlanRequest> = {}): GridPlanRequest => ({
  instId: INST,
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

test('timeout → reconcile → the desk can retry, and never doubles the position', async () => {
  const journal = makeJournal();
  let createCalls = 0;
  const created: GridVenueBot[] = [];

  // The venue: the first create "loses" its response, the second one is fine.
  const venue: GridVenuePort = {
    async createGrid() {
      createCalls += 1;
      if (createCalls === 1) throw new Error('timeout of 20000ms exceeded');
      const bot: GridVenueBot = { algoId: `grid_${createCalls}`, instId: INST, state: 'running' };
      created.push(bot);
      return { success: true, algoId: bot.algoId };
    },
    async stopGrid() {
      return { success: true };
    },
    async getOrderState(algoId) {
      const found = created.find((b) => b.algoId === algoId);
      return { state: found ? 'running' : 'absent' };
    },
  };

  const gateway = new GridCommandGateway({
    journal,
    venue,
    gates: { isKillSwitchEngaged: () => false, executionEnvironment: () => 'DEMO' },
    now: () => NOW,
    confirmAttempts: 1,
    confirmDelayMs: 0,
    sleep: async () => {},
  });

  // 1. The create times out: unknown, and blocked from resending.
  const attempt1 = await gateway.openFromPlan(planReq());
  eq(attempt1.unknownOutcome, true, 'unknown outcome');
  const blocked = await gateway.openFromPlan(planReq());
  eq(blocked.codes[0], 'INTENT_DUPLICATE', 'the desk cannot double the position');
  eq(createCalls, 1, 'only one create reached the venue');

  // 2. Reconciliation proves nothing landed (the venue list never had it).
  const report = await new GridReconciler({
    journal,
    venue: { listVenueBots: async () => created },
  }).reconcile();
  eq(report.abandoned, 1, 'proved absent');
  eq(journal.find(attempt1.intentId)?.state, 'ABANDONED', 'the intent is closed out');

  // 3. Now a retry is both allowed and safe, because the previous attempt provably never landed.
  const attempt2 = await gateway.openFromPlan(planReq());
  eq(attempt2.ok, true, 'the retry succeeds');
  eq(createCalls, 2, 'exactly one live attempt at a time');
  eq(journal.find(attempt2.intentId)?.state, 'CONFIRMED', 'and is confirmed');

  // 4. Had it landed instead, reconciliation would have confirmed it and the retry would stay
  //    blocked. Same loop, opposite verdict.
  const stuckJournal = makeJournal();
  const stuck = stuckOpen(stuckJournal, {});
  await new GridReconciler({
    journal: stuckJournal,
    venue: {
      listVenueBots: async () => [
        { algoId: 'grid_x', instId: INST, state: 'running', minPx: 95, maxPx: 105, gridNum: 4, lever: 2 },
      ],
    },
  }).reconcile();
  eq(stuckJournal.find(stuck.intentId)?.state, 'CONFIRMED', 'the create is proven to have landed');
  eq(stuckJournal.canSubmit(stuck.intentId), false, 'and can never be resent');
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
