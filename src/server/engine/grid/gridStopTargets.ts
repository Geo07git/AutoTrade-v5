/**
 * SL / TP derived from the grid's own geometry
 * =============================================
 * The numbers that were running live were incoherent with the bot they protected:
 *
 *   band $66.80 - $70.22, 2x, margin $12
 *   SL labelled -8%  -> displayed price $63.60   (-4.8% BELOW the band bottom)
 *   TP labelled +15% -> displayed price $75.48   (+7.5% ABOVE the band top)
 *
 * Two things are wrong with that, and they are different problems.
 *
 * 1. The SL price sat BELOW the band. A neutral grid stops being a grid the moment price leaves
 *    the band: from there it is a naked directional position with no ladder to unwind it. A stop
 *    1.5% below the edge does not protect the grid, it just lets a broken position run further.
 *
 * 2. The TP price sat ABOVE the band. A neutral grid earns from captures INSIDE the band; leaving
 *    the band is the failure case, not the success case. So a take-profit expressed as a price
 *    above the band can never be reached by a grid that is working — the only rule that can
 *    actually fire is the PnL one, which makes the displayed price decoration.
 *
 * Hence the shape of the answer here:
 *
 *   SL is a PRICE. It is structural: just past the edge where the grid dies. Inventory at that
 *   moment determines the loss, so the % is a property of the position, not of the stop.
 *   `stopLossPct` below is the worst case for a FULLY LOADED one-sided position.
 *
 *   TP is a PnL %. It is earned by captures and has no meaningful price. `takeProfitPrice` is
 *   therefore `null` on purpose — inventing one is how the $75.48 artefact appeared.
 *
 * Why the SL is not tighter. A grid's float swings by roughly `leverage * bandHalfPct` of the
 * margin on a full walk of its band; that IS the normal operating range, not a loss. Stopping
 * inside it means stopping on the oscillation the bot exists to harvest. This repository already
 * has the scar: the 0.15% breakout rule produced 70 of 89 live stops on bots whose median life was
 * 50 minutes. The stop is placed past the edge, and wick tolerance is left to
 * `assessRangeBreakout`, which requires confirmation.
 *
 * Why the TP is `rewardMultiple` x SL rather than a round 15%: a target must be reachable to be a
 * target. With SL 6% and TP 9%, risk:reward is 1:1.5 and both land where the geometry actually is.
 *
 * Pure: no I/O, no clock, no randomness.
 */

export const GRID_STOP_DEFAULTS = {
  /** Distance past the band edge at which the structure is considered dead, in % of price. */
  bufferPct: 0.5,
  /** TP = rewardMultiple x SL. Must be > 1 or the configuration is not worth taking. */
  rewardMultiple: 1.5,
  /** A stop tighter than this is inside the noise of a leveraged grid. */
  minSlPct: 3,
  /** A stop wider than this on a *leveraged* grid risks the liquidation line. */
  maxSlPct: 25,
} as const;

export interface GridStopTargetInput {
  lowerPrice: number;
  upperPrice: number;
  leverage: number;
  bufferPct?: number;
  rewardMultiple?: number;
  minSlPct?: number;
  maxSlPct?: number;
}

export interface GridStopTargets {
  /** False when the geometry cannot describe a band; the caller must KEEP its current values. */
  ok: boolean;
  /** Half-width of the band, in % of the geometric mid. */
  bandHalfPct: number;
  /**
   * Worst-case loss, in % of margin, for a FULLY LOADED one-sided position when price reaches
   * `stopLossPrice`. This is the number to show next to the stop.
   */
  stopLossPct: number;
  /** The structural stop: just past the band edge. */
  stopLossPrice: number;
  /**
   * The structural stop on the UPPER side, just past the top edge. A neutral grid that walks up
   * accumulates sell-side exposure and loses float exactly as it does walking down, so the upper
   * bound is a STOP, not a take-profit. Conflating the two is how the $75.48 artefact was labelled
   * "TP" while the engine used it as a breakout bound.
   */
  stopUpperPrice: number;
  /** Take-profit in % of margin. Earned by captures — there is no price for it. */
  takeProfitPct: number;
  /** Always `null`: a capture-based target has no single price. See the header. */
  takeProfitPrice: null;
  /** The clamp that actually bound, or null when neither did. Never silent. */
  clampedBy: 'min' | 'max' | null;
  /** Human-readable explanation for the journal / UI. */
  rationale: string;
}

function finiteOr(value: number | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function positiveOr(value: number | undefined, fallback: number): number {
  const n = finiteOr(value, fallback);
  return n > 0 ? n : fallback;
}

function round(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

/**
 * Derives the stop-loss and take-profit from the band. Total: it always returns a value, and
 * `ok:false` means "this geometry cannot be described, do not overwrite anything with zeroes" —
 * a zeroed stop is a DISABLED stop, which is the one outcome worse than a badly placed one.
 */
export function computeGridStopTargets(input: GridStopTargetInput): GridStopTargets {
  const lower = Number(input.lowerPrice);
  const upper = Number(input.upperPrice);
  const leverage = Number(input.leverage);

  const bufferPct = positiveOr(input.bufferPct, GRID_STOP_DEFAULTS.bufferPct);
  const rewardMultiple = positiveOr(input.rewardMultiple, GRID_STOP_DEFAULTS.rewardMultiple);
  const minSlPct = Math.max(0.1, finiteOr(input.minSlPct, GRID_STOP_DEFAULTS.minSlPct));
  const maxSlPct = Math.max(minSlPct, positiveOr(input.maxSlPct, GRID_STOP_DEFAULTS.maxSlPct));

  if (
    !Number.isFinite(lower) ||
    !Number.isFinite(upper) ||
    !Number.isFinite(leverage) ||
    !(lower > 0) ||
    !(upper > lower) ||
    !(leverage >= 1)
  ) {
    return {
      ok: false,
      bandHalfPct: 0,
      stopLossPct: 0,
      stopLossPrice: 0,
      stopUpperPrice: 0,
      takeProfitPct: 0,
      takeProfitPrice: null,
      clampedBy: null,
      rationale: 'Geometria benzii nu poate fi descrisa (pret sau levier invalid) - SL/TP existente sunt pastrate.',
    };
  }

  // Geometric mid: neutral grids are spaced geometrically at least as often as arithmetically, and
  // the geometric mid is the correct centre for a ratio-spaced ladder. On an arithmetic band the
  // two differ by well under 0.1%, which is inside the buffer anyway.
  const mid = Math.sqrt(lower * upper);
  const bandHalfPct = ((upper - lower) / 2 / mid) * 100;

  // A fully loaded one-sided position loses approximately `leverage x priceMovePct` of the margin.
  // The structure dies just past the edge, so that is where the stop goes.
  const rawSlPct = leverage * (bandHalfPct + bufferPct);
  const clampedBy = rawSlPct < minSlPct ? 'min' : rawSlPct > maxSlPct ? 'max' : null;
  const stopLossPct = round(Math.min(maxSlPct, Math.max(minSlPct, rawSlPct)), 2);

  const stopLossPrice = round(lower * (1 - bufferPct / 100), 6);
  const stopUpperPrice = round(upper * (1 + bufferPct / 100), 6);
  const takeProfitPct = round(stopLossPct * rewardMultiple, 2);

  const clampNote =
    clampedBy === 'min'
      ? ` (ridicat la minimul de ${minSlPct}% - banda e prea stramta pentru un stop mai mic)`
      : clampedBy === 'max'
        ? ` (limitat la ${maxSlPct}% - la ${leverage}x un stop mai larg se apropie de lichidare)`
        : '';

  return {
    ok: true,
    bandHalfPct: round(bandHalfPct, 3),
    stopLossPct,
    stopLossPrice,
    stopUpperPrice,
    takeProfitPct,
    takeProfitPrice: null,
    clampedBy,
    rationale:
      `Banda ${round(lower, 6)}-${round(upper, 6)} (±${round(bandHalfPct, 2)}% fata de ${round(mid, 4)}). ` +
      `SL este pret structural: ${stopLossPrice} = limita de jos -${bufferPct}% (sus ${stopUpperPrice}), deci ~${stopLossPct}% din marja ` +
      `pentru o pozitie complet incarcata la ${leverage}x${clampNote}. ` +
      `TP +${takeProfitPct}% din marja = ${rewardMultiple}x SL (risc:randament 1:${rewardMultiple}), ` +
      `incasat din capturi - nu are pret, iar un TP peste banda ar fi de neatins.`,
  };
}
