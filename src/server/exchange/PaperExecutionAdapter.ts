import WebSocket from 'ws';
import { Kline, OKXRawPosition, OrderStatus, OrderSide } from '../../shared/types';
import { IExecutionAdapter, InstrumentLotFilter, ConnectionTestResult } from './IExecutionAdapter';
import { JsonStore } from '../store';

export interface PaperAccountState {
  balanceUSDT: number;
  positions: Record<string, OKXRawPosition>;
  realizedPnlTotal: number;
}

const DEFAULT_PAPER_STATE: PaperAccountState = {
  balanceUSDT: 200.0,
  positions: {},
  realizedPnlTotal: 0,
};

export class PaperExecutionAdapter implements IExecutionAdapter {
  private paperStore: JsonStore<PaperAccountState>;
  private wsClient?: WebSocket;
  private pingInterval?: NodeJS.Timeout;
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
  private subscribedSymbols: Set<string> = new Set();
  private okxBaseUrl = 'https://eea.okx.com';
  private wsBaseUrl = 'wss://wseea.okx.com:8443/ws/v5/public';

  public onTickerUpdate?: (symbol: string, lastPrice: number) => void;
  public onOrderUpdate?: (order: any) => void;
  public onExecutionUpdate?: (execution: any) => void;
  public onPositionUpdate?: (position: any) => void;
  public onWalletUpdate?: (wallet: any) => void;
  public onConnectionChange?: (connected: boolean, message: string) => void;

  constructor() {
    this.paperStore = new JsonStore<PaperAccountState>('paper_account.json', DEFAULT_PAPER_STATE);
  }

  public hasCredentials(): boolean {
    return true; // Paper trading doesn't require live API keys
  }

  public isTestnet(): boolean {
    return false; // Paper mode
  }

  public normalizeSymbol(symbol: string): string {
    if (!symbol) return '';
    const clean = symbol.trim().toUpperCase();
    if (clean.endsWith('-SWAP')) return clean;
    if (clean.includes('-')) return `${clean}-SWAP`;
    if (clean.endsWith('USDT')) {
      return `${clean.replace(/USDT$/, '')}-USDT-SWAP`;
    }
    return `${clean}-USDT-SWAP`;
  }

  public async testConnection(): Promise<ConnectionTestResult> {
    try {
      const res = await fetch(`${this.okxBaseUrl}/api/v5/market/ticker?instId=BTC-USDT-SWAP`);
      const data: any = await res.json();
      if (data.code !== '0') {
        return {
          reachable: false,
          authenticated: false,
          error: `Paper engine cannot reach OKX market data: ${data.msg || 'Unknown error'}`,
        };
      }
      const equity = await this.getEquity();
      return {
        reachable: true,
        authenticated: true,
        accountType: 'PAPER_OKX_SWAP',
        equity,
      };
    } catch (err: any) {
      return {
        reachable: false,
        authenticated: false,
        error: err.message || 'Failed to connect to OKX market data',
      };
    }
  }

  public async getEquity(): Promise<number> {
    const state = this.paperStore.get();
    let totalUnrealisedPnl = 0;

    for (const [symbol, pos] of Object.entries(state.positions)) {
      if (pos.size <= 0) continue;
      const currentPrice = this.latestPrices.get(symbol) || pos.avgPrice;
      const filter = this.instrumentFilters.get(this.normalizeSymbol(symbol));
      const ctVal = filter?.ctVal || 1;
      const isBuy = pos.side.toUpperCase() === 'BUY';
      const uPnl = isBuy
        ? (currentPrice - pos.avgPrice) * pos.size * ctVal
        : (pos.avgPrice - currentPrice) * pos.size * ctVal;
      pos.unrealisedPnl = parseFloat(uPnl.toFixed(4));
      pos.markPrice = currentPrice;
      totalUnrealisedPnl += uPnl;
    }

    return parseFloat((state.balanceUSDT + totalUnrealisedPnl).toFixed(2));
  }

  public async getKlines(symbol: string, interval: string, limit: number = 200): Promise<Kline[]> {
    const instId = this.normalizeSymbol(symbol);
    let bar = '15m';
    const norm = interval.replace('m', '').replace('M', '');
    if (norm === '1') bar = '1m';
    else if (norm === '3') bar = '3m';
    else if (norm === '5') bar = '5m';
    else if (norm === '15') bar = '15m';
    else if (norm === '30') bar = '30m';
    else if (norm === '60' || norm === '1H') bar = '1H';
    else if (norm === '120' || norm === '2H') bar = '2H';
    else if (norm === '240' || norm === '4H') bar = '4H';
    else if (norm === 'D' || norm === '1D') bar = '1D';

    try {
      const res = await fetch(`${this.okxBaseUrl}/api/v5/market/candles?instId=${instId}&bar=${bar}&limit=${limit}`);
      const data: any = await res.json();

      if (data.code === '0' && Array.isArray(data.data)) {
        const klines = data.data.map((k: any[]) => ({
          timestamp: parseInt(k[0]),
          open: parseFloat(k[1]),
          high: parseFloat(k[2]),
          low: parseFloat(k[3]),
          close: parseFloat(k[4]),
          volume: parseFloat(k[5]),
        })).reverse();

        if (klines.length > 0) {
          const lastClose = klines[klines.length - 1].close;
          this.latestPrices.set(instId, lastClose);
          this.latestPrices.set(symbol, lastClose);
        }
        return klines;
      }
      return [];
    } catch (err) {
      console.error(`[PaperAdapter] Failed to fetch klines for ${instId}:`, err);
      return [];
    }
  }

  public async getTickerPrice(symbol: string): Promise<number | null> {
    const instId = this.normalizeSymbol(symbol);
    try {
      const res = await fetch(`${this.okxBaseUrl}/api/v5/market/ticker?instId=${instId}`);
      const data: any = await res.json();
      if (data.code === '0' && data.data?.length > 0) {
        const price = parseFloat(data.data[0].last);
        if (!isNaN(price) && price > 0) {
          this.latestPrices.set(instId, price);
          this.latestPrices.set(symbol, price);
          return price;
        }
      }
    } catch (err) {
      console.error(`[PaperAdapter] Failed to get ticker price for ${instId}:`, err);
    }
    return this.latestPrices.get(instId) || this.latestPrices.get(symbol) || null;
  }

  public async getInstrumentFilter(symbol: string): Promise<InstrumentLotFilter> {
    const instId = this.normalizeSymbol(symbol);
    if (this.instrumentFilters.has(instId)) {
      return this.instrumentFilters.get(instId)!;
    }

    try {
      const res = await fetch(`${this.okxBaseUrl}/api/v5/public/instruments?instType=SWAP&instId=${instId}`);
      const data: any = await res.json();
      if (data.code === '0' && data.data?.length > 0) {
        const info = data.data[0];
        const filter: InstrumentLotFilter = {
          symbol: instId,
          minOrderQty: parseFloat(info.minSz || '1'),
          maxOrderQty: parseFloat(info.maxMktSz || '1000000'),
          qtyStep: parseFloat(info.lotSz || '1'),
          minNotionalValue: 5,
          tickSize: parseFloat(info.tickSz || '0.01'),
          ctVal: parseFloat(info.ctVal || '1'),
          ctValCcy: info.ctValCcy || 'USDT',
        };
        this.instrumentFilters.set(instId, filter);
        this.instrumentFilters.set(symbol, filter);
        return filter;
      }
    } catch (err) {
      console.error(`[PaperAdapter] Instrument info fetch error for ${instId}:`, err);
    }

    const fallback: InstrumentLotFilter = {
      symbol: instId,
      minOrderQty: 1,
      maxOrderQty: 100000,
      qtyStep: 1,
      minNotionalValue: 5,
      tickSize: 0.01,
      ctVal: 1,
      ctValCcy: 'USDT',
    };
    this.instrumentFilters.set(instId, fallback);
    return fallback;
  }

  public async formatQuantity(symbol: string, desiredQty: number, currentPrice: number): Promise<number> {
    const filter = await this.getInstrumentFilter(symbol);
    const step = filter.qtyStep;
    const ctVal = filter.ctVal || 1;

    let contracts = desiredQty;
    if (desiredQty < filter.minOrderQty && ctVal > 0 && ctVal < 1) {
      contracts = desiredQty / ctVal;
    }

    const stepStr = step.toString();
    const decimals = stepStr.includes('.') ? stepStr.split('.')[1].length : 0;

    let qty = Math.floor(contracts / step) * step;
    qty = parseFloat(qty.toFixed(decimals));

    if (qty < filter.minOrderQty) {
      qty = filter.minOrderQty;
    }

    const notional = currentPrice > 0 ? qty * ctVal * currentPrice : 0;
    if (currentPrice > 0 && notional < filter.minNotionalValue) {
      const minQtyForNotional = filter.minNotionalValue / (ctVal * currentPrice);
      qty = Math.ceil(minQtyForNotional / step) * step;
      qty = parseFloat(qty.toFixed(decimals));
    }

    return qty;
  }

  public async getOpenPositions(settleCoin: string = 'USDT'): Promise<OKXRawPosition[]> {
    const state = this.paperStore.get();
    const result: OKXRawPosition[] = [];

    for (const [symbol, pos] of Object.entries(state.positions)) {
      if (pos.size > 0 && pos.side !== 'None') {
        const mark = this.latestPrices.get(symbol) || pos.avgPrice;
        const filter = this.instrumentFilters.get(this.normalizeSymbol(symbol));
        const ctVal = filter?.ctVal || 1;
        const mult = pos.side === 'Buy' ? 1 : -1;
        const uPnl = (mark - pos.avgPrice) * pos.size * mult * ctVal;

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

  public async submitOrder(params: {
    symbol: string;
    side: 'Buy' | 'Sell';
    orderType: 'Market' | 'Limit';
    qty: number;
    price?: number;
    orderLinkId: string;
    reduceOnly?: boolean;
  }): Promise<{ orderId: string; orderLinkId: string }> {
    const instId = this.normalizeSymbol(params.symbol);
    const exchangeOrderId = `paper_ord_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    
    let fillPrice = params.price || this.latestPrices.get(instId) || this.latestPrices.get(params.symbol) || 0;
    if (fillPrice <= 0) {
      const livePrice = await this.getTickerPrice(instId);
      fillPrice = livePrice || (instId.includes('BTC') ? 65000 : instId.includes('ETH') ? 3500 : 150);
    }

    const filter = await this.getInstrumentFilter(instId);
    const ctVal = filter.ctVal || 1;
    const notionalValue = fillPrice * params.qty * ctVal;
    const fee = notionalValue * 0.0005; // 0.05% OKX standard taker fee

    const state = this.paperStore.get();

    if (params.reduceOnly) {
      const existing = state.positions[instId] || state.positions[params.symbol];
      const targetKey = state.positions[instId] ? instId : params.symbol;

      if (existing && existing.size > 0) {
        const closeQty = Math.min(params.qty, existing.size);
        const isBuy = existing.side.toUpperCase() === 'BUY';
        const realizedPnl = isBuy
          ? (fillPrice - existing.avgPrice) * closeQty * ctVal
          : (existing.avgPrice - fillPrice) * closeQty * ctVal;

        state.balanceUSDT = parseFloat((state.balanceUSDT + realizedPnl - fee).toFixed(4));
        state.realizedPnlTotal = parseFloat((state.realizedPnlTotal + realizedPnl).toFixed(4));

        existing.size = parseFloat((existing.size - closeQty).toFixed(4));
        if (existing.size <= 1e-6) {
          delete state.positions[targetKey];
        } else {
          existing.updatedTime = Date.now();
        }
      } else {
        state.balanceUSDT = parseFloat((state.balanceUSDT - fee).toFixed(4));
      }
    } else {
      state.balanceUSDT = parseFloat((state.balanceUSDT - fee).toFixed(4));
      const existing = state.positions[instId] || state.positions[params.symbol];
      const targetKey = instId;

      if (existing && existing.side === params.side) {
        const totalSize = existing.size + params.qty;
        const weightedAvgPrice = (existing.size * existing.avgPrice + params.qty * fillPrice) / totalSize;
        existing.size = parseFloat(totalSize.toFixed(4));
        existing.avgPrice = parseFloat(weightedAvgPrice.toFixed(4));
        existing.updatedTime = Date.now();
      } else {
        state.positions[targetKey] = {
          symbol: instId,
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

    const simOrder = {
      orderLinkId: params.orderLinkId,
      exchangeOrderId,
      symbol: instId,
      side: params.side,
      qty: params.qty,
      filledQty: params.qty,
      price: fillPrice,
      status: 'FILLED' as OrderStatus,
      cumFee: fee,
      updatedTime: Date.now(),
    };
    this.simulatedOrders.set(params.orderLinkId, simOrder);

    setTimeout(() => {
      this.onOrderUpdate?.({
        orderLinkId: params.orderLinkId,
        orderId: exchangeOrderId,
        orderStatus: 'Filled',
        symbol: instId,
        side: params.side,
        qty: params.qty.toString(),
        cumExecQty: params.qty.toString(),
        avgPrice: fillPrice.toString(),
        cumExecFee: fee.toString(),
      });

      this.onExecutionUpdate?.({
        symbol: instId,
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

  public initWebSocket(symbols: string[] = ['BTC-USDT-SWAP', 'ETH-USDT-SWAP', 'SOL-USDT-SWAP']): void {
    if (this.wsClient) return;

    try {
      this.wsClient = new WebSocket(this.wsBaseUrl);

      this.wsClient.on('open', () => {
        this.isWsConnected = true;
        this.onConnectionChange?.(true, 'OKX EEA Paper Market Data WebSocket connected');

        if (this.pingInterval) clearInterval(this.pingInterval);
        this.pingInterval = setInterval(() => {
          if (this.wsClient && this.wsClient.readyState === WebSocket.OPEN) {
            this.wsClient.send('ping');
          }
        }, 20000);

        this.subscribeSymbols(symbols);
      });

      this.wsClient.on('message', (data: WebSocket.Data) => {
        const text = data.toString();
        if (text === 'pong') return;
        try {
          const parsed = JSON.parse(text);
          if (parsed.arg?.channel === 'tickers' && Array.isArray(parsed.data)) {
            for (const item of parsed.data) {
              const instId = item.instId;
              const lastPrice = parseFloat(item.last);
              if (instId && !isNaN(lastPrice) && lastPrice > 0) {
                this.latestPrices.set(instId, lastPrice);
                this.onTickerUpdate?.(instId, lastPrice);
              }
            }
          }
        } catch {}
      });

      this.wsClient.on('close', () => {
        this.isWsConnected = false;
        this.onConnectionChange?.(false, 'OKX EEA Paper Market Data WebSocket disconnected');
      });

      this.wsClient.on('error', (err) => {
        console.warn('[PaperAdapter] WebSocket notice:', err.message || err);
      });
    } catch (err) {
      console.warn('[PaperAdapter] WebSocket initialization error:', err);
    }
  }

  public subscribeSymbols(symbols: string[]) {
    if (!this.wsClient || this.wsClient.readyState !== WebSocket.OPEN) {
      symbols.forEach((s) => this.subscribedSymbols.add(this.normalizeSymbol(s)));
      return;
    }

    const newArgs: any[] = [];
    for (const raw of symbols) {
      const instId = this.normalizeSymbol(raw);
      if (!this.subscribedSymbols.has(instId)) {
        this.subscribedSymbols.add(instId);
        newArgs.push({ channel: 'tickers', instId });
      }
    }

    if (newArgs.length > 0) {
      this.wsClient.send(
        JSON.stringify({
          op: 'subscribe',
          args: newArgs,
        })
      );
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
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = undefined;
    }
    if (this.wsClient) {
      try {
        this.wsClient.close();
      } catch (e) {}
      this.wsClient = undefined;
    }
    this.isWsConnected = false;
  }
}
