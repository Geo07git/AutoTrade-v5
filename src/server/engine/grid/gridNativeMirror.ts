/**
 * NATIVE GRID MIRROR — the counters the analyzer reads must be the LIVE ones
 * ==========================================================================
 * A `_UM_XPERP` grid never reaches OKX's grid-algo gateway (51000), so no venue algo exists for
 * it and `OKXNativeGridEngine` keeps a STATIC adoption row written at creation:
 * `arbitrageNum = 0`, `gridProfit = 0`, `totalPnl = 0`, `peakTotalPnlPct` missing. The real
 * counters live on the TB5 `GridBotInstance` that shares the `botId`.
 *
 * `GridBotAnalyzer.analyzeAll()` reads that mirror (`gridEngine.getAllBots()`) and builds the STOP
 * event out of it, so every AUTO-LIMIT stop was journaled with `pnlBreakdown = 0`. Measured on
 * `grid_irys_mwpcnpqp` (2026-11-21 05:24 UTC): 71 round-trips, +1.1487 capture, +1.0535 net,
 * peak 2.90% — journaled as `grid=0 float=0 total=0 drawdown=0% realizedPnl=0`.
 *
 * Two consequences, both real and both fixed by keeping the mirror honest:
 *
 *   1. The post-mortem could not be done from the audit log. Working out what that bot earned
 *      meant re-summing `grid_arbitrages.json` by hand.
 *   2. `RISK_DRAWDOWN_STOP` and `RISK_PROFIT_GIVEBACK` are classified from `riskMetrics.drawdownPct`
 *      and `peakTotalPnlPct` — both permanently 0 on these rows, so neither gate could ever fire
 *      for an AUTO-LIMIT bot. The engine's own guards read the TB5 row directly and did work
 *      (IRYS's giveback correctly stayed put at peak 2.90 / current 2.77), which is exactly why
 *      the gap was invisible: protection appeared to work while half of it was dead code.
 *
 * The mirror is a COPY, not a second source of truth. The TB5 row owns the numbers; this only
 * stops the copy from lying. Pure (mutates the object it is given, touches no store, no clock) so
 * the mapping is testable without an engine, and idempotent so calling it on every read is free.
 */

import type { OKXNativeGridBot } from '../../../shared/types';

/** The fields the mirror may copy: all counters, never configuration. */
export interface LiveGridCounters {
  gridProfitUSDT?: number;
  floatingPnlUSDT?: number;
  totalNetPnlUSDT?: number;
  totalNetPnlPct?: number;
  peakTotalPnlPct?: number;
  completedArbitrages?: number;
  /** Last price the live engine saw. 0 means "not measured", not "the price is zero". */
  currentPrice?: number;
}

/**
 * Only rows this app created carry a TB5 twin. OKX's own native algos (and anything else) have
 * their counters reported by the venue and must never be overwritten from our side.
 */
export function isMirroredAlgoId(algoId: unknown): boolean {
  return typeof algoId === 'string' && algoId.toLowerCase().startsWith('grid');
}

/**
 * Copies the live counters onto the mirror row, in place. Returns true when anything changed so a
 * caller can decide whether the copy is worth persisting.
 *
 * `null`/`undefined`/`NaN` mean "the live row has no opinion" and are skipped. A real `0` IS
 * copied: a fresh bot with no round-trips is a fact, not a missing value, and treating it as
 * unknown is how a stale non-zero mirror would survive forever.
 */
export function applyLiveCountersToNative(
  mirror: OKXNativeGridBot | null | undefined,
  live: LiveGridCounters | null | undefined
): boolean {
  if (!mirror || !live || !isMirroredAlgoId(mirror.algoId)) return false;

  const measured = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;

  let changed = false;
  const assign = <K extends keyof OKXNativeGridBot>(
    field: K,
    value: OKXNativeGridBot[K] | null
  ): void => {
    if (value === null) return;
    if (mirror[field] === value) return;
    mirror[field] = value as OKXNativeGridBot[K];
    changed = true;
  };

  assign('gridProfit', measured(live.gridProfitUSDT));
  assign('floatProfit', measured(live.floatingPnlUSDT));
  assign('totalPnl', measured(live.totalNetPnlUSDT));
  assign('totalPnlPct', measured(live.totalNetPnlPct));
  assign('arbitrageNum', measured(live.completedArbitrages));
  // Optional on the type, so `assign` writes `undefined` only when the live row has no peak —
  // and `assessProfitTrailingStop` treats a missing peak as "never in profit", never as armed.
  assign('peakTotalPnlPct', measured(live.peakTotalPnlPct));

  const px = measured(live.currentPrice);
  if (px !== null && px > 0) assign('currentPx', px);

  return changed;
}
