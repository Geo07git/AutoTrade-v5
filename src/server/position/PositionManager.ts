import {
  Position,
  ProfileConfig,
  OKXRawPosition,
  OrderRecord,
  ProfileType,
  AuditLogType,
  EquityProtectionEvent,
  EquityProtectionClosedPositionSummary,
} from '../../shared/types';
import { formatPrice } from '../../shared/formatters';
import { OrderManager } from '../order/OrderManager';
import { JsonStore } from '../store';
import { formatBucharestDateTime } from '../utils/timezone';
import { experimentManager } from '../experiment/ExperimentManager';

export class PositionManager {
  private activePositions: Position[] = [];
  private closedHistory: Position[] = [];
  private highestEquity: number = 200.0; // Initialize with base equity
  private initialEquity: number = 200.0;
  private equityProtCount: number = 0;
  private auditLogger: (type: AuditLogType, message: string, details?: any) => void;
  private ctValResolver: (symbol: string) => number = () => 1;
  private eventStore: JsonStore<EquityProtectionEvent[]> = new JsonStore<EquityProtectionEvent[]>(
    'equity_protection_events.json',
    []
  );
  private equityProtEvents: EquityProtectionEvent[] = [];
  private isTriggeringEquityProtection: boolean = false;
  // Non-reentrancy guard: updatePrices is invoked by 3 independent timers (WS ticker, 2.5s monitor, 15s tick).
  private isUpdatingPrices: boolean = false;
  // Monotonic counter bumped on every position mutation; lets reconcile detect that its exchange snapshot is stale.
  private mutationSeq: number = 0;
  private recentlyClosedAt: Map<string, number> = new Map();
  private recentlyOpenedAt: Map<string, number> = new Map();
  // Per-symbol bookkeeping for re-entry control (closedHistory is capped at 200 so it cannot be used for this).
  private entryTimes: Map<string, number[]> = new Map();
  private lastLossAt: Map<string, number> = new Map();
  private static readonly RECONCILE_GRACE_MS = 30_000;
  // A 2-tick confirmation filters single-print wicks, but it must not let a real crash run unchecked:
  // when price is already this far beyond the trigger, exit immediately (observed avg SL fill was -3.18% vs -3% set).
  private static readonly SL_IMMEDIATE_BUFFER_PCT = 0.25;
  private static readonly BE_IMMEDIATE_BUFFER_PCT = 0.25;

  constructor(auditLogger: (type: AuditLogType, message: string, details?: any) => void) {
    this.auditLogger = auditLogger;
    const rawEvents = this.eventStore.get() || [];
    this.equityProtEvents = this.deduplicateAndSortEvents(rawEvents);
    this.equityProtCount = this.equityProtEvents.length;
    if (this.equityProtCount === 0) {
      this.initEventsFromOrdersHistory();
    } else {
      this.eventStore.save(this.equityProtEvents);
    }
  }

  /**
   * Cleans up and merges any duplicate event clusters created by concurrent ticks
   * ensuring exactly 1 log entry per equity protection cycle with sequential index.
   */
  private deduplicateAndSortEvents(rawEvents: EquityProtectionEvent[]): EquityProtectionEvent[] {
    if (!rawEvents || rawEvents.length === 0) return [];

    // Sort chronologically ascending
    const sorted = [...rawEvents].sort((a, b) => a.timestamp - b.timestamp);
    const uniqueGroups: EquityProtectionEvent[][] = [];

    for (const ev of sorted) {
      let matchedGroup: EquityProtectionEvent[] | undefined;
      for (const group of uniqueGroups) {
        const first = group[0];
        // Only group duplicate events that occurred within 15 seconds of each other during the same tick cascade
        const isTimeClose = Math.abs(first.timestamp - ev.timestamp) < 15000;
        if (isTimeClose) {
          matchedGroup = group;
          break;
        }
      }

      if (matchedGroup) {
        matchedGroup.push(ev);
      } else {
        uniqueGroups.push([ev]);
      }
    }

    const cleanedEvents: EquityProtectionEvent[] = [];
    uniqueGroups.forEach((group, groupIdx) => {
      // Pick the best event in the group (the one with the most closed positions or the latest)
      const best = group.reduce((prev, curr) => {
        const prevCount = prev.closedPositions?.length || 0;
        const currCount = curr.closedPositions?.length || 0;
        return currCount >= prevCount ? curr : prev;
      }, group[0]);

      // Re-index trigger sequentially
      const triggerIdx = groupIdx + 1;
      const formattedDate = best.timestamp ? formatBucharestDateTime(new Date(best.timestamp)) : (best.dateStr && !best.dateStr.includes('T') ? best.dateStr : formatBucharestDateTime(new Date()));
      cleanedEvents.push({
        ...best,
        triggerIndex: triggerIdx,
        dateStr: formattedDate,
      });
    });

    // Sort newest first (descending by timestamp)
    cleanedEvents.sort((a, b) => b.timestamp - a.timestamp);
    return cleanedEvents;
  }

  private initEventsFromOrdersHistory(): void {
    try {
      const ordersStore = new JsonStore<OrderRecord[]>('orders.json', []);
      const orders = ordersStore.get() || [];
      const epOrders = orders.filter((o) => o.intent === 'EQUITY_PROTECTION');

      // Group by timestamp proximity (within 5 seconds)
      const groups: OrderRecord[][] = [];
      for (const ord of epOrders) {
        let added = false;
        for (const g of groups) {
          if (Math.abs(g[0].createdTime - ord.createdTime) < 5000) {
            g.push(ord);
            added = true;
            break;
          }
        }
        if (!added) {
          groups.push([ord]);
        }
      }

      // Sort chronological
      groups.sort((a, b) => a[0].createdTime - b[0].createdTime);

      const generatedEvents: EquityProtectionEvent[] = [];

      // NOTE: previous versions pre-seeded a fabricated "Trigger 1" (SOL, $3.73 vault, fixed 203.80 peak) and
      // hard-coded vault amounts. Only real, order-derived events are reconstructed now; amounts that cannot be
      // recovered from the order history are left at 0 rather than invented.
      let currentVault = 0;

      groups.forEach((g) => {
        const first = g[0];
        const match = first.exitReasonDetail?.match(/vârful capitalului de lucru \(\$([0-9.]+)\)/);
        const peak = match ? parseFloat(match[1]) : 204.5;
        const ddMatch = first.exitReasonDetail?.match(/Drawdown de -([0-9.]+)%/);
        const dd = ddMatch ? parseFloat(ddMatch[1]) : 0.30;
        const limitMatch = first.exitReasonDetail?.match(/limită permisă: -([0-9.]+)%/);
        const limit = limitMatch ? parseFloat(limitMatch[1]) : 0.30;

        const closedSummary: EquityProtectionClosedPositionSummary[] = g.map((o) => ({
          symbol: o.symbol,
          side: o.side,
          sizeUSDT: o.sizeUSDT || 0,
          entryPrice: o.entryPrice || 0,
          closePrice: o.fillPrice || o.entryPrice || 0,
          pnl: o.realizedPnl,
          holdingTimeMinutes: o.holdingTimeMinutes,
          exitReasonDetail: o.exitReasonDetail,
        }));

        const trigIdx = generatedEvents.length + 1;
        const profitLocked = 0;
        const vaultBefore = currentVault;
        currentVault = parseFloat((currentVault + profitLocked).toFixed(2));

        generatedEvents.push({
          id: `ep_hist_${first.createdTime}_${trigIdx}`,
          triggerIndex: trigIdx,
          timestamp: first.createdTime,
          dateStr: new Date(first.createdTime).toLocaleString('ro-RO'),
          profile: (first.profile as ProfileType) || 'SCALP',
          executionMode: first.executionMode || 'PAPER',
          peakEquity: peak,
          effectiveEquity: parseFloat((peak * (1 - dd / 100)).toFixed(2)),
          totalEquity: parseFloat(((peak * (1 - dd / 100)) + vaultBefore).toFixed(2)),
          drawdownFromPeakPct: dd,
          configuredDrawdownLimitPct: limit,
          activationPrice: 0,
          activationPct: 0,
          vaultBefore,
          profitLockedToVault: profitLocked,
          vaultAfter: currentVault,
          baseCapital: this.initialEquity,
          closedPositionsCount: g.length,
          closedPositions: closedSummary,
        });
      });

      if (generatedEvents.length > 0) {
        // Sort newest first
        generatedEvents.sort((a, b) => b.timestamp - a.timestamp);
        this.equityProtEvents = generatedEvents;
        this.equityProtCount = this.equityProtEvents.length;
        this.eventStore.save(this.equityProtEvents);
      }
    } catch (err) {
      console.warn('[PositionManager] Failed to init historical EP events:', err);
    }
  }

  public getEquityProtectionEvents(): EquityProtectionEvent[] {
    return this.equityProtEvents;
  }

  public clearEquityProtectionEvents(): void {
    this.equityProtEvents = [];
    this.equityProtCount = 0;
    this.eventStore.save([]);
  }

  public setCtValResolver(resolver: (symbol: string) => number): void {
    this.ctValResolver = resolver;
  }

  public getActivePositions(): Position[] {
    return this.activePositions;
  }

  /** Number of entries opened on this symbol within the last `windowMs`. */
  public getRecentEntryCount(symbol: string, windowMs: number): number {
    const now = Date.now();
    return (this.entryTimes.get(symbol) || []).filter((t) => now - t < windowMs).length;
  }

  /** Minutes since the last losing close (or stop-loss) on this symbol; Infinity if none. */
  public getMinutesSinceLastLoss(symbol: string): number {
    const t = this.lastLossAt.get(symbol);
    return t ? (Date.now() - t) / 60000 : Infinity;
  }

  public getMutationSeq(): number {
    return this.mutationSeq;
  }

  /** True while any position is mid-close (CLOSING) or a price/risk pass is running. */
  public hasInFlightOperations(): boolean {
    return this.isUpdatingPrices || this.isTriggeringEquityProtection || this.activePositions.some((p) => p.status === 'CLOSING');
  }

  public getHighestEquity(): number {
    return this.highestEquity;
  }

  public getEquityTrailingState(config: ProfileConfig, currentEquity: number, profitVault: number = 0) {
    const effectiveEquity = Math.max(1, currentEquity - profitVault);
    const isEnabled = (config.equityProtectionActivationPct || 0) > 0 && (config.equityTrailingDrawdownPct || 0) > 0;
    const activationPrice = isEnabled ? this.initialEquity * (1 + (config.equityProtectionActivationPct || 0) / 100) : this.initialEquity;
    const isActive = isEnabled && this.highestEquity >= activationPrice;
    
    let sellThreshold: number | null = null;
    let sellThresholdTotal: number | null = null;
    if (isActive && config.equityTrailingDrawdownPct && config.equityTrailingDrawdownPct > 0) {
      sellThreshold = this.highestEquity * (1 - config.equityTrailingDrawdownPct / 100);
      sellThresholdTotal = parseFloat((sellThreshold + profitVault).toFixed(2));
    }
    
    const currentDrawdownPct = isActive ? ((this.highestEquity - effectiveEquity) / this.highestEquity) * 100 : 0;
    
    return {
      isEnabled,
      isActive,
      activationPrice: parseFloat(activationPrice.toFixed(2)),
      activationTotalEquity: parseFloat((activationPrice + profitVault).toFixed(2)),
      activationPct: config.equityProtectionActivationPct || 0,
      peakEquity: parseFloat(this.highestEquity.toFixed(2)),
      peakTotalEquity: parseFloat((this.highestEquity + profitVault).toFixed(2)),
      drawdownLimitPct: config.equityTrailingDrawdownPct || 0,
      currentDrawdownPct: Math.max(0, parseFloat(currentDrawdownPct.toFixed(2))),
      sellThreshold: sellThreshold ? parseFloat(sellThreshold.toFixed(2)) : null,
      sellThresholdTotal,
      triggerCount: this.equityProtCount,
      workingEquity: parseFloat(effectiveEquity.toFixed(2)),
      profitVault: parseFloat(profitVault.toFixed(2)),
      history: this.equityProtEvents,
    };
  }

  public updateHighestEquity(currentEquity: number): void {
    if (currentEquity > this.highestEquity) {
      this.highestEquity = currentEquity;
    }
  }

  public resetHighestEquity(equity: number = 200.0): void {
    this.highestEquity = equity;
    this.initialEquity = equity;
  }

  public getPosition(symbol: string): Position | undefined {
    return this.activePositions.find((p) => p.symbol === symbol && p.status === 'OPEN');
  }

  public hasOpenPosition(symbol: string): boolean {
    return this.activePositions.some((p) => p.symbol === symbol && p.status === 'OPEN');
  }

  public getClosedHistory(): Position[] {
    return this.closedHistory;
  }

  public clearHistory(): void {
    this.closedHistory = [];
  }

  public getLastClosedTime(symbol: string): number {
    const closedForSymbol = this.closedHistory.filter(p => p.symbol === symbol);
    if (closedForSymbol.length === 0) return 0;
    // Sort descending by exitTime
    closedForSymbol.sort((a, b) => (b.exitTime || 0) - (a.exitTime || 0));
    return closedForSymbol[0].exitTime || 0;
  }

  public setActivePositions(positions: Position[]) {
    this.mutationSeq++;
    this.activePositions = positions
      .filter((p) => p.status === 'OPEN')
      .map((p) => {
        const ctVal = p.ctVal || 1;
        const validQty = p.qty && !isNaN(p.qty) && p.qty > 0
          ? p.qty
          : (p.sizeUSDT / ((p.entryPrice || 1) * ctVal));
        return {
          ...p,
          ctVal,
          qty: validQty,
          sizeUSDT: parseFloat((validQty * (p.entryPrice || 1) * ctVal).toFixed(2)),
        };
      });
  }

  public setClosedHistory(history: Position[]) {
    this.closedHistory = history;
  }

  /**
   * Called when an ENTRY order has had an incremental fill confirmed.
   * Incremental quantity ensures that subsequent fills (or multiple events from polling/WS)
   * never duplicate or over-count position sizes.
   */
  public async onOrderFilled(
    order: OrderRecord,
    incrementalQty?: number,
    fillPriceOverride?: number,
    feeIncrement?: number
  ): Promise<Position | null> {
    const entryPrice = fillPriceOverride && fillPriceOverride > 0
      ? fillPriceOverride
      : (order.fillPrice && order.fillPrice > 0 ? order.fillPrice : (order.qty > 0 ? (order.sizeUSDT / ((order.ctVal || 1) * order.qty)) : 0));

    const filledQty = incrementalQty !== undefined
      ? incrementalQty
      : (order.filledQty && order.filledQty > 0 ? order.filledQty : order.qty);

    if (filledQty <= 0) {
      return null;
    }

    this.mutationSeq++;
    this.recentlyOpenedAt.set(order.symbol, Date.now());

    const ctVal = order.ctVal || 1;
    const realSizeUSDT = filledQty * entryPrice * ctVal;
    const feeToAdd = feeIncrement !== undefined
      ? feeIncrement
      : (order.cumFee !== undefined ? order.cumFee : parseFloat((realSizeUSDT * 0.0005).toFixed(4)));

    // Check if position already exists for this symbol (add incremental quantity)
    const existing = this.activePositions.find((p) => p.symbol === order.symbol && p.status === 'OPEN');

    if (existing) {
      // Weighted average entry price with incremental fill - preserved with exact full precision!
      const totalQty = existing.qty + filledQty;
      const avgEntryPrice = (existing.qty * existing.entryPrice + filledQty * entryPrice) / totalQty;
      existing.qty = parseFloat(totalQty.toFixed(6));
      existing.entryPrice = avgEntryPrice; // Exact full precision, no toFixed(4)
      existing.ctVal = existing.ctVal || ctVal;
      existing.sizeUSDT = parseFloat((existing.qty * existing.entryPrice * (existing.ctVal || 1)).toFixed(2));
      existing.entryFee = parseFloat(((existing.entryFee || 0) + feeToAdd).toFixed(4));
      existing.highestPrice = Math.max(existing.highestPrice || avgEntryPrice, entryPrice);
      existing.lowestPrice = Math.min(existing.lowestPrice || avgEntryPrice, entryPrice);
      existing.entryOrderId = existing.entryOrderId || order.id;
      order.positionId = existing.id;

      this.auditLogger('POSITION_UPDATED', `Position ${order.symbol} increased by +${filledQty} contracts to ${existing.qty} @ avg $${formatPrice(existing.entryPrice)} (Entry Fee: $${existing.entryFee})`, {
        symbol: order.symbol,
        incrementalQty: filledQty,
        totalQty: existing.qty,
        entryPrice: existing.entryPrice,
        entryFee: existing.entryFee,
        positionId: existing.id,
      });

      return existing;
    }

    const newPosition: Position = {
      id: `pos_${Date.now()}_${order.symbol}`,
      symbol: order.symbol,
      side: order.side.toUpperCase() === 'SELL' ? 'SELL' : 'BUY',
      qty: parseFloat(filledQty.toFixed(6)),
      entryPrice: entryPrice, // Exact fill price without any toFixed(4) rounding!
      ctVal,
      sizeUSDT: parseFloat(realSizeUSDT.toFixed(2)),
      entryFee: parseFloat(feeToAdd.toFixed(4)),
      exitFee: 0,
      status: 'OPEN',
      entryTime: Date.now(),
      highestPrice: entryPrice,
      lowestPrice: entryPrice,
      maePct: 0,
      mfePct: 0,
      stopLossPrice: order.stopLossPrice,
      isFadeTrade: order.isFadeTrade,
      profile: order.profile,
      source: order.executionMode === 'PAPER' ? 'PAPER' : 'LOCAL',
      executionMode: order.executionMode || 'TESTNET',
      marketRegime: order.marketRegime,
      entryOrderId: order.id,
      signalScore: order.signalScore,
      signalPrice: order.signalPrice,
      estimatedSlippagePct: order.estimatedSlippagePct,
      leverage: order.leverage || '1x',
      openPositionsAtEntry: order.openPositionsCount || (this.activePositions.length + 1),
      accountEquityAtEntry: order.accountEquity,
    };

    order.positionId = newPosition.id;
    this.activePositions.push(newPosition);

    this.auditLogger('POSITION_OPENED', `Opened ${order.side} position on ${order.symbol}: ${filledQty} contracts @ $${formatPrice(entryPrice)} ($${realSizeUSDT.toFixed(2)}) [Fee: $${newPosition.entryFee}]`, {
      positionId: newPosition.id,
      symbol: newPosition.symbol,
      side: newPosition.side,
      qty: newPosition.qty,
      entryPrice: newPosition.entryPrice,
      sizeUSDT: newPosition.sizeUSDT,
      profile: newPosition.profile,
      leverage: newPosition.leverage,
      signalScore: newPosition.signalScore,
      marketRegime: newPosition.marketRegime,
      openPositionsAtEntry: newPosition.openPositionsAtEntry,
    });

    const times = (this.entryTimes.get(newPosition.symbol) || []).filter((t) => Date.now() - t < 6 * 3600_000);
    times.push(Date.now());
    this.entryTimes.set(newPosition.symbol, times);

    experimentManager.logTradeEntry(newPosition.symbol, newPosition.side, newPosition.signalScore ?? 0, newPosition.entryPrice, newPosition.sizeUSDT, {
      entryRegime: newPosition.marketRegime,
      openPositionsAtEntry: newPosition.openPositionsAtEntry,
      slippagePct: newPosition.estimatedSlippagePct,
    });

    return newPosition;
  }

  /**
   * Updates current PNL for open positions and checks Stop-Loss / Trailing Stop conditions.
   * If an exit rule triggers, delegates execution to OrderManager!
   */
  public async updatePrices(
    currentPrices: Record<string, number>,
    config: ProfileConfig,
    orderManager: OrderManager,
    currentEquity: number,
    options?: {
      profitVault?: number;
      baseCapital?: number;
      lockProfitVault?: boolean;
      marketRegime?: string;
      accountEquity?: number;
      accountBalance?: number;
      onVaultProfitLocked?: (lockedAmount: number, totalVault: number) => void;
    }
  ) {
    // Single-flight: the WS ticker, the 2.5s risk monitor and the 15s tick all call this. Overlapping passes
    // used stale price snapshots, raced reconcileWithExchange and produced duplicate close attempts.
    // A skipped pass is harmless: the next 2.5s monitor cycle re-evaluates every position.
    if (this.isUpdatingPrices) return;
    this.isUpdatingPrices = true;
    try {
      await this.updatePricesInternal(currentPrices, config, orderManager, currentEquity, options);
    } finally {
      this.isUpdatingPrices = false;
    }
  }

  private async updatePricesInternal(
    currentPrices: Record<string, number>,
    config: ProfileConfig,
    orderManager: OrderManager,
    currentEquity: number,
    options?: {
      profitVault?: number;
      baseCapital?: number;
      lockProfitVault?: boolean;
      marketRegime?: string;
      accountEquity?: number;
      accountBalance?: number;
      onVaultProfitLocked?: (lockedAmount: number, totalVault: number) => void;
    }
  ) {
    const profitVault = Math.max(0, options?.profitVault || 0);
    const effectiveEquity = Math.max(1, currentEquity - profitVault);

    // If already processing an equity protection trigger, skip to prevent re-entrant duplicate triggers
    if (this.isTriggeringEquityProtection) {
      return;
    }

    // Equity Protection Check (Disabled if either activationPct or trailingDrawdownPct is <= 0)
    if (!experimentManager.getState().isActive) {
      this.updateHighestEquity(effectiveEquity);
    }
    
    // Equity Protection is meaningless during an experiment (synthetic $1B fund vs. a ~$200 baseline) and
    // would fire a 100% "drawdown" the moment the experiment ends and equity falls back to the real balance.
    const isEquityProtectionEnabled =
      !experimentManager.getState().isActive &&
      (config.equityProtectionActivationPct ?? 0) > 0 &&
      (config.equityTrailingDrawdownPct ?? 0) > 0;

    if (isEquityProtectionEnabled) {
      const peakEquity = this.getHighestEquity();
      const activationEquity = this.initialEquity * (1 + config.equityProtectionActivationPct / 100);
      
      // If we ever hit activationEquity, the peakEquity will naturally be >= activationEquity
      if (peakEquity >= activationEquity) {
        const drawdownFromPeak = (peakEquity - effectiveEquity) / peakEquity * 100;
        if (drawdownFromPeak >= config.equityTrailingDrawdownPct && this.activePositions.some((p) => p.status === 'OPEN') && !this.isTriggeringEquityProtection) {
          this.isTriggeringEquityProtection = true;

          try {
            // Only OPEN positions are closable. NOTE: do NOT pre-set status='CLOSING' here:
            // OrderManager.executeCloseOrder rejects any position whose status !== 'OPEN' and locks it itself,
            // so the previous pre-lock made every Equity Protection close a silent no-op (positions stuck in CLOSING).
            // Re-entrancy is already prevented by isTriggeringEquityProtection / isUpdatingPrices.
            const positionsToClose = this.activePositions.filter((p) => p.status === 'OPEN');

            const closedSummary: EquityProtectionClosedPositionSummary[] = positionsToClose.map((p) => {
              const exitPrice = currentPrices[p.symbol] || p.entryPrice;
              const sizeUSDT = p.sizeUSDT || 0;
              const ctVal = p.ctVal || 1;
              const pnl = p.side === 'BUY'
                ? (exitPrice - p.entryPrice) * p.qty * ctVal
                : (p.entryPrice - exitPrice) * p.qty * ctVal;
              return {
                symbol: p.symbol,
                side: p.side,
                sizeUSDT: parseFloat(sizeUSDT.toFixed(2)),
                entryPrice: p.entryPrice,
                closePrice: exitPrice,
                pnl: parseFloat(pnl.toFixed(2)),
                holdingTimeMinutes: p.holdingTimeMinutes,
                exitReasonDetail: `Equity Protection declanșat: Drawdown de -${drawdownFromPeak.toFixed(2)}% de la vârful capitalului de lucru ($${peakEquity.toFixed(2)}) (limită permisă: -${config.equityTrailingDrawdownPct}%)`,
              };
            });

            this.equityProtCount++;

            const cycleProfit = options?.lockProfitVault
              ? Math.max(0, parseFloat((effectiveEquity - this.initialEquity).toFixed(2)))
              : 0;

            const baseCap = options?.baseCapital || this.initialEquity;
            const vaultBefore = parseFloat(profitVault.toFixed(2));
            const vaultAfter = parseFloat((profitVault + cycleProfit).toFixed(2));

            const newEvent: EquityProtectionEvent = {
              id: `ep_${Date.now()}_${this.equityProtCount}`,
              triggerIndex: this.equityProtCount,
              timestamp: Date.now(),
              dateStr: formatBucharestDateTime(new Date()),
              profile: config.type,
              executionMode: positionsToClose[0]?.executionMode || 'PAPER',
              peakEquity: parseFloat(peakEquity.toFixed(2)),
              effectiveEquity: parseFloat(effectiveEquity.toFixed(2)),
              totalEquity: parseFloat(currentEquity.toFixed(2)),
              drawdownFromPeakPct: parseFloat(drawdownFromPeak.toFixed(2)),
              configuredDrawdownLimitPct: config.equityTrailingDrawdownPct || 0,
              activationPrice: parseFloat(activationEquity.toFixed(2)),
              activationPct: config.equityProtectionActivationPct || 0,
              vaultBefore,
              profitLockedToVault: cycleProfit,
              vaultAfter,
              baseCapital: baseCap,
              closedPositionsCount: positionsToClose.length,
              closedPositions: closedSummary,
            };

            this.equityProtEvents.unshift(newEvent);
            this.eventStore.save(this.equityProtEvents);

            this.auditLogger('KILL_SWITCH_ENGAGED', `Equity Protection triggered! Drawdown of ${drawdownFromPeak.toFixed(2)}% exceeded limit of ${config.equityTrailingDrawdownPct}%. Closing ${positionsToClose.length} positions in 1 unified trigger cycle.`, {
              peakEquity,
              currentEquity,
              effectiveEquity,
              drawdownFromPeak,
              triggerIndex: this.equityProtCount,
              closedPositionsCount: positionsToClose.length,
            });

            // Immediately reset equity baseline so trailing state is clean BEFORE awaiting async orders
            if (options?.lockProfitVault) {
              if (cycleProfit > 0 && options.onVaultProfitLocked) {
                options.onVaultProfitLocked(cycleProfit, vaultAfter);
              }
              this.initialEquity = baseCap;
              this.highestEquity = baseCap;
            } else {
              this.initialEquity = effectiveEquity;
              this.highestEquity = effectiveEquity;
            }

            // Execute close orders for each position
            for (const pos of positionsToClose) {
              await orderManager.executeCloseOrder({
                position: pos,
                reason: 'EQUITY_PROTECTION',
                currentPrice: currentPrices[pos.symbol] || pos.entryPrice,
                exitReasonDetail: `Equity Protection declanșat: Drawdown de -${drawdownFromPeak.toFixed(2)}% de la vârful capitalului de lucru ($${peakEquity.toFixed(2)}) (limită permisă: -${config.equityTrailingDrawdownPct}%)`,
                triggerStopValue: config.equityTrailingDrawdownPct,
                exitMarketRegime: options?.marketRegime,
                accountEquity: currentEquity,
                accountBalance: options?.accountBalance,
                openPositionsCount: this.activePositions.length,
              });
            }
          } finally {
            this.isTriggeringEquityProtection = false;
          }
        }
      }
    }

    for (const pos of [...this.activePositions]) {
      if (pos.status !== 'OPEN') continue;

      const rawPrice = currentPrices[pos.symbol] || 
                       currentPrices[pos.symbol.replace('-SWAP', '')] || 
                       currentPrices[`${pos.symbol}-SWAP`] || 
                       currentPrices[pos.symbol.replace('USDT', '-USDT')] ||
                       currentPrices[pos.symbol.replace('-USDT', 'USDT')] ||
                       pos.currentPrice;
      const currentPrice = rawPrice && rawPrice > 0 ? rawPrice : 0;
      if (!currentPrice || currentPrice <= 0) continue;

      pos.currentPrice = currentPrice;
      pos.holdingTimeMinutes = parseFloat(((Date.now() - pos.entryTime) / 60000).toFixed(1));

      // Update High/Low excursions
      pos.highestPrice = Math.max(pos.highestPrice || pos.entryPrice, currentPrice);
      pos.lowestPrice = Math.min(pos.lowestPrice || pos.entryPrice, currentPrice);

      // PNL calculation
      const isBuy = pos.side.toUpperCase() === 'BUY';
      const pnlPct = isBuy
        ? ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100
        : ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100;
      pos.pnlPct = parseFloat(pnlPct.toFixed(2));
      const ctVal = pos.ctVal || 1;
      pos.sizeUSDT = parseFloat((pos.qty * pos.entryPrice * ctVal).toFixed(2));
      // Calculate exact gross unrealized PnL from price difference, contracts, and ctVal
      const exactUnrealizedPnl = isBuy
        ? (currentPrice - pos.entryPrice) * pos.qty * ctVal
        : (pos.entryPrice - currentPrice) * pos.qty * ctVal;
      pos.pnl = parseFloat(exactUnrealizedPnl.toFixed(4));

      // Continuous MAE (Maximum Adverse Excursion) & MFE (Maximum Favorable Excursion)
      const lowestPnlPct = isBuy
        ? ((pos.lowestPrice - pos.entryPrice) / pos.entryPrice) * 100
        : ((pos.entryPrice - pos.highestPrice) / pos.entryPrice) * 100;
      const highestPnlPct = isBuy
        ? ((pos.highestPrice - pos.entryPrice) / pos.entryPrice) * 100
        : ((pos.entryPrice - pos.lowestPrice) / pos.entryPrice) * 100;

      pos.maePct = parseFloat(Math.min(0, pos.maePct !== undefined ? pos.maePct : 0, lowestPnlPct).toFixed(2));
      pos.mfePct = parseFloat(Math.max(0, pos.mfePct !== undefined ? pos.mfePct : 0, highestPnlPct).toFixed(2));

      // Passive Velocity Telemetry: Record time in minutes to first reach MFE >= 1.5%
      if (pos.mfePct >= 1.5 && (pos.timeToMfe15Minutes === undefined || pos.timeToMfe15Minutes === 0)) {
        const elapsedMins = parseFloat(((Date.now() - pos.entryTime) / 60000).toFixed(2));
        pos.timeToMfe15Minutes = elapsedMins;
        pos.isFastRunner = elapsedMins <= 5.0; // Early impulse velocity (reached in primele 3-5 min)
      }

      // Ensure stopLossPrice matches the profile's hardStopLossPct (unless break-even is triggered)
      if (!pos.isBreakEvenTriggered) {
        const hardSlPrice = pos.side === 'BUY'
          ? pos.entryPrice * (1 - config.hardStopLossPct / 100)
          : pos.entryPrice * (1 + config.hardStopLossPct / 100);
        pos.stopLossPrice = hardSlPrice;
      }

      // Take-Profit Logic
      if (config.takeProfitPct > 0) {
          if ((pos.side === 'BUY' && pnlPct >= config.takeProfitPct) || (pos.side === 'SELL' && pnlPct >= config.takeProfitPct)) {
              this.auditLogger('POSITION_UPDATED', `Take-Profit triggered for ${pos.symbol} at +${pnlPct.toFixed(2)}%`);
              await orderManager.executeCloseOrder({
                position: pos,
                reason: 'TAKE_PROFIT',
                currentPrice,
                exitReasonDetail: `Take-Profit atins la +${pnlPct.toFixed(2)}% (țintă setată: +${config.takeProfitPct}%)`,
                exitMarketRegime: options?.marketRegime,
                accountEquity: currentEquity,
                accountBalance: options?.accountBalance,
                openPositionsCount: this.activePositions.length,
              });
              continue;
          }
      }

      // Break-Even Logic
      if (pos.side === 'BUY' && pnlPct >= config.breakEvenActivationPct && (!pos.isBreakEvenTriggered || pos.stopLossPrice < pos.entryPrice)) {
          pos.breakEvenStopPrice = pos.entryPrice * 1.0025; // Move SL to entry + 0.25% buffer
          pos.stopLossPrice = pos.breakEvenStopPrice;
          pos.isBreakEvenTriggered = true;
          this.auditLogger('POSITION_UPDATED', `Break-Even triggered for ${pos.symbol}: SL mutat la intrare (+0.25% buffer).`);
      } else if (pos.side === 'SELL' && pnlPct >= config.breakEvenActivationPct && (!pos.isBreakEvenTriggered || pos.stopLossPrice > pos.entryPrice)) {
          pos.breakEvenStopPrice = pos.entryPrice * 0.9975; // Move SL to entry - 0.25% buffer
          pos.stopLossPrice = pos.breakEvenStopPrice;
          pos.isBreakEvenTriggered = true;
          this.auditLogger('POSITION_UPDATED', `Break-Even triggered for ${pos.symbol}: SL mutat la intrare (-0.25% buffer).`);
      }

      // 1. Break-Even Check vs Hard Stop Loss Check (Strict separation of exit reasons)
      if (pos.isBreakEvenTriggered) {
        const bePrice = pos.breakEvenStopPrice || (pos.side === 'BUY' ? pos.entryPrice * 1.0025 : pos.entryPrice * 0.9975);
        const rawBeHit = (pos.side === 'BUY' && currentPrice <= bePrice) ||
                         (pos.side === 'SELL' && currentPrice >= bePrice);

        if (rawBeHit) {
          pos.consecutiveBeHits = (pos.consecutiveBeHits || 0) + 1;
        } else {
          pos.consecutiveBeHits = 0;
        }

        const isBeHit = rawBeHit && (pos.consecutiveBeHits >= 2 || pnlPct <= -PositionManager.BE_IMMEDIATE_BUFFER_PCT);

        if (isBeHit) {
          this.auditLogger('POSITION_UPDATED', `Break-Even Stop atins pentru ${pos.symbol} la prețul $${formatPrice(currentPrice)} (SL mutat la intrare atins, PnL înregistrat: ${pnlPct.toFixed(2)}%)`, {
            symbol: pos.symbol,
            currentPrice,
            pnlPct,
            entryPrice: pos.entryPrice,
            breakEvenStopPrice: bePrice,
            breakEvenActivationPct: config.breakEvenActivationPct,
          });

          await orderManager.executeCloseOrder({
            position: pos,
            reason: 'BREAK_EVEN',
            currentPrice,
            exitReasonDetail: `Break-Even Stop atins la prețul $${formatPrice(currentPrice)} (SL mutat la intrare după atingerea țintei BE de +${config.breakEvenActivationPct}%, PnL înregistrat: ${pnlPct.toFixed(2)}%)`,
            triggerStopValue: config.breakEvenActivationPct,
            exitMarketRegime: options?.marketRegime,
            accountEquity: currentEquity,
            accountBalance: options?.accountBalance,
            openPositionsCount: this.activePositions.length,
          });
          continue;
        }
      } else {
        // 1b. Hard Stop Loss Check (ONLY when Break-Even has not been triggered)
        const hardSlPrice = pos.side === 'BUY'
          ? pos.entryPrice * (1 - config.hardStopLossPct / 100)
          : pos.entryPrice * (1 + config.hardStopLossPct / 100);
        pos.stopLossPrice = hardSlPrice;

        const rawSlHit = (pos.side === 'BUY' && currentPrice <= hardSlPrice) ||
                         (pos.side === 'SELL' && currentPrice >= hardSlPrice) ||
                         (pnlPct <= -config.hardStopLossPct);

        if (rawSlHit) {
          pos.consecutiveSlHits = (pos.consecutiveSlHits || 0) + 1;
        } else {
          pos.consecutiveSlHits = 0;
        }

        // Require at least 2 consecutive checks to confirm hard SL hit and eliminate false wicks / noise
        const isHardSlHit = rawSlHit && (pos.consecutiveSlHits >= 2 || pnlPct <= -(config.hardStopLossPct + PositionManager.SL_IMMEDIATE_BUFFER_PCT));

        if (isHardSlHit) {
          this.auditLogger('RISK_REJECTED', `Stop-Loss triggered for ${pos.symbol} at $${formatPrice(currentPrice)} (PnL: ${pnlPct.toFixed(2)}%, Limit: -${config.hardStopLossPct}%)`, {
            symbol: pos.symbol,
            currentPrice,
            pnlPct,
            hardStopLossPct: config.hardStopLossPct,
            stopLossPrice: hardSlPrice,
          });

          await orderManager.executeCloseOrder({
            position: pos,
            reason: 'STOP_LOSS',
            currentPrice,
            exitReasonDetail: `Stop-Loss hard la -${config.hardStopLossPct}% atins la prețul $${formatPrice(currentPrice)} (PnL înregistrat: ${pnlPct.toFixed(2)}%)`,
            triggerStopValue: config.hardStopLossPct,
            exitMarketRegime: options?.marketRegime,
            accountEquity: currentEquity,
            accountBalance: options?.accountBalance,
            openPositionsCount: this.activePositions.length,
          });
          continue;
        }
      }

      // 2. Trailing Stop Check
      let isTrailingActive = false;
      if (pos.side === 'BUY' && pos.highestPrice) {
        const peakPnlPct = ((pos.highestPrice - pos.entryPrice) / pos.entryPrice) * 100;
        if (peakPnlPct >= config.trailingActivationPct) {
          isTrailingActive = true;
          const retracementFromPeakPct = ((pos.highestPrice - currentPrice) / pos.highestPrice) * 100;
          if (retracementFromPeakPct >= config.trailingDistancePct) {
            this.auditLogger('RISK_REJECTED', `Trailing Stop triggered for ${pos.symbol}: retraced ${retracementFromPeakPct.toFixed(2)}% from peak of ${peakPnlPct.toFixed(2)}%`, {
              symbol: pos.symbol,
              peakPnlPct,
              retracementFromPeakPct,
              currentPrice,
            });

            await orderManager.executeCloseOrder({
              position: pos,
              reason: 'TRAILING_STOP',
              currentPrice,
              exitReasonDetail: `Trailing stop declanșat la vârful de +${peakPnlPct.toFixed(2)}%, retragere la ${pnlPct.toFixed(2)}% (dist= ${retracementFromPeakPct.toFixed(2)}% / setat ${config.trailingDistancePct}%)`,
              triggerStopValue: config.trailingDistancePct,
              trailingPeakPct: parseFloat(peakPnlPct.toFixed(2)),
              trailingDistancePct: parseFloat(retracementFromPeakPct.toFixed(2)),
              exitMarketRegime: options?.marketRegime,
              accountEquity: currentEquity,
              accountBalance: options?.accountBalance,
              openPositionsCount: this.activePositions.length,
            });
            continue;
          }
        }
      } else if (pos.side === 'SELL' && pos.lowestPrice) {
        const peakPnlPct = ((pos.entryPrice - pos.lowestPrice) / pos.entryPrice) * 100;
        if (peakPnlPct >= config.trailingActivationPct) {
          isTrailingActive = true;
          const retracementFromTroughPct = ((currentPrice - pos.lowestPrice) / pos.lowestPrice) * 100;
          if (retracementFromTroughPct >= config.trailingDistancePct) {
            this.auditLogger('RISK_REJECTED', `Trailing Stop triggered for short ${pos.symbol}: retraced ${retracementFromTroughPct.toFixed(2)}%`, {
              symbol: pos.symbol,
              currentPrice,
            });

            await orderManager.executeCloseOrder({
              position: pos,
              reason: 'TRAILING_STOP',
              currentPrice,
              exitReasonDetail: `Trailing stop Short declanșat la minimul de +${peakPnlPct.toFixed(2)}%, retragere la ${pnlPct.toFixed(2)}% (dist= ${retracementFromTroughPct.toFixed(2)}% / setat ${config.trailingDistancePct}%)`,
              triggerStopValue: config.trailingDistancePct,
              trailingPeakPct: parseFloat(peakPnlPct.toFixed(2)),
              trailingDistancePct: parseFloat(retracementFromTroughPct.toFixed(2)),
              exitMarketRegime: options?.marketRegime,
              accountEquity: currentEquity,
              accountBalance: options?.accountBalance,
              openPositionsCount: this.activePositions.length,
            });
            continue;
          }
        }
      }

      // 3. Staged Time-Stop & Max Holding Time Check (Configurable Stagnation Exit + Hard Max Limit)
      const maxHoldingLimit = config.maxHoldingTimeMinutes && config.maxHoldingTimeMinutes > 0 ? config.maxHoldingTimeMinutes : 45;
      const stagnationMinutes = config.stagnationTimeMinutes && config.stagnationTimeMinutes > 0 ? config.stagnationTimeMinutes : 0;
      const stagnationMinPeak = config.stagnationMinPeakPct ?? 0.5;

      const heldMinutes = (Date.now() - pos.entryTime) / 60000;

      // Evaluation of peak progression for this position
      const peakPnlPct = isBuy
        ? (((pos.highestPrice || pos.entryPrice) - pos.entryPrice) / pos.entryPrice) * 100
        : ((pos.entryPrice - (pos.lowestPrice || pos.entryPrice)) / pos.entryPrice) * 100;

      // Stage 1: Stagnation Time-Stop (ONLY if explicitly enabled > 0 and strictly less than maxHoldingLimit)
      if (stagnationMinutes > 0 && stagnationMinutes < maxHoldingLimit && !isTrailingActive && heldMinutes >= stagnationMinutes && peakPnlPct < stagnationMinPeak && pnlPct <= 0.2) {
        this.auditLogger('RISK_REJECTED', `Stagnation Time-Stop at ${heldMinutes.toFixed(1)}m for ${pos.symbol}: Peak +${peakPnlPct.toFixed(2)}% < +${stagnationMinPeak}%. Closing early to preserve winrate.`, {
          symbol: pos.symbol,
          heldMinutes: parseFloat(heldMinutes.toFixed(2)),
          peakPnlPct: parseFloat(peakPnlPct.toFixed(2)),
          currentPnlPct: parseFloat(pnlPct.toFixed(2)),
          currentPrice,
        });

        await orderManager.executeCloseOrder({
          position: pos,
          reason: 'TIME_STOP',
          currentPrice,
          exitReasonDetail: `Time-Stop Eșalonat (Stagnare min ${stagnationMinutes}): Vârf slab (+${peakPnlPct.toFixed(2)}% < +${stagnationMinPeak}%), PnL actual: ${pnlPct.toFixed(2)}% la ${heldMinutes.toFixed(1)}m. Închidere timpurie pentru protecție winrate.`,
          exitMarketRegime: options?.marketRegime,
          accountEquity: currentEquity,
          accountBalance: options?.accountBalance,
          openPositionsCount: this.activePositions.length,
        });
        continue;
      }

      // Stage 2: Hard Max Holding Time Check.
      // Positions with an active trailing stop are allowed to run past maxHoldingTimeMinutes (trailing exits are the
      // profit engine), but no longer indefinitely: they are capped at maxHoldingTimeMinutes * trailingMaxHoldMultiplier
      // (default 2). Previously `!isTrailingActive` removed the limit entirely (observed: 86.7 min with MaxHold=60).
      const trailingHoldMultiplier = config.trailingMaxHoldMultiplier && config.trailingMaxHoldMultiplier >= 1 ? config.trailingMaxHoldMultiplier : 2;
      const effectiveHoldLimit = isTrailingActive ? maxHoldingLimit * trailingHoldMultiplier : maxHoldingLimit;
      if (maxHoldingLimit > 0 && heldMinutes >= effectiveHoldLimit) {
        this.auditLogger('RISK_REJECTED', `Max holding time of ${effectiveHoldLimit}m exceeded for ${pos.symbol}${isTrailingActive ? ' (trailing-extended cap)' : ''}. Closing position.`, {
          symbol: pos.symbol,
          heldMinutes: parseFloat(heldMinutes.toFixed(2)),
          currentPrice,
        });
        await orderManager.executeCloseOrder({
          position: pos,
          reason: 'TIME_STOP',
          currentPrice,
          exitReasonDetail: `Time Stop Hard expirat: poziția a atins ${heldMinutes.toFixed(1)} minute (limită maximă: ${effectiveHoldLimit} min, PnL: ${pnlPct.toFixed(2)}%)`,
          exitMarketRegime: options?.marketRegime,
          accountEquity: currentEquity,
          accountBalance: options?.accountBalance,
          openPositionsCount: this.activePositions.length,
        });
        continue;
      }
    }
  }

  /**
   * Marks a position as closed only after confirmation from OKX / Adapter
   */
  public async markPositionClosed(
    posId: string,
    exitPrice: number,
    exitTime: number,
    reason: string,
    exitFee?: number,
    telemetry?: {
      exitMarketRegime?: string;
      accountEquity?: number;
      openPositionsCount?: number;
      closeOrderId?: string;
    }
  ): Promise<Position | null> {
    const index = this.activePositions.findIndex((p) => p.id === posId);
    if (index === -1) {
      // Idempotent: if the position was already finalised (e.g. by reconciliation) return the recorded result
      // instead of null, so the caller never books a phantom 0.00 PnL for a trade that really closed.
      const already = this.closedHistory.find((p) => p.id === posId);
      return already && already.pnl !== undefined ? already : null;
    }

    this.mutationSeq++;
    const pos = this.activePositions[index];
    this.recentlyClosedAt.set(pos.symbol, Date.now());
    pos.status = 'CLOSED';
    pos.exitPrice = exitPrice;
    pos.exitTime = exitTime;
    if (telemetry) {
      if (telemetry.exitMarketRegime) pos.exitMarketRegime = telemetry.exitMarketRegime;
      if (telemetry.accountEquity !== undefined) pos.accountEquityAtExit = telemetry.accountEquity;
      if (telemetry.openPositionsCount !== undefined) pos.openPositionsAtExit = telemetry.openPositionsCount;
      if (telemetry.closeOrderId) pos.closeOrderId = telemetry.closeOrderId;
    }

    const isBuy = pos.side.toUpperCase() === 'BUY';
    const finalPnlPct = isBuy
      ? ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100
      : ((pos.entryPrice - exitPrice) / pos.entryPrice) * 100;
    pos.pnlPct = parseFloat(finalPnlPct.toFixed(2));

    // Gross PnL strictly from price movement taking ctVal into account
    const ctVal = pos.ctVal || 1;
    const realNotional = pos.qty * pos.entryPrice * ctVal;
    const grossPnl = isBuy
      ? (exitPrice - pos.entryPrice) * pos.qty * ctVal
      : (pos.entryPrice - exitPrice) * pos.qty * ctVal;
    
    pos.grossPnl = parseFloat((isNaN(grossPnl) ? 0 : grossPnl).toFixed(4));

    // Fees: Entry Fee + Exit Fee (0.05% OKX taker standard)
    const entryFee = pos.entryFee || 0;
    const exitNotional = pos.qty * exitPrice * ctVal;
    const resolvedExitFee = exitFee !== undefined ? exitFee : parseFloat((exitNotional * 0.0005).toFixed(4));
    pos.exitFee = parseFloat(resolvedExitFee.toFixed(4));

    // Net PnL = grossPnl - (entryFee + exitFee)
    const netPnl = pos.grossPnl - (entryFee + resolvedExitFee);
    pos.pnl = parseFloat((isNaN(netPnl) ? 0 : netPnl).toFixed(4));
    if (pos.pnl < 0 || reason === 'STOP_LOSS') {
      this.lastLossAt.set(pos.symbol, Date.now());
    }

    this.activePositions.splice(index, 1);
    this.closedHistory.unshift(pos);

    // Keep history at reasonable limit
    if (this.closedHistory.length > 200) {
      this.closedHistory.length = 200;
    }

    return pos;
  }

  /**
   * Correctly handles PARTIALLY_FILLED close order:
   * Deducts executed quantity from position without closing it!
   */
  public async handlePartialClose(
    posId: string,
    filledQty: number,
    exitPrice: number
  ): Promise<Position | null> {
    const pos = this.activePositions.find((p) => p.id === posId);
    if (!pos) return null;

    this.mutationSeq++;
    const remainingQty = Math.max(0, parseFloat((pos.qty - filledQty).toFixed(6)));
    if (remainingQty <= 1e-6) {
      return this.markPositionClosed(posId, exitPrice, Date.now(), 'PARTIAL_CLOSE_COMPLETED');
    }

    const ctVal = pos.ctVal || 1;
    pos.qty = remainingQty;
    pos.sizeUSDT = parseFloat((remainingQty * pos.entryPrice * ctVal).toFixed(2));

    this.auditLogger(
      'POSITION_UPDATED',
      `Position ${pos.symbol} partially closed: reduced by ${filledQty} contracts @ $${formatPrice(exitPrice)}. Remaining: ${remainingQty}`,
      {
        posId,
        symbol: pos.symbol,
        closedQty: filledQty,
        remainingQty,
        exitPrice,
      }
    );

    return pos;
  }

  /**
   * Reconciles internal positions against real OKX exchange positions.
   * OKX is the ultimate source of truth!
   */
  public reconcileWithExchange(
    exchangePositions: OKXRawPosition[],
    currentProfile: ProfileType,
    options?: {
      /** Return true when an order is in flight for the symbol; such symbols are never touched. */
      isSymbolBusy?: (symbol: string) => boolean;
    }
  ): {
    discrepanciesFound: number;
    syncedPositions: Position[];
  } {
    let discrepancies = 0;
    const now = Date.now();
    const grace = PositionManager.RECONCILE_GRACE_MS;
    const isBusy = (symbol: string) => Boolean(options?.isSymbolBusy?.(symbol));
    const exchangeMap = new Map<string, OKXRawPosition>();

    for (const ep of exchangePositions) {
      exchangeMap.set(ep.symbol, ep);
    }

    // 1. Check existing local positions against the exchange snapshot
    for (const localPos of [...this.activePositions]) {
      const okxPos = exchangeMap.get(localPos.symbol);

      // Never touch a position that is mid-close or has an order in flight: the exchange snapshot and local
      // state are legitimately out of sync for the duration of the order lifecycle.
      if (localPos.status !== 'OPEN' || isBusy(localPos.symbol)) {
        exchangeMap.delete(localPos.symbol);
        continue;
      }

      if (!okxPos || okxPos.size <= 0) {
        // A freshly opened position may not be visible in a snapshot taken moments earlier.
        if (now - (localPos.entryTime || 0) < 15_000) {
          continue;
        }

        // Discrepancy: local position no longer exists on the exchange (liquidation, manual close, exchange-side TP/SL).
        discrepancies++;
        this.auditLogger(
          'RECONCILIATION_DISCREPANCY',
          `Local position ${localPos.symbol} does not exist on exchange. Marking as CLOSED locally.`,
          { symbol: localPos.symbol, positionId: localPos.id }
        );

        // Book the close properly (PnL + experiment ledger) instead of silently dropping it.
        const exitPrice = localPos.currentPrice && localPos.currentPrice > 0 ? localPos.currentPrice : localPos.entryPrice;
        const ctValLocal = localPos.ctVal || 1;
        const isBuyLocal = localPos.side.toUpperCase() === 'BUY';
        const gross = isBuyLocal
          ? (exitPrice - localPos.entryPrice) * localPos.qty * ctValLocal
          : (localPos.entryPrice - exitPrice) * localPos.qty * ctValLocal;
        const exitFee = parseFloat((localPos.qty * exitPrice * ctValLocal * 0.0005).toFixed(4));
        localPos.status = 'CLOSED';
        localPos.exitPrice = exitPrice;
        localPos.exitTime = now;
        localPos.grossPnl = parseFloat(gross.toFixed(4));
        localPos.exitFee = exitFee;
        localPos.pnl = parseFloat((gross - (localPos.entryFee || 0) - exitFee).toFixed(4));
        localPos.pnlPct = parseFloat(((isBuyLocal ? exitPrice - localPos.entryPrice : localPos.entryPrice - exitPrice) / localPos.entryPrice * 100).toFixed(2));
        this.mutationSeq++;
        this.recentlyClosedAt.set(localPos.symbol, now);
        this.activePositions = this.activePositions.filter((p) => p.id !== localPos.id);
        this.closedHistory.unshift(localPos);
        experimentManager.logTradeExit(
          localPos.symbol,
          localPos.side,
          localPos.signalScore ?? 0,
          localPos.entryPrice,
          exitPrice,
          localPos.sizeUSDT,
          localPos.pnl,
          localPos.pnlPct,
          localPos.entryTime ? (now - localPos.entryTime) / 60000 : 0,
          'RECONCILE_CLOSED'
        );
        continue;
      }

      // Check quantity mismatch
      const ctVal = localPos.ctVal || this.ctValResolver(localPos.symbol) || 1;
      localPos.ctVal = ctVal;

      if (Math.abs(localPos.qty - okxPos.size) > 1e-6) {
        discrepancies++;
        this.auditLogger(
          'RECONCILIATION_DISCREPANCY',
          `Quantity mismatch for ${localPos.symbol}: local=${localPos.qty}, exchange=${okxPos.size}. Updating to exchange size.`,
          { symbol: localPos.symbol, oldQty: localPos.qty, newQty: okxPos.size }
        );
        localPos.qty = okxPos.size;
        localPos.sizeUSDT = parseFloat((okxPos.size * localPos.entryPrice * ctVal).toFixed(2));
      }

      // Check side mismatch
      const okxSide = okxPos.side.toUpperCase() as 'BUY' | 'SELL';
      if (localPos.side !== okxSide) {
        discrepancies++;
        this.auditLogger(
          'RECONCILIATION_DISCREPANCY',
          `Side mismatch for ${localPos.symbol}: local=${localPos.side}, exchange=${okxSide}. Updating to exchange side.`,
          { symbol: localPos.symbol, oldSide: localPos.side, newSide: okxSide }
        );
        localPos.side = okxSide;
      }

      // Check entry price mismatch (relative check > 0.05%)
      const relPriceDiff = okxPos.avgPrice > 0 ? Math.abs(localPos.entryPrice - okxPos.avgPrice) / okxPos.avgPrice : 0;
      if (okxPos.avgPrice > 0 && relPriceDiff > 0.0005) {
        discrepancies++;
        this.auditLogger(
          'RECONCILIATION_DISCREPANCY',
          `Entry price mismatch for ${localPos.symbol}: local=$${formatPrice(localPos.entryPrice)}, exchange=$${formatPrice(okxPos.avgPrice)}. Updating to exchange price.`,
          { symbol: localPos.symbol, oldPrice: localPos.entryPrice, newPrice: okxPos.avgPrice }
        );
        localPos.entryPrice = okxPos.avgPrice;
        localPos.sizeUSDT = parseFloat((localPos.qty * okxPos.avgPrice * ctVal).toFixed(2));
      }

      // Matched
      exchangeMap.delete(localPos.symbol);
    }

    // 2. Positions that exist on the exchange but are missing locally.
    for (const [symbol, unmappedOkxPos] of exchangeMap.entries()) {
      if (unmappedOkxPos.size <= 0) continue;

      // Do not "discover" a position we closed (or just opened) within the grace window, or one with an order in
      // flight: the snapshot was taken before our own state change landed. This was the source of phantom
      // positions re-imported ~2-3s after a close (score 50 / second EXPERIMENT_END exit on the same entry price).
      const closedAgo = now - (this.recentlyClosedAt.get(symbol) || 0);
      const openedAgo = now - (this.recentlyOpenedAt.get(symbol) || 0);
      if (closedAgo < grace || openedAgo < grace || isBusy(symbol)) {
        continue;
      }

      discrepancies++;
      const side = unmappedOkxPos.side.toUpperCase() as 'BUY' | 'SELL';
      const entryPrice = unmappedOkxPos.avgPrice || unmappedOkxPos.markPrice;
      const ctVal = this.ctValResolver(symbol) || 1;
      const sizeUSDT = parseFloat((unmappedOkxPos.size * entryPrice * ctVal).toFixed(2));

      const importedPos: Position = {
        id: `okx_sync_${Date.now()}_${symbol}`,
        symbol,
        side,
        qty: unmappedOkxPos.size,
        entryPrice,
        ctVal,
        sizeUSDT,
        status: 'OPEN',
        entryTime: unmappedOkxPos.updatedTime || Date.now(),
        highestPrice: entryPrice,
        lowestPrice: entryPrice,
        profile: currentProfile,
        source: 'OKX_SYNC',
        executionMode: 'TESTNET',
      };

      this.mutationSeq++;
      this.activePositions.push(importedPos);

      this.auditLogger(
        'RECONCILIATION_DISCREPANCY',
        `Discovered unmapped position on exchange: ${symbol} (${side} ${unmappedOkxPos.size} @ $${entryPrice}). Imported into TradeBot state.`,
        { symbol, importedPos }
      );
    }

    return {
      discrepanciesFound: discrepancies,
      syncedPositions: this.activePositions,
    };
  }
}
