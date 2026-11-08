/**
 * NATIVE GRID SIZING — integer cents, one source of truth
 * =============================================================================
 * OKX `calculateGridMinInvestment` answers with up to 4 decimals (e.g. 11.9108).
 * The create path used to do:
 *
 *     const sz = parseFloat(Math.max(5, baseSz, minInv.minInvestmentUSDT).toFixed(2)); // -> 11.91
 *     if (sz < minInv.minInvestmentUSDT) reject(...);                                 // 11.91 < 11.9108
 *
 * so a grid was rejected while PRINTING the same number on both sides:
 *
 *     "Investiția alocată ($11.91) este sub investiția minimă cerută de OKX ($11.91 USD)"
 *
 * Two independent defects, both fixed here, both in integer cents:
 *
 *   1. ROUNDING — `toFixed(2)` rounds the requirement DOWN, so 11.9108 became 11.91, i.e.
 *      below the very floor it was derived from. The requirement now rounds UP (ceil).
 *   2. COMPARISON — a cents-rounded `sz` was compared against the raw 4-decimal value, so
 *      two numbers that render identically could still compare as "less". Both sides are
 *      now whole cents: equality is equality.
 *
 * On top of that we add 1 cent of headroom (capped by the budget), because an exact-equality
 * size is the one case OKX's own rounding could still shave. Pure functions only — no I/O.
 */

/** USD -> cents with binary-float noise removed before any rounding decision. */
export function usdToCents(usd: number): number {
  const n = Number(usd);
  if (!Number.isFinite(n) || n <= 0) return 0;
  // 5.11 * 100 === 510.99999999999994 and 11.91 * 100 === 1191.0000000000002: rounding to
  // 6 decimals first puts the value back on the cent grid.
  return Math.round(n * 1e6) / 1e4;
}

export interface NativeGridSizePlan {
  /** Margin to send, in cents (2 decimals is the unit OKX bills the investment in). */
  szCents: number;
  /** Live OKX minimum for THIS geometry, rounded UP to whole cents. */
  minInvCents: number;
  /** Margin requested by the caller, in cents. */
  requestedCents: number;
  /** True when the OKX minimum fits inside the per-bot budget. */
  fitsBudget: boolean;
  /** sz is still below the live OKX minimum — the caller must refuse the grid. */
  belowMinimum: boolean;
  /** sz had to be raised above the request to clear the OKX floor. */
  raised: boolean;
}

/**
 * Resolves the margin for one native contract grid.
 *
 * Guarantees:
 *   - `sz` never exceeds `maxBudgetUSDT` (nor the request, whichever is larger);
 *   - `sz` never sits below the OKX minimum when the minimum fits the budget;
 *   - `sz` never goes under `floorUSDT` (OKX's absolute 5 USDC minimum);
 *   - the requirement rounds UP, never down — 11.9101 must not be sent as 11.91.
 */
export function resolveNativeGridSize(input: {
  requestedUSDT: number;
  minInvestmentUSDT: number;
  maxBudgetUSDT: number;
  floorUSDT?: number;
}): NativeGridSizePlan {
  const floorCents = Math.round(usdToCents(input.floorUSDT ?? 5));
  const requestedCents = Math.round(usdToCents(input.requestedUSDT));
  // The budget ceiling is the larger of the request and the configured cap: a caller that
  // explicitly asked for more than the cap is not silently shrunk here.
  const budgetCents = Math.round(
    usdToCents(Math.max(requestedCents / 100, input.maxBudgetUSDT))
  );
  const minInvCents = Math.ceil(usdToCents(input.minInvestmentUSDT));
  const fitsBudget = minInvCents === 0 || minInvCents <= budgetCents;

  // 1 cent of headroom over the OKX floor, but never past the budget: when the minimum
  // equals the budget, the budget wins (and equality has to be accepted by OKX).
  const wantedCents =
    minInvCents === 0 ? 0 : fitsBudget ? Math.min(budgetCents, minInvCents + 1) : 0;

  const szCents = Math.max(floorCents, requestedCents, wantedCents);

  return {
    szCents,
    minInvCents,
    requestedCents,
    fitsBudget,
    belowMinimum: minInvCents > 0 && szCents < minInvCents,
    raised: minInvCents > 0 && szCents > requestedCents,
  };
}
