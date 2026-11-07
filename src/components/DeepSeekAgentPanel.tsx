import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  BrainCircuit,
  CheckCircle2,
  Clock,
  Eye,
  Key,
  Play,
  Power,
  RefreshCw,
  Save,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Trash2,
  XCircle,
  Zap,
} from 'lucide-react';
import type {
  DeepSeekAgentConfig,
  DeepSeekAgentDecision,
  DeepSeekAgentMode,
  DeepSeekAgentStatus,
} from '../shared/types';

interface DeepSeekAgentPanelProps {
  agentStatus?: DeepSeekAgentStatus;
  controlToken: string;
  onNotify: (banner: { type: 'success' | 'error' | 'info'; text: string }) => void;
  onRefresh?: () => void;
}

interface AgentFormState {
  runIntervalSec: string;
  maxActionsPerCycle: string;
  maxConcurrentBots: string;
  budgetPerBotUSDT: string;
  minReserveUSDT: string;
  maxLeverage: string;
  minSuitabilityScore: string;
  minNetProfitPerGridPct: string;
  cooldownMinutesPerSymbol: string;
  dailyLossLimitUSDT: string;
  hardStopLossPct: string;
  hardMinLiqDistancePct: string;
  hardMaxNoFillMinutes: string;
  temperature: string;
  maxTokens: string;
}

const n = (v: unknown, fallback = 0): number => {
  const parsed = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : fallback;
};

const money = (v: number | undefined, decimals = 2): string => {
  if (v === undefined || v === null || !Number.isFinite(v)) return '--';
  return v.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
};

const clockTime = (ts?: number): string => {
  if (!ts) return '--';
  try {
    return new Date(ts).toLocaleTimeString('ro-RO', { hour12: false });
  } catch {
    return '--';
  }
};

const MODE_META: Record<
  DeepSeekAgentMode,
  { label: string; hint: string; tone: string; active: string; icon: React.ReactNode }
> = {
  OFF: {
    label: 'OFF',
    hint: 'Bucla oprita. Ciclurile manuale sunt dry-run: propun, dar nu executa nimic.',
    tone: 'text-zinc-400 border-zinc-700',
    active: 'bg-zinc-600 text-white border-zinc-400',
    icon: <Power className="w-3.5 h-3.5" />,
  },
  ADVISOR: {
    label: 'ADVISOR',
    hint: 'Analizeaza si jurnalizeaza decizia plus motivele de respingere. NU executa nimic.',
    tone: 'text-cyan-300 border-cyan-500/40',
    active: 'bg-cyan-400 text-black border-cyan-300',
    icon: <Eye className="w-3.5 h-3.5" />,
  },
  AUTONOMOUS: {
    label: 'AUTONOMOUS',
    hint: 'Executa actiunile aprobate, in limitele configurate si ale guard-urilor dure.',
    tone: 'text-emerald-300 border-emerald-500/40',
    active: 'bg-emerald-500 text-black border-emerald-300',
    icon: <Zap className="w-3.5 h-3.5" />,
  },
};

const ACTION_TONE: Record<string, string> = {
  OPEN_GRID: 'text-emerald-300 border-emerald-500/40 bg-emerald-950/20',
  STOP_BOT: 'text-rose-300 border-rose-500/40 bg-rose-950/20',
  AMEND_BOT: 'text-amber-300 border-amber-500/40 bg-amber-950/20',
  HOLD: 'text-zinc-400 border-zinc-700 bg-zinc-900/40',
};

const actionLabel = (action: any): string => {
  if (!action) return 'UNKNOWN';
  if (action.type === 'OPEN_GRID') {
    return `OPEN ${action.instId} [${money(action.minPx)}-${money(action.maxPx)}] ${action.gridNum} grile ${action.lever}x @${money(action.sz)} U`;
  }
  if (action.type === 'STOP_BOT') return `STOP ${action.algoId} (tip ${action.stopType || '1'})`;
  if (action.type === 'AMEND_BOT') {
    return `AMEND ${action.algoId} SL ${action.slTriggerPx ?? action.stopLossPct ?? '-'} / TP ${action.tpTriggerPx ?? action.takeProfitPct ?? '-'}`;
  }
  return 'HOLD';
};

const formFromConfig = (cfg?: DeepSeekAgentConfig): AgentFormState => ({
  runIntervalSec: String(cfg?.runIntervalSec ?? 300),
  maxActionsPerCycle: String(cfg?.maxActionsPerCycle ?? 1),
  maxConcurrentBots: String(cfg?.maxConcurrentBots ?? 2),
  budgetPerBotUSDT: String(cfg?.budgetPerBotUSDT ?? 20),
  minReserveUSDT: String(cfg?.minReserveUSDT ?? 10),
  maxLeverage: String(cfg?.maxLeverage ?? 5),
  minSuitabilityScore: String(cfg?.minSuitabilityScore ?? 70),
  minNetProfitPerGridPct: String(cfg?.minNetProfitPerGridPct ?? 0.1),
  cooldownMinutesPerSymbol: String(cfg?.cooldownMinutesPerSymbol ?? 30),
  dailyLossLimitUSDT: String(cfg?.dailyLossLimitUSDT ?? 25),
  hardStopLossPct: String(cfg?.hardStopLossPct ?? 12),
  hardMinLiqDistancePct: String(cfg?.hardMinLiqDistancePct ?? 15),
  hardMaxNoFillMinutes: String(cfg?.hardMaxNoFillMinutes ?? 180),
  temperature: String(cfg?.temperature ?? 0.2),
  maxTokens: String(cfg?.maxTokens ?? 1200),
});

export const DeepSeekAgentPanel: React.FC<DeepSeekAgentPanelProps> = ({
  agentStatus,
  controlToken,
  onNotify,
  onRefresh,
}) => {
  const [status, setStatus] = useState<DeepSeekAgentStatus | undefined>(agentStatus);
  const [form, setForm] = useState<AgentFormState>(() => formFromConfig(agentStatus?.config));
  const [formDirty, setFormDirty] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hydratedRef = useRef(false);

  const cfg = status?.config;

  const authHeaders = useCallback(
    () => ({
      'Content-Type': 'application/json',
      'x-bot-token': controlToken || 'tradebot5_admin_token',
    }),
    [controlToken]
  );

  const loadStatus = useCallback(
    async (silent = false) => {
      try {
        const res = await fetch('/api/bot/agent/status?limit=20', { cache: 'no-store' });
        const data = await res.json();
        if (data?.success && data.agent) {
          setStatus(data.agent as DeepSeekAgentStatus);
          setError(null);
          if (!silent) onRefresh?.();
        } else if (!silent) {
          setError(data?.error || 'Nu am putut citi starea agentului.');
        }
      } catch (err: any) {
        if (!silent) setError(err?.message || 'Eroare de retea la citirea starii agentului.');
      }
    },
    [onRefresh]
  );

  // Hydrate the form only once, so polling never overwrites unsaved edits.
  useEffect(() => {
    if (status && !hydratedRef.current) {
      hydratedRef.current = true;
      setForm(formFromConfig(status.config));
    }
  }, [status]);

  useEffect(() => {
    if (!status && agentStatus) setStatus(agentStatus);
  }, [agentStatus, status]);

  useEffect(() => {
    void loadStatus(true);
    const t = setInterval(() => void loadStatus(true), 15_000);
    return () => clearInterval(t);
  }, [loadStatus]);

  const postJson = useCallback(
    async (url: string, body: Record<string, unknown>) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.success === false) {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      if (data.agent) setStatus(data.agent as DeepSeekAgentStatus);
      return data;
    },
    [authHeaders]
  );

  const saveConfig = useCallback(
    async (patch: Record<string, unknown>, label: string) => {
      setBusy(label);
      setError(null);
      try {
        const data = await postJson('/api/bot/agent/config', patch);
        if (data.config) setForm(formFromConfig(data.config as DeepSeekAgentConfig));
        setFormDirty(false);
        onNotify({ type: 'success', text: `${label}: salvat.` });
        await loadStatus(true);
      } catch (err: any) {
        setError(err?.message || 'Salvarea configuratiei a esuat.');
        onNotify({ type: 'error', text: `Eroare: ${err?.message || 'salvare respinsa'}` });
      } finally {
        setBusy(null);
      }
    },
    [loadStatus, onNotify, postJson]
  );

  const changeMode = useCallback(
    async (mode: DeepSeekAgentMode) => {
      if (mode === 'AUTONOMOUS') {
        const confirmed = window.confirm(
          'AUTONOMOUS: agentul va putea DESCHIDE si OPRI griduri native pe contul LIVE, in limitele configurate.\n\n' +
            'Guard-urile dure (SL, distanta la lichidare, breakout, bot fara arbitraje) raman active si nu depind de model.\n\n' +
            'Confirmi activarea executiei autonome?'
        );
        if (!confirmed) return;
      }
      await saveConfig({ mode }, `Mod ${mode}`);
    },
    [saveConfig]
  );

  const saveKey = useCallback(async () => {
    setBusy('key');
    setError(null);
    try {
      await postJson('/api/bot/agent/api-key', { apiKey: apiKeyInput.trim() });
      onNotify({
        type: 'success',
        text: apiKeyInput.trim() ? 'Cheie API DeepSeek salvata.' : 'Cheie API DeepSeek stearsa.',
      });
      setApiKeyInput('');
      await loadStatus(true);
    } catch (err: any) {
      setError(err?.message || 'Salvarea cheii API a esuat.');
      onNotify({ type: 'error', text: `Eroare cheie API: ${err?.message || 'necunoscuta'}` });
    } finally {
      setBusy(null);
    }
  }, [apiKeyInput, loadStatus, onNotify, postJson]);

  const clearKey = useCallback(async () => {
    if (!window.confirm('Stergi cheia DeepSeek? Agentul va rula pe fallback determinist.')) return;
    setBusy('clear-key');
    setError(null);
    try {
      await postJson('/api/bot/agent/api-key', { apiKey: '' });
      onNotify({ type: 'success', text: 'Cheie API DeepSeek stearsa.' });
      await loadStatus(true);
    } catch (err: any) {
      setError(err?.message || 'Stergerea cheii API a esuat.');
    } finally {
      setBusy(null);
    }
  }, [loadStatus, onNotify, postJson]);

  const runNow = useCallback(async () => {
    setBusy('run');
    setError(null);
    try {
      const data = await postJson('/api/bot/agent/run', { trigger: 'MANUAL' });
      const decision: DeepSeekAgentDecision | undefined = data.decision;
      const executed = decision?.results.filter((r) => r.success).length || 0;
      onNotify({
        type: decision?.dryRun ? 'info' : executed > 0 ? 'success' : 'info',
        text: decision
          ? `${decision.dryRun ? 'DRY-RUN' : 'EXECUTAT'} (${decision.engine}, ${decision.latencyMs}ms): ${
              decision.summaryRo || 'fara sumar'
            } | aprobate ${decision.approvedActions.length}, respinse ${decision.rejectedActions.length}, executate ${executed}`
          : 'Ciclu finalizat.',
      });
      await loadStatus(true);
    } catch (err: any) {
      setError(err?.message || 'Ciclul manual a esuat.');
      onNotify({ type: 'error', text: `Eroare ciclu: ${err?.message || 'necunoscuta'}` });
    } finally {
      setBusy(null);
    }
  }, [loadStatus, onNotify, postJson]);

  const panicStop = useCallback(async () => {
    const confirmed = window.confirm(
      'PANIC STOP: agentul trece pe OFF si bucla moare imediat.\n\n' +
        'Botii deja deschisi NU sunt atinsi (ii opresti din tab-ul 1 sau cu STOP URGENTA).\n\n' +
        'Continui?'
    );
    if (!confirmed) return;
    setBusy('panic');
    setError(null);
    try {
      await postJson('/api/bot/agent/stop', {
        reason: 'Panic stop din Terminal TB5 (tab DeepSeek Agent)',
      });
      onNotify({ type: 'success', text: 'Agent oprit: mod OFF, bucla terminata.' });
      await loadStatus(true);
    } catch (err: any) {
      setError(err?.message || 'Oprirea agentului a esuat.');
      onNotify({ type: 'error', text: `Eroare panic stop: ${err?.message || 'necunoscuta'}` });
    } finally {
      setBusy(null);
    }
  }, [loadStatus, onNotify, postJson]);

  const setField = (key: keyof AgentFormState, value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setFormDirty(true);
  };

  const submitForm = useCallback(async () => {
    await saveConfig(
      {
        runIntervalSec: n(form.runIntervalSec, 300),
        maxActionsPerCycle: n(form.maxActionsPerCycle, 1),
        maxConcurrentBots: n(form.maxConcurrentBots, 2),
        budgetPerBotUSDT: n(form.budgetPerBotUSDT, 20),
        minReserveUSDT: n(form.minReserveUSDT, 10),
        maxLeverage: n(form.maxLeverage, 5),
        minSuitabilityScore: n(form.minSuitabilityScore, 70),
        minNetProfitPerGridPct: n(form.minNetProfitPerGridPct, 0.1),
        cooldownMinutesPerSymbol: n(form.cooldownMinutesPerSymbol, 30),
        dailyLossLimitUSDT: n(form.dailyLossLimitUSDT, 25),
        hardStopLossPct: n(form.hardStopLossPct, 12),
        hardMinLiqDistancePct: n(form.hardMinLiqDistancePct, 15),
        hardMaxNoFillMinutes: n(form.hardMaxNoFillMinutes, 180),
        temperature: n(form.temperature, 0.2),
        maxTokens: n(form.maxTokens, 1200),
      },
      'Limite si guardrails'
    );
  }, [form, saveConfig]);

  const snapshot = status?.accountSnapshot;
  const decisions = useMemo(() => (status?.decisions || []).slice(0, 6), [status?.decisions]);
  const mode = status?.mode || 'OFF';
  const autonomousOnPaper = mode === 'AUTONOMOUS' && snapshot?.executionMode === 'PAPER';
  const autonomousWithoutKey = mode === 'AUTONOMOUS' && !status?.isConfigured;

  const numberField = (
    label: string,
    key: keyof AgentFormState,
    hint: string,
    step = '1'
  ) => (
    <div key={key}>
      <label className="text-[10px] text-zinc-500 uppercase tracking-wide block mb-0.5">
        {label}
      </label>
      <input
        type="number"
        step={step}
        value={form[key]}
        onChange={(e) => setField(key, e.target.value)}
        className="w-full bg-black border border-zinc-700 rounded px-2 py-1 text-white font-mono text-xs focus:border-cyan-500 outline-none"
      />
      <p className="text-[9px] text-zinc-600 mt-0.5 leading-tight">{hint}</p>
    </div>
  );

  const toggleRows: Array<[keyof DeepSeekAgentConfig, string, string]> = [
    ['allowOpenBots', 'Permite deschiderea de griduri', 'OPEN_GRID'],
    ['allowStopBots', 'Permite oprirea botilor', 'STOP_BOT'],
    ['allowAmendBots', 'Permite modificarea SL/TP', 'AMEND_BOT'],
    ['scanBeforeDecision', 'Rescaneaza piata inainte de decizie', 'scan live'],
    ['notifyTelegram', 'Trimite deciziile in Telegram', 'notificari'],
    ['fallbackEnabled', 'Fallback determinist fara LLM', 'LOCAL_FALLBACK'],
    ['enforceHardGuardrails', 'Guardrails dure (SL / lichidare / breakout)', 'STRAT DE SIGURANTA'],
    ['preferNativeAlgo', 'Grid nativ OKX (algo real) - ignorat pe _UM_XPERP', 'NATIVE_ALGO'],
    ['stopIfPassive', 'Stop bot pasiv (0 arbitraje) chiar si pe plus', 'capital liber'],
  ];

  return (
    <div className="space-y-3">
      {/* ================= HEADER ================= */}
      <div className="bg-zinc-950 border border-violet-500/40 rounded p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <div className="w-9 h-9 rounded bg-violet-500/15 border border-violet-500/40 flex items-center justify-center">
              <BrainCircuit className="w-5 h-5 text-violet-300" />
            </div>
            <div>
              <h2 className="text-sm font-black text-violet-200 tracking-wide">
                DEEPSEEK AUTONOMOUS AGENT
                <span className="text-zinc-500 font-normal"> // creierul desk-ului NEUTRAL GRID</span>
              </h2>
              <div className="flex flex-wrap items-center gap-1.5 pt-1">
                <span
                  className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${
                    status?.engine === 'DEEPSEEK'
                      ? 'text-violet-300 border-violet-500/50 bg-violet-950/30'
                      : 'text-amber-300 border-amber-500/40 bg-amber-950/20'
                  }`}
                >
                  ENGINE: {status?.engine || '--'}
                </span>
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-zinc-700 text-zinc-400">
                  MODEL: {status?.model || '--'}
                </span>
                <span
                  className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${
                    status?.loopActive
                      ? 'text-emerald-300 border-emerald-500/50 bg-emerald-950/30'
                      : 'text-zinc-500 border-zinc-700'
                  }`}
                >
                  {status?.loopActive ? 'LOOP ACTIV' : 'LOOP OPRIT'}
                </span>
                {status?.nextRunAt ? (
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-zinc-700 text-zinc-400 flex items-center gap-1">
                    <Clock className="w-3 h-3" /> URM {clockTime(status.nextRunAt)}
                  </span>
                ) : null}
                <span
                  className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${
                    status?.isConfigured
                      ? 'text-emerald-300 border-emerald-500/50'
                      : 'text-rose-300 border-rose-500/50'
                  }`}
                >
                  {status?.isConfigured ? 'CHEIE SETATA' : 'FARA CHEIE (fallback)'}
                </span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => void loadStatus()}
              disabled={busy !== null}
              className="px-2.5 py-1.5 rounded bg-zinc-900 border border-zinc-700 text-zinc-300 text-[11px] font-bold flex items-center gap-1.5 cursor-pointer hover:bg-zinc-800 disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${busy ? 'animate-spin' : ''}`} /> Refresh
            </button>
            <button
              type="button"
              onClick={() => void runNow()}
              disabled={busy !== null}
              className="px-2.5 py-1.5 rounded bg-cyan-500 text-black text-[11px] font-black flex items-center gap-1.5 cursor-pointer hover:bg-cyan-400 disabled:opacity-50"
            >
              <Play className="w-3.5 h-3.5" />
              {busy === 'run' ? 'CICLU...' : 'CICLU MANUAL'}
            </button>
            <button
              type="button"
              onClick={() => void panicStop()}
              disabled={busy !== null}
              className="px-2.5 py-1.5 rounded bg-rose-600 text-white text-[11px] font-black flex items-center gap-1.5 cursor-pointer hover:bg-rose-500 disabled:opacity-50"
            >
              <ShieldAlert className="w-3.5 h-3.5" /> PANIC OFF
            </button>
          </div>
        </div>

        {error && (
          <div className="mt-2 text-[11px] text-rose-300 bg-rose-950/30 border border-rose-500/40 rounded px-2 py-1 flex items-start gap-1.5">
            <XCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}
        {cfg?.lastError && !error && (
          <div className="mt-2 text-[11px] text-amber-300 bg-amber-950/20 border border-amber-500/30 rounded px-2 py-1">
            Ultima eroare inregistrata: {cfg.lastError}
          </div>
        )}
      </div>

      {/* ================= WARNING BANNERS ================= */}
      {status?.authorityConflict && (
        <div className="bg-amber-950/25 border border-amber-500/50 rounded p-2.5 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
          <div className="text-[11px] text-amber-200 leading-relaxed">
            <b>CONFLICT DE AUTORITATE:</b>{' '}
            {status.authorityConflictReason ||
              'Autopilot-ul nativ OKX este activ. Agentul nu va deschide boti pana il opresti: un singur trader automat odata.'}
          </div>
        </div>
      )}
      {autonomousOnPaper && (
        <div className="bg-rose-950/25 border border-rose-500/50 rounded p-2.5 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-rose-400 mt-0.5 shrink-0" />
          <div className="text-[11px] text-rose-200 leading-relaxed">
            <b>MODUL AUTONOMOUS pe cont PAPER:</b> agentul nu poate deschide griduri native si nu va
            schimba niciodata modul de executie singur. Treci pe LIVE din tab-ul 5 daca vrei executie
            reala, asumat explicit.
          </div>
        </div>
      )}
      {autonomousWithoutKey && (
        <div className="bg-amber-950/25 border border-amber-500/50 rounded p-2.5 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
          <div className="text-[11px] text-amber-200 leading-relaxed">
            <b>FARA CHEIE DEEPSEEK:</b> ciclurile ruleaza pe fallback determinist (LOCAL_FALLBACK), adica
            ranking-ul TB5 fara rationament LLM. Adauga o cheie mai jos pentru decizii complete.
          </div>
        </div>
      )}
      {snapshot?.killSwitchEngaged && (
        <div className="bg-rose-950/25 border border-rose-500/50 rounded p-2.5 flex items-start gap-2">
          <ShieldAlert className="w-4 h-4 text-rose-400 mt-0.5 shrink-0" />
          <div className="text-[11px] text-rose-200">
            <b>KILL SWITCH ACTIV:</b> nicio actiune de deschidere nu va fi aprobata.
          </div>
        </div>
      )}

      {/* ================= MODE SELECTOR ================= */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
        {(['OFF', 'ADVISOR', 'AUTONOMOUS'] as DeepSeekAgentMode[]).map((m) => {
          const meta = MODE_META[m];
          const isActive = mode === m;
          return (
            <button
              key={m}
              type="button"
              onClick={() => void changeMode(m)}
              disabled={busy !== null || isActive}
              className={`text-left p-2.5 rounded border transition-all cursor-pointer disabled:cursor-default ${
                isActive ? meta.active : `bg-zinc-950 hover:bg-zinc-900 ${meta.tone}`
              }`}
            >
              <div className="flex items-center gap-1.5 font-black text-xs">
                {meta.icon}
                <span>{meta.label}</span>
                {isActive && <CheckCircle2 className="w-3.5 h-3.5 ml-auto" />}
              </div>
              <p
                className={`text-[10px] leading-tight mt-1 ${
                  isActive ? 'opacity-80' : 'text-zinc-500'
                }`}
              >
                {meta.hint}
              </p>
            </button>
          );
        })}
      </div>

      {/* ================= SNAPSHOT + API KEY ================= */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <div className="bg-zinc-950 border border-zinc-800 rounded p-3 space-y-2">
          <h3 className="text-[11px] font-bold text-zinc-300 flex items-center gap-1.5 uppercase tracking-wide">
            <Activity className="w-3.5 h-3.5 text-cyan-400" /> Starea contului (citita de agent)
          </h3>
          <div className="grid grid-cols-2 gap-1.5 text-[11px]">
            {[
              ['MOD EXEC', snapshot?.executionMode || '--'],
              ['ECHITY', `${money(snapshot?.equityUSDT)} U`],
              ['FOND LIBER', `${money(snapshot?.freeBalanceUSDT)} U`],
              ['MARGIN', `${money(snapshot?.marginInvestedUSDT)} U`],
              ['PNL SESIUNE', `${money(snapshot?.sessionPnlUSDT)} U`],
              ['BOTI / SLOTURI', `${snapshot?.runningBots ?? 0} / ${snapshot?.freeSlots ?? 0} libere`],
            ].map(([k, v]) => (
              <div key={k} className="bg-black/60 border border-zinc-800 rounded px-1.5 py-1">
                <div className="text-[9px] text-zinc-500 uppercase">{k}</div>
                <div className="font-mono text-white">{v}</div>
              </div>
            ))}
          </div>
          <div className="text-[10px] text-zinc-500 pt-1 border-t border-zinc-800 grid grid-cols-2 gap-1">
            <div>
              CICLURI: <span className="text-zinc-300 font-mono">{cfg?.totalCycles ?? 0}</span>
            </div>
            <div>
              ACTIUNI: <span className="text-zinc-300 font-mono">{cfg?.totalActionsExecuted ?? 0}</span>
            </div>
            <div>
              ERORI: <span className="text-zinc-300 font-mono">{cfg?.totalErrors ?? 0}</span>
            </div>
            <div>
              ULTIMUL: <span className="text-zinc-300 font-mono">{clockTime(cfg?.lastDecisionAt)}</span>
            </div>
          </div>
        </div>

        <div className="lg:col-span-2 bg-zinc-950 border border-violet-500/30 rounded p-3 space-y-2">
          <h3 className="text-[11px] font-bold text-violet-200 flex items-center gap-1.5 uppercase tracking-wide">
            <Key className="w-3.5 h-3.5 text-violet-300" /> Cheie API DeepSeek (API compatibil OpenAI)
          </h3>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] font-mono px-2 py-1 rounded bg-black border border-zinc-700 text-zinc-400">
              {status?.apiKeyMasked || 'NESETATA'}
            </span>
            <input
              type="password"
              value={apiKeyInput}
              onChange={(e) => setApiKeyInput(e.target.value)}
              placeholder="sk-..."
              autoComplete="off"
              className="flex-1 min-w-[180px] bg-black border border-zinc-700 rounded px-2 py-1 text-white font-mono text-xs focus:border-violet-500 outline-none"
            />
            <button
              type="button"
              onClick={() => void saveKey()}
              disabled={busy !== null || !apiKeyInput.trim()}
              className="px-2.5 py-1.5 rounded bg-violet-500 text-black text-[11px] font-black flex items-center gap-1.5 cursor-pointer hover:bg-violet-400 disabled:opacity-40"
            >
              <Save className="w-3.5 h-3.5" /> {busy === 'key' ? 'SALVEZ...' : 'SALVEAZA CHEIA'}
            </button>
            <button
              type="button"
              onClick={() => void clearKey()}
              disabled={busy !== null || !status?.isConfigured}
              className="px-2.5 py-1.5 rounded bg-zinc-900 border border-zinc-700 text-zinc-300 text-[11px] font-bold flex items-center gap-1.5 cursor-pointer hover:bg-zinc-800 disabled:opacity-40"
            >
              <Trash2 className="w-3.5 h-3.5" /> {busy === 'clear-key' ? 'STERG...' : 'STERGE'}
            </button>
          </div>
          <p className="text-[10px] text-zinc-500 leading-relaxed">
            Cheia se scrie doar in <code className="text-zinc-300">.data/deepseek_credentials.json</code>{' '}
            (gitignored) sau se citeste din <code className="text-zinc-300">DEEPSEEK_API_KEY</code> si nu
            este niciodata afisata complet sau scrisa in loguri. Fara cheie, agentul ruleaza pe fallback
            determinist.
          </p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-1.5 pt-1">
            {[
              ['BASE URL', cfg?.baseUrl || '--'],
              ['TEMP', String(cfg?.temperature ?? '--')],
              ['MAX TOKENS', String(cfg?.maxTokens ?? '--')],
              ['INTERVAL', `${cfg?.runIntervalSec ?? '--'}s`],
            ].map(([k, v]) => (
              <div key={k} className="bg-black/60 border border-zinc-800 rounded px-1.5 py-1">
                <div className="text-[9px] text-zinc-500 uppercase">{k}</div>
                <div className="font-mono text-[10px] text-zinc-300 truncate" title={v}>
                  {v}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ================= LIMITS & GUARDRAILS ================= */}
      <div className="bg-zinc-950 border border-zinc-800 rounded p-3 space-y-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h3 className="text-[11px] font-bold text-amber-300 flex items-center gap-1.5 uppercase tracking-wide">
            <ShieldCheck className="w-3.5 h-3.5" /> Limite de executie si guardrails dure
          </h3>
          <div className="flex items-center gap-1.5">
            {formDirty && (
              <span className="text-[10px] text-amber-400 font-bold">MODIFICARI NESALVATE</span>
            )}
            <button
              type="button"
              onClick={() => void submitForm()}
              disabled={busy !== null}
              className="px-2.5 py-1.5 rounded bg-amber-500 text-black text-[11px] font-black flex items-center gap-1.5 cursor-pointer hover:bg-amber-400 disabled:opacity-50"
            >
              <Save className="w-3.5 h-3.5" />{' '}
              {busy === 'Limite si guardrails' ? 'SALVEZ...' : 'SALVEAZA LIMITELE'}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-5 gap-2">
          {numberField('Interval ciclu (s)', 'runIntervalSec', 'clamp 60-3600s', '30')}
          {numberField('Buget / bot (U)', 'budgetPerBotUSDT', 'plafon dur per grid', '1')}
          {numberField('Rezerva libera (U)', 'minReserveUSDT', 'cash care nu se atinge', '1')}
          {numberField('Max boti simultan', 'maxConcurrentBots', 'sloturi gestionate', '1')}
          {numberField('Levier maxim', 'maxLeverage', 'clamp 1-20x', '1')}
          {numberField('Scor minim', 'minSuitabilityScore', '0-100, prag eligibilitate', '1')}
          {numberField('Profit net min %/grila', 'minNetProfitPerGridPct', 'sub prag nu deschide', '0.01')}
          {numberField('Cooldown / simbol (min)', 'cooldownMinutesPerSymbol', 'anti re-deschidere', '5')}
          {numberField('Limita pierdere sesiune', 'dailyLossLimitUSDT', 'blocheaza deschideri', '1')}
          {numberField('Actiuni / ciclu', 'maxActionsPerCycle', 'clamp 1-5', '1')}
          {numberField('Hard SL (% marja)', 'hardStopLossPct', 'guardrail, nu depinde de LLM', '0.5')}
          {numberField('Distanta min. lichidare %', 'hardMinLiqDistancePct', 'sub prag => stop', '0.5')}
          {numberField('Fara arbitraje (min)', 'hardMaxNoFillMinutes', 'bot blocat => stop', '10')}
          {numberField('Temperature', 'temperature', '0 = determinist', '0.05')}
          {numberField('Max tokens raspuns', 'maxTokens', 'buget de raspuns', '100')}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-2 pt-2 border-t border-zinc-800">
          {toggleRows.map(([key, label, tag]) => {
            const value = Boolean((cfg as any)?.[key]);
            return (
              <button
                key={String(key)}
                type="button"
                onClick={() => void saveConfig({ [key]: !value }, label)}
                disabled={busy !== null}
                className={`flex items-center justify-between gap-2 px-2 py-1.5 rounded border text-[11px] cursor-pointer transition-colors ${
                  value
                    ? 'bg-emerald-950/25 border-emerald-500/40 text-emerald-200'
                    : 'bg-zinc-900 border-zinc-700 text-zinc-400'
                } disabled:opacity-50`}
              >
                <span className="flex items-center gap-1.5">
                  {value ? (
                    <CheckCircle2 className="w-3.5 h-3.5" />
                  ) : (
                    <XCircle className="w-3.5 h-3.5" />
                  )}
                  {label}
                </span>
                <span className="text-[9px] font-mono opacity-70">{tag}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* ================= DECISION FEED ================= */}
      <div className="bg-zinc-950 border border-zinc-800 rounded p-3 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-[11px] font-bold text-cyan-300 flex items-center gap-1.5 uppercase tracking-wide">
            <Sparkles className="w-3.5 h-3.5" /> Jurnal decizii (ultimele {decisions.length})
          </h3>
          {cfg?.lastDecisionSummary && (
            <span
              className="text-[10px] text-zinc-500 truncate max-w-[50%]"
              title={cfg.lastDecisionSummary}
            >
              {cfg.lastDecisionSummary}
            </span>
          )}
        </div>

        {decisions.length === 0 && (
          <div className="text-[11px] text-zinc-500 py-3 text-center border border-dashed border-zinc-800 rounded">
            Nicio decizie inregistrata. Ruleaza un ciclu manual: in OFF sau ADVISOR este dry-run.
          </div>
        )}

        <div className="space-y-1.5">
          {decisions.map((d) => (
            <div key={d.id} className="bg-black/50 border border-zinc-800 rounded p-2 space-y-1">
              <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
                <span className="font-mono text-zinc-400">{clockTime(d.createdAt)}</span>
                <span
                  className={`px-1.5 py-0.5 rounded border font-bold ${
                    d.dryRun
                      ? 'text-cyan-300 border-cyan-500/40 bg-cyan-950/20'
                      : 'text-emerald-300 border-emerald-500/40 bg-emerald-950/20'
                  }`}
                >
                  {d.dryRun ? 'DRY-RUN' : 'EXECUTAT'}
                </span>
                <span className="px-1.5 py-0.5 rounded border border-zinc-700 text-zinc-400">
                  {d.mode}
                </span>
                <span className="px-1.5 py-0.5 rounded border border-zinc-700 text-violet-300">
                  {d.engine}
                </span>
                <span className="text-zinc-500">{d.trigger}</span>
                <span className="text-zinc-500">{d.latencyMs}ms</span>
                {d.promptTokens ? (
                  <span className="text-zinc-600">
                    tok {d.promptTokens}/{d.completionTokens ?? 0}
                  </span>
                ) : null}
                <span className="text-zinc-500">
                  incredere {Math.round((d.confidence || 0) * 100)}%
                </span>
                <span className="text-zinc-500">{d.marketRegime}</span>
              </div>

              <div className="text-[11px] text-zinc-200 leading-snug">
                {d.summaryRo || <span className="text-zinc-500">fara sumar</span>}
              </div>

              {d.error && <div className="text-[10px] text-rose-300">Eroare: {d.error}</div>}

              {(d.guardrailActions.length > 0 || d.approvedActions.length > 0) && (
                <div className="flex flex-wrap gap-1">
                  {d.guardrailActions.map((a, i) => (
                    <span
                      key={`g${i}`}
                      className={`text-[9px] font-mono px-1.5 py-0.5 rounded border ${
                        ACTION_TONE[a.type] || ACTION_TONE.HOLD
                      }`}
                      title={a.rationale_ro}
                    >
                      GUARDRAIL: {actionLabel(a)}
                    </span>
                  ))}
                  {d.approvedActions
                    .filter((a) => a.type !== 'HOLD')
                    .map((a, i) => (
                      <span
                        key={`a${i}`}
                        className={`text-[9px] font-mono px-1.5 py-0.5 rounded border ${
                          ACTION_TONE[a.type] || ACTION_TONE.HOLD
                        }`}
                        title={a.rationale_ro}
                      >
                        {actionLabel(a)}
                      </span>
                    ))}
                </div>
              )}

              {d.rejectedActions.length > 0 && (
                <div className="space-y-0.5">
                  {d.rejectedActions.slice(0, 4).map((r, i) => (
                    <div
                      key={`r${i}`}
                      className="text-[10px] text-amber-300/90 flex items-start gap-1"
                    >
                      <XCircle className="w-3 h-3 mt-0.5 shrink-0" />
                      <span>
                        <b>
                          {r.action?.type === 'OPEN_GRID'
                            ? r.action?.instId
                            : r.action?.algoId || 'actiune'}
                        </b>{' '}
                        respins: {r.reason}
                      </span>
                    </div>
                  ))}
                  {d.rejectedActions.length > 4 && (
                    <div className="text-[10px] text-zinc-500">
                      +{d.rejectedActions.length - 4} alte respingeri
                    </div>
                  )}
                </div>
              )}

              {d.results.length > 0 && (
                <div className="space-y-0.5 pt-0.5 border-t border-zinc-800/70">
                  {d.results.map((r, i) => (
                    <div
                      key={`res${i}`}
                      className={`text-[10px] flex items-start gap-1 ${
                        r.success ? 'text-emerald-300' : 'text-rose-300'
                      }`}
                    >
                      {r.success ? (
                        <CheckCircle2 className="w-3 h-3 mt-0.5 shrink-0" />
                      ) : (
                        <XCircle className="w-3 h-3 mt-0.5 shrink-0" />
                      )}
                      <span>
                        <b>{r.source}</b> {r.action?.type}: {r.message}
                        {r.algoId ? ` (algo ${r.algoId})` : ''}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* ================= INVARIANTS ================= */}
      <div className="bg-black/60 border border-zinc-800 rounded p-2.5 text-[10px] text-zinc-500 leading-relaxed">
        <b className="text-zinc-400">INVARIANTI (nu pot fi schimbati din UI):</b> agentul nu schimba
        niciodata modul de executie (PAPER / TESTNET / LIVE), nu atinge kill switch-ul, credentialele OKX,
        levierul global sau Autopilot-ul nativ, nu deschide grid nativ decat daca contul este deja LIVE si
        Autopilot-ul oprit, si refuza orice propunere care nu trece de{' '}
        <code className="text-zinc-300">validateActions()</code>. Fiecare ciclu este jurnalizat cu decizia,
        respingerile si rezultatul.
      </div>
    </div>
  );
};

export default DeepSeekAgentPanel;
