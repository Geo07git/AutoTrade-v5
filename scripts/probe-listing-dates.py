#!/usr/bin/env python3
"""
probe-listing-dates.py
======================
Cat de vechi sunt contractele _UM_XPERP? Citeste `listTime` din
/api/v5/public/instruments si arata cele mai vechi listari, ca sa stim in ce
fereastra putem testa o piata care URCA.

Un singur request, nicio operatie pe cont.
"""

from __future__ import annotations

import json
import sys
import urllib.request
from datetime import datetime, timezone

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

BASE = "https://eea.okx.com"
NON_CRYPTO = {"3", "4", "5", "6", "7"}


def main() -> None:
    req = urllib.request.Request(
        BASE + "/api/v5/public/instruments?instType=FUTURES",
        headers={"User-Agent": "AutoTrade-v5-probe/1.0", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=25) as r:
        data = json.load(r)

    rows = []
    for i in data.get("data", []):
        iid = str(i.get("instId", ""))
        cat = str(i.get("instCategory") or "").strip()
        if "_UM_XPERP" not in iid or str(i.get("state", "")) != "live":
            continue
        if cat in NON_CRYPTO:
            continue
        lt = i.get("listTime")
        if not lt:
            continue
        rows.append((int(lt), iid.split("-")[0], iid))

    rows.sort()
    print(f"Contracte crypto _UM_XPERP live cu listTime: {len(rows)}")
    if not rows:
        return

    first = datetime.fromtimestamp(rows[0][0] / 1000, tz=timezone.utc)
    last = datetime.fromtimestamp(rows[-1][0] / 1000, tz=timezone.utc)
    print(f"Cel mai vechi: {first:%Y-%m-%d}")
    print(f"Cel mai nou:   {last:%Y-%m-%d}")

    now = datetime.now(timezone.utc)
    print(f"Data curenta:  {now:%Y-%m-%d}")
    print()
    print("Cele mai vechi 15 listari:")
    print(f"  {'data':<12}{'simbol':<14}{'instrument'}")
    print("  " + "-" * 60)
    for ts, sym, iid in rows[:15]:
        d = datetime.fromtimestamp(ts / 1000, tz=timezone.utc)
        print(f"  {d:%Y-%m-%d}  {sym:<14}{iid}")

    # distributie pe luni
    print()
    print("Cate contracte exista la fiecare sfarsit de luna (cumulativ):")
    months: dict[str, int] = {}
    for ts, _, _ in rows:
        d = datetime.fromtimestamp(ts / 1000, tz=timezone.utc)
        months[f"{d:%Y-%m}"] = months.get(f"{d:%Y-%m}", 0) + 1
    cum = 0
    for k in sorted(months):
        cum += months[k]
        print(f"  {k}   +{months[k]:>3}   total {cum:>3}")


if __name__ == "__main__":
    main()
