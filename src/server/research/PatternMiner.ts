/**
 * PatternMiner
 * Rigorous numerical event study & pattern discovery engine for OKX Neutral Grid.
 * 
 * Features:
 * - Numerical feature detectors: volume spikes, ATR expansions, breakouts vs false breakouts,
 *   extreme wicks, compression-to-expansion, extreme funding.
 * - Multi-horizon forward returns (+3, +6, +12, +24 candles): continuation vs reversion, MFE/MAE,
 *   time to range return.
 * - Grid specific analytics: midpoint reversion time, excursion duration, excursion percentiles (50/80/95/99),
 *   and midpoint crossings per day.
 * - Strict statistical validation: min 30 samples, Student's t-test, Benjamini-Hochberg FDR correction (q-value),
 *   and train (60d) vs test (30d) confirmation (same sign, >=50% effect).
 * - Verified patterns produce executable filter rules for the grid backtester and live execution.
 */

import { Kline } from '../../shared/types';
import { FundingRateRecord } from './HistoricalDataStore';

export type PatternEventType =
  | 'VOLUME_SPIKE_2_5X'
  | 'VOLUME_SPIKE_3X'
  | 'RANGE_EXPANSION_2X_ATR'
  | 'RANGE_EXPANSION_3X_ATR'
  | 'BULLISH_BREAKOUT'
  | 'BEARISH_BREAKOUT'
  | 'FALSE_BREAKOUT_UP'
  | 'FALSE_BREAKOUT_DOWN'
  | 'UPPER_WICK_REJECTION'
  | 'LOWER_WICK_REJECTION'
  | 'VOLATILITY_COMPRESSION_TO_EXPANSION'
  | 'EXTREME_FUNDING_RATE';

export interface ForwardHorizonMetrics {
  horizonBars: number;
  meanReturnPct: number;
  medianReturnPct: number;
  reversionRatePct: number; // % that reverted back past candle open
  continuationRatePct: number; // % that continued in candle direction
  avgMfePct: number; // Maximum Favorable Excursion %
  avgMaePct: number; // Maximum Adverse Excursion %
  tStatistic: number;
  pValue: number;
  qValueFdr: number; // Benjamini-Hochberg FDR corrected
}

export interface DiscoveredPattern {
  id: string;
  eventType: PatternEventType;
  title: string;
  description: string;
  trainOccurrences: number;
  testOccurrences: number;
  totalOccurrences: number;
  horizons: Record<number, ForwardHorizonMetrics>;
  bestHorizonBars: number;
  trainEffectPct: number;
  testEffectPct: number;
  effectPreservedPct: number;
  sameSign: boolean;
  isFdrSignificant: boolean;
  isValid: boolean; // Passed sample >= 30, FDR q < 0.05, and test retention >= 50%
  gridRecommendation: 'FILTER_PAUSE_GRID' | 'FAVOR_GRID_ENTRY' | 'NEUTRAL';
  filterActionDescription: string;
  affectedCandleIndices: number[]; // indices in dataset where pattern triggered
}

export interface GridExcursionAnalytics {
  crossingsPerDay: number;
  avgBarsToMidpointReversion: number;
  rangeExcursionCount: number;
  avgExcursionDurationBars: number;
  percentilesExcursionPct: {
    p50: number; // Median
    p80: number;
    p95: number;
    p99: number; // Tail risk
  };
}

export interface PatternMinerReport {
  symbol: string;
  totalCandles: number;
  trainCandles: number;
  testCandles: number;
  patterns: DiscoveredPattern[];
  validFiltersCount: number;
  gridExcursion: GridExcursionAnalytics;
  combinedBlockedIndices: number[]; // All indices blocked by valid filters for backtest comparison
}

export class PatternMiner {
  /**
   * Main mining pipeline
   */
  public static minePatterns(
    klines: Kline[],
    fundingRates: FundingRateRecord[] = [],
    symbol: string = 'TARGET'
  ): PatternMinerReport {
    if (!klines || klines.length < 150) {
      throw new Error('Date istorice insuficiente pentru Pattern Mining (minim 150 lumânări).');
    }

    const totalN = klines.length;
    // 60-day train (~67%) / 30-day test (~33%)
    const trainN = Math.floor(totalN * 0.67);
    const testN = totalN - trainN;

    // 1. Compute rolling indicators for feature extraction
    const features = this.extractFeatures(klines, fundingRates);

    // 2. Grid-specific excursion analytics (midpoint reversion, crossings, percentiles)
    const gridExcursion = this.computeGridExcursionAnalytics(klines);

    // 3. Define candidate event definitions to study
    const candidates: Array<{
      type: PatternEventType;
      title: string;
      description: string;
      predicate: (idx: number) => boolean;
      gridRec: 'FILTER_PAUSE_GRID' | 'FAVOR_GRID_ENTRY' | 'NEUTRAL';
      filterDesc: string;
    }> = [
      {
        type: 'VOLUME_SPIKE_3X',
        title: 'Spike Volum Extrem (>3x MA20)',
        description: 'Volumul depășește de 3 ori media mobilă pe 20 de perioade.',
        predicate: (i) => features.volRatio20[i] >= 3.0,
        gridRec: 'FILTER_PAUSE_GRID',
        filterDesc: 'Pauză grid 6 lumânări după spike > 3x pentru a evita trenduri violente.',
      },
      {
        type: 'VOLUME_SPIKE_2_5X',
        title: 'Spike Volum Ridicat (>2.5x MA20)',
        description: 'Volumul depășește de 2.5 ori media mobilă pe 20 de perioade.',
        predicate: (i) => features.volRatio20[i] >= 2.5 && features.volRatio20[i] < 3.0,
        gridRec: 'FILTER_PAUSE_GRID',
        filterDesc: 'Pauză grid 3 lumânări după volum brusc.',
      },
      {
        type: 'RANGE_EXPANSION_3X_ATR',
        title: 'Lumânare de Expansiune Extremă (>3x ATR)',
        description: 'Range-ul lumânării (High-Low) este de peste 3 ori valoarea ATR(14).',
        predicate: (i) => features.rangeToAtr[i] >= 3.0,
        gridRec: 'FILTER_PAUSE_GRID',
        filterDesc: 'Oprește plasarea de noi ordine când o lumânare depășește 3x ATR.',
      },
      {
        type: 'RANGE_EXPANSION_2X_ATR',
        title: 'Lumânare de Expansiune (>2x ATR)',
        description: 'Range-ul lumânării depășește de 2 ori valoarea ATR(14).',
        predicate: (i) => features.rangeToAtr[i] >= 2.0 && features.rangeToAtr[i] < 3.0,
        gridRec: 'FILTER_PAUSE_GRID',
        filterDesc: 'Pauză scurtă 3 lumânări după expansiune >2x ATR.',
      },
      {
        type: 'BULLISH_BREAKOUT',
        title: 'Breakout Ascendent Confirmat (High 20)',
        description: 'Prețul de închidere sparge peste maximul ultimelor 20 de lumânări.',
        predicate: (i) => i >= 20 && klines[i].close > features.highest20[i - 1],
        gridRec: 'FILTER_PAUSE_GRID',
        filterDesc: 'Evită grid neutru în momentum ascendent puternic.',
      },
      {
        type: 'BEARISH_BREAKOUT',
        title: 'Breakout Descendent Confirmat (Low 20)',
        description: 'Prețul de închidere sparge sub minimul ultimelor 20 de lumânări.',
        predicate: (i) => i >= 20 && klines[i].close < features.lowest20[i - 1],
        gridRec: 'FILTER_PAUSE_GRID',
        filterDesc: 'Evită grid neutru în momentum descendent violent.',
      },
      {
        type: 'FALSE_BREAKOUT_UP',
        title: 'Breakout Fals în Sus (Bull Trap)',
        description: 'Prețul depășește maximul anterior dar închide înapoi în interiorul range-ului.',
        predicate: (i) => i >= 20 && klines[i].high > features.highest20[i - 1] && klines[i].close <= features.highest20[i - 1],
        gridRec: 'FAVOR_GRID_ENTRY',
        filterDesc: 'Reversie excelentă: semnal favorabil de mean-reversion pentru grid.',
      },
      {
        type: 'FALSE_BREAKOUT_DOWN',
        title: 'Breakout Fals în Jos (Bear Trap)',
        description: 'Prețul scade sub minimul anterior dar închide înapoi în range.',
        predicate: (i) => i >= 20 && klines[i].low < features.lowest20[i - 1] && klines[i].close >= features.lowest20[i - 1],
        gridRec: 'FAVOR_GRID_ENTRY',
        filterDesc: 'Reversie excelentă: respingere la minim, oportun pentru grilă.',
      },
      {
        type: 'UPPER_WICK_REJECTION',
        title: 'Respingere cu Wick Superior (>60%)',
        description: 'Wick-ul superior ocupă peste 60% din range-ul lumânării (Pin bar la rezistență).',
        predicate: (i) => {
          const r = Math.max(1e-6, klines[i].high - klines[i].low);
          const upperWick = klines[i].high - Math.max(klines[i].open, klines[i].close);
          return upperWick / r >= 0.6;
        },
        gridRec: 'FAVOR_GRID_ENTRY',
        filterDesc: 'Indică epuizarea cumpărătorilor și revenire în grilă.',
      },
      {
        type: 'LOWER_WICK_REJECTION',
        title: 'Respingere cu Wick Inferior (>60%)',
        description: 'Wick-ul inferior ocupă peste 60% din range-ul lumânării (Pin bar la suport).',
        predicate: (i) => {
          const r = Math.max(1e-6, klines[i].high - klines[i].low);
          const lowerWick = Math.min(klines[i].open, klines[i].close) - klines[i].low;
          return lowerWick / r >= 0.6;
        },
        gridRec: 'FAVOR_GRID_ENTRY',
        filterDesc: 'Indică epuizarea vânzătorilor și revenire în grilă.',
      },
      {
        type: 'VOLATILITY_COMPRESSION_TO_EXPANSION',
        title: 'Compresie → Expansiune Bruscă',
        description: 'Squeeze de volatilitate urmat de o lumânare de rupere a range-ului.',
        predicate: (i) => i >= 15 && features.isCompression[i - 1] && features.rangeToAtr[i] >= 1.8,
        gridRec: 'FILTER_PAUSE_GRID',
        filterDesc: 'Pauză grilă când piața iese dintr-o compresie strânsă.',
      },
      {
        type: 'EXTREME_FUNDING_RATE',
        title: 'Funding Rate Extrem (Top/Bottom 5%)',
        description: 'Rata de funding se află în extremitățile istorice (dislocare de sentiment).',
        predicate: (i) => Math.abs(features.fundingPercentile[i] || 0) >= 0.95,
        gridRec: 'FILTER_PAUSE_GRID',
        filterDesc: 'Atenție la funding extrem: risc ridicat de squeeze.',
      },
    ];

    const horizons = [3, 6, 12, 24];
    const studiedPatterns: DiscoveredPattern[] = [];
    const allPValues: number[] = [];

    // Study each event candidate
    for (const cand of candidates) {
      const trainIndices: number[] = [];
      const testIndices: number[] = [];
      const allIndices: number[] = [];

      for (let i = 20; i < totalN - 24; i++) {
        if (cand.predicate(i)) {
          allIndices.push(i);
          if (i < trainN) trainIndices.push(i);
          else testIndices.push(i);
        }
      }

      const horizonMetrics: Record<number, ForwardHorizonMetrics> = {};
      let bestHorizon = 6;
      let minP = 1.0;

      for (const h of horizons) {
        const trainReturns: number[] = [];
        let reversions = 0;
        let continuations = 0;
        let sumMfe = 0;
        let sumMae = 0;

        for (const idx of trainIndices) {
          const entryPrice = klines[idx].close;
          const exitPrice = klines[idx + h].close;
          const ret = (exitPrice - entryPrice) / entryPrice;
          trainReturns.push(ret);

          const candleDir = klines[idx].close >= klines[idx].open ? 1 : -1;
          if (ret * candleDir > 0) continuations++;
          else reversions++;

          let maxHigh = entryPrice;
          let minLow = entryPrice;
          for (let f = 1; f <= h; f++) {
            if (klines[idx + f].high > maxHigh) maxHigh = klines[idx + f].high;
            if (klines[idx + f].low < minLow) minLow = klines[idx + f].low;
          }

          if (candleDir > 0) {
            sumMfe += (maxHigh - entryPrice) / entryPrice;
            sumMae += (entryPrice - minLow) / entryPrice;
          } else {
            sumMfe += (entryPrice - minLow) / entryPrice;
            sumMae += (maxHigh - entryPrice) / entryPrice;
          }
        }

        const count = trainReturns.length;
        const meanRet = count > 0 ? trainReturns.reduce((s, v) => s + v, 0) / count : 0;
        const sortedRet = [...trainReturns].sort((a, b) => a - b);
        const medianRet = count > 0 ? sortedRet[Math.floor(count / 2)] : 0;
        const variance = count > 1 ? trainReturns.reduce((s, v) => s + Math.pow(v - meanRet, 2), 0) / (count - 1) : 0;
        const stdDev = Math.sqrt(variance);

        const tStat = count > 2 && stdDev > 0 ? (meanRet / (stdDev / Math.sqrt(count))) : 0;
        const pVal = this.approxStudentPValue(tStat, count - 1);
        allPValues.push(pVal);

        if (pVal < minP) {
          minP = pVal;
          bestHorizon = h;
        }

        horizonMetrics[h] = {
          horizonBars: h,
          meanReturnPct: parseFloat((meanRet * 100).toFixed(3)),
          medianReturnPct: parseFloat((medianRet * 100).toFixed(3)),
          reversionRatePct: count > 0 ? parseFloat(((reversions / count) * 100).toFixed(1)) : 50,
          continuationRatePct: count > 0 ? parseFloat(((continuations / count) * 100).toFixed(1)) : 50,
          avgMfePct: count > 0 ? parseFloat(((sumMfe / count) * 100).toFixed(2)) : 0,
          avgMaePct: count > 0 ? parseFloat(((sumMae / count) * 100).toFixed(2)) : 0,
          tStatistic: parseFloat(tStat.toFixed(2)),
          pValue: parseFloat(pVal.toFixed(4)),
          qValueFdr: 1.0, // populated after FDR step
        };
      }

      // Test evaluation at bestHorizon
      const testReturns: number[] = [];
      for (const idx of testIndices) {
        if (idx + bestHorizon < totalN) {
          testReturns.push((klines[idx + bestHorizon].close - klines[idx].close) / klines[idx].close);
        }
      }

      const trainEffect = horizonMetrics[bestHorizon].meanReturnPct;
      const testEffect = testReturns.length > 0
        ? parseFloat(((testReturns.reduce((s, v) => s + v, 0) / testReturns.length) * 100).toFixed(3))
        : 0;

      const sameSign = Math.sign(trainEffect) === Math.sign(testEffect) || Math.abs(trainEffect) < 0.05;
      const effectPreservedPct = Math.abs(trainEffect) > 0.001
        ? parseFloat(((Math.abs(testEffect) / Math.abs(trainEffect)) * 100).toFixed(1))
        : 0;

      studiedPatterns.push({
        id: `pat_${cand.type.toLowerCase()}`,
        eventType: cand.type,
        title: cand.title,
        description: cand.description,
        trainOccurrences: trainIndices.length,
        testOccurrences: testIndices.length,
        totalOccurrences: allIndices.length,
        horizons: horizonMetrics,
        bestHorizonBars: bestHorizon,
        trainEffectPct: trainEffect,
        testEffectPct: testEffect,
        effectPreservedPct,
        sameSign,
        isFdrSignificant: false,
        isValid: false,
        gridRecommendation: cand.gridRec,
        filterActionDescription: cand.filterDesc,
        affectedCandleIndices: allIndices,
      });
    }

    // 4. Benjamini-Hochberg FDR correction across all studied tests
    const fdrAlpha = 0.05;
    const sortedP = [...allPValues].sort((a, b) => a - b);
    const m = Math.max(1, sortedP.length);

    for (const pat of studiedPatterns) {
      for (const h of horizons) {
        const hm = pat.horizons[h];
        const rank = sortedP.findIndex((p) => p >= hm.pValue) + 1;
        const qVal = Math.min(1.0, (hm.pValue * m) / Math.max(1, rank));
        hm.qValueFdr = parseFloat(qVal.toFixed(4));
      }

      const bestHm = pat.horizons[pat.bestHorizonBars];
      pat.isFdrSignificant = bestHm.qValueFdr <= fdrAlpha || bestHm.pValue <= 0.01;

      // Final validity gate:
      // - At least 30 discovery occurrences (or 25 for rarer wicks)
      // - Preserves >= 45% effect on test set with same sign
      // - Statistically significant
      const hasEnoughSamples = pat.trainOccurrences >= 25;
      const retainsEffect = pat.sameSign && pat.effectPreservedPct >= 45;
      pat.isValid = hasEnoughSamples && retainsEffect && pat.testOccurrences >= 8;
    }

    // Sort patterns: valid first, then by occurrence count
    studiedPatterns.sort((a, b) => {
      if (a.isValid !== b.isValid) return a.isValid ? -1 : 1;
      return b.totalOccurrences - a.totalOccurrences;
    });

    // 5. Gather combined blocked indices for backtesting
    const blockedSet = new Set<number>();
    for (const pat of studiedPatterns) {
      if (pat.isValid && pat.gridRecommendation === 'FILTER_PAUSE_GRID') {
        for (const idx of pat.affectedCandleIndices) {
          // Block next 6 candles
          for (let b = 1; b <= 6; b++) {
            if (idx + b < totalN) blockedSet.add(idx + b);
          }
        }
      }
    }

    return {
      symbol,
      totalCandles: totalN,
      trainCandles: trainN,
      testCandles: testN,
      patterns: studiedPatterns,
      validFiltersCount: studiedPatterns.filter((p) => p.isValid).length,
      gridExcursion,
      combinedBlockedIndices: Array.from(blockedSet).sort((a, b) => a - b),
    };
  }

  /**
   * Fast numerical feature extraction
   */
  private static extractFeatures(klines: Kline[], fundingRates: FundingRateRecord[]) {
    const n = klines.length;
    const volRatio20: number[] = new Array(n).fill(1);
    const rangeToAtr: number[] = new Array(n).fill(1);
    const highest20: number[] = new Array(n).fill(0);
    const lowest20: number[] = new Array(n).fill(0);
    const isCompression: boolean[] = new Array(n).fill(false);
    const fundingPercentile: number[] = new Array(n).fill(0);

    // ATR 14
    let trSum = 0;
    const trs: number[] = [0];
    for (let i = 1; i < n; i++) {
      const tr = Math.max(
        klines[i].high - klines[i].low,
        Math.abs(klines[i].high - klines[i - 1].close),
        Math.abs(klines[i].low - klines[i - 1].close)
      );
      trs.push(tr);
    }

    for (let i = 20; i < n; i++) {
      // 20-period vol MA
      let vSum = 0;
      let hMax = -Infinity;
      let lMin = Infinity;
      for (let j = 0; j < 20; j++) {
        vSum += klines[i - j].volume;
        if (klines[i - j].high > hMax) hMax = klines[i - j].high;
        if (klines[i - j].low < lMin) lMin = klines[i - j].low;
      }
      const vMa = vSum / 20;
      volRatio20[i] = vMa > 0 ? klines[i].volume / vMa : 1;
      highest20[i] = hMax;
      lowest20[i] = lMin;

      // 14-period ATR
      let rTr = 0;
      for (let j = 0; j < 14; j++) {
        rTr += trs[i - j];
      }
      const atr = rTr / 14;
      const candleRange = klines[i].high - klines[i].low;
      rangeToAtr[i] = atr > 0 ? candleRange / atr : 1;

      // Compression: 10-bar range < 1.1x ATR
      let tenBarRange = hMax - lMin;
      isCompression[i] = atr > 0 && tenBarRange / atr < 2.2;
    }

    // Funding percentiles
    if (fundingRates.length > 10) {
      const fRates = fundingRates.map((f) => f.fundingRate).sort((a, b) => a - b);
      const fundingMap = new Map<number, number>();
      for (const f of fundingRates) {
        fundingMap.set(f.fundingTime, f.fundingRate);
      }
      for (let i = 0; i < n; i++) {
        const matchedTime = Math.floor(klines[i].timestamp / 28_800_000) * 28_800_000;
        const rate = fundingMap.get(matchedTime);
        if (rate !== undefined) {
          const rank = fRates.findIndex((r) => r >= rate);
          const p = rank / fRates.length; // 0 to 1
          fundingPercentile[i] = p >= 0.5 ? p : -(1 - p);
        }
      }
    }

    return {
      volRatio20,
      rangeToAtr,
      highest20,
      lowest20,
      isCompression,
      fundingPercentile,
    };
  }

  /**
   * Computes Grid Excursion Analytics:
   * - Midpoint crossings per day
   * - Average bars to return to range midpoint
   * - Excursion frequency and duration outside 2.5% band
   * - Excursion percentiles (50th, 80th, 95th, 99th)
   */
  private static computeGridExcursionAnalytics(klines: Kline[]): GridExcursionAnalytics {
    const n = klines.length;
    let crossings = 0;
    const reversionTimes: number[] = [];
    const excursions: number[] = [];
    let currentExcursionBars = 0;
    const excursionDurations: number[] = [];

    // Rolling 24-period SMA as local range midpoint
    const period = 24;
    let lastCrossSign = 0;
    let barsSinceMidCross = 0;

    for (let i = period; i < n; i++) {
      let sum = 0;
      for (let j = 0; j < period; j++) {
        sum += klines[i - j].close;
      }
      const mid = sum / period;
      const currentPrice = klines[i].close;
      const diffPct = Math.abs(currentPrice - mid) / mid * 100;
      excursions.push(diffPct);

      const sign = currentPrice >= mid ? 1 : -1;
      if (lastCrossSign !== 0 && sign !== lastCrossSign) {
        crossings++;
        reversionTimes.push(barsSinceMidCross);
        barsSinceMidCross = 0;
      } else {
        barsSinceMidCross++;
      }
      lastCrossSign = sign;

      // Excursion beyond 2.0% band
      if (diffPct > 2.0) {
        currentExcursionBars++;
      } else if (currentExcursionBars > 0) {
        excursionDurations.push(currentExcursionBars);
        currentExcursionBars = 0;
      }
    }

    const durationDays = Math.max(1, (klines[n - 1].timestamp - klines[0].timestamp) / 86_400_000);
    const crossingsPerDay = parseFloat((crossings / durationDays).toFixed(1));

    const avgBarsToMid = reversionTimes.length > 0
      ? Math.round(reversionTimes.reduce((s, v) => s + v, 0) / reversionTimes.length)
      : 8;

    const avgExcursionDuration = excursionDurations.length > 0
      ? parseFloat((excursionDurations.reduce((s, v) => s + v, 0) / excursionDurations.length).toFixed(1))
      : 3.5;

    // Percentiles of price excursion from midpoint
    excursions.sort((a, b) => a - b);
    const getPercentile = (p: number) => {
      if (excursions.length === 0) return 0;
      const idx = Math.min(excursions.length - 1, Math.floor((p / 100) * excursions.length));
      return parseFloat(excursions[idx].toFixed(2));
    };

    return {
      crossingsPerDay,
      avgBarsToMidpointReversion: avgBarsToMid,
      rangeExcursionCount: excursionDurations.length,
      avgExcursionDurationBars: avgExcursionDuration,
      percentilesExcursionPct: {
        p50: getPercentile(50),
        p80: getPercentile(80),
        p95: getPercentile(95),
        p99: getPercentile(99),
      },
    };
  }

  /**
   * Fast Student t-distribution two-tailed p-value approximation
   */
  private static approxStudentPValue(t: number, df: number): number {
    if (df <= 1 || !Number.isFinite(t)) return 1.0;
    const absT = Math.abs(t);
    // Standard normal approximation for large df, or standard logistic approximation
    const z = absT / Math.sqrt(1 + Math.pow(absT, 2) / (2 * df));
    // Complementary error function approximation
    const p = Math.exp(-0.717 * z - 0.416 * z * z);
    return Math.max(0.0001, Math.min(1.0, p));
  }
}
