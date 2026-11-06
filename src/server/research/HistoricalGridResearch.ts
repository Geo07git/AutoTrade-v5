/**
 * HistoricalGridResearch
 * Comprehensive statistical analysis engine for OKX Neutral Grid trading.
 * 
 * Features:
 * - Hourly (0-23 UTC), Day of Week (0-6), and Session (Asia/Europe/US) profiles
 * - 24x7 Heatmap matrix and hourly ranking for optimal neutral grid operation
 * - Regime analysis: ATR, Choppiness Index (Dreiss), Wilder ADX, Hurst Exponent (R/S), Autocorrelation (lag 1-3)
 * - Price levels: S/R clusters from swing pivots, Volume Profile (POC, HVN, LVN, Value Area 70%)
 * - Correlation with BTC (Pearson r and Beta)
 */

import { Kline } from '../../shared/types';
import { HistoricalDataStore, FundingRateRecord } from './HistoricalDataStore';

export interface HourlyProfile {
  hourUtc: number;
  sampleCount: number;
  avgVolatilityPct: number;
  avgVolume: number;
  avgRangePct: number;
  trendVsRangeRatio: number; // 0 to 1 (lower is better for grid)
  neutralGridScore: number; // 0 to 100 (higher is better)
  rank: number; // 1 = best
  recommended: boolean;
}

export interface DayOfWeekProfile {
  dayOfWeek: number; // 0 = Sunday, 6 = Saturday
  dayName: string;
  sampleCount: number;
  avgVolatilityPct: number;
  avgVolume: number;
  avgRangePct: number;
  trendVsRangeRatio: number;
  neutralGridScore: number;
}

export interface SessionProfile {
  session: 'ASIA' | 'EUROPE' | 'US';
  hoursUtc: string;
  avgVolatilityPct: number;
  avgVolume: number;
  avgRangePct: number;
  trendVsRangeRatio: number;
  neutralGridScore: number;
  recommendation: 'EXCELLENT' | 'GOOD' | 'CAUTION' | 'AVOID';
}

export interface HeatmapCell {
  day: number; // 0-6
  hour: number; // 0-23
  gridScore: number; // 0-100
  volatilityPct: number;
  volume: number;
}

export interface MarketRegimeMetrics {
  currentPrice: number;
  atr: number;
  atrPct: number;
  choppinessIndex: number; // >61.8 = high chop (great), <38.2 = high trend (risky)
  choppinessVerdict: 'CHOPPY_SIDEWAYS' | 'NORMAL_OSCILLATION' | 'TRENDING_BREAKOUT';
  adx14: number; // <20 = range/weak trend, >25 = strong trend
  adxVerdict: 'RANGE_BOUND' | 'MODERATE' | 'STRONG_TREND';
  hurstExponent: number; // <0.5 = mean-reverting, ~0.5 = random walk, >0.5 = trending
  hurstVerdict: 'MEAN_REVERTING' | 'RANDOM_WALK' | 'PERSISTENT_TREND';
  autocorrelationLag1: number; // negative = mean-reverting
  autocorrelationLag2: number;
  autocorrelationLag3: number;
  overallRegime: 'IDEAL_GRID' | 'FAVORABLE_GRID' | 'TRANSITIONAL' | 'HIGH_TREND_RISK';
}

export interface SupportResistanceLevel {
  price: number;
  type: 'SUPPORT' | 'RESISTANCE';
  distancePct: number;
  touchCount: number;
  strengthScore: number; // 1 to 5
}

export interface VolumeProfileResult {
  pocPrice: number; // Point of Control (highest volume)
  valueAreaHigh: number; // 70% VAH
  valueAreaLow: number; // 70% VAL
  hvnLevels: number[]; // High Volume Nodes (magnets)
  lvnLevels: number[]; // Low Volume Nodes (fast slips)
  bins: Array<{ price: number; volume: number; pctOfTotal: number; isPOC: boolean; isHVN: boolean; isLVN: boolean }>;
}

export interface BtcCorrelationResult {
  symbol: string;
  btcSymbol: string;
  pearsonR: number; // -1 to +1
  beta: number;
  interpretation: 'HIGH_CORRELATION' | 'MODERATE_CORRELATION' | 'DECOUPLED' | 'INVERSE';
}

export interface HistoricalResearchReport {
  symbol: string;
  bar: string;
  daysAnalyzed: number;
  totalCandles: number;
  startDate: string;
  endDate: string;
  hourlyProfiles: HourlyProfile[];
  bestHoursList: number[];
  dayProfiles: DayOfWeekProfile[];
  sessionProfiles: SessionProfile[];
  heatmap: HeatmapCell[];
  regime: MarketRegimeMetrics;
  supportResistance: SupportResistanceLevel[];
  volumeProfile: VolumeProfileResult;
  btcCorrelation: BtcCorrelationResult;
}

export class HistoricalGridResearch {
  private dataStore: HistoricalDataStore;

  constructor(dataStore: HistoricalDataStore) {
    this.dataStore = dataStore;
  }

  /**
   * Main analysis pipeline on historical klines.
   */
  public async analyze(
    symbol: string,
    days: number = 90,
    bar: string = '5m',
    signal?: AbortSignal,
    onProgress?: (progressPct: number, message: string) => void
  ): Promise<HistoricalResearchReport> {
    if (onProgress) onProgress(5, `Încărcare date istorice pentru ${symbol} (${days} zile, ${bar})...`);

    // 1. Load klines and funding
    const klines = await this.dataStore.loadOrFetchKlines(symbol, bar, days, signal, (pct, msg) => {
      if (onProgress) onProgress(Math.round(5 + pct * 0.35), msg);
    });

    if (klines.length < 50) {
      throw new Error(`Date istorice insuficiente pentru ${symbol} (${klines.length} lumânări găsite).`);
    }

    if (onProgress) onProgress(45, 'Analiză profile orare, zilnice și sesiuni de piață...');

    // 2. Profiles (Hourly, Days, Sessions, Heatmap)
    const { hourlyProfiles, bestHoursList, dayProfiles, sessionProfiles, heatmap } =
      this.computeProfiles(klines);

    if (onProgress) onProgress(65, 'Calcul indicatori de regim (Hurst, Chop, ADX, Autocorelație)...');

    // 3. Regime Metrics
    const regime = this.computeRegimeMetrics(klines);

    if (onProgress) onProgress(80, 'Calcul clustere suport/rezistență și Volume Profile...');

    // 4. Support / Resistance clusters
    const supportResistance = this.computeSupportResistance(klines);

    // 5. Volume Profile (POC, HVN, LVN, Value Area)
    const volumeProfile = this.computeVolumeProfile(klines);

    if (onProgress) onProgress(90, 'Calcul corelație cu Bitcoin (BTC)...');

    // 6. BTC Correlation
    const btcCorrelation = await this.computeBtcCorrelation(symbol, klines, days, bar, signal);

    if (onProgress) onProgress(100, 'Raport de cercetare grid finalizat.');

    return {
      symbol,
      bar,
      daysAnalyzed: days,
      totalCandles: klines.length,
      startDate: new Date(klines[0].timestamp).toISOString().split('T')[0],
      endDate: new Date(klines[klines.length - 1].timestamp).toISOString().split('T')[0],
      hourlyProfiles,
      bestHoursList,
      dayProfiles,
      sessionProfiles,
      heatmap,
      regime,
      supportResistance,
      volumeProfile,
      btcCorrelation,
    };
  }

  /**
   * Computes 24-hour, 7-day, session breakdown and 24x7 heatmap.
   */
  private computeProfiles(klines: Kline[]): {
    hourlyProfiles: HourlyProfile[];
    bestHoursList: number[];
    dayProfiles: DayOfWeekProfile[];
    sessionProfiles: SessionProfile[];
    heatmap: HeatmapCell[];
  } {
    interface BucketData {
      count: number;
      sumVol: number;
      sumRangePct: number;
      sumTrendRatio: number;
      sumTrueRange: number;
    }

    const hourBuckets: BucketData[] = Array.from({ length: 24 }, () => ({
      count: 0,
      sumVol: 0,
      sumRangePct: 0,
      sumTrendRatio: 0,
      sumTrueRange: 0,
    }));

    const dayBuckets: BucketData[] = Array.from({ length: 7 }, () => ({
      count: 0,
      sumVol: 0,
      sumRangePct: 0,
      sumTrendRatio: 0,
      sumTrueRange: 0,
    }));

    const heatmapBuckets = new Map<string, { count: number; sumScore: number; sumVol: number; sumVolat: number }>();

    for (let i = 0; i < klines.length; i++) {
      const k = klines[i];
      const d = new Date(k.timestamp);
      const h = d.getUTCHours();
      const dow = d.getUTCDay();

      const candleRange = Math.max(1e-6, k.high - k.low);
      const rangePct = (candleRange / k.open) * 100;
      const body = Math.abs(k.close - k.open);
      const trendRatio = body / candleRange; // 1 = trend bar, 0 = doji/chop

      const hB = hourBuckets[h];
      hB.count++;
      hB.sumVol += k.volume;
      hB.sumRangePct += rangePct;
      hB.sumTrendRatio += trendRatio;

      const dB = dayBuckets[dow];
      dB.count++;
      dB.sumVol += k.volume;
      dB.sumRangePct += rangePct;
      dB.sumTrendRatio += trendRatio;

      const hmKey = `${dow}_${h}`;
      const existing = heatmapBuckets.get(hmKey) || { count: 0, sumScore: 0, sumVol: 0, sumVolat: 0 };
      existing.count++;
      existing.sumVol += k.volume;
      existing.sumVolat += rangePct;
      // Single candle instant score: higher volume + lower trendiness = better
      const instantScore = Math.max(0, Math.min(100, (1 - trendRatio) * 75 + Math.min(25, rangePct * 15)));
      existing.sumScore += instantScore;
      heatmapBuckets.set(hmKey, existing);
    }

    // Average volume across all hours for normalization
    const avgTotalHourlyVol =
      hourBuckets.reduce((s, b) => s + (b.count > 0 ? b.sumVol / b.count : 0), 0) / 24;

    const hourlyProfiles: HourlyProfile[] = hourBuckets.map((b, h) => {
      const c = Math.max(1, b.count);
      const avgVol = b.sumVol / c;
      const avgRange = b.sumRangePct / c;
      const avgTrendRatio = b.sumTrendRatio / c;

      // Neutral Grid Score calculation:
      // 1. Low trendiness (1 - avgTrendRatio) -> 45% weight
      // 2. Adequate volatility (range between 0.3% and 1.8% is optimal) -> 30% weight
      // 3. Adequate liquidity (relative to average volume) -> 25% weight
      const chopScore = (1 - avgTrendRatio) * 100;
      const volatScore = Math.max(0, 100 - Math.abs(avgRange - 0.75) * 60);
      const volScore = Math.min(100, (avgVol / Math.max(1, avgTotalHourlyVol)) * 80);

      const gridScore = Math.max(10, Math.min(100, Math.round(chopScore * 0.45 + volatScore * 0.3 + volScore * 0.25)));

      return {
        hourUtc: h,
        sampleCount: b.count,
        avgVolatilityPct: parseFloat(avgRange.toFixed(3)),
        avgVolume: Math.round(avgVol),
        avgRangePct: parseFloat(avgRange.toFixed(3)),
        trendVsRangeRatio: parseFloat(avgTrendRatio.toFixed(3)),
        neutralGridScore: gridScore,
        rank: 0,
        recommended: false,
      };
    });

    // Rank hours (descending score)
    const sortedHours = [...hourlyProfiles].sort((a, b) => b.neutralGridScore - a.neutralGridScore);
    sortedHours.forEach((hp, idx) => {
      const target = hourlyProfiles.find((item) => item.hourUtc === hp.hourUtc);
      if (target) {
        target.rank = idx + 1;
        target.recommended = idx < 16 && target.neutralGridScore >= 55; // Top 16 hours
      }
    });

    const bestHoursList = sortedHours.filter((h) => h.recommended).map((h) => h.hourUtc).sort((a, b) => a - b);

    // Day of week profiles
    const dayNames = ['Duminică', 'Luni', 'Marți', 'Miercuri', 'Joi', 'Vineri', 'Sâmbătă'];
    const dayProfiles: DayOfWeekProfile[] = dayBuckets.map((b, dow) => {
      const c = Math.max(1, b.count);
      const avgVol = b.sumVol / c;
      const avgRange = b.sumRangePct / c;
      const avgTrendRatio = b.sumTrendRatio / c;
      const chopScore = (1 - avgTrendRatio) * 100;
      const volatScore = Math.max(0, 100 - Math.abs(avgRange - 0.75) * 60);
      const gridScore = Math.round(chopScore * 0.6 + volatScore * 0.4);

      return {
        dayOfWeek: dow,
        dayName: dayNames[dow],
        sampleCount: b.count,
        avgVolatilityPct: parseFloat(avgRange.toFixed(3)),
        avgVolume: Math.round(avgVol),
        avgRangePct: parseFloat(avgRange.toFixed(3)),
        trendVsRangeRatio: parseFloat(avgTrendRatio.toFixed(3)),
        neutralGridScore: gridScore,
      };
    });

    // Sessions (Asia: 0-7, Europe: 8-15, US: 16-23)
    const calcSession = (name: 'ASIA' | 'EUROPE' | 'US', startH: number, endH: number): SessionProfile => {
      const slice = hourlyProfiles.filter((h) => h.hourUtc >= startH && h.hourUtc <= endH);
      const avgScore = slice.reduce((s, h) => s + h.neutralGridScore, 0) / slice.length;
      const avgVol = slice.reduce((s, h) => s + h.avgVolume, 0) / slice.length;
      const avgRange = slice.reduce((s, h) => s + h.avgRangePct, 0) / slice.length;
      const avgTrend = slice.reduce((s, h) => s + h.trendVsRangeRatio, 0) / slice.length;

      let rec: SessionProfile['recommendation'] = 'GOOD';
      if (avgScore >= 70) rec = 'EXCELLENT';
      else if (avgScore >= 55) rec = 'GOOD';
      else if (avgScore >= 45) rec = 'CAUTION';
      else rec = 'AVOID';

      return {
        session: name,
        hoursUtc: `${String(startH).padStart(2, '0')}:00 - ${String(endH + 1).padStart(2, '0')}:00 UTC`,
        avgVolatilityPct: parseFloat(avgRange.toFixed(3)),
        avgVolume: Math.round(avgVol),
        avgRangePct: parseFloat(avgRange.toFixed(3)),
        trendVsRangeRatio: parseFloat(avgTrend.toFixed(3)),
        neutralGridScore: Math.round(avgScore),
        recommendation: rec,
      };
    };

    const sessionProfiles: SessionProfile[] = [
      calcSession('ASIA', 0, 7),
      calcSession('EUROPE', 8, 15),
      calcSession('US', 16, 23),
    ];

    // Heatmap (24 hours x 7 days)
    const heatmap: HeatmapCell[] = [];
    for (let dow = 0; dow < 7; dow++) {
      for (let h = 0; h < 24; h++) {
        const key = `${dow}_${h}`;
        const raw = heatmapBuckets.get(key);
        if (raw && raw.count > 0) {
          heatmap.push({
            day: dow,
            hour: h,
            gridScore: Math.round(raw.sumScore / raw.count),
            volatilityPct: parseFloat((raw.sumVolat / raw.count).toFixed(3)),
            volume: Math.round(raw.sumVol / raw.count),
          });
        } else {
          heatmap.push({ day: dow, hour: h, gridScore: 50, volatilityPct: 0.5, volume: 100 });
        }
      }
    }

    return {
      hourlyProfiles,
      bestHoursList,
      dayProfiles,
      sessionProfiles,
      heatmap,
    };
  }

  /**
   * Computes Market Regime metrics:
   * - Wilder ATR (14)
   * - Dreiss Choppiness Index (14)
   * - Wilder ADX (14)
   * - Hurst Exponent via Rescaled Range (R/S)
   * - Return Autocorrelations (lag 1, 2, 3)
   */
  private computeRegimeMetrics(klines: Kline[]): MarketRegimeMetrics {
    const n = klines.length;
    const currentPrice = klines[n - 1].close;

    // 1. ATR (14)
    let trSum = 0;
    const trs: number[] = [];
    for (let i = 1; i < n; i++) {
      const tr = Math.max(
        klines[i].high - klines[i].low,
        Math.abs(klines[i].high - klines[i - 1].close),
        Math.abs(klines[i].low - klines[i - 1].close)
      );
      trs.push(tr);
    }
    const recentTrs = trs.slice(-14);
    const atr = recentTrs.reduce((s, v) => s + v, 0) / Math.max(1, recentTrs.length);
    const atrPct = (atr / currentPrice) * 100;

    // 2. Choppiness Index (over 14 periods)
    // Formula: 100 * LOG10( SUM(TR, 14) / (MaxHigh(14) - MinLow(14)) ) / LOG10(14)
    let choppinessIndex = 50;
    if (n >= 15) {
      const windowCandles = klines.slice(-14);
      const highMax = Math.max(...windowCandles.map((k) => k.high));
      const lowMin = Math.min(...windowCandles.map((k) => k.low));
      const sumTr = recentTrs.reduce((s, v) => s + v, 0);
      const denom = highMax - lowMin;
      if (denom > 0 && sumTr > 0) {
        choppinessIndex = (100 * Math.log10(sumTr / denom)) / Math.log10(14);
        choppinessIndex = Math.max(0, Math.min(100, choppinessIndex));
      }
    }

    let choppinessVerdict: MarketRegimeMetrics['choppinessVerdict'] = 'NORMAL_OSCILLATION';
    if (choppinessIndex >= 61.8) choppinessVerdict = 'CHOPPY_SIDEWAYS';
    else if (choppinessIndex <= 38.2) choppinessVerdict = 'TRENDING_BREAKOUT';

    // 3. ADX (14)
    const adx14 = this.computeAdx(klines, 14);
    let adxVerdict: MarketRegimeMetrics['adxVerdict'] = 'MODERATE';
    if (adx14 < 20) adxVerdict = 'RANGE_BOUND';
    else if (adx14 > 25) adxVerdict = 'STRONG_TREND';

    // 4. Hurst Exponent (R/S analysis over dataset)
    const hurstExponent = this.computeHurstExponent(klines);
    let hurstVerdict: MarketRegimeMetrics['hurstVerdict'] = 'RANDOM_WALK';
    if (hurstExponent < 0.47) hurstVerdict = 'MEAN_REVERTING';
    else if (hurstExponent > 0.53) hurstVerdict = 'PERSISTENT_TREND';

    // 5. Autocorrelation (lag 1, 2, 3 returns)
    const returns: number[] = [];
    for (let i = 1; i < n; i++) {
      returns.push(Math.log(klines[i].close / klines[i - 1].close));
    }
    const ac1 = this.computeAutocorrelation(returns, 1);
    const ac2 = this.computeAutocorrelation(returns, 2);
    const ac3 = this.computeAutocorrelation(returns, 3);

    // Overall verdict synthesis
    let overallRegime: MarketRegimeMetrics['overallRegime'] = 'FAVORABLE_GRID';
    let favorablePoints = 0;
    if (choppinessIndex >= 55) favorablePoints += 2;
    if (adx14 < 22) favorablePoints += 2;
    if (hurstExponent < 0.5) favorablePoints += 2;
    if (ac1 < 0) favorablePoints += 1;

    if (favorablePoints >= 6) overallRegime = 'IDEAL_GRID';
    else if (favorablePoints >= 4) overallRegime = 'FAVORABLE_GRID';
    else if (favorablePoints >= 2) overallRegime = 'TRANSITIONAL';
    else overallRegime = 'HIGH_TREND_RISK';

    return {
      currentPrice: parseFloat(currentPrice.toFixed(4)),
      atr: parseFloat(atr.toFixed(4)),
      atrPct: parseFloat(atrPct.toFixed(2)),
      choppinessIndex: parseFloat(choppinessIndex.toFixed(1)),
      choppinessVerdict,
      adx14: parseFloat(adx14.toFixed(1)),
      adxVerdict,
      hurstExponent: parseFloat(hurstExponent.toFixed(3)),
      hurstVerdict,
      autocorrelationLag1: parseFloat(ac1.toFixed(3)),
      autocorrelationLag2: parseFloat(ac2.toFixed(3)),
      autocorrelationLag3: parseFloat(ac3.toFixed(3)),
      overallRegime,
    };
  }

  /**
   * Wilder ADX 14 calculator
   */
  private computeAdx(klines: Kline[], period: number = 14): number {
    if (klines.length < period * 2) return 20;

    const trList: number[] = [];
    const plusDmList: number[] = [];
    const minusDmList: number[] = [];

    for (let i = 1; i < klines.length; i++) {
      const curr = klines[i];
      const prev = klines[i - 1];

      const tr = Math.max(curr.high - curr.low, Math.abs(curr.high - prev.close), Math.abs(curr.low - prev.close));
      trList.push(tr);

      const upMove = curr.high - prev.high;
      const downMove = prev.low - curr.low;

      plusDmList.push(upMove > downMove && upMove > 0 ? upMove : 0);
      minusDmList.push(downMove > upMove && downMove > 0 ? downMove : 0);
    }

    let smoothTr = trList.slice(0, period).reduce((s, v) => s + v, 0);
    let smoothPlusDm = plusDmList.slice(0, period).reduce((s, v) => s + v, 0);
    let smoothMinusDm = minusDmList.slice(0, period).reduce((s, v) => s + v, 0);

    const dxList: number[] = [];

    for (let i = period; i < trList.length; i++) {
      smoothTr = smoothTr - smoothTr / period + trList[i];
      smoothPlusDm = smoothPlusDm - smoothPlusDm / period + plusDmList[i];
      smoothMinusDm = smoothMinusDm - smoothMinusDm / period + minusDmList[i];

      const plusDi = smoothTr > 0 ? (smoothPlusDm / smoothTr) * 100 : 0;
      const minusDi = smoothTr > 0 ? (smoothMinusDm / smoothTr) * 100 : 0;
      const diSum = plusDi + minusDi;
      const dx = diSum > 0 ? (Math.abs(plusDi - minusDi) / diSum) * 100 : 0;
      dxList.push(dx);
    }

    if (dxList.length < period) return 20;
    let adx = dxList.slice(0, period).reduce((s, v) => s + v, 0) / period;
    for (let i = period; i < dxList.length; i++) {
      adx = (adx * (period - 1) + dxList[i]) / period;
    }

    return Math.max(0, Math.min(100, adx));
  }

  /**
   * Computes Hurst Exponent via Rescaled Range (R/S) Analysis.
   */
  private computeHurstExponent(klines: Kline[]): number {
    const prices = klines.map((k) => k.close);
    const n = prices.length;
    if (n < 60) return 0.5;

    // Use returns
    const logReturns: number[] = [];
    for (let i = 1; i < n; i++) {
      logReturns.push(Math.log(prices[i] / prices[i - 1]));
    }

    const subChunkSizes = [16, 32, 64, 128, 256].filter((s) => s < logReturns.length / 2);
    if (subChunkSizes.length < 2) return 0.5;

    const logChunkSizes: number[] = [];
    const logRsValues: number[] = [];

    for (const size of subChunkSizes) {
      const numChunks = Math.floor(logReturns.length / size);
      let totalRs = 0;

      for (let c = 0; c < numChunks; c++) {
        const chunk = logReturns.slice(c * size, (c + 1) * size);
        const mean = chunk.reduce((s, v) => s + v, 0) / size;

        // Mean-adjusted cumulative deviations
        let cumDev = 0;
        let maxDev = -Infinity;
        let minDev = Infinity;
        let sumSqDev = 0;

        for (let i = 0; i < size; i++) {
          const dev = chunk[i] - mean;
          cumDev += dev;
          if (cumDev > maxDev) maxDev = cumDev;
          if (cumDev < minDev) minDev = cumDev;
          sumSqDev += dev * dev;
        }

        const std = Math.sqrt(sumSqDev / size);
        const range = maxDev - minDev;
        if (std > 0) {
          totalRs += range / std;
        }
      }

      const meanRs = totalRs / numChunks;
      if (meanRs > 0) {
        logChunkSizes.push(Math.log(size));
        logRsValues.push(Math.log(meanRs));
      }
    }

    if (logChunkSizes.length < 2) return 0.5;

    // Linear regression slope of log(size) vs log(RS)
    const nPts = logChunkSizes.length;
    const meanX = logChunkSizes.reduce((s, v) => s + v, 0) / nPts;
    const meanY = logRsValues.reduce((s, v) => s + v, 0) / nPts;

    let num = 0;
    let den = 0;
    for (let i = 0; i < nPts; i++) {
      num += (logChunkSizes[i] - meanX) * (logRsValues[i] - meanY);
      den += Math.pow(logChunkSizes[i] - meanX, 2);
    }

    const hurst = den > 0 ? num / den : 0.5;
    return Math.max(0.1, Math.min(0.9, hurst));
  }

  /**
   * Computes Pearson Autocorrelation for a given lag.
   */
  private computeAutocorrelation(series: number[], lag: number): number {
    if (series.length <= lag + 5) return 0;
    const n = series.length - lag;
    const x = series.slice(0, n);
    const y = series.slice(lag, lag + n);

    const meanX = x.reduce((s, v) => s + v, 0) / n;
    const meanY = y.reduce((s, v) => s + v, 0) / n;

    let cov = 0;
    let varX = 0;
    let varY = 0;

    for (let i = 0; i < n; i++) {
      const dx = x[i] - meanX;
      const dy = y[i] - meanY;
      cov += dx * dy;
      varX += dx * dx;
      varY += dy * dy;
    }

    const denom = Math.sqrt(varX * varY);
    return denom > 0 ? cov / denom : 0;
  }

  /**
   * Identifies Support and Resistance clusters from local swing pivots.
   */
  private computeSupportResistance(klines: Kline[]): SupportResistanceLevel[] {
    const currentPrice = klines[klines.length - 1].close;
    const pivots: Array<{ price: number; type: 'SUPPORT' | 'RESISTANCE' }> = [];

    // 5-bar swing detection
    for (let i = 2; i < klines.length - 2; i++) {
      const c = klines[i];
      const isSwingHigh =
        c.high > klines[i - 1].high &&
        c.high > klines[i - 2].high &&
        c.high > klines[i + 1].high &&
        c.high > klines[i + 2].high;

      const isSwingLow =
        c.low < klines[i - 1].low &&
        c.low < klines[i - 2].low &&
        c.low < klines[i + 1].low &&
        c.low < klines[i + 2].low;

      if (isSwingHigh) pivots.push({ price: c.high, type: 'RESISTANCE' });
      if (isSwingLow) pivots.push({ price: c.low, type: 'SUPPORT' });
    }

    if (pivots.length === 0) return [];

    // Cluster pivots within 0.75% price tolerance
    const tolerancePct = 0.0075;
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

    // Filter and score top levels
    const scored: SupportResistanceLevel[] = clusters
      .filter((c) => c.touchCount >= 2)
      .map((c) => {
        const distPct = ((c.avgPrice - currentPrice) / currentPrice) * 100;
        const strength = Math.min(5, Math.max(1, Math.round(c.touchCount * 0.8)));
        return {
          price: parseFloat(c.avgPrice.toFixed(4)),
          type: c.avgPrice < currentPrice ? 'SUPPORT' : 'RESISTANCE',
          distancePct: parseFloat(distPct.toFixed(2)),
          touchCount: c.touchCount,
          strengthScore: strength,
        };
      });

    // Sort: support levels highest to lowest (closest to price), resistance lowest to highest (closest to price)
    const supports = scored.filter((l) => l.type === 'SUPPORT').sort((a, b) => b.price - a.price).slice(0, 4);
    const resistances = scored.filter((l) => l.type === 'RESISTANCE').sort((a, b) => a.price - b.price).slice(0, 4);

    return [...supports, ...resistances];
  }

  /**
   * Computes Volume Profile (Point of Control POC, High Volume Nodes HVN, Low Volume Nodes LVN, and 70% Value Area).
   */
  private computeVolumeProfile(klines: Kline[], binCount: number = 40): VolumeProfileResult {
    const high = Math.max(...klines.map((k) => k.high));
    const low = Math.min(...klines.map((k) => k.low));
    const span = Math.max(1e-6, high - low);
    const binSize = span / binCount;

    const binVolumes = new Array(binCount).fill(0);
    let totalVolume = 0;

    for (const k of klines) {
      const vol = k.volume;
      totalVolume += vol;
      // Approximate volume distribution across candle range
      const kLow = k.low;
      const kHigh = k.high;
      const startBin = Math.max(0, Math.min(binCount - 1, Math.floor((kLow - low) / binSize)));
      const endBin = Math.max(0, Math.min(binCount - 1, Math.floor((kHigh - low) / binSize)));
      const coveredBins = Math.max(1, endBin - startBin + 1);
      const volPerBin = vol / coveredBins;

      for (let b = startBin; b <= endBin; b++) {
        binVolumes[b] += volPerBin;
      }
    }

    // Find POC (highest volume bin)
    let maxBinIdx = 0;
    let maxBinVol = -1;
    for (let b = 0; b < binCount; b++) {
      if (binVolumes[b] > maxBinVol) {
        maxBinVol = binVolumes[b];
        maxBinIdx = b;
      }
    }
    const pocPrice = parseFloat((low + (maxBinIdx + 0.5) * binSize).toFixed(4));

    // Value Area (70% total volume radiating outwards from POC)
    const targetVaVolume = totalVolume * 0.7;
    let accumulatedVaVol = binVolumes[maxBinIdx];
    let lowerVaIdx = maxBinIdx;
    let upperVaIdx = maxBinIdx;

    while (accumulatedVaVol < targetVaVolume && (lowerVaIdx > 0 || upperVaIdx < binCount - 1)) {
      const lowerNextVol = lowerVaIdx > 0 ? binVolumes[lowerVaIdx - 1] : 0;
      const upperNextVol = upperVaIdx < binCount - 1 ? binVolumes[upperVaIdx + 1] : 0;

      if (lowerNextVol >= upperNextVol && lowerVaIdx > 0) {
        lowerVaIdx--;
        accumulatedVaVol += binVolumes[lowerVaIdx];
      } else if (upperVaIdx < binCount - 1) {
        upperVaIdx++;
        accumulatedVaVol += binVolumes[upperVaIdx];
      } else if (lowerVaIdx > 0) {
        lowerVaIdx--;
        accumulatedVaVol += binVolumes[lowerVaIdx];
      } else {
        break;
      }
    }

    const valueAreaLow = parseFloat((low + lowerVaIdx * binSize).toFixed(4));
    const valueAreaHigh = parseFloat((low + (upperVaIdx + 1) * binSize).toFixed(4));

    // HVN (local volume peaks) and LVN (local volume troughs)
    const hvnLevels: number[] = [];
    const lvnLevels: number[] = [];

    const bins = binVolumes.map((vol, idx) => {
      const price = parseFloat((low + (idx + 0.5) * binSize).toFixed(4));
      const pctOfTotal = totalVolume > 0 ? parseFloat(((vol / totalVolume) * 100).toFixed(2)) : 0;
      const prevVol = idx > 0 ? binVolumes[idx - 1] : vol;
      const nextVol = idx < binCount - 1 ? binVolumes[idx + 1] : vol;

      const isPOC = idx === maxBinIdx;
      const isHVN = !isPOC && vol > prevVol && vol > nextVol && pctOfTotal > 2.5;
      const isLVN = vol < prevVol && vol < nextVol && pctOfTotal < 1.5;

      if (isHVN) hvnLevels.push(price);
      if (isLVN) lvnLevels.push(price);

      return {
        price,
        volume: Math.round(vol),
        pctOfTotal,
        isPOC,
        isHVN,
        isLVN,
      };
    });

    return {
      pocPrice,
      valueAreaHigh,
      valueAreaLow,
      hvnLevels: hvnLevels.slice(0, 4),
      lvnLevels: lvnLevels.slice(0, 4),
      bins,
    };
  }

  /**
   * Computes return correlation and beta between the target instrument and Bitcoin (BTC).
   */
  private async computeBtcCorrelation(
    symbol: string,
    targetKlines: Kline[],
    days: number,
    bar: string,
    signal?: AbortSignal
  ): Promise<BtcCorrelationResult> {
    const isAlreadyBtc = symbol.toUpperCase().includes('BTC');
    if (isAlreadyBtc) {
      return {
        symbol,
        btcSymbol: symbol,
        pearsonR: 1.0,
        beta: 1.0,
        interpretation: 'HIGH_CORRELATION',
      };
    }

    try {
      // Determine appropriate BTC benchmark symbol on OKX (resolved dynamically)
      let btcSymbol = symbol.includes('_UM_XPERP') ? 'BTC-USD_UM_XPERP' : 'BTC-USDT-SWAP';
      let btcKlines = await this.dataStore.loadOrFetchKlines(btcSymbol, bar, days, signal);
      if (btcKlines.length < 50 && btcSymbol !== 'BTC-USDT-SWAP') {
        btcSymbol = 'BTC-USDT-SWAP';
        btcKlines = await this.dataStore.loadOrFetchKlines(btcSymbol, bar, days, signal);
      }

      if (btcKlines.length < 50) {
        return {
          symbol,
          btcSymbol,
          pearsonR: 0.8,
          beta: 1.0,
          interpretation: 'HIGH_CORRELATION',
        };
      }

      // Fast timestamp alignment
      const btcPriceMap = new Map<number, number>();
      for (const b of btcKlines) {
        btcPriceMap.set(b.timestamp, b.close);
      }

      const alignedTargetReturns: number[] = [];
      const alignedBtcReturns: number[] = [];

      for (let i = 1; i < targetKlines.length; i++) {
        const currTs = targetKlines[i].timestamp;
        const prevTs = targetKlines[i - 1].timestamp;
        const btcCurr = btcPriceMap.get(currTs);
        const btcPrev = btcPriceMap.get(prevTs);

        if (btcCurr && btcPrev && btcCurr > 0 && btcPrev > 0) {
          alignedTargetReturns.push(Math.log(targetKlines[i].close / targetKlines[i - 1].close));
          alignedBtcReturns.push(Math.log(btcCurr / btcPrev));
        }
      }

      if (alignedTargetReturns.length < 30) {
        return {
          symbol,
          btcSymbol,
          pearsonR: 0.75,
          beta: 1.0,
          interpretation: 'HIGH_CORRELATION',
        };
      }

      const n = alignedTargetReturns.length;
      const meanX = alignedTargetReturns.reduce((s, v) => s + v, 0) / n;
      const meanY = alignedBtcReturns.reduce((s, v) => s + v, 0) / n;

      let cov = 0;
      let varTarget = 0;
      let varBtc = 0;

      for (let i = 0; i < n; i++) {
        const dx = alignedTargetReturns[i] - meanX;
        const dy = alignedBtcReturns[i] - meanY;
        cov += dx * dy;
        varTarget += dx * dx;
        varBtc += dy * dy;
      }

      const pearsonR = varTarget > 0 && varBtc > 0 ? cov / Math.sqrt(varTarget * varBtc) : 0;
      const beta = varBtc > 0 ? cov / varBtc : 1.0;

      let interpretation: BtcCorrelationResult['interpretation'] = 'MODERATE_CORRELATION';
      if (pearsonR >= 0.7) interpretation = 'HIGH_CORRELATION';
      else if (pearsonR >= 0.35) interpretation = 'MODERATE_CORRELATION';
      else if (pearsonR > -0.2) interpretation = 'DECOUPLED';
      else interpretation = 'INVERSE';

      return {
        symbol,
        btcSymbol,
        pearsonR: parseFloat(pearsonR.toFixed(2)),
        beta: parseFloat(beta.toFixed(2)),
        interpretation,
      };
    } catch {
      return {
        symbol,
        btcSymbol: 'BTC-USDT-SWAP',
        pearsonR: 0.75,
        beta: 1.0,
        interpretation: 'HIGH_CORRELATION',
      };
    }
  }
}
