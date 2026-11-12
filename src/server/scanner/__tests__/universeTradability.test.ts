/**
 * Regression suite for universe tradability (`UniverseManager`).
 *
 * All offline: the predicate is pure and takes the venue's own `instCategory`, so these tests
 * pin the ONE decision that separates "a contract this desk may trade" from "a tokenized stock"
 * without a network call.
 *
 * Run: npm test
 */

import {
  NON_CRYPTO_INST_CATEGORIES,
  isTokenizedRealWorldInstrument,
  isTradableXPerp,
} from '../UniverseManager';

// ---------------------------------------------------------------------------
// Tiny runner (same pattern as deepSeekAgent.test.ts)
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
// The venue's taxonomy, as measured on EEA on 2026-11-12
// ---------------------------------------------------------------------------

test('categories: the venue taxonomy is crypto vs tokenized real-world assets', () => {
  // 167 crypto, 92 stocks, 4 metals out of 263 live `_UM_XPERP` contracts.
  eq(isTokenizedRealWorldInstrument('1'), false, 'category 1 is crypto');
  eq(isTokenizedRealWorldInstrument('3'), true, 'category 3 is a tokenized stock');
  eq(isTokenizedRealWorldInstrument('4'), true, 'category 4 is a metal/commodity (XAU, BZ, CL, XAG)');
  eq(isTokenizedRealWorldInstrument('5'), true, 'category 5 must be excluded the day OKX adds it');
  eq(isTokenizedRealWorldInstrument('6'), true, 'category 6 must be excluded the day OKX adds it');
  eq(isTokenizedRealWorldInstrument('7'), true, 'category 7 must be excluded the day OKX adds it');
});

test('categories: the exclusion set is exactly the non-crypto categories', () => {
  ok(NON_CRYPTO_INST_CATEGORIES.has('3'), 'stocks must be in the set');
  ok(!NON_CRYPTO_INST_CATEGORIES.has('1'), 'crypto must never be in the set');
  eq(NON_CRYPTO_INST_CATEGORIES.size, 5, '3, 4, 5, 6, 7 — and nothing else');
});

test('categories: numeric and whitespace-typed values are still recognised', () => {
  // The REST payload is string-typed, but a JSON round-trip through a cache may hand us a number.
  eq(isTokenizedRealWorldInstrument(3), true, 'a numeric 3 is still a stock');
  eq(isTokenizedRealWorldInstrument(' 3 '), true, 'padded input must not slip through');
  eq(isTokenizedRealWorldInstrument(1), false, 'a numeric 1 is still crypto');
});

test('categories: an ABSENT category is treated as crypto', () => {
  // Fail-open on missing metadata on purpose: silently dropping a real contract is worse than
  // listing a questionable one, and the venue always sets `instCategory` on `_UM_XPERP`.
  eq(isTokenizedRealWorldInstrument(undefined), false, 'undefined is not a stock');
  eq(isTokenizedRealWorldInstrument(null), false, 'null is not a stock');
  eq(isTokenizedRealWorldInstrument(''), false, 'an empty string is not a stock');
  eq(isTokenizedRealWorldInstrument('garbage'), false, 'an unknown value is not a stock');
});

// ---------------------------------------------------------------------------
// The full tradability predicate
// ---------------------------------------------------------------------------

const inst = (over: Record<string, unknown> = {}) => ({
  state: 'live',
  instId: 'BTC-USD_UM_XPERP-310404',
  instCategory: '1',
  ...over,
});

test('tradability: a live crypto X-Perp is tradable', () => {
  eq(isTradableXPerp(inst()), true, 'BTC crypto X-Perp must be tradable');
  eq(isTradableXPerp(inst({ instId: 'SUI-USD_UM_XPERP-310404' })), true, 'SUI must be tradable');
});

test('tradability: tokenized stocks are refused, whatever their symbol looks like', () => {
  // These are the real ids that were ranked into the agent pool before the exclusion.
  const stocks = [
    'NVDA-USD_UM_XPERP-310613',
    'AAPL-USD_UM_XPERP-310613',
    'AMD-USD_UM_XPERP-310613',
    'MSTR-USD_UM_XPERP-310704',
    'COIN-USD_UM_XPERP-310613',
    'SPCX-USD_UM_XPERP-310613',
    'SOXL-USD_UM_XPERP-310627',
    'PIEVERSE-USD_UM_XPERP-310822',
  ];
  for (const instId of stocks) {
    eq(
      isTradableXPerp(inst({ instId, instCategory: '3' })),
      false,
      `${instId} is a tokenized stock and must never reach the scan`
    );
  }
});

test('tradability: metals and commodities are refused too, not just stocks', () => {
  for (const instId of [
    'XAU-USD_UM_XPERP-310613',
    'XAG-USD_UM_XPERP-310613',
    'BZ-USD_UM_XPERP-310613',
    'CL-USD_UM_XPERP-310613',
  ]) {
    eq(
      isTradableXPerp(inst({ instId, instCategory: '4' })),
      false,
      `${instId} is a metal/commodity, not crypto`
    );
  }
});

test('tradability: category alone cannot smuggle in a non-tradable instrument', () => {
  eq(
    isTradableXPerp(inst({ state: 'suspend' })),
    false,
    'a suspended contract must stay out even with a crypto category'
  );
  eq(
    isTradableXPerp(inst({ instId: 'BTC-USDT-SWAP', instCategory: '1' })),
    false,
    'a non-X-Perp contract must stay out even with a crypto category'
  );
  eq(isTradableXPerp({}), false, 'an empty descriptor is not tradable');
});

test('universe split: the mixed venue list keeps exactly the crypto contracts', () => {
  // 6 crypto + 3 stocks + 1 metal, mirroring the real 263/167/92/4 shape.
  const venue = [
    inst({ instId: 'BTC-USD_UM_XPERP-310404' }),
    inst({ instId: 'ETH-USD_UM_XPERP-310404' }),
    inst({ instId: 'SOL-USD_UM_XPERP-310404' }),
    inst({ instId: 'SUI-USD_UM_XPERP-310404' }),
    inst({ instId: 'HYPE-USD_UM_XPERP-310523' }),
    inst({ instId: 'LINK-USD_UM_XPERP-310523' }),
    inst({ instId: 'NVDA-USD_UM_XPERP-310613', instCategory: '3' }),
    inst({ instId: 'AAPL-USD_UM_XPERP-310613', instCategory: '3' }),
    inst({ instId: 'COIN-USD_UM_XPERP-310613', instCategory: '3' }),
    inst({ instId: 'XAU-USD_UM_XPERP-310613', instCategory: '4' }),
  ];

  const kept = venue.filter(isTradableXPerp).map((i) => String(i.instId));
  eq(kept.length, 6, 'only the six crypto contracts survive');
  ok(!kept.some((id) => id.startsWith('NVDA')), 'NVDA must not survive');
  ok(!kept.some((id) => id.startsWith('XAU')), 'XAU must not survive');
  ok(kept.includes('BTC-USD_UM_XPERP-310404'), 'BTC must survive');
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
  console.log(`\n${total - failed}/${total} universe-tradability tests passed`);
  if (failed > 0) process.exitCode = 1;
};

void run();
