import { Kline, OKXRawPosition, OrderStatus } from '../../shared/types';

export interface InstrumentLotFilter {
  symbol: string;
  minOrderQty: number;
  maxOrderQty: number;
  qtyStep: number;
  minNotionalValue: number;
  tickSize: number;
  ctVal?: number;
  ctValCcy?: string;
}

export interface ConnectionTestResult {
  reachable: boolean;
  authenticated: boolean;
  accountType?: string;
  equity?: number;
  error?: string;
}

export interface IExecutionAdapter {
  testConnection(): Promise<ConnectionTestResult>;
  getEquity(): Promise<number>;
  getKlines(symbol: string, interval: string, limit?: number): Promise<Kline[]>;
  getTickerPrice(symbol: string): Promise<number | null>;
  getInstrumentFilter(symbol: string): Promise<InstrumentLotFilter>;
  formatQuantity(symbol: string, desiredQty: number, currentPrice: number): Promise<number>;
  getOpenPositions(settleCoin?: string): Promise<OKXRawPosition[]>;
  submitOrder(params: {
    symbol: string;
    side: 'Buy' | 'Sell';
    orderType: 'Market' | 'Limit';
    qty: number;
    price?: number;
    orderLinkId: string;
    reduceOnly?: boolean;
  }): Promise<{ orderId: string; orderLinkId: string }>;
  queryOrderStatus(
    symbol: string,
    orderLinkId: string,
    exchangeOrderId?: string
  ): Promise<{
    orderId?: string;
    status: OrderStatus;
    filledQty: number;
    avgPrice: number;
    cumFee: number;
    rawStatus: string;
  } | null>;
  cancelOrder(symbol: string, orderId?: string, orderLinkId?: string): Promise<boolean>;
  hasCredentials(): boolean;
  isTestnet(): boolean;
  updateCredentials?(apiKey: string, secretKey: string, passphrase?: string, isDemo?: boolean): void;
  initWebSocket?(symbols?: string[]): void;
  close?(): void;

  onTickerUpdate?: (symbol: string, lastPrice: number) => void;
  onOrderUpdate?: (order: any) => void;
  onExecutionUpdate?: (execution: any) => void;
  onPositionUpdate?: (position: any) => void;
  onWalletUpdate?: (wallet: any) => void;
  onConnectionChange?: (connected: boolean, message: string) => void;
}

