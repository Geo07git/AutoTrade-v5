#!/usr/bin/env python3
"""
classifier-regime-test.py
=========================
Universul _UM_XPERP e prea tanar ca sa contina o piata care urca (cea mai veche
listare: 2026-03-30). Deci intrebarea "clasificatorul produce LONG si castiga
cand piata urca?" nu se poate raspunde pe XPERP.

Dar clasificatorul e generic (ER, ret30, poz90). Il testam pe perp-uri USDT cu
istoric lung, pe mai multe regimuri de piata (bull si bear), ca sa vedem daca
este simetric sau e un short-machine.

Metoda:
  - esantion: perp-uri USDT-SWAP lichide
  - istoric: pana la ~2.5 ani (paginare inapoi)
  - pentru fiecare bara: clasificare LONG/SHORT/NEUTRAL/NO_TRADE
  - randament urmator pe 5 zile
  - EXCES = randamentul activului - randamentul mediu al pietei in aceeasi zi
    (asta elimina driftul de piata si izoleaza valoarea de selectie)
  - impartire pe regim: zile de bull (piata urca) vs bear (piata cade)

Market data public. Niciun ordin, nicio operatie pe cont.
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
UA = {"User-Agent": "AutoTrade-v5-test/1.0", "Accept": "application/json"}
FWD = 5
PAGES = 3
BARS_PER_PAGE = 300


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


def liquid_perps(limit: int = 30) -> list[str]:
    tk = get("/api/v5/market/tickers?instType=SWAP").get("data", []) or []
    rows = []
    for t in tk:
        iid = str(t.get("instId", ""))
        if not iid.endswith("-USDT-SWAP"):
            continue
        try:
            vol = float(t.get("volCcy24h") or 0) * float(t.get("last") or 0)
        except ValueError:
            vol = 0.0
        rows.append((vol, iid))
    rows.sort(reverse=True)
    return [iid for _, iid in rows[:limit]]


def history(inst: str) -> list[tuple[int, float]]:
    """>=2.5 ani de close zilnice, paginat inapoi. (ts, close)"""
    out: list[tuple[int, float]] = []
    after: int | None = None
    for _ in range(PAGES):
        url = f"/api/v5/market/candles?instId={inst}&bar=1Dutc&limit={BARS_PER_PAGE}"
        if after is not None:
            url += f"&after={after}"
        rows = get(url).get("data", []) or []
        if not rows:
            break
        chunk = [(int(r[0]), float(r[4])) for r in rows]
        out.extend(chunk)
        after = min(c[0] for c in chunk)
        time.sleep(0.05)
    out = sorted(set(out))
    return out


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


def classify(c: list[float], i: int) -> str:
    e30 = er(c, i, 30)
    r30 = rret(c, i, 30)
    pz = pos_in_range(c, i)
    if r30 <= -10.0 and e30 >= 0.35:
        return "SHORT"
    if r30 >= 10.0 and e30 >= 0.35:
        return "LONG"
    if e30 < 0.25 and 0.25 <= pz <= 0.75:
        return "NEUTRAL"
    return "NO_TRADE"


def main() -> None:
    print("=" * 100)
    print("CLASIFICATORUL, TESTAT PE REGIMURI — perp-uri USDT-SWAP cu istoric lung")
    print("=" * 100)

    insts = liquid_perps(30)
    print(f"  Perp-uri lichide selectate: {len(insts)}")

    series: dict[str, list[tuple[int, float]]] = {}
    for n, iid in enumerate(insts, 1):
        try:
            h = history(iid)
            if len(h) >= 200:
                series[iid] = h
        except Exception:  # noqa: BLE001
            pass
        if n % 10 == 0:
            print(f"    ... {n}/{len(insts)}")
    print(f"  Serii valide (>=200 bare): {len(series)}")
    if not series:
        print("  Fara date.")
        return

    all_ts = [t for h in series.values() for t, _ in h]
    d0 = datetime.fromtimestamp(min(all_ts) / 1000, tz=timezone.utc)
    d1 = datetime.fromtimestamp(max(all_ts) / 1000, tz=timezone.utc)
    print(f"  Interval: {d0:%Y-%m-%d} .. {d1:%Y-%m-%d}  ({(d1 - d0).days} zile)")

    # index comun de timp per simbol
    idx = {s: [t for t, _ in h] for s, h in series.items()}
    close = {s: [c for _, c in h] for s, h in series.items()}

    # observatii: (ts, cls, fwd5)
    obs: list[tuple[int, str, float]] = []
    for s in series:
        c = close[s]
        for i in range(31, len(c) - FWD):
            cls = classify(c, i)
            fwd = (c[i + FWD] / c[i] - 1.0) * 100.0
            obs.append((idx[s][i], cls, fwd))
    print(f"  Observatii brute: {len(obs)}")

    # randament mediu de piata per zi (cross-sectional) -> exces
    by_day: dict[int, list[float]] = {}
    for ts, _, fwd in obs:
        by_day.setdefault(ts, []).append(fwd)
    mkt = {ts: statistics.fmean(v) for ts, v in by_day.items() if v}

    print(f"  Zile distincte: {len(mkt)}")
    print(f"  Nota: esantionul EFECTIV este numarul de zile, nu numarul de observatii.")

    # --- tabel pe clase -----------------------------------------------------
    buckets: dict[str, list[float]] = {"LONG": [], "SHORT": [], "NEUTRAL": [], "NO_TRADE": []}
    excess: dict[str, list[float]] = {"LONG": [], "SHORT": [], "NEUTRAL": [], "NO_TRADE": []}
    for ts, cls, fwd in obs:
        buckets[cls].append(fwd)
        excess[cls].append(fwd - mkt[ts])

    print()
    print("=" * 100)
    print(f"REZULTAT PE CLASE (randament urmator pe {FWD} zile)")
    print("=" * 100)
    print(f"  {'clasa':<10}{'n':>7}{'fwd':>9}{'exces':>9}{'t exces':>10}{'hit%':>7}   verdict")
    print("  " + "-" * 88)

    verdicts: dict[str, str] = {}
    for cls in ("LONG", "SHORT", "NEUTRAL", "NO_TRADE"):
        ex = excess[cls]
        if len(ex) < 30:
            print(f"  {cls:<10}{len(ex):>7}   (prea putine)")
            continue
        m_ex = statistics.fmean(ex)
        sd = statistics.stdev(ex)
        # corectie pseudo-replicare: esantion efectiv = zile, nu observatii
        n_eff = min(len(ex), len(mkt))
        t = m_ex / (sd / n_eff ** 0.5) if sd else 0.0
        hit = sum(1 for x in buckets[cls] if x > 0) / len(buckets[cls]) * 100
        if cls == "LONG":
            ok = "BUN" if m_ex > 0 and t > 2 else "slab"
        elif cls == "SHORT":
            ok = "BUN" if m_ex < 0 and t < -2 else "slab"
        else:
            ok = "neutru" if abs(t) < 2 else "diferit de 0"
        verdicts[cls] = ok
        print(f"  {cls:<10}{len(ex):>7}{statistics.fmean(buckets[cls]):>8.2f}%"
              f"{m_ex:>8.2f}%{t:>10.2f}{hit:>6.0f}%   {ok}")

    # --- pe regimuri --------------------------------------------------------
    print()
    print("=" * 100)
    print("PE REGIMURI DE PIATA (zi de bull = piata medie urca pe orizont)")
    print("=" * 100)
    bull_days = [ts for ts, v in mkt.items() if v > 0]
    bear_days = [ts for ts, v in mkt.items() if v <= 0]
    print(f"  Zile de bull: {len(bull_days)}   |   zile de bear: {len(bear_days)}")
    print()
    print(f"  {'clasa':<10}{'n bull':>8}{'fwd bull':>10}{'n bear':>8}{'fwd bear':>10}")
    print("  " + "-" * 88)

    reg_bull: dict[str, list[float]] = {"LONG": [], "SHORT": [], "NEUTRAL": [], "NO_TRADE": []}
    reg_bear: dict[str, list[float]] = {"LONG": [], "SHORT": [], "NEUTRAL": [], "NO_TRADE": []}
    bull_set, bear_set = set(bull_days), set(bear_days)
    for ts, cls, fwd in obs:
        (reg_bull if ts in bull_set else reg_bear)[cls].append(fwd)

    for cls in ("LONG", "SHORT", "NEUTRAL", "NO_TRADE"):
        nb, nr = len(reg_bull[cls]), len(reg_bear[cls])
        mb = statistics.fmean(reg_bull[cls]) if nb else 0.0
        mr = statistics.fmean(reg_bear[cls]) if nr else 0.0
        print(f"  {cls:<10}{nb:>8}{mb:>9.2f}%{nr:>8}{mr:>9.2f}%{nb + nr:>7}")

    # --- verdict ------------------------------------------------------------
    print()
    print("=" * 100)
    print("VERDICT: este clasificatorul simetric sau e un short-machine?")
    print("=" * 100)

    long_ex = statistics.fmean(excess["LONG"]) if excess["LONG"] else 0.0
    short_ex = statistics.fmean(excess["SHORT"]) if excess["SHORT"] else 0.0
    spread = long_ex - short_ex
    print(f"  Exces LONG:  {long_ex:>+7.2f}pp")
    print(f"  Exces SHORT: {short_ex:>+7.2f}pp")
    print(f"  Spread LONG-SHORT: {spread:>+7.2f}pp")
    print()
    if long_ex > 1.0 and short_ex < -1.0:
        print("  SIMETRIC: ambele capete funcționeaza. Sistemul poate merge long si short.")
    elif short_ex < -1.0:
        print("  ASIMETRIC: doar capatul SHORT are valoare; LONG nu adauga nimic.")
        print("  => nu construi un sistem long-only pe acest clasificator.")
    elif long_ex > 1.0:
        print("  ASIMETRIC: doar capatul LONG are valoare.")
    else:
        print("  NICIO valoare de selectie pe niciun capat.")


if __name__ == "__main__":
    main()
