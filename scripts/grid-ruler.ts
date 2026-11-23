/**
 * Rigla de evaluare a rularii live -- READ-ONLY.
 *
 * Nu vorbeste cu OKX, nu scrie nimic, nu atinge trading-ul: citeste `.data/` si tipareste
 * cele sase numere din docs/audit-2026-11-14.md §5 plus pragul de oprire (3 boti consecutivi
 * opriti sub 10 minute cu `falseBreakCount > 0`).
 *
 * Ce NU se vede in UI (si de aici vine scriptul):
 *   - varsta botului la oprire (UI arata doar evenimentul, fara `cTime`);
 *   - `falseBreakCount` (scris de P0.2 in eveniment, dar niciun panou nu il randeaza).
 *
 * Surse:
 *   native_grid_bots.json        -- cTime / state / geometry (viata botului)
 *   grid_analyzer_events.json    -- motivul opririi + falseBreakCount
 *   okx_synced_transactions.json -- fill-uri reale: singura sursa onesta pentru trips/PnL
 *
 * `arbitrageNum` din registrul local NU se foloseste: e 0 pe 137/138 boti, fiindca OKX nu
 * intoarce campul pentru id-urile `_UM_XPERP`.
 *
 * Run: npm run ruler
 */

import fs from 'fs';
import path from 'path';

const DATA = path.join(process.cwd(), '.data');

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA, file), 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/**
 * `okx_synced_transactions.json` is schemaVersion 2 since the fiscal cache was versioned:
 * `{ schemaVersion: 2, records: [...] }`. Older exports are a flat array. The ruler used to assume
 * the flat array only, so it crashed (`all is not iterable`) on every versioned cache and printed
 * nothing -- which is how the most important number in the audit stays invisible. Accept both
 * shapes; neither is echoed to the console.
 */
function asList<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  const records = (value as { records?: unknown } | null)?.records;
  return Array.isArray(records) ? (records as T[]) : [];
}

interface Bot {
  algoId: string;
  instId: string;
  state?: string;
  cTime?: number;
  uTime?: number;
  sz?: number;
  lever?: number;
  stopReason?: string;
  stopTypeOnRisk?: string;
}

interface StopEvent {
  timestamp: number;
  algoId: string;
  instId: string;
  exactStopReason?: string;
  executedDecision?: string;
  stopType?: string;
  falseBreakCount?: number;
}

/** Un fill real de pe cont (OKX bills). */
interface Fill {
  symbol: string;
  timestamp: number;
  side: string;
  pnlUSD: number;
  feeUSD: number;
  notionalUSD: number;
  rawOrderId?: string;
  closeType?: string;
}

/**
 * Cache-ul fiscal contine acelasi ordin de 3-5 ori (orders-history, bills, fills, grid FIFO),
 * iar familia `OKX_GRID_FIFO_*` calculeaza FIFO peste tot istoricul si produce sume absurde
 * (+601 USDT pe un cont de 45). Singura familie cu magnitudini sanatoare e `OKX_ORDER_*`,
 * deduplicata pe `rawOrderId`. Tot ce urmeaza se bazeaza pe regula asta.
 */
const usableFillsOf = (all: Fill[]): Fill[] => {
  const seen = new Set<string>();
  const out: Fill[] = [];
  for (const f of all) {
    if (!String(f.closeType || '').startsWith('OKX_ORDER')) continue;
    const key = String(f.rawOrderId || `${f.symbol}:${f.timestamp}`);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
};

const median = (values: number[]): number => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const fmt = (n: number, digits = 2): string => (Number.isFinite(n) ? n.toFixed(digits) : 'n/a');

const mins = (ms: number): number => Math.round(ms / 60000);

const bots = asList<Bot>(readJson<unknown>('native_grid_bots.json', null));
const events = asList<StopEvent>(readJson<unknown>('grid_analyzer_events.json', null));
const fills = asList<Fill>(readJson<unknown>('okx_synced_transactions.json', null));
const usableFills = usableFillsOf(fills);

const byAlgo = new Map<string, Bot>(bots.map((b) => [String(b.algoId), b]));
const running = bots.filter((b) => String(b.state || '').toLowerCase() === 'running');

if (!events.length && !bots.length) {
  console.log('Nicio data in .data/ -- rigla nu are ce masura.');
  process.exit(0);
}

/** Fills-urile unui bot, in fereastra lui de viata (symbol + [cTime, stopTs]). */
const fillsOf = (instId: string, from: number, to: number): Fill[] =>
  usableFills.filter((f) => f.symbol === instId && f.timestamp >= from && f.timestamp <= to);

interface Row {
  instId: string;
  algoId: string;
  lifeMin: number | null;
  reason: string;
  falseBreak: number | null;
  /** Round-trip-uri = vanzari executate (fiecare inchide un nivel cumparat). */
  trips: number;
  capture: number;
  exitCost: number;
  fees: number;
  pnl: number;
  ts: number;
  /**
   * Feed-ul de fill-uri acopera fereastra botului?
   * Cache-ul `okx_synced_transactions.json` se actualizeaza DOAR la sync manual (tab Fiscal),
   * deci un bot oprit dupa ultimul sync are 0 fill-uri inregistrate, nu 0 fill-uri reale.
   */
  covered: boolean;
}

const feedMaxTs = usableFills.reduce((max, f) => Math.max(max, Number(f.timestamp) || 0), 0);

const rows: Row[] = events
  .map((ev) => {
    const bot = byAlgo.get(String(ev.algoId));
    const instId = String(ev.instId || bot?.instId || '?');
    const openedAt = Number(bot?.cTime) || 0;
    const closedAt = Number(ev.timestamp) || 0;
    const mine = openedAt && closedAt ? fillsOf(instId, openedAt, closedAt) : [];
    return {
      instId,
      algoId: String(ev.algoId || '?'),
      lifeMin: openedAt && closedAt ? mins(closedAt - openedAt) : null,
      reason: String(ev.exactStopReason || bot?.stopReason || '').replace(/\s+/g, ' ').slice(0, 40),
      falseBreak: typeof ev.falseBreakCount === 'number' ? ev.falseBreakCount : null,
      trips: mine.filter((f) => String(f.side).toUpperCase() === 'SELL').length,
      capture: mine.reduce((sum, f) => sum + Math.max(0, Number(f.pnlUSD) || 0), 0),
      exitCost: Math.abs(mine.reduce((sum, f) => sum + Math.min(0, Number(f.pnlUSD) || 0), 0)),
      fees: mine.reduce((sum, f) => sum + (Number(f.feeUSD) || 0), 0),
      pnl: mine.reduce((sum, f) => sum + (Number(f.pnlUSD) || 0), 0),
      ts: closedAt,
      covered: closedAt > 0 && closedAt <= feedMaxTs,
    };
  })
  .sort((a, b) => a.ts - b.ts);

// Metricile de bani se calculeaza DOAR pe botii acoperiti de feed: altfel "0 fill-uri
// inregistrate" se citeste ca "0 round-trip-uri", adica exact concluzia gresita.
const covered = rows.filter((r) => r.covered);
const uncovered = rows.length - covered.length;
const lives = rows.map((r) => r.lifeMin).filter((v): v is number => v !== null);
const capture = covered.reduce((sum, r) => sum + r.capture, 0);
const exitCost = covered.reduce((sum, r) => sum + r.exitCost, 0);
const fees = covered.reduce((sum, r) => sum + r.fees, 0);
const net = covered.reduce((sum, r) => sum + r.pnl, 0) - fees;
const totalTrips = covered.reduce((sum, r) => sum + r.trips, 0);
const zeroTrips = covered.filter((r) => r.trips === 0).length;
const withFalseBreak = rows.filter((r) => (r.falseBreak ?? 0) > 0).length;
const measuredFalseBreak = rows.filter((r) => r.falseBreak !== null).length;

// Pragul de oprire: ultimele 3 opriri, toate sub 10 min, toate cu falseBreak > 0.
const tail = rows.slice(-3);
const killAlert =
  tail.length === 3 &&
  tail.every((r) => r.lifeMin !== null && r.lifeMin < 10 && (r.falseBreak ?? 0) > 0);

const first = rows[0]?.ts;
const last = rows[rows.length - 1]?.ts;
if (first && last) {
  console.log(
    `Fereastra: ${new Date(first).toISOString().slice(0, 16)} -> ${new Date(last)
      .toISOString()
      .slice(0, 16)}  (${((last - first) / 36e5).toFixed(1)} h)`
  );
}
console.log(
  `Boti in registru: ${bots.length} | ruleaza acum: ${running.length} | opriri inregistrate: ${rows.length}\n`
);
if (!feedMaxTs) {
  console.log('!! Feed de fill-uri GOL: nu se pot masura trips/PnL. Ruleaza Sync in tab-ul Fiscal.\n');
} else {
  const lagH = last ? (last - feedMaxTs) / 36e5 : 0;
  console.log(
    `Feed fills: ultimul la ${new Date(feedMaxTs).toISOString().slice(0, 16)}` +
      (uncovered ? ` | ${uncovered} opriri DUPA el (neacoperite)` : ' | acopera toate opririle')
  );
  if (uncovered) {
    console.log(
      `!! ATENTIE: ${uncovered} din ${rows.length} opriri nu au fill-uri inregistrate (sync manual,` +
        ` ultimul acum ${lagH.toFixed(0)} h).\n   Metricile 2-4 si 6 se calculeaza doar pe cele ${covered.length} acoperite.\n`
    );
  } else {
    console.log('');
  }
}

console.log('instId                         viata  trips   capture    iesire      fees       net  motiv');
console.log('-'.repeat(122));
for (const r of rows.slice(-15)) {
  console.log(
    [
      r.instId.padEnd(30).slice(0, 30),
      `${r.lifeMin === null ? '  n/a' : String(r.lifeMin).padStart(4)}m`,
      String(r.trips).padStart(5),
      fmt(r.capture).padStart(9),
      fmt(r.exitCost).padStart(9),
      fmt(r.fees).padStart(9),
      `${r.pnl - r.fees >= 0 ? '+' : ''}${fmt(r.pnl - r.fees)}`.padStart(9),
      r.reason,
    ].join('  ')
  );
}

console.log('\n-- cele 6 numere ---------------------------------------------------------');
console.log(`1. viata mediana            ${fmt(median(lives), 0)} min          (era 50, prag >= 480)   [${lives.length} opriri]`);
console.log(
  `2. round-trip-uri / bot     ${covered.length ? fmt(totalTrips / covered.length, 2) : 'n/a'}             (era 1.75, prag >= 3)   [${covered.length} boti]`
);
console.log(
  `3. iesire / captura         ${capture > 0 ? fmt(exitCost / capture) : 'n/a'}             (era 1.76, prag < 1)` +
    `   [captura ${fmt(capture)} | iesire ${fmt(exitCost)}]`
);
console.log(
  `4. boti cu 0 round-trip-uri ${covered.length ? Math.round((zeroTrips / covered.length) * 100) : 0}%             (era 45%, prag < 15%)`
);
console.log(
  `5. falseBreak / opriri      ${
    measuredFalseBreak ? `${withFalseBreak} din ${measuredFalseBreak}` : 'n/a (niciun eveniment cu campul scris)'
  }   (prag < 0.3)`
);
console.log(
  `6. net cumulat              ${net >= 0 ? '+' : ''}${fmt(net)} USDT      (era -7.79, prag > -1)   [fees ${fmt(fees)}]`
);
console.log(
  '\nNota: trips/captura/iesire se numara din `okx_synced_transactions.json`, familia\n' +
    '      `OKX_ORDER_*` deduplicata pe `rawOrderId` (' +
    `${usableFills.length} din ${fills.length} randuri). Familia OKX_GRID_FIFO_* e exclusa:\n` +
    '      contorizeaza FIFO peste tot istoricul (+601 USDT pe un cont de 45) si e inutilizabila.\n' +
    '      Cache-ul se actualizeaza DOAR la sync manual (tab Fiscal -> Sync OKX): ruleaza-l\n' +
    '      inainte de fiecare citire, altfel cifrele ingheata la ultimul sync.\n' +
    '      `arbitrageNum` din registrul local e 0 pe 137/138 boti -- OKX nu intoarce campul\n' +
    '      pentru id-urile `_UM_XPERP`, deci nu se poate folosi ca masura.'
);

console.log('\n-- prag de oprire --------------------------------------------------------');
if (tail.length < 3) {
  console.log(`Prea putine opriri pentru verdict (${tail.length}/3).`);
} else if (killAlert) {
  console.log('!! ALERTA: ultimele 3 opriri sunt sub 10 min SI au falseBreak > 0 -- opreste si evalueaza.');
} else {
  console.log('Fara alerta: ultimele 3 opriri nu indeplinesc ambele conditii.');
  for (const r of tail) {
    console.log(
      `   ${r.instId.slice(0, 28).padEnd(28)} viata ${String(r.lifeMin ?? 'n/a').padStart(4)}m  falseBreak ${r.falseBreak ?? 'n/a'}`
    );
  }
}
