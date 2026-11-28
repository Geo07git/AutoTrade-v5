/**
 * Pure decision logic for "is there an update on origin, and is it safe to pull it".
 *
 * Kept free of git/fs so it can be tested without a real repository: the IO shell
 * (`RepoUpdateService`) only gathers facts, this decides what they mean.
 */

export interface RepoUpdateInputs {
  /** `.data/` must still be matched by .gitignore (a secret must never become committable). */
  dataIgnored: boolean;
  /** Commits on origin/<branch> that HEAD does not have. */
  behind: number;
  /** Local commits that origin does not have. */
  ahead: number;
  /** Tracked files with uncommitted modifications (an ff-only pull refuses to run over them). */
  dirtyFiles: string[];
  /** Files the incoming commits touch, used to know whether a restart is needed. */
  incomingFiles: string[];
}

export interface RepoUpdateDecision {
  /** Non-empty when a pull must NOT be attempted. Shown to the operator as the reason. */
  blockedReason?: string;
  /** True only when there is something to pull AND nothing blocks it. */
  canSync: boolean;
  /** True when the incoming commits touch code the running process has loaded. */
  restartRequired: boolean;
  /** One line, ready for the badge tooltip. */
  summary: string;
}

/**
 * Paths that change what the running process executes. Mirrors the `runtimePattern` used by
 * `scripts/sync-repo.ps1`, so the badge and the script cannot disagree about whether the
 * server has to be restarted after the pull.
 */
const RUNTIME_PATTERNS: RegExp[] = [
  /^src\//,
  /^public\//,
  /^(server\.ts|vite\.config\.ts|index\.html|electron\.cjs|package\.json|package-lock\.json|tsconfig\.json|capacitor\.config\.ts)$/,
];

export function isRuntimePath(filePath: string): boolean {
  return RUNTIME_PATTERNS.some((re) => re.test(filePath));
}

export function deriveRepoUpdateDecision(inputs: RepoUpdateInputs): RepoUpdateDecision {
  const restartRequired = inputs.incomingFiles.some(isRuntimePath);

  if (!inputs.dataIgnored) {
    return {
      blockedReason:
        'Nu fac sync: .data/ nu mai este ignorat de git. Orice git add -A ar putea comite chei, pozitii si ordine. Pune regula .data/ inapoi in .gitignore.',
      canSync: false,
      restartRequired,
      summary: 'Sync blocat: .data/ nu este ignorat de git.',
    };
  }

  // Nothing to pull is answered FIRST, before the local-tree checks: a dirty or unpushed tree is
  // not a blocker when there is no update, and reporting it as "sync blocked" would be a lie that
  // makes the desk look broken.
  if (inputs.behind === 0) {
    return {
      canSync: false,
      restartRequired: false,
      summary: 'Cod la zi cu origin.',
    };
  }

  if (inputs.dirtyFiles.length > 0) {
    const preview = inputs.dirtyFiles.slice(0, 3).join(', ');
    const extra = inputs.dirtyFiles.length > 3 ? ` (+${inputs.dirtyFiles.length - 3})` : '';
    return {
      blockedReason:
        `Nu fac sync peste modificari locale nesalvate: ${preview}${extra}. ` +
        'Commita-le sau salveaza-le, apoi reia sync-ul.',
      canSync: false,
      restartRequired,
      summary: `Sync blocat: ${inputs.dirtyFiles.length} fisiere modificate local.`,
    };
  }

  if (inputs.ahead > 0) {
    return {
      blockedReason:
        `Ai ${inputs.ahead} commit(uri) locale nepublicate fata de origin. Sync-ul doar trage (ff-only) si nu face rebase/merge automat.`,
      canSync: false,
      restartRequired,
      summary: `Sync blocat: ${inputs.ahead} commit(uri) locale nepublicate.`,
    };
  }

  return {
    canSync: true,
    restartRequired,
    summary:
      `${inputs.behind} commit(uri) noi pe origin` +
      (restartRequired
        ? ' (ating cod runtime -> restart automat dupa pull).'
        : ' (doar docs/config -> fara restart).'),
  };
}
