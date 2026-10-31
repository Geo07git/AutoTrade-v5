import { GridCandidateAnalysis, Kline } from '../../../shared/types';
import { IExecutionAdapter } from '../../exchange/IExecutionAdapter';
import { GridOptimizer } from './GridOptimizer';

export class NeutralGridAnalyzer {
  /**
   * Analyzes a symbol's klines, volatility, range boundness (Choppiness Index + ADX proxy),
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
      const klines = await adapter.getKlines(symbol, '15', 96); // 24 hours of 15m candles
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

      // 3. Directional Efficiency / ADX Trend Proxy (0..100)
      // Net displacement vs total path traveled over 24h
      let totalPath = 0;
      for (let i = 1; i < klines.length; i++) {
        totalPath += Math.abs(klines[i].close - klines[i - 1].close);
      }
      const netDisplacement = Math.abs(lastClose - firstOpen24h);
      const efficiencyRatio = totalPath > 0 ? netDisplacement / totalPath : 0;
      const adxTrendStrength = Math.min(95, Math.max(5, parseFloat((efficiencyRatio * 100).toFixed(1))));

      // 4. Volume, Spread, Funding
      const volume24hUSDT =
        tickerMeta?.volume24hUSDT ||
        klines.reduce((s, k) => s + k.volume * k.close, 0);
      const spreadPct = tickerMeta?.spreadPct ?? 0.03;
      const fundingRatePct = tickerMeta?.fundingRatePct ?? 0.01;

      // 5. Compute Neutral Grid Suitability Score (0..100)
      // - High Choppiness (50..80) -> up to 35 pts
      // - Low Directional Trend (ADX < 30) -> up to 25 pts
      // - Healthy oscillation ATR% (0.35% .. 1.8% per 15m) -> up to 25 pts
      // - Liquidity & Tight Spread -> up to 15 pts
      const chopScore = Math.min(35, Math.max(0, ((choppinessIndex - 35) / 40) * 35));
      const rangeBoundScore = Math.min(25, Math.max(0, ((55 - adxTrendStrength) / 45) * 25));

      let volScore = 0;
      if (atrPct >= 0.25 && atrPct <= 1.8) {
        volScore = 25;
      } else if (atrPct > 1.8 && atrPct <= 3.2) {
        volScore = 16;
      } else if (atrPct >= 0.12) {
        volScore = 12;
      } else {
        volScore = 5;
      }

      const spreadScore = spreadPct <= 0.04 ? 15 : spreadPct <= 0.08 ? 10 : 4;
      const gridSuitabilityScore = Math.round(
        Math.min(99, Math.max(10, chopScore + rangeBoundScore + volScore + spreadScore))
      );

      let regimeLabel: GridCandidateAnalysis['regimeLabel'] = 'IDEAL_RANGE';
      if (adxTrendStrength >= 42 || choppinessIndex < 42) {
        regimeLabel = 'TRENDING_RISK';
      } else if (atrPct > 1.8) {
        regimeLabel = 'HIGH_VOL_RANGE';
      } else if (atrPct < 0.18) {
        regimeLabel = 'LOW_VOLATILITY';
      }

      const lotFilter = await adapter.getInstrumentFilter(symbol);
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
        `Putere Trend ADX ${adxTrendStrength} (${adxTrendStrength < 30 ? 'Risc scăzut de breakout' : 'Atenție la trend'})`,
        `ATR(15m) ${atrPct.toFixed(2)}% | Range 24h ${range24hPct.toFixed(1)}%`,
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
