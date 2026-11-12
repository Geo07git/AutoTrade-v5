/**
 * Tests for the execution-environment gate.
 *
 * The regression this protects: `createNativeGridBot()` escalated the whole process to LIVE
 * whenever the venue answered 51001. The gate must refuse that by default and only ever return
 * an explicit, caller-performed flip when the owner approved it.
 *
 * Run: npm test
 */

import { describeGridEnvGate, resolveGridEnvGate } from '../gridEnvGate';

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

test('the configured environment is always enough when LIVE is not required', () => {
  for (const mode of ['PAPER', 'LIVE'] as const) {
    const d = resolveGridEnvGate({ current: mode, required: 'CONFIGURED', allowFlipToLive: false });
    ok(d.allowed, `${mode}: allowed`);
    eq(d.flipTo, undefined, `${mode}: no flip requested`);
    eq(d.code, undefined, `${mode}: no code`);
  }
});

test('already LIVE needs no flip', () => {
  const d = resolveGridEnvGate({ current: 'LIVE', required: 'LIVE', allowFlipToLive: false });
  ok(d.allowed, 'allowed');
  eq(d.flipTo, undefined, 'nothing to change');
});

test('PAPER + LIVE required + no approval is refused with a code', () => {
  const d = resolveGridEnvGate({ current: 'PAPER', required: 'LIVE', allowFlipToLive: false });
  eq(d.allowed, false, 'refused');
  eq(d.code, 'ENV_FLIP_REQUIRED', 'with the right code');
  eq(d.flipTo, undefined, 'and NO flip instruction — the silent escalation is gone');
  ok(d.detail.includes('allowGridEnvFlipToLive'), 'the message names the switch to enable');
  ok(d.detail.includes('nothing was sent'), 'and states that nothing was sent');
});

test('an approved escalation is explicit, never implicit', () => {
  const d = resolveGridEnvGate({ current: 'PAPER', required: 'LIVE', allowFlipToLive: true });
  ok(d.allowed, 'allowed');
  eq(d.flipTo, 'LIVE', 'the caller is told exactly what to do');
  ok(d.detail.includes('log'), 'and told to log it');
});

test('a missing approval flag behaves like false', () => {
  const d = resolveGridEnvGate({
    current: 'PAPER',
    required: 'LIVE',
    allowFlipToLive: undefined as unknown as boolean,
  });
  eq(d.allowed, false, 'absent approval is not approval');
  eq(d.code, 'ENV_FLIP_REQUIRED', 'still a coded refusal');
});

test('describeGridEnvGate never claims a flip that was not approved', () => {
  eq(
    describeGridEnvGate(resolveGridEnvGate({ current: 'PAPER', required: 'LIVE', allowFlipToLive: false })),
    'env: refused (ENV_FLIP_REQUIRED)',
    'refusal is described as a refusal'
  );
  eq(
    describeGridEnvGate(resolveGridEnvGate({ current: 'PAPER', required: 'LIVE', allowFlipToLive: true })),
    'env: LIVE (approved flip)',
    'approval is described as approved'
  );
  eq(
    describeGridEnvGate(resolveGridEnvGate({ current: 'LIVE', required: 'LIVE', allowFlipToLive: false })),
    'env: configured',
    'no change means configured'
  );
});

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
