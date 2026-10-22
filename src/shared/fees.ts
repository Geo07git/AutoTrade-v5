export function calculateExecutionFee(notional: number, type: 'maker' | 'taker'): number {
  // Simple fee model: 0.05% taker, 0.02% maker
  const feeRate = type === 'taker' ? 0.0005 : 0.0002;
  return parseFloat((notional * feeRate).toFixed(4));
}
