import {
  GridRangeVariantId,
  GridRangeVariantProfile,
} from '../../../shared/types';

export interface GridRangeVariantContext {
  price: number;                    // prețul curent al contractului
  decimals: number;                 // zecimale derivate din tickSize
  volFactor: number;                // factorul de volatilitate calibrat (0.72..1.45)
  range24hPct: number;
  chosenLever: number;
  minLotNotionalUSD: number;
  probeMinInvestmentUSDT: number;   // 0 dacă OKX nu a răspuns
  totalCostPerGridPct: number;      // fee round-trip + funding drag + spread drag
  roundTripMakerFeePct: number;
  maxBudgetPerBotUSDT: number;
  minNetProfitPerGridPct: number;
}

export interface GridRangeVariantSpec {
  id: GridRangeVariantId;
  label: string;
  subtitle: string;
  targetHalfBasePct: number;
  minGrids: number;
  maxGrids: number;
  targetStepPct: number;
}

export const GRID_RANGE_VARIANT_SPECS: Record<GridRangeVariantId, GridRangeVariantSpec> = {
  CONSERVATIVE: {
    id: 'CONSERVATIVE',
    label: 'Range Conservator (Larg)',
    subtitle: 'Mai puține execuții • Risc redus de ieșire din range',
    targetHalfBasePct: 2.05,
    minGrids: 4,
    maxGrids: 5,
    targetStepPct: 1.02,
  },
  BALANCED: {
    id: 'BALANCED',
    label: 'Range Echilibrat (Recomandat)',
    subtitle: 'Varianta de testat • Mai multe oportunități',
    targetHalfBasePct: 1.25,
    minGrids: 6,
    maxGrids: 8,
    targetStepPct: 0.38,
  },
  COMPACT: {
    id: 'COMPACT',
    label: 'Range Compact (Frecvență Mare)',
    subtitle: 'Risc de supra-tranzacționare • Necesită verificarea strictă a comisioanelor',
    targetHalfBasePct: 0.75,
    minGrids: 8,
    maxGrids: 10,
    targetStepPct: 0.17,
  },
};

export function buildGridRangeVariant(
  spec: GridRangeVariantSpec,
  ctx: GridRangeVariantContext
): GridRangeVariantProfile {
  const { id, label, subtitle, targetHalfBasePct, minGrids, maxGrids, targetStepPct } = spec;
  const {
    price,
    decimals,
    volFactor,
    range24hPct,
    chosenLever,
    minLotNotionalUSD,
    probeMinInvestmentUSDT,
    totalCostPerGridPct,
    roundTripMakerFeePct,
    maxBudgetPerBotUSDT,
    minNetProfitPerGridPct,
  } = ctx;

  const halfRangePct = parseFloat((targetHalfBasePct * volFactor).toFixed(2));
  const totalRangePct = parseFloat((halfRangePct * 2).toFixed(2));
  const vMinPx = parseFloat((price * (1 - halfRangePct / 100)).toFixed(decimals));
  const vMaxPx = parseFloat((price * (1 + halfRangePct / 100)).toFixed(decimals));

  let gridNum = Math.round(totalRangePct / Math.max(0.1, targetStepPct));
  gridNum = Math.max(minGrids, Math.min(maxGrids, gridNum));
  if (id !== 'CONSERVATIVE' && gridNum % 2 !== 0 && gridNum < maxGrids) {
    gridNum += 1;
  }

  const gridSpacingUSDT = (vMaxPx - vMinPx) / Math.max(1, gridNum);
  const gridSpacingPct = parseFloat(((gridSpacingUSDT / price) * 100).toFixed(2));
  const estimatedGrossProfitPerGridPct = gridSpacingPct;
  const estimatedNetProfitPerGridPct = parseFloat(
    (estimatedGrossProfitPerGridPct - totalCostPerGridPct).toFixed(3)
  );

  // Estimate min investment required for this variant's gridNum at chosenLever
  const basePerGridMargin =
    probeMinInvestmentUSDT > 0
      ? probeMinInvestmentUSDT / 6
      : Math.max(0.8, (minLotNotionalUSD * 1.08) / Math.max(1, chosenLever));
  const minInvestmentUSDT = parseFloat(
    Math.max(2.0, basePerGridMargin * gridNum).toFixed(2)
  );
  const fitsMaxBudget =
    minInvestmentUSDT > 0 && minInvestmentUSDT <= maxBudgetPerBotUSDT;
  const recommendedInvestmentUSDT = fitsMaxBudget
    ? parseFloat(
        Math.min(
          maxBudgetPerBotUSDT,
          Math.max(minInvestmentUSDT * 1.05, minInvestmentUSDT + 0.5)
        ).toFixed(2)
      )
    : minInvestmentUSDT;

  const estDailyCrossings = Math.max(
    1,
    Math.min(32, (range24hPct / Math.max(0.12, gridSpacingPct)) * 1.35)
  );
  const estimatedDailyNetYieldPct = parseFloat(
    (
      Math.max(0, estimatedNetProfitPerGridPct) *
      estDailyCrossings *
      0.35 *
      chosenLever
    ).toFixed(2)
  );

  const feeLoadPctOfStep = parseFloat(
    ((totalCostPerGridPct / Math.max(0.01, gridSpacingPct)) * 100).toFixed(1)
  );
  const minRequiredNetPct =
    id === 'COMPACT'
      ? Math.max(0.06, roundTripMakerFeePct * 1.75)
      : Math.max(0.08, minNetProfitPerGridPct * 0.8);
  const feeCheckPassed =
    estimatedNetProfitPerGridPct >= minRequiredNetPct && feeLoadPctOfStep <= 42;

  const feeWarning = !feeCheckPassed
    ? `Atenție comisioane: costul total (${totalCostPerGridPct.toFixed(3)}%) consumă ${feeLoadPctOfStep}% din pasul grilei (${gridSpacingPct.toFixed(2)}%).`
    : id === 'COMPACT'
    ? `Comisioane verificate: cost ${totalCostPerGridPct.toFixed(3)}% (${feeLoadPctOfStep}% din pas), net +${estimatedNetProfitPerGridPct.toFixed(2)}%/grilă.`
    : undefined;

  return {
    id,
    label,
    subtitle,
    halfRangePct,
    totalRangePct,
    minPx: vMinPx,
    maxPx: vMaxPx,
    gridNum,
    gridSpacingPct,
    lever: chosenLever,
    minInvestmentUSDT,
    recommendedInvestmentUSDT,
    fitsMaxBudget,
    estimatedGrossProfitPerGridPct,
    estimatedNetProfitPerGridPct,
    estimatedDailyNetYieldPct,
    feeCheckPassed,
    feeLoadPctOfStep,
    feeWarning,
  };
}

export function buildGridRangeVariants(
  ctx: GridRangeVariantContext
): Record<GridRangeVariantId, GridRangeVariantProfile> {
  return {
    CONSERVATIVE: buildGridRangeVariant(GRID_RANGE_VARIANT_SPECS.CONSERVATIVE, ctx),
    BALANCED: buildGridRangeVariant(GRID_RANGE_VARIANT_SPECS.BALANCED, ctx),
    COMPACT: buildGridRangeVariant(GRID_RANGE_VARIANT_SPECS.COMPACT, ctx),
  };
}

export function selectActiveRangeVariant(
  variants: Record<GridRangeVariantId, GridRangeVariantProfile>,
  requestedId: GridRangeVariantId
): GridRangeVariantProfile {
  let active = variants[requestedId] || variants.BALANCED;
  if (requestedId === 'COMPACT' && !variants.COMPACT.feeCheckPassed) {
    active = variants.BALANCED;
  }
  if (!active.fitsMaxBudget && variants.CONSERVATIVE.fitsMaxBudget) {
    active = variants.CONSERVATIVE;
  }
  return active;
}
