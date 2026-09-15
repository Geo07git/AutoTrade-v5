import { Position, ProfileConfig } from '../../shared/types';
import { BybitAdapter } from '../exchange/BybitAdapter';

export class PositionManager {
  private activePositions: Position[] = [];
  private exchange: BybitAdapter;

  constructor(exchange: BybitAdapter) {
    this.exchange = exchange;
  }

  public getActivePositions(): Position[] {
    return this.activePositions;
  }
  
  public setActivePositions(positions: Position[]) {
    this.activePositions = positions;
  }

  public async registerPosition(pos: Position) {
    this.activePositions.push(pos);
  }

  public async updatePrices(currentPrices: Record<string, number>, config: ProfileConfig) {
    for (const pos of this.activePositions) {
      if (pos.status !== 'OPEN') continue;

      const currentPrice = currentPrices[pos.symbol];
      if (!currentPrice) continue;

      // Update max/min for trailing
      pos.highestPrice = Math.max(pos.highestPrice || pos.entryPrice, currentPrice);
      pos.lowestPrice = Math.min(pos.lowestPrice || pos.entryPrice, currentPrice);
      
      const pnlPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100 * (pos.side === 'BUY' ? 1 : -1);
      pos.pnlPct = pnlPct;
      pos.pnl = (pos.sizeUSDT * pnlPct) / 100;

      // Check Hard Stop Loss
      if (pnlPct <= -config.hardStopLossPct) {
        await this.closePosition(pos, currentPrice, 'HARD_STOP_LOSS');
        continue;
      }

      // Check Trailing Stop
      if (pos.highestPrice && pos.side === 'BUY') {
        const highestPnlPct = ((pos.highestPrice - pos.entryPrice) / pos.entryPrice) * 100;
        if (highestPnlPct >= config.trailingActivationPct) {
          const distanceToCurrent = ((pos.highestPrice - currentPrice) / pos.highestPrice) * 100;
          if (distanceToCurrent >= config.trailingDistancePct) {
            await this.closePosition(pos, currentPrice, 'TRAILING_STOP');
          }
        }
      }
    }
  }

  public async closePosition(pos: Position, exitPrice: number, reason: string) {
    console.log(`[PositionManager] Closing ${pos.symbol} at ${exitPrice} due to ${reason}`);
    
    // Attempt real close on exchange if not testnet or paper trading
    // For now we will mock real order execution inside OrderManager/BybitAdapter, 
    // but here we mark it as closed locally.
    
    pos.status = 'CLOSED';
    pos.exitPrice = exitPrice;
    pos.exitTime = Date.now();
    
    // We would actually call exchange adapter here if fully live
    // await this.exchange.placeMarketOrder(pos.symbol, pos.side === 'BUY' ? 'Sell' : 'Buy', calculateQty());

    this.activePositions = this.activePositions.filter(p => p.id !== pos.id);
  }
  
  public async closeAllPositions(reason: string) {
    const positionsToClose = [...this.activePositions];
    for(const pos of positionsToClose) {
      await this.closePosition(pos, pos.highestPrice || pos.entryPrice, reason); // mock current price fallback
    }
  }
}
