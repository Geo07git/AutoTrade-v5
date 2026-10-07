/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { LineChart, Line, ResponsiveContainer, YAxis, Tooltip, XAxis, CartesianGrid } from 'recharts';
import {
  BotStatusResponse,
  AuditLog,
  AuditLogType,
  OrderRecord,
  Position,
  ExecutionMode,
  ProfileType,
  EquityProtectionEvent,
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
  ChevronLeft,
  ChevronRight,
  FileText,
  Info,
  Download,
  Trash2,
  Key,
  Radio,
  CheckCircle2,
  XCircle,
  Lock,
  Unlock,
  Wifi,
  ExternalLink,
  Eye,
  EyeOff,
  Bell,
  BellOff,
  BookOpen,
  ListFilter,
  MoreHorizontal,
} from 'lucide-react';
import { TradingViewChart } from './TradingViewChart';
import { SymbolStatsView } from './SymbolStatsView';
import { UserManualModal } from './UserManualModal';
import { downloadUserManualPdf } from '../utils/generateManualPdf';
import { formatPrice, formatExactPriceForExport, formatTimeLocal, formatDateTimeLocal } from '../shared/formatters';

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
  onUpdateCredentials?: (apiKey: string, secretKey: string, passphrase: string, testnet: boolean, region?: 'EEA' | 'GLOBAL' | 'AUTO') => Promise<{ success: boolean; error?: string }>;
  onTestOKXConnection?: (creds?: any) => Promise<any>;
  onSaveTelegramConfig?: (token: string, chatId: string, botUsername?: string) => Promise<{ success: boolean; message?: string; error?: string }>;
  onTestTelegramConnection?: (token?: string, chatId?: string) => Promise<{ success: boolean; reachable: boolean; validToken: boolean; botUsername?: string; botName?: string; chatDelivered?: boolean; error?: string }>;
  controlToken: string;
  onUpdateControlToken: (token: string) => void;
  errorMessage: string | null;
  successMessage: string | null;
  onDismissAlert?: () => void;
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

const getAuditCardTheme = (type: AuditLogType | string, message?: string) => {
  const isHeartbeat = message && (message.includes('STARE SISTEM') || message.includes('HEARTBEAT'));
  if (isHeartbeat) {
    return {
      badge: 'bg-indigo-950 text-indigo-300 border-indigo-500/60 font-black',
      card: 'bg-indigo-950/30 border-indigo-500/40 hover:border-indigo-400',
      dot: 'bg-indigo-400 animate-pulse shadow-[0_0_8px_rgba(129,140,248,0.9)]',
      badgeLabel: 'STARE [1m]',
    };
  }

  switch (type) {
    // 1. Profit & Execution Success (Emerald Green)
    case 'POSITION_CLOSED':
    case 'ORDER_FILLED':
    case 'PROFIT_VAULT_DEPOSIT':
      return {
        badge: 'bg-emerald-950 text-emerald-300 border-emerald-500/60',
        card: 'bg-emerald-950/25 border-emerald-500/40 hover:border-emerald-400',
        dot: 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.8)]',
        badgeLabel: type,
      };

    // 2. Orders Placed & Position Entry (Cyan Blue)
    case 'POSITION_OPENED':
    case 'ORDER_SUBMITTED':
    case 'ORDER_ACCEPTED':
    case 'ORDER_ROUTED':
    case 'ORDER_PARTIALLY_FILLED':
      return {
        badge: 'bg-cyan-950 text-cyan-300 border-cyan-500/60',
        card: 'bg-cyan-950/25 border-cyan-500/40 hover:border-cyan-400',
        dot: 'bg-cyan-400 shadow-[0_0_6px_rgba(34,211,238,0.8)]',
        badgeLabel: type,
      };

    // 3. Candidate Selection & Momentum Signals (Amber / Gold)
    case 'CANDIDATE_SELECTED':
    case 'SIGNAL_GENERATED':
    case 'RISK_APPROVED':
      return {
        badge: 'bg-amber-950 text-amber-300 border-amber-500/60',
        card: 'bg-amber-950/25 border-amber-500/40 hover:border-amber-400',
        dot: 'bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.8)]',
        badgeLabel: type,
      };

    // 4. Market Scanner & Universe Discovery (Purple / Violet)
    case 'SCAN_STARTED':
    case 'SCAN_COMPLETED':
    case 'UNIVERSE_REFRESH':
    case 'UNIVERSE_FILTERED':
      return {
        badge: 'bg-purple-950 text-purple-300 border-purple-500/60',
        card: 'bg-purple-950/25 border-purple-500/40 hover:border-purple-400',
        dot: 'bg-purple-400 shadow-[0_0_6px_rgba(192,132,252,0.8)]',
        badgeLabel: type,
      };

    // 5. Rejections & Skips (Orange / Coral)
    case 'CANDIDATE_REJECTED':
    case 'SIGNAL_REJECTED':
    case 'RISK_REJECTED':
    case 'ORDER_REJECTED':
    case 'ORDER_CANCELLED':
      return {
        badge: 'bg-orange-950 text-orange-300 border-orange-500/60',
        card: 'bg-orange-950/25 border-orange-500/40 hover:border-orange-400',
        dot: 'bg-orange-400 shadow-[0_0_6px_rgba(251,146,60,0.8)]',
        badgeLabel: type,
      };

    // 6. Errors, Discrepancies & Kill Switch (Rose / Red)
    case 'ERROR':
    case 'SCAN_ERROR':
    case 'ORDER_FAILED':
    case 'KILL_SWITCH_ENGAGED':
    case 'RECONCILIATION_DISCREPANCY':
      return {
        badge: 'bg-rose-950 text-rose-300 border-rose-500/60',
        card: 'bg-rose-950/25 border-rose-500/40 hover:border-rose-400',
        dot: 'bg-rose-500 animate-pulse shadow-[0_0_8px_rgba(244,63,94,0.9)]',
        badgeLabel: type,
      };

    // 7. System, Config & Disengage (Sky / Teal)
    case 'KILL_SWITCH_DISENGAGED':
    case 'EXCHANGE_CONNECTED':
    case 'EXCHANGE_DISCONNECTED':
    case 'MODE_CHANGED':
    case 'PAPER_RESET':
    case 'CONFIG_UPDATED':
    case 'PROFIT_VAULT_RESET':
    case 'RECOVERY':
    case 'EXPERIMENT':
    case 'POSITION_UPDATED':
    case 'SYSTEM':
    default:
      return {
        badge: 'bg-sky-950 text-sky-300 border-sky-500/60',
        card: 'bg-sky-950/25 border-sky-500/40 hover:border-sky-400',
        dot: 'bg-sky-400 shadow-[0_0_6px_rgba(56,189,248,0.8)]',
        badgeLabel: type,
      };
  }
};

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
  onUpdateCredentials,
  onTestOKXConnection,
  onSaveTelegramConfig,
  onTestTelegramConnection,
  controlToken,
  onUpdateControlToken,
  errorMessage,
  successMessage,
  onDismissAlert,
}) => {
  const profileConfig = status?.profileConfig;
  const activeProfile = status?.config?.activeProfile || 'MOMENTUM';

  const [activeScreen, setActiveScreen] = useState<'PORT' | 'POS' | 'TAPE' | 'SCAN' | 'BLOT' | 'SET' | 'INFO' | 'CHART' | 'SYM' | 'EXP'>('PORT');
  const [expandedPositionIds, setExpandedPositionIds] = useState<Record<string, boolean>>({});

  // 8-Hour Experiment State
  const [experimentState, setExperimentState] = useState<any>(null);
  const [experimentLogsCount, setExperimentLogsCount] = useState<number>(0);
  const [experimentLogs, setExperimentLogs] = useState<any[]>([]);
  const [isStartingExp, setIsStartingExp] = useState(false);
  const [isStoppingExp, setIsStoppingExp] = useState(false);

  // Configurable Experiment Settings State (Dedicated exclusively to the Experiment)
  const [expDurationHours, setExpDurationHours] = useState<number>(8);
  const [expMinMomentum, setExpMinMomentum] = useState<number>(50);
  const [expMaxHoldMinutes, setExpMaxHoldMinutes] = useState<number>(120);
  const [expHardStopLoss, setExpHardStopLoss] = useState<number>(20.0);
  const [expBreakEven, setExpBreakEven] = useState<number>(5.0);
  const [expTrailingAct, setExpTrailingAct] = useState<number>(2.5);
  const [expTrailingDist, setExpTrailingDist] = useState<number>(0.5);
  const [expTakeProfit, setExpTakeProfit] = useState<number>(20.0);
  const expConfigInitializedRef = useRef(false);

  const fetchExperimentStatus = async () => {
    try {
      const res = await fetch('/api/bot/experiment/status');
      if (res.ok) {
        const data = await res.json();
        setExperimentState(data.state);
        setExperimentLogsCount(data.logsCount || 0);
        if (Array.isArray(data.logs)) {
          setExperimentLogs(data.logs);
        }
        // Only initialize default slider values once on initial mount, do NOT overwrite user inputs on 3s polling
        if (data.state?.config && !expConfigInitializedRef.current) {
          expConfigInitializedRef.current = true;
          if (data.state.config.durationHours) setExpDurationHours(data.state.config.durationHours);
          if (data.state.config.minMomentumScore) setExpMinMomentum(data.state.config.minMomentumScore);
          if (data.state.config.maxHoldingTimeMinutes) setExpMaxHoldMinutes(data.state.config.maxHoldingTimeMinutes);
          if (data.state.config.hardStopLossPct) setExpHardStopLoss(data.state.config.hardStopLossPct);
          if (data.state.config.breakEvenActivationPct) setExpBreakEven(data.state.config.breakEvenActivationPct);
          if (data.state.config.trailingActivationPct) setExpTrailingAct(data.state.config.trailingActivationPct);
          if (data.state.config.trailingDistancePct) setExpTrailingDist(data.state.config.trailingDistancePct);
          if (data.state.config.takeProfitPct) setExpTakeProfit(data.state.config.takeProfitPct);
        }
      }
    } catch (e) {}
  };

  useEffect(() => {
    fetchExperimentStatus();
    const timer = setInterval(fetchExperimentStatus, 3000);
    return () => clearInterval(timer);
  }, []);

  const handleStartExperiment = async () => {
    setIsStartingExp(true);
    try {
      const res = await fetch('/api/bot/experiment/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-bot-token': controlToken },
        body: JSON.stringify({
          durationHours: expDurationHours,
          minMomentumScore: expMinMomentum,
          maxHoldingTimeMinutes: expMaxHoldMinutes,
          hardStopLossPct: expHardStopLoss,
          breakEvenActivationPct: expBreakEven,
          trailingActivationPct: expTrailingAct,
          trailingDistancePct: expTrailingDist,
          takeProfitPct: expTakeProfit,
        }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setExperimentState(data.state);
        onRefresh();
        fetchExperimentStatus();
        setLocalAlert({ type: 'success', message: data.message || 'Experiment pornit cu succes!' });
      } else {
        setLocalAlert({ type: 'error', message: data.error || 'Erore la pornirea experimentului.' });
      }
    } catch (err: any) {
      setLocalAlert({ type: 'error', message: err.message || 'Erore de rețea.' });
    } finally {
      setIsStartingExp(false);
    }
  };

  const handleStopExperiment = async () => {
    setIsStoppingExp(true);
    try {
      const res = await fetch('/api/bot/experiment/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-bot-token': controlToken }
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setExperimentState(data.state);
        onRefresh();
        fetchExperimentStatus();
        setLocalAlert({ type: 'info', message: 'Experimentul a fost oprit.' });
      }
    } catch (err: any) {
      setLocalAlert({ type: 'error', message: err.message || 'Erore de rețea.' });
    } finally {
      setIsStoppingExp(false);
    }
  };

  const handleDownloadExperiment = async (format: 'json' | 'csv') => {
    try {
      const res = await fetch(`/api/bot/experiment/download?format=${format}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setLocalAlert({ type: 'error', message: err.error || 'Niciun fișier de experiment disponibil încă.' });
        return;
      }
      const blob = await res.blob();
      const disposition = res.headers.get('content-disposition');
      const hours = experimentState?.durationHours || expDurationHours || 8;
      const dateStr = new Date().toISOString().split('T')[0];
      let filename = `experiment_${hours}h_${dateStr}.${format}`;
      if (disposition && disposition.includes('filename=')) {
        const match = disposition.match(/filename="?([^";]+)"?/);
        if (match && match[1]) filename = match[1];
      }
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
      setLocalAlert({ type: 'success', message: `✅ Fișierul ${filename} a fost descărcat cu succes!` });
    } catch (err: any) {
      setLocalAlert({ type: 'error', message: 'Erore la descărcare: ' + (err.message || 'Eroare rețea') });
    }
  };

  // OKX Gateway & Mode Switch State
  const [showOKXModal, setShowOKXModal] = useState<boolean>(false);
  const [showToolsMenu, setShowToolsMenu] = useState<boolean>(false);
  const toolsMenuRef = useRef<HTMLDivElement>(null);
  const [okxKeyInput, setOkxKeyInput] = useState<string>('');
  const [okxSecretInput, setOkxSecretInput] = useState<string>('');
  const [okxPassphraseInput, setOkxPassphraseInput] = useState<string>('');
  const [okxTestnetInput, setOkxTestnetInput] = useState<boolean>(true);
  const [okxRegionInput, setOkxRegionInput] = useState<'EEA' | 'GLOBAL' | 'AUTO'>('EEA');
  const [detectedServerIp, setDetectedServerIp] = useState<string>('');
  const [copiedIp, setCopiedIp] = useState<boolean>(false);
  const [isTestingOKX, setIsTestingOKX] = useState<boolean>(false);
  const [okxTestFeedback, setOkxTestFeedback] = useState<{
    tested: boolean;
    reachable?: boolean;
    authenticated?: boolean;
    equity?: number;
    error?: string;
    region?: string;
    endpoint?: string;
    serverIp?: string;
  } | null>(null);
  const [isSavingOKX, setIsSavingOKX] = useState<boolean>(false);
  const [okxSaveMessage, setOkxSaveMessage] = useState<string | null>(null);
  const [showLiveConfirm, setShowLiveConfirm] = useState<boolean>(false);
  const [liveDisclaimerChecked, setLiveDisclaimerChecked] = useState<boolean>(false);
  const [showManualModal, setShowManualModal] = useState<boolean>(false);

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
  const autoTapeTrackRef = useRef<HTMLDivElement>(null);
  const tickerPos = useRef<number>(0);

  const auditTapeRef = useRef<HTMLDivElement>(null);
  const auditTrackRef = useRef<HTMLDivElement>(null);
  const auditPos = useRef<number>(0);

  // Ultimele 100 de evenimente pentru banda derulantă DESK AUDIT FEED
  const displayLogs = useMemo(() => logs.slice(0, 100), [logs]);

  // Asigură că track-ul primar depășește întotdeauna lățimea ecranului pentru derulare fluidă fără cusur
  const extendedTapeItems = useMemo(() => {
    if (tapeItems.length === 0) return [];
    if (tapeItems.length < 15) {
      const repeats = Math.max(2, Math.ceil(24 / tapeItems.length));
      return Array(repeats).fill(tapeItems).flat();
    }
    return tapeItems;
  }, [tapeItems]);

  const extendedAuditLogs = useMemo(() => {
    if (displayLogs.length === 0) return [];
    if (displayLogs.length < 10) {
      const repeats = Math.max(2, Math.ceil(16 / displayLogs.length));
      return Array(repeats).fill(displayLogs).flat();
    }
    return displayLogs;
  }, [displayLogs]);
  const shortcutsRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const isDraggingShortcuts = useRef(false);
  const dragStartX = useRef(0);
  const dragScrollLeft = useRef(0);
  const [equityProtAct, setEquityProtAct] = useState(profileConfig?.equityProtectionActivationPct ?? 0);
  const [equityTrailingDraw, setEquityTrailingDraw] = useState(profileConfig?.equityTrailingDrawdownPct ?? 0);
  const [riskPerTrade, setRiskPerTrade] = useState(profileConfig?.riskPerTradePct ?? 10);
  const [maxPositions, setMaxPositions] = useState(profileConfig?.maxOpenPositions ?? 5);
  const [hardStopLoss, setHardStopLoss] = useState(profileConfig?.hardStopLossPct ?? 20.0);
  const [trailingAct, setTrailingAct] = useState(profileConfig?.trailingActivationPct ?? 1.1);
  const [trailingDist, setTrailingDist] = useState(profileConfig?.trailingDistancePct ?? 0.35);
  const [minMomentum, setMinMomentum] = useState(
    Math.min(95, Math.max(50, profileConfig?.minMomentumScore ?? 50))
  );
  const [maxMomentum, setMaxMomentum] = useState(
    Math.min(99, Math.max(70, profileConfig?.maxMomentumScore ?? 99))
  );
  const [min24hVol, setMin24hVol] = useState<number>(
    profileConfig?.min24hVolumeUSDT !== undefined
      ? profileConfig.min24hVolumeUSDT / 1_000_000
      : 1.5
  );
  const [max24hVol, setMax24hVol] = useState<number>(
    profileConfig?.max24hVolumeUSDT !== undefined
      ? profileConfig.max24hVolumeUSDT / 1_000_000
      : 0
  );
  const [takeProfit, setTakeProfit] = useState(profileConfig?.takeProfitPct ?? 0);
  const [breakEven, setBreakEven] = useState(profileConfig?.breakEvenActivationPct ?? 1.0);
  const [maxHoldTime, setMaxHoldTime] = useState(profileConfig?.maxHoldingTimeMinutes ?? 45);
  const [stagnationTime, setStagnationTime] = useState(profileConfig?.stagnationTimeMinutes ?? 0);
  const [cooldownMins, setCooldownMins] = useState(profileConfig?.cooldownMinutes ?? 5);
  const [sentimentThreshold, setSentimentThreshold] = useState(profileConfig?.sentimentThreshold ?? 1.5);
  const [shortRegimeGuard, setShortRegimeGuard] = useState<'BEAR_ONLY' | 'OFF' | 'DISABLED'>(profileConfig?.shortRegimeGuard ?? 'OFF');
  const [btcBearGuard, setBtcBearGuard] = useState<boolean>(profileConfig?.btcBearGuard ?? false);
  const [minShortScore, setMinShortScore] = useState<number>(profileConfig?.minShortMomentumScore ?? 0);
  const [maxEntriesPerHour, setMaxEntriesPerHour] = useState<number>(profileConfig?.maxEntriesPerSymbolPerHour ?? 3);
  const [cooldownAfterLoss, setCooldownAfterLoss] = useState<number>(profileConfig?.cooldownAfterLossMinutes ?? 30);
  const [telegramTesting, setTelegramTesting] = useState(false);
  const [isMonochrome, setIsMonochrome] = useState<boolean>(false);
  const [telegramStatusMsg, setTelegramStatusMsg] = useState<string | null>(null);

  // Telegram Bot Configuration State
  const [telegramTokenInput, setTelegramTokenInput] = useState<string>('');
  const [telegramChatIdInput, setTelegramChatIdInput] = useState<string>('');
  const [telegramShowToken, setTelegramShowToken] = useState<boolean>(false);
  const [isSavingTelegram, setIsSavingTelegram] = useState<boolean>(false);
  const [isTestingTelegram, setIsTestingTelegram] = useState<boolean>(false);
  const [telegramSaveMessage, setTelegramSaveMessage] = useState<string | null>(null);
  const [telegramTestFeedback, setTelegramTestFeedback] = useState<{
    tested: boolean;
    success?: boolean;
    reachable?: boolean;
    validToken?: boolean;
    botUsername?: string;
    botName?: string;
    chatDelivered?: boolean;
    error?: string;
  } | null>(null);

  // Pre-fill Telegram Chat ID if available from status
  useEffect(() => {
    if (status?.telegramStatus?.chatId && !telegramChatIdInput) {
      setTelegramChatIdInput(status.telegramStatus.chatId);
    }
  }, [status?.telegramStatus?.chatId]);

  // Auto-dismiss Telegram status message after 10 seconds
  useEffect(() => {
    if (!telegramStatusMsg) return;
    const timer = setTimeout(() => {
      setTelegramStatusMsg(null);
    }, 10000);
    return () => clearTimeout(timer);
  }, [telegramStatusMsg]);

  // Initial fetch of Telegram status on load
  useEffect(() => {
    const fetchTelegramInitialStatus = async () => {
      try {
        const res = await fetch('/api/bot/telegram/status');
        const data = await res.json();
        if (data?.status?.chatId && !telegramChatIdInput) {
          setTelegramChatIdInput(data.status.chatId);
        }
      } catch (e) {
        // ignore
      }
    };
    fetchTelegramInitialStatus();
  }, []);

  const [settingsSavedMessage, setSettingsSavedMessage] = useState<string | null>(null);
  const [expandedOrderId, setExpandedOrderId] = useState<string | null>(null);
  const [showClearOrdersConfirm, setShowClearOrdersConfirm] = useState(false);
  const [showClearLogsConfirm, setShowClearLogsConfirm] = useState(false);
  const [showTokenModal, setShowTokenModal] = useState(false);
  const [tempToken, setTempToken] = useState(controlToken);
  const [showSetBaseModal, setShowSetBaseModal] = useState<boolean>(false);
  const [newBaseInput, setNewBaseInput] = useState<string>('200.00');
  const [showResetVaultConfirmModal, setShowResetVaultConfirmModal] = useState<boolean>(false);
  const [showEquityProtectionModal, setShowEquityProtectionModal] = useState<boolean>(false);
  const [isClearingEquityProtection, setIsClearingEquityProtection] = useState<boolean>(false);
  const [selectedProtectionEvent, setSelectedProtectionEvent] = useState<EquityProtectionEvent | null>(null);
  const [localAlert, setLocalAlert] = useState<{ type: 'success' | 'error' | 'info'; message: string } | null>(null);

  // Auto-dismiss local alerts after 10 seconds
  useEffect(() => {
    if (!localAlert) return;
    const timer = setTimeout(() => {
      setLocalAlert(null);
    }, 10000);
    return () => clearTimeout(timer);
  }, [localAlert]);

  const [chartSymbol, setChartSymbol] = useState('BTCUSDT');
  const [symbolSearchQuery, setSymbolSearchQuery] = useState('');
  const [showSymbolDropdown, setShowSymbolDropdown] = useState(false);
  const [lang, setLang] = useState<'EN' | 'RO'>('RO');

  // Pre-fill OKX credential fields from status config if available
  useEffect(() => {
    if (status?.config?.okxApiKey && !okxKeyInput) {
      setOkxKeyInput(status.config.okxApiKey);
    }
    if (status?.config?.okxPassphrase && !okxPassphraseInput) {
      setOkxPassphraseInput(status.config.okxPassphrase);
    }
    if (status?.config?.testnet !== undefined) {
      setOkxTestnetInput(status.config.testnet);
    }
  }, [status?.config]);

  // Auto-fetch server public IP for diagnostic display
  useEffect(() => {
    if (showOKXModal && !detectedServerIp) {
      fetch('/api/bot/server-ip')
        .then((r) => r.json())
        .then((d) => {
          if (d.serverIp && d.serverIp !== 'Nedetectat') {
            setDetectedServerIp(d.serverIp);
          }
        })
        .catch(() => {});
    }
  }, [showOKXModal, detectedServerIp]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (toolsMenuRef.current && !toolsMenuRef.current.contains(event.target as Node)) {
        setShowToolsMenu(false);
      }
    };
    if (showToolsMenu) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showToolsMenu]);

  const handleCopyServerIp = () => {
    if (detectedServerIp) {
      navigator.clipboard.writeText(detectedServerIp);
      setCopiedIp(true);
      setTimeout(() => setCopiedIp(false), 3000);
    }
  };

  const handleSwitchExecutionModeWithCheck = (mode: ExecutionMode) => {
    if (status?.positions && status.positions.length > 0) {
      alert(`Nu poți comuta modul în timp ce există ${status.positions.length} poziție(i) deschise. Închide mai întâi toate pozițiile active!`);
      return;
    }
    if (mode === 'LIVE') {
      setShowLiveConfirm(true);
      return;
    }
    onSwitchMode(mode);
  };

  const handleConfirmLiveMode = () => {
    setShowLiveConfirm(false);
    setOkxTestnetInput(false);
    onSwitchMode('LIVE');
  };

  const handleRunOKXTest = async (overrideCreds?: any) => {
    setIsTestingOKX(true);
    setOkxTestFeedback(null);
    try {
      if (onTestOKXConnection) {
        const credsToSend = overrideCreds || (okxKeyInput && okxSecretInput ? {
          apiKey: okxKeyInput,
          secretKey: okxSecretInput,
          passphrase: okxPassphraseInput,
          isDemo: okxTestnetInput,
          region: okxRegionInput,
        } : {
          isDemo: okxTestnetInput,
          region: okxRegionInput,
        });
        const result = await onTestOKXConnection(credsToSend);
        setOkxTestFeedback({
          tested: true,
          reachable: result.reachable,
          authenticated: result.authenticated,
          equity: result.equity,
          error: result.error,
          region: result.region,
          endpoint: result.endpoint,
          serverIp: result.serverIp,
        });
        if (result.serverIp && result.serverIp !== 'Nedetectat') {
          setDetectedServerIp(result.serverIp);
        }
      }
    } catch (err: any) {
      setOkxTestFeedback({
        tested: true,
        reachable: false,
        authenticated: false,
        error: err.message || 'Eroare la testare',
      });
    } finally {
      setIsTestingOKX(false);
    }
  };

  const handleSaveOKXCredentials = async () => {
    if (!okxKeyInput.trim() || !okxSecretInput.trim()) {
      alert('Te rugăm să completezi atât OKX API Key cât și OKX Secret Key!');
      return;
    }
    setIsSavingOKX(true);
    setOkxSaveMessage(null);
    try {
      if (onUpdateCredentials) {
        const res = await onUpdateCredentials(
          okxKeyInput.trim(),
          okxSecretInput.trim(),
          okxPassphraseInput.trim(),
          okxTestnetInput,
          okxRegionInput
        );
        if (res.success) {
          setOkxSaveMessage('✅ Cheile API OKX au fost salvate și verificate cu succes!');
          setTimeout(() => setOkxSaveMessage(null), 5000);
        } else {
          setOkxSaveMessage(`❌ Eroare: ${res.error || 'Eroare la salvare'}`);
        }
      }
    } catch (err: any) {
      setOkxSaveMessage(`❌ Eroare: ${err.message || 'Eroare la salvare'}`);
    } finally {
      setIsSavingOKX(false);
    }
  };

  const handleRunTelegramTest = async () => {
    setIsTestingTelegram(true);
    setTelegramTestFeedback(null);
    try {
      const t = telegramTokenInput.trim();
      const c = telegramChatIdInput.trim();
      if (onTestTelegramConnection) {
        const res = await onTestTelegramConnection(t, c);
        setTelegramTestFeedback({
          tested: true,
          ...res,
        });
      } else {
        const token = localStorage.getItem('tb5_control_token') || 'tradebot5_admin_token';
        const res = await fetch('/api/bot/telegram/test-connection', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-bot-token': token },
          body: JSON.stringify({ token: t, chatId: c }),
        });
        const data = await res.json();
        setTelegramTestFeedback({
          tested: true,
          ...data,
        });
      }
    } catch (err: any) {
      setTelegramTestFeedback({
        tested: true,
        success: false,
        reachable: false,
        validToken: false,
        error: err.message || 'Eroare de conexiune la server',
      });
    } finally {
      setIsTestingTelegram(false);
    }
  };

  const handleSaveTelegramCredentials = async () => {
    if (!telegramTokenInput.trim() && !status?.telegramStatus?.hasToken) {
      alert('Te rugăm să introduci Telegram Bot Token (obținut de la @BotFather pe Telegram)!');
      return;
    }
    setIsSavingTelegram(true);
    setTelegramSaveMessage(null);
    try {
      const token = telegramTokenInput.trim();
      const chatId = telegramChatIdInput.trim();
      const botUser = telegramTestFeedback?.botUsername || status?.telegramStatus?.botUsername;
      if (onSaveTelegramConfig) {
        const res = await onSaveTelegramConfig(token, chatId, botUser);
        if (res.success) {
          setTelegramSaveMessage('✅ Configurația Telegram a fost salvată și activată cu succes!');
          setTimeout(() => setTelegramSaveMessage(null), 5000);
          onRefresh?.();
        } else {
          setTelegramSaveMessage(`❌ Eroare: ${res.error || 'Eroare la salvare'}`);
        }
      } else {
        const authTok = localStorage.getItem('tb5_control_token') || 'tradebot5_admin_token';
        const res = await fetch('/api/bot/telegram/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-bot-token': authTok },
          body: JSON.stringify({ token, chatId, botUsername: botUser }),
        });
        const data = await res.json();
        if (data.success) {
          setTelegramSaveMessage('✅ Configurația Telegram a fost salvată și activată cu succes!');
          setTimeout(() => setTelegramSaveMessage(null), 5000);
          onRefresh?.();
        } else {
          setTelegramSaveMessage(`❌ Eroare: ${data.error || 'Eroare la salvare'}`);
        }
      }
    } catch (err: any) {
      setTelegramSaveMessage(`❌ Eroare: ${err.message || 'Eroare la salvare'}`);
    } finally {
      setIsSavingTelegram(false);
    }
  };

  const renderExperimentView = () => {
    const isRunning = Boolean(experimentState?.isActive);
    const effectiveHours = isRunning ? (experimentState?.durationHours || 8) : expDurationHours;
    const effectiveMinMom = isRunning ? (experimentState?.minMomentumScore || 50) : expMinMomentum;
    const remMs = experimentState?.remainingMs !== undefined ? experimentState.remainingMs : (expDurationHours * 3600 * 1000);
    const hours = Math.floor(remMs / 3600000);
    const minutes = Math.floor((remMs % 3600000) / 60000);
    const seconds = Math.floor((remMs % 60000) / 1000);
    const dateStr = new Date(experimentState?.startTime || Date.now()).toISOString().split('T')[0];

    const handleResetExpDefaults = () => {
      setExpDurationHours(8);
      setExpMinMomentum(50);
      setExpMaxHoldMinutes(120);
      setExpHardStopLoss(20.0);
      setExpBreakEven(5.0);
      setExpTrailingAct(2.5);
      setExpTrailingDist(0.5);
      setExpTakeProfit(20.0);
    };

    return (
      <div className="flex flex-col h-full bg-zinc-950 p-3 sm:p-4 border border-cyan-500/30 rounded-lg overflow-y-auto space-y-4">
        {/* HEADER SECTION */}
        <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-3 border-b border-zinc-800 pb-3">
          <div className="flex items-center space-x-2.5">
            <Activity className="w-6 h-6 text-cyan-400 animate-pulse shrink-0" />
            <div>
              <h2 className="text-sm sm:text-base font-bold text-cyan-300 font-mono flex flex-wrap items-center gap-2">
                <span>🔬 EXPERIMENT {effectiveHours} ORE: SCALP &amp; MOMENTUM &gt;= {effectiveMinMom} (BALANȚĂ $10,000 | MAX 50 POZIȚII)</span>
                <span className={`px-2 py-0.5 rounded text-[10px] font-mono border ${
                  isRunning
                    ? 'bg-emerald-950 text-emerald-300 border-emerald-500 animate-pulse'
                    : 'bg-zinc-900 text-zinc-400 border-zinc-700'
                }`}>
                  {isRunning ? '● ACTIV (ÎN RULARE)' : '○ OPRIT / PREGĂTIT'}
                </span>
              </h2>
              <p className="text-xs text-zinc-400 mt-0.5">
                Rulează {effectiveHours} ore cu profilul SCALP pe toate perechile SWAP, execută oportunități cu Momentum &gt;= {effectiveMinMom}, balanță $10,000 USDT plafonată la 50 poziții simultane ($50/trade).
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {isRunning ? (
              <button
                onClick={handleStopExperiment}
                disabled={isStoppingExp}
                className="px-4 py-2 bg-rose-600 hover:bg-rose-500 text-white font-bold rounded text-xs flex items-center space-x-1.5 shadow-lg shadow-rose-600/30 cursor-pointer disabled:opacity-50"
              >
                <Square className="w-4 h-4" />
                <span>{isStoppingExp ? 'Se oprește...' : 'Oprește Experimentul'}</span>
              </button>
            ) : (
              <button
                onClick={handleStartExperiment}
                disabled={isStartingExp}
                className="px-4 py-2 bg-cyan-500 hover:bg-cyan-400 text-black font-bold rounded text-xs flex items-center space-x-1.5 shadow-lg shadow-cyan-500/30 cursor-pointer disabled:opacity-50"
              >
                <Play className="w-4 h-4" />
                <span>{isStartingExp ? 'Se inițializează...' : `Pornește Experimentul (${expDurationHours}h)`}</span>
              </button>
            )}

            <button
              onClick={() => handleDownloadExperiment('json')}
              className="px-3 py-2 bg-amber-500 hover:bg-amber-400 text-black font-bold rounded text-xs flex items-center space-x-1.5 shadow-lg shadow-amber-500/30 cursor-pointer"
              title={`Descarcă raportul complet în format JSON (experiment_${effectiveHours}h_${dateStr}.json)`}
            >
              <Download className="w-3.5 h-3.5" />
              <span>📥 JSON (experiment_{effectiveHours}h_{dateStr}.json)</span>
            </button>

            <button
              onClick={() => handleDownloadExperiment('csv')}
              className="px-3 py-2 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded text-xs flex items-center space-x-1.5 shadow-lg shadow-emerald-600/30 cursor-pointer"
              title={`Descarcă raportul complet în format CSV pentru Excel / Python (experiment_${effectiveHours}h_${dateStr}.csv)`}
            >
              <Download className="w-3.5 h-3.5" />
              <span>📊 CSV (experiment_{effectiveHours}h_{dateStr}.csv)</span>
            </button>
          </div>
        </div>

        {/* METRICS & RUNTIME HUD */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5">
          <div className="bg-zinc-900 border border-zinc-800 p-2.5 rounded">
            <span className="text-[10px] text-zinc-400 font-mono uppercase block">Stare Experiment</span>
            <span className={`text-xs sm:text-sm font-bold font-mono ${isRunning ? 'text-emerald-400 animate-pulse' : 'text-zinc-500'}`}>
              {isRunning ? '🟢 ÎN DESFĂȘURARE' : '⚪ OPRIT'}
            </span>
            <span className="text-[9px] text-zinc-500 block font-mono mt-0.5">
              {isRunning ? 'Execuție automată activă' : 'În așteptare pornire'}
            </span>
          </div>

          <div className="bg-zinc-900 border border-cyan-500/50 p-2.5 rounded shadow-[0_0_12px_rgba(6,182,212,0.15)]">
            <span className="text-[10px] text-cyan-400 font-mono uppercase block">Fond / Balanță Alocată</span>
            <div className="text-xs sm:text-sm font-bold text-cyan-300 font-mono flex items-center space-x-1">
              <span>$10,000 USDT</span>
            </div>
            <span className="text-[9px] text-zinc-400 block">Plafon: Max 50 Poziții</span>
          </div>

          <div className="bg-zinc-900 border border-zinc-800 p-2.5 rounded">
            <span className="text-[10px] text-zinc-400 font-mono uppercase block">Timp Rămas (Target {effectiveHours}h)</span>
            <span className="text-xs sm:text-sm font-bold text-cyan-300 font-mono">
              {String(hours).padStart(2, '0')}:{String(minutes).padStart(2, '0')}:{String(seconds).padStart(2, '0')}
            </span>
            <span className="text-[9px] text-zinc-500 block font-mono mt-0.5">
              {isRunning ? `Timp scurs: ${Math.floor((experimentState?.elapsedMs || 0) / 60000)}m` : 'Target: 1 - 12 ore'}
            </span>
          </div>

          <div className="bg-zinc-900 border border-zinc-800 p-2.5 rounded">
            <span className="text-[10px] text-zinc-400 font-mono uppercase block">Total Intrări / Ieșiri</span>
            <span className="text-xs sm:text-sm font-bold text-amber-300 font-mono">
              {experimentState?.totalEntries || 0} intrări / {experimentState?.totalExits || 0} ieșiri
            </span>
            <span className="text-[9px] text-zinc-500 block font-mono mt-0.5">
              {experimentLogsCount} evenimente înregistrate
            </span>
          </div>

          <div className="bg-zinc-900 border border-zinc-800 p-2.5 rounded">
            <span className="text-[10px] text-zinc-400 font-mono uppercase block">PnL Total Realizat</span>
            <span className={`text-xs sm:text-sm font-bold font-mono ${(experimentState?.totalPnl || 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
              {(experimentState?.totalPnl || 0) >= 0 ? '+' : ''}${(experimentState?.totalPnl || 0).toFixed(4)}
            </span>
            <span className="text-[9px] text-zinc-500 block font-mono mt-0.5">
              Contabilitate fără trunchiere
            </span>
          </div>
        </div>

        {/* CONFIGURATION DESK (CONFIGURARE DEDICATĂ EXPERIMENTULUI) */}
        <div className="bg-black/80 border border-cyan-500/40 rounded-lg p-3 sm:p-4 space-y-3 shadow-md">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-cyan-500/20 pb-2">
            <div className="flex items-center space-x-2">
              <span className="w-2.5 h-2.5 rounded-full bg-cyan-400 inline-block"></span>
              <h3 className="text-xs sm:text-sm font-bold text-cyan-300 font-mono uppercase">
                {isRunning
                  ? '🔒 CONFIGURAȚIE ACTIVĂ BLOCATĂ PE DURATA EXPERIMENTULUI:'
                  : '⚙️ SETĂRI CONFIGURABILE EXCLUSIV PENTRU ACEST EXPERIMENT:'}
              </h3>
            </div>
            {!isRunning && (
              <button
                type="button"
                onClick={handleResetExpDefaults}
                className="px-2.5 py-1 text-[11px] rounded border border-cyan-500/40 bg-zinc-900 text-cyan-300 hover:bg-zinc-800 cursor-pointer"
                title="Resetează toți parametrii la valorile implicite ale experimentului cerute de utilizator"
              >
                ↺ Resetează la Setările Implicite
              </button>
            )}
          </div>

          {!isRunning ? (
            /* INTERACTIVE CONTROLS BEFORE LAUNCH */
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
              {/* 1. Timp pentru experiment: 1 - 12h */}
              <div className="bg-zinc-900/90 p-2.5 rounded border border-cyan-500/20 space-y-1.5">
                <div className="flex justify-between items-center">
                  <span className="text-slate-300 font-mono text-[11px]">Timp Experiment (1-12 h)</span>
                  <span className="font-bold text-cyan-300 font-mono">{expDurationHours} ore</span>
                </div>
                <input
                  type="range"
                  min="1"
                  max="12"
                  step="1"
                  value={expDurationHours}
                  onChange={(e) => setExpDurationHours(Number(e.target.value))}
                  className="w-full accent-cyan-500 cursor-pointer"
                />
                <div className="flex justify-between text-[9px] text-zinc-500 font-mono">
                  <span>Min: 1h</span>
                  <span className="text-cyan-400">Target: {expDurationHours} ore</span>
                  <span>Max: 12h</span>
                </div>
              </div>

              {/* 2. Momentum score: 50 - 100 */}
              <div className="bg-zinc-900/90 p-2.5 rounded border border-cyan-500/20 space-y-1.5">
                <div className="flex justify-between items-center">
                  <span className="text-slate-300 font-mono text-[11px]">Prag Momentum (50-100)</span>
                  <span className="font-bold text-amber-300 font-mono">&gt;= {expMinMomentum}</span>
                </div>
                <input
                  type="range"
                  min="50"
                  max="100"
                  step="1"
                  value={expMinMomentum}
                  onChange={(e) => setExpMinMomentum(Number(e.target.value))}
                  className="w-full accent-amber-500 cursor-pointer"
                />
                <div className="flex justify-between text-[9px] text-zinc-500 font-mono">
                  <span>Min: 50</span>
                  <span className="text-amber-300">Toate semnalele &gt;= {expMinMomentum}</span>
                  <span>Max: 100</span>
                </div>
              </div>

              {/* 3. Timp max deținere: 15 - 120 min */}
              <div className="bg-zinc-900/90 p-2.5 rounded border border-cyan-500/20 space-y-1.5">
                <div className="flex justify-between items-center">
                  <span className="text-slate-300 font-mono text-[11px]">Timp Max Deținere (15-120m)</span>
                  <span className="font-bold text-amber-400 font-mono">{expMaxHoldMinutes} min</span>
                </div>
                <input
                  type="range"
                  min="15"
                  max="120"
                  step="1"
                  value={expMaxHoldMinutes}
                  onChange={(e) => setExpMaxHoldMinutes(Number(e.target.value))}
                  className="w-full accent-amber-500 cursor-pointer"
                />
                <div className="flex justify-between text-[9px] text-zinc-500 font-mono">
                  <span>Min: 15m</span>
                  <span className="text-amber-300">Time-Stop la {expMaxHoldMinutes}m</span>
                  <span>Max: 120m</span>
                </div>
              </div>

              {/* 4. Hard Stop-Loss: default 20% */}
              <div className="bg-zinc-900/90 p-2.5 rounded border border-rose-500/20 space-y-1.5">
                <div className="flex justify-between items-center">
                  <span className="text-slate-300 font-mono text-[11px]">Hard Stop-Loss (%)</span>
                  <span className="font-bold text-rose-400 font-mono">-{Number(expHardStopLoss).toFixed(1)}%</span>
                </div>
                <input
                  type="range"
                  min="0.5"
                  max="50"
                  step="0.5"
                  value={expHardStopLoss}
                  onChange={(e) => setExpHardStopLoss(Number(e.target.value))}
                  className="w-full accent-rose-500 cursor-pointer"
                />
                <div className="flex justify-between text-[9px] text-zinc-500 font-mono">
                  <span>Min: 0.5%</span>
                  <span className="text-rose-400">Strict respectat la -{expHardStopLoss}%</span>
                  <span>Max: 50%</span>
                </div>
              </div>

              {/* 5. Break-Even Act: default +5% */}
              <div className="bg-zinc-900/90 p-2.5 rounded border border-amber-500/20 space-y-1.5">
                <div className="flex justify-between items-center">
                  <span className="text-slate-300 font-mono text-[11px]">Break-Even Act (%)</span>
                  <span className="font-bold text-amber-300 font-mono">+{Number(expBreakEven).toFixed(1)}%</span>
                </div>
                <input
                  type="range"
                  min="0.5"
                  max="20"
                  step="0.5"
                  value={expBreakEven}
                  onChange={(e) => setExpBreakEven(Number(e.target.value))}
                  className="w-full accent-amber-500 cursor-pointer"
                />
                <div className="flex justify-between text-[9px] text-zinc-500 font-mono">
                  <span>Min: 0.5%</span>
                  <span className="text-amber-300">Mută SL la intrare la +{expBreakEven}%</span>
                  <span>Max: 20%</span>
                </div>
              </div>

              {/* 6. Trailing Act: default +2.5% */}
              <div className="bg-zinc-900/90 p-2.5 rounded border border-emerald-500/20 space-y-1.5">
                <div className="flex justify-between items-center">
                  <span className="text-slate-300 font-mono text-[11px]">Trailing Act (%)</span>
                  <span className="font-bold text-emerald-400 font-mono">+{Number(expTrailingAct).toFixed(1)}%</span>
                </div>
                <input
                  type="range"
                  min="0.5"
                  max="20"
                  step="0.1"
                  value={expTrailingAct}
                  onChange={(e) => setExpTrailingAct(Number(e.target.value))}
                  className="w-full accent-emerald-500 cursor-pointer"
                />
                <div className="flex justify-between text-[9px] text-zinc-500 font-mono">
                  <span>Min: 0.5%</span>
                  <span className="text-emerald-300">Armare trailing la +{expTrailingAct}%</span>
                  <span>Max: 20%</span>
                </div>
              </div>

              {/* 7. Trailing Dist: default -0.5% */}
              <div className="bg-zinc-900/90 p-2.5 rounded border border-purple-500/20 space-y-1.5">
                <div className="flex justify-between items-center">
                  <span className="text-slate-300 font-mono text-[11px]">Trailing Dist (%)</span>
                  <span className="font-bold text-purple-400 font-mono">-{Number(expTrailingDist).toFixed(1)}%</span>
                </div>
                <input
                  type="range"
                  min="0.1"
                  max="10"
                  step="0.1"
                  value={expTrailingDist}
                  onChange={(e) => setExpTrailingDist(Number(e.target.value))}
                  className="w-full accent-purple-500 cursor-pointer"
                />
                <div className="flex justify-between text-[9px] text-zinc-500 font-mono">
                  <span>Min: 0.1%</span>
                  <span className="text-purple-300">Distanță de la vârf: -{expTrailingDist}%</span>
                  <span>Max: 10%</span>
                </div>
              </div>

              {/* 8. Take-Profit: default +20% */}
              <div className="bg-zinc-900/90 p-2.5 rounded border border-emerald-500/20 space-y-1.5">
                <div className="flex justify-between items-center">
                  <span className="text-slate-300 font-mono text-[11px]">Take-Profit (%)</span>
                  <span className="font-bold text-emerald-400 font-mono">+{Number(expTakeProfit).toFixed(1)}%</span>
                </div>
                <input
                  type="range"
                  min="0.5"
                  max="50"
                  step="0.5"
                  value={expTakeProfit}
                  onChange={(e) => setExpTakeProfit(Number(e.target.value))}
                  className="w-full accent-emerald-500 cursor-pointer"
                />
                <div className="flex justify-between text-[9px] text-zinc-500 font-mono">
                  <span>Min: 0.5%</span>
                  <span className="text-emerald-300">Țintă profit: +{expTakeProfit}%</span>
                  <span>Max: 50%</span>
                </div>
              </div>
            </div>
          ) : (
            /* ACTIVE RUNNING RULES DISPLAY */
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2 text-[11px] font-mono">
              <div className="bg-zinc-900/80 border border-cyan-500/30 rounded p-2 text-center">
                <span className="text-zinc-500 text-[9px] block uppercase">Durată</span>
                <strong className="text-cyan-300 text-xs">{experimentState?.durationHours || 8}h</strong>
              </div>
              <div className="bg-zinc-900/80 border border-cyan-500/30 rounded p-2 text-center">
                <span className="text-zinc-500 text-[9px] block uppercase">Min Momentum</span>
                <strong className="text-amber-300 text-xs">&gt;= {experimentState?.minMomentumScore || 50}</strong>
              </div>
              <div className="bg-zinc-900/80 border border-cyan-500/30 rounded p-2 text-center">
                <span className="text-zinc-500 text-[9px] block uppercase">Max Hold</span>
                <strong className="text-amber-400 text-xs">{experimentState?.maxHoldingTimeMinutes || 120}m</strong>
              </div>
              <div className="bg-zinc-900/80 border border-rose-500/30 rounded p-2 text-center">
                <span className="text-zinc-500 text-[9px] block uppercase">Hard SL</span>
                <strong className="text-rose-400 text-xs">-{experimentState?.hardStopLossPct || 20.0}%</strong>
              </div>
              <div className="bg-zinc-900/80 border border-amber-500/30 rounded p-2 text-center">
                <span className="text-zinc-500 text-[9px] block uppercase">Break-Even</span>
                <strong className="text-amber-300 text-xs">+{experimentState?.breakEvenActivationPct || 5.0}%</strong>
              </div>
              <div className="bg-zinc-900/80 border border-emerald-500/30 rounded p-2 text-center">
                <span className="text-zinc-500 text-[9px] block uppercase">Trailing Act</span>
                <strong className="text-emerald-400 text-xs">+{experimentState?.trailingActivationPct || 2.5}%</strong>
              </div>
              <div className="bg-zinc-900/80 border border-purple-500/30 rounded p-2 text-center">
                <span className="text-zinc-500 text-[9px] block uppercase">Trailing Dist</span>
                <strong className="text-purple-400 text-xs">-{experimentState?.trailingDistancePct || 0.5}%</strong>
              </div>
              <div className="bg-zinc-900/80 border border-emerald-500/30 rounded p-2 text-center">
                <span className="text-zinc-500 text-[9px] block uppercase">Take-Profit</span>
                <strong className="text-emerald-400 text-xs">+{experimentState?.takeProfitPct || 20.0}%</strong>
              </div>
            </div>
          )}
        </div>

        {/* REAL-TIME EVENT STREAM TABLE (UNLIMITED LOGGING STREAM) */}
        <div className="bg-black/90 border border-zinc-800 rounded-lg p-3 space-y-2.5 font-mono text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800/80 pb-2">
            <div className="flex items-center space-x-2 text-zinc-300 font-bold">
              <ListFilter className="w-4 h-4 text-cyan-400" />
              <span>JURNAL ÎN TIMP REAL AL EXPERIMENTULUI ({experimentLogsCount} EVENIMENTE MEMORATE CONTINUU)</span>
            </div>
            <div className="text-[10px] text-zinc-500">
              Salvare continuă în fișier fără limita de 1000 înregistrări.
            </div>
          </div>

          <div className="overflow-x-auto min-h-[380px] max-h-[600px] overflow-y-auto">
            <table className="w-full text-left text-[11px] font-mono">
              <thead className="text-[10px] text-zinc-400 bg-zinc-900/80 uppercase border-b border-zinc-800 sticky top-0">
                <tr>
                  <th className="py-1.5 px-2">Data &amp; Ora</th>
                  <th className="py-1.5 px-2">Tip Eveniment</th>
                  <th className="py-1.5 px-2">Simbol</th>
                  <th className="py-1.5 px-2">Direcție</th>
                  <th className="py-1.5 px-2">Scor Mom</th>
                  <th className="py-1.5 px-2">Preț Intrare</th>
                  <th className="py-1.5 px-2">Preț Ieșire</th>
                  <th className="py-1.5 px-2">Marjă / Size</th>
                  <th className="py-1.5 px-2">PnL Net ($)</th>
                  <th className="py-1.5 px-2">PnL (%)</th>
                  <th className="py-1.5 px-2">Timp Deținere</th>
                  <th className="py-1.5 px-2">Motiv Ieșire</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-900">
                {experimentLogs.length === 0 ? (
                  <tr>
                    <td colSpan={12} className="py-6 text-center text-zinc-500 italic">
                      Niciun eveniment înregistrat încă în acest experiment. Pornește experimentul pentru a începe scanarea și tranzacționarea automată.
                    </td>
                  </tr>
                ) : (
                  experimentLogs.map((log: any) => {
                    const isExit = log.eventType === 'TRADE_EXIT';
                    const isEntry = log.eventType === 'TRADE_ENTRY';
                    const pnlVal = log.pnl !== undefined ? log.pnl : null;
                    const pnlPctVal = log.pnlPct !== undefined ? log.pnlPct : null;

                    return (
                      <tr key={log.id} className="hover:bg-zinc-900/50 transition-colors">
                        <td className="py-1.5 px-2 text-zinc-400 text-[10px]">
                          {log.dateStr ? log.dateStr.replace('T', ' ').substring(5, 19) : '--'}
                        </td>
                        <td className="py-1.5 px-2">
                          <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${
                            isExit
                              ? ((pnlVal || 0) >= 0 ? 'bg-emerald-950 text-emerald-300 border border-emerald-800/40' : 'bg-rose-950 text-rose-300 border border-rose-800/40')
                              : isEntry
                              ? 'bg-cyan-950 text-cyan-300 border border-cyan-800/40'
                              : 'bg-zinc-800 text-zinc-300'
                          }`}>
                            {log.eventType}
                          </span>
                        </td>
                        <td className="py-1.5 px-2 font-bold text-zinc-200">
                          {log.symbol || '--'}
                        </td>
                        <td className="py-1.5 px-2">
                          {log.side === 'BUY' ? (
                            <span className="text-emerald-400 font-bold">LONG</span>
                          ) : log.side === 'SELL' ? (
                            <span className="text-rose-400 font-bold">SHORT</span>
                          ) : (
                            <span className="text-zinc-500">--</span>
                          )}
                        </td>
                        <td className="py-1.5 px-2 text-amber-300 font-bold">
                          {log.score !== undefined && log.score !== 0 ? log.score.toFixed(1) : '--'}
                        </td>
                        <td className="py-1.5 px-2 text-zinc-300">
                          {log.entryPrice ? `$${log.entryPrice}` : '--'}
                        </td>
                        <td className="py-1.5 px-2 text-zinc-300">
                          {log.exitPrice ? `$${log.exitPrice}` : '--'}
                        </td>
                        <td className="py-1.5 px-2 text-zinc-400">
                          {log.sizeUSDT ? `$${log.sizeUSDT.toFixed(0)}` : '--'}
                        </td>
                        <td className="py-1.5 px-2 font-bold">
                          {pnlVal !== null ? (
                            <span className={pnlVal >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                              {pnlVal >= 0 ? '+' : ''}${pnlVal.toFixed(4)}
                            </span>
                          ) : (
                            <span className="text-zinc-500">--</span>
                          )}
                        </td>
                        <td className="py-1.5 px-2 font-bold">
                          {pnlPctVal !== null ? (
                            <span className={pnlPctVal >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                              {pnlPctVal >= 0 ? '+' : ''}{pnlPctVal.toFixed(2)}%
                            </span>
                          ) : (
                            <span className="text-zinc-500">--</span>
                          )}
                        </td>
                        <td className="py-1.5 px-2 text-zinc-400">
                          {log.holdingTimeMinutes !== undefined ? `${log.holdingTimeMinutes.toFixed(1)}m` : '--'}
                        </td>
                        <td className="py-1.5 px-2 text-zinc-400 text-[10px]">
                          {log.exitReason || log.details?.reason || '--'}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* TECHNICAL DETAILS & SPECIFICATION - EXPANDED TO FULL SCREEN WIDTH */}
        <div className="bg-zinc-900/60 border border-cyan-500/20 p-4 rounded text-xs space-y-3 font-mono text-zinc-300">
          <div className="font-bold text-cyan-400 flex items-center space-x-1.5 border-b border-cyan-500/20 pb-2">
            <Info className="w-4 h-4" />
            <span className="uppercase tracking-wider">Condiții &amp; Arhitectură Tehnică Experiment ({effectiveHours}h):</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 text-[11px]">
            <div className="p-3 bg-black/60 rounded border border-zinc-800 space-y-1.5">
              <span className="text-cyan-300 font-bold block flex items-center space-x-1">
                <span>⚡ MOTOR EXECUȚIE</span>
              </span>
              <p className="text-zinc-400 text-[10px] leading-relaxed">
                Profil SCALP optimizat. Scanare continuă a tuturor perechilor SWAP active OKX, decizii la tick-uri de 2.5 secunde, intrare doar la Momentum &gt;= {effectiveMinMom}.
              </p>
            </div>
            <div className="p-3 bg-black/60 rounded border border-zinc-800 space-y-1.5">
              <span className="text-emerald-400 font-bold block flex items-center space-x-1">
                <span>💰 CAPITAL &amp; LIMITĂ POZIȚII</span>
              </span>
              <p className="text-zinc-400 text-[10px] leading-relaxed">
                Balanță simulată alocată de $10,000.00 USDT, strict plafonată la maximum 50 poziții simultane ($50 per tranzacție, utilizare optimă de 25% marjă).
              </p>
            </div>
            <div className="p-3 bg-black/60 rounded border border-zinc-800 space-y-1.5">
              <span className="text-amber-400 font-bold block flex items-center space-x-1">
                <span>🛡️ REGULI PROTECȚIE &amp; EXIT</span>
              </span>
              <p className="text-zinc-400 text-[10px] leading-relaxed">
                Hard Stop-Loss strict la -{experimentState?.hardStopLossPct || expHardStopLoss}%, Break-Even la +{experimentState?.breakEvenActivationPct || expBreakEven}%, Trailing Stop dinamic și Time-Stop la {experimentState?.maxHoldingTimeMinutes || expMaxHoldMinutes}m.
              </p>
            </div>
            <div className="p-3 bg-black/60 rounded border border-zinc-800 space-y-1.5">
              <span className="text-purple-400 font-bold block flex items-center space-x-1">
                <span>📊 JURNALIZARE &amp; EXPORT</span>
              </span>
              <p className="text-zinc-400 text-[10px] leading-relaxed">
                Memorare automată fără trunchiere la 1000 înregistrări. Export instant prin butoanele de sus în fișiere conform formatului JSON și CSV pentru analiză Excel / Python.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  };

  const renderTelegramConfigCard = () => {
    const isConfigured = Boolean(status?.telegramActive || status?.telegramStatus?.configured);
    const hasToken = Boolean(status?.telegramStatus?.hasToken || telegramTokenInput.trim());
    const botNameOrUser = status?.telegramStatus?.botUsername || telegramTestFeedback?.botUsername;

    return (
      <div id="telegram-config-card" className="bg-black/90 p-3.5 rounded border border-sky-500/30 space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-zinc-900 pb-2.5">
          <span className="text-sky-400 font-bold text-xs flex items-center space-x-2">
            <Send className="w-4 h-4 text-sky-400" />
            <span>CONFIGURARE TELEGRAM BOT &amp; CANAL / CHAT</span>
          </span>
          <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono">
            {isConfigured && (
              <button
                type="button"
                onClick={handleToggleTelegramNotifications}
                className={`px-2.5 py-1 rounded font-bold flex items-center space-x-1.5 transition-all shadow cursor-pointer border ${
                  isTelegramNotificationsEnabled
                    ? 'bg-emerald-950 text-emerald-300 border-emerald-500 hover:bg-emerald-900'
                    : 'bg-rose-950 text-rose-300 border-rose-500 hover:bg-rose-900 animate-pulse'
                }`}
                title="Comută notificările Telegram ON / OFF (Mod Noapte)"
              >
                {isTelegramNotificationsEnabled ? (
                  <>
                    <Bell className="w-3.5 h-3.5 text-emerald-400" />
                    <span>NOTIFICĂRI: ACTIVE (ON)</span>
                  </>
                ) : (
                  <>
                    <BellOff className="w-3.5 h-3.5 text-rose-400" />
                    <span>NOTIFICĂRI: OPRITE (OFF / NOAPTE)</span>
                  </>
                )}
              </button>
            )}

            <span className={`px-2 py-0.5 rounded border ${
              isConfigured
                ? (isTelegramNotificationsEnabled ? 'bg-emerald-950/80 text-emerald-300 border-emerald-500/60' : 'bg-rose-950/80 text-rose-300 border-rose-500/60')
                : hasToken
                ? 'bg-amber-950/80 text-amber-300 border-amber-500/60'
                : 'bg-zinc-900 text-zinc-400 border-zinc-700'
            }`}>
              {isConfigured
                ? (isTelegramNotificationsEnabled
                    ? `● ACTIV & CONECTAT ${botNameOrUser ? `(@${botNameOrUser})` : ''}`
                    : `🔕 MUTE / MOD NOAPTE ${botNameOrUser ? `(@${botNameOrUser})` : ''}`)
                : hasToken
                ? '○ TOKEN PREZENT (LIPSEȘTE CANAL/CHAT ID)'
                : '○ NECONFIGURAT / STANDBY'}
            </span>
          </div>
        </div>

        {/* Informative Step-by-Step Guide Banner */}
        <div className="bg-zinc-950/90 border border-sky-500/20 rounded p-2.5 text-[11px] text-zinc-300 space-y-1.5 font-sans">
          <div className="font-bold text-sky-400 flex items-center space-x-1.5">
            <HelpCircle className="w-3.5 h-3.5 text-sky-400" />
            <span>GHID RAPID ACTIVARE TELEGRAM ÎN 3 PAȘI:</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2 pt-1 text-[11px] leading-relaxed">
            <div className="bg-black/50 p-2 rounded border border-zinc-800/80">
              <strong className="text-amber-400">1. Obține Bot Token:</strong> Deschide Telegram, caută <code className="text-sky-300">@BotFather</code>, trimite comanda <code>/newbot</code> și copiază cheia API (Token-ul generat).
            </div>
            <div className="bg-black/50 p-2 rounded border border-zinc-800/80">
              <strong className="text-amber-400">2. Adaugă Botul în Canal:</strong> Adaugă botul creat în canalul sau grupul dorit ca <strong>Administrator</strong> (cu permisiune de a posta mesaje). Sau trimite-i <code>/start</code> în privat.
            </div>
            <div className="bg-black/50 p-2 rounded border border-zinc-800/80">
              <strong className="text-amber-400">3. Introdu &amp; Salvează:</strong> Introdu Token-ul și ID-ul Canalului (ex: <code>-100...</code> sau <code>@canalul_tau</code>), apasă <strong>Testare</strong> și apoi <strong>Salvare</strong>.
            </div>
          </div>
        </div>

        {/* Input Fields */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-zinc-400 text-[10px] font-mono">
                TELEGRAM_BOT_TOKEN (API Token)
              </label>
              {status?.telegramStatus?.hasToken && !telegramTokenInput && (
                <span className="text-[10px] text-emerald-400 font-mono">
                  Salvată pe server ({status.telegramStatus.maskedToken})
                </span>
              )}
            </div>
            <div className="relative">
              <input
                type={telegramShowToken ? 'text' : 'password'}
                value={telegramTokenInput}
                onChange={(e) => setTelegramTokenInput(e.target.value)}
                placeholder={status?.telegramStatus?.hasToken ? `Token curent: ${status.telegramStatus.maskedToken} (lasă gol pentru a păstra)` : 'ex: 1234567890:AAHdqTcvCH1vGWJxfSeofSAs...'}
                className="w-full bg-zinc-950 text-amber-300 border border-zinc-800 rounded px-2.5 py-1.5 pr-8 text-xs font-mono focus:outline-none focus:border-sky-400"
              />
              <button
                type="button"
                onClick={() => setTelegramShowToken(!telegramShowToken)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
                title={telegramShowToken ? 'Ascunde Token' : 'Arată Token'}
              >
                {telegramShowToken ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              </button>
            </div>
            <p className="text-[10px] text-zinc-500 mt-1">
              Cheia secretă eliberată de @BotFather pentru comunicarea securizată cu Telegram API.
            </p>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-zinc-400 text-[10px] font-mono">
                TELEGRAM_CHAT_ID (Canal sau Chat ID)
              </label>
              {status?.telegramStatus?.chatId && (
                <span className="text-[10px] text-emerald-400 font-mono">
                  {status.telegramStatus.chatId}
                </span>
              )}
            </div>
            <input
              type="text"
              value={telegramChatIdInput}
              onChange={(e) => setTelegramChatIdInput(e.target.value)}
              placeholder="ex: -1001234567890 (Canal), @nume_canal sau 123456789 (Privat)"
              className="w-full bg-zinc-950 text-amber-300 border border-zinc-800 rounded px-2.5 py-1.5 text-xs font-mono focus:outline-none focus:border-sky-400"
            />
            <p className="text-[10px] text-zinc-500 mt-1">
              Canalele/Supergrupurile încep de regulă cu <code className="text-sky-400">-100</code> sau poți folosi username-ul public <code className="text-sky-400">@canalul_tau</code>.
            </p>
          </div>
        </div>

        {/* Buttons & Actions */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 pt-1 border-t border-zinc-900">
          <div className="text-[11px] text-zinc-400">
            {isConfigured ? (
              <span className="text-emerald-400 flex items-center space-x-1">
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>Alertele automate și interogările prin comenzi Telegram sunt active.</span>
              </span>
            ) : (
              <span className="text-amber-400 flex items-center space-x-1">
                <AlertTriangle className="w-3.5 h-3.5" />
                <span>Completează ambele câmpuri pentru a primi alerte de tranzacții și rapoarte orare.</span>
              </span>
            )}
          </div>

          <div className="flex items-center space-x-2 shrink-0">
            <button
              type="button"
              onClick={handleRunTelegramTest}
              disabled={isTestingTelegram || (!telegramTokenInput.trim() && !status?.telegramStatus?.hasToken)}
              className="px-3 py-1.5 bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-sky-300 rounded text-xs font-bold flex items-center space-x-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
              title="Validează tokenul și trimite un mesaj de confirmare pe canal/chat"
            >
              <Wifi className="w-3.5 h-3.5 text-sky-400" />
              <span>{isTestingTelegram ? 'TESTARE...' : 'TESTEAZĂ CONEXIUNEA'}</span>
            </button>

            <button
              type="button"
              onClick={handleSaveTelegramCredentials}
              disabled={isSavingTelegram || (!telegramTokenInput.trim() && !status?.telegramStatus?.hasToken)}
              className="px-4 py-1.5 bg-sky-500 hover:bg-sky-400 text-black rounded text-xs font-bold flex items-center space-x-1.5 disabled:opacity-40 disabled:cursor-not-allowed shadow-md"
            >
              <Save className="w-3.5 h-3.5" />
              <span>{isSavingTelegram ? 'SALVARE...' : 'SALVEAZĂ TELEGRAM PE BOT'}</span>
            </button>
          </div>
        </div>

        {telegramSaveMessage && (
          <div className="p-2 rounded bg-zinc-900 border border-sky-500/40 text-xs font-mono text-sky-300">
            {telegramSaveMessage}
          </div>
        )}

        {/* Detailed Test Feedback Banner */}
        {telegramTestFeedback && telegramTestFeedback.tested && (
          <div className={`p-2.5 rounded border text-xs font-mono space-y-1.5 ${
            telegramTestFeedback.success
              ? 'bg-emerald-950/60 border-emerald-500/50 text-emerald-300'
              : telegramTestFeedback.validToken
              ? 'bg-amber-950/60 border-amber-500/50 text-amber-300'
              : 'bg-rose-950/60 border-rose-500/50 text-rose-300'
          }`}>
            <div className="font-bold flex items-center space-x-2">
              {telegramTestFeedback.success ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              ) : telegramTestFeedback.validToken ? (
                <AlertTriangle className="w-4 h-4 text-amber-400" />
              ) : (
                <XCircle className="w-4 h-4 text-rose-400" />
              )}
              <span>REZULTAT TEST CONEXIUNE TELEGRAM:</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-1 text-[11px]">
              <div>
                • Conexiune Telegram API: <strong>{telegramTestFeedback.reachable ? '✅ CONECTAT' : '❌ INACCESIBIL'}</strong>
              </div>
              <div>
                • Validitate Bot Token: <strong>{telegramTestFeedback.validToken ? `✅ VALID (${telegramTestFeedback.botUsername ? `@${telegramTestFeedback.botUsername}` : 'OK'})` : '❌ INVALID'}</strong>
              </div>
              <div>
                • Livrare Mesaj Canal/Chat: <strong>{telegramTestFeedback.chatDelivered ? '✅ LIVRAT CU SUCCES' : telegramChatIdInput || status?.telegramStatus?.chatId ? '❌ EȘUAT' : '⚪ NESPECIFICAT'}</strong>
              </div>
            </div>

            {telegramTestFeedback.error && (
              <div className="text-[11px] text-rose-300 pt-1 leading-relaxed border-t border-rose-900/50 mt-1">
                ⚠️ <strong>Diagnostic Telegram:</strong> {telegramTestFeedback.error}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

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
    if (typeof window !== 'undefined' && window.innerWidth < 1024) {
      setActiveScreen('CHART');
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

  const getOrderLabel = (ord: OrderRecord) => {
    if (ord.intent !== 'ENTRY') return 'CLOSE';
    return ord.side === 'BUY' ? 'LONG' : 'SHORT';
  };

  const handleExportOrders = () => {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const headers = [
      'Order ID',
      'Position ID',
      'Exchange ID',
      'Symbol',
      'Side',
      'Intent',
      'Profile',
      'Execution Mode',
      'Size (USDT)',
      'Qty',
      'Leverage',
      'Model Score (metaScore)',
      'Rank At Entry',
      'Spread At Entry (%)',
      'Candle Elapsed Seconds',
      'HTF Trend (Entry)',
      'Entry Factors',
      'Signal Price',
      'Signal Price (Exact 8D+)',
      'Fill Price',
      'Fill Price (Exact 8D+)',
      'Estimated Slippage (%)',
      'Status',
      'PnL ($)',
      'PnL (%)',
      'MAE (%)',
      'MFE (%)',
      'Fee ($)',
      'Entry Price',
      'Entry Price (Exact 8D+)',
      'Exit Reason Detail',
      'Holding Time (min)',
      'Open Positions Count',
      'BTC Regime (Entry)',
      'BTC Regime (Exit)',
      'Account Equity ($)',
      'Account Balance ($)',
      'Created At',
      'Updated At',
    ];

    const rows = orders.map((o) => [
      o.id,
      o.positionId || '',
      o.exchangeOrderId || '',
      o.symbol,
      getOrderLabel(o),
      o.intent,
      o.profile,
      o.executionMode,
      o.sizeUSDT,
      o.qty,
      o.leverage || '1x',
      o.signalScore !== undefined ? o.signalScore : '',
      o.rankAtEntry !== undefined ? o.rankAtEntry : '',
      o.spreadPctAtEntry !== undefined ? o.spreadPctAtEntry : '',
      o.candleElapsedSecondsAtEntry !== undefined ? o.candleElapsedSecondsAtEntry : '',
      o.htfTrendAtEntry || '',
      o.entryFactors ? JSON.stringify(o.entryFactors) : '',
      formatPrice(o.signalPrice),
      formatExactPriceForExport(o.signalPrice),
      formatPrice(o.fillPrice),
      formatExactPriceForExport(o.fillPrice),
      o.estimatedSlippagePct !== undefined ? `${o.estimatedSlippagePct > 0 ? '+' : ''}${o.estimatedSlippagePct}%` : '',
      o.status,
      o.realizedPnl !== undefined ? o.realizedPnl : '',
      o.realizedPnlPct !== undefined ? o.realizedPnlPct : '',
      o.maePct !== undefined ? `${o.maePct}%` : '',
      o.mfePct !== undefined ? `+${o.mfePct}%` : '',
      o.cumFee !== undefined ? o.cumFee : (o.sizeUSDT * 0.0005).toFixed(4),
      formatPrice(o.entryPrice),
      formatExactPriceForExport(o.entryPrice),
      o.exitReasonDetail || '',
      o.holdingTimeMinutes || '',
      o.openPositionsCount !== undefined ? o.openPositionsCount : '',
      o.marketRegime || '',
      o.exitMarketRegime || '',
      o.accountEquity !== undefined ? o.accountEquity : '',
      o.accountBalance !== undefined ? o.accountBalance : '',
      new Date(o.createdTime).toLocaleString(),
      o.updatedTime ? new Date(o.updatedTime).toLocaleString() : '',
    ]);

    exportToCSV(`TradeBot_Orders_${timestamp}.csv`, headers, rows);
  };

  const handleExportLogs = () => {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const headers = ['Log ID', 'Timestamp', 'Type', 'Message', 'Details'];

    // Exportă ultimele până la 500 de evenimente de audit
    const exportLogs = logs.slice(0, 500);
    const rows = exportLogs.map((l) => [
      l.id,
      new Date(l.timestamp).toLocaleString(),
      l.type,
      l.message,
      l.details ? JSON.stringify(l.details) : '',
    ]);

    exportToCSV(`TradeBot_DeskLogs_Last${exportLogs.length}_${timestamp}.csv`, headers, rows);
  };

  const handleExportEquityProtectionCSV = () => {
    const events: EquityProtectionEvent[] = status?.equityTrailingState?.history || [];
    if (events.length === 0) {
      setLocalAlert({ type: 'info', message: 'Nu există declanșări înregistrate în jurnalul protecției.' });
      return;
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const headers = [
      'ID Eveniment',
      'Trigger #',
      'Data & Ora',
      'Profil',
      'Mod Execuție',
      'Total Equity ($)',
      'Capital Lucru ($)',
      'Vârf Atins ($)',
      'Drawdown Realizat (%)',
      'Limită Drawdown Permisă (%)',
      'Prag Activare ($)',
      'Seif Înainte ($)',
      'Profit Transferat în Seif ($)',
      'Seif După Declanșare ($)',
      'Bază Fixă ($)',
      'Număr Poziții Închise',
      'Detalii Poziții Închise',
    ];

    const rows = events.map((ev) => [
      ev.id,
      ev.triggerIndex,
      ev.dateStr,
      ev.profile,
      ev.executionMode,
      ev.totalEquity.toFixed(2),
      ev.effectiveEquity.toFixed(2),
      ev.peakEquity.toFixed(2),
      `-${ev.drawdownFromPeakPct.toFixed(2)}%`,
      `-${ev.configuredDrawdownLimitPct.toFixed(2)}%`,
      ev.activationPrice.toFixed(2),
      ev.vaultBefore.toFixed(2),
      ev.profitLockedToVault.toFixed(2),
      ev.vaultAfter.toFixed(2),
      ev.baseCapital.toFixed(2),
      ev.closedPositionsCount,
      (ev.closedPositions || [])
        .map((p) => `${p.symbol} (${p.side} $${p.sizeUSDT} @ $${p.closePrice}, PnL: ${p.pnl !== undefined ? (p.pnl >= 0 ? '+' : '') + p.pnl.toFixed(2) : '--'})`)
        .join(' | '),
    ]);

    exportToCSV(`TradeBot_EquityProtection_Logs_${timestamp}.csv`, headers, rows);
    setLocalAlert({
      type: 'success',
      message: `✅ Jurnalul declanșărilor (${events.length} înregistrări) a fost exportat cu succes în format CSV!`,
    });
  };

  const handleClearEquityProtection = async () => {
    const triggerCount = status?.equityTrailingState?.triggerCount || (status?.equityTrailingState?.history || []).length || 0;
    if (!window.confirm(`Ești sigur că vrei să resetezi contorul și să golești jurnalul declanșărilor protecției de capital?\n\nToate cele ${triggerCount} cicluri înregistrate vor fi șterse, iar baza de urmărire va fi realiniată la capitalul curent.`)) {
      return;
    }
    setIsClearingEquityProtection(true);
    try {
      const token = localStorage.getItem('tb5_control_token') || 'tradebot5_admin_token';
      const res = await fetch('/api/bot/equity-protection/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-bot-token': token },
      });
      const data = await res.json();
      if (res.ok && data.success) {
        onRefresh();
        setLocalAlert({
          type: 'success',
          message: '✅ Jurnalul și contorul protecției de capital au fost resetate la 0 cu succes!',
        });
      } else {
        setLocalAlert({
          type: 'error',
          message: data.error || 'Eroare la resetarea jurnalului protecției.',
        });
      }
    } catch (err: any) {
      setLocalAlert({
        type: 'error',
        message: 'Eroare la resetarea jurnalului: ' + (err.message || 'Server indisponibil'),
      });
    } finally {
      setIsClearingEquityProtection(false);
    }
  };

  const hasUnsavedSettings = profileConfig ? (
    riskPerTrade !== (profileConfig.riskPerTradePct ?? 50) ||
    maxPositions !== (profileConfig.maxOpenPositions ?? 2) ||
    hardStopLoss !== (profileConfig.hardStopLossPct ?? 20.0) ||
    trailingAct !== (profileConfig.trailingActivationPct ?? 1.1) ||
    trailingDist !== (profileConfig.trailingDistancePct ?? 0.35) ||
    minMomentum !== (profileConfig.minMomentumScore ?? 50) ||
    maxMomentum !== (profileConfig.maxMomentumScore ?? 99) ||
    min24hVol !== ((profileConfig.min24hVolumeUSDT ?? 1_500_000) / 1_000_000) ||
    max24hVol !== ((profileConfig.max24hVolumeUSDT ?? 0) / 1_000_000) ||
    takeProfit !== (profileConfig.takeProfitPct ?? 20) ||
    breakEven !== (profileConfig.breakEvenActivationPct ?? 5.0) ||
    maxHoldTime !== (profileConfig.maxHoldingTimeMinutes ?? 45) ||
    stagnationTime !== (profileConfig.stagnationTimeMinutes ?? 0) ||
    equityProtAct !== (profileConfig.equityProtectionActivationPct ?? 1.9) ||
    equityTrailingDraw !== (profileConfig.equityTrailingDrawdownPct ?? 0.3) ||
    cooldownMins !== (profileConfig.cooldownMinutes ?? 0) ||
    sentimentThreshold !== (profileConfig.sentimentThreshold ?? 5.0) ||
    shortRegimeGuard !== (profileConfig.shortRegimeGuard ?? 'OFF') ||
    btcBearGuard !== (profileConfig.btcBearGuard ?? false) ||
    minShortScore !== (profileConfig.minShortMomentumScore ?? 0) ||
    maxEntriesPerHour !== (profileConfig.maxEntriesPerSymbolPerHour ?? 3) ||
    cooldownAfterLoss !== (profileConfig.cooldownAfterLossMinutes ?? 30)
  ) : false;

  // Sync local state when profileConfig or activeProfile changes, but NOT if there are unsaved settings
  useEffect(() => {
    if (profileConfig && !hasUnsavedSettings) {
      setEquityProtAct(profileConfig.equityProtectionActivationPct ?? 1.9);
      setEquityTrailingDraw(profileConfig.equityTrailingDrawdownPct ?? 0.3);
      setRiskPerTrade(profileConfig.riskPerTradePct ?? 50);
      setMaxPositions(profileConfig.maxOpenPositions ?? 2);
      setHardStopLoss(profileConfig.hardStopLossPct ?? 20.0);
      setTrailingAct(profileConfig.trailingActivationPct ?? 1.1);
      setTrailingDist(profileConfig.trailingDistancePct ?? 0.35);
      setMinMomentum(
        Math.min(95, Math.max(50, profileConfig.minMomentumScore ?? 50))
      );
      setMaxMomentum(
        Math.min(99, Math.max(70, profileConfig.maxMomentumScore ?? 99))
      );
      setMin24hVol(
        profileConfig.min24hVolumeUSDT !== undefined
          ? profileConfig.min24hVolumeUSDT / 1_000_000
          : 1.5
      );
      setMax24hVol(
        profileConfig.max24hVolumeUSDT !== undefined
          ? profileConfig.max24hVolumeUSDT / 1_000_000
          : 0
      );
      setTakeProfit(profileConfig.takeProfitPct ?? 20);
      setBreakEven(profileConfig.breakEvenActivationPct ?? 5.0);
      setMaxHoldTime(profileConfig.maxHoldingTimeMinutes ?? 45);
      setStagnationTime(profileConfig.stagnationTimeMinutes ?? 0);
      setCooldownMins(profileConfig.cooldownMinutes ?? 0);
      setSentimentThreshold(profileConfig.sentimentThreshold ?? 5.0);
      setShortRegimeGuard(profileConfig.shortRegimeGuard ?? 'OFF');
      setBtcBearGuard(profileConfig.btcBearGuard ?? false);
      setMinShortScore(profileConfig.minShortMomentumScore ?? 0);
      setMaxEntriesPerHour(profileConfig.maxEntriesPerSymbolPerHour ?? 3);
      setCooldownAfterLoss(profileConfig.cooldownAfterLossMinutes ?? 30);
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
      maxMomentumScore: maxMomentum,
      min24hVolumeUSDT: Math.round(min24hVol * 1_000_000),
      max24hVolumeUSDT: max24hVol > 0 ? Math.round(max24hVol * 1_000_000) : 0,
      takeProfitPct: takeProfit,
      breakEvenActivationPct: breakEven,
      maxHoldingTimeMinutes: maxHoldTime,
      stagnationTimeMinutes: stagnationTime,
      equityProtectionActivationPct: equityProtAct,
      equityTrailingDrawdownPct: equityTrailingDraw,
      cooldownMinutes: cooldownMins,
      sentimentThreshold,
      shortRegimeGuard,
      btcBearGuard,
      minShortMomentumScore: minShortScore,
      maxEntriesPerSymbolPerHour: maxEntriesPerHour,
      cooldownAfterLossMinutes: cooldownAfterLoss,
    });
    setSettingsSavedMessage('Modificările au fost salvate cu succes!');
    setTimeout(() => setSettingsSavedMessage(null), 3500);
  };

  const handleResetSettingsToSaved = () => {
    if (!profileConfig) return;
    setRiskPerTrade(profileConfig.riskPerTradePct ?? 50);
    setMaxPositions(profileConfig.maxOpenPositions ?? 2);
    setHardStopLoss(profileConfig.hardStopLossPct ?? 20.0);
    setTrailingAct(profileConfig.trailingActivationPct ?? 1.1);
    setTrailingDist(profileConfig.trailingDistancePct ?? 0.35);
    setMinMomentum(
      Math.min(95, Math.max(50, profileConfig.minMomentumScore ?? 50))
    );
    setMaxMomentum(
      Math.min(99, Math.max(70, profileConfig.maxMomentumScore ?? 99))
    );
    setMin24hVol(
      profileConfig.min24hVolumeUSDT !== undefined
        ? profileConfig.min24hVolumeUSDT / 1_000_000
        : 1.5
    );
    setMax24hVol(
      profileConfig.max24hVolumeUSDT !== undefined
        ? profileConfig.max24hVolumeUSDT / 1_000_000
        : 0
    );
    setTakeProfit(profileConfig.takeProfitPct ?? 20);
    setBreakEven(profileConfig.breakEvenActivationPct ?? 5.0);
    setMaxHoldTime(profileConfig.maxHoldingTimeMinutes ?? 45);
    setStagnationTime(profileConfig.stagnationTimeMinutes ?? 0);
    setEquityProtAct(profileConfig.equityProtectionActivationPct ?? 1.9);
    setEquityTrailingDraw(profileConfig.equityTrailingDrawdownPct ?? 0.3);
    setCooldownMins(profileConfig.cooldownMinutes ?? 0);
    setSentimentThreshold(profileConfig.sentimentThreshold ?? 5.0);
    setShortRegimeGuard(profileConfig.shortRegimeGuard ?? 'OFF');
    setBtcBearGuard(profileConfig.btcBearGuard ?? false);
    setMinShortScore(profileConfig.minShortMomentumScore ?? 0);
    setMaxEntriesPerHour(profileConfig.maxEntriesPerSymbolPerHour ?? 3);
    setCooldownAfterLoss(profileConfig.cooldownAfterLossMinutes ?? 30);
    setSettingsSavedMessage(null);
  };

  // =========================================================================
  // VITEZA REAL-TIME TAPE: 72 px/sec (~1.2 px per frame la 60fps)
  // Derulare 100% fluidă și continuă fără salturi, întreruperi sau tremur
  // Folosește delta-time și lățimea exactă a Track 1 pentru tranziție matematic fără cusur (0px salt)
  // =========================================================================
  useEffect(() => {
    let animId: number;
    let lastTime = performance.now();
    const SPEED_PX_PER_SEC = 72;

    let isTickerHovered = false;
    let isAuditHovered = false;

    const tickerEl = tickerRef.current;
    const auditEl = auditTapeRef.current;

    const onTickerEnter = () => { isTickerHovered = true; };
    const onTickerLeave = () => { isTickerHovered = false; };
    const onAuditEnter = () => { isAuditHovered = true; };
    const onAuditLeave = () => { isAuditHovered = false; };

    tickerEl?.addEventListener('mouseenter', onTickerEnter);
    tickerEl?.addEventListener('mouseleave', onTickerLeave);
    auditEl?.addEventListener('mouseenter', onAuditEnter);
    auditEl?.addEventListener('mouseleave', onAuditLeave);

    const step = (now: number) => {
      const delta = Math.min(40, now - lastTime); // cap la 40ms pentru stabilitate la revenirea din background
      lastTime = now;
      const move = (SPEED_PX_PER_SEC * delta) / 1000;

      // 1. AUTO-TAPE (derulare continuă spre stânga fără restart sau salturi)
      if (tickerEl && !isTickerHovered && autoTapeTrackRef.current) {
        const trackW = autoTapeTrackRef.current.offsetWidth;
        if (trackW > 0) {
          tickerPos.current += move;
          if (tickerPos.current >= trackW) {
            tickerPos.current -= trackW;
          }
          tickerEl.scrollLeft = tickerPos.current;
        }
      }

      // 2. DESK AUDIT FEED TAPE (derulare continuă spre stânga fără restart sau salturi)
      if (auditEl && !isAuditHovered && auditTrackRef.current) {
        const auditTrackW = auditTrackRef.current.offsetWidth;
        if (auditTrackW > 0) {
          auditPos.current += move;
          if (auditPos.current >= auditTrackW) {
            auditPos.current -= auditTrackW;
          }
          auditEl.scrollLeft = auditPos.current;
        }
      }

      animId = requestAnimationFrame(step);
    };

    animId = requestAnimationFrame(step);

    return () => {
      cancelAnimationFrame(animId);
      tickerEl?.removeEventListener('mouseenter', onTickerEnter);
      tickerEl?.removeEventListener('mouseleave', onTickerLeave);
      auditEl?.removeEventListener('mouseenter', onAuditEnter);
      auditEl?.removeEventListener('mouseleave', onAuditLeave);
    };
  }, []);

  // Check whether the shortcuts bar has overflow to the left or right
  const checkShortcutsScroll = () => {
    const el = shortcutsRef.current;
    if (el) {
      const hasOverflow = el.scrollWidth > el.clientWidth;
      setCanScrollLeft(hasOverflow && el.scrollLeft > 6);
      setCanScrollRight(hasOverflow && el.scrollLeft + el.clientWidth < el.scrollWidth - 6);
    }
  };

  useEffect(() => {
    checkShortcutsScroll();
    const el = shortcutsRef.current;
    if (!el) return;

    const onScroll = () => checkShortcutsScroll();
    el.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', checkShortcutsScroll);

    const t1 = setTimeout(checkShortcutsScroll, 100);
    const t2 = setTimeout(checkShortcutsScroll, 500);

    return () => {
      el.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', checkShortcutsScroll);
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [activeScreen, status?.positions?.length, lang, activeProfile]);

  const scrollShortcuts = (direction: 'left' | 'right') => {
    if (shortcutsRef.current) {
      const delta = direction === 'left' ? -220 : 220;
      shortcutsRef.current.scrollBy({ left: delta, behavior: 'smooth' });
    }
  };

  const handleShortcutsWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (shortcutsRef.current) {
      if (e.deltaY !== 0) {
        shortcutsRef.current.scrollLeft += e.deltaY;
        checkShortcutsScroll();
      }
    }
  };

  const handleShortcutsMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!shortcutsRef.current) return;
    if ((e.target as HTMLElement).closest('button')) return;
    isDraggingShortcuts.current = true;
    dragStartX.current = e.pageX - shortcutsRef.current.offsetLeft;
    dragScrollLeft.current = shortcutsRef.current.scrollLeft;
  };

  const handleShortcutsMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isDraggingShortcuts.current || !shortcutsRef.current) return;
    e.preventDefault();
    const x = e.pageX - shortcutsRef.current.offsetLeft;
    const walk = (x - dragStartX.current) * 1.5;
    shortcutsRef.current.scrollLeft = dragScrollLeft.current - walk;
    checkShortcutsScroll();
  };

  const handleShortcutsMouseUp = () => {
    isDraggingShortcuts.current = false;
  };

  // Generate real-time tape stream items from scanner and activity
  useEffect(() => {
    const items: TapeItem[] = [];

    // Add scanner top opportunities with genuine momentum metrics & local time
    if (status?.scannerStats?.topOpportunities && status.scannerStats.topOpportunities.length > 0) {
      const topOpps = status.scannerStats.topOpportunities.slice(0, 20);
      topOpps.forEach((opp, idx) => {
        const timeStr = formatTimeLocal(opp.lastScannedTime || status?.scannerStats?.lastScanTimestamp || Date.now());
        const pctStr = (opp.priceChange24hPct || 0) >= 0 ? `+${(opp.priceChange24hPct || 0).toFixed(2)}%` : `${(opp.priceChange24hPct || 0).toFixed(2)}%`;
        const genuineSide = opp.signal?.side || opp.side;
        const climaxTag = opp.climax || opp.signal?.climax ? ' | ⚡CLIMAX' : '';
        items.push({
          id: `opp_${opp.symbol}_${idx}`,
          timestamp: timeStr,
          symbol: opp.symbol,
          side: genuineSide, // Genuine evaluated direction (BUY / SELL), not 24h change
          price: opp.price,
          size: `Scor ${opp.score.toFixed(1)} | RVOL ${opp.rvol.toFixed(1)}x | ${pctStr}${climaxTag}`,
          type: 'SIGNAL',
        });
      });
    }
    
    // Add real orders to tape
    orders.forEach((ord) => {
      items.push({
        id: `ord_${ord.id}`,
        timestamp: formatTimeLocal(ord.createdTime),
        symbol: ord.symbol,
        side: ord.side,
        price: ord.fillPrice || 0,
        size: `$${ord.sizeUSDT.toFixed(0)}`,
        type: ord.status === 'FILLED' ? 'FILL' : 'TRADE',
      });
    });

    // Add real open positions to tape
    status?.positions?.forEach((pos) => {
      items.push({
        id: `pos_${pos.id}`,
        timestamp: formatTimeLocal(pos.entryTime),
        symbol: pos.symbol,
        side: pos.side,
        price: pos.entryPrice,
        size: `$${pos.sizeUSDT.toFixed(0)}`,
        type: 'TRADE',
      });
    });

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
      console.warn('Failed to update scanner config', err);
    } finally {
      setScannerSaving(false);
    }
  };

  const handleToggleInvertSignals = async () => {
    try {
      const token = localStorage.getItem('tb5_control_token') || 'tradebot5_admin_token';
      const res = await fetch('/api/bot/invert-signals', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-bot-token': token,
        },
        body: JSON.stringify({ enabled: !status?.config?.invertSignals }),
      });
      if (res.ok) {
        onRefresh();
      }
    } catch (err) {
      console.warn('Eroare la comutarea inversării semnalelor:', err);
    }
  };

  const isExpOn = Boolean(status?.isExperimentActive || experimentState?.isActive);
  const effectiveExpHours = isExpOn ? (experimentState?.durationHours || 8) : expDurationHours;
  const effectiveExpMinMom = isExpOn ? (experimentState?.minMomentumScore || 50) : expMinMomentum;
  const positions = status?.positions || [];
  const currentEquity = isExpOn
    ? (status?.equity && status.equity > 500 ? status.equity : (experimentState?.unlimitedCapital || 10_000))
    : (status?.equity !== undefined ? status.equity : 200.0);
  const initialEquity = isExpOn
    ? (status?.initialEquity && status.initialEquity > 500 ? status.initialEquity : (experimentState?.unlimitedCapital || 10_000))
    : (status?.initialEquity !== undefined ? status.initialEquity : 200.0);
  const activePositions = positions.filter((p) => p.status === 'OPEN');

  const marginInvested = status?.marginInvested !== undefined
    ? status.marginInvested
    : activePositions.reduce((acc, p) => acc + (p.sizeUSDT || 0), 0);

  const unrealizedPnL = status?.unrealizedPnL !== undefined
    ? status.unrealizedPnL
    : activePositions.reduce((acc, p) => acc + (p.pnl || 0), 0);

  const unrealizedPnLPct = marginInvested > 0 ? (unrealizedPnL / marginInvested) * 100 : 0;

  const walletBalance = isExpOn
    ? (status?.walletBalance && status.walletBalance > 500 ? status.walletBalance : (experimentState?.unlimitedCapital || 10_000))
    : (status?.walletBalance !== undefined ? status.walletBalance : (currentEquity - unrealizedPnL));

  const freeBalance = isExpOn
    ? (status?.freeBalance && status.freeBalance > 500 ? status.freeBalance : Math.max(0, walletBalance - marginInvested))
    : (status?.freeBalance !== undefined ? status.freeBalance : Math.max(0, walletBalance - marginInvested));

  const totalProfit = status?.totalProfit !== undefined
    ? status.totalProfit
    : (currentEquity - initialEquity);

  const totalProfitPct = status?.totalProfitPct !== undefined
    ? status.totalProfitPct
    : (initialEquity > 0 ? (totalProfit / initialEquity) * 100 : 0);

  const totalPnL = unrealizedPnL;
  const lockedCapital = marginInvested;
  const isKillSwitch = status?.config?.killSwitchEngaged;

  const profitVault = status?.profitVault !== undefined ? status.profitVault : 0;
  const operatingEquity = isExpOn
    ? currentEquity
    : (status?.operatingEquity !== undefined ? status.operatingEquity : Math.max(10, currentEquity - profitVault));
  const baseCapital = isExpOn
    ? (experimentState?.unlimitedCapital || 10_000)
    : (status?.baseCapital !== undefined ? status.baseCapital : (status?.config?.baseCapital || initialEquity));
  const usableFreeBalance = isExpOn
    ? freeBalance
    : (status?.usableFreeBalance !== undefined ? status.usableFreeBalance : Math.max(0, freeBalance - profitVault));
  const isVaultActive = Boolean(status?.lockProfitVault);

  const handleToggleProfitVault = async () => {
    try {
      const token = localStorage.getItem('tb5_control_token') || 'tradebot5_admin_token';
      const res = await fetch('/api/bot/vault/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-bot-token': token },
        body: JSON.stringify({ enabled: !isVaultActive }),
      });
      if (res.ok) {
        onRefresh();
        setLocalAlert({
          type: 'success',
          message: !isVaultActive
            ? `Profit Vault ACTIVAT: Profitul peste baza curată de $${baseCapital.toFixed(2)} USDT va fi transferat automat în Seif.`
            : 'Profit Vault DEZACTIVAT: Profiturile vor fi utilizate normal.',
        });
      }
    } catch (err: any) {
      setLocalAlert({
        type: 'error',
        message: 'Eroare la comutarea Profit Vault: ' + (err.message || 'Eroare conexiune'),
      });
    }
  };

  const isTelegramConfigured = Boolean(status?.telegramStatus?.configured || (status?.telegramStatus?.hasToken && status?.telegramStatus?.hasChatId));
  const isTelegramNotificationsEnabled = status?.telegramStatus?.notificationsEnabled !== false;

  const handleToggleTelegramNotifications = async () => {
    try {
      const token = localStorage.getItem('tb5_control_token') || 'tradebot5_admin_token';
      const res = await fetch('/api/bot/telegram/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-bot-token': token },
        body: JSON.stringify({ enabled: !isTelegramNotificationsEnabled }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        onRefresh();
        setLocalAlert({
          type: data.enabled ? 'success' : 'info',
          message: data.message || (data.enabled ? 'Notificările Telegram au fost PORNITE.' : 'Notificările Telegram au fost OPRITE (Mod Noapte/Silențios).'),
        });
      }
    } catch (err: any) {
      setLocalAlert({
        type: 'error',
        message: 'Eroare la comutarea notificărilor Telegram: ' + (err.message || 'Eroare conexiune'),
      });
    }
  };

  const handleLockProfitNow = async () => {
    try {
      const token = localStorage.getItem('tb5_control_token') || 'tradebot5_admin_token';
      const res = await fetch('/api/bot/vault/lock-now', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-bot-token': token },
      });
      const data = await res.json();
      if (res.ok && data.success) {
        onRefresh();
        setLocalAlert({
          type: 'success',
          message: `✅ Depunere manuală confirmată: +$${data.profitLocked.toFixed(2)} USDT transferați în Seif (Total în Seif: $${data.totalVault.toFixed(2)} USDT). Baza curată: $${baseCapital.toFixed(2)} USDT.`,
        });
      } else {
        setLocalAlert({
          type: 'error',
          message: data.error || 'Nu există profit suplimentar de pus în seif.',
        });
      }
    } catch (err: any) {
      setLocalAlert({
        type: 'error',
        message: 'Eroare la depunerea în seif: ' + (err.message || 'Server indisponibil'),
      });
    }
  };

  const handleSetBaseCapital = async (amount: number) => {
    try {
      const token = localStorage.getItem('tb5_control_token') || 'tradebot5_admin_token';
      const res = await fetch('/api/bot/vault/set-base', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-bot-token': token },
        body: JSON.stringify({ amount }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        onRefresh();
        setShowSetBaseModal(false);
        setLocalAlert({
          type: 'success',
          message: `✅ Baza fixă de lucru a fost actualizată la $${amount.toFixed(2)} USDT.`,
        });
      } else {
        setLocalAlert({
          type: 'error',
          message: data.error || 'Eroare la actualizarea bazei fixe.',
        });
      }
    } catch (err: any) {
      setLocalAlert({
        type: 'error',
        message: 'Eroare la setarea bazei de lucru: ' + (err.message || 'Server indisponibil'),
      });
    }
  };

  const handleResetProfitVault = async () => {
    try {
      const token = localStorage.getItem('tb5_control_token') || 'tradebot5_admin_token';
      const res = await fetch('/api/bot/vault/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-bot-token': token },
      });
      const data = await res.json();
      if (res.ok && data.success) {
        onRefresh();
        setShowResetVaultConfirmModal(false);
        setLocalAlert({
          type: 'success',
          message: '✅ Seiful a fost resetat cu succes! Toate profiturile blocate au fost reintroduse în capitalul activ.',
        });
      } else {
        setLocalAlert({
          type: 'error',
          message: data.error || 'Eroare la resetarea seifului.',
        });
      }
    } catch (err: any) {
      setLocalAlert({
        type: 'error',
        message: 'Eroare la resetarea seifului: ' + (err.message || 'Server indisponibil'),
      });
    }
  };

  // Sentiment calculations for display
  const sentimentScore = status?.marketSentimentScore ?? 0;
  const currentSentimentThreshold = profileConfig?.sentimentThreshold ?? 1.5;
  const isBullishSentiment = (status?.marketSentiment?.includes('BULLISH') || sentimentScore >= currentSentimentThreshold);
  const isBearishSentiment = (status?.marketSentiment?.includes('BEARISH') || sentimentScore <= -currentSentimentThreshold);

  const renderOpenPositionsContent = (badgePrefix: string = 'F2') => (
    <div className="bg-zinc-950 border border-amber-500/30 rounded p-2 sm:p-3 flex flex-col flex-1 min-h-0">
      {/* Frozen Header for POS */}
      <div className="sticky top-0 z-10 bg-zinc-950 pb-1 shrink-0">
        <div className="flex flex-wrap items-center justify-between border-b border-amber-500/30 pb-2 mb-3 gap-2">
          <div className="flex items-center space-x-2">
            <Activity className="w-4 h-4 text-amber-500" />
            <span className="font-bold text-xs sm:text-sm tracking-wider text-amber-400">
              {badgePrefix === 'PORT' ? 'OPEN POSITIONS & ACTIVE EXPOSURE' : `${badgePrefix}: OPEN POSITIONS & ACTIVE EXPOSURE`}
            </span>
            <span className="text-[10px] sm:text-xs bg-amber-950 text-amber-300 px-1.5 sm:px-2 py-0.5 rounded border border-amber-500/40 font-mono">
              {positions.length} {positions.length === 1 ? 'POZIȚIE' : 'POZIȚII'}
            </span>
          </div>

          <div className="flex items-center space-x-2 sm:space-x-3 text-[11px] sm:text-xs font-mono">
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
        <div className="bg-black/60 border border-amber-500/20 rounded px-2.5 py-1.5 mb-2 flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono text-zinc-400">
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
      </div>

      {/* Empty state */}
      {positions.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-zinc-500 py-12 sm:py-16 space-y-3">
          <Activity className="w-10 h-10 opacity-30 animate-pulse text-amber-500" />
          <p className="text-xs sm:text-sm font-bold tracking-wider text-zinc-400 text-center">NU EXISTĂ POZIȚII DESCHISE ÎN ACEST MOMENT</p>
          <p className="text-[11px] sm:text-xs text-zinc-600 max-w-md text-center">
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
        <div className="overflow-y-auto flex-1 min-h-0 space-y-2 pr-1">
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
            const trailingActThreshold = profileConfig?.trailingActivationPct ?? 1.1;
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
                        {pos.isFadeTrade && (
                          <span className="px-1.5 py-0.2 text-[9px] font-bold rounded bg-purple-950 text-purple-300 border border-purple-600/60" title="Sub-strategie Fade Climax">
                            FADE
                          </span>
                        )}
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
                      <div className="font-bold text-zinc-300 font-mono">{formatPrice(pos.entryPrice, { prefix: '$' })}</div>
                    </div>

                    <div>
                      <div className="text-[9px] text-zinc-500">PREȚ ACTUAL</div>
                      <div className="font-bold text-white font-mono">{formatPrice(curPrice, { prefix: '$' })}</div>
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
                          <span className="text-zinc-200 font-mono">{formatPrice(pos.entryPrice, { prefix: '$' })}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-zinc-400">Preț Actual:</span>
                          <span className="text-white font-bold font-mono">{formatPrice(curPrice, { prefix: '$' })}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-zinc-400">Diferență Netă:</span>
                          <span className={`font-bold font-mono ${isProfit ? 'text-emerald-400' : 'text-rose-400'}`}>
                            {isProfit ? '+' : ''}{formatPrice(curPrice - pos.entryPrice, { prefix: '$' })} ({isProfit ? '+' : ''}{pos.pnlPct?.toFixed(2)}%)
                          </span>
                        </div>
                        <div className="flex justify-between text-[11px]">
                          <span className="text-zinc-500">Maxim Atins:</span>
                          <span className="text-emerald-400 font-mono">{formatPrice(pos.highestPrice || pos.entryPrice, { prefix: '$' })}</span>
                        </div>
                        <div className="flex justify-between text-[11px]">
                          <span className="text-zinc-500">Minim Atins:</span>
                          <span className="text-rose-400 font-mono">{formatPrice(pos.lowestPrice || pos.entryPrice, { prefix: '$' })}</span>
                        </div>
                        <div className="flex justify-between text-[11px] pt-1 border-t border-zinc-900">
                          <span className="text-zinc-400">MAE (Worst DD):</span>
                          <span className="text-rose-400 font-bold">{pos.maePct !== undefined ? `${pos.maePct}%` : '0.00%'}</span>
                        </div>
                        <div className="flex justify-between text-[11px]">
                          <span className="text-zinc-400">MFE (Peak PnL):</span>
                          <span className="text-emerald-400 font-bold">{pos.mfePct !== undefined ? `+${pos.mfePct}%` : '0.00%'}</span>
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
                          <span className="text-zinc-300 font-mono font-medium">
                            {new Date(pos.entryTime).toLocaleTimeString('ro-RO', { timeZone: 'Europe/Bucharest', hour12: false })}
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-zinc-400">Dată intrare:</span>
                          <span className="text-zinc-400 font-mono">
                            {new Date(pos.entryTime).toLocaleDateString('ro-RO', { timeZone: 'Europe/Bucharest' })}
                          </span>
                        </div>
                        <div className="flex justify-between text-[11px]">
                          <span className="text-zinc-500">Limită Max Hold:</span>
                          <span className="text-amber-400">
                            {profileConfig?.maxHoldingTimeMinutes && profileConfig.maxHoldingTimeMinutes > 0
                              ? `${profileConfig.maxHoldingTimeMinutes}m (${(profileConfig.maxHoldingTimeMinutes - holdingMinutes).toFixed(1)}m rămase)`
                              : '45m unificat'}
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
                          <span className="text-zinc-300">-{profileConfig?.trailingDistancePct ?? 0.35}%</span>
                        </div>
                        <div className="flex justify-between text-[11px]">
                          <span className="text-zinc-500">Break-Even (BE):</span>
                          <span className={isBreakEvenActive ? 'text-blue-400 font-bold' : 'text-zinc-500'}>
                            {isBreakEvenActive ? 'ACTIVAT (SL la intrare)' : `Inactiv (Necesar +${profileConfig?.breakEvenActivationPct ?? 5.0}%)`}
                          </span>
                        </div>
                        <div className="flex justify-between text-[11px]">
                          <span className="text-zinc-500">Hard Stop Loss:</span>
                          <span className="text-rose-400 font-bold font-mono">
                            {pos.stopLossPrice ? `${formatPrice(pos.stopLossPrice, { prefix: '$' })} (-${profileConfig?.hardStopLossPct ?? 20.0}%)` : `-${profileConfig?.hardStopLossPct ?? 20.0}%`}
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
                        <div className="flex justify-between text-[11px]">
                          <span className="text-zinc-500">ID Poziție:</span>
                          <span className="text-zinc-400 font-mono text-[10px]">{pos.id}</span>
                        </div>
                        <div className="flex justify-between text-[11px]">
                          <span className="text-zinc-500">Leverage:</span>
                          <span className="text-amber-400 font-bold">{pos.leverage || '1x'}</span>
                        </div>
                        {pos.signalScore !== undefined && (
                          <div className="flex justify-between text-[11px]">
                            <span className="text-zinc-500">metaScore Intrare:</span>
                            <span className="text-cyan-300 font-bold">{pos.signalScore.toFixed(1)}/100</span>
                          </div>
                        )}
                        <div className="flex justify-between text-[11px]">
                          <span className="text-zinc-500">Regim / Profil:</span>
                          <span className="text-zinc-400">{pos.marketRegime || 'BTC: --'} | {pos.profile}</span>
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
  );

  return (
    <div className={`h-screen h-[100dvh] max-h-[100dvh] w-full bg-black text-amber-500 font-mono flex flex-col overflow-hidden pb-[env(safe-area-inset-bottom)] ${isMonochrome ? 'monochrome' : ''}`}>
      {/* 0. FROZEN TOP DOCK: HEADER + AUTO-TAPE + SHORTCUTS BAR + BANNERS (STICKY TOP DOCK) */}
      <div className="sticky top-0 z-40 bg-black shadow-2xl border-b border-amber-500/40 flex flex-col shrink-0 w-full max-w-full min-w-0">
        {/* 1. UNIFIED TERMINAL HEADER (~40px, NEUTRAL ZINC-950 WITH AMBER ACCENTS) */}
        <header className="bg-zinc-950 text-zinc-100 border-b border-amber-500/30 px-2 sm:px-3 py-1.5 flex items-center justify-between text-xs font-mono shrink-0 shadow-lg gap-2 w-full max-w-full min-w-0 select-none">
          {/* LEFT: BRAND & MODE */}
          <div className="flex items-center space-x-1.5 sm:space-x-2 shrink-0">
            <span className="bg-amber-500/10 text-amber-400 px-1.5 py-0.5 rounded text-xs tracking-wider font-black border border-amber-500/40 shrink-0">
              TB5
            </span>

            {/* INTERACTIVE MODE SWITCHER BADGE */}
            <button
              onClick={() => setShowOKXModal(true)}
              className={`px-2 py-0.5 rounded text-[11px] sm:text-xs font-bold border flex items-center space-x-1 transition-all shadow-sm shrink-0 cursor-pointer ${
                status?.executionMode === 'LIVE'
                  ? 'bg-rose-950/80 text-rose-300 border-rose-500 hover:bg-rose-900 animate-pulse'
                  : status?.executionMode === 'TESTNET'
                  ? 'bg-amber-950/80 text-amber-300 border-amber-500 hover:bg-amber-900'
                  : 'bg-emerald-950/80 text-emerald-300 border-emerald-500 hover:bg-emerald-900'
              }`}
              title="Comută modul de execuție (PAPER / TESTNET / LIVE) sau configurează cheile OKX"
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  status?.executionMode === 'LIVE'
                    ? 'bg-rose-400 animate-ping'
                    : status?.executionMode === 'TESTNET'
                    ? 'bg-amber-400'
                    : 'bg-emerald-400'
                }`}
              />
              <span>
                {status?.executionMode === 'LIVE'
                  ? 'LIVE'
                  : status?.executionMode === 'TESTNET'
                  ? 'DEMO'
                  : 'PAPER'}
              </span>
              <span className="text-[9px] opacity-70">▾</span>
            </button>
          </div>

          {/* CENTER: ESSENTIAL ACCOUNT METRICS (EQ, PNL, POS) */}
          <div className="flex items-center space-x-1.5 sm:space-x-2.5 shrink-0 bg-black/60 px-2 sm:px-3 py-0.5 rounded border border-zinc-800">
            {isExpOn ? (
              <span className="text-cyan-300 text-xs sm:text-sm font-bold flex items-center gap-1">
                <span>🔬 EQ:</span>
                <span className="text-cyan-300">
                  ${currentEquity.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </span>
            ) : (
              <span className="text-emerald-400 text-xs sm:text-sm font-bold">
                EQ: ${status?.equity !== undefined ? status.equity.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '200.00'}
              </span>
            )}
            <span className="text-zinc-600">|</span>
            <span className={`text-xs sm:text-sm font-bold ${totalPnL >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
              PNL: {totalPnL >= 0 ? '+' : ''}${totalPnL.toFixed(2)}
            </span>
            <span className="text-zinc-600">|</span>
            <span className="text-zinc-300 text-xs font-medium">
              POS: <strong className="text-amber-400">{positions.length}</strong>
            </span>
            {isVaultActive && (
              <>
                <span className="text-zinc-600 hidden sm:inline">|</span>
                <span className="text-cyan-400 text-xs font-bold hidden sm:flex items-center gap-1" title="Profit acumulat în seif">
                  <span>🏦</span>
                  <span>${profitVault.toFixed(2)}</span>
                </span>
              </>
            )}
          </div>

          {/* RIGHT: PROFILE, ALWAYS-VISIBLE KILL SWITCH & COMPACT TOOLS MENU */}
          <div className="flex items-center space-x-1.5 sm:space-x-2 shrink-0 relative">
            {/* Profile Switcher */}
            <div className="flex bg-black/80 rounded border border-zinc-800 p-0.5 shrink-0">
              <button
                onClick={() => onSwitchProfile('SCALP')}
                className={`px-1.5 sm:px-2 py-0.5 rounded text-[10px] sm:text-[11px] font-bold cursor-pointer transition-colors ${
                  activeProfile === 'SCALP' ? 'bg-amber-500 text-black' : 'text-zinc-400 hover:text-amber-400'
                }`}
              >
                SCALP
              </button>
              <button
                onClick={() => onSwitchProfile('MOMENTUM')}
                className={`px-1.5 sm:px-2 py-0.5 rounded text-[10px] sm:text-[11px] font-bold cursor-pointer transition-colors ${
                  activeProfile === 'MOMENTUM' ? 'bg-amber-500 text-black' : 'text-zinc-400 hover:text-amber-400'
                }`}
              >
                MOMENTUM
              </button>
            </div>

            {/* KILL SWITCH - ALWAYS VISIBLE, NEVER HIDDEN IN SCROLL */}
            <button
              onClick={onToggleKillSwitch}
              className={`px-2 sm:px-3 py-1 rounded font-bold text-[11px] sm:text-xs border transition-all flex items-center space-x-1 shrink-0 cursor-pointer shadow-sm ${
                isKillSwitch
                  ? 'bg-rose-600 text-white border-rose-400 animate-pulse shadow-[0_0_12px_rgba(225,29,72,0.6)]'
                  : 'bg-zinc-900/90 text-rose-400 border-rose-500/50 hover:bg-rose-950/80 hover:text-rose-300'
              }`}
              title={isKillSwitch ? 'Dezactivează Kill Switch' : 'Oprește imediat tranzacționarea și noile ordine'}
            >
              <ShieldAlert className="w-3.5 h-3.5" />
              <span>{isKillSwitch ? 'KILL ENGAGED' : 'KILL SWITCH'}</span>
            </button>

            {/* COMPACT TOOLS DROPDOWN MENU */}
            <div className="relative" ref={toolsMenuRef}>
              <button
                onClick={() => setShowToolsMenu(!showToolsMenu)}
                className={`px-2 py-1 rounded text-xs font-bold border transition-colors flex items-center space-x-1 cursor-pointer ${
                  showToolsMenu
                    ? 'bg-amber-500 text-black border-amber-400'
                    : 'bg-zinc-900 text-zinc-300 border-zinc-700 hover:text-amber-400 hover:border-amber-500/50'
                }`}
                title="Meniu Utilități & Integrări (OKX, TG, FADE, VAULT, AUTH, MONO, SYNC, LIMBĂ)"
              >
                <MoreHorizontal className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">UTIL</span>
              </button>

              {/* DROPDOWN POPOVER */}
              {showToolsMenu && (
                <div className="absolute right-0 top-full mt-1.5 w-64 bg-zinc-950 border border-amber-500/50 rounded shadow-2xl py-2 px-2 z-50 text-xs flex flex-col space-y-1.5 backdrop-blur-md">
                  <div className="text-[10px] uppercase font-bold text-zinc-500 px-2 pb-1 border-b border-zinc-800 flex justify-between">
                    <span>PANOU INSTRUMENTE</span>
                    <span className="text-amber-400">TB5</span>
                  </div>

                  {/* Integrations */}
                  <button
                    onClick={() => {
                      setShowOKXModal(true);
                      setShowToolsMenu(false);
                    }}
                    className="flex items-center justify-between px-2 py-1.5 rounded hover:bg-zinc-900 text-zinc-300 hover:text-amber-300 cursor-pointer"
                  >
                    <span className="flex items-center space-x-2">
                      <Key className="w-3.5 h-3.5 text-amber-400" />
                      <span>Conexiune OKX</span>
                    </span>
                    <span className={`w-2 h-2 rounded-full ${status?.config?.okxApiKey ? 'bg-emerald-400' : 'bg-zinc-600'}`} />
                  </button>

                  <button
                    onClick={async () => {
                      if (!isTelegramConfigured) {
                        setActiveScreen('SET');
                        setShowToolsMenu(false);
                        return;
                      }
                      await handleToggleTelegramNotifications();
                    }}
                    className="flex items-center justify-between px-2 py-1.5 rounded hover:bg-zinc-900 text-zinc-300 hover:text-amber-300 cursor-pointer"
                  >
                    <span className="flex items-center space-x-2">
                      {isTelegramNotificationsEnabled ? <Bell className="w-3.5 h-3.5 text-sky-400" /> : <BellOff className="w-3.5 h-3.5 text-rose-400" />}
                      <span>Telegram Alerte</span>
                    </span>
                    <span className={`text-[10px] font-bold px-1.5 py-0.2 rounded ${!isTelegramNotificationsEnabled ? 'bg-rose-950 text-rose-300' : 'bg-sky-950 text-sky-300'}`}>
                      {isTelegramNotificationsEnabled ? 'ACTIV' : 'MUTE'}
                    </span>
                  </button>

                  {/* Fade & Vault */}
                  <button
                    onClick={() => {
                      handleToggleInvertSignals();
                    }}
                    className="flex items-center justify-between px-2 py-1.5 rounded hover:bg-zinc-900 text-zinc-300 hover:text-amber-300 cursor-pointer"
                  >
                    <span className="flex items-center space-x-2">
                      <span>🧪</span>
                      <span>Fade Climax</span>
                    </span>
                    <span className={`text-[10px] font-bold px-1.5 py-0.2 rounded ${status?.config?.invertSignals ? 'bg-purple-950 text-purple-300' : 'bg-zinc-800 text-zinc-400'}`}>
                      {status?.config?.invertSignals ? 'ON' : 'OFF'}
                    </span>
                  </button>

                  <button
                    onClick={() => {
                      handleToggleProfitVault();
                    }}
                    className="flex items-center justify-between px-2 py-1.5 rounded hover:bg-zinc-900 text-zinc-300 hover:text-amber-300 cursor-pointer"
                  >
                    <span className="flex items-center space-x-2">
                      <span>🏦</span>
                      <span>Profit Vault</span>
                    </span>
                    <span className={`text-[10px] font-bold px-1.5 py-0.2 rounded ${isVaultActive ? 'bg-cyan-950 text-cyan-300' : 'bg-zinc-800 text-zinc-400'}`}>
                      {isVaultActive ? 'ON' : 'OFF'}
                    </span>
                  </button>

                  <div className="border-t border-zinc-800 my-1" />

                  {/* Utilities */}
                  <button
                    onClick={() => {
                      setShowTokenModal(true);
                      setShowToolsMenu(false);
                    }}
                    className="flex items-center justify-between px-2 py-1.5 rounded hover:bg-zinc-900 text-zinc-300 hover:text-amber-300 cursor-pointer"
                  >
                    <span className="flex items-center space-x-2">
                      <Lock className="w-3.5 h-3.5 text-zinc-400" />
                      <span>Bot Control Token (AUTH)</span>
                    </span>
                  </button>

                  <button
                    onClick={() => {
                      setIsMonochrome(!isMonochrome);
                      setShowToolsMenu(false);
                    }}
                    className="flex items-center justify-between px-2 py-1.5 rounded hover:bg-zinc-900 text-zinc-300 hover:text-amber-300 cursor-pointer"
                  >
                    <span className="flex items-center space-x-2">
                      <span>🎨</span>
                      <span>Mod Monocrom</span>
                    </span>
                    <span className="text-[10px] text-zinc-400">{isMonochrome ? 'ACTIV' : 'INACTIV'}</span>
                  </button>

                  <button
                    onClick={() => {
                      onRefresh();
                      setShowToolsMenu(false);
                    }}
                    className="flex items-center justify-between px-2 py-1.5 rounded hover:bg-zinc-900 text-zinc-300 hover:text-amber-300 cursor-pointer"
                  >
                    <span className="flex items-center space-x-2">
                      <RefreshCw className="w-3.5 h-3.5 text-amber-400" />
                      <span>Sincronizare Forțată (SYNC)</span>
                    </span>
                  </button>

                  <button
                    onClick={() => {
                      setShowManualModal(true);
                      setShowToolsMenu(false);
                    }}
                    className="flex items-center justify-between px-2 py-1.5 rounded hover:bg-zinc-900 text-amber-300 cursor-pointer"
                  >
                    <span className="flex items-center space-x-2">
                      <BookOpen className="w-3.5 h-3.5 text-amber-400" />
                      <span>Manual Utilizare (PDF)</span>
                    </span>
                  </button>

                  <div className="border-t border-zinc-800 pt-1 flex items-center justify-between px-2">
                    <span className="text-zinc-500 text-[10px]">LIMBĂ INTERFAȚĂ:</span>
                    <div className="flex bg-zinc-900 rounded border border-zinc-800 p-0.5">
                      <button
                        onClick={() => setLang('EN')}
                        className={`px-1.5 py-0.2 rounded text-[10px] font-bold ${lang === 'EN' ? 'bg-amber-500 text-black' : 'text-zinc-400'}`}
                      >
                        EN
                      </button>
                      <button
                        onClick={() => setLang('RO')}
                        className={`px-1.5 py-0.2 rounded text-[10px] font-bold ${lang === 'RO' ? 'bg-amber-500 text-black' : 'text-zinc-400'}`}
                      >
                        RO
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </header>

        {/* UNIFIED ACTIVE PROTOCOLS RIBBON (STRICT SINGLE LINE ON MOBILE & DESKTOP - ONLY SHOWN CONDITIONALLY WHEN PROTOCOLS ARE ACTIVE) */}
        {(status?.isExperimentActive || experimentState?.isActive || status?.config?.invertSignals || isVaultActive || !isTelegramNotificationsEnabled || (status?.equityTrailingState?.triggerCount ?? 0) > 0) && (
          <div className="w-full max-w-full min-w-0 bg-zinc-950/95 border-b border-amber-500/30 px-2 sm:px-3 py-1 text-[9px] sm:text-[11px] font-mono flex flex-row flex-nowrap items-center justify-between gap-1.5 sm:gap-2 shrink-0 z-20 shadow-md overflow-x-auto terminal-scrollbar-x whitespace-nowrap select-none">
            <div className="flex flex-row flex-nowrap items-center space-x-1 sm:space-x-1.5 shrink min-w-0">
              {/* Experiment Active Pill */}
              {(status?.isExperimentActive || experimentState?.isActive) && (
                <div className="flex flex-row flex-nowrap items-center space-x-1 bg-cyan-950 border border-cyan-400/80 px-2 py-0.5 rounded text-cyan-200 shrink-0 shadow-[0_0_12px_rgba(6,182,212,0.35)]">
                  <span className="w-2 h-2 rounded-full bg-cyan-400 animate-ping shrink-0" />
                  <span className="font-bold text-[9px] sm:text-[10px] text-cyan-300">EXP {effectiveExpHours}H ACTIV:</span>
                  <span className="font-bold text-[9px] sm:text-[10px] text-white">${currentEquity.toFixed(2)} USDT</span>
                  <span className="text-[9px] sm:text-[10px] text-cyan-300 hidden sm:inline">| Scalp Momentum &gt;= {effectiveExpMinMom} | Max 50 Poziții</span>
                </div>
              )}

              {/* Telegram Muted Status Pill */}
              {!isTelegramNotificationsEnabled && (
                <div className="flex flex-row flex-nowrap items-center space-x-1 bg-rose-950/80 border border-rose-500/50 px-1.5 py-0.5 rounded text-rose-200 shrink-0">
                  <BellOff className="w-3 h-3 text-rose-400 shrink-0" />
                  <span className="font-bold text-[9px] sm:text-[10px] text-rose-300">TG: MUTE</span>
                  <span className="text-[9px] sm:text-[10px] hidden sm:inline">(Alerte oprite)</span>
                  <button
                    onClick={handleToggleTelegramNotifications}
                    className="ml-0.5 text-[9px] text-rose-300 hover:text-white underline cursor-pointer font-bold"
                    title="Pornește alertele Telegram"
                  >
                    [ACTIVEAZĂ]
                  </button>
                </div>
              )}

              {/* Fade Status Pill */}
              {status?.config?.invertSignals && (
                <div className="flex flex-row flex-nowrap items-center space-x-1 bg-purple-950/80 border border-purple-500/50 px-1.5 py-0.5 rounded text-purple-200 shrink-0">
                  <span className="w-1.5 h-1.5 rounded-full bg-purple-400 animate-pulse shrink-0" />
                  <span className="font-bold text-[9px] sm:text-[10px] text-purple-300">FADE:</span>
                  <span className="text-[9px] sm:text-[10px]">
                    <span className="hidden sm:inline">Semnale Climax Inversate</span>
                    <span className="sm:hidden">Fade Inv</span>
                  </span>
                  <button
                    onClick={handleToggleInvertSignals}
                    className="ml-0.5 text-[9px] text-purple-400 hover:text-white underline cursor-pointer"
                    title="Dezactivează Fade Climax"
                  >
                    [✕]
                  </button>
                </div>
              )}

              {/* Profit Vault Status Pill */}
              {isVaultActive && (
                <div className="flex flex-row flex-nowrap items-center space-x-1 bg-cyan-950/80 border border-cyan-500/50 px-1.5 py-0.5 rounded text-cyan-200 shrink-0">
                  <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse shrink-0" />
                  <span className="font-bold text-[9px] sm:text-[10px] text-cyan-300 shrink-0">VAULT:</span>
                  <span className="text-[9px] sm:text-[10px]">
                    <span className="hidden sm:inline">Bază: <strong>${baseCapital.toFixed(2)}</strong> | În seif: <strong className="text-cyan-300">+${profitVault.toFixed(2)}</strong> | Op: <strong>${operatingEquity.toFixed(2)}</strong></span>
                    <span className="sm:hidden">Seif: <strong className="text-cyan-300">+${profitVault.toFixed(0)}</strong> (Bază: ${baseCapital.toFixed(0)})</span>
                  </span>
                </div>
              )}

              {/* Equity Trailing Protection Triggers Badge - Only shown when triggerCount > 0 */}
              {(status?.equityTrailingState?.triggerCount ?? 0) > 0 && (
                <div className="flex flex-row flex-nowrap items-center space-x-1 bg-amber-950/70 border border-amber-500/50 px-1.5 py-0.5 rounded text-amber-200 shrink-0">
                  <ShieldAlert className="w-3 h-3 text-amber-400 shrink-0" />
                  <span className="font-bold text-[9px] sm:text-[10px] text-amber-300">EQ PROT:</span>
                  <span className="text-[9px] sm:text-[10px] font-mono font-bold text-cyan-300">
                    {status?.equityTrailingState?.triggerCount} {(status?.equityTrailingState?.triggerCount === 1) ? 'declanșare' : 'declanșări'}
                  </span>
                  <button
                    type="button"
                    onClick={() => setShowEquityProtectionModal(true)}
                    className="ml-0.5 text-[9px] sm:text-[10px] text-amber-300 hover:text-white underline cursor-pointer font-bold shrink-0"
                    title="Deschide jurnalul detaliat cu toate declanșările protecției"
                  >
                    [LOG]
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

      {/* 2. REAL-TIME TICKER TAPE */}
      <div className="bg-zinc-950 border-b border-amber-500/30 px-3 py-1 text-[11px] flex items-center shrink-0 overflow-hidden relative w-full max-w-full min-w-0">
        {/* Antet fix pe stânga */}
        <div className="flex items-center space-x-1.5 text-amber-400 font-bold shrink-0 z-20 bg-zinc-950 pr-3 border-r border-amber-500/30 shadow-[4px_0_10px_rgba(0,0,0,0.9)]">
          <Activity className="w-3.5 h-3.5 animate-pulse text-amber-500" />
          <span className="tracking-wider">AUTO-TAPE &gt;&gt;</span>
        </div>

        {/* Bandă date derulată fluid fără blocaje */}
        <div
          ref={tickerRef}
          className="flex-1 overflow-x-hidden whitespace-nowrap pl-3 select-none scrollbar-none flex items-center"
          title="Trecerea cursorului peste bandă o pune pe pauză temporar"
        >
          {extendedTapeItems.length === 0 ? (
            <div className="text-zinc-600 text-xs py-1">Se așteaptă date din piață...</div>
          ) : (
            <div className="flex items-center shrink-0">
              {/* Track 1 */}
              <div ref={autoTapeTrackRef} className="inline-flex items-center space-x-6 pr-6 shrink-0">
                {extendedTapeItems.map((item, idx) => (
                  <div key={`auto_1_${item.id}_${idx}`} className="flex items-center space-x-2 bg-zinc-900/80 px-2 py-0.5 rounded border border-amber-500/20 shrink-0">
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
              {/* Track 2 - Clonă exactă identică pentru buclă infinită perfectă fără salt */}
              <div className="inline-flex items-center space-x-6 pr-6 shrink-0">
                {extendedTapeItems.map((item, idx) => (
                  <div key={`auto_2_${item.id}_${idx}`} className="flex items-center space-x-2 bg-zinc-900/80 px-2 py-0.5 rounded border border-amber-500/20 shrink-0">
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
          )}
        </div>
      </div>

      {/* 3. FUNCTION KEY SHORTCUTS BAR (SCROLLABLE & DRAGGABLE IN COMPACT/MOBILE VIEW, CLEAN SINGLE BAR ON DESKTOP) */}
      <div className="relative w-full max-w-full min-w-0 bg-zinc-900 border-b border-amber-500/30 flex items-center group select-none">
        {/* Left Scroll Chevron (shows when scrolled right) */}
        {canScrollLeft && (
          <button
            type="button"
            onClick={() => scrollShortcuts('left')}
            className="absolute left-0 z-30 h-full px-1.5 bg-zinc-950/95 hover:bg-black text-amber-400 border-r border-amber-500/50 flex items-center justify-center shadow-lg transition-all"
            title="Derulează spre stânga"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
        )}

        {/* Scrollable Container with MouseWheel, Touch, Mouse Drag */}
        <div
          ref={shortcutsRef}
          onWheel={handleShortcutsWheel}
          onMouseDown={handleShortcutsMouseDown}
          onMouseMove={handleShortcutsMouseMove}
          onMouseUp={handleShortcutsMouseUp}
          onMouseLeave={handleShortcutsMouseUp}
          className="w-full max-w-full min-w-0 overflow-x-auto terminal-scrollbar-x py-1 px-2 sm:px-3 flex items-center justify-between text-xs whitespace-nowrap gap-1 lg:gap-2 cursor-grab active:cursor-grabbing lg:cursor-default"
          style={{ WebkitOverflowScrolling: 'touch' }}
        >
          <div className="flex items-center space-x-1 sm:space-x-1.5 shrink-0">
            <button
              onClick={() => setActiveScreen('PORT')}
              className={`px-2 sm:px-3 py-0.5 sm:py-1 rounded font-bold text-[11px] sm:text-xs transition-colors flex items-center space-x-1 sm:space-x-1.5 shrink-0 ${
                activeScreen === 'PORT' ? 'bg-amber-500 text-black shadow-lg shadow-amber-500/20' : 'bg-black text-amber-500 hover:bg-zinc-800 border border-amber-500/40'
              }`}
            >
              <span>[1:PORT]</span>
              <span className="hidden sm:inline">Portfolio &amp; Risk</span>
            </button>

            <button
              onClick={() => setActiveScreen('POS')}
              className={`px-2 sm:px-3 py-0.5 sm:py-1 rounded font-bold text-[11px] sm:text-xs transition-colors flex items-center space-x-1 sm:space-x-1.5 shrink-0 ${
                activeScreen === 'POS' || activeScreen === 'TAPE' ? 'bg-amber-500 text-black shadow-lg shadow-amber-500/20' : 'bg-black text-amber-500 hover:bg-zinc-800 border border-amber-500/40'
              }`}
            >
              <span>[2:POS]</span>
              <span className="hidden sm:inline">Open Positions ({positions.length})</span>
            </button>

            <button
              onClick={() => setActiveScreen('SCAN')}
              className={`px-2 sm:px-3 py-0.5 sm:py-1 rounded font-bold text-[11px] sm:text-xs transition-colors flex items-center space-x-1 sm:space-x-1.5 shrink-0 ${
                activeScreen === 'SCAN' ? 'bg-amber-500 text-black shadow-lg shadow-amber-500/20' : 'bg-black text-amber-500 hover:bg-zinc-800 border border-amber-500/40'
              }`}
            >
              <span>[3:SCAN]</span>
              <span className="hidden sm:inline">Universe Scanner</span>
            </button>

            <button
              onClick={() => setActiveScreen('SYM')}
              className={`px-2 sm:px-3 py-0.5 sm:py-1 rounded font-bold text-[11px] sm:text-xs transition-colors flex items-center space-x-1 sm:space-x-1.5 shrink-0 ${
                activeScreen === 'SYM' ? 'bg-amber-500 text-black shadow-lg shadow-amber-500/20' : 'bg-black text-amber-500 hover:bg-zinc-800 border border-amber-500/40'
              }`}
              title="Analiză rolling pe simbol: Hit-rate MFE ≥ 1.5%, winrate și feedback multiplier"
            >
              <span>[SYM]</span>
              <span className="hidden sm:inline">Analiză Simbol (MFE)</span>
            </button>

            <button
              onClick={() => setActiveScreen('EXP')}
              className={`px-2 sm:px-3 py-0.5 sm:py-1 rounded font-bold text-[11px] sm:text-xs transition-colors flex items-center space-x-1 sm:space-x-1.5 shrink-0 ${
                activeScreen === 'EXP' ? 'bg-cyan-400 text-black shadow-lg shadow-cyan-400/30' : 'bg-black text-cyan-400 hover:bg-zinc-800 border border-cyan-500/50'
              }`}
              title={`Experiment Scalp, Momentum >= ${expMinMomentum}, Balanță $10,000 & Max 50 Poziții`}
            >
              <Activity className="w-3.5 h-3.5 text-cyan-400 animate-pulse" />
              <span>[🔬 EXP]</span>
            </button>

            <button
              onClick={() => setActiveScreen('BLOT')}
              className={`px-2 sm:px-3 py-0.5 sm:py-1 rounded font-bold text-[11px] sm:text-xs transition-colors flex items-center space-x-1 sm:space-x-1.5 shrink-0 ${
                activeScreen === 'BLOT' ? 'bg-amber-500 text-black shadow-lg shadow-amber-500/20' : 'bg-black text-amber-500 hover:bg-zinc-800 border border-amber-500/40'
              }`}
            >
              <span>[4:BLOT]</span>
              <span className="hidden sm:inline">Orders &amp; Audit</span>
            </button>

            <button
              onClick={() => setActiveScreen('SET')}
              className={`px-2 sm:px-3 py-0.5 sm:py-1 rounded font-bold text-[11px] sm:text-xs transition-colors flex items-center space-x-1 sm:space-x-1.5 shrink-0 ${
                activeScreen === 'SET' ? 'bg-amber-500 text-black shadow-lg shadow-amber-500/20' : 'bg-black text-amber-500 hover:bg-zinc-800 border border-amber-500/40'
              }`}
            >
              <span>[5:SET]</span>
              <span className="hidden sm:inline">Parameters</span>
            </button>

            <button
              onClick={() => setActiveScreen('INFO')}
              className={`px-2 sm:px-3 py-0.5 sm:py-1 rounded font-bold text-[11px] sm:text-xs transition-colors flex items-center space-x-1 sm:space-x-1.5 shrink-0 ${
                activeScreen === 'INFO' ? 'bg-amber-500 text-black shadow-lg shadow-amber-500/20' : 'bg-black text-amber-500 hover:bg-zinc-800 border border-amber-500/40'
              }`}
            >
              <span>[6:INFO]</span>
              <span className="hidden sm:inline">{lang === 'EN' ? 'App Info & Build' : 'Info & Executabil'}</span>
            </button>

            <button
              type="button"
              onClick={() => setShowManualModal(true)}
              className="px-2 sm:px-2.5 py-0.5 sm:py-1 rounded font-bold text-[11px] sm:text-xs transition-all flex items-center space-x-1 sm:space-x-1.5 shrink-0 bg-amber-500/15 hover:bg-amber-500/30 text-amber-300 border border-amber-500/50 hover:shadow-[0_0_10px_rgba(245,158,11,0.3)] cursor-pointer"
              title="Deschide și descarcă Manualul complet de utilizare în format PDF"
            >
              <BookOpen className="w-3.5 h-3.5 text-amber-400" />
              <span>[📖 MANUAL PDF]</span>
            </button>

            {/* MOBILE ONLY: CHART BUTTON */}
            <button
              onClick={() => setActiveScreen('CHART')}
              className={`lg:hidden px-2 sm:px-3 py-0.5 sm:py-1 rounded font-bold text-[11px] sm:text-xs transition-colors flex items-center space-x-1 sm:space-x-1.5 shrink-0 ${
                activeScreen === 'CHART' ? 'bg-amber-500 text-black shadow-lg shadow-amber-500/20' : 'bg-black text-amber-500 hover:bg-zinc-800 border border-amber-500/40'
              }`}
              title="Afișează graficul TradingView pe ecran complet"
            >
              <span>[7:CHART]</span>
              <span className="hidden sm:inline">TradingView</span>
            </button>
          </div>
        </div>

        {/* Right Scroll Chevron (shows when more content to the right) */}
        {canScrollRight && (
          <button
            type="button"
            onClick={() => scrollShortcuts('right')}
            className="absolute right-0 z-30 h-full px-1.5 bg-zinc-950/95 hover:bg-black text-amber-400 border-l border-amber-500/50 flex items-center justify-center shadow-lg transition-all"
            title="Derulează spre dreapta"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* TELEGRAM STATUS MESSAGE BANNER */}
      {telegramStatusMsg && (
        <div className="px-4 py-2 text-xs flex items-center justify-between border-b bg-sky-950/90 text-sky-200 border-sky-700 font-mono">
          <div className="flex items-center space-x-2">
            <Send className="w-4 h-4 text-sky-400 shrink-0" />
            <span>{telegramStatusMsg}</span>
          </div>
          <button onClick={() => setTelegramStatusMsg(null)} className="text-sky-400 hover:text-white text-[10px]">✕</button>
        </div>
      )}

      {/* ALERTS NOTIFICATION BANNER (AUTO-DISMISS IN 10S) */}
      {(errorMessage || successMessage || localAlert) && (
        <div className={`relative px-4 py-2 text-xs flex items-center justify-between border-b shadow-md transition-all overflow-hidden ${
          (errorMessage || localAlert?.type === 'error') 
            ? 'bg-rose-950/90 text-rose-300 border-rose-800' 
            : localAlert?.type === 'info'
            ? 'bg-sky-950/90 text-sky-300 border-sky-800'
            : 'bg-emerald-950/90 text-emerald-300 border-emerald-800'
        }`}>
          <div className="flex items-center space-x-2 min-w-0 z-10">
            {(errorMessage || localAlert?.type === 'error') ? (
              <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
            ) : (
              <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
            )}
            <span className="font-semibold truncate">{errorMessage || successMessage || localAlert?.message}</span>
            <span className="text-[10px] text-zinc-400 opacity-80 shrink-0 hidden sm:inline">(dispare în 10s)</span>
          </div>
          <button
            onClick={() => {
              if (onDismissAlert) onDismissAlert();
              setLocalAlert(null);
            }}
            className="text-zinc-300 hover:text-white hover:bg-black/40 px-2 py-0.5 rounded text-xs ml-2 cursor-pointer transition-colors shrink-0 z-10 font-bold"
            title="Închide acum"
          >
            ✕
          </button>
          {/* Animated 10s shrinking progress indicator */}
          <div className={`absolute bottom-0 left-0 h-0.5 w-full ${(errorMessage || localAlert?.type === 'error') ? 'bg-rose-500' : 'bg-emerald-400'} animate-shrink-10s`} />
        </div>
      )}
      </div>

      {/* 4. MAIN TERMINAL WORKSPACE (100% NO SCROLL IN FULLSCREEN) */}
      <main className="flex-1 min-h-0 p-1 sm:p-2 bg-black flex flex-col gap-1 sm:gap-2 overflow-hidden">
        {/* UPPER ROW: LEFT ACTIVE SCREEN + RIGHT TRADINGVIEW CHART */}
        <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-12 gap-2">
          {/* LEFT / CENTER MODULE CONTENT (12 Cols on Mobile, 6 Cols on LG, or 12 Cols if SYM / EXP) */}
          <div className={`${
            activeScreen === 'CHART'
              ? 'hidden lg:flex lg:col-span-6'
              : activeScreen === 'SYM' || activeScreen === 'EXP'
              ? 'col-span-12 flex'
              : 'col-span-12 lg:col-span-6 flex'
          } flex-col min-h-0 overflow-y-auto pr-0.5 space-y-2`}>
            {activeScreen === 'PORT' && (
              <div className="bg-zinc-950 border border-amber-500/30 rounded p-2.5 flex flex-col min-h-0">
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

              {/* EXPERIMENT BANNER */}
              {(status?.isExperimentActive || experimentState?.isActive) && (
                <div className="bg-cyan-950/80 border border-cyan-400/80 rounded p-2.5 mb-2.5 flex items-center justify-between shadow-[0_0_15px_rgba(6,182,212,0.25)] text-xs font-mono">
                  <div className="flex items-center space-x-2">
                    <span className="w-2.5 h-2.5 rounded-full bg-cyan-400 animate-ping shrink-0" />
                    <div>
                      <span className="font-bold text-white tracking-wide">🔬 EXPERIMENT {effectiveExpHours}H ACTIV: BALANȚĂ $10,000 (MAX 50 POZIȚII)</span>
                      <p className="text-[11px] text-cyan-300">
                        Rulează cu profil SCALP pe fond simulat de $10,000 USDT ($50/trade). Execută automat oportunitățile cu scor Momentum &gt;= {effectiveExpMinMom}.
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={() => setActiveScreen('EXP')}
                    className="px-2.5 py-1 bg-cyan-500 hover:bg-cyan-400 text-black font-bold rounded text-[11px] shrink-0 cursor-pointer"
                  >
                    Panou Experiment
                  </button>
                </div>
              )}

              {/* TRADEBOT 4 ACCOUNTING METRICS (DYNAMIC LANG) */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-2">
                {/* 1. FREE BALANCE */}
                <div className={`bg-black border p-2 sm:p-2.5 rounded flex flex-col justify-between min-w-0 ${
                  (status?.isExperimentActive || experimentState?.isActive)
                    ? 'border-cyan-400/70 shadow-[0_0_12px_rgba(6,182,212,0.2)]'
                    : 'border-zinc-800'
                }`}>
                  <div className="flex items-center justify-between mb-0.5 sm:mb-1 gap-1">
                    <div className="text-slate-400 text-[9px] sm:text-xs font-bold tracking-wider truncate">
                      <span className="hidden sm:inline">{lang === 'EN' ? 'FREE BALANCE' : 'SOLD DISPONIBIL'}</span>
                      <span className="sm:hidden">{lang === 'EN' ? 'FREE BAL' : 'SOLD LIBER'}</span>
                    </div>
                    {(status?.isExperimentActive || experimentState?.isActive) ? (
                      <span className="text-[8px] sm:text-[9px] bg-cyan-950 text-cyan-300 border border-cyan-500/50 px-1 rounded font-bold uppercase shrink-0">
                        EXP (MAX 50)
                      </span>
                    ) : profitVault > 0 && (
                      <span className="text-[8px] sm:text-[9px] text-cyan-400 font-mono shrink-0" title="Profit rezervat în seif">
                        (${profitVault.toFixed(0)} seif)
                      </span>
                    )}
                  </div>
                  <div className={`text-sm sm:text-xl font-bold font-mono truncate ${
                    (status?.isExperimentActive || experimentState?.isActive) ? 'text-cyan-300' : 'text-amber-400'
                  }`}>
                    ${(isVaultActive ? usableFreeBalance : freeBalance).toFixed(2)}
                  </div>
                </div>

                {/* 2. MARGIN (INVESTED) */}
                <div className="bg-black border border-zinc-800 p-2 sm:p-2.5 rounded flex flex-col justify-between min-w-0">
                  <div className="text-slate-400 text-[9px] sm:text-xs font-bold tracking-wider mb-0.5 sm:mb-1 truncate">
                    <span className="hidden sm:inline">{lang === 'EN' ? 'MARGIN (INVESTED)' : 'MARJĂ INVESTITĂ'}</span>
                    <span className="sm:hidden">{lang === 'EN' ? 'MARGIN' : 'MARJĂ'}</span>
                  </div>
                  <div className="text-sm sm:text-xl font-bold font-mono text-amber-400 truncate">
                    ${marginInvested.toFixed(2)}
                  </div>
                </div>

                {/* 3. TOTAL EQUITY */}
                <div className={`bg-black border p-2 sm:p-2.5 rounded flex flex-col justify-between min-w-0 ${
                  (status?.isExperimentActive || experimentState?.isActive)
                    ? 'border-cyan-400/70 shadow-[0_0_12px_rgba(6,182,212,0.2)]'
                    : 'border-emerald-500/50 shadow-[0_0_12px_rgba(16,185,129,0.12)]'
                }`}>
                  <div className="text-emerald-400 text-[9px] sm:text-xs font-bold tracking-wider mb-0.5 sm:mb-1 truncate">
                    <span className="hidden sm:inline">{lang === 'EN' ? 'TOTAL EQUITY' : 'VALOARE TOTALĂ (EQUITY)'}</span>
                    <span className="sm:hidden">{lang === 'EN' ? 'EQUITY' : 'TOTAL EQUITY'}</span>
                  </div>
                  <div className={`text-sm sm:text-xl font-bold font-mono truncate ${
                    (status?.isExperimentActive || experimentState?.isActive) ? 'text-cyan-300' : 'text-emerald-400'
                  }`}>
                    ${currentEquity.toFixed(2)}
                  </div>
                </div>

                {/* 4. PROFIT VAULT (SEIF PROTEJAT) */}
                <div className={`border p-2 sm:p-2.5 rounded transition-all flex flex-col justify-between min-w-0 ${
                  isVaultActive && profitVault > 0
                    ? 'bg-cyan-950/40 border-cyan-500/60 shadow-[0_0_12px_rgba(6,182,212,0.2)]'
                    : isVaultActive
                    ? 'bg-black border-cyan-500/40'
                    : 'bg-black border-zinc-800'
                }`}>
                  <div className="flex items-center justify-between mb-0.5 sm:mb-1 gap-1">
                    <div className="text-cyan-400 text-[9px] sm:text-xs font-bold tracking-wider flex items-center space-x-1 truncate">
                      <span>🏦</span>
                      <span>{lang === 'EN' ? 'VAULT' : 'SEIF'}</span>
                    </div>
                    <button
                      onClick={handleToggleProfitVault}
                      className={`text-[8px] sm:text-[9px] px-1 sm:px-1.5 py-0.5 rounded font-bold border transition-colors cursor-pointer shrink-0 ${
                        isVaultActive
                          ? 'bg-cyan-900 border-cyan-400 text-cyan-200'
                          : 'bg-zinc-800 border-zinc-600 text-zinc-400 hover:text-cyan-300'
                      }`}
                      title="Comută Modul Profit Vault"
                    >
                      {isVaultActive ? 'ACTIV' : 'OFF'}
                    </button>
                  </div>
                  <div className="flex items-baseline justify-between gap-1">
                    <div className="text-sm sm:text-xl font-bold font-mono text-cyan-300 truncate">
                      ${profitVault.toFixed(2)}
                    </div>
                    <div className="text-[9px] sm:text-[10px] text-zinc-400 font-mono shrink-0">
                      Bază: <span className="text-zinc-200 font-bold">${baseCapital.toFixed(2)}</span>
                    </div>
                  </div>
                </div>

                {/* 5. UNREALIZED PNL */}
                <div className="bg-black border border-zinc-800 p-2 sm:p-2.5 rounded flex flex-col justify-between min-w-0">
                  <div className="text-slate-400 text-[9px] sm:text-xs font-bold tracking-wider mb-0.5 sm:mb-1 truncate">
                    {lang === 'EN' ? 'UNREALIZED PNL' : 'PNL NEREALIZAT'}
                  </div>
                  <div className={`text-xs sm:text-lg font-bold font-mono truncate ${unrealizedPnL >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {unrealizedPnL >= 0 ? '+' : ''}${unrealizedPnL.toFixed(2)}
                    <span className="text-[9px] sm:text-xs ml-0.5 font-normal opacity-90">
                      ({unrealizedPnL >= 0 ? '+' : ''}{unrealizedPnLPct.toFixed(2)}%)
                    </span>
                  </div>
                </div>

                {/* 6. TOTAL PROFIT */}
                <div className="bg-black border border-zinc-800 p-2 sm:p-2.5 rounded flex flex-col justify-between min-w-0">
                  <div className="text-slate-400 text-[9px] sm:text-xs font-bold tracking-wider mb-0.5 sm:mb-1 truncate">
                    {lang === 'EN' ? 'TOTAL PROFIT' : 'PROFIT TOTAL'}
                  </div>
                  <div className={`text-xs sm:text-lg font-bold font-mono truncate ${totalProfit >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {totalProfit >= 0 ? '+' : ''}${totalProfit.toFixed(2)}
                    <span className="text-[9px] sm:text-xs ml-0.5 font-normal opacity-90">
                      ({totalProfit >= 0 ? '+' : ''}{totalProfitPct.toFixed(2)}%)
                    </span>
                  </div>
                </div>

                {/* 7. ACTIVE POSITIONS */}
                <div className="bg-black border border-zinc-800 p-2 sm:p-2.5 rounded flex flex-col justify-between min-w-0">
                  <div className="flex items-center justify-between mb-0.5 sm:mb-1 gap-1">
                    <div className="text-slate-400 text-[9px] sm:text-xs font-bold tracking-wider truncate">
                      {lang === 'EN' ? 'ACTIVE POSITIONS' : 'POZIȚII ACTIVE'}
                    </div>
                    <span className="text-[9px] sm:text-[10px] font-mono text-zinc-400 shrink-0">
                      Cap: {Math.round((activePositions.length / 5) * 100)}%
                    </span>
                  </div>
                  <div className="flex items-baseline justify-between gap-1">
                    <div className="text-sm sm:text-xl font-bold font-mono text-cyan-400 truncate">
                      {activePositions.length} <span className="text-[9px] sm:text-[10px] text-zinc-500 font-normal">/ 5 max</span>
                    </div>
                    <div className="text-[9px] sm:text-[10px] text-zinc-400 font-mono shrink-0">
                      {activePositions.length === 0 ? '0 deschise' : `${activePositions.length} active`}
                    </div>
                  </div>
                </div>

                {/* 8. OKX & BTC SENTIMENT */}
                <div className={`p-2 sm:p-2.5 rounded flex flex-col justify-between transition-all border min-w-0 ${
                  isBullishSentiment
                    ? 'bg-emerald-950/20 border-emerald-500/50 shadow-[0_0_12px_rgba(16,185,129,0.1)]'
                    : isBearishSentiment
                    ? 'bg-rose-950/20 border-rose-500/50 shadow-[0_0_12px_rgba(244,63,94,0.1)]'
                    : 'bg-black border-zinc-800'
                }`}>
                  <div className="flex items-center justify-between mb-0.5 gap-1">
                    <div className="text-slate-400 text-[9px] sm:text-xs font-bold tracking-wider flex items-center space-x-1 truncate">
                      <span>{lang === 'EN' ? 'OKX & BTC SENTIMENT' : 'SENTIMENT OKX & BTC'}</span>
                    </div>
                    <button
                      onClick={async () => {
                        const token = localStorage.getItem('tb5_control_token') || 'tradebot5_admin_token';
                        await fetch('/api/bot/sentiment/refresh', { method: 'POST', headers: { 'x-bot-token': token } });
                        onRefresh();
                      }}
                      className="text-zinc-400 hover:text-amber-400 transition-colors p-0.5 cursor-pointer shrink-0"
                      title="Reîmprospătează sentimentul global OKX și BTC"
                    >
                      <RefreshCw className="w-3 h-3" />
                    </button>
                  </div>
                  <div className="flex items-baseline justify-between gap-1">
                    <div className={`text-xs sm:text-base font-bold font-mono truncate ${
                      isBullishSentiment
                        ? 'text-emerald-400'
                        : isBearishSentiment
                        ? 'text-rose-400'
                        : 'text-amber-400'
                    }`}>
                      {status?.marketSentiment?.includes('BULLISH')
                        ? 'BULLISH'
                        : status?.marketSentiment?.includes('BEARISH')
                        ? 'BEARISH'
                        : 'NEUTRAL'}
                    </div>
                    <div className="text-[9px] sm:text-[10px] font-mono text-zinc-300 shrink-0">
                      Scor: <span className="font-bold text-amber-300">{sentimentScore >= 0 ? '+' : ''}{sentimentScore.toFixed(2)}%</span>
                    </div>
                  </div>
                  {/* BTC SENTIMENT (MUTAT DIN ANTET) */}
                  <div className="flex items-center justify-between text-[9px] sm:text-[10px] font-mono pt-1 border-t border-zinc-800/80 mt-1">
                    <span className="text-slate-400">BTC Trend:</span>
                    <span className={`font-bold px-1 py-0.2 rounded truncate ${
                      status?.marketRegime?.includes('BULL') || (status?.marketRegime?.includes('+') && !status?.marketRegime?.includes('-%'))
                        ? 'text-emerald-400 bg-emerald-950/40'
                        : status?.marketRegime?.includes('BEAR') || status?.marketRegime?.includes('-%')
                        ? 'text-rose-400 bg-rose-950/40'
                        : 'text-amber-300 bg-zinc-900'
                    }`}>
                      {status?.marketRegime || 'BTC: Neutru'}
                    </span>
                  </div>
                </div>
              </div>

              {/* ADVANCED STATS SUB-GRID */}
              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-1.5 mb-2 bg-black border border-amber-500/20 p-2 rounded text-xs">
                <div>
                  <div className="text-slate-400 text-[10px]">SESSION REALIZED</div>
                  <div className={`font-bold ${(status?.sessionRealizedPnL || 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {(status?.sessionRealizedPnL || 0) >= 0 ? '+' : ''}${(status?.sessionRealizedPnL || 0).toFixed(2)}
                  </div>
                </div>
                <div>
                  <div className="text-slate-400 text-[10px]">WIN RATE</div>
                  <div className="font-bold text-amber-400">
                    {status?.performanceMetrics?.winRate !== undefined 
                      ? `${status.performanceMetrics.winRate.toFixed(1)}% (${status.performanceMetrics.winningTrades || 0}W/${status.performanceMetrics.losingTrades || 0}L)` 
                      : '0.0% (0W/0L)'}
                  </div>
                </div>
                <div>
                  <div className="text-slate-400 text-[10px]">PROFIT FACTOR</div>
                  {(() => {
                    const perf = status?.performanceMetrics;
                    if (!perf || perf.totalClosed === 0) {
                      return (
                        <div className="font-bold text-zinc-400 profit-metric" title="Nicio tranzacție finalizată încă">
                          0.00 <span className="text-[10px] font-normal text-zinc-500">($0.00/$0.00)</span>
                        </div>
                      );
                    }
                    const totalWin = perf.totalGrossProfit !== undefined 
                      ? perf.totalGrossProfit 
                      : (perf.avgWin * perf.winningTrades);
                    const totalLoss = perf.totalGrossLoss !== undefined 
                      ? perf.totalGrossLoss 
                      : (perf.avgLoss * perf.losingTrades);
                    
                    const isInfinite = perf.profitFactor >= 999 || (totalLoss === 0 && totalWin > 0);
                    const pfStr = isInfinite ? 'MAX' : perf.profitFactor.toFixed(2);
                    const pfColor = isInfinite || perf.profitFactor >= 1.0 
                      ? 'text-emerald-400' 
                      : 'text-rose-400';

                    return (
                      <div
                        className={`font-bold profit-metric ${pfColor}`}
                        title={`Profit Factor = Câștig Brut ($${totalWin.toFixed(2)}) / Pierdere Brută ($${totalLoss.toFixed(2)}) | Câștig Mediu: $${perf.avgWin.toFixed(2)}, Pierdere Medie: $${perf.avgLoss.toFixed(2)}`}
                      >
                        {pfStr}{' '}
                        <span className="text-[10px] font-normal text-zinc-300">
                          (${totalWin.toFixed(2)}/${totalLoss.toFixed(2)})
                        </span>
                      </div>
                    );
                  })()}
                </div>
                <div>
                  <div className="text-slate-400 text-[10px]">EXPECTANCY</div>
                  <div className={`font-bold ${(status?.performanceMetrics?.expectancy || 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {(status?.performanceMetrics?.expectancy || 0) >= 0 ? '+' : ''}${status?.performanceMetrics?.expectancy !== undefined ? status.performanceMetrics.expectancy.toFixed(2) : '0.00'}
                  </div>
                </div>
                <div>
                  <div className="text-slate-400 text-[10px]">MAX DRAWDOWN</div>
                  <div className="font-bold text-rose-400">
                    -{status?.performanceMetrics?.maxDrawdownPct !== undefined ? status.performanceMetrics.maxDrawdownPct.toFixed(2) : '0.00'}%
                  </div>
                </div>
                <div>
                  <div className="text-slate-400 text-[10px]">TOTAL FEES (FEE)</div>
                  <div className="font-bold text-rose-400">
                    -${status?.performanceMetrics?.totalFeesPaid?.toFixed(2) || '0.00'}
                  </div>
                </div>
                <div>
                  <div className="text-slate-400 text-[10px]">CLOSED TRADES</div>
                  <div className="font-bold text-amber-300">
                    {status?.performanceMetrics?.totalClosed || 0}
                  </div>
                </div>
              </div>

              {/* EQUITY TRAILING PROTECTION CARD */}
              {status?.equityTrailingState && (
                <div className="bg-black border border-amber-500/20 rounded p-2.5 mb-2">
                  <div className="flex items-center justify-between mb-1.5 flex-wrap gap-2">
                    <div className="flex items-center space-x-2 flex-wrap gap-y-1">
                      <ShieldAlert className="w-4 h-4 text-amber-500 shrink-0" />
                      <h3 className="font-bold text-amber-500 uppercase tracking-wider text-xs flex items-center gap-2 flex-wrap">
                        <span>EQUITY TRAILING PROTECTION</span>
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
                            {profitVault > 0
                              ? `AȘTEPTARE PROFIT (PRAG TOTAL: $${(status.equityTrailingState.activationTotalEquity || (status.equityTrailingState.activationPrice + profitVault)).toFixed(2)} | +${status.equityTrailingState.activationPct.toFixed(2)}%)`
                              : `AȘTEPTARE PROFIT (NECESITĂ +${status.equityTrailingState.activationPct.toFixed(2)}%)`}
                          </span>
                        )}
                        <span className="bg-cyan-950 text-cyan-300 border border-cyan-500/50 px-2 py-0.5 rounded text-[10px] font-bold" title="Numărul total de declanșări cu succes ale protecției de capital">
                          🛡️ DECLANȘAT: {status.equityTrailingState.triggerCount} {status.equityTrailingState.triggerCount === 1 ? 'DATĂ' : 'ORI'}
                        </span>
                      </h3>
                    </div>

                    {/* Action buttons: Jurnal & Export CSV & Reset */}
                    <div className="flex items-center space-x-1.5">
                      <button
                        type="button"
                        onClick={() => setShowEquityProtectionModal(true)}
                        className="inline-flex items-center space-x-1 px-2 py-0.5 rounded text-[10px] font-bold bg-zinc-900 hover:bg-zinc-800 border border-amber-500/40 text-amber-300 transition-colors shadow-sm cursor-pointer"
                        title="Vizualizează jurnalul detaliat cu toate declanșările protecției"
                      >
                        <FileText className="w-3 h-3 text-amber-400" />
                        <span>JURNAL DECLANȘĂRI ({status.equityTrailingState.triggerCount})</span>
                      </button>
                      <button
                        type="button"
                        onClick={handleExportEquityProtectionCSV}
                        className="inline-flex items-center space-x-1 px-2 py-0.5 rounded text-[10px] font-bold bg-amber-950/60 hover:bg-amber-900 border border-amber-500/50 text-amber-200 transition-colors shadow-sm cursor-pointer"
                        title="Descarcă jurnalul declanșărilor în format CSV (Excel) similar cu BLOT"
                      >
                        <Download className="w-3 h-3 text-amber-400" />
                        <span>EXPORT CSV</span>
                      </button>
                      <button
                        type="button"
                        disabled={isClearingEquityProtection}
                        onClick={handleClearEquityProtection}
                        className="inline-flex items-center space-x-1 px-2 py-0.5 rounded text-[10px] font-bold bg-rose-950/60 hover:bg-rose-900 border border-rose-500/50 text-rose-300 hover:text-rose-100 transition-colors shadow-sm cursor-pointer disabled:opacity-50"
                        title="Resetează contorul și golește istoricul declanșărilor protecției de capital"
                      >
                        <Trash2 className="w-3 h-3 text-rose-400" />
                        <span>RESET</span>
                      </button>
                    </div>
                  </div>
                  
                  <p className="text-xs text-slate-400 mb-2">
                    {!status.equityTrailingState.isEnabled || status.equityTrailingState.activationPct <= 0 || status.equityTrailingState.drawdownLimitPct <= 0
                      ? 'Protecția de capital este DEZACTIVATĂ (setată la 0%). Pozițiile sunt controlate exclusiv de Stop-Loss, Trailing Stop și Take-Profit individuale.'
                      : status.equityTrailingState.isActive 
                        ? `Urmărirea este activă. Se va închide automat la o retragere de ${status.equityTrailingState.drawdownLimitPct.toFixed(2)}% din vârful atins (la Total Equity $${(profitVault > 0 ? (status.equityTrailingState.sellThresholdTotal || ((status.equityTrailingState.sellThreshold || 0) + profitVault)) : (status.equityTrailingState.sellThreshold || 0)).toFixed(2)}). Protecția a fost declanșată cu succes de ${status.equityTrailingState.triggerCount} ori până acum.`
                        : profitVault > 0
                          ? `Urmărirea se activează când Total Equity atinge $${(status.equityTrailingState.activationTotalEquity || (status.equityTrailingState.activationPrice + profitVault)).toFixed(2)} (adică baza curată de $${baseCapital.toFixed(2)} + $${((baseCapital * status.equityTrailingState.activationPct) / 100).toFixed(2)} profit necesar + $${profitVault.toFixed(2)} din Seif). Total curent: $${currentEquity.toFixed(2)} (mai necesită +$${Math.max(0, (status.equityTrailingState.activationTotalEquity || (status.equityTrailingState.activationPrice + profitVault)) - currentEquity).toFixed(2)} profit). Până atunci pozițiile respiră liber. Protecția a fost declanșată cu succes de ${status.equityTrailingState.triggerCount} ori până acum.`
                          : `Urmărirea se activează când contul atinge $${status.equityTrailingState.activationPrice.toFixed(2)} (+${status.equityTrailingState.activationPct.toFixed(2)}%). Până atunci pozițiile respiră liber. Protecția a fost declanșată cu succes de ${status.equityTrailingState.triggerCount} ori până acum.`}
                  </p>

                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-[11px]">
                    <div>
                      <div className="text-slate-400 tracking-wider mb-0.5">
                        {profitVault > 0 ? 'PRAG ACTIVARE (TOTAL)' : 'PRAG ACTIVARE'}
                      </div>
                      <div className="font-bold text-emerald-400">
                        ${(profitVault > 0 ? (status.equityTrailingState.activationTotalEquity || (status.equityTrailingState.activationPrice + profitVault)) : status.equityTrailingState.activationPrice).toFixed(2)}
                        {profitVault > 0 ? (
                          <div className="text-[10px] text-zinc-400 font-normal mt-0.5">
                            Lucru: ${status.equityTrailingState.activationPrice.toFixed(2)} (+{status.equityTrailingState.activationPct.toFixed(2)}%)
                          </div>
                        ) : (
                          <span className="text-[10px] ml-1">(+{status.equityTrailingState.activationPct.toFixed(2)}%)</span>
                        )}
                      </div>
                    </div>
                    <div>
                      <div className="text-slate-400 tracking-wider mb-0.5">
                        {profitVault > 0 ? 'VÂRF ATINS (TOTAL)' : 'HIGH-WATER MARK (PEAK)'}
                      </div>
                      <div className="font-bold text-amber-100">
                        ${(profitVault > 0 ? (status.equityTrailingState.peakTotalEquity || (status.equityTrailingState.peakEquity + profitVault)) : status.equityTrailingState.peakEquity).toFixed(2)}
                        {profitVault > 0 && (
                          <div className="text-[10px] text-cyan-400 font-normal mt-0.5">
                            Lucru: ${operatingEquity.toFixed(2)} (vârf: ${status.equityTrailingState.peakEquity.toFixed(2)})
                          </div>
                        )}
                      </div>
                    </div>
                    <div>
                      <div className="text-slate-400 tracking-wider mb-0.5">
                        {profitVault > 0 ? 'PRAG VÂNZARE (TOTAL)' : 'PRAG VÂNZARE'}
                      </div>
                      <div className="font-bold text-zinc-300">
                        {status.equityTrailingState.sellThreshold 
                          ? `$${(profitVault > 0 ? (status.equityTrailingState.sellThresholdTotal || (status.equityTrailingState.sellThreshold + profitVault)) : status.equityTrailingState.sellThreshold).toFixed(2)}`
                          : 'În așteptare'}
                        {profitVault > 0 && status.equityTrailingState.sellThreshold && (
                          <div className="text-[10px] text-zinc-400 font-normal mt-0.5">
                            Lucru: ${status.equityTrailingState.sellThreshold.toFixed(2)}
                          </div>
                        )}
                      </div>
                    </div>
                    <div>
                      <div className="text-slate-400 tracking-wider mb-0.5">RETRAGERE CURENTĂ</div>
                      <div className="font-bold text-emerald-400">
                        {status.equityTrailingState.currentDrawdownPct.toFixed(2)}%
                      </div>
                    </div>
                    <div>
                      <div className="text-slate-400 tracking-wider mb-0.5">DECLANȘĂRI TOTALE</div>
                      <div className="font-bold text-cyan-300 flex items-center gap-1">
                        <span>{status.equityTrailingState.triggerCount} {status.equityTrailingState.triggerCount === 1 ? 'ciclu' : 'cicluri'}</span>
                        <button
                          type="button"
                          onClick={() => setShowEquityProtectionModal(true)}
                          className="text-[10px] text-amber-400 hover:text-white underline cursor-pointer ml-1 font-bold"
                          title="Deschide jurnalul de audit"
                        >
                          [LOG]
                        </button>
                        <button
                          type="button"
                          onClick={handleClearEquityProtection}
                          className="text-[10px] text-rose-400 hover:text-rose-200 underline cursor-pointer ml-1 font-bold"
                          title="Resetează contorul de declanșări la 0"
                        >
                          [RESET]
                        </button>
                      </div>
                    </div>
                  </div>

                  {isVaultActive && (
                    <div className="mt-2 pt-2 border-t border-cyan-500/30 flex items-center justify-between text-[11px] text-cyan-300 font-mono">
                      <span>🏦 <strong>Profit Vault Activ:</strong> La declanșarea protecției, profitul obținut este transferat automat în Seif (+${profitVault.toFixed(2)} USDT curent). Noul ciclu reia cu baza curată de ${baseCapital.toFixed(2)} USDT.</span>
                    </div>
                  )}
                </div>
              )}

              {/* ACTIVE RISK & RULES HUD (PROPOSAL 2 - COMPLETE LIVE RULES INTEGRATION) */}
              <div className="bg-zinc-950 border border-amber-500/30 rounded p-2.5 font-mono shadow-lg">
                {/* Header */}
                <div className="flex items-center justify-between border-b border-amber-500/20 pb-1.5 mb-2">
                  <div className="flex items-center space-x-1.5">
                    <ShieldCheck className="w-4 h-4 text-amber-400" />
                    <span className="font-bold text-[11px] text-amber-400 uppercase tracking-wider">
                      {lang === 'EN' ? 'ACTIVE RISK & BOT RULES HUD' : 'REGULI ACTIVE DE RISC & PROTECȚIE (HUD)'}
                    </span>
                  </div>
                  <div className="flex items-center space-x-1.5">
                    <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-amber-500/10 border border-amber-500/30 text-amber-300">
                      PROFIL: {status?.currentProfile || 'SCALP'}
                    </span>
                    <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-zinc-900 border border-zinc-700 text-zinc-300">
                      MOD: {status?.executionMode || 'PAPER'}
                    </span>
                    <button
                      type="button"
                      onClick={() => setActiveScreen('SET')}
                      className="text-[9px] text-amber-400 hover:text-amber-300 underline font-semibold pl-1"
                      title="Deschide ecranul SET pentru modificarea regulilor"
                    >
                      [MODIFICĂ ÎN SET ➔]
                    </button>
                  </div>
                </div>

                {/* 4 Compact Columns containing ALL rules from SET */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 text-[10px]">
                  {/* Col 1: Alocare Capital */}
                  <div className="bg-black/80 border border-zinc-800/80 rounded p-1.5 space-y-1">
                    <div className="text-[9px] text-amber-500/90 font-bold uppercase tracking-wider border-b border-zinc-900 pb-0.5">
                      1. ALOCARE RISC
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-slate-400">Risc/Trade:</span>
                      <span className="font-bold text-amber-300">{profileConfig?.riskPerTradePct ?? 10}%</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-slate-400">Capacitate:</span>
                      <span className="font-bold text-zinc-200">
                        {status?.activePositions?.length || 0} / {profileConfig?.maxOpenPositions ?? 5}
                      </span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-slate-400">Mărime est.:</span>
                      <span className="font-bold text-emerald-400">
                        ~${((currentEquity * (profileConfig?.riskPerTradePct ?? 10)) / 100).toFixed(1)}
                      </span>
                    </div>
                  </div>

                  {/* Col 2: Protecție Ieșire Poziție */}
                  <div className="bg-black/80 border border-zinc-800/80 rounded p-1.5 space-y-1">
                    <div className="text-[9px] text-rose-400/90 font-bold uppercase tracking-wider border-b border-zinc-900 pb-0.5">
                      2. STOP-LOSS & BE
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-slate-400">Hard SL:</span>
                      <span className="font-bold text-rose-400">-{profileConfig?.hardStopLossPct ?? 20.0}%</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-slate-400">Break-Even:</span>
                      <span className="font-bold text-amber-300">+{profileConfig?.breakEvenActivationPct ?? 5.0}%</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-slate-400">Take-Profit:</span>
                      <span className="font-bold text-emerald-400">
                        {!profileConfig?.takeProfitPct || profileConfig.takeProfitPct === 0 ? 'OFF (Trail)' : `+${profileConfig.takeProfitPct}%`}
                      </span>
                    </div>
                  </div>

                  {/* Col 3: Trailing Stop Poziție & Equity */}
                  <div className="bg-black/80 border border-zinc-800/80 rounded p-1.5 space-y-1">
                    <div className="text-[9px] text-purple-400/90 font-bold uppercase tracking-wider border-b border-zinc-900 pb-0.5">
                      3. TRAILING STOP
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-slate-400">Act. Poziție:</span>
                      <span className="font-bold text-emerald-400">+{profileConfig?.trailingActivationPct ?? 1.1}%</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-slate-400">Pas Urmărire:</span>
                      <span className="font-bold text-purple-300">-{profileConfig?.trailingDistancePct ?? 0.35}%</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-slate-400">Trail Eq DD:</span>
                      <span className="font-bold text-rose-400">
                        {!profileConfig?.equityTrailingDrawdownPct ? 'OFF' : `-${profileConfig.equityTrailingDrawdownPct}%`}
                      </span>
                    </div>
                  </div>

                  {/* Col 4: Scanare, Timp & Sentiment */}
                  <div className="bg-black/80 border border-zinc-800/80 rounded p-1.5 space-y-1">
                    <div className="text-[9px] text-cyan-400/90 font-bold uppercase tracking-wider border-b border-zinc-900 pb-0.5">
                      4. TIMP & FILTRE
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-slate-400">Momentum W:</span>
                      <span className="font-bold text-cyan-400">[{profileConfig?.minMomentumScore ?? 50} - {profileConfig?.maxMomentumScore ?? 99}]</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-slate-400">Volum 24h:</span>
                      <span className="font-bold text-emerald-400">
                        [{(profileConfig?.min24hVolumeUSDT ? profileConfig.min24hVolumeUSDT / 1_000_000 : 1.5).toFixed(1)}M - {profileConfig?.max24hVolumeUSDT && profileConfig.max24hVolumeUSDT > 0 ? (profileConfig.max24hVolumeUSDT / 1_000_000).toFixed(1) + 'M' : '∞'}]
                      </span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-slate-400">Hold / CD:</span>
                      <span className="font-bold text-amber-300">
                        {profileConfig?.maxHoldingTimeMinutes ?? 45}m / {profileConfig?.cooldownMinutes ?? 0}m
                      </span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-slate-400">Sentiment:</span>
                      <span className="font-bold text-zinc-300">±{profileConfig?.sentimentThreshold ?? 1.5}%</span>
                    </div>
                  </div>
                </div>

                {/* Micro-footer */}
                <div className="mt-1.5 pt-1 border-t border-zinc-900 flex items-center justify-between text-[9px] text-slate-400">
                  <div className="flex items-center space-x-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
                    <span>Toate cele 12 reguli sunt aplicate activ în timp real</span>
                  </div>
                  <span className="text-slate-400">
                    Bază Capital: <strong className={isExpOn ? 'text-cyan-300' : 'text-amber-300'}>
                      {isExpOn ? '$10,000.00' : `$${baseCapital.toFixed(2)}`}
                    </strong>
                  </span>
                </div>
              </div>

            </div>
          )}

          {activeScreen === 'INFO' && (
            <div className="bg-zinc-950 border border-amber-500/30 rounded p-3 sm:p-4 flex flex-col flex-1 min-h-0 font-mono text-zinc-300 space-y-4">
              <div className="flex items-center space-x-2 border-b border-amber-500/30 pb-2">
                <Info className="w-4 h-4 text-amber-500" />
                <h2 className="text-sm sm:text-base font-bold text-amber-400 tracking-wider">
                  {lang === 'EN' ? 'DESK INFORMATION & PRODUCTION DEPLOYMENT GUIDE' : 'INFORMAȚII DESK & GHID LANSARE ÎN PRODUCȚIE'}
                </h2>
              </div>

              {/* PDF Manual Banner & Quick Download */}
              <div className="bg-gradient-to-r from-amber-950/40 via-zinc-950 to-black border border-amber-500/50 rounded p-3 sm:p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-lg shadow-amber-950/20">
                <div className="space-y-1">
                  <div className="flex items-center space-x-2 text-amber-400 font-bold text-xs sm:text-sm">
                    <BookOpen className="w-4 h-4 text-amber-400 shrink-0" />
                    <span>MANUAL OFICIAL DE UTILIZARE — TRADEBOT 5 BLOOMBERG TERMINAL (PDF)</span>
                  </div>
                  <p className="text-[11px] text-zinc-300 leading-relaxed font-sans">
                    Documentație completă structurată pe capitole: Ghid pentru fiecare buton, card financiar, tabel, Reset Cont $200, Kill Switch, Multiplicator gradual continuu [0.50x – 1.50x] și telemetrie viteză impuls.
                  </p>
                </div>
                <div className="flex items-center space-x-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => setShowManualModal(true)}
                    className="px-3 py-1.5 bg-zinc-900 hover:bg-zinc-800 text-zinc-200 border border-zinc-700 rounded text-xs font-bold transition-all flex items-center space-x-1.5 cursor-pointer"
                  >
                    <Eye className="w-3.5 h-3.5 text-cyan-400" />
                    <span>VIZUALIZEAZĂ</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => downloadUserManualPdf()}
                    className="px-3.5 py-1.5 bg-amber-500 hover:bg-amber-400 text-black font-bold rounded text-xs transition-all flex items-center space-x-1.5 shadow-md shadow-amber-500/20 cursor-pointer"
                  >
                    <Download className="w-4 h-4 text-black" />
                    <span>DESCARCĂ PDF</span>
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs leading-relaxed">
                {/* 1: Local Execution */}
                <div className="bg-black border border-zinc-800 p-3 rounded space-y-2">
                  <h3 className="font-bold text-amber-400 text-xs border-b border-zinc-800 pb-1.5 flex items-center space-x-1.5">
                    <span className="w-2 h-2 rounded-full bg-amber-500"></span>
                    <span>{lang === 'EN' ? '1. Local Execution' : '1. Rulare Locală'}</span>
                  </h3>
                  <p className="text-zinc-400 text-[11px]">
                    {lang === 'EN' 
                      ? 'To run the Bloomberg TradeBot stack locally on your machine:'
                      : 'Pentru a rula aplicația local pe calculatorul tău:'}
                  </p>
                  <div className="bg-zinc-900 p-2 rounded border border-zinc-800 text-amber-300 font-mono text-[10px] space-y-0.5">
                    <div># 1. Dependențe</div>
                    <div className="text-white">npm install</div>
                    <div className="pt-0.5"># 2. Pornire server dev</div>
                    <div className="text-white">npm run dev</div>
                  </div>
                </div>

                {/* 2: Oracle Cloud (Ubuntu) Installation */}
                <div className="bg-black border border-zinc-800 p-3 rounded space-y-2">
                  <h3 className="font-bold text-emerald-400 text-xs border-b border-zinc-800 pb-1.5 flex items-center space-x-1.5">
                    <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
                    <span>{lang === 'EN' ? '2. Oracle Cloud (PM2)' : '2. Oracle Cloud (PM2)'}</span>
                  </h3>
                  <p className="text-zinc-400 text-[11px]">
                    {lang === 'EN' 
                      ? 'Deploy on an Ubuntu Cloud instance with 24/7 background execution:'
                      : 'Instalare pe server Ubuntu cu rulare continuă 24/7 prin PM2:'}
                  </p>
                  <div className="bg-zinc-900 p-2 rounded border border-zinc-800 text-emerald-300 font-mono text-[10px] space-y-0.5">
                    <div># 1. Build producție</div>
                    <div className="text-white">npm run build</div>
                    <div className="pt-0.5"># 2. Lansare PM2</div>
                    <div className="text-white">pm2 start ecosystem.config.js</div>
                    <div className="text-white">pm2 save && pm2 startup</div>
                  </div>
                </div>

                {/* 3: Electron Desktop Executable */}
                <div className="bg-black border border-zinc-800 p-3 rounded space-y-2">
                  <h3 className="font-bold text-sky-400 text-xs border-b border-zinc-800 pb-1.5 flex items-center space-x-1.5">
                    <span className="w-2 h-2 rounded-full bg-sky-500"></span>
                    <span>{lang === 'EN' ? '3. Electron Executable' : '3. Executabil Desktop Electron'}</span>
                  </h3>
                  <p className="text-zinc-400 text-[11px]">
                    {lang === 'EN' 
                      ? 'Compile standalone desktop application for Windows (.exe installer & portable):'
                      : 'Compilare aplicație desktop nativă pentru Windows (.exe & portable):'}
                  </p>
                  <div className="bg-zinc-900 p-2 rounded border border-zinc-800 text-sky-300 font-mono text-[10px] space-y-0.5">
                    <div># 1. Build applet bundle</div>
                    <div className="text-white">npm run build</div>
                    <div className="pt-0.5"># 2. Generare executabil .exe</div>
                    <div className="text-white">npm run electron:build</div>
                    <div className="text-zinc-400 text-[9px] pt-0.5">➔ Fisierele .exe se salvează în folderul release/</div>
                  </div>
                </div>
              </div>

              <div className="bg-amber-950/20 border border-amber-500/30 p-2.5 rounded text-[11px] text-amber-300/90 flex items-start space-x-2 mt-auto">
                <Info className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                <div>
                  <strong className="text-amber-400">Notă Bloomberg Desk:</strong> Aplicația este optimizată pentru rulare în producție 24/7. Modulul Electron integrează serverul automat și asigură o experiență trading fără browser, cu performanță maximă.
                </div>
              </div>
            </div>
          )}

          {(activeScreen === 'POS' || activeScreen === 'TAPE') && renderOpenPositionsContent('F2')}

          {activeScreen === 'SCAN' && (
            <div className="bg-zinc-950 border border-amber-500/30 rounded p-2 sm:p-3 flex flex-col flex-1 min-h-0">
              <div className="flex flex-wrap items-center justify-between border-b border-amber-500/30 pb-2 mb-3 gap-2">
                <div className="flex items-center space-x-2">
                  <Search className="w-4 h-4 text-amber-500" />
                  <span className="font-bold text-xs sm:text-sm tracking-wider">F3: MARKET MOMENTUM SCANNER &amp; UNIVERSE</span>
                </div>
                <div className="flex items-center space-x-1.5 sm:space-x-2">
                  <button
                    onClick={() => setShowScannerConfig(!showScannerConfig)}
                    className="bg-zinc-900 hover:bg-zinc-800 text-amber-400 border border-amber-500/40 px-2 py-0.5 sm:py-1 rounded text-[11px] sm:text-xs font-bold flex items-center space-x-1"
                  >
                    <Sliders className="w-3.5 h-3.5" />
                    <span>{showScannerConfig ? 'HIDE FILTERS' : 'FILTERS'}</span>
                  </button>
                  <button
                    onClick={onTriggerScan}
                    className="bg-amber-500 hover:bg-amber-400 text-black px-2 py-0.5 sm:py-1 rounded text-[11px] sm:text-xs font-bold"
                  >
                    SCAN NOW
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
                <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                  <div className="bg-zinc-900 p-3 rounded border border-amber-500/20">
                    <div className="text-slate-400 text-[11px]">Universe Monitored</div>
                    <div className="text-lg font-bold text-amber-400">{status?.scannerStats?.universeCount ?? 0} Symbols</div>
                  </div>
                  <div className="bg-zinc-900 p-3 rounded border border-amber-500/20">
                    <div className="text-slate-400 text-[11px]">Scanned Universe (Liquid)</div>
                    <div className="text-lg font-bold text-cyan-400">{status?.scannerStats?.topOpportunities?.length ?? 0} Pairs</div>
                  </div>
                  <div className="bg-zinc-900 p-3 rounded border border-amber-500/20">
                    <div className="text-slate-400 text-[11px]">Filtered Candidates (Signals)</div>
                    <div className="text-lg font-bold text-emerald-400">{status?.scannerStats?.candidatesCount ?? 0} Eligible</div>
                  </div>
                  <div className="bg-zinc-900 p-3 rounded border border-amber-500/20">
                    <div className="text-slate-400 text-[11px]">Scan Interval</div>
                    <div className="text-lg font-bold text-zinc-300">15s Auto</div>
                  </div>
                </div>

                <div className="bg-zinc-900/80 rounded border border-amber-500/20 overflow-hidden flex flex-col flex-1 min-h-0">
                  <div className="text-xs font-bold text-amber-400 p-2 sm:p-2.5 border-b border-amber-500/30 flex items-center justify-between bg-zinc-950">
                    <span className="tracking-wide text-[11px] sm:text-xs">TOP SCANNED OPPORTUNITIES / SCANNED UNIVERSE ({status?.scannerStats?.topOpportunities?.length || 0})</span>
                    <span className="text-[9px] sm:text-[10px] text-zinc-500 font-mono">OKX Real-time</span>
                  </div>
                  <div className="overflow-y-auto overflow-x-auto flex-1 min-h-0 relative">
                    <table className="w-full text-left text-xs border-collapse">
                      <thead className="sticky top-0 z-10 bg-zinc-950 border-b border-amber-500/40 text-amber-400 shadow-[0_2px_4px_rgba(0,0,0,0.8)]">
                        <tr>
                          <th className="py-2.5 px-3 bg-zinc-950 sticky top-0 font-bold">Rank</th>
                          <th className="py-2.5 px-3 bg-zinc-950 sticky top-0 font-bold">Symbol</th>
                          <th className="py-2.5 px-3 bg-zinc-950 sticky top-0 font-bold">Direcție</th>
                          <th className="py-2.5 px-3 bg-zinc-950 sticky top-0 font-bold">Preț Curent</th>
                          <th className="py-2.5 px-3 bg-zinc-950 sticky top-0 font-bold">RVOL</th>
                          <th className="py-2.5 px-3 bg-zinc-950 sticky top-0 font-bold">Scor Momentum</th>
                          <th className="py-2.5 px-3 bg-zinc-950 sticky top-0 font-bold text-right">Eligibilitate</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-zinc-800/80 font-mono">
                        {status?.scannerStats?.topOpportunities?.length ? (
                          status.scannerStats.topOpportunities.map((opp) => (
                            <tr key={opp.symbol} className="hover:bg-zinc-800/40 transition-colors">
                              <td className="py-2 px-3 text-slate-400 text-[11px]">#{opp.rank}</td>
                              <td className="py-2 px-3 font-bold text-amber-300">
                                <button
                                  type="button"
                                  onClick={() => loadTradingViewChart(opp.symbol)}
                                  className="hover:underline text-left"
                                  title="Afișează grafic"
                                >
                                  {opp.symbol}
                                </button>
                              </td>
                              <td className="py-2 px-3">
                                <div className="flex items-center space-x-1">
                                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                                    opp.side === 'SELL' ? 'bg-rose-950 text-rose-400 border border-rose-800/60' : 'bg-emerald-950 text-emerald-400 border border-emerald-800/60'
                                  }`}>
                                    {opp.side === 'SELL' ? 'SHORT' : 'LONG'}
                                  </span>
                                  {opp.isFadeTrade && (
                                    <span className="text-[9px] px-1 py-0.2 bg-purple-950 text-purple-300 border border-purple-700 rounded font-bold" title="Sub-strategie Fade Extrem">
                                      FADE
                                    </span>
                                  )}
                                </div>
                              </td>
                              <td className="py-2 px-3 text-slate-300 font-mono">${opp.price}</td>
                              <td className="py-2 px-3 text-emerald-400 font-bold">{opp.rvol}x</td>
                              <td className="py-2 px-3 text-amber-400 font-bold">{opp.score}/100</td>
                              <td className="py-2 px-3 text-right">
                                <span className={`px-2 py-0.5 rounded font-bold text-[10px] ${
                                  opp.isEligible && opp.isFadeTrade
                                    ? 'bg-purple-950 text-purple-300 border border-purple-600 shadow-[0_0_8px_rgba(168,85,247,0.3)]'
                                    : opp.isEligible 
                                    ? 'bg-emerald-950 text-emerald-400 border border-emerald-800' 
                                    : 'bg-zinc-800 text-zinc-400'
                                }`}>
                                  {opp.isEligible && opp.isFadeTrade 
                                    ? 'FADE EXTREM' 
                                    : opp.isEligible 
                                    ? 'ELIGIBLE' 
                                    : 'FILTERED'}
                                </span>
                              </td>
                            </tr>
                          ))
                        ) : (
                          <tr>
                            <td colSpan={7} className="text-zinc-500 text-xs py-8 text-center">
                              Nu există date de scanare în cache. Apasă "RUN SCAN NOW".
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeScreen === 'BLOT' && (
            <div className="bg-zinc-950 border border-amber-500/30 rounded p-2 sm:p-3 flex flex-col flex-1 min-h-0">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-500/30 pb-2 mb-3">
                <div className="flex items-center space-x-2">
                  <List className="w-4 h-4 text-amber-500" />
                  <span className="font-bold text-xs sm:text-sm tracking-wider">F4: ORDER EXECUTION BLOTTER &amp; AUDIT LOGS</span>
                  <span className="text-[10px] sm:text-xs text-slate-400 font-mono">({orders.length} Orders)</span>
                </div>

                {/* Control Action Buttons: Save Log (CSV/Excel) & Clear Log & Equity Prot Log */}
                <div className="flex items-center space-x-1.5 sm:space-x-2">
                  <button
                    type="button"
                    onClick={() => setShowEquityProtectionModal(true)}
                    className="inline-flex items-center space-x-1 sm:space-x-1.5 px-2 sm:px-2.5 py-0.5 sm:py-1 rounded text-[11px] sm:text-xs font-bold bg-amber-950/80 hover:bg-amber-900 border border-amber-500/50 text-amber-300 transition-colors shadow-sm cursor-pointer"
                    title="Vizualizează și exportă istoricul complet al declanșărilor Equity Trailing Protection"
                  >
                    <ShieldAlert className="w-3 sm:w-3.5 h-3 sm:h-3.5 text-amber-400" />
                    <span>LOG EQ PROT ({status?.equityTrailingState?.triggerCount || 0})</span>
                  </button>

                  <button
                    type="button"
                    onClick={handleExportOrders}
                    disabled={orders.length === 0}
                    className="inline-flex items-center space-x-1 sm:space-x-1.5 px-2 sm:px-2.5 py-0.5 sm:py-1 rounded text-[11px] sm:text-xs font-bold bg-emerald-950/80 hover:bg-emerald-900 border border-emerald-600/50 text-emerald-300 transition-colors disabled:opacity-40 disabled:cursor-not-allowed shadow-sm"
                    title="Exportă istoricul ordinelor în format CSV / Excel"
                  >
                    <Download className="w-3 sm:w-3.5 h-3 sm:h-3.5" />
                    <span>SAVE LOG</span>
                  </button>

                  {!showClearOrdersConfirm ? (
                    <button
                      type="button"
                      onClick={() => setShowClearOrdersConfirm(true)}
                      disabled={orders.length === 0}
                      className="inline-flex items-center space-x-1 sm:space-x-1.5 px-2 sm:px-2.5 py-0.5 sm:py-1 rounded text-[11px] sm:text-xs font-bold bg-rose-950/60 hover:bg-rose-900/80 border border-rose-600/40 text-rose-300 transition-colors disabled:opacity-40 disabled:cursor-not-allowed shadow-sm"
                      title="Șterge istoricul ordinelor curente"
                    >
                      <Trash2 className="w-3 sm:w-3.5 h-3 sm:h-3.5" />
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

              {/* Scrollable Blotter Table with Frozen Sticky Header */}
              <div className="overflow-y-auto overflow-x-auto flex-1 min-h-0 border border-zinc-800 rounded relative">
                <table className="w-full text-left text-xs border-collapse">
                  <thead className="sticky top-0 z-20 bg-zinc-950 shadow-[0_2px_4px_rgba(0,0,0,0.8)] border-b border-amber-500/40">
                    <tr className="text-amber-400 font-bold">
                      <th className="py-2.5 px-2.5 bg-zinc-950 sticky top-0">ID</th>
                      <th className="py-2.5 px-2.5 bg-zinc-950 sticky top-0">Symbol</th>
                      <th className="py-2.5 px-2.5 bg-zinc-950 sticky top-0">Side</th>
                      <th className="py-2.5 px-2.5 bg-zinc-950 sticky top-0">Intent</th>
                      <th className="py-2.5 px-2.5 bg-zinc-950 sticky top-0">Size ($)</th>
                      <th className="py-2.5 px-2.5 bg-zinc-950 sticky top-0">Status</th>
                      <th className="py-2.5 px-2.5 bg-zinc-950 sticky top-0">PnL / Exit Log</th>
                      <th className="py-2.5 px-2.5 bg-zinc-950 sticky top-0 text-right">Time</th>
                      <th className="py-2.5 px-2.5 bg-zinc-950 sticky top-0 text-center">Log</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-900 font-mono">
                    {orders.length === 0 ? (
                      <tr>
                        <td colSpan={9} className="py-12 text-center text-zinc-500 font-mono text-xs">
                          Nu există ordine executate înregistrate în această sesiune.
                        </td>
                      </tr>
                    ) : (
                      orders.map((ord) => {
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
                              <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${ord.intent !== 'ENTRY' ? 'bg-zinc-800 text-zinc-300' : (ord.side === 'BUY' ? 'bg-emerald-950 text-emerald-400' : 'bg-rose-950 text-rose-400')}`}>
                                {ord.intent === 'ENTRY' ? (ord.side === 'BUY' ? 'LONG' : 'SHORT') : 'CLOSE'}
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
                                        DETALII EXECUȚIE ORDIN: {ord.symbol} ({ord.intent === 'ENTRY' ? (ord.side === 'BUY' ? 'LONG' : 'SHORT') : 'CLOSE'}) [{ord.id}]
                                      </span>
                                    </div>
                                    <div className="flex items-center space-x-3 text-[11px] text-zinc-400">
                                      {ord.positionId && (
                                        <span className="bg-zinc-800 text-amber-300 px-1.5 py-0.5 rounded font-mono text-[10px] border border-amber-500/30">
                                          pos_id: {ord.positionId}
                                        </span>
                                      )}
                                      <span>Profil: <strong className="text-zinc-200">{ord.profile}</strong></span>
                                      <span>Mod: <strong className="text-amber-300">{ord.executionMode}</strong></span>
                                      <span>Leverage: <strong className="text-amber-400">{ord.leverage || '1x'}</strong></span>
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
                                      <div className="text-sm font-bold text-zinc-200 mt-0.5 font-mono">
                                        {ord.fillPrice ? `${formatPrice(ord.fillPrice, { prefix: '$' })}` : 'La Piață (Market)'}
                                        {ord.entryPrice && (
                                          <span className="text-[10px] text-zinc-400 block font-normal font-mono">
                                            Intrare: {formatPrice(ord.entryPrice, { prefix: '$' })}
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

                                    {/* Quantitative & Statistical Telemetry Grid */}
                                    <div className="bg-black/60 border border-zinc-800 p-2 rounded">
                                      <div className="text-[10px] text-zinc-400 uppercase">MAE / MFE Poziție</div>
                                      <div className="text-xs font-mono font-bold mt-0.5">
                                        <span className="text-rose-400">MAE: {ord.maePct !== undefined ? `${ord.maePct}%` : '0.00%'}</span>
                                        <span className="text-zinc-500 mx-1">|</span>
                                        <span className="text-emerald-400">MFE: {ord.mfePct !== undefined ? `+${ord.mfePct}%` : '0.00%'}</span>
                                      </div>
                                    </div>

                                    <div className="bg-black/60 border border-zinc-800 p-2 rounded">
                                      <div className="text-[10px] text-zinc-400 uppercase">Slippage &amp; Semnal</div>
                                      <div className="text-xs font-mono mt-0.5">
                                        <span className="text-zinc-300">Semnal: {ord.signalPrice ? `${formatPrice(ord.signalPrice, { prefix: '$' })}` : '--'}</span>
                                        <span className="text-amber-400 font-bold block text-[11px]">
                                          Slippage: {ord.estimatedSlippagePct !== undefined ? `${ord.estimatedSlippagePct > 0 ? '+' : ''}${ord.estimatedSlippagePct}%` : '0.00%'}
                                        </span>
                                      </div>
                                    </div>

                                    <div className="bg-black/60 border border-zinc-800 p-2 rounded">
                                      <div className="text-[10px] text-zinc-400 uppercase">Scor Model &amp; Poziții Deschise</div>
                                      <div className="text-xs font-mono mt-0.5">
                                        <span className="text-cyan-300 font-bold">
                                          Scor: {ord.signalScore !== undefined ? `${ord.signalScore.toFixed(1)}/100` : '--'}
                                        </span>
                                        <span className="text-zinc-400 block text-[11px]">
                                          Simultan deschise: <strong className="text-amber-300">{ord.openPositionsCount !== undefined ? ord.openPositionsCount : '--'}</strong>
                                        </span>
                                      </div>
                                    </div>

                                    <div className="bg-black/60 border border-zinc-800 p-2 rounded">
                                      <div className="text-[10px] text-zinc-400 uppercase">Echitate &amp; Balanță la Ordin</div>
                                      <div className="text-xs font-mono mt-0.5">
                                        <span className="text-emerald-300 font-bold">
                                          Eq: ${ord.accountEquity !== undefined ? ord.accountEquity.toFixed(2) : '--'}
                                        </span>
                                        <span className="text-zinc-400 block text-[11px]">
                                          Bal: ${ord.accountBalance !== undefined ? ord.accountBalance.toFixed(2) : '--'}
                                        </span>
                                      </div>
                                    </div>
                                    
                                    {(ord.marketRegime || ord.exitMarketRegime) && (
                                      <div className="bg-black/60 border border-zinc-800 p-2 rounded col-span-2 sm:col-span-4 mt-1">
                                        <div className="text-[10px] text-zinc-400 uppercase">Regim BTC Macro (Intrare vs Ieșire)</div>
                                        <div className="text-xs font-mono text-amber-300 mt-0.5 flex flex-wrap gap-4">
                                          <span>Regim la Intrare: <strong className="text-zinc-100">{ord.marketRegime || 'BTC: --'}</strong></span>
                                          {ord.exitMarketRegime && (
                                            <span>Regim la Ieșire: <strong className="text-zinc-100">{ord.exitMarketRegime}</strong></span>
                                          )}
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
                    }))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {activeScreen === 'SET' && (
            <div className="bg-zinc-950 border border-amber-500/30 rounded p-2 sm:p-3 flex flex-col flex-1 min-h-0">
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

              {/* ACTIVE RUNNING VALUES BANNER (ALL ACTIVE RULES IN REAL-TIME) */}
              <div className="bg-zinc-950 border border-amber-500/50 rounded p-3 mb-4 font-mono shadow-md">
                <div className="flex flex-wrap items-center justify-between border-b border-amber-500/20 pb-2 mb-2.5 gap-2">
                  <div className="text-amber-300 font-bold flex items-center space-x-2 text-xs">
                    <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 inline-block animate-pulse"></span>
                    <span>VALORI ACTIVE ÎN TIMP REAL (TOATE REGULILE CU CARE CALCULEAZĂ BOTUL):</span>
                  </div>
                  <div className="flex items-center space-x-2 text-[10px]">
                    <span className="px-2 py-0.5 rounded font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40">
                      PROFIL: {status?.currentProfile || 'SCALP'}
                    </span>
                    <span className="px-2 py-0.5 rounded font-bold bg-zinc-900 text-zinc-300 border border-zinc-700">
                      MOD: {status?.executionMode || 'PAPER'}
                    </span>
                  </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 text-[11px]">
                  <div className="bg-black/60 border border-zinc-800 rounded px-2.5 py-1.5">
                    <span className="text-slate-400 block text-[9px] uppercase">Risc / Trade</span>
                    <strong className="text-amber-400 text-xs">{profileConfig?.riskPerTradePct ?? 10}%</strong>
                  </div>
                  <div className="bg-black/60 border border-zinc-800 rounded px-2.5 py-1.5">
                    <span className="text-slate-400 block text-[9px] uppercase">Max Poziții</span>
                    <strong className="text-zinc-200 text-xs">{profileConfig?.maxOpenPositions ?? 5} sloturi</strong>
                  </div>
                  <div className="bg-black/60 border border-zinc-800 rounded px-2.5 py-1.5">
                    <span className="text-slate-400 block text-[9px] uppercase">Hard Stop-Loss</span>
                    <strong className="text-rose-400 text-xs">-{profileConfig?.hardStopLossPct ?? 20.0}%</strong>
                  </div>
                  <div className="bg-black/60 border border-zinc-800 rounded px-2.5 py-1.5">
                    <span className="text-slate-400 block text-[9px] uppercase">Break-Even Act</span>
                    <strong className="text-amber-300 text-xs">+{profileConfig?.breakEvenActivationPct ?? 5.0}%</strong>
                  </div>
                  <div className="bg-black/60 border border-zinc-800 rounded px-2.5 py-1.5">
                    <span className="text-slate-400 block text-[9px] uppercase">Trailing Act</span>
                    <strong className="text-emerald-400 text-xs">+{profileConfig?.trailingActivationPct ?? 1.1}%</strong>
                  </div>
                  <div className="bg-black/60 border border-zinc-800 rounded px-2.5 py-1.5">
                    <span className="text-slate-400 block text-[9px] uppercase">Trailing Dist</span>
                    <strong className="text-purple-400 text-xs">-{profileConfig?.trailingDistancePct ?? 0.35}%</strong>
                  </div>

                  <div className="bg-black/60 border border-zinc-800 rounded px-2.5 py-1.5">
                    <span className="text-slate-400 block text-[9px] uppercase">Take-Profit</span>
                    <strong className="text-emerald-400 text-xs">
                      {!profileConfig?.takeProfitPct || profileConfig.takeProfitPct === 0 ? 'OFF (Trailing)' : `+${profileConfig.takeProfitPct}%`}
                    </strong>
                  </div>
                  <div className="bg-black/60 border border-zinc-800 rounded px-2.5 py-1.5">
                    <span className="text-slate-400 block text-[9px] uppercase">Max Hold Time</span>
                    <strong className="text-amber-300 text-xs">{profileConfig?.maxHoldingTimeMinutes ?? 45} min</strong>
                  </div>
                  <div className="bg-black/60 border border-zinc-800 rounded px-2.5 py-1.5">
                    <span className="text-slate-400 block text-[9px] uppercase">Stagnation Stop</span>
                    <strong className="text-cyan-300 text-xs">
                      {profileConfig?.stagnationTimeMinutes && profileConfig.stagnationTimeMinutes > 0 ? `${profileConfig.stagnationTimeMinutes} min` : 'OFF (0m)'}
                    </strong>
                  </div>
                  <div className="bg-black/60 border border-zinc-800 rounded px-2.5 py-1.5">
                    <span className="text-slate-400 block text-[9px] uppercase">Equity Prot Act</span>
                    <strong className="text-cyan-400 text-xs">
                      {!profileConfig?.equityProtectionActivationPct ? 'OFF (0%)' : `+${profileConfig.equityProtectionActivationPct}%`}
                    </strong>
                  </div>
                  <div className="bg-black/60 border border-zinc-800 rounded px-2.5 py-1.5">
                    <span className="text-slate-400 block text-[9px] uppercase">Equity Trailing DD</span>
                    <strong className="text-rose-400 text-xs">
                      {!profileConfig?.equityTrailingDrawdownPct ? 'OFF (0%)' : `-${profileConfig.equityTrailingDrawdownPct}%`}
                    </strong>
                  </div>
                  <div className="bg-black/60 border border-zinc-800 rounded px-2.5 py-1.5">
                    <span className="text-slate-400 block text-[9px] uppercase">Fereastră Momentum</span>
                    <strong className="text-cyan-400 text-xs">
                      [{profileConfig?.minMomentumScore ?? 50} - {profileConfig?.maxMomentumScore ?? 99}]
                    </strong>
                  </div>
                  <div className="bg-black/60 border border-zinc-800 rounded px-2.5 py-1.5">
                    <span className="text-slate-400 block text-[9px] uppercase">Fereastră Volum 24h</span>
                    <strong className="text-emerald-400 text-xs">
                      [{(profileConfig?.min24hVolumeUSDT ? profileConfig.min24hVolumeUSDT / 1_000_000 : 0.5).toFixed(1)}M - {profileConfig?.max24hVolumeUSDT && profileConfig.max24hVolumeUSDT > 0 ? (profileConfig.max24hVolumeUSDT / 1_000_000).toFixed(1) + 'M' : '∞'}]
                    </strong>
                  </div>
                  <div className="bg-black/60 border border-zinc-800 rounded px-2.5 py-1.5">
                    <span className="text-slate-400 block text-[9px] uppercase">Cooldown Simbol</span>
                    <strong className="text-zinc-300 text-xs">{profileConfig?.cooldownMinutes ?? 5} min</strong>
                  </div>
                </div>

                <div className="mt-2.5 pt-2 border-t border-zinc-900 flex flex-wrap items-center justify-between text-[10px] text-zinc-400 gap-2">
                  <div className="flex items-center space-x-2">
                    <span>Prag Clasificare Sentiment OKX: <strong className="text-amber-300">±{profileConfig?.sentimentThreshold ?? 1.5}%</strong></span>
                    <span>•</span>
                    <span>Timeframes: <strong className="text-zinc-200">{profileConfig?.timeframes?.join(', ') || '15m, 1h'}</strong></span>
                  </div>
                  <div className="text-zinc-500">
                    Modificările glisoarelor de mai jos devin active după apăsarea butonului <strong>SAVE CHANGES</strong>.
                  </div>
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

                  {/* Min Momentum Score */}
                  <div className="bg-zinc-900 p-3 rounded border border-amber-500/20 space-y-2">
                    <div className="flex justify-between items-center">
                      <span className="text-slate-300">Min Momentum Score (Prag Inferior)</span>
                      <span className="font-bold text-amber-400">{minMomentum} / 100</span>
                    </div>
                    <input
                      type="range"
                      min="50"
                      max="85"
                      step="1"
                      value={minMomentum}
                      onChange={(e) => setMinMomentum(Number(e.target.value))}
                      className="w-full accent-amber-500 cursor-pointer"
                    />
                    <div className="flex justify-between text-[10px] text-zinc-400">
                      <span>Min: 50</span>
                      <span className="text-amber-300 font-semibold">Fereastră Semnale: [{minMomentum} - {maxMomentum}]</span>
                      <span>Max: 85</span>
                    </div>
                  </div>

                  {/* Max Momentum Score */}
                  <div className="bg-zinc-900 p-3 rounded border border-amber-500/20 space-y-2">
                    <div className="flex justify-between items-center">
                      <span className="text-slate-300">Max Momentum Score (Tavan Superior / Anti-Exhaustion)</span>
                      <span className="font-bold text-cyan-400">{maxMomentum} / 100</span>
                    </div>
                    <input
                      type="range"
                      min="70"
                      max="99"
                      step="1"
                      value={maxMomentum}
                      onChange={(e) => setMaxMomentum(Number(e.target.value))}
                      className="w-full accent-cyan-500 cursor-pointer"
                    />
                    <div className="flex justify-between text-[10px] text-zinc-400">
                      <span>Min: 70</span>
                      <span className="text-cyan-300 font-semibold">Elimină semnalele peste {maxMomentum} (prea extinse)</span>
                      <span>Max: 99</span>
                    </div>
                  </div>

                  {/* Min 24h Turnover (Prag Inferior Volum) */}
                  <div className="bg-zinc-900 p-3 rounded border border-emerald-500/20 space-y-2">
                    <div className="flex justify-between items-center">
                      <span className="text-slate-300">Min 24h Turnover (Prag Volum Inferior)</span>
                      <div className="flex items-center gap-1.5">
                        <input
                          type="number"
                          min="0.05"
                          max="50"
                          step="0.1"
                          value={min24hVol}
                          onChange={(e) => setMin24hVol(Math.max(0.05, parseFloat(e.target.value) || 0.1))}
                          className="w-16 px-1.5 py-0.5 bg-zinc-800 border border-zinc-700 rounded text-emerald-400 font-bold text-right text-xs"
                        />
                        <span className="font-bold text-emerald-400">M USDT</span>
                      </div>
                    </div>
                    <input
                      type="range"
                      min="0.1"
                      max="20"
                      step="0.1"
                      value={min24hVol}
                      onChange={(e) => setMin24hVol(Number(e.target.value))}
                      className="w-full accent-emerald-500 cursor-pointer"
                    />
                    <div className="flex justify-between text-[10px] text-zinc-400">
                      <span>Min: 0.1M</span>
                      <span className="text-emerald-300 font-semibold">
                        Fereastră Volum: [{min24hVol.toFixed(1)}M - {max24hVol > 0 ? `${max24hVol.toFixed(1)}M` : 'Nelimitat'}]
                      </span>
                      <span>Max: 20M</span>
                    </div>
                  </div>

                  {/* Max 24h Turnover (Tavan Superior Volum) */}
                  <div className="bg-zinc-900 p-3 rounded border border-emerald-500/20 space-y-2">
                    <div className="flex justify-between items-center">
                      <span className="text-slate-300">Max 24h Turnover (Tavan Volum Superior)</span>
                      <div className="flex items-center gap-1.5">
                        <input
                          type="number"
                          min="0"
                          max="100"
                          step="0.1"
                          value={max24hVol}
                          onChange={(e) => setMax24hVol(Math.max(0, parseFloat(e.target.value) || 0))}
                          className="w-16 px-1.5 py-0.5 bg-zinc-800 border border-zinc-700 rounded text-cyan-400 font-bold text-right text-xs"
                        />
                        <span className="font-bold text-cyan-400">M USDT</span>
                      </div>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="20"
                      step="0.1"
                      value={max24hVol}
                      onChange={(e) => setMax24hVol(Number(e.target.value))}
                      className="w-full accent-cyan-500 cursor-pointer"
                    />
                    <div className="flex justify-between text-[10px] text-zinc-400">
                      <span>0 = Nelimitat</span>
                      <span className="text-cyan-300 font-semibold">
                        {max24hVol > 0 ? `Exclude monedele cu rulaj > ${max24hVol.toFixed(1)}M USDT` : 'Fără limită superioară (0 = Any)'}
                      </span>
                      <span>Max: 20M</span>
                    </div>
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

                  {/* Stagnation Time-Stop - step 5 */}
                  <div className="bg-zinc-900 p-3 rounded border border-cyan-500/20 space-y-2">
                    <div className="flex justify-between items-center">
                      <span className="text-slate-300">Stagnation Time-Stop (Min)</span>
                      <span className={`font-bold ${stagnationTime === 0 ? 'text-zinc-400' : 'text-cyan-400'}`}>
                        {stagnationTime === 0 ? 'DEZACTIVAT (0m)' : `${stagnationTime}m`}
                      </span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="120"
                      step="5"
                      value={stagnationTime}
                      onChange={(e) => setStagnationTime(Number(e.target.value))}
                      className="w-full accent-cyan-500 cursor-pointer"
                    />
                    <div className="text-[10px] text-zinc-500">
                      Setează 0 pentru a dezactiva ieșirea la stagnare și a lăsa tranzacția să ruleze până la Max Hold Time ({maxHoldTime}m).
                    </div>
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

                  {/* Global Sentiment Classification Threshold - step 0.1 */}
                  <div className="bg-zinc-900 p-3 rounded border border-amber-500/20 space-y-2">
                    <div className="flex justify-between items-center">
                      <span className="text-slate-300">Prag Afișare Sentiment Global (OKX)</span>
                      <span className="font-bold text-amber-300">±{Number(sentimentThreshold).toFixed(1)}%</span>
                    </div>
                    <input
                      type="range"
                      min="0.5"
                      max="5.0"
                      step="0.1"
                      value={sentimentThreshold}
                      onChange={(e) => setSentimentThreshold(Number(e.target.value))}
                      className="w-full accent-amber-500 cursor-pointer"
                    />
                    <div className="text-[10px] text-zinc-500">
                      Stabilește pragul procentual folosit pentru clasificarea și afișarea stării pieței (BULLISH / BEARISH / NEUTRAL). Alertele și mesajele automate au fost deconectate.
                    </div>
                  </div>

                  {/* 🛡️ Regim BTC Guard pentru SELL / SHORT (shortRegimeGuard) */}
                  <div className="bg-zinc-900 p-3 rounded border border-indigo-500/30 space-y-2">
                    <div className="flex justify-between items-center">
                      <div className="flex items-center space-x-1.5">
                        <span className="text-slate-200 font-bold text-xs">Garda SELL / SHORT (shortRegimeGuard)</span>
                      </div>
                      <span className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold ${
                        shortRegimeGuard === 'DISABLED'
                          ? 'bg-rose-950 text-rose-300 border border-rose-600/50'
                          : shortRegimeGuard === 'OFF'
                          ? 'bg-amber-950 text-amber-300 border border-amber-600/50'
                          : 'bg-indigo-950 text-indigo-300 border border-indigo-600/50'
                      }`}>
                        {shortRegimeGuard === 'DISABLED' ? '🚫 OPRIT (DISABLED)' : shortRegimeGuard === 'OFF' ? '⚡ OFF (Permite Oricând)' : '🐻 BEAR ONLY'}
                      </span>
                    </div>
                    <div className="grid grid-cols-3 gap-1.5 pt-1">
                      <button
                        type="button"
                        onClick={() => {
                          setShortRegimeGuard('OFF');
                          onUpdateProfileSettings(activeProfile, { shortRegimeGuard: 'OFF' });
                        }}
                        className={`py-1.5 px-2 rounded text-[11px] font-bold border transition-all ${
                          shortRegimeGuard === 'OFF'
                            ? 'bg-amber-600/30 border-amber-500 text-amber-200 shadow'
                            : 'bg-zinc-800/80 border-zinc-700 text-zinc-400 hover:text-zinc-200'
                        }`}
                      >
                        OFF (Oricând)
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setShortRegimeGuard('BEAR_ONLY');
                          onUpdateProfileSettings(activeProfile, { shortRegimeGuard: 'BEAR_ONLY' });
                        }}
                        className={`py-1.5 px-2 rounded text-[11px] font-bold border transition-all ${
                          shortRegimeGuard === 'BEAR_ONLY'
                            ? 'bg-indigo-600/30 border-indigo-500 text-indigo-200 shadow'
                            : 'bg-zinc-800/80 border-zinc-700 text-zinc-400 hover:text-zinc-200'
                        }`}
                      >
                        BEAR ONLY
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setShortRegimeGuard('DISABLED');
                          onUpdateProfileSettings(activeProfile, { shortRegimeGuard: 'DISABLED' });
                        }}
                        className={`py-1.5 px-2 rounded text-[11px] font-bold border transition-all ${
                          shortRegimeGuard === 'DISABLED'
                            ? 'bg-rose-600/30 border-rose-500 text-rose-200 shadow'
                            : 'bg-zinc-800/80 border-zinc-700 text-zinc-400 hover:text-zinc-200'
                        }`}
                      >
                        DISABLED (Fără Short)
                      </button>
                    </div>
                    <div className="text-[10px] text-zinc-400 leading-tight">
                      {shortRegimeGuard === 'DISABLED'
                        ? 'Pozițiile SELL/SHORT sunt complet blocate pentru a proteja capitalul de scăderi asimetrice.'
                        : shortRegimeGuard === 'BEAR_ONLY'
                        ? 'Semnalele SELL sunt permise doar când Bitcoin este în regim BEAR.'
                        : 'Semnalele SELL sunt permise oricând (Garda dezactivată).'}
                    </div>

                    {/* Prag minim ridicat scor momentum pentru SHORT */}
                    <div className="pt-2 border-t border-zinc-800 space-y-1">
                      <div className="flex justify-between items-center">
                        <span className="text-zinc-300 text-[11px]">Prag Minim Scor SHORT (Filtru Declanșare)</span>
                        <span className="font-bold text-indigo-300 text-[11px]">
                          {minShortScore === 0 ? 'Dezactivat (Scor Standard)' : `>= ${minShortScore}`}
                        </span>
                      </div>
                      <input
                        type="range"
                        min="0"
                        max="95"
                        step="5"
                        value={minShortScore}
                        onChange={(e) => setMinShortScore(Number(e.target.value))}
                        className="w-full accent-indigo-500 cursor-pointer"
                      />
                      <div className="text-[9px] text-zinc-500">
                        Setează un prag ridicat (ex: 80-85) pentru a evita declanșarea pozițiilor SHORT pe semnale slabe/zgomot.
                      </div>
                    </div>

                    {/* 🛡️ Regim BTC Guard pentru LONG (btcBearGuard) */}
                    <div className="pt-2 border-t border-zinc-800 space-y-1.5">
                      <div className="flex justify-between items-center">
                        <span className="text-slate-200 font-bold text-xs">Garda LONG în BTC BEAR (btcBearGuard)</span>
                        <button
                          type="button"
                          onClick={() => {
                            const nextVal = !btcBearGuard;
                            setBtcBearGuard(nextVal);
                            onUpdateProfileSettings(activeProfile, { btcBearGuard: nextVal });
                          }}
                          className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold border transition-colors cursor-pointer ${
                            btcBearGuard
                              ? 'bg-amber-950 text-amber-300 border-amber-600/50 shadow'
                              : 'bg-zinc-800 text-zinc-400 border-zinc-700 hover:text-zinc-200'
                          }`}
                        >
                          {btcBearGuard ? '🛡️ ACTIVAT (Blochează LONG scor < 68)' : '⚡ OFF (Permite LONG Oricând)'}
                        </button>
                      </div>
                      <div className="text-[10px] text-zinc-400 leading-tight">
                        {btcBearGuard
                          ? 'Când Bitcoin este în regim BEAR, pozițiile LONG sunt blocate dacă scorul este sub 68.'
                          : 'Garda este DEZACTIVATĂ. Semnalele LONG sunt permise oricând conform scorului standard (fără blocare BTC BEAR).'}
                      </div>
                    </div>
                  </div>

                  {/* ⏱️ Plafon Intrări/Simbol/Oră (maxEntriesPerSymbolPerHour) */}
                  <div className="bg-zinc-900 p-3 rounded border border-cyan-500/20 space-y-2">
                    <div className="flex justify-between items-center">
                      <span className="text-slate-300 text-xs">Plafon Intrări/Simbol/Oră</span>
                      <span className="font-bold text-cyan-400 text-xs">
                        {maxEntriesPerHour === 0 ? 'Dezactivat (0)' : `${maxEntriesPerHour} intrări/oră`}
                      </span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="10"
                      step="1"
                      value={maxEntriesPerHour}
                      onChange={(e) => setMaxEntriesPerHour(Number(e.target.value))}
                      className="w-full accent-cyan-500 cursor-pointer"
                    />
                    <div className="text-[10px] text-zinc-500">
                      Limitează câte poziții noi pot fi deschise pe același simbol într-o fereastră de 60 min. (0 = nelimitat, implicit 3).
                    </div>
                  </div>

                  {/* 🧊 Pauză Post-Pierdere / SL pe Simbol (cooldownAfterLossMinutes) */}
                  <div className="bg-zinc-900 p-3 rounded border border-rose-500/20 space-y-2">
                    <div className="flex justify-between items-center">
                      <span className="text-slate-300 text-xs">Pauză după Pierdere / SL (Simbol)</span>
                      <span className="font-bold text-rose-400 text-xs">
                        {cooldownAfterLoss === 0 ? 'Dezactivat (0)' : `${cooldownAfterLoss} min`}
                      </span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="120"
                      step="5"
                      value={cooldownAfterLoss}
                      onChange={(e) => setCooldownAfterLoss(Number(e.target.value))}
                      className="w-full accent-rose-500 cursor-pointer"
                    />
                    <div className="text-[10px] text-zinc-500">
                      Timp de așteptare impus pe un simbol după o tranzacție închisă pe pierdere sau Stop-Loss (0 = dezactivat, implicit 30 min).
                    </div>
                  </div>
                </div>
              )}

              {/* ========================================================================= */}
              {/* 🎛️ EXECUTION MODE & OKX CONNECTION DESK (3-WAY SWITCH, KEYS, TEST PING) */}
              {/* ========================================================================= */}
              <div className="bg-zinc-950 border-2 border-amber-500/60 rounded p-4 mt-4 shadow-lg space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-amber-500/20 pb-3">
                  <div className="flex items-center space-x-2">
                    <div className="p-1.5 bg-amber-500/10 rounded border border-amber-500/30">
                      <Key className="w-4 h-4 text-amber-400" />
                    </div>
                    <div>
                      <h3 className="text-amber-400 font-bold text-sm tracking-wider flex items-center space-x-2">
                        <span>CONEXIUNE OKX &amp; MOD DE EXECUȚIE</span>
                        <span className={`px-2 py-0.2 rounded text-[10px] font-mono border ${
                          status?.executionMode === 'LIVE'
                            ? 'bg-rose-950 text-rose-300 border-rose-500 animate-pulse'
                            : status?.executionMode === 'TESTNET'
                            ? 'bg-amber-950 text-amber-300 border-amber-500'
                            : 'bg-emerald-950 text-emerald-300 border-emerald-500'
                        }`}>
                          MOD ACTIV: {status?.executionMode || 'PAPER'}
                        </span>
                      </h3>
                      <p className="text-[11px] text-zinc-400">
                        Comută între simulare fără risc, OKX Demo (Testnet) și OKX Live (cont real cu fonduri reale).
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center space-x-2">
                    <button
                      onClick={() => handleRunOKXTest()}
                      disabled={isTestingOKX}
                      className="px-3 py-1.5 bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-amber-300 rounded text-xs font-bold flex items-center space-x-1.5 transition-all disabled:opacity-50"
                      title="Verifică conexiunea REST API și autentificarea pe OKX"
                    >
                      <Wifi className={`w-3.5 h-3.5 ${isTestingOKX ? 'animate-pulse text-amber-400' : ''}`} />
                      <span>{isTestingOKX ? 'SE TESTEAZĂ...' : 'TESTEAZĂ PING OKX'}</span>
                    </button>
                  </div>
                </div>

                {/* 3-WAY SEGMENTED MODE SELECTOR */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  {/* OPTION 1: PAPER */}
                  <div
                    onClick={() => handleSwitchExecutionModeWithCheck('PAPER')}
                    className={`cursor-pointer p-3 rounded border transition-all flex flex-col justify-between ${
                      status?.executionMode === 'PAPER'
                        ? 'bg-emerald-950/40 border-emerald-500 shadow-md shadow-emerald-950/50 ring-1 ring-emerald-500'
                        : 'bg-zinc-900/60 border-zinc-800 hover:border-emerald-500/50 hover:bg-zinc-900'
                    }`}
                  >
                    <div className="space-y-1.5 mb-3">
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-xs text-emerald-400 flex items-center space-x-1.5">
                          <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 inline-block"></span>
                          <span>1. SIMULARE PAPER</span>
                        </span>
                        {status?.executionMode === 'PAPER' && (
                          <span className="text-[10px] bg-emerald-950 text-emerald-300 px-1.5 py-0.2 rounded border border-emerald-600/60 font-bold">
                            ACTIV
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-zinc-300 leading-relaxed">
                        Execuție locală fără risc. Capital virtual $200.00 USDT, prețuri reale în timp real din feed-ul OKX, simulare slippage și comisioane 0.05%.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleSwitchExecutionModeWithCheck('PAPER');
                      }}
                      className={`w-full py-1 rounded text-xs font-bold transition-all ${
                        status?.executionMode === 'PAPER'
                          ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/50 cursor-default'
                          : 'bg-zinc-800 hover:bg-emerald-600 hover:text-black text-zinc-300'
                      }`}
                    >
                      {status?.executionMode === 'PAPER' ? '✓ MOD CURENT ACTIV' : 'COMUTĂ LA PAPER'}
                    </button>
                  </div>

                  {/* OPTION 2: OKX LIVE (REAL) */}
                  <div
                    onClick={() => handleSwitchExecutionModeWithCheck('LIVE')}
                    className={`cursor-pointer p-3 rounded border transition-all flex flex-col justify-between ${
                      status?.executionMode === 'LIVE'
                        ? 'bg-rose-950/40 border-rose-500 shadow-md shadow-rose-950/50 ring-1 ring-rose-500'
                        : 'bg-zinc-900/60 border-zinc-800 hover:border-rose-500/50 hover:bg-zinc-900'
                    }`}
                  >
                    <div className="space-y-1.5 mb-3">
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-xs text-rose-400 flex items-center space-x-1.5">
                          <span className="w-2.5 h-2.5 rounded-full bg-rose-500 inline-block animate-ping"></span>
                          <span>2. OKX LIVE (CONT REAL)</span>
                        </span>
                        {status?.executionMode === 'LIVE' && (
                          <span className="text-[10px] bg-rose-950 text-rose-300 px-1.5 py-0.2 rounded border border-rose-600/60 font-bold animate-pulse">
                            LIVE REAL
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-zinc-300 leading-relaxed">
                        Execuție de ordine reale pe bursa <strong>OKX X-Perps / Perpetuals</strong> cu fonduri reale din cont. Necesită chei API cu permisiuni de tranzacționare.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleSwitchExecutionModeWithCheck('LIVE');
                      }}
                      className={`w-full py-1 rounded text-xs font-bold transition-all ${
                        status?.executionMode === 'LIVE'
                          ? 'bg-rose-500/20 text-rose-300 border border-rose-500/50 cursor-default'
                          : 'bg-zinc-800 hover:bg-rose-600 hover:text-white text-zinc-300'
                      }`}
                    >
                      {status?.executionMode === 'LIVE' ? '✓ MOD LIVE ACTIV' : 'COMUTĂ LA OKX LIVE (REAL)'}
                    </button>
                  </div>
                </div>

                {/* OKX CREDENTIALS CONFIGURATION & TEST ACCORDION / CARD */}
                <div className="bg-black/90 p-3.5 rounded border border-amber-500/30 space-y-3">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <span className="text-amber-400 font-bold text-xs flex items-center space-x-2">
                      <Key className="w-3.5 h-3.5 text-amber-400" />
                      <span>CONFIGURARE CHEI API OKX (PENTRU TESTNET ȘI LIVE)</span>
                    </span>
                    <span className="text-[11px] text-zinc-400 font-mono">
                      Stare Server: {status?.config?.okxApiKey ? '🟢 CHEI CONFIGURATE' : '⚪ CHEI LIPSĂ (SAU ÎN MEDIU)'}
                    </span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                    <div>
                      <label className="block text-zinc-400 text-[10px] mb-1 font-mono">OKX_API_KEY</label>
                      <input
                        type="text"
                        value={okxKeyInput}
                        onChange={(e) => setOkxKeyInput(e.target.value)}
                        placeholder="Cheie API OKX (ex: 81a9f4...)"
                        className="w-full bg-zinc-950 text-amber-300 border border-zinc-800 rounded px-2.5 py-1.5 text-xs font-mono focus:outline-none focus:border-amber-400"
                      />
                    </div>
                    <div>
                      <label className="block text-zinc-400 text-[10px] mb-1 font-mono">OKX_SECRET_KEY</label>
                      <input
                        type="password"
                        value={okxSecretInput}
                        onChange={(e) => setOkxSecretInput(e.target.value)}
                        placeholder="Secret Key OKX..."
                        className="w-full bg-zinc-950 text-amber-300 border border-zinc-800 rounded px-2.5 py-1.5 text-xs font-mono focus:outline-none focus:border-amber-400"
                      />
                    </div>
                    <div>
                      <label className="block text-zinc-400 text-[10px] mb-1 font-mono">OKX_PASSPHRASE</label>
                      <input
                        type="password"
                        value={okxPassphraseInput}
                        onChange={(e) => setOkxPassphraseInput(e.target.value)}
                        placeholder="Passphrase OKX..."
                        className="w-full bg-zinc-950 text-amber-300 border border-zinc-800 rounded px-2.5 py-1.5 text-xs font-mono focus:outline-none focus:border-amber-400"
                      />
                    </div>
                  </div>

                  <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 pt-1 border-t border-zinc-900">
                    <label className="flex items-center space-x-2 text-xs text-zinc-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={okxTestnetInput}
                        onChange={(e) => setOkxTestnetInput(e.target.checked)}
                        className="accent-amber-500 cursor-pointer"
                      />
                      <span>Activează header-ul <code>x-simulated-trading: 1</code> (Mod Simulated / Demo)</span>
                    </label>

                    <div className="flex items-center space-x-2 w-full sm:w-auto">
                      <button
                        onClick={() => handleRunOKXTest()}
                        disabled={isTestingOKX}
                        className="px-3 py-1.5 bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-300 rounded text-xs font-bold flex items-center space-x-1.5 disabled:opacity-50"
                      >
                        <Wifi className="w-3.5 h-3.5 text-amber-400" />
                        <span>{isTestingOKX ? 'TESTARE...' : 'TESTEAZĂ CHEI'}</span>
                      </button>

                      <button
                        onClick={handleSaveOKXCredentials}
                        disabled={isSavingOKX || !okxKeyInput || !okxSecretInput}
                        className="px-4 py-1.5 bg-amber-500 hover:bg-amber-400 text-black rounded text-xs font-bold flex items-center space-x-1.5 disabled:opacity-40 disabled:cursor-not-allowed shadow-md"
                      >
                        <Save className="w-3.5 h-3.5" />
                        <span>{isSavingOKX ? 'SALVARE...' : 'SALVEAZĂ CHEI PE BOT'}</span>
                      </button>
                    </div>
                  </div>

                  {okxSaveMessage && (
                    <div className="p-2 rounded bg-zinc-900 border border-amber-500/40 text-xs font-mono text-amber-300">
                      {okxSaveMessage}
                    </div>
                  )}

                  {/* Test Feedback Display */}
                  {okxTestFeedback && okxTestFeedback.tested && (
                    <div className={`p-2.5 rounded border text-xs font-mono space-y-1 ${
                      okxTestFeedback.authenticated
                        ? 'bg-emerald-950/50 border-emerald-500/50 text-emerald-300'
                        : okxTestFeedback.reachable
                        ? 'bg-amber-950/50 border-amber-500/50 text-amber-300'
                        : 'bg-rose-950/50 border-rose-500/50 text-rose-300'
                    }`}>
                      <div className="font-bold flex items-center space-x-2">
                        {okxTestFeedback.authenticated ? (
                          <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                        ) : (
                          <AlertTriangle className="w-4 h-4 text-amber-400" />
                        )}
                        <span>REZULTAT TEST CONEXIUNE OKX:</span>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-1 text-[11px]">
                        <div>• Ping Rețea: <strong>{okxTestFeedback.reachable ? '✅ CONECTAT' : '❌ INACCESIBIL'}</strong></div>
                        <div>• Autentificare Chei: <strong>{okxTestFeedback.authenticated ? '✅ VALIDE' : '❌ EȘUATĂ / NEAUTORIZAT'}</strong></div>
                        <div>• Sold Detectat: <strong>{okxTestFeedback.equity !== undefined ? `$${okxTestFeedback.equity.toFixed(2)} USDT` : '--'}</strong></div>
                      </div>
                      {okxTestFeedback.error && (
                        <div className="text-[11px] text-rose-300 pt-1">
                          ⚠️ Detalii eroare: {okxTestFeedback.error}
                        </div>
                      )}
                    </div>
                  )}

                  <div className="text-[11px] text-zinc-400 leading-relaxed pt-1">
                    💡 <strong>Configurare Permanentă Server:</strong> Poți seta cheile o singură dată în variabilele de mediu (Cloud Run / fișier <code>.env</code>):
                    <code className="ml-1 text-amber-400">OKX_API_KEY</code>, <code className="text-amber-400">OKX_SECRET_KEY</code>, <code className="text-amber-400">OKX_PASSPHRASE</code>. Botul le va detecta și încărca automat la pornire!
                  </div>
                </div>

                {/* TELEGRAM CREDENTIALS CONFIGURATION CARD */}
                {renderTelegramConfigCard()}
              </div>

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

          {activeScreen === 'INFO' && (
            <div className="bg-zinc-950 border border-amber-500/30 rounded p-2 sm:p-3 flex flex-col flex-1 min-h-0 space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between border-b border-amber-500/30 pb-2 gap-2">
                <div className="flex items-center space-x-2">
                  <Info className="w-4 h-4 text-amber-500" />
                  <span className="font-bold text-sm tracking-wider">F6: TELEGRAM ALERTS &amp; BOT OPERATIONAL HUB</span>
                </div>
                <div className="flex items-center space-x-2">
                  <span className={`px-2 py-0.5 rounded text-xs font-bold font-mono border ${
                    status?.telegramActive
                      ? 'bg-sky-950/80 text-sky-300 border-sky-500'
                      : 'bg-zinc-900 text-zinc-400 border-zinc-700'
                  }`}>
                    {status?.telegramActive ? '● TELEGRAM: CONECTAT & ACTIV' : '○ TELEGRAM: STANDBY'}
                  </span>
                </div>
              </div>

              {/* Telegram Credentials Configuration Section */}
              {renderTelegramConfigCard()}

              {/* Telegram Integration Overview Card */}
              <div className="bg-black border border-sky-500/30 rounded p-3 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-2 text-sky-400 font-bold text-xs">
                    <Send className="w-4 h-4" />
                    <span>ALERTE TELEGRAM NON-BLOCKING (ORARE &amp; EVENIMENTE CRITICE)</span>
                  </div>
                  <span className="text-[10px] bg-sky-950 text-sky-300 px-2 py-0.5 rounded border border-sky-800 font-mono">
                    ASYNC PROTOCOL
                  </span>
                </div>
                <p className="text-xs text-zinc-300 leading-relaxed">
                  Alertele Telegram rulează pe un fir de execuție complet asincron, garantând conform cerinței că procesul de scanare și tranzacționare al botului <strong>nu este niciodată influențat sau blocat</strong> de rețeaua Telegram.
                </p>

                {/* Quick Test Action Buttons */}
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <button
                    onClick={async () => {
                      setTelegramTesting(true);
                      try {
                        const token = localStorage.getItem('tb5_control_token') || 'tradebot5_admin_token';
                        const res = await fetch('/api/bot/telegram/test', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json', 'x-bot-token': token },
                          body: JSON.stringify({ type: 'hourly' }),
                        });
                        const data = await res.json();
                        if (data.success) {
                          setTelegramStatusMsg('Raport orar transmis cu succes pe Telegram!');
                        } else {
                          setTelegramStatusMsg('Eroare Telegram: ' + (data.error || 'Verifică BOT_TOKEN/CHAT_ID'));
                        }
                      } catch (e: any) {
                        setTelegramStatusMsg('Eroare la trimiterea raportului orar');
                      } finally {
                        setTelegramTesting(false);
                        setTimeout(() => setTelegramStatusMsg(null), 4000);
                      }
                    }}
                    disabled={telegramTesting}
                    className="px-3 py-1.5 bg-sky-950 hover:bg-sky-900 border border-sky-500/50 text-sky-200 rounded text-xs font-bold flex items-center space-x-1.5 disabled:opacity-50"
                  >
                    <Send className="w-3.5 h-3.5" />
                    <span>TRIMITE RAPORT ORAR (TEST)</span>
                  </button>

                  <button
                    onClick={async () => {
                      setTelegramTesting(true);
                      try {
                        const token = localStorage.getItem('tb5_control_token') || 'tradebot5_admin_token';
                        const res = await fetch('/api/bot/telegram/test', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json', 'x-bot-token': token },
                          body: JSON.stringify({ type: 'daily' }),
                        });
                        const data = await res.json();
                        if (data.success) {
                          setTelegramStatusMsg('Rezumat zilnic transmis cu succes pe Telegram!');
                        } else {
                          setTelegramStatusMsg('Eroare Telegram: ' + (data.error || 'Verifică BOT_TOKEN/CHAT_ID'));
                        }
                      } catch (e: any) {
                        setTelegramStatusMsg('Eroare la trimiterea rezumatului zilnic');
                      } finally {
                        setTelegramTesting(false);
                        setTimeout(() => setTelegramStatusMsg(null), 4000);
                      }
                    }}
                    disabled={telegramTesting}
                    className="px-3 py-1.5 bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-amber-300 rounded text-xs font-bold flex items-center space-x-1.5 disabled:opacity-50"
                  >
                    <Clock className="w-3.5 h-3.5" />
                    <span>TRIMITE REZUMAT ZILNIC (TEST)</span>
                  </button>

                  <button
                    onClick={async () => {
                      setTelegramTesting(true);
                      try {
                        const token = localStorage.getItem('tb5_control_token') || 'tradebot5_admin_token';
                        const res = await fetch('/api/bot/telegram/test', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json', 'x-bot-token': token },
                          body: JSON.stringify({ type: 'guide' }),
                        });
                        const data = await res.json();
                        if (data.success) {
                          setTelegramStatusMsg('Ghidul de comenzi a fost trimis pe Telegram!');
                        } else {
                          setTelegramStatusMsg('Eroare Telegram: ' + (data.error || 'Verifică BOT_TOKEN/CHAT_ID'));
                        }
                      } catch (e: any) {
                        setTelegramStatusMsg('Eroare la trimiterea ghidului');
                      } finally {
                        setTelegramTesting(false);
                        setTimeout(() => setTelegramStatusMsg(null), 4000);
                      }
                    }}
                    disabled={telegramTesting}
                    className="px-3 py-1.5 bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-300 rounded text-xs font-bold flex items-center space-x-1.5 disabled:opacity-50"
                  >
                    <HelpCircle className="w-3.5 h-3.5" />
                    <span>TRIMITE GHID COMENZI</span>
                  </button>
                </div>
              </div>

              {/* Interactive Telegram Commands Grid */}
              <div className="bg-black border border-amber-500/20 rounded p-3 space-y-2">
                <div className="text-amber-400 font-bold text-xs flex items-center space-x-1.5">
                  <Terminal className="w-3.5 h-3.5" />
                  <span>COMENZI TELEGRAM DISPONIBILE (INTEROGĂRI &amp; CONTROL ÎN TIMP REAL)</span>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs font-mono">
                  <div className="bg-zinc-950 p-2 rounded border border-zinc-800 flex flex-col justify-between">
                    <div>
                      <span className="text-amber-400 font-bold">/portofoliu</span>
                      <p className="text-[11px] text-zinc-400 font-sans mt-0.5">Afișează balanța liberă, capitalul total (Equity) și PnL-ul nerealizat curent.</p>
                    </div>
                  </div>
                  <div className="bg-zinc-950 p-2 rounded border border-zinc-800 flex flex-col justify-between">
                    <div>
                      <span className="text-amber-400 font-bold">/stare</span>
                      <p className="text-[11px] text-zinc-400 font-sans mt-0.5">Verifică starea botului, profilul activ, regimul BTC și sentimentul global OKX.</p>
                    </div>
                  </div>
                  <div className="bg-zinc-950 p-2 rounded border border-zinc-800 flex flex-col justify-between">
                    <div>
                      <span className="text-amber-400 font-bold">/pozitii</span>
                      <p className="text-[11px] text-zinc-400 font-sans mt-0.5">Listează toate pozițiile deschise cu preț intrare, preț curent și PnL% în timp real.</p>
                    </div>
                  </div>
                  <div className="bg-zinc-950 p-2 rounded border border-zinc-800 flex flex-col justify-between">
                    <div>
                      <span className="text-amber-400 font-bold">/jurnal</span>
                      <p className="text-[11px] text-zinc-400 font-sans mt-0.5">Ultimele 5 ordine și tranzacții executate cu rezultatele PnL.</p>
                    </div>
                  </div>
                  <div className="bg-zinc-950 p-2 rounded border border-zinc-800 flex flex-col justify-between">
                    <div>
                      <span className="text-rose-400 font-bold">/pauza</span>
                      <p className="text-[11px] text-zinc-400 font-sans mt-0.5">Activează Kill Switch-ul de urgență (blochează deschiderea de noi poziții).</p>
                    </div>
                  </div>
                  <div className="bg-zinc-950 p-2 rounded border border-zinc-800 flex flex-col justify-between">
                    <div>
                      <span className="text-emerald-400 font-bold">/porneste</span>
                      <p className="text-[11px] text-zinc-400 font-sans mt-0.5">Dezactivează Kill Switch-ul și reia tranzacționarea automată normală.</p>
                    </div>
                  </div>
                  <div className="bg-zinc-950 p-2 rounded border border-zinc-800 flex flex-col justify-between">
                    <div>
                      <span className="text-amber-400 font-bold">/cumpara SIMBOL [SUMA]</span>
                      <p className="text-[11px] text-zinc-400 font-sans mt-0.5">Deschide manual un ordin LONG pe OKX (ex: <code>/cumpara BTCUSDT 20</code>).</p>
                    </div>
                  </div>
                  <div className="bg-zinc-950 p-2 rounded border border-zinc-800 flex flex-col justify-between">
                    <div>
                      <span className="text-amber-400 font-bold">/vinde SIMBOL</span>
                      <p className="text-[11px] text-zinc-400 font-sans mt-0.5">Închide manual poziția pe simbolul specificat (ex: <code>/vinde BTCUSDT</code>).</p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Automatic Event Notifications Info */}
              <div className="bg-black border border-zinc-800 rounded p-3 text-xs space-y-2">
                <div className="text-slate-400 font-bold flex items-center space-x-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
                  <span>EVENIMENTE CRITICE NOTIFICATE AUTOMAT PE TELEGRAM:</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-[11px] text-zinc-300 font-mono">
                  <div className="p-2 bg-zinc-900 rounded border border-zinc-800">
                    <span className="text-rose-400 font-bold block">🚨 KILL SWITCH</span>
                    Notificare instantă când Kill Switch-ul este activat sau dezactivat.
                  </div>
                  <div className="p-2 bg-zinc-900 rounded border border-zinc-800">
                    <span className="text-cyan-400 font-bold block">🔄 RESET CONT</span>
                    Notificare când contul este resetat la $200.00 capital curat.
                  </div>
                  <div className="p-2 bg-zinc-900 rounded border border-zinc-800">
                    <span className="text-emerald-400 font-bold block">⚡ PRAG SENTIMENT</span>
                    Alertă automată când sentimentul pieței OKX trece peste ±{currentSentimentThreshold.toFixed(1)}%.
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeScreen === 'SYM' && (
            <SymbolStatsView
              onSelectSymbolForChart={(sym) => {
                loadTradingViewChart(sym);
                setActiveScreen('PORT');
              }}
              lang={lang}
            />
          )}

          {activeScreen === 'EXP' && renderExperimentView()}
        </div>

          {/* RIGHT MODULE PANEL: OPEN POSITIONS IN [1:PORT], TRADINGVIEW CHART IN ALL OTHER SCREENS (HIDDEN IN SYM/EXP) */}
          <div className={`${
            activeScreen === 'CHART'
              ? 'col-span-12 flex'
              : activeScreen === 'SYM' || activeScreen === 'EXP'
              ? 'hidden'
              : 'hidden lg:flex lg:col-span-6'
          } flex-col min-h-0`}>
            {activeScreen === 'PORT' ? (
              renderOpenPositionsContent('PORT')
            ) : (
              <TradingViewChart
                currentSymbol={chartSymbol}
                onSymbolChange={(sym) => setChartSymbol(sym)}
                availableSymbols={allUniverseSymbols}
                lang={lang}
              />
            )}
          </div>
        </div>

        {/* BOTTOM WIDE MODULE: DESK AUDIT FEED (DOUBLE-HEIGHT AUTO-TAPE TICKER WITH FULL INFO & 1M STATUS) */}
        <div className={`${activeScreen === 'EXP' ? 'hidden' : 'h-[84px] sm:h-24 lg:h-28 shrink-0 flex flex-col min-h-[84px] z-10'}`}>
          <div className="bg-zinc-950 border border-amber-500/30 rounded p-1.5 sm:p-2 flex flex-col h-full min-h-0 shadow-lg justify-between">
            {/* ANTET (STRICT SINGLE LINE ON MOBILE & DESKTOP) */}
            <div className="flex flex-nowrap items-center justify-between gap-1 border-b border-amber-500/30 pb-0.5 sm:pb-1 mb-0.5 sm:mb-1 shrink-0 overflow-hidden">
              <div className="flex items-center space-x-1.5 min-w-0 truncate">
                <Terminal className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                <span className="font-bold text-[11px] sm:text-xs tracking-wider text-amber-400 shrink-0">
                  <span className="sm:hidden">AUDIT FEED</span>
                  <span className="hidden sm:inline">DESK AUDIT FEED</span>
                </span>
                <span className="text-[10px] text-slate-400 font-mono shrink-0">
                  ({Math.min(displayLogs.length, 100)})
                </span>
                <span className="text-[10px] text-zinc-500 hidden md:inline truncate">
                  — Bandă derulantă live &gt;&gt; (puls sistem 1m)
                </span>
              </div>

              <div className="flex items-center space-x-1 shrink-0">
                <button
                  type="button"
                  onClick={handleExportLogs}
                  disabled={logs.length === 0}
                  className="inline-flex items-center space-x-1 px-1.5 sm:px-2.5 py-0.5 rounded text-[9px] sm:text-[10px] font-bold bg-emerald-950/80 hover:bg-emerald-900 border border-emerald-600/50 text-emerald-300 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer shrink-0"
                  title="Exportă ultimele până la 500 de evenimente de audit în format CSV / Excel"
                >
                  <Download className="w-2.5 h-2.5 sm:w-3 sm:h-3" />
                  <span className="hidden sm:inline">SAVE LOG ({Math.min(logs.length, 500)})</span>
                  <span className="sm:hidden">SAVE</span>
                </button>

                {!showClearLogsConfirm ? (
                  <button
                    type="button"
                    onClick={() => setShowClearLogsConfirm(true)}
                    disabled={logs.length === 0}
                    className="inline-flex items-center space-x-1 px-1.5 sm:px-2.5 py-0.5 rounded text-[9px] sm:text-[10px] font-bold bg-rose-950/60 hover:bg-rose-900/80 border border-rose-600/40 text-rose-300 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer shrink-0"
                    title="Șterge feed-ul de evenimente"
                  >
                    <Trash2 className="w-2.5 h-2.5 sm:w-3 sm:h-3" />
                    <span className="hidden sm:inline">CLEAR LOG</span>
                    <span className="sm:hidden">CLR</span>
                  </button>
                ) : (
                  <div className="flex items-center space-x-1 bg-rose-950 border border-rose-500 px-1.5 py-0.5 rounded text-[9px] sm:text-[10px] font-mono shrink-0">
                    <span className="text-rose-200 font-bold hidden sm:inline">Ștergi?</span>
                    <button
                      type="button"
                      onClick={() => {
                        setShowClearLogsConfirm(false);
                        if (onClearLogs) onClearLogs();
                      }}
                      className="px-1.5 py-0.5 bg-rose-600 hover:bg-rose-500 text-white rounded font-bold cursor-pointer"
                    >
                      DA
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowClearLogsConfirm(false)}
                      className="px-1.5 py-0.5 bg-zinc-800 text-zinc-300 rounded cursor-pointer"
                    >
                      NU
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* BANDĂ DERULANTĂ CU ÎNĂLȚIME DUBLĂ FAȚĂ DE AUTO-TAPE (INFORMAȚIE COMPLETĂ NE-TRUNCHIATĂ) */}
            <div className="flex-1 min-h-0 flex items-center overflow-hidden relative w-full max-w-full">
              <div
                ref={auditTapeRef}
                className="flex-1 overflow-x-hidden whitespace-nowrap pl-1 select-none scrollbar-none flex items-center h-full"
                title="Trecerea cursorului peste bandă o pune pe pauză temporar"
              >
                {extendedAuditLogs.length === 0 ? (
                  <div className="w-full text-center text-zinc-600 text-xs py-2 font-mono">
                    Niciun eveniment de audit înregistrat încă.
                  </div>
                ) : (
                  <div className="flex items-center shrink-0 h-full">
                    {/* Track 1 */}
                    <div ref={auditTrackRef} className="inline-flex items-center space-x-3 pr-3 shrink-0 py-0.5">
                      {extendedAuditLogs.map((log, idx) => {
                        const theme = getAuditCardTheme(log.type, log.message);
                        return (
                          <div
                            key={`audit_1_${log.id}_${idx}`}
                            className={`h-[48px] sm:h-[54px] w-max max-w-none flex flex-col justify-center px-2.5 sm:px-3.5 py-0.5 sm:py-1 rounded border shrink-0 transition-all select-text shadow-sm ${theme.card}`}
                            title={log.message}
                          >
                            {/* Rândul 1: Punct pulsant/glowing + Timestamp + Badge Tip Eveniment */}
                            <div className="flex items-center space-x-1.5 sm:space-x-2 text-[9px] sm:text-[10px] shrink-0 mb-0.5">
                              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${theme.dot}`} />
                              <span className="text-slate-400 font-mono shrink-0">
                                [{new Date(log.timestamp).toLocaleTimeString()}]
                              </span>
                              <span className={`px-1 sm:px-1.5 py-0.2 rounded text-[8px] sm:text-[9px] font-bold border shrink-0 ${theme.badge}`}>
                                {theme.badgeLabel}
                              </span>
                            </div>
                            {/* Rândul 2: Mesaj complet fără nicio trunchiere sau tăiere */}
                            <div className="text-zinc-100 text-[10px] sm:text-[11px] whitespace-nowrap font-mono font-medium tracking-tight">
                              {log.message}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    {/* Track 2 - Clonă exactă identică pentru buclă infinită perfectă fără salt */}
                    <div className="inline-flex items-center space-x-3 pr-3 shrink-0 py-0.5">
                      {extendedAuditLogs.map((log, idx) => {
                        const theme = getAuditCardTheme(log.type, log.message);
                        return (
                          <div
                            key={`audit_2_${log.id}_${idx}`}
                            className={`h-[48px] sm:h-[54px] w-max max-w-none flex flex-col justify-center px-2.5 sm:px-3.5 py-0.5 sm:py-1 rounded border shrink-0 transition-all select-text shadow-sm ${theme.card}`}
                            title={log.message}
                          >
                            {/* Rândul 1: Punct pulsant/glowing + Timestamp + Badge Tip Eveniment */}
                            <div className="flex items-center space-x-1.5 sm:space-x-2 text-[9px] sm:text-[10px] shrink-0 mb-0.5">
                              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${theme.dot}`} />
                              <span className="text-slate-400 font-mono shrink-0">
                                [{new Date(log.timestamp).toLocaleTimeString()}]
                              </span>
                              <span className={`px-1 sm:px-1.5 py-0.2 rounded text-[8px] sm:text-[9px] font-bold border shrink-0 ${theme.badge}`}>
                                {theme.badgeLabel}
                              </span>
                            </div>
                            {/* Rândul 2: Mesaj complet fără nicio trunchiere sau tăiere */}
                            <div className="text-zinc-100 text-[10px] sm:text-[11px] whitespace-nowrap font-mono font-medium tracking-tight">
                              {log.message}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </main>



      {/* Modal Modificare Bază Fixă Seif */}
      {showSetBaseModal && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
          <div className="bg-zinc-950 border-2 border-cyan-500 rounded p-4 max-w-sm w-full shadow-2xl">
            <h3 className="text-cyan-400 font-bold mb-2 flex items-center space-x-2 text-sm">
              <span>🏦</span>
              <span>MODIFICARE BAZĂ FIXĂ SEIF</span>
            </h3>
            <p className="text-xs text-slate-400 mb-3 leading-relaxed">
              Baza fixă reprezintă capitalul curat de la care botul începe fiecare ciclu. Orice profit generat peste această bază va fi transferat automat în Seif la declanșarea protecției sau la depunerea manuală.
            </p>
            <div className="mb-4">
              <label className="text-[11px] text-zinc-400 block mb-1 font-mono">Bază Fixă de Lucru (USDT):</label>
              <input
                type="number"
                step="5"
                min="10"
                value={newBaseInput}
                onChange={(e) => setNewBaseInput(e.target.value)}
                placeholder="ex: 200.00"
                className="w-full bg-black text-cyan-300 placeholder:text-zinc-700 px-3 py-2 rounded border border-cyan-500/50 text-sm font-mono focus:outline-none focus:border-cyan-400"
              />
              <div className="text-[10px] text-zinc-500 mt-1">Bază curentă: ${baseCapital.toFixed(2)} USDT</div>
            </div>
            <div className="flex justify-end space-x-2">
              <button
                type="button"
                onClick={() => setShowSetBaseModal(false)}
                className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded text-xs font-bold cursor-pointer"
              >
                ANULEAZĂ
              </button>
              <button
                type="button"
                onClick={() => {
                  const val = parseFloat(newBaseInput);
                  if (!isNaN(val) && val > 0) {
                    handleSetBaseCapital(val);
                  }
                }}
                className="px-3 py-1.5 bg-cyan-600 hover:bg-cyan-500 text-white rounded text-xs font-bold cursor-pointer shadow-md"
              >
                SALVEAZĂ BAZĂ
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal Confirmare Resetare Seif */}
      {showResetVaultConfirmModal && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
          <div className="bg-zinc-950 border-2 border-rose-500 rounded p-4 max-w-sm w-full shadow-2xl">
            <h3 className="text-rose-400 font-bold mb-2 flex items-center space-x-2 text-sm">
              <ShieldAlert className="w-5 h-5 text-rose-500" />
              <span>CONFIRMARE RESETARE SEIF</span>
            </h3>
            <p className="text-xs text-slate-300 mb-3 leading-relaxed">
              Ești sigur că vrei să resetezi Seiful (Profit Vault)?
            </p>
            <div className="bg-rose-950/30 border border-rose-800/50 rounded p-2.5 mb-4 text-xs font-mono text-rose-200">
              <div>Suma blocată în Seif: <strong className="text-cyan-300">+${profitVault.toFixed(2)} USDT</strong></div>
              <div className="text-[11px] text-zinc-400 mt-1">La resetare, această sumă este eliberată înapoi în balanța activă, iar noul ciclu de tranzacționare va porni de la capitalul total actual.</div>
            </div>
            <div className="flex justify-end space-x-2">
              <button
                type="button"
                onClick={() => setShowResetVaultConfirmModal(false)}
                className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded text-xs font-bold cursor-pointer"
              >
                ANULEAZĂ
              </button>
              <button
                type="button"
                onClick={handleResetProfitVault}
                className="px-3 py-1.5 bg-rose-600 hover:bg-rose-500 text-white rounded text-xs font-bold cursor-pointer shadow-md"
              >
                CONFIRMĂ RESETAREA
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal Jurnal Audit Declanșări Equity Trailing Protection */}
      {showEquityProtectionModal && (
        <div className="fixed inset-0 bg-black/85 flex items-center justify-center z-50 p-2 sm:p-4 overflow-hidden">
          <div className="bg-zinc-950 border-2 border-amber-500 rounded p-3 sm:p-5 max-w-4xl w-full h-[88vh] max-h-[88vh] flex flex-col shadow-2xl font-mono min-h-0">
            {/* Header */}
            <div className="flex items-center justify-between pb-3 border-b border-amber-500/40 mb-3 gap-2 shrink-0">
              <div className="flex items-center space-x-2">
                <ShieldAlert className="w-5 h-5 text-amber-500 shrink-0" />
                <div>
                  <h3 className="text-amber-400 font-bold text-sm sm:text-base tracking-wider">
                    JURNAL DECLANȘĂRI EQUITY TRAILING PROTECTION
                  </h3>
                  <div className="text-[11px] text-slate-400">
                    Total: <strong className="text-cyan-300">{(status?.equityTrailingState?.history || []).length}</strong> declanșări înregistrate și salvate pe disc (.data)
                  </div>
                </div>
              </div>
              <div className="flex items-center space-x-2">
                <button
                  type="button"
                  disabled={isClearingEquityProtection}
                  onClick={handleClearEquityProtection}
                  className="px-2.5 py-1 bg-rose-950/80 hover:bg-rose-900 border border-rose-500/60 text-rose-200 rounded text-xs font-bold flex items-center space-x-1.5 cursor-pointer shadow-sm disabled:opacity-50"
                  title="Resetează contorul și golește întreg jurnalul de declanșări"
                >
                  <Trash2 className="w-3.5 h-3.5 text-rose-400" />
                  <span>RESET JURNAL</span>
                </button>
                <button
                  type="button"
                  onClick={handleExportEquityProtectionCSV}
                  className="px-2.5 py-1 bg-amber-950/80 hover:bg-amber-900 border border-amber-500/60 text-amber-200 rounded text-xs font-bold flex items-center space-x-1.5 cursor-pointer shadow-sm"
                  title="Descarcă întreg jurnalul ca fișier CSV compatibil Excel"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>EXPORT CSV (EXCEL)</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowEquityProtectionModal(false);
                    setSelectedProtectionEvent(null);
                  }}
                  className="text-zinc-400 hover:text-white px-2 py-1 rounded text-sm font-bold bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 cursor-pointer"
                >
                  ✕
                </button>
              </div>
            </div>

            {/* List / Table (Fully Scrollable) */}
            <div className="flex-1 overflow-y-auto overscroll-contain min-h-0 space-y-2.5 pr-1.5 terminal-scrollbar select-text">
              {(status?.equityTrailingState?.history || []).length === 0 ? (
                <div className="p-8 text-center text-zinc-500 text-xs">
                  Nicio declanșare înregistrată încă. Declanșările vor fi logate automat aici și pe disc la fiecare activare.
                </div>
              ) : (
                (status?.equityTrailingState?.history || []).map((ev, idx) => (
                  <div
                    key={ev.id || idx}
                    className="bg-black border border-amber-500/25 hover:border-amber-500/60 rounded p-3 transition-colors shadow-sm"
                  >
                    {/* Top Row */}
                    <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-zinc-800">
                      <div className="flex items-center space-x-2">
                        <span className="bg-amber-500 text-black px-1.5 py-0.5 rounded text-xs font-black">
                          #{ev.triggerIndex || (status?.equityTrailingState?.history?.length || 0) - idx}
                        </span>
                        <span className="text-xs text-amber-200 font-bold">{ev.dateStr}</span>
                        <span className="bg-zinc-900 text-zinc-400 border border-zinc-700 px-1.5 py-0.2 rounded text-[10px]">
                          {ev.profile} | {ev.executionMode}
                        </span>
                      </div>
                      <div className="flex items-center space-x-2 text-xs">
                        <span className="text-zinc-400">Vârf Atins:</span>
                        <strong className="text-amber-300 font-mono">${ev.peakEquity.toFixed(2)}</strong>
                        <span className="text-zinc-600">|</span>
                        <span className="text-zinc-400">Drawdown:</span>
                        <strong className="text-rose-400 font-mono">-{ev.drawdownFromPeakPct.toFixed(2)}%</strong>
                        <span className="text-zinc-500 text-[10px]">(limită: -{ev.configuredDrawdownLimitPct.toFixed(2)}%)</span>
                      </div>
                    </div>

                    {/* Stats Row */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 py-2 text-[11px] bg-zinc-950/60 px-2 rounded mt-2 border border-zinc-900">
                      <div>
                        <span className="text-zinc-500 block text-[10px]">CAPITAL LUCRU LA DECLANȘARE:</span>
                        <strong className="text-zinc-200">${ev.effectiveEquity.toFixed(2)}</strong>
                      </div>
                      <div>
                        <span className="text-zinc-500 block text-[10px]">TOTAL EQUITY CONT:</span>
                        <strong className="text-emerald-400">${ev.totalEquity.toFixed(2)}</strong>
                      </div>
                      <div>
                        <span className="text-zinc-500 block text-[10px]">PROFIT TRANSFERAT ÎN SEIF:</span>
                        <strong className="text-cyan-300">
                          {ev.profitLockedToVault > 0 ? `+$${ev.profitLockedToVault.toFixed(2)} USDT` : '$0.00'}
                        </strong>
                      </div>
                      <div>
                        <span className="text-zinc-500 block text-[10px]">SOLD SEIF DUPĂ CICLU:</span>
                        <strong className="text-cyan-400">${ev.vaultAfter.toFixed(2)} USDT</strong>
                      </div>
                    </div>

                    {/* Closed Positions Summary */}
                    <div className="mt-2 text-xs">
                      <div className="text-[10px] text-slate-400 mb-1 flex items-center justify-between">
                        <span>POZIȚII ÎNCHISE LA DECLANȘARE ({ev.closedPositionsCount}):</span>
                        <span className="text-zinc-500">Bază noul ciclu: ${ev.baseCapital.toFixed(2)}</span>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {ev.closedPositions && ev.closedPositions.length > 0 ? (
                          ev.closedPositions.map((pos, pIdx) => (
                            <div
                              key={pIdx}
                              className="bg-zinc-900 border border-zinc-700/80 px-2 py-1 rounded text-[11px] flex items-center space-x-2"
                            >
                              <span className="font-bold text-amber-300">{pos.symbol}</span>
                              <span className={pos.side === 'BUY' ? 'text-emerald-400' : 'text-rose-400'}>
                                {pos.side} ${pos.sizeUSDT}
                              </span>
                              <span className="text-zinc-400">@ ${pos.closePrice}</span>
                              {pos.pnl !== undefined && (
                                <span className={`font-bold ${pos.pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                                  ({pos.pnl >= 0 ? '+' : ''}${pos.pnl.toFixed(2)})
                                </span>
                              )}
                            </div>
                          ))
                        ) : (
                          <span className="text-zinc-500 text-[10px] italic">Toate pozițiile active au fost lichidate în siguranță la atingerea pragului.</span>
                        )}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Footer */}
            <div className="pt-3 border-t border-zinc-800 flex items-center justify-between text-xs text-zinc-400 mt-2 shrink-0">
              <span className="text-[11px]">
                🛡️ Toate declanșările sunt salvate persistent în <code className="text-amber-400">.data/equity_protection_events.json</code>.
              </span>
              <button
                type="button"
                onClick={() => setShowEquityProtectionModal(false)}
                className="px-4 py-1.5 bg-amber-600 hover:bg-amber-500 text-black font-bold rounded text-xs cursor-pointer shadow-md"
              >
                ÎNCHIDE
              </button>
            </div>
          </div>
        </div>
      )}

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

      {/* ================================================================= */}
      {/* 🚀 OKX CONNECTION & EXECUTION MODE GATEWAY MODAL (ALL SCREENS)     */}
      {/* ================================================================= */}
      {showOKXModal && (
        <div className="fixed inset-0 bg-black/85 flex items-center justify-center z-50 p-4 backdrop-blur-sm">
          <div className="bg-zinc-950 border-2 border-amber-500 rounded p-5 max-w-2xl w-full shadow-2xl space-y-4 max-h-[90vh] overflow-y-auto">
            {/* Modal Header */}
            <div className="flex items-center justify-between border-b border-amber-500/30 pb-3">
              <div className="flex items-center space-x-2.5">
                <div className="p-2 bg-amber-500/10 rounded border border-amber-500/40">
                  <Key className="w-5 h-5 text-amber-400" />
                </div>
                <div>
                  <h3 className="text-amber-400 font-bold text-base tracking-wider flex items-center space-x-2">
                    <span>PANOU CONEXIUNE OKX &amp; COMUTATOR MOD</span>
                  </h3>
                  <p className="text-xs text-zinc-400">
                    Alege modul de tranzacționare și testează conexiunea directă cu bursa OKX.
                  </p>
                </div>
              </div>
              <button
                onClick={() => setShowOKXModal(false)}
                className="text-zinc-500 hover:text-zinc-200 text-lg px-2 py-0.5 rounded hover:bg-zinc-800"
              >
                ✕
              </button>
            </div>

            {/* Current Active Mode Banner */}
            <div className={`p-3 rounded border flex items-center justify-between font-mono text-xs ${
              status?.executionMode === 'LIVE'
                ? 'bg-rose-950/60 border-rose-500 text-rose-300'
                : status?.executionMode === 'TESTNET'
                ? 'bg-amber-950/60 border-amber-500 text-amber-300'
                : 'bg-emerald-950/60 border-emerald-500 text-emerald-300'
            }`}>
              <div className="flex items-center space-x-2">
                <span className={`w-3 h-3 rounded-full ${
                  status?.executionMode === 'LIVE'
                    ? 'bg-rose-400 animate-ping'
                    : status?.executionMode === 'TESTNET'
                    ? 'bg-amber-400'
                    : 'bg-emerald-400'
                }`} />
                <span>
                  MOD CURENT ACTIV: <strong>{status?.executionMode || 'PAPER'}</strong>
                  {status?.executionMode === 'TESTNET' ? ' (OKX SIMULATED DEMO)' : status?.executionMode === 'LIVE' ? ' (OKX LIVE TRADING)' : ' (SIMULARE LOCALĂ)'}
                </span>
              </div>
              <span className="text-[11px] opacity-80">
                Capital: {isExpOn ? '$10,000.00 USDT (Exp)' : `$${status?.equity !== undefined ? status.equity.toFixed(2) : '200.00'} USDT`}
              </span>
            </div>

            {/* 3 Mode Selection Cards */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
              {/* Paper */}
              <div
                onClick={() => handleSwitchExecutionModeWithCheck('PAPER')}
                className={`p-3 rounded border cursor-pointer transition-all flex flex-col justify-between ${
                  status?.executionMode === 'PAPER'
                    ? 'bg-emerald-950/50 border-emerald-500 ring-1 ring-emerald-500'
                    : 'bg-zinc-900 border-zinc-800 hover:border-emerald-500/40'
                }`}
              >
                <div className="space-y-1 mb-2">
                  <span className="text-xs font-bold text-emerald-400 block">🟢 PAPER (SIMULARE)</span>
                  <p className="text-[11px] text-zinc-300 leading-tight">
                    Fără risc. $200 virtual, comisioane 0.05%, prețuri reale OKX.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleSwitchExecutionModeWithCheck('PAPER');
                  }}
                  className={`w-full py-1 rounded text-xs font-bold ${
                    status?.executionMode === 'PAPER'
                      ? 'bg-emerald-600 text-black cursor-default'
                      : 'bg-zinc-800 text-zinc-300 hover:bg-emerald-600 hover:text-black'
                  }`}
                >
                  {status?.executionMode === 'PAPER' ? '✓ ACTIV' : 'COMUTĂ'}
                </button>
              </div>


              {/* Live */}
              <div
                onClick={() => handleSwitchExecutionModeWithCheck('LIVE')}
                className={`p-3 rounded border cursor-pointer transition-all flex flex-col justify-between ${
                  status?.executionMode === 'LIVE'
                    ? 'bg-rose-950/50 border-rose-500 ring-1 ring-rose-500'
                    : 'bg-zinc-900 border-zinc-800 hover:border-rose-500/40'
                }`}
              >
                <div className="space-y-1 mb-2">
                  <span className="text-xs font-bold text-rose-400 block">🔴 OKX LIVE (REAL)</span>
                  <p className="text-[11px] text-zinc-300 leading-tight">
                    Cont Real OKX. Tranzacționare cu capital real USDT SWAP.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleSwitchExecutionModeWithCheck('LIVE');
                  }}
                  className={`w-full py-1 rounded text-xs font-bold ${
                    status?.executionMode === 'LIVE'
                      ? 'bg-rose-600 text-white cursor-default'
                      : 'bg-zinc-800 text-zinc-300 hover:bg-rose-600 hover:text-white'
                  }`}
                >
                  {status?.executionMode === 'LIVE' ? '✓ ACTIV (LIVE)' : 'COMUTĂ'}
                </button>
              </div>
            </div>

            {/* OKX API Key Form */}
            <div className="bg-black/90 p-3.5 rounded border border-amber-500/30 space-y-3">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-zinc-900 pb-2">
                <span className="text-amber-400 font-bold text-xs flex items-center space-x-1.5">
                  <Key className="w-3.5 h-3.5" />
                  <span>CREDENTIALE OKX (API KEY, SECRET, PASSPHRASE)</span>
                </span>

                {/* Server OCI IP Whitelist helper */}
                {detectedServerIp && (
                  <div className="flex items-center space-x-1.5 text-[11px] font-mono bg-zinc-900 px-2 py-0.5 rounded border border-zinc-700">
                    <span className="text-zinc-400">IP Server OCI:</span>
                    <strong className="text-cyan-300">{detectedServerIp}</strong>
                    <button
                      type="button"
                      onClick={handleCopyServerIp}
                      className="px-1.5 py-0.5 text-[10px] bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded cursor-pointer"
                      title="Copiază IP-ul serverului pentru Whitelist-ul OKX"
                    >
                      {copiedIp ? '✓ Copiat' : 'Copiază'}
                    </button>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
                <div>
                  <label className="block text-zinc-400 text-[10px] mb-1">OKX_API_KEY</label>
                  <input
                    type="text"
                    value={okxKeyInput}
                    onChange={(e) => setOkxKeyInput(e.target.value)}
                    placeholder="API Key OKX"
                    className="w-full bg-zinc-950 text-amber-300 border border-zinc-800 rounded px-2.5 py-1.5 text-xs font-mono focus:outline-none focus:border-amber-400"
                  />
                </div>
                <div>
                  <label className="block text-zinc-400 text-[10px] mb-1">OKX_SECRET_KEY</label>
                  <input
                    type="password"
                    value={okxSecretInput}
                    onChange={(e) => setOkxSecretInput(e.target.value)}
                    placeholder="Secret Key"
                    className="w-full bg-zinc-950 text-amber-300 border border-zinc-800 rounded px-2.5 py-1.5 text-xs font-mono focus:outline-none focus:border-amber-400"
                  />
                </div>
                <div>
                  <label className="block text-zinc-400 text-[10px] mb-1">OKX_PASSPHRASE</label>
                  <input
                    type="password"
                    value={okxPassphraseInput}
                    onChange={(e) => setOkxPassphraseInput(e.target.value)}
                    placeholder="Passphrase"
                    className="w-full bg-zinc-950 text-amber-300 border border-zinc-800 rounded px-2.5 py-1.5 text-xs font-mono focus:outline-none focus:border-amber-400"
                  />
                </div>
              </div>

              {/* Region and Target Mode Configuration */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs pt-1">
                <div className="bg-zinc-950 p-2 rounded border border-zinc-850 flex items-center justify-between">
                  <span className="text-[11px] text-zinc-400">Regiune / Domeniu API:</span>
                  <select
                    value={okxRegionInput}
                    onChange={(e) => setOkxRegionInput(e.target.value as any)}
                    className="bg-zinc-900 text-amber-300 border border-zinc-700 rounded px-2 py-1 text-xs font-mono focus:outline-none"
                  >
                    <option value="EEA">EEA (România/Europa - eea.okx.com)</option>
                    <option value="GLOBAL">Global (Internațional - okx.com)</option>
                    <option value="AUTO">AUTO (Detectare Automată)</option>
                  </select>
                </div>

                <div className="bg-zinc-950 p-2 rounded border border-zinc-850 flex items-center justify-between">
                  <span className="text-[11px] text-zinc-400">Mod Rețea pentru Chei:</span>
                  <div className="flex items-center space-x-1.5">
                    <button
                      type="button"
                      onClick={() => setOkxTestnetInput(false)}
                      className={`px-2 py-0.5 rounded text-[11px] font-bold cursor-pointer transition-all ${
                        !okxTestnetInput
                          ? 'bg-rose-950 text-rose-300 border border-rose-500'
                          : 'bg-zinc-900 text-zinc-400 border border-zinc-700'
                      }`}
                    >
                      🔴 REAL (LIVE)
                    </button>
                    <button
                      type="button"
                      onClick={() => setOkxTestnetInput(true)}
                      className={`px-2 py-0.5 rounded text-[11px] font-bold cursor-pointer transition-all ${
                        okxTestnetInput
                          ? 'bg-amber-950 text-amber-300 border border-amber-500'
                          : 'bg-zinc-900 text-zinc-400 border border-zinc-700'
                      }`}
                    >
                      🟡 DEMO (TESTNET)
                    </button>
                  </div>
                </div>
              </div>

              {/* Important permissions tip */}
              <div className="bg-zinc-900/90 border border-amber-500/30 rounded p-2 text-[11px] font-mono space-y-1">
                <div className="text-amber-400 font-bold flex items-center space-x-1">
                  <AlertTriangle className="w-3 h-3 text-amber-400 shrink-0" />
                  <span>CERINȚE CHEIE API OKX (Evitare Eroare 50124):</span>
                </div>
                <ul className="text-zinc-300 list-disc list-inside space-y-0.5 text-[10px] leading-relaxed">
                  <li>
                    <strong className="text-amber-300">Permisiune &quot;Trade&quot; (Tranzacționare):</strong> În contul OKX (Profile &rarr; API &rarr; Editează cheia), bifează obligatoriu <span className="text-emerald-400 font-bold">Trade</span> (nu doar Read)! Fără Trade, OKX respinge orice ordin cu eroarea 50124.
                  </li>
                  <li>
                    <strong className="text-amber-300">Mod Cont (Account Mode):</strong> În OKX (Trade &rarr; Settings / Roată dințată &rarr; Account mode), selectează <span className="text-cyan-300 font-bold">Single-currency margin</span> sau <span className="text-cyan-300 font-bold">Multi-currency margin</span> pentru a permite contracte USDT SWAP.
                  </li>
                  <li>
                    <strong className="text-rose-400">Securitate:</strong> Lasă opțiunea <em>Withdraw</em> (Retrageri) <span className="text-rose-400 font-bold">DEBIFATĂ</span>.
                  </li>
                </ul>
              </div>

              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 pt-2 border-t border-zinc-900">
                <span className="text-[10px] text-zinc-500 font-mono">
                  {okxTestnetInput
                    ? '🟡 Header simulated activ (x-simulated-trading: 1). Necesită chei Demo create pe OKX.'
                    : '🔴 Fără header simulated. Tranzacționare cu cont Real USDT SWAP.'}
                </span>

                <div className="flex items-center space-x-2 w-full sm:w-auto">
                  <button
                    onClick={() => handleRunOKXTest()}
                    disabled={isTestingOKX}
                    className="px-3 py-1.5 bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-300 rounded text-xs font-bold flex items-center space-x-1.5 disabled:opacity-50 cursor-pointer"
                  >
                    <Wifi className="w-3.5 h-3.5 text-amber-400" />
                    <span>{isTestingOKX ? 'TESTARE...' : 'TESTEAZĂ CHEI'}</span>
                  </button>

                  <button
                    onClick={handleSaveOKXCredentials}
                    disabled={isSavingOKX || !okxKeyInput || !okxSecretInput}
                    className="px-3.5 py-1.5 bg-amber-500 hover:bg-amber-400 text-black rounded text-xs font-bold flex items-center space-x-1.5 disabled:opacity-40 cursor-pointer"
                  >
                    <Save className="w-3.5 h-3.5" />
                    <span>{isSavingOKX ? 'SALVARE...' : 'SALVEAZĂ CHEI'}</span>
                  </button>
                </div>
              </div>

              {okxSaveMessage && (
                <div className="p-2 rounded bg-zinc-900 border border-amber-500/40 text-xs font-mono text-amber-300">
                  {okxSaveMessage}
                </div>
              )}

              {/* Feedback Display */}
              {okxTestFeedback && okxTestFeedback.tested && (
                <div className={`p-2.5 rounded border text-xs font-mono space-y-1.5 ${
                  okxTestFeedback.authenticated
                    ? 'bg-emerald-950/60 border-emerald-500 text-emerald-300'
                    : okxTestFeedback.reachable
                    ? 'bg-amber-950/60 border-amber-500 text-amber-300'
                    : 'bg-rose-950/60 border-rose-500 text-rose-300'
                }`}>
                  <div className="font-bold flex items-center justify-between">
                    <div className="flex items-center space-x-1.5">
                      {okxTestFeedback.authenticated ? (
                        <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                      ) : (
                        <AlertTriangle className="w-4 h-4 text-amber-400" />
                      )}
                      <span>REZULTAT TEST CONEXIUNE OKX:</span>
                    </div>
                    {okxTestFeedback.region && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-700 text-cyan-300">
                        {okxTestFeedback.region}
                      </span>
                    )}
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-1 text-[11px]">
                    <div>• Ping API: <strong>{okxTestFeedback.reachable ? '✅ OK' : '❌ FAIL'}</strong></div>
                    <div>• Autentificare: <strong>{okxTestFeedback.authenticated ? '✅ VALIDE' : '❌ EȘUATĂ'}</strong></div>
                    <div>• Sold USDT: <strong>{okxTestFeedback.equity !== undefined ? `$${okxTestFeedback.equity.toFixed(2)}` : '--'}</strong></div>
                  </div>
                  {okxTestFeedback.error && (
                    <div className="text-[11px] text-rose-300 pt-1 whitespace-pre-line bg-black/50 p-2 rounded border border-rose-800/40">
                      {okxTestFeedback.error}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="flex justify-end pt-2">
              <button
                onClick={() => setShowOKXModal(false)}
                className="px-4 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded text-xs font-bold"
              >
                ÎNCHIDE
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ================================================================= */}
      {/* ⚠️ LIVE TRADING CONFIRMATION SAFETY MODAL                         */}
      {/* ================================================================= */}
      {showLiveConfirm && (
        <div className="fixed inset-0 bg-black/90 flex items-center justify-center z-50 p-4 backdrop-blur-md">
          <div className="bg-zinc-950 border-2 border-rose-500 rounded p-5 max-w-md w-full shadow-2xl space-y-4">
            <div className="flex items-center space-x-2 text-rose-400 border-b border-rose-500/40 pb-3">
              <AlertTriangle className="w-6 h-6 text-rose-500 animate-bounce" />
              <h3 className="font-black text-sm tracking-wider">
                CONFIRMARE ACTIVARE MOD OKX LIVE (CONT REAL)
              </h3>
            </div>

            <p className="text-xs text-zinc-300 leading-relaxed">
              Ești pe cale să comuți botul în modul <strong>LIVE</strong>.
              În acest mod, orice semnal de intrare generat de scaner va trimite <strong>ordine reale pe bursa OKX USDT SWAP Perpetuals folosind bani reali din contul tău</strong>.
            </p>

            <div className="bg-rose-950/40 border border-rose-500/40 rounded p-3 text-xs space-y-1.5 font-mono text-rose-200">
              <div>⚠️ Asigură-te că:</div>
              <div>1. Ai testat mai întâi strategia în mod PAPER sau TESTNET.</div>
              <div>2. Cheile API introduse sunt corecte și au permisiune de tranzacționare.</div>
              <div>3. Procentul de risc (Risk per trade) și Stop Loss-ul sunt setate conservator.</div>
            </div>

            <label className="flex items-start space-x-2.5 text-xs text-zinc-200 cursor-pointer pt-1">
              <input
                type="checkbox"
                checked={liveDisclaimerChecked}
                onChange={(e) => setLiveDisclaimerChecked(e.target.checked)}
                className="accent-rose-500 mt-0.5"
              />
              <span>Înțeleg riscul tranzacționării reale și confirm activarea modului LIVE pe OKX.</span>
            </label>

            <div className="flex justify-end space-x-3 pt-2">
              <button
                onClick={() => {
                  setShowLiveConfirm(false);
                  setLiveDisclaimerChecked(false);
                }}
                className="px-3.5 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded text-xs font-bold"
              >
                ANULEAZĂ
              </button>
              <button
                onClick={handleConfirmLiveMode}
                disabled={!liveDisclaimerChecked}
                className="px-4 py-1.5 bg-rose-600 hover:bg-rose-500 text-white rounded text-xs font-bold disabled:opacity-40 disabled:cursor-not-allowed shadow-lg shadow-rose-950"
              >
                CONFIRMĂ &amp; ACTIVEAZĂ LIVE
              </button>
            </div>
          </div>
        </div>
      )}

      {/* User Manual Modal (Exhaustive documentation & PDF generator) */}
      <UserManualModal
        isOpen={showManualModal}
        onClose={() => setShowManualModal(false)}
        lang={lang}
      />
    </div>
  );
};
