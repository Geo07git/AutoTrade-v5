/**
 * Venue-side protective stops for AUTO-LIMIT grid bots
 * ====================================================
 * The problem this exists to solve: an AUTO-LIMIT grid bot is a set of plain limit orders plus a
 * local supervisor. Every stop it has — SL, TP, breakout, giveback — is enforced by the Node
 * process. If that process dies (crash, machine reboot, a deploy that fails to come back), the
 * position sits on OKX with twenty resting limit orders and no exit at all.
 *
 * A `_UM_XPERP` instrument cannot use OKX's native grid algo (`/tradingBot/grid/order-algo` answers
 * 51000), which is exactly why the bot runs on the AUTO-LIMIT path — so the native grid's built-in
 * TP/SL is not available either. What IS available is a plain conditional algo order on
 * `/api/v5/trade/order-algo`, which lives at the venue and fires whether or not this process is
 * alive.
 *
 * ---------------------------------------------------------------------------------------------
 * THE THREE PROPERTIES THAT MAKE THIS SAFE TO PLACE
 * ---------------------------------------------------------------------------------------------
 * 1. `reduceOnly: true`. A stop order can therefore only ever DECREASE a position. If the side is
 *    wrong, if the position is flat, if the position already flipped — the worst outcome is a
 *    rejection, never an accidental new exposure. This module cannot open a position; that is a
 *    property of the request body, not of the caller being careful.
 *
 * 2. `closeFraction: '1'`. No size is computed here, so there is no size to be wrong. The order
 *    closes whatever is open at trigger time. A neutral grid's inventory changes continuously, so
 *    any `sz` we snapshotted would be stale within seconds.
 *
 * 3. `slOrdPx: '-1'` (market on trigger). A stop that rests as a limit at the trigger price does
 *    not fill in the exact conditions it exists for. The point is to be out, not to be filled well.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY TWO LEGS, AND WHY THE SIDES ARE WHAT THEY ARE
 * ---------------------------------------------------------------------------------------------
 * A neutral grid does not hold a fixed direction — it accumulates one SIDED position as price walks:
 *
 *   price walks DOWN out of the band -> the buys filled, the book is LONG -> close by SELLING
 *   price walks UP   out of the band -> the sells filled, the book is SHORT -> close by BUYING
 *
 * So the lower stop is a `sell` and the upper stop is a `buy`. This is not symmetric-looking, and
 * that is correct: it is the opposite of the price move that created the exposure each one guards.
 * Both legs can rest simultaneously because only one of the two prices can be reached.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO
 * ---------------------------------------------------------------------------------------------
 * It does not decide *where* the stops go — `gridStopTargets.ts` owns the geometry. It does not
 * cancel stops when a bot stops either; that is a lifecycle concern and it lives next to
 * `stopGridBot`. A stale conditional stop is the real hazard here: left behind, it would close a
 * FUTURE position at an old price. `cancelConditionalStops` exists for precisely that and the
 * lifecycle caller must invoke it.
 *
 * No clock, no randomness, no I/O in `planVenueStops` — the transport functions are the only part
 * that talks to the venue, and they never throw.
 */

// ---------------------------------------------------------------------------------------------
// Planning (pure)
// ---------------------------------------------------------------------------------------------

export interface VenueStopLeg {
  /** The order side. Always the side that REDUCES the exposure this trigger implies. */
  side: 'buy' | 'sell';
  /** Position side for hedge-mode accounts; 'net' for one-way. */
  posSide: 'long' | 'short' | 'net';
  triggerPx: number;
  /** Why this leg exists, for the journal. */
  reason: string;
}

export interface VenueStopPlan {
  ok: boolean;
  legs: VenueStopLeg[];
  rationale: string;
}

export interface VenueStopPlanInput {
  lowerStopPrice: number;
  upperStopPrice: number;
  /** OKX account position mode. 'net' collapses both legs onto the one-way book. */
  posMode?: 'net' | 'long_short';
}

/**
 * Builds the two protective legs. Total: always returns a plan; `ok:false` means the prices do not
 * describe a band and the caller must place NOTHING (a mis-triggered stop is worse than no stop).
 */
export function planVenueStops(input: VenueStopPlanInput): VenueStopPlan {
  const lower = Number(input.lowerStopPrice);
  const upper = Number(input.upperStopPrice);
  const posMode = input.posMode === 'long_short' ? 'long_short' : 'net';

  if (!Number.isFinite(lower) || !Number.isFinite(upper) || !(lower > 0) || !(upper > lower)) {
    return {
      ok: false,
      legs: [],
      rationale:
        'Pragurile de stop nu descriu o banda (lower > 0 si upper > lower) - nu se plaseaza nimic.',
    };
  }

  const legs: VenueStopLeg[] = [
    {
      // Price fell out of the band: the ladder bought all the way down, so the book is long.
      side: 'sell',
      posSide: posMode === 'long_short' ? 'long' : 'net',
      triggerPx: lower,
      reason: 'Ieșire pe dedesubt: scara a cumpărat în jos, poziția e LONG — se închide prin SELL.',
    },
    {
      // Price rose out of the band: the ladder sold all the way up, so the book is short.
      side: 'buy',
      posSide: posMode === 'long_short' ? 'short' : 'net',
      triggerPx: upper,
      reason: 'Ieșire pe deasupra: scara a vândut în sus, poziția e SHORT — se închide prin BUY.',
    },
  ];

  return {
    ok: true,
    legs,
    rationale:
      `Două stopuri reduce-only: SELL @ ${lower} (închide long-ul de sub banda) și BUY @ ${upper} ` +
      `(închide short-ul de peste bandă). Se pot odihni simultan - doar unul dintre prețuri poate fi atins. ` +
      `Ambele sunt closeFraction=1, deci nu depind de un inventar care se schimbă în fiecare secundă.`,
  };
}

// ---------------------------------------------------------------------------------------------
// Transport (the only part that talks to the venue)
// ---------------------------------------------------------------------------------------------

/** The narrow slice of the adapter this module needs. Keeps it testable without an exchange. */
export interface ConditionalStopTransport {
  requestPrivate(method: string, path: string, body?: any, signal?: AbortSignal): Promise<any>;
}

export interface PlaceConditionalStopInput {
  /** OKX instId, e.g. HYPE-USD_UM_XPERP-swap. */
  symbol: string;
  side: 'buy' | 'sell';
  triggerPx: number;
  posSide?: 'long' | 'short' | 'net';
  marginMode?: 'cross' | 'isolated';
}

export interface PlaceConditionalStopResult {
  ok: boolean;
  algoId?: string;
  /** Present whenever ok is false. Caller must keep its internal stop and surface this. */
  error?: string;
}

/**
 * Places one reduce-only conditional stop. Never throws: a failed stop must degrade to "the
 * internal stop is still the only protection", not to a crash in the supervisor.
 */
export async function placeConditionalStop(
  transport: ConditionalStopTransport,
  input: PlaceConditionalStopInput
): Promise<PlaceConditionalStopResult> {
  const instId = String(input.symbol || '');
  const triggerPx = Number(input.triggerPx);

  if (!instId) return { ok: false, error: 'instId lipsă' };
  if (!Number.isFinite(triggerPx) || triggerPx <= 0) {
    return { ok: false, error: `triggerPx invalid: ${input.triggerPx}` };
  }
  if (input.side !== 'buy' && input.side !== 'sell') {
    return { ok: false, error: `side invalid: ${input.side}` };
  }

  const body: Record<string, any> = {
    instId,
    tdMode: input.marginMode || 'cross',
    side: input.side,
    ordType: 'conditional',
    // The trigger, and "market once triggered". A limit at the trigger is how stops fail to fill.
    slTriggerPx: String(triggerPx),
    slOrdPx: '-1',
    // Properties 1 and 2 from the header: cannot open, cannot be sized wrong.
    reduceOnly: true,
    closeFraction: '1',
  };
  if (input.posSide && input.posSide !== 'net') {
    body.posSide = input.posSide;
  }

  try {
    const res = await transport.requestPrivate('POST', '/api/v5/trade/order-algo', body);
    if (res?.code !== '0') {
      return { ok: false, error: `OKX code ${res?.code}: ${res?.msg || 'necunoscut'}` };
    }
    const item = res?.data?.[0];
    if (!item) return { ok: false, error: 'OKX a răspuns fără date' };
    if (item.sCode && item.sCode !== '0') {
      return { ok: false, error: `OKX sCode ${item.sCode}: ${item.sMsg || 'execuție eșuată'}` };
    }
    if (!item.algoId) return { ok: false, error: 'OKX nu a returnat algoId' };
    return { ok: true, algoId: String(item.algoId) };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'Eroare de rețea la plasarea stopului' };
  }
}

/** Lists resting conditional algo orders for one instrument. Never throws. */
export async function listConditionalStops(
  transport: ConditionalStopTransport,
  symbol: string
): Promise<{ ok: boolean; algoIds: string[]; error?: string }> {
  try {
    const res = await transport.requestPrivate(
      'GET',
      `/api/v5/trade/orders-algo-pending?ordType=conditional&instId=${encodeURIComponent(symbol)}`
    );
    if (res?.code !== '0') {
      return { ok: false, algoIds: [], error: `OKX code ${res?.code}: ${res?.msg || 'necunoscut'}` };
    }
    const rows: any[] = Array.isArray(res?.data) ? res.data : [];
    return { ok: true, algoIds: rows.map((r) => String(r.algoId)).filter(Boolean) };
  } catch (err: any) {
    return { ok: false, algoIds: [], error: err?.message || 'Eroare de rețea la listare' };
  }
}

/**
 * Cancels conditional stops for an instrument.
 *
 * This is the one function that MUST be called when a bot stops. A conditional stop left resting
 * after its bot is gone will fire against whatever position exists later, at a price decided by a
 * bot that no longer exists — closing a fresh bot at a stale level. Never throws; reports what it
 * actually cancelled so a failure is visible instead of assumed away.
 */
export async function cancelConditionalStops(
  transport: ConditionalStopTransport,
  symbol: string,
  algoIds?: string[]
): Promise<{ cancelled: string[]; failed: string[]; error?: string }> {
  const listed = algoIds && algoIds.length > 0 ? { ok: true, algoIds, error: undefined } : await listConditionalStops(transport, symbol);
  if (!listed.ok) {
    return { cancelled: [], failed: [], error: listed.error };
  }
  if (listed.algoIds.length === 0) {
    return { cancelled: [], failed: [] };
  }

  try {
    const res = await transport.requestPrivate(
      'POST',
      '/api/v5/trade/cancel-algos',
      listed.algoIds.map((algoId) => ({ instId: symbol, algoId }))
    );
    const rows: any[] = Array.isArray(res?.data) ? res.data : [];
    const cancelled = rows.filter((r) => !r.sCode || r.sCode === '0').map((r) => String(r.algoId));
    const failed = rows.filter((r) => r.sCode && r.sCode !== '0').map((r) => String(r.algoId));
    if (res?.code !== '0' && cancelled.length === 0) {
      return { cancelled, failed: listed.algoIds, error: `OKX code ${res?.code}: ${res?.msg || 'necunoscut'}` };
    }
    return { cancelled, failed };
  } catch (err: any) {
    return { cancelled: [], failed: listed.algoIds, error: err?.message || 'Eroare de rețea la anulare' };
  }
}
