/**
 * HistoricalGridResearchPanel.tsx
 * High-performance research terminal for OKX Neutral Grid:
 * - 24x7 Hourly & Day Heatmap
 * - Quantitative Market Regime (Hurst, Chop, ADX, Autocorrelation, BTC Correlation)
 * - Volume Profile (POC, HVN, LVN, Value Area) & S/R Clusters
 * - Pattern Miner Event Study Table (FDR q-values, OOS validation)
 * - Walk-Forward & 3-Way Backtest Comparison
 * - 1-Click "Aplică în Grid" flow to populate OKXNativeGridPanel
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  Search,
  Zap,
  TrendingUp,
  Activity,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Clock,
  Calendar,
  Layers,
  ArrowRight,
  ShieldAlert,
  BarChart2,
  Flame,
  HelpCircle,
  Sparkles,
} from 'lucide-react';

export interface ApplyToGridParams {
  instId: string;
  minPx: number;
  maxPx: number;
  gridNum: number;
  runType: '1' | '2';
  lever: number;
}

interface HistoricalGridResearchPanelProps {
  controlToken: string;
  onApplyToGrid: (params: ApplyToGridParams) => void;
  onNotify: (banner: { type: 'success' | 'error' | 'info'; text: string }) => void;
  availableUniverse?: string[];
  externalSelectedSymbol?: string;
}

export const HistoricalGridResearchPanel: React.FC<HistoricalGridResearchPanelProps> = ({
  controlToken,
  onApplyToGrid,
  onNotify,
  availableUniverse = [],
  externalSelectedSymbol,
}) => {
  const [symbol, setSymbol] = useState<string>(externalSelectedSymbol || 'BTC-USD_UM_XPERP-310530');
  const [days, setDays] = useState<number>(90);
  const [bar, setBar] = useState<string>('5m');
  const [loading, setLoading] = useState<boolean>(false);
  const [progressPct, setProgressPct] = useState<number>(0);
  const [progressMsg, setProgressMsg] = useState<string>('');
  const [report, setReport] = useState<any | null>(null);
  const [hoveredCell, setHoveredCell] = useState<{ day: number; hour: number; score: number; volat: number; vol: number } | null>(null);
  const pollTimerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (externalSelectedSymbol && externalSelectedSymbol !== symbol) {
      setSymbol(externalSelectedSymbol);
    }
  }, [externalSelectedSymbol]);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, []);

  const authHeaders = () => ({
    'Content-Type': 'application/json',
    'x-bot-token': controlToken || 'tradebot5_admin_token',
  });

  const launchResearch = async (force: boolean = false) => {
    if (!symbol) {
      onNotify({ type: 'error', text: 'Selectează un simbol valid pentru research.' });
      return;
    }

    setLoading(true);
    setProgressPct(5);
    setProgressMsg('Inițializare cercetare...');

    try {
      const res = await fetch(
        `/api/research/grid?symbol=${encodeURIComponent(symbol)}&days=${days}&bar=${bar}${force ? '&force=1' : ''}`,
        {
          headers: authHeaders(),
        }
      );
      const data = await res.json();

      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Eroare la pornirea research-ului.');
      }

      if (data.status === 'COMPLETED' && data.result) {
        setReport(data.result);
        setLoading(false);
        setProgressPct(100);
        onNotify({ type: 'success', text: `Cercetare finalizată pentru ${symbol}.` });
        return;
      }

      // Start polling status
      pollStatus();
    } catch (err: any) {
      setLoading(false);
      onNotify({ type: 'error', text: err?.message || 'Eroare de conexiune la server.' });
    }
  };

  const pollStatus = () => {
    if (pollTimerRef.current) clearInterval(pollTimerRef.current);

    pollTimerRef.current = setInterval(async () => {
      try {
        const res = await fetch(
          `/api/research/grid/status?symbol=${encodeURIComponent(symbol)}&days=${days}&bar=${bar}`,
          {
            headers: authHeaders(),
          }
        );
        const data = await res.json();

        if (data.success) {
          setProgressPct(data.progressPct || 10);
          setProgressMsg(data.progressMessage || 'Procesare...');

          if (data.status === 'COMPLETED' && data.result) {
            if (pollTimerRef.current) clearInterval(pollTimerRef.current);
            setReport(data.result);
            setLoading(false);
            onNotify({ type: 'success', text: `Cercetare completă pentru ${symbol} (${days} zile).` });
          } else if (data.status === 'ERROR') {
            if (pollTimerRef.current) clearInterval(pollTimerRef.current);
            setLoading(false);
            onNotify({ type: 'error', text: data.error || 'Cercetarea a eșuat.' });
          }
        }
      } catch {
        // Keep polling
      }
    }, 1500);
  };

  const handleApply = () => {
    if (!report?.recommendation) return;
    const rec = report.recommendation;
    onApplyToGrid({
      instId: report.symbol,
      minPx: rec.minPx,
      maxPx: rec.maxPx,
      gridNum: rec.gridNum,
      runType: rec.runType,
      lever: rec.recommendedLeverage,
    });
    onNotify({
      type: 'success',
      text: `Parametrii optimizați pentru ${report.symbol} au fost transferați în Tab 1 (OKX Native Grid Builder).`,
    });
  };

  const rec = report?.recommendation;
  const reg = report?.researchReport?.regime;
  const vp = report?.researchReport?.volumeProfile;
  const heatmap = report?.researchReport?.heatmap || [];
  const patterns = report?.patternReport?.patterns || [];
  const wf = report?.walkForward;
  const comp = report?.comparison;

  const dayNamesShort = ['Dum', 'Lun', 'Mar', 'Mie', 'Joi', 'Vin', 'Sâm'];

  const getHeatmapColor = (score: number) => {
    if (score >= 75) return 'bg-emerald-500/80 hover:bg-emerald-400 text-black font-black';
    if (score >= 60) return 'bg-cyan-500/70 hover:bg-cyan-400 text-black font-bold';
    if (score >= 48) return 'bg-amber-500/50 hover:bg-amber-400 text-white';
    if (score >= 35) return 'bg-zinc-800/80 hover:bg-zinc-700 text-zinc-400';
    return 'bg-rose-950/60 hover:bg-rose-900 text-rose-300';
  };

  return (
    <div className="space-y-4 text-xs font-sans text-zinc-200 animate-in fade-in duration-200">
      {/* 1. TOP HEADER & CONTROLS */}
      <div className="bg-zinc-950 border border-amber-500/40 rounded-lg p-3.5 space-y-3">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 border-b border-amber-500/20 pb-3">
          <div className="flex items-center space-x-2">
            <div className="p-1.5 bg-amber-500/10 border border-amber-500/40 rounded text-amber-400">
              <BarChart2 className="w-4 h-4" />
            </div>
            <div>
              <h2 className="font-black text-sm tracking-wide text-amber-400 flex items-center gap-2">
                <span>HISTORICAL GRID RESEARCH &amp; PATTERN MINER</span>
                <span className="text-[10px] px-2 py-0.5 rounded bg-zinc-900 border border-amber-500/30 text-amber-300 font-mono">
                  90-DAY DEEP WALK-FORWARD
                </span>
              </h2>
              <p className="text-[11px] text-zinc-400">
                Analiză cantitativă istorică pe OKX EEA, profil orar, regim de piață (Hurst/Chop), event study FDR și optimizare out-of-sample.
              </p>
            </div>
          </div>

          {/* Controls */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[200px]">
              <input
                type="text"
                value={symbol}
                onChange={(e) => setSymbol(e.target.value.trim().toUpperCase())}
                placeholder="ex. BTC-USD_UM_XPERP-310530"
                className="w-full bg-black border border-zinc-700 rounded px-2.5 py-1.5 text-xs text-white font-mono focus:outline-none focus:border-amber-400"
              />
              {availableUniverse.length > 0 && (
                <div className="absolute right-1 top-1.5">
                  <select
                    onChange={(e) => {
                      if (e.target.value) setSymbol(e.target.value);
                    }}
                    className="bg-zinc-900 text-zinc-300 text-[10px] rounded border border-zinc-700 px-1 py-0.5"
                    defaultValue=""
                  >
                    <option value="" disabled>
                      Univers
                    </option>
                    {availableUniverse.slice(0, 30).map((u) => (
                      <option key={u} value={u}>
                        {u.replace('-USD_UM_XPERP-310530', '')}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            <div className="flex items-center space-x-1 bg-black border border-zinc-700 rounded p-0.5">
              {[30, 60, 90].map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setDays(d)}
                  className={`px-2 py-1 rounded text-[10px] font-bold cursor-pointer transition-colors ${
                    days === d ? 'bg-amber-500 text-black' : 'text-zinc-400 hover:text-white'
                  }`}
                >
                  {d}z
                </button>
              ))}
            </div>

            <div className="flex items-center space-x-1 bg-black border border-zinc-700 rounded p-0.5">
              {['1m', '5m', '15m'].map((b) => (
                <button
                  key={b}
                  type="button"
                  onClick={() => setBar(b)}
                  className={`px-2 py-1 rounded text-[10px] font-bold cursor-pointer transition-colors ${
                    bar === b ? 'bg-cyan-400 text-black' : 'text-zinc-400 hover:text-white'
                  }`}
                >
                  {b}
                </button>
              ))}
            </div>

            <button
              type="button"
              disabled={loading}
              onClick={() => launchResearch(true)}
              className="px-3.5 py-1.5 bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-black font-black rounded text-xs flex items-center space-x-1.5 cursor-pointer shadow-[0_0_15px_rgba(245,158,11,0.3)] transition-all disabled:opacity-50"
            >
              <Zap className="w-3.5 h-3.5" />
              <span>{loading ? 'ANALIZĂ ÎN CURS...' : 'LANSEAZĂ RESEARCH'}</span>
            </button>
          </div>
        </div>

        {/* Dynamic Progress Bar */}
        {loading && (
          <div className="space-y-1.5 bg-black/60 border border-amber-500/30 rounded p-3">
            <div className="flex items-center justify-between text-xs font-mono">
              <span className="text-amber-400 animate-pulse flex items-center gap-1.5">
                <Activity className="w-3.5 h-3.5 animate-spin" />
                <span>{progressMsg}</span>
              </span>
              <strong className="text-emerald-400">{progressPct}%</strong>
            </div>
            <div className="w-full bg-zinc-900 rounded-full h-2 overflow-hidden">
              <div
                className="bg-gradient-to-r from-amber-500 via-cyan-400 to-emerald-400 h-2 transition-all duration-300"
                style={{ width: `${progressPct}%` }}
              />
            </div>
          </div>
        )}
      </div>

      {/* 2. OPTIMAL RECOMMENDATION HERO BANNER */}
      {rec && (
        <div className="bg-gradient-to-r from-zinc-950 via-zinc-900 to-zinc-950 border-2 border-cyan-500/60 rounded-lg p-4 space-y-3.5 shadow-[0_0_25px_rgba(6,182,212,0.15)]">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 border-b border-zinc-800 pb-3">
            <div className="flex items-center space-x-2.5">
              <div className="p-2 bg-cyan-500/20 border border-cyan-400/50 rounded-lg text-cyan-300">
                <Sparkles className="w-5 h-5 text-cyan-400" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="font-black text-sm text-white tracking-wide">
                    CONFIGURAȚIE OPTIMĂ RECOMANDATĂ: {rec.symbol}
                  </h3>
                  <span
                    className={`text-[10px] font-bold px-2 py-0.5 rounded border ${
                      rec.regimeVerdict === 'IDEAL_GRID'
                        ? 'bg-emerald-950/80 text-emerald-300 border-emerald-500/60'
                        : rec.regimeVerdict === 'FAVORABLE_GRID'
                        ? 'bg-cyan-950/80 text-cyan-300 border-cyan-500/60'
                        : 'bg-amber-950/80 text-amber-300 border-amber-500/60'
                    }`}
                  >
                    REGIM: {rec.regimeVerdict.replace(/_/g, ' ')}
                  </span>
                </div>
                <p className="text-zinc-400 text-xs">
                  Sintetizată din testul Walk-Forward (60z train / 30z test), Value Area și excursia percentilă 95%.
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={handleApply}
              className="px-5 py-2.5 bg-gradient-to-r from-cyan-400 to-emerald-400 hover:from-cyan-300 hover:to-emerald-300 text-black font-black rounded-lg text-xs flex items-center justify-center space-x-2 cursor-pointer shadow-[0_0_20px_rgba(34,211,238,0.4)] transition-all transform hover:scale-[1.02]"
            >
              <span>APLICĂ ÎN GRID (TAB 1)</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>

          {/* Parameter Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5 text-xs">
            <div className="bg-black/70 border border-zinc-800 rounded p-2.5">
              <span className="text-zinc-400 block text-[10px] uppercase">Min Price (Suport)</span>
              <strong className="text-emerald-400 font-mono text-sm">${rec.minPx}</strong>
            </div>

            <div className="bg-black/70 border border-zinc-800 rounded p-2.5">
              <span className="text-zinc-400 block text-[10px] uppercase">Max Price (Rezistență)</span>
              <strong className="text-rose-400 font-mono text-sm">${rec.maxPx}</strong>
            </div>

            <div className="bg-black/70 border border-zinc-800 rounded p-2.5">
              <span className="text-zinc-400 block text-[10px] uppercase">Număr Grile / Tip</span>
              <strong className="text-amber-300 font-mono text-sm">
                {rec.gridNum} trepte ({rec.runType === '2' ? 'Geometric' : 'Aritmetic'})
              </strong>
            </div>

            <div className="bg-black/70 border border-zinc-800 rounded p-2.5">
              <span className="text-zinc-400 block text-[10px] uppercase">Leverage Recomandat</span>
              <strong className="text-cyan-300 font-mono text-sm">{rec.recommendedLeverage}x (Izolat)</strong>
            </div>

            <div className="bg-black/70 border border-zinc-800 rounded p-2.5">
              <span className="text-zinc-400 block text-[10px] uppercase">Stop Loss / Take Profit</span>
              <strong className="text-zinc-200 font-mono text-sm">
                SL {rec.stopLossPct}% | TP {rec.takeProfitPct}%
              </strong>
            </div>

            <div className="bg-black/70 border border-zinc-800 rounded p-2.5">
              <span className="text-zinc-400 block text-[10px] uppercase">Randament Estimat Lunar</span>
              <strong className="text-emerald-300 font-mono text-sm">+{rec.expectedMonthlyRoiPct}%</strong>
            </div>
          </div>

          {/* Concrete Stop & Reset Triggers */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1 text-[11px]">
            <div className="bg-black/50 border border-rose-500/30 rounded p-2.5 space-y-1">
              <strong className="text-rose-400 flex items-center gap-1 font-bold">
                <ShieldAlert className="w-3.5 h-3.5" />
                <span>Condiții de Stop &amp; Invalidare:</span>
              </strong>
              <ul className="list-disc list-inside text-zinc-300 space-y-0.5">
                {rec.stopConditions.map((s, idx) => (
                  <li key={idx}>{s}</li>
                ))}
              </ul>
            </div>

            <div className="bg-black/50 border border-emerald-500/30 rounded p-2.5 space-y-1">
              <strong className="text-emerald-400 flex items-center gap-1 font-bold">
                <Clock className="w-3.5 h-3.5" />
                <span>Condiții de Reset &amp; Ore Optime:</span>
              </strong>
              <ul className="list-disc list-inside text-zinc-300 space-y-0.5">
                {rec.resetConditions.map((r, idx) => (
                  <li key={idx}>{r}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* 3. 24x7 HOURLY & DAILY HEATMAP */}
      {heatmap.length > 0 && (
        <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-3.5 space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-zinc-800 pb-2">
            <div className="flex items-center space-x-2">
              <Flame className="w-4 h-4 text-amber-400" />
              <h3 className="font-bold text-xs text-amber-400">
                HEATMAP ORAR &amp; ZILNIC: SCOR FAVORABILITATE GRID NEUTRU (24h x 7z UTC)
              </h3>
            </div>
            <div className="flex items-center space-x-3 text-[10px] text-zinc-400 font-mono">
              <span className="flex items-center gap-1">
                <span className="w-2.5 h-2.5 rounded bg-emerald-500" /> &gt;75 Optim Chop
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2.5 h-2.5 rounded bg-cyan-500" /> 60-74 FFavorabil
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2.5 h-2.5 rounded bg-amber-500" /> 48-59 Moderat
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2.5 h-2.5 rounded bg-rose-950" /> &lt;35 Risc Trend
              </span>
            </div>
          </div>

          <div className="overflow-x-auto">
            <div className="min-w-[700px] space-y-1">
              {/* Hour Header (00-23) */}
              <div className="grid grid-cols-25 gap-1 text-[9px] font-mono text-zinc-500 text-center pb-1">
                <div className="text-left font-bold text-zinc-400">Zi / Oră</div>
                {Array.from({ length: 24 }).map((_, h) => (
                  <div key={h} className="truncate">
                    {String(h).padStart(2, '0')}
                  </div>
                ))}
              </div>

              {/* 7 Days rows */}
              {[0, 1, 2, 3, 4, 5, 6].map((dow) => (
                <div key={dow} className="grid grid-cols-25 gap-1 items-center">
                  <div className="text-[10px] font-bold text-zinc-400 truncate pr-1">
                    {dayNamesShort[dow]}
                  </div>
                  {Array.from({ length: 24 }).map((_, h) => {
                    const cell = heatmap.find((c: any) => c.day === dow && c.hour === h) || {
                      gridScore: 50,
                      volatilityPct: 0.5,
                      volume: 0,
                    };
                    return (
                      <div
                        key={h}
                        onMouseEnter={() =>
                          setHoveredCell({
                            day: dow,
                            hour: h,
                            score: cell.gridScore,
                            volat: cell.volatilityPct,
                            vol: cell.volume,
                          })
                        }
                        onMouseLeave={() => setHoveredCell(null)}
                        className={`h-6 rounded flex items-center justify-center text-[10px] font-mono cursor-pointer transition-transform hover:scale-110 ${getHeatmapColor(
                          cell.gridScore
                        )}`}
                        title={`Ziua: ${dayNamesShort[dow]}, Ora: ${h}:00 UTC | Scor Grid: ${cell.gridScore}/100`}
                      >
                        {cell.gridScore}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>

          {/* Hovered cell info card */}
          {hoveredCell && (
            <div className="bg-black/80 border border-zinc-700 rounded p-2 text-xs flex items-center justify-between font-mono animate-in fade-in duration-100">
              <span className="text-amber-300 font-bold">
                {dayNamesShort[hoveredCell.day]}, {String(hoveredCell.hour).padStart(2, '0')}:00 UTC
              </span>
              <span>Scor Favorabilitate: <strong className="text-emerald-400">{hoveredCell.score}/100</strong></span>
              <span>Volatilitate Medie: <strong>{hoveredCell.volat}%</strong></span>
              <span>Volum Mediu: <strong>{hoveredCell.vol.toLocaleString()}</strong></span>
            </div>
          )}
        </div>
      )}

      {/* 4. QUANTITATIVE MARKET REGIME & VOLUME PROFILE */}
      {reg && vp && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Market Regime */}
          <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-3.5 space-y-3">
            <h3 className="font-bold text-xs text-amber-400 border-b border-zinc-800 pb-2 flex items-center gap-1.5">
              <Activity className="w-4 h-4 text-cyan-400" />
              <span>INDICATORI STATISTICI DE REGIM (HURST / CHOP / ADX)</span>
            </h3>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
              <div className="bg-black border border-zinc-800 rounded p-2.5 space-y-1">
                <span className="text-zinc-400 text-[10px] block">Hurst Exponent (R/S)</span>
                <strong className={`font-mono text-sm ${reg.hurstExponent < 0.5 ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {reg.hurstExponent}
                </strong>
                <span className="text-[10px] text-zinc-500 block">
                  {reg.hurstExponent < 0.48 ? 'Mean-Reverting (Ideal)' : reg.hurstExponent > 0.52 ? 'Trending (Riscant)' : 'Random Walk'}
                </span>
              </div>

              <div className="bg-black border border-zinc-800 rounded p-2.5 space-y-1">
                <span className="text-zinc-400 text-[10px] block">Choppiness Index</span>
                <strong className={`font-mono text-sm ${reg.choppinessIndex >= 61.8 ? 'text-emerald-400' : 'text-amber-300'}`}>
                  {reg.choppinessIndex}
                </strong>
                <span className="text-[10px] text-zinc-500 block">
                  {reg.choppinessIndex >= 61.8 ? 'Chop Puternic (>61.8)' : 'Oscilație normală'}
                </span>
              </div>

              <div className="bg-black border border-zinc-800 rounded p-2.5 space-y-1">
                <span className="text-zinc-400 text-[10px] block">Wilder ADX(14)</span>
                <strong className={`font-mono text-sm ${reg.adx14 < 20 ? 'text-emerald-400' : 'text-amber-300'}`}>
                  {reg.adx14}
                </strong>
                <span className="text-[10px] text-zinc-500 block">
                  {reg.adx14 < 20 ? 'Fără Trend (<20)' : 'Trend Moderat'}
                </span>
              </div>

              <div className="bg-black border border-zinc-800 rounded p-2.5 space-y-1">
                <span className="text-zinc-400 text-[10px] block">Autocorelație Lag-1</span>
                <strong className={`font-mono text-sm ${reg.autocorrelationLag1 < 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {reg.autocorrelationLag1}
                </strong>
                <span className="text-[10px] text-zinc-500 block">
                  {reg.autocorrelationLag1 < 0 ? 'Reversie negativă' : 'Momentum pozitiv'}
                </span>
              </div>

              <div className="bg-black border border-zinc-800 rounded p-2.5 space-y-1">
                <span className="text-zinc-400 text-[10px] block">Corelație BTC (Pearson)</span>
                <strong className="text-cyan-300 font-mono text-sm">
                  r = {report?.researchReport?.btcCorrelation?.pearsonR || 0.8}
                </strong>
                <span className="text-[10px] text-zinc-500 block">
                  Beta = {report?.researchReport?.btcCorrelation?.beta || 1.0}
                </span>
              </div>

              <div className="bg-black border border-zinc-800 rounded p-2.5 space-y-1">
                <span className="text-zinc-400 text-[10px] block">ATR(14) Volatilitate</span>
                <strong className="text-amber-300 font-mono text-sm">
                  {reg.atrPct}% (${reg.atr})
                </strong>
                <span className="text-[10px] text-zinc-500 block">Spread mediu / lumânare</span>
              </div>
            </div>

            {/* S/R Swing Clusters Table */}
            <div className="pt-2 space-y-1.5">
              <strong className="text-zinc-400 text-[11px] block">Clustere Suport / Rezistență (Pivots):</strong>
              <div className="grid grid-cols-2 gap-2 text-[11px] font-mono">
                <div className="bg-black/60 border border-emerald-950 rounded p-2 space-y-1">
                  <span className="text-emerald-400 font-bold block text-[10px]">SUPORTURI IDENTIFICATE:</span>
                  {(report?.researchReport?.supportResistance || [])
                    .filter((l: any) => l.type === 'SUPPORT')
                    .map((s: any, idx: number) => (
                      <div key={idx} className="flex justify-between text-zinc-300">
                        <span>${s.price}</span>
                        <span className="text-zinc-500">({s.distancePct}% | {s.touchCount}x)</span>
                      </div>
                    ))}
                </div>

                <div className="bg-black/60 border border-rose-950 rounded p-2 space-y-1">
                  <span className="text-rose-400 font-bold block text-[10px]">REZISTENȚE IDENTIFICATE:</span>
                  {(report?.researchReport?.supportResistance || [])
                    .filter((l: any) => l.type === 'RESISTANCE')
                    .map((r: any, idx: number) => (
                      <div key={idx} className="flex justify-between text-zinc-300">
                        <span>${r.price}</span>
                        <span className="text-zinc-500">(+{r.distancePct}% | {r.touchCount}x)</span>
                      </div>
                    ))}
                </div>
              </div>
            </div>
          </div>

          {/* Volume Profile & Value Area */}
          <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-3.5 space-y-3">
            <div className="flex items-center justify-between border-b border-zinc-800 pb-2">
              <h3 className="font-bold text-xs text-amber-400 flex items-center gap-1.5">
                <Layers className="w-4 h-4 text-emerald-400" />
                <span>VOLUME PROFILE (POC / VALUE AREA 70% / HVN / LVN)</span>
              </h3>
              <span className="text-emerald-400 font-mono text-xs">
                POC: <strong>${vp.pocPrice}</strong>
              </span>
            </div>

            <div className="grid grid-cols-3 gap-2 text-xs font-mono">
              <div className="bg-black border border-zinc-800 rounded p-2 text-center">
                <span className="text-zinc-500 text-[10px] block">Value Area Low</span>
                <strong className="text-emerald-400">${vp.valueAreaLow}</strong>
              </div>
              <div className="bg-black border border-amber-500/40 rounded p-2 text-center">
                <span className="text-amber-400 text-[10px] block">POC (Point of Control)</span>
                <strong className="text-amber-300">${vp.pocPrice}</strong>
              </div>
              <div className="bg-black border border-zinc-800 rounded p-2 text-center">
                <span className="text-zinc-500 text-[10px] block">Value Area High</span>
                <strong className="text-rose-400">${vp.valueAreaHigh}</strong>
              </div>
            </div>

            {/* Profile Bars Visualization */}
            <div className="space-y-1 max-h-48 overflow-y-auto pr-1">
              {(vp.bins || []).slice(0, 16).map((bin: any, idx: number) => (
                <div key={idx} className="flex items-center space-x-2 text-[10px] font-mono">
                  <span className="w-16 text-zinc-400 text-right shrink-0">${bin.price}</span>
                  <div className="flex-1 bg-zinc-900 h-3 rounded-sm overflow-hidden flex items-center">
                    <div
                      className={`h-full ${
                        bin.isPOC
                          ? 'bg-amber-400'
                          : bin.isHVN
                          ? 'bg-emerald-500/80'
                          : bin.isLVN
                          ? 'bg-zinc-700'
                          : 'bg-cyan-500/60'
                      }`}
                      style={{ width: `${Math.min(100, bin.pctOfTotal * 7)}%` }}
                    />
                  </div>
                  <span className="w-12 text-zinc-500 text-right">{bin.pctOfTotal}%</span>
                </div>
              ))}
            </div>

            <div className="text-[10px] text-zinc-400 border-t border-zinc-800 pt-2 flex justify-between">
              <span>HVN (Magnete de lichiditate): {vp.hvnLevels.map((p: number) => `$${p}`).join(', ') || 'N/A'}</span>
            </div>
          </div>
        </div>
      )}

      {/* 5. PATTERN MINER EVENT STUDY TABLE */}
      {patterns.length > 0 && (
        <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-3.5 space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-zinc-800 pb-2">
            <div className="flex items-center space-x-2">
              <Search className="w-4 h-4 text-cyan-400" />
              <h3 className="font-bold text-xs text-cyan-400">
                PATTERN MINER: EVENT STUDY CU CORECȚIE FDR &amp; VALIDARE TRAIN/TEST (60z / 30z)
              </h3>
            </div>
            <span className="text-[10px] text-zinc-400">
              Filtre valide generate: <strong className="text-emerald-400">{report?.patternReport?.validFiltersCount || 0}</strong>
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-zinc-800 text-zinc-400 font-mono text-[10px] uppercase">
                  <th className="py-2 px-2.5">Pattern Eveniment</th>
                  <th className="py-2 px-2">Apariții (Train/Test)</th>
                  <th className="py-2 px-2">Orizont Optim</th>
                  <th className="py-2 px-2">Randament Mediu</th>
                  <th className="py-2 px-2">Reversie %</th>
                  <th className="py-2 px-2">FDR q-value</th>
                  <th className="py-2 px-2">Status Validare</th>
                  <th className="py-2 px-2">Acțiune Filtru Grid</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60 font-mono">
                {patterns.map((pat: any) => {
                  const bestH = pat.horizons[pat.bestHorizonBars] || {};
                  return (
                    <tr key={pat.id} className="hover:bg-zinc-900/50 transition-colors">
                      <td className="py-2 px-2.5 font-bold text-white font-sans">
                        <div className="text-xs">{pat.title}</div>
                        <div className="text-[10px] text-zinc-500 font-normal">{pat.description}</div>
                      </td>
                      <td className="py-2 px-2 text-zinc-300">
                        {pat.trainOccurrences}z / {pat.testOccurrences}z
                      </td>
                      <td className="py-2 px-2 text-cyan-300">+{pat.bestHorizonBars} lumânări</td>
                      <td className={`py-2 px-2 font-bold ${pat.trainEffectPct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                        {pat.trainEffectPct > 0 ? '+' : ''}{pat.trainEffectPct}%
                      </td>
                      <td className="py-2 px-2 text-zinc-300">{bestH.reversionRatePct}%</td>
                      <td className="py-2 px-2 text-zinc-400">q = {bestH.qValueFdr}</td>
                      <td className="py-2 px-2">
                        {pat.isValid ? (
                          <span className="px-2 py-0.5 rounded bg-emerald-950 border border-emerald-500/60 text-emerald-300 text-[10px] font-bold inline-flex items-center gap-1">
                            <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                            VALIDAT (OOS)
                          </span>
                        ) : (
                          <span className="px-1.5 py-0.5 rounded bg-zinc-900 text-zinc-500 text-[10px] font-bold inline-flex items-center gap-1">
                            <XCircle className="w-3 h-3 text-zinc-600" />
                            Nevalidat
                          </span>
                        )}
                      </td>
                      <td className="py-2 px-2 text-[11px] text-zinc-300 font-sans">{pat.filterActionDescription}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 6. BACKTEST COMPARISON & WALK-FORWARD */}
      {comp && wf && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {/* 24/7 Mode */}
            <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-3.5 space-y-2">
              <span className="text-[10px] text-zinc-500 uppercase font-mono block">Scenariul 1</span>
              <h4 className="font-bold text-sm text-white">24/7 Continuu (Fără Filtre)</h4>
              <div className="space-y-1 font-mono text-xs pt-1">
                <div className="flex justify-between">
                  <span className="text-zinc-400">Net PnL:</span>
                  <strong className={comp.mode247.netPnLUSDT >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                    ${comp.mode247.netPnLUSDT} ({comp.mode247.netPnLPct}%)
                  </strong>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-400">Cicluri Arbitraj:</span>
                  <strong className="text-zinc-200">{comp.mode247.completedCycles}</strong>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-400">Max Drawdown:</span>
                  <strong className="text-rose-400">-{comp.mode247.maxDrawdownPct}%</strong>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-400">Sharpe Ratio:</span>
                  <strong className="text-cyan-300">{comp.mode247.sharpeRatio}</strong>
                </div>
              </div>
            </div>

            {/* Best Hours Mode */}
            <div className="bg-zinc-950 border-2 border-emerald-500/50 rounded-lg p-3.5 space-y-2 shadow-[0_0_15px_rgba(16,185,129,0.15)]">
              <div className="flex justify-between items-center">
                <span className="text-[10px] text-emerald-400 uppercase font-mono font-bold block">Scenariul 2 (Recomandat)</span>
                <span className="px-1.5 py-0.5 rounded bg-emerald-950 text-emerald-300 text-[9px] font-bold">
                  ALPHA: {comp.alphaBestHoursPct > 0 ? '+' : ''}{comp.alphaBestHoursPct}%
                </span>
              </div>
              <h4 className="font-bold text-sm text-emerald-300">Doar Orele Favorable</h4>
              <div className="space-y-1 font-mono text-xs pt-1">
                <div className="flex justify-between">
                  <span className="text-zinc-400">Net PnL:</span>
                  <strong className="text-emerald-400">
                    ${comp.bestHoursMode.netPnLUSDT} ({comp.bestHoursMode.netPnLPct}%)
                  </strong>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-400">Cicluri Arbitraj:</span>
                  <strong className="text-zinc-200">{comp.bestHoursMode.completedCycles}</strong>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-400">Max Drawdown:</span>
                  <strong className="text-emerald-400">-{comp.bestHoursMode.maxDrawdownPct}% (Redus!)</strong>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-400">Sharpe Ratio:</span>
                  <strong className="text-emerald-300">{comp.bestHoursMode.sharpeRatio}</strong>
                </div>
              </div>
            </div>

            {/* Pattern Filtered Mode */}
            <div className="bg-zinc-950 border border-cyan-500/40 rounded-lg p-3.5 space-y-2">
              <div className="flex justify-between items-center">
                <span className="text-[10px] text-cyan-400 uppercase font-mono block">Scenariul 3</span>
                <span className="px-1.5 py-0.5 rounded bg-cyan-950 text-cyan-300 text-[9px] font-bold">
                  ALPHA: {comp.alphaPatternFilteredPct > 0 ? '+' : ''}{comp.alphaPatternFilteredPct}%
                </span>
              </div>
              <h4 className="font-bold text-sm text-cyan-300">Cu Filtre Pattern Miner</h4>
              <div className="space-y-1 font-mono text-xs pt-1">
                <div className="flex justify-between">
                  <span className="text-zinc-400">Net PnL:</span>
                  <strong className="text-cyan-400">
                    ${comp.patternFilteredMode.netPnLUSDT} ({comp.patternFilteredMode.netPnLPct}%)
                  </strong>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-400">Cicluri Arbitraj:</span>
                  <strong className="text-zinc-200">{comp.patternFilteredMode.completedCycles}</strong>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-400">Max Drawdown:</span>
                  <strong className="text-rose-400">-{comp.patternFilteredMode.maxDrawdownPct}%</strong>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-400">Sharpe Ratio:</span>
                  <strong className="text-cyan-300">{comp.patternFilteredMode.sharpeRatio}</strong>
                </div>
              </div>
            </div>
          </div>

          {/* Walk-Forward Card */}
          <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-3.5 space-y-2.5">
            <div className="flex items-center justify-between border-b border-zinc-800 pb-2">
              <h4 className="font-bold text-xs text-amber-400 flex items-center gap-1.5">
                <ShieldAlert className="w-4 h-4 text-emerald-400" />
                <span>REZULTAT WALK-FORWARD VALIDATION (60 ZILE TRAIN ➔ 30 ZILE TEST OUT-OF-SAMPLE)</span>
              </h4>
              <span
                className={`text-[10px] font-bold px-2 py-0.5 rounded border ${
                  wf.isRobust
                    ? 'bg-emerald-950 text-emerald-300 border-emerald-500/50'
                    : 'bg-amber-950 text-amber-300 border-amber-500/50'
                }`}
              >
                {wf.isRobust ? 'STRATEGIE ROBUSTĂ (FĂRĂ OVERFITTING)' : 'ATENȚIE: DEGRADARE OUT-OF-SAMPLE'}
              </span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs font-mono">
              <div className="bg-black border border-zinc-800 rounded p-2">
                <span className="text-zinc-500 text-[10px] block">In-Sample Net PnL (60z)</span>
                <strong className="text-emerald-400">${wf.inSample.netPnLUSDT} ({wf.inSample.netPnLPct}%)</strong>
              </div>
              <div className="bg-black border border-zinc-800 rounded p-2">
                <span className="text-zinc-500 text-[10px] block">Out-Of-Sample Net PnL (30z)</span>
                <strong className="text-cyan-300">${wf.outOfSample.netPnLUSDT} ({wf.outOfSample.netPnLPct}%)</strong>
              </div>
              <div className="bg-black border border-zinc-800 rounded p-2">
                <span className="text-zinc-500 text-[10px] block">Eficiență Walk-Forward</span>
                <strong className="text-amber-300">{wf.walkForwardEfficiencyPct}%</strong>
              </div>
              <div className="bg-black border border-zinc-800 rounded p-2">
                <span className="text-zinc-500 text-[10px] block">Scor Overfitting</span>
                <strong className={wf.overfittingScore <= 35 ? 'text-emerald-400' : 'text-rose-400'}>
                  {wf.overfittingScore} / 100 {wf.overfittingScore <= 35 ? '(Minim)' : '(Ridicată)'}
                </strong>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Empty State / Call to Action */}
      {!report && !loading && (
        <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-10 text-center space-y-3">
          <div className="w-12 h-12 bg-amber-500/10 border border-amber-500/30 rounded-full flex items-center justify-center mx-auto text-amber-400">
            <BarChart2 className="w-6 h-6" />
          </div>
          <h3 className="font-bold text-sm text-white">Nicio analiză istorică activă</h3>
          <p className="text-zinc-400 text-xs max-w-md mx-auto">
            Apasă butonul <strong className="text-amber-400">„Lansează Research”</strong> pentru a descărca istoricul de lumânări de la OKX, a calcula profilul orar/zilnic, event study-ul cu corecție FDR și backtest-ul Walk-Forward.
          </p>
          <button
            type="button"
            onClick={() => launchResearch(false)}
            className="px-4 py-2 bg-amber-500 hover:bg-amber-400 text-black font-black rounded text-xs cursor-pointer inline-flex items-center space-x-1.5"
          >
            <Zap className="w-3.5 h-3.5" />
            <span>Pornește Analiza pe {symbol}</span>
          </button>
        </div>
      )}
    </div>
  );
};
