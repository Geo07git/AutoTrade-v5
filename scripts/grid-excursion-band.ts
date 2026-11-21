/**
 * FAZA 1+2: cat de lata trebuie sa fie banda ca sa acopere 80% din excursiile de 8h — si ramane
 * pasul grilei peste podeaua de comision la latimea aceea?
 *
 * Context: `gridPlan.deriveGridGeometry` dimensioneaza banda ca
 *
 *     halfRangePct = z * ATR(1h) * sqrt(orizont),   z = 1/sqrt(2.2) = 0.674, orizont = 8h
 *
 * adica ±0.674 sigma din miscarea pe 8h => acoperire teoretica ~50%. Backtestul a masurat 46%
 * breakout-uri, deci formula face EXACT ce promite: grila moare in ~jumatate din cazuri la orizont.
 * Intrebarea acestui script nu e "e stricata formula", ci: daca am dimensiona banda dupa percentila
 * EMPIRICA p80 in loc de z gaussian, (a) cat de lata ar trebui sa fie, (b) o permite clampa
 * [GRID_MIN_HALF_RANGE_PCT, GRID_MAX_HALF_RANGE_PCT] si (c) mai ramane destul pas intre niveluri
 * ca sa acopere comisionul?
 *
 * (c) e poarta de trecere: o banda lata cu pas sub podeaua de comision e o masina de platit fee-uri,
 * nu o grila. Daca (b) sau (c) pica, schimbarea de design nu merita facuta.
 *
 * Read-only: istoric public OKX, fara credente, fara ordine.
 *
 * Run:
 *   npx tsx scripts/grid-excursion-band.ts --days=21 --symbols=25
 */

import { isTradableXPerp } from '../src/server/scanner/UniverseManager';
import {
  deriveGridGeometry,
  GRID_HOLDING_SIGMA_Z,
  GRID_DEFAULT_TARGET_HOLDING_HOURS,
  GRID_MAX_HALF_RANGE_PCT,
  GRID_MIN_HALF_RANGE_PCT,
} from '../src/server/engine/grid/gridPlan';
import type { Kline } from '../src/shared/types';

const BASE = 'https://www.okx.com';
const HORIZON_H = 8;

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  })
);
const DAYS = Math.max(3, Math.min(30, Number(args.get('days')) || 21));
const SYMBOLS = Math.max(2, Math.min(60, Number(args.get('symbols')) || 25));
const FEE = Number(args.get('fee')) || 0.08;
const SPREAD = Number(args.get('spread')) || 0.05;
const TARGET_COVERAGE = Math.max(0.5, Math.min(0.99, Number(args.get('coverage')) || 0.8));

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

async function fetchHistory(instId: string, bar: string, want: number): Promise<Kline[]> {
  const out: Kline[] = [];
  let after: string | undefined;
  const stepMs = bar === '1H' ? 3_600_000 : 900_000;
  const endMs = Date.now();
  while (out.length < want) {
    const json = await okxGet(
      `/api/v5/market/history-candles?instId=${instId}&bar=${bar}&limit=100` + (after ? `&after=${after}` : '')
    );
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
    await sleep(130);
  }
  out.sort((a, b) => a.timestamp - b.timestamp);
  return out.slice(0, -1).slice(-want);
}

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const quantile = (xs: number[], q: number): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * s.length)))];
};

/** ATR as % of price, same shape the scan uses: mean true range over the sampled bars. */
const atrPct = (bars: Kline[]): number => {
  if (bars.length < 2) return 0;
  let sum = 0;
  let n = 0;
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1].close;
    const tr = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - prev),
      Math.abs(bars[i].low - prev)
    );
    if (prev > 0) {
      sum += (tr / prev) * 100;
      n++;
    }
  }
  return n > 0 ? sum / n : 0;
};

interface Row {
  instId: string;
  atr1hPct: number;
  currentHalfPct: number;
  currentStepPct: number;
  currentCoverage: number;
  neededRatio: number;
  rawNeededHalfPct: number;
  neededHalfPct: number;
  neededStepPct: number;
  neededNetPerGridPct: number;
  feeFloorPct: number;
  clamped: boolean;
  windows: number;
}

(async () => {
  console.log(
    `EXCURSIE 8h vs BANDA ACTUALA | ${DAYS} zile | top ${SYMBOLS} X-Perp | tinta acoperire ` +
      `${Math.round(TARGET_COVERAGE * 100)}%\n` +
      `  fee round-trip ${FEE}% | spread ${SPREAD}% | orizont ${HORIZON_H}h | z actual ` +
      `${GRID_HOLDING_SIGMA_Z} => ±${(GRID_HOLDING_SIGMA_Z * Math.sqrt(HORIZON_H)).toFixed(2)} sigma\n` +
      `  banda legala: [${GRID_MIN_HALF_RANGE_PCT}%, ${GRID_MAX_HALF_RANGE_PCT}%] jumatate de banda\n`
  );

  // --- universe ------------------------------------------------------------------------------
  const [instruments, tickers] = await Promise.all([
    okxGet('/api/v5/public/instruments?instType=FUTURES'),
    okxGet('/api/v5/market/tickers?instType=FUTURES'),
  ]);
  const byId = new Map<string, any>((tickers.data || []).map((t: any) => [t.instId, t]));
  const universe: Array<{ instId: string; turnoverUsd: number }> = [];
  for (const inst of instruments.data || []) {
    if (!isTradableXPerp(inst)) continue;
    const t = byId.get(inst.instId);
    if (!t) continue;
    const last = Number(t.last);
    const turnoverUsd = Number(t.vol24h) * (Number(inst.ctVal) || 1) * last;
    if (!(last > 0) || !(turnoverUsd > 0)) continue;
    universe.push({ instId: inst.instId, turnoverUsd });
  }
  universe.sort((a, b) => b.turnoverUsd - a.turnoverUsd);
  const picked = universe.slice(0, SYMBOLS);
  console.log(`univers: ${universe.length} X-Perp-uri live, masor pe ${picked.length}\n`);

  const rows: Row[] = [];
  const barsPerWindow = (HORIZON_H * 60) / 15;

  for (const u of picked) {
    let bars15m: Kline[] = [];
    let bars1h: Kline[] = [];
    try {
      [bars15m, bars1h] = await Promise.all([
        fetchHistory(u.instId, '15m', DAYS * 96 + barsPerWindow + 4),
        fetchHistory(u.instId, '1H', 200),
      ]);
    } catch (err: any) {
      console.log(`  ${u.instId}: fetch esuat (${err?.message}), sarit`);
      continue;
    }
    if (bars15m.length < barsPerWindow * 4 || bars1h.length < 30) {
      console.log(`  ${u.instId}: istoric insuficient, sarit`);
      continue;
    }

    // Walk-forward: for EVERY 8h window, rebuild the band the scan would have produced from the
    // TRAILING ATR only (no look-ahead), then measure how far price actually travelled from the
    // window's open. Two corrections over the naive version:
    //   - the ATR is trailing, not one global average (volatility clusters, so a single ATR from
    //     a quiet week would make every band look too narrow, and one from a violent week too wide);
    //   - travel is `max(|hi-open|, |open-lo|)`, the real one-sided distance to an edge, NOT
    //     `(hi-lo)/2`. A window that opens at its low and runs up 2h breaches the far edge by h,
    //     yet `(hi-lo)/2` would call that 'inside'.
    const bands: number[] = [];
    const requireds: number[] = [];
    const ratios: number[] = [];
    const steps: number[] = [];
    const atrs: number[] = [];

    for (let i = 0; i + barsPerWindow <= bars15m.length; i += barsPerWindow) {
      const win = bars15m.slice(i, i + barsPerWindow);
      const openPx = win[0].open;
      if (!(openPx > 0)) continue;

      const trailing15 = bars15m.slice(Math.max(0, i - 48), i);
      if (trailing15.length < 20) continue;
      const trailing1h = bars1h.filter((b) => b.timestamp < win[0].timestamp).slice(-60);
      if (trailing1h.length < 24) continue;

      const atr15 = atrPct(trailing15);
      const atr1h = atrPct(trailing1h);
      if (!(atr15 > 0) || !(atr1h > 0)) continue;

      const geo = deriveGridGeometry({
        atrPct: atr15,
        atrPct1h: atr1h,
        roundTripFeePct: FEE,
        spreadPct: SPREAD,
      });
      if (!geo) continue;

      const hi = Math.max(...win.map((k) => k.high));
      const lo = Math.min(...win.map((k) => k.low));
      const required = (Math.max(Math.abs(hi - openPx), Math.abs(openPx - lo)) / openPx) * 100;

      bands.push(geo.halfRangePct);
      steps.push(geo.stepPct);
      requireds.push(required);
      ratios.push(required / Math.max(0.01, geo.halfRangePct));
      atrs.push(atr1h);
    }

    if (bands.length < 4) continue;

    const currentHalf = median(bands);
    const currentCoverage =
      requireds.filter((r, idx) => r <= bands[idx]).length / requireds.length;
    const neededRatio = quantile(ratios, TARGET_COVERAGE);
    const rawNeeded = currentHalf * neededRatio;

    // What production returns when asked for that band. The function clamps, so a needed band above
    // GRID_MAX_HALF_RANGE_PCT comes back LOWER: that is the reachability test, in production's own
    // terms instead of mine.
    const neededGeometry = deriveGridGeometry({
      atrPct: atrPct(bars15m.slice(-48)),
      atrPct1h: rawNeeded / (GRID_HOLDING_SIGMA_Z * Math.sqrt(HORIZON_H)),
      roundTripFeePct: FEE,
      spreadPct: SPREAD,
    });
    if (!neededGeometry) continue;

    rows.push({
      instId: u.instId,
      atr1hPct: median(atrs),
      currentHalfPct: currentHalf,
      currentStepPct: median(steps),
      currentCoverage,
      neededRatio,
      rawNeededHalfPct: rawNeeded,
      neededHalfPct: neededGeometry.halfRangePct,
      neededStepPct: neededGeometry.stepPct,
      neededNetPerGridPct: neededGeometry.netPerGridPct,
      feeFloorPct: neededGeometry.feeFloorPct,
      clamped: rawNeeded > neededGeometry.halfRangePct + 0.01,
      windows: requireds.length,
    });
  }

  if (rows.length === 0) {
    console.log('Nicio masuratoare valida.');
    return;
  }

  const short = (id: string) => id.replace('-USD_UM_XPERP', '').replace(/-\d+$/, '');

  console.log(
    '  ' +
      'instrument'.padEnd(14) +
      'ATR1h%'.padStart(7) +
      'banda%'.padStart(8) +
      'acoper%'.padStart(8) +
      'nevoie%'.padStart(9) +
      'x'.padStart(5) +
      'clamp'.padStart(7) +
      'pas%'.padStart(7) +
      'podea%'.padStart(8) +
      'net%'.padStart(7)
  );
  for (const r of rows) {
    console.log(
      '  ' +
        short(r.instId).padEnd(14) +
        r.atr1hPct.toFixed(2).padStart(7) +
        r.currentHalfPct.toFixed(2).padStart(8) +
        `${Math.round(r.currentCoverage * 100)}%`.padStart(8) +
        r.rawNeededHalfPct.toFixed(2).padStart(9) +
        r.neededRatio.toFixed(2).padStart(5) +
        (r.clamped ? 'DA' : '-').padStart(7) +
        r.neededStepPct.toFixed(3).padStart(7) +
        r.feeFloorPct.toFixed(3).padStart(8) +
        r.neededNetPerGridPct.toFixed(3).padStart(7)
    );
  }

  const coverageNow = median(rows.map((r) => r.currentCoverage));
  const ratio = median(rows.map((r) => r.neededRatio));
  const clampedShare = rows.filter((r) => r.clamped).length / rows.length;
  const stepBelowFloor = rows.filter((r) => r.neededStepPct < r.feeFloorPct).length;
  const stepBelowFloorPlusSpread = rows.filter(
    (r) => r.neededStepPct < r.feeFloorPct + SPREAD
  ).length;
  const netNegative = rows.filter((r) => r.neededNetPerGridPct <= 0).length;

  console.log('\n' + '='.repeat(100));
  console.log('AGREGAT');
  console.log(
    `  acoperire curenta (mediana pe ferestre): ${Math.round(coverageNow * 100)}%  ` +
      `=> breakout ${Math.round((1 - coverageNow) * 100)}% (masurat in backtest: 46%)`
  );
  console.log(
    `  banda necesara pentru ${Math.round(TARGET_COVERAGE * 100)}%: ${ratio.toFixed(2)}x fata de cea actuala ` +
      `(mediana jumatate ${median(rows.map((r) => r.rawNeededHalfPct)).toFixed(2)}% vs ` +
      `${median(rows.map((r) => r.currentHalfPct)).toFixed(2)}%)`
  );
  console.log(
    `  prinsa de clampa [${GRID_MIN_HALF_RANGE_PCT}%, ${GRID_MAX_HALF_RANGE_PCT}%]: ${Math.round(
      clampedShare * 100
    )}% din instrumente`
  );
  console.log(
    `  pas sub podeaua de comision (${FEE}%x3): ${stepBelowFloor}/${rows.length} | ` +
      `pas sub podea+spread: ${stepBelowFloorPlusSpread}/${rows.length} | ` +
      `castig net/nivel <= 0: ${netNegative}/${rows.length}`
  );

  console.log('\nVERDICT:');
  const reachable = clampedShare < 0.5;
  const economicsOk = stepBelowFloorPlusSpread === 0 && netNegative === 0;
  if (!reachable) {
    console.log(
      `  POARTA PICA: la ${Math.round(TARGET_COVERAGE * 100)}% acoperire, banda ceruta e peste `
      + `clampa de ${GRID_MAX_HALF_RANGE_PCT}% pentru ${Math.round(clampedShare * 100)}% din instrumente. `
      + `Nu se poate dimensiona banda din percentila fara sa scoti clampul, iar clampul e ce opreste `
      + `o banda absurd de lata sa devina o pozitie one-sided uriasa.`
    );
  } else if (!economicsOk) {
    console.log(
      `  POARTA PICA: banda e realizabila, dar pasul la latimea aceea nu mai acopera comisionul + spread `
      + `la ${stepBelowFloorPlusSpread} instrumente. O banda mai lata cu pas sub podea e o masina de fee-uri.`
    );
  } else {
    console.log(
      `  POARTA TRECE: banda de ${ratio.toFixed(2)}x e realizabila si pasul ramane peste podeaua de comision. ` +
        `Merita implementata si validata cu backtestul.`
    );
  }
  console.log('');
})();
