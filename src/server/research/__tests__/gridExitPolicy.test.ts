/**
 * Exit-policy mechanism test for GridBacktestEngine.
 *
 * The audit (docs/audit-2026-11-14.md) shows every one of the 89 recorded live stops was a
 * market close at the band edge, and that `stopType '2'` (keep the position) has never been
 * exercised. These tests pin the MECHANISM, not a favourite outcome:
 *   - MARKET_STOP closes on a band break and pays taker;
 *   - HOLD does not close on a band break at all;
 *   - HOLD wins when the break reverts, and loses when it does not.
 *
 * The last assertion matters as much as the others: it documents that holding is a trade-off,
 * not a free lunch, so nobody can read this file as a sales pitch.
 *
 * Run: npx tsx src/server/research/__tests__/gridExitPolicy.test.ts
 */

import { GridBacktestEngine, createDefaultBotConfig } from '../GridBacktestEngine';
import type { Kline, NeutralGridBotConfig } from '../../../shared/types';

const ok = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(msg);
};

const eq = (actual: unknown, expected: unknown, msg: string): void => {
  if (actual !== expected) {
    throw new Error(`${msg} (expected ${String(expected)}, got ${String(actual)})`);
  }
};

const intervalMs = 900_000; // 15m
const baseTs = 1_700_000_000_000;

const mk = (i: number, open: number, high: number, low: number, close: number): Kline => ({
  timestamp: baseTs + i * intervalMs,
  open,
  high,
  low,
  close,
  volume: 1000,
});

/** Oscillation around `center` that stays well inside the band. */
function oscillate(count: number, center: number, amplitude: number, from = 0): Kline[] {
  const out: Kline[] = [];
  for (let i = 0; i < count; i++) {
    const mid = center + Math.sin((i / 6) * Math.PI * 2) * amplitude;
    out.push(mk(from + i, mid, mid + 0.2, mid - 0.2, mid));
  }
  return out;
}

const lotFilter = {
  symbol: 'TEST-XPERP',
  minOrderQty: 1,
  maxOrderQty: 1_000_000,
  qtyStep: 1,
  minNotionalValue: 1,
  tickSize: 0.01,
  ctVal: 0.01, // 1 USDT per contract at price 100 -> a 200 USDT notional fits 6 levels
};

const buildConfig = (): NeutralGridBotConfig =>
  createDefaultBotConfig('TEST-XPERP', 97, 103, 6, 'ARITHMETIC', 2, 100, 20, 0);

/** Inside the band, breaks out to 110 on a CLOSE, then stays out. */
function breakoutThatHolds(): Kline[] {
  const bars = oscillate(60, 100, 1);
  let i = 60;
  for (const px of [104, 106, 108, 110]) {
    bars.push(mk(i++, px - 1, px + 0.5, px - 1.5, px));
  }
  for (let n = 0; n < 30; n++) bars.push(mk(i++, 110, 110.5, 109.5, 110));
  return bars;
}

/** Inside the band, a candle CLOSES at 104 (fires the market stop), then price reverts. */
function breakoutThatReverts(): Kline[] {
  const bars = oscillate(60, 100, 1);
  bars.push(mk(60, 100.5, 104.5, 100.2, 104)); // decisive close above 103
  bars.push(...oscillate(40, 100, 1, 61));
  return bars;
}

// ---------------------------------------------------------------------------

// 1. Default behaviour is unchanged: no exitPolicy == MARKET_STOP.
{
  const cfg = buildConfig();
  const bars = breakoutThatHolds();
  const implicit = GridBacktestEngine.runSimulation(bars, cfg, [], { lotFilter });
  const explicit = GridBacktestEngine.runSimulation(bars, cfg, [], { lotFilter, exitPolicy: 'MARKET_STOP' });
  eq(implicit.netPnLUSDT, explicit.netPnLUSDT, 'default must stay bit-identical to MARKET_STOP');
  eq(explicit.rangeBreakoutExits, 1, 'MARKET_STOP must fire exactly once on a clean band break');
  eq(explicit.exitReason, 'RANGE_BREAKOUT', 'MARKET_STOP exit reason');
}

// 2. HOLD must not close on a band break at all.
{
  const cfg = buildConfig();
  const held = GridBacktestEngine.runSimulation(breakoutThatHolds(), cfg, [], { lotFilter, exitPolicy: 'HOLD' });
  eq(held.rangeBreakoutExits, 0, 'HOLD must never count a range-breakout exit');
  eq(held.exitReason, 'END_OF_DATA', 'HOLD must run to the end of the data');
  ok(!held.wasLiquidated, 'HOLD at 2x must survive a 10% move inside this tape');
}

// 3. HOLD pays no taker close, so it must be strictly cheaper in fees on the same tape.
{
  const cfg = buildConfig();
  const bars = breakoutThatHolds();
  const market = GridBacktestEngine.runSimulation(bars, cfg, [], { lotFilter, exitPolicy: 'MARKET_STOP' });
  const held = GridBacktestEngine.runSimulation(bars, cfg, [], { lotFilter, exitPolicy: 'HOLD' });
  ok(
    market.totalFeesUSDT > held.totalFeesUSDT,
    `market close must cost taker fees the hold never pays (market ${market.totalFeesUSDT} vs hold ${held.totalFeesUSDT})`
  );
}

// 4. When the break reverts, holding loses less than being stopped out on noise.
{
  const cfg = buildConfig();
  const bars = breakoutThatReverts();
  const market = GridBacktestEngine.runSimulation(bars, cfg, [], { lotFilter, exitPolicy: 'MARKET_STOP' });
  const held = GridBacktestEngine.runSimulation(bars, cfg, [], { lotFilter, exitPolicy: 'HOLD' });
  eq(market.rangeBreakoutExits, 1, 'the reverted tape must still fire the market stop');
  eq(held.rangeBreakoutExits, 0, 'HOLD must ignore the same tape');
  ok(
    held.netPnLUSDT > market.netPnLUSDT,
    `on a reverting break HOLD must beat the market stop (hold ${held.netPnLUSDT} vs market ${market.netPnLUSDT})`
  );
}

// 5. And the opposite: when the break holds, holding is worse. This is the price of the policy.
{
  const cfg = buildConfig();
  const bars = breakoutThatHolds();
  const market = GridBacktestEngine.runSimulation(bars, cfg, [], { lotFilter, exitPolicy: 'MARKET_STOP' });
  const held = GridBacktestEngine.runSimulation(bars, cfg, [], { lotFilter, exitPolicy: 'HOLD' });
  ok(
    held.netPnLUSDT < market.netPnLUSDT,
    `on a break that holds, HOLD must be worse (hold ${held.netPnLUSDT} vs market ${market.netPnLUSDT})`
  );
}

// 6. The backstop sits beyond the edge: it must NOT fire on the edge, only beyond the buffer.
{
  const cfg = buildConfig();
  const bars = breakoutThatReverts(); // closes at 104 = 1% above the 103 edge
  const backstop = GridBacktestEngine.runSimulation(bars, cfg, [], {
    lotFilter,
    exitPolicy: 'HOLD_BACKSTOP',
    backstopBufferPct: 1.5, // edge + 1.5% = 104.5, so a 104 close survives
  });
  eq(backstop.rangeBreakoutExits, 0, 'a 1% break must not reach a 1.5% backstop');
  eq(backstop.exitReason, 'END_OF_DATA', 'backstop must leave the position open inside the buffer');

  const tight = GridBacktestEngine.runSimulation(bars, cfg, [], {
    lotFilter,
    exitPolicy: 'HOLD_BACKSTOP',
    backstopBufferPct: 0.5, // edge + 0.5% = 103.5, so the same 104 close DOES fire
  });
  eq(tight.rangeBreakoutExits, 1, 'the same break must fire a 0.5% backstop');
}

console.log('gridExitPolicy: 6/6 OK');
