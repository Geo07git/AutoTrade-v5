import { Kline, ProfileConfig, TradeSignal } from '../../shared/types';

export class MomentumEngine {
  private config: ProfileConfig;

  constructor(config: ProfileConfig) {
    this.config = config;
  }

  public setConfig(config: ProfileConfig) {
    this.config = config;
  }

  public evaluate(symbol: string, klines: Record<string, Kline[]>): TradeSignal | null {
    // Basic structural check
    if (!klines || Object.keys(klines).length === 0) return null;
    
    // We expect the market data fetcher to provide the timeframes requested by the profile
    const mainTf = this.config.timeframes[0] || '15m';
    const mainKlines = klines[mainTf];
    
    if (!mainKlines || mainKlines.length < 25) return null; // Not enough data

    const score = this.calculateScore(klines);
    
    // Config logic: Scalp needs a higher threshold maybe?
    const threshold = this.config.type === 'SCALP' ? 65 : 60;

    if (score > threshold) {
      return {
        symbol,
        side: 'BUY',
        score,
        profile: this.config.type,
        timestamp: Date.now(),
        reasons: {
          score,
          threshold,
          timeframes: this.config.timeframes
        }
      };
    }
    
    return null;
  }

  private calculateScore(klinesMap: Record<string, Kline[]>): number {
    // Cleaned up momentum scoring
    const EPSILON = 1e-8;
    
    // Let's assume we have 15m, 1h, 4h or whatever the profile dictates.
    // For simplicity, we just use the first timeframe if multiple are not provided, 
    // or map them if they are.
    const k15m = klinesMap['15'] || klinesMap['15m'] || Object.values(klinesMap)[0];
    
    if (!k15m || k15m.length < 22) return 50;

    const last = k15m[k15m.length - 1];
    const prev = k15m[k15m.length - 2];
    
    // Momentum
    const mom = ((last.close / prev.close) - 1) * 100;
    const clampedMom = Math.max(-15, Math.min(25, mom));

    // RVOL
    const volAvg = k15m.slice(-21, -1).reduce((a, b) => a + b.volume, 0) / 20;
    const rvol = Math.min(15, last.volume / (volAvg + EPSILON));

    // ATR
    const currentAtr = last.high - last.low;
    const avgAtr = k15m.slice(-15, -1).reduce((a, b) => a + (b.high - b.low), 0) / 14;
    const atrExpansion = Math.max(0.2, Math.min(5.0, currentAtr / (avgAtr + EPSILON)));

    const rawScore = (clampedMom * 2) + ((rvol - 1) * 5) + ((atrExpansion - 1) * 10);
    const score = Math.max(0, Math.min(100, 50 + rawScore));
    
    return score;
  }
}
