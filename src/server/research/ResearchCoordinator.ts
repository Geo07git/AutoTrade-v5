/**
 * ResearchCoordinator
 * Orchestrates full historical grid research:
 * 1. Data synchronization via HistoricalDataStore
 * 2. Statistical analysis via HistoricalGridResearch
 * 3. Pattern mining & FDR validation via PatternMiner
 * 4. Backtesting, Walk-Forward, and 3-Way comparison via GridBacktestEngine
 * 5. Optimal synthesis recommendation (range, grids, leverage, hours, stop/reset rules)
 */

import { OKXAdapter } from '../exchange/OKXAdapter';
import { HistoricalDataStore } from './HistoricalDataStore';
import {
  HistoricalGridResearch,
  HistoricalResearchReport,
} from './HistoricalGridResearch';
import { PatternMiner, PatternMinerReport } from './PatternMiner';
import {
  GridBacktestEngine,
  BacktestResult,
  WalkForwardResult,
  ComparisonResult,
} from './GridBacktestEngine';
import { GridSpacingType, NeutralGridBotConfig } from '../../shared/types';

export interface GridOptimalRecommendation {
  symbol: string;
  minPx: number;
  maxPx: number;
  gridNum: number;
  runType: '1' | '2'; // 1 = Arithmetic, 2 = Geometric
  recommendedLeverage: number;
  recommendedMarginUSDT: number;
  bestTradingHours: number[];
  stopLossPct: number;
  takeProfitPct: number;
  lowerStopPrice: number;
  upperStopPrice: number;
  stopConditions: string[];
  resetConditions: string[];
  regimeVerdict: string;
  expectedMonthlyRoiPct: number;
  expectedMaxDrawdownPct: number;
  executiveSummaryStatement: string;
}

export interface FullResearchOutput {
  jobId: string;
  symbol: string;
  days: number;
  bar: string;
  createdAt: number;
  recommendation: GridOptimalRecommendation;
  researchReport: HistoricalResearchReport;
  patternReport: PatternMinerReport;
  walkForward: WalkForwardResult;
  comparison: ComparisonResult;
  topConfigurations: BacktestResult[];
}

export interface JobProgress {
  jobId: string;
  symbol: string;
  days: number;
  bar: string;
  status: 'IDLE' | 'RUNNING' | 'COMPLETED' | 'ERROR';
  progressPct: number;
  progressMessage: string;
  result?: FullResearchOutput;
  error?: string;
  startedAt: number;
  completedAt?: number;
}

export class ResearchCoordinator {
  private adapter: OKXAdapter;
  private dataStore: HistoricalDataStore;
  private researchEngine: HistoricalGridResearch;
  private activeJobs: Map<string, JobProgress> = new Map();
  private cachedResults: Map<string, FullResearchOutput> = new Map();

  constructor(adapter: OKXAdapter) {
    this.adapter = adapter;
    this.dataStore = new HistoricalDataStore(adapter);
    this.researchEngine = new HistoricalGridResearch(this.dataStore);
  }

  public getJobStatus(symbol: string, days: number = 90, bar: string = '5m'): JobProgress | null {
    const key = `${this.adapter.normalizeSymbol(symbol)}_${days}_${bar}`;
    return this.activeJobs.get(key) || null;
  }

  public getCachedResult(symbol: string, days: number = 90, bar: string = '5m'): FullResearchOutput | null {
    const key = `${this.adapter.normalizeSymbol(symbol)}_${days}_${bar}`;
    return this.cachedResults.get(key) || null;
  }

  /**
   * Starts a background research job or returns existing active / cached job.
   */
  public async executeOrQueueResearch(
    symbol: string,
    days: number = 90,
    bar: string = '5m',
    forceRefresh: boolean = false
  ): Promise<JobProgress> {
    const instId = this.adapter.normalizeSymbol(symbol);
    const key = `${instId}_${days}_${bar}`;

    // Return cached result if fresh (< 10 minutes) and not forced
    if (!forceRefresh) {
      const cached = this.cachedResults.get(key);
      if (cached && Date.now() - cached.createdAt < 600_000) {
        return {
          jobId: cached.jobId,
          symbol: instId,
          days,
          bar,
          status: 'COMPLETED',
          progressPct: 100,
          progressMessage: 'Rezultat preluat din cache.',
          result: cached,
          startedAt: cached.createdAt,
          completedAt: cached.createdAt,
        };
      }
    }

    // Check if already running
    const existing = this.activeJobs.get(key);
    if (existing && existing.status === 'RUNNING') {
      return existing;
    }

    // Initialize new job
    const jobId = `job_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const job: JobProgress = {
      jobId,
      symbol: instId,
      days,
      bar,
      status: 'RUNNING',
      progressPct: 5,
      progressMessage: `Inițializare cercetare istorică pentru ${instId}...`,
      startedAt: Date.now(),
    };
    this.activeJobs.set(key, job);

    // Run async in background
    this.runResearchPipeline(instId, days, bar, job, key).catch((err) => {
      console.error(`[ResearchCoordinator] Job failed for ${instId}:`, err);
      job.status = 'ERROR';
      job.error = err?.message || 'Eroare internă în procesarea cercetării';
      job.progressMessage = `Eroare: ${job.error}`;
    });

    return job;
  }

  private async runResearchPipeline(
    instId: string,
    days: number,
    bar: string,
    job: JobProgress,
    cacheKey: string
  ): Promise<void> {
    try {
      // Step 1: Statistical Analysis & Profiles
      job.progressPct = 10;
      job.progressMessage = 'Descărcare lumânări și analiză statistică...';

      const researchReport = await this.researchEngine.analyze(
        instId,
        days,
        bar,
        undefined,
        (pct, msg) => {
          job.progressPct = Math.round(10 + pct * 0.35); // 10% to 45%
          job.progressMessage = msg;
        }
      );

      // Step 2: Load complete klines & funding rates for pattern & backtest engines
      job.progressPct = 50;
      job.progressMessage = 'Descărcare istoric funding rate & pattern mining...';

      const [klines, fundingRates] = await Promise.all([
        this.dataStore.loadOrFetchKlines(instId, bar, days),
        this.dataStore.loadOrFetchFunding(instId, days),
      ]);

      // Step 3: Pattern Mining & Event Study
      job.progressPct = 60;
      job.progressMessage = 'Execuție event study, test Student & corecție FDR...';

      const patternReport = PatternMiner.minePatterns(klines, fundingRates, instId);

      // Step 4: Backtesting & Variations
      job.progressPct = 75;
      job.progressMessage = 'Simulare backtest, explorare variații & Walk-Forward...';

      const topConfigurations = GridBacktestEngine.testVariations(klines, instId, fundingRates).slice(0, 8);

      // Step 5: Walk-Forward Validation
      job.progressPct = 85;
      job.progressMessage = 'Validare out-of-sample (Walk-Forward 60z/30z)...';

      const walkForward = GridBacktestEngine.runWalkForward(klines, instId, fundingRates);

      // Step 6: 3-Way Comparison WITHOUT Look-Ahead Bias
      // Train (in-sample) = first 60 days, Test (out-of-sample) = last 30 days
      job.progressPct = 90;
      job.progressMessage = 'Generare comparație 24/7 vs Ore Optime vs Filtre (out-of-sample)...';

      const splitIndex = Math.max(10, Math.floor(klines.length * (60 / 90)));
      const trainKlines = klines.slice(0, splitIndex);
      const testKlines = klines.slice(splitIndex);

      // Learn best hours strictly on in-sample train
      const inSampleProfiles = this.researchEngine.computeProfiles(trainKlines);
      const inSampleBestHours = inSampleProfiles.bestHoursList;

      // Extract valid pattern filters discovered in-sample
      const splitTime = testKlines.length > 0 ? testKlines[0].timestamp : 0;
      const trainFunding = fundingRates.filter((f) => f.fundingTime < splitTime);
      const testFunding = fundingRates.filter((f) => f.fundingTime >= splitTime);
      const inSamplePatternReport = PatternMiner.minePatterns(trainKlines, trainFunding, instId);
      const inSampleValidPatterns = inSamplePatternReport.patterns.filter((p) => p.isValid);

      // Project pattern rules onto testKlines without look-ahead
      const testPatternBlockedIndices = PatternMiner.extractBlockedIndicesForKlines(
        testKlines,
        inSampleValidPatterns,
        testFunding
      );

      // Run 3-way comparison strictly on the 30-day out-of-sample test klines using OOS recommendedConfig
      const bestConfig = walkForward.recommendedConfig;
      const comparison = GridBacktestEngine.runComparison(
        testKlines.length >= 20 ? testKlines : klines,
        bestConfig,
        testFunding.length > 0 ? testFunding : fundingRates,
        inSampleBestHours.length > 0 ? inSampleBestHours : researchReport.bestHoursList,
        testPatternBlockedIndices
      );

      // Step 7: Optimal Recommendation Synthesis
      job.progressPct = 95;
      job.progressMessage = 'Sintetizare parametri optimi și condiții de risc...';

      const recommendation = this.synthesizeRecommendation(
        instId,
        researchReport,
        patternReport,
        walkForward,
        comparison
      );

      const fullOutput: FullResearchOutput = {
        jobId: job.jobId,
        symbol: instId,
        days,
        bar,
        createdAt: Date.now(),
        recommendation,
        researchReport,
        patternReport,
        walkForward,
        comparison,
        topConfigurations,
      };

      job.status = 'COMPLETED';
      job.progressPct = 100;
      job.progressMessage = 'Cercetare finalizată cu succes!';
      job.result = fullOutput;
      job.completedAt = Date.now();

      this.cachedResults.set(cacheKey, fullOutput);
    } catch (err: any) {
      job.status = 'ERROR';
      job.error = err?.message || 'Eroare necunoscută în rularea cercetării';
      job.progressMessage = `Eșec: ${job.error}`;
      throw err;
    }
  }

  /**
   * Synthesizes optimal Neutral Grid configuration parameters and concrete stop/reset rules.
   */
  private synthesizeRecommendation(
    symbol: string,
    research: HistoricalResearchReport,
    patterns: PatternMinerReport,
    wf: WalkForwardResult,
    comp: ComparisonResult
  ): GridOptimalRecommendation {
    const curPrice = research.regime.currentPrice;
    const vp = research.volumeProfile;
    const p95Excursion = patterns.gridExcursion.percentilesExcursionPct.p95 || 3.5;
    const p99Excursion = patterns.gridExcursion.percentilesExcursionPct.p99 || 5.5;

    // Anchor bounds: blend Walk-Forward optimized bounds with Volume Profile Value Area & 95th excursion
    let lowerPx = wf.recommendedConfig.lowerPrice;
    let upperPx = wf.recommendedConfig.upperPrice;

    // Ensure bounds bracket current price
    if (lowerPx >= curPrice || upperPx <= curPrice) {
      lowerPx = parseFloat((curPrice * (1 - p95Excursion / 100)).toFixed(4));
      upperPx = parseFloat((curPrice * (1 + p95Excursion / 100)).toFixed(4));
    }

    // Grid count: prefer 8, 10, or 12 to ensure spacing clears maker fee
    const gridNum = Math.max(6, Math.min(16, wf.recommendedConfig.gridCount || 8));
    const runType: '1' | '2' = wf.recommendedConfig.gridType === 'GEOMETRIC' ? '2' : '1';

    // Recommended leverage: 2x if regime is high trend risk, 3x-4x for normal oscillation, 5x for ideal chop
    let recommendedLeverage = 3;
    if (research.regime.overallRegime === 'IDEAL_GRID') recommendedLeverage = 4;
    else if (research.regime.overallRegime === 'HIGH_TREND_RISK') recommendedLeverage = 2;

    const stopLossPct = Math.min(25, Math.max(8, parseFloat((p99Excursion * 1.5).toFixed(1))));
    const takeProfitPct = Math.min(50, Math.max(15, parseFloat((p99Excursion * 2.8).toFixed(1))));

    const lowerStopPrice = parseFloat((lowerPx * (1 - 0.02)).toFixed(4));
    const upperStopPrice = parseFloat((upperPx * (1 + 0.02)).toFixed(4));

    // Stop and Reset conditions
    const stopConditions: string[] = [
      `Ieșire de urgență (Stop Loss) dacă prețul atinge $${lowerStopPrice} sau $${upperStopPrice} (+${stopLossPct}% pierdere).`,
      `Pauză automată dacă se înregistrează un spike de volum > 3x MA(20) cu lumânare direcțională mare.`,
      `Dezactivare grilă dacă ADX(14) depășește pragul de 32 (regim de trend puternic detectat).`,
    ];

    const resetConditions: string[] = [
      `Recentrare grilă (Re-Anchor) dacă prețul revine la Point of Control ($${vp.pocPrice}) după o excursie laterală.`,
      `Reluare activitate grilă în orele recomandate (${research.bestHoursList.slice(0, 6).join(', ')} UTC).`,
      `Reducere număr trepte la 6 dacă volatilitatea scade sub 0.4% pe oră.`,
    ];

    const monthlyRoi = comp.bestHoursMode.netPnLPct > 0
      ? comp.bestHoursMode.annualizedRoiPct / 12
      : comp.mode247.annualizedRoiPct / 12;

    const recommendedMarginUSDT = 50;

    // Readable executive recommendation sentence requested by user
    let hoursStr = '24/7 (Toate orele)';
    if (research.bestHoursList && research.bestHoursList.length > 0) {
      const sortedHours = [...new Set(research.bestHoursList)].sort((a, b) => a - b);
      if (sortedHours.length <= 8) {
        hoursStr = sortedHours.map((h) => `${h.toString().padStart(2, '0')}:00`).join(', ') + ' UTC';
      } else {
        const topHours = sortedHours.slice(0, 6).map((h) => `${h.toString().padStart(2, '0')}:00`).join(', ');
        hoursStr = `${topHours} (+${sortedHours.length - 6} ore) UTC`;
      }
    }

    const gridTypeText = runType === '2' ? 'geometrice' : 'aritmetice';
    const executiveSummaryStatement = `Folosiți în intervalul orar ${hoursStr}, când prețul este între $${lowerPx} și $${upperPx}, suma recomandată a fi investită = ${recommendedMarginUSDT} USDT (la un levier de ${recommendedLeverage}x cu ${gridNum} grile ${gridTypeText}).`;

    return {
      symbol,
      minPx: lowerPx,
      maxPx: upperPx,
      gridNum,
      runType,
      recommendedLeverage,
      recommendedMarginUSDT,
      bestTradingHours: research.bestHoursList,
      stopLossPct,
      takeProfitPct,
      lowerStopPrice,
      upperStopPrice,
      stopConditions,
      resetConditions,
      regimeVerdict: research.regime.overallRegime,
      expectedMonthlyRoiPct: parseFloat(monthlyRoi.toFixed(2)),
      expectedMaxDrawdownPct: comp.mode247.maxDrawdownPct,
      executiveSummaryStatement,
    };
  }
}
