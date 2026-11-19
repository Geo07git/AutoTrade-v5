import {
  GridBotInstance,
  NeutralGridBotConfig,
} from '../../../shared/types';
import { assessProfitTrailingStop } from './gridProfitGuard';

export interface GridRiskEvaluation {
  approved: boolean;
  reason?: string;
}

export interface LiveBotRiskAction {
  action:
    | 'NONE'
    | 'STOP_LOSS'
    | 'TAKE_PROFIT'
    | 'RANGE_BREAKOUT_STOP'
    | 'PROFIT_TRAILING_STOP';
  reason?: string;
}

export class GridRiskManager {
  /**
   * Validates whether a new Neutral Grid bot can be safely deployed given account free balance and limits.
   */
  public static validateNewGridBot(
    config: NeutralGridBotConfig,
    freeBalanceUSDT: number,
    activeBotsCount: number,
    killSwitchEngaged: boolean
  ): GridRiskEvaluation {
    if (killSwitchEngaged) {
      return {
        approved: false,
        reason: 'Kill Switch de urgență este ACTIVAT. Dezactivați Kill Switch înainte de a lansa un bot Grid.',
      };
    }

    const maxBots = config.risk?.maxActiveGridBots || 10;
    if (activeBotsCount >= maxBots) {
      return {
        approved: false,
        reason: `Numărul maxim de boți Grid activi (${maxBots}) a fost atins.`,
      };
    }

    if (config.lowerPrice <= 0 || config.upperPrice <= 0 || config.lowerPrice >= config.upperPrice) {
      return {
        approved: false,
        reason: `Praguri de preț invalide: Prețul Minim ($${config.lowerPrice}) trebuie să fie strict mai mic decât Prețul Maxim ($${config.upperPrice}).`,
      };
    }

    if (config.gridCount < 2 || config.gridCount > 200) {
      return {
        approved: false,
        reason: `Numărul de trepte (${config.gridCount}) trebuie să fie între 2 și 200.`,
      };
    }

    if (config.marginInvestedUSDT < 5) {
      return {
        approved: false,
        reason: `Marginea investită ($${config.marginInvestedUSDT.toFixed(2)}) trebuie să fie de cel puțin $5.00 USDT.`,
      };
    }

    if (config.marginInvestedUSDT > freeBalanceUSDT) {
      return {
        approved: false,
        reason: `Marjă liberă insuficientă: Botul necesită $${config.marginInvestedUSDT.toFixed(2)} USDT, dar disponibilul liber este $${freeBalanceUSDT.toFixed(2)} USDT (Prevenire eroare OKX 51008).`,
      };
    }

    return { approved: true };
  }

  /**
   * Continuously monitors an active Grid Bot against Stop Loss (SL), Take Profit (TP), Range
   * Breakout bounds, and the profit trailing floor (giveback band + optional profit lock).
   *
   * The trailing floor is read FIRST, before the loss stop, and that order is load-bearing: a bot
   * that was once well in profit and has since fallen through the loss stop gave a banked gain
   * back — `grid_hype_mwmnij6v` peaked at +4.7% (+0.94 USD) and was reported as a plain STOP_LOSS
   * at -9.93% (-1.99 USD), which hides the cause. It stays disarmed until the bot has ever reached
   * `profitGivebackArmPct`, so a bot that only lost money can never be stopped by it.
   */
  public static evaluateLiveBotRisk(
    bot: GridBotInstance,
    currentPrice: number
  ): LiveBotRiskAction {
    if (bot.status !== 'RUNNING' || currentPrice <= 0) {
      return { action: 'NONE' };
    }

    const risk = bot.config.risk;
    const margin = Math.max(1, bot.config.marginInvestedUSDT);
    const netPnlPct = (bot.totalNetPnlUSDT / margin) * 100;

    // 1. Profit trailing floor. A disarmed guard (`peakTotalPnlPct` below armPct) always answers
    // triggered=false, so no extra "is this really a winner" check is needed here.
    const trailing = assessProfitTrailingStop({
      peakPct: bot.peakTotalPnlPct,
      currentPct: bot.totalNetPnlPct,
      armPct: risk.profitGivebackArmPct,
      ratio: risk.profitGivebackRatio,
      minBandPct: risk.profitGivebackMinBandPct,
      lockPct: risk.profitLockPct,
    });
    if (trailing.triggered) {
      const peakUSDT = (trailing.peakPct / 100) * margin;
      const basis = trailing.lockBinding
        ? `blocare profit +${trailing.lockFloorPct}%`
        : `banda ${trailing.bandPct.toFixed(2)}pp`;
      return {
        action: 'PROFIT_TRAILING_STOP',
        reason: `Profit dat înapoi: vârf +${trailing.peakPct.toFixed(2)}% ($${peakUSDT.toFixed(2)}), acum ${trailing.currentPct.toFixed(2)}%, prag +${trailing.floorPct.toFixed(2)}% (${basis})`,
      };
    }

    // 2. Check Stop Loss % of Margin Invested
    if (risk.stopLossPct > 0 && netPnlPct <= -Math.abs(risk.stopLossPct)) {
      return {
        action: 'STOP_LOSS',
        reason: `Stop Loss Marjă atins: PnL Net ${netPnlPct.toFixed(2)}% ($${bot.totalNetPnlUSDT.toFixed(2)}) <= -${risk.stopLossPct}%`,
      };
    }

    // 3. Check Take Profit % of Margin Invested
    if (risk.takeProfitPct > 0 && netPnlPct >= Math.abs(risk.takeProfitPct)) {
      return {
        action: 'TAKE_PROFIT',
        reason: `Take Profit Marjă atins: PnL Net +${netPnlPct.toFixed(2)}% (+$${bot.totalNetPnlUSDT.toFixed(2)}) >= +${risk.takeProfitPct}%`,
      };
    }

    // 4. Check Hard Lower / Upper Price Stop Breakout
    if (risk.stopOnRangeBreakout) {
      if (bot.lowerStopPrice > 0 && currentPrice <= bot.lowerStopPrice) {
        return {
          action: 'RANGE_BREAKOUT_STOP',
          reason: `Breakout sub Pragul Stop Inferior: Preț curent $${currentPrice} <= SL Inferior $${bot.lowerStopPrice}`,
        };
      }
      if (bot.upperStopPrice > 0 && currentPrice >= bot.upperStopPrice) {
        return {
          action: 'RANGE_BREAKOUT_STOP',
          reason: `Breakout peste Pragul Stop Superior: Preț curent $${currentPrice} >= SL Superior $${bot.upperStopPrice}`,
        };
      }
    }

    return { action: 'NONE' };
  }
}
