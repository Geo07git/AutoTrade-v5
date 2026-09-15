/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import React, { useEffect, useState } from 'react';
import {
  Activity,
  ShieldAlert,
  ShieldCheck,
  PowerOff,
  Target,
  Crosshair,
  RefreshCw,
  Key,
  CheckCircle2,
  XCircle,
  Clock,
  Radio,
  FileText,
  AlertOctagon,
  ArrowRight,
} from 'lucide-react';
import { BotStatusResponse, AuditLog, OrderRecord, Position } from './shared/types';

export default function App() {
  const [status, setStatus] = useState<BotStatusResponse | null>(null);
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [orders, setOrders] = useState<OrderRecord[]>([]);
  const [activeTab, setActiveTab] = useState<'positions' | 'orders' | 'logs'>('positions');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isReconciling, setIsReconciling] = useState<boolean>(false);
  const [showConfigModal, setShowConfigModal] = useState<boolean>(false);

  // API credentials form state
  const [apiKeyInput, setApiKeyInput] = useState<string>('');
  const [apiSecretInput, setApiSecretInput] = useState<string>('');
  const [isTestnet, setIsTestnet] = useState<boolean>(true);
  const [credSaving, setCredSaving] = useState<boolean>(false);

  const fetchStatus = async () => {
    try {
      const res = await fetch('/api/bot/status');
      if (res.ok) {
        const data: BotStatusResponse = await res.json();
        setStatus(data);
      }
    } catch (err) {
      console.error('Error fetching status:', err);
    }
  };

  const fetchLogs = async () => {
    try {
      const res = await fetch('/api/bot/logs');
      if (res.ok) {
        const data = await res.json();
        setLogs(data);
      }
    } catch (err) {
      console.error('Error fetching logs:', err);
    }
  };

  const fetchOrders = async () => {
    try {
      const res = await fetch('/api/bot/orders');
      if (res.ok) {
        const data = await res.json();
        setOrders(data);
      }
    } catch (err) {
      console.error('Error fetching orders:', err);
    }
  };

  useEffect(() => {
    fetchStatus();
    fetchLogs();
    fetchOrders();

    const interval = setInterval(() => {
      fetchStatus();
      fetchLogs();
      fetchOrders();
    }, 4000);

    return () => clearInterval(interval);
  }, []);

  const toggleKillswitch = async () => {
    try {
      setErrorMessage(null);
      await fetch('/api/bot/killswitch', { method: 'POST' });
      await fetchStatus();
      await fetchLogs();
      await fetchOrders();
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to toggle Kill Switch');
    }
  };

  const setProfile = async (profile: 'SCALP' | 'MOMENTUM') => {
    setErrorMessage(null);
    try {
      const res = await fetch('/api/bot/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMessage(data.error || 'Failed to switch profile');
      } else {
        await fetchStatus();
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to switch profile');
    }
  };

  const triggerReconcile = async () => {
    setIsReconciling(true);
    setErrorMessage(null);
    try {
      const res = await fetch('/api/bot/reconcile', { method: 'POST' });
      const data = await res.json();
      if (data.status) {
        setStatus(data.status);
      }
      await fetchLogs();
      await fetchOrders();
    } catch (err: any) {
      setErrorMessage(err.message || 'Reconciliation failed');
    } finally {
      setIsReconciling(false);
    }
  };

  const handleSaveCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!apiKeyInput.trim() || !apiSecretInput.trim()) {
      setErrorMessage('Please provide both API Key and Secret');
      return;
    }
    setCredSaving(true);
    setErrorMessage(null);
    try {
      const res = await fetch('/api/bot/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKey: apiKeyInput.trim(),
          apiSecret: apiSecretInput.trim(),
          testnet: isTestnet,
        }),
      });
      if (res.ok) {
        setShowConfigModal(false);
        setApiKeyInput('');
        setApiSecretInput('');
        await fetchStatus();
        await fetchLogs();
      } else {
        const data = await res.json();
        setErrorMessage(data.error || 'Failed to update credentials');
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Error updating credentials');
    } finally {
      setCredSaving(false);
    }
  };

  if (!status) {
    return (
      <div className="min-h-screen bg-slate-900 text-slate-100 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <Activity className="w-8 h-8 text-indigo-400 animate-spin" />
          <p className="text-slate-400 font-medium">Connecting to TradeBot 5 Engine...</p>
        </div>
      </div>
    );
  }

  const { state, config, profileConfig, equity, positions } = status;
  const isKilled = config.killSwitchEngaged;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans p-4 md:p-8">
      <div className="max-w-7xl mx-auto space-y-6">
        
        {/* Error Notification Banner */}
        {errorMessage && (
          <div className="bg-rose-950 border border-rose-800 text-rose-200 px-4 py-3 rounded-xl flex items-center justify-between text-sm">
            <div className="flex items-center gap-2">
              <AlertOctagon className="w-5 h-5 text-rose-400 shrink-0" />
              <span>{errorMessage}</span>
            </div>
            <button
              onClick={() => setErrorMessage(null)}
              className="text-rose-400 hover:text-rose-200 text-xs uppercase font-bold"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Top Header */}
        <header className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-slate-900/90 border border-slate-800/80 backdrop-blur p-6 rounded-2xl shadow-xl">
          <div>
            <div className="flex items-center gap-3">
              <div className="p-2.5 bg-indigo-500/10 border border-indigo-500/20 rounded-xl">
                <Crosshair className="w-6 h-6 text-indigo-400" />
              </div>
              <div>
                <div className="flex items-center gap-3">
                  <h1 className="text-2xl font-bold tracking-tight text-white">TradeBot 5</h1>
                  <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-indigo-950 text-indigo-300 border border-indigo-800/50">
                    Bybit Testnet
                  </span>
                </div>
                <p className="text-slate-400 text-sm mt-0.5">
                  Disciplined Momentum Engine & Real Bybit Order Manager
                </p>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {/* Bot State Badge */}
            <div
              className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold uppercase tracking-wider flex items-center gap-2 border ${
                state === 'TRADING'
                  ? 'bg-emerald-950/60 text-emerald-300 border-emerald-800/60'
                  : state === 'WAITING_FOR_EXCHANGE'
                  ? 'bg-amber-950/60 text-amber-300 border-amber-800/60'
                  : state === 'READY'
                  ? 'bg-blue-950/60 text-blue-300 border-blue-800/60'
                  : 'bg-rose-950/60 text-rose-300 border-rose-800/60'
              }`}
            >
              <Radio className={`w-3.5 h-3.5 ${state === 'TRADING' ? 'animate-pulse text-emerald-400' : ''}`} />
              <span>{state.replace(/_/g, ' ')}</span>
            </div>

            {/* Reconcile Button */}
            <button
              onClick={triggerReconcile}
              disabled={isReconciling}
              title="Reconcile local state with real Bybit positions and equity"
              className="px-3.5 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg text-xs font-medium flex items-center gap-2 transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isReconciling ? 'animate-spin text-indigo-400' : ''}`} />
              <span>Reconcile</span>
            </button>

            {/* Bybit Credentials Modal trigger */}
            <button
              onClick={() => setShowConfigModal(true)}
              className="px-3.5 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg text-xs font-medium flex items-center gap-2 transition-colors"
            >
              <Key className="w-3.5 h-3.5 text-slate-400" />
              <span>API Keys</span>
            </button>

            {/* Kill Switch Toggle Button */}
            <button
              onClick={toggleKillswitch}
              className={`px-5 py-2 rounded-lg font-bold text-xs uppercase tracking-wider transition-all flex items-center gap-2 shadow-lg ${
                isKilled
                  ? 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-emerald-900/30'
                  : 'bg-rose-600 hover:bg-rose-500 text-white shadow-rose-900/30'
              }`}
            >
              <PowerOff className="w-4 h-4" />
              <span>{isKilled ? 'DISENGAGE KILL SWITCH' : 'ENGAGE KILL SWITCH'}</span>
            </button>
          </div>
        </header>

        {/* Status Notice if Waiting for Keys */}
        {state === 'WAITING_FOR_EXCHANGE' && (
          <div className="bg-amber-950/40 border border-amber-800/50 p-4 rounded-xl flex flex-col md:flex-row items-start md:items-center justify-between gap-3 text-amber-200 text-sm">
            <div className="flex items-center gap-2">
              <ShieldAlert className="w-5 h-5 text-amber-400 shrink-0" />
              <span>
                <strong>Waiting for Bybit connection:</strong> Private Testnet trading requires API credentials. Configure your Bybit Testnet key to enable order execution and position sync.
              </span>
            </div>
            <button
              onClick={() => setShowConfigModal(true)}
              className="px-4 py-1.5 bg-amber-600 hover:bg-amber-500 text-slate-950 font-bold text-xs rounded-lg whitespace-nowrap transition-colors"
            >
              Configure Keys
            </button>
          </div>
        )}

        {/* Key Metrics Row */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          
          {/* Real Bybit Equity */}
          <div className="bg-slate-900 border border-slate-800 p-5 rounded-xl">
            <div className="flex items-center justify-between text-slate-400 text-xs uppercase tracking-wider font-semibold">
              <span>Bybit USDT Equity</span>
              <Activity className="w-4 h-4 text-slate-500" />
            </div>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-3xl font-bold tracking-tight text-white">
                ${equity.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
              <span className="text-xs text-slate-500">USDT</span>
            </div>
            <p className="text-slate-500 text-xs mt-2">Single shared capital on Bybit</p>
          </div>

          {/* Active Profile */}
          <div className="bg-slate-900 border border-slate-800 p-5 rounded-xl">
            <div className="flex items-center justify-between text-slate-400 text-xs uppercase tracking-wider font-semibold">
              <span>Execution Profile</span>
              <Target className="w-4 h-4 text-indigo-400" />
            </div>
            <div className="mt-2 flex items-center gap-2">
              <span className="text-xl font-bold text-indigo-300">{profileConfig.type}</span>
              <span className="text-xs px-2 py-0.5 bg-slate-800 text-slate-400 rounded">
                TF: {profileConfig.timeframes.join(', ')}m
              </span>
            </div>
            <p className="text-slate-500 text-xs mt-2">
              Risk: {profileConfig.riskPerTradePct}% / Hard SL: {profileConfig.hardStopLossPct}%
            </p>
          </div>

          {/* Open Positions Count */}
          <div className="bg-slate-900 border border-slate-800 p-5 rounded-xl">
            <div className="flex items-center justify-between text-slate-400 text-xs uppercase tracking-wider font-semibold">
              <span>Open Positions</span>
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
            </div>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-3xl font-bold text-white">{positions.length}</span>
              <span className="text-xs text-slate-500">/ {profileConfig.maxOpenPositions} Max</span>
            </div>
            <p className="text-slate-500 text-xs mt-2">Source of truth: Bybit Linear</p>
          </div>

          {/* Kill Switch Status */}
          <div className="bg-slate-900 border border-slate-800 p-5 rounded-xl">
            <div className="flex items-center justify-between text-slate-400 text-xs uppercase tracking-wider font-semibold">
              <span>Emergency State</span>
              {isKilled ? <ShieldAlert className="w-4 h-4 text-rose-400" /> : <ShieldCheck className="w-4 h-4 text-emerald-400" />}
            </div>
            <div className="mt-2">
              <span
                className={`inline-block px-2.5 py-1 rounded text-xs font-bold uppercase tracking-wider ${
                  isKilled ? 'bg-rose-950 text-rose-300 border border-rose-800' : 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                }`}
              >
                {isKilled ? 'Kill Switch Engaged' : 'Normal Execution'}
              </span>
            </div>
            <p className="text-slate-500 text-xs mt-2">
              {isKilled ? 'Entries blocked; positions closed' : 'Order Manager active'}
            </p>
          </div>
        </div>

        {/* Main Grid: Profiles & Execution Controls vs Tables */}
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
          
          {/* Left Column: Profile Switcher & Risk Engine Specs */}
          <div className="lg:col-span-1 space-y-6">
            
            {/* Profile Selection (Mutually Exclusive) */}
            <div className="bg-slate-900 border border-slate-800 p-5 rounded-xl space-y-4">
              <h2 className="text-xs font-bold text-slate-400 uppercase tracking-wider">
                Select Profile
              </h2>
              <div className="grid grid-cols-2 gap-2 bg-slate-950 p-1 rounded-lg border border-slate-800">
                <button
                  onClick={() => setProfile('SCALP')}
                  className={`py-2 px-3 text-xs font-bold rounded-md transition-all ${
                    config.activeProfile === 'SCALP'
                      ? 'bg-indigo-600 text-white shadow-md'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  SCALP
                </button>
                <button
                  onClick={() => setProfile('MOMENTUM')}
                  className={`py-2 px-3 text-xs font-bold rounded-md transition-all ${
                    config.activeProfile === 'MOMENTUM'
                      ? 'bg-indigo-600 text-white shadow-md'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  MOMENTUM
                </button>
              </div>

              {positions.length > 0 && (
                <p className="text-[11px] text-amber-400/80 leading-tight">
                  ℹ️ Profile switching is locked while positions are open ({positions.length} active).
                </p>
              )}

              <div className="space-y-2.5 pt-2 border-t border-slate-800 text-xs">
                <div className="flex justify-between items-center">
                  <span className="text-slate-500">Risk Allocation</span>
                  <span className="font-semibold text-slate-300">{profileConfig.riskPerTradePct}% / trade</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-slate-500">Max Open Positions</span>
                  <span className="font-semibold text-slate-300">{profileConfig.maxOpenPositions}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-slate-500">Hard Stop Loss</span>
                  <span className="font-semibold text-rose-400">-{profileConfig.hardStopLossPct}%</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-slate-500">Trailing Activation</span>
                  <span className="font-semibold text-emerald-400">+{profileConfig.trailingActivationPct}%</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-slate-500">Trailing Distance</span>
                  <span className="font-semibold text-slate-300">{profileConfig.trailingDistancePct}%</span>
                </div>
              </div>
            </div>

            {/* Architecture Flow Diagram */}
            <div className="bg-slate-900 border border-slate-800 p-5 rounded-xl space-y-3">
              <h2 className="text-xs font-bold text-slate-400 uppercase tracking-wider">
                Execution Pipeline
              </h2>
              <div className="space-y-2 text-xs font-mono">
                <div className="p-2 bg-slate-950 border border-slate-800 rounded flex items-center justify-between text-slate-300">
                  <span>1. Market Data</span>
                  <span className="text-[10px] text-indigo-400">Bybit REST/WS</span>
                </div>
                <div className="text-center text-slate-600">↓</div>
                <div className="p-2 bg-slate-950 border border-slate-800 rounded flex items-center justify-between text-slate-300">
                  <span>2. Momentum Engine</span>
                  <span className="text-[10px] text-indigo-400">Score &gt; {config.activeProfile === 'SCALP' ? 65 : 60}</span>
                </div>
                <div className="text-center text-slate-600">↓</div>
                <div className="p-2 bg-slate-950 border border-slate-800 rounded flex items-center justify-between text-slate-300">
                  <span>3. Risk Engine</span>
                  <span className="text-[10px] text-emerald-400">Mandatory Gate</span>
                </div>
                <div className="text-center text-slate-600">↓</div>
                <div className="p-2 bg-slate-950 border border-slate-800 rounded flex items-center justify-between text-slate-300">
                  <span>4. Order Manager</span>
                  <span className="text-[10px] text-amber-400">Lifecycle & Fill</span>
                </div>
                <div className="text-center text-slate-600">↓</div>
                <div className="p-2 bg-slate-950 border border-slate-800 rounded flex items-center justify-between text-slate-300">
                  <span>5. Position Manager</span>
                  <span className="text-[10px] text-blue-400">Bybit Reconciled</span>
                </div>
              </div>
            </div>

          </div>

          {/* Right Column: Tabbed Views (Positions / Order Lifecycle / Audit Logs) */}
          <div className="lg:col-span-3 space-y-4">
            
            {/* View Navigation Tabs */}
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setActiveTab('positions')}
                  className={`px-4 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider transition-colors flex items-center gap-2 ${
                    activeTab === 'positions'
                      ? 'bg-indigo-600 text-white shadow'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <Target className="w-3.5 h-3.5" />
                  <span>Active Positions ({positions.length})</span>
                </button>

                <button
                  onClick={() => setActiveTab('orders')}
                  className={`px-4 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider transition-colors flex items-center gap-2 ${
                    activeTab === 'orders'
                      ? 'bg-indigo-600 text-white shadow'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <FileText className="w-3.5 h-3.5" />
                  <span>Order Lifecycle ({orders.length})</span>
                </button>

                <button
                  onClick={() => setActiveTab('logs')}
                  className={`px-4 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider transition-colors flex items-center gap-2 ${
                    activeTab === 'logs'
                      ? 'bg-indigo-600 text-white shadow'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <Activity className="w-3.5 h-3.5" />
                  <span>Audit Trail ({logs.length})</span>
                </button>
              </div>

              <div className="text-[11px] text-slate-500 font-mono">
                Auto-refreshing: 4s
              </div>
            </div>

            {/* TAB 1: Positions */}
            {activeTab === 'positions' && (
              <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-lg">
                {positions.length === 0 ? (
                  <div className="p-12 text-center text-slate-500 space-y-2">
                    <Target className="w-10 h-10 mx-auto text-slate-600 opacity-40" />
                    <p className="font-medium text-sm">No open positions on Bybit.</p>
                    <p className="text-xs text-slate-600">
                      Signals evaluated by Momentum Engine will be validated by Risk Engine and executed through Order Manager.
                    </p>
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs border-collapse">
                      <thead>
                        <tr className="bg-slate-950/60 border-b border-slate-800 text-slate-400 uppercase tracking-wider font-semibold">
                          <th className="py-3.5 px-4">Symbol</th>
                          <th className="py-3.5 px-4">Side</th>
                          <th className="py-3.5 px-4">Qty</th>
                          <th className="py-3.5 px-4">Entry Price</th>
                          <th className="py-3.5 px-4">Size (USDT)</th>
                          <th className="py-3.5 px-4">Unrealized PnL</th>
                          <th className="py-3.5 px-4 text-right">Source</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800 font-mono">
                        {positions.map((pos) => {
                          const isProfit = (pos.pnlPct || 0) >= 0;
                          return (
                            <tr key={pos.id} className="hover:bg-slate-850/50 transition-colors">
                              <td className="py-3.5 px-4 font-bold text-white">{pos.symbol}</td>
                              <td className="py-3.5 px-4">
                                <span
                                  className={`px-2 py-0.5 rounded text-[11px] font-bold ${
                                    pos.side === 'BUY'
                                      ? 'bg-emerald-950 text-emerald-400 border border-emerald-800/60'
                                      : 'bg-rose-950 text-rose-400 border border-rose-800/60'
                                  }`}
                                >
                                  {pos.side}
                                </span>
                              </td>
                              <td className="py-3.5 px-4 text-slate-300">{pos.qty}</td>
                              <td className="py-3.5 px-4 text-slate-300">${pos.entryPrice.toFixed(4)}</td>
                              <td className="py-3.5 px-4 text-slate-300">${pos.sizeUSDT.toFixed(2)}</td>
                              <td className="py-3.5 px-4 font-semibold">
                                <span className={isProfit ? 'text-emerald-400' : 'text-rose-400'}>
                                  {isProfit ? '+' : ''}{pos.pnlPct?.toFixed(2) || '0.00'}%
                                  {pos.pnl !== undefined && ` ($${pos.pnl.toFixed(2)})`}
                                </span>
                              </td>
                              <td className="py-3.5 px-4 text-right">
                                <span className="px-1.5 py-0.5 text-[10px] bg-slate-800 text-slate-400 rounded">
                                  {pos.source}
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {/* TAB 2: Order Lifecycle */}
            {activeTab === 'orders' && (
              <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-lg">
                {orders.length === 0 ? (
                  <div className="p-12 text-center text-slate-500 space-y-2">
                    <FileText className="w-10 h-10 mx-auto text-slate-600 opacity-40" />
                    <p className="font-medium text-sm">No orders executed yet.</p>
                    <p className="text-xs text-slate-600">
                      Every order lifecycle step (CREATED → SUBMITTED → ACCEPTED → FILLED) will be recorded here.
                    </p>
                  </div>
                ) : (
                  <div className="overflow-x-auto max-h-[500px]">
                    <table className="w-full text-left text-xs border-collapse">
                      <thead>
                        <tr className="bg-slate-950/60 border-b border-slate-800 text-slate-400 uppercase tracking-wider font-semibold sticky top-0">
                          <th className="py-3 px-4">Time</th>
                          <th className="py-3 px-4">Symbol</th>
                          <th className="py-3 px-4">Intent</th>
                          <th className="py-3 px-4">Side</th>
                          <th className="py-3 px-4">Qty</th>
                          <th className="py-3 px-4">Status</th>
                          <th className="py-3 px-4">Fill Price</th>
                          <th className="py-3 px-4 text-right">Order ID</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800 font-mono">
                        {orders.map((ord) => {
                          const statusColor =
                            ord.status === 'FILLED'
                              ? 'bg-emerald-950 text-emerald-400 border-emerald-800'
                              : ord.status === 'ACCEPTED' || ord.status === 'SUBMITTED'
                              ? 'bg-blue-950 text-blue-400 border-blue-800'
                              : ord.status === 'PARTIALLY_FILLED'
                              ? 'bg-amber-950 text-amber-400 border-amber-800'
                              : 'bg-rose-950 text-rose-400 border-rose-800';

                          return (
                            <tr key={ord.id} className="hover:bg-slate-850/50 transition-colors">
                              <td className="py-3 px-4 text-slate-400 text-[11px]">
                                {new Date(ord.createdTime).toLocaleTimeString()}
                              </td>
                              <td className="py-3 px-4 font-bold text-white">{ord.symbol}</td>
                              <td className="py-3 px-4 text-slate-300">
                                <span className="px-1.5 py-0.5 text-[10px] bg-slate-800 text-slate-300 rounded font-sans font-medium">
                                  {ord.intent}
                                </span>
                              </td>
                              <td className="py-3 px-4">
                                <span
                                  className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                                    ord.side === 'BUY' ? 'text-emerald-400' : 'text-rose-400'
                                  }`}
                                >
                                  {ord.side}
                                </span>
                              </td>
                              <td className="py-3 px-4 text-slate-300">{ord.qty}</td>
                              <td className="py-3 px-4">
                                <span className={`px-2 py-0.5 rounded text-[10px] font-bold border uppercase tracking-wider ${statusColor}`}>
                                  {ord.status}
                                </span>
                              </td>
                              <td className="py-3 px-4 text-slate-300">
                                {ord.fillPrice ? `$${ord.fillPrice.toFixed(4)}` : '—'}
                              </td>
                              <td className="py-3 px-4 text-right text-slate-500 text-[10px] truncate max-w-[120px]">
                                {ord.id}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {/* TAB 3: Audit Trail */}
            {activeTab === 'logs' && (
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 shadow-lg">
                <div className="space-y-2 max-h-[500px] overflow-y-auto pr-2 font-mono text-xs">
                  {logs.length === 0 ? (
                    <p className="text-slate-500 text-center py-8">No audit logs recorded yet.</p>
                  ) : (
                    logs.map((log) => {
                      let badgeClass = 'bg-slate-800 text-slate-400 border-slate-700';

                      if (log.type.startsWith('ORDER_FILLED') || log.type.startsWith('POSITION_OPENED')) {
                        badgeClass = 'bg-emerald-950 text-emerald-400 border-emerald-800';
                      } else if (log.type.includes('REJECTED') || log.type.includes('ERROR') || log.type.includes('FAILED')) {
                        badgeClass = 'bg-rose-950 text-rose-400 border-rose-800';
                      } else if (log.type.includes('DISCREPANCY')) {
                        badgeClass = 'bg-amber-950 text-amber-400 border-amber-800';
                      } else if (log.type.includes('CONNECTED') || log.type.includes('RECOVERY')) {
                        badgeClass = 'bg-blue-950 text-blue-400 border-blue-800';
                      } else if (log.type.includes('KILL_SWITCH')) {
                        badgeClass = 'bg-purple-950 text-purple-400 border-purple-800';
                      }

                      return (
                        <div
                          key={log.id}
                          className="flex items-start gap-3 p-2.5 bg-slate-950/70 border border-slate-850 rounded-lg hover:border-slate-800 transition-colors"
                        >
                          <span className="text-slate-500 text-[11px] whitespace-nowrap mt-0.5">
                            {new Date(log.timestamp).toLocaleTimeString()}
                          </span>
                          <span className={`px-2 py-0.5 rounded text-[10px] font-bold border uppercase tracking-wider shrink-0 ${badgeClass}`}>
                            {log.type}
                          </span>
                          <p className="text-slate-300 leading-relaxed font-sans text-xs break-all">
                            {log.message}
                          </p>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            )}

          </div>
        </div>

        {/* Credentials Configuration Modal */}
        {showConfigModal && (
          <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-md w-full p-6 space-y-5 shadow-2xl">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Key className="w-5 h-5 text-indigo-400" />
                  <h3 className="font-bold text-lg text-white">Bybit Credentials</h3>
                </div>
                <button
                  onClick={() => setShowConfigModal(false)}
                  className="text-slate-400 hover:text-white text-sm"
                >
                  ✕
                </button>
              </div>

              <p className="text-slate-400 text-xs leading-relaxed">
                Enter your Bybit Testnet API credentials. TradeBot 5 uses these keys to fetch real balances, check open positions, and execute orders strictly on Bybit Testnet.
              </p>

              <form onSubmit={handleSaveCredentials} className="space-y-4 text-xs">
                <div className="space-y-1">
                  <label className="text-slate-300 font-semibold block">API Key</label>
                  <input
                    type="text"
                    value={apiKeyInput}
                    onChange={(e) => setApiKeyInput(e.target.value)}
                    placeholder="e.g. bybit_testnet_key..."
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-white font-mono focus:border-indigo-500 focus:outline-none"
                    required
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-slate-300 font-semibold block">API Secret</label>
                  <input
                    type="password"
                    value={apiSecretInput}
                    onChange={(e) => setApiSecretInput(e.target.value)}
                    placeholder="Enter API Secret..."
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-white font-mono focus:border-indigo-500 focus:outline-none"
                    required
                  />
                </div>

                <div className="flex items-center justify-between py-2 border-t border-slate-800">
                  <span className="text-slate-300 font-medium">Network:</span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setIsTestnet(true)}
                      className={`px-3 py-1 rounded text-xs font-bold ${
                        isTestnet ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-400'
                      }`}
                    >
                      Testnet (Demo)
                    </button>
                  </div>
                </div>

                <div className="flex items-center justify-end gap-3 pt-2">
                  <button
                    type="button"
                    onClick={() => setShowConfigModal(false)}
                    className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg font-medium transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={credSaving}
                    className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-lg transition-colors flex items-center gap-2"
                  >
                    {credSaving ? <RefreshCw className="w-4 h-4 animate-spin" /> : null}
                    <span>Save &amp; Connect</span>
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
