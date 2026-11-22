# TB5 — Faza 2: Exploatarea mișcărilor intraday

**Întrebarea:** după ce o mișcare a început deja, mai rămâne edge capturabil — fără să ghicești minimul sau maximul?

**Răspuns scurt: nu, nu pe aceste cinci instrumente și nu cu costurile OKX actuale.**
Nu există **niciun** semnal cu eșantion ≥100 care să fie pozitiv net în toate cele trei subperioade. Continuarea după impuls e, statistic, o aruncare de monedă (43–49% continuare vs 38–48% inversare), iar costul rund-trip de 0.15–0.40% este de același ordin cu tot edge-ul brut disponibil.

Ce urmează nu e o opinie: fiecare cifră are comanda care o reproduce.

---

## 1. Metodă și contract anti-look-ahead

| Element | Valoare |
|---|---|
| Bare | 5m, 27.400 bare/instrument (~95 zile), CASHCAT 17.382 (~61 zile) |
| Fereastră impuls | W = 12 bare = 1h, **exclusiv în urmă** |
| Amplitudini testate | 0.5%, 1%, 2%, 3%, 5% |
| Orizonturi | 15 / 30 / 60 / 120 / 240 min |
| Întârzieri de intrare | 0 / 1 / 2 / 3 bare după confirmare |
| Barieră first-touch | ±0.5% (favorabil vs advers) |
| Cost rund-trip | fee taker 0.05%×2 = **0.10%** |
| Scenariu slippage | **bază 0.05%** → cost 0.15% · **pesimist 0.30%** → cost 0.40% |
| Prag eșantion | n < 30 = „eșantion insuficient" |

**Contractul, impus prin construcție:**
- predicatele de semnal citesc doar indici ≤ t (ferestre `[t-W..t]` sau `[t-W..t-1]`);
- prețul de intrare este **open-ul unei bare strict ulterioare** semnalului (`open[t+1+delay]`);
- evenimentele al căror orizont complet depășește sfârșitul seriei sunt **eliminate**, nu trunchiate;
- ambiguitatea intrabar (bariera favorabilă și cea adversă atinse în aceeași lumânare) e rezolvată **pesimist**, în favoarea adversă.

**Test de concentrare (obligatoriu, altfel rezultatele mint).** Media singură poate fi produsă de 3 tranzacții. Fiecare candidat e re-rulat cu `diag.ts`, care adaugă un filtru de **non-suprapunere** (două intrări mai apropiate de un orizont sunt aceeași tranzacție numărată de două ori) și raportează distribuția completă plus contribuția primelor 5 evenimente.

---

## 2. Constatări globale (înainte de a coborî pe instrument)

### 2.1 Zero semnale robuste

Interogarea decisivă peste toate cele 2.200 de rânduri (n ≥ 100, delay 0, orizont 60m, pozitiv în toate cele 3 subperioade):

```
Total semnale n>=100 pozitive in toate cele 3 perioade: 0
```

### 2.2 Continuare vs inversare = aruncare de monedă

Probabilitatea de a atinge +0.5% înainte de −0.5% stă în 43–49%, iar inversarea în 38–48%. Diferența nu compensează nici măcar fee-ul, darămite slippage-ul.

### 2.3 Asimetrie sistematică LONG > SHORT

Media netă per instrument, toate semnalele cu n ≥ 100 (delay 0, 60m, cost bază):

| Instrument | LONG | SHORT |
|---|---:|---:|
| ZEC | −0.144% | −0.209% |
| ENA | −0.124% | −0.163% |
| IRYS | +0.520% | −0.325% |
| PIEVERSE | −0.100% | −0.300% |
| CASHCAT | −0.372% | **−0.078%** |

**Short-ul pe slăbiciune pierde la 4 din 5** — prețul reboundează. CASHCAT e excepția (era în trend descendent), dar acolo long-ul pierde mai rău. O strategie short-only ar fi fost cea mai proastă alegere pe acest eșantion.

### 2.4 Gradientul amplitudinii e INVERS (mean-reversion, nu momentum)

Randament brut la 60m, LONG după impuls up, delay 0:

| Instrument | 0.5% | 1% | 2% | 3% | 5% |
|---|---:|---:|---:|---:|---:|
| ZEC | +0.031 | +0.041 | +0.007 | +0.017 | **−0.322** |
| ENA | −0.021 | +0.089 | +0.076 | +0.053 | **−0.210** |
| IRYS | +0.038 | +0.072 | +0.098 | +1.021 | **+2.542** |
| PIEVERSE | +0.116 | +0.035 | +0.095 | −0.023 | **−0.286** |
| CASHCAT | −0.142 | −0.202 | −0.193 | −0.426 | +0.214 |

La ZEC, ENA, PIEVERSE, **cu cât impulsul e mai mare, cu atât continuarea e mai proastă**. Un +5% nu e semnal de cumpărare — e semnal de epuizare. IRYS e singura excepție și, cum arăt mai jos, e o singură pompă de listare.

### 2.5 Fereastra de intrare e scurtă, dar suficientă

Median, câte minute rămâne valabilă condiția după trigger:

| Instrument | 0.5% | 1% | 2% | 3% | 5% |
|---|---:|---:|---:|---:|---:|
| ZEC | 15m | 15m | 10m | 10m | 15m |
| ENA | 15m | 15m | 10m | 10m | 15m |
| IRYS | 25m | 15m | 10m | 15m | 15m |
| PIEVERSE | 60m | 45m | 25m | 15m | 15m |
| CASHCAT | 35m | 30m | 25m | 20m | 15m |

**Timpul nu e problema.** Ai 10–15 minute să intri. Problema e că intrarea nu e profitabilă.

### 2.6 Întârzierea nu ajută

`impulse_up_1`, net bază la 60m, pe întârzieri 0→3 bare: ZEC −0.109→−0.134, ENA −0.061→−0.041, PIEVERSE −0.115→−0.096, CASHCAT −0.352→−0.293. Variația e zgomot, nu semnal. Nu există „mai bine intru mai târziu".

---

## 3. Pe instrument

### 3.1 ZEC — lichid ($23.9M/zi), cel mai curat eșantion

| # | Comportament | n | Brut 60m | Net bază | Net pesimist | Perioade |
|---|---|---:|---:|---:|---|
| 1 | `breakout_up` (rupere 1h) nu se susține | 1221 | +0.072% | −0.078% | −0.328% | +0.02 / −0.00 / −0.28 |
| 2 | `impulse_up_1` continuă prea puțin ca să plătească | 1355 | +0.041% | −0.109% | −0.359% | −0.03 / −0.04 / −0.26 |
| 3 | Impulsul de 5% se **întoarce** | 35 | −0.322% | −0.472% | −0.722% | — |
| 4 | `volspike_up` = zero brut | 605 | +0.014% | −0.136% | −0.386% | −0.07 / −0.06 / −0.28 |
| 5 | Short pe scădere = pierdere (rebound) | 137 | −0.128% | −0.278% | −0.528% | — |

Distribuția completă pentru #2 (n=1355, non-suprapunere, cost 0.40%): media −0.359%, **mediana −0.453%**, win rate **33.4%**, p10 −1.84%. Fără primele 5 evenimente: −0.387%. **Nu e concentrat — pur și simplu pierde.**

Exemplu concret (#1, rupere în sus):
```
2026-08-19 16:55  intrare 557.68 -> ieșire 552.30  brut -0.965%  net -1.365% (pesimist)
                 MFE +0.23%  MAE -2.38%   <- a mers imediat împotrivă
```

### 3.2 ENA — lichid pe hârtie ($3.9M/zi), dar book de $19/$30

| # | Comportament | n | Brut 60m | Net bază | Perioade |
|---|---|---:|---:|---|
| 1 | `impulse_up_1` — cel mai bun, tot negativ | 1537 | +0.089% | −0.061% | +0.04 / −0.05 / −0.19 |
| 2 | `volspike_up` — brut **negativ** (fade candidat) | 604 | −0.112% | −0.262% | — |
| 3 | Impuls 5% se întoarce | 66 | −0.210% | −0.360% | — |
| 4 | `pullback_up_0.5` fără edge | 1885 | +0.046% | −0.104% | +0.04 / −0.23 / −0.21 |
| 5 | Short pe scădere pierde | 182 | −0.061% | −0.211% | — |

**Avertisment care nu apare în statistici:** adâncimea top-of-book măsurată era **$19 bid / $30 ask**. Modelul de slippage de 0.30% e deja prea optimist pentru un ordin de $100. ENA trece filtrele cantitative și rămâne netranzacționabilă.

### 3.3 IRYS — capcana statistică a eșantionului

Arată cel mai bine din tot raportul. Nu e edge.

| # | Comportament | n | Brut 60m | Verdict |
|---|---|---:|---:|---|
| 1 | `impulse_up_5` „+2.54%" | 132 | +2.542% | **5 evenimente = 109% din PnL** |
| 2 | `confirm_up` „+1.54%" | 818 | +1.536% | perioada 1 negativă (−0.49) |
| 3 | `impulse_up_3` „+1.02%" | 233 | +1.021% | tot în aceeași fereastră |
| 4 | `pullback_up` cu MFE 6.0 / MAE 4.0 | 1055 | +0.577% | volatilitate extremă |
| 5 | Short pe scădere: brut −0.37% | 937 | −0.374% | rebound, dar tot pompa |

Probă decisivă (#1, cost 0.40%):
```
events=132  mean +2.142%  MEDIAN -0.400%  win rate 42.4%
best 5 events = +308.7% din total +282.7%  (109%)
fara primele 5:  mean -0.205%
top evenimente: 2026-10-23 18:20 (+121.7%), 2026-10-23 18:40 (+69.8%),
                2026-10-23 15:05 (+48.0%), 2026-10-24 00:50 (+36.5%), 2026-10-24 01:00 (+32.8%)
```
Toate cinci sunt în **23–24 octombrie** — pompa de listare. Mediana e negativă, win rate 42%. Cu $19k volum median/zi, slippage-ul real e cu ordine de mărime peste 0.30%.

### 3.4 PIEVERSE — singurul candidat cu stabilitate, dar eșantion mic

| # | Comportament | n | Brut 60m | Net bază | Perioade |
|---|---|---:|---:|---|
| 1 | `btclead_up` (BTC sus, altul rămas în urmă) | 48 | +1.151% | +1.001% | **+1.76 / +0.29 / +0.55** |
| 2 | `breakout_up` | 764 | +0.252% | +0.102% | +0.07 / −0.01 / +0.17 |
| 3 | `volspike_up` | 347 | +0.238% | +0.088% | +0.29 / −0.39 / +0.19 |
| 4 | Impuls 5% se întoarce | 111 | −0.286% | −0.436% | — |
| 5 | Bare moarte: 0% mișcare în 60 min | — | 0.000% | −0.150% | — |

`btclead_up` e **singurul** semnal din tot raportul pozitiv în toate cele 3 perioade. Dar testul de concentrare îl destramă:
```
non-overlap: events=25  mean +0.254%  MEDIAN -0.057%  win rate 48.0%
fara primele 5:  mean -0.214%
```
n scade de la 48 la 25 (evenimentele suprapuse erau aceeași mișcare), mediana devine negativă. **Eșantion insuficient, nu edge dovedit.**

Exemplul #5 arată de ce: `2026-08-19 16:55 intrare 0.9273 → ieșire 0.9273, MFE 0 / MAE 0` — prețul nu s-a mișcat deloc o oră. Instrument mort în afara câtorva ferestre.

### 3.5 CASHCAT — 61 zile, spread 2.19%, cost deja prohibitiv

| # | Comportament | n | Brut 60m | Net bază | Perioade |
|---|---|---:|---:|---|
| 1 | `impulse_up_5` | 69 | +0.214% | +0.064% | **−1.38** / +0.45 / +0.60 |
| 2 | `impulse_dn_3` (short cu trendul) | 254 | +0.160% | +0.010% | +0.11 / −0.66 / +0.29 |
| 3 | `volspike_up` brut −0.306% → fade candidat | 394 | −0.306% | −0.456% | — |
| 4 | `impulse_up_1` brut −0.202% | 745 | −0.202% | −0.352% | — |
| 5 | Spread 2.19% = 5.5× pragul de 0.5% | — | — | — | — |

Fade-ul pe volum (#3) e cel mai bun candidat conceptual, dar și el moare la cost:
```
fade volspike_up: events=312  mean -0.078%  MEDIAN -0.138%  win 46.2%
fara primele 5:   mean -0.175%
```
Edge brut ~+0.32%, cost pesimist 0.40%. Diferența e −0.08%.

---

## 4. Răspunsuri explicite

### Există oportunități LONG?

**Nu, niciuna robustă.** Pe instrumentele lichide edge-ul brut e +0.04…+0.09% (ZEC, ENA) — sub cost chiar și în scenariul de bază. Candidații care arată bine sunt invalidați: IRYS = o singură pompă (5 evenimente = 109% din PnL, mediana negativă); PIEVERSE `btclead_up` = n=48, iar după non-suprapunere n=25 cu mediană negativă.

### Există oportunități SHORT?

**Nu — și e mai rău decât LONG.** Short-ul pe slăbiciune pierde sistematic: ZEC −0.128% brut la 3%, IRYS −0.374%, PIEVERSE −0.322% la 5%, ENA −0.061%. Prețul reboundează după scăderi. Singura excepție, CASHCAT (trend descendent), dă +0.16% brut la `impulse_dn_3` — exact cât să acopere fee-ul, și instabilă între perioade (−0.66 în perioada 2).

### Care sunt condițiile detectabile înaintea intrării?

Condițiile **există și sunt detectabile fără look-ahead**, dar sunt condiții de **fade**, nu de momentum:

1. **Spike de volum cu mișcare în sus** (z ≥ 3, bară verde): brut −0.11% (ENA), −0.31% (CASHCAT) pentru cumpărător → favorizează vânzătorul.
2. **Impuls up ≥ 3–5%**: brut −0.21…−0.32% (ZEC, ENA, PIEVERSE).
3. **Mișcare puternică în jos**: short-ul pierde (rebound), deci condiția favorizează long-ul contra mișcării.

Toate trei au edge brut de 0.2–0.35%, adică **de același ordin cu costul de 0.15–0.40%**.

### Cât din mișcare mai poate fi capturat după semnal?

Foarte puțin. Excursia maximă favorabilă e mare, dar nu se concretizează în close:

| Instrument | MFE mediu 60m | MAE mediu 60m | Ret mediu | Capturat / MFE |
|---|---:|---:|---:|---:|
| ZEC `impulse_up_1` | 1.147% | 1.017% | +0.041% | **3.6%** |
| ENA `impulse_up_1` | 1.213% | 1.067% | +0.089% | **7.3%** |
| PIEVERSE `impulse_up_2` | 2.136% | 1.822% | +0.095% | **4.4%** |

Mișcarea există (MFE 1.1–2.1%), dar e simetrică cu MAE — nu are direcție. Doar 3–7% din excursie supraviețuiește până la închiderea la 60m. **Nu poți captura ce nu are direcție.**

### Care e rezultatul economic după costuri?

Negativ pe toate instrumentele lichide:

| Cost | ZEC | ENA | PIEVERSE | CASHCAT |
|---|---:|---:|---:|---:|
| Bază 0.15% (fee 0.10 + slip 0.05) | −0.11% | −0.06% | −0.12% | −0.35% |
| Pesimist 0.40% (fee 0.10 + slip 0.30) | −0.36% | −0.31% | −0.37% | −0.60% |

Per tranzacție. La 14.3 semnale/zi pe ZEC (1355 evenimente / 95 zile), scenariul pesimist înseamnă ≈ −5.1%/zi din capitalul angajat. Semnul e consecvent, magnitudinea nu e marginală.

### Ce tipare merită testate pe o perioadă istorică mai lungă?

În ordinea raportului semnal/zgomot:

1. **`btclead` (reacție întârziată la BTC)** — singurul cu 3/3 perioade pozitive. Necesită minim 6–12 luni ca să treacă de n=200 și să supraviețuiască filtrului de non-suprapunere. De testat cu ETH ca lider secundar și cu praguri de 0.5/1/2%.
2. **Fade pe spike de volum cu execuție maker-only** — edge brut +0.2…+0.32%. Cu maker (0.02%×2 = 0.04%) în loc de taker, costul scade suficient cât să conteze. Testează dacă edge-ul brut supraviețuiește fără slippage de agresor.
3. **Gradientul invers al amplitudinii** — relația „impuls mai mare ⇒ continuare mai proastă" e cea mai consistentă din raport (4/5 instrumente). Merită testată ca semnal short pe orizonturi mai lungi.
4. **Orizonturi de 240m** — la `impulse_up_1`, netul bază devine ZEC +0.004%, ENA +0.106%, PIEVERSE +0.369%. Driftul se acumulează cu timpul, dar MAE crește proporțional. De testat cu stop-loss, nu fără.
5. **Condiționare pe regim** (ER / trend filter) — datele sugerează că semnalele se comportă opus în trend vs range. Un filtru de regim ar putea separa cele două.

---

## 5. Limite — ce acest raport NU poate spune

- **Spread și adâncime = un singur snapshot.** OKX nu publică istoric de order book. Costul real de execuție pe parcursul celor 95 de zile e necunoscut; slippage-ul e modelat, nu măsurat.
- **Suprapunere parțială.** Filtrul de non-suprapunere elimină dubla numărare a aceleiași mișcări, dar reduce n-ul. Ambele cifre sunt raportate.
- **95 zile = un singur regim de piață.** Toate cele 5 instrumente au fost listate în aceeași fereastră (aug–nov 2026). Nu există diversitate de regim, deci „stabilitatea pe perioade" e slabă prin construcție.
- **IRYS, PIEVERSE, CASHCAT** au sub 100 zile și volum median $17k–84k/zi. Pe ele, orice concluzie pozitivă e suspectă prin lichiditate, iar orice concluzie negativă e mai fiabilă decât pare.
- **Fee-uri Lv1.** Un tier mai bun ar reduce costul cu ~50%, dar nu schimbă semnul la ZEC/ENA (edge brut +0.04…+0.09% vs fee 0.04% la maker + slippage).
- **Nu s-a modelat funding.** Pe orizonturi de 240m, funding la 8h poate adăuga 0.5–10 bps — relevant doar pentru #4 din lista de mai sus.

---

## 6. Reproducere

```powershell
npx tsx research/tb5/phase2/collectRef.ts --days=95 --bars=5m,1H   # BTC/ETH referinta
npx tsx research/tb5/phase2/engine.ts                              # -> phase2.json (2200 randuri)
npx tsx research/tb5/phase2/diag.ts ZEC impulse_up_1 0 12          # distributie + non-overlap
npx tsx research/tb5/phase2/diag.ts CASHCAT volspike_up 0 12 fade  # test fade
npx tsx research/tb5/phase2/diag.ts PIEVERSE btclead_up 0 12       # candidatul cu 3/3 perioade
```

`phase2.json` conține matricea completă: 22 semnale × 4 întârzieri × 5 orizonturi × 5 instrumente, cu MFE, MAE, continuare, inversare, net bază/pesimist și defalcare pe cele 3 subperioade.

**Nu s-a implementat nicio strategie și nu s-a modificat nimic din TB5.** Acesta e material de cercetare, nu un bot.
