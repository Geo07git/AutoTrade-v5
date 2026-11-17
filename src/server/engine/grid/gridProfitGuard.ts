/**
 * PROFIT GUARD — stopping a grid from handing back profit it already earned
 * =============================================================================
 * A neutral grid can be deeply profitable and still end flat. The analyzer's only loss rule is
 * `drawdownPct`, and `GridBotAnalyzer` derives it as
 *
 *     drawdownPct = totalPnlPct < 0 ? Math.abs(totalPnlPct) : 0
 *
 * so a bot at +8% has a drawdown of exactly ZERO. Nothing fires on the way back down: the same
 * bot at +2% is still "in profit", still has zero drawdown, and is left running until the band
 * breaks — by which point the float has eaten the banked grid profit. There was no code, no
 * threshold and no rule for "give back the profit", only for "lose money".
 *
 * This module adds the missing half: a high-water mark of the return, and a giveback band.
 *
 *   armed     = the peak ever reached `armPct`        (a bot that only lost money never arms)
 *   band      = max(peak * ratio, minBandPct)         (a floor, so a small peak is not twitchy)
 *   triggered = armed AND current <= peak - band
 *
 * Why a BAND and not a tight trailing stop: the float of a leveraged grid swings by roughly
 * `rangeWidthPct * leverage` of the margin on a full walk of the band. On a 5% band at 2x that is
 * ~10% of the margin — far more than the 1.7% giveback that triggered this work. A tight trailing
 * stop therefore fires on that swing, not on a real reversal, and exits at the bottom of the range
 * right before the bounce the grid exists to capture. `minBandPct` keeps the guard above that
 * noise; `ratio` keeps it proportional to what was actually earned.
 *
 * Two zeros, deliberately the same value: `undefined` and `0` both mean "never in profit", so a
 * caller with no history and a permanently losing bot reach the same, safe answer.
 *
 * Pure: no I/O, no clock, no randomness.
 */

/** Defaults, kept here so the analyzer thresholds and the tests cannot drift apart. */
export const GRID_PROFIT_GIVEBACK_DEFAULTS = {
  /** Return that must have been reached before the guard arms. */
  armPct: 3,
  /** Fraction of the peak the bot may give back (0 < ratio <= 1). */
  ratio: 0.4,
  /** Absolute floor for the band, in % of margin, so noise cannot arm a stop on a small peak. */
  minBandPct: 2,
} as const;

export interface ProfitGivebackInput {
  /** High-water mark of the return, in % of margin. `undefined` = never in profit. */
  peakPct?: number;
  /** Current return, in % of margin. */
  currentPct?: number;
  armPct?: number;
  ratio?: number;
  minBandPct?: number;
}

export interface ProfitGivebackAssessment {
  /** False until the peak has ever reached `armPct`; every other field is then 0/false. */
  armed: boolean;
  peakPct: number;
  currentPct: number;
  /** Width of the allowed giveback, in % of margin. */
  bandPct: number;
  /** `peakPct - bandPct`: the return below which the guard fires. */
  floorPct: number;
  /** True when the bot has given back more than the band allows. */
  triggered: boolean;
}

function finiteOr(value: number | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function positiveOr(value: number | undefined, fallback: number): number {
  const n = finiteOr(value, fallback);
  return n > 0 ? n : fallback;
}

function ratioOr(value: number | undefined, fallback: number): number {
  const n = finiteOr(value, fallback);
  return n > 0 && n <= 1 ? n : fallback;
}

/**
 * The high-water mark, and the only rule for it: it may rise, and it never goes below zero.
 *
 * Separate from `assessProfitGiveback` because the ratchet is written on every accounting pass
 * while the assessment is only read by the classifier — two call sites, one invariant.
 */
export function ratchetPeak(
  previousPeak: number | undefined,
  currentPct: number | undefined
): number {
  const prev = Math.max(0, finiteOr(previousPeak, 0));
  const cur = Math.max(0, finiteOr(currentPct, 0));
  return cur > prev ? cur : prev;
}

/**
 * Measures the giveback against the peak. Total by construction: it always returns an assessment,
 * and a disarmed one reports zeroes rather than a band that a caller might act on by mistake.
 */
export function assessProfitGiveback(input: ProfitGivebackInput): ProfitGivebackAssessment {
  const armPct = positiveOr(input.armPct, GRID_PROFIT_GIVEBACK_DEFAULTS.armPct);
  const ratio = ratioOr(input.ratio, GRID_PROFIT_GIVEBACK_DEFAULTS.ratio);
  const minBandPct = Math.max(0, finiteOr(input.minBandPct, GRID_PROFIT_GIVEBACK_DEFAULTS.minBandPct));

  const peakPct = Math.max(0, finiteOr(input.peakPct, 0));
  const currentPct = finiteOr(input.currentPct, 0);

  const armed = peakPct >= armPct;
  if (!armed) {
    return { armed: false, peakPct, currentPct, bandPct: 0, floorPct: 0, triggered: false };
  }

  const bandPct = Math.max(peakPct * ratio, minBandPct);
  const floorPct = peakPct - bandPct;

  return {
    armed: true,
    peakPct,
    currentPct,
    bandPct,
    floorPct,
    triggered: currentPct <= floorPct,
  };
}
