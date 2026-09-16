import { Kline, ProfileConfig, TradeSignal, ScannedOpportunity } from '../../shared/types';

export interface MomentumMetrics {
  score: number;
  mom: number;
  rvol: number;
  atrExpansion: number;
  currentAtr: number;
  lastPrice: number;
  threshold: number;
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

  public evaluate(symbol: string, klines: Record<string, Kline[]>): TradeSignal | null {
    if (!klines || Object.keys(klines).length === 0) return null;
    
    const mainTf = this.config.timeframes[0] || '15m';
    const mainKlines = klines[mainTf] || Object.values(klines)[0];
    
    if (!mainKlines || mainKlines.length < 25) return null;

    const metrics = this.calculateMetrics(klines);

    if (metrics.score > metrics.threshold) {
      return {
        symbol,
        side: 'BUY',
        score: metrics.score,
        profile: this.config.type,
        timestamp: Date.now(),
        reasons: {
          score: metrics.score,
          threshold: metrics.threshold,
          mom: metrics.mom,
          rvol: metrics.rvol,
          atrExpansion: metrics.atrExpansion,
          timeframes: this.config.timeframes,
        },
      };
    }
    
    return null;
  }

  public evaluateCandidate(
    symbol: string,
    klines: Record<string, Kline[]>,
    tickerData?: { volume24hUSDT: number; priceChange24hPct: number }
  ): ScannedOpportunity | null {
    if (!klines || Object.keys(klines).length === 0) return null;
    
    const mainTf = this.config.timeframes[0] || '15m';
    const mainKlines = klines[mainTf] || Object.values(klines)[0];
    
    if (!mainKlines || mainKlines.length < 22) return null;

    const metrics = this.calculateMetrics(klines);
    const signal = this.evaluate(symbol, klines);

    return {
      symbol,
      price: metrics.lastPrice,
      volume24hUSDT: tickerData?.volume24hUSDT || 0,
      priceChange24hPct: tickerData?.priceChange24hPct || metrics.mom,
      rvol: metrics.rvol,
      atrExpansion: metrics.atrExpansion,
      score: metrics.score,
      side: 'BUY',
      isEligible: metrics.score > metrics.threshold,
      signal: signal || undefined,
      rank: 0,
      lastScannedTime: Date.now(),
    };
  }

  public calculateMetrics(klinesMap: Record<string, Kline[]>): MomentumMetrics {
    const EPSILON = 1e-8;
    const threshold = this.config.minMomentumScore || (this.config.type === 'SCALP' ? 65 : 60);
    
    const mainTf = this.config.timeframes[0] || '15m';
    const klines = klinesMap[mainTf] || klinesMap['15'] || klinesMap['15m'] || Object.values(klinesMap)[0];
    
    if (!klines || klines.length < 22) {
      return {
        score: 50,
        mom: 0,
        rvol: 1.0,
        atrExpansion: 1.0,
        currentAtr: 0,
        lastPrice: 0,
        threshold,
      };
    }

    const last = klines[klines.length - 1];
    const prev = klines[klines.length - 2];
    
    // Momentum
    const mom = ((last.close / prev.close) - 1) * 100;
    const clampedMom = Math.max(-15, Math.min(25, mom));

    // RVOL (Relative Volume across last 20 candles)
    const volAvg = klines.slice(-21, -1).reduce((a, b) => a + b.volume, 0) / 20;
    const rvol = Math.min(15, last.volume / (volAvg + EPSILON));

    // ATR
    const currentAtr = last.high - last.low;
    const avgAtr = klines.slice(-15, -1).reduce((a, b) => a + (b.high - b.low), 0) / 14;
    const atrExpansion = Math.max(0.2, Math.min(5.0, currentAtr / (avgAtr + EPSILON)));

    const rawScore = (clampedMom * 2) + ((rvol - 1) * 5) + ((atrExpansion - 1) * 10);
    const score = Math.max(0, Math.min(100, 50 + rawScore));
    
    return {
      score: parseFloat(score.toFixed(1)),
      mom: parseFloat(mom.toFixed(2)),
      rvol: parseFloat(rvol.toFixed(2)),
      atrExpansion: parseFloat(atrExpansion.toFixed(2)),
      currentAtr: parseFloat(currentAtr.toFixed(4)),
      lastPrice: last.close,
      threshold,
    };
  }
}
