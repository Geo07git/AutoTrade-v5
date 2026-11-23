/**
 * Confruntarea politicilor de iesire -- READ-ONLY, fara OKX privat, fara scriere.
 *
 * Intrebarea la care raspunde (docs/audit-2026-11-14.md):
 *   net -7.79 = motor +7.53 - fees 2.09 - iesiri 13.23
 * Toate cele 89 de opriri inregistrate au fost `stopType '1'` = close at market. `stopType '2'`
 * (nu inchide pozitia) exista in cod si nu a fost folosit NICIODATA. Deci nu stim daca motorul
 * pierde, sau doar felul in care iese pierde -- pentru ca a doua varianta nu a fost masurata.
 *
 * Metoda: acelasi grid, aceleasi lumanari reale 15m de la OKX EEA, trei politici de iesire:
 *   MARKET_STOP    - close la marginea benzii (exact ce a rulat 7 zile)
 *   HOLD           - nu inchide pe banda; ramane expus la stop-ul de marja si la lichidare
 *   HOLD_BACKSTOP  - nu inchide pe banda; inchide doar dincolo de un buffer (stop conditional
 *                    reduce-only plasat la bursa, ca in okxConditionalStop.ts)
 *
 * Ce NU face: nu atinge `.data/`, nu scrie fisiere, nu vorbeste cu API-ul privat.
 *
 * Run: npm run grid-exit
 */

import { GridBacktestEngine, createDefaultBotConfig } from '../src/server/research/GridBacktestEngine';
import { GridOptimizer } from '../src/server/engine/grid/GridOptimizer';
import type { Kline } from '../src/shared/types';

const BASE = 'https://eea.okx.com';

/** X-Perp vii (verificat: instType=FUTURES, 265 contracte). Doar crypto, fara stock tokens. */
const SYMBOLS = [
  'BTC-USD_UM_XPERP-310404',
  'ETH-USD_UM_XPERP-310404',
  'SOL-USD_UM_XPERP-310404',
  'XRP-USD_UM_XPERP-310404',
  'DOGE-USD_UM_XPERP-310404',
];

const BARS_TARGET = 1440; // ~15 zile la 15m
const BAND_PCT = Number(process.argv[3]) || 3; // mijlocul intervalului 2-6% din gridBand.ts
const GRID_COUNT = Number(process.argv[4]) || 6;
const LEVERAGE = 2;
const MARGIN_USDT = 12; // bugetul real per bot din config
const STOP_LOSS_PCT_OF_MARGIN = Number(process.argv[2]) || 20; // suficient de larg ca sa nu mascheze efectul benzii
const TAKE_PROFIT_PCT = 0; // dezactivat: nu e subiectul testului
const BACKSTOP_PCT = 1.5; // dincolo de marginea benzii

type Policy = 'MARKET_STOP' | 'HOLD' | 'HOLD_BACKSTOP';

const POLICIES: Array<{ policy: Policy; label: string }> = [
  { policy: 'MARKET_STOP', label: 'close la banda  (ce a rulat 7 zile)' },
  { policy: 'HOLD', label: 'hold pur        (stopType 2)' },
  { policy: 'HOLD_BACKSTOP', label: `hold + backstop (${BACKSTOP_PCT}% dincolo)` },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson(path: string): Promise<any[]> {
  const res = await fetch(`${BASE}${path}`, { headers: { 'Content-Type': 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${path}`);
  const body: any = await res.json();
  if (String(body?.code) !== '0') throw new Error(`OKX ${body?.code}: ${body?.msg} on ${path}`);
  return Array.isArray(body?.data) ? body.data : [];
}

/** Lumanari 15m, ascendente, fara duplicate. `after` pagineaza in trecut. */
async function fetchCandles(instId: string, target: number): Promise<Kline[]> {
  const byTs = new Map<number, Kline>();
  let after: string | undefined;
  let guard = 0;

  while (byTs.size < target && guard++ < 40) {
    const limit = after ? '300' : '300';
    const qs = new URLSearchParams({ instId, bar: '15m', limit });
    if (after) qs.set('after', after);
    let rows = await getJson(`/api/v5/market/candles?${qs.toString()}`);
    if (!rows.length && after) {
      const qh = new URLSearchParams({ instId, bar: '15m', limit: '100', after });
      rows = await getJson(`/api/v5/market/history-candles?${qh.toString()}`);
    }
    if (!rows.length) break;
    for (const r of rows) {
      const ts = Number(r[0]);
      if (!Number.isFinite(ts) || byTs.has(ts)) continue;
      const k: Kline = {
        timestamp: ts,
        open: Number(r[1]),
        high: Number(r[2]),
        low: Number(r[3]),
        close: Number(r[4]),
        volume: Number(r[5]),
      };
      if (k.close > 0) byTs.set(ts, k);
    }
    after = String(rows[rows.length - 1][0]);
    await sleep(120);
  }

  return Array.from(byTs.values()).sort((a, b) => a.timestamp - b.timestamp);
}

interface InstrumentSpec {
  ctVal: number;
  lotSz: number;
  minSz: number;
  tickSz: number;
}

async function fetchSpec(instId: string): Promise<InstrumentSpec> {
  const rows = await getJson(`/api/v5/public/instruments?instType=FUTURES&instId=${encodeURIComponent(instId)}`);
  const r = rows[0];
  if (!r) throw new Error(`instrument inexistent: ${instId}`);
  return {
    ctVal: Number(r.ctVal) || 1,
    lotSz: Number(r.lotSz) || 1,
    minSz: Number(r.minSz) || 1,
    tickSz: Number(r.tickSz) || 0.0001,
  };
}

const fmt = (n: number, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : 'n/a');
const sign = (n: number, d = 2) => `${n >= 0 ? '+' : ''}${fmt(n, d)}`;

interface Row {
  symbol: string;
  policy: Policy;
  trips: number;
  realized: number;
  floating: number;
  fees: number;
  exitReason: string;
  net: number;
  netPct: number;
  liq: boolean;
}

async function main() {
  console.log('Politici de iesire -- grid neutral, lumanari reale 15m, parametri identici.\n');
  console.log(
    `Banda +-${BAND_PCT}% | ${GRID_COUNT} nivele | levier ${LEVERAGE}x | marja ${MARGIN_USDT} USDT | ` +
      `stop ${STOP_LOSS_PCT_OF_MARGIN}% din marja | TP off\n`
  );

  const rows: Row[] = [];

  for (const symbol of SYMBOLS) {
    let klines: Kline[] = [];
    let spec: InstrumentSpec | null = null;
    try {
      spec = await fetchSpec(symbol);
      klines = await fetchCandles(symbol, BARS_TARGET);
    } catch (err: any) {
      console.log(`${symbol.padEnd(30)} SKIP: ${err?.message || err}`);
      continue;
    }
    if (klines.length < 100) {
      console.log(`${symbol.padEnd(30)} SKIP: doar ${klines.length} lumanari`);
      continue;
    }

    const first = klines[0].close;
    const lower = first * (1 - BAND_PCT / 100);
    const upper = first * (1 + BAND_PCT / 100);
    const lotFilter = {
      symbol,
      minOrderQty: spec.minSz,
      maxOrderQty: 1_000_000,
      qtyStep: spec.lotSz,
      minNotionalValue: 1,
      tickSize: spec.tickSz,
      ctVal: spec.ctVal,
    };

    const cfg = createDefaultBotConfig(
      symbol,
      lower,
      upper,
      GRID_COUNT,
      'ARITHMETIC',
      LEVERAGE,
      MARGIN_USDT,
      STOP_LOSS_PCT_OF_MARGIN,
      TAKE_PROFIT_PCT
    );

    // Bugetul chiar incape? Un contract X-Perp are o valoare fixa; daca 1 contract depaseste
    // nivelul, GridOptimizer il ridica la minSz si gridul iese supradimensionat.
    const geo = GridOptimizer.calculateGrid(cfg, first, lotFilter);
    const exposure = geo.levels.reduce((s, l) => s + l.qtyContracts * spec!.ctVal * l.price, 0);
    const budget = MARGIN_USDT * LEVERAGE;
    const tight = exposure > budget * 1.05;

    const days = ((klines[klines.length - 1].timestamp - klines[0].timestamp) / 86_400_000).toFixed(1);
    console.log(
      `${symbol}  ${String(klines.length).padStart(5)} bare / ${days} zile  ` +
        `expunere ${fmt(exposure)} USDT din buget ${fmt(budget)}` +
        (tight ? '  <-- NU INCAPE (minSz forteaza supradimensionare)' : '')
    );

    for (const { policy } of POLICIES) {
      const r = GridBacktestEngine.runSimulation(klines, cfg, [], {
        lotFilter,
        exitPolicy: policy,
        rangeStopBufferPct: 0,
        backstopBufferPct: BACKSTOP_PCT,
        conservativeFills: true,
      });
      rows.push({
        symbol,
        policy,
        trips: r.completedCycles,
        realized: r.gridProfitUSDT,
        floating: r.floatingPnLUSDT,
        fees: r.totalFeesUSDT,
        exitReason: r.wasLiquidated ? 'LIQUIDATION' : r.exitReason,
        net: r.netPnLUSDT,
        netPct: r.netPnLPct,
        liq: r.wasLiquidated,
      });
    }
  }

  console.log('\n-- per simbol si politica ----------------------------------------------------------------');
  console.log('simbol                          politica         trips   realizat  flotant     fees     iesire        net');
  console.log('-'.repeat(120));
  for (const r of rows) {
    console.log(
      [
        r.symbol.padEnd(30).slice(0, 30),
        r.policy.padEnd(15),
        String(r.trips).padStart(6),
        fmt(r.realized).padStart(10),
        fmt(r.floating).padStart(9),
        fmt(r.fees).padStart(8),
        r.exitReason.slice(0, 13).padStart(13),
        `${sign(r.net)} (${sign(r.netPct, 1)}%)`.padStart(16),
      ].join('  ')
    );
  }

  console.log('\n-- agregat pe politica ------------------------------------------------------------------');
  for (const { policy, label } of POLICIES) {
    const mine = rows.filter((r) => r.policy === policy);
    if (!mine.length) continue;
    const net = mine.reduce((s, r) => s + r.net, 0);
    const realized = mine.reduce((s, r) => s + r.realized, 0);
    const fees = mine.reduce((s, r) => s + r.fees, 0);
    const trips = mine.reduce((s, r) => s + r.trips, 0);
    const liq = mine.filter((r) => r.liq).length;
    const worst = mine.reduce((m, r) => Math.min(m, r.net), 0);
    console.log(
      `${policy.padEnd(15)} ${label.padEnd(36)} trips ${String(trips).padStart(5)}  ` +
        `realizat ${sign(realized).padStart(8)}  fees ${fmt(fees).padStart(7)}  ` +
        `net ${sign(net).padStart(8)} USDT  cel mai rau ${sign(worst).padStart(8)}` +
        (liq ? `  LICHIDARI ${liq}` : '')
    );
  }

  console.log(
    '\nCitire: "realizat" include si inchiderea fortata (motorul o adauga in realizedGridProfit), ' +
      'deci NU e captura dinainte de iesire. "flotant" e pozitia ramasa deschisa la finalul datelor.\n' +
      '        Daca HOLD iese sub MARKET_STOP, ideea ca am pierdut doar din felul in care iese e falsa.\n' +
      '        Daca HOLD iese peste, cele -13.23 USDT din audit erau cost de iesire, nu de strategie.'
  );
}

main().catch((err) => {
  console.error('Eroare:', err?.message || err);
  process.exit(1);
});
