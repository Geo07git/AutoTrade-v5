import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  AnafCoverageStatus,
  AnafMonthlySummary,
  AnafNativeBotReconciliationItem,
  AnafTaxEfficiencyMetrics,
  AnafTaxSummary,
  AnafTransactionPageResponse,
  AnafTransactionRecord,
} from '../shared/types';
import {
  FileText,
  DollarSign,
  TrendingUp,
  AlertTriangle,
  Download,
  Upload,
  RefreshCw,
  Copy,
  Calendar,
  Layers,
  HelpCircle,
  ShieldCheck,
  Percent,
  Search,
  ChevronLeft,
  ChevronRight,
  X,
  RotateCcw,
  Eye,
} from 'lucide-react';

interface AnafTaxPanelProps {
  controlToken: string;
  onNotify: (banner: { type: 'success' | 'error' | 'info'; text: string }) => void;
  onSwitchToApiTab?: () => void;
}

const getDefaultStartDateForYear = (year: number): string =>
  year === 2026 ? '2026-10-01' : `${year}-01-01`;

const formatRon = (val: number, decimals = 2): string =>
  val.toLocaleString('ro-RO', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });

const coverageBadgeStyle = (status: AnafCoverageStatus): string => {
  switch (status) {
    case 'API_COMPLETE':
    case 'API_PLUS_CSV':
      return 'text-emerald-300';
    case 'CSV_ONLY':
      return 'text-cyan-300';
    case 'PARTIAL_OLD_API':
      return 'text-amber-300';
    default:
      return 'text-zinc-500';
  }
};

const EfficiencyCell: React.FC<{
  eff: AnafTaxEfficiencyMetrics;
  includeCassNote?: boolean;
}> = ({ eff, includeCassNote }) => {
  const isCritical = eff.lossWithTaxDue || eff.taxExceedsGain;
  const isWarn = eff.status === 'HIGH_TAX';

  return (
    <div className="space-y-0.5 text-right tabular-nums">
      <div className="flex items-center justify-end gap-2 text-[11px]">
        <span className="text-zinc-400 font-normal">PnL Real:</span>
        <span className={`font-bold ${eff.realNetPnLRON >= 0 ? 'text-emerald-300' : 'text-rose-400'}`}>
          {eff.realNetPnLUSD >= 0 ? '+' : ''}${eff.realNetPnLUSD.toFixed(2)} ({eff.realNetPnLRON >= 0 ? '+' : ''}
          {formatRon(eff.realNetPnLRON)} RON)
        </span>
      </div>
      <div className="flex items-center justify-end gap-2 text-[10px]">
        <span className="text-zinc-400">
          Taxe{includeCassNote ? ' (Imp+CASS)' : ''}: <strong className="text-rose-300">{formatRon(eff.taxesDueRON, 0)} RON</strong>
        </span>
        <span aria-hidden="true" className="text-zinc-600">·</span>
        <span
          className={`font-bold ${
            isCritical ? 'text-rose-400' : isWarn ? 'text-amber-300' : 'text-zinc-200'
          }`}
        >
          Rată: {eff.effectiveTaxRatePct !== null ? `${eff.effectiveTaxRatePct.toFixed(1)}%` : 'N/A'}
        </span>
      </div>
      <div className="flex items-center justify-end gap-2 text-[10px]">
        <span className="text-zinc-400">Rămas net:</span>
        <span className={`font-black ${eff.netAfterTaxRON >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
          {eff.netAfterTaxRON >= 0 ? '+' : ''}{formatRon(eff.netAfterTaxRON)} RON
        </span>
      </div>
      {(isCritical || isWarn) && (
        <div
          className={`inline-flex items-center justify-end gap-1 text-[10px] font-black ${
            isCritical ? 'text-rose-300' : 'text-amber-300'
          }`}
        >
          <AlertTriangle className="w-3 h-3 shrink-0" />
          <span>{eff.statusLabel}</span>
        </div>
      )}
    </div>
  );
};

export const AnafTaxPanel: React.FC<AnafTaxPanelProps> = ({ controlToken, onNotify, onSwitchToApiTab }) => {
  const currentYear = new Date().getFullYear();
  const initialYear = currentYear === 2026 ? 2026 : currentYear;

  const [selectedYear, setSelectedYear] = useState<number>(initialYear);
  const [startDate, setStartDate] = useState<string>(getDefaultStartDateForYear(initialYear));
  const [taxRatePct, setTaxRatePct] = useState<number>(10);
  const [minWageGrossRON, setMinWageGrossRON] = useState<number>(4050);
  const [bnrRateInput, setBnrRateInput] = useState<string>('');
  const [settingsLoaded, setSettingsLoaded] = useState<boolean>(false);

  const [report, setReport] = useState<AnafTaxSummary | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [isSavingSettings, setIsSavingSettings] = useState<boolean>(false);
  const [copiedKey, setCopiedKey] = useState<string>('');
  const [showSpvGuide, setShowSpvGuide] = useState<boolean>(false);

  // CSV Upload Modal state
  const [showUploadModal, setShowUploadModal] = useState<boolean>(false);
  const [csvUploadText, setCsvUploadText] = useState<string>('');
  const [isUploadingCsv, setIsUploadingCsv] = useState<boolean>(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // On-demand Transaction Audit Drilldown state
  const [auditOpen, setAuditOpen] = useState<boolean>(false);
  const [auditMonth, setAuditMonth] = useState<string>('ALL'); // YYYY-MM or ALL
  const [auditFilter, setAuditFilter] = useState<'ALL' | 'PROFIT' | 'LOSS'>('ALL');
  const [auditSearch, setAuditSearch] = useState<string>('');
  const [auditPage, setAuditPage] = useState<number>(1);
  const [auditData, setAuditData] = useState<AnafTransactionPageResponse | null>(null);
  const [isLoadingAudit, setIsLoadingAudit] = useState<boolean>(false);

  const buildReportParams = useCallback(
    (overrides?: {
      year?: number;
      startDate?: string;
      taxRate?: number;
      minWage?: number;
      usdRonRate?: string | null;
    }) => {
      const y = overrides?.year ?? selectedYear;
      const sd = overrides?.startDate ?? startDate;
      const tr = overrides?.taxRate ?? taxRatePct;
      const mw = overrides?.minWage ?? minWageGrossRON;
      const q = new URLSearchParams({
        year: String(y),
        startDate: sd,
        taxRate: String(tr),
        minWage: String(mw),
      });
      if (overrides?.usdRonRate === null) {
        q.set('usdRonRate', 'live');
      } else if (typeof overrides?.usdRonRate === 'string' && overrides.usdRonRate.trim()) {
        q.set('usdRonRate', overrides.usdRonRate.trim());
      } else if (report?.isCustomUsdRonRate && bnrRateInput.trim()) {
        q.set('usdRonRate', bnrRateInput.trim());
      }
      return q;
    },
    [selectedYear, startDate, taxRatePct, minWageGrossRON, report?.isCustomUsdRonRate, bnrRateInput]
  );

  // Load persisted fiscal settings first on mount
  useEffect(() => {
    let active = true;
    const init = async () => {
      try {
        const res = await fetch('/api/bot/fiscal/settings');
        const data = await res.json();
        if (active && data?.success && data.settings) {
          const s = data.settings;
          const fy = Number(s.fiscalYear) || initialYear;
          setSelectedYear(fy);
          setStartDate(s.startDate || getDefaultStartDateForYear(fy));
          setTaxRatePct(Number(s.taxRatePct) === 16 ? 16 : 10);
          setMinWageGrossRON(Number(s.minWageGrossRON) || 4050);
          if (s.customUsdRonRate !== null && s.customUsdRonRate !== undefined) {
            setBnrRateInput(String(s.customUsdRonRate));
          } else if (data.liveRates?.usdRon) {
            setBnrRateInput(String(data.liveRates.usdRon));
          }
        }
      } catch {}
      if (active) setSettingsLoaded(true);
    };
    void init();
    return () => {
      active = false;
    };
  }, [initialYear]);

  const fetchTaxReport = useCallback(
    async (
      forceSync = false,
      overrides?: {
        year?: number;
        startDate?: string;
        taxRate?: number;
        minWage?: number;
        usdRonRate?: string | null;
      }
    ) => {
      if (forceSync) setIsSyncing(true);
      else setIsLoading(true);

      try {
        let res: Response;
        if (forceSync) {
          const parsedCustom =
            overrides?.usdRonRate === null
              ? null
              : report?.isCustomUsdRonRate && bnrRateInput.trim()
              ? parseFloat(bnrRateInput)
              : undefined;
          res = await fetch('/api/bot/fiscal/sync', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-bot-token': controlToken,
            },
            body: JSON.stringify({
              year: overrides?.year ?? selectedYear,
              startDate: overrides?.startDate ?? startDate,
              taxRate: overrides?.taxRate ?? taxRatePct,
              minWage: overrides?.minWage ?? minWageGrossRON,
              usdRonRate: parsedCustom,
            }),
          });
        } else {
          const q = buildReportParams(overrides);
          res = await fetch(`/api/bot/fiscal/report?${q.toString()}`);
        }

        const data = await res.json();
        if (data?.success && data.report) {
          setReport(data.report);
          if (!data.report.isCustomUsdRonRate && data.report.usdRonRate) {
            setBnrRateInput(String(data.report.usdRonRate));
          }
          if (forceSync) {
            onNotify({
              type: 'success',
              text: data.message || 'Datele fiscale și istoricul OKX Bills au fost sincronizate complet!',
            });
          }
        } else {
          onNotify({
            type: 'error',
            text: data?.error || 'Eroare la obținerea raportului fiscal ANAF.',
          });
        }
      } catch (err: any) {
        onNotify({
          type: 'error',
          text: err.message || 'Eroare de rețea la interogarea raportului fiscal.',
        });
      } finally {
        setIsLoading(false);
        setIsSyncing(false);
      }
    },
    [
      buildReportParams,
      controlToken,
      minWageGrossRON,
      onNotify,
      report?.isCustomUsdRonRate,
      bnrRateInput,
      selectedYear,
      startDate,
      taxRatePct,
    ]
  );

  useEffect(() => {
    if (!settingsLoaded) return;
    void fetchTaxReport(false);
  }, [settingsLoaded, selectedYear, startDate, taxRatePct, minWageGrossRON]);

  // Fetch paginated transactions ONLY when audit drilldown is open
  const fetchAuditTransactions = useCallback(
    async (opts?: { month?: string; filter?: 'ALL' | 'PROFIT' | 'LOSS'; search?: string; page?: number }) => {
      setIsLoadingAudit(true);
      try {
        const targetMonth = opts?.month ?? auditMonth;
        const targetFilter = opts?.filter ?? auditFilter;
        const targetSearch = opts?.search ?? auditSearch;
        const targetPage = opts?.page ?? auditPage;

        const q = new URLSearchParams({
          year: String(selectedYear),
          startDate,
          month: targetMonth,
          filter: targetFilter,
          search: targetSearch,
          page: String(targetPage),
          pageSize: '100',
        });
        if (report?.isCustomUsdRonRate && report.usdRonRate) {
          q.set('usdRonRate', String(report.usdRonRate));
        }

        const res = await fetch(`/api/bot/fiscal/transactions?${q.toString()}`);
        const data = await res.json();
        if (data?.success) {
          setAuditData(data);
        } else {
          onNotify({ type: 'error', text: data?.error || 'Eroare la încărcarea tranzacțiilor lunii.' });
        }
      } catch (err: any) {
        onNotify({ type: 'error', text: err.message || 'Eroare de rețea la încărcarea auditului OKX.' });
      } finally {
        setIsLoadingAudit(false);
      }
    },
    [
      auditMonth,
      auditFilter,
      auditSearch,
      auditPage,
      selectedYear,
      startDate,
      report?.isCustomUsdRonRate,
      report?.usdRonRate,
      onNotify,
    ]
  );

  useEffect(() => {
    if (!auditOpen) return;
    void fetchAuditTransactions();
  }, [auditOpen, auditMonth, auditFilter, auditPage, report?.usdRonRate, selectedYear, startDate]);

  const persistSettings = async (patch: {
    fiscalYear?: number;
    startDate?: string;
    taxRatePct?: number;
    minWageGrossRON?: number;
    customUsdRonRate?: number | null;
    clearCustomUsdRonRate?: boolean;
  }) => {
    setIsSavingSettings(true);
    try {
      const res = await fetch('/api/bot/fiscal/settings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-bot-token': controlToken,
        },
        body: JSON.stringify({
          fiscalYear: patch.fiscalYear ?? selectedYear,
          startDate: patch.startDate ?? startDate,
          taxRatePct: patch.taxRatePct ?? taxRatePct,
          minWageGrossRON: patch.minWageGrossRON ?? minWageGrossRON,
          customUsdRonRate: patch.customUsdRonRate,
          clearCustomUsdRonRate: patch.clearCustomUsdRonRate,
        }),
      });
      const data = await res.json();
      if (data?.success && data.report) {
        setReport(data.report);
        if (data.report.usdRonRate) {
          setBnrRateInput(String(data.report.usdRonRate));
        }
        return true;
      } else {
        onNotify({ type: 'error', text: data?.error || 'Eroare la salvarea configurației fiscale.' });
        return false;
      }
    } catch (err: any) {
      onNotify({ type: 'error', text: err.message || 'Eroare de rețea la salvarea setărilor.' });
      return false;
    } finally {
      setIsSavingSettings(false);
    }
  };

  const handleYearChange = (newYear: number) => {
    const nextStart = getDefaultStartDateForYear(newYear);
    setSelectedYear(newYear);
    setStartDate(nextStart);
    setAuditOpen(false);
    void persistSettings({ fiscalYear: newYear, startDate: nextStart });
  };

  const handleApplyCustomBnr = async () => {
    const parsed = parseFloat(bnrRateInput.replace(',', '.'));
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 20) {
      onNotify({ type: 'error', text: 'Introdu un curs BNR USD/RON valid (ex: 4.6500).' });
      return;
    }
    const ok = await persistSettings({ customUsdRonRate: parsed });
    if (ok) {
      onNotify({
        type: 'success',
        text: `Curs BNR suprascris și salvat: 1 USD = ${parsed.toFixed(4)} RON. Toate valorile au fost recalculate.`,
      });
    }
  };

  const handleRevertLiveBnr = async () => {
    const ok = await persistSettings({ customUsdRonRate: null, clearCustomUsdRonRate: true });
    if (ok) {
      onNotify({
        type: 'info',
        text: 'Revenit la cursul BNR Live. Toate valorile în RON au fost recalculate automat.',
      });
    }
  };

  const handleCopy = (key: string, val: string | number) => {
    try {
      navigator.clipboard.writeText(String(val));
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(''), 2500);
      onNotify({ type: 'info', text: `Copiat în clipboard: ${val}` });
    } catch {}
  };

  const handleCopyAllDeclaration = () => {
    if (!report) return;
    const g = report.spvDeclarationGuide;
    const text = [
      `--- DATE DECLARAȚIA UNICĂ ${report.fiscalYear} (${report.startDate} -> ${report.endDate}) ---`,
      `Secțiunea: ${g.section}`,
      `Categoria: ${g.category}`,
      `1. Venit Brut: ${g.boxGrossRevenueRON.toFixed(2)} RON`,
      `2. Cheltuieli Deductibile: ${g.boxDeductibleExpensesRON.toFixed(2)} RON`,
      `3. Venit Net (Baza Impozabilă): ${g.boxNetTaxableBaseRON.toFixed(2)} RON`,
      `4. Impozit pe Venit (${report.taxRatePct}%): ${g.boxIncomeTaxDueRON} RON`,
      `5. CASS Datorat (Sănătate): ${g.boxCassDueRON} RON`,
      `TOTAL DATORAT BUGET STAT: ${g.boxTotalDueRON} RON`,
      `PnL Real Net: ${report.ytdEfficiency.realNetPnLRON.toFixed(2)} RON · Rămas Net după Taxe: ${report.ytdEfficiency.netAfterTaxRON.toFixed(2)} RON`,
      `Termen legal plată & depunere: ${report.filingDeadline}`,
    ].join('\n');
    handleCopy('ALL_DECLARATION', text);
  };

  const handleDownloadCsv = () => {
    const q = buildReportParams();
    window.open(`/api/bot/fiscal/export-csv?${q.toString()}`, '_blank');
  };

  const handleOpenMonthAudit = (yearMonth: string) => {
    setAuditMonth(yearMonth);
    setAuditFilter('ALL');
    setAuditSearch('');
    setAuditPage(1);
    setAuditOpen(true);
  };

  const handleUploadCsvSubmit = async () => {
    if (!csvUploadText || csvUploadText.trim().length < 10) {
      onNotify({ type: 'error', text: 'Selectează sau lipește conținutul fișierului CSV de la OKX.' });
      return;
    }
    setIsUploadingCsv(true);
    try {
      const res = await fetch('/api/bot/fiscal/upload-csv', {
        method: 'POST',
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'x-bot-token': controlToken,
        },
        body: csvUploadText,
      });
      const data = await res.json();
      if (data?.success) {
        onNotify({
          type: 'success',
          text: data.message || `Au fost importate ${data.importedCount} înregistrări din CSV.`,
        });
        if (Array.isArray(data.yearsFound) && data.yearsFound.length > 0 && !data.yearsFound.includes(selectedYear)) {
          const recYear = data.yearsFound[data.yearsFound.length - 1];
          handleYearChange(recYear);
        }
        setShowUploadModal(false);
        setCsvUploadText('');
        await fetchTaxReport(false);
      } else {
        onNotify({ type: 'error', text: data.error || 'Eroare la importul CSV.' });
      }
    } catch (err: any) {
      onNotify({ type: 'error', text: err.message || 'Eroare de rețea la importul CSV.' });
    } finally {
      setIsUploadingCsv(false);
    }
  };

  const handleClearCsv = async () => {
    try {
      const res = await fetch('/api/bot/fiscal/clear-csv', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-bot-token': controlToken,
        },
      });
      const data = await res.json();
      if (data?.success) {
        onNotify({ type: 'info', text: 'Tranzacțiile CSV importate anterior au fost șterse.' });
        setShowUploadModal(false);
        await fetchTaxReport(false);
      }
    } catch (err: any) {
      onNotify({ type: 'error', text: err.message || 'Eroare la ștergerea tranzacțiilor CSV.' });
    }
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      const content = evt.target?.result as string;
      if (content) setCsvUploadText(content);
    };
    reader.readAsText(file);
  };

  return (
    <div className="space-y-4 p-1">
      {/* =================================================================== */}
      {/* 1. HEADER & CONTROALE FISCALE                                       */}
      {/* =================================================================== */}
      <section className="bg-zinc-950 border border-zinc-800 rounded p-4 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-zinc-800 pb-3">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
              <span>Legislație România (Art. 116 Cod Fiscal)</span>
              <span aria-hidden="true">·</span>
              <span>Perioadă: {report?.startDate || startDate} → {report?.endDate || 'azi'}</span>
              <span aria-hidden="true">·</span>
              <span>Termen SPV: {report?.filingDeadline || `25 Mai ${selectedYear + 1}`}</span>
            </div>
            <h2 className="font-bold text-base text-white tracking-tight flex items-center gap-2">
              <FileText className="w-4 h-4 text-emerald-400 shrink-0" />
              <span>Modul Fiscal ANAF &amp; Declarația Unică {selectedYear}</span>
            </h2>
            <p className="text-xs text-zinc-400 max-w-4xl">
              Sursă contabilă unică OKX (<code className="text-zinc-300">account/bills</code> &amp; <code className="text-zinc-300">bills-archive</code>), agregată pe luni calendaristice. Cursul BNR USD/RON recalculează dinamic toate cifrele în RON.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => void fetchTaxReport(true)}
              disabled={isSyncing}
              className="px-3.5 py-2 rounded bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50 text-black font-bold text-xs flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0 transition-colors"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin' : ''}`} />
              <span>{isSyncing ? 'Sincronizare OKX...' : 'Sincronizează API OKX & BNR'}</span>
            </button>
            <button
              type="button"
              onClick={handleDownloadCsv}
              className="px-3.5 py-2 rounded bg-zinc-900 hover:bg-zinc-800 text-emerald-300 border border-zinc-700 font-bold text-xs flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0 transition-colors"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Descarcă Raport .CSV</span>
            </button>
            <button
              type="button"
              onClick={() => setShowUploadModal(true)}
              className="px-3.5 py-2 rounded bg-zinc-900 hover:bg-zinc-800 text-amber-300 border border-zinc-700 font-bold text-xs flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0 transition-colors"
            >
              <Upload className="w-3.5 h-3.5" />
              <span>Încarcă CSV OKX</span>
            </button>
          </div>
        </div>

        {/* BARA DE CONTROALE (AN, START DATE, COTA, SALARIU MINIM, CURS BNR PERSISTENT) */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 text-xs">
          <div className="bg-black border border-zinc-800 rounded p-2.5">
            <label className="text-[11px] text-zinc-400 block mb-1.5 font-semibold flex items-center gap-1.5">
              <Calendar className="w-3.5 h-3.5 text-cyan-400" />
              <span>An Fiscal</span>
            </label>
            <select
              value={selectedYear}
              onChange={(e) => handleYearChange(parseInt(e.target.value, 10))}
              className="w-full bg-zinc-900 border border-zinc-700 rounded px-2.5 py-1.5 text-white font-semibold"
            >
              <option value={2026}>2026 (Termen Mai 2027)</option>
              <option value={2025}>2025 (Termen Mai 2026)</option>
              <option value={2027}>2027 (Termen Mai 2028)</option>
            </select>
          </div>

          <div className="bg-black border border-zinc-800 rounded p-2.5">
            <label className="text-[11px] text-zinc-400 block mb-1.5 font-semibold flex items-center gap-1.5">
              <Calendar className="w-3.5 h-3.5 text-emerald-400" />
              <span>Dată Start Calcul</span>
            </label>
            <input
              type="date"
              value={startDate}
              min={`${selectedYear}-01-01`}
              max={`${selectedYear}-12-31`}
              onChange={(e) => {
                const next = e.target.value;
                if (/^\d{4}-\d{2}-\d{2}$/.test(next)) {
                  setStartDate(next);
                  void persistSettings({ startDate: next });
                }
              }}
              className="w-full bg-zinc-900 border border-zinc-700 rounded px-2.5 py-1.5 text-white font-mono tabular-nums"
            />
          </div>

          <div className="bg-black border border-zinc-800 rounded p-2.5">
            <label className="text-[11px] text-zinc-400 block mb-1.5 font-semibold flex items-center gap-1.5">
              <Percent className="w-3.5 h-3.5 text-emerald-400" />
              <span>Cotă Impozit</span>
            </label>
            <div className="grid grid-cols-2 gap-1.5">
              <button
                type="button"
                onClick={() => {
                  setTaxRatePct(10);
                  void persistSettings({ taxRatePct: 10 });
                }}
                className={`py-1.5 px-2 rounded text-[11px] font-bold cursor-pointer border whitespace-nowrap ${
                  taxRatePct === 10
                    ? 'bg-emerald-500 text-black border-emerald-400'
                    : 'bg-zinc-900 text-zinc-300 border-zinc-700 hover:text-white'
                }`}
              >
                10% Crypto
              </button>
              <button
                type="button"
                onClick={() => {
                  setTaxRatePct(16);
                  void persistSettings({ taxRatePct: 16 });
                }}
                className={`py-1.5 px-2 rounded text-[11px] font-bold cursor-pointer border whitespace-nowrap ${
                  taxRatePct === 16
                    ? 'bg-amber-500 text-black border-amber-400'
                    : 'bg-zinc-900 text-zinc-300 border-zinc-700 hover:text-white'
                }`}
              >
                16% Derivate
              </button>
            </div>
          </div>

          <div className="bg-black border border-zinc-800 rounded p-2.5">
            <label className="text-[11px] text-zinc-400 block mb-1.5 font-semibold flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5 text-amber-400" />
              <span>Salariu Minim (CASS)</span>
            </label>
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                value={minWageGrossRON}
                onChange={(e) => setMinWageGrossRON(parseFloat(e.target.value) || 4050)}
                onBlur={() => void persistSettings({ minWageGrossRON })}
                className="w-full bg-zinc-900 border border-zinc-700 rounded px-2.5 py-1.5 text-amber-300 font-bold tabular-nums"
              />
              <span className="text-[11px] text-zinc-400 font-semibold">RON</span>
            </div>
          </div>

          <div className="bg-black border border-zinc-800 rounded p-2.5">
            <label className="text-[11px] text-zinc-400 block mb-1.5 font-semibold flex items-center justify-between gap-1">
              <span className="flex items-center gap-1">
                <DollarSign className="w-3.5 h-3.5 text-cyan-400" />
                <span>Curs BNR USD/RON</span>
              </span>
              <span className={`text-[10px] ${report?.isCustomUsdRonRate ? 'text-amber-300 font-bold' : 'text-emerald-400'}`}>
                {report?.isCustomUsdRonRate ? 'Manual' : 'BNR Live'}
              </span>
            </label>
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                step="0.0001"
                value={bnrRateInput}
                onChange={(e) => setBnrRateInput(e.target.value)}
                placeholder="4.6200"
                className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-cyan-300 font-bold tabular-nums"
              />
              <button
                type="button"
                disabled={isSavingSettings}
                onClick={() => void handleApplyCustomBnr()}
                className="px-2.5 py-1.5 rounded bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/40 text-cyan-300 text-[11px] font-bold cursor-pointer whitespace-nowrap shrink-0"
              >
                Aplică
              </button>
              {report?.isCustomUsdRonRate && (
                <button
                  type="button"
                  disabled={isSavingSettings}
                  onClick={() => void handleRevertLiveBnr()}
                  title={`Revino la BNR Live (${report.liveBnrUsdRonRate.toFixed(4)} RON)`}
                  className="p-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-amber-300 border border-zinc-700 cursor-pointer shrink-0"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Status Acoperire & Sincronizare Canonică */}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-[11px] text-zinc-400 border-t border-zinc-900">
          <div className="flex flex-wrap items-center gap-3 tabular-nums">
            <span>
              Sursă: <strong className="text-zinc-200">{report?.coverageSummary || 'Se încarcă...'}</strong>
            </span>
            <span aria-hidden="true">·</span>
            <span>
              Cache persistent: <strong className="text-amber-300">{report?.persistentCacheCount || 0} bills</strong>
            </span>
            <span aria-hidden="true">·</span>
            <span>
              Boți nativi OKX citiți: <strong className="text-emerald-300">{report?.nativeBotsReconciliation?.length || 0}</strong> (LONG/SHORT/NEUTRAL)
            </span>
            <span aria-hidden="true">·</span>
            <span>
              Curs activ: <strong className="text-cyan-300">{report ? `${report.usdRonRate.toFixed(4)} RON` : '—'}</strong> ({report?.ratesSource || 'BNR'})
            </span>
          </div>
          <div>
            Ultima sincronizare:{' '}
            <strong className="text-zinc-200 tabular-nums">
              {report?.okxApiSyncStatus?.lastSyncedAt
                ? new Date(report.okxApiSyncStatus.lastSyncedAt).toLocaleTimeString('ro-RO')
                : 'Niciuna în sesiune (se folosește cache-ul .data/)'}
            </strong>
          </div>
        </div>

        {!report?.okxApiSyncStatus?.hasOkxCredentials && (
          <div className="bg-amber-950/40 border border-amber-500/40 rounded p-2.5 text-amber-200 text-xs flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
              <span>
                <strong>Cheile API OKX nu sunt configurate.</strong> Poți folosi fișierul CSV oficial din OKX sau poți conecta API-ul din Tab 5.
              </span>
            </div>
            {onSwitchToApiTab && (
              <button
                type="button"
                onClick={onSwitchToApiTab}
                className="px-3 py-1.5 rounded bg-amber-500 hover:bg-amber-400 text-black font-bold text-xs cursor-pointer whitespace-nowrap shrink-0"
              >
                Conectează OKX (Tab 5)
              </button>
            )}
          </div>
        )}

        {report?.okxApiSyncStatus?.errorMessage && (
          <div className="bg-rose-950/40 border border-rose-500/40 rounded p-2.5 text-rose-300 text-xs flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>{report.okxApiSyncStatus.errorMessage}</span>
          </div>
        )}
      </section>

      {/* =================================================================== */}
      {/* 2. REZUMAT DECLARAȚIA UNICĂ (SPV) + PLAFOANE CASS                    */}
      {/* =================================================================== */}
      <section className="bg-zinc-950 border border-zinc-800 rounded p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 pb-2.5">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-amber-400" />
            <h3 className="font-bold text-sm text-white">
              Cifrele Oficiale Declarația Unică (Formular 212 SPV — {report?.fiscalYear || selectedYear})
            </h3>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowSpvGuide((v) => !v)}
              className="px-3 py-1.5 rounded bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-300 text-xs font-semibold flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
            >
              <HelpCircle className="w-3.5 h-3.5 text-amber-400" />
              <span>{showSpvGuide ? 'Ascunde Ghid SPV' : 'Ghid Completare SPV'}</span>
            </button>
            <button
              type="button"
              onClick={handleCopyAllDeclaration}
              className="px-3 py-1.5 rounded bg-amber-500 hover:bg-amber-400 text-black font-bold text-xs flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
            >
              <Copy className="w-3.5 h-3.5" />
              <span>{copiedKey === 'ALL_DECLARATION' ? 'Copiat!' : 'Copiază Toate Cifrele'}</span>
            </button>
          </div>
        </div>

        {/* 4 Metrici Principale Declarație */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div className="bg-black border border-zinc-800 rounded p-3 space-y-1">
            <div className="flex items-center justify-between text-[11px] text-zinc-400">
              <span>Venit Brut (Pozitive)</span>
              <button
                type="button"
                onClick={() => handleCopy('GROSS', report?.asymmetric.grossRevenueRON || 0)}
                className="text-cyan-400 hover:text-cyan-300 font-semibold cursor-pointer"
              >
                {copiedKey === 'GROSS' ? 'Copiat' : 'Copy'}
              </button>
            </div>
            <div className="text-xl font-black text-emerald-400 tabular-nums">
              {report ? formatRon(report.asymmetric.grossRevenueRON) : '0,00'} <span className="text-xs text-zinc-400">RON</span>
            </div>
            <div className="text-[10px] text-zinc-500 tabular-nums">
              Deductibile: -{report ? formatRon(report.asymmetric.deductibleExpensesRON) : '0,00'} RON
            </div>
          </div>

          <div className="bg-black border border-zinc-800 rounded p-3 space-y-1">
            <div className="flex items-center justify-between text-[11px] text-zinc-400">
              <span>Bază Impozabilă ANAF</span>
              <button
                type="button"
                onClick={() => handleCopy('NET', report?.asymmetric.netTaxableBaseRON || 0)}
                className="text-cyan-400 hover:text-cyan-300 font-semibold cursor-pointer"
              >
                {copiedKey === 'NET' ? 'Copiat' : 'Copy'}
              </button>
            </div>
            <div className="text-xl font-black text-amber-300 tabular-nums">
              {report ? formatRon(report.asymmetric.netTaxableBaseRON) : '0,00'} <span className="text-xs text-zinc-400">RON</span>
            </div>
            <div className="text-[10px] text-zinc-500 tabular-nums">
              {report?.profitableTransactionsCount || 0} pozitive · {report?.lossTransactionsCount || 0} pierderi (necompensate)
            </div>
          </div>

          <div className="bg-black border border-zinc-800 rounded p-3 space-y-1">
            <div className="flex items-center justify-between text-[11px] text-zinc-400">
              <span>Impozit ({taxRatePct}%) + CASS</span>
              <button
                type="button"
                onClick={() => handleCopy('TOTAL', report?.totalOwedToStateRON || 0)}
                className="text-cyan-400 hover:text-cyan-300 font-semibold cursor-pointer"
              >
                {copiedKey === 'TOTAL' ? 'Copiat' : 'Copy'}
              </button>
            </div>
            <div className="text-xl font-black text-rose-400 tabular-nums">
              {report ? report.totalOwedToStateRON.toLocaleString('ro-RO') : '0'} <span className="text-xs text-zinc-400">RON</span>
            </div>
            <div className="text-[10px] text-zinc-400 tabular-nums">
              Impozit {report?.asymmetric.incomeTaxRON || 0} RON + CASS {report?.cass.cassDueRON || 0} RON
            </div>
          </div>

          <div className="bg-black border border-zinc-800 rounded p-3 space-y-1">
            <div className="flex items-center justify-between text-[11px] text-zinc-400">
              <span>Eficiență YTD (incl. CASS)</span>
              {report?.ytdEfficiency.taxExceedsGain && (
                <span className="text-rose-400 font-bold text-[10px]">Alertă Fiscală</span>
              )}
            </div>
            <div
              className={`text-xl font-black tabular-nums ${
                (report?.ytdEfficiency.netAfterTaxRON ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'
              }`}
            >
              {report ? `${report.ytdEfficiency.netAfterTaxRON >= 0 ? '+' : ''}${formatRon(report.ytdEfficiency.netAfterTaxRON)}` : '0,00'}{' '}
              <span className="text-xs text-zinc-400">RON net</span>
            </div>
            <div className="text-[10px] text-zinc-400 tabular-nums">
              PnL Real: {report ? `${formatRon(report.ytdEfficiency.realNetPnLRON)} RON` : '—'} · Rată:{' '}
              {report?.ytdEfficiency.effectiveTaxRatePct !== null && report?.ytdEfficiency.effectiveTaxRatePct !== undefined
                ? `${report.ytdEfficiency.effectiveTaxRatePct}%`
                : 'N/A'}
            </div>
          </div>
        </div>

        {/* Bară progres CASS */}
        <div className="bg-black border border-zinc-800 rounded p-3 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="font-semibold text-zinc-300">
              Plafoane CASS (Salariu Minim: {minWageGrossRON.toLocaleString('ro-RO')} RON)
            </span>
            <span className="text-zinc-400 text-[11px]">{report?.cass.ceilingLabel}</span>
          </div>
          <div className="w-full h-2.5 bg-zinc-900 rounded-full overflow-hidden border border-zinc-800 relative">
            <div className="absolute top-0 bottom-0 left-[25%] w-px bg-zinc-700 z-10" />
            <div className="absolute top-0 bottom-0 left-[50%] w-px bg-zinc-700 z-10" />
            {(() => {
              const netVal = report?.asymmetric.netTaxableBaseRON || 0;
              const maxScale = (report?.cass.minWageThreshold24RON || 97200) * 1.05;
              const pct = Math.min(100, Math.max(0, (netVal / maxScale) * 100));
              return (
                <div
                  className="h-full bg-gradient-to-r from-emerald-500 via-sky-400 to-amber-500 transition-all duration-300"
                  style={{ width: `${pct}%` }}
                />
              );
            })()}
          </div>
          <div className="flex flex-wrap justify-between text-[10px] text-zinc-500 tabular-nums">
            <span>Prag 6 salarii: {report?.cass.minWageThreshold6RON.toLocaleString('ro-RO')} RON</span>
            <span>Prag 12 salarii: {report?.cass.minWageThreshold12RON.toLocaleString('ro-RO')} RON</span>
            <span>Prag 24 salarii: {report?.cass.minWageThreshold24RON.toLocaleString('ro-RO')} RON</span>
          </div>
        </div>

        {showSpvGuide && (
          <div className="bg-black border border-zinc-800 rounded p-3 text-xs text-zinc-300 space-y-1.5">
            <div className="font-bold text-amber-300">Ghid completare SPV ANAF (Formularul 212):</div>
            <ol className="list-decimal list-inside space-y-1 text-zinc-400 text-[11px]">
              <li>Descarcă Declarația Unică din contul SPV / anaf.ro (Secțiunea I — Venituri din Străinătate / Transfer monedă virtuală, Art. 116).</li>
              <li>
                Completează: Venit Brut <strong className="text-white">{report?.asymmetric.grossRevenueRON} RON</strong>, Cheltuieli Deductibile{' '}
                <strong className="text-white">{report?.asymmetric.deductibleExpensesRON} RON</strong>, Venit Net{' '}
                <strong className="text-white">{report?.asymmetric.netTaxableBaseRON} RON</strong>.
              </li>
              <li>
                Dacă Venitul Net depășește {report?.cass.minWageThreshold6RON.toLocaleString('ro-RO')} RON, bifează secțiunea CASS (contribuție calculată:{' '}
                <strong className="text-white">{report?.cass.cassDueRON} RON</strong>).
              </li>
              <li>Termen depunere și plată: <strong className="text-amber-300">{report?.filingDeadline}</strong>.</li>
            </ol>
          </div>
        )}
      </section>

      {/* =================================================================== */}
      {/* 3. TABEL PRINCIPAL: REZUMAT LUNAR + TOTAL PÂNĂ LA AZI (YTD)         */}
      {/* =================================================================== */}
      <section className="bg-zinc-950 border border-zinc-800 rounded p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 pb-2.5">
          <div>
            <h3 className="font-bold text-sm text-white flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-emerald-400" />
              <span>Rezumat Fiscal pe Luni Calendaristice ({report?.startDate || startDate} → {report?.endDate || 'azi'})</span>
            </h3>
            <p className="text-[11px] text-zinc-400 mt-0.5">
              Jurnalul detaliat nu este afișat implicit pentru performanță. Apasă <strong className="text-zinc-200">Vezi tranzacții</strong> pe orice lună pentru audit față de exportul OKX.
            </p>
          </div>
          <button
            type="button"
            onClick={() => handleOpenMonthAudit('ALL')}
            className="px-3 py-1.5 rounded bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-cyan-300 text-xs font-semibold flex items-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0"
          >
            <Eye className="w-3.5 h-3.5" />
            <span>Audit Toate Lunile ({report?.totalTransactionsCount || 0})</span>
          </button>
        </div>

        {isLoading && !report ? (
          <div className="p-8 text-center text-xs text-zinc-400">Se calculează rezumatul lunar ANAF...</div>
        ) : !report || report.monthlySummaries.length === 0 ? (
          <div className="bg-black border border-zinc-800 rounded p-6 text-center text-xs text-zinc-400 space-y-2">
            <p className="font-semibold text-amber-300">
              Nu există luni active pentru intervalul {startDate} — {selectedYear}.
            </p>
            <p>Sincronizează cu API OKX sau încarcă un fișier CSV din OKX.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-zinc-800 text-zinc-400 text-[11px]">
                  <th className="py-2.5 px-2.5 font-semibold">Lună</th>
                  <th className="py-2.5 px-2.5 font-semibold">Acoperire Date</th>
                  <th className="py-2.5 px-2.5 font-semibold text-right">Tranzacții</th>
                  <th className="py-2.5 px-2.5 font-semibold text-right">Profit / Pierdere / Com. (USD)</th>
                  <th className="py-2.5 px-2.5 font-semibold text-right">Bază &amp; Impozit ANAF (RON)</th>
                  <th className="py-2.5 px-2.5 font-semibold text-right">Eficiență Fiscală (Taxe vs. Real)</th>
                  <th className="py-2.5 px-2.5 font-semibold text-right">Audit OKX</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-900">
                {report.monthlySummaries.map((m: AnafMonthlySummary) => (
                  <tr key={m.yearMonth} className="hover:bg-zinc-900/50 transition-colors">
                    <td className="py-2.5 px-2.5 align-top">
                      <div className="font-bold text-white whitespace-nowrap">{m.monthLabel}</div>
                      <div className="text-[10px] text-zinc-500 tabular-nums">Win rate: {m.winRatePct}%</div>
                    </td>
                    <td className="py-2.5 px-2.5 align-top">
                      <div className={`text-[11px] font-semibold ${coverageBadgeStyle(m.coverageStatus)}`}>
                        {m.coverageLabel}
                      </div>
                      <div className="text-[10px] text-zinc-500 tabular-nums">
                        API: {m.sourcesBreakdown.okxApiBills} · CSV: {m.sourcesBreakdown.csvImport}
                      </div>
                    </td>
                    <td className="py-2.5 px-2.5 text-right align-top tabular-nums">
                      <div className="font-bold text-zinc-200">{m.transactionsCount}</div>
                      <div className="text-[10px] text-zinc-500">
                        <span className="text-emerald-400">+{m.profitableCount}</span> /{' '}
                        <span className="text-rose-400">-{m.lossCount}</span>
                      </div>
                    </td>
                    <td className="py-2.5 px-2.5 text-right align-top tabular-nums space-y-0.5">
                      <div className="text-emerald-400 font-semibold">+${m.totalProfitUSD.toFixed(2)}</div>
                      <div className="text-rose-400 font-semibold">${m.totalLossUSD.toFixed(2)}</div>
                      <div className="text-[10px] text-zinc-400">Com: -${m.totalFeesUSD.toFixed(2)}</div>
                    </td>
                    <td className="py-2.5 px-2.5 text-right align-top tabular-nums space-y-0.5">
                      <div className="text-zinc-200 font-semibold">{formatRon(m.netTaxableBaseRON)} RON</div>
                      <div className="text-[10px] text-zinc-500">
                        Brut {formatRon(m.grossRevenueRON)} · Ded -{formatRon(m.deductibleExpensesRON)}
                      </div>
                      <div className="text-xs font-bold text-rose-300">
                        Impozit {taxRatePct}%: {m.incomeTaxRON.toLocaleString('ro-RO')} RON
                      </div>
                    </td>
                    <td className="py-2.5 px-2.5 align-top">
                      <EfficiencyCell eff={m.efficiency} />
                    </td>
                    <td className="py-2.5 px-2.5 text-right align-top">
                      <button
                        type="button"
                        onClick={() => handleOpenMonthAudit(m.yearMonth)}
                        className="px-2.5 py-1.5 rounded bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-cyan-300 text-[11px] font-semibold inline-flex items-center gap-1 cursor-pointer whitespace-nowrap shrink-0"
                      >
                        <Eye className="w-3 h-3" />
                        <span>Vezi tranzacții ({m.transactionsCount})</span>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
              {/* RÂND FIX TOTAL PÂNĂ LA AZI (YTD) */}
              <tfoot>
                <tr className="border-t-2 border-emerald-500/50 bg-zinc-900/90">
                  <td className="py-3 px-2.5 align-top">
                    <div className="font-black text-emerald-300 whitespace-nowrap">TOTAL PÂNĂ LA AZI (YTD)</div>
                    <div className="text-[10px] text-zinc-400 tabular-nums">
                      {report.startDate} → {report.endDate}
                    </div>
                  </td>
                  <td className="py-3 px-2.5 align-top">
                    <div className="text-[11px] font-bold text-zinc-200">Total cumulat</div>
                    <div className="text-[10px] text-zinc-400">Curs: {report.usdRonRate.toFixed(4)} RON</div>
                  </td>
                  <td className="py-3 px-2.5 text-right align-top tabular-nums">
                    <div className="font-black text-white">{report.totalTransactionsCount}</div>
                    <div className="text-[10px] text-zinc-400">
                      <span className="text-emerald-400">+{report.profitableTransactionsCount}</span> /{' '}
                      <span className="text-rose-400">-{report.lossTransactionsCount}</span>
                    </div>
                  </td>
                  <td className="py-3 px-2.5 text-right align-top tabular-nums space-y-0.5">
                    <div className="text-emerald-400 font-bold">+${report.symmetric.totalProfitUSD.toFixed(2)}</div>
                    <div className="text-rose-400 font-bold">${report.symmetric.totalLossUSD.toFixed(2)}</div>
                    <div className="text-[10px] text-zinc-300">Com: -${report.symmetric.totalFeesUSD.toFixed(2)}</div>
                  </td>
                  <td className="py-3 px-2.5 text-right align-top tabular-nums space-y-0.5">
                    <div className="text-amber-300 font-black">{formatRon(report.asymmetric.netTaxableBaseRON)} RON</div>
                    <div className="text-[10px] text-zinc-400">
                      Imp {report.asymmetric.incomeTaxRON} + CASS {report.cass.cassDueRON} RON
                    </div>
                    <div className="text-xs font-black text-rose-400">
                      Total Stat: {report.totalOwedToStateRON.toLocaleString('ro-RO')} RON
                    </div>
                  </td>
                  <td className="py-3 px-2.5 align-top">
                    <EfficiencyCell eff={report.ytdEfficiency} includeCassNote />
                  </td>
                  <td className="py-3 px-2.5 text-right align-top">
                    <button
                      type="button"
                      onClick={() => handleOpenMonthAudit('ALL')}
                      className="px-2.5 py-1.5 rounded bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/40 text-emerald-300 text-[11px] font-bold inline-flex items-center gap-1 cursor-pointer whitespace-nowrap shrink-0"
                    >
                      <Layers className="w-3 h-3" />
                      <span>Audit YTD</span>
                    </button>
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </section>

      {/* =================================================================== */}
      {/* 3B. RECONCILIERE BOȚI NATIVI OKX GRID (LONG / SHORT / NEUTRAL)      */}
      {/* =================================================================== */}
      {report && report.nativeBotsReconciliation && report.nativeBotsReconciliation.length > 0 && (
        <section className="bg-zinc-950 border border-zinc-800 rounded p-4 space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 pb-2">
            <div>
              <h3 className="font-bold text-sm text-white flex items-center gap-2">
                <Layers className="w-4 h-4 text-cyan-400" />
                <span>Reconciliere Boți Nativi OKX Futures Grid (LONG / SHORT / NEUTRAL)</span>
              </h3>
              <p className="text-[11px] text-zinc-400 mt-0.5">
                Include boții BTC-USD UM X-PERP și ceilalți boți nativi deschiși manual pe OKX. Dacă există deja înregistrări <code className="text-zinc-300">OKX_BILL</code> în fereastra botului, acestea au prioritate contabilă fără dublare.
              </p>
            </div>
            <span className="text-[11px] text-zinc-400 tabular-nums">
              {report.nativeBotsReconciliation.length} boți reconciliați
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs tabular-nums">
              <thead>
                <tr className="border-b border-zinc-800 text-zinc-400 text-[11px]">
                  <th className="py-2 px-2">Algo ID</th>
                  <th className="py-2 px-2">Instrument</th>
                  <th className="py-2 px-2">Direcție</th>
                  <th className="py-2 px-2">Status</th>
                  <th className="py-2 px-2 text-right">Margin</th>
                  <th className="py-2 px-2 text-right">PnL Total</th>
                  <th className="py-2 px-2 text-right">Acoperire ANAF</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-900">
                {report.nativeBotsReconciliation.map((nb: AnafNativeBotReconciliationItem) => (
                  <tr key={nb.algoId} className="hover:bg-zinc-900/50">
                    <td className="py-2 px-2 font-mono text-[11px] text-zinc-400">{nb.algoId}</td>
                    <td className="py-2 px-2 font-semibold text-white whitespace-nowrap">{nb.instId}</td>
                    <td className="py-2 px-2 font-bold uppercase whitespace-nowrap">
                      <span
                        className={
                          nb.direction === 'long'
                            ? 'text-emerald-400'
                            : nb.direction === 'short'
                            ? 'text-rose-400'
                            : 'text-cyan-300'
                        }
                      >
                        {nb.direction}
                      </span>
                    </td>
                    <td className="py-2 px-2 text-zinc-300 uppercase text-[11px]">{nb.state}</td>
                    <td className="py-2 px-2 text-right text-zinc-200">${nb.investedMarginUSD.toFixed(2)}</td>
                    <td className={`py-2 px-2 text-right font-bold ${nb.totalPnlUSD >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {nb.totalPnlUSD >= 0 ? '+' : ''}${nb.totalPnlUSD.toFixed(2)}
                    </td>
                    <td className="py-2 px-2 text-right text-[11px]">
                      {nb.coveredByBills ? (
                        <span className="text-emerald-300 font-semibold">Inclus prin Bills OKX</span>
                      ) : nb.fallbackIncluded ? (
                        <span className="text-amber-300 font-semibold">Inclus Fallback Natív</span>
                      ) : (
                        <span className="text-zinc-500">Activ / PnL 0</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* =================================================================== */}
      {/* 4. JURNAL DETALIAT LA CERERE (PAGINAT PE BACKEND PENTRU AUDIT)      */}
      {/* =================================================================== */}
      {auditOpen && (
        <section className="bg-zinc-950 border border-cyan-500/40 rounded p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 pb-2.5">
            <div className="flex items-center gap-2">
              <Layers className="w-4 h-4 text-cyan-400" />
              <div>
                <h3 className="font-bold text-sm text-white">
                  Audit Tranzacții OKX Bills — {auditMonth === 'ALL' ? `Toate lunile (${startDate} → azi)` : auditMonth}
                </h3>
                <p className="text-[11px] text-zinc-400 tabular-nums">
                  {auditData ? `${auditData.totalCount} tranzacții potrivite · Curs activ: ${auditData.usdRonRate.toFixed(4)} RON` : 'Se încarcă...'}
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <select
                value={auditMonth}
                onChange={(e) => {
                  setAuditMonth(e.target.value);
                  setAuditPage(1);
                }}
                className="bg-zinc-900 border border-zinc-700 rounded px-2.5 py-1.5 text-xs text-white font-semibold"
              >
                <option value="ALL">Toate lunile ({report?.totalTransactionsCount || 0})</option>
                {(report?.monthlySummaries || []).map((m) => (
                  <option key={m.yearMonth} value={m.yearMonth}>
                    {m.monthLabel} ({m.transactionsCount})
                  </option>
                ))}
              </select>

              <div className="relative">
                <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={auditSearch}
                  onChange={(e) => {
                    setAuditSearch(e.target.value);
                    setAuditPage(1);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void fetchAuditTransactions({ page: 1 });
                  }}
                  placeholder="Caută simbol / billId..."
                  className="bg-black border border-zinc-700 rounded pl-8 pr-2.5 py-1.5 text-xs text-white w-44 focus:border-cyan-500 outline-none"
                />
              </div>

              <button
                type="button"
                onClick={() => void fetchAuditTransactions({ page: 1 })}
                className="px-2.5 py-1.5 rounded bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-xs text-cyan-300 font-semibold cursor-pointer whitespace-nowrap"
              >
                Caută
              </button>

              <div className="flex items-center bg-black border border-zinc-800 rounded p-0.5 text-[11px]">
                <button
                  type="button"
                  onClick={() => {
                    setAuditFilter('ALL');
                    setAuditPage(1);
                  }}
                  className={`px-2.5 py-1 rounded font-semibold cursor-pointer whitespace-nowrap ${
                    auditFilter === 'ALL' ? 'bg-amber-500 text-black' : 'text-zinc-400 hover:text-white'
                  }`}
                >
                  Toate
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAuditFilter('PROFIT');
                    setAuditPage(1);
                  }}
                  className={`px-2.5 py-1 rounded font-semibold cursor-pointer whitespace-nowrap ${
                    auditFilter === 'PROFIT' ? 'bg-emerald-500 text-black' : 'text-zinc-400 hover:text-white'
                  }`}
                >
                  Pozitive ({auditData?.profitableCount ?? 0})
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAuditFilter('LOSS');
                    setAuditPage(1);
                  }}
                  className={`px-2.5 py-1 rounded font-semibold cursor-pointer whitespace-nowrap ${
                    auditFilter === 'LOSS' ? 'bg-rose-600 text-white' : 'text-zinc-400 hover:text-white'
                  }`}
                >
                  Pierderi ({auditData?.lossCount ?? 0})
                </button>
              </div>

              <button
                type="button"
                onClick={() => setAuditOpen(false)}
                className="p-1.5 rounded bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-400 hover:text-white cursor-pointer"
                title="Închide audit"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {isLoadingAudit ? (
            <div className="p-6 text-center text-xs text-zinc-400">Se încarcă tranzacțiile din backend...</div>
          ) : !auditData || auditData.transactions.length === 0 ? (
            <div className="bg-black border border-zinc-800 rounded p-6 text-center text-xs text-zinc-400">
              Nu există tranzacții pentru filtrul selectat.
            </div>
          ) : (
            <>
              <div className="overflow-x-auto max-h-[55vh] overflow-y-auto pr-1">
                <table className="w-full text-left border-collapse text-[11px] tabular-nums">
                  <thead>
                    <tr className="border-b border-zinc-800 text-zinc-400 text-[10px] sticky top-0 bg-zinc-950">
                      <th className="py-2 px-2">Data (UTC)</th>
                      <th className="py-2 px-2">Bill ID / Sursă</th>
                      <th className="py-2 px-2">Instrument</th>
                      <th className="py-2 px-2">Sens</th>
                      <th className="py-2 px-2 text-right">Preț Exec.</th>
                      <th className="py-2 px-2 text-right">PnL USD</th>
                      <th className="py-2 px-2 text-right">Comision USD</th>
                      <th className="py-2 px-2 text-right">Curs BNR</th>
                      <th className="py-2 px-2 text-right">PnL RON</th>
                      <th className="py-2 px-2 text-right">Bază Impozabilă RON</th>
                      <th className="py-2 px-2 text-right">Statut ANAF</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-900">
                    {auditData.transactions.map((tx: AnafTransactionRecord) => (
                      <tr key={tx.id} className="hover:bg-zinc-900/60">
                        <td className="py-1.5 px-2 text-zinc-300 font-mono text-[10px] whitespace-nowrap">
                          {tx.dateFormatted}
                        </td>
                        <td className="py-1.5 px-2 font-mono text-[10px] text-zinc-400 truncate max-w-[160px]" title={tx.id}>
                          <span className="text-cyan-400">{tx.source}</span> · {tx.rawBillId || tx.id}
                        </td>
                        <td className="py-1.5 px-2 font-bold text-white whitespace-nowrap">{tx.symbol}</td>
                        <td className="py-1.5 px-2 whitespace-nowrap">
                          <span className={tx.side === 'BUY' ? 'text-emerald-300 font-semibold' : 'text-rose-300 font-semibold'}>
                            {tx.side}
                          </span>
                        </td>
                        <td className="py-1.5 px-2 text-right font-mono text-[10px] text-zinc-300">
                          {tx.exitPx || tx.entryPx ? `$${(tx.exitPx || tx.entryPx)!.toFixed(4)}` : '—'}
                        </td>
                        <td className={`py-1.5 px-2 text-right font-bold ${tx.pnlUSD >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                          {tx.pnlUSD >= 0 ? '+' : ''}${tx.pnlUSD.toFixed(4)}
                        </td>
                        <td className="py-1.5 px-2 text-right text-zinc-400">${tx.feeUSD.toFixed(4)}</td>
                        <td className="py-1.5 px-2 text-right text-cyan-300 font-mono text-[10px]">{tx.bnrRate.toFixed(4)}</td>
                        <td className={`py-1.5 px-2 text-right font-semibold ${tx.pnlRON >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                          {tx.pnlRON >= 0 ? '+' : ''}{tx.pnlRON.toFixed(2)} RON
                        </td>
                        <td className="py-1.5 px-2 text-right font-bold text-amber-300">
                          {tx.netTaxableGainRON > 0 ? `+${tx.netTaxableGainRON.toFixed(2)} RON` : '0.00 RON'}
                        </td>
                        <td className="py-1.5 px-2 text-right text-[10px] font-semibold whitespace-nowrap">
                          {tx.isProfit ? (
                            <span className="text-emerald-300">Impozabil</span>
                          ) : (
                            <span className="text-zinc-500">Necompensat</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Paginare Server */}
              <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-zinc-800 text-xs text-zinc-400 tabular-nums">
                <span>
                  Pagina <strong className="text-white">{auditData.page}</strong> din{' '}
                  <strong className="text-white">{auditData.totalPages}</strong> ({auditData.totalCount} total, 100/pagină)
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={auditData.page <= 1}
                    onClick={() => setAuditPage((p) => Math.max(1, p - 1))}
                    className="px-2.5 py-1 rounded bg-zinc-900 hover:bg-zinc-800 disabled:opacity-40 border border-zinc-700 text-zinc-200 flex items-center gap-1 cursor-pointer"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" />
                    <span>Anterior</span>
                  </button>
                  <button
                    type="button"
                    disabled={auditData.page >= auditData.totalPages}
                    onClick={() => setAuditPage((p) => Math.min(auditData.totalPages, p + 1))}
                    className="px-2.5 py-1 rounded bg-zinc-900 hover:bg-zinc-800 disabled:opacity-40 border border-zinc-700 text-zinc-200 flex items-center gap-1 cursor-pointer"
                  >
                    <span>Următor</span>
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </>
          )}
        </section>
      )}

      {/* =================================================================== */}
      {/* 5. MODAL ÎNCĂRCARE CSV OFICIAL OKX                                  */}
      {/* =================================================================== */}
      {showUploadModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div className="bg-zinc-950 border border-zinc-700 rounded-lg max-w-xl w-full p-4 space-y-3 shadow-2xl">
            <div className="flex items-center justify-between border-b border-zinc-800 pb-2">
              <div className="flex items-center gap-2">
                <Upload className="w-4 h-4 text-amber-400" />
                <h3 className="font-bold text-sm text-white">Încarcă CSV Istoric OKX (completare luni vechi &gt; 3 luni)</h3>
              </div>
              <button
                type="button"
                onClick={() => setShowUploadModal(false)}
                className="text-zinc-400 hover:text-white cursor-pointer font-bold px-2"
              >
                ✕
              </button>
            </div>

            <p className="text-xs text-zinc-400">
              Exportă fișierul din OKX (<code className="text-amber-300">Assets → Billing / Order History → Export</code>). Sistemul păstrează doar lunile mai vechi decât acoperirea API și elimină automat suprapunerile.
            </p>

            <div className="space-y-2">
              <input
                type="file"
                accept=".csv,text/csv,text/plain"
                ref={fileInputRef}
                onChange={handleFileInputChange}
                className="block w-full text-xs text-zinc-400 file:mr-3 file:py-1.5 file:px-3 file:rounded file:border file:border-zinc-700 file:text-xs file:font-bold file:bg-zinc-900 file:text-amber-300 hover:file:bg-zinc-800 cursor-pointer"
              />

              <div className="text-[11px] text-zinc-500">Sau lipește direct conținutul CSV:</div>
              <textarea
                value={csvUploadText}
                onChange={(e) => setCsvUploadText(e.target.value)}
                placeholder="Time,Instrument,Side,Price,Amount,Fee,Realized PnL..."
                rows={6}
                className="w-full bg-black border border-zinc-800 rounded p-2 text-xs text-zinc-200 font-mono focus:border-amber-500 outline-none"
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-zinc-800">
              <button
                type="button"
                onClick={handleClearCsv}
                className="px-3 py-1.5 rounded bg-rose-950/50 hover:bg-rose-900/80 border border-rose-500/40 text-rose-300 text-xs font-bold cursor-pointer"
              >
                Șterge CSV-ul importat
              </button>

              <div className="flex items-center gap-2 ml-auto">
                <button
                  type="button"
                  onClick={() => setShowUploadModal(false)}
                  className="px-3 py-1.5 rounded bg-zinc-900 hover:bg-zinc-800 text-zinc-300 text-xs font-bold cursor-pointer"
                >
                  Anulează
                </button>
                <button
                  type="button"
                  onClick={handleUploadCsvSubmit}
                  disabled={isUploadingCsv || !csvUploadText.trim()}
                  className="px-4 py-1.5 rounded bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-black font-bold text-xs cursor-pointer"
                >
                  {isUploadingCsv ? 'Se procesează...' : 'Importă Tranzacțiile'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
