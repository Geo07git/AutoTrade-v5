import { TradeSignal, ProfileConfig, Position } from '../../shared/types';

export class RiskEngine {
  public validateSignal(signal: TradeSignal, config: ProfileConfig, activePositions: Position[], currentEquity: number): { approved: boolean, sizeUSDT: number, reason?: string } {
    if (activePositions.length >= config.maxOpenPositions) {
      return { approved: false, sizeUSDT: 0, reason: 'Max open positions reached' };
    }

    const existingPosition = activePositions.find(p => p.symbol === signal.symbol && p.status === 'OPEN');
    if (existingPosition) {
      return { approved: false, sizeUSDT: 0, reason: 'Position already open for this symbol' };
    }

    // Allocate based on risk
    const targetSizeUSDT = currentEquity * (config.riskPerTradePct / 100);
    
    if (targetSizeUSDT < 5) {
      return { approved: false, sizeUSDT: 0, reason: 'Target size too small (<5 USDT)' };
    }

    return { approved: true, sizeUSDT: targetSizeUSDT };
  }
}
