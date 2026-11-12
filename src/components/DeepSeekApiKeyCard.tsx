import React, { useCallback, useState } from 'react';
import {
  BrainCircuit,
  CheckCircle2,
  Eye,
  EyeOff,
  Key,
  RefreshCw,
  Save,
  ShieldAlert,
  Trash2,
} from 'lucide-react';
import type { DeepSeekAgentStatus } from '../shared/types';

interface DeepSeekApiKeyCardProps {
  agentStatus?: Omit<DeepSeekAgentStatus, 'decisions'> | null;
  controlToken?: string;
  onNotify: (banner: { type: 'success' | 'error' | 'info'; text: string }) => void;
  onRefresh?: () => void;
  onOpenAgent?: () => void;
}

/**
 * Compact DeepSeek credential card for the OKX / API tab.
 *
 * It is intentionally a thin client over the same endpoints the DeepSeek panel uses
 * (`POST /api/bot/agent/api-key`): one source of truth for the stored key, so saving
 * here or in tab 8 produces exactly the same state. The full tuning (limits,
 * guardrails, mode) stays in tab 8 — this card only answers "is the agent
 * authenticated, and what do I do if it isn't".
 */
export const DeepSeekApiKeyCard: React.FC<DeepSeekApiKeyCardProps> = ({
  agentStatus,
  controlToken,
  onNotify,
  onRefresh,
  onOpenAgent,
}) => {
  const [keyInput, setKeyInput] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState<null | 'save' | 'clear'>(null);

  const authHeaders = useCallback((): Record<string, string> => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = (controlToken || '').trim();
    if (token) {
      headers['x-bot-token'] = token;
      headers['Authorization'] = `Bearer ${token}`;
    }
    return headers;
  }, [controlToken]);

  const postKey = useCallback(
    async (apiKey: string, label: string) => {
      setBusy(label === 'save' ? 'save' : 'clear');
      try {
        const res = await fetch('/api/bot/agent/api-key', {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({ apiKey }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data?.success === false) {
          throw new Error(data?.error || `HTTP ${res.status}`);
        }
        onNotify({
          type: 'success',
          text: apiKey.trim() ? 'Cheie API DeepSeek salvata.' : 'Cheie API DeepSeek stearsa.',
        });
        setKeyInput('');
        onRefresh?.();
      } catch (err: any) {
        onNotify({ type: 'error', text: `Cheia DeepSeek nu a putut fi salvata: ${err?.message || err}` });
      } finally {
        setBusy(null);
      }
    },
    [authHeaders, onNotify, onRefresh]
  );

  const keySet = Boolean(agentStatus?.isConfigured);
  const engine = agentStatus?.engine || 'DEEPSEEK';
  const mode = agentStatus?.mode || 'OFF';
  const model = agentStatus?.model || 'deepseek-chat';
  const baseUrl = agentStatus?.config?.baseUrl || 'https://api.deepseek.com';

  return (
    <div className="lg:col-span-2 bg-zinc-950 border border-violet-500/40 rounded p-4 space-y-3">
      <div className="flex items-center justify-between border-b border-violet-500/30 pb-2 flex-wrap gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <h2 className="font-bold text-sm text-violet-300 flex items-center gap-2">
            <BrainCircuit className="w-4 h-4 text-violet-400" />
            CONFIGURARE API DEEPSEEK (AGENT AI)
          </h2>
          <span
            className={`px-2 py-0.5 text-[10px] font-bold rounded border ${
              keySet
                ? 'bg-emerald-950/80 border-emerald-500/50 text-emerald-300'
                : 'bg-amber-950/80 border-amber-500/50 text-amber-300'
            }`}
          >
            {keySet ? 'CHEIE SETATA' : 'CHEIE NESETATA'}
          </span>
          <span className="px-2 py-0.5 text-[10px] font-mono rounded bg-black border border-zinc-700 text-zinc-400">
            {mode} · {engine}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {onRefresh && (
            <button
              type="button"
              onClick={() => onRefresh()}
              className="text-xs text-zinc-400 hover:text-white flex items-center gap-1 cursor-pointer"
              title="Reincarca starea agentului"
            >
              <RefreshCw className="w-3.5 h-3.5" /> Refresh
            </button>
          )}
          {onOpenAgent && (
            <button
              type="button"
              onClick={() => onOpenAgent()}
              className="px-2.5 py-1 rounded bg-violet-500 text-black text-[11px] font-black cursor-pointer hover:bg-violet-400"
              title="Setarile complete (mod, limite, guardrails, jurnal) sunt in tabul 8"
            >
              DESCHIDE TAB 8
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
        {[
          ['MODEL', model],
          ['BASE URL', baseUrl],
          ['CHEIE', agentStatus?.apiKeyMasked || 'NESETATA'],
        ].map(([k, v]) => (
          <div key={k} className="bg-black/60 border border-zinc-800 rounded px-2 py-1">
            <div className="text-[9px] text-zinc-500 uppercase">{k}</div>
            <div className="font-mono text-[10px] text-zinc-300 truncate" title={v}>
              {v}
            </div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          type={showKey ? 'text' : 'password'}
          value={keyInput}
          onChange={(e) => setKeyInput(e.target.value)}
          placeholder="sk-..."
          autoComplete="off"
          spellCheck={false}
          className="flex-1 min-w-[200px] bg-black border border-zinc-700 rounded px-2 py-1.5 text-white font-mono text-xs focus:border-violet-500 outline-none"
        />
        <button
          type="button"
          onClick={() => setShowKey((s) => !s)}
          className="px-2 py-1.5 rounded bg-zinc-900 border border-zinc-700 text-zinc-300 text-[11px] cursor-pointer hover:bg-zinc-800"
          title={showKey ? 'Ascunde cheia' : 'Arata cheia introdusa'}
        >
          {showKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
        </button>
        <button
          type="button"
          onClick={() => void postKey(keyInput.trim(), 'save')}
          disabled={busy !== null || !keyInput.trim()}
          className="px-3 py-1.5 rounded bg-violet-500 text-black text-[11px] font-black flex items-center gap-1.5 cursor-pointer hover:bg-violet-400 disabled:opacity-40"
        >
          <Save className="w-3.5 h-3.5" /> {busy === 'save' ? 'SALVEZ...' : 'SALVEAZA CHEIA'}
        </button>
        <button
          type="button"
          onClick={() => void postKey('', 'clear')}
          disabled={busy !== null || !keySet}
          className="px-3 py-1.5 rounded bg-zinc-900 border border-zinc-700 text-zinc-300 text-[11px] font-bold flex items-center gap-1.5 cursor-pointer hover:bg-zinc-800 disabled:opacity-40"
        >
          <Trash2 className="w-3.5 h-3.5" /> {busy === 'clear' ? 'STERG...' : 'STERGE'}
        </button>
      </div>

      {!keySet && (
        <div className="flex items-start gap-2 text-[10px] text-amber-300 bg-amber-950/40 border border-amber-500/40 rounded px-2 py-1.5">
          <ShieldAlert className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span>
            Fara cheie, agentul ruleaza pe fallback determinist (<code>LOCAL_FALLBACK</code>) — ranking TB5,
            fara LLM. Deciziile raman valide, dar nu exista analiza modelului.
          </span>
        </div>
      )}

      {keySet && (
        <div className="flex items-start gap-2 text-[10px] text-emerald-300/90 bg-emerald-950/30 border border-emerald-500/30 rounded px-2 py-1.5">
          <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span>
            Cheia este salvata. Modul agentului este <strong>{mode}</strong> si se schimba doar din tabul 8
            (OFF / ADVISOR / AUTONOMOUS).
          </span>
        </div>
      )}

      <p className="text-[10px] text-zinc-500 leading-relaxed flex items-start gap-1.5">
        <Key className="w-3 h-3 shrink-0 mt-0.5" />
        <span>
          Cheia se scrie doar local in <code className="text-zinc-300">.data/deepseek_credentials.json</code>{' '}
          (gitignored) sau se citeste din <code className="text-zinc-300">DEEPSEEK_API_KEY</code>. Nu este
          afisata niciodata complet si nu ajunge in loguri. Limitele, guardrails-urile si jurnalul de decizii
          sunt in tabul <strong>8: DEEPSEEK AGENT</strong>.
        </span>
      </p>
    </div>
  );
};
