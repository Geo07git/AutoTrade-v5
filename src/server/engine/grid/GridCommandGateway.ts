/**
 * GRID COMMAND GATEWAY — the single choke point for every grid mutation
 * =============================================================================
 * Nothing opens, closes or amends a grid except through here. Before this file the agent,
 * the autopilot and the UI each called the OKX adapter directly, so "was this bot already
 * sent?" was answered by whoever remembered to ask. Three properties are enforced instead:
 *
 *   1. GATE   — kill switch, dry run and plan refusals are decided BEFORE the network.
 *   2. JOURN   — the intent is persisted before the call, so a crash cannot lose the fact that
 *               an order MIGHT exist. `SUBMITTED_UNKNOWN` is never resent; it is reconciled.
 *   3. CONFIRM — a 2xx is not success. The bot is only `CONFIRMED` once the venue reports it
 *               in the expected state; otherwise the intent stays unknown and gets an explicit
 *               `GATEWAY_UNKNOWN_OUTCOME` code for the operator.
 *
 * The venue is a port (`GridVenuePort`), so this module has no OKX import and the whole flow
 * is testable with a fake. `gridCommandGateway.test.ts` covers each path including the
 * dangerous ones (double send after a timeout, resend of an unknown intent).
 *
 * Pure with respect to time/IO: clock and sleep are injected.
 */

import {
  buildGridPlan,
  buildGridPlanFromGeometry,
  isGridPlanRejection,
  type DecidedGridGeometry,
  type GridPlan,
  type GridPlanRequest,
} from './gridPlan';
import {
  GridIntentJournal,
  makeIntentId,
  type GridIntent,
  type GridIntentAction,
} from './GridIntentJournal';
import {
  isGridReasonCode,
  planRejectionToReasonCode,
  type GridReasonCode,
} from './gridReasonCodes';

// ---------------------------------------------------------------------------
// Venue port
// ---------------------------------------------------------------------------

export interface GridVenueCreateResult {
  success: boolean;
  algoId?: string;
  error?: string;
  /**
   * Set ONLY when the refusal was decided LOCALLY, before anything reached the network
   * (kill switch, missing credentials, environment gate, band below the venue minimum).
   *
   * Why a field and not prose: parsing the error string to guess whether an order could be in
   * flight is exactly the fragility this gateway exists to remove. `code` is a plain string so
   * the venue port does not have to import the reason-code union; the gateway validates it with
   * `isGridReasonCode()` before trusting it.
   */
  refusal?: { code: string };
}

export interface GridVenueStopResult {
  success: boolean;
  error?: string;
}

export interface GridVenueOrderState {
  /** `absent` = the venue is sure it has no such bot. `unknown` = we could not ask. */
  state: 'running' | 'stopped' | 'absent' | 'unknown';
  error?: string;
}

/** Everything the gateway needs from the exchange. Implemented by TradeBot/OKXNativeGridEngine. */
export interface GridVenuePort {
  createGrid(params: Record<string, unknown>): Promise<GridVenueCreateResult>;
  stopGrid(algoId: string, stopType: '1' | '2', reason?: string): Promise<GridVenueStopResult>;
  getOrderState(algoId: string): Promise<GridVenueOrderState>;
}

export interface GridGatewayGates {
  /** Kill switch: blocks OPEN only. Closing is always allowed — a kill switch that cannot
   *  flatten is not a kill switch. */
  isKillSwitchEngaged(): boolean;
  /** Recorded on the intent for audit; the gateway never flips it. */
  executionEnvironment(): 'LIVE' | 'DEMO' | 'PAPER';
}

export interface GridCommandGatewayOptions {
  journal: GridIntentJournal;
  venue: GridVenuePort;
  gates: GridGatewayGates;
  now: () => number;
  /** Validate and journal, send nothing. Default false. */
  dryRun?: boolean;
  /** Confirmation polls after a create/stop. Default 3. */
  confirmAttempts?: number;
  confirmDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (level: 'info' | 'warn' | 'error', message: string, details?: unknown) => void;
}

export interface GridOpenMeta {
  /** Agent cycle / UI action that produced the request. */
  runId?: string;
  /**
   * Fields the gateway does not model and must not invent: stop-loss/take-profit triggers,
   * fallback switches. They are MERGED UNDER the plan, so a caller can never override the
   * geometry the gateway validated and journaled.
   */
  venueOverrides?: Record<string, unknown>;
}

export interface GridOpenResult {
  ok: boolean;
  intentId: string;
  codes: GridReasonCode[];
  detail: string;
  algoId?: string;
  plan?: GridPlan;
  /** True when the venue may or may not hold the bot — reconcile, never resend. */
  unknownOutcome?: boolean;
}
export interface GridCloseResult {
  ok: boolean;
  intentId: string;
  codes: GridReasonCode[];
  detail: string;
  unknownOutcome?: boolean;
}

const DEFAULT_CONFIRM_ATTEMPTS = 3;
const DEFAULT_CONFIRM_DELAY_MS = 750;

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------

export class GridCommandGateway {
  private opts: GridCommandGatewayOptions;
  private journal: GridIntentJournal;
  private venue: GridVenuePort;
  private gates: GridGatewayGates;
  /** Makes intent ids unique per open without reusing a finished one. */
  private openSeq = 0;

  constructor(opts: GridCommandGatewayOptions) {
    this.opts = opts;
    this.journal = opts.journal;
    this.venue = opts.venue;
    this.gates = opts.gates;
  }

  private log(level: 'info' | 'warn' | 'error', message: string, details?: unknown): void {
    try {
      this.opts.log?.(level, message, details);
    } catch {
      /* logging must never break a trade path */
    }
  }

  private sleep(ms: number): Promise<void> {
    if (this.opts.sleep) return this.opts.sleep(ms);
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      t.unref?.();
    });
  }

  /**
   * Opens a neutral grid from a validated plan.
   *
   * Order of operations is the safety property: gates → plan → journal → send → confirm.
   * Nothing is sent on the strength of a hope.
   */

  public async openFromPlan(req: GridPlanRequest, meta: GridOpenMeta = {}): Promise<GridOpenResult> {
    // 1. Gate: kill switch. No journal entry, no plan, no network.
    if (this.gates.isKillSwitchEngaged()) {
      this.log('warn', 'grid open blocked: kill switch engaged', { instId: req.instId });
      return {
        ok: false,
        intentId: '',
        codes: ['KILL_SWITCH_ENGAGED'],
        detail: 'Kill switch engaged — no grid may be opened',
      };
    }

    // 2. Plan: geometry + sizing + refusals, all local and pure.
    const built = buildGridPlan(req);
    if (isGridPlanRejection(built)) {
      this.log('warn', 'grid open refused by plan', { instId: req.instId, codes: built.codes });
      return {
        ok: false,
        intentId: '',
        codes: built.codes.map(planRejectionToReasonCode),
        detail: built.detail,
      };
    }
    const plan = built.plan;
    return this.runOpen(plan, meta, false);
  }

  /**
   * Opens a grid whose geometry was already DECIDED upstream (agent, autopilot, operator).
   *
   * Difference from `openFromPlan`: the geometry is validated, not derived. The agent ranked
   * this exact band and level count, so re-deriving them from ATR here would send a different
   * grid than the one that was approved.
   *
   * Duplicate protection differs too, on purpose: the identity is "is there an UNRESOLVED
   * intent for this geometry right now", not "has this geometry ever been used". A finished
   * grid must not block the same band from being opened again later — while a timed-out send
   * still blocks a resend, which is the property that matters.
   */
  public async openWithGeometry(
    geometry: DecidedGridGeometry,

    meta: GridOpenMeta = {}
  ): Promise<GridOpenResult> {
    if (this.gates.isKillSwitchEngaged()) {
      this.log('warn', 'grid open blocked: kill switch engaged', { instId: geometry.instId });
      return {
        ok: false,
        intentId: '',
        codes: ['KILL_SWITCH_ENGAGED'],
        detail: 'Kill switch engaged — no grid may be opened',
      };
    }

    const built = buildGridPlanFromGeometry(geometry);
    if (isGridPlanRejection(built)) {
      this.log('warn', 'grid open refused by geometry', {
        instId: geometry.instId,
        codes: built.codes,
      });
      return {
        ok: false,
        intentId: '',
        codes: built.codes.map(planRejectionToReasonCode),
        detail: built.detail,
      };
    }

    return this.runOpen(built.plan, meta, true);
  }

  /**
   * Steps 3-6, shared by both open entries: journal → gate on the journal → send → confirm.
   *
   * `uniqueIntent` selects the identity model (see `openWithGeometry`).
   */
  private async runOpen(
    plan: GridPlan,

    meta: GridOpenMeta,
    uniqueIntent: boolean
  ): Promise<GridOpenResult> {
    // 3. Journal BEFORE the network. A crash from here on leaves a record that something
    //    might exist, which is exactly what reconciliation needs.
    if (uniqueIntent) {
      const inFlight = this.journal.findUnresolvedByGeometry('OPEN', plan.instId, plan.geometryHash);
      if (inFlight) {
        this.log('error', 'grid open blocked: identical geometry already in flight or unknown', {
          instId: plan.instId,
          intentId: inFlight.intentId,
          state: inFlight.state,
        });
        return {
          ok: false,
          intentId: inFlight.intentId,
          codes: ['INTENT_DUPLICATE'],
          detail: `Intent ${inFlight.intentId} is ${inFlight.state} — reconcile before resending`,
          plan,
          unknownOutcome: inFlight.state === 'SUBMITTED_UNKNOWN' || inFlight.state === 'SUBMITTING',
        };
      }
    }

    this.openSeq += 1;
    const intent = this.journal.plan({
      action: 'OPEN',
      instId: plan.instId,
      runId: meta.runId,
      geometryHash: plan.geometryHash,
      szCents: plan.szCents,
      // The geometry travels with the intent: if the create times out before we learn the
      // algoId, reconciliation matches on these exact numbers instead of guessing.
      geometry: {
        minPx: plan.minPx,
        maxPx: plan.maxPx,
        gridNum: plan.gridNum,
        lever: plan.lever,
        runType: String(plan.runType),
      },
      detail: `env=${this.gates.executionEnvironment()} sz=${plan.szCents / 100} USDT`,
      nonce: uniqueIntent ? `${this.opts.now()}#${this.openSeq}` : undefined,
    });

    if (!this.journal.canSubmit(intent.intentId)) {
      // The ONLY reason this can be false is an in-flight or unknown send. Refusing here is
      // what stops the classic double-open after a timeout.
      this.log('error', 'grid open blocked: intent already in flight or unknown', {
        instId: plan.instId,
        intentId: intent.intentId,
        state: intent.state,
      });
      return {
        ok: false,
        intentId: intent.intentId,
        codes: ['INTENT_DUPLICATE'],
        detail: `Intent ${intent.intentId} is ${intent.state} — reconcile before resending`,
        plan,
        unknownOutcome: intent.state === 'SUBMITTED_UNKNOWN' || intent.state === 'SUBMITTING',
      };
    }

    // 4. Dry run: everything validated, nothing sent, and the journal says so.
    if (this.opts.dryRun) {
      this.journal.settle(intent.intentId, 'ABANDONED', { reasonCodes: ['DRY_RUN'] });
      return {
        ok: true,
        intentId: intent.intentId,
        codes: ['DRY_RUN'],
        detail: `Dry run: ${plan.geometryHash} validated, nothing sent`,
        plan,
      };
    }

    // 5. Send.
    this.journal.transition(intent.intentId, 'SUBMITTING');
    let created: GridVenueCreateResult;
    try {
      created = await this.venue.createGrid(
        toVenueParams(plan, this.gates.executionEnvironment(), meta.venueOverrides)
      );
    } catch (err: any) {
      // A thrown call is the canonical "unknown" case: the request may have been processed.
      return this.markUnknown(intent, 'OPEN', err?.message || 'createGrid threw', plan);
    }

    if (!created?.success) {
      const detail = created?.error || 'venue rejected the grid';
      // A refusal decided LOCALLY (env gate, kill switch, missing keys, band below the venue
      // minimum) is final by construction: nothing was sent, so nothing can be in flight.
      // It is checked BEFORE any string heuristics and keeps its own code.
      const refusalCode = created?.refusal?.code;
      if (refusalCode) {
        const codes: GridReasonCode[] = isGridReasonCode(refusalCode)
          ? [refusalCode]
          : ['GATEWAY_REJECTED'];
        this.journal.settle(intent.intentId, 'REJECTED', {
          lastError: detail,
          reasonCodes: codes,
        });
        this.log('warn', 'grid open refused before sending', {
          instId: plan.instId,
          code: refusalCode,
          detail,
        });
        return { ok: false, intentId: intent.intentId, codes, detail, plan };
      }
      // Only call it rejected when the venue was explicit; anything vaguer stays unknown.
      if (isDefiniteRejection(detail)) {
        this.journal.settle(intent.intentId, 'REJECTED', {
          lastError: detail,
          reasonCodes: ['GATEWAY_REJECTED'],
        });
        this.log('warn', 'grid open rejected by venue', { instId: plan.instId, detail });
        return { ok: false, intentId: intent.intentId, codes: ['GATEWAY_REJECTED'], detail, plan };
      }
      return this.markUnknown(intent, 'OPEN', detail, plan);
    }

    const algoId = created.algoId;
    if (!algoId) {
      return this.markUnknown(intent, 'OPEN', 'venue reported success without an algoId', plan);
    }

    // 6. Confirm. A 2xx is a claim, not a fact.
    this.journal.transition(intent.intentId, 'SUBMITTED_UNKNOWN', { algoId });
    const confirmed = await this.confirmOrderState(algoId, 'running');
    if (confirmed) {
      this.journal.settle(intent.intentId, 'CONFIRMED', { algoId });
      this.log('info', 'grid opened and confirmed', { instId: plan.instId, algoId });
      return {
        ok: true,
        intentId: intent.intentId,
        codes: [],
        detail: `Bot ${algoId} running`,
        algoId,
        plan,
      };
    }

    this.journal.transition(intent.intentId, 'SUBMITTED_UNKNOWN', {
      algoId,
      lastError: 'confirmation timeout',
      reasonCodes: ['CONFIRM_TIMEOUT'],
    });
    this.log('error', 'grid created but not confirmed — reconcile, do not resend', {
      instId: plan.instId,
      algoId,
    });
    return {
      ok: false,
      intentId: intent.intentId,
      codes: ['GATEWAY_UNKNOWN_OUTCOME', 'CONFIRM_TIMEOUT'],
      detail: `Bot ${algoId} created on the venue but not confirmed — reconcile before resending`,
      algoId,
      plan,
      unknownOutcome: true,
    };
  }

  /**
   * Stops a running grid. Allowed even while the kill switch is engaged, and idempotent per
   * (algoId, stopType): a second call after an unknown outcome is refused, not resent.
   */
  public async closeGrid(input: {
    algoId: string;
    instId: string;
    stopType?: '1' | '2';
    reason?: string;
    runId?: string;
  }): Promise<GridCloseResult> {
    const algoId = String(input.algoId || '');
    const instId = String(input.instId || '');
    if (!algoId || !instId) {
      return {
        ok: false,
        intentId: '',
        codes: ['GATEWAY_REJECTED'],
        detail: 'closeGrid needs both algoId and instId',
      };
    }
    const stopType = input.stopType === '2' ? '2' : '1';
    // The intent id folds the stop type in, so "stop and keep position" and "close position"
    // are two distinct operations that cannot shadow each other.
    const geometryKey = `${algoId}:stop${stopType}`;

    const intent = this.journal.plan({
      action: 'CLOSE',
      instId,
      runId: input.runId,
      geometryHash: geometryKey,
      detail: input.reason,
    });

    if (!this.journal.canSubmit(intent.intentId)) {
      return {
        ok: false,
        intentId: intent.intentId,
        codes: ['INTENT_DUPLICATE'],
        detail: `Intent ${intent.intentId} is ${intent.state} — reconcile before resending`,
        unknownOutcome: intent.state === 'SUBMITTED_UNKNOWN' || intent.state === 'SUBMITTING',
      };
    }

    if (this.opts.dryRun) {
      this.journal.settle(intent.intentId, 'ABANDONED', { reasonCodes: ['DRY_RUN'] });
      return { ok: true, intentId: intent.intentId, codes: ['DRY_RUN'], detail: 'Dry run: nothing sent' };
    }

    this.journal.transition(intent.intentId, 'SUBMITTING', { algoId });
    let stopped: GridVenueStopResult;
    try {
      stopped = await this.venue.stopGrid(algoId, stopType, input.reason);
    } catch (err: any) {
      return this.markUnknownClose(intent, err?.message || 'stopGrid threw');
    }

    if (!stopped?.success) {
      const detail = stopped?.error || 'venue rejected the stop';
      if (isDefiniteRejection(detail)) {
        this.journal.settle(intent.intentId, 'REJECTED', {
          lastError: detail,
          reasonCodes: ['GATEWAY_REJECTED'],
        });
        return { ok: false, intentId: intent.intentId, codes: ['GATEWAY_REJECTED'], detail };
      }
      return this.markUnknownClose(intent, detail);
    }

    this.journal.transition(intent.intentId, 'SUBMITTED_UNKNOWN', { algoId });
    const confirmed = await this.confirmOrderState(algoId, 'stopped');
    if (confirmed) {
      this.journal.settle(intent.intentId, 'CONFIRMED', { algoId });
      return { ok: true, intentId: intent.intentId, codes: [], detail: `Bot ${algoId} stopped` };
    }

    this.journal.transition(intent.intentId, 'SUBMITTED_UNKNOWN', {
      algoId,
      lastError: 'stop confirmation timeout',
      reasonCodes: ['CONFIRM_TIMEOUT'],
    });
    return {
      ok: false,
      intentId: intent.intentId,
      codes: ['GATEWAY_UNKNOWN_OUTCOME', 'CONFIRM_TIMEOUT'],
      detail: `Stop of ${algoId} sent but not confirmed — reconcile before resending`,
      unknownOutcome: true,
    };
  }

  /** Journal view for the UI/status: what is in flight or unknown right now. */
  public unresolvedIntents(): GridIntent[] {
    return this.journal.unresolved();
  }

  public findIntent(action: GridIntentAction, instId: string, geometryHash?: string): GridIntent | undefined {
    return this.journal.find(makeIntentId(action, instId, geometryHash));
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async confirmOrderState(
    algoId: string,
    expected: 'running' | 'stopped'
  ): Promise<boolean> {
    const attempts = Math.max(1, this.opts.confirmAttempts ?? DEFAULT_CONFIRM_ATTEMPTS);
    const delay = Math.max(0, this.opts.confirmDelayMs ?? DEFAULT_CONFIRM_DELAY_MS);
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0 && delay > 0) await this.sleep(delay);
      let state: GridVenueOrderState;
      try {
        state = await this.venue.getOrderState(algoId);
      } catch {
        continue; // a failed poll is not a verdict
      }
      if (state?.state === expected) return true;
      // A definitive opposite state ends the wait early: no amount of polling changes it.
      if (expected === 'running' && state?.state === 'stopped') return false;
      if (expected === 'stopped' && (state?.state === 'absent' || state?.state === 'stopped')) {
        return true;
      }
    }
    return false;
  }

  private markUnknown(
    intent: GridIntent,
    _action: GridIntentAction,
    detail: string,
    plan?: GridPlan
  ): GridOpenResult {
    this.journal.transition(intent.intentId, 'SUBMITTED_UNKNOWN', {
      lastError: detail,
      reasonCodes: ['GATEWAY_UNKNOWN_OUTCOME'],
    });
    this.log('error', 'grid open outcome unknown — reconcile, do not resend', {
      instId: intent.instId,
      intentId: intent.intentId,
      detail,
    });
    return {
      ok: false,
      intentId: intent.intentId,
      codes: ['GATEWAY_UNKNOWN_OUTCOME'],
      detail: `Outcome unknown (${detail}) — reconcile before resending`,
      plan,
      unknownOutcome: true,
    };
  }

  private markUnknownClose(intent: GridIntent, detail: string): GridCloseResult {
    this.journal.transition(intent.intentId, 'SUBMITTED_UNKNOWN', {
      lastError: detail,
      reasonCodes: ['GATEWAY_UNKNOWN_OUTCOME'],
    });
    this.log('error', 'grid close outcome unknown — reconcile, do not resend', {
      instId: intent.instId,
      intentId: intent.intentId,
      detail,
    });
    return {
      ok: false,
      intentId: intent.intentId,
      codes: ['GATEWAY_UNKNOWN_OUTCOME'],
      detail: `Outcome unknown (${detail}) — reconcile before resending`,
      unknownOutcome: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Venue failures we may treat as final. OKX rejects with a numeric code (4xxxx/5xxxx) or a
 * message we can act on; timeouts, socket errors and empty responses are NOT final — treating
 * them as rejections is how a bot gets opened twice.
 */
export function isDefiniteRejection(error: string | undefined): boolean {
  const text = String(error || '').trim();
  if (!text) return false;
  if (/^(timeout|timed out|socket|etimedout|econnreset|econnrefused|enotfound|dns)/i.test(text)) {
    return false;
  }
  if (/\b(timeout|timed out|network|unreachable|socket hang up)\b/i.test(text)) return false;
  // Numeric OKX codes and explicit validation failures are final.
  // A leading `CODE:` is a refusal decided LOCALLY before the network (kill switch, env gate),
  // so it is final by construction — nothing was sent, nothing can be in flight.
  return (
    /^[A-Z][A-Z_]{3,}:/.test(text) ||
    /^\d{3,6}\b/.test(text) ||
    /\b(invalid|insufficient|rejected|not allowed|below|exceeds)\b/i.test(text)
  );
}

/** The plan, in the shape the venue adapter expects. Kept in one place on purpose. */
export function toVenueParams(
  plan: GridPlan,
  environment: 'LIVE' | 'DEMO' | 'PAPER',
  overrides?: Record<string, unknown>
): Record<string, unknown> {
  const params: Record<string, unknown> = {
    instId: plan.instId,
    algoOrdType: 'contract_grid',
    direction: 'neutral',
    minPx: plan.minPx,
    maxPx: plan.maxPx,
    gridNum: plan.gridNum,
    runType: plan.runType,
    lever: String(plan.lever),
    sz: (plan.szCents / 100).toFixed(2),
    // The execution variant is part of the plan, never re-derived downstream: `_UM_XPERP` ids
    // answer 51001 on /tradingBot/grid/order-algo and must go through the limit-order path.
    executionVariant: plan.variant,
    environment,
    geometryHash: plan.geometryHash,
  };
  // Overrides come FIRST so every field above wins. A caller may add stop-loss triggers or a
  // fallback switch; it may never re-point the band, the level count or the leverage that the
  // gateway validated and journaled a moment ago.
  return overrides ? { ...overrides, ...params } : params;
}
