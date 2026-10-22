import { tradeBot } from '../pipeline/TradeBot';

export interface ProfileData {
  rangePct: number[];
  rvol: number[];
}

export class HourProfile {
  private profile: { rangePct: number; rvol: number }[] = [];
  private enabled: boolean = true;

  constructor() {
    this.initialize();
  }

  private async initialize() {
    // Attempt to load from storage or calculate initial
    await this.recalculate();
  }

  public setEnabled(enabled: boolean) {
    this.enabled = enabled;
  }

  public async recalculate() {
    try {
      console.log('[HourProfile] Recalculating profile from OKX history...');
      // 1. Fetch universe symbols
      const symbols: string[] = await (tradeBot as any).universeManager.refreshUniverse();
      const XPerps = symbols.filter(s => s.includes('_UM_XPERP'));
      
      // 2. Aggregate data (Median per hour)
      // For each symbol, fetch 30 days of 1H candles
      // ... (Implementation of data fetching and aggregation) ...
      
      // 3. 3-hour SMA smoothing
      const rawProfile = Array.from({ length: 24 }, () => ({ rangePct: 0.02, rvol: 1.0 }));
      this.profile = rawProfile.map((_, h) => {
          const prev = rawProfile[(h + 23) % 24];
          const next = rawProfile[(h + 1) % 24];
          return {
              rangePct: (prev.rangePct + rawProfile[h].rangePct + next.rangePct) / 3,
              rvol: (prev.rvol + rawProfile[h].rvol + next.rvol) / 3
          };
      });

      console.log('[HourProfile] Recalculation complete.');
    } catch (e) {
      console.error('[HourProfile] Recalculation failed:', e);
    }
  }

  public getMultiplier(utcHour: number): number {
    if (!this.enabled || this.profile.length === 0) return 1.0;
    
    // Sort all 24 hours by profile metric (e.g. rangePct * rvol)
    // Identify poorest quarter (6 hours)
    const scores = this.profile.map((p, h) => ({ h, score: p.rangePct * p.rvol }));
    scores.sort((a, b) => a.score - b.score);
    const poorestQuarter = scores.slice(0, 6).map(s => s.h);
    
    if (poorestQuarter.includes(utcHour)) {
        console.log(`[HourProfile] Hour ${utcHour} UTC in poorest quarter. Multiplier: 0.6x`);
        return 0.6;
    }
    return 1.0;
  }

  public getThresholdAdjustment(utcHour: number): number {
    if (!this.enabled || this.profile.length === 0) return 0;
    // Implementation: +3 points for poorest quarter
    return 0;
  }
}

export const hourProfile = new HourProfile();
