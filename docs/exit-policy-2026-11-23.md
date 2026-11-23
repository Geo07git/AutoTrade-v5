# Politici de ieșire — măsurătoare, 23 noiembrie 2026

> Document de măsurare, nu plan. Continuă `audit-2026-11-14.md` §4.6 („ieșirile costă −13.23").
> Reproduce: `npm run grid-exit` (citire, fără OKX privat), testează mecanismul: `npm test`.
> Mecanismul e blocat de teste în `src/server/research/__tests__/gridExitPolicy.test.ts`.

## Întrebarea

Auditul a arătat: motor **+7.53**, fees **−2.09**, ieșiri **−13.23**, net **−7.79**.
Toate cele 89 de opriri au fost `stopType '1'` = close at market. `stopType '2'` (nu închide
poziția) există în cod și **nu fusese folosit niciodată**. Deci ipoteza era:

> am pierdut din felul în care ieșim, nu din motor.

## Metoda

`scripts/grid-exit-compare.ts` — același grid, aceleași lumânări reale 15m de la OKX EEA
(1440 bare = 15 zile), cinci X-Perp-uri crypto, trei politici de ieșire:

| Politică | Ce face |
|---|---|
| `MARKET_STOP` | close la marginea benzii — exact ce a rulat 7 zile |
| `HOLD` | nu închide pe bandă; rămâne expus la stop-ul de marjă și la lichidare |
| `HOLD_BACKSTOP` | nu închide pe bandă; închide doar la +1.5% dincolo (stop condiționat reduce-only) |

Parametri identici: bandă ±3%, 6 nivele, levier 2x, marjă 12 USDT, stop 20% din marjă (generos
față de 5% din producție, deci în favoarea lui HOLD), TP off.

## Rezultat

| Politică | trips | realizat | fees | **net** | cel mai rău bot |
|---|---|---|---|---|---|
| `MARKET_STOP` | 6 | −0.90 | 0.06 | **−0.98** | −0.27 |
| `HOLD` | 14 | −9.74 | 0.06 | **−11.01** | −2.51 |
| `HOLD_BACKSTOP` | 12 | −0.90 | 0.07 | **−0.98** | −0.29 |

**Ipoteza este falsificată.** Hold pur e de ~11× mai rău: patru din cinci simboluri lovesc
stop-ul de marjă la −20%. Backstop-ul e neutru (identic cu close-at-market). Ieșirea la marginea
benzii, cu tot costul ei, nu era gaura principală.

## Al doilea rezultat, la fel de important

Pe 15 zile și cinci majore, gridul a făcut **6 round-trip-uri în total**. Nu are ce câștiga:
într-o bandă de ±3%, un major traversează nivelurile prea rar. Iar producția a avut 236
round-trip-uri în 7 zile pentru că tranzacționa small caps volatile (HUMA, BTW, DGAI, PUMP, SOXL)
— exact instrumentele care produc și breakout-urile care ne omoară.

**Frecvența round-trip-urilor și riscul de breakout sunt aceeași variabilă.** Nu poți scala una
fără cealaltă. Asta explică de ce serverul a produs +7.53 brut și −13.23 ieșiri în aceleași 7 zile.

## Al treilea rezultat: un blocaj de măsurare

`npm run ruler` crăpa (`all is not iterable`) pentru că `okx_synced_transactions.json` e
`schemaVersion 2` (`{ schemaVersion, records }`), nu array plat. Reparat. După reparație, fereastra
09→23.11 arată:

- 38 boți, 100 opriri, **viață mediană 283 min** (era 50, prag ≥480) → fix-ul de bandă a prins;
- `falseBreak` măsurat pe 39 de opriri: **24 cu falseBreak > 0** (prag <0.3) → încă prea multe;
- **feed de fill-uri gol: 0 rânduri `OKX_ORDER_*` din 9406.** PnL-ul per bot este nemăsurabil
  local. Asta e motivul pentru care „nimic nu arăta profit": nu exista instrument de măsură,
  nu dovada că profitul nu există.

## Concluzie

Gridul neutral nu are o problemă de ieșire. Are o problemă **structurală**: câștigul per ciclu e
mai mic decât costul cozii pe care volatilitatea o produce în același timp cu ciclurile.
`stopType '2'` nu e răspunsul — e doar o pierdere mai mare, mai lent.

Ce rămâne de exploatat e chiar semnalul pe care îl măsurăm de 89 de ori: **breakout-ul confirmat**
(EFFICIENCY / ADX / PERSISTENCE). Azi îl folosim doar ca să închidem un grid — adică folosim un
detector de trend ca să ne oprim, niciodată ca să intrăm. 70 din 89 de opriri au fost „range
breakout CONFIRMAT": detectorul a avut dreptate de 70 de ori despre direcție, și de fiecare dată
am plătit ca să fim pe partea greșită a ei.
