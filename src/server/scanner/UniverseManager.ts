import { UniverseFilterConfig, AuditLogType } from '../../shared/types';
import { RestClientV5 } from 'bybit-api';

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
  maxSymbols: 30,             // Top 30 liquid candidates scanned per cycle
  settleCoin: 'USDT',
  refreshIntervalMs: 15 * 60 * 1000, // 15 minutes
};

export class UniverseManager {
  private restClient: RestClientV5;
  private cachedUniverse: string[] = [];
  private lastRefreshTime: number = 0;
  private logAuditFn?: (type: AuditLogType, message: string, details?: any) => void;

  constructor(
    logAudit?: (type: AuditLogType, message: string, details?: any) => void,
    restClient?: RestClientV5
  ) {
    this.logAuditFn = logAudit;
    this.restClient = restClient || new RestClientV5({ testnet: false });
  }

  public setAuditLogger(fn: (type: AuditLogType, message: string, details?: any) => void) {
    this.logAuditFn = fn;
  }

  /**
   * Fetches active USDT Linear Perpetual instruments from Bybit.
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
      // 1. Fetch linear instruments from Bybit public endpoint
      // Using RestClientV5 with linear category
      const res = await this.restClient.getInstrumentsInfo({
        category: 'linear',
        limit: 1000,
      });

      if (res.retCode === 0 && Array.isArray(res.result?.list)) {
        const linearPerps = res.result.list.filter((inst: any) => {
          const isTrading = inst.status === 'Trading';
          const isUsdtSettle = (inst.settleCoin || inst.quoteCoin) === (filterConfig.settleCoin || 'USDT');
          const isPerpetual = !inst.deliveryTime || inst.deliveryTime === '0' || inst.contractType === 'LinearPerpetual';
          return isTrading && isUsdtSettle && isPerpetual;
        });

        const symbols = linearPerps.map((i: any) => i.symbol);

        if (symbols.length > 0) {
          const previousCount = this.cachedUniverse.length;
          this.cachedUniverse = symbols;
          this.lastRefreshTime = now;

          this.logAuditFn?.(
            'UNIVERSE_REFRESH',
            `Dynamic Universe refreshed: ${symbols.length} active USDT Linear Perpetuals discovered from Bybit.`,
            { totalCount: symbols.length, previousCount }
          );

          return this.cachedUniverse;
        }
      }
    } catch (err: any) {
      console.warn('[UniverseManager] Bybit instruments query error, trying public HTTP fallback:', err?.message || err);
      // Fallback via direct fetch to public API
      try {
        const fallbackRes = await fetch('https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000');
        if (fallbackRes.ok) {
          const data: any = await fallbackRes.json();
          if (data.retCode === 0 && Array.isArray(data.result?.list)) {
            const symbols = data.result.list
              .filter((inst: any) => inst.status === 'Trading' && (inst.settleCoin || inst.quoteCoin) === 'USDT')
              .map((i: any) => i.symbol);
            if (symbols.length > 0) {
              this.cachedUniverse = symbols;
              this.lastRefreshTime = now;
              this.logAuditFn?.(
                'UNIVERSE_REFRESH',
                `Dynamic Universe refreshed via fallback: ${symbols.length} active USDT pairs.`,
                { totalCount: symbols.length }
              );
              return this.cachedUniverse;
            }
          }
        }
      } catch (fbErr) {
        console.error('[UniverseManager] Public HTTP fallback also failed:', fbErr);
      }
    }

    // If fetch failed but we have cached symbols, retain them
    if (this.cachedUniverse.length > 0) {
      return this.cachedUniverse;
    }

    // Safety fallback: standard high-liquidity crypto perps
    const standardUniverse = [
      'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT',
      'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'SUIUSDT',
      'NEARUSDT', 'APTUSDT', 'OPUSDT', 'ARBUSDT', 'RENDERUSDT',
      'FETUSDT', 'INJUSDT', 'TIAUSDT', 'SEIUSDT', 'PEPEUSDT'
    ];
    this.cachedUniverse = standardUniverse;
    this.lastRefreshTime = now;
    return this.cachedUniverse;
  }

  /**
   * Fetches 24h market tickers for all linear perps in a single batch call.
   */
  public async fetch24hTickers(): Promise<Record<string, MarketTickerInfo>> {
    const tickersMap: Record<string, MarketTickerInfo> = {};

    try {
      const res = await this.restClient.getTickers({ category: 'linear' });
      if (res.retCode === 0 && Array.isArray(res.result?.list)) {
        for (const item of res.result.list) {
          const symbol = item.symbol;
          const lastPrice = parseFloat(item.lastPrice || '0');
          const turnover24hUSDT = parseFloat(item.turnover24h || '0');
          const volume24h = parseFloat(item.volume24h || '0');
          const priceChange24hPct = parseFloat(item.price24hPcnt || '0') * 100;
          const highPrice24h = parseFloat(item.highPrice24h || '0');
          const lowPrice24h = parseFloat(item.lowPrice24h || '0');

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
    } catch (err: any) {
      console.warn('[UniverseManager] getTickers failed, trying fallback HTTP:', err?.message || err);
      try {
        const fbRes = await fetch('https://api.bybit.com/v5/market/tickers?category=linear');
        if (fbRes.ok) {
          const data: any = await fbRes.json();
          if (data.retCode === 0 && Array.isArray(data.result?.list)) {
            for (const item of data.result.list) {
              const symbol = item.symbol;
              const lastPrice = parseFloat(item.lastPrice || '0');
              const turnover24hUSDT = parseFloat(item.turnover24h || '0');
              const volume24h = parseFloat(item.volume24h || '0');
              const priceChange24hPct = parseFloat(item.price24hPcnt || '0') * 100;
              if (symbol && lastPrice > 0) {
                tickersMap[symbol] = {
                  symbol,
                  lastPrice,
                  turnover24hUSDT,
                  volume24h,
                  priceChange24hPct,
                  highPrice24h: parseFloat(item.highPrice24h || '0'),
                  lowPrice24h: parseFloat(item.lowPrice24h || '0'),
                };
              }
            }
            return tickersMap;
          }
        }
      } catch (fbErr) {
        console.error('[UniverseManager] Ticker fallback failed:', fbErr);
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
