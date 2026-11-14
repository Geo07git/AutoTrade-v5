/**
 * P0.3 — contabilitatea trebuie să poată răspunde la două întrebări diferite:
 *
 *   gridCaptureUSDT = ce a produs mecanica grilei (round-trip-uri buy-low / sell-high)
 *   exitCostUSDT    = ce a costat politica de ieșire (închideri forțate la piață ale inventarului)
 *   feesUSDT        = ce a luat OKX
 *
 * și, oricând,
 *
 *   totalNetPnlUSDT = gridCaptureUSDT + exitCostUSDT − feesUSDT + fundingEstimateUSDT + floatingPnlUSDT
 *
 * De ce: pe 2026-11-14, 135 de boți opriți aveau un singur contor (`gridProfitUSDT`) = −5.7032
 * și un PnL total net de −7.7896. Suma round-trip-urilor din jurnalul de arbitraje era +7.5303,
 * deci −13.2335 din rezultat venea din închideri, nu din grilă — și nu se putea vedea nicăieri.
 * Contorul unic făcea indistincte „grila a funcționat, ieșirea a distrus" și „grila a fost moartă".
 *
 * Fixture-ul `fixtures/pnl-2026-11-14.json` e un extract real (doar cifre) din
 * `.data/grid_bots.json` + `.data/grid_arbitrages.json`, ca testul să nu depindă de `.data/`.
 *
 * Run: npm test
 */

import fs from 'fs';
import path from 'path';
import {
  addToCounter,
  buildPnlBreakdown,
  chargeExitCost,
  chargeFee,
  computeNetPnl,
  createPnlCounters,
  creditGridCapture,
  legacyGridProfit,
  splitLegacyRealized,
  splitIsIntact,
} from '../gridPnlAccounting';

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------
const ok = (cond: unknown, msg: string): void => {
  if (!cond) throw new Error(msg);
};
const eq = (actual: unknown, expected: unknown, msg: string): void => {
  if (actual !== expected) throw new Error(`${msg} (expected ${expected}, got ${actual})`);
};
const round = (v: number): number => parseFloat(v.toFixed(4));

const tests: { name: string; fn: () => void }[] = [];
const test = (name: string, fn: () => void): void => {
  tests.push({ name, fn });
};

// ---------------------------------------------------------------------------
// Fixture: the real 135 bots, measured on 2026-11-14
// ---------------------------------------------------------------------------
interface FixtureBot {
  botId: string;
  symbol: string;
  gridProfitUSDT: number;
  totalFeesUSDT: number;
  totalNetPnlUSDT: number;
  fundingEstimateUSDT: number;
  floatingPnlUSDT: number;
  completedArbitrages: number;
}

function loadFixture(): { bots: FixtureBot[]; arbitrageSumByBot: Map<string, number> } {
  const file = path.join(
    process.cwd(),
    'src/server/engine/grid/__tests__/fixtures/pnl-2026-11-14.json'
  );
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));

  const bots: FixtureBot[] = (raw.bots as number[][]).length
    ? (raw.bots as any[][]).map((row) => ({
        botId: String(row[0]),
        symbol: String(row[1]),
        gridProfitUSDT: Number(row[2]),
        totalFeesUSDT: Number(row[3]),
        totalNetPnlUSDT: Number(row[4]),
        fundingEstimateUSDT: Number(row[5]),
        floatingPnlUSDT: Number(row[6]),
        completedArbitrages: Number(row[7]),
      }))
    : [];

  const arbitrageSumByBot = new Map<string, number>();
  for (const row of raw.arbitrages as any[][]) {
    const botId = String(row[0]);
    arbitrageSumByBot.set(botId, (arbitrageSumByBot.get(botId) || 0) + Number(row[1]));
  }

  return { bots, arbitrageSumByBot };
}

/** Replays a sequence of credits/charges into a fresh counter set. */
function replay(steps: Array<{ capture?: number; exit?: number; fee?: number }>) {
  const c = createPnlCounters();
  for (const s of steps) {
    if (s.capture !== undefined) creditGridCapture(c, s.capture);
    if (s.exit !== undefined) chargeExitCost(c, s.exit);
    if (s.fee !== undefined) chargeFee(c, s.fee);
  }
  return c;
}

/**
 * The pre-fix model, kept only to prove what it could not answer: one accumulator for
 * round-trips and forced closes alike.
 */
function legacySingleCounter(steps: Array<{ capture?: number; exit?: number }>): number {
  let acc = 0;
  for (const s of steps) {
    if (s.capture !== undefined) acc += s.capture;
    if (s.exit !== undefined) acc += s.exit;
  }
  return round(acc);
}

// ---------------------------------------------------------------------------
// The scenario from the plan, with the arithmetic spelled out
// ---------------------------------------------------------------------------

test('capture si exitCost sunt separabile, iar suma lor da netul', () => {
  // qty 2 contracte, ctVal 1, intrare 100, round-trip inchis la 100.28, apoi inchidere fortata la 98.5
  const c = createPnlCounters();
  creditGridCapture(c, (100.28 - 100) * 2); // +0.56
  chargeFee(c, 0.012); //                   2 x maker 0.02% pe 100 / 100.28
  chargeExitCost(c, (98.5 - 100.28) * 2); // -3.56
  chargeFee(c, 0.0985); //                    taker 0.05% pe 98.5 x 2

  eq(c.gridCaptureUSDT, 0.56, 'captura din round-trip trebuie sa fie pozitiva si izolata');
  eq(c.exitCostUSDT, -3.56, 'costul iesirii trebuie sa fie negativ si vizibil separat');
  eq(c.feesUSDT, 0.1105, 'fees adunate o singura data');
  eq(c.floatingPnlUSDT, 0, 'dupa inchidere nu mai exista inventar');
  eq(computeNetPnl(c), -3.1105, 'net = 0.56 - 3.56 - 0.1105');
  eq(buildPnlBreakdown(c).gridProfitUSDT, -3.0, 'agregatul legacy = 0.56 - 3.56');
});

// ---------------------------------------------------------------------------
// Why the split exists: two bots the single counter makes identical
// ---------------------------------------------------------------------------

test('doi boti cu ACELASI gridProfitUSDT nu mai sunt indistinctibile', () => {
  const goodGridBadExit = replay([{ capture: 7.5303 }, { exit: -13.2335 }]);
  const deadGridBadExit = replay([{ capture: 0 }, { exit: -5.7032 }]);

  eq(
    legacySingleCounter([{ capture: 7.5303 }, { exit: -13.2335 }]),
    legacySingleCounter([{ capture: 0 }, { exit: -5.7032 }]),
    'contorul unic le dadea acelasi numar: asta era bug-ul de raportare'
  );
  eq(legacyGridProfit(goodGridBadExit), -5.7032, 'agregatul vechi e identic (bot A)');
  eq(legacyGridProfit(deadGridBadExit), -5.7032, 'agregatul vechi e identic (bot B)');

  ok(goodGridBadExit.gridCaptureUSDT > 6.0, 'botul A a prins 7.53 din grila: trebuie sa se vada');
  eq(deadGridBadExit.gridCaptureUSDT, 0, 'botul B nu a prins niciun round-trip');
  ok(
    goodGridBadExit.exitCostUSDT < deadGridBadExit.exitCostUSDT,
    'costul iesirii lui A e mai mare, dar grila lui a produs de 7x mai mult'
  );
});

// ---------------------------------------------------------------------------
// The 135 historical bots, replayed from the committed fixture
// ---------------------------------------------------------------------------

test('reprocesarea celor 135 de boti istorici: identitatea tine, cifrele ies masurate', () => {
  const { bots, arbitrageSumByBot } = loadFixture();
  eq(bots.length, 135, 'fixture-ul trebuie sa contina toti cei 135 de boti opriti');

  let capture = 0;
  let exitCost = 0;
  let fees = 0;
  let net = 0;
  let floating = 0;
  let captureBeatsProfit = 0;
  let splitBroken = 0;

  for (const bot of bots) {
    const split = splitLegacyRealized(bot.gridProfitUSDT, arbitrageSumByBot.get(bot.botId) || 0);

    eq(
      round(split.gridCaptureUSDT + split.exitCostUSDT),
      round(bot.gridProfitUSDT),
      `${bot.symbol} (${bot.botId}): capture + exitCost trebuie sa dea exact gridProfitUSDT`
    );

    if (!splitIsIntact(bot.gridProfitUSDT, split)) splitBroken++;
    if (split.gridCaptureUSDT > bot.gridProfitUSDT) captureBeatsProfit++;

    capture += split.gridCaptureUSDT;
    exitCost += split.exitCostUSDT;
    fees += bot.totalFeesUSDT;
    net += bot.totalNetPnlUSDT;
    floating += bot.floatingPnlUSDT;

    // Identitatea pe care o verifica si motorul la runtime, pe fiecare bot oprit.
    eq(
      round(
        split.gridCaptureUSDT +
          split.exitCostUSDT -
          bot.totalFeesUSDT +
          bot.fundingEstimateUSDT +
          bot.floatingPnlUSDT
      ),
      round(bot.totalNetPnlUSDT),
      `${bot.symbol}: totalNetPnlUSDT trebuie sa fie derivabil din capture/exit/fees`
    );
  }

  eq(splitBroken, 0, 'niciun bot nu are split-ul rupt');
  eq(round(capture), 7.5303, 'captura agregata = totalul jurnalului de arbitraje');
  eq(round(exitCost), -13.2335, 'costul iesirilor, pana acum doar [derivat] in audit');
  eq(round(fees), 2.0864, 'fees neschimbate de acest fix');
  eq(round(net), -7.7896, 'netul din audit, acum derivabil');
  eq(round(floating), 0, 'totI botii sunt opriti: fara PnL flotant');
  eq(
    captureBeatsProfit,
    100,
    'pe 100 din 135 de boti iesirea a mancat mai mult decat a produs grila'
  );
});

test('botii cu zero arbitraje nu inventeaza captura: pierderea lor e toata cost de iesire', () => {
  const { bots, arbitrageSumByBot } = loadFixture();
  const noArbitrage = bots.filter((b) => b.completedArbitrages === 0);
  ok(noArbitrage.length > 0, 'fixture-ul trebuie sa contina boti fara niciun arbitraj');

  for (const bot of noArbitrage) {
    const split = splitLegacyRealized(bot.gridProfitUSDT, arbitrageSumByBot.get(bot.botId) || 0);
    eq(split.gridCaptureUSDT, 0, `${bot.symbol}: fara arbitraje nu exista captura`);
    eq(
      round(split.exitCostUSDT),
      round(bot.gridProfitUSDT),
      `${bot.symbol}: toata pierderea ramasa e cost de iesire`
    );
  }
});

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

test('splitLegacyRealized e determinist si idempotent', () => {
  const first = splitLegacyRealized(-0.3992, 0.7626);
  const second = splitLegacyRealized(-0.3992, 0.7626);
  eq(first.gridCaptureUSDT, 0.7626, 'captura vine din jurnalul de arbitraje');
  eq(first.exitCostUSDT, -1.1618, 'restul e cost de iesire');
  eq(second.gridCaptureUSDT, first.gridCaptureUSDT, 'aceleasi intrari, acelasi rezultat');
  eq(second.exitCostUSDT, first.exitCostUSDT, 'fara acumulare intre apeluri');
});

test('o singura regula de rotunjire, aplicata la fiecare creditare', () => {
  const c = createPnlCounters();
  for (let i = 0; i < 1000; i++) creditGridCapture(c, 0.0001);
  eq(c.gridCaptureUSDT, 0.1, '1000 x 0.0001 trebuie sa dea exact 0.1 la 4 zecimale');

  eq(addToCounter(0.1, 0.2), 0.3, '0.1 + 0.2 nu are voie sa dea 0.30000000000000004');
  eq(addToCounter(0, -0), 0, 'zero nu devine -0');

  const c2 = createPnlCounters();
  creditGridCapture(c2, 1.23456789);
  eq(c2.gridCaptureUSDT, 1.2346, 'fiecare creditare se rotunjeste la 4 zecimale');
});

test('fees nu sunt scazute de doua ori, iar split-ul rupt e detectat', () => {
  const c = createPnlCounters();
  creditGridCapture(c, 1.5); // captura e BRUTA de fees, prin contract
  chargeFee(c, 0.05);
  chargeExitCost(c, -0.5);
  chargeFee(c, 0.02);

  eq(computeNetPnl(c), 0.93, '1.5 - 0.5 - 0.07');
  ok(splitIsIntact(1.0, c), '1.5 - 0.5 = 1.0, split-ul e intact');
  ok(
    !splitIsIntact(1.0, { gridCaptureUSDT: 1.6, exitCostUSDT: -0.5 }),
    'capture + exitCost != gridProfitUSDT trebuie semnalat'
  );
  ok(
    splitIsIntact(1.005, c),
    'o diferenta de 0.005 e sub toleranta de $0.01 a garzii de runtime'
  );
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
let failed = 0;
for (const t of tests) {
  try {
    t.fn();
    console.log(`  ok    ${t.name}`);
  } catch (err: any) {
    failed += 1;
    console.error(`  FAIL  ${t.name}`);
    console.error(`        ${err?.message || err}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
if (failed > 0) process.exitCode = 1;
