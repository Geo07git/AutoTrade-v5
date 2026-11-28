import React, { useState, useEffect, useCallback } from 'react';
import {
  BtcSignalsFullStatus,
  BtcSignalsStatusSummary,
  BtcTelegramPreferences,
  BtcMonitoredBot,
  BtcSignalHistoryEntry,
  BtcIndicatorContribution,
  XPerpAssetKey,
} from '../shared/types';
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Bell,
  CheckCircle2,
  Clock,
  Copy,
  Eye,
  History,
  Play,
  RefreshCw,
  Send,
  ShieldCheck,
  Sliders,
  Square,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';

interface BtcXPerpSignalsPanelProps {
  controlToken: string;
  onNotify: (banner: { type: 'success' | 'error' | 'info'; text: string }) => void;
  onRefreshParent?: () => void;
  btcSummary?: BtcSignalsStatusSummary | null;
  zecSummary?: BtcSignalsStatusSummary | null;
}

const formatUsd = (val?: number | null, decimals = 1): string => {
  if (val === undefined || val === null || !Number.isFinite(val)) return '—';
  return `$${val.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
};

const formatCompactUsd = (val?: number | null): string => {
  if (val === undefined || val === null || !Number.isFinite(val) || val <= 0) return '—';
  if (val >= 1_000_000_000) return `$${(val / 1_000_000_000).toFixed(2)}B`;
  if (val >= 1_000_000) return `$${(val / 1_000_000).toFixed(1)}M`;
  if (val >= 1_000) return `$${(val / 1_000).toFixed(1)}K`;
  return `$${val.toFixed(0)}`;
};

const formatRoTime = (ts?: number): string => {
  if (!ts || !Number.isFinite(ts)) return '—';
  return new Date(ts).toLocaleString('ro-RO', {
    timeZone: 'Europe/Bucharest',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
};

const directionTextClass = (dir?: string | null): string => {
  const d = String(dir || '').toUpperCase();
  if (d === 'LONG') return 'text-emerald-400';
  if (d === 'SHORT') return 'text-rose-400';
  return 'text-cyan-300';
};

export const BtcXPerpSignalsPanel: React.FC<BtcXPerpSignalsPanelProps> = ({
  controlToken,
  onNotify,
  onRefreshParent,
  btcSummary,
  zecSummary,
}) => {
  const [selectedAsset, setSelectedAsset] = useState<XPerpAssetKey>('BTC');
  const [statusByAsset, setStatusByAsset] = useState<Partial<Record<XPerpAssetKey, BtcSignalsFullStatus>>>({});
  const [summaries, setSummaries] = useState<Partial<Record<XPerpAssetKey, BtcSignalsStatusSummary>>>({});
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isAnalyzingNow, setIsAnalyzingNow] = useState<boolean>(false);
  const [isSyncingBots, setIsSyncingBots] = useState<boolean>(false);
  const [isSavingConfig, setIsSavingConfig] = useState<boolean>(false);
  const [isSendingTelegram, setIsSendingTelegram] = useState<boolean>(false);
  const [historyTab, setHistoryTab] = useState<'SIGNALS' | 'BOTS'>('SIGNALS');
  const [copiedParams, setCopiedParams] = useState<boolean>(false);
  const [manualAlgoIdInput, setManualAlgoIdInput] = useState<string>('');

  const status = statusByAsset[selectedAsset] || null;
  const priceDecimals = selectedAsset === 'ZEC' ? 2 : 1;
  const gridBoundDecimals = selectedAsset === 'ZEC' ? 1 : 0;
  const stepDecimals = selectedAsset === 'ZEC' ? 2 : 0;
  const atrDecimals = selectedAsset === 'ZEC' ? 2 : 0;
  const displayInstrument =
    status?.displayInstrument ||
    (selectedAsset === 'ZEC' ? 'ZEC-USD UM X-PERP' : 'BTC-USD UM X-PERP');

  const fetchStatus = useCallback(
    async (syncBots = false, targetAsset: XPerpAssetKey = selectedAsset) => {
      if (syncBots) setIsSyncingBots(true);
      try {
        const params = new URLSearchParams({ asset: targetAsset });
        if (syncBots) params.set('sync', '1');
        const res = await fetch(`/api/bot/btc-signals/status?${params.toString()}`);
        const data = await res.json();
        if (data?.success && data.status) {
          const resolvedAsset: XPerpAssetKey = data.asset === 'ZEC' ? 'ZEC' : targetAsset;
          setStatusByAsset((prev) => ({ ...prev, [resolvedAsset]: data.status }));
        }
        if (data?.summaries) {
          setSummaries((prev) => ({ ...prev, ...data.summaries }));
        }
      } catch {
        // keep previous state silently on background poll
      } finally {
        setIsLoading(false);
        setIsSyncingBots(false);
      }
    },
    [selectedAsset]
  );

  useEffect(() => {
    void fetchStatus(true, selectedAsset);
    const interval = setInterval(() => {
      void fetchStatus(false, selectedAsset);
    }, 10_000);
    return () => clearInterval(interval);
  }, [fetchStatus, selectedAsset]);

  const handleSelectAsset = (asset: XPerpAssetKey) => {
    if (asset === selectedAsset) return;
    setSelectedAsset(asset);
    setManualAlgoIdInput('');
    setCopiedParams(false);
    if (!statusByAsset[asset]) {
      setIsLoading(true);
    }
  };

  const handleAnalyzeNow = async () => {
    const targetAsset = selectedAsset;
    const label = targetAsset === 'ZEC' ? 'ZEC-USD UM X-PERP' : 'BTC-USD UM X-PERP';
    setIsAnalyzingNow(true);
    try {
      const res = await fetch('/api/bot/btc-signals/analyze', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-bot-token': controlToken,
        },
        body: JSON.stringify({ asset: targetAsset }),
      });
      const data = await res.json();
      if (data?.summaries) {
        setSummaries((prev) => ({ ...prev, ...data.summaries }));
      }
      if (data?.success && data.status) {
        setStatusByAsset((prev) => ({ ...prev, [targetAsset]: data.status }));
        const rec = data.status.activeRecommendation;
        onNotify({
          type: 'success',
          text: rec
            ? `Analiză ${label} finalizată: ${rec.direction} ($${rec.minPx} – $${rec.maxPx}).`
            : `Analiză ${label} actualizată.`,
        });
        onRefreshParent?.();
      } else {
        onNotify({
          type: 'error',
          text: data?.error || `Eroare la rularea analizei ${label}.`,
        });
      }
    } catch (err: any) {
      onNotify({
        type: 'error',
        text: err?.message || `Eroare de rețea la rularea analizei ${targetAsset}.`,
      });
    } finally {
      setIsAnalyzingNow(false);
    }
  };

  const handleUpdateConfig = async (patch: {
    enabled?: boolean;
    analysisIntervalSec?: number;
    trackedAlgoIds?: string[];
    telegramPreferences?: Partial<BtcTelegramPreferences>;
  }) => {
    const targetAsset = selectedAsset;
    setIsSavingConfig(true);
    try {
      const res = await fetch('/api/bot/btc-signals/config', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-bot-token': controlToken,
        },
        body: JSON.stringify({ ...patch, asset: targetAsset }),
      });
      const data = await res.json();
      if (data?.summaries) {
        setSummaries((prev) => ({ ...prev, ...data.summaries }));
      }
      if (data?.success && data.status) {
        setStatusByAsset((prev) => ({ ...prev, [targetAsset]: data.status }));
        onNotify({ type: 'success', text: `Preferințele ${targetAsset} X-PERP Signals au fost salvate.` });
        onRefreshParent?.();
      } else {
        onNotify({ type: 'error', text: data?.error || 'Eroare la salvarea configurației.' });
      }
    } catch (err: any) {
      onNotify({ type: 'error', text: err?.message || 'Eroare de rețea la salvare.' });
    } finally {
      setIsSavingConfig(false);
    }
  };

  const handleTrackManualAlgoId = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = manualAlgoIdInput.trim();
    if (!/^\d{4,32}$/.test(clean)) {
      onNotify({ type: 'error', text: 'Introdu un Bot ID numeric valid din OKX (ex: 4137268713223610368).' });
      return;
    }
    const existing = status?.config?.trackedAlgoIds || [];
    const nextIds = existing.includes(clean) ? existing : [...existing, clean].slice(-10);
    await handleUpdateConfig({ trackedAlgoIds: nextIds });
    setManualAlgoIdInput('');
    await fetchStatus(true, selectedAsset);
  };

  const handleRemoveTrackedAlgoId = async (algoId: string) => {
    const existing = status?.config?.trackedAlgoIds || [];
    await handleUpdateConfig({ trackedAlgoIds: existing.filter((id) => id !== algoId) });
    await fetchStatus(true, selectedAsset);
  };

  const handleSendTelegramNow = async () => {
    const targetAsset = selectedAsset;
    const label = targetAsset === 'ZEC' ? 'ZEC-USD UM X-PERP' : 'BTC-USD UM X-PERP';
    setIsSendingTelegram(true);
    try {
      const res = await fetch('/api/bot/btc-signals/test-telegram', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-bot-token': controlToken,
        },
        body: JSON.stringify({ asset: targetAsset }),
      });
      const data = await res.json();
      if (data?.summaries) {
        setSummaries((prev) => ({ ...prev, ...data.summaries }));
      }
      if (data?.status) {
        setStatusByAsset((prev) => ({ ...prev, [targetAsset]: data.status }));
      }
      if (data?.success) {
        onNotify({ type: 'success', text: `Recomandarea curentă ${label} a fost trimisă pe Telegram.` });
      } else {
        onNotify({ type: 'error', text: data?.error || 'Nu s-a putut trimite mesajul pe Telegram.' });
      }
    } catch (err: any) {
      onNotify({ type: 'error', text: err?.message || 'Eroare de rețea la trimiterea Telegram.' });
    } finally {
      setIsSendingTelegram(false);
    }
  };

  const handleCopyManualParams = () => {
    const rec = status?.activeRecommendation;
    if (!rec) return;
    const text = [
      `Instrument: ${displayInstrument} (${rec.instId})`,
      `Tip bot: OKX Native Futures Grid (Manual)`,
      `Direcție: ${rec.direction}`,
      `Preț minim: ${rec.minPx}`,
      `Preț maxim: ${rec.maxPx}`,
      `Număr grile: ${rec.gridNum} (pas ${formatUsd(rec.gridStepUSD, stepDecimals)})`,
      `Take Profit: ${rec.tpMarginPct}% din invested margin`,
      `Stop Loss: ${rec.slMarginPct}% din invested margin`,
    ].join('\n');
    try {
      navigator.clipboard.writeText(text);
      setCopiedParams(true);
      setTimeout(() => setCopiedParams(false), 2500);
      onNotify({ type: 'info', text: 'Parametrii manuali OKX au fost copiați în clipboard.' });
    } catch {}
  };

  const rec = status?.activeRecommendation || null;
  const ind = rec?.indicators || null;
  const cal = rec?.calibration || null;
  const cfg = status?.config;
  const activeBots = status?.activeBots || [];
  const closedBots = status?.recentClosedBots || [];
  const signalHistory = status?.signalHistory || [];
  const currentPrice = status?.currentPrice || rec?.currentPrice || 0;

  const effectiveSummary = (asset: XPerpAssetKey): BtcSignalsStatusSummary | null =>
    summaries[asset] || (asset === 'BTC' ? btcSummary : zecSummary) || null;

  return (
    <div className="space-y-4 p-1">
      {/* =================================================================== */}
      {/* 1. SELECTOR 2 POZIȚII (BTC | ZEC) + HEADER & CONTROALE MANUALE      */}
      {/* =================================================================== */}
      <section className="bg-zinc-950 border border-zinc-800 rounded p-4 space-y-3">
        {/* 2-position segmented switcher */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 pb-3">
          <div
            role="group"
            aria-label="Selector contract X-PERP"
            className="inline-flex bg-black border border-zinc-800 rounded p-1 gap-1"
          >
            {(['BTC', 'ZEC'] as XPerpAssetKey[]).map((assetKey) => {
              const isActive = selectedAsset === assetKey;
              const sum = effectiveSummary(assetKey);
              const decimals = assetKey === 'ZEC' ? 2 : 1;
              const dir = sum?.recommendedDirection;
              const botsCount = sum?.activeBotsCount || 0;
              return (
                <button
                  key={assetKey}
                  type="button"
                  onClick={() => handleSelectAsset(assetKey)}
                  className={`px-3.5 py-2 rounded text-xs font-bold flex items-center gap-2 cursor-pointer transition-colors whitespace-nowrap ${
                    isActive
                      ? 'bg-amber-400 text-black'
                      : 'text-zinc-300 hover:text-white hover:bg-zinc-900'
                  }`}
                >
                  <span>{assetKey}-USD UM X-PERP</span>
                  {sum && sum.currentPrice > 0 && (
                    <span className={`font-mono tabular-nums ${isActive ? 'text-black/80' : 'text-zinc-400'}`}>
                      {formatUsd(sum.currentPrice, decimals)}
                    </span>
                  )}
                  {dir && (
                    <span
                      className={`font-black ${
                        isActive
                          ? 'text-black'
                          : dir === 'LONG'
                          ? 'text-emerald-400'
                          : 'text-rose-400'
                      }`}
                    >
                      {dir}
                    </span>
                  )}
                  {botsCount > 0 && (
                    <span
                      className={`font-mono ${
                        isActive ? 'text-black/90' : 'text-cyan-300'
                      }`}
                    >
                      · {botsCount} {botsCount === 1 ? 'bot' : 'boți'}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          <div className="text-[11px] text-zinc-400">
            Fiecare contract rulează separat analiza OKX (120s), monitorizarea boților (30s) și alertele Telegram.
          </div>
        </div>

        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-zinc-800 pb-3">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
              <span className="font-semibold text-cyan-300">{displayInstrument}</span>
              <span aria-hidden="true">·</span>
              <span>OKX Native Futures Grid (Deschidere exclusiv manuală)</span>
              <span aria-hidden="true">·</span>
              <span className="inline-flex items-center gap-1 text-emerald-400 font-semibold">
                <ShieldCheck className="w-3.5 h-3.5" />
                <span>Monitorizare 100% Read-Only</span>
              </span>
            </div>

            <h2 className="font-bold text-base text-white tracking-tight flex flex-wrap items-center gap-3">
              <span>{selectedAsset} X-PERP Signal &amp; Grid Monitor</span>
              <span className="font-mono text-lg font-black text-amber-300 tabular-nums">
                {currentPrice > 0 ? formatUsd(currentPrice, priceDecimals) : 'Se încarcă prețul...'}
              </span>
              {ind && (
                <span
                  className={`font-mono text-xs font-bold tabular-nums ${
                    ind.priceChange24hPct >= 0 ? 'text-emerald-400' : 'text-rose-400'
                  }`}
                >
                  24h: {ind.priceChange24hPct >= 0 ? '+' : ''}
                  {ind.priceChange24hPct.toFixed(2)}%
                </span>
              )}
            </h2>

            <div className="text-[11px] text-zinc-400 flex flex-wrap items-center gap-3 tabular-nums">
              <span>
                Contract activ:{' '}
                <strong className="text-zinc-200 font-mono">
                  {status?.instId || `${selectedAsset}-USD_UM_XPERP`}
                </strong>
              </span>
              <span aria-hidden="true">·</span>
              <span>Ultima analiză: <strong className="text-zinc-200">{formatRoTime(status?.lastAnalysisAt)}</strong></span>
              <span aria-hidden="true">·</span>
              <span>Sync boți (30s): <strong className="text-zinc-200">{formatRoTime(status?.lastBotSyncAt)}</strong></span>
            </div>
          </div>

          {/* Controale manuale */}
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              disabled={isSavingConfig}
              onClick={() => void handleUpdateConfig({ enabled: !(cfg?.enabled ?? true) })}
              className={`px-3 py-2 rounded text-xs font-bold flex items-center gap-1.5 cursor-pointer border whitespace-nowrap shrink-0 transition-colors ${
                cfg?.enabled ?? true
                  ? 'bg-emerald-500/20 hover:bg-emerald-500/30 border-emerald-500/50 text-emerald-300'
                  : 'bg-zinc-900 hover:bg-zinc-800 border-zinc-700 text-zinc-300'
              }`}
            >
              {cfg?.enabled ?? true ? <Play className="w-3.5 h-3.5" /> : <Square className="w-3.5 h-3.5" />}
              <span>{cfg?.enabled ?? true ? 'Analiză Continuă: ON' : 'Analiză Continuă: OFF'}</span>
            </button>

            <select
              aria-label={`Interval analiză piață ${selectedAsset}`}
              value={cfg?.analysisIntervalSec || 120}
              disabled={isSavingConfig}
              onChange={(e) => void handleUpdateConfig({ analysisIntervalSec: parseInt(e.target.value, 10) })}
              className="bg-zinc-900 border border-zinc-700 rounded px-2.5 py-2 text-xs font-bold text-white tabular-nums cursor-pointer"
            >
              <option value={60}>Interval: 60s</option>
              <option value={120}>Interval: 120s (Default)</option>
              <option value={180}>Interval: 180s</option>
              <option value={300}>Interval: 300s</option>
            </select>

            <button
              type="button"
              disabled={isAnalyzingNow}
              onClick={() => void handleAnalyzeNow()}
              className="px-3.5 py-2 rounded bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50 text-black font-bold text-xs flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0 transition-colors"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isAnalyzingNow ? 'animate-spin' : ''}`} />
              <span>{isAnalyzingNow ? 'Se analizează...' : 'Analiză imediată'}</span>
            </button>

            <button
              type="button"
              disabled={isSyncingBots}
              onClick={() => void fetchStatus(true, selectedAsset)}
              className="px-3 py-2 rounded bg-zinc-900 hover:bg-zinc-800 disabled:opacity-50 border border-zinc-700 text-zinc-200 font-bold text-xs flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0"
            >
              <Eye className="w-3.5 h-3.5 text-cyan-400" />
              <span>{isSyncingBots ? 'Sync...' : 'Sync OKX'}</span>
            </button>

            <button
              type="button"
              disabled={isSendingTelegram}
              onClick={() => void handleSendTelegramNow()}
              className="px-3 py-2 rounded bg-zinc-900 hover:bg-zinc-800 disabled:opacity-50 border border-zinc-700 text-amber-300 font-bold text-xs flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0"
            >
              <Send className="w-3.5 h-3.5" />
              <span>{isSendingTelegram ? 'Se trimite...' : 'Trimite Telegram'}</span>
            </button>
          </div>
        </div>

        {status?.lastAnalysisError && (
          <div className="bg-rose-950/40 border border-rose-500/40 rounded p-2.5 text-xs text-rose-300 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>Eroare analiză piață: {status.lastAnalysisError}</span>
          </div>
        )}
        {status?.lastBotSyncError && (
          <div className="bg-amber-950/40 border border-amber-500/40 rounded p-2.5 text-xs text-amber-300 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>Atenție sincronizare boți OKX: {status.lastBotSyncError}</span>
          </div>
        )}
      </section>

      {/* =================================================================== */}
      {/* 2. DIRECȚIE RECOMANDATĂ, PROBABILITATE & CONFIGURAȚIE BOT MANUAL    */}
      {/* =================================================================== */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* Stânga: Direcție, Probabilități calibrate, Riscuri și Argumente */}
        <section className="lg:col-span-7 bg-zinc-950 border border-zinc-800 rounded p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 pb-2.5">
            <div className="flex items-center gap-2">
              {rec?.direction === 'SHORT' ? (
                <TrendingDown className="w-4 h-4 text-rose-400" />
              ) : (
                <TrendingUp className="w-4 h-4 text-emerald-400" />
              )}
              <h3 className="font-bold text-sm text-white">Direcție Recomandată &amp; Probabilitate Calibrată</h3>
            </div>
            {rec && (
              <div className="text-[11px] font-mono tabular-nums text-zinc-400">
                Emis: <strong className="text-zinc-200">{formatRoTime(rec.issuedAt)}</strong> · Valabil:{' '}
                <strong className="text-amber-300">{formatRoTime(rec.validUntil)}</strong>
              </div>
            )}
          </div>

          {isLoading && !rec ? (
            <div className="p-8 text-center text-xs text-zinc-400">
              Se rulează prima analiză live {displayInstrument}...
            </div>
          ) : !rec ? (
            <div className="bg-black border border-zinc-800 rounded p-6 text-center text-xs text-zinc-400 space-y-2">
              <p className="text-amber-300 font-semibold">Nicio recomandare disponibilă încă.</p>
              <p>Apasă „Analiză imediată” pentru a interoga datele OKX și a genera semnalul.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {/* Direcție + Probabilitate Side-by-Side */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="bg-black border border-zinc-800 rounded p-3 flex flex-col justify-between">
                  <span className="text-[11px] text-zinc-400 font-semibold">Direcție Următorul Bot</span>
                  <div className="flex items-center gap-2 mt-1">
                    {rec.direction === 'LONG' ? (
                      <ArrowUpRight className="w-6 h-6 text-emerald-400 shrink-0" />
                    ) : (
                      <ArrowDownRight className="w-6 h-6 text-rose-400 shrink-0" />
                    )}
                    <span className={`text-2xl font-black tracking-tight ${directionTextClass(rec.direction)}`}>
                      {rec.direction}
                    </span>
                  </div>
                  <span className="text-[10px] text-zinc-500 mt-1">
                    {rec.preferredAlternationFrom
                      ? `Alternare analizată după ultimul bot ${rec.preferredAlternationFrom}`
                      : 'OKX Native Futures Grid'}
                  </span>
                </div>

                <div className="sm:col-span-2 bg-black border border-zinc-800 rounded p-3 space-y-2">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-zinc-400 font-semibold">
                      Probabilitate estimată (calibrare istorică reală)
                    </span>
                    <span
                      className={`font-bold ${
                        rec.probabilityStatus === 'CALIBRATED' ? 'text-emerald-400' : 'text-amber-300'
                      }`}
                    >
                      {rec.probabilityStatus === 'CALIBRATED'
                        ? `Calibrată (${cal?.totalEvaluatedBars || 0} bare 1H)`
                        : 'Date insuficiente pentru probabilitate validată'}
                    </span>
                  </div>

                  {rec.probabilityStatus === 'CALIBRATED' ? (
                    <div className="grid grid-cols-2 gap-3 tabular-nums">
                      <div>
                        <div className="flex items-center justify-between text-xs mb-1">
                          <span className="font-bold text-emerald-400">LONG</span>
                          <span className="font-mono font-black text-white">
                            {rec.longProbabilityPct?.toFixed(1)}%
                          </span>
                        </div>
                        <div className="w-full h-2 bg-zinc-900 rounded overflow-hidden">
                          <div
                            className="h-full bg-emerald-500"
                            style={{ width: `${Math.max(0, Math.min(100, rec.longProbabilityPct || 0))}%` }}
                          />
                        </div>
                        <div className="text-[10px] text-zinc-500 mt-1">
                          Istoric: {cal?.longWinCount}/{cal?.longSampleCount} reușite (
                          {cal?.longEmpiricalWinRatePct?.toFixed(1) ?? '—'}%)
                        </div>
                      </div>

                      <div>
                        <div className="flex items-center justify-between text-xs mb-1">
                          <span className="font-bold text-rose-400">SHORT</span>
                          <span className="font-mono font-black text-white">
                            {rec.shortProbabilityPct?.toFixed(1)}%
                          </span>
                        </div>
                        <div className="w-full h-2 bg-zinc-900 rounded overflow-hidden">
                          <div
                            className="h-full bg-rose-500"
                            style={{ width: `${Math.max(0, Math.min(100, rec.shortProbabilityPct || 0))}%` }}
                          />
                        </div>
                        <div className="text-[10px] text-zinc-500 mt-1">
                          Istoric: {cal?.shortWinCount}/{cal?.shortSampleCount} reușite (
                          {cal?.shortEmpiricalWinRatePct?.toFixed(1) ?? '—'}%)
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="text-xs text-amber-300 bg-amber-950/30 border border-amber-500/30 rounded p-2">
                      Date insuficiente pentru probabilitate validată ({cal?.note || 'eșantion istoric insuficient'}).
                    </div>
                  )}
                </div>
              </div>

              {/* Risk warnings / Invalidated alerts */}
              {rec.riskStatus !== 'VALID' && (
                <div
                  className={`rounded border p-2.5 text-xs space-y-1 ${
                    rec.riskStatus === 'INVALIDATED'
                      ? 'bg-rose-950/40 border-rose-500/40 text-rose-200'
                      : 'bg-amber-950/40 border-amber-500/40 text-amber-200'
                  }`}
                >
                  <div className="font-bold flex items-center gap-1.5">
                    <AlertTriangle className="w-4 h-4 shrink-0" />
                    <span>
                      {rec.riskStatus === 'INVALIDATED'
                        ? 'Semnal Invalidat — necesită reanaliză înainte de deschidere'
                        : rec.riskStatus === 'INSUFFICIENT_DATA'
                        ? 'Atenție: Date insuficiente pentru probabilitate validată'
                        : 'Risc Ridicat / Fără avantaj statistic clar'}
                    </span>
                  </div>
                  <ul className="list-disc list-inside text-[11px] space-y-0.5">
                    {rec.invalidatedReason && <li>{rec.invalidatedReason}</li>}
                    {rec.riskReasons.map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Argumente principale */}
              <div className="bg-black border border-zinc-800 rounded p-3 space-y-1.5">
                <div className="text-[11px] font-bold text-zinc-300">Argumentele Principale ale Analizei</div>
                <ul className="space-y-1 text-xs text-zinc-300">
                  {rec.arguments.map((arg, idx) => (
                    <li key={idx} className="flex items-start gap-2">
                      <CheckCircle2 className="w-3.5 h-3.5 text-cyan-400 shrink-0 mt-0.5" />
                      <span>{arg}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </section>

        {/* Dreapta: Configurația exactă a următorului bot manual OKX */}
        <section className="lg:col-span-5 bg-zinc-950 border border-zinc-800 rounded p-4 space-y-3">
          <div className="flex items-center justify-between gap-2 border-b border-zinc-800 pb-2.5">
            <div className="flex items-center gap-2">
              <Sliders className="w-4 h-4 text-amber-400" />
              <h3 className="font-bold text-sm text-white">Configurația Următorului Bot (OKX Manual)</h3>
            </div>
            <button
              type="button"
              disabled={!rec}
              onClick={handleCopyManualParams}
              className="px-2.5 py-1 rounded bg-amber-500 hover:bg-amber-400 disabled:opacity-40 text-black font-bold text-[11px] flex items-center gap-1 cursor-pointer whitespace-nowrap shrink-0"
            >
              <Copy className="w-3 h-3" />
              <span>{copiedParams ? 'Copiat!' : 'Copiază parametri'}</span>
            </button>
          </div>

          <div className="grid grid-cols-2 gap-2.5 text-xs tabular-nums">
            <div className="bg-black border border-zinc-800 rounded p-2.5">
              <div className="text-[10px] text-zinc-400">Instrument &amp; Tip</div>
              <div className="font-bold text-white mt-0.5">{displayInstrument}</div>
              <div className="text-[10px] text-cyan-300">OKX Native Futures Grid</div>
            </div>

            <div className="bg-black border border-zinc-800 rounded p-2.5">
              <div className="text-[10px] text-zinc-400">Direcție Aleasă</div>
              <div className={`font-black text-base mt-0.5 ${directionTextClass(rec?.direction)}`}>
                {rec?.direction || '—'}
              </div>
              <div className="text-[10px] text-zinc-500">Creare manuală în OKX</div>
            </div>

            <div className="bg-black border border-zinc-800 rounded p-2.5">
              <div className="text-[10px] text-zinc-400">Preț Minim Recomandat</div>
              <div className="font-mono font-black text-sm text-emerald-300 mt-0.5">
                {rec ? formatUsd(rec.minPx, gridBoundDecimals) : '—'}
              </div>
              <div className="text-[10px] text-zinc-500">
                {rec && currentPrice > 0
                  ? `${(((rec.minPx - currentPrice) / currentPrice) * 100).toFixed(2)}% față de preț`
                  : 'Suport dinamic ATR'}
              </div>
            </div>

            <div className="bg-black border border-zinc-800 rounded p-2.5">
              <div className="text-[10px] text-zinc-400">Preț Maxim Recomandat</div>
              <div className="font-mono font-black text-sm text-rose-300 mt-0.5">
                {rec ? formatUsd(rec.maxPx, gridBoundDecimals) : '—'}
              </div>
              <div className="text-[10px] text-zinc-500">
                {rec && currentPrice > 0
                  ? `+${(((rec.maxPx - currentPrice) / currentPrice) * 100).toFixed(2)}% față de preț`
                  : selectedAsset === 'BTC'
                  ? 'Diferență exactă $1,000'
                  : 'Bandă dinamică ATR'}
              </div>
            </div>

            <div className="bg-black border border-zinc-800 rounded p-2.5">
              <div className="text-[10px] text-zinc-400">Grile &amp; Interval</div>
              <div className="font-mono font-bold text-white mt-0.5">
                10 grile · Pas{' '}
                {rec
                  ? formatUsd(rec.gridStepUSD, stepDecimals)
                  : selectedAsset === 'BTC'
                  ? '$100'
                  : 'dinamic'}
              </div>
              <div className="text-[10px] text-zinc-400">
                {selectedAsset === 'BTC'
                  ? 'Lățime fixă: $1,000'
                  : `Lățime ATR: ${rec ? formatUsd(rec.rangeSpanUSD, gridBoundDecimals) : 'dinamică'}`}
              </div>
            </div>

            <div className="bg-black border border-zinc-800 rounded p-2.5">
              <div className="text-[10px] text-zinc-400">Praguri Margin OKX (PnL)</div>
              <div className="font-mono font-bold text-white mt-0.5">
                <span className="text-emerald-400">TP 5%</span> / <span className="text-rose-400">SL 2.5%</span>
              </div>
              <div className="text-[10px] text-zinc-400">Din Invested Margin (`tpRatio`/`slRatio`)</div>
            </div>
          </div>

          <div className="text-[11px] text-zinc-400 bg-black border border-zinc-800 rounded p-2.5 leading-relaxed">
            În OKX Native Futures Grid, <strong className="text-zinc-200">TP 5%</strong> și{' '}
            <strong className="text-zinc-200">SL 2.5%</strong> se setează pe profit/pierdere față de{' '}
            <strong className="text-zinc-200">invested margin</strong> (<code className="text-cyan-300">tpRatio=0.05</code>,{' '}
            <code className="text-cyan-300">slRatio=0.025</code>), indiferent de levier.
          </div>
        </section>
      </div>

      {/* =================================================================== */}
      {/* 3. MONITORIZARE BOȚI ACTIVI OKX (LONG / SHORT / NEUTRAL - READ ONLY)*/}
      {/* =================================================================== */}
      <section className="bg-zinc-950 border border-zinc-800 rounded p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 pb-2.5">
          <div>
            <h3 className="font-bold text-sm text-white flex items-center gap-2">
              <Activity className="w-4 h-4 text-cyan-400" />
              <span>Boți Activi OKX {displayInstrument} (LONG / SHORT / NEUTRAL — Read-Only)</span>
            </h3>
            <p className="text-[11px] text-zinc-400 mt-0.5">
              Detectează automat orice bot {displayInstrument} creat manual în OKX (LONG, SHORT sau NEUTRAL) la fiecare 30s. Nicio comandă de modificare sau oprire nu este disponibilă aici.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <form onSubmit={(e) => void handleTrackManualAlgoId(e)} className="flex items-center gap-1.5">
              <input
                type="text"
                value={manualAlgoIdInput}
                onChange={(e) => setManualAlgoIdInput(e.target.value)}
                placeholder="Pin Bot ID OKX (read-only)"
                aria-label="Pin Bot ID OKX read-only"
                className="bg-black border border-zinc-700 rounded px-2 py-1 text-[11px] font-mono text-white w-44 focus:outline-none focus:border-cyan-400"
              />
              <button
                type="submit"
                disabled={isSavingConfig || isSyncingBots}
                className="px-2.5 py-1 rounded bg-zinc-900 hover:bg-zinc-800 border border-cyan-500/40 text-cyan-300 text-[11px] font-bold cursor-pointer whitespace-nowrap"
              >
                + Urmărește ID
              </button>
            </form>
            <span className="text-xs font-mono font-bold text-cyan-300 tabular-nums">
              {activeBots.length} {activeBots.length === 1 ? 'bot activ' : 'boți activi'}
            </span>
          </div>
        </div>

        {(cfg?.trackedAlgoIds?.length || 0) > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-zinc-400">
            <span>Bot ID-uri urmărite direct:</span>
            {(cfg?.trackedAlgoIds || []).map((tid) => (
              <span
                key={tid}
                className="inline-flex items-center gap-1.5 bg-black border border-zinc-700 rounded px-2 py-0.5 font-mono text-zinc-200"
              >
                <span>#{tid}</span>
                <button
                  type="button"
                  onClick={() => void handleRemoveTrackedAlgoId(tid)}
                  className="text-zinc-400 hover:text-rose-400 font-bold cursor-pointer"
                  title="Elimină din urmărirea manuală"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}

        {activeBots.some((b) => b.limitStatus && b.limitStatus !== 'INSIDE') && (
          <div className="space-y-2">
            {activeBots
              .filter((b) => b.limitStatus && b.limitStatus !== 'INSIDE')
              .map((b) => {
                const isBreach = b.limitStatus === 'OUT_LOW' || b.limitStatus === 'OUT_HIGH';
                const sr = b.suggestedNewRange;
                return (
                  <div
                    key={`limit-advisory-${b.algoId}`}
                    className={`rounded border p-3 text-xs space-y-2 ${
                      isBreach
                        ? 'bg-rose-950/40 border-rose-500/50 text-rose-100'
                        : 'bg-amber-950/40 border-amber-500/50 text-amber-100'
                    }`}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="flex items-start gap-2">
                        <AlertTriangle
                          className={`w-4 h-4 shrink-0 mt-0.5 ${
                            isBreach ? 'text-rose-400' : 'text-amber-400'
                          }`}
                        />
                        <div className="space-y-0.5">
                          <div className="font-bold">
                            {isBreach
                              ? `Bot #${b.algoId} (${b.direction.toUpperCase()}) a ajuns la limită / în afara benzii`
                              : `Bot #${b.algoId} (${b.direction.toUpperCase()}) se apropie de limită`}
                          </div>
                          {b.limitMessage && (
                            <p className="text-[11px] opacity-90">{b.limitMessage}</p>
                          )}
                        </div>
                      </div>

                      {sr && (
                        <button
                          type="button"
                          onClick={() => {
                            const text = [
                              `Instrument: ${displayInstrument} (${b.instId})`,
                              `Bot existent: #${b.algoId} (${b.direction.toUpperCase()})`,
                              `Recomandare schimbare limite (Manual în OKX):`,
                              `Direcție analizată: ${sr.direction}`,
                              `Preț minim nou: ${sr.minPx}`,
                              `Preț maxim nou: ${sr.maxPx}`,
                              `Număr grile: 10 (pas ${formatUsd(sr.gridStepUSD, stepDecimals)})`,
                              `Take Profit: 5% din invested margin`,
                              `Stop Loss: 2.5% din invested margin`,
                            ].join('\n');
                            try {
                              navigator.clipboard.writeText(text);
                              onNotify({
                                type: 'info',
                                text: `Limitele noi sugerate pentru #${b.algoId} au fost copiate în clipboard.`,
                              });
                            } catch {}
                          }}
                          className="px-2.5 py-1 rounded bg-amber-400 hover:bg-amber-300 text-black font-bold text-[11px] flex items-center gap-1 cursor-pointer whitespace-nowrap shrink-0"
                        >
                          <Copy className="w-3 h-3" />
                          <span>Copiază limite noi</span>
                        </button>
                      )}
                    </div>

                    {sr && (
                      <div className="bg-black/60 border border-zinc-800 rounded px-2.5 py-2 font-mono text-[11px] flex flex-wrap items-center gap-x-4 gap-y-1">
                        <span>
                          Recomandare limite noi OKX:{' '}
                          <strong className="text-emerald-300">
                            {formatUsd(sr.minPx, gridBoundDecimals)}
                          </strong>{' '}
                          –{' '}
                          <strong className="text-rose-300">
                            {formatUsd(sr.maxPx, gridBoundDecimals)}
                          </strong>
                        </span>
                        <span className="text-zinc-300">
                          10 grile · Pas {formatUsd(sr.gridStepUSD, stepDecimals)}
                        </span>
                        <span className={directionTextClass(sr.direction)}>
                          Direcție analizată: <strong>{sr.direction}</strong>
                        </span>
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
        )}

        {activeBots.length === 0 ? (
          <div className="bg-black border border-zinc-800 rounded p-5 text-center text-xs text-zinc-400 space-y-1">
            <p className="text-zinc-200 font-semibold">
              Niciun bot activ detectat momentan pe {displayInstrument}.
            </p>
            <p>
              Analiza de piață continuă automat la fiecare {cfg?.analysisIntervalSec || 120}s pentru a menține pregătită următoarea recomandare. Poți fixa un Bot ID OKX în câmpul „Pin Bot ID OKX” pentru verificare directă read-only.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs tabular-nums">
              <thead>
                <tr className="border-b border-zinc-800 text-zinc-400 text-[11px]">
                  <th className="py-2 px-2">Bot / Direcție / Status</th>
                  <th className="py-2 px-2 text-right">Preț / Lichidare</th>
                  <th className="py-2 px-2">Interval Grid &amp; Poziție</th>
                  <th className="py-2 px-2 text-right">Grile / Lev</th>
                  <th className="py-2 px-2 text-right">Invested Margin</th>
                  <th className="py-2 px-2 text-right">TP / SL (Margin)</th>
                  <th className="py-2 px-2 text-right">PnL Total / Grid / Unpaired</th>
                  <th className="py-2 px-2">Progres TP/SL</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-900">
                {activeBots.map((bot: BtcMonitoredBot) => (
                  <tr key={bot.algoId} className="hover:bg-zinc-900/50">
                    <td className="py-2.5 px-2 align-top">
                      <div className={`font-black uppercase ${directionTextClass(bot.direction)}`}>
                        {bot.direction} GRID · <span className="text-emerald-300">{bot.state}</span>
                      </div>
                      <div className="font-mono text-[10px] text-zinc-400">
                        {bot.instId} · #{bot.algoId}
                      </div>
                      <div className="text-[10px] text-zinc-500">
                        Creat: {formatRoTime(bot.cTime)}
                      </div>
                    </td>
                    <td className="py-2.5 px-2 text-right align-top font-mono">
                      <div className="font-bold text-white">{formatUsd(bot.currentPx, priceDecimals)}</div>
                      {bot.liqPx ? (
                        <div className="text-[10px] text-amber-300">
                          Liq: {formatUsd(bot.liqPx, priceDecimals)}
                        </div>
                      ) : null}
                    </td>
                    <td className="py-2.5 px-2 align-top min-w-[170px]">
                      <div className="font-mono text-zinc-200">
                        {formatUsd(bot.minPx, gridBoundDecimals)} – {formatUsd(bot.maxPx, gridBoundDecimals)}
                      </div>
                      <div className="w-full h-1.5 bg-zinc-900 rounded overflow-hidden mt-1">
                        <div
                          className="h-full bg-cyan-400"
                          style={{ width: `${bot.bandPositionPct ?? 0}%` }}
                        />
                      </div>
                      <div className="text-[10px] text-zinc-500 mt-0.5">
                        Poziție în bandă: {bot.bandPositionPct !== null ? `${bot.bandPositionPct}%` : '—'}
                      </div>
                    </td>
                    <td className="py-2.5 px-2 text-right align-top font-mono text-zinc-200">
                      <div>{bot.gridNum} grile</div>
                      <div className="text-[10px] text-zinc-400">{bot.lever}x</div>
                    </td>
                    <td className="py-2.5 px-2 text-right align-top font-mono font-bold text-amber-300">
                      {bot.investedMarginUSD.toFixed(2)} {bot.investmentCcy || 'USDC'}
                    </td>
                    <td className="py-2.5 px-2 text-right align-top font-mono text-[11px]">
                      <div className="text-emerald-400">
                        TP: {bot.tpMarginPct !== undefined ? `${bot.tpMarginPct}%` : '—'}{' '}
                        {bot.tpMarginUSD !== undefined ? `($${bot.tpMarginUSD.toFixed(2)})` : ''}
                      </div>
                      <div className="text-rose-400">
                        SL: {bot.slMarginPct !== undefined ? `${bot.slMarginPct}%` : '—'}{' '}
                        {bot.slMarginUSD !== undefined ? `(-$${bot.slMarginUSD.toFixed(2)})` : ''}
                      </div>
                    </td>
                    <td className="py-2.5 px-2 text-right align-top font-mono">
                      <div className={`font-black ${bot.totalPnlUSD >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                        {bot.totalPnlUSD >= 0 ? '+' : ''}{bot.totalPnlUSD.toFixed(4)} {bot.investmentCcy || 'USDC'} ({bot.totalPnlPct >= 0 ? '+' : ''}
                        {bot.totalPnlPct.toFixed(2)}%)
                      </div>
                      <div className="text-[10px] text-zinc-300">
                        Grid: {bot.gridProfitUSD >= 0 ? '+' : ''}{bot.gridProfitUSD.toFixed(4)} · Arb: {bot.arbitrageNum}
                      </div>
                      <div className="text-[10px] text-zinc-400">
                        Unpaired: {bot.floatProfitUSD >= 0 ? '+' : ''}{bot.floatProfitUSD.toFixed(4)}
                      </div>
                    </td>
                    <td className="py-2.5 px-2 align-top min-w-[140px]">
                      <div className="text-[10px] flex justify-between text-emerald-400">
                        <span>TP</span>
                        <span>{bot.tpProgressPct ?? 0}%</span>
                      </div>
                      <div className="w-full h-1.5 bg-zinc-900 rounded overflow-hidden mb-1">
                        <div
                          className="h-full bg-emerald-500"
                          style={{ width: `${Math.max(0, Math.min(100, bot.tpProgressPct || 0))}%` }}
                        />
                      </div>
                      <div className="text-[10px] flex justify-between text-rose-400">
                        <span>SL</span>
                        <span>{bot.slProgressPct ?? 0}%</span>
                      </div>
                      <div className="w-full h-1.5 bg-zinc-900 rounded overflow-hidden">
                        <div
                          className="h-full bg-rose-500"
                          style={{ width: `${Math.max(0, Math.min(100, bot.slProgressPct || 0))}%` }}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* =================================================================== */}
      {/* 4. INDICATORI PIEȚEI OKX & CONTRIBUȚII ANALIZĂ                       */}
      {/* =================================================================== */}
      <section className="bg-zinc-950 border border-zinc-800 rounded p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 pb-2.5">
          <h3 className="font-bold text-sm text-white">Indicatori Reali OKX (15m / 1H / 4H) &amp; Lichiditate</h3>
          {ind && (
            <span className="text-[11px] font-mono text-zinc-400 tabular-nums">
              Lumânări: 15m({ind.candles15mCount}) · 1H({ind.candles1hCount}) · 4H({ind.candles4hCount})
            </span>
          )}
        </div>

        {ind ? (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2.5 text-xs tabular-nums">
              <div className="bg-black border border-zinc-800 rounded p-2.5">
                <div className="text-[10px] text-zinc-400">Structură &amp; EMA</div>
                <div className="font-bold text-white mt-0.5">{ind.structure1h.replace('_', ' ')}</div>
                <div className="text-[10px] text-zinc-400 font-mono">
                  1H {formatUsd(ind.ema20_1h, priceDecimals)} / {formatUsd(ind.ema50_1h, priceDecimals)}
                </div>
              </div>

              <div className="bg-black border border-zinc-800 rounded p-2.5">
                <div className="text-[10px] text-zinc-400">Trend ADX (1H)</div>
                <div className="font-mono font-bold text-cyan-300 mt-0.5">
                  ADX {ind.adx1h?.toFixed(1) ?? '—'}
                </div>
                <div className="text-[10px] text-zinc-400 font-mono">
                  +DI {ind.plusDi1h ?? '—'} / -DI {ind.minusDi1h ?? '—'}
                </div>
              </div>

              <div className="bg-black border border-zinc-800 rounded p-2.5">
                <div className="text-[10px] text-zinc-400">RSI (14)</div>
                <div className="font-mono font-bold text-white mt-0.5">
                  1H: {ind.rsi1h?.toFixed(1) ?? '—'}
                </div>
                <div className="text-[10px] text-zinc-400 font-mono">
                  15m: {ind.rsi15m?.toFixed(1) ?? '—'}
                </div>
              </div>

              <div className="bg-black border border-zinc-800 rounded p-2.5">
                <div className="text-[10px] text-zinc-400">ATR &amp; Volatilitate</div>
                <div className="font-mono font-bold text-amber-300 mt-0.5">
                  1H: ${ind.atr1hUSD.toFixed(atrDecimals)} ({ind.atr1hPct.toFixed(2)}%)
                </div>
                <div className="text-[10px] text-zinc-400 font-mono">
                  15m: ${ind.atr15mUSD.toFixed(atrDecimals)}
                </div>
              </div>

              <div className="bg-black border border-zinc-800 rounded p-2.5">
                <div className="text-[10px] text-zinc-400">Volum &amp; Presiune</div>
                <div className="font-mono font-bold text-white mt-0.5">
                  {ind.volumeRatio1h.toFixed(2)}x medie
                </div>
                <div className="text-[10px] text-zinc-400 font-mono">
                  Buy {ind.volumeBuyPressurePct.toFixed(0)}% · {formatCompactUsd(ind.volume24hUSD)}
                </div>
              </div>

              <div className="bg-black border border-zinc-800 rounded p-2.5">
                <div className="text-[10px] text-zinc-400">Suport / Rezistență</div>
                <div className="font-mono font-bold text-emerald-300 mt-0.5">
                  S: {ind.nearestSupport ? formatUsd(ind.nearestSupport.price, priceDecimals) : '—'}
                </div>
                <div className="font-mono text-[10px] text-rose-300">
                  R: {ind.nearestResistance ? formatUsd(ind.nearestResistance.price, priceDecimals) : '—'}
                </div>
              </div>

              <div className="bg-black border border-zinc-800 rounded p-2.5">
                <div className="text-[10px] text-zinc-400">Funding Rate</div>
                <div className="font-mono font-bold text-white mt-0.5">
                  {ind.fundingRatePct >= 0 ? '+' : ''}
                  {ind.fundingRatePct.toFixed(4)}%
                </div>
                <div className="text-[10px] text-zinc-400 font-mono">
                  Next: {ind.nextFundingRatePct.toFixed(4)}%
                </div>
              </div>

              <div className="bg-black border border-zinc-800 rounded p-2.5">
                <div className="text-[10px] text-zinc-400">Lichiditate &amp; OI</div>
                <div className="font-mono font-bold text-cyan-300 mt-0.5">
                  OI: {formatCompactUsd(ind.openInterestUSD)}
                </div>
                <div className="text-[10px] text-zinc-400 font-mono">
                  OB {(ind.orderBookImbalance * 100).toFixed(0)}% · Spr {ind.spreadBps.toFixed(1)}bps
                </div>
              </div>
            </div>

            {rec?.contributions && rec.contributions.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs tabular-nums">
                  <thead>
                    <tr className="border-b border-zinc-800 text-zinc-400 text-[11px]">
                      <th className="py-2 px-2">Criteriu</th>
                      <th className="py-2 px-2 font-mono">Valoare Măsurată</th>
                      <th className="py-2 px-2">Favorizează</th>
                      <th className="py-2 px-2 text-right">Scor LONG / SHORT</th>
                      <th className="py-2 px-2">Justificare</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-900">
                    {rec.contributions.map((c: BtcIndicatorContribution) => (
                      <tr key={c.key} className="hover:bg-zinc-900/40">
                        <td className="py-1.5 px-2 font-semibold text-white whitespace-nowrap">{c.label}</td>
                        <td className="py-1.5 px-2 font-mono text-zinc-300 whitespace-nowrap">{c.valueText}</td>
                        <td className={`py-1.5 px-2 font-bold whitespace-nowrap ${directionTextClass(c.favoredDirection)}`}>
                          {c.favoredDirection}
                        </td>
                        <td className="py-1.5 px-2 text-right font-mono text-zinc-300 whitespace-nowrap">
                          <span className="text-emerald-400">+{c.longWeight.toFixed(2)}</span> /{' '}
                          <span className="text-rose-400">+{c.shortWeight.toFixed(2)}</span>
                        </td>
                        <td className="py-1.5 px-2 text-zinc-400">{c.detail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : (
          <div className="text-xs text-zinc-500 p-4 text-center">
            Indicatorii vor apărea după prima analiză OKX.
          </div>
        )}
      </section>

      {/* =================================================================== */}
      {/* 5. PREFERINȚE TELEGRAM + ISTORIC SEMNALE & BOȚI                     */}
      {/* =================================================================== */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* Preferințe Telegram */}
        <section className="lg:col-span-4 bg-zinc-950 border border-zinc-800 rounded p-4 space-y-3">
          <div className="flex items-center justify-between border-b border-zinc-800 pb-2">
            <h3 className="font-bold text-sm text-white flex items-center gap-2">
              <Bell className="w-4 h-4 text-amber-400" />
              <span>Preferințe Notificări Telegram</span>
            </h3>
            <span
              className={`text-[11px] font-bold ${
                status?.telegramConfigured ? 'text-emerald-400' : 'text-amber-300'
              }`}
            >
              {status?.telegramConfigured ? 'Conectat' : 'Neconfigurat (Tab 5)'}
            </span>
          </div>

          <div className="space-y-2 text-xs">
            {(
              [
                ['onLongOpportunity', 'Oportunitate LONG detectată'],
                ['onShortOpportunity', 'Oportunitate SHORT detectată'],
                ['onBotClosed', 'Închiderea confirmată a unui bot (TP/SL/Manual)'],
                ['onNextRecommendation', 'Recomandare imediată pentru următorul bot'],
                ['onSignalInvalidated', 'Invalidarea semnalului (ieșire din interval / expirare)'],
                ['onBotLimitReached', 'Alertă atingere / ieșire din limitele botului (+ recomandare limite noi)'],
              ] as Array<[keyof BtcTelegramPreferences, string]>
            ).map(([key, label]) => {
              const checked = cfg?.telegramPreferences?.[key] ?? true;
              return (
                <label
                  key={key}
                  className="flex items-center justify-between gap-2 bg-black border border-zinc-800 rounded px-3 py-2 cursor-pointer hover:border-zinc-700"
                >
                  <span className="text-zinc-200">{label}</span>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={isSavingConfig}
                    onChange={(e) =>
                      void handleUpdateConfig({
                        telegramPreferences: { [key]: e.target.checked },
                      })
                    }
                    className="accent-cyan-400 w-4 h-4 cursor-pointer"
                  />
                </label>
              );
            })}
          </div>
        </section>

        {/* Istoric Semnale și Boți */}
        <section className="lg:col-span-8 bg-zinc-950 border border-zinc-800 rounded p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 pb-2">
            <h3 className="font-bold text-sm text-white flex items-center gap-2">
              <History className="w-4 h-4 text-cyan-400" />
              <span>Istoric {displayInstrument}</span>
            </h3>
            <div className="flex items-center gap-1.5 text-xs">
              <button
                type="button"
                onClick={() => setHistoryTab('SIGNALS')}
                className={`px-3 py-1.5 rounded font-bold cursor-pointer border whitespace-nowrap ${
                  historyTab === 'SIGNALS'
                    ? 'bg-cyan-500 text-black border-cyan-400'
                    : 'bg-black text-zinc-300 border-zinc-700 hover:text-white'
                }`}
              >
                Semnale Emise ({signalHistory.length})
              </button>
              <button
                type="button"
                onClick={() => setHistoryTab('BOTS')}
                className={`px-3 py-1.5 rounded font-bold cursor-pointer border whitespace-nowrap ${
                  historyTab === 'BOTS'
                    ? 'bg-amber-500 text-black border-amber-400'
                    : 'bg-black text-zinc-300 border-zinc-700 hover:text-white'
                }`}
              >
                Boți Închiși OKX ({closedBots.length})
              </button>
            </div>
          </div>

          {historyTab === 'SIGNALS' ? (
            signalHistory.length === 0 ? (
              <div className="bg-black border border-zinc-800 rounded p-6 text-center text-xs text-zinc-400">
                Niciun semnal înregistrat încă.
              </div>
            ) : (
              <div className="overflow-x-auto max-h-80 overflow-y-auto">
                <table className="w-full text-left border-collapse text-xs tabular-nums">
                  <thead>
                    <tr className="border-b border-zinc-800 text-zinc-400 text-[11px] sticky top-0 bg-zinc-950">
                      <th className="py-2 px-2">Ora (București)</th>
                      <th className="py-2 px-2">Direcție</th>
                      <th className="py-2 px-2 text-right">Preț {selectedAsset}</th>
                      <th className="py-2 px-2">
                        {selectedAsset === 'BTC' ? 'Interval Grid ($1k)' : 'Interval Grid (ATR)'}
                      </th>
                      <th className="py-2 px-2 text-right">Probabilitate</th>
                      <th className="py-2 px-2">Trigger / Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-900">
                    {signalHistory.slice(0, 30).map((s: BtcSignalHistoryEntry) => (
                      <tr key={s.id} className="hover:bg-zinc-900/50">
                        <td className="py-2 px-2 font-mono text-[11px] text-zinc-300 whitespace-nowrap">
                          {formatRoTime(s.issuedAt)}
                        </td>
                        <td className={`py-2 px-2 font-black ${directionTextClass(s.direction)}`}>
                          {s.direction}
                        </td>
                        <td className="py-2 px-2 text-right font-mono text-zinc-200">
                          {formatUsd(s.priceAtSignal, priceDecimals)}
                        </td>
                        <td className="py-2 px-2 font-mono text-zinc-300 whitespace-nowrap">
                          {formatUsd(s.minPx, gridBoundDecimals)} – {formatUsd(s.maxPx, gridBoundDecimals)}
                        </td>
                        <td className="py-2 px-2 text-right font-mono">
                          {s.probabilityStatus === 'CALIBRATED' && s.chosenProbabilityPct !== null
                            ? `${s.chosenProbabilityPct.toFixed(1)}%`
                            : 'Insuficientă'}
                        </td>
                        <td className="py-2 px-2 text-[11px]">
                          <div className="text-zinc-300">
                            {s.trigger} · {s.invalidatedAt ? 'Invalidat' : s.riskStatus}
                            {s.telegramSent ? ' · TG ✓' : ''}
                          </div>
                          {s.invalidatedReason && (
                            <div className="text-[10px] text-rose-300">{s.invalidatedReason}</div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          ) : closedBots.length === 0 ? (
            <div className="bg-black border border-zinc-800 rounded p-6 text-center text-xs text-zinc-400">
              Niciun bot {displayInstrument} închis în istoric.
            </div>
          ) : (
            <div className="overflow-x-auto max-h-80 overflow-y-auto">
              <table className="w-full text-left border-collapse text-xs tabular-nums">
                <thead>
                  <tr className="border-b border-zinc-800 text-zinc-400 text-[11px] sticky top-0 bg-zinc-950">
                    <th className="py-2 px-2">Închis la</th>
                    <th className="py-2 px-2">Direcție</th>
                    <th className="py-2 px-2">Interval Grid</th>
                    <th className="py-2 px-2 text-right">Margin</th>
                    <th className="py-2 px-2 text-right">PnL Total</th>
                    <th className="py-2 px-2">Motiv Detectat</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-900">
                  {closedBots.map((b: BtcMonitoredBot) => (
                    <tr key={b.algoId} className="hover:bg-zinc-900/50">
                      <td className="py-2 px-2 font-mono text-[11px] text-zinc-300 whitespace-nowrap">
                        <span className="inline-flex items-center gap-1">
                          <Clock className="w-3 h-3 text-zinc-500" />
                          {formatRoTime(b.uTime)}
                        </span>
                      </td>
                      <td className={`py-2 px-2 font-black uppercase ${directionTextClass(b.direction)}`}>
                        {b.direction}
                      </td>
                      <td className="py-2 px-2 font-mono text-zinc-300 whitespace-nowrap">
                        {formatUsd(b.minPx, gridBoundDecimals)} – {formatUsd(b.maxPx, gridBoundDecimals)} ({b.gridNum}g)
                      </td>
                      <td className="py-2 px-2 text-right font-mono text-zinc-200">
                        ${b.investedMarginUSD.toFixed(2)}
                      </td>
                      <td className={`py-2 px-2 text-right font-mono font-bold ${b.totalPnlUSD >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                        {b.totalPnlUSD >= 0 ? '+' : ''}${b.totalPnlUSD.toFixed(2)} ({b.totalPnlPct >= 0 ? '+' : ''}
                        {b.totalPnlPct.toFixed(2)}%)
                      </td>
                      <td className="py-2 px-2 text-[11px] text-zinc-300">
                        {b.closeReasonLabel || b.state}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
};
