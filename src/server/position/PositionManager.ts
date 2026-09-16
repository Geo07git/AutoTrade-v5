import {
  Position,
  ProfileConfig,
  BybitRawPosition,
  OrderRecord,
  ProfileType,
  AuditLogType,
} from '../../shared/types';
import { OrderManager } from '../order/OrderManager';

export class PositionManager {
  private activePositions: Position[] = [];
  private closedHistory: Position[] = [];
  private highestEquity: number = 200.0; // Initialize with base equity
  private auditLogger: (type: AuditLogType, message: string, details?: any) => void;

  constructor(auditLogger: (type: AuditLogType, message: string, details?: any) => void) {
    this.auditLogger = auditLogger;
  }

  public getActivePositions(): Position[] {
    return this.activePositions;
  }

  public getHighestEquity(): number {
    return this.highestEquity;
  }

  public updateHighestEquity(currentEquity: number): void {
    if (currentEquity > this.highestEquity) {
      this.highestEquity = currentEquity;
    }
  }

  public resetHighestEquity(equity: number = 200.0): void {
    this.highestEquity = equity;
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
      .map((p) => ({
        ...p,
        qty: p.qty && !isNaN(p.qty) && p.qty > 0 ? p.qty : parseFloat((p.sizeUSDT / (p.entryPrice || 1)).toFixed(4)),
      }));
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
    fillPriceOverride?: number
  ): Promise<Position | null> {
    const entryPrice = fillPriceOverride && fillPriceOverride > 0
      ? fillPriceOverride
      : (order.fillPrice && order.fillPrice > 0 ? order.fillPrice : (order.sizeUSDT / order.qty));

    const filledQty = incrementalQty !== undefined
      ? incrementalQty
      : (order.filledQty && order.filledQty > 0 ? order.filledQty : order.qty);

    if (filledQty <= 0) {
      return null;
    }

    const realSizeUSDT = filledQty * entryPrice;

    // Check if position already exists for this symbol (add incremental quantity)
    const existing = this.activePositions.find((p) => p.symbol === order.symbol && p.status === 'OPEN');

    if (existing) {
      // Weighted average entry price with incremental fill
      const totalQty = existing.qty + filledQty;
      const avgEntryPrice = (existing.qty * existing.entryPrice + filledQty * entryPrice) / totalQty;
      existing.qty = parseFloat(totalQty.toFixed(6));
      existing.entryPrice = parseFloat(avgEntryPrice.toFixed(4));
      existing.sizeUSDT = parseFloat((existing.qty * existing.entryPrice).toFixed(2));
      existing.highestPrice = Math.max(existing.highestPrice || avgEntryPrice, entryPrice);
      existing.lowestPrice = Math.min(existing.lowestPrice || avgEntryPrice, entryPrice);

      this.auditLogger('POSITION_UPDATED', `Position ${order.symbol} increased by +${filledQty} contracts to ${existing.qty} @ avg $${existing.entryPrice.toFixed(4)}`, {
        symbol: order.symbol,
        incrementalQty: filledQty,
        totalQty: existing.qty,
        entryPrice: existing.entryPrice,
      });

      return existing;
    }

    const newPosition: Position = {
      id: `pos_${Date.now()}_${order.symbol}`,
      symbol: order.symbol,
      side: order.side,
      qty: parseFloat(filledQty.toFixed(6)),
      entryPrice: parseFloat(entryPrice.toFixed(4)),
      sizeUSDT: parseFloat(realSizeUSDT.toFixed(2)),
      status: 'OPEN',
      entryTime: Date.now(),
      highestPrice: entryPrice,
      lowestPrice: entryPrice,
      profile: order.profile,
      source: order.executionMode === 'PAPER' ? 'PAPER' : 'LOCAL',
      executionMode: order.executionMode || 'TESTNET',
    };

    this.activePositions.push(newPosition);

    this.auditLogger('POSITION_OPENED', `Opened ${order.side} position on ${order.symbol}: ${filledQty} contracts @ $${entryPrice.toFixed(4)} ($${realSizeUSDT.toFixed(2)})`, {
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
    // Equity Protection Check
    this.updateHighestEquity(currentEquity);
    
    if (config.equityProtectionActivationPct !== undefined && config.equityTrailingDrawdownPct !== undefined) {
      const peakEquity = this.getHighestEquity();
      const activationEquity = peakEquity * (1 + config.equityProtectionActivationPct / 100);
      
      if (currentEquity >= activationEquity) {
        const drawdownFromPeak = (peakEquity - currentEquity) / peakEquity * 100;
        if (drawdownFromPeak >= config.equityTrailingDrawdownPct) {
          this.auditLogger('KILL_SWITCH_ENGAGED', `Equity Protection triggered! Drawdown of ${drawdownFromPeak.toFixed(2)}% exceeded limit of ${config.equityTrailingDrawdownPct}%. Closing all positions.`, {
            peakEquity,
            currentEquity,
            drawdownFromPeak
          });
          
          for (const pos of [...this.activePositions]) {
            await orderManager.executeCloseOrder({
              position: pos,
              reason: 'EQUITY_PROTECTION',
              currentPrice: currentPrices[pos.symbol] || pos.entryPrice,
              exitReasonDetail: `Equity Protection Drawdown: -${drawdownFromPeak.toFixed(2)}% de la vârful capitalului ($${peakEquity.toFixed(2)})`,
              triggerStopValue: config.equityTrailingDrawdownPct,
            });
          }
        }
      }
    }

    for (const pos of [...this.activePositions]) {
      if (pos.status !== 'OPEN') continue;

      const currentPrice = currentPrices[pos.symbol];
      if (!currentPrice || currentPrice <= 0) continue;

      // Update High/Low excursions
      pos.highestPrice = Math.max(pos.highestPrice || pos.entryPrice, currentPrice);
      pos.lowestPrice = Math.min(pos.lowestPrice || pos.entryPrice, currentPrice);

      // PNL calculation
      const multiplier = pos.side === 'BUY' ? 1 : -1;
      const pnlPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100 * multiplier;
      pos.pnlPct = parseFloat(pnlPct.toFixed(2));
      pos.pnl = parseFloat(((pos.sizeUSDT * pnlPct) / 100).toFixed(2));

      // 1. Hard Stop Loss Check
      if (pnlPct <= -config.hardStopLossPct) {
        this.auditLogger('RISK_REJECTED', `Hard Stop-Loss triggered for ${pos.symbol} at ${pnlPct.toFixed(2)}% (limit: -${config.hardStopLossPct}%)`, {
          symbol: pos.symbol,
          pnlPct,
          currentPrice,
        });

        await orderManager.executeCloseOrder({
          position: pos,
          reason: 'STOP_LOSS',
          currentPrice,
          exitReasonDetail: `Hard Stop-Loss triggered: Pierdere de ${pnlPct.toFixed(2)}% sub limita de -${config.hardStopLossPct}%`,
          triggerStopValue: -config.hardStopLossPct,
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
              exitReasonDetail: `Trailing Stop declanșat: retragere ${retracementFromPeakPct.toFixed(2)}% din vârful de +${peakPnlPct.toFixed(2)}% (distanță: ${config.trailingDistancePct}%)`,
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
              exitReasonDetail: `Trailing Stop Short declanșat: retragere ${retracementFromTroughPct.toFixed(2)}% din minim (distanță: ${config.trailingDistancePct}%)`,
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
            exitReasonDetail: `Time Stop: Durata maximă de menținere (${config.maxHoldingTimeMinutes} min) a fost atinsă (${heldMinutes.toFixed(1)}m)`,
          });
          continue;
        }
      }
    }
  }

  /**
   * Marks a position as closed only after confirmation from Bybit
   */
  public async markPositionClosed(
    posId: string,
    exitPrice: number,
    exitTime: number,
    reason: string
  ): Promise<Position | null> {
    const index = this.activePositions.findIndex((p) => p.id === posId);
    if (index === -1) return null;

    const pos = this.activePositions[index];
    pos.status = 'CLOSED';
    pos.exitPrice = exitPrice;
    pos.exitTime = exitTime;

    const multiplier = pos.side === 'BUY' ? 1 : -1;
    const finalPnlPct = ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100 * multiplier;
    pos.pnlPct = parseFloat(finalPnlPct.toFixed(2));
    pos.pnl = parseFloat(((pos.sizeUSDT * finalPnlPct) / 100).toFixed(2));

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

    pos.qty = remainingQty;
    pos.sizeUSDT = parseFloat((remainingQty * pos.entryPrice).toFixed(2));

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
   * Reconciles internal positions against real Bybit positions.
   * Bybit is the ultimate source of truth!
   */
  public reconcileWithBybit(
    bybitPositions: BybitRawPosition[],
    currentProfile: ProfileType
  ): {
    discrepanciesFound: number;
    syncedPositions: Position[];
  } {
    let discrepancies = 0;
    const bybitMap = new Map<string, BybitRawPosition>();

    for (const bp of bybitPositions) {
      bybitMap.set(bp.symbol, bp);
    }

    // 1. Check existing local positions against Bybit
    for (const localPos of [...this.activePositions]) {
      const bybitPos = bybitMap.get(localPos.symbol);

      if (!bybitPos || bybitPos.size <= 0) {
        // Discrepancy: Local position was closed on Bybit (liquidation, manual close, or TP/SL hit)
        discrepancies++;
        this.auditLogger(
          'RECONCILIATION_DISCREPANCY',
          `Local position ${localPos.symbol} does not exist on Bybit. Marking as CLOSED locally.`,
          { symbol: localPos.symbol, localPos }
        );

        localPos.status = 'CLOSED';
        localPos.exitTime = Date.now();
        this.activePositions = this.activePositions.filter((p) => p.id !== localPos.id);
        this.closedHistory.unshift(localPos);
        continue;
      }

      // Check quantity mismatch
      if (Math.abs(localPos.qty - bybitPos.size) > 1e-6) {
        discrepancies++;
        this.auditLogger(
          'RECONCILIATION_DISCREPANCY',
          `Quantity mismatch for ${localPos.symbol}: local=${localPos.qty}, Bybit=${bybitPos.size}. Updating to Bybit size.`,
          { symbol: localPos.symbol, oldQty: localPos.qty, newQty: bybitPos.size }
        );
        localPos.qty = bybitPos.size;
        localPos.sizeUSDT = bybitPos.size * localPos.entryPrice;
      }

      // Check side mismatch
      const bybitSide = bybitPos.side.toUpperCase() as 'BUY' | 'SELL';
      if (localPos.side !== bybitSide) {
        discrepancies++;
        this.auditLogger(
          'RECONCILIATION_DISCREPANCY',
          `Side mismatch for ${localPos.symbol}: local=${localPos.side}, Bybit=${bybitSide}. Updating to Bybit side.`,
          { symbol: localPos.symbol, oldSide: localPos.side, newSide: bybitSide }
        );
        localPos.side = bybitSide;
      }

      // Check entry price mismatch
      if (bybitPos.avgPrice > 0 && Math.abs(localPos.entryPrice - bybitPos.avgPrice) > 0.01) {
        discrepancies++;
        this.auditLogger(
          'RECONCILIATION_DISCREPANCY',
          `Entry price mismatch for ${localPos.symbol}: local=$${localPos.entryPrice}, Bybit=$${bybitPos.avgPrice}. Updating to Bybit price.`,
          { symbol: localPos.symbol, oldPrice: localPos.entryPrice, newPrice: bybitPos.avgPrice }
        );
        localPos.entryPrice = bybitPos.avgPrice;
        localPos.sizeUSDT = localPos.qty * bybitPos.avgPrice;
      }

      // Remove from map so we know it's matched
      bybitMap.delete(localPos.symbol);
    }

    // 2. Any remaining positions in Bybit exist on exchange but were missing locally
    for (const [symbol, unmappedBybitPos] of bybitMap.entries()) {
      if (unmappedBybitPos.size <= 0) continue;

      discrepancies++;
      const side = unmappedBybitPos.side.toUpperCase() as 'BUY' | 'SELL';
      const entryPrice = unmappedBybitPos.avgPrice || unmappedBybitPos.markPrice;
      const sizeUSDT = unmappedBybitPos.size * entryPrice;

      const importedPos: Position = {
        id: `bybit_sync_${Date.now()}_${symbol}`,
        symbol,
        side,
        qty: unmappedBybitPos.size,
        entryPrice,
        sizeUSDT,
        status: 'OPEN',
        entryTime: unmappedBybitPos.updatedTime || Date.now(),
        highestPrice: entryPrice,
        lowestPrice: entryPrice,
        profile: currentProfile,
        source: 'BYBIT_SYNC',
        executionMode: 'TESTNET',
      };

      this.activePositions.push(importedPos);

      this.auditLogger(
        'RECONCILIATION_DISCREPANCY',
        `Discovered unmapped position on Bybit: ${symbol} (${side} ${unmappedBybitPos.size} @ $${entryPrice}). Imported into TradeBot state.`,
        { symbol, importedPos }
      );
    }

    return {
      discrepanciesFound: discrepancies,
      syncedPositions: this.activePositions,
    };
  }
}
