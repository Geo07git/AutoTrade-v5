import { TradeSignal, ProfileConfig, Position, RiskApproval } from '../../shared/types';
import { experimentManager } from '../experiment/ExperimentManager';

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
      entriesLastHour?: number;
      lastClosedTradeWasLoss?: boolean;
      lastClosedTradeTime?: number;
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

    // 3. BTC BEAR Regime Filter for LONG entries (respects user setting: only active if config.btcBearGuard is true)
    const marketRegime = options?.marketRegime || '';
    const isBtcBear = marketRegime.includes('BEAR') || (marketRegime.includes('-%') && !marketRegime.includes('BTC: --'));

    if (config.btcBearGuard && isBtcBear && signal.side === 'BUY') {
      // If momentum score is below high threshold in BTC BEAR and guard is enabled, block LONG entries
      if (signal.score < 68) {
        return {
          approved: false,
          sizeUSDT: 0,
          reason: `[BTC_BEAR_GUARD] Pozițiile LONG sunt temporar dezactivate în regim BTC BEAR (${marketRegime}) pentru scoruri sub 68 (scor semnal: ${signal.score.toFixed(1)}). Dezactivează btcBearGuard în setări pentru permisiune oricând.`,
        };
      }
    }

    // 3b. Short Regime Guard for SELL/SHORT entries
    const shortGuard = config.shortRegimeGuard !== undefined ? config.shortRegimeGuard : 'OFF';
    if (signal.side === 'SELL') {
      if (shortGuard === 'DISABLED') {
        return {
          approved: false,
          sizeUSDT: 0,
          reason: `[SHORT_DISABLED] Pozițiile SELL (SHORT) sunt dezactivate în profil (istoric dovedit asimetric negativ).`,
        };
      }
      if (shortGuard === 'BEAR_ONLY' && !isBtcBear) {
        return {
          approved: false,
          sizeUSDT: 0,
          reason: `[SHORT_REGIME_GUARD] Pozițiile SELL (SHORT) sunt permise exclusiv când BTC se află în regim BEAR (regim actual: ${marketRegime || 'BULL/NEUTRAL'}). Setează shortRegimeGuard: 'OFF' în profil pentru dezactivare.`,
        };
      }
      // Prag ridicat de activare pentru semnalele SHORT (pentru evitarea declanșării pe semnale slabe)
      const minShortScore = config.minShortMomentumScore !== undefined ? config.minShortMomentumScore : 0;
      if (minShortScore > 0 && signal.score < minShortScore) {
        return {
          approved: false,
          sizeUSDT: 0,
          reason: `[SHORT_SCORE_FILTER] Scorul semnalului SELL (${signal.score.toFixed(1)}) este sub pragul ridicat de protecție configurat (${minShortScore}). Pozițiile SHORT cer confirmare de impuls puternic.`,
        };
      }
    }

    // 3c. Hourly Entry Cap per Symbol
    const maxEntriesPerHour = config.maxEntriesPerSymbolPerHour !== undefined ? config.maxEntriesPerSymbolPerHour : 3;
    if (maxEntriesPerHour > 0 && options?.entriesLastHour !== undefined && options.entriesLastHour >= maxEntriesPerHour) {
      return {
        approved: false,
        sizeUSDT: 0,
        reason: `[HOURLY_SYMBOL_CAP] Plafonul de ${maxEntriesPerHour} intrări/oră pe simbol a fost atins pentru ${signal.symbol} (${options.entriesLastHour} intrări în ultima oră). Setează maxEntriesPerSymbolPerHour: 0 pentru dezactivare.`,
      };
    }

    // 3d. Cooldown after Loss / Stop-Loss
    const lossCooldown = config.cooldownAfterLossMinutes !== undefined ? config.cooldownAfterLossMinutes : 30;
    if (lossCooldown > 0 && options?.lastClosedTradeWasLoss && options?.lastClosedTradeTime) {
      const minutesSinceLoss = (Date.now() - options.lastClosedTradeTime) / 60000;
      if (minutesSinceLoss < lossCooldown) {
        const remainingMin = (lossCooldown - minutesSinceLoss).toFixed(1);
        return {
          approved: false,
          sizeUSDT: 0,
          reason: `[POST_LOSS_COOLDOWN] Simbolul ${signal.symbol} este în pauză post-pierdere/SL (${lossCooldown}m configurat; ${remainingMin}m rămase). Setează cooldownAfterLossMinutes: 0 pentru dezactivare.`,
        };
      }
    }

    const expState = experimentManager.getState();
    const isExpActive = expState.isActive;

    // 4. Max Open Positions & Risk Allocation check
    const riskPct = config.riskPerTradePct > 0 ? config.riskPerTradePct : 50;
    const maxTradesByRisk = Math.max(1, Math.floor(100 / riskPct));
    const effectiveMaxOpenPositions = isExpActive ? 50 : Math.min(config.maxOpenPositions, maxTradesByRisk);

    if (activePositions.length >= effectiveMaxOpenPositions) {
      return {
        approved: false,
        sizeUSDT: 0,
        reason: isExpActive
          ? `Plafonul de 50 poziții simultane în modul Experiment a fost atins (${activePositions.length}/50).`
          : `Max open positions reached for risk setting ${riskPct}% (${activePositions.length}/${effectiveMaxOpenPositions} allowed; max trades by risk: ${maxTradesByRisk})`,
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

    // 6. Momentum Score Window Validation (Configurable via Settings)
    const maxScoreCap = config.maxMomentumScore !== undefined ? config.maxMomentumScore : 100;
    const minScoreRequired = config.minMomentumScore !== undefined ? config.minMomentumScore : 50;

    if (maxScoreCap < 100 && signal.score > maxScoreCap) {
      return {
        approved: false,
        sizeUSDT: 0,
        reason: `MOMENTUM_SCORE_TOO_HIGH: Scorul ${signal.score.toFixed(1)} depășește tavanul configurat în setări (${maxScoreCap}/100).`,
      };
    }

    const expMinScore = isExpActive ? (expState.minMomentumScore || 50) : 50;
    if (signal.score < minScoreRequired || (isExpActive && signal.score < expMinScore)) {
      return {
        approved: false,
        sizeUSDT: 0,
        reason: isExpActive 
          ? `[EXPERIMENT_FILTER] Scorul (${signal.score.toFixed(1)}) este sub pragul configurat pentru experiment (${expMinScore}/100).` 
          : `Scorul semnalului (${signal.score.toFixed(1)}) este sub pragul minim configurat (${minScoreRequired}/100).`,
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

    const effectiveEquity = isExpActive ? 10_000 : currentEquity;
    const profitVault = Math.max(0, options?.profitVault || 0);
    const operatingEquity = options?.operatingEquity && options.operatingEquity > 0
      ? options.operatingEquity
      : Math.max(10, effectiveEquity - profitVault);

    // 8. Equity & Sizing check
    if (operatingEquity <= 0 || effectiveEquity <= 0) {
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
    const walletBalance = effectiveEquity - unrealizedPnL;
    const rawFreeBalance = Math.max(0, walletBalance - marginInvested);
    // Usable Free Balance strictly respects the profit vault (reserve):
    const usableFreeBalance = Math.max(0, rawFreeBalance - profitVault);

    if (!isExpActive && usableFreeBalance < 5) {
      return {
        approved: false,
        sizeUSDT: 0,
        reason: profitVault > 0
          ? `Insufficient Usable Free Balance ($${usableFreeBalance.toFixed(2)} available, $${profitVault.toFixed(2)} protejat în Profit Vault). Marjă blocată: $${marginInvested.toFixed(2)}. Minim 5 USDT necesar.`
          : `Insufficient Free Balance ($${rawFreeBalance.toFixed(2)} available). Margin locked: $${marginInvested.toFixed(2)} across ${activePositions.length} position(s). Minimum 5 USDT required for new entry.`,
      };
    }

    // Volatility (ATR) Normalized Position Sizing & Fixed Dollar Risk:
    // Extracts current price and atr14 (14-period closed candle ATR) from signal/metrics to normalize risk across symbols.
    const currentPrice = signal.currentPrice || signal.reasons?.lastPrice || 0;
    const effectiveAtr = signal.atr14 || signal.reasons?.atr14 || signal.currentAtr || signal.reasons?.currentAtr || 0;
    const rawAtrPct = currentPrice > 0 && effectiveAtr > 0
      ? (effectiveAtr / currentPrice) * 100
      : (signal.atrPct || 0);
    const atrPct = Math.max(0, rawAtrPct);

    // Effective Risk Distance to Stop-Loss (%):
    // Strictly respect config.hardStopLossPct without hidden ATR shrinking/overrides.
    const effectiveStopDistancePct = Math.max(0.1, config.hardStopLossPct);

    // Net Capital with 10% reserve margin (-10% reserve margin):
    const netCapital = operatingEquity * 0.90;

    // Position Size (USDT) allocated by riskPerTradePct of Net Capital (-10% reserve):
    // In unlimited experiment mode, use fixed 50 USDT per trade for clean execution across unlimited pairs
    let desiredSizeUSDT = isExpActive ? 50 : netCapital * (riskPct / 100);

    // If LONG in BTC BEAR regime and guard enabled: reduce size by 50% for conservative exposure
    if (config.btcBearGuard && isBtcBear && signal.side === 'BUY') {
      desiredSizeUSDT = desiredSizeUSDT * 0.50;
    }

    // Single-Position Concentration Cap based on net capital:
    const maxSinglePositionCap = netCapital * 0.95;
    desiredSizeUSDT = Math.min(desiredSizeUSDT, maxSinglePositionCap);

    // Strict Usable Free Balance Cap:
    const maxAllocatableSize = usableFreeBalance * 0.95;
    let targetSizeUSDT = Math.min(desiredSizeUSDT, maxAllocatableSize);

    // If calculated percentage size is below 5 USDT but user has enough free balance, scale up to minimum 5 USDT
    if (targetSizeUSDT < 5 && usableFreeBalance >= 5.2) {
      targetSizeUSDT = Math.min(5.0, maxAllocatableSize);
    }

    // Stop Loss Price Calculation:
    const stopDistanceRatio = effectiveStopDistancePct / 100;
    const stopLossPrice = currentPrice > 0
      ? (signal.side === 'BUY'
          ? currentPrice * (1 - stopDistanceRatio)
          : currentPrice * (1 + stopDistanceRatio))
      : undefined;

    // Minimum notional value for OKX is 5 USDT
    if (targetSizeUSDT < 5 && !isExpActive) {
      return {
        approved: false,
        sizeUSDT: 0,
        reason: `Mărimea calculată ($${targetSizeUSDT.toFixed(2)}) sau balanța operativă disponibilă ($${usableFreeBalance.toFixed(2)}) este sub minimul de 5 USDT cerut de OKX.`,
      };
    }

    return {
      approved: true,
      sizeUSDT: parseFloat(targetSizeUSDT.toFixed(2)),
      stopLossPrice: stopLossPrice !== undefined ? stopLossPrice : undefined,
      effectiveStopDistancePct: parseFloat(effectiveStopDistancePct.toFixed(2)),
      dollarRiskAtStop: parseFloat((targetSizeUSDT * stopDistanceRatio).toFixed(2)),
      atrPct: parseFloat(atrPct.toFixed(2)),
      reason: config.btcBearGuard && isBtcBear && signal.side === 'BUY'
        ? `[BTC_BEAR_GUARD] Aprobat cu mărime redusă (-50%) în regim BTC BEAR (${marketRegime}).`
        : undefined,
    };
  }
}
