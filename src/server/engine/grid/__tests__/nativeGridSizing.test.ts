/**
 * Regression suite for native grid sizing (`resolveNativeGridSize`).
 *
 * The bug this file locks down, verbatim from the production journal:
 *
 *   OPEN PUMP-USD_UM_XPERP-310404 [0.0036240-0.0036820] 4 grile 2x @7.31 U
 *   MODEL OPEN_GRID: Deschidere respinsă: Investiția alocată ($11.91) este sub
 *   investiția minimă cerută de OKX ($11.91 USD) pentru 4 grile la 2x.
 *
 * OKX answered minInvestment = 11.9108; the create path did
 * `parseFloat(max(5, baseSz, 11.9108).toFixed(2))` -> 11.91 and then compared
 * `11.91 < 11.9108` -> rejection, with both numbers printing as "$11.91".
 *
 * Run: npm test
 */

import { resolveNativeGridSize, usdToCents } from '../nativeGridSizing';

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

/** The pre-fix formula, kept here only to prove it rejects what the new one accepts. */
function legacyWouldReject(
  baseSz: number,
  minInvestmentUSDT: number,
  maxBudgetUSDT: number
): boolean {
  const sz = parseFloat(
    Math.max(
      5,
      baseSz,
      minInvestmentUSDT > 0 && minInvestmentUSDT <= Math.max(baseSz, maxBudgetUSDT)
        ? minInvestmentUSDT
        : 0
    ).toFixed(2)
  );
  return minInvestmentUSDT > 0 && sz < minInvestmentUSDT;
}

// ---------------------------------------------------------------------------
// The reported failure
// ---------------------------------------------------------------------------

test('PUMP: a 4-decimal minimum no longer rejects the grid it was rounded from', () => {
  const plan = resolveNativeGridSize({
    requestedUSDT: 7.31,
    minInvestmentUSDT: 11.9108,
    maxBudgetUSDT: 12,
  });

  eq(legacyWouldReject(7.31, 11.9108, 12), true, 'the legacy formula must still fail this case');
  eq(plan.belowMinimum, false, 'sz 11.93 clears a 11.9108 minimum — this grid must open');
  eq(plan.szCents, 1193, 'the requirement rounds UP to 11.92, plus 1 cent of headroom');
  eq(plan.raised, true, 'the raise above the $7.31 request must be visible in the journal');
  eq(plan.fitsBudget, true, '11.9108 fits inside a 12 USDC budget');
});

test('PUMP: every minimum in [11.9100, 11.9199] is satisfied', () => {
  // The old code failed this whole band: toFixed(2) mapped it all to 11.91.
  for (let k = 0; k < 100; k++) {
    const minInv = 11.91 + k / 10000;
    const plan = resolveNativeGridSize({
      requestedUSDT: 5,
      minInvestmentUSDT: minInv,
      maxBudgetUSDT: 12,
    });
    ok(!plan.belowMinimum, `min ${minInv} must be reachable with a 12 USDC budget`);
    ok(plan.szCents >= plan.minInvCents, `sz ${plan.szCents} must be >= min ${plan.minInvCents}`);
    ok(plan.szCents <= 1200, `sz ${plan.szCents} must stay inside the 12 USDC budget`);
  }
});

test('the printed numbers can never be identical when a grid is refused', () => {
  // 11.9108 -> sz 11.91 in the old path, so the message read "$11.91 sub $11.91".
  const cases: Array<[number, number, number]> = [
    [7.31, 18.5, 12],
    [7.31, 12.01, 12],
    [5, 5.0001, 5],
    [11.91, 11.9108, 11.91],
  ];
  for (const [req, minInv, budget] of cases) {
    const plan = resolveNativeGridSize({
      requestedUSDT: req,
      minInvestmentUSDT: minInv,
      maxBudgetUSDT: budget,
    });
    if (!plan.belowMinimum) continue;
    ok(
      plan.szCents < plan.minInvCents,
      `a refused grid must be refused by real cents (sz ${plan.szCents} vs min ${plan.minInvCents})`
    );
  }

  // The minimal pair that must be refused: 5.00 sent against a 5.0001 requirement.
  const refused = resolveNativeGridSize({
    requestedUSDT: 5,
    minInvestmentUSDT: 5.0001,
    maxBudgetUSDT: 5,
  });
  eq(refused.szCents, 500, 'sz stays at the 5 USDC floor');
  eq(refused.minInvCents, 501, 'the requirement is 5.01, a distinct number from 5.00');
  eq(refused.belowMinimum, true, '5.00 really is below 5.0001 — refuse it, but print it honestly');
});

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

test('sz never exceeds the ceiling and never sits below a reachable minimum', () => {
  const budgets = [5, 5.11, 12, 20, 50];
  const minimums = [0, 5, 5.11, 11.9108, 12, 18.5, 49.99];
  const requests = [0, 5, 7.31, 12, 100, Number.NaN, -4];

  for (const budget of budgets) {
    for (const minInv of minimums) {
      for (const req of requests) {
        const plan = resolveNativeGridSize({
          requestedUSDT: req,
          minInvestmentUSDT: minInv,
          maxBudgetUSDT: budget,
        });
        const ceiling = Math.max(Number(req) > 0 ? Number(req) : 0, budget);
        ok(
          Number.isFinite(plan.szCents) && plan.szCents > 0,
          `sz must be finite and positive (budget ${budget}, min ${minInv}, req ${req})`
        );
        ok(
          plan.szCents / 100 <= ceiling + 1e-9,
          `sz ${plan.szCents / 100} must stay within ${ceiling} (min ${minInv}, req ${req})`
        );
        if (minInv > 0 && minInv <= ceiling) {
          ok(
            !plan.belowMinimum,
            `min ${minInv} fits the ceiling ${ceiling}, so it must not be refused (req ${req})`
          );
        }
      }
    }
  }
});

test('the 5 USDC OKX floor is respected but never invented on top of a smaller budget', () => {
  eq(resolveNativeGridSize({ requestedUSDT: 0, minInvestmentUSDT: 0, maxBudgetUSDT: 5 }).szCents, 500, 'no usable request -> the 5 USDC floor');
  eq(resolveNativeGridSize({ requestedUSDT: 1.2, minInvestmentUSDT: 0, maxBudgetUSDT: 5 }).szCents, 500, 'a request under the floor is lifted to the floor');
  eq(resolveNativeGridSize({ requestedUSDT: 0, minInvestmentUSDT: 0, maxBudgetUSDT: 12 }).szCents, 500, 'an unbounded budget does not inflate the size');
});

test('a failed minimum probe (0) neither rejects nor inflates', () => {
  const plan = resolveNativeGridSize({
    requestedUSDT: 7.31,
    minInvestmentUSDT: 0,
    maxBudgetUSDT: 12,
  });
  eq(plan.szCents, 731, 'sz is exactly what the caller asked for');
  eq(plan.belowMinimum, false, 'an unknown minimum cannot reject the grid');
  eq(plan.raised, false, 'nothing was raised, nothing is journaled');
});

test('minimum == budget is accepted at the budget, with no headroom past it', () => {
  const plan = resolveNativeGridSize({
    requestedUSDT: 12,
    minInvestmentUSDT: 12,
    maxBudgetUSDT: 12,
  });
  eq(plan.szCents, 1200, 'the 1 cent of headroom must not push past the budget');
  eq(plan.belowMinimum, false, 'equality is a valid size');
});

test('cent boundaries survive the binary-float trap', () => {
  // 5.11 * 100 === 510.99999999999994: a raw Math.ceil() would send 5.12 against a 5.11 budget.
  eq(usdToCents(5.11), 511, '5.11 USD must be exactly 511 cents');
  eq(usdToCents(1.1), 110, '1.10 USD must be exactly 110 cents');
  eq(usdToCents(0.07), 7, '0.07 USD must be exactly 7 cents');

  const plan = resolveNativeGridSize({
    requestedUSDT: 0,
    minInvestmentUSDT: 5.11,
    maxBudgetUSDT: 5.11,
  });
  eq(plan.szCents, 511, 'budget 5.11 and minimum 5.11 must resolve to exactly 5.11');
  eq(plan.belowMinimum, false, '5.11 is not below 5.11');
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
