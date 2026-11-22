#!/usr/bin/env python3
"""
grid-vs-directional.py
======================
Intrebarea: daca stim regimul (trend vs range), nu e mai bine sa mergem
DIRECTIONAL (long/short dupa trend) sau cu grid doar pe o parte, in loc sa
refuzam tranzactia?

Testam trei lucruri, pe aceleasi 9 contracte si aceleasi 90 de bare zilnice:

  A. Are regimul putere predictiva EX-ANTE?
     Pentru fiecare bara i: masuram ER14 si randamentul pe 14 bare folosind
     DOAR date pana la i, apoi ne uitam la randamentul barei urmatoare.
     Fara lookahead: semnalul de la i produce pozitia pentru i -> i+1.

  B. Trei strategii directionale, cu costuri reale de tranzactionare:
     - MOMENTUM:  long daca trendul e puternic si urca, short daca e puternic si coboara
     - MEANREV:   invers (long dupa o cadere puternica, short dupa o urcare puternica)
     - HOLD:      buy & hold, referinta

  C. Grid long-only vs grid short-only pe aceeasi fereastra.
          Gridul din backtest era neutru, dar neutru intr-o piata care cade =
     structural long. Intrebarea e cat de mult conteaza semnul laturii.

Rulare: python scripts/grid-vs-directional.py
"""

from __future__ import annotations

import importlib.util
import os
import statistics
import sys

# consola Windows e cp1252 si nu poate encoda diacritice
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

_HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location(
    "thesis", os.path.join(_HERE, "grid-range-thesis-test.py")
)
assert _spec and _spec.loader
thesis = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(thesis)

SYMS = ("BTC", "ETH", "SOL", "AAVE", "SUI", "ARB", "INJ", "HYPE", "ZEC")
CLOSES = {s: list(reversed(thesis.CLOSES[s])) for s in SYMS}

ER_WIN = 14
COST = 0.0005          # 0.05% per unitate de turnover (taker perp OKX)
TREND_ER = 0.35        # peste asta consideram "trend puternic"
RANGE_ER = 0.20        # sub asta consideram "range"


# ---------------------------------------------------------------------------
# A. Predictibilitate ex-ante
# ---------------------------------------------------------------------------

def observations(closes: list[float], win: int = ER_WIN):
    """(er, ret_win, fwd_1) pentru fiecare bara, fara lookahead."""
    out = []
    for i in range(win + 1, len(closes) - 1):
        w = closes[i - win:i + 1]
        net = abs(w[-1] - w[0])
        path = sum(abs(w[k] - w[k - 1]) for k in range(1, len(w)))
        er = net / path if path else 0.0
        ret = w[-1] / w[0] - 1.0
        fwd = closes[i + 1] / closes[i] - 1.0
        out.append((er, ret, fwd))
    return out


def mean_t(xs: list[float]) -> tuple[float, float]:
    """Media si t-statisticul (fata de 0)."""
    if len(xs) < 2:
        return (float("nan"), float("nan"))
    m = statistics.fmean(xs)
    sd = statistics.stdev(xs)
    t = m / (sd / len(xs) ** 0.5) if sd else float("nan")
    return m, t


def part_a() -> None:
    print("=" * 100)
    print("A. REGIMUL PREDICĂ BARA URMĂTOARE? (semnal la i, randament i->i+1, fara lookahead)")
    print("=" * 100)

    pooled = []
    for s in SYMS:
        pooled.extend(observations(CLOSES[s]))

    buckets = {
        "trend puternic, in SUS   (ER>%.2f, ret>0)" % TREND_ER: lambda e, r: e > TREND_ER and r > 0,
        "trend puternic, in JOS   (ER>%.2f, ret<0)" % TREND_ER: lambda e, r: e > TREND_ER and r < 0,
        "range, dupa urcare       (ER<%.2f, ret>0)" % RANGE_ER: lambda e, r: e < RANGE_ER and r > 0,
        "range, dupa cadere       (ER<%.2f, ret<0)" % RANGE_ER: lambda e, r: e < RANGE_ER and r < 0,
    }

    print(f"{'regim':<42}{'n':>6}{'fwd mediu':>12}{'t-stat':>9}{'hit%':>8}")
    print("-" * 100)
    for label, pred in buckets.items():
        fwd = [f for (e, r, f) in pooled if pred(e, r)]
        m, t = mean_t(fwd)
        hit = sum(1 for f in fwd if f > 0) / len(fwd) * 100 if fwd else 0
        print(f"{label:<42}{len(fwd):>6}{m * 100:>11.3f}%{t:>9.2f}{hit:>7.0f}%")

    print()
    print("Citire: daca 'trend in JOS' are fwd mediu NEGATIV cu |t|>2, atunci")
    print("shortul dupa un trend descendent are edge real. Daca 'range dupa cadere'")
    print("are fwd POZITIV, gridul are edge. Daca ambele sunt ~0, regimul nu ajuta.")


# ---------------------------------------------------------------------------
# B. Strategii directionale
# ---------------------------------------------------------------------------

def run_strategy(closes: list[float], mode: str, er_thr: float) -> dict:
    """mode: 'momentum' | 'meanrev' | 'hold'."""
    pos_prev = 0.0
    pnl = 0.0
    flips = 0
    for i in range(ER_WIN + 1, len(closes) - 1):
        w = closes[i - ER_WIN:i + 1]
        net = abs(w[-1] - w[0])
        path = sum(abs(w[k] - w[k - 1]) for k in range(1, len(w)))
        er = net / path if path else 0.0
        ret = w[-1] / w[0] - 1.0

        if mode == "hold":
            pos = 1.0
        elif mode == "momentum":
            pos = (1.0 if ret > 0 else -1.0) if er > er_thr else 0.0
        elif mode == "meanrev":
            pos = (-1.0 if ret > 0 else 1.0) if er < er_thr else 0.0
        else:
            raise ValueError(mode)

        fwd = closes[i + 1] / closes[i] - 1.0
        pnl += pos * fwd - COST * abs(pos - pos_prev)
        if pos != pos_prev:
            flips += 1
        pos_prev = pos
    return dict(pnl=pnl * 100.0, flips=flips)


def part_b() -> None:
    print()
    print("=" * 100)
    print("B. STRATEGII DIRECTIONALE (zilnic, cost 0.05%/unitate turnover)")
    print("=" * 100)
    print(f"{'SYM':<6}{'MOMENTUM':>12}{'MEANREV':>12}{'HOLD':>12}   castigator")
    print("-" * 100)

    totals = {"momentum": 0.0, "meanrev": 0.0, "hold": 0.0}
    wins = {"momentum": 0, "meanrev": 0, "hold": 0}
    for s in SYMS:
        mom = run_strategy(CLOSES[s], "momentum", TREND_ER)
        mrv = run_strategy(CLOSES[s], "meanrev", RANGE_ER)
        hold = run_strategy(CLOSES[s], "hold", 0)
        for k, v in (("momentum", mom), ("meanrev", mrv), ("hold", hold)):
            totals[k] += v["pnl"]
            wins[k] += 1 if v["pnl"] > 0 else 0
        best = max((mom["pnl"], "MOMENTUM"), (mrv["pnl"], "MEANREV"), (hold["pnl"], "HOLD"))[1]
        print(
            f"{s:<6}{mom['pnl']:>11.1f}%{mrv['pnl']:>11.1f}%{hold['pnl']:>11.1f}%   {best}"
        )

    print("-" * 100)
    print(
        f"{'TOTAL':<6}{totals['momentum']:>11.1f}%{totals['meanrev']:>11.1f}%"
        f"{totals['hold']:>11.1f}%"
    )
    print(
        f"{'verzi':<6}{wins['momentum']:>10}/9{wins['meanrev']:>10}/9{wins['hold']:>10}/9"
    )


# ---------------------------------------------------------------------------
# C. Grid long-only vs short-only vs neutru
# ---------------------------------------------------------------------------

def run_grid_side(closes: list[float], side: str, warmup: int = 30,
                  levels: int = 20, fee: float = COST) -> dict:
    """Grid cu o singura latura.

    side='long'  : cumpara pe coborare prin nivel, vinde un spacing mai sus.
    side='short' : vinde pe urcare prin nivel, rascumpara un spacing mai jos.
    """
    band_lo, band_hi = min(closes[:warmup]), max(closes[:warmup])
    spacing = (band_hi - band_lo) / (levels - 1)
    lv = [band_lo + i * spacing for i in range(levels)]
    ladder_capital = sum(lv)

    holding: dict[int, float] = {}
    realized = 0.0
    trips = 0

    for i in range(warmup, len(closes)):
        a, b = closes[i - 1], closes[i]
        lo, hi = (a, b) if a <= b else (b, a)
        up = b > a
        crossed = [j for j, p in enumerate(lv) if lo < p < hi]
        if up:
            crossed.reverse()

        for j in crossed:
            price = lv[j]
            if side == "long":
                if not up and j not in holding:
                    holding[j] = price
                elif up:
                    for k in list(holding):
                        if lv[k] + spacing <= price:
                            entry = holding.pop(k)
                            exit_px = entry + spacing
                            realized += exit_px - entry - fee * entry - fee * exit_px
                            trips += 1
            else:  # short
                if up and j not in holding:
                    holding[j] = price
                elif not up:
                    for k in list(holding):
                        if lv[k] - spacing >= price:
                            entry = holding.pop(k)
                            exit_px = entry - spacing
                            realized += entry - exit_px - fee * entry - fee * exit_px
                            trips += 1

    final_px = closes[-1]
    if side == "long":
        floating = sum(final_px - e for e in holding.values())
    else:
        floating = sum(e - final_px for e in holding.values())
    net = realized + floating
    return dict(
        realized_pct=realized / ladder_capital * 100.0,
        floating_pct=floating / ladder_capital * 100.0,
        net_pct=net / ladder_capital * 100.0,
        trips=trips,
        open_pos=len(holding),
    )


def part_c() -> None:
    print()
    print("=" * 100)
    print("C. GRID LONG-ONLY vs SHORT-ONLY (acelasi band, aceleasi niveluri, acelasi fee)")
    print("=" * 100)
    print(f"{'SYM':<6}{'LONG net%':>11}{'SHORT net%':>12}{'diff':>9}   ret_hold%")
    print("-" * 100)
    tl = ts = 0.0
    for s in SYMS:
        c = CLOSES[s]
        L = run_grid_side(c, "long")
        S = run_grid_side(c, "short")
        tl += L["net_pct"]
        ts += S["net_pct"]
        rh = (c[-1] / c[30] - 1.0) * 100.0
        print(
            f"{s:<6}{L['net_pct']:>10.2f}%{S['net_pct']:>11.2f}%"
            f"{S['net_pct'] - L['net_pct']:>8.2f}%{rh:>11.1f}%"
        )
    print("-" * 100)
    print(f"{'MEDIE':<6}{tl / 9:>10.2f}%{ts / 9:>11.2f}%{ts / 9 - tl / 9:>8.2f}%")


if __name__ == "__main__":
    part_a()
    part_b()
    part_c()
