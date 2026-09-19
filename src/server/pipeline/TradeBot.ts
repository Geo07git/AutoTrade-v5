import {
  AppConfig,
  ProfileConfig,
  AuditLog,
  Position,
  OrderRecord,
  BotState,
  AuditLogType,
  ProfileType,
  ExecutionMode,
  BotStatusResponse,
  UniverseFilterConfig,
  ScannedOpportunity,
  ScannerStats,
} from '../../shared/types';
import { IExecutionAdapter } from '../exchange/IExecutionAdapter';
import { OKXAdapter } from '../exchange/OKXAdapter';
import { PaperExecutionAdapter } from '../exchange/PaperExecutionAdapter';
import { MomentumEngine } from '../engine/MomentumEngine';
import { RiskEngine } from '../risk/RiskEngine';
import { PositionManager } from '../position/PositionManager';
import { OrderManager } from '../order/OrderManager';
import { JsonStore } from '../store';
import { UniverseManager, DEFAULT_UNIVERSE_FILTER } from '../scanner/UniverseManager';
import { MarketScanner } from '../scanner/MarketScanner';
import { telegramService } from '../telegram/TelegramService';

const DEFAULT_CONFIG: AppConfig = {
  executionMode: 'PAPER', // Default safe mode: Full simulation without OKX API keys
  activeProfile: 'MOMENTUM',
  testnet: true,
  killSwitchEngaged: false,
  okxApiKey: process.env.OKX_API_KEY || '',
  okxSecretKey: process.env.OKX_SECRET_KEY || '',
  okxPassphrase: process.env.OKX_PASSPHRASE || '',
  paperEquity: 200.0,
  watchlist: ['BTC-USDT-SWAP', 'ETH-USDT-SWAP', 'SOL-USDT-SWAP'],
  scannerFilter: { ...DEFAULT_UNIVERSE_FILTER },
};

const DEFAULT_PROFILES: Record<ProfileType, ProfileConfig> = {
  SCALP: {
    type: 'SCALP',
    timeframes: ['15', '60'],
    riskPerTradePct: 15,
    maxOpenPositions: 3,
    trailingActivationPct: 1.0,
    trailingDistancePct: 0.3,
    breakEvenActivationPct: 0.5,
    takeProfitPct: 3.0, // TP 3% vs SL 1.0% (R/R 3:1)
    hardStopLossPct: 1.0,
    equityProtectionActivationPct: 1.0,
    equityTrailingDrawdownPct: 0.25,
    minMomentumScore: 72,
    maxHoldingTimeMinutes: 30,
    cooldownMinutes: 10,
    sentimentThreshold: 1.5,
  },
  MOMENTUM: {
    type: 'MOMENTUM',
    timeframes: ['60', '240'],
    riskPerTradePct: 10,
    maxOpenPositions: 5,
    trailingActivationPct: 2.0,
    trailingDistancePct: 0.6,
    breakEvenActivationPct: 1.0,
    takeProfitPct: 6.0, // TP 6% vs SL 2.0% (R/R 3:1)
    hardStopLossPct: 2.0,
    equityProtectionActivationPct: 1.0,
    equityTrailingDrawdownPct: 0.25,
    minMomentumScore: 82,
    maxHoldingTimeMinutes: 240,
    cooldownMinutes: 60,
    sentimentThreshold: 2.0,
  },
};

export class TradeBot {
  private configStore: JsonStore<AppConfig>;
  private auditStore: JsonStore<AuditLog[]>;
  private positionStore: JsonStore<Position[]>;
  private orderStore: JsonStore<OrderRecord[]>;

  private activeAdapter: IExecutionAdapter;
  private okxAdapter: OKXAdapter;
  private paperAdapter: PaperExecutionAdapter;

  private engine: MomentumEngine;
  private riskEngine: RiskEngine;
  private positionManager: PositionManager;
  private orderManager: OrderManager;

  private universeManager: UniverseManager;
  private marketScanner: MarketScanner;

  private state: BotState = 'INITIALIZING';
  private loopInterval?: NodeJS.Timeout;
  private reconnectInterval?: NodeJS.Timeout;
  private currentEquity: number = 200.0;
  private equityHistory: { time: number; equity: number }[] = [];
  private lastEquitySnapshotTime: number = 0;
  private lastSyncTime: number = 0;
  private latestPrices: Record<string, number> = {};
  private isProcessingTick: boolean = false;
  private marketRegime: string = 'BTC: --';
  private regimeInterval?: NodeJS.Timeout;
  private marketSentiment: string = 'OKX NEUTRAL (+0.00%)';
  private marketSentimentScore: number = 0;
  private sentimentInterval?: NodeJS.Timeout;
  private lastSentimentAlertTime: number = 0;

  private getProfiles(): Record<ProfileType, ProfileConfig> {
    const config = this.configStore.get();
    if (config.profiles && Object.keys(config.profiles).length > 0) {
      return config.profiles as Record<ProfileType, ProfileConfig>;
    }
    return DEFAULT_PROFILES;
  }

  private getActiveProfileConfig(): ProfileConfig {
    const config = this.configStore.get();
    return this.getProfiles()[config.activeProfile];
  }

  constructor() {
    this.configStore = new JsonStore<AppConfig>('config.json', DEFAULT_CONFIG);
    this.auditStore = new JsonStore<AuditLog[]>('audit.json', []);
    this.positionStore = new JsonStore<Position[]>('positions.json', []);
    this.orderStore = new JsonStore<OrderRecord[]>('orders.json', []);

    const appConfig = this.configStore.get();
    if (!appConfig.executionMode) {
      appConfig.executionMode = 'PAPER';
      this.configStore.save(appConfig);
    }
    
    // Ensure profiles are initialized in config
    if (!appConfig.profiles) {
      appConfig.profiles = { ...DEFAULT_PROFILES };
      this.configStore.save(appConfig);
    }

    const profile = this.getActiveProfileConfig();

    // Unified audit logger callback
    const auditLogger = (type: AuditLogType, message: string, details?: any) => {
      this.logAudit(type, message, details);
    };

    // Instantiate both adapters
    this.okxAdapter = new OKXAdapter(
      appConfig.okxApiKey || '',
      appConfig.okxSecretKey || '',
      appConfig.okxPassphrase || '',
      appConfig.testnet
    );
    if (appConfig.maxLeverage) {
      this.okxAdapter.setLeverageConfig(appConfig.maxLeverage, 'cross');
    }
    this.paperAdapter = new PaperExecutionAdapter();

    // Select active adapter based on executionMode
    this.activeAdapter = appConfig.executionMode === 'TESTNET' ? this.okxAdapter : this.paperAdapter;

    this.positionManager = new PositionManager(auditLogger);
    this.positionManager.setCtValResolver((sym) => this.activeAdapter.getCachedCtVal?.(sym) || 1);
    this.orderManager = new OrderManager(
      this.activeAdapter,
      this.positionManager,
      auditLogger,
      appConfig.executionMode
    );

    this.engine = new MomentumEngine(profile);
    this.riskEngine = new RiskEngine();

    // Dynamic Universe & Market Scanner initialization
    this.universeManager = new UniverseManager(auditLogger);
    this.marketScanner = new MarketScanner(
      this.activeAdapter,
      this.engine,
      this.universeManager,
      auditLogger
    );
    if (appConfig.scannerFilter) {
      this.marketScanner.updateFilterConfig(appConfig.scannerFilter);
    }

    // Rehydrate saved positions and orders
    const savedPositions = this.positionStore.get() || [];
    this.positionManager.setActivePositions(savedPositions);

    const savedOrders = this.orderStore.get() || [];
    this.orderManager.setOrders(savedOrders);

    // Initialize equityHistory with initial points if empty
    const now = Date.now();
    this.equityHistory = [
      { time: now - 3600000 * 4, equity: 200.0 },
      { time: now - 3600000 * 3, equity: 200.10 },
      { time: now - 3600000 * 2, equity: 200.05 },
      { time: now - 3600000 * 1, equity: 200.25 },
      { time: now, equity: 200.0 }
    ];
    this.lastEquitySnapshotTime = now;

    // Setup WebSocket event hooks
    this.setupAdapterListeners(this.activeAdapter);

    // Setup Telegram bot delegate
    telegramService.setBotDelegate({
      getStatus: () => this.getStatus(),
      getClosedPositions: () => this.positionManager.getClosedHistory(),
      getActivePositions: () => this.positionManager.getActivePositions(),
      getOrders: () => this.orderManager.getOrders(),
      getAuditLogs: () => this.auditStore.get(),
      toggleKillSwitch: async () => {
        const engaged = await this.toggleKillSwitch();
        return { success: true, killSwitchEngaged: engaged };
      },
      executeManualOrder: (sym, side, qty) => this.executeManualOrder(sym, side, qty),
      closePositionManually: (sym) => this.closePositionManually(sym),
      setExecutionMode: (mode) => this.setExecutionMode(mode as any),
    });
    if (appConfig.telegramBotToken) {
      telegramService.updateCredentials(appConfig.telegramBotToken, appConfig.telegramChatId);
    }
  }

  private setupAdapterListeners(adapter: IExecutionAdapter) {
    adapter.onTickerUpdate = (symbol, lastPrice) => {
      this.latestPrices[symbol] = lastPrice;
      const profile = this.getActiveProfileConfig();
      // Live trailing stop & stop loss evaluation on real tick
      this.positionManager
        .updatePrices(this.latestPrices, profile, this.orderManager, this.currentEquity)
        .catch((err) => console.error('[TradeBot] Position price update error:', err));
    };

    adapter.onOrderUpdate = (orderData) => {
      this.orderManager.handleWsOrderUpdate(orderData);
      this.orderStore.save(this.orderManager.getOrders());
    };

    adapter.onExecutionUpdate = (execData) => {
      this.logAudit('ORDER_FILLED', `Execution confirmed for ${execData.symbol}`, execData);
    };

    adapter.onWalletUpdate = (walletData) => {
      const eq = parseFloat(walletData?.totalEquity || '0');
      if (eq > 0) {
        this.currentEquity = eq;
      }
    };

    adapter.onConnectionChange = (connected, msg) => {
      if (connected) {
        this.logAudit('EXCHANGE_CONNECTED', msg);
      } else {
        this.logAudit('EXCHANGE_DISCONNECTED', msg);
      }
    };
  }

  /**
   * Safe startup sequence
   */
  public async start() {
    const config = this.configStore.get();
    this.logAudit('SYSTEM', `TradeBot 5 starting sequence initiated in [${config.executionMode}] mode...`);
    this.state = 'INITIALIZING';

    await this.connectAndRecover();

    // Start tick loop (runs every 15 seconds)
    if (this.loopInterval) clearInterval(this.loopInterval);
    this.loopInterval = setInterval(() => this.tick(), 15000);

    // Watcher for reconnection if waiting for exchange
    if (this.reconnectInterval) clearInterval(this.reconnectInterval);
    this.reconnectInterval = setInterval(async () => {
      if (this.state === 'WAITING_FOR_EXCHANGE') {
        await this.connectAndRecover();
      }
    }, 15000);

    // Watcher for BTC 24h market regime proxy
    if (this.regimeInterval) clearInterval(this.regimeInterval);
    this.regimeInterval = setInterval(() => this.updateMarketRegime(), 60000); // every minute
    setTimeout(() => this.updateMarketRegime(), 2000);

    // Watcher for global market sentiment (every 30 seconds)
    if (this.sentimentInterval) clearInterval(this.sentimentInterval);
    this.sentimentInterval = setInterval(() => this.updateMarketSentiment(), 30000);
    setTimeout(() => this.updateMarketSentiment(), 1500);

    // Start background Telegram services (hourly alerts, commands)
    telegramService.start();
  }

  private async updateMarketRegime() {
    try {
      const response = await fetch('https://eea.okx.com/api/v5/market/ticker?instId=BTC-USDT-SWAP');
      const data = await response.json();
      if (data && data.code === '0' && Array.isArray(data.data) && data.data.length > 0) {
        const btcData = data.data[0];
        const last = parseFloat(btcData.last || '0');
        const open24h = parseFloat(btcData.open24h || '0');
        const pcnt = open24h > 0 ? ((last - open24h) / open24h) * 100 : 0;
        const sign = pcnt >= 0 ? '+' : '';
        const trend = pcnt > 2.0 ? 'BULL' : pcnt < -2.0 ? 'BEAR' : 'NEUTRAL';
        this.marketRegime = `BTC: ${sign}${pcnt.toFixed(2)}% (${trend})`;
      }
    } catch (err) {
      console.warn('[TradeBot] Failed to update BTC market regime:', err);
    }
  }

  private async updateMarketSentiment() {
    try {
      const benchmarkSymbols = ['BTC-USDT-SWAP', 'ETH-USDT-SWAP', 'SOL-USDT-SWAP'];
      const changes: number[] = [];

      for (const instId of benchmarkSymbols) {
        try {
          const res = await fetch(`https://eea.okx.com/api/v5/market/ticker?instId=${instId}`);
          const data = await res.json();
          if (data && data.code === '0' && Array.isArray(data.data) && data.data.length > 0) {
            const item = data.data[0];
            const last = parseFloat(item.last || '0');
            const open24h = parseFloat(item.open24h || '0');
            if (open24h > 0) {
              const pcnt = ((last - open24h) / open24h) * 100;
              changes.push(pcnt);
            }
          }
        } catch (symErr) {
          // ignore individual symbol ticker failure
        }
      }

      if (changes.length > 0) {
        const avgScore = changes.reduce((a, b) => a + b, 0) / changes.length;
        this.marketSentimentScore = parseFloat(avgScore.toFixed(2));
        const profile = this.getActiveProfileConfig();
        const threshold = profile.sentimentThreshold ?? 1.5;

        const sign = avgScore >= 0 ? '+' : '';
        if (avgScore >= threshold) {
          this.marketSentiment = `OKX BULLISH (${sign}${avgScore.toFixed(2)}%)`;
        } else if (avgScore <= -threshold) {
          this.marketSentiment = `OKX BEARISH (${avgScore.toFixed(2)}%)`;
        } else {
          this.marketSentiment = `OKX NEUTRAL (${sign}${avgScore.toFixed(2)}%)`;
        }

        // Trigger notification if threshold crossed
        if (Math.abs(avgScore) >= threshold) {
          const now = Date.now();
          if (now - this.lastSentimentAlertTime > 15 * 60 * 1000) {
            this.lastSentimentAlertTime = now;
            const alertMsg = `⚡ SENTIMENT GLOBAL ALERT: Sentimentul pieței OKX a depășit pragul de ±${threshold}%: ${this.marketSentiment}`;
            this.logAudit('SYSTEM', alertMsg);
            telegramService.sendMessage(alertMsg);
          }
        }
      }
    } catch (err) {
      console.warn('[TradeBot] Failed to update market sentiment:', err);
    }
  }

  public async refreshMarketSentiment() {
    await this.updateMarketSentiment();
  }

  public async connectAndRecover() {
    const config = this.configStore.get();
    const connTest = await this.activeAdapter.testConnection();

    if (!connTest.reachable || !connTest.authenticated) {
      this.state = 'WAITING_FOR_EXCHANGE';
      const reason = connTest.error || (!this.activeAdapter.hasCredentials() ? 'API keys not configured' : 'Unreachable');
      this.logAudit('EXCHANGE_DISCONNECTED', `Waiting for exchange connection: ${reason}`);
      return;
    }

    this.state = 'READY';
    this.logAudit(
      'EXCHANGE_CONNECTED',
      `Connected to ${config.executionMode} execution engine (${connTest.accountType || 'CONTRACT'}).`
    );

    // Fetch live equity from active adapter
    try {
      const realEquity = await this.activeAdapter.getEquity();
      if (realEquity > 0) {
        this.currentEquity = realEquity;
      } else if (connTest.equity && connTest.equity > 0) {
        this.currentEquity = connTest.equity;
      }
    } catch (err: any) {
      console.warn('[TradeBot] Equity fetch warning:', err.message || err);
    }

    // STRICT RECONCILIATION:
    // If reconciliation fails, DO NOT ALLOW TRADING!
    let reconciliationSuccessful = false;
    try {
      const realPositions = await this.activeAdapter.getOpenPositions();
      const currentProfile = config.activeProfile;

      const reconResult = this.positionManager.reconcileWithExchange(realPositions, currentProfile);
      this.positionStore.save(this.positionManager.getActivePositions());
      this.lastSyncTime = Date.now();
      reconciliationSuccessful = true;

      this.logAudit('RECOVERY', `State reconciled with ${config.executionMode}. Discrepancies resolved: ${reconResult.discrepanciesFound}. Active positions: ${this.positionManager.getActivePositions().length}`, {
        equity: this.currentEquity,
        activePositionsCount: this.positionManager.getActivePositions().length,
        discrepancies: reconResult.discrepanciesFound,
      });
    } catch (err: any) {
      this.state = 'WAITING_FOR_EXCHANGE';
      this.logAudit('ERROR', `Reconciliation failed with ${config.executionMode}: ${err.message || err}. TRADING HALTED - trading is strictly not permitted when state reconciliation fails.`);
      return; // STOP! Do not allow TRADING
    }

    if (!reconciliationSuccessful) {
      this.state = 'WAITING_FOR_EXCHANGE';
      this.logAudit('ERROR', `Reconciliation unverified. TRADING HALTED.`);
      return;
    }

    // Initialize market feeds
    const watchlist = config.watchlist || ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
    if (this.activeAdapter.initWebSocket) {
      this.activeAdapter.initWebSocket(watchlist);
    }

    // If Kill Switch is not engaged, enter TRADING state
    if (!config.killSwitchEngaged) {
      this.state = 'TRADING';
      this.logAudit('SYSTEM', `TradeBot 5 active. Profile: ${config.activeProfile} | Mode: ${config.executionMode}. Engine operational.`);
    } else {
      this.state = 'STOPPED';
      this.logAudit('KILL_SWITCH_ENGAGED', 'Bot remains halted because Kill Switch is currently engaged.');
    }
  }

  public stop() {
    this.state = 'STOPPED';
    if (this.loopInterval) clearInterval(this.loopInterval);
    if (this.reconnectInterval) clearInterval(this.reconnectInterval);
    if (this.regimeInterval) clearInterval(this.regimeInterval);
    this.logAudit('SYSTEM', 'TradeBot 5 stopped by operator');
  }

  /**
   * Central Execution Pipeline:
   * Market Data -> Momentum Engine -> Risk Engine -> Order Manager -> Execution Adapter -> PAPER / OKX
   */
  public async tick() {
    if (this.isProcessingTick) return;
    this.isProcessingTick = true;

    try {
      const config = this.configStore.get();

      // Guard: If Kill Switch is engaged, do not process entries
      if (config.killSwitchEngaged) {
        return;
      }

      // Guard: Must be in TRADING state (if reconciliation failed or waiting for exchange, strictly halt)
      if (this.state !== 'TRADING') {
        return;
      }

      // 1. Sync Equity
      try {
        const liveEquity = await this.activeAdapter.getEquity();
        if (liveEquity > 0) {
          this.currentEquity = liveEquity;
        }
      } catch (e) {
        // preserve currentEquity
      }

      // Record Equity History snapshot (every 15 minutes, or on first tick)
      const now = Date.now();
      if (now - this.lastEquitySnapshotTime > 15 * 60 * 1000) {
        this.equityHistory.push({ time: now, equity: this.currentEquity });
        // Keep last 24 hours (24h * 4 snapshots/hour = 96 snapshots max)
        if (this.equityHistory.length > 96) {
          this.equityHistory.shift();
        }
        this.lastEquitySnapshotTime = now;
      }

      // 2. Periodic Reconciliation
      if (now - this.lastSyncTime > 60000) {
        try {
          const exchangePositions = await this.activeAdapter.getOpenPositions();
          this.positionManager.reconcileWithExchange(exchangePositions, config.activeProfile);
          this.positionStore.save(this.positionManager.getActivePositions());
          this.lastSyncTime = now;
        } catch (err: any) {
          // If reconciliation fails, immediately halt TRADING!
          this.state = 'WAITING_FOR_EXCHANGE';
          this.logAudit('ERROR', `Periodic reconciliation failed with ${config.executionMode}: ${err.message || err}. Trading halted immediately for safety.`);
          return; // Stop current tick immediately! No new orders!
        }
      }

      const profile = this.getActiveProfileConfig();
      this.engine.setConfig(profile); // Force update engine config

      // 3. Dynamic Universe & Market Scanning
      const scannedOpportunities = await this.marketScanner.scan(profile);

      // Update latest prices for all scanned pairs
      for (const opp of scannedOpportunities) {
        if (opp.price > 0) {
          this.latestPrices[opp.symbol] = opp.price;
        }
      }

      // Filter eligible candidates meeting momentum threshold, sorted by score descending
      const eligibleCandidates = scannedOpportunities.filter((opp) => {
        if (!opp.isEligible) return false;
        if (profile.minMomentumScore && opp.score < profile.minMomentumScore) return false;
        return true;
      });

      for (const candidate of eligibleCandidates) {
        const symbol = candidate.symbol;

        // STRICT CHECK 1: Pre-filter symbols that already have an in-flight pending order
        if (this.orderManager.hasPendingOrderForSymbol(symbol)) {
          continue;
        }

        // STRICT CHECK 2: Pre-filter symbols that already have an open position
        const existingPos = this.positionManager.getPosition(symbol);
        if (existingPos && existingPos.status === 'OPEN') {
          continue;
        }

        // STRICT CHECK 3: Check cooldown period
        if (profile.cooldownMinutes && profile.cooldownMinutes > 0) {
          const lastClosedTime = this.positionManager.getLastClosedTime(symbol);
          if (lastClosedTime > 0) {
            const minutesSinceClose = (Date.now() - lastClosedTime) / 60000;
            if (minutesSinceClose < profile.cooldownMinutes) {
              continue;
            }
          }
        }

        this.logAudit(
          'CANDIDATE_SELECTED',
          `Dynamic Candidate #${candidate.rank} Selected: ${symbol} (Momentum Score: ${candidate.score}/100, RVOL: ${candidate.rvol}x, 24h Vol: $${(candidate.volume24hUSDT / 1e6).toFixed(1)}M)`,
          {
            symbol,
            rank: candidate.rank,
            score: candidate.score,
            rvol: candidate.rvol,
            atrExpansion: candidate.atrExpansion,
            price: candidate.price,
            profile: config.activeProfile,
          }
        );

        // Evaluate signal through Momentum Engine with MTF (LTF + HTF confirmation)
        let signal = candidate.signal;
        if (!signal) {
          const ltfKlines = await this.activeAdapter.getKlines(symbol, profile.timeframes[0], 35);
          const htfKlines = profile.timeframes[1]
            ? await this.activeAdapter.getKlines(symbol, profile.timeframes[1], 30)
            : [];
          
          signal = this.engine.evaluate(symbol, {
            [profile.timeframes[0]]: ltfKlines,
            ...(profile.timeframes[1] ? { [profile.timeframes[1]]: htfKlines } : {}),
          });
        }

        if (signal) {
          this.logAudit(
            'SIGNAL_GENERATED',
            `Momentum Engine confirmed ${signal.side} signal on candidate ${symbol} (Score: ${signal.score.toFixed(1)}/100, Rank #${candidate.rank})`,
            {
              symbol,
              side: signal.side,
              score: signal.score,
              profile: config.activeProfile,
              rank: candidate.rank,
            }
          );

          // Risk Engine: Mandatory gatekeeper validation with pending order check
          const hasPending = this.orderManager.hasPendingOrderForSymbol(symbol);
          const riskApproval = this.riskEngine.validateSignal(
            signal,
            profile,
            this.positionManager.getActivePositions(),
            this.currentEquity,
            config.killSwitchEngaged,
            hasPending
          );

          if (!riskApproval.approved) {
            this.logAudit('CANDIDATE_REJECTED', `Candidate ${symbol} rejected by Risk Engine: ${riskApproval.reason}`, {
              symbol,
              reason: riskApproval.reason,
            });
            this.logAudit('SIGNAL_REJECTED', `Signal rejected by Risk Engine: ${riskApproval.reason}`, {
              symbol,
              reason: riskApproval.reason,
            });
            continue;
          }

          // Order Manager: Execute via active Execution Adapter (PAPER or TESTNET)
          const executionResult = await this.orderManager.executeSignalOrder({
            signal,
            riskApproval,
            currentPrice: candidate.price,
            profile: config.activeProfile,
            marketRegime: this.marketRegime,
          });

          if (executionResult.success) {
            // Persist order & position state
            this.orderStore.save(this.orderManager.getOrders());
            this.positionStore.save(this.positionManager.getActivePositions());
          }
        }
      }

      // 4. Update prices and evaluate exit conditions (Trailing / Stop-loss)
      await this.positionManager.updatePrices(this.latestPrices, profile, this.orderManager, this.currentEquity);

      // Persist state
      this.positionStore.save(this.positionManager.getActivePositions());
      this.orderStore.save(this.orderManager.getOrders());
    } catch (err: any) {
      console.error('[TradeBot] Tick execution error:', err);
      this.logAudit('ERROR', `Error in trading cycle: ${err.message || err}`);
    } finally {
      this.isProcessingTick = false;
    }
  }

  /**
   * Set execution mode: PAPER | TESTNET | LIVE
   */
  public async setExecutionMode(mode: ExecutionMode): Promise<{ success: boolean; error?: string }> {
    const activePositions = this.positionManager.getActivePositions();
    if (activePositions.length > 0) {
      const err = `Nu se poate comuta modul de execuție în ${mode} cât timp există ${activePositions.length} poziție(i) deschise. Închide mai întâi toate pozițiile active.`;
      this.logAudit('SYSTEM', `Mode switch rejected: ${err}`, { activePositionsCount: activePositions.length });
      return { success: false, error: err };
    }

    const config = this.configStore.get();

    // Verify credentials if switching to TESTNET or LIVE
    if (mode === 'TESTNET' || mode === 'LIVE') {
      const hasCreds = this.hasOKXCredentials();
      if (!hasCreds) {
        const err = `Cheile API OKX (API Key, Secret Key, Passphrase) lipsesc. Configurează-le mai întâi în panoul de Conexiune OKX sau în variabilele de mediu.`;
        this.logAudit('SYSTEM', `Mode switch rejected: ${err}`);
        return { success: false, error: err };
      }
    }

    if (config.executionMode === mode && ((mode === 'TESTNET' && config.testnet) || (mode === 'LIVE' && !config.testnet))) {
      return { success: true };
    }

    // Close previous adapter sockets if any
    if (this.activeAdapter.close) {
      this.activeAdapter.close();
    }

    config.executionMode = mode;
    config.testnet = mode !== 'LIVE';
    this.configStore.save(config);

    // Switch active execution adapter
    if (mode === 'TESTNET') {
      const key = config.okxApiKey || process.env.OKX_API_KEY || '';
      const secret = config.okxSecretKey || process.env.OKX_SECRET_KEY || '';
      const pass = config.okxPassphrase || process.env.OKX_PASSPHRASE || '';
      this.okxAdapter.updateCredentials(key, secret, pass, true);
      this.activeAdapter = this.okxAdapter;
    } else if (mode === 'LIVE') {
      const key = config.okxApiKey || process.env.OKX_API_KEY || '';
      const secret = config.okxSecretKey || process.env.OKX_SECRET_KEY || '';
      const pass = config.okxPassphrase || process.env.OKX_PASSPHRASE || '';
      this.okxAdapter.updateCredentials(key, secret, pass, false);
      this.activeAdapter = this.okxAdapter;
    } else {
      this.activeAdapter = this.paperAdapter;
    }

    this.orderManager.setExecutionAdapter(this.activeAdapter, mode);

    // Rebind scanner to active adapter
    this.marketScanner = new MarketScanner(
      this.activeAdapter,
      this.engine,
      this.universeManager,
      (type, msg, det) => this.logAudit(type, msg, det)
    );
    if (config.scannerFilter) {
      this.marketScanner.updateFilterConfig(config.scannerFilter);
    }

    this.setupAdapterListeners(this.activeAdapter);
    this.logAudit(
      'MODE_CHANGED',
      `Modul de execuție a fost comutat la [${mode}] (${mode === 'TESTNET' ? 'OKX Demo Simulated Trading' : mode === 'LIVE' ? 'OKX Real Trading' : 'Simulare Locală Paper'}). Reconectare motor...`
    );

    await this.connectAndRecover();
    return { success: true };
  }

  /**
   * Resets the paper trading account balance to $10,000 USDT and clears paper positions
   */
  public resetPaperAccount(): { success: boolean; error?: string } {
    const config = this.configStore.get();
    if (config.executionMode !== 'PAPER') {
      return { success: false, error: 'Account reset is only available in PAPER mode.' };
    }

    this.paperAdapter.resetAccount(200.0);
    this.positionManager.setActivePositions([]);
    this.positionManager.clearHistory();
    this.positionManager.resetHighestEquity(200.0);
    this.positionStore.save([]);
    this.orderManager.clearOrders();
    this.orderStore.save([]);
    this.currentEquity = 200.0;
    this.equityHistory = [{ time: Date.now(), equity: 200.0 }];
    this.lastEquitySnapshotTime = Date.now();

    this.logAudit('PAPER_RESET', 'Paper account reset: Balance restored to $200.00 USDT and paper positions cleared.');
    return { success: true };
  }

  /**
   * Switch between SCALP and MOMENTUM profiles.
   * STRICT RULE: Must be mutually exclusive!
   * Cannot switch profile while positions are open.
   */
  public async setProfile(profile: ProfileType): Promise<{ success: boolean; error?: string }> {
    const activePositions = this.positionManager.getActivePositions();
    if (activePositions.length > 0) {
      const err = `Cannot switch profile to ${profile} while ${activePositions.length} position(s) are open. Close all positions first.`;
      this.logAudit('SYSTEM', `Profile switch rejected: ${err}`, { activePositionsCount: activePositions.length });
      return { success: false, error: err };
    }

    const config = this.configStore.get();
    config.activeProfile = profile;
    this.configStore.save();

    this.engine.setConfig(this.getProfiles()[profile]);
    this.logAudit('SYSTEM', `Active profile switched to ${profile}. Execution rules and timeframes updated.`);
    return { success: true };
  }

  /**
   * Emergency Kill Switch:
   * 1. Sets killSwitchEngaged = true (blocks all new entries)
   * 2. Executes market close orders via active adapter for all open positions
   * 3. Confirms closure before marking locally closed
   */
  public async toggleKillSwitch(): Promise<boolean> {
    const config = this.configStore.get();
    config.killSwitchEngaged = !config.killSwitchEngaged;
    this.configStore.save();

    if (config.killSwitchEngaged) {
      this.state = 'STOPPED';
      this.logAudit('KILL_SWITCH_ENGAGED', `🚨 KILL SWITCH ENGAGED! Halting new entries and closing all open positions via ${config.executionMode}...`);

      const openPositions = [...this.positionManager.getActivePositions()];
      let closedCount = 0;

      for (const pos of openPositions) {
        const currentPrice = this.latestPrices[pos.symbol] || pos.entryPrice;
        const res = await this.orderManager.executeCloseOrder({
          position: pos,
          reason: 'KILL_SWITCH',
          currentPrice,
          exitReasonDetail: 'Închidere de urgență prin Kill Switch Operator',
        });

        if (res.success) {
          closedCount++;
        }
      }

      this.positionStore.save(this.positionManager.getActivePositions());
      this.orderStore.save(this.orderManager.getOrders());

      this.logAudit('KILL_SWITCH_ENGAGED', `Kill Switch completed: ${closedCount}/${openPositions.length} positions closed.`);
    } else {
      this.logAudit('KILL_SWITCH_DISENGAGED', 'Kill Switch disengaged. Resuming normal operations.');
      if (config.executionMode === 'PAPER' || this.activeAdapter.hasCredentials()) {
        this.state = 'TRADING';
      } else {
        this.state = 'WAITING_FOR_EXCHANGE';
      }
    }

    return config.killSwitchEngaged;
  }

  /**
   * Update OKX API credentials
   */
  public async updateCredentials(apiKey: string, secretKey: string, passphrase: string, testnet: boolean = true) {
    const config = this.configStore.get();
    config.okxApiKey = apiKey.trim();
    config.okxSecretKey = secretKey.trim();
    config.okxPassphrase = passphrase.trim();
    config.testnet = testnet;
    this.configStore.save();

    this.okxAdapter.updateCredentials(apiKey, secretKey, passphrase, testnet);
    this.logAudit('SYSTEM', `Chei API OKX actualizate cu succes (Mod rețea: ${testnet ? 'OKX Demo / Simulated Trading' : 'OKX Live / Real Trading'}).`);

    if (config.executionMode === 'TESTNET' || config.executionMode === 'LIVE') {
      await this.connectAndRecover();
    }
  }

  public hasOKXCredentials(): boolean {
    const config = this.configStore.get();
    const hasInConfig = Boolean(config.okxApiKey && config.okxSecretKey && config.okxPassphrase);
    const hasInEnv = Boolean(process.env.OKX_API_KEY && process.env.OKX_SECRET_KEY && process.env.OKX_PASSPHRASE);
    return hasInConfig || hasInEnv;
  }

  public async testOKXConnection(creds?: { apiKey?: string; secretKey?: string; passphrase?: string; isDemo?: boolean }) {
    if (creds && creds.apiKey && creds.secretKey) {
      const tempAdapter = new OKXAdapter(
        creds.apiKey,
        creds.secretKey,
        creds.passphrase || '',
        creds.isDemo ?? true
      );
      return await tempAdapter.testConnection();
    }
    return await this.okxAdapter.testConnection();
  }

  private logAudit(type: AuditLogType, message: string, details?: any) {
    const logs = this.auditStore.get();
    const entry: AuditLog = {
      id: `${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      timestamp: Date.now(),
      type,
      message,
      details,
    };

    logs.unshift(entry);
    if (logs.length > 200) {
      logs.length = 200;
    }
    this.auditStore.save();
    console.log(`[TradeBot][${type}] ${message}`);

    // Non-blocking Telegram notification
    telegramService.notifyEvent(type, message, details);
  }

  public getStatus(): BotStatusResponse {
    const config = this.configStore.get();
    const closedPositions = this.positionManager.getClosedHistory();
    const sessionRealizedPnL = closedPositions.reduce((acc, pos) => acc + (pos.pnl || 0), 0);

    // Calculate advanced performance metrics
    const totalClosed = closedPositions.length;
    let winningTrades = 0;
    let losingTrades = 0;
    let totalGrossProfit = 0;
    let totalGrossLoss = 0;
    let sumWins = 0;
    let sumLosses = 0;

    for (const pos of closedPositions) {
      const pnl = pos.pnl || 0;
      if (pnl > 0) {
        winningTrades++;
        totalGrossProfit += pnl;
        sumWins += pnl;
      } else if (pnl < 0) {
        losingTrades++;
        totalGrossLoss += Math.abs(pnl);
        sumLosses += Math.abs(pnl);
      }
    }

    const activePositions = this.positionManager.getActivePositions().map((p) => {
      const currentPrice = p.currentPrice || this.latestPrices[p.symbol] || p.entryPrice;
      const holdingTimeMinutes = p.holdingTimeMinutes !== undefined
        ? p.holdingTimeMinutes
        : parseFloat(((Date.now() - p.entryTime) / 60000).toFixed(1));
      return {
        ...p,
        currentPrice,
        holdingTimeMinutes,
      };
    });

    const closedHistory = this.positionManager.getClosedHistory();
    const totalClosedFees = closedHistory.reduce((acc, p) => acc + (p.entryFee || 0) + (p.exitFee || 0), 0);
    const totalActiveFees = activePositions.reduce((acc, p) => acc + (p.entryFee || 0), 0);
    const totalFeesPaid = parseFloat((totalClosedFees + totalActiveFees).toFixed(4));

    const winRate = totalClosed > 0 ? (winningTrades / totalClosed) * 100 : 0;
    const profitFactor = totalGrossLoss > 0 ? totalGrossProfit / totalGrossLoss : (totalGrossProfit > 0 ? 999 : 0);
    const avgWin = winningTrades > 0 ? sumWins / winningTrades : 0;
    const avgLoss = losingTrades > 0 ? sumLosses / losingTrades : 0;
    const winRateDecimal = totalClosed > 0 ? winningTrades / totalClosed : 0;
    const lossRateDecimal = totalClosed > 0 ? losingTrades / totalClosed : 0;
    const expectancy = (winRateDecimal * avgWin) - (lossRateDecimal * avgLoss);

    // Max Drawdown calculation from equity history
    let peak = config.paperEquity || 200;
    let maxDdPct = 0;
    if (this.equityHistory && this.equityHistory.length > 0) {
      for (const pt of this.equityHistory) {
        if (pt.equity > peak) {
          peak = pt.equity;
        }
        const dd = peak > 0 ? ((peak - pt.equity) / peak) * 100 : 0;
        if (dd > maxDdPct) {
          maxDdPct = dd;
        }
      }
    }

    const performanceMetrics = {
      totalClosed,
      winningTrades,
      losingTrades,
      winRate: parseFloat(winRate.toFixed(2)),
      profitFactor: parseFloat(profitFactor.toFixed(2)),
      expectancy: parseFloat(expectancy.toFixed(2)),
      avgWin: parseFloat(avgWin.toFixed(2)),
      avgLoss: parseFloat(avgLoss.toFixed(2)),
      maxDrawdownPct: parseFloat(maxDdPct.toFixed(2)),
      totalFeesPaid,
    };
    const marginInvested = parseFloat(
      activePositions.reduce((acc, p) => acc + (p.sizeUSDT || 0), 0).toFixed(2)
    );
    const unrealizedPnL = parseFloat(
      activePositions.reduce((acc, p) => acc + (p.pnl || 0), 0).toFixed(4)
    );
    const initialEquity = config.paperEquity || 200.0;
    const totalProfit = parseFloat((this.currentEquity - initialEquity).toFixed(2));
    const totalProfitPct = initialEquity > 0 ? parseFloat(((totalProfit / initialEquity) * 100).toFixed(2)) : 0;

    // TradeBot 4 derivative accounting identity:
    // Wallet Balance = Total Equity - Unrealized PnL
    // Free Balance = Wallet Balance - Margin Invested
    // Total Equity = Free Balance + Margin Invested + Unrealized PnL
    const walletBalance = parseFloat((this.currentEquity - unrealizedPnL).toFixed(2));
    const freeBalance = parseFloat((walletBalance - marginInvested).toFixed(2));

    return {
      state: this.state,
      executionMode: config.executionMode,
      config: {
        ...config,
        // Mask API secrets for security
        okxSecretKey: config.okxSecretKey ? '********' : '',
        okxPassphrase: config.okxPassphrase ? '********' : '',
      },
      profileConfig: this.getActiveProfileConfig(),
      profiles: this.getProfiles(),
      equity: this.currentEquity,
      initialEquity,
      walletBalance,
      freeBalance,
      marginInvested,
      unrealizedPnL,
      totalProfit,
      totalProfitPct,
      equityHistory: this.equityHistory,
      sessionRealizedPnL,
      performanceMetrics,
      positions: activePositions,
      orders: this.orderManager.getOrders().slice(0, 1000),
      connected: this.state === 'READY' || this.state === 'TRADING',
      lastSyncTime: this.lastSyncTime,
      scannerStats: this.marketScanner.getStats(),
      marketRegime: this.marketRegime,
      marketSentiment: this.marketSentiment,
      marketSentimentScore: this.marketSentimentScore,
      telegramActive: telegramService.isConfigured(),
      equityTrailingState: this.positionManager.getEquityTrailingState(this.getActiveProfileConfig(), this.currentEquity),
    };
  }

  public getScannerStats(): ScannerStats {
    return this.marketScanner.getStats();
  }

  public async triggerManualScan(): Promise<ScannedOpportunity[]> {
    return this.marketScanner.scan(this.getActiveProfile());
  }

  public async executeManualOrder(
    symbol: string,
    side: 'BUY' | 'SELL',
    requestedQty?: number
  ): Promise<{ success: boolean; error?: string }> {
    const config = this.configStore.get();
    if (config.killSwitchEngaged) {
      return { success: false, error: 'Cannot execute order: Kill Switch is currently engaged.' };
    }

    let price = this.latestPrices[symbol];
    if (!price || price <= 0) {
      try {
        const tickerPrice = await this.activeAdapter.getTickerPrice(symbol);
        if (tickerPrice && tickerPrice > 0) {
          price = tickerPrice;
        }
      } catch (err: any) {
        return { success: false, error: `Failed to fetch live price for ${symbol}` };
      }
    }

    if (!price || price <= 0) {
      return { success: false, error: `Invalid price for ${symbol}` };
    }

    const profile = this.getActiveProfileConfig();
    const activePositions = this.positionManager.getActivePositions();
    if (activePositions.length >= profile.maxOpenPositions) {
      return { success: false, error: `Maximum open positions reached (${profile.maxOpenPositions})` };
    }

    // Determine size in USDT
    let sizeUSDT = (this.currentEquity * (profile.riskPerTradePct || 10)) / 100;
    if (requestedQty && requestedQty > 0) {
      sizeUSDT = requestedQty * price;
    }

    const manualSignal = {
      symbol,
      side,
      score: 90,
      profile: profile.type,
      timestamp: Date.now(),
      reasons: { manual: true, trigger: 'Telegram/Manual command' },
    };

    const riskApproval = {
      approved: true,
      sizeUSDT: parseFloat(sizeUSDT.toFixed(2)),
      reason: 'Manual order override approved',
    };

    const result = await this.orderManager.executeSignalOrder({
      signal: manualSignal,
      riskApproval,
      currentPrice: price,
      profile: profile.type,
      marketRegime: this.marketRegime,
    });

    if (result.success) {
      this.orderStore.save(this.orderManager.getOrders());
      this.positionStore.save(this.positionManager.getActivePositions());
      this.logAudit('ORDER_SUBMITTED', `Manual ${side} order executed for ${symbol} (Size: $${sizeUSDT.toFixed(2)})`);
    }

    return result;
  }

  public async closePositionManually(symbol: string): Promise<{ success: boolean; error?: string }> {
    const pos = this.positionManager.getPosition(symbol);
    if (!pos) {
      return { success: false, error: 'Position not found' };
    }

    const currentPrice = this.latestPrices[symbol] || pos.entryPrice;
    
    this.logAudit('SYSTEM', `Manual close initiated for ${symbol}`);
    
    const result = await this.orderManager.executeCloseOrder({
      position: pos,
      reason: 'MANUAL_CLOSE',
      currentPrice,
      exitReasonDetail: 'Închidere manuală efectuată de Operator din panou',
    });
    
    if (result.success) {
      this.positionStore.save(this.positionManager.getActivePositions());
      this.orderStore.save(this.orderManager.getOrders());
    }
    
    return result;
  }

  public updateProfileSettings(profileType: ProfileType, settings: Partial<ProfileConfig>) {
    const config = this.configStore.get();
    if (!config.profiles) {
      config.profiles = { ...DEFAULT_PROFILES };
    }
    if (!config.profiles[profileType]) {
      config.profiles[profileType] = { ...DEFAULT_PROFILES[profileType] };
    }
    config.profiles[profileType] = {
      ...config.profiles[profileType],
      ...settings,
    };
    this.configStore.save(config);
    if (config.activeProfile === profileType) {
      this.engine.setConfig(this.getActiveProfileConfig());
    }
    this.logAudit('SYSTEM', `Updated profile settings for ${profileType}`, settings);
  }

  public updateScannerFilter(filter: Partial<UniverseFilterConfig>) {
    this.marketScanner.updateFilterConfig(filter);
    const config = this.configStore.get();
    config.scannerFilter = this.marketScanner.getFilterConfig();
    this.configStore.save(config);
  }

  public updateLeverage(leverage: number, marginMode: 'cross' | 'isolated' = 'cross') {
    const config = this.configStore.get();
    config.maxLeverage = leverage;
    this.configStore.save(config);
    this.okxAdapter.setLeverageConfig(leverage, marginMode);
    this.logAudit('SYSTEM', `Leverage configured: ${leverage}x (mode: ${marginMode})`);
  }

  public getAuditLogs(): AuditLog[] {
    return this.auditStore.get();
  }

  public clearAuditLogs(): void {
    this.auditStore.clear();
    this.logAudit('SYSTEM', 'Audit feed cleared by user command.');
  }

  public clearOrders(): void {
    this.orderManager.clearOrders();
    this.orderStore.clear();
    this.logAudit('SYSTEM', 'Order blotter history cleared by user command.');
  }

  public getConfig(): AppConfig {
    return this.configStore.get();
  }

  public getActiveProfile(): ProfileConfig {
    return this.getActiveProfileConfig();
  }

  public getEquity(): number {
    return this.currentEquity;
  }

  public getPositions(): Position[] {
    return this.positionManager.getActivePositions();
  }

  public getOrders(): OrderRecord[] {
    return this.orderManager.getOrders();
  }

  public getState(): BotState {
    return this.state;
  }
}

export const tradeBot = new TradeBot();
tradeBot.start().catch((err) => console.error('[TradeBot] Startup fatal error:', err));
