import { TradeSignal, ProfileConfig, Position, RiskApproval } from '../../shared/types';

export class RiskEngine {
  /**
   * Mandatory gatekeeper: All trade signals must be validated here before
   * reaching OrderManager.
   */
  public validateSignal(
    signal: TradeSignal,
    config: ProfileConfig,
    activePositions: Position[],
    currentEquity: number,
    killSwitchEngaged: boolean
  ): RiskApproval {
    // 1. Kill Switch check
    if (killSwitchEngaged) {
      return {
        approved: false,
        sizeUSDT: 0,
        reason: 'Kill Switch is currently engaged. All new entries are blocked.',
      };
    }

    // 2. Max Open Positions check
    if (activePositions.length >= config.maxOpenPositions) {
      return {
        approved: false,
        sizeUSDT: 0,
        reason: `Max open positions reached (${activePositions.length}/${config.maxOpenPositions})`,
      };
    }

    // 3. Duplicate Position check
    const existingPosition = activePositions.find(
      (p) => p.symbol === signal.symbol && p.status === 'OPEN'
    );
    if (existingPosition) {
      return {
        approved: false,
        sizeUSDT: 0,
        reason: `Position already open for ${signal.symbol}`,
      };
    }

    // 4. Equity & Sizing check
    if (currentEquity <= 0) {
      return {
        approved: false,
        sizeUSDT: 0,
        reason: 'Zero or invalid account equity',
      };
    }

    // Calculate trade size based on risk percentage of shared capital
    const targetSizeUSDT = currentEquity * (config.riskPerTradePct / 100);

    // Minimum notional value for Bybit is 5 USDT
    if (targetSizeUSDT < 5) {
      return {
        approved: false,
        sizeUSDT: 0,
        reason: `Calculated trade size ($${targetSizeUSDT.toFixed(2)}) is below minimum exchange threshold (5 USDT)`,
      };
    }

    // Cap at 95% of equity to preserve margin for slippage and trading fees
    const cappedSizeUSDT = Math.min(targetSizeUSDT, currentEquity * 0.95);

    return {
      approved: true,
      sizeUSDT: parseFloat(cappedSizeUSDT.toFixed(2)),
    };
  }
}
