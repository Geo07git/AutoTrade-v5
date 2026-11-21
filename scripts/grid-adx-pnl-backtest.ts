/**
 * CAT COSTA PRAGUL DE ADX? — backtest pe fiecare ora in care TOATE celelalte porti au trecut.
 *
 * Intrebarea la care `grid-gate-replay.ts` NU raspunde: acolo se numara ferestre, aici se numara
 * BANI. Pentru fiecare ora in care scanul si toate portile non-regim au trecut (crossings, ER,
 * banda, comision, lichiditate, round-trips), rulam `GridBacktestEngine` pe urmatoarele
 * `--horizon` ore — adica exact orizontul pe care banda a fost dimensionata — si grupam rezultatul
 * pe benzi de ADX.
 *
 * De ce asa si nu altfel:
 *   - motorul de backtest e cel din productie (`GridBacktestEngine.runSimulation`), nu o
 *     reimplementare: geometria grilei, comisionul si funding-ul sunt aceleasi cifre pe care le
 *     foloseste aplicatia;
 *   - ferestrele sunt NE-SUPRAPUSE per simbol (`nextAvailableTs`), altfel 8 ferestre care impart
 *     aceeasi ora ar fi numarate ca 8 dovezi independente;
 *   - se raporteaza si `rangeBreakoutsAbove/Below` si `wasLiquidated`, pentru ca intrebarea
 *     "ar fi mers" nu e completa fara "cu ce risc".
 *
 * Ce NU se poate reconstrui (declarat, nu ascuns): spread-ul si adancimea top-of-book nu au
 * istoric public, deci se folosesc aceleasi presupuneri ca in `grid-gate-replay.ts`.
 *
 * Run:
 *   npx tsx scripts/grid-adx-pnl-backtest.ts --days=14 --symbols=10
 *   npx tsx scripts/grid-adx-pnl-backtest.ts --days=21 --symbols=15 --horizon=8
 */

import { isTradableXPerp } from '../src/server/scanner/UniverseManager';
import { buildAgentOpportunity, type AgentUniverseTicker } from '../src/server/agent/AgentUniverseScan';
import {
  hasDirectionalPressure,
  isDisplacedRegime,
  GRID_ADX_TREND_SELECTION,
  GRID_CHOP_TREND_SELECTION,
} from '../src/server/engine/grid/gridRegime';
import { GridBacktestEngine, createDefaultBotConfig } from '../src/server/research/GridBacktestEngine';
import type { Kline } from '../src/shared/types';

const BASE = 'https://www.okx.com';
const REGIME_BARS_1H = 60;

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  })
);
const DAYS = Math.max(2, Math.min(30, Number(args.get('days')) || 14));
const SYMBOLS = Math.max(2, Math.min(40, Number(args.get('symbols')) || 10));
const FEE = Number(args.get('fee')) || 0.08;
const BUDGET = Number(args.get('budget')) || 12;
const LEVER = Number(args.get('lever')) || 2;
const HARD_STOP = Number(args.get('stop')) || 12;
const TAKE_PROFIT = Number(args.get('tp')) || 15;
const SPREAD = Number(args.get('spread')) || 0.05;
const MIN_CROSSINGS = Number(args.get('mincross')) || 0.3;
const HORIZON_H = Math.max(1, Math.min(48, Number(args.get('horizon')) || 8));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function okxGet(path: string, attempt = 1): Promise<any> {
  try {
    const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(20_000) });
    const json: any = await res.json();
    if (json?.code === '0') return json;
    if (attempt <= 3 && ['50011', '50004', '50001', '50013'].includes(String(json?.code))) {
      await sleep(500 * attempt);
      return okxGet(path, attempt + 1);
    }
    throw new Error(`OKX ${json?.code}: ${json?.msg}`);
  } catch (err: any) {
    if (attempt <= 3 && /timeout|ECONN|fetch failed/i.test(String(err?.message))) {
      await sleep(500 * attempt);
      return okxGet(path, attempt + 1);
    }
    throw err;
  }
}

async function fetchHistory(instId: string, bar: string, want: number, pauseMs: number): Promise<Kline[]> {
  const out: Kline[] = [];
  let after: string | undefined;
  const stepMs = bar === '1H' ? 3_600_000 : 900_000;
  const endMs = Date.now();
  while (out.length < want) {
    const path =
      `/api/v5/market/history-candles?instId=${instId}&bar=${bar}&limit=100` +
      (after ? `&after=${after}` : '');
    const json = await okxGet(path);
    const rows: any[] = json.data || [];
    if (rows.length === 0) break;
    for (const k of rows) {
      out.push({
        timestamp: Number(k[0]),
        open: Number(k[1]),
        high: Number(k[2]),
        low: Number(k[3]),
        close: Number(k[4]),
        volume: Number(k[5]) || 0,
      });
    }
    after = String(rows[rows.length - 1][0]);
    if (rows.length < 100) break;
    if (Number(rows[rows.length - 1][0]) < endMs - want * stepMs) break;
    await sleep(pauseMs);
  }
  out.sort((a, b) => a.timestamp - b.timestamp);
  return out.slice(0, -1).slice(-want);
}

interface ContractMeta {
  instId: string;
  minSz: number;
  lotSz: number;
  tickSz: number;
  ctVal: number;
  turnoverUsd: number;
}

async function loadUniverse(): Promise<ContractMeta[]> {
  const [instruments, tickers] = await Promise.all([
    okxGet('/api/v5/public/instruments?instType=FUTURES'),
    okxGet('/api/v5/market/tickers?instType=FUTURES'),
  ]);
  const byId = new Map<string, any>((tickers.data || []).map((t: any) => [t.instId, t]));
  const rows: ContractMeta[] = [];
  for (const inst of instruments.data || []) {
    if (!isTradableXPerp(inst)) continue;
    const t = byId.get(inst.instId);
    if (!t) continue;
    const last = Number(t.last);
    const ctVal = Number(inst.ctVal) || 1;
    const turnoverUsd = Number(t.vol24h) * ctVal * last;
    if (!(last > 0) || !(turnoverUsd > 0)) continue;
    rows.push({
      instId: inst.instId,
      minSz: Number(inst.minSz) || 1,
      lotSz: Number(inst.lotSz) || 1,
      tickSz: Number(inst.tickSz) || 0.01,
      ctVal,
      turnoverUsd,
    });
  }
  rows.sort((a, b) => b.turnoverUsd - a.turnoverUsd);
  return rows;
}

interface Bucket {
  label: string;
  n: number;
  wins: number;
  netPct: number[];
  gridProfit: number;
  fees: number;
  maxDd: number;
  breakouts: number;
  liquidated: number;
  cycles: number;
}

const BUCKETS: Array<{ label: string; test: (adx: number) => boolean }> = [
  { label: `ADX <= ${GRID_ADX_TREND_SELECTION} (poarta deschisa)`, test: (a) => a <= GRID_ADX_TREND_SELECTION },
  { label: 'ADX 25-35 (refuzat azi)', test: (a) => a > 25 && a <= 35 },
  { label: 'ADX 35-50 (refuzat azi)', test: (a) => a > 35 && a <= 50 },
  { label: 'ADX > 50 (refuzat azi)', test: (a) => a > 50 },
];

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

(async () => {
  console.log(
    `BACKTEST PnL pe benzi de ADX | ${DAYS} zile | top ${SYMBOLS} X-Perp | orizont ${HORIZON_H}h\n` +
      `  buget ${BUDGET}$ | lev ${LEVER}x | stop ${HARD_STOP}% | tp ${TAKE_PROFIT}% | fee ${FEE}% | spread ${SPREAD}%\n` +
      `  se testeaza doar orele in care TOATE portile non-regim trec (crossings>=${MIN_CROSSINGS}/h, ER<=0.4)\n`
  );

  const universe = await loadUniverse();
  const picked = universe.slice(0, SYMBOLS);
  console.log(`univers: ${universe.length} X-Perp-uri live, backtest pe ${picked.length}\n`);

  const buckets = new Map<string, Bucket>(
    BUCKETS.map((b) => [
      b.label,
      { label: b.label, n: 0, wins: 0, netPct: [], gridProfit: 0, fees: 0, maxDd: 0, breakouts: 0, liquidated: 0, cycles: 0 },
    ])
  );
  const horizonBars = HORIZON_H * 4;
  let unaffordable = 0;

  for (const meta of picked) {
    let bars15m: Kline[] = [];
    let bars1h: Kline[] = [];
    try {
      [bars15m, bars1h] = await Promise.all([
        fetchHistory(meta.instId, '15m', DAYS * 96 + horizonBars + 8, 140),
        fetchHistory(meta.instId, '1H', DAYS * 24 + REGIME_BARS_1H + 2, 140),
      ]);
    } catch (err: any) {
      console.log(`  ${meta.instId}: fetch esuat (${err?.message}), sarit`);
      continue;
    }
    if (bars15m.length < 48 || bars1h.length < REGIME_BARS_1H + 24) {
      console.log(`  ${meta.instId}: istoric insuficient (15m ${bars15m.length}, 1h ${bars1h.length}), sarit`);
      continue;
    }

    let rows = 0;
    let simulated = 0;
    let nextAvailableTs = 0;

    for (let idx1h = REGIME_BARS_1H + 23; idx1h < bars1h.length; idx1h++) {
      const bar = bars1h[idx1h];
      // Non-overlapping windows per symbol: one observation = one independent 8h trade.
      if (bar.timestamp < nextAvailableTs) continue;

      const regimeWindow = bars1h.slice(idx1h - REGIME_BARS_1H + 1, idx1h + 1);
      const last24h = bars1h.slice(idx1h - 23, idx1h + 1);
      const close15m = bars15m.filter((k) => k.timestamp + 900_000 <= bar.timestamp + 1);
      if (close15m.length < 48) continue;

      const ticker: AgentUniverseTicker = {
        instId: meta.instId,
        lastPrice: bar.close,
        turnover24hUSDT: meta.turnoverUsd,
        priceChange24hPct: ((bar.close - last24h[0].close) / last24h[0].close) * 100,
        high24h: Math.max(...last24h.map((k) => k.high)),
        low24h: Math.min(...last24h.map((k) => k.low)),
        spreadPct: SPREAD,
      };

      const row = buildAgentOpportunity({
        spec: meta,
        ticker,
        klines15m: close15m.slice(-48),
        klines1h: regimeWindow,
        book: { depthUsd: 1_000_000, imbalance: 0 },
        settings: {
          budgetPerBotUSDT: BUDGET,
          maxLeverage: LEVER,
          hardStopLossPct: HARD_STOP,
          roundTripFeePct: FEE,
          universeScanMode: 'pool',
        },
      });
      if (!row || !row.isEligible) continue;

      const adx = row.adxTrendStrength;
      const chop = row.choppinessIndex;
      if (!Number.isFinite(adx as number)) continue;
      rows++;

      // Everything EXCEPT the regime gate must pass — otherwise this hour says nothing about ADX.
      const crossings = Number(row.crossingsPerHour) || 0;
      const er = row.efficiencyRatio;
      const erOk = !isDisplacedRegime(typeof er === 'number' ? er : null);
      if (crossings < MIN_CROSSINGS || !erOk) continue;

      const bucketDef = BUCKETS.find((b) => b.test(adx as number));
      if (!bucketDef) continue;

      // The trade window: the horizon the band was sized on.
      const windowBars = bars15m.filter(
        (k) => k.timestamp >= bar.timestamp && k.timestamp < bar.timestamp + HORIZON_H * 3_600_000
      );
      if (windowBars.length < 8) continue;

      // A single lot must fit inside the buying power, otherwise the simulation measures a
      // sizing artefact (1 lot forced on every level) instead of the strategy. This is the same
      // constraint the live scan flags as `requiresLiveProbe`.
      const minLotNotional = meta.minSz * meta.ctVal * bar.close;
      if (minLotNotional > BUDGET * LEVER) {
        unaffordable++;
        continue;
      }

      const config = createDefaultBotConfig(
        meta.instId,
        row.minPx,
        row.maxPx,
        row.gridNum,
        'ARITHMETIC',
        row.lever,
        BUDGET,
        HARD_STOP,
        TAKE_PROFIT
      );

      let result;
      try {
        result = GridBacktestEngine.runSimulation(windowBars, config, [], {
          lotFilter: {
            symbol: meta.instId,
            minOrderQty: meta.minSz,
            maxOrderQty: 1_000_000,
            qtyStep: meta.lotSz,
            minNotionalValue: 1,
            tickSize: meta.tickSz,
            // Without this the engine reads 1 contract as 1 whole coin: at BTC that is a
            // ~62000$ position on a 12$ margin, which is how a "+1338% in 8h" gets produced.
            ctVal: meta.ctVal,
          } as any,
          customMakerFeeRate: FEE / 2 / 100,
        });
      } catch {
        continue;
      }

      nextAvailableTs = bar.timestamp + HORIZON_H * 3_600_000;
      simulated++;
      const b = buckets.get(bucketDef.label)!;
      b.n++;
      b.netPct.push(result.netPnLPct);
      if (result.netPnLPct > 0) b.wins++;
      b.gridProfit += result.gridProfitUSDT;
      b.fees += result.totalFeesUSDT;
      b.maxDd = Math.max(b.maxDd, result.maxDrawdownPct);
      b.breakouts += result.rangeBreakoutsAbove + result.rangeBreakoutsBelow;
      b.liquidated += result.wasLiquidated ? 1 : 0;
      b.cycles += result.completedCycles;
    }

    console.log(
      `  ${meta.instId.padEnd(32)} ore testabile ${String(rows).padStart(4)} | ` +
        `trade-uri simulate ${String(simulated).padStart(3)}`
    );
  }

  console.log('\n' + '='.repeat(100));
  console.log(`REZULTAT — ${HORIZON_H}h per trade, ferestre ne-suprapuse`);
  console.log(
    `  ore sarite: nici un lot nu incape in ${BUDGET * LEVER}$ buying power: ${unaffordable}\n`
  );
  console.log(
    '  ' +
      'BANDA ADX'.padEnd(30) +
      'n'.padStart(4) +
      'win%'.padStart(7) +
      'medie%'.padStart(9) +
      'median%'.padStart(9) +
      'p10%'.padStart(8) +
      'p90%'.padStart(8) +
      'worst%'.padStart(9) +
      'loss>5%'.padStart(9) +
      'maxDD%'.padStart(8)
  );
  for (const b of buckets.values()) {
    if (b.n === 0) {
      console.log('  ' + b.label.padEnd(30) + String(0).padStart(4) + '   (niciun esantion)');
      continue;
    }
    const avg = b.netPct.reduce((s, x) => s + x, 0) / b.n;
    const sorted = [...b.netPct].sort((a, x) => a - x);
    const pct = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
    const bigLosses = sorted.filter((x) => x < -5).length;
    console.log(
      '  ' +
        b.label.padEnd(30) +
        String(b.n).padStart(4) +
        `${Math.round((b.wins / b.n) * 100)}%`.padStart(7) +
        avg.toFixed(3).padStart(9) +
        median(b.netPct).toFixed(3).padStart(9) +
        pct(0.1).toFixed(2).padStart(8) +
        pct(0.9).toFixed(2).padStart(8) +
        sorted[0].toFixed(2).padStart(9) +
        String(bigLosses).padStart(9) +
        b.maxDd.toFixed(1).padStart(8)
    );
  }

  console.log('\nVERDICT (pe esantioanele de mai sus):');
  const accepted = buckets.get(BUCKETS[0].label)!;
  const refused = BUCKETS.slice(1).map((d) => buckets.get(d.label)!);
  const refusedAll = refused.reduce(
    (acc, b) => ({ n: acc.n + b.n, sum: acc.sum + b.netPct.reduce((s, x) => s + x, 0) }),
    { n: 0, sum: 0 }
  );
  const avgAcc = accepted.n ? accepted.netPct.reduce((s, x) => s + x, 0) / accepted.n : 0;
  const avgRef = refusedAll.n ? refusedAll.sum / refusedAll.n : 0;
  console.log(
    `  poarta deschisa : n=${accepted.n}, medie ${avgAcc.toFixed(3)}%/trade, ` +
      `win ${accepted.n ? Math.round((accepted.wins / accepted.n) * 100) : 0}%`
  );
  console.log(
    `  refuzate de ADX : n=${refusedAll.n}, medie ${avgRef.toFixed(3)}%/trade ` +
      `(pragul actual: ADX>${GRID_ADX_TREND_SELECTION} sau chop<${GRID_CHOP_TREND_SELECTION})`
  );
  if (refusedAll.n === 0) {
    console.log('  -> fara esantioane refuzate: nu se poate concluziona nimic despre prag.');
  } else if (avgAcc <= 0 && avgRef <= 0) {
    // The important case, and the one a naive script gets wrong: "refused lost money" is NOT
    // evidence for the gate when the ACCEPTED population also lost money. A filter earns its
    // keep by SEPARATING outcomes, not by being negative on both sides.
    console.log(
      '  -> AMBELE pierd: pragul nu separa profit de pierdere, doar filtreaza. ' +
        'Relaxarea lui nu aduce profit; nici mentinerea lui nu aduce profit.'
    );
  } else if (avgRef < avgAcc) {
    console.log('  -> refuzatele castiga mai putin decat cele acceptate: pragul are sens economic.');
  } else {
    console.log('  -> refuzatele castiga CEL PUTIN la fel de mult: pragul taie profit, nu risc.');
  }
  console.log(
    '  atentie: spread-ul (%.2f%%) si adancimea sunt PRESUPUSE, funding 0; ' +
      'presupuneri optimiste => cifrele reale sunt mai proaste, nu mai bune.',
    SPREAD
  );
  console.log('');
})();
