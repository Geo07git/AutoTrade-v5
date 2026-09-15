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
  | 'RECOVERY'
  | 'SYSTEM'
  | 'ERROR';

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
}

export interface ProfileConfig {
  type: ProfileType;
  timeframes: string[]; // e.g. ['15', '60'] or ['60', '240']
  riskPerTradePct: number;
  maxOpenPositions: number;
  trailingActivationPct: number;
  trailingDistancePct: number;
  hardStopLossPct: number;
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
  intent: 'ENTRY' | 'STOP_LOSS' | 'TRAILING_STOP' | 'KILL_SWITCH' | 'MANUAL_CLOSE';
  profile: ProfileType;
  executionMode: ExecutionMode;
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

export interface BotStatusResponse {
  state: BotState;
  executionMode: ExecutionMode;
  config: AppConfig;
  profileConfig: ProfileConfig;
  equity: number;
  positions: Position[];
  orders: OrderRecord[];
  connected: boolean;
  lastSyncTime: number;
}

