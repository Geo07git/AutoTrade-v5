/**
 * OKX Fee Structure - Single Source of Truth
 * Regular Tier on OKX SWAP:
 * - Maker: 0.02% (0.0002)
 * - Taker: 0.05% (0.0005)
 */

export const OKX_FEE_RATES = {
  MAKER: 0.0002, // 0.02%
  TAKER: 0.0005, // 0.05%
} as const;

export type OrderExecutionFeeType = 'Market' | 'Limit' | 'taker' | 'maker';

/**
 * Calculates trading execution fee based on total notional value in USDT.
 * @param notionalUSDT Position or order notional (contracts * ctVal * price)
 * @param executionType Market / Limit or taker / maker
 * @returns fee in USDT rounded to 4 decimals
 */
export function calculateExecutionFee(
  notionalUSDT: number,
  executionType: OrderExecutionFeeType = 'Market'
): number {
  if (!notionalUSDT || notionalUSDT <= 0) return 0;
  const isMaker = executionType === 'Limit' || executionType === 'maker';
  const rate = isMaker ? OKX_FEE_RATES.MAKER : OKX_FEE_RATES.TAKER;
  return parseFloat((notionalUSDT * rate).toFixed(4));
}

/**
 * Calculates total trading execution fees across a complete 4-execution pair cycle:
 * 1. MAIN entry
 * 2. MAIN exit
 * 3. HEDGE entry
 * 4. HEDGE exit
 */
export function calculatePairCycleFees(params: {
  mainEntryNotional: number;
  mainExitNotional: number;
  hedgeEntryNotional: number;
  hedgeExitNotional: number;
  orderType?: OrderExecutionFeeType;
}): {
  mainEntryFee: number;
  mainExitFee: number;
  hedgeEntryFee: number;
  hedgeExitFee: number;
  totalCycleFees: number;
} {
  const type = params.orderType || 'taker';
  const mainEntryFee = calculateExecutionFee(params.mainEntryNotional, type);
  const mainExitFee = calculateExecutionFee(params.mainExitNotional, type);
  const hedgeEntryFee = calculateExecutionFee(params.hedgeEntryNotional, type);
  const hedgeExitFee = calculateExecutionFee(params.hedgeExitNotional, type);
  const totalCycleFees = parseFloat((mainEntryFee + mainExitFee + hedgeEntryFee + hedgeExitFee).toFixed(4));

  return {
    mainEntryFee,
    mainExitFee,
    hedgeEntryFee,
    hedgeExitFee,
    totalCycleFees,
  };
}
