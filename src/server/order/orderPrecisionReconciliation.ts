import { OrderRecord } from '../../shared/types';

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

    // If entryPrice was rounded or missing (discrepancy > 1e-7)
    if (priceDiff > 1e-7 || !order.entryPrice) {
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
        const entryFee = (order.qty * exactEntry * ctVal * 0.0005);
        const exitFee = (order.qty * exitPrice * ctVal * 0.0005);
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
        order.realizedPnl = parseFloat(netPnl.toFixed(2));
        order.realizedPnlPct = parseFloat(correctedPnlPct.toFixed(2));
        if (correctedMfePct !== undefined) order.mfePct = correctedMfePct;
        if (correctedMaePct !== undefined) order.maePct = correctedMaePct;
      }
    }
  }

  return orders;
}
