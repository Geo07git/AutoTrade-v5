import {
  GridAnalyzerDecision,
  GridAnalyzerStatusSummary,
  GridAnalyzerStopEvent,
  GridAnalyzerThresholds,
  GridBotAnalysisSnapshot,
  OKXNativeGridBot,
} from '../../../shared/types';
import { getLiveFeeRates } from '../../../shared/fees';
import { OKXAdapter } from '../../exchange/OKXAdapter';
import { JsonStore } from '../../store';
import { GridJournal } from './GridJournal';
import { NeutralGridAnalyzer } from './NeutralGridAnalyzer';
import { OKXNativeGridEngine } from './OKXNativeGridEngine';

export const DEFAULT_GRID_ANALYZER_THRESHOLDS: GridAnalyzerThresholds = {
  adxMonitorThreshold: 25,
  adxMonitorConsecutiveCount: 2,
  adxStopThreshold: 30,
  adxStopConsecutiveCount: 2,
  chopStopThreshold: 38,
  chopStopConsecutiveCount: 2,
  atrSpikeMonitorPct: 50,
  rangeEdgeWarningPct: 10,
  rangeBreakoutBufferPct: 0.15,
  warningDrawdownPct: 5,
  stopDrawdownPct: 8,
  minLiqSafetyPct: 4.0,
  requireMultiIndicatorForTrendStop: true,
  emergencyClosePosition: true,
};

/**
 * 1. GridBotMonitor
 * Reads and reconciles OKX Native Futures Grid Neutral bots against OKX EEA REST endpoints,
 * differentiating true OKX native contract_grid bots from individual Limit orders, and
 * maintaining 30s (status/reconcile) and 1m (price/position/limits/liqPx) cadence state in memory.
 */
export class GridBotMonitor {
  private okxAdapter: OKXAdapter;
  private nativeGridEngine: OKXNativeGridEngine;
  private okxConnectionOk: boolean = true;
  private reconciliationStatus: 'SYNCED' | 'RECONCILING' | 'CONTRADICTORY' | 'DEGRADED' = 'SYNCED';
  private lastReconcileAt: number = 0;

  constructor(okxAdapter: OKXAdapter, nativeGridEngine: OKXNativeGridEngine) {
    this.okxAdapter = okxAdapter;
    this.nativeGridEngine = nativeGridEngine;
  }

  public isNativeOKXBot(bot: OKXNativeGridBot): boolean {
    const id = String(bot.algoId || '').toLowerCase();
    return Boolean(bot.algoId && !id.startsWith('grid') && /^\d+$/.test(id));
  }

  public getConnectionState() {
    return {
      okxConnectionOk: this.okxConnectionOk,
      reconciliationStatus: this.reconciliationStatus,
      lastReconcileAt: this.lastReconcileAt,
    };
  }

  /**
   * 30-second cadence: Reconcile bot state and details with OKX EEA
   */
  public async reconcileWithOKX(): Promise<Map<string, any>> {
    const remoteMap = new Map<string, any>();
    if (!this.okxAdapter.hasCredentials()) {
      this.okxConnectionOk = false;
      this.reconciliationStatus = 'DEGRADED';
      return remoteMap;
    }

    try {
      const [pending, history] = await Promise.all([
        this.okxAdapter.getNativeContractGridBots('pending', false),
        this.okxAdapter.getNativeContractGridBots('history', false),
      ]);

      for (const item of [...pending, ...history.slice(0, 30)]) {
        if (item?.algoId && !remoteMap.has(String(item.algoId))) {
          remoteMap.set(String(item.algoId), item);
        }
      }

      this.okxConnectionOk = true;
      this.reconciliationStatus = 'SYNCED';
      this.lastReconcileAt = Date.now();
    } catch {
      this.okxConnectionOk = false;
      this.reconciliationStatus = 'DEGRADED';
    }

    return remoteMap;
  }

  /**
   * 1-minute cadence: Update live price, position exposure, range edge distance, and liquidation distance
   */
  public async refreshPriceAndRiskMetrics(
    bot: OKXNativeGridBot,
    remoteDetails: any | null,
    snapshot: GridBotAnalysisSnapshot
  ): Promise<void> {
    const now = Date.now();

    if (remoteDetails) {
      const remState = String(remoteDetails.state || 'running').toLowerCase();
      if (remState === 'stopped' || remState === 'no_close_position') {
        bot.state = 'stopped';
        snapshot.state = 'stopped';
        snapshot.reconciliationState = 'CONFIRMED_STOPPED';
      } else if (remState === 'stopping') {
        bot.state = 'stopping';
        snapshot.state = 'stopping';
        snapshot.reconciliationState = 'STOP_PENDING_CONFIRMATION';
      } else {
        bot.state = 'running';
        snapshot.state = 'running';
        snapshot.reconciliationState = 'CONFIRMED_RUNNING';
      }

      bot.gridProfit = parseFloat(remoteDetails.gridProfit || String(bot.gridProfit)) || 0;
      bot.floatProfit = parseFloat(remoteDetails.floatProfit || String(bot.floatProfit)) || 0;
      bot.totalPnl =
        parseFloat(remoteDetails.totalPnl || String(bot.gridProfit + bot.floatProfit)) || 0;
      bot.totalPnlPct =
        bot.sz > 0 ? parseFloat(((bot.totalPnl / bot.sz) * 100).toFixed(2)) : 0;
      bot.liqPx = parseFloat(remoteDetails.liqPx || String(bot.liqPx)) || 0;
      bot.arbitrageNum =
        parseInt(remoteDetails.arbitrageNum || String(bot.arbitrageNum), 10) || bot.arbitrageNum;
      const remPx = parseFloat(remoteDetails.last || remoteDetails.curPx || '0') || 0;
      if (remPx > 0) bot.currentPx = remPx;
    }

    const livePx = (await this.okxAdapter.getTickerPrice(bot.instId)) || bot.currentPx;
    if (livePx && livePx > 0) {
      bot.currentPx = livePx;
    }

    const rangeWidth = Math.max(1e-8, bot.maxPx - bot.minPx);
    const distToLowerLimitPct =
      bot.currentPx > 0
        ? parseFloat((((bot.currentPx - bot.minPx) / rangeWidth) * 100).toFixed(2))
        : 50;
    const distToUpperLimitPct =
      bot.currentPx > 0
        ? parseFloat((((bot.maxPx - bot.currentPx) / rangeWidth) * 100).toFixed(2))
        : 50;
    const minDistToEdgePct = parseFloat(
      Math.min(distToLowerLimitPct, distToUpperLimitPct).toFixed(2)
    );

    const distToLiqPct =
      bot.liqPx > 0 && bot.currentPx > 0
        ? parseFloat(((Math.abs(bot.currentPx - bot.liqPx) / bot.currentPx) * 100).toFixed(2))
        : 100;

    const drawdownPct =
      bot.totalPnlPct < 0 ? parseFloat(Math.abs(bot.totalPnlPct).toFixed(2)) : 0;

    const feeInfo = getLiveFeeRates();
    const roundTripFeeRate = (feeInfo.roundTripMakerFeePct || 0.04) / 100;
    const singleOrderNotional =
      bot.singleAmt > 0 ? bot.singleAmt : (bot.sz * bot.lever) / Math.max(1, bot.gridNum);
    const estimatedFeesUSDT = parseFloat(
      (bot.arbitrageNum * singleOrderNotional * roundTripFeeRate).toFixed(4)
    );
    const uptimeHours = Math.max(0, (now - bot.cTime) / 3_600_000);
    const fundingPeriods = uptimeHours / 8;
    const estimatedFundingCostUSDT = parseFloat(
      (
        Math.abs(snapshot.market.fundingRatePct / 100) *
        (bot.sz * bot.lever * 0.35) *
        fundingPeriods
      ).toFixed(4)
    );
    const netProfitAfterCostsUSDT = parseFloat(
      (bot.totalPnl - estimatedFeesUSDT - estimatedFundingCostUSDT).toFixed(4)
    );

    snapshot.performance = {
      gridProfitUSDT: bot.gridProfit,
      floatProfitUSDT: bot.floatProfit,
      totalPnlUSDT: bot.totalPnl,
      netYieldPct:
        bot.sz > 0 ? parseFloat(((netProfitAfterCostsUSDT / bot.sz) * 100).toFixed(2)) : 0,
      executedGrids: bot.arbitrageNum,
      activeGrids: bot.state === 'running' ? bot.gridNum : 0,
      uptimeSec: Math.max(0, Math.round((now - bot.cTime) / 1000)),
      estimatedFeesUSDT,
      estimatedFundingCostUSDT,
      netProfitAfterCostsUSDT,
    };

    snapshot.risk = {
      distToLowerLimitPct,
      distToUpperLimitPct,
      minDistToEdgePct,
      accumulatedPositionUSD: parseFloat(
        (Math.abs(bot.floatProfit) > 0 ? bot.sz * bot.lever * 0.4 : 0).toFixed(2)
      ),
      marginUsedUSDT: bot.sz,
      liqPx: bot.liqPx,
      distToLiqPct,
      drawdownPct,
      liquidityDegraded:
        snapshot.market.spreadBps > 35 ||
        (snapshot.market.orderBookDepthUSD > 0 && snapshot.market.orderBookDepthUSD < 1500),
    };

    snapshot.cadence.lastPrice1mAt = now;
    snapshot.updatedAt = now;
  }
}

/**
 * 2. GridMarketAnalyzer
 * 5-minute cadence: Computes ADX & trend persistence, Choppiness Index, current ATR vs initial ATR,
 * price direction, 24h volume, spread (bps), Order Book depth/imbalance, and funding rate.
 * Enforces a minimum 4.5-minute spacing between consecutive counter increments so manual or
 * accelerated refreshes never double-count the same 15m candle as "2 consecutive evaluations".
 */
export class GridMarketAnalyzer {
  private okxAdapter: OKXAdapter;
  private lastConsecutiveIncrementAt: Map<string, number> = new Map();

  constructor(okxAdapter: OKXAdapter) {
    this.okxAdapter = okxAdapter;
  }

  public async refreshMarketIndicators(
    bot: OKXNativeGridBot,
    snapshot: GridBotAnalysisSnapshot,
    thresholds: GridAnalyzerThresholds
  ): Promise<void> {
    try {
      const now = Date.now();
      const [baseAnalysis, extras] = await Promise.all([
        NeutralGridAnalyzer.analyzeSymbol(bot.instId, this.okxAdapter),
        this.okxAdapter.fetchMarketIntelligenceExtras(bot.instId),
      ]);

      if (baseAnalysis) {
        const adx = baseAnalysis.adxTrendStrength;
        const chop = baseAnalysis.choppinessIndex;
        const curAtr = baseAnalysis.atrPct;

        if (snapshot.market.initialAtrPct <= 0 && curAtr > 0) {
          snapshot.market.initialAtrPct = curAtr;
        }
        const initAtr = snapshot.market.initialAtrPct || curAtr || 1;
        const atrChangePct = parseFloat((((curAtr - initAtr) / initAtr) * 100).toFixed(2));

        // Only advance consecutive evaluation counters once per real 5-minute window (>= 270s)
        const prevCountAt = this.lastConsecutiveIncrementAt.get(bot.algoId) || 0;
        const canIncrementConsecutive = prevCountAt === 0 || now - prevCountAt >= 270_000;

        let adxConsecutiveAboveMonitor = snapshot.market.adxConsecutiveAboveMonitor;
        let adxConsecutiveAboveStop = snapshot.market.adxConsecutiveAboveStop;
        let chopConsecutiveBelowStop = snapshot.market.chopConsecutiveBelowStop;

        if (canIncrementConsecutive) {
          this.lastConsecutiveIncrementAt.set(bot.algoId, now);
          adxConsecutiveAboveMonitor =
            adx > thresholds.adxMonitorThreshold
              ? snapshot.market.adxConsecutiveAboveMonitor + 1
              : 0;
          adxConsecutiveAboveStop =
            adx > thresholds.adxStopThreshold ? snapshot.market.adxConsecutiveAboveStop + 1 : 0;
          chopConsecutiveBelowStop =
            chop < thresholds.chopStopThreshold ? snapshot.market.chopConsecutiveBelowStop + 1 : 0;
        } else {
          // If an indicator recovers within the window, reset its consecutive counter immediately
          if (adx <= thresholds.adxMonitorThreshold) adxConsecutiveAboveMonitor = 0;
          if (adx <= thresholds.adxStopThreshold) adxConsecutiveAboveStop = 0;
          if (chop >= thresholds.chopStopThreshold) chopConsecutiveBelowStop = 0;
        }

        const priceDirection: 'UP' | 'DOWN' | 'NEUTRAL' =
          baseAnalysis.priceChange24hPct > 1.2
            ? 'UP'
            : baseAnalysis.priceChange24hPct < -1.2
            ? 'DOWN'
            : 'NEUTRAL';

        snapshot.market = {
          adx,
          adxConsecutiveAboveMonitor,
          adxConsecutiveAboveStop,
          trendPersistent:
            adxConsecutiveAboveStop >= thresholds.adxStopConsecutiveCount &&
            adx > thresholds.adxStopThreshold,
          choppinessIndex: chop,
          chopConsecutiveBelowStop,
          initialAtrPct: initAtr,
          currentAtrPct: curAtr,
          atrChangePct,
          priceDirection,
          volume24hUSDT: baseAnalysis.volume24hUSDT,
          spreadBps: extras.spreadBps,
          orderBookDepthUSD: extras.orderBookDepthUSD,
          orderBookImbalance: extras.orderBookImbalance,
          fundingRatePct: extras.fundingRatePct,
        };
      }
      snapshot.cadence.lastMarket5mAt = now;
    } catch {
      // Silent in-memory handling per Section 7 (no telemetry spam on periodic checks)
    }
  }
}

/**
 * 3. GridDecisionEngine
 * Evaluates configurable rules from Section 4 without hardcoded magic numbers:
 * - Immediate evaluation of critical risks (Liquidation proximity, Max Drawdown Stop, Confirmed Range Breakout)
 * - Strict Multi-indicator requirement for non-critical trend stops:
 *   Never stops a bot based on Choppiness < 38 alone when ADX is weak (< adxMonitorThreshold) and Drawdown is 0%!
 *   Near-boundary price (< 10% to limit) with 0% drawdown is a WARNING, not a trend corroborator for STOP.
 */
export class GridDecisionEngine {
  public evaluate(
    bot: OKXNativeGridBot,
    snapshot: GridBotAnalysisSnapshot,
    thresholds: GridAnalyzerThresholds
  ): {
    decision: GridAnalyzerDecision;
    reason: string;
    riskLevel: 'LOW' | 'ELEVATED' | 'WARNING' | 'CRITICAL';
  } {
    // 1. CRITICAL EMERGENCY: LiqPx distance below minimum safety threshold
    if (
      snapshot.risk.liqPx > 0 &&
      snapshot.risk.distToLiqPct > 0 &&
      snapshot.risk.distToLiqPct <= thresholds.minLiqSafetyPct
    ) {
      return {
        decision: 'EMERGENCY',
        reason: `Distanță LiqPx critică (${snapshot.risk.distToLiqPct.toFixed(2)}% <= ${thresholds.minLiqSafetyPct}%)`,
        riskLevel: 'CRITICAL',
      };
    }

    // 2. CRITICAL STOP: Total PnL loss reaches stopDrawdownPct (or bot's configured stopLossPct)
    const effectiveStopDrawdownPct = Math.min(
      thresholds.stopDrawdownPct,
      bot.stopLossPct > 0 ? bot.stopLossPct : thresholds.stopDrawdownPct
    );
    if (snapshot.risk.drawdownPct >= effectiveStopDrawdownPct) {
      return {
        decision: 'STOP',
        reason: `Drawdown Total PnL (-${snapshot.risk.drawdownPct.toFixed(2)}%) a depășit pragul STOP (-${effectiveStopDrawdownPct}%)`,
        riskLevel: 'CRITICAL',
      };
    }

    // 3. CRITICAL STOP: Confirmed Range Breakout outside [minPx, maxPx] (with anti-wick buffer) when stopOnRangeBreakout is active
    if (bot.stopOnRangeBreakout && bot.currentPx > 0 && bot.minPx > 0 && bot.maxPx > bot.minPx) {
      const bufferPct =
        typeof thresholds.rangeBreakoutBufferPct === 'number' && thresholds.rangeBreakoutBufferPct >= 0
          ? thresholds.rangeBreakoutBufferPct
          : 0.15;
      const lowerBreakPx =
        bot.slTriggerPx && bot.slTriggerPx > 0 && bot.slTriggerPx < bot.minPx
          ? Math.max(bot.slTriggerPx, bot.minPx * (1 - bufferPct / 100))
          : bot.minPx * (1 - bufferPct / 100);
      const upperBreakPx =
        bot.tpTriggerPx && bot.tpTriggerPx > bot.maxPx
          ? Math.min(bot.tpTriggerPx, bot.maxPx * (1 + bufferPct / 100))
          : bot.maxPx * (1 + bufferPct / 100);

      if (bot.currentPx < lowerBreakPx || bot.currentPx > upperBreakPx) {
        return {
          decision: 'STOP',
          reason: `Range Breakout confirmat: Preț curent ($${bot.currentPx}) a depășit intervalul grilei [$${bot.minPx} – $${bot.maxPx}] (peste bufferul de ${bufferPct}%)`,
          riskLevel: 'CRITICAL',
        };
      }

      if (bot.currentPx < bot.minPx || bot.currentPx > bot.maxPx) {
        return {
          decision: 'WARNING',
          reason: `Preț curent ($${bot.currentPx}) la limita grilei [$${bot.minPx} – $${bot.maxPx}] — monitorizare în interiorul bufferului anti-wick (${bufferPct}%)`,
          riskLevel: 'WARNING',
        };
      }
    }

    // 4. TREND / CHOPPINESS STOP (Strict multi-indicator corroboration per Section 4)
    const adxStopTriggered =
      snapshot.market.adx > thresholds.adxStopThreshold &&
      snapshot.market.adxConsecutiveAboveStop >= thresholds.adxStopConsecutiveCount;
    const chopStopTriggered =
      snapshot.market.choppinessIndex > 0 &&
      snapshot.market.choppinessIndex < thresholds.chopStopThreshold &&
      snapshot.market.chopConsecutiveBelowStop >= thresholds.chopStopConsecutiveCount;

    // A genuine trend requires ADX at least above adxMonitorThreshold (25); if ADX is 6.0 (like PUMP-USD),
    // the market has no directional trend at all regardless of Choppiness.
    const hasDirectionalAdxSupport = snapshot.market.adx >= thresholds.adxMonitorThreshold;
    const hasVolatilityOrLossStress =
      snapshot.market.atrChangePct > thresholds.atrSpikeMonitorPct ||
      snapshot.risk.drawdownPct >= thresholds.warningDrawdownPct;

    // Case 4A: Both primary trend indicators confirm persistent directional trend (ADX > 30 x2 AND Chop < 38 x2)
    if (adxStopTriggered && chopStopTriggered) {
      return {
        decision: 'STOP',
        reason: `Trend direcțional persistent confirmat multi-indicator: ADX ${snapshot.market.adx.toFixed(1)} (>${thresholds.adxStopThreshold} la ${snapshot.market.adxConsecutiveAboveStop} eval.) + Choppiness ${snapshot.market.choppinessIndex.toFixed(1)} (<${thresholds.chopStopThreshold} la ${snapshot.market.chopConsecutiveBelowStop} eval.)`,
        riskLevel: 'CRITICAL',
      };
    }

    // Case 4B: Single trend indicator + explicit Volatility Spike (>50% ATR) or Warning Drawdown (>=5% loss),
    // AND directional ADX support (ADX >= 25) so low Choppiness with ADX=6 and 0% drawdown NEVER triggers STOP!
    if (
      thresholds.requireMultiIndicatorForTrendStop &&
      ((adxStopTriggered && hasVolatilityOrLossStress) ||
        (chopStopTriggered && hasDirectionalAdxSupport && hasVolatilityOrLossStress))
    ) {
      return {
        decision: 'STOP',
        reason: `Invalidare regim Neutral confirmată multi-indicator: ADX ${snapshot.market.adx.toFixed(1)}, Chop ${snapshot.market.choppinessIndex.toFixed(1)}, ATR Δ +${snapshot.market.atrChangePct.toFixed(1)}%, Drawdown -${snapshot.risk.drawdownPct.toFixed(2)}%`,
        riskLevel: 'CRITICAL',
      };
    }

    // Case 4C: Only if user explicitly disabled requireMultiIndicatorForTrendStop in settings
    if (
      !thresholds.requireMultiIndicatorForTrendStop &&
      (adxStopTriggered || (chopStopTriggered && hasDirectionalAdxSupport))
    ) {
      return {
        decision: 'STOP',
        reason: adxStopTriggered
          ? `ADX persistent peste prag (${snapshot.market.adx.toFixed(1)} > ${thresholds.adxStopThreshold})`
          : `Choppiness persistent sub prag (${snapshot.market.choppinessIndex.toFixed(1)} < ${thresholds.chopStopThreshold}) cu ADX ${snapshot.market.adx.toFixed(1)}`,
        riskLevel: 'CRITICAL',
      };
    }

    // 5. WARNING CONDITIONS (Section 4):
    // - Total PnL loss >= warningDrawdownPct (5%)
    // - Price < rangeEdgeWarningPct (10%) from range boundary
    if (snapshot.risk.drawdownPct >= thresholds.warningDrawdownPct) {
      return {
        decision: 'WARNING',
        reason: `Pierdere Total PnL (-${snapshot.risk.drawdownPct.toFixed(2)}%) peste pragul de avertizare (-${thresholds.warningDrawdownPct}%)`,
        riskLevel: 'WARNING',
      };
    }

    if (
      snapshot.risk.minDistToEdgePct >= 0 &&
      snapshot.risk.minDistToEdgePct < thresholds.rangeEdgeWarningPct
    ) {
      return {
        decision: 'WARNING',
        reason: `Preț la ${snapshot.risk.minDistToEdgePct.toFixed(1)}% de limita intervalului (<${thresholds.rangeEdgeWarningPct}%) • ADX ${snapshot.market.adx.toFixed(1)} / Chop ${snapshot.market.choppinessIndex.toFixed(1)} (fără condiții de STOP)`,
        riskLevel: 'WARNING',
      };
    }

    // 6. MONITOR CONDITIONS (Section 4):
    // - ADX > 25 for 2 consecutive evaluations
    // - ATR increase > 50% vs initial ATR
    // - Single-indicator trend alert (e.g. Chop < 38 with low ADX or ADX > 30 without secondary confirmation)
    if (snapshot.market.adxConsecutiveAboveMonitor >= thresholds.adxMonitorConsecutiveCount) {
      return {
        decision: 'MONITOR',
        reason: `ADX (${snapshot.market.adx.toFixed(1)}) > ${thresholds.adxMonitorThreshold} la ${snapshot.market.adxConsecutiveAboveMonitor} evaluări consecutive`,
        riskLevel: 'ELEVATED',
      };
    }

    if (snapshot.market.atrChangePct > thresholds.atrSpikeMonitorPct) {
      return {
        decision: 'MONITOR',
        reason: `Expansiune volatilitate ATR (+${snapshot.market.atrChangePct.toFixed(1)}% față de ATR inițial > +${thresholds.atrSpikeMonitorPct}%)`,
        riskLevel: 'ELEVATED',
      };
    }

    if (adxStopTriggered || chopStopTriggered || snapshot.market.choppinessIndex < thresholds.chopStopThreshold) {
      return {
        decision: 'MONITOR',
        reason: `Choppiness ${snapshot.market.choppinessIndex.toFixed(1)} (<${thresholds.chopStopThreshold}), dar ADX ${snapshot.market.adx.toFixed(1)} și Drawdown -${snapshot.risk.drawdownPct.toFixed(2)}% nu justifică oprirea — monitorizare activă`,
        riskLevel: 'ELEVATED',
      };
    }

    // 7. CONTINUE: Net profit positive after real costs or normal neutral range operation
    const netAfterCosts = snapshot.performance.netProfitAfterCostsUSDT;
    return {
      decision: 'CONTINUE',
      reason:
        netAfterCosts > 0
          ? `Profit net pozitiv după costuri (+$${netAfterCosts.toFixed(3)}) • Regim Neutral stabil`
          : `Operare normală în interval (${snapshot.risk.minDistToEdgePct.toFixed(1)}% față de limite)`,
      riskLevel: 'LOW',
    };
  }
}

/**
 * 4. GridBotSupervisor
 * Executes autonomous STOP / EMERGENCY decisions on OKX EEA:
 * - Treats STOP (stop-order-algo) and CLOSE POSITION (close-position) as distinct operations.
 * - Differentiates explicitly:
 *   - HTTP_SUCCESS
 *   - STOP_PENDING_CONFIRMATION
 *   - CONFIRMED_STOPPED
 *   - CLOSE_POSITION_CONFIRMED
 * - Polls OKX reconciliation after STOP and re-verifies any pending stop events on every 30s cycle.
 */
export class GridBotSupervisor {
  private okxAdapter: OKXAdapter;
  private journal: GridJournal;
  private eventsStore: JsonStore<GridAnalyzerStopEvent[]>;
  private recordedIdempotencyKeys: Set<string> = new Set();

  constructor(okxAdapter: OKXAdapter, journal: GridJournal) {
    this.okxAdapter = okxAdapter;
    this.journal = journal;
    this.eventsStore = new JsonStore<GridAnalyzerStopEvent[]>('grid_analyzer_events.json', []);
    const rawEvents = this.eventsStore.get() || [];
    let migrated = false;
    for (const ev of rawEvents) {
      if (ev?.idempotencyKey) {
        this.recordedIdempotencyKeys.add(ev.idempotencyKey);
      }
      // Normalize any legacy stopType or unconfirmed states in persisted events
      if (ev && ev.stopType !== '1' && ev.stopType !== '2') {
        ev.stopType = '1';
        migrated = true;
      }
      if (ev && !ev.okxFinalStateConfirmed && ev.closePositionResult === 'SUCCESS') {
        ev.closePositionResult = 'STOP_PENDING_CONFIRMATION';
        ev.stopResult = 'STOP_PENDING_CONFIRMATION';
        ev.stopHttpStatus = 'HTTP_SUCCESS';
        migrated = true;
      }
    }
    if (migrated) {
      this.eventsStore.save(rawEvents);
    }
  }

  public getStopEvents(): GridAnalyzerStopEvent[] {
    return this.eventsStore.get() || [];
  }

  /**
   * Verifies on OKX whether a bot is truly stopped and whether any position on its instId is closed.
   */
  private async verifyBotAndPositionStoppedOnOKX(
    algoId: string,
    instId: string,
    closePositionRequested: boolean
  ): Promise<{
    botConfirmedStopped: boolean;
    okxStateLabel: string;
    positionConfirmedClosed: boolean;
  }> {
    let botConfirmedStopped = false;
    let okxStateLabel = 'STOP_PENDING_CONFIRMATION';
    let positionConfirmedClosed = !closePositionRequested;

    try {
      const details = await this.okxAdapter.getNativeContractGridDetails(algoId, false);
      if (details) {
        const remState = String(details.state || '').toLowerCase();
        if (remState === 'stopped') {
          botConfirmedStopped = true;
          okxStateLabel = 'CONFIRMED_STOPPED';
        } else if (remState === 'no_close_position') {
          botConfirmedStopped = true;
          okxStateLabel = 'CONFIRMED_STOPPED (no_close_position)';
        } else if (remState === 'stopping') {
          botConfirmedStopped = false;
          okxStateLabel = 'STOP_PENDING_CONFIRMATION (OKX: stopping)';
        } else {
          okxStateLabel = `PENDING (${remState || 'running'})`;
        }
      } else {
        const history = await this.okxAdapter.getNativeContractGridBots('history', false);
        const foundInHist = history.find((h: any) => String(h?.algoId) === String(algoId));
        if (foundInHist) {
          botConfirmedStopped = true;
          okxStateLabel = 'CONFIRMED_STOPPED';
        }
      }

      if (closePositionRequested && botConfirmedStopped) {
        const openPositions = await this.okxAdapter.getOpenPositions().catch(() => []);
        const normTarget = this.okxAdapter.normalizeSymbol
          ? this.okxAdapter.normalizeSymbol(instId)
          : instId;
        const hasOpenPos = openPositions.some((p) => {
          const normP = this.okxAdapter.normalizeSymbol
            ? this.okxAdapter.normalizeSymbol(p.symbol)
            : p.symbol;
          return (normP === normTarget || p.symbol === instId) && Math.abs(Number(p.size) || 0) > 0;
        });
        positionConfirmedClosed = !hasOpenPos;
      }
    } catch {
      okxStateLabel = 'API_UNREACHABLE';
    }

    return {
      botConfirmedStopped,
      okxStateLabel,
      positionConfirmedClosed,
    };
  }

  /**
   * Reconciles any previously logged stop events that were in STOP_PENDING_CONFIRMATION
   * (e.g. when OKX was still in transient `stopping` state during the initial stop call).
   */
  public async reconcilePendingStopEvents(remoteMap: Map<string, any>): Promise<void> {
    const events = this.eventsStore.get() || [];
    let updated = false;

    for (const ev of events) {
      if (
        !ev.okxFinalStateConfirmed ||
        ev.stopResult === 'STOP_PENDING_CONFIRMATION' ||
        ev.stopResult === 'PENDING_CONFIRMATION' ||
        (ev.closePositionRequested &&
          ev.closePositionResult !== 'CLOSE_POSITION_CONFIRMED' &&
          ev.closePositionResult !== 'NOT_REQUESTED')
      ) {
        const rem = remoteMap.get(String(ev.algoId));
        const remState = String(rem?.state || '').toLowerCase();

        if (remState === 'stopped' || remState === 'no_close_position' || !rem) {
          const check = await this.verifyBotAndPositionStoppedOnOKX(
            ev.algoId,
            ev.instId,
            ev.closePositionRequested
          );
          if (check.botConfirmedStopped) {
            ev.okxFinalStateConfirmed = true;
            ev.okxConfirmedState = check.okxStateLabel;
            ev.stopResult = 'CONFIRMED_STOPPED';
            if (ev.eventType === 'OPERATIONAL_ERROR') {
              ev.eventType = ev.executedDecision === 'EMERGENCY' ? 'EMERGENCY' : 'STOP';
            }
            if (ev.closePositionRequested) {
              ev.closePositionResult = check.positionConfirmedClosed
                ? 'CLOSE_POSITION_CONFIRMED'
                : 'STOP_PENDING_CONFIRMATION';
            }
            updated = true;
          }
        }
      }
    }

    if (updated) {
      this.eventsStore.save(events);
    }
  }

  public async executeDecision(
    bot: OKXNativeGridBot,
    snapshot: GridBotAnalysisSnapshot,
    thresholds: GridAnalyzerThresholds,
    isNativeOKXBot: boolean
  ): Promise<void> {
    // Rule 3 & 7: Never send orders or log telemetry for CONTINUE, MONITOR, or WARNING
    if (
      snapshot.decision === 'CONTINUE' ||
      snapshot.decision === 'MONITOR' ||
      snapshot.decision === 'WARNING' ||
      snapshot.decision === 'ADJUST'
    ) {
      return;
    }

    // Rule 10: Do not use individual order fallbacks to administer native OKX bots
    if (!isNativeOKXBot) {
      return;
    }

    const cycleKey = `${bot.algoId}:${bot.cTime}:${snapshot.decision}`;
    if (this.recordedIdempotencyKeys.has(cycleKey)) {
      return;
    }

    const isEmergency = snapshot.decision === 'EMERGENCY';
    const stopType: '1' | '2' =
      isEmergency && thresholds.emergencyClosePosition
        ? '1'
        : bot.stopTypeOnRisk === '2'
        ? '2'
        : '1';
    const closePositionRequested = stopType === '1';

    let stopHttpOk = false;
    let operationalErrorMsg = '';

    // Step 1: Execute STOP on OKX (/api/v5/tradingBot/grid/stop-order-algo)
    try {
      stopHttpOk = await this.okxAdapter.stopNativeContractGrid({
        algoId: bot.algoId,
        instId: bot.instId,
        stopType,
        isDemo: false,
      });
    } catch (stopErr: any) {
      operationalErrorMsg = stopErr?.message || 'stop-order-algo error';
    }

    // Step 2: Distinct CLOSE POSITION action (/api/v5/tradingBot/grid/close-position) if stop-order-algo failed
    if (closePositionRequested && !stopHttpOk) {
      try {
        const closed = await this.okxAdapter.closeNativeContractGridPosition({
          algoId: bot.algoId,
          mktClose: true,
          isDemo: false,
        });
        if (closed) {
          stopHttpOk = true;
        }
      } catch (closeErr: any) {
        operationalErrorMsg =
          operationalErrorMsg || closeErr?.message || 'close-position error';
      }
    }

    // Step 3: Mandatory Final State Confirmation on OKX via controlled reconciliation polling (Section 5)
    // OKX transitions through `stopping` for ~1-4 seconds before reaching `stopped` and settling the position close.
    let okxFinalStateConfirmed = false;
    let okxConfirmedState = stopHttpOk ? 'STOP_PENDING_CONFIRMATION' : 'FAILED';
    let positionConfirmedClosed = !closePositionRequested;

    const maxVerifyAttempts = stopHttpOk ? 4 : 1;
    for (let attempt = 0; attempt < maxVerifyAttempts; attempt++) {
      if (attempt > 0 || stopHttpOk) {
        await new Promise((r) => setTimeout(r, 1200));
      }
      const check = await this.verifyBotAndPositionStoppedOnOKX(
        bot.algoId,
        bot.instId,
        closePositionRequested
      );
      okxConfirmedState = check.okxStateLabel;
      if (check.botConfirmedStopped) {
        okxFinalStateConfirmed = true;
        positionConfirmedClosed = check.positionConfirmedClosed;
        // If position close was requested and bot is stopped but position not yet settled, retry once more
        if (!closePositionRequested || positionConfirmedClosed || attempt === maxVerifyAttempts - 1) {
          break;
        }
      }
    }

    // If bot stopped with no_close_position despite stopType='1', invoke explicit close-position endpoint
    if (okxFinalStateConfirmed && closePositionRequested && !positionConfirmedClosed) {
      try {
        const closedExplicit = await this.okxAdapter.closeNativeContractGridPosition({
          algoId: bot.algoId,
          mktClose: true,
          isDemo: false,
        });
        if (closedExplicit) {
          await new Promise((r) => setTimeout(r, 1000));
          const recheck = await this.verifyBotAndPositionStoppedOnOKX(bot.algoId, bot.instId, true);
          positionConfirmedClosed = recheck.positionConfirmedClosed;
        }
      } catch {}
    }

    const stopHttpStatus: 'HTTP_SUCCESS' | 'FAILED' = stopHttpOk ? 'HTTP_SUCCESS' : 'FAILED';
    const stopResult: GridAnalyzerStopEvent['stopResult'] = okxFinalStateConfirmed
      ? 'CONFIRMED_STOPPED'
      : stopHttpOk
      ? 'STOP_PENDING_CONFIRMATION'
      : 'FAILED';
    const closePosResult: GridAnalyzerStopEvent['closePositionResult'] = !closePositionRequested
      ? 'NOT_REQUESTED'
      : okxFinalStateConfirmed && positionConfirmedClosed
      ? 'CLOSE_POSITION_CONFIRMED'
      : stopHttpOk
      ? 'STOP_PENDING_CONFIRMATION'
      : 'FAILED';

    if (okxFinalStateConfirmed) {
      bot.state = 'stopped';
      bot.stopReason = `[GridBotAnalyzer ${snapshot.decision}] ${snapshot.decisionReason}`;
      bot.uTime = Date.now();
      snapshot.state = 'stopped';
      snapshot.reconciliationState = 'CONFIRMED_STOPPED';
      snapshot.lastStopReason = bot.stopReason;
    } else {
      // Do NOT declare the bot stopped until confirmed by OKX real state!
      bot.state = stopHttpOk ? 'stopping' : bot.state;
      snapshot.state = stopHttpOk ? 'stopping' : snapshot.state;
      snapshot.reconciliationState = stopHttpOk ? 'STOP_PENDING_CONFIRMATION' : 'CONTRADICTORY';
    }

    // Step 4: Record a single complete idempotent event (Section 7)
    const eventKey = okxFinalStateConfirmed ? cycleKey : `${cycleKey}:PENDING`;
    if (this.recordedIdempotencyKeys.has(eventKey)) {
      return;
    }
    this.recordedIdempotencyKeys.add(eventKey);
    if (okxFinalStateConfirmed) {
      this.recordedIdempotencyKeys.add(cycleKey);
    }

    const stopEvent: GridAnalyzerStopEvent = {
      idempotencyKey: eventKey,
      timestamp: Date.now(),
      algoId: String(bot.algoId),
      instId: String(bot.instId),
      eventType: okxFinalStateConfirmed
        ? isEmergency
          ? 'EMERGENCY'
          : 'STOP'
        : 'OPERATIONAL_ERROR',
      exactStopReason:
        snapshot.decisionReason +
        (operationalErrorMsg && !okxFinalStateConfirmed ? ` | API: ${operationalErrorMsg}` : ''),
      triggeringIndicators: {
        adx: snapshot.market.adx,
        choppinessIndex: snapshot.market.choppinessIndex,
        initialAtrPct: snapshot.market.initialAtrPct,
        currentAtrPct: snapshot.market.currentAtrPct,
        atrChangePct: snapshot.market.atrChangePct,
        spreadBps: snapshot.market.spreadBps,
        orderBookDepthUSD: snapshot.market.orderBookDepthUSD,
        fundingRatePct: snapshot.market.fundingRatePct,
        priceDirection: snapshot.market.priceDirection,
      },
      botParameters: {
        minPx: bot.minPx,
        maxPx: bot.maxPx,
        gridNum: bot.gridNum,
        runType: bot.runType,
        lever: bot.lever,
        sz: bot.sz,
        slTriggerPx: bot.slTriggerPx,
        tpTriggerPx: bot.tpTriggerPx,
        currentPx: bot.currentPx,
      },
      pnlBreakdown: {
        gridProfitUSDT: snapshot.performance.gridProfitUSDT,
        floatProfitUSDT: snapshot.performance.floatProfitUSDT,
        totalPnlUSDT: snapshot.performance.totalPnlUSDT,
        netYieldPct: snapshot.performance.netYieldPct,
      },
      feesAndFunding: {
        estimatedFeesUSDT: snapshot.performance.estimatedFeesUSDT,
        fundingCostUSDT: snapshot.performance.estimatedFundingCostUSDT,
        netProfitAfterCostsUSDT: snapshot.performance.netProfitAfterCostsUSDT,
      },
      riskMetrics: {
        drawdownPct: snapshot.risk.drawdownPct,
        distToLiqPct: snapshot.risk.distToLiqPct,
        liqPx: snapshot.risk.liqPx,
        minDistToEdgePct: snapshot.risk.minDistToEdgePct,
      },
      executedDecision: snapshot.decision,
      stopType,
      stopHttpStatus,
      stopResult,
      okxFinalStateConfirmed,
      okxConfirmedState,
      closePositionRequested,
      closePositionResult: closePosResult,
    };

    const existingEvents = this.eventsStore.get() || [];
    this.eventsStore.save([stopEvent, ...existingEvents].slice(0, 100));

    this.journal.logAudit(
      isEmergency ? 'GRID_RISK_TRIGGERED' : 'GRID_STOPPED',
      `[GRID BOT ANALYZER ${stopEvent.eventType}] ${bot.instId} (algoId: ${bot.algoId}) | Decizie: ${snapshot.decision} | Motiv: ${stopEvent.exactStopReason} | PnL Total: $${stopEvent.pnlBreakdown.totalPnlUSDT.toFixed(3)} (Grid: $${stopEvent.pnlBreakdown.gridProfitUSDT.toFixed(3)}, Float: $${stopEvent.pnlBreakdown.floatProfitUSDT.toFixed(3)}) | stopType: ${stopType} | HTTP: ${stopHttpStatus} | Stop: ${stopResult} | ClosePos: ${closePosResult}`,
      stopEvent
    );
  }
}

/**
 * Main Orchestrator: GridBotAnalyzer
 * Coordinates 30s, 1m, 5m, and 15m cadences in memory and exposes status & configurable thresholds.
 */
export class GridBotAnalyzer {
  private okxAdapter: OKXAdapter;
  private journal: GridJournal;
  private gridEngine: OKXNativeGridEngine;
  private thresholdsStore: JsonStore<GridAnalyzerThresholds>;

  private monitor: GridBotMonitor;
  private marketAnalyzer: GridMarketAnalyzer;
  private decisionEngine: GridDecisionEngine;
  private supervisor: GridBotSupervisor;

  private snapshots: Map<string, GridBotAnalysisSnapshot> = new Map();
  private isAnalyzing: boolean = false;

  constructor(okxAdapter: OKXAdapter, journal: GridJournal, gridEngine: OKXNativeGridEngine) {
    this.okxAdapter = okxAdapter;
    this.journal = journal;
    this.gridEngine = gridEngine;
    this.thresholdsStore = new JsonStore<GridAnalyzerThresholds>(
      'grid_analyzer_thresholds.json',
      DEFAULT_GRID_ANALYZER_THRESHOLDS
    );

    this.monitor = new GridBotMonitor(okxAdapter, gridEngine);
    this.marketAnalyzer = new GridMarketAnalyzer(okxAdapter);
    this.decisionEngine = new GridDecisionEngine();
    this.supervisor = new GridBotSupervisor(okxAdapter, journal);
  }

  public getThresholds(): GridAnalyzerThresholds {
    return {
      ...DEFAULT_GRID_ANALYZER_THRESHOLDS,
      ...(this.thresholdsStore.get() || {}),
    };
  }

  public updateThresholds(updates: Partial<GridAnalyzerThresholds>): GridAnalyzerThresholds {
    const current = this.getThresholds();
    const next: GridAnalyzerThresholds = {
      ...current,
      ...updates,
    };
    this.thresholdsStore.save(next);
    return next;
  }

  private getOrCreateSnapshot(bot: OKXNativeGridBot): GridBotAnalysisSnapshot {
    const existing = this.snapshots.get(bot.algoId);
    if (existing) {
      existing.state = bot.state;
      if (bot.stopReason) existing.lastStopReason = bot.stopReason;
      return existing;
    }

    const isNative = this.monitor.isNativeOKXBot(bot);
    const created: GridBotAnalysisSnapshot = {
      algoId: bot.algoId,
      instId: bot.instId,
      isNativeOKXBot: isNative,
      managedByTB5: true,
      state: bot.state,
      decision: 'CONTINUE',
      decisionReason:
        bot.state === 'running'
          ? 'Monitorizare activă în memorie'
          : bot.stopReason || 'Bot oprit pe OKX',
      riskLevel: 'LOW',
      reconciliationState:
        bot.state === 'running'
          ? 'CONFIRMED_RUNNING'
          : bot.state === 'stopping'
          ? 'STOP_PENDING_CONFIRMATION'
          : 'CONFIRMED_STOPPED',
      market: {
        adx: 20,
        adxConsecutiveAboveMonitor: 0,
        adxConsecutiveAboveStop: 0,
        trendPersistent: false,
        choppinessIndex: 52,
        chopConsecutiveBelowStop: 0,
        initialAtrPct: 0,
        currentAtrPct: 0,
        atrChangePct: 0,
        priceDirection: 'NEUTRAL',
        volume24hUSDT: 0,
        spreadBps: 0,
        orderBookDepthUSD: 0,
        orderBookImbalance: 0,
        fundingRatePct: 0,
      },
      performance: {
        gridProfitUSDT: bot.gridProfit,
        floatProfitUSDT: bot.floatProfit,
        totalPnlUSDT: bot.totalPnl,
        netYieldPct: bot.totalPnlPct,
        executedGrids: bot.arbitrageNum,
        activeGrids: bot.state === 'running' ? bot.gridNum : 0,
        uptimeSec: Math.max(0, Math.round((Date.now() - bot.cTime) / 1000)),
        estimatedFeesUSDT: 0,
        estimatedFundingCostUSDT: 0,
        netProfitAfterCostsUSDT: bot.totalPnl,
      },
      risk: {
        distToLowerLimitPct: 50,
        distToUpperLimitPct: 50,
        minDistToEdgePct: 50,
        accumulatedPositionUSD: 0,
        marginUsedUSDT: bot.sz,
        liqPx: bot.liqPx,
        distToLiqPct: 100,
        drawdownPct: bot.totalPnlPct < 0 ? Math.abs(bot.totalPnlPct) : 0,
        liquidityDegraded: false,
      },
      cadence: {
        lastReconcile30sAt: 0,
        lastPrice1mAt: 0,
        lastMarket5mAt: 0,
        lastFullEval15mAt: 0,
      },
      lastStopReason: bot.stopReason,
      updatedAt: Date.now(),
    };

    this.snapshots.set(bot.algoId, created);
    return created;
  }

  /**
   * Periodic execution loop (called every ~30s by TradeBot; respects 30s / 1m / 5m / 15m cadences per bot
   * and evaluates critical risks immediately on every cycle).
   */
  public async analyzeAll(forceFullEvaluation: boolean = false): Promise<GridAnalyzerStatusSummary> {
    if (this.isAnalyzing) return this.getStatusSummary();
    this.isAnalyzing = true;

    try {
      const now = Date.now();
      const thresholds = this.getThresholds();
      const allBots = this.gridEngine.getAllBots();

      // 30s Cadence: Reconcile native bots and any pending stop events with OKX EEA
      const remoteMap = await this.monitor.reconcileWithOKX();
      await this.supervisor.reconcilePendingStopEvents(remoteMap);

      for (const bot of allBots) {
        const snapshot = this.getOrCreateSnapshot(bot);
        snapshot.cadence.lastReconcile30sAt = now;

        const remoteDetails = remoteMap.get(bot.algoId) || null;
        if (remoteDetails) {
          const remState = String(remoteDetails.state || '').toLowerCase();
          if (remState === 'stopped' || remState === 'no_close_position') {
            bot.state = 'stopped';
            snapshot.state = 'stopped';
            snapshot.reconciliationState = 'CONFIRMED_STOPPED';
          } else if (remState === 'stopping') {
            bot.state = 'stopping';
            snapshot.state = 'stopping';
            snapshot.reconciliationState = 'STOP_PENDING_CONFIRMATION';
          }
        }

        if (bot.state === 'stopped') {
          snapshot.state = 'stopped';
          snapshot.reconciliationState = 'CONFIRMED_STOPPED';
          if (bot.stopReason) snapshot.lastStopReason = bot.stopReason;
          continue;
        }

        if (bot.state === 'stopping') {
          snapshot.state = 'stopping';
          snapshot.reconciliationState = 'STOP_PENDING_CONFIRMATION';
          continue;
        }

        const isAcceleratedMonitor =
          snapshot.decision === 'MONITOR' || snapshot.decision === 'WARNING';

        // 1m Cadence (or 30s when in MONITOR/WARNING or force): Price, position, range limits, liqPx
        const duePrice1m =
          forceFullEvaluation ||
          isAcceleratedMonitor ||
          now - snapshot.cadence.lastPrice1mAt >= 55_000;
        if (duePrice1m) {
          await this.monitor.refreshPriceAndRiskMetrics(bot, remoteDetails, snapshot);
        }

        // 5m Cadence (or 2m when in MONITOR/WARNING or first run): ADX, Choppiness, ATR, Volume, Spread, Funding
        const marketIntervalMs = isAcceleratedMonitor ? 120_000 : 290_000;
        const dueMarket5m =
          forceFullEvaluation ||
          snapshot.cadence.lastMarket5mAt === 0 ||
          now - snapshot.cadence.lastMarket5mAt >= marketIntervalMs;
        if (dueMarket5m) {
          await this.marketAnalyzer.refreshMarketIndicators(bot, snapshot, thresholds);
        }

        // Immediate Critical Risk Evaluation on every cycle + 15m Full Re-evaluation
        const evalRes = this.decisionEngine.evaluate(bot, snapshot, thresholds);
        const isCritical =
          evalRes.decision === 'EMERGENCY' ||
          evalRes.decision === 'STOP' ||
          evalRes.riskLevel === 'CRITICAL';
        const dueFull15m =
          forceFullEvaluation ||
          snapshot.cadence.lastFullEval15mAt === 0 ||
          now - snapshot.cadence.lastFullEval15mAt >= 890_000;

        if (isCritical || dueFull15m || dueMarket5m || duePrice1m) {
          snapshot.decision = evalRes.decision;
          snapshot.decisionReason = evalRes.reason;
          snapshot.riskLevel = evalRes.riskLevel;
          if (dueFull15m) {
            snapshot.cadence.lastFullEval15mAt = now;
          }
        }

        // Execute autonomous supervision if STOP or EMERGENCY is triggered
        if (snapshot.decision === 'STOP' || snapshot.decision === 'EMERGENCY') {
          await this.supervisor.executeDecision(
            bot,
            snapshot,
            thresholds,
            snapshot.isNativeOKXBot
          );
        }
      }

      return this.getStatusSummary();
    } finally {
      this.isAnalyzing = false;
    }
  }

  public getStatusSummary(): GridAnalyzerStatusSummary {
    const allBots = this.gridEngine.getAllBots();
    const snapshots: GridBotAnalysisSnapshot[] = allBots.map((b) =>
      this.getOrCreateSnapshot(b)
    );

    const activeCount = allBots.filter((b) => b.state === 'running').length;
    const stoppedCount = allBots.length - activeCount;
    const totalPnlUSDT = parseFloat(
      allBots.reduce((acc, b) => acc + (b.totalPnl || 0), 0).toFixed(3)
    );

    let overallRiskLevel: 'LOW' | 'ELEVATED' | 'WARNING' | 'CRITICAL' = 'LOW';
    for (const s of snapshots) {
      if (s.state !== 'running') continue;
      if (s.riskLevel === 'CRITICAL') {
        overallRiskLevel = 'CRITICAL';
        break;
      }
      if (s.riskLevel === 'WARNING') {
        overallRiskLevel = 'WARNING';
      } else if (s.riskLevel === 'ELEVATED' && overallRiskLevel === 'LOW') {
        overallRiskLevel = 'ELEVATED';
      }
    }

    const conn = this.monitor.getConnectionState();

    return {
      monitoredBotsCount: allBots.length,
      activeNativeBotsCount: activeCount,
      stoppedNativeBotsCount: stoppedCount,
      totalPnlUSDT,
      overallRiskLevel,
      okxConnectionOk: conn.okxConnectionOk,
      reconciliationStatus: conn.reconciliationStatus,
      lastReconcileAt: conn.lastReconcileAt,
      thresholds: this.getThresholds(),
      botSnapshots: snapshots,
      stopEvents: this.supervisor.getStopEvents(),
    };
  }
}
