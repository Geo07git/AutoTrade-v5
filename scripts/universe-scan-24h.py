#!/usr/bin/env python3
"""
universe-scan-24h.py
====================
Scan complet al universului _UM_XPERP + selectia celor 10 nume de lucru pe 24h
+ calculul cadentei ciclului.

De ce script local si nu MCP: market_filter e dezactivat (405, confirmat de doua
ori), iar market_get_tickers pe tot SWAP intoarce un payload care nu poate fi
procesat manual. Aici datele se agregă in proces si iese doar sumarul.

Market data pentru _UM_XPERP se ia de pe hostul LIVE (demo=false), conform
regulii din AGENTS.md. Nu se face nicio operatie pe cont, niciun ordin.

Rulare: python scripts/universe-scan-24h.py
"""

from __future__ import annotations

import json
import statistics
import sys
import time
import urllib.error
import urllib.request

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

BASE = "https://www.okx.com"
UA = {"User-Agent": "AutoTrade-v5-scan/1.0"}
BAR = "1Dutc"
LIMIT = 90
SLEEP = 0.12


def get(path: str, retries: int = 3) -> dict:
    for attempt in range(retries):
        try:
            req = urllib.request.Request(BASE + path, headers=UA)
            with urllib.request.urlopen(req, timeout=25) as r:
                return json.load(r)
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            if attempt == retries - 1:
                raise
            time.sleep(1.0 + attempt)
    return {}


def universe() -> list[str]:
    """Toate instrumentele _UM_XPERP, din SWAP si FUTURES."""
    found: set[str] = set()
    for inst_type in ("SWAP", "FUTURES"):
        try:
            payload = get(f"/api/v5/market/tickers?instType={inst_type}")
        except Exception as e:  # noqa: BLE001
            print(f"  [warn] tickers {inst_type}: {e}")
            continue
        rows = payload.get("data", [])
        hits = [r.get("instId", "") for r in rows if "UM_XPERP" in r.get("instId", "")]
        print(f"  {inst_type}: {len(rows)} instrumente, {len(hits)} cu UM_XPERP")
        found.update(hits)
    return sorted(found)


def candles(inst: str) -> list[float]:
    """Close zilnice, ordonate vechi -> nou."""
    payload = get(f"/api/v5/market/candles?instId={inst}&bar={BAR}&limit={LIMIT}")
    rows = payload.get("data", [])
    rows.sort(key=lambda r: int(r[0]))
    return [float(r[4]) for r in rows]


def er(c: list[float], n: int) -> float:
    if len(c) < n + 1:
        return 0.0
    w = c[-n - 1:]
    net = abs(w[-1] - w[0])
    path = sum(abs(w[k] - w[k - 1]) for k in range(1, len(w)))
    return net / path if path else 0.0


def ret(c: list[float], n: int) -> float:
    if len(c) < n + 1:
        return 0.0
    return (c[-1] / c[-n - 1] - 1.0) * 100.0


def pos_in_range(c: list[float], n: int = 90) -> float:
    w = c[-n:]
    lo, hi = min(w), max(w)
    return (c[-1] - lo) / (hi - lo) if hi > lo else 0.5


def variant3(c: list[float], tp: float = 0.10, cooldown: int = 1,
             look: int = 14, thr: float = 0.35, fee: float = 0.0005,
             start: int = 30) -> dict:
    """Scan zilnic + TP + cooldown, fara SL/trailing (varianta castigatoare)."""
    pos, entry = 0.0, None
    pnl, cool = 0.0, 0
    closed = wins = 0
    holds: list[int] = []
    open_bar = 0
    for i in range(start, len(c) - 1):
        px = c[i]
        if pos != 0.0:
            r = pos * (px - entry) / entry
            if r >= tp:
                pnl -= fee
                closed += 1
                if r > 0:
                    wins += 1
                holds.append(i - open_bar)
                pos, entry = 0.0, None
                cool = cooldown
        if cool > 0:
            cool -= 1
        w = c[i - look:i + 1]
        path = sum(abs(w[q] - w[q - 1]) for q in range(1, len(w)))
        e = abs(w[-1] - w[0]) / path if path else 0.0
        rr = w[-1] / w[0] - 1.0
        want = (1.0 if rr > 0 else -1.0) if e > thr else 0.0
        if want != 0.0 and want != pos:
            if pos != 0.0:
                pnl -= fee
                closed += 1
                holds.append(i - open_bar)
                pos, entry = 0.0, None
            if cool == 0:
                pos, entry, open_bar = want, px, i
                pnl -= fee
        pnl += pos * (c[i + 1] / c[i] - 1.0)
    return dict(
        pnl=pnl * 100.0,
        closed=closed,
        wins=wins,
        avg_hold=statistics.fmean(holds) if holds else 0.0,
    )


def main() -> None:
    print("=" * 104)
    print("SCAN UNIVERS _UM_XPERP — market data live (demo=false), fara operatii pe cont")
    print("=" * 104)

    insts = universe()
    print(f"  Instrumente _UM_XPERP gasite: {len(insts)}")
    if not insts:
        print("  Nu am putut obtine universul. Verifica accesul la reteaua OKX.")
        return

    print(f"  Descarc {min(len(insts), 200)} serii de 90 bare zilnice...")
    data: dict[str, list[float]] = {}
    for n, inst in enumerate(insts, 1):
        try:
            c = candles(inst)
            if len(c) >= 60:
                data[inst] = c
        except Exception as e:  # noqa: BLE001
            print(f"    [skip] {inst}: {e}")
        if n % 40 == 0:
            print(f"    ... {n}/{len(insts)}")
        time.sleep(SLEEP)
    print(f"  Serii valide (>=60 bare): {len(data)}")

    # --- clasificare -------------------------------------------------------
    rows = []
    for inst, c in data.items():
        rows.append(dict(
            inst=inst,
            er30=er(c, 30),
            er14=er(c, 14),
            r7=ret(c, 7),
            r14=ret(c, 14),
            r30=ret(c, 30),
            pos90=pos_in_range(c),
            px=c[-1],
        ))

    for thr in (0.35, 0.30, 0.25):
        k = sum(1 for r in rows if r["er30"] > thr and abs(r["r14"]) > 15)
        print(f"  Candidati cu ER30>{thr:.2f} si |ret14|>15%: {k}")

    # --- selectia celor 10 -------------------------------------------------
    cands = [r for r in rows if r["er30"] > 0.25 and abs(r["r14"]) > 10]
    cands.sort(key=lambda r: r["er30"], reverse=True)
    picks = cands[:10]

    print()
    print("=" * 104)
    print("CEI 10 PENTRU URMATOARELE 24h (ordonati dupa persistenta trendului)")
    print("=" * 104)
    print(f"{'#':<3}{'instrument':<28}{'dir':>6}{'ret7':>8}{'ret14':>8}{'ret30':>8}"
          f"{'ER30':>7}{'poz90':>7}{'pret':>12}")
    print("-" * 104)
    for n, r in enumerate(picks, 1):
        d = "SHORT" if r["r14"] < 0 else "LONG"
        print(
            f"{n:<3}{r['inst']:<28}{d:>6}{r['r7']:>7.1f}%{r['r14']:>7.1f}%"
            f"{r['r30']:>7.1f}%{r['er30']:>7.3f}{r['pos90']:>7.2f}{r['px']:>12.6g}"
        )

    longs = sum(1 for r in picks if r["r14"] > 0)
    print("-" * 104)
    print(f"  Directie: {longs} LONG / {len(picks) - longs} SHORT")

    # --- cadenta: durata medie de tranzactie pe picks ----------------------
    print()
    print("=" * 104)
    print("CALCULUL CADENTEI (varianta 3: scan zilnic + TP 10% + cooldown 24h)")
    print("=" * 104)
    print(f"{'instrument':<28}{'tranzactii':>12}{'win%':>7}{'durata medie':>15}{'pnl':>10}")
    print("-" * 104)
    holds, trades, pnls, wins_t = [], 0, [], 0
    for r in picks:
        s = variant3(data[r["inst"]])
        if s["closed"]:
            holds.append(s["avg_hold"])
        trades += s["closed"]
        wins_t += s["wins"]
        pnls.append(s["pnl"])
        print(
            f"{r['inst']:<28}{s['closed']:>12}"
            f"{(s['wins'] / s['closed'] * 100 if s['closed'] else 0):>6.0f}%"
            f"{s['avg_hold']:>14.1f}z{s['pnl']:>9.1f}%"
        )

    print("-" * 104)
    avg_hold = statistics.fmean(holds) if holds else 0.0
    span = 60.0
    print(f"  Total tranzactii inchise: {trades}   win rate: "
          f"{(wins_t / trades * 100 if trades else 0):.0f}%")
    print(f"  Durata medie de tranzactie: {avg_hold:.1f} zile")
    print(f"  PnL mediu pe simbol: {statistics.fmean(pnls):+.1f}% "
          f"(pe fereastra de {span:.0f} zile)")

    print()
    print("  DIN CARE REZULTA:")
    if avg_hold > 0:
        print(f"    - un slot de capital se elibereaza la fiecare {avg_hold:.1f} zile")
        print(f"    - cu 1 slot activ:  {1 / avg_hold:.2f} tranzactii/zi")
        for k in (3, 5, 10):
            print(f"    - cu {k:>2} sloturi active: {k / avg_hold:.2f} tranzactii/zi")
        daily = trades / (len(picks) * span / 10.0)
        print(f"    - oferta de semnale: {trades} tranzactii / {len(picks)} nume / "
              f"{span:.0f} zile = {trades / len(picks) / span:.3f} per nume pe zi")
        print(f"    - cu 10 nume in lista: {trades / span * 10 / len(picks):.2f} "
              f"semnal(e)/zi disponibile")
        print()
        print(f"    CADENTA RECOMANDATA DE SCAN: 24h (fix, la ora fixa).")
        print(f"    CADENTA DE ROTATIE: imediat la inchidere, fara asteptare.")
        print(f"    NUMAR MINIM DE SLOTURI: {max(3, round(avg_hold))} — sub asta "
              f"stai cu capitalul idle intre tranzactii.")
    print()
    print("  NOTA: fereastra de 60 de zile a fost una de cadere generala (media")
    print("  universului -36%). Cifrele de mai sus masoara beta short, nu alpha.")


if __name__ == "__main__":
    main()
