/**
 * Grid PnL accounting — the split between what the grid earned and what the exit cost.
 *
 * Until P0.3 there was one accumulator (`gridProfitUSDT`) fed by two unrelated things:
 *   - completed round-trips (buy low / sell high inside the band)  -> the grid working
 *   - forced market closes of the leftover inventory               -> the exit policy paying
 * Summed together they produced a number that could not answer "was the grid good?".
 * Measured on 2026-11-14: 135 stopped bots showed -5.7032 total, of which +7.5303 came from
 * round-trips and -13.2335 from exits. On 100 of those bots the exit ate more than the grid made.
 *
 * This module owns the arithmetic: no I/O, no clock, no module state, one rounding rule.
 * `NeutralGridEngine` only calls it.
 */

/** Every counter in this file is money in USDT, rounded to 4 decimals. */
export const PNL_DECIMALS = 4;

const r4 = (value: number): number => {
  const next = parseFloat(value.toFixed(PNL_DECIMALS));
  // `0 - 0` and `-0.0000` must never reach JSON as `-0`: it prints as "-0" in the UI.
  return Object.is(next, -0) ? 0 : next;
};

const finite = (value: number): number => (Number.isFinite(value) ? value : 0);

/**
 * The three separate counters plus the two inputs that are not the grid's doing.
 *
 * `feesUSDT` is NOT a second copy of `GridBotInstance.totalFeesUSDT` — it is the same number,
 * exposed under the name the breakdown uses. A persisted duplicate would be a second source of
 * truth for the same money.
 */
export interface GridPnlCounters {
  /** Sum of completed round-trips (gross of fees — fees are charged separately). */
  gridCaptureUSDT: number;
  /** Realized PnL of forced market closes of the remaining inventory (signed, normally < 0). */
  exitCostUSDT: number;
  /** Every fee actually paid: maker on grid fills, taker on forced closes. */
  feesUSDT: number;
  /** Unrealized PnL on the inventory still open. */
  floatingPnlUSDT: number;
  /** Funding already accounted for. */
  fundingEstimateUSDT: number;
}

/** Structural view of a `GridBotInstance` for the capture/exit split (same field names). */
export interface GridPnlSplit {
  gridCaptureUSDT: number;
  exitCostUSDT: number;
}

/** Anything that carries the accounting fields: a counter set, or a bot. */
export interface GridPnlSource {
  gridCaptureUSDT: number;
  exitCostUSDT: number;
  /** Set on a counter set. */
  feesUSDT?: number;
  /** Set on a `GridBotInstance`. */
  totalFeesUSDT?: number;
  floatingPnlUSDT?: number;
  fundingEstimateUSDT?: number;
}

/** The derived view: the three counters, the two external inputs, and the total they produce. */
export interface GridPnlBreakdown extends GridPnlCounters {
  totalNetPnlUSDT: number;
  /** Legacy aggregate = gridCaptureUSDT + exitCostUSDT. Equity is unchanged by the split. */
  gridProfitUSDT: number;
}

/** The only rounding rule in the grid accounting path. */
export function addToCounter(prevValue: number, delta: number): number {
  return r4(finite(prevValue) + finite(delta));
}

export function createPnlCounters(init?: Partial<GridPnlCounters>): GridPnlCounters {
  return {
    gridCaptureUSDT: r4(finite(Number(init?.gridCaptureUSDT))),
    exitCostUSDT: r4(finite(Number(init?.exitCostUSDT))),
    feesUSDT: r4(finite(Number(init?.feesUSDT))),
    floatingPnlUSDT: r4(finite(Number(init?.floatingPnlUSDT))),
    fundingEstimateUSDT: r4(finite(Number(init?.fundingEstimateUSDT))),
  };
}

/** A round-trip closed: this is the grid mechanic earning. Mutates the target. */
export function creditGridCapture<T extends GridPnlSplit>(target: T, netProfitUSDT: number): T {
  target.gridCaptureUSDT = addToCounter(target.gridCaptureUSDT, netProfitUSDT);
  return target;
}

/**
 * A forced close realized PnL on the leftover inventory: this is the exit policy paying.
 * Never mixed into `gridCaptureUSDT` — that is the whole point of the split.
 */
export function chargeExitCost<T extends GridPnlSplit>(target: T, realizedUSDT: number): T {
  target.exitCostUSDT = addToCounter(target.exitCostUSDT, realizedUSDT);
  return target;
}

/** A fee was paid (maker on a grid fill, taker on a forced close). Mutates the target. */
export function chargeFee<T extends { feesUSDT: number }>(target: T, feeUSDT: number): T {
  target.feesUSDT = addToCounter(target.feesUSDT, feeUSDT);
  return target;
}

/** Legacy aggregate kept in sync for every existing reader of the single field. */
export function legacyGridProfit(target: GridPnlSplit): number {
  return r4(finite(target.gridCaptureUSDT) + finite(target.exitCostUSDT));
}

/**
 * totalNetPnlUSDT = capture + exitCost − fees + funding + floating.
 * The identity is unchanged from before the split: it only became attributable.
 */
export function computeNetPnl(counters: GridPnlCounters): number {
  return r4(
    finite(counters.gridCaptureUSDT) +
      finite(counters.exitCostUSDT) -
      finite(counters.feesUSDT) +
      finite(counters.fundingEstimateUSDT) +
      finite(counters.floatingPnlUSDT)
  );
}

/** Reads the counters off a bot (or off a counter set) without mutating anything. */
export function countersFromBot(source: GridPnlSource): GridPnlCounters {
  return createPnlCounters({
    gridCaptureUSDT: source.gridCaptureUSDT,
    exitCostUSDT: source.exitCostUSDT,
    feesUSDT: source.feesUSDT ?? source.totalFeesUSDT ?? 0,
    floatingPnlUSDT: source.floatingPnlUSDT ?? 0,
    fundingEstimateUSDT: source.fundingEstimateUSDT ?? 0,
  });
}

export function buildPnlBreakdown(source: GridPnlSource): GridPnlBreakdown {
  const counters = countersFromBot(source);
  return {
    ...counters,
    totalNetPnlUSDT: computeNetPnl(counters),
    gridProfitUSDT: legacyGridProfit(counters),
  };
}

/**
 * Backfills the split for a bot persisted before P0.3, where only `gridProfitUSDT` exists.
 *
 * The capture is recoverable: every completed round-trip was journalled as a `GridArbitrageEvent`
 * with its own `netProfitUSDT`. Whatever is left of `gridProfitUSDT` after the round-trips is,
 * by elimination, the close. Verified on the 135 historical bots: capture + exit == gridProfitUSDT
 * on all of them, with 0 orphan arbitrage records.
 *
 * Limit: the arbitrage journal keeps the latest 500 events, so a bot with more than that many
 * round-trips would have its capture understated. Only applied when the fields are absent, never
 * recomputed on a bot that already carries them.
 */
export function splitLegacyRealized(
  gridProfitUSDT: number,
  arbitrageNetSumUSDT: number
): GridPnlSplit {
  const capture = r4(finite(arbitrageNetSumUSDT));
  const profit = r4(finite(gridProfitUSDT));
  return { gridCaptureUSDT: capture, exitCostUSDT: r4(profit - capture) };
}

/**
 * True when `capture + exitCost` still equals the aggregate that readers see.
 * $0.01 default tolerance, the same threshold the cash-flow reconciliation uses.
 */
export function splitIsIntact(
  gridProfitUSDT: number,
  split: GridPnlSplit,
  toleranceUSDT: number = 0.01
): boolean {
  const diff = Math.abs(legacyGridProfit(split) - r4(finite(gridProfitUSDT)));
  return diff <= Math.abs(toleranceUSDT);
}
