/**
 * GRID PLAN BUILDER — the ONE geometry implementation
 * =============================================================================
 * Everything that needs sendable grid geometry goes through this file:
 *
 *   - the agent universe scan  (`AgentUniverseScan.computeAgentGridMetrics`)
 *   - the execution path       (`GridCommandGateway`, D4)
 *   - any future backtest that replays a plan
 *
 * Why it exists: the scanner used to own the band/step/level math privately, so the
 * numbers the agent ranked were not provably the numbers the engine sent. Two copies of
 * the same formula is a silent-drift bug waiting to happen — `gridPlan.test.ts` locks the
 * scan metrics against `deriveGridGeometry()` so the two can never diverge again.
 *
 * Contract:
 *   - PURE. No I/O, no `Date.now()`, no `Math.random()`, no environment reads.
 *   - MONEY IS INTEGER CENTS. Sizing is delegated to `resolveNativeGridSize()`; this file
 *     never re-derives a minimum, never rounds a requirement down, and never compares a
 *     rounded value against an unrounded one.
 *   - Refusals are VALUES, not exceptions: `{ ok: false, codes, detail }`.
 */

import { resolveNativeGridSize, usdToCents } from './nativeGridSizing';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Both execution variants are first-class: OKX's grid algo gateway does not recognise
 * `_UM_XPERP` ids (it answers 51001), so most X-Perp grids actually run as a set of
 * limit orders. Same plan, same intent, same lifecycle — only the transport differs.
 */
export type GridExecutionVariant = 'NATIVE_ALGO' | 'AUTO_LIMIT';

export interface GridPlanRequest {
  instId: string;
  currentPx: number;
  /** Price increment of the contract; 0 or missing degrades to 6-decimal snapping. */
  tickSz: number;
  /** Average true range over 15m bars, in % of price. */
  atrPct: number;
  /** Live top-of-book spread, in % of price. */
  spreadPct: number;
  /** Real maker round-trip cost, in % (e.g. 0.04). */
  roundTripFeePct: number;
  fundingRatePct?: number;
  lever: number;
  /** Margin the caller wants to allocate to THIS bot. */
  budgetUSDT: number;
  /** Desk-wide margin ceiling (all open bots + this one). */
  totalCapUSDT: number;
  /** Margin already locked by open bots. */
  committedUSDT: number;
  /** Live OKX `min-investment` answer for this geometry; 0 = probe unavailable. */
  minInvestmentUSDT: number;
  /** Measured level touches per hour (from the scan). Never derived here. */
  crossingsPerHour: number;
  /** Optional override; neutral grids default to arithmetic. */
  runType?: '1' | '2';
  /**
   * True only when the native algo gateway was observed to accept this instId.
   * Defaults to false for any id containing `_UM_XPERP` (verified: 51001).
   */
  preferNativeAlgo?: boolean;
}

export interface GridPlan {
  instId: string;
  minPx: number;
  maxPx: number;
  gridNum: number;
  runType: '1' | '2';
  lever: number;
  /** Distance between two levels, in % of price. */
  stepPct: number;
  /** Half of the band, in % of price. */
  halfRangePct: number;
  atrPct: number;
  crossingsPerHour: number;
  /** Step minus maker round-trip, funding drag and half-spread. */
  netPerGridPct: number;
  spreadPctOfStep: number;
  /** Margin to send, in whole cents. */
  szCents: number;
  /** Live OKX minimum for this geometry, in whole cents (rounded UP). */
  minInvCents: number;
  /** Margin requested by the caller, in whole cents. */
  requestedCents: number;
  /** Desk-wide cap still available to this bot, in whole cents. */
  availableCapCents: number;
  variant: GridExecutionVariant;
  /**
   * Stable hash over every field OKX will store, in integer ticks. Two plans with the same
   * hash are the same bot geometry — this is how the intent journal proves that the bot OKX
   * is running is the bot we asked for.
   */
  geometryHash: string;
}

export type GridPlanRejectionCode =
  | 'PRICE_INVALID'
  | 'TAPE_UNUSABLE'
  | 'LEVER_INVALID'
  | 'BUDGET_INVALID'
  | 'STEP_BELOW_FEE_FLOOR'
  | 'EDGE_NEGATIVE'
  | 'SPREAD_TOO_WIDE'
  | 'GEOMETRY_INVALID'
  | 'DESK_CAP_EXCEEDED'
  | 'BUDGET_BELOW_MIN';

export interface GridPlanRejection {
  ok: false;
  codes: GridPlanRejectionCode[];
  detail: string;
}

export type GridPlanResult = { ok: true; plan: GridPlan } | GridPlanRejection;

/**
 * Narrowing helper. `if (!result.ok)` does NOT narrow a union whose discriminant is a boolean
 * literal, so every consumer uses this guard instead of a truthiness check on `.ok`.
 */
export function isGridPlanRejection(result: GridPlanResult): result is GridPlanRejection {
  return result.ok !== true;
}

// ---------------------------------------------------------------------------
// Constants — the neutral-grid geometry, in one place
// ---------------------------------------------------------------------------

/**
 * Band half-width as a multiple of ATR, clamped to [MIN, MAX] % of price.
 * 1.6x ATR keeps ~93% of 15m bars inside the band over the horizons that matter here.
 */
export const GRID_HALF_RANGE_ATR_MULT = 1.6;
export const GRID_MIN_HALF_RANGE_PCT = 0.8;
export const GRID_MAX_HALF_RANGE_PCT = 6;

/** Target step before level-count rounding; clamped to the fee floor and to MAX_STEP. */
export const GRID_TARGET_STEP_ATR_MULT = 0.9;
export const GRID_MAX_STEP_PCT = 3;

/** A step must clear the maker round-trip at least this many times. */
export const GRID_FEE_FLOOR_MULTIPLE = 3;

/** Spread above this fraction of the step eats the whole edge. */
export const GRID_MAX_SPREAD_OF_STEP = 0.25;

/** Level count bounds. Even counts keep the pivot centred on the current price. */
export const GRID_MIN_LEVELS = 4;
export const GRID_MAX_LEVELS = 20;

/**
 * Defence in depth: this must stay equal to `AGENT_SCAN_MAX_LEVERAGE`, which is asserted by
 * `gridPlan.test.ts`. Declared here as well so a plan can never be built with unsafe leverage
 * even if a caller forgets the agent's ceiling.
 */
export const GRID_PLAN_MAX_LEVERAGE = 2;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

const round = (v: number, d: number): number => {
  const f = 10 ** d;
  return Math.round(v * f) / f;
};

/** Decimals implied by a price increment (0.0001 -> 4). */
export function priceDecimals(tickSz: number): number {
  return tickSz > 0 && Number.isFinite(tickSz)
    ? Math.max(0, -Math.floor(Math.log10(tickSz) + 1e-9))
    : 6;
}

/** Snap a price to the contract's tick, keeping two guard decimals of headroom. */
export function snapToTick(px: number, tickSz: number): number {
  if (!(tickSz > 0)) return round(px, 6);
  return round(Math.round(px / tickSz) * tickSz, priceDecimals(tickSz) + 2);
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export interface GridGeometry {
  /** ATR used, in % of price (rounded to 3 decimals for reporting). */
  atrPct: number;
  halfRangePct: number;
  gridNum: number;
  stepPct: number;
  /** Minimum step the fee structure allows, in % of price. */
  feeFloorPct: number;
  /** Step minus round-trip fee, funding drag and half-spread, in % of price. */
  netPerGridPct: number;
  spreadPctOfStep: number;
}

/**
 * Band half-width, level count and step, from volatility alone.
 *
 * This is the ONLY implementation of the neutral-grid geometry. Returns null when the input
 * cannot describe a grid at all (non-positive or non-finite ATR).
 */
export function deriveGridGeometry(input: {
  atrPct: number;
  roundTripFeePct: number;
  spreadPct?: number;
  fundingRatePct?: number;
}): GridGeometry | null {
  const atrPct = Number(input.atrPct);
  if (!Number.isFinite(atrPct) || atrPct <= 0) return null;

  const roundTripFeePct = Math.max(0, Number(input.roundTripFeePct) || 0);
  const feeFloorPct = roundTripFeePct * GRID_FEE_FLOOR_MULTIPLE;

  const halfRangePct = round(
    clamp(GRID_HALF_RANGE_ATR_MULT * atrPct, GRID_MIN_HALF_RANGE_PCT, GRID_MAX_HALF_RANGE_PCT),
    2
  );

  const targetStepPct = clamp(
    GRID_TARGET_STEP_ATR_MULT * atrPct,
    feeFloorPct,
    GRID_MAX_STEP_PCT
  );

  const rawLevels = Math.round((2 * halfRangePct) / Math.max(targetStepPct, 0.01));
  // Even counts keep the pivot centred; bounds keep the grid economically legible.
  const gridNum =
    Math.round(clamp(rawLevels, GRID_MIN_LEVELS, GRID_MAX_LEVELS) / 2) * 2;

  const stepPct = round((2 * halfRangePct) / gridNum, 4);

  const spreadPct = Math.max(0, Number(input.spreadPct) || 0);
  const fundingDrag = Math.abs(Number(input.fundingRatePct) || 0) * 0.35;
  const spreadDrag = spreadPct * 0.5;
  const netPerGridPct = round(stepPct - roundTripFeePct - fundingDrag - spreadDrag, 4);

  return {
    atrPct: round(atrPct, 3),
    halfRangePct,
    gridNum,
    stepPct,
    feeFloorPct,
    netPerGridPct,
    spreadPctOfStep: stepPct > 0 ? round(spreadPct / stepPct, 4) : 0,
  };
}

// ---------------------------------------------------------------------------
// Geometry hash
// ---------------------------------------------------------------------------

/** 32-bit FNV-1a over a canonical string; two lanes give a 64-bit digest. */
function fnv1a(input: string, seed: number): string {
  let h = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    // h *= 16777619, in 32-bit wrapping arithmetic
    h = (h + ((h << 1) >>> 0) + ((h << 4) >>> 0) + ((h << 7) >>> 0) + ((h << 8) >>> 0) + ((h << 24) >>> 0)) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * Stable fingerprint of the geometry OKX will store. Timestamps, margins and measured
 * metrics are deliberately excluded: the same band/step/level/leverage must hash the same
 * across cycles, and a different level count or leverage must not collide.
 */
export function geometryHash(parts: {
  instId: string;
  minPx: number;
  maxPx: number;
  gridNum: number;
  runType: '1' | '2';
  lever: number;
  tickSz: number;
}): string {
  const toTicks = (px: number): number =>
    parts.tickSz > 0 ? Math.round(px / parts.tickSz) : Math.round(px * 1e8);
  const canonical = [
    String(parts.instId),
    String(toTicks(parts.minPx)),
    String(toTicks(parts.maxPx)),
    String(Math.round(parts.gridNum)),
    String(parts.runType),
    String(Math.round(parts.lever)),
  ].join('|');
  return fnv1a(canonical, 0x811c9dc5) + fnv1a(canonical, 0x01000193);
}

// ---------------------------------------------------------------------------
// Plan builder
// ---------------------------------------------------------------------------

const reject = (codes: GridPlanRejectionCode[], detail: string): GridPlanRejection => ({
  ok: false,
  codes,
  detail,
});

/**
 * Geometry that was already DECIDED upstream (agent, autopilot, operator) and only needs to be
 * validated, hashed and made sendable.
 *
 * Why this is not `buildGridPlan()`: by the time the agent asks to open, it has already chosen
 * band, level count, leverage and margin from its own scan. Re-deriving them from ATR here would
 * silently execute a DIFFERENT grid than the one that was ranked and shown to the operator.
 * This path therefore validates what it was given and refuses nonsense — it never invents.
 */
export interface DecidedGridGeometry {
  instId: string;
  minPx: number;
  maxPx: number;
  gridNum: number;
  runType?: '1' | '2';
  lever: number;
  /** Margin decided upstream, in USDT. */
  szUSDT: number;
  /** Price increment, used only for the geometry fingerprint. */
  tickSz?: number;
  /** True only when the native algo gateway was observed to accept this instId. */
  preferNativeAlgo?: boolean;
}

/**
 * Validates decided geometry into a plan.
 *
 * Deliberately does NOT apply `GRID_PLAN_MAX_LEVERAGE`: that ceiling belongs to the derivation
 * of a *recommendation*. Refusing an execution because a recommendation rule changed would
 * block the desk from managing grids it already decided to run.
 */
export function buildGridPlanFromGeometry(input: DecidedGridGeometry): GridPlanResult {
  const instId = String(input.instId || '').trim();
  if (!instId) return reject(['GEOMETRY_INVALID'], 'Instrument lipsă');

  const minPx = Number(input.minPx);
  const maxPx = Number(input.maxPx);
  if (!Number.isFinite(minPx) || !(minPx > 0)) {
    return reject(['GEOMETRY_INVALID'], `Limită inferioară invalidă (${input.minPx})`);
  }
  if (!Number.isFinite(maxPx) || !(maxPx > minPx)) {
    return reject(['GEOMETRY_INVALID'], `Bandă invalidă [${input.minPx} – ${input.maxPx}]`);
  }

  const gridNum = Math.round(Number(input.gridNum));
  if (!Number.isFinite(gridNum) || gridNum < 2 || gridNum > 500) {
    return reject(['GEOMETRY_INVALID'], `Număr de grile invalid (${input.gridNum})`);
  }

  const lever = Math.round(Number(input.lever));
  if (!Number.isFinite(lever) || lever < 1 || lever > 20) {
    return reject(['LEVER_INVALID'], `Levier invalid (${input.lever})`);
  }

  const szCents = Math.round(usdToCents(Number(input.szUSDT)));
  if (szCents <= 0) {
    return reject(['BUDGET_INVALID'], `Marjă invalidă (${input.szUSDT} USDT)`);
  }

  const tickSz = Number(input.tickSz) > 0 ? Number(input.tickSz) : 0;
  const runType: '1' | '2' = input.runType === '2' ? '2' : '1';
  const midPx = (minPx + maxPx) / 2;
  const stepPct = midPx > 0 ? round(((maxPx - minPx) / gridNum / midPx) * 100, 4) : 0;
  const halfRangePct = midPx > 0 ? round((((maxPx - minPx) / 2) / midPx) * 100, 4) : 0;

  const isXPerp = instId.includes('_UM_XPERP');
  const variant: GridExecutionVariant =
    input.preferNativeAlgo === true || !isXPerp ? 'NATIVE_ALGO' : 'AUTO_LIMIT';

  return {
    ok: true,
    plan: {
      instId,
      minPx,
      maxPx,
      gridNum,
      runType,
      lever,
      stepPct,
      halfRangePct,
      // Bookkeeping only — the decided path does not use volatility for geometry.
      atrPct: 0,
      crossingsPerHour: 0,
      netPerGridPct: 0,
      spreadPctOfStep: 0,
      szCents,
      minInvCents: 0,
      requestedCents: szCents,
      availableCapCents: szCents,
      variant,
      geometryHash: geometryHash({ instId, minPx, maxPx, gridNum, runType, lever, tickSz }),
    },
  };
}

/**
 * Turns a requested configuration into a sendable plan, or refuses it with codes.
 *
 * Order of evaluation is part of the contract — the cheapest checks run first so a refusal
 * never depends on a network probe that was not needed.
 */
export function buildGridPlan(req: GridPlanRequest): GridPlanResult {
  // 1. Inputs that make a grid meaningless.
  const currentPx = Number(req.currentPx);
  if (!Number.isFinite(currentPx) || currentPx <= 0) {
    return reject(['PRICE_INVALID'], `Preț curent invalid (${req.currentPx})`);
  }

  const lever = Math.round(Number(req.lever));
  if (!Number.isFinite(lever) || lever < 1) {
    return reject(['LEVER_INVALID'], `Levier invalid (${req.lever})`);
  }
  if (lever > GRID_PLAN_MAX_LEVERAGE) {
    return reject(
      ['LEVER_INVALID'],
      `Levier ${lever}x peste plafonul dur ${GRID_PLAN_MAX_LEVERAGE}x pentru grilă neutră`
    );
  }

  const budgetCents = Math.round(usdToCents(req.budgetUSDT));
  if (budgetCents <= 0) {
    return reject(['BUDGET_INVALID'], `Buget invalid (${req.budgetUSDT} USDT)`);
  }

  const tickSz = Number(req.tickSz) > 0 ? Number(req.tickSz) : 0;

  // 2. Geometry — one implementation, shared with the scanner.
  const geo = deriveGridGeometry({
    atrPct: req.atrPct,
    roundTripFeePct: req.roundTripFeePct,
    spreadPct: req.spreadPct,
    fundingRatePct: req.fundingRatePct,
  });
  if (!geo) {
    return reject(['TAPE_UNUSABLE'], `ATR indisponibil/invalid (${req.atrPct}%)`);
  }

  const rejectionCodes: GridPlanRejectionCode[] = [];
  const rejectionNotes: string[] = [];

  if (geo.stepPct < geo.feeFloorPct) {
    rejectionCodes.push('STEP_BELOW_FEE_FLOOR');
    rejectionNotes.push(
      `Pas ${geo.stepPct}% sub podeaua de comision ${round(geo.feeFloorPct, 4)}% (${GRID_FEE_FLOOR_MULTIPLE}x round-trip maker)`
    );
  }
  if (geo.netPerGridPct <= 0) {
    rejectionCodes.push('EDGE_NEGATIVE');
    rejectionNotes.push(`Profit net/grilă ${geo.netPerGridPct}% <= 0 după comision + spread + funding`);
  }
  if (geo.spreadPctOfStep > GRID_MAX_SPREAD_OF_STEP) {
    rejectionCodes.push('SPREAD_TOO_WIDE');
    rejectionNotes.push(
      `Spread ${round(geo.spreadPctOfStep * 100, 1)}% din pas (max ${GRID_MAX_SPREAD_OF_STEP * 100}%)`
    );
  }

  // 3. Band, snapped to the contract tick.
  const minPx = snapToTick(currentPx * (1 - geo.halfRangePct / 100), tickSz);
  const maxPx = snapToTick(currentPx * (1 + geo.halfRangePct / 100), tickSz);
  if (!(minPx > 0) || !(maxPx > minPx)) {
    rejectionCodes.push('GEOMETRY_INVALID');
    rejectionNotes.push(`Bandă invalidă [${minPx} – ${maxPx}] pentru prețul ${currentPx}`);
  }

  // 4. Desk budget: the cap this bot may use is what is left of the desk ceiling.
  const totalCapCents = Math.max(0, Math.round(usdToCents(req.totalCapUSDT)));
  const committedCents = Math.max(0, Math.round(usdToCents(req.committedUSDT)));
  const availableCapCents = Math.max(0, totalCapCents - committedCents);

  if (availableCapCents <= 0) {
    rejectionCodes.push('DESK_CAP_EXCEEDED');
    rejectionNotes.push(
      `Plafon desk epuizat (angajat ${committedCents / 100} / ${totalCapCents / 100} USDT)`
    );
  }

  // Never ask for more than the desk still allows, and never inflate a plan to the cap.
  const effectiveRequestCents = Math.min(budgetCents, availableCapCents || budgetCents);
  // `budgetUSDT` is a HARD per-bot ceiling, so the ceiling handed to the sizer is the request
  // itself — not the desk remainder. Otherwise a live minimum above the caller's budget would
  // silently raise the position (12 USDT requested, 18.51 USDT sent) instead of refusing it.
  const size = resolveNativeGridSize({
    requestedUSDT: effectiveRequestCents / 100,
    minInvestmentUSDT: Number(req.minInvestmentUSDT) || 0,
    maxBudgetUSDT: effectiveRequestCents / 100,
  });

  if (size.belowMinimum) {
    rejectionCodes.push('BUDGET_BELOW_MIN');
    rejectionNotes.push(
      `Marjă ${size.szCents / 100} USDT sub minimul OKX ${size.minInvCents / 100} USDT pentru ${geo.gridNum} grile la ${lever}x`
    );
  }
  if (availableCapCents > 0 && size.szCents > availableCapCents) {
    rejectionCodes.push('DESK_CAP_EXCEEDED');
    rejectionNotes.push(
      `Marjă ${size.szCents / 100} USDT peste disponibilul desk ${availableCapCents / 100} USDT`
    );
  }

  if (rejectionCodes.length > 0) {
    return reject([...new Set(rejectionCodes)], rejectionNotes.join(' | '));
  }

  // 5. Execution variant. X-Perp ids are unknown to the grid algo gateway (51001), so the
  //    limit-order path is the default truth unless a caller proved otherwise.
  const runType: '1' | '2' = req.runType === '2' ? '2' : '1';
  const isXPerp = String(req.instId).includes('_UM_XPERP');
  const variant: GridExecutionVariant =
    req.preferNativeAlgo === true || !isXPerp ? 'NATIVE_ALGO' : 'AUTO_LIMIT';

  return {
    ok: true,
    plan: {
      instId: String(req.instId),
      minPx,
      maxPx,
      gridNum: geo.gridNum,
      runType,
      lever,
      stepPct: geo.stepPct,
      halfRangePct: geo.halfRangePct,
      atrPct: geo.atrPct,
      crossingsPerHour: Number(req.crossingsPerHour) || 0,
      netPerGridPct: geo.netPerGridPct,
      spreadPctOfStep: geo.spreadPctOfStep,
      szCents: size.szCents,
      minInvCents: size.minInvCents,
      requestedCents: size.requestedCents,
      availableCapCents,
      variant,
      geometryHash: geometryHash({
        instId: String(req.instId),
        minPx,
        maxPx,
        gridNum: geo.gridNum,
        runType,
        lever,
        tickSz,
      }),
    },
  };
}
