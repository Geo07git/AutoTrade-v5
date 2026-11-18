/**
 * Tests for the auto-arming policy. The properties that matter are the ones whose failure
 * is silent: arming twice (stacked stops), arming on an unreadable venue (blind placement),
 * and arming a bot that is not running (a stop on a dead position that a future bot inherits).
 */
import {
  decideVenueStopArming,
  isAutoArmingEnabled,
} from '../gridVenueStopArming';
import { planVenueStops } from '../../../exchange/okxConditionalStop';
import { computeGridStopTargets } from '../gridStopTargets';

let pass = 0;
let fail = 0;
function ok(cond: boolean, name: string) {
  if (cond) {
    pass++;
    console.log(`  ok    ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}`);
  }
}
function eq(a: any, b: any, name: string) {
  ok(a === b, `${name} (${JSON.stringify(a)} === ${JSON.stringify(b)})`);
}

const base = {
  status: 'RUNNING',
  lowerPrice: 0.1084,
  upperPrice: 0.1158,
  restingAlgoIds: [] as string[],
  lookupOk: true,
};

console.log('\nvenuel stop arming\n');

// --- the three states -------------------------------------------------------------------------
eq(decideVenueStopArming(base).action, 'ARM', 'running, valid band, nothing resting -> ARM');
eq(
  decideVenueStopArming({ ...base, restingAlgoIds: ['a1'] }).action,
  'KEEP',
  'a resting stop -> KEEP'
);
eq(
  decideVenueStopArming({ ...base, restingAlgoIds: ['a1', 'a2'] }).action,
  'KEEP',
  'two resting stops (a full pair) -> KEEP, never a third'
);

// --- idempotency: the failure that stacks orders -----------------------------------------------
const first = decideVenueStopArming(base).action;
const second = decideVenueStopArming({ ...base, restingAlgoIds: ['a1', 'a2'] }).action;
eq(first, 'ARM', 'cycle 1 arms');
eq(second, 'KEEP', 'cycle 2 keeps: a second cycle never places again');

// --- a non-running bot is never armed -----------------------------------------------------------
for (const st of ['STOPPED', 'stopping', 'stopped', '']) {
  eq(decideVenueStopArming({ ...base, status: st }).action, 'SKIP', `status "${st}" -> SKIP`);
}

// --- an unreadable venue degrades to SKIP, never to ARM -----------------------------------------
eq(decideVenueStopArming({ ...base, lookupOk: false }).action, 'SKIP',
  'lookup failure -> SKIP, not ARM (blind placement is the hazard)');
eq(
  decideVenueStopArming({ ...base, lookupOk: false, restingAlgoIds: ['a1'] }).action,
  'SKIP',
  'lookup failure wins even when stale ids are present'
);

// --- a band that is not a band -------------------------------------------------------------------
for (const [lo, hi, why] of [
  [0, 0.1158, 'lower is zero'],
  [0.1158, 0.1084, 'inverted'],
  [NaN, 0.1158, 'NaN lower'],
  [-1, 0.1158, 'negative'],
] as Array<[number, number, string]>) {
  eq(
    decideVenueStopArming({ ...base, lowerPrice: lo, upperPrice: hi }).action,
    'SKIP',
    `band rejected: ${why}`
  );
}

// --- the flag ------------------------------------------------------------------------------------
eq(isAutoArmingEnabled({}), false, 'unset -> off');
eq(isAutoArmingEnabled({ GRID_VENUE_STOPS: '1' }), false, 'the old "1" spelling does NOT enable it');
eq(isAutoArmingEnabled({ GRID_VENUE_STOPS: 'auto' }), true, '"auto" enables it');
eq(isAutoArmingEnabled({ GRID_VENUE_STOPS: 'AUTO' }), false, 'case-sensitive on purpose');

// --- ENA, end to end: the arming decision must reach the real geometry --------------------------
// Live row: band 0.1084 - 0.1158, 2x, SL -8% ($0.1032). Decision B places just past the edges.
const ena = computeGridStopTargets({ lowerPrice: 0.1084, upperPrice: 0.1158, leverage: 2 });
ok(ena.ok, 'ENA geometry computes');
// The arming path must feed `planVenueStops` the BAND EDGES that actually exist.
// `takeProfitPrice` is `null` by design (a capture target has no price); reading it as the upper
// stop fed `Number(null) === 0` into the plan, which then refused the pair with
// "lower > 0 and upper > lower" - the bug this test exists to keep dead.
eq(ena.takeProfitPrice, null, 'takeProfitPrice is null by design');
ok(Number.isFinite(ena.stopUpperPrice) && ena.stopUpperPrice > 0,
  'stopUpperPrice is a real price, not the null take-profit');
ok(ena.stopUpperPrice > ena.stopLossPrice, 'the upper stop sits above the lower one');
const enaPlan = planVenueStops({ lowerStopPrice: ena.stopLossPrice, upperStopPrice: ena.stopUpperPrice });
ok(enaPlan.ok, 'ENA plan is placeable');
eq(enaPlan.legs.length, 2, 'ENA gets exactly two legs');
eq(enaPlan.legs[0].side, 'sell', 'lower leg sells (the ladder bought, book is long)');
eq(enaPlan.legs[0].triggerPx.toFixed(6), '0.107858', 'lower trigger is 0.107858');
eq(enaPlan.legs[1].side, 'buy', 'upper leg buys (the ladder sold, book is short)');
eq(enaPlan.legs[1].triggerPx.toFixed(6), '0.116379', 'upper trigger is 0.116379');

// The arming pass must not act on ENA while its config still carries no usable band.
eq(
  decideVenueStopArming({ ...base, lowerPrice: 0, upperPrice: 0 }).action,
  'SKIP',
  'ENA with no band in config is skipped, not placed at 0'
);

console.log(`\n${pass}/${pass + fail} passed\n`);
if (fail > 0) process.exit(1);
