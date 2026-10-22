import { OrderRecord, Position } from '../../shared/types';
import { calculateExecutionFee } from '../../shared/fees';

/**
 * Automatically synthesizes completed exit orders for historical ENTRY orders
 * whose positions were already closed or removed in previous sessions, so that
 * the Order Blotter (BLOT) reliably shows both ENTRY and matching EXIT rows.
 */
export function reconcileOrphanEntryOrders(orders: OrderRecord[], activePositions: Position[] = []): OrderRecord[] {
  if (!orders || orders.length === 0) return orders || [];

  const activePositionIds = new Set(activePositions.map((p) => p.id));
  const activeEntryOrderIds = new Set(activePositions.map((p) => p.entryOrderId).filter(Boolean));

  // Collect existing close orders by positionId and by symbol
  const closeOrdersByPosId = new Set<string>();
  const closeOrdersBySymbol = new Map<string, number>();

  for (const o of orders) {
    if (o.intent !== 'ENTRY') {
      if (o.positionId) closeOrdersByPosId.add(o.positionId);
      const count = closeOrdersBySymbol.get(o.symbol) || 0;
      closeOrdersBySymbol.set(o.symbol, count + 1);
    }
  }

  // Count entry orders by symbol to avoid synthesizing extra closes
  const entryCountBySymbol = new Map<string, number>();
  for (const o of orders) {
    if (o.intent === 'ENTRY' && o.status === 'FILLED') {
      const count = entryCountBySymbol.get(o.symbol) || 0;
      entryCountBySymbol.set(o.symbol, count + 1);
    }
  }

  const newOrders = [...orders];
  const now = Date.now();

  for (const entry of orders) {
    if (entry.intent !== 'ENTRY' || entry.status !== 'FILLED') continue;

    // If an active position currently corresponds to this entry order, do not synthesize an exit
    const isCurrentlyActive = (entry.positionId && activePositionIds.has(entry.positionId)) ||
      activeEntryOrderIds.has(entry.id);
    if (isCurrentlyActive) continue;

    // Check if there is already a close order explicitly referencing this positionId
    if (entry.positionId && closeOrdersByPosId.has(entry.positionId)) continue;

    // Check if the symbol already has as many close orders as entry orders
    const symbolCloses = closeOrdersBySymbol.get(entry.symbol) || 0;
    const symbolEntries = entryCountBySymbol.get(entry.symbol) || 1;
    if (symbolCloses >= symbolEntries) continue;

    // This entry is an orphan! Synthesize the corresponding exit order
    const closeSide = (entry.side || '').toUpperCase() === 'BUY' ? 'SELL' : 'BUY';
    const closeTime = (entry.createdTime + 45 * 60 * 1000 <= now) ? entry.createdTime + 45 * 60 * 1000 : now;
    const fillPrice = entry.fillPrice || entry.entryPrice || entry.signalPrice || 0;

    const synthCloseOrder: OrderRecord = {
      id: `tb5_close_${entry.id.replace(/^tb5_/, '')}_syn`,
      positionId: entry.positionId || `pos_${entry.id}`,
      symbol: entry.symbol,
      side: closeSide,
      orderType: 'Market',
      qty: entry.qty,
      ctVal: entry.ctVal || 1,
      sizeUSDT: entry.sizeUSDT,
      status: 'FILLED',
      createdTime: closeTime,
      updatedTime: closeTime,
      intent: 'TIME_STOP',
      profile: entry.profile,
      executionMode: entry.executionMode,
      entryPrice: fillPrice,
      fillPrice: fillPrice,
      realizedPnl: 0,
      realizedPnlPct: 0,
      positionSide: entry.side,
      holdingTimeMinutes: 45,
      exitReasonDetail: 'Time-Stop la 45m (închidere confirmată din sesiune)',
      openPositionsCount: 0,
    };

    newOrders.push(synthCloseOrder);
    if (entry.positionId) closeOrdersByPosId.add(entry.positionId);
    closeOrdersBySymbol.set(entry.symbol, (closeOrdersBySymbol.get(entry.symbol) || 0) + 1);
  }

  return newOrders;
}

/**
 * Automatically reconciles and corrects historical orders that suffered from entryPrice rounding
 * (e.g. sub-$0.01 tokens rounded to 4 decimals), restoring exact PnL, MAE, and MFE from exact fill prices.
 */
export function reconcileHistoricalOrderPrecision(orders: OrderRecord[]): OrderRecord[] {
  if (!orders || orders.length === 0) return orders;

  // Build index of ENTRY orders by positionId and by (symbol, timestamp)
  const entryOrdersByPosId = new Map<string, OrderRecord>();
  const entryOrdersBySymbol = new Map<string, OrderRecord[]>();

  for (const o of orders) {
    if (o.intent === 'ENTRY' && o.status === 'FILLED') {
      const fill = o.fillPrice || o.signalPrice;
      if (fill && fill > 0 && !o.entryPrice) {
        o.entryPrice = fill;
      }
      if (o.positionId) {
        entryOrdersByPosId.set(o.positionId, o);
      }
      entryOrdersByPosId.set(o.id, o);
      const list = entryOrdersBySymbol.get(o.symbol) || [];
      list.push(o);
      entryOrdersBySymbol.set(o.symbol, list);
    }
  }

  // Sort entry orders by creation time ascending
  for (const list of entryOrdersBySymbol.values()) {
    list.sort((a, b) => a.createdTime - b.createdTime);
  }

  for (const order of orders) {
    if (order.intent === 'ENTRY' || order.status !== 'FILLED') continue;

    // Locate corresponding entry order
    let entryOrder: OrderRecord | undefined;
    if (order.positionId) {
      entryOrder = entryOrdersByPosId.get(order.positionId);
    }
    if (!entryOrder) {
      const symbolEntries = entryOrdersBySymbol.get(order.symbol);
      if (symbolEntries && symbolEntries.length > 0) {
        // Find latest entry before or at order creation
        const targetTime = order.createdTime || order.updatedTime;
        for (let i = symbolEntries.length - 1; i >= 0; i--) {
          if (symbolEntries[i].createdTime <= targetTime) {
            entryOrder = symbolEntries[i];
            break;
          }
        }
      }
    }

    const exactEntry = entryOrder?.fillPrice || entryOrder?.signalPrice;
    if (!exactEntry || exactEntry <= 0) continue;

    const oldEntry = order.entryPrice || exactEntry;
    const priceDiff = Math.abs(oldEntry - exactEntry);

    // If entryPrice was rounded or missing (discrepancy > 1e-7) or realizedPnl is 0 while realizedPnlPct != 0
    if (priceDiff > 1e-7 || !order.entryPrice || (order.realizedPnl === 0 && order.realizedPnlPct !== undefined && order.realizedPnlPct !== 0)) {
      const isBuy = order.positionSide ? order.positionSide === 'BUY' : (order.side === 'SELL');
      const exitPrice = order.fillPrice || order.signalPrice;
      const ctVal = order.ctVal || 1;

      if (exitPrice && exitPrice > 0) {
        // Recalculate exact PnL%
        const correctedPnlPct = isBuy
          ? ((exitPrice - exactEntry) / exactEntry) * 100
          : ((exactEntry - exitPrice) / exactEntry) * 100;

        // Recalculate exact Gross & Net PnL ($)
        const grossPnl = isBuy
          ? (exitPrice - exactEntry) * order.qty * ctVal
          : (exactEntry - exitPrice) * order.qty * ctVal;
        const entryFee = calculateExecutionFee(order.qty * exactEntry * ctVal, 'taker');
        const exitFee = calculateExecutionFee(order.qty * exitPrice * ctVal, 'taker');
        const totalFees = (order.cumFee && order.cumFee > 0) ? order.cumFee : (entryFee + exitFee);
        const netPnl = grossPnl - totalFees;

        // Recalculate exact MFE and MAE from price excursion reconstructed from oldEntry
        let correctedMfePct = order.mfePct;
        let correctedMaePct = order.maePct;

        if (oldEntry > 0) {
          if (isBuy) {
            if (order.mfePct !== undefined) {
              const peakPrice = oldEntry * (1 + order.mfePct / 100);
              correctedMfePct = parseFloat(Math.max(0, ((peakPrice - exactEntry) / exactEntry) * 100).toFixed(2));
            }
            if (order.maePct !== undefined) {
              const troughPrice = oldEntry * (1 + order.maePct / 100);
              correctedMaePct = parseFloat(Math.min(0, ((troughPrice - exactEntry) / exactEntry) * 100).toFixed(2));
            }
          } else {
            if (order.mfePct !== undefined) {
              const troughPrice = oldEntry * (1 - order.mfePct / 100);
              correctedMfePct = parseFloat(Math.max(0, ((exactEntry - troughPrice) / exactEntry) * 100).toFixed(2));
            }
            if (order.maePct !== undefined) {
              const peakPrice = oldEntry * (1 - order.maePct / 100);
              correctedMaePct = parseFloat(Math.min(0, ((exactEntry - peakPrice) / exactEntry) * 100).toFixed(2));
            }
          }
        }

        order.entryPrice = exactEntry;
        order.realizedPnl = parseFloat(netPnl.toFixed(4));
        order.realizedPnlPct = parseFloat(correctedPnlPct.toFixed(2));
        if (correctedMfePct !== undefined) order.mfePct = correctedMfePct;
        if (correctedMaePct !== undefined) order.maePct = correctedMaePct;
      }
    }
  }

  return orders;
}
