import crypto from 'crypto';
import WebSocket from 'ws';
import { Kline, OKXRawPosition, OrderStatus, OrderSide } from '../../shared/types';
import { IExecutionAdapter, InstrumentLotFilter, ConnectionTestResult } from './IExecutionAdapter';

export class OKXAdapter implements IExecutionAdapter {
  private apiKey: string;
  private secretKey: string;
  private passphrase: string;
  private isDemo: boolean;
  private region: 'EEA' | 'GLOBAL' | 'AUTO' = 'AUTO';
  private restBaseUrl: string = 'https://eea.okx.com';
  private wsBaseUrl: string = 'wss://wseea.okx.com:8443/ws/v5/public';
  private wsPrivateUrl: string = 'wss://wseea.okx.com:8443/ws/v5/private';

  private wsPublic?: WebSocket;
  private wsPrivate?: WebSocket;
  private pingInterval?: NodeJS.Timeout;
  private instrumentFilters: Map<string, InstrumentLotFilter> = new Map();
  private unlistedSymbols: Set<string> = new Set();
  private configuredLeverageSymbols: Set<string> = new Set();
  private isWsConnected: boolean = false;
  private subscribedSymbols: Set<string> = new Set();
  private leverage: string = '1';
  private marginMode: 'cross' | 'isolated' = 'cross';
  private credentialsPermanentlyFailed: boolean = false;

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
    isDemo: boolean = true,
    region: 'EEA' | 'GLOBAL' | 'AUTO' = 'AUTO'
  ) {
    this.apiKey = apiKey.trim();
    this.secretKey = secretKey.trim();
    this.passphrase = passphrase.trim();
    this.isDemo = isDemo;
    this.setRegion(region);
  }

  public setRegion(region: 'EEA' | 'GLOBAL' | 'AUTO') {
    this.region = region;
    if (region === 'GLOBAL') {
      this.restBaseUrl = 'https://www.okx.com';
      this.wsBaseUrl = 'wss://ws.okx.com:8443/ws/v5/public';
      this.wsPrivateUrl = 'wss://ws.okx.com:8443/ws/v5/private';
    } else {
      // Default to EEA for European users (Romania)
      this.restBaseUrl = 'https://eea.okx.com';
      this.wsBaseUrl = 'wss://wseea.okx.com:8443/ws/v5/public';
      this.wsPrivateUrl = 'wss://wseea.okx.com:8443/ws/v5/private';
    }
  }

  public getRegion(): 'EEA' | 'GLOBAL' | 'AUTO' {
    return this.region;
  }

  public getBaseUrl(): string {
    return this.restBaseUrl;
  }

  public updateCredentials(
    apiKey: string,
    secretKey: string,
    passphrase: string = '',
    isDemo: boolean = true,
    region: 'EEA' | 'GLOBAL' | 'AUTO' = 'AUTO'
  ) {
    this.apiKey = apiKey.trim();
    this.secretKey = secretKey.trim();
    this.passphrase = passphrase.trim();
    this.isDemo = isDemo;
    this.setRegion(region);
    this.credentialsPermanentlyFailed = false;
    this.unlistedSymbols.clear();
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

  public markCredentialsInvalid(): void {
    console.warn('[OKXAdapter] Warning: Received auth error from OKX. Retrying on next cycle.');
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
    if (clean.endsWith('-SWAP') || clean.includes('_UM_XPERP')) {
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
   * Performs an authenticated or public request to OKX REST API with auto-fallback between EEA and Global
   */
  private async request(method: string, path: string, body?: any, isAuth: boolean = false, signal?: AbortSignal, retryOtherDomain: boolean = true): Promise<any> {
    const timestamp = new Date().toISOString();
    const bodyStr = body ? JSON.stringify(body) : '';
    const url = `${this.restBaseUrl}${path}`;

    const headers: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
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
      signal: signal || AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`[OKXAdapter] Market data request FAILED: ${url} | Status: ${res.status} | Body: ${text}`);
      
      // If code is 50119 (API key doesn't exist on this domain), automatically try other domain (EEA <-> Global)
      if (isAuth && retryOtherDomain && (text.includes('50119') || text.includes("doesn't exist"))) {
        const altUrl = this.restBaseUrl.includes('eea') ? 'https://www.okx.com' : 'https://eea.okx.com';
        console.warn(`[OKXAdapter] Received 50119 on ${this.restBaseUrl}, auto-retrying on ${altUrl}...`);
        const originalBase = this.restBaseUrl;
        this.restBaseUrl = altUrl;
        try {
          const altRes = await this.request(method, path, body, isAuth, signal, false);
          // If alt succeeded, persist this domain
          if (altUrl.includes('eea')) {
            this.setRegion('EEA');
          } else {
            this.setRegion('GLOBAL');
          }
          return altRes;
        } catch {
          this.restBaseUrl = originalBase; // revert if alt also failed
        }
      }
      let parsedCode = '';
      let parsedMsg = text;
      try {
        const parsed = JSON.parse(text);
        if (parsed.code) parsedCode = parsed.code;
        if (parsed.msg) parsedMsg = parsed.msg;
      } catch {}

      if (parsedCode === '50110' || text.includes('50110') || text.includes('whitelist') || text.includes('IP')) {
        throw new Error(`OKX IP Whitelist Error [50110]: IP-ul serverului nu este inclus în Whitelist-ul cheii API pe OKX. Adaugă IP-ul curent în setările API pe OKX.`);
      }
      if (parsedCode === '50124' || text.includes('50124') || text.includes('trading permission')) {
        throw new Error(`OKX HTTP Error [401] (Cod 50124): Cheia ta API nu are permisiunea 'Trade' (Tranzacționare) activată pe această piață! Mergi în OKX -> Profil -> API Keys -> Editează cheia și bifează 'Trade' (Tranzacționare), și verifică activarea modului de contracte SWAP în OKX Settings.`);
      }

      throw new Error(`OKX HTTP Error [${res.status}]: ${text}`);
    }

    const data: any = await res.json();
    console.log(`[OKXAdapter] DEBUG request success: ${url} | Code: ${data.code} | Data length: ${Array.isArray(data.data) ? data.data.length : 'N/A'}`);
    
    if (data.code !== '0') {
      if (data.code === '50110' || data.msg?.includes('whitelist') || data.msg?.includes('IP')) {
        throw new Error(`OKX IP Whitelist Error [50110]: IP-ul serverului nu este inclus în Whitelist-ul cheii API pe OKX. Adaugă IP-ul curent în setările API pe OKX.`);
      }
      if (data.code === '50124' || data.msg?.includes('trading permission')) {
        throw new Error(`OKX API Error [50124]: Cheia ta API nu are permisiunea 'Trade' (Tranzacționare) activată pe această piață! Mergi în OKX -> Profil -> API Keys -> Editează cheia și bifează 'Trade' (Tranzacționare), și verifică activarea modului de contracte SWAP în OKX Settings.`);
      }
      throw new Error(`OKX API Error [${data.code}]: ${data.msg || 'Unknown error'}`);
    }

    return data;
  }

  /**
   * Helper to fetch server public IP for diagnostic messages
   */
  private async getPublicServerIp(): Promise<string> {
    try {
      const res = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(2500) });
      if (res.ok) {
        const json: any = await res.json();
        return json.ip || 'Necunoscut';
      }
    } catch {}
    return 'Nedetectat';
  }

  /**
   * Test connection to OKX REST API.
   * Checks public endpoint reachability and private auth if keys are provided.
   * Intelligently diagnoses EEA vs Global, IP Whitelisting, and Simulated Trading header mismatches.
   */
  public async testConnection(): Promise<ConnectionTestResult> {
    const serverIp = await this.getPublicServerIp();

    // 1. Independent Public Reachability Ping
    let isReachable = false;
    let pingEndpoint = this.restBaseUrl;
    try {
      const pingRes = await fetch(`${this.restBaseUrl}/api/v5/market/ticker?instId=BTC-USDT-SWAP`, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      if (pingRes.ok) {
        isReachable = true;
      }
    } catch {}

    // Fallback ping if primary domain failed
    if (!isReachable) {
      const altPingUrl = this.restBaseUrl.includes('eea') ? 'https://www.okx.com' : 'https://eea.okx.com';
      try {
        const altPingRes = await fetch(`${altPingUrl}/api/v5/market/ticker?instId=BTC-USDT-SWAP`, {
          method: 'GET',
          headers: { 'Accept': 'application/json' },
          signal: AbortSignal.timeout(5000),
        });
        if (altPingRes.ok) {
          isReachable = true;
          pingEndpoint = altPingUrl;
        }
      } catch {}
    }

    if (!isReachable) {
      return {
        reachable: false,
        authenticated: false,
        serverIp,
        endpoint: pingEndpoint,
        error: `Serverul nu poate accesa bursa OKX (timeout sau blocaj de rețea/firewall pe ${pingEndpoint}). Verifică conexiunea de internet și setările firewall ale serverului OCI.`,
      };
    }

    if (!this.hasCredentials()) {
      return {
        reachable: true,
        authenticated: false,
        serverIp,
        endpoint: pingEndpoint,
        error: 'Cheile API OKX nu sunt configurate pe server (lipsesc API Key, Secret sau Passphrase).',
      };
    }

    // Check if key is masked
    if (this.apiKey.includes('...') || this.apiKey.includes('***') || this.secretKey.includes('***')) {
      return {
        reachable: true,
        authenticated: false,
        serverIp,
        endpoint: pingEndpoint,
        error: '⚠️ Cheia API sau Secretul conțin mască (ex: "..."). Te rugăm să introduci cheia completă generată pe OKX.',
      };
    }

    // 2. Multi-matrix Private Endpoint Auth Test
    const testOnce = async (baseUrl: string, useDemoHeader: boolean) => {
      const timestamp = new Date().toISOString();
      const path = '/api/v5/account/balance?ccy=USDT';
      const sign = this.generateSignature(timestamp, 'GET', path, '');
      const headers: Record<string, string> = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'OK-ACCESS-KEY': this.apiKey,
        'OK-ACCESS-SIGN': sign,
        'OK-ACCESS-TIMESTAMP': timestamp,
        'OK-ACCESS-PASSPHRASE': this.passphrase,
      };
      if (useDemoHeader) {
        headers['x-simulated-trading'] = '1';
      }
      try {
        const res = await fetch(`${baseUrl}${path}`, {
          method: 'GET',
          headers,
          signal: AbortSignal.timeout(7000),
        });
        const text = await res.text();
        let json: any = null;
        try { json = JSON.parse(text); } catch {}
        return { status: res.status, text, json, baseUrl, useDemoHeader };
      } catch (err: any) {
        return { status: 0, text: err.message || 'Fetch failed', json: null, baseUrl, useDemoHeader };
      }
    };

    const primaryUrl = this.restBaseUrl;
    const secondaryUrl = primaryUrl.includes('eea') ? 'https://www.okx.com' : 'https://eea.okx.com';

    // Matrix Attempt 1: Primary domain + requested demo mode
    let attempt = await testOnce(primaryUrl, this.isDemo);

    // Matrix Attempt 2: If failed with 50111 or 50119, try Secondary domain with requested demo mode
    if (attempt.status !== 200 && (attempt.text.includes('50111') || attempt.text.includes('50119'))) {
      const altAttempt = await testOnce(secondaryUrl, this.isDemo);
      if (altAttempt.status === 200 && altAttempt.json?.code === '0') {
        attempt = altAttempt;
        this.setRegion(secondaryUrl.includes('eea') ? 'EEA' : 'GLOBAL');
      }
    }

    // Matrix Attempt 3: If still failed with 50111, test both domains with OPPOSITE demo mode (mode mismatch detection)
    if (attempt.status !== 200 && attempt.text.includes('50111')) {
      const oppositeDemo = !this.isDemo;
      const oppAttempt1 = await testOnce(primaryUrl, oppositeDemo);
      const oppAttempt2 = (oppAttempt1.status !== 200) ? await testOnce(secondaryUrl, oppositeDemo) : oppAttempt1;
      const oppWinning = oppAttempt1.status === 200 ? oppAttempt1 : oppAttempt2;

      if (oppWinning.status === 200 && oppWinning.json?.code === '0') {
        const detectedMode = oppositeDemo ? 'OKX TESTNET (DEMO SIMULAT)' : 'OKX LIVE (CONT REAL)';
        const currentModeName = this.isDemo ? 'DEMO' : 'LIVE';
        return {
          reachable: true,
          authenticated: false,
          serverIp,
          region: oppWinning.baseUrl.includes('eea') ? 'EEA' : 'GLOBAL',
          endpoint: oppWinning.baseUrl,
          error: `⚠️ NEPOTRIVIRE MOD DETECTATĂ: Cheile introduse sunt VALIDE pentru [${detectedMode}], dar în interfață ai activ modul [${currentModeName}]. Te rugăm să comuți pe modul ${detectedMode} (sau ${this.isDemo ? 'debifează' : 'bifează'} Mod Testnet Demo) și conexiunea va fi imediat aprobată!`,
        };
      }
    }

    // Matrix Succeeded
    if (attempt.status === 200 && attempt.json?.code === '0') {
      const balData = attempt.json.data?.[0];
      const eq = parseFloat(balData?.totalEq || balData?.details?.[0]?.eq || '0');
      const activeReg = attempt.baseUrl.includes('eea') ? 'EEA (Europa/România)' : 'GLOBAL';
      return {
        reachable: true,
        authenticated: true,
        accountType: 'UNIFIED',
        equity: isNaN(eq) ? 0 : eq,
        region: activeReg,
        endpoint: attempt.baseUrl,
        serverIp,
      };
    }

    // Diagnostics for failed attempts
    const errText = attempt.text || '';
    const activeReg = attempt.baseUrl.includes('eea') ? 'EEA (https://eea.okx.com)' : 'GLOBAL (https://www.okx.com)';

    if (errText.includes('50110') || errText.includes('whitelist') || errText.includes('IP')) {
      return {
        reachable: true,
        authenticated: false,
        serverIp,
        region: activeReg,
        endpoint: attempt.baseUrl,
        error: `⚠️ EROARE IP WHITELIST [50110]: IP-ul serverului tău OCI (${serverIp}) nu este inclus în Whitelist-ul cheii API pe OKX.\n👉 Soluție: Intră pe site-ul OKX la Profil -> API Management -> Editează Cheia API -> Adaugă IP-ul: ${serverIp} (sau selectează opțiunea 'Fără restricție IP').`,
      };
    }

    if (errText.includes('50111')) {
      return {
        reachable: true,
        authenticated: false,
        serverIp,
        region: activeReg,
        endpoint: attempt.baseUrl,
        error: `⚠️ CHEIE INVALIDĂ [50111]: OKX a refuzat cheia API (Invalid OK-ACCESS-KEY).\n👉 Cauze frecvente pe server OCI:\n1. Passphrase greșit (Passphrase-ul setat la crearea cheii pe OKX este case-sensitive).\n2. Cheia a fost creată pe alt mod (Live vs Demo) sau pe un cont OKX diferit.\n3. Cheia nu are permisiunea 'Read' și 'Trade' bifate pe OKX.\n4. IP Whitelist: Dacă cheia are restricție IP pe OKX, trebuie adăugat IP-ul serverului OCI: ${serverIp}.`,
      };
    }

    if (errText.includes('50119')) {
      return {
        reachable: true,
        authenticated: false,
        serverIp,
        region: activeReg,
        endpoint: attempt.baseUrl,
        error: `⚠️ CHEIE INEXISTENTĂ [50119]: Cheia API nu există pe ${attempt.baseUrl}. Conturile europene (România) sunt găzduite pe https://eea.okx.com, iar cele internaționale pe https://www.okx.com.`,
      };
    }

    return {
      reachable: true,
      authenticated: false,
      serverIp,
      region: activeReg,
      endpoint: attempt.baseUrl,
      error: `Eroare autentificare OKX [HTTP ${attempt.status}]: ${errText || 'Răspuns necunoscut de la OKX'}`,
    };
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
      const msg = err?.message || String(err);
      if (msg.includes('50110') || msg.includes('whitelist') || msg.includes('IP')) {
        console.warn('[OKXAdapter] Balance check skipped: IP not in OKX API key whitelist (Error 50110).');
      } else {
        console.error('[OKXAdapter] Failed to fetch wallet balance:', msg);
      }
    }
    return 0;
  }

  /**
   * Fetches actual cash/wallet balance from OKX account (excluding unrealised PnL)
   */
  public async getWalletBalance(): Promise<number> {
    if (!this.hasCredentials()) {
      return 0;
    }
    try {
      const res = await this.request('GET', '/api/v5/account/balance', undefined, true);
      if (res.code === '0' && Array.isArray(res.data) && res.data.length > 0) {
        const details: any[] = res.data[0].details || [];
        // Support USDC, USDT, USD, EUR
        const relevantDetails = details.filter((d: any) => ['USDC', 'USDT', 'USD', 'EUR'].includes(d.ccy));
        if (relevantDetails.length > 0) {
          const totalCash = relevantDetails.reduce((sum, d) => {
            const val = parseFloat(d.cashBal || d.availBal || d.availEq || d.eq || '0');
            return sum + (isNaN(val) ? 0 : val);
          }, 0);
          if (totalCash > 0) return parseFloat(totalCash.toFixed(2));
        }
        const totalEq = parseFloat(res.data[0].totalEq || '0');
        if (!isNaN(totalEq) && totalEq > 0) return parseFloat(totalEq.toFixed(2));
      }
    } catch (err: any) {
      const msg = err?.message || String(err);
      if (msg.includes('50110') || msg.includes('whitelist') || msg.includes('IP')) {
        console.warn('[OKXAdapter] Balance check skipped: IP not in OKX API key whitelist (Error 50110).');
      } else {
        console.error('[OKXAdapter] Failed to fetch cash balance:', msg);
      }
    }
    return 0;
  }

  /**
   * Fetches klines for a given symbol and interval
   */
  public async getKlines(symbol: string, interval: string, limit: number = 200, signal?: AbortSignal): Promise<Kline[]> {
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
      const fetchSignal = signal || AbortSignal.timeout(8000);
      const res = await this.request('GET', `/api/v5/market/candles?instId=${instId}&bar=${bar}&limit=${limit}`, undefined, false, fetchSignal);
      console.log(`[OKXAdapter] DEBUG getKlines instId=${instId} response:`, JSON.stringify(res).substring(0, 500));
      if (res.code === '0' && Array.isArray(res.data)) {
        // OKX returns newest candles first; reverse so oldest is index 0
        return res.data
          .map((k: any[]) => ({
            timestamp: parseInt(k[0]),
            open: parseFloat(k[1]),
            high: parseFloat(k[2]),
            low: parseFloat(k[3]),
            close: parseFloat(k[4]),
            // Use k[5] or k[6], but ensure we at least return a valid candle even if volume is 0
            volume: parseFloat(k[5]) || parseFloat(k[6]) || 0,
          }))
          .reverse();
      }
      console.warn(`[OKXAdapter] getKlines returned no data for ${instId}: code=${res.code}, data=${typeof res.data}, msg=${res.msg}`);
      return [];
    } catch (err: any) {
      console.error(`[OKXAdapter] Error fetching klines for ${instId}:`, err?.message || err);
      // Quietly return empty on timeout/abort
      if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
        return [];
      }
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

    if (this.unlistedSymbols.has(instId)) {
      this.instrumentFilters.set(instId, fallback);
      return fallback;
    }

    try {
      const isFutures = instId.includes('_UM_XPERP');
      let res = await this.request('GET', `/api/v5/public/instruments?instType=${isFutures ? 'FUTURES' : 'SWAP'}&instId=${instId}`, undefined, false);
      if (!(res.code === '0' && Array.isArray(res.data) && res.data.length > 0) && !isFutures) {
        res = await this.request('GET', `/api/v5/public/instruments?instType=FUTURES&instId=${instId}`, undefined, false);
      }
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
          ctValCcy: info.ctValCcy || info.settleCcy || 'USDT',
        };

        this.instrumentFilters.set(instId, filter);
        return filter;
      } else {
        this.unlistedSymbols.add(instId);
      }
    } catch (err: any) {
      if (err?.message?.includes('51001') || err?.message?.includes("doesn't exist")) {
        this.unlistedSymbols.add(instId);
      }
    }

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
      const [swapRes, futRes] = await Promise.all([
        this.request('GET', '/api/v5/account/positions?instType=SWAP', undefined, true).catch(() => ({ code: '-1', data: [] })),
        this.request('GET', '/api/v5/account/positions?instType=FUTURES', undefined, true).catch(() => ({ code: '-1', data: [] }))
      ]);

      const allData: any[] = [];
      if (swapRes.code === '0' && Array.isArray(swapRes.data)) allData.push(...swapRes.data);
      if (futRes.code === '0' && Array.isArray(futRes.data)) allData.push(...futRes.data);

      return allData
        .filter((p: any) => {
          const size = Math.abs(parseFloat(p.pos || '0'));
          return size > 0;
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

    if (this.unlistedSymbols.has(instId)) {
      throw new Error(`Symbol ${instId} is not a valid OKX SWAP contract (OKX API Error 51001).`);
    }

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
        ordType: params.orderType.toLowerCase(), // 'market' or 'limit'
        sz: params.qty.toString(),
        clOrdId,
        ccy: 'USDC',
      };

      if (params.price && params.orderType === 'Limit') {
        submitBody.px = params.price.toString();
      }

      if (params.reduceOnly) {
        submitBody.reduceOnly = true;
      }

      const bodiesToTry = [
        { ...submitBody, ccy: 'USDC' },
        { ...submitBody },
        { ...submitBody, posSide: params.side.toLowerCase() === 'buy' ? 'long' : 'short', ccy: 'USDC' },
        { ...submitBody, posSide: params.side.toLowerCase() === 'buy' ? 'long' : 'short' },
      ];

      let lastError: any = null;
      let successfulRes: any = null;

      for (let i = 0; i < bodiesToTry.length; i++) {
        const body = { ...bodiesToTry[i] };
        if (i > 0) {
          // Provide distinct clOrdId for retry to prevent duplicate clOrdId rejection
          body.clOrdId = `${clOrdId.slice(0, 28)}r${i}`;
        }
        try {
          const res = await this.request('POST', '/api/v5/trade/order', body, true);
          if (res.code === '0' && res.data?.[0]) {
            const orderData = res.data[0];
            if (!orderData.sCode || orderData.sCode === '0') {
              successfulRes = res;
              break;
            } else {
              throw new Error(`OKX sCode [${orderData.sCode}]: ${orderData.sMsg || 'Execution failed'}`);
            }
          } else {
            const detailMsg = res.data?.[0]?.sMsg ? ` - ${res.data[0].sMsg} (sCode: ${res.data[0].sCode})` : '';
            throw new Error(`OKX API Error [${res.code}]: ${res.msg || 'Request failed'}${detailMsg}`);
          }
        } catch (err: any) {
          lastError = err;
          console.warn(`[OKXAdapter] submitOrder attempt ${i + 1} failed:`, err?.message || err);
        }
      }

      if (!successfulRes) {
        throw lastError || new Error('All order placement attempts failed');
      }

      const orderData = successfulRes.data[0];
      return {
        orderId: orderData.ordId,
        orderLinkId: orderData.clOrdId || params.orderLinkId,
      };
    } catch (err: any) {
      if (err?.message?.includes('51001') || err?.message?.includes("doesn't exist")) {
        this.unlistedSymbols.add(instId);
      }
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
      const normSym = symbol ? this.normalizeSymbol(symbol) : undefined;
      const isFut = normSym ? normSym.includes('_UM_XPERP') : false;
      const instTypes = isFut ? ['FUTURES', 'SWAP'] : ['SWAP', 'FUTURES'];
      
      const allOrders: any[] = [];
      for (const instType of instTypes) {
        let endpoint = `/api/v5/trade/orders-pending?instType=${instType}`;
        if (normSym) {
          endpoint += `&instId=${normSym}`;
        }
        try {
          const res = await this.request('GET', endpoint, undefined, true);
          if (res.code === '0' && Array.isArray(res.data)) {
            allOrders.push(...res.data);
          }
        } catch {}
      }
      return allOrders;
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
                  { channel: 'orders', instType: 'FUTURES' },
                  { channel: 'positions', instType: 'SWAP' },
                  { channel: 'positions', instType: 'FUTURES' },
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
