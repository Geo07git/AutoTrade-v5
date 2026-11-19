/**
 * PIEVERSE `grid_pieverse_mwk05tlp` — cazul care a pornit ancheta.
 *
 * Simptomul raportat: `avgHoldPrice 1.9413`, `currentPrice 1.8889`, `exitCostUSDT -1.048`,
 * `netPositionContracts 0` (FLAT) si UN SINGUR nivel `IDLE` (idx 6 @ 1.9351, 1 contract).
 * Intrebarea: de unde 1.048 daca inventarul pare a fi un contract? Raspunsul scurt: nu pare.
 * Un nivel `IDLE` nu poarta inventar — `FILLED_HOLDING` nu e scris niciodata de motor, iar
 * nivelul care a tinut prima leg-ura a fost flipat pe `OPEN_ORDER` de fill-ul urmator si apoi
 * anulat de `stopBot`. Inventarul real era +2, deschis prin doua fill-uri Buy necompensate:
 * 1.9475 (idx 7) si 1.9351 (idx 6), cu media (1.9475 + 1.9351) / 2 = 1.9413.
 *
 * Fixture-ul e un extract doar-cifre din `.data/` (generat de `scripts/extract-grid-case.ts`,
 * proiectie whitelist, fara chei), ca testul sa nu depinda de `.data/` — acelasi tipar ca
 * `fixtures/pnl-2026-11-14.json`.
 *
 * Ce apara acest test: daca cineva "repara" `closeQty` derivandu-l din nivelurile `IDLE`, sau
 * rescrie `closeRealized`, sau face din nou indistincte captura si costul de iesire, testul
 * cade. El nu re-implementeaza ramurile din `handleGridLevelFilled` — verifica identitati
 * aritmetice care trebuie sa tina indiferent de implementare, plus cele doua fapte de
 * interpretare care au indus in eroare.
 *
 * Run: npm test
 */

import fs from 'fs';
import path from 'path';
import {
  computeNetPnl,
  countersFromBot,
  legacyGridProfit,
  splitIsIntact,
} from '../gridPnlAccounting';

// ---------------------------------------------------------------------------
// Assertions (acelasi stil ca restul suitei)
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
// Fixture
// ---------------------------------------------------------------------------
interface FixtureLevel {
  index: number;
  price: number;
  side: string;
  status: string;
  qtyContracts: number;
  notionalUSDT: number;
  fillCount: number;
  lastFilledAt: number;
  realizedGridProfitUSDT: number;
}

interface FixtureOrder {
  intent: string;
  side: string;
  orderType: string;
  qty: number;
  price: number;
  sizeUSDT: number;
  feeUSDT: number;
  status: string;
  gridLevelIndex: number;
  createdTime: number;
  updatedTime: number;
}

interface FixtureArb {
  openSide: string;
  openPrice: number;
  closePrice: number;
  qtyContracts: number;
  grossProfitUSDT: number;
  feeUSDT: number;
  netProfitUSDT: number;
  gridIndex: number;
  timestamp: number;
}

interface Fixture {
  bot: {
    botId: string;
    symbol: string;
    status: string;
    avgHoldPrice: number;
    netPositionContracts: number;
    gridCaptureUSDT: number;
    exitCostUSDT: number;
    gridProfitUSDT: number;
    totalFeesUSDT: number;
    fundingEstimateUSDT: number;
    floatingPnlUSDT: number;
    totalNetPnlUSDT: number;
    completedArbitrages: number;
    lowerStopPrice: number;
  };
  derived: { closeRowQty: number | null; closeRowPrice: number | null; idleLevelCount: number };
  levels: FixtureLevel[];
  filledOrders: FixtureOrder[];
  filledOrdersTruncated: boolean;
  arbitrages: FixtureArb[];
  arbitragesTruncated: boolean;
}

function loadFixture(): Fixture {
  const file = path.join(
    process.cwd(),
    'src/server/engine/grid/__tests__/fixtures/grid-case-grid-pieverse-mwk05tlp-2026-11-19.json'
  );
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Fixture;
}

const fixture = loadFixture();
const bot = fixture.bot;

/** ctVal implicit: fiecare nivel isi poarta notionalul. `notionalUSDT` e rotunjit la 2 zecimale. */
const CT_VAL = 10;

const closeRow = fixture.filledOrders.find((o) => o.intent === 'GRID_STOP_CLOSE_INVENTORY');
const gridFills = fixture.filledOrders
  .filter((o) => o.intent.startsWith('GRID_FILL_'))
  .sort((a, b) => a.createdTime - b.createdTime);

const sum = (xs: number[]): number => xs.reduce((s, x) => s + x, 0);

// ---------------------------------------------------------------------------
// Identitati care trebuie sa tina indiferent de implementare
// ---------------------------------------------------------------------------

test('fixture-ul e complet: fara trunchiere, inchiderea exista, botul e oprit', () => {
  eq(fixture.filledOrdersTruncated, false, 'ordinele nu au fost trunchiate la extractie');
  eq(fixture.arbitragesTruncated, false, 'arbitrajele nu au fost trunchiate la extractie');
  ok(closeRow, 'trebuie sa existe randul GRID_STOP_CLOSE_INVENTORY');
  eq(bot.status, 'STOPPED', 'cazul e un bot oprit');
  eq(bot.netPositionContracts, 0, 'dupa stop, motorul raporteaza FLAT (nu spune cat a inchis)');
});

test('contractele din jurnal se anuleaza, deci cash flow-ul ESTE rezultatul realizat', () => {
  const cashFlow = round(
    sum(
      fixture.filledOrders.map((o) =>
        o.side === 'BUY' ? -(o.price * o.qty * CT_VAL) : o.price * o.qty * CT_VAL
      )
    )
  );
  const netJournalContracts = sum(
    fixture.filledOrders.map((o) => (o.side === 'BUY' ? o.qty : -o.qty))
  );

  eq(netJournalContracts, 0, 'dupa inchidere, contractele cumparate = cele vandute');
  eq(cashFlow, bot.gridProfitUSDT, 'pe pozitie plata, cash flow-ul e exact gridProfitUSDT');
  eq(
    round(cashFlow - bot.totalFeesUSDT),
    bot.totalNetPnlUSDT,
    'cash flow - fees = PnL total net'
  );
});

test('captura vine integral din jurnalul de arbitraje, si se inchide si per nivel', () => {
  const arbSum = round(sum(fixture.arbitrages.map((a) => a.netProfitUSDT)));
  const perLevel = round(sum(fixture.levels.map((l) => l.realizedGridProfitUSDT)));

  eq(fixture.arbitrages.length, 8, 'opt round-trip-uri');
  eq(fixture.arbitrages.length, bot.completedArbitrages, 'contorul de arbitraje se potriveste');
  eq(arbSum, bot.gridCaptureUSDT, 'captura = suma round-trip-urilor');
  eq(perLevel, bot.gridCaptureUSDT, 'atribuirea per nivel se inchide pe captura');
  ok(
    fixture.arbitrages.every((a) => a.netProfitUSDT > 0),
    'toate cele 8 round-trip-uri sunt pozitive: grila in sine nu a pierdut nimic'
  );
});

test('inchiderea fortata NU e inregistrata ca arbitraj (altfel captura ar fi contrafacuta)', () => {
  ok(
    fixture.arbitrages.every((a) => round(a.closePrice) !== round(closeRow!.price)),
    'niciun eveniment de arbitraj nu are loc la pretul de inchidere fortata'
  );
});

test('exitCostUSDT e o masuratoare a unei inchideri de 2 contracte', () => {
  const close = closeRow!;
  eq(close.qty, 2, 'randul de inchidere jurnalizeaza qty 2');
  eq(close.side, 'SELL', 'inchiderea unui long se face prin SELL');
  eq(round(close.price), 1.8889, 'pretul de inchidere');
  eq(fixture.derived.closeRowQty, 2, 'extractorul a vazut acelasi qty');

  // Aceeasi formula ca in `stopBot`: (closePrice - avgHoldPrice) * qty * ctVal * semn.
  const expected = round((close.price - bot.avgHoldPrice) * close.qty * CT_VAL * 1);
  eq(expected, -1.048, 'aritmetica inchiderii');
  eq(expected, bot.exitCostUSDT, 'exitCostUSDT stocat = inchiderea jurnalizata');
});


test('un singur nivel IDLE nu inseamna un singur contract (capcana documentata)', () => {
  const idle = fixture.levels.filter((l) => l.status === 'IDLE');
  eq(idle.length, 1, 'snapshotul are EXACT un nivel IDLE — asta a indus in eroare');
  eq(fixture.derived.idleLevelCount, 1, 'extractorul a numarat la fel');
  eq(idle[0].index, 6, 'IDLE e nivelul 1.9351');
  eq(idle[0].qtyContracts, 1, 'qty-ul nivelului e lotul lui, nu inventarul botului');

  // Ultimele doua fill-uri inainte de inchidere sunt ambele BUY: doua leg-uri deschise,
  // fara niciun SELL care sa le fi inchis. Media lor e chiar avgHoldPrice.
  const unmatched = gridFills.filter((o) => o.createdTime < closeRow!.createdTime).slice(-2);
  eq(unmatched.length, 2, 'doua fill-uri inainte de inchidere');
  eq(unmatched[0].side, 'BUY', 'penultimul fill e un BUY');
  eq(unmatched[1].side, 'BUY', 'ultimul fill e un BUY');
  eq(round(unmatched[0].price), 1.9475, 'prima leg-ura');
  eq(round(unmatched[1].price), 1.9351, 'a doua leg-ura');
  eq(
    round((unmatched[0].price + unmatched[1].price) / 2),
    bot.avgHoldPrice,
    'avgHoldPrice e media celor doua fill-uri necompensate'
  );

  // Ipoteza "1 nivel IDLE = 1 contract" nu reproduce datele: ar fi dat -0.524.
  const oneContract = round((closeRow!.price - bot.avgHoldPrice) * 1 * CT_VAL);
  eq(oneContract, -0.524, 'ipoteza gresita ar fi dat -0.524');
  ok(oneContract !== bot.exitCostUSDT, 'deci datele nu sunt compatibile cu un singur contract');
});

test('nivelul care a tinut prima leg-ura nu mai e IDLE: a fost flipat si anulat', () => {
  const held = fixture.levels.find((l) => round(l.price) === 1.9475);
  ok(held, 'nivelul 1.9475 exista');
  eq(held!.status, 'CANCELLED', 'stopBot l-a anulat');
  eq(held!.side, 'Sell', 'fusese flipat pe Sell de fill-ul de la nivelul urmator');
  eq(held!.fillCount, 3, 'a fost umplut de trei ori');
  ok(held!.status !== 'IDLE', 'de aceea suma qty pe nivelurile IDLE nu poate fi inventarul');
});

test('fillCount per nivel se inchide pe fill-urile jurnalizate', () => {
  eq(gridFills.length, 18, 'optsprezece fill-uri de grila + o inchidere = 19 ordine FILLED');
  eq(fixture.filledOrders.length, 19, 'totalul din jurnal');
  eq(
    sum(fixture.levels.map((l) => l.fillCount)),
    gridFills.length,
    'suma fillCount = numarul de fill-uri jurnalizate'
  );
});

test('fees se inchid pe comisioanele jurnalizate, o singura data', () => {
  eq(
    round(sum(fixture.filledOrders.map((o) => o.feeUSDT))),
    bot.totalFeesUSDT,
    'fees din ordine = totalFeesUSDT (nu sunt scazute de doua ori)'
  );
});

test('split-ul captura/iesire e intact, iar identitatea completa tine', () => {
  ok(splitIsIntact(bot.gridProfitUSDT, bot), 'capture + exitCost = gridProfitUSDT');
  eq(legacyGridProfit(bot), bot.gridProfitUSDT, 'agregatul derivat se potriveste');
  eq(
    computeNetPnl(countersFromBot(bot)),
    bot.totalNetPnlUSDT,
    'totalNetPnlUSDT e derivabil din contoare (functiile de productie, pe date reale)'
  );
  eq(round(bot.gridCaptureUSDT + bot.exitCostUSDT), bot.gridProfitUSDT, '0.992 - 1.048 = -0.056');
});

test('verdictul cazului: grila a produs, iesirea a distrus', () => {
  ok(bot.gridCaptureUSDT > 0, 'grila a produs +0.992 din 8 round-trip-uri');
  ok(
    Math.abs(bot.exitCostUSDT) > bot.gridCaptureUSDT,
    "costul iesirii depaseste captura: 1.048 > 0.992 — asta e subiectul real, nu contabilitatea"
  );
  ok(
    bot.avgHoldPrice > closeRow!.price,
    'inventarul a fost lichidat sub cost, la cererea politicii de iesire'
  );
  eq(round(bot.lowerStopPrice), 1.7715, 'SL-ul era la 1.7715: stopul nu a fost de tip SL');
  ok(
    closeRow!.price > bot.lowerStopPrice,
    'ieșirea s-a facut deasupra SL: a fost un stop de stagnare, nu de protectie'
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
