/**
 * GridBacktestEngine
 * High-performance, side-effect-free backtesting simulator for OKX Neutral Grid bots.
 * 
 * Features:
 * - Uses GridOptimizer.calculateGrid for identical level geometry
 * - Exact fee modeling from getLiveFeeRates()
 * - Realistic 8-hour funding rate calculation
 * - Granular cycle / arbitrage tracking
 * - Range breakout duration & liquidation proximity metrics
 * - Walk-Forward 60d In-Sample / 30d Out-of-Sample analysis
 * - 24/7 vs Best-Hours vs Pattern-Filtered comparison
 */

import {
  Kline,
  NeutralGridBotConfig,
  GridSpacingType,
} from '../../shared/types';
import { InstrumentLotFilter } from '../exchange/IExecutionAdapter';
import { getLiveFeeRates } from '../../shared/fees';
import { GridOptimizer } from '../engine/grid/GridOptimizer';
import { FundingRateRecord } from './HistoricalDataStore';

export function createDefaultBotConfig(
  symbol: string,
  lowerPrice: number,
  upperPrice: number,
  gridCount: number = 8,
  gridType: GridSpacingType = 'ARITHMETIC',
  leverage: number = 3,
  marginInvestedUSDT: number = 50,
  stopLossPct: number = 15,
  takeProfitPct: number = 30
): NeutralGridBotConfig {
  return {
    symbol,
    platform: 'OKX_EEA',
    mode: 'AUTO',
    lowerPrice,
    upperPrice,
    gridCount,
    gridType,
    marginInvestedUSDT,
    leverage,
    marginMode: 'isolated',
    martingale: {
      enabled: false,
      sizeMultiplier: 1.0,
      maxMultiplierSteps: 5,
      maxExposureUSDT: 500,
    },
    risk: {
      stopLossPct,
      takeProfitPct,
      stopOnRangeBreakout: true,
      maxMarginUsagePct: 50,
      maxActiveGridBots: 5,
    },
  };
}

export interface BacktestOrderFill {
  timestamp: number;
  levelIndex: number;
  side: 'BUY' | 'SELL';
  price: number;
  qtyContracts: number;
  feeUSDT: number;
  realizedPnlUSDT: number;
}

export interface BacktestResult {
  config: NeutralGridBotConfig;
  symbol: string;
  startDate: string;
  endDate: string;
  totalCandles: number;
  initialMarginUSDT: number;
  finalEquityUSDT: number;
  netPnLUSDT: number;
  netPnLPct: number;
  annualizedRoiPct: number;
  gridProfitUSDT: number;
  totalFeesUSDT: number;
  fundingPnLUSDT: number;
  floatingPnLUSDT: number;
  completedCycles: number;
  avgProfitPerCycleUSDT: number;
  maxDrawdownUSDT: number;
  maxDrawdownPct: number;
  sharpeRatio: number;
  calmarRatio: number;
  rangeBreakoutsAbove: number;
  rangeBreakoutsBelow: number;
  timeOutsideRangePct: number;
  minLiquidationDistancePct: number;
  wasLiquidated: boolean;
  equityCurve: Array<{ timestamp: number; equity: number; drawdownPct: number }>;
}

export interface WalkForwardResult {
  symbol: string;
  inSample: BacktestResult;
  outOfSample: BacktestResult;
  walkForwardEfficiencyPct: number; // OOS return / IS return normalized
  overfittingScore: number; // 0-100 (lower is better, <35 is robust)
  isRobust: boolean;
  recommendedConfig: NeutralGridBotConfig;
}

export interface ComparisonResult {
  mode247: BacktestResult;
  bestHoursMode: BacktestResult;
  patternFilteredMode: BacktestResult;
  bestHoursList: number[];
  alphaBestHoursPct: number;
  alphaPatternFilteredPct: number;
}

export interface BacktestOptions {
  allowedHoursUtc?: Set<number>;
  patternFilterIndices?: Set<number>; // candle indices where entry/trading is blocked
  lotFilter?: InstrumentLotFilter;
  customMakerFeeRate?: number;
  customTakerFeeRate?: number;
}

export class GridBacktestEngine {
  /**
   * Runs a single historical simulation for a Neutral Grid configuration.
   */
  public static runSimulation(
    klines: Kline[],
    config: NeutralGridBotConfig,
    fundingRates: FundingRateRecord[] = [],
    options: BacktestOptions = {}
  ): BacktestResult {
    if (!klines || klines.length < 2) {
      throw new Error('Date istorice insuficiente pentru backtest (minim 2 lumânări).');
    }

    const firstPrice = klines[0].open;
    const lotFilter = options.lotFilter || {
      symbol: config.symbol || (config as any).defaultSymbol || 'BTC-USDT-SWAP',
      minOrderQty: 1,
      maxOrderQty: 1000000,
      qtyStep: 1,
      minNotionalValue: 1,
      tickSize: 0.01,
      ctVal: 1,
    };

    const feeRates = getLiveFeeRates();
    const makerRate = options.customMakerFeeRate ?? feeRates.makerFeeRate;
    const takerRate = options.customTakerFeeRate ?? feeRates.takerFeeRate;
    const ctVal = lotFilter.ctVal && lotFilter.ctVal > 0 ? lotFilter.ctVal : 1;

    // Calculate grid levels using standard GridOptimizer
    const gridCalc = GridOptimizer.calculateGrid(config, firstPrice, lotFilter);
    const levels = gridCalc.levels.map((l) => ({
      index: l.index,
      price: l.price,
      qtyContracts: Math.max(lotFilter.minOrderQty, l.qtyContracts || 1),
      currentOrder: (l.price < firstPrice ? 'BUY' : 'SELL') as 'BUY' | 'SELL',
    }));

    const marginInvested = config.marginInvestedUSDT || 50;
    let cashBalance = marginInvested;
    let netPositionContracts = 0;
    let avgHoldPrice = firstPrice;
    let realizedGridProfit = 0;
    let totalMakerFees = 0;
    let totalTakerFees = 0;
    let fundingPnL = 0;
    let completedCycles = 0;

    let peakEquity = marginInvested;
    let maxDrawdownUSDT = 0;
    let maxDrawdownPct = 0;
    let breakoutsAbove = 0;
    let breakoutsBelow = 0;
    let candlesOutside = 0;
    let minLiqDistPct = 999;
    let wasLiquidated = false;

    // Build fast lookup for funding rates by timestamp
    const fundingMap = new Map<number, number>();
    for (const f of fundingRates) {
      fundingMap.set(f.fundingTime, f.fundingRate);
    }

    const equityCurve: Array<{ timestamp: number; equity: number; drawdownPct: number }> = [];
    const dailyReturns: number[] = [];
    let lastDayIndex = -1;
    let dayStartEquity = marginInvested;

    const lowerBound = Math.min(config.lowerPrice, config.upperPrice);
    const upperBound = Math.max(config.lowerPrice, config.upperPrice);
    const estLiqLong = gridCalc.estimatedLiquidationPriceLong;
    const estLiqShort = gridCalc.estimatedLiquidationPriceShort;

    // Sort unique prices ascending to build adjacent grid interval slots
    const sortedPrices = Array.from(new Set(gridCalc.levels.map((l) => l.price))).sort((a, b) => a - b);
    interface GridSlot {
      index: number;
      buyPrice: number;
      sellPrice: number;
      qtyContracts: number;
      state: 'WAITING_BUY' | 'WAITING_SELL';
      openPrice?: number;
    }

    const slots: GridSlot[] = [];
    for (let sIdx = 0; sIdx < sortedPrices.length - 1; sIdx++) {
      const bPx = sortedPrices[sIdx];
      const sPx = sortedPrices[sIdx + 1];
      const matchedLvl = gridCalc.levels.find((l) => Math.abs(l.price - bPx) < 1e-6);
      const qty = Math.max(lotFilter.minOrderQty, matchedLvl?.qtyContracts || 1);
      // Below first price: waiting to buy at lower rung. Above first price: waiting to sell at upper rung.
      const initialSlotState: 'WAITING_BUY' | 'WAITING_SELL' = bPx < firstPrice ? 'WAITING_BUY' : 'WAITING_SELL';
      slots.push({
        index: sIdx,
        buyPrice: bPx,
        sellPrice: sPx,
        qtyContracts: qty,
        state: initialSlotState,
      });
    }

    for (let i = 0; i < klines.length; i++) {
      const k = klines[i];
      const candleHourUtc = new Date(k.timestamp).getUTCHours();
      const candleDayIndex = Math.floor(k.timestamp / 86_400_000);

      // Track daily returns for Sharpe ratio
      if (candleDayIndex !== lastDayIndex) {
        if (lastDayIndex !== -1 && dayStartEquity > 0) {
          const currentEq = cashBalance + realizedGridProfit + fundingPnL - (totalMakerFees + totalTakerFees);
          dailyReturns.push((currentEq - dayStartEquity) / dayStartEquity);
          dayStartEquity = currentEq;
        }
        lastDayIndex = candleDayIndex;
      }

      // Check range boundary metrics
      if (k.high > upperBound) breakoutsAbove++;
      if (k.low < lowerBound) breakoutsBelow++;
      if (k.close < lowerBound || k.close > upperBound) candlesOutside++;

      // Liquidation proximity check
      if (netPositionContracts > 0 && estLiqLong > 0) {
        const distLongPct = ((k.low - estLiqLong) / k.low) * 100;
        if (distLongPct < minLiqDistPct) minLiqDistPct = Math.max(0, distLongPct);
        if (k.low <= estLiqLong) {
          wasLiquidated = true;
        }
      } else if (netPositionContracts < 0 && estLiqShort > 0) {
        const distShortPct = ((estLiqShort - k.high) / k.high) * 100;
        if (distShortPct < minLiqDistPct) minLiqDistPct = Math.max(0, distShortPct);
        if (k.high >= estLiqShort) {
          wasLiquidated = true;
        }
      }

      // Funding application (check if candle crosses 8h boundary: 00:00, 08:00, 16:00 UTC)
      const prevK = i > 0 ? klines[i - 1] : null;
      if (prevK) {
        const prev8h = Math.floor(prevK.timestamp / 28_800_000);
        const curr8h = Math.floor(k.timestamp / 28_800_000);
        if (curr8h > prev8h && Math.abs(netPositionContracts) > 1e-6) {
          const matchedRate = fundingMap.get(curr8h * 28_800_000) ?? 0.0001;
          const posNotional = netPositionContracts * ctVal * k.close;
          const fPayment = posNotional * matchedRate;
          fundingPnL -= fPayment;
        }
      }

      if (wasLiquidated) {
        cashBalance = 0;
        break;
      }

      // Evaluate filters (Best hours / pattern blocker)
      const isHourAllowed = !options.allowedHoursUtc || options.allowedHoursUtc.has(candleHourUtc);
      const isPatternBlocked = options.patternFilterIndices?.has(i);
      const canExecuteNewFills = isHourAllowed && !isPatternBlocked;

      if (canExecuteNewFills) {
        for (const slot of slots) {
          if (slot.state === 'WAITING_BUY' && k.low <= slot.buyPrice) {
            // BUY fill at slot.buyPrice
            const notional = slot.buyPrice * slot.qtyContracts * ctVal;
            const fee = notional * makerRate;
            totalMakerFees += fee;

            if (slot.openPrice !== undefined) {
              // Closing a short leg!
              const profit = (slot.openPrice - slot.buyPrice) * slot.qtyContracts * ctVal;
              realizedGridProfit += profit;
              completedCycles++;
              netPositionContracts += slot.qtyContracts;
              slot.openPrice = undefined;
              slot.state = 'WAITING_SELL';
            } else {
              // Opening a long leg waiting to sell at slot.sellPrice
              netPositionContracts += slot.qtyContracts;
              slot.openPrice = slot.buyPrice;
              slot.state = 'WAITING_SELL';
            }

            // Intra-candle check: if candle also reached sellPrice, complete round-trip!
            if (slot.state === 'WAITING_SELL' && k.high >= slot.sellPrice) {
              const exitNotional = slot.sellPrice * slot.qtyContracts * ctVal;
              totalMakerFees += exitNotional * makerRate;
              const profit = (slot.sellPrice - slot.buyPrice) * slot.qtyContracts * ctVal;
              realizedGridProfit += profit;
              completedCycles++;
              netPositionContracts -= slot.qtyContracts;
              slot.openPrice = undefined;
              slot.state = 'WAITING_BUY';
            }
          } else if (slot.state === 'WAITING_SELL' && k.high >= slot.sellPrice) {
            // SELL fill at slot.sellPrice
            const notional = slot.sellPrice * slot.qtyContracts * ctVal;
            const fee = notional * makerRate;
            totalMakerFees += fee;

            if (slot.openPrice !== undefined) {
              // Closing a long leg!
              const profit = (slot.sellPrice - slot.openPrice) * slot.qtyContracts * ctVal;
              realizedGridProfit += profit;
              completedCycles++;
              netPositionContracts -= slot.qtyContracts;
              slot.openPrice = undefined;
              slot.state = 'WAITING_BUY';
            } else {
              // Opening a short leg waiting to buy back at slot.buyPrice
              netPositionContracts -= slot.qtyContracts;
              slot.openPrice = slot.sellPrice;
              slot.state = 'WAITING_BUY';
            }

            // Intra-candle check: if candle also dipped to buyPrice, complete round-trip!
            if (slot.state === 'WAITING_BUY' && k.low <= slot.buyPrice) {
              const buyNotional = slot.buyPrice * slot.qtyContracts * ctVal;
              totalMakerFees += buyNotional * makerRate;
              const profit = (slot.sellPrice - slot.buyPrice) * slot.qtyContracts * ctVal;
              realizedGridProfit += profit;
              completedCycles++;
              netPositionContracts += slot.qtyContracts;
              slot.openPrice = undefined;
              slot.state = 'WAITING_SELL';
            }
          }
        }
      }

      // Mark-to-market floating PnL on remaining net inventory
      const currentPrice = k.close;
      const floatingPnL =
        netPositionContracts !== 0
          ? (currentPrice - avgHoldPrice) * netPositionContracts * ctVal
          : 0;

      const currentEquity = cashBalance + realizedGridProfit + floatingPnL + fundingPnL - (totalMakerFees + totalTakerFees);

      if (currentEquity > peakEquity) {
        peakEquity = currentEquity;
      }
      const ddUSDT = peakEquity - currentEquity;
      const ddPct = peakEquity > 0 ? (ddUSDT / peakEquity) * 100 : 0;
      if (ddUSDT > maxDrawdownUSDT) maxDrawdownUSDT = ddUSDT;
      if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct;

      // Sample equity curve every 20 candles or on last candle to keep payload compact
      if (i % 20 === 0 || i === klines.length - 1) {
        equityCurve.push({
          timestamp: k.timestamp,
          equity: parseFloat(currentEquity.toFixed(2)),
          drawdownPct: parseFloat(ddPct.toFixed(2)),
        });
      }
    }

    // Final inventory closeout at last price
    const finalPrice = klines[klines.length - 1].close;
    let finalFloatingPnL = 0;
    if (Math.abs(netPositionContracts) > 1e-6) {
      finalFloatingPnL = (finalPrice - avgHoldPrice) * netPositionContracts * ctVal;
    }

    const totalFees = totalMakerFees + totalTakerFees;
    const finalEquity = cashBalance + realizedGridProfit + finalFloatingPnL + fundingPnL - totalFees;
    const netPnLUSDT = finalEquity - marginInvested;
    const netPnLPct = (netPnLUSDT / marginInvested) * 100;

    // Annualized ROI & Sharpe
    const durationDays = Math.max(1, (klines[klines.length - 1].timestamp - klines[0].timestamp) / 86_400_000);
    const annualizedRoiPct = (netPnLPct / durationDays) * 365;

    let sharpeRatio = 0;
    if (dailyReturns.length > 2) {
      const meanReturn = dailyReturns.reduce((s, r) => s + r, 0) / dailyReturns.length;
      const variance = dailyReturns.reduce((s, r) => s + Math.pow(r - meanReturn, 2), 0) / (dailyReturns.length - 1);
      const stdDev = Math.sqrt(variance);
      if (stdDev > 0) {
        sharpeRatio = (meanReturn / stdDev) * Math.sqrt(365);
      }
    }

    const calmarRatio = maxDrawdownPct > 0 ? annualizedRoiPct / maxDrawdownPct : 0;

    return {
      config,
      symbol: config.symbol || (config as any).defaultSymbol || '',
      startDate: new Date(klines[0].timestamp).toISOString().split('T')[0],
      endDate: new Date(klines[klines.length - 1].timestamp).toISOString().split('T')[0],
      totalCandles: klines.length,
      initialMarginUSDT: marginInvested,
      finalEquityUSDT: parseFloat(finalEquity.toFixed(2)),
      netPnLUSDT: parseFloat(netPnLUSDT.toFixed(2)),
      netPnLPct: parseFloat(netPnLPct.toFixed(2)),
      annualizedRoiPct: parseFloat(annualizedRoiPct.toFixed(2)),
      gridProfitUSDT: parseFloat(realizedGridProfit.toFixed(2)),
      totalFeesUSDT: parseFloat(totalFees.toFixed(2)),
      fundingPnLUSDT: parseFloat(fundingPnL.toFixed(2)),
      floatingPnLUSDT: parseFloat(finalFloatingPnL.toFixed(2)),
      completedCycles,
      avgProfitPerCycleUSDT: completedCycles > 0 ? parseFloat((realizedGridProfit / completedCycles).toFixed(4)) : 0,
      maxDrawdownUSDT: parseFloat(maxDrawdownUSDT.toFixed(2)),
      maxDrawdownPct: parseFloat(maxDrawdownPct.toFixed(2)),
      sharpeRatio: parseFloat(sharpeRatio.toFixed(2)),
      calmarRatio: parseFloat(calmarRatio.toFixed(2)),
      rangeBreakoutsAbove: breakoutsAbove,
      rangeBreakoutsBelow: breakoutsBelow,
      timeOutsideRangePct: parseFloat(((candlesOutside / klines.length) * 100).toFixed(2)),
      minLiquidationDistancePct: minLiqDistPct === 999 ? 100 : parseFloat(minLiqDistPct.toFixed(2)),
      wasLiquidated,
      equityCurve,
    };
  }

  /**
   * Explores parameter variations (range width, grid num, arithmetic vs geometric, leverage)
   * to rank configurations by Sharpe ratio, Net PnL, and Drawdown.
   */
  public static testVariations(
    klines: Kline[],
    baseSymbol: string,
    fundingRates: FundingRateRecord[] = [],
    options: BacktestOptions = {}
  ): BacktestResult[] {
    if (!klines || klines.length < 10) return [];

    const firstPrice = klines[0].open;
    const high = Math.max(...klines.map((k) => k.high));
    const low = Math.min(...klines.map((k) => k.low));
    const mid = (high + low) / 2;

    const rangeWidthsPct = [
      { name: 'Tight (±1.5%)', half: 1.5 },
      { name: 'Balanced (±2.5%)', half: 2.5 },
      { name: 'Wide (±4.0%)', half: 4.0 },
      { name: 'Historical Envelope (±5.5%)', half: 5.5 },
    ];
    const gridCounts = [6, 8, 12, 16];
    const gridTypes: GridSpacingType[] = ['ARITHMETIC', 'GEOMETRIC'];
    const leverages = [2, 3, 5];

    const results: BacktestResult[] = [];

    for (const r of rangeWidthsPct) {
      const lower = parseFloat((mid * (1 - r.half / 100)).toFixed(2));
      const upper = parseFloat((mid * (1 + r.half / 100)).toFixed(2));

      for (const count of gridCounts) {
        for (const type of gridTypes) {
          for (const lev of leverages) {
            const config: NeutralGridBotConfig = createDefaultBotConfig(
              baseSymbol,
              lower,
              upper,
              count,
              type,
              lev,
              50,
              15,
              30
            );

            try {
              const res = this.runSimulation(klines, config, fundingRates, options);
              results.push(res);
            } catch {}
          }
        }
      }
    }

    // Sort by best score: Net PnL * Sharpe / (MaxDrawdown + 1)
    results.sort((a, b) => {
      const scoreA = (a.netPnLUSDT * Math.max(0.1, a.sharpeRatio)) / (a.maxDrawdownPct + 1);
      const scoreB = (b.netPnLUSDT * Math.max(0.1, b.sharpeRatio)) / (b.maxDrawdownPct + 1);
      return scoreB - scoreA;
    });

    return results;
  }

  /**
   * Walk-Forward Validation:
   * Splits 90-day dataset into 60 days In-Sample (Train) and 30 days Out-of-Sample (Validate).
   * Validates if top discovered configuration persists out-of-sample without overfitting.
   */
  public static runWalkForward(
    klines: Kline[],
    baseSymbol: string,
    fundingRates: FundingRateRecord[] = [],
    options: BacktestOptions = {}
  ): WalkForwardResult {
    if (!klines || klines.length < 100) {
      throw new Error('Date insuficiente pentru Walk-Forward Validation (minim 100 lumânări).');
    }

    // Split roughly 66% train (60 days) and 34% test (30 days)
    const splitIndex = Math.floor(klines.length * 0.67);
    const inSampleKlines = klines.slice(0, splitIndex);
    const outOfSampleKlines = klines.slice(splitIndex);

    // 1. Optimize on In-Sample
    const inSampleVariations = this.testVariations(inSampleKlines, baseSymbol, fundingRates, options);
    const bestConfig = inSampleVariations.length > 0
      ? inSampleVariations[0].config
      : createDefaultBotConfig(
          baseSymbol,
          inSampleKlines[0].close * 0.97,
          inSampleKlines[0].close * 1.03,
          8,
          'ARITHMETIC',
          3,
          50,
          15,
          30
        );

    const isResult = this.runSimulation(inSampleKlines, bestConfig, fundingRates, options);

    // 2. Test exact same config Out-Of-Sample
    // Re-anchor lower/upper bounds proportionally to out-of-sample starting price
    const anchorRatio = outOfSampleKlines[0].open / inSampleKlines[0].open;
    const oosConfig: NeutralGridBotConfig = {
      ...bestConfig,
      lowerPrice: parseFloat((bestConfig.lowerPrice * anchorRatio).toFixed(2)),
      upperPrice: parseFloat((bestConfig.upperPrice * anchorRatio).toFixed(2)),
    };

    const oosResult = this.runSimulation(outOfSampleKlines, oosConfig, fundingRates, options);

    // 3. Robustness scoring
    const isMonthlyRoi = isResult.netPnLPct / 2; // 60 days ~ 2 months
    const oosMonthlyRoi = oosResult.netPnLPct; // 30 days ~ 1 month
    const walkForwardEfficiencyPct = isMonthlyRoi > 0
      ? parseFloat(((oosMonthlyRoi / isMonthlyRoi) * 100).toFixed(1))
      : 0;

    let overfittingScore = 50;
    if (oosResult.netPnLUSDT > 0 && isResult.netPnLUSDT > 0) {
      if (walkForwardEfficiencyPct >= 70) overfittingScore = 15; // Highly robust
      else if (walkForwardEfficiencyPct >= 45) overfittingScore = 30; // Acceptable
      else overfittingScore = 65; // Moderate decay
    } else if (oosResult.netPnLUSDT <= 0 && isResult.netPnLUSDT > 0) {
      overfittingScore = 85; // Overfitted
    } else {
      overfittingScore = 75;
    }

    const isRobust = overfittingScore <= 35 && oosResult.netPnLUSDT > 0 && !oosResult.wasLiquidated;

    return {
      symbol: baseSymbol,
      inSample: isResult,
      outOfSample: oosResult,
      walkForwardEfficiencyPct,
      overfittingScore,
      isRobust,
      recommendedConfig: oosConfig,
    };
  }

  /**
   * Three-Way Comparison:
   * 1. 24/7 unconstrained grid
   * 2. Filtered by Best Hours
   * 3. Filtered by Pattern Miner rules
   */
  public static runComparison(
    klines: Kline[],
    config: NeutralGridBotConfig,
    fundingRates: FundingRateRecord[],
    bestHours: number[],
    patternBlockedIndices: Set<number>,
    options: BacktestOptions = {}
  ): ComparisonResult {
    const res247 = this.runSimulation(klines, config, fundingRates, {
      ...options,
      allowedHoursUtc: undefined,
      patternFilterIndices: undefined,
    });

    const resBestHours = this.runSimulation(klines, config, fundingRates, {
      ...options,
      allowedHoursUtc: new Set(bestHours),
      patternFilterIndices: undefined,
    });

    const resPattern = this.runSimulation(klines, config, fundingRates, {
      ...options,
      allowedHoursUtc: undefined,
      patternFilterIndices: patternBlockedIndices,
    });

    const alphaBestHoursPct = parseFloat((resBestHours.netPnLPct - res247.netPnLPct).toFixed(2));
    const alphaPatternFilteredPct = parseFloat((resPattern.netPnLPct - res247.netPnLPct).toFixed(2));

    return {
      mode247: res247,
      bestHoursMode: resBestHours,
      patternFilteredMode: resPattern,
      bestHoursList: bestHours,
      alphaBestHoursPct,
      alphaPatternFilteredPct,
    };
  }
}
