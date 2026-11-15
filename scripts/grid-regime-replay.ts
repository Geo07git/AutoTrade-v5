/**
 * REPLAY POARTA DE REGIM -- read-only, zero creden?iale, zero ordine.
 *
 * Intrebarea la care raspunde: "cate deschideri ar fi permis poarta de regim in ultimele N zile?"
 * fara sa asteptam ca piata sa ofere 20 de intrari reale.
 *
 * Ce face: descarca lumAnari 1H publice pentru top-N X-Perp-uri (dupa turnover) si, pentru fiecare
 * ora din fereastra, ruleaza EXACT functiile din cod -- `wilderAdx`, `choppinessIndex`,
 * `hasDirectionalPressure`, `isDisplacedRegime` -- pe fereastra care se termina in acea ora. Nu
 * exista o a doua implementare a por?ii aici: daca regula se schimba in cod, replay-ul se schimba
 * cu ea.
 *
 * Ce NU poate reproduce (si de ce cifrele sunt o limita superioara, nu o promisiune):
 *   - spread si adAncimea top-of-book nu au istoric public -> por?ile de lichiditate nu se pot
 *     evalua retroactiv (in live au trecut, deci nu ingusteaza rezultatul);
 *   - ER se calculeaza in app pe 32 bare de 15m (8h). Aici folosim 8 bare de 1h (acela?i orizont,
 *     e?antionare mai grosiera) -- aproximare declarata, nu echivalenta;
 *   - confirmarea pe doua scanari (30 min) e aproximata prin "fereastra de minim o ora", care
 *     garanteaza cel pu?in doua scanari consecutive in care poarta e deschisa.
 *
 * Run:
 *   npx tsx scripts/grid-regime-replay.ts                    # 30 zile, top 25
 *   npx tsx scripts/grid-regime-replay.ts --days=60 --symbols=40
 */

import { isTradableXPerp } from '../src/server/scanner/UniverseManager';
import { AGENT_SCAN_REGIME_BARS_1H } from '../src/server/agent/AgentUniverseScan';
import {
  choppinessIndex,
  efficiencyRatioFromKlines,
  hasDirectionalPressure,
  isDisplacedRegime,
  wilderAdx,
  GRID_ADX_TREND_SELECTION,
  GRID_CHOP_TREND_SELECTION,
  GRID_ER_SCAN_BARS,
} from '../src/server/engine/grid/gridRegime';
import type { Kline } from '../src/shared/types';

const BASE = 'https://www.okx.com';
const BAR_HOURS = 1;
/** The pre-fix fetch length: what the gate was actually reading until now. */
const OLD_REGIME_BARS_1H = 24;
/** ER is measured on 32 x 15m = 8h in the app; replay it on 8 x 1h = the same horizon. */
const ER_REPLAY_BARS_1H = Math.round(GRID_ER_SCAN_BARS / 4);

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  })
);
const DAYS = Math.max(3, Math.min(180, Number(args.get('days')) || 30));
const SYMBOLS = Math.max(3, Math.min(60, Number(args.get('symbols')) || 25));
const BARS_PER_DAY = 24 / BAR_HOURS;
const WANT_BARS = Math.round(DAYS * BARS_PER_DAY);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function okxGet(path: string, attempt = 1): Promise<any> {
  try {
    const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(20_000) });
    const json: any = await res.json();
    if (json?.code === '0') return json;
    // 50011 = rate limit, 50004/50001 = transient. Anything else is a real answer (empty data).
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

interface UniverseRow {
  instId: string;
  turnoverUsd: number;
  ctVal: number;
}

async function loadUniverse(): Promise<UniverseRow[]> {
  const [instruments, tickers] = await Promise.all([
    okxGet('/api/v5/public/instruments?instType=FUTURES'),
    okxGet('/api/v5/market/tickers?instType=FUTURES'),
  ]);
  const byId = new Map<string, any>((tickers.data || []).map((t: any) => [t.instId, t]));
  const rows: UniverseRow[] = [];
  for (const inst of instruments.data || []) {
    if (!isTradableXPerp(inst)) continue;
    const t = byId.get(inst.instId);
    if (!t) continue;
    const last = Number(t.last);
    const ctVal = Number(inst.ctVal) || 1;
    const turnoverUsd = Number(t.vol24h) * ctVal * last;
    if (!(last > 0) || !(turnoverUsd > 0)) continue;
    rows.push({ instId: inst.instId, turnoverUsd, ctVal });
  }
  rows.sort((a, b) => b.turnoverUsd - a.turnoverUsd);
  return rows;
}

/** 1H bars, oldest first, paginated backwards with `after`. */
async function fetchHistory(instId: string, want: number): Promise<Kline[]> {
  const out: Kline[] = [];
  let after: string | undefined;
  while (out.length < want) {
    const path =
      `/api/v5/market/history-candles?instId=${instId}&bar=1H&limit=100` +
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
    await sleep(80);
  }
  out.sort((a, b) => a.timestamp - b.timestamp);
  // Drop the last bar: it is still forming.
  return out.slice(0, -1).slice(-want);
}

interface SymbolReplay {
  instId: string;
  hours: number;
  passOld: number;
  passNew: number;
  passNoEr: number;
  adxMoved: number;
  runsOld: number;
  runsNew: number;
  last24hPass: number;
  last24hHours: number;
  /** Unix ms of the first hour of every window the CURRENT gate would have opened. */
  runStarts: number[];
  /** Same, for the pre-fix measurement (ADX on 24 bars). */
  runStartsOld: number[];
  /** dayKey -> symbol-hours / passing symbol-hours, for the per-day table. */
  byDay: Map<string, { hours: number; pass: number; runs: number }>;
}

const dayKey = (ts: number): string => new Date(ts).toISOString().slice(0, 10);

function replay(instId: string, bars: Kline[]): SymbolReplay {
  const minBars = Math.max(AGENT_SCAN_REGIME_BARS_1H, 16);
  const row: SymbolReplay = {
    instId,
    hours: 0,
    passOld: 0,
    passNew: 0,
    passNoEr: 0,
    adxMoved: 0,
    runsOld: 0,
    runsNew: 0,
    last24hPass: 0,
    last24hHours: 0,
    runStarts: [],
    runStartsOld: [],
    byDay: new Map(),
  };
  let prevNew = false;
  let prevOld = false;
  const lastIndex = bars.length - 1;

  for (let i = minBars; i <= lastIndex; i++) {
    const win = bars.slice(i - AGENT_SCAN_REGIME_BARS_1H + 1, i + 1);
    const winOld = win.slice(-OLD_REGIME_BARS_1H);
    const chop = choppinessIndex(win, 14);
    const adxNew = wilderAdx(win, 14);
    const adxOld = wilderAdx(winOld, 14);
    const er = efficiencyRatioFromKlines(
      bars.slice(Math.max(0, i - ER_REPLAY_BARS_1H + 1), i + 1),
      ER_REPLAY_BARS_1H
    );

    const regimeOld = !hasDirectionalPressure(adxOld, chop);
    const regimeNew = !hasDirectionalPressure(adxNew, chop);
    const erOk = !isDisplacedRegime(er);
    const passNew = regimeNew && erOk;
    const passOld = regimeOld && erOk;

    row.hours++;
    if (passOld) row.passOld++;
    if (passNew) row.passNew++;
    if (regimeNew) row.passNoEr++;
    if (adxNew !== null && adxOld !== null && Math.abs(adxNew - adxOld) > 3) row.adxMoved++;
    if (passOld && !prevOld) {
      row.runsOld++;
      row.runStartsOld.push(bars[i].timestamp);
    }
    if (passNew && !prevNew) {
      row.runsNew++;
      row.runStarts.push(bars[i].timestamp);
    }
    prevOld = passOld;
    prevNew = passNew;

    const key = dayKey(bars[i].timestamp);
    const bucket = row.byDay.get(key) || { hours: 0, pass: 0, runs: 0 };
    bucket.hours++;
    if (passNew) bucket.pass++;
    row.byDay.set(key, bucket);

    if (bars[lastIndex].timestamp - bars[i].timestamp < 24 * 3_600_000) {
      row.last24hHours++;
      if (passNew) row.last24hPass++;
    }
  }
  // A window is counted on the day it STARTS, so the per-day table sums to `runsNew`.
  for (const start of row.runStarts) {
    const key = dayKey(start);
    const bucket = row.byDay.get(key);
    if (bucket) bucket.runs++;
  }
  return row;
}

const pct = (n: number, d: number) => (d > 0 ? `${((n / d) * 100).toFixed(1)}%` : 'n/a');
const pad = (s: string | number, w: number) => String(s).padStart(w);

(async () => {
  console.log(
    `REPLAY poarta de regim | ${DAYS} zile | top ${SYMBOLS} X-Perp dupa turnover\n` +
      `  poarta actuala : ADX(${AGENT_SCAN_REGIME_BARS_1H} bare 1H) > ${GRID_ADX_TREND_SELECTION} ` +
      `SAU chop < ${GRID_CHOP_TREND_SELECTION} SAU ER(${ER_REPLAY_BARS_1H} bare 1H ~8h) > 0.4 -> refuz\n` +
      `  poarta veche   : acelasi lucru, dar ADX citit pe ${OLD_REGIME_BARS_1H} bare 1H (proxy DX brut)\n`
  );

  const universe = await loadUniverse();
  const picked = universe.slice(0, SYMBOLS);
  console.log(`univers: ${universe.length} X-Perp-uri live, rejucam ${picked.length}\n`);

  const results: SymbolReplay[] = [];
  for (const u of picked) {
    try {
      const bars = await fetchHistory(u.instId, WANT_BARS);
      if (bars.length < AGENT_SCAN_REGIME_BARS_1H + 2) {
        console.log(`  ${u.instId}: istoric insuficient (${bars.length} bare), sarit`);
        continue;
      }
      const r = replay(u.instId, bars);
      results.push(r);
      console.log(
        `  ${u.instId.padEnd(32)} ${pad(r.hours, 4)}h  ` +
          `vechi ${pad(pct(r.passOld, r.hours), 6)}  nou ${pad(pct(r.passNew, r.hours), 6)}  ` +
          `fara-ER ${pad(pct(r.passNoEr, r.hours), 6)}  ` +
          `ADX schimbat >3pct in ${pad(pct(r.adxMoved, r.hours), 6)} din ore  ` +
          `ferestre vechi/nou ${pad(r.runsOld, 3)}/${pad(r.runsNew, 3)}`
      );
    } catch (err: any) {
      console.log(`  ${u.instId}: ${err?.message || err}`);
    }
  }

  const totalHours = results.reduce((s, r) => s + r.hours, 0);
  const sumOld = results.reduce((s, r) => s + r.passOld, 0);
  const sumNew = results.reduce((s, r) => s + r.passNew, 0);
  const sumNoEr = results.reduce((s, r) => s + r.passNoEr, 0);
  const runsOld = results.reduce((s, r) => s + r.runsOld, 0);
  const runsNew = results.reduce((s, r) => s + r.runsNew, 0);
  const moved = results.reduce((s, r) => s + r.adxMoved, 0);
  const lastHours = results.reduce((s, r) => s + r.last24hHours, 0);
  const lastPass = results.reduce((s, r) => s + r.last24hPass, 0);
  const observedDays = Math.max(1, totalHours / results.length / BARS_PER_DAY);

  console.log(`\n${'='.repeat(96)}`);
  console.log(
    `TOTAL ${results.length} simboluri x ${(totalHours / Math.max(1, results.length)).toFixed(0)}h = ` +
      `${totalHours} symbol-ore (${observedDays.toFixed(1)} zile de piata per simbol)`
  );
  console.log(
    `  ADX masurat ca inainte (24 bare)  : poarta deschisa ${pct(sumOld, totalHours)} din ore, ` +
      `${runsOld} ferestre (${(runsOld / observedDays).toFixed(2)}/zi pe tot pool-ul)`
  );
  console.log(
    `  ADX Wilder real (${AGENT_SCAN_REGIME_BARS_1H} bare)    : poarta deschisa ${pct(sumNew, totalHours)} din ore, ` +
      `${runsNew} ferestre (${(runsNew / observedDays).toFixed(2)}/zi pe tot pool-ul)`
  );
  console.log(`  ADX s-a schimbat cu >3 puncte in ${pct(moved, totalHours)} din ore (marimea fix-ului)`);
  console.log(
    `  doar regimul, fara ER               : poarta deschisa ${pct(sumNoEr, totalHours)} din ore ` +
      `(ER taie restul: ${pct(sumNoEr - sumNew, sumNoEr)} din ferestrele de regim)`
  );
  console.log(
    `  ultimele 24h (toate simbolurile)    : ${pct(lastPass, lastHours)} din symbol-ore ar fi trecut`
  );
  const perDay = runsNew / observedDays;
  console.log(
    `\nVERDICT: la ${perDay.toFixed(2)} ferestre/zi (fiecare = cel putin 2 scanari consecutive),\n` +
      `         20 de deschideri = ~${perDay > 0 ? (20 / perDay).toFixed(1) : 'infinit'} zile de piata ` +
      `cu aceasta poarta.`
  );
  if (perDay > 0) {
    const capacity = 6; // 2 sloturi x orizont de 8h
    console.log(
      `         plafonul de capacitate e ~${capacity}/zi (2 sloturi x orizont 8h), ` +
        `deci poarta e ${perDay >= capacity ? 'peste' : 'sub'} capacitate.`
    );
  }

  // Per-day table: the average is not the story if the last days are an outlier.
  const days = new Map<string, { hours: number; pass: number; runs: number }>();
  for (const r of results) {
    for (const [key, v] of r.byDay) {
      const acc = days.get(key) || { hours: 0, pass: 0, runs: 0 };
      acc.hours += v.hours;
      acc.pass += v.pass;
      acc.runs += v.runs;
      days.set(key, acc);
    }
  }
  const ordered = [...days.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-14);
  console.log(`\nZILE (ultimele ${ordered.length})  ora-UTC   symbol-ore  trecere  ferestre  ferestre/zi-normalizat`);
  for (const [key, v] of ordered) {
    console.log(
      `  ${key}   ${pad(v.hours, 8)}   ${pad(pct(v.pass, v.hours), 7)}   ${pad(v.runs, 6)}   ` +
        `${pad(((v.runs / Math.max(1, v.hours)) * 24 * results.length).toFixed(1), 6)}/zi (pool intreg)`
    );
  }

  // Runs in the recent windows, which is what the live bot actually faced.
  const newest = Math.max(...results.flatMap((r) => r.runStarts), 0);
  for (const hours of [24, 48, 72]) {
    const from = newest - hours * 3_600_000;
    const runsOldRecent = results.flatMap((r) => r.runStartsOld).filter((ts) => ts >= from).length;
    const runs = results.flatMap((r) => r.runStarts).filter((ts) => ts >= from).length;
    console.log(
      `  ferestre in ultimele ${pad(hours, 2)}h: ${pad(runsOldRecent, 4)} cu ADX vechi (24 bare) / ` +
        `${pad(runs, 4)} cu ADX real (${AGENT_SCAN_REGIME_BARS_1H} bare)`
    );
  }
  console.log(`${'='.repeat(96)}\n`);
})().catch((err) => {
  console.error(`REPLAY FAILED: ${err?.message || err}`);
  process.exitCode = 1;
});
