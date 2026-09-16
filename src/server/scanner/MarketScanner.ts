import {
  AuditLogType,
  ProfileConfig,
  ScannedOpportunity,
  ScannerStats,
  UniverseFilterConfig,
  Kline,
} from '../../shared/types';
import { IExecutionAdapter } from '../exchange/IExecutionAdapter';
import { MomentumEngine } from '../engine/MomentumEngine';
import { UniverseManager, DEFAULT_UNIVERSE_FILTER } from './UniverseManager';

export class MarketScanner {
  private adapter: IExecutionAdapter;
  private engine: MomentumEngine;
  private universeManager: UniverseManager;
  private logAuditFn?: (type: AuditLogType, message: string, details?: any) => void;

  private isScanning: boolean = false;
  private lastScanTimestamp: number = 0;
  private lastScanDurationMs: number = 0;
  private cachedOpportunities: ScannedOpportunity[] = [];
  private filterConfig: UniverseFilterConfig = { ...DEFAULT_UNIVERSE_FILTER };

  // In-memory cache for klines to avoid spamming the exchange on rapid scans
  private klineCache: Map<string, { klines: Kline[]; timestamp: number }> = new Map();
  private readonly KLINE_CACHE_TTL_MS = 20_000; // 20s TTL

  constructor(
    adapter: IExecutionAdapter,
    engine: MomentumEngine,
    universeManager: UniverseManager,
    logAudit?: (type: AuditLogType, message: string, details?: any) => void
  ) {
    this.adapter = adapter;
    this.engine = engine;
    this.universeManager = universeManager;
    this.logAuditFn = logAudit;
  }

  public setAuditLogger(fn: (type: AuditLogType, message: string, details?: any) => void) {
    this.logAuditFn = fn;
    this.universeManager.setAuditLogger(fn);
  }

  public updateFilterConfig(newConfig: Partial<UniverseFilterConfig>) {
    this.filterConfig = { ...this.filterConfig, ...newConfig };
  }

  public getFilterConfig(): UniverseFilterConfig {
    return { ...this.filterConfig };
  }

  public getStats(): ScannerStats {
    const candidateOpportunities = this.cachedOpportunities.filter((o) => o.isEligible);
    return {
      universeCount: this.universeManager.getCachedUniverseCount(),
      filteredCount: this.cachedOpportunities.length,
      candidatesCount: candidateOpportunities.length,
      lastScanDurationMs: this.lastScanDurationMs,
      lastScanTimestamp: this.lastScanTimestamp,
      isScanning: this.isScanning,
      topOpportunities: this.cachedOpportunities,
      filterConfig: this.getFilterConfig(),
    };
  }

  /**
   * Safe fetch for klines with concurrency limit, timeout, and failure isolation.
   */
  private async fetchKlinesWithTimeout(
    symbol: string,
    interval: string,
    limit: number = 30,
    timeoutMs: number = 5000
  ): Promise<Kline[]> {
    const cacheKey = `${symbol}_${interval}`;
    const cached = this.klineCache.get(cacheKey);
    const now = Date.now();

    if (cached && now - cached.timestamp < this.KLINE_CACHE_TTL_MS) {
      return cached.klines;
    }

    const fetchPromise = this.adapter.getKlines(symbol, interval, limit);
    const timeoutPromise = new Promise<Kline[]>((_, reject) =>
      setTimeout(() => reject(new Error(`Kline fetch timeout (${timeoutMs}ms) for ${symbol}`)), timeoutMs)
    );

    try {
      const klines = await Promise.race([fetchPromise, timeoutPromise]);
      if (klines && klines.length > 0) {
        this.klineCache.set(cacheKey, { klines, timestamp: now });
        return klines;
      }
      return [];
    } catch (err: any) {
      // Isolate error per symbol: do NOT throw, just log debug and return empty
      console.warn(`[MarketScanner] Kline fetch failed for ${symbol}:`, err?.message || err);
      return [];
    }
  }

  /**
   * Concurrency-controlled worker pool to scan symbols without overwhelming API rate limits.
   * Supports Multi-Timeframe (LTF + HTF confirmation for top candidates).
   */
  private async scanBatchWithConcurrency(
    symbols: string[],
    tickersMap: Record<string, any>,
    mainTf: string,
    htf: string,
    concurrency: number = 5
  ): Promise<ScannedOpportunity[]> {
    const results: ScannedOpportunity[] = [];
    const queue = [...symbols];

    const worker = async () => {
      while (queue.length > 0) {
        const symbol = queue.shift();
        if (!symbol) break;

        try {
          const ticker = tickersMap[symbol];
          const klinesLtf = await this.fetchKlinesWithTimeout(symbol, mainTf, 35, 6000);

          if (klinesLtf && klinesLtf.length >= 22) {
            const klinesMap: Record<string, Kline[]> = { [mainTf]: klinesLtf };

            const opportunity = this.engine.evaluateCandidate(
              symbol,
              klinesMap,
              ticker
                ? {
                    volume24hUSDT: ticker.turnover24hUSDT,
                    priceChange24hPct: ticker.priceChange24hPct,
                  }
                : undefined
            );

            if (opportunity) {
              results.push(opportunity);
            }
          }
        } catch (err: any) {
          // Failure on single symbol does NOT stop the scan
          console.warn(`[MarketScanner] Evaluation error on ${symbol}:`, err?.message || err);
        }

        // Small rate limit breather between consecutive queries
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
    };

    // Run workers up to concurrency limit
    const workers = Array.from({ length: Math.min(concurrency, symbols.length) }, () => worker());
    await Promise.all(workers);

    // Multi-Timeframe Confluence (Problem #2):
    // For top 10 ranked candidates, fetch HTF candles to verify macro trend confluence
    results.sort((a, b) => b.score - a.score);
    const topCandidates = results.slice(0, 10);

    for (const cand of topCandidates) {
      try {
        const htfKlines = await this.fetchKlinesWithTimeout(cand.symbol, htf, 30, 4000);
        if (htfKlines && htfKlines.length >= 20) {
          const ltfKlines = await this.fetchKlinesWithTimeout(cand.symbol, mainTf, 35, 4000);
          if (ltfKlines) {
            const reevaluated = this.engine.evaluateCandidate(
              cand.symbol,
              { [mainTf]: ltfKlines, [htf]: htfKlines },
              tickersMap[cand.symbol]
                ? {
                    volume24hUSDT: tickersMap[cand.symbol].turnover24hUSDT,
                    priceChange24hPct: tickersMap[cand.symbol].priceChange24hPct,
                  }
                : undefined
            );
            if (reevaluated) {
              cand.score = reevaluated.score;
              cand.side = reevaluated.side;
              cand.signal = reevaluated.signal;
              cand.isEligible = reevaluated.isEligible;
            }
          }
        }
      } catch (err) {
        // HTF failure is non-blocking
      }
    }

    return results;
  }

  /**
   * Main scan cycle:
   * 1. Refresh Universe & Fetch 24h market liquidity
   * 2. Filter liquid symbols
   * 3. Fetch klines & compute momentum scores with controlled concurrency
   * 4. Rank candidates by momentum score descending
   * 5. Return ranked opportunities
   */
  public async scan(profile: ProfileConfig): Promise<ScannedOpportunity[]> {
    if (this.isScanning) {
      return this.cachedOpportunities;
    }

    this.isScanning = true;
    const startTime = Date.now();
    const mainTf = profile.timeframes[0] || '15';
    const htf = profile.timeframes[1] || '60';

    this.logAuditFn?.(
      'SCAN_STARTED',
      `Market Scanner started. Profiling universe for profile: ${profile.type} (LTF: ${mainTf}m, HTF: ${htf}m)...`
    );

    try {
      // 1. Get filtered eligible symbols from Bybit linear perpetual universe
      const { allSymbolsCount, eligibleSymbols, tickersMap } =
        await this.universeManager.getFilteredUniverse(this.filterConfig);

      if (eligibleSymbols.length === 0) {
        this.logAuditFn?.(
          'SCAN_COMPLETED',
          `Market Scan finished: 0 eligible symbols passed liquidity filters.`,
          { universeCount: allSymbolsCount }
        );
        this.cachedOpportunities = [];
        this.lastScanDurationMs = Date.now() - startTime;
        this.lastScanTimestamp = Date.now();
        this.isScanning = false;
        return [];
      }

      // 2. Scan candidates with concurrency protection (max 5 concurrent requests)
      const scannedList = await this.scanBatchWithConcurrency(
        eligibleSymbols,
        tickersMap,
        mainTf,
        htf,
        5
      );

      // 3. Rank opportunities descending by Momentum score
      scannedList.sort((a, b) => b.score - a.score);

      // Assign ranks (#1, #2, ...)
      scannedList.forEach((opp, index) => {
        opp.rank = index + 1;
      });

      this.cachedOpportunities = scannedList;
      this.lastScanDurationMs = Date.now() - startTime;
      this.lastScanTimestamp = Date.now();

      const candidateOpportunities = scannedList.filter((s) => s.isEligible);
      const topSymbolsStr = scannedList
        .slice(0, 5)
        .map((s) => `${s.symbol} (${s.score.toFixed(1)})`)
        .join(', ');

      this.logAuditFn?.(
        'SCAN_COMPLETED',
        `Market Scan completed in ${(this.lastScanDurationMs / 1000).toFixed(2)}s. Scanned: ${scannedList.length}/${eligibleSymbols.length} pairs. Candidates: ${candidateOpportunities.length}. Top: ${topSymbolsStr || 'None'}.`,
        {
          totalUniverse: allSymbolsCount,
          eligibleCount: eligibleSymbols.length,
          scannedCount: scannedList.length,
          candidatesCount: candidateOpportunities.length,
          topRanked: scannedList.slice(0, 5).map((s) => ({
            symbol: s.symbol,
            score: s.score,
            rvol: s.rvol,
            price: s.price,
          })),
        }
      );

      return scannedList;
    } catch (err: any) {
      this.logAuditFn?.(
        'SCAN_ERROR',
        `Market scan encountered an error: ${err?.message || err}`,
        { error: String(err) }
      );
      console.error('[MarketScanner] Fatal scan error:', err);
      return this.cachedOpportunities;
    } finally {
      this.isScanning = false;
    }
  }

  public getCachedOpportunities(): ScannedOpportunity[] {
    return this.cachedOpportunities;
  }
}
