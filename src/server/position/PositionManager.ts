import {
  Position,
  ProfileConfig,
  OKXRawPosition,
  OrderRecord,
  ProfileType,
  AuditLogType,
} from '../../shared/types';
import { OrderManager } from '../order/OrderManager';

export class PositionManager {
  private activePositions: Position[] = [];
  private closedHistory: Position[] = [];
  private highestEquity: number = 200.0; // Initialize with base equity
  private initialEquity: number = 200.0;
  private equityProtCount: number = 0;
  private auditLogger: (type: AuditLogType, message: string, details?: any) => void;
  private ctValResolver: (symbol: string) => number = () => 1;

  constructor(auditLogger: (type: AuditLogType, message: string, details?: any) => void) {
    this.auditLogger = auditLogger;
  }

  public setCtValResolver(resolver: (symbol: string) => number): void {
    this.ctValResolver = resolver;
  }

  public getActivePositions(): Position[] {
    return this.activePositions;
  }

  public getHighestEquity(): number {
    return this.highestEquity;
  }

  public getEquityTrailingState(config: ProfileConfig, currentEquity: number) {
    const isEnabled = (config.equityProtectionActivationPct || 0) > 0 && (config.equityTrailingDrawdownPct || 0) > 0;
    const activationPrice = isEnabled ? this.initialEquity * (1 + (config.equityProtectionActivationPct || 0) / 100) : this.initialEquity;
    const isActive = isEnabled && this.highestEquity >= activationPrice;
    
    let sellThreshold: number | null = null;
    if (isActive && config.equityTrailingDrawdownPct && config.equityTrailingDrawdownPct > 0) {
      sellThreshold = this.highestEquity * (1 - config.equityTrailingDrawdownPct / 100);
    }
    
    const currentDrawdownPct = isActive ? ((this.highestEquity - currentEquity) / this.highestEquity) * 100 : 0;
    
    return {
      isEnabled,
      isActive,
      activationPrice,
      activationPct: config.equityProtectionActivationPct || 0,
      peakEquity: this.highestEquity,
      drawdownLimitPct: config.equityTrailingDrawdownPct || 0,
      currentDrawdownPct: Math.max(0, currentDrawdownPct),
      sellThreshold,
      triggerCount: this.equityProtCount
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
    this.activePositions = positions
      .filter((p) => p.status === 'OPEN')
      .map((p) => {
        const ctVal = p.ctVal || 1;
        const validQty = p.qty && !isNaN(p.qty) && p.qty > 0
          ? p.qty
          : parseFloat((p.sizeUSDT / ((p.entryPrice || 1) * ctVal)).toFixed(4));
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

    const ctVal = order.ctVal || 1;
    const realSizeUSDT = filledQty * entryPrice * ctVal;
    const feeToAdd = feeIncrement !== undefined
      ? feeIncrement
      : (order.cumFee !== undefined ? order.cumFee : parseFloat((realSizeUSDT * 0.0005).toFixed(4)));

    // Check if position already exists for this symbol (add incremental quantity)
    const existing = this.activePositions.find((p) => p.symbol === order.symbol && p.status === 'OPEN');

    if (existing) {
      // Weighted average entry price with incremental fill
      const totalQty = existing.qty + filledQty;
      const avgEntryPrice = (existing.qty * existing.entryPrice + filledQty * entryPrice) / totalQty;
      existing.qty = parseFloat(totalQty.toFixed(6));
      existing.entryPrice = parseFloat(avgEntryPrice.toFixed(4));
      existing.ctVal = existing.ctVal || ctVal;
      existing.sizeUSDT = parseFloat((existing.qty * existing.entryPrice * (existing.ctVal || 1)).toFixed(2));
      existing.entryFee = parseFloat(((existing.entryFee || 0) + feeToAdd).toFixed(4));
      existing.highestPrice = Math.max(existing.highestPrice || avgEntryPrice, entryPrice);
      existing.lowestPrice = Math.min(existing.lowestPrice || avgEntryPrice, entryPrice);

      this.auditLogger('POSITION_UPDATED', `Position ${order.symbol} increased by +${filledQty} contracts to ${existing.qty} @ avg $${existing.entryPrice.toFixed(4)} (Entry Fee: $${existing.entryFee})`, {
        symbol: order.symbol,
        incrementalQty: filledQty,
        totalQty: existing.qty,
        entryPrice: existing.entryPrice,
        entryFee: existing.entryFee,
      });

      return existing;
    }

    const newPosition: Position = {
      id: `pos_${Date.now()}_${order.symbol}`,
      symbol: order.symbol,
      side: order.side.toUpperCase() === 'SELL' ? 'SELL' : 'BUY',
      qty: parseFloat(filledQty.toFixed(6)),
      entryPrice: parseFloat(entryPrice.toFixed(4)),
      ctVal,
      sizeUSDT: parseFloat(realSizeUSDT.toFixed(2)),
      entryFee: parseFloat(feeToAdd.toFixed(4)),
      exitFee: 0,
      status: 'OPEN',
      entryTime: Date.now(),
      highestPrice: entryPrice,
      lowestPrice: entryPrice,
      profile: order.profile,
      source: order.executionMode === 'PAPER' ? 'PAPER' : 'LOCAL',
      executionMode: order.executionMode || 'TESTNET',
      marketRegime: order.marketRegime,
    };

    this.activePositions.push(newPosition);

    this.auditLogger('POSITION_OPENED', `Opened ${order.side} position on ${order.symbol}: ${filledQty} contracts @ $${entryPrice.toFixed(4)} ($${realSizeUSDT.toFixed(2)}) [Fee: $${newPosition.entryFee}]`, {
      positionId: newPosition.id,
      symbol: newPosition.symbol,
      side: newPosition.side,
      qty: newPosition.qty,
      entryPrice: newPosition.entryPrice,
      sizeUSDT: newPosition.sizeUSDT,
      profile: newPosition.profile,
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
    currentEquity: number
  ) {
    // Equity Protection Check (Disabled if either activationPct or trailingDrawdownPct is <= 0)
    this.updateHighestEquity(currentEquity);
    
    const isEquityProtectionEnabled = 
      (config.equityProtectionActivationPct ?? 0) > 0 && 
      (config.equityTrailingDrawdownPct ?? 0) > 0;

    if (isEquityProtectionEnabled) {
      const peakEquity = this.getHighestEquity();
      const activationEquity = this.initialEquity * (1 + config.equityProtectionActivationPct / 100);
      
      // If we ever hit activationEquity, the peakEquity will naturally be >= activationEquity
      if (peakEquity >= activationEquity) {
        const drawdownFromPeak = (peakEquity - currentEquity) / peakEquity * 100;
        if (drawdownFromPeak >= config.equityTrailingDrawdownPct && this.activePositions.length > 0) {
          this.auditLogger('KILL_SWITCH_ENGAGED', `Equity Protection triggered! Drawdown of ${drawdownFromPeak.toFixed(2)}% exceeded limit of ${config.equityTrailingDrawdownPct}%. Closing all positions.`, {
            peakEquity,
            currentEquity,
            drawdownFromPeak
          });
          
          this.equityProtCount++;
          
          for (const pos of [...this.activePositions]) {
            await orderManager.executeCloseOrder({
              position: pos,
              reason: 'EQUITY_PROTECTION',
              currentPrice: currentPrices[pos.symbol] || pos.entryPrice,
              exitReasonDetail: `Equity Protection declanșat: Drawdown de -${drawdownFromPeak.toFixed(2)}% de la vârful capitalului ($${peakEquity.toFixed(2)}) (limită permisă: -${config.equityTrailingDrawdownPct}%)`,
              triggerStopValue: config.equityTrailingDrawdownPct,
            });
          }
          
          // Reset highest equity baseline so it doesn't immediately re-trigger on next tick
          this.initialEquity = currentEquity;
          this.highestEquity = currentEquity;
        }
      }
    }

    for (const pos of [...this.activePositions]) {
      if (pos.status !== 'OPEN') continue;

      const currentPrice = currentPrices[pos.symbol];
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
      pos.pnl = parseFloat(((pos.sizeUSDT * pnlPct) / 100).toFixed(2));

      // Initialize stopLossPrice if undefined
      if (pos.stopLossPrice === undefined) {
        pos.stopLossPrice = pos.entryPrice * (1 - (pos.side === 'BUY' ? config.hardStopLossPct / 100 : -config.hardStopLossPct / 100));
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
              });
              continue;
          }
      }

      // Break-Even Logic
      if (pos.side === 'BUY' && pnlPct >= config.breakEvenActivationPct && pos.stopLossPrice < pos.entryPrice) {
          pos.stopLossPrice = pos.entryPrice * 1.0005; // Move SL to entry + 0.05% buffer
          pos.isBreakEvenTriggered = true;
          this.auditLogger('POSITION_UPDATED', `Break-Even triggered for ${pos.symbol}: SL moved to entry.`);
      } else if (pos.side === 'SELL' && pnlPct >= config.breakEvenActivationPct && (pos.stopLossPrice === undefined || pos.stopLossPrice > pos.entryPrice)) {
          pos.stopLossPrice = pos.entryPrice * 0.9995;
          pos.isBreakEvenTriggered = true;
          this.auditLogger('POSITION_UPDATED', `Break-Even triggered for ${pos.symbol}: SL moved to entry.`);
      }

      // 1. Hard Stop Loss Check (or Break-Even Stop Check if SL was moved)
      if ((pos.side === 'BUY' && currentPrice <= pos.stopLossPrice) || (pos.side === 'SELL' && currentPrice >= pos.stopLossPrice)) {
        this.auditLogger('RISK_REJECTED', `Stop-Loss triggered for ${pos.symbol} at ${currentPrice}`, {
          symbol: pos.symbol,
          currentPrice,
        });

        const exitReasonText = pos.isBreakEvenTriggered
          ? `Break-Even Stop atins la prețul $${currentPrice.toFixed(4)} (SL mutat la pragul de intrare după atingerea țintei BE, PnL înregistrat: ${pnlPct.toFixed(2)}%)`
          : `Stop-Loss hard atins la prețul $${currentPrice.toFixed(4)} (Limită pierdere setată: -${config.hardStopLossPct}%, PnL înregistrat: ${pnlPct.toFixed(2)}%)`;

        await orderManager.executeCloseOrder({
          position: pos,
          reason: 'STOP_LOSS',
          currentPrice,
          exitReasonDetail: exitReasonText,
        });
        continue;
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
            });
            continue;
          }
        }
      }

      // 3. Max Holding Time Check
      if (!isTrailingActive && config.maxHoldingTimeMinutes && config.maxHoldingTimeMinutes > 0) {
        const heldMinutes = (Date.now() - pos.entryTime) / 60000;
        if (heldMinutes >= config.maxHoldingTimeMinutes) {
          this.auditLogger('RISK_REJECTED', `Max holding time of ${config.maxHoldingTimeMinutes}m exceeded for ${pos.symbol}. Closing position.`, {
            symbol: pos.symbol,
            heldMinutes: parseFloat(heldMinutes.toFixed(2)),
            currentPrice,
          });
          await orderManager.executeCloseOrder({
            position: pos,
            reason: 'TIME_STOP',
            currentPrice,
            exitReasonDetail: `Time Stop expirat: poziția a fost menținută ${heldMinutes.toFixed(1)} minute (limită maximă configurată: ${config.maxHoldingTimeMinutes} min, PnL final: ${pnlPct.toFixed(2)}%)`,
          });
          continue;
        }
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
    exitFee?: number
  ): Promise<Position | null> {
    const index = this.activePositions.findIndex((p) => p.id === posId);
    if (index === -1) return null;

    const pos = this.activePositions[index];
    pos.status = 'CLOSED';
    pos.exitPrice = exitPrice;
    pos.exitTime = exitTime;

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
    pos.pnl = parseFloat((isNaN(netPnl) ? 0 : netPnl).toFixed(2));

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

    const remainingQty = Math.max(0, parseFloat((pos.qty - filledQty).toFixed(6)));
    if (remainingQty <= 1e-6) {
      return this.markPositionClosed(posId, exitPrice, Date.now(), 'PARTIAL_CLOSE_COMPLETED');
    }

    const ctVal = pos.ctVal || 1;
    pos.qty = remainingQty;
    pos.sizeUSDT = parseFloat((remainingQty * pos.entryPrice * ctVal).toFixed(2));

    this.auditLogger(
      'POSITION_UPDATED',
      `Position ${pos.symbol} partially closed: reduced by ${filledQty} contracts @ $${exitPrice.toFixed(4)}. Remaining: ${remainingQty}`,
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
    currentProfile: ProfileType
  ): {
    discrepanciesFound: number;
    syncedPositions: Position[];
  } {
    let discrepancies = 0;
    const exchangeMap = new Map<string, OKXRawPosition>();

    for (const ep of exchangePositions) {
      exchangeMap.set(ep.symbol, ep);
    }

    // 1. Check existing local positions against OKX
    for (const localPos of [...this.activePositions]) {
      const okxPos = exchangeMap.get(localPos.symbol);

      if (!okxPos || okxPos.size <= 0) {
        // Discrepancy: Local position was closed on OKX (liquidation, manual close, or TP/SL hit)
        discrepancies++;
        this.auditLogger(
          'RECONCILIATION_DISCREPANCY',
          `Local position ${localPos.symbol} does not exist on OKX. Marking as CLOSED locally.`,
          { symbol: localPos.symbol, localPos }
        );

        localPos.status = 'CLOSED';
        localPos.exitTime = Date.now();
        this.activePositions = this.activePositions.filter((p) => p.id !== localPos.id);
        this.closedHistory.unshift(localPos);
        continue;
      }

      // Check quantity mismatch
      const ctVal = localPos.ctVal || this.ctValResolver(localPos.symbol) || 1;
      localPos.ctVal = ctVal;

      if (Math.abs(localPos.qty - okxPos.size) > 1e-6) {
        discrepancies++;
        this.auditLogger(
          'RECONCILIATION_DISCREPANCY',
          `Quantity mismatch for ${localPos.symbol}: local=${localPos.qty}, OKX=${okxPos.size}. Updating to OKX size.`,
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
          `Side mismatch for ${localPos.symbol}: local=${localPos.side}, OKX=${okxSide}. Updating to OKX side.`,
          { symbol: localPos.symbol, oldSide: localPos.side, newSide: okxSide }
        );
        localPos.side = okxSide;
      }

      // Check entry price mismatch
      if (okxPos.avgPrice > 0 && Math.abs(localPos.entryPrice - okxPos.avgPrice) > 0.01) {
        discrepancies++;
        this.auditLogger(
          'RECONCILIATION_DISCREPANCY',
          `Entry price mismatch for ${localPos.symbol}: local=$${localPos.entryPrice}, OKX=$${okxPos.avgPrice}. Updating to OKX price.`,
          { symbol: localPos.symbol, oldPrice: localPos.entryPrice, newPrice: okxPos.avgPrice }
        );
        localPos.entryPrice = okxPos.avgPrice;
        localPos.sizeUSDT = parseFloat((localPos.qty * okxPos.avgPrice * ctVal).toFixed(2));
      }

      // Remove from map so we know it's matched
      exchangeMap.delete(localPos.symbol);
    }

    // 2. Any remaining positions on OKX exist on exchange but were missing locally
    for (const [symbol, unmappedOkxPos] of exchangeMap.entries()) {
      if (unmappedOkxPos.size <= 0) continue;

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

      this.activePositions.push(importedPos);

      this.auditLogger(
        'RECONCILIATION_DISCREPANCY',
        `Discovered unmapped position on OKX: ${symbol} (${side} ${unmappedOkxPos.size} @ $${entryPrice}). Imported into TradeBot state.`,
        { symbol, importedPos }
      );
    }

    return {
      discrepanciesFound: discrepancies,
      syncedPositions: this.activePositions,
    };
  }
}
