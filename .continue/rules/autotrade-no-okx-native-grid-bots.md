---
alwaysApply: true
---

In AutoTrade-v5 we do NOT open OKX native grid bots (`/api/v5/tradingBot/grid/order-algo`, `algoOrdType: 'contract_grid'`). The only grid execution path is the app's own **AUTO-LIMIT** bots: computed ladder of plain limit orders on OKX plus a local supervisor.

Consequences that must be respected in all design, review and debugging:

- Never propose, build, debug or optimise a native contract-grid bot. Do not suggest enabling or repairing that path.
- Do NOT discuss, reintroduce, or re-litigate "native bots" as an option. The decision is closed and is not open for reconsideration.
- When reading the code, treat the native-grid branch (`OKXNativeGridEngine`, `okxAdapter.stopNativeContractGrid`, autopilot `registerFallbackBot` native paths, `isNativeOKXBot`) as **legacy compatibility only** — it exists so older rows/tests don't break, not as a supported execution mode.
- All protection work (SL/TP geometry, profit-giveback guard, range-breakout confirmation, venue-side reduce-only conditional stops, watchdog) must target the AUTO-LIMIT path and its real executor: `NeutralGridEngine` + `GridRiskManager` + `GridBotAnalyzer`.
- The `_UM_XPERP` instruments cannot use OKX native grid anyway (answers error 51000), which is precisely why the AUTO-LIMIT path exists. That is the permanent reason, not a temporary limitation.

If a task seems to require a native bot, say so and refuse — offer the AUTO-LIMIT equivalent instead.