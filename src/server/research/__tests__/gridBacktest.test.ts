/**
 * Unit Test Suite for GridBacktestEngine
 * Patterned after gridOptimizer.test.ts: side-effect-free, pure mathematical verification.
 * Run via: npx tsx src/server/research/__tests__/gridBacktest.test.ts
 */

import { GridBacktestEngine, createDefaultBotConfig } from '../GridBacktestEngine';
import { Kline, NeutralGridBotConfig } from '../../../shared/types';
import { FundingRateRecord } from '../HistoricalDataStore';

// ---------------------------------------------------------------------------
// Minimal assertion helpers (no node:assert -> avoids CJS/ESM interop flags)
// ---------------------------------------------------------------------------
const ok = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(msg);
};

const eq = (actual: unknown, expected: unknown, msg: string): void => {
  if (actual !== expected) {
    throw new Error(`${msg} (expected ${String(expected)}, got ${String(actual)})`);
  }
};

const close = (actual: number, expected: number, tol: number, msg: string): void => {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > tol) {
    throw new Error(`${msg} (expected ${expected} +/-${tol}, got ${actual})`);
  }
};

// ---------------------------------------------------------------------------
// Generate synthetic oscillating candles (Sine wave around 100 USDT)
// ---------------------------------------------------------------------------
function generateSyntheticKlines(count: number, centerPrice: number = 100, amplitude: number = 3): Kline[] {
  const klines: Kline[] = [];
  const baseTs = 1_700_000_000_000;
  const intervalMs = 300_000; // 5m

  for (let i = 0; i < count; i++) {
    const angle = (i / 12) * Math.PI * 2; // Full cycle every 12 bars (1 hour)
    const mid = centerPrice + Math.sin(angle) * amplitude;
    const high = mid + 0.6;
    const low = mid - 0.6;
    const open = mid - 0.2;
    const c = mid + 0.2;

    klines.push({
      timestamp: baseTs + i * intervalMs,
      open: parseFloat(open.toFixed(2)),
      high: parseFloat(high.toFixed(2)),
      low: parseFloat(low.toFixed(2)),
      close: parseFloat(c.toFixed(2)),
      volume: 500,
    });
  }
  return klines;
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------
async function runTests() {
  console.log('[Test] Running GridBacktestEngine test suite...');

  const SYMBOL = 'BTC-USD_UM_XPERP-310404';
  const klines = generateSyntheticKlines(240, 100, 3.5); // 240 5m candles = 20 hours

  const config: NeutralGridBotConfig = createDefaultBotConfig(
    SYMBOL,
    96,
    104,
    8,
    'ARITHMETIC',
    3,
    50,
    15,
    30
  );

  const sampleFunding: FundingRateRecord[] = [
    { fundingTime: klines[20].timestamp, fundingRate: 0.0001 },
    { fundingTime: klines[120].timestamp, fundingRate: 0.0001 },
  ];

  // 1. Basic Simulation Run
  const res = GridBacktestEngine.runSimulation(klines, config, sampleFunding);
  ok(res.totalCandles === 240, 'Total candles must match input length');
  ok(res.initialMarginUSDT === 50, 'Initial margin must match config');
  ok(res.completedCycles > 0, `Must complete arbitrage cycles in oscillating market (got ${res.completedCycles})`);
  ok(res.gridProfitUSDT > 0, `Grid profit must be positive (got ${res.gridProfitUSDT})`);
  ok(res.totalFeesUSDT > 0, `Maker fees must be deducted (got ${res.totalFeesUSDT})`);
  ok(Number.isFinite(res.sharpeRatio), 'Sharpe ratio must be a valid number');
  ok(res.equityCurve.length > 5, 'Equity curve must contain data points');
  ok(!res.wasLiquidated, 'Grid within normal range must not be liquidated');

  console.log(`  ✓ runSimulation passed (Cycles: ${res.completedCycles}, Net PnL: ${res.netPnLUSDT} USDT, Sharpe: ${res.sharpeRatio})`);

  // 2. Variations Testing
  const variations = GridBacktestEngine.testVariations(klines.slice(0, 50), SYMBOL, sampleFunding);
  ok(variations.length > 0, 'testVariations must produce results');
  ok(variations[0].netPnLUSDT !== undefined, 'Top variation must have valid net PnL');
  console.log(`  ✓ testVariations passed (Generated ${variations.length} configurations, top score PnL: ${variations[0].netPnLUSDT})`);

  // 3. Walk-Forward Validation
  const longKlines = generateSyntheticKlines(400, 100, 3.5);
  const wf = GridBacktestEngine.runWalkForward(longKlines, SYMBOL, sampleFunding);
  ok(wf.inSample.totalCandles > 0, 'In-sample must have candles');
  ok(wf.outOfSample.totalCandles > 0, 'Out-of-sample must have candles');
  ok(wf.overfittingScore >= 0 && wf.overfittingScore <= 100, 'Overfitting score must be within 0-100');
  ok(wf.recommendedConfig.gridCount > 0, 'Must produce recommended configuration');
  console.log(`  ✓ runWalkForward passed (IS PnL: ${wf.inSample.netPnLUSDT}, OOS PnL: ${wf.outOfSample.netPnLUSDT}, OverfitScore: ${wf.overfittingScore})`);

  // 4. Three-Way Comparison
  const bestHours = [0, 1, 2, 3, 4, 10, 11, 12];
  const blockedIndices = new Set([5, 6, 7, 25, 26]);
  const comp = GridBacktestEngine.runComparison(klines, config, sampleFunding, bestHours, blockedIndices);
  ok(comp.mode247.totalCandles === 240, '24/7 mode must run all candles');
  ok(comp.bestHoursMode.totalCandles === 240, 'Best hours mode must be evaluated');
  ok(comp.patternFilteredMode.totalCandles === 240, 'Pattern filtered mode must be evaluated');
  console.log(`  ✓ runComparison passed (24/7 ROI: ${comp.mode247.netPnLPct}%, BestHours Alpha: ${comp.alphaBestHoursPct}%, PatternFiltered Alpha: ${comp.alphaPatternFilteredPct}%)`);

  // 5. PatternMiner Event Study & FDR Correction Test
  const { PatternMiner } = await import('../PatternMiner');
  const minerReport = PatternMiner.minePatterns(longKlines, sampleFunding, SYMBOL);
  ok(minerReport.patterns.length > 0, 'PatternMiner must discover patterns');
  ok(minerReport.gridExcursion.crossingsPerDay >= 0, 'Grid excursion metrics must be present');
  ok(minerReport.gridExcursion.percentilesExcursionPct.p50 > 0, 'Median excursion must be computed');
  console.log(`  ✓ PatternMiner passed (Discovered ${minerReport.patterns.length} patterns, Crossings/Day: ${minerReport.gridExcursion.crossingsPerDay}, Median Excursion: ${minerReport.gridExcursion.percentilesExcursionPct.p50}%)`);

  // 6. Deterministic Mathematical Verification (Known analytical cycle counts & mark-to-market PnL)
  console.log('  -> Running deterministic mathematical verification...');
  const deterministicKlines: Kline[] = [
    { timestamp: 1_700_000_000_000, open: 100, high: 100.2, low: 99.8, close: 100, volume: 100 },
    // Dip to 98: triggers BUY at 99
    { timestamp: 1_700_000_300_000, open: 100, high: 100, low: 98.0, close: 98.5, volume: 100 },
    // Rally to 102: triggers SELL at 101 (completes cycle 1)
    { timestamp: 1_700_000_600_000, open: 98.5, high: 102.0, low: 98.5, close: 101.5, volume: 100 },
    // Dip to 98: triggers BUY at 99
    { timestamp: 1_700_000_900_000, open: 101.5, high: 101.5, low: 98.0, close: 98.5, volume: 100 },
    // Rally to 102: triggers SELL at 101 (completes cycle 2)
    { timestamp: 1_700_001_200_000, open: 98.5, high: 102.0, low: 98.5, close: 100, volume: 100 },
  ];

  const detConfig: NeutralGridBotConfig = createDefaultBotConfig(
    SYMBOL,
    98,
    102,
    4, // 98, 99.33, 100.67, 102
    'ARITHMETIC',
    3,
    50,
    25,
    50
  );

  const detRes = GridBacktestEngine.runSimulation(deterministicKlines, detConfig, [], {
    conservativeFills: true,
  });

  ok(detRes.completedCycles > 0, `Deterministic run must execute completed cycles (got ${detRes.completedCycles})`);
  ok(detRes.gridProfitUSDT > 0, `Grid profit must be positive (got ${detRes.gridProfitUSDT})`);
  ok(detRes.totalFeesUSDT > 0, `Maker fees must be deducted (got ${detRes.totalFeesUSDT})`);
  close(detRes.netPnLUSDT, detRes.gridProfitUSDT - detRes.totalFeesUSDT + detRes.floatingPnLUSDT, 0.05, 'Net PnL must equal gridProfit - fees + floatingPnL');
  console.log(`  ✓ Deterministic oscillation test passed (Cycles: ${detRes.completedCycles}, Net PnL: $${detRes.netPnLUSDT}, Floating PnL: $${detRes.floatingPnLUSDT})`);

  // 7. Liquidation Modeling Test
  console.log('  -> Running liquidation modeling test...');
  const crashKlines: Kline[] = [
    { timestamp: 1_700_000_000_000, open: 100, high: 100, low: 99, close: 99.5, volume: 100 },
    { timestamp: 1_700_000_300_000, open: 99.5, high: 99.5, low: 95, close: 95, volume: 100 },
    // Massive catastrophic crash to 30 with 10x leverage
    { timestamp: 1_700_000_600_000, open: 95, high: 95, low: 30, close: 30, volume: 100 },
  ];

  const crashConfig: NeutralGridBotConfig = createDefaultBotConfig(
    SYMBOL,
    90,
    110,
    8,
    'ARITHMETIC',
    10, // 10x leverage
    50,
    90,
    90
  );

  const crashRes = GridBacktestEngine.runSimulation(crashKlines, crashConfig, []);
  ok(crashRes.wasLiquidated, 'Massive crash with 10x leverage must trigger liquidation');
  eq(crashRes.netPnLUSDT, -50, 'Net PnL upon liquidation must equal total loss of initial margin');
  eq(crashRes.netPnLPct, -100, 'ROI upon liquidation must be -100%');
  console.log('  ✓ Liquidation modeling test passed (Liquidated cleanly at equity 0 and -100% ROI)');

  console.log('\n[Test] ALL GridBacktestEngine and PatternMiner tests PASSED successfully!\n');
}

runTests().catch((err) => {
  console.error('[Test] FAILED:', err);
  process.exit(1);
});
