#!/usr/bin/env python3
"""
grid-range-thesis-test.py
=========================
Testeaza teza: "piata e in range, deci grid-ul trebuie sa mearga".

Idee: daca piata chiar e in range, atunci
  (a) Efficiency Ratio (Kaufman) e mic  -> pretul hoinareste, nu alearga
  (b) botii de grid care au rulat pe acel simbol au castigat

Masuram (a) pe 9 contracte _UM_XPERP din seria zilnica UTC de 90 bare,
si (b) din fixture-ul local cu PnL real al botilor (2026-11-14).

Sursa date pret: OKX public candles, bar=1Dutc, demo=false.
Sursa date PnL: src/server/engine/grid/__tests__/fixtures/pnl-2026-11-14.json

Rulare: python scripts/grid-range-thesis-test.py
"""

from __future__ import annotations

import json
import math
import os
import statistics

# ---------------------------------------------------------------------------
# 1. Date: closes zilnice (UTC), OKX _UM_XPERP, cele mai noi primele.
#    Fiecare serie are 90 de bare (ultima bara este incompleta).
# ---------------------------------------------------------------------------

CLOSES: dict[str, list[float]] = {
    "ZEC": [
        787.72, 778.10, 758.33, 893.14, 912.00, 966.90, 902.97, 915.10, 862.48, 933.40,
        955.45, 962.41, 1043.48, 1162.09, 1211.19, 1258.00, 1320.71, 1280.00, 1295.14, 1216.85,
        1133.89, 1232.77, 1249.81, 1268.46, 1221.81, 1309.44, 1307.51, 1231.01, 1212.54, 1206.36,
        1180.22, 1218.00, 1314.78, 1256.08, 1151.24, 1129.20, 1126.45, 1147.94, 1221.35, 1145.95,
        1217.90, 1166.21, 1276.23, 1221.18, 1205.06, 1186.18, 1327.98, 1366.57, 1338.94, 1352.62,
        1305.29, 1301.43, 1335.55, 1437.71, 1417.13, 1482.76, 1586.30, 1652.49, 1555.52, 1545.88,
        1497.80, 1629.97, 1470.48, 1508.97, 1469.99, 1560.54, 1464.87, 1335.68, 1109.64, 1163.00,
        1061.54, 1122.71, 1163.39, 1078.39, 1243.50, 1177.65, 1139.15, 1227.91, 1025.06, 1022.80,
        951.49, 815.10, 829.40, 846.83, 834.37, 840.96, 800.31, 810.04, 816.25, 770.25,
    ],
    "INJ": [
        6.192, 5.968, 6.357, 7.089, 6.975, 7.407, 6.891, 6.982, 6.804, 8.059,
        7.451, 7.517, 8.012, 8.105, 8.034, 8.256, 8.290, 8.139, 7.930, 7.243,
        6.975, 7.177, 7.222, 7.175, 7.324, 8.145, 7.957, 8.050, 7.860, 7.705,
        7.780, 7.900, 8.606, 8.931, 8.589, 8.714, 8.592, 8.730, 8.535, 7.663,
        8.106, 7.293, 7.753, 7.638, 6.926, 6.739, 7.462, 8.113, 7.670, 7.640,
        7.672, 7.445, 7.364, 7.418, 7.612, 7.411, 7.813, 7.770, 8.180, 8.049,
        7.797, 7.896, 7.856, 7.787, 7.923, 6.679, 5.722, 5.406, 5.436, 6.283,
        5.900, 5.988, 5.740, 5.939, 6.133, 6.405, 6.188, 5.309, 4.940, 4.801,
        4.973, 4.764, 4.804, 4.924, 4.992, 5.171, 5.153, 5.512, 5.552, 5.557,
    ],
    "HYPE": [
        62.200, 61.237, 60.878, 66.702, 66.867, 69.903, 69.700, 68.060, 64.290, 71.641,
        72.635, 71.943, 72.231, 75.088, 74.433, 77.721, 78.440, 76.512, 83.647, 84.979,
        83.928, 87.714, 87.850, 89.867, 88.818, 80.614, 81.190, 78.254, 76.245, 76.647,
        77.047, 77.363, 80.569, 80.280, 79.185, 78.874, 77.976, 80.243, 81.696, 80.793,
        81.493, 80.904, 86.607, 85.366, 84.120, 84.138, 88.429, 91.900, 94.109, 90.512,
        89.259, 89.054, 87.614, 90.899, 86.041, 87.430, 91.619, 92.555, 92.344, 92.065,
        93.981, 97.162, 94.052, 93.623, 92.127, 92.538, 84.984, 78.226, 76.882, 80.306,
        77.262, 79.625, 79.373, 78.524, 83.525, 85.096, 85.120, 87.937, 85.364, 84.400,
        87.424, 81.931, 82.753, 84.134, 80.000, 83.336, 80.880, 84.620, 82.242, 79.622,
    ],
    "SUI": [
        0.6540, 0.6469, 0.6497, 0.7093, 0.7186, 0.7376, 0.7187, 0.7370, 0.6996, 0.7946,
        0.8037, 0.8207, 0.8223, 0.8437, 0.8194, 0.8551, 0.8673, 0.8398, 0.9277, 0.8920,
        0.8711, 0.8992, 0.8977, 0.9033, 0.8676, 0.9416, 0.9318, 0.9165, 0.9185, 0.9368,
        0.9589, 0.9708, 1.0274, 1.0292, 0.9973, 0.9952, 0.9747, 1.0197, 1.0357, 1.0212,
        1.0459, 1.0267, 1.1291, 1.1112, 1.0687, 1.0396, 1.1275, 1.1774, 1.2133, 1.2075,
        1.1834, 1.1450, 1.1767, 1.1630, 1.1513, 1.1669, 1.2630, 1.1628, 1.1945, 1.0138,
        0.9592, 1.0230, 1.0422, 0.8971, 0.8578, 0.8141, 0.7406, 0.7125, 0.6863, 0.7208,
        0.7020, 0.7247, 0.7250, 0.7271, 0.7721, 0.8106, 0.8181, 0.8107, 0.7951, 0.7553,
        0.7830, 0.7464, 0.7210, 0.7261, 0.7108, 0.7445, 0.7427, 0.7795, 0.7665, 0.7570,
    ],
    "ARB": [
        0.11514, 0.11323, 0.11391, 0.12218, 0.12720, 0.13351, 0.13110, 0.13464, 0.12775, 0.14486,
        0.15056, 0.15158, 0.16049, 0.17450, 0.16581, 0.16883, 0.16446, 0.15628, 0.16212, 0.15785,
        0.15565, 0.16352, 0.16367, 0.16325, 0.15409, 0.17185, 0.16723, 0.16846, 0.16845, 0.16898,
        0.17136, 0.17890, 0.18766, 0.18758, 0.19693, 0.18670, 0.18078, 0.19096, 0.19539, 0.18163,
        0.19094, 0.17948, 0.19949, 0.18920, 0.18239, 0.17240, 0.18552, 0.19960, 0.20775, 0.20390,
        0.20127, 0.19587, 0.19969, 0.20263, 0.20322, 0.20196, 0.22611, 0.22201, 0.22654, 0.21616,
        0.21574, 0.23505, 0.22564, 0.21770, 0.20619, 0.22103, 0.17710, 0.16799, 0.15149, 0.13360,
        0.13289, 0.14052, 0.13938, 0.13974, 0.14942, 0.16468, 0.16937, 0.18923, 0.17715, 0.13179,
        0.14073, 0.12327, 0.11035, 0.10900, 0.08390, 0.08782, 0.08756, 0.09184, 0.09200, 0.09228,
    ],
    "AAVE": [
        98.30, 97.37, 97.78, 104.48, 109.14, 112.41, 108.27, 109.51, 100.49, 111.48,
        113.84, 120.45, 123.43, 131.34, 125.89, 131.52, 130.42, 128.72, 131.55, 126.88,
        126.47, 134.39, 133.48, 128.90, 118.96, 133.86, 133.63, 135.63, 136.28, 137.68,
        144.07, 146.57, 154.61, 154.33, 149.30, 151.98, 151.58, 155.06, 157.34, 154.32,
        160.18, 156.62, 171.61, 168.20, 167.13, 166.01, 173.89, 179.60, 183.88, 179.03,
        181.50, 179.37, 171.26, 159.15, 165.21, 149.25, 154.50, 155.79, 153.52, 146.80,
        138.90, 147.90, 145.99, 137.64, 141.00, 139.43, 128.58, 119.37, 122.09, 128.18,
        124.09, 125.46, 124.93, 120.53, 125.87, 128.78, 132.16, 136.85, 134.35, 130.45,
        132.61, 127.12, 127.84, 124.05, 122.35, 126.77, 122.16, 128.18, 127.11, 126.55,
    ],
    "SOL": [
        70.10, 70.13, 68.66, 73.00, 73.49, 75.07, 71.45, 72.67, 70.16, 78.04,
        81.58, 83.13, 83.23, 86.57, 86.37, 89.62, 89.96, 89.17, 95.46, 92.66,
        91.80, 94.40, 95.31, 96.15, 95.44, 102.29, 101.22, 100.77, 101.19, 102.21,
        102.71, 103.51, 106.80, 106.38, 104.87, 103.95, 103.27, 104.28, 105.29, 104.15,
        106.69, 105.63, 111.24, 109.96, 109.03, 109.47, 116.20, 120.63, 120.71, 121.50,
        119.51, 118.51, 118.35, 117.96, 119.01, 118.80, 121.88, 121.30, 122.04, 116.95,
        114.94, 118.50, 118.87, 111.09, 110.95, 112.64, 101.49, 98.52, 96.77, 102.46,
        99.18, 101.68, 102.37, 98.53, 101.47, 103.29, 103.70, 106.47, 103.11, 101.85,
        103.87, 100.42, 99.85, 102.94, 101.63, 105.53, 104.09, 109.08, 101.96, 96.52,
    ],
    "ETH": [
        1710.81, 1681.14, 1618.54, 1754.78, 1774.10, 1822.03, 1818.76, 1833.72, 1766.75, 1926.88,
        2016.19, 2052.24, 2049.74, 2131.67, 2124.12, 2236.60, 2234.80, 2234.31, 2421.27, 2271.02,
        2249.49, 2271.56, 2251.99, 2240.82, 2249.36, 2357.19, 2347.69, 2321.17, 2326.59, 2355.57,
        2384.47, 2386.33, 2471.48, 2446.69, 2405.24, 2407.41, 2399.36, 2419.73, 2438.78, 2418.74,
        2495.04, 2442.88, 2533.58, 2503.09, 2484.90, 2472.00, 2572.62, 2696.01, 2708.18, 2725.66,
        2685.53, 2666.77, 2704.69, 2683.64, 2675.68, 2686.60, 2686.60, 2694.50, 2689.20, 2685.80,
        2683.01, 2752.42, 2774.16, 2643.49, 2630.58, 2610.14, 2444.67, 2414.90, 2395.48, 2513.86,
        2474.80, 2524.42, 2514.60, 2436.03, 2466.77, 2483.78, 2488.29, 2513.40, 2478.78, 2455.04,
        2506.48, 2391.44, 2416.47, 2466.53, 2415.00, 2456.10, 2441.24, 2509.91, 2505.35, 2440.71,
    ],
    "BTC": [
        60618.7, 60059.6, 58800.0, 61886.7, 62955.5, 64852.1, 64795.5, 65298.0, 64084.9, 68247.0,
        71410.7, 73946.9, 73763.0, 75278.2, 74774.6, 75785.1, 75770.7, 75995.0, 80412.6, 77365.5,
        76738.7, 78267.5, 77491.9, 77249.1, 77885.5, 81270.6, 80834.4, 80059.9, 80096.9, 80822.4,
        81123.3, 81376.4, 84013.6, 82962.0, 81894.2, 82057.8, 81419.3, 81543.9, 82161.7, 81627.5,
        83088.0, 81766.4, 83682.8, 82933.2, 82572.3, 81702.3, 83251.2, 85509.4, 85714.3, 86472.4,
        84707.6, 84460.1, 84807.1, 83533.3, 83578.1, 83418.5, 84400.4, 84370.6, 84036.8, 84340.3,
        84339.4, 86154.8, 86567.4, 81126.2, 81197.5, 80849.2, 76344.0, 76140.6, 75622.1, 78149.1,
        76780.8, 77253.6, 77183.9, 76513.5, 78242.7, 78412.8, 79055.9, 80288.3, 79790.0, 79639.9,
        81220.0, 77313.0, 77362.7, 78517.4, 77632.0, 78196.4, 77811.0, 80216.5, 78987.6, 78453.5,
    ],
}


# ---------------------------------------------------------------------------
# 2. Metrici de "stare a pietei"
# ---------------------------------------------------------------------------

def efficiency_ratio(closes: list[float], n: int) -> float:
    """Kaufman ER pe ultimele n bare: |deplasare neta| / drum parcurs.

    1.0 = trend perfect (linie dreapta) -> gridul e cel mai rau caz.
    0.0 = pretul se intoarce la fiecare bara -> gridul e ideal.
    """
    window = closes[-n:]
    if len(window) < 3:
        return float("nan")
    net = abs(window[-1] - window[0])
    path = sum(abs(window[i] - window[i - 1]) for i in range(1, len(window)))
    return net / path if path else float("nan")


def trend_r2(closes: list[float], n: int) -> float:
    """R^2 al regresiei liniare log(pret) ~ timp. Cat de 'drept' e trendul."""
    window = closes[-n:]
    ys = [math.log(c) for c in window]
    m = len(ys)
    xs = list(range(m))
    mx = statistics.fmean(xs)
    my = statistics.fmean(ys)
    sxy = sum((xs[i] - mx) * (ys[i] - my) for i in range(m))
    sxx = sum((xs[i] - mx) ** 2 for i in range(m))
    syy = sum((ys[i] - my) ** 2 for i in range(m))
    if sxx == 0 or syy == 0:
        return 0.0
    slope = sxy / sxx
    ss_res = sum((ys[i] - (my + slope * (xs[i] - mx))) ** 2 for i in range(m))
    return max(0.0, 1.0 - ss_res / syy)


def max_drawdown(closes: list[float]) -> float:
    """Cea mai mare scadere peak-to-trough, in fractie (0.25 = -25%)."""
    peak = closes[0]
    worst = 0.0
    for c in closes:
        peak = max(peak, c)
        if peak > 0:
            worst = max(worst, (peak - c) / peak)
    return worst


def max_runup(closes: list[float]) -> float:
    """Cea mai mare urcare trough-to-peak, in fractie."""
    trough = closes[0]
    best = 0.0
    for c in closes:
        trough = min(trough, c)
        if trough > 0:
            best = max(best, (c - trough) / trough)
    return best


def realized_vol(closes: list[float], n: int) -> float:
    """Volatilitate realizata anualizata (365 zile) din log-returns."""
    rets = [math.log(closes[i] / closes[i - 1]) for i in range(len(closes) - n + 1, len(closes))]
    if len(rets) < 2:
        return float("nan")
    return statistics.stdev(rets) * math.sqrt(365)


def range_position(closes: list[float]) -> float:
    """Unde sta ultimul pret in intervalul [min, max] al ferestrei. 0 = la minim, 1 = la maxim."""
    lo, hi = min(closes), max(closes)
    if hi == lo:
        return 0.5
    return (closes[-1] - lo) / (hi - lo)


def verdict(er30: float) -> str:
    if er30 != er30:  # NaN
        return "?"
    if er30 < 0.15:
        return "RANGE (grid-friendly)"
    if er30 < 0.30:
        return "TRANZITIE"
    return "TREND (grid ostil)"


# ---------------------------------------------------------------------------
# 3. PnL real al botilor de grid (fixture local, masurat 2026-11-14)
# ---------------------------------------------------------------------------

PNL_FIXTURE = os.path.join(
    "src", "server", "engine", "grid", "__tests__", "fixtures", "pnl-2026-11-14.json"
)


def load_realized_pnl() -> dict[str, dict[str, float]]:
    """Agrega net PnL pe simbol din fixture. Returneaza {SYMBOL: {sum, n, wins}}."""
    if not os.path.exists(PNL_FIXTURE):
        return {}
    with open(PNL_FIXTURE, encoding="utf-8") as fh:
        raw = json.load(fh)
    out: dict[str, dict[str, float]] = {}
    for row in raw.get("bots", []):
        _bot_id, symbol, _grid_profit, _fees, net = row[0], row[1], row[2], row[3], row[4]
        net = float(net)  # totalNetPnlUSDT (botTuple index 4)
        base = str(symbol).split("-")[0]
        agg = out.setdefault(base, {"sum": 0.0, "n": 0.0, "wins": 0.0})
        agg["sum"] += net
        agg["n"] += 1.0
        if net > 0:
            agg["wins"] += 1.0
    return out


# ---------------------------------------------------------------------------
# 4. Raport
# ---------------------------------------------------------------------------

def main() -> None:
    pnl = load_realized_pnl()

    print("=" * 108)
    print("BATERIA DE TESTE — teza 'piata e in range, deci grid-ul merge'")
    print("Pret: OKX _UM_XPERP, 1Dutc, 90 bare.  PnL: boti reali din .data (2026-11-14).")
    print("=" * 108)

    rows = []
    for sym in ("BTC", "ETH", "SOL", "AAVE", "SUI", "ARB", "INJ", "HYPE", "ZEC"):
        c = list(reversed(CLOSES[sym]))
        if len(c) != 90:
            print(f"!! {sym}: {len(c)} bare, astept 90 — sar peste")
            continue
        er90, er30, er14 = (efficiency_ratio(c, n) for n in (90, 30, 14))
        rows.append(
            dict(
                sym=sym,
                er90=er90,
                er30=er30,
                er14=er14,
                r2=trend_r2(c, 90),
                ret90=(c[-1] / c[0] - 1.0) * 100.0,
                ret30=(c[-1] / c[-31] - 1.0) * 100.0,
                mdd=max_drawdown(c),
                mru=max_runup(c),
                vol=realized_vol(c, 30),
                pos=range_position(c),
                verdict=verdict(er30),
            )
        )

    hdr = (
        f"{'SYM':<6}{'ER90':>7}{'ER30':>7}{'ER14':>7}{'R2_90':>7}"
        f"{'ret90%':>9}{'ret30%':>9}{'maxDD%':>8}{'maxRU%':>8}{'vol30%':>8}{'poz':>6}"
        f"  {'VERDICT':<20}"
    )
    print(hdr)
    print("-" * 108)
    for r in rows:
        print(
            f"{r['sym']:<6}{r['er90']:>7.3f}{r['er30']:>7.3f}{r['er14']:>7.3f}{r['r2']:>7.3f}"
            f"{r['ret90']:>9.1f}{r['ret30']:>9.1f}{-r['mdd'] * 100:>8.1f}{r['mru'] * 100:>8.1f}"
            f"{r['vol'] * 100:>8.1f}{r['pos']:>6.2f}  {r['verdict']:<20}"
        )

    print()
    print("=" * 108)
    print("FRECVENTA DE TESUT: cat de des se plimba pretul fata de o bara (oscilatii/trend)")
    print("=" * 108)
    for r in rows:
        c = list(reversed(CLOSES[r["sym"]]))
        crossings = sum(
            1
            for i in range(2, len(c))
            if (c[i - 1] - c[i - 2]) * (c[i] - c[i - 1]) < 0
        )
        print(
            f"{r['sym']:<6} schimbari de directie: {crossings:>3}/88 bare "
            f"({crossings / 88 * 100:>5.1f}%)   drum/interval: {1 / r['er90']:>5.2f}x"
        )

    if pnl:
        print()
        print("=" * 108)
        print("REZULTAT REAL vs. TEORIE (boti de grid, net USDT, 2026-11-14)")
        print("=" * 108)
        print(f"{'SYM':<6}{'boti':>6}{'netUSDT':>10}{'win%':>8}{'ER30':>8}{'ER90':>8}  {'VERDICT':<20}")
        print("-" * 108)
        for r in rows:
            p = pnl.get(r["sym"])
            if not p:
                continue
            win = p["wins"] / p["n"] * 100.0 if p["n"] else 0.0
            print(
                f"{r['sym']:<6}{int(p['n']):>6}{p['sum']:>10.4f}{win:>7.0f}%"
                f"{r['er30']:>8.3f}{r['er90']:>8.3f}  {r['verdict']:<20}"
            )

        # corelatie ER30 vs PnL agregat, pe simbolurile comune
        pairs = [
            (r["er30"], pnl[r["sym"]]["sum"])
            for r in rows
            if r["sym"] in pnl and r["er30"] == r["er30"]
        ]
        if len(pairs) >= 4:
            xs = [p[0] for p in pairs]
            ys = [p[1] for p in pairs]
            mx, my = statistics.fmean(xs), statistics.fmean(ys)
            cov = sum((x - mx) * (y - my) for x, y in pairs) / len(pairs)
            sx, sy = statistics.pstdev(xs), statistics.pstdev(ys)
            corr = cov / (sx * sy) if sx and sy else float("nan")
            print()
            print(f"Corelatie Pearson ER30 vs netPnL pe simbol: r = {corr:+.3f}  (n={len(pairs)})")
            print("  Teza 'range => profit de grid' ar cere r negativ (ER mic -> PnL mare).")

    # --- clasament final: cine merita grid acum -------------------------------
    print()
    print("=" * 108)
    print("CLASAMENT pentru grid (ER30 mic = bun, vol rezonabila, fara trend puternic)")
    print("=" * 108)
    for r in sorted(rows, key=lambda x: x["er30"]):
        score = r["er30"] + max(0.0, r["r2"] - 0.4) * 0.5
        print(
            f"  {r['sym']:<6} ER30={r['er30']:.3f}  R2={r['r2']:.2f}  "
            f"ret30={r['ret30']:+6.1f}%  poz={r['pos']:.2f}  score={score:.3f}"
        )


if __name__ == "__main__":
    main()
