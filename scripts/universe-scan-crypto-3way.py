#!/usr/bin/env python3
"""
universe-scan-crypto-3way.py
============================
Scan al universului tradabil DEFINIT de isTradableXPerp din
src/server/scanner/UniverseManager.ts:

    state === 'live'  &&  instId contine '_UM_XPERP'  &&  instCategory nu in {3,4,5,6,7}

Adica: crypto doar. Tokenized stocks/metals/commodities/FX/bonds sunt excluse,
pentru ca mostenesc program de bursa si actiuni corporative pe care un sistem
crypto nu le modeleaza.

Inlocuieste scripts/universe-scan-24h.py, care folosea www.okx.com fara
instCategory si ajungea sa propuna actiuni tokenizate (ANTHROPIC, CRCL).

Fiecare contract este analizat in TREI directii — LONG, SHORT si NEUTRAL (grid) —
si clasificat dupa dovezi, nu dupa o directie impusa.

Apoi clasificatorul este VALIDAT istoric: pentru fiecare bara din trecut aplic
clasificarea si masor randamentul urmator la 5 zile.

Host: eea.okx.com (acelasi pe care il foloseste UniverseManager). Market data
public pentru _UM_XPERP => demo=false, conform AGENTS.md. Niciun ordin.

Rulare: python scripts/universe-scan-crypto-3way.py
"""

from __future__ import annotations

import json
import statistics
import sys
import time
import urllib.error
import urllib.request

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

BASE = "https://eea.okx.com"
UA = {"User-Agent": "AutoTrade-v5-scan/1.1", "Accept": "application/json"}
BAR = "1Dutc"
FWD = 5
NON_CRYPTO = {"3", "4", "5", "6", "7"}


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


# --- regula casei, replicata exact din UniverseManager.ts -------------------
def is_tokenized_rwa(inst_category: object) -> bool:
    return str(inst_category if inst_category is not None else "").strip() in NON_CRYPTO


def is_tradable_xperp(inst: dict) -> bool:
    return (
        str(inst.get("state", "")) == "live"
        and "_UM_XPERP" in str(inst.get("instId", ""))
        and not is_tokenized_rwa(inst.get("instCategory"))
    )


def fetch_instruments() -> list[dict]:
    payload = get("/api/v5/public/instruments?instType=FUTURES")
    return payload.get("data", []) or []


def candles(inst: str) -> list[float]:
    payload = get(f"/api/v5/market/candles?instId={inst}&bar={BAR}&limit=90")
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
    """Trei directii, reguli explicite. Returneaza (clasa, metrici)."""
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
    print("=" * 104)
    print("UNIVERS TRADABIL — regula isTradableXPerp (crypto-only), host eea.okx.com")
    print("=" * 104)

    insts = fetch_instruments()
    if not insts:
        print("  Nu am putut obtine instrumentele.")
        return

    cats: dict[str, int] = {}
    xperp = 0
    for i in insts:
        if "_UM_XPERP" in str(i.get("instId", "")) and str(i.get("state", "")) == "live":
            xperp += 1
            k = str(i.get("instCategory", "")).strip() or "(lipsa)"
            cats[k] = cats.get(k, 0) + 1

    print(f"  Contracte _UM_XPERP live: {xperp}")
    for k in sorted(cats):
        label = {"1": "crypto", "3": "actiuni", "4": "metale",
                 "5": "marfuri", "6": "FX", "7": "obligatiuni"}.get(k, "necunoscut")
        mark = "   <-- EXCLUS de regula casei" if k in NON_CRYPTO else ""
        print(f"    categoria {k:<8} {label:<14} {cats[k]:>4}{mark}")

    tradable = [i for i in insts if is_tradable_xperp(i)]
    excluded = [
        i for i in insts
        if "_UM_XPERP" in str(i.get("instId", ""))
        and str(i.get("state", "")) == "live"
        and not is_tradable_xperp(i)
    ]
    print(f"\n  Univers tradabil dupa regula casei: {len(tradable)}")
    print(f"  Excluse (tokenized RWA): {len(excluded)}")
    if excluded:
        ex = ", ".join(str(i.get("instId", "")).split("-")[0] for i in excluded[:12])
        print(f"    exemple: {ex} ...")

    print(f"\n  Descarc {len(tradable)} serii de 90 bare zilnice...")
    data: dict[str, list[float]] = {}
    for n, inst in enumerate(tradable, 1):
        iid = str(inst.get("instId", ""))
        try:
            c = candles(iid)
            if len(c) >= 60:
                data[iid] = c
        except Exception as e:  # noqa: BLE001
            print(f"    [skip] {iid}: {e}")
        if n % 50 == 0:
            print(f"    ... {n}/{len(tradable)}")
        time.sleep(0.05)
    print(f"  Serii valide (>=60 bare): {len(data)}")

    today = []
    for iid, c in data.items():
        cls, m = classify(c, len(c) - 1)
        m["inst"] = iid
        m["cls"] = cls
        m["px"] = c[-1]
        today.append(m)

    dist: dict[str, int] = {}
    for r in today:
        dist[r["cls"]] = dist.get(r["cls"], 0) + 1

    print()
    print("=" * 104)
    print("CLASIFICARE AZI — trei directii evaluate pentru fiecare contract")
    print("=" * 104)
    for k in ("LONG", "SHORT", "NEUTRAL", "NO_TRADE"):
        n = dist.get(k, 0)
        pct = n / len(today) * 100 if today else 0
        print(f"  {k:<10}{n:>5}  ({pct:>5.1f}%)")

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

    show("LONG — uptrend persistent", "LONG",
         lambda r: r["er30"] * abs(r["r30"]) * (1.25 - r["pz"]))
    show("SHORT — downtrend persistent", "SHORT",
         lambda r: r["er30"] * abs(r["r30"]) * (0.75 + r["pz"]))
    show("NEUTRAL — potrivit pentru grid", "NEUTRAL",
         lambda r: (0.25 - r["er30"]) * 100 + (0.5 - abs(r["pz"] - 0.5)) * 20)

    print()
    print("=" * 104)
    print(f"VALIDARE: clasificarea de la bara i prezice randamentul pe {FWD} zile?")
    print("=" * 104)

    buckets: dict[str, list[float]] = {"LONG": [], "SHORT": [], "NEUTRAL": [], "NO_TRADE": []}
    for c in data.values():
        for i in range(31, len(c) - FWD):
            cls, _ = classify(c, i)
            buckets[cls].append((c[i + FWD] / c[i] - 1.0) * 100.0)

    print(f"  {'clasa':<10}{'n':>8}{'fwd mediu':>12}{'t-stat':>9}{'hit%':>8}   semn corect?")
    print("  " + "-" * 84)
    verdicts = {}
    for cls in ("LONG", "SHORT", "NEUTRAL", "NO_TRADE"):
        xs = buckets[cls]
        if len(xs) < 3:
            print(f"  {cls:<10}{len(xs):>8}   (prea putine)")
            continue
        m = statistics.fmean(xs)
        sd = statistics.stdev(xs)
        t = m / (sd / len(xs) ** 0.5) if sd else 0.0
        hit = sum(1 for x in xs if x > 0) / len(xs) * 100
        if cls == "LONG":
            ok = "DA" if m > 0 and t > 1.5 else "nu"
        elif cls == "SHORT":
            ok = "DA" if m < 0 and t < -1.5 else "nu"
        else:
            ok = "DA" if abs(m) < 1.0 else "nu"
        verdicts[cls] = (m, t, ok)
        print(f"  {cls:<10}{len(xs):>8}{m:>11.2f}%{t:>9.2f}{hit:>7.0f}%   {ok}")

    print()
    print("  Citire: LONG vrea fwd mediu POZITIV cu t>1.5; SHORT vrea fwd mediu")
    print("  NEGATIV cu t<-1.5 (pretul cade => shortul castiga); NEUTRAL vrea fwd ~0.")

    print()
    print("=" * 104)
    print("CONCLUZIE")
    print("=" * 104)
    good = [k for k, v in verdicts.items() if v[2] == "DA"]
    if good:
        print(f"  Clase cu semn corect si semnificativ: {', '.join(good)}")
    else:
        print("  NICIO clasa nu are semn corect cu |t| > 1.5 pe aceasta fereastra.")
        print("  Clasificarea descrie bine situatia de AZI, dar nu prezice maine.")
        print("  => o folosim ca filtru de risc, nu ca predictor de directie.")
    print()
    print(f"  Esantion: {sum(len(v) for v in buckets.values())} observatii "
          f"({len(data)} contracte x ~55 bare).")


if __name__ == "__main__":
    main()
