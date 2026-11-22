#!/usr/bin/env python3
"""
scan-cooldown-protectii.py
==========================
Testeaza EXACT specificatia: scan zilnic + cooldown 24h dupa profit materializat
+ protectii (stop loss, trailing) + transformare grid -> directie cand gridul
nu e profitabil.

Nu comparam cu altceva: implementam regula ceruta si masuram fiecare piesa
separat, ca sa vedem ce aduce si ce ia.

Piese testate, adaugate pe rand peste baseline:
  0. BASELINE   scan zilnic, directie = semnul trendului (ER>0.35), fara protectii,
                fara cooldown. Acesta este cazul care a dat SOL +36%.
  1. + COOLDOWN 24h dupa o iesire pe profit
  2. + STOP LOSS 5%
  3. + TRAILING 8%
  4. + SL 5% + TRAILING 8% + COOLDOWN

Apoi politica "grid -> directie" cand gridul nu e profitabil.

Limitare asumata: simularea foloseste doar CLOSE zilnic (nu avem OHLC pentru
toate cele 9 serii), deci SL/trailing se declanseaza pe inchidere, nu intrabar.
Cost: 0.05% per picior.

Rulare: python scripts/scan-cooldown-protectii.py
"""

from __future__ import annotations

import importlib.util
import os
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

LOOK = 14
ER_THR = 0.35
FEE = 0.0005
START = 30


def scan(c: list[float], *, sl=None, tp=None, trail=None, cooldown=0) -> dict:
    """Scan zilnic cu protectii optionale. Returneaza statistici."""
    pos, entry, peak = 0.0, None, None
    pnl = 0.0
    cool = 0
    entries = 0
    closed = 0
    wins = 0
    cooldowns_fired = 0
    sl_hits = 0
    tp_hits = 0
    trail_hits = 0
    flips = 0

    for i in range(START, len(c) - 1):
        px = c[i]

        # --- 1. administreaza pozitia deschisa -----------------------------
        if pos != 0.0:
            peak = max(peak, px) if pos > 0 else min(peak, px)
            ret_open = pos * (px - entry) / entry
            giveback = (peak - px) / peak if pos > 0 else (px - peak) / peak

            reason = None
            if sl is not None and ret_open <= -sl:
                reason = "sl"
                sl_hits += 1
            elif tp is not None and ret_open >= tp:
                reason = "tp"
                tp_hits += 1
            elif trail is not None and giveback >= trail:
                reason = "trail"
                trail_hits += 1

            if reason:
                pnl -= FEE * abs(pos)
                closed += 1
                if pos * (px - entry) > 0:
                    wins += 1
                    cool = cooldown
                    if cooldown:
                        cooldowns_fired += 1
                pos, entry, peak = 0.0, None, None

        if cool > 0:
            cool -= 1

        # --- 2. semnalul de azi --------------------------------------------
        w = c[i - LOOK:i + 1]
        path = sum(abs(w[q] - w[q - 1]) for q in range(1, len(w)))
        er = abs(w[-1] - w[0]) / path if path else 0.0
        ret = w[-1] / w[0] - 1.0
        want = (1.0 if ret > 0 else -1.0) if er > ER_THR else 0.0

        # --- 3. intrare / inversare ----------------------------------------
        if want != 0.0 and want != pos:
            if pos != 0.0:                      # inchide inversarea
                pnl -= FEE * abs(pos)
                closed += 1
                if pos * (px - entry) > 0:
                    wins += 1
                    cool = cooldown
                    if cooldown:
                        cooldowns_fired += 1
                pos, entry, peak = 0.0, None, None
            if cool == 0:                        # cooldown blocheaza reintrarea
                pos, entry, peak = want, px, px
                entries += 1
                pnl -= FEE * abs(pos)
                flips += 1

        # --- 4. mark to market pe bara urmatoare ---------------------------
        pnl += pos * (c[i + 1] / c[i] - 1.0)

    return dict(
        pnl=pnl * 100.0,
        entries=entries,
        closed=closed,
        wins=wins,
        cooldowns=cooldowns_fired,
        sl=sl_hits,
        tp=tp_hits,
        trail=trail_hits,
    )


VARIANTS = [
    ("0. BASELINE (fara nimic)", dict()),
    ("1. + COOLDOWN 24h", dict(cooldown=1)),
    ("2. + STOP LOSS 5%", dict(sl=0.05)),
    ("3. + TAKE PROFIT 10% + COOLDOWN", dict(tp=0.10, cooldown=1)),
    ("4. + TRAILING 8%", dict(trail=0.08)),
    ("5. TP10% + SL5% + COOLDOWN", dict(tp=0.10, sl=0.05, cooldown=1)),
    ("6. TP10% + TRAIL8% + COOLDOWN", dict(tp=0.10, trail=0.08, cooldown=1)),
    ("7. TP10% + SL5% + TRAIL8% + COOLDOWN", dict(tp=0.10, sl=0.05, trail=0.08, cooldown=1)),
    ("8. TP5% + SL3% + TRAIL5% + COOLDOWN", dict(tp=0.05, sl=0.03, trail=0.05, cooldown=1)),
]


def main() -> None:
    print("=" * 100)
    print("SPECIFICATIA TA, MASURATA — scan zilnic, fara lookahead, cost 0.05%/picior")
    print("=" * 100)
    print(f"{'varianta':<36}{'TOTAL':>10}{'medie':>9}{'verzi':>7}{'inchise':>9}{'win%':>7}{'CD':>5}")
    print("-" * 100)

    for label, kw in VARIANTS:
        res = {s: scan(C[s], **kw) for s in SYMS}
        tot = sum(r["pnl"] for r in res.values())
        green = sum(1 for r in res.values() if r["pnl"] > 0)
        clo = sum(r["closed"] for r in res.values())
        w = sum(r["wins"] for r in res.values())
        cdn = sum(r["cooldowns"] for r in res.values())
        print(
            f"{label:<36}{tot:>9.1f}%{tot / 9:>8.1f}%{green:>6}/9{clo:>9}"
            f"{(w / clo * 100 if clo else 0):>6.0f}%{cdn:>5}"
        )

    # --- benchmark: ce face o pozitie permanenta pe aceeasi fereastra ------
    print()
    print("=" * 100)
    print("BENCHMARK DECISIV: regula ta vs. o pozitie permanenta pe aceeasi fereastra")
    print("=" * 100)
    always_short = sum(-(C[s][-1] / C[s][START] - 1.0) * 100.0 for s in SYMS)
    always_long = sum((C[s][-1] / C[s][START] - 1.0) * 100.0 for s in SYMS)
    base_tot = sum(scan(C[s])["pnl"] for s in SYMS)
    print(f"  SHORT permanent pe toate 9, fara nimic : {always_short:>+8.1f}%")
    print(f"  LONG permanent pe toate 9, fara nimic  : {always_long:>+8.1f}%")
    print(f"  Regula ta (baseline, scan zilnic)      : {base_tot:>+8.1f}%")
    print()
    print(f"  Diferenta regula - short permanent     : {base_tot - always_short:>+8.1f}%")
    print()
    print("  Daca regula ta nu bate un short permanent, rezultatul ei nu vine din")
    print("  scanare, ci din faptul ca fereastra a cazut. Scanarea adauga doar cost")
    print("  de tranzactionare peste o expunere short pe care o puteai lua gratuit.")

    print()
    print("=" * 100)
    print("EFECTUL FIECAREI PIESE, PE SIMBOL (fata de baseline)")
    print("=" * 100)
    base = {s: scan(C[s])["pnl"] for s in SYMS}
    cd = {s: scan(C[s], cooldown=1)["pnl"] for s in SYMS}
    prot = {s: scan(C[s], sl=0.05, trail=0.08, cooldown=1)["pnl"] for s in SYMS}

    print(f"{'SYM':<6}{'baseline':>11}{'+cooldown':>12}{'delta CD':>11}"
          f"{'+protectii':>13}{'delta PR':>11}")
    print("-" * 100)
    for s in SYMS:
        print(
            f"{s:<6}{base[s]:>10.1f}%{cd[s]:>11.1f}%{cd[s] - base[s]:>+10.1f}%"
            f"{prot[s]:>12.1f}%{prot[s] - cd[s]:>+10.1f}%"
        )
    print("-" * 100)
    print(
        f"{'TOTAL':<6}{sum(base.values()):>10.1f}%{sum(cd.values()):>11.1f}%"
        f"{sum(cd.values()) - sum(base.values()):>+10.1f}%"
        f"{sum(prot.values()):>12.1f}%{sum(prot.values()) - sum(cd.values()):>+10.1f}%"
    )

    # --- cate tranzactii taie cooldown-ul -----------------------------------
    print()
    print("=" * 100)
    print("COOLDOWNUL: ce taie efectiv")
    print("=" * 100)
    print(f"{'SYM':<6}{'intrari fara CD':>17}{'intrari cu CD':>15}{'cooldowns':>11}{'profit pierdut':>16}")
    print("-" * 100)
    for s in SYMS:
        b = scan(C[s])
        k = scan(C[s], cooldown=1)
        print(
            f"{s:<6}{b['entries']:>17}{k['entries']:>15}{k['cooldowns']:>11}"
            f"{cd[s] - base[s]:>+15.1f}%"
        )

    # --- politica grid -> directie -----------------------------------------
    print()
    print("=" * 100)
    print("POLITICA 'grid nu e profitabil -> transform in sell/buy curat'")
    print("=" * 100)
    print("Regula: ER30 < 0.20 -> grid (piata face range).  ER30 > 0.35 -> directie.")
    print("         Intre 0.20 si 0.35 -> nimic.")
    print()
    print(f"{'SYM':<6}{'ER30':>7}{'motor ales':>14}{'rezultat':>11}   motiv")
    print("-" * 100)

    grid_long = {
        "BTC": -23.28, "ETH": -27.36, "SOL": -34.76, "AAVE": -25.62, "SUI": -23.71,
        "ARB": -21.49, "INJ": -5.84, "HYPE": -21.38, "ZEC": -32.16,
    }
    direc = {s: scan(C[s], sl=0.05, trail=0.08, cooldown=1)["pnl"] for s in SYMS}

    chosen_total = 0.0
    used = 0
    for s in SYMS:
        er30 = thesis.efficiency_ratio(C[s], 30)
        if er30 < 0.20:
            engine, val, why = "GRID", grid_long[s], "range, grid are sens"
        elif er30 > 0.35:
            sign = "SHORT" if C[s][-1] < C[s][-15] else "LONG"
            engine, val, why = f"DIRECTIE {sign}", direc[s], "trend, grid ar sta impotriva"
        else:
            engine, val, why = "NIMIC", 0.0, "zona gri, risc fara recompensa"
        if engine != "NIMIC":
            chosen_total += val
            used += 1
        print(f"{s:<6}{er30:>7.3f}{engine:>14}{val:>10.1f}%   {why}")

    print("-" * 100)
    print(f"  Simboluri pe care s-ar tranzactiona ceva: {used}/9")
    print(f"  Total politica: {chosen_total:+.1f}%  (pe capital egalizat per simbol activ)")
    print(f"  Comparativ, grid pe toate 9: {sum(grid_long.values()):+.1f}%")
    print(f"  Comparativ, directie pe toate 9: {sum(direc.values()):+.1f}%")


if __name__ == "__main__":
    main()
