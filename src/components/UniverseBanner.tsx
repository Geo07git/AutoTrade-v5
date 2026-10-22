import React from 'react';
import { Scan, RefreshCw, Flame, ChevronRight, Activity, Globe } from 'lucide-react';
import { ScannerStats } from '../shared/types';

interface UniverseBannerProps {
  stats?: ScannerStats;
  onOpenScannerTab: () => void;
  onTriggerScan: () => Promise<void>;
  isScanningNow: boolean;
}

export const UniverseBanner: React.FC<UniverseBannerProps> = ({
  stats,
  onOpenScannerTab,
  onTriggerScan,
  isScanningNow,
}) => {
  const topOpportunities = (stats?.topOpportunities || []).slice(0, 5);

  return (
    <div className="bg-slate-900 border border-slate-800/90 rounded-xl p-4 shadow-md flex flex-col xl:flex-row xl:items-center justify-between gap-4">
      {/* Left: Dynamic Universe Key Stats */}
      <div className="flex flex-wrap items-center gap-4 sm:gap-6">
        {/* Dynamic Universe badge */}
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-indigo-950 border border-indigo-800/80 flex items-center justify-center text-indigo-400">
            <Globe className="w-4 h-4" />
          </div>
          <div>
            <div className="text-[10px] text-slate-400 uppercase tracking-wider font-semibold">
              Dynamic Universe
            </div>
            <div className="text-sm font-bold text-white flex items-center gap-1.5">
              <span>{stats?.universeCount || 0}</span>
              <span className="text-[11px] font-normal text-slate-400">symbols</span>
            </div>
          </div>
        </div>

        <div className="hidden sm:block h-6 w-px bg-slate-800" />

        {/* Scanning Count */}
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-indigo-400" />
          <div>
            <div className="text-[10px] text-slate-400 uppercase tracking-wider font-semibold">
              Scanning
            </div>
            <div className="text-sm font-bold text-indigo-300">
              {stats?.filteredCount || 0}{' '}
              <span className="text-[11px] font-normal text-slate-400">liquid pairs</span>
            </div>
          </div>
        </div>

        <div className="hidden sm:block h-6 w-px bg-slate-800" />

        {/* Candidates Count */}
        <div className="flex items-center gap-2">
          <Flame className="w-4 h-4 text-amber-400" />
          <div>
            <div className="text-[10px] text-slate-400 uppercase tracking-wider font-semibold">
              Candidates
            </div>
            <div className="text-sm font-bold text-amber-300">
              {stats?.candidatesCount || 0}{' '}
              <span className="text-[11px] font-normal text-slate-400">eligible</span>
            </div>
          </div>
        </div>

        <div className="hidden sm:block h-6 w-px bg-slate-800" />

        {/* Volume 24h Filter Window */}
        <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-slate-950 border border-emerald-900/60">
          <span className="text-[10px] text-slate-400 uppercase font-semibold">Vol 24h:</span>
          <span className="text-xs font-bold text-emerald-400 font-mono">
            [{(stats?.filterConfig ? stats.filterConfig.min24hVolumeUSDT / 1_000_000 : 0.5).toFixed(1)}M - {stats?.filterConfig?.max24hVolumeUSDT && stats.filterConfig.max24hVolumeUSDT > 0 ? `${(stats.filterConfig.max24hVolumeUSDT / 1_000_000).toFixed(1)}M` : '∞'}]
          </span>
        </div>
      </div>

      {/* Center/Right: Top Opportunities Ticker & Quick Actions */}
      <div className="flex flex-wrap items-center gap-3">
        {topOpportunities.length > 0 && (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold shrink-0">
              Top Ranked:
            </span>
            <div className="flex items-center gap-1.5 flex-wrap">
              {topOpportunities.map((opp) => (
                <button
                  key={opp.symbol}
                  onClick={onOpenScannerTab}
                  title={`Rank #${opp.rank} • Score: ${opp.score.toFixed(1)}/100 • RVOL: ${opp.rvol.toFixed(1)}x`}
                  className="px-2 py-1 rounded bg-slate-950 hover:bg-slate-800 border border-slate-800 text-xs font-mono flex items-center gap-1.5 transition-colors"
                >
                  <span className="font-bold text-white">{opp.symbol}</span>
                  <span
                    className={`text-[10px] font-bold px-1 rounded ${
                      opp.score >= 70
                        ? 'bg-emerald-950 text-emerald-400'
                        : opp.score >= 50
                        ? 'bg-amber-950 text-amber-400'
                        : 'bg-slate-800 text-slate-400'
                    }`}
                  >
                    {opp.score.toFixed(0)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={onTriggerScan}
            disabled={isScanningNow || stats?.isScanning}
            className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 border border-slate-700 text-xs font-semibold rounded-lg flex items-center gap-1.5 transition-colors"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${
                isScanningNow || stats?.isScanning ? 'animate-spin text-indigo-400' : ''
              }`}
            />
            <span>{isScanningNow || stats?.isScanning ? 'Scanning...' : 'Scan'}</span>
          </button>

          <button
            onClick={onOpenScannerTab}
            className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold rounded-lg flex items-center gap-1 transition-colors shadow-sm"
          >
            <Scan className="w-3.5 h-3.5" />
            <span>Open Scanner</span>
            <ChevronRight className="w-3.5 h-3.5 opacity-70" />
          </button>
        </div>
      </div>
    </div>
  );
};
