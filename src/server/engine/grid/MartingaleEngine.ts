import { MartingaleConfig } from '../../../shared/types';

export class MartingaleEngine {
  /**
   * Computes normalized weight multipliers for each grid level.
   * For a Neutral Grid:
   * - If Martingale is disabled (strict risk management), all levels have weight = 1.0.
   * - If Martingale is enabled, levels further away from the center price receive
   *   higher weights (up to maxMultiplierSteps) to improve average entry price on deeper excursions.
   */
  public static computeLevelWeights(
    gridCount: number,
    centerPrice: number,
    prices: number[],
    config: MartingaleConfig
  ): number[] {
    if (!config.enabled || config.sizeMultiplier <= 1.0 || prices.length === 0) {
      return prices.map(() => 1.0);
    }

    const mult = Math.min(2.0, Math.max(1.0, config.sizeMultiplier));
    const maxSteps = Math.max(1, config.maxMultiplierSteps || 5);

    // Find index closest to centerPrice
    let centerIdx = 0;
    let minDiff = Infinity;
    for (let i = 0; i < prices.length; i++) {
      const d = Math.abs(prices[i] - centerPrice);
      if (d < minDiff) {
        minDiff = d;
        centerIdx = i;
      }
    }

    const rawWeights: number[] = [];
    for (let i = 0; i < prices.length; i++) {
      const distSteps = Math.abs(i - centerIdx);
      const effectiveStep = Math.min(maxSteps, Math.max(0, distSteps - 1));
      const weight = Math.pow(mult, effectiveStep);
      rawWeights.push(parseFloat(weight.toFixed(4)));
    }

    return rawWeights;
  }

  /**
   * Enforces maximum notional exposure ceiling across all grid levels.
   */
  public static clampNotionalToCeiling(
    plannedTotalNotionalUSDT: number,
    config: MartingaleConfig
  ): number {
    if (config.maxExposureUSDT && config.maxExposureUSDT > 0) {
      return Math.min(plannedTotalNotionalUSDT, config.maxExposureUSDT);
    }
    return plannedTotalNotionalUSDT;
  }
}
