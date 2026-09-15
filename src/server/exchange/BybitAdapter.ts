import { RestClientV5, WebsocketClient } from 'bybit-api';
import { Kline, BybitRawPosition, OrderStatus, OrderSide } from '../../shared/types';

export interface InstrumentLotFilter {
  symbol: string;
  minOrderQty: number;
  maxOrderQty: number;
  qtyStep: number;
  minNotionalValue: number;
  tickSize: number;
}

export interface ConnectionTestResult {
  reachable: boolean;
  authenticated: boolean;
  accountType?: 'UNIFIED' | 'CONTRACT';
  equity?: number;
  error?: string;
}

export class BybitAdapter {
  private apiKey: string;
  private apiSecret: string;
  private testnet: boolean;
  private restClient: RestClientV5;
  private wsClient?: WebsocketClient;
  private instrumentFilters: Map<string, InstrumentLotFilter> = new Map();
  private isWsConnected: boolean = false;

  // Callbacks for WebSocket events
  public onTickerUpdate?: (symbol: string, lastPrice: number) => void;
  public onOrderUpdate?: (order: any) => void;
  public onExecutionUpdate?: (execution: any) => void;
  public onPositionUpdate?: (position: any) => void;
  public onWalletUpdate?: (wallet: any) => void;
  public onConnectionChange?: (connected: boolean, message: string) => void;

  constructor(apiKey: string = '', apiSecret: string = '', testnet: boolean = true) {
    this.apiKey = apiKey.trim();
    this.apiSecret = apiSecret.trim();
    this.testnet = testnet;

    this.restClient = new RestClientV5({
      key: this.apiKey,
      secret: this.apiSecret,
      testnet: this.testnet,
      recv_window: 10000,
    });
  }

  public updateCredentials(apiKey: string, apiSecret: string, testnet: boolean = true) {
    this.apiKey = apiKey.trim();
    this.apiSecret = apiSecret.trim();
    this.testnet = testnet;

    this.restClient = new RestClientV5({
      key: this.apiKey,
      secret: this.apiSecret,
      testnet: this.testnet,
      recv_window: 10000,
    });

    if (this.wsClient) {
      try {
        this.wsClient.closeAll();
      } catch (err) {
        // ignore close error
      }
      this.wsClient = undefined;
    }

    this.initWebSocket();
  }

  public hasCredentials(): boolean {
    return Boolean(this.apiKey && this.apiSecret);
  }

  public isTestnet(): boolean {
    return this.testnet;
  }

  /**
   * Test connection to Bybit REST API.
   * Checks public endpoint reachability and private auth if keys are provided.
   */
  public async testConnection(): Promise<ConnectionTestResult> {
    try {
      // 1. Test public endpoint
      const publicRes = await this.restClient.getTickers({ category: 'linear', symbol: 'BTCUSDT' });
      if (publicRes.retCode !== 0) {
        return {
          reachable: false,
          authenticated: false,
          error: `Public API unreachable: ${publicRes.retMsg || 'Unknown error'}`,
        };
      }

      // If no credentials, we are reachable publicly but unauthenticated
      if (!this.hasCredentials()) {
        return {
          reachable: true,
          authenticated: false,
          error: 'API keys not provided',
        };
      }

      // 2. Test private endpoint with Unified Account first
      try {
        const unifiedRes = await this.restClient.getWalletBalance({ accountType: 'UNIFIED', coin: 'USDT' });
        if (unifiedRes.retCode === 0) {
          const coinData = unifiedRes.result.list?.[0]?.coin?.find((c: any) => c.coin === 'USDT');
          const eq = parseFloat(unifiedRes.result.list?.[0]?.totalEquity || coinData?.equity || '0');
          return {
            reachable: true,
            authenticated: true,
            accountType: 'UNIFIED',
            equity: eq,
          };
        }
      } catch (unifiedErr: any) {
        // Fall back to CONTRACT account check
      }

      const contractRes = await this.restClient.getWalletBalance({ accountType: 'CONTRACT', coin: 'USDT' });
      if (contractRes.retCode === 0 && contractRes.result.list?.length > 0) {
        const item: any = contractRes.result.list[0];
        const eq = parseFloat(item.equity || item.totalEquity || '0');
        return {
          reachable: true,
          authenticated: true,
          accountType: 'CONTRACT',
          equity: eq,
        };
      } else {
        return {
          reachable: true,
          authenticated: false,
          error: `Authentication failed: ${contractRes.retMsg || 'Invalid credentials'}`,
        };
      }
    } catch (err: any) {
      return {
        reachable: false,
        authenticated: false,
        error: err.message || 'Connection failed',
      };
    }
  }

  /**
   * Fetches current equity from Bybit account (UNIFIED or CONTRACT)
   */
  public async getEquity(): Promise<number> {
    if (!this.hasCredentials()) {
      return 0;
    }
    try {
      // Try UNIFIED account
      const resUnified = await this.restClient.getWalletBalance({ accountType: 'UNIFIED', coin: 'USDT' });
      if (resUnified.retCode === 0 && resUnified.result.list?.length > 0) {
        const item = resUnified.result.list[0];
        const coinData = item.coin?.find((c: any) => c.coin === 'USDT');
        const eq = parseFloat(item.totalEquity || coinData?.equity || coinData?.walletBalance || '0');
        if (!isNaN(eq) && eq > 0) return eq;
      }
    } catch {
      // ignore and try CONTRACT
    }

    try {
      const resContract = await this.restClient.getWalletBalance({ accountType: 'CONTRACT', coin: 'USDT' });
      if (resContract.retCode === 0 && resContract.result.list?.length > 0) {
        const item: any = resContract.result.list[0];
        const eq = parseFloat(item.equity || item.totalEquity || '0');
        if (!isNaN(eq)) return eq;
      }
    } catch (err) {
      console.error('[BybitAdapter] Failed to fetch wallet balance:', err);
    }

    return 0;
  }

  /**
   * Fetches klines for a given symbol and interval
   */
  public async getKlines(symbol: string, interval: string, limit: number = 200): Promise<Kline[]> {
    try {
      const res = await this.restClient.getKline({
        category: 'linear',
        symbol,
        interval: interval as any,
        limit,
      });

      if (res.retCode === 0 && Array.isArray(res.result.list)) {
        return res.result.list.map((k: any[]) => ({
          timestamp: parseInt(k[0]),
          open: parseFloat(k[1]),
          high: parseFloat(k[2]),
          low: parseFloat(k[3]),
          close: parseFloat(k[4]),
          volume: parseFloat(k[5]),
        })).reverse(); // Bybit returns newest first, reverse so oldest is index 0
      }
      return [];
    } catch (err) {
      console.error(`[BybitAdapter] Failed to fetch klines for ${symbol}:`, err);
      return [];
    }
  }

  /**
   * Fetches latest ticker price
   */
  public async getTickerPrice(symbol: string): Promise<number | null> {
    try {
      const res = await this.restClient.getTickers({ category: 'linear', symbol });
      if (res.retCode === 0 && res.result.list?.length > 0) {
        const lastPrice = parseFloat(res.result.list[0].lastPrice);
        return isNaN(lastPrice) ? null : lastPrice;
      }
      return null;
    } catch (err) {
      console.error(`[BybitAdapter] Failed to get ticker price for ${symbol}:`, err);
      return null;
    }
  }

  /**
   * Caches and returns instrument lot size & tick size filters
   */
  public async getInstrumentFilter(symbol: string): Promise<InstrumentLotFilter> {
    if (this.instrumentFilters.has(symbol)) {
      return this.instrumentFilters.get(symbol)!;
    }

    try {
      const res = await this.restClient.getInstrumentsInfo({ category: 'linear', symbol });
      if (res.retCode === 0 && res.result.list?.length > 0) {
        const info: any = res.result.list[0];
        const lot: any = info.lotSizeFilter || {};
        const priceFilter: any = info.priceFilter || {};

        const filter: InstrumentLotFilter = {
          symbol,
          minOrderQty: parseFloat(lot.minOrderQty || '0.001'),
          maxOrderQty: parseFloat(lot.maxOrderQty || '1000000'),
          qtyStep: parseFloat(lot.qtyStep || '0.001'),
          minNotionalValue: parseFloat(lot.minNotionalValue || '5'),
          tickSize: parseFloat(priceFilter.tickSize || '0.01'),
        };
        this.instrumentFilters.set(symbol, filter);
        return filter;
      }
    } catch (err) {
      console.error(`[BybitAdapter] Error fetching instrument info for ${symbol}:`, err);
    }

    // Safe fallback defaults for crypto linear contracts
    const fallback: InstrumentLotFilter = {
      symbol,
      minOrderQty: 0.001,
      maxOrderQty: 100000,
      qtyStep: 0.001,
      minNotionalValue: 5,
      tickSize: 0.01,
    };
    this.instrumentFilters.set(symbol, fallback);
    return fallback;
  }

  /**
   * Rounds quantity to the precision/step allowed by Bybit lot filter
   */
  public async formatQuantity(symbol: string, desiredQty: number, currentPrice: number): Promise<number> {
    const filter = await this.getInstrumentFilter(symbol);
    const step = filter.qtyStep;
    
    // Calculate precision decimals from step
    const stepStr = step.toString();
    const decimals = stepStr.includes('.') ? stepStr.split('.')[1].length : 0;

    let qty = Math.floor(desiredQty / step) * step;
    qty = parseFloat(qty.toFixed(decimals));

    // Ensure >= minOrderQty
    if (qty < filter.minOrderQty) {
      qty = filter.minOrderQty;
    }

    // Ensure notional value >= minNotionalValue
    if (currentPrice > 0 && qty * currentPrice < filter.minNotionalValue) {
      const minQtyForNotional = filter.minNotionalValue / currentPrice;
      qty = Math.ceil(minQtyForNotional / step) * step;
      qty = parseFloat(qty.toFixed(decimals));
    }

    return qty;
  }

  /**
   * Fetches real open positions from Bybit
   */
  public async getOpenPositions(settleCoin: string = 'USDT'): Promise<BybitRawPosition[]> {
    if (!this.hasCredentials()) {
      return [];
    }

    try {
      const res = await this.restClient.getPositionInfo({
        category: 'linear',
        settleCoin,
      });

      if (res.retCode === 0 && Array.isArray(res.result.list)) {
        return res.result.list
          .filter((p: any) => {
            const size = parseFloat(p.size || '0');
            return size > 0 && p.side !== 'None';
          })
          .map((p: any) => ({
            symbol: p.symbol,
            side: p.side === 'Buy' ? 'Buy' : 'Sell',
            size: parseFloat(p.size),
            avgPrice: parseFloat(p.avgPrice || p.entryPrice || '0'),
            unrealisedPnl: parseFloat(p.unrealisedPnl || '0'),
            markPrice: parseFloat(p.markPrice || '0'),
            leverage: p.leverage || '1',
            updatedTime: parseInt(p.updatedTime || Date.now().toString()),
          }));
      }
      return [];
    } catch (err: any) {
      console.error('[BybitAdapter] getOpenPositions error:', err.message || err);
      return [];
    }
  }

  /**
   * Places an order on Bybit Testnet
   */
  public async submitOrder(params: {
    symbol: string;
    side: 'Buy' | 'Sell';
    orderType: 'Market' | 'Limit';
    qty: number;
    price?: number;
    orderLinkId: string;
    reduceOnly?: boolean;
  }): Promise<{ orderId: string; orderLinkId: string }> {
    if (!this.hasCredentials()) {
      throw new Error('Cannot submit order: Bybit API keys not configured.');
    }

    try {
      const submitParams: any = {
        category: 'linear',
        symbol: params.symbol,
        side: params.side,
        orderType: params.orderType,
        qty: params.qty.toString(),
        orderLinkId: params.orderLinkId,
      };

      if (params.price && params.orderType === 'Limit') {
        submitParams.price = params.price.toString();
      }

      if (params.reduceOnly) {
        submitParams.reduceOnly = true;
      }

      const res = await this.restClient.submitOrder(submitParams);

      if (res.retCode !== 0) {
        throw new Error(`Bybit rejected order [${res.retCode}]: ${res.retMsg}`);
      }

      return {
        orderId: res.result.orderId,
        orderLinkId: res.result.orderLinkId || params.orderLinkId,
      };
    } catch (err: any) {
      console.error(`[BybitAdapter] Failed submitOrder for ${params.symbol}:`, err.message || err);
      throw err;
    }
  }

  /**
   * Query status of an order on Bybit
   */
  public async queryOrderStatus(symbol: string, orderLinkId: string, exchangeOrderId?: string): Promise<{
    status: OrderStatus;
    filledQty: number;
    avgPrice: number;
    cumFee: number;
    rawStatus: string;
  } | null> {
    if (!this.hasCredentials()) return null;

    try {
      // 1. Try active orders
      const activeRes = await this.restClient.getActiveOrders({
        category: 'linear',
        symbol,
        orderLinkId,
        orderId: exchangeOrderId,
      });

      let orderItem = activeRes.result?.list?.[0];

      // 2. If not active, check historic orders
      if (!orderItem) {
        const historicRes = await this.restClient.getHistoricOrders({
          category: 'linear',
          symbol,
          orderLinkId,
          orderId: exchangeOrderId,
        });
        orderItem = historicRes.result?.list?.[0];
      }

      if (!orderItem) {
        return null;
      }

      const rawStatus = orderItem.orderStatus;
      let status: OrderStatus = 'SUBMITTED';

      switch (rawStatus) {
        case 'Created':
        case 'New':
          status = 'ACCEPTED';
          break;
        case 'PartiallyFilled':
          status = 'PARTIALLY_FILLED';
          break;
        case 'Filled':
          status = 'FILLED';
          break;
        case 'Cancelled':
        case 'PartiallyFilledCanceled':
          status = 'CANCELLED';
          break;
        case 'Rejected':
          status = 'REJECTED';
          break;
        case 'Deactivated':
          status = 'FAILED';
          break;
        default:
          status = 'SUBMITTED';
      }

      return {
        status,
        filledQty: parseFloat(orderItem.cumExecQty || '0'),
        avgPrice: parseFloat(orderItem.avgPrice || '0'),
        cumFee: parseFloat(orderItem.cumExecFee || '0'),
        rawStatus,
      };
    } catch (err) {
      console.error(`[BybitAdapter] Failed to query order status for ${symbol}:`, err);
      return null;
    }
  }

  /**
   * Cancel an open order
   */
  public async cancelOrder(symbol: string, orderId?: string, orderLinkId?: string): Promise<boolean> {
    if (!this.hasCredentials()) return false;
    try {
      const res = await this.restClient.cancelOrder({
        category: 'linear',
        symbol,
        orderId,
        orderLinkId,
      });
      return res.retCode === 0;
    } catch (err) {
      console.error(`[BybitAdapter] Failed cancelOrder for ${symbol}:`, err);
      return false;
    }
  }

  /**
   * Initializes and maintains WebSocket connection
   */
  public initWebSocket(watchlist: string[] = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']) {
    if (this.wsClient) return;

    try {
      this.wsClient = new WebsocketClient({
        key: this.apiKey,
        secret: this.apiSecret,
        testnet: this.testnet,
        market: 'v5',
      });

      this.wsClient.on('open', ({ wsKey }: any) => {
        this.isWsConnected = true;
        this.onConnectionChange?.(true, `WebSocket opened: ${wsKey}`);
      });

      this.wsClient.on('close', ({ wsKey }: any) => {
        this.isWsConnected = false;
        this.onConnectionChange?.(false, `WebSocket closed: ${wsKey}`);
      });

      (this.wsClient as any).on('error', (err: any) => {
        console.warn('[BybitAdapter WS Error]', err?.message || err);
        this.onConnectionChange?.(false, `WebSocket error: ${err?.message || 'Connection error'}`);
      });

      this.wsClient.on('update', (data: any) => {
        const topic = data.topic || '';

        // Ticker updates: tickers.BTCUSDT
        if (topic.startsWith('tickers.')) {
          const symbol = topic.replace('tickers.', '');
          const lastPrice = parseFloat(data.data?.lastPrice);
          if (!isNaN(lastPrice) && this.onTickerUpdate) {
            this.onTickerUpdate(symbol, lastPrice);
          }
        }

        // Private updates
        if (topic === 'order' && this.onOrderUpdate) {
          const orders = Array.isArray(data.data) ? data.data : [data.data];
          orders.forEach((o: any) => this.onOrderUpdate?.(o));
        }

        if (topic === 'execution' && this.onExecutionUpdate) {
          const executions = Array.isArray(data.data) ? data.data : [data.data];
          executions.forEach((e: any) => this.onExecutionUpdate?.(e));
        }

        if (topic === 'position' && this.onPositionUpdate) {
          const positions = Array.isArray(data.data) ? data.data : [data.data];
          positions.forEach((p: any) => this.onPositionUpdate?.(p));
        }

        if (topic === 'wallet' && this.onWalletUpdate) {
          this.onWalletUpdate(data.data);
        }
      });

      // Subscribe to public tickers
      for (const symbol of watchlist) {
        this.wsClient.subscribeV5(`tickers.${symbol}`, 'linear');
      }

      // If credentials exist, subscribe to private streams
      if (this.hasCredentials()) {
        try {
          (this.wsClient as any).subscribeV5(['order', 'execution', 'position', 'wallet']);
        } catch (err) {
          console.warn('[BybitAdapter] Failed private WS subscription:', err);
        }
      }
    } catch (err) {
      console.error('[BybitAdapter] Error initializing WebSocket:', err);
    }
  }

  public subscribeSymbols(symbols: string[]) {
    if (!this.wsClient) return;
    for (const symbol of symbols) {
      try {
        this.wsClient.subscribeV5(`tickers.${symbol}`, 'linear');
      } catch (e) {
        // ignore duplicate
      }
    }
  }

  public isConnected(): boolean {
    return this.isWsConnected;
  }
}
