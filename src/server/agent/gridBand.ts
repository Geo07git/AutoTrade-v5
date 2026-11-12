/**
 * Constructed grid band — places the band on the market's own structure instead of
 * stamping `price ± halfRange` around the last tick.
 *
 * WHY THE SYMMETRIC BAND IS WEAK
 * ------------------------------
 * `price ± halfRange` is centred on a single trade. Two consequences:
 *
 *  1. The edges are arbitrary. ATR says how WIDE the grid should be, it says nothing about
 *     WHERE the window should sit. If price is at the top of a 12 h range, half the levels are
 *     placed in price territory the market left hours ago — capital allocated to levels that
 *     will not be touched.
 *  2. Nothing stops an edge from landing on the 24 h low/high. That is the worst possible
 *     place: a band whose lower bound IS the 24 h low breaks out on the next new low, filling
 *     every level in one direction at the moment the desk is maximally wrong. Today this rule
 *     exists only in the model prompt, i.e. it is a suggestion, not a guard.
 *
 * WHAT THIS MODULE DOES
 * ---------------------
 * It does NOT change the step. `deriveGridGeometry` decides the step from ATR and fees, and the
 * width is `gridNum * step`; this module only decides WHERE that fixed-width window sits, then
 * proves the placement is legal. That is the whole reason the change is safe: net profit per
 * grid, crossings/hour and the fill statistics keep the exact values the scan already computed,
 * because not one grid level moves relative to its neighbours.
 *
 * Rules, in order of precedence:
 *  1. HARD — no edge within `extremeProximityPct` of the 24 h low/high. If that leaves no legal
 *     window, the candidate is refused. This is what makes the prompt rule enforceable.
 *  2. Price must sit at least `minStepsFromEdge` grid steps inside each edge, so the grid is
 *     two-sided rather than a one-way ladder waiting for the band to break.
 *  3. PREFERENCE — centre the window on the middle of the robust oscillation zone (10th..90th
 *     percentile of bar closes) so the levels cover where price actually trades. Wicks are
 *     ignored for the centre on purpose: one 3-ATR wick must not drag the entire band.
 *
 * Everything is pure and unit-tested offline; the caller supplies the tick size and the clock is
 * never read.
 */

import { snapToTick } from '../engine/grid/gridPlan';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round = (v: number, d: number) => {
  const f = 10 ** d;
  return Math.round(v * f) / f;
};

/** How far an edge must stay from the 24 h low/high, in % of that extreme. */
export const BAND_EXTREME_PROXIMITY_PCT = 2.5;
/** How many grid steps the price must be inside each edge. */
export const BAND_MIN_STEPS_FROM_EDGE = 1;
/** Percentiles that define the robust oscillation zone. */
export const BAND_CORE_LOW_PCT = 10;
export const BAND_CORE_HIGH_PCT = 90;

/** A 15m bar, as much of it as the band needs. */
export interface BandBar {
  high: number;
  low: number;
  close: number;
}

export type BandMethod =
  /** Window placed on the measured oscillation zone. */
  | 'CONSTRUCTED'
  /** Construction had no legal window, but a price-centred band still cleared the hard rules. */
  | 'SYMMETRIC_FALLBACK';

export interface ConstructedBandInput {
  price: number;
  /** 24 h extremes from the ticker. 0/undefined = unknown, and the hard rule cannot be applied. */
  low24h?: number;
  high24h?: number;
  /** Total band width in % of price (= `2 * halfRangePct` from deriveGridGeometry). */
  widthPct: number;
  gridNum: number;
  tickSz: number;
  klines15m: BandBar[];
  extremeProximityPct?: number;
  minStepsFromEdge?: number;
  coreLowPct?: number;
  coreHighPct?: number;
  /**
   * When the construction has no legal window, try a band centred on price. Default true: a
   * symmetric band that clears the hard rules is still a legal trade, and refusing it would turn
   * a placement problem into a lost opportunity. The row records which one was used.
   */
  allowSymmetricFallback?: boolean;
}

export interface ConstructedBand {
  /** false = this contract must not be opened; `reason` says exactly why. */
  ok: boolean;
  method: BandMethod;
  minPx: number;
  maxPx: number;
  /** Distance from price to each edge, in % of price. */
  lowerSidePct: number;
  upperSidePct: number;
  /** max(lowerSidePct, upperSidePct) — the adverse walk the leverage ceiling must survive. */
  maxSidePct: number;
  /** Effective width of the snapped band, in % of price. */
  widthPct: number;
  /** Effective step after snapping, in % of price. */
  stepPct: number;
  /** The oscillation zone the window was centred on (prices, not percentages). */
  coreLow: number;
  coreHigh: number;
  /** Human-readable explanation for the journal. */
  notes: string[];
  reason?: string;
  /** Why the constructed window was unavailable, when `method` is SYMMETRIC_FALLBACK. */
  fallbackReason?: string;
}

const percentile = (sorted: number[], p: number): number => {
  if (!sorted.length) return 0;
  const idx = clamp((p / 100) * (sorted.length - 1), 0, sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
};

/** Robust oscillation zone + the wick extremes, all in price space. */
export function measureOscillationZone(
  bars: BandBar[],
  coreLowPct = BAND_CORE_LOW_PCT,
  coreHighPct = BAND_CORE_HIGH_PCT
): { coreLow: number; coreHigh: number; stickLow: number; stickHigh: number; count: number } {
  const usable = (bars || []).filter(
    (b) => b && Number.isFinite(b.close) && b.close > 0 && Number.isFinite(b.high) && Number.isFinite(b.low)
  );
  if (!usable.length) return { coreLow: 0, coreHigh: 0, stickLow: 0, stickHigh: 0, count: 0 };
  const closes = usable.map((b) => b.close).sort((a, b) => a - b);
  return {
    coreLow: percentile(closes, coreLowPct),
    coreHigh: percentile(closes, coreHighPct),
    stickLow: Math.min(...usable.map((b) => b.low)),
    stickHigh: Math.max(...usable.map((b) => b.high)),
    count: usable.length,
  };
}

/**
 * Place a fixed-width window legally.
 *
 * The window is `[edge, edge + width]` and `edge` must satisfy four inequalities at once:
 *   edge >= lowLimit                     (hard rule, lower side)
 *   edge + width <= highLimit            (hard rule, upper side)
 *   edge <= price - safety               (price inside, lower side)
 *   edge >= price + safety - width       (price inside, upper side)
 *
 * Written as an interval for `edge`:
 *   loMin = max(lowLimit, price + safety - width)
 *   loMax = min(highLimit - width, price - safety)
 * and the placement exists iff `loMin <= loMax`. The preference (centre on the oscillation zone)
 * is then just a clamp of the desired edge into that interval — no search, no heuristic.
 */
function placeConstructedWindow(input: ConstructedBandInput): ConstructedBand {
  const notes: string[] = [];
  const fail = (reason: string, partial: Partial<ConstructedBand> = {}): ConstructedBand => ({
    ok: false,
    method: 'CONSTRUCTED',
    minPx: 0,
    maxPx: 0,
    lowerSidePct: 0,
    upperSidePct: 0,
    maxSidePct: 0,
    widthPct: 0,
    stepPct: 0,
    coreLow: 0,
    coreHigh: 0,
    notes,
    reason,
    ...partial,
  });

  const price = Number(input.price);
  if (!Number.isFinite(price) || price <= 0) return fail('preț invalid');
  const widthPct = Number(input.widthPct);
  if (!Number.isFinite(widthPct) || widthPct <= 0) return fail('lățime de bandă invalidă');
  const gridNum = Math.round(Number(input.gridNum));
  if (!Number.isFinite(gridNum) || gridNum < 2) return fail('număr de grile invalid');
  const tickSz = Number(input.tickSz) > 0 ? Number(input.tickSz) : 0;

  const proxPct = clamp(
    Number.isFinite(Number(input.extremeProximityPct))
      ? Number(input.extremeProximityPct)
      : BAND_EXTREME_PROXIMITY_PCT,
    0,
    25
  );
  const minSteps = clamp(
    Number.isFinite(Number(input.minStepsFromEdge))
      ? Number(input.minStepsFromEdge)
      : BAND_MIN_STEPS_FROM_EDGE,
    0,
    gridNum / 2 - 0.5
  );

  const widthPx = (price * widthPct) / 100;
  const stepPx = widthPx / gridNum;
  const safetyPx = minSteps * stepPx;

  const zone = measureOscillationZone(input.klines15m || [], input.coreLowPct, input.coreHighPct);
  const zoneKnown = zone.count > 0 && zone.coreHigh > zone.coreLow;

  // --- hard rule limits (only when the extremes are real numbers) -------------
  const low24h = Number(input.low24h);
  const high24h = Number(input.high24h);
  const extremesKnown =
    Number.isFinite(low24h) && Number.isFinite(high24h) && low24h > 0 && high24h > low24h;
  let lowLimit = 0;
  let highLimit = Number.POSITIVE_INFINITY;
  if (extremesKnown) {
    lowLimit = low24h * (1 + proxPct / 100);
    highLimit = high24h * (1 - proxPct / 100);
    notes.push(
      `limite 24h ${round(low24h, 6)}..${round(high24h, 6)}, marjă ${proxPct}% => fereastra legală ${round(
        lowLimit,
        6
      )}..${round(highLimit, 6)}`
    );
  } else {
    notes.push('extremele de 24h lipsesc — regula de margine NU a putut fi aplicată');
  }

  // --- feasibility ------------------------------------------------------------
  if (highLimit - lowLimit < widthPx) {
    return fail(
      `banda de ${round(widthPct, 2)}% nu încape în fereastra legală de ${round(
        ((highLimit - lowLimit) / price) * 100,
        2
      )}% dintre limitele de 24h (marjă ${proxPct}% față de extreme)`,
      { widthPct: round(widthPct, 3), stepPct: round((stepPx / price) * 100, 4) }
    );
  }
  const loMin = Math.max(lowLimit, price + safetyPx - widthPx);
  const loMax = Math.min(highLimit - widthPx, price - safetyPx);
  if (loMin > loMax) {
    // Only one of the two sides can be the culprit; say which one.
    const blockedLow = price - safetyPx < lowLimit;
    const blockedHigh = price + safetyPx > highLimit;
    return fail(
      blockedLow && blockedHigh
        ? `prețul ${round(price, 6)} e prea aproape de ambele extreme de 24h pentru o bandă de ${round(
            widthPct,
            2
          )}%`
        : blockedLow
          ? `prețul e la ${round(((price - lowLimit) / price) * 100, 2)}% de limita inferioară de 24h (${round(
              lowLimit,
              6
            )}) cu ${minSteps} pas(și) de siguranță — banda ar sta pe minimul de 24h`
          : `prețul e la ${round(((highLimit - price) / price) * 100, 2)}% de limita superioară de 24h (${round(
              highLimit,
              6
            )}) cu ${minSteps} pas(și) de siguranță — banda ar sta pe maximul de 24h`,
      { widthPct: round(widthPct, 3), stepPct: round((stepPx / price) * 100, 4) }
    );
  }

  // --- placement --------------------------------------------------------------
  // Preference: centre the window on the robust oscillation zone. Later the clamp decides.
  const zoneCenter = zoneKnown ? (zone.coreLow + zone.coreHigh) / 2 : price;
  const desiredEdge = zoneCenter - widthPx / 2;
  const edge = clamp(desiredEdge, loMin, loMax);
  const method: BandMethod = 'CONSTRUCTED';
  const shiftPct = ((edge - desiredEdge) / price) * 100;
  if (Math.abs(shiftPct) > 0.01) {
    notes.push(
      `fereastra a fost deplasată cu ${round(shiftPct, 3)}% față de centrul zonei de oscilație pentru a respecta limitele`
    );
  }

  const desiredMin = edge;
  const desiredMax = edge + widthPx;

  /** Snap to the tick grid in a chosen direction: outward keeps the width, inward keeps the rule. */
  const snapDir = (px: number, dir: 'up' | 'down'): number => {
    if (!(tickSz > 0)) return snapToTick(px, tickSz);
    const steps = dir === 'up' ? Math.ceil(px / tickSz - 1e-9) : Math.floor(px / tickSz + 1e-9);
    return snapToTick(steps * tickSz, tickSz);
  };

  // Outward first: growing the band never shrinks the width, so the step stays the one the
  // profitability maths assumed. The hard rule is re-checked right after, and it wins.
  let minPx = snapDir(desiredMin, 'down');
  let maxPx = snapDir(desiredMax, 'up');
  if (extremesKnown && (minPx < lowLimit || maxPx > highLimit)) {
    // Snap the legal limits onto the tick grid as well, so the result is legal AND tradeable.
    minPx = Math.max(minPx, snapDir(lowLimit, 'up'));
    maxPx = Math.min(maxPx, snapDir(highLimit, 'down'));
    notes.push('rotunjirea la tick a fost trasă spre interior ca să nu atingă extremele de 24h');
  }

  if (!(maxPx > minPx)) return fail('banda s-a prăbușit la rotunjirea pe tick');
  if (!(price > minPx && price < maxPx)) {
    return fail(
      `prețul ${round(price, 6)} nu e strict în interiorul benzii ${round(minPx, 6)}..${round(maxPx, 6)}`
    );
  }

  const widthPctEff = ((maxPx - minPx) / price) * 100;
  const lowerSidePct = ((price - minPx) / price) * 100;
  const upperSidePct = ((maxPx - price) / price) * 100;

  if (zoneKnown) {
    notes.push(
      `zonă de oscilație p${BAND_CORE_LOW_PCT}..p${BAND_CORE_HIGH_PCT} ${round(zone.coreLow, 6)}..${round(
        zone.coreHigh,
        6
      )} (${zone.count} bare), miez ${round(zone.stickLow, 6)}..${round(zone.stickHigh, 6)}`
    );
  } else {
    notes.push('prea puține bare pentru zona de oscilație — fereastra a fost centrată pe preț');
  }

  return {
    ok: true,
    method,
    minPx,
    maxPx,
    lowerSidePct: round(lowerSidePct, 4),
    upperSidePct: round(upperSidePct, 4),
    maxSidePct: round(Math.max(lowerSidePct, upperSidePct), 4),
    widthPct: round(widthPctEff, 4),
    stepPct: round(widthPctEff / gridNum, 4),
    coreLow: zoneKnown ? round(zone.coreLow, 8) : 0,
    coreHigh: zoneKnown ? round(zone.coreHigh, 8) : 0,
    notes,
  };
}

/**
 * The classic band: `price x (1 -+ widthPct/2)`, snapped outward, with the hard rules applied.
 * Kept as its own entry point because it is the fallback AND the reference the constructed
 * window is compared against in the tests.
 */
export function buildSymmetricBand(input: {
  price: number;
  widthPct: number;
  gridNum: number;
  tickSz: number;
  low24h?: number;
  high24h?: number;
  extremeProximityPct?: number;
}): ConstructedBand {
  const notes: string[] = [];
  const price = Number(input.price);
  const widthPct = Number(input.widthPct);
  const gridNum = Math.round(Number(input.gridNum)) || 0;
  if (!(price > 0) || !(widthPct > 0) || gridNum < 2) {
    return {
      ok: false,
      method: 'SYMMETRIC_FALLBACK',
      minPx: 0,
      maxPx: 0,
      lowerSidePct: 0,
      upperSidePct: 0,
      maxSidePct: 0,
      widthPct: 0,
      stepPct: 0,
      coreLow: 0,
      coreHigh: 0,
      notes,
      reason: 'parametri invalizi pentru banda simetrică',
    };
  }
  const tickSz = Number(input.tickSz) > 0 ? Number(input.tickSz) : 0;
  const snapOut = (px: number, dir: 'up' | 'down') => {
    if (!(tickSz > 0)) return snapToTick(px, tickSz);
    const steps = dir === 'up' ? Math.ceil(px / tickSz - 1e-9) : Math.floor(px / tickSz + 1e-9);
    return snapToTick(steps * tickSz, tickSz);
  };
  const minPx = snapOut(price * (1 - widthPct / 200), 'down');
  const maxPx = snapOut(price * (1 + widthPct / 200), 'up');
  const widthPctEff = ((maxPx - minPx) / price) * 100;
  const band: ConstructedBand = {
    ok: true,
    method: 'SYMMETRIC_FALLBACK',
    minPx,
    maxPx,
    lowerSidePct: round(((price - minPx) / price) * 100, 4),
    upperSidePct: round(((maxPx - price) / price) * 100, 4),
    maxSidePct: round(Math.max((price - minPx) / price, (maxPx - price) / price) * 100, 4),
    widthPct: round(widthPctEff, 4),
    stepPct: round(widthPctEff / gridNum, 4),
    coreLow: 0,
    coreHigh: 0,
    notes,
  };
  const illegal = inspectBandLegality({
    price,
    minPx,
    maxPx,
    low24h: input.low24h,
    high24h: input.high24h,
    extremeProximityPct: input.extremeProximityPct,
  });
  return illegal ? { ...band, ok: false, reason: illegal } : band;
}

/**
 * Public entry point: build the constructed band, and fall back to the price-centred band only
 * when the construction has no legal window AND the symmetric one is legal. Both outcomes are
 * labelled on the row, so nothing is silently substituted.
 */
export function buildConstructedBand(input: ConstructedBandInput): ConstructedBand {
  const constructed = placeConstructedWindow(input);
  if (constructed.ok) return constructed;
  if (input.allowSymmetricFallback === false) return constructed;

  const symmetric = buildSymmetricBand({
    price: input.price,
    widthPct: input.widthPct,
    gridNum: input.gridNum,
    tickSz: input.tickSz,
    low24h: input.low24h,
    high24h: input.high24h,
    extremeProximityPct: input.extremeProximityPct,
  });
  if (!symmetric.ok) {
    // Both failed. Report the construction reason (it is the informative one) and keep the
    // symmetric refusal as a note so the journal shows both halves of the decision.
    return {
      ...constructed,
      notes: [...constructed.notes, `bandă simetrică: ${symmetric.reason}`],
    };
  }
  return {
    ...symmetric,
    notes: [...symmetric.notes, ...constructed.notes],
    fallbackReason: constructed.reason,
  };
}

/**
 * Independent check used by the execution guard: is this band legal on this market?
 *
 * Deliberately separate from `buildConstructedBand` — the guard runs on bands the MODEL wrote
 * (minPx/maxPx in the decision JSON), not on the band this module would have built, so it must
 * not share the builder's assumptions. Returns null when the band is acceptable.
 */
export function inspectBandLegality(input: {
  price: number;
  minPx: number;
  maxPx: number;
  low24h?: number;
  high24h?: number;
  extremeProximityPct?: number;
}): string | null {
  const price = Number(input.price);
  const minPx = Number(input.minPx);
  const maxPx = Number(input.maxPx);
  if (!Number.isFinite(minPx) || !Number.isFinite(maxPx) || minPx <= 0 || maxPx <= minPx) {
    return `bandă invalidă: ${input.minPx}..${input.maxPx}`;
  }
  if (!(price > minPx && price < maxPx)) {
    return `prețul ${price} nu e strict în interiorul benzii ${minPx}..${maxPx}`;
  }
  const low24h = Number(input.low24h);
  const high24h = Number(input.high24h);
  if (!(Number.isFinite(low24h) && Number.isFinite(high24h) && low24h > 0 && high24h > low24h)) {
    return null; // extremes unknown: nothing to enforce, and no false rejection either
  }
  const proxPct = clamp(
    Number.isFinite(Number(input.extremeProximityPct))
      ? Number(input.extremeProximityPct)
      : BAND_EXTREME_PROXIMITY_PCT,
    0,
    25
  );
  const lowLimit = low24h * (1 + proxPct / 100);
  const highLimit = high24h * (1 - proxPct / 100);
  if (minPx < lowLimit) {
    return (
      `limita inferioară ${minPx} atinge minimul de 24h ${low24h} ` +
      `(necesar ≥ ${round(lowLimit, 8)}, marjă ${proxPct}%): un nou minim ar umple toate nivelurile deodată`
    );
  }
  if (maxPx > highLimit) {
    return (
      `limita superioară ${maxPx} atinge maximul de 24h ${high24h} ` +
      `(necesar ≤ ${round(highLimit, 8)}, marjă ${proxPct}%): un nou maxim ar umple toate nivelurile deodată`
    );
  }
  return null;
}
