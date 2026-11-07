// Extracts the pre-refactor buildVariant block verbatim from git (e640d5a) and
// wraps it in a function so it can be compared against the extracted module.
// Reads through Node (UTF-8) on purpose: PowerShell mangled the diacritics.
// Local only, never committed.

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const OLD_COMMIT = 'e640d5a';
const SRC = 'src/server/engine/grid/OKXNativeGridEngine.ts';

const oldFile = execFileSync('git', ['show', `${OLD_COMMIT}:${SRC}`], {
  encoding: 'utf8',
  maxBuffer: 32 * 1024 * 1024,
});
const lines = oldFile.split('\n');

const startIdx = lines.findIndex((l) => /^\s*const buildVariant = \(/.test(l));
if (startIdx < 0) throw new Error('buildVariant start marker not found');

const lastAssign = lines.findIndex((l) => l.includes('activeVar = conservativeVariant;'));
if (lastAssign < 0) throw new Error('selection block not found');

// The removed region ends at the "}" that closes the final `if` after the last assignment.
let endIdx = -1;
for (let i = lastAssign + 1; i < lines.length; i++) {
  if (lines[i].trim() === '}') {
    endIdx = i;
    break;
  }
}
if (endIdx < 0) throw new Error('closing brace of selection block not found');

const indent = (lines[startIdx].match(/^\s*/) || [''])[0].length;
const block = lines.slice(startIdx, endIdx + 1).map((l) => (l.length >= indent ? l.slice(indent) : l));

// Sanity: the block must be balanced and must contain both halves.
const joined = block.join('\n');
const opens = (joined.match(/\{/g) || []).length;
const closes = (joined.match(/\}/g) || []).length;
if (opens !== closes) throw new Error(`unbalanced block: ${opens} { vs ${closes} }`);
if (!joined.includes('feeWarning') || !joined.includes('activeVar = conservativeVariant')) {
  throw new Error('extracted block looks wrong');
}

const header = `// AUTO-GENERATED from ${OLD_COMMIT}:${SRC} -- do not edit, do not commit.
// Verbatim copy of the deleted buildVariant closure plus its selection block,
// wrapped so it can be diffed against the extracted pure module.
import type { GridRangeVariantId, GridRangeVariantProfile } from '../src/shared/types';
import type { GridRangeVariantContext } from '../src/server/engine/grid/GridRangeVariants';

export function oldBuildAll(
  ctx: GridRangeVariantContext,
  activeVariantId: GridRangeVariantId
): { rangeVariants: Record<GridRangeVariantId, GridRangeVariantProfile>; activeVar: GridRangeVariantProfile } {
  const {
    price, decimals, volFactor, range24hPct, chosenLever, minLotNotionalUSD,
    probeMinInvestmentUSDT, totalCostPerGridPct, roundTripMakerFeePct,
    maxBudgetPerBotUSDT, minNetProfitPerGridPct,
  } = ctx;
  const cfg = { maxBudgetPerBotUSDT, minNetProfitPerGridPct };
  const baseAnalysis = { range24hPct };
  const probeMinInv = { minInvestmentUSDT: probeMinInvestmentUSDT, ccy: 'USD' };
`;

const footer = `
  return { rangeVariants, activeVar };
}
`;

writeFileSync('scripts/_oldVariants.ts', header + '\n' + block.join('\n') + footer, 'utf8');
console.log(`extracted ${block.length} lines from ${OLD_COMMIT} (indent ${indent})`);
console.log(`first: ${block[0].trim()}`);
console.log(`last : ${block[block.length - 1].trim()}`);
