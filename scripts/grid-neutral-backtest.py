#!/usr/bin/env python3
"""
grid-neutral-backtest.py
========================
Testul decisiv pentru teza "piata e in range, deci grid-ul trebuie sa mearga".

Nu ne mai uitam la indicatori pasivi: simulam exact mecanica unui grid neutru
AUTO-LIMIT (ladder de limit orders + TP la un nivel distanta) pe fiecare din
cele 9 contracte, pe aceeasi fereastra de 90 de bare zilnice.

Reguli simulate (identice cu un grid neutru clasic):
  1. Band = [min, max] al primelor 30 bare (formare), 20 de niveluri echidistante.
  2. Cand pretul traverseaza un nivel in jos  -> BUY la acel nivel (daca nivelul e liber).
  3. Cand pretul traverseaza nivelul de deasupra in sus -> SELL, TP = 1 spacing.
  4. Fee platit pe ambele picioare (implicit 0.05%/side, taker OKX).
  5. La final: inventarul ramas e marcat la piata (floating).

Raspunde la: "daca as fi pus grid acum 60 de zile, as fi castigat?"

Rulare: python scripts/grid-neutral-backtest.py
"""

from __future__ import annotations

import importlib.util
import os
import statistics

_HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location(
    "thesis", os.path.join(_HERE, "grid-range-thesis-test.py")
)
assert _spec and _spec.loader
thesis = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(thesis)

CLOSES: dict[str, list[float]] = thesis.CLOSES
efficiency_ratio = thesis.efficiency_ratio

WARMUP = 30
LEVELS = 20
FEE = 0.0005  # 0.05% per side (taker). Maker-ul OKX e ~0.02%, vezi FEE_MAKER.


def run_grid(closes: list[float], fee: float = FEE, levels: int = LEVELS) -> dict:
    """Simuleaza un grid neutru si returneaza statisticile."""
    band_lo, band_hi = min(closes[:WARMUP]), max(closes[:WARMUP])
    spacing = (band_hi - band_lo) / (levels - 1)
    lv = [band_lo + i * spacing for i in range(levels)]

    holding: dict[int, float] = {}   # nivel -> pret de intrare
    realized = 0.0                   # USDT per 1 unitate de qty
    round_trips = 0
    buys = 0
    breaches = 0                     # bare cu pretul in afara benzii
    max_inventory = 0.0

    for i in range(WARMUP, len(closes)):
        a, b = closes[i - 1], closes[i]

        # bare in afara benzii: gridul nu mai are niveluri acolo (range breakout)
        if b < band_lo or b > band_hi:
            breaches += 1

        lo, hi = (a, b) if a <= b else (b, a)
        going_up = b > a

        # nivelurile traversate, in ordinea in care le atinge pretul
        crossed = [j for j, p in enumerate(lv) if lo < p < hi]
        if going_up:
            crossed.reverse()

        for j in crossed:
            price = lv[j]
            if not going_up:
                # coborare: BUY daca nivelul e liber
                if j not in holding:
                    holding[j] = price
                    buys += 1
            else:
                # urcare: inchide pozitiile care si-au atins TP (un nivel mai sus)
                for k in list(holding):
                    if lv[k] + spacing <= price:
                        entry = holding.pop(k)
                        exit_px = entry + spacing
                        realized += exit_px - entry - fee * entry - fee * exit_px
                        round_trips += 1

        max_inventory = max(max_inventory, float(len(holding)))

    final_px = closes[-1]
    floating = sum(final_px - entry for entry in holding.values())
    net = realized + floating
    ladder_capital = sum(lv)  # notional daca toate nivelurile ar fi pline

    notional = sum(holding.values()) + realized
    return dict(
        band=(band_lo, band_hi),
        spacing_pct=spacing / band_lo * 100.0,
        fills=buys,
        round_trips=round_trips,
        realized=realized,
        floating=floating,
        net=net,
        open_positions=len(holding),
        max_inventory=max_inventory,
        breaches=breaches,
        exposure_pct=(sum(holding.values()) / (band_hi - band_lo) * 100.0) if band_hi > band_lo else 0.0,
        final_in_band=band_lo <= final_px <= band_hi,
        notional=notional,
        ladder_capital=ladder_capital,
        net_pct=net / ladder_capital * 100.0 if ladder_capital else 0.0,
        realized_pct=realized / ladder_capital * 100.0 if ladder_capital else 0.0,
        floating_pct=floating / ladder_capital * 100.0 if ladder_capital else 0.0,
        ret=(final_px / closes[WARMUP] - 1.0) * 100.0,
    )


def main() -> None:
    print("=" * 104)
    print("BACKTEST GRID NEUTRU — 9 contracte _UM_XPERP, 90 bare zilnice")
    print(f"Band din primele {WARMUP} bare, {LEVELS} niveluri, fee {FEE * 100:.2f}%/picior (taker)")
    print("Rezultatul = ce ar fi facut gridul pe 1 unitate de qty per nivel, in USDT.")
    print("=" * 104)

    hdr = (
        f"{'SYM':<6}{'spacing%':>9}{'fills':>7}{'RT':>5}{'ret_hold%':>10}"
        f"{'realiz%':>9}{'float%':>9}{'NET%':>8}{'maxPoz':>7}{'brk':>5}{'inBand':>7}{'ER30':>7}"
    )
    print(hdr)
    print("-" * 104)

    results = []
    for sym in ("BTC", "ETH", "SOL", "AAVE", "SUI", "ARB", "INJ", "HYPE", "ZEC"):
        c = list(reversed(CLOSES[sym]))
        r = run_grid(c)
        r["sym"] = sym
        r["er30"] = efficiency_ratio(c, 30)
        r["er90"] = efficiency_ratio(c, 90)
        results.append(r)
        print(
            f"{sym:<6}{r['spacing_pct']:>9.2f}{r['fills']:>7}{r['round_trips']:>5}"
            f"{r['ret']:>10.1f}{r['realized_pct']:>9.2f}{r['floating_pct']:>9.2f}"
            f"{r['net_pct']:>8.2f}{r['max_inventory']:>7.0f}{r['breaches']:>5}"
            f"{('DA' if r['final_in_band'] else 'NU'):>7}{r['er30']:>7.3f}"
        )

    total_realized = sum(r["realized"] for r in results)
    winners = sum(1 for r in results if r["net"] > 0)
    avg_net_pct = statistics.fmean(r["net_pct"] for r in results)

    print("-" * 104)
    print(
        f"{'MEDIE':<6}{'':>9}{sum(r['fills'] for r in results):>7}"
        f"{sum(r['round_trips'] for r in results):>5}{'':>10}"
        f"{statistics.fmean(r['realized_pct'] for r in results):>9.2f}"
        f"{statistics.fmean(r['floating_pct'] for r in results):>9.2f}"
        f"{avg_net_pct:>8.2f}"
    )
    print()
    print(f"Simboluri pe profit: {winners}/9")
    print(f"Grid profit realizat, absolut (mecanica pura): {total_realized:+.3f} USDT")
    print(f"NET mediu pe capitalul scarii:                {avg_net_pct:+.2f}%")
    print("realiz%/float%/NET% sunt raportate la notionalul intregii scari (20 niveluri),".rjust(0))
    print("deci comparabile intre simboluri de preturi foarte diferite.")
    print()
    print("Interpretare: daca 'realizat' e pozitiv dar 'floating' e puternic negativ,")
    print("gridul a functionat pe hartie si a pierdut pe inventar — semnatura unui range")
    print("care s-a spart in jos, nu a unui range care tine.")

    # --- testul statistic central -------------------------------------------
    print()
    print("=" * 104)
    print("TEST: ER prezice profitul de grid?")
    print("=" * 104)
    for key in ("er30", "er90"):
        pairs = [(r[key], r["net_pct"]) for r in results if r[key] == r[key]]
        xs = [p[0] for p in pairs]
        ys = [p[1] for p in pairs]
        mx, my = statistics.fmean(xs), statistics.fmean(ys)
        cov = sum((x - mx) * (y - my) for x, y in pairs) / len(pairs)
        sx, sy = statistics.pstdev(xs), statistics.pstdev(ys)
        corr = cov / (sx * sy) if sx and sy else float("nan")
        print(f"  corelatie {key} vs NET grid:  r = {corr:+.3f}   (n={len(pairs)})")

    print()
    print("  Teza 'range -> grid merge' cere r NEGATIV (ER mic => profit mare).")

    # --- contributia componentei de inventar --------------------------------
    print()
    print("=" * 104)
    print("DEFALCARE: cat din rezultat vine din mecanica de grid vs. din directia pietei")
    print("=" * 104)
    print(f"{'SYM':<6}{'realiz%':>10}{'float%':>10}{'NET%':>10}   verdict")
    print("-" * 104)
    for r in sorted(results, key=lambda x: x["net_pct"]):
        if r["net_pct"] < 0 and r["realized_pct"] > 0:
            v = "grid castiga, inventarul pierde  <- capcana"
        elif r["net_pct"] < 0:
            v = "grid si inventar pierd"
        else:
            v = "ok"
        print(f"{r['sym']:<6}{r['realized_pct']:>10.2f}{r['floating_pct']:>10.2f}{r['net_pct']:>10.2f}   {v}")

    # --- senzitivitate la fees ----------------------------------------------
    print()
    print("=" * 104)
    print("SENZITIVITATE LA FEE (maker 0.02% vs taker 0.05%)")
    print("=" * 104)
    for fee, label in ((0.0002, "maker 0.02%"), (0.0005, "taker 0.05%")):
        pcts = [run_grid(list(reversed(CLOSES[s])), fee=fee)["net_pct"] for s in CLOSES]
        print(f"  {label}: NET mediu = {statistics.fmean(pcts):+.2f}% din capitalul scarii")


if __name__ == "__main__":
    main()
