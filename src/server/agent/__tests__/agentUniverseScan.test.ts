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
  selectRotationWindow,
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

test('opportunity: an estimated minimum above the budget is ADVISORY, not a rejection', () => {
  // 1 lot = 100 x 100 USDT, so `1 lot x gridNum / lever` is far above the 12 USDT budget.
  // That number is a LOCAL estimate, never an OKX answer (ETH 8 grids / 10x estimated $14.55
  // while OKX ran the grid on $5.00), so it must flag the candidate instead of deleting it.
  const row = buildAgentOpportunity({
    spec: spec({ minSz: 100, ctVal: 1 }),
    ticker: ticker(),
    klines15m: oscillatingKlines(),
    book: book(),
    settings,
  })!;

  eq(row.requiresLiveProbe, true, 'the estimate must be flagged for a live probe');
  eq(row.isEligible, true, 'the local 1-lot estimate must not block the candidate');
  eq(row.rejectionReason, undefined, 'no rejection may come from the estimate');
  eq(row.fitsMaxBudget, false, 'the estimate is still reported honestly');
  ok(
    row.reasons.some((r) => /proba live/i.test(r)),
    `the reason must say the live probe decides, got: ${row.reasons.join(' | ')}`
  );
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

test('scanner (turnover mode): ranks by crossings/hour and drops illiquid contracts', async () => {
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
    universeScanMode: 'turnover',
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
// Rotation — the whole universe must be seen, not just the most liquid
// ---------------------------------------------------------------------------

const rotationContracts = (n: number) =>
  Array.from({ length: n }, (_, i) => {
    const instId = `C${String(i).padStart(3, '0')}-USD_UM_XPERP-310523`;
    return { spec: spec({ instId }), ticker: ticker({ instId }), klines: oscillatingKlines() };
  });

test('rotation window: one turn covers the list exactly once, without overlap', () => {
  const ids = Array.from({ length: 259 }, (_, i) => `C${String(i).padStart(3, '0')}`);
  const seen: string[] = [];
  let cursor = 0;
  let cycles = 0;
  for (;;) {
    const w = selectRotationWindow(ids, cursor, 25);
    ok(w.items.length > 0, 'a non-empty list must always yield a window');
    seen.push(...w.items);
    cursor = w.nextCursor;
    cycles++;
    if (cursor === 0) break;
    ok(cycles <= 20, 'a turn must close instead of orbiting forever');
  }
  eq(cycles, 11, 'ceil(259/25) = 11 cycles per turn');
  eq(seen.length, 259, 'one turn must visit every contract exactly once');
  eq(new Set(seen).size, 259, 'no contract may be scanned twice in a turn');
  eq(seen[0], 'C000', 'the first window starts at the first item');
  eq(seen[seen.length - 1], 'C258', 'the turn ends on the last item');
});

test('rotation window: the last window of a turn is truncated, not wrapped', () => {
  const ids = Array.from({ length: 10 }, (_, i) => `I${i}`);
  const w = selectRotationWindow(ids, 8, 5);
  eq(w.items.join(','), 'I8,I9', 'only what is left of the list is scanned');
  eq(w.nextCursor, 0, 'the turn closes at the end of the list');
});

test('rotation window: degenerate inputs never throw or return junk', () => {
  eq(selectRotationWindow([], 3, 25).items.length, 0, 'empty list yields an empty window');
  const big = selectRotationWindow(['a', 'b'], 0, 25);
  eq(big.items.length, 2, 'a window larger than the list returns the whole list');
  eq(big.nextCursor, 0, 'and closes the turn');
  const far = selectRotationWindow(['a', 'b', 'c'], 999, 2);
  eq(far.start, 0, 'an out-of-range cursor is normalised (999 % 3 = 0)');
  eq(far.items.join(','), 'a,b', 'and the window is still valid');
});

test('scanner: rotation sees the whole universe, turnover is irrelevant', async () => {
  const data = fakeDataSource([
    {
      spec: spec({ instId: 'AAA-USD_UM_XPERP-310523' }),
      ticker: ticker({ instId: 'AAA-USD_UM_XPERP-310523' }),
      klines: oscillatingKlines(),
    },
    {
      spec: spec({ instId: 'BBB-USD_UM_XPERP-310523' }),
      ticker: ticker({ instId: 'BBB-USD_UM_XPERP-310523', turnover24hUSDT: 1000 }),
      klines: oscillatingKlines(),
    },
  ]);

  // No universeScanMode passed: rotation must be the default.
  const rows = await new AgentUniverseScanner(data).scan({ ...settings, deepScanCount: 25 });
  eq(rows.length, 2, 'a 1k-turnover contract must still be scanned in rotation mode');
});

test('scanner: rotation advances the persisted cursor between cycles', async () => {
  const data = fakeDataSource(rotationContracts(60));
  let saved = 0;
  const store = {
    load: () => saved,
    save: (c: number) => {
      saved = c;
    },
  };
  const scanner = new AgentUniverseScanner(data, undefined, store);

  const first = await scanner.scan({ ...settings, deepScanCount: 25 });
  eq(first.length, 25, 'the first cycle deep-scans exactly the window size');
  eq(saved, 25, 'the cursor advances after a completed cycle');

  const second = await scanner.scan({ ...settings, deepScanCount: 25 });
  const seenFirst = new Set(first.map((r) => r.instId));
  ok(
    second.every((r) => !seenFirst.has(r.instId)),
    'the next cycle must look at different contracts'
  );

  const third = await scanner.scan({ ...settings, deepScanCount: 25 });
  eq(third.length, 10, 'the turn closes with the 10 contracts that are left');
  eq(saved, 0, 'the cursor returns to the start once the universe is covered');
});

test('scanner: a broken cursor store degrades to the start instead of failing', async () => {
  const data = fakeDataSource(rotationContracts(5));
  const store = {
    load: () => {
      throw new Error('corrupt');
    },
    save: () => {},
  };
  const rows = await new AgentUniverseScanner(data, undefined, store).scan({
    ...settings,
    deepScanCount: 25,
  });
  eq(rows.length, 5, 'the scan must still produce candidates');
});

test('scanner: rotation order is alphabetical, not turnover order', async () => {
  // Turnover deliberately reversed relative to the instId order.
  const contracts = ['ZZZ', 'MMM', 'AAA'].map((s, i) => {
    const instId = `${s}-USD_UM_XPERP-310523`;
    return {
      spec: spec({ instId }),
      ticker: ticker({ instId, turnover24hUSDT: (i + 1) * 1_000_000 }),
      klines: oscillatingKlines(),
    };
  });

  const rows = await new AgentUniverseScanner(fakeDataSource(contracts)).scan({
    ...settings,
    deepScanCount: 2,
  });
  const scanned = rows.map((r) => r.instId.split('-')[0]).sort();
  eq(scanned.join(','), 'AAA,MMM', 'the window must follow instId order, not turnover');
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
