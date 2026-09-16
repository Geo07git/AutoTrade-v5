export type ProfileType = 'SCALP' | 'MOMENTUM';
export type OrderSide = 'BUY' | 'SELL';
export type PositionStatus = 'OPEN' | 'CLOSED';
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
  | 'UNIVERSE_REFRESH'
  | 'UNIVERSE_FILTERED'
  | 'SCAN_STARTED'
  | 'SCAN_COMPLETED'
  | 'SCAN_ERROR'
  | 'CANDIDATE_SELECTED'
  | 'CANDIDATE_REJECTED'
  | 'RECOVERY'
  | 'SYSTEM'
  | 'ERROR';

export interface UniverseFilterConfig {
  min24hVolumeUSDT: number;
  minPrice: number;
  maxSymbols: number;
  settleCoin: string;
  refreshIntervalMs: number;
}

export interface ScannedOpportunity {
  symbol: string;
  price: number;
  volume24hUSDT: number;
  priceChange24hPct: number;
  rvol: number;
  atrExpansion: number;
  score: number;
  side: OrderSide;
  isEligible: boolean;
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
  bybitApiKey?: string;
  bybitApiSecret?: string;
  paperEquity?: number;
  maxLeverage?: number;
  watchlist?: string[];
  scannerFilter?: UniverseFilterConfig;
  profiles?: Record<ProfileType, ProfileConfig>;
}

export interface ProfileConfig {
  type: ProfileType;
  timeframes: string[]; // e.g. ['15', '60'] or ['60', '240']
  riskPerTradePct: number;
  maxOpenPositions: number;
  trailingActivationPct: number;
  trailingDistancePct: number;
  hardStopLossPct: number;
  equityProtectionActivationPct: number;
  equityTrailingDrawdownPct: number;
  minMomentumScore?: number;
  maxHoldingTimeMinutes?: number;
  cooldownMinutes?: number;
}

export interface Kline {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TradeSignal {
  symbol: string;
  side: OrderSide;
  score: number;
  profile: ProfileType;
  timestamp: number;
  reasons: any;
}

export interface RiskApproval {
  approved: boolean;
  sizeUSDT: number;
  estimatedQty?: number;
  reason?: string;
}

export interface OrderRecord {
  id: string; // Internal / clientOrderId
  exchangeOrderId?: string;
  symbol: string;
  side: OrderSide;
  orderType: 'Market' | 'Limit';
  qty: number;
  sizeUSDT: number;
  status: OrderStatus;
  fillPrice?: number;
  filledQty?: number;
  cumFilledQty?: number;
  processedFilledQty?: number;
  cumFee?: number;
  createdTime: number;
  updatedTime: number;
  rejectionReason?: string;
  intent: 'ENTRY' | 'STOP_LOSS' | 'TRAILING_STOP' | 'KILL_SWITCH' | 'MANUAL_CLOSE' | 'EQUITY_PROTECTION' | 'TIME_STOP';
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
  exitTime?: number;
  exitPrice?: number;
  pnl?: number;
  pnlPct?: number;
  grossPnl?: number;
  entryFee?: number;
  exitFee?: number;
  highestPrice?: number;
  lowestPrice?: number;
  profile: ProfileType;
  source: 'LOCAL' | 'BYBIT_SYNC' | 'PAPER';
  executionMode: ExecutionMode;
}

export interface BybitRawPosition {
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

export interface BotStatusResponse {
  state: BotState;
  executionMode: ExecutionMode;
  config: AppConfig;
  profileConfig: ProfileConfig;
  profiles?: Record<ProfileType, ProfileConfig>;
  equity: number;
  equityHistory?: EquityDataPoint[];
  sessionRealizedPnL?: number;
  positions: Position[];
  orders: OrderRecord[];
  connected: boolean;
  lastSyncTime: number;
  scannerStats?: ScannerStats;
}

