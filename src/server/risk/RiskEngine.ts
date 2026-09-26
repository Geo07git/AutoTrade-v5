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
    hasPendingOrder: boolean = false,
    options?: {
      operatingEquity?: number;
      profitVault?: number;
      marketRegime?: string;
      excludedSymbols?: string[];
    }
  ): RiskApproval {
    // 1. Kill Switch check
    if (killSwitchEngaged) {
      return {
        approved: false,
        sizeUSDT: 0,
        reason: 'Kill Switch is currently engaged. All new entries are blocked.',
      };
    }

    // 2. Excluded Symbol Filter (Toxic / Underperforming Pairs)
    const excludedTokens = options?.excludedSymbols || ['CAP', 'ONDO', 'NIGHT', 'ARX', 'GPS', 'ZAMA'];
    const baseSymbol = signal.symbol.replace('-USDT-SWAP', '').replace('USDT', '').toUpperCase();
    const isBlacklisted = excludedTokens.some((token) => {
      const clean = token.toUpperCase().trim();
      return baseSymbol === clean || baseSymbol.startsWith(clean) || signal.symbol.toUpperCase().includes(clean);
    });
    if (isBlacklisted) {
      return {
        approved: false,
        sizeUSDT: 0,
        reason: `[TOKEN_EXCLUDED] Simbolul ${signal.symbol} este exclus din tranzacționare din cauza istoricului consistent negativ / spread nefavorabil.`,
      };
    }

    // 3. BTC BEAR Regime Filter for LONG entries
    const marketRegime = options?.marketRegime || '';
    const isBtcBear = marketRegime.includes('BEAR') || (marketRegime.includes('-%') && !marketRegime.includes('BTC: --'));

    if (isBtcBear && signal.side === 'BUY') {
      // If momentum score is below high threshold in BTC BEAR, block LONG entries entirely
      if (signal.score < 68) {
        return {
          approved: false,
          sizeUSDT: 0,
          reason: `[BTC_BEAR_GUARD] Pozițiile LONG sunt temporar dezactivate în regim BTC BEAR (${marketRegime}) pentru scoruri sub 68 (scor semnal: ${signal.score.toFixed(1)}). Risk/reward asimetric negativ pe date.`,
        };
      }
    }

    // 4. Max Open Positions & Risk Allocation check (User Rule: riskPerTradePct determines max trades = floor(100 / riskPct), capped by maxOpenPositions)
    const riskPct = config.riskPerTradePct > 0 ? config.riskPerTradePct : 50;
    const maxTradesByRisk = Math.max(1, Math.floor(100 / riskPct));
    const effectiveMaxOpenPositions = Math.min(config.maxOpenPositions, maxTradesByRisk);

    if (activePositions.length >= effectiveMaxOpenPositions) {
      return {
        approved: false,
        sizeUSDT: 0,
        reason: `Max open positions reached for risk setting ${riskPct}% (${activePositions.length}/${effectiveMaxOpenPositions} allowed; max trades by risk: ${maxTradesByRisk})`,
      };
    }

    // 5. Duplicate Position check
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

    // 6. Momentum Score Window Validation (Anti-Exhaustion Guard)
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

    // 7. Pending in-flight Order check (Prevents duplicate entries)
    if (hasPendingOrder) {
      return {
        approved: false,
        sizeUSDT: 0,
        reason: `Pending order already in-flight for ${signal.symbol}. Duplicate entry prevented.`,
      };
    }

    const profitVault = Math.max(0, options?.profitVault || 0);
    const operatingEquity = options?.operatingEquity && options.operatingEquity > 0
      ? options.operatingEquity
      : Math.max(10, currentEquity - profitVault);

    // 8. Equity & Sizing check
    if (operatingEquity <= 0 || currentEquity <= 0) {
      return {
        approved: false,
        sizeUSDT: 0,
        reason: 'Zero or invalid account operating equity',
      };
    }

    // 9. Free Balance & Margin Allocation Check (TradeBot 4 Accounting Logic)
    // Formula: Margin (Invested) + Free Balance = Total Equity - Unrealized PnL (Wallet Balance)
    const marginInvested = activePositions.reduce((acc, p) => acc + (p.sizeUSDT || 0), 0);
    const unrealizedPnL = activePositions.reduce((acc, p) => acc + (p.pnl || 0), 0);
    const walletBalance = currentEquity - unrealizedPnL;
    const rawFreeBalance = Math.max(0, walletBalance - marginInvested);
    // Usable Free Balance strictly respects the profit vault (reserve):
    const usableFreeBalance = Math.max(0, rawFreeBalance - profitVault);

    if (usableFreeBalance < 5) {
      return {
        approved: false,
        sizeUSDT: 0,
        reason: profitVault > 0
          ? `Insufficient Usable Free Balance ($${usableFreeBalance.toFixed(2)} available, $${profitVault.toFixed(2)} protejat în Profit Vault). Marjă blocată: $${marginInvested.toFixed(2)}. Minim 5 USDT necesar.`
          : `Insufficient Free Balance ($${rawFreeBalance.toFixed(2)} available). Margin locked: $${marginInvested.toFixed(2)} across ${activePositions.length} position(s). Minimum 5 USDT required for new entry.`,
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

    // Effective Risk Distance to Stop-Loss (%):
    // HARD Stop-Loss limit: MUST NEVER exceed config.hardStopLossPct (e.g. 3.5%).
    // Volatility Stop: 1.2x ATR% can tighten the stop if volatility is lower, but NEVER widen beyond hardStopLossPct.
    const hardStopLimitPct = Math.max(0.5, config.hardStopLossPct);
    const atrDistancePct = atrPct > 0 ? atrPct * 1.2 : hardStopLimitPct;
    const effectiveStopDistancePct = Math.min(
      hardStopLimitPct,
      Math.max(0.5, atrDistancePct)
    );

    // Net Capital with 10% reserve margin (-10% reserve margin):
    const netCapital = operatingEquity * 0.90;

    // Position Size (USDT) allocated by riskPerTradePct of Net Capital (-10% reserve):
    let desiredSizeUSDT = netCapital * (riskPct / 100);

    // If LONG in BTC BEAR regime: reduce size by 50% for conservative exposure
    if (isBtcBear && signal.side === 'BUY') {
      desiredSizeUSDT = desiredSizeUSDT * 0.50;
    }

    // Single-Position Concentration Cap based on net capital:
    const maxSinglePositionCap = netCapital * 0.95;
    desiredSizeUSDT = Math.min(desiredSizeUSDT, maxSinglePositionCap);

    // Strict Usable Free Balance Cap:
    const maxAllocatableSize = usableFreeBalance * 0.95;
    const targetSizeUSDT = Math.min(desiredSizeUSDT, maxAllocatableSize);

    // Stop Loss Price Calculation:
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
        reason: `Mărimea calculată pe bază de volatilitate/ATR ($${targetSizeUSDT.toFixed(2)}) sau balanța operativă disponibilă ($${usableFreeBalance.toFixed(2)}) este sub minimul de 5 USDT cerut de OKX. (Stop Volatilitate: ${effectiveStopDistancePct.toFixed(2)}%, ATR: ${atrPct.toFixed(2)}%).`,
      };
    }

    return {
      approved: true,
      sizeUSDT: parseFloat(targetSizeUSDT.toFixed(2)),
      stopLossPrice: stopLossPrice ? parseFloat(stopLossPrice.toFixed(4)) : undefined,
      effectiveStopDistancePct: parseFloat(effectiveStopDistancePct.toFixed(2)),
      dollarRiskAtStop: parseFloat((targetSizeUSDT * stopDistanceRatio).toFixed(2)),
      atrPct: parseFloat(atrPct.toFixed(2)),
      reason: isBtcBear && signal.side === 'BUY'
        ? `[BTC_BEAR_GUARD] Aprobat cu mărime redusă (-50%) în regim BTC BEAR (${marketRegime}).`
        : undefined,
    };
  }
}
