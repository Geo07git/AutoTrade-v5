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
    const list = Array.from(this.orders.values()).sort((a, b) => b.createdTime - a.createdTime);
    if (list.length > 1000) {
      // Keep only 1000 most recent
      this.orders.clear();
      for (const o of list.slice(0, 1000)) {
        this.orders.set(o.id, o);
      }
      return list.slice(0, 1000);
    }
    return list;
  }

  public setOrders(orders: OrderRecord[]) {
    this.orders.clear();
    for (const order of (orders || []).slice(0, 1000)) {
      if (order && order.id) {
        this.orders.set(order.id, order);
      }
    }
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

  public clearOrders(): void {
    this.orders.clear();
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
    marketRegime?: string;
  }): Promise<{ success: boolean; order?: OrderRecord; error?: string }> {
    const { signal, riskApproval, currentPrice, profile, marketRegime } = params;

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
    const filter = await this.exchange.getInstrumentFilter(signal.symbol);
    const ctVal = filter.ctVal && filter.ctVal > 0 ? filter.ctVal : 1;
    const targetQty = riskApproval.sizeUSDT / currentPrice;
    const formattedQty = await this.exchange.formatQuantity(signal.symbol, targetQty, currentPrice, false);

    if (formattedQty <= 0) {
      const err = `Formatted quantity for ${signal.symbol} is 0 (below minOrderQty)`;
      this.auditLogger('ORDER_FAILED', err, { symbol: signal.symbol, targetQty });
      return { success: false, error: err };
    }

    const clientOrderId = `tb5_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const actualNotional = formattedQty * ctVal * currentPrice;

    // 4. Create Order Record (CREATED)
    const orderRecord: OrderRecord = {
      id: clientOrderId,
      symbol: signal.symbol,
      side: signal.side,
      orderType: 'Market',
      qty: formattedQty,
      ctVal,
      sizeUSDT: parseFloat(actualNotional.toFixed(2)),
      status: 'CREATED',
      cumFilledQty: 0,
      processedFilledQty: 0,
      createdTime: Date.now(),
      updatedTime: Date.now(),
      intent: 'ENTRY',
      profile,
      executionMode: this.executionMode,
      marketRegime,
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
      const orderSide = signal.side === 'BUY' ? 'Buy' : 'Sell';
      const submitRes = await this.exchange.submitOrder({
        symbol: signal.symbol,
        side: orderSide,
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

      // 7. Confirmation of Execution via Polling (routes through central idempotent handler)
      const confirmed = await this.pollExecutionConfirmation(orderRecord, 5, 800);
      const currentStatus = orderRecord.status as OrderStatus;

      if (confirmed && (currentStatus === 'FILLED' || currentStatus === 'PARTIALLY_FILLED')) {
        return { success: true, order: orderRecord };
      } else {
        // Order accepted but still waiting for fill confirmation
        this.auditLogger('ORDER_ACCEPTED', `Order ${clientOrderId} submitted; waiting for asynchronous fill confirmation`, {
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
    reason: 'STOP_LOSS' | 'TRAILING_STOP' | 'TAKE_PROFIT' | 'KILL_SWITCH' | 'MANUAL_CLOSE' | 'EQUITY_PROTECTION' | 'TIME_STOP';
    currentPrice?: number;
    exitReasonDetail?: string;
    triggerStopValue?: number;
    trailingPeakPct?: number;
    trailingDistancePct?: number;
  }): Promise<{ success: boolean; order?: OrderRecord; error?: string }> {
    const { position, reason, currentPrice, exitReasonDetail, triggerStopValue, trailingPeakPct, trailingDistancePct } = params;

    if (position.status !== 'OPEN') {
      return { success: false, error: `Position ${position.symbol} is already closed.` };
    }

    // Immediately lock position status to prevent concurrent duplicate close triggers from rapid ticks
    position.status = 'CLOSING';

    if (this.hasPendingOrderForSymbol(position.symbol)) {
      position.status = 'OPEN'; // Revert status lock
      const err = `A pending order already exists for ${position.symbol}. Close order postponed until pending order completes.`;
      this.auditLogger('ORDER_FAILED', err, { symbol: position.symbol, positionId: position.id });
      return { success: false, error: err };
    }

    const closeSide: OrderSide = position.side === 'BUY' ? 'SELL' : 'BUY';
    const orderSide: 'Buy' | 'Sell' = closeSide === 'BUY' ? 'Buy' : 'Sell';
    const clientOrderId = `tb5_close_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

    // Quantity to close equals the open position quantity
    const estPrice = currentPrice || position.entryPrice;
    const filter = await this.exchange.getInstrumentFilter(position.symbol);
    const ctVal = position.ctVal || filter.ctVal || 1;
    const rawQty = position.qty && !isNaN(position.qty) && position.qty > 0
      ? position.qty
      : (position.sizeUSDT / ((position.entryPrice || 1) * ctVal));
    const formattedQty = await this.exchange.formatQuantity(position.symbol, rawQty, estPrice, true);

    const holdingTimeMinutes = position.entryTime ? parseFloat(((Date.now() - position.entryTime) / 60000).toFixed(1)) : 0;
    const actualCloseNotional = formattedQty * ctVal * estPrice;

    const closeOrder: OrderRecord = {
      id: clientOrderId,
      symbol: position.symbol,
      side: closeSide,
      orderType: 'Market',
      qty: formattedQty,
      ctVal,
      sizeUSDT: parseFloat(actualCloseNotional.toFixed(2)),
      status: 'CREATED',
      createdTime: Date.now(),
      updatedTime: Date.now(),
      intent: reason,
      profile: position.profile,
      executionMode: this.executionMode,
      entryPrice: position.entryPrice,
      exitReasonDetail,
      triggerStopValue,
      trailingPeakPct,
      trailingDistancePct,
      holdingTimeMinutes,
      positionSide: position.side,
    };

    this.orders.set(clientOrderId, closeOrder);

    this.auditLogger('ORDER_SUBMITTED', `Submitting Close Order for ${position.symbol} (${reason}) - Side: ${orderSide}, Qty: ${formattedQty} via ${this.executionMode}`, {
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
        side: orderSide,
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

        if (closeOrder.cumFee === undefined) {
          closeOrder.cumFee = parseFloat((closeOrder.sizeUSDT * 0.0005).toFixed(4));
        }

        const closedPos = await this.positionManager.markPositionClosed(
          position.id,
          exitPrice,
          exitTime,
          reason,
          closeOrder.cumFee
        );

        const pnl = closedPos?.pnl !== undefined ? closedPos.pnl : 0;
        const pnlPct = closedPos?.pnlPct !== undefined ? closedPos.pnlPct : 0;
        const grossPnl = closedPos?.grossPnl !== undefined ? closedPos.grossPnl : pnl;
        const totalFees = ((closedPos?.entryFee || 0) + (closedPos?.exitFee || 0));

        closeOrder.realizedPnl = pnl;
        closeOrder.realizedPnlPct = pnlPct;

        this.auditLogger('POSITION_CLOSED', `Position ${position.symbol} closed on ${this.executionMode} at $${exitPrice.toFixed(4)} (${reason}) - Net PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (Gross: ${grossPnl >= 0 ? '+' : ''}$${grossPnl.toFixed(2)}, Fees: -$${totalFees.toFixed(4)})`, {
          positionId: position.id,
          symbol: position.symbol,
          exitPrice,
          reason,
          pnl,
          pnlPct,
          grossPnl,
          entryFee: closedPos?.entryFee,
          exitFee: closedPos?.exitFee,
          totalFees,
          fee: closeOrder.cumFee,
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
        // STRICT RULE: Do NOT mark position closed, reset position status to OPEN so it can retry!
        position.status = 'OPEN';
        const errorMsg = `Close order for ${position.symbol} not confirmed filled (status: ${closeOrder.status}). Position remains OPEN.`;
        this.auditLogger('ORDER_FAILED', errorMsg, {
          positionId: position.id,
          orderId: closeOrder.id,
          status: closeOrder.status,
        });

        return { success: false, order: closeOrder, error: errorMsg };
      }
    } catch (err: any) {
      position.status = 'OPEN'; // Reset position status to OPEN on exception
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
   * Central idempotent execution update handler for both Polling and WebSocket streams.
   * - Eliminates duplicate onOrderFilled() invocations between polling and WebSocket.
   * - Accurately processes cumulative filled quantity (cumFilledQty) into incremental fills.
   * - Guarantees that only unprocessed delta quantities are applied to PositionManager.
   */
  public async handleOrderExecutionUpdate(update: {
    orderLinkId: string;
    exchangeOrderId?: string;
    status: OrderStatus;
    cumExecQty: number;
    avgPrice: number;
    cumFee?: number;
    source: 'POLL' | 'WS';
  }): Promise<OrderRecord | null> {
    const order = this.orders.get(update.orderLinkId);
    if (!order) return null;

    if (update.exchangeOrderId && !order.exchangeOrderId) {
      order.exchangeOrderId = update.exchangeOrderId;
    }

    if (update.avgPrice > 0) {
      order.fillPrice = update.avgPrice;
    }

    if (update.cumFee !== undefined) {
      order.cumFee = update.cumFee;
    }

    order.status = update.status;
    order.updatedTime = Date.now();

    // Calculate incremental fill from cumulative execution quantity
    const previouslyProcessedQty = order.processedFilledQty || 0;
    const reportedCumQty = typeof update.cumExecQty === 'number' && !isNaN(update.cumExecQty) ? update.cumExecQty : previouslyProcessedQty;
    const newCumFilledQty = Math.max(previouslyProcessedQty, reportedCumQty);
    const incrementalQty = Math.max(0, parseFloat((newCumFilledQty - previouslyProcessedQty).toFixed(6)));

    // Calculate incremental fee
    const previouslyProcessedFee = order.processedFee || 0;
    const currentCumFee = order.cumFee || 0;
    const feeDelta = Math.max(0, currentCumFee - previouslyProcessedFee);

    order.cumFilledQty = newCumFilledQty;
    order.filledQty = newCumFilledQty;

    if (incrementalQty > 0) {
      order.processedFilledQty = newCumFilledQty;
      order.processedFee = currentCumFee;

      if (order.intent === 'ENTRY') {
        const fillPrice = order.fillPrice && order.fillPrice > 0 ? order.fillPrice : update.avgPrice;
        await this.positionManager.onOrderFilled(order, incrementalQty, fillPrice, feeDelta);

        this.auditLogger(
          order.status === 'FILLED' ? 'ORDER_FILLED' : 'ORDER_PARTIALLY_FILLED',
          `Confirmed fill via ${update.source}: ${order.symbol} +${incrementalQty} @ $${fillPrice.toFixed(4)} (cum: ${newCumFilledQty}/${order.qty})`,
          {
            orderId: order.id,
            symbol: order.symbol,
            incrementalQty,
            cumFilledQty: newCumFilledQty,
            totalQty: order.qty,
            status: order.status,
            source: update.source,
          }
        );
      }
    } else {
      // incrementalQty is 0 -> already processed by previous poll or websocket event!
      // Do NOT invoke onOrderFilled() again!
      if (update.source === 'WS' && (update.status === 'FILLED' || update.status === 'PARTIALLY_FILLED')) {
        this.auditLogger(
          'ORDER_ACCEPTED',
          `WS duplicate check: Order ${order.id} (${order.status}) already processed. No redundant fill triggered.`,
          { orderId: order.id, cumFilledQty: newCumFilledQty, status: order.status }
        );
      }
    }

    return order;
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
        await this.handleOrderExecutionUpdate({
          orderLinkId: order.id,
          exchangeOrderId: statusRes.orderId || order.exchangeOrderId,
          status: statusRes.status,
          cumExecQty: statusRes.filledQty,
          avgPrice: statusRes.avgPrice,
          cumFee: statusRes.cumFee,
          source: 'POLL',
        });

        if (order.status === 'FILLED') {
          return true;
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
  public async handleWsOrderUpdate(wsData: any) {
    const orderLinkId = wsData.orderLinkId;
    if (!orderLinkId) return;

    const order = this.orders.get(orderLinkId);
    if (!order) return;

    const rawStatus = wsData.orderStatus;
    let status: OrderStatus = order.status;
    if (rawStatus === 'Filled') {
      status = 'FILLED';
    } else if (rawStatus === 'PartiallyFilled') {
      status = 'PARTIALLY_FILLED';
    } else if (rawStatus === 'Cancelled') {
      status = 'CANCELLED';
    } else if (rawStatus === 'Rejected') {
      status = 'REJECTED';
    }

    const cumExecQty = parseFloat(wsData.cumExecQty || wsData.qty || '0');
    const avgPrice = parseFloat(wsData.avgPrice || wsData.lastExecPrice || '0');
    const cumFee = parseFloat(wsData.cumExecFee || '0');

    await this.handleOrderExecutionUpdate({
      orderLinkId,
      exchangeOrderId: wsData.orderId,
      status,
      cumExecQty,
      avgPrice,
      cumFee,
      source: 'WS',
    });

    if (status === 'CANCELLED') {
      this.auditLogger('ORDER_CANCELLED', `WS: Order ${order.id} cancelled on exchange`, { orderId: order.id });
    }
  }
}
