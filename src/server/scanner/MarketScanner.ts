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
import { directionEngine } from '../engine/DirectionEngine';
import { UniverseManager, DEFAULT_UNIVERSE_FILTER } from './UniverseManager';

export class MarketScanner {
  private adapter: IExecutionAdapter;
  private engine: MomentumEngine;
  private universeManager: UniverseManager;
  private logAuditFn?: (type: AuditLogType, message: string, details?: any) => void;

  private isScanning: boolean = false;
  private lastScanTimestamp: number = 0;
  private lastScanDurationMs: number = 0;
  private scanCycleCount: number = 0;
  private cachedOpportunities: ScannedOpportunity[] = [];
  private filterConfig: UniverseFilterConfig = { ...DEFAULT_UNIVERSE_FILTER };

  // In-memory cache for klines to avoid spamming the exchange on rapid scans
  private klineCache: Map<string, { klines: Kline[]; timestamp: number }> = new Map();
  private readonly LTF_CACHE_TTL_MS = 10_000;  // 10s TTL for LTF
  private readonly HTF_CACHE_TTL_MS = 300_000; // 5 min TTL for HTF (Item 4)

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
   * Uses separate TTL for HTF (5 min) and LTF (10s), explicit via isHtf parameter.
   */
  private async fetchKlinesWithTimeout(
    symbol: string,
    interval: string,
    limit: number = 60,
    timeoutMs: number = 8000,
    isHtf: boolean = false
  ): Promise<Kline[]> {
    const cacheKey = `${symbol}_${interval}`;
    const cached = this.klineCache.get(cacheKey);
    const now = Date.now();
    const ttl = isHtf ? this.HTF_CACHE_TTL_MS : this.LTF_CACHE_TTL_MS;

    if (cached && now - cached.timestamp < ttl) {
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
   * Public accessor for cached or fresh LTF klines for structural invalidation checks without API spam.
   */
  public async getKlinesForSymbol(symbol: string, interval: string, limit: number = 60): Promise<Kline[]> {
    return this.fetchKlinesWithTimeout(symbol, interval, limit, 6000, false);
  }

  /**
   * Concurrency-controlled worker pool to scan symbols without overwhelming API rate limits.
   * Supports Multi-Timeframe (LTF + HTF confirmation for top 35 candidates via worker pool).
   */
  private async scanBatchWithConcurrency(
    symbols: string[],
    tickersMap: Record<string, any>,
    mainTf: string,
    htf: string,
    concurrency: number = 3,
    invertSignals: boolean = false,
    bypassImpulseGate: boolean = false
  ): Promise<ScannedOpportunity[]> {
    const results: ScannedOpportunity[] = [];
    const queue = [...symbols];

    const worker = async () => {
      while (queue.length > 0) {
        const symbol = queue.shift();
        if (!symbol) break;

        try {
          const ticker = tickersMap[symbol];
          const klinesLtf = await this.fetchKlinesWithTimeout(symbol, mainTf, 60, 8000, false);

          if (klinesLtf && klinesLtf.length >= 22) {
            const klinesMap: Record<string, Kline[]> = { [mainTf]: klinesLtf };

            const opportunity = this.engine.evaluateCandidate(
              symbol,
              klinesMap,
              ticker
                ? {
                    volume24hUSDT: ticker.turnover24hUSDT,
                    priceChange24hPct: ticker.priceChange24hPct,
                    spreadPct: ticker.spreadPct,
                  }
                : undefined,
              { invertExtremeSignals: invertSignals, bypassImpulseGate }
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

    // Multi-Timeframe Confluence (Item 4: Real HTF for top 30-40 candidates via worker pool)
    // Sort initial results with strict tie-break (Item 6)
    results.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const sA = a.spreadPct ?? 999;
      const sB = b.spreadPct ?? 999;
      if (sA !== sB) return sA - sB;
      return (b.volume24hUSDT || 0) - (a.volume24hUSDT || 0);
    });

    const topCandidates = results.slice(0, 35);
    const htfQueue = [...topCandidates];

    const htfWorker = async () => {
      while (htfQueue.length > 0) {
        const cand = htfQueue.shift();
        if (!cand) break;

        try {
          const htfKlines = await this.fetchKlinesWithTimeout(cand.symbol, htf, 60, 6000, true);
          if (htfKlines && htfKlines.length >= 20) {
            const ltfKlines = await this.fetchKlinesWithTimeout(cand.symbol, mainTf, 60, 6000, false);
            if (ltfKlines) {
              const reevaluated = this.engine.evaluateCandidate(
                cand.symbol,
                { [mainTf]: ltfKlines, [htf]: htfKlines },
                tickersMap[cand.symbol]
                  ? {
                      volume24hUSDT: tickersMap[cand.symbol].turnover24hUSDT,
                      priceChange24hPct: tickersMap[cand.symbol].priceChange24hPct,
                      spreadPct: tickersMap[cand.symbol].spreadPct,
                    }
                  : undefined,
                { invertExtremeSignals: invertSignals, bypassImpulseGate }
              );
              if (reevaluated) {
                cand.score = reevaluated.score;
                cand.currentAtr = reevaluated.currentAtr;
                cand.atr14 = reevaluated.atr14;
                cand.candleElapsedSeconds = reevaluated.candleElapsedSeconds;
                cand.spreadPct = reevaluated.spreadPct;
                cand.atrPct = reevaluated.atrPct;
                cand.side = reevaluated.side;
                cand.originalSide = reevaluated.originalSide;
                cand.isFadeTrade = reevaluated.isFadeTrade;
                cand.signal = reevaluated.signal;
                cand.climax = reevaluated.climax;
                cand.isEligible = reevaluated.isEligible;
              }
            }
          }
        } catch {
          // HTF failure is non-blocking
        }

        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };

    const htfWorkers = Array.from({ length: Math.min(3, topCandidates.length) }, () => htfWorker());
    await Promise.all(htfWorkers);

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
  public async scan(
    profile: ProfileConfig,
    invertSignals: boolean = false,
    activePositionsSymbols?: string[],
    bypassImpulseGate: boolean = false
  ): Promise<ScannedOpportunity[]> {
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
      // 1. Get filtered eligible symbols from OKX EEA universe (filterConfig from SCANNER PARAMETERS & LIQUIDITY FILTERS is the sovereign source)
      const scanFilter: UniverseFilterConfig = {
        ...this.filterConfig,
      };

      // Only fall back to profile volume limits if not configured in filterConfig
      if ((scanFilter.min24hVolumeUSDT === undefined || scanFilter.min24hVolumeUSDT === 0) && profile.min24hVolumeUSDT && profile.min24hVolumeUSDT > 0) {
        scanFilter.min24hVolumeUSDT = profile.min24hVolumeUSDT;
      }
      if ((scanFilter.max24hVolumeUSDT === undefined || scanFilter.max24hVolumeUSDT === 0) && profile.max24hVolumeUSDT && profile.max24hVolumeUSDT > 0) {
        scanFilter.max24hVolumeUSDT = profile.max24hVolumeUSDT;
      }

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

      // Latenta scan (Item 5: Hot list doar daca SCAN_COMPLETED > 10s)
      this.scanCycleCount++;
      const openPos = activePositionsSymbols || [];
      let symbolsToScan = Array.from(new Set([...eligibleSymbols, ...openPos]));
      const isHighLatency = this.lastScanDurationMs > 10_000;
      if (isHighLatency && this.cachedOpportunities.length > 30 && (this.scanCycleCount % 4 !== 0)) {
        const top30 = this.cachedOpportunities.slice(0, 30).map((s) => s.symbol);
        const hotSet = new Set([...top30, ...openPos]);
        symbolsToScan = symbolsToScan.filter((s) => hotSet.has(s));
      }

      // 2. Scan candidates with concurrency protection (max 3 concurrent requests)
      const scannedList = await this.scanBatchWithConcurrency(
        symbolsToScan,
        tickersMap,
        mainTf,
        htf,
        3,
        invertSignals,
        bypassImpulseGate
      );

      // 3. Initial rank by Momentum & Volatility score
      scannedList.sort((a, b) => {
        if (b.score !== a.score) {
          return b.score - a.score;
        }
        const spreadA = a.spreadPct !== undefined ? a.spreadPct : 999;
        const spreadB = b.spreadPct !== undefined ? b.spreadPct : 999;
        if (spreadA !== spreadB) {
          return spreadA - spreadB;
        }
        return (b.volume24hUSDT || 0) - (a.volume24hUSDT || 0);
      });

      // 4. STAGE 2 FUNNEL: Real-Time Order Flow & Microstructure (DirectionEngine)
      // Subscribe WS Ring-Buffer (`trades`, `books5`, `liquidation-orders`) to Top 25 candidates + Open Positions
      const topWsCandidates = scannedList.slice(0, 25);
      const trackedSymbols = Array.from(
        new Set([...topWsCandidates.map((c) => c.symbol), ...openPos])
      );
      directionEngine.updateTrackedSymbols(trackedSymbols, (sym) => {
        const meta = this.universeManager.getInstrumentMetadata(sym);
        return meta?.ctVal || this.adapter.getCachedCtVal?.(sym) || 1;
      });

      // Warm up top 35 candidates via lightweight REST (trades + L2 books + open interest) with concurrency 6
      const topStage2Candidates = scannedList.slice(0, 35);
      const warmupQueue = [...topStage2Candidates];
      const warmupWorker = async () => {
        while (warmupQueue.length > 0) {
          const cand = warmupQueue.shift();
          if (!cand) break;
          try {
            const meta = this.universeManager.getInstrumentMetadata(cand.symbol);
            const ctVal = meta?.ctVal || this.adapter.getCachedCtVal?.(cand.symbol) || 1;
            await directionEngine.warmupSymbol(cand.symbol, ctVal);
          } catch {}
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(6, topStage2Candidates.length) }, () => warmupWorker())
      );

      // Evaluate Order Flow & Microstructure across scanned opportunities
      // On SCALP profile (Varianta B): DirectionEngine is the primary directional brain, while preserving Fade Climax option
      const isScalpBrain = profile.type === 'SCALP' || profile.type === 'PAIR_SCALP';
      for (const opp of scannedList) {
        const cachedLtf = this.klineCache.get(`${opp.symbol}_${mainTf}`)?.klines;
        const assessment = directionEngine.evaluate(opp.symbol, cachedLtf, {
          invertSignals,
          isClimax: Boolean(opp.climax),
          currentAtr: opp.atr14 || opp.currentAtr,
          lastPrice: opp.price,
        });
        opp.directionAssessment = assessment;

        const hasRealTickFlow = (assessment.metrics.sampleTradesCount || 0) >= 5;

        if (isScalpBrain) {
          const isExtremeClimaxFade = Boolean(invertSignals && opp.climax && hasRealTickFlow);
          const isAbsorptionReversal =
            hasRealTickFlow &&
            (assessment.regime === 'BULLISH_ABSORPTION' || assessment.regime === 'BEARISH_ABSORPTION') &&
            assessment.confidence >= 55;

          if (hasRealTickFlow && (assessment.direction !== 'NEUTRAL' || isExtremeClimaxFade)) {
            // Varianta B: DirectionEngine dictates the direction on SCALP (with Fade Climax preserved)
            const chosenSide = isExtremeClimaxFade && assessment.direction === 'NEUTRAL'
              ? opp.side
              : assessment.side;
            const rawOriginalSide = assessment.isFadeSignal
              ? (chosenSide === 'BUY' ? 'SELL' : 'BUY')
              : chosenSide;

            opp.side = chosenSide;
            opp.originalSide = rawOriginalSide;
            opp.isFadeTrade = Boolean(invertSignals || assessment.isFadeSignal);

            // Blend Order Flow Direction Score (65%) with Volatility/RVOL Activity Score (35%)
            const blendedScore = parseFloat(
              Math.min(99.5, Math.max(0, assessment.directionScore * 0.65 + opp.score * 0.35)).toFixed(1)
            );
            opp.score = blendedScore;

            // Safety gate from MomentumEngine: block overextended / exhaustion wicks UNLESS
            // we are fading climax (invertSignals) OR DirectionEngine detected true passive Absorption reversal
            const passesSafetyFilter =
              bypassImpulseGate ||
              invertSignals ||
              isAbsorptionReversal ||
              !opp.entryQuality ||
              opp.entryQuality === 'OPTIMAL';

            const minThreshold = profile.minMomentumScore || 50;
            opp.isEligible = passesSafetyFilter && opp.score >= minThreshold;

            if (opp.isEligible) {
              opp.signal = {
                symbol: opp.symbol,
                side: opp.side,
                originalSide: opp.originalSide,
                isFadeTrade: opp.isFadeTrade,
                climax: opp.climax,
                score: opp.score,
                profile: profile.type,
                timestamp: Date.now(),
                currentPrice: opp.price,
                currentAtr: opp.currentAtr,
                atr14: opp.atr14,
                spreadPct: opp.spreadPct,
                candleElapsedSeconds: opp.candleElapsedSeconds,
                atrPct: opp.atrPct,
                directionAssessment: assessment,
                reasons: {
                  ...(opp.signal?.reasons || {}),
                  score: opp.score,
                  side: opp.side,
                  originalSide: opp.originalSide,
                  isFadeTrade: opp.isFadeTrade,
                  fadeClimax: opp.isFadeTrade,
                  climax: opp.climax,
                  rvol: opp.rvol,
                  atrExpansion: opp.atrExpansion,
                  lastPrice: opp.price,
                  atrPct: opp.atrPct,
                  orderFlowRegime: assessment.regime,
                  probabilityUp: assessment.probabilityUp,
                  directionalProbability: assessment.directionalProbability,
                  orderFlowConfidence: assessment.confidence,
                  orderFlowMetrics: assessment.metrics,
                  orderFlowReasoning: assessment.reasoning,
                },
              };
            } else {
              opp.signal = undefined;
            }
          } else {
            // Order flow is CHOP_BALANCED (NEUTRAL) or market is closed/illiquid (<5 trades in 15m) -> veto entry on SCALP
            if (!hasRealTickFlow) {
              opp.score = parseFloat((opp.score * 0.5).toFixed(1));
            }
            if (!bypassImpulseGate || !hasRealTickFlow) {
              opp.isEligible = false;
              opp.signal = undefined;
            }
          }
        }
      }

      // Re-sort opportunities after Stage 2 Order Flow scoring
      scannedList.sort((a, b) => {
        if (b.score !== a.score) {
          return b.score - a.score;
        }
        const spreadA = a.spreadPct !== undefined ? a.spreadPct : 999;
        const spreadB = b.spreadPct !== undefined ? b.spreadPct : 999;
        if (spreadA !== spreadB) {
          return spreadA - spreadB;
        }
        return (b.volume24hUSDT || 0) - (a.volume24hUSDT || 0);
      });

      // Assign final ranks (#1, #2, ...)
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
