import {
  AppConfig,
  ProfileConfig,
  AuditLog,
  Position,
  OrderRecord,
  BotState,
  AuditLogType,
  ProfileType,
  BotStatusResponse,
} from '../../shared/types';
import { BybitAdapter } from '../exchange/BybitAdapter';
import { MomentumEngine } from '../engine/MomentumEngine';
import { RiskEngine } from '../risk/RiskEngine';
import { PositionManager } from '../position/PositionManager';
import { OrderManager } from '../order/OrderManager';
import { JsonStore } from '../store';

const DEFAULT_CONFIG: AppConfig = {
  activeProfile: 'MOMENTUM',
  testnet: true,
  killSwitchEngaged: false,
  bybitApiKey: process.env.BYBIT_API_KEY || '',
  bybitApiSecret: process.env.BYBIT_API_SECRET || '',
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

  private exchange: BybitAdapter;
  private engine: MomentumEngine;
  private riskEngine: RiskEngine;
  private positionManager: PositionManager;
  private orderManager: OrderManager;

  private state: BotState = 'INITIALIZING';
  private loopInterval?: NodeJS.Timeout;
  private reconnectInterval?: NodeJS.Timeout;
  private currentEquity: number = 0;
  private lastSyncTime: number = 0;
  private latestPrices: Record<string, number> = {};
  private isProcessingTick: boolean = false;

  constructor() {
    this.configStore = new JsonStore<AppConfig>('config.json', DEFAULT_CONFIG);
    this.auditStore = new JsonStore<AuditLog[]>('audit.json', []);
    this.positionStore = new JsonStore<Position[]>('positions.json', []);
    this.orderStore = new JsonStore<OrderRecord[]>('orders.json', []);

    const appConfig = this.configStore.get();
    const profile = PROFILES[appConfig.activeProfile];

    // Audit logger callback
    const auditLogger = (type: AuditLogType, message: string, details?: any) => {
      this.logAudit(type, message, details);
    };

    this.exchange = new BybitAdapter(
      appConfig.bybitApiKey || '',
      appConfig.bybitApiSecret || '',
      appConfig.testnet
    );

    this.positionManager = new PositionManager(auditLogger);
    this.orderManager = new OrderManager(this.exchange, this.positionManager, auditLogger);
    this.engine = new MomentumEngine(profile);
    this.riskEngine = new RiskEngine();

    // Rehydrate stored state
    const savedPositions = this.positionStore.get() || [];
    this.positionManager.setActivePositions(savedPositions);

    // Setup WebSocket event hooks
    this.setupExchangeListeners();
  }

  private setupExchangeListeners() {
    this.exchange.onTickerUpdate = (symbol, lastPrice) => {
      this.latestPrices[symbol] = lastPrice;
      const profile = PROFILES[this.configStore.get().activeProfile];
      // Live trailing stop & stop loss evaluation on tick
      this.positionManager
        .updatePrices(this.latestPrices, profile, this.orderManager)
        .catch((err) => console.error('[TradeBot] Position price update error:', err));
    };

    this.exchange.onOrderUpdate = (orderData) => {
      this.orderManager.handleWsOrderUpdate(orderData);
      this.orderStore.save(this.orderManager.getOrders());
    };

    this.exchange.onExecutionUpdate = (execData) => {
      this.logAudit('ORDER_FILLED', `Execution update received for ${execData.symbol}`, execData);
    };

    this.exchange.onWalletUpdate = (walletData) => {
      const eq = parseFloat(walletData?.totalEquity || '0');
      if (eq > 0) {
        this.currentEquity = eq;
      }
    };

    this.exchange.onConnectionChange = (connected, msg) => {
      if (connected) {
        this.logAudit('EXCHANGE_CONNECTED', msg);
      } else {
        this.logAudit('EXCHANGE_DISCONNECTED', msg);
      }
    };
  }

  /**
   * Safe startup sequence:
   * 1. Connect Bybit
   * 2. Read real positions/orders
   * 3. Reconcile
   * 4. Rebuild local state
   * 5. Start trading
   */
  public async start() {
    this.logAudit('SYSTEM', 'TradeBot 5 starting sequence initiated...');
    this.state = 'INITIALIZING';

    await this.connectAndRecover();

    // Start tick loop (runs every 30 seconds)
    if (this.loopInterval) clearInterval(this.loopInterval);
    this.loopInterval = setInterval(() => this.tick(), 30000);

    // Background watcher for reconnection if disconnected
    if (this.reconnectInterval) clearInterval(this.reconnectInterval);
    this.reconnectInterval = setInterval(async () => {
      if (this.state === 'WAITING_FOR_EXCHANGE') {
        await this.connectAndRecover();
      }
    }, 15000);
  }

  public async connectAndRecover() {
    const config = this.configStore.get();
    const connTest = await this.exchange.testConnection();

    if (!connTest.reachable || !connTest.authenticated) {
      this.state = 'WAITING_FOR_EXCHANGE';
      const reason = connTest.error || (!this.exchange.hasCredentials() ? 'API keys not configured' : 'Unreachable');
      this.logAudit('EXCHANGE_DISCONNECTED', `Waiting for exchange connection: ${reason}`);
      return;
    }

    this.state = 'READY';
    this.logAudit(
      'EXCHANGE_CONNECTED',
      `Successfully connected to Bybit Testnet (${connTest.accountType || 'CONTRACT'} account).`
    );

    // Fetch live equity from Bybit
    const realEquity = await this.exchange.getEquity();
    if (realEquity > 0) {
      this.currentEquity = realEquity;
    } else if (connTest.equity && connTest.equity > 0) {
      this.currentEquity = connTest.equity;
    }

    // Read real positions directly from Bybit (Exchange is source of truth)
    const realPositions = await this.exchange.getOpenPositions();
    const currentProfile = config.activeProfile;

    // Run reconciliation against local state
    const reconResult = this.positionManager.reconcileWithBybit(realPositions, currentProfile);
    this.positionStore.save(this.positionManager.getActivePositions());
    this.lastSyncTime = Date.now();

    this.logAudit('RECOVERY', `Restart recovery complete. Reconciled with Bybit. Discrepancies resolved: ${reconResult.discrepanciesFound}. Active positions: ${this.positionManager.getActivePositions().length}`, {
      equity: this.currentEquity,
      activePositionsCount: this.positionManager.getActivePositions().length,
      discrepancies: reconResult.discrepanciesFound,
    });

    // Initialize WebSocket feeds for watchlist
    const watchlist = config.watchlist || ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
    this.exchange.initWebSocket(watchlist);

    // If Kill Switch is not engaged, enter TRADING state
    if (!config.killSwitchEngaged) {
      this.state = 'TRADING';
      this.logAudit('SYSTEM', `TradeBot 5 operational. Active profile: ${config.activeProfile}. Trading loop active.`);
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
   * Market Data -> Momentum Engine -> Risk Engine -> Order Manager -> Bybit Adapter -> Bybit
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

      // Guard: Must be connected to Bybit
      if (this.state === 'WAITING_FOR_EXCHANGE' || this.state === 'INITIALIZING') {
        return;
      }

      // 1. Sync Equity from Bybit
      const liveEquity = await this.exchange.getEquity();
      if (liveEquity > 0) {
        this.currentEquity = liveEquity;
      }

      // 2. Periodic Reconciliation with Bybit positions
      const now = Date.now();
      if (now - this.lastSyncTime > 60000) {
        const bybitPositions = await this.exchange.getOpenPositions();
        this.positionManager.reconcileWithBybit(bybitPositions, config.activeProfile);
        this.positionStore.save(this.positionManager.getActivePositions());
        this.lastSyncTime = now;
      }

      const profile = PROFILES[config.activeProfile];
      const watchlist = config.watchlist || ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
      const mainTf = profile.timeframes[0];

      // 3. Process Watchlist
      for (const symbol of watchlist) {
        // Market Data: Fetch klines from Bybit
        const klines = await this.exchange.getKlines(symbol, mainTf, 30);
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

          // Risk Engine: Mandatory gatekeeper validation
          const riskApproval = this.riskEngine.validateSignal(
            signal,
            profile,
            this.positionManager.getActivePositions(),
            this.currentEquity,
            config.killSwitchEngaged
          );

          if (!riskApproval.approved) {
            this.logAudit('SIGNAL_REJECTED', `Signal rejected by Risk Engine: ${riskApproval.reason}`, {
              symbol,
              reason: riskApproval.reason,
            });
            continue;
          }

          // Order Manager: Real execution on Bybit Testnet
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
   * 2. Executes market close orders on Bybit for all open positions
   * 3. Confirms closure before marking locally closed
   */
  public async toggleKillSwitch(): Promise<boolean> {
    const config = this.configStore.get();
    config.killSwitchEngaged = !config.killSwitchEngaged;
    this.configStore.save();

    if (config.killSwitchEngaged) {
      this.state = 'STOPPED';
      this.logAudit('KILL_SWITCH_ENGAGED', '🚨 KILL SWITCH ENGAGED! Halting new entries and closing all open positions on Bybit...');

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

      this.logAudit('KILL_SWITCH_ENGAGED', `Kill Switch completed: ${closedCount}/${openPositions.length} positions closed on Bybit.`);
    } else {
      this.logAudit('KILL_SWITCH_DISENGAGED', 'Kill Switch disengaged. Resuming normal operations.');
      if (this.exchange.hasCredentials()) {
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

    this.exchange.updateCredentials(apiKey, apiSecret, testnet);
    this.logAudit('SYSTEM', `Updated Bybit API credentials (Network: ${testnet ? 'Testnet' : 'Mainnet'}). Reconnecting...`);

    await this.connectAndRecover();
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
