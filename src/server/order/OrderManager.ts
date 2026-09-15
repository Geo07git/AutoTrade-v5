import { IExecutionAdapter } from '../exchange/IExecutionAdapter';
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
  ExecutionMode,
} from '../../shared/types';

export class OrderManager {
  private exchange: IExecutionAdapter;
  private positionManager: PositionManager;
  private executionMode: ExecutionMode;
  private orders: Map<string, OrderRecord> = new Map();
  private auditLogger: (type: AuditLogType, message: string, details?: any) => void;

  constructor(
    exchange: IExecutionAdapter,
    positionManager: PositionManager,
    auditLogger: (type: AuditLogType, message: string, details?: any) => void,
    executionMode: ExecutionMode = 'TESTNET'
  ) {
    this.exchange = exchange;
    this.positionManager = positionManager;
    this.auditLogger = auditLogger;
    this.executionMode = executionMode;
  }

  public setExecutionAdapter(adapter: IExecutionAdapter, mode: ExecutionMode) {
    this.exchange = adapter;
    this.executionMode = mode;
  }

  public getOrders(): OrderRecord[] {
    return Array.from(this.orders.values()).sort((a, b) => b.createdTime - a.createdTime);
  }

  public getOrder(id: string): OrderRecord | undefined {
    return this.orders.get(id);
  }

  /**
   * Checks whether there is an in-flight pending order for a given symbol.
   * Prevents duplicate entries!
   */
  public hasPendingOrderForSymbol(symbol: string): boolean {
    for (const order of this.orders.values()) {
      if (order.symbol === symbol) {
        if (
          order.status === 'CREATED' ||
          order.status === 'SUBMITTED' ||
          order.status === 'ACCEPTED' ||
          order.status === 'PARTIALLY_FILLED'
        ) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Primary entry point for signal-based orders.
   * STRICT CONSTRAINTS:
   * 1. Must have a valid, approved RiskApproval from RiskEngine.
   * 2. Must not have an in-flight pending order for this symbol.
   * 3. Must not bypass RiskEngine or OrderManager.
   */
  public async executeSignalOrder(params: {
    signal: TradeSignal;
    riskApproval: RiskApproval;
    currentPrice: number;
    profile: ProfileType;
  }): Promise<{ success: boolean; order?: OrderRecord; error?: string }> {
    const { signal, riskApproval, currentPrice, profile } = params;

    // 1. Check for in-flight pending order for this symbol to prevent duplicate entries
    if (this.hasPendingOrderForSymbol(signal.symbol)) {
      const pendingReason = `Pending order already in-flight for ${signal.symbol}. Duplicate entry strictly prevented.`;
      this.auditLogger('SIGNAL_REJECTED', pendingReason, { symbol: signal.symbol });
      return { success: false, error: pendingReason };
    }

    // 2. Mandatory Risk Validation Check
    if (!riskApproval || !riskApproval.approved || riskApproval.sizeUSDT <= 0) {
      const reason = riskApproval?.reason || 'Risk Engine rejected trade';
      this.auditLogger('RISK_REJECTED', `Signal for ${signal.symbol} rejected by Risk Engine: ${reason}`, {
        symbol: signal.symbol,
        score: signal.score,
        reason,
      });
      return { success: false, error: reason };
    }

    this.auditLogger('RISK_APPROVED', `Risk Engine approved ${signal.side} ${signal.symbol} for $${riskApproval.sizeUSDT.toFixed(2)} (${this.executionMode} mode)`, {
      symbol: signal.symbol,
      sizeUSDT: riskApproval.sizeUSDT,
      profile,
      executionMode: this.executionMode,
    });

    if (currentPrice <= 0) {
      return { success: false, error: `Invalid current price: ${currentPrice}` };
    }

    // 3. Quantity calculation & precision formatting according to exchange lot rules
    const targetQty = riskApproval.sizeUSDT / currentPrice;
    const formattedQty = await this.exchange.formatQuantity(signal.symbol, targetQty, currentPrice);

    if (formattedQty <= 0) {
      const err = `Formatted quantity for ${signal.symbol} is 0 (below minOrderQty)`;
      this.auditLogger('ORDER_FAILED', err, { symbol: signal.symbol, targetQty });
      return { success: false, error: err };
    }

    const clientOrderId = `tb5_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

    // 4. Create Order Record (CREATED)
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
      executionMode: this.executionMode,
    };

    this.orders.set(clientOrderId, orderRecord);

    // 5. Submit Order to Execution Adapter (SUBMITTED)
    orderRecord.status = 'SUBMITTED';
    orderRecord.updatedTime = Date.now();
    this.auditLogger('ORDER_SUBMITTED', `Submitting Market ${signal.side} ${signal.symbol} (Qty: ${formattedQty}) via ${this.executionMode} Adapter`, {
      orderId: clientOrderId,
      symbol: signal.symbol,
      side: signal.side,
      qty: formattedQty,
      mode: this.executionMode,
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

      // 6. Order Accepted by Exchange / Adapter (ACCEPTED)
      orderRecord.status = 'ACCEPTED';
      orderRecord.exchangeOrderId = submitRes.orderId;
      orderRecord.updatedTime = Date.now();
      this.auditLogger('ORDER_ACCEPTED', `Order accepted by ${this.executionMode} (ID: ${submitRes.orderId}) for ${clientOrderId}`, {
        orderId: clientOrderId,
        exchangeOrderId: submitRes.orderId,
      });

      // 7. Confirmation of Execution (Check fill status)
      const confirmed = await this.pollExecutionConfirmation(orderRecord, 5, 800);
      const currentStatus = orderRecord.status as OrderStatus;

      if (confirmed && (currentStatus === 'FILLED' || currentStatus === 'PARTIALLY_FILLED')) {
        // Update PositionManager with real confirmed fill values
        const finalFillPrice = orderRecord.fillPrice || currentPrice;
        const finalFilledQty = orderRecord.filledQty || formattedQty;

        await this.positionManager.onOrderFilled({
          ...orderRecord,
          fillPrice: finalFillPrice,
          filledQty: finalFilledQty,
        });

        return { success: true, order: orderRecord };
      } else {
        // Order accepted but waiting for fill
        this.auditLogger('ORDER_PARTIALLY_FILLED', `Order ${clientOrderId} submitted; waiting for fill confirmation`, {
          order: orderRecord,
        });
        return { success: true, order: orderRecord };
      }
    } catch (err: any) {
      orderRecord.status = 'REJECTED';
      orderRecord.rejectionReason = err.message || 'Execution error';
      orderRecord.updatedTime = Date.now();

      this.auditLogger('ORDER_REJECTED', `Order ${clientOrderId} rejected: ${err.message}`, {
        orderId: clientOrderId,
        symbol: signal.symbol,
        error: err.message,
      });

      return { success: false, order: orderRecord, error: err.message };
    }
  }

  /**
   * Executes a close order for an open position.
   * STRICT SAFETY INVARIANTS:
   * - Never mark position CLOSED without explicit FILLED confirmation.
   * - Handle PARTIALLY_FILLED gracefully without closing the position.
   * - If execution fails, keep position OPEN.
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

    if (this.hasPendingOrderForSymbol(position.symbol)) {
      const err = `A pending order already exists for ${position.symbol}. Close order postponed until pending order completes.`;
      this.auditLogger('ORDER_FAILED', err, { symbol: position.symbol, positionId: position.id });
      return { success: false, error: err };
    }

    const closeSide: OrderSide = position.side === 'BUY' ? 'SELL' : 'BUY';
    const bybitSide: 'Buy' | 'Sell' = closeSide === 'BUY' ? 'Buy' : 'Sell';
    const clientOrderId = `tb5_close_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

    // Quantity to close equals the open position quantity
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
      executionMode: this.executionMode,
    };

    this.orders.set(clientOrderId, closeOrder);

    this.auditLogger('ORDER_SUBMITTED', `Submitting Close Order for ${position.symbol} (${reason}) - Side: ${bybitSide}, Qty: ${formattedQty} via ${this.executionMode}`, {
      orderId: clientOrderId,
      symbol: position.symbol,
      reason,
      qty: formattedQty,
      mode: this.executionMode,
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

      this.auditLogger('ORDER_ACCEPTED', `Close order accepted by ${this.executionMode} (ID: ${submitRes.orderId}) for ${position.symbol}`, {
        orderId: clientOrderId,
        exchangeOrderId: submitRes.orderId,
      });

      // Confirm fill on Exchange / Adapter
      await this.pollExecutionConfirmation(closeOrder, 5, 800);
      const closeStatus = closeOrder.status as OrderStatus;

      // STRICT SAFETY CHECK: Only mark position closed if status is explicitly FILLED!
      if (closeStatus === 'FILLED') {
        const exitPrice = closeOrder.fillPrice || estPrice;
        const exitTime = closeOrder.updatedTime || Date.now();

        await this.positionManager.markPositionClosed(position.id, exitPrice, exitTime, reason);

        this.auditLogger('POSITION_CLOSED', `Position ${position.symbol} closed on ${this.executionMode} at $${exitPrice.toFixed(4)} (${reason})`, {
          positionId: position.id,
          symbol: position.symbol,
          exitPrice,
          reason,
        });

        return { success: true, order: closeOrder };
      } else if (closeStatus === 'PARTIALLY_FILLED' && (closeOrder.filledQty || 0) > 0) {
        // Correct handling of PARTIALLY_FILLED:
        // Position remains OPEN with reduced quantity!
        const exitPrice = closeOrder.fillPrice || estPrice;
        await this.positionManager.handlePartialClose(position.id, closeOrder.filledQty!, exitPrice);

        this.auditLogger('ORDER_PARTIALLY_FILLED', `Close order for ${position.symbol} partially filled (${closeOrder.filledQty} / ${closeOrder.qty}). Position remains OPEN with reduced size.`, {
          positionId: position.id,
          filledQty: closeOrder.filledQty,
          totalQty: closeOrder.qty,
        });

        return { success: true, order: closeOrder };
      } else {
        // Neither FILLED nor PARTIALLY_FILLED (e.g. still SUBMITTED / ACCEPTED or FAILED)
        // STRICT RULE: Do NOT mark position closed!
        const errorMsg = `Close order for ${position.symbol} not confirmed filled (status: ${closeOrder.status}). Position remains OPEN.`;
        this.auditLogger('ORDER_FAILED', errorMsg, {
          positionId: position.id,
          orderId: closeOrder.id,
          status: closeOrder.status,
        });

        return { success: false, order: closeOrder, error: errorMsg };
      }
    } catch (err: any) {
      closeOrder.status = 'FAILED';
      closeOrder.rejectionReason = err.message || 'Close order failed';
      closeOrder.updatedTime = Date.now();

      this.auditLogger('ORDER_FAILED', `CRITICAL: Failed to close position ${position.symbol}: ${err.message}. Position remains OPEN.`, {
        positionId: position.id,
        symbol: position.symbol,
        error: err.message,
        reason,
      });

      return { success: false, order: closeOrder, error: err.message };
    }
  }

  /**
   * Polls execution status for confirmation
   */
  private async pollExecutionConfirmation(
    order: OrderRecord,
    maxAttempts: number = 5,
    delayMs: number = 800
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
          this.auditLogger('ORDER_FILLED', `Confirmed Fill on ${this.executionMode}: ${order.symbol} @ $${order.fillPrice || 'Market'} (Qty: ${order.filledQty})`, {
            orderId: order.id,
            symbol: order.symbol,
            fillPrice: order.fillPrice,
            filledQty: order.filledQty,
          });
          return true;
        } else if (order.status === 'PARTIALLY_FILLED') {
          this.auditLogger('ORDER_PARTIALLY_FILLED', `Partially Filled on ${this.executionMode}: ${order.symbol} (${order.filledQty} / ${order.qty})`, {
            orderId: order.id,
            filledQty: order.filledQty,
          });
        } else if (order.status === 'CANCELLED' || order.status === 'REJECTED' || order.status === 'FAILED') {
          this.auditLogger('ORDER_FAILED', `Order ended with status ${order.status} on ${this.executionMode}`, {
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
    } else if (rawStatus === 'PartiallyFilled') {
      order.status = 'PARTIALLY_FILLED';
      order.fillPrice = parseFloat(wsData.avgPrice || wsData.lastExecPrice || '0');
      order.filledQty = parseFloat(wsData.cumExecQty || '0');
      order.cumFee = parseFloat(wsData.cumExecFee || '0');
      order.updatedTime = Date.now();

      this.auditLogger('ORDER_PARTIALLY_FILLED', `WS: Order ${order.id} partially filled (${order.filledQty} / ${order.qty})`, {
        orderId: order.id,
        symbol: order.symbol,
        filledQty: order.filledQty,
      });

      if (order.intent === 'ENTRY') {
        this.positionManager.onOrderFilled(order);
      }
    } else if (rawStatus === 'Cancelled') {
      order.status = 'CANCELLED';
      order.updatedTime = Date.now();
      this.auditLogger('ORDER_CANCELLED', `WS: Order ${order.id} cancelled on exchange`, { orderId: order.id });
    }
  }
}
