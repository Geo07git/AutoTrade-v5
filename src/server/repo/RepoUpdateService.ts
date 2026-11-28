import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { deriveRepoUpdateDecision, RepoUpdateDecision } from './repoUpdateLogic';

/**
 * "Did origin move?" - answered on a schedule, by the server itself.
 *
 * WHY THE SERVER AND NOT THE BROWSER
 *   The owner should not have to ask. If the check only ran from the UI, a closed tab would mean
 *   an empty desk that silently keeps running stale code. So the poll lives here and the badge
 *   only reads a value that is already fresh; the UI cannot be the only trigger.
 *
 * WHY THIS IS SAFE TO RUN UNATTENDED
 *   `git fetch` writes only inside `.git` (remote refs). It never touches the working tree, never
 *   merges, never pulls, never commits. The pull itself stays a deliberate operator action
 *   (`scripts/sync-repo.ps1`), which is also the only place that restarts the process.
 */

export interface RepoUpdateStatus extends RepoUpdateDecision {
  ok: boolean;
  error?: string;
  repoRoot: string;
  isRepo: boolean;
  branch: string;
  headSha: string;
  remoteSha: string;
  /** Commit the RUNNING process was started from (short). */
  runningSha: string;
  /** True when HEAD moved after this process started: disk is newer than what is running. */
  stale: boolean;
  behind: number;
  ahead: number;
  dirtyFiles: string[];
  incomingFiles: string[];
  incomingCommits: { sha: string; subject: string }[];
  dataIgnored: boolean;
  checkedAt: number;
  checkIntervalMs: number;
  nextCheckAt: number;
  checking: boolean;
  syncing: boolean;
  autoCheckEnabled: boolean;
}

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MIN_INTERVAL_MS = 60 * 1000;
/**
 * Hard backstop for the "a sync is running" flag. A docs-only sync finishes WITHOUT a restart, so
 * nothing would ever reset it; left unbounded it would 409 every later attempt until a restart.
 */
const SYNC_BACKSTOP_MS = 10 * 60 * 1000;
const GIT_TIMEOUT_MS = 25_000;
const MAX_BUFFER = 200_000;

function emptyStatus(repoRoot: string, checkIntervalMs: number): RepoUpdateStatus {
  return {
    ok: false,
    repoRoot,
    isRepo: false,
    branch: 'main',
    headSha: '',
    remoteSha: '',
    runningSha: '',
    stale: false,
    behind: 0,
    ahead: 0,
    dirtyFiles: [],
    incomingFiles: [],
    incomingCommits: [],
    dataIgnored: false,
    canSync: false,
    restartRequired: false,
    summary: 'Verificare neinitializata.',
    checkedAt: 0,
    checkIntervalMs,
    nextCheckAt: 0,
    checking: false,
    syncing: false,
    autoCheckEnabled: false,
  };
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Bounded `git` call: never blocks the event loop, never waits for credentials, never hangs. */
function runGit(args: string[], cwd: string, timeoutMs: number = GIT_TIMEOUT_MS): Promise<GitResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };

    let child;
    try {
      child = spawn('git', args, {
        cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0', // never block on a credential prompt
          GIT_PAGER: 'cat',
          GIT_OPTIONAL_LOCKS: '0',
        },
      });
    } catch (err: any) {
      resolve({ code: -1, stdout: '', stderr: err?.message || 'git spawn failed' });
      return;
    }

    timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
      stderr += ` (timeout ${timeoutMs}ms)`;
      finish(-2);
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
      if (stdout.length > MAX_BUFFER) stdout = stdout.slice(-MAX_BUFFER);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
    });
    child.on('error', (err: any) => {
      stderr += err?.message || 'git error';
      finish(-1);
    });
    child.on('close', (code) => finish(typeof code === 'number' ? code : -1));
  });
}

function splitLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export class RepoUpdateService {
  private readonly repoRoot: string;
  private readonly intervalMs: number;
  private status: RepoUpdateStatus;
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<RepoUpdateStatus>;
  private syncing = false;
  private syncingSince = 0;
  /** HEAD at boot: the only way to know what the running code actually is. */
  private runningShaFull = '';

  constructor(repoRoot: string = process.cwd(), intervalMs?: number) {
    const envInterval = Number(process.env.REPO_UPDATE_CHECK_MS);
    const requested = intervalMs ?? (Number.isFinite(envInterval) && envInterval > 0 ? envInterval : DEFAULT_INTERVAL_MS);
    this.intervalMs = Math.max(MIN_INTERVAL_MS, Math.round(requested));
    this.repoRoot = path.resolve(repoRoot);
    this.status = emptyStatus(this.repoRoot, this.intervalMs);
    void this.captureRunningSha();
  }

  /**
   * Records the commit this process was started from. A pull that never restarted leaves HEAD
   * ahead of it, which is exactly the state that must not be reported as "up to date".
   */
  private async captureRunningSha(): Promise<void> {
    const res = await runGit(['rev-parse', 'HEAD'], this.repoRoot, 10_000);
    if (res.code === 0) this.runningShaFull = res.stdout.trim();
  }

  /**
   * Start the unattended poll. Disabled with `REPO_UPDATE_POLL=off`, which is the only supported
   * way to silence it - there is no "manual only" mode, because that is the state this feature
   * exists to remove.
   */
  start(): void {
    const disabled = String(process.env.REPO_UPDATE_POLL || '').toLowerCase() === 'off';
    if (disabled || this.timer) {
      if (disabled) {
        this.status = {
          ...this.status,
          autoCheckEnabled: false,
          summary: 'Verificarea automata a repo-ului este oprita (REPO_UPDATE_POLL=off).',
        };
      }
      return;
    }

    this.status = { ...this.status, autoCheckEnabled: true };
    this.timer = setInterval(() => {
      void this.check(false).catch(() => {});
    }, this.intervalMs);
    // Never keep the process alive just to poll git.
    this.timer.unref?.();

    // First look shortly after boot: the desk is usually opened right after a deploy.
    setTimeout(() => {
      void this.check(false).catch(() => {});
    }, 8_000).unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  getStatus(): RepoUpdateStatus {
    return {
      ...this.status,
      syncing: this.syncing,
      checkIntervalMs: this.intervalMs,
      autoCheckEnabled: Boolean(this.timer),
    };
  }

  /**
   * Returns the cached result when it is still fresh, otherwise re-checks. Concurrent callers
   * share one git run, so a burst of UI requests cannot spawn a burst of fetches.
   */
  async check(force: boolean): Promise<RepoUpdateStatus> {
    const ageMs = Date.now() - this.status.checkedAt;
    const fresh = this.status.checkedAt > 0 && ageMs < this.intervalMs && this.status.ok;
    if (!force && fresh) return this.getStatus();
    if (this.inFlight) return this.inFlight;

    this.status = { ...this.status, checking: true };
    this.inFlight = this.collect()
      .catch((err: any) => {
        const fallback = {
          ...this.status,
          ok: false,
          error: err?.message || 'Verificarea repo-ului a esuat.',
          summary: 'Nu pot verifica repo-ul acum.',
          checkedAt: Date.now(),
        };
        return fallback as RepoUpdateStatus;
      })
      .then((next) => {
        // Clear the in-flight flag as soon as the evidence says the sync is over: nothing left to
        // pull (a docs-only pull never restarts the process) or the backstop elapsed (a failed
        // launch must not lock the feature out forever).
        if (
          this.syncing &&
          ((next.ok && next.behind === 0 && !next.stale) || Date.now() - this.syncingSince > SYNC_BACKSTOP_MS)
        ) {
          this.syncing = false;
          this.syncingSince = 0;
        }
        this.status = { ...next, checking: false, nextCheckAt: Date.now() + this.intervalMs };
        this.inFlight = undefined;
        return this.getStatus();
      });

    return this.inFlight;
  }

  /** True when an operator asked for a sync and the pull script has been launched. */
  isSyncing(): boolean {
    return this.syncing;
  }

  markSyncing(value: boolean): void {
    this.syncing = value;
    this.syncingSince = value ? Date.now() : 0;
  }

  getRepoRoot(): string {
    return this.repoRoot;
  }

  private async collect(): Promise<RepoUpdateStatus> {
    const base = emptyStatus(this.repoRoot, this.intervalMs);
    base.checkedAt = Date.now();

    if (!fs.existsSync(path.join(this.repoRoot, '.git'))) {
      return {
        ...base,
        ok: false,
        error: 'Directorul de lucru nu este un repository git (lipseste .git).',
        summary: 'Nu pot verifica: nu este repo git.',
      };
    }

    const branchRes = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], this.repoRoot, 10_000);
    if (branchRes.code !== 0) {
      return { ...base, ok: false, error: branchRes.stderr.trim() || 'git rev-parse a esuat.', summary: 'Nu pot citi branch-ul.' };
    }
    const branch = branchRes.stdout.trim() || 'main';

    // `.data/` must still be ignored, otherwise the run is already unsafe regardless of origin.
    // Probed with a CHILD path, not `.data` itself: a `directory-only` rule (`.data/`) only matches
    // once git knows the path is a directory, so on a fresh clone - where nothing created it yet -
    // probing `.data` would report "not ignored" and block every sync for the wrong reason.
    const ignoreRes = await runGit(['check-ignore', '-q', path.join('.data', '.probe')], this.repoRoot, 10_000);
    const dataIgnored = ignoreRes.code === 0;

    const headRes = await runGit(['rev-parse', 'HEAD'], this.repoRoot, 10_000);
    const headFull = headRes.code === 0 ? headRes.stdout.trim() : '';
    const headSha = headFull;
    // Unknown running sha (git failed at boot) is NOT treated as stale: a guard that fires on
    // missing data is worse than no guard.
    const stale = Boolean(this.runningShaFull) && Boolean(headFull) && this.runningShaFull !== headFull;

    const fetchRes = await runGit(['fetch', 'origin', '--prune'], this.repoRoot, GIT_TIMEOUT_MS);
    if (fetchRes.code !== 0) {
      return {
        ...base,
        isRepo: true,
        branch,
        headSha: headSha.slice(0, 7),
        dataIgnored,
        ok: false,
        error: (fetchRes.stderr || fetchRes.stdout || 'git fetch a esuat.').trim().slice(0, 400),
        summary: 'Nu pot contacta origin (offline sau remote inaccesibil).',
        ...deriveRepoUpdateDecision({ dataIgnored, behind: 0, ahead: 0, dirtyFiles: [], incomingFiles: [], stale }),
      };
    }

    const remoteRef = `origin/${branch}`;
    const remoteRes = await runGit(['rev-parse', remoteRef], this.repoRoot, 10_000);
    if (remoteRes.code !== 0) {
      return {
        ...base,
        isRepo: true,
        branch,
        headSha: headSha.slice(0, 7),
        dataIgnored,
        ok: false,
        error: `Nu exista ${remoteRef} dupa fetch.`,
        summary: `Nu exista ${remoteRef}.`,
      };
    }
    const remoteSha = remoteRes.stdout.trim();

    const countRes = await runGit(['rev-list', '--left-right', '--count', `HEAD...${remoteRef}`], this.repoRoot, 15_000);
    let ahead = 0;
    let behind = 0;
    if (countRes.code === 0) {
      // "ahead\tbehind" with --left-right --count HEAD...origin
      const parts = countRes.stdout.trim().split(/\s+/);
      ahead = Number.parseInt(parts[0] || '0', 10) || 0;
      behind = Number.parseInt(parts[1] || '0', 10) || 0;
    }

    const dirtyRes = await runGit(['status', '--porcelain', '--untracked-files=no'], this.repoRoot, 15_000);
    const dirtyFiles =
      dirtyRes.code === 0
        ? splitLines(dirtyRes.stdout).map((line) => line.replace(/^[A-Z?!]{1,2}\s+/, ''))
        : [];

    let incomingFiles: string[] = [];
    let incomingCommits: { sha: string; subject: string }[] = [];
    if (behind > 0) {
      const filesRes = await runGit(['diff', '--name-only', `HEAD..${remoteRef}`], this.repoRoot, 15_000);
      if (filesRes.code === 0) incomingFiles = splitLines(filesRes.stdout);

      const logRes = await runGit(
        ['log', '--format=%h%x09%s', '--max-count=10', `HEAD..${remoteRef}`],
        this.repoRoot,
        15_000
      );
      if (logRes.code === 0) {
        incomingCommits = splitLines(logRes.stdout).map((line) => {
          const tab = line.indexOf('\t');
          return tab === -1
            ? { sha: line, subject: '' }
            : { sha: line.slice(0, tab), subject: line.slice(tab + 1) };
        });
      }
    }

    const decision = deriveRepoUpdateDecision({ dataIgnored, behind, ahead, dirtyFiles, incomingFiles, stale });

    return {
      ...base,
      ...decision,
      ok: true,
      isRepo: true,
      branch,
      headSha: headSha.slice(0, 7),
      remoteSha: remoteSha.slice(0, 7),
      runningSha: this.runningShaFull.slice(0, 7),
      stale,
      behind,
      ahead,
      dirtyFiles,
      incomingFiles,
      incomingCommits,
      dataIgnored,
      nextCheckAt: Date.now() + this.intervalMs,
    };
  }
}

/** One instance for the process: the badge polls a value, not a git repository. */
export const repoUpdate = new RepoUpdateService();
