import fs from 'fs';
import path from 'path';
import {
  BtcGridDirection,
  BtcHistoricalCalibrationResult,
  BtcIndicatorContribution,
  BtcMarketIndicatorsSnapshot,
  BtcMonitoredBot,
  BtcMonitoredBotDirection,
  BtcSignalHistoryEntry,
  BtcSignalRecommendation,
  BtcSignalRiskStatus,
  BtcSignalsConfig,
  BtcSignalsFullStatus,
  BtcSignalsStatusSummary,
  BtcSupportResistanceLevel,
  Kline,
  XPerpAssetKey,
} from '../../../shared/types';
import { telegramService } from '../../telegram/TelegramService';
import { formatBucharestDateTime } from '../../utils/timezone';
import {
  choppinessIndex,
  efficiencyRatioFromKlines,
  wilderAdx,
} from './gridRegime';

export interface BtcReadOnlyOkxPort {
  hasCredentials(): boolean;
  isCredentialsPermanentlyFailed(): boolean;
  getAuthStatus?: () => { failed: boolean; message: string };
  getLastNativeGridError?: () => string;
  resolveLiveInstrumentId(symbol: string): Promise<string>;
  getKlines(symbol: string, interval: string, limit?: number): Promise<Kline[]>;
  getTickerPrice(symbol: string): Promise<number | null>;
  fetchMarketIntelligenceExtras(instId: string): Promise<{
    openInterestUSD: number;
    fundingRatePct: number;
    nextFundingRatePct: number;
    orderBookImbalance: number;
    orderBookDepthUSD: number;
    spreadBps: number;
  }>;
  getNativeContractGridBots(
    mode?: 'pending' | 'history',
    isDemo?: boolean,
    includeAllDirections?: boolean,
    instId?: string
  ): Promise<any[]>;
  getNativeContractGridDetails(algoId: string, isDemo?: boolean): Promise<any | null>;
}

export interface BtcTelegramPort {
  isConfigured(): boolean;
  isNotificationsEnabled(): boolean;
  sendMessage(text: string, targetChatId?: string, force?: boolean): Promise<boolean>;
}

export const DEFAULT_BTC_SIGNALS_CONFIG: BtcSignalsConfig = {
  enabled: true,
  analysisIntervalSec: 120,
  botMonitorIntervalSec: 30,
  minProbabilityEdgePct: 54,
  signalValidityMinutes: 30,
  trackedAlgoIds: [],
  telegramPreferences: {
    onLongOpportunity: true,
    onShortOpportunity: true,
    onBotClosed: true,
    onNextRecommendation: true,
    onSignalInvalidated: true,
  },
};

export function sanitizeTrackedAlgoIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  for (const item of raw) {
    const clean = String(item ?? '').trim();
    if (/^\d{4,32}$/.test(clean)) {
      seen.add(clean);
      if (seen.size >= 10) break;
    }
  }
  return Array.from(seen);
}

const BTC_RANGE_SPAN_USD = 1000;
const BTC_GRID_COUNT = 10;
const BTC_GRID_STEP_USD = 100;
const BTC_TP_MARGIN_PCT = 5;
const BTC_SL_MARGIN_PCT = 2.5;
const MIN_CALIBRATION_BARS = 100;
const MIN_CALIBRATION_SAMPLES = 8;

interface XPerpAssetSpec {
  asset: XPerpAssetKey;
  defaultInstId: string;
  displayInstrument: string;
  stateFileName: string;
  fixedRangeSpanUSD: number | null;
  highVolAtrPct: number;
  priceDecimals: number;
  gridDecimals: number;
}

const XPERP_ASSET_SPECS: Record<XPerpAssetKey, XPerpAssetSpec> = {
  BTC: {
    asset: 'BTC',
    defaultInstId: 'BTC-USD_UM_XPERP',
    displayInstrument: 'BTC-USD UM X-PERP',
    stateFileName: 'btc_xperp_signals.json',
    fixedRangeSpanUSD: BTC_RANGE_SPAN_USD,
    highVolAtrPct: 1.8,
    priceDecimals: 1,
    gridDecimals: 0,
  },
  ZEC: {
    asset: 'ZEC',
    defaultInstId: 'ZEC-USD_UM_XPERP',
    displayInstrument: 'ZEC-USD UM X-PERP',
    stateFileName: 'zec_xperp_signals.json',
    fixedRangeSpanUSD: null,
    highVolAtrPct: 3.0,
    priceDecimals: 2,
    gridDecimals: 1,
  },
};

interface PersistedBtcSignalsState {
  config: BtcSignalsConfig;
  instId: string;
  currentPrice: number;
  lastAnalysisAt: number;
  lastBotSyncAt: number;
  activeRecommendation: BtcSignalRecommendation | null;
  activeBots: BtcMonitoredBot[];
  recentClosedBots: BtcMonitoredBot[];
  signalHistory: BtcSignalHistoryEntry[];
  notifiedClosedAlgoIds: string[];
  lastDispatchedSignalSignature: string;
  lastDispatchedSignalAt: number;
  lastInvalidatedSignalId: string;
  lastClosedDirection: BtcGridDirection | null;
}

export function isXPerpInstrumentForAsset(
  asset: XPerpAssetKey,
  rawInstId?: string,
  instFamily?: string
): boolean {
  const inst = String(rawInstId || '').trim().toUpperCase();
  const family = String(instFamily || '').trim().toUpperCase();
  if (!inst) return false;
  const prefix = `${asset}-USD`;
  if (inst.startsWith(prefix) && inst.includes('_UM_XPERP')) return true;
  if (family.startsWith(prefix) && inst.includes('XPERP')) return true;
  return false;
}

export function isBtcXPerpInstrument(rawInstId?: string, instFamily?: string): boolean {
  return isXPerpInstrumentForAsset('BTC', rawInstId, instFamily);
}

export function computeEmaSeries(values: number[], period: number): number[] {
  if (!values || values.length === 0) return [];
  const k = 2 / (period + 1);
  const out: number[] = [values[0]];
  for (let i = 1; i < values.length; i++) {
    out.push(values[i] * k + out[i - 1] * (1 - k));
  }
  return out;
}

export function computeRsi(closes: number[], period: number = 14): number | null {
  const usable = (closes || []).filter((c) => Number.isFinite(c) && c > 0);
  if (usable.length < period + 2) return null;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const diff = usable[i] - usable[i - 1];
    if (diff >= 0) gainSum += diff;
    else lossSum += Math.abs(diff);
  }

  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;

  for (let i = period + 1; i < usable.length; i++) {
    const diff = usable[i] - usable[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss <= 1e-12) return 99;
  const rs = avgGain / avgLoss;
  const rsi = 100 - 100 / (1 + rs);
  return Number.isFinite(rsi) ? parseFloat(Math.max(1, Math.min(99, rsi)).toFixed(2)) : null;
}

export function computeWilderDiAndAdx(
  klines: Kline[],
  period: number = 14
): { adx: number | null; plusDi: number | null; minusDi: number | null } {
  const adx = wilderAdx(klines, period);
  const usable = (klines || []).filter(
    (k) => k && Number.isFinite(k.high) && Number.isFinite(k.low) && Number.isFinite(k.close)
  );
  if (usable.length < period + 2) {
    return { adx, plusDi: null, minusDi: null };
  }

  const trList: number[] = [];
  const plusDmList: number[] = [];
  const minusDmList: number[] = [];
  for (let i = 1; i < usable.length; i++) {
    const cur = usable[i];
    const prev = usable[i - 1];
    const upMove = cur.high - prev.high;
    const downMove = prev.low - cur.low;
    trList.push(
      Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close))
    );
    plusDmList.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDmList.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }
  if (trList.length < period) {
    return { adx, plusDi: null, minusDi: null };
  }

  let smoothTr = 0;
  let smoothPlusDm = 0;
  let smoothMinusDm = 0;
  for (let i = 0; i < period; i++) {
    smoothTr += trList[i];
    smoothPlusDm += plusDmList[i];
    smoothMinusDm += minusDmList[i];
  }
  for (let i = period; i < trList.length; i++) {
    smoothTr = smoothTr - smoothTr / period + trList[i];
    smoothPlusDm = smoothPlusDm - smoothPlusDm / period + plusDmList[i];
    smoothMinusDm = smoothMinusDm - smoothMinusDm / period + minusDmList[i];
  }
  if (smoothTr <= 1e-12) {
    return { adx, plusDi: null, minusDi: null };
  }

  return {
    adx,
    plusDi: parseFloat(((smoothPlusDm / smoothTr) * 100).toFixed(1)),
    minusDi: parseFloat(((smoothMinusDm / smoothTr) * 100).toFixed(1)),
  };
}

export function computeAtrUsd(klines: Kline[], period: number = 14): { atrUsd: number; atrPct: number } {
  const usable = (klines || []).filter(
    (k) => k && Number.isFinite(k.high) && Number.isFinite(k.low) && Number.isFinite(k.close) && k.close > 0
  );
  if (usable.length < 2) return { atrUsd: 0, atrPct: 0 };
  const slice = usable.slice(-Math.min(period, usable.length));
  let sumTr = 0;
  for (let i = 0; i < slice.length; i++) {
    const cur = slice[i];
    const prevClose = i > 0 ? slice[i - 1].close : cur.open || cur.close;
    sumTr += Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prevClose),
      Math.abs(cur.low - prevClose)
    );
  }
  const atrUsd = sumTr / slice.length;
  const lastClose = usable[usable.length - 1].close;
  return {
    atrUsd: parseFloat(atrUsd.toFixed(2)),
    atrPct: lastClose > 0 ? parseFloat(((atrUsd / lastClose) * 100).toFixed(3)) : 0,
  };
}

export function detectMarketStructure(
  klines: Kline[]
): 'BULLISH_HH_HL' | 'BEARISH_LH_LL' | 'RANGE' {
  if (!klines || klines.length < 20) return 'RANGE';
  const swingHighs: number[] = [];
  const swingLows: number[] = [];
  for (let i = 2; i < klines.length - 2; i++) {
    const c = klines[i];
    if (
      c.high > klines[i - 1].high &&
      c.high > klines[i - 2].high &&
      c.high > klines[i + 1].high &&
      c.high > klines[i + 2].high
    ) {
      swingHighs.push(c.high);
    }
    if (
      c.low < klines[i - 1].low &&
      c.low < klines[i - 2].low &&
      c.low < klines[i + 1].low &&
      c.low < klines[i + 2].low
    ) {
      swingLows.push(c.low);
    }
  }

  if (swingHighs.length >= 2 && swingLows.length >= 2) {
    const lastH = swingHighs[swingHighs.length - 1];
    const prevH = swingHighs[swingHighs.length - 2];
    const lastL = swingLows[swingLows.length - 1];
    const prevL = swingLows[swingLows.length - 2];
    if (lastH > prevH && lastL > prevL) return 'BULLISH_HH_HL';
    if (lastH < prevH && lastL < prevL) return 'BEARISH_LH_LL';
  }

  const closes = klines.map((k) => k.close);
  const ema20 = computeEmaSeries(closes, 20);
  const ema50 = computeEmaSeries(closes, 50);
  const lastE20 = ema20[ema20.length - 1];
  const lastE50 = ema50[ema50.length - 1];
  const lastClose = closes[closes.length - 1];
  if (lastClose > lastE20 && lastE20 > lastE50 * 1.002) return 'BULLISH_HH_HL';
  if (lastClose < lastE20 && lastE20 < lastE50 * 0.998) return 'BEARISH_LH_LL';
  return 'RANGE';
}

export function computeSupportResistanceClusters(klines: Kline[]): BtcSupportResistanceLevel[] {
  if (!klines || klines.length < 15) return [];
  const currentPrice = klines[klines.length - 1].close;
  if (!(currentPrice > 0)) return [];

  const pivots: Array<{ price: number; type: 'SUPPORT' | 'RESISTANCE' }> = [];
  for (let i = 2; i < klines.length - 2; i++) {
    const c = klines[i];
    if (
      c.high > klines[i - 1].high &&
      c.high > klines[i - 2].high &&
      c.high > klines[i + 1].high &&
      c.high > klines[i + 2].high
    ) {
      pivots.push({ price: c.high, type: 'RESISTANCE' });
    }
    if (
      c.low < klines[i - 1].low &&
      c.low < klines[i - 2].low &&
      c.low < klines[i + 1].low &&
      c.low < klines[i + 2].low
    ) {
      pivots.push({ price: c.low, type: 'SUPPORT' });
    }
  }
  if (pivots.length === 0) return [];

  const tolerancePct = 0.004; // 0.4% for BTC (~$350-$400)
  const clusters: Array<{
    type: 'SUPPORT' | 'RESISTANCE';
    prices: number[];
    avgPrice: number;
    touchCount: number;
  }> = [];

  for (const p of pivots) {
    let matched = false;
    for (const cl of clusters) {
      if (cl.type === p.type && Math.abs(p.price - cl.avgPrice) / cl.avgPrice < tolerancePct) {
        cl.prices.push(p.price);
        cl.avgPrice = cl.prices.reduce((s, v) => s + v, 0) / cl.prices.length;
        cl.touchCount++;
        matched = true;
        break;
      }
    }
    if (!matched) {
      clusters.push({
        type: p.type,
        prices: [p.price],
        avgPrice: p.price,
        touchCount: 1,
      });
    }
  }

  const levels: BtcSupportResistanceLevel[] = clusters.map((c) => {
    const type: 'SUPPORT' | 'RESISTANCE' = c.avgPrice <= currentPrice ? 'SUPPORT' : 'RESISTANCE';
    const distPct = ((c.avgPrice - currentPrice) / currentPrice) * 100;
    return {
      price: parseFloat(c.avgPrice.toFixed(1)),
      type,
      distancePct: parseFloat(distPct.toFixed(2)),
      touchCount: c.touchCount,
      strengthScore: Math.min(5, Math.max(1, c.touchCount)),
    };
  });

  const supports = levels
    .filter((l) => l.type === 'SUPPORT')
    .sort((a, b) => b.price - a.price)
    .slice(0, 4);
  const resistances = levels
    .filter((l) => l.type === 'RESISTANCE')
    .sort((a, b) => a.price - b.price)
    .slice(0, 4);

  return [...supports, ...resistances];
}

/**
 * Calibrates LONG and SHORT probabilities empirically from historical OKX candles using walk-forward
 * barrier evaluation (simulating 5% margin TP vs 2.5% margin SL directional grid outcomes at ~5x).
 * Returns INSUFFICIENT_DATA whenever candles or matched historical setups are below minimum thresholds.
 */
export function calibrateBtcHistoricalProbabilities(
  klines1h: Kline[],
  liveDirectionalBias: number
): BtcHistoricalCalibrationResult {
  if (!klines1h || klines1h.length < MIN_CALIBRATION_BARS) {
    return {
      status: 'INSUFFICIENT_DATA',
      longProbabilityPct: null,
      shortProbabilityPct: null,
      longSampleCount: 0,
      longWinCount: 0,
      longEmpiricalWinRatePct: null,
      shortSampleCount: 0,
      shortWinCount: 0,
      shortEmpiricalWinRatePct: null,
      totalEvaluatedBars: klines1h ? klines1h.length : 0,
      minRequiredSamples: MIN_CALIBRATION_SAMPLES,
      note: `Date insuficiente pentru probabilitate validată (${klines1h?.length || 0}/${MIN_CALIBRATION_BARS} lumânări 1H necesare).`,
    };
  }

  const closes = klines1h.map((k) => k.close);
  const ema20 = computeEmaSeries(closes, 20);
  const ema50 = computeEmaSeries(closes, 50);

  const lookbackStart = 50;
  const forwardHorizon = 12; // 12 hours forward evaluation
  const maxIdx = klines1h.length - forwardHorizon - 1;

  // Approximate price movement equivalent for 5% TP vs 2.5% SL at 5x grid exposure (~1.0% TP vs ~0.5% SL)
  const tpMoveFrac = 0.01;
  const slMoveFrac = 0.005;

  let longSampleCount = 0;
  let longWinCount = 0;
  let shortSampleCount = 0;
  let shortWinCount = 0;
  let totalEvaluatedBars = 0;

  for (let i = lookbackStart; i <= maxIdx; i++) {
    const entryPx = klines1h[i].close;
    if (!(entryPx > 0)) continue;

    const slice = klines1h.slice(0, i + 1);
    const rsi = computeRsi(slice.map((k) => k.close), 14);
    const di = computeWilderDiAndAdx(slice.slice(-40), 14);
    if (rsi === null || di.plusDi === null || di.minusDi === null) continue;

    let bias = 0;
    if (ema20[i] > ema50[i]) bias += 1;
    else if (ema20[i] < ema50[i]) bias -= 1;

    if (entryPx > ema20[i]) bias += 0.5;
    else if (entryPx < ema20[i]) bias -= 0.5;

    if (di.plusDi > di.minusDi) bias += 1;
    else if (di.minusDi > di.plusDi) bias -= 1;

    if (rsi >= 52 && rsi <= 70) bias += 0.5;
    else if (rsi <= 48 && rsi >= 30) bias -= 0.5;
    else if (rsi > 74) bias -= 1; // Overbought mean-reversion bias
    else if (rsi < 26) bias += 1; // Oversold mean-reversion bias

    totalEvaluatedBars++;

    if (bias >= 1) {
      longSampleCount++;
      const tpPx = entryPx * (1 + tpMoveFrac);
      const slPx = entryPx * (1 - slMoveFrac);
      let won: boolean | null = null;
      for (let f = 1; f <= forwardHorizon; f++) {
        const bar = klines1h[i + f];
        if (bar.low <= slPx && bar.high >= tpPx) {
          won = bar.close >= entryPx;
          break;
        }
        if (bar.low <= slPx) {
          won = false;
          break;
        }
        if (bar.high >= tpPx) {
          won = true;
          break;
        }
      }
      if (won === null) {
        won = klines1h[i + forwardHorizon].close > entryPx * 1.001;
      }
      if (won) longWinCount++;
    } else if (bias <= -1) {
      shortSampleCount++;
      const tpPx = entryPx * (1 - tpMoveFrac);
      const slPx = entryPx * (1 + slMoveFrac);
      let won: boolean | null = null;
      for (let f = 1; f <= forwardHorizon; f++) {
        const bar = klines1h[i + f];
        if (bar.high >= slPx && bar.low <= tpPx) {
          won = bar.close <= entryPx;
          break;
        }
        if (bar.high >= slPx) {
          won = false;
          break;
        }
        if (bar.low <= tpPx) {
          won = true;
          break;
        }
      }
      if (won === null) {
        won = klines1h[i + forwardHorizon].close < entryPx * 0.999;
      }
      if (won) shortWinCount++;
    }
  }

  if (longSampleCount < MIN_CALIBRATION_SAMPLES || shortSampleCount < MIN_CALIBRATION_SAMPLES) {
    return {
      status: 'INSUFFICIENT_DATA',
      longProbabilityPct: null,
      shortProbabilityPct: null,
      longSampleCount,
      longWinCount,
      longEmpiricalWinRatePct:
        longSampleCount > 0 ? parseFloat(((longWinCount / longSampleCount) * 100).toFixed(1)) : null,
      shortSampleCount,
      shortWinCount,
      shortEmpiricalWinRatePct:
        shortSampleCount > 0 ? parseFloat(((shortWinCount / shortSampleCount) * 100).toFixed(1)) : null,
      totalEvaluatedBars,
      minRequiredSamples: MIN_CALIBRATION_SAMPLES,
      note: `Date insuficiente pentru probabilitate validată (eșantion istoric LONG: ${longSampleCount}/${MIN_CALIBRATION_SAMPLES}, SHORT: ${shortSampleCount}/${MIN_CALIBRATION_SAMPLES} pe ${totalEvaluatedBars} bare 1H).`,
    };
  }

  const longEmpiricalWinRatePct = parseFloat(((longWinCount / longSampleCount) * 100).toFixed(1));
  const shortEmpiricalWinRatePct = parseFloat(((shortWinCount / shortSampleCount) * 100).toFixed(1));

  // Laplace-smoothed empirical probabilities (prior pseudo-count 4 at neutral 50%)
  const smoothLong = ((longWinCount + 2) / (longSampleCount + 4)) * 100;
  const smoothShort = ((shortWinCount + 2) / (shortSampleCount + 4)) * 100;

  // Modest bounded live confirmation adjustment (+/- max 6 percentage points from real-time score)
  const boundedAdj = Math.max(-6, Math.min(6, liveDirectionalBias * 1.2));
  const longProb = parseFloat(Math.max(15, Math.min(85, smoothLong + boundedAdj)).toFixed(1));
  const shortProb = parseFloat(Math.max(15, Math.min(85, smoothShort - boundedAdj)).toFixed(1));

  return {
    status: 'CALIBRATED',
    longProbabilityPct: longProb,
    shortProbabilityPct: shortProb,
    longSampleCount,
    longWinCount,
    longEmpiricalWinRatePct,
    shortSampleCount,
    shortWinCount,
    shortEmpiricalWinRatePct,
    totalEvaluatedBars,
    minRequiredSamples: MIN_CALIBRATION_SAMPLES,
    note: `Calibrat empiric pe ${totalEvaluatedBars} lumânări 1H reale OKX (LONG: ${longWinCount}/${longSampleCount} = ${longEmpiricalWinRatePct}%, SHORT: ${shortWinCount}/${shortSampleCount} = ${shortEmpiricalWinRatePct}%).`,
  };
}

/**
 * Computes a dynamic $1,000 USD grid band around current BTC price, informed by direction,
 * ATR(1H), and nearest Support/Resistance levels while strictly preserving:
 * - maxPx - minPx === 1000
 * - minPx < currentPrice < maxPx
 */
export function computeDynamicBtcGridRange(params: {
  currentPrice: number;
  direction: BtcGridDirection;
  atr1hUSD: number;
  nearestSupport: BtcSupportResistanceLevel | null;
  nearestResistance: BtcSupportResistanceLevel | null;
}): { minPx: number; maxPx: number } {
  const { currentPrice, direction, atr1hUSD, nearestSupport, nearestResistance } = params;
  const safePrice = Math.max(1000, currentPrice);

  // Volatility shift inside [0.30, 0.45]: high ATR pushes slightly deeper room on favorable side
  const volShift = Math.min(0.08, Math.max(0, (atr1hUSD / safePrice) * 5));
  let belowRatio = direction === 'LONG' ? 0.36 + volShift * 0.4 : 0.64 - volShift * 0.4;

  // Nudge anchor near Support (for LONG) or Resistance (for SHORT) while keeping safe inside-band margin
  let minPx = Math.round(safePrice - BTC_RANGE_SPAN_USD * belowRatio);
  if (direction === 'LONG' && nearestSupport && nearestSupport.price < safePrice) {
    const distBelow = safePrice - nearestSupport.price;
    if (distBelow >= 180 && distBelow <= 520) {
      minPx = Math.round(nearestSupport.price - 60);
    }
  } else if (direction === 'SHORT' && nearestResistance && nearestResistance.price > safePrice) {
    const distAbove = nearestResistance.price - safePrice;
    if (distAbove >= 180 && distAbove <= 520) {
      const targetMax = Math.round(nearestResistance.price + 60);
      minPx = targetMax - BTC_RANGE_SPAN_USD;
    }
  }

  // Enforce strict containment with at least $150 cushion on either edge
  const minEdgeMargin = 150;
  if (safePrice - minPx < minEdgeMargin) {
    minPx = Math.floor(safePrice - minEdgeMargin);
  }
  let maxPx = minPx + BTC_RANGE_SPAN_USD;
  if (maxPx - safePrice < minEdgeMargin) {
    maxPx = Math.ceil(safePrice + minEdgeMargin);
    minPx = maxPx - BTC_RANGE_SPAN_USD;
  }

  return { minPx, maxPx };
}

export function computeDynamicGridRangeForAsset(params: {
  asset: XPerpAssetKey;
  currentPrice: number;
  direction: BtcGridDirection;
  atr1hUSD: number;
  nearestSupport: BtcSupportResistanceLevel | null;
  nearestResistance: BtcSupportResistanceLevel | null;
}): { minPx: number; maxPx: number; rangeSpanUSD: number; gridStepUSD: number } {
  const { asset, currentPrice, direction, atr1hUSD, nearestSupport, nearestResistance } = params;
  if (asset === 'BTC') {
    const { minPx, maxPx } = computeDynamicBtcGridRange({
      currentPrice,
      direction,
      atr1hUSD,
      nearestSupport,
      nearestResistance,
    });
    return {
      minPx,
      maxPx,
      rangeSpanUSD: BTC_RANGE_SPAN_USD,
      gridStepUSD: BTC_GRID_STEP_USD,
    };
  }

  // ZEC / alt-perp dynamic ATR-calibrated band with clean 10-grid step precision
  const safePrice = Math.max(1, currentPrice);
  const rawSpan = Math.max(safePrice * 0.04, atr1hUSD * 3.5);
  let rangeSpanUSD: number;
  let decimals: number;
  if (safePrice >= 200) {
    rangeSpanUSD = Math.max(20, Math.round(rawSpan / 10) * 10);
    decimals = 1;
  } else if (safePrice >= 40) {
    rangeSpanUSD = Math.max(4, Math.round(rawSpan / 2) * 2);
    decimals = 2;
  } else {
    rangeSpanUSD = Math.max(1, parseFloat(rawSpan.toFixed(1)));
    decimals = 2;
  }

  const volShift = Math.min(0.08, Math.max(0, (atr1hUSD / safePrice) * 3));
  const belowRatio = direction === 'LONG' ? 0.36 + volShift * 0.4 : 0.64 - volShift * 0.4;

  const roundPx = (v: number) => parseFloat(v.toFixed(decimals));
  let minPx = roundPx(safePrice - rangeSpanUSD * belowRatio);

  if (direction === 'LONG' && nearestSupport && nearestSupport.price < safePrice) {
    const distBelow = safePrice - nearestSupport.price;
    if (distBelow >= rangeSpanUSD * 0.18 && distBelow <= rangeSpanUSD * 0.55) {
      minPx = roundPx(nearestSupport.price - rangeSpanUSD * 0.06);
    }
  } else if (direction === 'SHORT' && nearestResistance && nearestResistance.price > safePrice) {
    const distAbove = nearestResistance.price - safePrice;
    if (distAbove >= rangeSpanUSD * 0.18 && distAbove <= rangeSpanUSD * 0.55) {
      const targetMax = roundPx(nearestResistance.price + rangeSpanUSD * 0.06);
      minPx = roundPx(targetMax - rangeSpanUSD);
    }
  }

  const minEdgeMargin = rangeSpanUSD * 0.15;
  if (safePrice - minPx < minEdgeMargin) {
    minPx = roundPx(safePrice - minEdgeMargin);
  }
  minPx = Math.max(roundPx(safePrice * 0.5), minPx);
  let maxPx = roundPx(minPx + rangeSpanUSD);
  if (maxPx - safePrice < minEdgeMargin) {
    maxPx = roundPx(safePrice + minEdgeMargin);
    minPx = roundPx(maxPx - rangeSpanUSD);
  }

  const gridStepUSD = parseFloat((rangeSpanUSD / BTC_GRID_COUNT).toFixed(2));
  return { minPx, maxPx, rangeSpanUSD, gridStepUSD };
}

export class BtcXPerpSignalMonitor {
  private okxPort: BtcReadOnlyOkxPort;
  private telegramPort: BtcTelegramPort;
  private assetSpec: XPerpAssetSpec;
  private stateFile: string;
  private state: PersistedBtcSignalsState;

  private isAnalyzing: boolean = false;
  private isSyncingBots: boolean = false;
  private lastAnalysisError?: string;
  private lastBotSyncError?: string;
  private analysisTimer?: NodeJS.Timeout;
  private botMonitorTimer?: NodeJS.Timeout;

  constructor(
    okxPort: BtcReadOnlyOkxPort,
    options?: {
      asset?: XPerpAssetKey;
      dataDir?: string;
      telegramPort?: BtcTelegramPort;
    }
  ) {
    const asset: XPerpAssetKey = options?.asset === 'ZEC' ? 'ZEC' : 'BTC';
    this.assetSpec = XPERP_ASSET_SPECS[asset];
    this.okxPort = okxPort;
    this.telegramPort = options?.telegramPort || telegramService;
    const dataDir = options?.dataDir || path.join(process.cwd(), '.data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    this.stateFile = path.join(dataDir, this.assetSpec.stateFileName);
    this.state = this.loadState();
  }

  private loadState(): PersistedBtcSignalsState {
    const defaults: PersistedBtcSignalsState = {
      config: {
        ...DEFAULT_BTC_SIGNALS_CONFIG,
        telegramPreferences: { ...DEFAULT_BTC_SIGNALS_CONFIG.telegramPreferences },
      },
      instId: this.assetSpec.defaultInstId,
      currentPrice: 0,
      lastAnalysisAt: 0,
      lastBotSyncAt: 0,
      activeRecommendation: null,
      activeBots: [],
      recentClosedBots: [],
      signalHistory: [],
      notifiedClosedAlgoIds: [],
      lastDispatchedSignalSignature: '',
      lastDispatchedSignalAt: 0,
      lastInvalidatedSignalId: '',
      lastClosedDirection: null,
    };

    try {
      if (!fs.existsSync(this.stateFile)) return defaults;
      const raw = fs.readFileSync(this.stateFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return defaults;

      return {
        ...defaults,
        ...parsed,
        config: {
          ...defaults.config,
          ...(parsed.config || {}),
          trackedAlgoIds: sanitizeTrackedAlgoIds(parsed.config?.trackedAlgoIds),
          telegramPreferences: {
            ...defaults.config.telegramPreferences,
            ...(parsed.config?.telegramPreferences || {}),
          },
        },
        activeBots: Array.isArray(parsed.activeBots) ? parsed.activeBots : [],
        recentClosedBots: Array.isArray(parsed.recentClosedBots) ? parsed.recentClosedBots : [],
        signalHistory: Array.isArray(parsed.signalHistory) ? parsed.signalHistory : [],
        notifiedClosedAlgoIds: Array.isArray(parsed.notifiedClosedAlgoIds)
          ? parsed.notifiedClosedAlgoIds
          : [],
      };
    } catch {
      return defaults;
    }
  }

  private saveState(): void {
    try {
      const dir = path.dirname(this.stateFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2), 'utf8');
    } catch (err: any) {
      console.warn('[BtcXPerpSignalMonitor] Failed to persist state:', err?.message || err);
    }
  }

  public start(): void {
    this.rescheduleLoops();
    // Immediate startup sync & analysis in background
    void this.runStartupCycle();
  }

  public stop(): void {
    if (this.analysisTimer) {
      clearInterval(this.analysisTimer);
      this.analysisTimer = undefined;
    }
    if (this.botMonitorTimer) {
      clearInterval(this.botMonitorTimer);
      this.botMonitorTimer = undefined;
    }
  }

  private async runStartupCycle(): Promise<void> {
    await this.syncMonitoredBots().catch(() => {});
    if (this.state.config.enabled) {
      await this.runMarketAnalysis('STARTUP').catch(() => {});
    }
  }

  private rescheduleLoops(): void {
    if (this.analysisTimer) clearInterval(this.analysisTimer);
    if (this.botMonitorTimer) clearInterval(this.botMonitorTimer);

    const botIntervalMs = Math.max(15, this.state.config.botMonitorIntervalSec || 30) * 1000;
    this.botMonitorTimer = setInterval(() => {
      void this.syncMonitoredBots().catch(() => {});
    }, botIntervalMs);

    const analysisIntervalMs = Math.max(30, this.state.config.analysisIntervalSec || 120) * 1000;
    this.analysisTimer = setInterval(() => {
      if (this.state.config.enabled) {
        void this.runMarketAnalysis('SCHEDULE').catch(() => {});
      }
    }, analysisIntervalMs);
  }

  public getConfig(): BtcSignalsConfig {
    return {
      ...this.state.config,
      trackedAlgoIds: [...(this.state.config.trackedAlgoIds || [])],
      telegramPreferences: { ...this.state.config.telegramPreferences },
    };
  }

  public updateConfig(updates: Partial<BtcSignalsConfig>): BtcSignalsConfig {
    const next: BtcSignalsConfig = {
      ...this.state.config,
      ...updates,
      trackedAlgoIds:
        updates.trackedAlgoIds !== undefined
          ? sanitizeTrackedAlgoIds(updates.trackedAlgoIds)
          : sanitizeTrackedAlgoIds(this.state.config.trackedAlgoIds),
      telegramPreferences: {
        ...this.state.config.telegramPreferences,
        ...(updates.telegramPreferences || {}),
      },
    };
    next.analysisIntervalSec = Math.max(
      30,
      Math.min(1800, Math.round(Number(next.analysisIntervalSec) || 120))
    );
    next.botMonitorIntervalSec = Math.max(
      15,
      Math.min(300, Math.round(Number(next.botMonitorIntervalSec) || 30))
    );
    next.minProbabilityEdgePct = Math.max(
      50,
      Math.min(75, Number(next.minProbabilityEdgePct) || 54)
    );
    next.signalValidityMinutes = Math.max(
      5,
      Math.min(240, Math.round(Number(next.signalValidityMinutes) || 30))
    );
    next.enabled = Boolean(next.enabled);

    this.state.config = next;
    this.saveState();
    this.rescheduleLoops();
    return this.getConfig();
  }

  public getStatusSummary(): BtcSignalsStatusSummary {
    const rec = this.state.activeRecommendation;
    return {
      asset: this.assetSpec.asset,
      displayInstrument: this.assetSpec.displayInstrument,
      enabled: this.state.config.enabled,
      instId: this.state.instId,
      currentPrice: this.state.currentPrice,
      recommendedDirection: rec ? rec.direction : null,
      probabilityStatus: rec ? rec.probabilityStatus : 'INSUFFICIENT_DATA',
      longProbabilityPct: rec ? rec.longProbabilityPct : null,
      shortProbabilityPct: rec ? rec.shortProbabilityPct : null,
      riskStatus: rec ? rec.riskStatus : 'INSUFFICIENT_DATA',
      activeBotsCount: this.state.activeBots.filter((b) => b.state === 'running').length,
      lastAnalysisAt: this.state.lastAnalysisAt,
      lastBotSyncAt: this.state.lastBotSyncAt,
    };
  }

  public getFullStatus(): BtcSignalsFullStatus {
    return {
      asset: this.assetSpec.asset,
      displayInstrument: this.assetSpec.displayInstrument,
      config: this.getConfig(),
      readOnlyGuaranteed: true,
      instId: this.state.instId,
      currentPrice: this.state.currentPrice,
      isAnalyzing: this.isAnalyzing,
      isSyncingBots: this.isSyncingBots,
      lastAnalysisAt: this.state.lastAnalysisAt,
      lastBotSyncAt: this.state.lastBotSyncAt,
      lastAnalysisError: this.lastAnalysisError,
      lastBotSyncError: this.lastBotSyncError,
      activeRecommendation: this.state.activeRecommendation,
      activeBots: this.state.activeBots,
      recentClosedBots: this.state.recentClosedBots,
      signalHistory: this.state.signalHistory,
      telegramConfigured: this.telegramPort.isConfigured(),
      telegramNotificationsEnabled: this.telegramPort.isNotificationsEnabled(),
    };
  }

  private async resolveBtcInstrument(): Promise<string> {
    try {
      const resolved = await this.okxPort.resolveLiveInstrumentId(this.assetSpec.defaultInstId);
      if (resolved && resolved.includes(this.assetSpec.asset) && resolved.includes('_UM_XPERP')) {
        this.state.instId = resolved;
        return resolved;
      }
    } catch {}
    return this.state.instId || this.assetSpec.defaultInstId;
  }

  private mapRawBot(raw: any, fallbackPrice: number): BtcMonitoredBot {
    const algoId = String(raw.algoId || '');
    const instId = String(raw.instId || this.state.instId);
    const rawDir = String(raw.direction || 'neutral').toLowerCase();
    const direction: BtcMonitoredBotDirection =
      rawDir === 'long' ? 'long' : rawDir === 'short' ? 'short' : 'neutral';

    const rawState = String(raw.state || 'running').toLowerCase();
    const state: BtcMonitoredBot['state'] =
      rawState === 'stopped'
        ? 'stopped'
        : rawState === 'no_close_position'
        ? 'no_close_position'
        : rawState === 'stopping'
        ? 'stopping'
        : 'running';

    const minPx = parseFloat(raw.minPx || '0') || 0;
    const maxPx = parseFloat(raw.maxPx || '0') || 0;
    const gridNum = parseInt(raw.gridNum || '10', 10) || 10;
    const lever = parseFloat(raw.lever || '1') || 1;
    const investedMarginUSD = parseFloat(raw.investment || raw.sz || '0') || 0;
    const investmentCcy = String(raw.investmentCcy || raw.ccy || 'USDC').toUpperCase();
    const currentPx = parseFloat(raw.last || raw.curPx || '0') || fallbackPrice || 0;
    const openPx = parseFloat(raw.openPx || raw.runPx || raw.triggerPx || '0') || undefined;
    const liqPx = parseFloat(raw.liqPx || '0') || undefined;

    const gridProfitUSD = parseFloat(raw.gridProfit || '0') || 0;
    const floatProfitUSD = parseFloat(raw.floatProfit || '0') || 0;
    const totalPnlUSD =
      raw.totalPnl !== undefined && raw.totalPnl !== ''
        ? parseFloat(raw.totalPnl) || 0
        : gridProfitUSD + floatProfitUSD;
    const totalPnlPct =
      investedMarginUSD > 0
        ? parseFloat(((totalPnlUSD / investedMarginUSD) * 100).toFixed(2))
        : 0;

    const tpRatio = parseFloat(raw.tpRatio || '0') || undefined;
    const slRatio = parseFloat(raw.slRatio || '0') || undefined;
    const tpMarginPct = tpRatio ? parseFloat((tpRatio * 100).toFixed(2)) : undefined;
    const slMarginPct = slRatio ? parseFloat((slRatio * 100).toFixed(2)) : undefined;
    const tpMarginUSD =
      tpRatio && investedMarginUSD > 0
        ? parseFloat((investedMarginUSD * tpRatio).toFixed(2))
        : undefined;
    const slMarginUSD =
      slRatio && investedMarginUSD > 0
        ? parseFloat((investedMarginUSD * slRatio).toFixed(2))
        : undefined;

    const tpTriggerPx = parseFloat(raw.tpTriggerPx || '0') || undefined;
    const slTriggerPx = parseFloat(raw.slTriggerPx || '0') || undefined;

    const bandPositionPct =
      currentPx > 0 && maxPx > minPx
        ? parseFloat(
            Math.max(0, Math.min(100, ((currentPx - minPx) / (maxPx - minPx)) * 100)).toFixed(1)
          )
        : null;

    const targetTpPct = tpMarginPct ?? BTC_TP_MARGIN_PCT;
    const targetSlPct = slMarginPct ?? BTC_SL_MARGIN_PCT;
    const tpProgressPct =
      targetTpPct > 0
        ? parseFloat(Math.max(0, Math.min(100, (totalPnlPct / targetTpPct) * 100)).toFixed(1))
        : null;
    const slProgressPct =
      targetSlPct > 0 && totalPnlPct < 0
        ? parseFloat(
            Math.max(0, Math.min(100, (Math.abs(totalPnlPct) / targetSlPct) * 100)).toFixed(1)
          )
        : 0;

    const cancelType = raw.cancelType ? String(raw.cancelType) : undefined;
    let closeReasonLabel: string | undefined;
    if (state === 'stopped' || state === 'no_close_position') {
      const ct = (cancelType || '').toLowerCase();
      if (ct.includes('tp') || ct === '2' || (tpMarginPct && totalPnlPct >= tpMarginPct * 0.9)) {
        closeReasonLabel = 'Take Profit atins (OKX)';
      } else if (
        ct.includes('sl') ||
        ct === '3' ||
        (slMarginPct && totalPnlPct <= -slMarginPct * 0.9)
      ) {
        closeReasonLabel = 'Stop Loss atins (OKX)';
      } else if (ct === '1' || ct.includes('manual')) {
        closeReasonLabel = 'Închidere manuală (OKX)';
      } else if (state === 'no_close_position') {
        closeReasonLabel = 'Oprit (poziție păstrată pe OKX)';
      } else {
        closeReasonLabel = cancelType
          ? `Închis pe OKX (cod ${cancelType})`
          : 'Oprit / Închis pe OKX';
      }
    }

    return {
      algoId,
      instId,
      direction,
      state,
      closeReasonLabel,
      cancelType,
      currentPx,
      openPx,
      liqPx,
      minPx,
      maxPx,
      gridNum,
      lever,
      investedMarginUSD: parseFloat(investedMarginUSD.toFixed(2)),
      investmentCcy,
      tpRatio,
      slRatio,
      tpMarginPct,
      slMarginPct,
      tpMarginUSD,
      slMarginUSD,
      tpTriggerPx,
      slTriggerPx,
      gridProfitUSD: parseFloat(gridProfitUSD.toFixed(4)),
      floatProfitUSD: parseFloat(floatProfitUSD.toFixed(4)),
      totalPnlUSD: parseFloat(totalPnlUSD.toFixed(4)),
      totalPnlPct,
      arbitrageNum: parseInt(raw.arbitrageNum || raw.matchedSz || '0', 10) || 0,
      bandPositionPct,
      tpProgressPct,
      slProgressPct,
      cTime: parseInt(raw.cTime || String(Date.now()), 10) || Date.now(),
      uTime: parseInt(raw.uTime || String(Date.now()), 10) || Date.now(),
    };
  }

  /**
   * Strictly READ-ONLY synchronization of BTC-USD UM X-PERP native bots (LONG / SHORT / NEUTRAL).
   * Never calls any create, amend, stop, or close endpoints.
   */
  public async syncMonitoredBots(): Promise<{
    activeBots: BtcMonitoredBot[];
    newlyClosedBots: BtcMonitoredBot[];
  }> {
    if (this.isSyncingBots) {
      return { activeBots: this.state.activeBots, newlyClosedBots: [] };
    }
    this.isSyncingBots = true;
    this.lastBotSyncError = undefined;

    try {
      const instId = await this.resolveBtcInstrument();
      const livePx = (await this.okxPort.getTickerPrice(instId).catch(() => null)) || this.state.currentPrice;
      if (livePx && livePx > 0) {
        this.state.currentPrice = livePx;
      }

      if (!this.okxPort.hasCredentials()) {
        this.lastBotSyncError =
          'Cheile API OKX nu sunt configurate. Configurează API Key, Secret și Passphrase în tabul [5: CONEXIUNE OKX EEA].';
        this.state.lastBotSyncAt = Date.now();
        this.saveState();
        return { activeBots: this.state.activeBots, newlyClosedBots: [] };
      }

      if (this.okxPort.isCredentialsPermanentlyFailed()) {
        const authStatus = this.okxPort.getAuthStatus?.();
        this.lastBotSyncError =
          authStatus?.message ||
          'Autentificarea OKX este suspendată (Cod 50105 / cheie invalidă). Verifică acreditările în tabul [5: CONEXIUNE OKX EEA].';
        this.state.lastBotSyncAt = Date.now();
        this.saveState();
        return { activeBots: this.state.activeBots, newlyClosedBots: [] };
      }

      // Fetch ALL directions (long, short, neutral) from OKX read-only endpoints.
      // Query pending first so any OKX API/auth error is captured cleanly without overwriting activeBots.
      const pendingRaw = await this.okxPort.getNativeContractGridBots('pending', false, true);
      const pendingError = this.okxPort.getLastNativeGridError?.() || '';
      const historyRaw = await this.okxPort.getNativeContractGridBots('history', false, true);

      if (pendingError && pendingRaw.length === 0) {
        this.lastBotSyncError = pendingError;
        this.state.lastBotSyncAt = Date.now();
        this.saveState();
        return { activeBots: this.state.activeBots, newlyClosedBots: [] };
      }

      const prevActiveIds = new Set(
        this.state.activeBots.filter((b) => b.state === 'running' || b.state === 'stopping').map((b) => b.algoId)
      );

      const btcPendingRaw = pendingRaw.filter((r) =>
        isXPerpInstrumentForAsset(this.assetSpec.asset, r?.instId, r?.instFamily)
      );
      const btcHistoryRaw = historyRaw.filter((r) =>
        isXPerpInstrumentForAsset(this.assetSpec.asset, r?.instId, r?.instFamily)
      );

      const pendingAlgoIds = new Set(
        btcPendingRaw.map((r) => String(r?.algoId || '')).filter(Boolean)
      );
      const historyAlgoIds = new Set(
        btcHistoryRaw.map((r) => String(r?.algoId || '')).filter(Boolean)
      );

      const activeBots: BtcMonitoredBot[] = [];
      for (const raw of btcPendingRaw) {
        const algoId = String(raw.algoId || '');
        if (!algoId) continue;
        // Fetch live details for accurate TP/SL, liqPx, floatProfit & PnL metrics (read-only)
        const details = await this.okxPort.getNativeContractGridDetails(algoId, false).catch(() => null);
        const merged = details ? { ...raw, ...details } : raw;
        const mapped = this.mapRawBot(merged, this.state.currentPrice);
        if (mapped.state === 'running' || mapped.state === 'stopping') {
          activeBots.push(mapped);
        }
      }

      // Direct read-only lookup fallback for user-pinned algoIds (e.g. if OKX listing omitted a directional bot)
      const trackedIds = sanitizeTrackedAlgoIds(this.state.config.trackedAlgoIds);
      const extraClosedFromTracked: any[] = [];
      const assetPrefix = `${this.assetSpec.asset}-`;
      for (const trackedId of trackedIds) {
        if (pendingAlgoIds.has(trackedId)) continue;
        const details = await this.okxPort
          .getNativeContractGridDetails(trackedId, false)
          .catch(() => null);
        if (!details) continue;
        const detInst = String(details.instId || '').toUpperCase();
        const isAssetContract =
          isXPerpInstrumentForAsset(this.assetSpec.asset, details.instId, details.instFamily) ||
          detInst.startsWith(assetPrefix);
        if (!isAssetContract) continue;
        const mapped = this.mapRawBot(details, this.state.currentPrice);
        if (mapped.state === 'running' || mapped.state === 'stopping') {
          activeBots.push(mapped);
        } else if (!historyAlgoIds.has(trackedId)) {
          extraClosedFromTracked.push(details);
        }
      }

      const activeIdSet = new Set(activeBots.map((b) => b.algoId));
      const historyMap = new Map<string, any>();
      for (const h of [...btcHistoryRaw, ...extraClosedFromTracked]) {
        if (h?.algoId) historyMap.set(String(h.algoId), h);
      }

      // Detect newly closed bots (either transitioned from prevActiveIds or found newly closed in history)
      const newlyClosedBots: BtcMonitoredBot[] = [];
      const candidateClosedIds = new Set<string>();
      for (const prevId of prevActiveIds) {
        if (!activeIdSet.has(prevId)) candidateClosedIds.add(prevId);
      }
      for (const h of [...btcHistoryRaw.slice(0, 10), ...extraClosedFromTracked]) {
        const id = String(h?.algoId || '');
        if (id && !activeIdSet.has(id) && !this.state.notifiedClosedAlgoIds.includes(id)) {
          // Only trigger live close alert if it was previously tracked as active OR closed very recently (last 15m)
          const uTime = parseInt(h.uTime || '0', 10) || 0;
          if (prevActiveIds.has(id) || (uTime > 0 && Date.now() - uTime <= 15 * 60_000)) {
            candidateClosedIds.add(id);
          }
        }
      }

      for (const closedId of candidateClosedIds) {
        if (this.state.notifiedClosedAlgoIds.includes(closedId)) continue;
        // Confirm terminal state explicitly via OKX orders-algo-details + history
        const details = await this.okxPort.getNativeContractGridDetails(closedId, false).catch(() => null);
        const histRaw = historyMap.get(closedId);
        const merged = details ? { ...(histRaw || {}), ...details } : histRaw;
        if (!merged) continue;

        const remState = String(merged.state || '').toLowerCase();
        if (remState !== 'stopped' && remState !== 'no_close_position' && !histRaw) {
          continue;
        }

        const closedBot = this.mapRawBot(
          { ...merged, state: remState === 'no_close_position' ? 'no_close_position' : 'stopped' },
          this.state.currentPrice
        );
        closedBot.confirmedClosedAt = Date.now();
        newlyClosedBots.push(closedBot);
      }

      // Build clean recent closed bots list from history + newly confirmed closures
      const closedMap = new Map<string, BtcMonitoredBot>();
      for (const cb of newlyClosedBots) {
        closedMap.set(cb.algoId, cb);
      }
      for (const h of [...btcHistoryRaw.slice(0, 25), ...extraClosedFromTracked]) {
        const mapped = this.mapRawBot({ ...h, state: h.state || 'stopped' }, this.state.currentPrice);
        if (!closedMap.has(mapped.algoId)) {
          closedMap.set(mapped.algoId, mapped);
        }
      }
      for (const prevClosed of this.state.recentClosedBots) {
        if (!closedMap.has(prevClosed.algoId)) {
          closedMap.set(prevClosed.algoId, prevClosed);
        }
      }

      this.state.activeBots = activeBots;
      this.state.recentClosedBots = Array.from(closedMap.values())
        .sort((a, b) => b.uTime - a.uTime)
        .slice(0, 40);
      this.state.lastBotSyncAt = Date.now();

      // Continuity workflow when one or more bots close:
      // 1) Record closed direction, 2) Immediately dispatch existing valid recommendation on Telegram,
      // 3) Trigger fresh post-close analysis immediately.
      if (newlyClosedBots.length > 0) {
        for (const closedBot of newlyClosedBots) {
          if (closedBot.direction === 'long' || closedBot.direction === 'short') {
            this.state.lastClosedDirection = closedBot.direction.toUpperCase() as BtcGridDirection;
          }
          this.state.notifiedClosedAlgoIds.push(closedBot.algoId);
          if (this.state.notifiedClosedAlgoIds.length > 200) {
            this.state.notifiedClosedAlgoIds = this.state.notifiedClosedAlgoIds.slice(-200);
          }
          await this.handleConfirmedBotClosure(closedBot);
        }
      }

      // Also check if active recommendation was invalidated by live price movement
      await this.checkAndHandleSignalInvalidation();

      this.saveState();
      return { activeBots, newlyClosedBots };
    } catch (err: any) {
      this.lastBotSyncError = err?.message || 'Eroare la sincronizarea boților BTC OKX';
      return { activeBots: this.state.activeBots, newlyClosedBots: [] };
    } finally {
      this.isSyncingBots = false;
    }
  }

  private isRecommendationStillValid(rec: BtcSignalRecommendation | null, price: number): boolean {
    if (!rec) return false;
    if (rec.invalidatedAt) return false;
    if (Date.now() > rec.validUntil) return false;
    if (price > 0 && (price < rec.minPx || price > rec.maxPx)) return false;
    return true;
  }

  private async checkAndHandleSignalInvalidation(): Promise<void> {
    const rec = this.state.activeRecommendation;
    const px = this.state.currentPrice;
    if (!rec || rec.invalidatedAt || !(px > 0)) return;

    let reason: string | undefined;
    if (px < rec.minPx || px > rec.maxPx) {
      reason = `Prețul ${this.assetSpec.asset} ($${px.toFixed(this.assetSpec.priceDecimals)}) a ieșit din intervalul recomandat ($${rec.minPx} – $${rec.maxPx}).`;
    } else if (Date.now() > rec.validUntil) {
      reason = `Semnalul a expirat după fereastra de valabilitate (${formatBucharestDateTime(new Date(rec.validUntil))}).`;
    }

    if (!reason) return;

    rec.invalidatedAt = Date.now();
    rec.invalidatedReason = reason;
    rec.riskStatus = 'INVALIDATED';
    const histItem = this.state.signalHistory.find((h) => h.id === rec.id);
    if (histItem) {
      histItem.invalidatedAt = rec.invalidatedAt;
      histItem.invalidatedReason = reason;
    }

    if (
      this.state.config.telegramPreferences.onSignalInvalidated &&
      this.state.lastInvalidatedSignalId !== rec.id
    ) {
      this.state.lastInvalidatedSignalId = rec.id;
      const msg =
        `⚠️ INVALIDARE SEMNAL ${this.assetSpec.displayInstrument}\n\n` +
        `• Direcție anterioară: ${rec.direction}\n` +
        `• Interval recomandat: $${rec.minPx} – $${rec.maxPx}\n` +
        `• Preț ${this.assetSpec.asset} curent: $${px.toFixed(this.assetSpec.priceDecimals)}\n` +
        `• Motiv: ${reason}\n` +
        `• Ora: ${formatBucharestDateTime()} (București)`;
      await this.telegramPort.sendMessage(msg).catch(() => false);
    }
  }

  private async handleConfirmedBotClosure(closedBot: BtcMonitoredBot): Promise<void> {
    const prefs = this.state.config.telegramPreferences;
    const validRec = this.isRecommendationStillValid(
      this.state.activeRecommendation,
      this.state.currentPrice
    )
      ? this.state.activeRecommendation
      : null;

    if (prefs.onBotClosed) {
      const dirLabel = closedBot.direction.toUpperCase();
      const pnlSign = closedBot.totalPnlUSD >= 0 ? '+' : '';
      const closeMsg =
        `🏁 BOT ${this.assetSpec.displayInstrument} ÎNCHIS (${dirLabel})\n\n` +
        `• Algo ID: ${closedBot.algoId}\n` +
        `• Instrument: ${closedBot.instId}\n` +
        `• Motiv închidere: ${closedBot.closeReasonLabel || closedBot.state}\n` +
        `• Invested Margin: $${closedBot.investedMarginUSD.toFixed(2)}\n` +
        `• PnL Realizat + Total: ${pnlSign}$${closedBot.totalPnlUSD.toFixed(2)} (${pnlSign}${closedBot.totalPnlPct.toFixed(2)}%)\n` +
        `• Arbitraje finalizate: ${closedBot.arbitrageNum}\n` +
        `• Preț ${this.assetSpec.asset} actual: $${(this.state.currentPrice || closedBot.currentPx).toFixed(this.assetSpec.priceDecimals)}\n` +
        `• Ora confirmării: ${formatBucharestDateTime()} (București)`;
      await this.telegramPort.sendMessage(closeMsg).catch(() => false);
    }

    // Immediate next recommendation dispatch from cached latest analysis if still valid
    if (prefs.onNextRecommendation && validRec) {
      const recMsg = this.formatRecommendationTelegramMessage(
        validRec,
        '🤖 RECOMANDARE IMEDIATĂ PENTRU URMĂTORUL BOT (DUPĂ ÎNCHIDERE)'
      );
      const sent = await this.telegramPort.sendMessage(recMsg).catch(() => false);
      if (sent) {
        this.state.lastDispatchedSignalSignature = this.buildSignalSignature(validRec);
        this.state.lastDispatchedSignalAt = Date.now();
      }
    }

    // Trigger immediate fresh analysis right after confirmed bot closure (non-blocking if called in loop)
    if (this.state.config.enabled) {
      await this.runMarketAnalysis('BOT_CLOSED').catch(() => {});
    }
  }

  /**
   * Runs full multi-timeframe BTC-USD UM X-PERP market analysis, computes verifiable calibrated
   * LONG/SHORT probabilities, builds the $1,000 / 10-grid / TP 5% / SL 2.5% recommendation, and
   * notifies Telegram when a new non-duplicate opportunity or invalidation occurs.
   */
  public async runMarketAnalysis(
    trigger: 'STARTUP' | 'SCHEDULE' | 'BOT_CLOSED' | 'MANUAL' = 'MANUAL'
  ): Promise<BtcSignalRecommendation> {
    if (this.isAnalyzing && this.state.activeRecommendation) {
      return this.state.activeRecommendation;
    }
    this.isAnalyzing = true;
    this.lastAnalysisError = undefined;

    try {
      const instId = await this.resolveBtcInstrument();

      const [klines15m, klines1h, klines4h, tickerPx, extras] = await Promise.all([
        this.okxPort.getKlines(instId, '15m', 120),
        this.okxPort.getKlines(instId, '1H', 240),
        this.okxPort.getKlines(instId, '4H', 90),
        this.okxPort.getTickerPrice(instId).catch(() => null),
        this.okxPort.fetchMarketIntelligenceExtras(instId).catch(() => ({
          openInterestUSD: 0,
          fundingRatePct: 0,
          nextFundingRatePct: 0,
          orderBookImbalance: 0,
          orderBookDepthUSD: 0,
          spreadBps: 0,
        })),
      ]);

      const latestKlinePx =
        klines15m[klines15m.length - 1]?.close ||
        klines1h[klines1h.length - 1]?.close ||
        0;
      const currentPrice = tickerPx && tickerPx > 0 ? tickerPx : latestKlinePx;
      if (!(currentPrice > 0)) {
        throw new Error(`Nu s-a putut obține prețul curent OKX pentru ${instId}.`);
      }
      this.state.currentPrice = currentPrice;

      // 24h metrics from 1H klines (last 24 bars)
      const bars24h = klines1h.slice(-24);
      const high24h = bars24h.length > 0 ? Math.max(...bars24h.map((k) => k.high)) : currentPrice;
      const low24h = bars24h.length > 0 ? Math.min(...bars24h.map((k) => k.low)) : currentPrice;
      const open24h = bars24h.length > 0 ? bars24h[0].open || currentPrice : currentPrice;
      const priceChange24hPct = parseFloat((((currentPrice - open24h) / open24h) * 100).toFixed(2));
      const volume24hUSD = Math.round(
        bars24h.reduce((s, k) => s + (Number(k.volume) || 0) * k.close, 0)
      );

      // Indicators computation
      const closes1h = klines1h.map((k) => k.close);
      const closes4h = klines4h.map((k) => k.close);
      const closes15m = klines15m.map((k) => k.close);

      const ema20_1hSeries = computeEmaSeries(closes1h, 20);
      const ema50_1hSeries = computeEmaSeries(closes1h, 50);
      const ema20_4hSeries = computeEmaSeries(closes4h, 20);
      const ema50_4hSeries = computeEmaSeries(closes4h, 50);

      const ema20_1h = parseFloat((ema20_1hSeries[ema20_1hSeries.length - 1] || currentPrice).toFixed(1));
      const ema50_1h = parseFloat((ema50_1hSeries[ema50_1hSeries.length - 1] || currentPrice).toFixed(1));
      const ema20_4h = parseFloat((ema20_4hSeries[ema20_4hSeries.length - 1] || currentPrice).toFixed(1));
      const ema50_4h = parseFloat((ema50_4hSeries[ema50_4hSeries.length - 1] || currentPrice).toFixed(1));

      const structure1h = detectMarketStructure(klines1h.slice(-48));
      const structure4h = detectMarketStructure(klines4h.slice(-48));

      const adx15m = wilderAdx(klines15m, 14);
      const di1h = computeWilderDiAndAdx(klines1h, 14);
      const choppiness1h = choppinessIndex(klines1h, 14);
      const efficiencyRatio1h = efficiencyRatioFromKlines(klines1h, 16);

      const rsi15m = computeRsi(closes15m, 14);
      const rsi1h = computeRsi(closes1h, 14);

      const atr15m = computeAtrUsd(klines15m, 14);
      const atr1h = computeAtrUsd(klines1h, 14);

      // Volume ratio & candle buy/sell pressure on 1H
      const volBars = klines1h.slice(-23);
      const prevVolAvg =
        volBars.length > 3
          ? volBars.slice(0, -3).reduce((s, k) => s + (k.volume || 0), 0) / Math.max(1, volBars.length - 3)
          : 0;
      const recentVolAvg =
        volBars.slice(-3).reduce((s, k) => s + (k.volume || 0), 0) / Math.max(1, Math.min(3, volBars.length));
      const volumeRatio1h = prevVolAvg > 0 ? parseFloat((recentVolAvg / prevVolAvg).toFixed(2)) : 1.0;

      const pressureBars = klines1h.slice(-12);
      let buyVolWeight = 0;
      let totalVolWeight = 0;
      for (const b of pressureBars) {
        const span = Math.max(1e-6, b.high - b.low);
        const pos = Math.max(0, Math.min(1, (b.close - b.low) / span));
        const w = Math.max(1, b.volume || 1);
        buyVolWeight += pos * w;
        totalVolWeight += w;
      }
      const volumeBuyPressurePct =
        totalVolWeight > 0 ? parseFloat(((buyVolWeight / totalVolWeight) * 100).toFixed(1)) : 50;

      // Support & Resistance levels
      const srLevels = computeSupportResistanceClusters(klines1h.slice(-160));
      const nearestSupport =
        srLevels.filter((l) => l.type === 'SUPPORT').sort((a, b) => b.price - a.price)[0] || null;
      const nearestResistance =
        srLevels.filter((l) => l.type === 'RESISTANCE').sort((a, b) => a.price - b.price)[0] || null;

      const indicators: BtcMarketIndicatorsSnapshot = {
        instId,
        currentPrice,
        priceChange24hPct,
        high24h,
        low24h,
        volume24hUSD,
        ema20_1h,
        ema50_1h,
        ema20_4h,
        ema50_4h,
        structure1h,
        structure4h,
        adx15m,
        adx1h: di1h.adx,
        plusDi1h: di1h.plusDi,
        minusDi1h: di1h.minusDi,
        choppiness1h,
        efficiencyRatio1h,
        rsi15m,
        rsi1h,
        atr15mUSD: atr15m.atrUsd,
        atr15mPct: atr15m.atrPct,
        atr1hUSD: atr1h.atrUsd,
        atr1hPct: atr1h.atrPct,
        volumeRatio1h,
        volumeBuyPressurePct,
        fundingRatePct: extras.fundingRatePct,
        nextFundingRatePct: extras.nextFundingRatePct,
        openInterestUSD: extras.openInterestUSD,
        orderBookImbalance: extras.orderBookImbalance,
        orderBookDepthUSD: extras.orderBookDepthUSD,
        spreadBps: extras.spreadBps,
        nearestSupport,
        nearestResistance,
        supportResistanceLevels: srLevels,
        candles15mCount: klines15m.length,
        candles1hCount: klines1h.length,
        candles4hCount: klines4h.length,
      };

      // Transparent verifiable contributions per indicator
      const contributions: BtcIndicatorContribution[] = [];

      // 1. Price Action & Structure
      let paLong = 0;
      let paShort = 0;
      if (structure1h === 'BULLISH_HH_HL') paLong += 1.5;
      else if (structure1h === 'BEARISH_LH_LL') paShort += 1.5;
      if (structure4h === 'BULLISH_HH_HL') paLong += 1.0;
      else if (structure4h === 'BEARISH_LH_LL') paShort += 1.0;
      if (currentPrice > ema20_1h && ema20_1h >= ema50_1h) paLong += 1.0;
      else if (currentPrice < ema20_1h && ema20_1h <= ema50_1h) paShort += 1.0;
      contributions.push({
        key: 'price_action',
        label: 'Price Action & Structură',
        valueText: `1H: ${structure1h} / 4H: ${structure4h}`,
        favoredDirection: paLong > paShort ? 'LONG' : paShort > paLong ? 'SHORT' : 'NEUTRAL',
        longWeight: paLong,
        shortWeight: paShort,
        detail: `EMA20 1H $${ema20_1h} vs EMA50 1H $${ema50_1h}`,
      });

      // 2. Trend & ADX (+DI / -DI)
      let adxLong = 0;
      let adxShort = 0;
      if (di1h.plusDi !== null && di1h.minusDi !== null) {
        const diff = di1h.plusDi - di1h.minusDi;
        if (diff > 3) adxLong += (di1h.adx || 0) >= 20 ? 2.0 : 1.0;
        else if (diff < -3) adxShort += (di1h.adx || 0) >= 20 ? 2.0 : 1.0;
      }
      contributions.push({
        key: 'adx_trend',
        label: 'Trend & ADX(14)',
        valueText: `ADX 1H: ${di1h.adx ?? 'N/A'} (+DI ${di1h.plusDi ?? '-'} / -DI ${di1h.minusDi ?? '-'})`,
        favoredDirection: adxLong > adxShort ? 'LONG' : adxShort > adxLong ? 'SHORT' : 'NEUTRAL',
        longWeight: adxLong,
        shortWeight: adxShort,
        detail: `ADX 15m: ${adx15m ?? 'N/A'} · Chop 1H: ${choppiness1h ?? 'N/A'}`,
      });

      // 3. RSI(14)
      let rsiLong = 0;
      let rsiShort = 0;
      if (rsi1h !== null) {
        if (rsi1h <= 34) rsiLong += 2.0; // Oversold bounce favorable for LONG
        else if (rsi1h >= 52 && rsi1h <= 64) rsiLong += 1.0;
        else if (rsi1h >= 68) rsiShort += 2.0; // Overbought pullback favorable for SHORT
        else if (rsi1h <= 48 && rsi1h >= 36) rsiShort += 1.0;
      }
      contributions.push({
        key: 'rsi',
        label: 'RSI(14)',
        valueText: `1H: ${rsi1h ?? 'N/A'} · 15m: ${rsi15m ?? 'N/A'}`,
        favoredDirection: rsiLong > rsiShort ? 'LONG' : rsiShort > rsiLong ? 'SHORT' : 'NEUTRAL',
        longWeight: rsiLong,
        shortWeight: rsiShort,
        detail:
          rsi1h === null
            ? 'RSI indisponibil'
            : rsi1h >= 68
            ? 'Zonă supracumpărată (avantaj SHORT)'
            : rsi1h <= 34
            ? 'Zonă supravândută (avantaj LONG)'
            : 'Momentum echilibrat',
      });

      // 4. Support & Resistance proximity
      let srLong = 0;
      let srShort = 0;
      if (nearestSupport && Math.abs(nearestSupport.distancePct) <= 0.8) {
        srLong += 1.5;
      }
      if (nearestResistance && Math.abs(nearestResistance.distancePct) <= 0.8) {
        srShort += 1.5;
      }
      contributions.push({
        key: 'support_resistance',
        label: 'Support & Resistance',
        valueText: `S: ${nearestSupport ? `$${nearestSupport.price}` : 'N/A'} / R: ${nearestResistance ? `$${nearestResistance.price}` : 'N/A'}`,
        favoredDirection: srLong > srShort ? 'LONG' : srShort > srLong ? 'SHORT' : 'NEUTRAL',
        longWeight: srLong,
        shortWeight: srShort,
        detail: `Dist S: ${nearestSupport ? `${nearestSupport.distancePct}%` : '-'} · Dist R: ${nearestResistance ? `${nearestResistance.distancePct}%` : '-'}`,
      });

      // 5. Volume pressure
      let volLong = 0;
      let volShort = 0;
      if (volumeBuyPressurePct >= 56 && volumeRatio1h >= 0.9) volLong += 1.2;
      else if (volumeBuyPressurePct <= 44 && volumeRatio1h >= 0.9) volShort += 1.2;
      contributions.push({
        key: 'volume',
        label: 'Volum & Presiune',
        valueText: `Ratio ${volumeRatio1h}x · Buy ${volumeBuyPressurePct}%`,
        favoredDirection: volLong > volShort ? 'LONG' : volShort > volLong ? 'SHORT' : 'NEUTRAL',
        longWeight: volLong,
        shortWeight: volShort,
        detail: `Volum 24h: $${(volume24hUSD / 1e6).toFixed(1)}M`,
      });

      // 6. Funding Rate (crowding / carry)
      let fundLong = 0;
      let fundShort = 0;
      if (extras.fundingRatePct > 0.03) fundShort += 1.0; // Crowded longs + funding cost
      else if (extras.fundingRatePct < -0.015) fundLong += 1.0; // Crowded shorts
      contributions.push({
        key: 'funding_rate',
        label: 'Funding Rate',
        valueText: `${extras.fundingRatePct.toFixed(4)}% (urm: ${extras.nextFundingRatePct.toFixed(4)}%)`,
        favoredDirection: fundLong > fundShort ? 'LONG' : fundShort > fundLong ? 'SHORT' : 'NEUTRAL',
        longWeight: fundLong,
        shortWeight: fundShort,
        detail:
          extras.fundingRatePct > 0.03
            ? 'Funding pozitiv ridicat (favorabil contrarian SHORT)'
            : extras.fundingRatePct < -0.015
            ? 'Funding negativ (favorabil LONG)'
            : 'Funding neutru',
      });

      // 7. Liquidity & OrderBook
      let liqLong = 0;
      let liqShort = 0;
      if (extras.orderBookImbalance >= 0.15) liqLong += 1.0;
      else if (extras.orderBookImbalance <= -0.15) liqShort += 1.0;
      contributions.push({
        key: 'liquidity',
        label: 'Lichiditate & OrderBook',
        valueText: `Imb ${(extras.orderBookImbalance * 100).toFixed(0)}% · Spread ${extras.spreadBps.toFixed(1)}bps`,
        favoredDirection: liqLong > liqShort ? 'LONG' : liqShort > liqLong ? 'SHORT' : 'NEUTRAL',
        longWeight: liqLong,
        shortWeight: liqShort,
        detail: `OI: $${(extras.openInterestUSD / 1e6).toFixed(1)}M · Depth: $${(extras.orderBookDepthUSD / 1e3).toFixed(0)}k`,
      });

      // 8. ATR & Volatility
      contributions.push({
        key: 'atr_volatility',
        label: 'ATR & Volatilitate',
        valueText: `ATR 1H: $${atr1h.atrUsd} (${atr1h.atrPct}%)`,
        favoredDirection: 'NEUTRAL',
        longWeight: 0,
        shortWeight: 0,
        detail: `ATR 15m: $${atr15m.atrUsd} (${atr15m.atrPct}%) — folosit la calibrarea benzii de $1,000`,
      });

      const totalLongWeight = contributions.reduce((s, c) => s + c.longWeight, 0);
      const totalShortWeight = contributions.reduce((s, c) => s + c.shortWeight, 0);
      const liveDirectionalBias = totalLongWeight - totalShortWeight;

      // Historical walk-forward calibration
      const calibration = calibrateBtcHistoricalProbabilities(klines1h, liveDirectionalBias);

      // Determine recommended direction with preference for contextual alternation when tied
      const lastDir =
        this.state.lastClosedDirection ||
        (this.state.recentClosedBots[0]?.direction === 'long'
          ? 'LONG'
          : this.state.recentClosedBots[0]?.direction === 'short'
          ? 'SHORT'
          : null);

      let direction: BtcGridDirection;
      if (
        calibration.status === 'CALIBRATED' &&
        calibration.longProbabilityPct !== null &&
        calibration.shortProbabilityPct !== null
      ) {
        const diffProb = calibration.longProbabilityPct - calibration.shortProbabilityPct;
        if (Math.abs(diffProb) >= 1.5) {
          direction = diffProb > 0 ? 'LONG' : 'SHORT';
        } else if (Math.abs(liveDirectionalBias) >= 0.5) {
          direction = liveDirectionalBias > 0 ? 'LONG' : 'SHORT';
        } else if (lastDir) {
          direction = lastDir === 'LONG' ? 'SHORT' : 'LONG';
        } else {
          direction = 'LONG';
        }
      } else {
        if (Math.abs(liveDirectionalBias) >= 0.5) {
          direction = liveDirectionalBias > 0 ? 'LONG' : 'SHORT';
        } else if (lastDir) {
          direction = lastDir === 'LONG' ? 'SHORT' : 'LONG';
        } else {
          direction = 'LONG';
        }
      }

      const chosenDirectionProbabilityPct =
        calibration.status === 'CALIBRATED'
          ? direction === 'LONG'
            ? calibration.longProbabilityPct
            : calibration.shortProbabilityPct
          : null;
      const oppositeProb =
        calibration.status === 'CALIBRATED'
          ? direction === 'LONG'
            ? calibration.shortProbabilityPct
            : calibration.longProbabilityPct
          : null;
      const probabilityEdgePct =
        chosenDirectionProbabilityPct !== null && oppositeProb !== null
          ? parseFloat((chosenDirectionProbabilityPct - oppositeProb).toFixed(1))
          : null;

      // Risk evaluation
      const riskReasons: string[] = [];
      let riskStatus: BtcSignalRiskStatus = 'VALID';

      if (calibration.status === 'INSUFFICIENT_DATA') {
        riskStatus = 'INSUFFICIENT_DATA';
        riskReasons.push('Date insuficiente pentru probabilitate validată pe istoricul OKX.');
      } else if (
        chosenDirectionProbabilityPct !== null &&
        chosenDirectionProbabilityPct < this.state.config.minProbabilityEdgePct
      ) {
        riskStatus = 'HIGH_RISK';
        riskReasons.push(
          `Probabilitatea calibrată (${chosenDirectionProbabilityPct}%) este sub pragul minim recomandat (${this.state.config.minProbabilityEdgePct}%).`
        );
      }

      if (Math.abs(liveDirectionalBias) < 1.0) {
        if (riskStatus === 'VALID') riskStatus = 'HIGH_RISK';
        riskReasons.push('Semnale mixte între indicatori — piață fără direcție dominantă clară.');
      }
      if (atr1h.atrPct > this.assetSpec.highVolAtrPct) {
        if (riskStatus === 'VALID') riskStatus = 'HIGH_RISK';
        riskReasons.push(`Volatilitate ridicată (ATR 1H ${atr1h.atrPct}% / $${atr1h.atrUsd}) — risc de atingere rapidă a SL 2.5%.`);
      }
      if (extras.spreadBps > 8) {
        if (riskStatus === 'VALID') riskStatus = 'HIGH_RISK';
        riskReasons.push(`Spread ridicat (${extras.spreadBps.toFixed(1)} bps).`);
      }

      const { minPx, maxPx, rangeSpanUSD, gridStepUSD } = computeDynamicGridRangeForAsset({
        asset: this.assetSpec.asset,
        currentPrice,
        direction,
        atr1hUSD: atr1h.atrUsd,
        nearestSupport,
        nearestResistance,
      });

      const favoredArgs = contributions
        .filter((c) => c.favoredDirection === direction)
        .map((c) => `${c.label}: ${c.valueText} (${c.detail})`);
      const argsList =
        favoredArgs.length > 0
          ? favoredArgs
          : [
              `Structură 1H ${structure1h} / 4H ${structure4h}`,
              `RSI 1H: ${rsi1h ?? 'N/A'} | ADX 1H: ${di1h.adx ?? 'N/A'}`,
              `ATR 1H: $${atr1h.atrUsd} | Funding: ${extras.fundingRatePct.toFixed(4)}%`,
            ];

      const issuedAt = Date.now();
      const validUntil = issuedAt + this.state.config.signalValidityMinutes * 60_000;

      const recommendation: BtcSignalRecommendation = {
        id: `${this.assetSpec.asset}_SIG_${issuedAt}`,
        asset: this.assetSpec.asset,
        instId,
        displayInstrument: this.assetSpec.displayInstrument,
        botType: 'OKX Native Futures Grid',
        direction,
        preferredAlternationFrom: lastDir,
        currentPrice: parseFloat(currentPrice.toFixed(this.assetSpec.priceDecimals)),
        minPx,
        maxPx,
        rangeSpanUSD,
        gridNum: BTC_GRID_COUNT,
        gridStepUSD,
        tpMarginPct: BTC_TP_MARGIN_PCT,
        slMarginPct: BTC_SL_MARGIN_PCT,
        tpSlBasis: 'INVESTED_MARGIN',
        probabilityStatus: calibration.status,
        longProbabilityPct: calibration.longProbabilityPct,
        shortProbabilityPct: calibration.shortProbabilityPct,
        chosenDirectionProbabilityPct,
        probabilityEdgePct,
        riskStatus,
        riskReasons,
        arguments: argsList,
        contributions,
        calibration,
        indicators,
        issuedAt,
        validUntil,
      };

      this.state.activeRecommendation = recommendation;
      this.state.lastAnalysisAt = issuedAt;

      // Telegram dispatch with strict deduplication
      const telegramSent = await this.maybeSendOpportunityTelegram(recommendation, trigger);

      const histEntry: BtcSignalHistoryEntry = {
        id: recommendation.id,
        issuedAt,
        direction,
        instId,
        priceAtSignal: recommendation.currentPrice,
        minPx,
        maxPx,
        probabilityStatus: calibration.status,
        chosenProbabilityPct: chosenDirectionProbabilityPct,
        longProbabilityPct: calibration.longProbabilityPct,
        shortProbabilityPct: calibration.shortProbabilityPct,
        riskStatus,
        trigger,
        telegramSent,
      };
      this.state.signalHistory = [histEntry, ...this.state.signalHistory].slice(0, 100);
      this.saveState();

      return recommendation;
    } catch (err: any) {
      this.lastAnalysisError = err?.message || `Eroare la analiza ${this.assetSpec.displayInstrument}`;
      throw err;
    } finally {
      this.isAnalyzing = false;
    }
  }

  private buildSignalSignature(rec: BtcSignalRecommendation): string {
    const bucketUnit = Math.max(1, rec.gridStepUSD || 100);
    const minBucket = Math.round(rec.minPx / bucketUnit) * bucketUnit;
    return `${this.assetSpec.asset}:${rec.direction}:${minBucket}:${rec.riskStatus}:${rec.probabilityStatus}`;
  }

  private async maybeSendOpportunityTelegram(
    rec: BtcSignalRecommendation,
    trigger: 'STARTUP' | 'SCHEDULE' | 'BOT_CLOSED' | 'MANUAL'
  ): Promise<boolean> {
    const prefs = this.state.config.telegramPreferences;
    const dirAllowed =
      (rec.direction === 'LONG' && prefs.onLongOpportunity) ||
      (rec.direction === 'SHORT' && prefs.onShortOpportunity);
    if (!dirAllowed) return false;

    // On automatic background cycles, do not spam when riskStatus is HIGH_RISK/INSUFFICIENT_DATA unless direction changed or manual
    if (trigger !== 'MANUAL' && rec.riskStatus !== 'VALID') {
      return false;
    }

    const sig = this.buildSignalSignature(rec);
    const sameSigRecent =
      this.state.lastDispatchedSignalSignature === sig &&
      Date.now() - this.state.lastDispatchedSignalAt < 25 * 60_000;

    if (trigger !== 'MANUAL' && sameSigRecent) {
      return false;
    }

    const title =
      rec.direction === 'LONG'
        ? `🟢 OPORTUNITATE LONG — ${this.assetSpec.displayInstrument}`
        : `🔴 OPORTUNITATE SHORT — ${this.assetSpec.displayInstrument}`;

    const text = this.formatRecommendationTelegramMessage(rec, title);
    const sent = await this.telegramPort.sendMessage(text).catch(() => false);
    if (sent) {
      this.state.lastDispatchedSignalSignature = sig;
      this.state.lastDispatchedSignalAt = Date.now();
    }
    return sent;
  }

  public formatRecommendationTelegramMessage(
    rec: BtcSignalRecommendation,
    header: string
  ): string {
    const probLine =
      rec.probabilityStatus === 'CALIBRATED' && rec.chosenDirectionProbabilityPct !== null
        ? `${rec.chosenDirectionProbabilityPct}% (LONG: ${rec.longProbabilityPct}% | SHORT: ${rec.shortProbabilityPct}%)`
        : 'Date insuficiente pentru probabilitate validată';

    const argsLines =
      rec.arguments.length > 0
        ? rec.arguments.slice(0, 4).map((a) => `  • ${a}`).join('\n')
        : '  • Semnale mixte';

    const riskLine =
      rec.riskReasons.length > 0
        ? `\n⚠️ Risc / Atenționări:\n${rec.riskReasons.map((r) => `  • ${r}`).join('\n')}\n`
        : '';

    return (
      `${header}\n\n` +
      `• Instrument: ${this.assetSpec.displayInstrument} (${rec.instId})\n` +
      `• Direcție recomandată: ${rec.direction} (OKX Native Futures Grid — deschidere manuală)\n` +
      `• Preț ${this.assetSpec.asset} actual: $${rec.currentPrice.toFixed(this.assetSpec.priceDecimals)}\n` +
      `• Interval recomandat: $${rec.minPx} – $${rec.maxPx} (diferență $${rec.rangeSpanUSD})\n` +
      `• Grile: ${rec.gridNum} grile (distanță $${rec.gridStepUSD} / grilă)\n` +
      `• TP / SL: TP ${rec.tpMarginPct}% și SL ${rec.slMarginPct}% din invested margin\n` +
      `• Probabilitate estimată (${rec.direction}): ${probLine}\n` +
      `• Argumente principale:\n${argsLines}\n` +
      riskLine +
      `• Ora emiterii: ${formatBucharestDateTime(new Date(rec.issuedAt))} (București)\n` +
      `• Valabil până la: ${formatBucharestDateTime(new Date(rec.validUntil))} (București)`
    );
  }

  public async sendCurrentRecommendationToTelegram(): Promise<{ success: boolean; error?: string }> {
    const rec = this.state.activeRecommendation || (await this.runMarketAnalysis('MANUAL'));
    if (!this.telegramPort.isConfigured()) {
      return {
        success: false,
        error: 'Telegram nu este configurat. Configurează Token și Chat ID în Tab 5.',
      };
    }
    const header =
      rec.direction === 'LONG'
        ? `🟢 SEMNAL ${this.assetSpec.displayInstrument} — LONG`
        : `🔴 SEMNAL ${this.assetSpec.displayInstrument} — SHORT`;
    const sent = await this.telegramPort.sendMessage(
      this.formatRecommendationTelegramMessage(rec, header),
      undefined,
      true
    );
    return sent
      ? { success: true }
      : { success: false, error: 'Trimiterea mesajului pe Telegram a eșuat.' };
  }
}
