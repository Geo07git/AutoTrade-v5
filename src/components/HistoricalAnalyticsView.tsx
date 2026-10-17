import React, { useState, useEffect } from 'react';
import { Download, RefreshCw, BarChart2, Clock, Calendar, Globe, AlertCircle, Filter, TrendingUp } from 'lucide-react';

interface AnalyticsResponse {
  success: boolean;
  dataSource: string;
  daysAnalyzed: number;
  symbolsRequested: string[];
  results: Record<string, {
    symbol: string;
    observationsCount: number;
    isInsufficient: boolean;
    hourlyRank: Array<{
      hourUTC: number;
      hourRO: number;
      hourNY: number;
      observations: number;
      avgReturn: number;
      avgVolume: number;
      avgRvol: number;
      avgAtr: number;
      winRate: number;
    }>;
    dayRank: Array<{
      dayIndex: number;
      dayName: string;
      isWeekend: boolean;
      observations: number;
      avgReturn: number;
      avgVolume: number;
      avgRvol: number;
      avgAtr: number;
      winRate: number;
    }>;
    sessionRank: Array<{
      session: string;
      observations: number;
      avgReturn: number;
      avgVolume: number;
      avgRvol: number;
      avgAtr: number;
      winRate: number;
    }>;
    sampleCandles: Array<{
      ts: number;
      dateStr: string;
      close: number;
      volume: number;
      returnPct: number;
    }>;
    error?: string;
  }>;
}

export const HistoricalAnalyticsView: React.FC = () => {
  const [days, setDays] = useState<number>(30);
  const [selectedSymbol, setSelectedSymbol] = useState<string>('ALL');
  const [timezone, setTimezone] = useState<'UTC' | 'RO' | 'NY'>('RO');
  const [consecutiveHoursN, setConsecutiveHoursN] = useState<number>(4);
  const [loading, setLoading] = useState<boolean>(false);
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'HOURLY' | 'CONSECUTIVE' | 'DAYS' | 'SESSIONS' | 'COMBINED'>('HOURLY');

  const symbolsList = [
    'TRUMP-USD_UM_XPERP-310704',
    'LINK-USD_UM_XPERP-310523',
    'BTC-USD_UM_XPERP-310404',
    'ETH-USD_UM_XPERP-310516',
    'SOL-USD_UM_XPERP-310613'
  ];

  const fetchAnalytics = async () => {
    setLoading(true);
    setError(null);
    try {
      const syms = selectedSymbol === 'ALL' ? symbolsList.join(',') : selectedSymbol;
      const res = await fetch(`/api/bot/historical/analytics?days=${days}&symbols=${encodeURIComponent(syms)}`);
      const json = await res.json();
      if (json.success) {
        setData(json);
      } else {
        setError(json.error || 'Failed to fetch historical analytics');
      }
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAnalytics();
  }, [days, selectedSymbol]);

  const formatHour = (utcH: number) => {
    let h = utcH;
    if (timezone === 'RO') h = (utcH + 2) % 24;
    if (timezone === 'NY') h = (utcH + 19) % 24;
    return `${h.toString().padStart(2, '0')}:00 (${timezone})`;
  };

  const exportCSV = (filename: string, rows: object[]) => {
    if (!rows || rows.length === 0) return;
    const keys = Object.keys(rows[0]);
    const csvContent = [
      keys.join(','),
      ...rows.map(row => keys.map(k => JSON.stringify((row as any)[k] ?? '')).join(','))
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Aggregate hourly data across selected symbols if 'ALL'
  const getAggregatedHourly = () => {
    if (!data || !data.results) return [];
    const hourlyMap: Record<number, { count: number; retSum: number; volSum: number; rvolSum: number; atrSum: number; winSum: number }> = {};
    for (let h = 0; h < 24; h++) {
      hourlyMap[h] = { count: 0, retSum: 0, volSum: 0, rvolSum: 0, atrSum: 0, winSum: 0 };
    }

    const syms = Object.keys(data.results);
    let totalObs = 0;

    for (const sym of syms) {
      const res = data.results[sym];
      if (res.hourlyRank) {
        totalObs = res.observationsCount;
        for (const item of res.hourlyRank) {
          hourlyMap[item.hourUTC].count += 1;
          hourlyMap[item.hourUTC].retSum += item.avgReturn;
          hourlyMap[item.hourUTC].volSum += item.avgVolume;
          hourlyMap[item.hourUTC].rvolSum += item.avgRvol;
          hourlyMap[item.hourUTC].atrSum += item.avgAtr;
          hourlyMap[item.hourUTC].winSum += item.winRate;
        }
      }
    }

    const numSyms = syms.length || 1;
    return Object.keys(hourlyMap).map(hStr => {
      const h = parseInt(hStr, 10);
      const m = hourlyMap[h];
      return {
        hourUTC: h,
        hourFormatted: formatHour(h),
        observations: totalObs,
        avgReturn: parseFloat((m.retSum / numSyms).toFixed(4)),
        avgVolume: parseFloat((m.volSum / numSyms).toFixed(2)),
        avgRvol: parseFloat((m.rvolSum / numSyms).toFixed(2)),
        avgAtr: parseFloat((m.atrSum / numSyms).toFixed(4)),
        winRate: parseFloat((m.winSum / numSyms).toFixed(2)),
      };
    });
  };

  // Calculate Best N Consecutive Hours
  const getBestConsecutiveHours = (hourlyData: any[]) => {
    if (!hourlyData || hourlyData.length === 0) return [];
    const results = [];
    // hourlyData is sorted 0 to 23
    for (let i = 0; i < 24; i++) {
      let sumReturn = 0;
      let sumVolume = 0;
      let sumRvol = 0;
      const hoursWindow = [];
      for (let j = 0; j < consecutiveHoursN; j++) {
        const idx = (i + j) % 24;
        hoursWindow.push(hourlyData[idx].hourFormatted);
        sumReturn += hourlyData[idx].avgReturn;
        sumVolume += hourlyData[idx].avgVolume;
        sumRvol += hourlyData[idx].avgRvol;
      }
      results.push({
        windowStart: hoursWindow[0],
        windowEnd: hoursWindow[hoursWindow.length - 1],
        hoursList: hoursWindow.join(', '),
        totalReturn: parseFloat(sumReturn.toFixed(4)),
        avgVolume: parseFloat((sumVolume / consecutiveHoursN).toFixed(2)),
        avgRvol: parseFloat((sumRvol / consecutiveHoursN).toFixed(2)),
      });
    }
    results.sort((a, b) => b.totalReturn - a.totalReturn);
    return results;
  };

  const aggregatedHourly = getAggregatedHourly();
  const consecutiveRank = getBestConsecutiveHours(aggregatedHourly);

  return (
    <div className="h-full w-full bg-black text-amber-500 font-mono flex flex-col overflow-y-auto p-4 sm:p-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center border-b border-amber-500/30 pb-4 gap-4">
        <div>
          <div className="flex items-center space-x-2">
            <BarChart2 className="w-6 h-6 text-amber-400 animate-pulse" />
            <h1 className="text-xl sm:text-2xl font-bold tracking-wider uppercase text-amber-400">Historical Trading Analytics (OKX X-Perps)</h1>
          </div>
          <p className="text-xs text-amber-600 mt-1">
            Analiză statistică bazată pe date istorice reale OKX EEA (Lumina market candles) • Fără date simulate.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={fetchAnalytics}
            disabled={loading}
            className="flex items-center space-x-1.5 px-3 py-1.5 bg-amber-500/10 hover:bg-amber-500/25 border border-amber-500/40 rounded text-amber-400 text-xs transition"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>Actualizează</span>
          </button>
        </div>
      </div>

      {/* Controls Bar */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 bg-zinc-950/80 p-4 rounded-lg border border-amber-500/30">
        <div>
          <label className="block text-xs text-amber-600 mb-1">Perioada Analizei</label>
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="w-full bg-black border border-amber-500/40 rounded px-3 py-1.5 text-amber-400 text-xs focus:outline-none focus:border-amber-400"
          >
            <option value={7}>7 Zile</option>
            <option value={14}>14 Zile</option>
            <option value={30}>30 Zile (Verificat)</option>
            <option value={90}>90 Zile (Verificat)</option>
          </select>
        </div>

        <div>
          <label className="block text-xs text-amber-600 mb-1">Selecție Instrument</label>
          <select
            value={selectedSymbol}
            onChange={(e) => setSelectedSymbol(e.target.value)}
            className="w-full bg-black border border-amber-500/40 rounded px-3 py-1.5 text-amber-400 text-xs focus:outline-none focus:border-amber-400"
          >
            <option value="ALL">Toate X-Perps (Agregat)</option>
            {symbolsList.map(sym => (
              <option key={sym} value={sym}>{sym}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs text-amber-600 mb-1">Fus Orar</label>
          <select
            value={timezone}
            onChange={(e) => setTimezone(e.target.value as any)}
            className="w-full bg-black border border-amber-500/40 rounded px-3 py-1.5 text-amber-400 text-xs focus:outline-none focus:border-amber-400"
          >
            <option value="RO">Ora României (EET/EEST)</option>
            <option value="UTC">UTC (Coordinated Universal Time)</option>
            <option value="NY">Ora New York (EST/EDT)</option>
          </select>
        </div>

        <div>
          <label className="block text-xs text-amber-600 mb-1">Ore Consecutive (N)</label>
          <select
            value={consecutiveHoursN}
            onChange={(e) => setConsecutiveHoursN(Number(e.target.value))}
            className="w-full bg-black border border-amber-500/40 rounded px-3 py-1.5 text-amber-400 text-xs focus:outline-none focus:border-amber-400"
          >
            <option value={4}>4 Ore</option>
            <option value={6}>6 Ore</option>
            <option value={8}>8 Ore</option>
            <option value={12}>12 Ore</option>
            <option value={16}>16 Ore</option>
          </select>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex flex-wrap gap-2 border-b border-amber-500/20 pb-2">
        <button
          onClick={() => setActiveTab('HOURLY')}
          className={`px-4 py-2 rounded text-xs font-bold transition flex items-center space-x-1.5 ${
            activeTab === 'HOURLY' ? 'bg-amber-500 text-black shadow' : 'bg-zinc-900 text-amber-400 hover:bg-zinc-800 border border-amber-500/30'
          }`}
        >
          <Clock className="w-3.5 h-3.5" />
          <span>Clasament Ore (24h)</span>
        </button>
        <button
          onClick={() => setActiveTab('CONSECUTIVE')}
          className={`px-4 py-2 rounded text-xs font-bold transition flex items-center space-x-1.5 ${
            activeTab === 'CONSECUTIVE' ? 'bg-amber-500 text-black shadow' : 'bg-zinc-900 text-amber-400 hover:bg-zinc-800 border border-amber-500/30'
          }`}
        >
          <TrendingUp className="w-3.5 h-3.5" />
          <span>Ferestre Consecutive ({consecutiveHoursN}h)</span>
        </button>
        <button
          onClick={() => setActiveTab('DAYS')}
          className={`px-4 py-2 rounded text-xs font-bold transition flex items-center space-x-1.5 ${
            activeTab === 'DAYS' ? 'bg-amber-500 text-black shadow' : 'bg-zinc-900 text-amber-400 hover:bg-zinc-800 border border-amber-500/30'
          }`}
        >
          <Calendar className="w-3.5 h-3.5" />
          <span>Zilele Săptămânii</span>
        </button>
        <button
          onClick={() => setActiveTab('SESSIONS')}
          className={`px-4 py-2 rounded text-xs font-bold transition flex items-center space-x-1.5 ${
            activeTab === 'SESSIONS' ? 'bg-amber-500 text-black shadow' : 'bg-zinc-900 text-amber-400 hover:bg-zinc-800 border border-amber-500/30'
          }`}
        >
          <Globe className="w-3.5 h-3.5" />
          <span>Sesiuni Globale</span>
        </button>
      </div>

      {/* Main Content Area */}
      {loading ? (
        <div className="flex flex-col items-center justify-center py-20 space-y-4">
          <div className="w-8 h-8 border-2 border-amber-500 border-t-transparent rounded-full animate-spin"></div>
          <p className="text-xs text-amber-400 animate-pulse">Se colectează și se procesează datele istorice OKX EEA...</p>
        </div>
      ) : error ? (
        <div className="p-4 bg-red-950/40 border border-red-500/50 rounded flex items-center space-x-3 text-red-400 text-xs">
          <AlertCircle className="w-5 h-5 shrink-0" />
          <span>Eroare: {error}</span>
        </div>
      ) : data ? (
        <div className="space-y-6">
          {/* Metadata Card */}
          <div className="flex flex-wrap items-center justify-between bg-zinc-900/60 p-3 rounded border border-amber-500/20 text-xs">
            <div className="flex items-center space-x-4">
              <span className="text-amber-500 font-bold">Sursă: {data.dataSource}</span>
              <span className="text-amber-600">|</span>
              <span className="text-amber-400">Perioadă: Ultimele {data.daysAnalyzed} zile</span>
              <span className="text-amber-600">|</span>
              <span className="text-amber-400">Observații: {aggregatedHourly[0]?.observations || 0} bare orare</span>
            </div>
            <button
              onClick={() => {
                if (activeTab === 'HOURLY') exportCSV(`hourly_analytics_${selectedSymbol}.csv`, aggregatedHourly);
                else if (activeTab === 'CONSECUTIVE') exportCSV(`consecutive_${consecutiveHoursN}h_${selectedSymbol}.csv`, consecutiveRank);
                else if (activeTab === 'DAYS' && selectedSymbol !== 'ALL') {
                  const symRes = data.results[selectedSymbol];
                  exportCSV(`days_${selectedSymbol}.csv`, symRes?.dayRank || []);
                } else if (activeTab === 'SESSIONS' && selectedSymbol !== 'ALL') {
                  const symRes = data.results[selectedSymbol];
                  exportCSV(`sessions_${selectedSymbol}.csv`, symRes?.sessionRank || []);
                }
              }}
              className="flex items-center space-x-1 px-3 py-1 bg-amber-500 text-black font-bold rounded hover:bg-amber-400 transition"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Export CSV</span>
            </button>
          </div>

          {/* HOURLY TAB */}
          {activeTab === 'HOURLY' && (
            <div className="bg-zinc-950 border border-amber-500/30 rounded-lg overflow-hidden">
              <div className="p-3 bg-zinc-900/80 border-b border-amber-500/30 flex justify-between items-center">
                <h3 className="text-sm font-bold uppercase text-amber-400">Clasament Ore din Zi (00:00 - 23:00)</h3>
                <span className="text-xs text-amber-600">Sortat după Randament Mediu (%)</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-zinc-900 text-amber-500 uppercase tracking-wider border-b border-amber-500/20">
                    <tr>
                      <th className="p-3">Ora ({timezone})</th>
                      <th className="p-3 text-right">Randament Mediu (%)</th>
                      <th className="p-3 text-right">Win Rate (%)</th>
                      <th className="p-3 text-right">Volum Mediu ($)</th>
                      <th className="p-3 text-right">RVOL Mediu</th>
                      <th className="p-3 text-right">ATR Mediu ($)</th>
                      <th className="p-3 text-right">Observații</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-amber-500/10">
                    {[...aggregatedHourly].sort((a, b) => b.avgReturn - a.avgReturn).map((row, idx) => (
                      <tr key={row.hourUTC} className="hover:bg-amber-500/5 transition">
                        <td className="p-3 font-bold text-amber-300">
                          <span className="inline-block w-6 text-amber-600 text-[10px]">#{idx + 1}</span>
                          {row.hourFormatted}
                        </td>
                        <td className={`p-3 text-right font-bold ${row.avgReturn >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                          {row.avgReturn >= 0 ? '+' : ''}{row.avgReturn.toFixed(4)}%
                        </td>
                        <td className="p-3 text-right text-amber-300">{row.winRate.toFixed(1)}%</td>
                        <td className="p-3 text-right text-amber-400">${row.avgVolume.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                        <td className="p-3 text-right text-amber-300">{row.avgRvol.toFixed(2)}x</td>
                        <td className="p-3 text-right text-amber-400">${row.avgAtr.toFixed(4)}</td>
                        <td className="p-3 text-right text-amber-600">{row.observations}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* CONSECUTIVE HOURS TAB */}
          {activeTab === 'CONSECUTIVE' && (
            <div className="bg-zinc-950 border border-amber-500/30 rounded-lg overflow-hidden">
              <div className="p-3 bg-zinc-900/80 border-b border-amber-500/30 flex justify-between items-center">
                <h3 className="text-sm font-bold uppercase text-amber-400">Cele mai bune ferestre de {consecutiveHoursN} ore consecutive</h3>
                <span className="text-xs text-amber-600">Optimizare pentru intervale de scalping / day trading</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-zinc-900 text-amber-500 uppercase tracking-wider border-b border-amber-500/20">
                    <tr>
                      <th className="p-3">Fereastră Orară ({timezone})</th>
                      <th className="p-3">Include Orele</th>
                      <th className="p-3 text-right">Randament Cumulat (%)</th>
                      <th className="p-3 text-right">Volum Mediu ($)</th>
                      <th className="p-3 text-right">RVOL Mediu</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-amber-500/10">
                    {consecutiveRank.slice(0, 10).map((row, idx) => (
                      <tr key={idx} className="hover:bg-amber-500/5 transition">
                        <td className="p-3 font-bold text-amber-300">
                          <span className="inline-block w-6 text-amber-600 text-[10px]">#{idx + 1}</span>
                          {row.windowStart} ➔ {row.windowEnd}
                        </td>
                        <td className="p-3 text-amber-400 text-[11px]">{row.hoursList}</td>
                        <td className={`p-3 text-right font-bold ${row.totalReturn >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                          {row.totalReturn >= 0 ? '+' : ''}{row.totalReturn.toFixed(4)}%
                        </td>
                        <td className="p-3 text-right text-amber-400">${row.avgVolume.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                        <td className="p-3 text-right text-amber-300">{row.avgRvol.toFixed(2)}x</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* DAYS TAB */}
          {activeTab === 'DAYS' && (
            <div className="bg-zinc-950 border border-amber-500/30 rounded-lg overflow-hidden">
              <div className="p-3 bg-zinc-900/80 border-b border-amber-500/30 flex justify-between items-center">
                <h3 className="text-sm font-bold uppercase text-amber-400">Clasament Zilele Săptămânii</h3>
                <span className="text-xs text-amber-600">Lucrătoare vs Weekend</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-zinc-900 text-amber-500 uppercase tracking-wider border-b border-amber-500/20">
                    <tr>
                      <th className="p-3">Ziua Săptămânii</th>
                      <th className="p-3">Tip</th>
                      <th className="p-3 text-right">Randament Mediu (%)</th>
                      <th className="p-3 text-right">Win Rate (%)</th>
                      <th className="p-3 text-right">Volum Mediu ($)</th>
                      <th className="p-3 text-right">RVOL Mediu</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-amber-500/10">
                    {selectedSymbol !== 'ALL' && data.results[selectedSymbol]?.dayRank ? (
                      [...data.results[selectedSymbol].dayRank].sort((a, b) => b.avgReturn - a.avgReturn).map((row, idx) => (
                        <tr key={row.dayIndex} className="hover:bg-amber-500/5 transition">
                          <td className="p-3 font-bold text-amber-300">
                            <span className="inline-block w-6 text-amber-600 text-[10px]">#{idx + 1}</span>
                            {row.dayName}
                          </td>
                          <td className="p-3 text-amber-600">{row.isWeekend ? 'Weekend' : 'Zi Lucrătoare'}</td>
                          <td className={`p-3 text-right font-bold ${row.avgReturn >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                            {row.avgReturn >= 0 ? '+' : ''}{row.avgReturn.toFixed(4)}%
                          </td>
                          <td className="p-3 text-right text-amber-300">{row.winRate.toFixed(1)}%</td>
                          <td className="p-3 text-right text-amber-400">${row.avgVolume.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                          <td className="p-3 text-right text-amber-300">{row.avgRvol.toFixed(2)}x</td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td colSpan={6} className="p-6 text-center text-amber-600">
                          Selectați un singur asset din meniul sus pentru a vizualiza detaliul pe zile.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* SESSIONS TAB */}
          {activeTab === 'SESSIONS' && (
            <div className="bg-zinc-950 border border-amber-500/30 rounded-lg overflow-hidden">
              <div className="p-3 bg-zinc-900/80 border-b border-amber-500/30 flex justify-between items-center">
                <h3 className="text-sm font-bold uppercase text-amber-400">Sesiuni de Tranzacționare Globale</h3>
                <span className="text-xs text-amber-600">Asian, European, American</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-zinc-900 text-amber-500 uppercase tracking-wider border-b border-amber-500/20">
                    <tr>
                      <th className="p-3">Sesiune</th>
                      <th className="p-3 text-right">Randament Mediu (%)</th>
                      <th className="p-3 text-right">Win Rate (%)</th>
                      <th className="p-3 text-right">Volum Mediu ($)</th>
                      <th className="p-3 text-right">RVOL Mediu</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-amber-500/10">
                    {selectedSymbol !== 'ALL' && data.results[selectedSymbol]?.sessionRank ? (
                      [...data.results[selectedSymbol].sessionRank].sort((a, b) => b.avgReturn - a.avgReturn).map((row, idx) => (
                        <tr key={row.session} className="hover:bg-amber-500/5 transition">
                          <td className="p-3 font-bold text-amber-300">
                            <span className="inline-block w-6 text-amber-600 text-[10px]">#{idx + 1}</span>
                            {row.session}
                          </td>
                          <td className={`p-3 text-right font-bold ${row.avgReturn >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                            {row.avgReturn >= 0 ? '+' : ''}{row.avgReturn.toFixed(4)}%
                          </td>
                          <td className="p-3 text-right text-amber-300">{row.winRate.toFixed(1)}%</td>
                          <td className="p-3 text-right text-amber-400">${row.avgVolume.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                          <td className="p-3 text-right text-amber-300">{row.avgRvol.toFixed(2)}x</td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td colSpan={5} className="p-6 text-center text-amber-600">
                          Selectați un singur asset din meniul sus pentru a vizualiza detaliul pe sesiuni.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
};
