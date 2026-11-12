/**
 * Contract tests for the grid budget allocator.
 *
 * The allocator is the only place allowed to answer "how much margin may this bot get", so the
 * four guarantees in its header are asserted here as invariants, not as examples:
 *   1. the desk ceiling is never breached (fuzzed, not spot-checked);
 *   2. no candidate is shrunk below its live minimum or raised above its cap;
 *   3. allocation is deterministic (score desc, instId asc);
 *   4. every candidate ends up approved or skipped-with-a-code — nothing vanishes.
 *
 * Run: npm test
 */

import {
  allocateGridBudget,
  allocateGridBudgetUsd,
  usableDeskCents,
  type BudgetAllocationInput,
  type BudgetCandidate,
} from '../gridBudgetAllocator';

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

const baseInput = (over: Partial<BudgetAllocationInput> = {}): BudgetAllocationInput => ({
  freeBalanceCents: 10_000, // 100 USDT
  reserveCents: 2_000, // 20 USDT must stay untouched
  totalCapCents: 5_000, // 50 USDT desk ceiling
  perBotCapCents: 1_200, // 12 USDT per bot
  committedCents: 0,
  candidates: [],
  maxBots: 5,
  openBots: 0,
  ...over,
});

const cand = (instId: string, minInvCents: number, score: number): BudgetCandidate => ({
  instId,
  minInvCents,
  score,
});

/** Deterministic LCG so a failing fuzz case is reproducible from its seed. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

// ---------------------------------------------------------------------------
// Guarantee 1: the ceiling is never breached
// ---------------------------------------------------------------------------

test('the desk ceiling holds across 500 randomized desks', () => {
  const rnd = lcg(20260310);
  for (let i = 0; i < 500; i++) {
    const freeBalanceCents = Math.round(rnd() * 20_000);
    const reserveCents = Math.round(rnd() * 5_000);
    const totalCapCents = Math.round(rnd() * 10_000);
    const perBotCapCents = Math.round(rnd() * 2_000);
    const committedCents = Math.round(rnd() * 8_000);
    const candidates: BudgetCandidate[] = [];
    const count = Math.round(rnd() * 6);
    for (let c = 0; c < count; c++) {
      candidates.push(cand(`I${c}-USD_UM_XPERP-1`, Math.round(rnd() * 1_500), rnd() * 10));
    }

    const input: BudgetAllocationInput = {
      freeBalanceCents,
      reserveCents,
      totalCapCents,
      perBotCapCents,
      committedCents,
      candidates,
      maxBots: 1 + Math.round(rnd() * 4),
      openBots: Math.round(rnd() * 2),
    };
    const res = allocateGridBudget(input);

    const limit = Math.min(Math.max(0, freeBalanceCents - reserveCents), Math.max(0, totalCapCents));
    const spent = res.approved.reduce((s, a) => s + a.szCents, 0);
    // Approvals may never spend past the usable remainder. When the desk is ALREADY
    // over-committed (a lowered cap, an open bot sized earlier) `committed` can legitimately
    // exceed `limit`; the guarantee then degrades to "spend nothing more", never "overspend".
    ok(spent <= res.usableCents, `case ${i}: spent ${spent} > usable ${res.usableCents}`);
    ok(
      spent + committedCents <= Math.max(limit, committedCents),
      `case ${i}: spent ${spent} + committed ${committedCents} > max(limit, committed) ${Math.max(limit, committedCents)}`
    );
    eq(res.remainingCents, res.usableCents - spent, `case ${i}: remaining must be usable - spent`);
    ok(res.remainingCents >= 0, `case ${i}: remaining went negative`);
    ok(
      res.approved.length + res.skipped.length === candidates.length,
      `case ${i}: a candidate was neither approved nor skipped`
    );
    for (const a of res.approved) {
      ok(a.szCents > 0, `case ${i}: zero-cent approval for ${a.instId}`);
      ok(a.szCents <= perBotCapCents, `case ${i}: approval above the per-bot cap`);
    }
  }
});

test('usableDeskCents clamps hostile inputs instead of going negative', () => {
  eq(usableDeskCents({ freeBalanceCents: 1_000, reserveCents: 400, totalCapCents: 900, committedCents: 0 }), 600, 'cap binds at 600');
  eq(usableDeskCents({ freeBalanceCents: 1_000, reserveCents: 400, totalCapCents: 300, committedCents: 0 }), 300, 'total cap binds at 300');
  eq(usableDeskCents({ freeBalanceCents: 1_000, reserveCents: 2_000, totalCapCents: 900, committedCents: 0 }), 0, 'reserve above balance');
  eq(usableDeskCents({ freeBalanceCents: 1_000, reserveCents: 0, totalCapCents: 900, committedCents: 5_000 }), 0, 'over-committed desk');
  eq(usableDeskCents({ freeBalanceCents: -50, reserveCents: -10, totalCapCents: -1, committedCents: -5 }), 0, 'negatives clamp to 0');
});

// ---------------------------------------------------------------------------
// Guarantee 2: never below a minimum, never above a cap
// ---------------------------------------------------------------------------

test('a candidate whose minimum exceeds the per-bot cap is skipped, not shrunk', () => {
  const res = allocateGridBudget(
    baseInput({ candidates: [cand('BIG-USD_UM_XPERP-1', 1_850, 9), cand('OK-USD_UM_XPERP-1', 1_100, 8)] })
  );
  eq(res.approved.length, 1, 'only the affordable candidate is approved');
  eq(res.approved[0].instId, 'OK-USD_UM_XPERP-1', 'the affordable one is the small one');
  const skip = res.skipped.find((s) => s.instId === 'BIG-USD_UM_XPERP-1');
  ok(skip && skip.code === 'BUDGET_CAP_EXCEEDED', `expected BUDGET_CAP_EXCEEDED, got ${skip?.code}`);
  ok(res.approved[0].szCents >= 1_100, 'the approved size clears its minimum');
});

test('the approved size is the minimum plus one cent of headroom, never the whole cap', () => {
  const res = allocateGridBudget(baseInput({ candidates: [cand('A-USD_UM_XPERP-1', 1_100, 5)] }));
  eq(res.approved.length, 1, 'one approval');
  eq(res.approved[0].szCents, 1_101, 'minimum + 1 cent of headroom');
  ok(res.approved[0].szCents < 1_200, 'the per-bot cap is not spent just because it exists');
});

test('an unknown live minimum is skipped, never treated as a free pass', () => {
  const res = allocateGridBudget(baseInput({ candidates: [cand('NO-PROBE-USD_UM_XPERP-1', 0, 9)] }));
  eq(res.approved.length, 0, 'nothing is approved without a live floor');
  eq(res.skipped[0].code, 'MIN_PROBE_FAILED', 'the reason is explicit');
});

test('the 5 USDC floor is applied and still respects the ceiling', () => {
  const roomy = allocateGridBudget(baseInput({ candidates: [cand('A-USD_UM_XPERP-1', 100, 1)] }));
  eq(roomy.approved[0].szCents, 500, 'a 1 USDT minimum is lifted to the OKX floor');

  // Floors must never push the desk past its ceiling.
  const tight = allocateGridBudget(
    baseInput({ totalCapCents: 400, perBotCapCents: 1_200, candidates: [cand('A-USD_UM_XPERP-1', 100, 1)] })
  );
  eq(tight.approved.length, 0, 'a 4 USDT desk cannot host a 5 USDT floor');
  eq(tight.skipped[0].code, 'DESK_CAP_EXCEEDED', 'and says so');

  // A per-bot cap below the venue floor is refused, never multiplied up to 5 USDT.
  const subFloor = allocateGridBudget(
    baseInput({ perBotCapCents: 300, candidates: [cand('A-USD_UM_XPERP-1', 100, 1)] })
  );
  eq(subFloor.approved.length, 0, '3 USDT per bot cannot host the venue floor');
  eq(subFloor.skipped[0].code, 'BUDGET_CAP_EXCEEDED', 'the cap is the reason, not the desk');
});

test('an over-committed desk approves nothing but never reports a negative remainder', () => {
  const res = allocateGridBudget(
    baseInput({ totalCapCents: 2_000, committedCents: 2_968, candidates: [cand('A-USD_UM_XPERP-1', 600, 9)] })
  );
  eq(res.approved.length, 0, 'already past the cap: no new bot');
  eq(res.usableCents, 0, 'the usable ceiling is clamped to 0');
  eq(res.remainingCents, 0, 'and so is the remainder');
  eq(res.skipped[0].code, 'DESK_CAP_EXCEEDED', 'the refusal is explicit');
});

test('the desk remainder caps the second bot', () => {
  const res = allocateGridBudget(
    baseInput({
      totalCapCents: 2_300,
      perBotCapCents: 1_200,
      candidates: [cand('A-USD_UM_XPERP-1', 1_150, 9), cand('B-USD_UM_XPERP-1', 1_150, 8)],
    })
  );
  eq(res.approved.length, 1, 'only what the remainder can host');
  eq(res.approved[0].szCents, 1_151, 'the first bot takes minimum + 1 cent');
  eq(res.remainingCents, 2_300 - 1_151, 'the remainder reflects the real spend');
  eq(res.skipped[0].code, 'DESK_CAP_EXCEEDED', 'the second one is refused with a code');
});

// ---------------------------------------------------------------------------
// Guarantee 3: determinism
// ---------------------------------------------------------------------------

test('score desc, instId asc — same input, same desk, every time', () => {
  const candidates = [
    cand('C-USD_UM_XPERP-1', 600, 3),
    cand('A-USD_UM_XPERP-1', 600, 5),
    cand('B-USD_UM_XPERP-1', 600, 5),
  ];
  const first = allocateGridBudget(baseInput({ candidates, perBotCapCents: 1_000 }));
  const second = allocateGridBudget(baseInput({ candidates: [...candidates].reverse(), perBotCapCents: 1_000 }));
  eq(
    JSON.stringify(first.approved),
    JSON.stringify(second.approved),
    'input order must not change the allocation'
  );
  eq(first.approved[0].instId, 'A-USD_UM_XPERP-1', 'the tie is broken by instId ascending');
});

test('maxBots counts bots already open', () => {
  const res = allocateGridBudget(
    baseInput({
      maxBots: 3,
      openBots: 2,
      candidates: [cand('A-USD_UM_XPERP-1', 600, 9), cand('B-USD_UM_XPERP-1', 600, 8)],
    })
  );
  eq(res.approved.length, 1, 'one slot left');
  eq(res.approved[0].instId, 'A-USD_UM_XPERP-1', 'the best score takes the last slot');
  eq(res.skipped[0].code, 'MAX_BOTS_REACHED', 'the rest are refused explicitly');
});

test('a full desk approves nothing and explains why', () => {
  const res = allocateGridBudget(
    baseInput({ openBots: 5, candidates: [cand('A-USD_UM_XPERP-1', 600, 9)] })
  );
  eq(res.approved.length, 0, 'no slot, no bot');
  eq(res.skipped[0].code, 'MAX_BOTS_REACHED', 'reason is a code');
});

test('a malformed candidate is reported, not dropped', () => {
  const res = allocateGridBudget(
    baseInput({ candidates: [{ instId: '', minInvCents: 600, score: 10 }] })
  );
  eq(res.approved.length, 0, 'nothing approved');
  eq(res.skipped.length, 1, 'the candidate is still accounted for');
  eq(res.skipped[0].code, 'CANDIDATE_INVALID', 'with a code');
});

// ---------------------------------------------------------------------------
// Wrapper
// ---------------------------------------------------------------------------

test('allocateGridBudgetUsd is the same function in USDT', () => {
  const usd = allocateGridBudgetUsd({
    freeBalanceUSDT: 100,
    reserveUSDT: 20,
    totalCapUSDT: 50,
    perBotCapUSDT: 12,
    committedUSDT: 0,
    candidates: [cand('A-USD_UM_XPERP-1', 1_100, 5)],
    maxBots: 5,
    openBots: 0,
  });
  const cents = allocateGridBudget(
    baseInput({ candidates: [cand('A-USD_UM_XPERP-1', 1_100, 5)] })
  );
  eq(JSON.stringify(usd), JSON.stringify(cents), 'both entry points must agree to the cent');
});

test('an empty candidate list is a clean no-op', () => {
  const res = allocateGridBudget(baseInput());
  eq(res.approved.length, 0, 'nothing approved');
  eq(res.skipped.length, 0, 'nothing skipped');
  eq(res.remainingCents, res.usableCents, 'the whole desk stays available');
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
