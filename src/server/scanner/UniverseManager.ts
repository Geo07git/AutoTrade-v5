import { UniverseFilterConfig, AuditLogType } from '../../shared/types';

export interface MarketTickerInfo {
  symbol: string;
  lastPrice: number;
  turnover24hUSDT: number;
  volume24h: number;
  priceChange24hPct: number;
  highPrice24h: number;
  lowPrice24h: number;
}

export interface FilteredUniverseResult {
  allSymbolsCount: number;
  eligibleSymbols: string[];
  tickersMap: Record<string, MarketTickerInfo>;
}

export const DEFAULT_UNIVERSE_FILTER: UniverseFilterConfig = {
  min24hVolumeUSDT: 5_000_000, // 5M USDT 24h turnover minimum
  minPrice: 0.0001,
  maxSymbols: 500,             // Permitem până la 500 de simboluri
  settleCoin: 'USDT',
  refreshIntervalMs: 15 * 60 * 1000, // 15 minutes
};

export class UniverseManager {
  private okxBaseUrl: string = 'https://eea.okx.com';
  private cachedUniverse: string[] = [];
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
   * Fetches active USDT SWAP (Perpetual) instruments from OKX EEA.
   * Caches results and refreshes only when stale or forced.
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
      // Fetch SWAP instruments from OKX EEA public endpoint
      const res = await fetch(`${this.okxBaseUrl}/api/v5/public/instruments?instType=SWAP`);
      if (res.ok) {
        const data: any = await res.json();
        if (data.code === '0' && Array.isArray(data.data)) {
          const usdtSwaps = data.data.filter((inst: any) => {
            const isLive = inst.state === 'live';
            const isUsdtSettle = (inst.settleCcy || '').toUpperCase() === (filterConfig.settleCoin || 'USDT').toUpperCase();
            return isLive && isUsdtSettle;
          });

          const symbols = usdtSwaps.map((i: any) => i.instId);

          if (symbols.length > 0) {
            const previousCount = this.cachedUniverse.length;
            this.cachedUniverse = symbols;
            this.lastRefreshTime = now;

            this.logAuditFn?.(
              'UNIVERSE_REFRESH',
              `Dynamic Universe refreshed: ${symbols.length} active USDT SWAP Perpetuals discovered from OKX EEA.`,
              { totalCount: symbols.length, previousCount }
            );

            return this.cachedUniverse;
          }
        }
      }
    } catch (err: any) {
      console.warn('[UniverseManager] OKX EEA instruments query error, trying fallback:', err?.message || err);
      try {
        const fallbackRes = await fetch('https://www.okx.com/api/v5/public/instruments?instType=SWAP');
        if (fallbackRes.ok) {
          const data: any = await fallbackRes.json();
          if (data.code === '0' && Array.isArray(data.data)) {
            const symbols = data.data
              .filter((inst: any) => inst.state === 'live' && inst.settleCcy === 'USDT')
              .map((i: any) => i.instId);
            if (symbols.length > 0) {
              this.cachedUniverse = symbols;
              this.lastRefreshTime = now;
              this.logAuditFn?.(
                'UNIVERSE_REFRESH',
                `Dynamic Universe refreshed via fallback: ${symbols.length} active OKX USDT pairs.`,
                { totalCount: symbols.length }
              );
              return this.cachedUniverse;
            }
          }
        }
      } catch (fbErr) {
        console.error('[UniverseManager] Fallback instruments fetch failed:', fbErr);
      }
    }

    if (this.cachedUniverse.length > 0) {
      return this.cachedUniverse;
    }

    // Standard high-liquidity OKX SWAP perpetual universe
    const standardUniverse = [
      'BTC-USDT-SWAP', 'ETH-USDT-SWAP', 'SOL-USDT-SWAP', 'XRP-USDT-SWAP',
      'DOGE-USDT-SWAP', 'ADA-USDT-SWAP', 'AVAX-USDT-SWAP', 'LINK-USDT-SWAP',
      'SUI-USDT-SWAP', 'NEAR-USDT-SWAP', 'APT-USDT-SWAP', 'OP-USDT-SWAP',
      'ARB-USDT-SWAP', 'RENDER-USDT-SWAP', 'FET-USDT-SWAP', 'INJ-USDT-SWAP',
      'TIA-USDT-SWAP', 'SEI-USDT-SWAP', 'PEPE-USDT-SWAP'
    ];
    this.cachedUniverse = standardUniverse;
    this.lastRefreshTime = now;
    return this.cachedUniverse;
  }

  /**
   * Fetches 24h market tickers for all SWAP perpetuals from OKX EEA in a single call.
   */
  public async fetch24hTickers(): Promise<Record<string, MarketTickerInfo>> {
    const tickersMap: Record<string, MarketTickerInfo> = {};

    try {
      const res = await fetch(`${this.okxBaseUrl}/api/v5/market/tickers?instType=SWAP`);
      if (res.ok) {
        const data: any = await res.json();
        if (data.code === '0' && Array.isArray(data.data)) {
          for (const item of data.data) {
            const symbol = item.instId;
            const lastPrice = parseFloat(item.last || '0');
            // volCcy24h in OKX is 24h turnover in quote currency (USDT)
            const turnover24hUSDT = parseFloat(item.volCcy24h || '0');
            const volume24h = parseFloat(item.vol24h || '0');
            const open24h = parseFloat(item.open24h || '0');
            const priceChange24hPct = open24h > 0 ? ((lastPrice - open24h) / open24h) * 100 : 0;
            const highPrice24h = parseFloat(item.high24h || '0');
            const lowPrice24h = parseFloat(item.low24h || '0');

            if (symbol && lastPrice > 0) {
              tickersMap[symbol] = {
                symbol,
                lastPrice,
                turnover24hUSDT,
                volume24h,
                priceChange24hPct,
                highPrice24h,
                lowPrice24h,
              };
            }
          }
          return tickersMap;
        }
      }
    } catch (err: any) {
      console.warn('[UniverseManager] OKX getTickers failed, trying fallback:', err?.message || err);
      try {
        const fbRes = await fetch('https://www.okx.com/api/v5/market/tickers?instType=SWAP');
        if (fbRes.ok) {
          const data: any = await fbRes.json();
          if (data.code === '0' && Array.isArray(data.data)) {
            for (const item of data.data) {
              const symbol = item.instId;
              const lastPrice = parseFloat(item.last || '0');
              const turnover24hUSDT = parseFloat(item.volCcy24h || '0');
              const open24h = parseFloat(item.open24h || '0');
              const priceChange24hPct = open24h > 0 ? ((lastPrice - open24h) / open24h) * 100 : 0;
              if (symbol && lastPrice > 0) {
                tickersMap[symbol] = {
                  symbol,
                  lastPrice,
                  turnover24hUSDT,
                  volume24h: parseFloat(item.vol24h || '0'),
                  priceChange24hPct,
                  highPrice24h: parseFloat(item.high24h || '0'),
                  lowPrice24h: parseFloat(item.low24h || '0'),
                };
              }
            }
            return tickersMap;
          }
        }
      } catch (fbErr) {
        console.error('[UniverseManager] OKX Ticker fallback failed:', fbErr);
      }
    }

    return tickersMap;
  }

  /**
   * Filters the dynamic universe according to liquidity, price, and volume limits.
   */
  public async getFilteredUniverse(
    filterConfig: UniverseFilterConfig = DEFAULT_UNIVERSE_FILTER
  ): Promise<FilteredUniverseResult> {
    // 1. Ensure universe is populated
    const universe = await this.refreshUniverse(filterConfig);

    // 2. Fetch all 24h tickers
    const tickersMap = await this.fetch24hTickers();

    // 3. Filter symbols
    const eligibleWithVolume: Array<{ symbol: string; volume: number }> = [];

    for (const symbol of universe) {
      const ticker = tickersMap[symbol];
      if (!ticker) continue;

      if (ticker.lastPrice < filterConfig.minPrice) {
        continue;
      }

      if (ticker.turnover24hUSDT < filterConfig.min24hVolumeUSDT) {
        continue;
      }

      eligibleWithVolume.push({
        symbol,
        volume: ticker.turnover24hUSDT,
      });
    }

    // 4. Sort descending by 24h turnover (highest liquidity first)
    eligibleWithVolume.sort((a, b) => b.volume - a.volume);

    // 5. Cap at maxSymbols
    const capped = eligibleWithVolume.slice(0, filterConfig.maxSymbols);
    const eligibleSymbols = capped.map((c) => c.symbol);

    this.logAuditFn?.(
      'UNIVERSE_FILTERED',
      `Universe filtered: ${eligibleSymbols.length} liquid candidates selected from ${universe.length} total (Min 24h Volume: $${(filterConfig.min24hVolumeUSDT / 1e6).toFixed(1)}M USDT).`,
      {
        totalUniverse: universe.length,
        eligibleCount: eligibleSymbols.length,
        maxSymbols: filterConfig.maxSymbols,
        minVolumeUSDT: filterConfig.min24hVolumeUSDT,
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
}
