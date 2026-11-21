/**
 * Regression suite for the EXIT DEFERRAL guard (`gridInventoryGuard.ts`).
 *
 * The case that made this necessary is `grid_pieverse_mwk05tlp` (`grid-case-grid-pieverse-…json`):
 * created 01:17, stopped 09:18, 8 completed arbitrages, `gridCaptureUSDT` +0.992, `totalFeesUSDT`
 * 0.0894, ONE forced exit costing -1.048 -> net -0.1454. The stop was
 * `[Stagnation STOP Anticipat @120m]` with ADX 27.4 / Chop 30.1 / 11.9% from the band edge, at a
 * price (1.8889) still well inside the band [1.8608 .. 2.0962] and 6.6% above the hard stop
 * (1.7715). In other words: a profitable session was converted into a loss by the exit policy, not
 * by the grid and not by the market.
 *
 * These tests pin the rule that prevents it, plus the escapes that keep the rule from becoming
 * captivity (breakout, expiry, no inventory, nothing banked).
 *
 * Run: npm test
 */

import { assessInventoryAction, FREEZE_DEFAULTS } from '../gridInventoryGuard';
import type { InventoryGuardInput } from '../gridInventoryGuard';

// ---------------------------------------------------------------------------
// Runner & assertions (same shape as the rest of the suite)
// ---------------------------------------------------------------------------
const tests: { name: string; fn: () => void | Promise<void> }[] = [];
const test = (name: string, fn: () => void | Promise<void>): void => {
  tests.push({ name, fn });
};

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
/** PIEVERSE at the moment the analyzer asked to close it. */
const pieverse = (over: Partial<InventoryGuardInput> = {}): InventoryGuardInput => ({
  px: 1.8889,
  minPx: 1.8608,
  maxPx: 2.0962,
  netContracts: 2,
  netSide: 'LONG',
  minutesSinceLastFill: 120,
  netRealizedAfterCostsUSDT: 0.9014, // capture 0.992 - fees 0.0894, before the forced exit
  floatingPnlUSDT: -1.0475, // what the market close actually realized
  closeFeeEstimateUSDT: 0.0005,
  ...over,
});

/** A healthy, active bot: nothing to defer, nothing to freeze. */
const active = (over: Partial<InventoryGuardInput> = {}): InventoryGuardInput => ({
  px: 100,
  minPx: 94,
  maxPx: 106,
  netContracts: 5,
  netSide: 'LONG',
  minutesSinceLastFill: 3,
  netRealizedAfterCostsUSDT: 0.4,
  floatingPnlUSDT: -0.1,
  closeFeeEstimateUSDT: 0.01,
  ...over,
});

// ---------------------------------------------------------------------------
// 1. The case that started it
// ---------------------------------------------------------------------------
test('PIEVERSE: closing would turn a +0.90 session into a -0.15 loss -> FREEZE, never close', () => {
  const v = assessInventoryAction(pieverse());
  eq(v.action, 'FREEZE_BUYS', 'the exit must be converted into a buy-ladder freeze');
  eq(v.deferExit, true, 'the caller must be told not to close');
  eq(v.hasInventory, true, '2 contracts of inventory were being held');
  eq(v.bankedCoversExit, false, 'the floating loss eats the banked profit');
  ok(/profitul bancat/i.test(v.reason), `reason must name the giveaway: ${v.reason}`);
});

test('PIEVERSE: the same bot one step later, after the freeze was applied, stays frozen and defers', () => {
  const v = assessInventoryAction(
    pieverse({ frozenFromPx: 1.8889, frozenForMinutes: 30, minutesSinceLastFill: 150 })
  );
  eq(v.action, 'NONE', 'a standing freeze must not be re-applied every tick');
  eq(v.deferExit, true, 'a frozen bot must still not be dumped');
});

test('PIEVERSE: a bounce past the freeze level releases the ladder (no re-arm of a new freeze)', () => {
  const frozenFrom = 1.8889;
  const bounce = frozenFrom * (1 + FREEZE_DEFAULTS.releaseGainPct / 100) + 1e-6;
  const v = assessInventoryAction(
    pieverse({
      px: bounce,
      frozenFromPx: frozenFrom,
      frozenForMinutes: 40,
      minutesSinceLastFill: 160,
    })
  );
  eq(v.action, 'RELEASE_FREEZE', 'a move of one grid step means the tape works again');
});

test('PIEVERSE: a fresh fill releases the freeze even at an unchanged price', () => {
  const v = assessInventoryAction(
    pieverse({ frozenFromPx: 1.8889, frozenForMinutes: 20, minutesSinceLastFill: 2 })
  );
  eq(v.action, 'RELEASE_FREEZE', 'oscillation resumed -> the buy ladder must re-arm');
});

test('PIEVERSE: the freeze cannot outlive its backstop (90m), then the close is allowed', () => {
  const v = assessInventoryAction(
    pieverse({
      frozenFromPx: 1.8889,
      frozenForMinutes: FREEZE_DEFAULTS.maxFreezeMinutes,
      minutesSinceLastFill: 210,
    })
  );
  eq(v.action, 'ALLOW_CLOSE', 'capital must never be captured by a freeze nobody lifts');
  eq(v.deferExit, false, 'an expired freeze no longer blocks the exit');
  eq(v.freezeExpired, true, 'the verdict must report why');
});

// ---------------------------------------------------------------------------
// 2. The escapes — the guard must never hold a position the market invalidated
// ---------------------------------------------------------------------------
test('price below the band edge -> close is legitimate, no freeze', () => {
  const v = assessInventoryAction(pieverse({ px: 1.85 }));
  eq(v.action, 'ALLOW_CLOSE', 'outside the band the grid thesis is gone');
  eq(v.deferExit, false, 'nothing to protect outside the band');
});

test('price above the band edge -> close is legitimate, no freeze', () => {
  const v = assessInventoryAction(pieverse({ px: 2.1 }));
  eq(v.action, 'ALLOW_CLOSE', 'outside the band the grid thesis is gone');
});

test('confirmed breakout -> close even with price technically inside the band', () => {
  const v = assessInventoryAction(pieverse({ breakoutConfirmed: true }));
  eq(v.action, 'ALLOW_CLOSE', 'a confirmed breakout outranks the freeze');
  eq(v.deferExit, false, 'a broken band must not be defended with inventory');
});

test('flat book -> nothing to unwind, nothing to freeze', () => {
  const v = assessInventoryAction(
    pieverse({ netContracts: 0, netSide: 'FLAT', floatingPnlUSDT: 0 })
  );
  eq(v.action, 'NONE', 'a dead bot with no inventory may be closed on the normal rules');
  eq(v.deferExit, false, 'zero inventory means zero exit cost');
  eq(v.hasInventory, false, 'the verdict must say so');
});

test('nothing banked -> the stagnation stop keeps its original meaning', () => {
  const v = assessInventoryAction(
    pieverse({ netRealizedAfterCostsUSDT: -0.35, floatingPnlUSDT: -0.5 })
  );
  eq(v.action, 'ALLOW_CLOSE', 'no earned profit to hand back');
  eq(v.deferExit, false, 'deferral exists to protect profit, not to hide a loser');
});

test('banked profit still covers the exit -> close (it banks something)', () => {
  const v = assessInventoryAction(
    pieverse({ netRealizedAfterCostsUSDT: 3, floatingPnlUSDT: -0.2 })
  );
  eq(v.action, 'ALLOW_CLOSE', 'closing at +2.8 is not a giveaway');
  eq(v.bankedCoversExit, true, 'the verdict must say the exit is covered');
});

// ---------------------------------------------------------------------------
// 3. It must stay quiet on healthy bots
// ---------------------------------------------------------------------------
test('active bot: no freeze, no deferral', () => {
  const v = assessInventoryAction(active());
  eq(v.action, 'NONE', 'a bot that fills every few minutes needs no protection');
  eq(v.deferExit, false, 'nothing to defer');
});

test('stagnant but profitable bot, inside the band -> freeze (the PIEVERSE shape, generic)', () => {
  const v = assessInventoryAction(active({ minutesSinceLastFill: 100, floatingPnlUSDT: -0.9 }));
  eq(v.action, 'FREEZE_BUYS', 'the ladder stops accumulating, the sells keep working');
  eq(v.deferExit, true, 'the close would hand back the banked profit');
});

test('short inventory behaves like long inventory (the rule is side-agnostic)', () => {
  const v = assessInventoryAction(
    active({ netSide: 'SHORT', netContracts: -5, minutesSinceLastFill: 100, floatingPnlUSDT: -0.9 })
  );
  eq(v.action, 'FREEZE_BUYS', 'a short book is unwound by the buys, but the rule is the same');
});

test('frozenForMinutes without a frozen price is not a standing freeze', () => {
  const v = assessInventoryAction(
    active({ minutesSinceLastFill: 100, floatingPnlUSDT: -0.9, frozenForMinutes: 20 })
  );
  eq(v.action, 'FREEZE_BUYS', 'minutes alone never count as a freeze; the ladder is frozen fresh');
  eq(v.deferExit, true, 'and the exit is deferred for the same reason as any other freeze');
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ok  ${t.name}`);
    } catch (err: any) {
      failed++;
      console.error(`  FAIL ${t.name}\n       ${err?.message || err}`);
    }
  }
  console.log(`\ngridInventoryGuard: ${tests.length - failed}/${tests.length} passed`);
  if (failed > 0) process.exit(1);
})();
