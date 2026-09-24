import React, { useState } from 'react';
import {
  Scan,
  TrendingUp,
  RefreshCw,
  Sliders,
  CheckCircle2,
  AlertCircle,
  ArrowUpRight,
  ArrowDownRight,
  Flame,
  Activity,
  Layers,
  Search,
} from 'lucide-react';
import { ScannerStats, ScannedOpportunity, UniverseFilterConfig } from '../shared/types';

interface MarketScannerViewProps {
  stats?: ScannerStats;
  onTriggerScan: () => Promise<void>;
  onUpdateFilter: (filter: Partial<UniverseFilterConfig>) => Promise<void>;
  isScanningNow: boolean;
}

export const MarketScannerView: React.FC<MarketScannerViewProps> = ({
  stats,
  onTriggerScan,
  onUpdateFilter,
  isScanningNow,
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [showConfig, setShowConfig] = useState(false);
  const [minVolInput, setMinVolInput] = useState<number>(
    stats?.filterConfig ? stats.filterConfig.min24hVolumeUSDT / 1_000_000 : 0.5
  );
  const [maxVolInput, setMaxVolInput] = useState<number>(
    stats?.filterConfig && stats.filterConfig.max24hVolumeUSDT && stats.filterConfig.max24hVolumeUSDT > 0
      ? stats.filterConfig.max24hVolumeUSDT / 1_000_000
      : 0
  );
  const [maxSymbolsInput, setMaxSymbolsInput] = useState<number>(
    stats?.filterConfig ? stats.filterConfig.maxSymbols : 50
  );
  const [filterSaving, setFilterSaving] = useState(false);

  const opportunities: ScannedOpportunity[] = stats?.topOpportunities || [];
  const filteredList = opportunities.filter((o) =>
    o.symbol.toLowerCase().includes(searchTerm.toLowerCase().trim())
  );

  const handleSaveFilter = async (e: React.FormEvent) => {
    e.preventDefault();
    setFilterSaving(true);
    try {
      await onUpdateFilter({
        min24hVolumeUSDT: minVolInput * 1_000_000,
        max24hVolumeUSDT: maxVolInput > 0 ? maxVolInput * 1_000_000 : 0,
        maxSymbols: maxSymbolsInput,
      });
      setShowConfig(false);
    } finally {
      setFilterSaving(false);
    }
  };

  const lastScanAgo = stats?.lastScanTimestamp
    ? `${Math.max(1, Math.round((Date.now() - stats.lastScanTimestamp) / 1000))}s ago`
    : 'Never';

  return (
    <div className="space-y-4">
      {/* Scanner Header Banner */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-lg space-y-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-indigo-950/80 border border-indigo-800/60 flex items-center justify-center text-indigo-400">
              <Scan className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-base font-bold text-white">Dynamic Market Scanner</h3>
                <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-indigo-950 text-indigo-300 border border-indigo-800/60">
                  OKX EEA USDT SWAP Perps
                </span>
                <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-emerald-950 text-emerald-300 border border-emerald-800/60">
                  Vol 24h: [{(stats?.filterConfig ? stats.filterConfig.min24hVolumeUSDT / 1_000_000 : 0.5).toFixed(1)}M - {stats?.filterConfig?.max24hVolumeUSDT && stats.filterConfig.max24hVolumeUSDT > 0 ? `${(stats.filterConfig.max24hVolumeUSDT / 1_000_000).toFixed(1)}M` : '∞'}]
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                Full-market dynamic discovery, liquidity scoring, and momentum candidate ranking
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2.5">
            <button
              onClick={() => setShowConfig(!showConfig)}
              className={`px-3 py-2 rounded-lg text-xs font-medium border flex items-center gap-1.5 transition-colors ${
                showConfig
                  ? 'bg-slate-700 text-white border-slate-600'
                  : 'bg-slate-800 hover:bg-slate-750 text-slate-300 border-slate-700'
              }`}
            >
              <Sliders className="w-3.5 h-3.5 text-slate-400" />
              <span>Filters</span>
            </button>

            <button
              onClick={onTriggerScan}
              disabled={isScanningNow || stats?.isScanning}
              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-bold text-xs rounded-lg transition-colors flex items-center gap-2 shadow-md shadow-indigo-950/40"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${
                  isScanningNow || stats?.isScanning ? 'animate-spin text-white' : ''
                }`}
              />
              <span>{isScanningNow || stats?.isScanning ? 'Scanning...' : 'Scan Now'}</span>
            </button>
          </div>
        </div>

        {/* Filter Configuration Drawer */}
        {showConfig && (
          <form
            onSubmit={handleSaveFilter}
            className="p-4 bg-slate-950/80 border border-slate-800 rounded-lg text-xs space-y-3"
          >
            <div className="font-bold text-slate-300 text-xs flex items-center gap-1.5">
              <Sliders className="w-3.5 h-3.5 text-indigo-400" />
              <span>Liquidity & Scan Parameters</span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-slate-400 mb-1">
                  Min 24h Turnover (M USDT, e.g. 1.0)
                </label>
                <input
                  type="number"
                  min="0.05"
                  step="0.1"
                  value={minVolInput}
                  onChange={(e) => setMinVolInput(parseFloat(e.target.value) || 0.5)}
                  className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white font-mono"
                />
              </div>
              <div>
                <label className="block text-slate-400 mb-1">
                  Max 24h Turnover (M USDT, 0 = no limit)
                </label>
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  value={maxVolInput}
                  onChange={(e) => setMaxVolInput(parseFloat(e.target.value) || 0)}
                  className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white font-mono"
                />
              </div>
              <div>
                <label className="block text-slate-400 mb-1">
                  Max Candidate Symbols to Scan
                </label>
                <input
                  type="number"
                  min="5"
                  max="500"
                  value={maxSymbolsInput}
                  onChange={(e) => setMaxSymbolsInput(parseInt(e.target.value, 10) || 50)}
                  className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white font-mono"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowConfig(false)}
                className="px-3 py-1.5 bg-slate-800 text-slate-300 hover:bg-slate-700 rounded-lg"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={filterSaving}
                className="px-3.5 py-1.5 bg-indigo-600 text-white font-bold hover:bg-indigo-500 rounded-lg"
              >
                {filterSaving ? 'Applying...' : 'Apply Filters'}
              </button>
            </div>
          </form>
        )}

        {/* 4 Quick Stat Pills */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-1 border-t border-slate-800/80">
          <div className="p-3 bg-slate-950/60 border border-slate-800 rounded-lg">
            <div className="text-slate-500 text-[11px] uppercase tracking-wider font-semibold flex items-center gap-1.5">
              <Layers className="w-3.5 h-3.5 text-blue-400" />
              <span>OKX Universe</span>
            </div>
            <div className="text-xl font-bold text-white mt-1">
              {stats?.universeCount || 0}{' '}
              <span className="text-xs font-normal text-slate-500">symbols</span>
            </div>
          </div>

          <div className="p-3 bg-slate-950/60 border border-slate-800 rounded-lg">
            <div className="text-slate-500 text-[11px] uppercase tracking-wider font-semibold flex items-center gap-1.5">
              <Activity className="w-3.5 h-3.5 text-indigo-400" />
              <span>Scanned / Liquid</span>
            </div>
            <div className="text-xl font-bold text-indigo-300 mt-1">
              {stats?.filteredCount || 0}{' '}
              <span className="text-xs font-normal text-slate-500">pairs</span>
            </div>
          </div>

          <div className="p-3 bg-slate-950/60 border border-slate-800 rounded-lg">
            <div className="text-slate-500 text-[11px] uppercase tracking-wider font-semibold flex items-center gap-1.5">
              <Flame className="w-3.5 h-3.5 text-amber-400" />
              <span>Candidates</span>
            </div>
            <div className="text-xl font-bold text-amber-300 mt-1">
              {stats?.candidatesCount || 0}{' '}
              <span className="text-xs font-normal text-slate-500">qualified</span>
            </div>
          </div>

          <div className="p-3 bg-slate-950/60 border border-slate-800 rounded-lg">
            <div className="text-slate-500 text-[11px] uppercase tracking-wider font-semibold flex items-center gap-1.5">
              <RefreshCw className="w-3.5 h-3.5 text-emerald-400" />
              <span>Last Scan</span>
            </div>
            <div className="text-sm font-bold text-slate-300 mt-1 font-mono">
              {stats?.lastScanDurationMs
                ? `${(stats.lastScanDurationMs / 1000).toFixed(1)}s (${lastScanAgo})`
                : 'Pending'}
            </div>
          </div>
        </div>
      </div>

      {/* Search and Table Container */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-lg">
        <div className="p-4 border-b border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold text-slate-300 uppercase tracking-wider">
              Ranked Opportunities ({filteredList.length})
            </span>
            <span className="text-[11px] text-slate-500">
              Sorted by Momentum Score descending
            </span>
          </div>

          <div className="relative w-full sm:w-64">
            <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              type="text"
              placeholder="Search symbol (e.g. BTC)..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-8 pr-3 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 font-mono"
            />
          </div>
        </div>

        {filteredList.length === 0 ? (
          <div className="p-12 text-center text-slate-500 space-y-2">
            <Scan className="w-10 h-10 mx-auto text-slate-600 opacity-40" />
            <p className="font-medium text-sm">No scanned opportunities currently cached.</p>
            <p className="text-xs text-slate-600">
              Click &quot;Scan Now&quot; above to poll the dynamic OKX EEA USDT SWAP universe and rank candidates.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="bg-slate-950/60 border-b border-slate-800 text-slate-400 uppercase tracking-wider font-semibold">
                  <th className="py-3 px-4 w-12 text-center">#</th>
                  <th className="py-3 px-4">Symbol</th>
                  <th className="py-3 px-4 text-right">Price</th>
                  <th className="py-3 px-4 text-right">24h Volume</th>
                  <th className="py-3 px-4 text-center">RVOL</th>
                  <th className="py-3 px-4 text-center">ATR Exp</th>
                  <th className="py-3 px-4">Momentum Score</th>
                  <th className="py-3 px-4 text-center">Signal</th>
                  <th className="py-3 px-4 text-center">Pipeline</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800 font-mono">
                {filteredList.map((opp) => {
                  const isTop3 = opp.rank <= 3;
                  const isBullish = opp.signal?.side === 'BUY';
                  const isBearish = opp.signal?.side === 'SELL';
                  const volFormatted = opp.volume24hUSDT
                    ? `$${(opp.volume24hUSDT / 1_000_000).toFixed(1)}M`
                    : 'N/A';

                  return (
                    <tr
                      key={opp.symbol}
                      className={`hover:bg-slate-850/50 transition-colors ${
                        opp.isEligible ? 'bg-indigo-950/10' : ''
                      }`}
                    >
                      {/* Rank */}
                      <td className="py-3 px-4 text-center">
                        <span
                          className={`inline-block px-1.5 py-0.5 rounded text-[11px] font-bold ${
                            isTop3
                              ? 'bg-amber-950 text-amber-300 border border-amber-800/80'
                              : 'text-slate-500'
                          }`}
                        >
                          #{opp.rank}
                        </span>
                      </td>

                      {/* Symbol */}
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-white text-xs">{opp.symbol}</span>
                          {opp.priceChange24hPct !== undefined && (
                            <span
                              className={`text-[10px] flex items-center ${
                                opp.priceChange24hPct >= 0
                                  ? 'text-emerald-400'
                                  : 'text-rose-400'
                              }`}
                            >
                              {opp.priceChange24hPct >= 0 ? '+' : ''}
                              {opp.priceChange24hPct.toFixed(1)}%
                            </span>
                          )}
                        </div>
                      </td>

                      {/* Price */}
                      <td className="py-3 px-4 text-right text-slate-200">
                        ${opp.price >= 1 ? opp.price.toFixed(2) : opp.price.toFixed(4)}
                      </td>

                      {/* 24h Volume */}
                      <td className="py-3 px-4 text-right text-slate-300 font-semibold">
                        {volFormatted}
                      </td>

                      {/* RVOL */}
                      <td className="py-3 px-4 text-center">
                        <span
                          className={`px-1.5 py-0.5 rounded text-[11px] font-semibold ${
                            opp.rvol >= 1.5
                              ? 'bg-emerald-950 text-emerald-300 border border-emerald-800/60'
                              : 'text-slate-400'
                          }`}
                        >
                          {opp.rvol.toFixed(2)}x
                        </span>
                      </td>

                      {/* ATR Exp */}
                      <td className="py-3 px-4 text-center">
                        <span
                          className={`px-1.5 py-0.5 rounded text-[11px] ${
                            opp.atrExpansion >= 1.2
                              ? 'text-indigo-300 font-bold'
                              : 'text-slate-400'
                          }`}
                        >
                          {opp.atrExpansion.toFixed(2)}x
                        </span>
                      </td>

                      {/* Momentum Score Bar */}
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-2">
                          <div className="w-16 bg-slate-800 rounded-full h-1.5 overflow-hidden">
                            <div
                              className={`h-full rounded-full ${
                                opp.score >= 70
                                  ? 'bg-emerald-500'
                                  : opp.score >= 50
                                  ? 'bg-amber-500'
                                  : 'bg-slate-600'
                              }`}
                              style={{ width: `${Math.min(100, Math.max(0, opp.score))}%` }}
                            />
                          </div>
                          <span
                            className={`font-bold text-xs ${
                              opp.score >= 70
                                ? 'text-emerald-400'
                                : opp.score >= 50
                                ? 'text-amber-400'
                                : 'text-slate-400'
                            }`}
                          >
                            {opp.score.toFixed(1)}
                          </span>
                        </div>
                      </td>

                      {/* Signal */}
                      <td className="py-3 px-4 text-center">
                        {opp.signal ? (
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase inline-flex items-center gap-1 ${
                              isBullish
                                ? 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                                : isBearish
                                ? 'bg-rose-950 text-rose-300 border border-rose-800'
                                : 'bg-slate-800 text-slate-400'
                            }`}
                          >
                            {isBullish ? (
                              <ArrowUpRight className="w-3 h-3 text-emerald-400" />
                            ) : (
                              <ArrowDownRight className="w-3 h-3 text-rose-400" />
                            )}
                            {opp.signal.side}
                          </span>
                        ) : (
                          <span className="text-[10px] text-slate-500">NONE</span>
                        )}
                      </td>

                      {/* Eligibility Status */}
                      <td className="py-3 px-4 text-center">
                        {opp.isEligible ? (
                          <span
                            title="Meets all momentum & liquidity thresholds for candidate entry"
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-950/80 text-emerald-300 border border-emerald-800/80"
                          >
                            <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                            <span>ELIGIBLE</span>
                          </span>
                        ) : opp.score > 82 ? (
                          <span 
                            title="Semnal respins de regula Anti-Exhaustion: Scorul depășește tavanul de siguranță (max 82/85)"
                            className="text-[10px] px-2 py-0.5 rounded text-rose-400 bg-rose-950/80 border border-rose-800/80 font-bold inline-flex items-center gap-1"
                          >
                            <AlertCircle className="w-3 h-3 text-rose-400" />
                            <span>BLOCKED (&gt;82)</span>
                          </span>
                        ) : (
                          <span className="text-[10px] text-slate-600 font-semibold">
                            FILTERED
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
