/**
 * Auto-arming policy for venue-side stops on AUTO-LIMIT grid bots
 * ===============================================================
 * `okxConditionalStop.ts` knows HOW to place a reduce-only stop and
 * `gridStopTargets.ts` knows WHERE it goes. Neither answers the question this module
 * answers: *should this bot have stops right now, and does it already?*
 *
 * That question is not cosmetic. Without it the only arming path was
 * `registerFallbackBot`, which runs exactly once, at creation. A bot created before the
 * feature existed - or before the flag was on - keeps nothing, and no code ever notices.
 * A manual "arm this one" button fixes that bot and not the next one; the failure being
 * repaired is *forgetting*, so the repair cannot itself depend on remembering.
 *
 * ---------------------------------------------------------------------------------------------
 * THREE STATES, AND WHY IDEMPOTENCY IS THE WHOLE POINT
 * ---------------------------------------------------------------------------------------------
 *   ARM      - running, has a band, and nothing rests at the venue -> place the two legs
 *   KEEP     - running, and stops already rest -> do nothing (a second pair would double up,
 *              and one of the two would outlive the bot)
 *   SKIP     - not running, no usable band, or the lookup failed -> do nothing
 *
 * The dangerous direction is ARM-when-it-should-KEEP: it stacks a second stop pair every
 * cycle. The lookup failure therefore resolves to SKIP, never to ARM - an unreadable venue
 * must degrade to "still unprotected", not to "placed twice".
 *
 * A non-running bot is SKIP rather than CANCEL on purpose: cancelling belongs to the stop
 * lifecycle (`cancelVenueStops` on `stopBot`), which has the bot instance in hand. Doing it
 * from a polling pass would race that path and could cancel a stop a *newer* bot just placed
 * on the same instrument.
 *
 * Pure: no I/O, no clock, no randomness.
 */

export interface ArmDecisionInput {
  /** Engine state of the bot this cycle. Anything but 'RUNNING' is left alone. */
  status: string;
  /** Band edges from the bot config. Non-positive or inverted means no arming. */
  lowerPrice: number;
  upperPrice: number;
  /** Algo ids of conditional stops currently resting at the venue for this instrument. */
  restingAlgoIds: string[];
  /** False when the venue could not be read this cycle. */
  lookupOk: boolean;
}

export interface ArmDecision {
  action: 'ARM' | 'KEEP' | 'SKIP';
  /** Human-readable cause, for the audit log. Never parsed. */
  reason: string;
}

export function decideVenueStopArming(input: ArmDecisionInput): ArmDecision {
  if (!input.lookupOk) {
    return {
      action: 'SKIP',
      reason: 'nu s-a putut citi bursa - nu se plaseaza nimic (un stop dublat e mai rau decat unul lipsa)',
    };
  }

  if (String(input.status).toUpperCase() !== 'RUNNING') {
    return { action: 'SKIP', reason: `botul nu ruleaza (${input.status}) - armarea nu se aplica` };
  }

  const lower = Number(input.lowerPrice);
  const upper = Number(input.upperPrice);
  if (!Number.isFinite(lower) || !Number.isFinite(upper) || !(lower > 0) || !(upper > lower)) {
    return {
      action: 'SKIP',
      reason: `banda nu descrie un interval valid (${input.lowerPrice} / ${input.upperPrice})`,
    };
  }

  const resting = Array.isArray(input.restingAlgoIds) ? input.restingAlgoIds.filter(Boolean) : [];
  if (resting.length > 0) {
    return {
      action: 'KEEP',
      reason: `${resting.length} stop(uri) deja la bursa - nu se dubleaza`,
    };
  }

  return { action: 'ARM', reason: 'ruleaza, banda valida, niciun stop la bursa - se armeaza' };
}

/** True when the automated arming pass is switched on. Absent or any other value = off. */
export function isAutoArmingEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.GRID_VENUE_STOPS === 'auto';
}
