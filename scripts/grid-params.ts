/**
 * Parametrii unui grid pentru un simbol dat -- READ-ONLY, fara OKX privat.
 *
 * Nu inventeaza nimic: banda, numarul de niveluri, treapta, levierul si SL-ul vin din
 * `deriveGridGeometry` + `buildSymmetricBand` + `maxLeverageForBand` + `gridStopLossPct`
 * (singura implementare de geometrie din repo), iar scara concreta de ordine din
 * `GridOptimizer.calculateGrid`, cu loturile reale ale contractului.
 *
 * Include garda pe extremele 24h (`inspectBandLegality`): o banda lipita de maximul sau minimul
 * zilei e refuzata. Exact regula care lipsea cand s-a deschis SOXL.
 *
 * Run: npm run grid-params DOGE-USD_UM_XPERP-310404 39.41 12
 *      (simbol, USDC disponibil, marja per bot)
 */

import {
  deriveGridGeometry,
  maxLeverageForBand,
  gridStopLossPct,
  GRID_PLAN_MAX_LEVERAGE,
} from '../src/server/engine/grid/gridPlan';
import { buildConstructedBand, inspectBandLegality } from '../src/server/agent/gridBand';
import { GridOptimizer } from '../src/server/engine/grid/GridOptimizer';
import { createDefaultBotConfig } from '../src/server/research/GridBacktestEngine';
import type { Kline } from '../src/shared/types';

const BASE = 'https://eea.okx.com';
const HARD_STOP_LOSS_PCT = 12; // plafonul dur al aplicatiei, in % din marja
const MAKER_FEE_PCT = 0.02;
const TAKER_FEE_PCT = 0.05;
const TARGET_HOLDING_HOURS = 8;

const args = process.argv.slice(2);
const SYMBOL = args[0] || 'DOGE-USD_UM_XPERP-310404';
const AVAILABLE_USDC = Number(args[1]) || 39.41;
const BUDGET = Number(args[2]) || 12;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function okx(path: string): Promise<any> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${path}`);
  const body: any = await res.json();
  if (String(body?.code) !== '0') throw new Error(`OKX ${body?.code}: ${body?.msg}`);
  return body?.data;
}

function toKlines(rows: any[]): Kline[] {
  return rows
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

/** ATR Wilder, in % din ultimul close. */
function wilderAtrPct(bars: Kline[], period = 14): number | null {
  if (bars.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1].close;
    trs.push(Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - prev), Math.abs(bars[i].low - prev)));
  }
  let atr = trs.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < trs.length; i++) atr = (atr * (period - 1) + trs[i]) / period;
  const last = bars[bars.length - 1].close;
  return last > 0 ? (atr / last) * 100 : null;
}

const f = (n: number, d = 4) => (Number.isFinite(n) ? n.toFixed(d) : 'n/a');

async function main() {
  console.log(`Grid params -- ${SYMBOL}`);
  console.log(`Disponibil ${f(AVAILABLE_USDC, 2)} USDC | marja per bot ${f(BUDGET, 2)} USDC\n`);

  const [inst, ticker, c15, c1h, funding] = await Promise.all([
    okx(`/api/v5/public/instruments?instType=FUTURES&instId=${encodeURIComponent(SYMBOL)}`),
    okx(`/api/v5/market/ticker?instId=${encodeURIComponent(SYMBOL)}`),
    okx(`/api/v5/market/candles?instId=${encodeURIComponent(SYMBOL)}&bar=15m&limit=100`),
    okx(`/api/v5/market/candles?instId=${encodeURIComponent(SYMBOL)}&bar=1H&limit=100`),
    okx(`/api/v5/public/funding-rate?instId=${encodeURIComponent(SYMBOL)}`).catch(() => []),
  ]);
  await sleep(0);

  const ins = inst[0];
  const tk = ticker[0];
  const price = Number(tk.last);
  const bid = Number(tk.bidPx) || price;
  const ask = Number(tk.askPx) || price;
  const high24h = Number(tk.high24h);
  const low24h = Number(tk.low24h);
  const ctVal = Number(ins.ctVal) || 1;
  const tickSz = Number(ins.tickSz) || 0.0001;
  const lotSz = Number(ins.lotSz) || 1;
  const minSz = Number(ins.minSz) || 1;
  const instLever = Number(ins.lever) || 10;
  const instCategory = String(ins.instCategory ?? '');

  const bars15 = toKlines(c15);
  const bars1h = toKlines(c1h);
  const atrPct = wilderAtrPct(bars15);
  const atrPct1h = wilderAtrPct(bars1h);
  const spreadPct = ask > 0 && bid > 0 ? ((ask - bid) / ((ask + bid) / 2)) * 100 : 0;
  const fundingRatePct = Number(funding?.[0]?.fundingRate ?? 0) * 100;

  console.log(`Instrument   ${ins.instId}`);
  console.log(`Categorie    ${instCategory}${instCategory === '3' ? '  <-- STOCK TOKEN: refuzat de regulile aplicatiei' : ''}`);
  console.log(`Pret         ${f(price, 6)}   (bid ${f(bid, 6)} / ask ${f(ask, 6)} = spread ${f(spreadPct, 4)}%)`);
  console.log(`24h          low ${f(low24h, 6)} / high ${f(high24h, 6)}`);
  console.log(`Contract     ctVal ${ctVal} | tick ${tickSz} | lot ${lotSz} | minSz ${minSz} | levier max ${instLever}x`);
  console.log(`ATR(15m)     ${f(atrPct, 3)}%   ATR(1h) ${f(atrPct1h, 3)}%   funding ${f(fundingRatePct, 4)}%`);

  if (instCategory === '3') {
    console.log('\nSTOP: stock token (categoria 3). Nu se calculeaza geometrie -- regulile din cod il refuza.');
    return;
  }

  const geom = deriveGridGeometry({
    atrPct: atrPct || 0,
    atrPct1h: atrPct1h || undefined,
    targetHoldingHours: TARGET_HOLDING_HOURS,
    roundTripFeePct: MAKER_FEE_PCT * 2,
    spreadPct,
    fundingRatePct,
  });
  if (!geom) {
    console.log('\nSTOP: ATR indisponibil, geometria nu poate fi derivata.');
    return;
  }

  const band = buildConstructedBand({
    price,
    low24h,
    high24h,
    widthPct: geom.halfRangePct * 2,
    gridNum: geom.gridNum,
    tickSz,
    klines15m: bars15.slice(-96).map((k) => ({ high: k.high, low: k.low, close: k.close })),
  });
  if (!band.ok) {
    console.log(`\nSTOP: banda refuzata -- ${(band as any).reason}`);
    return;
  }

  const illegal = inspectBandLegality({ price, minPx: band.minPx, maxPx: band.maxPx, low24h, high24h });

  console.log('\n-- GEOMETRIE (din deriveGridGeometry) --------------------------------------');
  console.log(`Banda            +-${f(geom.halfRangePct, 2)}%  (${f(geom.halfRangePct * 2, 2)}% latime)`);
  console.log(`Constructie      ${band.method}  (jos ${f(band.lowerSidePct, 2)}% / sus ${f(band.upperSidePct, 2)}%)`);
  console.log(`Orizont tintit   ${geom.targetHoldingHours}h -> viata medie estimata ${f(geom.expectedLifetimeHours, 1)}h`);
  console.log(`Niveluri         ${geom.gridNum}`);
  console.log(`Treapta          ${f(geom.stepPct, 3)}% din pret (minim fee ${f(geom.feeFloorPct, 3)}%)`);
  console.log(`Net per grila    ${f(geom.netPerGridPct, 3)}% din pret (dupa fee, funding, jumatate de spread)`);
  console.log(`Spread/treapta   ${f(geom.spreadPctOfStep * 100, 1)}% (limita 25%)`);

  const leverCap = Math.min(GRID_PLAN_MAX_LEVERAGE, instLever);
  const leverMax = maxLeverageForBand(geom.halfRangePct, HARD_STOP_LOSS_PCT, leverCap);
  const slAtMax = gridStopLossPct(geom.halfRangePct, leverMax, 0, HARD_STOP_LOSS_PCT);
  const leverSafe = Math.max(1, Math.min(leverMax, Math.floor(HARD_STOP_LOSS_PCT / (geom.halfRangePct * 1.5))));
  const slSafe = gridStopLossPct(geom.halfRangePct, leverSafe, 0, HARD_STOP_LOSS_PCT);

  const scenarios: Array<{ label: string; lever: number; sl: number }> = [
    { label: 'levier maxim, SL la plafonul dur (buffer maxim)', lever: leverMax, sl: HARD_STOP_LOSS_PCT },
    { label: 'levier maxim, SL minim geometric (fara buffer)', lever: leverMax, sl: slAtMax },
    { label: 'levier cu buffer sub SL', lever: leverSafe, sl: slSafe },
  ];
  const seen = new Set<string>();

  for (const sc of scenarios) {
    const key = `${sc.lever}-${sc.sl}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const cfg = createDefaultBotConfig(
      SYMBOL,
      band.minPx,
      band.maxPx,
      geom.gridNum,
      'ARITHMETIC',
      sc.lever,
      BUDGET,
      sc.sl,
      15
    );
    const lotFilter = {
      symbol: SYMBOL,
      minOrderQty: minSz,
      maxOrderQty: 1_000_000,
      qtyStep: lotSz,
      minNotionalValue: 1,
      tickSize: tickSz,
      ctVal,
    };
    const calc = GridOptimizer.calculateGrid(cfg, price, lotFilter);
    const notional = BUDGET * sc.lever;
    const perLevel = notional / geom.gridNum;
    const qtyPerLevel = perLevel / (price * ctVal);
    const exposure = calc.levels.reduce((s, l) => s + l.qtyContracts * ctVal * l.price, 0);
    const walkCost = sc.lever * geom.halfRangePct;

    console.log(`\n-- ${sc.label.toUpperCase()}: levier ${sc.lever}x ----------------------------------`);
    console.log(`Price range      ${f(band.minPx, 6)}  -  ${f(band.maxPx, 6)}   (${f(band.maxPx - band.minPx, 6)} USD latime)`);
    console.log(`Grid quantity    ${geom.gridNum}   treapta ${f(calc.gridSpacingUSDT, 6)} USD / ${f(calc.gridSpacingPct, 3)}%`);
    console.log(`Invested margin  ${f(BUDGET, 2)} USDC   notional ${f(notional, 2)} USDC`);
    console.log(`~ per nivel      ${f(perLevel, 2)} USDC  =  ${f(qtyPerLevel, 2)} contracte (pas ${lotSz})`);
    console.log(`Expunere totala  ${f(exposure, 2)} USDC  ${exposure > notional * 1.05 ? '<-- DEPASESTE bugetul' : '(in buget)'}`);
    console.log(`Profit/o grila    ${f(calc.estimatedProfitPerGridPct, 3)}% din pret  ->  ~${f(perLevel * (geom.netPerGridPct / 100), 4)} USDC per nivel`);
    console.log(`O plimbare intreaga (${geom.gridNum} niveluri)  ~${f(perLevel * (geom.netPerGridPct / 100) * geom.gridNum, 3)} USDC brut`);
    console.log(`SL               -${f(sc.sl, 2)}% din marja  (= ${f(sc.sl, 2)} USD)`);
    console.log(`   o plimbare completa la marginea benzii costa ${f(walkCost, 2)}% din marja`);
    console.log(`   buffer dincolo de margine: ${f(sc.sl - walkCost, 2)} puncte procentuale`);
    console.log(`TP               +15% din marja (= +${f(BUDGET * 0.15, 2)} USD)`);
    console.log(`Liq estimat      long ${f(calc.estimatedLiquidationPriceLong, 6)} | short ${f(calc.estimatedLiquidationPriceShort, 6)}`);
    console.log(`Stop pe pret     lower ${f(calc.lowerStopPrice, 6)} | upper ${f(calc.upperStopPrice, 6)}`);
    if (calc.warnings.length) console.log(`Avertismente     ${calc.warnings.join(' | ')}`);

    const marginNeeded = BUDGET;
    console.log(
      `Incap in cont?   ${marginNeeded <= AVAILABLE_USDC ? 'da' : 'NU'} ` +
        `(${f(marginNeeded, 2)} din ${f(AVAILABLE_USDC, 2)} USDC)`
    );
  }

  console.log('\n-- GARZI ------------------------------------------------------------------');
  console.log(`Banda legala?    ${illegal ? `NU -- ${illegal}` : 'da (nu atinge extremele 24h la 1%)'}`);
  for (const note of band.notes) console.log(`  nota: ${note}`);
  console.log(
    `Raport SL/banda  ${f((slAtMax / (geom.halfRangePct * leverMax)) * 1, 2)}x  ` +
      `(SL trebuie sa fie >= 1x plimbarea la margine; sub asta se opreste pe zgomot)`
  );
  console.log(
    `\nRegula din cod: SL% din marja >= levier x jumatate de banda -- ${f(leverMax, 0)} x ${f(geom.halfRangePct, 2)}% = ${f(leverMax * geom.halfRangePct, 2)}%.`
  );
}

main().catch((err) => {
  console.error('Eroare:', err?.message || err);
  process.exit(1);
});
