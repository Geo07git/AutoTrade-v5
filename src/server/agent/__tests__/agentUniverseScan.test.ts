/**
 * Regression suite for the agent-owned universe scan (`AgentUniverseScan`).
 *
 * All offline: the data source is a fake, so these tests verify ONLY the math and the
 * gates — which is exactly what decides whether a grid will ever fill.
 *
 * Run: npm test
 */

import {
  AgentUniverseScanner,
  buildAgentOpportunity,
  computeAgentGridMetrics,
  computeMinLotNotionalUsd,
  type AgentContractSpec,
  type AgentUniverseDataSource,
  type AgentUniverseTicker,
} from '../AgentUniverseScan';
import type { Kline } from '../../../shared/types';

// ---------------------------------------------------------------------------
// Tiny runner (same pattern as deepSeekAgent.test.ts)
// ---------------------------------------------------------------------------

const registered: Array<{ name: string; fn: () => Promise<void> | void }> = [];
const test = (name: string, fn: () => Promise<void> | void) => registered.push({ name, fn });

const ok = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(msg);
};

const eq = (actual: unknown, expected: unknown, msg: string): void => {
  if (actual !== expected) {
    throw new Error(`${msg} (expected ${String(expected)}, got ${String(actual)})`);
  }
};

const near = (actual: number, expected: number, tolerance: number, msg: string): void => {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${msg} (expected ~${expected}, got ${actual})`);
  }
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FEE = 0.04; // maker round-trip, %

/** 48 bars of a clean ±0.4% oscillation around `base`, with ±0.5% wicks. */
function oscillatingKlines(base = 100, amplitudePct = 0.4, wickPct = 0.2): Kline[] {
  const bars: Kline[] = [];
  for (let i = 0; i < 48; i++) {
    const close = i % 2 === 0 ? base : base * (1 + amplitudePct / 100);
    bars.push({
      timestamp: Date.now() - (48 - i) * 900_000,
      open: close,
      high: close * (1 + wickPct / 100),
      low: close * (1 - wickPct / 100),
      close,
      volume: 1000,
    });
  }
  return bars;
}

/** 48 bars of a dead tape: barely moves. */
function flatKlines(base = 100): Kline[] {
  return Array.from({ length: 48 }, (_, i) => ({
    timestamp: Date.now() - (48 - i) * 900_000,
    open: base,
    high: base * 1.0001,
    low: base * 0.9999,
    close: base,
    volume: 10,
  }));
}

const spec = (over: Partial<AgentContractSpec> = {}): AgentContractSpec => ({
  instId: 'ETH-USD_UM_XPERP-310523',
  minSz: 1,
  lotSz: 1,
  tickSz: 0.01,
  ctVal: 1,
  ...over,
});

const ticker = (over: Partial<AgentUniverseTicker> = {}): AgentUniverseTicker => ({
  instId: 'ETH-USD_UM_XPERP-310523',
  lastPrice: 100,
  turnover24hUSDT: 50_000_000,
  priceChange24hPct: 0.5,
  high24h: 103,
  low24h: 97,
  spreadPct: 0.01,
  ...over,
});

const book = (depthUsd = 1_000_000) => ({ depthUsd, imbalance: 0.02 });

const settings = {
  budgetPerBotUSDT: 12,
  maxLeverage: 2,
  roundTripFeePct: FEE,
};

// ---------------------------------------------------------------------------
// Geometry + fill statistics
// ---------------------------------------------------------------------------

test('metrics: step comes from ATR, and crossings/hour from the real path', () => {
  const m = computeAgentGridMetrics({
    price: 100,
    klines15m: oscillatingKlines(),
    spreadPct: 0,
    roundTripFeePct: FEE,
  })!;

  ok(!!m, 'metrics must be produced for a usable tape');
  near(m.atrPct, 0.4, 0.05, 'ATR15m must reflect the 0.4% true range');
  near(m.halfRangePct, 0.8, 0.01, 'half range = 1.6 x ATR');
  eq(m.gridNum, 4, 'a 1.6% band with a ~0.36% target step needs 4 grids (even count)');
  near(m.stepPct, 0.4, 0.01, 'step = 2 x halfRange / gridNum');
  // 0.4% per bar, 4 bars per hour => ~1.6%/h of path on a 0.4% step.
  near(m.pathPerHourPct, 1.6, 0.1, 'path per hour must be measured on the 15m closes');
  near(m.crossingsPerHour, 4.0, 0.2, 'crossings/h = path per hour / step');
  near(m.expectedFirstFillMin, 15, 2, 'first fill = half a step at the observed speed');
  near(m.netPerGridPct, 0.36, 0.01, 'net per grid = step - maker round-trip');
});

test('metrics: a dead tape cannot produce an edge', () => {
  const m = computeAgentGridMetrics({
    price: 100,
    klines15m: flatKlines(),
    spreadPct: 0,
    roundTripFeePct: FEE,
  })!;

  ok(m.pathPerHourPct < 0.01, 'a flat tape must report ~0 path per hour');
  eq(m.crossingsPerHour, 0, 'no path means no crossings');
  ok(m.expectedFirstFillMin > 240, 'first fill must be pushed hours into the future');
});

test('metrics: unusable input is refused instead of guessed', () => {
  eq(
    computeAgentGridMetrics({ price: 0, klines15m: oscillatingKlines(), roundTripFeePct: FEE }),
    null,
    'a non-positive price cannot be measured'
  );
  eq(
    computeAgentGridMetrics({ price: 100, klines15m: oscillatingKlines().slice(0, 5), roundTripFeePct: FEE }),
    null,
    'fewer than 16 bars cannot describe a tape'
  );
});

test('min lot notional respects contract value', () => {
  eq(computeMinLotNotionalUsd(spec({ minSz: 2, ctVal: 3 }), 10), 60, 'minSz x ctVal x price');
});

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

test('opportunity: a healthy candidate is eligible and keeps leverage <= 2x', () => {
  const row = buildAgentOpportunity({
    spec: spec({ tickSz: 0.0001 }),
    ticker: ticker({ lastPrice: 1 }),
    klines15m: oscillatingKlines(1),
    book: book(),
    settings: { ...settings, maxLeverage: 5 }, // must be clamped down
  })!;

  eq(row.agentScan, true, 'the row must be flagged as agent-scanned');
  eq(row.isEligible, true, `expected eligible, got rejection "${row.rejectionReason}"`);
  eq(row.lever, 2, 'leverage is capped at 2x');
  eq(row.suitabilityScore, 0, 'the agent scan deliberately produces no score');
  ok(row.minPx < row.price && row.price < row.maxPx, 'the price must sit inside the band');
  ok((row.crossingsPerHour || 0) > 0, 'crossings/hour must be reported');
});

test('opportunity: a step under the fee floor is rejected', () => {
  const row = buildAgentOpportunity({
    spec: spec(),
    ticker: ticker(),
    klines15m: flatKlines(),
    book: book(),
    settings,
  })!;

  eq(row.isEligible, false, 'a grid whose step cannot clear 3x fees must never be opened');
  ok(/comision/i.test(row.rejectionReason || ''), `unexpected reason: ${row.rejectionReason}`);
});

test('opportunity: a wide spread against the step is rejected', () => {
  const row = buildAgentOpportunity({
    spec: spec(),
    ticker: ticker({ spreadPct: 0.5 }),
    klines15m: oscillatingKlines(),
    book: book(),
    settings,
  })!;

  eq(row.isEligible, false, 'spread > 25% of the step must block the open');
  ok(/Spread/i.test(row.rejectionReason || ''), `unexpected reason: ${row.rejectionReason}`);
});

test('opportunity: a minimum lot that does not fit the budget is rejected', () => {
  const row = buildAgentOpportunity({
    spec: spec({ minSz: 100, ctVal: 1 }),
    ticker: ticker(),
    klines15m: oscillatingKlines(),
    book: book(),
    settings,
  })!;

  eq(row.isEligible, false, '1 lot x gridNum must fit inside the budget');
  ok(/Marj/i.test(row.rejectionReason || ''), `unexpected reason: ${row.rejectionReason}`);
});

test('opportunity: thin top-of-book liquidity is rejected', () => {
  const row = buildAgentOpportunity({
    spec: spec({ tickSz: 0.0001 }),
    ticker: ticker({ lastPrice: 1 }),
    klines15m: oscillatingKlines(1),
    book: book(50), // 50 USD vs 20 x 12 USD required
    settings,
  })!;

  eq(row.isEligible, false, 'a book thinner than 20x the margin must block the open');
  ok(/Lichiditate/i.test(row.rejectionReason || ''), `unexpected reason: ${row.rejectionReason}`);
});

// ---------------------------------------------------------------------------
// Scanner: ordering is crossings/hour, not any app score
// ---------------------------------------------------------------------------

const fakeDataSource = (
  contracts: Array<{ spec: AgentContractSpec; ticker: AgentUniverseTicker; klines: Kline[] }>
): AgentUniverseDataSource => ({
  listXPerpContracts: async () => contracts.map((c) => c.spec),
  fetchTickers: async () => {
    const map: Record<string, AgentUniverseTicker> = {};
    for (const c of contracts) map[c.spec.instId] = c.ticker;
    return map;
  },
  fetchKlines15m: async (instId: string) =>
    contracts.find((c) => c.spec.instId === instId)!.klines,
  fetchBookSnapshot: async () => book(),
});

test('scanner: ranks by crossings/hour and drops illiquid contracts before the deep scan', async () => {
  const fastId = 'AAA-USD_UM_XPERP-310523';
  const slowId = 'BBB-USD_UM_XPERP-310523';
  const deadTurnoverId = 'CCC-USD_UM_XPERP-310523';

  const data = fakeDataSource([
    {
      spec: spec({ instId: fastId }),
      ticker: ticker({ instId: fastId }),
      klines: oscillatingKlines(100, 0.6, 0.3),
    },
    {
      spec: spec({ instId: slowId }),
      ticker: ticker({ instId: slowId }),
      klines: oscillatingKlines(100, 0.12, 0.3),
    },
    {
      spec: spec({ instId: deadTurnoverId }),
      ticker: ticker({ instId: deadTurnoverId, turnover24hUSDT: 1000 }),
      klines: oscillatingKlines(100, 2, 1),
    },
  ]);

  const rows = await new AgentUniverseScanner(data).scan({
    ...settings,
    deepScanCount: 25,
    roundTripFeePct: 0.01,
  });

  eq(rows.length, 2, 'the < 3M turnover contract must never reach the deep scan');
  eq(rows[0].instId, fastId, 'the most crossed grid must rank first');
  eq(rows[0].rank, 1, 'ranks must be assigned');
  ok(
    (rows[0].crossingsPerHour || 0) > (rows[1].crossingsPerHour || 0),
    'ordering must be strictly by crossings/hour'
  );
});

test('scanner: an empty universe produces no candidates instead of throwing', async () => {
  const rows = await new AgentUniverseScanner(fakeDataSource([])).scan(settings);
  eq(rows.length, 0, 'no contracts must yield no rows');
});

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

const run = async (): Promise<void> => {
  let failed = 0;
  for (const t of registered) {
    try {
      await t.fn();
      console.log(`  ok    ${t.name}`);
    } catch (err: any) {
      failed++;
      console.error(`  FAIL  ${t.name}`);
      console.error(`        ${err?.message || err}`);
    }
  }
  const total = registered.length;
  console.log(`\n${total - failed}/${total} agent-universe tests passed`);
  if (failed > 0) process.exitCode = 1;
};

void run();
