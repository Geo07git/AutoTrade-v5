/**
 * Regression suite for the refactored ANAF Fiscal Module (`AnafTaxEngine.ts`).
 *
 * Covers:
 *  1. Default & configurable `startDate` (`2026-10-01` for 2026, ignoring pre-start records).
 *  2. Canonical OKX Bills synchronization (`bills` + `bills-archive`) with full `after` cursor
 *     pagination (>600 items), strict `billId` deduplication, legacy v1 cache migration, and
 *     exclusion of duplicate `grid_arbitrages.json` / `orders.json` / `OKX_ORD_` / `OKX_FILL_`.
 *  3. Non-overlapping CSV fallback for periods older than the API window.
 *  4. Persistent BNR USD/RON manual override + live revert + dynamic RON recalculation from USD.
 *  5. Monthly aggregation (`monthlySummaries`), coverage status, tax efficiency metrics
 *     (including `TAX_EXCEEDS_GAIN` & `LOSS_WITH_TAX`), and paginated on-demand queries.
 *
 * NO network, NO real `.data/` touched (uses an isolated temp directory cleaned up at exit).
 *
 * Run: npm test
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { AnafTaxEngine } from '../AnafTaxEngine';
import type { OKXAdapter } from '../../exchange/OKXAdapter';

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

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'anaf-fiscal-test-'));
}

function makeMockAdapter(
  handler: (reqPath: string) => any,
  hasCreds = true
): OKXAdapter {
  return {
    hasCredentials: () => hasCreds,
    getCachedCtVal: () => 1,
    requestPrivate: async (_method: string, reqPath: string) => handler(reqPath),
  } as unknown as OKXAdapter;
}

const NOW_2026_11_21 = Date.UTC(2026, 10, 21, 14, 0, 0); // 2026-11-21T14:00:00Z

// ---------------------------------------------------------------------------
// 1. Default startDate (2026-10-01) & date filtering
// ---------------------------------------------------------------------------
test('startDate: 2026 defaults to 2026-10-01 and excludes September records', async () => {
  const dir = makeTempDir();
  try {
    const adapter = makeMockAdapter(() => ({ code: '0', data: [] }), false);
    const engine = new AnafTaxEngine(adapter, dir, { nowFn: () => NOW_2026_11_21, rateLimitDelayMs: 0 });
    engine.savePersistentSyncedTransactions([
      {
        id: 'OKX_BILL_SEP_1',
        rawBillId: 'SEP_1',
        source: 'OKX_API',
        timestamp: Date.UTC(2026, 8, 25, 10, 0, 0), // 2026-09-25
        dateFormatted: '2026-09-25 10:00:00',
        symbol: 'BTC-USD_UM_XPERP',
        side: 'SELL',
        closeType: 'OKX_BILL_PROFIT',
        pnlUSD: 100,
        feeUSD: 1,
        notionalUSD: 1000,
        bnrRate: 4.62,
        pnlRON: 462,
        feeRON: 4.62,
        isProfit: true,
        grossGainRON: 462,
        deductibleFeeRON: 4.62,
        netTaxableGainRON: 457.38,
      },
      {
        id: 'OKX_BILL_OCT_3',
        rawBillId: 'OCT_3',
        source: 'OKX_API',
        timestamp: Date.UTC(2026, 9, 3, 12, 0, 0), // 2026-10-03
        dateFormatted: '2026-10-03 12:00:00',
        symbol: 'ETH-USD_UM_XPERP',
        side: 'SELL',
        closeType: 'OKX_BILL_PROFIT',
        pnlUSD: 50,
        feeUSD: 2,
        notionalUSD: 500,
        bnrRate: 4.62,
        pnlRON: 231,
        feeRON: 9.24,
        isProfit: true,
        grossGainRON: 231,
        deductibleFeeRON: 9.24,
        netTaxableGainRON: 221.76,
      },
      {
        id: 'OKX_BILL_NOV_10',
        rawBillId: 'NOV_10',
        source: 'OKX_API',
        timestamp: Date.UTC(2026, 10, 10, 12, 0, 0), // 2026-11-10
        dateFormatted: '2026-11-10 12:00:00',
        symbol: 'SOL-USD_UM_XPERP',
        side: 'SELL',
        closeType: 'OKX_BILL_PROFIT',
        pnlUSD: 20,
        feeUSD: 1,
        notionalUSD: 200,
        bnrRate: 4.62,
        pnlRON: 92.4,
        feeRON: 4.62,
        isProfit: true,
        grossGainRON: 92.4,
        deductibleFeeRON: 4.62,
        netTaxableGainRON: 87.78,
      },
    ]);

    const summary = await engine.computeTaxReport({
      fiscalYear: 2026,
      customUsdRonRate: 5.0,
      nowMs: NOW_2026_11_21,
    });

    eq(summary.startDate, '2026-10-01', '2026 must default to 2026-10-01');
    eq(summary.totalTransactionsCount, 2, 'only Oct and Nov records included');
    eq(summary.monthlySummaries.length, 2, 'must emit 2026-10 and 2026-11');
    eq(summary.monthlySummaries[0].yearMonth, '2026-10', 'first month is October');
    eq(summary.monthlySummaries[1].yearMonth, '2026-11', 'second month is November');
    eq(summary.transactions.length, 0, 'lightweight summary must not serialize full transactions array by default');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. Full cursor pagination (>600 bills), strict billId dedup & no local double-counting
// ---------------------------------------------------------------------------
test('sync: paginates beyond 600 items using after cursor and ignores duplicate local files', async () => {
  const dir = makeTempDir();
  try {
    // Seed duplicate legacy grid_arbitrages.json and orders.json that MUST be ignored
    fs.writeFileSync(
      path.join(dir, 'grid_arbitrages.json'),
      JSON.stringify([{ id: 'arb_dup_1', timestamp: Date.UTC(2026, 9, 10), grossProfitUSDT: 999, feeUSDT: 1 }])
    );
    fs.writeFileSync(
      path.join(dir, 'orders.json'),
      JSON.stringify([{ id: 'ord_dup_1', status: 'Filled', updateTime: Date.UTC(2026, 9, 11), realizedPnl: 888, feeUSDT: 1 }])
    );

    // Build 650 canonical FUTURES bills across 7 pages (100 per page)
    const archiveBills: any[] = [];
    for (let i = 0; i < 650; i++) {
      archiveBills.push({
        billId: `B_${1000 - i}`,
        instId: 'ETH-USD_UM_XPERP',
        ts: String(NOW_2026_11_21 - (i + 1) * 60_000),
        pnl: '1.0',
        fee: '-0.1',
        px: '3000',
        sz: '1',
        type: '2',
        subType: '2',
      });
    }
    // Overlapping 50 bills in recent endpoint to verify zero duplication across bills vs bills-archive
    const recentOverlapBills = archiveBills.slice(0, 50);

    const adapter = makeMockAdapter((reqPath) => {
      const url = new URL(`http://okx${reqPath}`);
      const instType = url.searchParams.get('instType');
      const after = url.searchParams.get('after');
      if (instType !== 'FUTURES') return { code: '0', data: [] };

      if (url.pathname === '/api/v5/account/bills') {
        if (after) return { code: '0', data: [] };
        return { code: '0', data: recentOverlapBills };
      }
      if (url.pathname === '/api/v5/account/bills-archive') {
        if (!after) return { code: '0', data: archiveBills.slice(0, 100) };
        const idx = archiveBills.findIndex((b) => b.billId === after);
        if (idx < 0) return { code: '0', data: [] };
        return { code: '0', data: archiveBills.slice(idx + 1, idx + 101) };
      }
      return { code: '0', data: [] };
    }, true);

    const engine = new AnafTaxEngine(adapter, dir, { nowFn: () => NOW_2026_11_21, rateLimitDelayMs: 0 });
    const summary = await engine.computeTaxReport({
      fiscalYear: 2026,
      forceSyncOkxApi: true,
      customUsdRonRate: 5.0,
      nowMs: NOW_2026_11_21,
    });

    eq(summary.totalTransactionsCount, 650, 'must fetch and deduplicate all 650 canonical bills (>600 limit broken)');
    near(summary.symmetric.totalProfitUSD, 650, 1e-3, 'total profit must not include fake 999/888 from local files');
    near(summary.symmetric.totalFeesUSD, 65, 1e-3, 'fees must match 650 * 0.1');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. Legacy cache migration + non-overlapping CSV fallback
// ---------------------------------------------------------------------------
test('migration & CSV: drops OKX_ORD/OKX_FILL duplicates and merges older CSV without overlap', async () => {
  const dir = makeTempDir();
  try {
    // Write legacy v1 mixed flat-array cache
    fs.writeFileSync(
      path.join(dir, 'okx_synced_transactions.json'),
      JSON.stringify([
        {
          id: 'OKX_ORD_111',
          source: 'OKX_API',
          timestamp: Date.UTC(2026, 9, 10),
          dateFormatted: '2026-10-10 00:00:00',
          symbol: 'BTC-USD_UM_XPERP',
          side: 'SELL',
          closeType: 'OKX_ORDER_PROFIT',
          pnlUSD: 100,
          feeUSD: 1,
          notionalUSD: 1000,
          bnrRate: 4.62,
          pnlRON: 462,
          feeRON: 4.62,
          isProfit: true,
          grossGainRON: 462,
          deductibleFeeRON: 4.62,
          netTaxableGainRON: 457.38,
        },
        {
          id: 'OKX_FILL_222',
          source: 'OKX_API',
          timestamp: Date.UTC(2026, 9, 10),
          dateFormatted: '2026-10-10 00:00:00',
          symbol: 'BTC-USD_UM_XPERP',
          side: 'SELL',
          closeType: 'OKX_FILL_TAKE_PROFIT',
          pnlUSD: 100,
          feeUSD: 1,
          notionalUSD: 1000,
          bnrRate: 4.62,
          pnlRON: 462,
          feeRON: 4.62,
          isProfit: true,
          grossGainRON: 462,
          deductibleFeeRON: 4.62,
          netTaxableGainRON: 457.38,
        },
        {
          id: 'OKX_BILL_999',
          rawBillId: '999',
          source: 'OKX_API',
          timestamp: Date.UTC(2026, 9, 15, 10, 0, 0), // 2026-10-15
          dateFormatted: '2026-10-15 10:00:00',
          symbol: 'BTC-USD_UM_XPERP',
          side: 'SELL',
          closeType: 'OKX_BILL_PROFIT',
          pnlUSD: 20,
          feeUSD: 1,
          notionalUSD: 500,
          bnrRate: 4.62,
          pnlRON: 92.4,
          feeRON: 4.62,
          isProfit: true,
          grossGainRON: 92.4,
          deductibleFeeRON: 4.62,
          netTaxableGainRON: 87.78,
        },
      ])
    );

    const adapter = makeMockAdapter(() => ({ code: '0', data: [] }), false);
    const engine = new AnafTaxEngine(adapter, dir, { nowFn: () => NOW_2026_11_21, rateLimitDelayMs: 0 });

    // Upload CSV containing BOTH an older row (2026-10-05 < earliestApiBillTs 2026-10-15)
    // AND an overlapping row (2026-10-20 >= 2026-10-15)
    const csv = [
      'Bill ID,Time,Instrument,Side,Price,Amount,Fee,Realized PnL',
      '800,2026-10-05 12:00:00,SOL-USD_UM_XPERP,SELL,150,1,1,10',
      '999,2026-10-15 10:00:00,BTC-USD_UM_XPERP,SELL,60000,1,1,20',
      '1050,2026-10-20 12:00:00,BTC-USD_UM_XPERP,SELL,61000,1,1,30',
    ].join('\n');
    engine.parseAndImportOkxCsv(csv);

    const summary = await engine.computeTaxReport({
      fiscalYear: 2026,
      customUsdRonRate: 5.0,
      nowMs: NOW_2026_11_21,
    });

    // Must contain OKX_BILL_999 (20 USD) + CSV 800 (10 USD), dropping OKX_ORD_111, OKX_FILL_222, duplicate 999, and overlapping 1050 (>= 2026-10-15)
    eq(summary.totalTransactionsCount, 2, 'must preserve pre-API CSV (800) + canonical API bill (999) only');
    near(summary.symmetric.totalProfitUSD, 30, 1e-4, 'total USD profit must be 20 + 10 = 30');
    eq(summary.monthlySummaries[0].coverageStatus, 'API_PLUS_CSV', 'October has both API and CSV fallback');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. Dynamic BNR rate recalculation & persistence
// ---------------------------------------------------------------------------
test('BNR override: dynamically recalculates RON amounts from USD and persists across instances', async () => {
  const dir = makeTempDir();
  try {
    const adapter = makeMockAdapter(() => ({ code: '0', data: [] }), false);
    const engine1 = new AnafTaxEngine(adapter, dir, { nowFn: () => NOW_2026_11_21, rateLimitDelayMs: 0 });

    // Stored record has stale cached 4.0000 rate RON numbers (pnlRON = 400 instead of 500)
    engine1.savePersistentSyncedTransactions([
      {
        id: 'OKX_BILL_RATE_1',
        rawBillId: 'RATE_1',
        source: 'OKX_API',
        timestamp: Date.UTC(2026, 9, 12, 8, 0, 0),
        dateFormatted: '2026-10-12 08:00:00',
        symbol: 'BTC-USD_UM_XPERP',
        side: 'SELL',
        closeType: 'OKX_BILL_PROFIT',
        pnlUSD: 100,
        feeUSD: 2,
        notionalUSD: 1000,
        bnrRate: 4.0,
        pnlRON: 400,
        feeRON: 8,
        isProfit: true,
        grossGainRON: 400,
        deductibleFeeRON: 8,
        netTaxableGainRON: 392,
      },
    ]);

    engine1.saveFiscalSettings({ fiscalYear: 2026, customUsdRonRate: 5.0 });

    // New engine instance reads persisted settings & recomputes dynamically at 5.0 RON/USD
    const engine2 = new AnafTaxEngine(adapter, dir, { nowFn: () => NOW_2026_11_21, rateLimitDelayMs: 0 });
    const summary = await engine2.computeTaxReport({ fiscalYear: 2026, nowMs: NOW_2026_11_21 });

    eq(summary.isCustomUsdRonRate, true, 'must remember custom override across restart');
    near(summary.usdRonRate, 5.0, 1e-4, 'active rate must be 5.0');
    near(summary.asymmetric.grossRevenueRON, 500, 0.01, '100 USD * 5.0 = 500 RON (not frozen 400 RON)');
    near(summary.asymmetric.deductibleExpensesRON, 10, 0.01, '2 USD * 5.0 = 10 RON');
    near(summary.asymmetric.netTaxableBaseRON, 490, 0.01, '500 - 10 = 490 RON');
    eq(summary.asymmetric.incomeTaxRON, 49, '10% of 490 = 49 RON');

    // Paginated transaction query must ALSO recompute RON dynamically
    const page = await engine2.queryTransactions({ fiscalYear: 2026, yearMonth: '2026-10', nowMs: NOW_2026_11_21 });
    eq(page.transactions.length, 1, 'must find 1 record in October');
    near(page.transactions[0].pnlRON, 500, 0.01, 'transaction drilldown pnlRON must reflect 5.0 override');

    // Revert to live rate
    engine2.saveFiscalSettings({ clearCustomUsdRonRate: true });
    const reverted = await engine2.computeTaxReport({ fiscalYear: 2026, nowMs: NOW_2026_11_21 });
    eq(reverted.isCustomUsdRonRate, false, 'custom flag cleared on revert');
    ok(reverted.usdRonRate !== 5.0, 'rate reverted to live/reference BNR');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5. Tax efficiency (tax > gain, loss + tax) & paginated search/filter
// ---------------------------------------------------------------------------
test('efficiency & pagination: detects TAX_EXCEEDS_GAIN and LOSS_WITH_TAX and paginates queries', async () => {
  const dir = makeTempDir();
  try {
    const adapter = makeMockAdapter(() => ({ code: '0', data: [] }), false);
    const engine = new AnafTaxEngine(adapter, dir, { nowFn: () => NOW_2026_11_21, rateLimitDelayMs: 0 });

    engine.savePersistentSyncedTransactions([
      // October: Profit +100, Loss -92, Fees 4 => Real Net = +4 USD = +20 RON; ANAF base ~490 RON => Tax = 49 RON > 20 RON!
      {
        id: 'OKX_BILL_OCT_W',
        rawBillId: 'OCT_W',
        source: 'OKX_API',
        timestamp: Date.UTC(2026, 9, 5, 10, 0, 0),
        dateFormatted: '2026-10-05 10:00:00',
        symbol: 'ARB-USD_UM_XPERP',
        side: 'SELL',
        closeType: 'OKX_BILL_PROFIT',
        pnlUSD: 100,
        feeUSD: 2,
        notionalUSD: 1000,
        bnrRate: 5.0,
        pnlRON: 500,
        feeRON: 10,
        isProfit: true,
        grossGainRON: 500,
        deductibleFeeRON: 10,
        netTaxableGainRON: 490,
      },
      {
        id: 'OKX_BILL_OCT_L',
        rawBillId: 'OCT_L',
        source: 'OKX_API',
        timestamp: Date.UTC(2026, 9, 6, 10, 0, 0),
        dateFormatted: '2026-10-06 10:00:00',
        symbol: 'ARB-USD_UM_XPERP',
        side: 'SELL',
        closeType: 'OKX_BILL_LOSS',
        pnlUSD: -92,
        feeUSD: 2,
        notionalUSD: 920,
        bnrRate: 5.0,
        pnlRON: -460,
        feeRON: 10,
        isProfit: false,
        grossGainRON: 0,
        deductibleFeeRON: 0,
        netTaxableGainRON: 0,
      },
      // November: Profit +50, Loss -60, Fees 5 => Real Net = -15 USD = -75 RON; still pays tax ~24 RON => LOSS_WITH_TAX!
      {
        id: 'OKX_BILL_NOV_W',
        rawBillId: 'NOV_W',
        source: 'OKX_API',
        timestamp: Date.UTC(2026, 10, 5, 10, 0, 0),
        dateFormatted: '2026-11-05 10:00:00',
        symbol: 'LINK-USD_UM_XPERP',
        side: 'SELL',
        closeType: 'OKX_BILL_PROFIT',
        pnlUSD: 50,
        feeUSD: 2,
        notionalUSD: 500,
        bnrRate: 5.0,
        pnlRON: 250,
        feeRON: 10,
        isProfit: true,
        grossGainRON: 250,
        deductibleFeeRON: 10,
        netTaxableGainRON: 240,
      },
      {
        id: 'OKX_BILL_NOV_L',
        rawBillId: 'NOV_L',
        source: 'OKX_API',
        timestamp: Date.UTC(2026, 10, 6, 10, 0, 0),
        dateFormatted: '2026-11-06 10:00:00',
        symbol: 'LINK-USD_UM_XPERP',
        side: 'SELL',
        closeType: 'OKX_BILL_LOSS',
        pnlUSD: -60,
        feeUSD: 3,
        notionalUSD: 600,
        bnrRate: 5.0,
        pnlRON: -300,
        feeRON: 15,
        isProfit: false,
        grossGainRON: 0,
        deductibleFeeRON: 0,
        netTaxableGainRON: 0,
      },
    ]);

    const summary = await engine.computeTaxReport({
      fiscalYear: 2026,
      customUsdRonRate: 5.0,
      taxRatePct: 10,
      includeTransactions: true,
      nowMs: NOW_2026_11_21,
    });

    const oct = summary.monthlySummaries[0];
    const nov = summary.monthlySummaries[1];

    eq(oct.efficiency.status, 'TAX_EXCEEDS_GAIN', 'October tax (49 RON) exceeds real net (20 RON)');
    eq(oct.efficiency.taxExceedsGain, true, 'taxExceedsGain must be true');
    near(oct.efficiency.effectiveTaxRatePct!, 245.0, 0.5, 'effective tax rate = 49 / 20 * 100 = 245%');
    near(oct.efficiency.netAfterTaxRON, -29, 0.01, '20 - 49 = -29 RON left after tax');

    eq(nov.efficiency.status, 'LOSS_WITH_TAX', 'November has real loss (-75 RON) + ANAF tax (24 RON)');
    eq(nov.efficiency.lossWithTaxDue, true, 'lossWithTaxDue must be true');
    eq(nov.efficiency.effectiveTaxRatePct, null, 'effective rate null when real net <= 0');

    // CSV export must contain monthly summary and full journal
    const csvOut = engine.generateAuditCsv(summary);
    ok(csvOut.includes('SUMAR LUNAR ANAF'), 'CSV includes monthly summary');
    ok(csvOut.includes('2026-10 Octombrie'), 'CSV includes October label');
    ok(csvOut.includes('OKX_BILL_NOV_W'), 'CSV includes full transaction rows');

    // Paginated query filter + search
    const linkOnly = await engine.queryTransactions({
      fiscalYear: 2026,
      yearMonth: '2026-11',
      search: 'LINK',
      filter: 'PROFIT',
      customUsdRonRate: 5.0,
      nowMs: NOW_2026_11_21,
    });
    eq(linkOnly.totalCount, 1, 'filtered LINK PROFIT in Nov matches 1 row');
    eq(linkOnly.transactions[0].id, 'OKX_BILL_NOV_W', 'exact row returned');
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
  console.log(`\n${tests.length - failed}/${tests.length} anaf-tax-engine tests passed`);
  if (failed > 0) process.exitCode = 1;
};

void run();
