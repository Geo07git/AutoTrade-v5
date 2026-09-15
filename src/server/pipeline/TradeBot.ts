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
} from '../../shared/types';
import { IExecutionAdapter } from '../exchange/IExecutionAdapter';
import { BybitAdapter } from '../exchange/BybitAdapter';
import { PaperExecutionAdapter } from '../exchange/PaperExecutionAdapter';
import { MomentumEngine } from '../engine/MomentumEngine';
import { RiskEngine } from '../risk/RiskEngine';
import { PositionManager } from '../position/PositionManager';
import { OrderManager } from '../order/OrderManager';
import { JsonStore } from '../store';

const DEFAULT_CONFIG: AppConfig = {
  executionMode: 'PAPER', // Default safe mode: Full simulation without Bybit API keys
  activeProfile: 'MOMENTUM',
  testnet: true,
  killSwitchEngaged: false,
  bybitApiKey: process.env.BYBIT_API_KEY || '',
  bybitApiSecret: process.env.BYBIT_API_SECRET || '',
  paperEquity: 10000.0,
  watchlist: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
};

const PROFILES: Record<ProfileType, ProfileConfig> = {
  SCALP: {
    type: 'SCALP',
    timeframes: ['15', '60'],
    riskPerTradePct: 15,
    maxOpenPositions: 3,
    trailingActivationPct: 1.5,
    trailingDistancePct: 0.4,
    hardStopLossPct: 2.0,
  },
  MOMENTUM: {
    type: 'MOMENTUM',
    timeframes: ['60', '240'],
    riskPerTradePct: 10,
    maxOpenPositions: 5,
    trailingActivationPct: 3.0,
    trailingDistancePct: 1.0,
    hardStopLossPct: 5.0,
  },
};

export class TradeBot {
  private configStore: JsonStore<AppConfig>;
  private auditStore: JsonStore<AuditLog[]>;
  private positionStore: JsonStore<Position[]>;
  private orderStore: JsonStore<OrderRecord[]>;

  private activeAdapter: IExecutionAdapter;
  private bybitAdapter: BybitAdapter;
  private paperAdapter: PaperExecutionAdapter;

  private engine: MomentumEngine;
  private riskEngine: RiskEngine;
  private positionManager: PositionManager;
  private orderManager: OrderManager;

  private state: BotState = 'INITIALIZING';
  private loopInterval?: NodeJS.Timeout;
  private reconnectInterval?: NodeJS.Timeout;
  private currentEquity: number = 10000.0;
  private lastSyncTime: number = 0;
  private latestPrices: Record<string, number> = {};
  private isProcessingTick: boolean = false;

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

    const profile = PROFILES[appConfig.activeProfile];

    // Unified audit logger callback
    const auditLogger = (type: AuditLogType, message: string, details?: any) => {
      this.logAudit(type, message, details);
    };

    // Instantiate both adapters
    this.bybitAdapter = new BybitAdapter(
      appConfig.bybitApiKey || '',
      appConfig.bybitApiSecret || '',
      appConfig.testnet
    );
    this.paperAdapter = new PaperExecutionAdapter();

    // Select active adapter based on executionMode
    this.activeAdapter = appConfig.executionMode === 'TESTNET' ? this.bybitAdapter : this.paperAdapter;

    this.positionManager = new PositionManager(auditLogger);
    this.orderManager = new OrderManager(
      this.activeAdapter,
      this.positionManager,
      auditLogger,
      appConfig.executionMode
    );

    this.engine = new MomentumEngine(profile);
    this.riskEngine = new RiskEngine();

    // Rehydrate saved positions
    const savedPositions = this.positionStore.get() || [];
    this.positionManager.setActivePositions(savedPositions);

    // Setup WebSocket event hooks
    this.setupAdapterListeners(this.activeAdapter);
  }

  private setupAdapterListeners(adapter: IExecutionAdapter) {
    adapter.onTickerUpdate = (symbol, lastPrice) => {
      this.latestPrices[symbol] = lastPrice;
      const profile = PROFILES[this.configStore.get().activeProfile];
      // Live trailing stop & stop loss evaluation on real tick
      this.positionManager
        .updatePrices(this.latestPrices, profile, this.orderManager)
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
    // If getting open positions fails, NEVER wipe or assume empty positions!
    try {
      const realPositions = await this.activeAdapter.getOpenPositions();
      const currentProfile = config.activeProfile;

      const reconResult = this.positionManager.reconcileWithBybit(realPositions, currentProfile);
      this.positionStore.save(this.positionManager.getActivePositions());
      this.lastSyncTime = Date.now();

      this.logAudit('RECOVERY', `State reconciled with ${config.executionMode}. Discrepancies resolved: ${reconResult.discrepanciesFound}. Active positions: ${this.positionManager.getActivePositions().length}`, {
        equity: this.currentEquity,
        activePositionsCount: this.positionManager.getActivePositions().length,
        discrepancies: reconResult.discrepanciesFound,
      });
    } catch (err: any) {
      // Prevent false position closures when exchange is unreachable
      this.logAudit('ERROR', `Could not fetch positions from ${config.executionMode}; skipping reconciliation to prevent false position closures: ${err.message || err}`);
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
    this.logAudit('SYSTEM', 'TradeBot 5 stopped by operator');
  }

  /**
   * Central Execution Pipeline:
   * Market Data -> Momentum Engine -> Risk Engine -> Order Manager -> Execution Adapter -> PAPER / BYBIT
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

      // Guard: Must be ready or trading
      if (this.state === 'WAITING_FOR_EXCHANGE' || this.state === 'INITIALIZING') {
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

      // 2. Periodic Reconciliation
      const now = Date.now();
      if (now - this.lastSyncTime > 60000) {
        try {
          const exchangePositions = await this.activeAdapter.getOpenPositions();
          this.positionManager.reconcileWithBybit(exchangePositions, config.activeProfile);
          this.positionStore.save(this.positionManager.getActivePositions());
          this.lastSyncTime = now;
        } catch (err: any) {
          this.logAudit('ERROR', `Periodic position sync error: ${err.message || err}. Local positions preserved.`);
        }
      }

      const profile = PROFILES[config.activeProfile];
      const watchlist = config.watchlist || ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
      const mainTf = profile.timeframes[0];

      // 3. Process Watchlist through Pipeline
      for (const symbol of watchlist) {
        // STRICT CHECK: Pre-filter symbols that already have an in-flight pending order
        if (this.orderManager.hasPendingOrderForSymbol(symbol)) {
          continue;
        }

        // Market Data: Fetch klines
        const klines = await this.activeAdapter.getKlines(symbol, mainTf, 30);
        if (!klines || klines.length === 0) continue;

        const currentPrice = klines[klines.length - 1].close;
        this.latestPrices[symbol] = currentPrice;

        // Momentum Engine: Evaluate market data
        const signal = this.engine.evaluate(symbol, { [mainTf]: klines });

        if (signal) {
          this.logAudit('SIGNAL_GENERATED', `Momentum Engine produced ${signal.side} signal on ${symbol} (Score: ${signal.score.toFixed(1)}/100)`, {
            symbol,
            side: signal.side,
            score: signal.score,
            profile: config.activeProfile,
          });

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
            this.logAudit('SIGNAL_REJECTED', `Signal rejected by Risk Engine: ${riskApproval.reason}`, {
              symbol,
              reason: riskApproval.reason,
            });
            continue;
          }

          // Order Manager: Execute via active Execution Adapter
          const executionResult = await this.orderManager.executeSignalOrder({
            signal,
            riskApproval,
            currentPrice,
            profile: config.activeProfile,
          });

          if (executionResult.success) {
            // Persist order & position state
            this.orderStore.save(this.orderManager.getOrders());
            this.positionStore.save(this.positionManager.getActivePositions());
          }
        }
      }

      // 4. Update prices and evaluate exit conditions (Trailing / Stop-loss)
      await this.positionManager.updatePrices(this.latestPrices, profile, this.orderManager);

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
   * STRICT SECURITY: LIVE mode is completely blocked!
   */
  public async setExecutionMode(mode: ExecutionMode): Promise<{ success: boolean; error?: string }> {
    if (mode === 'LIVE') {
      const msg = 'LIVE trading is strictly blocked and disabled for safety reasons.';
      this.logAudit('SYSTEM', `Operator attempt to switch to LIVE mode blocked: ${msg}`);
      return { success: false, error: msg };
    }

    const activePositions = this.positionManager.getActivePositions();
    if (activePositions.length > 0) {
      const err = `Cannot switch execution mode to ${mode} while ${activePositions.length} position(s) are open. Close all positions first.`;
      this.logAudit('SYSTEM', `Mode switch rejected: ${err}`, { activePositionsCount: activePositions.length });
      return { success: false, error: err };
    }

    const config = this.configStore.get();
    if (config.executionMode === mode) {
      return { success: true };
    }

    // Close previous adapter sockets if any
    if (this.activeAdapter.close) {
      this.activeAdapter.close();
    }

    config.executionMode = mode;
    this.configStore.save(config);

    // Switch active execution adapter
    this.activeAdapter = mode === 'TESTNET' ? this.bybitAdapter : this.paperAdapter;
    this.orderManager.setExecutionAdapter(this.activeAdapter, mode);

    this.setupAdapterListeners(this.activeAdapter);
    this.logAudit('MODE_CHANGED', `Execution mode switched to [${mode}]. Reconnecting execution engine...`);

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

    this.paperAdapter.resetAccount(10000.0);
    this.positionManager.setActivePositions([]);
    this.positionStore.save([]);
    this.currentEquity = 10000.0;

    this.logAudit('PAPER_RESET', 'Paper account reset: Balance restored to $10,000 USDT and paper positions cleared.');
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

    this.engine.setConfig(PROFILES[profile]);
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
   * Update Bybit API credentials
   */
  public async updateCredentials(apiKey: string, apiSecret: string, testnet: boolean = true) {
    const config = this.configStore.get();
    config.bybitApiKey = apiKey.trim();
    config.bybitApiSecret = apiSecret.trim();
    config.testnet = testnet;
    this.configStore.save();

    this.bybitAdapter.updateCredentials(apiKey, apiSecret, testnet);
    this.logAudit('SYSTEM', `Updated Bybit API credentials (Network: ${testnet ? 'Testnet' : 'Mainnet'}).`);

    if (config.executionMode === 'TESTNET') {
      await this.connectAndRecover();
    }
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
  }

  public getStatus(): BotStatusResponse {
    const config = this.configStore.get();
    return {
      state: this.state,
      executionMode: config.executionMode,
      config: {
        ...config,
        // Mask API secret for security
        bybitApiSecret: config.bybitApiSecret ? '********' : '',
      },
      profileConfig: PROFILES[config.activeProfile],
      equity: this.currentEquity,
      positions: this.positionManager.getActivePositions(),
      orders: this.orderManager.getOrders().slice(0, 50),
      connected: this.state === 'READY' || this.state === 'TRADING',
      lastSyncTime: this.lastSyncTime,
    };
  }

  public getAuditLogs(): AuditLog[] {
    return this.auditStore.get();
  }

  public getConfig(): AppConfig {
    return this.configStore.get();
  }

  public getActiveProfile(): ProfileConfig {
    return PROFILES[this.configStore.get().activeProfile];
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
