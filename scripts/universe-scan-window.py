#!/usr/bin/env python3
"""
universe-scan-window.py
=======================
Acceasi analiza ca universe-scan-crypto-3way.py, dar pe o fereastra ISTORICA
aleasa din argument, ca sa raspunda la intrebarea:

    Clasificatorul LONG/SHORT/NEUTRAL produce LONG intr-o piata care URCA?
    Si urca coșul LONG atunci?

Univers: regula isTradableXPerp din src/server/scanner/UniverseManager.ts
(crypto only, fara tokenized stocks/metals).

Utilizare:
    python scripts/universe-scan-window.py                # implicit: nov 2024 - ian 2025
    python scripts/universe-scan-window.py 1740787200000  # alta fereastra (ms epoch, capat)

Market data public _UM_XPERP => demo=false. Niciun ordin.
"""

from __future__ import annotations

import json
import statistics
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

BASE = "https://eea.okx.com"
UA = {"User-Agent": "AutoTrade-v5-scan/1.2", "Accept": "application/json"}
BAR = "1Dutc"
FWD = 5
NON_CRYPTO = {"3", "4", "5", "6", "7"}

# 2025-02-01 00:00 UTC — fereastra rezultata: ~3 nov 2024 .. 31 ian 2025
DEFAULT_AFTER = 1738368000000


def get(path: str, retries: int = 3) -> dict:
    for attempt in range(retries):
        try:
            req = urllib.request.Request(BASE + path, headers=UA)
            with urllib.request.urlopen(req, timeout=25) as r:
                return json.load(r)
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
            if attempt == retries - 1:
                raise
            time.sleep(1.0 + attempt)
    return {}


def is_tokenized_rwa(cat: object) -> bool:
    return str(cat if cat is not None else "").strip() in NON_CRYPTO


def is_tradable_xperp(inst: dict) -> bool:
    return (
        str(inst.get("state", "")) == "live"
        and "_UM_XPERP" in str(inst.get("instId", ""))
        and not is_tokenized_rwa(inst.get("instCategory"))
    )


def candles(inst: str, after: int) -> list[float]:
    payload = get(
        f"/api/v5/market/candles?instId={inst}&bar={BAR}&limit=120&after={after}"
    )
    rows = payload.get("data", [])
    rows.sort(key=lambda r: int(r[0]))
    return [float(r[4]) for r in rows]


def er(c: list[float], i: int, n: int) -> float:
    if i - n < 0:
        return 0.0
    w = c[i - n:i + 1]
    net = abs(w[-1] - w[0])
    path = sum(abs(w[k] - w[k - 1]) for k in range(1, len(w)))
    return net / path if path else 0.0


def rret(c: list[float], i: int, n: int) -> float:
    if i - n < 0:
        return 0.0
    return (c[i] / c[i - n] - 1.0) * 100.0


def pos_in_range(c: list[float], i: int, n: int = 90) -> float:
    w = c[max(0, i - n + 1):i + 1]
    lo, hi = min(w), max(w)
    return (c[i] - lo) / (hi - lo) if hi > lo else 0.5


def classify(c: list[float], i: int) -> tuple[str, dict]:
    e30, e14 = er(c, i, 30), er(c, i, 14)
    r30, r14 = rret(c, i, 30), rret(c, i, 14)
    pz = pos_in_range(c, i)
    m = dict(er30=e30, er14=e14, r30=r30, r14=r14, pz=pz)
    if r30 <= -10.0 and e30 >= 0.35:
        return "SHORT", m
    if r30 >= 10.0 and e30 >= 0.35:
        return "LONG", m
    if e30 < 0.25 and 0.25 <= pz <= 0.75:
        return "NEUTRAL", m
    return "NO_TRADE", m


def main() -> None:
    after = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_AFTER
    when = datetime.fromtimestamp(after / 1000, tz=timezone.utc)

    print("=" * 104)
    print(f"SCAN PE FEREASTRA ISTORICA — capat: {when:%Y-%m-%d} UTC (barele dinaintea acestei date)")
    print("=" * 104)

    insts = get("/api/v5/public/instruments?instType=FUTURES").get("data", []) or []
    tradable = [i for i in insts if is_tradable_xperp(i)]
    print(f"  Univers tradabil dupa regula casei: {len(tradable)}")

    print(f"  Descarc serii de 120 bare pentru {len(tradable)} contracte...")
    data: dict[str, list[float]] = {}
    empty = 0
    for n, inst in enumerate(tradable, 1):
        iid = str(inst.get("instId", ""))
        try:
            c = candles(iid, after)
            if len(c) >= 60:
                data[iid] = c
            else:
                empty += 1
        except Exception:  # noqa: BLE001
            empty += 1
        if n % 50 == 0:
            print(f"    ... {n}/{len(tradable)}")
        time.sleep(0.05)

    print(f"  Serii valide (>=60 bare): {len(data)}   |   fara istoric in fereastra: {empty}")
    if len(data) < 20:
        print("\n  Prea putine serii in aceasta fereastra (contractele sunt listate recent).")
        print("  Alege alta fereastra: python scripts/universe-scan-window.py <ms_epoch>")
        return

    # --- confirmam ca fereastra chiar a urcat --------------------------------
    chg = []
    for c in data.values():
        if len(c) >= 60:
            chg.append((c[-1] / c[-60] - 1.0) * 100.0)
    print(f"\n  Randament mediu al universului pe fereastra: {statistics.fmean(chg):+.1f}%")
    print(f"  Contracte care au urcat: {sum(1 for x in chg if x > 0)}/{len(chg)}")

    # --- clasificare la finalul ferestrei -----------------------------------
    today = []
    for iid, c in data.items():
        cls, m = classify(c, len(c) - 1)
        m.update(inst=iid, cls=cls, px=c[-1])
        today.append(m)

    dist: dict[str, int] = {}
    for r in today:
        dist[r["cls"]] = dist.get(r["cls"], 0) + 1

    print()
    print("=" * 104)
    print("CLASIFICARE LA FINALUL FERESTREI")
    print("=" * 104)
    for k in ("LONG", "SHORT", "NEUTRAL", "NO_TRADE"):
        n = dist.get(k, 0)
        print(f"  {k:<10}{n:>5}  ({n / len(today) * 100:>5.1f}%)")

    def show(title: str, cls: str, key, top: int = 5) -> None:
        rows = [r for r in today if r["cls"] == cls]
        if not rows:
            print(f"\n  {title}: niciun candidat")
            return
        rows.sort(key=key, reverse=True)
        print()
        print(f"  {title} (top {min(top, len(rows))} din {len(rows)})")
        print(f"  {'instrument':<30}{'ret30':>9}{'ret14':>9}{'ER30':>7}{'poz90':>7}{'pret':>13}")
        print("  " + "-" * 78)
        for r in rows[:top]:
            print(f"  {r['inst']:<30}{r['r30']:>8.1f}%{r['r14']:>8.1f}%"
                  f"{r['er30']:>7.3f}{r['pz']:>7.2f}{r['px']:>13.6g}")

    show("LONG", "LONG", lambda r: r["er30"] * abs(r["r30"]) * (1.25 - r["pz"]))
    show("SHORT", "SHORT", lambda r: r["er30"] * abs(r["r30"]) * (0.75 + r["pz"]))
    show("NEUTRAL", "NEUTRAL",
         lambda r: (0.25 - r["er30"]) * 100 + (0.5 - abs(r["pz"] - 0.5)) * 20)

    # --- validare in fereastra ---------------------------------------------
    print()
    print("=" * 104)
    print(f"VALIDARE IN FEREASTRA: clasificarea la bara i -> randament pe {FWD} zile")
    print("=" * 104)
    buckets: dict[str, list[float]] = {"LONG": [], "SHORT": [], "NEUTRAL": [], "NO_TRADE": []}
    for c in data.values():
        for i in range(31, len(c) - FWD):
            cls, _ = classify(c, i)
            buckets[cls].append((c[i + FWD] / c[i] - 1.0) * 100.0)

    print(f"  {'clasa':<10}{'n':>8}{'fwd mediu':>12}{'t-stat':>9}{'t corectat':>12}{'hit%':>8}")
    print("  " + "-" * 88)
    days = 60.0
    for cls in ("LONG", "SHORT", "NEUTRAL", "NO_TRADE"):
        xs = buckets[cls]
        if len(xs) < 3:
            print(f"  {cls:<10}{len(xs):>8}   (prea putine)")
            continue
        m = statistics.fmean(xs)
        sd = statistics.stdev(xs)
        t = m / (sd / len(xs) ** 0.5) if sd else 0.0
        # corectie pentru pseudo-replicare: observatiile nu sunt independente
        t_eff = t * (days / len(xs)) ** 0.5 if len(xs) > days else t
        hit = sum(1 for x in xs if x > 0) / len(xs) * 100
        print(f"  {cls:<10}{len(xs):>8}{m:>11.2f}%{t:>9.2f}{t_eff:>12.2f}{hit:>7.0f}%")

    print()
    print("  't corectat' = t * sqrt(zile / observatii): corectia pentru faptul ca")
    print("  cele ~145 de contracte se misca aproape impreuna, deci esantionul efectiv")
    print("  este numarul de ZILE, nu numarul de observatii.")

    # --- comparatie relativa ------------------------------------------------
    print()
    print("=" * 104)
    print("SEMNAL RELATIV (fata de coșul NO_TRADE = aproximarea pietei)")
    print("=" * 104)
    base = statistics.fmean(buckets["NO_TRADE"]) if buckets["NO_TRADE"] else 0.0
    for cls in ("LONG", "SHORT", "NEUTRAL"):
        xs = buckets[cls]
        if not xs:
            continue
        m = statistics.fmean(xs)
        print(f"  {cls:<10}{m:>8.2f}%   fata de piata: {m - base:>+7.2f}pp")
    if buckets["LONG"] and buckets["SHORT"]:
        spread = statistics.fmean(buckets["LONG"]) - statistics.fmean(buckets["SHORT"])
        print(f"\n  Spread LONG - SHORT: {spread:>+7.2f}pp pe {FWD} zile")


if __name__ == "__main__":
    main()
