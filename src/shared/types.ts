export type ProfileType = 'SCALP' | 'MOMENTUM';
export type OrderSide = 'BUY' | 'SELL';
export type PositionStatus = 'OPEN' | 'CLOSING' | 'CLOSED';
export type ExecutionMode = 'PAPER' | 'TESTNET' | 'LIVE';

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
  | 'SIGNAL_GENERATED'
  | 'SIGNAL_REJECTED'
  | 'RISK_APPROVED'
  | 'RISK_REJECTED'
  | 'ORDER_SUBMITTED'
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
  | 'PROFIT_VAULT_DEPOSIT'
  | 'PROFIT_VAULT_RESET'
  | 'SYSTEM'
  | 'ERROR';

export interface UniverseFilterConfig {
  min24hVolumeUSDT: number;
  max24hVolumeUSDT?: number;
  minPrice: number;
  maxSymbols: number;
  settleCoin: string;
  refreshIntervalMs: number;
  maxSpreadPct?: number; // Max allowed bid-ask spread % (e.g. 0.15% to eliminate wide-spread tokens)
  excludedSymbols?: string[]; // Underperforming or high-spread tokens excluded from trading
}

export interface ScannedOpportunity {
  symbol: string;
  price: number;
  volume24hUSDT: number;
  priceChange24hPct: number;
  rvol: number;
  atrExpansion: number;
  currentAtr?: number;
  atrPct?: number;
  score: number;
  side: OrderSide;
  isEligible: boolean;
  isFadeTrade?: boolean;
  originalSide?: OrderSide;
  signal?: TradeSignal;
  rank: number;
  lastScannedTime: number;
}

export interface ScannerStats {
  universeCount: number;
  filteredCount: number;
  candidatesCount: number;
  lastScanDurationMs: number;
  lastScanTimestamp: number;
  isScanning: boolean;
  topOpportunities: ScannedOpportunity[];
  filterConfig: UniverseFilterConfig;
}

export interface AppConfig {
  executionMode: ExecutionMode;
  activeProfile: ProfileType;
  testnet: boolean;
  killSwitchEngaged: boolean;
  invertSignals?: boolean; // Experimental: Invert Long <-> Short signals
  okxApiKey?: string;
  okxSecretKey?: string;
  okxPassphrase?: string;
  paperEquity?: number;
  maxLeverage?: number;
  watchlist?: string[];
  scannerFilter?: UniverseFilterConfig;
  profiles?: Record<ProfileType, ProfileConfig>;
  telegramBotToken?: string;
  telegramChatId?: string;
  telegramAlertsEnabled?: boolean;
  lockProfitVault?: boolean; // Profit Vault Mode: Locks profits into an untouchable vault
  baseCapital?: number; // Fixed base operating capital (e.g. 1000 USDT or 200 USDT)
  profitVault?: number; // Total protected profit stored in vault
}

export interface ProfileConfig {
  type: ProfileType;
  timeframes: string[]; // e.g. ['15', '60'] or ['60', '240']
  riskPerTradePct: number;
  maxOpenPositions: number;
  trailingActivationPct: number;
  trailingDistancePct: number;
  breakEvenActivationPct: number;
  takeProfitPct: number; // 0 means Off
  hardStopLossPct: number;
  equityProtectionActivationPct: number;
  equityTrailingDrawdownPct: number;
  minMomentumScore?: number;
  maxMomentumScore?: number;
  min24hVolumeUSDT?: number; // Prag inferior volum/turnover 24h în USDT (ex: 1_000_000 = 1.0M)
  max24hVolumeUSDT?: number; // Prag superior volum/turnover 24h în USDT (ex: 1_500_000 = 1.5M, 0 = nelimitat)
  maxHoldingTimeMinutes?: number;
  stagnationTimeMinutes?: number; // Time-stop eșalonat la stagnare (ex: 30 min)
  stagnationMinPeakPct?: number; // Prag minim de impuls de vârf cerut la stagnare (ex: +0.5%)
  cooldownMinutes?: number;
  sentimentThreshold?: number; // Global sentiment score threshold (% benchmark change)
}

export interface Kline {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type SymbolConfidenceStatus = 'LOW_SAMPLE' | 'DEVELOPING' | 'HIGH_CONFIDENCE';

export interface SymbolTradeRecord {
  positionId: string;
  symbol: string;
  pnl: number;
  pnlPct: number;
  mfePct: number;
  maePct?: number;
  holdingTimeMinutes?: number;
  timeToMfe15Minutes?: number; // Time in minutes to achieve MFE >= 1.5%
  isFastRunner?: boolean; // True if MFE >= 1.5% reached within <= 5 min
  exitTime: number;
  hitMfe15: boolean; // mfePct >= 1.5%
  isWin: boolean;
  intent?: string;
}

export interface SymbolRollingStats {
  symbol: string;
  n: number; // total trades in rolling window (max 30)
  wins: number;
  losses: number;
  winrate: number; // %
  trailingHitCount: number; // trades with MFE >= 1.5%
  hitRateMfe15: number; // % of trades with MFE >= 1.5%
  avgMfe: number; // %
  avgMae: number; // %
  totalPnl: number; // USDT
  avgPnl: number; // USDT
  avgPnlPct: number; // %
  confidenceStatus: SymbolConfidenceStatus;
  recommendedMultiplier: number; // Continuous linear interpolation 0.50x to 1.50x (1.0 default for n < 8)
  lastTradeTime: number;
  avgHoldingMinutes?: number;
  fastRunnerCount?: number; // MFE >= 1.5 reached within <= 5m
  fastRunnerRate?: number; // % of trades in rolling window reaching MFE in <= 5m
  avgTimeToMfeMinutes?: number; // Average minutes until peak MFE was reached
  recentTrades?: SymbolTradeRecord[];
}

export interface SymbolStatsSummary {
  totalTrackedSymbols: number;
  validSampleSymbols: number; // n >= 8
  lowSampleSymbols: number; // n < 8
  topRunnerSymbol?: string;
  topRunnerHitRate?: number;
  worstPerformerSymbol?: string;
  worstPerformerHitRate?: number;
  overallAvgHitRateMfe15: number;
  multiplierActive: boolean;
  lastUpdated: number;
  // Sample & Capital Coverage Metrics
  validCapitalCoveragePct: number; // % of currently open position capital under VALID symbols (n >= 8)
  lowSampleCapitalCoveragePct: number; // % under neutral default symbols (n < 8)
  validCapitalUSDT: number;
  lowSampleCapitalUSDT: number;
  totalActiveCapitalUSDT: number;
  validTradesCoveragePct: number; // % of trades in dataset with valid sample
  validTradesCount: number;
  totalTradesAnalyzed: number;
  fastRunnerPortfolioCount: number; // Total trades across all symbols with MFE in <= 5m
  fastRunnerPortfolioRate: number; // % of trades across portfolio with MFE in <= 5m
}

export interface TradeSignal {
  symbol: string;
  side: OrderSide;
  originalSide?: OrderSide;
  isFadeTrade?: boolean;
  score: number;
  profile: ProfileType;
  timestamp: number;
  reasons: any;
  currentPrice?: number;
  currentAtr?: number;
  atrPct?: number;
  stopLossPrice?: number;
}

export interface RiskApproval {
  approved: boolean;
  sizeUSDT: number;
  estimatedQty?: number;
  reason?: string;
  stopLossPrice?: number;
  effectiveStopDistancePct?: number;
  dollarRiskAtStop?: number;
  atrPct?: number;
}

export interface OrderRecord {
  id: string; // Internal / clientOrderId
  exchangeOrderId?: string;
  positionId?: string; // Direct link between ENTRY and CLOSE orders
  symbol: string;
  side: OrderSide;
  orderType: 'Market' | 'Limit';
  qty: number;
  ctVal?: number;
  sizeUSDT: number;
  status: OrderStatus;
  stopLossPrice?: number;
  isFadeTrade?: boolean;
  fillPrice?: number;
  filledQty?: number;
  cumFilledQty?: number;
  processedFilledQty?: number;
  cumFee?: number;
  processedFee?: number;
  createdTime: number;
  updatedTime: number;
  rejectionReason?: string;
  intent: 'ENTRY' | 'STOP_LOSS' | 'TRAILING_STOP' | 'TAKE_PROFIT' | 'KILL_SWITCH' | 'MANUAL_CLOSE' | 'EQUITY_PROTECTION' | 'TIME_STOP';
  profile: ProfileType;
  executionMode: ExecutionMode;
  // Detailed exit / profit / log telemetry
  realizedPnl?: number;
  realizedPnlPct?: number;
  entryPrice?: number;
  exitReasonDetail?: string;
  triggerStopValue?: number;
  trailingPeakPct?: number;
  trailingDistancePct?: number;
  holdingTimeMinutes?: number;
  marketRegime?: string; // BTC regime at ENTRY
  exitMarketRegime?: string; // BTC regime at EXIT
  positionSide?: OrderSide;
  // Quantitative telemetry fields
  signalScore?: number; // Model score / probability (metaScore) at entry
  signalPrice?: number; // Price at signal generation
  estimatedSlippagePct?: number; // Slippage (fill price vs signal price) %
  leverage?: string; // Leverage used (e.g. '1x')
  openPositionsCount?: number; // Number of open positions at entry/exit moment
  maePct?: number; // Maximum Adverse Excursion % (worst unrealized PnL% during position life)
  mfePct?: number; // Maximum Favorable Excursion % (best unrealized PnL% during position life)
  timeToMfe15Minutes?: number; // Minutes from entry until MFE >= 1.5% reached (passive velocity telemetry)
  isFastRunner?: boolean; // True if MFE >= 1.5% was reached in <= 5 minutes
  accountEquity?: number; // Account total equity at order time
  accountBalance?: number; // Account wallet balance at order time
}

export interface Position {
  id: string;
  symbol: string;
  side: OrderSide;
  originalSide?: OrderSide;
  isFadeTrade?: boolean;
  qty: number;
  entryPrice: number;
  ctVal?: number;
  sizeUSDT: number;
  status: PositionStatus;
  entryTime: number;
  exitTime?: number;
  exitPrice?: number;
  pnl?: number;
  pnlPct?: number;
  grossPnl?: number;
  entryFee?: number;
  exitFee?: number;
  highestPrice?: number;
  lowestPrice?: number;
  maePct?: number;
  mfePct?: number;
  timeToMfe15Minutes?: number; // Minutes from entry until MFE >= 1.5% reached (passive velocity telemetry)
  isFastRunner?: boolean; // True if MFE >= 1.5% was reached in <= 5 minutes
  stopLossPrice?: number;
  isBreakEvenTriggered?: boolean;
  currentPrice?: number;
  holdingTimeMinutes?: number;
  exitReasonDetail?: string;
  profile: ProfileType;
  source: 'LOCAL' | 'OKX_SYNC' | 'PAPER';
  executionMode: ExecutionMode;
  marketRegime?: string; // BTC regime at ENTRY
  exitMarketRegime?: string; // BTC regime at EXIT
  entryOrderId?: string;
  closeOrderId?: string;
  signalScore?: number; // metaScore at entry
  signalPrice?: number;
  estimatedSlippagePct?: number;
  leverage?: string;
  openPositionsAtEntry?: number;
  openPositionsAtExit?: number;
  accountEquityAtEntry?: number;
  accountEquityAtExit?: number;
}

export interface OKXRawPosition {
  symbol: string;
  side: 'Buy' | 'Sell' | 'None';
  size: number;
  avgPrice: number;
  unrealisedPnl: number;
  markPrice: number;
  leverage: string;
  updatedTime: number;
}

export interface AuditLog {
  id: string;
  timestamp: number;
  type: AuditLogType;
  message: string;
  details?: any;
}

export interface EquityDataPoint {
  time: number;
  equity: number;
}

export interface EquityProtectionClosedPositionSummary {
  symbol: string;
  side: OrderSide;
  sizeUSDT: number;
  entryPrice: number;
  closePrice: number;
  pnl?: number;
  holdingTimeMinutes?: number;
  exitReasonDetail?: string;
}

export interface EquityProtectionEvent {
  id: string;
  triggerIndex: number;
  timestamp: number;
  dateStr: string;
  profile: ProfileType;
  executionMode: ExecutionMode;
  peakEquity: number;
  effectiveEquity: number;
  totalEquity: number;
  drawdownFromPeakPct: number;
  configuredDrawdownLimitPct: number;
  activationPrice: number;
  activationPct: number;
  vaultBefore: number;
  profitLockedToVault: number;
  vaultAfter: number;
  baseCapital: number;
  closedPositionsCount: number;
  closedPositions: EquityProtectionClosedPositionSummary[];
}

export interface EquityTrailingState {
  isEnabled?: boolean;
  isActive: boolean;
  activationPrice: number;
  activationTotalEquity?: number;
  activationPct: number;
  peakEquity: number;
  peakTotalEquity?: number;
  drawdownLimitPct: number;
  currentDrawdownPct: number;
  sellThreshold: number | null;
  sellThresholdTotal?: number | null;
  triggerCount: number;
  workingEquity?: number;
  profitVault?: number;
  history?: EquityProtectionEvent[];
}

export interface PerformanceMetrics {
  totalClosed: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  profitFactor: number;
  expectancy: number;
  avgWin: number;
  avgLoss: number;
  maxDrawdownPct: number;
  totalFeesPaid: number;
  totalGrossProfit?: number;
  totalGrossLoss?: number;
}

export interface BotStatusResponse {
  state: BotState;
  executionMode: ExecutionMode;
  config: AppConfig;
  profileConfig: ProfileConfig;
  profiles?: Record<ProfileType, ProfileConfig>;
  equity: number;
  initialEquity?: number;
  walletBalance?: number;
  freeBalance?: number;
  marginInvested?: number;
  unrealizedPnL?: number;
  totalProfit?: number;
  totalProfitPct?: number;
  profitVault?: number; // Protected profit locked in vault (intangible reserve)
  operatingEquity?: number; // Active capital used for trade sizing and risk evaluation
  usableFreeBalance?: number; // Free balance excluding profit vault
  baseCapital?: number; // Configured fixed operating base capital
  lockProfitVault?: boolean; // Profit vault mode enabled/disabled
  equityHistory?: EquityDataPoint[];
  sessionRealizedPnL?: number;
  performanceMetrics?: PerformanceMetrics;
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
  equityTrailingState?: EquityTrailingState;
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

