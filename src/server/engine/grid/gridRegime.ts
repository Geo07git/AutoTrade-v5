/**
 * GRID REGIME — pure measures that separate oscillation from displacement
 * =============================================================================
 * The audit's §5.1 finding: the live selection ranked contracts by
 * `crossingsPerHour = path / step`, and "path" (distance travelled) is large in BOTH chop and
 * trend. A token that rallies 8% in an hour has an enormous path, ranked #1, and then killed its
 * grid in 2-6 minutes (H, LINK, HYPE) or lost 2.25 USDT (PIEVERSE). Nothing in the live path
 * distinguished "price oscillates" from "price leaves".
 *
 * The Kaufman Efficiency Ratio answers exactly that question:
 *
 *     ER = |net displacement| / path travelled        in [0, 1]
 *
 *   - ER near 0  -> the price went nowhere but travelled a lot = real chop, ideal for a grid;
 *   - ER near 1  -> the price went straight there                = a trend, poison for a grid.
 *
 * It is scale-free (independent of volatility and of the step), needs no fitting, and is the
 * cheapest possible discriminator — which is why it is the one the plan adopts.
 *
 * Two windows, two distinct questions, each spelled out as a constant rather than a magic number
 * at the call site:
 *
 *   - SCAN (32 x 15m = 8h): does this regime suit a band that must survive the holding horizon?
 *     The window IS the horizon, otherwise you measure a different question.
 *   - EXIT (16 x 15m = 4h): is the current move out of the band a real displacement or a wick?
 *     Shorter, because a stop must react to what is happening NOW.
 *
 * Pure: no I/O, no clock, no randomness.
 */

import type { Kline } from '../../../shared/types';

/**
 * Above this, a candidate is displaced, not oscillating: the scan refuses it.
 *
 * 0.4 is the plan's threshold and it has a plain reading: the price spent 40% of its travel
 * going in one direction. A driftless random walk sits near 0.25 on these windows.
 */
export const GRID_ER_TREND_THRESHOLD = 0.4;

/**
 * Above this, a move outside the band needs no persistence confirmation — the market is going
 * somewhere and a neutral grid is short the move. Stricter than the scan threshold on purpose:
 * here it OVERRIDES a stop delay, so it must be reserved for unambiguous displacement.
 */
export const GRID_ER_EXIT_CONFIRMED = 0.45;

/** Bars the scan measures its regime on: 32 x 15m = 8h, the default holding horizon. */
export const GRID_ER_SCAN_BARS = 32;
/** Bars the exit measures displacement on: 16 x 15m = 4h. */
export const GRID_ER_EXIT_BARS = 16;

/**
 * Kaufman efficiency ratio of a close series, in [0, 1].
 *
 * Returns `null` when the input cannot describe a path (fewer than 2 usable closes), so callers
 * can tell "unknown" apart from "zero" — a gate must never read an unknown as a pass.
 */
export function efficiencyRatio(closes: number[]): number | null {
  const series = (closes || []).filter((c) => Number.isFinite(c) && c > 0);
  if (series.length < 2) return null;

  let path = 0;
  for (let i = 1; i < series.length; i++) path += Math.abs(series[i] - series[i - 1]);
  if (!Number.isFinite(path)) return null;
  // Flat tape: no displacement AND no travel. 0 is the honest reading (nothing went anywhere).
  if (path <= 1e-12) return 0;

  const displacement = Math.abs(series[series.length - 1] - series[0]);
  const er = displacement / path;
  return Number.isFinite(er) ? Math.min(1, Math.max(0, parseFloat(er.toFixed(4)))) : null;
}

/**
 * Same measure over the last `bars` candles of a kline series. `bars` defaults to the trade
 * window (the last N bars), never the whole series: an old trend must not define today's regime.
 */
export function efficiencyRatioFromKlines(klines: Kline[], bars = GRID_ER_SCAN_BARS): number | null {
  const usable = (klines || []).filter((k) => k && Number.isFinite(k.close) && k.close > 0);
  if (usable.length < 4) return null;
  const window = Math.max(4, Math.min(bars, usable.length));
  return efficiencyRatio(usable.slice(-window).map((k) => k.close));
}

/**
 * True when the ratio proves displacement (a trend), false when it proves oscillation.
 * `null`/unknown is NOT a trend: the gates that use this are refusals, and refusing on missing
 * data would delete legitimate candidates instead of protecting them.
 */
export function isDisplacedRegime(er: number | null, threshold = GRID_ER_TREND_THRESHOLD): boolean {
  return er !== null && Number.isFinite(er) && er > threshold;
}

// ---------------------------------------------------------------------------
// Range breakout — is the price EDGE-BREACHING or REGIME-CHANGING?
// ---------------------------------------------------------------------------

/**
 * Smallest anti-wick buffer beyond the band edge, in % of price.
 *
 * The old value was a flat 0.15%, which on a ±1% band is a sixth of what price covers in one 15m
 * bar — not a buffer, a formality. 0.5% is the smallest number that absorbs ordinary noise on a
 * mid-cap X-Perp.
 */
export const GRID_BREAKOUT_MIN_BUFFER_PCT = 0.5;

/** The buffer also scales with volatility: half an ATR(15m), whichever is larger. */
export const GRID_BREAKOUT_ATR_BUFFER_MULT = 0.5;

/**
 * How long price must sit outside the band before a breach counts as CONFIRMED.
 *
 * Deliberately TIME-BASED, not "N consecutive evaluations". The audit found this exact class of
 * bug elsewhere (§5.4): two scans 5 minutes apart were counted as two independent confirmations
 * because nobody had asked what an "evaluation" is worth in minutes, so the analyzer's three
 * cadences (30s / 1m / 5m) would each give N a different meaning. 30 minutes is two 15m bars:
 * long enough not to be a wick, and safe to wait because the drawdown stop is evaluated BEFORE
 * the breakout rule and still catches an expensive breakout immediately.
 */
export const GRID_BREAKOUT_CONFIRM_MINUTES = 30;

/** A strong, persistent ADX confirms a breach without waiting for persistence. */
export const GRID_BREAKOUT_ADX_CONFIRM = 25;
export const GRID_BREAKOUT_ADX_CONFIRM_EVALS = 3;

/** An excursion outside the band that reverts inside within this window is a false break. */
export const GRID_FALSE_BREAK_MAX_MINUTES = 120;

export type BreakoutSide = 'NONE' | 'ABOVE' | 'BELOW';
export type BreakoutConfirmedBy = 'PERSISTENCE' | 'EFFICIENCY' | 'ADX' | null;

export interface RangeBreakoutInput {
  currentPx: number;
  minPx: number;
  maxPx: number;
  /** Hard stop the venue already holds below the band, if any (the band never widens past it). */
  slTriggerPx?: number;
  /** Take-profit the venue already holds above the band, if any. */
  tpTriggerPx?: number;
  /** Configured buffer, in %. Missing/negative -> `GRID_BREAKOUT_MIN_BUFFER_PCT`. */
  configuredBufferPct?: number;
  /** ATR(15m) in % of price; widens the buffer by `GRID_BREAKOUT_ATR_BUFFER_MULT`. */
  atrPct?: number;
  /** Minutes price has been CONTINUOUSLY outside [minPx, maxPx]. */
  outsideMinutes?: number;
  /** Efficiency ratio on the exit window (`GRID_ER_EXIT_CONFIRMED`). */
  efficiencyRatio?: number | null;
  /** ADX(14) on 15m bars. */
  adx?: number;
  /** Consecutive evaluations with ADX above the stop threshold. */
  adxEvalsAboveStop?: number;
  /** Overrides `GRID_BREAKOUT_CONFIRM_MINUTES`. */
  confirmMinutes?: number;
}

export interface RangeBreakoutAssessment {
  side: BreakoutSide;
  /** Price is outside [minPx, maxPx] — the raw band, no buffer. */
  outsideBand: boolean;
  /** Price is beyond the buffered break price. Only then can a STOP be considered. */
  beyondBuffer: boolean;
  /** Buffer actually applied, in %. */
  bufferPct: number;
  lowerBreakPx: number;
  upperBreakPx: number;
  /** The breach is corroborated by persistence, efficiency ratio or a persistent ADX. */
  confirmed: boolean;
  confirmedBy: BreakoutConfirmedBy;
  /** Minutes outside the band, echoed for the reason text. */
  outsideMinutes: number;
}

/**
 * Classifies a price against a grid band and decides whether a breach is CONFIRMED.
 *
 * The single rule this replaces (`currentPx > maxPx * 1.0015` -> STOP) could not tell a 4-minute
 * wick from a 17-hour rally, so it produced 70 range-breakout stops on bots whose median life was
 * 50 minutes: the band was being EXITED, not BROKEN. Corroboration order is deliberate —
 * persistence first (cheap, cadence-independent), then the efficiency ratio (the tape itself says
 * it is travelling), then a persistent ADX.
 */
export function assessRangeBreakout(input: RangeBreakoutInput): RangeBreakoutAssessment {
  const { currentPx, minPx, maxPx } = input;
  const outsideMinutes = Math.max(0, Number(input.outsideMinutes) || 0);
  const degraded = !(currentPx > 0) || !(minPx > 0) || !(maxPx > minPx) || !Number.isFinite(currentPx);

  const configured = Number(input.configuredBufferPct);
  const bufferPct = Math.max(
    Number.isFinite(configured) && configured >= 0 ? configured : GRID_BREAKOUT_MIN_BUFFER_PCT,
    GRID_BREAKOUT_MIN_BUFFER_PCT,
    Math.max(0, Number(input.atrPct) || 0) * GRID_BREAKOUT_ATR_BUFFER_MULT
  );

  if (degraded) {
    return {
      side: 'NONE',
      outsideBand: false,
      beyondBuffer: false,
      bufferPct,
      lowerBreakPx: 0,
      upperBreakPx: 0,
      confirmed: false,
      confirmedBy: null,
      outsideMinutes,
    };
  }

  const lowerBreakPx =
    input.slTriggerPx && input.slTriggerPx > 0 && input.slTriggerPx < minPx
      ? Math.max(input.slTriggerPx, minPx * (1 - bufferPct / 100))
      : minPx * (1 - bufferPct / 100);
  const upperBreakPx =
    input.tpTriggerPx && input.tpTriggerPx > maxPx
      ? Math.min(input.tpTriggerPx, maxPx * (1 + bufferPct / 100))
      : maxPx * (1 + bufferPct / 100);

  const below = currentPx < lowerBreakPx;
  const above = currentPx > upperBreakPx;
  const side: BreakoutSide = above ? 'ABOVE' : below ? 'BELOW' : 'NONE';
  const outsideBand = currentPx < minPx || currentPx > maxPx;
  const beyondBuffer = side !== 'NONE';

  if (!beyondBuffer) {
    return {
      side,
      outsideBand,
      beyondBuffer,
      bufferPct,
      lowerBreakPx,
      upperBreakPx,
      confirmed: false,
      confirmedBy: null,
      outsideMinutes,
    };
  }

  const confirmMinutes = Math.max(
    0,
    Number.isFinite(Number(input.confirmMinutes))
      ? Number(input.confirmMinutes)
      : GRID_BREAKOUT_CONFIRM_MINUTES
  );
  const er = Number(input.efficiencyRatio) || 0;
  const adx = Number(input.adx) || 0;
  const adxEvals = Number(input.adxEvalsAboveStop) || 0;

  let confirmedBy: BreakoutConfirmedBy = null;
  if (outsideMinutes >= confirmMinutes) confirmedBy = 'PERSISTENCE';
  else if (er >= GRID_ER_EXIT_CONFIRMED) confirmedBy = 'EFFICIENCY';
  else if (adx > GRID_BREAKOUT_ADX_CONFIRM && adxEvals >= GRID_BREAKOUT_ADX_CONFIRM_EVALS) {
    confirmedBy = 'ADX';
  }

  return {
    side,
    outsideBand,
    beyondBuffer,
    bufferPct,
    lowerBreakPx,
    upperBreakPx,
    confirmed: confirmedBy !== null,
    confirmedBy,
    outsideMinutes,
  };
}

// ---------------------------------------------------------------------------
// False-break bookkeeping
// ---------------------------------------------------------------------------

export interface OutsideBandState {
  /** Timestamp (ms) the current excursion started; 0 when price is inside the band. */
  sinceAt: number;
  /** Minutes price has been continuously outside the band, as of the last update. */
  outsideMinutes: number;
  /** Excursions that returned inside the band within `GRID_FALSE_BREAK_MAX_MINUTES`. */
  falseBreaks: number;
}

export const INITIAL_OUTSIDE_BAND_STATE: OutsideBandState = {
  sinceAt: 0,
  outsideMinutes: 0,
  falseBreaks: 0,
};

/**
 * Advances the "how long has price been outside the band" state machine by one price tick.
 *
 * This produces the measurement the audit says does not exist: "false break rate is not a
 * first-class metric". An excursion that reverts inside the band within two hours WAS a wick the
 * bot survived, so counting it turns `falseBreakCount / stops` from an estimate into a number.
 *
 * Call on every price refresh: these counters are what `assessRangeBreakout` reads, and they are
 * time-based so the analyzer's cadence cannot change their meaning.
 */
export function advanceOutsideBandState(
  prev: Partial<OutsideBandState> | undefined,
  input: {
    currentPx: number;
    minPx: number;
    maxPx: number;
    now: number;
    maxFalseBreakMinutes?: number;
  }
): OutsideBandState {
  const state: OutsideBandState = { ...INITIAL_OUTSIDE_BAND_STATE, ...(prev || {}) };
  const { currentPx, minPx, maxPx, now } = input;

  if (!(currentPx > 0) || !(minPx > 0) || !(maxPx > minPx)) return state;

  const outside = currentPx < minPx || currentPx > maxPx;
  if (outside) {
    const sinceAt = state.sinceAt > 0 ? state.sinceAt : now;
    return {
      sinceAt,
      outsideMinutes: parseFloat(Math.max(0, (now - sinceAt) / 60_000).toFixed(2)),
      falseBreaks: state.falseBreaks,
    };
  }

  // Back inside. An excursion that started outside has just ended: it was either a wick (counted)
  // or a genuine breakout that recovered (too long to call a wick - not counted).
  if (state.sinceAt > 0) {
    const excursionMinutes = (now - state.sinceAt) / 60_000;
    const maxMinutes = Math.max(1, Number(input.maxFalseBreakMinutes) || GRID_FALSE_BREAK_MAX_MINUTES);
    return {
      sinceAt: 0,
      outsideMinutes: 0,
      falseBreaks: state.falseBreaks + (excursionMinutes <= maxMinutes ? 1 : 0),
    };
  }

  return { sinceAt: 0, outsideMinutes: 0, falseBreaks: state.falseBreaks };
}
