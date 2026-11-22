/**
 * TB5 `_UM_XPERP` data collector.
 *
 * Public endpoints only, on the EEA venue (the only place where `_UM_XPERP` exists):
 *   GET /api/v5/public/instruments        (contract metadata)
 *   GET /api/v5/market/history-candles    (OHLCV, paginated back)
 *   GET /api/v5/public/funding-rate-history (8h funding)
 *   GET /api/v5/rubik/stat/contracts/open-interest-volume (OI + volume, daily)
 *   GET /api/v5/public/open-interest      (live OI snapshot)
 *   GET /api/v5/market/books              (LIVE spread snapshot - no history exists)
 *
 * Writes JSON into ./data next to this file. No credentials are read or written.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const BASE = 'https://eea.okx.com';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(HERE, 'data');

export const INSTRUMENTS: Array<{ short: string; instId: string; ccy: string }> = [
  { short: 'ZEC', instId: 'ZEC-USD_UM_XPERP-310530', ccy: 'ZEC' },
  { short: 'ENA', instId: 'ENA-USD_UM_XPERP-310613', ccy: 'ENA' },
  { short: 'IRYS', instId: 'IRYS-USD_UM_XPERP-310530', ccy: 'IRYS' },
  { short: 'PIEVERSE', instId: 'PIEVERSE-USD_UM_XPERP-310822', ccy: 'PIEVERSE' },
  { short: 'CASHCAT', instId: 'CASHCAT-USD_UM_XPERP-310926', ccy: 'CASHCAT' },
];

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  })
);
const DAYS = Math.max(1, Math.min(120, Number(args.get('days')) || 90));
const BARS = String(args.get('bars') || '5m,15m,1H,1Dutc')
  .split(',')
  .map((b) => b.trim())
  .filter(Boolean);
/** Optional `--only=ZEC,ENA` to re-collect a subset. */
const ONLY = args.get('only');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function okxGet(pathAndQuery: string, attempt = 1): Promise<any> {
  try {
    const res = await fetch(`${BASE}${pathAndQuery}`, { signal: AbortSignal.timeout(25_000) });
    const json: any = await res.json();
    if (json?.code === '0') return json;
    if (attempt <= 4 && ['50011', '50004', '50001', '50013'].includes(String(json?.code))) {
      await sleep(600 * attempt);
      return okxGet(pathAndQuery, attempt + 1);
    }
    throw new Error(`OKX ${json?.code}: ${json?.msg}`);
  } catch (err: any) {
    if (attempt <= 4 && /timeout|ECONN|fetch failed|socket/i.test(String(err?.message))) {
      await sleep(600 * attempt);
      return okxGet(pathAndQuery, attempt + 1);
    }
    throw err;
  }
}

/** Absolute bar duration in ms; used for pagination and gap checks. */
export function barMs(bar: string): number {
  const b = bar.toLowerCase();
  if (b === '1m') return 60_000;
  if (b === '3m') return 180_000;
  if (b === '5m') return 300_000;
  if (b === '15m') return 900_000;
  if (b === '30m') return 1_800_000;
  if (b === '1h') return 3_600_000;
  if (b === '2h') return 7_200_000;
  if (b === '4h') return 14_400_000;
  if (b === '1d' || b === '1dutc') return 86_400_000;
  throw new Error(`Unsupported bar: ${bar}`);
}

export interface Candle {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Contracts traded. */
  vol: number;
  /** Base-currency volume (volCcy). */
  volCcy: number;
  /** Quote-currency volume (volCcyQuote) — USD notional for these contracts. */
  volUsd: number;
  confirm: boolean;
}

/**
 * Paginates /market/history-candles back from `untilTs` (ms) until `targetStartTs` or exhaustion.
 * Returns ascending by timestamp, duplicates removed.
 */
async function fetchCandles(instId: string, bar: string, days: number): Promise<Candle[]> {
  const duration = barMs(bar);
  const targetStartTs = Date.now() - days * 86_400_000;
  const wantCount = Math.ceil((days * 86_400_000) / duration) + 5;
  const map = new Map<number, Candle>();
  let after: string | undefined;

  for (let page = 0; page < 400; page++) {
    const q =
      `/api/v5/market/history-candles?instId=${encodeURIComponent(instId)}&bar=${bar}&limit=100` +
      (after ? `&after=${after}` : '');
    const json = await okxGet(q);
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
        volCcy: Number(k[6]) || 0,
        volUsd: Number(k[7]) || 0,
        confirm: String(k[8]) === '1',
      });
    }
    const oldest = Number(rows[rows.length - 1][0]);
    after = String(oldest);
    if (rows.length < 100) break;
    if (oldest <= targetStartTs) break;
    if (map.size >= wantCount) break;
    await sleep(120);
  }

  return Array.from(map.values()).sort((a, b) => a.ts - b.ts);
}

/** Paginates /public/funding-rate-history back `days` days. Funding here is 8h. */
async function fetchFunding(instId: string, days: number) {
  const targetStartTs = Date.now() - days * 86_400_000;
  const map = new Map<number, { ts: number; fundingRate: number; realizedRate: number }>();
  let before: string | undefined;

  for (let page = 0; page < 100; page++) {
    const q =
      `/api/v5/public/funding-rate-history?instId=${encodeURIComponent(instId)}&limit=100` +
      (before ? `&before=${before}` : '');
    const json = await okxGet(q);
    const rows: any[] = json.data || [];
    if (rows.length === 0) break;
    let oldest = Infinity;
    for (const r of rows) {
      const ts = Number(r.fundingTime);
      oldest = Math.min(oldest, ts);
      if (ts >= targetStartTs) {
        map.set(ts, {
          ts,
          fundingRate: Number(r.fundingRate) || 0,
          realizedRate: Number(r.realizedRate ?? r.fundingRate) || 0,
        });
      }
    }
    if (oldest <= targetStartTs || rows.length < 100) break;
    before = String(oldest);
    await sleep(120);
  }

  return Array.from(map.values()).sort((a, b) => a.ts - b.ts);
}

/**
 * OI history via rubik: `[[ts, oiContracts, volumeContracts], ...]` at 1D granularity.
 * Rubik is keyed by bare `ccy`, so two XPERP contracts sharing a base would collide — here
 * each base is unique among the five, so the mapping is unambiguous.
 */
async function fetchOiHistory(ccy: string, days: number) {
  const end = Date.now();
  const begin = end - days * 86_400_000;
  const q = `/api/v5/rubik/stat/contracts/open-interest-volume?ccy=${ccy}&period=1D&begin=${begin}&end=${end}`;
  const json = await okxGet(q);
  return (json.data || []).map((r: any) => ({
    ts: Number(r[0]),
    oi: Number(r[1]) || 0,
    vol: Number(r[2]) || 0,
  })).sort((a: any, b: any) => a.ts - b.ts);
}

async function fetchOiSnapshot(instId: string) {
  const json = await okxGet(`/api/v5/public/open-interest?instType=FUTURES&instId=${encodeURIComponent(instId)}`);
  const d = (json.data || [])[0];
  if (!d) return null;
  return {
    ts: Number(d.ts),
    oi: Number(d.oi) || 0,
    oiCcy: Number(d.oiCcy) || 0,
    oiUsd: Number(d.oiUsd) || 0,
  };
}

/** Live spread only — OKX publishes no historical book. This is a point-in-time snapshot. */
async function fetchLiveSpread(instId: string) {
  const json = await okxGet(`/api/v5/market/books?instId=${encodeURIComponent(instId)}&sz=5`);
  const b = (json.data || [])[0];
  if (!b) return null;
  const bid = Number(b.bids?.[0]?.[0]) || 0;
  const ask = Number(b.asks?.[0]?.[0]) || 0;
  const mid = (bid + ask) / 2;
  const topBidSz = Number(b.bids?.[0]?.[1]) || 0;
  const topAskSz = Number(b.asks?.[0]?.[1]) || 0;
  const bidDepthUsd = (b.bids || []).reduce((s: number, l: any) => s + Number(l[0]) * Number(l[1]), 0);
  const askDepthUsd = (b.asks || []).reduce((s: number, l: any) => s + Number(l[0]) * Number(l[1]), 0);
  return {
    ts: Number(b.ts),
    bid,
    ask,
    spreadAbs: ask - bid,
    spreadPct: mid > 0 ? ((ask - bid) / mid) * 100 : 0,
    topBidSz,
    topAskSz,
    bidDepthUsd,
    askDepthUsd,
    /** Measured once; NOT a historical series. */
    note: 'live snapshot at collection time',
  };
}

async function fetchInstrumentMeta(instId: string) {
  const json = await okxGet(
    `/api/v5/public/instruments?instType=FUTURES&instId=${encodeURIComponent(instId)}`
  );
  const d = (json.data || [])[0];
  if (!d) return null;
  return {
    instId: d.instId,
    instFamily: d.instFamily,
    ctVal: Number(d.ctVal) || 0,
    ctValCcy: d.ctValCcy,
    tickSz: Number(d.tickSz) || 0,
    lotSz: Number(d.lotSz) || 0,
    minSz: Number(d.minSz) || 0,
    lever: Number(d.lever) || 0,
    settleCcy: d.settleCcy,
    ruleType: d.ruleType,
    listTime: Number(d.listTime) || 0,
    expTime: Number(d.expTime) || 0,
    state: d.state,
  };
}

async function fetchTicker(instId: string) {
  const json = await okxGet(`/api/v5/market/ticker?instId=${encodeURIComponent(instId)}`);
  const d = (json.data || [])[0];
  if (!d) return null;
  return {
    ts: Number(d.ts),
    last: Number(d.last) || 0,
    vol24h: Number(d.vol24h) || 0,
    volCcy24h: Number(d.volCcy24h) || 0,
    bidPx: Number(d.bidPx) || 0,
    askPx: Number(d.askPx) || 0,
  };
}

function writeJson(name: string, data: unknown) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const p = path.join(OUT_DIR, name);
  fs.writeFileSync(`${p}.tmp`, JSON.stringify(data), 'utf8');
  fs.renameSync(`${p}.tmp`, p);
  return p;
}

(async () => {
  const picked = ONLY
    ? INSTRUMENTS.filter((i) => ONLY.split(',').map((s) => s.trim().toUpperCase()).includes(i.short))
    : INSTRUMENTS;

  console.log(`TB5 collector | EEA | ${DAYS} zile | bare=${BARS.join(',')} | ${picked.length} instrumente\n`);

  const metaBlob: Record<string, any> = {};

  for (const inst of picked) {
    console.log(`--- ${inst.short} (${inst.instId})`);
    const meta = await fetchInstrumentMeta(inst.instId);
    const ticker = await fetchTicker(inst.instId);
    const oiSnap = await fetchOiSnapshot(inst.instId);
    const spread = await fetchLiveSpread(inst.instId);
    metaBlob[inst.short] = { meta, ticker, oiSnapshot: oiSnap, liveSpread: spread, collectedAt: Date.now() };
    console.log(
      `  meta ctVal=${meta?.ctVal} ${meta?.ctValCcy} tick=${meta?.tickSz} lot=${meta?.lotSz} ` +
        `lev=${meta?.lever} exp=${meta?.expTime}`
    );
    console.log(
      `  live last=${ticker?.last} spread=${spread?.spreadPct?.toFixed(4)}% ` +
        `depth bid/ask=$${Math.round(spread?.bidDepthUsd || 0)}/$${Math.round(spread?.askDepthUsd || 0)}`
    );

    for (const bar of BARS) {
      try {
        const candles = await fetchCandles(inst.instId, bar, DAYS);
        if (candles.length === 0) {
          console.log(`  candles ${bar.padEnd(6)} VIDE`);
          continue;
        }
        writeJson(`${inst.short}_${inst.instId}_candles_${bar}.json`, candles);
        const first = new Date(candles[0].ts).toISOString().slice(0, 10);
        const last = new Date(candles[candles.length - 1].ts).toISOString().slice(0, 10);
        console.log(`  candles ${bar.padEnd(6)} ${candles.length} bare  ${first} -> ${last}`);
      } catch (err: any) {
        console.log(`  candles ${bar.padEnd(6)} EROARE: ${err?.message}`);
      }
      await sleep(150);
    }

    try {
      const funding = await fetchFunding(inst.instId, DAYS);
      writeJson(`${inst.short}_${inst.instId}_funding.json`, funding);
      console.log(`  funding        ${funding.length} inregistrari`);
    } catch (err: any) {
      console.log(`  funding        EROARE: ${err?.message}`);
    }

    try {
      const oi = await fetchOiHistory(inst.ccy, DAYS);
      writeJson(`${inst.short}_${inst.instId}_oi.json`, oi);
      const nonZero = oi.filter((r: any) => r.oi > 0).length;
      console.log(`  OI istoric     ${oi.length} zile (${nonZero} cu OI>0)`);
    } catch (err: any) {
      console.log(`  OI istoric     EROARE: ${err?.message}`);
    }

    console.log('');
    await sleep(200);
  }

  writeJson('meta.json', metaBlob);
  console.log(`Gata. Date scrise in: ${OUT_DIR}`);
})();
