# Breakout-ul confirmat ca intrare — testat și respins, 23 noiembrie 2026

> **Corectează concluzia din `docs/exit-policy-2026-11-23.md`** (§„Concluzie"), unde am scris:
> „detectorul a avut dreptate de 70 de ori din 89 despre direcție". Afirmația **nu era susținută
> de date**: un eveniment `Range Breakout CONFIRMAT` dovedește că breakout-ul a fost confirmat,
> nu că prețul a continuat. Aici e testul.
>
> Reproduce: `npm run breakout-entry`. Read-only, fără OKX privat, fără scriere.

## Metoda

`scripts/breakout-entry-study.ts` apelează **funcția din producție** `assessRangeBreakout`
(`gridRegime.ts`) — nu o reimplementare. 8 X-Perp-uri crypto, 2040 bare de 15m fiecare
(21.2 zile), bandă rulantă de 32 bare (8h) calculată strict din trecut, înghețată în momentul
ieșirii (ca un grid real). Semnalul e luat ca **intrare în direcția lui**, cu cooldown 32 bare ca
același breakout să nu fie numărat de 30 de ori.

Cost: 0.13% round-trip (taker 0.05% × 2 + un tick de spread).

Regula de decizie a fost fixată **înainte** de rulare — PASS dacă n ≥ 100, medie netă > 0 și
profit factor > 1.10. Nu s-a ajustat niciun parametru după ce am văzut rezultatul.

## Rezultat

| Orizont | n | medie netă | median | win% | avgWin | avgLoss | profitFactor |
|---|---|---|---|---|---|---|---|
| 1h | 202 | **−0.146%** | −0.135% | 41.1% | +0.726% | −0.755% | **0.67** |
| 4h | 195 | **−0.179%** | −0.255% | 40.0% | +1.601% | −1.366% | **0.78** |
| 8h | 195 | **−0.388%** | −0.521% | 33.8% | +2.651% | −1.943% | **0.70** |
| 24h | 190 | **−0.828%** | −1.147% | 39.5% | +3.454% | −3.620% | **0.62** |

Pe metoda de confirmare, la 4h: `PERSISTENCE` n=104 media −0.093%, `EFFICIENCY` n=91 media −0.277%.
Ambele negative — deci nu e o metodă care poluează rezultatul.

Semnale: 203. **FAIL la toate orizonturile.** Pierderea crește monoton cu orizontul
(−0.15% la 1h → −0.83% la 24h), iar win-rate-ul stă sub 41% cu avgWin ≈ avgLoss.

## Ce înseamnă

Detectorul nu e un trend detector stricat. E un **detector de mean-reversion**: după un breakout
confirmat, prețul revine. Ca *ieșire* din grid e exact ce trebuie — ieși, iar prețul se întoarce
în bandă. Ca *intrare* în aceeași direcție e greșit prin construcție, iar pierderea care crește cu
orizontul confirmă că nu e vorba de cost, ci de semn.

Nu se contrazice cu `exit-policy-2026-11-23.md`: acolo `HOLD` a pierdut pentru că ținea un grid
**cu levier 2x săptămâni**, până la stop-ul de marjă la −20% (−10% mișcare de preț). Aici orizontul
e 1–24h, fără poziție și fără levier. Pe termen scurt breakout-ul se întoarce; pe termen lung
drift-ul omoară un hold levierat. Ambele măsurători sunt consistente.

## Ce rămâne, și ce nu

- **Închis:** „folosim detectorul ca intrare". Testat, picat, nu se redeschide fără date noi.
- **Nepermis:** inversarea lui (fade pe breakout). Același eșantion, aceeași zi — ar fi data
  mining. Și oricum gridul neutral *este* fade-ul, cu coada lui cunoscută.
- **Deschis, și prioritar:** măsurarea banilor. Rigla raportează 0 rânduri `OKX_ORDER_*` din 9406,
  deci PnL-ul per bot e nemăsurabil local. Fără un arbitru funcțional, orice formulă nouă e
  neverificabilă — asta e motivul real pentru care „nimic nu arăta profit", nu absența profitului.
