/**
 * Unit & integration regression suite for TB5 BTC-USD UM X-PERP Signal & Read-Only Grid Monitor.
 *
 * Verifies:
 *  1. Strictly $1,000 range width (maxPx - minPx === 1000, minPx < price < maxPx), 10 grids ($100 step),
 *     and TP 5% / SL 2.5% of invested margin semantics.
 *  2. Honest empirical probability calibration vs explicit "Date insuficiente pentru probabilitate validată"
 *     when bars or matched directional samples are below minimum requirements.
 *  3. Read-only monitoring of ALL manual OKX native grid directions (LONG, SHORT, NEUTRAL) on BTC-USD UM X-PERP,
 *     filtering out non-BTC bots, and confirming zero mutating/order/stop/amend paths exist.
 *  4. Continuity workflow on confirmed bot closure: confirms terminal status via OKX details, updates closed
 *     bot history, immediately dispatches the valid next recommendation via Telegram without duplicates, and
 *     triggers fresh post-close analysis.
 *  5. Signal invalidation Telegram alert when price exits recommended band, plus `.data/` state persistence.
 *
 * Run: npm test
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  BtcXPerpSignalMonitor,
  BtcReadOnlyOkxPort,
  BtcTelegramPort,
  calibrateBtcHistoricalProbabilities,
  computeDynamicBtcGridRange,
  computeDynamicGridRangeForAsset,
  isBtcXPerpInstrument,
  isXPerpInstrumentForAsset,
} from '../BtcXPerpSignalMonitor';
import type { Kline } from '../../../../shared/types';

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

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'btc-xperp-signals-test-'));
}

/** Builds oscillating trending candles that naturally create both bullish and bearish directional setups. */
function makeOscillatingBtcKlines(count: number, basePrice = 88000): Kline[] {
  const out: Kline[] = [];
  const startTs = Date.UTC(2026, 10, 1, 0, 0, 0);
  let prevClose = basePrice;
  for (let i = 0; i < count; i++) {
    // Alternating macro swing cycles (~36 bars each) + realistic noise
    const wave = Math.sin(i / 6) * 900 + Math.cos(i / 11) * 600;
    const micro = Math.sin(i * 1.3) * 140;
    const close = Math.max(10000, basePrice + wave + micro);
    const open = prevClose;
    const high = Math.max(open, close) + 180 + Math.abs(Math.sin(i) * 160);
    const low = Math.min(open, close) - 180 - Math.abs(Math.cos(i) * 160);
    out.push({
      timestamp: startTs + i * 3600_000,
      open: parseFloat(open.toFixed(1)),
      high: parseFloat(high.toFixed(1)),
      low: parseFloat(low.toFixed(1)),
      close: parseFloat(close.toFixed(1)),
      volume: 1200 + Math.abs(Math.sin(i * 0.7)) * 800,
    });
    prevClose = close;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. Exact bot configuration ($1000 span, 10 grids, TP 5% / SL 2.5% margin)
// ---------------------------------------------------------------------------
test('config & range: enforces exact $1,000 range, 10 grids, and TP 5% / SL 2.5% invested margin', async () => {
  const dir = makeTempDir();
  try {
    const klines1h = makeOscillatingBtcKlines(180, 91200);
    const klines15m = makeOscillatingBtcKlines(120, 91400);
    const klines4h = makeOscillatingBtcKlines(80, 90800);
    const currentPx = klines15m[klines15m.length - 1].close;

    const okxPort: BtcReadOnlyOkxPort = {
      hasCredentials: () => false,
      isCredentialsPermanentlyFailed: () => false,
      resolveLiveInstrumentId: async () => 'BTC-USD_UM_XPERP-310530',
      getKlines: async (_sym, interval) =>
        interval === '15m' ? klines15m : interval === '4H' ? klines4h : klines1h,
      getTickerPrice: async () => currentPx,
      fetchMarketIntelligenceExtras: async () => ({
        openInterestUSD: 450_000_000,
        fundingRatePct: 0.012,
        nextFundingRatePct: 0.011,
        orderBookImbalance: 0.18,
        orderBookDepthUSD: 2_500_000,
        spreadBps: 1.2,
      }),
      getNativeContractGridBots: async () => [],
      getNativeContractGridDetails: async () => null,
    };

    const telegramSent: string[] = [];
    const tgPort: BtcTelegramPort = {
      isConfigured: () => true,
      isNotificationsEnabled: () => true,
      sendMessage: async (text) => {
        telegramSent.push(text);
        return true;
      },
    };

    const monitor = new BtcXPerpSignalMonitor(okxPort, { dataDir: dir, telegramPort: tgPort });
    const rec = await monitor.runMarketAnalysis('MANUAL');

    eq(rec.displayInstrument, 'BTC-USD UM X-PERP', 'display instrument matches spec');
    eq(rec.botType, 'OKX Native Futures Grid', 'bot type matches spec');
    eq(rec.gridNum, 10, 'must recommend 10 grids');
    eq(rec.gridStepUSD, 100, 'grid step must be $100');
    eq(rec.rangeSpanUSD, 1000, 'rangeSpanUSD must be $1,000');
    eq(rec.maxPx - rec.minPx, 1000, 'maxPx - minPx must equal exactly $1,000');
    ok(rec.minPx < currentPx && currentPx < rec.maxPx, 'current BTC price must sit inside recommended band');
    eq(rec.tpMarginPct, 5, 'TP must be 5% of invested margin');
    eq(rec.slMarginPct, 2.5, 'SL must be 2.5% of invested margin');
    eq(rec.tpSlBasis, 'INVESTED_MARGIN', 'TP/SL basis must explicitly be INVESTED_MARGIN');
    eq(rec.probabilityStatus, 'CALIBRATED', 'must empirically calibrate when >=100 bars and >=8 samples exist');
    ok(
      rec.longProbabilityPct !== null && rec.shortProbabilityPct !== null,
      'calibrated probabilities must be numeric percentages'
    );

    // Also test standalone computeDynamicBtcGridRange invariance across extremes
    const rLow = computeDynamicBtcGridRange({
      currentPrice: 64234.5,
      direction: 'LONG',
      atr1hUSD: 420,
      nearestSupport: { price: 64050, type: 'SUPPORT', distancePct: -0.29, touchCount: 3, strengthScore: 3 },
      nearestResistance: null,
    });
    eq(rLow.maxPx - rLow.minPx, 1000, 'dynamic range preserves exact $1,000 span near support');
    ok(rLow.minPx < 64234.5 && 64234.5 < rLow.maxPx, 'dynamic range encloses price');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. Honest insufficient-data handling (zero fabricated scores)
// ---------------------------------------------------------------------------
test('calibration: explicitly reports Date insuficiente pentru probabilitate validată when history is sparse', () => {
  const shortBars = makeOscillatingBtcKlines(40, 90000);
  const resShort = calibrateBtcHistoricalProbabilities(shortBars, 2.0);
  eq(resShort.status, 'INSUFFICIENT_DATA', '40 bars must yield INSUFFICIENT_DATA');
  eq(resShort.longProbabilityPct, null, 'must not fabricate LONG probability');
  eq(resShort.shortProbabilityPct, null, 'must not fabricate SHORT probability');
  ok(
    resShort.note.includes('Date insuficiente pentru probabilitate validată'),
    'must include exact Romanian insufficient-data notice'
  );

  // One-way strictly rising market yields 0 SHORT setups -> also INSUFFICIENT_DATA
  const oneWayBars: Kline[] = [];
  for (let i = 0; i < 140; i++) {
    const px = 80000 + i * 100;
    oneWayBars.push({
      timestamp: Date.UTC(2026, 9, 1) + i * 3600_000,
      open: px - 50,
      high: px + 60,
      low: px - 70,
      close: px,
      volume: 1000,
    });
  }
  const resOneWay = calibrateBtcHistoricalProbabilities(oneWayBars, 3.0);
  eq(resOneWay.status, 'INSUFFICIENT_DATA', 'missing counter-direction historical sample yields INSUFFICIENT_DATA');
  ok(
    resOneWay.note.includes('Date insuficiente pentru probabilitate validată'),
    'one-way sample notice explains missing validated probability'
  );
});

// ---------------------------------------------------------------------------
// 3. Strictly read-only monitoring (LONG/SHORT/NEUTRAL), closure & Telegram flow
// ---------------------------------------------------------------------------
test('monitor & continuity: tracks LONG/SHORT/NEUTRAL read-only, confirms close, sends valid next rec on Telegram', async () => {
  const dir = makeTempDir();
  try {
    const klines1h = makeOscillatingBtcKlines(180, 90000);
    const klines15m = makeOscillatingBtcKlines(120, 90100);
    const klines4h = makeOscillatingBtcKlines(80, 89900);
    let livePx = klines15m[klines15m.length - 1].close;

    let botClosed = false;
    const rawRunningBots = [
      {
        algoId: 'BTC_SHORT_1',
        instId: 'BTC-USD_UM_XPERP-310530',
        direction: 'short',
        state: 'running',
        minPx: String(Math.round(livePx - 500)),
        maxPx: String(Math.round(livePx + 500)),
        gridNum: '10',
        lever: '5',
        investment: '100',
        tpRatio: '0.05',
        slRatio: '0.025',
        gridProfit: '2.10',
        floatProfit: '0.40',
        totalPnl: '2.50',
        arbitrageNum: '4',
        cTime: String(Date.now() - 3600_000),
        uTime: String(Date.now()),
      },
      {
        algoId: 'BTC_NEUTRAL_2',
        instId: 'BTC-USD_UM_XPERP-310530',
        direction: 'neutral',
        state: 'running',
        minPx: String(Math.round(livePx - 400)),
        maxPx: String(Math.round(livePx + 600)),
        gridNum: '10',
        lever: '3',
        investment: '50',
        tpRatio: '0.05',
        slRatio: '0.025',
        gridProfit: '0.80',
        floatProfit: '-0.10',
        totalPnl: '0.70',
        arbitrageNum: '2',
        cTime: String(Date.now() - 1800_000),
        uTime: String(Date.now()),
      },
      // Non-BTC bot MUST be excluded by BTC monitor
      {
        algoId: 'ETH_LONG_9',
        instId: 'ETH-USD_UM_XPERP-310530',
        direction: 'long',
        state: 'running',
        minPx: '2900',
        maxPx: '3200',
        gridNum: '10',
        lever: '3',
        investment: '50',
        cTime: String(Date.now() - 1800_000),
        uTime: String(Date.now()),
      },
    ];

    const forbiddenCalls: string[] = [];
    const okxPort: BtcReadOnlyOkxPort = {
      hasCredentials: () => true,
      isCredentialsPermanentlyFailed: () => false,
      resolveLiveInstrumentId: async () => 'BTC-USD_UM_XPERP-310530',
      getKlines: async (_sym, interval) =>
        interval === '15m' ? klines15m : interval === '4H' ? klines4h : klines1h,
      getTickerPrice: async () => livePx,
      fetchMarketIntelligenceExtras: async () => ({
        openInterestUSD: 410_000_000,
        fundingRatePct: -0.008,
        nextFundingRatePct: -0.006,
        orderBookImbalance: 0.22,
        orderBookDepthUSD: 3_100_000,
        spreadBps: 1.0,
      }),
      getNativeContractGridBots: async (mode, _isDemo, includeAllDirections) => {
        ok(includeAllDirections === true, 'BTC monitor must request includeAllDirections=true');
        if (mode === 'pending') {
          return botClosed ? rawRunningBots.slice(1) : rawRunningBots;
        }
        return botClosed
          ? [
              {
                ...rawRunningBots[0],
                state: 'stopped',
                cancelType: '2',
                totalPnl: '5.10',
                gridProfit: '5.10',
                floatProfit: '0',
                uTime: String(Date.now()),
              },
            ]
          : [];
      },
      getNativeContractGridDetails: async (algoId) => {
        if (algoId === 'BTC_SHORT_1' && botClosed) {
          return {
            ...rawRunningBots[0],
            state: 'stopped',
            cancelType: '2',
            totalPnl: '5.10',
            gridProfit: '5.10',
            floatProfit: '0',
            uTime: String(Date.now()),
          };
        }
        return rawRunningBots.find((b) => b.algoId === algoId) || null;
      },
      // Guard: ensure no hidden write helpers exist on monitor port
      ...({
        placeOrder: async () => {
          forbiddenCalls.push('placeOrder');
        },
        stopNativeContractGrid: async () => {
          forbiddenCalls.push('stopNativeContractGrid');
        },
      } as any),
    };

    const messages: string[] = [];
    const tgPort: BtcTelegramPort = {
      isConfigured: () => true,
      isNotificationsEnabled: () => true,
      sendMessage: async (text) => {
        messages.push(text);
        return true;
      },
    };

    const monitor = new BtcXPerpSignalMonitor(okxPort, { dataDir: dir, telegramPort: tgPort });
    // Enforce default intervals (120s / 30s)
    eq(monitor.getConfig().analysisIntervalSec, 120, 'default analysis interval is 120s');
    eq(monitor.getConfig().botMonitorIntervalSec, 30, 'default bot monitor interval is 30s');

    // Step 1: Sync initial bots + prepare valid recommendation while bot is running
    const sync1 = await monitor.syncMonitoredBots();
    eq(sync1.activeBots.length, 2, 'must track BOTH BTC SHORT and BTC NEUTRAL bots (and exclude ETH)');
    eq(sync1.activeBots[0].tpMarginPct, 5, 'TP parsed as 5% of invested margin');
    eq(sync1.activeBots[0].slMarginPct, 2.5, 'SL parsed as 2.5% of invested margin');
    eq(sync1.activeBots[0].tpMarginUSD, 5, 'TP USD = 5% of $100 margin = $5');
    eq(sync1.activeBots[0].slMarginUSD, 2.5, 'SL USD = 2.5% of $100 margin = $2.5');

    const firstRec = await monitor.runMarketAnalysis('STARTUP');
    ok(firstRec.minPx < livePx && livePx < firstRec.maxPx, 'initial recommendation covers live BTC price');
    const msgsAfterStartup = messages.length;

    // Step 2: Simulate confirmed closure of BTC_SHORT_1 (TP reached)
    botClosed = true;
    const sync2 = await monitor.syncMonitoredBots();
    eq(sync2.newlyClosedBots.length, 1, 'must confirm closed bot on OKX');
    eq(sync2.newlyClosedBots[0].algoId, 'BTC_SHORT_1', 'closed algoId matches BTC_SHORT_1');
    eq(sync2.newlyClosedBots[0].closeReasonLabel, 'Take Profit atins (OKX)', 'detects TP close reason');
    eq(sync2.activeBots.length, 1, 'remaining BTC_NEUTRAL_2 still active');

    // Verify immediate closure alert + immediate next recommendation sent on Telegram
    const postCloseMessages = messages.slice(msgsAfterStartup);
    ok(
      postCloseMessages.some((m) => m.includes('BOT BTC-USD UM X-PERP ÎNCHIS')),
      'must send Telegram close notification'
    );
    ok(
      postCloseMessages.some((m) => m.includes('RECOMANDARE IMEDIATĂ PENTRU URMĂTORUL BOT')),
      'must immediately dispatch precomputed valid next recommendation upon closure'
    );

    // Verify signalHistory recorded fresh post-close BOT_CLOSED analysis
    const statusAfterClose = monitor.getFullStatus();
    ok(
      statusAfterClose.signalHistory.some((h) => h.trigger === 'BOT_CLOSED'),
      'must trigger fresh post-close analysis immediately'
    );
    eq(statusAfterClose.recentClosedBots.length, 1, 'recentClosedBots records BTC_SHORT_1');

    // Step 3: Running another bot sync immediately must NOT send duplicate closure Telegram alerts
    const msgsBeforeSync3 = messages.length;
    await monitor.syncMonitoredBots();
    eq(messages.length, msgsBeforeSync3, 'must deduplicate closure Telegram notifications');

    // Step 4: Move BTC price outside recommended band -> must trigger invalidation alert once
    const activeRec = monitor.getFullStatus().activeRecommendation!;
    livePx = activeRec.maxPx + 250;
    await monitor.syncMonitoredBots();
    const afterOutOfRange = monitor.getFullStatus().activeRecommendation!;
    eq(afterOutOfRange.riskStatus, 'INVALIDATED', 'recommendation must be marked INVALIDATED outside band');
    ok(
      messages.some((m) => m.includes('INVALIDARE SEMNAL BTC-USD UM X-PERP')),
      'must send Telegram signal invalidation notification'
    );

    // Step 5: Persistence check across new monitor instance in same temp dir
    const monitor2 = new BtcXPerpSignalMonitor(okxPort, { dataDir: dir, telegramPort: tgPort });
    eq(monitor2.getFullStatus().recentClosedBots.length, 1, 'persisted closed bots survive restart');
    eq(monitor2.getFullStatus().signalHistory.length >= 2, true, 'persisted signal history survives restart');
    eq(forbiddenCalls.length, 0, 'zero write/order/stop calls executed');
    eq(isBtcXPerpInstrument('BTC-USD_UM_XPERP-310530'), true, 'identifies dated BTC-USD UM X-PERP');
    eq(isBtcXPerpInstrument('ETH-USD_UM_XPERP-310530'), false, 'rejects non-BTC contracts');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. Auth/API error visibility + direct read-only trackedAlgoIds fallback
// ---------------------------------------------------------------------------
test('sync errors & trackedAlgoIds: surfaces OKX auth/API errors and resolves pinned SHORT bot via details', async () => {
  const dir = makeTempDir();
  try {
    let credsFailed = true;
    let transientError = '';
    const pinnedBotId = '4137268713223610368';

    const okxPort: BtcReadOnlyOkxPort = {
      hasCredentials: () => true,
      isCredentialsPermanentlyFailed: () => credsFailed,
      getAuthStatus: () => ({
        failed: credsFailed,
        message: credsFailed ? 'OKX Passphrase sau Cheie API incorectă (Cod 50105).' : '',
      }),
      getLastNativeGridError: () => transientError,
      resolveLiveInstrumentId: async () => 'BTC-USD_UM_XPERP-310404',
      getKlines: async () => [],
      getTickerPrice: async () => 59807.3,
      fetchMarketIntelligenceExtras: async () => ({
        openInterestUSD: 0,
        fundingRatePct: 0,
        nextFundingRatePct: 0,
        orderBookImbalance: 0,
        orderBookDepthUSD: 0,
        spreadBps: 0,
      }),
      getNativeContractGridBots: async () => [],
      getNativeContractGridDetails: async (algoId) => {
        if (algoId === pinnedBotId) {
          return {
            algoId: pinnedBotId,
            instId: 'BTC-USD_UM_XPERP-310404',
            direction: 'short',
            state: 'running',
            minPx: '59000',
            maxPx: '60000',
            gridNum: '10',
            lever: '5',
            investment: '37.81',
            investmentCcy: 'USDC',
            liqPx: '78062.9',
            tpRatio: '0.05',
            slRatio: '0.025',
            gridProfit: '0.0776',
            floatProfit: '-0.2869',
            totalPnl: '-0.2092',
            arbitrageNum: '3',
            cTime: String(Date.now() - 600_000),
            uTime: String(Date.now()),
          };
        }
        return null;
      },
    };

    const tgPort: BtcTelegramPort = {
      isConfigured: () => false,
      isNotificationsEnabled: () => false,
      sendMessage: async () => false,
    };

    const monitor = new BtcXPerpSignalMonitor(okxPort, { dataDir: dir, telegramPort: tgPort });

    // Case 1: 50105 credential failure must surface explicit lastBotSyncError
    await monitor.syncMonitoredBots();
    ok(
      (monitor.getFullStatus().lastBotSyncError || '').includes('50105'),
      'must surface explicit 50105 auth error instead of silent empty state'
    );

    // Case 2: Credentials recover, user pins bot ID via trackedAlgoIds -> detected via orders-algo-details
    credsFailed = false;
    monitor.updateConfig({ trackedAlgoIds: [pinnedBotId] });
    const syncPinned = await monitor.syncMonitoredBots();
    eq(syncPinned.activeBots.length, 1, 'pinned SHORT bot must be detected via orders-algo-details');
    eq(syncPinned.activeBots[0].algoId, pinnedBotId, 'detected algoId matches pinned ID');
    eq(syncPinned.activeBots[0].direction, 'short', 'detected direction is short');
    eq(syncPinned.activeBots[0].investedMarginUSD, 37.81, 'invested margin parsed accurately');
    eq(syncPinned.activeBots[0].investmentCcy, 'USDC', 'investment currency parsed as USDC');
    eq(syncPinned.activeBots[0].liqPx, 78062.9, 'estimated liquidation price parsed');

    // Case 3: Transient OKX API error on subsequent poll must surface error AND preserve activeBots
    transientError = 'OKX HTTP Error [429]: Too Many Requests';
    const syncErr = await monitor.syncMonitoredBots();
    eq(syncErr.activeBots.length, 1, 'must preserve activeBots on transient OKX error');
    ok(
      (monitor.getFullStatus().lastBotSyncError || '').includes('429'),
      'must surface transient OKX error to UI'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5. ZEC-USD UM X-PERP dynamic ATR band, isolated persistence & bot filtering
// ---------------------------------------------------------------------------
test('ZEC monitor: uses dynamic ATR range, isolated state file, and filters strictly ZEC X-PERP bots', async () => {
  const dir = makeTempDir();
  try {
    // Generate realistic oscillating ZEC candles around $740
    const makeZecKlines = (count: number, basePrice = 740): Kline[] => {
      const out: Kline[] = [];
      const startTs = Date.UTC(2026, 10, 1, 0, 0, 0);
      let prevClose = basePrice;
      for (let i = 0; i < count; i++) {
        const wave = Math.sin(i / 5) * 18 + Math.cos(i / 9) * 12;
        const micro = Math.sin(i * 1.1) * 3;
        const close = Math.max(100, basePrice + wave + micro);
        const open = prevClose;
        const high = Math.max(open, close) + 4 + Math.abs(Math.sin(i) * 3);
        const low = Math.min(open, close) - 4 - Math.abs(Math.cos(i) * 3);
        out.push({
          timestamp: startTs + i * 3600_000,
          open: parseFloat(open.toFixed(2)),
          high: parseFloat(high.toFixed(2)),
          low: parseFloat(low.toFixed(2)),
          close: parseFloat(close.toFixed(2)),
          volume: 15000 + Math.abs(Math.sin(i * 0.6)) * 8000,
        });
        prevClose = close;
      }
      return out;
    };

    const klines1h = makeZecKlines(180, 740);
    const klines15m = makeZecKlines(120, 742);
    const klines4h = makeZecKlines(80, 738);
    const currentPx = klines15m[klines15m.length - 1].close;

    const rawBots = [
      {
        algoId: 'ZEC_LONG_1',
        instId: 'ZEC-USD_UM_XPERP-310530',
        direction: 'long',
        state: 'running',
        minPx: '710',
        maxPx: '760',
        gridNum: '10',
        lever: '5',
        investment: '50',
        investmentCcy: 'USDC',
        tpRatio: '0.05',
        slRatio: '0.025',
        gridProfit: '0.90',
        floatProfit: '0.30',
        totalPnl: '1.20',
        arbitrageNum: '5',
        cTime: String(Date.now() - 3600_000),
        uTime: String(Date.now()),
      },
      // BTC bot MUST be excluded by ZEC monitor
      {
        algoId: 'BTC_SHORT_9',
        instId: 'BTC-USD_UM_XPERP-310404',
        direction: 'short',
        state: 'running',
        minPx: '59000',
        maxPx: '60000',
        gridNum: '10',
        lever: '5',
        investment: '37.81',
        cTime: String(Date.now() - 1800_000),
        uTime: String(Date.now()),
      },
    ];

    const okxPort: BtcReadOnlyOkxPort = {
      hasCredentials: () => true,
      isCredentialsPermanentlyFailed: () => false,
      resolveLiveInstrumentId: async (base) =>
        base === 'ZEC-USD_UM_XPERP' ? 'ZEC-USD_UM_XPERP-310530' : 'BTC-USD_UM_XPERP-310404',
      getKlines: async (_sym, interval) =>
        interval === '15m' ? klines15m : interval === '4H' ? klines4h : klines1h,
      getTickerPrice: async () => currentPx,
      fetchMarketIntelligenceExtras: async () => ({
        openInterestUSD: 42_000_000,
        fundingRatePct: 0.009,
        nextFundingRatePct: 0.008,
        orderBookImbalance: 0.12,
        orderBookDepthUSD: 620_000,
        spreadBps: 2.1,
      }),
      getNativeContractGridBots: async (mode) => (mode === 'pending' ? rawBots : []),
      getNativeContractGridDetails: async (algoId) =>
        rawBots.find((b) => b.algoId === algoId) || null,
    };

    const tgPort: BtcTelegramPort = {
      isConfigured: () => false,
      isNotificationsEnabled: () => false,
      sendMessage: async () => false,
    };

    const zecMonitor = new BtcXPerpSignalMonitor(okxPort, {
      asset: 'ZEC',
      dataDir: dir,
      telegramPort: tgPort,
    });

    const rec = await zecMonitor.runMarketAnalysis('MANUAL');
    eq(rec.asset, 'ZEC', 'recommendation asset is ZEC');
    eq(rec.displayInstrument, 'ZEC-USD UM X-PERP', 'display instrument is ZEC-USD UM X-PERP');
    eq(rec.gridNum, 10, 'must recommend 10 grids for ZEC');
    eq(rec.tpMarginPct, 5, 'ZEC TP is 5% invested margin');
    eq(rec.slMarginPct, 2.5, 'ZEC SL is 2.5% invested margin');
    ok(rec.rangeSpanUSD >= 20 && rec.rangeSpanUSD <= 150, `ZEC ATR span is realistic (${rec.rangeSpanUSD})`);
    ok(
      Math.abs((rec.maxPx - rec.minPx) - rec.rangeSpanUSD) < 1e-6,
      'maxPx - minPx matches dynamic rangeSpanUSD'
    );
    ok(
      Math.abs(rec.gridStepUSD - rec.rangeSpanUSD / 10) < 1e-4,
      'gridStepUSD equals rangeSpanUSD / 10'
    );
    ok(rec.minPx < currentPx && currentPx < rec.maxPx, 'current ZEC price sits inside band');

    const sync = await zecMonitor.syncMonitoredBots();
    eq(sync.activeBots.length, 1, 'ZEC monitor detects only ZEC bot and excludes BTC bot');
    eq(sync.activeBots[0].algoId, 'ZEC_LONG_1', 'detected ZEC bot algoId matches');

    ok(
      fs.existsSync(path.join(dir, 'zec_xperp_signals.json')),
      'ZEC state persisted to isolated zec_xperp_signals.json'
    );
    eq(
      fs.existsSync(path.join(dir, 'btc_xperp_signals.json')),
      false,
      'ZEC monitor must not write into btc_xperp_signals.json'
    );

    eq(isXPerpInstrumentForAsset('ZEC', 'ZEC-USD_UM_XPERP-310530'), true, 'matches ZEC X-PERP');
    eq(isXPerpInstrumentForAsset('ZEC', 'BTC-USD_UM_XPERP-310404'), false, 'rejects BTC in ZEC matcher');

    const zecDyn = computeDynamicGridRangeForAsset({
      asset: 'ZEC',
      currentPrice: 740.5,
      direction: 'LONG',
      atr1hUSD: 12.2,
      nearestSupport: { price: 730, type: 'SUPPORT', distancePct: -1.4, touchCount: 2, strengthScore: 2 },
      nearestResistance: { price: 762, type: 'RESISTANCE', distancePct: 2.9, touchCount: 2, strengthScore: 2 },
    });
    ok(zecDyn.rangeSpanUSD >= 40 && zecDyn.maxPx - zecDyn.minPx === zecDyn.rangeSpanUSD, 'ZEC dynamic range is consistent');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 6. Active bot limit advisory (NEAR_MIN/OUT_LOW) + Telegram anti-spam hysteresis
// ---------------------------------------------------------------------------
test('bot limit alerts: detects NEAR_MIN/OUT_LOW, suggests new range, and deduplicates with hysteresis', async () => {
  const dir = makeTempDir();
  try {
    let livePx = 59500;
    const rawBot = {
      algoId: 'BTC_SHORT_LIMIT',
      instId: 'BTC-USD_UM_XPERP-310404',
      direction: 'short',
      state: 'running',
      minPx: '59000',
      maxPx: '60000',
      gridNum: '10',
      lever: '5',
      investment: '37.81',
      investmentCcy: 'USDC',
      tpRatio: '0.05',
      slRatio: '0.025',
      gridProfit: '0.18',
      floatProfit: '-0.12',
      totalPnl: '0.06',
      arbitrageNum: '3',
      cTime: String(Date.now() - 600_000),
      uTime: String(Date.now()),
    };

    const okxPort: BtcReadOnlyOkxPort = {
      hasCredentials: () => true,
      isCredentialsPermanentlyFailed: () => false,
      resolveLiveInstrumentId: async () => 'BTC-USD_UM_XPERP-310404',
      getKlines: async () => [],
      getTickerPrice: async () => livePx,
      fetchMarketIntelligenceExtras: async () => ({
        openInterestUSD: 400_000_000,
        fundingRatePct: -0.005,
        nextFundingRatePct: -0.005,
        orderBookImbalance: 0,
        orderBookDepthUSD: 2_000_000,
        spreadBps: 1.0,
      }),
      getNativeContractGridBots: async (mode) => (mode === 'pending' ? [rawBot] : []),
      getNativeContractGridDetails: async (algoId) => (algoId === rawBot.algoId ? rawBot : null),
    };

    const messages: string[] = [];
    const tgPort: BtcTelegramPort = {
      isConfigured: () => true,
      isNotificationsEnabled: () => true,
      sendMessage: async (text) => {
        messages.push(text);
        return true;
      },
    };

    const monitor = new BtcXPerpSignalMonitor(okxPort, { dataDir: dir, telegramPort: tgPort });

    // 1) Inside band ($59,500) -> INSIDE, no Telegram alert
    const s1 = await monitor.syncMonitoredBots();
    eq(s1.activeBots.length, 1, 'bot detected inside band');
    eq(s1.activeBots[0].limitStatus, 'INSIDE', '59500 is INSIDE 59000-60000');
    eq(s1.activeBots[0].suggestedNewRange, undefined, 'no suggested range while INSIDE');
    eq(messages.length, 0, 'no Telegram alert when inside band');

    // 2) Approaching lower bound ($59,050 -> 5% <= 8%) -> NEAR_MIN alert once
    livePx = 59050;
    const s2 = await monitor.syncMonitoredBots();
    eq(s2.activeBots[0].limitStatus, 'NEAR_MIN', '59050 is NEAR_MIN');
    ok(s2.activeBots[0].limitMessage?.includes('59,000') || s2.activeBots[0].limitMessage?.includes('59000'), 'limitMessage mentions lower bound');
    ok(s2.activeBots[0].suggestedNewRange !== undefined, 'suggestedNewRange populated on NEAR_MIN');
    eq(messages.length, 1, 'sends NEAR_MIN Telegram alert once');
    ok(messages[0].includes('APROAPE DE LIMITĂ'), 'Telegram alert uses NEAR warning header');
    ok(messages[0].includes('RECOMANDARE SCHIMBARE LIMITE'), 'Telegram alert includes new range recommendation');

    // Repeat poll at $59,040 -> zero duplicate alert
    livePx = 59040;
    await monitor.syncMonitoredBots();
    eq(messages.length, 1, 'deduplicates repeated NEAR_MIN polls');

    // 3) Cross below $59,000 ($58,950) -> immediate upgrade to OUT_LOW
    livePx = 58950;
    const s3 = await monitor.syncMonitoredBots();
    eq(s3.activeBots[0].limitStatus, 'OUT_LOW', '58950 is OUT_LOW');
    const sug = s3.activeBots[0].suggestedNewRange!;
    eq(sug.rangeSpanUSD, 1000, 'suggested new BTC range preserves $1,000 span');
    eq(sug.gridStepUSD, 100, 'suggested new BTC range preserves $100 step');
    ok(sug.minPx < 58950 && 58950 < sug.maxPx, 'suggested range encloses current price 58950');
    eq(messages.length, 2, 'immediately upgrades NEAR_MIN -> OUT_LOW on Telegram');
    ok(messages[1].includes('LA LIMITĂ / ÎN AFARA BENZII'), 'Telegram breach alert uses urgent header');

    // Bounce back slightly to $59,040 (4% < 15% hysteresis) and drop again -> no spam
    livePx = 59040;
    await monitor.syncMonitoredBots();
    livePx = 58960;
    await monitor.syncMonitoredBots();
    eq(messages.length, 2, '15%-85% hysteresis suppresses oscillation spam near boundary');

    // 4) Full recovery to $59,500 (50% inside 15%-85%) clears hysteresis lock
    livePx = 59500;
    const s4 = await monitor.syncMonitoredBots();
    eq(s4.activeBots[0].limitStatus, 'INSIDE', 'recovers cleanly to INSIDE');

    // Drop again to $59,050 triggers fresh alert because hysteresis cleared
    livePx = 59050;
    await monitor.syncMonitoredBots();
    eq(messages.length, 3, 'fires again after full 15%-85% hysteresis reset');

    // 5) Recover and disable onBotLimitReached toggle -> zero Telegram alerts on subsequent breach
    livePx = 59500;
    await monitor.syncMonitoredBots();
    monitor.updateConfig({
      telegramPreferences: {
        ...monitor.getConfig().telegramPreferences,
        onBotLimitReached: false,
      },
    });
    livePx = 58900;
    const s5 = await monitor.syncMonitoredBots();
    eq(s5.activeBots[0].limitStatus, 'OUT_LOW', 'UI limitStatus still updates when Telegram toggle is off');
    eq(messages.length, 3, 'respects onBotLimitReached=false without sending Telegram alert');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Runner
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
  console.log(`\n${tests.length - failed}/${tests.length} btc-xperp-signal-monitor tests passed`);
  if (failed > 0) process.exitCode = 1;
};

void run();
