# AGENTS.md — working agreement for this repo

Instructions for any AI agent (or human) committing to **AutoTrade-v5**.
Owner preference: **every code change is committed and pushed to `main`.**

## Auto-push policy (always on)

After every **logical** change (a feature, a bugfix, a refactor — not every
single file save), do this in order:

1. Review what changed: `git status` and `git diff`.
2. **Secret check:** the diff must not contain API keys, private keys, tokens,
   passwords, `.env*` values, or anything under `.data/`. `.gitignore` already
   covers `.env*`, `.data/`, `*.zip`, `*.patch` — verify, do not assume.
3. If the change touches TypeScript, run `npm run lint` (`tsc --noEmit`).
4. Commit: `git add -A; git commit -m "<type>: <summary>"`.
5. Push: `git push origin main`.

A local `post-commit` hook (`.git/hooks/post-commit`) already pushes on every
commit. Step 5 is the explicit fallback for when the hook is missing or
disabled — the result must be the same: **`main` on GitHub is up to date.**

Target branch: `main`, direct commits, no PR flow.

## Never do these (hard, no approval path)

- `git push --force`, `--force-with-lease`, `-f`.
- `git reset --hard`, `git rebase` on `main`, or `git commit --amend` on a
  commit that is already pushed.
- `git filter-branch`, `git update-ref`, `git reflog expire`, `git gc --prune`.
- `git commit --no-verify` / `-n`, and any other hook bypass.
- `git remote add|remove|set-url`, and any change to `git config`.
- `rm -rf`, `Remove-Item -Recurse`, `del /f`, `rd /s`, `git clean -fdx`,
  `git checkout -- .`, `git restore .` — these destroy uncommitted work.
- Reading, printing, copying, committing or transmitting the contents of
  `.env*`, `.data/`, private keys, keystores, `*.zip`, `*.patch`.
- Touching production: `ssh`, `systemctl restart`, `gh workflow run`, editing the
  `push:` trigger in `.github/workflows/deploy.yml`.
- `--live` on any trading CLI, and any real (non-demo) trading operation.

## Only with explicit owner approval

- Commit `.env*`, `.data/`, `*.zip`, `*.patch`, `public/*.zip`, or any secret.
- Push while `npm run lint` fails, or while the secret check is inconclusive.
- Auto-resolve merge conflicts by guessing which side is correct.
- Delete or move repository files, change dependencies (`npm install`/`ci`,
  `pip install`), or rename anything.

## Terminal modes

No approval prompts in chat. Every command is either run (free) or printed for
someone else to run (display only).

**Free — run directly:** reads (`cat`, `type`, `dir`, `ls`, `head`, `tail`,
`grep`, `find`), all git commands except those under `## Never do these`, and the
verifications `npm run lint`, `npm test`, `npm run build`.

**Agent commits and pushes.** `git add`, `commit`, `push`, `pull`, `merge`,
`checkout <branch>`, `switch`, `stash`, `tag` are run by the agent directly — the
owner's standing approval is recorded here. Before every commit the agent runs
`git status`, `git diff`, the secret check and `npm run lint` (when TypeScript
changed); if a check fails or is inconclusive, it stops and reports instead of
committing.

Consequence the owner accepted: a commit is public on `main` within seconds (the
`post-commit` hook), and undoing it needs a force-push, which is forbidden above.

**Display only — print the powershell block, the human runs it:** dependency
installs (`npm install`/`ci`/`uninstall`, `pip install`), file moves/renames, and
any command that writes outside `src/`, `scripts/`, `docs/`, `public/`.

Prefer whitelist forms (the IDE escalates anything else to a permission prompt):
`npm run lint` instead of `npx tsc --noEmit`; `grep`/`cat`/`dir` instead of
`rg`/`Get-Content`/`Get-ChildItem`; one simple command per call, no `|`, `&&`,
`;` chains.

## If a push fails

Stop and report the exact error message. Do not rewrite history, do not run
`git pull --rebase` automatically, do not delete the commit. The commit stays
local and safe; the owner decides what happens next.

## Execution model — AUTO-LIMIT only (settled, do not reopen)

**We do not open OKX native grid bots.** The only grid execution path is the
app's own **AUTO-LIMIT** bots: a computed ladder of plain limit orders placed
on OKX plus a local supervisor.

- Never propose, build, debug or optimise a native contract-grid bot
  (`/api/v5/tradingBot/grid/order-algo`, `algoOrdType: 'contract_grid'`).
- Do not re-litigate "native bots" as an option. The decision is closed.
- `OKXNativeGridEngine`, `okxAdapter.stopNativeContractGrid`, the autopilot
  native paths and `isNativeOKXBot` are **legacy compatibility only** — they
  exist so old rows and tests don't break, not as a supported mode.
- All protection work (SL/TP geometry, profit-giveback guard, range-breakout
  confirmation, venue-side reduce-only conditional stops, watchdog) targets the
  AUTO-LIMIT path and its real executor: `NeutralGridEngine` +
  `GridRiskManager` + `GridBotAnalyzer`.
- `_UM_XPERP` instruments cannot use OKX native grid at all (error 51000). That
  is the permanent reason the AUTO-LIMIT path exists, not a temporary limitation.

If a task seems to require a native bot, refuse and offer the AUTO-LIMIT
equivalent.

## Deployment (production impact)

**Current state: automatic deploy is PAUSED.** In `.github/workflows/deploy.yml`
the `push:` trigger is commented out (the OCI server was deleted on 2026-11-01),
so a push to `main` deploys **nothing** and restarts **nothing**. The workflow
still exists and can be run manually: Actions → "Deploy to OCI" → Run workflow
(`workflow_dispatch`) — it fails at SSH until `OCI_HOST` points to a real host.

Do **not** tell the owner that a push deployed, restarted the service or ran a
health check while `push:` stays commented out. Verify the trigger before making
any claim about deployment.

When the workflow is re-enabled, it deploys every push to `main` to the live OCI
server (`/home/ubuntu/AutoTrade-v5`, systemd service `autotrade-v5.service`).
That is a real trading bot, so a push then becomes a production action.

- `paths-ignore` (`**.md`, `.github/**`, `.gitignore`) → docs and repo-config
  commits do **not** deploy and do not restart the service. Batch non-code work
  into those paths when the service must not be disturbed.
- `concurrency: deploy-oci-main` with `cancel-in-progress: false` → deploys run
  one at a time and are never interrupted mid-way.
- Flow: verify clean tree → backup (`git bundle` + `dist/` tarball) →
  `git reset --hard origin/main` → `npm ci` → `npm run lint` → `npm test` →
  `npm run build` → restart → poll `/api/health` (10 × 3 s).
- Any failure (lint, test, build, service, health) triggers an automatic
  `git reset --hard <previous commit>` rollback.
- Manual redeploy: Actions → "Deploy to OCI" → Run workflow (`workflow_dispatch`).

Implication for any future re-activation: **never push a broken build to `main`**.
Group changes so that one push = one coherent, deployable state.

## Commit message style

Imperative mood, English, conventional prefix:
`feat:`, `fix:`, `refactor:`, `chore:`, `docs:`, `test:`.

Examples:
- `feat: add neutral grid cooldown guard`
- `fix: reconcile OKX native grid bots after 50124 fallback`
- `docs: rewrite README for the current grid + DeepSeek configuration`

## Hook reference

| Action | Command |
|---|---|
| Skip auto-push for one commit | `GIT_AUTO_PUSH_DISABLE=1 git commit -m "..."` |
| Remove the hook permanently | `rm .git/hooks/post-commit` |
| Check that the hook is active | `ls .git/hooks/post-commit` |

The hook never forces, never rewrites history, and always exits 0 so a failed
push can never invalidate a commit. It skips detached HEAD, a missing `origin`
remote, and rebase/bisect in progress.
