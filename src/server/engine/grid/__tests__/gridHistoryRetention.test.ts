/**
 * Contract tests for grid history retention.
 *
 * The failure these tests exist for: `saveBots()` overwrites `grid_bots.json` with whatever the
 * engine still holds, so a bot that leaves the list takes its row, its accounting and its share
 * of the desk totals with it. On 2026-11-15 a single click on "clear stopped" removed 100+ bots
 * from the desk with no dialog and no copy left anywhere.
 *
 * Two guarantees are pinned here:
 *   1. `mergeBotsIntoArchive` is append-only — a bot that leaves the list stays in the archive.
 *   2. The retention caps are wide enough that a desk with hundreds of bots does not silently
 *      lose its per-round-trip record to a 500-entry ring buffer.
 *
 * Pure functions only: no store, no `.data`, no clock.
 *
 * Run: npm test
 */

import {
  GRID_ARBITRAGE_MAX_EVENTS,
  GRID_AUDIT_MAX_EVENTS,
  mergeBotsIntoArchive,
  type ArchivedGridBot,
} from '../GridJournal';
import type { GridBotInstance } from '../../../../shared/types';

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
const NOW = 1_800_000_000_000;

/** A terminal bot; only the fields retention cares about are spelled out. */
const botOf = (over: Partial<GridBotInstance> = {}): GridBotInstance =>
  ({
    botId: 'grid_near_test1',
    symbol: 'NEAR-USD_UM_XPERP-310613',
    platform: 'OKX',
    executionMode: 'LIVE',
    status: 'STOPPED',
    createdAt: 1_000,
    updatedAt: 2_000,
    initialCenterPrice: 3.1,
    currentPrice: 3.13,
    gridSpacingUSDT: 0.01,
    gridSpacingPct: 0.33,
    estimatedProfitPerGridPct: 0.33,
    estimatedLiquidationPriceLong: 0,
    estimatedLiquidationPriceShort: 0,
    lowerStopPrice: 2.989,
    upperStopPrice: 3.175,
    levels: [],
    totalNotionalUSDT: 12,
    netPositionContracts: 0,
    netPositionSide: 'FLAT',
    avgHoldPrice: 0,
    gridCaptureUSDT: 0.22,
    exitCostUSDT: 0,
    gridProfitUSDT: 0.22,
    floatingPnlUSDT: 0,
    totalFeesUSDT: 0.0035,
    completedArbitrages: 2,
    activeBuyOrders: 0,
    activeSellOrders: 0,
    ...over,
  } as unknown as GridBotInstance);

const archiveOf = (...bots: ArchivedGridBot[]): Record<string, ArchivedGridBot> =>
  Object.fromEntries(bots.map((b) => [b.botId, b]));

// ---------------------------------------------------------------------------
// 1. Append-only
// ---------------------------------------------------------------------------
test('a running bot is not archived (it already lives in grid_bots.json)', () => {
  const archive: Record<string, ArchivedGridBot> = {};
  const changed = mergeBotsIntoArchive(archive, [botOf({ status: 'RUNNING' })], NOW);
  eq(changed, false, 'a running bot must not write the archive on every flush');
  eq(Object.keys(archive).length, 0, 'nothing archived');
});

test('a stopped bot is archived with its accounting intact', () => {
  const archive: Record<string, ArchivedGridBot> = {};
  const changed = mergeBotsIntoArchive(
    archive,
    [botOf({ status: 'STOPPED', gridProfitUSDT: 0.22, completedArbitrages: 2 })],
    NOW
  );
  eq(changed, true, 'a terminal bot is archived');
  const entry = archive['grid_near_test1'];
  ok(entry, 'the bot is in the archive');
  eq(entry.gridProfitUSDT, 0.22, 'grid capture survives');
  eq(entry.completedArbitrages, 2, 'arbitrage count survives');
  eq(entry.archivedAt, NOW, 'the snapshot is timestamped');
});

test('removing a row from the incoming list does NOT remove it from the archive', () => {
  const kept = botOf({ botId: 'grid_keep', updatedAt: 3_000 });
  const deleted = botOf({ botId: 'grid_gone', updatedAt: 3_000 });
  const archive: Record<string, ArchivedGridBot> = {};
  mergeBotsIntoArchive(archive, [kept, deleted], NOW);

  // This is what `deleteStoppedBot` used to do: hand back a list that no longer contains it.
  mergeBotsIntoArchive(archive, [kept], NOW + 1_000);

  ok(archive['grid_gone'], 'the deleted bot is still in the archive');
  eq(archive['grid_gone'].gridProfitUSDT, 0.22, 'and its PnL is unchanged');
  eq(Object.keys(archive).length, 2, 'the archive only grows');
});

test('an older snapshot never overwrites a newer one', () => {
  const archive: Record<string, ArchivedGridBot> = {};
  mergeBotsIntoArchive(archive, [botOf({ updatedAt: 5_000, gridProfitUSDT: 0.4 })], NOW);
  const changed = mergeBotsIntoArchive(
    archive,
    [botOf({ updatedAt: 4_000, gridProfitUSDT: 0.1 })],
    NOW + 1_000
  );
  eq(changed, false, 'a stale snapshot is ignored');
  eq(archive['grid_near_test1'].gridProfitUSDT, 0.4, 'the newer capture is preserved');
});

test('a soft delete is captured as a new snapshot (so the flag is not lost on restart)', () => {
  const archive: Record<string, ArchivedGridBot> = {};
  mergeBotsIntoArchive(archive, [botOf({ updatedAt: 5_000 })], NOW);
  eq(archive['grid_near_test1'].deletedAt, undefined, 'not deleted yet');

  const changed = mergeBotsIntoArchive(
    archive,
    [botOf({ updatedAt: 5_000, deletedAt: 6_000 })],
    NOW + 1_000
  );
  eq(changed, true, 'the same updatedAt but a new deletedAt still counts as a change');
  eq(archive['grid_near_test1'].deletedAt, 6_000, 'the delete is recorded');
});

// ---------------------------------------------------------------------------
// 2. Retention caps
// ---------------------------------------------------------------------------
test('the arbitrage cap covers 100+ bots, not one day of trading', () => {
  // 500 entries was the old cap: on a desk with hundreds of bots that is a rounding error, and
  // it is the only per-round-trip record that survives a row being deleted.
  ok(
    GRID_ARBITRAGE_MAX_EVENTS >= 100 * 50,
    `cap must hold ~50 round trips for 100+ bots (got ${GRID_ARBITRAGE_MAX_EVENTS})`
  );
});

test('the audit cap is not a 500-line ring buffer', () => {
  ok(
    GRID_AUDIT_MAX_EVENTS > 500,
    `the audit trail must outlive one day of trading (got ${GRID_AUDIT_MAX_EVENTS})`
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
