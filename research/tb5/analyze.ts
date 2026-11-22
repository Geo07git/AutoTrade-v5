/**
 * TB5 `_UM_XPERP` analysis.
 *
 * Reads the JSON produced by `collect.ts` and emits `report.json` + `report.md`.
 * Pure computation over collected data — no network, no credentials.
 *
 * Sections:
 *   1 profile  2 volatility/regime  3 price behaviour  4 microstructure (live snapshot)
 *   5 funding  6 cost model         7 grid viability   8 verdict
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(HERE, 'data');

interface Candle {
  ts: number; open: number; high: number; low: number; close: number;
  vol: number; volCcy: number; volUsd: number; confirm: boolean;
}
interface Funding { ts: number; fundingRate: number; realizedRate: number }
interface OiPoint { ts: number; oi: number; vol: number }

const INSTRUMENTS = [
  { short: 'ZEC', instId: 'ZEC-USD_UM_XPERP-310530' },
  { short: 'ENA', instId: 'ENA-USD_UM_XPERP-310613' },
  { short: 'IRYS', instId: 'IRYS-USD_UM_XPERP-310530' },
  { short: 'PIEVERSE', instId: 'PIEVERSE-USD_UM_XPERP-310822' },
  { short: 'CASHCAT', instId: 'CASHCAT-USD_UM_XPERP-310926' },
];

/** Live account fee tier (Lv1): maker 0.02% / taker 0.05%. */
const FEE = { makerPct: 0.02, takerPct: 0.05 };

const load = <T>(file: string): T | null => {
  const p = path.join(DATA, file);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
};

const mean = (xs: number[]): number => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const std = (xs: number[]): number => {
  if (xs.length < 2) return 0;
  const mu = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - mu) ** 2, 0) / (xs.length - 1));
};
const pct = (xs: number[], p: number): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * s.length)))];
};
const r2 = (x: number, d = 2): number => {
  const f = 10 ** d;
  return Number.isFinite(x) ? Math.round(x * f) / f : 0;
};

const trPct = (c: Candle, prev?: Candle): number => {
  if (prev) {
    const a = c.high - c.low;
    const b = Math.abs(c.high - prev.close);
    const d = Math.abs(c.low - prev.close);
    return (Math.max(a, b, d) / c.close) * 100;
  }
  return ((c.high - c.low) / c.close) * 100;
};

const atrPct = (candles: Candle[], period = 14): number => {
  if (candles.length < period + 1) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) trs.push(trPct(candles[i], candles[i - 1]));
  let atr = mean(trs.slice(0, period));
  for (let i = period; i < trs.length; i++) atr = (atr * (period - 1) + trs[i]) / period;
  return atr;
};

const efficiencyRatio = (closes: number[], window = 20): number => {
  if (closes.length < window + 1) return 0;
  const seg = closes.slice(-window - 1);
  const net = Math.abs(seg[seg.length - 1] - seg[0]);
  let p = 0;
  for (let i = 1; i < seg.length; i++) p += Math.abs(seg[i] - seg[i - 1]);
  return p > 0 ? net / p : 0;
};

const autocorr1 = (rets: number[]): number => {
  if (rets.length < 10) return 0;
  const mu = mean(rets);
  const num = rets.slice(1).reduce((s, r, i) => s + (r - mu) * (rets[i] - mu), 0);
  const den = rets.reduce((s, r) => s + (r - mu) ** 2, 0);
  return den > 0 ? num / den : 0;
};

const crossingsPerHour = (candles: Candle[], ref: number, barMs: number): number => {
  let crossings = 0;
  let prevSide = 0;
  for (const c of candles) {
    const side = c.close > ref ? 1 : c.close < ref ? -1 : 0;
    if (side !== 0 && prevSide !== 0 && side !== prevSide) crossings++;
    if (side !== 0) prevSide = side;
  }
  const hours = (candles.length * barMs) / 3_600_000;
  return hours > 0 ? crossings / hours : 0;
};

/** Counts grid-level hits per hour: how many distinct levels a bar visits. */
const gridCrossingsPerHour = (candles: Candle[], low: number, high: number, gridNum: number, barMs: number): number => {
  if (high <= low || gridNum < 2) return 0;
  const step = (high - low) / gridNum;
  const levels: number[] = [];
  for (let i = 0; i <= gridNum; i++) levels.push(low + i * step);
  let hits = 0;
  let lastIdx: number | null = null;
  for (const c of candles) {
    let idx: number | null = null;
    for (let i = 0; i < levels.length; i++) {
      if (c.low <= levels[i] && c.high >= levels[i]) { idx = i; break; }
    }
    if (idx != null && lastIdx != null && idx !== lastIdx) hits += Math.abs(idx - lastIdx);
    if (idx != null) lastIdx = idx;
  }
  const hours = (candles.length * barMs) / 3_600_000;
  return hours > 0 ? hits / hours : 0;
};

/**
 * Grid profitability, done honestly.
 *
 * `fillsPerDay` counts level touches. A neutral grid harvests ONE step per ROUND TRIP,
 * i.e. two fills (buy at level n, sell at level n+1). Therefore:
 *
 *   grossPerDayPct = (fillsPerDay / 2) * stepPct
 *   netPerDayPct   = grossPerDayPct - fillsPerDay * costPerFillPct
 *
 * A passive fill costs `maker + spread/2`. Fees are charged PER FILL, so they scale with
 * `fillsPerDay`, not with round trips. An earlier draft subtracted one round-trip cost from the
 * step and multiplied the remainder by fills/2 — that double-counted the step and under-counted
 * fees, which is what produced the absurd +11%/day figures.
 */
const costPerFillPct = (spreadPct: number): number => FEE.makerPct + spreadPct / 2;

/** A step smaller than the live spread can never fill; far above ATR(1h) it rarely does. */
const MIN_STEP_MULT = 0.5;
const MAX_STEP_MULT = 4.0;

/**
 * Some contracts are seeded with a flat placeholder funding rate (exactly 0.00005 = 0.5 bps).
 * A run where min === max === seed is a placeholder, not a market signal, and annualising it
 * would be fiction. Such records are excluded and the report says so.
 */
const isPlaceholderFunding = (funding: Funding[]): boolean => {
  if (funding.length < 3) return false;
  const uniq = new Set(funding.map((f) => f.realizedRate.toFixed(10)));
  return uniq.size === 1 && Math.abs(funding[0].realizedRate - 0.00005) < 1e-9;
};

const analyses: any[] = [];
const metaAll = load<Record<string, any>>('meta.json') || {};

for (const inst of INSTRUMENTS) {
  const metaBlob = metaAll[inst.short] || {};
  const daily = load<Candle[]>(`${inst.short}_${inst.instId}_candles_1Dutc.json`) || [];
  const h1 = load<Candle[]>(`${inst.short}_${inst.instId}_candles_1H.json`) || [];
  const m15 = load<Candle[]>(`${inst.short}_${inst.instId}_candles_15m.json`) || [];
  const m5 = load<Candle[]>(`${inst.short}_${inst.instId}_candles_5m.json`) || [];
  const funding = load<Funding[]>(`${inst.short}_${inst.instId}_funding.json`) || [];

  if (daily.length === 0 && h1.length === 0) {
    console.log(`  ${inst.short}: fara date, sarit`);
    continue;
  }

  const meta = metaBlob.meta || {};
  const ctVal = Number(meta.ctVal) || 1;
  const activeDaily = daily.filter((d) => d.volUsd > 0);
  const dormantDays = daily.length - activeDaily.length;
  const lastPrice = daily.length ? daily[daily.length - 1].close : (metaBlob.ticker?.last || 0);

  // ---- 1 profile
  const usdPerDay = activeDaily.map((d) => d.volUsd);
  const profile = {
    lastPrice: r2(lastPrice, 6),
    priceRange: activeDaily.length
      ? { min: r2(Math.min(...activeDaily.map((d) => d.low)), 6), max: r2(Math.max(...activeDaily.map((d) => d.high)), 6) }
      : null,
    daysOfData: daily.length,
    activeDays: activeDaily.length,
    dormantDays,
    firstBar: daily.length ? new Date(daily[0].ts).toISOString().slice(0, 10) : null,
    lastBar: daily.length ? new Date(daily[daily.length - 1].ts).toISOString().slice(0, 10) : null,
    medianDailyUsdVolume: r2(median(usdPerDay), 0),
    meanDailyUsdVolume: r2(mean(usdPerDay), 0),
    minDailyUsdVolume: r2(Math.min(...(usdPerDay.length ? usdPerDay : [0])), 0),
    maxDailyUsdVolume: r2(Math.max(...(usdPerDay.length ? usdPerDay : [0])), 0),
    contract: {
      ctVal,
      ctValCcy: meta.ctValCcy,
      tickSz: meta.tickSz,
      lotSz: meta.lotSz,
      minSz: meta.minSz,
      minTicketUsd: r2((Number(meta.minSz) || 1) * ctVal * lastPrice, 2),
      leverage: meta.lever,
      settleCcy: meta.settleCcy,
      ruleType: meta.ruleType,
      expTime: meta.expTime ? new Date(meta.expTime).toISOString().slice(0, 10) : null,
    },
  };

  // ---- 2 volatility
  const atr1d = atrPct(daily);
  const atr1h = atrPct(h1);
  const atr15 = atrPct(m15);
  const rets1h = h1.slice(1).map((c, i) => Math.log(c.close / h1[i].close)).filter(Number.isFinite);
  const realizedVol1h = std(rets1h) * 100;
  const dailyRangePct = activeDaily.map((d) => ((d.high - d.low) / d.close) * 100);
  const er1h = efficiencyRatio(h1.map((c) => c.close), 24);
  const upDays = activeDaily.filter((d, i) => i > 0 && d.close > activeDaily[i - 1].close).length;
  const volatility = {
    atrPct1d: r2(atr1d, 3),
    atrPct1h: r2(atr1h, 3),
    atrPct15m: r2(atr15, 3),
    realizedVol1hPct: r2(realizedVol1h, 3),
    medianDailyRangePct: r2(median(dailyRangePct), 3),
    p90DailyRangePct: r2(pct(dailyRangePct, 0.9), 3),
    maxDailyRangePct: r2(Math.max(...(dailyRangePct.length ? dailyRangePct : [0])), 3),
    efficiencyRatio1h: r2(er1h, 4),
    regime: er1h > 0.35 ? 'trending' : er1h < 0.15 ? 'noisy/mean-reverting' : 'mixed',
    upDayShare: activeDaily.length > 1 ? r2((upDays / (activeDaily.length - 1)) * 100, 1) : 0,
    /**
     * ATR uses the whole bar range, so wick spikes inflate it while closes barely move.
     * When ATR(1h) exceeds the close-to-close realized vol by 2x+, the range is wick-driven
     * and any grid sized "to ATR" is really sized to noise — flagged, not silently trusted.
     */
    atrVsRealizedVolRatio: realizedVol1h > 0 ? r2(atr1h / realizedVol1h, 2) : null,
    wickDominated: realizedVol1h > 0 ? atr1h / realizedVol1h > 2 : false,
  };

  // ---- 3 behaviour
  const rets15 = m15.slice(1).map((c, i) => Math.log(c.close / m15[i].close)).filter(Number.isFinite);
  const rets5 = m5.slice(1).map((c, i) => Math.log(c.close / m5[i].close)).filter(Number.isFinite);
  const midRange = profile.priceRange ? (profile.priceRange.min + profile.priceRange.max) / 2 : lastPrice;
  const ac15 = autocorr1(rets15);
  const behaviour = {
    autocorr1h: r2(autocorr1(rets1h), 4),
    autocorr15m: r2(ac15, 4),
    autocorr5m: r2(autocorr1(rets5), 4),
    interpretation:
      ac15 < -0.02 ? 'mean-reverting (favours grid)' : ac15 > 0.02 ? 'momentum (grid risks trend losses)' : 'close to random walk',
    midCrossingsPerHour: r2(crossingsPerHour(h1, midRange, 3_600_000), 2),
  };

  // ---- 4 microstructure (live snapshot only)
  const spread = metaBlob.liveSpread;
  const microstructure = {
    spreadSource: 'LIVE SNAPSHOT at collection — OKX has NO historical book',
    spreadPct: spread ? r2(spread.spreadPct, 4) : null,
    spreadAbs: spread ? spread.spreadAbs : null,
    bidDepthUsd5Lvl: spread ? r2(spread.bidDepthUsd, 0) : null,
    askDepthUsd5Lvl: spread ? r2(spread.askDepthUsd, 0) : null,
    minTicketVsMedianVolumePct:
      profile.medianDailyUsdVolume > 0 ? r2((profile.contract.minTicketUsd / profile.medianDailyUsdVolume) * 100, 4) : null,
  };

  // ---- 5 funding
  const fundingIsPlaceholder = isPlaceholderFunding(funding);
  // Median interval is the honest cadence: one gap in an otherwise 8h/4h series must not
  // silently rescale the annualisation (IRYS showed 3.6h purely from sparse early records).
  const deltas = funding.slice(1).map((f, i) => (f.ts - funding[i].ts) / 3_600_000).filter((h) => h > 0);
  const intervals = deltas.length ? median(deltas) : 8;
  const ratesBps = funding.map((f) => f.realizedRate * 10_000);
  const meanRate = mean(funding.map((f) => f.realizedRate));
  const annualised = meanRate * (24 / intervals) * 365 * 100;
  let signFlips = 0;
  for (let i = 1; i < funding.length; i++) if (Math.sign(funding[i].realizedRate) !== Math.sign(funding[i - 1].realizedRate)) signFlips++;
  const fundObj = {
    records: funding.length,
    usable: !fundingIsPlaceholder && funding.length >= 10,
    usableNote: fundingIsPlaceholder
      ? 'rate is a flat venue placeholder (0.5 bps constant) — NOT real funding; stats suppressed'
      : funding.length < 10
        ? 'too few records'
        : 'real series',
    intervalHours: r2(intervals, 1),
    meanBpsPerInterval: fundingIsPlaceholder ? null : r2(mean(ratesBps), 4),
    medianBpsPerInterval: fundingIsPlaceholder ? null : r2(median(ratesBps), 4),
    p95PositiveBps: fundingIsPlaceholder ? null : r2(pct(ratesBps, 0.95), 4),
    p5NegativeBps: fundingIsPlaceholder ? null : r2(pct(ratesBps, 0.05), 4),
    maxBps: fundingIsPlaceholder ? null : r2(Math.max(...(ratesBps.length ? ratesBps : [0])), 4),
    minBps: fundingIsPlaceholder ? null : r2(Math.min(...(ratesBps.length ? ratesBps : [0])), 4),
    annualisedPct: fundingIsPlaceholder ? null : r2(annualised, 2),
    positiveShare: fundingIsPlaceholder ? null : funding.length ? r2((funding.filter((f) => f.realizedRate > 0).length / funding.length) * 100, 1) : 0,
    signFlips: fundingIsPlaceholder ? null : signFlips,
    carryBias: fundingIsPlaceholder
      ? 'unknown (placeholder series)'
      : meanRate > 0.00005 ? 'longs pay (crowded long)' : meanRate < -0.00005 ? 'shorts pay (crowded short)' : 'neutral',
  };

  // ---- 6 costs
  const spreadPct = spread ? spread.spreadPct : 0;
  const costs = {
    feeSource: 'live account tier Lv1 (maker 0.02% / taker 0.05%)',
    makerPct: FEE.makerPct,
    takerPct: FEE.takerPct,
    roundTripMakerPct: FEE.makerPct * 2,
    roundTripTakerPct: FEE.takerPct * 2,
    roundTripMixedPct: FEE.makerPct + FEE.takerPct,
    liveSpreadPct: r2(spreadPct, 4),
    breakevenMoveMakerPct: r2(FEE.makerPct * 2 + spreadPct / 2, 4),
    breakevenMoveMixedPct: r2(FEE.makerPct + FEE.takerPct + spreadPct / 2, 4),
    slippageAssumption: 'not modelled (no book history) — treat as 0, add manually if depth is thin',
  };

  // ---- 7 grid viability
  const sortedLows = [...activeDaily].sort((a, b) => a.low - b.low);
  const sortedHighs = [...activeDaily].sort((a, b) => b.high - a.high);
  const bandLow = sortedLows.length ? sortedLows[Math.floor(sortedLows.length * 0.1)].low : lastPrice * 0.8;
  const bandHigh = sortedHighs.length ? sortedHighs[Math.floor(sortedHighs.length * 0.1)].high : lastPrice * 1.2;

  const perFill = costPerFillPct(spreadPct);
  const gridRows = [10, 20, 30, 50].map((gridNum) => {
    const step = (bandHigh - bandLow) / gridNum;
    const stepPct = (step / lastPrice) * 100;
    /**
     * Fill estimate is measured on 5m bars, not 1H.
     *
     * A 1H bar swallows several grid traversals inside its range, so counting `idx` changes
     * per 1H bar UNDERSTATES touches; conversely treating a touch as a fill OVERSTATES them
     * (price may wick through a level without a resting order being hit on the way back).
     * 5m is the closest granularity we have to the real fill path: ZEC gives 14.5 fills/day
     * on 5m versus 11.8 on 1H for the same band, and 5m is the honest (higher) number.
     */
    const fillsPerDay = gridCrossingsPerHour(m5, bandLow, bandHigh, gridNum, 300_000) * 24;
    const stepVsAtr = atr1h > 0 ? stepPct / atr1h : 0;

    // A completed round trip captures ONE step and costs TWO fills.
    const grossPerDayPct = (fillsPerDay / 2) * stepPct;
    const feesPerDayPct = fillsPerDay * perFill;
    const netPerDayPct = grossPerDayPct - feesPerDayPct;
    const netPerRoundTripPct = stepPct - perFill * 2;

    // Reachability: a step below the live spread never executes; far above ATR almost never fills.
    const reachable = stepPct > spreadPct && stepVsAtr >= MIN_STEP_MULT && stepVsAtr <= MAX_STEP_MULT;

    return {
      gridNum,
      stepPct: r2(stepPct, 3),
      stepVsAtr1h: r2(stepVsAtr, 2),
      fillsPerDayEstimate: r2(fillsPerDay, 1),
      netPerRoundTripPct: r2(netPerRoundTripPct, 3),
      grossPerDayPct: r2(grossPerDayPct, 2),
      feesPerDayPct: r2(feesPerDayPct, 2),
      netPerDayPct: r2(netPerDayPct, 2),
      reachable,
      viable: netPerRoundTripPct > 0 && reachable && fillsPerDay >= 1,
    };
  });

  const worstDropPct = activeDaily.length
    ? Math.max(...activeDaily.map((d, i) => (i === 0 ? 0 : ((activeDaily[i - 1].close - d.low) / activeDaily[i - 1].close) * 100)))
    : 0;

  const viableRows = gridRows.filter((g) => g.viable);
  const recommendedRow = viableRows.length
    ? viableRows.reduce((best, g) => (Math.abs((g.stepVsAtr1h || 0) - 1) < Math.abs((best.stepVsAtr1h || 0) - 1) ? g : best))
    : null;
  const recommended = recommendedRow ? recommendedRow.gridNum : null;

  const gridViability = {
    bandLow: r2(bandLow, 6),
    bandHigh: r2(bandHigh, 6),
    bandWidthPct: r2(((bandHigh - bandLow) / lastPrice) * 100, 2),
    atr1hPct: r2(atr1h, 3),
    worstSingleDayAdverseExcursionPct: r2(worstDropPct, 2),
    recommendedGridNum: recommended,
    recommendedStepPct: recommendedRow ? recommendedRow.stepPct : null,
    recommendedFillsPerDay: recommendedRow ? recommendedRow.fillsPerDayEstimate : null,
    recommendedNetPerDayPct: recommendedRow ? recommendedRow.netPerDayPct : null,
    costPerFillPct: r2(perFill, 4),
    gridRows,
  };

  // ---- 8 verdict
  const liquidityOk = profile.medianDailyUsdVolume >= 50_000;
  const spreadOk = spread ? spread.spreadPct <= 0.5 : false;
  const volatilityOk = atr1h >= 0.5 && atr1h <= 15;
  const gridViable = viableRows.length > 0;
  const reasons: string[] = [];
  if (!liquidityOk) reasons.push(`lichiditate sub $50k/zi (${profile.medianDailyUsdVolume})`);
  if (!spreadOk) reasons.push(`spread ${spread ? spread.spreadPct.toFixed(3) + '%' : 'necunoscut'} > 0.5%`);
  if (!volatilityOk) reasons.push(`ATR(1h) ${r2(atr1h, 2)}% in afara [0.5%, 15%]`);
  if (!gridViable) reasons.push('nicio configuratie de grid net-pozitiva si accesibila cu >=1 fill/zi');

  const verdict = {
    tradeableOnGrid: liquidityOk && spreadOk && volatilityOk && gridViable,
    checks: { liquidityOk, spreadOk, volatilityOk, gridViable },
    reasons,
    caveats: [
      profile.dormantDays > 0 ? `${profile.dormantDays} zile dormante (excluse din statistici)` : null,
      'spread/depth = snapshot live, nu serie istorica',
      `istoric limitat la ${profile.activeDays} zile active`,
    ].filter(Boolean),
  };

  analyses.push({
    short: inst.short,
    instId: inst.instId,
    meta,
    ticker: metaBlob.ticker || null,
    oiSnapshot: metaBlob.oiSnapshot || null,
    liveSpread: spread || null,
    bars: {
      '5m': m5.length, '15m': m15.length, '1H': h1.length, '1Dutc': daily.length,
    },
    profile, volatility, behaviour, microstructure,
    funding: fundObj, costs, gridViability, verdict,
  });

  console.log(`  ${inst.short}: ${daily.length}z ATR1h=${r2(atr1h, 2)}% ER=${r2(er1h, 3)} grid=${verdict.tradeableOnGrid ? 'DA' : 'NU'}`);
}

fs.writeFileSync(
  path.join(HERE, 'report.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), venue: 'eea.okx.com', instruments: analyses }, null, 2),
  'utf8'
);
console.log(`\nreport.json scris (${analyses.length} instrumente)`);
