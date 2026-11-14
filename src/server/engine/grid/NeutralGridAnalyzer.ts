import { GridCandidateAnalysis, Kline } from '../../../shared/types';
import { IExecutionAdapter } from '../../exchange/IExecutionAdapter';
import { GridOptimizer } from './GridOptimizer';
import { efficiencyRatioFromKlines, GRID_ER_EXIT_BARS } from './gridRegime';

export class NeutralGridAnalyzer {
  /**
   * Computes true Wilder ADX(14) (+DI, -DI, DX, smoothed ADX) on 15m candles
   * instead of a 24h net-displacement proxy that artificially compressed ADX to 5..12.
   */
  public static computeWilderAdx14(klines: Kline[], period: number = 14): number {
    if (!klines || klines.length < period + 2) return 20;

    const trList: number[] = [];
    const plusDmList: number[] = [];
    const minusDmList: number[] = [];

    for (let i = 1; i < klines.length; i++) {
      const cur = klines[i];
      const prev = klines[i - 1];
      const upMove = cur.high - prev.high;
      const downMove = prev.low - cur.low;

      const plusDm = upMove > downMove && upMove > 0 ? upMove : 0;
      const minusDm = downMove > upMove && downMove > 0 ? downMove : 0;
      const tr = Math.max(
        cur.high - cur.low,
        Math.abs(cur.high - prev.close),
        Math.abs(cur.low - prev.close)
      );

      trList.push(tr);
      plusDmList.push(plusDm);
      minusDmList.push(minusDm);
    }

    if (trList.length < period) return 20;

    let smoothTr = 0;
    let smoothPlusDm = 0;
    let smoothMinusDm = 0;

    for (let i = 0; i < period; i++) {
      smoothTr += trList[i];
      smoothPlusDm += plusDmList[i];
      smoothMinusDm += minusDmList[i];
    }

    const dxValues: number[] = [];
    const pushDx = (trVal: number, pDm: number, mDm: number) => {
      if (trVal <= 1e-12) {
        dxValues.push(0);
        return;
      }
      const plusDi = (pDm / trVal) * 100;
      const minusDi = (mDm / trVal) * 100;
      const diSum = plusDi + minusDi;
      const dx = diSum > 1e-9 ? (Math.abs(plusDi - minusDi) / diSum) * 100 : 0;
      dxValues.push(dx);
    };

    pushDx(smoothTr, smoothPlusDm, smoothMinusDm);

    for (let i = period; i < trList.length; i++) {
      smoothTr = smoothTr - smoothTr / period + trList[i];
      smoothPlusDm = smoothPlusDm - smoothPlusDm / period + plusDmList[i];
      smoothMinusDm = smoothMinusDm - smoothMinusDm / period + minusDmList[i];
      pushDx(smoothTr, smoothPlusDm, smoothMinusDm);
    }

    if (dxValues.length === 0) return 20;
    if (dxValues.length < period) {
      const avgDx = dxValues.reduce((a, b) => a + b, 0) / dxValues.length;
      return Math.min(95, Math.max(5, parseFloat(avgDx.toFixed(1))));
    }

    let adx = 0;
    for (let i = 0; i < period; i++) {
      adx += dxValues[i];
    }
    adx /= period;

    for (let i = period; i < dxValues.length; i++) {
      adx = (adx * (period - 1) + dxValues[i]) / period;
    }

    return Math.min(95, Math.max(5, parseFloat(adx.toFixed(1))));
  }

  /**
   * Analyzes a symbol's live 15m klines, volatility, range boundness (Choppiness Index + Wilder ADX(14)),
   * liquidity, spread, and funding to determine how suitable it is for a Neutral Futures Grid.
   */
  public static async analyzeSymbol(
    symbol: string,
    adapter: IExecutionAdapter,
    tickerMeta?: {
      lastPrice?: number;
      volume24hUSDT?: number;
      high24h?: number;
      low24h?: number;
      spreadPct?: number;
      fundingRatePct?: number;
    }
  ): Promise<GridCandidateAnalysis | null> {
    try {
      const klines = await adapter.getKlines(symbol, '15', 96); // 24 hours of fresh 15m candles
      if (!klines || klines.length < 20) return null;

      const lastClose = tickerMeta?.lastPrice || klines[klines.length - 1].close;
      if (!lastClose || lastClose <= 0) return null;

      const firstOpen24h = klines[0].open || lastClose;
      const priceChange24hPct = ((lastClose - firstOpen24h) / firstOpen24h) * 100;

      const highs = klines.map((k) => k.high);
      const lows = klines.map((k) => k.low);
      const high24h = tickerMeta?.high24h || Math.max(...highs);
      const low24h = tickerMeta?.low24h || Math.min(...lows);
      const range24h = Math.max(1e-9, high24h - low24h);
      const range24hPct = (range24h / lastClose) * 100;

      // 1. ATR(14) & Sum of True Ranges for Choppiness Index
      const period = 14;
      const slice = klines.slice(-period);
      let sumTr = 0;
      let highest14 = -Infinity;
      let lowest14 = Infinity;

      for (let i = 0; i < slice.length; i++) {
        const cur = slice[i];
        const prevClose = i > 0 ? slice[i - 1].close : cur.open;
        const tr = Math.max(
          cur.high - cur.low,
          Math.abs(cur.high - prevClose),
          Math.abs(cur.low - prevClose)
        );
        sumTr += tr;
        if (cur.high > highest14) highest14 = cur.high;
        if (cur.low < lowest14) lowest14 = cur.low;
      }

      const atr14 = sumTr / period;
      const atrPct = (atr14 / lastClose) * 100;

      // 2. Choppiness Index (0..100):
      // 100 * LOG10( SUM(TR, 14) / (MaxHigh14 - MinLow14) ) / LOG10(14)
      // Values > 61.8 indicate strong sideways consolidation (ideal for Neutral Grid!)
      // Values < 38.2 indicate strong directional breakout (dangerous for Neutral Grid)
      const hlRange14 = Math.max(1e-9, highest14 - lowest14);
      const rawChop =
        (100 * Math.log10(Math.max(1.0001, sumTr / hlRange14))) / Math.log10(period);
      const choppinessIndex = Math.max(10, Math.min(95, parseFloat(rawChop.toFixed(1))));

      // 3. True Wilder ADX(14) on 15m candles (0..100)
      const adxTrendStrength = NeutralGridAnalyzer.computeWilderAdx14(klines, 14);

      // 3b. Kaufman efficiency ratio over the exit window (4h): displacement vs oscillation.
      //     ADX and Choppiness both look at range expansion; ER looks at DIRECTION, which is what
      //     decides whether a neutral grid's short side gets run over. Feeds the breakout
      //     confirmation in the analyzer (`assessRangeBreakout`).
      const efficiencyRatio = efficiencyRatioFromKlines(klines, GRID_ER_EXIT_BARS);

      // 4. Live Volume, Spread, Funding & Lot Filter
      const lotFilter = await adapter.getInstrumentFilter(symbol);
      const ctVal = lotFilter?.ctVal && lotFilter.ctVal > 0 ? lotFilter.ctVal : 1;
      const volume24hUSDT =
        tickerMeta?.volume24hUSDT && tickerMeta.volume24hUSDT > 0
          ? tickerMeta.volume24hUSDT
          : klines.reduce((s, k) => s + k.volume * ctVal * k.close, 0);
      const spreadPct =
        tickerMeta?.spreadPct !== undefined && tickerMeta.spreadPct > 0
          ? tickerMeta.spreadPct
          : 0.03;
      const fundingRatePct = tickerMeta?.fundingRatePct ?? 0.01;

      // 5. High-Sensitivity Continuous Neutral Grid Suitability Score (0..100)
      // - Choppiness (0..32 pts): continuous slope from 36..72
      const chopScore = Math.min(32, Math.max(0, ((choppinessIndex - 36) / 34) * 32));

      // - Wilder ADX(14) Trend Resistance (0..26 pts): peaks when ADX <= 16, drops sharply above ADX 28
      const rangeBoundScore =
        adxTrendStrength <= 16
          ? 26
          : Math.min(26, Math.max(0, ((44 - adxTrendStrength) / 28) * 26));

      // - Continuous Volatility & 24h Range Centering Score (0..27 pts):
      //   Peaks when 15m ATR is in the 0.35%..1.10% sweet spot AND price is centered inside its 24h channel
      let atrBellScore = 0;
      if (atrPct >= 0.32 && atrPct <= 1.25) {
        const distFromIdealAtr = Math.abs(atrPct - 0.68) / 0.57;
        atrBellScore = 18 - distFromIdealAtr * 5;
      } else if (atrPct > 1.25 && atrPct <= 2.6) {
        atrBellScore = Math.max(5, 13 - (atrPct - 1.25) * 6);
      } else if (atrPct >= 0.14 && atrPct < 0.32) {
        atrBellScore = 4 + ((atrPct - 0.14) / 0.18) * 9;
      } else {
        atrBellScore = 2;
      }

      const posIn24hRange = Math.max(0, Math.min(1, (lastClose - low24h) / range24h));
      const edgeProximity = Math.abs(posIn24hRange - 0.5) * 2; // 0 = center, 1 = extreme 24h high/low
      const centeringBonus = Math.max(0, (1 - Math.pow(edgeProximity, 1.4)) * 9);
      const volScore = atrBellScore + centeringBonus;

      // - Continuous Spread & Liquidity Score (0..15 pts):
      const spreadPts = Math.max(0, Math.min(10, (1 - spreadPct / 0.1) * 10));
      const logVol = Math.log10(Math.max(100_000, volume24hUSDT));
      const liqPts = Math.max(0, Math.min(5, (logVol - 5.0) * 1.5));
      const spreadScore = spreadPts + liqPts;

      const gridSuitabilityScore = Math.round(
        Math.min(99, Math.max(10, chopScore + rangeBoundScore + volScore + spreadScore))
      );

      let regimeLabel: GridCandidateAnalysis['regimeLabel'] = 'IDEAL_RANGE';
      if (adxTrendStrength >= 30 || choppinessIndex < 40) {
        regimeLabel = 'TRENDING_RISK';
      } else if (atrPct > 1.65) {
        regimeLabel = 'HIGH_VOL_RANGE';
      } else if (atrPct < 0.18) {
        regimeLabel = 'LOW_VOLATILITY';
      }

      const autoOpt = GridOptimizer.autoOptimizeParameters(
        symbol,
        lastClose,
        klines,
        100,
        lotFilter?.tickSize || 0.01
      );

      const bandPct = ((autoOpt.upperPrice - autoOpt.lowerPrice) / lastClose) * 100;
      const stepPct = bandPct / Math.max(1, autoOpt.gridCount - 1);
      const estimatedNetProfitPerGridPct = parseFloat(Math.max(0.05, stepPct - 0.04).toFixed(2));
      const estimatedDailyCrossings = Math.max(2, Math.round((atrPct * 18) / Math.max(0.2, stepPct)));
      const estimatedDailyGridYieldPct = parseFloat(
        (estimatedDailyCrossings * estimatedNetProfitPerGridPct * 0.35 * autoOpt.recommendedLeverage).toFixed(2)
      );

      const reasons: string[] = [
        `Choppiness ${choppinessIndex} (${choppinessIndex >= 55 ? 'Consolidare laterală ideală' : 'Lateral moderat'})`,
        `Wilder ADX(14) ${adxTrendStrength} (${adxTrendStrength < 25 ? 'Fără trend direcțional' : 'Atenție la trend'})`,
        `Efficiency Ratio ${efficiencyRatio === null ? 'n/a' : efficiencyRatio} (${efficiencyRatio !== null && efficiencyRatio > 0.4 ? 'deplasare, nu oscilație' : 'oscilație'})`,
        `ATR(15m) ${atrPct.toFixed(2)}% | Range 24h ${range24hPct.toFixed(1)}% (Poz ${(posIn24hRange * 100).toFixed(0)}%)`,
      ];

      return {
        symbol,
        price: lastClose,
        volume24hUSDT: Math.round(volume24hUSDT),
        priceChange24hPct: parseFloat(priceChange24hPct.toFixed(2)),
        high24h,
        low24h,
        range24hPct: parseFloat(range24hPct.toFixed(2)),
        atrPct: parseFloat(atrPct.toFixed(2)),
        choppinessIndex,
        adxTrendStrength,
        efficiencyRatio,
        spreadPct: parseFloat(spreadPct.toFixed(3)),
        fundingRatePct: parseFloat(fundingRatePct.toFixed(4)),
        gridSuitabilityScore,
        regimeLabel,
        recommendedLowerPrice: autoOpt.lowerPrice,
        recommendedUpperPrice: autoOpt.upperPrice,
        recommendedGridCount: autoOpt.gridCount,
        recommendedLeverage: autoOpt.recommendedLeverage,
        estimatedNetProfitPerGridPct,
        estimatedDailyGridYieldPct,
        reasons,
        rank: 0,
        lastScannedTime: Date.now(),
      };
    } catch {
      return null;
    }
  }
}
