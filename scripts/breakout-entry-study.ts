/**
 * Detectorul de breakout, folosit ca INTRARE -- studiu de randament viitor. READ-ONLY.
 *
 * De ce exista: `GridBotAnalyzer` a oprit 70 din 89 de boti cu "Range Breakout CONFIRMAT".
 * Intotdeauna ca IESIRE: gridul era pe partea greasita si plateau ca sa se inchida. Intrebarea
 * nu e "a avut dreptate?" (o oprire confirmata nu dovedeste ca pretul a continuat), ci:
 *
 *   dupa un breakout CONFIRMAT de detectorul din productie, randamentul viitor in directia
 *   semnalului acopera costul de a intra si de a iesi?
 *
 * Regula de decizie, FIXATA INAINTE de a rula (ca sa nu caut parametrul care iese bine):
 *   PASS  daca n >= 100 semnale SI exista un orizont cu media NETA > 0 SI profit factor > 1.10
 *   FAIL  in orice alt caz. Orizonturi fixe: 1h / 4h / 8h / 24h. Cooldown fix: 32 bare.
 *   Cost fix: 0.13% round-trip (taker 0.05% x2 + un tick de spread).
 * Daca iese FAIL, subiectul se inchide -- nu se ajusteaza pragurile pana iese PASS.
 *
 * Ce NU face: nu atinge `.data/`, nu scrie fisiere, nu vorbeste cu API-ul privat.
 *
 * Run: npm run breakout-entry
 */

import {
  assessRangeBreakout,
  efficiencyRatioFromKlines,
  wilderAdx,
} from '../src/server/engine/grid/gridRegime';
import type { Kline } from '../src/shared/types';

const BASE = 'https://eea.okx.com';

const SYMBOLS = [
  'BTC-USD_UM_XPERP-310404',
  'ETH-USD_UM_XPERP-310404',
  'SOL-USD_UM_XPERP-310404',
  'XRP-USD_UM_XPERP-310404',
  'DOGE-USD_UM_XPERP-310404',
  'INJ-USD_UM_XPERP-310711',
  'SUI-USD_UM_XPERP-310404',
  'ADA-USD_UM_XPERP-310404',
];

const BARS_TARGET = 2000; // ~20 zile la 15m
const BAND_WINDOW = 32; // 8h -- orizontul pe care scanul isi masoara regimul
const COOLDOWN_BARS = 32;
const COST_PCT = 0.13; // round-trip: taker x2 + un tick de spread
const HORIZONS = [4, 16, 32, 96]; // 1h, 4h, 8h, 24h
const MIN_SIGNALS = 100;
const MIN_PROFIT_FACTOR = 1.1;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson(path: string): Promise<any[]> {
  const res = await fetch(`${BASE}${path}`, { headers: { 'Content-Type': 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${path}`);
  const body: any = await res.json();
  if (String(body?.code) !== '0') throw new Error(`OKX ${body?.code}: ${body?.msg} on ${path}`);
  return Array.isArray(body?.data) ? body.data : [];
}

async function fetchCandles(instId: string, target: number): Promise<Kline[]> {
  const byTs = new Map<number, Kline>();
  let after: string | undefined;
  let guard = 0;

  while (byTs.size < target && guard++ < 40) {
    const qs = new URLSearchParams({ instId, bar: '15m', limit: '300' });
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

/** ATR% (15m) pe fereastra, din true range mediu. */
function atrPctOf(bars: Kline[]): number | null {
  if (bars.length < 3) return null;
  let sum = 0;
  let n = 0;
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1].close;
    const tr = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - prev),
      Math.abs(bars[i].low - prev)
    );
    if (Number.isFinite(tr) && prev > 0) {
      sum += tr / prev;
      n++;
    }
  }
  return n ? (sum / n) * 100 : null;
}

interface Signal {
  symbol: string;
  side: 'ABOVE' | 'BELOW';
  confirmedBy: string;
  index: number;
  entryPx: number;
  forward: Array<number | null>;
}

const median = (v: number[]): number => {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const fmt = (n: number, d = 3) => (Number.isFinite(n) ? n.toFixed(d) : 'n/a');
const sign = (n: number, d = 3) => `${n >= 0 ? '+' : ''}${fmt(n, d)}`;

async function main() {
  console.log('Breakout confirmat folosit ca INTRARE -- randament viitor, cost inclus.\n');
  console.log(
    `Fereastra de banda ${BAND_WINDOW} bare (8h) | cooldown ${COOLDOWN_BARS} bare | ` +
      `cost ${COST_PCT}% round-trip | orizonturi ${HORIZONS.map((h) => `${h * 15}m`).join(' / ')}\n`
  );

  const signals: Signal[] = [];

  for (const symbol of SYMBOLS) {
    let bars: Kline[] = [];
    try {
      bars = await fetchCandles(symbol, BARS_TARGET);
    } catch (err: any) {
      console.log(`${symbol.padEnd(30)} SKIP: ${err?.message || err}`);
      continue;
    }
    if (bars.length < BAND_WINDOW + 100) {
      console.log(`${symbol.padEnd(30)} SKIP: doar ${bars.length} bare`);
      continue;
    }

    let cooldown = 0;
    let frozen: { minPx: number; maxPx: number } | null = null;
    let sinceBar = 0;
    let count = 0;

    for (let i = BAND_WINDOW; i < bars.length; i++) {
      if (cooldown > 0) {
        cooldown--;
        continue;
      }
      const window = bars.slice(i - BAND_WINDOW, i); // strict trecut: fara lookahead
      const minPx = Math.min(...window.map((k) => k.low));
      const maxPx = Math.max(...window.map((k) => k.high));
      if (!(maxPx > minPx)) continue;

      const px = bars[i].close;

      // Banda se ingheata in momentul iesirii: asa lucreaza un grid real, cu o banda statica.
      if (!frozen) {
        if (px > maxPx || px < minPx) {
          frozen = { minPx, maxPx };
          sinceBar = i;
        } else {
          continue;
        }
      }

      const outsideMinutes = (i - sinceBar) * 15;
      const assessment = assessRangeBreakout({
        currentPx: px,
        minPx: frozen.minPx,
        maxPx: frozen.maxPx,
        atrPct: atrPctOf(window) ?? undefined,
        outsideMinutes,
        efficiencyRatio: efficiencyRatioFromKlines(bars.slice(Math.max(0, i - 16), i + 1), 16),
        adx: wilderAdx(bars.slice(Math.max(0, i - 40), i + 1)) ?? undefined,
      });

      // Pretul a revenit in banda inghetata: nu mai e breakout, se reia masuratoarea.
      if (!assessment.outsideBand) {
        frozen = null;
        continue;
      }

      if (!assessment.confirmed || assessment.side === 'NONE') continue;

      const side = assessment.side as 'ABOVE' | 'BELOW';
      const forward = HORIZONS.map((h) => {
        if (i + h >= bars.length) return null;
        const exitPx = bars[i + h].close;
        const raw = side === 'ABOVE' ? (exitPx - px) / px : (px - exitPx) / px;
        return raw * 100 - COST_PCT;
      });

      signals.push({
        symbol,
        side,
        confirmedBy: String(assessment.confirmedBy),
        index: i,
        entryPx: px,
        forward,
      });
      count++;
      cooldown = COOLDOWN_BARS; // acelasi breakout nu se numara de 30 de ori
      frozen = null;
    }

    const days = ((bars[bars.length - 1].timestamp - bars[0].timestamp) / 86_400_000).toFixed(1);
    console.log(`${symbol.padEnd(30)} ${String(bars.length).padStart(5)} bare / ${days} zile  semnale ${count}`);
  }

  console.log('\n-- rezultat pe orizont (dupa cost) -------------------------------------------------------');
  console.log('orizont    n     medie     median     win%   avgWin   avgLoss   profitFactor    suma%');
  console.log('-'.repeat(100));

  let anyPass = false;
  let best: { horizon: number; pf: number; mean: number; n: number } | null = null;

  HORIZONS.forEach((h, idx) => {
    const vals = signals
      .map((s) => s.forward[idx])
      .filter((v): v is number => v !== null && Number.isFinite(v));
    if (!vals.length) {
      console.log(`${String(h * 15).padStart(4)}m   --`);
      return;
    }
    const wins = vals.filter((v) => v > 0);
    const losses = vals.filter((v) => v <= 0);
    const grossWin = wins.reduce((s, v) => s + v, 0);
    const grossLoss = Math.abs(losses.reduce((s, v) => s + v, 0));
    const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
    const pass = vals.length >= MIN_SIGNALS && mean > 0 && pf > MIN_PROFIT_FACTOR;
    if (pass) anyPass = true;
    if (!best || pf > best.pf) best = { horizon: h, pf, mean, n: vals.length };
    console.log(
      [
        `${h * 15}m`.padStart(6),
        String(vals.length).padStart(5),
        `${sign(mean)}%`.padStart(9),
        `${sign(median(vals))}%`.padStart(9),
        `${((wins.length / vals.length) * 100).toFixed(1)}%`.padStart(7),
        `${sign(wins.length ? grossWin / wins.length : 0)}%`.padStart(8),
        `${sign(losses.length ? -grossLoss / losses.length : 0)}%`.padStart(8),
        fmt(pf, 2).padStart(12),
        `${sign(vals.reduce((s, v) => s + v, 0), 1)}%`.padStart(9),
        pass ? '  PASS' : '',
      ].join('  ')
    );
  });

  console.log('\n-- pe confirmare --------------------------------------------------------------');
  const byMethod = new Map<string, Signal[]>();
  for (const s of signals) {
    const list = byMethod.get(s.confirmedBy) || [];
    list.push(s);
    byMethod.set(s.confirmedBy, list);
  }
  for (const [method, list] of byMethod) {
    const idx = HORIZONS.indexOf(16); // 4h, orizontul de referinta
    const vals = list.map((s) => s.forward[idx]).filter((v): v is number => v !== null);
    const mean = vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0;
    console.log(`${method.padEnd(12)} n=${String(vals.length).padStart(4)}   media 4h ${sign(mean)}%`);
  }

  console.log('\n-- verdict -------------------------------------------------------------------');
  console.log(
    `Regula fixata: n >= ${MIN_SIGNALS} SI media neta > 0 SI profitFactor > ${MIN_PROFIT_FACTOR}.\n` +
      (anyPass
        ? 'PASS: exista un orizont care trece. Nu e dovada de profit live, e permisiunea unui backtest serios.'
        : 'FAIL: detectorul nu are edge de intrare pe esantionul asta. Subiectul se inchide aici.') +
      `\nCel mai bun orizont: ${best ? `${best.horizon * 15}m (n=${best.n}, mean ${sign(best.mean)}%, PF ${fmt(best.pf, 2)})` : 'n/a'}` +
      `\nSemnale totale: ${signals.length}`
  );
}

main().catch((err) => {
  console.error('Eroare:', err?.message || err);
  process.exit(1);
});
