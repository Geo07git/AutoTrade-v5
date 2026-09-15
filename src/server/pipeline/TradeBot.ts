import { AppConfig, ProfileConfig, AuditLog } from '../../shared/types';
import { BybitAdapter } from '../exchange/BybitAdapter';
import { MomentumEngine } from '../engine/MomentumEngine';
import { RiskEngine } from '../risk/RiskEngine';
import { PositionManager } from '../position/PositionManager';
import { JsonStore } from '../store';

const DEFAULT_CONFIG: AppConfig = {
  activeProfile: 'MOMENTUM',
  testnet: true,
  killSwitchEngaged: false,
};

const PROFILES: Record<string, ProfileConfig> = {
  SCALP: {
    type: 'SCALP',
    timeframes: ['15', '60'],
    riskPerTradePct: 20,
    maxOpenPositions: 3,
    trailingActivationPct: 1.5,
    trailingDistancePct: 0.3,
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
  }
};

export class TradeBot {
  private configStore: JsonStore<AppConfig>;
  private auditStore: JsonStore<AuditLog[]>;
  private positionStore: JsonStore<any[]>; // using any[] for simple persistence for now

  private exchange!: BybitAdapter;
  private engine!: MomentumEngine;
  private riskEngine!: RiskEngine;
  private positionManager!: PositionManager;

  private isRunning: boolean = false;
  private loopInterval?: NodeJS.Timeout;
  private currentEquity: number = 1000; // Mock initial

  constructor() {
    this.configStore = new JsonStore<AppConfig>('config.json', DEFAULT_CONFIG);
    this.auditStore = new JsonStore<AuditLog[]>('audit.json', []);
    this.positionStore = new JsonStore<any[]>('positions.json', []);

    this.initializeComponents();
  }

  private initializeComponents() {
    const appConfig = this.configStore.get();
    const profile = PROFILES[appConfig.activeProfile];

    this.exchange = new BybitAdapter(
      appConfig.bybitApiKey || '',
      appConfig.bybitApiSecret || '',
      appConfig.testnet
    );

    this.engine = new MomentumEngine(profile);
    this.riskEngine = new RiskEngine();
    this.positionManager = new PositionManager(this.exchange);
    
    // Load state
    this.positionManager.setActivePositions(this.positionStore.get() || []);
  }

  public async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.logAudit('SYSTEM', 'Bot started');

    this.loopInterval = setInterval(() => this.tick(), 60000); // 1-minute tick
    await this.tick();
  }

  public stop() {
    this.isRunning = false;
    if (this.loopInterval) clearInterval(this.loopInterval);
    this.logAudit('SYSTEM', 'Bot stopped');
  }

  public getConfig() {
    return this.configStore.get();
  }
  
  public getActiveProfile() {
      return PROFILES[this.configStore.get().activeProfile];
  }

  public async setProfile(profile: 'SCALP' | 'MOMENTUM') {
    const config = this.configStore.get();
    config.activeProfile = profile;
    this.configStore.save();
    this.engine.setConfig(PROFILES[profile]);
    this.logAudit('SYSTEM', `Profile changed to ${profile}`);
  }

  public async toggleKillSwitch() {
    const config = this.configStore.get();
    config.killSwitchEngaged = !config.killSwitchEngaged;
    this.configStore.save();
    this.logAudit('SYSTEM', `Killswitch ${config.killSwitchEngaged ? 'ENGAGED' : 'DISENGAGED'}`);

    if (config.killSwitchEngaged) {
      await this.positionManager.closeAllPositions('KILL_SWITCH_ENGAGED');
      this.positionStore.save(this.positionManager.getActivePositions());
    }
  }

  private async tick() {
    if (this.configStore.get().killSwitchEngaged) return;

    try {
      // 1. Fetch equity
      const equity = await this.exchange.getEquity();
      if (equity > 0) this.currentEquity = equity;

      // 2. Fetch market data for active symbols (Mocking a watchlist for now)
      const watchlist = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
      const profile = PROFILES[this.configStore.get().activeProfile];
      const mainTf = profile.timeframes[0];

      // Update active positions with mock current prices (fetch ticker in reality)
      const currentPrices: Record<string, number> = {};
      
      for (const symbol of watchlist) {
        const klines = await this.exchange.getKlines(symbol, mainTf, 30);
        if (klines.length > 0) {
            currentPrices[symbol] = klines[klines.length - 1].close;
        }

        // 3. Engine Signal
        const signal = this.engine.evaluate(symbol, { [mainTf]: klines });

        if (signal) {
          // 4. Signal Validation & 5. Risk Engine
          const riskApproval = this.riskEngine.validateSignal(
            signal,
            profile,
            this.positionManager.getActivePositions(),
            this.currentEquity
          );

          if (riskApproval.approved) {
            // 6. Execute Order & 7. Register Position
            // Mock execution
            const entryPrice = klines[klines.length - 1].close;
            const newPos = {
              id: `pos_${Date.now()}_${symbol}`,
              symbol,
              side: signal.side,
              entryPrice,
              sizeUSDT: riskApproval.sizeUSDT,
              status: 'OPEN' as const,
              entryTime: Date.now(),
              highestPrice: entryPrice,
              lowestPrice: entryPrice
            };
            
            await this.positionManager.registerPosition(newPos);
            this.logAudit('POSITION', `Opened ${signal.side} on ${symbol} (Score: ${signal.score.toFixed(1)})`);
          }
        }
      }

      // Update positions
      await this.positionManager.updatePrices(currentPrices, profile);
      this.positionStore.save(this.positionManager.getActivePositions());

    } catch (err) {
      console.error('Error during bot tick:', err);
      this.logAudit('ERROR', `Tick error: ${err}`);
    }
  }

  private logAudit(type: AuditLog['type'], message: string) {
    const logs = this.auditStore.get();
    logs.unshift({
      id: Date.now().toString(),
      timestamp: Date.now(),
      type,
      message,
    });
    // Keep last 100
    if (logs.length > 100) logs.length = 100;
    this.auditStore.save();
    console.log(`[${type}] ${message}`);
  }
  
  public getPositions() {
      return this.positionManager.getActivePositions();
  }
  
  public getAuditLogs() {
      return this.auditStore.get();
  }
  
  public getEquity() {
      return this.currentEquity;
  }
}

export const tradeBot = new TradeBot();
tradeBot.start();
