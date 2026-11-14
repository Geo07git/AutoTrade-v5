import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  GridAnalyzerStatusSummary,
  GridAnalyzerThresholds,
  GridRangeVariantId,
  GridRangeVariantProfile,
  NativeGridAutopilotConfig,
  NativeGridOpportunity,
  OKXFeeTierInfo,
  OKXNativeGridBot,
  UniverseCatalogItem,
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
  onInspectLadder?: (botId: string) => void;
  externalSelectedSymbol?: {
    instId: string;
    ts: number;
    minPx?: number;
    maxPx?: number;
    gridNum?: number;
    runType?: '1' | '2';
    lever?: number;
  } | null;
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
  onInspectLadder,
  externalSelectedSymbol,
}) => {
  // Autopilot & Governance state (Exclusively LIVE on OKX EEA)
  const [apEnabled, setApEnabled] = useState<boolean>(Boolean(autopilot?.enabled));
  const [maxBudgetPerBot, setMaxBudgetPerBot] = useState<number>(
    Math.max(5, autopilot?.maxBudgetPerBotUSDT ?? 25)
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
  const [defaultRangeVariant, setDefaultRangeVariant] = useState<GridRangeVariantId>(
    autopilot?.defaultRangeVariant || 'BALANCED'
  );
  const [rowVariants, setRowVariants] = useState<Record<string, GridRangeVariantId>>({});
  const [builderVariant, setBuilderVariant] = useState<GridRangeVariantId>(
    autopilot?.defaultRangeVariant || 'BALANCED'
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
    Math.max(
      5,
      autopilot?.maxBudgetPerBotUSDT ?? 25,
      opportunities[0]?.minInvestmentUSDT ?? 0,
      opportunities[0]?.recommendedInvestmentUSDT ?? 0
    )
  );
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
  const [showInstructions, setShowInstructions] = useState<boolean>(true);
  const [, setCopiedField] = useState<string>('');
  const [editingBot, setEditingBot] = useState<OKXNativeGridBot | null>(null);
  const [editTpPx, setEditTpPx] = useState<number>(0);
  const [editSlPx, setEditSlPx] = useState<number>(0);
  const [editStopType, setEditStopType] = useState<'1' | '2'>('1');

  // Full Universe Manual Selector & On-Demand Parameter Calculator (all ~257 _UM_XPERP coins, regardless of score)
  const [universeCatalog, setUniverseCatalog] = useState<UniverseCatalogItem[]>([]);
  const [isLoadingUniverse, setIsLoadingUniverse] = useState<boolean>(false);
  const [universeSearch, setUniverseSearch] = useState<string>('');
  const [universeSortBy, setUniverseSortBy] = useState<
    'RANGE_24H' | 'VOLUME_24H' | 'CHANGE_24H' | 'MIN_LOT' | 'ALPHA'
  >('RANGE_24H');
  const [onlyBudgetAccessibleLot, setOnlyBudgetAccessibleLot] = useState<boolean>(false);
  const [showManualUniverseModule, setShowManualUniverseModule] = useState<boolean>(true);
  const [manualSelectedInstId, setManualSelectedInstId] = useState<string>('');
  const [manualOppsMap, setManualOppsMap] = useState<Record<string, NativeGridOpportunity>>({});
  const [isCalculatingManual, setIsCalculatingManual] = useState<boolean>(false);
  const builderSectionRef = useRef<HTMLDivElement | null>(null);

  // TB5 GridBotAnalyzer & Autonomous Supervisor state
  const [showAnalyzerThresholds, setShowAnalyzerThresholds] = useState<boolean>(false);
  const [showAnalyzerStopLog, setShowAnalyzerStopLog] = useState<boolean>(false);
  const [showStagnationAnalyzer, setShowStagnationAnalyzer] = useState<boolean>(false);
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
    rangeBreakoutBufferPct: gridAnalyzer?.thresholds?.rangeBreakoutBufferPct ?? 0.5,
    warningDrawdownPct: gridAnalyzer?.thresholds?.warningDrawdownPct ?? 5,
    stopDrawdownPct: gridAnalyzer?.thresholds?.stopDrawdownPct ?? 8,
    minLiqSafetyPct: gridAnalyzer?.thresholds?.minLiqSafetyPct ?? 4.0,
    requireMultiIndicatorForTrendStop:
      gridAnalyzer?.thresholds?.requireMultiIndicatorForTrendStop ?? true,
    emergencyClosePosition: gridAnalyzer?.thresholds?.emergencyClosePosition ?? true,
    stagnationMonitorNoFillMinutes:
      gridAnalyzer?.thresholds?.stagnationMonitorNoFillMinutes ?? 30,
    stagnationWarningNoFillMinutes:
      gridAnalyzer?.thresholds?.stagnationWarningNoFillMinutes ?? 60,
    stagnationReviewMinutes: gridAnalyzer?.thresholds?.stagnationReviewMinutes ?? 120,
    stagnationStopMinutes: gridAnalyzer?.thresholds?.stagnationStopMinutes ?? 180,
    minRealizedPnlProgressUSDT:
      gridAnalyzer?.thresholds?.minRealizedPnlProgressUSDT ?? 0.005,
    minProductiveHourlyYieldPct:
      gridAnalyzer?.thresholds?.minProductiveHourlyYieldPct ?? 0.015,
    minOscillationToGridStepRatio:
      gridAnalyzer?.thresholds?.minOscillationToGridStepRatio ?? 0.85,
    minCapitalTurnover120mRatio:
      gridAnalyzer?.thresholds?.minCapitalTurnover120mRatio ?? 0.25,
    enableEarlyStopOnMarketDeterioration:
      gridAnalyzer?.thresholds?.enableEarlyStopOnMarketDeterioration ?? true,
  });

  const hasHydratedAutopilot = useRef<boolean>(false);
  const lastSyncedAutopilotSig = useRef<string>('');
  const hasHydratedBuilder = useRef<boolean>(false);
  const hasHydratedAnalyzerThresholds = useRef<boolean>(false);

  useEffect(() => {
    if (gridAnalyzer?.thresholds && !hasHydratedAnalyzerThresholds.current) {
      hasHydratedAnalyzerThresholds.current = true;
      setAnalyzerThresholds(gridAnalyzer.thresholds);
    }
  }, [gridAnalyzer?.thresholds]);

  const effectiveMaxBudget = Math.max(
    5,
    Number(maxBudgetPerBot) || Number(autopilot?.maxBudgetPerBotUSDT) || 25
  );
  const effectiveMinScore =
    Number(minScore) || Number(autopilot?.minSuitabilityScore) || 68;
  const effectiveMinNetProfit =
    Number(minNetProfitPct) || Number(autopilot?.minNetProfitPerGridPct) || 0.12;

  const computeBotInvestmentUSDT = (
    minInvUSDT?: number,
    budgetOverride?: number
  ): number => {
    const budget = Math.max(5, Number(budgetOverride ?? effectiveMaxBudget) || 25);
    const minReq = Math.max(5, Number(minInvUSDT) || 0);
    return parseFloat(Math.max(5, minReq, budget).toFixed(2));
  };

  // Sync Autopilot settings on initial load and whenever server configuration actually changes
  useEffect(() => {
    if (!autopilot) return;
    try {
      // Remove legacy duplicate backup key so old Tab 1 settings ($6.00 / 70) never overwrite unified settings
      localStorage.removeItem('tb5_autopilot_backup');
    } catch {}
    const sig = [
      Boolean(autopilot.enabled),
      autopilot.maxBudgetPerBotUSDT,
      autopilot.minReserveUSDT,
      autopilot.maxConcurrentNativeBots,
      autopilot.minSuitabilityScore,
      autopilot.minNetProfitPerGridPct,
      autopilot.maxLeverage,
      autopilot.defaultRunType,
      autopilot.defaultStopType,
      autopilot.defaultRangeVariant,
      autopilot.stopLossPct,
      autopilot.takeProfitPct,
      Boolean(autopilot.stopOnRangeBreakout),
      Boolean(autopilot.stopOnTrendInvalidation),
    ].join('|');

    if (!hasHydratedAutopilot.current || lastSyncedAutopilotSig.current !== sig) {
      hasHydratedAutopilot.current = true;
      lastSyncedAutopilotSig.current = sig;
      const hydratedBudget = Math.max(5, Number(autopilot.maxBudgetPerBotUSDT) || 25);
      setApEnabled(Boolean(autopilot.enabled));
      setMaxBudgetPerBot(hydratedBudget);
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
      if (autopilot.defaultRangeVariant) {
        setDefaultRangeVariant(autopilot.defaultRangeVariant);
        setBuilderVariant(autopilot.defaultRangeVariant);
      }
      setSz((prev) => Math.max(5, hydratedBudget, Number(prev) || 0));
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
      setSz(computeBotInvestmentUSDT(top.minInvestmentUSDT));
      setMinInvCheck({
        minInvestmentUSDT: top.minInvestmentUSDT,
        ccy: top.minInvestmentCcy || 'USD',
        singleAmt: 0,
      });
    }
  }, [opportunities]);

  const authHeaders = () => ({
    'Content-Type': 'application/json',
    'x-bot-token': controlToken || 'tradebot5_admin_token',
  });

  // Automatically verify OKX Min-Investment whenever Builder parameters change so user is never stuck in a manual check state
  useEffect(() => {
    if (!instId || Number(minPx) <= 0 || Number(maxPx) <= Number(minPx)) return;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch('/api/bot/native-grid/min-investment', {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({
            instId,
            minPx: Number(minPx),
            maxPx: Number(maxPx),
            gridNum: Number(gridNum) || 8,
            runType,
            lever: Number(lever) || 3,
          }),
        });
        const data = await res.json();
        if (data && typeof data.minInvestmentUSDT === 'number' && data.minInvestmentUSDT > 0) {
          setMinInvCheck(data);
          setSz((prev) => {
            const currentVal = Number(prev) || 0;
            const floorVal = Math.max(5, data.minInvestmentUSDT, Number(maxBudgetPerBot) || 5);
            return currentVal < Math.max(5, data.minInvestmentUSDT)
              ? parseFloat(floorVal.toFixed(2))
              : currentVal;
          });
        }
      } catch {}
    }, 350);
    return () => clearTimeout(timer);
  }, [instId, minPx, maxPx, gridNum, runType, lever]);

  const handleSaveAutopilot = async (overrideEnabled?: boolean) => {
    setIsSavingAp(true);
    const nextEnabled = typeof overrideEnabled === 'boolean' ? overrideEnabled : apEnabled;
    if (typeof overrideEnabled === 'boolean') {
      setApEnabled(overrideEnabled);
    }
    const sanitizedBudget = Math.max(5, Number(maxBudgetPerBot) || 10);
    setMaxBudgetPerBot(sanitizedBudget);
    try {
      const res = await fetch('/api/bot/native-grid/autopilot', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          enabled: nextEnabled,
          environment: 'LIVE',
          liveExecutionConfirmed: true,
          maxBudgetPerBotUSDT: sanitizedBudget,
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
          defaultRangeVariant,
        }),
      });
      const data = await res.json();
      if (data.success) {
        if (data.autopilot) {
          setApEnabled(Boolean(data.autopilot.enabled));
          try {
            localStorage.removeItem('tb5_autopilot_backup');
            localStorage.setItem('tb5_native_autopilot_backup', JSON.stringify(data.autopilot));
          } catch {}
        }
        onNotify({
          type: 'success',
          text: `Configurație OKX Native Grid LIVE salvată (Autopilot: ${
            data.autopilot?.enabled ? 'ON' : 'OFF'
          } | Buget Max/Bot: $${sanitizedBudget} | Scor Min: ≥${Number(minScore) || 65}). ${data.decision || ''}`,
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
        const nextTargetSz = computeBotInvestmentUSDT(data.minInvestmentUSDT);
        setSz((prev) => Math.max(nextTargetSz, Number(prev) || 0));
        onNotify({
          type: 'info',
          text: `OKX API Min-Investment (${instId}): $${data.minInvestmentUSDT.toFixed(2)} ${data.ccy} (Min Operare TB5: $${Math.max(5, data.minInvestmentUSDT).toFixed(2)} | Buget Bot: $${nextTargetSz.toFixed(2)}) pentru ${gridNum} grile la ${lever}x.`,
        });
      }
    } catch (err: any) {
      onNotify({ type: 'error', text: err.message });
    } finally {
      setIsCheckingMinInv(false);
    }
  };

  const getVariantProfileForOpp = (
    opp: NativeGridOpportunity,
    variantId?: GridRangeVariantId
  ): GridRangeVariantProfile => {
    const targetId: GridRangeVariantId =
      variantId || rowVariants[opp.instId] || opp.selectedVariant || defaultRangeVariant || 'BALANCED';
    if (opp.rangeVariants && opp.rangeVariants[targetId]) {
      return opp.rangeVariants[targetId];
    }
    const halfPct =
      opp.halfRangePct ??
      (opp.price > 0 ? parseFloat((((opp.maxPx - opp.minPx) / 2 / opp.price) * 100).toFixed(2)) : 1.25);
    return {
      id: targetId,
      label:
        targetId === 'CONSERVATIVE'
          ? 'Range conservator'
          : targetId === 'COMPACT'
          ? 'Range compact'
          : 'Range echilibrat',
      subtitle:
        targetId === 'CONSERVATIVE'
          ? 'Range larg • Mai puține execuții'
          : targetId === 'COMPACT'
          ? 'Risc de supra-tranzacționare • Verificare comisioane'
          : 'Varianta de testat • Mai multe oportunități',
      halfRangePct: halfPct,
      totalRangePct: parseFloat((halfPct * 2).toFixed(2)),
      minPx: opp.minPx,
      maxPx: opp.maxPx,
      gridNum: opp.gridNum,
      gridSpacingPct: opp.gridSpacingPct,
      lever: opp.lever,
      minInvestmentUSDT: opp.minInvestmentUSDT,
      recommendedInvestmentUSDT: opp.recommendedInvestmentUSDT,
      fitsMaxBudget: opp.fitsMaxBudget,
      estimatedGrossProfitPerGridPct: opp.estimatedGrossProfitPerGridPct,
      estimatedNetProfitPerGridPct: opp.estimatedNetProfitPerGridPct,
      estimatedDailyNetYieldPct: opp.estimatedDailyNetYieldPct,
      feeCheckPassed: opp.estimatedNetProfitPerGridPct >= minNetProfitPct,
      feeLoadPctOfStep:
        opp.estimatedGrossProfitPerGridPct > 0
          ? parseFloat(
              (
                ((opp.estimatedGrossProfitPerGridPct - opp.estimatedNetProfitPerGridPct) /
                  opp.estimatedGrossProfitPerGridPct) *
                100
              ).toFixed(1)
            )
          : 25,
    };
  };

  // Merge scanned opportunities with any manually analyzed contracts so manual selections never vanish
  const allOpportunities = useMemo(() => {
    const map = new Map<string, NativeGridOpportunity>();
    for (const o of opportunities) {
      map.set(o.instId, o);
    }
    for (const [k, v] of Object.entries(manualOppsMap) as [string, NativeGridOpportunity][]) {
      map.set(k, v);
    }
    return Array.from(map.values());
  }, [opportunities, manualOppsMap]);

  const fetchUniverseCatalog = async (force: boolean = false) => {
    setIsLoadingUniverse(true);
    try {
      const res = await fetch(`/api/bot/native-grid/universe${force ? '?force=1' : ''}`);
      const data = await res.json();
      if (data?.success && Array.isArray(data.items)) {
        setUniverseCatalog(data.items);
        if (!manualSelectedInstId && data.items.length > 0) {
          setManualSelectedInstId(data.items[0].instId);
        }
      }
    } catch {} finally {
      setIsLoadingUniverse(false);
    }
  };

  useEffect(() => {
    fetchUniverseCatalog(false);
  }, []);

  const filteredUniverseCatalog = useMemo(() => {
    const q = universeSearch.trim().toUpperCase();
    const list = universeCatalog.filter((item) => {
      if (
        onlyBudgetAccessibleLot &&
        item.estMinGridMargin5xUSD > effectiveMaxBudget
      ) {
        return false;
      }
      if (!q) return true;
      return (
        item.baseSymbol.includes(q) ||
        item.instId.toUpperCase().includes(q)
      );
    });

    list.sort((a, b) => {
      if (universeSortBy === 'RANGE_24H') {
        return b.range24hPct - a.range24hPct;
      }
      if (universeSortBy === 'VOLUME_24H') {
        return b.turnover24hUSDT - a.turnover24hUSDT;
      }
      if (universeSortBy === 'CHANGE_24H') {
        return Math.abs(b.priceChange24hPct) - Math.abs(a.priceChange24hPct);
      }
      if (universeSortBy === 'MIN_LOT') {
        return a.minLotNotionalUSD - b.minLotNotionalUSD;
      }
      return a.baseSymbol.localeCompare(b.baseSymbol);
    });
    return list;
  }, [universeCatalog, universeSearch, universeSortBy, onlyBudgetAccessibleLot, effectiveMaxBudget]);

  const handleLoadOpportunity = (
    opp: NativeGridOpportunity,
    variantOverride?: GridRangeVariantId,
    forceRamura1: boolean = false,
    scrollToBuilder: boolean = false
  ) => {
    const chosenVariantId =
      variantOverride || rowVariants[opp.instId] || opp.selectedVariant || defaultRangeVariant || 'BALANCED';
    const v = getVariantProfileForOpp(opp, chosenVariantId);
    const targetInvestUSDT = computeBotInvestmentUSDT(v.minInvestmentUSDT);
    setInstId(opp.instId);
    setManualSelectedInstId(opp.instId);
    setBuilderVariant(chosenVariantId);
    setDefaultRangeVariant(chosenVariantId);
    setRowVariants((prev) => ({ ...prev, [opp.instId]: chosenVariantId }));
    setMinPx(v.minPx);
    setMaxPx(v.maxPx);
    setGridNum(v.gridNum);
    setRunType(opp.runType);
    setLever(v.lever);
    setSz(targetInvestUSDT);
    setMinInvCheck({
      minInvestmentUSDT: v.minInvestmentUSDT,
      ccy: opp.minInvestmentCcy,
      singleAmt: 0,
    });
    if (scrollToBuilder && builderSectionRef.current) {
      builderSectionRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    onNotify({
      type: v.feeWarning ? 'error' : 'info',
      text: `${opp.instId} [${v.label} ±${v.halfRangePct.toFixed(2)}% • ${v.gridNum} grile • Distanță ${v.gridSpacingPct.toFixed(2)}% • Marjă: $${targetInvestUSDT.toFixed(2)} • Net +${v.estimatedNetProfitPerGridPct.toFixed(2)}%/grilă] preluat în RAMURA 1 (Builder Tab 1).${
        v.feeWarning ? ` ⚠ ${v.feeWarning}` : ''
      }`,
    });
  };

  const handleAnalyzeAndLoadSymbol = async (
    targetSymbol: string,
    variantOverride?: GridRangeVariantId,
    scrollToBuilder: boolean = false
  ) => {
    const cleanSym = (targetSymbol || manualSelectedInstId || instId || '').trim();
    if (!cleanSym) {
      onNotify({
        type: 'error',
        text: 'Selectează o monedă din universul OKX EEA (_UM_XPERP).',
      });
      return;
    }
    setIsCalculatingManual(true);
    setManualSelectedInstId(cleanSym);
    try {
      const chosenVar = variantOverride || builderVariant || defaultRangeVariant || 'BALANCED';
      const res = await fetch('/api/bot/native-grid/analyze-symbol', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          instId: cleanSym,
          maxBudgetPerBotUSDT: effectiveMaxBudget,
          maxLeverage: Number(lever) || Number(maxLeverage) || 5,
          runType,
          rangeVariant: chosenVar,
        }),
      });
      const data = await res.json();
      if (data?.success && data.opportunity) {
        const opp: NativeGridOpportunity = data.opportunity;
        setManualOppsMap((prev) => ({ ...prev, [opp.instId]: opp }));
        handleLoadOpportunity(opp, chosenVar, true, scrollToBuilder);
        onRefresh();
      } else {
        onNotify({
          type: 'error',
          text: data?.error || `Nu s-au putut calcula parametrii pentru ${cleanSym}.`,
        });
      }
    } catch (err: any) {
      onNotify({
        type: 'error',
        text: err.message || `Eroare la calcularea parametrilor pentru ${cleanSym}.`,
      });
    } finally {
      setIsCalculatingManual(false);
    }
  };

  useEffect(() => {
    if (externalSelectedSymbol?.instId) {
      if (externalSelectedSymbol.minPx && externalSelectedSymbol.maxPx) {
        setInstId(externalSelectedSymbol.instId);
        setManualSelectedInstId(externalSelectedSymbol.instId);
        setMinPx(externalSelectedSymbol.minPx);
        setMaxPx(externalSelectedSymbol.maxPx);
        if (externalSelectedSymbol.gridNum) setGridNum(externalSelectedSymbol.gridNum);
        if (externalSelectedSymbol.runType) setRunType(externalSelectedSymbol.runType);
        if (externalSelectedSymbol.lever) setLever(externalSelectedSymbol.lever);
        if (builderSectionRef.current) {
          builderSectionRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
        onNotify({
          type: 'success',
          text: `Parametrii din Historical Research au fost aplicați în RAMURA 1 pentru ${externalSelectedSymbol.instId} (${externalSelectedSymbol.minPx} - ${externalSelectedSymbol.maxPx}, ${externalSelectedSymbol.gridNum} grile).`,
        });
      } else {
        handleAnalyzeAndLoadSymbol(externalSelectedSymbol.instId, undefined, true);
      }
    }
  }, [externalSelectedSymbol?.ts]);

  const handleCreateNativeBot = async (overrideParams?: Partial<NativeGridOpportunity>) => {
    const targetInstId = overrideParams?.instId || instId;
    const targetMinPx = Number(overrideParams?.minPx ?? minPx) || 0;
    const targetMaxPx = Number(overrideParams?.maxPx ?? maxPx) || 0;
    const targetGridNum = Number(overrideParams?.gridNum ?? gridNum) || 10;
    const targetRunType = overrideParams?.runType || runType;
    const targetLever = Number(overrideParams?.lever ?? lever) || 3;
    const minReqSz = Math.max(
      5,
      Number(overrideParams?.minInvestmentUSDT ?? minInvCheck?.minInvestmentUSDT ?? 0) || 0
    );
    const rawRequestedSz =
      overrideParams?.recommendedInvestmentUSDT !== undefined
        ? computeBotInvestmentUSDT(overrideParams.minInvestmentUSDT)
        : Number(sz) || Number(maxBudgetPerBot) || 5;
    const targetSz = parseFloat(Math.max(5, minReqSz, rawRequestedSz).toFixed(2));
    if (!overrideParams) {
      setSz(targetSz);
    }
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
          stopTypeOnRisk: defaultStopType,
          stopOnRangeBreakout: stopOnBreakout,
          stopOnTrendInvalidation,
          environment: 'LIVE',
          explicitLiveConfirm: true,
          executionVariant: 'AUTO_LIMIT',
        }),
      });
      const data = await res.json();
      if (data.success && data.bot) {
        onNotify({
          type: 'success',
          text: `GRILĂ RAMURA 1 (ORDINE LIMIT OKX) LANSATĂ CU SUCCES: ${data.bot.instId} | ID: ${data.bot.algoId} | Investiție: $${data.bot.sz} @ ${data.bot.lever}x!`,
        });
        onRefresh();
      } else {
        onNotify({
          type: 'error',
          text: data.error || 'Eroare la lansarea grilei pe OKX.',
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
    const safeSz = parseFloat(
      Math.max(5, Number(b.sz) || 0, Number(maxBudgetPerBot) || 5).toFixed(2)
    );
    setInstId(b.instId);
    setMinPx(b.minPx);
    setMaxPx(b.maxPx);
    setGridNum(b.gridNum);
    setRunType(b.runType);
    setLever(b.lever);
    setSz(safeSz);
    setDefaultStopType(b.stopTypeOnRisk || '1');
    onNotify({
      type: 'info',
      text: `Parametrii botului ${b.instId} ($${b.minPx}–$${b.maxPx}, ${b.gridNum} grile, ${b.lever}x, $${safeSz}) au fost încărcați în Builderul din stânga.`,
    });
  };

  const handleRestartStoppedBot = async (b: OKXNativeGridBot) => {
    const safeSz = parseFloat(
      Math.max(5, Number(b.sz) || 0, Number(maxBudgetPerBot) || 5).toFixed(2)
    );
    await handleCreateNativeBot({
      instId: b.instId,
      minPx: b.minPx,
      maxPx: b.maxPx,
      gridNum: b.gridNum,
      runType: b.runType,
      lever: b.lever,
      minInvestmentUSDT: safeSz,
      recommendedInvestmentUSDT: safeSz,
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
  const evaluateOpportunityLive = (
    opp: NativeGridOpportunity,
    activeVar: GridRangeVariantProfile
  ): {
    isEligible: boolean;
    rejectionReason?: string;
    minOp: number;
    botBudget: number;
    fitsBudgetNow: boolean;
  } => {
    const minOp = parseFloat(Math.max(5, Number(activeVar.minInvestmentUSDT) || 0).toFixed(2));
    const botBudget = effectiveMaxBudget;
    const fitsBudgetNow = activeVar.minInvestmentUSDT > 0 && minOp <= botBudget;
    const reasons: string[] = [];

    if (activeVar.minInvestmentUSDT <= 0) {
      reasons.push('OKX min-investment indisponibil');
    } else if (!fitsBudgetNow) {
      reasons.push(
        `Investiție minimă ($${minOp.toFixed(2)}) > Buget Max ($${botBudget.toFixed(2)})`
      );
    }
    const feeOk =
      activeVar.feeCheckPassed &&
      activeVar.estimatedNetProfitPerGridPct >= effectiveMinNetProfit;
    if (!feeOk) {
      reasons.push(
        activeVar.feeWarning ||
          `Profit net/grilă (${activeVar.estimatedNetProfitPerGridPct.toFixed(2)}%) < min (${effectiveMinNetProfit.toFixed(2)}%)`
      );
    }
    if (opp.regimeLabel === 'TRENDING_RISK') {
      reasons.push('Piață în trend direcțional puternic (TRENDING_RISK)');
    }
    if (opp.suitabilityScore < effectiveMinScore) {
      reasons.push(`Scor (${opp.suitabilityScore}) sub pragul minim (${effectiveMinScore})`);
    }
    return {
      isEligible: reasons.length === 0,
      rejectionReason: reasons.length > 0 ? reasons.join(' | ') : undefined,
      minOp,
      botBudget,
      fitsBudgetNow,
    };
  };

  const eligibleOpportunities = opportunities.filter((o) => {
    const varId: GridRangeVariantId =
      rowVariants[o.instId] || o.selectedVariant || defaultRangeVariant || 'BALANCED';
    const vp = getVariantProfileForOpp(o, varId);
    return evaluateOpportunityLive(o, vp).isEligible;
  });

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
              COMANDĂ CENTRALĂ GRID OKX (_UM_XPERP) — ORDINE LIMIT OKX (100% AUTOMAT + AUTOPILOT):
            </span>
          </div>

          <button
            type="button"
            onClick={() => setShowInstructions(!showInstructions)}
            className="px-3 py-1.5 rounded bg-zinc-900 hover:bg-zinc-800 border border-amber-500/50 text-amber-300 font-black text-[11px] cursor-pointer"
          >
            {showInstructions
              ? '▲ Ascunde Instrucțiunile de Folosire'
              : '📖 Instrucțiuni de Folosire'}
          </button>
        </div>

        {showInstructions && (
          <div className="bg-black border border-zinc-800 rounded p-3 grid grid-cols-1 gap-3 text-[11px] leading-relaxed">
            <div className="p-2.5 rounded border border-emerald-500/60 bg-emerald-950/15">
              <div className="font-black text-emerald-400 text-xs mb-1">
                ⚡ CUM FUNCȚIONEAZĂ — EXECUȚIE 100% AUTOMATĂ (ORDINE LIMIT OKX)
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
                    <li>TB5 validează geometria local și plasează direct ordinele Limit ale grilei pe OKX EEA.</li>
                  </ol>
                </li>
                <li>
                  <strong>Unde îl vezi în platforma OKX:</strong> În taburile <strong>Positions + Open Orders (cele 8 ordine Limit)</strong>. În tabelul din dreapta are eticheta verde <code className="text-emerald-300">AUTO-LIMIT OKX</code>.
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
                onClick={() => setShowStagnationAnalyzer(!showStagnationAnalyzer)}
                className={`px-2.5 py-1 rounded text-[10px] font-bold cursor-pointer border flex items-center space-x-1 ${
                  showStagnationAnalyzer
                    ? 'bg-cyan-400 text-black border-cyan-200'
                    : 'bg-zinc-900 text-cyan-300 border-cyan-500/40 hover:bg-zinc-800'
                }`}
              >
                <Activity className="w-3 h-3" />
                <span>
                  {showStagnationAnalyzer ? '▲ Stagnare' : '▼ Stagnare'} (
                  {(gridAnalyzer?.botSnapshots || []).filter((s) => s.state === 'running').length})
                </span>
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
                      title={`${s.instId} (${s.algoId}): ${s.decisionReason}${
                        s.decisionCodes?.length ? ` [${s.decisionCodes.join(', ')}]` : ''
                      }`}
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
              {Object.keys(gridAnalyzer?.codeCounts || {}).length > 0 && (
                <div className="flex flex-wrap items-center gap-1 mt-1 pt-1 border-t border-zinc-800/70">
                  {Object.entries<number>(gridAnalyzer?.codeCounts || {}).map(([code, count]) => (
                    <span
                      key={code}
                      title={code}
                      className="px-1 py-0.5 rounded text-[8px] font-mono bg-zinc-900 text-zinc-400 border border-zinc-800"
                    >
                      {code}
                      {count > 1 ? ` x${count}` : ''}
                    </span>
                  ))}
                </div>
              )}
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

              {/* Stagnation Analyzer Configurable Thresholds (.data/grid_analyzer_thresholds.json) */}
              <div className="border-t border-zinc-800 pt-2">
                <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
                  <span className="text-[10px] font-black text-cyan-300">
                    PRAGURI STAGNATION ANALYZER (SEPARAT DE PROFITABILITATE &amp; RISC DIRECȚIONAL — PERSISTATE ÎN .data)
                  </span>
                  <label className="flex items-center space-x-1.5 text-[10px] text-amber-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={analyzerThresholds.enableEarlyStopOnMarketDeterioration ?? true}
                      onChange={(e) =>
                        setAnalyzerThresholds({
                          ...analyzerThresholds,
                          enableEarlyStopOnMarketDeterioration: e.target.checked,
                        })
                      }
                      className="accent-amber-400"
                    />
                    <span>STOP Anticipat (≥120m) la Stagnare + Deteriorare Piață</span>
                  </label>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2 text-xs">
                  <div className="bg-black border border-zinc-800 rounded p-2">
                    <span className="text-[10px] text-zinc-400 block">Fără Fill MONITOR (m)</span>
                    <input
                      type="number"
                      step="5"
                      value={analyzerThresholds.stagnationMonitorNoFillMinutes ?? 30}
                      onChange={(e) =>
                        setAnalyzerThresholds({
                          ...analyzerThresholds,
                          stagnationMonitorNoFillMinutes: parseFloat(e.target.value) || 30,
                        })
                      }
                      className="w-full bg-zinc-900 border border-cyan-500/40 rounded px-2 py-1 text-cyan-300 font-bold mt-0.5"
                    />
                  </div>
                  <div className="bg-black border border-zinc-800 rounded p-2">
                    <span className="text-[10px] text-zinc-400 block">Fără Fill WARN (m)</span>
                    <input
                      type="number"
                      step="5"
                      value={analyzerThresholds.stagnationWarningNoFillMinutes ?? 60}
                      onChange={(e) =>
                        setAnalyzerThresholds({
                          ...analyzerThresholds,
                          stagnationWarningNoFillMinutes: parseFloat(e.target.value) || 60,
                        })
                      }
                      className="w-full bg-zinc-900 border border-amber-500/40 rounded px-2 py-1 text-amber-300 font-bold mt-0.5"
                    />
                  </div>
                  <div className="bg-black border border-zinc-800 rounded p-2">
                    <span className="text-[10px] text-zinc-400 block">Reevaluare Spec. (m)</span>
                    <input
                      type="number"
                      step="10"
                      value={analyzerThresholds.stagnationReviewMinutes ?? 120}
                      onChange={(e) =>
                        setAnalyzerThresholds({
                          ...analyzerThresholds,
                          stagnationReviewMinutes: parseFloat(e.target.value) || 120,
                        })
                      }
                      className="w-full bg-zinc-900 border border-amber-500/40 rounded px-2 py-1 text-amber-300 font-bold mt-0.5"
                    />
                  </div>
                  <div className="bg-black border border-zinc-800 rounded p-2">
                    <span className="text-[10px] text-zinc-400 block">Stagnare STOP (m)</span>
                    <input
                      type="number"
                      step="15"
                      value={analyzerThresholds.stagnationStopMinutes ?? 180}
                      onChange={(e) =>
                        setAnalyzerThresholds({
                          ...analyzerThresholds,
                          stagnationStopMinutes: parseFloat(e.target.value) || 180,
                        })
                      }
                      className="w-full bg-zinc-900 border border-rose-500/40 rounded px-2 py-1 text-rose-300 font-bold mt-0.5"
                    />
                  </div>
                  <div className="bg-black border border-zinc-800 rounded p-2">
                    <span className="text-[10px] text-zinc-400 block">Progres Min PnL ($)</span>
                    <input
                      type="number"
                      step="0.001"
                      value={analyzerThresholds.minRealizedPnlProgressUSDT ?? 0.005}
                      onChange={(e) =>
                        setAnalyzerThresholds({
                          ...analyzerThresholds,
                          minRealizedPnlProgressUSDT: parseFloat(e.target.value) || 0.005,
                        })
                      }
                      className="w-full bg-zinc-900 border border-emerald-500/40 rounded px-2 py-1 text-emerald-300 font-bold mt-0.5"
                    />
                  </div>
                  <div className="bg-black border border-zinc-800 rounded p-2">
                    <span className="text-[10px] text-zinc-400 block">Randament Net/h (%)</span>
                    <input
                      type="number"
                      step="0.005"
                      value={analyzerThresholds.minProductiveHourlyYieldPct ?? 0.015}
                      onChange={(e) =>
                        setAnalyzerThresholds({
                          ...analyzerThresholds,
                          minProductiveHourlyYieldPct: parseFloat(e.target.value) || 0.015,
                        })
                      }
                      className="w-full bg-zinc-900 border border-emerald-500/40 rounded px-2 py-1 text-emerald-300 font-bold mt-0.5"
                    />
                  </div>
                  <div className="bg-black border border-zinc-800 rounded p-2">
                    <span className="text-[10px] text-zinc-400 block">Min Osc / Pas Grilă</span>
                    <input
                      type="number"
                      step="0.05"
                      value={analyzerThresholds.minOscillationToGridStepRatio ?? 0.85}
                      onChange={(e) =>
                        setAnalyzerThresholds({
                          ...analyzerThresholds,
                          minOscillationToGridStepRatio: parseFloat(e.target.value) || 0.85,
                        })
                      }
                      className="w-full bg-zinc-900 border border-cyan-500/40 rounded px-2 py-1 text-cyan-300 font-bold mt-0.5"
                    />
                  </div>
                  <div className="bg-black border border-zinc-800 rounded p-2">
                    <span className="text-[10px] text-zinc-400 block">Min Rulaj 120m (x)</span>
                    <input
                      type="number"
                      step="0.05"
                      value={analyzerThresholds.minCapitalTurnover120mRatio ?? 0.25}
                      onChange={(e) =>
                        setAnalyzerThresholds({
                          ...analyzerThresholds,
                          minCapitalTurnover120mRatio: parseFloat(e.target.value) || 0.25,
                        })
                      }
                      className="w-full bg-zinc-900 border border-cyan-500/40 rounded px-2 py-1 text-cyan-300 font-bold mt-0.5"
                    />
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Compact & Collapsible Stagnation & Capital Productivity Live Monitor (Active Bots Only) */}
          {(() => {
            const activeStagnationSnapshots = (gridAnalyzer?.botSnapshots || []).filter(
              (s) => s.state === 'running'
            );
            if (activeStagnationSnapshots.length === 0 && !showStagnationAnalyzer) {
              return null;
            }
            return (
              <div className="bg-zinc-950 border border-cyan-500/30 rounded px-2.5 py-1.5 space-y-1.5">
                <div
                  onClick={() => setShowStagnationAnalyzer(!showStagnationAnalyzer)}
                  className="flex flex-wrap items-center justify-between gap-2 cursor-pointer select-none"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[10px] font-black text-cyan-300">
                      STAGNATION &amp; CAPITAL PRODUCTIVITY ANALYZER (REEVALUARE 15M • SEPARAT DE FLOATING PNL &amp; RISC DIRECȚIONAL)
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    <span className="text-[9px] text-zinc-400 hidden xl:inline">
                      30m → MONITOR • 60m → WARNING • 120m → Reevaluare • 180m → STOP
                    </span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setShowStagnationAnalyzer(!showStagnationAnalyzer);
                      }}
                      className="px-2 py-0.5 rounded bg-zinc-900 hover:bg-zinc-800 border border-cyan-500/40 text-cyan-300 font-black text-[10px] cursor-pointer"
                    >
                      {showStagnationAnalyzer
                        ? '▲ Restrânge Tabel Stagnare'
                        : `▼ Extinde Tabel Stagnare (${activeStagnationSnapshots.length})`}
                    </button>
                  </div>
                </div>

                {showStagnationAnalyzer && (
                  <div className="overflow-x-auto border-t border-zinc-800 pt-1.5">
                    {activeStagnationSnapshots.length === 0 ? (
                      <div className="text-center py-3 text-[11px] text-zinc-400 font-bold">
                        Niciun bot activ în prezent.
                      </div>
                    ) : (
                      <table className="w-full text-left border-collapse text-[10px]">
                        <thead>
                          <tr className="border-b border-zinc-800 text-zinc-400">
                            <th className="py-1 px-2">Bot / Status</th>
                            <th className="py-1 px-2">Nivel Stagnare</th>
                            <th className="py-1 px-2">Minute fără Fill</th>
                            <th className="py-1 px-2">Ultima Închidere Grid</th>
                            <th className="py-1 px-2">Execuții (30m / 60m / 120m)</th>
                            <th className="py-1 px-2">PnL Realizat &amp; Net (după Fee/Fund)</th>
                            <th className="py-1 px-2">Evoluție PnL Realizat (Δ30m / Δ60m / Δ120m)</th>
                            <th className="py-1 px-2">Oscilație vs Pas Grilă</th>
                            <th className="py-1 px-2">Capital Blocat / Verdict Oportunitate</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-zinc-900">
                          {activeStagnationSnapshots.map((s) => {
                            const st = s.stagnation;
                            const levelBadge =
                              st?.level === 'STOP_180M' || st?.level === 'EARLY_STOP_MARKET'
                                ? 'bg-rose-600 text-white'
                                : st?.level === 'REVIEW_120M' || st?.level === 'WARNING_60M'
                                ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                                : st?.level === 'MONITOR_30M'
                                ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                                : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40';
                            return (
                              <tr key={s.algoId} className="hover:bg-zinc-900/60 tabular-nums">
                                <td className="py-1.5 px-2 whitespace-nowrap">
                                  <span className="font-bold text-white">{s.instId}</span>{' '}
                                  <span className="text-[9px] text-zinc-400">({s.state})</span>
                                </td>
                                <td className="py-1.5 px-2 whitespace-nowrap">
                                  <span className={`px-1.5 py-0.5 rounded font-black text-[9px] ${levelBadge}`}>
                                    {st?.level || 'ACTIVE'}
                                  </span>
                                </td>
                                <td className="py-1.5 px-2 whitespace-nowrap">
                                  <span
                                    className={`font-bold ${
                                      Number(st?.minutesSinceLastFill || 0) >=
                                      (analyzerThresholds.stagnationWarningNoFillMinutes ?? 60)
                                        ? 'text-amber-300'
                                        : 'text-zinc-200'
                                    }`}
                                  >
                                    {Number(st?.minutesSinceLastFill || 0).toFixed(1)} min
                                  </span>
                                  {st?.lastFillAt ? (
                                    <span className="text-[9px] text-zinc-500 block">
                                      {new Date(st.lastFillAt).toLocaleTimeString()}
                                    </span>
                                  ) : null}
                                </td>
                                <td className="py-1.5 px-2 whitespace-nowrap">
                                  <span
                                    className={`font-bold ${
                                      Number(st?.minutesSinceLastGridClose || 0) >=
                                      (analyzerThresholds.stagnationReviewMinutes ?? 120)
                                        ? 'text-rose-300'
                                        : 'text-zinc-200'
                                    }`}
                                  >
                                    {Number(st?.minutesSinceLastGridClose || 0).toFixed(1)} min
                                  </span>
                                  {st?.lastGridCycleCloseAt ? (
                                    <span className="text-[9px] text-zinc-500 block">
                                      {new Date(st.lastGridCycleCloseAt).toLocaleTimeString()}
                                    </span>
                                  ) : null}
                                </td>
                                <td className="py-1.5 px-2 whitespace-nowrap text-zinc-200">
                                  <div>
                                    Fills: <strong>{st?.fillsCount30m ?? 0}</strong> /{' '}
                                    <strong>{st?.fillsCount60m ?? 0}</strong> /{' '}
                                    <strong>{st?.fillsCount120m ?? 0}</strong>
                                  </div>
                                  <div className="text-[9px] text-zinc-400">
                                    Cicluri Grid: {st?.gridCyclesCount30m ?? 0} / {st?.gridCyclesCount60m ?? 0} /{' '}
                                    {st?.gridCyclesCount120m ?? 0} • Ordine active: {st?.activeOrdersCount ?? 0}
                                  </div>
                                </td>
                                <td className="py-1.5 px-2 whitespace-nowrap">
                                  <div className="text-emerald-400 font-bold">
                                    Realizat: ${Number(st?.realizedPnlUSDT ?? s.performance.gridProfitUSDT ?? 0).toFixed(3)}
                                  </div>
                                  <div className="text-[9px] text-zinc-400">
                                    Net realizat: $
                                    {Number(
                                      st?.netRealizedProfitAfterCostsUSDT ??
                                        s.performance.netProfitAfterCostsUSDT ??
                                        0
                                    ).toFixed(3)}{' '}
                                    | Float: ${Number(st?.floatPnlUSDT ?? s.performance.floatProfitUSDT ?? 0).toFixed(3)}
                                  </div>
                                </td>
                                <td className="py-1.5 px-2 whitespace-nowrap">
                                  <div className="text-zinc-200">
                                    Δ30m: ${Number(st?.realizedPnlDelta30mUSDT || 0).toFixed(4)} | Δ60m: $
                                    {Number(st?.realizedPnlDelta60mUSDT || 0).toFixed(4)}
                                  </div>
                                  <div className="text-[9px] text-zinc-400">
                                    Δ120m: ${Number(st?.realizedPnlDelta120mUSDT || 0).toFixed(4)} | Float Δ60m: $
                                    {Number(st?.floatPnlDelta60mUSDT || 0).toFixed(4)}
                                  </div>
                                </td>
                                <td className="py-1.5 px-2 whitespace-nowrap">
                                  <div
                                    className={`font-bold ${
                                      Number(st?.oscillationToGridStepRatio ?? 1) <
                                      (analyzerThresholds.minOscillationToGridStepRatio ?? 0.85)
                                        ? 'text-amber-300'
                                        : 'text-emerald-300'
                                    }`}
                                  >
                                    {Number(st?.oscillationToGridStepRatio ?? 1).toFixed(2)}x pas (
                                    {Number(st?.priceOscillationAmplitude60mPct || 0).toFixed(2)}% /{' '}
                                    {Number(st?.gridStepPct || 0).toFixed(2)}%)
                                  </div>
                                  <div className="text-[9px] text-zinc-400">
                                    Perspectivă: <strong>{st?.recoveryProspect || 'HIGH'}</strong> • Dist. ordin:{' '}
                                    {Number(st?.nearestOrderDistancePct || 0).toFixed(2)}%
                                  </div>
                                </td>
                                <td className="py-1.5 px-2 max-w-xs">
                                  <div className="text-amber-300 font-bold">
                                    ${Number(st?.lockedCapitalUSDT ?? s.risk.marginUsedUSDT ?? 0).toFixed(2)} blocat •
                                    Rulaj 120m: {Number(st?.capitalTurnover120mRatio || 0).toFixed(2)}x (Scor{' '}
                                    {st?.capitalEfficiencyScore ?? 70}/100)
                                  </div>
                                  <div
                                    className="text-[9px] text-zinc-300 truncate"
                                    title={st?.continueOpportunityVerdict}
                                  >
                                    {st?.continueOpportunityVerdict || 'Activitate normală'}
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    )}
                  </div>
                )}
              </div>
            );
          })()}

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
                      {gridAnalyzer.stopEvents.map((ev) => {
                        const httpStatus =
                          ev.stopHttpStatus ||
                          (ev.stopResult === 'FAILED' ? 'FAILED' : 'HTTP_SUCCESS');
                        const stopStateLabel =
                          ev.stopResult === 'CONFIRMED_STOPPED' || ev.okxFinalStateConfirmed
                            ? 'CONFIRMED_STOPPED'
                            : ev.stopResult === 'FAILED'
                            ? 'FAILED'
                            : 'STOP_PENDING_CONFIRMATION';
                        const closePosLabel =
                          ev.closePositionResult === 'CLOSE_POSITION_CONFIRMED' ||
                          (ev.okxFinalStateConfirmed && ev.stopType !== '2')
                            ? 'CLOSE_POSITION_CONFIRMED'
                            : ev.closePositionResult === 'NOT_REQUESTED' || ev.stopType === '2'
                            ? 'NOT_REQUESTED (stopType=2)'
                            : ev.closePositionResult === 'FAILED'
                            ? 'FAILED'
                            : 'STOP_PENDING_CONFIRMATION';
                        return (
                          <tr key={ev.idempotencyKey} className="hover:bg-zinc-900/60">
                            <td className="py-1.5 px-2 tabular-nums text-zinc-300 whitespace-nowrap">
                              {new Date(ev.timestamp).toLocaleString()}
                            </td>
                            <td className="py-1.5 px-2 whitespace-nowrap">
                              <span className="font-bold text-white">{ev.instId}</span>{' '}
                              <span className="font-mono text-[9px] text-cyan-400">
                                [algoId:{ev.algoId}]
                              </span>
                            </td>
                            <td className="py-1.5 px-2 whitespace-nowrap">
                              <span
                                className={`px-1.5 py-0.5 rounded font-black ${
                                  ev.executedDecision === 'EMERGENCY'
                                    ? 'bg-rose-600 text-white'
                                    : ev.executedDecision === 'STOP'
                                    ? 'bg-amber-500 text-black'
                                    : 'bg-zinc-800 text-rose-300'
                                }`}
                              >
                                {ev.executedDecision} | stopType=
                                {ev.stopType === '2' ? '2 (Păstrează Poz.)' : '1 (Închide Poz.)'}
                              </span>
                            </td>
                            <td className="py-1.5 px-2 text-rose-300 max-w-xs">
                              {ev.exactStopReason}
                              {ev.decisionCodes?.length ? (
                                <div className="mt-0.5 font-mono text-[9px] text-zinc-400">
                                  [{ev.decisionCodes.join(', ')}]
                                </div>
                              ) : null}
                            </td>
                            <td className="py-1.5 px-2 tabular-nums text-zinc-300 whitespace-nowrap">
                              ADX: {Number(ev.triggeringIndicators?.adx || 0).toFixed(1)} | Chop:{' '}
                              {Number(ev.triggeringIndicators?.choppinessIndex || 0).toFixed(1)} | ATR
                              Δ: {Number(ev.triggeringIndicators?.atrChangePct || 0).toFixed(1)}%
                            </td>
                            <td className="py-1.5 px-2 tabular-nums whitespace-nowrap">
                              G: ${Number(ev.pnlBreakdown?.gridProfitUSDT || 0).toFixed(2)} | F: $
                              {Number(ev.pnlBreakdown?.floatProfitUSDT || 0).toFixed(2)} | T: $
                              {Number(ev.pnlBreakdown?.totalPnlUSDT || 0).toFixed(2)}
                            </td>
                            <td className="py-1.5 px-2 tabular-nums text-rose-300 whitespace-nowrap">
                              DD: {Number(ev.riskMetrics?.drawdownPct || 0).toFixed(2)}% | Liq:{' '}
                              {ev.riskMetrics?.distToLiqPct !== undefined
                                ? `${Number(ev.riskMetrics.distToLiqPct).toFixed(1)}%`
                                : 'N/A'}
                            </td>
                            <td className="py-1.5 px-2 whitespace-nowrap">
                              <div className="flex flex-col gap-0.5">
                                <span
                                  className={
                                    httpStatus === 'HTTP_SUCCESS'
                                      ? 'text-cyan-300 font-mono text-[9px]'
                                      : 'text-rose-400 font-bold text-[9px]'
                                  }
                                >
                                  API: {httpStatus}
                                </span>
                                <span
                                  className={
                                    stopStateLabel === 'CONFIRMED_STOPPED'
                                      ? 'text-emerald-400 font-bold'
                                      : stopStateLabel === 'FAILED'
                                      ? 'text-rose-400 font-bold'
                                      : 'text-amber-300 font-bold'
                                  }
                                >
                                  Bot: {stopStateLabel} ({ev.okxConfirmedState})
                                </span>
                                <span
                                  className={
                                    closePosLabel === 'CLOSE_POSITION_CONFIRMED'
                                      ? 'text-emerald-300 font-semibold'
                                      : closePosLabel === 'FAILED'
                                      ? 'text-rose-400 font-bold'
                                      : 'text-amber-200'
                                  }
                                >
                                  Pos: {closePosLabel}
                                </span>
                              </div>
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
        </div>

        {/* Unified Autopilot, Capital, Risk & Range Profile Bar (Single Source of Truth) */}
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
          <div className="bg-black border border-zinc-800 rounded p-2">
            <span className="text-[10px] text-zinc-400 block" title="Bugetul standard alocat fiecărui bot (Autopilot & Builder)">
              Buget / Bot ($, min $5)
            </span>
            <input
              type="number"
              min={5}
              step="1"
              value={maxBudgetPerBot}
              onChange={(e) => {
                const rawVal = e.target.value;
                if (rawVal === '') {
                  setMaxBudgetPerBot('' as any);
                  return;
                }
                const parsed = parseFloat(rawVal);
                setMaxBudgetPerBot(parsed);
                if (Number.isFinite(parsed) && parsed >= 5) {
                  setSz(
                    parseFloat(
                      Math.max(5, parsed, minInvCheck?.minInvestmentUSDT || 0).toFixed(2)
                    )
                  );
                }
              }}
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
              max={20}
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
            <span className="text-[10px] text-zinc-400 block">Levier Implicit / Max</span>
            <select
              value={maxLeverage}
              onChange={(e) => {
                const nextLev = parseInt(e.target.value, 10) || 3;
                setMaxLeverage(nextLev);
                setLever(nextLev);
              }}
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
            <span className="text-[10px] text-zinc-400 block" title="Stop Loss % și Take Profit % din marjă (aplicat atât în Autopilot cât și în Builder)">
              SL % / TP % Bot
            </span>
            <div className="grid grid-cols-2 gap-1 mt-0.5">
              <input
                type="number"
                step="0.5"
                min={0.5}
                value={stopLossPct}
                onChange={(e) =>
                  setStopLossPct(e.target.value === '' ? ('' as any) : parseFloat(e.target.value))
                }
                className="w-full bg-zinc-900 border border-rose-500/40 rounded px-1.5 py-1 text-rose-300 font-bold"
                title="Stop Loss % din Marjă"
              />
              <input
                type="number"
                step="0.5"
                min={0.5}
                value={takeProfitPct}
                onChange={(e) =>
                  setTakeProfitPct(e.target.value === '' ? ('' as any) : parseFloat(e.target.value))
                }
                className="w-full bg-zinc-900 border border-emerald-500/40 rounded px-1.5 py-1 text-emerald-300 font-bold"
                title="Take Profit % din Marjă"
              />
            </div>
          </div>
          <div className="bg-black border border-zinc-800 rounded p-2">
            <span className="text-[10px] text-zinc-400 block" title="Comportamentul la oprire pentru toți boții (Autopilot & Lansare Manuală)">
              Mod Oprire Risc OKX
            </span>
            <select
              value={defaultStopType}
              onChange={(e) => setDefaultStopType(e.target.value === '2' ? '2' : '1')}
              className="w-full bg-zinc-900 border border-cyan-500/40 rounded px-1.5 py-1 text-cyan-300 font-bold mt-0.5"
            >
              <option value="1">stopType 1: Închide Poziția</option>
              <option value="2">stopType 2: Păstrează Poziția</option>
            </select>
          </div>
          <div className="bg-black border border-cyan-500/40 rounded p-2 col-span-2 md:col-span-2">
            <span className="text-[10px] text-cyan-300 font-bold block">
              Profil Range TB5 (Autopilot &amp; Builder)
            </span>
            <select
              value={defaultRangeVariant}
              onChange={(e) => {
                const nextVar = (e.target.value as GridRangeVariantId) || 'BALANCED';
                setDefaultRangeVariant(nextVar);
                setBuilderVariant(nextVar);
                const currentOpp = allOpportunities.find((o) => o.instId === instId);
                if (currentOpp) {
                  handleLoadOpportunity(currentOpp, nextVar);
                }
              }}
              className="w-full bg-zinc-900 border border-cyan-500/50 rounded px-1.5 py-1 text-cyan-200 font-bold mt-0.5"
            >
              <option value="CONSERVATIVE">
                1. Range conservator (±2.05% • 4 grile • Dist ~1.0%)
              </option>
              <option value="BALANCED">
                2. Range echilibrat (±1.25% • 6–8 grile • Dist ~0.35–0.42%) ★ Recomandat
              </option>
              <option value="COMPACT">
                3. Range compact (±0.75% • 8–10 grile • Dist ~0.15–0.19% • Verificare Fee)
              </option>
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
      {/* 1.5. MODUL MANUAL COMPLET — ALEGERE DIN TOT UNIVERSUL (257 MONEDE) */}
      {/* ================================================================= */}
      <div className="bg-zinc-950 border-2 border-fuchsia-500/50 rounded p-3 space-y-2.5 shadow-lg">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-fuchsia-500/30 pb-2">
          <div className="flex items-center space-x-2">
            <Zap className="w-4 h-4 text-fuchsia-400" />
            <div>
              <h3 className="font-black text-xs text-fuchsia-300 tracking-wide">
                🎯 MODUL MANUAL — ALEGERE &amp; CALCUL PARAMETRI DIN TOT UNIVERSUL OKX EEA (
                {universeCatalog.length || 257} MONEDE • INDIFERENT DE SCOR)
              </h3>
              <p className="text-[10px] text-zinc-400">
                Alege orice monedă din cele {universeCatalog.length || 257} contracte{' '}
                <code className="text-fuchsia-300">_UM_XPERP</code>. Aplicația îi calculează pe loc
                ATR 15m, cele 3 variante de Range, SL/TP și Min-Investment OKX, apoi încarcă automat
                valorile în <strong>Ramura 1 (Ordine Limit OKX)</strong> — chiar dacă scorul este sub
                pragul Autopilot.
              </p>
            </div>
          </div>

          <div className="flex items-center space-x-2">
            <button
              type="button"
              onClick={() => fetchUniverseCatalog(true)}
              disabled={isLoadingUniverse}
              className="px-2.5 py-1 rounded bg-zinc-900 hover:bg-zinc-800 border border-fuchsia-500/40 text-fuchsia-300 text-[10px] font-bold flex items-center space-x-1 cursor-pointer"
            >
              <RefreshCw className={`w-3 h-3 ${isLoadingUniverse ? 'animate-spin' : ''}`} />
              <span>
                {isLoadingUniverse
                  ? 'Se încarcă universul...'
                  : `Actualizează Univers (${universeCatalog.length})`}
              </span>
            </button>
            <button
              type="button"
              onClick={() => setShowManualUniverseModule((v) => !v)}
              className="px-2.5 py-1 rounded bg-fuchsia-500/20 hover:bg-fuchsia-500/30 border border-fuchsia-500/50 text-fuchsia-200 text-[10px] font-black cursor-pointer"
            >
              {showManualUniverseModule ? 'Ascunde Modul Manual ▲' : 'Deschide Modul Manual ▼'}
            </button>
          </div>
        </div>

        {showManualUniverseModule && (
          <div className="space-y-2.5">
            {/* RAND 1: CAUTARE, SORTARE, FILTRU LOT SI SELECTOR RAPID + BUTON CALCUL */}
            <div className="grid grid-cols-1 md:grid-cols-12 gap-2 items-end bg-black/70 border border-zinc-800 rounded p-2.5">
              <div className="md:col-span-3">
                <label className="text-[10px] text-zinc-400 block mb-0.5 font-bold">
                  1. Caută Monedă (ex: PEPE, SOL, DOGE, SUI, HYPE, WIF)
                </label>
                <input
                  type="text"
                  value={universeSearch}
                  onChange={(e) => setUniverseSearch(e.target.value)}
                  placeholder="Scrie simbolul monedei..."
                  className="w-full bg-zinc-900 border border-fuchsia-500/50 rounded px-2.5 py-1.5 text-white font-bold text-xs placeholder:text-zinc-500"
                />
              </div>

              <div className="md:col-span-2">
                <label className="text-[10px] text-zinc-400 block mb-0.5 font-bold">
                  Sortare Univers ({filteredUniverseCatalog.length} monede)
                </label>
                <select
                  value={universeSortBy}
                  onChange={(e) => setUniverseSortBy(e.target.value as any)}
                  className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-zinc-200 font-bold text-xs"
                >
                  <option value="RANGE_24H">Volatilitate / Range 24h % ↓</option>
                  <option value="VOLUME_24H">Volum 24h (Lichiditate ↓)</option>
                  <option value="CHANGE_24H">Mișcare 24h (|Δ%| ↓)</option>
                  <option value="MIN_LOT">Lot Minim OKX ($ Accesibil ↑)</option>
                  <option value="ALPHA">Alfabetic (A → Z)</option>
                </select>
              </div>

              <div className="md:col-span-4">
                <div className="flex items-center justify-between mb-0.5">
                  <label className="text-[10px] text-fuchsia-300 font-bold">
                    2. Alege Moneda din Lista Completă ({filteredUniverseCatalog.length} din{' '}
                    {universeCatalog.length})
                  </label>
                  <label className="flex items-center space-x-1 text-[9px] text-emerald-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={onlyBudgetAccessibleLot}
                      onChange={(e) => setOnlyBudgetAccessibleLot(e.target.checked)}
                      className="accent-emerald-400"
                    />
                    <span>
                      Doar încadrabile în Buget (${Number(effectiveMaxBudget || 25).toFixed(0)})
                    </span>
                  </label>
                </div>
                <select
                  value={manualSelectedInstId || instId}
                  onChange={(e) => {
                    const chosen = e.target.value;
                    setManualSelectedInstId(chosen);
                    if (chosen) {
                      handleAnalyzeAndLoadSymbol(chosen, builderVariant, false);
                    }
                  }}
                  className="w-full bg-zinc-900 border border-fuchsia-500/60 rounded px-2.5 py-1.5 text-amber-300 font-black text-xs"
                >
                  {filteredUniverseCatalog.map((c) => {
                    const analyzed = allOpportunities.find((o) => o.instId === c.instId);
                    const estMinVal = Number(
                      analyzed?.minInvestmentUSDT ?? c.estMinGridMargin5xUSD ?? 5
                    );
                    return (
                      <option key={c.instId} value={c.instId}>
                        {c.baseSymbol} ({c.instId}) — ${formatPrice(c.lastPrice)} | Range 24h:{' '}
                        {Number(c.range24hPct || 0).toFixed(1)}% | Vol: $
                        {(Number(c.turnover24hUSDT || 0) / 1000).toFixed(0)}K | Min ~$
                        {estMinVal.toFixed(1)}
                        {analyzed ? ` ★ [Scor ${analyzed.suitabilityScore}]` : ''}
                      </option>
                    );
                  })}
                </select>
              </div>

              <div className="md:col-span-3 flex items-center space-x-1.5">
                <button
                  type="button"
                  onClick={() =>
                    handleAnalyzeAndLoadSymbol(
                      manualSelectedInstId || instId,
                      builderVariant,
                      true
                    )
                  }
                  disabled={isCalculatingManual || !(manualSelectedInstId || instId)}
                  className="w-full py-2 px-3 rounded bg-fuchsia-500 hover:bg-fuchsia-400 disabled:opacity-50 text-black font-black text-xs flex items-center justify-center space-x-1.5 cursor-pointer shadow-md"
                >
                  <Zap className={`w-4 h-4 ${isCalculatingManual ? 'animate-spin' : ''}`} />
                  <span>
                    {isCalculatingManual
                      ? 'Se calculează pe OKX...'
                      : '⚡ Calculează & Preia în Ramura 1'}
                  </span>
                </button>
              </div>
            </div>

            {/* RAND 2: CHIPS / BUTOANE RAPIDE CU MONEDELE FILTRATE (PRIMELE 36 DIN CAUTARE) */}
            <div className="bg-black/50 border border-zinc-900 rounded p-2">
              <div className="flex items-center justify-between text-[10px] text-zinc-400 mb-1.5">
                <span>
                  Click direct pe orice monedă pentru <strong>calcul instant al parametrilor</strong>{' '}
                  și preluare automată în <strong>Ramura 1 (Ordine Limit OKX)</strong>:
                </span>
                <span className="text-fuchsia-300 font-bold">
                  Afișate: {Math.min(36, filteredUniverseCatalog.length)} /{' '}
                  {filteredUniverseCatalog.length} contracte
                </span>
              </div>
              <div className="grid grid-cols-3 sm:grid-cols-6 md:grid-cols-9 lg:grid-cols-12 gap-1.5 max-h-44 overflow-y-auto pr-1">
                {filteredUniverseCatalog.slice(0, 36).map((c) => {
                  const isCurrent = (manualSelectedInstId || instId) === c.instId;
                  const analyzed = allOpportunities.find((o) => o.instId === c.instId);
                  const estMin = Number(
                    analyzed?.minInvestmentUSDT ?? c.estMinGridMargin5xUSD ?? 5
                  );
                  const fitsUserBudget = estMin <= effectiveMaxBudget;
                  const chg24h = Number(c.priceChange24hPct || 0);
                  const rng24h = Number(c.range24hPct || 0);
                  return (
                    <button
                      key={c.instId}
                      type="button"
                      onClick={() => handleAnalyzeAndLoadSymbol(c.instId, builderVariant, false)}
                      disabled={isCalculatingManual}
                      className={`p-1.5 rounded border text-left transition cursor-pointer ${
                        isCurrent
                          ? 'bg-fuchsia-950/80 border-fuchsia-400 text-white ring-1 ring-fuchsia-400'
                          : fitsUserBudget
                          ? 'bg-zinc-900/80 hover:bg-zinc-800 border-zinc-800 text-zinc-200'
                          : 'bg-zinc-950/70 hover:bg-zinc-900 border-rose-900/40 text-zinc-400'
                      }`}
                      title={`${c.instId} | Preț: $${c.lastPrice} | Range 24h: ${rng24h}% | Vol 24h: $${Math.round(Number(c.turnover24hUSDT || 0)).toLocaleString()} | Lot Min 1x: $${c.minLotNotionalUSD} | Est Min Grilă: $${estMin.toFixed(2)}`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-black text-[10px] text-amber-300 truncate">
                          {c.baseSymbol}
                        </span>
                        <span
                          className={`text-[8px] font-bold px-1 rounded ${
                            chg24h >= 0
                              ? 'bg-emerald-500/15 text-emerald-300'
                              : 'bg-rose-500/15 text-rose-300'
                          }`}
                        >
                          {chg24h >= 0 ? '+' : ''}
                          {chg24h.toFixed(1)}%
                        </span>
                      </div>
                      <div className="text-[9px] text-zinc-300 font-mono truncate">
                        ${formatPrice(c.lastPrice)}
                      </div>
                      <div className="flex items-center justify-between text-[8px] text-zinc-400 mt-0.5">
                        <span>R:{rng24h.toFixed(1)}%</span>
                        <span className={fitsUserBudget ? 'text-emerald-400' : 'text-rose-400'}>
                          ~${estMin.toFixed(0)}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* RAND 3: REZULTATUL CALCULULUI PENTRU MONEDA SELECTATA MANUAL */}
            {(() => {
              const targetId = manualSelectedInstId || instId;
              const calcOpp = allOpportunities.find((o) => o.instId === targetId);
              if (!calcOpp) return null;
              const activeVar =
                calcOpp.rangeVariants?.[builderVariant] ||
                calcOpp.rangeVariants?.[calcOpp.selectedVariant || 'BALANCED'];
              const minInvVal = Number(
                activeVar?.minInvestmentUSDT ?? calcOpp.minInvestmentUSDT ?? 5
              );
              return (
                <div className="bg-fuchsia-950/20 border border-fuchsia-500/40 rounded p-2.5 flex flex-wrap items-center justify-between gap-2 text-[11px]">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="px-2 py-0.5 rounded bg-fuchsia-500 text-black font-black text-[10px]">
                      PARAMETRI CALCULAȚI LIVE
                    </span>
                    <strong className="text-white font-mono text-xs">{calcOpp.instId}</strong>
                    <span className="text-amber-300 font-bold">
                      Preț: ${formatPrice(calcOpp.price)}
                    </span>
                    <span className="text-zinc-400">|</span>
                    <span className="text-cyan-300">
                      Scor Piață: <strong>{calcOpp.suitabilityScore}/100</strong> (
                      {calcOpp.regimeLabel})
                    </span>
                    <span className="text-zinc-400">|</span>
                    <span className="text-zinc-300">
                      ATR 15m: <strong>{Number(calcOpp.atrPct || 0).toFixed(2)}%</strong> • Chop:{' '}
                      <strong>{Number(calcOpp.choppinessIndex || 0).toFixed(1)}</strong> • ADX:{' '}
                      <strong>{Number(calcOpp.adxTrendStrength || 0).toFixed(1)}</strong>
                    </span>
                    <span className="text-zinc-400">|</span>
                    <span className="text-emerald-300 font-bold">
                      Range [{builderVariant}]: ${formatPrice(activeVar?.minPx ?? calcOpp.minPx)} – $
                      {formatPrice(activeVar?.maxPx ?? calcOpp.maxPx)} (
                      {activeVar?.gridNum ?? calcOpp.gridNum} grile @ {calcOpp.lever}x)
                    </span>
                    <span className="text-zinc-400">|</span>
                    <span className="text-amber-300 font-bold">
                      Min-Inv OKX: ${minInvVal.toFixed(2)} USD
                    </span>
                  </div>

                  <div className="flex items-center space-x-2">
                    <button
                      type="button"
                      onClick={() => handleLoadOpportunity(calcOpp, builderVariant, true, true)}
                      className="px-3 py-1 rounded bg-emerald-500 hover:bg-emerald-400 text-black font-black text-[11px] cursor-pointer shadow"
                    >
                      ✓ Valori Preluate în Ramura 1 (Mergi la Lansare ↓)
                    </button>
                  </div>
                </div>
              );
            })()}
          </div>
        )}
      </div>

      {/* ================================================================= */}
      {/* 2. MAIN WORKSPACE: MANUAL BUILDER (4 COLS) + ACTIVE BOTS (8 COLS)  */}
      {/* ================================================================= */}
      <div
        ref={builderSectionRef}
        className="grid grid-cols-1 lg:grid-cols-12 gap-3 items-start"
      >
        {/* LEFT 4 COLS: BUILDER PENTRU GRILA CU ORDINE LIMIT (execuție proprie, fără algo la bursă) */}
        <div className="lg:col-span-4 bg-zinc-950 border border-amber-500/40 rounded p-3 space-y-2.5">
          <div className="flex items-center justify-between border-b border-amber-500/30 pb-2">
            <div className="flex items-center space-x-1.5">
              <Settings className="w-4 h-4 text-amber-400" />
              <h3 className="font-bold text-xs text-amber-400">
                ⚡ LANSARE GRILĂ ORDINE LIMIT OKX
              </h3>
            </div>
            <span className="px-2 py-0.5 rounded text-[10px] font-black bg-rose-600 text-white">
              LIVE OKX
            </span>
          </div>

          <div className="space-y-2">
            <div>
              <div className="flex items-center justify-between mb-0.5">
                <label className="text-[10px] text-zinc-400 block">
                  Instrument OKX EEA (Toate cele {universeCatalog.length || 257} contracte _UM_XPERP)
                </label>
                <button
                  type="button"
                  onClick={() => {
                    const found = allOpportunities.find((o) => o.instId === instId);
                    if (found) {
                      handleLoadOpportunity(found, builderVariant, true);
                    } else {
                      handleAnalyzeAndLoadSymbol(instId, builderVariant, false);
                    }
                  }}
                  disabled={isCalculatingManual}
                  className="text-[10px] text-cyan-300 hover:text-cyan-200 font-bold cursor-pointer"
                >
                  {isCalculatingManual ? 'Se calculează...' : '⚡ Recalculează Parametri Live'}
                </button>
              </div>
              <select
                value={instId}
                onChange={(e) => {
                  const next = e.target.value;
                  setInstId(next);
                  setManualSelectedInstId(next);
                  const found = allOpportunities.find((o) => o.instId === next);
                  if (found) {
                    handleLoadOpportunity(found, builderVariant, true);
                  } else {
                    handleAnalyzeAndLoadSymbol(next, builderVariant, false);
                  }
                }}
                className="w-full bg-black border border-amber-500/50 rounded px-2.5 py-1.5 text-white font-bold"
              >
                <optgroup
                  label={`★ Monede cu Parametri Calculați (${allOpportunities.length})`}
                >
                  {allOpportunities.map((o) => (
                    <option key={o.instId} value={o.instId}>
                      {o.instId} — ${formatPrice(o.price)} (Scor: {o.suitabilityScore} | Min-Inv: $
                      {Number(o.minInvestmentUSDT || 0).toFixed(2)})
                    </option>
                  ))}
                </optgroup>
                {universeCatalog.length > 0 && (
                  <optgroup
                    label={`🌐 Tot Universul OKX EEA (${universeCatalog.length} contracte — Calculează automat la selectare)`}
                  >
                    {universeCatalog
                      .filter((c) => !allOpportunities.some((o) => o.instId === c.instId))
                      .map((c) => (
                        <option key={c.instId} value={c.instId}>
                          {c.instId} — ${formatPrice(c.lastPrice)} (Range 24h:{' '}
                          {Number(c.range24hPct || 0).toFixed(1)}% | Est Min: $
                          {Number(c.estMinGridMargin5xUSD || 5).toFixed(2)})
                        </option>
                      ))}
                  </optgroup>
                )}
                {!allOpportunities.some((o) => o.instId === instId) &&
                  !universeCatalog.some((c) => c.instId === instId) && (
                    <option value={instId}>{instId}</option>
                  )}
              </select>
            </div>

            {/* TB5 3-VARIANT RANGE SELECTOR FOR CURRENT CONTRACT */}
            {(() => {
              const currentOpp = allOpportunities.find((o) => o.instId === instId);
              if (currentOpp?.rangeVariants) {
                const variantOrder: GridRangeVariantId[] = ['CONSERVATIVE', 'BALANCED', 'COMPACT'];
                return (
                  <div className="bg-black/80 border border-cyan-500/30 rounded p-2 space-y-1.5">
                    <div className="flex items-center justify-between text-[10px]">
                      <span className="text-cyan-300 font-black">
                        TB5 — 3 VARIANTE RANGE CALCULATE ({currentOpp.instId}):
                      </span>
                      <span className="text-zinc-400">
                        ATR 15m: {currentOpp.atrPct.toFixed(2)}%
                      </span>
                    </div>
                    <div className="grid grid-cols-3 gap-1.5">
                      {variantOrder.map((vId) => {
                        const vp = currentOpp.rangeVariants![vId];
                        const isSelected = builderVariant === vId;
                        return (
                          <button
                            key={vId}
                            type="button"
                            onClick={() => handleLoadOpportunity(currentOpp, vId)}
                            className={`text-left p-1.5 rounded border transition cursor-pointer ${
                              isSelected
                                ? vId === 'BALANCED'
                                  ? 'bg-emerald-950/60 border-emerald-400 text-white'
                                  : vId === 'COMPACT'
                                  ? 'bg-amber-950/60 border-amber-400 text-white'
                                  : 'bg-cyan-950/60 border-cyan-400 text-white'
                                : 'bg-zinc-900/70 hover:bg-zinc-900 border-zinc-800 text-zinc-300'
                            }`}
                          >
                            <div className="flex items-center justify-between">
                              <span className="text-[10px] font-black leading-tight">
                                {vId === 'CONSERVATIVE'
                                  ? 'Conservator'
                                  : vId === 'BALANCED'
                                  ? 'Echilibrat ★'
                                  : 'Compact'}
                              </span>
                              <span
                                className={`text-[9px] font-black px-1 rounded ${
                                  vp.feeCheckPassed
                                    ? 'bg-emerald-500/20 text-emerald-300'
                                    : 'bg-rose-500/20 text-rose-300'
                                }`}
                              >
                                ±{vp.halfRangePct.toFixed(2)}%
                              </span>
                            </div>
                            <div className="text-[10px] font-bold text-amber-300 mt-0.5">
                              {vp.gridNum} grile • Dist {vp.gridSpacingPct.toFixed(2)}%
                            </div>
                            <div className="text-[9px] text-zinc-400">
                              Net:{' '}
                              <strong
                                className={
                                  vp.feeCheckPassed ? 'text-emerald-300' : 'text-rose-400'
                                }
                              >
                                +{vp.estimatedNetProfitPerGridPct.toFixed(2)}%
                              </strong>{' '}
                              • Min ${vp.minInvestmentUSDT.toFixed(1)}
                            </div>
                            {vp.feeWarning ? (
                              <div
                                className="text-[8px] text-rose-400 leading-tight mt-0.5 truncate"
                                title={vp.feeWarning}
                              >
                                ⚠ Comisioane {vp.feeLoadPctOfStep}% din pas
                              </div>
                            ) : (
                              <div className="text-[8px] text-zinc-500 leading-tight mt-0.5 truncate">
                                {vId === 'CONSERVATIVE'
                                  ? 'Mai puține execuții'
                                  : vId === 'BALANCED'
                                  ? 'Mai multe oportunități'
                                  : 'Fee OK (Verificat)'}
                              </div>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              }
              return null;
            })()}

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
                  Levier Bot (lever)
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

            {/* UNIFIED MARGIN ALLOCATION & OKX MIN-INVESTMENT BOX */}
            {(() => {
              const currentOpp = allOpportunities.find((o) => o.instId === instId);
              const rawOkxMin =
                minInvCheck?.minInvestmentUSDT || currentOpp?.minInvestmentUSDT || 0;
              const ccyLabel = minInvCheck?.ccy || currentOpp?.minInvestmentCcy || 'USD';
              const minOperational = Math.max(5, rawOkxMin);
              const budgetTarget = computeBotInvestmentUSDT(rawOkxMin);
              const currentSzVal = Math.max(5, Number(sz) || budgetTarget);
              const fitsBudget = minOperational <= effectiveMaxBudget;
              return (
                <div className="bg-black border border-emerald-500/40 rounded p-2.5 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <label className="text-[10px] font-black text-emerald-300">
                      💰 MARJĂ INVESTITĂ ÎN BOT ({instId.split('-')[0]}) &amp; PRAG MINIM OKX
                    </label>
                    <button
                      type="button"
                      onClick={handleCheckMinInvestment}
                      disabled={isCheckingMinInv}
                      className="px-2 py-0.5 rounded bg-zinc-900 hover:bg-zinc-800 text-cyan-300 border border-cyan-500/40 font-bold text-[10px] cursor-pointer shrink-0"
                    >
                      {isCheckingMinInv ? 'Calcul...' : 'Recalculează Min-Inv'}
                    </button>
                  </div>

                  <div className="grid grid-cols-12 gap-2 items-center">
                    <div className="col-span-5">
                      <span className="text-[9px] text-zinc-400 block mb-0.5">
                        Marjă Alocată (sz $, min $5)
                      </span>
                      <input
                        type="number"
                        min={5}
                        step="0.5"
                        value={sz}
                        onChange={(e) =>
                          setSz(e.target.value === '' ? ('' as any) : parseFloat(e.target.value))
                        }
                        className="w-full bg-zinc-900 border border-emerald-500/50 rounded px-2 py-1 text-emerald-300 font-black text-xs"
                      />
                    </div>
                    <div className="col-span-7 text-[10px] space-y-0.5">
                      <div className="flex items-center justify-between">
                        <span className="text-zinc-400">Min Necesar TB5:</span>
                        <strong
                          className={
                            Number(sz) < minOperational ? 'text-amber-300' : 'text-emerald-400'
                          }
                        >
                          ${minOperational.toFixed(2)} {ccyLabel}
                        </strong>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-zinc-400">Buget Setat Sus:</span>
                        <button
                          type="button"
                          onClick={() => setSz(budgetTarget)}
                          className="text-cyan-300 hover:text-cyan-200 font-bold underline cursor-pointer"
                          title="Sincronizează cu Buget / Bot setat în bara de sus"
                        >
                          ${effectiveMaxBudget.toFixed(2)} (Aplică ${budgetTarget.toFixed(2)})
                        </button>
                      </div>
                      <div className="text-[9px] text-zinc-400 truncate">
                        {rawOkxMin > 0
                          ? fitsBudget
                            ? `✓ OKX 1-lot ($${rawOkxMin.toFixed(2)}) se încadrează în buget ($${effectiveMaxBudget})`
                            : `⚠ OKX 1-lot ($${rawOkxMin.toFixed(2)}) depășește Bugetul ($${effectiveMaxBudget})`
                          : `Calculat automat de la min $5.00 la Buget ($${effectiveMaxBudget})`}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* LIVE SL & TP TRIGGER PREVIEW BOX (FOLOSEȘTE DIRECT SL % / TP % DIN BARA DE SUS) */}
            <div className="bg-black border border-amber-500/40 rounded p-2.5 space-y-1.5">
              <div className="flex items-center justify-between border-b border-zinc-800 pb-1">
                <span className="text-[10px] font-black text-amber-300">
                  🎯 PREȚURI TRIGGER SL (-{stopLossPct || 8}%) &amp; TP (+{takeProfitPct || 15}%) • {defaultStopType === '1' ? 'stopType 1 (Închide)' : 'stopType 2 (Păstrează)'}
                </span>
                <span className="text-[9px] text-zinc-400">
                  Click pt. Copy
                </span>
              </div>

              <div className="grid grid-cols-2 gap-1.5 text-[10px]">
                <div
                  onClick={() => handleCopyField('SL Trigger Price ($)', formatPrice(calcSlTriggerPx))}
                  className="bg-zinc-950 hover:bg-zinc-900 border border-rose-500/30 rounded px-2 py-1 cursor-pointer flex items-center justify-between"
                  title="Click pentru a copia SL Trigger Price ($)"
                >
                  <div>
                    <span className="text-zinc-400 block text-[9px]">
                      SL Trigger (-{stopLossPct || 8}% = -${(((Number(sz) || 0) * (Number(stopLossPct) || 8)) / 100).toFixed(2)})
                    </span>
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
                    <span className="text-zinc-400 block text-[9px]">
                      TP Trigger (+{takeProfitPct || 15}% = +${(((Number(sz) || 0) * (Number(takeProfitPct) || 15)) / 100).toFixed(2)})
                    </span>
                    <span className="font-black text-emerald-400">${formatPrice(calcTpTriggerPx)}</span>
                  </div>
                  <span className="text-[9px] text-cyan-400 font-bold">Copy</span>
                </div>
              </div>
            </div>

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
                Plasează și gestionează automat ordinele Limit ale grilei direct pe OKX EEA.
              </p>
            </div>
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
                            {b.algoId.toLowerCase().startsWith('grid') && onInspectLadder && (
                              <button
                                type="button"
                                onClick={() => onInspectLadder(b.algoId)}
                                className="px-2 py-1 rounded bg-zinc-900 hover:bg-zinc-800 text-emerald-300 border border-emerald-500/40 text-[10px] font-bold cursor-pointer"
                                title="Vezi scara treptelor grilei și ordinele Limit active"
                              >
                                Trepte Grilă
                              </button>
                            )}
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
                            {b.algoId.toLowerCase().startsWith('grid') && onInspectLadder && (
                              <button
                                type="button"
                                onClick={() => onInspectLadder(b.algoId)}
                                className="px-2 py-1 rounded bg-zinc-900 hover:bg-zinc-800 text-emerald-300 border border-emerald-500/40 text-[10px] font-bold cursor-pointer"
                                title="Vezi scara treptelor grilei"
                              >
                                Trepte Grilă
                              </button>
                            )}
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
                MARKET INTELLIGENCE &amp; OPTIMIZATOR INVESTIȚIE MINIMĂ OKX (_UM_XPERP — {eligibleOpportunities.length} ELIGIBILE / {opportunities.length} ANALIZATE PROFUND)
              </h3>
              <p className="text-[10px] text-zinc-400">
                Pre-scorează toate cele {autopilot?.scanDiagnostics?.totalUniverseXPerpCount ?? 257} contracte _UM_XPERP după consolidare laterală 24h, spread live, lichiditate și buget per 1 lot, apoi analizează profund (Klines 15m, Wilder ADX(14), Choppiness, ATR, OrderBook, Funding 8h, Min-Investment OKX) top {opportunities.length} candidați ({feeTierInfo?.roundTripMakerFeePct ?? 0.04}% round-trip).
              </p>
            </div>
          </div>
          {autopilot?.scanDiagnostics && (
            <div className="text-[10px] text-right text-zinc-400">
              <div>
                Ultima recalculare live:{' '}
                <strong className="text-cyan-300">
                  {new Date(autopilot.scanDiagnostics.lastScanAt).toLocaleTimeString()}
                </strong>{' '}
                ({autopilot.scanDiagnostics.lastScanDurationMs}ms)
              </div>
              <div>
                Schimbări poziție în clasament:{' '}
                <strong className="text-amber-300">
                  {autopilot.scanDiagnostics.rankingChangesLastScan} monede
                </strong>
              </div>
            </div>
          )}
        </div>

        {/* AUDIT DIVERSITATE SELECȚIE 24H, DINAMICĂ METRICI & SENSIBILITATE RANKING */}
        {autopilot?.scanDiagnostics && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2 bg-zinc-900/70 border border-zinc-800 rounded p-2 text-[10px]">
            <div className="space-y-0.5">
              <div className="font-bold text-cyan-300 uppercase">
                1. Pâlnie Selecție Univers ({autopilot.scanDiagnostics.totalUniverseXPerpCount} _UM_XPERP)
              </div>
              <div className="text-zinc-300">
                Total: <strong className="text-white">{autopilot.scanDiagnostics.totalUniverseXPerpCount}</strong> → Lichide/Spread:{' '}
                <strong className="text-white">{autopilot.scanDiagnostics.liquidSpreadFilteredCount}</strong> → Eligibile 1-Lot (≤${maxBudgetPerBot}):{' '}
                <strong className="text-emerald-300">{autopilot.scanDiagnostics.budgetFeasibleCount}</strong> → Analizate Klines+OB:{' '}
                <strong className="text-cyan-300">{autopilot.scanDiagnostics.deepAnalyzedCount}</strong>
              </div>
            </div>

            <div className="space-y-0.5">
              <div className="font-bold text-emerald-300 uppercase">
                2. Diversitate Top 7 (Ultimele 24h): {autopilot.scanDiagnostics.distinctTop7Count24h} simboluri distincte
              </div>
              <div className="flex flex-wrap gap-1 pt-0.5">
                {autopilot.scanDiagnostics.distinctTop7Symbols24h.map((sym) => (
                  <span
                    key={sym}
                    className="px-1.5 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 font-bold text-[9px]"
                  >
                    {sym}
                  </span>
                ))}
              </div>
            </div>

            <div className="space-y-0.5">
              <div className="font-bold text-amber-300 uppercase">
                3. Dinamică &amp; Sensibilitate Clasament (Fără Rotație Artificială)
              </div>
              <div className="text-zinc-300">
                Wilder ADX(14), Chop(14), ATR(14) și Spread bid/ask sunt recalculate live la fiecare scanare. Monedele urcă/coboară exclusiv pe baza datelor reale de piață (<span className="text-emerald-400">↑</span>/<span className="text-rose-400">↓</span> ΔRank &amp; ΔScor).
              </div>
            </div>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-[11px]">
            <thead>
              <tr className="border-b border-zinc-800 text-zinc-400">
                <th className="py-1.5 px-2">Rank / Contract _UM_XPERP</th>
                <th className="py-1.5 px-2">Preț / Range 24h</th>
                <th className="py-1.5 px-2">Scor &amp; Δ Dinamică</th>
                <th className="py-1.5 px-2">Chop / Wilder ADX / ATR</th>
                <th className="py-1.5 px-2">Open Interest / Vol 24h</th>
                <th className="py-1.5 px-2">Funding 8h / Spread</th>
                <th className="py-1.5 px-2">OrderBook Depth / Imb</th>
                <th className="py-1.5 px-2">3 Variante Range TB5 / Grile / Distanță</th>
                <th className="py-1.5 px-2">OKX Min-Investment</th>
                <th className="py-1.5 px-2">Profit Net &amp; Verificare Comisioane</th>
                <th className="py-1.5 px-2 text-right">Acțiune</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-900">
              {opportunities.map((opp, idx) => {
                const activeVarId: GridRangeVariantId =
                  rowVariants[opp.instId] ||
                  opp.selectedVariant ||
                  defaultRangeVariant ||
                  'BALANCED';
                const activeVar = getVariantProfileForOpp(opp, activeVarId);
                const liveEval = evaluateOpportunityLive(opp, activeVar);
                const displayRank = opp.rank ?? idx + 1;
                const rankDelta = opp.rankDelta ?? 0;
                const scoreDelta = opp.scoreDelta ?? 0;
                return (
                <tr
                  key={opp.instId}
                  className={`hover:bg-zinc-900/60 ${
                    liveEval.isEligible ? '' : 'opacity-65'
                  }`}
                >
                  <td className="py-2 px-2">
                    <div className="flex items-center gap-1.5">
                      <span className="px-1.5 py-0.5 rounded bg-zinc-800 text-cyan-300 font-black text-[10px]">
                        #{displayRank}
                      </span>
                      {opp.prevRank === undefined ? (
                        <span className="text-[9px] px-1 rounded bg-cyan-500/20 text-cyan-300 font-bold">
                          NOU
                        </span>
                      ) : rankDelta > 0 ? (
                        <span className="text-[9px] px-1 rounded bg-emerald-500/20 text-emerald-300 font-bold" title={`A urcat ${rankDelta} poziții față de scanarea anterioară (#${opp.prevRank} → #${displayRank})`}>
                          ↑{rankDelta}
                        </span>
                      ) : rankDelta < 0 ? (
                        <span className="text-[9px] px-1 rounded bg-rose-500/20 text-rose-300 font-bold" title={`A coborât ${Math.abs(rankDelta)} poziții față de scanarea anterioară (#${opp.prevRank} → #${displayRank})`}>
                          ↓{Math.abs(rankDelta)}
                        </span>
                      ) : (
                        <span className="text-[9px] text-zinc-500 font-mono" title="Aceeași poziție în clasament ca la scanarea anterioară">
                          =
                        </span>
                      )}
                      <span className="font-black text-white">{opp.instId}</span>
                    </div>
                    <div className="text-[10px] text-zinc-400 mt-0.5">
                      {liveEval.isEligible ? (
                        <span className="text-emerald-400 font-bold">
                          ✓ ELIGIBIL NEUTRAL GRID {opp.preScore ? `(Pre-Scor: ${opp.preScore})` : ''}
                        </span>
                      ) : (
                        <span className="text-rose-400" title={liveEval.rejectionReason}>
                          ✕ {liveEval.rejectionReason}
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
                    <div className="flex items-center gap-1">
                      <span className="font-black text-cyan-300">{opp.suitabilityScore}/100</span>
                      {scoreDelta !== 0 && (
                        <span
                          className={`text-[9px] font-bold ${
                            scoreDelta > 0 ? 'text-emerald-400' : 'text-rose-400'
                          }`}
                        >
                          ({scoreDelta > 0 ? `+${scoreDelta}` : scoreDelta})
                        </span>
                      )}
                    </div>
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
                    <div>
                      Chop: <strong className="text-white">{opp.choppinessIndex.toFixed(1)}</strong>
                      {opp.chopDelta !== undefined && opp.chopDelta !== 0 && (
                        <span className={`ml-1 text-[9px] ${opp.chopDelta > 0 ? 'text-emerald-400' : 'text-amber-400'}`}>
                          {opp.chopDelta > 0 ? `+${opp.chopDelta.toFixed(1)}` : opp.chopDelta.toFixed(1)}
                        </span>
                      )}
                    </div>
                    <div>
                      ADX: <strong className="text-white">{opp.adxTrendStrength.toFixed(1)}</strong>
                      {opp.adxDelta !== undefined && opp.adxDelta !== 0 && (
                        <span className={`ml-1 text-[9px] ${opp.adxDelta <= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                          {opp.adxDelta > 0 ? `+${opp.adxDelta.toFixed(1)}` : opp.adxDelta.toFixed(1)}
                        </span>
                      )}{' '}
                      | ATR: {opp.atrPct.toFixed(2)}%
                    </div>
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
                    {/* 3-Variant Switcher Pills */}
                    <div className="flex items-center gap-1 mb-1">
                      {(['CONSERVATIVE', 'BALANCED', 'COMPACT'] as GridRangeVariantId[]).map(
                        (vId) => {
                          const vp = getVariantProfileForOpp(opp, vId);
                          const isAct = activeVarId === vId;
                          return (
                            <button
                              key={vId}
                              type="button"
                              onClick={() =>
                                setRowVariants((prev) => ({ ...prev, [opp.instId]: vId }))
                              }
                              title={`${vp.label}: ±${vp.halfRangePct.toFixed(2)}% | ${vp.gridNum} grile | Distanță ${vp.gridSpacingPct.toFixed(2)}% | Net +${vp.estimatedNetProfitPerGridPct.toFixed(2)}%`}
                              className={`px-1.5 py-0.5 rounded text-[9px] font-black border cursor-pointer ${
                                isAct
                                  ? vId === 'BALANCED'
                                    ? 'bg-emerald-500 text-black border-emerald-400'
                                    : vId === 'COMPACT'
                                    ? 'bg-amber-500 text-black border-amber-400'
                                    : 'bg-cyan-500 text-black border-cyan-400'
                                  : 'bg-zinc-900 text-zinc-400 border-zinc-800 hover:text-white'
                              }`}
                            >
                              {vId === 'CONSERVATIVE'
                                ? `Conserv. ±${vp.halfRangePct.toFixed(2)}%`
                                : vId === 'BALANCED'
                                ? `Echilibrat ±${vp.halfRangePct.toFixed(2)}%`
                                : `Compact ±${vp.halfRangePct.toFixed(2)}%`}
                            </button>
                          );
                        }
                      )}
                    </div>
                    <div className="font-bold text-white">
                      ${formatPrice(activeVar.minPx)} – ${formatPrice(activeVar.maxPx)}{' '}
                      <span className="text-[10px] text-cyan-300 font-black">
                        (±{activeVar.halfRangePct.toFixed(2)}%)
                      </span>
                    </div>
                    <div className="text-[10px] text-amber-300 font-bold">
                      {activeVar.gridNum} grile • Distanță ~{activeVar.gridSpacingPct.toFixed(2)}% @{' '}
                      {activeVar.lever}x
                    </div>
                    <div className="text-[9px] text-zinc-400 mt-0.5">
                      <span className="text-rose-300">
                        SL: ${formatPrice(activeVar.minPx * (1 - (stopLossPct || 8) / 100 / Math.max(1, activeVar.lever)))}
                      </span>{' '}
                      |{' '}
                      <span className="text-emerald-300">
                        TP: ${formatPrice(activeVar.maxPx * (1 + (takeProfitPct || 15) / 100 / Math.max(1, activeVar.lever)))}
                      </span>
                    </div>
                  </td>
                  <td className="py-2 px-2 tabular-nums">
                    {(() => {
                      const { minOp, botBudget, fitsBudgetNow } = liveEval;
                      const allocSz = computeBotInvestmentUSDT(activeVar.minInvestmentUSDT, botBudget);
                      return (
                        <>
                          <div
                            className={`font-black ${
                              fitsBudgetNow ? 'text-emerald-400' : 'text-rose-400'
                            }`}
                          >
                            Min TB5: ${minOp.toFixed(2)} (OKX: ${activeVar.minInvestmentUSDT.toFixed(2)})
                          </div>
                          <div className="text-[10px]">
                            {fitsBudgetNow ? (
                              <span className="text-emerald-300 font-bold">
                                Alocat Bot: ${allocSz.toFixed(2)} (Buget Max: ${botBudget.toFixed(2)})
                              </span>
                            ) : (
                              <span className="text-rose-400">
                                PESTE BUGET (&gt;${botBudget.toFixed(2)})
                              </span>
                            )}
                          </div>
                        </>
                      );
                    })()}
                  </td>
                  <td className="py-2 px-2 tabular-nums">
                    <div
                      className={`font-black ${
                        activeVar.feeCheckPassed &&
                        activeVar.estimatedNetProfitPerGridPct >= minNetProfitPct
                          ? 'text-emerald-400'
                          : 'text-rose-400'
                      }`}
                    >
                      +{activeVar.estimatedNetProfitPerGridPct.toFixed(2)}% / grilă
                    </div>
                    <div className="text-[10px] text-zinc-400">
                      Est/zi: +{activeVar.estimatedDailyNetYieldPct.toFixed(2)}% • Fee load:{' '}
                      {activeVar.feeLoadPctOfStep}%
                    </div>
                    {activeVar.feeWarning ? (
                      <div
                        className="text-[9px] text-rose-400 font-bold mt-0.5 max-w-[190px] leading-tight"
                        title={activeVar.feeWarning}
                      >
                        ⚠ {activeVar.feeWarning}
                      </div>
                    ) : (
                      <div className="text-[9px] text-emerald-400/90 mt-0.5">
                        ✓ Comisioane verificate ({activeVar.label})
                      </div>
                    )}
                  </td>
                  <td className="py-2 px-2 text-right">
                    <div className="flex items-center justify-end space-x-1">
                      <button
                        type="button"
                        onClick={() => handleLoadOpportunity(opp, activeVarId)}
                        className="px-2 py-1 rounded bg-zinc-900 hover:bg-zinc-800 text-amber-300 border border-amber-500/40 text-[10px] font-bold cursor-pointer"
                      >
                        În Builder
                      </button>
                        <button
                          type="button"
                          disabled={
                            Math.max(5, activeVar.minInvestmentUSDT) >
                              Math.max(5, Number(maxBudgetPerBot) || 25) ||
                            !activeVar.feeCheckPassed ||
                            isCreating
                          }
                          onClick={() =>
                            handleCreateNativeBot({
                              ...opp,
                              minPx: activeVar.minPx,
                              maxPx: activeVar.maxPx,
                              gridNum: activeVar.gridNum,
                              lever: activeVar.lever,
                              minInvestmentUSDT: activeVar.minInvestmentUSDT,
                              recommendedInvestmentUSDT: computeBotInvestmentUSDT(
                                activeVar.minInvestmentUSDT
                              ),
                            })
                          }
                          className="px-2.5 py-1 rounded bg-emerald-500 hover:bg-emerald-400 disabled:opacity-40 text-black text-[10px] font-black cursor-pointer"
                          title={
                            !activeVar.feeCheckPassed
                              ? activeVar.feeWarning || 'Comisioanele depășesc pragul de siguranță pentru această variantă'
                              : `Lansează ${activeVar.label} (±${activeVar.halfRangePct.toFixed(2)}%, ${activeVar.gridNum} grile, $${computeBotInvestmentUSDT(activeVar.minInvestmentUSDT).toFixed(2)})`
                          }
                        >
                          ⚡ Lansează Auto-Limit
                        </button>
                    </div>
                  </td>
                </tr>
                );
              })}
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
