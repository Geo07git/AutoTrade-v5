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
} from 'lucide-react';
import { TradingViewChart } from './TradingViewChart';

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
  onUpdateCredentials?: (apiKey: string, secretKey: string, passphrase: string, testnet: boolean) => Promise<{ success: boolean; error?: string }>;
  onTestOKXConnection?: (creds?: any) => Promise<any>;
  onSaveTelegramConfig?: (token: string, chatId: string, botUsername?: string) => Promise<{ success: boolean; message?: string; error?: string }>;
  onTestTelegramConnection?: (token?: string, chatId?: string) => Promise<{ success: boolean; reachable: boolean; validToken: boolean; botUsername?: string; botName?: string; chatDelivered?: boolean; error?: string }>;
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
  onUpdateCredentials,
  onTestOKXConnection,
  onSaveTelegramConfig,
  onTestTelegramConnection,
  controlToken,
  onUpdateControlToken,
  errorMessage,
  successMessage,
}) => {
  const profileConfig = status?.profileConfig;
  const activeProfile = status?.config?.activeProfile || 'MOMENTUM';

  const [activeScreen, setActiveScreen] = useState<'PORT' | 'POS' | 'TAPE' | 'SCAN' | 'BLOT' | 'SET' | 'INFO' | 'CHART'>('PORT');
  const [expandedPositionIds, setExpandedPositionIds] = useState<Record<string, boolean>>({});

  // OKX Gateway & Mode Switch State
  const [showOKXModal, setShowOKXModal] = useState<boolean>(false);
  const [okxKeyInput, setOkxKeyInput] = useState<string>('');
  const [okxSecretInput, setOkxSecretInput] = useState<string>('');
  const [okxPassphraseInput, setOkxPassphraseInput] = useState<string>('');
  const [okxTestnetInput, setOkxTestnetInput] = useState<boolean>(true);
  const [isTestingOKX, setIsTestingOKX] = useState<boolean>(false);
  const [okxTestFeedback, setOkxTestFeedback] = useState<{
    tested: boolean;
    reachable?: boolean;
    authenticated?: boolean;
    equity?: number;
    error?: string;
  } | null>(null);
  const [isSavingOKX, setIsSavingOKX] = useState<boolean>(false);
  const [okxSaveMessage, setOkxSaveMessage] = useState<string | null>(null);
  const [showLiveConfirm, setShowLiveConfirm] = useState<boolean>(false);
  const [liveDisclaimerChecked, setLiveDisclaimerChecked] = useState<boolean>(false);

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
  const [hardStopLoss, setHardStopLoss] = useState(profileConfig?.hardStopLossPct ?? 2.5);
  const [trailingAct, setTrailingAct] = useState(profileConfig?.trailingActivationPct ?? 1.5);
  const [trailingDist, setTrailingDist] = useState(profileConfig?.trailingDistancePct ?? 0.4);
  const [minMomentum, setMinMomentum] = useState(
    Math.min(82, Math.max(57, profileConfig?.minMomentumScore ?? 72))
  );
  const [takeProfit, setTakeProfit] = useState(profileConfig?.takeProfitPct ?? 0);
  const [breakEven, setBreakEven] = useState(profileConfig?.breakEvenActivationPct ?? 1.0);
  const [maxHoldTime, setMaxHoldTime] = useState(profileConfig?.maxHoldingTimeMinutes ?? 60);
  const [cooldownMins, setCooldownMins] = useState(profileConfig?.cooldownMinutes ?? 5);
  const [sentimentThreshold, setSentimentThreshold] = useState(profileConfig?.sentimentThreshold ?? 1.5);
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
        } : undefined);
        const result = await onTestOKXConnection(credsToSend);
        setOkxTestFeedback({
          tested: true,
          reachable: result.reachable,
          authenticated: result.authenticated,
          equity: result.equity,
          error: result.error,
        });
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
          okxTestnetInput
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
          <div className="flex items-center space-x-2 text-[11px] font-mono">
            <span className={`px-2 py-0.5 rounded border ${
              isConfigured
                ? 'bg-emerald-950/80 text-emerald-300 border-emerald-500/60'
                : hasToken
                ? 'bg-amber-950/80 text-amber-300 border-amber-500/60'
                : 'bg-zinc-900 text-zinc-400 border-zinc-700'
            }`}>
              {isConfigured
                ? `● ACTIV & CONECTAT ${botNameOrUser ? `(@${botNameOrUser})` : ''}`
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
      getOrderLabel(o),
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
    minMomentum !== (profileConfig.minMomentumScore ?? 72) ||
    takeProfit !== (profileConfig.takeProfitPct ?? 0) ||
    breakEven !== (profileConfig.breakEvenActivationPct ?? 1.0) ||
    maxHoldTime !== (profileConfig.maxHoldingTimeMinutes ?? 60) ||
    equityProtAct !== (profileConfig.equityProtectionActivationPct ?? 0) ||
    equityTrailingDraw !== (profileConfig.equityTrailingDrawdownPct ?? 0) ||
    cooldownMins !== (profileConfig.cooldownMinutes ?? 5) ||
    sentimentThreshold !== (profileConfig.sentimentThreshold ?? 1.5)
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
      setMinMomentum(
        Math.min(82, Math.max(57, profileConfig.minMomentumScore ?? 72))
      );
      setTakeProfit(profileConfig.takeProfitPct ?? 0);
      setBreakEven(profileConfig.breakEvenActivationPct ?? 1.0);
      setMaxHoldTime(profileConfig.maxHoldingTimeMinutes ?? 60);
      setCooldownMins(profileConfig.cooldownMinutes ?? 5);
      setSentimentThreshold(profileConfig.sentimentThreshold ?? 1.5);
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
      sentimentThreshold,
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
    setMinMomentum(
      Math.min(82, Math.max(57, profileConfig.minMomentumScore ?? 72))
    );
    setTakeProfit(profileConfig.takeProfitPct ?? 0);
    setBreakEven(profileConfig.breakEvenActivationPct ?? 1.0);
    setMaxHoldTime(profileConfig.maxHoldingTimeMinutes ?? 60);
    setEquityProtAct(profileConfig.equityProtectionActivationPct ?? 0);
    setEquityTrailingDraw(profileConfig.equityTrailingDrawdownPct ?? 0);
    setCooldownMins(profileConfig.cooldownMinutes ?? 5);
    setSentimentThreshold(profileConfig.sentimentThreshold ?? 1.5);
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

  // Sentiment calculations for display
  const sentimentScore = status?.marketSentimentScore ?? 0;
  const currentSentimentThreshold = profileConfig?.sentimentThreshold ?? 1.5;
  const isBullishSentiment = (status?.marketSentiment?.includes('BULLISH') || sentimentScore >= currentSentimentThreshold);
  const isBearishSentiment = (status?.marketSentiment?.includes('BEARISH') || sentimentScore <= -currentSentimentThreshold);

  return (
    <div className={`h-screen w-full bg-black text-amber-500 font-mono flex flex-col overflow-hidden ${isMonochrome ? 'monochrome' : ''}`}>
      {/* 0. FROZEN TOP DOCK: HEADER + AUTO-TAPE + SHORTCUTS BAR + BANNERS (STICKY TOP DOCK) */}
      <div className="sticky top-0 z-40 bg-black shadow-2xl border-b border-amber-500/40 flex flex-col shrink-0 w-full max-w-full min-w-0">
        {/* 1. BLOOMBERG TERMINAL TOP BANNER */}
        <header className="bg-amber-600 text-black px-2 sm:px-3 py-1 flex flex-col md:flex-row md:items-center justify-between text-xs font-bold tracking-wider shrink-0 shadow-md gap-1.5 md:gap-0 w-full max-w-full min-w-0">
        <div className="flex items-center justify-between md:justify-start w-full md:w-auto space-x-1.5 sm:space-x-3">
          <span className="bg-black text-amber-500 px-2 sm:px-3 py-0.5 sm:py-1 rounded text-xs sm:text-base tracking-widest font-black border border-amber-500/50 shrink-0">
            <span className="hidden sm:inline">BLOOMBERG // TRADEBOT v5.0 PRO</span>
            <span className="sm:hidden">BBG // TRADEBOT</span>
          </span>
          <span className="hidden lg:inline">DESK: SECURE-QUANT-01</span>
          <span className="hidden lg:inline">|</span>
          {/* INTERACTIVE MODE SWITCHER BADGE */}
          <button
            onClick={() => setShowOKXModal(true)}
            className={`px-1.5 sm:px-2 py-0.5 rounded text-[10px] sm:text-xs font-bold border flex items-center space-x-1 sm:space-x-1.5 transition-all shadow-sm shrink-0 ${
              status?.executionMode === 'LIVE'
                ? 'bg-rose-950/90 text-rose-300 border-rose-500 hover:bg-rose-900 animate-pulse'
                : status?.executionMode === 'TESTNET'
                ? 'bg-amber-950/90 text-amber-300 border-amber-500 hover:bg-amber-900'
                : 'bg-emerald-950/90 text-emerald-300 border-emerald-500 hover:bg-emerald-900'
            }`}
            title="Comută modul de execuție (PAPER / TESTNET / LIVE) sau configurează cheile OKX"
          >
            <span
              className={`w-1.5 sm:w-2 h-1.5 sm:h-2 rounded-full ${
                status?.executionMode === 'LIVE'
                  ? 'bg-rose-400 animate-ping'
                  : status?.executionMode === 'TESTNET'
                  ? 'bg-amber-400'
                  : 'bg-emerald-400'
              }`}
            />
            <span>
              {status?.executionMode === 'LIVE'
                ? 'FEED: 🔴 OKX LIVE'
                : status?.executionMode === 'TESTNET'
                ? 'FEED: 🟡 OKX DEMO'
                : 'FEED: 🟢 PAPER'}
            </span>
            <span className="text-[9px] sm:text-[10px] bg-black/60 px-1 py-0.2 rounded border border-white/20 text-zinc-300">
              MOD ▾
            </span>
          </button>
          <span className="hidden md:inline">|</span>
          <span className="font-mono text-[9px] sm:text-[10px] bg-black text-amber-400 px-1 sm:px-1.5 py-0.5 rounded border border-amber-500/50 shrink-0">{status?.marketRegime || 'BTC: --'}</span>
          <button
            onClick={() => {
              onResetPaper();
            }}
            className="md:hidden bg-zinc-900 text-amber-400 hover:bg-black px-1.5 py-0.5 rounded border border-amber-500/30 flex items-center space-x-1 text-[9px] shrink-0"
          >
            <span>RESET</span>
          </button>
        </div>
        <div className="flex items-center justify-between md:justify-end w-full md:w-auto space-x-1.5 sm:space-x-3">
          <div className="flex items-center space-x-1 sm:space-x-2 shrink-0">
            <span className="bg-black/90 text-emerald-400 px-1.5 sm:px-2 py-0.5 rounded text-xs sm:text-sm md:text-base font-mono balance-metric">
              EQ: ${status?.equity !== undefined ? status.equity.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '200.00'}
            </span>
            <span className={`px-1.5 sm:px-2 py-0.5 rounded text-xs sm:text-sm md:text-base font-mono shrink-0 pnl-metric ${totalPnL >= 0 ? 'bg-emerald-950 text-emerald-400' : 'bg-rose-950 text-rose-400'}`}>
              PNL: {totalPnL >= 0 ? '+' : ''}${totalPnL.toFixed(2)}
            </span>
          </div>
          <div className="flex items-center space-x-1 sm:space-x-2 shrink-0">
            <button
              onClick={() => setShowOKXModal(true)}
              className="bg-black text-amber-400 hover:bg-zinc-900 px-1.5 sm:px-2 py-0.5 rounded border border-amber-500/50 flex items-center space-x-1 text-[10px] sm:text-xs font-bold shadow-sm"
              title="Configurează Conexiunea OKX & Modul de Execuție"
            >
              <Key className="w-3 h-3 text-amber-400" />
              <span className="hidden sm:inline">CONEXIUNE OKX</span>
              <span className="sm:hidden">OKX</span>
            </button>
            <button
              onClick={() => {
                setActiveScreen('INFO');
                setTimeout(() => {
                  const el = document.getElementById('telegram-config-card');
                  if (el) el.scrollIntoView({ behavior: 'smooth' });
                }, 50);
              }}
              className={`px-1.5 sm:px-2 py-0.5 rounded border flex items-center space-x-1 text-[10px] sm:text-xs font-bold shadow-sm transition-colors ${
                status?.telegramActive
                  ? 'bg-sky-950/80 text-sky-300 border-sky-500/60 hover:bg-sky-900/60'
                  : 'bg-zinc-900 text-sky-400 border-sky-500/40 hover:bg-zinc-800'
              }`}
              title="Configurează Cheia Telegram și Canalul de Alerte"
            >
              <Send className="w-3 h-3 text-sky-400" />
              <span className="hidden sm:inline">{status?.telegramActive ? 'TELEGRAM: ACTIV' : 'CONFIG TELEGRAM'}</span>
              <span className="sm:hidden">{status?.telegramActive ? 'TG: ON' : 'TG +'}</span>
            </button>
            <button
              onClick={() => setShowTokenModal(true)}
              className="bg-zinc-900 text-amber-400 hover:bg-black px-1.5 sm:px-2 py-0.5 rounded border border-amber-500/30 flex items-center space-x-1 text-[10px] sm:text-xs"
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
              onClick={handleToggleInvertSignals}
              className={`px-1.5 sm:px-2 py-0.5 rounded border flex items-center space-x-1 text-[10px] sm:text-xs font-bold transition-all shrink-0 cursor-pointer ${
                status?.config?.invertSignals
                  ? 'bg-purple-950 text-purple-300 border-purple-500 shadow-[0_0_8px_rgba(168,85,247,0.4)] animate-pulse'
                  : 'bg-zinc-900 text-zinc-400 hover:text-purple-300 border-zinc-700'
              }`}
              title="Experiment: Inversare Semnale (BUY ⇄ SELL). Când este activ, semnalele Long devin Short și viceversa."
            >
              <span className="shrink-0">🧪</span>
              <span className="hidden md:inline">{status?.config?.invertSignals ? 'EXP: INVERS ACTIV' : 'EXP: NORMAL'}</span>
              <span className="md:hidden">{status?.config?.invertSignals ? 'INVERS' : 'NORMAL'}</span>
            </button>
            <button
              onClick={() => setIsMonochrome(!isMonochrome)}
              className={`px-2 py-0.5 rounded text-[10px] sm:text-xs font-bold border flex items-center space-x-1 transition-all shrink-0 cursor-pointer ${
                isMonochrome
                  ? 'bg-white text-black border-white shadow-md'
                  : 'bg-zinc-900 text-amber-400 hover:bg-zinc-800 border-amber-500/40'
              }`}
              title="Comută Modul Monocrom (High-contrast B&W, păstrează amber pentru balanță, PnL și profit)"
            >
              <span>{isMonochrome ? 'MONO: ON' : 'MONO: OFF'}</span>
            </button>
            <button
              onClick={onRefresh}
              className="bg-black text-amber-500 hover:bg-zinc-900 px-1.5 sm:px-2 py-0.5 rounded flex items-center space-x-1 text-[10px] sm:text-[11px]"
            >
              <RefreshCw className="w-3 h-3 animate-spin" style={{ animationDuration: '4s' }} />
              <span className="hidden sm:inline">SYNC</span>
            </button>
          </div>
        </div>
      </header>

      {/* 1.1 BANNER EXPERIMENT INVERSARE SEMNALE */}
      {status?.config?.invertSignals && (
        <div className="bg-purple-950/95 border-b border-purple-500/60 px-3 py-1.5 text-[11px] font-mono text-purple-200 flex flex-wrap items-center justify-between gap-2 shrink-0 z-20 shadow-[0_2px_12px_rgba(88,28,135,0.5)]">
          <div className="flex items-center space-x-2">
            <span className="bg-purple-600 text-white text-[9px] px-1.5 py-0.5 rounded font-bold uppercase tracking-wider animate-pulse shrink-0">
              🧪 EXPERIMENT INVERSARE ACTIV
            </span>
            <span className="text-[10px] sm:text-[11px]">
              Semnalele sunt inversate: <strong>BUY (Long) ➡️ SHORT (Sell)</strong> | <strong>SELL (Short) ➡️ LONG (Buy)</strong>. Rulează în paralel cu instanța locală pentru comparare.
            </span>
          </div>
          <button
            onClick={handleToggleInvertSignals}
            className="bg-purple-800 hover:bg-purple-700 text-white text-[10px] font-bold px-2.5 py-0.5 rounded border border-purple-400/50 transition-colors shrink-0 cursor-pointer"
          >
            Oprește Experimentul (Revenire la Normal)
          </button>
        </div>
      )}

      {/* 2. REAL-TIME TICKER TAPE (AUTO-SCROLLING 24H % DESC) */}
      <div className="bg-zinc-950 border-b border-amber-500/30 px-3 py-1 text-[11px] flex items-center shrink-0 overflow-hidden relative w-full max-w-full min-w-0">
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

      {/* 3. FUNCTION KEY SHORTCUTS BAR (SCROLLABLE & DRAGGABLE IN COMPACT/MOBILE VIEW) */}
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

        {/* Scrollable Container with MouseWheel, Touch, Mouse Drag, and Styled Scrollbar */}
        <div
          ref={shortcutsRef}
          onWheel={handleShortcutsWheel}
          onMouseDown={handleShortcutsMouseDown}
          onMouseMove={handleShortcutsMouseMove}
          onMouseUp={handleShortcutsMouseUp}
          onMouseLeave={handleShortcutsMouseUp}
          className="w-full max-w-full min-w-0 overflow-x-auto terminal-scrollbar-x py-1 px-2 sm:px-3 flex items-center justify-between text-xs whitespace-nowrap gap-2 sm:gap-4 cursor-grab active:cursor-grabbing"
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

            {/* Language Switcher Switch (EN / RO) */}
            <div className="flex bg-black rounded border border-amber-500/40 p-0.5 shrink-0 ml-1 sm:ml-2">
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

            {/* Telegram Status & Quick Action */}
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
                    setTelegramStatusMsg('Raport orar expediat cu succes pe Telegram!');
                  } else {
                    setTelegramStatusMsg('Eroare Telegram: ' + (data.error || 'Verificați cheile BOT_TOKEN/CHAT_ID'));
                  }
                } catch (e: any) {
                  setTelegramStatusMsg('Eroare conexiune server API');
                } finally {
                  setTelegramTesting(false);
                  setTimeout(() => setTelegramStatusMsg(null), 4000);
                }
              }}
              disabled={telegramTesting}
              className={`px-2 py-1 rounded text-[11px] font-bold border transition-colors flex items-center space-x-1 shrink-0 ${
                status?.telegramActive
                  ? 'bg-sky-950/80 text-sky-300 border-sky-500/60 hover:bg-sky-900/60 shadow-sm'
                  : 'bg-zinc-950 text-zinc-400 border-zinc-700 hover:bg-zinc-900'
              }`}
              title="Apasă pentru a trimite un raport orar de test pe Telegram"
            >
              <Send className="w-3.5 h-3.5" />
              <span>{telegramTesting ? 'TRIMIT...' : status?.telegramActive ? 'TG: ACTIV' : 'TG: STANDBY'}</span>
            </button>

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

      {/* ALERTS NOTIFICATION BANNER */}
      {(errorMessage || successMessage) && (
        <div className={`px-4 py-2 text-xs flex items-center justify-between border-b ${errorMessage ? 'bg-rose-950/80 text-rose-300 border-rose-800' : 'bg-emerald-950/80 text-emerald-300 border-emerald-800'}`}>
          <div className="flex items-center space-x-2">
            {errorMessage ? <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" /> : <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />}
            <span>{errorMessage || successMessage}</span>
          </div>
        </div>
      )}
      </div>

      {/* 4. MAIN TERMINAL WORKSPACE (100% NO SCROLL IN FULLSCREEN) */}
      <main className="flex-1 min-h-0 p-2 bg-black flex flex-col gap-2 overflow-hidden">
        {/* UPPER ROW: LEFT ACTIVE SCREEN + RIGHT TRADINGVIEW CHART */}
        <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-12 gap-2">
          {/* LEFT / CENTER MODULE CONTENT (12 Cols on Mobile, 6 Cols on LG) */}
          <div className={`${activeScreen === 'CHART' ? 'hidden lg:flex' : 'col-span-12 flex'} lg:col-span-6 flex-col min-h-0 overflow-y-auto pr-0.5 space-y-2`}>
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

              {/* TRADEBOT 4 ACCOUNTING METRICS (DYNAMIC LANG) */}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-2">
                {/* 1. FREE BALANCE */}
                <div className="bg-black border border-zinc-800 p-2 sm:p-2.5 rounded">
                  <div className="text-slate-400 text-[10px] sm:text-xs font-bold tracking-wider mb-0.5 sm:mb-1">
                    {lang === 'EN' ? 'FREE BALANCE' : 'SOLD DISPONIBIL'}
                  </div>
                  <div className="text-base sm:text-xl font-bold font-mono text-amber-400">
                    ${freeBalance.toFixed(2)}
                  </div>
                </div>

                {/* 2. MARGIN (INVESTED) */}
                <div className="bg-black border border-zinc-800 p-2 sm:p-2.5 rounded">
                  <div className="text-slate-400 text-[10px] sm:text-xs font-bold tracking-wider mb-0.5 sm:mb-1">
                    {lang === 'EN' ? 'MARGIN (INVESTED)' : 'MARJĂ INVESTITĂ'}
                  </div>
                  <div className="text-base sm:text-xl font-bold font-mono text-amber-400">
                    ${marginInvested.toFixed(2)}
                  </div>
                </div>

                {/* 3. TOTAL EQUITY */}
                <div className="bg-black border border-emerald-500/50 p-2 sm:p-2.5 rounded shadow-[0_0_12px_rgba(16,185,129,0.12)]">
                  <div className="text-emerald-400 text-[10px] sm:text-xs font-bold tracking-wider mb-0.5 sm:mb-1">
                    {lang === 'EN' ? 'TOTAL EQUITY' : 'VALOARE TOTALĂ (EQUITY)'}
                  </div>
                  <div className="text-base sm:text-xl font-bold font-mono text-emerald-400">
                    ${currentEquity.toFixed(2)}
                  </div>
                </div>

                {/* 4. UNREALIZED PNL */}
                <div className="bg-black border border-zinc-800 p-2 sm:p-2.5 rounded">
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
                <div className="bg-black border border-zinc-800 p-2 sm:p-2.5 rounded">
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

                {/* 6. ACTIVE POSITIONS & OKX SENTIMENT */}
                <div className="border p-2 sm:p-2.5 rounded flex flex-col justify-between transition-all bg-black border-zinc-800">
                  <div className="flex items-center justify-between mb-0.5 sm:mb-1">
                    <div className="text-slate-400 text-[10px] sm:text-xs font-bold tracking-wider">
                      {lang === 'EN' ? 'ACTIVE POSITIONS' : 'POZIȚII ACTIVE'}
                    </div>
                    <div className={`flex items-center gap-2 rounded px-2.5 py-1 text-xs font-mono border transition-all ${
                      isBullishSentiment
                        ? 'bg-emerald-950/60 border-emerald-500/50 text-emerald-300'
                        : isBearishSentiment
                        ? 'bg-rose-950/60 border-rose-500/50 text-rose-300'
                        : 'bg-zinc-900 border-zinc-700 text-zinc-300'
                    }`}>
                      <span className="font-bold">
                        {status?.marketSentiment ? (lang === 'EN' ? status.marketSentiment.replace('BULLISH', 'BULLISH').replace('BEARISH', 'BEARISH').replace('NEUTRAL', 'NEUTRAL') : status.marketSentiment) : (lang === 'EN' ? 'OKX NEUTRAL' : 'OKX NEUTRU')}
                      </span>
                      <button onClick={async () => {
                          const token = localStorage.getItem('tb5_control_token') || 'tradebot5_admin_token';
                          await fetch('/api/bot/sentiment/refresh', { method: 'POST', headers: { 'x-bot-token': token } });
                          onRefresh();
                      }} className="hover:text-white transition-colors p-0.5" title="Reîmprospătează sentimentul global OKX">
                        <RefreshCw className="w-3.5 h-3.5" />
                      </button>
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
                  <div className="flex items-center space-x-2 mb-1.5">
                    <ShieldAlert className="w-4 h-4 text-amber-500 shrink-0" />
                    <h3 className="font-bold text-amber-500 uppercase tracking-wider text-xs flex items-center gap-2">
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
                  
                  <p className="text-xs text-slate-400 mb-2">
                    {!status.equityTrailingState.isEnabled || status.equityTrailingState.activationPct <= 0 || status.equityTrailingState.drawdownLimitPct <= 0
                      ? 'Protecția de capital este DEZACTIVATĂ (setată la 0%). Pozițiile sunt controlate exclusiv de Stop-Loss, Trailing Stop și Take-Profit individuale.'
                      : status.equityTrailingState.isActive 
                        ? `Urmărirea este activă. Se va închide automat la o retragere de ${status.equityTrailingState.drawdownLimitPct.toFixed(2)}% din vârful atins. Protecția a fost declanșată cu succes de ${status.equityTrailingState.triggerCount} ori până acum.`
                        : `Urmărirea se activează când contul atinge $${status.equityTrailingState.activationPrice.toFixed(2)} (+${status.equityTrailingState.activationPct.toFixed(2)}%). Până atunci pozițiile respiră liber. Protecția a fost declanșată cu succes de ${status.equityTrailingState.triggerCount} ori până acum.`}
                  </p>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
                    <div>
                      <div className="text-slate-400 tracking-wider mb-0.5">PRAG ACTIVARE</div>
                      <div className="font-bold text-emerald-400">
                        ${status.equityTrailingState.activationPrice.toFixed(2)} <span className="text-[10px]">(+{status.equityTrailingState.activationPct.toFixed(2)}%)</span>
                      </div>
                    </div>
                    <div>
                      <div className="text-slate-400 tracking-wider mb-0.5">HIGH-WATER MARK (PEAK)</div>
                      <div className="font-bold text-amber-100">
                        ${status.equityTrailingState.peakEquity.toFixed(2)}
                      </div>
                    </div>
                    <div>
                      <div className="text-slate-400 tracking-wider mb-0.5">PRAG VÂNZARE</div>
                      <div className="font-bold text-zinc-300">
                        {status.equityTrailingState.sellThreshold 
                          ? `$${status.equityTrailingState.sellThreshold.toFixed(2)}`
                          : 'În așteptare'}
                      </div>
                    </div>
                    <div>
                      <div className="text-slate-400 tracking-wider mb-0.5">RETRAGERE CURENTĂ</div>
                      <div className="font-bold text-emerald-400">
                        {status.equityTrailingState.currentDrawdownPct.toFixed(2)}%
                      </div>
                    </div>
                  </div>
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
                      <span className="font-bold text-rose-400">-{profileConfig?.hardStopLossPct ?? 2.5}%</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-slate-400">Break-Even:</span>
                      <span className="font-bold text-amber-300">+{profileConfig?.breakEvenActivationPct ?? 1.0}%</span>
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
                      <span className="font-bold text-emerald-400">+{profileConfig?.trailingActivationPct ?? 1.5}%</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-slate-400">Pas Urmărire:</span>
                      <span className="font-bold text-purple-300">-{profileConfig?.trailingDistancePct ?? 0.4}%</span>
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
                      <span className="text-slate-400">Min Score:</span>
                      <span className="font-bold text-cyan-400">{profileConfig?.minMomentumScore ?? 60}/100</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-slate-400">Hold / CD:</span>
                      <span className="font-bold text-amber-300">
                        {profileConfig?.maxHoldingTimeMinutes ?? 60}m / {profileConfig?.cooldownMinutes ?? 5}m
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
                    Bază Capital: <strong className="text-amber-300">$200.00</strong>
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

          {(activeScreen === 'POS' || activeScreen === 'TAPE') && (
            <div className="bg-zinc-950 border border-amber-500/30 rounded p-2 sm:p-3 flex flex-col flex-1 min-h-0">
              {/* Frozen Header for POS */}
              <div className="sticky top-0 z-10 bg-zinc-950 pb-1">
                <div className="flex flex-wrap items-center justify-between border-b border-amber-500/30 pb-2 mb-3 gap-2">
                  <div className="flex items-center space-x-2">
                    <Activity className="w-4 h-4 text-amber-500" />
                    <span className="font-bold text-xs sm:text-sm tracking-wider text-amber-400">
                      F2: OPEN POSITIONS &amp; ACTIVE EXPOSURE
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

                <div className="bg-zinc-900/80 rounded border border-amber-500/20 overflow-hidden flex flex-col flex-1 min-h-0">
                  <div className="text-xs font-bold text-amber-400 p-2 sm:p-2.5 border-b border-amber-500/30 flex items-center justify-between bg-zinc-950">
                    <span className="tracking-wide text-[11px] sm:text-xs">TOP SCANNED OPPORTUNITIES ({status?.scannerStats?.topOpportunities?.length || 0})</span>
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
                                <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                                  opp.side === 'SELL' ? 'bg-rose-950 text-rose-400 border border-rose-800/60' : 'bg-emerald-950 text-emerald-400 border border-emerald-800/60'
                                }`}>
                                  {opp.side === 'SELL' ? 'SHORT' : 'LONG'}
                                </span>
                              </td>
                              <td className="py-2 px-3 text-slate-300 font-mono">${opp.price}</td>
                              <td className="py-2 px-3 text-emerald-400 font-bold">{opp.rvol}x</td>
                              <td className="py-2 px-3 text-amber-400 font-bold">{opp.score}/100</td>
                              <td className="py-2 px-3 text-right">
                                <span className={`px-2 py-0.5 rounded font-bold text-[10px] ${
                                  opp.isEligible 
                                    ? 'bg-emerald-950 text-emerald-400 border border-emerald-800' 
                                    : opp.score > 82
                                    ? 'bg-rose-950/80 text-rose-400 border border-rose-800/80'
                                    : 'bg-zinc-800 text-zinc-400'
                                }`}>
                                  {opp.isEligible ? 'ELIGIBLE' : opp.score > 82 ? 'BLOCKED (>82)' : 'FILTERED'}
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

                {/* Control Action Buttons: Save Log (CSV/Excel) & Clear Log */}
                <div className="flex items-center space-x-1.5 sm:space-x-2">
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
                    <strong className="text-rose-400 text-xs">-{profileConfig?.hardStopLossPct ?? 2.5}%</strong>
                  </div>
                  <div className="bg-black/60 border border-zinc-800 rounded px-2.5 py-1.5">
                    <span className="text-slate-400 block text-[9px] uppercase">Break-Even Act</span>
                    <strong className="text-amber-300 text-xs">+{profileConfig?.breakEvenActivationPct ?? 1.0}%</strong>
                  </div>
                  <div className="bg-black/60 border border-zinc-800 rounded px-2.5 py-1.5">
                    <span className="text-slate-400 block text-[9px] uppercase">Trailing Act</span>
                    <strong className="text-emerald-400 text-xs">+{profileConfig?.trailingActivationPct ?? 1.5}%</strong>
                  </div>
                  <div className="bg-black/60 border border-zinc-800 rounded px-2.5 py-1.5">
                    <span className="text-slate-400 block text-[9px] uppercase">Trailing Dist</span>
                    <strong className="text-purple-400 text-xs">-{profileConfig?.trailingDistancePct ?? 0.4}%</strong>
                  </div>

                  <div className="bg-black/60 border border-zinc-800 rounded px-2.5 py-1.5">
                    <span className="text-slate-400 block text-[9px] uppercase">Take-Profit</span>
                    <strong className="text-emerald-400 text-xs">
                      {!profileConfig?.takeProfitPct || profileConfig.takeProfitPct === 0 ? 'OFF (Trailing)' : `+${profileConfig.takeProfitPct}%`}
                    </strong>
                  </div>
                  <div className="bg-black/60 border border-zinc-800 rounded px-2.5 py-1.5">
                    <span className="text-slate-400 block text-[9px] uppercase">Max Hold Time</span>
                    <strong className="text-amber-300 text-xs">{profileConfig?.maxHoldingTimeMinutes ?? 60} min</strong>
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
                      [{profileConfig?.minMomentumScore ?? 60} - {profileConfig?.maxMomentumScore ?? 82}]
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

                  {/* Min Momentum Score - step 1 - Configurable between 57 and 82 */}
                  <div className="bg-zinc-900 p-3 rounded border border-amber-500/20 space-y-2">
                    <div className="flex justify-between items-center">
                      <span className="text-slate-300">Min Momentum Score (Prag Intrare)</span>
                      <span className="font-bold text-amber-400">{minMomentum} / 100</span>
                    </div>
                    <input
                      type="range"
                      min="57"
                      max="82"
                      step="1"
                      value={minMomentum}
                      onChange={(e) => setMinMomentum(Number(e.target.value))}
                      className="w-full accent-amber-500 cursor-pointer"
                    />
                    <div className="flex justify-between text-[10px] text-zinc-400">
                      <span>Min: 57</span>
                      <span className="text-amber-300 font-semibold">Tavan Max Semnal: 82 (Hard Cap anti-exhaustion)</span>
                      <span>Max: 82</span>
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

                  {/* OPTION 2: OKX TESTNET (DEMO) */}
                  <div
                    onClick={() => handleSwitchExecutionModeWithCheck('TESTNET')}
                    className={`cursor-pointer p-3 rounded border transition-all flex flex-col justify-between ${
                      status?.executionMode === 'TESTNET'
                        ? 'bg-amber-950/40 border-amber-500 shadow-md shadow-amber-950/50 ring-1 ring-amber-500'
                        : 'bg-zinc-900/60 border-zinc-800 hover:border-amber-500/50 hover:bg-zinc-900'
                    }`}
                  >
                    <div className="space-y-1.5 mb-3">
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-xs text-amber-400 flex items-center space-x-1.5">
                          <span className="w-2.5 h-2.5 rounded-full bg-amber-500 inline-block"></span>
                          <span>2. OKX TESTNET (DEMO)</span>
                        </span>
                        {status?.executionMode === 'TESTNET' && (
                          <span className="text-[10px] bg-amber-950 text-amber-300 px-1.5 py-0.2 rounded border border-amber-600/60 font-bold">
                            ACTIV
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-zinc-300 leading-relaxed">
                        Conexiune via API la <strong>Simulated Trading OKX</strong> (header <code>x-simulated-trading: 1</code>). Testează ordinele și WebSocket-urile reale pe OKX fără risc financiar.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleSwitchExecutionModeWithCheck('TESTNET');
                      }}
                      className={`w-full py-1 rounded text-xs font-bold transition-all ${
                        status?.executionMode === 'TESTNET'
                          ? 'bg-amber-500/20 text-amber-300 border border-amber-500/50 cursor-default'
                          : 'bg-zinc-800 hover:bg-amber-500 hover:text-black text-zinc-300'
                      }`}
                    >
                      {status?.executionMode === 'TESTNET' ? '✓ MOD CURENT ACTIV' : 'COMUTĂ LA OKX DEMO'}
                    </button>
                  </div>

                  {/* OPTION 3: OKX LIVE (REAL) */}
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
                          <span>3. OKX LIVE (CONT REAL)</span>
                        </span>
                        {status?.executionMode === 'LIVE' && (
                          <span className="text-[10px] bg-rose-950 text-rose-300 px-1.5 py-0.2 rounded border border-rose-600/60 font-bold animate-pulse">
                            LIVE REAL
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-zinc-300 leading-relaxed">
                        Execuție de ordine reale pe bursa <strong>OKX USDT SWAP Perpetuals</strong> cu fonduri reale din cont. Necesită chei API cu permisiuni de tranzacționare.
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
        </div>

          {/* RIGHT MODULE PANEL: TRADINGVIEW CHART (6 Cols on LG, Hidden on Mobile unless CHART selected) */}
          <div className={`${activeScreen === 'CHART' ? 'col-span-12 flex' : 'hidden'} lg:flex lg:col-span-6 flex-col min-h-0`}>
            <TradingViewChart
              currentSymbol={chartSymbol}
              onSymbolChange={(sym) => setChartSymbol(sym)}
              availableSymbols={allUniverseSymbols}
              lang={lang}
            />
          </div>
        </div>

        {/* BOTTOM WIDE MODULE: DESK AUDIT FEED (ADAPTIVE HEIGHT, FULL SCREEN FIT WITH ZERO PAGE SCROLL) */}
        <div className="h-36 sm:h-44 lg:h-52 shrink-0 flex flex-col min-h-0">
          <div className="bg-zinc-950 border border-amber-500/30 rounded p-2.5 flex flex-col h-full min-h-0 shadow-lg">
            <div className="flex flex-wrap items-center justify-between gap-1.5 border-b border-amber-500/30 pb-1.5 mb-1.5 shrink-0">
              <div className="flex items-center space-x-2">
                <Terminal className="w-4 h-4 text-amber-500" />
                <span className="font-bold text-xs tracking-wider text-amber-400">DESK AUDIT FEED</span>
                <span className="text-[10px] text-slate-400 font-mono">({logs.length} evenimente)</span>
                <span className="text-[10px] text-zinc-500 hidden sm:inline">— Feed de audit în timp real</span>
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

            {/* Scrollable event list adapted to fill available height cleanly */}
            <div className="flex-1 min-h-0 overflow-y-auto space-y-1 font-mono text-[11px] pr-1">
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
                Capital: ${status?.equity !== undefined ? status.equity.toFixed(2) : '200.00'} USDT
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

              {/* Testnet */}
              <div
                onClick={() => handleSwitchExecutionModeWithCheck('TESTNET')}
                className={`p-3 rounded border cursor-pointer transition-all flex flex-col justify-between ${
                  status?.executionMode === 'TESTNET'
                    ? 'bg-amber-950/50 border-amber-500 ring-1 ring-amber-500'
                    : 'bg-zinc-900 border-zinc-800 hover:border-amber-500/40'
                }`}
              >
                <div className="space-y-1 mb-2">
                  <span className="text-xs font-bold text-amber-400 block">🟡 OKX TESTNET (DEMO)</span>
                  <p className="text-[11px] text-zinc-300 leading-tight">
                    Simulated Trading API OKX. Fără bani reali. Header simulated activ.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleSwitchExecutionModeWithCheck('TESTNET');
                  }}
                  className={`w-full py-1 rounded text-xs font-bold ${
                    status?.executionMode === 'TESTNET'
                      ? 'bg-amber-500 text-black cursor-default'
                      : 'bg-zinc-800 text-zinc-300 hover:bg-amber-500 hover:text-black'
                  }`}
                >
                  {status?.executionMode === 'TESTNET' ? '✓ ACTIV' : 'COMUTĂ'}
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
              <span className="text-amber-400 font-bold text-xs flex items-center space-x-1.5">
                <Key className="w-3.5 h-3.5" />
                <span>CREDENTIALE OKX (API KEY, SECRET, PASSPHRASE)</span>
              </span>

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

              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 pt-2 border-t border-zinc-900">
                <label className="flex items-center space-x-2 text-xs text-zinc-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={okxTestnetInput}
                    onChange={(e) => setOkxTestnetInput(e.target.checked)}
                    className="accent-amber-500 cursor-pointer"
                  />
                  <span>Mod Testnet Demo (<code>x-simulated-trading: 1</code>)</span>
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
                    className="px-3.5 py-1.5 bg-amber-500 hover:bg-amber-400 text-black rounded text-xs font-bold flex items-center space-x-1.5 disabled:opacity-40"
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
                <div className={`p-2.5 rounded border text-xs font-mono space-y-1 ${
                  okxTestFeedback.authenticated
                    ? 'bg-emerald-950/60 border-emerald-500 text-emerald-300'
                    : okxTestFeedback.reachable
                    ? 'bg-amber-950/60 border-amber-500 text-amber-300'
                    : 'bg-rose-950/60 border-rose-500 text-rose-300'
                }`}>
                  <div className="font-bold flex items-center space-x-1.5">
                    {okxTestFeedback.authenticated ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                    ) : (
                      <AlertTriangle className="w-4 h-4 text-amber-400" />
                    )}
                    <span>REZULTAT TEST CONEXIUNE OKX:</span>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-1 text-[11px]">
                    <div>• Ping API: <strong>{okxTestFeedback.reachable ? '✅ OK' : '❌ FAIL'}</strong></div>
                    <div>• Autentificare: <strong>{okxTestFeedback.authenticated ? '✅ VALIDE' : '❌ EȘUATĂ'}</strong></div>
                    <div>• Sold USDT: <strong>{okxTestFeedback.equity !== undefined ? `$${okxTestFeedback.equity.toFixed(2)}` : '--'}</strong></div>
                  </div>
                  {okxTestFeedback.error && (
                    <div className="text-[11px] text-rose-300 pt-1">
                      ⚠️ Eroare: {okxTestFeedback.error}
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
    </div>
  );
};
