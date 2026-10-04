import { UniverseFilterConfig, AuditLogType } from '../../shared/types';

export interface InstrumentMetadata {
  instId: string;
  ctVal: number;
  ctValCcy: string;
  ctType: string;
  settleCcy: string;
  instType: string;
  instFamily: string;
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
  eligibleSymbols: string[];
  tickersMap: Record<string, MarketTickerInfo>;
}

export const DEFAULT_UNIVERSE_FILTER: UniverseFilterConfig = {
  min24hVolumeUSDT: 100_000, // $100k (0.1M) USDT/USD 24h turnover minimum
  max24hVolumeUSDT: 0,       // 0 = no upper limit by default
  minPrice: 0.0001,
  maxSymbols: 500,           // Permitem până la 500 de simboluri (acoperă întregul univers lichid)
  settleCoin: 'USDT',
  refreshIntervalMs: 15 * 60 * 1000, // 15 minutes
  maxSpreadPct: 0,           // 0 = dezactivat la nivel de univers (nu reduce artificial universul lichid)
  excludedSymbols: [],       // Universul reflectă lichiditatea; excluderile sunt gestionate de RiskEngine
};

export class UniverseManager {
  private okxBaseUrl: string = 'https://eea.okx.com';
  private cachedUniverse: string[] = [];
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
      // 1. Fetch FUTURES instruments (X-Perp)
      const futRes = await fetch(`${this.okxBaseUrl}/api/v5/public/instruments?instType=FUTURES`);
      
      console.log(`[UniverseManager] Fetching instruments... FUTURES ok: ${futRes.ok}`);

      const symbols: string[] = [];
      
      if (futRes.ok) {
        const data = await futRes.json();
        console.log(`[UniverseManager] Fetched ${data.data?.length || 0} FUTURES instruments`);
        if (data.code === '0' && Array.isArray(data.data)) {
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
              });
            }
          }
          const xPerps = data.data.filter((inst: any) => inst.state === 'live' && inst.instId.includes('_UM_XPERP'));
          console.log(`[UniverseManager] Found ${xPerps.length} X-Perp instruments`);
          symbols.push(...xPerps.map((i: any) => i.instId));
        }
      }

      // Also populate SWAP instruments metadata if available
      try {
        const swapRes = await fetch(`${this.okxBaseUrl}/api/v5/public/instruments?instType=SWAP`);
        if (swapRes.ok) {
          const swapData = await swapRes.json();
          if (swapData.code === '0' && Array.isArray(swapData.data)) {
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
                });
              }
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
      // Fetch both SWAP and FUTURES tickers
      const [swapRes, futRes] = await Promise.all([
        fetch(`${this.okxBaseUrl}/api/v5/market/tickers?instType=SWAP`),
        fetch(`${this.okxBaseUrl}/api/v5/market/tickers?instType=FUTURES`)
      ]);

      const responses = [];
      if (swapRes.ok) responses.push(await swapRes.json());
      if (futRes.ok) responses.push(await futRes.json());

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
              : 0;

            // Correct turnover calculation based on instType, ctType, and contract multiplier ctVal
            const meta = this.instrumentMetaMap.get(symbol);
            const ctVal = meta?.ctVal && meta.ctVal > 0 ? meta.ctVal : 1;
            const isXPerp = symbol.includes('_UM_XPERP') || item.instType === 'FUTURES';
            const ctType = meta?.ctType || 'linear';

            let turnover24hUSDT = 0;
            if (isXPerp) {
              // OKX X-Perps (FUTURES, settleCcy=USD, ctType=linear)
              // vol24h is number of contracts traded in 24h.
              // ctVal is base currency units per contract (e.g. BTC 0.0001, ETH 0.001, DOGE 10, XRP 1).
              // lastPrice is unit price in USD.
              // Turnover USD = vol24h * ctVal * lastPrice
              if (volume24h > 0 && ctVal > 0 && lastPrice > 0) {
                turnover24hUSDT = volume24h * ctVal * lastPrice;
              } else if (volCcy24h > 0 && lastPrice > 0) {
                // Fallback: volCcy24h is base currency volume (vol24h * ctVal)
                turnover24hUSDT = volCcy24h * lastPrice;
              }
            } else if (item.instType === 'SWAP') {
              if (ctType === 'inverse') {
                // Inverse contracts: ctVal is USD value per contract
                turnover24hUSDT = volume24h * ctVal;
              } else {
                // Linear USDT SWAP: vol24h * ctVal * lastPrice
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

    return tickersMap;
  }

  /**
   * Filters the dynamic universe strictly by liquidity turnover.
   */
  public async getFilteredUniverse(
    filterConfig: UniverseFilterConfig = DEFAULT_UNIVERSE_FILTER
  ): Promise<FilteredUniverseResult> {
    // 1. Ensure universe is populated
    const universe = await this.refreshUniverse(filterConfig);

    // 2. Fetch all 24h tickers
    const tickersMap = await this.fetch24hTickers();

    // 3. Filter symbols strictly by liquidity
    const eligibleWithVolume: Array<{ symbol: string; volume: number }> = [];
    const excludedTokens = filterConfig.excludedSymbols || [];
    let excludedByVolume = 0;
    let excludedBySpread = 0;

    for (const symbol of universe) {
      const ticker = tickersMap[symbol];
      if (!ticker) continue;

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

      if (filterConfig.max24hVolumeUSDT && filterConfig.max24hVolumeUSDT > 0 && ticker.turnover24hUSDT > filterConfig.max24hVolumeUSDT) {
        continue;
      }

      // Spread filter: evaluated for liquid tokens meeting volume criteria
      if (filterConfig.maxSpreadPct && filterConfig.maxSpreadPct > 0) {
        if (ticker.spreadPct !== undefined && ticker.spreadPct > filterConfig.maxSpreadPct) {
          excludedBySpread++;
          continue;
        }
      }

      eligibleWithVolume.push({
        symbol,
        volume: ticker.turnover24hUSDT,
      });
    }

    // 4. Sort descending by 24h turnover (highest liquidity first)
    eligibleWithVolume.sort((a, b) => b.volume - a.volume);

    // 5. Cap at maxSymbols (default 500 covers the complete liquid universe without artificial truncation)
    const maxSymbolsLimit = filterConfig.maxSymbols && filterConfig.maxSymbols > 0 ? filterConfig.maxSymbols : 500;
    const capped = eligibleWithVolume.slice(0, maxSymbolsLimit);
    const eligibleSymbols = capped.map((c) => c.symbol);

    const minVolStr = filterConfig.min24hVolumeUSDT >= 1e6
      ? `$${(filterConfig.min24hVolumeUSDT / 1e6).toFixed(1)}M`
      : `$${(filterConfig.min24hVolumeUSDT / 1e3).toFixed(0)}k`;
    const maxSpreadStr = filterConfig.maxSpreadPct && filterConfig.maxSpreadPct > 0
      ? `${filterConfig.maxSpreadPct.toFixed(2)}%`
      : 'OFF';

    this.logAuditFn?.(
      'UNIVERSE_FILTERED',
      `Universe filtered: ${eligibleSymbols.length} liquid candidates selected from ${universe.length} total (Min Vol: ${minVolStr}, Max Spread: ${maxSpreadStr}, Excluded by Volume: ${excludedByVolume}, Excluded by Spread: ${excludedBySpread}).`,
      {
        totalUniverse: universe.length,
        eligibleCount: eligibleSymbols.length,
        maxSymbols: maxSymbolsLimit,
        minVolumeUSDT: filterConfig.min24hVolumeUSDT,
        maxSpreadPct: filterConfig.maxSpreadPct || 0,
        excludedByVolume,
        excludedBySpread,
        topSymbols: eligibleSymbols.slice(0, 5),
      }
    );

    return {
      allSymbolsCount: universe.length,
      eligibleSymbols,
      tickersMap,
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
}
