/**
 * GRID EXECUTION-ENVIRONMENT GATE
 * =============================================================================
 * The neutral-grid path has one legitimate reason to need `LIVE` while the app is configured
 * for `PAPER`: the native algorithm endpoint rejects `_UM_XPERP` ids (51001) and the order has
 * to go through the limit-order route instead.
 *
 * What it must NOT do is switch the whole application's execution mode as a side effect of a
 * fallback. `TradeBot.createNativeGridBot()` used to call `setExecutionMode('LIVE')` inline —
 * a silent, global, unlogged escalation triggered by a venue error. One failed call and every
 * subsequent operation in the process is live.
 *
 * This module makes that decision explicit and testable: the required environment is requested,
 * an approval flag is consulted, and a refusal carries a code. Nothing here flips anything —
 * the CALLER performs the flip, only when `flipTo` is returned.
 */

import type { ExecutionMode } from '../../../shared/types';
import type { GridReasonCode } from './gridReasonCodes';

export type GridEnvRequirement = 'LIVE' | 'CONFIGURED';

export interface GridEnvGateInput {
  /** The mode the application is configured for right now. */
  current: ExecutionMode;
  /** What the operation needs. `CONFIGURED` means "whatever the app is set to". */
  required: GridEnvRequirement;
  /** Owner approval for an in-process escalation to LIVE. Default is refused. */
  allowFlipToLive: boolean;
}

export interface GridEnvGateDecision {
  allowed: boolean;
  code?: GridReasonCode;
  detail: string;
  /** Set ONLY when the caller is authorised to flip, and must then log the change. */
  flipTo?: 'LIVE';
}

/**
 * Decides whether an operation may proceed in the current execution environment.
 *
 * `required: 'CONFIGURED'` is always allowed — it is the safe default for anything that does
 * not truly need the live venue.
 */
export function resolveGridEnvGate(input: GridEnvGateInput): GridEnvGateDecision {
  const current: ExecutionMode = input.current === 'LIVE' ? 'LIVE' : 'PAPER';

  if (input.required !== 'LIVE') {
    return {
      allowed: true,
      detail: `Running in the configured environment (${current})`,
    };
  }

  if (current === 'LIVE') {
    return {
      allowed: true,
      detail: 'Already in LIVE — no environment change needed',
    };
  }

  if (input.allowFlipToLive) {
    return {
      allowed: true,
      flipTo: 'LIVE',
      detail:
        'LIVE required and explicitly approved (allowGridEnvFlipToLive) — the caller must log the change',
    };
  }

  return {
    allowed: false,
    code: 'ENV_FLIP_REQUIRED',
    detail:
      `LIVE is required but the app is configured for ${current}, and allowGridEnvFlipToLive is not enabled. ` +
      'Approve the escalation in settings or open the bot from a LIVE session — nothing was sent.',
  };
}

/** Human-readable one-liner for logs and the UI. */
export function describeGridEnvGate(decision: GridEnvGateDecision): string {
  return decision.allowed
    ? decision.flipTo
      ? `env: ${decision.flipTo} (approved flip)`
      : 'env: configured'
    : `env: refused (${decision.code})`;
}
