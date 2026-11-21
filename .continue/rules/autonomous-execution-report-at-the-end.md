---
description: Use for any multi-step or multi-phase task where the owner has
  already approved the plan, to avoid asking for confirmation at each
  intermediate step.
---

The owner does not want per-step confirmation on multi-phase work.

- Run the whole agreed plan without asking "shall I continue?" between phases.
- Report only at the end, opening with "e gata" (done) or, if it stopped, exactly where and why.
- Still stop and report instead of guessing when: a check fails (lint/test), a secret or `.env`/`.data/` file would be committed, a destructive git command would be needed, or the plan turns out to be based on a false premise.
- AGENTS.md hard rules (no force-push, no history rewrite, no `--live`, no native OKX grid bots, no touching production) still apply in full — silence is not approval for those.
- If a phase fails a go/no-go gate, stop the plan there and report; do not substitute a different design without being asked.