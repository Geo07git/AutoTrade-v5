import React, { useState, useEffect, useRef } from 'react';
import {
  GridAnalyzerStatusSummary,
  GridAnalyzerThresholds,
  NativeGridAutopilotConfig,
  NativeGridOpportunity,
  OKXFeeTierInfo,
  OKXNativeGridBot,
} from '../shared/types';
import { formatPrice } from '../shared/formatters';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Layers,
  Play,
  RefreshCw,
  Search,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Sliders,
  Square,
  Zap,
} from 'lucide-react';

interface OKXNativeGridPanelProps {
  opportunities: NativeGridOpportunity[];
  bots: OKXNativeGridBot[];
  autopilot?: NativeGridAutopilotConfig;
  gridAnalyzer?: GridAnalyzerStatusSummary;
  feeTierInfo?: OKXFeeTierInfo;
  freeBalanceUSDT: number;
  controlToken: string;
  onRefresh: () => void;
  onNotify: (banner: { type: 'success' | 'error' | 'info'; text: string }) => void;
}

export const OKXNativeGridPanel: React.FC<OKXNativeGridPanelProps> = ({
  opportunities,
  bots,
  autopilot,
  gridAnalyzer,
  feeTierInfo,
  freeBalanceUSDT,
  controlToken,
  onRefresh,
  onNotify,
}) => {
  // Autopilot & Governance state (Exclusively LIVE on OKX EEA)
  const [apEnabled, setApEnabled] = useState<boolean>(Boolean(autopilot?.enabled));
  const [maxBudgetPerBot, setMaxBudgetPerBot] = useState<number>(
    autopilot?.maxBudgetPerBotUSDT ?? 25
  );
  const [minReserve, setMinReserve] = useState<number>(autopilot?.minReserveUSDT ?? 5);
  const [maxConcurrentBots, setMaxConcurrentBots] = useState<number>(
    autopilot?.maxConcurrentNativeBots ?? 2
  );
  const [minScore, setMinScore] = useState<number>(autopilot?.minSuitabilityScore ?? 68);
  const [minNetProfitPct, setMinNetProfitPct] = useState<number>(
    autopilot?.minNetProfitPerGridPct ?? 0.12
  );
  const [maxLeverage, setMaxLeverage] = useState<number>(autopilot?.maxLeverage ?? 5);
  const [defaultRunType, setDefaultRunType] = useState<'1' | '2'>(
    autopilot?.defaultRunType || '1'
  );
  const [defaultStopType, setDefaultStopType] = useState<'1' | '2'>(
    autopilot?.defaultStopType || '1'
  );
  const [stopLossPct, setStopLossPct] = useState<number>(autopilot?.stopLossPct ?? 8.0);
  const [takeProfitPct, setTakeProfitPct] = useState<number>(autopilot?.takeProfitPct ?? 15.0);
  const [stopOnBreakout, setStopOnBreakout] = useState<boolean>(
    autopilot?.stopOnRangeBreakout ?? true
  );
  const [stopOnTrendInvalidation, setStopOnTrendInvalidation] = useState<boolean>(
    autopilot?.stopOnTrendInvalidation ?? true
  );

  // Manual / Custom Native Bot Builder state
  const [instId, setInstId] = useState<string>(
    opportunities[0]?.instId || 'LINK-USD_UM_XPERP-310523'
  );
  const [minPx, setMinPx] = useState<number>(opportunities[0]?.minPx || 0);
  const [maxPx, setMaxPx] = useState<number>(opportunities[0]?.maxPx || 0);
  const [gridNum, setGridNum] = useState<number>(opportunities[0]?.gridNum || 10);
  const [runType, setRunType] = useState<'1' | '2'>(opportunities[0]?.runType || '1');
  const [lever, setLever] = useState<number>(opportunities[0]?.lever || 3);
  const [sz, setSz] = useState<number>(
    opportunities[0]?.recommendedInvestmentUSDT || maxBudgetPerBot
  );
  const [customStopType, setCustomStopType] = useState<'1' | '2'>('1');
  const [minInvCheck, setMinInvCheck] = useState<{
    minInvestmentUSDT: number;
    ccy: string;
    singleAmt: number;
    error?: string;
  } | null>(null);

  const [isScanning, setIsScanning] = useState(false);
  const [isCheckingMinInv, setIsCheckingMinInv] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [isSavingAp, setIsSavingAp] = useState(false);
  const [isSyncingBots, setIsSyncingBots] = useState(false);
  const [executionVariant, setExecutionVariant] = useState<'AUTO_LIMIT' | 'NATIVE_ASSISTANT'>(
    'AUTO_LIMIT'
  );
  const [showInstructions, setShowInstructions] = useState<boolean>(true);
  const [copiedField, setCopiedField] = useState<string>('');
  const [editingBot, setEditingBot] = useState<OKXNativeGridBot | null>(null);
  const [editTpPx, setEditTpPx] = useState<number>(0);
  const [editSlPx, setEditSlPx] = useState<number>(0);
  const [editStopType, setEditStopType] = useState<'1' | '2'>('1');

  // TB5 GridBotAnalyzer & Autonomous Supervisor state
  const [showAnalyzerThresholds, setShowAnalyzerThresholds] = useState<boolean>(false);
  const [showAnalyzerStopLog, setShowAnalyzerStopLog] = useState<boolean>(false);
  const [isEvaluatingAnalyzer, setIsEvaluatingAnalyzer] = useState<boolean>(false);
  const [isSavingThresholds, setIsSavingThresholds] = useState<boolean>(false);
  const [analyzerThresholds, setAnalyzerThresholds] = useState<GridAnalyzerThresholds>({
    adxMonitorThreshold: gridAnalyzer?.thresholds?.adxMonitorThreshold ?? 25,
    adxMonitorConsecutiveCount: gridAnalyzer?.thresholds?.adxMonitorConsecutiveCount ?? 2,
    adxStopThreshold: gridAnalyzer?.thresholds?.adxStopThreshold ?? 30,
    adxStopConsecutiveCount: gridAnalyzer?.thresholds?.adxStopConsecutiveCount ?? 2,
    chopStopThreshold: gridAnalyzer?.thresholds?.chopStopThreshold ?? 38,
    chopStopConsecutiveCount: gridAnalyzer?.thresholds?.chopStopConsecutiveCount ?? 2,
    atrSpikeMonitorPct: gridAnalyzer?.thresholds?.atrSpikeMonitorPct ?? 50,
    rangeEdgeWarningPct: gridAnalyzer?.thresholds?.rangeEdgeWarningPct ?? 10,
    warningDrawdownPct: gridAnalyzer?.thresholds?.warningDrawdownPct ?? 5,
    stopDrawdownPct: gridAnalyzer?.thresholds?.stopDrawdownPct ?? 8,
    minLiqSafetyPct: gridAnalyzer?.thresholds?.minLiqSafetyPct ?? 4.0,
    requireMultiIndicatorForTrendStop:
      gridAnalyzer?.thresholds?.requireMultiIndicatorForTrendStop ?? true,
    emergencyClosePosition: gridAnalyzer?.thresholds?.emergencyClosePosition ?? true,
  });

  const hasHydratedAutopilot = useRef<boolean>(false);
  const hasHydratedBuilder = useRef<boolean>(false);
  const hasHydratedAnalyzerThresholds = useRef<boolean>(false);

  useEffect(() => {
    if (gridAnalyzer?.thresholds && !hasHydratedAnalyzerThresholds.current) {
      hasHydratedAnalyzerThresholds.current = true;
      setAnalyzerThresholds(gridAnalyzer.thresholds);
    }
  }, [gridAnalyzer?.thresholds]);

  // Hydrate Autopilot settings ONLY ONCE on initial load so 3-second polling never overwrites user edits
  useEffect(() => {
    if (!autopilot) return;
    if (!hasHydratedAutopilot.current) {
      hasHydratedAutopilot.current = true;
      setApEnabled(Boolean(autopilot.enabled));
      setMaxBudgetPerBot(autopilot.maxBudgetPerBotUSDT);
      setMinReserve(autopilot.minReserveUSDT);
      setMaxConcurrentBots(autopilot.maxConcurrentNativeBots);
      setMinScore(autopilot.minSuitabilityScore);
      setMinNetProfitPct(autopilot.minNetProfitPerGridPct);
      setMaxLeverage(autopilot.maxLeverage);
      setDefaultRunType(autopilot.defaultRunType);
      setDefaultStopType(autopilot.defaultStopType);
      setStopLossPct(autopilot.stopLossPct);
      setTakeProfitPct(autopilot.takeProfitPct);
      setStopOnBreakout(Boolean(autopilot.stopOnRangeBreakout));
      setStopOnTrendInvalidation(Boolean(autopilot.stopOnTrendInvalidation));
    }
  }, [autopilot]);

  // Hydrate Manual Builder ONLY ONCE on initial load when opportunities first arrive
  useEffect(() => {
    if (!hasHydratedBuilder.current && opportunities.length > 0) {
      hasHydratedBuilder.current = true;
      const top = opportunities[0];
      setInstId(top.instId);
      setMinPx(top.minPx);
      setMaxPx(top.maxPx);
      setGridNum(top.gridNum);
      setRunType(top.runType);
      setLever(top.lever);
      setSz(top.recommendedInvestmentUSDT);
    }
  }, [opportunities]);

  const authHeaders = () => ({
    'Content-Type': 'application/json',
    'x-bot-token': controlToken || 'tradebot5_admin_token',
  });

  const handleSaveAutopilot = async (overrideEnabled?: boolean) => {
    setIsSavingAp(true);
    const nextEnabled = typeof overrideEnabled === 'boolean' ? overrideEnabled : apEnabled;
    if (typeof overrideEnabled === 'boolean') {
      setApEnabled(overrideEnabled);
    }
    try {
      const res = await fetch('/api/bot/native-grid/autopilot', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          enabled: nextEnabled,
          environment: 'LIVE',
          liveExecutionConfirmed: true,
          maxBudgetPerBotUSDT: Number(maxBudgetPerBot) || 10,
          minReserveUSDT: Number(minReserve) >= 0 ? Number(minReserve) : 0,
          maxConcurrentNativeBots: Number(maxConcurrentBots) || 1,
          minSuitabilityScore: Number(minScore) || 65,
          minNetProfitPerGridPct: Number(minNetProfitPct) || 0.1,
          maxLeverage: Number(maxLeverage) || 3,
          defaultRunType,
          defaultStopType,
          stopLossPct: Number(stopLossPct) || 8,
          takeProfitPct: Number(takeProfitPct) || 15,
          stopOnRangeBreakout: stopOnBreakout,
          stopOnTrendInvalidation,
        }),
      });
      const data = await res.json();
      if (data.success) {
        if (data.autopilot) {
          setApEnabled(Boolean(data.autopilot.enabled));
        }
        onNotify({
          type: 'success',
          text: `Configurație OKX Native Grid LIVE salvată (Autopilot: ${
            data.autopilot?.enabled ? 'ON' : 'OFF'
          }). ${data.decision || ''}`,
        });
        onRefresh();
      } else {
        onNotify({ type: 'error', text: data.error || 'Eroare la salvarea configurației.' });
      }
    } catch (err: any) {
      onNotify({ type: 'error', text: err.message });
    } finally {
      setIsSavingAp(false);
    }
  };

  const handleScanNow = async () => {
    setIsScanning(true);
    try {
      const res = await fetch('/api/bot/native-grid/scan', {
        method: 'POST',
        headers: authHeaders(),
      });
      const data = await res.json();
      if (data.success) {
        const count = data.opportunities?.length || 0;
        const elig = (data.opportunities || []).filter((o: any) => o.isEligible).length;
        onNotify({
          type: 'success',
          text: `Scanare Market Intelligence & OKX Min-Investment finalizată: ${count} contracte _UM_XPERP analizate (${elig} eligibile în bugetul ≤$${maxBudgetPerBot}).`,
        });
        onRefresh();
      } else {
        onNotify({ type: 'error', text: data.error || 'Eroare la scanarea OKX Native Grid.' });
      }
    } catch (err: any) {
      onNotify({ type: 'error', text: err.message });
    } finally {
      setIsScanning(false);
    }
  };

  const handleCheckMinInvestment = async () => {
    if (!instId || minPx <= 0 || maxPx <= minPx) {
      onNotify({
        type: 'error',
        text: 'Selectează un instrument _UM_XPERP și introdu limitele minPx < maxPx.',
      });
      return;
    }
    setIsCheckingMinInv(true);
    try {
      const res = await fetch('/api/bot/native-grid/min-investment', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          instId,
          minPx: Number(minPx),
          maxPx: Number(maxPx),
          gridNum: Number(gridNum),
          runType,
          lever: Number(lever),
        }),
      });
      const data = await res.json();
      setMinInvCheck(data);
      if (data.minInvestmentUSDT > 0) {
        onNotify({
          type: 'info',
          text: `OKX API Min-Investment (${instId}): $${data.minInvestmentUSDT.toFixed(2)} ${data.ccy} pentru ${gridNum} grile la ${lever}x.`,
        });
      }
    } catch (err: any) {
      onNotify({ type: 'error', text: err.message });
    } finally {
      setIsCheckingMinInv(false);
    }
  };

  const handleLoadOpportunity = (opp: NativeGridOpportunity) => {
    setInstId(opp.instId);
    setMinPx(opp.minPx);
    setMaxPx(opp.maxPx);
    setGridNum(opp.gridNum);
    setRunType(opp.runType);
    setLever(opp.lever);
    setSz(opp.recommendedInvestmentUSDT);
    setMinInvCheck({
      minInvestmentUSDT: opp.minInvestmentUSDT,
      ccy: opp.minInvestmentCcy,
      singleAmt: 0,
    });
    onNotify({
      type: 'info',
      text: `Parametrii optimizați pentru ${opp.instId} (Min-Inv OKX: $${opp.minInvestmentUSDT.toFixed(2)}) au fost încărcați în Builder.`,
    });
  };

  const handleCreateNativeBot = async (overrideParams?: Partial<NativeGridOpportunity>) => {
    const targetInstId = overrideParams?.instId || instId;
    const targetMinPx = Number(overrideParams?.minPx ?? minPx) || 0;
    const targetMaxPx = Number(overrideParams?.maxPx ?? maxPx) || 0;
    const targetGridNum = Number(overrideParams?.gridNum ?? gridNum) || 10;
    const targetRunType = overrideParams?.runType || runType;
    const targetLever = Number(overrideParams?.lever ?? lever) || 3;
    const targetSz = Number(overrideParams?.recommendedInvestmentUSDT ?? sz) || 5;
    const slPctVal = Number(stopLossPct) || 8;
    const tpPctVal = Number(takeProfitPct) || 15;
    const targetSlPx =
      targetMinPx > 0
        ? parseFloat((targetMinPx * (1 - slPctVal / 100 / Math.max(1, targetLever))).toFixed(6))
        : undefined;
    const targetTpPx =
      targetMaxPx > 0
        ? parseFloat((targetMaxPx * (1 + tpPctVal / 100 / Math.max(1, targetLever))).toFixed(6))
        : undefined;

    setIsCreating(true);
    try {
      const res = await fetch('/api/bot/native-grid/create', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          instId: targetInstId,
          minPx: targetMinPx,
          maxPx: targetMaxPx,
          gridNum: targetGridNum,
          runType: targetRunType,
          lever: targetLever,
          sz: targetSz,
          stopLossPct: slPctVal,
          takeProfitPct: tpPctVal,
          slTriggerPx: targetSlPx,
          tpTriggerPx: targetTpPx,
          stopTypeOnRisk: customStopType || defaultStopType,
          stopOnRangeBreakout: stopOnBreakout,
          stopOnTrendInvalidation,
          environment: 'LIVE',
          explicitLiveConfirm: true,
        }),
      });
      const data = await res.json();
      if (data.success && data.bot) {
        onNotify({
          type: 'success',
          text: `BOT NATIV OKX CREAT CU SUCCES (LIVE): ${data.bot.instId} | algoId: ${data.bot.algoId} | Investiție: $${data.bot.sz} @ ${data.bot.lever}x!`,
        });
        onRefresh();
      } else {
        onNotify({
          type: 'error',
          text: data.error || 'Eroare la crearea botului nativ pe OKX.',
        });
      }
    } catch (err: any) {
      onNotify({ type: 'error', text: err.message });
    } finally {
      setIsCreating(false);
    }
  };

  const handleStopNativeBot = async (algoId: string, stopType: '1' | '2') => {
    try {
      const res = await fetch(`/api/bot/native-grid/${algoId}/stop`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          stopType,
          reason: `Oprit manual din Terminal TB5 (stopType ${stopType})`,
        }),
      });
      const data = await res.json();
      if (data.success) {
        onNotify({
          type: 'info',
          text: `Botul nativ OKX (algoId: ${algoId}) a fost oprit cu stopType ${stopType} (${
            stopType === '1' ? 'Poziție închisă la piață' : 'Poziție păstrată'
          }).`,
        });
        onRefresh();
      } else {
        onNotify({ type: 'error', text: data.error || 'Eroare la oprirea botului nativ.' });
      }
    } catch (err: any) {
      onNotify({ type: 'error', text: err.message });
    }
  };

  const handleClosePositionOnly = async (algoId: string) => {
    try {
      const res = await fetch(`/api/bot/native-grid/${algoId}/close-position`, {
        method: 'POST',
        headers: authHeaders(),
      });
      const data = await res.json();
      if (data.success) {
        onNotify({
          type: 'success',
          text: `Poziția botului nativ OKX (algoId: ${algoId}) a fost închisă la piață (/api/v5/tradingBot/grid/close-position).`,
        });
        onRefresh();
      } else {
        onNotify({ type: 'error', text: data.error || 'Eroare la închiderea poziției.' });
      }
    } catch (err: any) {
      onNotify({ type: 'error', text: err.message });
    }
  };

  const handleSaveAmend = async () => {
    if (!editingBot) return;
    try {
      const res = await fetch(`/api/bot/native-grid/${editingBot.algoId}/amend`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          tpTriggerPx: Number(editTpPx) || undefined,
          slTriggerPx: Number(editSlPx) || undefined,
          stopTypeOnRisk: editStopType,
        }),
      });
      const data = await res.json();
      if (data.success) {
        onNotify({
          type: 'success',
          text: `Parametrii SL/TP & StopType pentru ${editingBot.instId} (algoId: ${editingBot.algoId}) au fost actualizați pe OKX!`,
        });
        setEditingBot(null);
        onRefresh();
      } else {
        onNotify({ type: 'error', text: data.error || 'Eroare la modificarea botului nativ.' });
      }
    } catch (err: any) {
      onNotify({ type: 'error', text: err.message });
    }
  };

  const handleLoadStoppedBotToBuilder = (b: OKXNativeGridBot) => {
    setInstId(b.instId);
    setMinPx(b.minPx);
    setMaxPx(b.maxPx);
    setGridNum(b.gridNum);
    setRunType(b.runType);
    setLever(b.lever);
    setSz(b.sz);
    setCustomStopType(b.stopTypeOnRisk || '1');
    onNotify({
      type: 'info',
      text: `Parametrii botului ${b.instId} ($${b.minPx}–$${b.maxPx}, ${b.gridNum} grile, ${b.lever}x, $${b.sz}) au fost încărcați în Builderul din stânga. Poți modifica valorile sau apăsa "CREEAZĂ BOT NATIV PE OKX (LIVE)".`,
    });
  };

  const handleRestartStoppedBot = async (b: OKXNativeGridBot) => {
    if (executionVariant === 'NATIVE_ASSISTANT') {
      handleLoadStoppedBotToBuilder(b);
      onNotify({
        type: 'info',
        text: `VARIANTA 2 ACTIVĂ: Parametrii botului ${b.instId} au fost încărcați în Cartela Copy 1-Click din stânga. Copiază-i în OKX Trading Bots și apoi apasă "🔄 AM CREAT BOTUL ÎN OKX"!`,
      });
      return;
    }
    await handleCreateNativeBot({
      instId: b.instId,
      minPx: b.minPx,
      maxPx: b.maxPx,
      gridNum: b.gridNum,
      runType: b.runType,
      lever: b.lever,
      recommendedInvestmentUSDT: b.sz,
    });
  };

  const handleDeleteNativeBot = async (algoId: string, botInstId: string) => {
    try {
      const res = await fetch(`/api/bot/native-grid/${algoId}/delete`, {
        method: 'POST',
        headers: authHeaders(),
      });
      const data = await res.json();
      if (data.success) {
        onNotify({
          type: 'info',
          text: `Botul oprit ${botInstId} (algoId: ${algoId}) a fost șters din listă.`,
        });
        onRefresh();
      } else {
        onNotify({ type: 'error', text: data.error || 'Eroare la ștergerea botului.' });
      }
    } catch (err: any) {
      onNotify({ type: 'error', text: err.message });
    }
  };

  const handleClearStoppedBots = async () => {
    try {
      const res = await fetch('/api/bot/native-grid/clear-stopped', {
        method: 'POST',
        headers: authHeaders(),
      });
      const data = await res.json();
      if (data.success) {
        onNotify({
          type: 'info',
          text: `${data.removedCount || 0} boți opriți au fost șterși din listă.`,
        });
        onRefresh();
      } else {
        onNotify({ type: 'error', text: data.error || 'Eroare la curățarea boților opriți.' });
      }
    } catch (err: any) {
      onNotify({ type: 'error', text: err.message });
    }
  };

  const handleCopyField = (label: string, val: string | number) => {
    try {
      navigator.clipboard.writeText(String(val));
      setCopiedField(label);
      setTimeout(() => setCopiedField(''), 1800);
    } catch {}
  };

  const handleSyncNativeBotsNow = async () => {
    setIsSyncingBots(true);
    try {
      const res = await fetch('/api/bot/native-grid/sync', {
        method: 'POST',
        headers: authHeaders(),
      });
      const data = await res.json();
      if (data.success) {
        const activeCount = (data.bots || []).filter((b: any) => b.state === 'running').length;
        onNotify({
          type: 'success',
          text: `Sincronizare OKX EEA finalizată: ${activeCount} boți activi preluați sub supravegherea autonomă TB5!`,
        });
        onRefresh();
      } else {
        onNotify({ type: 'error', text: data.error || 'Eroare la sincronizarea boților OKX.' });
      }
    } catch (err: any) {
      onNotify({ type: 'error', text: err.message });
    } finally {
      setIsSyncingBots(false);
    }
  };

  const [botFilter, setBotFilter] = useState<'ALL' | 'RUNNING' | 'STOPPED'>('ALL');
  const runningNativeBots = bots.filter((b) => b.state === 'running');
  const stoppedNativeBots = bots.filter((b) => b.state !== 'running');
  const displayedBots =
    botFilter === 'RUNNING'
      ? runningNativeBots
      : botFilter === 'STOPPED'
        ? stoppedNativeBots
        : bots;
  const eligibleOpportunities = opportunities.filter((o) => o.isEligible);

  const calcSlTriggerPx =
    minPx > 0 ? parseFloat((minPx * (1 - (stopLossPct || 8) / 100 / Math.max(1, lever))).toFixed(6)) : 0;
  const calcTpTriggerPx =
    maxPx > 0 ? parseFloat((maxPx * (1 + (takeProfitPct || 15) / 100 / Math.max(1, lever))).toFixed(6)) : 0;

  return (
    <div className="space-y-3 text-xs">
      {/* ================================================================= */}
      {/* 0. COMUTATOR MOD DE OPERARE (VARIANTA 1 vs VARIANTA 2) & GHID      */}
      {/* ================================================================= */}
      <div className="bg-zinc-950 border border-amber-500/50 rounded p-3 space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-black text-amber-300 uppercase tracking-wide">
              ALEGE MODUL DE LANSARE (_UM_XPERP):
            </span>
            <div className="flex flex-wrap items-center bg-black border border-zinc-700 rounded p-1 gap-1">
              <button
                type="button"
                onClick={() => setExecutionVariant('AUTO_LIMIT')}
                className={`px-3 py-1.5 rounded font-black text-[11px] cursor-pointer transition-all ${
                  executionVariant === 'AUTO_LIMIT'
                    ? 'bg-emerald-500 text-black shadow-[0_0_10px_rgba(16,185,129,0.4)]'
                    : 'bg-zinc-900 text-zinc-400 hover:text-white'
                }`}
              >
                ⚡ VARIANTA 1: EXECUȚIE 100% AUTOMATĂ (ORDINE LIMIT OKX)
              </button>
              <button
                type="button"
                onClick={() => setExecutionVariant('NATIVE_ASSISTANT')}
                className={`px-3 py-1.5 rounded font-black text-[11px] cursor-pointer transition-all ${
                  executionVariant === 'NATIVE_ASSISTANT'
                    ? 'bg-cyan-400 text-black shadow-[0_0_10px_rgba(34,211,238,0.4)]'
                    : 'bg-zinc-900 text-zinc-400 hover:text-white'
                }`}
              >
                🤖 VARIANTA 2: BOT NATIV ÎN TABUL &quot;TRADING BOTS&quot; OKX (COPY + SUPRAVEGHERE API)
              </button>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setShowInstructions(!showInstructions)}
            className="px-3 py-1.5 rounded bg-zinc-900 hover:bg-zinc-800 border border-amber-500/50 text-amber-300 font-black text-[11px] cursor-pointer"
          >
            {showInstructions
              ? '▲ Ascunde Instrucțiunile de Folosire'
              : '📖 Instrucțiuni de Folosire (Varianta 1 & Varianta 2)'}
          </button>
        </div>

        {showInstructions && (
          <div className="bg-black border border-zinc-800 rounded p-3 grid grid-cols-1 lg:grid-cols-2 gap-3 text-[11px] leading-relaxed">
            <div
              className={`p-2.5 rounded border ${
                executionVariant === 'AUTO_LIMIT'
                  ? 'border-emerald-500/60 bg-emerald-950/15'
                  : 'border-zinc-800 bg-zinc-950'
              }`}
            >
              <div className="font-black text-emerald-400 text-xs mb-1">
                ⚡ CUM FUNCȚIONEAZĂ VARIANTA 1 — EXECUȚIE 100% AUTOMATĂ (ORDINE LIMIT OKX)
              </div>
              <ul className="list-disc list-inside text-zinc-300 space-y-1">
                <li>
                  <strong>Pentru cine este:</strong> Când vrei ca TB5 (sau Autopilotul) să deschidă, să întrețină și să închidă grila <strong>100% singur din aplicație</strong>, fără să intri în OKX să creezi manual botul.
                </li>
                <li>
                  <strong>Pași de folosire:</strong>
                  <ol className="list-decimal list-inside ml-3 text-zinc-400 space-y-0.5 mt-0.5">
                    <li>Selectează o monedă din tabelul de jos (sau activează <strong>AUTOPILOT NATIV: ON</strong>).</li>
                    <li>Apasă <strong>&quot;CREEAZĂ GRILĂ AUTO-LIMIT PE OKX (LIVE)&quot;</strong> (sau <strong>&quot;▶ Repornește&quot;</strong> pe un bot oprit).</li>
                    <li>TB5 verifică investiția minimă prin API-ul OKX și plasează direct ordinele Limit ale grilei pe OKX EEA.</li>
                  </ol>
                </li>
                <li>
                  <strong>Unde îl vezi în platforma OKX:</strong> În taburile <strong>Positions + Open Orders (cele 8 ordine Limit)</strong>. În tabelul din dreapta are eticheta verde <code className="text-emerald-300">AUTO-LIMIT OKX</code>.
                </li>
              </ul>
            </div>

            <div
              className={`p-2.5 rounded border ${
                executionVariant === 'NATIVE_ASSISTANT'
                  ? 'border-cyan-400/60 bg-cyan-950/15'
                  : 'border-zinc-800 bg-zinc-950'
              }`}
            >
              <div className="font-black text-cyan-300 text-xs mb-1">
                🤖 CUM FUNCȚIONEAZĂ VARIANTA 2 — BOT NATIV ÎN TABUL &quot;TRADING BOTS&quot; OKX
              </div>
              <ul className="list-disc list-inside text-zinc-300 space-y-1">
                <li>
                  <strong>De ce există:</strong> Pe OKX Europa (EEA), contractele cu levier <code className="text-amber-300">_UM_XPERP</code> pot fi create ca „Bot Nativ” în tabul <em>Trading Bots</em> doar din interfața OKX (Web/Telefon), dar <strong>pot fi citite, modificate (SL/TP) și oprite automat prin API de către TB5</strong>!
                </li>
                <li>
                  <strong>Pași de folosire (10 secunde):</strong>
                  <ol className="list-decimal list-inside ml-3 text-zinc-400 space-y-0.5 mt-0.5">
                    <li>Apasă <strong>&quot;În Builder&quot;</strong> pe o oportunitate eligibilă din tabelul de jos.</li>
                    <li>În panoul din stânga îți apar valorile gata calculate cu butoane <strong>[Copiază]</strong>: deschide în OKX → <em>Trading Bots → Futures Grid → Neutral → Manual</em> și lipește <code className="text-white">Lower Price</code>, <code className="text-white">Upper Price</code>, <code className="text-white">Grids</code>, <code className="text-white">Leverage</code> și <code className="text-white">Margin</code>.</li>
                    <li>Apasă butonul albastru <strong>&quot;🔄 AM CREAT BOTUL ÎN OKX — PREIA &amp; SUPRAVEGHEAZĂ ACUM&quot;</strong>. TB5 îl importă imediat în tabelul din dreapta (eticheta <code className="text-cyan-300">BOT NATIV OKX</code>) și îi supraveghează autonom PnL-ul, lichidarea, ieșirea din range și oprirea la risc!</li>
                  </ol>
                </li>
              </ul>
            </div>
          </div>
        )}
      </div>

      {/* ================================================================= */}
      {/* 1. GOVERNANCE, DEMO/LIVE SAFETY GUARD & AUTOPILOT BAR              */}
      {/* ================================================================= */}
      <div className="bg-zinc-950 border border-cyan-500/40 rounded p-3 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-cyan-500/30 pb-2">
          <div className="flex items-center space-x-2">
            <Layers className="w-4 h-4 text-cyan-400" />
            <div>
              <h2 className="font-black text-sm text-cyan-300 tracking-wide">
                MODUL AUTONOM OKX EEA NATIVE FUTURES GRID (contract_grid — direction: neutral)
              </h2>
              <p className="text-[11px] text-zinc-400">
                Execuție nativă direct pe infrastructura OKX (<code className="text-amber-300">https://eea.okx.com</code>) • Exclusiv contracte <code className="text-emerald-300">_UM_XPERP</code> • Fără Martingale extern
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="px-2.5 py-1 rounded bg-rose-600 text-white font-black text-[11px] tracking-wide">
              MOD LIVE OKX EEA (CONT REAL)
            </span>

            {/* Autopilot Toggle */}
            <button
              type="button"
              disabled={isSavingAp}
              onClick={() => handleSaveAutopilot(!apEnabled)}
              className={`px-3 py-1 rounded font-black text-xs flex items-center space-x-1.5 cursor-pointer border transition-all ${
                apEnabled
                  ? 'bg-cyan-400 text-black border-cyan-200 shadow-[0_0_12px_rgba(34,211,238,0.45)]'
                  : 'bg-zinc-900 text-zinc-300 border-zinc-700 hover:border-cyan-500/50'
              }`}
            >
              <Zap className="w-3.5 h-3.5" />
              <span>{apEnabled ? 'AUTOPILOT NATIV: ON' : 'AUTOPILOT NATIV: OFF'}</span>
            </button>
          </div>
        </div>

        {/* ================================================================= */}
        {/* TB5 – GRID BOT ANALYZER & AUTONOMOUS SUPERVISOR (SECȚIUNEA 9)      */}
        {/* ================================================================= */}
        <div className="bg-black/90 border border-cyan-500/40 rounded p-3 space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 pb-2">
            <div className="flex items-center space-x-2">
              <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-black text-xs text-white tracking-wide">
                    TB5 – GRID BOT ANALYZER &amp; AUTONOMOUS SUPERVISOR
                  </span>
                  <span
                    className={`px-2 py-0.5 rounded text-[10px] font-black border ${
                      gridAnalyzer?.reconciliationStatus === 'SYNCED'
                        ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40'
                        : gridAnalyzer?.reconciliationStatus === 'RECONCILING'
                        ? 'bg-cyan-500/15 text-cyan-300 border-cyan-500/40'
                        : 'bg-rose-500/20 text-rose-300 border-rose-500/50 animate-pulse'
                    }`}
                  >
                    RECONCILIERE OKX: {gridAnalyzer?.reconciliationStatus || 'SYNCED'}
                  </span>
                  <span
                    className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                      gridAnalyzer?.okxConnectionOk !== false
                        ? 'bg-zinc-900 text-emerald-400 border border-emerald-500/30'
                        : 'bg-rose-950 text-rose-300 border border-rose-500/40'
                    }`}
                  >
                    {gridAnalyzer?.okxConnectionOk !== false
                      ? '● API OKX ONLINE'
                      : '○ API OKX DEGRADAT'}
                  </span>
                </div>
                <p className="text-[10px] text-zinc-400 mt-0.5">
                  Cadență autonomă: <strong className="text-zinc-200">30s</strong> status/reconciliere •{' '}
                  <strong className="text-zinc-200">1m</strong> preț/LiqPx/range •{' '}
                  <strong className="text-zinc-200">5m</strong> ADX/Chop/ATR/OrderBook/Funding •{' '}
                  <strong className="text-zinc-200">15m</strong> decizie completă (risc critic evaluat imediat) •{' '}
                  <span className="text-cyan-300">Zero log spam la verificări normale</span>
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                disabled={isEvaluatingAnalyzer}
                onClick={async () => {
                  setIsEvaluatingAnalyzer(true);
                  try {
                    const res = await fetch('/api/bot/native-grid/analyzer/evaluate', {
                      method: 'POST',
                      headers: {
                        'Content-Type': 'application/json',
                        ...(controlToken ? { 'x-Persist-Token': controlToken } : {}),
                      },
                    });
                    const data = await res.json();
                    if (data.success) {
                      onRefresh();
                      onNotify({
                        type: 'success',
                        text: 'Reevaluare completă GridBotAnalyzer executată și reconciliată cu OKX EEA.',
                      });
                    }
                  } catch (e: any) {
                    onNotify({ type: 'error', text: e.message || 'Eroare la reevaluarea Analyzer-ului' });
                  } finally {
                    setIsEvaluatingAnalyzer(false);
                  }
                }}
                className="px-2.5 py-1 rounded bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-300 border border-cyan-500/40 text-[10px] font-black cursor-pointer flex items-center space-x-1"
              >
                <RefreshCw className={`w-3 h-3 ${isEvaluatingAnalyzer ? 'animate-spin' : ''}`} />
                <span>{isEvaluatingAnalyzer ? 'Evaluează...' : 'Reevaluează Acum'}</span>
              </button>

              <button
                type="button"
                onClick={() => setShowAnalyzerThresholds(!showAnalyzerThresholds)}
                className={`px-2.5 py-1 rounded text-[10px] font-bold cursor-pointer border flex items-center space-x-1 ${
                  showAnalyzerThresholds
                    ? 'bg-amber-500 text-black border-amber-300'
                    : 'bg-zinc-900 text-amber-300 border-amber-500/40 hover:bg-zinc-800'
                }`}
              >
                <Sliders className="w-3 h-3" />
                <span>Praguri Decizie</span>
              </button>

              <button
                type="button"
                onClick={() => setShowAnalyzerStopLog(!showAnalyzerStopLog)}
                className={`px-2.5 py-1 rounded text-[10px] font-bold cursor-pointer border flex items-center space-x-1 ${
                  showAnalyzerStopLog
                    ? 'bg-rose-500 text-white border-rose-300'
                    : 'bg-zinc-900 text-rose-300 border-rose-500/40 hover:bg-zinc-800'
                }`}
              >
                <ShieldAlert className="w-3 h-3" />
                <span>Jurnal Opriri ({gridAnalyzer?.stopEvents?.length || 0})</span>
              </button>
            </div>
          </div>

          {/* 5 KPI Cards mandated by Section 9 */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
            <div className="bg-zinc-950 border border-zinc-800 rounded p-2">
              <span className="text-[10px] text-zinc-500 block">1. BOȚI MONITORIZAȚI</span>
              <div className="flex items-baseline justify-between mt-0.5">
                <span className="text-white font-black text-sm tabular-nums">
                  {gridAnalyzer?.monitoredBotsCount ?? bots.length} total
                </span>
                <span className="text-[10px] text-emerald-400 font-bold tabular-nums">
                  {gridAnalyzer?.activeNativeBotsCount ??
                    bots.filter((b) => b.state === 'running').length}{' '}
                  activi /{' '}
                  <span className="text-zinc-400">
                    {gridAnalyzer?.stoppedNativeBotsCount ??
                      bots.filter((b) => b.state !== 'running').length}{' '}
                    opriți
                  </span>
                </span>
              </div>
            </div>

            <div className="bg-zinc-950 border border-zinc-800 rounded p-2">
              <span className="text-[10px] text-zinc-500 block">2. DECIZII CURENTE BOȚI ACTIVI</span>
              <div className="flex flex-wrap items-center gap-1 mt-1">
                {(() => {
                  const snaps = (gridAnalyzer?.botSnapshots || []).filter((s) => s.state === 'running');
                  if (snaps.length === 0) {
                    return <span className="text-[11px] text-zinc-400 font-bold">Niciun bot activ</span>;
                  }
                  return snaps.map((s) => (
                    <span
                      key={s.algoId}
                      title={`${s.instId} (${s.algoId}): ${s.decisionReason}`}
                      className={`px-1.5 py-0.5 rounded text-[9px] font-black ${
                        s.decision === 'CONTINUE'
                          ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                          : s.decision === 'MONITOR'
                          ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                          : s.decision === 'WARNING'
                          ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                          : 'bg-rose-600 text-white'
                      }`}
                    >
                      {(s.instId || '').split('-')[0]}: {s.decision}
                    </span>
                  ));
                })()}
              </div>
            </div>

            <div className="bg-zinc-950 border border-zinc-800 rounded p-2">
              <span className="text-[10px] text-zinc-500 block">3. PNL TOTAL &amp; NIVEL RISC</span>
              <div className="flex items-baseline justify-between mt-0.5">
                <span
                  className={`font-black text-sm tabular-nums ${
                    Number(
                      gridAnalyzer?.totalPnlUSDT ??
                        bots.reduce((s, b) => s + Number(b.totalPnl || 0), 0)
                    ) >= 0
                      ? 'text-emerald-400'
                      : 'text-rose-400'
                  }`}
                >
                  {Number(
                    gridAnalyzer?.totalPnlUSDT ??
                      bots.reduce((s, b) => s + Number(b.totalPnl || 0), 0)
                  ) >= 0
                    ? '+'
                    : ''}
                  $
                  {Number(
                    gridAnalyzer?.totalPnlUSDT ??
                      bots.reduce((s, b) => s + Number(b.totalPnl || 0), 0)
                  ).toFixed(2)}
                </span>
                <span
                  className={`px-1.5 py-0.5 rounded text-[10px] font-black ${
                    gridAnalyzer?.overallRiskLevel === 'CRITICAL'
                      ? 'bg-rose-600 text-white'
                      : gridAnalyzer?.overallRiskLevel === 'WARNING'
                      ? 'bg-amber-500/20 text-amber-300'
                      : gridAnalyzer?.overallRiskLevel === 'ELEVATED'
                      ? 'bg-cyan-500/20 text-cyan-300'
                      : 'bg-emerald-500/20 text-emerald-300'
                  }`}
                >
                  RISC: {gridAnalyzer?.overallRiskLevel || 'LOW'}
                </span>
              </div>
            </div>

            <div className="bg-zinc-950 border border-zinc-800 rounded p-2">
              <span className="text-[10px] text-zinc-500 block">4. MOTIVUL ULTIMEI OPRIRI</span>
              <div
                className="text-[10px] font-bold text-amber-300 truncate mt-0.5"
                title={
                  gridAnalyzer?.stopEvents?.[0]?.exactStopReason ||
                  'Nicio oprire autonomă declanșată'
                }
              >
                {gridAnalyzer?.stopEvents?.[0]?.exactStopReason ||
                  'Nicio oprire autonomă declanșată'}
              </div>
              {gridAnalyzer?.stopEvents?.[0]?.timestamp && (
                <span className="text-[9px] text-zinc-500 block">
                  {new Date(gridAnalyzer.stopEvents[0].timestamp).toLocaleTimeString()}
                </span>
              )}
            </div>

            <div className="bg-zinc-950 border border-zinc-800 rounded p-2">
              <span className="text-[10px] text-zinc-500 block">5. SINCRONIZARE &amp; VERIFICARE</span>
              <div className="text-[11px] font-bold text-cyan-300 mt-0.5">
                {gridAnalyzer?.reconciliationStatus === 'SYNCED'
                  ? '✓ Reconciliat cu OKX EEA'
                  : `⚠ Stare: ${gridAnalyzer?.reconciliationStatus || 'SYNCED'}`}
              </div>
              <span className="text-[9px] text-zinc-500 block">
                Ultima reconciliere:{' '}
                {gridAnalyzer?.lastReconcileAt
                  ? new Date(gridAnalyzer.lastReconcileAt).toLocaleTimeString()
                  : 'În curs...'}
              </span>
            </div>
          </div>

          {/* Collapsible Configurable Decision Thresholds Editor (Section 4) */}
          {showAnalyzerThresholds && (
            <div className="bg-zinc-950 border border-amber-500/40 rounded p-3 space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-500/30 pb-1.5">
                <div>
                  <h4 className="font-black text-xs text-amber-300">
                    PRAGURI DECIZIONALE CONFIGURABILE (SECȚIUNEA 4 — FĂRĂ VALORI HARDCODATE)
                  </h4>
                  <p className="text-[10px] text-zinc-400">
                    Nu oprește un bot exclusiv pe baza unui singur indicator de trend, cu excepția condițiilor critice de risc (Drawdown, LiqPx, Range Breakout).
                  </p>
                </div>
                <button
                  type="button"
                  disabled={isSavingThresholds}
                  onClick={async () => {
                    setIsSavingThresholds(true);
                    try {
                      const res = await fetch('/api/bot/native-grid/analyzer/thresholds', {
                        method: 'POST',
                        headers: {
                          'Content-Type': 'application/json',
                          ...(controlToken ? { 'x-Persist-Token': controlToken } : {}),
                        },
                        body: JSON.stringify(analyzerThresholds),
                      });
                      const data = await res.json();
                      if (data.success) {
                        onRefresh();
                        onNotify({
                          type: 'success',
                          text: 'Pragurile GridBotAnalyzer au fost salvate și aplicate în timp real.',
                        });
                      }
                    } catch (e: any) {
                      onNotify({ type: 'error', text: e.message || 'Eroare la salvarea pragurilor' });
                    } finally {
                      setIsSavingThresholds(false);
                    }
                  }}
                  className="px-3 py-1 rounded bg-amber-500 hover:bg-amber-400 text-black font-black text-xs cursor-pointer"
                >
                  {isSavingThresholds ? 'Se salvează...' : 'Salvează Pragurile'}
                </button>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2 text-xs">
                <div className="bg-black border border-zinc-800 rounded p-2">
                  <span className="text-[10px] text-zinc-400 block">ADX MONITOR (&gt;)</span>
                  <input
                    type="number"
                    step="1"
                    value={analyzerThresholds.adxMonitorThreshold}
                    onChange={(e) =>
                      setAnalyzerThresholds({
                        ...analyzerThresholds,
                        adxMonitorThreshold: parseFloat(e.target.value) || 25,
                      })
                    }
                    className="w-full bg-zinc-900 border border-cyan-500/40 rounded px-2 py-1 text-cyan-300 font-bold mt-0.5"
                  />
                </div>
                <div className="bg-black border border-zinc-800 rounded p-2">
                  <span className="text-[10px] text-zinc-400 block">ADX STOP (&gt;)</span>
                  <input
                    type="number"
                    step="1"
                    value={analyzerThresholds.adxStopThreshold}
                    onChange={(e) =>
                      setAnalyzerThresholds({
                        ...analyzerThresholds,
                        adxStopThreshold: parseFloat(e.target.value) || 30,
                      })
                    }
                    className="w-full bg-zinc-900 border border-rose-500/40 rounded px-2 py-1 text-rose-300 font-bold mt-0.5"
                  />
                </div>
                <div className="bg-black border border-zinc-800 rounded p-2">
                  <span className="text-[10px] text-zinc-400 block">Choppiness STOP (&lt;)</span>
                  <input
                    type="number"
                    step="1"
                    value={analyzerThresholds.chopStopThreshold}
                    onChange={(e) =>
                      setAnalyzerThresholds({
                        ...analyzerThresholds,
                        chopStopThreshold: parseFloat(e.target.value) || 38,
                      })
                    }
                    className="w-full bg-zinc-900 border border-rose-500/40 rounded px-2 py-1 text-rose-300 font-bold mt-0.5"
                  />
                </div>
                <div className="bg-black border border-zinc-800 rounded p-2">
                  <span className="text-[10px] text-zinc-400 block">ATR Creștere (% &gt;)</span>
                  <input
                    type="number"
                    step="5"
                    value={analyzerThresholds.atrSpikeMonitorPct}
                    onChange={(e) =>
                      setAnalyzerThresholds({
                        ...analyzerThresholds,
                        atrSpikeMonitorPct: parseFloat(e.target.value) || 50,
                      })
                    }
                    className="w-full bg-zinc-900 border border-cyan-500/40 rounded px-2 py-1 text-cyan-300 font-bold mt-0.5"
                  />
                </div>
                <div className="bg-black border border-zinc-800 rounded p-2">
                  <span className="text-[10px] text-zinc-400 block">Dist. Limită Warn (%)</span>
                  <input
                    type="number"
                    step="1"
                    value={analyzerThresholds.rangeEdgeWarningPct}
                    onChange={(e) =>
                      setAnalyzerThresholds({
                        ...analyzerThresholds,
                        rangeEdgeWarningPct: parseFloat(e.target.value) || 10,
                      })
                    }
                    className="w-full bg-zinc-900 border border-amber-500/40 rounded px-2 py-1 text-amber-300 font-bold mt-0.5"
                  />
                </div>
                <div className="bg-black border border-zinc-800 rounded p-2">
                  <span className="text-[10px] text-zinc-400 block">Pierdere WARN (-%)</span>
                  <input
                    type="number"
                    step="0.5"
                    value={analyzerThresholds.warningDrawdownPct}
                    onChange={(e) =>
                      setAnalyzerThresholds({
                        ...analyzerThresholds,
                        warningDrawdownPct: parseFloat(e.target.value) || 5,
                      })
                    }
                    className="w-full bg-zinc-900 border border-amber-500/40 rounded px-2 py-1 text-amber-300 font-bold mt-0.5"
                  />
                </div>
                <div className="bg-black border border-zinc-800 rounded p-2">
                  <span className="text-[10px] text-zinc-400 block">Pierdere STOP (-%)</span>
                  <input
                    type="number"
                    step="0.5"
                    value={analyzerThresholds.stopDrawdownPct}
                    onChange={(e) =>
                      setAnalyzerThresholds({
                        ...analyzerThresholds,
                        stopDrawdownPct: parseFloat(e.target.value) || 8,
                      })
                    }
                    className="w-full bg-zinc-900 border border-rose-500/40 rounded px-2 py-1 text-rose-300 font-bold mt-0.5"
                  />
                </div>
                <div className="bg-black border border-zinc-800 rounded p-2">
                  <span className="text-[10px] text-zinc-400 block">Siguranță LiqPx (%)</span>
                  <input
                    type="number"
                    step="0.5"
                    value={analyzerThresholds.minLiqSafetyPct}
                    onChange={(e) =>
                      setAnalyzerThresholds({
                        ...analyzerThresholds,
                        minLiqSafetyPct: parseFloat(e.target.value) || 4,
                      })
                    }
                    className="w-full bg-zinc-900 border border-rose-500/40 rounded px-2 py-1 text-rose-300 font-bold mt-0.5"
                  />
                </div>
              </div>
            </div>
          )}

          {/* Collapsible Stop / Emergency / Operational Error Log (Section 7) */}
          {showAnalyzerStopLog && (
            <div className="bg-zinc-950 border border-rose-500/40 rounded p-3 space-y-2">
              <div className="flex items-center justify-between border-b border-rose-500/30 pb-1.5">
                <h4 className="font-black text-xs text-rose-300">
                  JURNAL OBLIGATORIU EXCLUSIV LA OPRIRE / ÎNCHIDERE / EROARE OPERAȚIONALĂ (SECȚIUNEA 7)
                </h4>
                <span className="text-[10px] text-zinc-400">
                  .data/grid_analyzer_events.json ({gridAnalyzer?.stopEvents?.length || 0} evenimente)
                </span>
              </div>

              {!gridAnalyzer?.stopEvents || gridAnalyzer.stopEvents.length === 0 ? (
                <div className="text-center py-4 text-xs text-zinc-400">
                  Niciun eveniment STOP / EMERGENCY înregistrat. Analizele normale (CONTINUE, MONITOR, WARNING) rulează exclusiv în memorie conform Secțiunii 7.
                </div>
              ) : (
                <div className="overflow-x-auto max-h-60">
                  <table className="w-full text-left border-collapse text-[10px]">
                    <thead>
                      <tr className="border-b border-zinc-800 text-zinc-400">
                        <th className="py-1 px-2">Timp</th>
                        <th className="py-1 px-2">Bot / Instrument</th>
                        <th className="py-1 px-2">Decizie / stopType</th>
                        <th className="py-1 px-2">Motiv Exact</th>
                        <th className="py-1 px-2">Indicatori Declanșatori</th>
                        <th className="py-1 px-2">Grid / Float / Total PnL</th>
                        <th className="py-1 px-2">Drawdown / LiqPx</th>
                        <th className="py-1 px-2">Confirmare Finală OKX</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-900">
                      {gridAnalyzer.stopEvents.map((ev) => (
                        <tr key={ev.idempotencyKey} className="hover:bg-zinc-900/60">
                          <td className="py-1.5 px-2 tabular-nums text-zinc-300">
                            {new Date(ev.timestamp).toLocaleString()}
                          </td>
                          <td className="py-1.5 px-2">
                            <div className="font-bold text-white">{ev.instId}</div>
                            <div className="font-mono text-cyan-400">{ev.algoId}</div>
                          </td>
                          <td className="py-1.5 px-2">
                            <span
                              className={`px-1.5 py-0.5 rounded font-black ${
                                ev.executedDecision === 'EMERGENCY'
                                  ? 'bg-rose-600 text-white'
                                  : ev.executedDecision === 'STOP'
                                  ? 'bg-amber-500 text-black'
                                  : 'bg-zinc-800 text-rose-300'
                              }`}
                            >
                              {ev.executedDecision} (stopType={ev.stopType})
                            </span>
                          </td>
                          <td className="py-1.5 px-2 text-rose-300 max-w-xs">
                            {ev.exactStopReason}
                          </td>
                          <td className="py-1.5 px-2 tabular-nums text-zinc-300">
                            ADX: {Number(ev.triggeringIndicators?.adx || 0).toFixed(1)} | Chop:{' '}
                            {Number(ev.triggeringIndicators?.choppinessIndex || 0).toFixed(1)} | ATR
                            Δ: {Number(ev.triggeringIndicators?.atrChangePct || 0).toFixed(1)}%
                          </td>
                          <td className="py-1.5 px-2 tabular-nums">
                            G: ${Number(ev.pnlBreakdown?.gridProfitUSDT || 0).toFixed(2)} | F: $
                            {Number(ev.pnlBreakdown?.floatProfitUSDT || 0).toFixed(2)} | T: $
                            {Number(ev.pnlBreakdown?.totalPnlUSDT || 0).toFixed(2)}
                          </td>
                          <td className="py-1.5 px-2 tabular-nums text-rose-300">
                            DD: {Number(ev.riskMetrics?.drawdownPct || 0).toFixed(2)}% | Liq:{' '}
                            {ev.riskMetrics?.distToLiqPct !== undefined
                              ? `${Number(ev.riskMetrics.distToLiqPct).toFixed(1)}%`
                              : 'N/A'}
                          </td>
                          <td className="py-1.5 px-2">
                            <div
                              className={
                                ev.okxFinalStateConfirmed
                                  ? 'text-emerald-400 font-bold'
                                  : 'text-amber-300'
                              }
                            >
                              {ev.okxFinalStateConfirmed
                                ? `✓ Confirmat (${ev.okxConfirmedState})`
                                : `⚠ ${ev.okxConfirmedState}`}
                            </div>
                            <div className="text-zinc-400">
                              Close Pos: {ev.closePositionResult}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Autopilot & Budget Configuration Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
          <div className="bg-black border border-zinc-800 rounded p-2">
            <span className="text-[10px] text-zinc-400 block">Buget Max / Bot ($)</span>
            <input
              type="number"
              min={2}
              step="1"
              value={maxBudgetPerBot}
              onChange={(e) =>
                setMaxBudgetPerBot(e.target.value === '' ? ('' as any) : parseFloat(e.target.value))
              }
              className="w-full bg-zinc-900 border border-emerald-500/40 rounded px-2 py-1 text-emerald-300 font-bold mt-0.5"
            />
          </div>
          <div className="bg-black border border-zinc-800 rounded p-2">
            <span className="text-[10px] text-zinc-400 block">Rezervă Liberă ($)</span>
            <input
              type="number"
              min={0}
              step="1"
              value={minReserve}
              onChange={(e) =>
                setMinReserve(e.target.value === '' ? ('' as any) : parseFloat(e.target.value))
              }
              className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-white font-bold mt-0.5"
            />
          </div>
          <div className="bg-black border border-zinc-800 rounded p-2">
            <span className="text-[10px] text-zinc-400 block">Max Boți Nativi</span>
            <input
              type="number"
              min={1}
              max={15}
              value={maxConcurrentBots}
              onChange={(e) =>
                setMaxConcurrentBots(
                  e.target.value === '' ? ('' as any) : parseInt(e.target.value, 10)
                )
              }
              className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-white font-bold mt-0.5"
            />
          </div>
          <div className="bg-black border border-zinc-800 rounded p-2">
            <span className="text-[10px] text-zinc-400 block">Levier Max (1x–20x)</span>
            <select
              value={maxLeverage}
              onChange={(e) => setMaxLeverage(parseInt(e.target.value, 10) || 3)}
              className="w-full bg-zinc-900 border border-amber-500/40 rounded px-2 py-1 text-amber-300 font-bold mt-0.5"
            >
              {[1, 2, 3, 5, 7, 10, 15, 20].map((l) => (
                <option key={l} value={l}>
                  {l}x Max
                </option>
              ))}
            </select>
          </div>
          <div className="bg-black border border-zinc-800 rounded p-2">
            <span className="text-[10px] text-zinc-400 block">Scor Minim (0–100)</span>
            <input
              type="number"
              min={40}
              max={95}
              value={minScore}
              onChange={(e) =>
                setMinScore(e.target.value === '' ? ('' as any) : parseInt(e.target.value, 10))
              }
              className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-white font-bold mt-0.5"
            />
          </div>
          <div className="bg-black border border-zinc-800 rounded p-2">
            <span className="text-[10px] text-zinc-400 block">Profit Net Min/Grilă %</span>
            <input
              type="number"
              step="0.02"
              value={minNetProfitPct}
              onChange={(e) =>
                setMinNetProfitPct(
                  e.target.value === '' ? ('' as any) : parseFloat(e.target.value)
                )
              }
              className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-emerald-300 font-bold mt-0.5"
            />
          </div>
          <div className="bg-black border border-zinc-800 rounded p-2">
            <span className="text-[10px] text-zinc-400 block">SL % / TP % Bot</span>
            <div className="grid grid-cols-2 gap-1 mt-0.5">
              <input
                type="number"
                step="0.5"
                value={stopLossPct}
                onChange={(e) =>
                  setStopLossPct(e.target.value === '' ? ('' as any) : parseFloat(e.target.value))
                }
                className="w-full bg-zinc-900 border border-rose-500/40 rounded px-1.5 py-1 text-rose-300 font-bold"
                title="Stop Loss %"
              />
              <input
                type="number"
                step="0.5"
                value={takeProfitPct}
                onChange={(e) =>
                  setTakeProfitPct(e.target.value === '' ? ('' as any) : parseFloat(e.target.value))
                }
                className="w-full bg-zinc-900 border border-emerald-500/40 rounded px-1.5 py-1 text-emerald-300 font-bold"
                title="Take Profit %"
              />
            </div>
          </div>
          <div className="bg-black border border-zinc-800 rounded p-2">
            <span className="text-[10px] text-zinc-400 block">Mod Oprire Risc OKX</span>
            <select
              value={defaultStopType}
              onChange={(e) => setDefaultStopType(e.target.value === '2' ? '2' : '1')}
              className="w-full bg-zinc-900 border border-cyan-500/40 rounded px-1.5 py-1 text-cyan-300 font-bold mt-0.5"
            >
              <option value="1">stopType 1: Închide Poziția</option>
              <option value="2">stopType 2: Păstrează Poziția</option>
            </select>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-[11px]">
          <div className="flex flex-wrap items-center gap-3 text-zinc-300">
            <label className="flex items-center space-x-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={stopOnBreakout}
                onChange={(e) => setStopOnBreakout(e.target.checked)}
                className="accent-cyan-400"
              />
              <span>Oprește la spargerea intervalului (Range Breakout)</span>
            </label>
            <label className="flex items-center space-x-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={stopOnTrendInvalidation}
                onChange={(e) => setStopOnTrendInvalidation(e.target.checked)}
                className="accent-cyan-400"
              />
              <span>Oprește când piața intră în TRENDING_RISK puternic</span>
            </label>
            <span className="text-zinc-500">|</span>
            <span className="text-amber-300">
              Decizie Autopilot: <strong>{autopilot?.lastDecision || 'Pregătit'}</strong>
            </span>
          </div>

          <div className="flex items-center space-x-2">
            <button
              type="button"
              onClick={() => handleSaveAutopilot()}
              disabled={isSavingAp}
              className="px-3 py-1 rounded bg-amber-500 hover:bg-amber-400 text-black font-black cursor-pointer"
            >
              {isSavingAp ? 'Se salvează...' : 'Salvează Configurația Nativă'}
            </button>
            <button
              type="button"
              onClick={handleScanNow}
              disabled={isScanning}
              className="px-3 py-1 rounded bg-cyan-500 hover:bg-cyan-400 text-black font-black flex items-center space-x-1 cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isScanning ? 'animate-spin' : ''}`} />
              <span>
                {isScanning
                  ? 'Se interoghează OKX...'
                  : 'Scanează & Calculează Min-Investment OKX'}
              </span>
            </button>
          </div>
        </div>
      </div>

      {/* ================================================================= */}
      {/* 2. MAIN WORKSPACE: MANUAL BUILDER (4 COLS) + ACTIVE BOTS (8 COLS)  */}
      {/* ================================================================= */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 items-start">
        {/* LEFT 4 COLS: BUILDER CU VALIDARE LIVE POST /api/v5/tradingBot/grid/min-investment */}
        <div className="lg:col-span-4 bg-zinc-950 border border-amber-500/40 rounded p-3 space-y-2.5">
          <div className="flex items-center justify-between border-b border-amber-500/30 pb-2">
            <div className="flex items-center space-x-1.5">
              <Settings className="w-4 h-4 text-amber-400" />
              <h3 className="font-bold text-xs text-amber-400">
                CREARE BOT NATIV OKX (contract_grid — neutral)
              </h3>
            </div>
            <span className="px-2 py-0.5 rounded text-[10px] font-black bg-rose-600 text-white">
              LIVE OKX
            </span>
          </div>

          <div className="space-y-2">
            <div>
              <label className="text-[10px] text-zinc-400 block mb-0.5">
                Instrument OKX EEA (Exclusiv _UM_XPERP)
              </label>
              <select
                value={instId}
                onChange={(e) => {
                  const next = e.target.value;
                  setInstId(next);
                  const found = opportunities.find((o) => o.instId === next);
                  if (found) handleLoadOpportunity(found);
                }}
                className="w-full bg-black border border-amber-500/50 rounded px-2.5 py-1.5 text-white font-bold"
              >
                {opportunities.map((o) => (
                  <option key={o.instId} value={o.instId}>
                    {o.instId} — ${formatPrice(o.price)} (Min-Inv: ${o.minInvestmentUSDT.toFixed(2)})
                  </option>
                ))}
                {!opportunities.some((o) => o.instId === instId) && (
                  <option value={instId}>{instId}</option>
                )}
              </select>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[10px] text-zinc-400 block mb-0.5">
                  Limita Inferioară (minPx $)
                </label>
                <input
                  type="number"
                  step="any"
                  value={minPx}
                  onChange={(e) =>
                    setMinPx(e.target.value === '' ? ('' as any) : parseFloat(e.target.value))
                  }
                  className="w-full bg-black border border-emerald-500/50 rounded px-2 py-1 text-emerald-300 font-bold"
                />
              </div>
              <div>
                <label className="text-[10px] text-zinc-400 block mb-0.5">
                  Limita Superioară (maxPx $)
                </label>
                <input
                  type="number"
                  step="any"
                  value={maxPx}
                  onChange={(e) =>
                    setMaxPx(e.target.value === '' ? ('' as any) : parseFloat(e.target.value))
                  }
                  className="w-full bg-black border border-rose-500/50 rounded px-2 py-1 text-rose-300 font-bold"
                />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="text-[10px] text-zinc-400 block mb-0.5">
                  Nr. Grile (gridNum)
                </label>
                <input
                  type="number"
                  min={2}
                  max={100}
                  value={gridNum}
                  onChange={(e) =>
                    setGridNum(
                      e.target.value === '' ? ('' as any) : parseInt(e.target.value, 10)
                    )
                  }
                  className="w-full bg-black border border-zinc-700 rounded px-2 py-1 text-white font-bold"
                />
              </div>
              <div>
                <label className="text-[10px] text-zinc-400 block mb-0.5">
                  Tip Grilă (runType)
                </label>
                <select
                  value={runType}
                  onChange={(e) => setRunType(e.target.value === '2' ? '2' : '1')}
                  className="w-full bg-black border border-zinc-700 rounded px-2 py-1 text-white font-bold"
                >
                  <option value="1">1: Aritmetic</option>
                  <option value="2">2: Geometric</option>
                </select>
              </div>
              <div>
                <label className="text-[10px] text-zinc-400 block mb-0.5">
                  Levier (lever)
                </label>
                <select
                  value={lever}
                  onChange={(e) => setLever(parseInt(e.target.value, 10) || 3)}
                  className="w-full bg-black border border-amber-500/50 rounded px-2 py-1 text-amber-300 font-bold"
                >
                  {[1, 2, 3, 5, 7, 10, 15, 20].map((l) => (
                    <option key={l} value={l}>
                      {l}x
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[10px] text-zinc-400 block mb-0.5">
                  Marjă Investită pe OKX (sz $)
                </label>
                <input
                  type="number"
                  step="0.5"
                  value={sz}
                  onChange={(e) =>
                    setSz(e.target.value === '' ? ('' as any) : parseFloat(e.target.value))
                  }
                  className="w-full bg-black border border-emerald-500/50 rounded px-2 py-1 text-emerald-300 font-bold"
                />
              </div>
              <div>
                <label className="text-[10px] text-zinc-400 block mb-0.5">
                  Mod Oprire Bot (stopType)
                </label>
                <select
                  value={customStopType}
                  onChange={(e) => setCustomStopType(e.target.value === '2' ? '2' : '1')}
                  className="w-full bg-black border border-cyan-500/50 rounded px-2 py-1 text-cyan-300 font-bold"
                >
                  <option value="1">stopType 1: Închide Poziția</option>
                  <option value="2">stopType 2: Păstrează Poziția</option>
                </select>
              </div>
            </div>

            {/* LIVE SL & TP CALCULATOR BOX (PREȚ TRIGGER $ + PROCENT PnL % / $) */}
            <div className="bg-black border border-amber-500/40 rounded p-2.5 space-y-2">
              <div className="flex items-center justify-between border-b border-zinc-800 pb-1">
                <span className="text-[10px] font-black text-amber-300">
                  🎯 CALCULATOR AUTOMAT STOP LOSS &amp; TAKE PROFIT (LIVE)
                </span>
                <span className="text-[9px] text-zinc-400">
                  Click pe orice valoare pt. Copy
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] text-rose-300 block mb-0.5">
                    Stop Loss % din Marjă (SL %)
                  </label>
                  <input
                    type="number"
                    step="0.5"
                    min={0.5}
                    value={stopLossPct}
                    onChange={(e) =>
                      setStopLossPct(e.target.value === '' ? ('' as any) : parseFloat(e.target.value))
                    }
                    className="w-full bg-zinc-900 border border-rose-500/50 rounded px-2 py-1 text-rose-300 font-bold"
                  />
                </div>
                <div>
                  <label className="text-[10px] text-emerald-300 block mb-0.5">
                    Take Profit % din Marjă (TP %)
                  </label>
                  <input
                    type="number"
                    step="0.5"
                    min={0.5}
                    value={takeProfitPct}
                    onChange={(e) =>
                      setTakeProfitPct(
                        e.target.value === '' ? ('' as any) : parseFloat(e.target.value)
                      )
                    }
                    className="w-full bg-zinc-900 border border-emerald-500/50 rounded px-2 py-1 text-emerald-300 font-bold"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-1.5 text-[10px]">
                <div
                  onClick={() => handleCopyField('SL Trigger Price ($)', formatPrice(calcSlTriggerPx))}
                  className="bg-zinc-950 hover:bg-zinc-900 border border-rose-500/30 rounded px-2 py-1 cursor-pointer flex items-center justify-between"
                  title="Click pentru a copia SL Trigger Price ($)"
                >
                  <div>
                    <span className="text-zinc-400 block text-[9px]">SL Trigger Price (Sub minPx)</span>
                    <span className="font-black text-rose-400">${formatPrice(calcSlTriggerPx)}</span>
                  </div>
                  <span className="text-[9px] text-cyan-400 font-bold">Copy</span>
                </div>

                <div
                  onClick={() => handleCopyField('TP Trigger Price ($)', formatPrice(calcTpTriggerPx))}
                  className="bg-zinc-950 hover:bg-zinc-900 border border-emerald-500/30 rounded px-2 py-1 cursor-pointer flex items-center justify-between"
                  title="Click pentru a copia TP / Upper Stop Price ($)"
                >
                  <div>
                    <span className="text-zinc-400 block text-[9px]">TP / Upper Trigger (Peste maxPx)</span>
                    <span className="font-black text-emerald-400">${formatPrice(calcTpTriggerPx)}</span>
                  </div>
                  <span className="text-[9px] text-cyan-400 font-bold">Copy</span>
                </div>

                <div
                  onClick={() => handleCopyField('SL PnL %', `${stopLossPct || 8}`)}
                  className="bg-zinc-950 hover:bg-zinc-900 border border-zinc-800 rounded px-2 py-1 cursor-pointer flex items-center justify-between"
                  title="Click pentru a copia procentul SL"
                >
                  <div>
                    <span className="text-zinc-400 block text-[9px]">Pierdere Max la SL (-{stopLossPct || 8}%)</span>
                    <span className="font-bold text-rose-300">
                      -${(((Number(sz) || 0) * (Number(stopLossPct) || 8)) / 100).toFixed(2)} USD
                    </span>
                  </div>
                  <span className="text-[9px] text-cyan-400 font-bold">Copy %</span>
                </div>

                <div
                  onClick={() => handleCopyField('TP PnL %', `${takeProfitPct || 15}`)}
                  className="bg-zinc-950 hover:bg-zinc-900 border border-zinc-800 rounded px-2 py-1 cursor-pointer flex items-center justify-between"
                  title="Click pentru a copia procentul TP"
                >
                  <div>
                    <span className="text-zinc-400 block text-[9px]">Țintă Profit la TP (+{takeProfitPct || 15}%)</span>
                    <span className="font-bold text-emerald-300">
                      +${(((Number(sz) || 0) * (Number(takeProfitPct) || 15)) / 100).toFixed(2)} USD
                    </span>
                  </div>
                  <span className="text-[9px] text-cyan-400 font-bold">Copy %</span>
                </div>
              </div>
            </div>

            {/* OKX Min-Investment API Result Box */}
            <div className="bg-black border border-zinc-800 rounded p-2 flex items-center justify-between">
              <div>
                <span className="text-[10px] text-zinc-500 block">
                  INVESTIȚIE MINIMĂ OKX API (min-investment)
                </span>
                <span
                  className={`font-black text-xs ${
                    minInvCheck && minInvCheck.minInvestmentUSDT > sz
                      ? 'text-rose-400'
                      : 'text-cyan-300'
                  }`}
                >
                  {minInvCheck && minInvCheck.minInvestmentUSDT > 0
                    ? `$${minInvCheck.minInvestmentUSDT.toFixed(2)} ${minInvCheck.ccy}`
                    : 'Apasă "Verifică Min-Investment"'}
                </span>
              </div>
              <button
                type="button"
                onClick={handleCheckMinInvestment}
                disabled={isCheckingMinInv}
                className="px-2.5 py-1 rounded bg-zinc-900 hover:bg-zinc-800 text-cyan-300 border border-cyan-500/40 font-bold text-[11px] cursor-pointer"
              >
                {isCheckingMinInv ? 'Calcul...' : 'Verifică Min-Investment'}
              </button>
            </div>

            {executionVariant === 'AUTO_LIMIT' ? (
              <div className="space-y-1.5">
                <button
                  type="button"
                  onClick={() => handleCreateNativeBot()}
                  disabled={isCreating || !instId || minPx <= 0 || maxPx <= minPx}
                  className="w-full py-2 px-3 rounded bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-black font-black text-xs flex items-center justify-center space-x-1.5 cursor-pointer shadow-[0_0_12px_rgba(16,185,129,0.4)]"
                >
                  <Play className="w-3.5 h-3.5 fill-current" />
                  <span>
                    {isCreating
                      ? 'SE LANSEAZĂ GRILA PE OKX...'
                      : '⚡ CREEAZĂ GRILĂ AUTO-LIMIT PE OKX (LIVE)'}
                  </span>
                </button>
                <p className="text-[10px] text-zinc-400 text-center">
                  Varianta 1 activă: Plasează și gestionează automat ordinele Limit ale grilei direct pe OKX EEA.
                </p>
              </div>
            ) : (
              <div className="bg-black border border-cyan-500/50 rounded p-2.5 space-y-2">
                <div className="flex items-center justify-between border-b border-zinc-800 pb-1">
                  <span className="text-[10px] font-black text-cyan-300">
                    🤖 CARTELĂ COPIERE 1-CLICK PENTRU OKX &quot;TRADING BOTS&quot;
                  </span>
                  {copiedField && (
                    <span className="text-[10px] text-emerald-400 font-bold">
                      ✓ Copiat: {copiedField}
                    </span>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-1.5 text-[10px]">
                  {[
                    { label: 'Contract', val: instId },
                    { label: 'Direcție / Tip', val: `Neutral / ${runType === '1' ? 'Arithmetic' : 'Geometric'}` },
                    { label: 'Lower Price (minPx)', val: minPx },
                    { label: 'Upper Price (maxPx)', val: maxPx },
                    { label: 'Grids (Nr. Grile)', val: gridNum },
                    { label: 'Leverage', val: `${lever}x` },
                    { label: 'Margin (USD)', val: sz },
                    { label: 'SL / TP Ratio (%)', val: `-${stopLossPct || 8}% / +${takeProfitPct || 15}%` },
                    { label: 'SL Trigger Price ($)', val: formatPrice(calcSlTriggerPx) },
                    { label: 'TP Trigger Price ($)', val: formatPrice(calcTpTriggerPx) },
                  ].map((item) => (
                    <div
                      key={item.label}
                      onClick={() => handleCopyField(item.label, item.val)}
                      className="bg-zinc-950 hover:bg-zinc-900 border border-zinc-800 rounded px-2 py-1 flex items-center justify-between cursor-pointer"
                      title="Click pentru a copia valoarea"
                    >
                      <div>
                        <span className="text-zinc-500 block text-[9px]">{item.label}</span>
                        <span className="text-white font-bold">{item.val}</span>
                      </div>
                      <span className="text-[9px] text-cyan-400 font-bold">Copy</span>
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={handleSyncNativeBotsNow}
                  disabled={isSyncingBots}
                  className="w-full py-2 px-3 rounded bg-cyan-400 hover:bg-cyan-300 disabled:opacity-50 text-black font-black text-xs flex items-center justify-center space-x-1.5 cursor-pointer shadow-[0_0_12px_rgba(34,211,238,0.4)]"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isSyncingBots ? 'animate-spin' : ''}`} />
                  <span>
                    {isSyncingBots
                      ? 'SE CAUTĂ BOTUL ÎN OKX TRADING BOTS...'
                      : '🔄 AM CREAT BOTUL ÎN OKX — PREIA & SUPRAVEGHEAZĂ ACUM'}
                  </span>
                </button>
              </div>
            )}
          </div>
        </div>

        {/* RIGHT 8 COLS: ACTIVE & HISTORICAL NATIVE OKX BOTS */}
        <div className="lg:col-span-8 bg-zinc-950 border border-amber-500/40 rounded p-3 space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-500/30 pb-2">
            <div className="flex items-center space-x-2">
              <Activity className="w-4 h-4 text-emerald-400" />
              <h3 className="font-bold text-xs text-white">
                BOȚI NATIVI OKX FUTURES GRID ACTIVI &amp; SUPRAVEGHEAȚI ({runningNativeBots.length} ACTIVI / {bots.length} TOTAL)
              </h3>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={handleSyncNativeBotsNow}
                disabled={isSyncingBots}
                className="px-2 py-1 rounded bg-zinc-900 hover:bg-zinc-800 text-cyan-300 border border-cyan-500/40 text-[10px] font-bold cursor-pointer flex items-center space-x-1"
                title="Sincronizează imediat boții din tabul Trading Bots de pe OKX EEA"
              >
                <RefreshCw className={`w-3 h-3 ${isSyncingBots ? 'animate-spin' : ''}`} />
                <span>Sync OKX Bots</span>
              </button>
              <div className="flex items-center bg-black border border-zinc-800 rounded p-0.5 text-[10px]">
                <button
                  type="button"
                  onClick={() => setBotFilter('ALL')}
                  className={`px-2 py-0.5 rounded font-bold cursor-pointer ${
                    botFilter === 'ALL'
                      ? 'bg-amber-500 text-black'
                      : 'text-zinc-400 hover:text-white'
                  }`}
                >
                  Toți ({bots.length})
                </button>
                <button
                  type="button"
                  onClick={() => setBotFilter('RUNNING')}
                  className={`px-2 py-0.5 rounded font-bold cursor-pointer ${
                    botFilter === 'RUNNING'
                      ? 'bg-emerald-500 text-black'
                      : 'text-zinc-400 hover:text-white'
                  }`}
                >
                  Activi ({runningNativeBots.length})
                </button>
                <button
                  type="button"
                  onClick={() => setBotFilter('STOPPED')}
                  className={`px-2 py-0.5 rounded font-bold cursor-pointer ${
                    botFilter === 'STOPPED'
                      ? 'bg-zinc-700 text-white'
                      : 'text-zinc-400 hover:text-white'
                  }`}
                >
                  Opriți ({stoppedNativeBots.length})
                </button>
              </div>
              {stoppedNativeBots.length > 0 && (
                <button
                  type="button"
                  onClick={handleClearStoppedBots}
                  className="px-2 py-1 rounded bg-zinc-900 hover:bg-rose-950 text-rose-300 border border-rose-500/40 text-[10px] font-bold cursor-pointer"
                  title="Șterge toți boții opriți din această listă"
                >
                  Șterge Opriții ({stoppedNativeBots.length})
                </button>
              )}
            </div>
          </div>

          {displayedBots.length === 0 ? (
            <div className="bg-black border border-zinc-800 rounded p-6 text-center text-zinc-400 space-y-1">
              <p className="font-bold text-amber-300">
                Niciun bot în filtrul selectat ({botFilter === 'RUNNING' ? 'Activi' : botFilter === 'STOPPED' ? 'Opriți' : 'Toți'}).
              </p>
              <p className="text-[11px]">
                Selectează o oportunitate eligibilă din tabelul de Market Intelligence de mai jos sau folosește formularul din stânga pentru a lansa un bot nou LIVE.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-[11px]">
                <thead>
                  <tr className="border-b border-zinc-800 text-zinc-400">
                    <th className="py-1.5 px-2">Instrument / algoId</th>
                    <th className="py-1.5 px-2">Mod / Status / Decizie Analyzer</th>
                    <th className="py-1.5 px-2">Interval / Grile</th>
                    <th className="py-1.5 px-2">Investiție</th>
                    <th className="py-1.5 px-2">Preț / LiqPx</th>
                    <th className="py-1.5 px-2">Grid / Float PnL</th>
                    <th className="py-1.5 px-2">Total PnL</th>
                    <th className="py-1.5 px-2">SL / TP / StopType</th>
                    <th className="py-1.5 px-2 text-right">Acțiuni Directe OKX</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-900">
                  {displayedBots.map((b) => {
                    const snap = gridAnalyzer?.botSnapshots?.find((s) => s.algoId === b.algoId);
                    return (
                    <tr key={b.algoId} className="hover:bg-zinc-900/60">
                      <td className="py-2 px-2">
                        <div className="font-black text-white">{b.instId}</div>
                        <div className="text-[10px] text-cyan-400 font-mono">
                          algoId: {b.algoId}
                        </div>
                        <div className="mt-0.5">
                          {b.algoId.toLowerCase().startsWith('grid') ? (
                            <span className="px-1.5 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 text-[9px] font-bold">
                              ⚡ AUTO-LIMIT OKX (Open Orders)
                            </span>
                          ) : (
                            <span className="px-1.5 py-0.5 rounded bg-cyan-500/15 border border-cyan-500/40 text-cyan-300 text-[9px] font-bold">
                              🤖 BOT NATIV OKX (Trading Bots)
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="py-2 px-2">
                        <div className="flex flex-wrap items-center gap-1">
                          <span
                            className={`px-1.5 py-0.5 rounded text-[10px] font-black ${
                              b.environment === 'LIVE'
                                ? 'bg-rose-600 text-white'
                                : 'bg-zinc-800 text-amber-300'
                            }`}
                          >
                            {b.environment}
                          </span>
                          <span
                            className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                              b.state === 'running'
                                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                                : 'bg-zinc-800 text-zinc-400'
                            }`}
                          >
                            {b.state.toUpperCase()}
                          </span>
                          {snap && (
                            <span
                              title={snap.decisionReason}
                              className={`px-1.5 py-0.5 rounded text-[9px] font-black ${
                                snap.decision === 'CONTINUE'
                                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                                  : snap.decision === 'MONITOR'
                                  ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                                  : snap.decision === 'WARNING'
                                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                                  : 'bg-rose-600 text-white'
                              }`}
                            >
                              {snap.decision}
                            </span>
                          )}
                        </div>
                        {snap && (
                          <div className="text-[9px] text-zinc-400 mt-0.5 tabular-nums">
                            ADX:{' '}
                            <strong className="text-white">
                              {Number(snap.market?.adx || 0).toFixed(1)}
                            </strong>{' '}
                            | Chop:{' '}
                            <strong className="text-white">
                              {Number(snap.market?.choppinessIndex || 0).toFixed(1)}
                            </strong>{' '}
                            | Edge:{' '}
                            <strong className="text-amber-300">
                              {Number(snap.risk?.minDistToEdgePct || 0).toFixed(1)}%
                            </strong>
                          </div>
                        )}
                        {(b.stopReason || (snap && snap.decision !== 'CONTINUE')) && (
                          <div
                            className="text-[9px] text-rose-300 mt-0.5 max-w-[200px] truncate"
                            title={b.stopReason || snap?.decisionReason}
                          >
                            {b.stopReason || snap?.decisionReason}
                          </div>
                        )}
                      </td>
                      <td className="py-2 px-2 tabular-nums">
                        <div className="text-zinc-200 font-bold">
                          ${formatPrice(b.minPx)} – ${formatPrice(b.maxPx)}
                        </div>
                        <div className="text-[10px] text-zinc-400">
                          {b.gridNum} grile ({b.runType === '1' ? 'Aritm' : 'Geom'}) • Arb: {b.arbitrageNum ?? 0}
                        </div>
                      </td>
                      <td className="py-2 px-2 tabular-nums">
                        <div className="font-bold text-amber-300">${Number(b.sz || 0).toFixed(2)}</div>
                        <div className="text-[10px] text-zinc-400">{b.lever || 1}x NEUTRAL</div>
                      </td>
                      <td className="py-2 px-2 tabular-nums">
                        <div className="font-bold text-white">${formatPrice(b.currentPx)}</div>
                        <div className="text-[10px] text-rose-400">
                          Liq: {b.liqPx > 0 ? `$${formatPrice(b.liqPx)}` : 'N/A'}
                        </div>
                      </td>
                      <td className="py-2 px-2 tabular-nums">
                        <div className="text-emerald-400">
                          Grid: {Number(b.gridProfit || 0) >= 0 ? '+' : ''}${Number(b.gridProfit || 0).toFixed(3)}
                        </div>
                        <div className="text-zinc-400 text-[10px]">
                          Float: {Number(b.floatProfit || 0) >= 0 ? '+' : ''}${Number(b.floatProfit || 0).toFixed(3)}
                        </div>
                      </td>
                      <td className="py-2 px-2 tabular-nums">
                        <div
                          className={`font-black ${
                            Number(b.totalPnl || 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'
                          }`}
                        >
                          {Number(b.totalPnl || 0) >= 0 ? '+' : ''}${Number(b.totalPnl || 0).toFixed(3)}
                        </div>
                        <div
                          className={`text-[10px] ${
                            Number(b.totalPnlPct || 0) >= 0 ? 'text-emerald-300' : 'text-rose-300'
                          }`}
                        >
                          ({Number(b.totalPnlPct || 0) >= 0 ? '+' : ''}
                          {Number(b.totalPnlPct || 0).toFixed(2)}%)
                        </div>
                      </td>
                      <td className="py-2 px-2 tabular-nums text-[10px]">
                        <div className="text-rose-300">
                          SL: -{b.stopLossPct}% {b.slTriggerPx ? `($${formatPrice(b.slTriggerPx)})` : ''}
                        </div>
                        <div className="text-emerald-300">
                          TP: +{b.takeProfitPct}% {b.tpTriggerPx ? `($${formatPrice(b.tpTriggerPx)})` : ''}
                        </div>
                        <div className="text-cyan-300">
                          stopType: {b.stopTypeOnRisk === '1' ? '1 (Închide)' : '2 (Păstrează)'}
                        </div>
                      </td>
                      <td className="py-2 px-2 text-right">
                        {b.state === 'running' ? (
                          <div className="flex flex-wrap items-center justify-end gap-1">
                            <button
                              type="button"
                              onClick={() => {
                                setEditingBot(b);
                                setEditTpPx(b.tpTriggerPx || 0);
                                setEditSlPx(b.slTriggerPx || 0);
                                setEditStopType(b.stopTypeOnRisk || '1');
                              }}
                              className="px-2 py-1 rounded bg-zinc-900 hover:bg-zinc-800 text-amber-300 border border-amber-500/40 text-[10px] font-bold cursor-pointer"
                              title="Modifică SL/TP pe OKX (amend-order-algo)"
                            >
                              SL/TP
                            </button>
                            <button
                              type="button"
                              onClick={() => handleClosePositionOnly(b.algoId)}
                              className="px-2 py-1 rounded bg-zinc-900 hover:bg-amber-950 text-amber-300 border border-amber-500/40 text-[10px] font-bold cursor-pointer"
                              title="POST /api/v5/tradingBot/grid/close-position"
                            >
                              Close Pos
                            </button>
                            <button
                              type="button"
                              onClick={() => handleStopNativeBot(b.algoId, '1')}
                              className="px-2 py-1 rounded bg-rose-600 hover:bg-rose-500 text-white text-[10px] font-black cursor-pointer"
                              title="Oprește botul și închide poziția la piață (stopType 1)"
                            >
                              Stop [1:Închide]
                            </button>
                            <button
                              type="button"
                              onClick={() => handleStopNativeBot(b.algoId, '2')}
                              className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-rose-300 border border-rose-500/40 text-[10px] font-bold cursor-pointer"
                              title="Oprește botul și păstrează poziția deschisă (stopType 2)"
                            >
                              Stop [2:Păstrează]
                            </button>
                          </div>
                        ) : (
                          <div className="flex flex-wrap items-center justify-end gap-1">
                            <button
                              type="button"
                              disabled={isCreating}
                              onClick={() => handleRestartStoppedBot(b)}
                              className="px-2 py-1 rounded bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-black text-[10px] font-black cursor-pointer"
                              title="Pornește un bot nou LIVE pe OKX cu aceeași configurație"
                            >
                              ▶ Repornește
                            </button>
                            <button
                              type="button"
                              onClick={() => handleLoadStoppedBotToBuilder(b)}
                              className="px-2 py-1 rounded bg-zinc-900 hover:bg-zinc-800 text-cyan-300 border border-cyan-500/40 text-[10px] font-bold cursor-pointer"
                              title="Încarcă parametrii în Builderul din stânga pentru editare înainte de lansare"
                            >
                              ⚙ În Builder
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDeleteNativeBot(b.algoId, b.instId)}
                              className="px-2 py-1 rounded bg-zinc-900 hover:bg-rose-950 text-rose-300 border border-rose-500/40 text-[10px] font-bold cursor-pointer"
                              title="Șterge acest bot oprit din listă"
                            >
                              ✕ Șterge
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* ================================================================= */}
      {/* 3. MARKET INTELLIGENCE & OKX MIN-INVESTMENT OPPORTUNITY TABLE     */}
      {/* ================================================================= */}
      <div className="bg-zinc-950 border border-cyan-500/40 rounded p-3 space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-cyan-500/30 pb-2">
          <div className="flex items-center space-x-2">
            <Search className="w-4 h-4 text-cyan-400" />
            <div>
              <h3 className="font-bold text-xs text-white">
                MARKET INTELLIGENCE &amp; OPTIMIZATOR INVESTIȚIE MINIMĂ OKX (_UM_XPERP — {eligibleOpportunities.length} ELIGIBILE / {opportunities.length} ANALIZATE)
              </h3>
              <p className="text-[10px] text-zinc-400">
                Analizează Lichiditatea, Volumul, Volatilitatea (ATR/Chop), Spread-ul, Trendul (ADX), Open Interest, Funding 8h, OrderBook Imbalance și filtrează automat oportunitățile peste bugetul de ${maxBudgetPerBot} sau neprofitabile după comisioanele reale OKX ({feeTierInfo?.roundTripMakerFeePct ?? 0.04}% round-trip).
              </p>
            </div>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-[11px]">
            <thead>
              <tr className="border-b border-zinc-800 text-zinc-400">
                <th className="py-1.5 px-2">Contract _UM_XPERP</th>
                <th className="py-1.5 px-2">Preț / Range 24h</th>
                <th className="py-1.5 px-2">Scor &amp; Regim</th>
                <th className="py-1.5 px-2">Chop / ADX / ATR</th>
                <th className="py-1.5 px-2">Open Interest / Vol 24h</th>
                <th className="py-1.5 px-2">Funding 8h / Spread</th>
                <th className="py-1.5 px-2">OrderBook Depth / Imb</th>
                <th className="py-1.5 px-2">Range Optimizat / Grile</th>
                <th className="py-1.5 px-2">OKX Min-Investment</th>
                <th className="py-1.5 px-2">Profit Net/Grilă</th>
                <th className="py-1.5 px-2 text-right">Acțiune</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-900">
              {opportunities.map((opp) => (
                <tr
                  key={opp.instId}
                  className={`hover:bg-zinc-900/60 ${
                    opp.isEligible ? '' : 'opacity-65'
                  }`}
                >
                  <td className="py-2 px-2">
                    <div className="font-black text-white">{opp.instId}</div>
                    <div className="text-[10px] text-zinc-400">
                      {opp.isEligible ? (
                        <span className="text-emerald-400 font-bold">✓ ELIGIBIL NEUTRAL GRID</span>
                      ) : (
                        <span className="text-rose-400" title={opp.rejectionReason}>
                          ✕ {opp.rejectionReason}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="py-2 px-2 tabular-nums">
                    <div className="font-bold text-amber-300">${formatPrice(opp.price)}</div>
                    <div className="text-[10px] text-zinc-400">
                      Range 24h: {opp.range24hPct.toFixed(2)}%
                    </div>
                  </td>
                  <td className="py-2 px-2">
                    <div className="font-black text-cyan-300">{opp.suitabilityScore}/100</div>
                    <span
                      className={`inline-block px-1.5 py-0.5 rounded text-[9px] font-bold ${
                        opp.regimeLabel === 'IDEAL_RANGE'
                          ? 'bg-emerald-500/20 text-emerald-300'
                          : opp.regimeLabel === 'HIGH_VOL_RANGE'
                          ? 'bg-amber-500/20 text-amber-300'
                          : 'bg-rose-500/20 text-rose-300'
                      }`}
                    >
                      {opp.regimeLabel}
                    </span>
                  </td>
                  <td className="py-2 px-2 tabular-nums text-[10px]">
                    <div>Chop: <strong className="text-white">{opp.choppinessIndex.toFixed(1)}</strong></div>
                    <div>ADX: <strong className="text-white">{opp.adxTrendStrength.toFixed(1)}</strong> | ATR: {opp.atrPct.toFixed(2)}%</div>
                  </td>
                  <td className="py-2 px-2 tabular-nums text-[10px]">
                    <div className="text-white font-bold">
                      OI: ${(opp.openInterestUSD / 1000).toFixed(1)}K
                    </div>
                    <div className="text-zinc-400">
                      Vol: ${(opp.volume24hUSDT / 1000).toFixed(1)}K
                    </div>
                  </td>
                  <td className="py-2 px-2 tabular-nums text-[10px]">
                    <div
                      className={
                        Math.abs(opp.fundingRatePct) > 0.05 ? 'text-rose-400' : 'text-emerald-300'
                      }
                    >
                      Fund: {opp.fundingRatePct >= 0 ? '+' : ''}
                      {opp.fundingRatePct.toFixed(4)}%
                    </div>
                    <div className="text-zinc-400">Spread: {opp.spreadBps.toFixed(1)} bps</div>
                  </td>
                  <td className="py-2 px-2 tabular-nums text-[10px]">
                    <div className="text-white">Depth: ${opp.orderBookDepthUSD.toFixed(0)}</div>
                    <div
                      className={
                        Math.abs(opp.orderBookImbalance) <= 0.35
                          ? 'text-emerald-400'
                          : 'text-amber-400'
                      }
                    >
                      Imb: {(opp.orderBookImbalance * 100).toFixed(0)}%
                    </div>
                  </td>
                  <td className="py-2 px-2 tabular-nums">
                    <div className="font-bold text-white">
                      ${formatPrice(opp.minPx)} – ${formatPrice(opp.maxPx)}
                    </div>
                    <div className="text-[10px] text-amber-300">
                      {opp.gridNum} grile ({opp.gridSpacingPct.toFixed(2)}%) @ {opp.lever}x
                    </div>
                    <div className="text-[9px] text-zinc-400 mt-0.5">
                      <span className="text-rose-300">
                        SL: ${formatPrice(opp.minPx * (1 - (stopLossPct || 8) / 100 / Math.max(1, opp.lever)))}
                      </span>{' '}
                      |{' '}
                      <span className="text-emerald-300">
                        TP: ${formatPrice(opp.maxPx * (1 + (takeProfitPct || 15) / 100 / Math.max(1, opp.lever)))}
                      </span>
                    </div>
                  </td>
                  <td className="py-2 px-2 tabular-nums">
                    <div
                      className={`font-black ${
                        opp.fitsMaxBudget ? 'text-emerald-400' : 'text-rose-400'
                      }`}
                    >
                      ${opp.minInvestmentUSDT.toFixed(2)} {opp.minInvestmentCcy}
                    </div>
                    <div className="text-[10px]">
                      {opp.fitsMaxBudget ? (
                        <span className="text-emerald-300">ÎN BUGET (Rec: ${opp.recommendedInvestmentUSDT})</span>
                      ) : (
                        <span className="text-rose-400">PESTE BUGET (&gt;${maxBudgetPerBot})</span>
                      )}
                    </div>
                  </td>
                  <td className="py-2 px-2 tabular-nums">
                    <div
                      className={`font-black ${
                        opp.estimatedNetProfitPerGridPct >= minNetProfitPct
                          ? 'text-emerald-400'
                          : 'text-rose-400'
                      }`}
                    >
                      +{opp.estimatedNetProfitPerGridPct.toFixed(2)}% / grilă
                    </div>
                    <div className="text-[10px] text-zinc-400">
                      Est/zi: +{opp.estimatedDailyNetYieldPct.toFixed(2)}%
                    </div>
                  </td>
                  <td className="py-2 px-2 text-right">
                    <div className="flex items-center justify-end space-x-1">
                      <button
                        type="button"
                        onClick={() => handleLoadOpportunity(opp)}
                        className="px-2 py-1 rounded bg-zinc-900 hover:bg-zinc-800 text-amber-300 border border-amber-500/40 text-[10px] font-bold cursor-pointer"
                      >
                        În Builder
                      </button>
                      {executionVariant === 'AUTO_LIMIT' ? (
                        <button
                          type="button"
                          disabled={!opp.fitsMaxBudget || isCreating}
                          onClick={() => handleCreateNativeBot(opp)}
                          className="px-2.5 py-1 rounded bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-black text-[10px] font-black cursor-pointer"
                        >
                          ⚡ Lansează Auto-Limit
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => handleLoadOpportunity(opp)}
                          className="px-2.5 py-1 rounded bg-cyan-400 hover:bg-cyan-300 text-black text-[10px] font-black cursor-pointer"
                        >
                          🤖 Pregătește Copy OKX
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* AMEND MODAL FOR NATIVE BOT */}
      {editingBot && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
          onClick={() => setEditingBot(null)}
        >
          <div
            className="bg-zinc-950 border border-cyan-500 rounded p-4 w-full max-w-md space-y-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-cyan-500/30 pb-2">
              <h4 className="font-bold text-sm text-cyan-300">
                MODIFICARE BOT NATIV OKX — {editingBot.instId} ({editingBot.algoId})
              </h4>
              <button
                type="button"
                onClick={() => setEditingBot(null)}
                className="text-zinc-400 hover:text-white font-bold cursor-pointer"
              >
                ✕
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs">
              <div>
                <label className="text-rose-400 block mb-1">SL Trigger Price ($)</label>
                <input
                  type="number"
                  step="any"
                  value={editSlPx}
                  onChange={(e) => setEditSlPx(parseFloat(e.target.value) || 0)}
                  className="w-full bg-black border border-rose-500/50 rounded px-2.5 py-1.5 text-white font-bold"
                />
              </div>
              <div>
                <label className="text-emerald-400 block mb-1">TP Trigger Price ($)</label>
                <input
                  type="number"
                  step="any"
                  value={editTpPx}
                  onChange={(e) => setEditTpPx(parseFloat(e.target.value) || 0)}
                  className="w-full bg-black border border-emerald-500/50 rounded px-2.5 py-1.5 text-white font-bold"
                />
              </div>
              <div className="col-span-2">
                <label className="text-cyan-300 block mb-1">
                  Mod Oprire Automată la Risc (stopType)
                </label>
                <select
                  value={editStopType}
                  onChange={(e) => setEditStopType(e.target.value === '2' ? '2' : '1')}
                  className="w-full bg-black border border-cyan-500/50 rounded px-2.5 py-1.5 text-white font-bold"
                >
                  <option value="1">stopType 1: Închide Poziția la Piață (Recomandat)</option>
                  <option value="2">stopType 2: Păstrează Poziția Deschisă</option>
                </select>
              </div>
            </div>

            <div className="flex justify-end space-x-2 pt-2">
              <button
                type="button"
                onClick={() => setEditingBot(null)}
                className="px-3 py-1.5 bg-zinc-900 text-zinc-300 rounded text-xs cursor-pointer"
              >
                Anulează
              </button>
              <button
                type="button"
                onClick={handleSaveAmend}
                className="px-4 py-1.5 bg-cyan-500 text-black font-black rounded text-xs cursor-pointer"
              >
                Trimite Amend pe OKX
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
