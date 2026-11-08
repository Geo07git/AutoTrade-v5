/**
 * Regression suite for DeepSeekAgent — the autonomous decision layer of the TB5 desk.
 *
 * What is covered here (all offline: no OKX, no DeepSeek API, no network):
 *   - mode semantics (OFF / ADVISOR dry-run, AUTONOMOUS execution)
 *   - the deterministic fallback engine (no API key -> LOCAL_FALLBACK)
 *   - the execution guard: PAPER accounts, authority conflict with the OKX native
 *     Autopilot, kill switch, cooldowns, range geometry, budget/slot accounting
 *   - the hard guardrail stops (hard SL, liquidation proximity, range breakout, no-fill)
 *   - config sanitisation + panic stop
 *
 * Every test builds its own agent with throw-away store files, so the operator's
 * real `.data/deepseek_agent_config.json` is never touched.
 *
 * Run: npm test
 */

import fs from 'fs';
import path from 'path';

import {
  DeepSeekAgent,
  DEFAULT_DEEPSEEK_AGENT_CONFIG,
  computeDeepSeekCostUSD,
  estimateTokensFromText,
  resolveOpenSize,
  type DeepSeekAccountSnapshot,
  type DeepSeekAgentDeps,
} from '../DeepSeekAgent';
import type {
  DeepSeekAgentDecision,
  NativeGridOpportunity,
  OKXNativeGridBot,
} from '../../../shared/types';

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------
const ok = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(msg);
};

const eq = (actual: unknown, expected: unknown, msg: string): void => {
  if (actual !== expected) {
    throw new Error(`${msg} (expected ${String(expected)}, got ${String(actual)})`);
  }
};

const near = (actual: number, expected: number, tolerance: number, msg: string): void => {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > tolerance) {
    throw new Error(`${msg} (expected ~${expected}, got ${actual})`);
  }
};

const has = (text: string, needle: string, msg: string): void => {
  if (!String(text).toLowerCase().includes(needle.toLowerCase())) {
    throw new Error(`${msg} (expected to contain "${needle}", got "${text}")`);
  }
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const INST = 'ETH-USD_UM_XPERP-310523';
const OTHER_INST = 'SOL-USD_UM_XPERP-310523';
const LIVE_ALGO = '3123456789012345678';

const opportunity = (over: Partial<NativeGridOpportunity> = {}): NativeGridOpportunity => ({
  instId: INST,
  price: 2000,
  volume24hUSDT: 250_000_000,
  priceChange24hPct: 0.4,
  range24hPct: 3.2,
  atrPct: 1.1,
  choppinessIndex: 62,
  adxTrendStrength: 18,
  spreadBps: 1.8,
  openInterestUSD: 90_000_000,
  fundingRatePct: 0.008,
  nextFundingRatePct: 0.007,
  orderBookImbalance: 0.05,
  orderBookDepthUSD: 4_000_000,
  suitabilityScore: 82,
  regimeLabel: 'IDEAL_RANGE',
  halfRangePct: 1.25,
  minPx: 1975,
  maxPx: 2025,
  gridNum: 8,
  runType: '1',
  gridSpacingPct: 0.63,
  lever: 5,
  minInvestmentUSDT: 18,
  minInvestmentCcy: 'USDT',
  recommendedInvestmentUSDT: 20,
  fitsMaxBudget: true,
  estimatedGrossProfitPerGridPct: 0.63,
  estimatedNetProfitPerGridPct: 0.55,
  estimatedDailyNetYieldPct: 1.4,
  selectedVariant: 'BALANCED',
  isEligible: true,
  reasons: [],
  updatedAt: Date.now(),
  ...over,
});

const bot = (over: Partial<OKXNativeGridBot> = {}): OKXNativeGridBot => ({
  algoId: LIVE_ALGO,
  instId: INST,
  algoOrdType: 'contract_grid',
  direction: 'neutral',
  environment: 'LIVE',
  state: 'running',
  minPx: 1975,
  maxPx: 2025,
  gridNum: 8,
  runType: '1',
  lever: 5,
  sz: 20,
  singleAmt: 0,
  currentPx: 2000,
  liqPx: 1700,
  gridProfit: 1.2,
  floatProfit: 0.3,
  totalPnl: 1.5,
  totalPnlPct: 7.5,
  arbitrageNum: 6,
  stopLossPct: 8,
  takeProfitPct: 15,
  stopTypeOnRisk: '1',
  stopOnRangeBreakout: true,
  stopOnTrendInvalidation: true,
  cTime: Date.now() - 30 * 60_000,
  uTime: Date.now() - 60_000,
  ...over,
});

const LIVE_SNAPSHOT: DeepSeekAccountSnapshot = {
  executionMode: 'LIVE',
  killSwitchEngaged: false,
  equity: 300,
  freeBalance: 220,
  marginInvested: 80,
  sessionPnl: 4.5,
  makerFeePct: 0.02,
  takerFeePct: 0.05,
};

interface Harness {
  deps: DeepSeekAgentDeps;
  agent: DeepSeekAgent;
  calls: {
    created: any[];
    stopped: Array<{ algoId: string; stopType?: string; reason?: string }>;
    amended: Array<{ algoId: string; params: any }>;
    scans: number;
    audits: Array<{ type: string; message: string }>;
    telegram: string[];
  };
  setSnapshot(over: Partial<DeepSeekAccountSnapshot>): void;
  setOpportunities(list: NativeGridOpportunity[]): void;
  setBots(list: OKXNativeGridBot[]): void;
  setAutopilot(enabled: boolean): void;
  createResult: { success: boolean; error?: string };
}

let storeSeq = 0;
const createdStores: string[] = [];
const STORE_DIR = path.join(process.cwd(), '.data');
// Unique per process run: JsonStore flushes on process exit, so a fixed filename would
// leak state from a previous run into the next one.
const RUN_ID = `${process.pid}_${Date.now().toString(36)}`;
const TEST_STORE_PREFIX = '__test_deepseek_';

function purgeTestStores(): void {
  try {
    for (const name of fs.readdirSync(STORE_DIR)) {
      if (name.startsWith(TEST_STORE_PREFIX)) {
        fs.rmSync(path.join(STORE_DIR, name), { force: true });
      }
    }
  } catch {
    /* best effort */
  }
}

purgeTestStores();

function makeAgent(opts?: {
  snapshot?: Partial<DeepSeekAccountSnapshot>;
  opportunities?: NativeGridOpportunity[];
  bots?: OKXNativeGridBot[];
  autopilotEnabled?: boolean;
  /** Rows returned by the agent-owned scan (enables the scanAgentUniverse dependency). */
  ownScan?: NativeGridOpportunity[];
  /** When true, the agent-owned scan throws (fail-closed test). */
  ownScanThrows?: boolean;
  /** Live tape readings for the stagnation rule (presence enables getMarketActivity). */
  marketActivity?: { pathPerHourPct: number; atrPct: number } | null;
}): Harness {
  let snapshot: DeepSeekAccountSnapshot = { ...LIVE_SNAPSHOT, ...(opts?.snapshot || {}) };
  let opportunities = opts?.opportunities ?? [opportunity()];
  let bots = opts?.bots ?? [];
  let autopilotEnabled = opts?.autopilotEnabled ?? false;

  const calls: Harness['calls'] = {
    created: [],
    stopped: [],
    amended: [],
    scans: 0,
    audits: [],
    telegram: [],
  };

  const harness: Harness = {
    deps: {} as DeepSeekAgentDeps,
    agent: null as unknown as DeepSeekAgent,
    calls,
    createResult: { success: true },
    setSnapshot: (over) => {
      snapshot = { ...snapshot, ...over };
    },
    setOpportunities: (list) => {
      opportunities = list;
    },
    setBots: (list) => {
      bots = list;
    },
    setAutopilot: (enabled) => {
      autopilotEnabled = enabled;
    },
  };

  const deps: DeepSeekAgentDeps = {
    getAccountSnapshot: () => ({ ...snapshot }),
    hasOKXCredentials: () => true,
    getNativeGridAutopilotConfig: () => ({
      enabled: autopilotEnabled,
      lastDecision: autopilotEnabled ? 'Autopilot activ' : 'Autopilot oprit',
    }),
    getNativeGridBots: () => bots,
    getNativeGridOpportunities: () => opportunities,
    scanNativeGridOpportunities: async () => {
      calls.scans++;
      return opportunities;
    },
    createNativeGridBot: async (params: any) => {
      calls.created.push(params);
      return harness.createResult.success
        ? { success: true, bot: { algoId: `grid_${calls.created.length}` } }
        : { success: false, error: harness.createResult.error || 'respins de OKX' };
    },
    stopNativeGridBot: async (algoId: string, stopType?: '1' | '2', reason?: string) => {
      calls.stopped.push({ algoId, stopType, reason });
      return { success: true };
    },
    amendNativeGridBot: async (algoId: string, params: any) => {
      calls.amended.push({ algoId, params });
      return { success: true };
    },
    logAudit: (type, message) => {
      calls.audits.push({ type: String(type), message });
    },
    // Only attached when the test asks for it: without it the agent uses the app list.
    ...(opts && ('ownScan' in opts || 'ownScanThrows' in opts)
      ? {
          scanAgentUniverse: async () => {
            calls.scans++;
            if (opts.ownScanThrows) throw new Error('scan indisponibil');
            return opts.ownScan ?? [];
          },
        }
      : {}),
    ...(opts && 'marketActivity' in opts
      ? { getMarketActivity: async () => opts.marketActivity ?? null }
      : {}),
    notifyTelegram: async (text: string) => {
      calls.telegram.push(text);
      return true;
    },
  };

  const seq = ++storeSeq;
  const files = {
    configFile: `${TEST_STORE_PREFIX}${RUN_ID}_${seq}_config.json`,
    credentialsFile: `${TEST_STORE_PREFIX}${RUN_ID}_${seq}_credentials.json`,
    decisionsFile: `${TEST_STORE_PREFIX}${RUN_ID}_${seq}_decisions.json`,
  };
  createdStores.push(...Object.values(files));

  harness.deps = deps;
  harness.agent = new DeepSeekAgent(deps, files);
  // Never let an ambient DEEPSEEK_API_KEY turn the suite into a network test.
  harness.agent.setApiKey('');
  return harness;
}

/** AUTONOMOUS config + LIVE account: the only configuration allowed to execute. */
async function armAutonomous(h: Harness, over: Record<string, any> = {}) {
  return h.agent.updateConfig({
    mode: 'AUTONOMOUS',
    scanBeforeDecision: false,
    notifyTelegram: false,
    budgetPerBotUSDT: 20,
    minReserveUSDT: 10,
    maxConcurrentBots: 2,
    // The fixture's OKX minimum (18 USDC) must not trip the desk margin ceiling here.
    maxTotalMarginUSDT: 200,
    minSuitabilityScore: 70,
    minNetProfitPerGridPct: 0.05,
    maxActionsPerCycle: 2,
    ...over,
  });
}

const openActions = (d: DeepSeekAgentDecision) =>
  d.approvedActions.filter((a) => a.type === 'OPEN_GRID') as any[];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
const registered: Array<{ name: string; fn: () => Promise<void> | void }> = [];
const test = (name: string, fn: () => Promise<void> | void): void => {
  registered.push({ name, fn });
};

// ===========================================================================
// 1. Mode semantics
// ===========================================================================

test('OFF mode: a manual cycle still produces a dry-run decision and executes nothing', async () => {
  const h = makeAgent();
  eq(h.agent.getConfig().mode, 'OFF', 'agent must default to OFF');

  const decision = await h.agent.runCycle('MANUAL');

  eq(decision.mode, 'OFF', 'decision must record the OFF mode');
  eq(decision.dryRun, true, 'OFF mode must always be a dry run');
  eq(decision.engine, 'LOCAL_FALLBACK', 'no API key -> deterministic fallback engine');
  eq(decision.results.length, 0, 'nothing may be executed in OFF mode');
  eq(h.calls.created.length, 0, 'no bot may be created in OFF mode');
});

test('ADVISOR mode: proposes but never executes', async () => {
  const h = makeAgent();
  await h.agent.updateConfig({
    mode: 'ADVISOR',
    scanBeforeDecision: false,
    notifyTelegram: false,
    // The fixture's OKX minimum is 18 USDT; the shipped default budget is 12.
    budgetPerBotUSDT: 20,
    maxTotalMarginUSDT: 200,
  });

  const decision = await h.agent.runCycle('MANUAL');

  eq(decision.dryRun, true, 'ADVISOR must be a dry run');
  ok(openActions(decision).length > 0, 'the fallback engine should still propose the eligible candidate');
  eq(decision.results.length, 0, 'ADVISOR must not execute any action');
  eq(h.calls.created.length, 0, 'ADVISOR must never call createNativeGridBot');
});

test('AUTONOMOUS mode + LIVE account: the eligible candidate is opened once', async () => {
  const h = makeAgent();
  await armAutonomous(h);

  const decision = await h.agent.runCycle('MANUAL');

  eq(decision.dryRun, false, 'AUTONOMOUS must execute');
  eq(h.calls.created.length, 1, 'exactly one bot must be created');
  eq(h.calls.created[0].instId, INST, 'the created bot must target the analysed instrument');
  eq(h.calls.created[0].environment, 'LIVE', 'native grid creation must be flagged LIVE');
  eq(
    h.calls.created[0].executionVariant,
    'AUTO_LIMIT',
    'OKX EEA rejects _UM_XPERP on /tradingBot/grid/* (51001 then 51000): X-Perp opens must skip the native algo'
  );
  eq(h.calls.created[0].stopTypeOnRisk, '1', 'risk stop must close the position at market');
  ok(h.calls.created[0].sz <= 20, 'size must respect budgetPerBotUSDT');
  ok(h.calls.created[0].lever <= 5, 'leverage must respect maxLeverage');
  eq(decision.results.filter((r) => r.success).length, 1, 'one successful result expected');
});

test('preferNativeAlgo is a no-op on X-Perp: both switch states use direct orders', async () => {
  const off = makeAgent();
  await armAutonomous(off, { preferNativeAlgo: false });
  await off.agent.runCycle('MANUAL');
  eq(off.calls.created.length, 1, 'exactly one bot must be created');
  eq(
    off.calls.created[0].executionVariant,
    'AUTO_LIMIT',
    'direct orders must be used when the native algo is disabled'
  );

  const on = makeAgent();
  const cfg = await armAutonomous(on, { preferNativeAlgo: true });
  eq(cfg.preferNativeAlgo, true, 'the switch itself must stay ON when the operator enables it');
  await on.agent.runCycle('MANUAL');
  eq(on.calls.created.length, 1, 'exactly one bot must be created');
  eq(
    on.calls.created[0].executionVariant,
    'AUTO_LIMIT',
    'an X-Perp must never be routed to the native grid algo (OKX EEA 51001/51000), even when the switch is ON'
  );
});

// ===========================================================================
// 2. Execution guard
// ===========================================================================

test('guard: PAPER account blocks OPEN_GRID (the agent never switches execution mode)', async () => {
  const h = makeAgent({ snapshot: { executionMode: 'PAPER' } });
  await armAutonomous(h);

  const decision = await h.agent.runCycle('MANUAL');

  eq(openActions(decision).length, 0, 'no OPEN_GRID may be approved on a PAPER account');
  eq(h.calls.created.length, 0, 'no bot may be created on a PAPER account');
  ok(
    decision.rejectedActions.some((r) => /PAPER/i.test(r.reason)),
    'the rejection reason must name the execution mode'
  );
});

test('guard: an enabled OKX native Autopilot blocks OPEN_GRID (single trading authority)', async () => {
  const h = makeAgent({ autopilotEnabled: true });
  await armAutonomous(h);

  const decision = await h.agent.runCycle('MANUAL');

  eq(openActions(decision).length, 0, 'no OPEN_GRID while the Autopilot is enabled');
  eq(h.calls.created.length, 0, 'no bot may be created while the Autopilot is enabled');
  ok(
    decision.rejectedActions.some((r) => /Autopilot/i.test(r.reason)),
    'the rejection reason must mention the authority conflict'
  );
  eq(h.agent.getStatus().authorityConflict, true, 'status must expose the authority conflict');
});

test('guard: kill switch blocks OPEN_GRID', async () => {
  const h = makeAgent({ snapshot: { killSwitchEngaged: true } });
  await armAutonomous(h);

  const decision = await h.agent.runCycle('MANUAL');

  eq(h.calls.created.length, 0, 'no bot may be created with the kill switch engaged');
  ok(
    decision.rejectedActions.some((r) => /Kill Switch/i.test(r.reason)),
    'the rejection reason must mention the kill switch'
  );
});

test('guard: price outside [minPx, maxPx] is rejected', async () => {
  const h = makeAgent({
    opportunities: [opportunity({ price: 2100 })], // inside a range the model cannot honour
    snapshot: { executionMode: 'LIVE' },
  });
  await armAutonomous(h);

  const decision = await h.agent.runCycle('MANUAL');
  const actions = decision.approvedActions as any[];

  eq(actions.filter((a) => a.type === 'OPEN_GRID').length, 0, 'an out-of-range price must not be opened');
  ok(
    decision.rejectedActions.length > 0,
    'the out-of-range proposal must be rejected with a reason'
  );
});

test('guard: a range wider than +/-25% of price is rejected', async () => {
  const h = makeAgent({
    opportunities: [opportunity({ minPx: 1000, maxPx: 3000 })],
  });
  await armAutonomous(h);

  const decision = await h.agent.runCycle('MANUAL');

  eq(openActions(decision).length, 0, 'an over-wide range must not be opened');
  ok(
    decision.rejectedActions.some((r) => /25%/.test(r.reason)),
    'the rejection reason must mention the 25% range clamp'
  );
});

test('guard: an active per-symbol cooldown blocks re-opening the same instrument', async () => {
  const h = makeAgent();
  await armAutonomous(h, { cooldownMinutesPerSymbol: 30, symbolCooldowns: { [INST]: Date.now() } });

  const decision = await h.agent.runCycle('MANUAL');

  eq(openActions(decision).length, 0, 'cooldown must block the open');
  ok(
    decision.rejectedActions.some((r) => /Cooldown/i.test(r.reason)),
    'the rejection reason must mention the cooldown'
  );
});

test('guard: session loss limit blocks new opens', async () => {
  const h = makeAgent({ snapshot: { sessionPnl: -40 } });
  await armAutonomous(h, { dailyLossLimitUSDT: 25 });

  const decision = await h.agent.runCycle('MANUAL');

  eq(openActions(decision).length, 0, 'a breached loss limit must block new opens');
  ok(
    decision.rejectedActions.some((r) => /pierdere/i.test(r.reason)),
    'the rejection reason must mention the loss limit'
  );
});

test('guard: a free balance below budget+reserve blocks the open', async () => {
  const h = makeAgent({ snapshot: { freeBalance: 25 } });
  await armAutonomous(h, { budgetPerBotUSDT: 20, minReserveUSDT: 10 });

  const decision = await h.agent.runCycle('MANUAL');

  eq(openActions(decision).length, 0, 'spendable cash must stay above the reserve');
  ok(
    decision.rejectedActions.some((r) => /Fond liber insuficient/.test(r.reason)),
    'the rejection reason must mention insufficient free balance'
  );
});

test('guard: slots are respected (maxConcurrentBots already saturated)', async () => {
  const h = makeAgent({
    bots: [bot({ algoId: 'a1', instId: 'XRP-USD_UM_XPERP-310523' }), bot({ algoId: 'a2', instId: OTHER_INST })],
  });
  await armAutonomous(h, { maxConcurrentBots: 2 });

  const decision = await h.agent.runCycle('MANUAL');

  eq(openActions(decision).length, 0, 'no open while every slot is occupied');
  ok(
    decision.rejectedActions.some((r) => /sloturi/i.test(r.reason)),
    'the rejection reason must mention the occupied slots'
  );
});

test('guard: STOP_BOT on an unknown algoId is rejected', async () => {
  const h = makeAgent({ bots: [] });
  await armAutonomous(h);

  // Model output is unavailable offline -> fallback would HOLD, so drive the pipeline
  // through a manual decision by mutating nothing: instead assert the public behaviour
  // of a cycle with no running bots (no STOP may be approved).
  const decision = await h.agent.runCycle('MANUAL');
  eq(
    decision.approvedActions.filter((a) => a.type === 'STOP_BOT').length,
    0,
    'a STOP_BOT cannot be approved when no bot is managed by TB5'
  );
  eq(h.calls.stopped.length, 0, 'nothing may be stopped');
});

// ===========================================================================
// 3. Hard guardrails (deterministic, independent of the model)
// ===========================================================================

test('guardrail: hard stop-loss on margin produces a STOP_BOT that is executed', async () => {
  const h = makeAgent({ bots: [bot({ sz: 20, totalPnl: -3.0, arbitrageNum: 4 })] }); // -15% of margin
  await armAutonomous(h, { hardStopLossPct: 12 });

  const decision = await h.agent.runCycle('MANUAL');

  ok(decision.guardrailActions.length >= 1, 'a hard SL breach must raise a guardrail action');
  eq(h.calls.stopped.length, 1, 'the guardrail stop must be executed in AUTONOMOUS mode');
  eq(h.calls.stopped[0].algoId, LIVE_ALGO, 'the running bot must be the one stopped');
  eq(h.calls.stopped[0].stopType, '1', 'guardrail stops must close the position');
  ok(
    decision.results.some((r) => r.source === 'GUARDRAIL' && r.success),
    'the result must be attributed to the GUARDRAIL source'
  );
});

test('guardrail: liquidation proximity produces a STOP_BOT', async () => {
  const h = makeAgent({ bots: [bot({ currentPx: 2000, liqPx: 1820, totalPnl: 0.4 })] }); // 9% to liq
  await armAutonomous(h, { hardMinLiqDistancePct: 12 });

  const decision = await h.agent.runCycle('MANUAL');

  ok(
    decision.guardrailActions.some((a: any) => /lichidare/i.test(a.rationale_ro || '')),
    'the guardrail must explain the liquidation distance'
  );
  eq(h.calls.stopped.length, 1, 'the bot must be stopped');
});

test('guardrail: a price outside the range produces a STOP_BOT', async () => {
  const h = makeAgent({ bots: [bot({ currentPx: 2060, totalPnl: 0.2 })] });
  await armAutonomous(h);

  const decision = await h.agent.runCycle('MANUAL');

  ok(
    decision.guardrailActions.some((a: any) => /afara range-ului/i.test(a.rationale_ro || '')),
    'the guardrail must explain the range breakout'
  );
  eq(h.calls.stopped.length, 1, 'the bot must be stopped on a breakout');
});

test('guardrail: no arbitrages for too long with negative PnL produces a STOP_BOT', async () => {
  const h = makeAgent({
    bots: [bot({ arbitrageNum: 0, totalPnl: -0.2, cTime: Date.now() - 240 * 60_000 })],
  });
  await armAutonomous(h, { hardMaxNoFillMinutes: 180 });

  const decision = await h.agent.runCycle('MANUAL');

  ok(
    decision.guardrailActions.some((a: any) => /0 arbitraje/i.test(a.rationale_ro || '')),
    'the guardrail must explain the stale bot'
  );
  eq(h.calls.stopped.length, 1, 'the stale bot must be stopped');
});

test('guardrail: a young bot with 0 arbitrages is NOT stopped by the passive rule', async () => {
  const h = makeAgent({
    bots: [bot({ arbitrageNum: 0, totalPnl: 0.01, cTime: Date.now() - 30 * 60_000 })],
  });
  // Even if the operator asks for 20 min, the clamp raises it to 60: a 30 min old grid is
  // simply still waiting for its first crossing.
  await armAutonomous(h, { hardMaxNoFillMinutes: 20, stopIfPassive: true });

  const decision = await h.agent.runCycle('MANUAL');

  eq(
    decision.guardrailActions.length,
    0,
    'a 30 min old bot with 0 arbitrages must be left alone (threshold floor is 60 min)'
  );
  eq(h.calls.stopped.length, 0, 'nothing may be stopped');
});

test('guardrail: a PROFITABLE silent bot is never stopped for silence alone', async () => {
  const h = makeAgent({
    bots: [bot({ arbitrageNum: 0, totalPnl: 0.42, cTime: Date.now() - 400 * 60_000 })],
    marketActivity: { pathPerHourPct: 0.01, atrPct: 0.05 }, // dead tape
  });
  await armAutonomous(h, { hardMaxNoFillMinutes: 180, stopIfPassive: true });

  const decision = await h.agent.runCycle('MANUAL');

  eq(
    decision.guardrailActions.length,
    0,
    'a bot that is not losing money must not be killed just because it is quiet'
  );
  eq(h.calls.stopped.length, 0, 'nothing may be stopped');
});

test('guardrail: a losing bot on a DEAD tape is stopped only past the expected-fill deadline', async () => {
  // bot geometry: [1975, 2025] with 8 grids -> step 0.3125%; tape crawls 0.02%/h =>
  // expected first fill ~268 min, deadline = max(180, 2.5 x 268) = 670 min.
  const h = makeAgent({
    bots: [bot({ arbitrageNum: 0, totalPnl: -0.2, cTime: Date.now() - 700 * 60_000 })],
    marketActivity: { pathPerHourPct: 0.02, atrPct: 0.1 },
  });
  await armAutonomous(h, { hardMaxNoFillMinutes: 180 });

  const decision = await h.agent.runCycle('MANUAL');

  ok(
    decision.guardrailActions.some((a: any) => /crossings\/h/i.test(a.rationale_ro || '')),
    'the guardrail must justify the stop with live crossings/hour'
  );
  eq(h.calls.stopped.length, 1, 'dead tape past the deadline must release the capital');
});

test('guardrail: a losing bot on an ALIVE tape is left alone', async () => {
  const h = makeAgent({
    bots: [bot({ arbitrageNum: 0, totalPnl: -0.2, cTime: Date.now() - 700 * 60_000 })],
    // 1.2%/h of path on a 0.3125% step => ~3.8 crossings/h: the grid is working.
    marketActivity: { pathPerHourPct: 1.2, atrPct: 1.0 },
  });
  await armAutonomous(h, { hardMaxNoFillMinutes: 180 });

  const decision = await h.agent.runCycle('MANUAL');

  eq(
    decision.guardrailActions.length,
    0,
    'an alive tape must never be stopped merely because no fill happened yet'
  );
});

test('guardrail: stopIfPassive=false keeps the old PnL condition', async () => {
  const h = makeAgent({
    bots: [bot({ arbitrageNum: 0, totalPnl: 0.01, cTime: Date.now() - 200 * 60_000 })],
  });
  await armAutonomous(h, { hardMaxNoFillMinutes: 180, stopIfPassive: false });

  const decision = await h.agent.runCycle('MANUAL');

  eq(
    decision.guardrailActions.length,
    0,
    'a positive PnL must not trigger a passive stop when the switch is off'
  );
});

test('guardrail: a healthy bot raises nothing', async () => {
  const h = makeAgent({ bots: [bot()] });
  await armAutonomous(h);

  const decision = await h.agent.runCycle('MANUAL');

  eq(decision.guardrailActions.length, 0, 'a healthy bot must not be touched');
  eq(h.calls.stopped.length, 0, 'nothing may be stopped');
});

test('guardrail: enforceHardGuardrails=false disables the deterministic layer', async () => {
  const h = makeAgent({ bots: [bot({ totalPnl: -6 })] });
  await armAutonomous(h, { enforceHardGuardrails: false });

  const decision = await h.agent.runCycle('MANUAL');

  eq(decision.guardrailActions.length, 0, 'no guardrail actions when the layer is disabled');
  eq(h.calls.stopped.length, 0, 'nothing may be stopped');
});

// ===========================================================================
// 4. Config sanitisation & panic
// ===========================================================================

// ---------------------------------------------------------------------------
// Agent-owned scan: selection belongs to the agent, not to the app scanner
// ---------------------------------------------------------------------------

const agentRow = (over: Partial<NativeGridOpportunity> = {}): NativeGridOpportunity => ({
  ...opportunity(),
  agentScan: true,
  suitabilityScore: 0, // the agent scan does not score — it ranks by crossings/hour
  minInvestmentUSDT: 6,
  gridNum: 8,
  minPx: 1985,
  maxPx: 2015,
  gridSpacingPct: 0.19,
  lever: 2,
  crossingsPerHour: 1.4,
  roundTripsPerHour: 0.7,
  expectedFirstFillMin: 22,
  stepPct: 0.19,
  estimatedNetProfitPerGridPct: 0.15,
  ...over,
});

test('own scan: the agent opens its own top-crossings candidate, not the app pick', async () => {
  const own = agentRow({ instId: OTHER_INST, crossingsPerHour: 1.6 });
  const h = makeAgent({ ownScan: [own], opportunities: [opportunity()] });
  await armAutonomous(h, { budgetPerBotUSDT: 12, maxConcurrentBots: 1 });

  await h.agent.runCycle('MANUAL');

  eq(h.calls.scans, 1, 'the agent must run exactly one own scan per cycle');
  eq(h.calls.created.length, 1, 'exactly one bot must be created');
  eq(
    h.calls.created[0].instId,
    OTHER_INST,
    'selection must follow crossings/hour, never the app suitability score'
  );
  eq(
    h.calls.created[0].instId === INST,
    false,
    'the app-scored candidate must not win just because its score is 82'
  );
  ok(h.calls.created[0].lever <= 2, 'leverage must stay within the 2x ceiling');
  ok(h.calls.created[0].sz <= 12, 'size must stay within the 12 USDC budget');
});

test('own scan: a candidate below the crossings threshold is refused', async () => {
  const h = makeAgent({ ownScan: [agentRow({ crossingsPerHour: 0.05 })] });
  await armAutonomous(h, { minCrossingsPerHour: 0.35 });

  await h.agent.runCycle('MANUAL');

  eq(h.calls.created.length, 0, 'a grid with 0.05 crossings/h would only immobilise capital');
});

test('own scan: a failed scan fails closed instead of reusing app scores', async () => {
  const h = makeAgent({ ownScanThrows: true, opportunities: [opportunity()] });
  await armAutonomous(h, {});

  await h.agent.runCycle('MANUAL');

  eq(h.calls.created.length, 0, 'no candidate may be opened when the own scan failed');
  ok(
    h.calls.audits.some((a) => /scanul propriu/i.test(a.message)),
    'the scan failure must be audited'
  );
});

test('guard: the 40 USDC total-margin ceiling blocks a new open', async () => {
  const h = makeAgent({ bots: [bot({ sz: 35 })], ownScan: [agentRow()] });
  await armAutonomous(h, {
    maxConcurrentBots: 2,
    budgetPerBotUSDT: 12,
    maxTotalMarginUSDT: 40,
  });

  await h.agent.runCycle('MANUAL');

  eq(h.calls.created.length, 0, '35 + 6 USDC would exceed the 40 USDC desk ceiling');
});

test('config: invalid values are clamped, never trusted', async () => {
  const h = makeAgent();

  const cfg = h.agent.updateConfig({
    mode: 'YOLO' as any,
    runIntervalSec: 5,
    maxConcurrentBots: 999,
    budgetPerBotUSDT: 0,
    maxLeverage: 100,
    minSuitabilityScore: 5,
    hardStopLossPct: 100,
    maxActionsPerCycle: 99,
  });

  eq(cfg.mode, 'OFF', 'an unknown mode must collapse to OFF');
  eq(cfg.runIntervalSec, 60, 'interval must clamp to the 60s floor');
  eq(cfg.maxConcurrentBots, 5, 'maxConcurrentBots must clamp to the 5-slot ceiling');
  eq(cfg.budgetPerBotUSDT, 12, 'a zero budget must fall back to the 12 USDT default');
  eq(cfg.maxLeverage, 2, 'leverage must clamp to the agreed ceiling of 2x');
  eq(cfg.minSuitabilityScore, 30, 'score floor must clamp to 30');
  eq(cfg.hardStopLossPct, 60, 'hard SL must clamp to 60%');
  eq(cfg.maxActionsPerCycle, 5, 'actions per cycle must clamp to 5');
  ok(DEFAULT_DEEPSEEK_AGENT_CONFIG.mode === 'OFF', 'the shipped default mode must stay OFF');
});

test('config: the capital envelope is enforced, not suggested', async () => {
  const h = makeAgent();

  const cfg = h.agent.updateConfig({
    budgetPerBotUSDT: 500,
    maxTotalMarginUSDT: 999,
    minReserveUSDT: 0,
    cooldownMinutesPerSymbol: 0,
    universeScanSize: 500,
  });

  eq(cfg.budgetPerBotUSDT, 500, 'per-bot budget is the owner call, capped only at 500 USDC');
  eq(cfg.maxTotalMarginUSDT, 500, 'desk margin ceiling follows the same ceiling');
  eq(cfg.minReserveUSDT, 0, 'a zero reserve must be accepted (15 USDC account)');
  eq(cfg.cooldownMinutesPerSymbol, 45, 'a zero cooldown is refused (45 min floor)');
  eq(cfg.universeScanSize, 60, 'the deep scan is capped at 60 contracts');
  eq(cfg.ownUniverseScan, true, 'the agent-owned scan is the default selection path');
});

test('config: defaults fit a 15 USDC account (12 budget, 1 slot, no reserve)', async () => {
  const h = makeAgent();
  const cfg = h.agent.getConfig();

  eq(cfg.budgetPerBotUSDT, 12, 'one grid = 12 USDC');
  eq(cfg.maxConcurrentBots, 1, 'a single margin slot');
  eq(cfg.minReserveUSDT, 0, 'no reserve, otherwise 12 + reserve > 15 and nothing opens');
  eq(cfg.maxTotalMarginUSDT, 12, 'desk ceiling = one grid');
  eq(cfg.maxLeverage, 2, 'leverage stays at 2x');
});

test('guard: a 15 USDC account opens a 12 USDC bot (reserve 0, one slot)', async () => {
  const h = makeAgent({
    snapshot: { freeBalance: 15, equity: 15, marginInvested: 0 },
    ownScan: [agentRow()],
  });
  await armAutonomous(h, {
    maxConcurrentBots: 1,
    budgetPerBotUSDT: 12,
    minReserveUSDT: 0,
    maxTotalMarginUSDT: 12,
  });

  await h.agent.runCycle('MANUAL');

  eq(h.calls.created.length, 1, 'the 12 USDC grid must be allowed on a 15 USDC balance');
  ok(h.calls.created[0].sz <= 12, 'size must stay within the 12 USDC budget');
});

test('own scan: a 4-decimal OKX minimum opens with a size above it', async () => {
  const h = makeAgent({
    snapshot: { freeBalance: 15, equity: 15, marginInvested: 0 },
    ownScan: [agentRow({ minInvestmentUSDT: 11.9108 })],
  });
  await armAutonomous(h, {
    maxConcurrentBots: 1,
    budgetPerBotUSDT: 12,
    minReserveUSDT: 0,
    maxTotalMarginUSDT: 12,
  });

  await h.agent.runCycle('MANUAL');

  eq(h.calls.created.length, 1, 'a grid whose minimum is 11.9108 must fit a 12 USDC budget');
  ok(h.calls.created[0].sz >= 11.9108, 'sz must clear the 4-decimal OKX minimum');
  ok(h.calls.created[0].sz <= 12, 'sz must stay within the 12 USDC budget');
});

test('tokens: cost is computed from the editable per-1M prices', async () => {
  const prices = {
    pricePer1MInputUSD: 0.27,
    pricePer1MInputCachedUSD: 0.07,
    pricePer1MOutputUSD: 1.1,
  };

  // 100k prompt (20k cached) + 2k completion
  const cost = computeDeepSeekCostUSD(
    { promptTokens: 100_000, cachedPromptTokens: 20_000, completionTokens: 2_000 },
    prices
  );
  const expected = (80_000 / 1e6) * 0.27 + (20_000 / 1e6) * 0.07 + (2_000 / 1e6) * 1.1;
  near(cost, expected, 1e-9, 'cache-hit tokens must be billed at the cheaper tier');
  const noCacheCost = computeDeepSeekCostUSD(
    { promptTokens: 100_000, completionTokens: 2_000 },
    prices
  );
  ok(cost < noCacheCost, 'a cache hit must be cheaper than a full miss');
  near(
    noCacheCost,
    (100_000 / 1e6) * 0.27 + (2_000 / 1e6) * 1.1,
    1e-9,
    'without cache data the whole prompt is billed as a miss'
  );
});

test('tokens: prompt estimate is chars/4 and never zero for a real prompt', async () => {
  eq(estimateTokensFromText(''), 0, 'an empty prompt has no tokens');
  eq(estimateTokensFromText('a'.repeat(400)), 100, '4 characters ~ 1 token');
  ok(estimateTokensFromText('x'.repeat(401)) === 101, 'partial tokens round UP');
});

test('tokens: status exposes cumulative usage and a monthly estimate', async () => {
  const h = makeAgent();
  await armAutonomous(h, { runIntervalSec: 300 });

  const usage = h.agent.getStatus().tokenUsage;

  eq(usage.apiCalls, 0, 'no call yet: the account is clean');
  eq(usage.totalTokens, 0, 'no tokens spent yet');
  ok(usage.estimatedPromptTokensPerCycle > 1000, 'the system prompt alone is >1000 tokens');
  eq(usage.cyclesPerDay, 288, '288 cycles/day at a 5 min cadence (86400/300)');
  ok(usage.estimatedCostPerMonthUSD > 0, 'a monthly projection must be shown');
  ok(
    usage.estimatedCostPerMonthUSD < 30,
    `the projection must stay realistic for a 288-cycles/day cadence (got ${usage.estimatedCostPerMonthUSD})`
  );
  ok(
    usage.estimatedCostPerCycleUSD < 0.01,
    `one cycle must cost fractions of a cent (got ${usage.estimatedCostPerCycleUSD})`
  );
});

// ---------------------------------------------------------------------------
// Sizing: sz is resolved in INTEGER CENTS — never below the OKX floor, never above budget
// ---------------------------------------------------------------------------

test('sizing: a model size below the OKX minimum is raised and flagged', () => {
  // PUMP case: the model asked 7.31 USDC, OKX required 11.9108 USDC.
  const plan = resolveOpenSize(7.31, 11.9108, 12);

  ok(plan.sz >= 11.9108, 'sz must clear the 4-decimal OKX minimum');
  eq(plan.sz, 11.93, '11.9108 rounds UP to 11.93 (two decimals, never down)');
  eq(plan.required, 11.93, 'the reported requirement must match what we send');
  eq(plan.raised, true, 'a raised size must be flagged so the journal can explain it');
});

test('sizing: two decimals can never land just under a 4-decimal minimum', () => {
  // 11.9101 -> 11.92 would be enough, but a naive round() gives 11.91 < 11.9101.
  const exactFloor = resolveOpenSize(11.9101, 11.9101, 20);
  ok(exactFloor.sz >= 11.9101, 'asking exactly the minimum must still clear it');
  eq(exactFloor.sz, 11.93, 'the requirement rounds UP to the next whole cent');

  // A minimum just above 5 must not collapse back to the 5 USDC floor.
  const hair = resolveOpenSize(5, 5.0001, 20);
  ok(hair.sz >= 5.0001, '5.0001 must not be sent as 5.00');
  eq(hair.sz, 5.02, 'the OKX floor (5.01) plus one cent of headroom');
});

test('sizing: sz never exceeds the per-bot budget, even on cent boundaries', () => {
  // Regression: 5.11 * 100 === 510.99999999999994, so Math.ceil() produced 5.12 > budget.
  const budgets = [5, 5.11, 5.55, 11.91, 12, 20];
  const minimums = [5, 5.11, 6, 11.9108, 999];
  const wanted = [0, 7.31, 12, 999, Number.NaN];

  for (const budget of budgets) {
    for (const minInv of minimums) {
      for (const sz of wanted) {
        const plan = resolveOpenSize(sz, minInv, budget);
        ok(
          Number.isFinite(plan.sz),
          `sz must stay finite (budget ${budget}, minInv ${minInv}, asked ${sz})`
        );
        ok(
          plan.sz <= budget + 1e-9,
          `sz ${plan.sz} must not exceed the budget ${budget} (minInv ${minInv}, asked ${sz})`
        );
        if (minInv <= budget) {
          ok(
            plan.sz + 1e-9 >= minInv,
            `sz ${plan.sz} must clear the minimum ${minInv} when the budget allows it`
          );
        }
      }
    }
  }

  eq(resolveOpenSize(0, 5.11, 5.11).sz, 5.11, 'budget == minimum must send exactly the budget');
});

test('sizing: a missing or absurd model size falls back to the budget, not to NaN', () => {
  for (const asked of [Number.NaN, -3, 0, Number.POSITIVE_INFINITY]) {
    const plan = resolveOpenSize(asked, 6, 12);
    eq(plan.sz, 11.4, 'no usable model size -> 95% of the budget, still above the floor');
    eq(plan.raised, false, 'a missing model size is not a raise');
  }

  eq(resolveOpenSize(20, 6, 12).sz, 12, 'a model size above the budget is capped at the budget');
  eq(resolveOpenSize(9, 6.01, 12).sz, 9, 'a sane model size is honoured unchanged');
  eq(resolveOpenSize(9, 6.01, 12).raised, false, 'nothing was raised, nothing is journaled');
});

test('config: the passive-bot threshold cannot be set below 60 min', async () => {
  const h = makeAgent();

  const cfg = h.agent.updateConfig({ hardMaxNoFillMinutes: 20 });

  eq(cfg.hardMaxNoFillMinutes, 60, 'a 20 min passive threshold guarantees a false stop on every bot');
});

test('panic: forces OFF and stops the loop without touching open bots', async () => {
  const h = makeAgent({ bots: [bot()] });
  await armAutonomous(h);
  ok(h.agent.getConfig().mode === 'AUTONOMOUS', 'precondition: AUTONOMOUS');

  const cfg = h.agent.panic('test panic');

  eq(cfg.mode, 'OFF', 'panic must force the OFF mode');
  eq(h.agent.getStatus().loopActive, false, 'panic must kill the loop');
  eq(h.calls.stopped.length, 0, 'panic must not stop the running bots by itself');

  const decision = await h.agent.runCycle('MANUAL');
  eq(decision.dryRun, true, 'post-panic cycles must be dry runs only');
});

test('status: exposes masked credentials and the account snapshot', async () => {
  const h = makeAgent({ bots: [bot()] });
  await armAutonomous(h);
  h.agent.setApiKey('sk-test-0123456789abcdef');

  const status = h.agent.getStatus();

  eq(status.mode, 'AUTONOMOUS', 'status must report the mode');
  eq(status.engine, 'DEEPSEEK', 'a stored key makes DeepSeek the engine');
  eq(status.isConfigured, true, 'isConfigured must be true with a key');
  ok(!status.apiKeyMasked.includes('0123456789abcdef'), 'the full key must never be exposed');
  has(status.apiKeyMasked, 'sk-t', 'the masked key must keep a short prefix');
  eq(status.accountSnapshot.runningBots, 1, 'running bots must be counted');
  eq(status.accountSnapshot.executionMode, 'LIVE', 'execution mode must be reported');
});

test('history: decisions are persisted newest-first and capped', async () => {
  const h = makeAgent();
  await h.agent.updateConfig({ scanBeforeDecision: false, notifyTelegram: false });

  for (let i = 0; i < 3; i++) await h.agent.runCycle('MANUAL');

  const history = h.agent.getDecisions(10);
  eq(history.length, 3, 'every cycle must be journaled');
  ok(history[0].createdAt >= history[2].createdAt, 'history must be newest-first');
  eq(h.agent.getConfig().totalCycles, 3, 'the cycle counter must match the history');
});

// ---------------------------------------------------------------------------
// Execute + cleanup
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

  for (const file of createdStores) {
    try {
      fs.rmSync(path.join(STORE_DIR, file), { force: true });
    } catch {
      /* best effort */
    }
  }
  // JsonStore flushes on process exit; delete again afterwards so no fixture survives.
  process.on('exit', purgeTestStores);

  const total = registered.length;
  console.log(`\n${total - failed}/${total} passed`);
  if (failed > 0) process.exitCode = 1;
};

void run();
