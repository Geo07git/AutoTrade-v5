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
  Lock,
  RotateCcw,
  Cpu,
  DollarSign,
  Layers,
} from 'lucide-react';
import { BotStatusResponse, AuditLog, OrderRecord, Position, ExecutionMode } from './shared/types';

export default function App() {
  const [status, setStatus] = useState<BotStatusResponse | null>(null);
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [orders, setOrders] = useState<OrderRecord[]>([]);
  const [activeTab, setActiveTab] = useState<'positions' | 'orders' | 'logs'>('positions');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isReconciling, setIsReconciling] = useState<boolean>(false);
  const [showConfigModal, setShowConfigModal] = useState<boolean>(false);

  // Authentication token stored locally for control endpoints
  const [controlToken, setControlToken] = useState<string>(() => {
    return localStorage.getItem('tb5_control_token') || 'tradebot5_admin_token';
  });

  // API credentials form state
  const [apiKeyInput, setApiKeyInput] = useState<string>('');
  const [apiSecretInput, setApiSecretInput] = useState<string>('');
  const [isTestnet, setIsTestnet] = useState<boolean>(true);
  const [credSaving, setCredSaving] = useState<boolean>(false);

  const getAuthHeaders = () => ({
    'Content-Type': 'application/json',
    'x-bot-token': controlToken,
  });

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
    }, 3000);

    return () => clearInterval(interval);
  }, []);

  const switchExecutionMode = async (mode: ExecutionMode) => {
    setErrorMessage(null);
    setSuccessMessage(null);

    if (mode === 'LIVE') {
      setErrorMessage('LIVE trading is strictly blocked and disabled for safety reasons.');
      return;
    }

    try {
      const res = await fetch('/api/bot/mode', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ mode }),
      });
      const data = await res.json();

      if (!res.ok) {
        setErrorMessage(data.error || 'Failed to switch execution mode');
      } else {
        setSuccessMessage(`Switched execution mode to ${mode}`);
        await fetchStatus();
        await fetchLogs();
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to switch execution mode');
    }
  };

  const resetPaperAccount = async () => {
    setErrorMessage(null);
    setSuccessMessage(null);
    try {
      const res = await fetch('/api/bot/paper-reset', {
        method: 'POST',
        headers: getAuthHeaders(),
      });
      const data = await res.json();

      if (!res.ok) {
        setErrorMessage(data.error || 'Failed to reset paper account');
      } else {
        setSuccessMessage('Paper account reset: Balance restored to $10,000 USDT and positions cleared.');
        await fetchStatus();
        await fetchLogs();
        await fetchOrders();
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to reset paper account');
    }
  };

  const toggleKillswitch = async () => {
    try {
      setErrorMessage(null);
      setSuccessMessage(null);
      const res = await fetch('/api/bot/killswitch', {
        method: 'POST',
        headers: getAuthHeaders(),
      });
      if (!res.ok) {
        const data = await res.json();
        setErrorMessage(data.error || 'Failed to toggle Kill Switch');
        return;
      }
      await fetchStatus();
      await fetchLogs();
      await fetchOrders();
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to toggle Kill Switch');
    }
  };

  const setProfile = async (profile: 'SCALP' | 'MOMENTUM') => {
    setErrorMessage(null);
    setSuccessMessage(null);
    try {
      const res = await fetch('/api/bot/profile', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ profile }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMessage(data.error || 'Failed to switch profile');
      } else {
        setSuccessMessage(`Active profile set to ${profile}`);
        await fetchStatus();
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to switch profile');
    }
  };

  const triggerReconcile = async () => {
    setIsReconciling(true);
    setErrorMessage(null);
    setSuccessMessage(null);
    try {
      const res = await fetch('/api/bot/reconcile', {
        method: 'POST',
        headers: getAuthHeaders(),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMessage(data.error || 'Reconciliation failed');
      } else {
        if (data.status) {
          setStatus(data.status);
        }
        setSuccessMessage('Reconciliation completed successfully.');
        await fetchLogs();
        await fetchOrders();
      }
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
        headers: getAuthHeaders(),
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
        setSuccessMessage('Credentials saved and connection reloaded.');
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

  const handleSaveControlToken = (newToken: string) => {
    setControlToken(newToken);
    localStorage.setItem('tb5_control_token', newToken);
  };

  if (!status) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <Activity className="w-8 h-8 text-indigo-400 animate-spin" />
          <p className="text-slate-400 font-medium">Connecting to TradeBot 5 Engine...</p>
        </div>
      </div>
    );
  }

  const { state, config, profileConfig, equity, positions, executionMode } = status;
  const isKilled = config.killSwitchEngaged;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans p-4 md:p-8">
      <div className="max-w-7xl mx-auto space-y-6">
        
        {/* Error Notification Banner */}
        {errorMessage && (
          <div className="bg-rose-950/80 border border-rose-800 text-rose-200 px-4 py-3 rounded-xl flex items-center justify-between text-sm shadow-lg">
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

        {/* Success Notification Banner */}
        {successMessage && (
          <div className="bg-emerald-950/80 border border-emerald-800 text-emerald-200 px-4 py-3 rounded-xl flex items-center justify-between text-sm shadow-lg">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
              <span>{successMessage}</span>
            </div>
            <button
              onClick={() => setSuccessMessage(null)}
              className="text-emerald-400 hover:text-emerald-200 text-xs uppercase font-bold"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Top Header */}
        <header className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 bg-slate-900/90 border border-slate-800/80 backdrop-blur p-6 rounded-2xl shadow-xl">
          <div>
            <div className="flex items-center gap-3">
              <div className="p-2.5 bg-indigo-500/10 border border-indigo-500/20 rounded-xl">
                <Crosshair className="w-6 h-6 text-indigo-400" />
              </div>
              <div>
                <div className="flex items-center gap-3">
                  <h1 className="text-2xl font-bold tracking-tight text-white">TradeBot 5</h1>
                  <span
                    className={`px-2.5 py-0.5 rounded-full text-xs font-semibold border ${
                      executionMode === 'PAPER'
                        ? 'bg-emerald-950 text-emerald-300 border-emerald-800/60'
                        : 'bg-indigo-950 text-indigo-300 border-indigo-800/60'
                    }`}
                  >
                    {executionMode === 'PAPER' ? 'Paper Trading' : 'Bybit Testnet'}
                  </span>
                </div>
                <p className="text-slate-400 text-sm mt-0.5">
                  Disciplined Momentum Engine & Unified Execution Pipeline
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
              title="Reconcile local state with execution adapter"
              className="px-3.5 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg text-xs font-medium flex items-center gap-2 transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isReconciling ? 'animate-spin text-indigo-400' : ''}`} />
              <span>Reconcile</span>
            </button>

            {/* Settings Modal trigger */}
            <button
              onClick={() => setShowConfigModal(true)}
              className="px-3.5 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 rounded-lg text-xs font-medium flex items-center gap-2 transition-colors"
            >
              <Key className="w-3.5 h-3.5 text-slate-400" />
              <span>Settings</span>
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

        {/* Execution Mode Selector Banner */}
        <div className="bg-slate-900/70 border border-slate-800 p-4 rounded-xl flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Cpu className="w-5 h-5 text-indigo-400 shrink-0" />
            <div>
              <div className="text-sm font-bold text-slate-200">Execution Mode</div>
              <div className="text-xs text-slate-400">
                Single pipeline with pluggable execution adapters (Paper simulation vs Bybit Testnet)
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* PAPER Mode Button */}
            <button
              onClick={() => switchExecutionMode('PAPER')}
              className={`px-4 py-2 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 ${
                executionMode === 'PAPER'
                  ? 'bg-emerald-600 text-white shadow-md shadow-emerald-950/40'
                  : 'bg-slate-800 text-slate-300 hover:bg-slate-700 border border-slate-700'
              }`}
            >
              <Activity className="w-3.5 h-3.5" />
              <span>PAPER TRADING</span>
            </button>

            {/* TESTNET Mode Button */}
            <button
              onClick={() => switchExecutionMode('TESTNET')}
              className={`px-4 py-2 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 ${
                executionMode === 'TESTNET'
                  ? 'bg-indigo-600 text-white shadow-md shadow-indigo-950/40'
                  : 'bg-slate-800 text-slate-300 hover:bg-slate-700 border border-slate-700'
              }`}
            >
              <Target className="w-3.5 h-3.5" />
              <span>BYBIT TESTNET</span>
            </button>

            {/* LIVE Mode Button (BLOCKED) */}
            <button
              onClick={() => switchExecutionMode('LIVE')}
              title="LIVE trading is strictly blocked and disabled for safety reasons"
              className="px-4 py-2 rounded-lg text-xs font-bold bg-slate-900 text-slate-500 border border-slate-800/80 cursor-not-allowed flex items-center gap-1.5 opacity-70 hover:opacity-100 transition-opacity"
            >
              <Lock className="w-3.5 h-3.5 text-rose-500" />
              <span>LIVE</span>
              <span className="text-[10px] text-rose-400 font-mono bg-rose-950/80 px-1 rounded">BLOCKED</span>
            </button>

            {/* Reset Paper Balance button if in PAPER mode */}
            {executionMode === 'PAPER' && (
              <button
                onClick={resetPaperAccount}
                title="Reset paper balance to $10,000 USDT and clear simulated positions"
                className="ml-2 px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors"
              >
                <RotateCcw className="w-3.5 h-3.5 text-emerald-400" />
                <span>Reset Balance</span>
              </button>
            )}
          </div>
        </div>

        {/* Status Notice if in Testnet and Waiting for Keys */}
        {executionMode === 'TESTNET' && state === 'WAITING_FOR_EXCHANGE' && (
          <div className="bg-amber-950/40 border border-amber-800/50 p-4 rounded-xl flex flex-col md:flex-row items-start md:items-center justify-between gap-3 text-amber-200 text-sm">
            <div className="flex items-center gap-2">
              <ShieldAlert className="w-5 h-5 text-amber-400 shrink-0" />
              <span>
                <strong>Waiting for Bybit Testnet credentials:</strong> Set your API key and secret in Settings or switch to <strong>PAPER TRADING</strong> for instant local simulation without keys.
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => switchExecutionMode('PAPER')}
                className="px-3.5 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs rounded-lg whitespace-nowrap transition-colors"
              >
                Switch to Paper
              </button>
              <button
                onClick={() => setShowConfigModal(true)}
                className="px-3.5 py-1.5 bg-amber-600 hover:bg-amber-500 text-slate-950 font-bold text-xs rounded-lg whitespace-nowrap transition-colors"
              >
                Configure Keys
              </button>
            </div>
          </div>
        )}

        {/* Key Metrics Row */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          
          {/* Equity */}
          <div className="bg-slate-900 border border-slate-800 p-5 rounded-xl">
            <div className="flex items-center justify-between text-slate-400 text-xs uppercase tracking-wider font-semibold">
              <span>{executionMode === 'PAPER' ? 'Simulated Equity' : 'Bybit USDT Equity'}</span>
              <DollarSign className="w-4 h-4 text-slate-500" />
            </div>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-3xl font-bold tracking-tight text-white">
                ${equity.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
              <span className="text-xs text-slate-500">USDT</span>
            </div>
            <p className="text-slate-500 text-xs mt-2">
              {executionMode === 'PAPER' ? 'Local paper portfolio balance' : 'Single shared capital on Bybit'}
            </p>
          </div>

          {/* Active Profile */}
          <div className="bg-slate-900 border border-slate-800 p-5 rounded-xl">
            <div className="flex items-center justify-between text-slate-400 text-xs uppercase tracking-wider font-semibold">
              <span>Strategy Profile</span>
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
            <p className="text-slate-500 text-xs mt-2">
              Source of truth: {executionMode === 'PAPER' ? 'Paper Engine' : 'Bybit Linear'}
            </p>
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

            {/* Architecture Pipeline Flow */}
            <div className="bg-slate-900 border border-slate-800 p-5 rounded-xl space-y-3">
              <h2 className="text-xs font-bold text-slate-400 uppercase tracking-wider">
                Unified Pipeline
              </h2>
              <div className="space-y-2 text-xs font-mono">
                <div className="p-2 bg-slate-950 border border-slate-800 rounded flex items-center justify-between text-slate-300">
                  <span>1. Market Data</span>
                  <span className="text-[10px] text-indigo-400">REST & WS</span>
                </div>
                <div className="text-center text-slate-600 text-xs">↓</div>
                <div className="p-2 bg-slate-950 border border-slate-800 rounded flex items-center justify-between text-slate-300">
                  <span>2. Momentum Engine</span>
                  <span className="text-[10px] text-indigo-400">RSI, MACD, Trend</span>
                </div>
                <div className="text-center text-slate-600 text-xs">↓</div>
                <div className="p-2 bg-slate-950 border border-slate-800 rounded flex items-center justify-between text-slate-300">
                  <span>3. Risk Engine</span>
                  <span className="text-[10px] text-emerald-400">Pending & Size Gate</span>
                </div>
                <div className="text-center text-slate-600 text-xs">↓</div>
                <div className="p-2 bg-slate-950 border border-slate-800 rounded flex items-center justify-between text-slate-300">
                  <span>4. Order Manager</span>
                  <span className="text-[10px] text-amber-400">Lifecycle State Machine</span>
                </div>
                <div className="text-center text-slate-600 text-xs">↓</div>
                <div className="p-2 bg-slate-950 border border-slate-800 rounded flex items-center justify-between text-slate-300">
                  <span>5. Execution Adapter</span>
                  <span className="text-[10px] text-cyan-400">{executionMode}</span>
                </div>
                <div className="text-center text-slate-600 text-xs">↓</div>
                <div className="p-2 bg-slate-950 border border-slate-800 rounded flex items-center justify-between text-slate-300">
                  <span>6. Position Manager</span>
                  <span className="text-[10px] text-blue-400">FILLED Confirmed</span>
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
                Auto-sync: 3s
              </div>
            </div>

            {/* TAB 1: Positions */}
            {activeTab === 'positions' && (
              <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-lg">
                {positions.length === 0 ? (
                  <div className="p-12 text-center text-slate-500 space-y-2">
                    <Target className="w-10 h-10 mx-auto text-slate-600 opacity-40" />
                    <p className="font-medium text-sm">No open positions in {executionMode} mode.</p>
                    <p className="text-xs text-slate-600">
                      When Momentum Engine signals satisfy Risk Engine limits, Order Manager submits orders and positions update upon confirmed fill.
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
                          <th className="py-3.5 px-4">PnL</th>
                          <th className="py-3.5 px-4">Mode</th>
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
                              <td className="py-3.5 px-4 text-slate-300 font-semibold">{pos.qty}</td>
                              <td className="py-3.5 px-4 text-slate-300">${pos.entryPrice.toFixed(4)}</td>
                              <td className="py-3.5 px-4 text-slate-300 font-semibold">${pos.sizeUSDT.toFixed(2)}</td>
                              <td className="py-3.5 px-4">
                                <span className={isProfit ? 'text-emerald-400 font-bold' : 'text-rose-400 font-bold'}>
                                  {isProfit ? '+' : ''}{(pos.pnlPct || 0).toFixed(2)}%
                                </span>
                              </td>
                              <td className="py-3.5 px-4">
                                <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-800 text-slate-300">
                                  {pos.executionMode || executionMode}
                                </span>
                              </td>
                              <td className="py-3.5 px-4 text-right text-slate-500 text-[11px]">
                                {pos.source}
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

            {/* TAB 2: Orders */}
            {activeTab === 'orders' && (
              <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-lg">
                {orders.length === 0 ? (
                  <div className="p-12 text-center text-slate-500 space-y-2">
                    <FileText className="w-10 h-10 mx-auto text-slate-600 opacity-40" />
                    <p className="font-medium text-sm">No orders executed yet.</p>
                    <p className="text-xs text-slate-600">
                      Orders follow strict state flow: CREATED → SUBMITTED → ACCEPTED → FILLED.
                    </p>
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs border-collapse">
                      <thead>
                        <tr className="bg-slate-950/60 border-b border-slate-800 text-slate-400 uppercase tracking-wider font-semibold">
                          <th className="py-3.5 px-4">Time</th>
                          <th className="py-3.5 px-4">Order ID</th>
                          <th className="py-3.5 px-4">Symbol</th>
                          <th className="py-3.5 px-4">Side</th>
                          <th className="py-3.5 px-4">Qty</th>
                          <th className="py-3.5 px-4">Status</th>
                          <th className="py-3.5 px-4">Fill Price</th>
                          <th className="py-3.5 px-4">Mode</th>
                          <th className="py-3.5 px-4 text-right">Intent</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800 font-mono">
                        {orders.map((ord) => {
                          const isFilled = ord.status === 'FILLED';
                          const isPartial = ord.status === 'PARTIALLY_FILLED';
                          const isPending = ord.status === 'SUBMITTED' || ord.status === 'ACCEPTED' || ord.status === 'CREATED';
                          return (
                            <tr key={ord.id} className="hover:bg-slate-850/50 transition-colors">
                              <td className="py-3.5 px-4 text-slate-500 text-[11px]">
                                {new Date(ord.createdTime).toLocaleTimeString()}
                              </td>
                              <td className="py-3.5 px-4 text-slate-300 font-mono text-[11px] truncate max-w-[120px]">
                                {ord.id}
                              </td>
                              <td className="py-3.5 px-4 font-bold text-white">{ord.symbol}</td>
                              <td className="py-3.5 px-4">
                                <span
                                  className={`px-2 py-0.5 rounded text-[11px] font-bold ${
                                    ord.side === 'BUY'
                                      ? 'bg-emerald-950 text-emerald-400 border border-emerald-800/60'
                                      : 'bg-rose-950 text-rose-400 border border-rose-800/60'
                                  }`}
                                >
                                  {ord.side}
                                </span>
                              </td>
                              <td className="py-3.5 px-4 text-slate-300 font-semibold">{ord.qty}</td>
                              <td className="py-3.5 px-4">
                                <span
                                  className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                                    isFilled
                                      ? 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                                      : isPartial
                                      ? 'bg-amber-950 text-amber-300 border border-amber-800'
                                      : isPending
                                      ? 'bg-blue-950 text-blue-300 border border-blue-800'
                                      : 'bg-rose-950 text-rose-300 border border-rose-800'
                                  }`}
                                >
                                  {ord.status}
                                </span>
                              </td>
                              <td className="py-3.5 px-4 text-slate-300">
                                {ord.fillPrice ? `$${ord.fillPrice.toFixed(4)}` : '—'}
                              </td>
                              <td className="py-3.5 px-4">
                                <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-800 text-slate-400">
                                  {ord.executionMode || executionMode}
                                </span>
                              </td>
                              <td className="py-3.5 px-4 text-right text-slate-400 text-[11px]">
                                {ord.intent}
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
              <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-lg">
                <div className="p-4 border-b border-slate-800 text-xs font-semibold text-slate-400 flex items-center justify-between">
                  <span>Audit Trail Logs ({logs.length} entries)</span>
                  <span className="text-[11px] text-slate-500 font-normal">Real-time state transitions</span>
                </div>
                <div className="max-h-[520px] overflow-y-auto divide-y divide-slate-800 font-mono text-xs">
                  {logs.map((log) => {
                    const isError = log.type === 'ERROR' || log.type === 'ORDER_FAILED' || log.type === 'ORDER_REJECTED';
                    const isSuccess = log.type === 'ORDER_FILLED' || log.type === 'POSITION_OPENED' || log.type === 'POSITION_CLOSED';
                    const isWarning = log.type === 'RECONCILIATION_DISCREPANCY' || log.type === 'KILL_SWITCH_ENGAGED' || log.type === 'ORDER_PARTIALLY_FILLED';
                    return (
                      <div key={log.id} className="p-3.5 hover:bg-slate-850/40 transition-colors flex items-start gap-3">
                        <span className="text-slate-500 text-[11px] shrink-0 pt-0.5">
                          {new Date(log.timestamp).toLocaleTimeString()}
                        </span>
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-bold shrink-0 ${
                            isError
                              ? 'bg-rose-950 text-rose-300 border border-rose-800'
                              : isSuccess
                              ? 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                              : isWarning
                              ? 'bg-amber-950 text-amber-300 border border-amber-800'
                              : 'bg-slate-800 text-slate-300'
                          }`}
                        >
                          {log.type}
                        </span>
                        <div className="flex-1 text-slate-200 break-words leading-relaxed">
                          {log.message}
                          {log.details && (
                            <details className="mt-1 text-[11px] text-slate-500 cursor-pointer">
                              <summary>View details</summary>
                              <pre className="mt-1 p-2 bg-slate-950 rounded text-slate-400 overflow-x-auto text-[10px]">
                                {JSON.stringify(log.details, null, 2)}
                              </pre>
                            </details>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

          </div>

        </div>

        {/* Settings & Credentials Modal */}
        {showConfigModal && (
          <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-md w-full p-6 space-y-6 shadow-2xl">
              <div className="flex items-center justify-between border-b border-slate-800 pb-4">
                <div className="flex items-center gap-2.5">
                  <Key className="w-5 h-5 text-indigo-400" />
                  <h3 className="font-bold text-white text-base">TradeBot 5 Configuration</h3>
                </div>
                <button
                  onClick={() => setShowConfigModal(false)}
                  className="text-slate-400 hover:text-white text-xs uppercase font-bold"
                >
                  Close
                </button>
              </div>

              {/* Bot Control Token configuration */}
              <div className="space-y-2 p-3.5 bg-slate-950/60 border border-slate-800 rounded-xl">
                <label className="text-xs font-semibold text-slate-300 flex items-center justify-between">
                  <span>Bot Control Token (Auth)</span>
                  <span className="text-[10px] text-indigo-400">Security Gate</span>
                </label>
                <input
                  type="text"
                  value={controlToken}
                  onChange={(e) => handleSaveControlToken(e.target.value)}
                  placeholder="tradebot5_admin_token"
                  className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-xs font-mono text-slate-200 focus:outline-none focus:border-indigo-500"
                />
                <p className="text-[10px] text-slate-500">
                  Matches BOT_CONTROL_TOKEN in server environment to authorize control endpoints.
                </p>
              </div>

              {/* Bybit API Keys Form */}
              <form onSubmit={handleSaveCredentials} className="space-y-4">
                <div className="text-xs font-bold text-slate-400 uppercase tracking-wider">
                  Bybit Testnet Credentials
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-slate-400">Bybit API Key</label>
                  <input
                    type="text"
                    value={apiKeyInput}
                    onChange={(e) => setApiKeyInput(e.target.value)}
                    placeholder={config.bybitApiKey ? `Configured (${config.bybitApiKey.slice(0, 4)}...)` : 'Enter Bybit Testnet Key'}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3.5 py-2 text-xs font-mono text-slate-200 focus:outline-none focus:border-indigo-500"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-slate-400">Bybit API Secret</label>
                  <input
                    type="password"
                    value={apiSecretInput}
                    onChange={(e) => setApiSecretInput(e.target.value)}
                    placeholder={config.bybitApiSecret ? '••••••••••••••••' : 'Enter Bybit Testnet Secret'}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3.5 py-2 text-xs font-mono text-slate-200 focus:outline-none focus:border-indigo-500"
                  />
                </div>

                <div className="flex items-center gap-2 pt-1">
                  <input
                    type="checkbox"
                    id="testnetCheckbox"
                    checked={isTestnet}
                    onChange={(e) => setIsTestnet(e.target.checked)}
                    className="rounded bg-slate-950 border-slate-800 text-indigo-600 focus:ring-0"
                  />
                  <label htmlFor="testnetCheckbox" className="text-xs text-slate-300">
                    Use Bybit Testnet (api-testnet.bybit.com)
                  </label>
                </div>

                <div className="pt-3 border-t border-slate-800 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setShowConfigModal(false)}
                    className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs font-medium transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={credSaving}
                    className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-bold transition-colors disabled:opacity-50"
                  >
                    {credSaving ? 'Connecting...' : 'Save & Reconnect'}
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
