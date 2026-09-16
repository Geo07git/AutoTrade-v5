import { RestClientV5, WebsocketClient } from 'bybit-api';
import { Kline, BybitRawPosition, OrderStatus, OrderSide } from '../../shared/types';
import { IExecutionAdapter } from './IExecutionAdapter';
import { InstrumentLotFilter, ConnectionTestResult } from './BybitAdapter';
import { JsonStore } from '../store';

export interface PaperAccountState {
  balanceUSDT: number;
  positions: Record<string, BybitRawPosition>;
  realizedPnlTotal: number;
}

const DEFAULT_PAPER_STATE: PaperAccountState = {
  balanceUSDT: 200.0,
  positions: {},
  realizedPnlTotal: 0,
};

export class PaperExecutionAdapter implements IExecutionAdapter {
  private paperStore: JsonStore<PaperAccountState>;
  private restClient: RestClientV5;
  private wsClient?: WebsocketClient;
  private instrumentFilters: Map<string, InstrumentLotFilter> = new Map();
  private simulatedOrders: Map<string, {
    orderLinkId: string;
    exchangeOrderId: string;
    symbol: string;
    side: 'Buy' | 'Sell';
    qty: number;
    filledQty: number;
    price: number;
    status: OrderStatus;
    cumFee: number;
    updatedTime: number;
  }> = new Map();

  private latestPrices: Map<string, number> = new Map();
  private isWsConnected: boolean = false;

  public onTickerUpdate?: (symbol: string, lastPrice: number) => void;
  public onOrderUpdate?: (order: any) => void;
  public onExecutionUpdate?: (execution: any) => void;
  public onPositionUpdate?: (position: any) => void;
  public onWalletUpdate?: (wallet: any) => void;
  public onConnectionChange?: (connected: boolean, message: string) => void;

  constructor() {
    this.paperStore = new JsonStore<PaperAccountState>('paper_account.json', DEFAULT_PAPER_STATE);
    // Public REST client to fetch real Bybit market prices without credentials
    this.restClient = new RestClientV5({
      testnet: true,
      recv_window: 10000,
    });
  }

  public hasCredentials(): boolean {
    return true; // Paper trading doesn't require Bybit API keys
  }

  public isTestnet(): boolean {
    return false; // This is PAPER mode
  }

  public async testConnection(): Promise<ConnectionTestResult> {
    try {
      const publicRes = await this.restClient.getTickers({ category: 'linear', symbol: 'BTCUSDT' });
      if (publicRes.retCode !== 0) {
        return {
          reachable: false,
          authenticated: false,
          error: `Paper engine cannot reach market data: ${publicRes.retMsg || 'Unknown error'}`,
        };
      }
      const equity = await this.getEquity();
      return {
        reachable: true,
        authenticated: true,
        accountType: 'CONTRACT',
        equity,
      };
    } catch (err: any) {
      return {
        reachable: false,
        authenticated: false,
        error: err.message || 'Failed to connect to market data',
      };
    }
  }

  public async getEquity(): Promise<number> {
    const state = this.paperStore.get();
    let totalUnrealisedPnl = 0;

    for (const [symbol, pos] of Object.entries(state.positions)) {
      if (pos.size <= 0) continue;
      const currentPrice = this.latestPrices.get(symbol) || pos.avgPrice;
      const mult = pos.side === 'Buy' ? 1 : -1;
      const uPnl = (currentPrice - pos.avgPrice) * pos.size * mult;
      pos.unrealisedPnl = parseFloat(uPnl.toFixed(4));
      pos.markPrice = currentPrice;
      totalUnrealisedPnl += uPnl;
    }

    return parseFloat((state.balanceUSDT + totalUnrealisedPnl).toFixed(2));
  }

  public async getKlines(symbol: string, interval: string, limit: number = 200): Promise<Kline[]> {
    try {
      const res = await this.restClient.getKline({
        category: 'linear',
        symbol,
        interval: interval as any,
        limit,
      });

      if (res.retCode === 0 && Array.isArray(res.result.list)) {
        const klines = res.result.list.map((k: any[]) => ({
          timestamp: parseInt(k[0]),
          open: parseFloat(k[1]),
          high: parseFloat(k[2]),
          low: parseFloat(k[3]),
          close: parseFloat(k[4]),
          volume: parseFloat(k[5]),
        })).reverse();

        if (klines.length > 0) {
          const lastClose = klines[klines.length - 1].close;
          this.latestPrices.set(symbol, lastClose);
        }
        return klines;
      }
      return [];
    } catch (err) {
      console.error(`[PaperAdapter] Failed to fetch klines for ${symbol}:`, err);
      return [];
    }
  }

  public async getTickerPrice(symbol: string): Promise<number | null> {
    try {
      const res = await this.restClient.getTickers({ category: 'linear', symbol });
      if (res.retCode === 0 && res.result.list?.length > 0) {
        const price = parseFloat(res.result.list[0].lastPrice);
        if (!isNaN(price) && price > 0) {
          this.latestPrices.set(symbol, price);
          return price;
        }
      }
    } catch (err) {
      console.error(`[PaperAdapter] Failed to get ticker price for ${symbol}:`, err);
    }
    return this.latestPrices.get(symbol) || null;
  }

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
      console.error(`[PaperAdapter] Instrument info fetch error for ${symbol}:`, err);
    }

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

  public async formatQuantity(symbol: string, desiredQty: number, currentPrice: number): Promise<number> {
    const filter = await this.getInstrumentFilter(symbol);
    const step = filter.qtyStep;
    const stepStr = step.toString();
    const decimals = stepStr.includes('.') ? stepStr.split('.')[1].length : 0;

    let qty = Math.floor(desiredQty / step) * step;
    qty = parseFloat(qty.toFixed(decimals));

    if (qty < filter.minOrderQty) {
      qty = filter.minOrderQty;
    }

    if (currentPrice > 0 && qty * currentPrice < filter.minNotionalValue) {
      const minQtyForNotional = filter.minNotionalValue / currentPrice;
      qty = Math.ceil(minQtyForNotional / step) * step;
      qty = parseFloat(qty.toFixed(decimals));
    }

    return qty;
  }

  /**
   * Returns current paper positions formatted identically to Bybit raw positions
   */
  public async getOpenPositions(settleCoin: string = 'USDT'): Promise<BybitRawPosition[]> {
    const state = this.paperStore.get();
    const result: BybitRawPosition[] = [];

    for (const [symbol, pos] of Object.entries(state.positions)) {
      if (pos.size > 0 && pos.side !== 'None') {
        const mark = this.latestPrices.get(symbol) || pos.avgPrice;
        const mult = pos.side === 'Buy' ? 1 : -1;
        const uPnl = (mark - pos.avgPrice) * pos.size * mult;

        result.push({
          symbol: pos.symbol,
          side: pos.side,
          size: pos.size,
          avgPrice: pos.avgPrice,
          unrealisedPnl: parseFloat(uPnl.toFixed(4)),
          markPrice: mark,
          leverage: '1',
          updatedTime: pos.updatedTime || Date.now(),
        });
      }
    }

    return result;
  }

  /**
   * Simulates order submission and immediate execution with taker fee
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
    const exchangeOrderId = `paper_ord_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    
    // Obtain fill price
    let fillPrice = params.price || this.latestPrices.get(params.symbol) || 0;
    if (fillPrice <= 0) {
      const livePrice = await this.getTickerPrice(params.symbol);
      fillPrice = livePrice || (params.symbol.startsWith('BTC') ? 65000 : params.symbol.startsWith('ETH') ? 3500 : 150);
    }

    // 0.055% taker fee simulation
    const notionalValue = fillPrice * params.qty;
    const fee = notionalValue * 0.00055;

    const state = this.paperStore.get();

    if (params.reduceOnly) {
      // Close / Reduce simulated position
      const existing = state.positions[params.symbol];
      if (existing && existing.size > 0) {
        const closeQty = Math.min(params.qty, existing.size);
        const mult = existing.side === 'Buy' ? 1 : -1;
        const realizedPnl = (fillPrice - existing.avgPrice) * closeQty * mult;

        state.balanceUSDT = parseFloat((state.balanceUSDT + realizedPnl - fee).toFixed(4));
        state.realizedPnlTotal = parseFloat((state.realizedPnlTotal + realizedPnl).toFixed(4));

        existing.size = parseFloat((existing.size - closeQty).toFixed(4));
        if (existing.size <= 1e-6) {
          delete state.positions[params.symbol];
        } else {
          existing.updatedTime = Date.now();
        }
      } else {
        // Position was not found, still deduct fee
        state.balanceUSDT = parseFloat((state.balanceUSDT - fee).toFixed(4));
      }
    } else {
      // Open / Increase simulated position
      state.balanceUSDT = parseFloat((state.balanceUSDT - fee).toFixed(4));
      const existing = state.positions[params.symbol];

      if (existing && existing.side === params.side) {
        const totalSize = existing.size + params.qty;
        const weightedAvgPrice = (existing.size * existing.avgPrice + params.qty * fillPrice) / totalSize;
        existing.size = parseFloat(totalSize.toFixed(4));
        existing.avgPrice = parseFloat(weightedAvgPrice.toFixed(4));
        existing.updatedTime = Date.now();
      } else {
        state.positions[params.symbol] = {
          symbol: params.symbol,
          side: params.side,
          size: params.qty,
          avgPrice: fillPrice,
          unrealisedPnl: 0,
          markPrice: fillPrice,
          leverage: '1',
          updatedTime: Date.now(),
        };
      }
    }

    this.paperStore.save(state);

    // Save simulated order record
    const simOrder = {
      orderLinkId: params.orderLinkId,
      exchangeOrderId,
      symbol: params.symbol,
      side: params.side,
      qty: params.qty,
      filledQty: params.qty,
      price: fillPrice,
      status: 'FILLED' as OrderStatus,
      cumFee: fee,
      updatedTime: Date.now(),
    };
    this.simulatedOrders.set(params.orderLinkId, simOrder);

    // Trigger simulated WS callbacks asynchronously to mirror exchange behavior
    setTimeout(() => {
      this.onOrderUpdate?.({
        orderLinkId: params.orderLinkId,
        orderId: exchangeOrderId,
        orderStatus: 'Filled',
        symbol: params.symbol,
        side: params.side,
        qty: params.qty.toString(),
        cumExecQty: params.qty.toString(),
        avgPrice: fillPrice.toString(),
        cumExecFee: fee.toString(),
      });

      this.onExecutionUpdate?.({
        symbol: params.symbol,
        execPrice: fillPrice,
        execQty: params.qty,
        orderLinkId: params.orderLinkId,
      });
    }, 50);

    return {
      orderId: exchangeOrderId,
      orderLinkId: params.orderLinkId,
    };
  }

  public async queryOrderStatus(
    symbol: string,
    orderLinkId: string,
    exchangeOrderId?: string
  ): Promise<{
    orderId?: string;
    status: OrderStatus;
    filledQty: number;
    avgPrice: number;
    cumFee: number;
    rawStatus: string;
  } | null> {
    const simOrder = this.simulatedOrders.get(orderLinkId);
    if (!simOrder) return null;

    return {
      orderId: simOrder.exchangeOrderId,
      status: simOrder.status,
      filledQty: simOrder.filledQty,
      avgPrice: simOrder.price,
      cumFee: simOrder.cumFee,
      rawStatus: 'Filled',
    };
  }

  public async cancelOrder(symbol: string, orderId?: string, orderLinkId?: string): Promise<boolean> {
    if (orderLinkId && this.simulatedOrders.has(orderLinkId)) {
      const ord = this.simulatedOrders.get(orderLinkId)!;
      ord.status = 'CANCELLED';
      return true;
    }
    return true;
  }

  public initWebSocket(symbols: string[] = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']): void {
    if (this.wsClient) return;

    try {
      this.wsClient = new WebsocketClient({
        market: 'v5',
        testnet: true,
      });

      (this.wsClient as any).on('update', (data: any) => {
        const topic = data.topic || '';
        if (topic.startsWith('tickers.')) {
          const tickerData = data.data;
          const symbol = tickerData?.symbol;
          const lastPrice = parseFloat(tickerData?.lastPrice || '0');
          if (symbol && !isNaN(lastPrice) && lastPrice > 0) {
            this.latestPrices.set(symbol, lastPrice);
            this.onTickerUpdate?.(symbol, lastPrice);
          }
        }
      });

      (this.wsClient as any).on('open', () => {
        this.isWsConnected = true;
        this.onConnectionChange?.(true, 'Paper Market Data WebSocket connected');
        for (const s of symbols) {
          try {
            this.wsClient?.subscribeV5(`tickers.${s}`, 'linear');
          } catch (e) {
            // ignore
          }
        }
      });

      (this.wsClient as any).on('close', () => {
        this.isWsConnected = false;
        this.onConnectionChange?.(false, 'Paper Market Data WebSocket disconnected');
      });
    } catch (err) {
      console.warn('[PaperAdapter] WebSocket initialization notice:', err);
    }
  }

  public resetAccount(initialBalance: number = 200.0) {
    const newState: PaperAccountState = {
      balanceUSDT: initialBalance,
      positions: {},
      realizedPnlTotal: 0,
    };
    this.paperStore.save(newState);
    this.simulatedOrders.clear();
  }

  public close(): void {
    if (this.wsClient) {
      try {
        this.wsClient.closeAll();
      } catch (e) {
        // ignore
      }
      this.wsClient = undefined;
    }
    this.isWsConnected = false;
  }
}
