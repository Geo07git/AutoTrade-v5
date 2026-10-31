// Dynamic & Live OKX Fee Rate Calculation Utility
// Updates in real-time when OKXAdapter fetches /api/v5/account/trade-fee?instType=FUTURES

export const DEFAULT_MAKER_FEE_RATE = 0.0002; // 0.02% OKX Lv1 Futures/Swap Maker
export const DEFAULT_TAKER_FEE_RATE = 0.0005; // 0.05% OKX Lv1 Futures/Swap Taker

let currentMakerFeeRate = DEFAULT_MAKER_FEE_RATE;
let currentTakerFeeRate = DEFAULT_TAKER_FEE_RATE;
let currentFeeLevel = 'Lv1';
let currentFeeSource: 'OKX_API_LIVE' | 'OKX_FILLS_DERIVED' | 'DEFAULT_TIER' = 'DEFAULT_TIER';
let lastFeeTierUpdatedAt = 0;

export const MAKER_FEE_RATE = DEFAULT_MAKER_FEE_RATE;
export const TAKER_FEE_RATE = DEFAULT_TAKER_FEE_RATE;

export function setLiveFeeRates(
  makerRate: number,
  takerRate: number,
  level: string = 'Lv1',
  source: 'OKX_API_LIVE' | 'OKX_FILLS_DERIVED' | 'DEFAULT_TIER' = 'OKX_API_LIVE'
): void {
  if (Number.isFinite(makerRate) && makerRate >= 0 && makerRate < 0.05) {
    currentMakerFeeRate = makerRate;
  }
  if (Number.isFinite(takerRate) && takerRate >= 0 && takerRate < 0.05) {
    currentTakerFeeRate = takerRate;
  }
  if (level) {
    currentFeeLevel = level;
  }
  currentFeeSource = source;
  lastFeeTierUpdatedAt = Date.now();
}

export function getLiveFeeRates(): {
  makerFeeRate: number;
  takerFeeRate: number;
  makerFeePct: number;
  takerFeePct: number;
  roundTripMakerFeePct: number;
  level: string;
  source: 'OKX_API_LIVE' | 'OKX_FILLS_DERIVED' | 'DEFAULT_TIER';
  updatedAt: number;
} {
  return {
    makerFeeRate: currentMakerFeeRate,
    takerFeeRate: currentTakerFeeRate,
    makerFeePct: parseFloat((currentMakerFeeRate * 100).toFixed(4)),
    takerFeePct: parseFloat((currentTakerFeeRate * 100).toFixed(4)),
    roundTripMakerFeePct: parseFloat((currentMakerFeeRate * 2 * 100).toFixed(4)),
    level: currentFeeLevel,
    source: currentFeeSource,
    updatedAt: lastFeeTierUpdatedAt,
  };
}

export function calculateExecutionFee(
  notional: number,
  type: 'maker' | 'taker',
  customMakerRate?: number,
  customTakerRate?: number
): number {
  if (!Number.isFinite(notional) || notional <= 0) return 0;
  const maker = customMakerRate !== undefined ? customMakerRate : currentMakerFeeRate;
  const taker = customTakerRate !== undefined ? customTakerRate : currentTakerFeeRate;
  const feeRate = type === 'taker' ? taker : maker;
  return parseFloat((notional * feeRate).toFixed(4));
}

export function calculateVolumeFeeBreakdown(params: {
  makerVolumeUSDT: number;
  takerVolumeUSDT: number;
  makerFeeRate?: number;
  takerFeeRate?: number;
}): {
  totalVolumeUSDT: number;
  makerFeeUSDT: number;
  takerFeeUSDT: number;
  totalCalculatedFeeUSDT: number;
  effectiveBlendedRatePct: number;
} {
  const makerVol = Math.max(0, Number(params.makerVolumeUSDT) || 0);
  const takerVol = Math.max(0, Number(params.takerVolumeUSDT) || 0);
  const totalVol = makerVol + takerVol;
  const mRate = params.makerFeeRate !== undefined ? params.makerFeeRate : currentMakerFeeRate;
  const tRate = params.takerFeeRate !== undefined ? params.takerFeeRate : currentTakerFeeRate;

  const makerFee = makerVol * mRate;
  const takerFee = takerVol * tRate;
  const totalFee = makerFee + takerFee;
  const blendedPct = totalVol > 0 ? (totalFee / totalVol) * 100 : mRate * 100;

  return {
    totalVolumeUSDT: parseFloat(totalVol.toFixed(2)),
    makerFeeUSDT: parseFloat(makerFee.toFixed(4)),
    takerFeeUSDT: parseFloat(takerFee.toFixed(4)),
    totalCalculatedFeeUSDT: parseFloat(totalFee.toFixed(4)),
    effectiveBlendedRatePct: parseFloat(blendedPct.toFixed(4)),
  };
}
