import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, X } from 'lucide-react';

/**
 * Proactive "update available" badge.
 *
 * WHY A FLOATING BADGE AND NOT A HEADER BUTTON
 *   The owner must not have to press anything to LEARN that origin moved. The check runs on the
 *   server every 5 minutes (`RepoUpdateService`, `git fetch` = read-only), this component only
 *   reads that value - so the information exists even when no tab is open, and appears here as
 *   soon as one is.
 *
 * WHY THE PULL IS STILL A CLICK
 *   Pulling changes which code runs. Even though the operation itself is automated end to end
 *   (`scripts/sync-repo.ps1`: ff-only, refuses over local edits, secret guard, lint gate, backup +
 *   clean shutdown + restart), starting it on its own would mean the process swaps itself out
 *   while the operator is not looking. One click is the whole manual surface: no follow-up
 *   decision, no second button.
 */

interface RepoUpdateStatusView {
  ok: boolean;
  error?: string;
  branch?: string;
  headSha: string;
  remoteSha: string;
  behind: number;
  ahead: number;
  runningSha: string;
  stale: boolean;
  dirtyFiles: string[];
  incomingCommits: { sha: string; subject: string }[];
  blockedReason?: string;
  canSync: boolean;
  restartRequired: boolean;
  summary: string;
  checkedAt: number;
  autoCheckEnabled?: boolean;
}

export interface RepoUpdateBadgeProps {
  controlToken: string;
  /** Renders as a header button instead of a floating pill (same state, same click). */
  inline?: boolean;
  /** Surfaces the outcome through the desk's existing alert banner. */
  onNotify?: (type: 'success' | 'error' | 'info', text: string) => void;
  /** Re-reads desk state after the pull/restart actually happened. */
  onRefresh?: () => void;
}

const SYNC_DEADLINE_MS = 360_000; // lint has a 300 s budget in the script, plus pull + restart
const POLL_MS = 60_000;

const fmtClock = (ms: number): string => {
  if (!ms) return '-';
  try {
    return new Date(ms).toLocaleTimeString('ro-RO', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '-';
  }
};

export const RepoUpdateBadge: React.FC<RepoUpdateBadgeProps> = ({
  controlToken,
  inline = false,
  onNotify,
  onRefresh,
}) => {
  const [status, setStatus] = useState<RepoUpdateStatusView | null>(null);
  const [syncing, setSyncing] = useState<boolean>(false);
  const [checking, setChecking] = useState<boolean>(false);
  // Dismissed per remote revision: a new update must reappear, a dismissed one stays dismissed.
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const aliveRef = useRef<boolean>(true);
  const syncingRef = useRef<boolean>(false);

  const notify = useCallback(
    (type: 'success' | 'error' | 'info', text: string) => {
      onNotify?.(type, text);
    },
    [onNotify]
  );

  const authHeaders = useCallback(
    () => ({
      'Content-Type': 'application/json',
      'x-bot-token': controlToken,
    }),
    [controlToken]
  );

  const readStatus = useCallback(
    async (force: boolean): Promise<RepoUpdateStatusView | null> => {
      try {
        const res = await fetch(`/api/bot/repo/status${force ? '?force=1' : ''}`, {
          headers: controlToken ? { 'x-bot-token': controlToken } : undefined,
          cache: 'no-store',
        });
        if (!res.ok) return null;
        const data = await res.json();
        if (!data || data.success === false) return null;
        if (aliveRef.current) setStatus(data as RepoUpdateStatusView);
        return data as RepoUpdateStatusView;
      } catch {
        // Informational only: a failed badge poll is not a trading error and raises no alert.
        return null;
      }
    },
    [controlToken]
  );

  // 1. Keep reading the server-side verdict. The server does the git work; this only displays it.
  useEffect(() => {
    aliveRef.current = true;
    void readStatus(false);

    const timer = setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      void readStatus(false);
    }, POLL_MS);

    const onVisible = () => {
      if (document.visibilityState === 'visible') void readStatus(false);
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      aliveRef.current = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [readStatus]);

  const behind = status?.behind ?? 0;
  const blocked = Boolean(status?.blockedReason);
  const updateKey = status ? `${status.headSha}:${status.remoteSha}` : '';

  // Four states, and three of them are ALWAYS visible. A badge that disappears when there is
  // nothing to do is indistinguishable from a badge that is broken, so "COD LA ZI" stays on
  // screen and doubles as the "check now" button.
  const variant: 'blocked' | 'update' | 'stale' | 'offline' | 'current' =
    behind > 0
      ? blocked
        ? 'blocked'
        : 'update'
      : behind === 0 && status?.stale
      ? 'stale'
      : status && status.ok
      ? 'current'
      : 'offline';
  const isDismissed =
    (variant === 'update' || variant === 'blocked' || variant === 'stale') &&
    dismissedKey !== null &&
    dismissedKey === updateKey;

  const chipClass =
    variant === 'update'
      ? 'bg-amber-500 text-black border-amber-300'
      : variant === 'stale'
      ? 'bg-amber-400 text-black border-amber-200'
      : variant === 'blocked'
      ? 'bg-rose-950/95 text-rose-200 border-rose-500'
      : variant === 'offline'
      ? 'bg-rose-950/90 text-rose-300 border-rose-500/60'
      : 'bg-black/90 text-emerald-400/85 border-emerald-500/30';

  const titleText =
    variant === 'blocked'
      ? `${status?.blockedReason}\n\nRezolva blocajul si reia. Manual: scripts\\sync-repo.ps1 -Restart`
      : variant === 'update'
      ? `${status?.summary}\n\nClick = git pull --ff-only + npm run lint${
          status?.restartRequired
            ? ' + repornire automata (copie .data/, shutdown curat)'
            : ' (fara restart: doar fisiere non-runtime)'
        }.\nVerificat automat la ${fmtClock(status?.checkedAt || 0)} (${status?.branch || 'main'} ${
          status?.headSha
        } -> ${status?.remoteSha}).`
      : variant === 'offline'
      ? `Nu pot verifica origin: ${status?.error || 'eroare necunoscuta'}.\nClick = reincearca acum.`
      : variant === 'stale'
      ? `Codul de pe disc (${
          status?.headSha
        }) nu ruleaza: procesul a pornit din ${status?.runningSha}.\n\nClick = npm run lint pe arborele curent, apoi repornire (backup .data/, shutdown curat).\nDaca lint-ul pica, serverul vechi ramane sus.\nSe intampla dupa un pull al carui restart nu a avut loc.`
      : `Cod la zi cu origin/${status?.branch || 'main'} (${status?.headSha}).\nVerificare automata la 5 min, ultima la ${fmtClock(
          status?.checkedAt || 0
        )}. Procesul ruleaza exact acelasi commit. Click = verifica acum.`;

  const handleRecheck = async () => {
    if (checking) return;
    setChecking(true);
    const next = await readStatus(true);
    setChecking(false);
    if (!next) {
      notify('error', 'Nu pot verifica origin acum (offline sau token respins).');
    } else if (!next.ok) {
      notify('error', next.error || 'Nu pot contacta origin.');
    } else if (next.behind > 0) {
      notify('info', `Origin are ${next.behind} commit(uri) noi pe ${next.branch}.`);
    } else {
      notify('success', `Cod la zi cu origin/${next.branch} (${next.headSha}).`);
    }
  };

  const handleSync = async () => {
    if (!status || syncingRef.current) return;

    if (status.blockedReason) {
      notify('error', status.blockedReason);
      return;
    }

    const commitPreview = (status.incomingCommits || [])
      .slice(0, 5)
      .map((c) => `- ${c.sha} ${c.subject}`)
      .join('\n');

    const staleOnly = Boolean(status.stale) && status.behind === 0;

    // The click on the badge IS the decision. A docs-only pull changes nothing that is running,
    // so it goes straight through; only a pull that will replace the running process stops to be
    // read first. That is the single question worth asking, and it is asked once.
    if (status.restartRequired) {
      const confirmed = window.confirm(
        staleOnly
          ? `Repornesc serverul ca sa incarce codul de pe disc?\n\n` +
            `Procesul ruleaza ${status.runningSha || '?'}, discul are ${status.headSha}.\n\n` +
            'Ce se intampla:\n' +
            '1. npm run lint pe arborele curent\n' +
            '2. repornire automata: copie .data/, shutdown curat, pornire, /api/health\n' +
            '\nDaca lint-ul pica, serverul vechi ramane sus si functional.\n' +
            'Log: %TEMP%\\autotrade-sync.log'
          : `Aduc ${status.behind} commit(uri) de pe origin/${status.branch || 'main'}?\n\n` +
            (commitPreview ? `${commitPreview}\n\n` : '') +
            'Ce se intampla, in ordine:\n' +
            '1. git pull --ff-only (fara merge, fara rebase; refuza daca ai modificari locale)\n' +
            '2. npm run lint pe codul nou\n' +
            '3. repornire automata: copie .data/, shutdown curat, pornire, /api/health\n' +
            '\nDaca lint-ul pica, serverul vechi ramane sus si functional.\n' +
            'Log: %TEMP%\\autotrade-sync.log'
      );
      if (!confirmed) return;
    }

    syncingRef.current = true;
    setSyncing(true);
    notify(
      'info',
      staleOnly
        ? 'Rulez lint pe codul de pe disc si repornesc serverul...'
        : `Se aduc ${status.behind} commit(uri) de pe origin/${status.branch || 'main'}. Astept pull-ul${
            status.restartRequired ? ' si repornirea serverului' : ''
          }...`
    );

    let previousStartedAt: number | null = null;
    try {
      const preRes = await fetch('/api/health', { cache: 'no-store' });
      if (preRes.ok) {
        const preData = await preRes.json();
        if (typeof preData?.startedAt === 'number') previousStartedAt = preData.startedAt;
      }
    } catch {
      // no baseline: the loop below still detects "behind became 0"
    }

    try {
      const res = await fetch('/api/bot/repo/sync', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ source: 'ui-badge' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.success) {
        syncingRef.current = false;
        setSyncing(false);
        notify('error', data?.error || 'Sync-ul nu a pornit. Verifica %TEMP%\\autotrade-sync.log.');
        return;
      }
    } catch (err: any) {
      syncingRef.current = false;
      setSyncing(false);
      notify('error', err?.message || 'Eroare de retea la pornirea sync-ului.');
      return;
    }

    const deadline = Date.now() + SYNC_DEADLINE_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2500));

      // (a) The process was replaced: new startedAt means the new code is what runs now.
      try {
        const hRes = await fetch(`/api/health?ts=${Date.now()}`, { cache: 'no-store' });
        if (hRes.ok) {
          const hData = await hRes.json();
          if (
            hData?.status === 'ok' &&
            typeof hData.startedAt === 'number' &&
            hData.startedAt !== previousStartedAt
          ) {
            syncingRef.current = false;
            setSyncing(false);
            setDismissedKey(null);
            notify('success', 'Cod actualizat de pe origin si server repornit. Starea repo-ului se reimprospateaza.');
            onRefresh?.();
            void readStatus(true);
            return;
          }
        }
      } catch {
        // Expected while the restart script swaps the process: the port is briefly closed.
      }

      // (b) Nothing left to pull. Only a pull that needed NO restart can be called done here: if
      // the process had to be replaced, "behind === 0" just means the pull landed - the running
      // code may still be the old one (lint gate, failed restart). Calling that a success would be
      // the exact lie this badge exists to prevent.
      try {
        const sRes = await fetch('/api/bot/repo/status?force=1', {
          headers: authHeaders(),
          cache: 'no-store',
        });
        if (sRes.ok) {
          const sData = await sRes.json();
          const nothingLeft =
            sData && sData.success !== false && sData.ok && (sData.behind ?? 1) === 0 && !sData.stale;
          if (nothingLeft && !status.restartRequired) {
            if (aliveRef.current) setStatus(sData as RepoUpdateStatusView);
            syncingRef.current = false;
            setSyncing(false);
            setDismissedKey(null);
            notify('success', 'Cod actualizat (fara restart: commit-urile nu ating cod runtime).');
            onRefresh?.();
            return;
          }
        }
      } catch {
        // The old process may already be gone; keep waiting within the deadline.
      }
    }

    syncingRef.current = false;
    setSyncing(false);
    const finalStatus = await readStatus(true).catch(() => null);
    if (finalStatus && finalStatus.ok && finalStatus.behind === 0 && finalStatus.stale) {
      // The pull landed but the process was never replaced: most likely the lint gate refused.
      // Say exactly that - the badge now shows RESTART NECESAR until it is resolved.
      notify(
        'error',
        `Codul de pe disc (${finalStatus.headSha}) NU ruleaza: procesul e tot pe ${
          finalStatus.runningSha || '?'
        }. Nu a repornit (probabil lint rosu). Vezi %TEMP%\\autotrade-sync.log.`
      );
      return;
    }
    notify(
      'error',
      'Sync-ul nu a raportat finalizare in 6 minute. Verifica %TEMP%\\autotrade-sync.log si /api/health.'
    );
  };

  if (!status || isDismissed) return null;

  return (
    <div className={inline ? 'flex items-center' : 'fixed right-2 bottom-24 lg:bottom-3 z-[60] flex items-center'}>
      <div
        className={`flex items-center gap-1.5 rounded border font-mono ${chipClass} ${
          inline
            ? 'px-2 sm:px-2.5 py-1.5 text-[10px] sm:text-xs font-bold'
            : 'px-2 py-1.5 text-[11px] shadow-lg backdrop-blur'
        }`}
        title={titleText}
      >
        {variant === 'update' || variant === 'stale' ? (
          <Download className={`w-3.5 h-3.5 shrink-0 ${syncing ? 'animate-bounce' : ''}`} />
        ) : variant === 'current' ? (
          <CheckCircle2 className={`w-3.5 h-3.5 shrink-0 ${checking ? 'animate-spin' : ''}`} />
        ) : (
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
        )}

        <button
          type="button"
          disabled={syncing}
          onClick={() =>
            void (variant === 'update' || variant === 'blocked' || variant === 'stale'
              ? handleSync()
              : handleRecheck())
          }
          className="font-black tracking-wide cursor-pointer disabled:cursor-wait whitespace-nowrap"
        >
          {syncing
            ? 'SYNC IN CURS...'
            : variant === 'update'
            ? `UPDATE DISPONIBIL (${behind})`
            : variant === 'stale'
            ? 'RESTART NECESAR'
            : variant === 'blocked'
            ? `UPDATE ${behind} BLOCAT`
            : variant === 'offline'
            ? 'GIT OFFLINE'
            : 'COD LA ZI'}
        </button>

        <span
          className={`hidden sm:inline text-[9px] ${
            variant === 'current'
              ? 'text-emerald-400/50'
              : blocked
              ? 'text-rose-300/80'
              : 'text-black/60'
          }`}
        >
          {variant === 'update' || variant === 'blocked'
            ? `${status.headSha} -> ${status.remoteSha}`
            : variant === 'stale'
            ? `${status.runningSha || '?'} -> ${status.headSha}`
            : `${status.headSha} ${fmtClock(status.checkedAt)}`}
        </span>

        {(variant === 'update' || variant === 'blocked' || variant === 'stale') && (
          <button
            type="button"
            disabled={syncing}
            onClick={() => setDismissedKey(updateKey)}
            title="Ascunde pana la urmatorul commit pe origin (sincronizarea ramane disponibila din scripts\\sync-repo.ps1)"
            className={`ml-0.5 rounded p-0.5 cursor-pointer disabled:opacity-40 ${
              blocked ? 'hover:bg-rose-900' : 'hover:bg-amber-600'
            }`}
          >
            <X className="w-3 h-3" />
          </button>
        )}
      </div>
    </div>
  );
};
