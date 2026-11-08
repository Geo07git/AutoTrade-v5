/**
 * GRID BUDGET ALLOCATOR — deterministic, integer cents
 * =============================================================================
 * Answers one question, once per cycle: given the free balance, the reserve, the desk
 * ceiling and the margin already locked by open bots, WHICH candidates may be opened right
 * now and with exactly how much margin?
 *
 * Before this module the answer was computed ad hoc in three places (agent config, the
 * autopilot and the create path), each with slightly different arithmetic — which is how a
 * desk ends up 3 cents over its own ceiling or with a bot sized below its live minimum.
 *
 * Guarantees (all asserted in `__tests__/gridBudgetAllocator.test.ts`):
 *   1. `sum(approved) + committed <= min(freeBalance - reserve, totalCap)` — never breached,
 *      not even by the 5 USDC floor.
 *   2. A candidate whose live minimum exceeds the per-bot cap is SKIPPED with a code. It is
 *      never shrunk below its minimum and never raised past the cap.
 *   3. Deterministic: score desc, `instId` asc. Same input, same allocation, always.
 *   4. No zero-cent approvals, no negative margins, no silently dropped candidates: every
 *      input candidate ends up either approved or skipped-with-reason.
 *
 * Sizing itself is NOT re-implemented here: it is delegated to `resolveNativeGridSize()`.
 */

import { resolveNativeGridSize, usdToCents } from './nativeGridSizing';

export type GridBudgetSkipCode =
  | 'CANDIDATE_INVALID'
  | 'MIN_PROBE_FAILED'
  | 'BUDGET_CAP_EXCEEDED'
  | 'DESK_CAP_EXCEEDED'
  | 'MAX_BOTS_REACHED';

export interface BudgetCandidate {
  instId: string;
  /** Live OKX minimum for this exact geometry, in cents. 0 = probe unavailable. */
  minInvCents: number;
  /** Ranking score from the scan (crossings/hour, net edge, …). Higher is better. */
  score: number;
}

export interface BudgetAllocationInput {
  /** Total equity available for margin, in cents. */
  freeBalanceCents: number;
  /** Must stay untouched, in cents. */
  reserveCents: number;
  /** Desk-wide margin ceiling, in cents. */
  totalCapCents: number;
  /** Ceiling for a single bot, in cents. */
  perBotCapCents: number;
  /** Margin already locked by OPEN bots, in cents. */
  committedCents: number;
  candidates: BudgetCandidate[];
  /** How many bots may be running at once. */
  maxBots: number;
  /** Bots already open (counts against `maxBots`). */
  openBots?: number;
}

export interface BudgetAllocationResult {
  approved: Array<{ instId: string; szCents: number }>;
  skipped: Array<{ instId: string; code: GridBudgetSkipCode; detail: string }>;
  /** Desk capacity still unused after this allocation, in cents. */
  remainingCents: number;
  /** The hard ceiling this allocation was computed against, in cents. */
  usableCents: number;
}

const centsToUsd = (cents: number): number => cents / 100;

/** Total margin this desk may hold right now, before any new bot. */
export function usableDeskCents(input: {
  freeBalanceCents: number;
  reserveCents: number;
  totalCapCents: number;
  committedCents: number;
}): number {
  const balance = Math.max(0, Math.round(Number(input.freeBalanceCents) || 0));
  const reserve = Math.max(0, Math.round(Number(input.reserveCents) || 0));
  const cap = Math.max(0, Math.round(Number(input.totalCapCents) || 0));
  const committed = Math.max(0, Math.round(Number(input.committedCents) || 0));
  const spendable = Math.max(0, balance - reserve);
  const deskLimit = Math.min(spendable, cap);
  return Math.max(0, deskLimit - committed);
}

export function allocateGridBudget(input: BudgetAllocationInput): BudgetAllocationResult {
  const perBotCapCents = Math.max(0, Math.round(Number(input.perBotCapCents) || 0));
  const maxBots = Math.max(0, Math.round(Number(input.maxBots) || 0));
  const openBots = Math.max(0, Math.round(Number(input.openBots) || 0));

  const usable = usableDeskCents(input);
  let remaining = usable;

  const approved: BudgetAllocationResult['approved'] = [];
  const skipped: BudgetAllocationResult['skipped'] = [];

  // Deterministic order: best score first, `instId` ascending as the tie-break. A cycle that
  // sees the same candidates twice must not allocate two different desks.
  const ordered = [...(input.candidates || [])].sort((a, b) => {
    const sa = Number(a?.score) || 0;
    const sb = Number(b?.score) || 0;
    if (sb !== sa) return sb - sa;
    return String(a?.instId).localeCompare(String(b?.instId));
  });

  for (const candidate of ordered) {
    const instId = String(candidate?.instId || '');
    if (!instId) {
      skipped.push({ instId: '(missing)', code: 'CANDIDATE_INVALID', detail: 'Candidate without instId' });
      continue;
    }

    const minInvCents = Math.max(0, Math.round(Number(candidate?.minInvCents) || 0));
    if (minInvCents <= 0) {
      // An unknown minimum is not a free pass: committing margin without the live floor is
      // how a create call fails after the budget was already reserved.
      skipped.push({
        instId,
        code: 'MIN_PROBE_FAILED',
        detail: 'Live min-investment probe unavailable — cannot commit margin blindly',
      });
      continue;
    }

    if (approved.length + openBots >= maxBots) {
      skipped.push({
        instId,
        code: 'MAX_BOTS_REACHED',
        detail: `${approved.length + openBots} bots already at the ${maxBots} limit`,
      });
      continue;
    }

    if (minInvCents > perBotCapCents) {
      skipped.push({
        instId,
        code: 'BUDGET_CAP_EXCEEDED',
        detail: `min ${centsToUsd(minInvCents)} USDT above the ${centsToUsd(perBotCapCents)} USDT per-bot cap`,
      });
      continue;
    }

    if (minInvCents > remaining) {
      skipped.push({
        instId,
        code: 'DESK_CAP_EXCEEDED',
        detail: `min ${centsToUsd(minInvCents)} USDT above the ${centsToUsd(remaining)} USDT desk remainder`,
      });
      continue;
    }

    // The size is exactly the minimum, plus the sizer's 1 cent of headroom, capped by the
    // per-bot ceiling and by what is left. Asking for more would spend a budget nobody asked
    // to spend; asking for less would sit below the OKX floor.
    const ceilingCents = Math.min(perBotCapCents, remaining);
    const size = resolveNativeGridSize({
      requestedUSDT: centsToUsd(minInvCents),
      minInvestmentUSDT: centsToUsd(minInvCents),
      maxBudgetUSDT: centsToUsd(ceilingCents),
    });

    if (size.belowMinimum) {
      skipped.push({
        instId,
        code: 'DESK_CAP_EXCEEDED',
        detail: `min ${centsToUsd(size.minInvCents)} USDT cannot be met by ${centsToUsd(ceilingCents)} USDT`,
      });
      continue;
    }
    if (size.szCents <= 0) {
      skipped.push({ instId, code: 'CANDIDATE_INVALID', detail: 'resolved size is 0 cents' });
      continue;
    }
    if (size.szCents > perBotCapCents) {
      // The 5 USDC venue floor can exceed a per-bot cap the owner configured lower (2 USDT).
      // Sending 5 USDT anyway would silently multiply the configured ceiling by 2.5x.
      skipped.push({
        instId,
        code: 'BUDGET_CAP_EXCEEDED',
        detail: `venue floor ${centsToUsd(size.szCents)} USDT above the ${centsToUsd(perBotCapCents)} USDT per-bot cap`,
      });
      continue;
    }
    if (size.szCents > remaining) {
      skipped.push({
        instId,
        code: 'DESK_CAP_EXCEEDED',
        detail: `size ${centsToUsd(size.szCents)} USDT above the ${centsToUsd(remaining)} USDT remainder`,
      });
      continue;
    }

    approved.push({ instId, szCents: size.szCents });
    remaining -= size.szCents;
  }

  return { approved, skipped, remainingCents: remaining, usableCents: usable };
}

/** Convenience wrapper for callers that hold USD instead of cents. */
export function allocateGridBudgetUsd(
  input: Omit<
    BudgetAllocationInput,
    'freeBalanceCents' | 'reserveCents' | 'totalCapCents' | 'perBotCapCents' | 'committedCents'
  > & {
    freeBalanceUSDT: number;
    reserveUSDT: number;
    totalCapUSDT: number;
    perBotCapUSDT: number;
    committedUSDT: number;
  }
): BudgetAllocationResult {
  return allocateGridBudget({
    freeBalanceCents: usdToCents(input.freeBalanceUSDT),
    reserveCents: usdToCents(input.reserveUSDT),
    totalCapCents: usdToCents(input.totalCapUSDT),
    perBotCapCents: usdToCents(input.perBotCapUSDT),
    committedCents: usdToCents(input.committedUSDT),
    candidates: input.candidates,
    maxBots: input.maxBots,
    openBots: input.openBots,
  });
}
