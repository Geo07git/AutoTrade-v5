/**
 * Suite for venue-side conditional stops (`okxConditionalStop.ts`).
 *
 * The invariants pinned here are the ones that make it safe to put a real order on the venue:
 *
 *   - every request is `reduceOnly` with `closeFraction=1` and no `sz`, so it can never open or
 *     increase a position and can never be sized wrong;
 *   - the side is OPPOSITE the move that created the exposure (sell under the band, buy above it);
 *   - nothing throws — a failed stop degrades to "the internal stop is still the only protection";
 *   - cancellation reports what actually happened, because a stale stop firing against a later
 *     position is the real hazard.
 *
 * Run: npm test
 */

import {
  planVenueStops,
  placeConditionalStop,
  listConditionalStops,
  cancelConditionalStops,
  ConditionalStopTransport,
} from '../okxConditionalStop';

const tests: { name: string; fn: () => void | Promise<void> }[] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push({ name, fn });

const ok = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(msg);
};
const eq = (actual: unknown, expected: unknown, msg: string): void => {
  if (actual !== expected) throw new Error(`${msg} (expected ${String(expected)}, got ${String(actual)})`);
};

/** Records every call and replays a scripted answer. */
function fakeTransport(answers: Array<any>): ConditionalStopTransport & { calls: any[] } {
  const calls: any[] = [];
  let i = 0;
  return {
    calls,
    async requestPrivate(method: string, path: string, body?: any) {
      calls.push({ method, path, body });
      const next = answers[Math.min(i, answers.length - 1)];
      i++;
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

const HYPE_LOWER = 66.466;
const HYPE_UPPER = 70.571;

// ---------------------------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------------------------

test('plan: below the band closes a LONG by selling', () => {
  const p = planVenueStops({ lowerStopPrice: HYPE_LOWER, upperStopPrice: HYPE_UPPER });
  eq(p.ok, true, 'a real band must produce a plan');
  const lower = p.legs.find((l) => l.triggerPx === HYPE_LOWER)!;
  ok(lower, 'the lower leg must exist');
  eq(lower.side, 'sell', 'price fell: the ladder is long, so it must SELL to get out');
});

test('plan: above the band closes a SHORT by buying', () => {
  const p = planVenueStops({ lowerStopPrice: HYPE_LOWER, upperStopPrice: HYPE_UPPER });
  const upper = p.legs.find((l) => l.triggerPx === HYPE_UPPER)!;
  ok(upper, 'the upper leg must exist');
  eq(upper.side, 'buy', 'price rose: the ladder is short, so it must BUY to get out');
});

test('plan: both legs can rest at once — they are different prices', () => {
  const p = planVenueStops({ lowerStopPrice: HYPE_LOWER, upperStopPrice: HYPE_UPPER });
  eq(p.legs.length, 2, 'exactly two legs');
  const prices = p.legs.map((l) => l.triggerPx);
  eq(prices[0] !== prices[1], true, 'two distinct triggers, so only one can ever be reached');
});

test('plan: hedge mode carries posSide, one-way mode collapses to net', () => {
  const hedge = planVenueStops({ lowerStopPrice: 1, upperStopPrice: 2, posMode: 'long_short' });
  eq(hedge.legs[0].posSide, 'long', 'the sell closes the long side');
  eq(hedge.legs[1].posSide, 'short', 'the buy closes the short side');

  const net = planVenueStops({ lowerStopPrice: 1, upperStopPrice: 2, posMode: 'net' });
  eq(net.legs[0].posSide, 'net', 'one-way book');
  eq(net.legs[1].posSide, 'net', 'one-way book');
});

test('plan: prices that do not describe a band produce NO legs', () => {
  const bad = [
    { lowerStopPrice: 0, upperStopPrice: 10 },
    { lowerStopPrice: 10, upperStopPrice: 10 },
    { lowerStopPrice: 11, upperStopPrice: 10 },
    { lowerStopPrice: NaN, upperStopPrice: 10 },
  ];
  for (const b of bad) {
    const p = planVenueStops(b);
    eq(p.ok, false, `${JSON.stringify(b)} must be refused`);
    eq(p.legs.length, 0, 'and must place NOTHING — a mis-triggered stop is worse than none');
    ok(p.rationale.length > 0, 'a refusal explains itself');
  }
});

// ---------------------------------------------------------------------------------------------
// Placement — the properties that make a real order safe
// ---------------------------------------------------------------------------------------------

test('place: the request can never open a position', async () => {
  const t = fakeTransport([{ code: '0', data: [{ algoId: 'A1', sCode: '0' }] }]);
  const r = await placeConditionalStop(t, { symbol: 'HYPE-USD_UM_XPERP-swap', side: 'sell', triggerPx: HYPE_LOWER });
  eq(r.ok, true, 'a clean answer is a success');

  const body = t.calls[0].body;
  eq(body.reduceOnly, true, 'reduceOnly is the property that makes a wrong side harmless');
  eq(body.closeFraction, '1', 'closes whatever is open — no stale size to be wrong');
  eq(body.sz, undefined, 'NEVER sends a size: inventory changes every second');
  eq(body.ordType, 'conditional', 'the algo order type');
  eq(body.slOrdPx, '-1', 'market on trigger — a limit resting at the trigger does not fill');
  eq(body.slTriggerPx, String(HYPE_LOWER), 'the trigger is the structural stop');
});

test('place: returns the algoId so the stop can be cancelled later', async () => {
  const t = fakeTransport([{ code: '0', data: [{ algoId: 'A42', sCode: '0' }] }]);
  const r = await placeConditionalStop(t, { symbol: 'X-swap', side: 'buy', triggerPx: 70.571 });
  eq(r.algoId, 'A42', 'without the algoId the stop could never be cleaned up');
});

test('place: an sCode rejection is a failure, not a success', async () => {
  const t = fakeTransport([{ code: '0', data: [{ sCode: '51000', sMsg: 'parameter error' }] }]);
  const r = await placeConditionalStop(t, { symbol: 'X-swap', side: 'sell', triggerPx: 66.466 });
  eq(r.ok, false, 'a per-item sCode error must not be read as success');
  ok(String(r.error).includes('51000'), 'and the code must survive into the message');
});

test('place: a network throw degrades, it does not propagate', async () => {
  const t = fakeTransport([new Error('ECONNRESET')]);
  const r = await placeConditionalStop(t, { symbol: 'X-swap', side: 'sell', triggerPx: 66.466 });
  eq(r.ok, false, 'the supervisor must not crash because a stop could not be placed');
  ok(String(r.error).includes('ECONNRESET'), 'the cause is reported');
});

test('place: bad input never reaches the venue', async () => {
  const t = fakeTransport([{ code: '0', data: [{ algoId: 'A1', sCode: '0' }] }]);
  for (const bad of [
    { symbol: '', side: 'sell' as const, triggerPx: 10 },
    { symbol: 'X-swap', side: 'sell' as const, triggerPx: 0 },
    { symbol: 'X-swap', side: 'sell' as const, triggerPx: NaN },
    { symbol: 'X-swap', side: 'hold' as any, triggerPx: 10 },
  ]) {
    const r = await placeConditionalStop(t, bad as any);
    eq(r.ok, false, `${JSON.stringify(bad)} must be refused`);
  }
  eq(t.calls.length, 0, 'nothing malformed is ever sent to the exchange');
});

test('place: hedge mode sends posSide, one-way omits it', async () => {
  const t = fakeTransport([{ code: '0', data: [{ algoId: 'A1', sCode: '0' }] }]);
  await placeConditionalStop(t, { symbol: 'X', side: 'sell', triggerPx: 1, posSide: 'long' });
  eq(t.calls[0].body.posSide, 'long', 'hedge mode needs the side');

  const t2 = fakeTransport([{ code: '0', data: [{ algoId: 'A2', sCode: '0' }] }]);
  await placeConditionalStop(t2, { symbol: 'X', side: 'sell', triggerPx: 1, posSide: 'net' });
  eq(t2.calls[0].body.posSide, undefined, 'net mode must NOT send posSide');
});

// ---------------------------------------------------------------------------------------------
// Lifecycle — the stale-stop hazard
// ---------------------------------------------------------------------------------------------

test('cancel: discovers resting stops then cancels them by algoId', async () => {
  const t = fakeTransport([
    { code: '0', data: [{ algoId: 'A1' }, { algoId: 'A2' }] },
    { code: '0', data: [{ algoId: 'A1', sCode: '0' }, { algoId: 'A2', sCode: '0' }] },
  ]);
  const r = await cancelConditionalStops(t, 'HYPE-USD_UM_XPERP-swap');
  eq(r.cancelled.length, 2, 'both stops are gone');
  eq(r.failed.length, 0, 'nothing left behind');
  eq(t.calls[1].path, '/api/v5/trade/cancel-algos', 'the cancel endpoint');
});

test('cancel: a partially failed cancel is REPORTED, not swallowed', async () => {
  const t = fakeTransport([
    { code: '0', data: [{ algoId: 'A1' }, { algoId: 'A2' }] },
    { code: '0', data: [{ algoId: 'A1', sCode: '0' }, { algoId: 'A2', sCode: '51400' }] },
  ]);
  const r = await cancelConditionalStops(t, 'X-swap');
  eq(r.cancelled.length, 1, 'the one that worked');
  eq(r.failed.length, 1, 'and the one that did NOT is surfaced, because it is still armed');
});

test('cancel: nothing resting is a clean no-op, with no cancel call', async () => {
  const t = fakeTransport([{ code: '0', data: [] }]);
  const r = await cancelConditionalStops(t, 'X-swap');
  eq(r.cancelled.length, 0, 'nothing to do');
  eq(t.calls.length, 1, 'only the listing call, no empty cancel request');
});

test('cancel: a failed listing is reported rather than assumed empty', async () => {
  const t = fakeTransport([{ code: '50011', msg: 'rate limit' }]);
  const r = await cancelConditionalStops(t, 'X-swap');
  ok(r.error, 'an unreadable list must not look like "no stale stops"');
  ok(String(r.error).includes('50011'), 'the cause survives');
});

test('cancel: an explicit algoId list skips the listing round-trip', async () => {
  const t = fakeTransport([{ code: '0', data: [{ algoId: 'A9', sCode: '0' }] }]);
  const r = await cancelConditionalStops(t, 'X-swap', ['A9']);
  eq(r.cancelled[0], 'A9', 'cancelled directly');
  eq(t.calls.length, 1, 'no listing needed when the ids are known');
  eq(t.calls[0].path, '/api/v5/trade/cancel-algos', 'straight to cancel');
});

// ---------------------------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------------------------
(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ok    ${t.name}`);
    } catch (err) {
      failed++;
      console.error(`  FAIL  ${t.name}\n        ${(err as Error).message}`);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} okx-conditional-stop tests passed`);
  if (failed > 0) process.exit(1);
})();
