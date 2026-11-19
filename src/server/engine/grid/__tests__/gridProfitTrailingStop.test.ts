/**
 * Regression suite for the PROFIT TRAILING STOP on the AUTO-LIMIT path.
 *
 * `gridProfitGuard.test.ts` covers the pure band (`assessProfitGiveback`). This suite covers what
 * was built on top of it and can only be tested one level up:
 *
 *   1. `GridRiskManager.evaluateLiveBotRisk()` — the rule is wired, it fires BEFORE the loss stop,
 *      and its reason string names the peak, the peak in USD and the floor actually used.
 *   2. `assessProfitTrailingStop()` — the profit lock (`max(peak - band, profitLockPct)`), including
 *      the fact that a lock can only ever tighten what the band already protects.
 *   3. `NeutralGridEngine` — `PROFIT_TRAILING_STOP` is mapped to `TAKE_PROFIT_HIT` (a stop on
 *      banked profit is not a loss), and a reduce-only level is never dropped from the live window
 *      because of the opening budget.
 *
 * The HYPE numbers are the case that started this work: `grid_hype_mwmnij6v` peaked at +4.7%
 * (+0.94 USD on 20 USDT of margin), gave the whole gain back and exited at -9.93% (-1.99 USD).
 * Its loss stop sat at 9.72%, so the desk was told "stop loss" for a bot whose real failure was
 * handing back the profit first.
 *
 * NO network, NO exchange, NO `.data/`: the adapter and the journal are stubs, and the engine reads
 * only what those stubs answer.
 *
 * Run: npm test
 */

import { GridRiskManager } from '../GridRiskManager';
import {
  assessProfitGiveback,
  assessProfitTrailingStop,
  resolveTrailingFloorPct,
} from '../gridProfitGuard';
import { NeutralGridEngine } from '../NeutralGridEngine';
import type { GridJournal } from '../GridJournal';
import type { IExecutionAdapter } from '../../../exchange/IExecutionAdapter';
import type {
  GridBotInstance,
  GridLevelState,
  GridRiskConfig,
  MartingaleConfig,
} from '../../../../shared/types';

// ---------------------------------------------------------------------------
// Runner & assertions (same shape as the rest of the suite)
// ---------------------------------------------------------------------------
const tests: { name: string; fn: () => void | Promise<void> }[] = [];
const test = (name: string, fn: () => void | Promise<void>): void => {
  tests.push({ name, fn });
};

const ok = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(msg);
};
const eq = (actual: unknown, expected: unknown, msg: string): void => {
  if (actual !== expected) {
    throw new Error(`${msg} (expected ${String(expected)}, got ${String(actual)})`);
  }
};
const near = (actual: number, expected: number, tol: number, msg: string): void => {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > tol) {
    throw new Error(`${msg} (expected ~${expected}, got ${actual})`);
  }
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const SYMBOL = 'HYPE-USD_UM_XPERP-310523';

const MART_OFF: MartingaleConfig = {
  enabled: false,
  sizeMultiplier: 1,
  maxMultiplierSteps: 5,
  maxExposureUSDT: 0,
};

/** `grid_hype_mwmnij6v`: 20 USDT margin, 2x, band 61.802 - 74.623, loss stop 9.72%. */
const makeBot = (
  over: Partial<GridBotInstance> = {},
  riskOver: Partial<GridRiskConfig> = {}
): GridBotInstance => ({
  botId: 'grid_hype_mwmnij6v',
  symbol: SYMBOL,
  platform: 'OKX_EEA',
  executionMode: 'LIVE',
  status: 'RUNNING',
  config: {
    symbol: SYMBOL,
    platform: 'OKX_EEA',
    mode: 'AUTO',
    lowerPrice: 61.802,
    upperPrice: 74.623,
    gridCount: 20,
    gridType: 'ARITHMETIC',
    marginInvestedUSDT: 20,
    leverage: 2,
    marginMode: 'cross',
    martingale: MART_OFF,
    risk: {
      stopLossPct: 9.72,
      takeProfitPct: 15,
      stopOnRangeBreakout: true,
      maxMarginUsagePct: 90,
      maxActiveGridBots: 100,
      ...riskOver,
    },
  },
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  initialCenterPrice: 69.931,
  currentPrice: 69.931,
  gridSpacingUSDT: 0.6,
  gridSpacingPct: 0.86,
  estimatedProfitPerGridPct: 0.82,
  estimatedLiquidationPriceLong: 55.4,
  estimatedLiquidationPriceShort: 84.2,
  lowerStopPrice: 61.802,
  upperStopPrice: 74.623,
  levels: [],
  totalNotionalUSDT: 40,
  netPositionContracts: 0,
  netPositionSide: 'FLAT',
  avgHoldPrice: 69.931,
  gridCaptureUSDT: 0,
  exitCostUSDT: 0,
  gridProfitUSDT: 0,
  floatingPnlUSDT: 0,
  totalFeesUSDT: 0,
  fundingEstimateUSDT: 0,
  totalNetPnlUSDT: 0,
  totalNetPnlPct: 0,
  completedArbitrages: 0,
  activeBuyOrders: 0,
  activeSellOrders: 0,
  ...over,
});

/** New-bot defaults written by `NeutralGridEngine.createAndStartBot()`. */
const NEW_BOT_RISK: Partial<GridRiskConfig> = { profitGivebackRatio: 0.25, profitLockPct: 2.5 };

/** The bot at the moment it was stopped: peak +4.7% (+0.94 USD), now -9.93% (-1.99 USD). */
const hypeAtStop = (riskOver: Partial<GridRiskConfig> = NEW_BOT_RISK) =>
  makeBot(
    {
      totalNetPnlUSDT: -1.99,
      totalNetPnlPct: -9.93,
      peakTotalPnlPct: 4.7,
      peakTotalPnlAt: 1_700_003_600_000,
      netPositionContracts: 15,
      netPositionSide: 'LONG',
      avgHoldPrice: 71.2,
    },
    riskOver
  );

const level = (
  index: number,
  price: number,
  side: 'Buy' | 'Sell',
  notionalUSDT = 10
): GridLevelState => ({
  index,
  price,
  side,
  qtyContracts: 1,
  notionalUSDT,
  martingaleWeight: 1,
  status: 'OPEN_ORDER',
  fillCount: 0,
  realizedGridProfitUSDT: 0,
});

/** Engine with stubbed I/O: no exchange, no journal file, nothing under `.data/` is touched. */
const makeEngine = (bots: GridBotInstance[] = []) => {
  const audits: string[] = [];

  const journal = {
    getBots: () => bots,
    getArbitrages: () => [],
    saveBots: () => {},
    logAudit: (_type: string, message: string) => {
      audits.push(message);
    },
    recordOrder: () => {},
    recordArbitrage: () => {},
    getFilledOrdersByBot: () => [],
  };

  const adapter = {
    normalizeSymbol: (s: string) => s,
    getInstrumentFilter: async (symbol: string) => ({
      symbol,
      minOrderQty: 1,
      maxOrderQty: 100_000,
      qtyStep: 1,
      minNotionalValue: 0,
      tickSize: 0.01,
      ctVal: 1,
    }),
  };

  const engine = new NeutralGridEngine(
    adapter as unknown as IExecutionAdapter,
    journal as unknown as GridJournal
  );
  return { engine, audits };
};

/** `computeTargetLiveWindow` is private: the window is behaviour, so it is tested as behaviour. */
const windowOf = (engine: NeutralGridEngine, bot: GridBotInstance): GridLevelState[] =>
  (engine as unknown as { computeTargetLiveWindow(b: GridBotInstance): GridLevelState[] })
    .computeTargetLiveWindow(bot);

// ===========================================================================
// 1. The rule is wired into evaluateLiveBotRisk, and it fires first
// ===========================================================================

test('hype: a +4.7% peak sitting at -9.93% is a PROFIT TRAILING stop, not a plain stop loss', () => {
  const risk = GridRiskManager.evaluateLiveBotRisk(hypeAtStop(), 69.931);

  eq(risk.action, 'PROFIT_TRAILING_STOP', 'the bot must be classified by what it gave back');
  ok(risk.reason, 'a stop must always explain itself');
});

test('hype: the verdict names the peak, the peak in USD and the floor actually used', () => {
  const risk = GridRiskManager.evaluateLiveBotRisk(hypeAtStop(), 69.931);
  const reason = risk.reason || '';

  // 0.25 of a +4.7% peak is 1.175pp, but the 2pp min-band floor dominates -> floor = +2.7%.
  ok(reason.includes('vârf +4.70%'), `the peak must be named in % (got: ${reason})`);
  ok(reason.includes('($0.94)'), `the peak must be named in USD: 4.7% of 20 USDT (got: ${reason})`);
  ok(reason.includes('acum -9.93%'), `the current return must be named (got: ${reason})`);
  ok(reason.includes('prag +2.70%'), `the floor actually used must be named (got: ${reason})`);
  ok(reason.includes('banda 2.00pp'), `the basis must be named: the band here, not the lock (got: ${reason})`);
});

test('ordering: the same loss on a bot that never armed is still a STOP_LOSS', () => {
  // Peak +2.5% < armPct 3 -> the trailing guard is disarmed, so nothing else changed for it.
  const bot = hypeAtStop({ ...NEW_BOT_RISK });
  bot.peakTotalPnlPct = 2.5;

  const risk = GridRiskManager.evaluateLiveBotRisk(bot, 69.931);
  eq(risk.action, 'STOP_LOSS', 'a bot that never earned 3% must fall through to the loss stop');
});

test('ordering: a winning bot that gives the gain back never reports a loss stop', () => {
  // -9.93% is also past the 9.72% loss stop: both rules COULD fire, and the trailing one must win.
  const bot = hypeAtStop();
  ok(
    Math.abs(bot.totalNetPnlPct) >= bot.config.risk.stopLossPct,
    'fixture must sit past the loss stop too, otherwise it proves nothing'
  );

  eq(GridRiskManager.evaluateLiveBotRisk(bot, 69.931).action, 'PROFIT_TRAILING_STOP', 'trailing wins');
});

test('hype: an intact bot at its peak is not stopped by the trailing rule', () => {
  const bot = hypeAtStop();
  bot.totalNetPnlPct = 4.7;
  bot.totalNetPnlUSDT = 0.94;

  eq(GridRiskManager.evaluateLiveBotRisk(bot, 69.931).action, 'NONE', 'a bot at its high-water mark holds');
});

test('guard: at the arming peak the tolerance is the full 2pp — a 0.5pp scalp stop is a bug', () => {
  // Regression for the interaction found in review: armPct 3 + lock 2.5 left 0.5pp of room, so a
  // bot that had just armed at +3.0% was stopped by 0.25% of price (2x) or by the float swing of
  // one fill. The lock is capped at `peak - minBandPct`, so the floor at a 3.0% peak is +1.0%.
  const bot = hypeAtStop();
  bot.peakTotalPnlPct = 3.0;
  bot.totalNetPnlPct = 2.6;
  bot.totalNetPnlUSDT = 0.52;

  eq(
    GridRiskManager.evaluateLiveBotRisk(bot, 69.931).action,
    'NONE',
    'peak +3.0% = floor +1.0%, so -0.4pp inside the band must hold'
  );

  bot.totalNetPnlPct = 0.99;
  eq(
    GridRiskManager.evaluateLiveBotRisk(bot, 69.931).action,
    'PROFIT_TRAILING_STOP',
    'below the +1.0% band floor it must still stop - as profit, not as a loss'
  );
});

test('guard: a stopped bot is never evaluated, whatever its peak says', () => {
  const bot = hypeAtStop();
  bot.status = 'TAKE_PROFIT_HIT';

  eq(GridRiskManager.evaluateLiveBotRisk(bot, 69.931).action, 'NONE', 'only RUNNING bots are watched');
});

// ===========================================================================
// 2. The profit lock: two protections, one floor, it only ever tightens
// ===========================================================================

test('floor: on a small peak the proportional band is what applies', () => {
  const r = resolveTrailingFloorPct({ peakPct: 5, ratio: 0.25, minBandPct: 2, lockPct: 2.5 });

  near(r.bandFloorPct, 3, 1e-9, '5 - max(1.25, 2) = +3%');
  near(r.floorPct, 3, 1e-9, 'the band floor is above the 2.5 lock, so the band is used');
  eq(r.locked, true, 'the lock is configured');
});

test('floor: a lock above the band cannot shave the min band — it is capped at peak - minBand', () => {
  const r = resolveTrailingFloorPct({ peakPct: 6, ratio: 0.25, minBandPct: 2, lockPct: 4.5 });

  near(r.bandFloorPct, 4, 1e-9, '6 - max(1.5, 2) = +4%');
  near(r.lockFloorPct, 4, 1e-9, 'min(4.5, 6 - 2) = +4%: the cap, not the raw 4.5');
  near(r.floorPct, 4, 1e-9, 'the band still sets the floor, so the tolerance stays 2pp');
});

test('floor: the lock can raise the floor but never lower it, and never below the min band', () => {
  for (let peak = 3; peak <= 20; peak += 0.5) {
    const band = resolveTrailingFloorPct({ peakPct: peak, ratio: 0.25, minBandPct: 2 });
    const locked = resolveTrailingFloorPct({ peakPct: peak, ratio: 0.25, minBandPct: 2, lockPct: 2.5 });

    ok(locked.floorPct >= band.floorPct - 1e-9, `peak ${peak}: the lock loosened the floor`);
    ok(peak - locked.floorPct >= 2 - 1e-9, `peak ${peak}: the tolerance fell below the 2pp min band`);
  }
});

test('floor: peak 12 -> band floor +9, which the 2.5 lock cannot lower', () => {
  const r = resolveTrailingFloorPct({ peakPct: 12, ratio: 0.25, minBandPct: 2, lockPct: 2.5 });
  near(r.floorPct, 9, 1e-9, '12 - max(3, 2) = +9%');
});

test('lock: 0 and undefined both mean "off", and then it is exactly the giveback guard', () => {
  for (const lockPct of [0, undefined]) {
    for (const peakPct of [3, 4.7, 5.8, 12]) {
      const base = assessProfitGiveback({ peakPct, currentPct: peakPct - 3, ratio: 0.25 });
      const trailed = assessProfitTrailingStop({
        peakPct,
        currentPct: peakPct - 3,
        ratio: 0.25,
        lockPct,
      });

      near(trailed.floorPct, base.floorPct, 1e-9, `peak ${peakPct}: the floor must not move`);
      eq(trailed.triggered, base.triggered, `peak ${peakPct}: the verdict must not move`);
      eq(trailed.lockBinding, false, `peak ${peakPct}: a disabled lock never binds`);
    }
  }
});

test('lock: a disarmed guard stays disarmed, however high the lock is', () => {
  const r = assessProfitTrailingStop({ peakPct: 2.9, currentPct: -20, lockPct: 5 });

  eq(r.armed, false, 'peak 2.9 < armPct 3');
  eq(r.triggered, false, 'an armed-only lock must not stop a bot that never earned 3%');
  near(r.floorPct, 0, 1e-9, 'a disarmed assessment reports no floor to act on');
});

test('lock: the reported band always adds up to peak minus floor', () => {
  for (const peakPct of [3, 4.7, 6, 9, 15]) {
    const r = assessProfitTrailingStop({ peakPct, currentPct: 0, ratio: 0.25, lockPct: 2.5 });
    near(r.bandPct, r.peakPct - r.floorPct, 1e-9, `peak ${peakPct}: band must equal peak - floor`);
  }
});

test('lock: on a +4.7% peak it costs nothing — the band is already tighter', () => {
  const r = assessProfitTrailingStop({ peakPct: 4.7, currentPct: 4.7, ratio: 0.25, lockPct: 2.5 });

  eq(r.lockBinding, false, '2.5 < 2.7, so the band binds');
  near(r.floorPct, 2.7, 1e-9, 'floor = max(4.7 - 2, 2.5) = +2.7%');
});

test('lock: it binds only when minBandPct is lowered below it — the cap makes it explicit', () => {
  // With the default 2pp min band the lock can never bind (the two describe the same safeguard).
  const capped = assessProfitTrailingStop({
    peakPct: 3,
    currentPct: 2.1,
    ratio: 0.25,
    minBandPct: 2,
    lockPct: 2.5,
  });
  eq(capped.lockBinding, false, 'min band 2 wins: floor +1.0, tolerance 2pp');
  eq(capped.triggered, false, '+2.1% is above the +1.0% floor');

  // An owner who really wants the absolute floor lowers the band minimum and owns the squeeze.
  const binding = assessProfitTrailingStop({
    peakPct: 3,
    currentPct: 2.1,
    ratio: 0.25,
    minBandPct: 0,
    lockPct: 2.5,
  });
  eq(binding.lockBinding, true, 'min band 0 lets the 2.5 lock set the floor');
  near(binding.floorPct, 2.5, 1e-9, 'floor = min(2.5, 3 - 0) = +2.5%');
  eq(binding.triggered, true, '+2.1% is below the +2.5% lock');
});

// ===========================================================================
// 3. The engine: status mapping and the reduce-only live window
// ===========================================================================

const windowBot = (over: Partial<GridBotInstance> = {}): GridBotInstance => {
  // 20 USDT at 2x = 40 notional, 92% of it = 36.8 USDT of opening budget.
  const bot = makeBot({
    executionMode: 'LIVE',
    currentPrice: 100,
    levels: [
      level(0, 99, 'Buy'),
      level(1, 94, 'Buy'),
      level(2, 98, 'Buy'),
      level(3, 95, 'Buy'),
      level(4, 97, 'Buy'),
      level(5, 96, 'Buy'),
      level(6, 101, 'Sell'),
      level(7, 106, 'Sell'),
      level(8, 102, 'Sell'),
      level(9, 105, 'Sell'),
      level(10, 103, 'Sell'),
      level(11, 104, 'Sell'),
    ],
    ...over,
  });
  return bot;
};

const BUDGET = 20 * 2 * 0.92;

test('window: a long bot keeps its reduce-only Sells even when the opening budget is spent', () => {
  const { engine } = makeEngine();
  const bot = windowBot({ netPositionContracts: 15, netPositionSide: 'LONG' });
  const win = windowOf(engine, bot);

  const sells = win.filter((l) => l.side === 'Sell');
  const buys = win.filter((l) => l.side === 'Buy');

  eq(sells.length, 5, 'every free Sell that fits in the 8 slots must survive, not just the first batch');
  eq(buys.length, 3, 'the Buys stay capped by the budget (30 USDT of the 36.8 allowed)');
  eq(win.length, 8, 'the window fills up to the cap: the budget rejects openings, never free reductions');

  const openingNotional = buys.reduce((s, l) => s + l.notionalUSDT, 0);
  ok(openingNotional <= BUDGET, `opening notional ${openingNotional} must respect the budget`);

  const totalNotional = win.reduce((s, l) => s + l.notionalUSDT, 0);
  ok(
    totalNotional > BUDGET,
    `the window's raw notional (${totalNotional}) must exceed the budget — that is the Sells being free`
  );
});

test('window: the Sells that reduce inventory are exactly the ones the budget used to cut', () => {
  const { engine } = makeEngine();
  const long = windowBot({ netPositionContracts: 15, netPositionSide: 'LONG' });
  const flat = windowBot({ netPositionContracts: 0, netPositionSide: 'FLAT' });

  const longSells = windowOf(engine, long).filter((l) => l.side === 'Sell').length;
  const flatSells = windowOf(engine, flat).filter((l) => l.side === 'Sell').length;

  ok(longSells > flatSells, `long ${longSells} vs flat ${flatSells}: inventory must widen the Sell side`);
});

test('window: a short bot gets the same treatment on its Buys', () => {
  const { engine } = makeEngine();
  const bot = windowBot({ netPositionContracts: -15, netPositionSide: 'SHORT' });
  const win = windowOf(engine, bot);

  eq(win.filter((l) => l.side === 'Buy').length, 5, 'every free Buy that fits must survive, not just the first batch');
  eq(win.filter((l) => l.side === 'Sell').length, 3, 'the Sells stay capped by the budget');
  eq(win.length, 8, 'the cap is reached from the free side as well');
});

test('window: with flat inventory the budget still binds exactly as before', () => {
  const { engine } = makeEngine();
  const win = windowOf(engine, windowBot({ netPositionContracts: 0, netPositionSide: 'FLAT' }));

  eq(win.length, 3, 'no inventory -> no exemption: b99 + s101 + b98, then the budget stops it');
  ok(
    win.reduce((s, l) => s + l.notionalUSDT, 0) <= BUDGET,
    'a flat bot can never exceed the opening budget'
  );
});

test('window: the 8-level cap is unchanged, even for free levels', () => {
  const { engine } = makeEngine();
  const free = makeBot({
    currentPrice: 100,
    netPositionContracts: 15,
    netPositionSide: 'LONG',
    levels: [
      ...[99, 98, 97, 96, 95, 94, 93, 92].map((p, i) => level(i, p, 'Buy', 0)),
      ...[101, 102, 103, 104, 105, 106, 107, 108].map((p, i) => level(8 + i, p, 'Sell', 0)),
    ],
  });

  eq(windowOf(engine, free).length, 8, 'the live window is still capped at 8 orders');
});

test('engine: a trailing stop on a LIVE bot is reported as TAKE_PROFIT_HIT', async () => {
  const bot = hypeAtStop();
  bot.executionMode = 'PAPER'; // no exchange cleanup, no order placement: the status is the subject
  const { engine, audits } = makeEngine([bot]);

  await engine.onPriceTick(SYMBOL, bot.currentPrice);

  eq(bot.status, 'TAKE_PROFIT_HIT', 'a stop on banked profit must not be filed as a stop loss');
  ok(bot.stopReason && bot.stopReason.includes('vârf +4.70%'), 'the stop reason must survive on the row');
  ok(
    audits.some((m) => m.includes('TAKE_PROFIT_HIT')),
    'the audit line must carry the real status'
  );
});

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
const run = async (): Promise<void> => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ok    ${t.name}`);
    } catch (err: any) {
      failed++;
      console.error(`  FAIL  ${t.name}`);
      console.error(`        ${err?.message || err}`);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} grid-profit-trailing-stop tests passed`);
  if (failed > 0) process.exitCode = 1;
};

void run();
