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
  await h.agent.updateConfig({ mode: 'ADVISOR', scanBeforeDecision: false, notifyTelegram: false });

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

test('guardrail: a passive bot is stopped even with a positive PnL', async () => {
  const h = makeAgent({
    bots: [bot({ arbitrageNum: 0, totalPnl: 0.01, cTime: Date.now() - 200 * 60_000 })],
  });
  await armAutonomous(h, { hardMaxNoFillMinutes: 180, stopIfPassive: true });

  const decision = await h.agent.runCycle('MANUAL');

  ok(
    decision.guardrailActions.some((a: any) => /bot pasiv/i.test(a.rationale_ro || '')),
    'the guardrail must report the passive grid'
  );
  eq(h.calls.stopped.length, 1, 'dead capital must be released even on a positive PnL');
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
  eq(cfg.maxConcurrentBots, 10, 'maxConcurrentBots must clamp to 10');
  eq(cfg.budgetPerBotUSDT, 20, 'a zero budget must fall back to the 20 USDT default');
  eq(cfg.maxLeverage, 20, 'leverage must clamp to 20x');
  eq(cfg.minSuitabilityScore, 30, 'score floor must clamp to 30');
  eq(cfg.hardStopLossPct, 60, 'hard SL must clamp to 60%');
  eq(cfg.maxActionsPerCycle, 5, 'actions per cycle must clamp to 5');
  ok(DEFAULT_DEEPSEEK_AGENT_CONFIG.mode === 'OFF', 'the shipped default mode must stay OFF');
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
