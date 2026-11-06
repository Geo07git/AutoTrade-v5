/**
 * HistoricalDataStore
 * Handles disk caching and delta synchronization for historical OHLCV klines
 * and funding rates from OKX (/market/history-candles & /public/funding-rate-history).
 * 
 * Cache location: data/history/ (with automatic fallback / creation)
 * Supports any X-Perp, SWAP, or USDC instrument.
 */

import fs from 'fs';
import path from 'path';
import { Kline } from '../../shared/types';
import { OKXAdapter } from '../exchange/OKXAdapter';

export interface FundingRateRecord {
  fundingTime: number;
  fundingRate: number;
  realizedRate?: number;
}

export class HistoricalDataStore {
  private cacheDir: string;
  private adapter: OKXAdapter;

  constructor(adapter: OKXAdapter, customCacheDir?: string) {
    this.adapter = adapter;
    this.cacheDir = customCacheDir || path.resolve(process.cwd(), 'data', 'history');
    this.ensureCacheDir();
  }

  private ensureCacheDir(): void {
    try {
      if (!fs.existsSync(this.cacheDir)) {
        fs.mkdirSync(this.cacheDir, { recursive: true });
      }
    } catch (err: any) {
      console.warn(`[HistoricalDataStore] Could not create cache dir ${this.cacheDir}:`, err?.message);
    }
  }

  private sanitizeFilename(symbol: string, suffix: string): string {
    const safe = symbol.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.cacheDir, `${safe}_${suffix}.json`);
  }

  private getBarDurationMs(bar: string): number {
    const norm = bar.toLowerCase().trim();
    if (norm === '1m' || norm === '1') return 60_000;
    if (norm === '3m' || norm === '3') return 180_000;
    if (norm === '5m' || norm === '5') return 300_000;
    if (norm === '15m' || norm === '15') return 900_000;
    if (norm === '30m' || norm === '30') return 1_800_000;
    if (norm === '1h' || norm === '60') return 3_600_000;
    if (norm === '2h' || norm === '120') return 7_200_000;
    if (norm === '4h' || norm === '240') return 14_400_000;
    if (norm === '1d' || norm === 'd') return 86_400_000;
    return 300_000;
  }

  /**
   * Loads cached klines from disk and delta-downloads only missing historical or recent candles.
   */
  public async loadOrFetchKlines(
    symbol: string,
    bar: string = '5m',
    days: number = 90,
    signal?: AbortSignal,
    onProgress?: (progressPct: number, message: string) => void
  ): Promise<Kline[]> {
    const instId = await this.adapter.resolveLiveInstrumentId(symbol);
    const filePath = this.sanitizeFilename(instId, bar);
    const targetStartTs = Date.now() - Math.max(1, days) * 86_400_000;
    const now = Date.now();
    const barMs = this.getBarDurationMs(bar);

    let existing: Kline[] = [];
    if (fs.existsSync(filePath)) {
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          existing = parsed;
        }
      } catch (err: any) {
        console.warn(`[HistoricalDataStore] Corrupted cache for ${filePath}, re-downloading:`, err?.message);
      }
    }

    // Determine what needs to be fetched
    let needFetch = false;
    let requiredDays = days;

    if (existing.length === 0) {
      needFetch = true;
      requiredDays = days;
    } else {
      const earliestTs = existing[0].timestamp;
      const latestTs = existing[existing.length - 1].timestamp;

      const hasOlderGap = earliestTs > targetStartTs + barMs * 5;
      const hasRecentGap = latestTs < now - barMs * 3;

      if (hasOlderGap || hasRecentGap) {
        needFetch = true;
        // If older gap exists, we need days covering back to targetStartTs
        if (hasOlderGap) {
          const missingOldDays = Math.ceil((earliestTs - targetStartTs) / 86_400_000) + 1;
          requiredDays = Math.max(days, missingOldDays);
        } else {
          // Only recent gap
          requiredDays = Math.ceil((now - latestTs) / 86_400_000) + 1;
        }
      }
    }

    if (!needFetch && existing.length > 0) {
      // Return cached slice filtered by targetStartTs
      if (onProgress) onProgress(100, `Încărcat complet din cache local (${existing.length} lumânări)`);
      return existing.filter((k) => k.timestamp >= targetStartTs);
    }

    if (onProgress) onProgress(10, `Descărcare date istorice de la OKX (${requiredDays} zile)...`);

    // Fetch from OKX
    const fetched = await this.adapter.getHistoryKlines(
      instId,
      bar,
      requiredDays,
      signal,
      (count) => {
        if (onProgress) {
          const estTotal = (requiredDays * 24 * 60) / (barMs / 60000);
          const pct = Math.min(90, Math.max(15, Math.round((count / Math.max(1, estTotal)) * 90)));
          onProgress(pct, `Descărcat ${count} lumânări OKX (${bar})...`);
        }
      }
    );

    // Merge existing + fetched, deduplicate by timestamp
    const map = new Map<number, Kline>();
    for (const k of existing) {
      map.set(k.timestamp, k);
    }
    for (const k of fetched) {
      map.set(k.timestamp, k);
    }

    const merged = Array.from(map.values()).sort((a, b) => a.timestamp - b.timestamp);

    // Persist merged cache to disk
    try {
      this.ensureCacheDir();
      const tmpPath = `${filePath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(merged), 'utf8');
      fs.renameSync(tmpPath, filePath);
    } catch (err: any) {
      console.warn(`[HistoricalDataStore] Error saving cache to ${filePath}:`, err?.message);
    }

    if (onProgress) onProgress(100, `Sincronizare finalizată: ${merged.length} lumânări disponibile.`);
    return merged.filter((k) => k.timestamp >= targetStartTs);
  }

  /**
   * Loads or delta-fetches historical funding rates.
   */
  public async loadOrFetchFunding(
    symbol: string,
    days: number = 90,
    signal?: AbortSignal
  ): Promise<FundingRateRecord[]> {
    const instId = await this.adapter.resolveLiveInstrumentId(symbol);
    const filePath = this.sanitizeFilename(instId, 'funding');
    const targetStartTs = Date.now() - Math.max(1, days) * 86_400_000;
    const now = Date.now();

    let existing: FundingRateRecord[] = [];
    if (fs.existsSync(filePath)) {
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          existing = parsed;
        }
      } catch (err: any) {
        console.warn(`[HistoricalDataStore] Corrupted funding cache, re-downloading:`, err?.message);
      }
    }

    let needFetch = false;
    let requiredDays = days;

    if (existing.length === 0) {
      needFetch = true;
    } else {
      const earliestTs = existing[0].fundingTime;
      const latestTs = existing[existing.length - 1].fundingTime;
      // Funding is every 8h -> 28_800_000 ms
      const hasOlderGap = earliestTs > targetStartTs + 86_400_000;
      const hasRecentGap = latestTs < now - 28_800_000 * 2;
      if (hasOlderGap || hasRecentGap) {
        needFetch = true;
        requiredDays = Math.max(days, Math.ceil((now - earliestTs) / 86_400_000) + 2);
      }
    }

    if (!needFetch && existing.length > 0) {
      return existing.filter((f) => f.fundingTime >= targetStartTs);
    }

    const fetched = await this.adapter.getFundingRateHistory(instId, requiredDays, signal);

    const map = new Map<number, FundingRateRecord>();
    for (const f of existing) {
      map.set(f.fundingTime, f);
    }
    for (const f of fetched) {
      map.set(f.fundingTime, f);
    }

    const merged = Array.from(map.values()).sort((a, b) => a.fundingTime - b.fundingTime);

    try {
      this.ensureCacheDir();
      const tmpPath = `${filePath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(merged), 'utf8');
      fs.renameSync(tmpPath, filePath);
    } catch (err: any) {
      console.warn(`[HistoricalDataStore] Error saving funding cache:`, err?.message);
    }

    return merged.filter((f) => f.fundingTime >= targetStartTs);
  }
}
