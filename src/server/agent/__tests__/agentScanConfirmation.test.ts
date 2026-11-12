/**
 * Regression suite for the two-look confirmation gate (`agentScanConfirmation`).
 *
 * Offline and clock-injected: every case fixes `now`, so "two looks 20 minutes
 * apart" is an exact statement and not a timing-sensitive test.
 *
 * Run: npm test
 */

import {
  SCAN_CONFIRMATION_DEFAULT_MAX_AGE_MINUTES,
  SCAN_CONFIRMATION_DEFAULT_MIN_SPACING_MINUTES,
  SCAN_CONFIRMATION_DEFAULT_TOP_N,
  applyScanToLedger,
  confirmationOf,
  explainNotConfirmed,
  isQualifyingRow,
  resolveConfirmationConfig,
  type ScanConfirmationConfig,
  type ScanConfirmationLedger,
} from '../agentScanConfirmation';
import type { NativeGridOpportunity } from '../../../shared/types';

// ---------------------------------------------------------------------------
// Tiny runner (same pattern as agentUniverseScan.test.ts)
// ---------------------------------------------------------------------------

const registered: Array<{ name: string; fn: () => Promise<void> | void }> = [];
const test = (name: string, fn: () => Promise<void> | void) => registered.push({ name, fn });

const ok = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(msg);
};

const eq = (actual: unknown, expected: unknown, msg: string): void => {
  if (actual !== expected) {
    throw new Error(`${msg} (expected ${String(expected)}, got ${String(actual)})`);
  }
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MIN = 60_000;
const BTC = 'BTC-USD_UM_XPERP-310404';
const ETH = 'ETH-USD_UM_XPERP-310405';

/** Only the fields the gate reads are meaningful; the rest is filler. */
const row = (over: Partial<NativeGridOpportunity> = {}): NativeGridOpportunity =>
  ({
    instId: BTC,
    isEligible: true,
    rank: 1,
    crossingsPerHour: 1.2,
    estimatedNetProfitPerGridPct: 0.2,
    ...over,
  }) as NativeGridOpportunity;

const cfg = (over: Partial<ScanConfirmationConfig> = {}): ScanConfirmationConfig => ({
  topN: 10,
  minNetPerGridPct: 0.05,
  minCrossingsPerHour: 0.3,
  maxAgeMinutes: 180,
  minSpacingMinutes: 5,
  ttlMinutes: 720,
  ...over,
});

// ---------------------------------------------------------------------------
// Qualification of a single look
// ---------------------------------------------------------------------------

test('a top-ranked eligible row with edge qualifies', () => {
  ok(isQualifyingRow(row(), cfg()), 'rank 1, 1.2 crossings/h, 0.2% net must qualify');
});

test('an ineligible row never qualifies, whatever its rank', () => {
  ok(!isQualifyingRow(row({ isEligible: false }), cfg()), 'ineligible must not qualify');
});

test('a rank outside top N does not qualify', () => {
  ok(!isQualifyingRow(row({ rank: 11 }), cfg({ topN: 10 })), 'rank 11 > top 10');
  ok(isQualifyingRow(row({ rank: 10 }), cfg({ topN: 10 })), 'rank 10 is inside the top 10');
  ok(!isQualifyingRow(row({ rank: 0 }), cfg()), 'an unranked row cannot qualify');
});

test('edge floors are the same ones the open will enforce', () => {
  ok(
    !isQualifyingRow(row({ estimatedNetProfitPerGridPct: 0.04 }), cfg({ minNetPerGridPct: 0.05 })),
    'net per grid below the floor'
  );
  ok(
    !isQualifyingRow(row({ crossingsPerHour: 0.2 }), cfg({ minCrossingsPerHour: 0.3 })),
    'crossings below the floor'
  );
});

// ---------------------------------------------------------------------------
// The confirmation itself
// ---------------------------------------------------------------------------

test('one look is never a confirmation', () => {
  const t0 = 1_000_000;
  const res = applyScanToLedger(undefined, [row()], cfg(), t0);
  eq(res.confirmed.length, 0, 'a single qualifying scan must not confirm anything');
  eq(res.pending.length, 1, 'the candidate is reported as pending');
  const mem = confirmationOf(res.ledger, BTC)!;
  eq(mem.observations, 1, 'one observation recorded');
  eq(mem.qualifications, 1, 'the look itself qualified');
  eq(mem.confirmed, false, 'but it is not confirmed');
});

test('two qualifying looks 20 minutes apart confirm', () => {
  const t0 = 1_000_000;
  const first = applyScanToLedger(undefined, [row()], cfg(), t0);
  const second = applyScanToLedger(first.ledger, [row()], cfg(), t0 + 20 * MIN);
  eq(second.confirmed.length, 1, 'the second qualifying look confirms');
  eq(second.confirmed[0], BTC, 'the confirmed id is the one that qualified twice');
  const mem = confirmationOf(second.ledger, BTC)!;
  eq(mem.qualifications, 2, 'two qualifications recorded');
  eq(mem.confirmed, true, 'memory says confirmed');
});

test('two looks 1 minute apart are one look triggered twice', () => {
  const t0 = 1_000_000;
  const first = applyScanToLedger(undefined, [row()], cfg(), t0);
  const second = applyScanToLedger(first.ledger, [row()], cfg(), t0 + 1 * MIN);
  eq(second.confirmed.length, 0, 'spacing below the minimum must not confirm');
  eq(
    second.pending[0].reason.includes('distanța minimă'),
    true,
    'the reason names the spacing rule'
  );
});

test('a miss between two qualifications breaks the chain', () => {
  const t0 = 1_000_000;
  const a = applyScanToLedger(undefined, [row()], cfg(), t0);
  // Second look: fell out of the top N.
  const b = applyScanToLedger(a.ledger, [row({ rank: 30 })], cfg(), t0 + 20 * MIN);
  eq(b.confirmed.length, 0, 'a miss cannot confirm');
  eq(confirmationOf(b.ledger, BTC)!.previousQualifiedAt, 0, 'the chain was cleared');
  // Third look qualifies again — this is only the FIRST qualification of a new chain.
  const c = applyScanToLedger(b.ledger, [row()], cfg(), t0 + 40 * MIN);
  eq(c.confirmed.length, 0, 'qualifying again after a miss must not confirm yet');
  eq(confirmationOf(c.ledger, BTC)!.qualifications, 2, 'two qualifications in total so far');
  // Fourth look qualifies: now the last two looks both qualified.
  const d = applyScanToLedger(c.ledger, [row()], cfg(), t0 + 60 * MIN);
  eq(d.confirmed.length, 1, 'the new chain completes on the second consecutive qualification');
});

test('an ineligible look breaks the chain even at rank 1', () => {
  const t0 = 1_000_000;
  const a = applyScanToLedger(undefined, [row()], cfg(), t0);
  const b = applyScanToLedger(a.ledger, [row({ isEligible: false })], cfg(), t0 + 20 * MIN);
  eq(b.confirmed.length, 0, 'an ineligible look cannot confirm');
  eq(confirmationOf(b.ledger, BTC)!.previousQualifiedAt, 0, 'chain cleared by the ineligible look');
});

test('a previous qualification older than maxAge cannot be paired', () => {
  const t0 = 1_000_000;
  const a = applyScanToLedger(undefined, [row()], cfg({ maxAgeMinutes: 180 }), t0);
  const b = applyScanToLedger(a.ledger, [row()], cfg({ maxAgeMinutes: 180 }), t0 + 181 * MIN);
  eq(b.confirmed.length, 0, '181 min > 180 min max age');
  eq(
    b.pending[0].reason.includes('peste limita'),
    true,
    'the reason names the age limit'
  );
});

test('a contract not seen for the TTL is forgotten', () => {
  const t0 = 1_000_000;
  const a = applyScanToLedger(undefined, [row()], cfg({ ttlMinutes: 60 }), t0);
  // A later scan that looks at something else entirely.
  const b = applyScanToLedger(a.ledger, [row({ instId: ETH })], cfg({ ttlMinutes: 60 }), t0 + 61 * MIN);
  eq(confirmationOf(b.ledger, BTC), undefined, 'the stale entry was dropped');
  eq(b.forgotten, 1, 'and counted as forgotten');
  ok(confirmationOf(b.ledger, ETH), 'the fresh entry survived');
});

// ---------------------------------------------------------------------------
// Purity and degenerate input
// ---------------------------------------------------------------------------

test('the input ledger is never mutated', () => {
  const t0 = 1_000_000;
  const first = applyScanToLedger(undefined, [row()], cfg(), t0);
  const snapshot = JSON.stringify(first.ledger);
  applyScanToLedger(first.ledger, [row()], cfg(), t0 + 20 * MIN);
  eq(JSON.stringify(first.ledger), snapshot, 'the first ledger must be untouched');
});

test('an empty scan prunes only and confirms nothing', () => {
  const t0 = 1_000_000;
  const a = applyScanToLedger(undefined, [row()], cfg(), t0);
  const b = applyScanToLedger(a.ledger, [], cfg(), t0 + 20 * MIN);
  eq(b.confirmed.length, 0, 'nothing to confirm');
  eq(b.pending.length, 0, 'nothing pending either');
  ok(confirmationOf(b.ledger, BTC), 'an entry inside the TTL is kept');
});

test('an undefined ledger starts from scratch', () => {
  const res = applyScanToLedger(undefined, [row()], cfg(), 1_000_000);
  eq(Object.keys(res.ledger).length, 1, 'the first scan creates exactly one entry');
});

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

test('defaults match the documented behaviour', () => {
  const c = resolveConfirmationConfig({});
  eq(c.topN, SCAN_CONFIRMATION_DEFAULT_TOP_N, 'default top N');
  eq(c.maxAgeMinutes, SCAN_CONFIRMATION_DEFAULT_MAX_AGE_MINUTES, 'default max age');
  eq(c.minSpacingMinutes, SCAN_CONFIRMATION_DEFAULT_MIN_SPACING_MINUTES, 'default spacing');
});

test('nonsense config falls back instead of disabling the gate', () => {
  const c = resolveConfirmationConfig({
    topN: -3,
    maxAgeMinutes: Number.NaN,
    minSpacingMinutes: -1,
    ttlMinutes: 0,
  });
  eq(c.topN, SCAN_CONFIRMATION_DEFAULT_TOP_N, 'negative top N falls back');
  eq(c.maxAgeMinutes, SCAN_CONFIRMATION_DEFAULT_MAX_AGE_MINUTES, 'NaN age falls back');
  eq(c.minSpacingMinutes, SCAN_CONFIRMATION_DEFAULT_MIN_SPACING_MINUTES, 'negative spacing falls back');
  ok(c.ttlMinutes > 0, 'a TTL of 0 would forget everything; it falls back');
});

test('max age can never exceed the TTL', () => {
  const c = resolveConfirmationConfig({ maxAgeMinutes: 10_000, ttlMinutes: 120 });
  ok(c.maxAgeMinutes <= c.ttlMinutes, 'a pairing window longer than the memory is meaningless');
});

test('spacing can never exceed max age', () => {
  const c = resolveConfirmationConfig({ maxAgeMinutes: 30, minSpacingMinutes: 600 });
  ok(c.minSpacingMinutes <= c.maxAgeMinutes, 'spacing above the age window could never confirm');
});

// ---------------------------------------------------------------------------
// Reasons shown to the operator
// ---------------------------------------------------------------------------

test('the first-look reason says a second scan is needed', () => {
  const t0 = 1_000_000;
  const res = applyScanToLedger(undefined, [row()], cfg(), t0);
  const mem = confirmationOf(res.ledger, BTC)!;
  const reason = explainNotConfirmed(mem, cfg(), t0);
  ok(reason.includes('încă un scan'), `reason must ask for a second scan, got "${reason}"`);
});

test('the out-of-top-N reason names the rank and the limit', () => {
  const t0 = 1_000_000;
  const res = applyScanToLedger(undefined, [row({ rank: 18 })], cfg({ topN: 10 }), t0);
  const mem = confirmationOf(res.ledger, BTC)!;
  const reason = explainNotConfirmed(mem, cfg(), t0);
  ok(reason.includes('#18') && reason.includes('top 10'), `got "${reason}"`);
});

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

const run = async (): Promise<void> => {
  let failed = 0;
  for (const t of registered) {
    try {
      await t.fn();
      console.log(`  ok    ${t.name}`);
    } catch (err: any) {
      failed++;
      console.error(`  FAIL  ${t.name}`);
      console.error(`        ${err?.message || err}`);
    }
  }
  const total = registered.length;
  console.log(`\n${total - failed}/${total} scan-confirmation tests passed`);
  if (failed > 0) process.exitCode = 1;
};

void run();
