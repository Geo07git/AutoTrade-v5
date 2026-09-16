import { Kline, ProfileConfig, TradeSignal, ScannedOpportunity, OrderSide } from '../../shared/types';

export interface MomentumMetrics {
  score: number;
  side: OrderSide;
  mom: number;
  rvol: number;
  atrExpansion: number;
  currentAtr: number;
  lastPrice: number;
  threshold: number;
  htfTrend: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  htfAligned: boolean;
  factors: {
    impulseScore: number;     // 0 - 35 pts
    rvolScore: number;        // 0 - 25 pts
    atrScore: number;         // 0 - 20 pts
    htfScore: number;         // 0 - 20 pts
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
    precomputedMetrics?: MomentumMetrics
  ): TradeSignal | null {
    if (!klines || Object.keys(klines).length === 0) return null;

    const mainTf = this.config.timeframes[0] || '15';
    const mainKlines = klines[mainTf] || Object.values(klines)[0];

    if (!mainKlines || mainKlines.length < 22) return null;

    const metrics = precomputedMetrics || this.calculateMetrics(klines);

    if (metrics.score >= metrics.threshold) {
      return {
        symbol,
        side: metrics.side,
        score: metrics.score,
        profile: this.config.type,
        timestamp: Date.now(),
        reasons: {
          score: metrics.score,
          threshold: metrics.threshold,
          side: metrics.side,
          mom: metrics.mom,
          rvol: metrics.rvol,
          atrExpansion: metrics.atrExpansion,
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
    tickerData?: { volume24hUSDT: number; priceChange24hPct: number }
  ): ScannedOpportunity | null {
    if (!klines || Object.keys(klines).length === 0) return null;

    const mainTf = this.config.timeframes[0] || '15';
    const mainKlines = klines[mainTf] || Object.values(klines)[0];

    if (!mainKlines || mainKlines.length < 22) return null;

    // Calculate metrics ONCE per candidate
    const metrics = this.calculateMetrics(klines);
    // Reuse precomputed metrics - eliminates redundant duplicate calculation
    const signal = this.evaluate(symbol, klines, metrics);

    return {
      symbol,
      price: metrics.lastPrice,
      volume24hUSDT: tickerData?.volume24hUSDT || 0,
      priceChange24hPct: tickerData?.priceChange24hPct !== undefined ? tickerData.priceChange24hPct : metrics.mom,
      rvol: metrics.rvol,
      atrExpansion: metrics.atrExpansion,
      score: metrics.score,
      side: metrics.side,
      isEligible: metrics.score >= metrics.threshold,
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

    // 1. LTF Momentum & Direction
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

    // Determine Direction: BUY (Long) vs SELL (Short) (Problem #1)
    // Positive momentum + price above EMA -> BUY
    // Negative momentum + price below EMA -> SELL
    let side: OrderSide = 'BUY';
    if (mom < 0 && (distFromEmaPct < 0 || htfTrend === 'BEARISH')) {
      side = 'SELL';
    } else if (mom > 0 && (distFromEmaPct > 0 || htfTrend === 'BULLISH')) {
      side = 'BUY';
    } else {
      // Mixed: side follows the active candle price momentum
      side = mom >= 0 ? 'BUY' : 'SELL';
    }

    const htfAligned = (side === 'BUY' && htfTrend === 'BULLISH') || (side === 'SELL' && htfTrend === 'BEARISH');

    // Directional Magnitude of Momentum (|mom|)
    const absMom = Math.abs(mom);
    const clampedMom = Math.min(15, absMom);

    // 2. RVOL (Relative Volume across last 20 candles)
    const volAvg = ltfKlines.slice(-21, -1).reduce((a, b) => a + b.volume, 0) / 20;
    const rvol = Math.min(10, last.volume / (volAvg + EPSILON));

    // 3. ATR Expansion
    const currentAtr = last.high - last.low;
    const avgAtr = ltfKlines.slice(-15, -1).reduce((a, b) => a + (b.high - b.low), 0) / 14;
    const atrExpansion = Math.max(0.1, Math.min(5.0, currentAtr / (avgAtr + EPSILON)));

    // 4. Calibrated Multi-Factor Score Model (Problem #3)
    // Pillar A: Impulse Strength (0 to 35 points)
    // 1% candle = ~15pts, 3% candle = ~28pts, 5%+ candle = ~35pts
    const impulseScore = Math.min(35, (Math.sqrt(clampedMom) / Math.sqrt(6)) * 30 + (Math.abs(distFromEmaPct) > 0.5 ? 5 : 0));

    // Pillar B: Relative Volume (0 to 25 points)
    // Saturating curve: RVOL 1.0x = 10pts, 1.8x = 18pts, 3.0x+ = 25pts (prevents extreme spikes from breaking the model)
    const rvolScore = Math.min(25, Math.max(0, (rvol / (rvol + 1.2)) * 35));

    // Pillar C: ATR / Volatility Expansion (0 to 20 points)
    // atrExpansion 1.0x = 10pts, 1.8x+ = 20pts
    const atrScore = Math.min(20, Math.max(0, (atrExpansion / (atrExpansion + 0.8)) * 25));

    // Pillar D: Higher Timeframe Confluence (0 to 20 points)
    // Aligned HTF = full 20pts; Neutral/Divergent = 5 to 10pts
    const htfScore = htfAligned ? 20 : (htfTrend === 'NEUTRAL' ? 10 : 5);

    // Total Normalized Score (0 to 100)
    const totalScore = Math.max(0, Math.min(100, impulseScore + rvolScore + atrScore + htfScore));

    return {
      score: parseFloat(totalScore.toFixed(1)),
      side,
      mom: parseFloat(mom.toFixed(2)),
      rvol: parseFloat(rvol.toFixed(2)),
      atrExpansion: parseFloat(atrExpansion.toFixed(2)),
      currentAtr: parseFloat(currentAtr.toFixed(4)),
      lastPrice: lastClose,
      threshold,
      htfTrend,
      htfAligned,
      factors: {
        impulseScore: parseFloat(impulseScore.toFixed(1)),
        rvolScore: parseFloat(rvolScore.toFixed(1)),
        atrScore: parseFloat(atrScore.toFixed(1)),
        htfScore: parseFloat(htfScore.toFixed(1)),
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
