---
description: Use when adding or reviewing any protection, exit, freeze, cooldown
  or stop mechanism on the AUTO-LIMIT grid path — ensures it runs automatically
  instead of requiring a manual call.
---

Any protection or exit decision that is correct in code must be wired to run automatically; never ship it as a manual-only capability.

- If a guard exists but only an operator can trigger it (e.g. `setBuyFreezePx` called only from a TradeBot route), treat that as an incomplete feature and wire the automatic trigger in the same change: engine tick, analyzer decision, autopilot, or watchdog.
- Manual override stays allowed (an operator may always intervene), but it must never be the only path.
- Every automatic protection must have: a trigger condition, a reason string persisted on the bot row + audit log, an idempotent effect (no repeated writes per tick), and a bounded duration or a hard backstop so it cannot hang forever.
- Keep one actor per action. When two supervisors could act (NeutralGridEngine tick vs GridBotAnalyzer), the pure predicate is shared, and only one of them performs the side effect; the other defers.
- The owner does not remember to press buttons: "the owner can click it in the UI" is not an implementation.