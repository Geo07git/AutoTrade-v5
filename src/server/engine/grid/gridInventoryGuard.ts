/**
 * EXIT DEFERRAL — the rule that stops a supervisor from paying for an exit it does not need yet.
 *
 * The stagnation analyzer exists so dead capital is noticed. Its original remedy was the most
 * expensive one available: a market close of whatever inventory the grid still held. On
 * `grid_pieverse_mwk05tlp` that single decision realized **-1.048 USDT** against a grid capture of
 * **+0.992 USDT**, i.e. the exit handed back the whole session's work and then some, at a price
 * (`1.8889`) still 6% above the band's lower edge and 6.6% above the stop (`1.7715`).
 *
 * The distinction this module makes is one the time-based rules cannot: a bot that has banked
 * profit and still holds inventory it can unwind through its own sells does NOT need to be closed
 * at market just because the last two hours were quiet. It needs to stop ACCUMULATING — which the
 * engine already supports (`setBuyFreezePx`, filtered in `computeTargetLiveWindow`) — and keep its
 * sells live.
 *
 * One predicate, two consumers, one actor:
 *   - `NeutralGridEngine` applies the freeze/release at tick time (it owns the real inventory and
 *     the live window), and answers `deferExitForStagnation()` for the analyzer's supervisor;
 *   - `GridBotAnalyzer` / `GridBotSupervisor` only ask "may I close?" — they never duplicate the
 *     rule and never close on their own judgement.
 *
 * Pure by construction: no clock (`minutesSinceLastFill` and `frozenForMinutes` come in already
 * computed), no I/O, no exchange. Same shape as `gridProfitGuard`, so it can be pinned by tests.
 */

/**
 * Defaults, measured rather than invented:
 * - `noFillMinutes: 45` fires well INSIDE the analyzer's 120m review, so the ladder is frozen
 *   before the review can propose a close — the deferral has to exist before it is needed.
 * - `maxFreezeMinutes: 90` is three quarters of that 120m window: capital is protected, but it can
 *   never be captured by a freeze that nobody lifts.
 * - `releaseGainPct: 0.35` is about one grid step on a +/-3.5% band with 20 levels: a move that
 *   large means the tape is working again, so the buys must re-arm on their own.
 */
export const FREEZE_DEFAULTS = {
  noFillMinutes: 45,
  maxFreezeMinutes: 90,
  releaseGainPct: 0.35,
} as const;

export type InventoryAction =
  /** Nothing to do this tick. */
  | 'NONE'
  /** Record a buy-ladder freeze from the current price: stop adding inventory, keep the sells. */
  | 'FREEZE_BUYS'
  /** Lift the freeze: the tape is working again, the ladder must re-arm. */
  | 'RELEASE_FREEZE'
  /** The caller may close at market — the guard has no objection. */
  | 'ALLOW_CLOSE';

export interface InventoryGuardInput {
  /** Current price. */
  px: number;
  /** Band edges the grid was built on (not the stops — the stops are wider than the band). */
  minPx: number;
  maxPx: number;
  /** Signed net inventory in contracts, as the engine stores it. */
  netContracts: number;
  netSide: 'LONG' | 'SHORT' | 'FLAT';
  /** Minutes since the last grid fill (buy or sell), already computed by the caller. */
  minutesSinceLastFill: number;
  /** Freeze already recorded at this price (0/undefined = not frozen). */
  frozenFromPx?: number;
  /** How long the freeze has been standing, in minutes (caller computes from `buyLadderFrozenAt`). */
  frozenForMinutes?: number;
  /** Confirmed range breakout (the 30m confirmation the analyzer already runs). */
  breakoutConfirmed?: boolean;
  /** Net realized after real costs, cumulative for the bot's life (NOT a 120m window). */
  netRealizedAfterCostsUSDT: number;
  /** Unrealized PnL on the inventory currently held (signed). */
  floatingPnlUSDT: number;
  /** Taker fee to flatten the inventory now, in USDT. Missing -> 0 (it is second-order here). */
  closeFeeEstimateUSDT?: number;
  noFillMinutes?: number;
  maxFreezeMinutes?: number;
  releaseGainPct?: number;
}

export interface InventoryGuardVerdict {
  action: InventoryAction;
  /**
   * True when a stop taken NOW would be a giveaway: inventory exists, the price is still inside
   * the band, the breakout is not confirmed, and the exit would eat the banked profit. A caller
   * that ignores this is the PIEVERSE bug.
   */
  deferExit: boolean;
  /** Is there inventory at all? No inventory -> no exit cost -> nothing to protect. */
  hasInventory: boolean;
  /** Would closing now still leave the bot net positive after the fee? */
  bankedCoversExit: boolean;
  /** The freeze outlived `maxFreezeMinutes`: the caller may close even at a giveaway price. */
  freezeExpired: boolean;
  reason: string;
}

const num = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

export function assessInventoryAction(input: InventoryGuardInput): InventoryGuardVerdict {
  const px = num(input.px);
  const minPx = num(input.minPx);
  const maxPx = num(input.maxPx);
  const contracts = Math.abs(num(input.netContracts));
  const hasInventory =
    (input.netSide === 'LONG' || input.netSide === 'SHORT') && contracts > 0;

  const realized = num(input.netRealizedAfterCostsUSDT);
  const floating = num(input.floatingPnlUSDT);
  const fee = Math.max(0, num(input.closeFeeEstimateUSDT));

  const noFillMinutes = num(input.noFillMinutes) || FREEZE_DEFAULTS.noFillMinutes;
  const maxFreezeMinutes = num(input.maxFreezeMinutes) || FREEZE_DEFAULTS.maxFreezeMinutes;
  const releaseGainPct = num(input.releaseGainPct) || FREEZE_DEFAULTS.releaseGainPct;

  // Closing converts the floating PnL into realized: the question is whether what is left is still
  // positive. `realized > 0` matters on its own — a bot whose whole life is underwater has nothing
  // banked to protect, and deferring its exit would just delay a decision that is already correct.
  const netIfClosed = realized + floating - fee;
  const bankedCoversExit = realized > 0 && netIfClosed > 0;

  const bandValid = minPx > 0 && maxPx > minPx && px > 0;
  const insideBand = bandValid && px > minPx && px < maxPx;

  const frozenFrom = num(input.frozenFromPx);
  const isFrozen = frozenFrom > 0;
  const frozenForMinutes = isFrozen ? Math.max(0, num(input.frozenForMinutes)) : 0;
  const freezeExpired = isFrozen && frozenForMinutes >= maxFreezeMinutes;

  const base = { hasInventory, bankedCoversExit, freezeExpired };

  // 1. No inventory -> the exit costs nothing and there is nothing a freeze could protect. A dead
  //    bot with a flat book may be closed on the normal rules.
  if (!hasInventory) {
    return {
      ...base,
      action: 'NONE',
      deferExit: false,
      reason: 'Fără inventar de descărcat (poziția netă e 0) — o ieșire nu are ce să coste',
    };
  }

  // 2. The price already left the band (or the breakout is confirmed): the exit is legitimate.
  //    Freezing buys outside the band would be protecting a thesis the market already invalidated.
  if (!insideBand) {
    return {
      ...base,
      action: 'ALLOW_CLOSE',
      deferExit: false,
      reason: bandValid
        ? `Preț $${px} în afara benzii [$${minPx}..$${maxPx}] — ieșirea e justificată`
        : `Bandă indisponibilă (${minPx}..${maxPx}) — nu pot stabili dacă prețul e în interior`,
    };
  }
  if (input.breakoutConfirmed) {
    return {
      ...base,
      action: 'ALLOW_CLOSE',
      deferExit: false,
      reason: `Breakout confirmat cu prețul la $${px} — ieșirea e justificată`,
    };
  }

  // 3. Freeze lifecycle. While frozen the guard is deliberately inert: it does not close (that is
  //    what the freeze bought) and it does not re-freeze at a new price every tick.
  if (isFrozen) {
    if (freezeExpired) {
      return {
        ...base,
        action: 'ALLOW_CLOSE',
        deferExit: false,
        reason: `Freeze expirat după ${maxFreezeMinutes}m fără fill și fără revenire — capitalul nu poate rămâne captiv`,
      };
    }
    const recovered = px >= frozenFrom * (1 + releaseGainPct / 100);
    const fillResumed = num(input.minutesSinceLastFill) < noFillMinutes;
    if (recovered || fillResumed) {
      return {
        ...base,
        action: 'RELEASE_FREEZE',
        deferExit: true,
        reason: fillResumed
          ? `Oscilația a revenit (ultimul fill acum ${num(input.minutesSinceLastFill).toFixed(0)}m) — scara de Buy se re-armează`
          : `Preț $${px} a revenit peste nivelul de congelare $${frozenFrom} (+${releaseGainPct}%) — scara de Buy se re-armează`,
      };
    }
    return {
      ...base,
      action: 'NONE',
      deferExit: true,
      reason: `Buy congelat de ${frozenForMinutes.toFixed(0)}m la $${frozenFrom} — Sell-urile descarcă inventarul`,
    };
  }

  // 4. Not stagnant yet: the guard has no opinion to give. It is asked "may I close?" only when a
  //    stagnation question is live, and it must not answer ALLOW_CLOSE on a working bot.
  if (num(input.minutesSinceLastFill) < noFillMinutes) {
    return {
      ...base,
      action: 'NONE',
      deferExit: false,
      reason: `Activ (ultimul fill acum ${num(input.minutesSinceLastFill).toFixed(0)}m, sub pragul de ${noFillMinutes}m)`,
    };
  }

  // 5. Closing now still banks something: there is no giveaway to prevent.
  if (bankedCoversExit) {
    return {
      ...base,
      action: 'ALLOW_CLOSE',
      deferExit: false,
      reason: `Profitul bancat acoperă ieșirea (realizat $${realized.toFixed(3)} + flotant $${floating.toFixed(3)} - fee $${fee.toFixed(3)} = $${netIfClosed.toFixed(3)})`,
    };
  }

  // 6. Nothing banked to protect. A bot that is losing on the realized side has no earned profit
  //    for an exit to hand back, so the stagnation stop keeps its original meaning: close it. Risk
  //    stops (SL / drawdown) are unaffected either way.
  if (realized <= 0) {
    return {
      ...base,
      action: 'ALLOW_CLOSE',
      deferExit: false,
      reason: `Fără profit bancat de protejat (realizat $${realized.toFixed(3)}) — stopul de stagnare își păstrează efectul`,
    };
  }

  // 7. Stagnant, holding inventory, and a close would eat the banked profit: freeze instead.
  return {
    ...base,
    action: 'FREEZE_BUYS',
    deferExit: true,
    reason:
      `${num(input.minutesSinceLastFill).toFixed(0)}m fără fill cu inventar ${contracts} contracte în bandă: ` +
      `ieșirea ar da înapoi profitul bancat (realizat $${realized.toFixed(3)} + flotant $${floating.toFixed(3)} = $${netIfClosed.toFixed(3)})`,
  };
}
