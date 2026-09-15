/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import { useEffect, useState } from 'react';
import { Activity, AlertTriangle, Play, ShieldAlert, ShieldCheck, PowerOff, Target, ArrowDownUp, Crosshair } from 'lucide-react';

export default function App() {
  const [status, setStatus] = useState<any>(null);
  const [logs, setLogs] = useState<any[]>([]);

  const fetchStatus = async () => {
    try {
      const res = await fetch('/api/bot/status');
      const data = await res.json();
      setStatus(data);
    } catch (err) {
      console.error(err);
    }
  };

  const fetchLogs = async () => {
    try {
      const res = await fetch('/api/bot/logs');
      const data = await res.json();
      setLogs(data);
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    fetchStatus();
    fetchLogs();
    const interval = setInterval(() => {
      fetchStatus();
      fetchLogs();
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  const toggleKillswitch = async () => {
    await fetch('/api/bot/killswitch', { method: 'POST' });
    fetchStatus();
  };

  const setProfile = async (profile: string) => {
    await fetch('/api/bot/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile }),
    });
    fetchStatus();
  };

  if (!status) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="animate-pulse flex flex-col items-center gap-4">
          <Activity className="w-8 h-8 text-slate-400" />
          <p className="text-slate-500 font-medium tracking-tight">Initializing TradeBot 5...</p>
        </div>
      </div>
    );
  }

  const { config, profileConfig, equity, positions } = status;
  const isKilled = config.killSwitchEngaged;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans p-6 md:p-12">
      <div className="max-w-6xl mx-auto space-y-8">
        
        {/* Header */}
        <header className="flex flex-col md:flex-row md:items-center justify-between gap-6 bg-white p-6 rounded-2xl shadow-sm border border-slate-100">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900 flex items-center gap-3">
              <Crosshair className="w-7 h-7 text-indigo-600" />
              TradeBot 5
            </h1>
            <p className="text-slate-500 mt-1">Centralized Execution & Momentum Engine</p>
          </div>
          <div className="flex items-center gap-4">
            <div className={`px-4 py-2 rounded-full font-medium text-sm border flex items-center gap-2 ${isKilled ? 'bg-red-50 text-red-700 border-red-200' : 'bg-emerald-50 text-emerald-700 border-emerald-200'}`}>
              {isKilled ? <ShieldAlert className="w-4 h-4" /> : <ShieldCheck className="w-4 h-4" />}
              {isKilled ? 'SYSTEM HALTED' : 'SYSTEM ACTIVE'}
            </div>
            <button
              onClick={toggleKillswitch}
              className={`px-6 py-2 rounded-full font-semibold text-sm transition-colors flex items-center gap-2 shadow-sm ${isKilled ? 'bg-emerald-600 text-white hover:bg-emerald-700' : 'bg-red-600 text-white hover:bg-red-700'}`}
            >
              <PowerOff className="w-4 h-4" />
              {isKilled ? 'ENGAGE SYSTEM' : 'KILL SWITCH'}
            </button>
          </div>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Left Column */}
          <div className="lg:col-span-1 space-y-8">
            
            {/* Account Info */}
            <section className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100">
              <h2 className="text-sm font-bold text-slate-400 uppercase tracking-wider mb-4">Account Status</h2>
              <div className="space-y-4">
                <div>
                  <p className="text-slate-500 text-sm">Estimated Equity</p>
                  <p className="text-4xl font-bold tracking-tight mt-1">${equity.toFixed(2)}</p>
                </div>
                <div className="flex items-center justify-between py-3 border-t border-slate-100">
                  <span className="text-slate-600 text-sm">Network</span>
                  <span className="font-medium px-2 py-1 bg-slate-100 rounded text-xs">{config.testnet ? 'TESTNET' : 'MAINNET'}</span>
                </div>
                <div className="flex items-center justify-between pt-1">
                  <span className="text-slate-600 text-sm">Open Positions</span>
                  <span className="font-medium">{positions.length} / {profileConfig.maxOpenPositions}</span>
                </div>
              </div>
            </section>

            {/* Profile Selector */}
            <section className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100">
              <h2 className="text-sm font-bold text-slate-400 uppercase tracking-wider mb-4">Active Profile</h2>
              <div className="flex bg-slate-100 rounded-xl p-1 mb-6">
                <button
                  onClick={() => setProfile('SCALP')}
                  className={`flex-1 py-2 text-sm font-semibold rounded-lg transition-colors ${config.activeProfile === 'SCALP' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                >
                  SCALP
                </button>
                <button
                  onClick={() => setProfile('MOMENTUM')}
                  className={`flex-1 py-2 text-sm font-semibold rounded-lg transition-colors ${config.activeProfile === 'MOMENTUM' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                >
                  MOMENTUM
                </button>
              </div>
              <div className="space-y-3">
                <div className="flex justify-between items-center text-sm">
                  <span className="text-slate-500">Risk per Trade</span>
                  <span className="font-medium text-slate-700">{profileConfig.riskPerTradePct}%</span>
                </div>
                <div className="flex justify-between items-center text-sm">
                  <span className="text-slate-500">Hard Stop Loss</span>
                  <span className="font-medium text-slate-700">{profileConfig.hardStopLossPct}%</span>
                </div>
                <div className="flex justify-between items-center text-sm">
                  <span className="text-slate-500">Trailing Start</span>
                  <span className="font-medium text-slate-700">{profileConfig.trailingActivationPct}%</span>
                </div>
                <div className="flex justify-between items-center text-sm">
                  <span className="text-slate-500">Timeframes</span>
                  <span className="font-medium text-slate-700">{profileConfig.timeframes.join(', ')}</span>
                </div>
              </div>
            </section>
          </div>

          {/* Right Column */}
          <div className="lg:col-span-2 space-y-8">
            
            {/* Active Positions */}
            <section className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100">
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-sm font-bold text-slate-400 uppercase tracking-wider">Active Positions</h2>
              </div>
              {positions.length === 0 ? (
                <div className="text-center py-12 text-slate-400">
                  <Target className="w-12 h-12 mx-auto mb-3 opacity-20" />
                  <p>No active positions currently.</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-slate-100 text-slate-400 text-xs uppercase tracking-wider">
                        <th className="pb-3 font-semibold">Symbol</th>
                        <th className="pb-3 font-semibold">Side</th>
                        <th className="pb-3 font-semibold">Entry</th>
                        <th className="pb-3 font-semibold">Size (USDT)</th>
                        <th className="pb-3 font-semibold text-right">PNL</th>
                      </tr>
                    </thead>
                    <tbody className="text-sm">
                      {positions.map((pos: any) => (
                        <tr key={pos.id} className="border-b border-slate-50 last:border-0">
                          <td className="py-4 font-bold text-slate-800">{pos.symbol}</td>
                          <td className="py-4">
                            <span className={`px-2 py-1 rounded text-xs font-bold ${pos.side === 'BUY' ? 'bg-emerald-50 text-emerald-600' : 'bg-rose-50 text-rose-600'}`}>
                              {pos.side}
                            </span>
                          </td>
                          <td className="py-4 font-mono text-slate-600">${pos.entryPrice.toFixed(4)}</td>
                          <td className="py-4 font-mono text-slate-600">${pos.sizeUSDT.toFixed(2)}</td>
                          <td className="py-4 font-mono text-right font-medium">
                            <span className={pos.pnlPct >= 0 ? 'text-emerald-600' : 'text-rose-600'}>
                              {pos.pnlPct >= 0 ? '+' : ''}{pos.pnlPct?.toFixed(2) || 0}%
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {/* Audit Logs */}
            <section className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100">
              <h2 className="text-sm font-bold text-slate-400 uppercase tracking-wider mb-6">Audit Logs</h2>
              <div className="space-y-4 max-h-[300px] overflow-y-auto pr-2">
                {logs.length === 0 ? (
                  <p className="text-slate-400 text-center py-6 text-sm">No logs recorded yet.</p>
                ) : (
                  logs.slice(0, 50).map((log, i) => (
                    <div key={log.id || i} className="flex gap-4 text-sm items-start">
                      <span className="font-mono text-slate-400 text-xs whitespace-nowrap mt-0.5">
                        {new Date(log.timestamp).toLocaleTimeString()}
                      </span>
                      <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider mt-0.5
                        ${log.type === 'SYSTEM' ? 'bg-slate-100 text-slate-500' : ''}
                        ${log.type === 'POSITION' ? 'bg-blue-50 text-blue-600' : ''}
                        ${log.type === 'ERROR' ? 'bg-rose-50 text-rose-600' : ''}
                      `}>
                        {log.type}
                      </span>
                      <p className="text-slate-700 leading-relaxed">{log.message}</p>
                    </div>
                  ))
                )}
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
