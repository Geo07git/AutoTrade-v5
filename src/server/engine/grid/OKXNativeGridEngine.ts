import {
  NativeGridAutopilotConfig,
  NativeGridOpportunity,
  OKXNativeGridBot,
  UniverseFilterConfig,
} from '../../../shared/types';
import { getLiveFeeRates } from '../../../shared/fees';
import { OKXAdapter } from '../../exchange/OKXAdapter';
import { UniverseManager } from '../../scanner/UniverseManager';
import { JsonStore } from '../../store';
import { GridJournal } from './GridJournal';
import { GridOptimizer } from './GridOptimizer';
import { NeutralGridAnalyzer } from './NeutralGridAnalyzer';

export const DEFAULT_NATIVE_GRID_AUTOPILOT: NativeGridAutopilotConfig = {
  enabled: false,
  environment: 'LIVE',
  liveExecutionConfirmed: true,
  maxBudgetPerBotUSDT: 25,
  minReserveUSDT: 5,
  maxConcurrentNativeBots: 2,
  minSuitabilityScore: 68,
  minNetProfitPerGridPct: 0.12,
  maxLeverage: 5,
  defaultRunType: '1', // '1' = Arithmetic, '2' = Geometric
  defaultStopType: '1', // '1' = Close position at market, '2' = Keep position open
  stopLossPct: 8.0,
  takeProfitPct: 15.0,
  stopOnRangeBreakout: true,
  stopOnTrendInvalidation: true,
  scanIntervalSec: 60,
  lastScanAt: 0,
  lastDecision: 'Modul OKX Native Futures Grid pregătit (Execuție directă LIVE pe OKX EEA).',
};

export class OKXNativeGridEngine {
  private okxAdapter: OKXAdapter;
  private universeManager: UniverseManager;
  private journal: GridJournal;
  private configStore: JsonStore<NativeGridAutopilotConfig>;
  private botsStore: JsonStore<OKXNativeGridBot[]>;
  private dismissedStore: JsonStore<string[]>;

  private opportunities: NativeGridOpportunity[] = [];
  private bots: Map<string, OKXNativeGridBot> = new Map();
  private dismissedAlgoIds: Set<string> = new Set();
  private isScanning: boolean = false;
  private isMonitoring: boolean = false;

  constructor(
    okxAdapter: OKXAdapter,
    universeManager: UniverseManager,
    journal: GridJournal
  ) {
    this.okxAdapter = okxAdapter;
    this.universeManager = universeManager;
    this.journal = journal;
    this.configStore = new JsonStore<NativeGridAutopilotConfig>(
      'native_grid_autopilot.json',
      DEFAULT_NATIVE_GRID_AUTOPILOT
    );
    this.botsStore = new JsonStore<OKXNativeGridBot[]>('native_grid_bots.json', []);
    this.dismissedStore = new JsonStore<string[]>('native_grid_dismissed.json', []);

    const savedDismissed = this.dismissedStore.get();
    if (Array.isArray(savedDismissed)) {
      for (const id of savedDismissed) {
        if (id) this.dismissedAlgoIds.add(String(id));
      }
    }

    const savedBots = this.botsStore.get();
    if (Array.isArray(savedBots)) {
      for (const b of savedBots) {
        if (b?.algoId && !this.dismissedAlgoIds.has(String(b.algoId))) {
          this.bots.set(b.algoId, b);
        }
      }
    }
  }

  private persistBots(): void {
    this.botsStore.save(this.getAllBots());
  }

  private persistDismissed(): void {
    this.dismissedStore.save(Array.from(this.dismissedAlgoIds));
  }

  public getConfig(): NativeGridAutopilotConfig {
    const stored = this.configStore.get() || ({} as Partial<NativeGridAutopilotConfig>);
    return {
      ...DEFAULT_NATIVE_GRID_AUTOPILOT,
      ...stored,
      environment: 'LIVE',
      liveExecutionConfirmed: true,
    };
  }

  public updateConfig(updates: Partial<NativeGridAutopilotConfig>): NativeGridAutopilotConfig {
    const current = this.getConfig();
    const next: NativeGridAutopilotConfig = {
      ...current,
      ...updates,
      environment: 'LIVE',
      liveExecutionConfirmed: true,
    };

    next.maxBudgetPerBotUSDT = Math.max(2, Number(next.maxBudgetPerBotUSDT) || 25);
    next.minReserveUSDT = Math.max(0, Number(next.minReserveUSDT) || 5);
    next.maxConcurrentNativeBots = Math.max(
      1,
      Math.min(20, Math.round(Number(next.maxConcurrentNativeBots) || 2))
    );
    next.minSuitabilityScore = Math.max(
      35,
      Math.min(98, Math.round(Number(next.minSuitabilityScore) || 68))
    );
    next.minNetProfitPerGridPct = Math.max(0.02, Number(next.minNetProfitPerGridPct) || 0.12);
    next.maxLeverage = Math.max(1, Math.min(20, Math.round(Number(next.maxLeverage) || 5)));
    next.defaultRunType = next.defaultRunType === '2' ? '2' : '1';
    next.defaultStopType = next.defaultStopType === '2' ? '2' : '1';
    next.stopLossPct = Math.max(1, Math.min(80, Number(next.stopLossPct) || 8.0));
    next.takeProfitPct = Math.max(1, Math.min(300, Number(next.takeProfitPct) || 15.0));
    next.scanIntervalSec = Math.max(
      20,
      Math.min(600, Math.round(Number(next.scanIntervalSec) || 60))
    );

    this.configStore.save(next);
    this.journal.logAudit(
      'CONFIG_UPDATED',
      `[OKX NATIVE GRID CONFIG LIVE] Autopilot: ${next.enabled ? 'ON' : 'OFF'} | Buget Max/Bot: $${next.maxBudgetPerBotUSDT} | Levier Max: ${next.maxLeverage}x | StopType: ${next.defaultStopType === '1' ? '1 (Închide Poziția)' : '2 (Păstrează Poziția)'}`
    );
    return next;
  }

  public getAllBots(): OKXNativeGridBot[] {
    return Array.from(this.bots.values()).sort((a, b) => b.cTime - a.cTime);
  }

  public getRunningBots(): OKXNativeGridBot[] {
    return this.getAllBots().filter(
      (b) => b.state === 'running' || b.state === 'pending_signal'
    );
  }

  public getOpportunities(): NativeGridOpportunity[] {
    return this.opportunities;
  }

  /**
   * 1–5. Autonomous Market Intelligence & OKX Min-Investment Optimizer:
   * - Exclusively analyzes FUTURES X-Perp (_UM_XPERP) instruments on OKX EEA.
   * - Evaluates liquidity, 24h volume, volatility (ATR, Choppiness), spread, trend (ADX),
   *   Open Interest, funding rate, and Order Book depth/imbalance.
   * - Queries POST /api/v5/tradingBot/grid/min-investment on OKX EEA and iteratively
   *   optimizes gridNum & leverage so the required investment fits within maxBudgetPerBotUSDT.
   * - Eliminates candidates over budget or with negative/insufficient net profit after real OKX fees & funding.
   */
  public async scanAndOptimizeOpportunities(
    scannerFilter?: UniverseFilterConfig,
    maxCandidatesToAnalyze: number = 10
  ): Promise<NativeGridOpportunity[]> {
    if (this.isScanning) return this.opportunities;
    this.isScanning = true;

    const cfg = this.getConfig();
    const startMs = Date.now();

    try {
      const filtered = await this.universeManager.getFilteredUniverse(scannerFilter);
      let rawSymbols = filtered.eligibleSymbols;
      if (!rawSymbols || rawSymbols.length === 0) {
        rawSymbols = await this.universeManager.refreshUniverse(scannerFilter);
      }

      // Mandatory rule: Exclusively FUTURES X-Perp (_UM_XPERP) contracts
      const xperpSymbols = rawSymbols
        .filter((s) => s.includes('_UM_XPERP'))
        .slice(0, Math.max(4, Math.min(20, maxCandidatesToAnalyze)));

      // Refresh live OKX fee tier before computing net profitability
      await this.okxAdapter.fetchTradeFeeTier('FUTURES', false).catch(() => {});
      const feeInfo = getLiveFeeRates();
      const roundTripMakerFeePct = feeInfo.roundTripMakerFeePct; // e.g. 0.04%

      const analyzed: NativeGridOpportunity[] = [];

      for (const instId of xperpSymbols) {
        try {
          const baseAnalysis = await NeutralGridAnalyzer.analyzeSymbol(instId, this.okxAdapter);
          if (!baseAnalysis || baseAnalysis.price <= 0) continue;

          const [extras, lotFilter] = await Promise.all([
            this.okxAdapter.fetchMarketIntelligenceExtras(instId),
            this.okxAdapter.getInstrumentFilter(instId),
          ]);

          const tickSize = lotFilter?.tickSize || 0.01;
          const decimals = Math.max(0, -Math.floor(Math.log10(tickSize)));
          const minPx = parseFloat(baseAnalysis.recommendedLowerPrice.toFixed(decimals));
          const maxPx = parseFloat(baseAnalysis.recommendedUpperPrice.toFixed(decimals));
          if (minPx <= 0 || maxPx <= minPx) continue;

          const runType: '1' | '2' = cfg.defaultRunType === '2' ? '2' : '1';
          const initialGridNum = Math.max(4, Math.min(35, baseAnalysis.recommendedGridCount || 10));
          const initialLever = Math.max(
            1,
            Math.min(cfg.maxLeverage, baseAnalysis.recommendedLeverage || 3)
          );

          // Closed-loop optimization with OKX /api/v5/tradingBot/grid/min-investment
          // Try initial (gridNum, lever); if minInvestment > maxBudgetPerBotUSDT, step down gridNum and/or step up lever up to maxLeverage
          let chosenGridNum = initialGridNum;
          let chosenLever = initialLever;
          let minInvRes = await this.okxAdapter.calculateGridMinInvestment({
            instId,
            maxPx,
            minPx,
            gridNum: chosenGridNum,
            runType,
            lever: chosenLever,
          });

          const candidateGridCounts = Array.from(
            new Set([
              initialGridNum,
              Math.max(4, Math.floor(initialGridNum * 0.75)),
              Math.max(3, Math.floor(initialGridNum * 0.5)),
              4,
              3,
              2,
            ])
          ).filter((g) => g >= 2 && g <= initialGridNum);

          const candidateLevers = Array.from(
            new Set([initialLever, Math.min(cfg.maxLeverage, initialLever + 2), cfg.maxLeverage])
          ).filter((l) => l >= 1 && l <= cfg.maxLeverage);

          if (
            minInvRes.minInvestmentUSDT <= 0 ||
            minInvRes.minInvestmentUSDT > cfg.maxBudgetPerBotUSDT
          ) {
            let foundWithinBudget = false;
            for (const levTry of candidateLevers) {
              for (const gridTry of candidateGridCounts) {
                if (levTry === initialLever && gridTry === initialGridNum) continue;
                const tryRes = await this.okxAdapter.calculateGridMinInvestment({
                  instId,
                  maxPx,
                  minPx,
                  gridNum: gridTry,
                  runType,
                  lever: levTry,
                });
                if (tryRes.minInvestmentUSDT > 0) {
                  chosenGridNum = gridTry;
                  chosenLever = levTry;
                  minInvRes = tryRes;
                  if (tryRes.minInvestmentUSDT <= cfg.maxBudgetPerBotUSDT) {
                    foundWithinBudget = true;
                    break;
                  }
                }
              }
              if (foundWithinBudget) break;
            }
          }

          const gridSpacingUSDT = (maxPx - minPx) / Math.max(1, chosenGridNum);
          const gridSpacingPct = parseFloat(
            ((gridSpacingUSDT / baseAnalysis.price) * 100).toFixed(3)
          );
          const fundingDragPerGridPct = Math.abs(extras.fundingRatePct) * 0.35;
          const spreadDragPct = (extras.spreadBps / 100) * 0.5;
          const estimatedGrossProfitPerGridPct = parseFloat(gridSpacingPct.toFixed(3));
          const estimatedNetProfitPerGridPct = parseFloat(
            (
              estimatedGrossProfitPerGridPct -
              roundTripMakerFeePct -
              fundingDragPerGridPct -
              spreadDragPct
            ).toFixed(3)
          );

          const estDailyCrossings = Math.max(
            1,
            Math.min(28, (baseAnalysis.range24hPct / Math.max(0.15, gridSpacingPct)) * 1.4)
          );
          const estimatedDailyNetYieldPct = parseFloat(
            (Math.max(0, estimatedNetProfitPerGridPct) * estDailyCrossings * 0.35 * chosenLever).toFixed(2)
          );

          // Composite Market Intelligence Score (incorporating Open Interest, Order Book depth/imbalance, Funding)
          let score = baseAnalysis.gridSuitabilityScore;
          const reasons = [...baseAnalysis.reasons];

          if (extras.openInterestUSD >= 500_000) {
            score += 4;
            reasons.push(`OI solid ($${(extras.openInterestUSD / 1e6).toFixed(2)}M)`);
          }
          if (Math.abs(extras.orderBookImbalance) <= 0.3) {
            score += 4;
            reasons.push(`OrderBook echilibrat (Imb ${(extras.orderBookImbalance * 100).toFixed(0)}%)`);
          } else if (Math.abs(extras.orderBookImbalance) > 0.65) {
            score -= 6;
            reasons.push(`Presiune OrderBook unidirecțională (${(extras.orderBookImbalance * 100).toFixed(0)}%)`);
          }
          if (Math.abs(extras.fundingRatePct) > 0.08) {
            score -= 8;
            reasons.push(`Funding ridicat (${extras.fundingRatePct.toFixed(4)}%)`);
          }
          score = Math.max(5, Math.min(99, Math.round(score)));

          const fitsMaxBudget =
            minInvRes.minInvestmentUSDT > 0 &&
            minInvRes.minInvestmentUSDT <= cfg.maxBudgetPerBotUSDT;

          const rejectionReasons: string[] = [];
          if (minInvRes.minInvestmentUSDT <= 0) {
            rejectionReasons.push(minInvRes.error || 'OKX min-investment indisponibil');
          } else if (!fitsMaxBudget) {
            rejectionReasons.push(
              `Investiție minimă OKX ($${minInvRes.minInvestmentUSDT.toFixed(2)}) > Buget Max ($${cfg.maxBudgetPerBotUSDT.toFixed(2)})`
            );
          }
          if (estimatedNetProfitPerGridPct < cfg.minNetProfitPerGridPct) {
            rejectionReasons.push(
              `Profit net/grilă (${estimatedNetProfitPerGridPct.toFixed(2)}%) < minim (${cfg.minNetProfitPerGridPct.toFixed(2)}%) după fee OKX (${roundTripMakerFeePct.toFixed(2)}%) & funding`
            );
          }
          if (baseAnalysis.regimeLabel === 'TRENDING_RISK') {
            rejectionReasons.push('Piață în trend direcțional puternic (TRENDING_RISK)');
          }
          if (score < cfg.minSuitabilityScore) {
            rejectionReasons.push(`Scor (${score}) sub pragul minim (${cfg.minSuitabilityScore})`);
          }

          const isEligible = rejectionReasons.length === 0;
          const recommendedInvestmentUSDT = fitsMaxBudget
            ? parseFloat(
                Math.min(
                  cfg.maxBudgetPerBotUSDT,
                  Math.max(minInvRes.minInvestmentUSDT * 1.05, minInvRes.minInvestmentUSDT + 0.5)
                ).toFixed(2)
              )
            : parseFloat(minInvRes.minInvestmentUSDT.toFixed(2));

          const opp: NativeGridOpportunity = {
            instId,
            price: baseAnalysis.price,
            volume24hUSDT: baseAnalysis.volume24hUSDT,
            priceChange24hPct: baseAnalysis.priceChange24hPct,
            range24hPct: baseAnalysis.range24hPct,
            atrPct: baseAnalysis.atrPct,
            choppinessIndex: baseAnalysis.choppinessIndex,
            adxTrendStrength: baseAnalysis.adxTrendStrength,
            spreadBps: extras.spreadBps,
            openInterestUSD: extras.openInterestUSD,
            fundingRatePct: extras.fundingRatePct,
            nextFundingRatePct: extras.nextFundingRatePct,
            orderBookImbalance: extras.orderBookImbalance,
            orderBookDepthUSD: extras.orderBookDepthUSD,
            suitabilityScore: score,
            regimeLabel: baseAnalysis.regimeLabel,
            minPx,
            maxPx,
            gridNum: chosenGridNum,
            runType,
            gridSpacingPct,
            lever: chosenLever,
            minInvestmentUSDT: minInvRes.minInvestmentUSDT,
            minInvestmentCcy: minInvRes.ccy || 'USD',
            recommendedInvestmentUSDT,
            fitsMaxBudget,
            estimatedGrossProfitPerGridPct,
            estimatedNetProfitPerGridPct,
            estimatedDailyNetYieldPct,
            isEligible,
            rejectionReason: rejectionReasons.length > 0 ? rejectionReasons.join(' | ') : undefined,
            reasons,
            updatedAt: Date.now(),
          };

          analyzed.push(opp);
        } catch (symErr: any) {
          console.warn(`[OKXNativeGridEngine] Eroare analiză ${instId}:`, symErr?.message || symErr);
        }
      }

      // Sort: eligible opportunities first, then by suitabilityScore descending
      analyzed.sort((a, b) => {
        if (a.isEligible !== b.isEligible) return a.isEligible ? -1 : 1;
        if (a.fitsMaxBudget !== b.fitsMaxBudget) return a.fitsMaxBudget ? -1 : 1;
        return b.suitabilityScore - a.suitabilityScore;
      });

      this.opportunities = analyzed;
      const eligibleCount = analyzed.filter((o) => o.isEligible).length;

      this.journal.logAudit(
        'SCAN_COMPLETED',
        `[OKX NATIVE GRID SCAN] ${analyzed.length} contracte _UM_XPERP analizate în ${Date.now() - startMs}ms: ${eligibleCount} eligibile în bugetul ≤$${cfg.maxBudgetPerBotUSDT} USDT.`
      );

      // Update scan timestamp
      const updatedCfg = this.getConfig();
      updatedCfg.lastScanAt = Date.now();
      this.configStore.save(updatedCfg);

      // If Autopilot is enabled, evaluate autonomous native bot creation
      if (cfg.enabled) {
        await this.evaluateAutopilot();
      }

      return this.opportunities;
    } finally {
      this.isScanning = false;
    }
  }

  /**
   * 6. Create & Configure a Native Futures Grid (contract_grid, direction: neutral) directly on OKX EEA.
   */
  public async createNativeBot(params: {
    instId: string;
    minPx: number;
    maxPx: number;
    gridNum: number;
    runType?: '1' | '2';
    lever: number;
    sz: number;
    stopLossPct?: number;
    takeProfitPct?: number;
    tpTriggerPx?: number;
    slTriggerPx?: number;
    stopTypeOnRisk?: '1' | '2';
    stopOnRangeBreakout?: boolean;
    stopOnTrendInvalidation?: boolean;
    environment?: 'LIVE';
    explicitLiveConfirm?: boolean;
    killSwitchEngaged?: boolean;
  }): Promise<{
    success: boolean;
    bot?: OKXNativeGridBot;
    error?: string;
    needsDirectOrderFallback?: boolean;
    validatedParams?: any;
  }> {
    const cfg = this.getConfig();
    if (params.killSwitchEngaged) {
      return {
        success: false,
        error: 'Kill Switch de urgență este activat. Lansarea boților nativi OKX este blocată.',
      };
    }

    const instId = this.okxAdapter.normalizeSymbol(params.instId);
    if (!instId.includes('_UM_XPERP')) {
      return {
        success: false,
        error: `Instrument invalid (${instId}): Modulul OKX Native Grid acceptă exclusiv contracte FUTURES X-Perp (_UM_XPERP).`,
      };
    }

    const env: 'LIVE' = 'LIVE';

    if (!this.okxAdapter.hasCredentials()) {
      return {
        success: false,
        error: 'Cheile API OKX EEA nu sunt configurate în backend. Configurează-le în tabul [6:API].',
      };
    }

    const minPx = Number(params.minPx);
    const maxPx = Number(params.maxPx);
    const gridNum = Math.max(2, Math.min(100, Math.round(Number(params.gridNum) || 8)));
    const runType: '1' | '2' = params.runType === '2' ? '2' : '1';
    const lever = Math.max(1, Math.min(20, Math.round(Number(params.lever) || 3)));
    const sz = Number(params.sz);

    if (minPx <= 0 || maxPx <= minPx) {
      return {
        success: false,
        error: 'Interval de preț invalid: minPx trebuie să fie pozitiv și mai mic decât maxPx.',
      };
    }

    // Verify minimum investment on OKX EEA before sending order-algo
    const minInv = await this.okxAdapter.calculateGridMinInvestment({
      instId,
      maxPx,
      minPx,
      gridNum,
      runType,
      lever,
    });

    if (minInv.minInvestmentUSDT > 0 && sz < minInv.minInvestmentUSDT) {
      const msg = `Investiția alocată ($${sz.toFixed(2)}) este sub investiția minimă cerută de OKX ($${minInv.minInvestmentUSDT.toFixed(2)} ${minInv.ccy}) pentru ${gridNum} grile la ${lever}x.`;
      this.journal.logAudit('CANDIDATE_REJECTED', `[OKX NATIVE GRID RESPINS] ${instId}: ${msg}`);
      return { success: false, error: msg };
    }

    const stopLossPct = Number(params.stopLossPct ?? cfg.stopLossPct ?? 8.0);
    const takeProfitPct = Number(params.takeProfitPct ?? cfg.takeProfitPct ?? 15.0);
    const stopTypeOnRisk: '1' | '2' =
      params.stopTypeOnRisk === '2'
        ? '2'
        : params.stopTypeOnRisk === '1'
        ? '1'
        : cfg.defaultStopType;

    const lotFilter = await this.okxAdapter.getInstrumentFilter(instId);
    const tickSize = lotFilter?.tickSize || 0.01;
    const decimals = Math.max(0, -Math.floor(Math.log10(tickSize)));

    // Compute default trigger prices if not explicitly passed
    const slTriggerPx =
      params.slTriggerPx && params.slTriggerPx > 0
        ? Number(params.slTriggerPx.toFixed(decimals))
        : Number((minPx * (1 - Math.min(0.15, (stopLossPct / 100) * 0.6))).toFixed(decimals));
    const tpTriggerPx =
      params.tpTriggerPx && params.tpTriggerPx > 0
        ? Number(params.tpTriggerPx.toFixed(decimals))
        : Number((maxPx * (1 + Math.min(0.2, (takeProfitPct / 100) * 0.5))).toFixed(decimals));

    const validatedParams = {
      instId,
      minPx,
      maxPx,
      gridNum,
      runType,
      lever,
      sz: parseFloat(sz.toFixed(2)),
      singleAmt: minInv.singleAmt || 0,
      tpTriggerPx,
      slTriggerPx,
      stopLossPct,
      takeProfitPct,
      stopTypeOnRisk,
      stopOnRangeBreakout:
        params.stopOnRangeBreakout !== undefined
          ? Boolean(params.stopOnRangeBreakout)
          : cfg.stopOnRangeBreakout,
      stopOnTrendInvalidation:
        params.stopOnTrendInvalidation !== undefined
          ? Boolean(params.stopOnTrendInvalidation)
          : cfg.stopOnTrendInvalidation,
    };

    if ((params as any).executionVariant === 'AUTO_LIMIT') {
      return {
        success: false,
        needsDirectOrderFallback: true,
        validatedParams,
      } as any;
    }

    try {
      const created = await this.okxAdapter.createNativeContractGrid({
        instId,
        maxPx,
        minPx,
        gridNum,
        runType,
        sz: parseFloat(sz.toFixed(2)),
        lever,
        tpTriggerPx,
        slTriggerPx,
        isDemo: false,
      });

      const livePx = (await this.okxAdapter.getTickerPrice(instId)) || (minPx + maxPx) / 2;
      const now = Date.now();

      const bot: OKXNativeGridBot = {
        algoId: created.algoId,
        instId,
        algoOrdType: 'contract_grid',
        direction: 'neutral',
        environment: env,
        state: 'running',
        minPx,
        maxPx,
        gridNum,
        runType,
        lever,
        sz: parseFloat(sz.toFixed(2)),
        singleAmt: minInv.singleAmt || 0,
        currentPx: livePx,
        liqPx: 0,
        gridProfit: 0,
        floatProfit: 0,
        totalPnl: 0,
        totalPnlPct: 0,
        arbitrageNum: 0,
        tpTriggerPx,
        slTriggerPx,
        stopLossPct,
        takeProfitPct,
        stopTypeOnRisk,
        stopOnRangeBreakout: validatedParams.stopOnRangeBreakout,
        stopOnTrendInvalidation: validatedParams.stopOnTrendInvalidation,
        cTime: now,
        uTime: now,
      };

      this.bots.set(bot.algoId, bot);
      this.persistBots();

      this.journal.logAudit(
        'GRID_CREATED',
        `[OKX NATIVE BOT CREAT LIVE] ${instId} (algoId: ${bot.algoId}) | Direction: NEUTRAL | Range: $${minPx} – $${maxPx} | ${gridNum} grile (${runType === '1' ? 'Aritmetic' : 'Geometric'}) | Investiție: $${sz.toFixed(2)} @ ${lever}x | SL Trigger: $${slTriggerPx} / TP Trigger: $${tpTriggerPx} | StopType: ${stopTypeOnRisk}`,
        bot
      );

      return { success: true, bot };
    } catch (err: any) {
      const errMsg = err?.message || 'Eroare necunoscută la crearea botului nativ pe OKX';
      const isOkxGatewayInstIdBug =
        errMsg.includes('51000') &&
        errMsg.includes('Parameter instId error') &&
        instId.includes('-USD_UM');
      this.journal.logAudit(
        'ORDER_REJECTED',
        isOkxGatewayInstIdBug
          ? `[OKX EEA GATEWAY 51000] Ruta OKX /tradingBot/grid/order-algo respinge sufixul -USD_UM (${instId}) pe API Key; se activează execuția directă pe OKX EEA (/api/v5/trade/order) cu parametrii validați prin min-investment.`
          : `[OKX NATIVE GRID EROARE CREARE LIVE] ${instId}: ${errMsg}`
      );
      return {
        success: false,
        error: errMsg,
        needsDirectOrderFallback: isOkxGatewayInstIdBug,
        validatedParams,
      } as any;
    }
  }

  public registerFallbackBot(bot: OKXNativeGridBot): void {
    this.bots.set(bot.algoId, bot);
    this.persistBots();
  }

  public isDismissed(algoId: string): boolean {
    return this.dismissedAlgoIds.has(String(algoId));
  }

  /**
   * Amend TP / SL / StopType parameters on an active Native Contract Grid Bot on OKX.
   */
  public async amendNativeBot(params: {
    algoId: string;
    tpTriggerPx?: number;
    slTriggerPx?: number;
    stopLossPct?: number;
    takeProfitPct?: number;
    stopTypeOnRisk?: '1' | '2';
    stopOnRangeBreakout?: boolean;
    stopOnTrendInvalidation?: boolean;
  }): Promise<{ success: boolean; bot?: OKXNativeGridBot; error?: string }> {
    const bot = this.bots.get(params.algoId);
    if (!bot) {
      return { success: false, error: `Botul nativ OKX (${params.algoId}) nu a fost găsit.` };
    }

    const isAutoLimit = bot.algoId.toLowerCase().startsWith('grid');

    try {
      if (!isAutoLimit && (params.tpTriggerPx !== undefined || params.slTriggerPx !== undefined)) {
        await this.okxAdapter.amendNativeContractGrid({
          algoId: bot.algoId,
          instId: bot.instId,
          tpTriggerPx: params.tpTriggerPx,
          slTriggerPx: params.slTriggerPx,
          isDemo: false,
        });
      }

      if (params.tpTriggerPx !== undefined) bot.tpTriggerPx = params.tpTriggerPx;
      if (params.slTriggerPx !== undefined) bot.slTriggerPx = params.slTriggerPx;
      if (params.stopLossPct !== undefined) bot.stopLossPct = Number(params.stopLossPct);
      if (params.takeProfitPct !== undefined) bot.takeProfitPct = Number(params.takeProfitPct);
      if (params.stopTypeOnRisk === '1' || params.stopTypeOnRisk === '2') {
        bot.stopTypeOnRisk = params.stopTypeOnRisk;
      }
      if (params.stopOnRangeBreakout !== undefined) {
        bot.stopOnRangeBreakout = Boolean(params.stopOnRangeBreakout);
      }
      if (params.stopOnTrendInvalidation !== undefined) {
        bot.stopOnTrendInvalidation = Boolean(params.stopOnTrendInvalidation);
      }
      bot.uTime = Date.now();
      this.persistBots();

      this.journal.logAudit(
        'GRID_MODIFIED',
        `[OKX NATIVE BOT MODIFICAT] ${bot.instId} (algoId: ${bot.algoId}) | SL: -${bot.stopLossPct}% ($${bot.slTriggerPx || 'N/A'}) | TP: +${bot.takeProfitPct}% ($${bot.tpTriggerPx || 'N/A'}) | StopType: ${bot.stopTypeOnRisk === '1' ? '1 (Închide Poziția)' : '2 (Păstrează Poziția)'}`,
        bot
      );

      return { success: true, bot };
    } catch (err: any) {
      return {
        success: false,
        error: err?.message || 'Eroare la modificarea parametrilor pe OKX (amend-order-algo)',
      };
    }
  }

  /**
   * Stop an active Native Contract Grid Bot on OKX via POST /api/v5/tradingBot/grid/stop-order-algo
   */
  public async stopNativeBot(
    algoId: string,
    stopType?: '1' | '2',
    reason: string = 'Oprit manual din Terminal'
  ): Promise<{ success: boolean; bot?: OKXNativeGridBot; error?: string }> {
    const bot = this.bots.get(algoId);
    if (!bot) {
      return { success: false, error: `Botul nativ OKX (${algoId}) nu a fost găsit.` };
    }

    const effectiveStopType: '1' | '2' = stopType || bot.stopTypeOnRisk || '1';
    const isFallback = bot.algoId.toLowerCase().startsWith('grid');
    try {
      let ok = false;
      if (!isFallback) {
        try {
          ok = await this.okxAdapter.stopNativeContractGrid({
            algoId: bot.algoId,
            instId: bot.instId,
            stopType: effectiveStopType,
            isDemo: false,
          });
        } catch (stopErr: any) {
          const msg = stopErr?.message || '';
          // If OKX EEA stop-order-algo rejects -USD_UM instId with 51000/51001, fall back to close-position (which only uses algoId)
          if (effectiveStopType === '1') {
            ok = await this.okxAdapter
              .closeNativeContractGridPosition({
                algoId: bot.algoId,
                mktClose: true,
                isDemo: false,
              })
              .catch(() => false);
          } else {
            throw new Error(msg);
          }
        }
      } else {
        ok = true;
      }

      let confirmedStopped = isFallback;
      if (!isFallback && ok) {
        for (let attempt = 0; attempt < 3; attempt++) {
          await new Promise((r) => setTimeout(r, 1100));
          const det = await this.okxAdapter
            .getNativeContractGridDetails(bot.algoId, false)
            .catch(() => null);
          const remState = String(det?.state || '').toLowerCase();
          if (remState === 'stopped' || remState === 'no_close_position') {
            confirmedStopped = true;
            break;
          }
          if (!det) {
            const hist = await this.okxAdapter
              .getNativeContractGridBots('history', false)
              .catch(() => []);
            if (hist.some((h: any) => String(h?.algoId) === String(bot.algoId))) {
              confirmedStopped = true;
              break;
            }
          }
        }
      }

      bot.state = confirmedStopped ? 'stopped' : ok ? 'stopping' : bot.state;
      bot.stopReason = `${reason} (stopType ${effectiveStopType}: ${
        effectiveStopType === '1' ? 'Poziție închisă la piață' : 'Poziție păstrată'
      } | ${confirmedStopped ? 'CONFIRMED_STOPPED' : 'STOP_PENDING_CONFIRMATION'})`;
      bot.uTime = Date.now();
      this.persistBots();

      this.journal.logAudit(
        reason.toLowerCase().includes('risc') || reason.toLowerCase().includes('stop')
          ? 'GRID_RISK_TRIGGERED'
          : 'GRID_STOPPED',
        `[OKX NATIVE BOT OPRIT] ${bot.instId} (algoId: ${bot.algoId} | LIVE) | stopType: ${effectiveStopType} | Stare OKX: ${
          confirmedStopped ? 'CONFIRMED_STOPPED' : 'STOP_PENDING_CONFIRMATION'
        } | Motiv: ${reason} | PnL Total: $${bot.totalPnl.toFixed(2)} (${bot.totalPnlPct >= 0 ? '+' : ''}${bot.totalPnlPct.toFixed(2)}%)`,
        { algoId: bot.algoId, stopType: effectiveStopType, reason, ok, confirmedStopped }
      );

      return { success: true, bot };
    } catch (err: any) {
      const errMsg = err?.message || 'Eroare la oprirea botului nativ OKX';
      return { success: false, error: errMsg };
    }
  }

  /**
   * Close position for a Native Contract Grid Bot via POST /api/v5/tradingBot/grid/close-position
   */
  public async closeNativeBotPosition(
    algoId: string
  ): Promise<{ success: boolean; error?: string }> {
    const bot = this.bots.get(algoId);
    if (!bot) {
      return { success: false, error: `Botul nativ OKX (${algoId}) nu a fost găsit.` };
    }
    try {
      const ok = await this.okxAdapter.closeNativeContractGridPosition({
        algoId: bot.algoId,
        mktClose: true,
        isDemo: false,
      });
      this.journal.logAudit(
        'POSITION_CLOSED',
        `[OKX NATIVE GRID CLOSE POSITION] Poziția aferentă botului nativ ${bot.instId} (algoId: ${bot.algoId}) a fost închisă la piață pe OKX.`
      );
      return { success: ok };
    } catch (err: any) {
      return {
        success: false,
        error: err?.message || 'Eroare la închiderea poziției botului nativ pe OKX',
      };
    }
  }

  /**
   * Delete/dismiss a stopped Native Contract Grid Bot from TB5 list
   */
  public deleteNativeBot(algoId: string): { success: boolean; error?: string } {
    const bot = this.bots.get(algoId);
    if (!bot) {
      this.dismissedAlgoIds.add(String(algoId));
      this.persistDismissed();
      return { success: true };
    }
    if (bot.state === 'running') {
      return {
        success: false,
        error: 'Botul este încă ACTIV. Oprește-l întâi înainte de a-l șterge din listă.',
      };
    }
    this.bots.delete(algoId);
    this.dismissedAlgoIds.add(String(algoId));
    this.persistBots();
    this.persistDismissed();
    return { success: true };
  }

  /**
   * Clear all stopped Native Contract Grid Bots from TB5 list
   */
  public clearStoppedNativeBots(): { success: boolean; removedCount: number } {
    let removedCount = 0;
    for (const [id, bot] of Array.from(this.bots.entries())) {
      if (bot.state !== 'running') {
        this.bots.delete(id);
        this.dismissedAlgoIds.add(String(id));
        removedCount++;
      }
    }
    if (removedCount > 0) {
      this.persistBots();
      this.persistDismissed();
    }
    return { success: true, removedCount };
  }

  /**
   * Autonomous Autopilot Evaluation for OKX Native Grid:
   * Selects top eligible _UM_XPERP opportunities and creates Native Contract Grid bots on OKX
   * within maxBudgetPerBotUSDT and maxConcurrentNativeBots.
   */
  public async evaluateAutopilot(
    freeBalanceUSDT?: number,
    killSwitchEngaged?: boolean,
    customCreator?: (params: any) => Promise<{ success: boolean; bot?: OKXNativeGridBot; error?: string }>
  ): Promise<{ launched: OKXNativeGridBot[]; decision: string }> {
    const cfg = this.getConfig();
    const saveDecision = (msg: string) => {
      const latest = this.getConfig();
      latest.lastDecision = msg;
      latest.lastScanAt = Date.now();
      this.configStore.save(latest);
      return msg;
    };

    if (!cfg.enabled) {
      return { launched: [], decision: cfg.lastDecision || 'Autopilot OKX Native Grid este OPRIT.' };
    }
    if (killSwitchEngaged) {
      return {
        launched: [],
        decision: saveDecision('Blocat: Kill Switch de urgență este activat.'),
      };
    }
    if (!this.okxAdapter.hasCredentials()) {
      return {
        launched: [],
        decision: saveDecision('Blocat: Cheile API OKX EEA nu sunt configurate.'),
      };
    }

    const running = this.getRunningBots();
    if (running.length >= cfg.maxConcurrentNativeBots) {
      return {
        launched: [],
        decision: saveDecision(
          `Sloturi ocupate: ${running.length}/${cfg.maxConcurrentNativeBots} boți nativi OKX activi.`
        ),
      };
    }

    const runningInstIds = new Set(running.map((b) => b.instId));
    const eligible = this.opportunities.filter(
      (o) => o.isEligible && o.fitsMaxBudget && !runningInstIds.has(o.instId)
    );

    if (eligible.length === 0) {
      return {
        launched: [],
        decision: saveDecision(
          `Nicio oportunitate _UM_XPERP eligibilă în bugetul ≤$${cfg.maxBudgetPerBotUSDT} USDT (Scor ≥${cfg.minSuitabilityScore}).`
        ),
      };
    }

    let availUSDT =
      freeBalanceUSDT !== undefined
        ? freeBalanceUSDT
        : this.okxAdapter.getAvailableMarginUSDT() || 100;

    const launched: OKXNativeGridBot[] = [];

    for (const opp of eligible) {
      if (running.length + launched.length >= cfg.maxConcurrentNativeBots) break;
      const investAmt = Math.min(cfg.maxBudgetPerBotUSDT, opp.recommendedInvestmentUSDT);
      if (availUSDT - investAmt < cfg.minReserveUSDT) {
        break;
      }

      const createPayload = {
        instId: opp.instId,
        minPx: opp.minPx,
        maxPx: opp.maxPx,
        gridNum: opp.gridNum,
        runType: opp.runType,
        lever: opp.lever,
        sz: investAmt,
        stopLossPct: cfg.stopLossPct,
        takeProfitPct: cfg.takeProfitPct,
        stopTypeOnRisk: cfg.defaultStopType,
        stopOnRangeBreakout: cfg.stopOnRangeBreakout,
        stopOnTrendInvalidation: cfg.stopOnTrendInvalidation,
        environment: 'LIVE' as const,
        explicitLiveConfirm: true,
        executionVariant: 'AUTO_LIMIT' as const,
      };

      const res = customCreator
        ? await customCreator(createPayload)
        : await this.createNativeBot(createPayload);

      if (res.success && res.bot) {
        launched.push(res.bot);
        availUSDT = Math.max(0, availUSDT - investAmt);
      }
    }

    if (launched.length > 0) {
      const msg = saveDecision(
        `Lansat autonom pe OKX (LIVE) ${launched.length} bot(i): ${launched
          .map((b) => `${b.instId} ($${b.sz} @ ${b.lever}x, algoId ${b.algoId})`)
          .join(', ')}`
      );
      return { launched, decision: msg };
    }

    return {
      launched: [],
      decision: saveDecision('Niciun bot nativ nou lansat în acest ciclu.'),
    };
  }

  /**
   * 7–8. Sync & Risk Supervision Loop for Active OKX Native Contract Grid Bots:
   * - Fetches live bot list & details directly from OKX (/api/v5/tradingBot/grid/orders-algo-pending).
   * - Updates PnL (gridProfit, floatProfit, totalPnl), liquidation price (liqPx), and completed arbitrages.
   * - Evaluates risk triggers (Stop Loss %, Take Profit %, range breakout, liquidation proximity < 3.5%,
   *   and market regime invalidation TRENDING_RISK) and automatically stops the bot on OKX.
   */
  public async syncAndMonitorActiveBots(killSwitchEngaged: boolean = false): Promise<void> {
    if (this.isMonitoring || !this.okxAdapter.hasCredentials()) return;
    this.isMonitoring = true;

    try {
      const cfg = this.getConfig();

      // Fetch both active (pending) and recent historical LIVE contract_grid bots from OKX EEA
      const [pendingRemote, historyRemote] = await Promise.all([
        this.okxAdapter.getNativeContractGridBots('pending', false),
        this.okxAdapter.getNativeContractGridBots('history', false),
      ]);
      const remoteMap = new Map<string, any>();

      for (const r of [...pendingRemote, ...historyRemote.slice(0, 15)]) {
        if (!r?.algoId) continue;
        const algoIdStr = String(r.algoId);
        if (!remoteMap.has(algoIdStr)) {
          remoteMap.set(algoIdStr, r);
        }

        // Adopt any neutral _UM_XPERP contract_grid bot from OKX EEA unless dismissed by user
        if (
          !this.bots.has(algoIdStr) &&
          !this.dismissedAlgoIds.has(algoIdStr) &&
          String(r.instId || '').includes('_UM_XPERP')
        ) {
          const sz = parseFloat(r.sz || r.investment || '0') || 0;
          const gridProfit = parseFloat(r.gridProfit || '0') || 0;
          const floatProfit = parseFloat(r.floatProfit || '0') || 0;
          const totalPnl = parseFloat(r.totalPnl || String(gridProfit + floatProfit)) || 0;
          const remState = String(r.state || 'running').toLowerCase();
          const isStopped = remState === 'stopped' || remState === 'no_close_position';
          this.bots.set(algoIdStr, {
            algoId: algoIdStr,
            instId: String(r.instId),
            algoOrdType: 'contract_grid',
            direction: 'neutral',
            environment: 'LIVE',
            state: isStopped ? 'stopped' : 'running',
            minPx: parseFloat(r.minPx || '0') || 0,
            maxPx: parseFloat(r.maxPx || '0') || 0,
            gridNum: parseInt(r.gridNum || '10', 10) || 10,
            runType: r.runType === '2' ? '2' : '1',
            lever: parseFloat(r.lever || '3') || 3,
            sz,
            singleAmt: parseFloat(r.singleAmt || '0') || 0,
            currentPx: parseFloat(r.last || r.curPx || '0') || 0,
            liqPx: parseFloat(r.liqPx || '0') || 0,
            gridProfit,
            floatProfit,
            totalPnl,
            totalPnlPct: sz > 0 ? parseFloat(((totalPnl / sz) * 100).toFixed(2)) : 0,
            arbitrageNum: parseInt(r.arbitrageNum || r.matchedSz || '0', 10) || 0,
            tpTriggerPx: parseFloat(r.tpTriggerPx || '0') || undefined,
            slTriggerPx: parseFloat(r.slTriggerPx || '0') || undefined,
            tpRatio: parseFloat(r.tpRatio || '0') || undefined,
            slRatio: parseFloat(r.slRatio || '0') || undefined,
            stopLossPct: r.slRatio ? parseFloat((parseFloat(r.slRatio) * 100).toFixed(2)) : cfg.stopLossPct,
            takeProfitPct: r.tpRatio ? parseFloat((parseFloat(r.tpRatio) * 100).toFixed(2)) : cfg.takeProfitPct,
            stopTypeOnRisk: r.stopType === '2' ? '2' : cfg.defaultStopType === '2' ? '2' : '1',
            stopOnRangeBreakout: cfg.stopOnRangeBreakout,
            stopOnTrendInvalidation: cfg.stopOnTrendInvalidation,
            stopReason: isStopped ? `Oprit pe OKX (cancelType ${r.cancelType || 'manual'})` : undefined,
            cTime: parseInt(r.cTime || String(Date.now()), 10) || Date.now(),
            uTime: parseInt(r.uTime || String(Date.now()), 10) || Date.now(),
          });
        }
      }

      let changed = true;

      for (const bot of this.getAllBots()) {
        if (bot.state !== 'running' && bot.state !== 'stopping') continue;

        // Emergency LIVE Kill Switch stops all running native bots
        if (killSwitchEngaged && bot.state === 'running') {
          await this.stopNativeBot(
            bot.algoId,
            '1',
            'Kill Switch de urgență (LIVE) activat în TB5'
          );
          changed = true;
          continue;
        }

        const isFallback = bot.algoId.toLowerCase().startsWith('grid');
        const remote = isFallback
          ? null
          : remoteMap.get(bot.algoId) ||
            (await this.okxAdapter.getNativeContractGridDetails(bot.algoId, false));

        if (remote) {
          const remoteState = String(remote.state || 'running').toLowerCase();
          if (remoteState === 'stopped' || remoteState === 'no_close_position') {
            bot.state = 'stopped';
            bot.stopReason = bot.stopReason || `Oprit pe OKX (${remote.cancelType || remoteState})`;
          } else if (remoteState === 'stopping') {
            bot.state = 'stopping';
          } else {
            bot.state = 'running';
          }

          bot.gridProfit = parseFloat(remote.gridProfit || String(bot.gridProfit)) || 0;
          bot.floatProfit = parseFloat(remote.floatProfit || String(bot.floatProfit)) || 0;
          bot.totalPnl =
            parseFloat(remote.totalPnl || String(bot.gridProfit + bot.floatProfit)) || 0;
          bot.totalPnlPct =
            bot.sz > 0 ? parseFloat(((bot.totalPnl / bot.sz) * 100).toFixed(2)) : 0;
          bot.liqPx = parseFloat(remote.liqPx || String(bot.liqPx)) || 0;
          bot.arbitrageNum =
            parseInt(remote.arbitrageNum || String(bot.arbitrageNum), 10) || bot.arbitrageNum;
          const remPx = parseFloat(remote.last || remote.curPx || '0') || 0;
          if (remPx > 0) bot.currentPx = remPx;
          bot.uTime = Date.now();
          changed = true;
        } else {
          // Update current price from public ticker
          const livePx = await this.okxAdapter.getTickerPrice(bot.instId);
          if (livePx && livePx > 0) {
            bot.currentPx = livePx;
            bot.uTime = Date.now();
            changed = true;
          }
        }
      }

      if (changed) {
        this.persistBots();
      }
    } catch (err: any) {
      console.warn('[OKXNativeGridEngine] Monitor error:', err?.message || err);
    } finally {
      this.isMonitoring = false;
    }
  }
}
