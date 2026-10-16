import { IExecutionAdapter } from '../exchange/IExecutionAdapter';
import { PositionManager } from '../position/PositionManager';
import { SymbolStatsTracker } from '../stats/SymbolStatsTracker';
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
  HedgeArm,
  LegRole,
  PairExitMode,
} from '../../shared/types';
import { formatPrice } from '../../shared/formatters';
import { reconcileHistoricalOrderPrecision } from './orderPrecisionReconciliation';
import { calculateExecutionFee } from '../../shared/fees';

export class OrderManager {
  private exchange: IExecutionAdapter;
  private okxAdapter?: IExecutionAdapter;
  private paperAdapter?: IExecutionAdapter;
  private positionManager: PositionManager;
  private executionMode: ExecutionMode;
  private orders: Map<string, OrderRecord> = new Map();
  private auditLogger: (type: AuditLogType, message: string, details?: any) => void;
  private symbolStatsTracker?: SymbolStatsTracker;
  private rejectedSymbolsCooldown: Map<string, number> = new Map();

  constructor(
    exchange: IExecutionAdapter,
    positionManager: PositionManager,
    auditLogger: (type: AuditLogType, message: string, details?: any) => void,
    executionMode: ExecutionMode = 'PAPER',
    symbolStatsTracker?: SymbolStatsTracker
  ) {
    this.exchange = exchange;
    this.positionManager = positionManager;
    this.auditLogger = auditLogger;
    this.executionMode = executionMode;
    this.symbolStatsTracker = symbolStatsTracker;
  }

  public setAdapters(okxAdapter?: IExecutionAdapter, paperAdapter?: IExecutionAdapter) {
    this.okxAdapter = okxAdapter;
    this.paperAdapter = paperAdapter;
  }

  public setSymbolStatsTracker(tracker: SymbolStatsTracker) {
    this.symbolStatsTracker = tracker;
  }

  public getSymbolStatsTracker(): SymbolStatsTracker | undefined {
    return this.symbolStatsTracker;
  }

  public setExecutionAdapter(adapter: IExecutionAdapter, mode: ExecutionMode) {
    this.exchange = adapter;
    this.executionMode = mode;
  }

  private getActiveAdapter(): IExecutionAdapter {
    if (this.executionMode === 'PAPER' && this.paperAdapter) {
      return this.paperAdapter;
    }
    if (this.executionMode !== 'PAPER' && this.okxAdapter && this.okxAdapter.hasCredentials()) {
      return this.okxAdapter;
    }
    return this.exchange;
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
    const reconciled = reconcileHistoricalOrderPrecision(orders || []);
    const now = Date.now();
    for (const order of reconciled.slice(0, 1000)) {
      if (order && order.id) {
        this.orders.set(order.id, order);
        if (order.status === 'REJECTED' && order.symbol) {
          const orderTime = order.updatedTime || order.createdTime;
          if (now - orderTime < 15 * 60 * 1000) {
            const existing = this.rejectedSymbolsCooldown.get(order.symbol) || 0;
            if (orderTime > existing) {
              this.rejectedSymbolsCooldown.set(order.symbol, orderTime);
            }
          }
        }
      }
    }
  }

  public getOrder(id: string): OrderRecord | undefined {
    return this.orders.get(id);
  }

  /**
   * Verifica daca un simbol se afla in perioada de cooldown (10-15 min) dupa un ORDER_REJECTED.
   * Previne spam-ul de ordine respinse (ex: ANTHROPIC 63x, OPENAI 23x, TRX 20x).
   */
  public isSymbolInRejectionCooldown(symbol: string, cooldownMinutes: number = 15): { inCooldown: boolean; remainingMinutes: number } {
    const lastRejection = this.rejectedSymbolsCooldown.get(symbol);
    if (!lastRejection) return { inCooldown: false, remainingMinutes: 0 };
    const elapsedMinutes = (Date.now() - lastRejection) / 60000;
    if (elapsedMinutes < cooldownMinutes) {
      return { inCooldown: true, remainingMinutes: parseFloat((cooldownMinutes - elapsedMinutes).toFixed(1)) };
    }
    return { inCooldown: false, remainingMinutes: 0 };
  }

  public recordRejection(symbol: string) {
    this.rejectedSymbolsCooldown.set(symbol, Date.now());
  }

  public clearRejectionCooldown(symbol?: string) {
    if (symbol) {
      this.rejectedSymbolsCooldown.delete(symbol);
    } else {
      this.rejectedSymbolsCooldown.clear();
    }
  }

  /**
   * Checks whether there is an in-flight pending order for a given symbol.
   * Prevents duplicate entries!
   */
  public hasPendingOrderForSymbol(symbol: string): boolean {
    const now = Date.now();
    for (const order of this.orders.values()) {
      if (order.symbol === symbol) {
        if (
          order.status === 'CREATED' ||
          order.status === 'SUBMITTED' ||
          order.status === 'ACCEPTED' ||
          order.status === 'PARTIALLY_FILLED'
        ) {
          // If pending order is older than 120 seconds, treat as stale and do not block
          if (now - order.createdTime > 120000) {
            order.status = 'FAILED';
            order.rejectionReason = 'Stale pending order timeout cleared';
            continue;
          }
          return true;
        }
      }
    }
    return false;
  }

  public clearOrders(): void {
    this.orders.clear();
    this.rejectedSymbolsCooldown.clear();
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
    accountEquity?: number;
    accountBalance?: number;
    openPositionsCount?: number;
    leverage?: string;
    rank?: number;
    spreadPct?: number;
    candleElapsedSeconds?: number;
    htfTrend?: string;
    entryFactors?: any;
    pairId?: string;
    arm?: HedgeArm;
    legRole?: LegRole;
    effectiveRatio?: number;
    initialTotalNotional?: number;
    hedgeStopPct?: number;
    pairTimeStopMin?: number;
    exitMode?: PairExitMode;
  }): Promise<{ success: boolean; order?: OrderRecord; error?: string }> {
    const {
      signal,
      riskApproval,
      currentPrice,
      profile,
      marketRegime,
      accountEquity,
      accountBalance,
      rank,
      spreadPct,
      candleElapsedSeconds,
      htfTrend,
      entryFactors,
      pairId,
      arm,
      legRole,
      effectiveRatio,
      initialTotalNotional,
      hedgeStopPct,
      pairTimeStopMin,
      exitMode,
    } = params;

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
    const activeAdapter = this.getActiveAdapter();
    const filter = await activeAdapter.getInstrumentFilter(signal.symbol);
    const ctVal = filter.ctVal && filter.ctVal > 0 ? filter.ctVal : 1;
    const targetQty = riskApproval.sizeUSDT / currentPrice;
    const formattedQty = await activeAdapter.formatQuantity(signal.symbol, targetQty, currentPrice, false);

    if (formattedQty <= 0) {
      const minNotional = filter.minOrderQty * ctVal * currentPrice;
      const err = `Mărimea minimă pentru ${signal.symbol} (min ${filter.minOrderQty} contract(e) = $${minNotional.toFixed(2)}) depășește marja de risc alocată ($${riskApproval.sizeUSDT.toFixed(2)}). Tranzacție omisă.`;
      this.auditLogger('ORDER_REJECTED', err, {
        symbol: signal.symbol,
        targetQty,
        minOrderQty: filter.minOrderQty,
        ctVal,
        approvedRiskUSDT: riskApproval.sizeUSDT,
      });
      return { success: false, error: err };
    }

    const clientOrderId = `tb5_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const actualNotional = formattedQty * ctVal * currentPrice;
    const leverage = params.leverage || '1x';
    const numLeverage = Math.max(1, parseFloat(leverage.replace(/[^0-9.]/g, '')) || 1);
    const requiredMargin = actualNotional / numLeverage;

    // Safety gate: Check if required margin exceeds available cash balance or account equity in both LIVE and PAPER modes
    const availableBalance = (params.accountBalance && params.accountBalance > 0)
      ? params.accountBalance
      : (params.accountEquity && params.accountEquity > 0 ? params.accountEquity : 0);

    if (availableBalance > 0 && requiredMargin > availableBalance * 1.05) {
      const err = `Marja necesară pentru ${formattedQty} contract(e) de ${signal.symbol} ($${requiredMargin.toFixed(2)}) depășește capitalul/balanța disponibilă ($${availableBalance.toFixed(2)}). Tranzacție respinsă pentru prevenirea riscului excesiv.`;
      this.auditLogger('ORDER_REJECTED', err, {
        symbol: signal.symbol,
        requiredMargin,
        accountBalance: availableBalance,
        qty: formattedQty,
        ctVal,
        currentPrice,
      });
      return { success: false, error: err };
    }

    // Safety gate: actual notional must not drastically overshoot approved risk size (prevents $4,075 notional on $18 approved risk)
    if (riskApproval.sizeUSDT > 0 && actualNotional > Math.max(riskApproval.sizeUSDT * 2.5, availableBalance * 1.05)) {
      const err = `Valoarea poziției pentru ${formattedQty} contract(e) de ${signal.symbol} ($${actualNotional.toFixed(2)}) depășește mărimea aprobată de risc ($${riskApproval.sizeUSDT.toFixed(2)}) și capitalul disponibil ($${availableBalance.toFixed(2)}). Tranzacție respinsă.`;
      this.auditLogger('ORDER_REJECTED', err, {
        symbol: signal.symbol,
        actualNotional,
        approvedSize: riskApproval.sizeUSDT,
        availableBalance,
      });
      return { success: false, error: err };
    }

    const openPositionsCount = params.openPositionsCount !== undefined
      ? params.openPositionsCount
      : this.positionManager.getActivePositions().length;

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
      stopLossPrice: riskApproval.stopLossPrice,
      isFadeTrade: signal.isFadeTrade,
      climax: Boolean(signal.climax || entryFactors?.climax),
      cumFilledQty: 0,
      processedFilledQty: 0,
      createdTime: Date.now(),
      updatedTime: Date.now(),
      intent: 'ENTRY',
      profile,
      executionMode: this.executionMode,
      marketRegime,
      signalScore: signal.score,
      signalPrice: currentPrice,
      rankAtEntry: rank,
      spreadPctAtEntry: spreadPct !== undefined ? spreadPct : signal.spreadPct,
      candleElapsedSecondsAtEntry: candleElapsedSeconds !== undefined ? candleElapsedSeconds : signal.candleElapsedSeconds,
      htfTrendAtEntry: htfTrend || signal.reasons?.htfTrend,
      entryFactors: entryFactors || signal.reasons,
      leverage,
      openPositionsCount,
      accountEquity,
      accountBalance,
      pairId,
      arm,
      legRole,
      effectiveRatio,
    };
    (orderRecord as any).initialTotalNotional = initialTotalNotional;
    (orderRecord as any).hedgeStopPct = hedgeStopPct;
    (orderRecord as any).pairTimeStopMin = pairTimeStopMin;
    (orderRecord as any).exitMode = exitMode;

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
      signalScore: signal.score,
      signalPrice: currentPrice,
      leverage,
      openPositionsCount,
      accountEquity,
      accountBalance,
    });

    try {
      let activeAdapter = this.getActiveAdapter();
      const orderSide = signal.side === 'BUY' ? 'Buy' : 'Sell';
      let submitRes;
      try {
        submitRes = await activeAdapter.submitOrder({
          symbol: signal.symbol,
          side: orderSide,
          orderType: 'Market',
          qty: formattedQty,
          price: currentPrice,
          orderLinkId: clientOrderId,
          posSide: signal.side === 'BUY' ? 'long' : 'short',
        });
      } catch (submitErr: any) {
        if (
          this.executionMode !== 'LIVE' &&
          this.paperAdapter &&
          activeAdapter !== this.paperAdapter &&
          (submitErr?.message?.includes('401') ||
           submitErr?.message?.includes('51001') ||
           submitErr?.message?.includes('50119') ||
           submitErr?.message?.includes("doesn't exist") ||
           submitErr?.message?.includes('API key'))
        ) {
          this.auditLogger(
            'ORDER_ROUTED',
            `Adapter submitOrder routed to Paper adapter for ${signal.symbol} (${submitErr.message}).`,
            { symbol: signal.symbol, reason: submitErr.message }
          );
          activeAdapter = this.paperAdapter;
          submitRes = await activeAdapter.submitOrder({
            symbol: signal.symbol,
            side: orderSide,
            orderType: 'Market',
            qty: formattedQty,
            price: currentPrice,
            orderLinkId: clientOrderId,
          });
          orderRecord.executionMode = 'PAPER';
        } else {
          throw submitErr;
        }
      }

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

      // Calculate Slippage (fillPrice vs signalPrice)
      if (orderRecord.fillPrice && orderRecord.signalPrice && orderRecord.signalPrice > 0) {
        const diff = (orderRecord.fillPrice - orderRecord.signalPrice) / orderRecord.signalPrice * 100;
        const slip = orderRecord.side === 'BUY' ? diff : -diff;
        orderRecord.estimatedSlippagePct = parseFloat(slip.toFixed(3));
      }

      if (confirmed && (currentStatus === 'FILLED' || currentStatus === 'PARTIALLY_FILLED')) {
        try {
          const postEntryEquity = await activeAdapter.getEquity();
          const postEntryBalance = activeAdapter.getWalletBalance
            ? await activeAdapter.getWalletBalance()
            : (accountBalance !== undefined ? parseFloat((accountBalance - (orderRecord.cumFee || 0)).toFixed(2)) : undefined);

          if (postEntryEquity > 0) {
            orderRecord.accountEquity = postEntryEquity;
          }
          if (postEntryBalance !== undefined) {
            orderRecord.accountBalance = postEntryBalance;
          }
          orderRecord.openPositionsCount = this.positionManager.getActivePositions().length;
          this.orders.set(clientOrderId, orderRecord);
        } catch (e) {
          // ignore error updating post-entry telemetry
        }

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
      this.recordRejection(signal.symbol);

      this.auditLogger('ORDER_REJECTED', `Order ${clientOrderId} rejected: ${err.message}`, {
        orderId: clientOrderId,
        symbol: signal.symbol,
        error: err.message,
      });

      return { success: false, order: orderRecord, error: err.message };
    }
  }

  /**
   * Executes an atomic Asymmetric Hedge Pair (MAIN + HEDGE) on the same symbol.
   * Specification (AutoTrade-v5 Experiment Asymmetric Hedge):
   * 1. MAIN leg: signal direction, weight mainWeight (default 70%)
   * 2. HEDGE leg: opposite direction, weight (1 - mainWeight) (default 30%)
   * 3. Both converted to contracts with ctVal and lot rounding.
   * 4. Pre-entry margin check across BOTH legs combined.
   * 5. If either leg < minOrderQty: skip trade and log reason.
   * 6. Atomicity: if Leg 2 (HEDGE) fails or is rejected, immediately close Leg 1 (MAIN) at market (LEG_FAIL_ROLLBACK).
   */
  public async executeAsymmetricPairOrder(params: {
    pairId: string;
    signal: TradeSignal;
    totalNotional: number; // Approved size in USDT (after SymbolStatsTracker multiplier)
    mainWeight: number; // e.g. 0.70
    hedgeStopPct: number; // e.g. -1.0
    pairTimeStopMin: number; // e.g. 45
    exitMode: PairExitMode; // 'pair_close' | 'hedge_runs'
    entryOrderType?: 'taker' | 'maker';
    currentPrice: number;
    profile: ProfileType;
    marketRegime?: string;
    accountEquity?: number;
    accountBalance?: number;
    leverage?: string;
    rank?: number;
    spreadPct?: number;
    candleElapsedSeconds?: number;
    htfTrend?: string;
    entryFactors?: any;
    concurrentPairs?: number;
  }): Promise<{ success: boolean; mainOrder?: OrderRecord; hedgeOrder?: OrderRecord; effectiveRatio?: number; error?: string }> {
    const {
      pairId,
      signal,
      totalNotional,
      mainWeight,
      hedgeStopPct,
      pairTimeStopMin,
      exitMode,
      currentPrice,
      profile,
      marketRegime,
      accountEquity,
      accountBalance,
      leverage,
      rank,
      spreadPct,
      candleElapsedSeconds,
      htfTrend,
      entryFactors,
      concurrentPairs,
    } = params;

    // 1. In-flight check
    if (this.hasPendingOrderForSymbol(signal.symbol)) {
      const pendingReason = `Pending order already in-flight for ${signal.symbol}. Pair entry prevented.`;
      this.auditLogger('SIGNAL_REJECTED', pendingReason, { symbol: signal.symbol, pairId });
      return { success: false, error: pendingReason };
    }

    if (currentPrice <= 0 || totalNotional <= 0) {
      return { success: false, error: `Invalid price ($${currentPrice}) or notional ($${totalNotional})` };
    }

    // 2. Fetch instrument specifications & ctVal
    const activeAdapter = this.getActiveAdapter();
    const filter = await activeAdapter.getInstrumentFilter(signal.symbol);
    const ctVal = filter.ctVal && filter.ctVal > 0 ? filter.ctVal : 1;

    // 3. Compute nominals and format quantities into contracts
    const targetMainNotional = totalNotional * mainWeight;
    const targetHedgeNotional = totalNotional * (1 - mainWeight);

    const formattedMainQty = await activeAdapter.formatQuantity(signal.symbol, targetMainNotional / currentPrice, currentPrice, false);
    const formattedHedgeQty = await activeAdapter.formatQuantity(signal.symbol, targetHedgeNotional / currentPrice, currentPrice, false);

    // 4. Verify minOrderQty on BOTH legs (Cerința 3.3)
    if (formattedMainQty < filter.minOrderQty || formattedHedgeQty < filter.minOrderQty) {
      const err = `[ASYMMETRIC_HEDGE] Mărime sub pragul minim OKX (${filter.minOrderQty} ct = $${(filter.minOrderQty * ctVal * currentPrice).toFixed(2)}) pentru ${signal.symbol}. MAIN: ${formattedMainQty} ct ($${(formattedMainQty * ctVal * currentPrice).toFixed(2)}), HEDGE: ${formattedHedgeQty} ct ($${(formattedHedgeQty * ctVal * currentPrice).toFixed(2)}). Tranzacție omisă conform cerinței 3.3.`;
      this.auditLogger('ORDER_REJECTED', err, {
        pairId,
        symbol: signal.symbol,
        formattedMainQty,
        formattedHedgeQty,
        minOrderQty: filter.minOrderQty,
        ctVal,
        currentPrice,
        targetMainNotional,
        targetHedgeNotional,
      });
      return { success: false, error: err };
    }

    // 5. Effective nominals and effective ratio
    const actualMainNotional = formattedMainQty * ctVal * currentPrice;
    const actualHedgeNotional = formattedHedgeQty * ctVal * currentPrice;
    const actualTotalNotional = actualMainNotional + actualHedgeNotional;
    const effectiveRatio = actualMainNotional / actualTotalNotional;

    // 6. Pre-entry Margin check across BOTH legs combined (Cerința 3.4)
    const levStr = leverage || '1x';
    const numLeverage = Math.max(1, parseFloat(levStr.replace(/[^0-9.]/g, '')) || 1);
    const requiredMargin = actualTotalNotional / numLeverage;
    const availableBalance = (accountBalance && accountBalance > 0)
      ? accountBalance
      : (accountEquity && accountEquity > 0 ? accountEquity : 0);

    if (availableBalance > 0 && requiredMargin > availableBalance * 1.05) {
      const err = `[ASYMMETRIC_HEDGE] Marja necesară pentru ambele picioare ($${requiredMargin.toFixed(2)}) depășește balanța disponibilă ($${availableBalance.toFixed(2)}). Tranzacție respinsă pentru prevenirea riscului.`;
      this.auditLogger('ORDER_REJECTED', err, {
        pairId,
        symbol: signal.symbol,
        requiredMargin,
        availableBalance,
        actualTotalNotional,
      });
      return { success: false, error: err };
    }

    // 7. Leg direction & posSide
    const mainSide: OrderSide = signal.side;
    const hedgeSide: OrderSide = signal.side === 'BUY' ? 'SELL' : 'BUY';
    const mainPosSide: 'long' | 'short' = signal.side === 'BUY' ? 'long' : 'short';
    const hedgePosSide: 'long' | 'short' = signal.side === 'BUY' ? 'short' : 'long';

    this.auditLogger(
      'ORDER_SUBMITTED',
      `[ASYMMETRIC_HEDGE] Inițiere pereche pe ${signal.symbol}: MAIN ${mainSide} ${formattedMainQty} ct ($${actualMainNotional.toFixed(2)}) + HEDGE ${hedgeSide} ${formattedHedgeQty} ct ($${actualHedgeNotional.toFixed(2)}) | Ratio efectiv: ${(effectiveRatio * 100).toFixed(1)}% | Pair ID: ${pairId}`,
      {
        pairId,
        symbol: signal.symbol,
        mainQty: formattedMainQty,
        hedgeQty: formattedHedgeQty,
        actualTotalNotional,
        effectiveRatio,
        mainWeight,
      }
    );

    // 8. Submit Leg 1 (MAIN)
    const mainOrderId = `tb5_main_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const mainRecord: OrderRecord = {
      id: mainOrderId,
      symbol: signal.symbol,
      side: mainSide,
      orderType: 'Market',
      qty: formattedMainQty,
      ctVal,
      sizeUSDT: parseFloat(actualMainNotional.toFixed(2)),
      status: 'CREATED',
      cumFilledQty: 0,
      processedFilledQty: 0,
      createdTime: Date.now(),
      updatedTime: Date.now(),
      intent: 'ENTRY',
      profile,
      executionMode: this.executionMode,
      marketRegime,
      signalScore: signal.score,
      signalPrice: currentPrice,
      rankAtEntry: rank,
      spreadPctAtEntry: spreadPct,
      candleElapsedSecondsAtEntry: candleElapsedSeconds,
      htfTrendAtEntry: htfTrend,
      entryFactors,
      leverage: levStr,
      openPositionsCount: this.positionManager.getOccupiedSlotsCount(),
      accountEquity,
      accountBalance,
      pairId,
      arm: 'PAIR',
      legRole: 'MAIN',
      effectiveRatio,
    };
    (mainRecord as any).initialTotalNotional = actualTotalNotional;
    (mainRecord as any).hedgeStopPct = hedgeStopPct;
    (mainRecord as any).pairTimeStopMin = pairTimeStopMin;
    (mainRecord as any).exitMode = exitMode;

    this.orders.set(mainOrderId, mainRecord);
    mainRecord.status = 'SUBMITTED';

    let mainConfirmed = false;
    try {
      const res1 = await activeAdapter.submitOrder({
        symbol: signal.symbol,
        side: mainSide === 'BUY' ? 'Buy' : 'Sell',
        orderType: 'Market',
        qty: formattedMainQty,
        price: currentPrice,
        orderLinkId: mainOrderId,
        posSide: mainPosSide,
      });
      mainRecord.status = 'ACCEPTED';
      mainRecord.exchangeOrderId = res1.orderId;
      mainConfirmed = await this.pollExecutionConfirmation(mainRecord, 5, 800);
    } catch (err: any) {
      mainRecord.status = 'REJECTED';
      mainRecord.rejectionReason = err?.message || 'Leg 1 (MAIN) submission failed';
      this.auditLogger('ORDER_REJECTED', `[ASYMMETRIC_HEDGE] Piciorul 1 (MAIN) a fost respins: ${err.message}`, { pairId, symbol: signal.symbol });
      return { success: false, error: `Leg 1 rejected: ${err.message}` };
    }

    const mainFinalStatus = mainRecord.status as OrderStatus;
    if (!mainConfirmed || (mainFinalStatus !== 'FILLED' && mainFinalStatus !== 'PARTIALLY_FILLED')) {
      return { success: false, error: 'Leg 1 (MAIN) fill not confirmed' };
    }

    // Calculate slippage on Leg 1 (MAIN)
    if (mainRecord.fillPrice && mainRecord.signalPrice && mainRecord.signalPrice > 0) {
      const diff = (mainRecord.fillPrice - mainRecord.signalPrice) / mainRecord.signalPrice * 100;
      const slip = mainRecord.side === 'BUY' ? diff : -diff;
      mainRecord.estimatedSlippagePct = parseFloat(slip.toFixed(3));
    }

    // 9. Submit Leg 2 (HEDGE) with Rollback protection!
    const hedgeOrderId = `tb5_hdg_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const hedgeRecord: OrderRecord = {
      id: hedgeOrderId,
      symbol: signal.symbol,
      side: hedgeSide,
      orderType: 'Market',
      qty: formattedHedgeQty,
      ctVal,
      sizeUSDT: parseFloat(actualHedgeNotional.toFixed(2)),
      status: 'CREATED',
      cumFilledQty: 0,
      processedFilledQty: 0,
      createdTime: Date.now(),
      updatedTime: Date.now(),
      intent: 'ENTRY',
      profile,
      executionMode: this.executionMode,
      marketRegime,
      signalScore: signal.score,
      signalPrice: currentPrice,
      rankAtEntry: rank,
      spreadPctAtEntry: spreadPct,
      candleElapsedSecondsAtEntry: candleElapsedSeconds,
      htfTrendAtEntry: htfTrend,
      entryFactors,
      leverage: levStr,
      openPositionsCount: this.positionManager.getOccupiedSlotsCount(),
      accountEquity,
      accountBalance,
      pairId,
      arm: 'PAIR',
      legRole: 'HEDGE',
      effectiveRatio,
    };
    (hedgeRecord as any).initialTotalNotional = actualTotalNotional;
    (hedgeRecord as any).hedgeStopPct = hedgeStopPct;
    (hedgeRecord as any).pairTimeStopMin = pairTimeStopMin;
    (hedgeRecord as any).exitMode = exitMode;

    this.orders.set(hedgeOrderId, hedgeRecord);
    hedgeRecord.status = 'SUBMITTED';

    let hedgeConfirmed = false;
    let hedgeError = '';

    try {
      const res2 = await activeAdapter.submitOrder({
        symbol: signal.symbol,
        side: hedgeSide === 'BUY' ? 'Buy' : 'Sell',
        orderType: 'Market',
        qty: formattedHedgeQty,
        price: currentPrice,
        orderLinkId: hedgeOrderId,
        posSide: hedgePosSide,
      });
      hedgeRecord.status = 'ACCEPTED';
      hedgeRecord.exchangeOrderId = res2.orderId;
      hedgeConfirmed = await this.pollExecutionConfirmation(hedgeRecord, 5, 800);
    } catch (err: any) {
      hedgeError = err?.message || 'HEDGE submit error';
    }

    // =========================================================================
    // ⚠️ ATOMICITY ENFORCEMENT: LEG_FAIL_ROLLBACK
    // If Leg 2 fails or is not filled, Leg 1 MUST be rolled back immediately!
    // =========================================================================
    const hedgeFinalStatus = hedgeRecord.status as OrderStatus;
    if (!hedgeConfirmed || hedgeFinalStatus === 'REJECTED' || hedgeFinalStatus === 'FAILED') {
      hedgeRecord.status = 'REJECTED';
      hedgeRecord.rejectionReason = hedgeError || 'Fill timeout';

      this.auditLogger(
        'ORDER_FAILED',
        `[LEG_FAIL_ROLLBACK] Piciorul 2 (HEDGE) a eșuat (${hedgeError || 'Reject'}). Se inițiază închiderea imediată de siguranță (ROLLBACK) a piciorului 1 (MAIN) pe ${signal.symbol}.`,
        {
          pairId,
          symbol: signal.symbol,
          error: hedgeError,
        }
      );

      // Find open MAIN position and close it immediately
      const openMain = this.positionManager.getActivePositions().find(
        (p) => p.pairId === pairId && p.legRole === 'MAIN' && p.status === 'OPEN'
      );
      if (openMain) {
        await this.executeCloseOrder({
          position: openMain,
          reason: 'MANUAL_CLOSE',
          currentPrice,
          exitReasonDetail: `LEG_FAIL_ROLLBACK: Închidere automată la market a piciorului MAIN deoarece piciorul HEDGE a eșuat (${hedgeError}).`,
          openPositionsCount: this.positionManager.getActivePositions().length,
        });
      }

      return {
        success: false,
        error: `LEG_FAIL_ROLLBACK: HEDGE rejected, MAIN rolled back (${hedgeError || 'fill unconfirmed'})`,
      };
    }

    // Calculate slippage on Leg 2 (HEDGE)
    if (hedgeRecord.fillPrice && hedgeRecord.signalPrice && hedgeRecord.signalPrice > 0) {
      const diff = (hedgeRecord.fillPrice - hedgeRecord.signalPrice) / hedgeRecord.signalPrice * 100;
      const slip = hedgeRecord.side === 'BUY' ? diff : -diff;
      hedgeRecord.estimatedSlippagePct = parseFloat(slip.toFixed(3));
    }

    // Both legs FILLED successfully!
    this.auditLogger(
      'POSITION_OPENED',
      `[ASYMMETRIC_HEDGE] Pereche completă executată cu succes: MAIN ${mainSide} (${formattedMainQty} ct) + HEDGE ${hedgeSide} (${formattedHedgeQty} ct) pe ${signal.symbol} [Ratio: ${(effectiveRatio * 100).toFixed(1)}%, Pair: ${pairId}]`,
      {
        pairId,
        symbol: signal.symbol,
        effectiveRatio,
        mainQty: formattedMainQty,
        hedgeQty: formattedHedgeQty,
        actualTotalNotional,
      }
    );

    return {
      success: true,
      mainOrder: mainRecord,
      hedgeOrder: hedgeRecord,
      effectiveRatio,
    };
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
    reason: 'STOP_LOSS' | 'TRAILING_STOP' | 'TAKE_PROFIT' | 'KILL_SWITCH' | 'MANUAL_CLOSE' | 'EQUITY_PROTECTION' | 'TIME_STOP' | 'BREAK_EVEN' | 'EXPERIMENT_END';
    currentPrice?: number;
    exitReasonDetail?: string;
    triggerStopValue?: number;
    trailingPeakPct?: number;
    trailingDistancePct?: number;
    exitMarketRegime?: string;
    accountEquity?: number;
    accountBalance?: number;
    openPositionsCount?: number;
  }): Promise<{ success: boolean; order?: OrderRecord; error?: string }> {
    const {
      position,
      reason,
      currentPrice,
      exitReasonDetail,
      triggerStopValue,
      trailingPeakPct,
      trailingDistancePct,
      exitMarketRegime,
      accountEquity,
      accountBalance,
      openPositionsCount,
    } = params;

    if (position.status !== 'OPEN') {
      return { success: false, error: `Position ${position.symbol} is already closed.` };
    }

    // Immediately handle legacy mock symbols (_UM_XPERP): close locally without attempting invalid OKX calls
    if (position.symbol.includes('_UM_XPERP') || position.symbol.includes('XPERP')) {
      const exitPrice = currentPrice || position.entryPrice || 0;
      await this.positionManager.markPositionClosed(
        position.id,
        exitPrice,
        Date.now(),
        reason || 'MANUAL_CLOSE',
        0,
        { exitMarketRegime, accountEquity, openPositionsCount, closeOrderId: `close_mock_${Date.now()}` }
      );
      this.auditLogger('POSITION_CLOSED', `Closed legacy mock position ${position.symbol} locally.`, { symbol: position.symbol });
      return { success: true };
    }

    // Immediately lock position status to prevent concurrent duplicate close triggers from rapid ticks
    position.status = 'CLOSING';

    // Supersede/cancel any existing pending orders for this symbol so close order takes immediate precedence
    for (const order of this.orders.values()) {
      if (order.symbol === position.symbol) {
        if (
          order.status === 'CREATED' ||
          order.status === 'SUBMITTED' ||
          order.status === 'ACCEPTED' ||
          order.status === 'PARTIALLY_FILLED'
        ) {
          order.status = 'CANCELLED';
          order.rejectionReason = 'Superseded by position close order';
          order.updatedTime = Date.now();
          this.auditLogger('ORDER_CANCELLED', `Pending order ${order.id} for ${position.symbol} superseded and cancelled by position close.`, { orderId: order.id, symbol: position.symbol });
        }
      }
    }

    const closeSide: OrderSide = position.side === 'BUY' ? 'SELL' : 'BUY';
    const orderSide: 'Buy' | 'Sell' = closeSide === 'BUY' ? 'Buy' : 'Sell';
    const clientOrderId = `tb5_close_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

    let isExchangePosition =
      this.executionMode !== 'PAPER' &&
      (position.source === 'OKX_SYNC' || position.executionMode === 'LIVE') &&
      Boolean(this.okxAdapter && this.okxAdapter.hasCredentials());
    let targetAdapter = this.executionMode === 'PAPER' && this.paperAdapter
      ? this.paperAdapter
      : (isExchangePosition && this.okxAdapter ? this.okxAdapter : (this.paperAdapter ? this.paperAdapter : this.exchange));

    // Quantity to close equals the open position quantity
    const estPrice = currentPrice || position.entryPrice;
    let filter;
    try {
      filter = await targetAdapter.getInstrumentFilter(position.symbol);
    } catch (err: any) {
      if (this.paperAdapter && targetAdapter !== this.paperAdapter) {
        this.auditLogger('ORDER_FAILED', `Adapter failed to get instrument filter for ${position.symbol} (${err.message}). Falling back to Paper adapter.`, { symbol: position.symbol });
        targetAdapter = this.paperAdapter;
        filter = await targetAdapter.getInstrumentFilter(position.symbol);
      } else {
        throw err;
      }
    }
    const ctVal = position.ctVal || filter.ctVal || 1;
    const rawQty = position.qty && !isNaN(position.qty) && position.qty > 0
      ? position.qty
      : (position.sizeUSDT / ((position.entryPrice || 1) * ctVal));
    const formattedQty = await targetAdapter.formatQuantity(position.symbol, rawQty, estPrice, true);

    const holdingTimeMinutes = position.entryTime ? parseFloat(((Date.now() - position.entryTime) / 60000).toFixed(1)) : 0;
    const actualCloseNotional = formattedQty * ctVal * estPrice;
    const resolvedOpenCount = openPositionsCount !== undefined
      ? openPositionsCount
      : this.positionManager.getActivePositions().length;

    const closeOrder: OrderRecord = {
      id: clientOrderId,
      positionId: position.id,
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
      marketRegime: position.marketRegime, // BTC regime at ENTRY
      exitMarketRegime,                    // BTC regime at EXIT
      signalScore: position.signalScore,
      signalPrice: estPrice,
      leverage: position.leverage || '1x',
      openPositionsCount: resolvedOpenCount,
      maePct: position.maePct,
      mfePct: position.mfePct,
      timeToMfe15Minutes: position.timeToMfe15Minutes,
      isFastRunner: position.isFastRunner,
      accountEquity,
      accountBalance,
    };

    this.orders.set(clientOrderId, closeOrder);

    this.auditLogger('ORDER_SUBMITTED', `Submitting Close Order for ${position.symbol} (${reason}) - Side: ${orderSide}, Qty: ${formattedQty} via ${this.executionMode}`, {
      orderId: clientOrderId,
      positionId: position.id,
      symbol: position.symbol,
      reason,
      qty: formattedQty,
      mode: this.executionMode,
      marketRegimeAtEntry: position.marketRegime,
      marketRegimeAtExit: exitMarketRegime,
      accountEquity,
      accountBalance,
      openPositionsCount: resolvedOpenCount,
      maePct: position.maePct,
      mfePct: position.mfePct,
    });

    closeOrder.status = 'SUBMITTED';

    try {
      let submitRes;
      const posSide = position.side === 'BUY' ? 'long' : 'short';
      try {
        submitRes = await targetAdapter.submitOrder({
          symbol: position.symbol,
          side: orderSide,
          orderType: 'Market',
          qty: formattedQty,
          price: estPrice,
          orderLinkId: clientOrderId,
          reduceOnly: true,
          posSide,
        });
      } catch (submitErr: any) {
        const errMsg = submitErr?.message || '';
        if (
          this.executionMode === 'LIVE' &&
          (errMsg.includes('All operations failed') || errMsg.includes('sCode [1]') || errMsg.includes('rate limit') || errMsg.includes('50011'))
        ) {
          this.auditLogger('ORDER_RETRY', `Close order for ${position.symbol} hit OKX rate limit / burst rejection (${errMsg}). Retrying after 650ms...`, { symbol: position.symbol });
          await new Promise((r) => setTimeout(r, 650));
          submitRes = await targetAdapter.submitOrder({
            symbol: position.symbol,
            side: orderSide,
            orderType: 'Market',
            qty: formattedQty,
            price: estPrice,
            orderLinkId: `${clientOrderId}r`,
            reduceOnly: true,
            posSide,
          });
        } else if (
          this.executionMode !== 'LIVE' &&
          this.paperAdapter &&
          targetAdapter !== this.paperAdapter &&
          (errMsg.includes('401') ||
           errMsg.includes('51001') ||
           errMsg.includes('50119') ||
           errMsg.includes("doesn't exist") ||
           errMsg.includes('API key'))
        ) {
          this.auditLogger('ORDER_FAILED', `Adapter submitOrder failed for ${position.symbol} (${errMsg}). Falling back to Paper adapter.`, { symbol: position.symbol });
          targetAdapter = this.paperAdapter;
          submitRes = await targetAdapter.submitOrder({
            symbol: position.symbol,
            side: orderSide,
            orderType: 'Market',
            qty: formattedQty,
            price: estPrice,
            orderLinkId: clientOrderId,
            reduceOnly: true,
            posSide,
          });
        } else {
          throw submitErr;
        }
      }

      // Add a polite stagger pause (400ms) in LIVE mode after closing an order to prevent OKX burst limits
      if (this.executionMode === 'LIVE') {
        await new Promise((r) => setTimeout(r, 400));
      }

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

      // Calculate Slippage on exit (fillPrice vs signalPrice)
      if (closeOrder.fillPrice && closeOrder.signalPrice && closeOrder.signalPrice > 0) {
        const diff = (closeOrder.fillPrice - closeOrder.signalPrice) / closeOrder.signalPrice * 100;
        const slip = closeOrder.side === 'BUY' ? diff : -diff;
        closeOrder.estimatedSlippagePct = parseFloat(slip.toFixed(3));
      }

      // STRICT SAFETY CHECK: Only mark position closed if status is explicitly FILLED!
      if (closeStatus === 'FILLED') {
        const exitPrice = closeOrder.fillPrice || estPrice;
        const exitTime = closeOrder.updatedTime || Date.now();

        if (closeOrder.cumFee === undefined) {
          closeOrder.cumFee = calculateExecutionFee(closeOrder.sizeUSDT, closeOrder.orderType);
        }

        const closedPos = await this.positionManager.markPositionClosed(
          position.id,
          exitPrice,
          exitTime,
          reason,
          closeOrder.cumFee,
          {
            exitMarketRegime,
            accountEquity,
            openPositionsCount: resolvedOpenCount,
            closeOrderId: closeOrder.id,
          }
        );

        // If PositionManager no longer tracks the position (should be rare now that reconcile skips in-flight
        // symbols), derive PnL from the fill itself rather than booking a fake 0.00 for a trade that really closed.
        let fallbackGross = 0;
        let fallbackFees = 0;
        let fallbackPct = 0;
        if (!closedPos) {
          const isBuyPos = position.side.toUpperCase() === 'BUY';
          const ctValPos = position.ctVal || 1;
          fallbackGross = (isBuyPos ? exitPrice - position.entryPrice : position.entryPrice - exitPrice) * position.qty * ctValPos;
          fallbackFees = (position.entryFee || 0) + (closeOrder.cumFee || 0);
          fallbackPct = position.entryPrice > 0 ? ((isBuyPos ? exitPrice - position.entryPrice : position.entryPrice - exitPrice) / position.entryPrice) * 100 : 0;
          this.auditLogger('RECONCILIATION_DISCREPANCY', `Close of ${position.symbol} confirmed but position was no longer tracked; PnL derived from fill.`, { positionId: position.id, symbol: position.symbol });
        }
        const pnl = closedPos?.pnl !== undefined ? closedPos.pnl : parseFloat((fallbackGross - fallbackFees).toFixed(4));
        const pnlPct = closedPos?.pnlPct !== undefined ? closedPos.pnlPct : parseFloat(fallbackPct.toFixed(2));
        const grossPnl = closedPos?.grossPnl !== undefined ? closedPos.grossPnl : (closedPos ? pnl : parseFloat(fallbackGross.toFixed(4)));
        const totalFees = closedPos ? ((closedPos.entryFee || 0) + (closedPos.exitFee || 0)) : fallbackFees;

        closeOrder.realizedPnl = pnl;
        closeOrder.realizedPnlPct = pnlPct;

        try {
          const activeAdapter = this.getActiveAdapter();
          const postCloseEquity = await activeAdapter.getEquity();
          const postCloseBalance = activeAdapter.getWalletBalance
            ? await activeAdapter.getWalletBalance()
            : (accountBalance !== undefined ? parseFloat((accountBalance + pnl - totalFees).toFixed(2)) : undefined);

          if (postCloseEquity > 0) {
            closeOrder.accountEquity = postCloseEquity;
          }
          if (postCloseBalance !== undefined) {
            closeOrder.accountBalance = postCloseBalance;
          }
          closeOrder.openPositionsCount = this.positionManager.getActivePositions().length;
          this.orders.set(clientOrderId, closeOrder);
        } catch (e) {
          // ignore error updating post-close telemetry
        }

        // Record trade in persistent SymbolStatsTracker rolling window
        if (this.symbolStatsTracker) {
          const mfeVal = position.mfePct !== undefined ? position.mfePct : (closedPos?.mfePct ?? 0);
          const maeVal = position.maePct !== undefined ? position.maePct : (closedPos?.maePct ?? 0);
          const timeToMfeVal = position.timeToMfe15Minutes !== undefined
            ? position.timeToMfe15Minutes
            : (closeOrder.holdingTimeMinutes !== undefined && closeOrder.holdingTimeMinutes <= 5.0 && mfeVal >= 1.5 ? closeOrder.holdingTimeMinutes : undefined);
          const isFast = position.isFastRunner !== undefined
            ? position.isFastRunner
            : (Boolean(timeToMfeVal !== undefined && timeToMfeVal <= 5.0) || (closeOrder.holdingTimeMinutes !== undefined && closeOrder.holdingTimeMinutes <= 5.0 && mfeVal >= 1.5));

          this.symbolStatsTracker.recordClosedTrade({
            positionId: position.id,
            symbol: position.symbol,
            pnl,
            pnlPct,
            mfePct: mfeVal,
            maePct: maeVal,
            holdingTimeMinutes: closeOrder.holdingTimeMinutes,
            timeToMfe15Minutes: timeToMfeVal,
            isFastRunner: isFast,
            exitTime,
            hitMfe15: mfeVal >= 1.5,
            isWin: pnl > 0,
            intent: reason,
          });
        }

        this.auditLogger('POSITION_CLOSED', `Position ${position.symbol} closed on ${this.executionMode} at $${formatPrice(exitPrice)} (${reason}) - Net PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (Gross: ${grossPnl >= 0 ? '+' : ''}$${grossPnl.toFixed(2)}, Fees: -$${totalFees.toFixed(4)}) [MAE: ${position.maePct || 0}%, MFE: ${position.mfePct || 0}%]`, {
          positionId: position.id,
          symbol: position.symbol,
          exitPrice,
          reason,
          pnl,
          pnlPct,
          grossPnl,
          maePct: position.maePct,
          mfePct: position.mfePct,
          marketRegimeAtEntry: position.marketRegime,
          marketRegimeAtExit: exitMarketRegime,
          accountEquity: closeOrder.accountEquity,
          accountBalance: closeOrder.accountBalance,
          openPositionsCount: closeOrder.openPositionsCount,
          leverage: position.leverage || '1x',
          signalScore: position.signalScore,
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
      position.lastCloseAttempt = Date.now();
      const errMsg = err?.message || String(err);

      // Reconcile with exchange: If OKX reported position does not exist, all operations failed, or burst limit
      // verify if the position is already closed or non-existent on the exchange.
      if (
        targetAdapter &&
        (errMsg.includes('51006') ||
         errMsg.includes('51001') ||
         errMsg.includes('51000') ||
         errMsg.includes('does not exist') ||
         errMsg.includes('All operations failed') ||
         errMsg.includes('All order placement attempts failed') ||
         errMsg.includes('burst') ||
         errMsg.includes('sCode [1]'))
      ) {
        let isClosedOnExchange = true;
        if (typeof targetAdapter.getOpenPositions === 'function') {
          try {
            const openPositions = await targetAdapter.getOpenPositions();
            const normalizeKey = (s: string) => (s || '').trim().toUpperCase().replace(/-SWAP$/, '').replace(/-/g, '');
            const targetKey = normalizeKey(position.symbol);
            const stillOpen = openPositions.find((p) => normalizeKey(p.symbol) === targetKey && p.size > 0);
            if (stillOpen) {
              isClosedOnExchange = false;
            }
          } catch (recErr) {
            isClosedOnExchange = true;
          }
        }

        if (isClosedOnExchange) {
          this.auditLogger('POSITION_CLOSED', `Reconciliation: Position ${position.symbol} does not exist on exchange (${errMsg}). Marking as closed locally.`, {
            positionId: position.id,
            symbol: position.symbol,
            reason: 'CLOSED_EXTERNALLY',
          });
          await this.positionManager.markPositionClosed(
            position.id,
            estPrice,
            Date.now(),
            'MANUAL_CLOSE',
            0,
            { exitMarketRegime, accountEquity, openPositionsCount: resolvedOpenCount, closeOrderId: closeOrder.id }
          );
          closeOrder.status = 'FILLED';
          closeOrder.fillPrice = estPrice;
          return { success: true, order: closeOrder };
        }
      }

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
      if (order.intent === 'ENTRY' && !order.entryPrice) {
        order.entryPrice = update.avgPrice;
      }
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
          `Confirmed fill via ${update.source}: ${order.symbol} +${incrementalQty} @ $${formatPrice(fillPrice)} (cum: ${newCumFilledQty}/${order.qty})`,
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
      // Query first, wait afterwards: market orders (and every paper fill) are already FILLED on the first query.
      // The previous unconditional 800ms pre-sleep made each close take >=0.8s, so closing ~100 open positions
      // sequentially (risk monitor / experiment end) took over a minute while prices kept moving.
      if (attempt > 1) {
        await new Promise((r) => setTimeout(r, delayMs));
      }

      const activeAdapter = this.getActiveAdapter();
      const statusRes = await activeAdapter.queryOrderStatus(order.symbol, order.id, order.exchangeOrderId);

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

export { reconcileHistoricalOrderPrecision } from './orderPrecisionReconciliation';

