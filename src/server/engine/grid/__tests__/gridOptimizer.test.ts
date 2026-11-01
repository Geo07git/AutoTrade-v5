/**
 * Regression suite for the Neutral Grid execution path.
 *
 * Replaces the obsolete `scalpStrategy.test.ts` reference (the scalp/momentum engine
 * was removed in 578d929 and that test file never existed in this repository's history).
 *
 * Covers only pure, side-effect-free code -- no network, no OKXAdapter, no filesystem:
 *   - GridOptimizer.autoOptimizeParameters  (band clamps, gridCount parity, leverage tiers)
 *   - GridOptimizer.calculateGrid           (level geometry, strict maker-fee gate, liq/stop bounds)
 *   - MartingaleEngine                      (level weights, exposure ceiling)
 *   - NeutralGridAnalyzer.computeWilderAdx14 (Wilder smoothing, clamp bounds)
 *
 * Run: npm test
 */

import { GridOptimizer } from '../GridOptimizer';
import {
  buildGridRangeVariants,
  selectActiveRangeVariant,
  type GridRangeVariantContext,
} from '../GridRangeVariants';
import { MartingaleEngine } from '../MartingaleEngine';
import { NeutralGridAnalyzer } from '../NeutralGridAnalyzer';
import type { InstrumentLotFilter } from '../../../exchange/IExecutionAdapter';
import type {
  GridRangeVariantId,
  Kline,
  MartingaleConfig,
  NeutralGridBotConfig,
} from '../../../../shared/types';

// ---------------------------------------------------------------------------
// GridOptimizer.MAKER_FEE_PCT is 0.02 per leg -> 0.04% round trip.
// Every net-profit assertion below is anchored to this constant on purpose:
// if the fee model changes, the fee gate must change with it.
// ---------------------------------------------------------------------------
const MAKER_FEE_ROUND_TRIP_PCT = 0.04;
const MIN_NET_PROFIT_WARN_PCT = 0.02;

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
// Fixtures
// ---------------------------------------------------------------------------
const SYMBOL = 'ETH-USD_UM_XPERP-310523';

const kline = (high: number, low: number, i: number, close?: number): Kline => ({
  timestamp: 1_700_000_000_000 + i * 900_000,
  open: close ?? (high + low) / 2,
  high,
  low,
  close: close ?? (high + low) / 2,
  volume: 1_000,
});

/** ETH-like OKX linear contract: 0.01 ETH per contract, 1-contract order step. */
const lot = (over: Partial<InstrumentLotFilter> = {}): InstrumentLotFilter => ({
  symbol: SYMBOL,
  minOrderQty: 1,
  maxOrderQty: 100_000,
  qtyStep: 1,
  minNotionalValue: 0,
  tickSize: 0.01,
  ctVal: 0.01,
  ctValCcy: 'ETH',
  ...over,
});

const MART_OFF: MartingaleConfig = {
  enabled: false,
  sizeMultiplier: 1,
  maxMultiplierSteps: 5,
  maxExposureUSDT: 0,
};

const cfg = (over: Partial<NeutralGridBotConfig> = {}): NeutralGridBotConfig => ({
  symbol: SYMBOL,
  platform: 'OKX_EEA',
  mode: 'AUTO',
  lowerPrice: 1960,
  upperPrice: 2040,
  gridCount: 8,
  gridType: 'ARITHMETIC',
  marginInvestedUSDT: 50,
  leverage: 5,
  marginMode: 'cross',
  martingale: MART_OFF,
  risk: {
    stopLossPct: 8,
    takeProfitPct: 15,
    stopOnRangeBreakout: true,
    maxMarginUsagePct: 50,
    maxActiveGridBots: 2,
  },
  ...over,
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
const registered: Array<{ name: string; fn: () => void }> = [];
const test = (name: string, fn: () => void): void => {
  registered.push({ name, fn });
};

// ===========================================================================
// 1. autoOptimizeParameters
// ===========================================================================

test('autoOptimize: rejects a non-positive market price', () => {
  let threw = false;
  try {
    GridOptimizer.autoOptimizeParameters(SYMBOL, 0, []);
  } catch {
    threw = true;
  }
  ok(threw, 'autoOptimizeParameters must throw when currentPrice is unavailable');
});

test('autoOptimize: fallback band is clamped to +/-1.75% and gridCount stays even', () => {
  // No klines -> synthetic ATR 1.2% and 24h range 8% -> half band clamps to the 1.75% ceiling.
  const r = GridOptimizer.autoOptimizeParameters(SYMBOL, 2000, [], 50, 0.01);

  close(r.lowerPrice, 1965, 0.005, 'lowerPrice must sit 1.75% under price');
  close(r.upperPrice, 2035, 0.005, 'upperPrice must sit 1.75% over price');
  ok(r.lowerPrice < 2000 && r.upperPrice > 2000, 'band must straddle the current price');

  ok(
    r.gridCount === 6 || r.gridCount === 8,
    `gridCount must be a balanced 6 or 8, got ${r.gridCount}`
  );
  eq(r.gridCount % 2, 0, 'gridCount must be even so the mid level stays neutral');

  ok(r.recommendedLeverage >= 3 && r.recommendedLeverage <= 5, 'leverage must stay in the 3x-5x tier');
  ok(r.stopLossPct >= 4 && r.stopLossPct <= 12, 'stopLossPct must stay within 4%-12%');
  ok(r.takeProfitPct >= 6 && r.takeProfitPct <= 24, 'takeProfitPct must stay within 6%-24%');
});

test('autoOptimize: Wilder ATR from klines drives the leverage tier', () => {
  // 48 candles, each with a 40-wide range -> ATR(14) = 40 -> atrPct = 2.0% on a 2000 price.
  const klines = Array.from({ length: 48 }, (_, i) => kline(2020, 1980, i));

  const r = GridOptimizer.autoOptimizeParameters(SYMBOL, 2000, klines, 50, 0.01);

  close(r.atrPct, 2.0, 0.01, 'atrPct must equal ATR/price');
  // atrPct 2.0 is > 1.2 but <= 2.2 -> 4x tier (3x only above 2.2%).
  eq(r.recommendedLeverage, 4, 'atrPct 2.0% must select the 4x leverage tier');
  eq(r.gridCount % 2, 0, 'gridCount must stay even');
});

test('autoOptimize: dead volatility floors the band at 0.95%', () => {
  // 8-wide ranges -> ATR 8 -> atrPct 0.4% -> balanced band collapses onto the 0.95% floor.
  const klines = Array.from({ length: 48 }, (_, i) => kline(2004, 1996, i));

  const r = GridOptimizer.autoOptimizeParameters(SYMBOL, 2000, klines, 50, 0.01);

  close(r.lowerPrice, 1981, 0.005, 'lowerPrice must floor-bind at 0.95%');
  close(r.upperPrice, 2019, 0.005, 'upperPrice must floor-bind at 0.95%');
  eq(r.gridCount, 6, 'a 1.9% total band must yield the minimum 6 grids');
});

// ===========================================================================
// 2. calculateGrid -- geometry
// ===========================================================================

test('calculateGrid: emits one level per grid, ascending, with correct sides', () => {
  const r = GridOptimizer.calculateGrid(cfg(), 2000, lot());

  eq(r.levels.length, 8, 'must emit exactly gridCount levels');
  eq(r.levels[0].index, 0, 'levels must be zero-indexed');

  for (let i = 1; i < r.levels.length; i++) {
    ok(r.levels[i].price > r.levels[i - 1].price, 'levels must be strictly ascending');
  }

  for (const lvl of r.levels) {
    if (lvl.price < 2000) eq(lvl.side, 'Buy', `level @${lvl.price} below price must be a Buy`);
    if (lvl.price > 2000) eq(lvl.side, 'Sell', `level @${lvl.price} above price must be a Sell`);
  }

  ok(r.totalPlannedNotionalUSDT > 0, 'planned notional must be positive');
  // Never exceed margin * leverage * 0.92 (8% maintenance buffer kept inside the bot).
  ok(
    r.totalPlannedNotionalUSDT <= 50 * 5 * 0.92 + 0.01,
    `planned notional ${r.totalPlannedNotionalUSDT} must respect the 92% buying-power cap`
  );
});

test('calculateGrid: every order respects minOrderQty and qtyStep', () => {
  const r = GridOptimizer.calculateGrid(cfg(), 2000, lot());

  for (const lvl of r.levels) {
    ok(
      lvl.qtyContracts >= 1,
      `level @${lvl.price} must carry at least minOrderQty contracts (got ${lvl.qtyContracts})`
    );
    eq(lvl.qtyContracts % 1, 0, 'contract quantity must be a whole multiple of qtyStep=1');
    ok(lvl.notionalUSDT > 0, 'notional must be positive once a quantity is forced');
  }
});

test('calculateGrid: geometric spacing keeps a constant ratio', () => {
  const r = GridOptimizer.calculateGrid(
    cfg({ lowerPrice: 1000, upperPrice: 2000, gridCount: 6, gridType: 'GEOMETRIC' }),
    1500,
    lot()
  );

  eq(r.levels.length, 6, 'must emit 6 geometric levels');
  close(r.levels[0].price, 1000, 0.01, 'first geometric level must equal lowerPrice');
  close(r.levels[5].price, 2000, 0.01, 'last geometric level must equal upperPrice');

  const expectedRatio = Math.pow(2, 1 / 5); // (upper/lower)^(1/(count-1))
  for (let i = 1; i < r.levels.length; i++) {
    const ratio = r.levels[i].price / r.levels[i - 1].price;
    close(ratio, expectedRatio, 0.002, `step ratio ${i} must stay geometric`);
  }
});

test('calculateGrid: absurd gridCount is clamped to the 2-level floor', () => {
  const r = GridOptimizer.calculateGrid(cfg({ gridCount: 1 }), 2000, lot());
  eq(r.levels.length, 2, 'gridCount 1 must clamp to 2 levels, never 1');
});

// ===========================================================================
// 3. calculateGrid -- strict fee gate (the core of 8ca9af7 / 578d929 behaviour)
// ===========================================================================

test('fee gate: net profit per grid is spacing minus the 0.04% maker round trip', () => {
  const r = GridOptimizer.calculateGrid(cfg(), 2000, lot());

  const expectedNet = Math.max(0, r.gridSpacingPct - MAKER_FEE_ROUND_TRIP_PCT);
  close(
    r.estimatedProfitPerGridPct,
    expectedNet,
    0.002,
    'net profit per grid must equal spacing minus the round-trip maker fee'
  );

  // ~0.57% spacing is comfortably above the 0.02% warning floor -> no fee warning.
  ok(r.estimatedProfitPerGridPct > MIN_NET_PROFIT_WARN_PCT, 'wide grid must stay profitable');
  ok(
    !r.warnings.some((w) => w.includes('comisioanele Maker')),
    'a profitable grid must not raise a fee warning'
  );
});

test('fee gate: a range too tight for the maker fee is flagged and nets exactly zero', () => {
  // 50 levels inside a 20 USDT band -> 0.0204% spacing < 0.04% round trip -> negative gross.
  const r = GridOptimizer.calculateGrid(cfg({ lowerPrice: 1990, upperPrice: 2010, gridCount: 50 }), 2000, lot());

  eq(r.estimatedProfitPerGridPct, 0, 'profit must be floored at 0, never negative');
  ok(
    r.warnings.some((w) => w.includes('comisioanele Maker')),
    'a sub-fee grid must emit the explicit maker-fee warning'
  );
  ok(r.gridSpacingPct < MAKER_FEE_ROUND_TRIP_PCT, 'spacing must indeed be under the round trip');
});

// ===========================================================================
// 4. calculateGrid -- neutral pivot, risk bounds, order-size floor
// ===========================================================================

test('calculateGrid: exactly one neutral pivot, excluded from planned notional', () => {
  const r = GridOptimizer.calculateGrid(
    cfg({ lowerPrice: 1990, upperPrice: 2010, gridCount: 5 }),
    2000,
    lot()
  );

  const neutral = r.levels.filter((l) => l.side === 'Neutral');
  eq(neutral.length, 1, 'exactly one level may sit neutral on the pivot');
  close(neutral[0].price, 2000, 0.01, 'the neutral level must sit on the current price');
  eq(neutral[0].status, 'IDLE', 'the neutral pivot must wait idle, not rest an order');

  const nonNeutralNotional = r.levels
    .filter((l) => l.side !== 'Neutral')
    .reduce((s, l) => s + l.notionalUSDT, 0);
  close(
    r.totalPlannedNotionalUSDT,
    nonNeutralNotional,
    0.05,
    'planned notional must exclude the neutral pivot'
  );
});

test('calculateGrid: liquidation estimates bracket the band on both sides', () => {
  const r = GridOptimizer.calculateGrid(cfg(), 2000, lot());

  ok(
    r.estimatedLiquidationPriceLong < 1960,
    `long liquidation ${r.estimatedLiquidationPriceLong} must sit below lowerPrice`
  );
  ok(
    r.estimatedLiquidationPriceShort > 2040,
    `short liquidation ${r.estimatedLiquidationPriceShort} must sit above upperPrice`
  );
  ok(r.lowerStopPrice < 1960, 'lower stop must trigger below the band');
  ok(r.upperStopPrice > 2040, 'upper stop must trigger above the band');
});

test('calculateGrid: an explicit hard stop overrides the computed buffer', () => {
  const r = GridOptimizer.calculateGrid(
    cfg({
      risk: {
        stopLossPct: 8,
        takeProfitPct: 15,
        lowerStopPrice: 1900,
        upperStopPrice: 2100,
        stopOnRangeBreakout: true,
        maxMarginUsagePct: 50,
        maxActiveGridBots: 2,
      },
    }),
    2000,
    lot()
  );

  eq(r.lowerStopPrice, 1900, 'explicit lowerStopPrice must win over the computed buffer');
  eq(r.upperStopPrice, 2100, 'explicit upperStopPrice must win over the computed buffer');
});

test('calculateGrid: dust margin forces minOrderQty and warns about the real margin floor', () => {
  // 5 USDT at 2x -> 9.2 notional spread over 8 levels -> ~1.15 USDT per level -> 0 contracts,
  // so every level is bumped to minOrderQty=1 (19.6 USDT) and the real margin need explodes.
  const r = GridOptimizer.calculateGrid(
    cfg({ marginInvestedUSDT: 5, leverage: 2 }),
    2000,
    lot()
  );

  for (const lvl of r.levels) {
    eq(lvl.qtyContracts, 1, 'every level must be bumped to the 1-contract minimum');
  }
  ok(
    r.warnings.some((w) => w.includes('Lotul minim')),
    'the engine must warn that minOrderQty requires more margin than allocated'
  );
});

// ===========================================================================
// 5. MartingaleEngine
// ===========================================================================

test('martingale: disabled weights are flat and the exposure ceiling clamps', () => {
  const flat = MartingaleEngine.computeLevelWeights(4, 100, [90, 97, 103, 110], MART_OFF);
  eq(flat.length, 4, 'one weight per level');
  for (const w of flat) eq(w, 1, 'disabled martingale must weight every level equally');

  const on: MartingaleConfig = { ...MART_OFF, enabled: true, sizeMultiplier: 1.5 };
  const weights = MartingaleEngine.computeLevelWeights(6, 100, [90, 95, 98, 102, 105, 110], on);
  // Center resolves to index 2 (98) -> step-1 neighbours stay at 1.0, deeper levels scale by 1.5x.
  const expected = [1.5, 1, 1, 1, 1.5, 2.25];
  weights.forEach((w, i) => close(w, expected[i], 1e-9, `weight[${i}] must follow the 1.5x step`));

  eq(
    MartingaleEngine.clampNotionalToCeiling(1000, { ...MART_OFF, maxExposureUSDT: 400 }),
    400,
    'exposure ceiling must clamp the planned notional'
  );
  eq(
    MartingaleEngine.clampNotionalToCeiling(1000, MART_OFF),
    1000,
    'a zero ceiling must leave the notional untouched'
  );
});

// ===========================================================================
// 6. Wilder ADX(14)
// ===========================================================================

test('adx: insufficient history falls back to the neutral 20', () => {
  eq(NeutralGridAnalyzer.computeWilderAdx14([], 14), 20, 'empty input must return 20');
  eq(
    NeutralGridAnalyzer.computeWilderAdx14(Array.from({ length: 10 }, (_, i) => kline(101, 99, i)), 14),
    20,
    'fewer than period+2 candles must return 20'
  );
});

test('adx: a clean uptrend saturates high, a flat tape collapses low', () => {
  // +DI only, -DI zero -> DX 100 on every bar -> ADX pinned to the 95 ceiling.
  const trend = Array.from({ length: 40 }, (_, i) => kline(100 + i, 99 + i, i, 99.5 + i));
  eq(NeutralGridAnalyzer.computeWilderAdx14(trend, 14), 95, 'a pure uptrend must hit the ADX ceiling');

  // Identical candles -> zero directional movement -> ADX pinned to the 5 floor.
  const flat = Array.from({ length: 40 }, (_, i) => kline(101, 99, i, 100));
  eq(NeutralGridAnalyzer.computeWilderAdx14(flat, 14), 5, 'a flat tape must hit the ADX floor');
});

// ===========================================================================
// 7. GridRangeVariants (CONSERVATIVE / BALANCED / COMPACT & active selection)
// ===========================================================================

const variantCtx = (over: Partial<GridRangeVariantContext> = {}): GridRangeVariantContext => ({
  price: 2000,
  decimals: 2,
  volFactor: 1.0,
  range24hPct: 4,
  chosenLever: 5,
  minLotNotionalUSD: 20,
  probeMinInvestmentUSDT: 0,
  totalCostPerGridPct: 0.055,
  roundTripMakerFeePct: 0.04,
  maxBudgetPerBotUSDT: 25,
  minNetProfitPerGridPct: 0.12,
  ...over,
});

test('variants (a): normal cost 0.055% computes geometry, spacing order, fee gates, and budget fit', () => {
  const v = buildGridRangeVariants(variantCtx({ totalCostPerGridPct: 0.055 }));

  eq(v.CONSERVATIVE.gridNum, 4, 'CONSERVATIVE gridNum must be 4');
  eq(v.BALANCED.gridNum, 8, 'BALANCED gridNum must be 8');
  eq(v.COMPACT.gridNum, 10, 'COMPACT gridNum must be 10');

  eq(v.CONSERVATIVE.halfRangePct, 2.05, 'CONSERVATIVE halfRangePct must be 2.05');
  eq(v.BALANCED.halfRangePct, 1.25, 'BALANCED halfRangePct must be 1.25');
  eq(v.COMPACT.halfRangePct, 0.75, 'COMPACT halfRangePct must be 0.75');

  ok(
    v.CONSERVATIVE.gridSpacingPct > v.BALANCED.gridSpacingPct &&
      v.BALANCED.gridSpacingPct > v.COMPACT.gridSpacingPct &&
      v.COMPACT.gridSpacingPct > 0,
    'spacing must be strictly ordered: CONSERVATIVE > BALANCED > COMPACT > 0'
  );

  eq(v.CONSERVATIVE.feeCheckPassed, true, 'CONSERVATIVE must pass fee check at 0.055% cost');
  eq(v.BALANCED.feeCheckPassed, true, 'BALANCED must pass fee check at 0.055% cost');
  eq(v.COMPACT.feeCheckPassed, true, 'COMPACT must pass fee check at 0.055% cost');

  eq(v.CONSERVATIVE.minInvestmentUSDT, 17.28, 'CONSERVATIVE minInvestmentUSDT must be 17.28');
  eq(v.BALANCED.minInvestmentUSDT, 34.56, 'BALANCED minInvestmentUSDT must be 34.56');
  eq(v.COMPACT.minInvestmentUSDT, 43.2, 'COMPACT minInvestmentUSDT must be 43.2');

  eq(v.CONSERVATIVE.fitsMaxBudget, true, 'CONSERVATIVE must fit maxBudgetPerBotUSDT=25');
  eq(v.BALANCED.fitsMaxBudget, false, 'BALANCED must exceed maxBudgetPerBotUSDT=25');
  eq(v.COMPACT.fitsMaxBudget, false, 'COMPACT must exceed maxBudgetPerBotUSDT=25');

  eq(
    v.CONSERVATIVE.recommendedInvestmentUSDT,
    18.14,
    'CONSERVATIVE recommendedInvestmentUSDT must be 18.14'
  );
});

test('variants (b): elevated cost 0.09% rejects COMPACT on fee gate while BALANCED passes', () => {
  const v = buildGridRangeVariants(variantCtx({ totalCostPerGridPct: 0.09 }));

  eq(v.COMPACT.feeCheckPassed, false, 'COMPACT must fail fee check at 0.09% cost');
  ok(
    typeof v.COMPACT.feeWarning === 'string' && v.COMPACT.feeWarning.length > 0,
    'COMPACT must emit a non-empty feeWarning when feeCheckPassed is false'
  );
  eq(v.BALANCED.feeCheckPassed, true, 'BALANCED must still pass fee check at 0.09% cost');
});

test('variants (c): selectActiveRangeVariant enforces fee safety, budget fallback, and unknown ID fallback', () => {
  // High cost (0.09%) + budget large enough so budget fallback does not mask the fee fallback
  const vHighCostWideBudget = buildGridRangeVariants(
    variantCtx({ totalCostPerGridPct: 0.09, maxBudgetPerBotUSDT: 100 })
  );
  const pickedFromCompact = selectActiveRangeVariant(vHighCostWideBudget, 'COMPACT');
  eq(
    pickedFromCompact.id,
    'BALANCED',
    'COMPACT failing fee check must fall back to BALANCED'
  );

  // At 0.055% cost with maxBudget=25, BALANCED (34.56) exceeds budget while CONSERVATIVE (17.28) fits
  const vDefaultBudget = buildGridRangeVariants(variantCtx({ totalCostPerGridPct: 0.055 }));
  const pickedFromBalanced = selectActiveRangeVariant(vDefaultBudget, 'BALANCED');
  eq(
    pickedFromBalanced.id,
    'CONSERVATIVE',
    'BALANCED exceeding budget must fall back to CONSERVATIVE when CONSERVATIVE fits'
  );

  // Unknown requestedId falls back to BALANCED without throwing (when BALANCED fits budget)
  const vWideBudget = buildGridRangeVariants(
    variantCtx({ totalCostPerGridPct: 0.055, maxBudgetPerBotUSDT: 100 })
  );
  const pickedUnknown = selectActiveRangeVariant(
    vWideBudget,
    'UNKNOWN_VARIANT' as unknown as GridRangeVariantId
  );
  eq(pickedUnknown.id, 'BALANCED', 'unknown requestedId must fall back to BALANCED without throwing');
});

test('variants (d): geometry invariants hold across all three profiles', () => {
  const v = buildGridRangeVariants(variantCtx({ totalCostPerGridPct: 0.055 }));
  const all = [v.CONSERVATIVE, v.BALANCED, v.COMPACT];

  for (const p of all) {
    ok(p.minPx < 2000 && 2000 < p.maxPx, `${p.id} must bracket price (minPx < price < maxPx)`);
    close(
      p.totalRangePct,
      2 * p.halfRangePct,
      0.01,
      `${p.id} totalRangePct must equal 2 * halfRangePct`
    );
  }

  eq(v.BALANCED.gridNum % 2, 0, 'BALANCED gridNum must be even');
  eq(v.COMPACT.gridNum % 2, 0, 'COMPACT gridNum must be even');
});

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------
const run = (): void => {
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
  console.log(`\n${total - failed}/${total} passed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
};

run();
