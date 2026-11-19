/**
 * grid-case — extrage un fixture „doar cifre" pentru UN bot Grid, din `.data/`.
 *
 * De ce exista: `AGENTS.md` interzice agentului sa citeasca `.data/` pentru ca in acelasi
 * director sta `okx_credentials.json` (okxApiKey / okxSecretKey / okxPassphrase) plus cheia
 * DeepSeek. Investigarea contabilitatii are insa nevoie de ~10 numere. Deci le proiecteaza
 * acest script, pe care il ruleaza omul, iar rezultatul se commiteaza sub `src/` — exact
 * tiparul deja folosit de `__tests__/fixtures/pnl-2026-11-14.json` ("un extract real, doar
 * cifre, ca testul sa nu depinda de .data/").
 *
 * Ce NU face: nu scrie in `.data/`, nu vorbeste cu OKX, nu atinge trading-ul, nu citeste
 * `okx_credentials.json` sau orice alt nume care nu e in ALLOWED_SOURCES (allow-list, nu
 * blocklist: un nume gresit este respins, nu acceptat din inertie).
 *
 * Ce face in plus: calculeaza verdictul pe loc, din datele extrase — daca `exitCostUSDT` e o
 * masuratoare a unei inchideri reale (exista rand `GRID_STOP_CLOSE_INVENTORY`) sau o derivare
 * de migrare (`gridProfitUSDT - suma arbitrajelor`). Vezi blocul VERDICT din output.
 *
 * Run: npm run grid-case -- mwk05tlp
 */

import fs from 'fs';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), '.data');
const FIXTURE_DIR = path.join(
  process.cwd(),
  'src',
  'server',
  'engine',
  'grid',
  '__tests__',
  'fixtures'
);

/**
 * Singurele fisiere din `.data/` pe care acest script are voie sa le deschida.
 * `okx_credentials.json` nu e in lista si nu poate ajunge in fixture nici prin greseala de
 * tipar: `readStore` arunca daca numele nu e in allow-list.
 */
const ALLOWED_SOURCES = [
  'grid_bots.json',
  'grid_bots_archive.json',
  'grid_arbitrages.json',
  'orders.json',
  'audit.json',
] as const;
type SourceName = (typeof ALLOWED_SOURCES)[number];

const MAX_FILLS = 200;
const MAX_ARBS = 200;
const MAX_AUDIT = 40;

// ---------------------------------------------------------------------------
// Citire (allow-listed) + proiectie (whitelist de campuri, obiect literal nou)
// ---------------------------------------------------------------------------

function readStore<T>(name: SourceName, fallback: T): T {
  if (!(ALLOWED_SOURCES as readonly string[]).includes(name)) {
    throw new Error(`[grid-case] refuz sa citesc "${name}": nu e in ALLOWED_SOURCES`);
  }
  const file = path.join(DATA_DIR, name);
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch (err: any) {
    console.warn(`[grid-case] ${name} nu a putut fi parsat: ${err?.message || err}`);
    return fallback;
  }
}

const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v));
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const r4 = (v: number): number => parseFloat(v.toFixed(4));

function projectBot(bot: any) {
  return {
    botId: str(bot.botId),
    symbol: str(bot.symbol),
    platform: str(bot.platform),
    executionMode: str(bot.executionMode),
    status: str(bot.status),
    stopReason: str(bot.stopReason),
    createdAt: num(bot.createdAt),
    stoppedAt: num(bot.stoppedAt),
    updatedAt: num(bot.updatedAt),
    // Contabilitate — cifrele care se auditeaza
    avgHoldPrice: num(bot.avgHoldPrice),
    netPositionContracts: num(bot.netPositionContracts),
    netPositionSide: str(bot.netPositionSide),
    gridCaptureUSDT: num(bot.gridCaptureUSDT),
    exitCostUSDT: num(bot.exitCostUSDT),
    gridProfitUSDT: num(bot.gridProfitUSDT),
    totalFeesUSDT: num(bot.totalFeesUSDT),
    fundingEstimateUSDT: num(bot.fundingEstimateUSDT),
    floatingPnlUSDT: num(bot.floatingPnlUSDT),
    totalNetPnlUSDT: num(bot.totalNetPnlUSDT),
    completedArbitrages: num(bot.completedArbitrages),
    // Config: doar scalari fara secrete (NeutralGridBotConfig nu contine chei)
    marginInvestedUSDT: num(bot.config?.marginInvestedUSDT),
    leverage: num(bot.config?.leverage),
    gridCount: num(bot.config?.gridCount),
    lowerPrice: num(bot.config?.lowerPrice),
    upperPrice: num(bot.config?.upperPrice),
    lowerStopPrice: num(bot.lowerStopPrice),
    upperStopPrice: num(bot.upperStopPrice),
  };
}

function projectLevel(l: any) {
  return {
    index: num(l.index),
    price: num(l.price),
    side: str(l.side),
    status: str(l.status),
    qtyContracts: num(l.qtyContracts),
    notionalUSDT: num(l.notionalUSDT),
    fillCount: num(l.fillCount),
    lastFilledAt: num(l.lastFilledAt),
    realizedGridProfitUSDT: num(l.realizedGridProfitUSDT),
  };
}

function projectOrder(r: any) {
  return {
    intent: str(r.intent),
    side: str(r.side),
    orderType: str(r.orderType),
    qty: num(r.qty),
    price: num(r.price),
    sizeUSDT: num(r.sizeUSDT),
    feeUSDT: num(r.feeUSDT),
    status: str(r.status),
    gridLevelIndex: num(r.gridLevelIndex),
    createdTime: num(r.createdTime),
    updatedTime: num(r.updatedTime),
  };
}

function projectArb(a: any) {
  return {
    openSide: str(a.openSide),
    openPrice: num(a.openPrice),
    closePrice: num(a.closePrice),
    qtyContracts: num(a.qtyContracts),
    grossProfitUSDT: num(a.grossProfitUSDT),
    feeUSDT: num(a.feeUSDT),
    netProfitUSDT: num(a.netProfitUSDT),
    gridIndex: num(a.gridIndex),
    timestamp: num(a.timestamp),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): number {
  if (!fs.existsSync(DATA_DIR)) {
    console.error(`[grid-case] ${DATA_DIR} nu exista. Ruleaza din radacina repo-ului.`);
    return 1;
  }

  const needle = (process.argv[2] || '').trim().toLowerCase();
  const liveBots = readStore<any[]>('grid_bots.json', []);
  const archived = readStore<Record<string, any>>('grid_bots_archive.json', {});
  const archivedList = Object.values(archived || {});

  const all = [...liveBots, ...archivedList].filter((b) => b && b.botId);

  if (!needle) {
    console.log('[grid-case] Botii disponibili (botId | simbol | status | exitCostUSDT):');
    for (const b of all.slice(0, 40)) {
      console.log(
        `  ${str(b.botId)} | ${str(b.symbol)} | ${str(b.status)} | ${num(b.exitCostUSDT)}`
      );
    }
    console.log('\n  Ruleaza din nou cu un fragment din botId, ex: npm run grid-case -- mwk05tlp');
    return 0;
  }

  const match = (b: any) => str(b.botId).toLowerCase().includes(needle);
  const fromLive = liveBots.find(match);
  const fromArchive = archivedList.find(match);
  const bot = fromLive || fromArchive;

  if (!bot) {
    console.error(`[grid-case] Niciun bot cu botId care sa contina "${needle}".`);
    const hints = all.filter((b) => str(b.botId).toLowerCase().includes(needle.slice(0, 4)));
    if (hints.length) {
      console.error('  Posibile potriviri:');
      for (const b of hints.slice(0, 10)) console.error(`    ${str(b.botId)} | ${str(b.symbol)}`);
    }
    return 1;
  }

  const botId = str(bot.botId);
  const source: string = fromLive ? 'grid_bots.json' : 'grid_bots_archive.json';

  const orders = readStore<any[]>('orders.json', []).filter((r) => str(r?.botId) === botId);
  const arbs = readStore<any[]>('grid_arbitrages.json', []).filter((a) => str(a?.botId) === botId);
  const audit = readStore<any[]>('audit.json', []).filter(
    (a) => str(a?.details?.botId) === botId || str(a?.message).includes(botId)
  );

  const filledOrders = orders.filter((r) => str(r.status) === 'FILLED');
  const closeOrders = filledOrders.filter((r) => str(r.intent) === 'GRID_STOP_CLOSE_INVENTORY');

  const levels = (Array.isArray(bot.levels) ? bot.levels : []).map(projectLevel);
  const levelsByIdle = levels.filter((l) => l.status === 'IDLE');

  // ctVal implicit, derivat din notional/ (pret x contracte) — nu e stocat pe bot, dar fiecare
  // nivel il contine implicit. Daca toate nivelurile dau aceeasi valoare, e ctVal-ul real.
  const impliedCtVals = levels
    .filter((l) => l.notionalUSDT > 0 && l.price > 0 && l.qtyContracts > 0)
    .map((l) => r4(l.notionalUSDT / (l.price * l.qtyContracts)));
  const impliedCtVal = impliedCtVals.length ? impliedCtVals[0] : 0;
  const ctValConsistent = impliedCtVals.every((v) => Math.abs(v - impliedCtVal) <= 1e-6);

  const arbSum = r4(arbs.reduce((s, a) => s + num(a.netProfitUSDT), 0));
  const splitSum = r4(num(bot.gridCaptureUSDT) + num(bot.exitCostUSDT));
  const splitIntact = Math.abs(splitSum - num(bot.gridProfitUSDT)) <= 0.01;
  const exitFromMigration = r4(num(bot.gridProfitUSDT) - arbSum);

  // -------------------------------------------------------------------------
  // Verdict
  // -------------------------------------------------------------------------
  let verdict = '';
  let expectedExit: number | null = null;
  let exitDelta: number | null = null;

  if (closeOrders.length > 0) {
    const close = projectOrder(closeOrders[0]);
    const dir = close.side === 'SELL' ? 1 : -1;
    const ctVal = impliedCtVal > 0 ? impliedCtVal : 1;
    expectedExit = r4((close.price - num(bot.avgHoldPrice)) * close.qty * ctVal * dir);
    exitDelta = r4(expectedExit - num(bot.exitCostUSDT));
    verdict =
      Math.abs(exitDelta) <= 0.01
        ? 'MASURATOARE: exitCostUSDT = o inchidere reala, aritmetica se inchide exact'
        : 'NEconcordanta intre randul de inchidere si exitCostUSDT — investigheaza';
  } else if (Math.abs(exitFromMigration - num(bot.exitCostUSDT)) <= 0.01 && num(bot.exitCostUSDT) !== 0) {
    verdict =
      'DERIVARE: fara rand GRID_STOP_CLOSE_INVENTORY; exitCostUSDT = gridProfitUSDT - suma arbitrajelor (migrare)';
  } else {
    verdict = 'NECONCLUDENT: nici inchidere jurnalizata, nici derivare care sa se potriveasca';
  }

  // -------------------------------------------------------------------------
  // Output uman (numere, nu randuri brute)
  // -------------------------------------------------------------------------
  const line = (k: string, v: unknown) => console.log(`  ${k.padEnd(34)} ${String(v)}`);
  console.log(`\n[grid-case] sursa: ${source}`);
  console.log(`\n  BOT`);
  line('botId', botId);
  line('symbol', str(bot.symbol));
  line('status', str(bot.status));
  line('avgHoldPrice', num(bot.avgHoldPrice));
  line('netPositionContracts', num(bot.netPositionContracts));
  line('gridCaptureUSDT', num(bot.gridCaptureUSDT));
  line('exitCostUSDT', num(bot.exitCostUSDT));
  line('gridProfitUSDT', num(bot.gridProfitUSDT));
  line('completedArbitrages', num(bot.completedArbitrages));
  line('split intact (capture+exit=profit)', splitIntact ? 'DA' : 'NU');
  line('impliedCtVal (din niveluri)', impliedCtVals.length ? `${impliedCtVal}${ctValConsistent ? '' : ' (INCONSISTENT intre niveluri)'}` : 'necunoscut');

  console.log(`\n  NIVELURI  (total ${levels.length}, IDLE ${levelsByIdle.length})`);
  for (const l of levelsByIdle) {
    line(`IDLE #${l.index}`, `${l.side} @ ${l.price} qty=${l.qtyContracts} fills=${l.fillCount}`);
  }

  console.log(`\n  ORDINE FILLED  (${filledOrders.length})`);
  for (const r of filledOrders.slice(0, MAX_FILLS).map(projectOrder)) {
    line(`${r.intent || '?'}`, `${r.side} ${r.qty} @ ${r.price} fee=${r.feeUSDT} L${r.gridLevelIndex}`);
  }

  console.log(`\n  ARBITRAJE  (${arbs.length}, suma netProfitUSDT=${arbSum})`);
  console.log(`\n  VERDICT: ${verdict}`);
  if (expectedExit !== null) {
    line('exitCost asteptat din closeRow', expectedExit);
    line('diferenta fata de exitCostUSDT', exitDelta);
  } else {
    line('exitCost daca ar fi migrare', exitFromMigration);
  }

  // -------------------------------------------------------------------------
  // Fixture
  // -------------------------------------------------------------------------
  const slug = botId.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase().slice(0, 60);
  const dated = new Date().toISOString().slice(0, 10);
  const outFile = path.join(FIXTURE_DIR, `grid-case-${slug}-${dated}.json`);
  const resolvedOut = path.resolve(outFile);
  if (!resolvedOut.startsWith(path.resolve(FIXTURE_DIR) + path.sep)) {
    console.error('[grid-case] refuz sa scriu in afara directorului de fixtures.');
    return 1;
  }

  const fixture = {
    note:
      'Extract doar-cifre din .data/ (grid_bots.json / grid_bots_archive.json, orders.json, ' +
      'grid_arbitrages.json, audit.json). Proiectie whitelist pe campuri numerice; fara chei, ' +
      'fara id-uri de ordine, fara continut brut. Generat de scripts/extract-grid-case.ts.',
    generatedAt: new Date().toISOString(),
    source,
    bot: projectBot(bot),
    derived: {
      impliedCtVal,
      ctValConsistent,
      idleLevelCount: levelsByIdle.length,
      closeRowQty: closeOrders.length ? num(closeOrders[0].qty) : null,
      closeRowPrice: closeOrders.length ? num(closeOrders[0].price) : null,
      closeRowSide: closeOrders.length ? str(closeOrders[0].side) : null,
      arbSumUSDT: arbSum,
      splitSumUSDT: splitSum,
      splitIntact,
      exitCostFromMigration: exitFromMigration,
      exitCostExpectedFromCloseRow: expectedExit,
      exitCostDelta: exitDelta,
      verdict,
    },
    levels,
    filledOrders: filledOrders.slice(0, MAX_FILLS).map(projectOrder),
    filledOrdersTruncated: filledOrders.length > MAX_FILLS,
    arbitrages: arbs.slice(0, MAX_ARBS).map(projectArb),
    arbitragesTruncated: arbs.length > MAX_ARBS,
    auditLines: audit.slice(0, MAX_AUDIT).map((a) => ({
      type: str(a.type),
      message: str(a.message),
      timestamp: num(a.timestamp),
    })),
  };

  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  fs.writeFileSync(resolvedOut, `${JSON.stringify(fixture, null, 2)}\n`, 'utf-8');

  console.log(`\n[grid-case] fixture scris: ${path.relative(process.cwd(), resolvedOut)}`);
  console.log('[grid-case] verifica-l (doar cifre), apoi: git add -A ; git commit -m "test: add grid case fixture"');
  return 0;
}

process.exitCode = main();
