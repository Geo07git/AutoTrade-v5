import { Kline, ProfileConfig, TradeSignal, ScannedOpportunity, OrderSide } from '../../shared/types';

export interface MomentumMetrics {
  score: number;
  side: OrderSide;
  mom: number;
  rvol: number;
  atrExpansion: number;
  currentAtr: number;
  atr14: number; // 14-period closed candle ATR for sizing
  candleElapsedSeconds: number;
  lastPrice: number;
  threshold: number;
  htfTrend: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  htfAligned: boolean;
  climax?: boolean;
  factors: {
    impulseScore: number;     // 0 - 35 pts
    rvolScore: number;        // 0 - 25 pts
    atrScore: number;         // 0 - 20 pts
    htfScore: number;         // 0 - 20 pts
    climax?: boolean;
  };
}

export class MomentumEngine {
  private config: ProfileConfig;

  constructor(config: ProfileConfig) {
    this.config = config;
  }

  public setConfig(config: ProfileConfig) {
    this.config = config;
  }

  public getConfig(): ProfileConfig {
    return this.config;
  }

  /**
   * Evaluates klines across timeframes to generate a directional signal (BUY/LONG or SELL/SHORT).
   * Supports precomputed metrics to avoid double computation (Problem #4).
   */
  public evaluate(
    symbol: string,
    klines: Record<string, Kline[]>,
    precomputedMetrics?: MomentumMetrics,
    options?: { invertExtremeSignals?: boolean; bypassImpulseGate?: boolean }
  ): TradeSignal | null {
    if (!klines || Object.keys(klines).length === 0) return null;

    const mainTf = this.config.timeframes[0] || '15';
    const mainKlines = klines[mainTf] || Object.values(klines)[0];

    if (!mainKlines || mainKlines.length < 22) return null;

    const metrics = precomputedMetrics || this.calculateMetrics(klines);
    const maxScore = this.config.maxMomentumScore !== undefined ? this.config.maxMomentumScore : 100;
    const effAtr = metrics.atr14 > 0 ? metrics.atr14 : metrics.currentAtr;
    const atrPct = metrics.lastPrice > 0 ? (effAtr / metrics.lastPrice) * 100 : 0;

    // Poarta de impuls minim (Item 1) & Fallback de directie (Item 2):
    // Daca mom == 0, impulseScore == 0, impulseScore < 10 sau |mom|/atrPct < 0.5: respinge candidatul (fara semnal / nu BUY implicit)
    // Colectare PAPER (Item 5): bypassImpulseGate permite trecerea intregii populatii de date
    const momInAtrUnits = Math.abs(metrics.mom) / Math.max(0.15, atrPct);
    const impulseScore = metrics.factors?.impulseScore ?? 0;
    const bypassImpulse = options?.bypassImpulseGate ?? false;
    if (!bypassImpulse && (metrics.mom === 0 || impulseScore < 10 || momInAtrUnits < 0.5)) {
      return null;
    }

    // CASE 1: Standard Momentum Continuation / Inversion (threshold <= score <= maxScore)
    const shouldInvert = Boolean(options?.invertExtremeSignals);
    if (metrics.score >= metrics.threshold && (maxScore >= 100 || metrics.score <= maxScore)) {
      // STRICT HTF CONFLUENCE FILTER for continuation:
      if (!metrics.htfAligned) {
        return null;
      }

      const signalSide: OrderSide = shouldInvert
        ? (metrics.side === 'BUY' ? 'SELL' : 'BUY')
        : metrics.side;

      return {
        symbol,
        side: signalSide,
        originalSide: metrics.side,
        isFadeTrade: shouldInvert,
        climax: Boolean(metrics.climax || metrics.factors?.climax),
        score: metrics.score,
        profile: this.config.type,
        timestamp: Date.now(),
        currentPrice: metrics.lastPrice,
        currentAtr: metrics.currentAtr,
        atr14: metrics.atr14,
        candleElapsedSeconds: metrics.candleElapsedSeconds,
        atrPct: parseFloat(atrPct.toFixed(2)),
        reasons: {
          score: metrics.score,
          threshold: metrics.threshold,
          maxScore,
          side: signalSide,
          originalSide: metrics.side,
          isFadeTrade: shouldInvert,
          fadeClimax: shouldInvert,
          climax: Boolean(metrics.climax || metrics.factors?.climax),
          mom: metrics.mom,
          rvol: metrics.rvol,
          atrExpansion: metrics.atrExpansion,
          currentAtr: metrics.currentAtr,
          atr14: metrics.atr14,
          candleElapsedSeconds: metrics.candleElapsedSeconds,
          lastPrice: metrics.lastPrice,
          atrPct: parseFloat(atrPct.toFixed(2)),
          htfTrend: metrics.htfTrend,
          htfAligned: metrics.htfAligned,
          factors: metrics.factors,
          timeframes: this.config.timeframes,
        },
      };
    }

    // CASE 2: Extreme Momentum Climax Zone (score > maxScore when maxScore < 100)
    // In inverted mode: Instead of discarding, we INVERT the side to fade the exhaustion blow-off / climax
    if (maxScore < 100 && metrics.score > maxScore && shouldInvert) {
      const invertedSide: OrderSide = metrics.side === 'BUY' ? 'SELL' : 'BUY';

      return {
        symbol,
        side: invertedSide,
        originalSide: metrics.side,
        isFadeTrade: true,
        climax: Boolean(metrics.climax || metrics.factors?.climax),
        score: metrics.score,
        profile: this.config.type,
        timestamp: Date.now(),
        currentPrice: metrics.lastPrice,
        currentAtr: metrics.currentAtr,
        atr14: metrics.atr14,
        candleElapsedSeconds: metrics.candleElapsedSeconds,
        atrPct: parseFloat(atrPct.toFixed(2)),
        reasons: {
          score: metrics.score,
          threshold: metrics.threshold,
          maxScore,
          side: invertedSide,
          originalSide: metrics.side,
          isFadeTrade: true,
          fadeClimax: true,
          climax: Boolean(metrics.climax || metrics.factors?.climax),
          mom: metrics.mom,
          rvol: metrics.rvol,
          atrExpansion: metrics.atrExpansion,
          currentAtr: metrics.currentAtr,
          atr14: metrics.atr14,
          candleElapsedSeconds: metrics.candleElapsedSeconds,
          lastPrice: metrics.lastPrice,
          atrPct: parseFloat(atrPct.toFixed(2)),
          htfTrend: metrics.htfTrend,
          htfAligned: metrics.htfAligned,
          factors: metrics.factors,
          timeframes: this.config.timeframes,
        },
      };
    }

    return null;
  }

  /**
   * Evaluates a candidate pair for Market Scanner ranking.
   * Fixes Problem #4: Calculates metrics ONCE and passes them to evaluate().
   */
  public evaluateCandidate(
    symbol: string,
    klines: Record<string, Kline[]>,
    tickerData?: { volume24hUSDT: number; priceChange24hPct: number; spreadPct?: number },
    options?: { invertExtremeSignals?: boolean; bypassImpulseGate?: boolean }
  ): ScannedOpportunity | null {
    if (!klines || Object.keys(klines).length === 0) return null;

    const mainTf = this.config.timeframes[0] || '15';
    const mainKlines = klines[mainTf] || Object.values(klines)[0];

    if (!mainKlines || mainKlines.length < 22) return null;

    // Calculate metrics ONCE per candidate
    const metrics = this.calculateMetrics(klines);
    // Reuse precomputed metrics - eliminates redundant duplicate calculation
    const signal = this.evaluate(symbol, klines, metrics, options);

    const maxScore = this.config.maxMomentumScore !== undefined ? this.config.maxMomentumScore : 100;
    const effAtr = metrics.atr14 > 0 ? metrics.atr14 : metrics.currentAtr;
    const atrPct = metrics.lastPrice > 0 ? (effAtr / metrics.lastPrice) * 100 : 0;
    const momInAtrUnits = Math.abs(metrics.mom) / Math.max(0.15, atrPct);
    const impulseScore = metrics.factors?.impulseScore ?? 0;
    const bypassImpulse = options?.bypassImpulseGate ?? false;
    const passesImpulseGate = bypassImpulse || (metrics.mom !== 0 && impulseScore >= 10 && momInAtrUnits >= 0.5);

    const shouldInvert = Boolean(options?.invertExtremeSignals);
    const isExtreme = maxScore < 100 && metrics.score > maxScore;
    const isStandard = metrics.score >= metrics.threshold && (maxScore >= 100 || metrics.score <= maxScore);

    let isEligible = false;
    let finalSide: OrderSide = metrics.side;
    let isFadeTrade = false;

    if (shouldInvert) {
      // Invert signals across the ENTIRE score spectrum (both standard and extreme scores)
      if (isStandard && passesImpulseGate) {
        isEligible = metrics.htfAligned;
        finalSide = metrics.side === 'BUY' ? 'SELL' : 'BUY';
        isFadeTrade = true;
      } else if (isExtreme && passesImpulseGate) {
        isEligible = true;
        finalSide = metrics.side === 'BUY' ? 'SELL' : 'BUY';
        isFadeTrade = true;
      }
    } else {
      if (isStandard && passesImpulseGate) {
        isEligible = metrics.htfAligned;
        finalSide = metrics.side;
        isFadeTrade = false;
      }
    }

    return {
      symbol,
      price: metrics.lastPrice,
      volume24hUSDT: tickerData?.volume24hUSDT || 0,
      priceChange24hPct: tickerData?.priceChange24hPct !== undefined ? tickerData.priceChange24hPct : metrics.mom,
      spreadPct: tickerData?.spreadPct,
      rvol: metrics.rvol,
      atrExpansion: metrics.atrExpansion,
      currentAtr: metrics.currentAtr,
      atr14: metrics.atr14,
      candleElapsedSeconds: metrics.candleElapsedSeconds,
      atrPct: parseFloat(atrPct.toFixed(2)),
      score: metrics.score,
      side: finalSide,
      originalSide: metrics.side,
      isFadeTrade,
      climax: Boolean(metrics.climax || metrics.factors?.climax),
      isEligible,
      signal: signal || undefined,
      rank: 0,
      lastScannedTime: Date.now(),
    };
  }

  /**
   * Calibrated Multi-Factor & Multi-Timeframe Scoring Model (Problem #1, #2, #3):
   * 1. Bidirectional Evaluation: Detects both Long and Short impulses.
   * 2. Multi-Timeframe Confluence: Analyzes HTF (timeframes[1]) trend alignment with LTF (timeframes[0]).
   * 3. Calibrated Factor Model: Non-linear bounded score [0 - 100] across 4 weighted pillars:
   *    - Impulse Strength (35%): Log-scaled directional price change & EMA displacement
   *    - RVOL (25%): Volume expansion saturated sigmoid (diminishing returns beyond 3.5x)
   *    - ATR Expansion (20%): True range volatility expansion
   *    - HTF Alignment (20%): Trend confluence from the higher timeframe
   */
  public calculateMetrics(klinesMap: Record<string, Kline[]>): MomentumMetrics {
    const EPSILON = 1e-8;
    const threshold = this.config.minMomentumScore || (this.config.type === 'SCALP' ? 65 : 60);

    const ltfKey = this.config.timeframes[0] || '15';
    const htfKey = this.config.timeframes[1] || '60';

    // Lower Timeframe (Entry & Momentum)
    const ltfKlines = klinesMap[ltfKey] || klinesMap['15'] || klinesMap['15m'] || Object.values(klinesMap)[0];

    if (!ltfKlines || ltfKlines.length < 22) {
      return {
        score: 50,
        side: 'BUY',
        mom: 0,
        rvol: 1.0,
        atrExpansion: 1.0,
        currentAtr: 0,
        atr14: 0,
        candleElapsedSeconds: 0,
        lastPrice: 0,
        threshold,
        htfTrend: 'NEUTRAL',
        htfAligned: false,
        factors: { impulseScore: 17.5, rvolScore: 12.5, atrScore: 10, htfScore: 10 },
      };
    }

    const last = ltfKlines[ltfKlines.length - 1];
    const prev = ltfKlines[ltfKlines.length - 2];
    const lastClose = last.close;

    // 1. LTF Momentum & Direction (mom remains on live price)
    const mom = ((lastClose / (prev.close || lastClose)) - 1) * 100;
    
    // EMA 20 on LTF
    const ema20Ltf = this.calculateEMA(ltfKlines.map((k) => k.close), 20);
    const distFromEmaPct = ((lastClose - ema20Ltf) / (ema20Ltf + EPSILON)) * 100;

    // Higher Timeframe (HTF) Trend Analysis (Problem #2)
    const htfKlines = klinesMap[htfKey] || klinesMap['60'] || klinesMap['240'];
    let htfTrend: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL';

    if (htfKlines && htfKlines.length >= 20) {
      const htfLastClose = htfKlines[htfKlines.length - 1].close;
      const htfEma20 = this.calculateEMA(htfKlines.map((k) => k.close), 20);
      const htfEma50 = htfKlines.length >= 50 ? this.calculateEMA(htfKlines.map((k) => k.close), 50) : htfEma20;

      const diffPct = Math.abs((htfLastClose - htfEma20) / (htfEma20 + EPSILON)) * 100;
      if (diffPct < 0.15) {
        htfTrend = 'NEUTRAL';
      } else if (htfLastClose > htfEma20 && htfEma20 >= htfEma50) {
        htfTrend = 'BULLISH';
      } else if (htfLastClose < htfEma20 && htfEma20 <= htfEma50) {
        htfTrend = 'BEARISH';
      } else {
        htfTrend = htfLastClose >= htfEma20 ? 'BULLISH' : 'BEARISH';
      }
    } else {
      // Fallback: If HTF klines not available in map, infer trend from LTF longer period EMA 50
      const ltfEma50 = ltfKlines.length >= 50 ? this.calculateEMA(ltfKlines.map((k) => k.close), 50) : ema20Ltf;
      const diffPct = Math.abs((lastClose - ltfEma50) / (ltfEma50 + EPSILON)) * 100;
      if (diffPct < 0.2) {
        htfTrend = 'NEUTRAL';
      } else {
        htfTrend = lastClose >= ltfEma50 ? 'BULLISH' : 'BEARISH';
      }
    }

    // Determine Direction: BUY (Long) vs SELL (Short)
    // Fallback de directie (Item 2): Daca mom == 0, nu BUY implicit
    const hasDirectionalMom = Math.abs(mom) > 0.0001;
    let side: OrderSide = 'BUY';
    if (!hasDirectionalMom) {
      side = 'BUY'; // placeholder de tip, dar mom == 0 e respins in evaluate/evaluateCandidate
    } else if (mom < 0 && (distFromEmaPct < 0 || htfTrend === 'BEARISH')) {
      side = 'SELL';
    } else if (mom > 0 && (distFromEmaPct > 0 || htfTrend === 'BULLISH')) {
      side = 'BUY';
    } else {
      side = mom > 0 ? 'BUY' : 'SELL';
    }

    // HTF Alignment: Valid as long as HTF is not in strict opposite direction
    const isOpposingHtf = (side === 'BUY' && htfTrend === 'BEARISH') || (side === 'SELL' && htfTrend === 'BULLISH');
    const htfAligned = !isOpposingHtf;

    // Directional Magnitude of Momentum (|mom|)
    const absMom = Math.abs(mom);

    // Time-elapsed fraction of currently forming candle (Item 2)
    const mainTfMinutes = parseInt(ltfKey) || 15;
    const intervalMs = mainTfMinutes * 60 * 1000;
    const now = Date.now();
    const candleElapsedMs = Math.max(0, now - last.timestamp);
    const f = Math.max(0.05, Math.min(1.0, candleElapsedMs / intervalMs));
    const candleElapsedSeconds = Math.floor(candleElapsedMs / 1000);

    // 2. RVOL (Relative Volume across last 20 candles with time normalization)
    // 20-period baseline on completed candles
    const volAvg = ltfKlines.slice(-21, -1).reduce((a, b) => a + b.volume, 0) / 20;
    const isUnconfirmed = last.isConfirmed === false || (!last.isConfirmed && f < 0.99);
    const rvol = isUnconfirmed
      ? Math.min(10, (last.volume / f) / (volAvg + EPSILON))
      : Math.min(10, last.volume / (volAvg + EPSILON));

    // 3. ATR Expansion & Volatility Baseline (Item 2 & 3)
    const candleRange = Math.max(EPSILON, last.high - last.low);
    const avgAtr = ltfKlines.slice(-15, -1).reduce((a, b) => a + (b.high - b.low), 0) / 14;
    const atrExp = isUnconfirmed
      ? Math.max(0.1, Math.min(5.0, candleRange / ((avgAtr + EPSILON) * Math.sqrt(f))))
      : Math.max(0.1, Math.min(5.0, candleRange / (avgAtr + EPSILON)));
    const atrExpansion = atrExp;
    const atrPct = (avgAtr / (lastClose + EPSILON)) * 100;

    // Marcaj "climax" (Item 4): Cand ambele plafoane (rvol 10, atrExp 5) sunt atinse
    const isClimax = rvol >= 9.95 && atrExp >= 4.95;

    // Candle body quality ratio & persistence check
    const bodyRange = Math.max(EPSILON, last.high - last.low);
    const candleBody = Math.abs(last.close - last.open);
    const bodyRatio = candleBody / bodyRange;
    const qualityMultiplier = bodyRatio >= 0.20 ? 1.0 : 0.85;

    const prevMom = ltfKlines.length >= 3 ? ((prev.close / ltfKlines[ltfKlines.length - 3].close) - 1) * 100 : 0;
    const persistenceBonus = (side === 'BUY' && prev.close > prev.open && mom > 0 && prevMom > 0) || 
                             (side === 'SELL' && prev.close < prev.open && mom < 0 && prevMom < 0) ? 4 : 0;

    // 4. Calibrated Multi-Factor Score Model (Zero Gratuitous Baseline)
    // Pillar A: Volatility-Normalized Impulse Strength (0 to 35 points)
    // Measure impulse in units of coin's own volatility (|mom| / ATR%)
    const momInAtrUnits = absMom / Math.max(0.15, atrPct);
    let impulseBase = 0;
    if (momInAtrUnits >= 0.25) {
      // Moves above 0.25x ATR scale progressively up to 25 points at 2.5x ATR
      impulseBase = Math.min(25, (momInAtrUnits - 0.25) * 11.5);
    }

    const emaBonus = ((side === 'BUY' && distFromEmaPct > 0) || (side === 'SELL' && distFromEmaPct < 0))
      ? Math.min(6, (Math.abs(distFromEmaPct) / Math.max(0.2, atrPct)) * 3)
      : 0;

    const impulseScore = Math.min(35, Math.max(0, (impulseBase + emaBonus + persistenceBonus) * qualityMultiplier));

    // Smooth linear weight ramp (0 -> 1 between f = 0.25 and f = 0.50) to eliminate score jump
    const rampWeight = isUnconfirmed ? Math.max(0, Math.min(1.0, (f - 0.25) / 0.25)) : 1.0;

    // Pillar B: Relative Volume (0 to 25 points) - Smooth linear ramp between f = 0.25 and 0.50
    let rvolScore = 0;
    if (rampWeight > 0 && rvol > 1.0) {
      const rawRvol = Math.min(25, 25 * (1 - Math.exp(-(rvol - 1.0) / 1.1)));
      rvolScore = rawRvol * rampWeight;
    }

    // Pillar C: ATR / Volatility Expansion (0 to 20 points) - Smooth linear ramp between f = 0.25 and 0.50
    let atrScore = 0;
    if (rampWeight > 0 && atrExpansion > 1.0) {
      const rawAtr = Math.min(20, (atrExpansion - 1.0) * 16);
      atrScore = rawAtr * rampWeight;
    }

    // Pillar D: Higher Timeframe Confluence (0 to 20 points)
    // Confluence bonus is only earned when there is actual market activity
    let htfScore = 0;
    if (htfAligned) {
      const activityRatio = Math.min(1.0, (impulseScore + rvolScore + atrScore) / 25);
      htfScore = htfTrend === 'NEUTRAL' ? (8 * activityRatio) : (20 * activityRatio);
    }

    // Total Normalized Score (0 to 100)
    let rawScore = impulseScore + rvolScore + atrScore + htfScore;
    if (!htfAligned) {
      rawScore = Math.max(0, rawScore - 20); // Severe penalty for counter-HTF trades
    }
    const totalScore = Math.max(0, Math.min(100, rawScore));

    return {
      score: parseFloat(totalScore.toFixed(1)),
      side,
      mom: parseFloat(mom.toFixed(2)),
      rvol: parseFloat(rvol.toFixed(2)),
      atrExpansion: parseFloat(atrExpansion.toFixed(2)),
      currentAtr: candleRange, // Exact candle range
      atr14: avgAtr, // 14-period closed candle ATR for sizing (Item 3)
      candleElapsedSeconds,
      lastPrice: lastClose,
      threshold,
      htfTrend,
      htfAligned,
      climax: isClimax,
      factors: {
        impulseScore: parseFloat(impulseScore.toFixed(1)),
        rvolScore: parseFloat(rvolScore.toFixed(1)),
        atrScore: parseFloat(atrScore.toFixed(1)),
        htfScore: parseFloat(htfScore.toFixed(1)),
        climax: isClimax,
      },
    };
  }

  /**
   * Standard Exponential Moving Average helper
   */
  private calculateEMA(values: number[], period: number): number {
    if (!values || values.length === 0) return 0;
    if (values.length <= period) {
      return values.reduce((a, b) => a + b, 0) / values.length;
    }
    const k = 2 / (period + 1);
    let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < values.length; i++) {
      ema = values[i] * k + ema * (1 - k);
    }
    return ema;
  }
}
