/**
 * Phase 2 — reference data collector (BTC / ETH).
 *
 * Phase 2 asks whether the five `_UM_XPERP` instruments react with a LAG to BTC and ETH.
 * That needs the reference series on the SAME 5m grid as the alts, otherwise the lead/lag
 * comparison would be contaminated by resampling.
 *
 * Public endpoints only. Tries the EEA venue first (same clock/session as the alts) and falls
 * back to the global venue if the reference pair is not listed on EEA.
 *
 * Writes: data/ref_<SYMBOL>_candles_<bar>.json
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(HERE, '..', 'data');

const VENUES = ['https://eea.okx.com', 'https://www.okx.com'];

/** Candidate instIds per reference, most-preferred first. */
const REFS: Array<{ short: string; candidates: string[] }> = [
  { short: 'BTC', candidates: ['BTC-USDT-SWAP', 'BTC-USDT', 'BTC-USD'] },
  { short: 'ETH', candidates: ['ETH-USDT-SWAP', 'ETH-USDT', 'ETH-USD'] },
];

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  })
);
const DAYS = Math.max(1, Math.min(120, Number(args.get('days')) || 95));
const BARS = String(args.get('bars') || '5m,1H').split(',').map((b) => b.trim()).filter(Boolean);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function barMs(bar: string): number {
  const b = bar.toLowerCase();
  if (b === '5m') return 300_000;
  if (b === '15m') return 900_000;
  if (b === '1h') return 3_600_000;
  if (b === '1d' || b === '1dutc') return 86_400_000;
  throw new Error(`Unsupported bar: ${bar}`);
}

async function getJson(base: string, q: string, attempt = 1): Promise<any> {
  try {
    const res = await fetch(base + q, { signal: AbortSignal.timeout(25_000) });
    const json: any = await res.json();
    if (json?.code === '0') return json;
    if (attempt <= 3 && ['50011', '50004', '50001', '50013'].includes(String(json?.code))) {
      await sleep(500 * attempt);
      return getJson(base, q, attempt + 1);
    }
    throw new Error(`OKX ${json?.code}: ${json?.msg}`);
  } catch (err: any) {
    if (attempt <= 3 && /timeout|ECONN|fetch failed|socket/i.test(String(err?.message))) {
      await sleep(500 * attempt);
      return getJson(base, q, attempt + 1);
    }
    throw err;
  }
}

/** Find the first candidate instId that actually returns candles on some venue. */
async function resolve(base: string, candidates: string[]): Promise<string | null> {
  for (const instId of candidates) {
    try {
      const j = await getJson(
        base,
        `/api/v5/market/history-candles?instId=${encodeURIComponent(instId)}&bar=5m&limit=2`
      );
      if ((j.data || []).length > 0) return instId;
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

async function fetchCandles(base: string, instId: string, bar: string, days: number) {
  const target = Date.now() - days * 86_400_000;
  const map = new Map<number, any>();
  let after: string | undefined;

  for (let page = 0; page < 500; page++) {
    const q =
      `/api/v5/market/history-candles?instId=${encodeURIComponent(instId)}&bar=${bar}&limit=100` +
      (after ? `&after=${after}` : '');
    const json = await getJson(base, q);
    const rows: any[] = json.data || [];
    if (rows.length === 0) break;
    for (const k of rows) {
      const ts = Number(k[0]);
      map.set(ts, {
        ts,
        open: Number(k[1]),
        high: Number(k[2]),
        low: Number(k[3]),
        close: Number(k[4]),
        vol: Number(k[5]) || 0,
        volUsd: Number(k[7]) || 0,
      });
    }
    const oldest = Number(rows[rows.length - 1][0]);
    after = String(oldest);
    if (rows.length < 100 || oldest <= target) break;
    await sleep(150);
  }
  return Array.from(map.values()).sort((a, b) => a.ts - b.ts);
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`Phase 2 reference collector | ${DAYS} zile | bare=${BARS.join(',')}\n`);

  for (const ref of REFS) {
    let done = false;
    for (const base of VENUES) {
      if (done) break;
      const instId = await resolve(base, ref.candidates);
      if (!instId) {
        console.log(`  ${ref.short}: niciun candidat pe ${base}`);
        continue;
      }
      const venue = base.includes('eea') ? 'eea' : 'global';
      console.log(`  ${ref.short}: folosesc ${instId} pe ${venue}`);
      for (const bar of BARS) {
        try {
          const c = await fetchCandles(base, instId, bar, DAYS);
          if (c.length === 0) {
            console.log(`    ${bar}: VIDE`);
            continue;
          }
          const file = path.join(OUT_DIR, `ref_${ref.short}_candles_${bar}.json`);
          fs.writeFileSync(file, JSON.stringify(c), 'utf8');
          console.log(
            `    ${bar.padEnd(6)} ${String(c.length).padStart(6)} bare  ` +
              `${new Date(c[0].ts).toISOString().slice(0, 10)} -> ${new Date(c[c.length - 1].ts).toISOString().slice(0, 10)}`
          );
          done = true;
        } catch (err: any) {
          console.log(`    ${bar}: EROARE ${err?.message}`);
        }
        await sleep(150);
      }
    }
    if (!done) console.log(`  ${ref.short}: NU am putut colecta\n`);
    else console.log('');
  }

  console.log('Gata.');
})();
