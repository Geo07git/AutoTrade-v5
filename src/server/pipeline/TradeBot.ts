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
  SymbolRollingStats,
  SymbolStatsSummary,
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
import { SymbolStatsTracker } from '../stats/SymbolStatsTracker';
import { experimentManager, ExperimentState } from '../experiment/ExperimentManager';

const DEFAULT_CONFIG: AppConfig = {
  executionMode: 'PAPER', // Default safe mode: Full simulation without OKX API keys
  activeProfile: 'MOMENTUM',
  testnet: true,
  killSwitchEngaged: false,
  invertSignals: false, // Default: FALSE. Signals strictly follow calculated momentum and HTF macro confluence
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
    riskPerTradePct: 50,
    maxOpenPositions: 2,
    trailingActivationPct: 1.1,
    trailingDistancePct: 0.35,
    breakEvenActivationPct: 5.0,
    takeProfitPct: 20.0,
    hardStopLossPct: 20.0, // Stop-loss hard 20%
    equityProtectionActivationPct: 1.9,
    equityTrailingDrawdownPct: 0.3,
    minMomentumScore: 50,
    maxMomentumScore: 99,
    min24hVolumeUSDT: 1_500_000,
    max24hVolumeUSDT: 0,
    maxHoldingTimeMinutes: 45, // Time-stop maxim unificat la 45 min
    stagnationTimeMinutes: 0, // Time-stop eșalonat la stagnare (0 = dezactivat, folosește strict maxHoldingTimeMinutes)
    stagnationMinPeakPct: 0.5, // Vârf minim de +0.5% cerut la stagnare
    cooldownMinutes: 0,
    sentimentThreshold: 5.0,
    shortRegimeGuard: 'OFF',
    maxEntriesPerSymbolPerHour: 3,
    cooldownAfterLossMinutes: 30,
  },
  MOMENTUM: {
    type: 'MOMENTUM',
    timeframes: ['60', '240'],
    riskPerTradePct: 10,
    maxOpenPositions: 10,
    trailingActivationPct: 1.8,
    trailingDistancePct: 0.5,
    breakEvenActivationPct: 1.0,
    takeProfitPct: 6.0,
    hardStopLossPct: 3.5, // Stop-loss hard 3.5%
    equityProtectionActivationPct: 3.0,
    equityTrailingDrawdownPct: 2.0,
    minMomentumScore: 60,
    maxMomentumScore: 99,
    min24hVolumeUSDT: 1_500_000,
    max24hVolumeUSDT: 0,
    maxHoldingTimeMinutes: 45, // Time-stop maxim unificat la 45 min
    stagnationTimeMinutes: 0, // Time-stop eșalonat la stagnare (0 = dezactivat)
    stagnationMinPeakPct: 0.5, // Vârf minim de +0.5% cerut la stagnare
    cooldownMinutes: 60,
    sentimentThreshold: 2.0,
    shortRegimeGuard: 'OFF',
    maxEntriesPerSymbolPerHour: 3,
    cooldownAfterLossMinutes: 30,
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
  private symbolStatsTracker: SymbolStatsTracker;

  private universeManager: UniverseManager;
  private marketScanner: MarketScanner;

  private state: BotState = 'INITIALIZING';
  private loopInterval?: NodeJS.Timeout;
  private reconnectInterval?: NodeJS.Timeout;
  private positionMonitorInterval?: NodeJS.Timeout;
  private currentEquity: number = 200.0;
  private equityHistory: { time: number; equity: number }[] = [];
  private lastEquitySnapshotTime: number = 0;
  private lastSyncTime: number = 0;
  private latestPrices: Record<string, number> = {};
  private isProcessingTick: boolean = false;
  private isMonitoringRisk: boolean = false;
  private isStoppingExperiment: boolean = false;
  private tickerCache: { at: number; prices: Record<string, number> } = { at: 0, prices: {} };
  private marketRegime: string = 'BTC: --';
  private regimeInterval?: NodeJS.Timeout;
  private marketSentiment: string = 'OKX NEUTRAL (+0.00%)';
  private marketSentimentScore: number = 0;
  private sentimentInterval?: NodeJS.Timeout;

  private getProfiles(): Record<ProfileType, ProfileConfig> {
    const config = this.configStore.get();
    if (config.profiles && Object.keys(config.profiles).length > 0) {
      return config.profiles as Record<ProfileType, ProfileConfig>;
    }
    return DEFAULT_PROFILES;
  }

  private getActiveProfileConfig(): ProfileConfig {
    const config = this.configStore.get();
    const baseProfile = this.getProfiles()[config.activeProfile] || DEFAULT_PROFILES.SCALP;
    const expState = experimentManager.getState();
    if (expState.isActive) {
      return {
        ...baseProfile,
        type: 'SCALP',
        minMomentumScore: expState.minMomentumScore,
        maxHoldingTimeMinutes: expState.maxHoldingTimeMinutes,
        hardStopLossPct: expState.hardStopLossPct,
        breakEvenActivationPct: expState.breakEvenActivationPct,
        trailingActivationPct: expState.trailingActivationPct,
        trailingDistancePct: expState.trailingDistancePct,
        takeProfitPct: expState.takeProfitPct,
        stagnationTimeMinutes: 0,
        maxOpenPositions: 50, // Plafonează pozițiile simultane la 50 în experiment
      };
    }
    return baseProfile;
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
    
    // Ensure invertSignals is false by default to prevent unintentional signal fade
    if (appConfig.invertSignals === undefined) {
      appConfig.invertSignals = false;
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
    const isDemo = appConfig.executionMode !== 'LIVE' && (appConfig.testnet !== false);
    const region = appConfig.okxRegion || 'AUTO';
    this.okxAdapter = new OKXAdapter(
      appConfig.okxApiKey || process.env.OKX_API_KEY || '',
      appConfig.okxSecretKey || process.env.OKX_SECRET_KEY || '',
      appConfig.okxPassphrase || process.env.OKX_PASSPHRASE || '',
      isDemo,
      region
    );
    if (appConfig.maxLeverage) {
      this.okxAdapter.setLeverageConfig(appConfig.maxLeverage, 'cross');
    }
    this.paperAdapter = new PaperExecutionAdapter();

    // Select active adapter based on executionMode (TESTNET or LIVE uses OKXAdapter only if credentials exist)
    const hasCreds = this.okxAdapter.hasCredentials() || this.hasOKXCredentials();
    this.activeAdapter = appConfig.executionMode === 'LIVE' && hasCreds
      ? this.okxAdapter
      : this.paperAdapter;

    this.positionManager = new PositionManager(auditLogger);
    this.positionManager.setCtValResolver((sym) => this.activeAdapter.getCachedCtVal?.(sym) || 1);
    this.orderManager = new OrderManager(
      this.activeAdapter,
      this.positionManager,
      auditLogger,
      appConfig.executionMode
    );
    this.orderManager.setAdapters(this.okxAdapter, this.paperAdapter);

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

    // Instantiate and link SymbolStatsTracker (Rolling 30 trades per symbol)
    this.symbolStatsTracker = new SymbolStatsTracker();
    this.orderManager.setSymbolStatsTracker(this.symbolStatsTracker);
    this.symbolStatsTracker.bootstrapFromOrders(savedOrders);

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
      const config = this.configStore.get();
      // Live trailing stop & stop loss evaluation on real tick
      this.positionManager
        .updatePrices(this.latestPrices, profile, this.orderManager, this.currentEquity, {
          profitVault: config.profitVault || 0,
          baseCapital: config.baseCapital || (config.executionMode === 'PAPER' ? (config.paperEquity || 200.0) : this.currentEquity),
          lockProfitVault: Boolean(config.lockProfitVault),
          onVaultProfitLocked: (lockedAmount, totalVault) => {
            this.handleVaultProfitLocked(lockedAmount, totalVault);
          },
        })
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

  private isStarted = false;

  /**
   * Safe startup sequence
   */
  public async start() {
    if (this.isStarted) return;
    this.isStarted = true;

    const config = this.configStore.get();
    this.logAudit('SYSTEM', `TradeBot 5 starting sequence initiated in [${config.executionMode}] mode...`);
    this.state = 'INITIALIZING';

    await this.connectAndRecover();

    // Start tick loop (runs every 15 seconds for market scanning & new entries)
    if (this.loopInterval) clearInterval(this.loopInterval);
    this.loopInterval = setInterval(() => this.tick(), 15000);
    // Execute first scan immediately after start
    setTimeout(() => this.tick(), 1500);

    // Dedicated high-frequency live price & risk monitor for active positions (evaluates Hard SL / TP / Trailing / EquityProt every 2.5s)
    if (this.positionMonitorInterval) clearInterval(this.positionMonitorInterval);
    this.positionMonitorInterval = setInterval(() => this.evaluateActivePositionsRisk(), 2500);

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

    // Ensure okxAdapter credentials are fresh from config Store
    if (config.executionMode === 'LIVE' && this.activeAdapter === this.okxAdapter) {
      const key = config.okxApiKey || process.env.OKX_API_KEY || '';
      const secret = config.okxSecretKey || process.env.OKX_SECRET_KEY || '';
      const pass = config.okxPassphrase || process.env.OKX_PASSPHRASE || '';
      const isDemo = config.executionMode !== 'LIVE';
      const reg = config.okxRegion || 'AUTO';
      if (key && secret) {
        this.okxAdapter.updateCredentials(key, secret, pass, isDemo, reg);
      }
    }

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
        if (config.executionMode === 'LIVE' && (!config.baseCapital || config.baseCapital === 200.0)) {
          config.baseCapital = parseFloat(realEquity.toFixed(2));
          this.positionManager.resetHighestEquity(config.baseCapital);
          this.configStore.save(config);
        }
      } else if (connTest.equity && connTest.equity > 0) {
        this.currentEquity = connTest.equity;
        if (config.executionMode === 'LIVE' && (!config.baseCapital || config.baseCapital === 200.0)) {
          config.baseCapital = parseFloat(connTest.equity.toFixed(2));
          this.positionManager.resetHighestEquity(config.baseCapital);
          this.configStore.save(config);
        }
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
    if (this.positionMonitorInterval) clearInterval(this.positionMonitorInterval);
    if (this.reconnectInterval) clearInterval(this.reconnectInterval);
    if (this.regimeInterval) clearInterval(this.regimeInterval);
    this.logAudit('SYSTEM', 'TradeBot 5 stopped by operator');
  }

  /**
   * Fast real-time price poll & risk check for all active open positions.
   * Runs every 2.5 seconds independently of the 15-second scanning tick loop,
   * guaranteeing instantaneous execution of Hard Stop-Loss (-3.5%), Trailing-Stop,
   * Take-Profit, Break-Even, and Equity Trailing Protection without waiting for candle close.
   */
  public async evaluateActivePositionsRisk() {
    if (this.state !== 'TRADING') return;
    // setInterval does not wait for the previous run: with 100+ positions a pass can exceed 2.5s, so overlapping
    // runs used to stack up (duplicate fetch storms, racing close attempts, stale-price stop-losses).
    if (this.isMonitoringRisk) return;
    const activePositions = this.positionManager.getActivePositions();
    if (activePositions.length === 0) return;

    this.isMonitoringRisk = true;
    try {
      const config = this.configStore.get();
      const profile = this.getActiveProfileConfig();

      // One batched request for every SWAP ticker instead of one REST call per open position
      // (100 positions => 100 calls / 2.5s, far above OKX public rate limits => silent stale prices => late stops).
      const prices = await this.fetchSwapTickers();
      for (const pos of activePositions) {
        const instId = pos.symbol.includes('-SWAP') ? pos.symbol : `${pos.symbol}-SWAP`;
        const px = prices[instId];
        if (px && px > 0) {
          this.latestPrices[pos.symbol] = px;
        }
      }

      // Sync latest prices with paper adapter
      if (this.paperAdapter && (this.paperAdapter as any).updatePrices) {
        (this.paperAdapter as any).updatePrices(this.latestPrices);
      }

      const initialUnrealizedPnl = activePositions.reduce((acc, p) => acc + (p.pnl || 0), 0);
      const currentWallet = this.activeAdapter.getWalletBalance
        ? await this.activeAdapter.getWalletBalance()
        : parseFloat((this.currentEquity - initialUnrealizedPnl).toFixed(2));

      // Evaluate risk & price excursion on live prices
      await this.positionManager.updatePrices(this.latestPrices, profile, this.orderManager, this.currentEquity, {
        profitVault: config.profitVault || 0,
        baseCapital: config.baseCapital || (config.executionMode === 'PAPER' ? (config.paperEquity || 200.0) : this.currentEquity),
        lockProfitVault: Boolean(config.lockProfitVault),
        marketRegime: this.marketRegime,
        accountEquity: parseFloat(this.currentEquity.toFixed(2)),
        accountBalance: currentWallet,
        onVaultProfitLocked: (lockedAmount, totalVault) => {
          this.handleVaultProfitLocked(lockedAmount, totalVault);
        },
      });

      const updatedActivePositions = this.positionManager.getActivePositions();
      const freshUnrealizedPnl = updatedActivePositions.reduce((acc, p) => acc + (p.pnl || 0), 0);
      const isExpRunning = experimentManager.getState().isActive;
      if (isExpRunning) {
        const expState = experimentManager.getState();
        if (expState.isActive && Date.now() >= expState.startTime + expState.durationMs) {
          await this.stopExperiment('EXPERIMENT_EXPIRED');
        } else {
          this.currentEquity = parseFloat((expState.unlimitedCapital + (expState.totalPnl || 0) + freshUnrealizedPnl).toFixed(2));
        }
      } else if (config.executionMode === 'PAPER') {
        const paperWallet = this.paperAdapter ? await this.paperAdapter.getWalletBalance() : currentWallet;
        this.currentEquity = parseFloat((paperWallet + freshUnrealizedPnl).toFixed(2));
      }

      this.positionStore.save(this.positionManager.getActivePositions());
      this.orderStore.save(this.orderManager.getOrders());
    } catch (err: any) {
      // transient price update error ignored
    } finally {
      this.isMonitoringRisk = false;
    }
  }

  /**
   * Fetches all OKX SWAP tickers in a single request (cached for 1s) and returns instId -> last price.
   */
  private async fetchSwapTickers(): Promise<Record<string, number>> {
    const now = Date.now();
    if (now - this.tickerCache.at < 1000) {
      return this.tickerCache.prices;
    }
    try {
      const res = await fetch('https://eea.okx.com/api/v5/market/tickers?instType=SWAP', {
        signal: AbortSignal.timeout(4000),
      });
      const data: any = await res.json();
      if (data?.code === '0' && Array.isArray(data.data)) {
        const prices: Record<string, number> = {};
        for (const t of data.data) {
          const px = parseFloat(t.last || '0');
          if (t.instId && px > 0) prices[t.instId] = px;
        }
        this.tickerCache = { at: now, prices };
        return prices;
      }
    } catch {
      // fall through: keep the previous snapshot rather than evaluating on nothing
    }
    return this.tickerCache.prices;
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
      // PAPER mode: positions live in the local paper store, so reconciling it against itself adds no information
      // and only creates a race with the risk monitor (ghost positions re-imported seconds after a close).
      // It still runs once at startup (connectAndRecover) to rehydrate after a crash.
      if (config.executionMode !== 'PAPER' && now - this.lastSyncTime > 60000 && this.state !== 'WAITING_FOR_EXCHANGE') {
        try {
          const seqBefore = this.positionManager.getMutationSeq();
          const exchangePositions = await this.activeAdapter.getOpenPositions();
          // Only apply the snapshot if nothing changed locally while it was in flight and no close/pass is running;
          // otherwise discard it and retry on the next tick instead of "correcting" state with stale data.
          if (this.positionManager.getMutationSeq() === seqBefore && !this.positionManager.hasInFlightOperations()) {
            this.positionManager.reconcileWithExchange(exchangePositions, config.activeProfile, {
              isSymbolBusy: (sym) => this.orderManager.hasPendingOrderForSymbol(sym),
            });
            this.positionStore.save(this.positionManager.getActivePositions());
            this.lastSyncTime = now;
          }
        } catch (err: any) {
          // Log warning but do NOT halt trading or enter WAITING_FOR_EXCHANGE
          console.warn('[TradeBot] Periodic reconciliation warning (non-fatal):', err?.message || err);
          this.logAudit('SYSTEM', `Periodic reconciliation notice: ${err.message || err}. Continuing normal scan & execution loop.`);
        }
      }

      const profile = this.getActiveProfileConfig();
      this.engine.setConfig(profile); // Force update engine config

      // 3. Dynamic Universe & Market Scanning (ALWAYS RUNS AUTOMATICALLY)
      // This guarantees the market scanner continuously runs every 15s to update opportunities,
      // candidate momentum scores, RVOL, and real-time feeds even if entries are paused.
      const scannedOpportunities = await this.marketScanner.scan(profile, Boolean(config.invertSignals));

      // Update latest prices for all scanned pairs
      for (const opp of scannedOpportunities) {
        if (opp.price > 0) {
          this.latestPrices[opp.symbol] = opp.price;
        }
      }

      // 4. Update prices and evaluate exit conditions (Trailing / Stop-loss / Time-stop) for existing open positions
      const activePositionsBeforeExits = this.positionManager.getActivePositions();
      const currentUnrealizedPnl = activePositionsBeforeExits.reduce((acc, p) => acc + (p.pnl || 0), 0);
      const currentWallet = this.activeAdapter.getWalletBalance
        ? await this.activeAdapter.getWalletBalance()
        : parseFloat((this.currentEquity - currentUnrealizedPnl).toFixed(2));

      await this.positionManager.updatePrices(this.latestPrices, profile, this.orderManager, this.currentEquity, {
        profitVault: config.profitVault || 0,
        baseCapital: config.baseCapital || (config.executionMode === 'PAPER' ? (config.paperEquity || 200.0) : this.currentEquity),
        lockProfitVault: Boolean(config.lockProfitVault),
        marketRegime: this.marketRegime,
        accountEquity: parseFloat(this.currentEquity.toFixed(2)),
        accountBalance: currentWallet,
        onVaultProfitLocked: (lockedAmount, totalVault) => {
          this.handleVaultProfitLocked(lockedAmount, totalVault);
        },
      });

      this.positionStore.save(this.positionManager.getActivePositions());
      this.orderStore.save(this.orderManager.getOrders());

      // 5. STRICT ENTRY GUARDS: If experiment is stopping, Kill Switch is engaged, or state is not TRADING, halt before new entries
      if (this.isStoppingExperiment) {
        return;
      }

      if (config.killSwitchEngaged) {
        return;
      }

      if (this.state !== 'TRADING') {
        return;
      }

      const expState = experimentManager.getState();
      const isExpActive = expState.isActive;
      // Filter eligible candidates meeting momentum score window [min, max] and 24h volume window [min, max], sorted by score descending
      const eligibleCandidates = scannedOpportunities.filter((opp) => {
        if (isExpActive) {
          const minScore = expState.minMomentumScore || 50;
          return opp.score >= minScore && opp.score <= 100;
        }
        if (!opp.isEligible && !(opp.score >= (profile.minMomentumScore || 50) && (profile.maxMomentumScore ? opp.score <= profile.maxMomentumScore : true))) return false;
        if (profile.minMomentumScore && opp.score < profile.minMomentumScore) return false;
        if (profile.maxMomentumScore && profile.maxMomentumScore < 100 && opp.score > profile.maxMomentumScore) return false;
        const effMinVol = (config.scannerFilter?.min24hVolumeUSDT && config.scannerFilter.min24hVolumeUSDT > 0)
          ? config.scannerFilter.min24hVolumeUSDT
          : (profile.min24hVolumeUSDT || 0);
        const effMaxVol = (config.scannerFilter?.max24hVolumeUSDT && config.scannerFilter.max24hVolumeUSDT > 0)
          ? config.scannerFilter.max24hVolumeUSDT
          : (profile.max24hVolumeUSDT || 0);
        if (effMinVol > 0 && opp.volume24hUSDT < effMinVol) return false;
        if (effMaxVol > 0 && opp.volume24hUSDT > effMaxVol) return false;
        return true;
      });

      for (const candidate of eligibleCandidates) {
        if (this.isStoppingExperiment) break; // never open positions while the experiment is being closed out
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

        // STRICT CHECK 4: Affordability check in LIVE mode (ensures 1 contract notional fits within available equity)
        if (config.executionMode === 'LIVE' && !isExpActive) {
          const ctVal = this.okxAdapter.getCachedCtVal(symbol);
          const minNotional = (candidate.price || 1) * ctVal;
          const leverage = Math.max(1, parseFloat(String(config.maxLeverage || '1').replace(/[^0-9.]/g, '')) || 1);
          const requiredMarginForOneContract = minNotional / leverage;
          if (this.currentEquity > 0 && requiredMarginForOneContract > this.currentEquity * 1.05) {
            this.logAudit(
              'CANDIDATE_REJECTED',
              `Candidatul #${candidate.rank} (${symbol}) omis: 1 contract necesită o marjă minimă de $${requiredMarginForOneContract.toFixed(2)} (ctVal: ${ctVal}), depășind capitalul disponibil ($${this.currentEquity.toFixed(2)}). Se evaluează automat următorul candidat.`,
              {
                symbol,
                requiredMargin: requiredMarginForOneContract,
                currentEquity: this.currentEquity,
                ctVal,
                price: candidate.price,
              }
            );
            continue;
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
          
          signal = this.engine.evaluate(
            symbol,
            {
              [profile.timeframes[0]]: ltfKlines,
              ...(profile.timeframes[1] ? { [profile.timeframes[1]]: htfKlines } : {}),
            },
            undefined,
            { invertExtremeSignals: Boolean(config.invertSignals) }
          );
        }

        // Direct signal creation for high momentum candidates in experiment or active scan
        if (!signal && (isExpActive || candidate.score >= (profile.minMomentumScore || 50))) {
          const atrPct = candidate.price > 0 && candidate.currentAtr ? (candidate.currentAtr / candidate.price) * 100 : 1.0;
          signal = {
            symbol,
            side: candidate.side === 'SELL' ? 'SELL' : 'BUY',
            originalSide: candidate.side === 'SELL' ? 'SELL' : 'BUY',
            isFadeTrade: false,
            score: candidate.score,
            profile: config.activeProfile,
            timestamp: Date.now(),
            currentPrice: candidate.price,
            currentAtr: candidate.currentAtr || (candidate.price * 0.01),
            atrPct: parseFloat(atrPct.toFixed(2)),
            reasons: {
              score: candidate.score,
              threshold: isExpActive ? (expState.minMomentumScore || 50) : (profile.minMomentumScore || 50),
              side: candidate.side === 'SELL' ? 'SELL' : 'BUY',
              rvol: candidate.rvol,
              atrExpansion: candidate.atrExpansion,
            },
          };
        }

        if (signal) {
          // Ensure real-time price & ATR are attached to signal for Volatility Risk Sizing
          signal.currentPrice = signal.currentPrice || candidate.price;
          signal.currentAtr = signal.currentAtr || candidate.currentAtr;
          signal.atrPct = signal.atrPct || candidate.atrPct;
          signal.isFadeTrade = candidate.isFadeTrade || signal.isFadeTrade;
          signal.originalSide = candidate.originalSide || signal.originalSide || signal.side;

          const signalMessage = signal.isFadeTrade
            ? `[FADE CLIMAX] Momentum Climax ${signal.originalSide} (Scor: ${signal.score.toFixed(1)}/100) ➡️ INVERSAT în ${signal.side} (${signal.side === 'BUY' ? 'LONG' : 'SHORT'}) pe ${symbol} (Sub-strategie Fade Extrem, Rank #${candidate.rank}, ATR: ${signal.atrPct ?? '--'}%)`
            : `Momentum Engine confirmed ${signal.side} signal on candidate ${symbol} (Score: ${signal.score.toFixed(1)}/100, Rank #${candidate.rank}, ATR: ${signal.atrPct ?? '--'}%)`;

          this.logAudit(
            'SIGNAL_GENERATED',
            signalMessage,
            {
              symbol,
              originalSide: signal.originalSide || signal.side,
              side: signal.side,
              isFadeTrade: Boolean(signal.isFadeTrade),
              score: signal.score,
              profile: config.activeProfile,
              rank: candidate.rank,
              currentPrice: signal.currentPrice,
              currentAtr: signal.currentAtr,
              atrPct: signal.atrPct,
            }
          );

          // Risk Engine: Mandatory gatekeeper validation with volatility-based sizing (ATR) & pending order check
          const hasPending = this.orderManager.hasPendingOrderForSymbol(symbol);
          const profitVault = isExpActive ? 0 : (config.profitVault || 0);
          const operatingEquity = isExpActive ? 10_000 : Math.max(10, this.currentEquity - profitVault);

          const entriesLastHour = this.positionManager.getEntriesCountLastHour(symbol);
          const lastClosed = this.positionManager.getLastClosedPosition(symbol);
          const lastClosedTradeWasLoss = lastClosed ? (lastClosed.pnl !== undefined && lastClosed.pnl < 0) || (lastClosed.exitReason === 'STOP_LOSS') : false;
          const lastClosedTradeTime = lastClosed ? lastClosed.exitTime : undefined;

          const riskApproval = this.riskEngine.validateSignal(
            signal,
            profile,
            this.positionManager.getActivePositions(),
            isExpActive ? 10_000 : this.currentEquity,
            isExpActive ? false : config.killSwitchEngaged,
            hasPending,
            {
              operatingEquity,
              profitVault,
              marketRegime: this.marketRegime,
              excludedSymbols: config.scannerFilter?.excludedSymbols || ['CAP', 'ONDO', 'NIGHT', 'ARX', 'GPS', 'ZAMA'],
              entriesLastHour,
              lastClosedTradeWasLoss,
              lastClosedTradeTime,
            }
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

          const currentPositions = this.positionManager.getActivePositions();
          const unrealizedPnlTotal = currentPositions.reduce((acc, p) => acc + (p.pnl || 0), 0);
          const currentWalletBalance = this.activeAdapter.getWalletBalance
            ? await this.activeAdapter.getWalletBalance()
            : parseFloat((this.currentEquity - unrealizedPnlTotal).toFixed(2));

          // Feedback Multiplier based on rolling MFE >= 1.5% Hit-rate
          if (this.symbolStatsTracker.isMultiplierActive()) {
            const symMult = this.symbolStatsTracker.getSizeMultiplier(symbol);
            if (symMult !== 1.0) {
              const prevSize = riskApproval.sizeUSDT;
              riskApproval.sizeUSDT = parseFloat(Math.max(5, prevSize * symMult).toFixed(2));
              this.logAudit('SIGNAL_GENERATED', `[SYMBOL ROLLING MULTIPLIER] Dinamic Sizing pentru ${symbol}: $${prevSize} ➔ $${riskApproval.sizeUSDT} (${symMult}x pe baza MFE ≥ 1.5% Hit-rate)`, {
                symbol,
                originalSize: prevSize,
                adjustedSize: riskApproval.sizeUSDT,
                multiplier: symMult,
              });
            }
          }

          // Order Manager: Execute via active Execution Adapter (PAPER or TESTNET)
          const executionResult = await this.orderManager.executeSignalOrder({
            signal,
            riskApproval,
            currentPrice: signal.currentPrice || candidate.price,
            profile: config.activeProfile,
            marketRegime: this.marketRegime,
            accountEquity: parseFloat(this.currentEquity.toFixed(2)),
            accountBalance: currentWalletBalance,
            openPositionsCount: currentPositions.length,
            leverage: (config.maxLeverage || 1).toString() + 'x',
          });

          if (executionResult.success) {
            // Persist order & position state
            this.orderStore.save(this.orderManager.getOrders());
            this.positionStore.save(this.positionManager.getActivePositions());
          }
        }
      }
    } catch (err: any) {
      console.error('[TradeBot] Tick execution error:', err);
      this.logAudit('ERROR', `Error in trading cycle: ${err.message || err}`);
    } finally {
      this.isProcessingTick = false;
    }
  }

  /**
   * Set execution mode: PAPER | LIVE
   */
  public async setExecutionMode(mode: ExecutionMode): Promise<{ success: boolean; error?: string }> {
    const activePositions = this.positionManager.getActivePositions();
    if (activePositions.length > 0) {
      const err = `Nu se poate comuta modul de execuție în ${mode} cât timp există ${activePositions.length} poziție(i) deschise. Închide mai întâi toate pozițiile active.`;
      this.logAudit('SYSTEM', `Mode switch rejected: ${err}`, { activePositionsCount: activePositions.length });
      return { success: false, error: err };
    }

    const config = this.configStore.get();

    // Verify credentials if switching to LIVE
    if (mode === 'LIVE') {
      const hasCreds = this.hasOKXCredentials();
      if (!hasCreds) {
        const err = `Cheile API OKX (API Key, Secret Key, Passphrase) lipsesc. Configurează-le mai întâi în panoul de Conexiune OKX sau în variabilele de mediu.`;
        this.logAudit('SYSTEM', `Mode switch rejected: ${err}`);
        return { success: false, error: err };
      }
    }

    if (config.executionMode === mode && (mode === 'LIVE' || mode === 'PAPER')) {
      return { success: true };
    }

    // Close previous adapter sockets if any
    if (this.activeAdapter.close) {
      this.activeAdapter.close();
    }

    config.executionMode = mode;
    config.testnet = false;
    config.killSwitchEngaged = false;
    this.configStore.save(config);

    // Switch active execution adapter
    if (mode === 'LIVE') {
      const key = config.okxApiKey || process.env.OKX_API_KEY || '';
      const secret = config.okxSecretKey || process.env.OKX_SECRET_KEY || '';
      const pass = config.okxPassphrase || process.env.OKX_PASSPHRASE || '';
      this.okxAdapter.updateCredentials(key, secret, pass, false);
      if (this.okxAdapter.hasCredentials()) {
        this.activeAdapter = this.okxAdapter;
      } else {
        this.activeAdapter = this.paperAdapter;
      }
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
      `Modul de execuție a fost comutat la [${mode}] (${mode === 'LIVE' ? 'OKX Real Trading' : 'Simulare Locală Paper'}). Reconectare motor...`
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

    config.profitVault = 0;
    config.baseCapital = 200.0;
    this.configStore.save(config);

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

    this.logAudit('PAPER_RESET', 'Paper account reset: Balance restored to $200.00 USDT, positions cleared, Profit Vault reset to $0.00.');
    return { success: true };
  }

  /**
   * Called whenever Equity Protection secures profit in a cycle while lockProfitVault is active.
   */
  private handleVaultProfitLocked(lockedAmount: number, totalVault: number) {
    const config = this.configStore.get();
    config.profitVault = parseFloat(totalVault.toFixed(2));
    this.configStore.save(config);

    this.logAudit(
      'PROFIT_VAULT_DEPOSIT',
      `[PROFIT VAULT] S-au pus deoparte +$${lockedAmount.toFixed(2)} USDT în Seif! Total acumulat în Seif: $${config.profitVault.toFixed(2)} USDT. Tranzacționarea se reia strict cu capitalul de bază ($${(config.baseCapital || 200).toFixed(2)} USDT).`,
      {
        cycleProfit: lockedAmount,
        totalVault: config.profitVault,
        baseCapital: config.baseCapital,
      }
    );

    if (config.telegramAlertsEnabled && telegramService.isConfigured()) {
      telegramService.sendMessage(
        `🏦 *PROFIT VAULT: BANI PUȘI DEOPARTE!*\n\n` +
        `• *Profit ciclu salvat:* +$${lockedAmount.toFixed(2)} USDT\n` +
        `• *Total în Seif:* $${config.profitVault.toFixed(2)} USDT\n` +
        `• *Baza de lucru neschimbată:* $${(config.baseCapital || 200).toFixed(2)} USDT\n` +
        `Noul ciclu tranzacționează fără a risca profitul securizat!`
      ).catch(() => {});
    }
  }

  /**
   * Operator manually locks current excess profit into the vault
   */
  public lockProfitVaultNow(): { success: boolean; profitLocked: number; totalVault: number; error?: string } {
    const config = this.configStore.get();
    const base = config.baseCapital || (config.executionMode === 'PAPER' ? (config.paperEquity || 200.0) : this.currentEquity);
    const existingVault = config.profitVault || 0;
    const excess = parseFloat((this.currentEquity - base - existingVault).toFixed(2));

    if (excess <= 0) {
      return {
        success: false,
        profitLocked: 0,
        totalVault: existingVault,
        error: `Nu există profit suplimentar de pus în seif (Capital curent: $${this.currentEquity.toFixed(2)}, Bază: $${base.toFixed(2)}, Seif: $${existingVault.toFixed(2)}).`,
      };
    }

    config.profitVault = parseFloat((existingVault + excess).toFixed(2));
    config.baseCapital = base;
    this.configStore.save(config);

    this.logAudit(
      'PROFIT_VAULT_DEPOSIT',
      `[PROFIT VAULT MANUAL] Operatorul a depus manual +$${excess.toFixed(2)} USDT în Seif. Total în Seif: $${config.profitVault.toFixed(2)} USDT. Baza de lucru: $${base.toFixed(2)} USDT.`,
      { profitLocked: excess, totalVault: config.profitVault, baseCapital: base }
    );

    return {
      success: true,
      profitLocked: excess,
      totalVault: config.profitVault,
    };
  }

  /**
   * Toggle Profit Vault Mode (Fixed base capital without compounding profits)
   */
  public toggleLockProfitVault(enabled?: boolean): boolean {
    const config = this.configStore.get();
    config.lockProfitVault = typeof enabled === 'boolean' ? enabled : !config.lockProfitVault;
    if (config.lockProfitVault && (!config.baseCapital || config.baseCapital <= 0)) {
      config.baseCapital = config.executionMode === 'PAPER'
        ? (config.paperEquity || 200.0)
        : parseFloat((this.currentEquity - (config.profitVault || 0)).toFixed(2));
    }
    this.configStore.save(config);
    this.logAudit(
      'CONFIG_UPDATED',
      `[PROFIT VAULT] Modul Profit Vault a fost ${config.lockProfitVault ? 'ACTIVAT' : 'DEZACTIVAT'}. Baza fixă: $${(config.baseCapital || 200).toFixed(2)} USDT | Seif curent: $${(config.profitVault || 0).toFixed(2)} USDT.`,
      { lockProfitVault: config.lockProfitVault, baseCapital: config.baseCapital, profitVault: config.profitVault }
    );
    return config.lockProfitVault;
  }

  /**
   * Set custom operating base capital
   */
  public setBaseCapital(amount: number): { success: boolean; baseCapital: number; error?: string } {
    if (amount <= 0 || isNaN(amount)) {
      return { success: false, baseCapital: 0, error: 'Valoarea bazei de lucru trebuie să fie mai mare ca 0.' };
    }
    const config = this.configStore.get();
    config.baseCapital = parseFloat(amount.toFixed(2));
    this.configStore.save(config);
    this.positionManager.resetHighestEquity(config.baseCapital);
    this.logAudit(
      'CONFIG_UPDATED',
      `[PROFIT VAULT] Baza de lucru fixă a fost setată la $${config.baseCapital.toFixed(2)} USDT.`,
      { baseCapital: config.baseCapital }
    );
    return { success: true, baseCapital: config.baseCapital };
  }

  /**
   * Reset the vault and unlock profits back into active operating capital
   */
  public resetProfitVault(): { success: boolean } {
    const config = this.configStore.get();
    const oldVault = config.profitVault || 0;
    config.profitVault = 0;
    config.baseCapital = parseFloat(this.currentEquity.toFixed(2));
    this.configStore.save(config);
    this.positionManager.resetHighestEquity(this.currentEquity);
    this.logAudit(
      'PROFIT_VAULT_RESET',
      `[PROFIT VAULT RESET] Seiful a fost resetat ($${oldVault.toFixed(2)} reintroduși în capitalul activ). Noua bază: $${config.baseCapital.toFixed(2)} USDT.`,
      { oldVault, newBase: config.baseCapital }
    );
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

  public async setKillSwitch(engaged: boolean): Promise<boolean> {
    const config = this.configStore.get();
    if (config.killSwitchEngaged === engaged) {
      return config.killSwitchEngaged;
    }
    return this.toggleKillSwitch();
  }

  /**
   * Update OKX API credentials
   */
  public async updateCredentials(apiKey: string, secretKey: string, passphrase: string, testnet: boolean = true, region: 'EEA' | 'GLOBAL' | 'AUTO' = 'AUTO') {
    const config = this.configStore.get();
    config.okxApiKey = apiKey.trim();
    config.okxSecretKey = secretKey.trim();
    config.okxPassphrase = passphrase.trim();
    config.testnet = testnet;
    config.okxRegion = region;
    this.configStore.save();

    const isDemo = config.executionMode === 'LIVE' ? false : testnet;
    this.okxAdapter.updateCredentials(apiKey, secretKey, passphrase, isDemo, region);
    this.logAudit('SYSTEM', `Chei API OKX actualizate cu succes (Regiune: ${region}, Mod rețea: ${testnet ? 'OKX Demo / Simulated Trading' : 'OKX Live / Real Trading'}).`);

    if (config.executionMode === 'LIVE') {
      await this.connectAndRecover();
    }
  }

  public hasOKXCredentials(): boolean {
    const config = this.configStore.get();
    const hasInConfig = Boolean(config.okxApiKey && config.okxSecretKey && config.okxPassphrase);
    const hasInEnv = Boolean(process.env.OKX_API_KEY && process.env.OKX_SECRET_KEY && process.env.OKX_PASSPHRASE);
    return hasInConfig || hasInEnv;
  }

  public async testOKXConnection(creds?: { apiKey?: string; secretKey?: string; passphrase?: string; isDemo?: boolean; region?: 'EEA' | 'GLOBAL' | 'AUTO' }) {
    const config = this.configStore.get();
    const isMaskedKey = creds?.apiKey && (creds.apiKey.includes('...') || creds.apiKey.includes('***'));
    const isMaskedSecret = creds?.secretKey && creds.secretKey.includes('***');

    if (creds && creds.apiKey && creds.secretKey && !isMaskedKey && !isMaskedSecret) {
      const tempAdapter = new OKXAdapter(
        creds.apiKey.trim(),
        creds.secretKey.trim(),
        creds.passphrase?.trim() || '',
        creds.isDemo !== undefined ? creds.isDemo : (config.executionMode !== 'LIVE' && config.testnet !== false),
        creds.region || config.okxRegion || 'AUTO'
      );
      return await tempAdapter.testConnection();
    }

    // Otherwise test using currently saved adapter credentials
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
      totalGrossProfit: parseFloat(totalGrossProfit.toFixed(2)),
      totalGrossLoss: parseFloat(totalGrossLoss.toFixed(2)),
    };
    const marginInvested = parseFloat(
      activePositions.reduce((acc, p) => acc + (p.sizeUSDT || 0), 0).toFixed(2)
    );
    const unrealizedPnL = parseFloat(
      activePositions.reduce((acc, p) => acc + (p.pnl || 0), 0).toFixed(4)
    );
    const expState = experimentManager.getState();
    const isExpActive = expState.isActive;

    let initialEquity = isExpActive
      ? expState.unlimitedCapital
      : (config.executionMode === 'PAPER'
          ? (config.paperEquity || 200.0)
          : (config.baseCapital || this.currentEquity || 200.0));

    // TradeBot 4 derivative accounting identity:
    // Wallet Balance = Cash balance (total collateral deposited + realized PnL - trading fees)
    // Free Balance = Wallet Balance - Margin Invested
    // Total Equity = Wallet Balance + Unrealized PnL
    let walletBalance: number;
    let effectiveEquity: number;

    if (isExpActive) {
      initialEquity = expState.unlimitedCapital;
      walletBalance = expState.unlimitedCapital + (expState.totalPnl || 0);
      effectiveEquity = parseFloat((walletBalance + unrealizedPnL).toFixed(2));
      this.currentEquity = effectiveEquity;
    } else if (config.executionMode === 'PAPER') {
      const paperRaw = (this.paperAdapter as any)?.paperStore?.get();
      walletBalance = parseFloat((paperRaw?.balanceUSDT !== undefined ? paperRaw.balanceUSDT : (this.currentEquity - unrealizedPnL)).toFixed(2));
      effectiveEquity = parseFloat((walletBalance + unrealizedPnL).toFixed(2));
      this.currentEquity = effectiveEquity;
    } else {
      // LIVE or TESTNET
      effectiveEquity = this.currentEquity;
      walletBalance = parseFloat((effectiveEquity - unrealizedPnL).toFixed(2));
      if (!config.baseCapital && this.currentEquity > 0) {
        config.baseCapital = parseFloat(this.currentEquity.toFixed(2));
      }
      initialEquity = config.baseCapital || this.currentEquity;
    }

    const freeBalance = parseFloat((walletBalance - marginInvested).toFixed(2));
    const profitVault = parseFloat((config.profitVault || 0).toFixed(2));
    const baseCapital = isExpActive
      ? expState.unlimitedCapital
      : parseFloat((config.baseCapital || (config.executionMode === 'PAPER' ? (config.paperEquity || 200.0) : this.currentEquity)).toFixed(2));
    const operatingEquity = isExpActive
      ? effectiveEquity
      : Math.max(10, parseFloat((effectiveEquity - profitVault).toFixed(2)));
    const usableFreeBalance = isExpActive
      ? freeBalance
      : Math.max(0, parseFloat((freeBalance - profitVault).toFixed(2)));

    const totalProfit = isExpActive
      ? parseFloat(((expState.totalPnl || 0) + unrealizedPnL).toFixed(2))
      : parseFloat((this.currentEquity - initialEquity).toFixed(2));
    const totalProfitPct = isExpActive
      ? parseFloat((((expState.totalPnl || 0) + unrealizedPnL)).toFixed(2))
      : (initialEquity > 0 ? parseFloat(((totalProfit / initialEquity) * 100).toFixed(2)) : 0);

    return {
      state: this.state,
      executionMode: config.executionMode,
      config: {
        ...config,
        // Mask API secrets for security
        okxApiKey: config.okxApiKey ? `${config.okxApiKey.slice(0, 4)}...${config.okxApiKey.slice(-4)}` : '',
        okxSecretKey: config.okxSecretKey ? '********' : '',
        okxPassphrase: config.okxPassphrase ? '********' : '',
        telegramBotToken: config.telegramBotToken ? '********' : '',
      },
      profileConfig: this.getActiveProfileConfig(),
      profiles: this.getProfiles(),
      equity: this.currentEquity,
      operatingEquity,
      profitVault,
      baseCapital,
      usableFreeBalance,
      lockProfitVault: Boolean(config.lockProfitVault),
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
      telegramActive: telegramService.isConfigured() && telegramService.isNotificationsEnabled(),
      telegramStatus: telegramService.getCredentialsStatus(),
      equityTrailingState: this.positionManager.getEquityTrailingState(this.getActiveProfileConfig(), this.currentEquity, profitVault),
      isExperimentActive: isExpActive,
      experimentState: expState,
    };
  }

  public getScannerStats(): ScannerStats {
    return this.marketScanner.getStats();
  }

  public async triggerManualScan(): Promise<ScannedOpportunity[]> {
    return this.marketScanner.scan(this.getActiveProfile(), Boolean(this.configStore.get().invertSignals));
  }

  public setInvertSignals(invert: boolean): boolean {
    const config = this.configStore.get();
    config.invertSignals = invert;
    this.configStore.save(config);
    this.logAudit(
      'CONFIG_UPDATED',
      `[EXPERIMENT] Inversare Semnale (LONG ⇄ SHORT) a fost ${invert ? 'ACTIVATĂ 🧪' : 'DEZACTIVATĂ (Mod Normal) 🛡️'}.`,
      { invertSignals: invert }
    );
    return invert;
  }

  public getEquityProtectionEvents() {
    return this.positionManager.getEquityProtectionEvents();
  }

  public clearEquityProtectionEvents() {
    this.positionManager.clearEquityProtectionEvents();
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
    const riskPct = profile.riskPerTradePct || 50;
    const maxTradesByRisk = Math.max(1, Math.floor(100 / riskPct));
    const effectiveMaxOpenPositions = Math.min(profile.maxOpenPositions, maxTradesByRisk);

    if (activePositions.length >= effectiveMaxOpenPositions) {
      return { success: false, error: `Maximum open positions reached for risk setting ${riskPct}% (${activePositions.length}/${effectiveMaxOpenPositions} allowed; max trades by risk: ${maxTradesByRisk})` };
    }

    // Determine size in USDT using net capital (-10% reserve margin) divided by risk/trade pct
    const netCapital = Math.max(10, this.currentEquity * 0.90);
    let sizeUSDT = netCapital * (riskPct / 100);
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
    
    const activePositions = this.positionManager.getActivePositions();
    const unrealizedPnlTotal = activePositions.reduce((acc, p) => acc + (p.pnl || 0), 0);
    const currentWalletBalance = parseFloat((this.currentEquity - unrealizedPnlTotal).toFixed(2));

    const result = await this.orderManager.executeCloseOrder({
      position: pos,
      reason: 'MANUAL_CLOSE',
      currentPrice,
      exitReasonDetail: 'Închidere manuală efectuată de Operator din panou',
      exitMarketRegime: this.marketRegime,
      accountEquity: parseFloat(this.currentEquity.toFixed(2)),
      accountBalance: currentWalletBalance,
      openPositionsCount: activePositions.length,
    });
    
    if (result.success) {
      this.positionStore.save(this.positionManager.getActivePositions());
      this.orderStore.save(this.orderManager.getOrders());
    }
    
    return result;
  }

  public async stopExperiment(reason: string = 'MANUAL_STOP'): Promise<ExperimentState> {
    const expState = experimentManager.getState();
    const exitReasonDetail = reason === 'EXPERIMENT_EXPIRED'
      ? `Închidere automată la expirarea duratei experimentului (${expState.durationHours}h)`
      : `Închidere automată la oprirea manuală a experimentului (${expState.durationHours}h)`;

    const openAtStop = this.positionManager.getActivePositions().length;

    // Block new entries first: positions opened while this loop ran were never closed or booked
    // (the experiment ledger showed 253 entries vs 249 exits).
    this.isStoppingExperiment = true;
    try {
      // Close in parallel batches (each close is an independent reduce-only order), then sweep for stragglers.
      const BATCH = 8;
      for (let pass = 0; pass < 3; pass++) {
        const open = this.positionManager.getActivePositions().filter((p) => p.status === 'OPEN');
        if (open.length === 0) break;
        for (let i = 0; i < open.length; i += BATCH) {
          const slice = open.slice(i, i + BATCH);
          await Promise.all(slice.map(async (pos) => {
            try {
              const currentPrice = this.latestPrices[pos.symbol] || pos.currentPrice || pos.entryPrice;
              const activeCount = this.positionManager.getActivePositions().length;
              const unrealizedPnlTotal = this.positionManager.getActivePositions().reduce((acc, p) => acc + (p.pnl || 0), 0);
              const currentWalletBalance = parseFloat((this.currentEquity - unrealizedPnlTotal).toFixed(2));

              await this.orderManager.executeCloseOrder({
                position: pos,
                reason: 'EXPERIMENT_END',
                currentPrice,
                exitReasonDetail,
                exitMarketRegime: this.marketRegime,
                accountEquity: parseFloat(this.currentEquity.toFixed(2)),
                accountBalance: currentWalletBalance,
                openPositionsCount: activeCount,
              });
            } catch (err: any) {
              console.error(`[TradeBot] Failed to close position ${pos.symbol} on experiment stop:`, err);
            }
          }));
        }
      }
    } finally {
      this.isStoppingExperiment = false;
    }

    const state = experimentManager.stopExperiment();
    this.updateProfileSettings('SCALP', { maxOpenPositions: 5 });
    // The equity peak was inflated by the synthetic $10,000 experiment fund; reset the Equity Protection baseline to the
    // real account so the first post-experiment position is not instantly "stopped out" by a fake 100% drawdown.
    try {
      const cfg = this.configStore.get();
      const realEquity = cfg.executionMode === 'PAPER'
        ? await this.paperAdapter.getEquity()
        : await this.activeAdapter.getEquity();
      if (realEquity > 0) {
        this.currentEquity = realEquity;
        this.positionManager.resetHighestEquity(cfg.baseCapital || realEquity);
      }
    } catch {
      // baseline reset is best-effort
    }
    this.positionStore.save(this.positionManager.getActivePositions());
    this.orderStore.save(this.orderManager.getOrders());
    this.logAudit(
      'EXPERIMENT',
      `Experimentul de ${state.durationHours}h a fost oprit (${reason}). S-au închis și contabilizat ${openAtStop - this.positionManager.getActivePositions().length}/${openAtStop} poziții active. PnL Total: $${state.totalPnl.toFixed(4)}`,
      { totalEntries: state.totalEntries, totalExits: state.totalExits, totalPnl: state.totalPnl }
    );
    return state;
  }

  public updateProfileSettings(profileType: ProfileType, settings: Partial<ProfileConfig>) {
    const config = this.configStore.get();
    if (!config.profiles) {
      config.profiles = { ...DEFAULT_PROFILES };
    }
    if (!config.profiles[profileType]) {
      config.profiles[profileType] = { ...DEFAULT_PROFILES[profileType] };
    }

    // Sanitize minMomentumScore within configured bounds [50, 100]
    if (settings.minMomentumScore !== undefined) {
      settings.minMomentumScore = Math.min(100, Math.max(50, Number(settings.minMomentumScore) || 50));
    }
    // Sanitize maxMomentumScore within bounds [50, 100]
    if (settings.maxMomentumScore !== undefined) {
      settings.maxMomentumScore = Math.min(100, Math.max(50, Number(settings.maxMomentumScore) || 99));
    }
    // Sanitize 24h volume turnover limits
    if (settings.min24hVolumeUSDT !== undefined) {
      settings.min24hVolumeUSDT = Math.max(50_000, Number(settings.min24hVolumeUSDT) || 500_000);
    }
    if (settings.max24hVolumeUSDT !== undefined) {
      settings.max24hVolumeUSDT = Math.max(0, Number(settings.max24hVolumeUSDT) || 0);
    }
    // Sanitize timeframes array if provided
    if (settings.timeframes !== undefined && Array.isArray(settings.timeframes)) {
      settings.timeframes = settings.timeframes.map((t) => String(t).trim()).filter(Boolean);
    }

    config.profiles[profileType] = {
      ...config.profiles[profileType],
      ...settings,
    };

    // Synchronize market scanner volume filters if volume parameters were adjusted
    if (settings.min24hVolumeUSDT !== undefined || settings.max24hVolumeUSDT !== undefined) {
      const volUpdate: Partial<UniverseFilterConfig> = {};
      if (settings.min24hVolumeUSDT !== undefined) volUpdate.min24hVolumeUSDT = settings.min24hVolumeUSDT;
      if (settings.max24hVolumeUSDT !== undefined) volUpdate.max24hVolumeUSDT = settings.max24hVolumeUSDT;
      this.marketScanner.updateFilterConfig(volUpdate);
      config.scannerFilter = this.marketScanner.getFilterConfig();
    }
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

  public getSymbolStatsTracker(): SymbolStatsTracker {
    return this.symbolStatsTracker;
  }

  public getSymbolStats(): SymbolRollingStats[] {
    return this.symbolStatsTracker.getAllStats();
  }

  public getSymbolStatsSummary(): SymbolStatsSummary {
    return this.symbolStatsTracker.getSummary(this.positionManager.getActivePositions());
  }

  public recalculateSymbolStats(): SymbolStatsSummary {
    this.symbolStatsTracker.recalculateFromOrders(this.orderManager.getOrders());
    this.orderStore.save(this.orderManager.getOrders());
    this.logAudit('SYSTEM', 'Symbol performance rolling stats recalculate executed across all historic orders.');
    return this.symbolStatsTracker.getSummary(this.positionManager.getActivePositions());
  }

  public toggleSymbolMultiplier(enabled?: boolean): boolean {
    const newState = enabled !== undefined ? enabled : !this.symbolStatsTracker.isMultiplierActive();
    this.symbolStatsTracker.setMultiplierActive(newState);
    this.logAudit(
      'CONFIG_UPDATED',
      `Feedback Multiplier pe Simbol a fost ${newState ? 'ACTIVAT' : 'DEZACTIVAT'} (interpolare liniară simetrică continuă: 0.50x la 0% hit ➔ 1.50x la 100% hit, prag n≥8).`
    );
    return newState;
  }
}

export const tradeBot = new TradeBot();
tradeBot.start().catch((err) => console.error('[TradeBot] Startup fatal error:', err));
