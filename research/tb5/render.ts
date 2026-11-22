/**
 * Renders `report.json` into `report.md` (human readable) — no computation here beyond formatting.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const report = JSON.parse(fs.readFileSync(path.join(HERE, 'report.json'), 'utf8'));

const f = (x: any, d = 2): string => (x === null || x === undefined ? '—' : Number(x).toFixed(d));
const n0 = (x: any): string => (x === null || x === undefined ? '—' : Number(x).toLocaleString('en-US'));
const yn = (b: boolean): string => (b ? 'DA' : 'NU');

const md: string[] = [];
const L = (s = '') => md.push(s);

L('# TB5 `_UM_XPERP` — Raport de cercetare');
L();
L(`Generat: \`${report.generatedAt}\` | Venue: \`${report.venue}\` | Instrumente: ${report.instruments.length}`);
L();
L('> **Surse de date.** OHLCV, funding și OI sunt serii istorice reale de la `eea.okx.com`.');
L('> **Spread-ul și adâncimea order-book sunt un singur snapshot live** la momentul colectării — OKX nu publică istoric de book. Sunt marcate ca atare în fiecare tabel.');
L('> **Funding-ul este la 4h sau 8h** (secțiunea 5 arată intervalul măsurat, nu presupus).');
L();
L('## Sumar executiv');
L();
L('| Instrument | Grid? | Lichiditate | Spread | ATR(1h) | Regim | Motiv principal |');
L('|---|---|---|---|---|---|---|');
for (const i of report.instruments) {
  L(
    `| **${i.short}** | ${yn(i.verdict.tradeableOnGrid)} | $${n0(i.profile.medianDailyUsdVolume)}/zi | ` +
    `${f(i.microstructure.spreadPct, 3)}% | ${f(i.volatility.atrPct1h, 2)}% | ${i.volatility.regime} | ` +
    `${i.verdict.reasons.length ? i.verdict.reasons[0] : '—'} |`
  );
}
L();

for (const i of report.instruments) {
  const v = i.verdict;
  L('---');
  L();
  L(`## ${i.short} — \`${i.instId}\``);
  L();
  L(`### Verdict AUTO-LIMIT grid: ${v.tradeableOnGrid ? '✅ DA' : '❌ NU'}`);
  L();
  L('| Verificare | Rezultat |');
  L('|---|---|');
  L(`| Lichiditate (≥ $50k/zi median) | ${yn(v.checks.liquidityOk)} |`);
  L(`| Spread (≤ 0.5%) | ${yn(v.checks.spreadOk)} |`);
  L(`| Volatilitate ATR(1h) în [0.5%, 15%] | ${yn(v.checks.volatilityOk)} |`);
  L(`| Configurație grid net-pozitivă & accesibilă | ${yn(v.checks.gridViable)} |`);
  L();
  if (v.reasons.length) {
    L(`**Motive de respingere:** ${v.reasons.join('; ')}`);
    L();
  }

  L('### 1. Profil');
  L();
  L('| Câmp | Valoare |');
  L('|---|---|');
  L(`| Preț curent | ${f(i.profile.lastPrice, 6)} |`);
  L(`| Interval preț (zile active) | ${f(i.profile.priceRange?.min, 6)} – ${f(i.profile.priceRange?.max, 6)} |`);
  L(`| Zile de date (total / active / dormante) | ${i.profile.daysOfData} / ${i.profile.activeDays} / ${i.profile.dormantDays} |`);
  L(`| Perioadă | ${i.profile.firstBar} → ${i.profile.lastBar} |`);
  L(`| Volum median zilnic | $${n0(i.profile.medianDailyUsdVolume)} |`);
  L(`| Volum mediu zilnic | $${n0(i.profile.meanDailyUsdVolume)} |`);
  L(`| Volum min / max zilnic | $${n0(i.profile.minDailyUsdVolume)} / $${n0(i.profile.maxDailyUsdVolume)} |`);
  L(`| \`ctVal\` | ${i.profile.contract.ctVal} ${i.profile.contract.ctValCcy} |`);
  L(`| \`tickSz\` / \`lotSz\` / \`minSz\` | ${i.profile.contract.tickSz} / ${i.profile.contract.lotSz} / ${i.profile.contract.minSz} |`);
  L(`| Ticket minim | $${f(i.profile.contract.minTicketUsd, 2)} |`);
  L(`| Levier max / settle | ${i.profile.contract.leverage}× / ${i.profile.contract.settleCcy} |`);
  L(`| \`ruleType\` / expirare | ${i.profile.contract.ruleType} / ${i.profile.contract.expTime} |`);
  L(`| Bare colectate (5m / 15m / 1H / 1D) | ${i.bars['5m']} / ${i.bars['15m']} / ${i.bars['1H']} / ${i.bars['1Dutc']} |`);
  L();

  L('### 2. Volatilitate & regim');
  L();
  L('| Metrică | Valoare |');
  L('|---|---|');
  L(`| ATR(1D) | ${f(i.volatility.atrPct1d, 3)}% |`);
  L(`| ATR(1H) | ${f(i.volatility.atrPct1h, 3)}% |`);
  L(`| ATR(15m) | ${f(i.volatility.atrPct15m, 3)}% |`);
  L(`| Vol realizată close-to-close (1H) | ${f(i.volatility.realizedVol1hPct, 3)}% |`);
  L(`| ATR / vol realizată | ${f(i.volatility.atrVsRealizedVolRatio, 2)}× ${i.volatility.wickDominated ? '⚠️ **dominat de wick-uri**' : ''} |`);
  L(`| Range zilnic median / p90 / max | ${f(i.volatility.medianDailyRangePct, 2)}% / ${f(i.volatility.p90DailyRangePct, 2)}% / ${f(i.volatility.maxDailyRangePct, 2)}% |`);
  L(`| Efficiency Ratio (1H, 24 bare) | ${f(i.volatility.efficiencyRatio1h, 4)} → **${i.volatility.regime}** |`);
  L(`| Zile în creștere | ${f(i.volatility.upDayShare, 1)}% |`);
  L();

  L('### 3. Comportament de preț');
  L();
  L('| Metrică | Valoare |');
  L('|---|---|');
  L(`| Autocorelație lag-1 (1H) | ${f(i.behaviour.autocorr1h, 4)} |`);
  L(`| Autocorelație lag-1 (15m) | ${f(i.behaviour.autocorr15m, 4)} |`);
  L(`| Autocorelație lag-1 (5m) | ${f(i.behaviour.autocorr5m, 4)} |`);
  L(`| Interpretare | ${i.behaviour.interpretation} |`);
  L(`| Traversări ale prețului median / oră | ${f(i.behaviour.midCrossingsPerHour, 3)} |`);
  L();

  L('### 4. Microstructură — ⚠️ SNAPSHOT LIVE, nu serie');
  L();
  L('| Metrică | Valoare |');
  L('|---|---|');
  L(`| Sursă | ${i.microstructure.spreadSource} |`);
  L(`| Spread | ${f(i.microstructure.spreadPct, 4)}% (${i.microstructure.spreadAbs}) |`);
  L(`| Adâncime bid / ask (5 niveluri) | $${n0(i.microstructure.bidDepthUsd5Lvl)} / $${n0(i.microstructure.askDepthUsd5Lvl)} |`);
  L(`| Ticket minim vs volum median | ${f(i.microstructure.minTicketVsMedianVolumePct, 4)}% |`);
  L();

  L('### 5. Funding & carry');
  L();
  const fu = i.funding;
  if (!fu.usable) {
    L(`> ⚠️ **Serie neutilizabilă:** ${fu.usableNote}`);
    L();
  }
  L('| Metrică | Valoare |');
  L('|---|---|');
  L(`| Înregistrări | ${fu.records} |`);
  L(`| Interval măsurat (mediană) | ${f(fu.intervalHours, 1)}h |`);
  L(`| Mediu / median (bps/interval) | ${f(fu.meanBpsPerInterval, 4)} / ${f(fu.medianBpsPerInterval, 4)} |`);
  L(`| p95 pozitiv / p5 negativ | ${f(fu.p95PositiveBps, 4)} / ${f(fu.p5NegativeBps, 4)} |`);
  L(`| Max / min (bps) | ${f(fu.maxBps, 4)} / ${f(fu.minBps, 4)} |`);
  L(`| Annualizat | ${f(fu.annualisedPct, 2)}% |`);
  L(`| Share pozitiv | ${f(fu.positiveShare, 1)}% |`);
  L(`| Schimbări de semn | ${fu.signFlips ?? '—'} |`);
  L(`| Bias carry | ${fu.carryBias} |`);
  L();

  L('### 6. Model de cost');
  L();
  L('| Metrică | Valoare |');
  L('|---|---|');
  L(`| Sursă fee | ${i.costs.feeSource} |`);
  L(`| Maker / Taker | ${i.costs.makerPct}% / ${i.costs.takerPct}% |`);
  L(`| Round-trip maker / taker / mixt | ${i.costs.roundTripMakerPct}% / ${i.costs.roundTripTakerPct}% / ${i.costs.roundTripMixedPct}% |`);
  L(`| Spread live | ${f(i.costs.liveSpreadPct, 4)}% |`);
  L(`| Break-even move (maker / mixt) | ${f(i.costs.breakevenMoveMakerPct, 4)}% / ${f(i.costs.breakevenMoveMixedPct, 4)}% |`);
  L(`| Cost per fill pasiv (maker + spread/2) | ${f(i.gridViability.costPerFillPct, 4)}% |`);
  L(`| Slippage | ${i.costs.slippageAssumption} |`);
  L();

  L('### 7. Viabilitate grid');
  L();
  L(`Bandă: **${f(i.gridViability.bandLow, 6)} – ${f(i.gridViability.bandHigh, 6)}** (lățime ${f(i.gridViability.bandWidthPct, 2)}% din preț), adâncime adversă maximă într-o zi: **${f(i.gridViability.worstSingleDayAdverseExcursionPct, 2)}%**.`);
  L();
  L('*Fills estimate pe bare de 5m. Un round-trip captează un pas și plătește două fill-uri (maker + spread/2 fiecare).*');
  L();
  L('| gridNum | pas % | pas/ATR(1h) | fills/zi | brut/zi % | fee/zi % | **net/zi %** | accesibil | viabil |');
  L('|---:|---:|---:|---:|---:|---:|---:|:--:|:--:|');
  for (const g of i.gridViability.gridRows) {
    L(
      `| ${g.gridNum} | ${f(g.stepPct, 3)} | ${f(g.stepVsAtr1h, 2)} | ${f(g.fillsPerDayEstimate, 1)} | ` +
      `${f(g.grossPerDayPct, 2)} | ${f(g.feesPerDayPct, 2)} | **${f(g.netPerDayPct, 2)}** | ${yn(g.reachable)} | ${yn(g.viable)} |`
    );
  }
  L();
  if (i.gridViability.recommendedGridNum) {
    L(
      `**Recomandat:** \`gridNum=${i.gridViability.recommendedGridNum}\` (pas ${f(i.gridViability.recommendedStepPct, 3)}%, ` +
      `${f(i.gridViability.recommendedFillsPerDay, 1)} fills/zi, net estimat ${f(i.gridViability.recommendedNetPerDayPct, 2)}%/zi).`
    );
  } else {
    L('**Niciun gridNum viabil** — fie pasul nu poate executa, fie profitul net e negativ.');
  }
  L();
  L('> Cifrele „net/zi" sunt **superioare** (assumă fiecare atingere = fill executat integral și zero slippage). Nu sunt un PnL așteptat — sunt un plafon teoretic folosit pentru a compara configurații. Un backtest pe executorul real (`NeutralGridEngine`) rămâne necesar înainte de orice bot live.');
  L();

  L('### 8. Cavete');
  L();
  for (const c of v.caveats) L(`- ${c}`);
  L();
}

L('---');
L();
L('## Metodologie & limite');
L();
L('- **`fillsPerDay`** numără traversări de nivel pe bare de 5m. Nu ține cont de coada din order book (nu există istoric).');
L('- **`netPerDayPct`** = `(fills/2)×pas − fills×costPerFill`. Assumă executare integrală la fiecare nivel atins, 0 slippage.');
L('- **`reachable`** cere pas > spread live și `0.5×ATR ≤ pas ≤ 4×ATR`. Un pas sub spread nu poate executa niciodată.');
L('- **`wickDominated`** semnalează ATR > 2× vol realizată: range-ul e umflat de spike-uri, iar ATR nu descrie mișcarea de close.');
L('- **Funding** cu `min == max == 0.00005` este placeholder de venue și e suprimat, nu anualizat.');
L('- **Spread/depth** = un singur snapshot. Ele pot fi diferite la alte ore și nu pot fi reconstruite istoric.');

// Explicit UTF-8 with BOM: PowerShell's default `Out-File`/redirection on Windows otherwise
// re-encodes ș/ț/ă/î as CP1252 mojibake when the file is piped through a console host.
fs.writeFileSync(path.join(HERE, 'report.md'), '\uFEFF' + md.join('\n'), { encoding: 'utf8' });
console.log(`report.md scris (${md.length} linii)`);
