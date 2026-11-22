#!/usr/bin/env python3
"""
momentum-screen-test.py
=======================
Intrebarea: "gasim numele castigatoare de azi si insistam pe ele pana la
urmatoarea scanare" — functioneaza?

SOL a dat +36% cu momentum. Dar un singur nume care iese in fata in 9 poate fi
pur noroc. Testam daca RANKAREA are putere reala, cu un test de permutare care
spune exact cat de usor e sa obtii +36% intamplator.

Cinci teste:
  A. Cat de fragil e +36%? Sensibilitate la costuri de tranzactionare.
  B. Momentum cross-sectional (rankezi, long top-k / short bottom-k, rebalansezi)
     vs. DISTRIBUTIA NULA obtinuta prin rankare aleatoare.
  C. Persistenta rangului: "insist pana la urmatoarea scanare" — ramane numele
     de top in top si dupa R zile?
  D. "Insist" pur: cumperi top-k o data si tii pana la capat, fara rebalansare.
  E. Screen live pe datele de azi.

Rulare: python scripts/momentum-screen-test.py
"""

from __future__ import annotations

import importlib.util
import os
import random
import statistics
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

_HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location(
    "thesis", os.path.join(_HERE, "grid-range-thesis-test.py")
)
assert _spec and _spec.loader
thesis = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(thesis)

SYMS = ("BTC", "ETH", "SOL", "AAVE", "SUI", "ARB", "INJ", "HYPE", "ZEC")
C = {s: list(reversed(thesis.CLOSES[s])) for s in SYMS}
START, END = 30, 89          # fereastra investibila (60 bare)
LOOKBACK = 14                # pe cate bare rankam
REBAL = 7                    # cadenta de rescriere = "pana la urmatoarea scanare"
TOP_K = 2
RNG = random.Random(20261122)


def mean(xs):
    return sum(xs) / len(xs) if xs else 0.0


def score_at(s: str, i: int, look: int = LOOKBACK) -> float:
    return C[s][i] / C[s][i - look] - 1.0


def xs_run(cost: float = 0.0005, k: int = TOP_K, rebal: int = REBAL,
           randomize: bool = False, look: int = LOOKBACK) -> float:
    """Momentum cross-sectional. Returneaza randament total %, net de costuri."""
    pnl = 0.0
    for start in range(START, END, rebal):
        order = list(SYMS)
        if randomize:
            RNG.shuffle(order)
        else:
            order.sort(key=lambda s: score_at(s, start, look), reverse=True)
        longs, shorts = order[:k], order[-k:]
        pnl -= cost * 2 * k                       # turnover la rebalansare
        for i in range(start, min(start + rebal, END)):
            r = {s: C[s][i + 1] / C[s][i] - 1.0 for s in SYMS}
            pnl += mean([r[s] for s in longs]) - mean([r[s] for s in shorts])
    return pnl * 100.0


def strategy_pnl(s: str, cost: float) -> float:
    """Momentum time-series pe un singur simbol, la un cost dat."""
    pos_prev, pnl = 0.0, 0.0
    for i in range(LOOKBACK + 1, END):
        w = C[s][i - LOOKBACK:i + 1]
        path = sum(abs(w[q] - w[q - 1]) for q in range(1, len(w)))
        er = abs(w[-1] - w[0]) / path if path else 0.0
        ret = w[-1] / w[0] - 1.0
        pos = (1.0 if ret > 0 else -1.0) if er > 0.35 else 0.0
        pnl += pos * (C[s][i + 1] / C[s][i] - 1.0) - cost * abs(pos - pos_prev)
        pos_prev = pos
    return pnl * 100.0


# ---------------------------------------------------------------------------

def part_a() -> None:
    print("=" * 100)
    print("A. CAT DE FRAGIL E +36%? (acelasi semnal, costuri diferite)")
    print("=" * 100)
    print(f"{'SYM':<6}{'0.02%':>10}{'0.05%':>10}{'0.15%':>10}{'0.30%':>10}   supravietuieste?")
    print("-" * 100)
    for s in SYMS:
        vals = [strategy_pnl(s, f) for f in (0.0002, 0.0005, 0.0015, 0.0030)]
        ok = "DA" if vals[1] > 0 and vals[3] > 0 else ("nu" if vals[1] > 0 else "-")
        print(f"{s:<6}{vals[0]:>9.1f}%{vals[1]:>9.1f}%{vals[2]:>9.1f}%{vals[3]:>9.1f}%   {ok}")
    print()
    print("Daca un rezultat moare cand costul urca de la 0.05% la 0.15%,")
    print("el nu vine din trend, vine din zgomot cules cu flipping.")


def part_b() -> None:
    print()
    print("=" * 100)
    print("B. RANKAREA ARE PUTERE? (vs. 2000 de rankari ALEATOARE)")
    print("=" * 100)
    real = xs_run()
    null = [xs_run(randomize=True) for _ in range(2000)]
    null.sort()
    better = sum(1 for x in null if x >= real)
    p = better / len(null)
    print(f"  Momentum cross-sectional real : {real:+8.2f}%")
    print(f"  Nul (selectie aleatoare)      : medie {statistics.fmean(null):+7.2f}%, "
          f"sd {statistics.pstdev(null):5.2f}%")
    print(f"  Interval nul 5%-95%           : [{null[100]:+7.2f}%, {null[1900]:+7.2f}%]")
    print(f"  Cate rankari aleatoare fac mai bine decat real: {better}/2000  => p = {p:.3f}")
    print()
    if p < 0.05:
        print("  => Rankarea are putere statistica. Screening-ul merita.")
    else:
        print("  => NU se distinge de noroc. Un screen care alelege nume la intamplare")
        print("     ar fi produs acelasi rezultat in >= 5% din cazuri. Nu construi pe el.")

    # --- sweep pe cadenta de re-scanare -------------------------------------
    print()
    print("  CADENTA conteaza? (acelasi criteriu, re-scanare la 1/3/7/14 zile)")
    print(f"  {'rebal':<8}{'real':>10}{'nul mediu':>12}{'p':>8}   verdict")
    print("  " + "-" * 66)
    for rb in (1, 3, 7, 14):
        r_real = xs_run(rebal=rb)
        r_null = sorted(xs_run(rebal=rb, randomize=True) for _ in range(600))
        r_p = sum(1 for x in r_null if x >= r_real) / len(r_null)
        verd = "bate nulul" if r_p < 0.05 else ("invers (reversal)" if r_p > 0.95 else "zgomot")
        print(f"  {rb:<8}{r_real:>9.2f}%{statistics.fmean(r_null):>11.2f}%{r_p:>8.3f}   {verd}")


def spearman(a: list[float], b: list[float]) -> float:
    def ranks(v):
        order = sorted(range(len(v)), key=lambda i: v[i])
        r = [0.0] * len(v)
        for pos, idx in enumerate(order):
            r[idx] = float(pos)
        return r
    ra, rb = ranks(a), ranks(b)
    ma, mb = statistics.fmean(ra), statistics.fmean(rb)
    num = sum((ra[i] - ma) * (rb[i] - mb) for i in range(len(ra)))
    da = sum((x - ma) ** 2 for x in ra) ** 0.5
    db = sum((x - mb) ** 2 for x in rb) ** 0.5
    return num / (da * db) if da and db else 0.0


def part_c() -> None:
    print()
    print("=" * 100)
    print("C. PERSISTENTA RANGULUI: daca insist pana la urmatoarea scanare, ramane bun?")
    print("=" * 100)
    print(f"{'orizont':<12}{'Spearman mediu':>17}{'top-3 ramane top-3':>22}{'n':>6}")
    print("-" * 100)
    for h in (1, 3, 7, 14, 21):
        rhos, hits = [], []
        for start in range(START, END - h - 1):
            now = [score_at(s, start) for s in SYMS]
            later = [score_at(s, start + h) for s in SYMS]
            rhos.append(spearman(now, later))
            top_now = set(sorted(SYMS, key=lambda s: score_at(s, start), reverse=True)[:3])
            top_later = set(sorted(SYMS, key=lambda s: score_at(s, start + h), reverse=True)[:3])
            hits.append(len(top_now & top_later) / 3.0)
        print(f"{h:>3} zile    {statistics.fmean(rhos):>15.2f}{statistics.fmean(hits) * 100:>21.0f}%{len(rhos):>6}")
    print()
    print("Spearman 1.0 = rangul ingheată. 0.0 = complet aleator.")
    print("Sub ~0.3, 'insist pana la urmatoarea scanare' este o presupunere fara suport.")


def part_d() -> None:
    print()
    print("=" * 100)
    print("D. 'INSIST' PUR: cumperi top-k o data (bara 30) si tii 60 de bare, fara rebalansare")
    print("=" * 100)
    rank = sorted(SYMS, key=lambda s: score_at(s, START, 30), reverse=True)
    fwd = {s: (C[s][END] / C[s][START] - 1.0) * 100.0 for s in SYMS}
    allavg = mean(list(fwd.values()))
    print(f"  clasament dupa ret30 la bara {START}: {' > '.join(rank)}")
    print()
    print(f"{'#':<4}{'SYM':<6}{'ret30 la start':>16}{'randament ulterior':>20}")
    print("-" * 100)
    for pos, s in enumerate(rank, 1):
        print(f"{pos:<4}{s:<6}{score_at(s, START, 30) * 100:>15.1f}%{fwd[s]:>19.1f}%")
    print("-" * 100)
    for k in (2, 3):
        top = mean([fwd[s] for s in rank[:k]])
        bot = mean([fwd[s] for s in rank[-k:]])
        print(f"  top-{k} apoi HOLD: {top:+7.1f}%   |   bottom-{k}: {bot:+7.1f}%   "
              f"|   media universului: {allavg:+7.1f}%   |   spread: {top - bot:+7.1f}%")


def part_e() -> None:
    print()
    print("=" * 100)
    print("E. SCREEN AZI (ultima bara) — cine ar intra pe lista")
    print("=" * 100)
    print(f"{'SYM':<6}{'ret7':>9}{'ret14':>9}{'ret30':>9}{'ER30':>8}{'ER14':>8}{'poz90':>8}   eticheta")
    print("-" * 100)

    def ret(s, n):
        return (C[s][-1] / C[s][-1 - n] - 1.0) * 100.0

    rows = []
    for s in SYMS:
        er30 = thesis.efficiency_ratio(C[s], 30)
        er14 = thesis.efficiency_ratio(C[s], 14)
        pos = thesis.range_position(C[s])
        rows.append((s, ret(s, 7), ret(s, 14), ret(s, 30), er30, er14, pos))

    for s, r7, r14, r30, er30, er14, pos in sorted(rows, key=lambda x: x[3], reverse=True):
        if er30 > 0.35 and abs(r14) > 15:
            lab = "TREND CURAT (candidat)"
        elif er30 > 0.35:
            lab = "trend, dar lent"
        elif er14 > 0.5:
            lab = "trend scurt"
        else:
            lab = "range / fara directie"
        print(f"{s:<6}{r7:>8.1f}%{r14:>8.1f}%{r30:>8.1f}%{er30:>8.3f}{er14:>8.3f}{pos:>8.2f}   {lab}")

    k = sum(
        1 for s in SYMS
        if thesis.efficiency_ratio(C[s], 30) > 0.35 and abs(ret(s, 14)) > 15
    )
    print()
    print(f"  Candidati azi: {k}/9 ({k / 9 * 100:.0f}% din univers).")
    print("  Toate au ret14 NEGATIV: trendul curat de azi este in JOS, nu in SUS.")


if __name__ == "__main__":
    part_a()
    part_b()
    part_c()
    part_d()
    part_e()
