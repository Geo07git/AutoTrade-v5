/**
 * TWO-LOOK CONFIRMATION BEFORE AN AGENT-OPENED GRID
 * =============================================================================
 * The scan ranks contracts by `crossingsPerHour` and returns the best of ONE
 * snapshot of the last 48 x 15m candles. That single snapshot is a noisy
 * estimate: a contract can top the ranking because of one 40-minute burst and
 * be dead for the rest of the day. Opening a grid on that burst means paying
 * the entry spread, opening `gridNum` levels and waiting for fills that never
 * come — while the capital stays locked in the band.
 *
 * So a candidate is not allowed to be opened on the strength of one look. It
 * has to qualify TWICE:
 *
 *   - the last time the scanner looked at this contract, AND
 *   - the time before that,
 *
 * with the earlier of the two no older than `maxAgeMinutes` (so an ancient
 * qualification cannot be paired with today's) and no closer than
 * `minSpacingMinutes` (so two manual cycles a minute apart do not count as two
 * independent observations of the market).
 *
 * "Two looks" is deliberately NOT "two consecutive cycles": the scanner
 * rotates its window inside the elite pool (`universeScanMode: 'pool'` visits a
 * contract every ~2 cycles, `'rotation'` every ~11), so requiring consecutive
 * CYCLE ids would make confirmation impossible for most of the universe. The
 * ledger therefore remembers the two most recent qualifications PER CONTRACT,
 * and the definition above is exactly "it qualified the last two times we
 * looked at it".
 *
 * A miss BREAKS the chain: if the contract is not top-N, not eligible, or its
 * edge fell below the floor on the most recent look, `previousQualifiedAt` is
 * cleared and the countdown starts over. That is the point — the confirmation
 * is a statement about the current regime, not a credit the contract earned
 * once and keeps.
 *
 * Everything here is pure and clock-injected, so the behaviour is testable
 * without a market: see `__tests__/agentScanConfirmation.test.ts`.
 */

import type { NativeGridOpportunity } from '../../shared/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScanConfirmationConfig {
  /** A look only qualifies inside this many top ranks. */
  topN: number;
  /** ...and only if its net edge per grid clears this floor (in %). */
  minNetPerGridPct: number;
  /** ...and only if the price crosses levels at least this often (per hour). */
  minCrossingsPerHour: number;
  /** The earlier of the two looks must be no older than this. */
  maxAgeMinutes: number;
  /** The two looks must be at least this far apart (a real second observation). */
  minSpacingMinutes: number;
  /** Forget a contract that has not been looked at for this long. */
  ttlMinutes: number;
}

/** What the ledger remembers about one contract. */
export interface ScanCandidateMemory {
  instId: string;
  /** First time the scanner ever looked at this contract. */
  firstSeenAt: number;
  /** The most recent look, qualifying or not. */
  lastSeenAt: number;
  /** When the most recent QUALIFYING look happened (0 = never). */
  lastQualifiedAt: number;
  /**
   * When the qualifying look BEFORE that happened (0 = none yet).
   *
   * Only set when that earlier qualification came from the IMMEDIATELY
   * preceding look: a miss in between clears it, so a stale qualification can
   * never be resurrected as the partner of a fresh one.
   */
  previousQualifiedAt: number;
  /** Looks in total / looks that qualified. */
  observations: number;
  qualifications: number;
  /**
   * Index (1-based, into `observations`) of the look that last qualified.
   * Bookkeeping only: it is what makes "the previous look also qualified"
   * decidable after a miss. Not persisted, not shown.
   */
  lastQualifiedObservation: number;
  /** Snapshot of the last look, for the operator-facing reason strings. */
  lastRank: number;
  lastCrossingsPerHour: number;
  lastNetPerGridPct: number;
  /** Whether the most recent look was eligible at all, and why not. */
  lastEligible: boolean;
  lastRejectionReason: string;
  /** True when this contract currently carries a usable confirmation. */
  confirmed: boolean;
}

export type ScanConfirmationLedger = Record<string, ScanCandidateMemory>;

export interface ScanConfirmationResult {
  /** The ledger to keep for the next scan (input is never mutated). */
  ledger: ScanConfirmationLedger;
  /** instIds seen in this scan that are now confirmed and may be opened. */
  confirmed: string[];
  /** instIds seen in this scan that are not confirmed yet, with the reason. */
  pending: Array<{ instId: string; reason: string }>;
  /** Entries dropped because they were not looked at for longer than the TTL. */
  forgotten: number;
}

// ---------------------------------------------------------------------------
// Defaults — what the agent uses unless the operator says otherwise
// ---------------------------------------------------------------------------

/**
 * Top 10 of a 25-contract deep scan. Wide enough that a genuinely good regime
 * is not lost to one stronger neighbour, narrow enough that "rank 18 of 25" is
 * not a confirmation of anything.
 */
export const SCAN_CONFIRMATION_DEFAULT_TOP_N = 10;
/** 3 hours: covers a ~2-cycle cadence at 20 min with room for a missed cycle. */
export const SCAN_CONFIRMATION_DEFAULT_MAX_AGE_MINUTES = 180;
/** Two looks 5 minutes apart are one look, triggered twice. */
export const SCAN_CONFIRMATION_DEFAULT_MIN_SPACING_MINUTES = 5;
/** 12 hours with no look at all and the memory is worthless. */
export const SCAN_CONFIRMATION_DEFAULT_TTL_MINUTES = 720;

export function resolveConfirmationConfig(input: {
  topN?: number;
  minNetPerGridPct?: number;
  minCrossingsPerHour?: number;
  maxAgeMinutes?: number;
  minSpacingMinutes?: number;
  ttlMinutes?: number;
}): ScanConfirmationConfig {
  const num = (v: number | undefined, fallback: number, min: number, max: number): number => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(max, Math.max(min, n));
  };
  const ttl = num(
    input.ttlMinutes,
    SCAN_CONFIRMATION_DEFAULT_TTL_MINUTES,
    15,
    7 * 24 * 60
  );
  const maxAge = Math.min(
    ttl,
    num(input.maxAgeMinutes, SCAN_CONFIRMATION_DEFAULT_MAX_AGE_MINUTES, 1, 7 * 24 * 60)
  );
  return {
    topN: Math.round(num(input.topN, SCAN_CONFIRMATION_DEFAULT_TOP_N, 1, 200)),
    minNetPerGridPct: Math.max(0, Number(input.minNetPerGridPct) || 0),
    minCrossingsPerHour: Math.max(0, Number(input.minCrossingsPerHour) || 0),
    maxAgeMinutes: maxAge,
    minSpacingMinutes: Math.min(
      maxAge,
      num(input.minSpacingMinutes, SCAN_CONFIRMATION_DEFAULT_MIN_SPACING_MINUTES, 0, 24 * 60)
    ),
    ttlMinutes: ttl,
  };
}

// ---------------------------------------------------------------------------
// Qualification
// ---------------------------------------------------------------------------

/**
 * Did this look pass every gate the open itself will have to pass again?
 *
 * The two thresholds are the SAME ones `validateActions` enforces
 * (`minCrossingsPerHour`, `minNetProfitPerGridPct`): a look cannot qualify on a
 * rule the open would then refuse, otherwise a contract could be "confirmed"
 * by a scan and rejected every time it is proposed.
 */
export function isQualifyingRow(
  row: NativeGridOpportunity,
  cfg: ScanConfirmationConfig
): boolean {
  if (!row || !row.instId) return false;
  if (!row.isEligible) return false;
  const rank = Number(row.rank) || 0;
  if (rank <= 0 || rank > cfg.topN) return false;
  if ((Number(row.crossingsPerHour) || 0) < cfg.minCrossingsPerHour) return false;
  if ((Number(row.estimatedNetProfitPerGridPct) || 0) < cfg.minNetPerGridPct) return false;
  return true;
}

/** The reason a seen-but-unconfirmed candidate cannot be opened yet. */
export function explainNotConfirmed(
  memory: ScanCandidateMemory,
  cfg: ScanConfirmationConfig,
  now: number
): string {
  if (!memory.lastEligible) {
    return `respins la scan: ${memory.lastRejectionReason || 'neeligibil'}`;
  }
  if (memory.lastRank <= 0) {
    return 'scanul nu i-a atribuit niciun rang, deci nu poate fi confirmat';
  }
  if (memory.lastRank > cfg.topN) {
    return `rang #${memory.lastRank} în afara top ${cfg.topN} al scanului`;
  }
  if (memory.qualifications === 0) {
    return `nu a trecut porțile scanului (crossings/h ${memory.lastCrossingsPerHour}, net/grilă ${memory.lastNetPerGridPct}%)`;
  }
  if (memory.previousQualifiedAt <= 0) {
    return 'o singură calificare — confirmarea cere încă un scan care să califice';
  }
  const gapMin = (now - memory.previousQualifiedAt) / 60_000;
  if (gapMin > cfg.maxAgeMinutes) {
    return `calificarea anterioară are ${Math.round(gapMin)} min, peste limita de ${Math.round(cfg.maxAgeMinutes)} min`;
  }
  if (gapMin < cfg.minSpacingMinutes) {
    return `cele două scanuri sunt la ${Math.round(gapMin * 10) / 10} min, sub distanța minimă de ${cfg.minSpacingMinutes} min`;
  }
  return 'neconfirmat';
}

// ---------------------------------------------------------------------------
// The ledger update — one call per completed scan
// ---------------------------------------------------------------------------

/**
 * Fold one completed scan into the ledger.
 *
 * Pure: `ledger` is never mutated, the returned ledger is a new object. Safe to
 * call with an empty scan (no rows) — that only prunes.
 */
export function applyScanToLedger(
  ledger: ScanConfirmationLedger | undefined,
  rows: NativeGridOpportunity[] | undefined,
  cfg: ScanConfirmationConfig,
  now: number
): ScanConfirmationResult {
  const maxAgeMs = cfg.maxAgeMinutes * 60_000;
  const minSpacingMs = cfg.minSpacingMinutes * 60_000;
  const ttlMs = cfg.ttlMinutes * 60_000;

  // Copy the entries: the caller's ledger may be in use by a concurrent read.
  const next: ScanConfirmationLedger = {};
  for (const [id, entry] of Object.entries(ledger || {})) {
    if (!entry || !entry.instId) continue;
    next[id] = { ...entry };
  }

  const confirmed: string[] = [];
  const pending: Array<{ instId: string; reason: string }> = [];
  const seenThisScan = new Set<string>();

  for (const row of rows || []) {
    if (!row || !row.instId) continue;
    const instId = row.instId;
    seenThisScan.add(instId);

    const memory: ScanCandidateMemory =
      next[instId] ||
      ({
        instId,
        firstSeenAt: now,
        lastSeenAt: now,
        lastQualifiedAt: 0,
        previousQualifiedAt: 0,
        observations: 0,
        qualifications: 0,
        lastQualifiedObservation: 0,
        lastRank: 0,
        lastCrossingsPerHour: 0,
        lastNetPerGridPct: 0,
        lastEligible: false,
        lastRejectionReason: '',
        confirmed: false,
      } as ScanCandidateMemory);

    const rank = Number(row.rank) || 0;
    const crossings = Number(row.crossingsPerHour) || 0;
    const netPerGrid = Number(row.estimatedNetProfitPerGridPct) || 0;
    const qualifies = isQualifyingRow(row, cfg);

    memory.lastSeenAt = now;
    memory.lastRank = rank;
    memory.lastCrossingsPerHour = crossings;
    memory.lastNetPerGridPct = netPerGrid;
    memory.lastEligible = Boolean(row.isEligible);
    memory.lastRejectionReason = String(row.rejectionReason || '');

    // Did the look immediately before this one qualify? Decided BEFORE the
    // counters move, because that is the only moment both indices are comparable.
    const previousLookQualified = memory.lastQualifiedObservation === memory.observations;

    memory.observations += 1;
    if (qualifies) {
      // Pair only with a qualification that came from the previous look. After a
      // miss, `previousLookQualified` is false and the chain starts over here.
      memory.previousQualifiedAt = previousLookQualified ? memory.lastQualifiedAt : 0;
      memory.lastQualifiedAt = now;
      memory.lastQualifiedObservation = memory.observations;
      memory.qualifications += 1;
    } else {
      // A miss breaks the chain: the confirmation must describe the CURRENT
      // regime, so a contract that fell out of the top N starts over.
      memory.previousQualifiedAt = 0;
    }

    const gapMs = memory.previousQualifiedAt > 0 ? now - memory.previousQualifiedAt : -1;
    memory.confirmed =
      qualifies &&
      memory.previousQualifiedAt > 0 &&
      gapMs >= minSpacingMs &&
      gapMs <= maxAgeMs;

    next[instId] = memory;
    if (memory.confirmed) confirmed.push(instId);
    else pending.push({ instId, reason: explainNotConfirmed(memory, cfg, now) });
  }

  // Forget contracts nobody has looked at for a while (universe membership moves).
  let forgotten = 0;
  for (const [id, entry] of Object.entries(next)) {
    if (now - entry.lastSeenAt > ttlMs) {
      delete next[id];
      forgotten += 1;
    }
  }

  return { ledger: next, confirmed, pending, forgotten };
}

/** Read-only view of one contract's memory (for the audit log / UI). */
export function confirmationOf(
  ledger: ScanConfirmationLedger | undefined,
  instId: string
): ScanCandidateMemory | undefined {
  const entry = (ledger || {})[instId];
  return entry ? { ...entry } : undefined;
}
