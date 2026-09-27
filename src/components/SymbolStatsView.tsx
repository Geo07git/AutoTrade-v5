import React, { useState, useEffect, useMemo } from 'react';
import {
  SymbolRollingStats,
  SymbolStatsSummary,
  SymbolTradeRecord,
} from '../shared/types';
import {
  TrendingUp,
  TrendingDown,
  BarChart2,
  RefreshCw,
  Search,
  Filter,
  AlertTriangle,
  CheckCircle,
  HelpCircle,
  ChevronDown,
  ChevronUp,
  Layers,
  Zap,
  Sliders,
  DollarSign,
  Activity,
  ArrowUpDown,
  Clock,
  PieChart,
} from 'lucide-react';

interface SymbolStatsViewProps {
  onSelectSymbolForChart?: (symbol: string) => void;
  lang?: string;
}

type SortField = 'n' | 'winrate' | 'hitRateMfe15' | 'avgMfe' | 'totalPnl' | 'symbol' | 'fastRunnerRate';
type SortOrder = 'asc' | 'desc';
type FilterCategory = 'ALL' | 'VALID' | 'RUNNERS' | 'NOISE';

export const SymbolStatsView: React.FC<SymbolStatsViewProps> = ({
  onSelectSymbolForChart,
  lang = 'ro',
}) => {
  const [stats, setStats] = useState<SymbolRollingStats[]>([]);
  const [summary, setSummary] = useState<SymbolStatsSummary | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isRecalculating, setIsRecalculating] = useState<boolean>(false);
  const [isTogglingMultiplier, setIsTogglingMultiplier] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedFilter, setSelectedFilter] = useState<FilterCategory>('ALL');
  const [sortField, setSortField] = useState<SortField>('n');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');
  const [expandedSymbol, setExpandedSymbol] = useState<string | null>(null);
  const [showMethodology, setShowMethodology] = useState<boolean>(false);
  const [actionMessage, setActionMessage] = useState<{ type: 'success' | 'info' | 'error'; text: string } | null>(null);

  const fetchSymbolStats = async () => {
    try {
      setIsLoading(true);
      const res = await fetch('/api/bot/symbol-stats');
      if (res.ok) {
        const data = await res.json();
        setStats(data.stats || []);
        setSummary(data.summary || null);
      }
    } catch (err: any) {
      console.error('Failed to load symbol stats:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchSymbolStats();
    const interval = setInterval(fetchSymbolStats, 15000); // auto-refresh every 15s
    return () => clearInterval(interval);
  }, []);

  const handleRecalculate = async () => {
    try {
      setIsRecalculating(true);
      const token = localStorage.getItem('tb5_control_token') || 'tradebot5_admin_token';
      const res = await fetch('/api/bot/symbol-stats/recalculate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-bot-token': token },
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setStats(data.stats || []);
        setSummary(data.summary || null);
        setActionMessage({
          type: 'success',
          text: 'Agregatul statistic a fost recalculat cu succes din toate ordinele închise!',
        });
        setTimeout(() => setActionMessage(null), 4000);
      }
    } catch (err: any) {
      setActionMessage({
        type: 'error',
        text: 'Eroare la recalculare: ' + (err.message || 'Eroare conexiune'),
      });
      setTimeout(() => setActionMessage(null), 4000);
    } finally {
      setIsRecalculating(false);
    }
  };

  const handleToggleMultiplier = async () => {
    try {
      setIsTogglingMultiplier(true);
      const token = localStorage.getItem('tb5_control_token') || 'tradebot5_admin_token';
      const res = await fetch('/api/bot/symbol-stats/toggle-multiplier', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-bot-token': token },
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setSummary(data.summary || null);
        setActionMessage({
          type: 'info',
          text: data.message || (data.multiplierActive ? 'Feedback Multiplier ACTIVAT' : 'Feedback Multiplier DEZACTIVAT'),
        });
        setTimeout(() => setActionMessage(null), 4000);
        fetchSymbolStats();
      }
    } catch (err: any) {
      setActionMessage({
        type: 'error',
        text: 'Eroare la comutare multiplicator: ' + (err.message || 'Eroare conexiune'),
      });
      setTimeout(() => setActionMessage(null), 4000);
    } finally {
      setIsTogglingMultiplier(false);
    }
  };

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortOrder(sortOrder === 'desc' ? 'asc' : 'desc');
    } else {
      setSortField(field);
      setSortOrder('desc');
    }
  };

  const filteredStats = useMemo(() => {
    let result = [...stats];

    // Search filter
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      result = result.filter((s) => s.symbol.toLowerCase().includes(q));
    }

    // Category filter
    if (selectedFilter === 'VALID') {
      result = result.filter((s) => s.n >= 8);
    } else if (selectedFilter === 'RUNNERS') {
      result = result.filter((s) => s.hitRateMfe15 >= 50);
    } else if (selectedFilter === 'NOISE') {
      result = result.filter((s) => s.n < 8);
    }

    // Sorting
    result.sort((a, b) => {
      let comparison = 0;
      if (sortField === 'symbol') {
        comparison = a.symbol.localeCompare(b.symbol);
      } else {
        comparison = ((a as any)[sortField] || 0) - ((b as any)[sortField] || 0);
      }
      return sortOrder === 'desc' ? -comparison : comparison;
    });

    return result;
  }, [stats, searchQuery, selectedFilter, sortField, sortOrder]);

  return (
    <div className="flex flex-col w-full h-full bg-zinc-950 border border-amber-500/30 rounded p-2.5 sm:p-3 font-mono min-h-0 select-text">
      {/* 1. Header & Quick Summary */}
      <div className="shrink-0 border-b border-amber-500/30 pb-2.5 mb-2.5 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center space-x-2">
            <BarChart2 className="w-5 h-5 text-amber-500 shrink-0" />
            <div>
              <div className="flex items-center space-x-2">
                <span className="font-bold text-xs sm:text-sm tracking-wider text-amber-400">
                  ANALIZĂ ROLLING PE SIMBOL (HIT-RATE MFE ≥ 1.5%)
                </span>
                <span className="text-[10px] bg-amber-950 text-amber-300 px-1.5 py-0.5 rounded border border-amber-500/40">
                  ROLLING: ULTIMELE 30 TRADE-URI
                </span>
              </div>
              <div className="text-[10px] text-zinc-400">
                Interpolare liniară continuă a multiplicatorului [0.50x – 1.50x]. Eșantion valid: n ≥ 8. Telemetrie viteză de impuls (≤ 5 min).
              </div>
            </div>
          </div>

          <div className="flex items-center space-x-2">
            <button
              type="button"
              onClick={handleToggleMultiplier}
              disabled={isTogglingMultiplier}
              className={`px-2.5 py-1 rounded text-[10px] font-bold border transition-all flex items-center space-x-1 cursor-pointer ${
                summary?.multiplierActive
                  ? 'bg-emerald-950 text-emerald-300 border-emerald-500 hover:bg-emerald-900 shadow-[0_0_8px_rgba(16,185,129,0.3)]'
                  : 'bg-zinc-900 text-zinc-400 border-zinc-700 hover:text-amber-300'
              }`}
              title="Activează feedback-ul ca multiplicator continuu: 0.50x (la 0%) până la 1.50x (la 100%)"
            >
              <Sliders className="w-3 h-3" />
              <span>FEEDBACK MULTIPLIER: {summary?.multiplierActive ? 'ACTIV (APLICAT)' : 'MONITORIZARE (INACTIV)'}</span>
            </button>

            <button
              type="button"
              onClick={handleRecalculate}
              disabled={isRecalculating}
              className="px-2.5 py-1 bg-amber-500/20 hover:bg-amber-500/30 text-amber-400 border border-amber-500/40 rounded text-[10px] font-bold transition-all flex items-center space-x-1 cursor-pointer"
              title="Recalculează fereastra rolling din toate ordinele închise din blotter"
            >
              <RefreshCw className={`w-3 h-3 ${isRecalculating ? 'animate-spin' : ''}`} />
              <span>RECALCULEAZĂ ISTORIC</span>
            </button>

            <button
              type="button"
              onClick={() => setShowMethodology(!showMethodology)}
              className="px-2 py-1 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 border border-zinc-700 rounded text-[10px] font-bold flex items-center space-x-1 cursor-pointer"
            >
              <HelpCircle className="w-3 h-3 text-cyan-400" />
              <span>{showMethodology ? 'ASCUNDE GHID' : 'METODOLOGIE & SIMETRIE'}</span>
            </button>
          </div>
        </div>

        {actionMessage && (
          <div className={`p-1.5 px-3 rounded text-[11px] border font-mono ${
            actionMessage.type === 'success'
              ? 'bg-emerald-950/80 border-emerald-500/50 text-emerald-300'
              : actionMessage.type === 'info'
              ? 'bg-sky-950/80 border-sky-500/50 text-sky-300'
              : 'bg-rose-950/80 border-rose-500/50 text-rose-300'
          }`}>
            {actionMessage.text}
          </div>
        )}

        {/* Metric Cards Row */}
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2 text-xs">
          <div className="bg-black/60 border border-zinc-800 rounded p-2">
            <span className="text-zinc-500 text-[9px] block uppercase">Simboluri Monitorizate</span>
            <div className="flex items-baseline space-x-1.5 mt-0.5">
              <span className="font-bold text-amber-400 text-sm">{summary?.totalTrackedSymbols ?? stats.length}</span>
              <span className="text-[10px] text-zinc-500">active</span>
            </div>
          </div>

          <div className="bg-black/60 border border-zinc-800 rounded p-2">
            <span className="text-zinc-500 text-[9px] block uppercase">Sample Valid (n ≥ 8)</span>
            <div className="flex items-baseline space-x-1.5 mt-0.5">
              <span className="font-bold text-emerald-400 text-sm">{summary?.validSampleSymbols ?? 0}</span>
              <span className="text-[10px] text-zinc-500">statistici robuste</span>
            </div>
          </div>

          <div className="bg-black/60 border border-zinc-800 rounded p-2">
            <span className="text-zinc-500 text-[9px] block uppercase">Zgomot Statistic (n &lt; 8)</span>
            <div className="flex items-baseline space-x-1.5 mt-0.5">
              <span className="font-bold text-amber-500 text-sm">{summary?.lowSampleSymbols ?? 0}</span>
              <span className="text-[10px] text-zinc-500">fără intervenție</span>
            </div>
          </div>

          <div className="bg-black/60 border border-zinc-800 rounded p-2">
            <span className="text-zinc-500 text-[9px] block uppercase">Hit-rate MFE Portofoliu</span>
            <div className="flex items-baseline space-x-1.5 mt-0.5">
              <span className="font-bold text-cyan-400 text-sm">{summary?.overallAvgHitRateMfe15 ?? 0}%</span>
              <span className="text-[10px] text-zinc-500">reper agregat</span>
            </div>
          </div>

          <div className="bg-black/60 border border-zinc-800 rounded p-2">
            <span className="text-zinc-500 text-[9px] block uppercase">Top Runner Momentum</span>
            <div className="flex items-baseline space-x-1 mt-0.5 truncate">
              <span className="font-bold text-emerald-300 text-xs truncate">
                {summary?.topRunnerSymbol ? summary.topRunnerSymbol.replace('-USDT-SWAP', '') : '--'}
              </span>
              {summary?.topRunnerHitRate !== undefined && (
                <span className="text-[10px] text-emerald-400">({summary.topRunnerHitRate}%)</span>
              )}
            </div>
          </div>

          <div className="bg-black/60 border border-zinc-800 rounded p-2">
            <span className="text-zinc-500 text-[9px] block uppercase">Cel Mai Lent / Plat</span>
            <div className="flex items-baseline space-x-1 mt-0.5 truncate">
              <span className="font-bold text-rose-400 text-xs truncate">
                {summary?.worstPerformerSymbol ? summary.worstPerformerSymbol.replace('-USDT-SWAP', '') : '--'}
              </span>
              {summary?.worstPerformerHitRate !== undefined && (
                <span className="text-[10px] text-rose-500">({summary.worstPerformerHitRate}%)</span>
              )}
            </div>
          </div>
        </div>

        {/* CERINȚA 3: RAPORTARE EXPLICITĂ A ACOPERIRII EȘANTIONULUI (SAMPLE & CAPITAL COVERAGE) */}
        <div className="bg-black/70 border border-zinc-800 rounded p-2.5 space-y-2">
          <div className="flex flex-wrap items-center justify-between text-[11px] gap-2">
            <div className="flex items-center space-x-2">
              <Layers className="w-4 h-4 text-emerald-400 shrink-0" />
              <span className="font-bold text-zinc-200 tracking-wide">
                ACOPERIRE CAPITAL ACTIV &amp; EȘANTION: VALID (n ≥ 8) vs NEUTRU IMPLICIT (n &lt; 8)
              </span>
            </div>
            <div className="flex items-center space-x-3 text-[10px]">
              <span className="text-zinc-400">
                Acoperire Trade-uri Istoric: <strong className="text-cyan-400">{summary?.validTradesCoveragePct ?? 0}%</strong> ({summary?.validTradesCount ?? 0}/{summary?.totalTradesAnalyzed ?? 0} trade-uri pe simboluri valide)
              </span>
              <span className="text-zinc-600 hidden sm:inline">|</span>
              <span className="text-zinc-400 flex items-center space-x-1">
                <Zap className="w-3 h-3 text-amber-400" />
                <span>Viteză Impuls Portofoliu (&le;5m): <strong className="text-amber-300">{summary?.fastRunnerPortfolioCount ?? 0} trade-uri</strong> ({summary?.fastRunnerPortfolioRate ?? 0}%)</span>
              </span>
            </div>
          </div>

          {/* Visual Dual Progress Bar */}
          <div className="w-full bg-zinc-900 rounded-full h-3 flex overflow-hidden border border-zinc-800">
            <div
              className="bg-gradient-to-r from-emerald-600 to-teal-500 h-full transition-all duration-500 flex items-center justify-center text-[9px] font-bold text-black select-none"
              style={{ width: `${Math.max(summary?.validCapitalCoveragePct || 0, (summary?.totalActiveCapitalUSDT ? 5 : 0))}%` }}
              title={`Capital activ sub simboluri cu eșantion VALID: $${summary?.validCapitalUSDT ?? 0} (${summary?.validCapitalCoveragePct ?? 0}%)`}
            >
              {(summary?.validCapitalCoveragePct || 0) > 12 ? `${summary?.validCapitalCoveragePct}% VALID` : ''}
            </div>
            <div
              className="bg-zinc-800 hover:bg-zinc-700 h-full transition-all duration-500 flex items-center justify-center text-[9px] font-bold text-zinc-400 select-none"
              style={{ width: `${Math.max(0, 100 - (summary?.validCapitalCoveragePct || 0))}%` }}
              title={`Capital activ sub simboluri NEUTRE (n<8): $${summary?.lowSampleCapitalUSDT ?? 0} (${summary?.lowSampleCapitalCoveragePct ?? 0}%)`}
            >
              {(summary?.lowSampleCapitalCoveragePct || 0) > 15 ? `${summary?.lowSampleCapitalCoveragePct}% NEUTRU (n<8)` : ''}
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between text-[10px] text-zinc-400 gap-2">
            <div className="flex items-center space-x-4">
              <div className="flex items-center space-x-1.5">
                <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block"></span>
                <span>Capital sub Simboluri VALIDE: <strong className="text-emerald-300 font-mono">${summary?.validCapitalUSDT ?? 0}</strong> ({summary?.validCapitalCoveragePct ?? 0}%)</span>
              </div>
              <div className="flex items-center space-x-1.5">
                <span className="w-2 h-2 rounded-full bg-zinc-500 inline-block"></span>
                <span>Capital sub Multiplicator Neutru (n&lt;8): <strong className="text-zinc-300 font-mono">${summary?.lowSampleCapitalUSDT ?? 0}</strong> ({summary?.lowSampleCapitalCoveragePct ?? 0}%)</span>
              </div>
            </div>
            <div className="text-[9px] text-zinc-500 italic">
              Așteptare: acoperirea crește treptat pe măsură ce botul acumulează tranzacții. Nu e nevoie de intervenție acum.
            </div>
          </div>
        </div>

        {/* Methodology Accordion */}
        {showMethodology && (
          <div className="bg-zinc-900 border border-cyan-500/40 rounded p-3 text-[11px] space-y-2 text-zinc-300 animate-fadeIn">
            <div className="flex items-center space-x-1.5 text-cyan-400 font-bold border-b border-zinc-800 pb-1">
              <HelpCircle className="w-4 h-4" />
              <span>METODOLOGIE ȘTIINȚIFICĂ: MULTIPLICATOR CONTINUU &amp; TELEMETRIE VITEZĂ</span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-1">
              <div className="bg-black/50 p-2.5 rounded border border-zinc-800 space-y-1">
                <span className="font-bold text-amber-400 block">1. Interpolare Liniară Continuă (0.50x – 1.50x)</span>
                <p className="text-[10px] text-zinc-400 leading-relaxed">
                  Am eliminat treptele fixe (0.5x / 1.0x / 1.2x) pentru a evita salturile bruște provocate de 1 singur trade diferență pe eșantioane de 8-10 poziții. Multiplicatorul este o <strong>funcție continuă</strong>:
                  <br />
                  <code className="text-amber-300 text-[10px]">multiplier = 0.50 + (hitRateMfe15 / 100) * 1.00</code>
                  <br />
                  Fiecare +1% în hit-rate aduce exact +0.01x la multiplicator.
                </p>
              </div>

              <div className="bg-black/50 p-2.5 rounded border border-zinc-800 space-y-1">
                <span className="font-bold text-emerald-400 block">2. Simetrie Matematică Justificată (±0.50x)</span>
                <p className="text-[10px] text-zinc-400 leading-relaxed">
                  Intervalul este <strong>perfect simetric</strong> în jurul pragului neutru de 50% hit-rate (1.00x):
                  <br />• La 0% hit-rate ➔ <strong>0.50x</strong> (-0.50x conservare capital pe active plate)
                  <br />• La 50% hit-rate ➔ <strong>1.00x</strong> (baseline neutru)
                  <br />• La 100% hit-rate ➔ <strong>1.50x</strong> (+0.50x bonus proporțional pe runneri constanți)
                  <br />Simbolurile cu n &lt; 8 rămân strict la 1.00x (zgomot statistic).
                </p>
              </div>

              <div className="bg-black/50 p-2.5 rounded border border-zinc-800 space-y-1">
                <span className="font-bold text-cyan-400 block">3. Pasul 2: Telemetrie Pasivă Viteză (≤5m)</span>
                <p className="text-[10px] text-zinc-400 leading-relaxed">
                  Activează înregistrarea pasivă a momentului în care este atins MFE ≥ 1.5% (dacă se produce în primele 3-5 minute).
                  <br />• <strong>Fără efect pe decizii de size sau intrare</strong> în această etapă.
                  <br />• Acumulăm minim 8-10 trade-uri per simbol pentru a verifica dacă viteza timpurie a impulsului separă câștigătorii de ieșirile la TIME_STOP mai bine decât metaScore-ul static.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* 2. Filters & Search Bar */}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <div className="flex items-center space-x-1 text-xs">
            <span className="text-zinc-500 text-[10px] mr-1 flex items-center">
              <Filter className="w-3 h-3 inline mr-0.5" /> Filtru:
            </span>
            {(['ALL', 'VALID', 'RUNNERS', 'NOISE'] as FilterCategory[]).map((cat) => {
              const labels: Record<FilterCategory, string> = {
                ALL: `TOATE (${stats.length})`,
                VALID: `VALIDE n≥8 (${stats.filter((s) => s.n >= 8).length})`,
                RUNNERS: `RUNNERS Hit≥50% (${stats.filter((s) => s.hitRateMfe15 >= 50).length})`,
                NOISE: `ZGOMOT n<8 (${stats.filter((s) => s.n < 8).length})`,
              };
              return (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setSelectedFilter(cat)}
                  className={`px-2 py-0.5 rounded text-[10px] font-bold transition-all border ${
                    selectedFilter === cat
                      ? 'bg-amber-500 text-black border-amber-400 font-extrabold'
                      : 'bg-zinc-900 text-zinc-400 border-zinc-800 hover:text-zinc-200'
                  }`}
                >
                  {labels[cat]}
                </button>
              );
            })}
          </div>

          <div className="relative min-w-[180px]">
            <Search className="w-3.5 h-3.5 absolute left-2 top-2 text-zinc-500" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Caută simbol (ex: HUMA, W, ONE)..."
              className="bg-black border border-zinc-800 rounded pl-7 pr-2 py-1 text-[11px] text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-amber-500 w-full"
            />
          </div>
        </div>
      </div>

      {/* 3. Main Table */}
      <div className="flex-1 overflow-x-auto overflow-y-auto min-h-[380px] max-h-[60vh] sm:max-h-[68vh] terminal-scrollbar border border-zinc-900 rounded bg-black/40">
        {isLoading && stats.length === 0 ? (
          <div className="flex items-center justify-center h-48 text-zinc-500 space-x-2">
            <RefreshCw className="w-5 h-5 animate-spin text-amber-500" />
            <span>Se calculează statisticile pe simbol din istoricul de tranzacții...</span>
          </div>
        ) : filteredStats.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 text-zinc-500 space-y-2">
            <AlertTriangle className="w-7 h-7 text-amber-500/40" />
            <p className="text-xs">Niciun simbol nu corespunde criteriilor de filtrare selectate.</p>
          </div>
        ) : (
          <table className="w-full min-w-[860px] text-[11px] text-left border-collapse">
            <thead className="sticky top-0 bg-zinc-900 text-zinc-400 border-b border-zinc-800 z-10 text-[10px] uppercase select-none">
              <tr>
                <th className="p-2 cursor-pointer hover:text-amber-400" onClick={() => handleSort('symbol')}>
                  <div className="flex items-center space-x-1">
                    <span>Simbol</span>
                    {sortField === 'symbol' && <ArrowUpDown className="w-3 h-3 text-amber-400" />}
                  </div>
                </th>
                <th className="p-2 text-center cursor-pointer hover:text-amber-400" onClick={() => handleSort('n')}>
                  <div className="flex items-center justify-center space-x-1">
                    <span>Trades (n)</span>
                    {sortField === 'n' && <ArrowUpDown className="w-3 h-3 text-amber-400" />}
                  </div>
                </th>
                <th className="p-2 text-right cursor-pointer hover:text-amber-400" onClick={() => handleSort('winrate')}>
                  <div className="flex items-center justify-end space-x-1">
                    <span>Winrate</span>
                    {sortField === 'winrate' && <ArrowUpDown className="w-3 h-3 text-amber-400" />}
                  </div>
                </th>
                <th className="p-2 text-right cursor-pointer hover:text-amber-400" onClick={() => handleSort('hitRateMfe15')}>
                  <div className="flex items-center justify-end space-x-1">
                    <span title="Procent din trade-uri cu MFE ≥ 1.5%">Hit-rate MFE ≥ 1.5%</span>
                    {sortField === 'hitRateMfe15' && <ArrowUpDown className="w-3 h-3 text-amber-400" />}
                  </div>
                </th>
                <th className="p-2 text-right cursor-pointer hover:text-amber-400" onClick={() => handleSort('avgMfe')}>
                  <div className="flex items-center justify-end space-x-1">
                    <span title="Excursie Maximă Favorabilă Medie">Avg MFE</span>
                    {sortField === 'avgMfe' && <ArrowUpDown className="w-3 h-3 text-amber-400" />}
                  </div>
                </th>
                <th className="p-2 text-right cursor-pointer hover:text-amber-400" onClick={() => handleSort('totalPnl')}>
                  <div className="flex items-center justify-end space-x-1">
                    <span>Total PnL ($)</span>
                    {sortField === 'totalPnl' && <ArrowUpDown className="w-3 h-3 text-amber-400" />}
                  </div>
                </th>
                <th className="p-2 text-center cursor-pointer hover:text-amber-400" onClick={() => handleSort('fastRunnerRate')} title="Telemetrie pasivă: Trade-uri cu MFE ≥ 1.5% atins în primele 3-5 minute">
                  <div className="flex items-center justify-center space-x-1">
                    <span>Viteză (≤5m)</span>
                    <span className="text-[8px] text-zinc-500 font-sans">[PASIV]</span>
                    {sortField === 'fastRunnerRate' && <ArrowUpDown className="w-3 h-3 text-amber-400" />}
                  </div>
                </th>
                <th className="p-2 text-center">Statut Eșantion</th>
                <th className="p-2 text-center" title="Interpolare liniară continuă simetrică [0.50x - 1.50x]">
                  <span>Multiplier Gradual</span>
                </th>
                <th className="p-2 text-center">Acțiuni</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-900">
              {filteredStats.map((item) => {
                const isExpanded = expandedSymbol === item.symbol;
                const isNoise = item.n < 8;
                const isRunner = item.hitRateMfe15 >= 70 && !isNoise;
                const isLaggard = item.hitRateMfe15 < 30 && !isNoise;
                const isProfitable = item.totalPnl >= 0;

                return (
                  <React.Fragment key={item.symbol}>
                    <tr
                      className={`hover:bg-zinc-900/60 transition-colors cursor-pointer ${
                        isExpanded ? 'bg-zinc-900/80 border-l-2 border-amber-500' : ''
                      } ${isRunner ? 'bg-emerald-950/10' : isLaggard ? 'bg-rose-950/10' : ''}`}
                      onClick={() => setExpandedSymbol(isExpanded ? null : item.symbol)}
                    >
                      {/* Simbol */}
                      <td className="p-2 font-bold text-amber-300">
                        <div className="flex items-center space-x-1.5">
                          {isExpanded ? (
                            <ChevronUp className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                          ) : (
                            <ChevronDown className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                          )}
                          <span>{item.symbol.replace('-USDT-SWAP', '')}</span>
                          <span className="text-[9px] text-zinc-600 hidden sm:inline">SWAP</span>
                        </div>
                      </td>

                      {/* Trades (n) */}
                      <td className="p-2 text-center font-bold">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] ${
                          item.n >= 15
                            ? 'bg-blue-950 text-blue-300 border border-blue-600/40'
                            : item.n >= 8
                            ? 'bg-zinc-800 text-zinc-200'
                            : 'bg-zinc-900 text-zinc-500 border border-zinc-800'
                        }`}>
                          {item.n}
                        </span>
                      </td>

                      {/* Winrate */}
                      <td className="p-2 text-right">
                        <span className={`font-bold ${
                          item.winrate >= 60 ? 'text-emerald-400' : item.winrate <= 35 ? 'text-rose-400' : 'text-zinc-300'
                        }`}>
                          {item.winrate.toFixed(1)}%
                        </span>
                        <span className="text-[9px] text-zinc-500 ml-1">
                          ({item.wins}W/{item.losses}L)
                        </span>
                      </td>

                      {/* Hit-rate MFE >= 1.5% */}
                      <td className="p-2 text-right">
                        <span className={`font-bold px-1.5 py-0.5 rounded ${
                          item.hitRateMfe15 >= 70
                            ? 'bg-emerald-950 text-emerald-300 border border-emerald-500/50'
                            : item.hitRateMfe15 >= 50
                            ? 'bg-teal-950 text-teal-300 border border-teal-500/40'
                            : item.hitRateMfe15 < 30 && !isNoise
                            ? 'bg-rose-950 text-rose-300 border border-rose-500/50'
                            : 'text-zinc-300'
                        }`}>
                          {item.hitRateMfe15.toFixed(1)}%
                        </span>
                        <span className="text-[9px] text-zinc-500 ml-1">
                          ({item.trailingHitCount}/{item.n})
                        </span>
                      </td>

                      {/* Avg MFE */}
                      <td className="p-2 text-right">
                        <span className={`font-bold ${
                          item.avgMfe >= 1.5 ? 'text-emerald-400' : item.avgMfe < 0.6 ? 'text-rose-400' : 'text-zinc-300'
                        }`}>
                          +{item.avgMfe.toFixed(2)}%
                        </span>
                        <div className="text-[9px] text-zinc-600">
                          MAE: {item.avgMae.toFixed(2)}%
                        </div>
                      </td>

                      {/* Total PnL */}
                      <td className="p-2 text-right">
                        <div className={`font-bold ${isProfitable ? 'text-emerald-400' : 'text-rose-400'}`}>
                          {isProfitable ? '+' : ''}${item.totalPnl.toFixed(2)}
                        </div>
                        <div className={`text-[9px] ${item.avgPnlPct >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                          {item.avgPnlPct >= 0 ? '+' : ''}{item.avgPnlPct.toFixed(2)}% avg
                        </div>
                      </td>

                      {/* Viteză Impuls (≤5m) - Telemetrie Pasivă */}
                      <td className="p-2 text-center font-mono">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] ${
                          (item.fastRunnerCount ?? 0) > 0
                            ? 'bg-amber-950/60 text-amber-300 border border-amber-500/30'
                            : 'text-zinc-500'
                        }`} title="Trade-uri care au atins MFE ≥ 1.5% în primele 3-5 minute">
                          {item.fastRunnerCount ?? 0}
                          <span className="text-[9px] text-zinc-500 ml-0.5">({item.fastRunnerRate ?? 0}%)</span>
                        </span>
                      </td>

                      {/* Statut Eșantion */}
                      <td className="p-2 text-center">
                        {item.confidenceStatus === 'HIGH_CONFIDENCE' ? (
                          <span className="bg-emerald-950 text-emerald-300 border border-emerald-600/40 px-1.5 py-0.5 rounded text-[9px] font-bold" title="n ≥ 15: Statistic robust">
                            ROBUST (n≥15)
                          </span>
                        ) : item.confidenceStatus === 'DEVELOPING' ? (
                          <span className="bg-blue-950 text-blue-300 border border-blue-600/40 px-1.5 py-0.5 rounded text-[9px] font-bold" title="8 ≤ n < 15: Eșantion valid">
                            VALID (n≥8)
                          </span>
                        ) : (
                          <span className="bg-zinc-900 text-zinc-500 border border-zinc-800 px-1.5 py-0.5 rounded text-[9px]" title="n < 8: Eșantion mic, tratat ca zgomot">
                            ZGOMOT (n&lt;8)
                          </span>
                        )}
                      </td>

                      {/* Multiplier Size Gradual Continuu */}
                      <td className="p-2 text-center">
                        <span className={`font-mono px-2 py-0.5 rounded font-bold text-[10px] ${
                          isNoise
                            ? 'bg-zinc-900 text-zinc-500 border border-zinc-800'
                            : item.recommendedMultiplier > 1.05
                            ? 'bg-emerald-950 text-emerald-300 border border-emerald-500/70 shadow-[0_0_6px_rgba(16,185,129,0.2)]'
                            : item.recommendedMultiplier < 0.95
                            ? 'bg-rose-950 text-rose-300 border border-rose-500/70 shadow-[0_0_6px_rgba(244,63,94,0.2)]'
                            : 'bg-zinc-900 text-zinc-300 border border-zinc-700'
                        }`} title={`Interpolare liniară continuă: 0.50x la 0% ➔ 1.00x la 50% ➔ 1.50x la 100% (Hit-rate: ${item.hitRateMfe15}%)`}>
                          {item.recommendedMultiplier.toFixed(2)}x
                        </span>
                      </td>

                      {/* Acțiuni */}
                      <td className="p-2 text-center" onClick={(e) => e.stopPropagation()}>
                        {onSelectSymbolForChart && (
                          <button
                            type="button"
                            onClick={() => onSelectSymbolForChart(item.symbol)}
                            className="px-2 py-0.5 bg-zinc-800 hover:bg-amber-500/20 text-zinc-300 hover:text-amber-400 border border-zinc-700 rounded text-[9px] font-bold transition-all"
                            title="Afișează graficul pe acest simbol"
                          >
                            CHART
                          </button>
                        )}
                      </td>
                    </tr>

                    {/* Expanded Detail Rows: Recent Trades for this symbol */}
                    {isExpanded && (
                      <tr className="bg-black/80 border-b border-zinc-800">
                        <td colSpan={10} className="p-3">
                          <div className="space-y-2">
                            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 pb-1.5 text-[10px]">
                              <span className="font-bold text-amber-400 flex items-center space-x-1">
                                <Activity className="w-3.5 h-3.5" />
                                <span>ISTORIC RECENT ROLLING: {item.symbol} ({item.recentTrades?.length || 0} trade-uri afișate)</span>
                              </span>
                              <div className="flex items-center space-x-3 text-zinc-400">
                                <span>Timp mediu deținere: <strong className="text-cyan-400">{item.avgHoldingMinutes ?? '--'} min</strong></span>
                                <span>Impuls rapid (&le;5m): <strong className="text-emerald-400">{item.fastRunnerCount ?? 0} trade-uri</strong></span>
                                {item.avgTimeToMfeMinutes && (
                                  <span>Timp mediu până la MFE 1.5%: <strong className="text-amber-300">{item.avgTimeToMfeMinutes} min</strong></span>
                                )}
                              </div>
                            </div>

                            {(!item.recentTrades || item.recentTrades.length === 0) ? (
                              <div className="text-zinc-600 text-center py-2 text-[10px]">
                                Nu sunt trade-uri detaliate încărcate pentru acest simbol.
                              </div>
                            ) : (
                              <div className="overflow-x-auto">
                                <table className="w-full text-[10px] text-left border-collapse">
                                  <thead className="bg-zinc-950 text-zinc-500 border-b border-zinc-900 uppercase">
                                    <tr>
                                      <th className="p-1.5">ID / Motiv</th>
                                      <th className="p-1.5 text-right">PnL Net ($)</th>
                                      <th className="p-1.5 text-right">PnL %</th>
                                      <th className="p-1.5 text-right">MFE % (Peak)</th>
                                      <th className="p-1.5 text-right">MAE % (Drawdown)</th>
                                      <th className="p-1.5 text-center">Deținere</th>
                                      <th className="p-1.5 text-center">Prag MFE ≥ 1.5%</th>
                                      <th className="p-1.5 text-center">Viteză (≤5m)</th>
                                      <th className="p-1.5 text-right">Dată Închidere</th>
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y divide-zinc-900 font-mono">
                                    {item.recentTrades.map((trade, idx) => {
                                      const isWin = trade.isWin;
                                      const isFast = trade.isFastRunner || (trade.hitMfe15 && trade.holdingTimeMinutes !== undefined && trade.holdingTimeMinutes <= 5.0);

                                      return (
                                        <tr key={idx} className="hover:bg-zinc-900/40">
                                          <td className="p-1.5 text-zinc-400">
                                            <span className="font-bold text-zinc-300">{trade.intent || 'CLOSE'}</span>
                                            <span className="text-[9px] text-zinc-600 ml-1">({trade.positionId.slice(-6)})</span>
                                          </td>
                                          <td className={`p-1.5 text-right font-bold ${isWin ? 'text-emerald-400' : 'text-rose-400'}`}>
                                            {isWin ? '+' : ''}${trade.pnl.toFixed(2)}
                                          </td>
                                          <td className={`p-1.5 text-right font-bold ${trade.pnlPct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                                            {trade.pnlPct >= 0 ? '+' : ''}{trade.pnlPct.toFixed(2)}%
                                          </td>
                                          <td className="p-1.5 text-right font-bold text-emerald-400">
                                            +{trade.mfePct.toFixed(2)}%
                                          </td>
                                          <td className="p-1.5 text-right text-rose-400">
                                            {trade.maePct !== undefined ? `${trade.maePct.toFixed(2)}%` : '--'}
                                          </td>
                                          <td className="p-1.5 text-center text-cyan-400">
                                            {trade.holdingTimeMinutes !== undefined ? `${trade.holdingTimeMinutes}m` : '--'}
                                          </td>
                                          <td className="p-1.5 text-center">
                                            {trade.hitMfe15 ? (
                                              <span className="text-emerald-400 font-bold bg-emerald-950/80 px-1 py-0.2 rounded border border-emerald-600/40">
                                                ✓ ATINS
                                              </span>
                                            ) : (
                                              <span className="text-zinc-600">✕ Sub 1.5%</span>
                                            )}
                                          </td>
                                          <td className="p-1.5 text-center">
                                            {isFast ? (
                                              <span className="text-amber-300 font-bold bg-amber-950/70 px-1 py-0.2 rounded border border-amber-500/40 text-[9px]">
                                                ⚡ &le;5m
                                              </span>
                                            ) : trade.hitMfe15 ? (
                                              <span className="text-zinc-500 text-[9px]">&gt;5m</span>
                                            ) : (
                                              <span className="text-zinc-700 text-[9px]">--</span>
                                            )}
                                          </td>
                                          <td className="p-1.5 text-right text-zinc-500">
                                            {new Date(trade.exitTime).toLocaleTimeString()} {new Date(trade.exitTime).toLocaleDateString()}
                                          </td>
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* 4. Footer Note */}
      <div className="shrink-0 pt-2 border-t border-zinc-900 flex flex-wrap items-center justify-between text-[10px] text-zinc-500 gap-1.5">
        <div>
          🛡️ Multiplicator gradual continuu: <code className="text-amber-400">0.50x + (Hit-rate / 100) * 1.00</code>. Simetrie perfectă ±0.50x în jurul pragului neutru de 50%.
        </div>
        <div className="text-zinc-400">
          Afișate: <strong>{filteredStats.length}</strong> din <strong>{stats.length}</strong> simboluri monitorizate
        </div>
      </div>
    </div>
  );
};
