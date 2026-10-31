/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  BotStatusResponse,
  AuditLog,
  OrderRecord,
  ExecutionMode,
  ProfileType,
  GridBotInstance,
  GridCandidateAnalysis,
  GridSpacingType,
  ExchangePlatformId,
} from '../shared/types';
import {
  Terminal,
  Activity,
  ShieldAlert,
  ShieldCheck,
  Zap,
  RefreshCw,
  Search,
  Sliders,
  Play,
  Square,
  AlertTriangle,
  Send,
  List,
  Save,
  Trash2,
  Key,
  CheckCircle2,
  XCircle,
  Layers,
  TrendingUp,
  ArrowUpDown,
  Settings,
  Eye,
  EyeOff,
  Download,
} from 'lucide-react';
import { formatPrice, formatTimeLocal, formatDateTimeLocal } from '../shared/formatters';
import { OKXFeeCalculatorModal } from './OKXFeeCalculatorModal';
import { OKXNativeGridPanel } from './OKXNativeGridPanel';

interface BloombergTerminalProps {
  status: BotStatusResponse | null;
  logs: AuditLog[];
  orders: OrderRecord[];
  telemetry?: {
    tickCount: number;
    lastSyncAt: number;
    pingMs: number;
    rxFlash: boolean;
  };
  onRefresh: () => void;
  onSwitchMode: (mode: ExecutionMode) => void;
  onSwitchProfile: (profile: ProfileType) => void;
  onUpdateProfileSettings: (
    profileType: ProfileType,
    settings: any
  ) => Promise<{ success: boolean; error?: string; errors?: string[] }> | void;
  onClosePosition: (symbol: string) => void;
  onResetPaper: () => void;
  onToggleKillSwitch: () => void;
  onTriggerScan: () => void;
  onClearLogs?: () => void;
  onClearOrders?: () => void;
  onUpdateCredentials?: (
    apiKey: string,
    secretKey: string,
    passphrase: string,
    testnet: boolean,
    region?: 'EEA' | 'GLOBAL' | 'AUTO'
  ) => Promise<{ success: boolean; error?: string }>;
  onTestOKXConnection?: (creds?: any) => Promise<any>;
  onUpdateLeverage?: (
    leverage: number,
    marginMode: 'cross' | 'isolated',
    enabled: boolean
  ) => Promise<{ success: boolean; error?: string }>;
  onSaveTelegramConfig?: (
    token: string,
    chatId: string,
    botUsername?: string
  ) => Promise<{ success: boolean; message?: string; error?: string }>;
  onTestTelegramConnection?: (
    token?: string,
    chatId?: string
  ) => Promise<{
    success: boolean;
    reachable: boolean;
    validToken: boolean;
    botUsername?: string;
    botName?: string;
    chatDelivered?: boolean;
    error?: string;
  }>;
  controlToken: string;
  onUpdateControlToken: (token: string) => void;
  errorMessage: string | null;
  successMessage: string | null;
  onDismissAlert?: () => void;
}

export const BloombergTerminal: React.FC<BloombergTerminalProps> = ({
  status,
  logs,
  orders,
  telemetry,
  onRefresh,
  onSwitchMode,
  onUpdateProfileSettings,
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
  const [activeTab, setActiveTab] = useState<
    'DASHBOARD' | 'NATIVE_GRID' | 'CONFIG' | 'SCANNER' | 'LADDER' | 'JOURNAL' | 'API'
  >('NATIVE_GRID');
  const [mobileDashView, setMobileDashView] = useState<'BOTS' | 'LAUNCH'>('BOTS');
  const [showFeeCalculatorModal, setShowFeeCalculatorModal] = useState<boolean>(false);

  const profile = status?.profileConfig;
  const gridBots: GridBotInstance[] = status?.gridBots || [];
  const runningBots = useMemo(
    () => gridBots.filter((b) => b.status === 'RUNNING'),
    [gridBots]
  );
  const gridCandidates: GridCandidateAnalysis[] =
    status?.gridCandidates || status?.scannerStats?.gridCandidates || [];
  const recentArbitrages = status?.recentArbitrages || [];
  const feeTierInfo = status?.feeTierInfo;
  const nativeGridBots = status?.nativeGridBots || [];
  const runningNativeBotsCount = useMemo(
    () => nativeGridBots.filter((b) => b.state === 'running').length,
    [nativeGridBots]
  );
  const nativeGridOpportunities = status?.nativeGridOpportunities || [];
  const nativeGridAutopilot = status?.nativeGridAutopilot;

  // =========================================================================
  // LIVE HEARTBEAT CLOCK, COUNTDOWN & PRICE CHANGE FLASH TRACKER
  // =========================================================================
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);

  const prevBotPricesRef = useRef<Record<string, { price: number; pnl: number }>>({});
  const [botFlashes, setBotFlashes] = useState<
    Record<string, { priceDir?: 'up' | 'down'; pnlDir?: 'up' | 'down'; ts: number }>
  >({});

  useEffect(() => {
    if (!gridBots || gridBots.length === 0) return;
    const now = Date.now();
    const updates: Record<
      string,
      { priceDir?: 'up' | 'down'; pnlDir?: 'up' | 'down'; ts: number }
    > = {};
    let hasChange = false;

    for (const b of gridBots) {
      const prev = prevBotPricesRef.current[b.botId];
      if (prev) {
        const priceDir =
          b.currentPrice > prev.price
            ? 'up'
            : b.currentPrice < prev.price
            ? 'down'
            : undefined;
        const pnlDir =
          b.totalNetPnlUSDT > prev.pnl
            ? 'up'
            : b.totalNetPnlUSDT < prev.pnl
            ? 'down'
            : undefined;
        if (priceDir || pnlDir) {
          updates[b.botId] = { priceDir, pnlDir, ts: now };
          hasChange = true;
        }
      }
      prevBotPricesRef.current[b.botId] = {
        price: b.currentPrice,
        pnl: b.totalNetPnlUSDT,
      };
    }

    if (hasChange) {
      setBotFlashes((old) => ({ ...old, ...updates }));
    }
  }, [gridBots]);

  // =========================================================================
  // NEUTRAL GRID BOT CONFIGURATOR STATE (Toate setările botului)
  // =========================================================================
  const [selectedSymbol, setSelectedSymbol] = useState<string>('');
  const [platform, setPlatform] = useState<ExchangePlatformId>('OKX_EEA');
  const [configMode, setConfigMode] = useState<'AUTO' | 'MANUAL'>('MANUAL');
  const [lowerPrice, setLowerPrice] = useState<number>(0);
  const [upperPrice, setUpperPrice] = useState<number>(0);
  const [gridCount, setGridCount] = useState<number>(profile?.gridCount || 12);
  const [gridType, setGridType] = useState<GridSpacingType>(
    profile?.gridType || 'ARITHMETIC'
  );
  const [marginInvestedUSDT, setMarginInvestedUSDT] = useState<number>(
    profile?.marginInvestedUSDT || 50
  );
  const [leverage, setLeverage] = useState<number>(profile?.leverage || 3);
  const [marginMode, setMarginMode] = useState<'cross' | 'isolated'>(
    profile?.marginMode || 'cross'
  );

  // Stop Loss (SL) & Take Profit (TP)
  const [stopLossPct, setStopLossPct] = useState<number>(profile?.stopLossPct ?? 8.0);
  const [takeProfitPct, setTakeProfitPct] = useState<number>(
    profile?.takeProfitPct ?? 15.0
  );
  const [lowerStopPrice, setLowerStopPrice] = useState<string>('');
  const [upperStopPrice, setUpperStopPrice] = useState<string>('');
  const [stopOnRangeBreakout, setStopOnRangeBreakout] = useState<boolean>(
    profile?.stopOnRangeBreakout ?? true
  );

  // Martingale Settings
  const [martingaleEnabled, setMartingaleEnabled] = useState<boolean>(
    profile?.martingaleEnabled ?? false
  );
  const [martingaleMultiplier, setMartingaleMultiplier] = useState<number>(
    profile?.martingaleMultiplier || 1.15
  );
  const [martingaleMaxSteps, setMartingaleMaxSteps] = useState<number>(
    profile?.martingaleMaxSteps || 5
  );
  const [maxExposureUSDT, setMaxExposureUSDT] = useState<number>(
    profile?.maxExposureUSDT || 150
  );
  const [autoDeployTopCandidate, setAutoDeployTopCandidate] = useState<boolean>(
    profile?.autoDeployTopCandidate ?? false
  );

  // =========================================================================
  // CONFIGURABLE AUTOPILOT STATE (Coexistă cu Lansarea Manuală)
  // =========================================================================
  const serverAutopilot = status?.autopilot || status?.config?.autopilot;
  const [apEnabled, setApEnabled] = useState<boolean>(
    serverAutopilot?.enabled ?? false
  );
  const [apScanIntervalSec, setApScanIntervalSec] = useState<number>(
    serverAutopilot?.scanIntervalSec || 60
  );
  const [apMaxScannedSymbols, setApMaxScannedSymbols] = useState<number>(
    serverAutopilot?.maxScannedSymbols || 12
  );
  const [apMinScore, setApMinScore] = useState<number>(
    serverAutopilot?.minSuitabilityScore || 70
  );
  const [apMaxBots, setApMaxBots] = useState<number>(
    serverAutopilot?.maxConcurrentBots || 2
  );
  const [apMarginPerBot, setApMarginPerBot] = useState<number>(
    serverAutopilot?.marginPerBotUSDT || 15
  );
  const [apMinReserve, setApMinReserve] = useState<number>(
    serverAutopilot?.minReserveUSDT ?? 5
  );
  const [apUseAnalyzerLeverage, setApUseAnalyzerLeverage] = useState<boolean>(
    serverAutopilot?.useAnalyzerLeverage ?? true
  );
  const [apDefaultLeverage, setApDefaultLeverage] = useState<number>(
    serverAutopilot?.defaultLeverage || 3
  );
  const [apMarginMode, setApMarginMode] = useState<'cross' | 'isolated'>(
    serverAutopilot?.defaultMarginMode || 'isolated'
  );
  const [apGridType, setApGridType] = useState<GridSpacingType>(
    serverAutopilot?.defaultGridType || 'ARITHMETIC'
  );
  const [apStopLossPct, setApStopLossPct] = useState<number>(
    serverAutopilot?.stopLossPct || 8.0
  );
  const [apTakeProfitPct, setApTakeProfitPct] = useState<number>(
    serverAutopilot?.takeProfitPct || 15.0
  );
  const [apStopOnBreakout, setApStopOnBreakout] = useState<boolean>(
    serverAutopilot?.stopOnRangeBreakout ?? true
  );
  const [apCooldownMin, setApCooldownMin] = useState<number>(
    serverAutopilot?.cooldownMinutesPerSymbol ?? 15
  );
  const [apOnlyIdealRegime, setApOnlyIdealRegime] = useState<boolean>(
    serverAutopilot?.onlyIdealOrGoodRegime ?? true
  );
  const [isSavingAutopilot, setIsSavingAutopilot] = useState<boolean>(false);
  const [isRunningAutopilotNow, setIsRunningAutopilotNow] = useState<boolean>(false);

  const hasHydratedAutopilot = useRef<boolean>(false);
  const hasHydratedProfile = useRef<boolean>(false);

  // Helper to immediately persist leverage & marginMode choice across UI, localStorage, and backend
  const syncLeverageAndMarginMode = (
    nextLeverage: number,
    nextMarginMode: 'cross' | 'isolated'
  ) => {
    const validMode: 'cross' | 'isolated' =
      nextMarginMode === 'isolated' ? 'isolated' : 'cross';
    const validLev = Math.max(1, Math.min(20, Number(nextLeverage) || 3));
    setLeverage(validLev);
    setMarginMode(validMode);
    setApDefaultLeverage(validLev);
    setApMarginMode(validMode);
    try {
      localStorage.setItem(
        'tb5_leverage_pref',
        JSON.stringify({ leverage: validLev, marginMode: validMode })
      );
      const savedRaw = localStorage.getItem('tb5_autopilot_backup');
      if (savedRaw) {
        const parsed = JSON.parse(savedRaw);
        parsed.defaultLeverage = validLev;
        parsed.defaultMarginMode = validMode;
        localStorage.setItem('tb5_autopilot_backup', JSON.stringify(parsed));
      }
    } catch {}
    fetch('/api/bot/leverage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-bot-token': controlToken,
      },
      body: JSON.stringify({
        leverage: validLev,
        marginMode: validMode,
        enabled: true,
      }),
    }).catch(() => {});
  };

  // Hydrate manual profile leverage & marginMode on initial load
  useEffect(() => {
    if (hasHydratedProfile.current) return;
    try {
      const savedPrefRaw = localStorage.getItem('tb5_leverage_pref');
      if (savedPrefRaw) {
        const savedPref = JSON.parse(savedPrefRaw);
        if (savedPref && (savedPref.marginMode === 'isolated' || savedPref.marginMode === 'cross')) {
          hasHydratedProfile.current = true;
          const mode: 'cross' | 'isolated' =
            savedPref.marginMode === 'isolated' ? 'isolated' : 'cross';
          const lev = Number(savedPref.leverage) || profile?.leverage || 3;
          setMarginMode(mode);
          setApMarginMode(mode);
          setLeverage(lev);
          setApDefaultLeverage(lev);
          fetch('/api/bot/leverage', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-bot-token': controlToken,
            },
            body: JSON.stringify({ leverage: lev, marginMode: mode, enabled: true }),
          }).catch(() => {});
          return;
        }
      }
    } catch {}

    if (profile) {
      hasHydratedProfile.current = true;
      const serverMode: 'cross' | 'isolated' =
        profile.marginMode === 'isolated' || status?.config?.marginMode === 'isolated'
          ? 'isolated'
          : 'cross';
      const serverLev = profile.leverage || status?.config?.maxLeverage || 3;
      setMarginMode(serverMode);
      setLeverage(serverLev);
      if (profile.marginInvestedUSDT) setMarginInvestedUSDT(profile.marginInvestedUSDT);
      if (profile.gridCount) setGridCount(profile.gridCount);
      if (profile.gridType) setGridType(profile.gridType);
      if (profile.stopLossPct !== undefined) setStopLossPct(profile.stopLossPct);
      if (profile.takeProfitPct !== undefined) setTakeProfitPct(profile.takeProfitPct);
    }
  }, [profile, status?.config?.marginMode, status?.config?.maxLeverage]);

  // Sync Autopilot config from backend status on initial load & auto-restore if container reset
  useEffect(() => {
    if (!serverAutopilot) return;

    // If the container just reset from hibernation (fresh default state with lastAutopilotCheckAt === 0 and enabled === false),
    // automatically restore the user's last saved Autopilot configuration from localStorage!
    if (
      !hasHydratedAutopilot.current &&
      !serverAutopilot.enabled &&
      (!serverAutopilot.lastAutopilotCheckAt || serverAutopilot.lastAutopilotCheckAt === 0)
    ) {
      try {
        const savedRaw = localStorage.getItem('tb5_autopilot_backup');
        if (savedRaw) {
          const savedAp = JSON.parse(savedRaw);
          if (savedAp && typeof savedAp === 'object') {
            hasHydratedAutopilot.current = true;
            setApEnabled(Boolean(savedAp.enabled));
            if (savedAp.scanIntervalSec) setApScanIntervalSec(savedAp.scanIntervalSec);
            if (savedAp.maxScannedSymbols) setApMaxScannedSymbols(savedAp.maxScannedSymbols);
            if (savedAp.minSuitabilityScore) setApMinScore(savedAp.minSuitabilityScore);
            if (savedAp.maxConcurrentBots) setApMaxBots(savedAp.maxConcurrentBots);
            if (savedAp.marginPerBotUSDT) setApMarginPerBot(savedAp.marginPerBotUSDT);
            if (savedAp.minReserveUSDT !== undefined) setApMinReserve(savedAp.minReserveUSDT);
            if (typeof savedAp.useAnalyzerLeverage === 'boolean') setApUseAnalyzerLeverage(savedAp.useAnalyzerLeverage);
            if (savedAp.defaultLeverage) {
              setApDefaultLeverage(savedAp.defaultLeverage);
              setLeverage(savedAp.defaultLeverage);
            }
            if (savedAp.defaultMarginMode === 'isolated' || savedAp.defaultMarginMode === 'cross') {
              setApMarginMode(savedAp.defaultMarginMode);
              setMarginMode(savedAp.defaultMarginMode);
            }
            if (savedAp.defaultGridType) setApGridType(savedAp.defaultGridType);
            if (savedAp.stopLossPct) setApStopLossPct(savedAp.stopLossPct);
            if (savedAp.takeProfitPct) setApTakeProfitPct(savedAp.takeProfitPct);
            if (typeof savedAp.stopOnRangeBreakout === 'boolean') setApStopOnBreakout(savedAp.stopOnRangeBreakout);
            if (savedAp.cooldownMinutesPerSymbol !== undefined) setApCooldownMin(savedAp.cooldownMinutesPerSymbol);
            if (typeof savedAp.onlyIdealOrGoodRegime === 'boolean') setApOnlyIdealRegime(savedAp.onlyIdealOrGoodRegime);

            fetch('/api/bot/grid/autopilot', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-bot-token': controlToken,
              },
              body: JSON.stringify(savedAp),
            })
              .then(() => onRefresh())
              .catch(() => {});
            return;
          }
        }
      } catch {}
    }

    if (typeof serverAutopilot.enabled === 'boolean') {
      setApEnabled(serverAutopilot.enabled);
    }
    if (!hasHydratedAutopilot.current) {
      hasHydratedAutopilot.current = true;
      if (serverAutopilot.scanIntervalSec) setApScanIntervalSec(serverAutopilot.scanIntervalSec);
      if (serverAutopilot.maxScannedSymbols) setApMaxScannedSymbols(serverAutopilot.maxScannedSymbols);
      if (serverAutopilot.minSuitabilityScore) setApMinScore(serverAutopilot.minSuitabilityScore);
      if (serverAutopilot.maxConcurrentBots) setApMaxBots(serverAutopilot.maxConcurrentBots);
      if (serverAutopilot.marginPerBotUSDT) setApMarginPerBot(serverAutopilot.marginPerBotUSDT);
      if (serverAutopilot.minReserveUSDT !== undefined) setApMinReserve(serverAutopilot.minReserveUSDT);
      if (typeof serverAutopilot.useAnalyzerLeverage === 'boolean') setApUseAnalyzerLeverage(serverAutopilot.useAnalyzerLeverage);
      if (serverAutopilot.defaultLeverage) setApDefaultLeverage(serverAutopilot.defaultLeverage);
      if (serverAutopilot.defaultMarginMode) setApMarginMode(serverAutopilot.defaultMarginMode);
      if (serverAutopilot.defaultGridType) setApGridType(serverAutopilot.defaultGridType);
      if (serverAutopilot.stopLossPct) setApStopLossPct(serverAutopilot.stopLossPct);
      if (serverAutopilot.takeProfitPct) setApTakeProfitPct(serverAutopilot.takeProfitPct);
      if (typeof serverAutopilot.stopOnRangeBreakout === 'boolean') setApStopOnBreakout(serverAutopilot.stopOnRangeBreakout);
      if (serverAutopilot.cooldownMinutesPerSymbol !== undefined) setApCooldownMin(serverAutopilot.cooldownMinutesPerSymbol);
      if (typeof serverAutopilot.onlyIdealOrGoodRegime === 'boolean') setApOnlyIdealRegime(serverAutopilot.onlyIdealOrGoodRegime);
    }
  }, [serverAutopilot]);

  // Live Optimizer Preview & Actions State
  const [liveSymbolPrice, setLiveSymbolPrice] = useState<number>(0);
  const [isOptimizing, setIsOptimizing] = useState<boolean>(false);
  const [isCreatingBot, setIsCreatingBot] = useState<boolean>(false);
  const [selectedBotIdForLadder, setSelectedBotIdForLadder] = useState<string | null>(
    null
  );
  const [localBanner, setLocalBanner] = useState<{
    type: 'success' | 'error' | 'info';
    text: string;
  } | null>(null);

  // Edit SL/TP Modal for an active bot
  const [editingBot, setEditingBot] = useState<GridBotInstance | null>(null);
  const [editSlPct, setEditSlPct] = useState<number>(8);
  const [editTpPct, setEditTpPct] = useState<number>(15);
  const [editLowerStop, setEditLowerStop] = useState<number>(0);
  const [editUpperStop, setEditUpperStop] = useState<number>(0);

  // Kill Switch Confirmation Modal state (prevents accidental trigger)
  const [showKillSwitchConfirm, setShowKillSwitchConfirm] = useState<boolean>(false);
  const [isExecutingKillSwitch, setIsExecutingKillSwitch] = useState<boolean>(false);

  // API & Credentials State (persisted across server/container restarts via server config + localStorage backup)
  const getInitialSavedCreds = () => {
    try {
      const raw = localStorage.getItem('tb5_okx_creds_backup');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') return parsed;
      }
    } catch {}
    return null;
  };
  const initialCreds = getInitialSavedCreds();

  const [apiKeyInput, setApiKeyInput] = useState<string>(
    status?.config?.okxApiKey || initialCreds?.apiKey || ''
  );
  const [secretKeyInput, setSecretKeyInput] = useState<string>(
    status?.config?.okxSecretKey || initialCreds?.secretKey || ''
  );
  const [passphraseInput, setPassphraseInput] = useState<string>(
    status?.config?.okxPassphrase || initialCreds?.passphrase || ''
  );
  const [okxRegionInput, setOkxRegionInput] = useState<'EEA' | 'GLOBAL' | 'AUTO'>(
    status?.config?.okxRegion || initialCreds?.region || 'EEA'
  );
  const [okxDemoMode, setOkxDemoMode] = useState<boolean>(
    status?.config?.testnet ?? initialCreds?.testnet ?? false
  );
  const hasHydratedCredentials = useRef<boolean>(false);
  const [showSecrets, setShowSecrets] = useState<boolean>(false);
  const [okxTestResult, setOkxTestResult] = useState<any>(null);
  const [isTestingOkx, setIsTestingOkx] = useState<boolean>(false);
  const [serverIp, setServerIp] = useState<string>('Se detectează...');

  // Sync & auto-recover OKX API credentials across page reloads and container restarts
  useEffect(() => {
    const serverCfg = status?.config;
    if (!serverCfg) return;

    const serverHasCreds = Boolean(
      serverCfg.okxApiKey && serverCfg.okxSecretKey && serverCfg.okxPassphrase
    );

    if (serverHasCreds) {
      if (!hasHydratedCredentials.current) {
        hasHydratedCredentials.current = true;
        setApiKeyInput(serverCfg.okxApiKey || '');
        setSecretKeyInput(serverCfg.okxSecretKey || '');
        setPassphraseInput(serverCfg.okxPassphrase || '');
        setOkxRegionInput(serverCfg.okxRegion || 'EEA');
        setOkxDemoMode(Boolean(serverCfg.testnet));
      }
      try {
        localStorage.setItem(
          'tb5_okx_creds_backup',
          JSON.stringify({
            apiKey: serverCfg.okxApiKey,
            secretKey: serverCfg.okxSecretKey,
            passphrase: serverCfg.okxPassphrase,
            testnet: Boolean(serverCfg.testnet),
            region: serverCfg.okxRegion || 'EEA',
          })
        );
      } catch {}
      return;
    }

    // Server config has empty credentials (e.g., container just restarted/recreated):
    // Automatically restore saved credentials (and LIVE mode if previously active) from localStorage!
    if (!hasHydratedCredentials.current) {
      const saved = getInitialSavedCreds();
      if (saved && saved.apiKey && saved.secretKey && saved.passphrase) {
        hasHydratedCredentials.current = true;
        setApiKeyInput(saved.apiKey);
        setSecretKeyInput(saved.secretKey);
        setPassphraseInput(saved.passphrase);
        setOkxRegionInput(saved.region || 'EEA');
        setOkxDemoMode(Boolean(saved.testnet));

        fetch('/api/bot/credentials', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-bot-token': controlToken,
          },
          body: JSON.stringify({
            apiKey: saved.apiKey,
            secretKey: saved.secretKey,
            passphrase: saved.passphrase,
            testnet: Boolean(saved.testnet),
            region: saved.region || 'EEA',
          }),
        })
          .then(async () => {
            try {
              const savedMode = localStorage.getItem('tb5_execution_mode_backup');
              if (savedMode === 'LIVE' && status?.executionMode !== 'LIVE') {
                await fetch('/api/bot/mode', {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'x-bot-token': controlToken,
                  },
                  body: JSON.stringify({ mode: 'LIVE' }),
                });
              }
            } catch {}
            onRefresh();
          })
          .catch(() => {});
      }
    }
  }, [status?.config, status?.executionMode]);

  // Telegram State
  const [tgToken, setTgToken] = useState<string>('');
  const [tgChatId, setTgChatId] = useState<string>(
    status?.telegramStatus?.chatId || ''
  );
  const [tgTestResult, setTgTestResult] = useState<any>(null);

  const authHeaders = () => ({
    'Content-Type': 'application/json',
    'x-bot-token': controlToken,
  });

  // Auto-select first running bot for ladder view
  useEffect(() => {
    if (!selectedBotIdForLadder && gridBots.length > 0) {
      setSelectedBotIdForLadder(gridBots[0].botId);
    }
  }, [gridBots, selectedBotIdForLadder]);

  // Auto-populate real symbol & live price bounds from OKX EEA scanner candidates (no mock prices)
  useEffect(() => {
    if (gridCandidates.length > 0 && (!selectedSymbol || selectedSymbol.endsWith('-USDT-SWAP') || lowerPrice <= 0 || upperPrice <= 0)) {
      const top = gridCandidates[0];
      setSelectedSymbol(top.symbol);
      setLiveSymbolPrice(top.price);
      setLowerPrice(top.recommendedLowerPrice);
      setUpperPrice(top.recommendedUpperPrice);
      setGridCount(top.recommendedGridCount);
    }
  }, [gridCandidates, selectedSymbol, lowerPrice, upperPrice]);

  // Fetch server IP when API tab opens
  useEffect(() => {
    if (activeTab === 'API') {
      fetch('/api/bot/server-ip')
        .then((r) => r.json())
        .then((d) => {
          if (d?.serverIp) setServerIp(d.serverIp);
        })
        .catch(() => {});
    }
  }, [activeTab]);

  const safeJson = async (res: Response): Promise<any> => {
    const text = await res.text();
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      return {
        success: false,
        error: `Serverul a returnat un răspuns temporar invalid (HTTP ${res.status}). Reîncercați în câteva secunde.`,
      };
    }
  };

  // Auto-optimize preview when user clicks "Auto-Optimizează din Piață"
  const handleAutoOptimize = async (symOverride?: string) => {
    const targetSym = symOverride || selectedSymbol;
    setIsOptimizing(true);
    setLocalBanner(null);
    try {
      const res = await fetch('/api/bot/grid/optimize', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          symbol: targetSym,
          marginInvestedUSDT,
        }),
      });
      const data = await safeJson(res);
      if (data.success) {
        setSelectedSymbol(data.symbol);
        setLiveSymbolPrice(data.currentPrice || 0);
        setLowerPrice(data.lowerPrice);
        setUpperPrice(data.upperPrice);
        setGridCount(data.gridCount);
        setGridType(data.gridType || 'ARITHMETIC');
        setStopLossPct(data.stopLossPct || 8);
        setTakeProfitPct(data.takeProfitPct || 15);
        if (data.preview) {
          setLowerStopPrice(String(data.preview.lowerStopPrice || ''));
          setUpperStopPrice(String(data.preview.upperStopPrice || ''));
        }
        setLocalBanner({
          type: 'info',
          text: `GridOptimizer a calculat automat parametrii optimi pentru ${data.symbol} (Preț curent: $${formatPrice(data.currentPrice)} | ATR: ${data.atrPct}% | Range 24h: ${data.range24hPct}%).`,
        });
      } else {
        setLocalBanner({
          type: 'error',
          text: data.error || 'Nu s-au putut calcula automat parametrii grilei.',
        });
      }
    } catch (err: any) {
      setLocalBanner({
        type: 'error',
        text: err.message || 'Eroare la comunicarea cu GridOptimizer.',
      });
    } finally {
      setIsOptimizing(false);
    }
  };

  // Apply quick ±% range around current price or midpoint
  const handleQuickRangeBand = (pct: number) => {
    const cand = gridCandidates.find((c) => c.symbol === selectedSymbol);
    const refPx =
      liveSymbolPrice > 0
        ? liveSymbolPrice
        : cand?.price || (lowerPrice + upperPrice) / 2 || 1;
    const decimals = refPx >= 1000 ? 1 : refPx >= 10 ? 2 : refPx >= 1 ? 3 : 4;
    const low = parseFloat((refPx * (1 - pct / 100)).toFixed(decimals));
    const high = parseFloat((refPx * (1 + pct / 100)).toFixed(decimals));
    setLowerPrice(low);
    setUpperPrice(high);
    setLowerStopPrice(
      String(parseFloat((low * (1 - (stopLossPct / 100) * 0.5)).toFixed(decimals)))
    );
    setUpperStopPrice(
      String(parseFloat((high * (1 + (stopLossPct / 100) * 0.5)).toFixed(decimals)))
    );
  };

  // Real-time client-side Grid Math Preview
  const gridPreview = useMemo(() => {
    const low = Math.min(lowerPrice, upperPrice);
    const high = Math.max(lowerPrice, upperPrice);
    const count = Math.max(2, Math.min(200, gridCount));
    const refPx =
      liveSymbolPrice > low && liveSymbolPrice < high
        ? liveSymbolPrice
        : (low + high) / 2 || 1;
    const totalBuyingPower = marginInvestedUSDT * leverage;
    const stepUSDT = (high - low) / Math.max(1, count - 1);
    const stepPct = refPx > 0 ? (stepUSDT / refPx) * 100 : 0;
    const roundTripMakerPct = feeTierInfo?.roundTripMakerFeePct ?? 0.04;
    const netProfitPerGridPct = Math.max(0, stepPct - roundTripMakerPct);
    const notionalPerGrid = (totalBuyingPower * 0.92) / count;
    const estLiqLong = Math.max(0, ((low + refPx) / 2) * (1 - (1 / leverage - 0.008)));
    const estLiqShort = ((high + refPx) / 2) * (1 + (1 / leverage - 0.008));

    // Generate preview ladder levels
    const levels: {
      index: number;
      price: number;
      side: 'BUY' | 'SELL' | 'PIVOT';
      notionalUSDT: number;
    }[] = [];

    for (let i = 0; i < count; i++) {
      const px =
        gridType === 'GEOMETRIC' && low > 0
          ? low * Math.pow(high / low, i / Math.max(1, count - 1))
          : low + stepUSDT * i;
      const side =
        Math.abs(px - refPx) / refPx < 0.0012
          ? 'PIVOT'
          : px < refPx
          ? 'BUY'
          : 'SELL';
      levels.push({
        index: i + 1,
        price: px,
        side,
        notionalUSDT: notionalPerGrid,
      });
    }

    return {
      refPx,
      totalBuyingPower,
      stepUSDT,
      stepPct,
      netProfitPerGridPct,
      notionalPerGrid,
      estLiqLong,
      estLiqShort,
      levels,
    };
  }, [
    lowerPrice,
    upperPrice,
    gridCount,
    gridType,
    marginInvestedUSDT,
    leverage,
    liveSymbolPrice,
  ]);

  // Create and Start Neutral Grid Bot
  const handleCreateAndStartGridBot = async () => {
    setIsCreatingBot(true);
    setLocalBanner(null);
    try {
      const res = await fetch('/api/bot/grid/create', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          symbol: selectedSymbol,
          platform,
          mode: configMode,
          lowerPrice: Number(lowerPrice),
          upperPrice: Number(upperPrice),
          gridCount: Number(gridCount),
          gridType,
          marginInvestedUSDT: Number(marginInvestedUSDT),
          leverage: Number(leverage),
          marginMode,
          martingale: {
            enabled: martingaleEnabled,
            sizeMultiplier: Number(martingaleMultiplier),
            maxMultiplierSteps: Number(martingaleMaxSteps),
            maxExposureUSDT: Number(maxExposureUSDT),
          },
          risk: {
            stopLossPct: Number(stopLossPct),
            takeProfitPct: Number(takeProfitPct),
            lowerStopPrice: lowerStopPrice ? Number(lowerStopPrice) : undefined,
            upperStopPrice: upperStopPrice ? Number(upperStopPrice) : undefined,
            stopOnRangeBreakout,
            maxMarginUsagePct: 95,
            maxActiveGridBots: Math.max(100, Number(apMaxBots) || 100),
          },
        }),
      });
      const data = await safeJson(res);
      if (!res.ok || !data.success) {
        setLocalBanner({
          type: 'error',
          text: data.error || 'Eroare la lansarea botului Neutral Grid.',
        });
      } else {
        setSelectedBotIdForLadder(data.bot?.botId || null);
        setMobileDashView('BOTS');
        setLocalBanner({
          type: 'success',
          text: `Botul Neutral Grid pe ${data.bot.symbol} a fost LANSAT cu succes (${data.bot.config.gridCount} trepte între $${data.bot.config.lowerPrice} și $${data.bot.config.upperPrice})!`,
        });
        onRefresh();
      }
    } catch (err: any) {
      setLocalBanner({
        type: 'error',
        text: err.message || 'Eroare de rețea la pornirea botului Grid.',
      });
    } finally {
      setIsCreatingBot(false);
    }
  };

  // Save default settings without starting a bot
  const handleSaveDefaultSettings = async () => {
    setLocalBanner(null);
    const res = await onUpdateProfileSettings('NEUTRAL_GRID', {
      defaultSymbol: selectedSymbol,
      lowerPrice: Number(lowerPrice),
      upperPrice: Number(upperPrice),
      gridCount: Number(gridCount),
      gridType,
      marginInvestedUSDT: Number(marginInvestedUSDT),
      leverage: Number(leverage),
      marginMode,
      stopLossPct: Number(stopLossPct),
      takeProfitPct: Number(takeProfitPct),
      stopOnRangeBreakout,
      martingaleEnabled,
      martingaleMultiplier: Number(martingaleMultiplier),
      martingaleMaxSteps: Number(martingaleMaxSteps),
      maxExposureUSDT: Number(maxExposureUSDT),
      autoDeployTopCandidate,
    });
    if (!res || res.success) {
      setLocalBanner({
        type: 'success',
        text: 'Setările Neutral Grid au fost salvate în configurația TB5.',
      });
      onRefresh();
    }
  };

  const handleStopGridBot = async (botId: string, symbol: string) => {
    try {
      const res = await fetch(`/api/bot/grid/${botId}/stop`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ reason: 'Oprit manual de utilizator din Terminal' }),
      });
      const data = await safeJson(res);
      if (data.success) {
        setLocalBanner({
          type: 'info',
          text: `Botul Grid ${symbol} (${botId}) a fost oprit și ordinele deschise au fost anulate.`,
        });
        onRefresh();
      }
    } catch (err: any) {
      setLocalBanner({ type: 'error', text: err.message });
    }
  };

  const handleDeleteStoppedBot = async (botId: string) => {
    try {
      await fetch(`/api/bot/grid/${botId}`, {
        method: 'DELETE',
        headers: authHeaders(),
      });
      onRefresh();
    } catch {}
  };

  const handleExportCsv = async (
    dataset: 'grid_arbitrages' | 'orders' | 'grid_bots' | 'grid_levels' | 'audit'
  ) => {
    try {
      const res = await fetch(`/api/bot/export/${dataset}`);
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Eroare la descărcarea ${dataset}.csv`);
      }
      const blob = await res.blob();
      const dateStr = new Date().toISOString().slice(0, 10);
      const fileName = `${dataset}_${dateStr}.csv`;
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
      setLocalBanner({
        type: 'success',
        text: `Fișierul ${fileName} (din .data/) a fost descărcat cu succes!`,
      });
    } catch (err: any) {
      setLocalBanner({
        type: 'error',
        text: err.message || 'Eroare la exportul CSV din .data/',
      });
    }
  };

  const handleSaveBotRiskModal = async () => {
    if (!editingBot) return;
    try {
      const res = await fetch(`/api/bot/grid/${editingBot.botId}/risk`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          stopLossPct: editSlPct,
          takeProfitPct: editTpPct,
          lowerStopPrice: editLowerStop,
          upperStopPrice: editUpperStop,
        }),
      });
      const data = await safeJson(res);
      if (data.success) {
        setLocalBanner({
          type: 'success',
          text: `Pragurile SL/TP pentru ${editingBot.symbol} au fost actualizate.`,
        });
        setEditingBot(null);
        onRefresh();
      }
    } catch (err: any) {
      setLocalBanner({ type: 'error', text: err.message });
    }
  };

  const handleLoadCandidateIntoConfigurator = (cand: GridCandidateAnalysis) => {
    setSelectedSymbol(cand.symbol);
    setLiveSymbolPrice(cand.price);
    setLowerPrice(cand.recommendedLowerPrice);
    setUpperPrice(cand.recommendedUpperPrice);
    setGridCount(cand.recommendedGridCount);
    setLocalBanner({
      type: 'info',
      text: `Moneda ${cand.symbol} (Scor Grid ${cand.gridSuitabilityScore}/100) — comutat în [1:OKX NATIVE & AUTO-LIMIT GRID] (Ramura 1: Ordine Limit).`,
    });
    setActiveTab('NATIVE_GRID');
  };

  // Direct 1-click Manual Launch from Scanner table into Ramura 1: Ordine Limit (OKX Native & Auto-Limit Grid)
  const handleDirectLaunchCandidate = async (cand: GridCandidateAnalysis) => {
    setIsCreatingBot(true);
    setLocalBanner(null);
    try {
      const budget = Number(nativeGridAutopilot?.maxBudgetPerBotUSDT) || Number(apMarginPerBot) || 15;
      const lev = Number(cand.recommendedLeverage) || Number(nativeGridAutopilot?.maxLeverage) || 3;
      const res = await fetch('/api/bot/native-grid/create', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          instId: cand.symbol,
          minPx: cand.recommendedLowerPrice,
          maxPx: cand.recommendedUpperPrice,
          gridNum: cand.recommendedGridCount,
          runType: nativeGridAutopilot?.defaultRunType || '1',
          lever: lev,
          sz: budget,
          stopLossPct: Number(nativeGridAutopilot?.stopLossPct) || 8,
          takeProfitPct: Number(nativeGridAutopilot?.takeProfitPct) || 15,
          stopTypeOnRisk: nativeGridAutopilot?.defaultStopType || '1',
          stopOnRangeBreakout: nativeGridAutopilot?.stopOnRangeBreakout ?? true,
          stopOnTrendInvalidation: nativeGridAutopilot?.stopOnTrendInvalidation ?? true,
          environment: 'LIVE',
          explicitLiveConfirm: true,
          executionVariant: 'AUTO_LIMIT',
        }),
      });
      const data = await safeJson(res);
      if (!res.ok || !data.success) {
        setLocalBanner({
          type: 'error',
          text: data.error || `Eroare la lansarea botului Ramura 1 (Ordine Limit) pe ${cand.symbol}.`,
        });
      } else {
        setLocalBanner({
          type: 'success',
          text: `GRILĂ RAMURA 1 (ORDINE LIMIT OKX) LANSATĂ: ${cand.symbol} a pornit (${cand.recommendedGridCount} trepte între $${cand.recommendedLowerPrice} – $${cand.recommendedUpperPrice})!`,
        });
        setActiveTab('NATIVE_GRID');
        onRefresh();
      }
    } catch (err: any) {
      setLocalBanner({ type: 'error', text: err.message });
    } finally {
      setIsCreatingBot(false);
    }
  };

  // Save & apply Autopilot configuration
  const handleSaveAutopilot = async (overrideEnabled?: boolean) => {
    setIsSavingAutopilot(true);
    setLocalBanner(null);
    const nextEnabled =
      typeof overrideEnabled === 'boolean' ? overrideEnabled : apEnabled;
    setApEnabled(nextEnabled);
    try {
      const res = await fetch('/api/bot/grid/autopilot', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          enabled: nextEnabled,
          scanIntervalSec: Number(apScanIntervalSec),
          maxScannedSymbols: Number(apMaxScannedSymbols),
          minSuitabilityScore: Number(apMinScore),
          maxConcurrentBots: Number(apMaxBots),
          marginPerBotUSDT: Number(apMarginPerBot),
          minReserveUSDT: Number(apMinReserve),
          useAnalyzerLeverage: apUseAnalyzerLeverage,
          defaultLeverage: Number(apDefaultLeverage),
          defaultMarginMode: apMarginMode,
          defaultGridType: apGridType,
          stopLossPct: Number(apStopLossPct),
          takeProfitPct: Number(apTakeProfitPct),
          stopOnRangeBreakout: apStopOnBreakout,
          cooldownMinutesPerSymbol: Number(apCooldownMin),
          onlyIdealOrGoodRegime: apOnlyIdealRegime,
        }),
      });
      const data = await safeJson(res);
      if (data.success) {
        if (data.autopilot) {
          try {
            localStorage.setItem('tb5_autopilot_backup', JSON.stringify(data.autopilot));
          } catch {}
          setApEnabled(Boolean(data.autopilot.enabled));
          setApScanIntervalSec(data.autopilot.scanIntervalSec);
          setApMaxScannedSymbols(data.autopilot.maxScannedSymbols);
          setApMinScore(data.autopilot.minSuitabilityScore);
          setApMaxBots(data.autopilot.maxConcurrentBots);
          setApMarginPerBot(data.autopilot.marginPerBotUSDT);
          setApMinReserve(data.autopilot.minReserveUSDT);
          setApUseAnalyzerLeverage(Boolean(data.autopilot.useAnalyzerLeverage));
          setApDefaultLeverage(data.autopilot.defaultLeverage);
          setApMarginMode(data.autopilot.defaultMarginMode);
          setApGridType(data.autopilot.defaultGridType);
          setApStopLossPct(data.autopilot.stopLossPct);
          setApTakeProfitPct(data.autopilot.takeProfitPct);
          setApStopOnBreakout(Boolean(data.autopilot.stopOnRangeBreakout));
          setApCooldownMin(data.autopilot.cooldownMinutesPerSymbol);
          setApOnlyIdealRegime(Boolean(data.autopilot.onlyIdealOrGoodRegime));
        }
        const launchedCount = data.launchedBots?.length || 0;
        setLocalBanner({
          type: launchedCount > 0 ? 'success' : 'info',
          text:
            launchedCount > 0
              ? `AUTOPILOT ACTIVAT: S-au lansat automat ${launchedCount} bot(i) Grid! (${data.decision})`
              : `Configurație Autopilot salvată (${nextEnabled ? 'AUTOPILOT ON' : 'DOAR MANUAL'} | Max ${data.autopilot?.maxConcurrentBots || apMaxBots} boți | Scanare la ${data.autopilot?.scanIntervalSec || apScanIntervalSec}s). ${data.decision || ''}`,
        });
        onRefresh();
      } else {
        setLocalBanner({
          type: 'error',
          text: data.error || 'Eroare la salvarea Autopilotului.',
        });
      }
    } catch (err: any) {
      setLocalBanner({ type: 'error', text: err.message });
    } finally {
      setIsSavingAutopilot(false);
    }
  };

  // Run an immediate Autopilot scan + launch evaluation cycle
  const handleRunAutopilotNow = async () => {
    setIsRunningAutopilotNow(true);
    setLocalBanner(null);
    try {
      const res = await fetch('/api/bot/grid/autopilot/run-now', {
        method: 'POST',
        headers: authHeaders(),
      });
      const data = await safeJson(res);
      if (data.success) {
        const count = data.launchedBots?.length || 0;
        setLocalBanner({
          type: count > 0 ? 'success' : 'info',
          text:
            count > 0
              ? `Ciclu Autopilot executat: ${count} bot(i) lansat(i) autonom! (${data.decision})`
              : `Ciclu Autopilot verificat: ${data.decision}`,
        });
        onRefresh();
      } else {
        setLocalBanner({
          type: 'error',
          text: data.error || 'Eroare la rularea ciclului Autopilot.',
        });
      }
    } catch (err: any) {
      setLocalBanner({ type: 'error', text: err.message });
    } finally {
      setIsRunningAutopilotNow(false);
    }
  };

  const selectedLadderBot = useMemo(() => {
    return (
      gridBots.find((b) => b.botId === selectedBotIdForLadder) ||
      gridBots[0] ||
      null
    );
  }, [gridBots, selectedBotIdForLadder]);

  const tickerItems = useMemo(() => {
    return runningBots.length > 0
      ? runningBots.map((b) => ({
          id: b.botId,
          symbol: b.symbol,
          price: b.currentPrice,
          pnl: b.totalNetPnlUSDT,
          isBot: true,
        }))
      : gridCandidates.slice(0, 6).map((c) => ({
          id: c.symbol,
          symbol: c.symbol,
          price: c.price,
          pnl: c.priceChange24hPct,
          isBot: false,
        }));
  }, [runningBots, gridCandidates]);

  const equity = status?.equity ?? 200.0;
  const walletBalance = status?.walletBalance ?? equity;
  const freeBalance = status?.freeBalance ?? 200.0;
  const unallocatedBalance = status?.unallocatedBalance ?? freeBalance;
  const exchangeFrozenMargin = status?.exchangeFrozenMargin ?? 0.0;
  const marginInvested = status?.marginInvested ?? 0.0;
  const gridProfitTotal = status?.gridProfitTotal ?? 0.0;
  const unrealizedPnL = status?.unrealizedPnL ?? 0.0;
  const totalFees = status?.totalFees ?? 0.0;
  const totalProfit = status?.totalProfit ?? 0.0;
  const completedArbitragesTotal = status?.completedArbitragesTotal ?? 0;
  const isKillSwitch = Boolean(status?.config?.killSwitchEngaged);
  const execMode = status?.executionMode || 'PAPER';

  // Live telemetry derived metrics (updates every 1s + every 3s RX poll)
  const lastSyncAt = telemetry?.lastSyncAt || nowMs;
  const secSinceSync = Math.max(0, Math.floor((nowMs - lastSyncAt) / 1000));
  const isStreamAlive = secSinceSync <= 8;
  const rxFlash = Boolean(telemetry?.rxFlash);
  const tickCount = telemetry?.tickCount ?? 0;
  const pingMs = telemetry?.pingMs ?? 12;
  const liveClockStr = new Date(nowMs).toLocaleTimeString('ro-RO', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const scanIntervalSec = serverAutopilot?.scanIntervalSec || apScanIntervalSec || 60;
  const lastScanCheckAt =
    serverAutopilot?.lastAutopilotCheckAt ||
    (status?.scannerStats?.lastScanTime
      ? new Date(status.scannerStats.lastScanTime).getTime()
      : nowMs);
  const elapsedScanSec = Math.max(0, Math.floor((nowMs - lastScanCheckAt) / 1000));
  const nextScanInSec = Math.max(
    0,
    scanIntervalSec - (elapsedScanSec % Math.max(1, scanIntervalSec))
  );
  const latestLog = logs && logs.length > 0 ? logs[0] : null;

  return (
    <div className="h-[100dvh] w-full bg-black text-amber-400 font-mono flex flex-col overflow-hidden select-text">
      {/* =================================================================== */}
      {/* 1. TOP BLOOMBERG HEADER — 100% NEUTRAL FUTURES GRID                 */}
      {/* =================================================================== */}
      <header className="bg-zinc-950 border-b border-amber-500/40 px-2.5 sm:px-3 py-1.5 flex flex-col lg:flex-row lg:flex-wrap lg:items-center lg:justify-between gap-2 shrink-0 overflow-hidden">
        <div className="flex items-center justify-between lg:justify-start gap-1.5 sm:gap-2.5 flex-wrap">
          <div className="flex items-center space-x-1.5 bg-amber-500 text-black px-2 sm:px-2.5 py-1 rounded font-black text-[11px] sm:text-xs tracking-wider shadow-[0_0_12px_rgba(245,158,11,0.4)]">
            <Layers className="w-3.5 h-3.5 sm:w-4 sm:h-4 shrink-0" />
            <span className="truncate">TB5 // GRID</span>
          </div>

          {/* LIVE HEARTBEAT & NETWORK TELEMETRY CAPSULE */}
          <div
            className={`flex items-center space-x-1.5 sm:space-x-2 px-2 py-1 rounded border text-[10px] sm:text-[11px] transition-all duration-300 ${
              !isStreamAlive
                ? 'bg-rose-950/90 border-rose-500 text-rose-200 animate-pulse'
                : rxFlash
                ? 'bg-emerald-950/80 border-emerald-400 text-emerald-200 shadow-[0_0_12px_rgba(16,185,129,0.45)]'
                : 'bg-black border-emerald-500/40 text-zinc-200'
            }`}
            title="Telemetrie în timp real: conexiune backend, pachete RX, latență și ceas live"
          >
            {/* Blinking Radar LED */}
            <span className="relative flex h-2 w-2 sm:h-2.5 sm:w-2.5">
              <span
                className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${
                  !isStreamAlive
                    ? 'bg-rose-400'
                    : rxFlash
                    ? 'bg-cyan-300'
                    : 'bg-emerald-400'
                }`}
              />
              <span
                className={`relative inline-flex rounded-full h-2 w-2 sm:h-2.5 sm:w-2.5 ${
                  !isStreamAlive
                    ? 'bg-rose-500'
                    : rxFlash
                    ? 'bg-cyan-400'
                    : 'bg-emerald-500'
                }`}
              />
            </span>

            <span className="font-black tracking-wide text-emerald-400">
              {!isStreamAlive ? 'RECONECTARE...' : 'LIVE'}
            </span>

            <span className="text-zinc-500 hidden sm:inline">|</span>

            <span
              className={`font-bold px-1 rounded transition-colors hidden sm:inline ${
                rxFlash ? 'bg-cyan-500/30 text-cyan-200' : 'text-cyan-400'
              }`}
            >
              RX #{tickCount}
            </span>

            <span className="text-zinc-400 tabular-nums">{pingMs}ms</span>

            <span className="text-zinc-500 hidden md:inline">|</span>

            <span className="text-amber-300 font-bold tabular-nums hidden md:inline">{liveClockStr}</span>
          </div>

          {/* Execution Mode Switcher: PAPER vs LIVE */}
          <div className="flex items-center bg-black border border-amber-500/40 rounded p-0.5 text-[11px] sm:text-xs">
            <button
              onClick={() => onSwitchMode('PAPER')}
              className={`px-2 py-0.5 rounded font-bold cursor-pointer transition-colors ${
                execMode === 'PAPER'
                  ? 'bg-emerald-500 text-black'
                  : 'text-zinc-400 hover:text-white'
              }`}
            >
              PAPER
            </button>
            <button
              onClick={() => onSwitchMode('LIVE')}
              className={`px-2 py-0.5 rounded font-bold cursor-pointer transition-colors ${
                execMode === 'LIVE'
                  ? 'bg-rose-600 text-white animate-pulse'
                  : 'text-zinc-400 hover:text-white'
              }`}
            >
              LIVE OKX
            </button>
          </div>

          {/* Quick Unified Autopilot Switch in Top Bar with Live Countdown */}
          <button
            type="button"
            onClick={() => handleSaveAutopilot(!Boolean(nativeGridAutopilot?.enabled ?? apEnabled))}
            disabled={isSavingAutopilot}
            className={`px-2 sm:px-2.5 py-1 rounded text-[11px] sm:text-xs font-black flex items-center space-x-1 cursor-pointer border transition-all ${
              Boolean(nativeGridAutopilot?.enabled ?? apEnabled)
                ? 'bg-cyan-500 text-black border-cyan-300 shadow-[0_0_12px_rgba(6,182,212,0.5)]'
                : 'bg-zinc-900 text-zinc-300 border-zinc-700 hover:border-cyan-500/50'
            }`}
            title="Comută Autopilotul Unificat din [1:OKX NATIVE & AUTO-LIMIT GRID] (Ramura 1: Ordine Limit)"
          >
            <Zap className="w-3.5 h-3.5 shrink-0" />
            <span className="tabular-nums truncate">
              {Boolean(nativeGridAutopilot?.enabled ?? apEnabled)
                ? `AUTO: ON (${nextScanInSec}s | ≥${nativeGridAutopilot?.minSuitabilityScore || apMinScore}p)`
                : `AUTO: OFF (${nextScanInSec}s)`}
            </span>
          </button>
        </div>

        {/* Accounting KPI Bar */}
        <div className="grid grid-cols-3 sm:flex sm:flex-wrap items-center gap-1.5 sm:gap-2 text-xs">
          <div
            className={`bg-black border px-2 py-1 rounded transition-colors duration-300 ${
              rxFlash ? 'border-emerald-500/60' : 'border-zinc-800'
            }`}
            title="Equity total din contul OKX (totalEq = Cash Portofel + PnL Nerealizat)"
          >
            <span className="text-zinc-500 text-[9px] sm:text-[10px] block truncate">
              {execMode === 'LIVE' ? 'EQUITY OKX' : 'EQUITY TOTAL'}
            </span>
            <span className="font-bold text-white tabular-nums text-[11px] sm:text-xs">
              ${equity.toFixed(2)}
            </span>
            {execMode === 'LIVE' && (
              <span className="text-[9px] text-zinc-400 block tabular-nums truncate">
                Cash: ${walletBalance.toFixed(2)}
              </span>
            )}
          </div>
          <div
            className="bg-black border border-zinc-800 px-2 py-1 rounded"
            title="Balanța disponibilă pe OKX (availBal după scăderea ordinelor active) și bugetul nealocat boților"
          >
            <span className="text-zinc-500 text-[9px] sm:text-[10px] block truncate">
              {execMode === 'LIVE' ? 'DISPONIBIL OKX' : 'MARJĂ LIBERĂ'}
            </span>
            <span className="font-bold text-emerald-400 tabular-nums text-[11px] sm:text-xs">
              ${freeBalance.toFixed(2)}
            </span>
            {execMode === 'LIVE' && (
              <span className="text-[9px] text-zinc-400 block tabular-nums truncate">
                Nealocat: ${unallocatedBalance.toFixed(2)}
              </span>
            )}
          </div>
          <div
            className="bg-black border border-zinc-800 px-2 py-1 rounded"
            title="Marja înghețată efectiv pe OKX în ordinele limită active vs. bugetul total alocat boților activi"
          >
            <span className="text-zinc-500 text-[9px] sm:text-[10px] block truncate">
              {execMode === 'LIVE' ? 'BLOCAT OKX / BUGET' : 'ÎN GRILE'}
            </span>
            <span className="font-bold text-amber-400 tabular-nums text-[11px] sm:text-xs">
              {execMode === 'LIVE'
                ? `$${exchangeFrozenMargin.toFixed(2)} / $${marginInvested.toFixed(2)}`
                : `$${marginInvested.toFixed(2)}`}
            </span>
            {execMode === 'LIVE' && (
              <span className="text-[9px] text-zinc-400 block tabular-nums truncate">
                În ordine OKX / Alocat
              </span>
            )}
          </div>
          <div
            onClick={() => setShowFeeCalculatorModal(true)}
            className="bg-black border border-zinc-800 hover:border-amber-500/60 px-2 py-1 rounded cursor-pointer transition-colors"
            title="Click pentru Calculatorul Live de Comisioane & Volum OKX (GET /api/v5/account/trade-fee)"
          >
            <span className="text-zinc-500 text-[9px] sm:text-[10px] block truncate">
              PROFIT REALIZAT • {feeTierInfo?.level || 'Lv1'}
            </span>
            <span
              className={`font-bold tabular-nums text-[11px] sm:text-xs ${
                gridProfitTotal >= 0 ? 'text-emerald-400' : 'text-rose-400'
              }`}
            >
              {gridProfitTotal >= 0 ? '+' : ''}${gridProfitTotal.toFixed(2)} ({completedArbitragesTotal})
            </span>
            <span className="text-[9px] text-amber-300 hover:text-amber-200 block tabular-nums truncate">
              Fee OKX Live: -${totalFees.toFixed(Math.abs(totalFees) > 0 && Math.abs(totalFees) < 0.01 ? 4 : 2)}
              {feeTierInfo?.totalVolumeUSDT && feeTierInfo.totalVolumeUSDT > 0
                ? ` (Vol $${feeTierInfo.totalVolumeUSDT.toFixed(0)})`
                : ` (${feeTierInfo?.makerFeePct ?? 0.02}%/${feeTierInfo?.takerFeePct ?? 0.05}%)`}
            </span>
          </div>
          <div
            className="bg-black border border-zinc-800 px-2 py-1 rounded"
            title="PnL Net Total = Profit Realizat - Comisioane OKX + Floating PnL (UPL)"
          >
            <span className="text-zinc-500 text-[9px] sm:text-[10px] block truncate">PNL NET CONT</span>
            <span
              className={`font-bold tabular-nums text-[11px] sm:text-xs ${
                totalProfit >= 0 ? 'text-emerald-400' : 'text-rose-400'
              }`}
            >
              {totalProfit >= 0 ? '+' : ''}${totalProfit.toFixed(2)}
            </span>
            <span className="text-[9px] text-zinc-400 block tabular-nums truncate">
              UPL: {unrealizedPnL >= 0 ? '+' : ''}${unrealizedPnL.toFixed(2)}
            </span>
          </div>

          <button
            type="button"
            onClick={() => setShowKillSwitchConfirm(true)}
            className={`px-2 sm:px-3 py-1.5 rounded font-bold text-[10px] sm:text-xs flex items-center justify-center space-x-1 cursor-pointer border transition-all ${
              isKillSwitch
                ? 'bg-rose-600 text-white border-rose-400 animate-pulse'
                : 'bg-zinc-900 text-rose-400 border-rose-500/50 hover:bg-rose-950'
            }`}
            title={
              isKillSwitch
                ? 'Click pentru a dezactiva Kill Switch-ul (cu confirmare)'
                : 'Oprire de urgență cu confirmare: închide toți boții și pozițiile active'
            }
          >
            <ShieldAlert className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">{isKillSwitch ? 'KILL ACTIV' : 'STOP URGENȚĂ'}</span>
          </button>
        </div>
      </header>

      {/* =================================================================== */}
      {/* 2. NAVIGATION TABS BAR (DESKTOP / TABLET)                           */}
      {/* =================================================================== */}
      <nav className="hidden lg:flex bg-zinc-950 border-b border-amber-500/30 px-3 py-1 items-center justify-between gap-2 overflow-x-auto shrink-0">
        <div className="flex items-center space-x-1.5">
          <button
            onClick={() => setActiveTab('NATIVE_GRID')}
            className={`px-3 py-1 rounded text-xs font-bold flex items-center space-x-1.5 cursor-pointer transition-colors ${
              activeTab === 'NATIVE_GRID'
                ? 'bg-cyan-400 text-black shadow-[0_0_10px_rgba(34,211,238,0.4)]'
                : 'bg-black text-cyan-300 border border-cyan-500/40 hover:bg-zinc-900'
            }`}
          >
            <Zap className="w-3.5 h-3.5" />
            <span>[1:OKX NATIVE &amp; AUTO-LIMIT GRID] ({runningNativeBotsCount})</span>
          </button>

          <button
            onClick={() => setActiveTab('SCANNER')}
            className={`px-3 py-1 rounded text-xs font-bold flex items-center space-x-1.5 cursor-pointer transition-colors ${
              activeTab === 'SCANNER'
                ? 'bg-amber-500 text-black'
                : 'bg-black text-amber-400 border border-amber-500/30 hover:bg-zinc-900'
            }`}
          >
            <Search className="w-3.5 h-3.5" />
            <span>[2:UNIVERS SCANNER GRID] ({gridCandidates.length})</span>
          </button>

          <button
            onClick={() => setActiveTab('LADDER')}
            className={`px-3 py-1 rounded text-xs font-bold flex items-center space-x-1.5 cursor-pointer transition-colors ${
              activeTab === 'LADDER'
                ? 'bg-amber-500 text-black'
                : 'bg-black text-amber-400 border border-amber-500/30 hover:bg-zinc-900'
            }`}
          >
            <ArrowUpDown className="w-3.5 h-3.5" />
            <span>[3:TREPTE GRILĂ &amp; ORDINE]</span>
          </button>

          <button
            onClick={() => setActiveTab('JOURNAL')}
            className={`px-3 py-1 rounded text-xs font-bold flex items-center space-x-1.5 cursor-pointer transition-colors ${
              activeTab === 'JOURNAL'
                ? 'bg-amber-500 text-black'
                : 'bg-black text-amber-400 border border-amber-500/30 hover:bg-zinc-900'
            }`}
          >
            <List className="w-3.5 h-3.5" />
            <span>[4:GRID JOURNAL &amp; LOGURI] ({logs.length})</span>
          </button>

          <button
            onClick={() => setActiveTab('API')}
            className={`px-3 py-1 rounded text-xs font-bold flex items-center space-x-1.5 cursor-pointer transition-colors ${
              activeTab === 'API'
                ? 'bg-amber-500 text-black'
                : 'bg-black text-amber-400 border border-amber-500/30 hover:bg-zinc-900'
            }`}
          >
            <Key className="w-3.5 h-3.5" />
            <span>[5:CONEXIUNE OKX EEA &amp; PLATFORME]</span>
          </button>
        </div>

        <div className="flex items-center space-x-2">
          {execMode === 'PAPER' && (
            <button
              onClick={onResetPaper}
              className="px-2.5 py-1 rounded text-[11px] bg-zinc-900 hover:bg-zinc-800 text-amber-300 border border-amber-500/30 cursor-pointer"
            >
              Reset Cont Paper ($200)
            </button>
          )}
          <button
            onClick={onRefresh}
            className={`px-2.5 py-1 rounded text-[11px] bg-zinc-900 hover:bg-zinc-800 text-amber-400 border flex items-center space-x-1 cursor-pointer transition-all ${
              rxFlash ? 'border-emerald-400 text-emerald-300' : 'border-amber-500/30'
            }`}
          >
            <RefreshCw className={`w-3 h-3 ${rxFlash ? 'animate-spin text-emerald-400' : ''}`} />
            <span>Sync ({secSinceSync}s)</span>
          </button>
        </div>
      </nav>

      {/* =================================================================== */}
      {/* 2B. LIVE ENGINE TELEMETRY & REAL-TIME MARKET TICKER BAR (DESKTOP)   */}
      {/* =================================================================== */}
      <div className="hidden md:flex bg-zinc-950/90 border-b border-zinc-800 px-3 py-1 items-center justify-between gap-3 text-[11px] overflow-hidden shrink-0">
        <div className="flex items-center space-x-2 shrink-0">
          <span
            className={`inline-flex items-center space-x-1.5 px-2 py-0.5 rounded font-bold border ${
              rxFlash
                ? 'bg-emerald-500/20 border-emerald-400 text-emerald-300'
                : 'bg-zinc-900 border-zinc-700 text-emerald-400'
            }`}
          >
            <Activity className={`w-3 h-3 ${rxFlash ? 'animate-pulse text-cyan-300' : ''}`} />
            <span>
              STREAM OKX EEA: {runningBots.length} GRILE ACTIVE • {gridCandidates.length} PERECHI SCANATE
            </span>
          </span>
        </div>

        {/* Live Price Tape for Running Bots & Top Candidates */}
        <div
          className="flex-1 min-w-0 overflow-hidden ml-4"
          style={{ containerType: 'inline-size' }}
        >
          <style>{`
            @keyframes ticker-loop {
              from { transform: translateX(0); }
              to   { transform: translateX(-50%); }
            }
            .ticker-track {
              display: flex;
              width: max-content;
              animation: ticker-loop 90s linear infinite;
            }
            .ticker-group {
              display: flex;
              align-items: center;
              flex-shrink: 0;
              min-width: 100cqw;
              gap: 8px;
              padding-right: 8px;
            }
          `}</style>
          <div className="ticker-track">
            {[0, 1].map((copy) => (
              <div key={copy} className="ticker-group" aria-hidden={copy === 1}>
                {tickerItems.map((item, idx) => {
                  const flash = botFlashes[item.id];
                  const isRecentFlash = flash && nowMs - flash.ts < 3500;
                  return (
                    <div
                      key={`${copy}-${item.id}-${idx}`}
                      className={`flex items-center space-x-1.5 px-2 py-0.5 rounded border tabular-nums transition-all duration-300 shrink-0 ${
                        isRecentFlash && flash?.priceDir === 'up'
                          ? 'bg-emerald-950/90 border-emerald-400 text-emerald-200'
                          : isRecentFlash && flash?.priceDir === 'down'
                          ? 'bg-rose-950/90 border-rose-400 text-rose-200'
                          : 'bg-black border-zinc-800 text-zinc-300'
                      }`}
                    >
                      <span className="font-bold text-white">{item.symbol}</span>
                      <span className="text-amber-300 font-bold">${formatPrice(item.price)}</span>
                      {isRecentFlash && flash?.priceDir === 'up' && (
                        <span className="text-emerald-400 font-black animate-bounce">▲</span>
                      )}
                      {isRecentFlash && flash?.priceDir === 'down' && (
                        <span className="text-rose-400 font-black animate-bounce">▼</span>
                      )}
                      {item.isBot && (
                        <span className={`font-bold ${item.pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                          ({item.pnl >= 0 ? '+' : ''}${item.pnl.toFixed(2)})
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        {/* Latest Engine Activity Log Pill */}
        {latestLog && (
          <div className="flex items-center space-x-1.5 text-zinc-400 truncate max-w-xs shrink-0">
            <span className="text-cyan-400 font-bold">
              [{formatTimeLocal(latestLog.timestamp)}]
            </span>
            <span className="truncate text-zinc-300">{latestLog.message}</span>
          </div>
        )}
      </div>

      {/* =================================================================== */}
      {/* 3. ALERTS / FEEDBACK BANNER                                         */}
      {/* =================================================================== */}
      {(errorMessage || successMessage || localBanner) && (
        <div
          className={`px-4 py-1.5 text-xs flex items-center justify-between border-b shrink-0 ${
            errorMessage || localBanner?.type === 'error'
              ? 'bg-rose-950/90 text-rose-200 border-rose-700'
              : localBanner?.type === 'info'
              ? 'bg-sky-950/90 text-sky-200 border-sky-700'
              : 'bg-emerald-950/90 text-emerald-200 border-emerald-700'
          }`}
        >
          <div className="flex items-center space-x-2">
            {errorMessage || localBanner?.type === 'error' ? (
              <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
            ) : (
              <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
            )}
            <span>{errorMessage || successMessage || localBanner?.text}</span>
          </div>
          <button
            onClick={() => {
              setLocalBanner(null);
              if (onDismissAlert) onDismissAlert();
            }}
            className="text-zinc-300 hover:text-white px-2 font-bold cursor-pointer"
          >
            ✕
          </button>
        </div>
      )}

      {/* =================================================================== */}
      {/* 4. MAIN WORKSPACE CONTENT                                           */}
      {/* =================================================================== */}
      <main className="flex-1 min-h-0 p-2 pb-20 lg:pb-4 overflow-y-auto overflow-x-hidden bg-black terminal-scrollbar">
        {/* ================================================================= */}
        {/* TAB 1: SETĂRI BOT & BOȚI ACTIVI PE TOATĂ ÎNĂLȚIMEA                */}
        {/* ================================================================= */}
        {activeTab === 'DASHBOARD' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 items-start">
            {/* MOBILE SUB-VIEW SWITCHER: BOȚI ACTIVI vs LANSARE BOT */}
            <div className="lg:hidden grid grid-cols-2 gap-2 bg-zinc-950 border border-amber-500/40 rounded p-1.5">
              <button
                type="button"
                onClick={() => setMobileDashView('BOTS')}
                className={`py-2.5 px-3 rounded text-xs font-black flex items-center justify-center space-x-1.5 cursor-pointer transition-all ${
                  mobileDashView === 'BOTS'
                    ? 'bg-emerald-500 text-black shadow-[0_0_10px_rgba(16,185,129,0.4)]'
                    : 'bg-black text-zinc-300 border border-zinc-800'
                }`}
              >
                <Activity className="w-4 h-4 shrink-0" />
                <span>BOȚI ACTIVI ({runningBots.length}/{gridBots.length})</span>
              </button>
              <button
                type="button"
                onClick={() => setMobileDashView('LAUNCH')}
                className={`py-2.5 px-3 rounded text-xs font-black flex items-center justify-center space-x-1.5 cursor-pointer transition-all ${
                  mobileDashView === 'LAUNCH'
                    ? 'bg-amber-500 text-black shadow-[0_0_10px_rgba(245,158,11,0.4)]'
                    : 'bg-black text-amber-300 border border-amber-500/30'
                }`}
              >
                <Settings className="w-4 h-4 shrink-0" />
                <span>+ LANSARE / SETĂRI</span>
              </button>
            </div>

            {/* LEFT COLUMN: SETĂRI COMPLETE BOT NEUTRAL GRID (5 COLS) */}
            <div
              className={`${
                mobileDashView === 'LAUNCH' ? 'flex' : 'hidden lg:flex'
              } lg:col-span-5 bg-zinc-950 border border-amber-500/40 rounded p-3 flex-col justify-between space-y-3`}
            >
              <div className="space-y-3">
                <div className="flex items-center justify-between border-b border-amber-500/30 pb-2">
                  <div className="flex items-center space-x-2">
                    <Settings className="w-4 h-4 text-amber-400" />
                    <h2 className="font-bold text-sm text-amber-400 tracking-wide">
                      SETĂRI BOT FUTURES GRID NEUTRAL
                    </h2>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleAutoOptimize()}
                    disabled={isOptimizing}
                    className="px-2.5 py-1 rounded bg-cyan-500 hover:bg-cyan-400 text-black font-black text-[11px] flex items-center space-x-1 cursor-pointer shadow-[0_0_10px_rgba(6,182,212,0.4)]"
                  >
                    <Zap className="w-3.5 h-3.5" />
                    <span>
                      {isOptimizing
                        ? 'SE CALCULEAZĂ...'
                        : 'AUTO-OPTIMIZEAZĂ (ATR / PIAȚĂ)'}
                    </span>
                  </button>
                </div>

                {/* 1. MONEDA ALEASĂ & PLATFORMA (EXCLUSIV INSTRUMENTE REALE OKX EEA) */}
                <div className="bg-black border border-zinc-800 rounded p-2.5 space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-bold text-amber-300">
                      1. MONEDA ALEASĂ (INSTRUMENT REAL OKX EEA)
                    </label>
                    <span className="text-[11px] text-emerald-400">
                      {liveSymbolPrice > 0 || gridPreview.refPx > 1
                        ? `Preț Live Piață: $${formatPrice(liveSymbolPrice || gridPreview.refPx)}`
                        : 'Așteptare cotație live...'}
                    </span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <select
                      value={selectedSymbol}
                      onChange={(e) => {
                        const sym = e.target.value;
                        setSelectedSymbol(sym);
                        const cand = gridCandidates.find((c) => c.symbol === sym);
                        if (cand) {
                          setLiveSymbolPrice(cand.price);
                          setLowerPrice(cand.recommendedLowerPrice);
                          setUpperPrice(cand.recommendedUpperPrice);
                          setGridCount(cand.recommendedGridCount);
                        } else if (sym) {
                          handleAutoOptimize(sym);
                        }
                      }}
                      className="bg-zinc-900 border border-amber-500/50 rounded px-2.5 py-1.5 text-xs text-white font-bold"
                    >
                      {gridCandidates.length === 0 && (
                        <option value="">
                          Se scanează instrumentele reale OKX EEA...
                        </option>
                      )}
                      {gridCandidates.map((c) => (
                        <option key={c.symbol} value={c.symbol}>
                          {c.symbol} — ${formatPrice(c.price)} (Scor {c.gridSuitabilityScore}/100)
                        </option>
                      ))}
                    </select>

                    <input
                      type="text"
                      value={selectedSymbol}
                      onChange={(e) => setSelectedSymbol(e.target.value.toUpperCase())}
                      placeholder="Selectați din listă sau introduceți simbol OKX EEA"
                      className="bg-zinc-900 border border-zinc-700 rounded px-2.5 py-1.5 text-xs text-amber-300 font-bold"
                    />
                  </div>
                </div>

                {/* 2. PRAGURI INTERVAL DE PREȚ (LOWER & UPPER PRICE) */}
                <div className="bg-black border border-zinc-800 rounded p-2.5 space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-bold text-amber-300">
                      2. PRAGURI INTERVAL GRILĂ (MINIM / MAXIM)
                    </label>
                    <div className="flex items-center space-x-1">
                      <span className="text-[10px] text-zinc-400">Auto-Range:</span>
                      {[3, 5, 8, 12].map((pct) => (
                        <button
                          key={pct}
                          type="button"
                          onClick={() => handleQuickRangeBand(pct)}
                          className="px-1.5 py-0.5 bg-zinc-900 hover:bg-amber-500 hover:text-black text-amber-300 border border-amber-500/30 rounded text-[10px] font-bold cursor-pointer"
                        >
                          ±{pct}%
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <span className="text-[10px] text-zinc-400 block mb-0.5">
                        Prag Inferior (Lower Price $)
                      </span>
                      <input
                        type="number"
                        step="any"
                        value={lowerPrice}
                        onChange={(e) => setLowerPrice(parseFloat(e.target.value) || 0)}
                        className="w-full bg-zinc-900 border border-emerald-500/50 rounded px-2.5 py-1.5 text-xs text-emerald-300 font-bold"
                      />
                    </div>
                    <div>
                      <span className="text-[10px] text-zinc-400 block mb-0.5">
                        Prag Superior (Upper Price $)
                      </span>
                      <input
                        type="number"
                        step="any"
                        value={upperPrice}
                        onChange={(e) => setUpperPrice(parseFloat(e.target.value) || 0)}
                        className="w-full bg-zinc-900 border border-rose-500/50 rounded px-2.5 py-1.5 text-xs text-rose-300 font-bold"
                      />
                    </div>
                  </div>
                </div>

                {/* 3. TREPTE (NUMĂR GRILE & TIP GRILĂ) */}
                <div className="bg-black border border-zinc-800 rounded p-2.5 space-y-2">
                  <label className="text-xs font-bold text-amber-300 block">
                    3. TREPTE GRILĂ (NUMĂR TREPTE &amp; DISTANȚĂ)
                  </label>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <span className="text-[10px] text-zinc-400 block mb-0.5">
                        Număr Trepte (2 – 200)
                      </span>
                      <input
                        type="number"
                        min={2}
                        max={200}
                        value={gridCount}
                        onChange={(e) =>
                          setGridCount(Math.max(2, parseInt(e.target.value, 10) || 2))
                        }
                        className="w-full bg-zinc-900 border border-amber-500/50 rounded px-2.5 py-1.5 text-xs text-white font-bold"
                      />
                    </div>
                    <div>
                      <span className="text-[10px] text-zinc-400 block mb-0.5">
                        Tip Spațiere Trepte
                      </span>
                      <select
                        value={gridType}
                        onChange={(e) => setGridType(e.target.value as GridSpacingType)}
                        className="w-full bg-zinc-900 border border-amber-500/50 rounded px-2.5 py-1.5 text-xs text-white font-bold"
                      >
                        <option value="ARITHMETIC">ARITMETICĂ (Pas egal în $)</option>
                        <option value="GEOMETRIC">GEOMETRICĂ (Pas egal în %)</option>
                      </select>
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-2 pt-1 text-[11px] bg-zinc-950 p-2 rounded border border-zinc-800">
                    <div>
                      <span className="text-zinc-500 block text-[10px]">Distanță Treaptă</span>
                      <span className="text-white font-bold">
                        ${formatPrice(gridPreview.stepUSDT)} ({gridPreview.stepPct.toFixed(2)}%)
                      </span>
                    </div>
                    <div>
                      <span className="text-zinc-500 block text-[10px]">Profit Net/Treaptă</span>
                      <span className="text-emerald-400 font-bold">
                        +{gridPreview.netProfitPerGridPct.toFixed(2)}%
                      </span>
                    </div>
                    <div>
                      <span className="text-zinc-500 block text-[10px]">Valoare/Treaptă</span>
                      <span className="text-amber-300 font-bold">
                        ${gridPreview.notionalPerGrid.toFixed(2)}
                      </span>
                    </div>
                  </div>
                </div>

                {/* 4. MARGINE INVESTITĂ & LEVIER */}
                <div className="bg-black border border-zinc-800 rounded p-2.5 space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-bold text-amber-300">
                      4. MARGINE INVESTITĂ (USDT) &amp; LEVIER
                    </label>
                    <div className="flex items-center space-x-1">
                      {[25, 50, 75, 100].map((pct) => (
                        <button
                          key={pct}
                          type="button"
                          onClick={() =>
                            setMarginInvestedUSDT(
                              Math.max(5, Math.floor((freeBalance * pct) / 100))
                            )
                          }
                          className="px-1.5 py-0.5 bg-zinc-900 hover:bg-emerald-500 hover:text-black text-emerald-300 border border-emerald-500/30 rounded text-[10px] font-bold cursor-pointer"
                        >
                          {pct}%
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <span className="text-[10px] text-zinc-400 block mb-0.5">
                        Margine Alocată ($)
                      </span>
                      <input
                        type="number"
                        min={5}
                        step="1"
                        value={marginInvestedUSDT}
                        onChange={(e) =>
                          setMarginInvestedUSDT(parseFloat(e.target.value) || 0)
                        }
                        className="w-full bg-zinc-900 border border-emerald-500/50 rounded px-2.5 py-1.5 text-xs text-emerald-300 font-bold"
                      />
                    </div>
                    <div>
                      <span className="text-[10px] text-zinc-400 block mb-0.5">
                        Levier (1x – 20x)
                      </span>
                      <select
                        value={leverage}
                        onChange={(e) => {
                          const nextLev = parseInt(e.target.value, 10) || 1;
                          syncLeverageAndMarginMode(nextLev, marginMode);
                        }}
                        className="w-full bg-zinc-900 border border-amber-500/50 rounded px-2.5 py-1.5 text-xs text-amber-300 font-bold"
                      >
                        {[1, 2, 3, 5, 7, 10, 15, 20].map((lev) => (
                          <option key={lev} value={lev}>
                            {lev}x Levier
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <span className="text-[10px] text-zinc-400 block mb-0.5">
                        Mod Marjă
                      </span>
                      <select
                        value={marginMode}
                        onChange={(e) => {
                          const nextMode = e.target.value as 'cross' | 'isolated';
                          syncLeverageAndMarginMode(leverage, nextMode);
                        }}
                        className="w-full bg-zinc-900 border border-zinc-700 rounded px-2.5 py-1.5 text-xs text-white font-bold"
                      >
                        <option value="cross">CROSS</option>
                        <option value="isolated">ISOLATED</option>
                      </select>
                    </div>
                  </div>

                  <div className="flex items-center justify-between text-[11px] bg-zinc-950 px-2.5 py-1.5 rounded border border-zinc-800">
                    <span>
                      Expunere Totală cu Levier:{' '}
                      <strong className="text-white">
                        ${gridPreview.totalBuyingPower.toFixed(2)} USDT
                      </strong>
                    </span>
                    <span className="text-zinc-400">
                      Liq Est: L ${formatPrice(gridPreview.estLiqLong)} / S $
                      {formatPrice(gridPreview.estLiqShort)}
                    </span>
                  </div>
                </div>

                {/* 5. STOP LOSS (SL) & TAKE PROFIT (TP) */}
                <div className="bg-black border border-zinc-800 rounded p-2.5 space-y-2">
                  <label className="text-xs font-bold text-amber-300 block">
                    5. PROTECȚIE RISC: SL (STOP LOSS) &amp; TP (TAKE PROFIT)
                  </label>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <span className="text-[10px] text-rose-400 block mb-0.5">
                        SL — Stop Loss (% din Marjă)
                      </span>
                      <input
                        type="number"
                        min={0.5}
                        max={100}
                        step="0.5"
                        value={stopLossPct}
                        onChange={(e) => setStopLossPct(parseFloat(e.target.value) || 0)}
                        className="w-full bg-zinc-900 border border-rose-500/50 rounded px-2.5 py-1.5 text-xs text-rose-300 font-bold"
                      />
                    </div>
                    <div>
                      <span className="text-[10px] text-emerald-400 block mb-0.5">
                        TP — Take Profit (% din Marjă)
                      </span>
                      <input
                        type="number"
                        min={0.5}
                        max={500}
                        step="0.5"
                        value={takeProfitPct}
                        onChange={(e) =>
                          setTakeProfitPct(parseFloat(e.target.value) || 0)
                        }
                        className="w-full bg-zinc-900 border border-emerald-500/50 rounded px-2.5 py-1.5 text-xs text-emerald-300 font-bold"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <span className="text-[10px] text-zinc-400 block mb-0.5">
                        Preț Stop Inferior (Opțional $)
                      </span>
                      <input
                        type="number"
                        step="any"
                        placeholder="Auto sub Lower Price"
                        value={lowerStopPrice}
                        onChange={(e) => setLowerStopPrice(e.target.value)}
                        className="w-full bg-zinc-900 border border-zinc-700 rounded px-2.5 py-1 text-xs text-zinc-200"
                      />
                    </div>
                    <div>
                      <span className="text-[10px] text-zinc-400 block mb-0.5">
                        Preț Stop Superior (Opțional $)
                      </span>
                      <input
                        type="number"
                        step="any"
                        placeholder="Auto peste Upper Price"
                        value={upperStopPrice}
                        onChange={(e) => setUpperStopPrice(e.target.value)}
                        className="w-full bg-zinc-900 border border-zinc-700 rounded px-2.5 py-1 text-xs text-zinc-200"
                      />
                    </div>
                  </div>

                  <label className="flex items-center space-x-2 text-xs text-zinc-300 pt-1 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={stopOnRangeBreakout}
                      onChange={(e) => setStopOnRangeBreakout(e.target.checked)}
                      className="accent-amber-500"
                    />
                    <span>
                      Închide automat grila dacă prețul sparge pragurile de Stop (Breakout Protection)
                    </span>
                  </label>
                </div>

                {/* 6. MARTINGALE ENGINE (OPȚIONAL) */}
                <div className="bg-black border border-zinc-800 rounded p-2.5 space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-bold text-amber-300">
                      6. MARTINGALE ENGINE (MULTIPLICATOR TREPTE)
                    </label>
                    <button
                      type="button"
                      onClick={() => setMartingaleEnabled(!martingaleEnabled)}
                      className={`px-2 py-0.5 rounded text-[10px] font-bold cursor-pointer ${
                        martingaleEnabled
                          ? 'bg-amber-500 text-black'
                          : 'bg-zinc-900 text-emerald-400 border border-emerald-500/40'
                      }`}
                    >
                      {martingaleEnabled
                        ? 'MARTINGALE ACTIV'
                        : 'OPRIT (RISC STRICT / CANTITĂȚI EGALE)'}
                    </button>
                  </div>

                  {martingaleEnabled && (
                    <div className="grid grid-cols-3 gap-2 pt-1">
                      <div>
                        <span className="text-[10px] text-zinc-400 block mb-0.5">
                          Multiplicator (1.05x–1.5x)
                        </span>
                        <input
                          type="number"
                          step="0.05"
                          min={1.0}
                          max={1.5}
                          value={martingaleMultiplier}
                          onChange={(e) =>
                            setMartingaleMultiplier(parseFloat(e.target.value) || 1.1)
                          }
                          className="w-full bg-zinc-900 border border-amber-500/50 rounded px-2 py-1 text-xs text-white"
                        />
                      </div>
                      <div>
                        <span className="text-[10px] text-zinc-400 block mb-0.5">
                          Max Trepte Scale
                        </span>
                        <input
                          type="number"
                          min={1}
                          max={15}
                          value={martingaleMaxSteps}
                          onChange={(e) =>
                            setMartingaleMaxSteps(parseInt(e.target.value, 10) || 5)
                          }
                          className="w-full bg-zinc-900 border border-amber-500/50 rounded px-2 py-1 text-xs text-white"
                        />
                      </div>
                      <div>
                        <span className="text-[10px] text-zinc-400 block mb-0.5">
                          Plafon Expunere ($)
                        </span>
                        <input
                          type="number"
                          value={maxExposureUSDT}
                          onChange={(e) =>
                            setMaxExposureUSDT(parseFloat(e.target.value) || 150)
                          }
                          className="w-full bg-zinc-900 border border-amber-500/50 rounded px-2 py-1 text-xs text-white"
                        />
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* ACTION BUTTONS: LAUNCH GRID BOT & SAVE SETTINGS */}
              <div className="pt-2 border-t border-amber-500/30 flex flex-col sm:flex-row gap-2">
                <button
                  type="button"
                  onClick={handleCreateAndStartGridBot}
                  disabled={isCreatingBot || isKillSwitch || !selectedSymbol || lowerPrice <= 0 || upperPrice <= 0}
                  className="flex-1 py-2.5 px-4 rounded bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-black font-black text-xs tracking-wider flex items-center justify-center space-x-2 cursor-pointer shadow-[0_0_15px_rgba(16,185,129,0.4)]"
                >
                  <Play className="w-4 h-4 fill-current" />
                  <span>
                    {isCreatingBot
                      ? 'SE LANSEAZĂ GRILA...'
                      : selectedSymbol
                      ? `LANSEAZĂ BOT NEUTRAL GRID (${selectedSymbol})`
                      : 'SELECTAȚI O MONEDĂ DIN PIAȚĂ'}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={handleSaveDefaultSettings}
                  className="py-2.5 px-3 rounded bg-zinc-900 hover:bg-zinc-800 text-amber-300 border border-amber-500/40 font-bold text-xs flex items-center justify-center space-x-1.5 cursor-pointer"
                >
                  <Save className="w-3.5 h-3.5" />
                  <span>Salvează Setări</span>
                </button>
              </div>
            </div>

            {/* RIGHT COLUMN (7 COLS): BOȚI NEUTRAL GRID ACTIVI PE TOATĂ ÎNĂLȚIMEA */}
            <div
              className={`${
                mobileDashView === 'BOTS' ? 'flex' : 'hidden lg:flex'
              } lg:col-span-7 flex-col`}
            >
              <div className="bg-zinc-950 border border-amber-500/40 rounded p-3 flex flex-col space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-500/30 pb-2 shrink-0">
                  <div className="flex items-center space-x-2">
                    <Activity className="w-4 h-4 text-emerald-400" />
                    <h3 className="font-bold text-sm text-white">
                      BOȚI NEUTRAL GRID ACTIVI &amp; ISTORIC ({runningBots.length} ACTIVI / {gridBots.length} TOTAL)
                    </h3>
                  </div>
                  <div className="flex items-center space-x-2">
                    <span className="text-[11px] text-zinc-400 hidden sm:inline">
                      Monitorizare în timp real pe toată înălțimea (Buy Low / Sell High)
                    </span>
                    <button
                      type="button"
                      onClick={() => setActiveTab('CONFIG')}
                      className="px-2 py-0.5 rounded bg-zinc-900 hover:bg-zinc-800 text-cyan-300 border border-cyan-500/40 text-[10px] font-bold cursor-pointer"
                    >
                      [Setări Autopilot &amp; Simulator ➔]
                    </button>
                  </div>
                </div>

                {gridBots.length === 0 ? (
                  <div className="bg-black border border-zinc-800 rounded p-6 sm:p-8 text-center flex-1 flex flex-col items-center justify-center space-y-3">
                    <Layers className="w-10 h-10 text-amber-500/60 mx-auto" />
                    <div className="text-base font-bold text-white">
                      Niciun Bot Neutral Grid nu este pornit în acest moment.
                    </div>
                    <p className="text-xs text-zinc-400 max-w-xl mx-auto">
                      Alegeți moneda și pragurile în panoul de lansare (sau apăsați{' '}
                      <strong className="text-cyan-400">AUTO-OPTIMIZEAZĂ</strong>), apoi
                      apăsați <strong className="text-emerald-400">LANSEAZĂ BOT NEUTRAL GRID</strong>.
                    </p>
                    <button
                      type="button"
                      onClick={() => setMobileDashView('LAUNCH')}
                      className="lg:hidden px-4 py-2.5 rounded bg-amber-500 text-black font-black text-xs cursor-pointer"
                    >
                      + CONFIGUREAZĂ ȘI LANSEAZĂ BOT ACUM
                    </button>
                  </div>
                ) : (
                  <div className="space-y-2.5 overflow-x-hidden">
                    {gridBots.map((bot) => {
                      const rangePctPos = Math.min(
                        100,
                        Math.max(
                          0,
                          ((bot.currentPrice - bot.config.lowerPrice) /
                            Math.max(1e-9, bot.config.upperPrice - bot.config.lowerPrice)) *
                            100
                        )
                      );
                      const flash = botFlashes[bot.botId];
                      const isRecentFlash = Boolean(flash && nowMs - flash.ts < 3500);
                      const uptimeSec = Math.max(
                        0,
                        Math.floor(
                          ((bot.stoppedAt || nowMs) - (bot.createdAt || nowMs)) / 1000
                        )
                      );
                      const upH = Math.floor(uptimeSec / 3600);
                      const upM = Math.floor((uptimeSec % 3600) / 60);
                      const upS = uptimeSec % 60;
                      const uptimeStr =
                        upH > 0
                          ? `${upH}h ${upM}m ${upS}s`
                          : `${upM}m ${upS < 10 ? '0' : ''}${upS}s`;

                      return (
                        <div
                          key={bot.botId}
                          className={`bg-black border rounded p-3 space-y-2 transition-all duration-300 ${
                            bot.status === 'RUNNING'
                              ? isRecentFlash && flash?.priceDir === 'up'
                                ? 'border-emerald-400 shadow-[0_0_14px_rgba(16,185,129,0.28)]'
                                : isRecentFlash && flash?.priceDir === 'down'
                                ? 'border-rose-400 shadow-[0_0_14px_rgba(244,63,94,0.28)]'
                                : rxFlash
                                ? 'border-cyan-400/70'
                                : 'border-emerald-500/50'
                              : 'border-zinc-800 opacity-80'
                          }`}
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex items-center space-x-2 flex-wrap gap-y-1">
                              <span
                                className={`px-2 py-0.5 rounded text-[10px] font-black inline-flex items-center space-x-1.5 ${
                                  bot.status === 'RUNNING'
                                    ? 'bg-emerald-500 text-black'
                                    : bot.status === 'TAKE_PROFIT_HIT'
                                    ? 'bg-cyan-500 text-black'
                                    : bot.status === 'STOP_LOSS_HIT'
                                    ? 'bg-rose-600 text-white'
                                    : 'bg-zinc-700 text-zinc-200'
                                }`}
                              >
                                {bot.status === 'RUNNING' && (
                                  <span className="relative flex h-2 w-2">
                                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-black opacity-75" />
                                    <span className="relative inline-flex rounded-full h-2 w-2 bg-black" />
                                  </span>
                                )}
                                <span>{bot.status}</span>
                              </span>
                              <span className="font-black text-sm text-white">
                                {bot.symbol}
                              </span>
                              <span className="text-xs text-amber-400 font-bold">
                                {bot.config.leverage}x {bot.config.marginMode.toUpperCase()}
                              </span>
                              <span className="text-[11px] text-zinc-400">
                                ({bot.config.gridCount} trepte {bot.config.gridType})
                              </span>
                              {bot.status === 'RUNNING' && (
                                <span
                                  className={`text-[10px] px-1.5 py-0.5 rounded border tabular-nums transition-colors ${
                                    rxFlash
                                      ? 'bg-cyan-950/80 border-cyan-400 text-cyan-200'
                                      : 'bg-zinc-900 border-zinc-700 text-emerald-300'
                                  }`}
                                  title="Timp de rulare activ (se actualizează la fiecare secundă)"
                                >
                                  ⏱ {uptimeStr}
                                </span>
                              )}
                            </div>

                            <div className="flex items-center space-x-1.5">
                              <button
                                onClick={() => {
                                  setSelectedBotIdForLadder(bot.botId);
                                  setActiveTab('LADDER');
                                }}
                                className="px-2 py-1 bg-zinc-900 hover:bg-zinc-800 text-amber-300 border border-amber-500/40 rounded text-[11px] font-bold cursor-pointer"
                              >
                                [Vezi Trepte ({bot.levels.length})]
                              </button>
                              {bot.status === 'RUNNING' && (
                                <>
                                  <button
                                    onClick={() => {
                                      setEditingBot(bot);
                                      setEditSlPct(bot.config.risk.stopLossPct);
                                      setEditTpPct(bot.config.risk.takeProfitPct);
                                      setEditLowerStop(bot.lowerStopPrice);
                                      setEditUpperStop(bot.upperStopPrice);
                                    }}
                                    className="px-2 py-1 bg-zinc-900 hover:bg-zinc-800 text-cyan-300 border border-cyan-500/40 rounded text-[11px] font-bold cursor-pointer"
                                  >
                                    [SL / TP]
                                  </button>
                                  <button
                                    onClick={() => handleStopGridBot(bot.botId, bot.symbol)}
                                    className="px-2.5 py-1 bg-rose-600 hover:bg-rose-500 text-white rounded text-[11px] font-bold flex items-center space-x-1 cursor-pointer"
                                  >
                                    <Square className="w-3 h-3 fill-current" />
                                    <span>Oprește</span>
                                  </button>
                                </>
                              )}
                              {bot.status !== 'RUNNING' && (
                                <button
                                  onClick={() => handleDeleteStoppedBot(bot.botId)}
                                  className="px-2 py-1 bg-zinc-900 hover:bg-rose-950 text-zinc-400 hover:text-rose-300 border border-zinc-700 rounded text-[11px] cursor-pointer"
                                  title="Șterge din istoric"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              )}
                            </div>
                          </div>

                          {/* Visual Range Progress Bar */}
                          <div className="space-y-1">
                            <div className="flex justify-between items-center text-[11px]">
                              <span className="text-emerald-400 tabular-nums">
                                Min: ${formatPrice(bot.config.lowerPrice)} (SL: $
                                {formatPrice(bot.lowerStopPrice)})
                              </span>
                              <span
                                className={`font-bold px-2 py-0.5 rounded border tabular-nums transition-all duration-300 ${
                                  isRecentFlash && flash?.priceDir === 'up'
                                    ? 'bg-emerald-950 border-emerald-400 text-emerald-200'
                                    : isRecentFlash && flash?.priceDir === 'down'
                                    ? 'bg-rose-950 border-rose-400 text-rose-200'
                                    : 'bg-zinc-950 border-zinc-800 text-white'
                                }`}
                              >
                                Preț Live: ${formatPrice(bot.currentPrice)}{' '}
                                {isRecentFlash && flash?.priceDir === 'up' && (
                                  <span className="text-emerald-400">▲</span>
                                )}
                                {isRecentFlash && flash?.priceDir === 'down' && (
                                  <span className="text-rose-400">▼</span>
                                )}
                              </span>
                              <span className="text-rose-400 tabular-nums">
                                Max: ${formatPrice(bot.config.upperPrice)} (SL: $
                                {formatPrice(bot.upperStopPrice)})
                              </span>
                            </div>
                            <div className="w-full h-2.5 bg-zinc-900 rounded-full overflow-hidden relative border border-zinc-800">
                              <div
                                className="h-full bg-gradient-to-r from-emerald-500 via-amber-400 to-rose-500 transition-all duration-500"
                                style={{ width: `${rangePctPos}%` }}
                              />
                              {bot.status === 'RUNNING' && (
                                <div
                                  className="absolute top-0 bottom-0 w-1.5 bg-white shadow-[0_0_8px_#fff] animate-pulse transition-all duration-500"
                                  style={{ left: `calc(${rangePctPos}% - 3px)` }}
                                />
                              )}
                            </div>
                          </div>

                          {/* Bot Metrics Row */}
                          <div className="grid grid-cols-2 sm:grid-cols-6 gap-2 pt-1 text-[11px] bg-zinc-950 p-2 rounded border border-zinc-900">
                            <div>
                              <span className="text-zinc-500 block text-[10px]">Buget Alocat</span>
                              <span className="text-white font-bold tabular-nums">
                                ${bot.config.marginInvestedUSDT.toFixed(2)}
                              </span>
                            </div>
                            <div>
                              <span className="text-zinc-500 block text-[10px]">Profit Grilă</span>
                              <span className="text-emerald-400 font-bold tabular-nums">
                                +${bot.gridProfitUSDT.toFixed(3)}
                              </span>
                              <span className="text-[9px] text-zinc-500 block tabular-nums">
                                Fee: -${(bot.totalFeesUSDT || 0).toFixed(3)}
                              </span>
                            </div>
                            <div>
                              <span className="text-zinc-500 block text-[10px]">Floating PnL</span>
                              <span
                                className={`font-bold tabular-nums ${
                                  bot.floatingPnlUSDT >= 0
                                    ? 'text-emerald-300'
                                    : 'text-rose-400'
                                }`}
                              >
                                {bot.floatingPnlUSDT >= 0 ? '+' : ''}$
                                {bot.floatingPnlUSDT.toFixed(3)}
                              </span>
                            </div>
                            <div
                              className={`rounded px-1 transition-colors duration-300 ${
                                isRecentFlash && flash?.pnlDir === 'up'
                                  ? 'bg-emerald-950/70'
                                  : isRecentFlash && flash?.pnlDir === 'down'
                                  ? 'bg-rose-950/70'
                                  : ''
                              }`}
                            >
                              <span className="text-zinc-500 block text-[10px]">PnL Total Net</span>
                              <span
                                className={`font-bold tabular-nums ${
                                  bot.totalNetPnlUSDT >= 0
                                    ? 'text-emerald-400'
                                    : 'text-rose-400'
                                }`}
                              >
                                {bot.totalNetPnlUSDT >= 0 ? '+' : ''}$
                                {bot.totalNetPnlUSDT.toFixed(2)} ({bot.totalNetPnlPct}%)
                              </span>
                            </div>
                            <div>
                              <span className="text-zinc-500 block text-[10px]">Arbitraje</span>
                              <span className="text-amber-300 font-bold tabular-nums">
                                {bot.completedArbitrages} match-uri
                              </span>
                            </div>
                            <div>
                              <span className="text-zinc-500 block text-[10px]">
                                {bot.executionMode === 'LIVE' ? 'Ordine pe OKX' : 'Ordine Active'}
                              </span>
                              <span className="text-white font-bold tabular-nums">
                                <span className="text-emerald-400">{bot.activeBuyOrders}B</span> /{' '}
                                <span className="text-rose-400">{bot.activeSellOrders}S</span>
                              </span>
                              {bot.executionMode === 'LIVE' && (
                                <span className="text-[9px] text-zinc-500 block tabular-nums">
                                  din {bot.levels.filter((l) => l.status === 'OPEN_ORDER').length} trepte
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ================================================================= */}
        {/* TAB 2: AUTOPILOT CONFIGURABIL & SIMULATOR VIZUAL DE TREPTE        */}
        {/* ================================================================= */}
        {activeTab === 'CONFIG' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 items-start">
            {/* LEFT COLUMN (5 COLS): AUTOPILOT CONFIGURABIL */}
            <div className="lg:col-span-5 bg-zinc-950 border border-cyan-500/40 rounded p-3 flex flex-col justify-between space-y-3">
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-cyan-500/30 pb-2">
                  <div className="flex items-center space-x-2">
                    <Zap className="w-4 h-4 text-cyan-400" />
                    <div>
                      <h2 className="font-bold text-xs sm:text-sm text-cyan-300">
                        MOD DECIZIE LANSARE: AUTOPILOT CONFIGURABIL
                      </h2>
                      <p className="text-[11px] text-zinc-400">
                        Scanează primele <strong className="text-white">{apMaxScannedSymbols}</strong> instrumente la fiecare{' '}
                        <strong className="text-white">{apScanIntervalSec}s</strong> și lansează autonom boți când Scorul Grid ≥{' '}
                        <strong className="text-emerald-400">{apMinScore}/100</strong>.
                      </p>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => handleSaveAutopilot(!apEnabled)}
                    disabled={isSavingAutopilot}
                    className={`px-3 py-1.5 rounded text-xs font-black cursor-pointer transition-all ${
                      apEnabled
                        ? 'bg-cyan-400 text-black shadow-[0_0_12px_rgba(34,211,238,0.5)]'
                        : 'bg-zinc-900 text-zinc-300 border border-zinc-700 hover:border-cyan-400'
                    }`}
                  >
                    {apEnabled ? 'AUTOPILOT: ACTIV (ON)' : 'AUTOPILOT: OPRIT (OFF)'}
                  </button>
                </div>

                {/* 1. SCANARE UNIVERS & PRAG DECIZIE */}
                <div className="bg-black border border-zinc-800 rounded p-2.5 space-y-2">
                  <label className="text-xs font-bold text-cyan-300 block">
                    1. FRECVENȚĂ SCANARE &amp; DIMENSIUNE UNIVERS
                  </label>
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <span className="text-[10px] text-zinc-400 block mb-0.5">
                        Interval Scanare (sec)
                      </span>
                      <input
                        type="number"
                        min={15}
                        max={600}
                        value={apScanIntervalSec}
                        onChange={(e) =>
                          setApScanIntervalSec(parseInt(e.target.value, 10) || 60)
                        }
                        className="w-full bg-zinc-900 border border-cyan-500/40 rounded px-2 py-1.5 text-xs text-cyan-300 font-bold"
                      />
                    </div>
                    <div>
                      <span className="text-[10px] text-zinc-400 block mb-0.5">
                        Instrumente Analizate
                      </span>
                      <input
                        type="number"
                        min={1}
                        max={100}
                        value={apMaxScannedSymbols}
                        onChange={(e) =>
                          setApMaxScannedSymbols(
                            Math.max(1, Math.min(100, parseInt(e.target.value, 10) || 1))
                          )
                        }
                        className="w-full bg-zinc-900 border border-amber-500/40 rounded px-2 py-1.5 text-xs text-amber-300 font-bold"
                      />
                    </div>
                    <div>
                      <span className="text-[10px] text-zinc-400 block mb-0.5">
                        Scor Minim Grid (30–98)
                      </span>
                      <input
                        type="number"
                        min={30}
                        max={98}
                        value={apMinScore}
                        onChange={(e) =>
                          setApMinScore(parseInt(e.target.value, 10) || 30)
                        }
                        className="w-full bg-zinc-900 border border-emerald-500/40 rounded px-2 py-1.5 text-xs text-emerald-300 font-bold"
                      />
                    </div>
                  </div>
                </div>

                {/* 2. ALOCARE CAPITAL & MAX BOȚI SIMULTANI */}
                <div className="bg-black border border-zinc-800 rounded p-2.5 space-y-2">
                  <label className="text-xs font-bold text-cyan-300 block">
                    2. ALOCARE CAPITAL &amp; BOȚI SIMULTANI AUTOPILOT
                  </label>
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <span className="text-[10px] text-zinc-400 block mb-0.5">
                        Max Boți Simultani (1–100)
                      </span>
                      <input
                        type="number"
                        min={1}
                        max={100}
                        value={apMaxBots}
                        onChange={(e) =>
                          setApMaxBots(Math.max(1, Math.min(100, parseInt(e.target.value, 10) || 1)))
                        }
                        className="w-full bg-zinc-900 border border-amber-500/40 rounded px-2 py-1.5 text-xs text-white font-bold"
                      />
                    </div>
                    <div>
                      <span className="text-[10px] text-zinc-400 block mb-0.5">
                        Marjă / Bot Auto ($)
                      </span>
                      <input
                        type="number"
                        min={3}
                        step="1"
                        value={apMarginPerBot}
                        onChange={(e) =>
                          setApMarginPerBot(parseFloat(e.target.value) || 10)
                        }
                        className="w-full bg-zinc-900 border border-emerald-500/40 rounded px-2 py-1.5 text-xs text-emerald-300 font-bold"
                      />
                    </div>
                    <div>
                      <span className="text-[10px] text-zinc-400 block mb-0.5">
                        Rezervă Păstrată ($)
                      </span>
                      <input
                        type="number"
                        min={0}
                        step="1"
                        value={apMinReserve}
                        onChange={(e) =>
                          setApMinReserve(parseFloat(e.target.value) || 0)
                        }
                        className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-xs text-zinc-200 font-bold"
                      />
                    </div>
                  </div>
                </div>

                {/* 3. PARAMETRI TEHNICI & PROTECȚIE SL/TP AUTOPILOT */}
                <div className="bg-black border border-zinc-800 rounded p-2.5 space-y-2">
                  <label className="text-xs font-bold text-cyan-300 block">
                    3. LEVIER, MOD MARJĂ &amp; STOP LOSS / TAKE PROFIT AUTOPILOT
                  </label>
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <span className="text-[10px] text-zinc-400 block mb-0.5">
                        Levier Implicit
                      </span>
                      <select
                        value={apDefaultLeverage}
                        onChange={(e) => {
                          const nextLev = parseInt(e.target.value, 10) || 3;
                          setApUseAnalyzerLeverage(false);
                          syncLeverageAndMarginMode(nextLev, apMarginMode);
                        }}
                        className="w-full bg-zinc-900 border border-amber-500/40 rounded px-2 py-1.5 text-xs text-amber-300 font-bold"
                      >
                        {[1, 2, 3, 5, 7, 10, 15, 20].map((l) => (
                          <option key={l} value={l}>
                            {l}x Levier
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <span className="text-[10px] text-zinc-400 block mb-0.5">
                        Mod Marjă Auto
                      </span>
                      <select
                        value={apMarginMode}
                        onChange={(e) => {
                          const nextMode = e.target.value as 'cross' | 'isolated';
                          syncLeverageAndMarginMode(apDefaultLeverage, nextMode);
                        }}
                        className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-xs text-white font-bold"
                      >
                        <option value="isolated">ISOLATED</option>
                        <option value="cross">CROSS</option>
                      </select>
                    </div>
                    <div>
                      <span className="text-[10px] text-zinc-400 block mb-0.5">
                        Tip Grilă Auto
                      </span>
                      <select
                        value={apGridType}
                        onChange={(e) =>
                          setApGridType(e.target.value as GridSpacingType)
                        }
                        className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-xs text-white font-bold"
                      >
                        <option value="ARITHMETIC">ARITMETICĂ</option>
                        <option value="GEOMETRIC">GEOMETRICĂ</option>
                      </select>
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-2 pt-1">
                    <div>
                      <span className="text-[10px] text-rose-400 block mb-0.5">
                        SL Auto (% Marjă)
                      </span>
                      <input
                        type="number"
                        step="0.5"
                        value={apStopLossPct}
                        onChange={(e) =>
                          setApStopLossPct(parseFloat(e.target.value) || 8)
                        }
                        className="w-full bg-zinc-900 border border-rose-500/40 rounded px-2 py-1.5 text-xs text-rose-300 font-bold"
                      />
                    </div>
                    <div>
                      <span className="text-[10px] text-emerald-400 block mb-0.5">
                        TP Auto (% Marjă)
                      </span>
                      <input
                        type="number"
                        step="0.5"
                        value={apTakeProfitPct}
                        onChange={(e) =>
                          setApTakeProfitPct(parseFloat(e.target.value) || 15)
                        }
                        className="w-full bg-zinc-900 border border-emerald-500/40 rounded px-2 py-1.5 text-xs text-emerald-300 font-bold"
                      />
                    </div>
                    <div>
                      <span className="text-[10px] text-zinc-400 block mb-0.5">
                        Cooldown / Monedă (min)
                      </span>
                      <input
                        type="number"
                        min={1}
                        max={240}
                        value={apCooldownMin}
                        onChange={(e) =>
                          setApCooldownMin(parseInt(e.target.value, 10) || 15)
                        }
                        className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-xs text-zinc-200 font-bold"
                      />
                    </div>
                  </div>

                  <div className="space-y-1.5 pt-1 text-xs text-zinc-300">
                    <label className="flex items-center space-x-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={apUseAnalyzerLeverage}
                        onChange={(e) => setApUseAnalyzerLeverage(e.target.checked)}
                        className="accent-cyan-500"
                      />
                      <span>Folosește levierul recomandat dinamic de analizorul ATR</span>
                    </label>
                    <label className="flex items-center space-x-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={apOnlyIdealRegime}
                        onChange={(e) => setApOnlyIdealRegime(e.target.checked)}
                        className="accent-cyan-500"
                      />
                      <span>Lansează doar în regim lateral confirmat (evită STRONG_TREND_AVOID)</span>
                    </label>
                  </div>
                </div>

                {/* Status Decizie Autopilot */}
                <div className="bg-black border border-cyan-500/30 rounded p-2.5 text-xs space-y-1">
                  <div className="text-cyan-400 font-bold">
                    Ultima Decizie Autopilot:
                  </div>
                  <div className="text-zinc-300">
                    {serverAutopilot?.lastAutopilotAction ||
                      'În așteptarea activării sau a următoarei scanări'}
                  </div>
                </div>
              </div>

              <div className="pt-2 border-t border-cyan-500/30 flex flex-col sm:flex-row gap-2">
                <button
                  type="button"
                  onClick={() => handleSaveAutopilot()}
                  disabled={isSavingAutopilot}
                  className="flex-1 py-2.5 px-3 rounded bg-cyan-500 hover:bg-cyan-400 text-black font-black text-xs flex items-center justify-center space-x-1.5 cursor-pointer"
                >
                  <Save className="w-4 h-4" />
                  <span>
                    {isSavingAutopilot ? 'SE SALVEAZĂ...' : 'SALVEAZĂ SETĂRI AUTOPILOT'}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={handleRunAutopilotNow}
                  disabled={isRunningAutopilotNow || isKillSwitch}
                  className="py-2.5 px-3 rounded bg-amber-500 hover:bg-amber-400 text-black font-black text-xs flex items-center justify-center space-x-1.5 cursor-pointer"
                >
                  <Play className="w-3.5 h-3.5 fill-current" />
                  <span>
                    {isRunningAutopilotNow ? 'SE EVALUEAZĂ...' : 'TESTEAZĂ / LANSEAZĂ AUTO ACUM'}
                  </span>
                </button>
              </div>
            </div>

            {/* RIGHT COLUMN (7 COLS): SIMULATOR VIZUAL DE TREPTE PE TOATĂ ÎNĂLȚIMEA */}
            <div className="lg:col-span-7 bg-zinc-950 border border-amber-500/40 rounded p-3 flex flex-col space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-500/30 pb-2 shrink-0">
                <div>
                  <h3 className="font-bold text-sm text-amber-400">
                    SIMULARE VIZUALĂ A CELOR {gridPreview.levels.length} TREPTE ÎNAINTE DE LANSARE ({selectedSymbol})
                  </h3>
                  <span className="text-[11px] text-zinc-400">
                    Pas: ${formatPrice(gridPreview.stepUSDT)} ({gridPreview.stepPct.toFixed(2)}%) | Profit Net/Treaptă: +{gridPreview.netProfitPerGridPct.toFixed(2)}% | Valoare/Treaptă: ${gridPreview.notionalPerGrid.toFixed(2)}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setMobileDashView('LAUNCH');
                    setActiveTab('DASHBOARD');
                  }}
                  className="px-2.5 py-1 rounded bg-emerald-500 hover:bg-emerald-400 text-black font-black text-xs cursor-pointer"
                >
                  [Mergi la Lansare Manuală ➔]
                </button>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead className="sticky top-0 bg-zinc-950">
                    <tr className="border-b border-zinc-800 text-zinc-400 text-[10px]">
                      <th className="py-1.5 px-2">Treaptă #</th>
                      <th className="py-1.5 px-2">Preț Treaptă ($)</th>
                      <th className="py-1.5 px-2">Ordin Inițial</th>
                      <th className="py-1.5 px-2">Valoare Ordin ($)</th>
                      <th className="py-1.5 px-2">Distanță față de Preț</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...gridPreview.levels].reverse().map((lvl) => {
                      const distPct =
                        ((lvl.price - gridPreview.refPx) / gridPreview.refPx) * 100;
                      return (
                        <tr
                          key={lvl.index}
                          className="border-b border-zinc-900 hover:bg-zinc-900/60"
                        >
                          <td className="py-1.5 px-2 font-bold text-zinc-300">
                            Nivel #{lvl.index}
                          </td>
                          <td className="py-1.5 px-2 font-bold text-white">
                            ${formatPrice(lvl.price)}
                          </td>
                          <td className="py-1.5 px-2">
                            <span
                              className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                                lvl.side === 'BUY'
                                  ? 'bg-emerald-950 text-emerald-300 border border-emerald-500/40'
                                  : lvl.side === 'SELL'
                                  ? 'bg-rose-950 text-rose-300 border border-rose-500/40'
                                  : 'bg-amber-950 text-amber-300 border border-amber-500/40'
                              }`}
                            >
                              {lvl.side === 'BUY'
                                ? 'LIMIT BUY (Sub Preț)'
                                : lvl.side === 'SELL'
                                ? 'LIMIT SELL (Peste Preț)'
                                : 'PIVOT CENTRAL'}
                            </span>
                          </td>
                          <td className="py-1.5 px-2 text-zinc-300">
                            ${lvl.notionalUSDT.toFixed(2)} USDT
                          </td>
                          <td
                            className={`py-1.5 px-2 font-bold ${
                              distPct >= 0 ? 'text-rose-400' : 'text-emerald-400'
                            }`}
                          >
                            {distPct >= 0 ? '+' : ''}
                            {distPct.toFixed(2)}%
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* ================================================================= */}
        {/* TAB 3: UNIVERS SCANNER PENTRU NEUTRAL GRID (NeutralGridAnalyzer)  */}
        {/* ================================================================= */}
        {activeTab === 'SCANNER' && (
          <div className="bg-zinc-950 border border-amber-500/40 rounded p-3 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-500/30 pb-2">
              <div>
                <h2 className="font-bold text-sm text-amber-400">
                  NEUTRAL GRID UNIVERSE SCANNER (ANALIZĂ CHOPPINESS, RANGE 24H, ATR, SPREAD &amp; FUNDING)
                </h2>
                <p className="text-xs text-zinc-400">
                  Identifică automat monedele aflate în consolidare laterală (Choppiness ridicat, ADX scăzut) ideale pentru profit din grilă neutră.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex items-center space-x-1.5 bg-black border border-cyan-500/40 rounded px-2 py-1 text-xs">
                  <span className="text-zinc-400">Interval Scanare:</span>
                  {[30, 60, 90, 180].map((sec) => (
                    <button
                      key={sec}
                      type="button"
                      onClick={() => {
                        setApScanIntervalSec(sec);
                        fetch('/api/bot/grid/autopilot', {
                          method: 'POST',
                          headers: authHeaders(),
                          body: JSON.stringify({ scanIntervalSec: sec }),
                        }).then(() => onRefresh());
                      }}
                      className={`px-1.5 py-0.5 rounded text-[10px] font-bold cursor-pointer ${
                        apScanIntervalSec === sec
                          ? 'bg-cyan-500 text-black'
                          : 'bg-zinc-900 text-zinc-300'
                      }`}
                    >
                      {sec}s
                    </button>
                  ))}
                </div>

                <button
                  type="button"
                  onClick={() => handleSaveAutopilot(!apEnabled)}
                  className={`px-3 py-1.5 rounded font-black text-xs flex items-center space-x-1.5 cursor-pointer ${
                    apEnabled
                      ? 'bg-cyan-500 text-black'
                      : 'bg-zinc-900 text-cyan-300 border border-cyan-500/40'
                  }`}
                >
                  <Zap className="w-3.5 h-3.5" />
                  <span>
                    {apEnabled
                      ? `AUTOPILOT ON (Scor ≥${apMinScore})`
                      : 'ACTIVEAZĂ AUTOPILOT'}
                  </span>
                </button>

                <button
                  onClick={onTriggerScan}
                  className="px-3 py-1.5 bg-amber-500 hover:bg-amber-400 text-black font-black text-xs rounded flex items-center space-x-1.5 cursor-pointer"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>SCANEAZĂ PIAȚA ACUM</span>
                </button>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="border-b border-zinc-800 text-zinc-400 text-[11px]">
                    <th className="py-2 px-2">Rank</th>
                    <th className="py-2 px-2">Monedă</th>
                    <th className="py-2 px-2">Scor Grid</th>
                    <th className="py-2 px-2">Regim Lateral</th>
                    <th className="py-2 px-2">Preț Curent</th>
                    <th className="py-2 px-2">Choppiness / ADX</th>
                    <th className="py-2 px-2">Range 24h / ATR</th>
                    <th className="py-2 px-2">Praguri Recomandate (Min – Max)</th>
                    <th className="py-2 px-2">Trepte &amp; Levier</th>
                    <th className="py-2 px-2">Acțiuni (Manual / Configurator)</th>
                  </tr>
                </thead>
                <tbody>
                  {gridCandidates.map((cand) => (
                    <tr
                      key={cand.symbol}
                      className="border-b border-zinc-900 hover:bg-zinc-900/60"
                    >
                      <td className="py-2 px-2 font-bold text-amber-400">#{cand.rank}</td>
                      <td className="py-2 px-2 font-black text-white">{cand.symbol}</td>
                      <td className="py-2 px-2">
                        <span
                          className={`px-2 py-0.5 rounded font-black text-xs ${
                            cand.gridSuitabilityScore >= apMinScore
                              ? 'bg-emerald-500 text-black'
                              : cand.gridSuitabilityScore >= 60
                              ? 'bg-amber-500 text-black'
                              : 'bg-zinc-800 text-zinc-300'
                          }`}
                        >
                          {cand.gridSuitabilityScore} / 100
                        </span>
                      </td>
                      <td className="py-2 px-2">
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                            cand.regimeLabel === 'IDEAL_RANGE'
                              ? 'bg-emerald-950 text-emerald-300 border border-emerald-500/40'
                              : cand.regimeLabel === 'HIGH_VOL_RANGE'
                              ? 'bg-cyan-950 text-cyan-300 border border-cyan-500/40'
                              : 'bg-rose-950 text-rose-300 border border-rose-500/40'
                          }`}
                        >
                          {cand.regimeLabel}
                        </span>
                      </td>
                      <td className="py-2 px-2 font-bold text-white">
                        ${formatPrice(cand.price)}
                      </td>
                      <td className="py-2 px-2 text-zinc-300">
                        Chop: <strong>{cand.choppinessIndex}</strong> | ADX:{' '}
                        <strong>{cand.adxTrendStrength}</strong>
                      </td>
                      <td className="py-2 px-2 text-zinc-300">
                        {cand.range24hPct}% | ATR {cand.atrPct}%
                      </td>
                      <td className="py-2 px-2 font-bold text-amber-300">
                        ${formatPrice(cand.recommendedLowerPrice)} – $
                        {formatPrice(cand.recommendedUpperPrice)}
                      </td>
                      <td className="py-2 px-2 text-zinc-200">
                        {cand.recommendedGridCount} trepte × {cand.recommendedLeverage}x
                      </td>
                      <td className="py-2 px-2">
                        <div className="flex items-center space-x-1.5">
                          <button
                            onClick={() => handleDirectLaunchCandidate(cand)}
                            disabled={isCreatingBot || isKillSwitch}
                            className="px-2.5 py-1 bg-emerald-500 hover:bg-emerald-400 text-black font-black rounded text-[11px] cursor-pointer"
                            title="Lansează imediat botul cu parametrii recomandați"
                          >
                            Lansează Acum
                          </button>
                          <button
                            onClick={() => handleLoadCandidateIntoConfigurator(cand)}
                            className="px-2 py-1 bg-zinc-900 hover:bg-zinc-800 text-amber-300 border border-amber-500/40 font-bold rounded text-[11px] cursor-pointer"
                            title="Încarcă în Configurator pentru a edita manual pragurile sau treptele"
                          >
                            Editează
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ================================================================= */}
        {/* TAB 4: TREPTE GRILĂ & ORDINE ACTIVE (GRID LADDER & ARBITRAGES)    */}
        {/* ================================================================= */}
        {activeTab === 'LADDER' && (
          <div className="space-y-3">
            <div className="bg-zinc-950 border border-cyan-500/40 rounded px-3 py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="flex items-center space-x-2 text-zinc-300">
                <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
                <span>
                  <strong className="text-emerald-400">PERSISTENȚĂ ACTIVĂ PE DISC (.data/):</strong>{' '}
                  Treptele grilei sunt salvate în <code className="text-amber-300">.data/grid_bots.json</code>, ordinele în{' '}
                  <code className="text-amber-300">.data/orders.json</code> ({orders.length}/500 ordine), iar arbitrajele în{' '}
                  <code className="text-amber-300">.data/grid_arbitrages.json</code> ({recentArbitrages.length}/500 match-uri).
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  onClick={() => handleExportCsv('grid_arbitrages')}
                  className="px-2.5 py-1 rounded bg-emerald-950/80 hover:bg-emerald-900 text-emerald-300 border border-emerald-500/50 text-[11px] font-bold cursor-pointer flex items-center space-x-1"
                  title="Descarcă .data/grid_arbitrages.json în format CSV (limită 500)"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Arbitraje .CSV</span>
                </button>
                <button
                  onClick={() => handleExportCsv('orders')}
                  className="px-2.5 py-1 rounded bg-amber-950/80 hover:bg-amber-900 text-amber-300 border border-amber-500/50 text-[11px] font-bold cursor-pointer flex items-center space-x-1"
                  title="Descarcă .data/orders.json în format CSV"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Ordine .CSV</span>
                </button>
                <button
                  onClick={() => handleExportCsv('grid_bots')}
                  className="px-2.5 py-1 rounded bg-cyan-950/80 hover:bg-cyan-900 text-cyan-300 border border-cyan-500/50 text-[11px] font-bold cursor-pointer flex items-center space-x-1"
                  title="Descarcă .data/grid_bots.json (boții și metricile PnL) în format CSV"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Boți Grid .CSV</span>
                </button>
                <button
                  onClick={() => handleExportCsv('grid_levels')}
                  className="px-2.5 py-1 rounded bg-zinc-900 hover:bg-zinc-800 text-zinc-200 border border-zinc-700 text-[11px] font-bold cursor-pointer flex items-center space-x-1"
                  title="Descarcă toate treptele grilei din .data/grid_bots.json în format CSV"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Trepte .CSV</span>
                </button>
                <button
                  onClick={() => handleExportCsv('audit')}
                  className="px-2.5 py-1 rounded bg-zinc-900 hover:bg-zinc-800 text-zinc-200 border border-zinc-700 text-[11px] font-bold cursor-pointer flex items-center space-x-1"
                  title="Descarcă .data/audit.json în format CSV"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Jurnal .CSV</span>
                </button>
                {onClearOrders && (
                  <button
                    onClick={onClearOrders}
                    className="px-2.5 py-1 rounded bg-zinc-900 hover:bg-rose-950 text-zinc-300 hover:text-rose-300 border border-zinc-700 text-[11px] font-bold cursor-pointer"
                  >
                    Șterge Istoric Ordine (.data/orders.json)
                  </button>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-3">
              <div className="lg:col-span-7 bg-zinc-950 border border-amber-500/40 rounded p-3 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-500/30 pb-2">
                  <h2 className="font-bold text-sm text-amber-400">
                    SCARA TREPTELOR GRILEI (SALVATE ÎN .data/grid_bots.json)
                  </h2>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleExportCsv('grid_levels')}
                      className="px-2 py-1 rounded bg-zinc-900 hover:bg-zinc-800 text-amber-300 border border-amber-500/40 text-[10px] font-bold cursor-pointer flex items-center space-x-1"
                    >
                      <Download className="w-3 h-3" />
                      <span>.CSV</span>
                    </button>
                    <select
                      value={selectedLadderBot?.botId || ''}
                      onChange={(e) => setSelectedBotIdForLadder(e.target.value)}
                      className="bg-zinc-900 border border-amber-500/50 rounded px-2.5 py-1 text-xs text-white font-bold"
                    >
                      {gridBots.map((b) => (
                        <option key={b.botId} value={b.botId}>
                          {b.symbol} ({b.status}) — {b.config.gridCount} trepte
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {!selectedLadderBot ? (
                  <div className="text-center py-8 text-zinc-400 text-xs">
                    Nu există niciun bot Grid cu ordine Limit pentru afișarea treptelor. Lansați un bot din tabul [1:OKX NATIVE &amp; AUTO-LIMIT GRID] (Ramura 1: Ordine Limit).
                  </div>
                ) : (
                  <div className="overflow-y-auto max-h-[68vh]">
                    <table className="w-full text-left text-xs border-collapse">
                      <thead>
                        <tr className="border-b border-zinc-800 text-zinc-400 text-[10px]">
                          <th className="py-1.5 px-2">Treaptă</th>
                          <th className="py-1.5 px-2">Preț ($)</th>
                          <th className="py-1.5 px-2">Parte Ordin</th>
                          <th className="py-1.5 px-2">Contracte</th>
                          <th className="py-1.5 px-2">Valoare ($)</th>
                          <th className="py-1.5 px-2">Status</th>
                          <th className="py-1.5 px-2">Execuții</th>
                          <th className="py-1.5 px-2">Profit Treaptă</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...selectedLadderBot.levels].reverse().map((lvl) => (
                          <tr
                            key={lvl.index}
                            className="border-b border-zinc-900 hover:bg-zinc-900/60"
                          >
                            <td className="py-1.5 px-2 font-bold text-zinc-300">
                              #{lvl.index + 1}
                            </td>
                            <td className="py-1.5 px-2 font-bold text-white">
                              ${formatPrice(lvl.price)}
                            </td>
                            <td className="py-1.5 px-2">
                              <span
                                className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                                  lvl.side === 'Buy'
                                    ? 'bg-emerald-950 text-emerald-300 border border-emerald-500/40'
                                    : lvl.side === 'Sell'
                                    ? 'bg-rose-950 text-rose-300 border border-rose-500/40'
                                    : 'bg-zinc-800 text-amber-300'
                                }`}
                              >
                                {lvl.side.toUpperCase()}
                              </span>
                            </td>
                            <td className="py-1.5 px-2 text-zinc-300">
                              {lvl.qtyContracts}
                            </td>
                            <td className="py-1.5 px-2 text-zinc-300">
                              ${lvl.notionalUSDT.toFixed(2)}
                            </td>
                            <td className="py-1.5 px-2">
                              <span className="text-[10px] font-bold text-amber-300">
                                {lvl.status}
                              </span>
                            </td>
                            <td className="py-1.5 px-2 font-bold text-white">
                              {lvl.fillCount}x
                            </td>
                            <td className="py-1.5 px-2 font-bold text-emerald-400">
                              +${lvl.realizedGridProfitUSDT.toFixed(4)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* RIGHT SIDE: COMPLETED GRID ARBITRAGES & SAVED ORDERS BLOTTER */}
              <div className="lg:col-span-5 flex flex-col gap-3">
                <div className="bg-zinc-950 border border-amber-500/40 rounded p-3 space-y-2.5">
                  <div className="flex items-center justify-between border-b border-amber-500/30 pb-2">
                    <h3 className="font-bold text-sm text-emerald-400">
                      ARBITRAJE GRID FINALIZATE ({recentArbitrages.length} / max 500)
                    </h3>
                    <div className="flex items-center space-x-2">
                      <span className="text-[10px] text-zinc-400">
                        .data/grid_arbitrages.json
                      </span>
                      <button
                        onClick={() => handleExportCsv('grid_arbitrages')}
                        className="px-2 py-0.5 rounded bg-emerald-950 hover:bg-emerald-900 text-emerald-300 border border-emerald-500/50 text-[10px] font-bold cursor-pointer flex items-center space-x-1"
                      >
                        <Download className="w-3 h-3" />
                        <span>.CSV</span>
                      </button>
                    </div>
                  </div>

                  {recentArbitrages.length === 0 ? (
                    <div className="text-xs text-zinc-400 py-4 text-center">
                      Niciun ciclu complet de arbitraj (Buy Low ➔ Sell High) finalizat încă.
                    </div>
                  ) : (
                    <div className="space-y-1.5 max-h-60 overflow-y-auto">
                      {recentArbitrages.map((arb) => (
                        <div
                          key={arb.id}
                          className="bg-black border border-emerald-500/30 rounded p-2 text-xs flex items-center justify-between"
                        >
                          <div>
                            <span className="font-bold text-white">{arb.symbol}</span>{' '}
                            <span className="text-zinc-400">Nivel #{arb.gridIndex + 1}</span>
                            <div className="text-[11px] text-zinc-300">
                              {arb.openSide} @ ${formatPrice(arb.openPrice)} ➔ Închis @ $
                              {formatPrice(arb.closePrice)}
                            </div>
                          </div>
                          <div className="text-right">
                            <span className="font-black text-emerald-400 block">
                              +${arb.netProfitUSDT.toFixed(4)} USDT
                            </span>
                            <span className="text-[10px] text-zinc-500">
                              {formatTimeLocal(arb.timestamp)}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="bg-zinc-950 border border-amber-500/40 rounded p-3 space-y-2.5">
                  <div className="flex items-center justify-between border-b border-amber-500/30 pb-2">
                    <h3 className="font-bold text-sm text-amber-400">
                      REGISTRU ORDINE SALVATE ({orders.length} / max 500)
                    </h3>
                    <div className="flex items-center space-x-2">
                      <span className="text-[10px] text-zinc-400">
                        .data/orders.json
                      </span>
                      <button
                        onClick={() => handleExportCsv('orders')}
                        className="px-2 py-0.5 rounded bg-amber-950 hover:bg-amber-900 text-amber-300 border border-amber-500/50 text-[10px] font-bold cursor-pointer flex items-center space-x-1"
                      >
                        <Download className="w-3 h-3" />
                        <span>.CSV</span>
                      </button>
                    </div>
                  </div>

                  {orders.length === 0 ? (
                    <div className="text-xs text-zinc-400 py-4 text-center">
                      Niciun ordin înregistrat în .data/orders.json.
                    </div>
                  ) : (
                    <div className="space-y-1.5 max-h-72 overflow-y-auto">
                      {orders.map((ord) => (
                        <div
                          key={ord.id}
                          className="bg-black border border-zinc-800 rounded p-2 text-xs flex items-center justify-between"
                        >
                          <div>
                            <div className="flex items-center space-x-1.5">
                              <span
                                className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                                  ord.side === 'BUY'
                                    ? 'bg-emerald-950 text-emerald-300'
                                    : 'bg-rose-950 text-rose-300'
                                }`}
                              >
                                {ord.side}
                              </span>
                              <span className="font-bold text-white">{ord.symbol}</span>
                              <span className="text-[10px] text-amber-300 font-bold">
                                [{ord.status}]
                              </span>
                            </div>
                            <div className="text-[11px] text-zinc-400 mt-0.5">
                              Preț: ${formatPrice(ord.price || 0)} | Cantitate: {ord.qty} contracte (${(ord.sizeUSDT || 0).toFixed(2)})
                            </div>
                          </div>
                          <div className="text-right text-[10px] text-zinc-500">
                            <div>{ord.intent}</div>
                            <div>{formatTimeLocal(ord.updatedTime || ord.createdTime)}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ================================================================= */}
        {/* TAB 5: GRID JOURNAL & AUDIT FEED                                  */}
        {/* ================================================================= */}
        {activeTab === 'JOURNAL' && (
          <div className="bg-zinc-950 border border-amber-500/40 rounded p-3 space-y-3">
            <div className="flex items-center justify-between border-b border-amber-500/30 pb-2">
              <h2 className="font-bold text-sm text-amber-400">
                GRID JOURNAL — JURNAL UNIC SELECȚII, CALCULE, ORDINE &amp; RISC ({logs.length})
              </h2>
              <div className="flex items-center space-x-2">
                <button
                  onClick={() => handleExportCsv('audit')}
                  className="px-2.5 py-1 bg-emerald-950 hover:bg-emerald-900 text-emerald-300 border border-emerald-500/50 rounded text-xs font-bold cursor-pointer flex items-center space-x-1"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Descarcă Jurnal (.CSV)</span>
                </button>
                {onClearLogs && (
                  <button
                    onClick={onClearLogs}
                    className="px-2.5 py-1 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 border border-zinc-700 rounded text-xs cursor-pointer"
                  >
                    Golește Jurnalul
                  </button>
                )}
              </div>
            </div>

            <div className="space-y-1.5 max-h-[75vh] overflow-y-auto">
              {logs.map((log) => (
                <div
                  key={log.id}
                  className="bg-black border border-zinc-800 rounded px-3 py-2 text-xs flex items-start justify-between gap-3"
                >
                  <div className="space-x-2">
                    <span className="px-1.5 py-0.5 rounded bg-zinc-900 text-amber-400 font-bold text-[10px]">
                      {log.type}
                    </span>
                    <span className="text-zinc-200">{log.message}</span>
                  </div>
                  <span className="text-[10px] text-zinc-500 shrink-0">
                    {formatDateTimeLocal(log.timestamp)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ================================================================= */}
        {/* TAB 6: CONEXIUNE OKX EEA, TELEGRAM & ARHITECTURĂ MULTI-EXCHANGE    */}
        {/* ================================================================= */}
        {activeTab === 'API' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* OKX EEA API CREDENTIALS */}
            <div className="bg-zinc-950 border border-amber-500/40 rounded p-4 space-y-3">
              <div className="flex items-center justify-between border-b border-amber-500/30 pb-2">
                <div className="flex items-center gap-2">
                  <h2 className="font-bold text-sm text-amber-400">
                    CONFIGURARE API OKX EEA (FUTURES GRID)
                  </h2>
                  {apiKeyInput && secretKeyInput && passphraseInput && (
                    <span className="px-2 py-0.5 text-[10px] font-bold rounded bg-emerald-950/80 border border-emerald-500/50 text-emerald-300">
                      SALVAT PERSISTENT ({okxDemoMode ? 'DEMO' : 'LIVE'})
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setShowSecrets(!showSecrets)}
                  className="text-xs text-zinc-400 hover:text-white flex items-center space-x-1 cursor-pointer"
                >
                  {showSecrets ? (
                    <EyeOff className="w-3.5 h-3.5" />
                  ) : (
                    <Eye className="w-3.5 h-3.5" />
                  )}
                  <span>{showSecrets ? 'Ascunde' : 'Arată'}</span>
                </button>
              </div>

              <div className="bg-black border border-zinc-800 rounded p-2.5 text-xs flex items-center justify-between">
                <span className="text-zinc-400">IP Server pentru OKX API Whitelist:</span>
                <strong className="text-amber-300 select-all">{serverIp}</strong>
              </div>

              <div className="space-y-2 text-xs">
                <div>
                  <label className="text-zinc-400 block mb-1">OKX API Key</label>
                  <input
                    type={showSecrets ? 'text' : 'password'}
                    value={apiKeyInput}
                    onChange={(e) => setApiKeyInput(e.target.value)}
                    placeholder="Introduceți OKX API Key"
                    className="w-full bg-black border border-zinc-700 rounded px-3 py-1.5 text-white"
                  />
                </div>
                <div>
                  <label className="text-zinc-400 block mb-1">OKX Secret Key</label>
                  <input
                    type={showSecrets ? 'text' : 'password'}
                    value={secretKeyInput}
                    onChange={(e) => setSecretKeyInput(e.target.value)}
                    placeholder="Introduceți OKX Secret Key"
                    className="w-full bg-black border border-zinc-700 rounded px-3 py-1.5 text-white"
                  />
                </div>
                <div>
                  <label className="text-zinc-400 block mb-1">OKX Passphrase</label>
                  <input
                    type={showSecrets ? 'text' : 'password'}
                    value={passphraseInput}
                    onChange={(e) => setPassphraseInput(e.target.value)}
                    placeholder="Introduceți OKX Passphrase"
                    className="w-full bg-black border border-zinc-700 rounded px-3 py-1.5 text-white"
                  />
                </div>

                <div className="grid grid-cols-2 gap-2 pt-1">
                  <div>
                    <label className="text-zinc-400 block mb-1">Regiune OKX</label>
                    <select
                      value={okxRegionInput}
                      onChange={(e) => setOkxRegionInput(e.target.value as any)}
                      className="w-full bg-black border border-zinc-700 rounded px-2.5 py-1.5 text-white font-bold"
                    >
                      <option value="EEA">OKX EEA (Europa / România)</option>
                      <option value="GLOBAL">OKX Global</option>
                      <option value="AUTO">Auto-Detect</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-zinc-400 block mb-1">Tip Cont OKX</label>
                    <select
                      value={okxDemoMode ? 'DEMO' : 'LIVE'}
                      onChange={(e) => setOkxDemoMode(e.target.value === 'DEMO')}
                      className="w-full bg-black border border-zinc-700 rounded px-2.5 py-1.5 text-white font-bold"
                    >
                      <option value="LIVE">Cont REAL (Live Trading)</option>
                      <option value="DEMO">Cont DEMO (Simulated OKX)</option>
                    </select>
                  </div>
                </div>

                <div className="flex space-x-2 pt-2">
                  <button
                    type="button"
                    onClick={async () => {
                      const cleanKey = apiKeyInput.trim();
                      const cleanSecret = secretKeyInput.trim();
                      const cleanPass = passphraseInput.trim();
                      try {
                        localStorage.setItem(
                          'tb5_okx_creds_backup',
                          JSON.stringify({
                            apiKey: cleanKey,
                            secretKey: cleanSecret,
                            passphrase: cleanPass,
                            testnet: okxDemoMode,
                            region: okxRegionInput,
                          })
                        );
                      } catch {}
                      if (!onUpdateCredentials) return;
                      const res = await onUpdateCredentials(
                        cleanKey,
                        cleanSecret,
                        cleanPass,
                        okxDemoMode,
                        okxRegionInput
                      );
                      if (res?.success) {
                        setLocalBanner({
                          type: 'success',
                          text: `Cheile OKX (${okxDemoMode ? 'DEMO' : 'LIVE'} / ${okxRegionInput}) au fost salvate persistent pe server și în backup-ul local.`,
                        });
                      }
                    }}
                    className="flex-1 py-2 bg-amber-500 hover:bg-amber-400 text-black font-black rounded cursor-pointer"
                  >
                    Salvează Cheile OKX
                  </button>
                  <button
                    type="button"
                    disabled={isTestingOkx}
                    onClick={async () => {
                      if (!onTestOKXConnection) return;
                      setIsTestingOkx(true);
                      const r = await onTestOKXConnection({
                        apiKey: apiKeyInput,
                        secretKey: secretKeyInput,
                        passphrase: passphraseInput,
                        isDemo: okxDemoMode,
                        region: okxRegionInput,
                      });
                      setOkxTestResult(r);
                      setIsTestingOkx(false);
                    }}
                    className="px-4 py-2 bg-zinc-900 hover:bg-zinc-800 text-amber-300 border border-amber-500/40 font-bold rounded cursor-pointer"
                  >
                    {isTestingOkx ? 'Se testează...' : 'Testează Conexiunea'}
                  </button>
                </div>

                {okxTestResult && (
                  <div
                    className={`p-2.5 rounded border text-xs ${
                      okxTestResult.authenticated
                        ? 'bg-emerald-950/60 border-emerald-500 text-emerald-200'
                        : 'bg-rose-950/60 border-rose-500 text-rose-200'
                    }`}
                  >
                    {okxTestResult.authenticated
                      ? `Conexiune OKX autentificată cu succes! Balanță: $${okxTestResult.equity ?? 0}`
                      : `Eroare conexiune: ${okxTestResult.error || 'Neautentificat'}`}
                  </div>
                )}
              </div>
            </div>

            {/* MULTI-EXCHANGE LAYER & TELEGRAM */}
            <div className="space-y-4">
              <div className="bg-zinc-950 border border-amber-500/40 rounded p-4 space-y-2.5">
                <h3 className="font-bold text-sm text-amber-400 border-b border-amber-500/30 pb-2">
                  EXCHANGE ADAPTER LAYER (PLATFORME EUROPA)
                </h3>
                <p className="text-xs text-zinc-400">
                  Arhitectura TB5 Neutral Grid este decuplată de bursă prin{' '}
                  <code className="text-amber-300">IExecutionAdapter</code>:
                </p>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  {[
                    { id: 'OKX_EEA', name: 'OKX EEA (UM X-Perp & USDT)', active: true },
                    { id: 'BINANCE_EEA', name: 'Binance EEA (MiCA Ready)', active: false },
                    { id: 'BYBIT_EU', name: 'Bybit EU (Netherlands/EEA)', active: false },
                    { id: 'KRAKEN_FUTURES', name: 'Kraken Futures Europe', active: false },
                  ].map((ex) => (
                    <div
                      key={ex.id}
                      onClick={() => ex.active && setPlatform(ex.id as ExchangePlatformId)}
                      className={`p-2.5 rounded border flex items-center justify-between ${
                        ex.active
                          ? 'bg-black border-emerald-500/60 text-white cursor-pointer'
                          : 'bg-black/40 border-zinc-800 text-zinc-500'
                      }`}
                    >
                      <span className="font-bold">{ex.name}</span>
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${
                          ex.active
                            ? 'bg-emerald-500 text-black'
                            : 'bg-zinc-800 text-zinc-400'
                        }`}
                      >
                        {ex.active ? 'ACTIV' : 'EXTENSIBIL'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="bg-zinc-950 border border-amber-500/40 rounded p-4 space-y-2.5">
                <h3 className="font-bold text-sm text-amber-400 border-b border-amber-500/30 pb-2">
                  NOTIFICĂRI TELEGRAM &amp; CONTROL TOKEN
                </h3>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <label className="text-zinc-400 block mb-1">Telegram Bot Token</label>
                    <input
                      type="password"
                      value={tgToken}
                      onChange={(e) => setTgToken(e.target.value)}
                      placeholder="BotFather Token"
                      className="w-full bg-black border border-zinc-700 rounded px-2.5 py-1.5 text-white"
                    />
                  </div>
                  <div>
                    <label className="text-zinc-400 block mb-1">Telegram Chat ID</label>
                    <input
                      type="text"
                      value={tgChatId}
                      onChange={(e) => setTgChatId(e.target.value)}
                      placeholder="Chat ID"
                      className="w-full bg-black border border-zinc-700 rounded px-2.5 py-1.5 text-white"
                    />
                  </div>
                </div>
                <div className="flex space-x-2">
                  <button
                    type="button"
                    onClick={async () => {
                      if (!onSaveTelegramConfig) return;
                      const r = await onSaveTelegramConfig(tgToken, tgChatId);
                      setTgTestResult(r);
                    }}
                    className="px-3 py-1.5 bg-amber-500 text-black font-bold rounded text-xs cursor-pointer"
                  >
                    Salvează Telegram
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      if (!onTestTelegramConnection) return;
                      const r = await onTestTelegramConnection(tgToken, tgChatId);
                      setTgTestResult(r);
                    }}
                    className="px-3 py-1.5 bg-zinc-900 text-amber-300 border border-amber-500/40 font-bold rounded text-xs cursor-pointer"
                  >
                    Testează Telegram
                  </button>
                </div>
                {tgTestResult && (
                  <div className="text-xs text-amber-300 pt-1">
                    {tgTestResult.message ||
                      tgTestResult.error ||
                      (tgTestResult.success ? 'Telegram OK!' : 'Eroare Telegram')}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ================================================================= */}
        {/* TAB 1 PRINCIPAL: OKX NATIVE & AUTO-LIMIT FUTURES GRID             */}
        {/* ================================================================= */}
        {activeTab === 'NATIVE_GRID' && (
          <OKXNativeGridPanel
            opportunities={nativeGridOpportunities}
            bots={nativeGridBots}
            autopilot={nativeGridAutopilot}
            gridAnalyzer={status?.gridAnalyzer}
            feeTierInfo={feeTierInfo}
            freeBalanceUSDT={freeBalance}
            controlToken={controlToken}
            onRefresh={onRefresh}
            onNotify={(banner) => setLocalBanner(banner)}
            onInspectLadder={(botId) => {
              setSelectedBotIdForLadder(botId);
              setActiveTab('LADDER');
            }}
          />
        )}
      </main>

      {/* =================================================================== */}
      {/* MODAL CALCULATOR LIVE COMISIOANE & VOLUM OKX EEA                    */}
      {/* =================================================================== */}
      <OKXFeeCalculatorModal
        isOpen={showFeeCalculatorModal}
        onClose={() => setShowFeeCalculatorModal(false)}
        feeTierInfo={feeTierInfo}
        totalFeesPaidUSDT={totalFees}
        fillsCount={status?.exchangeFillsSummary?.fillsCount || feeTierInfo?.fillsAnalyzedCount || 0}
        onRefreshFeeTier={async () => {
          try {
            await fetch('/api/bot/fee-tier?force=1');
            onRefresh();
          } catch {}
        }}
      />

      {/* =================================================================== */}
      {/* MODAL PENTRU MODIFICARE RAPIDĂ SL / TP PE UN BOT ACTIV              */}
      {/* =================================================================== */}
      {editingBot && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
          <div className="bg-zinc-950 border border-amber-500 rounded p-4 w-full max-w-md space-y-3">
            <div className="flex items-center justify-between border-b border-amber-500/30 pb-2">
              <h3 className="font-bold text-sm text-amber-400">
                MODIFICARE SL / TP — {editingBot.symbol}
              </h3>
              <button
                onClick={() => setEditingBot(null)}
                className="text-zinc-400 hover:text-white font-bold cursor-pointer"
              >
                ✕
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs">
              <div>
                <label className="text-rose-400 block mb-1">Stop Loss (% din Marjă)</label>
                <input
                  type="number"
                  step="0.5"
                  value={editSlPct}
                  onChange={(e) => setEditSlPct(parseFloat(e.target.value) || 0)}
                  className="w-full bg-black border border-rose-500/50 rounded px-2.5 py-1.5 text-white font-bold"
                />
              </div>
              <div>
                <label className="text-emerald-400 block mb-1">Take Profit (% din Marjă)</label>
                <input
                  type="number"
                  step="0.5"
                  value={editTpPct}
                  onChange={(e) => setEditTpPct(parseFloat(e.target.value) || 0)}
                  className="w-full bg-black border border-emerald-500/50 rounded px-2.5 py-1.5 text-white font-bold"
                />
              </div>
              <div>
                <label className="text-zinc-400 block mb-1">Preț Stop Inferior ($)</label>
                <input
                  type="number"
                  step="any"
                  value={editLowerStop}
                  onChange={(e) => setEditLowerStop(parseFloat(e.target.value) || 0)}
                  className="w-full bg-black border border-zinc-700 rounded px-2.5 py-1.5 text-white"
                />
              </div>
              <div>
                <label className="text-zinc-400 block mb-1">Preț Stop Superior ($)</label>
                <input
                  type="number"
                  step="any"
                  value={editUpperStop}
                  onChange={(e) => setEditUpperStop(parseFloat(e.target.value) || 0)}
                  className="w-full bg-black border border-zinc-700 rounded px-2.5 py-1.5 text-white"
                />
              </div>
            </div>

            <div className="flex justify-end space-x-2 pt-2">
              <button
                onClick={() => setEditingBot(null)}
                className="px-3 py-1.5 bg-zinc-900 text-zinc-300 rounded text-xs cursor-pointer"
              >
                Anulează
              </button>
              <button
                onClick={handleSaveBotRiskModal}
                className="px-4 py-1.5 bg-emerald-500 text-black font-black rounded text-xs cursor-pointer"
              >
                Salvează SL / TP
              </button>
            </div>
          </div>
        </div>
      )}

      {/* =================================================================== */}
      {/* MODAL DE CONFIRMARE KILL SWITCH (PREVENIRE DECLANȘARE ACCIDENTALĂ)  */}
      {/* =================================================================== */}
      {showKillSwitchConfirm && (
        <div
          className="fixed inset-0 z-50 bg-black/85 backdrop-blur-xs flex items-center justify-center p-4"
          onClick={() => {
            if (!isExecutingKillSwitch) setShowKillSwitchConfirm(false);
          }}
        >
          <div
            className={`bg-zinc-950 border-2 rounded-lg p-5 w-full max-w-lg space-y-4 shadow-2xl ${
              isKillSwitch
                ? 'border-amber-500 shadow-[0_0_30px_rgba(245,158,11,0.3)]'
                : 'border-rose-500 shadow-[0_0_35px_rgba(244,63,94,0.4)]'
            }`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between border-b border-zinc-800 pb-3">
              <div className="flex items-center space-x-2.5">
                <div
                  className={`p-2 rounded border ${
                    isKillSwitch
                      ? 'bg-amber-950/60 border-amber-500/50 text-amber-400'
                      : 'bg-rose-950/80 border-rose-500 text-rose-400 animate-pulse'
                  }`}
                >
                  <ShieldAlert className="w-6 h-6" />
                </div>
                <div>
                  <h3
                    className={`font-black text-base tracking-wide ${
                      isKillSwitch ? 'text-amber-400' : 'text-rose-400'
                    }`}
                  >
                    {isKillSwitch
                      ? 'CONFIRMARE DEZACTIVARE KILL SWITCH'
                      : 'CONFIRMARE OPRIRE DE URGENȚĂ (KILL SWITCH)'}
                  </h3>
                  <p className="text-[11px] text-zinc-400">
                    {isKillSwitch
                      ? 'Deblocare motor de tranzacționare TB5'
                      : 'Protecție împotriva declanșării accidentale — verifică impactul înainte de execuție'}
                  </p>
                </div>
              </div>
              <button
                type="button"
                disabled={isExecutingKillSwitch}
                onClick={() => setShowKillSwitchConfirm(false)}
                className="text-zinc-400 hover:text-white font-bold text-sm px-2 py-0.5 rounded hover:bg-zinc-900 cursor-pointer"
              >
                ✕
              </button>
            </div>

            {!isKillSwitch ? (
              <div className="space-y-3 text-xs">
                <div className="bg-rose-950/30 border border-rose-500/40 rounded p-3 space-y-1.5 text-zinc-200">
                  <div className="font-bold text-rose-300 flex items-center space-x-1.5">
                    <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
                    <span>
                      ATENȚIE ({execMode}): Această acțiune se aplică EXCLUSIV modului {execMode}:
                    </span>
                  </div>
                  <ul className="list-disc list-inside space-y-1 text-zinc-300 pl-1">
                    <li>
                      Oprește forțat{' '}
                      <span className="font-black text-white">
                        {runningBots.filter((b) => b.executionMode === execMode).length} boți Grid{' '}
                        {execMode}
                        {execMode === 'LIVE' && runningNativeBotsCount > 0
                          ? ` + ${runningNativeBotsCount} boți OKX Native Grid LIVE`
                          : ''}
                      </span>{' '}
                      și anulează ordinele limită aferente modului {execMode}.
                    </li>
                    <li>
                      Lichidează imediat la prețul pieței (Market Close) pozițiile deschise în modul{' '}
                      <span
                        className={`font-black px-1.5 py-0.5 rounded ${
                          execMode === 'LIVE'
                            ? 'bg-rose-600 text-white'
                            : 'bg-emerald-500/20 text-emerald-300'
                        }`}
                      >
                        {execMode}
                      </span>
                      .
                    </li>
                    {execMode === 'PAPER' ? (
                      <li className="text-emerald-300 font-bold">
                        PROTECȚIE IZOLATĂ: Boții LIVE și pozițiile reale de pe OKX EEA NU sunt atinse de Kill Switch-ul din PAPER!
                      </li>
                    ) : (
                      <li>
                        Blochează Autopilotul LIVE și orice lansare de bot LIVE nou până la dezactivarea manuală.
                      </li>
                    )}
                  </ul>
                </div>

                {/* Live Impact Summary */}
                <div className="grid grid-cols-3 gap-2 bg-black border border-zinc-800 rounded p-2.5 text-center">
                  <div>
                    <span className="text-[10px] text-zinc-500 block">BOȚI {execMode} AFECTAȚI</span>
                    <span className="text-sm font-black text-white tabular-nums">
                      {runningBots.filter((b) => b.executionMode === execMode).length +
                        (execMode === 'LIVE' ? runningNativeBotsCount : 0)}
                    </span>
                  </div>
                  <div>
                    <span className="text-[10px] text-zinc-500 block">MARJĂ ÎN GRILE ({execMode})</span>
                    <span className="text-sm font-black text-amber-400 tabular-nums">
                      ${marginInvested.toFixed(2)}
                    </span>
                  </div>
                  <div>
                    <span className="text-[10px] text-zinc-500 block">PNL NET CURENT ({execMode})</span>
                    <span
                      className={`text-sm font-black tabular-nums ${
                        totalProfit >= 0 ? 'text-emerald-400' : 'text-rose-400'
                      }`}
                    >
                      {totalProfit >= 0 ? '+' : ''}${totalProfit.toFixed(2)}
                    </span>
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-3 text-xs">
                <div className="bg-amber-950/30 border border-amber-500/40 rounded p-3 space-y-1.5 text-zinc-200">
                  <p className="font-bold text-amber-300">
                    Ești sigur că vrei să dezactivezi starea de urgență (Kill Switch {execMode})?
                  </p>
                  <p className="text-zinc-300">
                    După dezactivare, motorul TB5 va permite din nou lansarea de boți Grid în modul {execMode} (manual și/sau prin Autopilot dacă acesta este pornit). Boții opriți anterior nu repornesc singuri fără o nouă lansare.
                  </p>
                </div>
              </div>
            )}

            <div className="flex items-center justify-end space-x-2.5 pt-2 border-t border-zinc-800">
              <button
                type="button"
                disabled={isExecutingKillSwitch}
                onClick={() => setShowKillSwitchConfirm(false)}
                className="px-4 py-2 bg-zinc-900 hover:bg-zinc-800 text-zinc-200 border border-zinc-700 font-bold rounded text-xs cursor-pointer transition-colors"
              >
                ANULEAZĂ (RENUNȚĂ)
              </button>
              <button
                type="button"
                disabled={isExecutingKillSwitch}
                onClick={async () => {
                  setIsExecutingKillSwitch(true);
                  try {
                    await onToggleKillSwitch();
                  } finally {
                    setIsExecutingKillSwitch(false);
                    setShowKillSwitchConfirm(false);
                  }
                }}
                className={`px-4 py-2 font-black rounded text-xs flex items-center space-x-1.5 cursor-pointer transition-all ${
                  isKillSwitch
                    ? 'bg-emerald-500 hover:bg-emerald-400 text-black shadow-[0_0_15px_rgba(16,185,129,0.4)]'
                    : 'bg-rose-600 hover:bg-rose-500 text-white border border-rose-400 shadow-[0_0_15px_rgba(244,63,94,0.5)]'
                }`}
              >
                <ShieldAlert className="w-4 h-4" />
                <span>
                  {isExecutingKillSwitch
                    ? 'SE EXECUTĂ...'
                    : isKillSwitch
                    ? 'CONFIRMĂ DEZACTIVAREA KILL SWITCH'
                    : 'CONFIRMĂ OPRIREA DE URGENȚĂ'}
                </span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* =================================================================== */}
      {/* 6. MOBILE BOTTOM THUMB-ZONE NAVIGATION BAR (< lg)                   */}
      {/* =================================================================== */}
      <nav
        aria-label="Navigare mobilă"
        className="lg:hidden fixed bottom-0 left-0 right-0 z-40 bg-zinc-950/95 backdrop-blur border-t border-amber-500/40 grid grid-cols-5 gap-0.5 px-1 py-1"
      >
        <button
          type="button"
          onClick={() => setActiveTab('NATIVE_GRID')}
          className={`flex flex-col items-center justify-center min-h-[44px] rounded text-[10px] font-bold transition-colors ${
            activeTab === 'NATIVE_GRID'
              ? 'bg-cyan-400 text-black'
              : 'text-cyan-300 hover:bg-zinc-900'
          }`}
        >
          <Zap className="w-4 h-4 mb-0.5" />
          <span>Grid OKX ({runningNativeBotsCount})</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('SCANNER')}
          className={`flex flex-col items-center justify-center min-h-[44px] rounded text-[10px] font-bold transition-colors ${
            activeTab === 'SCANNER'
              ? 'bg-amber-500 text-black'
              : 'text-amber-300 hover:bg-zinc-900'
          }`}
        >
          <Search className="w-4 h-4 mb-0.5" />
          <span>Scan ({gridCandidates.length})</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('LADDER')}
          className={`flex flex-col items-center justify-center min-h-[44px] rounded text-[10px] font-bold transition-colors ${
            activeTab === 'LADDER'
              ? 'bg-amber-500 text-black'
              : 'text-amber-300 hover:bg-zinc-900'
          }`}
        >
          <ArrowUpDown className="w-4 h-4 mb-0.5" />
          <span>Trepte</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('JOURNAL')}
          className={`flex flex-col items-center justify-center min-h-[44px] rounded text-[10px] font-bold transition-colors ${
            activeTab === 'JOURNAL'
              ? 'bg-amber-500 text-black'
              : 'text-amber-300 hover:bg-zinc-900'
          }`}
        >
          <List className="w-4 h-4 mb-0.5" />
          <span>Loguri</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab('API')}
          className={`flex flex-col items-center justify-center min-h-[44px] rounded text-[10px] font-bold transition-colors ${
            activeTab === 'API'
              ? 'bg-amber-500 text-black'
              : 'text-amber-300 hover:bg-zinc-900'
          }`}
        >
          <Key className="w-4 h-4 mb-0.5" />
          <span>OKX</span>
        </button>
      </nav>
    </div>
  );
};
