/**
 * GRID RECONCILER — the only way out of "we don't know"
 * =============================================================================
 * The gateway never resends an intent in `SUBMITTING` or `SUBMITTED_UNKNOWN`. That refusal is
 * only safe if something eventually ANSWERS the question, otherwise a single timeout freezes
 * that instrument forever. This is that something.
 *
 * Rules, in order of importance:
 *
 *   1. If the venue cannot be asked, NOTHING is changed. Marking an intent `ABANDONED` on a
 *      failed query would re-open the door to a resend, and a resent grid is a doubled
 *      position. `unavailable` is a first-class outcome.
 *   2. Presence is proved by the venue, not by our optimism: a bot found running (by algoId,
 *      or by instId + geometry) resolves the OPEN as `CONFIRMED`.
 *   3. Absence is only concluded from a SUCCESSFUL query that lists the instrument: no such
 *      bot, so the create never landed → `ABANDONED`, which is what re-allows a retry.
 *   4. Ambiguity is reported, never guessed. Two matching bots and no algoId stays unknown.
 *   5. A CLOSE whose bot is still running did not take effect → `ABANDONED` (a new stop may be
 *      issued), while a CLOSE whose bot is gone is `CONFIRMED`.
 *
 * Pure apart from the injected port and clock: `gridReconciler.test.ts` exercises every branch,
 * including the "venue down" path and a full gateway→timeout→reconcile→retry loop.
 */

import {
  type GridIntent,
  type GridIntentJournal,
} from './GridIntentJournal';
import type { GridReasonCode } from './gridReasonCodes';

// ---------------------------------------------------------------------------
// Port
// ---------------------------------------------------------------------------

export interface GridVenueBot {
  algoId: string;
  instId: string;
  state: 'running' | 'stopped';
  /** Optional geometry, used to match an intent that never learned its algoId. */
  minPx?: number;
  maxPx?: number;
  gridNum?: number;
  lever?: number;
}

/**
 * One call, all bots: a per-intent query would be N round-trips per cycle and could still see
 * a bot appear between two of them.
 */
export interface GridReconcilePort {
  listVenueBots(): Promise<GridVenueBot[]>;
}

export interface GridReconcilerOptions {
  journal: GridIntentJournal;
  venue: GridReconcilePort;
  /** Keep at most this many intents per cycle (protects the API budget). Default 50. */
  maxPerCycle?: number;
  log?: (level: 'info' | 'warn' | 'error', message: string, details?: unknown) => void;
}

export interface GridReconcileDecision {
  intentId: string;
  action: GridIntent['action'];
  instId: string;
  from: GridIntent['state'];
  to: GridIntent['state'] | 'UNCHANGED';
  codes: GridReasonCode[];
  detail: string;
  algoId?: string;
}

export interface GridReconcileReport {
  /** False when the venue could not be listed — nothing was touched. */
  available: boolean;
  checked: number;
  confirmed: number;
  abandoned: number;
  stillUnknown: number;
  decisions: GridReconcileDecision[];
  codes: GridReasonCode[];
}

const DEFAULT_MAX_PER_CYCLE = 50;

// ---------------------------------------------------------------------------
// Reconciler
// ---------------------------------------------------------------------------

export class GridReconciler {
  private journal: GridIntentJournal;
  private venue: GridReconcilePort;
  private maxPerCycle: number;
  private log: (level: 'info' | 'warn' | 'error', message: string, details?: unknown) => void;

  constructor(opts: GridReconcilerOptions) {
    this.journal = opts.journal;
    this.venue = opts.venue;
    this.maxPerCycle = Math.max(1, opts.maxPerCycle ?? DEFAULT_MAX_PER_CYCLE);
    this.log = opts.log || (() => {});
  }

  /**
   * Resolves every intent whose outcome is unknown. Safe to call at boot and on a timer:
   * intents already settled are skipped, so a second run is a no-op.
   */
  public async reconcile(): Promise<GridReconcileReport> {
    const unresolved = this.journal
      .unresolved()
      // Oldest first: the desk's oldest doubt is the most dangerous one.
      .sort((a, b) => a.createdAt - b.createdAt || a.intentId.localeCompare(b.intentId))
      .slice(0, this.maxPerCycle);

    const empty: GridReconcileReport = {
      available: true,
      checked: 0,
      confirmed: 0,
      abandoned: 0,
      stillUnknown: 0,
      decisions: [],
      codes: [],
    };
    if (unresolved.length === 0) return empty;

    // 1. Ask the venue ONCE. Failure means "we still don't know" — never "it never landed".
    let venueBots: GridVenueBot[];
    try {
      venueBots = await this.venue.listVenueBots();
      if (!Array.isArray(venueBots)) throw new Error('venue returned a non-list');
    } catch (err: any) {
      this.log('error', 'grid reconcile unavailable — intents left untouched', {
        unresolved: unresolved.length,
        error: err?.message || String(err),
      });
      return {
        ...empty,
        available: false,
        checked: 0,
        stillUnknown: unresolved.length,
        codes: ['RECONCILE_UNAVAILABLE'],
      };
    }

    const decisions: GridReconcileDecision[] = [];
    let confirmed = 0;
    let abandoned = 0;
    let stillUnknown = 0;

    for (const intent of unresolved) {
      const decision = this.resolveIntent(intent, venueBots);
      if (decision.to === 'CONFIRMED') confirmed += 1;
      else if (decision.to === 'ABANDONED') abandoned += 1;
      else stillUnknown += 1;
      decisions.push(decision);
    }

    const codes = [...new Set(decisions.flatMap((d) => d.codes))] as GridReasonCode[];
    if (decisions.some((d) => d.to !== 'UNCHANGED')) {
      this.log('info', 'grid reconcile finished', {
        checked: decisions.length,
        confirmed,
        abandoned,
        stillUnknown,
      });
    }

    return {
      available: true,
      checked: decisions.length,
      confirmed,
      abandoned,
      stillUnknown,
      decisions,
      codes,
    };
  }

  // -------------------------------------------------------------------------
  // Per-intent resolution
  // -------------------------------------------------------------------------

  private resolveIntent(intent: GridIntent, venueBots: GridVenueBot[]): GridReconcileDecision {
    const base = {
      intentId: intent.intentId,
      action: intent.action,
      instId: intent.instId,
      from: intent.state,
    };

    return intent.action === 'CLOSE'
      ? this.resolveClose(intent, venueBots, base)
      : this.resolveOpen(intent, venueBots, base);
  }

  private resolveOpen(
    intent: GridIntent,
    venueBots: GridVenueBot[],
    base: Omit<GridReconcileDecision, 'to' | 'codes' | 'detail'>
  ): GridReconcileDecision {
    // (a) We know the algoId: the venue either has it or it does not.
    if (intent.algoId) {
      const found = venueBots.find((b) => b.algoId === intent.algoId);
      if (found) {
        this.settle(
          intent,
          'CONFIRMED',
          ['RECONCILED_CONFIRMED'],
          'found on venue by algoId',
          found.algoId
        );
        return {
          ...base,
          to: 'CONFIRMED',
          algoId: found.algoId,
          codes: ['RECONCILED_CONFIRMED'],
          detail: `Bot ${found.algoId} exists on the venue (${found.state})`,
        };
      }
      // A successful listing that does not contain it is proof it never landed.
      this.settle(
        intent,
        'ABANDONED',
        ['RECONCILED_ABSENT'],
        'venue listing has no such algoId — the create never landed'
      );
      return {
        ...base,
        to: 'ABANDONED',
        codes: ['RECONCILED_ABSENT'],
        detail: `Bot ${intent.algoId} is not on the venue — safe to retry`,
      };
    }

    // (b) No algoId (the timeout case): match on the instrument plus, when recorded, geometry.
    const sameInstrument = venueBots.filter((b) => b.instId === intent.instId);
    const matches = sameInstrument.filter((b) => this.geometryMatches(intent, b));

    if (matches.length === 1) {
      const bot = matches[0];
      this.settle(
        intent,
        'CONFIRMED',
        ['RECONCILED_CONFIRMED'],
        'matched on venue by instrument',
        bot.algoId
      );
      return {
        ...base,
        to: 'CONFIRMED',
        algoId: bot.algoId,
        codes: ['RECONCILED_CONFIRMED'],
        detail: `Create landed as ${bot.algoId} — matched ${intent.instId}`,
      };
    }

    if (matches.length === 0) {
      this.settle(
        intent,
        'ABANDONED',
        ['RECONCILED_ABSENT'],
        'no matching bot on the instrument — the create never landed'
      );
      return {
        ...base,
        to: 'ABANDONED',
        codes: ['RECONCILED_ABSENT'],
        detail: `Nothing on ${intent.instId} matches this intent — safe to retry`,
      };
    }

    // (c) Several candidates and no algoId: guessing here would adopt someone else's bot.
    this.log('warn', 'grid reconcile ambiguous — leaving the intent unknown', {
      intentId: intent.intentId,
      instId: intent.instId,
      candidates: matches.map((b) => b.algoId),
    });
    return {
      ...base,
      to: 'UNCHANGED',
      codes: ['RECONCILE_AMBIGUOUS'],
      detail: `${matches.length} bots match ${intent.instId} — resolve manually, never resent automatically`,
    };
  }

  private resolveClose(
    intent: GridIntent,
    venueBots: GridVenueBot[],
    base: Omit<GridReconcileDecision, 'to' | 'codes' | 'detail'>
  ): GridReconcileDecision {
    const algoId = intent.algoId;
    const found = algoId ? venueBots.find((b) => b.algoId === algoId) : undefined;

    // Gone or stopped: the stop took effect.
    if (!found || found.state === 'stopped') {
      this.settle(intent, 'CONFIRMED', ['RECONCILED_CONFIRMED'], 'bot is no longer running');
      return {
        ...base,
        to: 'CONFIRMED',
        algoId,
        codes: ['RECONCILED_CONFIRMED'],
        detail: algoId ? `Bot ${algoId} is stopped` : 'Bot is no longer on the venue',
      };
    }

    // Still running: the stop did not apply. ABANDONED re-allows a new stop — it does NOT
    // re-open a position, because CLOSE intents only ever stop things.
    this.settle(
      intent,
      'ABANDONED',
      ['RECONCILED_STILL_RUNNING'],
      'stop did not apply — a new stop may be issued'
    );
    return {
      ...base,
      to: 'ABANDONED',
      algoId,
      codes: ['RECONCILED_STILL_RUNNING'],
      detail: `Bot ${algoId} is still running — the stop must be re-issued`,
    };
  }

  private settle(
    intent: GridIntent,
    state: 'CONFIRMED' | 'ABANDONED',
    codes: GridReasonCode[],
    detail: string,
    algoId?: string
  ): void {
    this.journal.settle(intent.intentId, state, {
      reasonCodes: codes as string[],
      // The algoId is the whole point of a reconciliation: without it the desk cannot manage
      // the bot it just proved exists.
      algoId: algoId || intent.algoId,
      lastError: state === 'ABANDONED' ? detail : undefined,
    });
  }

  /**
   * A recorded geometry must match on every field it carries. No heroics: a mismatch means
   * "not this bot", which sends the intent down the ABSENT/AMBIGUOUS path rather than adopting
   * a grid someone else opened.
   */
  private geometryMatches(intent: GridIntent, bot: GridVenueBot): boolean {
    const g = intent.geometry;
    if (!g) return true; // no geometry recorded (legacy intent): instrument match is all we have
    if (bot.minPx === undefined || bot.maxPx === undefined || bot.gridNum === undefined) return false;
    const close = (a: number, b: number): boolean => Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 1e-9);
    return (
      close(bot.minPx, g.minPx) &&
      close(bot.maxPx, g.maxPx) &&
      bot.gridNum === g.gridNum &&
      (g.lever === undefined || bot.lever === undefined || close(bot.lever, g.lever))
    );
  }
}
