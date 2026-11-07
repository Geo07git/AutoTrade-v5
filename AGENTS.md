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

## Never do these without explicit owner approval

- `git push --force` or `--force-with-lease` on `main`.
- `git reset --hard`, `git rebase` on `main`, or `git commit --amend` on a
  commit that is already pushed.
- Commit `.env*`, `.data/`, `*.zip`, `*.patch`, `public/*.zip`, or any secret.
- Push while `npm run lint` fails, or while the secret check is inconclusive.
- Auto-resolve merge conflicts by guessing which side is correct.

## If a push fails

Stop and report the exact error message. Do not rewrite history, do not run
`git pull --rebase` automatically, do not delete the commit. The commit stays
local and safe; the owner decides what happens next.

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
