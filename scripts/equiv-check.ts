// Differential equivalence harness: old buildVariant closure (verbatim from
// e640d5a) vs the extracted pure module (896d207). Local only, never committed.
//
//   npx tsx scripts/equiv-check.ts [iterations]
//
// Exit code 0 = byte-identical output on every fixture.

import {
  buildGridRangeVariants,
  selectActiveRangeVariant,
} from '../src/server/engine/grid/GridRangeVariants';
import type { GridRangeVariantContext } from '../src/server/engine/grid/GridRangeVariants';
import type { GridRangeVariantId } from '../src/shared/types';
import { oldBuildAll } from './_oldVariants';

// Deterministic PRNG so a failure is reproducible.
const mulberry32 = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const rnd = mulberry32(0x5eed1234);
const rand = (lo: number, hi: number): number => lo + rnd() * (hi - lo);
const randInt = (lo: number, hi: number): number => Math.floor(rand(lo, hi + 1));
const logRand = (lo: number, hi: number): number =>
  Math.exp(rand(Math.log(lo), Math.log(hi)));

/** Canonical form: sorted keys, undefined marked explicitly so it cannot hide. */
const canon = (v: unknown): unknown => {
  if (v === undefined) return '<undefined>';
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(canon);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v as object).sort()) {
    out[k] = canon((v as Record<string, unknown>)[k]);
  }
  return out;
};

const IDS: GridRangeVariantId[] = ['CONSERVATIVE', 'BALANCED', 'COMPACT'];

const makeFixture = (i: number): { ctx: GridRangeVariantContext; id: GridRangeVariantId } => {
  // First 40 fixtures are hand-picked edges, the rest are randomised.
  if (i === 0) {
    return {
      id: 'BALANCED',
      ctx: {
        price: 2000, decimals: 2, volFactor: 1, range24hPct: 4, chosenLever: 5,
        minLotNotionalUSD: 20, probeMinInvestmentUSDT: 0, totalCostPerGridPct: 0.055,
        roundTripMakerFeePct: 0.04, maxBudgetPerBotUSDT: 25, minNetProfitPerGridPct: 0.12,
      },
    };
  }
  if (i === 1) {
    return {
      id: 'COMPACT',
      ctx: {
        price: 2000, decimals: 2, volFactor: 1, range24hPct: 4, chosenLever: 5,
        minLotNotionalUSD: 20, probeMinInvestmentUSDT: 0, totalCostPerGridPct: 0.09,
        roundTripMakerFeePct: 0.04, maxBudgetPerBotUSDT: 25, minNetProfitPerGridPct: 0.12,
      },
    };
  }
  if (i === 2) {
    // decimals 0 + dust price + huge cost + no budget
    return {
      id: 'CONSERVATIVE',
      ctx: {
        price: 0.1, decimals: 0, volFactor: 0.72, range24hPct: 0.2, chosenLever: 1,
        minLotNotionalUSD: 0.5, probeMinInvestmentUSDT: 0, totalCostPerGridPct: 0.35,
        roundTripMakerFeePct: 0.06, maxBudgetPerBotUSDT: 2, minNetProfitPerGridPct: 0.02,
      },
    };
  }
  if (i === 3) {
    // volFactor ceiling + 6 decimals + whale budget + probe answered
    return {
      id: 'COMPACT',
      ctx: {
        price: 98765.4321, decimals: 6, volFactor: 1.45, range24hPct: 25, chosenLever: 20,
        minLotNotionalUSD: 500, probeMinInvestmentUSDT: 400, totalCostPerGridPct: 0.02,
        roundTripMakerFeePct: 0.02, maxBudgetPerBotUSDT: 100, minNetProfitPerGridPct: 0.5,
      },
    };
  }
  if (i === 4) {
    // boundary hunt around the 42% fee-load gate and the COMPACT net threshold
    return {
      id: 'COMPACT',
      ctx: {
        price: 100, decimals: 2, volFactor: 1, range24hPct: 12, chosenLever: 3,
        minLotNotionalUSD: 1, probeMinInvestmentUSDT: 0, totalCostPerGridPct: 0.063,
        roundTripMakerFeePct: 0.04, maxBudgetPerBotUSDT: 5, minNetProfitPerGridPct: 0.12,
      },
    };
  }

  return {
    id: IDS[randInt(0, 2)],
    ctx: {
      price: logRand(0.1, 100_000),
      decimals: randInt(0, 6),
      volFactor: rand(0.72, 1.45),
      range24hPct: rand(0.2, 25),
      chosenLever: randInt(1, 20),
      minLotNotionalUSD: rand(0.5, 500),
      probeMinInvestmentUSDT: rnd() < 0.3 ? 0 : rand(1, 120),
      totalCostPerGridPct: rand(0.02, 0.35),
      roundTripMakerFeePct: rand(0.02, 0.06),
      maxBudgetPerBotUSDT: rand(2, 100),
      minNetProfitPerGridPct: rand(0.02, 0.5),
    },
  };
};

const iterations = Number(process.argv[2] || 5000);

let mismatches = 0;
let checked = 0;
const stats = {
  feeCheckPassed: { t: 0, f: 0 },
  compactRejected: 0,
  budgetFallback: 0,
  differentIdSelected: 0,
};

for (let i = 0; i < iterations; i++) {
  const { ctx, id } = makeFixture(i);

  const oldOut = oldBuildAll(ctx, id);
  const newVariants = buildGridRangeVariants(ctx);
  const newActive = selectActiveRangeVariant(newVariants, id);

  checked++;

  const oldCanon = JSON.stringify(canon(oldOut.rangeVariants));
  const newCanon = JSON.stringify(canon(newVariants));
  const oldActiveCanon = JSON.stringify(canon(oldOut.activeVar));
  const newActiveCanon = JSON.stringify(canon(newActive));

  if (oldCanon !== newCanon || oldActiveCanon !== newActiveCanon) {
    mismatches++;
    if (mismatches <= 3) {
      console.error(`\nMISMATCH on fixture #${i} (requested ${id})`);
      console.error('ctx:', JSON.stringify(ctx));
      if (oldCanon !== newCanon) {
        console.error('variants differ');
        for (const k of IDS) {
          if (JSON.stringify(canon(oldOut.rangeVariants[k])) !== JSON.stringify(canon(newVariants[k]))) {
            console.error(`  ${k} OLD:`, JSON.stringify(canon(oldOut.rangeVariants[k])));
            console.error(`  ${k} NEW:`, JSON.stringify(canon(newVariants[k])));
          }
        }
      }
      if (oldActiveCanon !== newActiveCanon) {
        console.error(`activeVar OLD: ${oldActiveCanon}`);
        console.error(`activeVar NEW: ${newActiveCanon}`);
      }
    }
  }

  for (const k of IDS) {
    if (newVariants[k].feeCheckPassed) stats.feeCheckPassed.t++;
    else stats.feeCheckPassed.f++;
  }
  if (id === 'COMPACT' && !newVariants.COMPACT.feeCheckPassed) stats.compactRejected++;
  if (!newVariants[id].fitsMaxBudget && newVariants.CONSERVATIVE.fitsMaxBudget) stats.budgetFallback++;
  if (newActive.id !== id) stats.differentIdSelected++;
}

// Unknown/invalid requested id must degrade to BALANCED in both implementations.
const unknownId = 'NOPE' as unknown as GridRangeVariantId;
const unknownOld = oldBuildAll(makeFixture(0).ctx, unknownId).activeVar;
const unknownNew = selectActiveRangeVariant(buildGridRangeVariants(makeFixture(0).ctx), unknownId);
const unknownOk =
  JSON.stringify(canon(unknownOld)) === JSON.stringify(canon(unknownNew));

console.log(`\nfixtures checked   : ${checked}`);
console.log(`mismatches         : ${mismatches}`);
console.log(`unknown-id fallback: ${unknownOk ? 'identical' : 'DIFFERS'}`);
console.log(`\ncoverage of the new paths:`);
console.log(`  feeCheckPassed      : true=${stats.feeCheckPassed.t}  false=${stats.feeCheckPassed.f}`);
console.log(`  COMPACT rejected    : ${stats.compactRejected}`);
console.log(`  budget -> CONSERV   : ${stats.budgetFallback}`);
console.log(`  different id picked : ${stats.differentIdSelected}`);

if (mismatches > 0 || !unknownOk) {
  console.error('\nRESULT: NOT equivalent');
  process.exitCode = 1;
} else {
  console.log('\nRESULT: byte-identical on all fixtures');
}
