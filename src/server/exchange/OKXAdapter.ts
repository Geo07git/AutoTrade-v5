import crypto from 'crypto';
import WebSocket from 'ws';
import { Kline, OKXRawPosition, OrderStatus, OrderSide } from '../../shared/types';
import { IExecutionAdapter, InstrumentLotFilter, ConnectionTestResult } from './IExecutionAdapter';

export class OKXAdapter implements IExecutionAdapter {
  private apiKey: string;
  private secretKey: string;
  private passphrase: string;
  private isDemo: boolean;
  private restBaseUrl: string = 'https://eea.okx.com';
  private wsBaseUrl: string = 'wss://wseea.okx.com:8443/ws/v5/public';
  private wsPrivateUrl: string = 'wss://wseea.okx.com:8443/ws/v5/private';

  private wsPublic?: WebSocket;
  private wsPrivate?: WebSocket;
  private pingInterval?: NodeJS.Timeout;
  private instrumentFilters: Map<string, InstrumentLotFilter> = new Map();
  private configuredLeverageSymbols: Set<string> = new Set();
  private isWsConnected: boolean = false;
  private subscribedSymbols: Set<string> = new Set();
  private leverage: string = '1';
  private marginMode: 'cross' | 'isolated' = 'cross';

  // Callbacks for WebSocket / Live events
  public onTickerUpdate?: (symbol: string, lastPrice: number) => void;
  public onOrderUpdate?: (order: any) => void;
  public onExecutionUpdate?: (execution: any) => void;
  public onPositionUpdate?: (position: any) => void;
  public onWalletUpdate?: (wallet: any) => void;
  public onConnectionChange?: (connected: boolean, message: string) => void;

  constructor(
    apiKey: string = '',
    secretKey: string = '',
    passphrase: string = '',
    isDemo: boolean = true
  ) {
    this.apiKey = apiKey.trim();
    this.secretKey = secretKey.trim();
    this.passphrase = passphrase.trim();
    this.isDemo = isDemo;
  }

  public updateCredentials(
    apiKey: string,
    secretKey: string,
    passphrase: string = '',
    isDemo: boolean = true
  ) {
    this.apiKey = apiKey.trim();
    this.secretKey = secretKey.trim();
    this.passphrase = passphrase.trim();
    this.isDemo = isDemo;
    this.configuredLeverageSymbols.clear();

    if (this.wsPrivate) {
      try {
        this.wsPrivate.close();
      } catch {}
      this.wsPrivate = undefined;
    }

    if (this.hasCredentials()) {
      this.initPrivateWebSocket();
    }
  }

  public hasCredentials(): boolean {
    return Boolean(this.apiKey && this.secretKey && this.passphrase);
  }

  public isTestnet(): boolean {
    return this.isDemo;
  }

  /**
   * Helper to normalize symbols to OKX standard perpetual SWAP format.
   * e.g. BTCUSDT -> BTC-USDT-SWAP, BTC-USDT-SWAP -> BTC-USDT-SWAP
   */
  public normalizeSymbol(symbol: string): string {
    if (!symbol) return '';
    const clean = symbol.trim().toUpperCase();
    if (clean.endsWith('-SWAP')) {
      return clean;
    }
    if (clean.includes('-')) {
      return `${clean}-SWAP`;
    }
    if (clean.endsWith('USDT')) {
      const base = clean.replace(/USDT$/, '');
      return `${base}-USDT-SWAP`;
    }
    return `${clean}-USDT-SWAP`;
  }

  /**
   * Generates HMAC-SHA256 signature for OKX v5 authentication
   */
  private generateSignature(timestamp: string, method: string, requestPath: string, bodyStr: string = ''): string {
    const prehash = timestamp + method.toUpperCase() + requestPath + bodyStr;
    return crypto.createHmac('sha256', this.secretKey).update(prehash).digest('base64');
  }

  /**
   * Performs an authenticated or public request to OKX EEA REST API
   */
  private async request(method: string, path: string, body?: any, isAuth: boolean = false): Promise<any> {
    const timestamp = new Date().toISOString();
    const bodyStr = body ? JSON.stringify(body) : '';
    const url = `${this.restBaseUrl}${path}`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };

    if (this.isDemo) {
      headers['x-simulated-trading'] = '1';
    }

    if (isAuth) {
      if (!this.hasCredentials()) {
        throw new Error('OKX API credentials (apiKey, secretKey, passphrase) are required.');
      }
      const sign = this.generateSignature(timestamp, method, path, bodyStr);
      headers['OK-ACCESS-KEY'] = this.apiKey;
      headers['OK-ACCESS-SIGN'] = sign;
      headers['OK-ACCESS-TIMESTAMP'] = timestamp;
      headers['OK-ACCESS-PASSPHRASE'] = this.passphrase;
    }

    const res = await fetch(url, {
      method,
      headers,
      body: body ? bodyStr : undefined,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OKX HTTP Error [${res.status}]: ${text}`);
    }

    const data: any = await res.json();
    if (data.code !== '0') {
      throw new Error(`OKX API Error [${data.code}]: ${data.msg || 'Unknown error'}`);
    }

    return data;
  }

  /**
   * Test connection to OKX REST API.
   * Checks public endpoint reachability and private auth if keys are provided.
   */
  public async testConnection(): Promise<ConnectionTestResult> {
    try {
      // 1. Test public endpoint
      const publicRes = await this.request('GET', '/api/v5/market/ticker?instId=BTC-USDT-SWAP', undefined, false);
      if (publicRes.code !== '0') {
        return {
          reachable: false,
          authenticated: false,
          error: `Public OKX API unreachable: ${publicRes.msg || 'Unknown error'}`,
        };
      }

      if (!this.hasCredentials()) {
        return {
          reachable: true,
          authenticated: false,
          error: 'OKX API keys not configured',
        };
      }

      // 2. Test private endpoint: balance
      const balanceRes = await this.request('GET', '/api/v5/account/balance?ccy=USDT', undefined, true);
      if (balanceRes.code === '0') {
        const balData = balanceRes.data?.[0];
        const eq = parseFloat(balData?.totalEq || balData?.details?.[0]?.eq || '0');
        return {
          reachable: true,
          authenticated: true,
          accountType: 'UNIFIED',
          equity: isNaN(eq) ? 0 : eq,
        };
      } else {
        return {
          reachable: true,
          authenticated: false,
          error: `Authentication failed: ${balanceRes.msg || 'Invalid OKX credentials'}`,
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
   * Fetches current equity from OKX account
   */
  public async getEquity(): Promise<number> {
    if (!this.hasCredentials()) {
      return 0;
    }
    try {
      const res = await this.request('GET', '/api/v5/account/balance', undefined, true);
      if (res.code === '0' && Array.isArray(res.data) && res.data.length > 0) {
        const totalEq = parseFloat(res.data[0].totalEq || '0');
        if (!isNaN(totalEq) && totalEq > 0) {
          return totalEq;
        }
        const usdtDetail = res.data[0].details?.find((d: any) => d.ccy === 'USDT');
        const eq = parseFloat(usdtDetail?.eq || usdtDetail?.cashBal || '0');
        if (!isNaN(eq)) return eq;
      }
    } catch (err: any) {
      console.error('[OKXAdapter] Failed to fetch wallet balance:', err?.message || err);
    }
    return 0;
  }

  /**
   * Fetches klines for a given symbol and interval
   */
  public async getKlines(symbol: string, interval: string, limit: number = 200): Promise<Kline[]> {
    const instId = this.normalizeSymbol(symbol);
    
    // Map interval formats (e.g. '1', '15', '60', '240') to OKX bar formats ('1m', '15m', '1H', '4H')
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
      const res = await this.request('GET', `/api/v5/market/candles?instId=${instId}&bar=${bar}&limit=${limit}`, undefined, false);
      if (res.code === '0' && Array.isArray(res.data)) {
        // OKX returns newest candles first; reverse so oldest is index 0
        return res.data
          .map((k: any[]) => ({
            timestamp: parseInt(k[0]),
            open: parseFloat(k[1]),
            high: parseFloat(k[2]),
            low: parseFloat(k[3]),
            close: parseFloat(k[4]),
            volume: parseFloat(k[5]), // volume in contracts
          }))
          .reverse();
      }
      return [];
    } catch (err: any) {
      console.error(`[OKXAdapter] Failed to fetch klines for ${instId}:`, err?.message || err);
      return [];
    }
  }

  /**
   * Fetches latest ticker price
   */
  public async getTickerPrice(symbol: string): Promise<number | null> {
    const instId = this.normalizeSymbol(symbol);
    try {
      const res = await this.request('GET', `/api/v5/market/ticker?instId=${instId}`, undefined, false);
      if (res.code === '0' && Array.isArray(res.data) && res.data.length > 0) {
        const last = parseFloat(res.data[0].last);
        return isNaN(last) ? null : last;
      }
      return null;
    } catch (err: any) {
      console.error(`[OKXAdapter] Failed to get ticker price for ${instId}:`, err?.message || err);
      return null;
    }
  }

  public setLeverageConfig(leverage: string | number, marginMode: 'cross' | 'isolated' = 'cross') {
    this.leverage = leverage.toString();
    this.marginMode = marginMode;
    this.configuredLeverageSymbols.clear();
  }

  public getLeverageConfig(): { leverage: string; marginMode: 'cross' | 'isolated' } {
    return { leverage: this.leverage, marginMode: this.marginMode };
  }

  /**
   * Fetches order book depth for an instrument
   */
  public async getOrderBook(symbol: string, depth: number = 20): Promise<{ bids: [number, number][]; asks: [number, number][] }> {
    const instId = this.normalizeSymbol(symbol);
    try {
      const res = await this.request('GET', `/api/v5/market/books?instId=${instId}&sz=${depth}`, undefined, false);
      if (res.code === '0' && Array.isArray(res.data) && res.data.length > 0) {
        const book = res.data[0];
        const bids: [number, number][] = (book.bids || []).map((b: string[]) => [parseFloat(b[0]), parseFloat(b[1])]);
        const asks: [number, number][] = (book.asks || []).map((a: string[]) => [parseFloat(a[0]), parseFloat(a[1])]);
        return { bids, asks };
      }
      return { bids: [], asks: [] };
    } catch (err: any) {
      console.error(`[OKXAdapter] Failed to get orderbook for ${instId}:`, err?.message || err);
      return { bids: [], asks: [] };
    }
  }

  /**
   * Caches and returns instrument lot size & tick size filters
   */
  public async getInstrumentFilter(symbol: string): Promise<InstrumentLotFilter> {
    const instId = this.normalizeSymbol(symbol);
    if (this.instrumentFilters.has(instId)) {
      return this.instrumentFilters.get(instId)!;
    }

    try {
      const res = await this.request('GET', `/api/v5/public/instruments?instType=SWAP&instId=${instId}`, undefined, false);
      if (res.code === '0' && Array.isArray(res.data) && res.data.length > 0) {
        const info = res.data[0];
        const minSz = parseFloat(info.minSz || '1');
        const lotSz = parseFloat(info.lotSz || '1');
        const tickSz = parseFloat(info.tickSz || '0.01');
        const ctVal = parseFloat(info.ctVal || '1');

        const filter: InstrumentLotFilter = {
          symbol: instId,
          minOrderQty: minSz,
          maxOrderQty: parseFloat(info.maxMktSz || '1000000'),
          qtyStep: lotSz,
          minNotionalValue: 5,
          tickSize: tickSz,
          ctVal,
          ctValCcy: info.ctValCcy || 'USDT',
        };

        this.instrumentFilters.set(instId, filter);
        return filter;
      }
    } catch (err: any) {
      console.error(`[OKXAdapter] Error fetching instrument info for ${instId}:`, err?.message || err);
    }

    // Safe fallback defaults for OKX SWAP contracts
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

  public getCachedCtVal(symbol: string): number {
    const instId = this.normalizeSymbol(symbol);
    const filter = this.instrumentFilters.get(instId) || this.instrumentFilters.get(symbol);
    return filter?.ctVal && filter.ctVal > 0 ? filter.ctVal : 1;
  }

  /**
   * Formats quantity in contracts adhering to OKX lot step & min size
   */
  public async formatQuantity(
    symbol: string,
    desiredQty: number,
    currentPrice: number,
    isAlreadyContracts: boolean = false
  ): Promise<number> {
    const filter = await this.getInstrumentFilter(symbol);
    const step = filter.qtyStep || 1;
    const ctVal = filter.ctVal && filter.ctVal > 0 ? filter.ctVal : 1;

    // In OKX SWAPs, order size 'sz' represents number of contracts.
    // desiredQty is initially expressed in base tokens (e.g. 250 DOGE or 0.05 BTC).
    // Convert base tokens to number of contracts: contracts = desiredQty / ctVal
    // If isAlreadyContracts is true (e.g. closing an existing position), desiredQty is already in contracts.
    const contracts = isAlreadyContracts ? desiredQty : desiredQty / ctVal;

    const stepStr = step.toString();
    const decimals = stepStr.includes('.') ? stepStr.split('.')[1].length : 0;

    let qty = Math.floor(contracts / step) * step;
    qty = parseFloat(qty.toFixed(decimals));

    if (qty < filter.minOrderQty) {
      qty = filter.minOrderQty;
    }

    // Ensure notional value >= minNotionalValue
    const notional = currentPrice > 0 ? qty * ctVal * currentPrice : 0;
    if (currentPrice > 0 && notional < filter.minNotionalValue) {
      const minQtyForNotional = filter.minNotionalValue / (ctVal * currentPrice);
      qty = Math.ceil(minQtyForNotional / step) * step;
      qty = parseFloat(qty.toFixed(decimals));
    }

    return qty;
  }

  /**
   * Fetches real open positions from OKX
   */
  public async getOpenPositions(settleCoin: string = 'USDT'): Promise<OKXRawPosition[]> {
    if (!this.hasCredentials()) {
      throw new Error('Cannot fetch OKX positions: OKX API credentials not configured.');
    }

    try {
      const res = await this.request('GET', '/api/v5/account/positions?instType=SWAP', undefined, true);
      if (res.code !== '0') {
        throw new Error(`OKX getPositions failed [${res.code}]: ${res.msg}`);
      }

      if (Array.isArray(res.data)) {
        return res.data
          .filter((p: any) => {
            const size = Math.abs(parseFloat(p.pos || '0'));
            const matchesSettle = !settleCoin || (p.ccy || '').toUpperCase() === settleCoin.toUpperCase();
            return size > 0 && matchesSettle;
          })
          .map((p: any) => {
            const rawSize = parseFloat(p.pos || '0');
            const posSide = p.posSide || 'net';
            const side: 'Buy' | 'Sell' = posSide === 'long' || rawSize > 0 ? 'Buy' : 'Sell';

            return {
              symbol: p.instId,
              side,
              size: Math.abs(rawSize),
              avgPrice: parseFloat(p.avgPx || '0'),
              unrealisedPnl: parseFloat(p.upl || '0'),
              markPrice: parseFloat(p.markPx || '0'),
              leverage: p.lever || '1',
              updatedTime: parseInt(p.uTime || Date.now().toString()),
            };
          });
      }
      return [];
    } catch (err: any) {
      console.error('[OKXAdapter] getOpenPositions error:', err?.message || err);
      throw new Error(`OKX getOpenPositions failed: ${err?.message || err}`);
    }
  }

  /**
   * Ensures leverage and margin mode on OKX (configurable, defaults to 1x cross margin mode)
   */
  public async ensureLeverage(symbol: string, leverage?: string, marginMode?: 'cross' | 'isolated'): Promise<boolean> {
    if (!this.hasCredentials()) return false;
    const instId = this.normalizeSymbol(symbol);
    const targetLeverage = (leverage || this.leverage).toString();
    const targetMarginMode = marginMode || this.marginMode;
    const configKey = `${instId}_${targetLeverage}_${targetMarginMode}`;

    if (this.configuredLeverageSymbols.has(configKey)) {
      return true;
    }

    try {
      const res = await this.request(
        'POST',
        '/api/v5/account/set-leverage',
        {
          instId,
          lever: targetLeverage,
          mgnMode: targetMarginMode,
        },
        true
      );

      if (res.code === '0') {
        this.configuredLeverageSymbols.add(configKey);
        return true;
      }
      return false;
    } catch (err: any) {
      // If already set or warning, cache to prevent repeat
      this.configuredLeverageSymbols.add(configKey);
      return true;
    }
  }

  /**
   * Places an order on OKX
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
      throw new Error('Cannot submit order: OKX API credentials not configured.');
    }

    const instId = this.normalizeSymbol(params.symbol);

    if (!params.reduceOnly) {
      await this.ensureLeverage(instId, this.leverage, this.marginMode);
    }

    try {
      // clOrdId in OKX must be max 32 characters alphanumeric
      const clOrdId = params.orderLinkId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 32);

      const submitBody: any = {
        instId,
        tdMode: this.marginMode,
        side: params.side.toLowerCase(), // 'buy' or 'sell'
        posSide: 'net', // unified / net account mode
        ordType: params.orderType.toLowerCase(), // 'market' or 'limit'
        sz: params.qty.toString(),
        clOrdId,
      };

      if (params.price && params.orderType === 'Limit') {
        submitBody.px = params.price.toString();
      }

      if (params.reduceOnly) {
        submitBody.reduceOnly = true;
      }

      const res = await this.request('POST', '/api/v5/trade/order', submitBody, true);

      if (res.code !== '0' || !res.data?.[0]) {
        throw new Error(`OKX rejected order [${res.code}]: ${res.msg || 'Order placement failed'}`);
      }

      const orderData = res.data[0];
      if (orderData.sCode && orderData.sCode !== '0') {
        throw new Error(`OKX order execution error [${orderData.sCode}]: ${orderData.sMsg}`);
      }

      return {
        orderId: orderData.ordId,
        orderLinkId: orderData.clOrdId || params.orderLinkId,
      };
    } catch (err: any) {
      console.error(`[OKXAdapter] Failed submitOrder for ${instId}:`, err?.message || err);
      throw err;
    }
  }

  /**
   * Query status of an order on OKX
   */
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
    if (!this.hasCredentials()) return null;
    const instId = this.normalizeSymbol(symbol);
    const clOrdId = orderLinkId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 32);

    try {
      let queryParam = exchangeOrderId ? `ordId=${exchangeOrderId}` : `clOrdId=${clOrdId}`;
      let res = await this.request('GET', `/api/v5/trade/order?instId=${instId}&${queryParam}`, undefined, true);

      let orderItem = res.data?.[0];

      // If not found in active orders, query history
      if (!orderItem) {
        res = await this.request('GET', `/api/v5/trade/orders-history?instType=SWAP&instId=${instId}&${queryParam}`, undefined, true);
        orderItem = res.data?.[0];
      }

      if (!orderItem) {
        return null;
      }

      const rawStatus = orderItem.state;
      let status: OrderStatus = 'SUBMITTED';

      switch (rawStatus) {
        case 'live':
          status = 'ACCEPTED';
          break;
        case 'partially_filled':
          status = 'PARTIALLY_FILLED';
          break;
        case 'filled':
          status = 'FILLED';
          break;
        case 'canceled':
          status = 'CANCELLED';
          break;
        default:
          status = 'SUBMITTED';
      }

      return {
        orderId: orderItem.ordId,
        status,
        filledQty: parseFloat(orderItem.accFillSz || '0'),
        avgPrice: parseFloat(orderItem.avgPx || '0'),
        cumFee: Math.abs(parseFloat(orderItem.fee || '0')),
        rawStatus,
      };
    } catch (err: any) {
      console.error(`[OKXAdapter] Failed to query order status for ${instId}:`, err?.message || err);
      return null;
    }
  }

  /**
   * Cancel an open order on OKX
   */
  public async cancelOrder(symbol: string, orderId?: string, orderLinkId?: string): Promise<boolean> {
    if (!this.hasCredentials()) return false;
    const instId = this.normalizeSymbol(symbol);
    const clOrdId = orderLinkId ? orderLinkId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 32) : undefined;

    try {
      const cancelBody: any = { instId };
      if (orderId) cancelBody.ordId = orderId;
      if (clOrdId) cancelBody.clOrdId = clOrdId;

      const res = await this.request('POST', '/api/v5/trade/cancel-order', cancelBody, true);
      return res.code === '0' && res.data?.[0]?.sCode === '0';
    } catch (err: any) {
      console.error(`[OKXAdapter] Failed cancelOrder for ${instId}:`, err?.message || err);
      return false;
    }
  }

  /**
   * Retrieves pending/open orders on OKX for reconciliation
   */
  public async getOpenOrders(symbol?: string): Promise<any[]> {
    if (!this.hasCredentials()) return [];
    try {
      const instType = 'SWAP';
      let endpoint = `/api/v5/trade/orders-pending?instType=${instType}`;
      if (symbol) {
        endpoint += `&instId=${this.normalizeSymbol(symbol)}`;
      }
      const res = await this.request('GET', endpoint, undefined, true);
      if (res.code === '0' && Array.isArray(res.data)) {
        return res.data;
      }
      return [];
    } catch (err: any) {
      console.error('[OKXAdapter] Failed getOpenOrders:', err?.message || err);
      return [];
    }
  }

  /**
   * Initializes and maintains WebSocket connection to OKX EEA
   */
  public initWebSocket(watchlist: string[] = ['BTC-USDT-SWAP', 'ETH-USDT-SWAP', 'SOL-USDT-SWAP']) {
    if (this.wsPublic) return;

    try {
      this.wsPublic = new WebSocket(this.wsBaseUrl);

      this.wsPublic.on('open', () => {
        this.isWsConnected = true;
        this.onConnectionChange?.(true, 'OKX EEA WebSocket connected');

        // Start ping heartbeat every 20s
        if (this.pingInterval) clearInterval(this.pingInterval);
        this.pingInterval = setInterval(() => {
          if (this.wsPublic && this.wsPublic.readyState === WebSocket.OPEN) {
            this.wsPublic.send('ping');
          }
        }, 20000);

        // Subscribe to initial watchlist
        this.subscribeSymbols(watchlist);
      });

      this.wsPublic.on('message', (data: WebSocket.Data) => {
        const text = data.toString();
        if (text === 'pong') return;

        try {
          const parsed = JSON.parse(text);
          if (parsed.arg?.channel === 'tickers' && Array.isArray(parsed.data)) {
            for (const item of parsed.data) {
              const instId = item.instId;
              const lastPrice = parseFloat(item.last);
              if (instId && !isNaN(lastPrice) && this.onTickerUpdate) {
                this.onTickerUpdate(instId, lastPrice);
              }
            }
          }
        } catch {}
      });

      this.wsPublic.on('close', () => {
        this.isWsConnected = false;
        this.onConnectionChange?.(false, 'OKX EEA WebSocket closed');
        // Auto-reconnect after 3s
        setTimeout(() => {
          if (!this.wsPublic || this.wsPublic.readyState === WebSocket.CLOSED) {
            this.wsPublic = undefined;
            this.initWebSocket(Array.from(this.subscribedSymbols));
          }
        }, 3000);
      });

      this.wsPublic.on('error', (err: any) => {
        console.warn('[OKXAdapter WS Error]:', err?.message || err);
        this.onConnectionChange?.(false, `OKX WebSocket error: ${err?.message || 'Error'}`);
      });

      if (this.hasCredentials()) {
        this.initPrivateWebSocket();
      }
    } catch (err: any) {
      console.error('[OKXAdapter] Error initializing WebSocket:', err?.message || err);
    }
  }

  private initPrivateWebSocket() {
    if (this.wsPrivate || !this.hasCredentials()) return;

    try {
      this.wsPrivate = new WebSocket(this.wsPrivateUrl);

      this.wsPrivate.on('open', () => {
        const timestamp = (Math.floor(Date.now() / 1000)).toString();
        const sign = crypto.createHmac('sha256', this.secretKey).update(timestamp + 'GET/users/self/verify').digest('base64');

        this.wsPrivate?.send(
          JSON.stringify({
            op: 'login',
            args: [
              {
                apiKey: this.apiKey,
                passphrase: this.passphrase,
                timestamp,
                sign,
              },
            ],
          })
        );
      });

      this.wsPrivate.on('message', (data: WebSocket.Data) => {
        const text = data.toString();
        if (text === 'pong') return;
        try {
          const parsed = JSON.parse(text);
          if (parsed.event === 'login' && parsed.code === '0') {
            // Subscribe to private channels
            this.wsPrivate?.send(
              JSON.stringify({
                op: 'subscribe',
                args: [
                  { channel: 'orders', instType: 'SWAP' },
                  { channel: 'positions', instType: 'SWAP' },
                  { channel: 'account' },
                ],
              })
            );
          }

          if (parsed.arg?.channel === 'orders' && this.onOrderUpdate) {
            parsed.data?.forEach((o: any) => this.onOrderUpdate?.(o));
          }
          if (parsed.arg?.channel === 'positions' && this.onPositionUpdate) {
            parsed.data?.forEach((p: any) => this.onPositionUpdate?.(p));
          }
          if (parsed.arg?.channel === 'account' && this.onWalletUpdate) {
            this.onWalletUpdate(parsed.data);
          }
        } catch {}
      });

      this.wsPrivate.on('error', () => {});
      this.wsPrivate.on('close', () => {
        this.wsPrivate = undefined;
      });
    } catch {}
  }

  public subscribeSymbols(symbols: string[]) {
    if (!this.wsPublic || this.wsPublic.readyState !== WebSocket.OPEN) {
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
      this.wsPublic.send(
        JSON.stringify({
          op: 'subscribe',
          args: newArgs,
        })
      );
    }
  }

  public isConnected(): boolean {
    return this.isWsConnected;
  }

  public close() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = undefined;
    }
    if (this.wsPublic) {
      try {
        this.wsPublic.close();
      } catch {}
      this.wsPublic = undefined;
    }
    if (this.wsPrivate) {
      try {
        this.wsPrivate.close();
      } catch {}
      this.wsPrivate = undefined;
    }
    this.isWsConnected = false;
  }
}
