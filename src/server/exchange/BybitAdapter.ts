import { RestClientV5, WebsocketClient } from 'bybit-api';
import { Kline } from '../../shared/types';

export class BybitAdapter {
  private restClient: RestClientV5;
  private wsClient: WebsocketClient;
  private testnet: boolean;

  constructor(apiKey: string, apiSecret: string, testnet: boolean = true) {
    this.testnet = testnet;
    this.restClient = new RestClientV5({
      key: apiKey,
      secret: apiSecret,
      testnet: this.testnet,
    });
    
    this.wsClient = new WebsocketClient({
      key: apiKey,
      secret: apiSecret,
      testnet: this.testnet,
      market: 'linear',
    });
  }

  public async getEquity(): Promise<number> {
    try {
      const res = await this.restClient.getWalletBalance({ accountType: 'CONTRACT', coin: 'USDT' });
      if (res.retCode === 0 && res.result.list.length > 0) {
        return parseFloat(res.result.list[0].equity);
      }
      return 0;
    } catch (err) {
      console.error('Failed to fetch Bybit equity:', err);
      return 0;
    }
  }

  public async getKlines(symbol: string, interval: string, limit: number = 200): Promise<Kline[]> {
    try {
      const res = await this.restClient.getKline({
        category: 'linear',
        symbol,
        interval: interval as any,
        limit,
      });
      if (res.retCode === 0) {
        return res.result.list.map((k: any[]) => ({
          timestamp: parseInt(k[0]),
          open: parseFloat(k[1]),
          high: parseFloat(k[2]),
          low: parseFloat(k[3]),
          close: parseFloat(k[4]),
          volume: parseFloat(k[5]),
        })).reverse(); // Bybit returns newest first, reverse to oldest first
      }
      return [];
    } catch (err) {
      console.error(`Failed to fetch klines for ${symbol}:`, err);
      return [];
    }
  }

  public async placeMarketOrder(symbol: string, side: 'Buy' | 'Sell', qty: number) {
    try {
      const res = await this.restClient.submitOrder({
        category: 'linear',
        symbol,
        side,
        orderType: 'Market',
        qty: qty.toString(),
      });
      return res;
    } catch (err) {
      console.error(`Failed to place order for ${symbol}:`, err);
      throw err;
    }
  }
}
