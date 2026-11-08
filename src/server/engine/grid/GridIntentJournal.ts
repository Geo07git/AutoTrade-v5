/**
 * GRID INTENT JOURNAL — crash-safe intent tracking
 * =============================================================================
 * Every grid mutation is written here BEFORE the network call, so a crash, a timeout or a
 * DNS failure can never lose the fact that an order MIGHT exist on OKX.
 *
 * The dangerous state is `SUBMITTED_UNKNOWN`: we sent something and never learned whether it
 * landed. It may only be resolved by reconciliation against OKX (D4/`GridReconciler`), never
 * by resubmitting — resubmitting a grid whose create call merely timed out is how a desk
 * silently doubles a position.
 *
 * Storage is injected (`IntentStoreAdapter`), so the journal itself stays pure and testable:
 * TradeBot backs it with a `JsonStore`, tests back it with an in-memory array.
 */

export type GridIntentAction = 'OPEN' | 'CLOSE' | 'AMEND';

export type GridIntentState =
  /** Plan built, nothing sent. */
  | 'PLANNED'
  /** Live min-investment probe done, still nothing sent. */
  | 'PROBED'
  /** About to send. A crash here means "may or may not have been sent". */
  | 'SUBMITTING'
  /** Sent, outcome unknown. Resolvable ONLY by reconciliation. */
  | 'SUBMITTED_UNKNOWN'
  /** OKX confirmed the bot / the stop. */
  | 'CONFIRMED'
  /** OKX rejected it, or a local gate refused before sending. */
  | 'REJECTED'
  /** Nobody ever found it on OKX — abandoned on purpose, not silently retried. */
  | 'ABANDONED';

export interface GridIntent {
  intentId: string;
  action: GridIntentAction;
  instId: string;
  state: GridIntentState;
  createdAt: number;
  updatedAt: number;
  /** Agent cycle / UI action that produced this intent. */
  runId?: string;
  /** Geometry fingerprint from `gridPlan.geometryHash` (OPEN intents). */
  geometryHash?: string;
  /** Margin in whole cents (OPEN intents). */
  szCents?: number;
  /** OKX confirmation fingerprint: minPx/maxPx/gridNum/lever as observed. */
  geometry?: { minPx: number; maxPx: number; gridNum: number; lever: number; runType: string };
  attempts: number;
  algoId?: string;
  lastError?: string;
  reasonCodes: string[];
  /** Free-form notes for the operator; never parsed. */
  detail?: string;
}

export interface IntentStoreAdapter {
  load(): GridIntent[];
  save(intents: GridIntent[]): void;
}

/** In-memory adapter: used by tests and as a safe fallback when persistence fails. */
export class MemoryIntentStore implements IntentStoreAdapter {
  private items: GridIntent[] = [];
  constructor(seed: GridIntent[] = []) {
    this.items = JSON.parse(JSON.stringify(seed));
  }
  load(): GridIntent[] {
    return JSON.parse(JSON.stringify(this.items));
  }
  save(intents: GridIntent[]): void {
    this.items = JSON.parse(JSON.stringify(intents));
  }
}

const TERMINAL: GridIntentState[] = ['CONFIRMED', 'REJECTED', 'ABANDONED'];

export const isTerminalState = (state: GridIntentState): boolean => TERMINAL.includes(state);

/** States from which a resend is allowed. `SUBMITTING`/`SUBMITTED_UNKNOWN` are NOT. */
export const isResubmittableState = (state: GridIntentState): boolean =>
  state === 'PLANNED' || state === 'PROBED' || state === 'REJECTED' || state === 'ABANDONED';

/**
 * Deterministic identity: the same action on the same geometry inside the same run is ONE
 * intent, no matter how many times a retry loop asks for it.
 */
export function makeIntentId(
  action: GridIntentAction,
  instId: string,
  geometryHash?: string
): string {
  const suffix = geometryHash ? String(geometryHash) : 'no-geometry';
  return `${action}:${String(instId)}:${suffix}`;
}

export interface GridIntentJournalOptions {
  now: () => number;
  /** How many terminal intents to keep in addition to every non-terminal one. */
  maxTerminal?: number;
}

export class GridIntentJournal {
  private store: IntentStoreAdapter;
  private now: () => number;
  private maxTerminal: number;

  constructor(store: IntentStoreAdapter, options: GridIntentJournalOptions) {
    this.store = store;
    this.now = options.now;
    this.maxTerminal = Math.max(1, Math.round(options.maxTerminal ?? 100));
  }

  public list(): GridIntent[] {
    try {
      return this.store.load() || [];
    } catch {
      // A corrupt journal must not take the desk down; it must also never look "empty but fine"
      // to a caller that then resubmits. Callers treat an empty journal as "no history".
      return [];
    }
  }

  public find(intentId: string): GridIntent | undefined {
    return this.list().find((i) => i.intentId === intentId);
  }

  public findByAlgoId(algoId: string): GridIntent | undefined {
    return this.list().find((i) => i.algoId === algoId);
  }

  /** Intents whose outcome is still unknown — the ones a boot MUST reconcile. */
  public unresolved(): GridIntent[] {
    return this.list().filter((i) => !isTerminalState(i.state));
  }

  /** True only when the journal has no record that this intent was already sent. */
  public canSubmit(intentId: string): boolean {
    const existing = this.find(intentId);
    if (!existing) return true;
    return isResubmittableState(existing.state);
  }

  /**
   * Creates the intent, or returns the existing one untouched. Never mutates state: a caller
   * that already has an unresolved intent gets it back and must reconcile it first.
   */
  public plan(input: {
    action: GridIntentAction;
    instId: string;
    runId?: string;
    geometryHash?: string;
    szCents?: number;
    reasonCodes?: string[];
    detail?: string;
  }): GridIntent {
    const intentId = makeIntentId(input.action, input.instId, input.geometryHash);
    const existing = this.find(intentId);
    if (existing) return existing;

    const ts = this.now();
    const intent: GridIntent = {
      intentId,
      action: input.action,
      instId: String(input.instId),
      state: 'PLANNED',
      createdAt: ts,
      updatedAt: ts,
      runId: input.runId,
      geometryHash: input.geometryHash,
      szCents: input.szCents,
      attempts: 0,
      reasonCodes: [...(input.reasonCodes || [])],
      detail: input.detail,
    };
    const all = this.list();
    all.push(intent);
    this.persist(all);
    return intent;
  }

  /**
   * Moves an intent forward. Refuses the transitions that would let a caller resubmit an
   * order whose fate is unknown, and refuses to move anything out of a terminal state.
   */
  public transition(
    intentId: string,
    state: GridIntentState,
    patch: Partial<Omit<GridIntent, 'intentId' | 'action' | 'instId' | 'state'>> = {}
  ): GridIntent | undefined {
    const all = this.list();
    const idx = all.findIndex((i) => i.intentId === intentId);
    if (idx === -1) return undefined;

    const current = all[idx];
    if (isTerminalState(current.state)) return current;

    if (state === 'SUBMITTING' && current.state === 'SUBMITTED_UNKNOWN') {
      // Guard rail: the ONLY exit from SUBMITTED_UNKNOWN is a reconciliation verdict.
      return current;
    }

    const next: GridIntent = {
      ...current,
      ...patch,
      state,
      updatedAt: this.now(),
      attempts: state === 'SUBMITTING' ? current.attempts + 1 : current.attempts,
    };
    if (patch.reasonCodes) {
      next.reasonCodes = [...new Set([...current.reasonCodes, ...patch.reasonCodes])];
    }
    all[idx] = next;
    this.persist(all);
    return next;
  }

  /** Terminal write in one hop, so a confirmed bot can never sit half-recorded. */
  public settle(
    intentId: string,
    state: Extract<GridIntentState, 'CONFIRMED' | 'REJECTED' | 'ABANDONED'>,
    patch: Partial<Omit<GridIntent, 'intentId' | 'action' | 'instId' | 'state'>> = {}
  ): GridIntent | undefined {
    return this.transition(intentId, state, patch);
  }

  /** Keeps every non-terminal intent plus the newest `maxTerminal` terminal ones. */
  private persist(intents: GridIntent[]): void {
    const terminal = intents
      .filter((i) => isTerminalState(i.state))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, this.maxTerminal);
    const live = intents.filter((i) => !isTerminalState(i.state));
    const pruned = [...live, ...terminal].sort((a, b) => a.createdAt - b.createdAt);
    try {
      this.store.save(pruned);
    } catch {
      // Persistence failure is reported by the caller's logger; losing the write must not
      // change the decision that was already taken in memory.
    }
  }
}
