/**
 * REPLAY LANTULUI COMPLET DE POR?I DE DESCHIDERE -- read-only, zero creden?iale, zero ordine.
 *
 * `grid-regime-replay.ts` raspunde "cat de des e deschisa poarta de REGIM". Scriptul asta raspunde
 * la intrebarea urmatoare: "daca poarta de regim ar fi fost deschisa, ar fi trecut RESTUL lan?ului?"
 * -- adica exact motivul pentru care botul a stat 55h fara nicio deschidere in timp ce replay-ul de
 * regim arata zeci de ferestre.
 *
 * Metoda: nu reimplementeaza nimic. Pentru fiecare ora reconstruie?te intrarea scanului (48 bare
 * 15m + 60 bare 1h + ce s-ar fi vazut in ticker la acea ora) si cheama FUNC?IA REALA
 * `buildAgentOpportunity` din `AgentUniverseScan`. Apoi aplica cele doua por?i pe care scanul NU le
 * aplica (ele stau in `DeepSeekAgent.validateActions`): pragul de crossings si vetoul de regim.
 * Daca `buildAgentOpportunity` se schimba, replay-ul se schimba cu ea.
 *
 * Ce nu se poate reconstrui (si e declarat, nu ascuns):
 *   - spread: fara istoric public -> se folose?te `--spread=0.05` (aceea?i presupunere ca pool-ul);
 *   - adAncimea top-of-book: fara istoric -> se presupune ca trece (in live a trecut);
 *   - funding: fara istoric pe 14 zile -> 0 (usor optimist);
 *   - pool-ul live e ales pe range/spread, aici e top-N pe turnover: supramul?ime, nu submul?ime;
 *   - confirmarea pe doua scanari e aproximata prin "fereastra de minim o ora".
 *
 * Run:
 *   npx tsx scripts/grid-gate-replay.ts                      # 14 zile, top 25
 *   npx tsx scripts/grid-gate-replay.ts --days=7 --symbols=15 --fee=0.04
 */

import { isTradableXPerp } from '../src/server/scanner/UniverseManager';
import { buildAgentOpportunity, type AgentUniverseTicker } from '../src/server/agent/AgentUniverseScan';
import {
  hasDirectionalPressure,
  isDisplacedRegime,
  GRID_ADX_TREND_SELECTION,
  GRID_CHOP_TREND_SELECTION,
} from '../src/server/engine/grid/gridRegime';
import type { Kline } from '../src/shared/types';

const BASE = 'https://www.okx.com';
const REGIME_BARS_1H = 60;
const ER_SCAN_BARS = 32;

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  })
);
const DAYS = Math.max(2, Math.min(30, Number(args.get('days')) || 14));
const SYMBOLS = Math.max(3, Math.min(40, Number(args.get('symbols')) || 25));
/** Live: TradeBot passes `roundTripMakerFeePct` (fallback 0.08). Owner config: budget 12, lever 2, stop 12. */
const FEE = Number(args.get('fee')) || 0.08;
const BUDGET = Number(args.get('budget')) || 12;
const LEVER = Number(args.get('lever')) || 2;
const HARD_STOP = Number(args.get('stop')) || 12;
const SPREAD = Number(args.get('spread')) || 0.05;
const MIN_CROSSINGS = Number(args.get('mincross')) || 0.3;

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
    // Never ask for bars we already have (keeps the page count proportional to `want`).
    if (Number(rows[rows.length - 1][0]) < endMs - want * stepMs) break;
    await sleep(pauseMs);
  }
  out.sort((a, b) => a.timestamp - b.timestamp);
  return out.slice(0, -1).slice(-want); // drop the still-forming bar
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

/** Which gate refused first, for the histogram. The scan's own order decides, not ours. */
function bucketOf(reason: string | undefined): string {
  if (!reason) return 'ELIGIBLE (scan)';
  const r = reason.toLowerCase();
  if (r.startsWith('regim de deplasare')) return 'ER (deplasare)';
  // Every band refusal carries its own percentage, so the raw string would explode into one
  // bucket per value. The CATEGORY is what matters: the band was illegal against the 24h extremes.
  if (r.startsWith('band')) return 'banda ilegala fata de extremele 24h';
  if (r.includes('podeaua de comision')) return 'pas sub podeaua de comision';
  if (r.includes('profit net/grila')) return 'profit net/grila <= 0';
  if (r.startsWith('spread')) return 'spread > 25% din pas';
  if (r.includes('round-trip')) return 'prea putine round-trip-uri';
  if (r.includes('lichiditate')) return 'lichiditate top-book';
  return reason.slice(0, 44);
}

interface DayBucket {
  hours: number;
  scanEligible: number;
  fullyOpenable: number;
  runs: number;
}

(async () => {
  console.log(
    `REPLAY lant complet | ${DAYS} zile | top ${SYMBOLS} X-Perp | fee ${FEE}% | buget ${BUDGET}$ | ` +
      `lev ${LEVER}x | stop ${HARD_STOP}% | spread ${SPREAD}%\n` +
      `  refuz daca: scan neeligibil SAU crossings<${MIN_CROSSINGS}/h SAU ER>0.4 SAU ` +
      `ADX>${GRID_ADX_TREND_SELECTION} SAU chop<${GRID_CHOP_TREND_SELECTION}\n`
  );

  const universe = await loadUniverse();
  const picked = universe.slice(0, SYMBOLS);
  console.log(`univers: ${universe.length} X-Perp-uri live, rejucam ${picked.length}\n`);

  const days = new Map<string, DayBucket>();
  const reasons = new Map<string, number>();
  const perSymbol: string[] = [];
  /** Openable windows split by chop band: the 45-61.8 band is what the OLD prose refused. */
  const bands = new Map<string, { hours: number; runs: number }>();
  const chopBand = (chop: number | null | undefined): string => {
    if (chop == null || !Number.isFinite(chop)) return 'chop necunoscut';
    return chop >= 61.8 ? 'chop >= 61.8 (se deschidea si inainte)' : 'chop 45-61.8 (blocat doar de proza)';
  };

  for (const meta of picked) {
    const [bars15m, bars1h] = await Promise.all([
      fetchHistory(meta.instId, '15m', DAYS * 96, 140),
      fetchHistory(meta.instId, '1H', DAYS * 24 + REGIME_BARS_1H + 2, 140),
    ]);
    if (bars15m.length < 48 || bars1h.length < REGIME_BARS_1H + 24) {
      console.log(`  ${meta.instId}: istoric insuficient, sarit`);
      continue;
    }

    let hours = 0;
    let scanEligible = 0;
    let fully = 0;
    let runs = 0;
    let prev = false;
    let prevBand: string | null = null;

    // Walk the 1h closes; the scan sees the 15m bars that ended by then.
    for (let idx1h = 0; idx1h < bars1h.length; idx1h++) {
      const bar = bars1h[idx1h];
      if (idx1h < REGIME_BARS_1H + 23) continue;
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

      hours++;
      const key = new Date(bar.timestamp).toISOString().slice(0, 10);
      const bucket = days.get(key) || { hours: 0, scanEligible: 0, fullyOpenable: 0, runs: 0 };

      let openable = false;
      if (!row) {
        reasons.set('metrica indisponibila (bare prea putine)', (reasons.get('metrica indisponibila (bare prea putine)') || 0) + 1);
      } else {
        const category = bucketOf(row.rejectionReason);
        reasons.set(category, (reasons.get(category) || 0) + 1);
        if (row.isEligible) {
          scanEligible++;
          bucket.scanEligible++;
          // The gates that live in the agent, not in the scan.
          const crossings = Number(row.crossingsPerHour) || 0;
          const er = row.efficiencyRatio;
          const erOk = !(typeof er === 'number' && Number.isFinite(er) && er > 0.4);
          const regimeOk = !hasDirectionalPressure(row.adxTrendStrength, row.choppinessIndex);
          openable = crossings >= MIN_CROSSINGS && erOk && regimeOk && !isDisplacedRegime(er);
          if (openable) {
            fully++;
            bucket.fullyOpenable++;
            const band = chopBand(row.choppinessIndex);
            const acc = bands.get(band) || { hours: 0, runs: 0 };
            acc.hours++;
            if (!prev || prevBand !== band) acc.runs++;
            bands.set(band, acc);
            prevBand = band;
            if (!prev) {
              runs++;
              bucket.runs++;
            }
          }
        }
      }
      prev = openable;
      bucket.hours++;
      days.set(key, bucket);
    }

    perSymbol.push(
      `  ${meta.instId.padEnd(32)} ${String(hours).padStart(4)}h  scan eligibil ` +
        `${String(scanEligible).padStart(4)}h  deschizabil ${String(fully).padStart(3)}h  ferestre ${runs}`
    );
    console.log(perSymbol[perSymbol.length - 1]);
  }

  const totals = [...days.values()].reduce(
    (s, d) => ({
      hours: s.hours + d.hours,
      scanEligible: s.scanEligible + d.scanEligible,
      fully: s.fully + d.fullyOpenable,
      runs: s.runs + d.runs,
    }),
    { hours: 0, scanEligible: 0, fully: 0, runs: 0 }
  );
  const pct = (n: number, d: number) => (d > 0 ? `${((n / d) * 100).toFixed(1)}%` : 'n/a');

  console.log(`\n${'='.repeat(100)}`);
  console.log(`TOTAL ${totals.hours} symbol-ore rejucate`);
  console.log(`  scan eligibil (buildAgentOpportunity.isEligible) : ${totals.scanEligible}h (${pct(totals.scanEligible, totals.hours)})`);
  console.log(`  deschizabil dupa TOATE portile agentului       : ${totals.fully}h (${pct(totals.fully, totals.hours)})`);
  console.log(`  ferestre (>=1h, deci >=2 scanari)              : ${totals.runs}`);

  console.log(`\nMOTIVE (prima poarta care refuza, numaratoare pe symbol-ore):`);
  for (const [k, v] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(v).padStart(6)}  ${pct(v, totals.hours).padStart(6)}  ${k}`);
  }

  console.log(`\nFEREASTRE PE BENZI DE CHOP — cat bloca proza "chop > 61.8", care nu exista in cod:`);
  for (const [band, v] of [...bands.entries()].sort((a, b) => b[1].runs - a[1].runs)) {
    console.log(
      `  ${band.padEnd(38)} ${String(v.hours).padStart(5)}h  ${String(v.runs).padStart(4)} ferestre  ` +
        `~${(v.runs / Math.max(1, DAYS)).toFixed(1)}/zi`
    );
  }

  const ordered = [...days.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  console.log(`\nZILE  ora-UTC   symbol-ore  scan-eligibil  deschizabil  ferestre`);
  for (const [key, d] of ordered) {
    console.log(
      `  ${key}   ${String(d.hours).padStart(8)}   ${String(d.scanEligible).padStart(12)}   ` +
        `${String(d.fullyOpenable).padStart(10)}   ${String(d.runs).padStart(7)}`
    );
  }
  console.log(`${'='.repeat(100)}\n`);
})().catch((err) => {
  console.error(`REPLAY FAILED: ${err?.message || err}`);
  process.exitCode = 1;
});
