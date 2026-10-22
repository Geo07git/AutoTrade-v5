import fs from 'fs';
import path from 'path';
import {
  SymbolTradeRecord,
  SymbolRollingStats,
  SymbolStatsSummary,
  SymbolConfidenceStatus,
  OrderRecord,
  Position,
} from '../../shared/types';
import { reconcileHistoricalOrderPrecision } from '../order/orderPrecisionReconciliation';

interface PersistedSymbolStatsData {
  tradesBySymbol: Record<string, SymbolTradeRecord[]>;
  multiplierActive: boolean;
  lastUpdated: number;
}

export class SymbolStatsTracker {
  private filePath: string;
  private maxRollingWindow: number = 30; // Rolling last 30 trades per symbol
  private tradesBySymbol: Map<string, SymbolTradeRecord[]> = new Map();
  private multiplierActive: boolean = false; // Prepared as feedback multiplier (default: monitor mode)
  private minSampleConfidence: number = 8; // n < 8 is treated as statistical noise
  private highSampleConfidence: number = 15; // n >= 15 is high confidence sample

  constructor(dataDir: string = '.data') {
    this.filePath = path.join(process.cwd(), dataDir, 'symbol_stats.json');
    this.loadPersistedData();
  }

  private loadPersistedData(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const data: PersistedSymbolStatsData = JSON.parse(raw);
        if (data && data.tradesBySymbol) {
          for (const [sym, trades] of Object.entries(data.tradesBySymbol)) {
            this.tradesBySymbol.set(sym, Array.isArray(trades) ? trades : []);
          }
        }
        if (typeof data.multiplierActive === 'boolean') {
          this.multiplierActive = data.multiplierActive;
        }
      }
    } catch (err) {
      console.warn('[SymbolStatsTracker] Failed to load persisted symbol stats:', err);
    }
  }

  private savePersistedData(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const serializable: Record<string, SymbolTradeRecord[]> = {};
      for (const [sym, trades] of this.tradesBySymbol.entries()) {
        serializable[sym] = trades;
      }

      const data: PersistedSymbolStatsData = {
        tradesBySymbol: serializable,
        multiplierActive: this.multiplierActive,
        lastUpdated: Date.now(),
      };

      fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      console.error('[SymbolStatsTracker] Failed to save symbol stats:', err);
    }
  }

  /**
   * Bootstraps symbol records from historic orders if tracker is empty
   */
  public bootstrapFromOrders(orders: OrderRecord[]): void {
    if (this.tradesBySymbol.size > 0) {
      return; // Already populated from persistent storage
    }
    this.recalculateFromOrders(orders);
  }

  /**
   * Recalculates rolling stats entirely from closed orders
   */
  public recalculateFromOrders(orders: OrderRecord[]): void {
    this.tradesBySymbol.clear();

    const reconciledOrders = reconcileHistoricalOrderPrecision(orders || []);
    const closedOrders = reconciledOrders.filter(
      (o) => o.intent !== 'ENTRY' && o.status === 'FILLED' && o.symbol
    );

    // Sort chronologically ascending
    closedOrders.sort((a, b) => (a.updatedTime || a.createdTime) - (b.updatedTime || b.createdTime));

    for (const order of closedOrders) {
      const pnl = order.realizedPnl ?? 0;
      const pnlPct = order.realizedPnlPct ?? 0;
      const mfePct = order.mfePct ?? 0;
      const maePct = order.maePct ?? 0;
      const holdingTimeMinutes = order.holdingTimeMinutes ?? 0;
      const exitTime = order.updatedTime || order.createdTime || Date.now();

      const timeToMfeVal = order.timeToMfe15Minutes !== undefined
        ? order.timeToMfe15Minutes
        : (holdingTimeMinutes <= 5.0 && mfePct >= 1.5 ? holdingTimeMinutes : undefined);
      const isFast = order.isFastRunner !== undefined
        ? order.isFastRunner
        : (Boolean(timeToMfeVal !== undefined && timeToMfeVal <= 5.0) || (holdingTimeMinutes <= 5.0 && mfePct >= 1.5));

      const record: SymbolTradeRecord = {
        positionId: order.positionId || order.id,
        symbol: order.symbol,
        pnl: parseFloat(pnl.toFixed(2)),
        pnlPct: parseFloat(pnlPct.toFixed(2)),
        mfePct: parseFloat(mfePct.toFixed(2)),
        maePct: parseFloat(maePct.toFixed(2)),
        holdingTimeMinutes: parseFloat(holdingTimeMinutes.toFixed(1)),
        timeToMfe15Minutes: timeToMfeVal,
        isFastRunner: isFast,
        exitTime,
        hitMfe15: mfePct >= 1.5,
        isWin: pnl > 0,
        intent: order.intent,
      };

      this.addTradeToRollingWindow(order.symbol, record);
    }

    this.savePersistedData();
  }

  /**
   * Records a closed trade into the symbol's rolling window
   */
  public recordClosedTrade(record: SymbolTradeRecord): void {
    this.addTradeToRollingWindow(record.symbol, record);
    this.savePersistedData();
  }

  private addTradeToRollingWindow(symbol: string, record: SymbolTradeRecord): void {
    if (!this.tradesBySymbol.has(symbol)) {
      this.tradesBySymbol.set(symbol, []);
    }

    const list = this.tradesBySymbol.get(symbol)!;
    // Prepend newest trade
    list.unshift(record);

    // Enforce sliding window (keep last N trades)
    if (list.length > this.maxRollingWindow) {
      list.length = this.maxRollingWindow;
    }
  }

  /**
   * Computes aggregated rolling stats for a single symbol
   */
  public getSymbolStats(symbol: string): SymbolRollingStats | undefined {
    const trades = this.tradesBySymbol.get(symbol);
    if (!trades || trades.length === 0) {
      return undefined;
    }

    const n = trades.length;
    const wins = trades.filter((t) => t.isWin).length;
    const losses = trades.filter((t) => !t.isWin).length;
    const winrate = parseFloat(((wins / n) * 100).toFixed(1));

    const trailingHitCount = trades.filter((t) => t.hitMfe15).length;
    const hitRateMfe15 = parseFloat(((trailingHitCount / n) * 100).toFixed(1));

    const sumMfe = trades.reduce((acc, t) => acc + (t.mfePct || 0), 0);
    const avgMfe = parseFloat((sumMfe / n).toFixed(2));

    const sumMae = trades.reduce((acc, t) => acc + (t.maePct || 0), 0);
    const avgMae = parseFloat((sumMae / n).toFixed(2));

    const totalPnl = parseFloat(trades.reduce((acc, t) => acc + (t.pnl || 0), 0).toFixed(2));
    const avgPnl = parseFloat((totalPnl / n).toFixed(2));

    const sumPnlPct = trades.reduce((acc, t) => acc + (t.pnlPct || 0), 0);
    const avgPnlPct = parseFloat((sumPnlPct / n).toFixed(2));

    const sumHolding = trades.reduce((acc, t) => acc + (t.holdingTimeMinutes || 0), 0);
    const avgHoldingMinutes = parseFloat((sumHolding / n).toFixed(1));

    // Passive Velocity Telemetry:
    // Fast runner = trade reached MFE >= 1.5% within early holding time (<= 5 min)
    const fastRunnerCount = trades.filter(
      (t) => t.isFastRunner || (t.hitMfe15 && t.holdingTimeMinutes !== undefined && t.holdingTimeMinutes <= 5.0)
    ).length;
    const fastRunnerRate = parseFloat(((fastRunnerCount / n) * 100).toFixed(1));

    const mfeTimes = trades
      .map((t) => t.timeToMfe15Minutes ?? (t.hitMfe15 && t.holdingTimeMinutes ? t.holdingTimeMinutes : undefined))
      .filter((tm): tm is number => typeof tm === 'number' && !isNaN(tm));
    const avgTimeToMfeMinutes = mfeTimes.length > 0
      ? parseFloat((mfeTimes.reduce((acc, v) => acc + v, 0) / mfeTimes.length).toFixed(1))
      : undefined;

    // Confidence status
    let confidenceStatus: SymbolConfidenceStatus = 'LOW_SAMPLE';
    if (n >= this.highSampleConfidence) {
      confidenceStatus = 'HIGH_CONFIDENCE';
    } else if (n >= this.minSampleConfidence) {
      confidenceStatus = 'DEVELOPING';
    }

    /**
     * CERINȚA 1 & 2: MULTIPLICATOR GRADUAL CONTINUU CU SIMETRIE JUSTIFICATĂ
     * 
     * Elimină treptele fixe (0.5x / 1.0x / 1.2x) și le înlocuiește cu o interpolare liniară continuă:
     * - Dacă n < 8: recommendedMultiplier = 1.00x (neutru implicit, zgomot statistic).
     * - Dacă n >= 8:
     *     multiplier = 0.50 + (hitRateMfe15 / 100.0) * 1.00
     * 
     * Simetrie Matematică Perfectă (+/- 0.50x în jurul baseline-ului 1.00x la 50% hit-rate):
     * - La 0% hit-rate   -> 0.50x  (-50% conservare capital pe active plate/fără impuls)
     * - La 50% hit-rate  -> 1.00x  (neutru baseline)
     * - La 100% hit-rate -> 1.50x  (+50% bonus gradual pe runneri cu extensie confirmată)
     * - Pantă lină continuă: Delta = 0.01x per 1% hit-rate MFE.
     * - Niciun salt brusc de alocare la trecerea unui prag arbitrar!
     */
    let recommendedMultiplier = 1.0;
    if (n >= this.minSampleConfidence) {
      const continuous = 0.50 + (hitRateMfe15 / 100.0) * 1.00;
      recommendedMultiplier = parseFloat(Math.min(1.50, Math.max(0.50, continuous)).toFixed(2));
    }

    const lastTradeTime = trades[0]?.exitTime || Date.now();

    return {
      symbol,
      n,
      wins,
      losses,
      winrate,
      trailingHitCount,
      hitRateMfe15,
      avgMfe,
      avgMae,
      totalPnl,
      avgPnl,
      avgPnlPct,
      confidenceStatus,
      recommendedMultiplier,
      lastTradeTime,
      avgHoldingMinutes,
      fastRunnerCount,
      fastRunnerRate,
      avgTimeToMfeMinutes,
      recentTrades: trades.slice(0, 10), // attach up to 10 most recent for telemetry
    };
  }

  /**
   * Returns all symbol stats sorted by trade count descending, then totalPnl descending
   */
  public getAllStats(): SymbolRollingStats[] {
    const results: SymbolRollingStats[] = [];
    for (const symbol of this.tradesBySymbol.keys()) {
      const stat = this.getSymbolStats(symbol);
      if (stat) {
        results.push(stat);
      }
    }

    results.sort((a, b) => {
      if (b.n !== a.n) return b.n - a.n;
      return b.totalPnl - a.totalPnl;
    });

    return results;
  }

  /**
   * Returns multiplier for position sizing (returns 1.0 if multiplier is disabled)
   */
  public getSizeMultiplier(symbol: string): number {
    if (!this.multiplierActive) return 1.0;
    const stat = this.getSymbolStats(symbol);
    return stat ? stat.recommendedMultiplier : 1.0;
  }

  public isMultiplierActive(): boolean {
    return this.multiplierActive;
  }

  public setMultiplierActive(active: boolean): void {
    this.multiplierActive = active;
    this.savePersistedData();
  }

  /**
   * Returns summary across all symbols with explicit Capital & Sample Coverage Reporting
   */
  public getSummary(activePositions: Position[] = []): SymbolStatsSummary {
    const all = this.getAllStats();
    const valid = all.filter((s) => s.n >= this.minSampleConfidence);
    const low = all.filter((s) => s.n < this.minSampleConfidence);

    let topRunnerSymbol: string | undefined;
    let topRunnerHitRate: number | undefined;
    let worstPerformerSymbol: string | undefined;
    let worstPerformerHitRate: number | undefined;

    if (valid.length > 0) {
      const sortedByHit = [...valid].sort((a, b) => b.hitRateMfe15 - a.hitRateMfe15);
      topRunnerSymbol = sortedByHit[0].symbol;
      topRunnerHitRate = sortedByHit[0].hitRateMfe15;

      worstPerformerSymbol = sortedByHit[sortedByHit.length - 1].symbol;
      worstPerformerHitRate = sortedByHit[sortedByHit.length - 1].hitRateMfe15;
    }

    const overallAvgHitRate =
      all.length > 0
        ? parseFloat((all.reduce((acc, s) => acc + s.hitRateMfe15, 0) / all.length).toFixed(1))
        : 0;

    // Total Trades Analyzed & Coverage
    const totalTradesAnalyzed = all.reduce((acc, s) => acc + s.n, 0);
    const validTradesCount = valid.reduce((acc, s) => acc + s.n, 0);
    const validTradesCoveragePct = totalTradesAnalyzed > 0
      ? parseFloat(((validTradesCount / totalTradesAnalyzed) * 100).toFixed(1))
      : 0;

    // Active Positions Capital Coverage
    let validCapitalUSDT = 0;
    let lowSampleCapitalUSDT = 0;
    const validSymbolSet = new Set(valid.map((s) => s.symbol));

    for (const pos of activePositions) {
      const size = pos.sizeUSDT || (pos.qty * pos.entryPrice * (pos.ctVal || 1)) || 0;
      if (validSymbolSet.has(pos.symbol)) {
        validCapitalUSDT += size;
      } else {
        lowSampleCapitalUSDT += size;
      }
    }

    const totalActiveCapitalUSDT = parseFloat((validCapitalUSDT + lowSampleCapitalUSDT).toFixed(2));
    validCapitalUSDT = parseFloat(validCapitalUSDT.toFixed(2));
    lowSampleCapitalUSDT = parseFloat(lowSampleCapitalUSDT.toFixed(2));

    const validCapitalCoveragePct = totalActiveCapitalUSDT > 0
      ? parseFloat(((validCapitalUSDT / totalActiveCapitalUSDT) * 100).toFixed(1))
      : 0;
    const lowSampleCapitalCoveragePct = totalActiveCapitalUSDT > 0
      ? parseFloat(((lowSampleCapitalUSDT / totalActiveCapitalUSDT) * 100).toFixed(1))
      : (totalActiveCapitalUSDT === 0 ? 0 : 100);

    // Passive Velocity Portfolio Metrics
    const fastRunnerPortfolioCount = all.reduce((acc, s) => acc + (s.fastRunnerCount || 0), 0);
    const fastRunnerPortfolioRate = totalTradesAnalyzed > 0
      ? parseFloat(((fastRunnerPortfolioCount / totalTradesAnalyzed) * 100).toFixed(1))
      : 0;

    return {
      totalTrackedSymbols: all.length,
      validSampleSymbols: valid.length,
      lowSampleSymbols: low.length,
      topRunnerSymbol,
      topRunnerHitRate,
      worstPerformerSymbol,
      worstPerformerHitRate,
      overallAvgHitRateMfe15: overallAvgHitRate,
      multiplierActive: this.multiplierActive,
      lastUpdated: Date.now(),
      // Explicit Sample & Capital Coverage
      validCapitalCoveragePct,
      lowSampleCapitalCoveragePct,
      validCapitalUSDT,
      lowSampleCapitalUSDT,
      totalActiveCapitalUSDT,
      validTradesCoveragePct,
      validTradesCount,
      totalTradesAnalyzed,
      fastRunnerPortfolioCount,
      fastRunnerPortfolioRate,
    };
  }
}
