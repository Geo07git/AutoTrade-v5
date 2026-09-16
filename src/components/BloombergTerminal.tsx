/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import React, { useState, useEffect, useRef } from 'react';
import { LineChart, Line, ResponsiveContainer, YAxis, Tooltip, XAxis } from 'recharts';
import {
  BotStatusResponse,
  AuditLog,
  OrderRecord,
  Position,
  ExecutionMode,
  ProfileType,
} from '../shared/types';
import {
  Terminal,
  Activity,
  ShieldAlert,
  ShieldCheck,
  Zap,
  TrendingUp,
  TrendingDown,
  RefreshCw,
  Search,
  Sliders,
  DollarSign,
  Play,
  Square,
  AlertTriangle,
  Send,
  HelpCircle,
  Clock,
  List,
} from 'lucide-react';

interface BloombergTerminalProps {
  status: BotStatusResponse | null;
  logs: AuditLog[];
  orders: OrderRecord[];
  onRefresh: () => void;
  onSwitchMode: (mode: ExecutionMode) => void;
  onSwitchProfile: (profile: ProfileType) => void;
  onUpdateProfileSettings: (profileType: ProfileType, settings: any) => void;
  onClosePosition: (symbol: string) => void;
  onResetPaper: () => void;
  onToggleKillSwitch: () => void;
  onTriggerScan: () => void;
  errorMessage: string | null;
  successMessage: string | null;
}

interface TapeItem {
  id: string;
  timestamp: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: string;
  type: 'TRADE' | 'SIGNAL' | 'FILL' | 'STOP';
}

export const BloombergTerminal: React.FC<BloombergTerminalProps> = ({
  status,
  logs,
  orders,
  onRefresh,
  onSwitchMode,
  onSwitchProfile,
  onUpdateProfileSettings,
  onClosePosition,
  onResetPaper,
  onToggleKillSwitch,
  onTriggerScan,
  errorMessage,
  successMessage,
}) => {
  const [activeScreen, setActiveScreen] = useState<'PORT' | 'TAPE' | 'SCAN' | 'BLOT' | 'SET'>('PORT');
  const [commandInput, setCommandInput] = useState('');
  const [commandHistory, setCommandHistory] = useState<string[]>([
    'SYSTEM BOOT: BLOOMBERG TERMINAL V5.0 SECURE DESK INITIALIZED',
    'TYPE "HELP" OR CLICK FUNCTION KEYS [F1]-[F5] FOR MODULE ACCESS.',
  ]);
  const [tapeItems, setTapeItems] = useState<TapeItem[]>([]);
  const [minVolInput, setMinVolInput] = useState<number>(
    status?.scannerStats?.filterConfig ? status.scannerStats.filterConfig.min24hVolumeUSDT / 1_000_000 : 5
  );
  const [maxSymbolsInput, setMaxSymbolsInput] = useState<number>(
    status?.scannerStats?.filterConfig ? status.scannerStats.filterConfig.maxSymbols : 50
  );
  const [scannerSaving, setScannerSaving] = useState(false);
  const [showScannerConfig, setShowScannerConfig] = useState(false);
  const tickerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll ticker tape continuously
  useEffect(() => {
    const el = tickerRef.current;
    if (!el) return;
    const interval = setInterval(() => {
      if (el) {
        if (el.scrollLeft + el.clientWidth >= el.scrollWidth - 5) {
          el.scrollLeft = 0;
        } else {
          el.scrollLeft += 1;
        }
      }
    }, 45);
    return () => clearInterval(interval);
  }, [tapeItems]);

  // Generate real-time tape stream items sorted descending by 24h price increase percentage
  useEffect(() => {
    const items: TapeItem[] = [];

    // Add scanner topOpportunities sorted descending by 24h price change percentage
    if (status?.scannerStats?.topOpportunities && status.scannerStats.topOpportunities.length > 0) {
      const sortedOpps = [...status.scannerStats.topOpportunities].sort(
        (a, b) => (b.priceChange24hPct || 0) - (a.priceChange24hPct || 0)
      );
      sortedOpps.forEach((opp, idx) => {
        items.push({
          id: `opp_${opp.symbol}_${idx}`,
          timestamp: new Date().toLocaleTimeString(),
          symbol: opp.symbol,
          side: (opp.priceChange24hPct || 0) >= 0 ? 'BUY' : 'SELL',
          price: opp.price,
          size: `${(opp.priceChange24hPct || 0) >= 0 ? '+' : ''}${(opp.priceChange24hPct || 0).toFixed(2)}% (Vol $${((opp.volume24hUSDT || 0) / 1e6).toFixed(1)}M)`,
          type: 'SIGNAL',
        });
      });
    }
    
    // Add orders to tape
    orders.forEach((ord) => {
      items.push({
        id: `ord_${ord.id}`,
        timestamp: new Date(ord.createdTime).toLocaleTimeString(),
        symbol: ord.symbol,
        side: ord.side,
        price: ord.fillPrice || 0,
        size: `$${ord.sizeUSDT.toFixed(0)}`,
        type: ord.status === 'FILLED' ? 'FILL' : 'TRADE',
      });
    });

    // Add positions
    status?.positions?.forEach((pos) => {
      items.push({
        id: `pos_${pos.id}`,
        timestamp: new Date(pos.entryTime).toLocaleTimeString(),
        symbol: pos.symbol,
        side: pos.side,
        price: pos.entryPrice,
        size: `$${pos.sizeUSDT.toFixed(0)}`,
        type: 'TRADE',
      });
    });

    if (items.length === 0) {
      const defaultCrypto = [
        { symbol: 'RENDERUSDT', price: 7.84, change: 18.4, side: 'BUY' as const },
        { symbol: 'SOLUSDT', price: 198.50, change: 14.2, side: 'BUY' as const },
        { symbol: 'SUIUSDT', price: 3.42, change: 11.9, side: 'BUY' as const },
        { symbol: 'FETUSDT', price: 1.65, change: 9.8, side: 'BUY' as const },
        { symbol: 'INJUSDT', price: 24.10, change: 7.5, side: 'BUY' as const },
        { symbol: 'ETHUSDT', price: 3450.00, change: 4.8, side: 'BUY' as const },
        { symbol: 'BTCUSDT', price: 92800.00, change: 3.2, side: 'BUY' as const },
        { symbol: 'AVAXUSDT', price: 31.20, change: 1.1, side: 'BUY' as const },
        { symbol: 'XRPUSDT', price: 2.15, change: -0.5, side: 'SELL' as const },
      ].sort((a, b) => b.change - a.change);

      defaultCrypto.forEach((c, i) => {
        items.push({
          id: `def_${i}`,
          timestamp: new Date(Date.now() - i * 3000).toLocaleTimeString(),
          symbol: c.symbol,
          side: c.side,
          price: c.price,
          size: `+${c.change.toFixed(2)}%`,
          type: 'SIGNAL',
        });
      });
    }

    setTapeItems(items.slice(0, 50));
  }, [orders, status]);

  // Handle command line execution
  const handleCommandSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const cmd = commandInput.trim().toUpperCase();
    if (!cmd) return;

    let response = `> ${cmd}`;
    const parts = cmd.split(' ');
    const action = parts[0];

    if (action === 'HELP') {
      response = 'AVAILABLE COMMANDS: START, STOP, SCALP, MOMENTUM, SCAN, RESET, KILL, CLEAR, PORT, TAPE, BLOT, SET';
    } else if (action === 'SCALP') {
      onSwitchProfile('SCALP');
      response = 'PROFILE SWITCHED TO SCALP (15m/60m, Aggressive)';
    } else if (action === 'MOMENTUM') {
      onSwitchProfile('MOMENTUM');
      response = 'PROFILE SWITCHED TO MOMENTUM (60m/240m, Trend)';
    } else if (action === 'SCAN') {
      onTriggerScan();
      response = 'MANUAL UNIVERSE SCAN INITIATED...';
    } else if (action === 'KILL') {
      onToggleKillSwitch();
      response = 'EMERGENCY KILL SWITCH TOGGLED.';
    } else if (action === 'RESET') {
      onResetPaper();
      response = 'PAPER TRADING ACCOUNT RESET TO $200.00';
    } else if (action === 'CLEAR') {
      setCommandHistory(['SCREEN CLEARED.']);
      setCommandInput('');
      return;
    } else if (action === 'PORT' || action === 'F1') {
      setActiveScreen('PORT');
      response = 'SWITCHED TO F1: PORTFOLIO & POSITIONS';
    } else if (action === 'TAPE' || action === 'F2') {
      setActiveScreen('TAPE');
      response = 'SWITCHED TO F2: REAL-TIME TAPE';
    } else if (action === 'SCAN' || action === 'F3') {
      setActiveScreen('SCAN');
      response = 'SWITCHED TO F3: MARKET SCANNER';
    } else if (action === 'BLOT' || action === 'F4') {
      setActiveScreen('BLOT');
      response = 'SWITCHED TO F4: ORDER BLOTTER';
    } else if (action === 'SET' || action === 'F5') {
      setActiveScreen('SET');
      response = 'SWITCHED TO F5: STRATEGY PARAMETERS';
    } else {
      response = `UNKNOWN COMMAND: "${cmd}". TYPE "HELP" FOR COMMAND LIST.`;
    }

    setCommandHistory((prev) => [response, ...prev.slice(0, 30)]);
    setCommandInput('');
  };

  const handleSaveScannerConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    setScannerSaving(true);
    try {
      const res = await fetch('/api/bot/scanner/config', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-bot-token': localStorage.getItem('tb5_control_token') || 'tradebot5_admin_token',
        },
        body: JSON.stringify({
          min24hVolumeUSDT: minVolInput * 1_000_000,
          maxSymbols: maxSymbolsInput,
        }),
      });
      if (res.ok) {
        onRefresh();
        setShowScannerConfig(false);
      }
    } catch (err) {
      console.error('Failed to update scanner config', err);
    } finally {
      setScannerSaving(false);
    }
  };

  const profileConfig = status?.profileConfig;
  const activeProfile = status?.config?.activeProfile || 'MOMENTUM';
  const positions = status?.positions || [];
  const totalPnL = positions.reduce((acc, p) => acc + (p.pnl || 0), 0);
  const lockedCapital = positions.reduce((acc, p) => acc + (p.sizeUSDT || 0), 0);
  const isKillSwitch = status?.config?.killSwitchEngaged;

  return (
    <div className="min-h-screen bg-black text-amber-500 font-mono flex flex-col select-none overflow-x-hidden">
      {/* 1. BLOOMBERG TERMINAL TOP BANNER */}
      <header className="bg-amber-600 text-black px-3 py-1 flex flex-col md:flex-row md:items-center justify-between text-xs font-bold tracking-wider shrink-0 shadow-md gap-2 md:gap-0">
        <div className="flex items-center justify-between md:justify-start w-full md:w-auto space-x-2 md:space-x-3">
          <span className="bg-black text-amber-500 px-2 py-0.5 rounded text-[11px] tracking-widest font-extrabold border border-amber-500/50">
            <span className="hidden sm:inline">BLOOMBERG // TRADEBOT v5.0 PRO</span>
            <span className="sm:hidden">BBG // TRADEBOT</span>
          </span>
          <span className="hidden lg:inline">DESK: SECURE-QUANT-01</span>
          <span className="hidden lg:inline">|</span>
          <span className="hidden md:inline">FEED: {status?.config?.executionMode || 'PAPER'} (TESTNET)</span>
          <button
            onClick={() => {
              if (window.confirm('Reset paper account to $200.00? This will wipe equity.')) {
                onResetPaper();
              }
            }}
            className="md:hidden bg-zinc-900 text-amber-400 hover:bg-black px-2 py-0.5 rounded border border-amber-500/30 flex items-center space-x-1 text-[10px]"
          >
            <span>RESET BAL</span>
          </button>
        </div>
        <div className="flex items-center justify-between md:justify-end w-full md:w-auto space-x-2 md:space-x-4">
          <div className="flex items-center space-x-2 shrink-0">
            <span className="bg-black/90 text-emerald-400 px-2 py-0.5 rounded text-[11px] font-mono">
              EQ: ${status?.equity?.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) || '10,000.00'}
            </span>
            <span className={`px-2 py-0.5 rounded text-[11px] font-mono shrink-0 ${totalPnL >= 0 ? 'bg-emerald-950 text-emerald-400' : 'bg-rose-950 text-rose-400'}`}>
              PNL: {totalPnL >= 0 ? '+' : ''}${totalPnL.toFixed(2)}
            </span>
          </div>
          <div className="flex items-center space-x-2 shrink-0">
            <button
              onClick={() => {
                if (window.confirm('Reset paper account to $200.00? This will wipe equity.')) {
                  onResetPaper();
                }
              }}
              className="hidden md:flex bg-zinc-900 text-amber-400 hover:bg-black px-2 py-0.5 rounded border border-amber-500/30 items-center space-x-1 text-[11px]"
            >
              <span>RESET BAL</span>
            </button>
            <button
              onClick={onRefresh}
              className="bg-black text-amber-500 hover:bg-zinc-900 px-2 py-0.5 rounded flex items-center space-x-1 text-[11px]"
            >
              <RefreshCw className="w-3 h-3 animate-spin" style={{ animationDuration: '4s' }} />
              <span className="hidden sm:inline">SYNC</span>
            </button>
          </div>
        </div>
      </header>

      {/* 2. REAL-TIME TICKER TAPE (AUTO-SCROLLING 24H % DESC) */}
      <div
        ref={tickerRef}
        className="bg-zinc-950 border-b border-amber-500/30 px-3 py-1 text-[11px] flex items-center space-x-6 overflow-x-auto whitespace-nowrap shrink-0 scrollbar-none"
        style={{ scrollBehavior: 'smooth' }}
      >
        <div className="flex items-center space-x-1 text-amber-400 font-bold shrink-0">
          <Activity className="w-3.5 h-3.5 animate-pulse text-amber-500" />
          <span>AUTO-TAPE (24H % DESC) &gt;&gt;</span>
        </div>
        <div className="flex items-center space-x-6 shrink-0">
          {tapeItems.map((item, idx) => (
            <div key={item.id + idx} className="flex items-center space-x-2 bg-zinc-900/80 px-2 py-0.5 rounded border border-amber-500/20 shrink-0">
              <span className="text-slate-400">[{item.timestamp}]</span>
              <span className="font-bold text-amber-300">{item.symbol}</span>
              <span className={item.side === 'BUY' ? 'text-emerald-400 font-bold' : 'text-rose-400 font-bold'}>
                {item.side}
              </span>
              <span className="text-zinc-200">${item.price.toLocaleString()}</span>
              <span className="text-amber-400 text-[10px] font-bold">({item.size})</span>
            </div>
          ))}
        </div>
      </div>

      {/* 3. FUNCTION KEY SHORTCUTS BAR (SCROLLABLE IN PHONE VIEW) */}
      <div className="bg-zinc-900 border-b border-amber-500/30 px-3 py-1.5 flex items-center justify-between text-xs shrink-0 overflow-x-auto whitespace-nowrap gap-4">
        <div className="flex items-center space-x-1 sm:space-x-2 shrink-0">
          <button
            onClick={() => setActiveScreen('PORT')}
            className={`px-3 py-1 rounded font-bold text-xs transition-colors flex items-center space-x-1.5 shrink-0 ${
              activeScreen === 'PORT' ? 'bg-amber-500 text-black shadow-lg shadow-amber-500/20' : 'bg-black text-amber-500 hover:bg-zinc-800 border border-amber-500/40'
            }`}
          >
            <span>[1:PORT]</span>
            <span className="hidden sm:inline">Positions ({positions.length})</span>
          </button>

          <button
            onClick={() => setActiveScreen('TAPE')}
            className={`px-3 py-1 rounded font-bold text-xs transition-colors flex items-center space-x-1.5 shrink-0 ${
              activeScreen === 'TAPE' ? 'bg-amber-500 text-black shadow-lg shadow-amber-500/20' : 'bg-black text-amber-500 hover:bg-zinc-800 border border-amber-500/40'
            }`}
          >
            <span>[2:TAPE]</span>
            <span className="hidden sm:inline">Time &amp; Sales</span>
          </button>

          <button
            onClick={() => setActiveScreen('SCAN')}
            className={`px-3 py-1 rounded font-bold text-xs transition-colors flex items-center space-x-1.5 shrink-0 ${
              activeScreen === 'SCAN' ? 'bg-amber-500 text-black shadow-lg shadow-amber-500/20' : 'bg-black text-amber-500 hover:bg-zinc-800 border border-amber-500/40'
            }`}
          >
            <span>[3:SCAN]</span>
            <span className="hidden sm:inline">Universe Scanner</span>
          </button>

          <button
            onClick={() => setActiveScreen('BLOT')}
            className={`px-3 py-1 rounded font-bold text-xs transition-colors flex items-center space-x-1.5 shrink-0 ${
              activeScreen === 'BLOT' ? 'bg-amber-500 text-black shadow-lg shadow-amber-500/20' : 'bg-black text-amber-500 hover:bg-zinc-800 border border-amber-500/40'
            }`}
          >
            <span>[4:BLOT]</span>
            <span className="hidden sm:inline">Orders &amp; Audit</span>
          </button>

          <button
            onClick={() => setActiveScreen('SET')}
            className={`px-3 py-1 rounded font-bold text-xs transition-colors flex items-center space-x-1.5 shrink-0 ${
              activeScreen === 'SET' ? 'bg-amber-500 text-black shadow-lg shadow-amber-500/20' : 'bg-black text-amber-500 hover:bg-zinc-800 border border-amber-500/40'
            }`}
          >
            <span>[5:SET]</span>
            <span className="hidden sm:inline">Parameters</span>
          </button>
        </div>

        <div className="flex items-center space-x-2 shrink-0">
          {/* Profile Switcher */}
          <div className="flex bg-black rounded border border-amber-500/40 p-0.5 shrink-0">
            <button
              onClick={() => onSwitchProfile('SCALP')}
              className={`px-2 py-0.5 rounded text-[11px] font-bold ${
                activeProfile === 'SCALP' ? 'bg-amber-500 text-black' : 'text-amber-500 hover:text-amber-300'
              }`}
            >
              SCALP
            </button>
            <button
              onClick={() => onSwitchProfile('MOMENTUM')}
              className={`px-2 py-0.5 rounded text-[11px] font-bold ${
                activeProfile === 'MOMENTUM' ? 'bg-amber-500 text-black' : 'text-amber-500 hover:text-amber-300'
              }`}
            >
              MOMENTUM
            </button>
          </div>

          {/* Kill Switch */}
          <button
            onClick={onToggleKillSwitch}
            className={`px-3 py-1 rounded font-bold text-xs border transition-colors flex items-center space-x-1 shrink-0 ${
              isKillSwitch ? 'bg-rose-600 text-white border-rose-400 animate-pulse' : 'bg-zinc-950 text-rose-500 border-rose-500/50 hover:bg-rose-950/40'
            }`}
          >
            <ShieldAlert className="w-3.5 h-3.5" />
            <span>{isKillSwitch ? 'KILL SWITCH ENGAGED' : 'KILL SWITCH'}</span>
          </button>
        </div>
      </div>

      {/* ALERTS NOTIFICATION BANNER */}
      {(errorMessage || successMessage) && (
        <div className={`px-4 py-2 text-xs flex items-center justify-between border-b ${errorMessage ? 'bg-rose-950/80 text-rose-300 border-rose-800' : 'bg-emerald-950/80 text-emerald-300 border-emerald-800'}`}>
          <div className="flex items-center space-x-2">
            {errorMessage ? <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" /> : <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />}
            <span>{errorMessage || successMessage}</span>
          </div>
        </div>
      )}

      {/* 4. MAIN TERMINAL WORKSPACE GRID */}
      <main className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-2 p-2 bg-black overflow-y-auto">
        {/* LEFT / CENTER MODULE CONTENT (8 Cols on LG) */}
        <div className="lg:col-span-8 flex flex-col space-y-2">
          {activeScreen === 'PORT' && (
            <div className="bg-zinc-950 border border-amber-500/30 rounded p-3 flex flex-col h-full min-h-[450px]">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between border-b border-amber-500/30 pb-2 mb-3 gap-2">
                <div className="flex items-center space-x-2">
                  <Terminal className="w-4 h-4 text-amber-500" />
                  <span className="font-bold text-sm tracking-wider">F1: ACTIVE PORTFOLIO &amp; POSITIONS</span>
                </div>
                <span className="text-xs text-slate-400">{positions.length} Open Positions</span>
              </div>

              {/* PORTFOLIO METRICS */}
              <div className="grid grid-cols-2 gap-3 mb-4">
                <div className="bg-black border border-amber-500/20 p-3 rounded">
                  <div className="text-slate-400 text-[10px] tracking-wider mb-1">SESSION REALIZED PNL</div>
                  <div className={`text-lg font-bold ${(status?.sessionRealizedPnL || 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {(status?.sessionRealizedPnL || 0) >= 0 ? '+' : ''}${(status?.sessionRealizedPnL || 0).toFixed(2)}
                  </div>
                </div>
                <div className="bg-black border border-amber-500/20 p-3 rounded">
                  <div className="text-slate-400 text-[10px] tracking-wider mb-1">LOCKED CAPITAL (USDT)</div>
                  <div className="text-lg font-bold text-cyan-400">
                    ${lockedCapital.toFixed(2)}
                  </div>
                </div>
              </div>

              {/* EQUITY HISTORY CHART */}
              {status?.equityHistory && status.equityHistory.length > 1 && (
                <div className="mb-4 bg-black border border-amber-500/20 p-2 rounded h-32 relative">
                  <span className="absolute top-1 left-2 text-[10px] text-amber-600 font-bold tracking-widest z-10">24H EQUITY CURVE</span>
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={status.equityHistory}>
                      <YAxis domain={['auto', 'auto']} hide />
                      <Line 
                        type="monotone" 
                        dataKey="equity" 
                        stroke="#10b981" 
                        strokeWidth={1.5} 
                        dot={false}
                        isAnimationActive={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}

              {positions.length === 0 ? (
                <div className="flex-1 flex flex-col items-center justify-center text-zinc-500 py-12 space-y-2">
                  <Activity className="w-8 h-8 opacity-40 animate-pulse" />
                  <p className="text-xs tracking-wider">NO ACTIVE POSITIONS. SCANNING UNIVERSE FOR MOMENTUM SIGNALS...</p>
                </div>
              ) : (
                <div className="overflow-x-auto flex-1">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-amber-500/20 text-amber-400/80">
                        <th className="py-2 px-2">Symbol</th>
                        <th className="py-2 px-2">Side</th>
                        <th className="py-2 px-2">Qty</th>
                        <th className="py-2 px-2">Entry</th>
                        <th className="py-2 px-2">Size</th>
                        <th className="py-2 px-2">PnL ($ / %)</th>
                        <th className="py-2 px-2 text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-900 font-mono">
                      {positions.map((pos) => {
                        const isProfit = (pos.pnl || 0) >= 0;
                        return (
                          <tr key={pos.id} className="hover:bg-zinc-900/50">
                            <td className="py-2.5 px-2 font-bold text-amber-300">{pos.symbol}</td>
                            <td className="py-2.5 px-2">
                              <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${pos.side === 'BUY' ? 'bg-emerald-950 text-emerald-400' : 'bg-rose-950 text-rose-400'}`}>
                                {pos.side}
                              </span>
                            </td>
                            <td className="py-2.5 px-2">{pos.qty.toFixed(4)}</td>
                            <td className="py-2.5 px-2">${pos.entryPrice.toLocaleString()}</td>
                            <td className="py-2.5 px-2">${pos.sizeUSDT.toFixed(2)}</td>
                            <td className={`py-2.5 px-2 font-bold ${isProfit ? 'text-emerald-400' : 'text-rose-400'}`}>
                              {isProfit ? '+' : ''}${pos.pnl?.toFixed(2) || '0.00'} ({isProfit ? '+' : ''}{pos.pnlPct?.toFixed(2) || '0.00'}%)
                            </td>
                            <td className="py-2.5 px-2 text-right">
                              <button
                                onClick={() => {
                                  if (window.confirm(`Force close position for ${pos.symbol}?`)) {
                                    onClosePosition(pos.symbol);
                                  }
                                }}
                                className="bg-rose-900 hover:bg-rose-800 text-white px-2 py-0.5 rounded text-[10px] font-bold tracking-wider"
                              >
                                CLOSE
                              </button>
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

          {activeScreen === 'TAPE' && (
            <div className="bg-zinc-950 border border-amber-500/30 rounded p-3 flex flex-col h-full min-h-[450px]">
              <div className="flex items-center justify-between border-b border-amber-500/30 pb-2 mb-3">
                <div className="flex items-center space-x-2">
                  <Activity className="w-4 h-4 text-amber-500" />
                  <span className="font-bold text-sm tracking-wider">F2: REAL-TIME TIME &amp; SALES TAPE</span>
                </div>
                <span className="text-xs text-slate-400">Live Tick Stream</span>
              </div>

              <div className="overflow-y-auto flex-1 max-h-[500px] space-y-1 font-mono text-xs">
                {tapeItems.map((item, idx) => (
                  <div key={item.id + idx} className="flex items-center justify-between bg-zinc-900/60 px-3 py-1.5 rounded border border-amber-500/10 hover:border-amber-500/30">
                    <div className="flex items-center space-x-3">
                      <span className="text-slate-500">{item.timestamp}</span>
                      <span className="font-bold text-amber-300">{item.symbol}</span>
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${item.side === 'BUY' ? 'bg-emerald-950 text-emerald-400' : 'bg-rose-950 text-rose-400'}`}>
                        {item.side}
                      </span>
                    </div>
                    <div className="flex items-center space-x-4">
                      <span className="text-zinc-100 font-bold">${item.price.toLocaleString()}</span>
                      <span className="text-amber-500/80 text-[11px]">{item.size}</span>
                      <span className="text-slate-400 text-[10px] bg-black px-1.5 py-0.5 rounded border border-zinc-800">{item.type}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeScreen === 'SCAN' && (
            <div className="bg-zinc-950 border border-amber-500/30 rounded p-3 flex flex-col h-full min-h-[450px]">
              <div className="flex items-center justify-between border-b border-amber-500/30 pb-2 mb-3">
                <div className="flex items-center space-x-2">
                  <Search className="w-4 h-4 text-amber-500" />
                  <span className="font-bold text-sm tracking-wider">F3: MARKET MOMENTUM SCANNER &amp; UNIVERSE</span>
                </div>
                <div className="flex items-center space-x-2">
                  <button
                    onClick={() => setShowScannerConfig(!showScannerConfig)}
                    className="bg-zinc-900 hover:bg-zinc-800 text-amber-400 border border-amber-500/40 px-2 py-1 rounded text-xs font-bold flex items-center space-x-1"
                  >
                    <Sliders className="w-3.5 h-3.5" />
                    <span>{showScannerConfig ? 'HIDE FILTERS' : 'SCANNER FILTERS'}</span>
                  </button>
                  <button
                    onClick={onTriggerScan}
                    className="bg-amber-500 hover:bg-amber-400 text-black px-2 py-1 rounded text-xs font-bold"
                  >
                    RUN SCAN NOW
                  </button>
                </div>
              </div>

              {/* Scanner Config Form */}
              {showScannerConfig && (
                <form onSubmit={handleSaveScannerConfig} className="bg-zinc-900/90 border border-amber-500/40 rounded p-3 mb-3 text-xs space-y-3">
                  <div className="font-bold text-amber-400 flex items-center space-x-1.5">
                    <Sliders className="w-3.5 h-3.5" />
                    <span>SCANNER PARAMETERS &amp; LIQUIDITY FILTERS</span>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-slate-400 mb-1">Min 24h Volume (Millions USDT)</label>
                      <input
                        type="number"
                        min="0.5"
                        step="0.5"
                        value={minVolInput}
                        onChange={(e) => setMinVolInput(parseFloat(e.target.value) || 1)}
                        className="w-full bg-black text-amber-400 px-2 py-1.5 rounded border border-amber-500/40 font-mono text-xs"
                      />
                    </div>
                    <div>
                      <label className="block text-slate-400 mb-1">Număr de perechi de scanat (Max Symbols)</label>
                      <input
                        type="number"
                        min="5"
                        max="100"
                        value={maxSymbolsInput}
                        onChange={(e) => setMaxSymbolsInput(parseInt(e.target.value, 10) || 50)}
                        className="w-full bg-black text-amber-400 px-2 py-1.5 rounded border border-amber-500/40 font-mono text-xs"
                      />
                    </div>
                  </div>
                  <div className="flex justify-end space-x-2">
                    <button
                      type="button"
                      onClick={() => setShowScannerConfig(false)}
                      className="px-3 py-1 bg-zinc-800 text-slate-300 rounded text-xs"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={scannerSaving}
                      className="px-3 py-1 bg-amber-500 hover:bg-amber-400 text-black font-bold rounded text-xs"
                    >
                      {scannerSaving ? 'Saving...' : 'Apply Filters'}
                    </button>
                  </div>
                </form>
              )}

              <div className="space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div className="bg-zinc-900 p-3 rounded border border-amber-500/20">
                    <div className="text-slate-400 text-[11px]">Universe Monitored</div>
                    <div className="text-lg font-bold text-amber-400">{status?.scannerStats?.universeCount || 25} Symbols</div>
                  </div>
                  <div className="bg-zinc-900 p-3 rounded border border-amber-500/20">
                    <div className="text-slate-400 text-[11px]">Filtered Candidates</div>
                    <div className="text-lg font-bold text-emerald-400">{status?.scannerStats?.candidatesCount || 4} Active</div>
                  </div>
                  <div className="bg-zinc-900 p-3 rounded border border-amber-500/20">
                    <div className="text-slate-400 text-[11px]">Scan Interval</div>
                    <div className="text-lg font-bold text-cyan-400">10,000 ms</div>
                  </div>
                </div>

                <div className="bg-zinc-900/80 rounded p-3 border border-amber-500/20">
                  <div className="text-xs font-bold text-amber-400 mb-2">TOP SCANNED OPPORTUNITIES</div>
                  <div className="space-y-2">
                    {status?.scannerStats?.topOpportunities?.length ? (
                      status.scannerStats.topOpportunities.map((opp) => (
                        <div key={opp.symbol} className="flex items-center justify-between bg-black p-2 rounded border border-zinc-800 text-xs">
                          <div className="flex items-center space-x-3">
                            <span className="font-bold text-amber-300">#{opp.rank} {opp.symbol}</span>
                            <span className="text-slate-400">${opp.price}</span>
                            <span className="text-emerald-400">RVOL: {opp.rvol}x</span>
                          </div>
                          <div className="flex items-center space-x-3">
                            <span className="text-amber-500 font-bold">Score: {opp.score}/100</span>
                            <span className={`px-2 py-0.5 rounded font-bold text-[10px] ${opp.isEligible ? 'bg-emerald-950 text-emerald-400' : 'bg-zinc-800 text-zinc-400'}`}>
                              {opp.isEligible ? 'ELIGIBLE' : 'FILTERED'}
                            </span>
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="text-zinc-500 text-xs py-4 text-center">No live scanner data cached yet. Click "RUN SCAN NOW".</div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeScreen === 'BLOT' && (
            <div className="bg-zinc-950 border border-amber-500/30 rounded p-3 flex flex-col h-full min-h-[450px]">
              <div className="flex items-center justify-between border-b border-amber-500/30 pb-2 mb-3">
                <div className="flex items-center space-x-2">
                  <List className="w-4 h-4 text-amber-500" />
                  <span className="font-bold text-sm tracking-wider">F4: ORDER EXECUTION BLOTTER &amp; AUDIT LOGS</span>
                </div>
                <span className="text-xs text-slate-400">{orders.length} Orders Recorded</span>
              </div>

              <div className="overflow-x-auto flex-1">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-amber-500/20 text-amber-400/80">
                      <th className="py-2 px-2">ID</th>
                      <th className="py-2 px-2">Symbol</th>
                      <th className="py-2 px-2">Side</th>
                      <th className="py-2 px-2">Intent</th>
                      <th className="py-2 px-2">Size ($)</th>
                      <th className="py-2 px-2">Status</th>
                      <th className="py-2 px-2 text-right">Time</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-900 font-mono">
                    {orders.slice(0, 20).map((ord) => (
                      <tr key={ord.id} className="hover:bg-zinc-900/50">
                        <td className="py-2 px-2 text-slate-400 text-[10px]">{ord.id.substring(0, 8)}</td>
                        <td className="py-2 px-2 font-bold text-amber-300">{ord.symbol}</td>
                        <td className="py-2 px-2">
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${ord.side === 'BUY' ? 'bg-emerald-950 text-emerald-400' : 'bg-rose-950 text-rose-400'}`}>
                            {ord.side}
                          </span>
                        </td>
                        <td className="py-2 px-2 text-zinc-300">{ord.intent}</td>
                        <td className="py-2 px-2">${ord.sizeUSDT.toFixed(0)}</td>
                        <td className="py-2 px-2">
                          <span className="text-cyan-400 font-bold text-[10px]">{ord.status}</span>
                        </td>
                        <td className="py-2 px-2 text-right text-slate-400 text-[10px]">
                          {new Date(ord.createdTime).toLocaleTimeString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {activeScreen === 'SET' && (
            <div className="bg-zinc-950 border border-amber-500/30 rounded p-3 flex flex-col h-full min-h-[450px]">
              <div className="flex items-center justify-between border-b border-amber-500/30 pb-2 mb-3">
                <div className="flex items-center space-x-2">
                  <Sliders className="w-4 h-4 text-amber-500" />
                  <span className="font-bold text-sm tracking-wider">F5: STRATEGY PARAMETERS &amp; SLIDERS ({activeProfile})</span>
                </div>
                <span className="text-xs text-amber-400">Live Auto-Save Enabled</span>
              </div>

              {profileConfig && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                  {/* Risk Allocation */}
                  <div className="bg-zinc-900 p-3 rounded border border-amber-500/20 space-y-2">
                    <div className="flex justify-between items-center">
                      <span className="text-slate-300">Risk Allocation</span>
                      <span className="font-bold text-amber-400">{profileConfig.riskPerTradePct}% / trade</span>
                    </div>
                    <input
                      type="range"
                      min="1"
                      max="100"
                      step="1"
                      defaultValue={profileConfig.riskPerTradePct}
                      onMouseUp={(e) => onUpdateProfileSettings(activeProfile, { riskPerTradePct: Number(e.currentTarget.value) })}
                      onTouchEnd={(e) => onUpdateProfileSettings(activeProfile, { riskPerTradePct: Number(e.currentTarget.value) })}
                      className="w-full accent-amber-500"
                    />
                  </div>

                  {/* Max Open Positions */}
                  <div className="bg-zinc-900 p-3 rounded border border-amber-500/20 space-y-2">
                    <div className="flex justify-between items-center">
                      <span className="text-slate-300">Max Open Positions</span>
                      <span className="font-bold text-amber-400">{profileConfig.maxOpenPositions}</span>
                    </div>
                    <input
                      type="range"
                      min="1"
                      max="20"
                      step="1"
                      defaultValue={profileConfig.maxOpenPositions}
                      onMouseUp={(e) => onUpdateProfileSettings(activeProfile, { maxOpenPositions: Number(e.currentTarget.value) })}
                      onTouchEnd={(e) => onUpdateProfileSettings(activeProfile, { maxOpenPositions: Number(e.currentTarget.value) })}
                      className="w-full accent-amber-500"
                    />
                  </div>

                  {/* Hard Stop Loss */}
                  <div className="bg-zinc-900 p-3 rounded border border-amber-500/20 space-y-2">
                    <div className="flex justify-between items-center">
                      <span className="text-slate-300">Hard Stop Loss</span>
                      <span className="font-bold text-rose-400">-{profileConfig.hardStopLossPct}%</span>
                    </div>
                    <input
                      type="range"
                      min="0.5"
                      max="20"
                      step="0.1"
                      defaultValue={profileConfig.hardStopLossPct}
                      onMouseUp={(e) => onUpdateProfileSettings(activeProfile, { hardStopLossPct: Number(e.currentTarget.value) })}
                      onTouchEnd={(e) => onUpdateProfileSettings(activeProfile, { hardStopLossPct: Number(e.currentTarget.value) })}
                      className="w-full accent-rose-500"
                    />
                  </div>

                  {/* Trailing Activation */}
                  <div className="bg-zinc-900 p-3 rounded border border-amber-500/20 space-y-2">
                    <div className="flex justify-between items-center">
                      <span className="text-slate-300">Trailing Activation</span>
                      <span className="font-bold text-emerald-400">+{profileConfig.trailingActivationPct}%</span>
                    </div>
                    <input
                      type="range"
                      min="0.1"
                      max="20"
                      step="0.1"
                      defaultValue={profileConfig.trailingActivationPct}
                      onMouseUp={(e) => onUpdateProfileSettings(activeProfile, { trailingActivationPct: Number(e.currentTarget.value) })}
                      onTouchEnd={(e) => onUpdateProfileSettings(activeProfile, { trailingActivationPct: Number(e.currentTarget.value) })}
                      className="w-full accent-emerald-500"
                    />
                  </div>

                  {/* Trailing Distance */}
                  <div className="bg-zinc-900 p-3 rounded border border-amber-500/20 space-y-2">
                    <div className="flex justify-between items-center">
                      <span className="text-slate-300">Trailing Distance</span>
                      <span className="font-bold text-purple-400">-{profileConfig.trailingDistancePct}%</span>
                    </div>
                    <input
                      type="range"
                      min="0.1"
                      max="10"
                      step="0.1"
                      defaultValue={profileConfig.trailingDistancePct}
                      onMouseUp={(e) => onUpdateProfileSettings(activeProfile, { trailingDistancePct: Number(e.currentTarget.value) })}
                      onTouchEnd={(e) => onUpdateProfileSettings(activeProfile, { trailingDistancePct: Number(e.currentTarget.value) })}
                      className="w-full accent-purple-500"
                    />
                  </div>

                  {/* Min Momentum Score */}
                  <div className="bg-zinc-900 p-3 rounded border border-amber-500/20 space-y-2">
                    <div className="flex justify-between items-center">
                      <span className="text-slate-300">Min Momentum Score</span>
                      <span className="font-bold text-amber-400">{profileConfig.minMomentumScore || 0} / 100</span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      step="5"
                      defaultValue={profileConfig.minMomentumScore || 0}
                      onMouseUp={(e) => onUpdateProfileSettings(activeProfile, { minMomentumScore: Number(e.currentTarget.value) })}
                      onTouchEnd={(e) => onUpdateProfileSettings(activeProfile, { minMomentumScore: Number(e.currentTarget.value) })}
                      className="w-full accent-amber-500"
                    />
                  </div>

                  {/* Max Holding Time */}
                  <div className="bg-zinc-900 p-3 rounded border border-amber-500/20 space-y-2">
                    <div className="flex justify-between items-center">
                      <span className="text-slate-300">Max Hold Time (Min)</span>
                      <span className="font-bold text-amber-400">{profileConfig.maxHoldingTimeMinutes || 0}m</span>
                    </div>
                    <input
                      type="range"
                      min="5"
                      max="1440"
                      step="5"
                      defaultValue={profileConfig.maxHoldingTimeMinutes || 0}
                      onMouseUp={(e) => onUpdateProfileSettings(activeProfile, { maxHoldingTimeMinutes: Number(e.currentTarget.value) })}
                      onTouchEnd={(e) => onUpdateProfileSettings(activeProfile, { maxHoldingTimeMinutes: Number(e.currentTarget.value) })}
                      className="w-full accent-amber-500"
                    />
                  </div>

                  {/* Cooldown Minutes */}
                  <div className="bg-zinc-900 p-3 rounded border border-amber-500/20 space-y-2">
                    <div className="flex justify-between items-center">
                      <span className="text-slate-300">Cooldown (Minutes)</span>
                      <span className="font-bold text-cyan-400">{profileConfig.cooldownMinutes || 0}m</span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="1440"
                      step="5"
                      defaultValue={profileConfig.cooldownMinutes || 0}
                      onMouseUp={(e) => onUpdateProfileSettings(activeProfile, { cooldownMinutes: Number(e.currentTarget.value) })}
                      onTouchEnd={(e) => onUpdateProfileSettings(activeProfile, { cooldownMinutes: Number(e.currentTarget.value) })}
                      className="w-full accent-cyan-500"
                    />
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* RIGHT MODULE PANEL: AUDIT LOGS & TERMINAL COMMAND LINE (4 Cols on LG) */}
        <div className="lg:col-span-4 flex flex-col space-y-2">
          {/* Audit Logs / System Events */}
          <div className="bg-zinc-950 border border-amber-500/30 rounded p-3 flex flex-col h-[320px]">
            <div className="flex items-center justify-between border-b border-amber-500/30 pb-2 mb-2">
              <span className="font-bold text-xs tracking-wider text-amber-400">DESK AUDIT FEED</span>
              <span className="text-[10px] text-slate-400">{logs.length} Events</span>
            </div>
            <div className="overflow-y-auto flex-1 space-y-1 font-mono text-[11px] pr-1">
              {logs.slice(0, 40).map((log) => (
                <div key={log.id} className="bg-black p-1.5 rounded border border-zinc-900 hover:border-amber-500/20">
                  <div className="flex items-center justify-between text-[10px] text-slate-500">
                    <span className="font-bold text-amber-500">{log.type}</span>
                    <span>{new Date(log.timestamp).toLocaleTimeString()}</span>
                  </div>
                  <div className="text-zinc-300 mt-0.5">{log.message}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Terminal Command Line (`BLP >`) */}
          <div className="bg-zinc-950 border border-amber-500/30 rounded p-3 flex flex-col h-[280px]">
            <div className="flex items-center justify-between border-b border-amber-500/30 pb-2 mb-2">
              <span className="font-bold text-xs tracking-wider text-amber-400">BLOOMBERG COMMAND PROMPT</span>
              <span className="text-[10px] text-zinc-500">TYPE HELP</span>
            </div>

            <div className="overflow-y-auto flex-1 space-y-1 font-mono text-[11px] bg-black p-2 rounded border border-zinc-900 mb-2">
              {commandHistory.map((cmd, i) => (
                <div key={i} className={cmd.startsWith('>') ? 'text-cyan-400 font-bold' : 'text-amber-500/90'}>
                  {cmd}
                </div>
              ))}
            </div>

            <form onSubmit={handleCommandSubmit} className="flex items-center space-x-1">
              <span className="text-amber-400 font-bold text-xs">BLP &gt;</span>
              <input
                type="text"
                value={commandInput}
                onChange={(e) => setCommandInput(e.target.value)}
                placeholder="Enter command (e.g., HELP, SCALP, MOMENTUM, SCAN)..."
                className="flex-1 bg-black text-amber-400 placeholder:text-zinc-700 px-2 py-1 rounded border border-amber-500/40 text-xs font-mono focus:outline-none focus:border-amber-400"
              />
              <button
                type="submit"
                className="bg-amber-500 hover:bg-amber-400 text-black px-3 py-1 rounded text-xs font-bold"
              >
                EXEC
              </button>
            </form>
          </div>
        </div>
      </main>
    </div>
  );
};
