// TB5 Neutral Grid System - Shared Types

export type ProfileType = 'NEUTRAL_GRID' | 'SCALP' | 'MOMENTUM' | 'PAIR_SCALP';
export type OrderSide = 'BUY' | 'SELL';
export type PositionStatus = 'OPEN' | 'CLOSING' | 'CLOSED';
export type ExecutionMode = 'PAPER' | 'LIVE';
export type GridSpacingType = 'ARITHMETIC' | 'GEOMETRIC';
export type ExchangePlatformId = 'OKX_EEA' | 'BINANCE_EEA' | 'BYBIT_EU' | 'KRAKEN_FUTURES';

export type OrderStatus =
  | 'CREATED'
  | 'SUBMITTED'
  | 'ACCEPTED'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'CANCELLED'
  | 'REJECTED'
  | 'FAILED';

export type BotState =
  | 'INITIALIZING'
  | 'WAITING_FOR_EXCHANGE'
  | 'READY'
  | 'TRADING'
  | 'STOPPED'
  | 'ERROR';

export type AuditLogType =
  | 'GRID_CREATED'
  | 'GRID_STOPPED'
  | 'GRID_MODIFIED'
  | 'GRID_ARBITRAGE_PROFIT'
  | 'GRID_LEVEL_FILLED'
  | 'GRID_RISK_TRIGGERED'
  | 'SIGNAL_GENERATED'
  | 'SIGNAL_REJECTED'
  | 'RISK_APPROVED'
  | 'RISK_REJECTED'
  | 'ORDER_SUBMITTED'
  | 'ORDER_ROUTED'
  | 'ORDER_ACCEPTED'
  | 'ORDER_REJECTED'
  | 'ORDER_PARTIALLY_FILLED'
  | 'ORDER_FILLED'
  | 'ORDER_CANCELLED'
  | 'ORDER_FAILED'
  | 'POSITION_OPENED'
  | 'POSITION_UPDATED'
  | 'POSITION_CLOSED'
  | 'RECONCILIATION_DISCREPANCY'
  | 'KILL_SWITCH_ENGAGED'
  | 'KILL_SWITCH_DISENGAGED'
  | 'EXCHANGE_CONNECTED'
  | 'EXCHANGE_DISCONNECTED'
  | 'MODE_CHANGED'
  | 'PAPER_RESET'
  | 'CONFIG_UPDATED'
  | 'UNIVERSE_REFRESH'
  | 'UNIVERSE_FILTERED'
  | 'SCAN_STARTED'
  | 'SCAN_COMPLETED'
  | 'SCAN_ERROR'
  | 'CANDIDATE_SELECTED'
  | 'CANDIDATE_REJECTED'
  | 'RECOVERY'
  | 'FORCE_SYNC'
  | 'SYSTEM'
  | 'ERROR';

export interface UniverseFilterConfig {
  min24hVolumeUSDT: number;
  max24hVolumeUSDT?: number;
  minPrice: number;
  maxSymbols: number;
  settleCoin: string;
  refreshIntervalMs: number;
  maxSpreadPct?: number;
  excludedSymbols?: string[];
  [key: string]: any;
}

export interface MartingaleConfig {
  enabled: boolean;
  sizeMultiplier: number;      // e.g. 1.0 (off) to 1.5x per step away from mid
  maxMultiplierSteps: number;  // e.g. 5 steps max
  maxExposureUSDT: number;     // Maximum total notional exposure cap
}

export interface GridRiskConfig {
  stopLossPct: number;         // Max loss % of invested margin before emergency stop (e.g. 8%)
  takeProfitPct: number;       // Target profit % of invested margin to lock profit (e.g. 15%)
  lowerStopPrice?: number;     // Hard lower stop price below lowerPrice
  upperStopPrice?: number;     // Hard upper stop price above upperPrice
  stopOnRangeBreakout: boolean;// Automatically close grid if price breaks stop bounds
  maxMarginUsagePct: number;   // Max % of account free balance allowed per grid bot
  maxActiveGridBots: number;   // Max concurrent active grid bots
}

export interface NeutralGridBotConfig {
  symbol: string;
  platform: ExchangePlatformId;
  mode: 'AUTO' | 'MANUAL';
  lowerPrice: number;
  upperPrice: number;
  gridCount: number;
  gridType: GridSpacingType;
  marginInvestedUSDT: number;
  leverage: number;
  marginMode: 'cross' | 'isolated';
  martingale: MartingaleConfig;
  risk: GridRiskConfig;
  autoManageRange?: boolean;
}

export interface GridLevelState {
  index: number;
  price: number;
  side: 'Buy' | 'Sell' | 'Neutral';
  qtyContracts: number;
  notionalUSDT: number;
  martingaleWeight: number;
  status: 'IDLE' | 'OPEN_ORDER' | 'FILLED_HOLDING' | 'CANCELLED';
  activeOrderId?: string;
  activeOrderLinkId?: string;
  fillCount: number;
  lastFilledAt?: number;
  realizedGridProfitUSDT: number;
}

export interface GridArbitrageEvent {
  id: string;
  botId: string;
  symbol: string;
  timestamp: number;
  openSide: 'Buy' | 'Sell';
  openPrice: number;
  closePrice: number;
  qtyContracts: number;
  grossProfitUSDT: number;
  feeUSDT: number;
  netProfitUSDT: number;
  gridIndex: number;
}

export interface GridBotInstance {
  botId: string;
  symbol: string;
  platform: ExchangePlatformId;
  executionMode: ExecutionMode;
  status: 'RUNNING' | 'STOPPED' | 'STOP_LOSS_HIT' | 'TAKE_PROFIT_HIT' | 'ERROR';
  stopReason?: string;
  config: NeutralGridBotConfig;
  createdAt: number;
  updatedAt: number;
  stoppedAt?: number;
  initialCenterPrice: number;
  currentPrice: number;
  gridSpacingUSDT: number;
  gridSpacingPct: number;
  estimatedProfitPerGridPct: number;
  estimatedLiquidationPriceLong: number;
  estimatedLiquidationPriceShort: number;
  lowerStopPrice: number;
  upperStopPrice: number;
  levels: GridLevelState[];
  // Accounting & Telemetry
  totalNotionalUSDT: number;
  netPositionContracts: number;
  netPositionSide: 'LONG' | 'SHORT' | 'FLAT';
  avgHoldPrice: number;
  gridProfitUSDT: number;       // Realized profit from completed grid buy-low/sell-high pairs
  floatingPnlUSDT: number;      // Unrealized PnL on currently held inventory
  totalFeesUSDT: number;
  fundingEstimateUSDT: number;
  totalNetPnlUSDT: number;      // gridProfitUSDT + floatingPnlUSDT - totalFeesUSDT + fundingEstimateUSDT
  totalNetPnlPct: number;       // % return on marginInvestedUSDT
  completedArbitrages: number;  // Total matched grid round-trips
  activeBuyOrders: number;
  activeSellOrders: number;
  okxAlgoId?: string;           // If linked to native OKX Grid Algo API
}

export interface GridCandidateAnalysis {
  symbol: string;
  price: number;
  volume24hUSDT: number;
  priceChange24hPct: number;
  high24h: number;
  low24h: number;
  range24hPct: number;
  atrPct: number;
  choppinessIndex: number;      // 0..100 (>61.8 = sideways/consolidation ideal for Neutral Grid)
  adxTrendStrength: number;     // 0..100 (<25 = weak trend / range-bound ideal for Neutral Grid)
  spreadPct: number;
  fundingRatePct: number;       // 8h funding rate %
  gridSuitabilityScore: number; // 0..100 composite score for Neutral Grid
  regimeLabel: 'IDEAL_RANGE' | 'HIGH_VOL_RANGE' | 'TRENDING_RISK' | 'LOW_VOLATILITY';
  recommendedLowerPrice: number;
  recommendedUpperPrice: number;
  recommendedGridCount: number;
  recommendedLeverage: number;
  estimatedNetProfitPerGridPct: number;
  estimatedDailyGridYieldPct: number;
  reasons: string[];
  rank: number;
  lastScannedTime: number;
}

export interface ProfileConfig {
  type: ProfileType;
  defaultSymbol?: string;
  lowerPrice?: number;
  upperPrice?: number;
  gridCount?: number;
  gridType?: GridSpacingType;
  marginInvestedUSDT?: number;
  leverage?: number;
  marginMode?: 'cross' | 'isolated';
  stopLossPct?: number;
  takeProfitPct?: number;
  stopOnRangeBreakout?: boolean;
  martingaleEnabled?: boolean;
  martingaleMultiplier?: number;
  martingaleMaxSteps?: number;
  maxExposureUSDT?: number;
  autoDeployTopCandidate?: boolean;
  maxActiveGridBots?: number;
  [key: string]: any;
}

export interface GridAutopilotConfig {
  enabled: boolean;
  scanIntervalSec: number;           // Configurable Universe scan interval in seconds (15..600)
  minSuitabilityScore: number;       // Minimum score (0..100) required for autonomous launch
  maxConcurrentBots: number;         // Max simultaneous RUNNING bots managed by Autopilot
  marginPerBotUSDT: number;          // Margin invested (USDT) per automatically launched bot
  minReserveUSDT: number;            // Minimum free USDT balance to keep untouched in wallet
  defaultLeverage: number;           // Leverage used when useAnalyzerLeverage is false
  useAnalyzerLeverage: boolean;      // Use leverage recommended by NeutralGridAnalyzer
  defaultMarginMode: 'cross' | 'isolated';
  defaultGridType: GridSpacingType;
  stopLossPct: number;
  takeProfitPct: number;
  stopOnRangeBreakout: boolean;
  martingaleEnabled: boolean;
  martingaleMultiplier: number;
  martingaleMaxSteps: number;
  cooldownMinutesPerSymbol: number;  // Cooldown before re-launching on the same symbol
  onlyIdealOrGoodRegime: boolean;    // Avoid TRENDING_RISK regime
  lastAutopilotCheckAt?: number;
  lastAutopilotAction?: string;
  totalAutopilotLaunches?: number;
  maxScannedSymbols: number; // Configurable limit for the scanner (e.g., 12)
}

export interface AppConfig {
  executionMode: ExecutionMode;
  activeProfile: ProfileType;
  activePlatform?: ExchangePlatformId;
  testnet: boolean;
  killSwitchEngaged: boolean;
  paperKillSwitchEngaged?: boolean;
  liveKillSwitchEngaged?: boolean;
  okxApiKey?: string;
  okxSecretKey?: string;
  okxPassphrase?: string;
  okxRegion?: 'EEA' | 'GLOBAL' | 'AUTO';
  paperEquity?: number;
  leverageEnabled?: boolean;
  maxLeverage?: number;
  marginMode?: 'cross' | 'isolated';
  watchlist?: string[];
  scannerFilter?: UniverseFilterConfig;
  autopilot?: GridAutopilotConfig;
  profiles?: Record<string, ProfileConfig>;
  telegramBotToken?: string;
  telegramChatId?: string;
  telegramAlertsEnabled?: boolean;
  [key: string]: any;
}

export interface OKXFeeTierInfo {
  instType: 'FUTURES' | 'SWAP';
  level: string;                  // e.g. 'Lv1'
  makerFeeRate: number;           // e.g. 0.0002 (0.02%)
  takerFeeRate: number;           // e.g. 0.0005 (0.05%)
  makerFeePct: number;            // e.g. 0.02
  takerFeePct: number;            // e.g. 0.05
  roundTripMakerFeePct: number;   // e.g. 0.04
  totalVolumeUSDT: number;        // Current executed trade volume in USDT/USD
  makerVolumeUSDT: number;
  takerVolumeUSDT: number;
  calculatedFeeOnVolumeUSDT: number; // Volume * actual OKX fee tier rate
  actualExchangeFeesUSDT: number;    // Sum of fees reported on fills
  effectiveFeeUSDT: number;          // Live fee applied to accounting & UI
  fillsAnalyzedCount: number;
  source: 'OKX_API_LIVE' | 'OKX_FILLS_DERIVED' | 'DEFAULT_TIER';
  updatedAt: number;
}

export interface NativeGridOpportunity {
  instId: string;                 // Exclusively _UM_XPERP (e.g. LINK-USD_UM_XPERP-310523)
  price: number;
  volume24hUSDT: number;
  priceChange24hPct: number;
  range24hPct: number;
  atrPct: number;
  choppinessIndex: number;
  adxTrendStrength: number;
  spreadBps: number;
  openInterestUSD: number;
  fundingRatePct: number;         // Current 8h funding rate %
  nextFundingRatePct: number;
  orderBookImbalance: number;     // -1..+1 (-0.35..+0.35 balanced for Neutral Grid)
  orderBookDepthUSD: number;      // Top 20 bid+ask liquidity USD
  suitabilityScore: number;       // 0..100 composite score
  regimeLabel: 'IDEAL_RANGE' | 'HIGH_VOL_RANGE' | 'TRENDING_RISK' | 'LOW_VOLATILITY';
  minPx: number;
  maxPx: number;
  gridNum: number;
  runType: '1' | '2';             // '1' = Arithmetic, '2' = Geometric
  gridSpacingPct: number;
  lever: number;
  minInvestmentUSDT: number;      // Exact from POST /api/v5/tradingBot/grid/min-investment
  minInvestmentCcy: string;
  recommendedInvestmentUSDT: number;
  fitsMaxBudget: boolean;
  estimatedGrossProfitPerGridPct: number;
  estimatedNetProfitPerGridPct: number; // After real OKX maker fee & funding
  estimatedDailyNetYieldPct: number;
  isEligible: boolean;
  rejectionReason?: string;
  reasons: string[];
  updatedAt: number;
}

export interface OKXNativeGridBot {
  algoId: string;
  instId: string;
  algoOrdType: 'contract_grid';
  direction: 'neutral';
  environment: 'LIVE';
  state: 'running' | 'stopping' | 'stopped' | 'pending_signal';
  minPx: number;
  maxPx: number;
  gridNum: number;
  runType: '1' | '2';             // '1' = Arithmetic, '2' = Geometric
  lever: number;
  sz: number;                     // Margin invested (USD/USDC/USDT)
  singleAmt: number;
  currentPx: number;
  liqPx: number;                  // Estimated liquidation price reported by OKX
  gridProfit: number;             // Realized grid profit reported by OKX
  floatProfit: number;            // Unrealized PnL reported by OKX
  totalPnl: number;               // Total PnL reported by OKX
  totalPnlPct: number;
  arbitrageNum: number;           // Completed grid round-trips on OKX
  tpTriggerPx?: number;
  slTriggerPx?: number;
  tpRatio?: number;
  slRatio?: number;
  stopLossPct: number;            // TB5 supervisor risk threshold (% of sz)
  takeProfitPct: number;          // TB5 supervisor profit target (% of sz)
  stopTypeOnRisk: '1' | '2';      // '1' = Close position at market, '2' = Keep position open
  stopOnRangeBreakout: boolean;
  stopOnTrendInvalidation: boolean;
  stopReason?: string;
  cTime: number;
  uTime: number;
}

export interface NativeGridAutopilotConfig {
  enabled: boolean;
  environment: 'LIVE';
  liveExecutionConfirmed: boolean;
  maxBudgetPerBotUSDT: number;     // Maximum investment per bot (validated against min-investment)
  minReserveUSDT: number;
  maxConcurrentNativeBots: number;
  minSuitabilityScore: number;
  minNetProfitPerGridPct: number;
  maxLeverage: number;
  defaultRunType: '1' | '2';
  defaultStopType: '1' | '2';      // '1' = Close position, '2' = Keep position
  stopLossPct: number;
  takeProfitPct: number;
  stopOnRangeBreakout: boolean;
  stopOnTrendInvalidation: boolean;
  scanIntervalSec: number;
  lastScanAt?: number;
  lastDecision?: string;
}

export interface BotStatusResponse {
  state: BotState;
  executionMode: ExecutionMode;
  config: AppConfig;
  profileConfig: ProfileConfig;
  autopilot?: GridAutopilotConfig;
  profiles?: Record<string, ProfileConfig>;
  equity: number;
  initialEquity?: number;
  walletBalance?: number;
  freeBalance?: number;
  unallocatedBalance?: number;
  exchangeAvailBalance?: number;
  exchangeFrozenMargin?: number;
  marginInvested?: number;
  unrealizedPnL?: number;
  totalFees?: number;
  totalProfit?: number;
  totalProfitPct?: number;
  gridProfitTotal?: number;
  completedArbitragesTotal?: number;
  exchangeFillsSummary?: {
    realizedPnlUSDT: number;
    totalFeesUSDT: number;
    netPnlUSDT: number;
    fillsCount: number;
    closingFillsCount: number;
    totalVolumeUSDT?: number;
    makerVolumeUSDT?: number;
    takerVolumeUSDT?: number;
  };
  feeTierInfo?: OKXFeeTierInfo;
  nativeGridBots?: OKXNativeGridBot[];
  nativeGridOpportunities?: NativeGridOpportunity[];
  nativeGridAutopilot?: NativeGridAutopilotConfig;
  gridAnalyzer?: GridAnalyzerStatusSummary;
  gridBots?: GridBotInstance[];
  recentArbitrages?: GridArbitrageEvent[];
  gridCandidates?: GridCandidateAnalysis[];
  positions: Position[];
  orders: OrderRecord[];
  connected: boolean;
  lastSyncTime: number;
  scannerStats?: ScannerStats;
  marketRegime?: string;
  marketSentiment?: string;
  marketSentimentScore?: number;
  telegramActive?: boolean;
  telegramStatus?: TelegramConfigStatus;
  [key: string]: any;
}

export type GridAnalyzerDecision =
  | 'CONTINUE'
  | 'MONITOR'
  | 'WARNING'
  | 'ADJUST'
  | 'STOP'
  | 'EMERGENCY';

export type GridStagnationLevel =
  | 'ACTIVE'
  | 'MONITOR_30M'
  | 'WARNING_60M'
  | 'REVIEW_120M'
  | 'EARLY_STOP_MARKET'
  | 'STOP_180M';

export interface GridStagnationMetrics {
  level: GridStagnationLevel;
  isStagnant: boolean;
  lastFillAt: number;
  minutesSinceLastFill: number;
  lastGridCycleCloseAt: number;
  minutesSinceLastGridClose: number;
  realizedPnlUSDT: number;
  realizedPnlDelta30mUSDT: number;
  realizedPnlDelta60mUSDT: number;
  realizedPnlDelta120mUSDT: number;
  floatPnlUSDT: number;
  floatPnlDelta30mUSDT: number;
  floatPnlDelta60mUSDT: number;
  netRealizedProfitAfterCostsUSDT: number;
  netTotalProfitAfterCostsUSDT: number;
  realizedNetHourlyYieldPct: number;
  fillsCount30m: number;
  fillsCount60m: number;
  fillsCount120m: number;
  gridCyclesCount30m: number;
  gridCyclesCount60m: number;
  gridCyclesCount120m: number;
  activeOrdersCount: number;
  gridStepPct: number;
  nearestOrderDistancePct: number;
  priceOscillationAmplitude60mPct: number;
  priceOscillationAmplitude120mPct: number;
  oscillationToGridStepRatio: number;
  lockedCapitalUSDT: number;
  capitalTurnover120mRatio: number;
  capitalEfficiencyScore: number;
  recoveryProspect: 'HIGH' | 'MODERATE' | 'LOW';
  continueOpportunityVerdict: string;
}

export interface GridAnalyzerThresholds {
  adxMonitorThreshold: number;
  adxMonitorConsecutiveCount: number;
  adxStopThreshold: number;
  adxStopConsecutiveCount: number;
  chopStopThreshold: number;
  chopStopConsecutiveCount: number;
  atrSpikeMonitorPct: number;
  rangeEdgeWarningPct: number;
  rangeBreakoutBufferPct?: number;
  warningDrawdownPct: number;
  stopDrawdownPct: number;
  minLiqSafetyPct: number;
  requireMultiIndicatorForTrendStop: boolean;
  emergencyClosePosition: boolean;
  // Stagnation Analyzer configurable thresholds
  stagnationMonitorNoFillMinutes: number;
  stagnationWarningNoFillMinutes: number;
  stagnationReviewMinutes: number;
  stagnationStopMinutes: number;
  minRealizedPnlProgressUSDT: number;
  minProductiveHourlyYieldPct: number;
  minOscillationToGridStepRatio: number;
  minCapitalTurnover120mRatio: number;
  enableEarlyStopOnMarketDeterioration: boolean;
}

export interface GridBotAnalysisSnapshot {
  algoId: string;
  instId: string;
  isNativeOKXBot: boolean;
  managedByTB5: boolean;
  state: 'running' | 'stopping' | 'stopped' | 'pending_signal';
  decision: GridAnalyzerDecision;
  decisionReason: string;
  riskLevel: 'LOW' | 'ELEVATED' | 'WARNING' | 'CRITICAL';
  reconciliationState:
    | 'CONFIRMED_RUNNING'
    | 'CONFIRMED_STOPPED'
    | 'STOP_PENDING_CONFIRMATION'
    | 'PENDING_CONFIRMATION'
    | 'CONTRADICTORY'
    | 'API_UNREACHABLE';
  market: {
    adx: number;
    adxConsecutiveAboveMonitor: number;
    adxConsecutiveAboveStop: number;
    trendPersistent: boolean;
    choppinessIndex: number;
    chopConsecutiveBelowStop: number;
    initialAtrPct: number;
    currentAtrPct: number;
    atrChangePct: number;
    priceDirection: 'UP' | 'DOWN' | 'NEUTRAL';
    volume24hUSDT: number;
    spreadBps: number;
    orderBookDepthUSD: number;
    orderBookImbalance: number;
    fundingRatePct: number;
  };
  performance: {
    gridProfitUSDT: number;
    floatProfitUSDT: number;
    totalPnlUSDT: number;
    netYieldPct: number;
    executedGrids: number;
    activeGrids: number;
    uptimeSec: number;
    estimatedFeesUSDT: number;
    estimatedFundingCostUSDT: number;
    netProfitAfterCostsUSDT: number;
  };
  risk: {
    distToLowerLimitPct: number;
    distToUpperLimitPct: number;
    minDistToEdgePct: number;
    accumulatedPositionUSD: number;
    marginUsedUSDT: number;
    liqPx: number;
    distToLiqPct: number;
    drawdownPct: number;
    liquidityDegraded: boolean;
  };
  stagnation: GridStagnationMetrics;
  cadence: {
    lastReconcile30sAt: number;
    lastPrice1mAt: number;
    lastMarket5mAt: number;
    lastFullEval15mAt: number;
  };
  lastStopReason?: string;
  updatedAt: number;
}

export interface GridAnalyzerStopEvent {
  idempotencyKey: string;
  timestamp: number;
  algoId: string;
  instId: string;
  eventType: 'STOP' | 'EMERGENCY' | 'OPERATIONAL_ERROR';
  exactStopReason: string;
  triggeringIndicators: {
    adx: number;
    choppinessIndex: number;
    initialAtrPct: number;
    currentAtrPct: number;
    atrChangePct: number;
    spreadBps: number;
    orderBookDepthUSD: number;
    fundingRatePct: number;
    priceDirection: string;
  };
  botParameters: {
    minPx: number;
    maxPx: number;
    gridNum: number;
    runType: '1' | '2';
    lever: number;
    sz: number;
    slTriggerPx?: number;
    tpTriggerPx?: number;
    currentPx: number;
  };
  pnlBreakdown: {
    gridProfitUSDT: number;
    floatProfitUSDT: number;
    totalPnlUSDT: number;
    netYieldPct: number;
  };
  feesAndFunding: {
    estimatedFeesUSDT: number;
    fundingCostUSDT: number;
    netProfitAfterCostsUSDT: number;
  };
  riskMetrics: {
    drawdownPct: number;
    distToLiqPct: number;
    liqPx: number;
    minDistToEdgePct: number;
  };
  stagnationMetrics?: GridStagnationMetrics;
  executedDecision: GridAnalyzerDecision;
  stopType: '1' | '2';
  stopHttpStatus?: 'HTTP_SUCCESS' | 'FAILED';
  stopResult:
    | 'CONFIRMED_STOPPED'
    | 'STOP_PENDING_CONFIRMATION'
    | 'HTTP_SUCCESS'
    | 'SUCCESS'
    | 'PENDING_CONFIRMATION'
    | 'FAILED';
  okxFinalStateConfirmed: boolean;
  okxConfirmedState: string;
  closePositionRequested: boolean;
  closePositionResult:
    | 'CLOSE_POSITION_CONFIRMED'
    | 'STOP_PENDING_CONFIRMATION'
    | 'HTTP_SUCCESS'
    | 'SUCCESS'
    | 'FAILED'
    | 'NOT_REQUESTED';
}

export interface GridAnalyzerStatusSummary {
  monitoredBotsCount: number;
  activeNativeBotsCount: number;
  stoppedNativeBotsCount: number;
  totalPnlUSDT: number;
  overallRiskLevel: 'LOW' | 'ELEVATED' | 'WARNING' | 'CRITICAL';
  okxConnectionOk: boolean;
  reconciliationStatus: 'SYNCED' | 'RECONCILING' | 'CONTRADICTORY' | 'DEGRADED';
  lastReconcileAt: number;
  thresholds: GridAnalyzerThresholds;
  botSnapshots: GridBotAnalysisSnapshot[];
  stopEvents: GridAnalyzerStopEvent[];
}

export interface Position {
  id: string;
  symbol: string;
  side: OrderSide;
  qty: number;
  entryPrice: number;
  sizeUSDT: number;
  status: PositionStatus;
  entryTime: number;
  profile: ProfileType;
  executionMode: ExecutionMode;
  [key: string]: any;
}

export interface OrderRecord {
  id: string;
  symbol: string;
  side: OrderSide;
  orderType: 'Market' | 'Limit';
  qty: number;
  sizeUSDT: number;
  feeUSDT?: number;
  status: OrderStatus;
  price?: number;
  createdTime: number;
  updatedTime: number;
  intent: string;
  profile: ProfileType;
  executionMode: ExecutionMode;
  botId?: string;
  gridLevelIndex?: number;
  [key: string]: any;
}

export interface AuditLog {
  id: string;
  timestamp: number;
  type: AuditLogType;
  message: string;
  details?: any;
}

export interface ScannerStats {
  universeCount: number;
  filteredCount: number;
  candidatesCount: number;
  lastScanDurationMs: number;
  lastScanTimestamp: number;
  isScanning: boolean;
  topOpportunities: ScannedOpportunity[];
  gridCandidates?: GridCandidateAnalysis[];
  filterConfig: UniverseFilterConfig;
  [key: string]: any;
}

export interface TelegramConfigStatus {
  configured: boolean;
  hasToken: boolean;
  hasChatId: boolean;
  maskedToken: string;
  chatId: string;
  botUsername?: string;
  notificationsEnabled?: boolean;
}

export interface ScannedOpportunity { [key: string]: any; }

export interface Kline {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  isConfirmed?: boolean;
  [key: string]: any;
}

export interface OKXRawPosition {
  symbol: string;
  side: 'Buy' | 'Sell' | 'None';
  posSide?: 'long' | 'short' | 'net';
  mgnMode?: 'cross' | 'isolated';
  size: number;
  avgPrice: number;
  unrealisedPnl: number;
  markPrice: number;
  leverage: string;
  updatedTime: number;
  [key: string]: any;
}

