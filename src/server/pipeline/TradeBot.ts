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
  ScannerStats,
  GridCandidateAnalysis,
  NeutralGridBotConfig,
  GridBotInstance,
  GridAutopilotConfig,
  NativeGridAutopilotConfig,
  OKXFeeTierInfo,
} from '../../shared/types';
import { IExecutionAdapter } from '../exchange/IExecutionAdapter';
import { OKXAdapter } from '../exchange/OKXAdapter';
import { PaperExecutionAdapter } from '../exchange/PaperExecutionAdapter';
import { NeutralGridEngine } from '../engine/grid/NeutralGridEngine';
import { OKXNativeGridEngine } from '../engine/grid/OKXNativeGridEngine';
import { GridBotAnalyzer } from '../engine/grid/GridBotAnalyzer';
import { NeutralGridAnalyzer } from '../engine/grid/NeutralGridAnalyzer';
import { GridOptimizer } from '../engine/grid/GridOptimizer';
import { GridJournal } from '../engine/grid/GridJournal';
import { JsonStore } from '../store';
import { UniverseManager, DEFAULT_UNIVERSE_FILTER } from '../scanner/UniverseManager';
import { telegramService } from '../telegram/TelegramService';

const DEFAULT_GRID_PROFILE: ProfileConfig = {
  type: 'NEUTRAL_GRID',
  defaultSymbol: '',
  lowerPrice: 0,
  upperPrice: 0,
  gridCount: 12,
  gridType: 'ARITHMETIC',
  marginInvestedUSDT: 50,
  leverage: 3,
  marginMode: 'cross',
  stopLossPct: 8.0,
  takeProfitPct: 15.0,
  stopOnRangeBreakout: true,
  martingaleEnabled: false,
  martingaleMultiplier: 1.0,
  martingaleMaxSteps: 5,
  maxExposureUSDT: 150,
  autoDeployTopCandidate: false,
  maxActiveGridBots: 5,
};

const DEFAULT_AUTOPILOT_CONFIG: GridAutopilotConfig = {
  enabled: false,
  scanIntervalSec: 60,
  minSuitabilityScore: 70,
  maxConcurrentBots: 2,
  marginPerBotUSDT: 15,
  minReserveUSDT: 5,
  defaultLeverage: 3,
  useAnalyzerLeverage: true,
  defaultMarginMode: 'isolated',
  defaultGridType: 'ARITHMETIC',
  stopLossPct: 8.0,
  takeProfitPct: 15.0,
  stopOnRangeBreakout: true,
  martingaleEnabled: false,
  martingaleMultiplier: 1.15,
  martingaleMaxSteps: 4,
  cooldownMinutesPerSymbol: 15,
  onlyIdealOrGoodRegime: true,
  lastAutopilotCheckAt: 0,
  lastAutopilotAction: 'Autopilot pregătit (În așteptare activare)',
  totalAutopilotLaunches: 0,
  maxScannedSymbols: 12,
};

const DEFAULT_CONFIG: AppConfig = {
  executionMode: 'PAPER',
  activeProfile: 'NEUTRAL_GRID',
  activePlatform: 'OKX_EEA',
  testnet: false,
  killSwitchEngaged: false,
  okxApiKey: process.env.OKX_API_KEY || '',
  okxSecretKey: process.env.OKX_SECRET_KEY || '',
  okxPassphrase: process.env.OKX_PASSPHRASE || '',
  okxRegion: 'EEA',
  paperEquity: 500.0,
  leverageEnabled: true,
  maxLeverage: 3,
  marginMode: 'cross',
  watchlist: [],
  scannerFilter: { ...DEFAULT_UNIVERSE_FILTER },
  autopilot: { ...DEFAULT_AUTOPILOT_CONFIG },
  profiles: {
    NEUTRAL_GRID: { ...DEFAULT_GRID_PROFILE },
  },
};

export class TradeBot {
  private configStore: JsonStore<AppConfig>;
  private okxCredsStore: JsonStore<{
    okxApiKey: string;
    okxSecretKey: string;
    okxPassphrase: string;
    testnet: boolean;
    okxRegion: 'EEA' | 'GLOBAL' | 'AUTO';
    executionMode?: ExecutionMode;
  }>;
  private journal: GridJournal;

  private activeAdapter: IExecutionAdapter;
  private okxAdapter: OKXAdapter;
  private paperAdapter: PaperExecutionAdapter;
  private gridEngine: NeutralGridEngine;
  private nativeGridEngine: OKXNativeGridEngine;
  private gridBotAnalyzer: GridBotAnalyzer;
  private universeManager: UniverseManager;

  private state: BotState = 'INITIALIZING';
  private lastSyncTime: number = Date.now();
  private marketSentiment: string = 'NEUTRAL RANGE (IDEAL GRID)';
  private marketSentimentScore: number = 0;
  private gridCandidates: GridCandidateAnalysis[] = [];
  private isScanning: boolean = false;
  private lastScanDurationMs: number = 0;
  private lastScanTimestamp: number = 0;
  private monitorInterval?: NodeJS.Timeout;
  private scannerInterval?: NodeJS.Timeout;
  private cachedLiveWalletBalance: number = 200.0;

  constructor() {
    this.configStore = new JsonStore<AppConfig>('config.json', DEFAULT_CONFIG);
    this.okxCredsStore = new JsonStore('okx_credentials.json', {
      okxApiKey: process.env.OKX_API_KEY || '',
      okxSecretKey: process.env.OKX_SECRET_KEY || '',
      okxPassphrase: process.env.OKX_PASSPHRASE || '',
      testnet: false,
      okxRegion: 'EEA',
    });
    this.journal = new GridJournal();

    const appConfig = this.configStore.get();
    const savedCreds = this.okxCredsStore.get();

    // Restore OKX credentials from dedicated backup store if config.json lost them
    if (
      (!appConfig.okxApiKey || !appConfig.okxSecretKey || !appConfig.okxPassphrase) &&
      savedCreds?.okxApiKey &&
      savedCreds?.okxSecretKey &&
      savedCreds?.okxPassphrase
    ) {
      appConfig.okxApiKey = savedCreds.okxApiKey;
      appConfig.okxSecretKey = savedCreds.okxSecretKey;
      appConfig.okxPassphrase = savedCreds.okxPassphrase;
      appConfig.testnet = Boolean(savedCreds.testnet);
      appConfig.okxRegion = savedCreds.okxRegion || 'EEA';
      if (savedCreds.executionMode === 'LIVE' || savedCreds.executionMode === 'PAPER') {
        appConfig.executionMode = savedCreds.executionMode;
      }
    } else if (appConfig.okxApiKey && appConfig.okxSecretKey && appConfig.okxPassphrase) {
      this.okxCredsStore.save({
        okxApiKey: appConfig.okxApiKey,
        okxSecretKey: appConfig.okxSecretKey,
        okxPassphrase: appConfig.okxPassphrase,
        testnet: Boolean(appConfig.testnet),
        okxRegion: appConfig.okxRegion || 'EEA',
        executionMode: appConfig.executionMode,
      });
      this.okxCredsStore.flushSync();
    }

    appConfig.activeProfile = 'NEUTRAL_GRID';
    if (!appConfig.activePlatform) appConfig.activePlatform = 'OKX_EEA';
    if (!appConfig.profiles || !appConfig.profiles.NEUTRAL_GRID) {
      appConfig.profiles = {
        NEUTRAL_GRID: { ...DEFAULT_GRID_PROFILE },
      };
    } else {
      appConfig.profiles.NEUTRAL_GRID = {
        ...DEFAULT_GRID_PROFILE,
        ...appConfig.profiles.NEUTRAL_GRID,
        type: 'NEUTRAL_GRID',
      };
      // Purge legacy mock symbol/prices if present in persisted config.json
      if (appConfig.profiles.NEUTRAL_GRID.defaultSymbol?.endsWith('-USDT-SWAP')) {
        appConfig.profiles.NEUTRAL_GRID.defaultSymbol = '';
      }
      if (
        appConfig.profiles.NEUTRAL_GRID.lowerPrice === 62000 &&
        appConfig.profiles.NEUTRAL_GRID.upperPrice === 68000
      ) {
        appConfig.profiles.NEUTRAL_GRID.lowerPrice = 0;
        appConfig.profiles.NEUTRAL_GRID.upperPrice = 0;
      }
    }
    if (Array.isArray(appConfig.watchlist)) {
      appConfig.watchlist = appConfig.watchlist.filter((s) => !s.endsWith('-USDT-SWAP'));
    }
    appConfig.autopilot = {
      ...DEFAULT_AUTOPILOT_CONFIG,
      ...(appConfig.autopilot || {}),
    };
    this.configStore.save(appConfig);
    this.configStore.flushSync();

    const isDemo = Boolean(appConfig.testnet);
    const region = appConfig.okxRegion || 'EEA';

    this.okxAdapter = new OKXAdapter(
      appConfig.okxApiKey || process.env.OKX_API_KEY || '',
      appConfig.okxSecretKey || process.env.OKX_SECRET_KEY || '',
      appConfig.okxPassphrase || process.env.OKX_PASSPHRASE || '',
      isDemo,
      region
    );
    const initialLev = appConfig.profiles?.NEUTRAL_GRID?.leverage || appConfig.maxLeverage || 3;
    const initialMode: 'cross' | 'isolated' =
      appConfig.profiles?.NEUTRAL_GRID?.marginMode === 'isolated' || appConfig.marginMode === 'isolated'
        ? 'isolated'
        : 'cross';
    this.okxAdapter.setLeverageConfig(initialLev, initialMode);
    this.paperAdapter = new PaperExecutionAdapter();

    // Wire real-time ticker & order updates from adapters directly into NeutralGridEngine
    const handleLivePrice = (symbol: string, lastPrice: number) => {
      this.gridEngine.onPriceTick(symbol, lastPrice).catch(() => {});
    };
    this.okxAdapter.onTickerUpdate = handleLivePrice;
    this.paperAdapter.onTickerUpdate = handleLivePrice;
    this.okxAdapter.onOrderUpdate = (order: any) => {
      this.gridEngine.onLiveOrderUpdate(order).catch(() => {});
    };

    const hasCreds = this.okxAdapter.hasCredentials() || this.hasOKXCredentials();
    this.activeAdapter =
      appConfig.executionMode === 'LIVE' && hasCreds ? this.okxAdapter : this.paperAdapter;

    this.gridEngine = new NeutralGridEngine(this.activeAdapter, this.journal);
    this.universeManager = new UniverseManager((type, msg, details) =>
      this.logAudit(type, msg, details)
    );
    this.nativeGridEngine = new OKXNativeGridEngine(
      this.okxAdapter,
      this.universeManager,
      this.journal
    );
    this.gridBotAnalyzer = new GridBotAnalyzer(
      this.okxAdapter,
      this.journal,
      this.nativeGridEngine
    );
    this.paperAdapter.setMetadataResolver((sym) =>
      this.universeManager.getInstrumentLotFilter(sym)
    );

    this.state = 'TRADING';
    this.logAudit(
      'EXCHANGE_CONNECTED',
      `TB5 Neutral Grid System inițializat pe platforma ${appConfig.activePlatform} (${appConfig.executionMode}).`
    );
  }

  public logAudit(type: AuditLogType, message: string, details?: any) {
    this.journal.logAudit(type, message, details);
  }

  public getAuditLogs(): AuditLog[] {
    return this.journal.getAuditLogs();
  }

  public clearAuditLogs() {
    this.journal.clearAuditLogs();
  }

  public getOrders(): OrderRecord[] {
    return this.journal.getOrders();
  }

  public getArbitrages(limit: number = 500) {
    return this.journal.getArbitrages(limit);
  }

  public clearOrders() {
    this.journal.clearOrders();
  }

  public getPositions(): Position[] {
    // Expose active grid bot net holdings as positions for unified portfolio visibility
    return this.gridEngine
      .getRunningBots()
      .filter((b) => Math.abs(b.netPositionContracts) > 0)
      .map((b) => ({
        id: b.botId,
        symbol: b.symbol,
        side: b.netPositionContracts >= 0 ? 'BUY' : 'SELL',
        qty: Math.abs(b.netPositionContracts),
        entryPrice: b.avgHoldPrice,
        currentPrice: b.currentPrice,
        sizeUSDT: parseFloat((b.config.marginInvestedUSDT * b.config.leverage).toFixed(2)),
        status: 'OPEN',
        entryTime: b.createdAt,
        pnl: b.totalNetPnlUSDT,
        pnlPct: b.totalNetPnlPct,
        leverage: `${b.config.leverage}x`,
        profile: 'NEUTRAL_GRID',
        executionMode: b.executionMode,
      }));
  }

  public hasOKXCredentials(): boolean {
    const cfg = this.configStore.get();
    return Boolean(
      (cfg.okxApiKey || process.env.OKX_API_KEY) &&
        (cfg.okxSecretKey || process.env.OKX_SECRET_KEY) &&
        (cfg.okxPassphrase || process.env.OKX_PASSPHRASE)
    );
  }

  public async setExecutionMode(
    mode: ExecutionMode
  ): Promise<{ success: boolean; error?: string }> {
    const cfg = this.configStore.get();
    if (mode === 'LIVE' && !this.hasOKXCredentials()) {
      return {
        success: false,
        error:
          'Cheile API OKX EEA nu sunt configurate. Introduceți API Key, Secret și Passphrase în tabul [6:API] înainte de a activa modul LIVE.',
      };
    }

    if (mode === 'LIVE') {
      const conn = await this.okxAdapter.testConnection();
      if (!conn.authenticated) {
        return {
          success: false,
          error:
            conn.error ||
            'Autentificare OKX eșuată. Verifică API Key, Secret Key și Passphrase în tabul [6:API].',
        };
      }
      if (typeof conn.equity === 'number' && conn.equity > 0) {
        this.cachedLiveWalletBalance = conn.equity;
      }
      // Sync config if testConnection auto-corrected Demo vs Live or Region
      cfg.testnet = this.okxAdapter.isTestnet();
      cfg.okxRegion = this.okxAdapter.getRegion();
    }

    cfg.executionMode = mode;
    this.configStore.save(cfg);
    this.configStore.flushSync();

    const savedCreds = this.okxCredsStore.get();
    this.okxCredsStore.save({
      ...savedCreds,
      okxApiKey: cfg.okxApiKey || savedCreds.okxApiKey || '',
      okxSecretKey: cfg.okxSecretKey || savedCreds.okxSecretKey || '',
      okxPassphrase: cfg.okxPassphrase || savedCreds.okxPassphrase || '',
      testnet: Boolean(cfg.testnet),
      okxRegion: cfg.okxRegion || 'EEA',
      executionMode: mode,
    });
    this.okxCredsStore.flushSync();

    this.activeAdapter = mode === 'LIVE' ? this.okxAdapter : this.paperAdapter;
    this.gridEngine.setAdapter(this.activeAdapter);

    if (mode === 'LIVE') {
      try {
        const bal = await this.okxAdapter.getWalletBalance();
        if (bal > 0) this.cachedLiveWalletBalance = bal;
      } catch {}
    }

    this.logAudit('MODE_CHANGED', `Mod de execuție comutat în ${mode}.`);
    return { success: true };
  }

  public resetPaperAccount(): { success: boolean; error?: string } {
    this.paperAdapter.resetAccount(200.0);
    this.gridEngine.clearAllBots();
    this.journal.clearArbitrages();
    this.journal.clearOrders();
    this.logAudit(
      'PAPER_RESET',
      'Contul de simulare Paper Trading a fost resetat la $200.00 USDT și toți boții Grid au fost resetați.'
    );
    return { success: true };
  }

  // =========================================================================
  // NEUTRAL GRID BOT OPERATIONS (CREATE / AUTO-OPTIMIZE / MODIFY / STOP)
  // =========================================================================

  public async createGridBot(rawConfig: Partial<NeutralGridBotConfig>) {
    const status = this.getStatus();
    const res = await this.gridEngine.createAndStartBot(
      rawConfig,
      status.executionMode,
      status.freeBalance || 200,
      status.config.killSwitchEngaged
    );

    if (res.success && res.bot) {
      // Subscribe symbol to WebSocket ticker stream
      this.activeAdapter.subscribeSymbols?.([res.bot.symbol]);
      this.okxAdapter.setLeverageConfig(res.bot.config.leverage, res.bot.config.marginMode);
      // Also update default profile settings to reflect user's latest grid configuration
      this.updateProfileSettings('NEUTRAL_GRID', {
        defaultSymbol: res.bot.symbol,
        lowerPrice: res.bot.config.lowerPrice,
        upperPrice: res.bot.config.upperPrice,
        gridCount: res.bot.config.gridCount,
        gridType: res.bot.config.gridType,
        marginInvestedUSDT: res.bot.config.marginInvestedUSDT,
        leverage: res.bot.config.leverage,
        marginMode: res.bot.config.marginMode,
        stopLossPct: res.bot.config.risk.stopLossPct,
        takeProfitPct: res.bot.config.risk.takeProfitPct,
        stopOnRangeBreakout: res.bot.config.risk.stopOnRangeBreakout,
        martingaleEnabled: res.bot.config.martingale.enabled,
        martingaleMultiplier: res.bot.config.martingale.sizeMultiplier,
        martingaleMaxSteps: res.bot.config.martingale.maxMultiplierSteps,
        maxExposureUSDT: res.bot.config.martingale.maxExposureUSDT,
      });
    }
    return res;
  }

  public async previewAndAutoOptimizeGrid(
    symbol: string,
    marginInvestedUSDT: number = 50
  ) {
    const fallbackSym = this.gridCandidates[0]?.symbol || '';
    const rawSym = symbol || fallbackSym;
    if (!rawSym) {
      throw new Error('Selectați mai întâi un instrument valid din Universul OKX EEA.');
    }
    const normSymbol = this.activeAdapter.normalizeSymbol ? this.activeAdapter.normalizeSymbol(rawSym) : rawSym;
    const livePrice = (await this.activeAdapter.getTickerPrice(normSymbol)) || 0;
    const klines = await this.activeAdapter.getKlines(normSymbol, '15', 60);
    const lotFilter = await this.activeAdapter.getInstrumentFilter(normSymbol);

    const effectivePrice =
      livePrice > 0
        ? livePrice
        : (klines.length > 0 ? klines[klines.length - 1].close : 0);
    if (effectivePrice <= 0) throw new Error(`Nu s-a putut obține prețul curent pentru ${normSymbol}`);

    const auto = GridOptimizer.autoOptimizeParameters(
      normSymbol,
      effectivePrice,
      klines,
      marginInvestedUSDT,
      lotFilter?.tickSize || 0.01
    );

    const previewCalc = GridOptimizer.calculateGrid(
      {
        symbol: normSymbol,
        platform: 'OKX_EEA',
        mode: 'AUTO',
        lowerPrice: auto.lowerPrice,
        upperPrice: auto.upperPrice,
        gridCount: auto.gridCount,
        gridType: auto.gridType,
        marginInvestedUSDT,
        leverage: auto.recommendedLeverage,
        marginMode: 'cross',
        martingale: {
          enabled: false,
          sizeMultiplier: 1.0,
          maxMultiplierSteps: 5,
          maxExposureUSDT: marginInvestedUSDT * auto.recommendedLeverage,
        },
        risk: {
          stopLossPct: auto.stopLossPct,
          takeProfitPct: auto.takeProfitPct,
          stopOnRangeBreakout: true,
          maxMarginUsagePct: 90,
          maxActiveGridBots: 100,
        },
      },
      effectivePrice,
      lotFilter
    );

    return {
      symbol: normSymbol,
      currentPrice: effectivePrice,
      lotFilter,
      ...auto,
      preview: previewCalc,
    };
  }

  public async stopGridBot(botId: string, reason?: string) {
    return await this.gridEngine.stopBot(botId, reason || 'Oprit manual din Terminal');
  }

  public deleteStoppedGridBot(botId: string) {
    return this.gridEngine.deleteStoppedBot(botId);
  }

  public updateGridBotRisk(botId: string, updates: any) {
    return this.gridEngine.updateBotRiskSettings(botId, updates);
  }

  public getGridEngine(): NeutralGridEngine {
    return this.gridEngine;
  }

  // =========================================================================
  // UNIVERSE SCANNER FOR NEUTRAL GRID CANDIDATES
  // =========================================================================

  public async triggerManualScan(): Promise<GridCandidateAnalysis[]> {
    if (this.isScanning) return this.gridCandidates;
    this.isScanning = true;
    const startMs = Date.now();

    try {
      const cfg = this.configStore.get();
      const filtered = await this.universeManager.getFilteredUniverse(cfg.scannerFilter);
      let symbols = filtered.eligibleSymbols;
      if (!symbols || symbols.length === 0) {
        symbols = await this.universeManager.refreshUniverse(cfg.scannerFilter);
      }
      const ap = this.getAutopilotConfig();
      const targetSymbols = symbols.slice(0, ap.maxScannedSymbols || 12);
      const analyzed: GridCandidateAnalysis[] = [];

      for (const sym of targetSymbols) {
        const res = await NeutralGridAnalyzer.analyzeSymbol(sym, this.activeAdapter);
        if (res) {
          analyzed.push(res);
        }
      }

      analyzed.sort((a, b) => b.gridSuitabilityScore - a.gridSuitabilityScore);
      analyzed.forEach((item, idx) => {
        item.rank = idx + 1;
      });

      this.gridCandidates = analyzed;
      this.lastScanDurationMs = Date.now() - startMs;
      this.lastScanTimestamp = Date.now();

      if (analyzed.length > 0) {
        const top = analyzed[0];
        this.marketSentiment = `TOP GRID: ${top.symbol.replace('-USDT-SWAP', '')} (Scor ${top.gridSuitabilityScore}/100 | Chop ${top.choppinessIndex})`;
        this.marketSentimentScore = top.gridSuitabilityScore;
      }

      this.logAudit(
        'SCAN_COMPLETED',
        `Scanare Grid Universe finalizată în ${this.lastScanDurationMs}ms: ${analyzed.length} instrumente analizate pentru Neutral Grid.`
      );

      // Evaluate configurable Autopilot after every scan
      await this.evaluateAutopilotLaunch();

      // Also refresh OKX Native Futures Grid opportunities in parallel
      this.nativeGridEngine
        .scanAndOptimizeOpportunities(cfg.scannerFilter, Math.min(10, ap.maxScannedSymbols || 10))
        .then(async () => {
          if (this.nativeGridEngine.getConfig().enabled) {
            const st = this.getStatus();
            await this.nativeGridEngine.evaluateAutopilot(
              st.freeBalance,
              st.config.killSwitchEngaged,
              (p) => this.createNativeGridBot(p)
            );
          }
        })
        .catch(() => {});

      return analyzed;
    } catch (err: any) {
      this.logAudit('SCAN_ERROR', `Eroare la scanarea Grid Universe: ${err.message}`);
      return this.gridCandidates;
    } finally {
      this.isScanning = false;
    }
  }

  // =========================================================================
  // CONFIGURABLE AUTOPILOT ENGINE (AUTONOMOUS + MANUAL COEXISTENCE)
  // =========================================================================

  public getAutopilotConfig(): GridAutopilotConfig {
    const cfg = this.configStore.get();
    return {
      ...DEFAULT_AUTOPILOT_CONFIG,
      ...(cfg.autopilot || {}),
    };
  }

  public async updateAutopilotConfig(
    updates: Partial<GridAutopilotConfig>
  ): Promise<{
    success: boolean;
    autopilot: GridAutopilotConfig;
    launchedBots: GridBotInstance[];
    decision: string;
  }> {
    const cfg = this.configStore.get();
    const prevInterval = cfg.autopilot?.scanIntervalSec || DEFAULT_AUTOPILOT_CONFIG.scanIntervalSec;
    const prevEnabled = Boolean(cfg.autopilot?.enabled);

    const nextAutopilot: GridAutopilotConfig = {
      ...DEFAULT_AUTOPILOT_CONFIG,
      ...(cfg.autopilot || {}),
      ...updates,
    };

    // Sanitize numeric bounds
    nextAutopilot.scanIntervalSec = Math.max(15, Math.min(600, Math.round(Number(nextAutopilot.scanIntervalSec) || 60)));
    nextAutopilot.maxScannedSymbols = Math.max(1, Math.min(100, Math.round(Number(nextAutopilot.maxScannedSymbols) || 12)));
    nextAutopilot.minSuitabilityScore = Math.max(30, Math.min(98, Math.round(Number(nextAutopilot.minSuitabilityScore) || 70)));
    nextAutopilot.maxConcurrentBots = Math.max(1, Math.min(100, Math.round(Number(nextAutopilot.maxConcurrentBots) || 2)));
    nextAutopilot.marginPerBotUSDT = Math.max(2, Number(nextAutopilot.marginPerBotUSDT) || 15);
    nextAutopilot.minReserveUSDT = Math.max(0, Number(nextAutopilot.minReserveUSDT) || 5);
    nextAutopilot.defaultLeverage = Math.max(1, Math.min(20, Math.round(Number(nextAutopilot.defaultLeverage) || 3)));
    nextAutopilot.defaultMarginMode = nextAutopilot.defaultMarginMode === 'isolated' ? 'isolated' : 'cross';
    nextAutopilot.stopLossPct = Math.max(1, Math.min(50, Number(nextAutopilot.stopLossPct) || 8));
    nextAutopilot.takeProfitPct = Math.max(1, Math.min(200, Number(nextAutopilot.takeProfitPct) || 15));
    nextAutopilot.cooldownMinutesPerSymbol = Math.max(0, Math.min(1440, Math.round(Number(nextAutopilot.cooldownMinutesPerSymbol) || 15)));

    cfg.autopilot = nextAutopilot;
    cfg.marginMode = nextAutopilot.defaultMarginMode;
    cfg.maxLeverage = nextAutopilot.defaultLeverage;
    if (cfg.profiles?.NEUTRAL_GRID) {
      cfg.profiles.NEUTRAL_GRID.autoDeployTopCandidate = nextAutopilot.enabled;
      cfg.profiles.NEUTRAL_GRID.maxActiveGridBots = nextAutopilot.maxConcurrentBots;
      cfg.profiles.NEUTRAL_GRID.marginMode = nextAutopilot.defaultMarginMode;
      cfg.profiles.NEUTRAL_GRID.leverage = nextAutopilot.defaultLeverage;
    }
    this.okxAdapter.setLeverageConfig(nextAutopilot.defaultLeverage, nextAutopilot.defaultMarginMode);
    this.configStore.save(cfg);

    if (nextAutopilot.scanIntervalSec !== prevInterval) {
      this.rescheduleScannerInterval(nextAutopilot.scanIntervalSec);
    }

    this.logAudit(
      'CONFIG_UPDATED',
      `Setări Autopilot Grid actualizate: ${nextAutopilot.enabled ? 'ACTIVAT (ON)' : 'OPRIT (OFF)'} | Scanare la ${nextAutopilot.scanIntervalSec}s | Scor Min ≥ ${nextAutopilot.minSuitabilityScore} | Max ${nextAutopilot.maxConcurrentBots} boți × $${nextAutopilot.marginPerBotUSDT} USDT.`
    );

    let launchedBots: GridBotInstance[] = [];
    let decision = nextAutopilot.lastAutopilotAction || '';

    // If Autopilot was just turned ON or is active, run an immediate evaluation cycle
    if (nextAutopilot.enabled) {
      if (this.gridCandidates.length === 0) {
        await this.triggerManualScan();
      } else {
        const evalRes = await this.evaluateAutopilotLaunch();
        launchedBots = evalRes.launchedBots;
        decision = evalRes.decision;
      }
    } else if (prevEnabled && !nextAutopilot.enabled) {
      decision = 'Autopilot dezactivat manual (boții deja deschiși continuă să ruleze)';
      cfg.autopilot.lastAutopilotAction = decision;
      cfg.autopilot.lastAutopilotCheckAt = Date.now();
      this.configStore.save(cfg);
    }

    return {
      success: true,
      autopilot: this.getAutopilotConfig(),
      launchedBots,
      decision,
    };
  }

  public async evaluateAutopilotLaunch(forceRunEvenIfDisabled: boolean = false): Promise<{
    launchedBots: GridBotInstance[];
    decision: string;
  }> {
    const cfg = this.configStore.get();
    const ap = this.getAutopilotConfig();
    const now = Date.now();

    const saveDecision = (msg: string, addLaunches: number = 0) => {
      const latestCfg = this.configStore.get();
      latestCfg.autopilot = {
        ...DEFAULT_AUTOPILOT_CONFIG,
        ...(latestCfg.autopilot || {}),
        lastAutopilotCheckAt: now,
        lastAutopilotAction: msg,
        totalAutopilotLaunches: ((latestCfg.autopilot?.totalAutopilotLaunches || 0) + addLaunches),
      };
      this.configStore.save(latestCfg);
      return msg;
    };

    if (!ap.enabled && !forceRunEvenIfDisabled) {
      return { launchedBots: [], decision: ap.lastAutopilotAction || 'Autopilot OPRIT (Mod Manual)' };
    }

    if (cfg.killSwitchEngaged) {
      const msg = saveDecision('Blocat: Kill Switch de urgență este activat.');
      return { launchedBots: [], decision: msg };
    }

    if (this.gridCandidates.length === 0) {
      const msg = saveDecision('În așteptarea primei scanări Universe...');
      return { launchedBots: [], decision: msg };
    }

    const allBots = this.gridEngine.getAllBots();
    const runningBots = allBots.filter((b) => b.status === 'RUNNING');
    if (runningBots.length >= ap.maxConcurrentBots) {
      const msg = saveDecision(
        `Sloturi ocupate: ${runningBots.length}/${ap.maxConcurrentBots} boți activi (${runningBots.map((b) => b.symbol.replace('-USDT-SWAP', '')).join(', ')}).`
      );
      return { launchedBots: [], decision: msg };
    }

    if (cfg.executionMode === 'LIVE') {
      await this.refreshLiveAccountMetrics(true);
    }

    const status = this.getStatus();
    let currentFreeBalance = Math.min(
      status.freeBalance ?? 0,
      status.unallocatedBalance ?? status.freeBalance ?? 0
    );

    if (currentFreeBalance - ap.marginPerBotUSDT < ap.minReserveUSDT) {
      const msg = saveDecision(
        `Marjă nealocată insuficientă pentru lansare nouă: nealocat $${currentFreeBalance.toFixed(2)} (Disponibil OKX: $${(status.freeBalance ?? 0).toFixed(2)}), necesar $${ap.marginPerBotUSDT.toFixed(2)} + rezervă $${ap.minReserveUSDT.toFixed(2)}.`
      );
      return { launchedBots: [], decision: msg };
    }

    const runningSymbols = new Set(runningBots.map((b) => b.symbol));
    const cooldownMs = (ap.cooldownMinutesPerSymbol || 0) * 60 * 1000;

    const launchedBots: GridBotInstance[] = [];
    const skippedReasons: string[] = [];

    for (const candidate of this.gridCandidates) {
      if (runningBots.length + launchedBots.length >= ap.maxConcurrentBots) break;
      if (currentFreeBalance - ap.marginPerBotUSDT < ap.minReserveUSDT) break;

      if (runningSymbols.has(candidate.symbol)) {
        continue;
      }

      // Check cooldown on recently stopped bots for the same symbol
      if (cooldownMs > 0) {
        const recentStopped = allBots.find(
          (b) =>
            b.symbol === candidate.symbol &&
            b.status !== 'RUNNING' &&
            b.stoppedAt &&
            now - b.stoppedAt < cooldownMs
        );
        if (recentStopped) {
          skippedReasons.push(`${candidate.symbol.replace('-USDT-SWAP', '')} (Cooldown)`);
          continue;
        }
      }

      if (candidate.gridSuitabilityScore < ap.minSuitabilityScore) {
        skippedReasons.push(
          `${candidate.symbol.replace('-USDT-SWAP', '')} (Scor ${candidate.gridSuitabilityScore} < ${ap.minSuitabilityScore})`
        );
        continue;
      }

      if (ap.onlyIdealOrGoodRegime && candidate.regimeLabel === 'TRENDING_RISK') {
        skippedReasons.push(`${candidate.symbol.replace('-USDT-SWAP', '')} (Regim TRENDING_RISK evitat)`);
        continue;
      }

      const chosenLeverage = ap.useAnalyzerLeverage
        ? candidate.recommendedLeverage
        : ap.defaultLeverage;

      const createRes = await this.createGridBot({
        symbol: candidate.symbol,
        platform: cfg.activePlatform || 'OKX_EEA',
        mode: 'AUTO',
        lowerPrice: candidate.recommendedLowerPrice,
        upperPrice: candidate.recommendedUpperPrice,
        gridCount: candidate.recommendedGridCount,
        gridType: ap.defaultGridType,
        marginInvestedUSDT: ap.marginPerBotUSDT,
        leverage: chosenLeverage,
        marginMode: ap.defaultMarginMode,
        martingale: {
          enabled: ap.martingaleEnabled,
          sizeMultiplier: ap.martingaleEnabled ? ap.martingaleMultiplier : 1.0,
          maxMultiplierSteps: ap.martingaleMaxSteps,
          maxExposureUSDT: ap.marginPerBotUSDT * chosenLeverage,
        },
        risk: {
          stopLossPct: ap.stopLossPct,
          takeProfitPct: ap.takeProfitPct,
          stopOnRangeBreakout: ap.stopOnRangeBreakout,
          maxMarginUsagePct: 95,
          maxActiveGridBots: Math.max(100, ap.maxConcurrentBots),
        },
      });

      if (createRes.success && createRes.bot) {
        launchedBots.push(createRes.bot);
        runningSymbols.add(candidate.symbol);
        if (cfg.executionMode === 'LIVE') {
          await this.refreshLiveAccountMetrics(true);
          const updatedStatus = this.getStatus();
          currentFreeBalance = Math.min(
            updatedStatus.freeBalance ?? 0,
            updatedStatus.unallocatedBalance ?? updatedStatus.freeBalance ?? 0
          );
        } else {
          currentFreeBalance = Math.max(0, currentFreeBalance - ap.marginPerBotUSDT);
        }
        this.logAudit(
          'GRID_CREATED',
          `[AUTOPILOT LAUNCH] Bot Neutral Grid lansat autonom pe ${candidate.symbol} (Scor ${candidate.gridSuitabilityScore}/100 | Range $${candidate.recommendedLowerPrice} - $${candidate.recommendedUpperPrice} | ${candidate.recommendedGridCount} trepte | Marjă $${ap.marginPerBotUSDT} la ${chosenLeverage}x).`
        );
      } else if (createRes.error) {
        skippedReasons.push(`${candidate.symbol.replace('-USDT-SWAP', '')} (${createRes.error})`);
      }
    }

    if (launchedBots.length > 0) {
      const msg = saveDecision(
        `Lansat autonom ${launchedBots.length} bot(i): ${launchedBots.map((b) => `${b.symbol.replace('-USDT-SWAP', '')} ($${b.config.marginInvestedUSDT} @ ${b.config.leverage}x)`).join(', ')}`,
        launchedBots.length
      );
      return { launchedBots, decision: msg };
    }

    const topCand = this.gridCandidates[0];
    const msg = saveDecision(
      `Niciun candidat eligibil peste pragul ≥${ap.minSuitabilityScore}/100. Top curent: ${topCand ? `${topCand.symbol.replace('-USDT-SWAP', '')} (${topCand.gridSuitabilityScore}/100)` : 'N/A'}.`
    );
    return { launchedBots: [], decision: msg };
  }

  private rescheduleScannerInterval(intervalSec: number) {
    const clampedSec = Math.max(15, Math.min(600, Math.round(Number(intervalSec) || 60)));
    if (this.scannerInterval) clearInterval(this.scannerInterval);
    this.scannerInterval = setInterval(() => {
      this.triggerManualScan().catch(() => {});
    }, clampedSec * 1000);
  }

  public getScannerStats(): ScannerStats {
    return {
      universeCount: Math.max(12, this.gridCandidates.length),
      filteredCount: this.gridCandidates.length,
      candidatesCount: this.gridCandidates.filter((c) => c.gridSuitabilityScore >= 60).length,
      lastScanDurationMs: this.lastScanDurationMs,
      lastScanTimestamp: this.lastScanTimestamp,
      isScanning: this.isScanning,
      topOpportunities: this.gridCandidates,
      gridCandidates: this.gridCandidates,
      filterConfig: this.configStore.get().scannerFilter || DEFAULT_UNIVERSE_FILTER,
    };
  }

  public async updateCredentials(
    apiKey: string,
    secretKey: string,
    passphrase: string,
    testnet: boolean,
    region?: 'EEA' | 'GLOBAL' | 'AUTO'
  ): Promise<void> {
    const cleanKey = (apiKey || '').trim();
    const cleanSecret = (secretKey || '').trim();
    const cleanPass = (passphrase || '').trim();
    const cleanRegion = region || 'EEA';
    const isDemo = Boolean(testnet);

    const cfg = this.configStore.get();
    cfg.okxApiKey = cleanKey;
    cfg.okxSecretKey = cleanSecret;
    cfg.okxPassphrase = cleanPass;
    cfg.testnet = isDemo;
    cfg.okxRegion = cleanRegion;
    this.configStore.save(cfg);
    this.configStore.flushSync();

    this.okxCredsStore.save({
      okxApiKey: cleanKey,
      okxSecretKey: cleanSecret,
      okxPassphrase: cleanPass,
      testnet: isDemo,
      okxRegion: cleanRegion,
      executionMode: cfg.executionMode,
    });
    this.okxCredsStore.flushSync();

    this.okxAdapter.updateCredentials(cleanKey, cleanSecret, cleanPass, isDemo, cleanRegion);
    try {
      const conn = await this.okxAdapter.testConnection();
      if (conn.authenticated) {
        cfg.testnet = this.okxAdapter.isTestnet();
        cfg.okxRegion = this.okxAdapter.getRegion();
        this.configStore.save(cfg);
        this.configStore.flushSync();
        this.okxCredsStore.save({
          okxApiKey: cleanKey,
          okxSecretKey: cleanSecret,
          okxPassphrase: cleanPass,
          testnet: cfg.testnet,
          okxRegion: cfg.okxRegion,
          executionMode: cfg.executionMode,
        });
        this.okxCredsStore.flushSync();
        const bal = await this.okxAdapter.getWalletBalance();
        if (bal > 0) this.cachedLiveWalletBalance = bal;
      }
    } catch {}
    this.logAudit('CONFIG_UPDATED', `Cheile API OKX (${cleanRegion} | ${isDemo ? 'DEMO' : 'LIVE'}) au fost salvate persistent.`);
  }

  public async testOKXConnection(creds?: any): Promise<any> {
    if (creds && creds.apiKey && creds.secretKey) {
      const tempAdapter = new OKXAdapter(
        creds.apiKey,
        creds.secretKey,
        creds.passphrase || '',
        Boolean(creds.isDemo),
        creds.region || 'EEA'
      );
      return await tempAdapter.testConnection();
    }
    return await this.okxAdapter.testConnection();
  }

  public async forceSyncPositions(): Promise<{ count: number }> {
    if (this.configStore.get().executionMode === 'LIVE' && this.hasOKXCredentials()) {
      await this.gridEngine.reconcileWithExchange();
      await this.refreshLiveAccountMetrics(true);
    }
    const running = this.gridEngine.getRunningBots();
    for (const bot of running) {
      const px = await this.activeAdapter.getTickerPrice(bot.symbol);
      if (px && px > 0) {
        await this.gridEngine.onPriceTick(bot.symbol, px);
      }
    }
    this.lastSyncTime = Date.now();
    this.logAudit(
      'FORCE_SYNC',
      `Reconciliere Grid & OKX efectuată pentru ${running.length} boți activi.`
    );
    return { count: running.length };
  }

  public async toggleKillSwitch(): Promise<boolean> {
    const cfg = this.configStore.get();
    cfg.killSwitchEngaged = !cfg.killSwitchEngaged;
    this.configStore.save(cfg);

    if (cfg.killSwitchEngaged) {
      this.state = 'STOPPED';
      this.logAudit(
        'KILL_SWITCH_ENGAGED',
        'KILL SWITCH DE URGENȚĂ ACTIVAT! Toți boții Neutral Grid activi au fost opriți.'
      );
      const running = this.gridEngine.getRunningBots();
      for (const bot of running) {
        await this.gridEngine.stopBot(bot.botId, 'Kill Switch de urgență activat', 'STOPPED', false);
      }
    } else {
      this.state = 'TRADING';
      this.logAudit('KILL_SWITCH_DISENGAGED', 'Kill Switch dezactivat. Sistemul este pregătit.');
    }
    return cfg.killSwitchEngaged;
  }

  public async refreshMarketSentiment(): Promise<void> {
    await this.triggerManualScan();
  }

  public setProfile(_profile: ProfileType): { success: boolean; error?: string } {
    return { success: true };
  }

  public updateProfileSettings(
    _profileType: ProfileType,
    settings: Partial<ProfileConfig>
  ): { success: boolean; error?: string } {
    const cfg = this.configStore.get();
    if (!cfg.profiles) cfg.profiles = { NEUTRAL_GRID: { ...DEFAULT_GRID_PROFILE } };
    cfg.profiles.NEUTRAL_GRID = {
      ...DEFAULT_GRID_PROFILE,
      ...cfg.profiles.NEUTRAL_GRID,
      ...settings,
      type: 'NEUTRAL_GRID',
    };
    const effectiveMode: 'cross' | 'isolated' =
      cfg.profiles.NEUTRAL_GRID.marginMode === 'isolated' ? 'isolated' : 'cross';
    const effectiveLev = Number(cfg.profiles.NEUTRAL_GRID.leverage) || 3;
    cfg.profiles.NEUTRAL_GRID.marginMode = effectiveMode;
    cfg.marginMode = effectiveMode;
    cfg.maxLeverage = effectiveLev;
    if (cfg.autopilot) {
      cfg.autopilot.defaultMarginMode = effectiveMode;
      cfg.autopilot.defaultLeverage = effectiveLev;
    }
    this.okxAdapter.setLeverageConfig(effectiveLev, effectiveMode);
    this.configStore.save(cfg);
    this.logAudit(
      'CONFIG_UPDATED',
      `Setările implicite Neutral Grid (${cfg.profiles.NEUTRAL_GRID.defaultSymbol || 'Global'} | ${effectiveLev}x ${effectiveMode.toUpperCase()}) au fost salvate.`
    );
    return { success: true };
  }

  public getConfig(): AppConfig {
    return this.configStore.get();
  }

  private async refreshLiveAccountMetrics(force: boolean = false): Promise<void> {
    if (!this.hasOKXCredentials()) return;
    try {
      const bal = await this.okxAdapter.fetchAccountBalance(force);
      if (bal.walletBalance > 0) {
        this.cachedLiveWalletBalance = bal.walletBalance;
      } else if (bal.equity > 0) {
        this.cachedLiveWalletBalance = bal.equity;
      }
      const fillsSummary = await this.okxAdapter.fetchExchangeFillsSummary(force);
      // Sync recent OKX executed fills into local Order Journal if not already recorded
      if (Array.isArray(fillsSummary.recentFills) && fillsSummary.recentFills.length > 0) {
        const existingIds = new Set(this.journal.getOrders().map((o) => o.id));
        for (const f of fillsSummary.recentFills) {
          const fillId = f.clOrdId || f.ordId || f.tradeId;
          if (!fillId || existingIds.has(fillId)) continue;
          const px = parseFloat(f.fillPx || '0') || 0;
          const sz = parseFloat(f.fillSz || '0') || 0;
          const fee = Math.abs(parseFloat(f.fee || '0') || 0);
          const pnl = parseFloat(f.fillPnl || f.pnl || '0') || 0;
          const ts = parseInt(f.ts || f.fillTime || String(Date.now()), 10) || Date.now();
          existingIds.add(fillId);
          this.journal.recordOrder({
            id: fillId,
            symbol: f.instId || 'OKX-FUTURES',
            side: String(f.side).toLowerCase() === 'buy' ? 'BUY' : 'SELL',
            orderType: f.execType === 'M' ? 'Limit' : 'Market',
            qty: sz,
            sizeUSDT: parseFloat((px * sz).toFixed(2)),
            feeUSDT: parseFloat(fee.toFixed(4)),
            price: px,
            status: 'FILLED',
            createdTime: ts,
            updatedTime: ts,
            intent: pnl !== 0 ? `OKX_FILL (PnL ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(4)})` : 'OKX_GRID_FILL',
            profile: 'NEUTRAL_GRID',
            executionMode: 'LIVE',
          });
        }
      }
    } catch {}
  }

  public getStatus(): BotStatusResponse {
    const cfg = this.configStore.get();
    const profileConfig = cfg.profiles?.NEUTRAL_GRID || DEFAULT_GRID_PROFILE;
    const allBots = this.gridEngine.getAllBots();
    // Filter bots by active executionMode for accounting so old PAPER bots never pollute LIVE fees/PnL
    const modeBots = allBots.filter((b) => b.executionMode === cfg.executionMode);
    const runningBots = modeBots.filter((b) => b.status === 'RUNNING');

    const marginInvested = parseFloat(
      runningBots.reduce((s, b) => s + (b.config.marginInvestedUSDT || 0), 0).toFixed(2)
    );
    const botGridProfitTotal = parseFloat(
      modeBots.reduce((s, b) => s + (b.gridProfitUSDT || 0), 0).toFixed(4)
    );
    const botUnrealizedPnL = parseFloat(
      runningBots.reduce((s, b) => s + (b.floatingPnlUSDT || 0), 0).toFixed(4)
    );
    const botTotalFees = parseFloat(
      modeBots.reduce((s, b) => s + (b.totalFeesUSDT || 0), 0).toFixed(4)
    );
    const botCompletedArbitrages = modeBots.reduce(
      (s, b) => s + (b.completedArbitrages || 0),
      0
    );

    const feeTierInfo = this.okxAdapter.getCachedFeeTierInfo();
    const nativeGridBots = this.nativeGridEngine.getAllBots().map((nb) => {
      if (nb.algoId.toLowerCase().startsWith('grid')) {
        const match = allBots.find((b) => b.botId === nb.algoId);
        if (match) {
          return {
            ...nb,
            state: match.status === 'RUNNING' ? ('running' as const) : ('stopped' as const),
            currentPx: match.currentPrice || nb.currentPx,
            gridProfit: match.gridProfitUSDT || 0,
            floatProfit: match.floatingPnlUSDT || 0,
            totalPnl: match.totalNetPnlUSDT || 0,
            totalPnlPct: match.totalNetPnlPct || 0,
            arbitrageNum: match.completedArbitrages || 0,
            stopReason: match.stopReason || nb.stopReason,
          };
        }
      }
      return nb;
    });
    const nativeGridOpportunities = this.nativeGridEngine.getOpportunities();
    const nativeGridAutopilot = this.nativeGridEngine.getConfig();

    if (cfg.executionMode === 'LIVE') {
      const liveBal = this.okxAdapter.getCachedAccountBalanceDetails();
      const fillsSummary = this.okxAdapter.getCachedExchangeFillsSummary();

      // In LIVE mode, OKX's cashBal and totalEq are the ground-truth accounting numbers
      // (they ALREADY include all realized PnL and fees deducted by OKX).
      const walletBalance = parseFloat(
        (liveBal.walletBalance > 0 ? liveBal.walletBalance : this.cachedLiveWalletBalance).toFixed(2)
      );
      const unrealizedPnL = parseFloat(
        (Math.abs(liveBal.unrealizedPnl) > 1e-6 ? liveBal.unrealizedPnl : botUnrealizedPnL).toFixed(2)
      );
      const equity = parseFloat(
        (liveBal.equity > 0 ? liveBal.equity : walletBalance + unrealizedPnL).toFixed(2)
      );
      const exchangeFrozenMargin = parseFloat((liveBal.frozenMargin || 0).toFixed(2));
      const exchangeAvailBalance = parseFloat(
        (liveBal.availBalance > 0
          ? liveBal.availBalance
          : Math.max(0, walletBalance - exchangeFrozenMargin)
        ).toFixed(2)
      );
      const unallocatedBalance = parseFloat(
        Math.max(0, walletBalance - marginInvested).toFixed(2)
      );

      // Live OKX fee calculation from real exchange fills & OKX fee rate tier (/api/v5/account/trade-fee)
      const liveExchangeFee =
        feeTierInfo.effectiveFeeUSDT > 0
          ? feeTierInfo.effectiveFeeUSDT
          : fillsSummary.totalFeesUSDT || 0;
      const totalFees = parseFloat(Math.max(botTotalFees, liveExchangeFee).toFixed(4));
      const gridProfitTotal = parseFloat(
        (botGridProfitTotal !== 0 ? botGridProfitTotal : fillsSummary.realizedPnlUSDT || 0).toFixed(2)
      );
      const completedArbitragesTotal =
        botCompletedArbitrages > 0 ? botCompletedArbitrages : fillsSummary.closingFillsCount || 0;
      const totalProfit = parseFloat(
        (
          (botGridProfitTotal !== 0 || botTotalFees !== 0
            ? botGridProfitTotal - totalFees
            : (fillsSummary.realizedPnlUSDT || 0) - totalFees) + unrealizedPnL
        ).toFixed(2)
      );
      const initialEquity = parseFloat(
        Math.max(0.01, walletBalance - ((fillsSummary.realizedPnlUSDT || 0) - totalFees)).toFixed(2)
      );
      const totalProfitPct =
        initialEquity > 0 ? parseFloat(((totalProfit / initialEquity) * 100).toFixed(2)) : 0;

      return {
        state: cfg.killSwitchEngaged ? 'STOPPED' : this.state,
        executionMode: cfg.executionMode,
        config: cfg,
        profileConfig,
        autopilot: this.getAutopilotConfig(),
        profiles: cfg.profiles,
        equity,
        initialEquity,
        walletBalance,
        freeBalance: exchangeAvailBalance,
        unallocatedBalance,
        exchangeAvailBalance,
        exchangeFrozenMargin,
        marginInvested,
        unrealizedPnL,
        totalFees,
        totalProfit,
        totalProfitPct,
        gridProfitTotal,
        completedArbitragesTotal,
        exchangeFillsSummary: {
          realizedPnlUSDT: fillsSummary.realizedPnlUSDT,
          totalFeesUSDT: totalFees,
          netPnlUSDT: parseFloat(((fillsSummary.realizedPnlUSDT || 0) - totalFees).toFixed(4)),
          fillsCount: fillsSummary.fillsCount,
          closingFillsCount: fillsSummary.closingFillsCount,
          totalVolumeUSDT: fillsSummary.totalVolumeUSDT,
          makerVolumeUSDT: fillsSummary.makerVolumeUSDT,
          takerVolumeUSDT: fillsSummary.takerVolumeUSDT,
        },
        feeTierInfo,
        nativeGridBots,
        nativeGridOpportunities,
        nativeGridAutopilot,
        gridAnalyzer: this.gridBotAnalyzer.getStatusSummary(),
        gridBots: allBots,
        recentArbitrages: this.journal.getArbitrages(100),
        gridCandidates: this.gridCandidates,
        positions: this.getPositions(),
        orders: this.getOrders().slice(0, 150),
        connected: true,
        lastSyncTime: this.lastSyncTime,
        scannerStats: this.getScannerStats(),
        marketRegime: this.marketSentiment,
        marketSentiment: this.marketSentiment,
        marketSentimentScore: this.marketSentimentScore,
        telegramActive: telegramService.isConfigured(),
        telegramStatus: telegramService.getCredentialsStatus(),
      };
    }

    // PAPER mode synthetic accounting + live OKX fee tier applied to PAPER filled volume
    const paperFilledOrders = this.journal
      .getOrders()
      .filter((o) => o.executionMode === 'PAPER' && o.status === 'FILLED');
    let paperMakerVol = 0;
    let paperTakerVol = 0;
    for (const o of paperFilledOrders) {
      const vol = Number(o.sizeUSDT) || 0;
      if (o.orderType === 'Limit') paperMakerVol += vol;
      else paperTakerVol += vol;
    }
    const paperTotalVol = parseFloat((paperMakerVol + paperTakerVol).toFixed(2));
    const paperCalcFee = parseFloat(
      (
        paperMakerVol * feeTierInfo.makerFeeRate +
        paperTakerVol * feeTierInfo.takerFeeRate
      ).toFixed(4)
    );
    const effectivePaperFee = parseFloat(Math.max(botTotalFees, paperCalcFee).toFixed(4));

    const paperFeeTierInfo: OKXFeeTierInfo = {
      ...feeTierInfo,
      totalVolumeUSDT: paperTotalVol > 0 ? paperTotalVol : feeTierInfo.totalVolumeUSDT,
      makerVolumeUSDT: paperTotalVol > 0 ? parseFloat(paperMakerVol.toFixed(2)) : feeTierInfo.makerVolumeUSDT,
      takerVolumeUSDT: paperTotalVol > 0 ? parseFloat(paperTakerVol.toFixed(2)) : feeTierInfo.takerVolumeUSDT,
      calculatedFeeOnVolumeUSDT:
        paperTotalVol > 0 ? paperCalcFee : feeTierInfo.calculatedFeeOnVolumeUSDT,
      effectiveFeeUSDT:
        paperTotalVol > 0 ? effectivePaperFee : feeTierInfo.effectiveFeeUSDT,
    };

    const baseWallet = cfg.paperEquity || 200.0;
    const gridProfitTotal = parseFloat(botGridProfitTotal.toFixed(2));
    const unrealizedPnL = parseFloat(botUnrealizedPnL.toFixed(2));
    const totalFees = effectivePaperFee;
    const totalProfit = parseFloat((gridProfitTotal + unrealizedPnL - totalFees).toFixed(2));
    const walletBalance = parseFloat((baseWallet + gridProfitTotal - totalFees).toFixed(2));
    const equity = parseFloat((walletBalance + unrealizedPnL).toFixed(2));
    const freeBalance = parseFloat(Math.max(0, walletBalance - marginInvested).toFixed(2));
    const totalProfitPct =
      baseWallet > 0 ? parseFloat(((totalProfit / baseWallet) * 100).toFixed(2)) : 0;

    return {
      state: cfg.killSwitchEngaged ? 'STOPPED' : this.state,
      executionMode: cfg.executionMode,
      config: cfg,
      profileConfig,
      autopilot: this.getAutopilotConfig(),
      profiles: cfg.profiles,
      equity,
      initialEquity: baseWallet,
      walletBalance,
      freeBalance,
      unallocatedBalance: freeBalance,
      exchangeAvailBalance: freeBalance,
      exchangeFrozenMargin: marginInvested,
      marginInvested,
      unrealizedPnL,
      totalFees,
      totalProfit,
      totalProfitPct,
      gridProfitTotal,
      completedArbitragesTotal: botCompletedArbitrages,
      feeTierInfo: paperFeeTierInfo,
      nativeGridBots,
      nativeGridOpportunities,
      nativeGridAutopilot,
      gridAnalyzer: this.gridBotAnalyzer.getStatusSummary(),
      gridBots: allBots,
      recentArbitrages: this.journal.getArbitrages(100),
      gridCandidates: this.gridCandidates,
      positions: this.getPositions(),
      orders: this.getOrders().slice(0, 150),
      connected: true,
      lastSyncTime: this.lastSyncTime,
      scannerStats: this.getScannerStats(),
      marketRegime: this.marketSentiment,
      marketSentiment: this.marketSentiment,
      marketSentimentScore: this.marketSentimentScore,
      telegramActive: telegramService.isConfigured(),
      telegramStatus: telegramService.getCredentialsStatus(),
    };
  }

  // =========================================================================
  // OKX NATIVE FUTURES GRID & LIVE FEE TIER PUBLIC FACADE
  // =========================================================================

  public getGridAnalyzerStatus() {
    return this.gridBotAnalyzer.getStatusSummary();
  }

  public updateGridAnalyzerThresholds(updates: any) {
    const thresholds = this.gridBotAnalyzer.updateThresholds(updates || {});
    return {
      success: true,
      thresholds,
      gridAnalyzer: this.gridBotAnalyzer.getStatusSummary(),
    };
  }

  public async evaluateGridAnalyzerNow() {
    await this.gridBotAnalyzer.analyzeAll(true);
    return {
      success: true,
      gridAnalyzer: this.gridBotAnalyzer.getStatusSummary(),
    };
  }

  public async fetchLiveFeeTier(force: boolean = false): Promise<OKXFeeTierInfo> {
    if (this.hasOKXCredentials()) {
      await this.okxAdapter.fetchExchangeFillsSummary(force).catch(() => {});
      return await this.okxAdapter.fetchTradeFeeTier('FUTURES', force);
    }
    return this.okxAdapter.getCachedFeeTierInfo();
  }

  public getNativeGridEngine(): OKXNativeGridEngine {
    return this.nativeGridEngine;
  }

  public async scanNativeGridOpportunities() {
    const cfg = this.configStore.get();
    const ap = this.getAutopilotConfig();
    return await this.nativeGridEngine.scanAndOptimizeOpportunities(
      cfg.scannerFilter,
      Math.max(8, ap.maxScannedSymbols || 10)
    );
  }

  public async calculateNativeGridMinInvestment(params: {
    instId: string;
    maxPx: number;
    minPx: number;
    gridNum: number;
    runType: '1' | '2';
    lever: number;
  }) {
    return await this.okxAdapter.calculateGridMinInvestment(params);
  }

  public async syncNativeGridBots() {
    const cfg = this.configStore.get();
    await this.nativeGridEngine.syncAndMonitorActiveBots(cfg.killSwitchEngaged);
    return this.nativeGridEngine.getAllBots();
  }

  public async createNativeGridBot(params: any) {
    const cfg = this.configStore.get();
    const res: any = await this.nativeGridEngine.createNativeBot({
      ...params,
      killSwitchEngaged: cfg.killSwitchEngaged,
    });

    // If OKX EEA's public REST gateway on /api/v5/tradingBot/grid/order-algo blocks the -USD_UM suffix (Error 51000),
    // automatically execute the Neutral Grid on OKX EEA via /api/v5/trade/order unless disabled by user mode!
    if (
      !res.success &&
      res.needsDirectOrderFallback &&
      res.validatedParams &&
      !params?.disableDirectOrderFallback
    ) {
      const vp = res.validatedParams;
      const prevMode = cfg.executionMode;
      if (prevMode !== 'LIVE') {
        await this.setExecutionMode('LIVE');
      }
      const gridRes = await this.createGridBot({
        symbol: vp.instId,
        platform: 'OKX_EEA',
        mode: 'MANUAL',
        lowerPrice: vp.minPx,
        upperPrice: vp.maxPx,
        gridCount: vp.gridNum,
        gridType: vp.runType === '2' ? 'GEOMETRIC' : 'ARITHMETIC',
        marginInvestedUSDT: vp.sz,
        leverage: vp.lever,
        marginMode: cfg.marginMode || 'isolated',
        martingale: {
          enabled: false,
          sizeMultiplier: 1,
          maxMultiplierSteps: 1,
          maxExposureUSDT: vp.sz * vp.lever,
        },
        risk: {
          stopLossPct: vp.stopLossPct,
          takeProfitPct: vp.takeProfitPct,
          lowerStopPrice: vp.slTriggerPx,
          upperStopPrice: vp.tpTriggerPx,
          stopOnRangeBreakout: vp.stopOnRangeBreakout,
          maxMarginUsagePct: 95,
          maxActiveGridBots: 20,
        },
      });

      if (gridRes.success && gridRes.bot) {
        const now = Date.now();
        const fallbackNativeBot = {
          algoId: gridRes.bot.botId,
          instId: vp.instId,
          algoOrdType: 'contract_grid' as const,
          direction: 'neutral' as const,
          environment: 'LIVE' as const,
          state: 'running' as const,
          minPx: vp.minPx,
          maxPx: vp.maxPx,
          gridNum: vp.gridNum,
          runType: vp.runType,
          lever: vp.lever,
          sz: vp.sz,
          singleAmt: vp.singleAmt || 0,
          currentPx: gridRes.bot.currentPrice,
          liqPx: 0,
          gridProfit: 0,
          floatProfit: 0,
          totalPnl: 0,
          totalPnlPct: 0,
          arbitrageNum: 0,
          tpTriggerPx: vp.tpTriggerPx,
          slTriggerPx: vp.slTriggerPx,
          stopLossPct: vp.stopLossPct,
          takeProfitPct: vp.takeProfitPct,
          stopTypeOnRisk: vp.stopTypeOnRisk,
          stopOnRangeBreakout: vp.stopOnRangeBreakout,
          stopOnTrendInvalidation: vp.stopOnTrendInvalidation,
          cTime: now,
          uTime: now,
        };
        this.nativeGridEngine.registerFallbackBot(fallbackNativeBot);
        return { success: true, bot: fallbackNativeBot };
      }
      return {
        success: false,
        error: gridRes.error || res.error,
      };
    }

    return res;
  }

  public async amendNativeGridBot(algoId: string, params: any) {
    return await this.nativeGridEngine.amendNativeBot({
      algoId,
      ...params,
    });
  }

  public async stopNativeGridBot(algoId: string, stopType?: '1' | '2', reason?: string) {
    if (algoId.toLowerCase().startsWith('grid')) {
      await this.stopGridBot(algoId, reason || 'Oprit manual din panoul OKX Native Grid');
    }
    return await this.nativeGridEngine.stopNativeBot(algoId, stopType, reason);
  }

  public async closeNativeGridBotPosition(algoId: string) {
    if (algoId.toLowerCase().startsWith('grid')) {
      const stopped = await this.stopGridBot(algoId, 'Close Position din panoul OKX Native Grid');
      return { success: stopped.success, error: stopped.error };
    }
    return await this.nativeGridEngine.closeNativeBotPosition(algoId);
  }

  public deleteNativeGridBot(algoId: string) {
    return this.nativeGridEngine.deleteNativeBot(algoId);
  }

  public clearStoppedNativeGridBots() {
    return this.nativeGridEngine.clearStoppedNativeBots();
  }

  public async updateNativeGridAutopilot(updates: Partial<NativeGridAutopilotConfig>) {
    const nextCfg = this.nativeGridEngine.updateConfig(updates);
    let launched: any[] = [];
    let decision = nextCfg.lastDecision || '';
    if (nextCfg.enabled) {
      if (this.nativeGridEngine.getOpportunities().length === 0) {
        await this.scanNativeGridOpportunities();
      }
      const status = this.getStatus();
      const evalRes = await this.nativeGridEngine.evaluateAutopilot(
        status.freeBalance,
        status.config.killSwitchEngaged,
        (p) => this.createNativeGridBot(p)
      );
      launched = evalRes.launched;
      decision = evalRes.decision;
    }
    return {
      success: true,
      autopilot: this.nativeGridEngine.getConfig(),
      launched,
      decision,
    };
  }

  public async start(): Promise<void> {
    this.state = this.configStore.get().killSwitchEngaged ? 'STOPPED' : 'TRADING';
    const runningSymbols = this.gridEngine.getRunningBots().map((b) => b.symbol);
    this.activeAdapter.initWebSocket(runningSymbols);

    if (this.hasOKXCredentials()) {
      await this.refreshLiveAccountMetrics(true);
      await this.okxAdapter.fetchTradeFeeTier('FUTURES', true).catch(() => {});
      await this.nativeGridEngine
        .syncAndMonitorActiveBots(this.configStore.get().killSwitchEngaged)
        .catch(() => {});
      await this.gridBotAnalyzer.analyzeAll(true).catch(() => {});
      if (this.configStore.get().executionMode === 'LIVE') {
        await this.gridEngine.reconcileWithExchange();
        await this.refreshLiveAccountMetrics(true);
      }
    }

    // Run initial scan in background (which also triggers evaluateAutopilotLaunch and Native Grid scan)
    this.triggerManualScan().catch(() => {});

    // Background price monitor every 4s for active grid bots
    if (this.monitorInterval) clearInterval(this.monitorInterval);
    let monitorTickCount = 0;
    this.monitorInterval = setInterval(async () => {
      try {
        monitorTickCount++;
        const running = this.gridEngine.getRunningBots();
        for (const bot of running) {
          const px = await this.activeAdapter.getTickerPrice(bot.symbol);
          if (px && px > 0) {
            await this.gridEngine.onPriceTick(bot.symbol, px);
          }
        }
        if (this.hasOKXCredentials()) {
          if (monitorTickCount % 4 === 0 && this.configStore.get().executionMode === 'LIVE') {
            await this.gridEngine.reconcileWithExchange().catch(() => {});
          }
          if (monitorTickCount % 3 === 0) {
            await this.nativeGridEngine
              .syncAndMonitorActiveBots(this.configStore.get().killSwitchEngaged)
              .catch(() => {});
          }
          // GridBotAnalyzer periodic analysis (enforces 30s/1m/5m/15m cadences & immediate critical risk checks)
          if (monitorTickCount % 4 === 0) {
            await this.gridBotAnalyzer
              .analyzeAll(false)
              .catch((err) => console.error('[TradeBot] GridBotAnalyzer error:', err));
          }
          this.refreshLiveAccountMetrics(false).catch(() => {});
        }
        this.lastSyncTime = Date.now();
      } catch (err) {
        console.error('[TradeBot] Monitor loop error:', err);
      }
    }, 4000);

    // Periodic Universe Grid Scanner using configurable autopilot.scanIntervalSec
    const scanSec = this.getAutopilotConfig().scanIntervalSec || 60;
    this.rescheduleScannerInterval(scanSec);
  }

  // Compatibility helpers for server routes
  public async closePositionManually(symbol: string): Promise<any> {
    const running = this.gridEngine
      .getRunningBots()
      .find((b) => b.symbol === symbol || b.botId === symbol);
    if (running) {
      return await this.stopGridBot(running.botId, 'Închis manual din Terminal');
    }
    return { success: true };
  }
  public async connectAndRecover() {
    await this.forceSyncPositions();
  }
  public updateScannerFilter(filter: any) {
    const cfg = this.configStore.get();
    cfg.scannerFilter = { ...(cfg.scannerFilter || DEFAULT_UNIVERSE_FILTER), ...filter };
    this.configStore.save(cfg);
  }
  public updateLeverage(lev: number, mode: 'cross' | 'isolated', enabled?: boolean) {
    const cfg = this.configStore.get();
    const validMode: 'cross' | 'isolated' = mode === 'isolated' ? 'isolated' : 'cross';
    cfg.maxLeverage = lev;
    cfg.marginMode = validMode;
    if (enabled !== undefined) cfg.leverageEnabled = enabled;
    if (cfg.profiles?.NEUTRAL_GRID) {
      cfg.profiles.NEUTRAL_GRID.leverage = lev;
      cfg.profiles.NEUTRAL_GRID.marginMode = validMode;
    }
    if (cfg.autopilot) {
      cfg.autopilot.defaultLeverage = lev;
      cfg.autopilot.defaultMarginMode = validMode;
    }
    this.okxAdapter.setLeverageConfig(lev, validMode);
    this.configStore.save(cfg);
    this.logAudit(
      'CONFIG_UPDATED',
      `Configurație Levier & Marjă actualizată: ${lev}x ${validMode.toUpperCase()}.`
    );
  }
}

export const tradeBot = new TradeBot();

