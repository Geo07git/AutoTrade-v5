import crypto from 'crypto';
import WebSocket from 'ws';
import { Kline, OKXRawPosition, OrderStatus, OrderSide, OKXFeeTierInfo } from '../../shared/types';
import { setLiveFeeRates, getLiveFeeRates, calculateVolumeFeeBreakdown } from '../../shared/fees';
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
  private accountPosMode: 'long_short' | 'net' | null = null;
  private posModeCheckPromise: Promise<void> | null = null;
  private credentialsPermanentlyFailed: boolean = false;

  // Bulk instrument cache to avoid per-symbol 429 rate limits on /api/v5/public/instruments
  private bulkInstrumentsPromise: Promise<void> | null = null;
  private lastBulkInstrumentsLoadTime: number = 0;

  // Rate-limiting & balance cache to avoid OKX 429 Too Many Requests (50011)
  private cachedEquity: number = 0;
  private cachedWalletBalance: number = 0;
  private cachedAvailBalance: number = 0;
  private cachedFrozenMargin: number = 0;
  private cachedUnrealizedPnl: number = 0;
  private lastBalanceFetchTime: number = 0;
  private balanceFetchPromise: Promise<{
    equity: number;
    walletBalance: number;
    availBalance: number;
    frozenMargin: number;
    unrealizedPnl: number;
  }> | null = null;
  private static readonly BALANCE_CACHE_TTL_MS = 8_000;
  private lastFillsFetchTime: number = 0;
  private cachedFillsSummary: {
    realizedPnlUSDT: number;
    totalFeesUSDT: number;
    netPnlUSDT: number;
    fillsCount: number;
    closingFillsCount: number;
    totalVolumeUSDT: number;
    makerVolumeUSDT: number;
    takerVolumeUSDT: number;
    recentFills: any[];
  } = {
    realizedPnlUSDT: 0,
    totalFeesUSDT: 0,
    netPnlUSDT: 0,
    fillsCount: 0,
    closingFillsCount: 0,
    totalVolumeUSDT: 0,
    makerVolumeUSDT: 0,
    takerVolumeUSDT: 0,
    recentFills: [],
  };
  private lastFeeTierFetchTime: number = 0;
  private cachedFeeTier: {
    instType: 'FUTURES' | 'SWAP';
    level: string;
    makerFeeRate: number;
    takerFeeRate: number;
    source: 'OKX_API_LIVE' | 'OKX_FILLS_DERIVED' | 'DEFAULT_TIER';
    updatedAt: number;
  } = {
    instType: 'FUTURES',
    level: 'Lv1',
    makerFeeRate: 0.0002,
    takerFeeRate: 0.0005,
    source: 'DEFAULT_TIER',
    updatedAt: Date.now(),
  };
  private ipWhitelistFailed: boolean = false;
  private lastIpWhitelistCheck: number = 0;

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
    this.ipWhitelistFailed = false;
    this.lastIpWhitelistCheck = 0;
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

  public setDemoMode(isDemo: boolean): void {
    if (this.isDemo !== isDemo) {
      this.isDemo = isDemo;
      this.credentialsPermanentlyFailed = false;
      this.lastBalanceFetchTime = 0;
    }
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
   * Performs an authenticated or public request to OKX REST API with auto-fallback between EEA and Global,
   * bounded 429 retry, and a hard timeout race so neither fetch() nor res.json()/res.text() can ever hang.
   */
  private async request(
    method: string,
    path: string,
    body?: any,
    isAuth: boolean = false,
    signal?: AbortSignal,
    retryOtherDomain: boolean = true,
    retryCount: number = 0
  ): Promise<any> {
    if (signal?.aborted) {
      throw new Error(`OKX request aborted: ${path}`);
    }

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

    const timeoutMs = isAuth ? 9000 : 7500;
    const localController = new AbortController();
    const onExternalAbort = () => localController.abort();
    if (signal) {
      if (signal.aborted) {
        localController.abort();
      } else {
        signal.addEventListener('abort', onExternalAbort, { once: true });
      }
    }

    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        localController.abort();
        reject(new Error(`OKX request timeout (${timeoutMs}ms): ${path}`));
      }, timeoutMs);
    });

    let res: Response;
    let rawText = '';
    try {
      const result = await Promise.race([
        (async () => {
          const response = await fetch(url, {
            method,
            headers,
            body: body ? bodyStr : undefined,
            signal: localController.signal,
          });
          const text = await response.text();
          return { response, text };
        })(),
        timeoutPromise,
      ]);
      res = result.response;
      rawText = result.text;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (signal) signal.removeEventListener('abort', onExternalAbort);
    }

    if (!res.ok) {
      const text = rawText;
      let parsedCode = '';
      let parsedMsg = text;
      try {
        const parsed = JSON.parse(text);
        if (parsed.code) parsedCode = parsed.code;
        if (parsed.msg) parsedMsg = parsed.msg;
      } catch {}

      const maxRetries = isAuth ? 2 : 1;
      if ((res.status === 429 || parsedCode === '50011' || text.includes('Too Many Requests')) && retryCount < maxRetries && !signal?.aborted) {
        const retryAfter = isAuth ? 2500 + Math.random() * 2000 : 1200 + Math.random() * 1000;
        console.warn(`[OKXAdapter] Rate limited (HTTP 429 / 50011) on ${path} (retry ${retryCount + 1}/${maxRetries}). Backing off for ${Math.round(retryAfter)}ms.`);
        await new Promise((resolve) => setTimeout(resolve, retryAfter));
        if (signal?.aborted) {
          throw new Error(`OKX request aborted during 429 backoff: ${path}`);
        }
        return this.request(method, path, body, isAuth, signal, retryOtherDomain, retryCount + 1);
      }

      if (parsedCode === '50110' || text.includes('50110') || text.includes('whitelist') || text.includes('IP')) {
        this.ipWhitelistFailed = true;
        this.lastIpWhitelistCheck = Date.now();
        console.warn(`[OKXAdapter] IP Whitelist restriction [50110] on ${url}: ${parsedMsg || text}`);
        throw new Error(`OKX IP Whitelist Error [50110]: IP-ul serverului nu este inclus în Whitelist-ul cheii API pe OKX. Adaugă IP-ul curent în setările API pe OKX.`);
      }

      if (parsedCode === '50124' || text.includes('50124') || text.includes('trading permission')) {
        console.warn(`[OKXAdapter] Trading permission required [50124] on ${url}: ${parsedMsg || text}`);
        throw new Error(`OKX HTTP Error [401] (Cod 50124): Cheia ta API nu are permisiunea 'Trade' (Tranzacționare) activată pe această piață! Mergi în OKX -> Profil -> API Keys -> Editează cheia și bifează 'Trade' (Tranzacționare), și verifică activarea modului de contracte SWAP în OKX Settings.`);
      }

      // If code is 50119 (API key doesn't exist on this domain), automatically try other domain (EEA <-> Global)
      if (isAuth && retryOtherDomain && (text.includes('50119') || text.includes("doesn't exist"))) {
        const altUrl = this.restBaseUrl.includes('eea') ? 'https://www.okx.com' : 'https://eea.okx.com';
        console.warn(`[OKXAdapter] Received 50119 on ${this.restBaseUrl}, auto-retrying on ${altUrl}...`);
        const originalBase = this.restBaseUrl;
        this.restBaseUrl = altUrl;
        try {
          const altRes = await this.request(method, path, body, isAuth, signal, false, retryCount);
          if (altUrl.includes('eea')) {
            this.setRegion('EEA');
          } else {
            this.setRegion('GLOBAL');
          }
          return altRes;
        } catch {
          this.restBaseUrl = originalBase;
        }
      }

      throw new Error(`OKX HTTP Error [${res.status}]: ${text}`);
    }

    let data: any;
    try {
      data = JSON.parse(rawText);
    } catch {
      throw new Error(`OKX invalid JSON response from ${path}`);
    }

    if (process.env.OKX_DEBUG === '1') {
      console.log(`[OKXAdapter] DEBUG request success: ${url} | Code: ${data.code} | Data length: ${Array.isArray(data.data) ? data.data.length : 'N/A'}`);
    }

    if (data.code !== '0') {
      const subCode = data.data?.[0]?.sCode;
      const subMsg = data.data?.[0]?.sMsg;
      const subDetail = subMsg ? ` (sCode ${subCode}: ${subMsg})` : (subCode ? ` (sCode ${subCode})` : '');

      if (data.code === '50110' || data.msg?.includes('whitelist') || data.msg?.includes('IP')) {
        throw new Error(`OKX IP Whitelist Error [50110]: IP-ul serverului nu este inclus în Whitelist-ul cheii API pe OKX. Adaugă IP-ul curent în setările API pe OKX.`);
      }
      if (data.code === '50124' || subCode === '50124' || data.msg?.includes('trading permission') || subMsg?.includes('trading permission')) {
        throw new Error(`OKX API Error [50124]: Cheia ta API nu are permisiunea 'Trade' (Tranzacționare) activată pe această piață! Mergi în OKX -> Profil -> API Keys -> Editează cheia și bifează 'Trade' (Tranzacționare), și verifică activarea modului de contracte SWAP în OKX Settings.`);
      }
      throw new Error(`OKX API Error [${data.code}]: ${data.msg || 'Unknown error'}${subDetail}`);
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
      const path = '/api/v5/account/balance';
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

    // Matrix Attempt 2: If failed with 50111, 50119, or 50105, try Secondary domain with requested demo mode
    if (
      attempt.status !== 200 &&
      (attempt.text.includes('50111') || attempt.text.includes('50119') || attempt.text.includes('50105'))
    ) {
      const altAttempt = await testOnce(secondaryUrl, this.isDemo);
      if (altAttempt.status === 200 && altAttempt.json?.code === '0') {
        attempt = altAttempt;
        this.setRegion(secondaryUrl.includes('eea') ? 'EEA' : 'GLOBAL');
      }
    }

    // Matrix Attempt 3: If still failed with 50111 or 50105, test both domains with OPPOSITE demo mode (mode mismatch detection)
    if (attempt.status !== 200 && (attempt.text.includes('50111') || attempt.text.includes('50105'))) {
      const oppositeDemo = !this.isDemo;
      const oppAttempt1 = await testOnce(primaryUrl, oppositeDemo);
      const oppAttempt2 = (oppAttempt1.status !== 200) ? await testOnce(secondaryUrl, oppositeDemo) : oppAttempt1;
      const oppWinning = oppAttempt1.status === 200 ? oppAttempt1 : oppAttempt2;

      if (oppWinning.status === 200 && oppWinning.json?.code === '0') {
        // Automatically switch adapter to the working mode & domain so the user doesn't get stuck
        this.isDemo = oppositeDemo;
        this.setRegion(oppWinning.baseUrl.includes('eea') ? 'EEA' : 'GLOBAL');
        attempt = oppWinning;
      }
    }

    // Matrix Succeeded
    if (attempt.status === 200 && attempt.json?.code === '0') {
      this.credentialsPermanentlyFailed = false;
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

    if (errText.includes('50105') || errText.includes('PASSPHRASE')) {
      this.credentialsPermanentlyFailed = true;
      return {
        reachable: true,
        authenticated: false,
        serverIp,
        region: activeReg,
        endpoint: attempt.baseUrl,
        error: `⚠️ PASSPHRASE INCORECT [50105]: Passphrase-ul OKX introdus nu corespunde cu cel setat la crearea cheii API pe OKX.\n👉 Soluție: Passphrase-ul este case-sensitive (diferențiază litere mari/mici). Reintrodu Passphrase-ul exact în tabul [6:API] și apasă 'Salvează Cheile OKX'.`,
      };
    }

    if (errText.includes('50113') || errText.includes('Invalid Sign')) {
      this.credentialsPermanentlyFailed = true;
      return {
        reachable: true,
        authenticated: false,
        serverIp,
        region: activeReg,
        endpoint: attempt.baseUrl,
        error: `⚠️ SECRET KEY INCORECT [50113]: Secret Key-ul introdus nu corespunde cu API Key-ul (Invalid Sign).\n👉 Soluție: Reintrodu Secret Key-ul complet în tabul [6:API] și apasă 'Salvează Cheile OKX'.`,
      };
    }

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
      this.credentialsPermanentlyFailed = true;
      return {
        reachable: true,
        authenticated: false,
        serverIp,
        region: activeReg,
        endpoint: attempt.baseUrl,
        error: `⚠️ CHEIE INVALIDĂ [50111]: OKX a refuzat cheia API (Invalid OK-ACCESS-KEY).\n👉 Cauze frecvente:\n1. Cheia a fost creată pe alt mod (Live vs Demo) sau pe un cont OKX diferit.\n2. Cheia nu are permisiunea 'Read' și 'Trade' bifate pe OKX.\n3. IP Whitelist: Dacă cheia are restricție IP pe OKX, trebuie adăugat IP-ul serverului: ${serverIp}.`,
      };
    }

    if (errText.includes('50119')) {
      this.credentialsPermanentlyFailed = true;
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
   * Fetches account balance from OKX with single-flight deduplication, 8s caching,
   * and graceful 429/auth backoff protection.
   * Properly separates:
   * - equity: totalEq / details.eq (Total Equity including unrealized PnL)
   * - walletBalance: details.cashBal (Total cash balance in wallet before frozen margin)
   * - availBalance: details.availBal (Free available balance after subtracting frozen margin)
   * - frozenMargin: details.frozenBal / ordFrozen + imr (Margin locked in open orders & positions)
   * - unrealizedPnl: details.upl (Unrealized PnL on open positions)
   */
  public async fetchAccountBalance(force: boolean = false): Promise<{
    equity: number;
    walletBalance: number;
    availBalance: number;
    frozenMargin: number;
    unrealizedPnl: number;
  }> {
    if (!this.hasCredentials()) {
      return {
        equity: 0,
        walletBalance: 0,
        availBalance: 0,
        frozenMargin: 0,
        unrealizedPnl: 0,
      };
    }

    if (this.credentialsPermanentlyFailed && !force) {
      return {
        equity: this.cachedEquity,
        walletBalance: this.cachedWalletBalance,
        availBalance: this.cachedAvailBalance,
        frozenMargin: this.cachedFrozenMargin,
        unrealizedPnl: this.cachedUnrealizedPnl,
      };
    }

    const now = Date.now();
    // If IP whitelist restriction was detected, return cached values and avoid hammering the endpoint
    if (this.ipWhitelistFailed && now - this.lastIpWhitelistCheck < 120_000) {
      return {
        equity: this.cachedEquity,
        walletBalance: this.cachedWalletBalance,
        availBalance: this.cachedAvailBalance,
        frozenMargin: this.cachedFrozenMargin,
        unrealizedPnl: this.cachedUnrealizedPnl,
      };
    }

    if (
      !force &&
      now - this.lastBalanceFetchTime < OKXAdapter.BALANCE_CACHE_TTL_MS &&
      this.cachedEquity > 0 &&
      this.cachedWalletBalance > 0
    ) {
      return {
        equity: this.cachedEquity,
        walletBalance: this.cachedWalletBalance,
        availBalance: this.cachedAvailBalance,
        frozenMargin: this.cachedFrozenMargin,
        unrealizedPnl: this.cachedUnrealizedPnl,
      };
    }

    if (this.balanceFetchPromise) {
      return this.balanceFetchPromise;
    }

    this.balanceFetchPromise = (async () => {
      try {
        const res = await this.request('GET', '/api/v5/account/balance', undefined, true);
        if (res.code === '0' && Array.isArray(res.data) && res.data.length > 0) {
          this.credentialsPermanentlyFailed = false;
          const accountData = res.data[0];
          const details: any[] = accountData.details || [];
          const relevantDetails = details.filter((d: any) =>
            ['USDC', 'USDT', 'USD', 'EUR'].includes(d.ccy)
          );

          // 1. Total Equity (totalEq or sum of details.eq)
          let eq = parseFloat(accountData.totalEq || '0');
          if (isNaN(eq) || eq <= 0) {
            eq = relevantDetails.reduce((sum, d) => {
              const v = parseFloat(d.eqUsd || d.eq || d.cashBal || '0');
              return sum + (isNaN(v) ? 0 : v);
            }, 0);
          }

          // 2. Total Cash / Wallet Balance (details.cashBal, NOT availBal!)
          const totalCash = relevantDetails.reduce((sum, d) => {
            const v = parseFloat(d.cashBal || d.eq || '0');
            return sum + (isNaN(v) ? 0 : v);
          }, 0);

          // 3. Available / Free Balance (details.availBal after subtracting frozenBal)
          const totalAvail = relevantDetails.reduce((sum, d) => {
            const v = parseFloat(d.availBal || d.availEq || d.cashBal || '0');
            return sum + (isNaN(v) ? 0 : v);
          }, 0);

          // 4. Frozen Margin in open orders + positions (details.frozenBal or ordFrozen + imr)
          const totalFrozen = relevantDetails.reduce((sum, d) => {
            const frozen = parseFloat(d.frozenBal || '0');
            if (!isNaN(frozen) && frozen > 0) return sum + frozen;
            const ordFroz = parseFloat(d.ordFrozen || '0') || 0;
            const imr = parseFloat(d.imr || '0') || 0;
            return sum + ordFroz + imr;
          }, 0);

          // 5. Unrealized PnL on open positions (details.upl or accountData.upl)
          let totalUpl = parseFloat(accountData.upl || '0');
          if (isNaN(totalUpl)) {
            totalUpl = relevantDetails.reduce((sum, d) => {
              const v = parseFloat(d.upl || d.isoUpl || '0');
              return sum + (isNaN(v) ? 0 : v);
            }, 0);
          }

          if (!isNaN(eq) && eq > 0) {
            this.cachedEquity = parseFloat(eq.toFixed(2));
          }
          this.cachedWalletBalance =
            totalCash > 0
              ? parseFloat(totalCash.toFixed(2))
              : this.cachedEquity > 0
              ? this.cachedEquity
              : 0;
          this.cachedAvailBalance =
            totalAvail > 0
              ? parseFloat(totalAvail.toFixed(2))
              : Math.max(0, parseFloat((this.cachedWalletBalance - totalFrozen).toFixed(2)));
          this.cachedFrozenMargin = parseFloat(Math.max(0, totalFrozen).toFixed(2));
          this.cachedUnrealizedPnl = parseFloat((totalUpl || 0).toFixed(4));

          this.lastBalanceFetchTime = Date.now();
          this.ipWhitelistFailed = false;
        }
      } catch (err: any) {
        const msg = err?.message || String(err);
        if (msg.includes('429') || msg.includes('50011') || msg.includes('Too Many Requests')) {
          this.lastBalanceFetchTime = Date.now();
          console.warn('[OKXAdapter] Rate limit (429) on balance endpoint; returning cached balance.');
        } else if (msg.includes('50110') || msg.includes('whitelist') || msg.includes('IP')) {
          this.ipWhitelistFailed = true;
          this.lastIpWhitelistCheck = Date.now();
          this.lastBalanceFetchTime = Date.now() + 120_000;
          console.warn('[OKXAdapter] Balance check skipped: IP not in OKX API key whitelist (Error 50110). Backing off for 2 minutes.');
        } else if (
          msg.includes('50105') ||
          msg.includes('50111') ||
          msg.includes('50113') ||
          msg.includes('50119') ||
          msg.includes('PASSPHRASE') ||
          msg.includes('Invalid Sign')
        ) {
          this.credentialsPermanentlyFailed = true;
          this.lastBalanceFetchTime = Date.now() + 300_000;
          console.warn('[OKXAdapter] Auth paused due to invalid API credentials/passphrase (update in [6:API] tab):', msg);
        } else {
          this.lastBalanceFetchTime = Date.now();
          console.warn('[OKXAdapter] Transient issue fetching account balance:', msg);
        }
      } finally {
        this.balanceFetchPromise = null;
      }
      return {
        equity: this.cachedEquity,
        walletBalance: this.cachedWalletBalance,
        availBalance: this.cachedAvailBalance,
        frozenMargin: this.cachedFrozenMargin,
        unrealizedPnl: this.cachedUnrealizedPnl,
      };
    })();

    return this.balanceFetchPromise;
  }

  public getCachedAccountBalanceDetails() {
    return {
      equity: this.cachedEquity,
      walletBalance: this.cachedWalletBalance,
      availBalance: this.cachedAvailBalance,
      frozenMargin: this.cachedFrozenMargin,
      unrealizedPnl: this.cachedUnrealizedPnl,
    };
  }

  public getAvailableMarginUSDT(): number {
    if (this.cachedAvailBalance > 0) {
      return this.cachedAvailBalance;
    }
    if (this.cachedWalletBalance > 0) {
      return Math.max(0, parseFloat((this.cachedWalletBalance - this.cachedFrozenMargin).toFixed(2)));
    }
    return this.cachedEquity;
  }

  public consumeAvailableMarginOptimistic(amountUSDT: number): void {
    if (!Number.isFinite(amountUSDT) || amountUSDT <= 0) return;
    if (this.cachedAvailBalance > 0) {
      this.cachedAvailBalance = Math.max(0, parseFloat((this.cachedAvailBalance - amountUSDT).toFixed(2)));
    }
    this.cachedFrozenMargin = parseFloat((this.cachedFrozenMargin + amountUSDT).toFixed(2));
  }

  public releaseAvailableMarginOptimistic(amountUSDT: number): void {
    if (!Number.isFinite(amountUSDT) || amountUSDT <= 0) return;
    this.cachedAvailBalance = parseFloat((this.cachedAvailBalance + amountUSDT).toFixed(2));
    this.cachedFrozenMargin = Math.max(0, parseFloat((this.cachedFrozenMargin - amountUSDT).toFixed(2)));
  }

  /**
   * Fetches actual account fee rate tiers from OKX (/api/v5/account/trade-fee?instType=FUTURES)
   * and applies them to the current trade volume display.
   */
  public async fetchTradeFeeTier(
    instType: 'FUTURES' | 'SWAP' = 'FUTURES',
    force: boolean = false
  ): Promise<OKXFeeTierInfo> {
    const now = Date.now();
    if (
      this.hasCredentials() &&
      !this.credentialsPermanentlyFailed &&
      !this.ipWhitelistFailed &&
      (force || now - this.lastFeeTierFetchTime > 60_000 || this.cachedFeeTier.source === 'DEFAULT_TIER')
    ) {
      try {
        const res = await this.request(
          'GET',
          `/api/v5/account/trade-fee?instType=${instType}`,
          undefined,
          true
        );
        if (res?.code === '0' && Array.isArray(res.data) && res.data.length > 0) {
          const item = res.data[0];
          // OKX returns fee rates as negative strings (e.g. "-0.0002" = 0.02% fee paid; "-0.0005" = 0.05% taker fee)
          const rawMaker = Math.abs(parseFloat(item.makerU || item.maker || '-0.0002'));
          const rawTaker = Math.abs(parseFloat(item.takerU || item.taker || '-0.0005'));
          const makerFeeRate = Number.isFinite(rawMaker) && rawMaker > 0 ? rawMaker : 0.0002;
          const takerFeeRate = Number.isFinite(rawTaker) && rawTaker > 0 ? rawTaker : 0.0005;
          const level = String(item.level || 'Lv1');

          this.cachedFeeTier = {
            instType,
            level,
            makerFeeRate,
            takerFeeRate,
            source: 'OKX_API_LIVE',
            updatedAt: now,
          };
          this.lastFeeTierFetchTime = now;
          setLiveFeeRates(makerFeeRate, takerFeeRate, level, 'OKX_API_LIVE');
        }
      } catch {
        this.lastFeeTierFetchTime = now;
      }
    }

    return this.getCachedFeeTierInfo();
  }

  public getCachedFeeTierInfo(): OKXFeeTierInfo {
    const fills = this.cachedFillsSummary;
    const { makerFeeRate, takerFeeRate, level, source, updatedAt, instType } = this.cachedFeeTier;
    const volBreakdown = calculateVolumeFeeBreakdown({
      makerVolumeUSDT: fills.makerVolumeUSDT || 0,
      takerVolumeUSDT: fills.takerVolumeUSDT || 0,
      makerFeeRate,
      takerFeeRate,
    });
    const actualExchangeFeesUSDT = parseFloat((fills.totalFeesUSDT || 0).toFixed(4));
    const calculatedFeeOnVolumeUSDT = volBreakdown.totalCalculatedFeeUSDT;
    const effectiveFeeUSDT =
      actualExchangeFeesUSDT > 0 ? actualExchangeFeesUSDT : calculatedFeeOnVolumeUSDT;

    return {
      instType,
      level,
      makerFeeRate,
      takerFeeRate,
      makerFeePct: parseFloat((makerFeeRate * 100).toFixed(4)),
      takerFeePct: parseFloat((takerFeeRate * 100).toFixed(4)),
      roundTripMakerFeePct: parseFloat((makerFeeRate * 2 * 100).toFixed(4)),
      totalVolumeUSDT: volBreakdown.totalVolumeUSDT,
      makerVolumeUSDT: parseFloat((fills.makerVolumeUSDT || 0).toFixed(2)),
      takerVolumeUSDT: parseFloat((fills.takerVolumeUSDT || 0).toFixed(2)),
      calculatedFeeOnVolumeUSDT,
      actualExchangeFeesUSDT,
      effectiveFeeUSDT,
      fillsAnalyzedCount: fills.fillsCount || 0,
      source,
      updatedAt,
    };
  }

  /**
   * Fetches real executed fills summary from OKX (/api/v5/trade/fills and /api/v5/trade/fills-history)
   * and calculates exact trade volume (maker/taker) and live fees using the account's OKX fee tier.
   */
  public async fetchExchangeFillsSummary(force: boolean = false) {
    if (!this.hasCredentials() || this.credentialsPermanentlyFailed || this.ipWhitelistFailed) {
      return this.cachedFillsSummary;
    }
    const now = Date.now();
    if (!force && now - this.lastFillsFetchTime < 12_000 && this.cachedFillsSummary.fillsCount > 0) {
      return this.cachedFillsSummary;
    }
    try {
      // Ensure bulk instruments and fee tier are loaded so ctVal and fee rates are accurate
      if (this.instrumentFilters.size === 0) {
        await this.loadAllInstrumentsBulk().catch(() => {});
      }
      await this.fetchTradeFeeTier('FUTURES', false).catch(() => {});

      const [recentRes, historyRes] = await Promise.all([
        this.request('GET', '/api/v5/trade/fills?instType=FUTURES&limit=100', undefined, true).catch(
          () => ({ code: '-1', data: [] })
        ),
        this.request(
          'GET',
          '/api/v5/trade/fills-history?instType=FUTURES&limit=100',
          undefined,
          true
        ).catch(() => ({ code: '-1', data: [] })),
      ]);

      const mergedMap = new Map<string, any>();
      const pushList = (arr: any[]) => {
        if (!Array.isArray(arr)) return;
        for (const item of arr) {
          const key = String(item.tradeId || item.billId || `${item.ordId}_${item.ts}`);
          if (!mergedMap.has(key)) {
            mergedMap.set(key, item);
          }
        }
      };
      if (recentRes?.code === '0') pushList(recentRes.data);
      if (historyRes?.code === '0') pushList(historyRes.data);

      const list = Array.from(mergedMap.values()).sort(
        (a, b) => (parseInt(b.ts || b.fillTime || '0', 10) || 0) - (parseInt(a.ts || a.fillTime || '0', 10) || 0)
      );

      if (list.length > 0 || recentRes?.code === '0' || historyRes?.code === '0') {
        let realizedPnl = 0;
        let totalFees = 0;
        let closingCount = 0;
        let makerVolumeUSDT = 0;
        let takerVolumeUSDT = 0;
        const { makerFeeRate, takerFeeRate } = this.cachedFeeTier;

        for (const f of list) {
          const pnl = parseFloat(f.fillPnl || f.pnl || '0') || 0;
          const px = parseFloat(f.fillPx || '0') || 0;
          const sz = Math.abs(parseFloat(f.fillSz || '0') || 0);
          const ctVal = this.getCachedCtVal(f.instId || '');
          const notionalUSDT = px * sz * ctVal;
          const isMaker = String(f.execType || '').toUpperCase() === 'M';

          if (isMaker) {
            makerVolumeUSDT += notionalUSDT;
          } else {
            takerVolumeUSDT += notionalUSDT;
          }

          const rawFee = Math.abs(parseFloat(f.fee || '0') || 0);
          const calcFee = notionalUSDT * (isMaker ? makerFeeRate : takerFeeRate);
          const effectiveFillFee = rawFee > 0 ? rawFee : calcFee;

          realizedPnl += pnl;
          totalFees += effectiveFillFee;
          if (Math.abs(pnl) > 1e-8) closingCount++;
        }

        const totalVolumeUSDT = makerVolumeUSDT + takerVolumeUSDT;
        this.cachedFillsSummary = {
          realizedPnlUSDT: parseFloat(realizedPnl.toFixed(4)),
          totalFeesUSDT: parseFloat(totalFees.toFixed(4)),
          netPnlUSDT: parseFloat((realizedPnl - totalFees).toFixed(4)),
          fillsCount: list.length,
          closingFillsCount: closingCount,
          totalVolumeUSDT: parseFloat(totalVolumeUSDT.toFixed(2)),
          makerVolumeUSDT: parseFloat(makerVolumeUSDT.toFixed(2)),
          takerVolumeUSDT: parseFloat(takerVolumeUSDT.toFixed(2)),
          recentFills: list.slice(0, 50),
        };
        this.lastFillsFetchTime = now;
      }
    } catch {
      this.lastFillsFetchTime = now;
    }
    return this.cachedFillsSummary;
  }

  public getCachedExchangeFillsSummary() {
    return this.cachedFillsSummary;
  }

  /**
   * Fetches current equity from OKX account (cached)
   */
  public async getEquity(): Promise<number> {
    const res = await this.fetchAccountBalance();
    return res.equity;
  }

  /**
   * Fetches actual cash/wallet balance from OKX account (cached, cashBal before frozen margin)
   */
  public async getWalletBalance(): Promise<number> {
    const res = await this.fetchAccountBalance();
    return res.walletBalance > 0 ? res.walletBalance : res.equity;
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
      const fetchSignal = signal || AbortSignal.timeout(7500);
      const res = await this.request('GET', `/api/v5/market/candles?instId=${instId}&bar=${bar}&limit=${limit}`, undefined, false, fetchSignal);
      if (process.env.OKX_DEBUG === '1') {
        console.log(`[OKXAdapter] DEBUG getKlines instId=${instId} response:`, JSON.stringify(res).substring(0, 500));
      }
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
   * Bulk-loads all live FUTURES and SWAP instrument filters in a single request per instType,
   * eliminating per-symbol HTTP 429 rate limits on /api/v5/public/instruments.
   */
  private async loadAllInstrumentsBulk(): Promise<void> {
    if (this.bulkInstrumentsPromise) {
      return this.bulkInstrumentsPromise;
    }

    this.bulkInstrumentsPromise = (async () => {
      try {
        for (const instType of ['FUTURES', 'SWAP'] as const) {
          try {
            const res = await this.request('GET', `/api/v5/public/instruments?instType=${instType}`, undefined, false);
            if (res?.code === '0' && Array.isArray(res.data)) {
              for (const info of res.data) {
                if (!info?.instId) continue;
                const minSz = parseFloat(info.minSz || '1') || 1;
                const lotSz = parseFloat(info.lotSz || '1') || 1;
                const tickSz = parseFloat(info.tickSz || '0.01') || 0.01;
                const ctVal = parseFloat(info.ctVal || '1') || 1;
                this.instrumentFilters.set(info.instId, {
                  symbol: info.instId,
                  minOrderQty: minSz,
                  maxOrderQty: parseFloat(info.maxMktSz || '1000000') || 1000000,
                  qtyStep: lotSz,
                  minNotionalValue: 5,
                  tickSize: tickSz,
                  ctVal,
                  ctValCcy: info.ctValCcy || info.settleCcy || 'USDT',
                });
              }
            }
          } catch {}
        }
        if (this.instrumentFilters.size > 0) {
          this.lastBulkInstrumentsLoadTime = Date.now();
        }
      } finally {
        this.bulkInstrumentsPromise = null;
      }
    })();

    return this.bulkInstrumentsPromise;
  }

  /**
   * Caches and returns instrument lot size & tick size filters
   */
  public async getInstrumentFilter(symbol: string): Promise<InstrumentLotFilter> {
    const instId = this.normalizeSymbol(symbol);
    if (this.instrumentFilters.has(instId)) {
      return this.instrumentFilters.get(instId)!;
    }

    // Preload all instruments in bulk once (or every 30m) so we don't fire per-symbol requests that hit 429
    if (Date.now() - this.lastBulkInstrumentsLoadTime > 30 * 60 * 1000) {
      await this.loadAllInstrumentsBulk();
      if (this.instrumentFilters.has(instId)) {
        return this.instrumentFilters.get(instId)!;
      }
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
          const posSide = (p.posSide || '').toLowerCase();
          let side: 'Buy' | 'Sell';
          if (posSide === 'short') {
            side = 'Sell';
          } else if (posSide === 'long') {
            side = 'Buy';
          } else {
            // Net mode fallback: positive pos is Buy (Long), negative pos is Sell (Short)
            side = rawSize < 0 ? 'Sell' : 'Buy';
          }

          return {
            symbol: p.instId,
            side,
            posSide: (side === 'Sell' ? 'short' : 'long') as 'long' | 'short',
            mgnMode: (p.mgnMode === 'isolated' ? 'isolated' : 'cross') as 'cross' | 'isolated',
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
   * Ensures leverage and margin mode on OKX (supports both cross and isolated in net_mode and long_short_mode)
   */
  public async ensureLeverage(symbol: string, leverage?: string, marginMode?: 'cross' | 'isolated'): Promise<boolean> {
    if (!this.hasCredentials()) return false;
    const instId = this.normalizeSymbol(symbol);
    const targetLeverage = (leverage || this.leverage).toString();
    const targetMarginMode: 'cross' | 'isolated' =
      marginMode === 'isolated' ? 'isolated' : marginMode === 'cross' ? 'cross' : this.marginMode;
    const configKey = `${instId}_${targetLeverage}_${targetMarginMode}`;

    if (this.configuredLeverageSymbols.has(configKey)) {
      return true;
    }

    await this.ensureAccountPosMode();

    try {
      if (targetMarginMode === 'isolated' && this.accountPosMode === 'long_short') {
        // In OKX Hedge Mode (long_short_mode), isolated margin requires setting leverage for both 'long' and 'short' posSide
        const [resLong, resShort] = await Promise.all([
          this.request(
            'POST',
            '/api/v5/account/set-leverage',
            { instId, lever: targetLeverage, mgnMode: 'isolated', posSide: 'long' },
            true
          ).catch(() => ({ code: '-1' })),
          this.request(
            'POST',
            '/api/v5/account/set-leverage',
            { instId, lever: targetLeverage, mgnMode: 'isolated', posSide: 'short' },
            true
          ).catch(() => ({ code: '-1' })),
        ]);
        if (resLong.code === '0' || resShort.code === '0') {
          this.configuredLeverageSymbols.add(configKey);
          return true;
        }
      }

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
      const errMsg = String(err?.message || err);
      // If isolated failed with 51000 (posSide required in long_short_mode), set both 'long' and 'short'
      if (targetMarginMode === 'isolated' && (errMsg.includes('51000') || errMsg.toLowerCase().includes('posside'))) {
        this.accountPosMode = 'long_short';
        try {
          await Promise.all([
            this.request('POST', '/api/v5/account/set-leverage', { instId, lever: targetLeverage, mgnMode: 'isolated', posSide: 'long' }, true).catch(() => {}),
            this.request('POST', '/api/v5/account/set-leverage', { instId, lever: targetLeverage, mgnMode: 'isolated', posSide: 'short' }, true).catch(() => {}),
          ]);
        } catch {}
      }
      this.configuredLeverageSymbols.add(configKey);
      return true;
    }
  }

  /**
   * Detects account position mode ('long_short_mode' vs 'net_mode') once via /api/v5/account/config
   * so the first order placement never wastes attempts on sCode 51000 (Parameter posSide error).
   */
  private async ensureAccountPosMode(): Promise<void> {
    if (this.accountPosMode !== null || !this.hasCredentials() || this.credentialsPermanentlyFailed) {
      return;
    }
    if (this.posModeCheckPromise) {
      return this.posModeCheckPromise;
    }

    this.posModeCheckPromise = (async () => {
      try {
        const res = await this.request('GET', '/api/v5/account/config', undefined, true);
        if (res?.code === '0' && Array.isArray(res.data) && res.data.length > 0) {
          const posMode = res.data[0]?.posMode;
          if (posMode === 'long_short_mode') {
            this.accountPosMode = 'long_short';
          } else if (posMode === 'net_mode') {
            this.accountPosMode = 'net';
          }
        }
      } catch {
        // Fallback handled gracefully by submitOrder
      } finally {
        this.posModeCheckPromise = null;
      }
    })();

    return this.posModeCheckPromise;
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
    posSide?: 'long' | 'short' | 'net';
    leverage?: number;
    marginMode?: 'cross' | 'isolated';
  }): Promise<{ orderId: string; orderLinkId: string }> {
    if (!this.hasCredentials()) {
      throw new Error('Cannot submit order: OKX API credentials not configured.');
    }

    const instId = this.normalizeSymbol(params.symbol);

    if (this.unlistedSymbols.has(instId)) {
      throw new Error(`Symbol ${instId} is not a valid OKX SWAP/FUTURES contract (OKX API Error 51001).`);
    }

    await this.ensureAccountPosMode();

    const effectiveLeverage = params.leverage ? params.leverage.toString() : this.leverage;
    const effectiveMarginMode: 'cross' | 'isolated' = params.marginMode || this.marginMode;

    if (!params.reduceOnly) {
      await this.ensureLeverage(instId, effectiveLeverage, effectiveMarginMode);
    }

    try {
      // clOrdId in OKX must be max 32 characters alphanumeric
      const clOrdId = params.orderLinkId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 32);

      // Determine accurate position side:
      // When opening: BUY -> 'long', SELL -> 'short'
      // When closing (reduceOnly): closing with SELL -> 'long' position; closing with BUY -> 'short' position
      let targetPosSide: 'long' | 'short' | 'net' = params.posSide || (params.reduceOnly
        ? (params.side.toLowerCase() === 'sell' ? 'long' : 'short')
        : (params.side.toLowerCase() === 'buy' ? 'long' : 'short'));

      const baseBody: any = {
        instId,
        tdMode: effectiveMarginMode,
        side: params.side.toLowerCase(), // 'buy' or 'sell'
        ordType: params.orderType.toLowerCase(), // 'market' or 'limit'
        sz: params.qty.toString(),
        clOrdId,
      };

      if (params.price && params.orderType === 'Limit') {
        baseBody.px = params.price.toString();
      }

      if (params.reduceOnly) {
        baseBody.reduceOnly = true;
      }

      // Modes to try:
      // - For new entry orders (!reduceOnly): use configured marginMode first; only try alternate mode if 51010/mode error.
      // - For close orders (reduceOnly): try configured marginMode first, then alternate mode in case position was opened in the other mode.
      const modesToTry: ('cross' | 'isolated')[] = params.reduceOnly
        ? [effectiveMarginMode, effectiveMarginMode === 'cross' ? 'isolated' : 'cross']
        : [effectiveMarginMode];

      let lastError: any = null;
      let successfulRes: any = null;
      let attemptIndex = 0;
      let abortAllRetries = false;

      for (let mIdx = 0; mIdx < modesToTry.length && !successfulRes && !abortAllRetries; mIdx++) {
        const mode = modesToTry[mIdx];
        const posSideVariants: Array<'long' | 'short' | 'net' | undefined> =
          this.accountPosMode === 'long_short'
            ? [targetPosSide]
            : this.accountPosMode === 'net'
            ? [undefined]
            : [targetPosSide, undefined];

        for (let pIdx = 0; pIdx < posSideVariants.length && !successfulRes && !abortAllRetries; pIdx++) {
          const posSideCandidate = posSideVariants[pIdx];
          const body: any = { ...baseBody, tdMode: mode };
          if (posSideCandidate) {
            body.posSide = posSideCandidate;
          } else {
            delete body.posSide;
          }
          if (attemptIndex > 0) {
            // Provide distinct clOrdId for retry to prevent duplicate clOrdId rejection (51016)
            const entropy = Date.now().toString(36).slice(-4) + Math.random().toString(36).slice(2, 4);
            body.clOrdId = `${clOrdId.slice(0, 22)}${entropy}r${attemptIndex}`;
          }
          attemptIndex++;

          try {
            console.log(`[OKXAdapter] Attempting order placement (attempt ${attemptIndex}):`, JSON.stringify(body));
            const res = await this.request('POST', '/api/v5/trade/order', body, true);
            if (res.code === '0' && res.data?.[0]) {
              const orderData = res.data[0];
              if (!orderData.sCode || orderData.sCode === '0') {
                successfulRes = res;
                this.accountPosMode = posSideCandidate && posSideCandidate !== 'net' ? 'long_short' : 'net';
                break;
              } else {
                throw new Error(`OKX sCode [${orderData.sCode}]: ${orderData.sMsg || 'Execution failed'}`);
              }
            } else {
              const subCode = res.data?.[0]?.sCode;
              const subMsg = res.data?.[0]?.sMsg;
              const detailMsg = subMsg ? ` - ${subMsg} (sCode: ${subCode})` : (res.msg ? `: ${res.msg}` : '');
              throw new Error(`OKX API Error [${res.code}]${detailMsg}`);
            }
          } catch (err: any) {
            lastError = err;
            const errMsg = String(err?.message || err);
            const isInsufficientMargin =
              errMsg.includes('51008') || errMsg.toLowerCase().includes('insufficient');
            const isDuplicateClOrdId =
              errMsg.includes('51016') || errMsg.toLowerCase().includes('already exists');

            if (isInsufficientMargin) {
              this.cachedAvailBalance = 0;
              this.fetchAccountBalance(true).catch(() => {});
              console.log(
                `[OKXAdapter] Margin limit reached (51008) for ${instId}; keeping outer grid level in virtual standby until margin frees up.`
              );
            } else if (isDuplicateClOrdId && attemptIndex <= 2) {
              console.log(
                `[OKXAdapter] Duplicate clOrdId (51016) on ${instId}; regenerating unique clOrdId and retrying.`
              );
              pIdx--; // Retry same posSideCandidate with fresh unique clOrdId
              continue;
            } else {
              console.warn(`[OKXAdapter] submitOrder attempt ${attemptIndex} notice:`, errMsg);
            }

            // Non-retryable errors: insufficient margin (51008), invalid instrument (51001), size/price limit (51004/51006/51020), auth/permission (50124/50110)
            if (
              isInsufficientMargin ||
              errMsg.includes('51001') ||
              errMsg.includes('51004') ||
              errMsg.includes('51006') ||
              errMsg.includes('51020') ||
              errMsg.includes('50124') ||
              errMsg.includes('50110')
            ) {
              this.accountPosMode = posSideCandidate && posSideCandidate !== 'net' ? 'long_short' : 'net';
              abortAllRetries = true;
              break;
            }

            // If error is NOT a posSide parameter error (51000), posSide was valid -> lock posMode and stop trying other posSide variants for this tdMode
            if (!errMsg.includes('51000') && !errMsg.toLowerCase().includes('posside')) {
              this.accountPosMode = posSideCandidate && posSideCandidate !== 'net' ? 'long_short' : 'net';
              break;
            }
          }
        }
      }

      // If regular order placement fails on a close order, attempt the dedicated OKX position close endpoint
      if (!successfulRes && params.reduceOnly) {
        for (const closeMode of [effectiveMarginMode, effectiveMarginMode === 'cross' ? 'isolated' : 'cross']) {
          try {
            console.log(`[OKXAdapter] Attempting direct /api/v5/trade/close-position (${closeMode}) for ${instId}...`);
            const closeBody: any = {
              instId,
              mgnMode: closeMode,
            };
            if (this.accountPosMode !== 'net') {
              closeBody.posSide = targetPosSide;
            }
            const closeRes = await this.request('POST', '/api/v5/trade/close-position', closeBody, true);
            if (closeRes.code === '0') {
              const ordId = closeRes.data?.[0]?.ordId || `close_${Date.now()}`;
              return {
                orderId: ordId,
                orderLinkId: params.orderLinkId,
              };
            }
          } catch (closeErr: any) {
            console.warn(`[OKXAdapter] Dedicated close-position (${closeMode}) failed:`, closeErr?.message || closeErr);
          }
        }
      }

      if (!successfulRes) {
        throw lastError || new Error('All order placement attempts failed');
      }

      const orderData = successfulRes.data[0];
      if (!params.reduceOnly && params.price && params.qty) {
        const ctVal = this.getCachedCtVal(instId);
        const levNum = Math.max(1, parseFloat(effectiveLeverage) || 1);
        const estMargin = ((params.qty * ctVal * params.price) / levNum) * 1.05;
        this.consumeAvailableMarginOptimistic(estMargin);
      }

      return {
        orderId: orderData.ordId,
        orderLinkId: orderData.clOrdId || params.orderLinkId,
      };
    } catch (err: any) {
      const errMsg = String(err?.message || err);
      if (errMsg.includes('51001') || errMsg.includes("doesn't exist")) {
        this.unlistedSymbols.add(instId);
      }
      if (!errMsg.includes('51008') && !errMsg.toLowerCase().includes('insufficient')) {
        console.warn(`[OKXAdapter] submitOrder rejected for ${instId}:`, errMsg);
      }
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
        const instType = instId.includes('_UM_XPERP') ? 'FUTURES' : 'SWAP';
        res = await this.request('GET', `/api/v5/trade/orders-history?instType=${instType}&instId=${instId}&${queryParam}`, undefined, true);
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
      if (orderId && !orderId.startsWith('sim_') && !orderId.startsWith('pending_')) {
        cancelBody.ordId = orderId;
      } else if (clOrdId) {
        cancelBody.clOrdId = clOrdId;
      } else {
        return false;
      }

      const res = await this.request('POST', '/api/v5/trade/cancel-order', cancelBody, true);
      const sCode = res.data?.[0]?.sCode;
      if (res.code === '0' && (!sCode || sCode === '0')) {
        return true;
      }
      if (sCode === '51400' || sCode === '51401') {
        return true;
      }
      return false;
    } catch (err: any) {
      const errMsg = String(err?.message || err);
      if (
        errMsg.includes('51400') ||
        errMsg.includes('51401') ||
        errMsg.toLowerCase().includes('filled, canceled or does not exist')
      ) {
        console.log(`[OKXAdapter] Order on ${instId} already closed/cancelled (51400).`);
        return true;
      }
      console.warn(`[OKXAdapter] Failed cancelOrder for ${instId}:`, errMsg);
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

  private wsPrivateQueue: any[] = [];
  private wsPrivateLoggedIn: boolean = false;

  private initPrivateWebSocket() {
    if (this.wsPrivate || !this.hasCredentials() || this.credentialsPermanentlyFailed) return;
    this.wsPrivateLoggedIn = false;
    this.wsPrivateQueue = [];

    try {
      this.wsPrivate = new WebSocket(this.wsPrivateUrl);

      this.wsPrivate.on('open', () => {
        const timestamp = (Math.floor(Date.now() / 1000)).toString();
        const sign = crypto.createHmac('sha256', this.secretKey).update(timestamp + 'GET/users/self/verify').digest('base64');

        this.sendPrivate({
          op: 'login',
          args: [
            {
              apiKey: this.apiKey,
              passphrase: this.passphrase,
              timestamp,
              sign,
            },
          ],
        });
      });

      this.wsPrivate.on('message', (data: WebSocket.Data) => {
        const text = data.toString();
        if (text === 'pong') return;
        try {
          const parsed = JSON.parse(text);
          if (parsed.event === 'error' && (parsed.code === '60009' || parsed.code === '60001' || parsed.code === '50105')) {
            this.credentialsPermanentlyFailed = true;
            try { this.wsPrivate?.close(); } catch {}
            return;
          }
          if (parsed.event === 'login' && parsed.code === '0') {
            this.wsPrivateLoggedIn = true;
            this.sendPrivate({
              op: 'subscribe',
              args: [
                { channel: 'orders', instType: 'SWAP' },
                { channel: 'orders', instType: 'FUTURES' },
                { channel: 'positions', instType: 'SWAP' },
                { channel: 'positions', instType: 'FUTURES' },
                { channel: 'account' },
              ],
            });
            // Process queue
            while (this.wsPrivateQueue.length > 0) {
              this.sendPrivate(this.wsPrivateQueue.shift());
            }
          }

          if (parsed.arg?.channel === 'orders' && this.onOrderUpdate) {
            parsed.data?.forEach((o: any) => this.onOrderUpdate?.(o));
          }
          if (parsed.arg?.channel === 'positions' && this.onPositionUpdate) {
            parsed.data?.forEach((p: any) => this.onPositionUpdate?.(p));
          }
          if (parsed.arg?.channel === 'account') {
            if (Array.isArray(parsed.data) && parsed.data.length > 0) {
              const acc = parsed.data[0];
              const details: any[] = acc.details || [];
              const relevantDetails = details.filter((d: any) =>
                ['USDC', 'USDT', 'USD', 'EUR'].includes(d.ccy)
              );
              let eq = parseFloat(acc.totalEq || '0');
              if (isNaN(eq) || eq <= 0) {
                eq = relevantDetails.reduce((sum, d) => {
                  const v = parseFloat(d.eqUsd || d.eq || d.cashBal || '0');
                  return sum + (isNaN(v) ? 0 : v);
                }, 0);
              }
              const totalCash = relevantDetails.reduce((sum, d) => {
                const v = parseFloat(d.cashBal || d.eq || '0');
                return sum + (isNaN(v) ? 0 : v);
              }, 0);
              const totalAvail = relevantDetails.reduce((sum, d) => {
                const v = parseFloat(d.availBal || d.availEq || d.cashBal || '0');
                return sum + (isNaN(v) ? 0 : v);
              }, 0);
              const totalFrozen = relevantDetails.reduce((sum, d) => {
                const frozen = parseFloat(d.frozenBal || '0');
                if (!isNaN(frozen) && frozen > 0) return sum + frozen;
                const ordFroz = parseFloat(d.ordFrozen || '0') || 0;
                const imr = parseFloat(d.imr || '0') || 0;
                return sum + ordFroz + imr;
              }, 0);
              if (!isNaN(eq) && eq > 0) {
                this.cachedEquity = parseFloat(eq.toFixed(2));
                this.lastBalanceFetchTime = Date.now();
              }
              if (totalCash > 0) {
                this.cachedWalletBalance = parseFloat(totalCash.toFixed(2));
              } else if (this.cachedEquity > 0 && this.cachedWalletBalance <= 0) {
                this.cachedWalletBalance = this.cachedEquity;
              }
              if (totalAvail > 0) {
                this.cachedAvailBalance = parseFloat(totalAvail.toFixed(2));
              }
              if (totalFrozen >= 0) {
                this.cachedFrozenMargin = parseFloat(totalFrozen.toFixed(2));
              }
            }
            if (this.onWalletUpdate) {
              this.onWalletUpdate(parsed.data);
            }
          }
        } catch {}
      });

      this.wsPrivate.on('error', (err) => console.warn('[OKX Private WS Warning]', err?.message || err));
      this.wsPrivate.on('close', () => {
        this.wsPrivate = undefined;
        this.wsPrivateLoggedIn = false;
        if (!this.credentialsPermanentlyFailed) {
          setTimeout(() => this.initPrivateWebSocket(), 5000); // Reconnect
        }
      });
    } catch (err: any) {
      console.warn('[OKXAdapter] Warning initializing Private WebSocket:', err?.message || err);
    }
  }

  private sendPrivate(data: any) {
    if (this.wsPrivate && this.wsPrivate.readyState === WebSocket.OPEN) {
      try {
        this.wsPrivate.send(JSON.stringify(data));
      } catch (err) {
        console.error('[OKXAdapter] sendPrivate error:', err);
        this.wsPrivateQueue.push(data);
      }
    } else {
      console.log(`[OKXAdapter] WebSocket not open (state: ${this.wsPrivate?.readyState}), queuing message:`, JSON.stringify(data));
      this.wsPrivateQueue.push(data);
    }
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

  // =========================================================================
  // OKX EEA NATIVE FUTURES GRID (contract_grid — direction: neutral) API
  // =========================================================================

  /**
   * Performs a public/authenticated request with an optional per-call Demo/Live header override
   * so the Native Grid module can test in DEMO mode or execute in LIVE mode as configured.
   */
  private async requestWithEnvOverride(
    method: string,
    path: string,
    body?: any,
    isAuth: boolean = false,
    forceDemo?: boolean
  ): Promise<any> {
    const prevDemo = this.isDemo;
    if (typeof forceDemo === 'boolean') {
      this.isDemo = forceDemo;
    }
    try {
      return await this.request(method, path, body, isAuth);
    } finally {
      this.isDemo = prevDemo;
    }
  }

  /**
   * Fetches Open Interest, Funding Rate, and Order Book Depth/Imbalance for Market Intelligence
   * on OKX EEA (https://eea.okx.com).
   */
  public async fetchMarketIntelligenceExtras(instId: string): Promise<{
    openInterestUSD: number;
    fundingRatePct: number;
    nextFundingRatePct: number;
    orderBookImbalance: number;
    orderBookDepthUSD: number;
    spreadBps: number;
  }> {
    const normInstId = this.normalizeSymbol(instId);
    const isFutures = normInstId.includes('_UM_XPERP');
    const instType = isFutures ? 'FUTURES' : 'SWAP';

    let openInterestUSD = 0;
    let fundingRatePct = 0.01;
    let nextFundingRatePct = 0.01;
    let orderBookImbalance = 0;
    let orderBookDepthUSD = 0;
    let spreadBps = 2.0;

    const [oiRes, fundRes, bookRes] = await Promise.all([
      this.request(
        'GET',
        `/api/v5/public/open-interest?instType=${instType}&instId=${normInstId}`,
        undefined,
        false
      ).catch(() => null),
      this.request(
        'GET',
        `/api/v5/public/funding-rate?instId=${normInstId}`,
        undefined,
        false
      ).catch(() => null),
      this.getOrderBook(normInstId, 20).catch(() => ({ bids: [], asks: [] })),
    ]);

    const ctVal = this.getCachedCtVal(normInstId);

    if (oiRes?.code === '0' && Array.isArray(oiRes.data) && oiRes.data.length > 0) {
      const d = oiRes.data[0];
      const oiUsd = parseFloat(d.oiUsd || '0');
      const oiContracts = parseFloat(d.oi || '0');
      if (oiUsd > 0) {
        openInterestUSD = oiUsd;
      } else if (oiContracts > 0 && bookRes.bids.length > 0) {
        openInterestUSD = oiContracts * ctVal * bookRes.bids[0][0];
      }
    }

    if (fundRes?.code === '0' && Array.isArray(fundRes.data) && fundRes.data.length > 0) {
      const f = fundRes.data[0];
      const fr = parseFloat(f.fundingRate || '0');
      const nfr = parseFloat(f.nextFundingRate || f.fundingRate || '0');
      if (!isNaN(fr)) fundingRatePct = parseFloat((fr * 100).toFixed(4));
      if (!isNaN(nfr)) nextFundingRatePct = parseFloat((nfr * 100).toFixed(4));
    }

    if (bookRes.bids.length > 0 && bookRes.asks.length > 0) {
      const bestBid = bookRes.bids[0][0];
      const bestAsk = bookRes.asks[0][0];
      const mid = (bestBid + bestAsk) / 2;
      if (mid > 0 && bestAsk >= bestBid) {
        spreadBps = parseFloat((((bestAsk - bestBid) / mid) * 10000).toFixed(2));
      }
      let bidDepthUSD = 0;
      for (const [px, sz] of bookRes.bids) bidDepthUSD += px * sz * ctVal;
      let askDepthUSD = 0;
      for (const [px, sz] of bookRes.asks) askDepthUSD += px * sz * ctVal;
      orderBookDepthUSD = parseFloat((bidDepthUSD + askDepthUSD).toFixed(2));
      if (orderBookDepthUSD > 0) {
        orderBookImbalance = parseFloat(
          ((bidDepthUSD - askDepthUSD) / orderBookDepthUSD).toFixed(3)
        );
      }
    }

    return {
      openInterestUSD: parseFloat(openInterestUSD.toFixed(2)),
      fundingRatePct,
      nextFundingRatePct,
      orderBookImbalance,
      orderBookDepthUSD,
      spreadBps,
    };
  }

  /**
   * 1. OKX Minimum Investment Calculation: POST /api/v5/tradingBot/grid/min-investment
   * Strictly uses algoOrdType: 'contract_grid' and direction: 'neutral'.
   */
  public async calculateGridMinInvestment(params: {
    instId: string;
    maxPx: number;
    minPx: number;
    gridNum: number;
    runType: '1' | '2';
    lever: number;
  }): Promise<{
    minInvestmentUSDT: number;
    ccy: string;
    singleAmt: number;
    error?: string;
  }> {
    const instId = this.normalizeSymbol(params.instId);
    const body = {
      instId,
      algoOrdType: 'contract_grid',
      maxPx: String(params.maxPx),
      minPx: String(params.minPx),
      gridNum: String(Math.max(2, Math.round(params.gridNum))),
      runType: params.runType === '2' ? '2' : '1',
      direction: 'neutral',
      lever: String(Math.max(1, Math.round(params.lever))),
    };

    try {
      const res = await this.request(
        'POST',
        '/api/v5/tradingBot/grid/min-investment',
        body,
        false
      );
      if (res?.code === '0' && Array.isArray(res.data) && res.data.length > 0) {
        const d = res.data[0];
        const invItem = Array.isArray(d.minInvestmentData) ? d.minInvestmentData[0] : null;
        const amt = parseFloat(invItem?.amt || d.minInvestment || '0') || 0;
        const ccy = String(invItem?.ccy || 'USD');
        const singleAmt = parseFloat(d.singleAmt || '0') || 0;
        return {
          minInvestmentUSDT: parseFloat(amt.toFixed(4)),
          ccy,
          singleAmt: parseFloat(singleAmt.toFixed(4)),
        };
      }
      return {
        minInvestmentUSDT: 0,
        ccy: 'USD',
        singleAmt: 0,
        error: res?.msg || 'Nu s-a putut calcula investiția minimă pe OKX.',
      };
    } catch (err: any) {
      return {
        minInvestmentUSDT: 0,
        ccy: 'USD',
        singleAmt: 0,
        error: err?.message || 'Eroare la apelul OKX min-investment',
      };
    }
  }

  /**
   * 2. Create Native Contract Grid Bot on OKX: POST /api/v5/tradingBot/grid/order-algo
   * Exclusively contract_grid with direction: 'neutral' and basePos: false.
   */
  public async createNativeContractGrid(params: {
    instId: string;
    maxPx: number;
    minPx: number;
    gridNum: number;
    runType: '1' | '2';
    sz: number;
    lever: number;
    tpTriggerPx?: number;
    slTriggerPx?: number;
    tpRatio?: number;
    slRatio?: number;
    isDemo?: boolean;
  }): Promise<{ algoId: string; sCode?: string; sMsg?: string }> {
    const instId = this.normalizeSymbol(params.instId);
    const body: Record<string, any> = {
      instId,
      algoOrdType: 'contract_grid',
      maxPx: String(params.maxPx),
      minPx: String(params.minPx),
      gridNum: String(Math.max(2, Math.round(params.gridNum))),
      runType: params.runType === '2' ? '2' : '1',
      sz: String(params.sz),
      direction: 'neutral',
      lever: String(Math.max(1, Math.round(params.lever))),
      basePos: false,
    };

    if (params.tpTriggerPx && params.tpTriggerPx > 0) {
      body.tpTriggerPx = String(params.tpTriggerPx);
    }
    if (params.slTriggerPx && params.slTriggerPx > 0) {
      body.slTriggerPx = String(params.slTriggerPx);
    }
    if (params.tpRatio && params.tpRatio > 0) {
      body.tpRatio = String(params.tpRatio);
    }
    if (params.slRatio && params.slRatio > 0) {
      body.slRatio = String(params.slRatio);
    }

    const res = await this.requestWithEnvOverride(
      'POST',
      '/api/v5/tradingBot/grid/order-algo',
      body,
      true,
      params.isDemo
    );
    const item = res?.data?.[0];
    if (!item?.algoId || (item.sCode && item.sCode !== '0')) {
      throw new Error(
        `OKX Native Grid create failed: ${item?.sMsg || res?.msg || 'Unknown error'} (sCode: ${item?.sCode || res?.code})`
      );
    }
    return {
      algoId: String(item.algoId),
      sCode: item.sCode,
      sMsg: item.sMsg,
    };
  }

  /**
   * 3. Amend Native Contract Grid Bot on OKX: POST /api/v5/tradingBot/grid/amend-order-algo
   */
  public async amendNativeContractGrid(params: {
    algoId: string;
    instId: string;
    tpTriggerPx?: number;
    slTriggerPx?: number;
    tpRatio?: number;
    slRatio?: number;
    isDemo?: boolean;
  }): Promise<boolean> {
    const instId = this.normalizeSymbol(params.instId);
    const body: Record<string, any> = {
      algoId: String(params.algoId),
      instId,
    };
    if (params.tpTriggerPx !== undefined) {
      body.tpTriggerPx = params.tpTriggerPx > 0 ? String(params.tpTriggerPx) : '';
    }
    if (params.slTriggerPx !== undefined) {
      body.slTriggerPx = params.slTriggerPx > 0 ? String(params.slTriggerPx) : '';
    }
    if (params.tpRatio !== undefined) {
      body.tpRatio = params.tpRatio > 0 ? String(params.tpRatio) : '';
    }
    if (params.slRatio !== undefined) {
      body.slRatio = params.slRatio > 0 ? String(params.slRatio) : '';
    }

    const res = await this.requestWithEnvOverride(
      'POST',
      '/api/v5/tradingBot/grid/amend-order-algo',
      body,
      true,
      params.isDemo
    );
    const item = res?.data?.[0];
    return res?.code === '0' && (!item?.sCode || item.sCode === '0');
  }

  /**
   * 4. Stop Native Contract Grid Bot on OKX: POST /api/v5/tradingBot/grid/stop-order-algo
   * Note: OKX expects an array of up to 10 stop objects.
   * stopType: '1' = Close position at market & cancel orders; '2' = Keep position open.
   */
  public async stopNativeContractGrid(params: {
    algoId: string;
    instId: string;
    stopType: '1' | '2';
    isDemo?: boolean;
  }): Promise<boolean> {
    const instId = this.normalizeSymbol(params.instId);
    const body = [
      {
        algoId: String(params.algoId),
        instId,
        algoOrdType: 'contract_grid',
        stopType: params.stopType === '2' ? '2' : '1',
      },
    ];

    const res = await this.requestWithEnvOverride(
      'POST',
      '/api/v5/tradingBot/grid/stop-order-algo',
      body,
      true,
      params.isDemo
    );
    const item = res?.data?.[0];
    return res?.code === '0' && (!item?.sCode || item.sCode === '0');
  }

  /**
   * 5. Close Position for a Contract Grid Bot on OKX: POST /api/v5/tradingBot/grid/close-position
   */
  public async closeNativeContractGridPosition(params: {
    algoId: string;
    mktClose?: boolean;
    sz?: string;
    px?: string;
    isDemo?: boolean;
  }): Promise<boolean> {
    const body: Record<string, any> = {
      algoId: String(params.algoId),
      mktClose: params.mktClose !== false,
    };
    if (!body.mktClose && params.sz && params.px) {
      body.sz = String(params.sz);
      body.px = String(params.px);
    }

    const res = await this.requestWithEnvOverride(
      'POST',
      '/api/v5/tradingBot/grid/close-position',
      body,
      true,
      params.isDemo
    );
    const item = res?.data?.[0];
    return res?.code === '0' && (!item?.sCode || item.sCode === '0');
  }

  /**
   * 6. List Active or Historical Native Contract Grid Bots on OKX:
   * GET /api/v5/tradingBot/grid/orders-algo-pending?algoOrdType=contract_grid
   * GET /api/v5/tradingBot/grid/orders-algo-history?algoOrdType=contract_grid
   */
  public async getNativeContractGridBots(
    mode: 'pending' | 'history' = 'pending',
    isDemo?: boolean
  ): Promise<any[]> {
    if (!this.hasCredentials() || this.credentialsPermanentlyFailed || this.ipWhitelistFailed) {
      return [];
    }
    const endpoint =
      mode === 'history'
        ? '/api/v5/tradingBot/grid/orders-algo-history?algoOrdType=contract_grid&limit=50'
        : '/api/v5/tradingBot/grid/orders-algo-pending?algoOrdType=contract_grid&limit=50';
    try {
      const res = await this.requestWithEnvOverride('GET', endpoint, undefined, true, isDemo);
      if (res?.code === '0' && Array.isArray(res.data)) {
        return res.data.filter((b: any) => !b.direction || b.direction === 'neutral');
      }
    } catch {}
    return [];
  }

  /**
   * 7. Fetch Detailed Telemetry for a Native Contract Grid Bot on OKX:
   * GET /api/v5/tradingBot/grid/orders-algo-details?algoOrdType=contract_grid&algoId=...
   */
  public async getNativeContractGridDetails(algoId: string, isDemo?: boolean): Promise<any | null> {
    if (!this.hasCredentials() || !algoId) return null;
    try {
      const res = await this.requestWithEnvOverride(
        'GET',
        `/api/v5/tradingBot/grid/orders-algo-details?algoOrdType=contract_grid&algoId=${encodeURIComponent(algoId)}`,
        undefined,
        true,
        isDemo
      );
      if (res?.code === '0' && Array.isArray(res.data) && res.data.length > 0) {
        return res.data[0];
      }
    } catch {}
    return null;
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
