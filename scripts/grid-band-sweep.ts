/**
 * BALEEAREA GEOMETRIEI — care parametri taie coada stanga fara sa omoare mediana?
 *
 * Backtestul pe benzi de ADX (`grid-adx-pnl-backtest.ts`) a aratat ca problema nu e poarta de
 * regim: TOATE benzile pierd in medie, inclusiv cea acceptata. Ce diferentiaza categoriile nu e
 * media, ci coada: mediana e +0.1..+0.3%/trade, dar cele mai proaste trade-uri pierd -21% si -28%.
 * Deci intrebarea corecta nu mai e "cand intram", ci "cu ce geometrie intram".
 *
 * Scriptul asta ia exact multimea de ferestre in care toate portile NON-regim trec (aceeasi
 * populatie ca backtestul de ADX, ca rezultatele sa fie comparabile) si ruleaza aceeasi simulare
 * din productie pentru fiecare combinatie de:
 *
 *   - latimea benzii   (scalata in jurul centrului scanului: 0.7x / 1.0x / 1.3x / 1.6x)
 *   - stop loss        (6% / 8% / 12% din pret)
 *   - take profit      (8% / 15% / 100% = practic inexistent)
 *
 * Geometria grilei (gridNum) ramane cea aleasa de scan: altfel am amesteca doua variabile si
 * n-as mai sti care a produs diferenta.
 *
 * Se raporteaza mediana, media, p10, cel mai prost trade si rata de castig pentru FIECARE varianta,
 * plus baseline-ul configului actual, ca sa se vada daca o schimbare merita.
 *
 * Ce NU se poate reconstrui (declarat, nu ascuns): spread-ul si adancimea top-of-book nu au istoric
 * public -> se folosesc presupunerile din celelalte doua scripturi; funding 0.
 *
 * LIMITARE CRITICA, gasita la prima rulare a acestei baleieri:
 *   `GridBacktestEngine.runSimulation` NU citeste `config.risk.stopLossPct`,
 *   `config.risk.takeProfitPct` si `config.risk.stopOnRangeBreakout`. Acele campuri exista in
 *   `NeutralGridBotConfig` si sunt setate de `createDefaultBotConfig`, dar motorul le ignora:
 *   numara `rangeBreakoutsAbove/Below` fara sa actioneze pe ele. Dovada empirica: cele trei
 *   valori de stop (6/8/12%) si cele trei de tp (8/15/100%) produc rezultate IDENTICE.
 *   Consecinta: coloanele `stop` si `tp` din tabel sunt decorative, iar `worst%` descrie o grila
 *   lasata sa ruleze fara nicio protectie - nu ce face botul live (care are stop de breakout,
 *   hard stop si watchdog). Pana nu se rezolva asta, baleierea are O singura dimensiune valida:
 *   latimea benzii (`mult`).
 *
 * Run:
 *   npx tsx scripts/grid-band-sweep.ts --days=14 --symbols=15
 *   npx tsx scripts/grid-band-sweep.ts --days=21 --symbols=20 --horizon=8
 */

import { isTradableXPerp } from '../src/server/scanner/UniverseManager';
import { buildAgentOpportunity, type AgentUniverseTicker } from '../src/server/agent/AgentUniverseScan';
import { isDisplacedRegime } from '../src/server/engine/grid/gridRegime';
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
const SYMBOLS = Math.max(2, Math.min(40, Number(args.get('symbols')) || 15));
const FEE = Number(args.get('fee')) || 0.08;
const BUDGET = Number(args.get('budget')) || 12;
const LEVER = Number(args.get('lever')) || 2;
const SPREAD = Number(args.get('spread')) || 0.05;
const MIN_CROSSINGS = Number(args.get('mincross')) || 0.3;
const HORIZON_H = Math.max(1, Math.min(48, Number(args.get('horizon')) || 8));

/** The search space. Deliberately small: 36 cells, so a "winner" is not a fitted fluke. */
const BAND_MULTS = [0.7, 1.0, 1.3, 1.6];
const STOPS = [6, 8, 12];
const TPS = [8, 15, 100];
/** The live configuration, so every row can be compared against what the bot actually does. */
const BASELINE = { mult: 1.0, stop: 12, tp: 15 };

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

/** One simulated trade, kept so the aggregation can compute tails and profit factor. */
interface TradeOutcome {
  netPct: number;
  maxDd: number;
  cycles: number;
}

interface Variant {
  key: string;
  mult: number;
  stop: number;
  tp: number;
  trades: TradeOutcome[];
}

interface Window {
  instId: string;
  meta: ContractMeta;
  minPx: number;
  maxPx: number;
  gridNum: number;
  lever: number;
  bars: Kline[];
}

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const variantKey = (mult: number, stop: number, tp: number) => `band x${mult} | stop ${stop}% | tp ${tp}%`;

(async () => {
  console.log(
    `BALEEARE GEOMETRIE | ${DAYS} zile | top ${SYMBOLS} X-Perp | orizont ${HORIZON_H}h\n` +
      `  buget ${BUDGET}$ | lev ${LEVER}x | fee ${FEE}% | spread ${SPREAD}% (presupus)\n` +
      `  populatie: doar orele cu TOATE portile non-regim trecute (crossings>=${MIN_CROSSINGS}/h, ER<=0.4)\n` +
      `  variante: ${BAND_MULTS.length} latimi x ${STOPS.length} stopuri x ${TPS.length} tp = ` +
      `${BAND_MULTS.length * STOPS.length * TPS.length}\n`
  );

  const universe = await loadUniverse();
  const picked = universe.slice(0, SYMBOLS);
  console.log(`univers: ${universe.length} X-Perp-uri live, baleiere pe ${picked.length}\n`);

  const windows: Window[] = [];

  // --- pass 1: collect the testable windows (regime gate NOT applied: we are testing geometry) --
  for (const meta of picked) {
    let bars15m: Kline[] = [];
    let bars1h: Kline[] = [];
    try {
      [bars15m, bars1h] = await Promise.all([
        fetchHistory(meta.instId, '15m', DAYS * 96 + HORIZON_H * 4 + 8, 140),
        fetchHistory(meta.instId, '1H', DAYS * 24 + REGIME_BARS_1H + 2, 140),
      ]);
    } catch (err: any) {
      console.log(`  ${meta.instId}: fetch esuat (${err?.message}), sarit`);
      continue;
    }
    if (bars15m.length < 48 || bars1h.length < REGIME_BARS_1H + 24) {
      console.log(`  ${meta.instId}: istoric insuficient, sarit`);
      continue;
    }

    let found = 0;
    let nextAvailableTs = 0;
    for (let idx1h = REGIME_BARS_1H + 23; idx1h < bars1h.length; idx1h++) {
      const bar = bars1h[idx1h];
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
          hardStopLossPct: 12,
          roundTripFeePct: FEE,
          universeScanMode: 'pool',
        },
      });
      if (!row || !row.isEligible) continue;

      const crossings = Number(row.crossingsPerHour) || 0;
      const er = row.efficiencyRatio;
      const erOk = !isDisplacedRegime(typeof er === 'number' ? er : null);
      if (crossings < MIN_CROSSINGS || !erOk) continue;

      const minLotNotional = meta.minSz * meta.ctVal * bar.close;
      if (minLotNotional > BUDGET * LEVER) continue;

      const windowBars = bars15m.filter(
        (k) => k.timestamp >= bar.timestamp && k.timestamp < bar.timestamp + HORIZON_H * 3_600_000
      );
      if (windowBars.length < 8) continue;

      windows.push({
        instId: meta.instId,
        meta,
        minPx: row.minPx,
        maxPx: row.maxPx,
        gridNum: row.gridNum,
        lever: row.lever,
        bars: windowBars,
      });
      // Non-overlapping per symbol, so 8 windows never share the same hour.
      nextAvailableTs = bar.timestamp + HORIZON_H * 3_600_000;
      found++;
    }
    console.log(`  ${meta.instId.padEnd(32)} ferestre testabile ${String(found).padStart(3)}`);
  }

  if (windows.length === 0) {
    console.log('\nNicio fereastra testabila — nimic de baleiat.');
    return;
  }
  console.log(`\nTOTAL ferestre: ${windows.length} — rulez ${windows.length * BAND_MULTS.length * STOPS.length * TPS.length} simulari\n`);

  // --- pass 2: every variant on every window ------------------------------------------------
  const variants = new Map<string, Variant>();
  for (const mult of BAND_MULTS) {
    for (const stop of STOPS) {
      for (const tp of TPS) {
        const key = variantKey(mult, stop, tp);
        variants.set(key, { key, mult, stop, tp, trades: [] });
      }
    }
  }

  for (const w of windows) {
    const center = (w.minPx + w.maxPx) / 2;
    const half = ((w.maxPx - w.minPx) / 2) || center * 0.01;

    for (const mult of BAND_MULTS) {
      const lowerPrice = Math.max(center * 0.5, center - half * mult);
      const upperPrice = center + half * mult;
      if (!(lowerPrice > 0) || !(upperPrice > lowerPrice)) continue;

      for (const stop of STOPS) {
        for (const tp of TPS) {
          const config = createDefaultBotConfig(
            w.meta.instId,
            lowerPrice,
            upperPrice,
            w.gridNum,
            'ARITHMETIC',
            w.lever,
            BUDGET,
            stop,
            tp
          );
          let result;
          try {
            result = GridBacktestEngine.runSimulation(w.bars, config, [], {
              lotFilter: {
                symbol: w.meta.instId,
                minOrderQty: w.meta.minSz,
                maxOrderQty: 1_000_000,
                qtyStep: w.meta.lotSz,
                minNotionalValue: 1,
                tickSize: w.meta.tickSz,
                ctVal: w.meta.ctVal,
              } as any,
              customMakerFeeRate: FEE / 2 / 100,
            });
          } catch {
            continue;
          }
          variants
            .get(variantKey(mult, stop, tp))!
            .trades.push({
              netPct: result.netPnLPct,
              maxDd: result.maxDrawdownPct,
              cycles: result.completedCycles,
            });
        }
      }
    }
  }

  interface Summary {
    key: string;
    mult: number;
    stop: number;
    tp: number;
    n: number;
    mean: number;
    med: number;
    p10: number;
    worst: number;
    win: number;
    bigLosses: number;
    avgDd: number;
    profitFactor: number;
    total: number;
  }

  const summaries: Summary[] = [];
  for (const v of variants.values()) {
    if (v.trades.length === 0) continue;
    const nets = v.trades.map((t) => t.netPct);
    const sorted = [...nets].sort((a, b) => a - b);
    const gains = nets.filter((x) => x > 0).reduce((s, x) => s + x, 0);
    const losses = nets.filter((x) => x < 0).reduce((s, x) => s + x, 0);
    summaries.push({
      key: v.key,
      mult: v.mult,
      stop: v.stop,
      tp: v.tp,
      n: nets.length,
      mean: nets.reduce((s, x) => s + x, 0) / nets.length,
      med: median(nets),
      p10: sorted[Math.floor(0.1 * sorted.length)],
      worst: sorted[0],
      win: (nets.filter((x) => x > 0).length / nets.length) * 100,
      bigLosses: nets.filter((x) => x < -5).length,
      avgDd: v.trades.reduce((s, t) => s + t.maxDd, 0) / v.trades.length,
      profitFactor: losses === 0 ? Infinity : gains / Math.abs(losses),
      total: nets.reduce((s, x) => s + x, 0),
    });
  }

  const printRow = (s: Summary, mark = ' ') => {
    console.log(
      `${mark} ` +
        `x${String(s.mult).padEnd(4)}`.padEnd(7) +
        `${String(s.stop)}%`.padStart(5) +
        `${String(s.tp)}%`.padStart(6) +
        String(s.n).padStart(6) +
        `${Math.round(s.win)}%`.padStart(7) +
        s.mean.toFixed(3).padStart(9) +
        s.med.toFixed(3).padStart(9) +
        s.p10.toFixed(2).padStart(8) +
        s.worst.toFixed(2).padStart(9) +
        String(s.bigLosses).padStart(7) +
        s.avgDd.toFixed(1).padStart(8) +
        (Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : 'inf').padStart(8) +
        s.total.toFixed(1).padStart(10)
    );
  };

  const header =
    '  ' +
    'banda'.padEnd(7) +
    'stop'.padStart(5) +
    'tp'.padStart(6) +
    'n'.padStart(6) +
    'win%'.padStart(7) +
    'medie%'.padStart(9) +
    'median%'.padStart(9) +
    'p10%'.padStart(8) +
    'worst%'.padStart(9) +
    'loss>5'.padStart(7) +
    'maxDD%'.padStart(8) +
    'PF'.padStart(8) +
    'total%'.padStart(10);

  console.log('='.repeat(100));
  console.log('TOATE VARIANTELE, sortate dupa MEDIE (castigul mediu per trade):\n');
  console.log(header);
  const byMean = [...summaries].sort((a, b) => b.mean - a.mean);
  for (const s of byMean) {
    const isBase = s.mult === BASELINE.mult && s.stop === BASELINE.stop && s.tp === BASELINE.tp;
    printRow(s, isBase ? '>' : ' ');
  }

  const base = summaries.find(
    (s) => s.mult === BASELINE.mult && s.stop === BASELINE.stop && s.tp === BASELINE.tp
  );

  console.log('\n' + '='.repeat(100));
  console.log(`BASELINE (configul live: banda x${BASELINE.mult}, stop ${BASELINE.stop}%, tp ${BASELINE.tp}%):`);
  if (base) printRow(base, '>');
  else console.log('  (n/a)');

  console.log('\nCE TAIE COADA (worst >= -12% si medie maxima), adica exact intrebarea pusa:');
  console.log(header);
  const tailSafe = summaries
    .filter((s) => s.worst >= -12)
    .sort((a, b) => b.mean - a.mean)
    .slice(0, 10);
  if (tailSafe.length === 0) console.log('  nicio varianta nu tine cel mai prost trade peste -12%');
  for (const s of tailSafe) printRow(s);

  console.log('\nVERDICT:');
  if (!base) {
    console.log('  baseline indisponibil — nu se poate compara.');
  } else {
    const best = byMean[0];
    const improvement = best.mean - base.mean;
    console.log(
      `  baseline: medie ${base.mean.toFixed(3)}%/trade, median ${base.med.toFixed(3)}%, ` +
        `worst ${base.worst.toFixed(2)}%, loss>5% ${base.bigLosses}/${base.n}`
    );
    console.log(
      `  cea mai buna medie: ${best.key} -> ${best.mean.toFixed(3)}%/trade ` +
        `(+${improvement.toFixed(3)} fata de baseline), worst ${best.worst.toFixed(2)}%`
    );
    if (best.mean <= 0) {
      console.log('  -> NICIO varianta nu e profitabila in medie: geometria nu e levierul care lipsea.');
    } else if (best.worst < base.worst) {
      console.log('  -> castigul mediu urca, dar coada se Adanceste: e un schimb, nu o imbunatatire.');
    } else {
      console.log('  -> exista o varianta cu medie mai buna SI coada mai putin rea: candidat real.');
    }
  }
  console.log('');
})();
