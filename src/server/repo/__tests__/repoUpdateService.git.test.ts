/**
 * Integration check for the git plumbing behind the update badge.
 *
 * The pure decision is covered by repoUpdateLogic.test.ts; this one proves the IO shell really
 * answers "origin moved" from a live `git` (fetch, rev-list parsing, diff --name-only, status),
 * using a throwaway bare remote under %TEMP% - no network, no touching the real repository.
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { RepoUpdateService } from '../RepoUpdateService';

const eq = (actual: unknown, expected: unknown, msg: string): void => {
  if (actual !== expected) {
    throw new Error(`${msg} (expected ${String(expected)}, got ${String(actual)})`);
  }
};

const git = (cwd: string, args: string[]): string => {
  const res = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' },
  });
  if (res.error) throw new Error(`git ${args.join(' ')} could not run: ${res.error.message}`);
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${res.status}): ${res.stderr || res.stdout}`);
  }
  return (res.stdout || '').trim();
};

const commitAll = (cwd: string, message: string): void => {
  git(cwd, ['add', '-A']);
  git(cwd, ['-c', 'user.name=TB5 test', '-c', 'user.email=tb5@test.local', 'commit', '-m', message]);
};

const write = (filePath: string, contents: string): void => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, 'utf8');
};

const main = async (): Promise<void> => {
  // git is a hard requirement of the app's own workflow (scripts/sync-repo.ps1); if it is missing
  // on this machine the integration half cannot say anything, and it says so instead of passing.
  try {
    git(process.cwd(), ['--version']);
  } catch {
    console.log('  skip  git is not available on this machine');
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb5-repo-update-'));
  const remoteDir = path.join(root, 'remote.git');
  const seedDir = path.join(root, 'seed');
  const workDir = path.join(root, 'work');

  // Cleanup is scoped to the directory this test just created under %TEMP%.
  try {
    fs.mkdirSync(remoteDir, { recursive: true });
    fs.mkdirSync(seedDir, { recursive: true });

    git(remoteDir, ['init', '--bare', '-b', 'main']);
    git(seedDir, ['init', '-b', 'main']);

    // .data/ ignored from the first commit: otherwise the service correctly refuses everything.
    write(path.join(seedDir, '.gitignore'), '.data/\n*.log\n');
    write(path.join(seedDir, 'src', 'engine.ts'), 'export const engine = 1;\n');
    commitAll(seedDir, 'init');
    git(seedDir, ['remote', 'add', 'origin', remoteDir]);
    git(seedDir, ['push', '-u', 'origin', 'main']);
    git(root, ['clone', remoteDir, workDir]);

    const service = new RepoUpdateService(workDir, 60_000);

    const first = await service.check(true);
    eq(first.ok, true, 'a clean clone must be readable');
    eq(first.behind, 0, 'a fresh clone is not behind');
    eq(first.ahead, 0, 'and has nothing to publish');
    eq(first.dataIgnored, true, '.data/ is ignored, so the sync guard passes');
    eq(first.canSync, false, 'nothing to pull means nothing to sync');
    eq(first.autoCheckEnabled, false, 'start() was never called here: the poll is opt-in per process');

    // origin moves, touching runtime code
    write(path.join(seedDir, 'src', 'server', 'engine.ts'), 'export const engine = 2;\n');
    commitAll(seedDir, 'feat: change runtime code');
    git(seedDir, ['push', 'origin', 'main']);

    const second = await service.check(true);
    eq(second.behind, 1, 'one commit behind after origin moved');
    eq(second.incomingCommits.length, 1, 'the badge can name what is coming');
    eq(second.canSync, true, 'and the pull is allowed on a clean tree');
    eq(second.restartRequired, true, 'src/ changes mean the process must be replaced');
    eq(
      second.incomingFiles.includes('src/server/engine.ts'),
      true,
      'the changed file is reported, not just the count'
    );

    // local edits: an ff-only pull must not be attempted
    write(path.join(workDir, 'src', 'engine.ts'), 'export const engine = 99;\n');
    const third = await service.check(true);
    eq(third.behind, 1, 'still behind');
    eq(third.canSync, false, 'a dirty tracked file blocks the sync');
    eq(Boolean(third.blockedReason), true, 'and the operator is told why');
    eq(third.blockedReason!.includes('src/engine.ts'), true, 'the blocked file is named');

    // docs-only update: worth pulling, must not bounce the process
    git(workDir, ['checkout', '--', 'src/engine.ts']);
    write(path.join(seedDir, 'README.md'), '# docs\n');
    commitAll(seedDir, 'docs: readme');
    git(seedDir, ['push', 'origin', 'main']);

    const fourth = await service.check(true);
    eq(fourth.behind, 2, 'both commits are now pending on this clone');
    eq(fourth.restartRequired, true, 'the first one still touches runtime code');

    console.log('  ok    git plumbing: behind/ahead, incoming files, dirty guard');
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // best effort: a leftover temp directory must never fail the test run
    }
  }
};

void main().catch((err: any) => {
  console.error('  FAIL  repo update service (git integration)');
  console.error(`        ${err?.message || err}`);
  process.exitCode = 1;
});
