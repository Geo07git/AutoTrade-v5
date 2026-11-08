/**
 * AGENT-OWNED UNIVERSE SCAN
 * =============================================================================
 * The DeepSeek agent builds its OWN candidate list from public OKX data. It does NOT
 * consume `NeutralGridAnalyzer` / `UNIVERS SCANNER GRID` scores: a "suitability score"
 * says nothing about how many times a price will cross a grid level, which is the only
 * thing that produces money in a neutral grid.
 *
 * The metric that decides selection here is:
 *
 *   crossingsPerHour = (price path travelled per hour) / (grid step)
 *
 * with a fee floor on the step (a step smaller than ~3x the maker round-trip can never
 * be profitable), and the resulting expected time to the FIRST fill:
 *
 *   expectedFirstFillMin = 60 * (step / 2) / (price speed per hour)
 *
 * Everything in this file is deterministic, network-free (the data source is injected)
 * and unit-tested — see `__tests__/agentUniverseScan.test.ts`.
 */

import type { Kline, NativeGridOpportunity } from '../../shared/types';

// ---------------------------------------------------------------------------
// Hard constants (the agent cannot loosen these)
// ---------------------------------------------------------------------------

/** Deep-analyzed contracts per cycle (25 = 25 kline calls + 25 order books / 5 min). */
export const AGENT_SCAN_DEFAULT_DEEP_COUNT = 25;
/** Contracts below this 24h turnover are not even deep-scanned. */
export const AGENT_SCAN_MIN_TURNOVER_USDT = 3_000_000;
/** A grid step must clear the maker round-trip at least this many times. */
export const AGENT_SCAN_FEE_FLOOR_MULTIPLE = 3;
/** Spread above 25% of the grid step eats the edge. */
export const AGENT_SCAN_MAX_SPREAD_OF_STEP = 0.25;
/** Top-of-book liquidity must cover this multiple of the bot margin. */
export const AGENT_SCAN_MIN_DEPTH_MULTIPLE = 20;
/** Absolute leverage ceiling for agent-opened grids. */
export const AGENT_SCAN_MAX_LEVERAGE = 2;
/** Band half-width bounds, in % of price. */
export const AGENT_SCAN_MIN_HALF_RANGE_PCT = 0.8;
export const AGENT_SCAN_MAX_HALF_RANGE_PCT = 6;

// ---------------------------------------------------------------------------
// Data source contract (implemented by TradeBot, i.e. TB5 = OKX connectivity only)
// ---------------------------------------------------------------------------

export interface AgentContractSpec {
  instId: string;
  minSz: number;
  lotSz: number;
  tickSz: number;
  ctVal: number;
}

export interface AgentUniverseTicker {
  instId: string;
  lastPrice: number;
  turnover24hUSDT: number;
  priceChange24hPct: number;
  high24h: number;
  low24h: number;
  /** (ask - bid) / mid * 100 */
  spreadPct: number;
}

export interface AgentBookSnapshot {
  /** Notional USD resting on the top N levels (bid + ask). */
  depthUsd: number;
  /** -1..+1 */
  imbalance: number;
}

export interface AgentUniverseDataSource {
  listXPerpContracts(): Promise<AgentContractSpec[]>;
  fetchTickers(): Promise<Record<string, AgentUniverseTicker>>;
  fetchKlines15m(instId: string, bars: number): Promise<Kline[]>;
  fetchBookSnapshot(instId: string, depth: number): Promise<AgentBookSnapshot>;
}

export interface AgentScanSettings {
  budgetPerBotUSDT: number;
  maxLeverage: number;
  /** Real maker round-trip cost, e.g. 0.04 (%)  */
  roundTripFeePct: number;
  deepScanCount?: number;
  minTurnover24hUSDT?: number;
  /** Optional funding drag input, keyed by instId (current 8h funding rate %). */
  fundingRatePctByInstId?: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Pure math
// ---------------------------------------------------------------------------

export interface AgentGridMetrics {
  /** Wilder-lite true-range average over 15m bars, in % of price. */
  atrPct: number;
  /** Absolute price path travelled per hour, in % of price. */
  pathPerHourPct: number;
  /** Half of the grid band, in % of price. */
  halfRangePct: number;
  /** Distance between two grid levels, in % of price. */
  stepPct: number;
  gridNum: number;
  /** Level touches per hour (path / step). */
  crossingsPerHour: number;
  /** Expected minutes until the first level is touched. */
  expectedFirstFillMin: number;
  /** Step minus maker round-trip, funding drag and half-spread. */
  netPerGridPct: number;
  spreadPctOfStep: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round = (v: number, d: number) => {
  const f = 10 ** d;
  return Math.round(v * f) / f;
};
const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

/**
 * Derives the grid geometry and the fill statistics from raw 15m candles.
 * Returns null when the tape is unusable (too few bars / non-positive price).
 */
export function computeAgentGridMetrics(input: {
  price: number;
  klines15m: Kline[];
  spreadPct?: number;
  roundTripFeePct: number;
  fundingRatePct?: number;
}): AgentGridMetrics | null {
  const price = Number(input.price);
  if (!Number.isFinite(price) || price <= 0) return null;

  const bars = (input.klines15m || []).filter((k) => k && k.close > 0);
  if (bars.length < 16) return null;

  // --- volatility: average true range, in % of price -------------------------
  const trPct = bars.slice(-14).map((k) => ((k.high - k.low) / k.close) * 100);
  const atrPct = mean(trPct.filter((v) => Number.isFinite(v) && v > 0));
  if (!Number.isFinite(atrPct) || atrPct <= 0) return null;

  // --- activity: absolute path travelled per hour ---------------------------
  const pathBars = bars.slice(-8); // 8 x 15m = 2h
  let pathSum = 0;
  for (let i = 1; i < pathBars.length; i++) {
    pathSum += Math.abs(pathBars[i].close - pathBars[i - 1].close) / pathBars[i].close;
  }
  const hours = (pathBars.length - 1) * 0.25;
  const pathPerHourPct = hours > 0 ? (pathSum / hours) * 100 : 0;

  // --- geometry -------------------------------------------------------------
  const roundTripFeePct = Math.max(0, Number(input.roundTripFeePct) || 0);
  const feeFloor = roundTripFeePct * AGENT_SCAN_FEE_FLOOR_MULTIPLE;

  const halfRangePct = round(
    clamp(1.6 * atrPct, AGENT_SCAN_MIN_HALF_RANGE_PCT, AGENT_SCAN_MAX_HALF_RANGE_PCT),
    2
  );
  const targetStepPct = clamp(0.9 * atrPct, feeFloor, 3);
  let gridNum = Math.round((2 * halfRangePct) / Math.max(targetStepPct, 0.01));
  gridNum = Math.round(clamp(gridNum, 4, 20) / 2) * 2; // even counts keep the pivot centred
  const stepPct = round((2 * halfRangePct) / gridNum, 4);

  // --- fill statistics ------------------------------------------------------
  const crossingsPerHour = stepPct > 0 ? round(pathPerHourPct / stepPct, 3) : 0;
  // Net displacement speed proxy: absolute path overstates direction, ATR understates it.
  const speedPctPerHour = Math.max(pathPerHourPct * 0.5, atrPct * 0.35, 0.0001);
  const expectedFirstFillMin = round((60 * (stepPct / 2)) / speedPctPerHour, 1);

  const spreadPct = Math.max(0, Number(input.spreadPct) || 0);
  const fundingDrag = Math.abs(Number(input.fundingRatePct) || 0) * 0.35;
  const spreadDrag = spreadPct * 0.5;
  const netPerGridPct = round(stepPct - roundTripFeePct - fundingDrag - spreadDrag, 4);

  return {
    atrPct: round(atrPct, 3),
    pathPerHourPct: round(pathPerHourPct, 3),
    halfRangePct,
    stepPct,
    gridNum,
    crossingsPerHour,
    expectedFirstFillMin,
    netPerGridPct,
    spreadPctOfStep: stepPct > 0 ? round(spreadPct / stepPct, 4) : 0,
  };
}

/** Notional value of one minimum-size order, in USD. */
export function computeMinLotNotionalUsd(spec: AgentContractSpec, price: number): number {
  const minSz = spec.minSz > 0 ? spec.minSz : 1;
  const ctVal = spec.ctVal > 0 ? spec.ctVal : 1;
  return round(minSz * ctVal * price, 4);
}

const priceDecimals = (tickSz: number) =>
  tickSz > 0 && Number.isFinite(tickSz) ? Math.max(0, -Math.floor(Math.log10(tickSz) + 1e-9)) : 6;

const snapToTick = (px: number, tickSz: number) => {
  if (!(tickSz > 0)) return round(px, 6);
  return round(Math.round(px / tickSz) * tickSz, priceDecimals(tickSz) + 2);
};

/**
 * Builds one agent-scan opportunity row. Selection is driven by `crossingsPerHour`;
 * `suitabilityScore` is deliberately left at 0 because this scan does not score.
 */
export function buildAgentOpportunity(input: {
  spec: AgentContractSpec;
  ticker: AgentUniverseTicker;
  klines15m: Kline[];
  book: AgentBookSnapshot;
  settings: AgentScanSettings;
}): NativeGridOpportunity | null {
  const { spec, ticker, klines15m, book, settings } = input;
  const fundingRatePct = Number(settings.fundingRatePctByInstId?.[spec.instId] || 0);

  const metrics = computeAgentGridMetrics({
    price: ticker.lastPrice,
    klines15m,
    spreadPct: ticker.spreadPct,
    roundTripFeePct: settings.roundTripFeePct,
    fundingRatePct,
  });
  if (!metrics) return null;

  const price = ticker.lastPrice;
  const lever = clamp(Math.round(settings.maxLeverage) || 1, 1, AGENT_SCAN_MAX_LEVERAGE);
  const budget = Math.max(1, Number(settings.budgetPerBotUSDT) || 0);

  const minLotNotionalUsd = computeMinLotNotionalUsd(spec, price);
  // Margin needed for one lot on every level, at the chosen leverage.
  const minGridMarginUsd = round((minLotNotionalUsd * metrics.gridNum) / lever, 2);
  const feeFloor = Math.max(0, settings.roundTripFeePct) * AGENT_SCAN_FEE_FLOOR_MULTIPLE;

  const reasons: string[] = [];
  let rejectionReason: string | undefined;

  const reject = (reason: string) => {
    if (!rejectionReason) rejectionReason = reason;
  };

  if (metrics.stepPct < feeFloor) {
    reject(
      `Pas ${metrics.stepPct}% sub podeaua de comision (${round(feeFloor, 4)}% = 3x round-trip maker)`
    );
  } else if (metrics.netPerGridPct <= 0) {
    reject(`Profit net/grilă ${metrics.netPerGridPct}% <= 0 după comision + spread + funding`);
  }
  if (metrics.spreadPctOfStep > AGENT_SCAN_MAX_SPREAD_OF_STEP) {
    reject(
      `Spread ${round(metrics.spreadPctOfStep * 100, 1)}% din pas (max ${AGENT_SCAN_MAX_SPREAD_OF_STEP * 100}%)`
    );
  }
  if (minGridMarginUsd > budget) {
    reject(
      `Marjă minimă ${minGridMarginUsd}$ (1 lot x ${metrics.gridNum} grile / ${lever}x) peste bugetul ${budget}$`
    );
  }
  if (book.depthUsd < AGENT_SCAN_MIN_DEPTH_MULTIPLE * budget) {
    reject(
      `Lichiditate top-book ${round(book.depthUsd, 0)}$ sub ${AGENT_SCAN_MIN_DEPTH_MULTIPLE}x bugetul (${AGENT_SCAN_MIN_DEPTH_MULTIPLE * budget}$)`
    );
  }

  const isEligible = !rejectionReason;
  const minPx = snapToTick(price * (1 - metrics.halfRangePct / 100), spec.tickSz);
  const maxPx = snapToTick(price * (1 + metrics.halfRangePct / 100), spec.tickSz);
  const roundTripsPerHour = metrics.crossingsPerHour / 2;
  const dailyYieldPct = round(
    Math.min(200, metrics.netPerGridPct * roundTripsPerHour * 24),
    3
  );

  reasons.push(
    `crossings/h=${metrics.crossingsPerHour} (path ${metrics.pathPerHourPct}%/h / pas ${metrics.stepPct}%)`,
    `prima umplere estimată în ~${metrics.expectedFirstFillMin} min`,
    `ATR15m=${metrics.atrPct}% -> bandă ±${metrics.halfRangePct}% cu ${metrics.gridNum} grile`
  );
  if (!rejectionReason) reasons.push('trece toate porțile agentului');

  return {
    instId: spec.instId,
    price: round(price, priceDecimals(spec.tickSz) + 2),
    volume24hUSDT: round(ticker.turnover24hUSDT, 0),
    priceChange24hPct: round(ticker.priceChange24hPct, 2),
    range24hPct:
      ticker.low24h > 0 ? round(((ticker.high24h - ticker.low24h) / ticker.low24h) * 100, 2) : 0,
    atrPct: metrics.atrPct,
    // Not computed by this scan on purpose: the agent does not rank by these.
    choppinessIndex: 0,
    adxTrendStrength: 0,
    spreadBps: round(ticker.spreadPct * 100, 2),
    openInterestUSD: 0,
    fundingRatePct: round(fundingRatePct, 4),
    nextFundingRatePct: 0,
    orderBookImbalance: round(book.imbalance, 3),
    orderBookDepthUSD: round(book.depthUsd, 0),
    suitabilityScore: 0,
    regimeLabel:
      metrics.crossingsPerHour >= 0.5 && metrics.spreadPctOfStep <= AGENT_SCAN_MAX_SPREAD_OF_STEP
        ? 'IDEAL_RANGE'
        : metrics.atrPct >= 2
          ? 'HIGH_VOL_RANGE'
          : 'LOW_VOLATILITY',
    halfRangePct: metrics.halfRangePct,
    minPx,
    maxPx,
    gridNum: metrics.gridNum,
    runType: '1',
    gridSpacingPct: metrics.stepPct,
    lever,
    // Estimated lower bound (no /min-investment probe in the agent scan); the live create
    // call still enforces OKX's real minimum.
    minInvestmentUSDT: minGridMarginUsd,
    minInvestmentCcy: 'USDT',
    recommendedInvestmentUSDT: round(Math.min(budget, Math.max(minGridMarginUsd, budget)), 2),
    fitsMaxBudget: minGridMarginUsd <= budget,
    estimatedGrossProfitPerGridPct: metrics.stepPct,
    estimatedNetProfitPerGridPct: metrics.netPerGridPct,
    estimatedDailyNetYieldPct: dailyYieldPct,
    isEligible,
    rejectionReason,
    reasons,
    agentScan: true,
    crossingsPerHour: metrics.crossingsPerHour,
    roundTripsPerHour: round(roundTripsPerHour, 3),
    expectedFirstFillMin: metrics.expectedFirstFillMin,
    stepPct: metrics.stepPct,
    updatedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Scanner (network orchestration only — no scoring)
// ---------------------------------------------------------------------------

export class AgentUniverseScanner {
  constructor(
    private data: AgentUniverseDataSource,
    private log?: (message: string, details?: any) => void
  ) {}

  public async scan(settings: AgentScanSettings): Promise<NativeGridOpportunity[]> {
    const startedAt = Date.now();
    const deepCount = clamp(
      Math.round(Number(settings.deepScanCount) || AGENT_SCAN_DEFAULT_DEEP_COUNT),
      1,
      60
    );
    const minTurnover = Math.max(
      AGENT_SCAN_MIN_TURNOVER_USDT,
      Number(settings.minTurnover24hUSDT) || 0
    );

    const [specs, tickers] = await Promise.all([
      this.data.listXPerpContracts(),
      this.data.fetchTickers(),
    ]);

    // Stage 1 — liquidity gate on raw turnover only (no scoring whatsoever).
    const stage1 = specs
      .filter((s) => s.instId.includes('_UM_XPERP'))
      .map((spec) => ({ spec, ticker: tickers[spec.instId] }))
      .filter(
        (r): r is { spec: AgentContractSpec; ticker: AgentUniverseTicker } =>
          !!r.ticker &&
          r.ticker.lastPrice > 0 &&
          r.ticker.turnover24hUSDT >= minTurnover
      )
      .sort((a, b) => b.ticker.turnover24hUSDT - a.ticker.turnover24hUSDT)
      .slice(0, Math.ceil(deepCount * 1.6));

    // Stage 2 — deep scan: candles + book, then the agent's own math.
    const rows: NativeGridOpportunity[] = [];
    const poolSize = 5;
    let cursor = 0;
    const worker = async () => {
      while (cursor < stage1.length) {
        const item = stage1[cursor++];
        try {
          const [klines, book] = await Promise.all([
            this.data.fetchKlines15m(item.spec.instId, 48),
            this.data.fetchBookSnapshot(item.spec.instId, 20),
          ]);
          const row = buildAgentOpportunity({
            spec: item.spec,
            ticker: item.ticker,
            klines15m: klines,
            book,
            settings,
          });
          if (row) rows.push(row);
        } catch (err: any) {
          this.log?.(`[AGENT SCAN] ${item.spec.instId}: ${err?.message || err}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(poolSize, stage1.length) }, worker));

    // Selection order: crossings per hour first (the only thing that pays), then net edge.
    rows.sort((a, b) => {
      if (a.isEligible !== b.isEligible) return a.isEligible ? -1 : 1;
      const ca = a.crossingsPerHour || 0;
      const cb = b.crossingsPerHour || 0;
      if (cb !== ca) return cb - ca;
      return (b.estimatedNetProfitPerGridPct || 0) - (a.estimatedNetProfitPerGridPct || 0);
    });
    rows.forEach((row, idx) => (row.rank = idx + 1));

    this.log?.(
      `[AGENT SCAN] ${rows.length} contracte scanate adânc în ${Date.now() - startedAt} ms, ` +
        `${rows.filter((r) => r.isEligible).length} eligibile (rank = crossings/h)`,
      { deep: rows.length, eligible: rows.filter((r) => r.isEligible).length }
    );

    return rows;
  }
}
