/**
 * Regimul de piata ACUM, pe pragurile din cod. READ-ONLY.
 *
 * Raspunde la intrebarea "piata a devenit directionala?" cu aceleasi trei masuratori pe care
 * aplicatia le foloseste ca sa refuze un grid: efficiency ratio (displacement), ADX (presiune
 * directionala), Choppiness (cat de mult se intoarce pretul).
 *
 * Pragurile nu sunt inventate aici: GRID_ER_TREND_THRESHOLD / GRID_ER_EXIT_CONFIRMED,
 * GRID_ADX_TREND_SELECTION, GRID_CHOP_TREND_SELECTION.
 *
 * Run: npm run regime-now
 */

import {
  efficiencyRatioFromKlines,
  wilderAdx,
  choppinessIndex,
  GRID_ER_TREND_THRESHOLD,
  GRID_ADX_TREND_SELECTION,
  GRID_CHOP_TREND_SELECTION,
  GRID_ER_SCAN_BARS,
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function candles(instId: string, bar: string, limit = 120): Promise<Kline[]> {
  const res = await fetch(
    `${BASE}/api/v5/market/candles?instId=${encodeURIComponent(instId)}&bar=${bar}&limit=${limit}`
  );
  const body: any = await res.json();
  if (String(body?.code) !== '0') return [];
  return (body.data as any[])
    .map((r) => ({
      timestamp: Number(r[0]),
      open: Number(r[1]),
      high: Number(r[2]),
      low: Number(r[3]),
      close: Number(r[4]),
      volume: Number(r[5]),
    }))
    .filter((k) => k.close > 0)
    .sort((a, b) => a.timestamp - b.timestamp);
}

const f = (n: number | null, d = 2) => (n === null || !Number.isFinite(n) ? ' n/a' : n.toFixed(d).padStart(5));

async function main() {
  console.log('Regim de piata, praguri din cod (ER > ' + GRID_ER_TREND_THRESHOLD +
    ', ADX > ' + GRID_ADX_TREND_SELECTION + ', Chop < ' + GRID_CHOP_TREND_SELECTION + ')\n');
  console.log('simbol                        ER(8h)   ADX14   Chop14   displacement  2 zile (48h)');
  console.log('-'.repeat(92));

  let trending = 0;
  let measured = 0;

  for (const symbol of SYMBOLS) {
    const [b15, b1h] = await Promise.all([
      candles(symbol, '15m'),
      candles(symbol, '1H'),
    ]);
    if (b15.length < 40) {
      console.log(`${symbol.padEnd(28)}  SKIP (date insuficiente)`);
      continue;
    }

    const er = efficiencyRatioFromKlines(b15, GRID_ER_SCAN_BARS);
    const adx = wilderAdx(b15);
    const chop = choppinessIndex(b15);
    // Aceeasi masuratoare pe 1h, ca sa vedem daca e o faza scurta sau o saptamana intreaga.
    const erWeek = efficiencyRatioFromKlines(b1h, 48);

    const isTrending =
      (er !== null && er > GRID_ER_TREND_THRESHOLD) ||
      (adx !== null && adx > GRID_ADX_TREND_SELECTION) ||
      (chop !== null && chop < GRID_CHOP_TREND_SELECTION);

    if (er !== null && adx !== null && chop !== null) measured++;
    if (isTrending) trending++;

    console.log(
      `${symbol.padEnd(28)}  ${f(er)}   ${f(adx)}   ${f(chop)}      ` +
        `${(isTrending ? 'DA' : 'nu').padEnd(10)}  ER48h ${f(erWeek)}`
    );
    await sleep(140);
  }

  console.log('\n-- verdict ----------------------------------------------------------------');
  console.log(`${trending} din ${measured} instrumente sunt in regim directionar dupa pragurile codului.`);
  if (measured > 0 && trending / measured >= 0.75) {
    console.log('Piata E directionala acum -- un grid neutral e un instrument nepotrivit in aceasta fereastra.');
  } else if (measured > 0 && trending / measured <= 0.25) {
    console.log('Piata NU e directionala acum -- un grid neutral are regimul pe care il vrea.');
  } else {
    console.log('Piata e MIXTA -- unele instrumente merg, altele nu. Selectia conteaza mai mult decat tipul de bot.');
  }
  console.log(
    '\nAtentie: asta masoara ULTIMELE ore, nu o tendinta de fond. Displacement pe 48h de 1h e a doua coloana.'
  );
}

main().catch((err) => {
  console.error('Eroare:', err?.message || err);
  process.exit(1);
});
