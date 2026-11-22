/**
 * Phase 2 — Intraday move exploitation engine.
 *
 * Question: once a move has ALREADY started, is there capturable edge left?
 * We never try to predict the low or the high. Every signal is a state that is observable
 * at bar `t` using bars <= t only, and entry happens at `open[t + 1 + delay]`.
 *
 * NO LOOK-AHEAD CONTRACT (enforced by construction):
 *   - signal predicates read closes/highs/lows/volumes from indices <= t
 *   - trailing windows are [t-W .. t] or [t-W .. t-1], never t+1
 *   - the entry price is an OPEN of a bar strictly after the signal bar
 *   - every outcome uses bars >= entry index, and events whose full horizon would run past
 *     the end of the series are DROPPED (not truncated)
 *
 * Costs: round-trip taker 0.05% x2 = 0.10%, plus explicit slippage scenarios
 *   base 0.05% (maker/liquid) and pessimistic 0.30% (thin book, the honest one for XPERPs).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(HERE, '..', 'data');

interface C {
  ts: number; open: number; high: number; low: number; close: number;
  vol: number; volUsd: number;
}

const INSTRUMENTS = [
  { short: 'ZEC', instId: 'ZEC-USD_UM_XPERP-310530' },
  { short: 'ENA', instId: 'ENA-USD_UM_XPERP-310613' },
  { short: 'IRYS', instId: 'IRYS-USD_UM_XPERP-310530' },
  { short: 'PIEVERSE', instId: 'PIEVERSE-USD_UM_XPERP-310822' },
  { short: 'CASHCAT', instId: 'CASHCAT-USD_UM_XPERP-310926' },
];

/* ---------------------------------------------------------------- configuration */

const W = 12;                                   // 1h trailing window (12 x 5m)
const AMPS = [0.5, 1, 2, 3, 5];                 // impulse amplitudes, %
const HORIZONS = [3, 6, 12, 24, 48];            // bars -> 15/30/60/120/240 min
const H_MIN: { [k: number]: number } = { 3: 15, 6: 30, 12: 60, 24: 120, 48: 240 };
const MAX_H = 48;
const DELAYS = [0, 1, 2, 3];                    // extra bars of artificial entry delay
const BARRIER = 0.5;                            // first-touch barrier, %
const FEE_RT = 0.10;                            // round-trip taker, %
const SLIP_BASE = 0.05;                         // %
const SLIP_PESS = 0.30;                         // %
const MIN_N = 30;                               // below this a row is "insufficient sample"
const Z_VOL = 3;                                // volume spike z-score
const RETRACE = [0.5, 1.0];                     // pullback depths, %
const BTC_MOVE = 1.0;                           // reference impulse, %

const load = <T>(file: string): T | null => {
  const p = path.join(DATA, file);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
};

const rnd = (x: number, d = 4): number => {
  if (!Number.isFinite(x)) return 0;
  const f = 10 ** d;
  return Math.round(x * f) / f;
};
const mean = (xs: number[]): number => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/* ---------------------------------------------------------------- helpers */

/** Min close over [t-w .. t] — strictly backward looking. */
function tMin(arr: number[], t: number, w: number): number {
  let m = Infinity;
  for (let i = Math.max(0, t - w); i <= t; i++) if (arr[i] < m) m = arr[i];
  return m;
}
function tMax(arr: number[], t: number, w: number): number {
  let m = -Infinity;
  for (let i = Math.max(0, t - w); i <= t; i++) if (arr[i] > m) m = arr[i];
  return m;
}

/* ---------------------------------------------------------------- signal generation */

type Sig = { name: string; dir: 1 | -1; events: number[] };

function buildSignals(c: C[], btcRet3: (number | null)[]): Sig[] {
  const n = c.length;
  const closes = c.map((x) => x.close);
  const highs = c.map((x) => x.high);
  const lows = c.map((x) => x.low);
  const vols = c.map((x) => x.volUsd);
  const sigs: Sig[] = [];

  /* 1. Impulse: price is X% away from its recent extreme. First crossing only, so a single
        move is not counted 20 times as it grinds higher. */
  for (const X of AMPS) {
    for (const dir of [1, -1] as const) {
      const events: number[] = [];
      let prev = false;
      for (let t = W; t < n - 1; t++) {
        const ref = dir === 1 ? tMin(closes, t, W) : tMax(closes, t, W);
        const move = dir === 1 ? (closes[t] / ref - 1) * 100 : (1 - closes[t] / ref) * 100;
        const ok = move >= X;
        if (ok && !prev) events.push(t);
        prev = ok;
      }
      sigs.push({ name: `impulse_${dir === 1 ? 'up' : 'dn'}_${X}`, dir, events });
    }
  }

  /* 2. Breakout: close beyond the prior W-bar range. Prior bars only. */
  for (const dir of [1, -1] as const) {
    const events: number[] = [];
    let prev = false;
    for (let t = W; t < n - 1; t++) {
      let ok: boolean;
      if (dir === 1) {
        let mx = -Infinity;
        for (let i = t - W; i <= t - 1; i++) if (highs[i] > mx) mx = highs[i];
        ok = closes[t] > mx;
      } else {
        let mn = Infinity;
        for (let i = t - W; i <= t - 1; i++) if (lows[i] < mn) mn = lows[i];
        ok = closes[t] < mn;
      }
      if (ok && !prev) events.push(t);
      prev = ok;
    }
    sigs.push({ name: `breakout_${dir === 1 ? 'up' : 'dn'}`, dir, events });
  }

  /* 3. Pullback inside a live impulse: price retraced R% from the run extreme, then a bar
        closes back in the impulse direction = resumption. Both legs are past data. */
  for (const R of RETRACE) {
    for (const dir of [1, -1] as const) {
      const events: number[] = [];
      for (let t = W + 1; t < n - 1; t++) {
        const refMin = tMin(closes, t, W);
        const refMax = tMax(closes, t, W);
        const impulseOk = dir === 1 ? (closes[t] / refMin - 1) * 100 >= 1 : (1 - closes[t] / refMax) * 100 >= 1;
        if (!impulseOk) continue;
        let runExtreme: number;
        if (dir === 1) {
          runExtreme = -Infinity;
          for (let i = t - W; i <= t - 1; i++) if (closes[i] > runExtreme) runExtreme = closes[i];
        } else {
          runExtreme = Infinity;
          for (let i = t - W; i <= t - 1; i++) if (closes[i] < runExtreme) runExtreme = closes[i];
        }
        const dd = dir === 1 ? ((runExtreme - closes[t - 1]) / runExtreme) * 100 : ((closes[t - 1] - runExtreme) / runExtreme) * 100;
        if (dd < R) continue;
        const resuming = dir === 1 ? closes[t] > closes[t - 1] : closes[t] < closes[t - 1];
        if (resuming) events.push(t);
      }
      sigs.push({ name: `pullback_${dir === 1 ? 'up' : 'dn'}_${R}`, dir, events });
    }
  }

  /* 4. Volume spike: z-score of USD volume vs the previous 20 bars, direction from the bar. */
  for (const dir of [1, -1] as const) {
    const events: number[] = [];
    for (let t = 21; t < n - 1; t++) {
      const win: number[] = [];
      for (let i = t - 20; i <= t - 1; i++) win.push(vols[i]);
      const mu = mean(win);
      const sd = Math.sqrt(mean(win.map((v) => (v - mu) ** 2)));
      if (sd <= 0) continue;
      const z = (vols[t] - mu) / sd;
      const barDir = Math.sign(closes[t] - closes[t - 1]);
      if (z >= Z_VOL && barDir === dir) events.push(t);
    }
    sigs.push({ name: `volspike_${dir === 1 ? 'up' : 'dn'}`, dir, events });
  }

  /* 5. BTC lead: BTC already moved, the alt has not caught up yet. */
  for (const dir of [1, -1] as const) {
    const events: number[] = [];
    for (let t = 3; t < n - 1; t++) {
      const br = btcRet3[t];
      if (br === null) continue;
      const altRet3 = (closes[t] / closes[t - 3] - 1) * 100;
      const started = dir === 1 ? br >= BTC_MOVE : br <= -BTC_MOVE;
      const lagging = dir === 1 ? altRet3 < br / 2 : altRet3 > br / 2;
      if (started && lagging) events.push(t);
    }
    sigs.push({ name: `btclead_${dir === 1 ? 'up' : 'dn'}`, dir, events });
  }

  /* 6. Two-bar confirmation: two consecutive closes in the same direction, >= 1% total. */
  for (const dir of [1, -1] as const) {
    const events: number[] = [];
    for (let t = 2; t < n - 1; t++) {
      const up = closes[t] > closes[t - 1] && closes[t - 1] > closes[t - 2];
      const dn = closes[t] < closes[t - 1] && closes[t - 1] < closes[t - 2];
      const move = Math.abs((closes[t] / closes[t - 2] - 1) * 100);
      if (dir === 1 && up && move >= 1) events.push(t);
      if (dir === -1 && dn && move >= 1) events.push(t);
    }
    sigs.push({ name: `confirm_${dir === 1 ? 'up' : 'dn'}`, dir, events });
  }

  return sigs;
}

/* ---------------------------------------------------------------- aggregation */

interface Acc {
  n: number;
  np: [number, number, number];
  retSum: number;
  retArr: number[];
  mfeSum: number;
  maeSum: number;
  fav: number;
  adv: number;
  amb: number;
  netBaseSum: number;
  netPessSum: number;
  netWins: number;
  nbSum: [number, number, number];
}

const newAcc = (): Acc => ({
  n: 0, np: [0, 0, 0], retSum: 0, retArr: [], mfeSum: 0, maeSum: 0,
  fav: 0, adv: 0, amb: 0, netBaseSum: 0, netPessSum: 0, netWins: 0, nbSum: [0, 0, 0],
});

const report: any = {
  generatedAt: new Date().toISOString(),
  config: {
    barMinutes: 5, impulseWindowBars: W, amplitudes: AMPS, horizonsMinutes: HORIZONS.map((h) => H_MIN[h]),
    delaysBars: DELAYS, firstTouchBarrierPct: BARRIER, feeRoundTripTakerPct: FEE_RT,
    slippageBasePct: SLIP_BASE, slippagePessimisticPct: SLIP_PESS, minSample: MIN_N,
    volSpikeZ: Z_VOL, pullbackDepths: RETRACE, btcMovePct: BTC_MOVE,
  },
  instruments: [] as any[],
};

/* reference series, aligned by timestamp */
const btc5 = load<C[] >('ref_BTC_candles_5m.json');
const eth5 = load<C[]>('ref_ETH_candles_5m.json');
const refMap = (s: C[] | null) => {
  const m = new Map<number, number>();
  if (s) for (const b of s) m.set(b.ts, b.close);
  return m;
};
const btcMap = refMap(btc5);

for (const inst of INSTRUMENTS) {
  const c = load<C[]>(`${inst.short}_${inst.instId}_candles_5m.json`);
  if (!c || c.length < 200) {
    console.log(`  ${inst.short}: date insuficiente, sarit`);
    continue;
  }
  const n = c.length;

  // BTC return over the last 3 bars, aligned to each alt bar by timestamp.
  const btcRet3: (number | null)[] = new Array(n).fill(null);
  for (let t = 3; t < n; t++) {
    const a = btcMap.get(c[t].ts);
    const b = btcMap.get(c[t - 3].ts);
    if (a !== undefined && b !== undefined && b > 0) btcRet3[t] = (a / b - 1) * 100;
  }

  const sigs = buildSignals(c, btcRet3);
  const periodOf = (t: number): 0 | 1 | 2 => (t < n / 3 ? 0 : t < (2 * n) / 3 ? 1 : 2);

  const accs = new Map<string, Acc>();
  const getAcc = (k: string): Acc => {
    let a = accs.get(k);
    if (!a) { a = newAcc(); accs.set(k, a); }
    return a;
  };

  const signalMeta: any[] = [];
  const examples: any[] = [];

  for (const sg of sigs) {
    /* How long the setup stays valid after it triggers — the real "window to enter". */
    const holds: number[] = [];
    if (sg.name.startsWith('impulse_')) {
      const X = Number(sg.name.split('_').pop());
      const closes = c.map((x) => x.close);
      for (const t of sg.events) {
        let k = 0;
        while (t + k + 1 < n && k < MAX_H) {
          const tt = t + k;
          const ref = sg.dir === 1 ? tMin(closes, tt, W) : tMax(closes, tt, W);
          const mv = sg.dir === 1 ? (closes[tt] / ref - 1) * 100 : (1 - closes[tt] / ref) * 100;
          if (mv < X) break;
          k++;
        }
        holds.push(k);
      }
    }
    signalMeta.push({
      name: sg.name,
      dir: sg.dir,
      events: sg.events.length,
      holdBarsMedian: holds.length ? rnd(median(holds), 1) : null,
      holdMinutesMedian: holds.length ? rnd(median(holds) * 5, 0) : null,
    });

    /** Cap examples at 3 per signal — enough to show, not enough to bloat the artifact. */
    let examplesLeft = 3;

    for (const t of sg.events) {
      const per = periodOf(t);

      for (const delay of DELAYS) {
        const ei = t + 1 + delay;
        if (ei + MAX_H > n - 1) continue; // full horizon must exist
        const p0 = c[ei].open;
        if (!(p0 > 0)) continue;

        let favMax = 0;
        let advMax = 0;
        let touch = 0; // 0 none, 1 favourable, 2 adverse, 3 ambiguous

        for (let h = 0; h < MAX_H; h++) {
          const bar = c[ei + h];
          const favPct = sg.dir === 1 ? (bar.high / p0 - 1) * 100 : (p0 - bar.low) / p0 * 100;
          const advPct = sg.dir === 1 ? (p0 - bar.low) / p0 * 100 : (bar.high / p0 - 1) * 100;
          if (favPct > favMax) favMax = favPct;
          if (advPct > advMax) advMax = advPct;

          if (touch === 0) {
            const hitFav = favPct >= BARRIER;
            const hitAdv = advPct >= BARRIER;
            // Ambiguity inside one bar is resolved PESSIMISTICALLY (adverse first).
            if (hitAdv && hitFav) touch = 3;
            else if (hitAdv) touch = 2;
            else if (hitFav) touch = 1;
          }

          const bars = h + 1;
          if (HORIZONS.indexOf(bars) === -1) continue;

          const raw = sg.dir === 1 ? (bar.close / p0 - 1) * 100 : (p0 - bar.close) / p0 * 100;
          const netBase = raw - (FEE_RT + SLIP_BASE);
          const netPess = raw - (FEE_RT + SLIP_PESS);

          const a = getAcc(`${sg.name}|${delay}|${bars}`);
          a.n++;
          a.np[per]++;
          a.retSum += raw;
          a.retArr.push(raw);
          a.mfeSum += favMax;
          a.maeSum += advMax;
          a.netBaseSum += netBase;
          a.netPessSum += netPess;
          a.nbSum[per] += netBase;
          if (netBase > 0) a.netWins++;
          if (touch === 1) a.fav++;
          else if (touch === 2) a.adv++;
          else if (touch === 3) a.amb++;

          /* one concrete example per signal, at delay 0 / 60 min */
          if (examplesLeft > 0 && delay === 0 && bars === 12) {
            examplesLeft--;
            examples.push({
              signal: sg.name, dir: sg.dir,
              signalTs: c[t].ts, entryTs: c[ei].ts,
              signalClose: rnd(c[t].close, 6), entryPx: rnd(p0, 6), exitPx: rnd(bar.close, 6),
              grossPct: rnd(raw, 3), netBasePct: rnd(netBase, 3), netPessPct: rnd(netPess, 3),
              mfePct: rnd(favMax, 3), maePct: rnd(advMax, 3),
              period: per,
            });
          }
        }
      }
    }
  }

  /* finalise rows */
  const rows: any[] = [];
  for (const [k, a] of accs) {
    const [sigName, dStr, hStr] = k.split('|');
    const delay = Number(dStr);
    const horizon = Number(hStr);
    const dir = sigs.find((s) => s.name === sigName)?.dir ?? 1;
    const costBase = FEE_RT + SLIP_BASE;
    const costPess = FEE_RT + SLIP_PESS;

    rows.push({
      signal: sigName,
      dir,
      delay,
      horizon,
      horizonMin: H_MIN[horizon],
      n: a.n,
      nP1: a.np[0], nP2: a.np[1], nP3: a.np[2],
      meanRet: rnd(a.retSum / a.n, 3),
      medianRet: rnd(median(a.retArr), 3),
      winRate: rnd((a.retArr.filter((r) => r > 0).length / a.n) * 100, 1),
      mfe: rnd(a.mfeSum / a.n, 3),
      mae: rnd(a.maeSum / a.n, 3),
      rr: rnd(a.mfeSum / Math.max(a.maeSum, 1e-9), 2),
      contProb: rnd((a.fav / a.n) * 100, 1),
      revProb: rnd((a.adv / a.n) * 100, 1),
      ambProb: rnd((a.amb / a.n) * 100, 1),
      netBase: rnd(a.netBaseSum / a.n, 3),
      netPess: rnd(a.netPessSum / a.n, 3),
      netWinRate: rnd((a.netWins / a.n) * 100, 1),
      nbP1: a.np[0] ? rnd(a.nbSum[0] / a.np[0], 3) : null,
      nbP2: a.np[1] ? rnd(a.nbSum[1] / a.np[1], 3) : null,
      nbP3: a.np[2] ? rnd(a.nbSum[2] / a.np[2], 3) : null,
      costBase, costPess,
      insufficientSample: a.n < MIN_N,
    });
  }

  report.instruments.push({
    short: inst.short,
    instId: inst.instId,
    bars: n,
    firstTs: c[0].ts,
    lastTs: c[n - 1].ts,
    hasBtcRef: btcRet3.filter((x) => x !== null).length,
    signals: signalMeta,
    rows,
    examples,
  });

  const best = rows
    .filter((r) => r.delay === 0 && r.horizon === 12 && r.n >= MIN_N)
    .sort((a, b) => b.netBase - a.netBase)
    .slice(0, 3);
  console.log(
    `  ${inst.short}: ${n} bare, ${sigs.length} semnale | best 60m: ` +
      best.map((b: any) => `${b.signal}=${b.netBase}%`).join(', ')
  );
}

fs.writeFileSync(path.join(HERE, '..', 'phase2.json'), JSON.stringify(report, null, 2), 'utf8');
const total = report.instruments.reduce((s: number, i: any) => s + i.rows.length, 0);
console.log(`\nphase2.json: ${report.instruments.length} instrumente, ${total} randuri`);
