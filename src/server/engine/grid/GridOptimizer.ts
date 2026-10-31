import {
  NeutralGridBotConfig,
  GridLevelState,
  GridSpacingType,
  Kline,
} from '../../../shared/types';
import { InstrumentLotFilter } from '../../exchange/IExecutionAdapter';
import { MartingaleEngine } from './MartingaleEngine';

export interface GridOptimizationResult {
  levels: GridLevelState[];
  gridSpacingUSDT: number;
  gridSpacingPct: number;
  estimatedProfitPerGridPct: number;
  totalPlannedNotionalUSDT: number;
  estimatedLiquidationPriceLong: number;
  estimatedLiquidationPriceShort: number;
  lowerStopPrice: number;
  upperStopPrice: number;
  warnings: string[];
}

export class GridOptimizer {
  private static readonly MAKER_FEE_PCT = 0.02; // 0.02% maker fee per leg (0.04% round-trip)

  /**
   * Automatically calculates optimal Neutral Grid boundaries (lowerPrice, upperPrice, gridCount, leverage)
   * from recent Klines and ATR volatility when user clicks "Auto-Optimizează" or runs in AUTO mode.
   */
  public static autoOptimizeParameters(
    symbol: string,
    currentPrice: number,
    klines: Kline[],
    marginInvestedUSDT: number = 50,
    tickSize: number = 0.01
  ): {
    lowerPrice: number;
    upperPrice: number;
    gridCount: number;
    gridType: GridSpacingType;
    recommendedLeverage: number;
    stopLossPct: number;
    takeProfitPct: number;
    atrPct: number;
    range24hPct: number;
  } {
    if (!currentPrice || currentPrice <= 0) {
      throw new Error(`Prețul curent de piață pentru ${symbol} este indisponibil.`);
    }

    let atr = currentPrice * 0.012;
    let high = currentPrice * 1.04;
    let low = currentPrice * 0.96;

    if (klines && klines.length >= 14) {
      const recent = klines.slice(-48);
      high = Math.max(...recent.map((k) => k.high));
      low = Math.min(...recent.map((k) => k.low));
      const trSum = klines
        .slice(-14)
        .reduce((acc, k) => acc + Math.max(1e-9, k.high - k.low), 0);
      atr = trSum / 14;
    }

    const atrPct = (atr / currentPrice) * 100;
    const rawRangePct = ((high - low) / currentPrice) * 100;

    // Ideal 3-day / 24h neutral channel width: between 3.5% and 14% around currentPrice
    const halfBandPct = Math.min(8.0, Math.max(2.0, Math.max(rawRangePct * 0.65, atrPct * 3.2)));
    const decimals = this.getDecimalsFromTick(tickSize, currentPrice);

    const lowerPrice = parseFloat((currentPrice * (1 - halfBandPct / 100)).toFixed(decimals));
    const upperPrice = parseFloat((currentPrice * (1 + halfBandPct / 100)).toFixed(decimals));

    // Target spacing ~0.35% - 0.60% per grid so net profit after 0.04% maker round-trip is ~0.30% - 0.55%
    const totalBandPct = halfBandPct * 2;
    const idealStepPct = Math.max(0.32, Math.min(0.75, atrPct * 0.45));
    let gridCount = Math.round(totalBandPct / idealStepPct);
    gridCount = Math.max(6, Math.min(40, gridCount));

    // Ensure margin can support the number of grids (at least $4 notional per grid with leverage)
    const recommendedLeverage = atrPct > 2.2 ? 2 : atrPct > 1.2 ? 3 : 5;
    const totalBuyingPower = marginInvestedUSDT * recommendedLeverage;
    const maxAffordableGrids = Math.max(4, Math.floor(totalBuyingPower / 5.5));
    gridCount = Math.min(gridCount, maxAffordableGrids);
    if (gridCount % 2 !== 0) gridCount += 1; // Even grid count for symmetrical Neutral Grid

    return {
      lowerPrice,
      upperPrice,
      gridCount: Math.max(4, gridCount),
      gridType: totalBandPct > 10 ? 'GEOMETRIC' : 'ARITHMETIC',
      recommendedLeverage,
      stopLossPct: parseFloat(Math.min(15, Math.max(4, halfBandPct * 1.15)).toFixed(1)),
      takeProfitPct: parseFloat(Math.min(30, Math.max(6, halfBandPct * 1.8)).toFixed(1)),
      atrPct: parseFloat(atrPct.toFixed(2)),
      range24hPct: parseFloat(rawRangePct.toFixed(2)),
    };
  }

  /**
   * Computes complete Neutral Grid levels, contract quantities, liquidation estimates, and stop prices.
   */
  public static calculateGrid(
    config: NeutralGridBotConfig,
    currentPrice: number,
    lotFilter?: InstrumentLotFilter
  ): GridOptimizationResult {
    const warnings: string[] = [];
    const lower = Math.min(config.lowerPrice, config.upperPrice);
    const upper = Math.max(config.lowerPrice, config.upperPrice);
    const count = Math.max(2, Math.min(200, Math.round(config.gridCount)));
    const leverage = Math.max(1, Math.min(50, config.leverage || 1));
    const margin = Math.max(5, config.marginInvestedUSDT || 50);

    const refPrice =
      currentPrice > lower && currentPrice < upper
        ? currentPrice
        : (lower + upper) / 2;

    const tickSize = lotFilter?.tickSize || this.inferTickSize(refPrice);
    const priceDecimals = this.getDecimalsFromTick(tickSize, refPrice);
    const ctVal = lotFilter?.ctVal && lotFilter.ctVal > 0 ? lotFilter.ctVal : 1;
    const qtyStep = lotFilter?.qtyStep && lotFilter.qtyStep > 0 ? lotFilter.qtyStep : 1;
    const minOrderQty = lotFilter?.minOrderQty && lotFilter.minOrderQty > 0 ? lotFilter.minOrderQty : qtyStep;
    const qtyDecimals = this.getDecimalsFromTick(qtyStep, 1);

    // 1. Generate Price Levels (count levels -> count - 1 intervals, or count levels total)
    const prices: number[] = [];
    if (config.gridType === 'GEOMETRIC' && lower > 0) {
      const ratio = Math.pow(upper / lower, 1 / (count - 1));
      for (let i = 0; i < count; i++) {
        const px = lower * Math.pow(ratio, i);
        prices.push(parseFloat(px.toFixed(priceDecimals)));
      }
    } else {
      const step = (upper - lower) / (count - 1);
      for (let i = 0; i < count; i++) {
        const px = lower + step * i;
        prices.push(parseFloat(px.toFixed(priceDecimals)));
      }
    }

    const avgSpacingUSDT = (upper - lower) / Math.max(1, count - 1);
    const avgSpacingPct = (avgSpacingUSDT / refPrice) * 100;
    const estimatedProfitPerGridPct = Math.max(
      0,
      parseFloat((avgSpacingPct - this.MAKER_FEE_PCT * 2).toFixed(3))
    );

    if (estimatedProfitPerGridPct <= 0.02) {
      warnings.push(
        `Distanța dintre trepte (${avgSpacingPct.toFixed(2)}%) este foarte mică față de comisioanele Maker (0.04% dus-întors). Recomandăm reducerea numărului de trepte sau lărgirea intervalului.`
      );
    }

    // 2. Compute Martingale / Step Weights
    const weights = MartingaleEngine.computeLevelWeights(
      count,
      refPrice,
      prices,
      config.martingale
    );
    const totalWeight = weights.reduce((s, w) => s + w, 0) || count;

    // 3. Total Buying Power & Notional Allocation
    const rawTotalNotional = margin * leverage * 0.92; // Keep 8% maintenance buffer inside bot allocation
    const cappedTotalNotional = MartingaleEngine.clampNotionalToCeiling(
      rawTotalNotional,
      config.martingale
    );

    const levels: GridLevelState[] = [];
    let actualTotalNotional = 0;

    // Find closest level to currentPrice to leave as the neutral pivot gap (so we don't cross the book immediately)
    let closestIdx = 0;
    let minDist = Infinity;
    for (let i = 0; i < prices.length; i++) {
      const d = Math.abs(prices[i] - refPrice);
      if (d < minDist) {
        minDist = d;
        closestIdx = i;
      }
    }

    for (let i = 0; i < prices.length; i++) {
      const px = prices[i];
      const weight = weights[i];
      const levelTargetNotional = (cappedTotalNotional * weight) / totalWeight;

      // Convert notional USDT -> OKX contracts: contracts = notional / (px * ctVal)
      const rawContracts = levelTargetNotional / Math.max(1e-9, px * ctVal);
      let contracts = Math.floor(rawContracts / qtyStep) * qtyStep;
      if (contracts < minOrderQty) {
        contracts = minOrderQty;
      }
      contracts = parseFloat(contracts.toFixed(qtyDecimals));
      const actualNotional = parseFloat((contracts * ctVal * px).toFixed(2));

      // Neutral Grid assignment:
      // Levels strictly below currentPrice -> Limit BUY
      // Levels strictly above currentPrice -> Limit SELL
      // Level closest to currentPrice (if within 0.15% of currentPrice) -> Neutral pivot (waiting for fill on neighbors)
      let side: 'Buy' | 'Sell' | 'Neutral' = px < refPrice ? 'Buy' : 'Sell';
      if (i === closestIdx && Math.abs(px - refPrice) / refPrice < 0.0015 && count > 4) {
        side = 'Neutral';
      }

      if (side !== 'Neutral') {
        actualTotalNotional += actualNotional;
      }

      levels.push({
        index: i,
        price: px,
        side,
        qtyContracts: contracts,
        notionalUSDT: actualNotional,
        martingaleWeight: weight,
        status: side === 'Neutral' ? 'IDLE' : 'OPEN_ORDER',
        fillCount: 0,
        realizedGridProfitUSDT: 0,
      });
    }

    const requiredMarginMin = actualTotalNotional / leverage;
    if (requiredMarginMin > margin * 1.15) {
      warnings.push(
        `Lotul minim al instrumentului (${minOrderQty} contracte, ctVal=${ctVal}) necesită o marjă minimă de ~$${requiredMarginMin.toFixed(2)} la ${leverage}x pentru ${count} trepte.`
      );
    }

    // 4. Liquidation & Stop Price Estimates
    const mmr = 0.008; // ~0.8% maintenance margin buffer
    const maxExcursionPct = Math.max(0.02, 1 / leverage - mmr);
    const avgBuyPx = (lower + refPrice) / 2;
    const avgSellPx = (upper + refPrice) / 2;

    const estimatedLiquidationPriceLong = parseFloat(
      Math.max(0, avgBuyPx * (1 - maxExcursionPct)).toFixed(priceDecimals)
    );
    const estimatedLiquidationPriceShort = parseFloat(
      (avgSellPx * (1 + maxExcursionPct)).toFixed(priceDecimals)
    );

    const stopBufferPct = Math.max(0.005, (config.risk.stopLossPct || 5) / (100 * Math.max(1, leverage * 0.5)));
    const lowerStopPrice =
      config.risk.lowerStopPrice && config.risk.lowerStopPrice > 0 && config.risk.lowerStopPrice < lower
        ? config.risk.lowerStopPrice
        : parseFloat((lower * (1 - stopBufferPct)).toFixed(priceDecimals));

    const upperStopPrice =
      config.risk.upperStopPrice && config.risk.upperStopPrice > upper
        ? config.risk.upperStopPrice
        : parseFloat((upper * (1 + stopBufferPct)).toFixed(priceDecimals));

    return {
      levels,
      gridSpacingUSDT: parseFloat(avgSpacingUSDT.toFixed(priceDecimals)),
      gridSpacingPct: parseFloat(avgSpacingPct.toFixed(3)),
      estimatedProfitPerGridPct,
      totalPlannedNotionalUSDT: parseFloat(actualTotalNotional.toFixed(2)),
      estimatedLiquidationPriceLong,
      estimatedLiquidationPriceShort,
      lowerStopPrice,
      upperStopPrice,
      warnings,
    };
  }

  private static inferTickSize(price: number): number {
    if (price >= 10000) return 0.1;
    if (price >= 100) return 0.01;
    if (price >= 1) return 0.001;
    if (price >= 0.01) return 0.0001;
    return 0.00001;
  }

  private static getDecimalsFromTick(tick: number, fallbackPrice: number): number {
    const s = tick.toString();
    if (s.includes('.')) return s.split('.')[1].length;
    if (fallbackPrice < 0.1) return 5;
    if (fallbackPrice < 10) return 4;
    return 2;
  }
}
