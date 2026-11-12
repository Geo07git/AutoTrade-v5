/**
 * Contract tests for the crash-safe grid intent journal.
 *
 * The journal exists to make one scenario impossible: resubmitting an order whose fate is
 * unknown. So the tests below concentrate on the state machine's refusals — terminal states
 * are final, `SUBMITTED_UNKNOWN` can only leave through reconciliation, and a corrupt store
 * degrades to "no history" instead of crashing the desk or pretending a write succeeded.
 *
 * Run: npm test
 */

import {
  GridIntentJournal,
  MemoryIntentStore,
  isResubmittableState,
  isTerminalState,
  makeIntentId,
  type GridIntent,
  type IntentStoreAdapter,
} from '../GridIntentJournal';

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

let clock = 1_700_000_000_000;
const tick = (ms = 1_000): number => {
  clock += ms;
  return clock;
};

const makeJournal = (opts: { maxTerminal?: number; store?: IntentStoreAdapter } = {}) =>
  new GridIntentJournal(opts.store ?? new MemoryIntentStore(), {
    now: () => tick(),
    maxTerminal: opts.maxTerminal ?? 100,
  });

const openIntent = (j: GridIntentJournal, hash = 'h1', instId = 'LINK-USD_UM_XPERP-310523') =>
  j.plan({ action: 'OPEN', instId, geometryHash: hash, szCents: 1_151, runId: 'run-1' });

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

test('the same action on the same geometry is one intent', () => {
  eq(
    makeIntentId('OPEN', 'LINK-USD_UM_XPERP-310523', 'abc'),
    makeIntentId('OPEN', 'LINK-USD_UM_XPERP-310523', 'abc'),
    'identity is deterministic'
  );
  ok(
    makeIntentId('OPEN', 'LINK-USD_UM_XPERP-310523', 'abc') !==
      makeIntentId('OPEN', 'LINK-USD_UM_XPERP-310523', 'abd'),
    'a different geometry is a different intent'
  );
  ok(
    makeIntentId('OPEN', 'LINK-USD_UM_XPERP-310523', 'abc') !==
      makeIntentId('CLOSE', 'LINK-USD_UM_XPERP-310523', 'abc'),
    'a different action is a different intent'
  );
  eq(makeIntentId('OPEN', 'X'), 'OPEN:X:no-geometry', 'missing geometry is spelled out');
});

test('planning twice never creates a duplicate and never mutates the first', () => {
  const j = makeJournal();
  const first = openIntent(j);
  const second = openIntent(j);

  eq(first.intentId, second.intentId, 'same id');
  eq(j.list().length, 1, 'one record only');
  eq(second.state, 'PLANNED', 'the existing record is returned untouched');
  eq(second.attempts, 0, 'and no attempt was counted');
});

test('a second geometry for the same symbol is a separate intent', () => {
  const j = makeJournal();
  openIntent(j, 'h1');
  openIntent(j, 'h2');
  eq(j.list().length, 2, 'two geometries, two intents');
});

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

test('a planned intent can be submitted, and attempts are counted', () => {
  const j = makeJournal();
  const intent = openIntent(j);
  eq(j.canSubmit(intent.intentId), true, 'nothing sent yet');

  const submitting = j.transition(intent.intentId, 'SUBMITTING');
  eq(submitting?.state, 'SUBMITTING', 'submitted');
  eq(submitting?.attempts, 1, 'first attempt');

  eq(j.canSubmit(intent.intentId), false, 'a send in flight is not resubmittable');

  j.transition(intent.intentId, 'SUBMITTED_UNKNOWN');
  eq(j.canSubmit(intent.intentId), false, 'an unknown send is not resubmittable');
});

test('SUBMITTED_UNKNOWN can never be resubmitted — only reconciled', () => {
  const j = makeJournal();
  const intent = openIntent(j);
  j.transition(intent.intentId, 'SUBMITTING');
  j.transition(intent.intentId, 'SUBMITTED_UNKNOWN');

  const blocked = j.transition(intent.intentId, 'SUBMITTING');
  eq(blocked?.state, 'SUBMITTED_UNKNOWN', 'the resend is refused');
  eq(blocked?.attempts, 1, 'no attempt was counted for the refused resend');

  const confirmed = j.settle(intent.intentId, 'CONFIRMED', { algoId: 'grid_123' });
  eq(confirmed?.state, 'CONFIRMED', 'a reconciliation verdict is accepted');
  eq(confirmed?.algoId, 'grid_123', 'and it records what OKX said');
});

test('a rejected intent may be retried', () => {
  const j = makeJournal();
  const intent = openIntent(j);
  j.transition(intent.intentId, 'SUBMITTING');
  j.settle(intent.intentId, 'REJECTED', { lastError: '51000' });
  eq(j.canSubmit(intent.intentId), true, 'a definite rejection is retryable');

  const retry = j.transition(intent.intentId, 'SUBMITTING');
  eq(retry?.attempts, 2, 'the retry is counted');
});

test('terminal states are final', () => {
  const j = makeJournal();
  const intent = openIntent(j);
  j.settle(intent.intentId, 'CONFIRMED', { algoId: 'grid_1' });

  const forced = j.transition(intent.intentId, 'REJECTED', { lastError: 'late' });
  eq(forced?.state, 'CONFIRMED', 'a confirmed bot cannot be rewritten as rejected');
  eq(forced?.lastError, undefined, 'and the patch is not applied either');
});

test('reason codes accumulate without duplicates', () => {
  const j = makeJournal();
  const intent = j.plan({
    action: 'OPEN',
    instId: 'LINK-USD_UM_XPERP-310523',
    geometryHash: 'h1',
    reasonCodes: ['DESK_CAP_EXCEEDED'],
  });
  j.transition(intent.intentId, 'SUBMITTING', { reasonCodes: ['DESK_CAP_EXCEEDED', 'DRY_RUN'] });
  const rec = j.find(intent.intentId);
  eq(rec?.reasonCodes.length, 2, 'one code per reason');
  ok(rec?.reasonCodes.includes('DESK_CAP_EXCEEDED'), 'the original code survives');
  ok(rec?.reasonCodes.includes('DRY_RUN'), 'the new code is added');
});

test('transitioning an unknown intent returns undefined instead of inventing one', () => {
  const j = makeJournal();
  eq(j.transition('nope', 'CONFIRMED'), undefined, 'no phantom records');
});

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

test('unresolved() lists exactly the intents a boot must reconcile', () => {
  const j = makeJournal();
  const a = j.plan({ action: 'OPEN', instId: 'A-USD_UM_XPERP-1', geometryHash: 'h1' });
  const b = j.plan({ action: 'OPEN', instId: 'B-USD_UM_XPERP-1', geometryHash: 'h1' });
  j.plan({ action: 'OPEN', instId: 'C-USD_UM_XPERP-1', geometryHash: 'h1' });

  j.settle(a.intentId, 'CONFIRMED');
  j.transition(b.intentId, 'SUBMITTING');

  const unresolved = j.unresolved().map((i) => i.instId).sort();
  eq(unresolved.length, 2, 'only the live ones');
  ok(unresolved.includes('B-USD_UM_XPERP-1'), 'in-flight is unresolved');
  ok(unresolved.includes('C-USD_UM_XPERP-1'), 'planned is unresolved');
});

test('findByAlgoId resolves the confirmation record', () => {
  const j = makeJournal();
  const intent = openIntent(j);
  j.settle(intent.intentId, 'CONFIRMED', { algoId: 'grid_abc' });
  eq(j.findByAlgoId('grid_abc')?.intentId, intent.intentId, 'algoId lookup works');
  eq(j.findByAlgoId('grid_nope'), undefined, 'unknown algoId finds nothing');
});

test('isTerminalState / isResubmittableState agree with the machine', () => {
  for (const s of ['CONFIRMED', 'REJECTED', 'ABANDONED'] as const) {
    ok(isTerminalState(s), `${s} is terminal`);
    ok(!isResubmittableState(s) || s === 'REJECTED' || s === 'ABANDONED', `${s} resubmit rule`);
  }
  ok(!isTerminalState('SUBMITTING'), 'in flight is not terminal');
  ok(!isResubmittableState('SUBMITTING'), 'in flight is not resubmittable');
  ok(!isResubmittableState('SUBMITTED_UNKNOWN'), 'unknown is never resubmittable');
  ok(isResubmittableState('PLANNED'), 'a plan may be sent');
});

// ---------------------------------------------------------------------------
// Pruning and failure modes
// ---------------------------------------------------------------------------

test('pruning keeps every live intent and only the newest terminal ones', () => {
  const j = makeJournal({ maxTerminal: 2 });

  const live = j.plan({ action: 'OPEN', instId: 'LIVE-USD_UM_XPERP-1', geometryHash: 'h0' });
  j.transition(live.intentId, 'SUBMITTING');

  for (let i = 1; i <= 4; i++) {
    const settled = j.plan({ action: 'OPEN', instId: `S${i}-USD_UM_XPERP-1`, geometryHash: 'h1' });
    j.settle(settled.intentId, 'CONFIRMED', { algoId: `grid_${i}` });
  }

  const records = j.list();
  eq(records.length, 3, '2 terminal + 1 live');
  ok(records.some((r) => r.instId === 'LIVE-USD_UM_XPERP-1'), 'the live intent is never pruned');
  ok(!records.some((r) => r.instId === 'S1-USD_UM_XPERP-1'), 'the oldest terminal is dropped');
  ok(records.some((r) => r.instId === 'S4-USD_UM_XPERP-1'), 'the newest terminal is kept');
});

test('a corrupt store degrades to "no history" instead of crashing', () => {
  let failLoad = true;
  const store: IntentStoreAdapter = {
    load: () => {
      if (failLoad) throw new Error('EACCES');
      return [];
    },
    save: () => {
      throw new Error('ENOSPC');
    },
  };
  const j = new GridIntentJournal(store, { now: () => tick() });

  eq(JSON.stringify(j.list()), '[]', 'a broken load looks like an empty journal');
  eq(j.unresolved().length, 0, 'and nothing is reported as in flight');

  // A failing save must not throw out of plan(): the decision was already taken in memory.
  let threw = false;
  try {
    j.plan({ action: 'OPEN', instId: 'A-USD_UM_XPERP-1', geometryHash: 'h1' });
  } catch {
    threw = true;
  }
  ok(!threw, 'a persistence failure must never break the caller');
  failLoad = false;
});

test('records survive a store round-trip without sharing references', () => {
  const store = new MemoryIntentStore();
  const j = new GridIntentJournal(store, { now: () => tick() });
  const intent = openIntent(j);

  const loaded = j.list();
  loaded[0].state = 'CONFIRMED';
  const again = j.list();
  eq(again[0].state, 'PLANNED', 'mutating a read result cannot corrupt the store');

  eq(j.find(intent.intentId)?.szCents, 1_151, 'the margin is persisted in cents');
  ok(
    typeof (store.load() as GridIntent[])[0].createdAt === 'number',
    'timestamps come from the injected clock'
  );
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
