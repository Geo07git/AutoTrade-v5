import { UniverseFilterConfig, AuditLogType } from '../../shared/types';
import { InstrumentLotFilter } from '../exchange/IExecutionAdapter';

export interface InstrumentMetadata {
  instId: string;
  ctVal: number;
  ctValCcy: string;
  ctType: string;
  settleCcy: string;
  instType: string;
  instFamily: string;
  minSz?: number;
  lotSz?: number;
  tickSz?: number;
  maxMktSz?: number;
}

export interface MarketTickerInfo {
  symbol: string;
  lastPrice: number;
  turnover24hUSDT: number;
  volume24h: number;
  priceChange24hPct: number;
  highPrice24h: number;
  lowPrice24h: number;
  bidPx?: number;
  askPx?: number;
  spreadPct?: number;
}

export interface FilteredUniverseResult {
  allSymbolsCount: number;
  liquidSpreadFilteredCount: number;
  budgetFeasibleCount: number;
  eligibleSymbols: string[];
  tickersMap: Record<string, MarketTickerInfo>;
  preScoresMap: Record<string, number>;
}

export const DEFAULT_UNIVERSE_FILTER: UniverseFilterConfig = {
  min24hVolumeUSDT: 100_000, // $100k (0.1M) USDT/USD 24h turnover minimum
  max24hVolumeUSDT: 0,       // 0 = no upper limit by default
  minPrice: 0.0001,
  maxSymbols: 500,           // Permitem până la 500 de simboluri (acoperă întregul univers lichid)
  settleCoin: 'USDT',
  refreshIntervalMs: 15 * 60 * 1000, // 15 minutes
  maxSpreadPct: 0.10,        // 0.10% spread maxim (Item 5: maxSpreadPct = 0.10%)
  excludedSymbols: [],       // Universul reflectă lichiditatea; excluderile sunt gestionate de RiskEngine
};

export class UniverseManager {
  private okxBaseUrl: string = 'https://eea.okx.com';
  private cachedUniverse: string[] = [];
  private cachedTickersMap: Record<string, MarketTickerInfo> = {};
  private instrumentMetaMap: Map<string, InstrumentMetadata> = new Map();
  private lastRefreshTime: number = 0;
  private logAuditFn?: (type: AuditLogType, message: string, details?: any) => void;

  constructor(
    logAudit?: (type: AuditLogType, message: string, details?: any) => void
  ) {
    this.logAuditFn = logAudit;
  }

  public setAuditLogger(fn: (type: AuditLogType, message: string, details?: any) => void) {
    this.logAuditFn = fn;
  }

  /**
   * Fetches JSON from OKX public endpoint with a strict AbortController + Promise.race timeout
   * so neither fetch() nor res.json() can ever hang.
   */
  private async fetchJsonWithTimeout(url: string, timeoutMs: number = 6500): Promise<any | null> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeoutPromise = new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve(null);
        }, timeoutMs);
      });
      const fetchPromise = (async () => {
        const res = await fetch(url, {
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });
        if (!res.ok) return null;
        return await res.json();
      })();
      return await Promise.race([fetchPromise, timeoutPromise]);
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Fetches active instruments (FUTURES X-Perp & SWAP) from OKX EEA.
   * Caches results and metadata, refreshing only when stale or forced.
   */
  public async refreshUniverse(
    filterConfig: UniverseFilterConfig = DEFAULT_UNIVERSE_FILTER,
    force: boolean = false
  ): Promise<string[]> {
    const now = Date.now();
    const isStale = now - this.lastRefreshTime > filterConfig.refreshIntervalMs;

    if (!force && !isStale && this.cachedUniverse.length > 0) {
      return this.cachedUniverse;
    }

    try {
      // 1. Fetch FUTURES instruments (X-Perp) with hard timeout
      const data = await this.fetchJsonWithTimeout(`${this.okxBaseUrl}/api/v5/public/instruments?instType=FUTURES`, 7000);
      const symbols: string[] = [];

      if (data && data.code === '0' && Array.isArray(data.data)) {
        for (const inst of data.data) {
          if (inst.state === 'live') {
            this.instrumentMetaMap.set(inst.instId, {
              instId: inst.instId,
              ctVal: parseFloat(inst.ctVal || '1') || 1,
              ctValCcy: inst.ctValCcy || '',
              ctType: inst.ctType || 'linear',
              settleCcy: inst.settleCcy || 'USD',
              instType: inst.instType || 'FUTURES',
              instFamily: inst.instFamily || '',
              minSz: parseFloat(inst.minSz || '1') || 1,
              lotSz: parseFloat(inst.lotSz || '1') || 1,
              tickSz: parseFloat(inst.tickSz || '0.01') || 0.01,
              maxMktSz: parseFloat(inst.maxMktSz || '1000000') || 1000000,
            });
          }
        }
        const xPerps = data.data.filter((inst: any) => inst.state === 'live' && inst.instId.includes('_UM_XPERP'));
        symbols.push(...xPerps.map((i: any) => i.instId));
      }

      // Also populate SWAP instruments metadata if available (with hard timeout)
      try {
        const swapData = await this.fetchJsonWithTimeout(`${this.okxBaseUrl}/api/v5/public/instruments?instType=SWAP`, 7000);
        if (swapData && swapData.code === '0' && Array.isArray(swapData.data)) {
          for (const inst of swapData.data) {
            if (inst.state === 'live') {
              this.instrumentMetaMap.set(inst.instId, {
                instId: inst.instId,
                ctVal: parseFloat(inst.ctVal || '1') || 1,
                ctValCcy: inst.ctValCcy || '',
                ctType: inst.ctType || 'linear',
                settleCcy: inst.settleCcy || 'USDT',
                instType: inst.instType || 'SWAP',
                instFamily: inst.instFamily || '',
                minSz: parseFloat(inst.minSz || '1') || 1,
                lotSz: parseFloat(inst.lotSz || '1') || 1,
                tickSz: parseFloat(inst.tickSz || '0.01') || 0.01,
                maxMktSz: parseFloat(inst.maxMktSz || '1000000') || 1000000,
              });
            }
          }
        }
      } catch {}

      if (symbols.length > 0) {
        this.cachedUniverse = symbols;
        this.lastRefreshTime = now;
        this.logAuditFn?.(
          'UNIVERSE_REFRESH',
          `Dynamic Universe refreshed: ${symbols.length} active instruments (FUTURES X-Perp only).`,
          { totalCount: symbols.length }
        );
        return this.cachedUniverse;
      }
    } catch (err: any) {
      console.warn('[UniverseManager] OKX EEA instruments query error:', err?.message || err);
    }

    // Fallback to standard X-Perp universe if needed
    if (this.cachedUniverse.length === 0) {
      this.cachedUniverse = [
        'BTC-USD_UM_XPERP-310404' // Fallback for testing
      ];
    }

    return this.cachedUniverse;
  }

  /**
   * Fetches 24h market tickers for all SWAP and FUTURES perpetuals from OKX EEA in a single call.
   * Calculates actual 24h USD turnover correctly based on contract specs (vol24h * ctVal * lastPrice).
   */
  public async fetch24hTickers(): Promise<Record<string, MarketTickerInfo>> {
    const tickersMap: Record<string, MarketTickerInfo> = {};

    // Ensure instrument metadata map is populated
    if (this.instrumentMetaMap.size === 0) {
      await this.refreshUniverse();
    }

    try {
      // Fetch both SWAP and FUTURES tickers with strict 6.5s timeout
      const [swapData, futData] = await Promise.all([
        this.fetchJsonWithTimeout(`${this.okxBaseUrl}/api/v5/market/tickers?instType=SWAP`, 6500),
        this.fetchJsonWithTimeout(`${this.okxBaseUrl}/api/v5/market/tickers?instType=FUTURES`, 6500)
      ]);

      const responses = [];
      if (swapData) responses.push(swapData);
      if (futData) responses.push(futData);

      for (const res of responses) {
        if (res.code === '0' && Array.isArray(res.data)) {
          for (const item of res.data) {
            const symbol = item.instId;
            const lastPrice = parseFloat(item.last || '0');
            const volume24h = parseFloat(item.vol24h || '0');
            const volCcy24h = parseFloat(item.volCcy24h || '0');
            const open24h = parseFloat(item.open24h || '0');
            const priceChange24hPct = open24h > 0 ? ((lastPrice - open24h) / open24h) * 100 : 0;
            const highPrice24h = parseFloat(item.high24h || '0');
            const lowPrice24h = parseFloat(item.low24h || '0');
            const bidPx = parseFloat(item.bidPx || '0');
            const askPx = parseFloat(item.askPx || '0');
            const spreadPct = (bidPx > 0 && askPx > 0 && lastPrice > 0)
              ? parseFloat((((askPx - bidPx) / lastPrice) * 100).toFixed(4))
              : undefined;

            // Correct turnover calculation based on instType, ctType, and contract multiplier ctVal
            const meta = this.instrumentMetaMap.get(symbol);
            const ctVal = meta?.ctVal && meta.ctVal > 0 ? meta.ctVal : 1;
            const isXPerp = symbol.includes('_UM_XPERP') || item.instType === 'FUTURES';
            const ctType = meta?.ctType || 'linear';

            let turnover24hUSDT = 0;
            if (isXPerp) {
              if (volume24h > 0 && ctVal > 0 && lastPrice > 0) {
                turnover24hUSDT = volume24h * ctVal * lastPrice;
              } else if (volCcy24h > 0 && lastPrice > 0) {
                turnover24hUSDT = volCcy24h * lastPrice;
              }
            } else if (item.instType === 'SWAP') {
              if (ctType === 'inverse') {
                turnover24hUSDT = volume24h * ctVal;
              } else {
                if (volume24h > 0 && ctVal > 0 && lastPrice > 0) {
                  turnover24hUSDT = volume24h * ctVal * lastPrice;
                } else if (volCcy24h > 0 && lastPrice > 0) {
                  turnover24hUSDT = volCcy24h * lastPrice;
                } else {
                  turnover24hUSDT = volCcy24h;
                }
              }
            } else {
              turnover24hUSDT = volCcy24h > 0 ? volCcy24h : volume24h * lastPrice;
            }

            if (symbol && lastPrice > 0) {
              tickersMap[symbol] = {
                symbol,
                lastPrice,
                turnover24hUSDT,
                volume24h,
                priceChange24hPct,
                highPrice24h,
                lowPrice24h,
                bidPx: bidPx > 0 ? bidPx : undefined,
                askPx: askPx > 0 ? askPx : undefined,
                spreadPct,
              };
            }
          }
        }
      }
    } catch (err: any) {
      console.warn('[UniverseManager] OKX getTickers failed:', err?.message || err);
    }

    if (Object.keys(tickersMap).length > 0) {
      this.cachedTickersMap = tickersMap;
      return tickersMap;
    }

    return this.cachedTickersMap;
  }

  /**
   * Filters the dynamic universe by liquidity & spread and pre-scores all ~257 _UM_XPERP
   * contracts using real 24h market range consolidation, centering, amplitude, spread,
   * logarithmic liquidity, and single-lot margin feasibility (no artificial rotation,
   * no raw-volume monopoly that hides 95% of the universe).
   */
  public async getFilteredUniverse(
    filterConfig: UniverseFilterConfig = DEFAULT_UNIVERSE_FILTER,
    maxBudgetPerBotUSDT: number = 25,
    maxLeverage: number = 5
  ): Promise<FilteredUniverseResult> {
    // 1. Ensure universe is populated
    const universe = await this.refreshUniverse(filterConfig);

    // 2. Fetch all 24h tickers (always fresh from OKX EEA)
    const tickersMap = await this.fetch24hTickers();

    // 3. Filter symbols by liquidity & spread and compute market-driven Neutral Grid Pre-Score
    const eligibleWithScore: Array<{
      symbol: string;
      volume: number;
      preScore: number;
      budgetFeasible: boolean;
    }> = [];
    const preScoresMap: Record<string, number> = {};
    const excludedTokens = filterConfig.excludedSymbols || [];
    let excludedByVolume = 0;
    let excludedBySpread = 0;
    let budgetFeasibleCount = 0;

    for (const symbol of universe) {
      const ticker = tickersMap[symbol];
      if (!ticker || ticker.lastPrice <= 0) continue;

      // Exclusion filter: only if explicitly provided in filterConfig
      if (excludedTokens.length > 0) {
        const baseToken = symbol.split('-')[0].toUpperCase();
        if (excludedTokens.some((token) => token.toUpperCase().trim() === baseToken)) {
          continue;
        }
      }

      if (filterConfig.minPrice && ticker.lastPrice < filterConfig.minPrice) {
        continue;
      }

      // Volume threshold filter
      if (filterConfig.min24hVolumeUSDT && ticker.turnover24hUSDT < filterConfig.min24hVolumeUSDT) {
        excludedByVolume++;
        continue;
      }

      if (
        filterConfig.max24hVolumeUSDT &&
        filterConfig.max24hVolumeUSDT > 0 &&
        ticker.turnover24hUSDT > filterConfig.max24hVolumeUSDT
      ) {
        continue;
      }

      // Spread filter: evaluated for liquid tokens meeting volume criteria
      if (filterConfig.maxSpreadPct && filterConfig.maxSpreadPct > 0) {
        if (ticker.spreadPct !== undefined && ticker.spreadPct > filterConfig.maxSpreadPct) {
          excludedBySpread++;
          continue;
        }
      }

      // --- Market-Driven Neutral Grid Pre-Score across all liquid _UM_XPERP contracts ---
      const high24 = ticker.highPrice24h || ticker.lastPrice;
      const low24 = ticker.lowPrice24h || ticker.lastPrice;
      const range24hAbs = Math.max(0, high24 - low24);
      const range24hPct = ticker.lastPrice > 0 ? (range24hAbs / ticker.lastPrice) * 100 : 0;
      const absChange24hPct = Math.abs(ticker.priceChange24hPct || 0);

      // A. 24h Range Consolidation Efficiency (0..36 pts):
      // High when price oscillated inside a healthy 24h band with small net 24h directional drift
      const consolidationRatio =
        range24hPct > 0.25
          ? Math.max(0, Math.min(1, 1 - absChange24hPct / Math.max(0.5, range24hPct)))
          : 0.2;
      const consolidationPts = consolidationRatio * 36;

      // B. 24h Channel Centering (0..22 pts):
      // Highest when current price sits near the middle (30%..70%) of its 24h range rather than breaking out at high24/low24
      const posInRange =
        range24hAbs > 1e-9
          ? Math.max(0, Math.min(1, (ticker.lastPrice - low24) / range24hAbs))
          : 0.5;
      const distFromMid = Math.abs(posInRange - 0.5) * 2; // 0 at center, 1 at extreme edge
      const centeringPts = Math.max(0, (1 - Math.pow(distFromMid, 1.35)) * 22);

      // C. 24h Volatility Amplitude Sweet-Spot for Neutral Grid (0..22 pts):
      // Ideal 24h range is ~2.4%..8.2% (enough oscillation for 0.35%..0.42% grid steps without extreme pump/dump)
      let amplitudePts = 0;
      if (range24hPct >= 2.2 && range24hPct <= 8.2) {
        const distIdeal = Math.abs(range24hPct - 4.8) / 3.6;
        amplitudePts = 22 - Math.min(8, distIdeal * 7);
      } else if (range24hPct > 8.2 && range24hPct <= 14.0) {
        amplitudePts = Math.max(6, 15 - (range24hPct - 8.2) * 1.5);
      } else if (range24hPct >= 1.1 && range24hPct < 2.2) {
        amplitudePts = 6 + ((range24hPct - 1.1) / 1.1) * 8;
      } else {
        amplitudePts = 2;
      }

      // D. Live Spread & Logarithmic Liquidity (0..20 pts):
      // Using log10(volume) prevents $500M mega-caps from monopolizing top slots over $5M-$50M contracts with much better range
      const spreadVal = ticker.spreadPct ?? 0.04;
      const spreadPts = Math.max(0, Math.min(11, (1 - spreadVal / 0.1) * 11));
      const logVol = Math.log10(Math.max(100_000, ticker.turnover24hUSDT)); // 5.0 ($100k) .. 8.5 ($300M+)
      const liqPts = Math.max(1, Math.min(9, (logVol - 5.0) * 2.8));

      // E. Lot-Size Budget Feasibility Check (via cached instrument metadata):
      const meta = this.instrumentMetaMap.get(symbol);
      const minSz = meta?.minSz && meta.minSz > 0 ? meta.minSz : 1;
      const ctVal = meta?.ctVal && meta.ctVal > 0 ? meta.ctVal : 1;
      const minLotNotionalUSD = minSz * ctVal * ticker.lastPrice;
      // Minimum margin for 4 grids (at least 4 lots) at maxLeverage
      const estMinGridMarginUSD = (minLotNotionalUSD * 4) / Math.max(1, maxLeverage);
      const budgetFeasible = estMinGridMarginUSD <= maxBudgetPerBotUSDT * 1.15;
      if (budgetFeasible) {
        budgetFeasibleCount++;
      }

      let preScore =
        consolidationPts + centeringPts + amplitudePts + spreadPts + liqPts;
      if (!budgetFeasible) {
        // Deprioritize contracts whose minimum lot size exceeds the user's per-bot budget
        preScore -= 35;
      }
      preScore = parseFloat(Math.max(1, Math.min(99, preScore)).toFixed(2));
      preScoresMap[symbol] = preScore;

      eligibleWithScore.push({
        symbol,
        volume: ticker.turnover24hUSDT,
        preScore,
        budgetFeasible,
      });
    }

    // 4. Sort descending by market-driven Neutral Grid Pre-Score (tie-break by liquidity)
    eligibleWithScore.sort((a, b) => {
      if (Math.abs(b.preScore - a.preScore) > 0.15) {
        return b.preScore - a.preScore;
      }
      return b.volume - a.volume;
    });

    // 5. Cap at maxSymbols (default 500 covers the complete liquid universe without artificial truncation)
    const maxSymbolsLimit =
      filterConfig.maxSymbols && filterConfig.maxSymbols > 0 ? filterConfig.maxSymbols : 500;
    const capped = eligibleWithScore.slice(0, maxSymbolsLimit);
    const eligibleSymbols = capped.map((c) => c.symbol);

    const minVolStr =
      filterConfig.min24hVolumeUSDT >= 1e6
        ? `$${(filterConfig.min24hVolumeUSDT / 1e6).toFixed(1)}M`
        : `$${(filterConfig.min24hVolumeUSDT / 1e3).toFixed(0)}k`;
    const maxSpreadStr =
      filterConfig.maxSpreadPct && filterConfig.maxSpreadPct > 0
        ? `${filterConfig.maxSpreadPct.toFixed(2)}%`
        : 'OFF';

    this.logAuditFn?.(
      'UNIVERSE_FILTERED',
      `Universe filtered & pre-scored: ${eligibleSymbols.length} liquid candidates from ${universe.length} total _UM_XPERP (${budgetFeasibleCount} budget-feasible, Min Vol: ${minVolStr}, Max Spread: ${maxSpreadStr}).`,
      {
        totalUniverse: universe.length,
        eligibleCount: eligibleSymbols.length,
        budgetFeasibleCount,
        maxSymbols: maxSymbolsLimit,
        minVolumeUSDT: filterConfig.min24hVolumeUSDT,
        maxSpreadPct: filterConfig.maxSpreadPct || 0,
        excludedByVolume,
        excludedBySpread,
        topSymbols: eligibleSymbols.slice(0, 7),
      }
    );

    return {
      allSymbolsCount: universe.length,
      liquidSpreadFilteredCount: eligibleWithScore.length,
      budgetFeasibleCount,
      eligibleSymbols,
      tickersMap,
      preScoresMap,
    };
  }

  public getCachedUniverseCount(): number {
    return this.cachedUniverse.length;
  }

  public getLastRefreshTime(): number {
    return this.lastRefreshTime;
  }

  public getInstrumentMetadata(symbol: string): InstrumentMetadata | undefined {
    return this.instrumentMetaMap.get(symbol);
  }

  public getInstrumentLotFilter(symbol: string): InstrumentLotFilter | undefined {
    const meta = this.instrumentMetaMap.get(symbol);
    if (!meta) return undefined;
    return {
      symbol: meta.instId,
      minOrderQty: meta.minSz || 1,
      maxOrderQty: meta.maxMktSz || 1000000,
      qtyStep: meta.lotSz || 1,
      minNotionalValue: 5,
      tickSize: meta.tickSz || 0.01,
      ctVal: meta.ctVal || 1,
      ctValCcy: meta.ctValCcy || meta.settleCcy || 'USDT',
    };
  }
}
