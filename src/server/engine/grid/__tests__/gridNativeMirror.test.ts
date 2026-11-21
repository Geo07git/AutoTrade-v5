/**
 * The analyzer journals a STOP from the native mirror row, so the mirror must carry the live
 * counters. These tests pin the mapping that made `grid_irys_mwpcnpqp` record `pnlBreakdown = 0`
 * over 71 completed round-trips and +1.0535 USDT.
 */

import {
  applyLiveCountersToNative,
  isMirroredAlgoId,
  type LiveGridCounters,
} from '../gridNativeMirror';
import type { OKXNativeGridBot } from '../../../../shared/types';

const ok = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(msg);
};

const eq = (actual: unknown, expected: unknown, msg: string): void => {
  if (actual !== expected) {
    throw new Error(`${msg} (expected ${String(expected)}, got ${String(actual)})`);
  }
};

/** The adoption row exactly as `registerFallbackBot` writes it: config only, counters at zero. */
const mirrorRow = (over: Partial<OKXNativeGridBot> = {}): OKXNativeGridBot => ({
  algoId: 'grid_irys_mwpcnpqp',
  instId: 'IRYS-USD_UM_XPERP-310530',
  algoOrdType: 'contract_grid',
  direction: 'neutral',
  environment: 'LIVE',
  state: 'running',
  minPx: 0.01989,
  maxPx: 0.02231,
  gridNum: 16,
  runType: '1',
  lever: 1,
  sz: 38,
  singleAmt: 0,
  currentPx: 0.0211,
  liqPx: 0.00016,
  gridProfit: 0,
  floatProfit: 0,
  totalPnl: 0,
  totalPnlPct: 0,
  arbitrageNum: 0,
  stopLossPct: 12,
  takeProfitPct: 15,
  stopTypeOnRisk: '1',
  stopOnRangeBreakout: true,
  stopOnTrendInvalidation: false,
  cTime: 1_795_191_961_000,
  uTime: 1_795_238_665_959,
  ...over,
});

/** The TB5 row at the moment of that stop. */
const irysLive: LiveGridCounters = {
  gridProfitUSDT: 1.1487,
  floatingPnlUSDT: 0,
  totalNetPnlUSDT: 1.0535,
  totalNetPnlPct: 2.77,
  peakTotalPnlPct: 2.9,
  completedArbitrages: 71,
  currentPrice: 0.01952,
};

const test = (name: string, fn: () => void) => registered.push({ name, fn });
const registered: Array<{ name: string; fn: () => void }> = [];

test('mirror: the IRYS stop row gets the real counters instead of zeros', () => {
  const mirror = mirrorRow();
  const changed = applyLiveCountersToNative(mirror, irysLive);

  eq(changed, true, 'a row full of zeros must report that it learned something');
  eq(mirror.gridProfit, 1.1487, 'capture lands on the row the analyzer journals');
  eq(mirror.floatProfit, 0, 'a flat book is 0, and 0 is a real reading');
  eq(mirror.totalPnl, 1.0535, 'total = capture - exit cost - fees');
  eq(mirror.totalPnlPct, 2.77, 'percent of margin, as the event reports it');
  eq(mirror.arbitrageNum, 71, 'round-trips, not the adoption-time 0');
  eq(mirror.peakTotalPnlPct, 2.9, 'the giveback guard needs the high-water mark');
  eq(mirror.currentPx, 0.01952, 'the price the stop was decided on');
});

test('mirror: configuration is never overwritten by counters', () => {
  const mirror = mirrorRow();
  applyLiveCountersToNative(mirror, irysLive);

  eq(mirror.sz, 38, 'margin invested is configuration');
  eq(mirror.gridNum, 16, 'the ladder size is configuration');
  eq(mirror.minPx, 0.01989, 'the band is configuration');
  eq(mirror.maxPx, 0.02231, 'the band is configuration');
  eq(mirror.lever, 1, 'leverage is configuration');
  eq(mirror.stopOnRangeBreakout, true, 'the stop flags are configuration');
});

test('mirror: a real zero is copied, not treated as unknown', () => {
  // A bot restarted after an exit: the live row is genuinely back at 0. If 0 were read as
  // "no opinion", the previous run's profit would sit on the mirror forever.
  const mirror = mirrorRow({ gridProfit: 9.99, totalPnl: 9.99, arbitrageNum: 400 });
  applyLiveCountersToNative(mirror, {
    gridProfitUSDT: 0,
    totalNetPnlUSDT: 0,
    completedArbitrages: 0,
  });

  eq(mirror.gridProfit, 0, 'zero capture is a fact');
  eq(mirror.totalPnl, 0, 'zero total is a fact');
  eq(mirror.arbitrageNum, 0, 'zero round-trips is a fact');
});

test('mirror: unmeasured fields are skipped instead of clobbering the row', () => {
  const mirror = mirrorRow({ gridProfit: 0.5, arbitrageNum: 7, currentPx: 0.02, peakTotalPnlPct: 1.2 });
  const changed = applyLiveCountersToNative(mirror, {
    gridProfitUSDT: undefined,
    completedArbitrages: Number.NaN,
    currentPrice: 0,
    peakTotalPnlPct: undefined,
  });

  eq(changed, false, 'nothing measured, nothing written');
  eq(mirror.gridProfit, 0.5, 'NaN must not become a number');
  eq(mirror.arbitrageNum, 7, 'NaN must not become 0');
  eq(mirror.currentPx, 0.02, 'price 0 means "not measured", never "the price is zero"');
  eq(mirror.peakTotalPnlPct, 1.2, 'a missing peak leaves the known high-water mark alone');
});

test('mirror: only rows this app created are mirrored', () => {
  // OKX's own native grid algos report their counters; ours must not overwrite them.
  const native = mirrorRow({ algoId: '1234567890', gridProfit: 3, arbitrageNum: 12 });
  const changed = applyLiveCountersToNative(native, irysLive);

  eq(changed, false, 'a venue algo id is not ours');
  eq(native.gridProfit, 3, 'its counters stay as the venue reported them');
  eq(native.arbitrageNum, 12, 'and so do its round-trips');

  eq(isMirroredAlgoId('grid_irys_mwpcnpqp'), true, 'TB5 bot ids start with "grid"');
  eq(isMirroredAlgoId('GRID_X'), true, 'case-insensitively');
  eq(isMirroredAlgoId(''), false, 'an empty id is not a bot');
  eq(isMirroredAlgoId(null), false, 'and null is not an id');
});

test('mirror: repeating the sync is free and never double-counts', () => {
  const mirror = mirrorRow();
  eq(applyLiveCountersToNative(mirror, irysLive), true, 'the first pass writes');
  eq(applyLiveCountersToNative(mirror, irysLive), false, 'the second pass finds nothing to do');
  eq(mirror.totalPnl, 1.0535, 'and the value is still the live one, not a sum');
});

const run = () => {
  let failed = 0;
  for (const t of registered) {
    try {
      t.fn();
      console.log(`  ok    ${t.name}`);
    } catch (err: any) {
      failed++;
      console.error(`  FAIL  ${t.name}`);
      console.error(`        ${err?.message || err}`);
    }
  }
  const total = registered.length;
  console.log(`\n${total - failed}/${total} grid-native-mirror tests passed`);
  if (failed > 0) process.exitCode = 1;
};

void run();
export { ok };
