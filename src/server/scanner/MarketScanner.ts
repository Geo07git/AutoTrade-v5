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
   * Safe fetch for klines with concurrency limit, timeout, AbortController, and failure isolation.
   */
  private async fetchKlinesWithTimeout(
    symbol: string,
    interval: string,
    limit: number = 30,
    timeoutMs: number = 8000
  ): Promise<Kline[]> {
    const cacheKey = `${symbol}_${interval}`;
    const cached = this.klineCache.get(cacheKey);
    const now = Date.now();

    if (cached && now - cached.timestamp < this.KLINE_CACHE_TTL_MS) {
      return cached.klines;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const klines = await this.adapter.getKlines(symbol, interval, limit, controller.signal);
      clearTimeout(timeoutId);
      if (klines && klines.length > 0) {
        this.klineCache.set(cacheKey, { klines, timestamp: now });
        return klines;
      }
      return [];
    } catch {
      clearTimeout(timeoutId);
      // Gracefully isolate error per symbol during rapid market scans
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
    concurrency: number = 3,
    invertSignals: boolean = false
  ): Promise<ScannedOpportunity[]> {
    const results: ScannedOpportunity[] = [];
    const queue = [...symbols];

    const worker = async () => {
      while (queue.length > 0) {
        const symbol = queue.shift();
        if (!symbol) break;

        try {
          const ticker = tickersMap[symbol];
          const klinesLtf = await this.fetchKlinesWithTimeout(symbol, mainTf, 35, 8000);

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
                : undefined,
              { invertExtremeSignals: invertSignals }
            );

            if (opportunity) {
              results.push(opportunity);
            }
          }
        } catch {
          // Failure on single symbol does NOT stop the scan
        }

        // Rate limit breather between consecutive queries (80ms per worker keeps total req/s ~8, within OKX 10 req/s limit)
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
    };

    // Run workers up to concurrency limit (max 3 concurrent connections)
    const workers = Array.from({ length: Math.min(concurrency, symbols.length) }, () => worker());
    await Promise.all(workers);

    // Multi-Timeframe Confluence:
    // For top 10 ranked candidates, fetch HTF candles to verify macro trend confluence
    results.sort((a, b) => b.score - a.score);
    const topCandidates = results.slice(0, 10);

    for (const cand of topCandidates) {
      try {
        const htfKlines = await this.fetchKlinesWithTimeout(cand.symbol, htf, 30, 6000);
        if (htfKlines && htfKlines.length >= 20) {
          const ltfKlines = await this.fetchKlinesWithTimeout(cand.symbol, mainTf, 35, 6000);
          if (ltfKlines) {
            const reevaluated = this.engine.evaluateCandidate(
              cand.symbol,
              { [mainTf]: ltfKlines, [htf]: htfKlines },
              tickersMap[cand.symbol]
                ? {
                    volume24hUSDT: tickersMap[cand.symbol].turnover24hUSDT,
                    priceChange24hPct: tickersMap[cand.symbol].priceChange24hPct,
                  }
                : undefined,
              { invertExtremeSignals: invertSignals }
            );
            if (reevaluated) {
              cand.score = reevaluated.score;
              cand.currentAtr = reevaluated.currentAtr;
              cand.atrPct = reevaluated.atrPct;
              cand.side = reevaluated.side;
              cand.originalSide = reevaluated.originalSide;
              cand.isFadeTrade = reevaluated.isFadeTrade;
              cand.signal = reevaluated.signal;
              cand.isEligible = reevaluated.isEligible;
            }
          }
        }
      } catch {
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
  public async scan(profile: ProfileConfig, invertSignals: boolean = false): Promise<ScannedOpportunity[]> {
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
      // 1. Get filtered eligible symbols from OKX EEA USDT SWAP universe (merging active profile volume limits)
      const scanFilter: UniverseFilterConfig = {
        ...this.filterConfig,
        ...(profile.min24hVolumeUSDT !== undefined && profile.min24hVolumeUSDT > 0
          ? { min24hVolumeUSDT: profile.min24hVolumeUSDT }
          : {}),
        ...(profile.max24hVolumeUSDT !== undefined
          ? { max24hVolumeUSDT: profile.max24hVolumeUSDT }
          : {}),
      };
      const { allSymbolsCount, eligibleSymbols, tickersMap } =
        await this.universeManager.getFilteredUniverse(scanFilter);

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

      // 2. Scan candidates with concurrency protection (max 3 concurrent requests)
      const scannedList = await this.scanBatchWithConcurrency(
        eligibleSymbols,
        tickersMap,
        mainTf,
        htf,
        3,
        invertSignals
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
