# TB5 `_UM_XPERP` Research

Isolated research package for the five OKX **EEA** `_UM_XPERP` instruments that TB5 trades.

Nothing in this folder is imported by `src/`. It is a standalone data-collection and
analysis harness that talks to `https://eea.okx.com` over **public** endpoints only.

## Why EEA and not `www.okx.com`

The `_UM_XPERP` contracts (`ruleType: "xperp"`, `settleCcy: "USD"`) are **not** listed on
the global `www.okx.com` endpoint — they return `51001 Instrument doesn't exist`. They are
FUTURES instruments on the European venue `eea.okx.com`. TB5 itself points at
`eea.okx.com` (`OKXAdapter.restBaseUrl` default).

## Instruments

| Short | instId |
|---|---|
| ZEC | `ZEC-USD_UM_XPERP-310530` |
| ENA | `ENA-USD_UM_XPERP-310613` |
| IRYS | `IRYS-USD_UM_XPERP-310530` |
| PIEVERSE | `PIEVERSE-USD_UM_XPERP-310822` |
| CASHCAT | `CASHCAT-USD_UM_XPERP-310926` |

## Pipeline

```
1. collect.ts  -> data/<instId>_candles_<bar>.json, data/<instId>_funding.json,
                  data/<instId>_oi.json, data/meta.json
2. analyze.ts   -> report.json (all sections) + report.md (human readable)
```

Run (Node 18+, no extra deps — uses global fetch):

```powershell
npx tsx research/tb5/collect.ts --bars=5m,15m,1H,1Dutc --days=90
npx tsx research/tb5/analyze.ts
```

## Known data limitations (declared, not hidden)

- **Spread / order-book depth have no public history.** OKX only serves a live snapshot.
  The report measures live spread at collection time and states it as a single snapshot,
  not a time series.
- **Funding on `_UM_XPERP` is 8h** on all five instruments (verified, not assumed).
- **IRYS and CASHCAT were effectively dormant** early in their listed history
  (IRYS < $1k/day, CASHCAT zero for weeks). Windows below the liquidity floor are flagged
  and excluded from the primary statistics, but kept in the raw data.
- **~78 days of price history** is the natural ceiling for these contracts (oldest 1D bar
  ≈ 1786752000000, early Sept 2026).
