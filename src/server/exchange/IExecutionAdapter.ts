import { Kline, BybitRawPosition, OrderStatus } from '../../shared/types';
import { InstrumentLotFilter, ConnectionTestResult } from './BybitAdapter';

export interface IExecutionAdapter {
  testConnection(): Promise<ConnectionTestResult>;
  getEquity(): Promise<number>;
  getKlines(symbol: string, interval: string, limit?: number): Promise<Kline[]>;
  getTickerPrice(symbol: string): Promise<number | null>;
  getInstrumentFilter(symbol: string): Promise<InstrumentLotFilter>;
  formatQuantity(symbol: string, desiredQty: number, currentPrice: number): Promise<number>;
  getOpenPositions(settleCoin?: string): Promise<BybitRawPosition[]>;
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
    status: OrderStatus;
    filledQty: number;
    avgPrice: number;
    cumFee: number;
    rawStatus: string;
  } | null>;
  cancelOrder(symbol: string, orderId?: string, orderLinkId?: string): Promise<boolean>;
  hasCredentials(): boolean;
  isTestnet(): boolean;
  updateCredentials?(apiKey: string, apiSecret: string, testnet?: boolean): void;
  initWebSocket?(symbols?: string[]): void;
  close?(): void;

  onTickerUpdate?: (symbol: string, lastPrice: number) => void;
  onOrderUpdate?: (order: any) => void;
  onExecutionUpdate?: (execution: any) => void;
  onPositionUpdate?: (position: any) => void;
  onWalletUpdate?: (wallet: any) => void;
  onConnectionChange?: (connected: boolean, message: string) => void;
}
