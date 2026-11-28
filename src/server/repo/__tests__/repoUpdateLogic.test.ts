
/**
 * The badge in the header tells the owner "there is an update" without being asked, and the pull
 * is one click. That click must be justified by origin and must refuse to run when the local tree
 * is not in a state a fast-forward can survive - otherwise it either silently does nothing or
 * commits someone else's work. `deriveRepoUpdateDecision` is that gate, so it is tested here
 * without touching a real repository.
 */

import { deriveRepoUpdateDecision, isRuntimePath, RepoUpdateInputs } from '../repoUpdateLogic';

const eq = (actual: unknown, expected: unknown, msg: string): void => {
  if (actual !== expected) {
    throw new Error(`${msg} (expected ${String(expected)}, got ${String(actual)})`);
  }
};

const inputs = (over: Partial<RepoUpdateInputs> = {}): RepoUpdateInputs => ({
  dataIgnored: true,
  behind: 0,
  ahead: 0,
  dirtyFiles: [],
  incomingFiles: [],
  stale: false,
  ...over,
});

const test = (name: string, fn: () => void) => registered.push({ name, fn });
const registered: Array<{ name: string; fn: () => void }> = [];

test('up to date: nothing to pull, nothing blocked', () => {
  const d = deriveRepoUpdateDecision(inputs());
  eq(d.canSync, false, 'no commits behind means no sync button');
  eq(d.blockedReason, undefined, 'being up to date is not a block, it is a state');
  eq(d.restartRequired, false, 'and it certainly does not require a restart');
});

test('behind on runtime code: sync allowed and a restart is required', () => {
  const d = deriveRepoUpdateDecision(
    inputs({ behind: 3, incomingFiles: ['src/server/pipeline/TradeBot.ts', 'README.md'] })
  );
  eq(d.canSync, true, 'origin moved and the tree is clean');
  eq(d.restartRequired, true, 'src/ is loaded by the running process');
  eq(d.blockedReason, undefined, 'nothing blocks it');
  eq(d.summary.includes('3'), true, 'the operator sees how many commits are coming');
});

test('behind on docs only: sync allowed, no restart', () => {
  const d = deriveRepoUpdateDecision(
    inputs({ behind: 2, incomingFiles: ['README.md', 'docs/AGENTS.md', '.github/workflows/deploy.yml'] })
  );
  eq(d.canSync, true, 'docs are still worth pulling');
  eq(d.restartRequired, false, 'a markdown commit must not bounce the trading process');
});

test('local edits with nothing to pull are not reported as a blocked sync', () => {
  // The working tree is dirty all day while someone develops. With origin not moving, that is
  // not a problem - and calling it "sync blocked" would make a healthy desk look broken.
  const d = deriveRepoUpdateDecision(inputs({ dirtyFiles: ['server.ts', 'src/a.ts'], ahead: 1 }));
  eq(d.canSync, false, 'nothing to pull');
  eq(d.blockedReason, undefined, 'a dirty tree without an update is not a block');
  eq(d.summary.includes('la zi'), true, 'it says the truth: origin has nothing new');
});

test('uncommitted tracked edits block the pull', () => {
  const d = deriveRepoUpdateDecision(
    inputs({ behind: 4, dirtyFiles: ['server.ts', 'src/a.ts', 'b.ts', 'c.ts'] })
  );
  eq(d.canSync, false, 'an ff-only pull over local edits either fails or eats work');
  eq(Boolean(d.blockedReason), true, 'and the reason must be shown, not swallowed');
  eq(d.blockedReason!.includes('server.ts'), true, 'the blocked file is named');
  eq(d.blockedReason!.includes('+1'), true, 'the rest are counted, not listed forever');
});

test('local commits ahead block the pull (no merge, no rebase)', () => {
  const d = deriveRepoUpdateDecision(inputs({ ahead: 2, behind: 1, incomingFiles: ['src/x.ts'] }));
  eq(d.canSync, false, 'a diverged history is not a fast-forward');
  eq(d.blockedReason!.includes('2'), true, 'the number of local commits is reported');
});

test('.data no longer ignored stops everything, even when there is nothing to pull', () => {
  // The dangerous state is silent: git add -A would happily stage keys and orders. It must be
  // shouted about, not reported as a healthy "up to date".
  const d = deriveRepoUpdateDecision(inputs({ dataIgnored: false }));
  eq(d.canSync, false, 'no sync while secrets could be committed');
  eq(Boolean(d.blockedReason), true, 'and it is a block, not a footnote');
  eq(d.blockedReason!.includes('.data'), true, 'naming the directory that is at risk');
});

test('a stale process is actionable even with nothing to pull', () => {
  // The pull landed but the restart did not (lint gate). origin has nothing new, yet the running
  // code is old - so the badge must NOT say "cod la zi" and go quiet.
  const d = deriveRepoUpdateDecision(inputs({ stale: true }));
  eq(d.canSync, true, 'there IS work to do: verify the tree and restart');
  eq(d.restartRequired, true, 'a restart is exactly what is missing');
  eq(d.blockedReason, undefined, 'nothing blocks it');
  eq(d.summary.includes('lint'), true, 'the summary names what the click will run');
});

test('a stale process does not need a clean tree to be restarted', () => {
  // Restarting reads the working tree, it never merges into it, so local edits are irrelevant.
  const d = deriveRepoUpdateDecision(inputs({ stale: true, dirtyFiles: ['server.ts'], ahead: 2 }));
  eq(d.canSync, false, 'restartul nu publica: cu commit-uri locale nepublicate scriptul refuza');
  eq(d.restartRequired, true, 'starea stale ramane adevarata, doar actiunea e blocata');
  eq(Boolean(d.blockedReason), true, 'si motivul e spus, nu ascuns');
  eq(d.blockedReason!.includes('nepublicate'), true, 'operatorul afla ce are de facut');
});

test('a stale process with a clean tree is one click', () => {
  const d = deriveRepoUpdateDecision(inputs({ stale: true, dirtyFiles: ['server.ts'] }));
  eq(d.canSync, true, 'modificarile locale nu blocheaza un restart (nu se face merge)');
  eq(d.restartRequired, true, 'lint + restart e actiunea');
  eq(d.blockedReason, undefined, 'nimic nu o opreste');
});

test('runtime path detection matches scripts/sync-repo.ps1', () => {
  // If these two disagree, the badge says "no restart needed" and the script restarts anyway
  // (or worse, the other way round: fresh code silently not loaded).
  eq(isRuntimePath('src/components/BloombergTerminal.tsx'), true, 'src/ is runtime');
  eq(isRuntimePath('server.ts'), true, 'the entrypoint is runtime');
  eq(isRuntimePath('package.json'), true, 'a dependency change needs a restart');
  eq(isRuntimePath('vite.config.ts'), true, 'build config is runtime');
  eq(isRuntimePath('public/logo.png'), true, 'public/ is served by the app');
  eq(isRuntimePath('README.md'), false, 'docs are not runtime');
  eq(isRuntimePath('scripts/restart-app.ps1'), false, 'repo tooling is not runtime');
  eq(isRuntimePath('.github/workflows/deploy.yml'), false, 'workflow config is not runtime');
});

const run = () => {
  let failed = 0;
  for (const t of registered) {
    try {
      t.fn();
      console.log(`  ok    ${t.name}`);
    } catch (err: any) {
      failed++;
      console.error(`  FAIL  ${t.name}`);
      console.error(`        ${err?.message || err}`);
    }
  }
  const total = registered.length;
  console.log(`\n${total - failed}/${total} repo-update tests passed`);
  if (failed > 0) process.exitCode = 1;
};

void run();
