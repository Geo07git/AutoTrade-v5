# TB5 `_UM_XPERP` — Raport de cercetare

Generat: `2026-11-22T18:20:32.624Z` | Venue: `eea.okx.com` | Instrumente: 5

> **Surse de date.** OHLCV, funding și OI sunt serii istorice reale de la `eea.okx.com`.
> **Spread-ul și adâncimea order-book sunt un singur snapshot live** la momentul colectării — OKX nu publică istoric de book. Sunt marcate ca atare în fiecare tabel.
> **Funding-ul este la 4h sau 8h** (secțiunea 5 arată intervalul măsurat, nu presupus).

## Sumar executiv

| Instrument | Grid? | Lichiditate | Spread | ATR(1h) | Regim | Motiv principal |
|---|---|---|---|---|---|---|
| **ZEC** | DA | $23,881,429/zi | 0.020% | 1.67% | noisy/mean-reverting | — |
| **ENA** | DA | $3,886,475/zi | 0.137% | 1.38% | trending | — |
| **IRYS** | NU | $19,122/zi | 0.208% | 2.96% | noisy/mean-reverting | lichiditate sub $50k/zi (19122) |
| **PIEVERSE** | NU | $16,986/zi | 0.249% | 9.93% | noisy/mean-reverting | lichiditate sub $50k/zi (16986) |
| **CASHCAT** | NU | $83,961/zi | 2.187% | 3.05% | trending | spread 2.187% > 0.5% |

---

## ZEC — `ZEC-USD_UM_XPERP-310530`

### Verdict AUTO-LIMIT grid: ✅ DA

| Verificare | Rezultat |
|---|---|
| Lichiditate (≥ $50k/zi median) | DA |
| Spread (≤ 0.5%) | DA |
| Volatilitate ATR(1h) în [0.5%, 15%] | DA |
| Configurație grid net-pozitivă & accesibilă | DA |

### 1. Profil

| Câmp | Valoare |
|---|---|
| Preț curent | 794.010000 |
| Interval preț (zile active) | 483.630000 – 1696.110000 |
| Zile de date (total / active / dormante) | 100 / 100 / 0 |
| Perioadă | 2026-08-15 → 2026-11-22 |
| Volum median zilnic | $23,881,429 |
| Volum mediu zilnic | $25,949,087 |
| Volum min / max zilnic | $1,064,198 / $60,422,542 |
| `ctVal` | 0.01 ZEC |
| `tickSz` / `lotSz` / `minSz` | 0.01 / 1 / 1 |
| Ticket minim | $7.94 |
| Levier max / settle | 50× / USD |
| `ruleType` / expirare | xperp / 2031-05-30 |
| Bare colectate (5m / 15m / 1H / 1D) | 27400 / 9200 / 2300 / 100 |

### 2. Volatilitate & regim

| Metrică | Valoare |
|---|---|
| ATR(1D) | 11.062% |
| ATR(1H) | 1.673% |
| ATR(15m) | 0.667% |
| Vol realizată close-to-close (1H) | 1.272% |
| ATR / vol realizată | 1.32×  |
| Range zilnic median / p90 / max | 8.98% / 17.75% / 24.25% |
| Efficiency Ratio (1H, 24 bare) | 0.0716 → **noisy/mean-reverting** |
| Zile în creștere | 51.5% |

### 3. Comportament de preț

| Metrică | Valoare |
|---|---|
| Autocorelație lag-1 (1H) | 0.0262 |
| Autocorelație lag-1 (15m) | 0.0075 |
| Autocorelație lag-1 (5m) | -0.0278 |
| Interpretare | close to random walk |
| Traversări ale prețului median / oră | 0.010 |

### 4. Microstructură — ⚠️ SNAPSHOT LIVE, nu serie

| Metrică | Valoare |
|---|---|
| Sursă | LIVE SNAPSHOT at collection — OKX has NO historical book |
| Spread | 0.0201% (0.15999999999996817) |
| Adâncime bid / ask (5 niveluri) | $320,435 / $322,288 |
| Ticket minim vs volum median | 0.0000% |

### 5. Funding & carry

| Metrică | Valoare |
|---|---|
| Înregistrări | 100 |
| Interval măsurat (mediană) | 8.0h |
| Mediu / median (bps/interval) | 0.9167 / 1.0000 |
| p95 pozitiv / p5 negativ | 1.0000 / -0.6206 |
| Max / min (bps) | 10.5304 / -3.1473 |
| Annualizat | 10.04% |
| Share pozitiv | 88.0% |
| Schimbări de semn | 11 |
| Bias carry | longs pay (crowded long) |

### 6. Model de cost

| Metrică | Valoare |
|---|---|
| Sursă fee | live account tier Lv1 (maker 0.02% / taker 0.05%) |
| Maker / Taker | 0.02% / 0.05% |
| Round-trip maker / taker / mixt | 0.04% / 0.1% / 0.07% |
| Spread live | 0.0201% |
| Break-even move (maker / mixt) | 0.0501% / 0.0801% |
| Cost per fill pasiv (maker + spread/2) | 0.0301% |
| Slippage | not modelled (no book history) — treat as 0, add manually if depth is thin |

### 7. Viabilitate grid

Bandă: **752.560000 – 1533.400000** (lățime 98.34% din preț), adâncime adversă maximă într-o zi: **18.88%**.

*Fills estimate pe bare de 5m. Un round-trip captează un pas și plătește două fill-uri (maker + spread/2 fiecare).*

| gridNum | pas % | pas/ATR(1h) | fills/zi | brut/zi % | fee/zi % | **net/zi %** | accesibil | viabil |
|---:|---:|---:|---:|---:|---:|---:|:--:|:--:|
| 10 | 9.834 | 5.88 | 0.8 | 4.13 | 0.03 | **4.11** | NU | NU |
| 20 | 4.917 | 2.94 | 3.0 | 7.47 | 0.09 | **7.38** | DA | DA |
| 30 | 3.278 | 1.96 | 7.1 | 11.61 | 0.21 | **11.40** | DA | DA |
| 50 | 1.967 | 1.18 | 18.7 | 18.35 | 0.56 | **17.79** | DA | DA |

**Recomandat:** `gridNum=50` (pas 1.967%, 18.7 fills/zi, net estimat 17.79%/zi).

> Cifrele „net/zi" sunt **superioare** (assumă fiecare atingere = fill executat integral și zero slippage). Nu sunt un PnL așteptat — sunt un plafon teoretic folosit pentru a compara configurații. Un backtest pe executorul real (`NeutralGridEngine`) rămâne necesar înainte de orice bot live.

### 8. Cavete

- spread/depth = snapshot live, nu serie istorica
- istoric limitat la 100 zile active

---

## ENA — `ENA-USD_UM_XPERP-310613`

### Verdict AUTO-LIMIT grid: ✅ DA

| Verificare | Rezultat |
|---|---|
| Lichiditate (≥ $50k/zi median) | DA |
| Spread (≤ 0.5%) | DA |
| Volatilitate ATR(1h) în [0.5%, 15%] | DA |
| Configurație grid net-pozitivă & accesibilă | DA |

### 1. Profil

| Câmp | Valoare |
|---|---|
| Preț curent | 0.102260 |
| Interval preț (zile active) | 0.081040 – 0.294670 |
| Zile de date (total / active / dormante) | 100 / 100 / 0 |
| Perioadă | 2026-08-15 → 2026-11-22 |
| Volum median zilnic | $3,886,475 |
| Volum mediu zilnic | $4,389,033 |
| Volum min / max zilnic | $314,303 / $19,843,935 |
| `ctVal` | 100 ENA |
| `tickSz` / `lotSz` / `minSz` | 0.00001 / 1 / 1 |
| Ticket minim | $10.23 |
| Levier max / settle | 20× / USD |
| `ruleType` / expirare | xperp / 2031-06-13 |
| Bare colectate (5m / 15m / 1H / 1D) | 27400 / 9200 / 2300 / 100 |

### 2. Volatilitate & regim

| Metrică | Valoare |
|---|---|
| ATR(1D) | 9.826% |
| ATR(1H) | 1.378% |
| ATR(15m) | 0.582% |
| Vol realizată close-to-close (1H) | 1.460% |
| ATR / vol realizată | 0.94×  |
| Range zilnic median / p90 / max | 9.77% / 18.93% / 27.81% |
| Efficiency Ratio (1H, 24 bare) | 0.3965 → **trending** |
| Zile în creștere | 51.5% |

### 3. Comportament de preț

| Metrică | Valoare |
|---|---|
| Autocorelație lag-1 (1H) | -0.0061 |
| Autocorelație lag-1 (15m) | -0.0094 |
| Autocorelație lag-1 (5m) | -0.0364 |
| Interpretare | close to random walk |
| Traversări ale prețului median / oră | 0.020 |

### 4. Microstructură — ⚠️ SNAPSHOT LIVE, nu serie

| Metrică | Valoare |
|---|---|
| Sursă | LIVE SNAPSHOT at collection — OKX has NO historical book |
| Spread | 0.1371% (0.00014000000000000123) |
| Adâncime bid / ask (5 niveluri) | $19 / $30 |
| Ticket minim vs volum median | 0.0003% |

### 5. Funding & carry

| Metrică | Valoare |
|---|---|
| Înregistrări | 100 |
| Interval măsurat (mediană) | 8.0h |
| Mediu / median (bps/interval) | 0.9081 / 1.0000 |
| p95 pozitiv / p5 negativ | 1.0000 / 0.1054 |
| Max / min (bps) | 1.0000 / -0.2916 |
| Annualizat | 9.94% |
| Share pozitiv | 96.0% |
| Schimbări de semn | 6 |
| Bias carry | longs pay (crowded long) |

### 6. Model de cost

| Metrică | Valoare |
|---|---|
| Sursă fee | live account tier Lv1 (maker 0.02% / taker 0.05%) |
| Maker / Taker | 0.02% / 0.05% |
| Round-trip maker / taker / mixt | 0.04% / 0.1% / 0.07% |
| Spread live | 0.1371% |
| Break-even move (maker / mixt) | 0.1086% / 0.1386% |
| Cost per fill pasiv (maker + spread/2) | 0.0886% |
| Slippage | not modelled (no book history) — treat as 0, add manually if depth is thin |

### 7. Viabilitate grid

Bandă: **0.107350 – 0.247170** (lățime 136.73% din preț), adâncime adversă maximă într-o zi: **18.21%**.

*Fills estimate pe bare de 5m. Un round-trip captează un pas și plătește două fill-uri (maker + spread/2 fiecare).*

| gridNum | pas % | pas/ATR(1h) | fills/zi | brut/zi % | fee/zi % | **net/zi %** | accesibil | viabil |
|---:|---:|---:|---:|---:|---:|---:|:--:|:--:|
| 10 | 13.673 | 9.93 | 0.8 | 5.46 | 0.07 | **5.39** | NU | NU |
| 20 | 6.836 | 4.96 | 3.0 | 10.28 | 0.27 | **10.01** | NU | NU |
| 30 | 4.558 | 3.31 | 6.6 | 15.09 | 0.59 | **14.50** | DA | DA |
| 50 | 2.735 | 1.99 | 17.3 | 23.63 | 1.53 | **22.10** | DA | DA |

**Recomandat:** `gridNum=50` (pas 2.735%, 17.3 fills/zi, net estimat 22.10%/zi).

> Cifrele „net/zi" sunt **superioare** (assumă fiecare atingere = fill executat integral și zero slippage). Nu sunt un PnL așteptat — sunt un plafon teoretic folosit pentru a compara configurații. Un backtest pe executorul real (`NeutralGridEngine`) rămâne necesar înainte de orice bot live.

### 8. Cavete

- spread/depth = snapshot live, nu serie istorica
- istoric limitat la 100 zile active

---

## IRYS — `IRYS-USD_UM_XPERP-310530`

### Verdict AUTO-LIMIT grid: ❌ NU

| Verificare | Rezultat |
|---|---|
| Lichiditate (≥ $50k/zi median) | NU |
| Spread (≤ 0.5%) | DA |
| Volatilitate ATR(1h) în [0.5%, 15%] | DA |
| Configurație grid net-pozitivă & accesibilă | DA |

**Motive de respingere:** lichiditate sub $50k/zi (19122)

### 1. Profil

| Câmp | Valoare |
|---|---|
| Preț curent | 0.019220 |
| Interval preț (zile active) | 0.011790 – 0.376070 |
| Zile de date (total / active / dormante) | 100 / 100 / 0 |
| Perioadă | 2026-08-15 → 2026-11-22 |
| Volum median zilnic | $19,122 |
| Volum mediu zilnic | $1,152,541 |
| Volum min / max zilnic | $38 / $46,740,845 |
| `ctVal` | 100 IRYS |
| `tickSz` / `lotSz` / `minSz` | 0.00001 / 1 / 1 |
| Ticket minim | $1.92 |
| Levier max / settle | 20× / USD |
| `ruleType` / expirare | xperp / 2031-05-30 |
| Bare colectate (5m / 15m / 1H / 1D) | 27400 / 9200 / 2300 / 100 |

### 2. Volatilitate & regim

| Metrică | Valoare |
|---|---|
| ATR(1D) | 20.962% |
| ATR(1H) | 2.956% |
| ATR(15m) | 0.932% |
| Vol realizată close-to-close (1H) | 3.147% |
| ATR / vol realizată | 0.94×  |
| Range zilnic median / p90 / max | 6.67% / 27.83% / 467.97% |
| Efficiency Ratio (1H, 24 bare) | 0.0121 → **noisy/mean-reverting** |
| Zile în creștere | 46.5% |

### 3. Comportament de preț

| Metrică | Valoare |
|---|---|
| Autocorelație lag-1 (1H) | 0.0791 |
| Autocorelație lag-1 (15m) | 0.1825 |
| Autocorelație lag-1 (5m) | -0.0094 |
| Interpretare | momentum (grid risks trend losses) |
| Traversări ale prețului median / oră | 0.000 |

### 4. Microstructură — ⚠️ SNAPSHOT LIVE, nu serie

| Metrică | Valoare |
|---|---|
| Sursă | LIVE SNAPSHOT at collection — OKX has NO historical book |
| Spread | 0.2084% (0.00004000000000000184) |
| Adâncime bid / ask (5 niveluri) | $21 / $21 |
| Ticket minim vs volum median | 0.0100% |

### 5. Funding & carry

| Metrică | Valoare |
|---|---|
| Înregistrări | 100 |
| Interval măsurat (mediană) | 4.0h |
| Mediu / median (bps/interval) | -10.0377 / 0.5000 |
| p95 pozitiv / p5 negativ | 0.5000 / -64.7341 |
| Max / min (bps) | 0.5000 / -100.0000 |
| Annualizat | -219.83% |
| Share pozitiv | 65.0% |
| Schimbări de semn | 3 |
| Bias carry | shorts pay (crowded short) |

### 6. Model de cost

| Metrică | Valoare |
|---|---|
| Sursă fee | live account tier Lv1 (maker 0.02% / taker 0.05%) |
| Maker / Taker | 0.02% / 0.05% |
| Round-trip maker / taker / mixt | 0.04% / 0.1% / 0.07% |
| Spread live | 0.2084% |
| Break-even move (maker / mixt) | 0.1442% / 0.1742% |
| Cost per fill pasiv (maker + spread/2) | 0.1242% |
| Slippage | not modelled (no book history) — treat as 0, add manually if depth is thin |

### 7. Viabilitate grid

Bandă: **0.012980 – 0.024150** (lățime 58.12% din preț), adâncime adversă maximă într-o zi: **47.42%**.

*Fills estimate pe bare de 5m. Un round-trip captează un pas și plătește două fill-uri (maker + spread/2 fiecare).*

| gridNum | pas % | pas/ATR(1h) | fills/zi | brut/zi % | fee/zi % | **net/zi %** | accesibil | viabil |
|---:|---:|---:|---:|---:|---:|---:|:--:|:--:|
| 10 | 5.812 | 1.97 | 1.8 | 5.28 | 0.23 | **5.06** | DA | DA |
| 20 | 2.906 | 0.98 | 5.6 | 8.15 | 0.70 | **7.46** | DA | DA |
| 30 | 1.937 | 0.66 | 11.1 | 10.77 | 1.38 | **9.39** | DA | DA |
| 50 | 1.162 | 0.39 | 24.0 | 13.93 | 2.98 | **10.95** | NU | NU |

**Recomandat:** `gridNum=20` (pas 2.906%, 5.6 fills/zi, net estimat 7.46%/zi).

> Cifrele „net/zi" sunt **superioare** (assumă fiecare atingere = fill executat integral și zero slippage). Nu sunt un PnL așteptat — sunt un plafon teoretic folosit pentru a compara configurații. Un backtest pe executorul real (`NeutralGridEngine`) rămâne necesar înainte de orice bot live.

### 8. Cavete

- spread/depth = snapshot live, nu serie istorica
- istoric limitat la 100 zile active

---

## PIEVERSE — `PIEVERSE-USD_UM_XPERP-310822`

### Verdict AUTO-LIMIT grid: ❌ NU

| Verificare | Rezultat |
|---|---|
| Lichiditate (≥ $50k/zi median) | NU |
| Spread (≤ 0.5%) | DA |
| Volatilitate ATR(1h) în [0.5%, 15%] | DA |
| Configurație grid net-pozitivă & accesibilă | NU |

**Motive de respingere:** lichiditate sub $50k/zi (16986); nicio configuratie de grid net-pozitiva si accesibila cu >=1 fill/zi

### 1. Profil

| Câmp | Valoare |
|---|---|
| Preț curent | 3.668800 |
| Interval preț (zile active) | 0.845200 – 5.389500 |
| Zile de date (total / active / dormante) | 98 / 98 / 0 |
| Perioadă | 2026-08-17 → 2026-11-22 |
| Volum median zilnic | $16,986 |
| Volum mediu zilnic | $449,793 |
| Volum min / max zilnic | $73 / $11,909,824 |
| `ctVal` | 10 PIEVERSE |
| `tickSz` / `lotSz` / `minSz` | 0.0001 / 1 / 1 |
| Ticket minim | $36.69 |
| Levier max / settle | 20× / USD |
| `ruleType` / expirare | xperp / 2031-08-22 |
| Bare colectate (5m / 15m / 1H / 1D) | 27400 / 9200 / 2300 / 98 |

### 2. Volatilitate & regim

| Metrică | Valoare |
|---|---|
| ATR(1D) | 21.012% |
| ATR(1H) | 9.925% |
| ATR(15m) | 6.178% |
| Vol realizată close-to-close (1H) | 1.984% |
| ATR / vol realizată | 5.00× ⚠️ **dominat de wick-uri** |
| Range zilnic median / p90 / max | 5.81% / 20.32% / 72.33% |
| Efficiency Ratio (1H, 24 bare) | 0.0638 → **noisy/mean-reverting** |
| Zile în creștere | 51.5% |

### 3. Comportament de preț

| Metrică | Valoare |
|---|---|
| Autocorelație lag-1 (1H) | 0.0704 |
| Autocorelație lag-1 (15m) | -0.0164 |
| Autocorelație lag-1 (5m) | -0.0122 |
| Interpretare | close to random walk |
| Traversări ale prețului median / oră | 0.000 |

### 4. Microstructură — ⚠️ SNAPSHOT LIVE, nu serie

| Metrică | Valoare |
|---|---|
| Sursă | LIVE SNAPSHOT at collection — OKX has NO historical book |
| Spread | 0.2489% (0.009199999999999875) |
| Adâncime bid / ask (5 niveluri) | $675 / $267 |
| Ticket minim vs volum median | 0.2160% |

### 5. Funding & carry

| Metrică | Valoare |
|---|---|
| Înregistrări | 100 |
| Interval măsurat (mediană) | 4.0h |
| Mediu / median (bps/interval) | 0.5171 / 0.5000 |
| p95 pozitiv / p5 negativ | 0.5000 / 0.5000 |
| Max / min (bps) | 2.2067 / 0.5000 |
| Annualizat | 11.32% |
| Share pozitiv | 100.0% |
| Schimbări de semn | 0 |
| Bias carry | longs pay (crowded long) |

### 6. Model de cost

| Metrică | Valoare |
|---|---|
| Sursă fee | live account tier Lv1 (maker 0.02% / taker 0.05%) |
| Maker / Taker | 0.02% / 0.05% |
| Round-trip maker / taker / mixt | 0.04% / 0.1% / 0.07% |
| Spread live | 0.2489% |
| Break-even move (maker / mixt) | 0.1645% / 0.1945% |
| Cost per fill pasiv (maker + spread/2) | 0.1445% |
| Slippage | not modelled (no book history) — treat as 0, add manually if depth is thin |

### 7. Viabilitate grid

Bandă: **0.977600 – 2.037100** (lățime 28.88% din preț), adâncime adversă maximă într-o zi: **33.24%**.

*Fills estimate pe bare de 5m. Un round-trip captează un pas și plătește două fill-uri (maker + spread/2 fiecare).*

| gridNum | pas % | pas/ATR(1h) | fills/zi | brut/zi % | fee/zi % | **net/zi %** | accesibil | viabil |
|---:|---:|---:|---:|---:|---:|---:|:--:|:--:|
| 10 | 2.888 | 0.29 | 0.8 | 1.21 | 0.12 | **1.09** | NU | NU |
| 20 | 1.444 | 0.15 | 2.8 | 1.99 | 0.40 | **1.59** | NU | NU |
| 30 | 0.963 | 0.10 | 5.0 | 2.42 | 0.73 | **1.69** | NU | NU |
| 50 | 0.578 | 0.06 | 11.2 | 3.24 | 1.62 | **1.62** | NU | NU |

**Niciun gridNum viabil** — fie pasul nu poate executa, fie profitul net e negativ.

> Cifrele „net/zi" sunt **superioare** (assumă fiecare atingere = fill executat integral și zero slippage). Nu sunt un PnL așteptat — sunt un plafon teoretic folosit pentru a compara configurații. Un backtest pe executorul real (`NeutralGridEngine`) rămâne necesar înainte de orice bot live.

### 8. Cavete

- spread/depth = snapshot live, nu serie istorica
- istoric limitat la 98 zile active

---

## CASHCAT — `CASHCAT-USD_UM_XPERP-310926`

### Verdict AUTO-LIMIT grid: ❌ NU

| Verificare | Rezultat |
|---|---|
| Lichiditate (≥ $50k/zi median) | DA |
| Spread (≤ 0.5%) | NU |
| Volatilitate ATR(1h) în [0.5%, 15%] | DA |
| Configurație grid net-pozitivă & accesibilă | DA |

**Motive de respingere:** spread 2.187% > 0.5%

### 1. Profil

| Câmp | Valoare |
|---|---|
| Preț curent | 0.043900 |
| Interval preț (zile active) | 0.034140 – 0.202100 |
| Zile de date (total / active / dormante) | 61 / 61 / 0 |
| Perioadă | 2026-09-23 → 2026-11-22 |
| Volum median zilnic | $83,961 |
| Volum mediu zilnic | $168,805 |
| Volum min / max zilnic | $1,999 / $1,984,973 |
| `ctVal` | 10 CASHCAT |
| `tickSz` / `lotSz` / `minSz` | 0.00001 / 1 / 1 |
| Ticket minim | $0.44 |
| Levier max / settle | 20× / USD |
| `ruleType` / expirare | xperp / 2031-09-26 |
| Bare colectate (5m / 15m / 1H / 1D) | 17382 / 5794 / 1450 / 61 |

### 2. Volatilitate & regim

| Metrică | Valoare |
|---|---|
| ATR(1D) | 16.124% |
| ATR(1H) | 3.051% |
| ATR(15m) | 1.638% |
| Vol realizată close-to-close (1H) | 2.036% |
| ATR / vol realizată | 1.50×  |
| Range zilnic median / p90 / max | 12.60% / 21.42% / 29.40% |
| Efficiency Ratio (1H, 24 bare) | 0.3687 → **trending** |
| Zile în creștere | 41.7% |

### 3. Comportament de preț

| Metrică | Valoare |
|---|---|
| Autocorelație lag-1 (1H) | -0.0469 |
| Autocorelație lag-1 (15m) | -0.0404 |
| Autocorelație lag-1 (5m) | -0.0054 |
| Interpretare | mean-reverting (favours grid) |
| Traversări ale prețului median / oră | 0.020 |

### 4. Microstructură — ⚠️ SNAPSHOT LIVE, nu serie

| Metrică | Valoare |
|---|---|
| Sursă | LIVE SNAPSHOT at collection — OKX has NO historical book |
| Spread | 2.1868% (0.0009600000000000025) |
| Adâncime bid / ask (5 niveluri) | $68 / $1 |
| Ticket minim vs volum median | 0.0005% |

### 5. Funding & carry

> ⚠️ **Serie neutilizabilă:** rate is a flat venue placeholder (0.5 bps constant) — NOT real funding; stats suppressed

| Metrică | Valoare |
|---|---|
| Înregistrări | 100 |
| Interval măsurat (mediană) | 4.0h |
| Mediu / median (bps/interval) | — / — |
| p95 pozitiv / p5 negativ | — / — |
| Max / min (bps) | — / — |
| Annualizat | —% |
| Share pozitiv | —% |
| Schimbări de semn | — |
| Bias carry | unknown (placeholder series) |

### 6. Model de cost

| Metrică | Valoare |
|---|---|
| Sursă fee | live account tier Lv1 (maker 0.02% / taker 0.05%) |
| Maker / Taker | 0.02% / 0.05% |
| Round-trip maker / taker / mixt | 0.04% / 0.1% / 0.07% |
| Spread live | 2.1868% |
| Break-even move (maker / mixt) | 1.1334% / 1.1634% |
| Cost per fill pasiv (maker + spread/2) | 1.1134% |
| Slippage | not modelled (no book history) — treat as 0, add manually if depth is thin |

### 7. Viabilitate grid

Bandă: **0.040620 – 0.181700** (lățime 321.37% din preț), adâncime adversă maximă într-o zi: **21.84%**.

*Fills estimate pe bare de 5m. Un round-trip captează un pas și plătește două fill-uri (maker + spread/2 fiecare).*

| gridNum | pas % | pas/ATR(1h) | fills/zi | brut/zi % | fee/zi % | **net/zi %** | accesibil | viabil |
|---:|---:|---:|---:|---:|---:|---:|:--:|:--:|
| 10 | 32.137 | 10.53 | 0.4 | 7.19 | 0.50 | **6.69** | NU | NU |
| 20 | 16.068 | 5.27 | 1.5 | 11.98 | 1.66 | **10.32** | NU | NU |
| 30 | 10.712 | 3.51 | 2.8 | 15.26 | 3.17 | **12.09** | DA | DA |
| 50 | 6.427 | 2.11 | 6.8 | 21.72 | 7.53 | **14.20** | DA | DA |

**Recomandat:** `gridNum=50` (pas 6.427%, 6.8 fills/zi, net estimat 14.20%/zi).

> Cifrele „net/zi" sunt **superioare** (assumă fiecare atingere = fill executat integral și zero slippage). Nu sunt un PnL așteptat — sunt un plafon teoretic folosit pentru a compara configurații. Un backtest pe executorul real (`NeutralGridEngine`) rămâne necesar înainte de orice bot live.

### 8. Cavete

- spread/depth = snapshot live, nu serie istorica
- istoric limitat la 61 zile active

---

## Metodologie & limite

- **`fillsPerDay`** numără traversări de nivel pe bare de 5m. Nu ține cont de coada din order book (nu există istoric).
- **`netPerDayPct`** = `(fills/2)×pas − fills×costPerFill`. Assumă executare integrală la fiecare nivel atins, 0 slippage.
- **`reachable`** cere pas > spread live și `0.5×ATR ≤ pas ≤ 4×ATR`. Un pas sub spread nu poate executa niciodată.
- **`wickDominated`** semnalează ATR > 2× vol realizată: range-ul e umflat de spike-uri, iar ATR nu descrie mișcarea de close.
- **Funding** cu `min == max == 0.00005` este placeholder de venue și e suprimat, nu anualizat.
- **Spread/depth** = un singur snapshot. Ele pot fi diferite la alte ore și nu pot fi reconstruite istoric.