# Plan: protecția grid-urilor AUTO-LIMIT (`_UM_XPERP`)

Scris: 2026-11-17. Stare: **neaprobat, necodat**. Nimic din fișierul ăsta nu e implementat.

Scopul documentului: să nu mai repar simptome. Mai jos e ce am verificat în cod, ce am
greșit, și ce trebuie făcut — în ordinea în care trebuie făcut.

---

## 0. Corectarea a ce ți-am spus azi

Ți-am spus că HYPE se oprește singur la **$63.60 în jos** și **$75.48 în sus**. Asta e
adevărat pentru **un singur** motor. În cod există **două**, și nu sunt de acord între ele:

| Motor | Fișier | Cum decide | Bounds folosite |
|---|---|---|---|
| A. Risk manager brut | `GridRiskManager.ts:75` | per tick, fără confirmare | `bot.lowerStopPrice` / `bot.upperStopPrice` → $63.60 / $75.48 |
| B. Analyzer | `GridBotAnalyzer.ts` + `gridReasonCodes.ts` | buffered + **confirmat** (ADX, minute în afara benzii) | `bot.minPx` / `bot.maxPx` → $66.80 / $70.22 |

Motorul A oprește la −7.4% / +9.9%. Motorul B oprește la marginea benzii ± buffer, adică
≈ −2.7% / +2.3%. **Aceeași poziție, două răspunsuri diferite la întrebarea „unde mă opresc".**

Care are autoritatea — asta e necunoscutul care trebuie rezolvat primul. Nu-l ghicesc.

---

## 1. Ce e verificat (fapte, cu locul din cod)

**Există deja:**
- `assessProfitGiveback` + `ratchetPeak` — garda de giveback, cu teste (`gridProfitGuard.test.ts`)
- `assessRangeBreakout` — breakout cu buffer, ADX, `outsideMinutes`, `efficiencyRatio`
  (`gridReasonCodes.ts:281-300`), produce `RISK_RANGE_BREAKOUT_CONFIRMED` / `_UNCONFIRMED`
- `peakTotalPnlPct` — high-water mark, ratcheted la fiecare tick (`NeutralGridEngine.ts:967-969`)
- Stopuri la bursă reduce-only — `okxConditionalStop.ts` + wiring, 16 teste, **oprite de flag**

**Lipsește sau e rupt:**
- `stopOnTrendInvalidation` — se salvează (`OKXNativeGridEngine.ts:1068-1071`, `1133-1134`),
  se afișează în UI, dar **n-am găsit nicio evaluare** în calea de risc. Config mort.
- `GridRiskConfig` (types.ts) **nu are** câmp de giveback → analyzer-ul folosește `thresholds`
  proprii, nu configurația botului. Două seturi de praguri care nu se văd unul pe altul.
- Stops derivate din `SL% / levier` în loc de geometria benzii → asimetrie
  (−4.8% sub bandă vs +7.5% peste). Reparat în `GridOptimizer` pentru boți **noi**, dar
  HYPE/JUP au configurația înghețată în `.data`.

---

## 2. Problema reală, formulată o dată

> Stopurile sunt calculate în trei locuri după trei formule, executate de două motoare care nu
> se coordonează, și toate trăiesc în procesul Node.

De aici decurg toate celelalte: asimetria, TP-ul de neatins, giveback-ul, riscul de noapte.

---

## 3. Planul, în ordinea corectă

### Pas 0 — Cine execută? (investigație, fără cod)
De răspuns **înainte** de orice modificare:

1. `GridBotAnalyzer` — verdictul lui ajunge automat la `stopBot`, sau doar în UI ca „MONITOR"?
2. Dacă ajunge automat: A și B se contrazic pe un bot real? Care câștigă la același tick?
3. Dacă nu ajunge: garda de giveback e **decorativă**, și asta e gaura cea mare.

Fără răspunsul ăsta, orice cod scris mâine poate dubla o logică ce există deja sau poate
anula una care funcționa.

**Ieșire:** o propoziție scrisă — „la tick, botul se oprește după X, pentru că Y".

### Pas 1 — O singură sursă de adevăr pentru stopuri
O funcție pură care, dată fiind banda + levierul, întoarce **toate** numerele:
preț jos, preț sus, SL%, TP%, plus justificarea. Consumatori:

```
GridOptimizer ─┐
analyzer       ├→  sursaUnica(bandă, levier)  →  prețuri identice peste tot
UI             │
venue stops   ─┘
```

Deja există 80% (`gridStopTargets.ts`). Rămâne ca analyzer-ul și UI-ul să o folosească,
nu să-și calculeze fiecare.

### Pas 2 — Elimină asimetria
Stopul de sus trebuie să fie `bandă + buffer`, nu `bandă + TP%/levier`. Consecință azi:

```
jos:  66.80 → 63.60  = −4.8%
sus:  70.22 → 75.48  = +7.5%     ← de aici se dă înapoi tot profitul
```

Simetric înseamnă ±0.5% în afara benzii pe ambele părți. Deja calculat de `gridStopTargets`
(`stopLossPrice` / `stopUpperPrice`) — trebuie doar folosit peste tot.

### Pas 3 — `stopOnTrendInvalidation`: reparat sau șters
Acum e un buton care minte. Două variante:
- **reparat**: evaluat în analyzer pe `adxConsecutiveAboveStop` (câmpul există deja)
- **șters**: scos din UI și din config, ca nimeni să nu se bazeze pe el

Recomandare: reparat, pentru că informația (ADX 28.7 la 10 evaluări) e deja colectată.

### Pas 4 — Stopuri la bursă, armate
`okxConditionalStop.ts` e gata și testat. De activat:
1. `GRID_VENUE_STOP_ENABLED=1` pe **un** bot mic, supravegheat
2. verificat în OKX → Ordine algo că apar exact 2 poziții, `reduceOnly`
3. verificat că la `stopBot` dispar
4. abia apoi pe toate

Ăsta e singurul strat care supraviețuiește unui crash, unui sleep sau unui restart.

### Pas 5 — Watchdog pentru tick-uri moarte
Cauza #1 pentru „nu s-a oprit noaptea" nu e piața — e laptopul care adoarme. Procesul trăiește,
dar nu mai primește prețuri, deci niciuna din reguli nu rulează. Un check simplu: dacă nu a
venit niciun tick pentru N minute pe un simbol cu bot RUNNING → alertă (Telegram) + log critic.

Nu oprește nimic. Doar îți spune că ești descoperit.

### Pas 6 — Migrarea boților existenți
HYPE și JUP au în `.data` stopurile vechi. Orice cod nou nu-i atinge. Decizie de luat
explicit, per bot, cu cifrele din față:

```
HYPE:  SL $63.60 → $66.47   |  sus $75.48 → $70.57
JUP:   SL $0.2310 → ?       |  sus ? → ?
```

Asta e o schimbare pe un bot **live**. Nu se face automat.

---

## 4. Cifrele lui HYPE, ca referință pentru mâine

```
bandă        66.80 – 70.22
preț         68.66   (54.5% din bandă)
marjă/levier $12 / 2x     notional max ~$22
acum         +$0.853 (+7.11%), 63 arbitraje, grid +$1.044 bancat
ADX          28.7 > 25 la 10 evaluări consecutive

oprire jos   $63.60   −7.4%   ~+$0.2     (motorul A)
oprire sus   $75.48   +9.9%   ~−$0.9     (motorul A)
oprire B     ~66.47 / ~70.57  ±0.5% peste bandă, cu confirmare ADX
TP +15%      $1.80    de neatins: plafonul de sus se atinge primul
```

---

## 5. Ce NU se rezolvă în cod

- **Laptopul care adoarme.** Doar setare de OS sau mutarea pe un device care stă pornit.
- **Gap-uri de preț.** Un stop la bursă se execută la piață, nu la prețul dorit.
- **Faptul că `_UM_XPERP` poate să nu accepte ordine condiționate.** Netestabil de aici;
  se află la primul `GRID_VENUE_STOP_ENABLED=1`.

---

## 6. Ordinea de lucru pentru mâine

```
1. Pas 0  — aflăm cine execută              (30 min, doar citit)
2. Pas 2  — simetrie în gridStopTargets     (mic, testabil)
3. Pas 3  — stopOnTrendInvalidation         (decis: reparat sau șters)
4. Pas 1  — sursă unică peste tot           (refactor, după ce 2 și 3 sunt clare)
5. Pas 5  — watchdog tick-uri               (independent, se poate oricând)
6. Pas 4  — stopuri la bursă, armate        (ultimul, supravegheat)
7. Pas 6  — migrare HYPE/JUP                (doar cu acordul tău, per bot)
```

De ce în ordinea asta: 1–3 sunt pure și testabile fără să atingă bani. 4 atinge viața reală.
5 e independent. 6 și 7 schimbă boți live — ultimele, după ce restul e verificat.
