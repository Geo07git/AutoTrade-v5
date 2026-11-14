/**
 * GRID REASON CODES — stable identifiers for every grid decision
 * =============================================================================
 * The analyzer and the supervisor used to communicate in Romanian prose: a stop was
 * recognised downstream by string-matching `reason`, so any wording tweak silently broke
 * routing, telemetry and idempotency. Codes fix that: prose stays for humans, codes decide.
 *
 * Two families, deliberately separate types:
 *
 *   - `GridDecisionCode`  — WHY the analyzer reached a verdict (EMERGENCY / STOP / WARNING /
 *                           MONITOR / CONTINUE). `decisionForCode()` is total, so a code can
 *                           never disagree with a decision.
 *   - `GridExecutionCode` — WHY an open/close/amend was refused or went sideways. Nothing here
 *                           implies a market verdict.
 *
 * `classifyDecisionCodes()` mirrors `GridDecisionEngine.evaluate()` precedence rule for rule.
 * `gridReasonCodes.test.ts` proves it against the real engine on a fixture per rule, so the
 * two can never drift apart.
 *
 * Pure: no I/O, no clock, no randomness.
 */

import type {
  GridAnalyzerDecision,
  GridBotAnalysisSnapshot,
  GridAnalyzerThresholds,
  OKXNativeGridBot,
} from '../../../shared/types';
import type { GridPlanRejectionCode } from './gridPlan';
import { assessRangeBreakout } from './gridRegime';

// ---------------------------------------------------------------------------
// Market verdict codes
// ---------------------------------------------------------------------------

export type GridDecisionCode =
  // CRITICAL — risk
  | 'RISK_LIQ_PROXIMITY'
  | 'RISK_DRAWDOWN_STOP'
  | 'RISK_RANGE_BREAKOUT_CONFIRMED'
  | 'RISK_RANGE_BREAKOUT_UNCONFIRMED'
  | 'RISK_RANGE_BREAKOUT_BUFFER'
  // CRITICAL — regime invalidation
  | 'REGIME_TREND_CONFIRMED'
  | 'REGIME_TREND_MULTI_INDICATOR'
  | 'REGIME_TREND_SINGLE_INDICATOR'
  // CRITICAL — stagnation
  | 'STAGNATION_180M'
  | 'STAGNATION_EARLY_MARKET'
  // WARNING
  | 'RISK_DRAWDOWN_WARNING'
  | 'RISK_RANGE_EDGE_WARNING'
  | 'STAGNATION_120M_REVIEW'
  | 'STAGNATION_60M_WARNING'
  // MONITOR
  | 'REGIME_ADX_MONITOR'
  | 'REGIME_ATR_SPIKE'
  | 'REGIME_CHOP_MONITOR'
  | 'STAGNATION_30M_MONITOR'
  // CONTINUE
  | 'HOLD_PROFITABLE'
  | 'HOLD_RANGE_NORMAL';

// ---------------------------------------------------------------------------
// Execution codes
// ---------------------------------------------------------------------------

export type GridExecutionCode =
  // gates
  | 'KILL_SWITCH_ENGAGED'
  | 'ENV_FLIP_REQUIRED'
  | 'CREDENTIALS_MISSING'
  | 'DRY_RUN'
  // budget
  | 'NO_CAPITAL'
  | 'MAX_BOTS_REACHED'
  | 'DESK_CAP_EXCEEDED'
  | 'BUDGET_CAP_EXCEEDED'
  | 'BUDGET_BELOW_MIN'
  // plan refusals (names are shared with GridPlanRejectionCode on purpose)
  | 'PRICE_INVALID'
  | 'TAPE_UNUSABLE'
  | 'LEVER_INVALID'
  | 'BUDGET_INVALID'
  | 'STEP_BELOW_FEE_FLOOR'
  | 'EDGE_NEGATIVE'
  | 'SPREAD_TOO_WIDE'
  | 'GEOMETRY_INVALID'
  // transport
  | 'PROBE_FAILED'
  | 'INTENT_DUPLICATE'
  | 'GATEWAY_REJECTED'
  | 'GATEWAY_UNKNOWN_OUTCOME'
  | 'CONFIRM_TIMEOUT'
  // reconciliation verdicts
  | 'RECONCILED_CONFIRMED'
  | 'RECONCILED_ABSENT'
  | 'RECONCILED_STILL_RUNNING'
  | 'RECONCILE_AMBIGUOUS'
  | 'RECONCILE_UNAVAILABLE';

export type GridReasonCode = GridDecisionCode | GridExecutionCode;

// ---------------------------------------------------------------------------
// Code -> decision (total)
// ---------------------------------------------------------------------------

const DECISION_BY_CODE: Record<GridDecisionCode, GridAnalyzerDecision> = {
  RISK_LIQ_PROXIMITY: 'EMERGENCY',
  RISK_DRAWDOWN_STOP: 'STOP',
  RISK_RANGE_BREAKOUT_CONFIRMED: 'STOP',
  RISK_RANGE_BREAKOUT_UNCONFIRMED: 'WARNING',
  RISK_RANGE_BREAKOUT_BUFFER: 'WARNING',
  REGIME_TREND_CONFIRMED: 'STOP',
  REGIME_TREND_MULTI_INDICATOR: 'STOP',
  REGIME_TREND_SINGLE_INDICATOR: 'STOP',
  STAGNATION_180M: 'STOP',
  STAGNATION_EARLY_MARKET: 'STOP',
  RISK_DRAWDOWN_WARNING: 'WARNING',
  RISK_RANGE_EDGE_WARNING: 'WARNING',
  STAGNATION_120M_REVIEW: 'WARNING',
  STAGNATION_60M_WARNING: 'WARNING',
  REGIME_ADX_MONITOR: 'MONITOR',
  REGIME_ATR_SPIKE: 'MONITOR',
  REGIME_CHOP_MONITOR: 'MONITOR',
  STAGNATION_30M_MONITOR: 'MONITOR',
  HOLD_PROFITABLE: 'CONTINUE',
  HOLD_RANGE_NORMAL: 'CONTINUE',
};

/** Total by construction: every decision code has exactly one verdict. */
export function decisionForCode(code: GridDecisionCode): GridAnalyzerDecision {
  return DECISION_BY_CODE[code];
}

/** Short, ASCII-only Romanian labels for UI/journal. Prose detail stays in `reason`. */
export const GRID_REASON_MESSAGES_RO: Record<GridReasonCode, string> = {
  RISK_LIQ_PROXIMITY: 'Prea aproape de lichidare',
  RISK_DRAWDOWN_STOP: 'Drawdown peste pragul de stop',
  RISK_RANGE_BREAKOUT_CONFIRMED: 'Iesire confirmata din banda grilei',
  RISK_RANGE_BREAKOUT_UNCONFIRMED: 'Ruptura de banda neconfirmata (wick sau tranzitoriu)',
  RISK_RANGE_BREAKOUT_BUFFER: 'Pret la limita benzii (buffer anti-wick)',
  REGIME_TREND_CONFIRMED: 'Trend directional confirmat multi-indicator',
  REGIME_TREND_MULTI_INDICATOR: 'Regim neutral invalidat multi-indicator',
  REGIME_TREND_SINGLE_INDICATOR: 'Trend persistent pe un singur indicator',
  STAGNATION_180M: 'Stagnare 180m fara activitate productiva',
  STAGNATION_EARLY_MARKET: 'Stagnare anticipata cu piata deteriorata',
  RISK_DRAWDOWN_WARNING: 'Drawdown peste pragul de avertizare',
  RISK_RANGE_EDGE_WARNING: 'Pret aproape de marginea benzii',
  STAGNATION_120M_REVIEW: 'Revizuire oportunitate dupa 120m',
  STAGNATION_60M_WARNING: 'Stagnare 60m fara executii',
  REGIME_ADX_MONITOR: 'ADX peste prag de monitorizare',
  REGIME_ATR_SPIKE: 'Expansiune de volatilitate',
  REGIME_CHOP_MONITOR: 'Choppiness ridicat, fara conditii de stop',
  STAGNATION_30M_MONITOR: 'Monitorizare stagnare 30m',
  HOLD_PROFITABLE: 'Profit realizat net pozitiv',
  HOLD_RANGE_NORMAL: 'Operare normala in banda',

  KILL_SWITCH_ENGAGED: 'Kill switch activ',
  ENV_FLIP_REQUIRED: 'Schimbarea mediului de executie cere aprobare explicita',
  CREDENTIALS_MISSING: 'Cheile API OKX lipsesc sau sunt invalide',
  DRY_RUN: 'Mod simulare: plan validat, nimic trimis',
  NO_CAPITAL: 'Fara capital disponibil dupa rezerva',
  MAX_BOTS_REACHED: 'Numar maxim de boti atins',
  DESK_CAP_EXCEEDED: 'Plafon de marja al desk-ului epuizat',
  BUDGET_CAP_EXCEEDED: 'Buget peste plafonul per bot',
  BUDGET_BELOW_MIN: 'Buget sub investitia minima OKX',
  PRICE_INVALID: 'Pret invalid',
  TAPE_UNUSABLE: 'Date de piata insuficiente pentru geometrie',
  LEVER_INVALID: 'Levier peste plafonul permis',
  BUDGET_INVALID: 'Buget invalid',
  STEP_BELOW_FEE_FLOOR: 'Pas sub podeaua de comision',
  EDGE_NEGATIVE: 'Profit net pe grila negativ',
  SPREAD_TOO_WIDE: 'Spread prea mare fata de pas',
  GEOMETRY_INVALID: 'Geometrie invalida',
  PROBE_FAILED: 'Proba de investitie minima a esuat',
  INTENT_DUPLICATE: 'Intentie identica deja in lucru',
  GATEWAY_REJECTED: 'Respins de gateway',
  GATEWAY_UNKNOWN_OUTCOME: 'Rezultat necunoscut: nu se retrimite',
  CONFIRM_TIMEOUT: 'Confirmarea de la OKX a expirat',
  RECONCILED_CONFIRMED: 'Confirmat prin reconciliere',
  RECONCILED_ABSENT: 'Absent pe venue: create-ul nu a ajuns, se poate relua',
  RECONCILED_STILL_RUNNING: 'Stop-ul nu s-a aplicat: botul ruleaza in continuare',
  RECONCILE_AMBIGUOUS: 'Reconciliere ambigua: mai multi candidati, nu se ghiceste',
  RECONCILE_UNAVAILABLE: 'Reconciliere imposibila: venue indisponibil, nimic modificat',
};

// ---------------------------------------------------------------------------
// Runtime guard
// ---------------------------------------------------------------------------

/**
 * True when a string is one of the registered codes.
 *
 * Needed because a refusal can arrive as a plain string from a port that deliberately does not
 * import this union (the venue port). Validating it HERE keeps the journal and the UI from ever
 * displaying an unregistered "code" that no classifier can interpret.
 */
export function isGridReasonCode(value: unknown): value is GridReasonCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(GRID_REASON_MESSAGES_RO, value);
}

// ---------------------------------------------------------------------------
// Plan refusal -> execution code
// ---------------------------------------------------------------------------

/**
 * `GridPlanRejectionCode` is a strict subset of `GridExecutionCode` (same spellings), so this
 * mapping is an assertion, not a translation table. It exists so plan refusals can travel in a
 * journal that only speaks `GridReasonCode`.
 */
export function planRejectionToReasonCode(code: GridPlanRejectionCode): GridExecutionCode {
  return code;
}

/** True when a plan refusal implies "the desk cannot afford this", i.e. worth retrying later. */
export function isBudgetRefusal(code: GridReasonCode): boolean {
  return code === 'BUDGET_BELOW_MIN' || code === 'BUDGET_CAP_EXCEEDED' || code === 'DESK_CAP_EXCEEDED';
}

// ---------------------------------------------------------------------------
// Classifier — mirrors GridDecisionEngine.evaluate() precedence exactly
// ---------------------------------------------------------------------------

export interface GridDecisionInput {
  bot: OKXNativeGridBot;
  snapshot: GridBotAnalysisSnapshot;
  thresholds: GridAnalyzerThresholds;
  allowStagnationStop?: boolean;
}

/**
 * Returns the codes behind the analyzer's verdict, highest precedence first.
 *
 * The order below is the SAME order `evaluate()` returns in — first match wins. Any change to
 * one MUST be mirrored in the other; `gridReasonCodes.test.ts` enforces that with a fixture per
 * rule, asserting `decisionForCode(codes[0]) === evaluate(...).decision`.
 */
export function classifyDecisionCodes(input: GridDecisionInput): GridDecisionCode[] {
  const { bot, snapshot, thresholds } = input;
  const allowStagnationStop = input.allowStagnationStop !== false;

  // 1. Liquidation proximity -> EMERGENCY
  if (
    snapshot.risk.liqPx > 0 &&
    snapshot.risk.distToLiqPct > 0 &&
    snapshot.risk.distToLiqPct <= thresholds.minLiqSafetyPct
  ) {
    return ['RISK_LIQ_PROXIMITY'];
  }

  // 2. Total drawdown -> STOP
  const effectiveStopDrawdownPct = Math.min(
    thresholds.stopDrawdownPct,
    bot.stopLossPct > 0 ? bot.stopLossPct : thresholds.stopDrawdownPct
  );
  if (snapshot.risk.drawdownPct >= effectiveStopDrawdownPct) {
    return ['RISK_DRAWDOWN_STOP'];
  }

  // 3. Range breakout — buffered and CONFIRMED. Shares `assessRangeBreakout` with the engine's
  //    `evaluate()`, so "confirmed" cannot mean two different things in two places.
  if (bot.stopOnRangeBreakout) {
    const breakout = assessRangeBreakout({
      currentPx: bot.currentPx,
      minPx: bot.minPx,
      maxPx: bot.maxPx,
      slTriggerPx: bot.slTriggerPx,
      tpTriggerPx: bot.tpTriggerPx,
      configuredBufferPct: thresholds.rangeBreakoutBufferPct,
      atrPct: snapshot.market.currentAtrPct,
      outsideMinutes: snapshot.market.rangeOutsideMinutes,
      efficiencyRatio: snapshot.market.efficiencyRatio,
      adx: snapshot.market.adx,
      adxEvalsAboveStop: snapshot.market.adxConsecutiveAboveStop,
      confirmMinutes: thresholds.rangeBreakoutConfirmMinutes,
    });

    if (breakout.beyondBuffer && breakout.confirmed) return ['RISK_RANGE_BREAKOUT_CONFIRMED'];
    if (breakout.beyondBuffer) return ['RISK_RANGE_BREAKOUT_UNCONFIRMED'];
    if (breakout.outsideBand) return ['RISK_RANGE_BREAKOUT_BUFFER'];
  }

  // 4. Regime invalidation
  const adxStopTriggered =
    snapshot.market.adx > thresholds.adxStopThreshold &&
    snapshot.market.adxConsecutiveAboveStop >= thresholds.adxStopConsecutiveCount;
  const chopStopTriggered =
    snapshot.market.choppinessIndex > 0 &&
    snapshot.market.choppinessIndex < thresholds.chopStopThreshold &&
    snapshot.market.chopConsecutiveBelowStop >= thresholds.chopStopConsecutiveCount;
  const hasDirectionalAdxSupport = snapshot.market.adx >= thresholds.adxMonitorThreshold;
  const hasVolatilityOrLossStress =
    snapshot.market.atrChangePct > thresholds.atrSpikeMonitorPct ||
    snapshot.risk.drawdownPct >= thresholds.warningDrawdownPct;

  if (adxStopTriggered && chopStopTriggered) return ['REGIME_TREND_CONFIRMED'];

  if (
    thresholds.requireMultiIndicatorForTrendStop &&
    ((adxStopTriggered && hasVolatilityOrLossStress) ||
      (chopStopTriggered && hasDirectionalAdxSupport && hasVolatilityOrLossStress))
  ) {
    return ['REGIME_TREND_MULTI_INDICATOR'];
  }

  if (
    !thresholds.requireMultiIndicatorForTrendStop &&
    (adxStopTriggered || (chopStopTriggered && hasDirectionalAdxSupport))
  ) {
    return ['REGIME_TREND_SINGLE_INDICATOR'];
  }

  // 5. Stagnation stops
  const stag = snapshot.stagnation;
  if (stag && allowStagnationStop) {
    if (stag.level === 'STOP_180M') return ['STAGNATION_180M'];
    if (stag.level === 'EARLY_STOP_MARKET') return ['STAGNATION_EARLY_MARKET'];
  }

  // 6. Warnings
  if (snapshot.risk.drawdownPct >= thresholds.warningDrawdownPct) return ['RISK_DRAWDOWN_WARNING'];
  if (
    snapshot.risk.minDistToEdgePct >= 0 &&
    snapshot.risk.minDistToEdgePct < thresholds.rangeEdgeWarningPct
  ) {
    return ['RISK_RANGE_EDGE_WARNING'];
  }
  if (stag && (stag.level === 'REVIEW_120M' || stag.level === 'WARNING_60M') && stag.isStagnant) {
    return [stag.level === 'REVIEW_120M' ? 'STAGNATION_120M_REVIEW' : 'STAGNATION_60M_WARNING'];
  }

  // 7. Monitors
  if (snapshot.market.adxConsecutiveAboveMonitor >= thresholds.adxMonitorConsecutiveCount) {
    return ['REGIME_ADX_MONITOR'];
  }
  if (snapshot.market.atrChangePct > thresholds.atrSpikeMonitorPct) return ['REGIME_ATR_SPIKE'];
  if (
    adxStopTriggered ||
    chopStopTriggered ||
    snapshot.market.choppinessIndex < thresholds.chopStopThreshold
  ) {
    return ['REGIME_CHOP_MONITOR'];
  }
  if (stag && (stag.level === 'MONITOR_30M' || stag.level === 'REVIEW_120M')) {
    return ['STAGNATION_30M_MONITOR'];
  }

  // 8. Continue
  const netRealizedAfterCosts = stag
    ? stag.netRealizedProfitAfterCostsUSDT
    : snapshot.performance.netProfitAfterCostsUSDT;
  return netRealizedAfterCosts > 0 ? ['HOLD_PROFITABLE'] : ['HOLD_RANGE_NORMAL'];
}
