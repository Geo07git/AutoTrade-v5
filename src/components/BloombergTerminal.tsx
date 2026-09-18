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
  Save,
  ChevronDown,
  ChevronUp,
  FileText,
  Info,
  Download,
  Trash2,
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
  onClearLogs?: () => void;
  onClearOrders?: () => void;
  controlToken: string;
  onUpdateControlToken: (token: string) => void;
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
  onClearLogs,
  onClearOrders,
  controlToken,
  onUpdateControlToken,
  errorMessage,
  successMessage,
}) => {
  const profileConfig = status?.profileConfig;
  const activeProfile = status?.config?.activeProfile || 'MOMENTUM';

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
  const [equityProtAct, setEquityProtAct] = useState(profileConfig?.equityProtectionActivationPct ?? 0);
  const [equityTrailingDraw, setEquityTrailingDraw] = useState(profileConfig?.equityTrailingDrawdownPct ?? 0);
  const [riskPerTrade, setRiskPerTrade] = useState(profileConfig?.riskPerTradePct ?? 10);
  const [maxPositions, setMaxPositions] = useState(profileConfig?.maxOpenPositions ?? 5);
  const [hardStopLoss, setHardStopLoss] = useState(profileConfig?.hardStopLossPct ?? 2.5);
  const [trailingAct, setTrailingAct] = useState(profileConfig?.trailingActivationPct ?? 1.5);
  const [trailingDist, setTrailingDist] = useState(profileConfig?.trailingDistancePct ?? 0.4);
  const [minMomentum, setMinMomentum] = useState(profileConfig?.minMomentumScore ?? 60);
  const [takeProfit, setTakeProfit] = useState(profileConfig?.takeProfitPct ?? 0);
  const [breakEven, setBreakEven] = useState(profileConfig?.breakEvenActivationPct ?? 1.0);
  const [maxHoldTime, setMaxHoldTime] = useState(profileConfig?.maxHoldingTimeMinutes ?? 60);
  const [cooldownMins, setCooldownMins] = useState(profileConfig?.cooldownMinutes ?? 5);
  const [settingsSavedMessage, setSettingsSavedMessage] = useState<string | null>(null);
  const [expandedOrderId, setExpandedOrderId] = useState<string | null>(null);
  const [showClearOrdersConfirm, setShowClearOrdersConfirm] = useState(false);
  const [showClearLogsConfirm, setShowClearLogsConfirm] = useState(false);
  const [showTokenModal, setShowTokenModal] = useState(false);
  const [tempToken, setTempToken] = useState(controlToken);
  const [chartSymbol, setChartSymbol] = useState('BTCUSDT');
  const [symbolSearchQuery, setSymbolSearchQuery] = useState('');
  const [showSymbolDropdown, setShowSymbolDropdown] = useState(false);

  const allUniverseSymbols = Array.from(new Set([
    'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT',
    'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'SUIUSDT',
    'NEARUSDT', 'APTUSDT', 'OPUSDT', 'ARBUSDT', 'RENDERUSDT',
    'FETUSDT', 'INJUSDT', 'TIAUSDT', 'SEIUSDT', 'PEPEUSDT',
    'POLUSDT', 'ATOMUSDT', 'ICPUSDT', 'SHIBUSDT', 'WIFUSDT',
    'BONKUSDT', 'FLOKIUSDT', 'PENDLEUSDT', 'JUPUSDT', 'WLDUSDT',
    'CRVUSDT', 'AAVEUSDT', 'MKRUSDT', 'UNIUSDT', 'FILUSDT',
    'PUMPUSDT', 'IOSTUSDT', 'BOMEUSDT', 'AKEUSDT', 'TURBOUSDT',
    'ONEOUSDT', 'RESOLVUSDT', 'EDENUSDT', 'FLOCKUSDT', 'ENAUSDT',
    'MONUSDT', 'DGAIUSDT', 'PONSUSDT', 'TRIAUSDT', 'USELESSUSDT',
    'TONUSDT', 'LDOUSDT', 'GRTUSDT', 'RNDRUSDT', 'DYDXUSDT', 
    'GMXUSDT', 'IMXUSDT', 'COMPUSDT', 'SNXUSDT', 'AXSUSDT', 
    'SANDUSDT', 'MANAUSDT', 'CHZUSDT', 'THETAUSDT', 'FTMUSDT',
    ...(status?.marketOpportunities?.map(o => o.symbol) || []),
    ...(status?.scannerStats?.candidates?.map((c: any) => c.symbol) || [])
  ]));

  const filteredSymbols = allUniverseSymbols.filter(s =>
    s.toLowerCase().includes(symbolSearchQuery.toLowerCase())
  );

  const loadTradingViewChart = (symbol: string) => {
    setChartSymbol(symbol);
    setSymbolSearchQuery('');
    setShowSymbolDropdown(false);
    const script = document.createElement('script');
    script.src = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
    script.type = "text/javascript";
    script.async = true;
    const cleanSym = symbol.replace(/-SWAP$/i, '').replace(/-/g, '');
    script.innerHTML = JSON.stringify({
      "autosize": true,
      "symbol": `OKX:${cleanSym}.P`,
      "interval": "D",
      "timezone": "Etc/UTC",
      "theme": "dark",
      "style": "1",
      "locale": "en",
      "allow_symbol_change": true,
      "calendar": false,
      "support_host": "https://www.tradingview.com"
    });
    const container = document.getElementById('tradingview-widget-container');
    if (container) {
      container.innerHTML = '';
      container.appendChild(script);
    }
  };

  // Helper to export data as CSV / Excel-compatible format
  const exportToCSV = (filename: string, headers: string[], rows: (string | number)[][]) => {
    // Add UTF-8 BOM so Excel opens it with proper characters and encoding
    const BOM = '\uFEFF';
    const csvContent = [
      headers.map((h) => `"${h.replace(/"/g, '""')}"`).join(','),
      ...rows.map((row) =>
        row
          .map((val) => {
            const str = val !== undefined && val !== null ? String(val) : '';
            return `"${str.replace(/"/g, '""')}"`;
          })
          .join(',')
      ),
    ].join('\r\n');

    const blob = new Blob([BOM + csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleExportOrders = () => {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const headers = [
      'Order ID',
      'Exchange ID',
      'Symbol',
      'Side',
      'Intent',
      'Profile',
      'Execution Mode',
      'Size (USDT)',
      'Qty',
      'Price',
      'Fill Price',
      'Status',
      'PnL ($)',
      'PnL (%)',
      'Fee ($)',
      'Entry Price',
      'Exit Reason Detail',
      'Holding Time (min)',
      'Market Regime',
      'Created At',
      'Updated At',
    ];

    const rows = orders.map((o) => [
      o.id,
      o.exchangeOrderId || '',
      o.symbol,
      o.side === 'BUY' ? 'LONG' : 'SHORT',
      o.intent,
      o.profile,
      o.executionMode,
      o.sizeUSDT,
      o.qty,
      o.price || '',
      o.fillPrice || '',
      o.status,
      o.realizedPnl !== undefined ? o.realizedPnl : '',
      o.realizedPnlPct !== undefined ? o.realizedPnlPct : '',
      o.cumFee !== undefined ? o.cumFee : (o.sizeUSDT * 0.00055).toFixed(4),
      o.entryPrice || '',
      o.exitReasonDetail || '',
      o.holdingTimeMinutes || '',
      o.marketRegime || '',
      new Date(o.createdTime).toLocaleString(),
      o.updatedTime ? new Date(o.updatedTime).toLocaleString() : '',
    ]);

    exportToCSV(`TradeBot_Orders_${timestamp}.csv`, headers, rows);
  };

  const handleExportLogs = () => {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const headers = ['Log ID', 'Timestamp', 'Type', 'Message', 'Details'];

    const rows = logs.map((l) => [
      l.id,
      new Date(l.timestamp).toLocaleString(),
      l.type,
      l.message,
      l.details ? JSON.stringify(l.details) : '',
    ]);

    exportToCSV(`TradeBot_DeskLogs_${timestamp}.csv`, headers, rows);
  };

  const hasUnsavedSettings = profileConfig ? (
    riskPerTrade !== (profileConfig.riskPerTradePct ?? 10) ||
    maxPositions !== (profileConfig.maxOpenPositions ?? 5) ||
    hardStopLoss !== (profileConfig.hardStopLossPct ?? 2.5) ||
    trailingAct !== (profileConfig.trailingActivationPct ?? 1.5) ||
    trailingDist !== (profileConfig.trailingDistancePct ?? 0.4) ||
    minMomentum !== (profileConfig.minMomentumScore ?? 60) ||
    takeProfit !== (profileConfig.takeProfitPct ?? 0) ||
    breakEven !== (profileConfig.breakEvenActivationPct ?? 1.0) ||
    maxHoldTime !== (profileConfig.maxHoldingTimeMinutes ?? 60) ||
    equityProtAct !== (profileConfig.equityProtectionActivationPct ?? 0) ||
    equityTrailingDraw !== (profileConfig.equityTrailingDrawdownPct ?? 0) ||
    cooldownMins !== (profileConfig.cooldownMinutes ?? 5)
  ) : false;

  // Sync local state when profileConfig or activeProfile changes, but NOT if there are unsaved settings
  useEffect(() => {
    if (profileConfig && !hasUnsavedSettings) {
      setEquityProtAct(profileConfig.equityProtectionActivationPct ?? 0);
      setEquityTrailingDraw(profileConfig.equityTrailingDrawdownPct ?? 0);
      setRiskPerTrade(profileConfig.riskPerTradePct ?? 10);
      setMaxPositions(profileConfig.maxOpenPositions ?? 5);
      setHardStopLoss(profileConfig.hardStopLossPct ?? 2.5);
      setTrailingAct(profileConfig.trailingActivationPct ?? 1.5);
      setTrailingDist(profileConfig.trailingDistancePct ?? 0.4);
      setMinMomentum(profileConfig.minMomentumScore ?? 60);
      setTakeProfit(profileConfig.takeProfitPct ?? 0);
      setBreakEven(profileConfig.breakEvenActivationPct ?? 1.0);
      setMaxHoldTime(profileConfig.maxHoldingTimeMinutes ?? 60);
      setCooldownMins(profileConfig.cooldownMinutes ?? 5);
      setSettingsSavedMessage(null);
    }
  }, [profileConfig, activeProfile, hasUnsavedSettings]);

  const handleSaveAllSettings = () => {
    onUpdateProfileSettings(activeProfile, {
      riskPerTradePct: riskPerTrade,
      maxOpenPositions: maxPositions,
      hardStopLossPct: hardStopLoss,
      trailingActivationPct: trailingAct,
      trailingDistancePct: trailingDist,
      minMomentumScore: minMomentum,
      takeProfitPct: takeProfit,
      breakEvenActivationPct: breakEven,
      maxHoldingTimeMinutes: maxHoldTime,
      equityProtectionActivationPct: equityProtAct,
      equityTrailingDrawdownPct: equityTrailingDraw,
      cooldownMinutes: cooldownMins,
    });
    setSettingsSavedMessage('Modificările au fost salvate cu succes!');
    setTimeout(() => setSettingsSavedMessage(null), 3500);
  };

  const handleResetSettingsToSaved = () => {
    if (!profileConfig) return;
    setRiskPerTrade(profileConfig.riskPerTradePct ?? 10);
    setMaxPositions(profileConfig.maxOpenPositions ?? 5);
    setHardStopLoss(profileConfig.hardStopLossPct ?? 2.5);
    setTrailingAct(profileConfig.trailingActivationPct ?? 1.5);
    setTrailingDist(profileConfig.trailingDistancePct ?? 0.4);
    setMinMomentum(profileConfig.minMomentumScore ?? 60);
    setTakeProfit(profileConfig.takeProfitPct ?? 0);
    setBreakEven(profileConfig.breakEvenActivationPct ?? 1.0);
    setMaxHoldTime(profileConfig.maxHoldingTimeMinutes ?? 60);
    setEquityProtAct(profileConfig.equityProtectionActivationPct ?? 0);
    setEquityTrailingDraw(profileConfig.equityTrailingDrawdownPct ?? 0);
    setCooldownMins(profileConfig.cooldownMinutes ?? 5);
    setSettingsSavedMessage(null);
  };

  // =========================================================================
  // VITEZA REAL-TIME TAPE (SETEAZĂ DIRECT AICI ÎN COD):
  // 0.8 = lent/calm | 1.2 = normal/recomandat | 2.0 = rapid | 3.5 = ultra
  // =========================================================================
  const TAPE_SCROLL_SPEED = 1.2;

  // Derulare fluidă 60FPS fără blocaje sau tremur (folosind requestAnimationFrame și buclă infinită)
  useEffect(() => {
    const el = tickerRef.current;
    if (!el || tapeItems.length === 0) return;

    let animId: number;
    let pos = el.scrollLeft;
    let isHovered = false;

    const onEnter = () => { isHovered = true; };
    const onLeave = () => { isHovered = false; };
    el.addEventListener('mouseenter', onEnter);
    el.addEventListener('mouseleave', onLeave);

    const step = () => {
      if (el && !isHovered) {
        pos += TAPE_SCROLL_SPEED;
        const halfWidth = el.scrollWidth / 2;
        // Când ajunge la jumătate (sfârșitul primului set duplicat), resetăm lin fără niciun salt vizibil
        if (halfWidth > 0 && pos >= halfWidth) {
          pos -= halfWidth;
        }
        el.scrollLeft = pos;
      }
      animId = requestAnimationFrame(step);
    };

    animId = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(animId);
      el.removeEventListener('mouseenter', onEnter);
      el.removeEventListener('mouseleave', onLeave);
    };
  }, [tapeItems, TAPE_SCROLL_SPEED]);

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
      response = 'AVAILABLE COMMANDS: START, STOP, SCALP, MOMENTUM, SCAN, RESET, KILL, SAVELOG, CLEARLOG, CLEAR, PORT, TAPE, BLOT, SET';
    } else if (action === 'SCALP') {
      onSwitchProfile('SCALP');
      response = 'PROFILE SWITCHED TO SCALP (15m/60m, Aggressive)';
    } else if (action === 'MOMENTUM') {
      onSwitchProfile('MOMENTUM');
      response = 'PROFILE SWITCHED TO MOMENTUM (60m/240m, Trend)';
    } else if (action === 'SCAN') {
      onTriggerScan();
      response = 'MANUAL UNIVERSE SCAN INITIATED...';
    } else if (action === 'SAVELOG' || action === 'EXPORT') {
      handleExportOrders();
      handleExportLogs();
      response = 'EXPORTED ORDERS & AUDIT LOGS TO CSV/EXCEL FILES.';
    } else if (action === 'CLEARLOG') {
      if (onClearOrders) onClearOrders();
      if (onClearLogs) onClearLogs();
      response = 'ORDERS BLOTTER & AUDIT LOGS CLEARED.';
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

  const positions = status?.positions || [];
  const totalPnL = positions.reduce((acc, p) => acc + (p.pnl || 0), 0);
  const lockedCapital = positions.reduce((acc, p) => acc + (p.sizeUSDT || 0), 0);
  const isKillSwitch = status?.config?.killSwitchEngaged;

  return (
    <div className="min-h-screen bg-black text-amber-500 font-mono flex flex-col select-none overflow-x-hidden">
      {/* 1. BLOOMBERG TERMINAL TOP BANNER */}
      <header className="bg-amber-600 text-black px-3 py-1 flex flex-col md:flex-row md:items-center justify-between text-xs font-bold tracking-wider shrink-0 shadow-md gap-2 md:gap-0">
        <div className="flex items-center justify-between md:justify-start w-full md:w-auto space-x-2 md:space-x-3">
          <span className="bg-black text-amber-500 px-3 py-1 rounded text-base tracking-widest font-black border border-amber-500/50">
            <span className="hidden sm:inline">BLOOMBERG // TRADEBOT v5.0 PRO</span>
            <span className="sm:hidden">BBG // TRADEBOT</span>
          </span>
          <span className="hidden lg:inline">DESK: SECURE-QUANT-01</span>
          <span className="hidden lg:inline">|</span>
          <span className="hidden md:inline">FEED: {status?.config?.executionMode || 'PAPER'} (TESTNET)</span>
          <span className="hidden md:inline">|</span>
          <span className="font-mono text-[10px] bg-black text-amber-400 px-1.5 py-0.5 rounded border border-amber-500/50">{status?.marketRegime || 'BTC: --'}</span>
          <button
            onClick={() => {
              onResetPaper();
            }}
            className="md:hidden bg-zinc-900 text-amber-400 hover:bg-black px-2 py-0.5 rounded border border-amber-500/30 flex items-center space-x-1 text-[10px]"
          >
            <span>RESET BAL</span>
          </button>
        </div>
        <div className="flex items-center justify-between md:justify-end w-full md:w-auto space-x-2 md:space-x-4">
          <div className="flex items-center space-x-2 shrink-0">
            <span className="bg-black/90 text-emerald-400 px-2 py-0.5 rounded text-base font-mono">
              EQ: ${status?.equity !== undefined ? status.equity.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '200.00'}
            </span>
            <span className={`px-2 py-0.5 rounded text-base font-mono shrink-0 ${totalPnL >= 0 ? 'bg-emerald-950 text-emerald-400' : 'bg-rose-950 text-rose-400'}`}>
              PNL: {totalPnL >= 0 ? '+' : ''}${totalPnL.toFixed(2)}
            </span>
          </div>
          <div className="flex items-center space-x-2 shrink-0">
            <button
              onClick={() => setShowTokenModal(true)}
              className="bg-zinc-900 text-amber-400 hover:bg-black px-2 py-0.5 rounded border border-amber-500/30 flex items-center space-x-1 text-xs"
              title="Set Bot Control Token"
            >
              <span>AUTH</span>
            </button>
            <button
              onClick={() => {
                onResetPaper();
              }}
              className="hidden md:flex bg-zinc-900 text-amber-400 hover:bg-black px-2 py-0.5 rounded border border-amber-500/30 items-center space-x-1 text-xs"
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
      <div className="bg-zinc-950 border-b border-amber-500/30 px-3 py-1 text-[11px] flex items-center shrink-0 overflow-hidden relative">
        {/* Antet fix pe stânga */}
        <div className="flex items-center space-x-1.5 text-amber-400 font-bold shrink-0 z-20 bg-zinc-950 pr-3 border-r border-amber-500/30 shadow-[4px_0_10px_rgba(0,0,0,0.9)]">
          <Activity className="w-3.5 h-3.5 animate-pulse text-amber-500" />
          <span className="tracking-wider">AUTO-TAPE (24H % DESC) &gt;&gt;</span>
        </div>

        {/* Bandă date derulată fluid fără blocaje */}
        <div
          ref={tickerRef}
          className="flex-1 overflow-x-hidden whitespace-nowrap pl-3 select-none scrollbar-none"
          title="Trecerea cursorului peste bandă o pune pe pauză temporar"
        >
          <div className="inline-flex items-center space-x-6">
            {[...tapeItems, ...tapeItems].map((item, idx) => (
              <div key={`${item.id}_${idx}`} className="flex items-center space-x-2 bg-zinc-900/80 px-2 py-0.5 rounded border border-amber-500/20 shrink-0">
                <span className="text-slate-400">[{item.timestamp}]</span>
                <span className="font-bold text-amber-300">{item.symbol}</span>
                <span className={item.side === 'BUY' ? 'text-emerald-400 font-bold' : 'text-rose-400 font-bold'}>
                  {item.side === 'BUY' ? 'LONG' : 'SHORT'}
                </span>
                <span className="text-zinc-200">${item.price.toLocaleString()}</span>
                <span className="text-amber-400 text-[10px] font-bold">({item.size})</span>
              </div>
            ))}
          </div>
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
        {/* LEFT / CENTER MODULE CONTENT (6 Cols on LG) */}
        <div className="lg:col-span-6 flex flex-col space-y-2">
          {activeScreen === 'PORT' && (
            <div className="bg-zinc-950 border border-amber-500/30 rounded p-3 flex flex-col flex-1 min-h-[300px]">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between border-b border-amber-500/30 pb-2 mb-3 gap-2">
                <div className="flex items-center space-x-2">
                  <Terminal className="w-4 h-4 text-amber-500" />
                  <span className="font-bold text-sm tracking-wider">F1: ACTIVE PORTFOLIO &amp; POSITIONS</span>
                </div>
                <span className="text-xs text-slate-400">{positions.length} Open Positions</span>
              </div>

              {/* PORTFOLIO METRICS */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
                <div className="bg-black border border-amber-500/20 p-3 rounded">
                  <div className="text-slate-400 text-[10px] tracking-wider mb-1">SESSION REALIZED PNL</div>
                  <div className={`text-lg font-bold ${(status?.sessionRealizedPnL || 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {(status?.sessionRealizedPnL || 0) >= 0 ? '+' : ''}${(status?.sessionRealizedPnL || 0).toFixed(2)}
                  </div>
                </div>
                <div className="bg-black border border-amber-500/20 p-3 rounded">
                  <div className="text-slate-400 text-[10px] tracking-wider mb-1">TOTAL EXPOSURE (USDT)</div>
                  <div className="text-lg font-bold text-cyan-400">
                    ${lockedCapital.toFixed(2)}
                  </div>
                </div>
                <div className="bg-black border border-amber-500/20 p-3 rounded">
                  <div className="text-slate-400 text-[10px] tracking-wider mb-1">WIN RATE</div>
                  <div className="text-lg font-bold text-amber-400">
                    {status?.performanceMetrics?.winRate !== undefined ? `${status.performanceMetrics.winRate}%` : '0.00%'}
                    <span className="text-[10px] text-slate-500 font-normal ml-1">({status?.performanceMetrics?.winningTrades || 0}W / {status?.performanceMetrics?.losingTrades || 0}L)</span>
                  </div>
                </div>
                <div className="bg-black border border-amber-500/20 p-3 rounded">
                  <div className="text-slate-400 text-[10px] tracking-wider mb-1">PROFIT FACTOR</div>
                  <div className="text-lg font-bold text-amber-400">
                    {status?.performanceMetrics?.profitFactor !== undefined ? status.performanceMetrics.profitFactor : '0.00'}
                  </div>
                </div>
              </div>

              {/* ADVANCED STATS SUB-GRID */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4 bg-black border border-amber-500/20 p-3 rounded text-xs">
                <div>
                  <div className="text-slate-500 text-[10px]">EXPECTANCY (AVG/TR)</div>
                  <div className={`font-bold ${(status?.performanceMetrics?.expectancy || 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {(status?.performanceMetrics?.expectancy || 0) >= 0 ? '+' : ''}${status?.performanceMetrics?.expectancy?.toFixed(2) || '0.00'}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500 text-[10px]">MAX DRAWDOWN</div>
                  <div className="font-bold text-rose-400">
                    -{status?.performanceMetrics?.maxDrawdownPct?.toFixed(2) || '0.00'}%
                  </div>
                </div>
                <div>
                  <div className="text-slate-500 text-[10px]">AVG WIN / LOSS</div>
                  <div className="font-bold text-zinc-300">
                    +${status?.performanceMetrics?.avgWin?.toFixed(2) || '0.00'} / -${status?.performanceMetrics?.avgLoss?.toFixed(2) || '0.00'}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500 text-[10px]">TOTAL CLOSED TRADES</div>
                  <div className="font-bold text-amber-300">
                    {status?.performanceMetrics?.totalClosed || 0}
                  </div>
                </div>
              </div>

              {/* EQUITY TRAILING PROTECTION CARD */}
              {status?.equityTrailingState && (
                <div className="bg-black border border-amber-500/20 rounded p-3 mb-4">
                  <div className="flex items-center space-x-2 mb-2">
                    <ShieldAlert className="w-5 h-5 text-amber-500 shrink-0" />
                    <h3 className="font-bold text-amber-500 uppercase tracking-wider text-sm flex items-center gap-2">
                      EQUITY TRAILING PROTECTION
                      {status.equityTrailingState.isActive ? (
                        <span className="bg-emerald-950 text-emerald-400 border border-emerald-500/50 px-2 py-0.5 rounded text-[10px]">
                          ACTIV - URMĂREȘTE VÂRFUL
                        </span>
                      ) : (
                        <span className="bg-amber-950 text-amber-400 border border-amber-500/50 px-2 py-0.5 rounded text-[10px]">
                          AȘTEPTARE PROFIT (NECESITĂ +{status.equityTrailingState.activationPct.toFixed(2)}%)
                        </span>
                      )}
                    </h3>
                  </div>
                  
                  <p className="text-xs text-slate-400 mb-4">
                    {status.equityTrailingState.isActive 
                      ? `Urmărirea este activă. Se va închide automat la o retragere de ${status.equityTrailingState.drawdownLimitPct.toFixed(2)}% din vârful atins. Protecția a fost declanșată cu succes de ${status.equityTrailingState.triggerCount} ori până acum.`
                      : `Urmărirea se activează când contul atinge $${status.equityTrailingState.activationPrice.toFixed(2)} (+${status.equityTrailingState.activationPct.toFixed(2)}%). Până atunci pozițiile respiră liber. Protecția a fost declanșată cu succes de ${status.equityTrailingState.triggerCount} ori până acum.`}
                  </p>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
                    <div>
                      <div className="text-zinc-500 tracking-wider mb-1">PRAG ACTIVARE</div>
                      <div className="font-bold text-emerald-400">
                        ${status.equityTrailingState.activationPrice.toFixed(2)} <span className="text-[10px]">(+{status.equityTrailingState.activationPct.toFixed(2)}%)</span>
                      </div>
                    </div>
                    <div>
                      <div className="text-zinc-500 tracking-wider mb-1">HIGH-WATER MARK (PEAK)</div>
                      <div className="font-bold text-amber-100">
                        ${status.equityTrailingState.peakEquity.toFixed(2)}
                      </div>
                    </div>
                    <div>
                      <div className="text-zinc-500 tracking-wider mb-1">PRAG VÂNZARE</div>
                      <div className="font-bold text-zinc-300">
                        {status.equityTrailingState.sellThreshold 
                          ? `$${status.equityTrailingState.sellThreshold.toFixed(2)}`
                          : 'În așteptare'}
                      </div>
                    </div>
                    <div>
                      <div className="text-zinc-500 tracking-wider mb-1">RETRAGERE CURENTĂ</div>
                      <div className="font-bold text-emerald-400">
                        {status.equityTrailingState.currentDrawdownPct.toFixed(2)}%
                      </div>
                    </div>
                  </div>
                </div>
              )}

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
                        <th className="py-2 px-2">PnL (Net)</th>
                        <th className="py-2 px-2 text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-900 font-mono">
                      {positions.map((pos) => {
                        const isProfit = (pos.pnl || 0) >= 0;
                        return (
                          <tr key={pos.id} className="hover:bg-zinc-900/50">
                            <td className="py-2.5 px-2 font-bold text-amber-300">
                              {pos.symbol}
                              {(pos.entryFee || 0) > 0 && (
                                <span className="block text-[9px] text-zinc-500 font-normal">
                                  Fee: -${pos.entryFee?.toFixed(2)}
                                </span>
                              )}
                            </td>
                            <td className="py-2.5 px-2">
                              <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${pos.side === 'BUY' ? 'bg-emerald-950 text-emerald-400' : 'bg-rose-950 text-rose-400'}`}>
                                {pos.side === 'BUY' ? 'LONG' : 'SHORT'}
                              </span>
                            </td>
                            <td className="py-2.5 px-2">{pos.qty.toFixed(4)}</td>
                            <td className="py-2.5 px-2">${pos.entryPrice.toLocaleString()}</td>
                            <td className="py-2.5 px-2">${pos.sizeUSDT.toFixed(2)}</td>
                            <td className={`py-2.5 px-2 font-bold ${isProfit ? 'text-emerald-400' : 'text-rose-400'}`}>
                              {isProfit ? '+' : ''}${pos.pnl?.toFixed(2) || '0.00'} ({isProfit ? '+' : ''}{pos.pnlPct?.toFixed(2) || '0.00'}%)
                              {pos.grossPnl !== undefined && pos.grossPnl !== pos.pnl && (
                                <span className="block text-[9px] text-zinc-500 font-normal mt-0.5">
                                  Gross: {pos.grossPnl >= 0 ? '+' : ''}${pos.grossPnl.toFixed(2)}
                                </span>
                              )}
                            </td>
                            <td className="py-2.5 px-2 text-right">
                              <button
                                onClick={() => {
                                  onClosePosition(pos.symbol);
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
                        {item.side === 'BUY' ? 'LONG' : 'SHORT'}
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
                            <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                              opp.side === 'SELL' ? 'bg-rose-950 text-rose-400 border border-rose-800/60' : 'bg-emerald-950 text-emerald-400 border border-emerald-800/60'
                            }`}>
                              {opp.side === 'SELL' ? 'SHORT' : 'LONG'}
                            </span>
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
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-500/30 pb-2 mb-3">
                <div className="flex items-center space-x-2">
                  <List className="w-4 h-4 text-amber-500" />
                  <span className="font-bold text-sm tracking-wider">F4: ORDER EXECUTION BLOTTER &amp; AUDIT LOGS</span>
                  <span className="text-xs text-slate-400 font-mono">({orders.length} Orders)</span>
                </div>

                {/* Control Action Buttons: Save Log (CSV/Excel) & Clear Log */}
                <div className="flex items-center space-x-2">
                  <button
                    type="button"
                    onClick={handleExportOrders}
                    disabled={orders.length === 0}
                    className="inline-flex items-center space-x-1.5 px-2.5 py-1 rounded text-xs font-bold bg-emerald-950/80 hover:bg-emerald-900 border border-emerald-600/50 text-emerald-300 transition-colors disabled:opacity-40 disabled:cursor-not-allowed shadow-sm"
                    title="Exportă istoricul ordinelor în format CSV / Excel"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>SAVE LOG (EXCEL/CSV)</span>
                  </button>

                  {!showClearOrdersConfirm ? (
                    <button
                      type="button"
                      onClick={() => setShowClearOrdersConfirm(true)}
                      disabled={orders.length === 0}
                      className="inline-flex items-center space-x-1.5 px-2.5 py-1 rounded text-xs font-bold bg-rose-950/60 hover:bg-rose-900/80 border border-rose-600/40 text-rose-300 transition-colors disabled:opacity-40 disabled:cursor-not-allowed shadow-sm"
                      title="Șterge istoricul ordinelor curente"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>CLEAR LOG</span>
                    </button>
                  ) : (
                    <div className="flex items-center space-x-1.5 bg-rose-950 border border-rose-500 px-2 py-0.5 rounded text-xs font-mono">
                      <span className="text-rose-200 text-[11px] font-bold">Confirmi ștergerea?</span>
                      <button
                        type="button"
                        onClick={() => {
                          setShowClearOrdersConfirm(false);
                          if (onClearOrders) onClearOrders();
                        }}
                        className="px-2 py-0.5 bg-rose-600 hover:bg-rose-500 text-white rounded font-bold text-[11px]"
                      >
                        DA
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowClearOrdersConfirm(false)}
                        className="px-2 py-0.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded text-[11px]"
                      >
                        NU
                      </button>
                    </div>
                  )}
                </div>
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
                      <th className="py-2 px-2">PnL / Exit Log</th>
                      <th className="py-2 px-2 text-right">Time</th>
                      <th className="py-2 px-2 text-center">Log</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-900 font-mono">
                    {orders.slice(0, 30).map((ord) => {
                      const isExpanded = expandedOrderId === ord.id;
                      const hasPnl = ord.realizedPnl !== undefined;
                      const isProfit = (ord.realizedPnl ?? 0) >= 0;
                      const isCloseOrder = ord.intent !== 'ENTRY';
                      
                      // Fallback fee calculation if not present: 0.055% taker fee
                      const feeUSDT = ord.cumFee !== undefined ? ord.cumFee : (ord.sizeUSDT * 0.00055);

                      return (
                        <React.Fragment key={ord.id}>
                          <tr className={`hover:bg-zinc-900/60 transition-colors ${isExpanded ? 'bg-amber-950/20 border-l-2 border-l-amber-500' : ''}`}>
                            <td className="py-2 px-2 text-slate-400 text-[10px]">{ord.id.substring(0, 8)}</td>
                            <td className="py-2 px-2 font-bold text-amber-300">{ord.symbol}</td>
                            <td className="py-2 px-2">
                              <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${ord.side === 'BUY' ? 'bg-emerald-950 text-emerald-400' : 'bg-rose-950 text-rose-400'}`}>
                                {ord.side === 'BUY' ? 'LONG' : 'SHORT'}
                              </span>
                            </td>
                            <td className="py-2 px-2">
                              <span className={`px-1.5 py-0.5 rounded text-[10px] ${
                                ord.intent === 'TAKE_PROFIT' ? 'bg-emerald-950/80 text-emerald-300 font-bold border border-emerald-800/40' :
                                ord.intent === 'STOP_LOSS' ? 'bg-rose-950/80 text-rose-300 font-bold border border-rose-800/40' :
                                ord.intent === 'TRAILING_STOP' ? 'bg-amber-950/80 text-amber-300 font-bold border border-amber-800/40' :
                                ord.intent === 'EQUITY_PROTECTION' ? 'bg-purple-950/80 text-purple-300 font-bold border border-purple-800/40' :
                                ord.intent === 'MANUAL_CLOSE' || ord.intent === 'KILL_SWITCH' ? 'bg-orange-950/80 text-orange-300 border border-orange-800/40' :
                                'text-zinc-300'
                              }`}>
                                {ord.intent}
                              </span>
                            </td>
                            <td className="py-2 px-2 font-medium">${ord.sizeUSDT.toFixed(0)}</td>
                            <td className="py-2 px-2">
                              <span className={`text-[10px] font-bold ${
                                ord.status === 'FILLED' ? 'text-emerald-400' :
                                ord.status === 'REJECTED' || ord.status === 'CANCELLED' ? 'text-rose-400' :
                                'text-cyan-400'
                              }`}>
                                {ord.status}
                              </span>
                            </td>
                            <td className="py-2 px-2">
                              {hasPnl ? (
                                <span className={`font-bold text-[11px] ${isProfit ? 'text-emerald-400' : 'text-rose-400'}`}>
                                  {isProfit ? '+' : ''}${ord.realizedPnl?.toFixed(2)} ({isProfit ? '+' : ''}{ord.realizedPnlPct?.toFixed(2)}%)
                                </span>
                              ) : isCloseOrder ? (
                                <span className="text-zinc-500 text-[10px] italic">Închidere poziție</span>
                              ) : (
                                <span className="text-zinc-500 text-[10px]">—</span>
                              )}
                            </td>
                            <td className="py-2 px-2 text-right text-slate-400 text-[10px]">
                              {new Date(ord.createdTime).toLocaleTimeString()}
                            </td>
                            <td className="py-2 px-2 text-center">
                              <button
                                type="button"
                                onClick={() => setExpandedOrderId(isExpanded ? null : ord.id)}
                                className={`inline-flex items-center space-x-1 px-2 py-1 rounded text-[10px] font-bold border transition-all ${
                                  isExpanded
                                    ? 'bg-amber-500 text-black border-amber-400 shadow-sm'
                                    : 'bg-zinc-900 hover:bg-zinc-800 text-amber-400 border-amber-500/30 hover:border-amber-400'
                                }`}
                                title="Afișează log detaliat ordin"
                              >
                                <FileText className="w-3 h-3" />
                                <span>{isExpanded ? 'ASCUNDE' : 'SHOW LOG'}</span>
                                {isExpanded ? <ChevronUp className="w-2.5 h-2.5 ml-0.5" /> : <ChevronDown className="w-2.5 h-2.5 ml-0.5" />}
                              </button>
                            </td>
                          </tr>

                          {/* Expanded detailed audit log panel */}
                          {isExpanded && (
                            <tr className="bg-zinc-950/90 border-b border-amber-500/30">
                              <td colSpan={9} className="p-3 text-xs">
                                <div className="bg-zinc-900/90 border border-amber-500/40 rounded p-3 text-slate-200 space-y-2.5 shadow-inner">
                                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 pb-2">
                                    <div className="flex items-center space-x-2">
                                      <Info className="w-4 h-4 text-amber-400" />
                                      <span className="font-bold text-amber-400 uppercase tracking-wide">
                                        DETALII EXECUȚIE ORDIN: {ord.symbol} ({ord.side === 'BUY' ? 'LONG' : 'SHORT'}) [{ord.id}]
                                      </span>
                                    </div>
                                    <div className="flex items-center space-x-3 text-[11px] text-zinc-400">
                                      <span>Profil: <strong className="text-zinc-200">{ord.profile}</strong></span>
                                      <span>Mod: <strong className="text-amber-300">{ord.executionMode}</strong></span>
                                      <span>Creat: <strong className="text-zinc-200">{new Date(ord.createdTime).toLocaleString()}</strong></span>
                                    </div>
                                  </div>

                                  {/* Metric highlights */}
                                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                                    <div className="bg-black/60 border border-zinc-800 p-2 rounded">
                                      <div className="text-[10px] text-zinc-400 uppercase">Profit / Pierdere (Net PnL)</div>
                                      <div className={`text-sm font-bold mt-0.5 ${
                                        hasPnl
                                          ? isProfit ? 'text-emerald-400' : 'text-rose-400'
                                          : 'text-zinc-500'
                                      }`}>
                                        {hasPnl
                                          ? `${isProfit ? '+' : ''}$${ord.realizedPnl?.toFixed(2)} (${isProfit ? '+' : ''}${ord.realizedPnlPct?.toFixed(2)}%)`
                                          : 'N/A (Intrare)'}
                                      </div>
                                    </div>

                                    <div className="bg-black/60 border border-zinc-800 p-2 rounded">
                                      <div className="text-[10px] text-zinc-400 uppercase">Comision (Fee)</div>
                                      <div className="text-sm font-bold text-amber-300 mt-0.5">
                                        ${feeUSDT.toFixed(4)} <span className="text-[10px] text-zinc-400 font-normal">{(ord.cumFee !== undefined ? 'Realizat' : 'Estimativ (0.055%)')}</span>
                                      </div>
                                    </div>

                                    <div className="bg-black/60 border border-zinc-800 p-2 rounded">
                                      <div className="text-[10px] text-zinc-400 uppercase">Preț Execuție / Fill</div>
                                      <div className="text-sm font-bold text-zinc-200 mt-0.5">
                                        {ord.fillPrice ? `$${ord.fillPrice.toFixed(4)}` : 'La Piață (Market)'}
                                        {ord.entryPrice && (
                                          <span className="text-[10px] text-zinc-400 block font-normal">
                                            Intrare: ${ord.entryPrice.toFixed(4)}
                                          </span>
                                        )}
                                      </div>
                                    </div>

                                    <div className="bg-black/60 border border-zinc-800 p-2 rounded">
                                      <div className="text-[10px] text-zinc-400 uppercase">Cantitate / Dimensiune</div>
                                      <div className="text-sm font-bold text-zinc-200 mt-0.5">
                                        {ord.qty} {ord.symbol.replace('USDT', '')}
                                        <span className="text-[10px] text-zinc-400 block font-normal">
                                          ${ord.sizeUSDT.toFixed(2)} USDT
                                        </span>
                                      </div>
                                    </div>
                                    
                                    {ord.marketRegime && (
                                      <div className="bg-black/60 border border-zinc-800 p-2 rounded col-span-2 sm:col-span-4 mt-1">
                                        <div className="text-[10px] text-zinc-400 uppercase">Context Piață (BTC 24h Proxy)</div>
                                        <div className="text-sm font-bold text-amber-300 mt-0.5">
                                          {ord.marketRegime}
                                        </div>
                                      </div>
                                    )}
                                  </div>

                                  {/* Exit Reason & Triggers description */}
                                  <div className="bg-black/70 border border-zinc-800/80 p-2.5 rounded text-xs">
                                    <div className="text-[10px] text-amber-400 font-semibold uppercase tracking-wider mb-1">
                                      Motiv Închidere / Diagnostic Parametri:
                                    </div>
                                    <div className="text-zinc-200 font-mono text-[11px] leading-relaxed">
                                      {ord.exitReasonDetail ? (
                                        <p className="text-amber-200">{ord.exitReasonDetail}</p>
                                      ) : ord.intent === 'TAKE_PROFIT' ? (
                                        <p className="text-emerald-300 font-bold">
                                          Declanșat de <strong>Take-Profit</strong> (ținta automată procentuală de profit a fost atinsă cu succes).
                                        </p>
                                      ) : ord.intent === 'STOP_LOSS' ? (
                                        <p className="text-rose-300">
                                          Declanșat de <strong>Hard Stop-Loss</strong> (depășire limită maximă de pierdere permisă per profil).
                                        </p>
                                      ) : ord.intent === 'TRAILING_STOP' ? (
                                        <p className="text-amber-300">
                                          Declanșat de <strong>Trailing Stop</strong> (prețul s-a retras de la vârful maxim cu distanța setată).
                                          {ord.trailingPeakPct !== undefined && ` [Vârf PnL atins: +${ord.trailingPeakPct}%]`}
                                          {ord.trailingDistancePct !== undefined && ` [Retragere: ${ord.trailingDistancePct}%]`}
                                        </p>
                                      ) : ord.intent === 'EQUITY_PROTECTION' ? (
                                        <p className="text-purple-300">
                                          Declanșat de <strong>Equity Protection</strong> (drawdown al capitalului global de la vârf).
                                        </p>
                                      ) : ord.intent === 'TIME_STOP' ? (
                                        <p className="text-cyan-300">
                                          Declanșat de <strong>Max Holding Time</strong> (poziția a atins durata maximă permisă de menținere).
                                        </p>
                                      ) : ord.intent === 'MANUAL_CLOSE' ? (
                                        <p className="text-orange-300">Închidere manuală declanșată din interfața Bloomberg Terminal.</p>
                                      ) : ord.intent === 'KILL_SWITCH' ? (
                                        <p className="text-red-400 font-bold">Oprire forțată prin Kill Switch Operator.</p>
                                      ) : (
                                        <p className="text-zinc-400">Ordin de intrare (deschidere poziție) executat conform semnalului din scaner.</p>
                                      )}

                                      {ord.rejectionReason && (
                                        <div className="mt-1 text-rose-400 font-bold">
                                          Motiv respingere OKX: {ord.rejectionReason}
                                        </div>
                                      )}

                                      {ord.holdingTimeMinutes !== undefined && ord.holdingTimeMinutes > 0 && (
                                        <div className="mt-1 text-[10px] text-zinc-400">
                                          Timp menținere poziție: <span className="text-zinc-200 font-bold">{ord.holdingTimeMinutes} minute</span>
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {activeScreen === 'SET' && (
            <div className="bg-zinc-950 border border-amber-500/30 rounded p-3 flex flex-col h-full min-h-[450px]">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between border-b border-amber-500/30 pb-2 mb-3 gap-2">
                <div className="flex items-center space-x-2">
                  <Sliders className="w-4 h-4 text-amber-500" />
                  <span className="font-bold text-sm tracking-wider">F5: STRATEGY PARAMETERS ({activeProfile})</span>
                </div>
                
                <div className="flex items-center space-x-2">
                  {settingsSavedMessage && (
                    <span className="text-xs text-emerald-400 font-bold animate-pulse">
                      ✓ {settingsSavedMessage}
                    </span>
                  )}
                  {hasUnsavedSettings && (
                    <span className="text-[11px] text-amber-400 bg-amber-950/60 px-2 py-0.5 rounded border border-amber-500/40 animate-pulse">
                      ● Modificări nesalvate (Apasă SAVE CHANGES pentru a aplica)
                    </span>
                  )}
                  <button
                    onClick={handleResetSettingsToSaved}
                    disabled={!hasUnsavedSettings}
                    className="px-2 py-1 text-xs rounded border border-zinc-700 bg-zinc-900 text-zinc-400 hover:text-zinc-200 disabled:opacity-40 disabled:cursor-not-allowed"
                    title="Anulează modificările nesalvate"
                  >
                    Anulează
                  </button>
                  <button
                    onClick={handleSaveAllSettings}
                    disabled={!hasUnsavedSettings}
                    className={`px-3 py-1 text-xs font-bold rounded flex items-center space-x-1.5 transition-all shadow-md ${
                      hasUnsavedSettings
                        ? 'bg-amber-500 hover:bg-amber-400 text-black shadow-amber-500/20 animate-bounce'
                        : 'bg-zinc-800 text-zinc-500 cursor-not-allowed'
                    }`}
                  >
                    <Save className="w-3.5 h-3.5" />
                    <span>SAVE CHANGES</span>
                  </button>
                </div>
              </div>

              {/* ACTIVE RUNNING VALUES BANNER */}
              <div className="bg-black border border-amber-500/40 rounded p-2.5 mb-3 flex flex-wrap items-center justify-between text-[11px] font-mono gap-2">
                <div className="text-amber-300 font-bold flex items-center space-x-1.5">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block animate-ping"></span>
                  <span>VALORI ACTIVE (CU CARE CALCULEAZĂ BOTUL ÎN TIMP REAL):</span>
                </div>
                <div className="flex flex-wrap items-center gap-3 text-zinc-300">
                  <span>Risk: <strong className="text-amber-400">{profileConfig?.riskPerTradePct ?? 10}%</strong></span>
                  <span>StopLoss: <strong className="text-rose-400">-{profileConfig?.hardStopLossPct ?? 2.5}%</strong></span>
                  <span>TrailingAct: <strong className="text-emerald-400">+{profileConfig?.trailingActivationPct ?? 1.5}%</strong></span>
                  <span>TrailingDist: <strong className="text-purple-400">-{profileConfig?.trailingDistancePct ?? 0.4}%</strong></span>
                  <span>MinScore: <strong className="text-cyan-400">{profileConfig?.minMomentumScore ?? 60}</strong></span>
                </div>
              </div>

              {profileConfig && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                  {/* Risk Allocation - step 1 */}
                  <div className="bg-zinc-900 p-3 rounded border border-amber-500/20 space-y-2">
                    <div className="flex justify-between items-center">
                      <span className="text-slate-300">Risk Allocation</span>
                      <span className="font-bold text-amber-400">{riskPerTrade}% / trade</span>
                    </div>
                    <input
                      type="range"
                      min="1"
                      max="100"
                      step="1"
                      value={riskPerTrade}
                      onChange={(e) => setRiskPerTrade(Number(e.target.value))}
                      className="w-full accent-amber-500 cursor-pointer"
                    />
                  </div>

                  {/* Max Open Positions - step 1 */}
                  <div className="bg-zinc-900 p-3 rounded border border-amber-500/20 space-y-2">
                    <div className="flex justify-between items-center">
                      <span className="text-slate-300">Max Open Positions</span>
                      <span className="font-bold text-amber-400">{maxPositions}</span>
                    </div>
                    <input
                      type="range"
                      min="1"
                      max="20"
                      step="1"
                      value={maxPositions}
                      onChange={(e) => setMaxPositions(Number(e.target.value))}
                      className="w-full accent-amber-500 cursor-pointer"
                    />
                  </div>

                  {/* Hard Stop Loss - step 0.1 */}
                  <div className="bg-zinc-900 p-3 rounded border border-amber-500/20 space-y-2">
                    <div className="flex justify-between items-center">
                      <span className="text-slate-300">Hard Stop Loss</span>
                      <span className="font-bold text-rose-400">-{Number(hardStopLoss).toFixed(1)}%</span>
                    </div>
                    <input
                      type="range"
                      min="0.5"
                      max="20"
                      step="0.1"
                      value={hardStopLoss}
                      onChange={(e) => setHardStopLoss(Number(e.target.value))}
                      className="w-full accent-rose-500 cursor-pointer"
                    />
                  </div>

                  {/* Trailing Activation - step 0.1 */}
                  <div className="bg-zinc-900 p-3 rounded border border-amber-500/20 space-y-2">
                    <div className="flex justify-between items-center">
                      <span className="text-slate-300">Trailing Activation</span>
                      <span className="font-bold text-emerald-400">+{Number(trailingAct).toFixed(1)}%</span>
                    </div>
                    <input
                      type="range"
                      min="0.1"
                      max="20"
                      step="0.1"
                      value={trailingAct}
                      onChange={(e) => setTrailingAct(Number(e.target.value))}
                      className="w-full accent-emerald-500 cursor-pointer"
                    />
                  </div>

                  {/* Trailing Distance - step 0.05 */}
                  <div className="bg-zinc-900 p-3 rounded border border-amber-500/20 space-y-2">
                    <div className="flex justify-between items-center">
                      <span className="text-slate-300">Trailing Distance</span>
                      <span className="font-bold text-purple-400">-{Number(trailingDist).toFixed(2)}%</span>
                    </div>
                    <input
                      type="range"
                      min="0.05"
                      max="10"
                      step="0.05"
                      value={trailingDist}
                      onChange={(e) => setTrailingDist(Number(e.target.value))}
                      className="w-full accent-purple-500 cursor-pointer"
                    />
                  </div>

                  {/* Min Momentum Score - step 1 */}
                  <div className="bg-zinc-900 p-3 rounded border border-amber-500/20 space-y-2">
                    <div className="flex justify-between items-center">
                      <span className="text-slate-300">Min Momentum Score</span>
                      <span className="font-bold text-amber-400">{minMomentum} / 100</span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      step="1"
                      value={minMomentum}
                      onChange={(e) => setMinMomentum(Number(e.target.value))}
                      className="w-full accent-amber-500 cursor-pointer"
                    />
                  </div>

                  {/* Break-Even Activation (%) */}
                  <div className="bg-zinc-900 p-3 rounded border border-amber-500/20 space-y-2">
                    <div className="flex justify-between items-center">
                      <span className="text-slate-300">Break-Even Act (%)</span>
                      <span className="font-bold text-amber-400">{breakEven}%</span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="5"
                      step="0.1"
                      value={breakEven}
                      onChange={(e) => setBreakEven(Number(e.target.value))}
                      className="w-full accent-amber-500 cursor-pointer"
                    />
                  </div>

                  {/* Take-Profit (%) */}
                  <div className="bg-zinc-900 p-3 rounded border border-emerald-500/20 space-y-2">
                    <div className="flex justify-between items-center">
                      <span className="text-slate-300">Take-Profit (%)</span>
                      <span className="font-bold text-emerald-400">{takeProfit === 0 ? 'OFF' : `${takeProfit}%`}</span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="20"
                      step="0.5"
                      value={takeProfit}
                      onChange={(e) => setTakeProfit(Number(e.target.value))}
                      className="w-full accent-emerald-500 cursor-pointer"
                    />
                  </div>

                  {/* Max Holding Time - step 1 */}
                  <div className="bg-zinc-900 p-3 rounded border border-amber-500/20 space-y-2">
                    <div className="flex justify-between items-center">
                      <span className="text-slate-300">Max Hold Time (Min)</span>
                      <span className="font-bold text-amber-400">{maxHoldTime}m</span>
                    </div>
                    <input
                      type="range"
                      min="5"
                      max="1440"
                      step="1"
                      value={maxHoldTime}
                      onChange={(e) => setMaxHoldTime(Number(e.target.value))}
                      className="w-full accent-amber-500 cursor-pointer"
                    />
                  </div>

                  {/* Equity Protection Activation - step 0.1 */}
                  <div className="bg-zinc-900 p-3 rounded border border-amber-500/20 space-y-2">
                    <div className="flex justify-between items-center">
                      <span className="text-slate-300">Equity Protection Activation</span>
                      <span className="font-bold text-amber-400">+{Number(equityProtAct).toFixed(1)}%</span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="50"
                      step="0.1"
                      value={equityProtAct}
                      onChange={(e) => setEquityProtAct(Number(e.target.value))}
                      className="w-full accent-amber-500 cursor-pointer"
                    />
                  </div>

                  {/* Equity Trailing Drawdown - step 0.05 */}
                  <div className="bg-zinc-900 p-3 rounded border border-amber-500/20 space-y-2">
                    <div className="flex justify-between items-center">
                      <span className="text-slate-300">Equity Trailing Drawdown</span>
                      <span className="font-bold text-rose-400">-{Number(equityTrailingDraw).toFixed(2)}%</span>
                    </div>
                    <input
                      type="range"
                      min="0.05"
                      max="10"
                      step="0.05"
                      value={equityTrailingDraw}
                      onChange={(e) => setEquityTrailingDraw(Number(e.target.value))}
                      className="w-full accent-rose-500 cursor-pointer"
                    />
                  </div>

                  {/* Cooldown Minutes - step 1 */}
                  <div className="bg-zinc-900 p-3 rounded border border-amber-500/20 space-y-2">
                    <div className="flex justify-between items-center">
                      <span className="text-slate-300">Cooldown (Minutes)</span>
                      <span className="font-bold text-cyan-400">{cooldownMins}m</span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="1440"
                      step="1"
                      value={cooldownMins}
                      onChange={(e) => setCooldownMins(Number(e.target.value))}
                      className="w-full accent-cyan-500 cursor-pointer"
                    />
                  </div>
                </div>
              )}

              {/* Mobile bottom Save bar for easy reach */}
              {hasUnsavedSettings && (
                <div className="mt-4 pt-3 border-t border-amber-500/30 flex justify-end space-x-2">
                  <button
                    onClick={handleResetSettingsToSaved}
                    className="px-3 py-1.5 text-xs rounded border border-zinc-700 bg-zinc-900 text-zinc-300 hover:bg-zinc-800"
                  >
                    Anulează modificările
                  </button>
                  <button
                    onClick={handleSaveAllSettings}
                    className="px-4 py-1.5 text-xs font-bold rounded bg-amber-500 hover:bg-amber-400 text-black flex items-center space-x-1.5 shadow-lg shadow-amber-500/20"
                  >
                    <Save className="w-4 h-4" />
                    <span>SAVE CHANGES</span>
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* RIGHT MODULE PANEL: AUDIT LOGS & TRADINGVIEW CHART (6 Cols on LG) */}
        <div className="lg:col-span-6 flex flex-col space-y-2">
          {/* TradingView Widget */}
          <div className="bg-zinc-950 border border-amber-500/30 rounded p-3 flex flex-col h-[460px]">
            <div className="flex items-center justify-between border-b border-amber-500/30 pb-2 mb-2 relative">
              <span className="font-bold text-xs tracking-wider text-amber-400">MARKET CHART ({chartSymbol})</span>
              <div className="relative">
                <div className="flex items-center bg-black border border-amber-500/40 rounded px-1.5 py-0.5">
                  <Search className="w-3 h-3 text-amber-500 mr-1" />
                  <input
                    type="text"
                    placeholder="Caută simbol..."
                    value={symbolSearchQuery}
                    onFocus={() => setShowSymbolDropdown(true)}
                    onChange={(e) => {
                      setSymbolSearchQuery(e.target.value);
                      setShowSymbolDropdown(true);
                    }}
                    className="bg-transparent text-amber-400 text-[10px] outline-none w-[130px]"
                  />
                </div>
                {showSymbolDropdown && (
                  <div className="absolute right-0 top-full mt-1 w-48 bg-zinc-950 border border-amber-500/50 rounded shadow-xl max-h-60 overflow-y-auto z-50">
                    <div className="p-1 text-[9px] text-zinc-500 border-b border-zinc-800">
                      Simboluri Universe ({filteredSymbols.length})
                    </div>
                    {filteredSymbols.length > 0 ? (
                      filteredSymbols.map((sym) => (
                        <div
                          key={sym}
                          onClick={() => loadTradingViewChart(sym)}
                          className={`px-2 py-1.5 text-[10px] cursor-pointer hover:bg-amber-500/20 text-amber-300 font-mono flex items-center justify-between ${
                            chartSymbol === sym ? 'bg-amber-500/30 font-bold' : ''
                          }`}
                        >
                          <span>{sym}</span>
                          <span className="text-[9px] text-slate-500">OKX</span>
                        </div>
                      ))
                    ) : (
                      <div className="p-2 text-[10px] text-zinc-500 text-center">Niciun simbol găsit</div>
                    )}
                  </div>
                )}
              </div>
            </div>
            <div id="tradingview-widget-container" className="flex-1 w-full h-full"></div>
            {/* Load default chart on mount */}
            <div className="hidden">
              {(() => {
                setTimeout(() => {
                  const container = document.getElementById('tradingview-widget-container');
                  if (container && container.innerHTML === '') {
                    loadTradingViewChart('BTCUSDT');
                  }
                }, 100);
                return null;
              })()}
            </div>
          </div>

          {/* Audit Logs / System Events */}
          <div className="bg-zinc-950 border border-amber-500/30 rounded p-3 flex flex-col h-[320px]">
            <div className="flex flex-wrap items-center justify-between gap-1.5 border-b border-amber-500/30 pb-2 mb-2">
              <div className="flex items-center space-x-1.5">
                <span className="font-bold text-xs tracking-wider text-amber-400">DESK AUDIT FEED</span>
                <span className="text-[10px] text-slate-400 font-mono">({logs.length})</span>
              </div>

              <div className="flex items-center space-x-1.5">
                <button
                  type="button"
                  onClick={handleExportLogs}
                  disabled={logs.length === 0}
                  className="inline-flex items-center space-x-1 px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-950/80 hover:bg-emerald-900 border border-emerald-600/50 text-emerald-300 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  title="Exportă feed-ul de audit în format CSV / Excel"
                >
                  <Download className="w-3 h-3" />
                  <span>SAVE LOG</span>
                </button>

                {!showClearLogsConfirm ? (
                  <button
                    type="button"
                    onClick={() => setShowClearLogsConfirm(true)}
                    disabled={logs.length === 0}
                    className="inline-flex items-center space-x-1 px-2 py-0.5 rounded text-[10px] font-bold bg-rose-950/60 hover:bg-rose-900/80 border border-rose-600/40 text-rose-300 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    title="Șterge feed-ul de evenimente"
                  >
                    <Trash2 className="w-3 h-3" />
                    <span>CLEAR LOG</span>
                  </button>
                ) : (
                  <div className="flex items-center space-x-1 bg-rose-950 border border-rose-500 px-1.5 py-0.5 rounded text-[10px] font-mono">
                    <span className="text-rose-200">Ștergi?</span>
                    <button
                      type="button"
                      onClick={() => {
                        setShowClearLogsConfirm(false);
                        if (onClearLogs) onClearLogs();
                      }}
                      className="px-1.5 py-0.2 bg-rose-600 hover:bg-rose-500 text-white rounded font-bold"
                    >
                      DA
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowClearLogsConfirm(false)}
                      className="px-1.5 py-0.2 bg-zinc-800 text-zinc-300 rounded"
                    >
                      NU
                    </button>
                  </div>
                )}
              </div>
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
        </div>
      </main>

      {/* Bot Control Token Modal */}
      {showTokenModal && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
          <div className="bg-zinc-950 border-2 border-amber-500 rounded p-4 max-w-sm w-full">
            <h3 className="text-amber-500 font-bold mb-3 flex items-center space-x-2">
              <ShieldAlert className="w-5 h-5" />
              <span>BOT CONTROL TOKEN</span>
            </h3>
            <p className="text-xs text-slate-400 mb-4 leading-relaxed">
              Introduceți token-ul de administrare (Bot Control Token) pentru a autoriza acțiuni precum SCAN, schimbare profil, etc. Acest token este salvat local în browserul dumneavoastră.
            </p>
            <input
              type="password"
              value={tempToken}
              onChange={(e) => setTempToken(e.target.value)}
              placeholder="Enter control token..."
              className="w-full bg-black text-amber-400 placeholder:text-zinc-700 px-3 py-2 rounded border border-amber-500/40 text-sm font-mono focus:outline-none focus:border-amber-400 mb-4"
            />
            <div className="flex justify-end space-x-3">
              <button
                onClick={() => {
                  setTempToken(controlToken);
                  setShowTokenModal(false);
                }}
                className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded text-xs font-bold"
              >
                CANCEL
              </button>
              <button
                onClick={() => {
                  onUpdateControlToken(tempToken);
                  setShowTokenModal(false);
                }}
                className="px-3 py-1.5 bg-amber-500 hover:bg-amber-400 text-black rounded text-xs font-bold"
              >
                SAVE TOKEN
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
