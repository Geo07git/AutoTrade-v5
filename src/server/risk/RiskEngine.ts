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
    killSwitchEngaged: boolean,
    hasPendingOrder: boolean = false
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

    // 4. Momentum Score Window Validation (Anti-Exhaustion Guard)
    // Avoid entries when score is above maxMomentumScore (e.g. >= 85, where win rate dropped to 0-3%)
    const maxScoreCap = config.maxMomentumScore !== undefined ? config.maxMomentumScore : 85;
    const minScoreRequired = config.minMomentumScore !== undefined ? config.minMomentumScore : 57;

    if (signal.score > maxScoreCap) {
      return {
        approved: false,
        sizeUSDT: 0,
        reason: `MOMENTUM_EXHAUSTION_ZONE: Scorul ${signal.score.toFixed(1)} depășește tavanul maxim de siguranță (${maxScoreCap}/100). Mișcare supradestinsă (exhaustion top).`,
      };
    }

    if (signal.score < minScoreRequired) {
      return {
        approved: false,
        sizeUSDT: 0,
        reason: `Scorul semnalului (${signal.score.toFixed(1)}) este sub pragul minim configurat (${minScoreRequired}/100).`,
      };
    }

    // 4. Pending in-flight Order check (Prevents duplicate entries)
    if (hasPendingOrder) {
      return {
        approved: false,
        sizeUSDT: 0,
        reason: `Pending order already in-flight for ${signal.symbol}. Duplicate entry prevented.`,
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

    // 5. Free Balance & Margin Allocation Check (TradeBot 4 Accounting Logic)
    // Formula: Margin (Invested) + Free Balance = Total Equity - Unrealized PnL (Wallet Balance)
    const marginInvested = activePositions.reduce((acc, p) => acc + (p.sizeUSDT || 0), 0);
    const unrealizedPnL = activePositions.reduce((acc, p) => acc + (p.pnl || 0), 0);
    const walletBalance = currentEquity - unrealizedPnL;
    const freeBalance = Math.max(0, walletBalance - marginInvested);

    if (freeBalance < 5) {
      return {
        approved: false,
        sizeUSDT: 0,
        reason: `Insufficient Free Balance ($${freeBalance.toFixed(2)} available). Margin locked: $${marginInvested.toFixed(2)} across ${activePositions.length} position(s). Minimum 5 USDT required for new entry.`,
      };
    }

    // Desired trade size based on risk percentage of shared capital
    const desiredSizeUSDT = currentEquity * (config.riskPerTradePct / 100);

    // Strict Free Balance Cap: The position size can never exceed available free balance (with 5% buffer for fees/slippage)
    const maxAllocatableSize = freeBalance * 0.95;
    const targetSizeUSDT = Math.min(desiredSizeUSDT, maxAllocatableSize);

    // Minimum notional value for OKX is 5 USDT
    if (targetSizeUSDT < 5) {
      return {
        approved: false,
        sizeUSDT: 0,
        reason: `Remaining Free Balance ($${freeBalance.toFixed(2)}) is insufficient for minimum trade size (5 USDT). Current margin allocated: $${marginInvested.toFixed(2)}.`,
      };
    }

    return {
      approved: true,
      sizeUSDT: parseFloat(targetSizeUSDT.toFixed(2)),
    };
  }
}
