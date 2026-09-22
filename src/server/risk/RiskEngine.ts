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

    // Volatility (ATR) Normalized Position Sizing & Fixed Dollar Risk:
    // Extracts current price and ATR from signal/metrics to normalize risk across symbols.
    const currentPrice = signal.currentPrice || signal.reasons?.lastPrice || 0;
    const currentAtr = signal.currentAtr || signal.reasons?.currentAtr || 0;
    const rawAtrPct = currentPrice > 0 && currentAtr > 0
      ? (currentAtr / currentPrice) * 100
      : (signal.atrPct || 0);
    const atrPct = Math.max(0, rawAtrPct);

    // 1. Effective Risk Distance to Stop-Loss (%):
    // Floor is the profile's hardStopLossPct (e.g. 1.0% in SCALP, 2.0% in MOMENTUM).
    // Volatility Stop: 1.2x ATR% ensures the stop is outside standard 1-candle noise.
    // Clamped between baseStopDistancePct and at most 2.5x baseStopDistancePct.
    const baseStopDistancePct = Math.max(0.5, config.hardStopLossPct);
    const atrDistancePct = atrPct > 0 ? atrPct * 1.2 : baseStopDistancePct;
    const effectiveStopDistancePct = Math.min(
      baseStopDistancePct * 2.5,
      Math.max(baseStopDistancePct, atrDistancePct)
    );

    // 2. Fixed Dollar Risk Budget ($ at risk per trade):
    // Standard baseline risk at hardStopLossPct:
    // targetDollarRisk = currentEquity * (riskPerTradePct / 100) * (baseStopDistancePct / 100)
    // E.g. $200 equity * 15% allocation * 1.0% stop = $0.30 fixed risk.
    const targetDollarRisk = currentEquity * (config.riskPerTradePct / 100) * (baseStopDistancePct / 100);

    // 3. Volatility-Calibrated Position Size (USDT):
    // Position Size = Target $ Risk / (effectiveStopDistancePct / 100)
    // Volatile pairs (high ATR) get smaller notional sizes to cap dollar loss.
    // Calmer pairs (low ATR) get larger notional sizes to normalize portfolio yield.
    let desiredSizeUSDT = targetDollarRisk / (effectiveStopDistancePct / 100);

    // 4. Single-Position Concentration Cap:
    // Never allocate more than 30% of total equity into a single position.
    const maxSinglePositionCap = currentEquity * 0.30;
    desiredSizeUSDT = Math.min(desiredSizeUSDT, maxSinglePositionCap);

    // 5. Strict Free Balance Cap:
    // The position size can never exceed available free balance (with 5% buffer for fees/slippage).
    const maxAllocatableSize = freeBalance * 0.95;
    const targetSizeUSDT = Math.min(desiredSizeUSDT, maxAllocatableSize);

    // 6. Stop Loss Price Calculation:
    const stopDistanceRatio = effectiveStopDistancePct / 100;
    const stopLossPrice = currentPrice > 0
      ? (signal.side === 'BUY'
          ? currentPrice * (1 - stopDistanceRatio)
          : currentPrice * (1 + stopDistanceRatio))
      : undefined;

    // Minimum notional value for OKX is 5 USDT
    if (targetSizeUSDT < 5) {
      return {
        approved: false,
        sizeUSDT: 0,
        reason: `Mărimea calculată pe bază de volatilitate/ATR ($${targetSizeUSDT.toFixed(2)}) sau balanța disponibilă ($${freeBalance.toFixed(2)}) este sub minimul de 5 USDT cerut de OKX. (Stop Volatilitate: ${effectiveStopDistancePct.toFixed(2)}%, ATR: ${atrPct.toFixed(2)}%).`,
      };
    }

    return {
      approved: true,
      sizeUSDT: parseFloat(targetSizeUSDT.toFixed(2)),
      stopLossPrice: stopLossPrice ? parseFloat(stopLossPrice.toFixed(4)) : undefined,
      effectiveStopDistancePct: parseFloat(effectiveStopDistancePct.toFixed(2)),
      dollarRiskAtStop: parseFloat((targetSizeUSDT * stopDistanceRatio).toFixed(2)),
      atrPct: parseFloat(atrPct.toFixed(2)),
    };
  }
}
