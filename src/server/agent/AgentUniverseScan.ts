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
import {
  deriveGridGeometry,
  maxLeverageForBand,
  priceDecimals,
  snapToTick,
  GRID_DEFAULT_TARGET_HOLDING_HOURS,
  GRID_FEE_FLOOR_MULTIPLE,
  GRID_MAX_HALF_RANGE_PCT,
  GRID_MAX_SPREAD_OF_STEP,
  GRID_MIN_HALF_RANGE_PCT,
  GRID_PLAN_MAX_LEVERAGE,
} from '../engine/grid/gridPlan';
import { buildConstructedBand } from './gridBand';
import {
  efficiencyRatioFromKlines,
  isDisplacedRegime,
  GRID_ER_SCAN_BARS,
  GRID_ER_TREND_THRESHOLD,
} from '../engine/grid/gridRegime';

// ---------------------------------------------------------------------------
// Hard constants (the agent cannot loosen these)
// ---------------------------------------------------------------------------

/** Deep-analyzed contracts per cycle (25 = 25 kline calls + 25 order books / 5 min). */
export const AGENT_SCAN_DEFAULT_DEEP_COUNT = 25;
/** Contracts below this 24h turnover are not even deep-scanned. */
export const AGENT_SCAN_MIN_TURNOVER_USDT = 3_000_000;
/**
 * These are aliases, not copies: the geometry constants live in `engine/grid/gridPlan.ts`,
 * which the execution path uses too. Two copies of "the fee floor is 3x" is exactly how a
 * grid ends up ranked on one geometry and opened on another.
 */
/** A grid step must clear the maker round-trip at least this many times. */
export const AGENT_SCAN_FEE_FLOOR_MULTIPLE = GRID_FEE_FLOOR_MULTIPLE;
/** Spread above 25% of the grid step eats the edge. */
export const AGENT_SCAN_MAX_SPREAD_OF_STEP = GRID_MAX_SPREAD_OF_STEP;
/** Top-of-book liquidity must cover this multiple of the bot margin. */
export const AGENT_SCAN_MIN_DEPTH_MULTIPLE = 20;
/** Absolute leverage ceiling for agent-opened grids (same ceiling the plan builder enforces). */
export const AGENT_SCAN_MAX_LEVERAGE = GRID_PLAN_MAX_LEVERAGE;
/** Band half-width bounds, in % of price. */
export const AGENT_SCAN_MIN_HALF_RANGE_PCT = GRID_MIN_HALF_RANGE_PCT;
export const AGENT_SCAN_MAX_HALF_RANGE_PCT = GRID_MAX_HALF_RANGE_PCT;

/**
 * Holding horizon the band is sized for, in hours. Alias of the plan builder's default so the
 * scan cannot rank a band that the execution path would size differently.
 */
export const AGENT_SCAN_TARGET_HOLDING_HOURS = GRID_DEFAULT_TARGET_HOLDING_HOURS;
/**
 * A candidate must fit at least this many round-trips inside the holding horizon.
 *
 * Three because the accounting is asymmetric: every round-trip is taxed by the maker round-trip
 * and the grid ALSO pays a half-spread and (eventually) a forced exit. Two round-trips do not
 * clear that; the number that separates "a bot that trades" from "a bot that locks 12 USDT and
 * pays an exit" is three, which is also what the live sample showed was never reached.
 */
export const AGENT_SCAN_MIN_ROUND_TRIPS_IN_HORIZON = 3;
/** 1h bars fetched per contract for the regime ATR (24 = one day of hourly bars). */
export const AGENT_SCAN_REGIME_BARS_1H = 24;

/** Elite pool size (how many of the whole universe keep their candles). */
export const AGENT_SCAN_POOL_SIZE = 50;
/** Pool lifetime before it is re-picked from the whole universe. */
export const AGENT_SCAN_POOL_REFRESH_MINUTES = 180;
/** Cheap-stage spread ceiling: above this the grid loses the edge before it fills. */
export const AGENT_SCAN_POOL_MAX_SPREAD_PCT = 0.25;
/** Spread assumed when the snapshot does not carry one (so a contract is RANKED, not dropped). */
export const AGENT_SCAN_POOL_ASSUMED_SPREAD_PCT = 0.05;

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
  /**
   * 1h candles: the REGIME the band is sized on. The 15m tape decides the step, but a band that
   * has to survive several hours is measured in hourly movement — the two are not interchangeable.
   */
  fetchKlines1h(instId: string, bars: number): Promise<Kline[]>;
  fetchBookSnapshot(instId: string, depth: number): Promise<AgentBookSnapshot>;
}

/**
 * How the agent picks WHICH contracts to deep-scan each cycle.
 *
 * - `pool` (default): TWO stages instead of one long turn.
 *     1. CHEAP full sweep — the tickers snapshot already contains all ~260 `_UM_XPERP`
 *        contracts in ONE request, so ranking the whole universe no longer costs 11 cycles. Every
 *        contract is scored without candles: `(high-low)% / spread%` (path worth crossing per
 *        unit of spread), gated by a turnover floor and a spread ceiling.
 *     2. ELITE POOL — the best `poolSize` (50) of that ranking are the only contracts that get
 *        candles. `deepScanCount` (25) of them are deep-scanned per cycle, rotating inside the
 *        pool, so the pool is fully re-measured every 2 cycles (40 min) instead of every 11
 *        cycles (3.7 h). The pool is re-picked from the whole universe every
 *        `poolRefreshMinutes` (180).
 *   Why this beats plain rotation: rotation spent 10 of its 11 cycles deep-scanning contracts
 *   that the cheap snapshot could already tell were unusable, and a good contract was only
 *   re-measured once every 3.7 h - by which time its chop was gone.
 * - `rotation` (rollback): every contract is eligible, each cycle takes the next alphabetical
 *   window, one turn = `ceil(total / deepScanCount)` cycles, no turnover gate.
 * - `turnover` (legacy rollback): top-N by 24h turnover with the 3M floor.
 */
export type AgentUniverseScanMode = 'pool' | 'rotation' | 'turnover';

/**
 * Normalises a persisted/forwarded scan mode.
 *
 * An absent or unrecognised value falls back to `pool` — never to a *different* valid mode.
 * That distinction is not cosmetic: the pipeline used to collapse every non-`turnover` mode
 * into `rotation` (`opts.universeScanMode === 'turnover' ? 'turnover' : 'rotation'`), so a
 * config asking for the pool was silently served a rotation. The scan still produced rows, so
 * nothing looked broken: `.data/agent_scan_cursor.json` kept advancing while
 * `.data/agent_scan_pool.json` stayed empty forever. Mapping one valid mode onto another is
 * indistinguishable from working, which is why the resolution lives in one tested place.
 */
export function resolveAgentScanMode(mode?: AgentUniverseScanMode): AgentUniverseScanMode {
  return mode === 'turnover' || mode === 'rotation' || mode === 'pool' ? mode : 'pool';
}

/**
 * Persisted rotation position. Injected so the scanner stays free of I/O and testable;
 * TradeBot backs it with a JsonStore. A failed load must degrade to 0, never throw.
 */
export interface AgentScanCursorStore {
  load(): number;
  save(cursor: number): void;
}

/** Persisted elite pool (pool mode). Same contract as the cursor: degraded load must not throw. */
export interface AgentScanPoolState {
  /** Pooled instIds, best cheap score first. */
  pool: string[];
  /** When the pool was picked (Unix ms). */
  builtAt: number;
  /** Rotation cursor INSIDE the pool (so the pool is covered in ceil(size / deepScanCount) cycles). */
  cursor: number;
  /** Cheap scores, for the audit trail and for explaining a pool rebuild. */
  scores?: Record<string, number>;
}

export interface AgentScanPoolStore {
  load(): AgentScanPoolState | null;
  save(state: AgentScanPoolState): void;
}

export interface AgentScanSettings {
  budgetPerBotUSDT: number;
  maxLeverage: number;
  /** Hard margin stop (agent guardrail, % of margin). Caps the leverage a wide band can carry. */
  hardStopLossPct?: number;
  /** Real maker round-trip cost, e.g. 0.04 (%)  */
  roundTripFeePct: number;
  deepScanCount?: number;
  minTurnover24hUSDT?: number;
  /** 'pool' (default) = top-N by cheap 24h ranking, deep-scanned every cycle, pool rebuilt
   *  every `poolRefreshMinutes`; 'rotation' / 'turnover' kept for instant rollback. */
  universeScanMode?: AgentUniverseScanMode;
  /** How many contracts the elite pool holds (default 50). */
  poolSize?: number;
  /** How long the elite pool lives before it is re-picked from the whole universe (default 180). */
  poolRefreshMinutes?: number;
  /** Optional funding drag input, keyed by instId (current 8h funding rate %). */
  fundingRatePctByInstId?: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Pure math
// ---------------------------------------------------------------------------

export interface AgentGridMetrics {
  /** Wilder-lite true-range average over 15m bars, in % of price. Drives the step. */
  atrPct: number;
  /** True-range average over 1h bars, in % of price. Drives the band. */
  atrPct1h: number;
  /** Holding horizon the band was sized for, in hours. */
  targetHoldingHours: number;
  /** Median hours until the band edge is touched at the measured 15m ATR. */
  expectedLifetimeHours: number;
  /** Absolute price path travelled per hour, in % of price. */
  pathPerHourPct: number;
  /** Half of the grid band, in % of price. */
  halfRangePct: number;
  /** Distance between two grid levels, in % of price. */
  stepPct: number;
  gridNum: number;
  /** Level touches per hour (path / step). */
  crossingsPerHour: number;
  /**
   * Kaufman efficiency ratio of the 15m tape over the holding horizon (0..1), `null` when it
   * cannot be measured.
   *
   * `crossingsPerHour` counts DISTANCE travelled, which is large in chop AND in a pump — that is
   * how H / LINK / HYPE ranked #1 and died in 2-6 minutes. ER is the same window's NET
   * displacement over that path: near 0 = oscillation (what a neutral grid needs), near 1 = a
   * one-way move (what kills it).
   */
  efficiencyRatio: number | null;
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
 * Derives the grid geometry and the fill statistics from raw candles.
 * Returns null when the tape is unusable (too few bars / non-positive price).
 *
 * `klines1h` is the REGIME input: the band is sized on hourly movement over the holding horizon,
 * the step on 15m movement. When it is absent the plan builder scales the 15m ATR by sqrt(4),
 * which is the same random-walk assumption the horizon maths already makes.
 */
export function computeAgentGridMetrics(input: {
  price: number;
  klines15m: Kline[];
  klines1h?: Kline[];
  targetHoldingHours?: number;
  spreadPct?: number;
  roundTripFeePct: number;
  fundingRatePct?: number;
}): AgentGridMetrics | null {
  const price = Number(input.price);
  if (!Number.isFinite(price) || price <= 0) return null;

  const bars = (input.klines15m || []).filter((k) => k && k.close > 0);
  if (bars.length < 16) return null;

  // --- volatility: average true range, in % of price -------------------------
  const trueRangePct = (k: Kline): number => ((k.high - k.low) / k.close) * 100;
  const atrPct = mean(bars.slice(-14).map(trueRangePct).filter((v) => Number.isFinite(v) && v > 0));
  if (!Number.isFinite(atrPct) || atrPct <= 0) return null;

  // --- regime: the same measure on 1h bars (ignored when there are too few) --
  const regimeBars = (input.klines1h || []).filter((k) => k && k.close > 0);
  const regimeAtr = regimeBars.length >= 8
    ? mean(regimeBars.slice(-14).map(trueRangePct).filter((v) => Number.isFinite(v) && v > 0))
    : 0;
  const atrPct1h = Number.isFinite(regimeAtr) && regimeAtr > 0 ? regimeAtr : undefined;

  // --- activity: absolute path travelled per hour ---------------------------
  const pathBars = bars.slice(-8); // 8 x 15m = 2h
  let pathSum = 0;
  for (let i = 1; i < pathBars.length; i++) {
    pathSum += Math.abs(pathBars[i].close - pathBars[i - 1].close) / pathBars[i].close;
  }
  const hours = (pathBars.length - 1) * 0.25;
  const pathPerHourPct = hours > 0 ? (pathSum / hours) * 100 : 0;

  // --- direction: how much of that path went somewhere ----------------------
  // Same tape, same idea, but measuring DISPLACEMENT instead of distance. Window = the holding
  // horizon, because that is the question the band is sized on: "does it oscillate for 8h?".
  const efficiencyRatio = efficiencyRatioFromKlines(bars, GRID_ER_SCAN_BARS);

  // --- geometry -------------------------------------------------------------
  // Delegated to the plan builder: the band / level count / step formula has exactly one
  // implementation in this repo, and `gridPlan.test.ts` locks this parity.
  const geo = deriveGridGeometry({
    atrPct,
    atrPct1h,
    targetHoldingHours: input.targetHoldingHours,
    roundTripFeePct: input.roundTripFeePct,
    spreadPct: input.spreadPct,
    fundingRatePct: input.fundingRatePct,
  });
  if (!geo) return null;
  const { halfRangePct, gridNum, stepPct, netPerGridPct, spreadPctOfStep } = geo;

  // --- fill statistics ------------------------------------------------------
  const crossingsPerHour = stepPct > 0 ? round(pathPerHourPct / stepPct, 3) : 0;
  // Net displacement speed proxy: absolute path overstates direction, ATR understates it.
  const speedPctPerHour = Math.max(pathPerHourPct * 0.5, atrPct * 0.35, 0.0001);
  const expectedFirstFillMin = round((60 * (stepPct / 2)) / speedPctPerHour, 1);

  return {
    atrPct: geo.atrPct,
    atrPct1h: geo.atrPct1h,
    targetHoldingHours: geo.targetHoldingHours,
    expectedLifetimeHours: geo.expectedLifetimeHours,
    pathPerHourPct: round(pathPerHourPct, 3),
    efficiencyRatio,
    halfRangePct,
    stepPct,
    gridNum,
    crossingsPerHour,
    expectedFirstFillMin,
    netPerGridPct,
    spreadPctOfStep,
  };
}

/** Notional value of one minimum-size order, in USD. */
export function computeMinLotNotionalUsd(spec: AgentContractSpec, price: number): number {
  const minSz = spec.minSz > 0 ? spec.minSz : 1;
  const ctVal = spec.ctVal > 0 ? spec.ctVal : 1;
  return round(minSz * ctVal * price, 4);
}

/**
 * Builds one agent-scan opportunity row. Selection is driven by `crossingsPerHour`;
 * `suitabilityScore` is deliberately left at 0 because this scan does not score.
 */
export function buildAgentOpportunity(input: {
  spec: AgentContractSpec;
  ticker: AgentUniverseTicker;
  klines15m: Kline[];
  klines1h?: Kline[];
  book: AgentBookSnapshot;
  settings: AgentScanSettings;
}): NativeGridOpportunity | null {
  const { spec, ticker, klines15m, book, settings } = input;
  const fundingRatePct = Number(settings.fundingRatePctByInstId?.[spec.instId] || 0);

  const metrics = computeAgentGridMetrics({
    price: ticker.lastPrice,
    klines15m,
    klines1h: input.klines1h,
    targetHoldingHours: AGENT_SCAN_TARGET_HOLDING_HOURS,
    spreadPct: ticker.spreadPct,
    roundTripFeePct: settings.roundTripFeePct,
    fundingRatePct,
  });
  if (!metrics) return null;

  const price = ticker.lastPrice;

  // WHERE the band sits is a market-structure question, not a rounding of the last tick.
  // `price +- halfRange` centred the window on one trade: the edges were arbitrary and could
  // land straight on the 24 h low/high, so one breakout filled every level in one direction at
  // the moment the desk was maximally wrong. The step is UNTOUCHED (width = gridNum * step), so
  // every fill statistic above keeps the exact value it was ranked on; only the placement moves.
  const band = buildConstructedBand({
    price,
    low24h: ticker.low24h,
    high24h: ticker.high24h,
    widthPct: metrics.halfRangePct * 2,
    gridNum: metrics.gridNum,
    tickSz: spec.tickSz,
    klines15m,
  });

  // Leverage is not a free knob: `stopLossPct` is in % of MARGIN, so at leverage L a 1% adverse
  // price move costs L% of margin. Walking to the band edge must stay under the hard guardrail,
  // hence lever <= hardStopLossPct / walk. A CONSTRUCTED band can sit off-centre, so the walk is
  // no longer `halfRangePct`: if price sits near the lower edge, the distance the leverage must
  // survive is the UPPER side, and `maxSidePct` is exactly that number.
  const adverseWalkPct = band.ok ? band.maxSidePct : metrics.halfRangePct;
  const riskCeiling = maxLeverageForBand(
    adverseWalkPct,
    Number(settings.hardStopLossPct) || 12,
    AGENT_SCAN_MAX_LEVERAGE
  );
  const lever = clamp(Math.round(settings.maxLeverage) || 1, 1, riskCeiling);
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

  // REGIME gate — the one the live run was missing.
  //
  // `crossingsPerHour` measures DISTANCE, so a pump ranks exactly as high as a chop. The audit's
  // worst live bots (H: 2 minutes, LINK: 6, HYPE: 4, PIEVERSE: -2.25 USDT) were all selected on
  // huge paths produced by a ONE-WAY move: the grid opened and the price walked out of it. ER > 0.4
  // means 40% of the travel went in a single direction — a trend, not an oscillation — and no
  // number of crossings inside a trend ever pays for the exit it forces.
  //
  // Deliberately the FIRST gate: when a candidate is refused, the reason shown in the scan
  // diagnostics must be the structural one, not a downstream consequence.
  if (isDisplacedRegime(metrics.efficiencyRatio)) {
    reject(
      `Regim de deplasare: ER ${metrics.efficiencyRatio} > ${GRID_ER_TREND_THRESHOLD} — prețul ` +
        `călătorește într-o direcție în loc să oscileze (gridul neutru e scurt pe această mișcare)`
    );
  }

  if (metrics.stepPct < feeFloor) {    reject(
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
  // HORIZON gate: the band is now wide enough to survive the holding horizon, so a tape that is
  // too slow to cross it inside that horizon has to be refused here — otherwise the bot simply
  // sits on locked margin until the stagnation stop rescues it (the live failure: 0-3
  // arbitrages in a 50-minute life, every round-trip eaten by the exit).
  //
  // One round-trip is one STEP of travel, and the first touch happens after HALF a step, so the
  // expected duration of a round-trip is twice `expectedFirstFillMin` — not once.
  const horizonMinutes = round(metrics.targetHoldingHours * 60, 2);
  const expectedRoundTripMin = Math.max(0.02, metrics.expectedFirstFillMin * 2);
  const roundTripsInHorizon = round(horizonMinutes / expectedRoundTripMin, 2);
  if (roundTripsInHorizon < AGENT_SCAN_MIN_ROUND_TRIPS_IN_HORIZON) {
    reject(
      `Prea puține round-trip-uri în orizontul de ${metrics.targetHoldingHours}h: prima umplere la ` +
        `~${metrics.expectedFirstFillMin} min (încape ${roundTripsInHorizon}x, minim ${AGENT_SCAN_MIN_ROUND_TRIPS_IN_HORIZON})`
    );
  }
  // ADVISORY, not a gate — and no longer a venue query either.
  //
  // This number is `1 lot x gridNum / lever` computed LOCALLY. An X-Perp grid never reaches
  // OKX's grid algo gateway (51000/51001), so it runs as our own limit orders and OKX's
  // `min-investment` answer does not describe it: the margin is a budget decision, and a level
  // that cannot afford a full lot is placed with the minimum lot while the rest of the grid
  // stays virtual. Kept on the row so the UI can show the sizing target.
  const requiresLiveProbe = minGridMarginUsd > budget;
  if (requiresLiveProbe) {
    reasons.push(
      `marjă estimată ${minGridMarginUsd}$ peste bugetul ${budget}$ (1 lot x ${metrics.gridNum} grile / ${lever}x)` +
        ` — nivelurile care nu încap pe un lot primesc lotul minim, restul grilei rămâne virtual`
    );
  }
  if (book.depthUsd < AGENT_SCAN_MIN_DEPTH_MULTIPLE * budget) {
    reject(
      `Lichiditate top-book ${round(book.depthUsd, 0)}$ sub ${AGENT_SCAN_MIN_DEPTH_MULTIPLE}x bugetul (${AGENT_SCAN_MIN_DEPTH_MULTIPLE * budget}$)`
    );
  }

  // The hard placement rule is a GATE, not a note in the prompt: a band whose edge lands within
  // the proximity margin of the 24 h extreme breaks out on the next new high/low and fills every
  // level at once. If no legal window exists the candidate is refused, not silently re-centred.
  if (!band.ok) {
    reject(
      `Bandă refuzată: ${band.reason || 'fără fereastră legală față de extremele de 24h'}`
    );
  }

  const isEligible = !rejectionReason;
  // Kept displayable even when refused: the row still shows the geometry it would have used.
  const minPx = band.ok
    ? band.minPx
    : snapToTick(price * (1 - metrics.halfRangePct / 100), spec.tickSz);
  const maxPx = band.ok
    ? band.maxPx
    : snapToTick(price * (1 + metrics.halfRangePct / 100), spec.tickSz);
  const roundTripsPerHour = metrics.crossingsPerHour / 2;
  const dailyYieldPct = round(
    Math.min(200, metrics.netPerGridPct * roundTripsPerHour * 24),
    3
  );

  reasons.push(
    `crossings/h=${metrics.crossingsPerHour} (path ${metrics.pathPerHourPct}%/h / pas ${metrics.stepPct}%)`,
    `ER=${metrics.efficiencyRatio === null ? 'n/a' : metrics.efficiencyRatio} ` +
      `(${isDisplacedRegime(metrics.efficiencyRatio) ? 'deplasare' : 'oscilație'}, prag ${GRID_ER_TREND_THRESHOLD})`,
    `prima umplere estimată în ~${metrics.expectedFirstFillMin} min`,
    `bandă dimensionată pe orizontul de ${metrics.targetHoldingHours}h: ATR1h=${metrics.atrPct1h}% -> ` +
      `±${metrics.halfRangePct}% (atingerea marginii în ~${metrics.expectedLifetimeHours}h)`,
    `ATR15m=${metrics.atrPct}% -> pas ${metrics.stepPct}% cu ${metrics.gridNum} grile`
  );
  reasons.push(
    band.ok
      ? `bandă ${band.method === 'CONSTRUCTED' ? 'construită pe zona de oscilație' : 'simetrică (fallback)'}: ` +
          `${round(minPx, 6)}..${round(maxPx, 6)} (jos ${band.lowerSidePct}% / sus ${band.upperSidePct}% față de preț)`
      : `bandă refuzată: ${band.reason || 'fără fereastră legală'}`
  );
  reasons.push(...band.notes);
  if (!rejectionReason) reasons.push('trece toate porțile agentului');

  return {
    instId: spec.instId,
    price: round(price, priceDecimals(spec.tickSz) + 2),
    volume24hUSDT: round(ticker.turnover24hUSDT, 0),
    priceChange24hPct: round(ticker.priceChange24hPct, 2),
    range24hPct:
      ticker.low24h > 0 ? round(((ticker.high24h - ticker.low24h) / ticker.low24h) * 100, 2) : 0,
    atrPct: metrics.atrPct,
    // The regime the band was sized on, and what the band actually buys in hours.
    atrPct1h: metrics.atrPct1h,
    targetHoldingHours: metrics.targetHoldingHours,
    expectedLifetimeHours: metrics.expectedLifetimeHours,
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
    regimeLabel: isDisplacedRegime(metrics.efficiencyRatio)
      ? 'TRENDING_RISK'
      : metrics.crossingsPerHour >= 0.5 && metrics.spreadPctOfStep <= AGENT_SCAN_MAX_SPREAD_OF_STEP
        ? 'IDEAL_RANGE'
        : metrics.atrPct >= 2
          ? 'HIGH_VOL_RANGE'
          : 'LOW_VOLATILITY',
    efficiencyRatio: metrics.efficiencyRatio,
    halfRangePct: metrics.halfRangePct,
    minPx,
    maxPx,
    // The extremes travel with the row: the execution guard re-checks the MODEL's band against
    // them with a function that shares no assumptions with this builder.
    low24h: ticker.low24h,
    high24h: ticker.high24h,
    bandMethod: band.method,
    gridNum: metrics.gridNum,
    runType: '1',
    gridSpacingPct: metrics.stepPct,
    lever,
    // Estimated lower bound (no venue query in the agent scan); this is the sizing target the
    // agent uses before the budget cap is applied.
    minInvestmentUSDT: minGridMarginUsd,
    minInvestmentCcy: 'USDT',
    recommendedInvestmentUSDT: round(Math.min(budget, Math.max(5, minGridMarginUsd)), 2),
    fitsMaxBudget: minGridMarginUsd <= budget,
    requiresLiveProbe,
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
// Rotation
// ---------------------------------------------------------------------------

export interface RotationWindow<T> {
  items: T[];
  /** Index this window started at. */
  start: number;
  /** Index the next cycle must start at (already wrapped into range). */
  nextCursor: number;
  total: number;
  /** Cycles needed to look at every item once at this window size. */
  cyclesForFullCoverage: number;
}

/**
 * Slice the next window out of a stable, ordered list.
 *
 * One "turn" is one exact pass over the list: the final window of a turn is TRUNCATED to what
 * is left (never wrapped around), so no item is scanned twice in a turn and the cursor always
 * returns to 0 when the turn ends. With 25/259 that means ten full windows of 25 and a last
 * window of 9 — drifting into a wrapped window instead (250..274) would overlap and leave the
 * cursor parked off-zero forever.
 *
 * Pure and total: an empty list yields an empty window, an out-of-range cursor is normalised,
 * and a window larger than the list returns everything.
 */
export function selectRotationWindow<T>(
  items: T[],
  cursor: number,
  size: number
): RotationWindow<T> {
  const total = items.length;
  if (total === 0) {
    return { items: [], start: 0, nextCursor: 0, total: 0, cyclesForFullCoverage: 0 };
  }
  const rawSize = Math.round(Number(size) || 0);
  const count = Math.min(total, Math.max(1, rawSize || 1));
  const rawCursor = Math.round(Number(cursor) || 0);
  const start = ((rawCursor % total) + total) % total;
  // Truncate at the end of the list: this closes the turn instead of wrapping into an overlap.
  const take = Math.min(count, total - start);
  const picked = items.slice(start, start + take);
  const closesTurn = start + take >= total;
  return {
    items: picked,
    start,
    nextCursor: closesTurn ? 0 : start + take,
    total,
    cyclesForFullCoverage: Math.ceil(total / count),
  };
}

// ---------------------------------------------------------------------------
// Elite pool (cheap ranking of the WHOLE universe — no candles)
// ---------------------------------------------------------------------------

export interface AgentPoolCandidate {
  instId: string;
  /** 24h range % divided by spread % — path worth crossing per unit of cost. */
  score: number;
  range24hPct: number;
  spreadPct: number;
  turnover24hUSDT: number;
}

/**
 * Rank the ENTIRE universe from a single tickers snapshot and keep the best `size`.
 *
 * Deliberately candle-free: one `fetchTickers()` already returns every `_UM_XPERP` contract, so
 * the whole universe can be scored on every cycle. This is what removes the need for a long
 * rotation turn — the sweep is complete each cycle, and only the top slice pays for candles.
 *
 * Score = 24h range / spread: a neutral grid is paid by the price travelling across its levels
 * (range) and taxed by the spread it crosses to get there. Turnover and spread are GATES, not
 * ranking keys — ranking by turnover (the old legacy mode) rewards popularity, not chop.
 *
 * Total and pure: a missing/zero spread is scored with a typical value instead of being silently
 * dropped (the deep stage measures the real book), and an empty result is returned as-is so the
 * caller can decide to fall back.
 */
export function rankElitePool(
  tickers: AgentUniverseTicker[],
  opts: { minTurnoverUSDT?: number; maxSpreadPct?: number; size?: number } = {}
): AgentPoolCandidate[] {
  const minTurnover = Math.max(0, Number(opts.minTurnoverUSDT) || 0);
  const maxSpread =
    Number(opts.maxSpreadPct) > 0
      ? Number(opts.maxSpreadPct)
      : AGENT_SCAN_POOL_MAX_SPREAD_PCT;
  const size = clamp(Math.round(Number(opts.size) || AGENT_SCAN_POOL_SIZE), 1, 260);

  const out: AgentPoolCandidate[] = [];
  for (const t of tickers || []) {
    if (!t || !t.instId || !(t.lastPrice > 0)) continue;
    if (!(t.turnover24hUSDT >= minTurnover)) continue;
    const spreadPct =
      t.spreadPct > 0 ? t.spreadPct : AGENT_SCAN_POOL_ASSUMED_SPREAD_PCT;
    if (spreadPct > maxSpread) continue;
    const range24hPct =
      t.high24h > 0 && t.low24h > 0 && t.high24h > t.low24h
        ? ((t.high24h - t.low24h) / t.lastPrice) * 100
        : 0;
    out.push({
      instId: t.instId,
      score: round(range24hPct / spreadPct, 4),
      range24hPct: round(range24hPct, 4),
      spreadPct: round(spreadPct, 4),
      turnover24hUSDT: t.turnover24hUSDT,
    });
  }

  out.sort(
    (a, b) =>
      b.score - a.score ||
      b.turnover24hUSDT - a.turnover24hUSDT ||
      a.instId.localeCompare(b.instId)
  );
  return out.slice(0, size);
}

// ---------------------------------------------------------------------------
// Scanner (network orchestration only — no scoring)
// ---------------------------------------------------------------------------

export class AgentUniverseScanner {
  constructor(
    private data: AgentUniverseDataSource,
    private log?: (message: string, details?: any) => void,
    private cursorStore?: AgentScanCursorStore,
    private poolStore?: AgentScanPoolStore
  ) {}

  public async scan(settings: AgentScanSettings): Promise<NativeGridOpportunity[]> {
    const startedAt = Date.now();
    const deepCount = clamp(
      Math.round(Number(settings.deepScanCount) || AGENT_SCAN_DEFAULT_DEEP_COUNT),
      1,
      60
    );
    const mode = resolveAgentScanMode(settings.universeScanMode);

    const [specs, tickers] = await Promise.all([
      this.data.listXPerpContracts(),
      this.data.fetchTickers(),
    ]);

    // Contracts that can be priced at all. No turnover gate here — turnover mode applies its
    // own floor below, rotation mode deliberately applies none.
    type Stage1Row = { spec: AgentContractSpec; ticker: AgentUniverseTicker };
    const universe = specs
      .filter((s) => s.instId.includes('_UM_XPERP'))
      .map((spec) => ({ spec, ticker: tickers[spec.instId] }))
      .filter(
        (r): r is Stage1Row => !!r.ticker && r.ticker.lastPrice > 0
      );

    let stage1: Stage1Row[];
    let rotation: RotationWindow<Stage1Row> | null = null;
    /** Pool state to persist once the cycle completed (pool mode only). */
    let pendingPoolState: AgentScanPoolState | null = null;
    /** Human-readable description of how this cycle's window was chosen. */
    let span = `mod ${mode}`;

    if (mode === 'pool') {
      const picked = this.pickElitePool(universe, settings, deepCount, startedAt);
      rotation = picked.window;
      stage1 = picked.window.items;
      pendingPoolState = picked.nextState;
      span =
        `pool ${picked.pool.length}/${universe.length} (vârstă ${Math.round(
          picked.ageMinutes
        )} min, reîmprospătare în ${Math.round(picked.minutesToRefresh)} min)` +
        ` — fereastră ${picked.window.start + 1}-${
          picked.window.start + picked.window.items.length
        }, pool complet în ${picked.window.cyclesForFullCoverage} cicluri`;
    } else if (mode === 'rotation') {
      // Alphabetical, NOT by turnover: the ordering must be stable across cycles, otherwise
      // membership shifts between ticks and a contract can be skipped or scanned twice.
      universe.sort((a, b) => a.spec.instId.localeCompare(b.spec.instId));
      let startCursor = 0;
      try {
        startCursor = this.cursorStore?.load() ?? 0;
      } catch (err: any) {
        this.log?.(
          `[AGENT SCAN] cursor de rotație ilizibil, repornesc de la 0: ${err?.message || err}`
        );
      }
      rotation = selectRotationWindow(universe, startCursor, deepCount);
      stage1 = rotation.items;
    } else {
      const minTurnover = Math.max(
        AGENT_SCAN_MIN_TURNOVER_USDT,
        Number(settings.minTurnover24hUSDT) || 0
      );
      stage1 = universe
        .filter((r) => r.ticker.turnover24hUSDT >= minTurnover)
        .sort((a, b) => b.ticker.turnover24hUSDT - a.ticker.turnover24hUSDT)
        .slice(0, Math.ceil(deepCount * 1.6));
    }

    // Stage 2 — deep scan: candles + book, then the agent's own math.
    const rows: NativeGridOpportunity[] = [];
    const poolSize = 5;
    let cursor = 0;
    const worker = async () => {
      while (cursor < stage1.length) {
        const item = stage1[cursor++];
        try {
          const [klines, klines1h, book] = await Promise.all([
            this.data.fetchKlines15m(item.spec.instId, 48),
            this.fetchRegimeKlines(item.spec.instId),
            this.data.fetchBookSnapshot(item.spec.instId, 20),
          ]);
          const row = buildAgentOpportunity({
            spec: item.spec,
            ticker: item.ticker,
            klines15m: klines,
            klines1h,
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

    // Advance only after a completed cycle: a crash mid-scan must retry the same window,
    // never skip it for a full turn.
    if (rotation && mode === 'rotation') {
      try {
        this.cursorStore?.save(rotation.nextCursor);
      } catch (err: any) {
        this.log?.(
          `[AGENT SCAN] nu am putut salva cursorul de rotație: ${err?.message || err}`
        );
      }
    }
    if (pendingPoolState) {
      try {
        this.poolStore?.save(pendingPoolState);
      } catch (err: any) {
        this.log?.(`[AGENT SCAN] nu am putut salva pool-ul de scan: ${err?.message || err}`);
      }
    }

    // Selection order: crossings per hour first (the only thing that pays), then net edge.
    rows.sort((a, b) => {
      if (a.isEligible !== b.isEligible) return a.isEligible ? -1 : 1;
      const ca = a.crossingsPerHour || 0;
      const cb = b.crossingsPerHour || 0;
      if (cb !== ca) return cb - ca;
      return (b.estimatedNetProfitPerGridPct || 0) - (a.estimatedNetProfitPerGridPct || 0);
    });
    rows.forEach((row, idx) => (row.rank = idx + 1));

    if (rotation && mode === 'rotation' && rotation.total > 0) {
      span =
        `rotație ${rotation.start + 1}-${rotation.start + rotation.items.length} din ${
          rotation.total
        } (următorul ciclu de la ${rotation.nextCursor + 1},` +
        ` acoperire completă în ${rotation.cyclesForFullCoverage} cicluri)`;
    }

    this.log?.(
      `[AGENT SCAN] ${rows.length} contracte scanate adânc în ${Date.now() - startedAt} ms, ` +
        `${rows.filter((r) => r.isEligible).length} eligibile (rank = crossings/h) — ${span}`,
      { deep: rows.length, eligible: rows.filter((r) => r.isEligible).length, mode }
    );

    return rows;
  }

  /**
   * 1h candles for the regime ATR, with a LOUD fallback.
   *
   * A failed 1h fetch must not delete an otherwise valid candidate (the 15m tape alone still
   * describes the step), but it must not pass for a real measurement either: the plan builder
   * then falls back to `sqrt(4) x ATR(15m)`, which is the same random-walk assumption the horizon
   * maths makes. Logged so "we sized 12 bands on an assumption" is answerable after the fact.
   */
  private async fetchRegimeKlines(instId: string): Promise<Kline[]> {
    try {
      return await this.data.fetchKlines1h(instId, AGENT_SCAN_REGIME_BARS_1H);
    } catch (err: any) {
      this.log?.(
        `[AGENT SCAN] ${instId}: klines 1h indisponibile (${err?.message || err}) — ` +
          `regimul cade pe ATR(15m) x sqrt(4)`
      );
      return [];
    }
  }

  /**
   * Pick this cycle's window out of the elite pool, rebuilding the pool first when it is missing,
   * expired or has lost too many members from the universe.
   *
   * Two stages, deliberately asymmetric in cost:
   *   - the CHEAP sweep ranks the WHOLE universe from the tickers snapshot (one request, already
   *     fetched above) — so "a full turn over all ~260 contracts" happens every cycle, not every
   *     11 cycles;
   *   - only the top `poolSize` pay for candles, and the window rotates INSIDE the pool so the
   *     pool is re-measured every ceil(poolSize / deepScanCount) cycles instead of every full turn.
   *
   * The advanced cursor is returned, not saved: a crash mid-scan must retry the same window (the
   * caller persists after a completed cycle, exactly like the rotation cursor).
   */
  private pickElitePool(
    universe: Array<{ spec: AgentContractSpec; ticker: AgentUniverseTicker }>,
    settings: AgentScanSettings,
    deepCount: number,
    now: number
  ): {
    pool: string[];
    window: RotationWindow<{ spec: AgentContractSpec; ticker: AgentUniverseTicker }>;
    nextState: AgentScanPoolState;
    ageMinutes: number;
    minutesToRefresh: number;
  } {
    const poolTarget = clamp(
      Math.round(Number(settings.poolSize) || AGENT_SCAN_POOL_SIZE),
      5,
      60
    );
    const refreshMinutes = clamp(
      Math.round(Number(settings.poolRefreshMinutes) || AGENT_SCAN_POOL_REFRESH_MINUTES),
      15,
      1440
    );
    const refreshMs = refreshMinutes * 60_000;

    let state: AgentScanPoolState | null = null;
    try {
      state = this.poolStore?.load() ?? null;
    } catch (err: any) {
      this.log?.(`[AGENT SCAN] pool ilizibil, îl reconstruiesc: ${err?.message || err}`);
      state = null;
    }

    const byId = new Map(universe.map((r) => [r.spec.instId, r]));
    const storedPool = Array.isArray(state?.pool)
      ? (state!.pool || []).filter((id) => typeof id === 'string' && id.length > 0)
      : [];
    const alive = storedPool.filter((id) => byId.has(id));
    const dropped = storedPool.length - alive.length;
    const ageMs = state ? Math.max(0, now - (Number(state.builtAt) || 0)) : Number.POSITIVE_INFINITY;

    const stale =
      !state ||
      alive.length === 0 ||
      ageMs >= refreshMs ||
      // Decay, not absolute size: a pool that came back short because the cheap gates reject most
      // of the universe must NOT be rebuilt every cycle (that would pin the cursor at 0 and scan
      // the same contracts forever). Only members actually leaving the universe trigger this.
      (storedPool.length > 0 && alive.length < Math.ceil(storedPool.length * 0.8));

    let pool = alive;
    let scores = state?.scores;
    let builtAt = state ? Number(state.builtAt) || 0 : 0;
    let rebuilt = false;

    if (stale) {
      // Cheap stage over EVERY contract, including ones rotation would only reach tomorrow.
      // No turnover gate on purpose: turnover measures popularity, and the deep stage already
      // rejects what cannot pay (depth, crossings, spread vs step).
      const minTurnover = Math.max(0, Number(settings.minTurnover24hUSDT) || 0);
      let ranked = rankElitePool(
        universe.map((r) => r.ticker),
        { minTurnoverUSDT: minTurnover, size: poolTarget }
      );
      if (ranked.length === 0) {
        // Every contract looked too expensive on the snapshot alone: keep the desk alive by
        // ranking without the spread ceiling instead of returning "nothing to scan".
        ranked = rankElitePool(universe.map((r) => r.ticker), {
          minTurnoverUSDT: minTurnover,
          maxSpreadPct: Number.POSITIVE_INFINITY,
          size: poolTarget,
        });
        if (ranked.length > 0) {
          this.log?.(
            `[AGENT SCAN] pool: toate spread-urile peste plafonul de ${AGENT_SCAN_POOL_MAX_SPREAD_PCT}%, ` +
              `rank fără plafon (${ranked.length} candidați) — stadiul adânc decide.`
          );
        }
      }
      pool = ranked.map((r) => r.instId);
      scores = Object.fromEntries(ranked.map((r) => [r.instId, r.score]));
      builtAt = now;
      rebuilt = true;
      this.log?.(
        `[AGENT SCAN] pool reîmprospătat din ${universe.length} contracte: ${pool.length} ținute ` +
          `(vârstă veche ${Number.isFinite(ageMs) ? Math.round(ageMs / 60_000) + ' min' : 'n/a'}` +
          `${dropped > 0 ? `, ${dropped} dispărute din univers` : ''}) — ` +
          (ranked
            .slice(0, 5)
            .map((r) => `${r.instId.split('-')[0]}=${r.score}(range ${r.range24hPct}%/spread ${r.spreadPct}%)`)
            .join(', ') || 'niciun candidat'),
        { poolSize: pool.length, mode: 'pool' }
      );
    }

    const poolRows = pool
      .map((id) => byId.get(id))
      .filter((r): r is { spec: AgentContractSpec; ticker: AgentUniverseTicker } => !!r);
    const startCursor = Number(state?.cursor) || 0;
    const window = selectRotationWindow(poolRows, rebuilt ? 0 : startCursor, deepCount);

    return {
      pool,
      window,
      nextState: { pool, builtAt, cursor: window.nextCursor, scores },
      ageMinutes: rebuilt ? 0 : ageMs / 60_000,
      minutesToRefresh: rebuilt ? refreshMinutes : Math.max(0, (refreshMs - ageMs) / 60_000),
    };
  }
}
