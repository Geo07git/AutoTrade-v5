/**
 * Phase 2 diagnostic — distribution of a single signal, per instrument.
 *
 * The aggregate means in phase2.json can be dominated by a handful of outliers on a thin
 * instrument. This prints the FULL distribution (percentiles, top contributors, share of total
 * PnL from the best 5 events) so a "great average" can be judged as edge or as noise.
 *
 * Usage: npx tsx research/tb5/phase2/diag.ts <SHORT> <signal> [delay] [horizonBars]
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(HERE, '..', 'data');

const FEE_RT = 0.10;
const SLIP = 0.30; // pessimistic — the honest default for these instruments
const COST = FEE_RT + SLIP;

interface C { ts: number; open: number; high: number; low: number; close: number; vol: number; volUsd: number }

const INSTRUMENTS: any = {
  ZEC: 'ZEC-USD_UM_XPERP-310530',
  ENA: 'ENA-USD_UM_XPERP-310613',
  IRYS: 'IRYS-USD_UM_XPERP-310530',
  PIEVERSE: 'PIEVERSE-USD_UM_XPERP-310822',
  CASHCAT: 'CASHCAT-USD_UM_XPERP-310926',
};

const short = process.argv[2] || 'IRYS';
const signal = process.argv[3] || 'impulse_up_5';
const delay = Number(process.argv[4] ?? 0);
const H = Number(process.argv[5] ?? 12);
/** `fade` = trade AGAINST the impulse (the signal condition still uses the impulse direction). */
const fade = process.argv[6] === 'fade';
const W = 12;

const c: C[] = JSON.parse(
  fs.readFileSync(path.join(DATA, `${short}_${INSTRUMENTS[short]}_candles_5m.json`), 'utf8')
);
const n = c.length;
const closes = c.map((x) => x.close);
const impulseDir = signal.indexOf('_dn') >= 0 ? -1 : 1;
const dir = fade ? -impulseDir : impulseDir;

let X = 0;
const m = signal.match(/_(\d+(?:\.\d+)?)$/);
if (m) X = Number(m[1]);

const tMin = (t: number) => {
  let v = Infinity;
  for (let i = Math.max(0, t - W); i <= t; i++) if (closes[i] < v) v = closes[i];
  return v;
};
const tMax = (t: number) => {
  let v = -Infinity;
  for (let i = Math.max(0, t - W); i <= t; i++) if (closes[i] > v) v = closes[i];
  return v;
};

const highs = c.map((x) => x.high);
const lows = c.map((x) => x.low);
const vols = c.map((x) => x.volUsd);

/* BTC reference, aligned by timestamp, for the lagged-reaction family. */
const btcPath = path.join(DATA, 'ref_BTC_candles_5m.json');
const btcMap = new Map<number, number>();
if (fs.existsSync(btcPath)) {
  const btc: C[] = JSON.parse(fs.readFileSync(btcPath, 'utf8'));
  for (const b of btc) btcMap.set(b.ts, b.close);
}
const btcRet3: (number | null)[] = new Array(n).fill(null);
for (let t = 3; t < n; t++) {
  const a = btcMap.get(c[t].ts);
  const b = btcMap.get(c[t - 3].ts);
  if (a !== undefined && b !== undefined && b > 0) btcRet3[t] = (a / b - 1) * 100;
}

/** Rebuild the same events the engine produced, for the signal families used in the report. */
function buildEvents(): number[] {
  const ev: number[] = [];
  const fam = signal.split('_')[0];

  if (fam === 'impulse') {
    let prev = false;
    for (let t = W; t < n - 1; t++) {
      const ref = impulseDir === 1 ? tMin(t) : tMax(t);
      const move = impulseDir === 1 ? (closes[t] / ref - 1) * 100 : (1 - closes[t] / ref) * 100;
      const ok = move >= X;
      if (ok && !prev) ev.push(t);
      prev = ok;
    }
  } else if (fam === 'breakout') {
    let prev = false;
    for (let t = W; t < n - 1; t++) {
      let ok: boolean;
      if (impulseDir === 1) {
        let mx = -Infinity;
        for (let i = t - W; i <= t - 1; i++) if (highs[i] > mx) mx = highs[i];
        ok = closes[t] > mx;
      } else {
        let mn = Infinity;
        for (let i = t - W; i <= t - 1; i++) if (lows[i] < mn) mn = lows[i];
        ok = closes[t] < mn;
      }
      if (ok && !prev) ev.push(t);
      prev = ok;
    }
  } else if (fam === 'confirm') {
    for (let t = 2; t < n - 1; t++) {
      const up = closes[t] > closes[t - 1] && closes[t - 1] > closes[t - 2];
      const dn = closes[t] < closes[t - 1] && closes[t - 1] < closes[t - 2];
      const mv = Math.abs((closes[t] / closes[t - 2] - 1) * 100);
      if (impulseDir === 1 && up && mv >= 1) ev.push(t);
      if (impulseDir === -1 && dn && mv >= 1) ev.push(t);
    }
  } else if (fam === 'volspike') {
    for (let t = 21; t < n - 1; t++) {
      let sum = 0;
      for (let i = t - 20; i <= t - 1; i++) sum += vols[i];
      const mu = sum / 20;
      let varSum = 0;
      for (let i = t - 20; i <= t - 1; i++) varSum += (vols[i] - mu) ** 2;
      const sd = Math.sqrt(varSum / 20);
      if (sd <= 0) continue;
      const z = (vols[t] - mu) / sd;
      const barDir = Math.sign(closes[t] - closes[t - 1]);
      if (z >= 3 && barDir === impulseDir) ev.push(t);
    }
  } else if (fam === 'btclead') {
    for (let t = 3; t < n - 1; t++) {
      const br = btcRet3[t];
      if (br === null) continue;
      const altRet3 = (closes[t] / closes[t - 3] - 1) * 100;
      const started = impulseDir === 1 ? br >= 1.0 : br <= -1.0;
      const lagging = impulseDir === 1 ? altRet3 < br / 2 : altRet3 > br / 2;
      if (started && lagging) ev.push(t);
    }
  }
  return ev;
}

const events = buildEvents();

const rows: any[] = [];
let lastEi = -Infinity;
for (const t of events) {
  const ei = t + 1 + delay;
  if (ei + H > n - 1) continue;
  /* Non-overlap filter: two entries closer than one full horizon are the SAME trade twice.
     Counting both inflates n and makes a single move look like a repeatable pattern. */
  if (ei - lastEi < H) continue;
  const p0 = c[ei].open;
  if (!(p0 > 0)) continue;
  lastEi = ei;
  const exit = c[ei + H - 1].close;
  const raw = dir === 1 ? (exit / p0 - 1) * 100 : (p0 - exit) / p0 * 100;
  let mfe = 0;
  let mae = 0;
  for (let h = 0; h < H; h++) {
    const b = c[ei + h];
    const fav = dir === 1 ? (b.high / p0 - 1) * 100 : (p0 - b.low) / p0 * 100;
    const adv = dir === 1 ? (p0 - b.low) / p0 * 100 : (b.high / p0 - 1) * 100;
    if (fav > mfe) mfe = fav;
    if (adv > mae) mae = adv;
  }
  rows.push({ t, ei, ts: c[ei].ts, raw, net: raw - COST, mfe, mae });
}

const nets = rows.map((r) => r.net).sort((a, b) => a - b);
const M = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
const P = (p: number) => (nets.length ? nets[Math.min(nets.length - 1, Math.floor(p * nets.length))] : 0);
const total = nets.reduce((s, x) => s + x, 0);
const sortedDesc = [...rows].sort((a, b) => b.net - a.net);
const top5 = sortedDesc.slice(0, 5).reduce((s, r) => s + r.net, 0);

const fmt = (x: number) => (x >= 0 ? '+' : '') + x.toFixed(3);

console.log(`\n${short}  ${signal}  trade=${dir === 1 ? 'LONG' : 'SHORT'}${fade ? ' (FADE)' : ''}  delay=${delay}  horizon=${H} bars (${H * 5}m)`);
console.log(`cost applied: ${COST.toFixed(2)}% round trip (fee ${FEE_RT}% + slip ${SLIP}%)`);
console.log(`events=${rows.length}\n`);
console.log(`mean net   ${fmt(M(nets))}%`);
console.log(`median net ${fmt(P(0.5))}%`);
console.log(`p10 ${fmt(P(0.1))}%   p25 ${fmt(P(0.25))}%   p75 ${fmt(P(0.75))}%   p90 ${fmt(P(0.9))}%`);
console.log(`worst ${fmt(nets[0] ?? 0)}%   best ${fmt(nets[nets.length - 1] ?? 0)}%`);
console.log(`win rate (net>0) ${((nets.filter((x) => x > 0).length / Math.max(nets.length, 1)) * 100).toFixed(1)}%`);
console.log(`total PnL sum ${fmt(total)}%  |  best 5 events contribute ${fmt(top5)}% = ${((top5 / Math.max(Math.abs(total), 1e-9)) * 100).toFixed(0)}% of total`);
console.log(`\nTop 5 contributors:`);
for (const r of sortedDesc.slice(0, 5)) {
  console.log(
    `  ${new Date(r.ts).toISOString().slice(0, 16).replace('T', ' ')}  net=${fmt(r.net)}%  mfe=${r.mfe.toFixed(2)}  mae=${r.mae.toFixed(2)}`
  );
}
console.log(`\nWithout the best 5 events: mean net = ${fmt((total - top5) / Math.max(nets.length - 5, 1))}%`);
