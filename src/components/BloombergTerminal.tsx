/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import React, { useState, useEffect, useRef } from 'react';
import { LineChart, Line, ResponsiveContainer, YAxis, Tooltip, XAxis, CartesianGrid } from 'recharts';
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

  const [activeScreen, setActiveScreen] = useState<'PORT' | 'POS' | 'TAPE' | 'SCAN' | 'BLOT' | 'SET' | 'INFO'>('PORT');
  const [expandedPositionIds, setExpandedPositionIds] = useState<Record<string, boolean>>({});

  const toggleExpandPosition = (id: string) => {
    setExpandedPositionIds((prev) => ({ ...prev, [id]: !prev[id] }));
  };

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
  const [lang, setLang] = useState<'EN' | 'RO'>('RO');

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
      o.cumFee !== undefined ? o.cumFee : (o.sizeUSDT * 0.0005).toFixed(4),
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
      response = 'AVAILABLE COMMANDS: START, STOP, SCALP, MOMENTUM, SCAN, RESET, KILL, SAVELOG, CLEARLOG, CLEAR, PORT, POS, SCAN, BLOT, SET';
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
      response = 'SWITCHED TO F1: PORTFOLIO & RISK';
    } else if (action === 'POS' || action === 'TAPE' || action === 'F2') {
      setActiveScreen('POS');
      response = 'SWITCHED TO F2: OPEN POSITIONS';
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
  const currentEquity = status?.equity !== undefined ? status.equity : 200.0;
  const initialEquity = status?.initialEquity !== undefined ? status.initialEquity : 200.0;
  const activePositions = positions.filter((p) => p.status === 'OPEN');

  const marginInvested = status?.marginInvested !== undefined
    ? status.marginInvested
    : activePositions.reduce((acc, p) => acc + (p.sizeUSDT || 0), 0);

  const unrealizedPnL = status?.unrealizedPnL !== undefined
    ? status.unrealizedPnL
    : activePositions.reduce((acc, p) => acc + (p.pnl || 0), 0);

  const unrealizedPnLPct = marginInvested > 0 ? (unrealizedPnL / marginInvested) * 100 : 0;

  const walletBalance = status?.walletBalance !== undefined
    ? status.walletBalance
    : (currentEquity - unrealizedPnL);

  const freeBalance = status?.freeBalance !== undefined
    ? status.freeBalance
    : Math.max(0, walletBalance - marginInvested);

  const totalProfit = status?.totalProfit !== undefined
    ? status.totalProfit
    : (currentEquity - initialEquity);

  const totalProfitPct = status?.totalProfitPct !== undefined
    ? status.totalProfitPct
    : (initialEquity > 0 ? (totalProfit / initialEquity) * 100 : 0);

  const totalPnL = unrealizedPnL;
  const lockedCapital = marginInvested;
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
            <span className="hidden sm:inline">Portfolio &amp; Risk</span>
          </button>

          <button
            onClick={() => setActiveScreen('POS')}
            className={`px-3 py-1 rounded font-bold text-xs transition-colors flex items-center space-x-1.5 shrink-0 ${
              activeScreen === 'POS' || activeScreen === 'TAPE' ? 'bg-amber-500 text-black shadow-lg shadow-amber-500/20' : 'bg-black text-amber-500 hover:bg-zinc-800 border border-amber-500/40'
            }`}
          >
            <span>[2:POS]</span>
            <span className="hidden sm:inline">Open Positions ({positions.length})</span>
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

          <button
            onClick={() => setActiveScreen('INFO')}
            className={`px-3 py-1 rounded font-bold text-xs transition-colors flex items-center space-x-1.5 shrink-0 ${
              activeScreen === 'INFO' ? 'bg-amber-500 text-black shadow-lg shadow-amber-500/20' : 'bg-black text-amber-500 hover:bg-zinc-800 border border-amber-500/40'
            }`}
          >
            <span>[6:INFO]</span>
            <span className="hidden sm:inline">{lang === 'EN' ? 'App Info & Build' : 'Info & Executabil'}</span>
          </button>

          {/* Language Switcher Switch (EN / RO) */}
          <div className="flex bg-black rounded border border-amber-500/40 p-0.5 shrink-0 ml-2">
            <button
              onClick={() => setLang('EN')}
              className={`px-2 py-0.5 rounded text-[11px] font-bold ${
                lang === 'EN' ? 'bg-amber-500 text-black' : 'text-amber-500 hover:text-amber-300'
              }`}
            >
              EN
            </button>
            <button
              onClick={() => setLang('RO')}
              className={`px-2 py-0.5 rounded text-[11px] font-bold ${
                lang === 'RO' ? 'bg-amber-500 text-black' : 'text-amber-500 hover:text-amber-300'
              }`}
            >
              RO
            </button>
          </div>
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
                <div className="flex items-center space-x-2">
                  <span className="text-xs text-slate-400">{positions.length} Open Positions</span>
                  <button
                    onClick={() => onResetPaper()}
                    className="bg-zinc-900 hover:bg-zinc-800 text-amber-400 hover:text-amber-300 px-2 py-0.5 rounded border border-amber-500/30 text-[11px] flex items-center space-x-1"
                    title="Resetează contul Paper la $200.00 curat"
                  >
                    <span>RESET CONT $200</span>
                  </button>
                </div>
              </div>

              {/* TRADEBOT 4 ACCOUNTING METRICS (DYNAMIC LANG) */}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-3">
                {/* 1. FREE BALANCE */}
                <div className="bg-black border border-zinc-800 p-2 sm:p-3 rounded">
                  <div className="text-slate-400 text-[10px] sm:text-xs font-bold tracking-wider mb-0.5 sm:mb-1">
                    {lang === 'EN' ? 'FREE BALANCE' : 'SOLD DISPONIBIL'}
                  </div>
                  <div className="text-base sm:text-xl font-bold font-mono text-amber-400">
                    ${freeBalance.toFixed(2)}
                  </div>
                </div>

                {/* 2. MARGIN (INVESTED) */}
                <div className="bg-black border border-zinc-800 p-2 sm:p-3 rounded">
                  <div className="text-slate-400 text-[10px] sm:text-xs font-bold tracking-wider mb-0.5 sm:mb-1">
                    {lang === 'EN' ? 'MARGIN (INVESTED)' : 'MARJĂ INVESTITĂ'}
                  </div>
                  <div className="text-base sm:text-xl font-bold font-mono text-amber-400">
                    ${marginInvested.toFixed(2)}
                  </div>
                </div>

                {/* 3. TOTAL EQUITY */}
                <div className="bg-black border border-emerald-500/50 p-2 sm:p-3 rounded shadow-[0_0_12px_rgba(16,185,129,0.12)]">
                  <div className="text-emerald-400 text-[10px] sm:text-xs font-bold tracking-wider mb-0.5 sm:mb-1">
                    {lang === 'EN' ? 'TOTAL EQUITY' : 'VALOARE TOTALĂ (EQUITY)'}
                  </div>
                  <div className="text-base sm:text-xl font-bold font-mono text-emerald-400">
                    ${currentEquity.toFixed(2)}
                  </div>
                </div>

                {/* 4. UNREALIZED PNL */}
                <div className="bg-black border border-zinc-800 p-2 sm:p-3 rounded">
                  <div className="text-slate-400 text-[10px] sm:text-xs font-bold tracking-wider mb-0.5 sm:mb-1">
                    {lang === 'EN' ? 'UNREALIZED PNL' : 'PNL NEREALIZAT'}
                  </div>
                  <div className={`text-sm sm:text-lg font-bold font-mono ${unrealizedPnL >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {unrealizedPnL >= 0 ? '+' : ''}${unrealizedPnL.toFixed(2)}
                    <span className="text-[10px] sm:text-xs ml-0.5 font-normal opacity-90">
                      ({unrealizedPnL >= 0 ? '+' : ''}{unrealizedPnLPct.toFixed(2)}%)
                    </span>
                  </div>
                </div>

                {/* 5. TOTAL PROFIT */}
                <div className="bg-black border border-zinc-800 p-2 sm:p-3 rounded">
                  <div className="text-slate-400 text-[10px] sm:text-xs font-bold tracking-wider mb-0.5 sm:mb-1">
                    {lang === 'EN' ? 'TOTAL PROFIT' : 'PROFIT TOTAL'}
                  </div>
                  <div className={`text-sm sm:text-lg font-bold font-mono ${totalProfit >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {totalProfit >= 0 ? '+' : ''}${totalProfit.toFixed(2)}
                    <span className="text-[10px] sm:text-xs ml-0.5 font-normal opacity-90">
                      ({totalProfit >= 0 ? '+' : ''}{totalProfitPct.toFixed(2)}%)
                    </span>
                  </div>
                </div>

                {/* 6. ACTIVE POSITIONS */}
                <div className="bg-black border border-zinc-800 p-2 sm:p-3 rounded flex flex-col justify-between">
                  <div className="flex items-center justify-between mb-0.5 sm:mb-1">
                    <div className="text-slate-400 text-[10px] sm:text-xs font-bold tracking-wider">
                      {lang === 'EN' ? 'ACTIVE POSITIONS' : 'POZIȚII ACTIVE'}
                    </div>
                    <div className="text-[9px] font-mono px-1.5 py-0.2 rounded bg-amber-950/60 border border-amber-500/40 text-amber-300">
                      {status?.marketSentiment ? (lang === 'EN' ? status.marketSentiment.replace('BULLISH', 'BULLISH').replace('BEARISH', 'BEARISH').replace('NEUTRAL', 'NEUTRAL') : status.marketSentiment) : (lang === 'EN' ? 'OKX NEUTRAL' : 'OKX NEUTRU')}
                    </div>
                  </div>
                  <div className="flex items-baseline justify-between">
                    <div className="text-base sm:text-xl font-bold font-mono text-cyan-400">
                      {activePositions.length} <span className="text-[10px] text-zinc-500 font-normal">/ 5 max</span>
                    </div>
                    <div className="text-[10px] text-zinc-400 font-mono">
                      Cap: {Math.round((activePositions.length / 5) * 100)}%
                    </div>
                  </div>
                </div>
              </div>

              {/* ADVANCED STATS SUB-GRID */}
              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2 mb-4 bg-black border border-amber-500/20 p-3 rounded text-xs">
                <div>
                  <div className="text-slate-500 text-[10px]">SESSION REALIZED</div>
                  <div className={`font-bold ${(status?.sessionRealizedPnL || 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {(status?.sessionRealizedPnL || 0) >= 0 ? '+' : ''}${(status?.sessionRealizedPnL || 0).toFixed(2)}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500 text-[10px]">WIN RATE</div>
                  <div className="font-bold text-amber-400">
                    {status?.performanceMetrics?.winRate !== undefined ? `${status.performanceMetrics.winRate}%` : '0.00%'}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500 text-[10px]">PROFIT FACTOR</div>
                  <div className="font-bold text-amber-400">
                    {status?.performanceMetrics?.profitFactor !== undefined ? status.performanceMetrics.profitFactor : '0.00'}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500 text-[10px]">EXPECTANCY</div>
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
                  <div className="text-slate-500 text-[10px]">TOTAL FEES (FEE)</div>
                  <div className="font-bold text-rose-400">
                    -${status?.performanceMetrics?.totalFeesPaid?.toFixed(2) || '0.00'}
                  </div>
                </div>
                <div>
                  <div className="text-slate-500 text-[10px]">CLOSED TRADES</div>
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
                      {!status.equityTrailingState.isEnabled || status.equityTrailingState.activationPct <= 0 || status.equityTrailingState.drawdownLimitPct <= 0 ? (
                        <span className="bg-zinc-800 text-zinc-400 border border-zinc-700 px-2 py-0.5 rounded text-[10px]">
                          DEZACTIVAT (PRAG 0%)
                        </span>
                      ) : status.equityTrailingState.isActive ? (
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
                    {!status.equityTrailingState.isEnabled || status.equityTrailingState.activationPct <= 0 || status.equityTrailingState.drawdownLimitPct <= 0
                      ? 'Protecția de capital este DEZACTIVATĂ (setată la 0%). Pozițiile sunt controlate exclusiv de Stop-Loss, Trailing Stop și Take-Profit individuale.'
                      : status.equityTrailingState.isActive 
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

              {/* OKX Market Sentiment Card mimicking user screenshot */}
              <div className="mt-4 bg-zinc-950 border border-amber-500/30 p-4 rounded flex flex-col items-center justify-center font-mono">
                <div className="text-[11px] text-zinc-400 tracking-wider mb-3">SENTIMENT SCORE</div>
                
                {(() => {
                  const sentimentStr = status?.marketSentiment || 'NEUTRAL';
                  let score = 78;
                  let label = 'Lăcomie';
                  let color = '#10b981'; // emerald
                  if (sentimentStr.includes('BEARISH')) {
                    score = 22;
                    label = 'Frică';
                    color = '#f43f5e';
                  } else if (sentimentStr.includes('NEUTRAL')) {
                    score = 50;
                    label = 'Neutru';
                    color = '#f59e0b';
                  }

                  // Semi-circle gauge calculation
                  const angle = (score / 100) * 180 - 90;
                  const rad = (angle * Math.PI) / 180;
                  const cx = 70;
                  const cy = 60;
                  const r = 46;
                  const nx = cx + r * Math.sin(rad);
                  const ny = cy - r * Math.cos(rad);

                  return (
                    <div className="flex flex-col items-center">
                      <div className="relative w-36 h-20 flex items-end justify-center mb-2">
                        <svg className="w-36 h-36 absolute -top-4" viewBox="0 0 140 100">
                          {/* Arc segments for Red, Yellow, Green */}
                          <path d="M 20 60 A 46 46 0 0 1 50 25" fill="none" stroke="#f43f5e" strokeWidth="10" strokeLinecap="round" />
                          <path d="M 52 24 A 46 46 0 0 1 88 24" fill="none" stroke="#f59e0b" strokeWidth="10" strokeLinecap="round" />
                          <path d="M 90 25 A 46 46 0 0 1 120 60" fill="none" stroke="#10b981" strokeWidth="10" strokeLinecap="round" />
                          {/* Needle line */}
                          <line x1={cx} y1={cy} x2={nx} y2={ny} stroke="#ffffff" strokeWidth="3" strokeLinecap="round" />
                          <circle cx={cx} cy={cy} r="5" fill="#ffffff" />
                        </svg>
                      </div>
                      <div className="text-3xl font-bold font-serif text-white tracking-wide mt-1">
                        {score}
                      </div>
                      <div className="text-sm font-medium tracking-wide mt-0.5" style={{ color }}>
                        {label}
                      </div>
                      <div className="text-[10px] text-zinc-500 mt-2">
                        Calculat pe baza semnalelor active din lista de urmărire.
                      </div>
                    </div>
                  );
                })()}
              </div>
            </div>
          )}

          {activeScreen === 'INFO' && (
            <div className="bg-zinc-950 border border-amber-500/30 rounded p-4 sm:p-6 flex flex-col h-full min-h-[520px] font-mono text-zinc-300 space-y-6">
              <div className="flex items-center space-x-2 border-b border-amber-500/30 pb-3">
                <Info className="w-5 h-5 text-amber-500" />
                <h2 className="text-base font-bold text-amber-400 tracking-wider">
                  {lang === 'EN' ? 'DESK INFORMATION & ELECTRON BUILD GUIDE' : 'INFORMAȚII DESK & GHID BUILD EXECUTABIL ELECTRON'}
                </h2>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 text-xs leading-relaxed">
                {/* Left Column: Local Execution */}
                <div className="bg-black border border-zinc-800 p-4 rounded space-y-3">
                  <h3 className="font-bold text-amber-400 text-sm border-b border-zinc-800 pb-2 flex items-center space-x-2">
                    <span className="w-2 h-2 rounded-full bg-amber-500"></span>
                    <span>{lang === 'EN' ? '1. Running Locally' : '1. Rulare Locală'}</span>
                  </h3>
                  <p className="text-zinc-400">
                    {lang === 'EN' 
                      ? 'To run the entire Bloomberg TradeBot stack locally on your machine with full API integration:'
                      : 'Pentru a rula întreaga aplicație Bloomberg TradeBot local pe calculatorul tău cu integrare API completă:'}
                  </p>
                  <div className="bg-zinc-900 p-2.5 rounded border border-zinc-800 text-amber-300 font-mono text-[11px] space-y-1">
                    <div># 1. Install dependencies</div>
                    <div className="text-white">npm install</div>
                    <div className="pt-1"># 2. Start development server</div>
                    <div className="text-white">npm run dev</div>
                  </div>
                  <p className="text-[11px] text-zinc-500">
                    {lang === 'EN'
                      ? 'The server runs on http://localhost:3000 with Express backend and Vite frontend.'
                      : 'Serverul rulează pe http://localhost:3000 cu backend Express și frontend Vite.'}
                  </p>
                </div>

                {/* Right Column: Electron & .exe Build */}
                <div className="bg-black border border-zinc-800 p-4 rounded space-y-3">
                  <h3 className="font-bold text-amber-400 text-sm border-b border-zinc-800 pb-2 flex items-center space-x-2">
                    <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
                    <span>{lang === 'EN' ? '2. Building Windows .exe (Electron)' : '2. Generare Executabil Windows (.exe)'}</span>
                  </h3>
                  <p className="text-zinc-400">
                    {lang === 'EN'
                      ? 'Electron is fully configured. You can test in desktop mode or package a standalone executable installer (.exe):'
                      : 'Electron este configurat complet. Poți testa în mod desktop sau poți genera pachetul instalabil (.exe):'}
                  </p>
                  <div className="bg-zinc-900 p-2.5 rounded border border-zinc-800 text-amber-300 font-mono text-[11px] space-y-1">
                    <div># Test app in Electron desktop window</div>
                    <div className="text-white">npm run electron:dev</div>
                    <div className="pt-1"># Build Windows .exe installer & portable</div>
                    <div className="text-white">npm run electron:build</div>
                  </div>
                  <p className="text-[11px] text-zinc-500">
                    {lang === 'EN'
                      ? 'Outputs will be generated in the /release directory (NSIS installer & portable binaries).'
                      : 'Fișierele generate vor fi salvate în directorul /release (instalator NSIS și binar portabil).'}
                  </p>
                </div>
              </div>

              <div className="bg-amber-950/20 border border-amber-500/30 p-3 rounded text-[11px] text-amber-300/90 flex items-start space-x-2 mt-auto">
                <Info className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                <div>
                  <strong className="text-amber-400">Notă Bloomberg Desk:</strong> Acest terminal asigură un mediu de tranzacționare cu risc controlat, feed-uri live de la OKX și execuție automatizată în timp real. Asigurați-vă că aveți jetoanele de control configurate corect.
                </div>
              </div>
            </div>
          )}

          {(activeScreen === 'POS' || activeScreen === 'TAPE') && (
            <div className="bg-zinc-950 border border-amber-500/30 rounded p-3 flex flex-col h-full min-h-[480px]">
              {/* Header */}
              <div className="flex flex-wrap items-center justify-between border-b border-amber-500/30 pb-2 mb-3 gap-2">
                <div className="flex items-center space-x-2">
                  <Activity className="w-4 h-4 text-amber-500" />
                  <span className="font-bold text-sm tracking-wider text-amber-400">
                    F2: OPEN POSITIONS &amp; ACTIVE EXPOSURE
                  </span>
                  <span className="text-xs bg-amber-950 text-amber-300 px-2 py-0.5 rounded border border-amber-500/40 font-mono">
                    {positions.length} {positions.length === 1 ? 'POZIȚIE' : 'POZIȚII'}
                  </span>
                </div>

                <div className="flex items-center space-x-3 text-xs font-mono">
                  <span className="text-zinc-400">
                    Marjă Investită: <strong className="text-amber-400">${marginInvested.toFixed(2)}</strong>
                  </span>
                  <span className="text-zinc-400">
                    PnL Nerealizat:{' '}
                    <strong className={unrealizedPnL >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                      {unrealizedPnL >= 0 ? '+' : ''}${unrealizedPnL.toFixed(2)}
                    </strong>
                  </span>
                </div>
              </div>

              {/* Instructions banner */}
              <div className="bg-black/60 border border-amber-500/20 rounded px-2.5 py-1.5 mb-3 flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono text-zinc-400">
                <div className="flex items-center space-x-1.5">
                  <Info className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                  <span>Apasă pe oricare poziție pentru a extinde detaliile complete (preț actual, minute deținere, stare trailing).</span>
                </div>
                {positions.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      const allExpanded = positions.every((p) => expandedPositionIds[p.id]);
                      const newMap: Record<string, boolean> = {};
                      if (!allExpanded) {
                        positions.forEach((p) => { newMap[p.id] = true; });
                      }
                      setExpandedPositionIds(newMap);
                    }}
                    className="text-[10px] text-amber-400 hover:text-amber-300 underline font-bold shrink-0"
                  >
                    {positions.every((p) => expandedPositionIds[p.id]) ? 'Restrânge Toate' : 'Extinde Toate'}
                  </button>
                )}
              </div>

              {/* Empty state */}
              {positions.length === 0 ? (
                <div className="flex-1 flex flex-col items-center justify-center text-zinc-500 py-16 space-y-3">
                  <Activity className="w-10 h-10 opacity-30 animate-pulse text-amber-500" />
                  <p className="text-sm font-bold tracking-wider text-zinc-400">NU EXISTĂ POZIȚII DESCHISE ÎN ACEST MOMENT</p>
                  <p className="text-xs text-zinc-600 max-w-md text-center">
                    Scannerul OKX monitorizează continuu piața. În momentul în care un activ atinge scorul momentum configurat (&gt;={profileConfig?.minMomentumScore ?? 60}), botul va deschide automat poziția.
                  </p>
                  <button
                    type="button"
                    onClick={() => onTriggerScan()}
                    className="mt-2 px-3 py-1.5 bg-amber-500/20 hover:bg-amber-500/30 text-amber-400 border border-amber-500/40 rounded text-xs font-bold transition-all"
                  >
                    Lansează Scanare Manuală Acum (F3)
                  </button>
                </div>
              ) : (
                <div className="overflow-x-auto flex-1 space-y-2">
                  {positions.map((pos) => {
                    const isExpanded = !!expandedPositionIds[pos.id];
                    const isProfit = (pos.pnl || 0) >= 0;
                    const curPrice = pos.currentPrice || pos.entryPrice;
                    const holdingMinutes = pos.holdingTimeMinutes !== undefined
                      ? pos.holdingTimeMinutes
                      : parseFloat(((Date.now() - pos.entryTime) / 60000).toFixed(1));
                    
                    // Trailing evaluation
                    const isBuy = pos.side.toUpperCase() === 'BUY';
                    const peakPnlPct = isBuy
                      ? (((pos.highestPrice || pos.entryPrice) - pos.entryPrice) / pos.entryPrice) * 100
                      : ((pos.entryPrice - (pos.lowestPrice || pos.entryPrice)) / pos.entryPrice) * 100;
                    const trailingActThreshold = profileConfig?.trailingActivationPct ?? 1.5;
                    const isTrailActive = peakPnlPct >= trailingActThreshold;

                    // Break Even evaluation
                    const isBreakEvenActive = isBuy
                      ? (pos.stopLossPrice !== undefined && pos.stopLossPrice > pos.entryPrice)
                      : (pos.stopLossPrice !== undefined && pos.stopLossPrice < pos.entryPrice);

                    // State label
                    let stateBadge = {
                      label: isTrailActive ? 'TRAIL ACTIV' : isBreakEvenActive ? 'BE ASIGURAT' : isProfit ? 'ÎN PROFIT' : 'ÎN PIERDERE',
                      bg: isTrailActive
                        ? 'bg-purple-950 text-purple-300 border-purple-500/50'
                        : isBreakEvenActive
                        ? 'bg-blue-950 text-blue-300 border-blue-500/50'
                        : isProfit
                        ? 'bg-emerald-950 text-emerald-300 border-emerald-500/50'
                        : 'bg-rose-950 text-rose-300 border-rose-500/50'
                    };

                    return (
                      <div
                        key={pos.id}
                        className={`rounded border transition-all ${
                          isExpanded
                            ? 'bg-zinc-900 border-amber-500/60 shadow-lg shadow-black/40'
                            : 'bg-zinc-950/80 border-amber-500/20 hover:border-amber-500/40'
                        }`}
                      >
                        {/* Summary Header Row */}
                        <div
                          onClick={() => toggleExpandPosition(pos.id)}
                          className="p-2.5 flex flex-wrap items-center justify-between gap-2 cursor-pointer select-none"
                        >
                          <div className="flex items-center space-x-2.5">
                            <button
                              type="button"
                              className="text-amber-400 p-0.5 rounded hover:bg-amber-500/20"
                              title={isExpanded ? 'Restrânge' : 'Extinde detalii'}
                            >
                              {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                            </button>

                            <div>
                              <div className="flex items-center space-x-1.5">
                                <span className="font-bold text-amber-300 text-sm font-mono">{pos.symbol}</span>
                                <span className={`px-1.5 py-0.2 text-[10px] font-bold rounded ${
                                  pos.side === 'BUY' ? 'bg-emerald-950 text-emerald-400 border border-emerald-600/40' : 'bg-rose-950 text-rose-400 border border-rose-600/40'
                                }`}>
                                  {pos.side === 'BUY' ? 'LONG' : 'SHORT'}
                                </span>
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    loadTradingViewChart(pos.symbol);
                                  }}
                                  className="text-[9px] bg-zinc-800 hover:bg-amber-500/20 text-zinc-300 hover:text-amber-400 px-1.5 py-0.2 rounded border border-zinc-700 font-mono"
                                  title="Afișează graficul pe acest simbol"
                                >
                                  CHART
                                </button>
                              </div>
                              <div className="text-[10px] text-zinc-500 font-mono">
                                Cant: {pos.qty.toFixed(4)} | Dim: ${pos.sizeUSDT.toFixed(2)}
                              </div>
                            </div>
                          </div>

                          {/* Quick Metrics */}
                          <div className="flex items-center space-x-3 sm:space-x-5 text-xs font-mono">
                            <div>
                              <div className="text-[9px] text-zinc-500">PREȚ INTRARE</div>
                              <div className="font-bold text-zinc-300">${pos.entryPrice.toLocaleString()}</div>
                            </div>

                            <div>
                              <div className="text-[9px] text-zinc-500">PREȚ ACTUAL</div>
                              <div className="font-bold text-white">${curPrice.toLocaleString()}</div>
                            </div>

                            <div>
                              <div className="text-[9px] text-zinc-500">PNL NET</div>
                              <div className={`font-bold ${isProfit ? 'text-emerald-400' : 'text-rose-400'}`}>
                                {isProfit ? '+' : ''}${pos.pnl?.toFixed(2) || '0.00'} ({isProfit ? '+' : ''}{pos.pnlPct?.toFixed(2) || '0.00'}%)
                              </div>
                            </div>

                            <div>
                              <div className="text-[9px] text-zinc-500">DEȚINERE</div>
                              <div className="text-cyan-400 font-bold flex items-center space-x-0.5">
                                <Clock className="w-3 h-3 inline-block" />
                                <span>{Math.floor(holdingMinutes)}m</span>
                              </div>
                            </div>

                            <div>
                              <div className="text-[9px] text-zinc-500">STARE</div>
                              <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold border ${stateBadge.bg}`}>
                                {stateBadge.label}
                              </span>
                            </div>

                            <div className="flex items-center space-x-1.5" onClick={(e) => e.stopPropagation()}>
                              <button
                                type="button"
                                onClick={() => onClosePosition(pos.symbol)}
                                className="bg-rose-900 hover:bg-rose-700 text-white px-2.5 py-1 rounded text-[10px] font-bold tracking-wider transition-colors shadow-sm"
                              >
                                CLOSE
                              </button>
                            </div>
                          </div>
                        </div>

                        {/* Expanded Detail Panel */}
                        {isExpanded && (
                          <div className="border-t border-amber-500/20 bg-black/60 p-3 text-xs font-mono space-y-3">
                            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-2.5">
                              {/* Panel 1: Preț Actual & Evoluție */}
                              <div className="bg-zinc-950 p-2.5 rounded border border-zinc-800 space-y-1.5">
                                <div className="text-[10px] font-bold text-amber-400 border-b border-zinc-800 pb-1 flex items-center justify-between">
                                  <span>PREȚ ACTUAL &amp; EXCURSIE</span>
                                  <TrendingUp className="w-3 h-3 text-amber-500" />
                                </div>
                                <div className="flex justify-between">
                                  <span className="text-zinc-400">Preț Intrare:</span>
                                  <span className="text-zinc-200">${pos.entryPrice.toLocaleString()}</span>
                                </div>
                                <div className="flex justify-between">
                                  <span className="text-zinc-400">Preț Actual:</span>
                                  <span className="text-white font-bold">${curPrice.toLocaleString()}</span>
                                </div>
                                <div className="flex justify-between">
                                  <span className="text-zinc-400">Diferență Netă:</span>
                                  <span className={`font-bold ${isProfit ? 'text-emerald-400' : 'text-rose-400'}`}>
                                    {isProfit ? '+' : ''}${(curPrice - pos.entryPrice).toFixed(4)} ({isProfit ? '+' : ''}{pos.pnlPct?.toFixed(2)}%)
                                  </span>
                                </div>
                                <div className="flex justify-between text-[11px]">
                                  <span className="text-zinc-500">Maxim Atins:</span>
                                  <span className="text-emerald-400">${(pos.highestPrice || pos.entryPrice).toLocaleString()}</span>
                                </div>
                                <div className="flex justify-between text-[11px]">
                                  <span className="text-zinc-500">Minim Atins:</span>
                                  <span className="text-rose-400">${(pos.lowestPrice || pos.entryPrice).toLocaleString()}</span>
                                </div>
                              </div>

                              {/* Panel 2: Minute de Deținere & Timing */}
                              <div className="bg-zinc-950 p-2.5 rounded border border-zinc-800 space-y-1.5">
                                <div className="text-[10px] font-bold text-cyan-400 border-b border-zinc-800 pb-1 flex items-center justify-between">
                                  <span>MINUTE DEȚINERE &amp; TIMING</span>
                                  <Clock className="w-3 h-3 text-cyan-400" />
                                </div>
                                <div className="flex justify-between">
                                  <span className="text-zinc-400">Timp Scurs:</span>
                                  <span className="text-cyan-300 font-bold">{holdingMinutes.toFixed(1)} minute</span>
                                </div>
                                <div className="flex justify-between">
                                  <span className="text-zinc-400">Deschis la:</span>
                                  <span className="text-zinc-300">{new Date(pos.entryTime).toLocaleTimeString()}</span>
                                </div>
                                <div className="flex justify-between">
                                  <span className="text-zinc-400">Dată intrare:</span>
                                  <span className="text-zinc-400">{new Date(pos.entryTime).toLocaleDateString()}</span>
                                </div>
                                <div className="flex justify-between text-[11px]">
                                  <span className="text-zinc-500">Limită Max Hold:</span>
                                  <span className="text-amber-400">
                                    {profileConfig?.maxHoldingTimeMinutes && profileConfig.maxHoldingTimeMinutes > 0
                                      ? `${profileConfig.maxHoldingTimeMinutes}m (${(profileConfig.maxHoldingTimeMinutes - holdingMinutes).toFixed(1)}m rămase)`
                                      : 'Fără limită'}
                                  </span>
                                </div>
                              </div>

                              {/* Panel 3: Stare Risc & Trailing */}
                              <div className="bg-zinc-950 p-2.5 rounded border border-zinc-800 space-y-1.5">
                                <div className="text-[10px] font-bold text-purple-400 border-b border-zinc-800 pb-1 flex items-center justify-between">
                                  <span>STARE RISC &amp; TRAILING</span>
                                  <Zap className="w-3 h-3 text-purple-400" />
                                </div>
                                <div className="flex justify-between">
                                  <span className="text-zinc-400">Trailing Stop:</span>
                                  <span className={`font-bold ${isTrailActive ? 'text-purple-300' : 'text-zinc-500'}`}>
                                    {isTrailActive ? 'ACTIV (URMĂREȘTE)' : 'AȘTEPTARE ACTIVARE'}
                                  </span>
                                </div>
                                <div className="flex justify-between text-[11px]">
                                  <span className="text-zinc-500">Prag Activare:</span>
                                  <span className="text-zinc-300">+{trailingActThreshold}% (Vârf: +{peakPnlPct.toFixed(2)}%)</span>
                                </div>
                                <div className="flex justify-between text-[11px]">
                                  <span className="text-zinc-500">Distanță Retragere:</span>
                                  <span className="text-zinc-300">-{profileConfig?.trailingDistancePct ?? 0.4}%</span>
                                </div>
                                <div className="flex justify-between text-[11px]">
                                  <span className="text-zinc-500">Break-Even (BE):</span>
                                  <span className={isBreakEvenActive ? 'text-blue-400 font-bold' : 'text-zinc-500'}>
                                    {isBreakEvenActive ? 'ACTIVAT (SL la intrare)' : `Inactiv (Necesar +${profileConfig?.breakEvenActivationPct ?? 1}%)`}
                                  </span>
                                </div>
                                <div className="flex justify-between text-[11px]">
                                  <span className="text-zinc-500">Hard Stop Loss:</span>
                                  <span className="text-rose-400">
                                    {pos.stopLossPrice ? `$${pos.stopLossPrice.toFixed(4)} (-${profileConfig?.hardStopLossPct ?? 2.5}%)` : `-${profileConfig?.hardStopLossPct ?? 2.5}%`}
                                  </span>
                                </div>
                              </div>

                              {/* Panel 4: Financiar & Ordine */}
                              <div className="bg-zinc-950 p-2.5 rounded border border-zinc-800 space-y-1.5">
                                <div className="text-[10px] font-bold text-emerald-400 border-b border-zinc-800 pb-1 flex items-center justify-between">
                                  <span>FINANCIAR &amp; CONTRACT</span>
                                  <DollarSign className="w-3 h-3 text-emerald-400" />
                                </div>
                                <div className="flex justify-between">
                                  <span className="text-zinc-400">Valoare Marjă:</span>
                                  <span className="text-amber-400 font-bold">${pos.sizeUSDT.toFixed(2)} USDT</span>
                                </div>
                                <div className="flex justify-between">
                                  <span className="text-zinc-400">Comision Intrare:</span>
                                  <span className="text-zinc-300">
                                    {pos.entryFee !== undefined ? `-$${pos.entryFee.toFixed(3)}` : 'Inclus (0.05%)'}
                                  </span>
                                </div>
                                <div className="flex justify-between">
                                  <span className="text-zinc-400">PnL Gross vs Net:</span>
                                  <span className="text-zinc-200">
                                    Gross: ${pos.grossPnl?.toFixed(2) ?? pos.pnl?.toFixed(2)} | Net: ${pos.pnl?.toFixed(2)}
                                  </span>
                                </div>
                                <div className="flex justify-between text-[11px]">
                                  <span className="text-zinc-500">Regim / Profil:</span>
                                  <span className="text-zinc-400">{pos.marketRegime || 'MOMENTUM'} | {pos.profile}</span>
                                </div>
                                <div className="flex justify-between text-[11px]">
                                  <span className="text-zinc-500">Mod Execuție:</span>
                                  <span className="text-amber-400 font-bold">{pos.executionMode}</span>
                                </div>
                              </div>
                            </div>

                            <div className="pt-2 border-t border-zinc-800 flex justify-end space-x-2">
                              <button
                                type="button"
                                onClick={() => onClosePosition(pos.symbol)}
                                className="px-3 py-1 bg-rose-700 hover:bg-rose-600 text-white rounded font-bold text-xs flex items-center space-x-1 shadow"
                              >
                                <Square className="w-3 h-3" />
                                <span>ÎNCHIDE POZIȚIA IMEDIAT (MARKET CLOSE)</span>
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
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
                      
                      // Fallback fee calculation if not present: 0.05% OKX standard taker fee
                      const feeUSDT = ord.cumFee !== undefined ? ord.cumFee : (ord.sizeUSDT * 0.0005);

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
                      <span className={`font-bold ${Number(equityProtAct) === 0 ? 'text-zinc-400' : 'text-amber-400'}`}>
                        {Number(equityProtAct) === 0 ? 'DEZACTIVAT (0%)' : `+${Number(equityProtAct).toFixed(1)}%`}
                      </span>
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
                    <div className="text-[10px] text-zinc-500">
                      Setează 0% pentru a dezactiva complet această regulă.
                    </div>
                  </div>

                  {/* Equity Trailing Drawdown - step 0.05 */}
                  <div className="bg-zinc-900 p-3 rounded border border-amber-500/20 space-y-2">
                    <div className="flex justify-between items-center">
                      <span className="text-slate-300">Equity Trailing Drawdown</span>
                      <span className={`font-bold ${Number(equityTrailingDraw) === 0 ? 'text-zinc-400' : 'text-rose-400'}`}>
                        {Number(equityTrailingDraw) === 0 ? 'DEZACTIVAT (0%)' : `-${Number(equityTrailingDraw).toFixed(2)}%`}
                      </span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="10"
                      step="0.05"
                      value={equityTrailingDraw}
                      onChange={(e) => setEquityTrailingDraw(Number(e.target.value))}
                      className="w-full accent-rose-500 cursor-pointer"
                    />
                    <div className="text-[10px] text-zinc-500">
                      Setează 0% pentru a dezactiva complet această regulă.
                    </div>
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

        {/* RIGHT MODULE PANEL: TRADINGVIEW CHART (6 Cols on LG) */}
        <div className="lg:col-span-6 flex flex-col space-y-2">
          {/* TradingView Widget */}
          <div className="bg-zinc-950 border border-amber-500/30 rounded p-3 flex flex-col h-[520px]">
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

          {/* EQUITY HISTORY CHART (MOVED BELOW TRADINGVIEW CHART) */}
          {status?.equityHistory && status.equityHistory.length > 0 && (
            <div className="bg-zinc-950 border border-amber-500/30 p-3 rounded h-[285px] relative flex flex-col font-mono">
              <div className="flex items-center justify-between mb-1.5 px-0.5">
                <span className="text-[10px] text-amber-400 font-bold tracking-widest flex items-center space-x-1.5">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                  <span>24H EQUITY CURVE &amp; PERFORMANCE</span>
                </span>
                <div className="text-[10px] text-zinc-400 space-x-2">
                  <span>Min: <strong className="text-rose-400">${Math.min(...status.equityHistory.map(h => h.equity)).toFixed(2)}</strong></span>
                  <span>Max: <strong className="text-emerald-400">${Math.max(...status.equityHistory.map(h => h.equity)).toFixed(2)}</strong></span>
                </div>
              </div>
              <div className="flex-1 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={status.equityHistory} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
                    <XAxis 
                      dataKey="time" 
                      tickFormatter={(time) => new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      stroke="#71717a" 
                      fontSize={9} 
                      tickLine={false}
                    />
                    <YAxis 
                      domain={['auto', 'auto']} 
                      stroke="#71717a" 
                      fontSize={9} 
                      tickLine={false}
                      tickFormatter={(val) => `$${val}`}
                    />
                    <Tooltip 
                      contentStyle={{ backgroundColor: '#09090b', borderColor: '#d97706', borderRadius: '4px', fontSize: '10px', color: '#fcd34d' }}
                      formatter={(value: any) => [`$${Number(value).toFixed(2)}`, 'Equity']}
                      labelFormatter={(label) => new Date(label).toLocaleTimeString()}
                    />
                    <Line 
                      type="monotone" 
                      dataKey="equity" 
                      stroke="#10b981" 
                      strokeWidth={2} 
                      dot={false}
                      activeDot={{ r: 4, fill: '#10b981' }}
                      isAnimationActive={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
        </div>

        {/* BOTTOM WIDE MODULE: DESK AUDIT FEED (12 Cols on LG - WIDENED ACROSS FULL SCREEN) */}
        <div className="lg:col-span-12">
          <div className="bg-zinc-950 border border-amber-500/30 rounded p-3 flex flex-col">
            <div className="flex flex-wrap items-center justify-between gap-1.5 border-b border-amber-500/30 pb-2 mb-2">
              <div className="flex items-center space-x-2">
                <Terminal className="w-4 h-4 text-amber-500" />
                <span className="font-bold text-xs tracking-wider text-amber-400">DESK AUDIT FEED</span>
                <span className="text-[10px] text-slate-400 font-mono">({logs.length} evenimente)</span>
                <span className="text-[10px] text-zinc-500 hidden sm:inline">— Feed derulabil în timp real (5 vizibile)</span>
              </div>

              <div className="flex items-center space-x-1.5">
                <button
                  type="button"
                  onClick={handleExportLogs}
                  disabled={logs.length === 0}
                  className="inline-flex items-center space-x-1 px-2.5 py-1 rounded text-[10px] font-bold bg-emerald-950/80 hover:bg-emerald-900 border border-emerald-600/50 text-emerald-300 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
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
                    className="inline-flex items-center space-x-1 px-2.5 py-1 rounded text-[10px] font-bold bg-rose-950/60 hover:bg-rose-900/80 border border-rose-600/40 text-rose-300 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    title="Șterge feed-ul de evenimente"
                  >
                    <Trash2 className="w-3 h-3" />
                    <span>CLEAR LOG</span>
                  </button>
                ) : (
                  <div className="flex items-center space-x-1 bg-rose-950 border border-rose-500 px-2 py-0.5 rounded text-[10px] font-mono">
                    <span className="text-rose-200 font-bold">Ștergi istoricul?</span>
                    <button
                      type="button"
                      onClick={() => {
                        setShowClearLogsConfirm(false);
                        if (onClearLogs) onClearLogs();
                      }}
                      className="px-2 py-0.5 bg-rose-600 hover:bg-rose-500 text-white rounded font-bold"
                    >
                      DA
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowClearLogsConfirm(false)}
                      className="px-2 py-0.5 bg-zinc-800 text-zinc-300 rounded"
                    >
                      NU
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* Scrollable event list sized for 5 events */}
            <div className="overflow-y-auto max-h-[195px] space-y-1 font-mono text-[11px] pr-1">
              {logs.length === 0 ? (
                <div className="p-4 text-center text-zinc-600 text-xs">
                  Niciun eveniment de audit înregistrat încă.
                </div>
              ) : (
                logs.map((log) => {
                  let badgeColor = 'bg-zinc-800 text-zinc-300 border-zinc-700';
                  if (log.type === 'ORDER_FILLED' || log.type === 'POSITION_CLOSED') {
                    badgeColor = 'bg-emerald-950 text-emerald-300 border-emerald-600/50';
                  } else if (log.type === 'RISK_REJECTED' || log.type === 'SYSTEM_ERROR') {
                    badgeColor = 'bg-rose-950 text-rose-300 border-rose-600/50';
                  } else if (log.type === 'POSITION_OPENED' || log.type === 'ORDER_SUBMITTED') {
                    badgeColor = 'bg-amber-950 text-amber-300 border-amber-600/50';
                  } else if (log.type === 'SCANNER_RUN' || log.type === 'POSITION_UPDATED') {
                    badgeColor = 'bg-blue-950 text-blue-300 border-blue-600/50';
                  }

                  return (
                    <div
                      key={log.id}
                      className="bg-black/90 p-1.5 px-2.5 rounded border border-zinc-900 hover:border-amber-500/30 flex flex-wrap items-center justify-between gap-2"
                    >
                      <div className="flex items-center space-x-2.5 flex-1 min-w-0">
                        <span className="text-[10px] text-slate-500 shrink-0">
                          {new Date(log.timestamp).toLocaleTimeString()}
                        </span>
                        <span className={`px-1.5 py-0.2 rounded text-[9px] font-bold border shrink-0 ${badgeColor}`}>
                          {log.type}
                        </span>
                        <span className="text-zinc-200 truncate text-[11px]">
                          {log.message}
                        </span>
                      </div>
                      {log.details && (
                        <span className="text-[9px] text-zinc-500 shrink-0 hidden md:inline">
                          {typeof log.details === 'string' ? log.details : JSON.stringify(log.details).slice(0, 50)}
                        </span>
                      )}
                    </div>
                  );
                })
              )}
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
