import { BybitAdapter } from '../exchange/BybitAdapter';
import { PositionManager } from '../position/PositionManager';
import {
  TradeSignal,
  RiskApproval,
  OrderRecord,
  OrderStatus,
  OrderSide,
  Position,
  ProfileType,
  AuditLogType,
} from '../../shared/types';

export class OrderManager {
  private exchange: BybitAdapter;
  private positionManager: PositionManager;
  private orders: Map<string, OrderRecord> = new Map();
  private auditLogger: (type: AuditLogType, message: string, details?: any) => void;

  constructor(
    exchange: BybitAdapter,
    positionManager: PositionManager,
    auditLogger: (type: AuditLogType, message: string, details?: any) => void
  ) {
    this.exchange = exchange;
    this.positionManager = positionManager;
    this.auditLogger = auditLogger;
  }

  public getOrders(): OrderRecord[] {
    return Array.from(this.orders.values()).sort((a, b) => b.createdTime - a.createdTime);
  }

  public getOrder(id: string): OrderRecord | undefined {
    return this.orders.get(id);
  }

  /**
   * Primary entry point for signal-based orders.
   * STRICT CONSTRAINT: Must have a valid, approved RiskApproval from RiskEngine!
   */
  public async executeSignalOrder(params: {
    signal: TradeSignal;
    riskApproval: RiskApproval;
    currentPrice: number;
    profile: ProfileType;
  }): Promise<{ success: boolean; order?: OrderRecord; error?: string }> {
    const { signal, riskApproval, currentPrice, profile } = params;

    // 1. Mandatory Risk Validation Check
    if (!riskApproval || !riskApproval.approved || riskApproval.sizeUSDT <= 0) {
      const reason = riskApproval?.reason || 'Risk Engine rejected trade';
      this.auditLogger('RISK_REJECTED', `Signal for ${signal.symbol} rejected by Risk Engine: ${reason}`, {
        symbol: signal.symbol,
        score: signal.score,
        reason,
      });
      return { success: false, error: reason };
    }

    this.auditLogger('RISK_APPROVED', `Risk Engine approved ${signal.side} ${signal.symbol} for $${riskApproval.sizeUSDT.toFixed(2)}`, {
      symbol: signal.symbol,
      sizeUSDT: riskApproval.sizeUSDT,
      profile,
    });

    if (currentPrice <= 0) {
      return { success: false, error: `Invalid current price: ${currentPrice}` };
    }

    // 2. Quantity calculation & precision formatting according to Bybit rules
    const targetQty = riskApproval.sizeUSDT / currentPrice;
    const formattedQty = await this.exchange.formatQuantity(signal.symbol, targetQty, currentPrice);

    if (formattedQty <= 0) {
      const err = `Formatted quantity for ${signal.symbol} is 0 (below minOrderQty)`;
      this.auditLogger('ORDER_FAILED', err, { symbol: signal.symbol, targetQty });
      return { success: false, error: err };
    }

    const clientOrderId = `tb5_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

    // 3. Create Order Record (CREATED)
    const orderRecord: OrderRecord = {
      id: clientOrderId,
      symbol: signal.symbol,
      side: signal.side,
      orderType: 'Market',
      qty: formattedQty,
      sizeUSDT: formattedQty * currentPrice,
      status: 'CREATED',
      createdTime: Date.now(),
      updatedTime: Date.now(),
      intent: 'ENTRY',
      profile,
    };

    this.orders.set(clientOrderId, orderRecord);

    // 4. Submit Order to Bybit Testnet (SUBMITTED)
    orderRecord.status = 'SUBMITTED';
    orderRecord.updatedTime = Date.now();
    this.auditLogger('ORDER_SUBMITTED', `Submitting Market ${signal.side} ${signal.symbol} (Qty: ${formattedQty}) to Bybit Testnet`, {
      orderId: clientOrderId,
      symbol: signal.symbol,
      side: signal.side,
      qty: formattedQty,
    });

    try {
      const bybitSide = signal.side === 'BUY' ? 'Buy' : 'Sell';
      const submitRes = await this.exchange.submitOrder({
        symbol: signal.symbol,
        side: bybitSide,
        orderType: 'Market',
        qty: formattedQty,
        orderLinkId: clientOrderId,
      });

      // 5. Order Accepted by Exchange (ACCEPTED)
      orderRecord.status = 'ACCEPTED';
      orderRecord.exchangeOrderId = submitRes.orderId;
      orderRecord.updatedTime = Date.now();
      this.auditLogger('ORDER_ACCEPTED', `Bybit accepted order ${clientOrderId} (Exchange ID: ${submitRes.orderId})`, {
        orderId: clientOrderId,
        exchangeOrderId: submitRes.orderId,
      });

      // 6. Confirmation of Execution (Check fill status)
      const confirmed = await this.pollExecutionConfirmation(orderRecord, 5, 1000);
      const currentStatus = orderRecord.status as OrderStatus;

      if (confirmed && (currentStatus === 'FILLED' || currentStatus === 'PARTIALLY_FILLED')) {
        // 7. Update PositionManager with real confirmed fill values
        const finalFillPrice = orderRecord.fillPrice || currentPrice;
        const finalFilledQty = orderRecord.filledQty || formattedQty;

        await this.positionManager.onOrderFilled({
          ...orderRecord,
          fillPrice: finalFillPrice,
          filledQty: finalFilledQty,
        });

        return { success: true, order: orderRecord };
      } else {
        // Order accepted but not confirmed filled yet (could be pending or slow response)
        this.auditLogger('ORDER_PARTIALLY_FILLED', `Order ${clientOrderId} submitted; waiting for async fill confirmation`, {
          order: orderRecord,
        });
        return { success: true, order: orderRecord };
      }
    } catch (err: any) {
      orderRecord.status = 'REJECTED';
      orderRecord.rejectionReason = err.message || 'Execution error';
      orderRecord.updatedTime = Date.now();

      this.auditLogger('ORDER_REJECTED', `Order ${clientOrderId} rejected on Bybit: ${err.message}`, {
        orderId: clientOrderId,
        symbol: signal.symbol,
        error: err.message,
      });

      return { success: false, order: orderRecord, error: err.message };
    }
  }

  /**
   * Executes a close order on Bybit for an open position.
   * Ensures that the position is only marked closed locally after Bybit confirms fill!
   */
  public async executeCloseOrder(params: {
    position: Position;
    reason: 'STOP_LOSS' | 'TRAILING_STOP' | 'KILL_SWITCH' | 'MANUAL_CLOSE';
    currentPrice?: number;
  }): Promise<{ success: boolean; order?: OrderRecord; error?: string }> {
    const { position, reason, currentPrice } = params;

    if (position.status !== 'OPEN') {
      return { success: false, error: `Position ${position.symbol} is already closed.` };
    }

    const closeSide: OrderSide = position.side === 'BUY' ? 'SELL' : 'BUY';
    const bybitSide: 'Buy' | 'Sell' = closeSide === 'BUY' ? 'Buy' : 'Sell';
    const clientOrderId = `tb5_close_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

    // Quantity to close equals the position quantity (with fallback for legacy records)
    const estPrice = currentPrice || position.entryPrice;
    const rawQty = position.qty && !isNaN(position.qty) && position.qty > 0
      ? position.qty
      : (position.sizeUSDT / (position.entryPrice || 1));
    const formattedQty = await this.exchange.formatQuantity(position.symbol, rawQty, estPrice);

    const closeOrder: OrderRecord = {
      id: clientOrderId,
      symbol: position.symbol,
      side: closeSide,
      orderType: 'Market',
      qty: formattedQty,
      sizeUSDT: formattedQty * estPrice,
      status: 'CREATED',
      createdTime: Date.now(),
      updatedTime: Date.now(),
      intent: reason,
      profile: position.profile,
    };

    this.orders.set(clientOrderId, closeOrder);

    this.auditLogger('ORDER_SUBMITTED', `Submitting Close Order for ${position.symbol} (${reason}) - Side: ${bybitSide}, Qty: ${formattedQty}`, {
      orderId: clientOrderId,
      symbol: position.symbol,
      reason,
      qty: formattedQty,
    });

    closeOrder.status = 'SUBMITTED';

    try {
      const submitRes = await this.exchange.submitOrder({
        symbol: position.symbol,
        side: bybitSide,
        orderType: 'Market',
        qty: formattedQty,
        orderLinkId: clientOrderId,
        reduceOnly: true,
      });

      closeOrder.status = 'ACCEPTED';
      closeOrder.exchangeOrderId = submitRes.orderId;
      closeOrder.updatedTime = Date.now();

      this.auditLogger('ORDER_ACCEPTED', `Close order accepted by Bybit (ID: ${submitRes.orderId}) for ${position.symbol}`, {
        orderId: clientOrderId,
        exchangeOrderId: submitRes.orderId,
      });

      // Confirm fill on Bybit
      const confirmed = await this.pollExecutionConfirmation(closeOrder, 5, 800);

      const exitPrice = closeOrder.fillPrice || estPrice;
      const exitTime = closeOrder.updatedTime || Date.now();

      // IMPORTANT: Only mark position closed after Bybit confirmation!
      await this.positionManager.markPositionClosed(position.id, exitPrice, exitTime, reason);

      this.auditLogger('POSITION_CLOSED', `Position ${position.symbol} closed on Bybit at $${exitPrice.toFixed(4)} (${reason})`, {
        positionId: position.id,
        symbol: position.symbol,
        exitPrice,
        reason,
      });

      return { success: true, order: closeOrder };
    } catch (err: any) {
      closeOrder.status = 'FAILED';
      closeOrder.rejectionReason = err.message || 'Close order failed';
      closeOrder.updatedTime = Date.now();

      this.auditLogger('ORDER_FAILED', `CRITICAL: Failed to close position ${position.symbol} on Bybit: ${err.message}`, {
        positionId: position.id,
        symbol: position.symbol,
        error: err.message,
        reason,
      });

      return { success: false, order: closeOrder, error: err.message };
    }
  }

  /**
   * Polls Bybit REST order status for execution confirmation
   */
  private async pollExecutionConfirmation(
    order: OrderRecord,
    maxAttempts: number = 5,
    delayMs: number = 1000
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await new Promise((r) => setTimeout(r, delayMs));

      const statusRes = await this.exchange.queryOrderStatus(order.symbol, order.id, order.exchangeOrderId);

      if (statusRes) {
        order.status = statusRes.status;
        order.filledQty = statusRes.filledQty;
        if (statusRes.avgPrice > 0) {
          order.fillPrice = statusRes.avgPrice;
        }
        order.cumFee = statusRes.cumFee;
        order.updatedTime = Date.now();

        if (order.status === 'FILLED') {
          this.auditLogger('ORDER_FILLED', `Confirmed Fill on Bybit: ${order.symbol} @ $${order.fillPrice || 'Market'} (Qty: ${order.filledQty})`, {
            orderId: order.id,
            symbol: order.symbol,
            fillPrice: order.fillPrice,
            filledQty: order.filledQty,
          });
          return true;
        } else if (order.status === 'PARTIALLY_FILLED') {
          this.auditLogger('ORDER_PARTIALLY_FILLED', `Partially Filled on Bybit: ${order.symbol} (${order.filledQty} / ${order.qty})`, {
            orderId: order.id,
            filledQty: order.filledQty,
          });
        } else if (order.status === 'CANCELLED' || order.status === 'REJECTED' || order.status === 'FAILED') {
          this.auditLogger('ORDER_FAILED', `Order ended with status ${order.status} on Bybit`, {
            orderId: order.id,
            rawStatus: statusRes.rawStatus,
          });
          return false;
        }
      }
    }

    return order.status === 'FILLED';
  }

  /**
   * Handler for asynchronous WebSocket execution & order stream events
   */
  public handleWsOrderUpdate(wsData: any) {
    const orderLinkId = wsData.orderLinkId;
    if (!orderLinkId) return;

    const order = this.orders.get(orderLinkId);
    if (!order) return;

    const rawStatus = wsData.orderStatus;
    if (rawStatus === 'Filled') {
      order.status = 'FILLED';
      order.fillPrice = parseFloat(wsData.avgPrice || wsData.lastExecPrice || '0');
      order.filledQty = parseFloat(wsData.cumExecQty || wsData.qty || '0');
      order.cumFee = parseFloat(wsData.cumExecFee || '0');
      order.updatedTime = Date.now();

      this.auditLogger('ORDER_FILLED', `WS Confirmed Fill: ${order.symbol} @ $${order.fillPrice}`, {
        orderId: order.id,
        symbol: order.symbol,
      });

      if (order.intent === 'ENTRY') {
        this.positionManager.onOrderFilled(order);
      }
    } else if (rawStatus === 'Cancelled') {
      order.status = 'CANCELLED';
      order.updatedTime = Date.now();
      this.auditLogger('ORDER_CANCELLED', `WS: Order ${order.id} cancelled on Bybit`, { orderId: order.id });
    }
  }
}
