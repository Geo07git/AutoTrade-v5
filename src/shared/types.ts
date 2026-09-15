export type ProfileType = 'SCALP' | 'MOMENTUM';
export type OrderSide = 'BUY' | 'SELL';
export type PositionStatus = 'OPEN' | 'CLOSED';

export interface AppConfig {
  activeProfile: ProfileType;
  testnet: boolean;
  killSwitchEngaged: boolean;
  bybitApiKey?: string;
  bybitApiSecret?: string;
}

export interface ProfileConfig {
  type: ProfileType;
  timeframes: string[]; // e.g. ['15m', '1h', '4h']
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

export interface Position {
  id: string;
  symbol: string;
  side: OrderSide;
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
}

export interface AuditLog {
  id: string;
  timestamp: number;
  type: 'SYSTEM' | 'ORDER' | 'POSITION' | 'RISK' | 'ERROR';
  message: string;
  details?: any;
}
