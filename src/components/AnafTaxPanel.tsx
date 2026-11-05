import React, { useState, useEffect, useMemo, useRef } from 'react';
import { AnafTaxSummary, AnafTransactionRecord } from '../shared/types';
import { formatPrice } from '../shared/formatters';
import {
  FileText,
  DollarSign,
  TrendingUp,
  TrendingDown,
  AlertTriangle,
  CheckCircle2,
  Download,
  Upload,
  RefreshCw,
  Copy,
  Info,
  Calendar,
  Layers,
  HelpCircle,
  ShieldCheck,
  Percent,
} from 'lucide-react';

interface AnafTaxPanelProps {
  controlToken: string;
  onNotify: (banner: { type: 'success' | 'error' | 'info'; text: string }) => void;
}

export const AnafTaxPanel: React.FC<AnafTaxPanelProps> = ({ controlToken, onNotify }) => {
  const currentYear = new Date().getFullYear();
  const [selectedYear, setSelectedYear] = useState<number>(currentYear);
  const [taxRatePct, setTaxRatePct] = useState<number>(10); // 10% standard transfer monedă virtuală Cod Fiscal
  const [minWageGrossRON, setMinWageGrossRON] = useState<number>(4050); // 4050 RON în 2026
  const [customUsdRonRate, setCustomUsdRonRate] = useState<string>('');
  const [report, setReport] = useState<AnafTaxSummary | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [txFilter, setTxFilter] = useState<'ALL' | 'PROFIT' | 'LOSS'>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [copiedKey, setCopiedKey] = useState<string>('');
  const [showUploadModal, setShowUploadModal] = useState<boolean>(false);
  const [csvUploadText, setCsvUploadText] = useState<string>('');
  const [isUploadingCsv, setIsUploadingCsv] = useState<boolean>(false);
  const [sourceFilter, setSourceFilter] = useState<'ALL' | 'OKX_API' | 'GRID' | 'CSV'>('ALL');
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const fetchTaxReport = async (forceSync: boolean = false) => {
    if (forceSync) {
      setIsSyncing(true);
    } else {
      setIsLoading(true);
    }
    try {
      const endpoint = forceSync ? '/api/bot/fiscal/sync' : '/api/bot/fiscal/report';
      const queryParams = new URLSearchParams({
        year: String(selectedYear),
        taxRate: String(taxRatePct),
        minWage: String(minWageGrossRON),
      });
      if (customUsdRonRate && !isNaN(parseFloat(customUsdRonRate))) {
        queryParams.set('usdRonRate', customUsdRonRate);
      }

      let res: Response;
      if (forceSync) {
        res = await fetch('/api/bot/fiscal/sync', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-bot-token': controlToken,
          },
          body: JSON.stringify({
            year: selectedYear,
            taxRate: taxRatePct,
            minWage: minWageGrossRON,
            usdRonRate: customUsdRonRate ? parseFloat(customUsdRonRate) : undefined,
          }),
        });
      } else {
        res = await fetch(`/api/bot/fiscal/report?${queryParams.toString()}`);
      }

      const data = await res.json();
      if (data?.success && data.report) {
        setReport(data.report);
        if (!customUsdRonRate && data.report.usdRonRate) {
          setCustomUsdRonRate(String(data.report.usdRonRate));
        }
        if (forceSync) {
          onNotify({
            type: 'success',
            text: data.message || 'Datele fiscale și istoricul OKX API au fost sincronizate cu succes!',
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
  };

  useEffect(() => {
    fetchTaxReport(false);
  }, [selectedYear, taxRatePct, minWageGrossRON]);

  const handleCopy = (key: string, val: string | number) => {
    try {
      navigator.clipboard.writeText(String(val));
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(''), 2500);
      onNotify({
        type: 'info',
        text: `Copiat în clipboard: ${val}`,
      });
    } catch {}
  };

  const handleCopyAllDeclaration = () => {
    if (!report) return;
    const g = report.spvDeclarationGuide;
    const text = [
      `--- DATE DECLARAȚIA UNICĂ ${report.fiscalYear} (AutoTrade-v5) ---`,
      `Secțiunea: ${g.section}`,
      `Categoria: ${g.category}`,
      `1. Venit Brut: ${g.boxGrossRevenueRON.toFixed(2)} RON`,
      `2. Cheltuieli Deductibile: ${g.boxDeductibleExpensesRON.toFixed(2)} RON`,
      `3. Venit Net (Baza Impozabilă): ${g.boxNetTaxableBaseRON.toFixed(2)} RON`,
      `4. Impozit pe Venit (${report.taxRatePct}%): ${g.boxIncomeTaxDueRON} RON`,
      `5. CASS Datorat (Sănătate): ${g.boxCassDueRON} RON`,
      `TOTAL DATORAT BUGET STAT: ${g.boxTotalDueRON} RON`,
      `Termen legal plată & depunere: ${report.filingDeadline}`,
    ].join('\n');
    handleCopy('ALL_DECLARATION', text);
  };

  const handleDownloadCsv = () => {
    const q = new URLSearchParams({
      year: String(selectedYear),
      taxRate: String(taxRatePct),
      minWage: String(minWageGrossRON),
    });
    if (customUsdRonRate) q.set('usdRonRate', customUsdRonRate);
    window.open(`/api/bot/fiscal/export-csv?${q.toString()}`, '_blank');
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
          text: data.message || `Au fost importate ${data.importedCount} tranzacții din CSV.`,
        });
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

  const filteredTransactions = useMemo(() => {
    if (!report?.transactions) return [];
    let list = report.transactions;
    if (txFilter === 'PROFIT') {
      list = list.filter((t) => t.isProfit);
    } else if (txFilter === 'LOSS') {
      list = list.filter((t) => !t.isProfit);
    }
    if (sourceFilter === 'OKX_API') {
      list = list.filter((t) => t.source === 'OKX_API');
    } else if (sourceFilter === 'GRID') {
      list = list.filter((t) => t.source === 'GRID_ARBITRAGE' || t.source === 'BOT_ORDER');
    } else if (sourceFilter === 'CSV') {
      list = list.filter((t) => t.source === 'CSV_IMPORT');
    }
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toUpperCase();
      list = list.filter(
        (t) =>
          t.symbol.toUpperCase().includes(q) ||
          t.id.toUpperCase().includes(q) ||
          t.closeType.toUpperCase().includes(q)
      );
    }
    return list;
  }, [report?.transactions, txFilter, sourceFilter, searchQuery]);

  return (
    <div className="space-y-3 p-1">
      {/* =================================================================== */}
      {/* 1. HEADER BANNER: MODUL FISCAL ANAF & DECLARAȚIA UNICĂ              */}
      {/* =================================================================== */}
      <div className="bg-zinc-950 border-2 border-emerald-500/50 rounded p-3.5 space-y-2 shadow-[0_0_15px_rgba(16,185,129,0.15)]">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-emerald-500/30 pb-2.5">
          <div className="flex items-center space-x-2.5">
            <div className="p-2 bg-emerald-500/20 border border-emerald-400/40 rounded">
              <FileText className="w-5 h-5 text-emerald-300" />
            </div>
            <div>
              <h2 className="font-black text-sm text-white tracking-wide flex items-center gap-2">
                <span>🇷🇴 MODUL FISCAL ANAF &amp; DECLARAȚIA UNICĂ ({selectedYear} / TERMEN MAI {selectedYear + 1})</span>
                <span className="px-2 py-0.5 rounded text-[10px] font-black bg-emerald-500 text-black">
                  LEGISLAȚIE ROMÂNIA (ART. 116 COD FISCAL)
                </span>
              </h2>
              <p className="text-[11px] text-zinc-400 mt-0.5">
                Monitorizare în timp real din API-ul OKX a veniturilor din tranzacționare futures/perpetuals.
                Aplică automat <strong>Regula Asimetrică ANAF</strong> (fără compensare pierderi), conversia la <strong>Cursul BNR</strong>, deducerea comisioanelor și calculul plafoanelor <strong>CASS</strong> (Sănătate).
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => fetchTaxReport(true)}
              disabled={isSyncing}
              className="px-3 py-1.5 rounded bg-cyan-500 hover:bg-cyan-400 disabled:opacity-50 text-black font-black text-xs flex items-center space-x-1.5 cursor-pointer shadow-[0_0_10px_rgba(6,182,212,0.3)]"
              title="Interoghează API-ul OKX pentru toate fills și actualizează cursul BNR"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin' : ''}`} />
              <span>{isSyncing ? 'Se sincronizează OKX...' : 'Sincronizează API OKX & Curs BNR'}</span>
            </button>
            <button
              type="button"
              onClick={handleDownloadCsv}
              className="px-3 py-1.5 rounded bg-zinc-900 hover:bg-zinc-800 text-emerald-300 border border-emerald-500/40 font-bold text-xs flex items-center space-x-1.5 cursor-pointer"
              title="Descarcă raportul complet formatat pentru contabil"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Descarcă Raport .CSV</span>
            </button>
            <button
              type="button"
              onClick={() => setShowUploadModal(true)}
              className="px-3 py-1.5 rounded bg-zinc-900 hover:bg-zinc-800 text-amber-300 border border-amber-500/40 font-bold text-xs flex items-center space-x-1.5 cursor-pointer"
              title="Importă un fișier CSV descărcat din contul OKX"
            >
              <Upload className="w-3.5 h-3.5" />
              <span>Încarcă CSV OKX</span>
            </button>
          </div>
        </div>

        {/* BARA DE CONTROL: AN FISCAL, COTA IMPOZIT, SALARIU MINIM, CURS BNR */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5 pt-1 text-xs">
          <div className="bg-black border border-zinc-800 rounded p-2">
            <label className="text-[10px] text-zinc-400 block mb-1 font-bold flex items-center space-x-1">
              <Calendar className="w-3 h-3 text-cyan-400" />
              <span>1. An Fiscal (Generare Declarație)</span>
            </label>
            <select
              value={selectedYear}
              onChange={(e) => setSelectedYear(parseInt(e.target.value, 10))}
              className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-white font-bold"
            >
              <option value={2026}>Anul 2026 (Depunere până la 25 Mai 2027) [Curent]</option>
              <option value={2025}>Anul 2025 (Depunere până la 25 Mai 2026)</option>
              <option value={2027}>Anul 2027 (Depunere până la 25 Mai 2028)</option>
            </select>
          </div>

          <div className="bg-black border border-zinc-800 rounded p-2">
            <label className="text-[10px] text-zinc-400 block mb-1 font-bold flex items-center space-x-1">
              <Percent className="w-3 h-3 text-emerald-400" />
              <span>2. Cotă Impozit pe Venit</span>
            </label>
            <div className="grid grid-cols-2 gap-1">
              <button
                type="button"
                onClick={() => setTaxRatePct(10)}
                className={`py-1 px-1.5 rounded text-[11px] font-black cursor-pointer border ${
                  taxRatePct === 10
                    ? 'bg-emerald-500 text-black border-emerald-400'
                    : 'bg-zinc-900 text-zinc-300 border-zinc-700 hover:text-white'
                }`}
                title="Cota standard conform Art. 116 din Codul Fiscal (Transferul de monedă virtuală)"
              >
                10% (Art. 116 Crypto) ★
              </button>
              <button
                type="button"
                onClick={() => setTaxRatePct(16)}
                className={`py-1 px-1.5 rounded text-[11px] font-black cursor-pointer border ${
                  taxRatePct === 16
                    ? 'bg-amber-500 text-black border-amber-400'
                    : 'bg-zinc-900 text-zinc-300 border-zinc-700 hover:text-white'
                }`}
                title="Cota generală pentru alte venituri financiare sau derivate nereglementate"
              >
                16% (Alte Venituri)
              </button>
            </div>
          </div>

          <div className="bg-black border border-zinc-800 rounded p-2">
            <label className="text-[10px] text-zinc-400 block mb-1 font-bold flex items-center space-x-1">
              <ShieldCheck className="w-3 h-3 text-amber-400" />
              <span>3. Salariu Minim Brut (Plafoane CASS)</span>
            </label>
            <div className="flex items-center space-x-1.5">
              <input
                type="number"
                value={minWageGrossRON}
                onChange={(e) => setMinWageGrossRON(parseFloat(e.target.value) || 4050)}
                className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-amber-300 font-bold"
              />
              <span className="text-[10px] text-zinc-400 font-bold">RON</span>
            </div>
          </div>

          <div className="bg-black border border-zinc-800 rounded p-2">
            <label className="text-[10px] text-zinc-400 block mb-1 font-bold flex items-center justify-between">
              <span className="flex items-center space-x-1">
                <DollarSign className="w-3 h-3 text-cyan-400" />
                <span>4. Curs BNR USD / RON</span>
              </span>
              <span className="text-[9px] text-emerald-400">{report?.ratesSource || 'BNR Live'}</span>
            </label>
            <div className="flex items-center space-x-1.5">
              <input
                type="number"
                step="0.0001"
                value={customUsdRonRate}
                onChange={(e) => setCustomUsdRonRate(e.target.value)}
                placeholder="4.6200"
                className="w-full bg-zinc-900 border border-cyan-500/40 rounded px-2 py-1 text-cyan-300 font-bold"
              />
              <button
                type="button"
                onClick={() => fetchTaxReport(false)}
                className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-cyan-300 text-[10px] font-bold cursor-pointer shrink-0"
              >
                Aplică
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* =================================================================== */}
      {/* 1.5. SINCRONIZARE AUTOMATĂ OKX API (ARCHIVE & ORDERS HISTORY)       */}
      {/* =================================================================== */}
      <div className="bg-zinc-950 border border-cyan-500/40 rounded p-3 space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 pb-2">
          <div className="flex items-center space-x-2">
            <RefreshCw className="w-4 h-4 text-cyan-400" />
            <h3 className="font-bold text-xs text-white flex items-center gap-2">
              <span>⚡ SINCRONIZARE DIRECTĂ OKX API (ARHIVĂ, COMENZI EXECUTATE &amp; COMISIOANE)</span>
              <span className="px-1.5 py-0.5 rounded text-[9px] font-black bg-cyan-500/20 text-cyan-300 border border-cyan-500/40">
                PROTECȚIE SESIUNI PREVIEW &amp; RECONCILIERE 100%
              </span>
            </h3>
          </div>

          <div className="flex items-center space-x-2">
            <span className="text-[10px] text-zinc-400">
              Ultima sincronizare OKX:{' '}
              <strong className="text-zinc-200">
                {report?.okxApiSyncStatus?.lastSyncedAt
                  ? new Date(report.okxApiSyncStatus.lastSyncedAt).toLocaleTimeString()
                  : 'Niciuna recentă'}
              </strong>
            </span>
            <button
              type="button"
              onClick={() => fetchTaxReport(true)}
              disabled={isSyncing}
              className="px-3 py-1 rounded bg-cyan-400 hover:bg-cyan-300 disabled:opacity-50 text-black font-black text-xs flex items-center space-x-1 cursor-pointer shadow"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin' : ''}`} />
              <span>{isSyncing ? 'Se descarcă din OKX...' : '⚡ Sincronizează Complet cu OKX API (Archive & Fills)'}</span>
            </button>
          </div>
        </div>

        {/* ENDPOINTS INTEROGATE & PERSISTENȚĂ */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-2 text-xs">
          <div className="bg-black/80 border border-zinc-800 rounded p-2 space-y-1">
            <div className="text-[10px] text-zinc-400 font-bold flex items-center space-x-1">
              <span className="text-cyan-400 font-mono">1.</span>
              <span>/trade/orders-history-archive</span>
            </div>
            <div className="text-sm font-black text-cyan-300 tabular-nums">
              {report?.okxApiSyncStatus?.totalOrdersFromArchive || 0}{' '}
              <span className="text-[10px] text-zinc-500 font-normal">comenzi</span>
            </div>
            <p className="text-[10px] text-zinc-400 leading-tight">
              Arhivă OKX pentru comenzi mai vechi de 3 luni (până la 3 ani).
            </p>
          </div>

          <div className="bg-black/80 border border-zinc-800 rounded p-2 space-y-1">
            <div className="text-[10px] text-zinc-400 font-bold flex items-center space-x-1">
              <span className="text-cyan-400 font-mono">2.</span>
              <span>/trade/orders-history</span>
            </div>
            <div className="text-sm font-black text-white tabular-nums">
              {report?.okxApiSyncStatus?.totalOrdersFromHistory || 0}{' '}
              <span className="text-[10px] text-zinc-500 font-normal">comenzi</span>
            </div>
            <p className="text-[10px] text-zinc-400 leading-tight">
              Comenzi executate recente în ultimele 3 luni (cu preț intrare/ieșire).
            </p>
          </div>

          <div className="bg-black/80 border border-zinc-800 rounded p-2 space-y-1">
            <div className="text-[10px] text-zinc-400 font-bold flex items-center space-x-1">
              <span className="text-emerald-400 font-mono">3.</span>
              <span>/account/bills-archive &amp; bills</span>
            </div>
            <div className="text-sm font-black text-emerald-300 tabular-nums">
              {report?.okxApiSyncStatus?.totalBillsFromArchive || 0}{' '}
              <span className="text-[10px] text-zinc-500 font-normal">extrase cont</span>
            </div>
            <p className="text-[10px] text-zinc-400 leading-tight">
              Registru contabil oficial OKX: comisioane plătite și PnL realizat.
            </p>
          </div>

          <div className="bg-black/80 border border-amber-500/30 rounded p-2 space-y-1">
            <div className="text-[10px] text-amber-300 font-bold flex items-center space-x-1">
              <span className="text-amber-400 font-mono">4.</span>
              <span>Cache Persistent Anti-Pierdere</span>
            </div>
            <div className="text-sm font-black text-amber-300 tabular-nums">
              {report?.persistentCacheCount || 0}{' '}
              <span className="text-[10px] text-zinc-400 font-normal">pe disc (.data/)</span>
            </div>
            <p className="text-[10px] text-zinc-400 leading-tight">
              Salvat permanent pe disc. Nu se pierde la restart sau reload preview!
            </p>
          </div>
        </div>

        {report?.okxApiSyncStatus?.errorMessage && (
          <div className="bg-rose-950/40 border border-rose-500/40 rounded p-2 text-rose-300 text-xs flex items-center space-x-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>{report.okxApiSyncStatus.errorMessage}</span>
          </div>
        )}
      </div>

      {/* =================================================================== */}
      {/* 2. CARTELA OFICIALĂ A DECLARAȚIEI UNICE (SPV - FORMULARUL 212)      */}
      {/* =================================================================== */}
      <div className="bg-zinc-950 border-2 border-amber-500/50 rounded p-4 space-y-3 shadow-lg">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-500/30 pb-2">
          <div className="flex items-center space-x-2">
            <FileText className="w-4 h-4 text-amber-400" />
            <h3 className="font-black text-xs sm:text-sm text-amber-300 tracking-wide">
              📋 CIFRELE OFICIALE PENTRU DECLARAȚIA UNICĂ (FORMULARUL 212 SPV — ANUL {report?.fiscalYear || selectedYear})
            </h3>
          </div>

          <div className="flex items-center space-x-2">
            <span className="text-[11px] text-zinc-400">
              Termen limită plată &amp; depunere:{' '}
              <strong className="text-amber-300">{report?.filingDeadline || `25 Mai ${selectedYear + 1}`}</strong>
            </span>
            <button
              type="button"
              onClick={handleCopyAllDeclaration}
              className="px-3 py-1 rounded bg-amber-500 hover:bg-amber-400 text-black font-black text-xs flex items-center space-x-1 cursor-pointer shadow"
            >
              <Copy className="w-3.5 h-3.5" />
              <span>{copiedKey === 'ALL_DECLARATION' ? '✓ Copiat Tot!' : 'Copiază Toate Cifrele Declarației'}</span>
            </button>
          </div>
        </div>

        {/* 3 CIFRE MARI DE BAZĂ (ANAF) */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {/* 1. VENIT BRUT */}
          <div className="bg-black/90 border border-emerald-500/40 rounded p-3 space-y-1 relative">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-zinc-400 font-bold uppercase tracking-wider">
                1. Venit Brut (Căsuța ANAF)
              </span>
              <button
                type="button"
                onClick={() => handleCopy('GROSS', report?.asymmetric.grossRevenueRON || 0)}
                className="text-[10px] text-cyan-400 hover:text-cyan-300 font-bold cursor-pointer"
              >
                {copiedKey === 'GROSS' ? '✓ Copiat' : 'Copy'}
              </button>
            </div>
            <div className="text-2xl font-black text-emerald-400 tabular-nums">
              {report ? report.asymmetric.grossRevenueRON.toLocaleString(undefined, { minimumFractionDigits: 2 }) : '0.00'} <span className="text-xs text-zinc-400">RON</span>
            </div>
            <p className="text-[10px] text-zinc-400 leading-tight">
              Suma totală a profiturilor brute din toate tranzacțiile închise pe plus în {selectedYear} (fără scăderea pierderilor).
            </p>
          </div>

          {/* 2. CHELTUIELI DEDUCTIBILE */}
          <div className="bg-black/90 border border-zinc-700 rounded p-3 space-y-1 relative">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-zinc-400 font-bold uppercase tracking-wider">
                2. Cheltuieli Deductibile
              </span>
              <button
                type="button"
                onClick={() => handleCopy('EXPENSES', report?.asymmetric.deductibleExpensesRON || 0)}
                className="text-[10px] text-cyan-400 hover:text-cyan-300 font-bold cursor-pointer"
              >
                {copiedKey === 'EXPENSES' ? '✓ Copiat' : 'Copy'}
              </button>
            </div>
            <div className="text-2xl font-black text-zinc-200 tabular-nums">
              {report ? report.asymmetric.deductibleExpensesRON.toLocaleString(undefined, { minimumFractionDigits: 2 }) : '0.00'} <span className="text-xs text-zinc-400">RON</span>
            </div>
            <p className="text-[10px] text-zinc-400 leading-tight">
              Comisioanele de tranzacționare (trading fees) oprite de OKX aferente tranzacțiilor pe plus.
            </p>
          </div>

          {/* 3. VENIT NET (BAZA IMPOZABILĂ) */}
          <div className="bg-black/90 border border-amber-500/50 rounded p-3 space-y-1 relative">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-amber-300 font-bold uppercase tracking-wider">
                3. Venit Net (Baza Impozabilă)
              </span>
              <button
                type="button"
                onClick={() => handleCopy('NET', report?.asymmetric.netTaxableBaseRON || 0)}
                className="text-[10px] text-cyan-400 hover:text-cyan-300 font-bold cursor-pointer"
              >
                {copiedKey === 'NET' ? '✓ Copiat' : 'Copy'}
              </button>
            </div>
            <div className="text-2xl font-black text-amber-300 tabular-nums">
              {report ? report.asymmetric.netTaxableBaseRON.toLocaleString(undefined, { minimumFractionDigits: 2 }) : '0.00'} <span className="text-xs text-zinc-400">RON</span>
            </div>
            <p className="text-[10px] text-zinc-400 leading-tight">
              Venit Brut minus Cheltuieli Deductibile. Aceasta este suma pe care se aplică impozitul de {taxRatePct}%.
            </p>
          </div>
        </div>

        {/* 3 CASETE: IMPOZIT PE VENIT, CASS SI TOTAL DE PLATĂ */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-1">
          {/* IMPOZIT DATORAT */}
          <div className="bg-zinc-900/80 border border-rose-500/40 rounded p-3 space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-rose-300 font-bold uppercase">
                Impozit pe Venit Datorat ({taxRatePct}%)
              </span>
              <button
                type="button"
                onClick={() => handleCopy('TAX', report?.asymmetric.incomeTaxRON || 0)}
                className="text-[10px] text-cyan-400 hover:text-cyan-300 font-bold cursor-pointer"
              >
                {copiedKey === 'TAX' ? '✓ Copiat' : 'Copy'}
              </button>
            </div>
            <div className="text-xl font-black text-rose-400 tabular-nums">
              {report ? report.asymmetric.incomeTaxRON.toLocaleString() : '0'} <span className="text-xs text-zinc-400">RON</span>
            </div>
            <div className="text-[9px] text-zinc-400">
              {taxRatePct}% din Venitul Net ({report?.asymmetric.netTaxableBaseRON || 0} RON)
            </div>
          </div>

          {/* CASS DATORAT */}
          <div className="bg-zinc-900/80 border border-sky-500/40 rounded p-3 space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-sky-300 font-bold uppercase">
                CASS Datorat (Sănătate)
              </span>
              <button
                type="button"
                onClick={() => handleCopy('CASS', report?.cass.cassDueRON || 0)}
                className="text-[10px] text-cyan-400 hover:text-cyan-300 font-bold cursor-pointer"
              >
                {copiedKey === 'CASS' ? '✓ Copiat' : 'Copy'}
              </button>
            </div>
            <div className="text-xl font-black text-sky-300 tabular-nums">
              {report ? report.cass.cassDueRON.toLocaleString() : '0'} <span className="text-xs text-zinc-400">RON</span>
            </div>
            <div className="text-[9px] text-zinc-400 truncate" title={report?.cass.ceilingLabel}>
              {report?.cass.ceilingLabel || 'Se calculează...'}
            </div>
          </div>

          {/* TOTAL DATORAT LA STAT */}
          <div className="bg-emerald-950/30 border-2 border-emerald-500 rounded p-3 space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-emerald-300 font-black uppercase tracking-wider">
                TOTAL DE PLATĂ LA BUGETUL DE STAT
              </span>
              <button
                type="button"
                onClick={() => handleCopy('TOTAL', report?.totalOwedToStateRON || 0)}
                className="text-[10px] text-cyan-400 hover:text-cyan-300 font-bold cursor-pointer"
              >
                {copiedKey === 'TOTAL' ? '✓ Copiat' : 'Copy'}
              </button>
            </div>
            <div className="text-2xl font-black text-emerald-300 tabular-nums">
              {report ? report.totalOwedToStateRON.toLocaleString() : '0'} <span className="text-xs text-zinc-300">RON</span>
            </div>
            <div className="text-[10px] text-emerald-400 font-bold">
              Impozit ({report?.asymmetric.incomeTaxRON || 0} RON) + CASS ({report?.cass.cassDueRON || 0} RON)
            </div>
          </div>
        </div>

        {/* GHID RAPID PAS CU PAS PENTRU SPV */}
        <div className="bg-black/60 border border-zinc-800 rounded p-3 text-[11px] text-zinc-300 space-y-1.5">
          <div className="font-bold text-amber-300 flex items-center space-x-1.5">
            <HelpCircle className="w-3.5 h-3.5 text-amber-400" />
            <span>Ghid completare SPV (Spațiul Privat Virtual ANAF — Formularul 212):</span>
          </div>
          <ol className="list-decimal list-inside space-y-1 text-zinc-400 text-[10px]">
            <li>
              Descarcă PDF-ul inteligent al Declarației Unice de pe <code className="text-amber-300">anaf.ro</code> sau completează formularul online din contul tău SPV.
            </li>
            <li>
              Mergi la <strong>Secțiunea 1: Date privind veniturile realizate din Străinătate</strong> (sau din România, în funcție de rezidența contului OKX EEA).
            </li>
            <li>
              La Categoria de venit, selectează: <strong className="text-white">Transferul de monedă virtuală</strong> (Art. 116 Cod Fiscal).
            </li>
            <li>
              Copiază cele 3 valori de mai sus: <strong>Venit Brut</strong> ({report?.asymmetric.grossRevenueRON} RON), <strong>Cheltuieli Deductibile</strong> ({report?.asymmetric.deductibleExpensesRON} RON) și <strong>Venit Net</strong> ({report?.asymmetric.netTaxableBaseRON} RON).
            </li>
            <li>
              Dacă Venitul Net depășește 6 salarii minime ({report?.cass.minWageThreshold6RON.toLocaleString()} RON), bifează secțiunea de <strong>CASS</strong> unde declarația va calcula automat contribuția fixă datorată ({report?.cass.cassDueRON} RON).
            </li>
            <li>
              Apasă <strong>Validează</strong>, semnează documentul și trimite-l. Plata se efectuează în contul unic până la <strong>{report?.filingDeadline}</strong>.
            </li>
          </ol>
        </div>
      </div>

      {/* =================================================================== */}
      {/* 3. MONITORIZARE PLAFOANE CASS (SĂNĂTATE) — BARA VIZUALĂ DE PROGRES */}
      {/* =================================================================== */}
      <div className="bg-zinc-950 border border-sky-500/40 rounded p-3.5 space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-sky-500/30 pb-2">
          <div className="flex items-center space-x-2">
            <ShieldCheck className="w-4 h-4 text-sky-400" />
            <h3 className="font-bold text-xs text-sky-300">
              🩺 MONITORIZARE PLAFOANE CASS 2026 (SALARIU MINIM: {minWageGrossRON.toLocaleString()} RON)
            </h3>
          </div>
          <span className="text-[11px] text-zinc-400">
            Nivel curent: <strong className="text-white">{report?.cass.ceilingLabel}</strong>
          </span>
        </div>

        {/* BARA VIZUALA MULTI-SEGMENT */}
        <div className="space-y-1.5">
          <div className="flex justify-between items-center text-[10px] text-zinc-400">
            <span>0 RON</span>
            <span className={report && report.asymmetric.netTaxableBaseRON >= report.cass.minWageThreshold6RON ? 'text-amber-400 font-bold' : ''}>
              Prag 1 (6 salarii): {report?.cass.minWageThreshold6RON.toLocaleString()} RON (CASS: 2.430 RON)
            </span>
            <span className={report && report.asymmetric.netTaxableBaseRON >= report.cass.minWageThreshold12RON ? 'text-amber-400 font-bold' : ''}>
              Prag 2 (12 salarii): {report?.cass.minWageThreshold12RON.toLocaleString()} RON (CASS: 4.860 RON)
            </span>
            <span className={report && report.asymmetric.netTaxableBaseRON >= report.cass.minWageThreshold24RON ? 'text-rose-400 font-bold' : ''}>
              Prag 3 (24 salarii): {report?.cass.minWageThreshold24RON.toLocaleString()} RON (CASS: 9.720 RON Max)
            </span>
          </div>

          <div className="w-full h-3 bg-zinc-900 rounded-full overflow-hidden border border-zinc-800 relative">
            {/* Markers */}
            <div className="absolute top-0 bottom-0 left-[25%] w-0.5 bg-zinc-700 z-10" />
            <div className="absolute top-0 bottom-0 left-[50%] w-0.5 bg-zinc-700 z-10" />
            <div className="absolute top-0 bottom-0 left-[100%] w-0.5 bg-zinc-700 z-10" />

            {/* Filled bar */}
            {(() => {
              const netVal = report?.asymmetric.netTaxableBaseRON || 0;
              const maxScale = (report?.cass.minWageThreshold24RON || 97200) * 1.05;
              const pct = Math.min(100, Math.max(0, (netVal / maxScale) * 100));
              return (
                <div
                  className="h-full bg-gradient-to-r from-emerald-500 via-sky-400 to-amber-500 transition-all duration-500"
                  style={{ width: `${pct}%` }}
                />
              );
            })()}
          </div>

          <div className="flex justify-between items-center text-[10px] text-zinc-400 pt-0.5">
            <span>
              Venit Net Curent: <strong className="text-amber-300">{report?.asymmetric.netTaxableBaseRON.toLocaleString()} RON</strong>
            </span>
            {report && report.cass.remainingUntilNextCeilingRON > 0 ? (
              <span className="text-sky-300">
                Mai ai <strong>{report.cass.remainingUntilNextCeilingRON.toLocaleString()} RON</strong> până la următorul plafon CASS
              </span>
            ) : (
              <span className="text-rose-400 font-bold">Ai atins plafonul maxim CASS (24 salarii)</span>
            )}
          </div>
        </div>
      </div>

      {/* =================================================================== */}
      {/* 4. ANALIZĂ ASIMETRIE FISCALĂ (ANAF VS PNL REAL PORTOFOLIU CRYPTO)   */}
      {/* =================================================================== */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {/* STANGA: REGULA ASIMETRICA ANAF */}
        <div className="bg-zinc-950 border border-amber-500/40 rounded p-3 space-y-2">
          <div className="flex items-center justify-between border-b border-zinc-800 pb-1.5">
            <span className="text-xs font-black text-amber-300 flex items-center space-x-1.5">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
              <span>REGULA ASIMETRICĂ ANAF (LEGISLAȚIE ROMÂNIA)</span>
            </span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 font-bold">
              Obligatoriu Legal
            </span>
          </div>
          <p className="text-[10px] text-zinc-400">
            Conform Codului Fiscal, pierderile din tranzacționarea crypto NU se compensează cu profiturile. Fiecare tranzacție pe plus generează venit impozabil:
          </p>
          <div className="space-y-1 text-xs">
            <div className="flex justify-between">
              <span className="text-zinc-400">Tranzacții pe plus:</span>
              <strong className="text-emerald-400">{report?.profitableTransactionsCount || 0} execuții</strong>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-400">Venit Brut Impozabil:</span>
              <strong className="text-white">{report?.asymmetric.grossRevenueRON.toLocaleString()} RON</strong>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-400">Comisioane Deductibile:</span>
              <strong className="text-zinc-300">-{report?.asymmetric.deductibleExpensesRON.toLocaleString()} RON</strong>
            </div>
            <div className="flex justify-between border-t border-zinc-800 pt-1">
              <span className="text-amber-300 font-bold">Impozit pe Venit Datorat:</span>
              <strong className="text-rose-400 text-sm font-black">{report?.asymmetric.incomeTaxRON.toLocaleString()} RON</strong>
            </div>
          </div>
        </div>

        {/* DREAPTA: REGULA SIMETRICĂ (PNL REAL GLOBAL NET) */}
        <div className="bg-zinc-950 border border-zinc-800 rounded p-3 space-y-2">
          <div className="flex items-center justify-between border-b border-zinc-800 pb-1.5">
            <span className="text-xs font-bold text-zinc-300 flex items-center space-x-1.5">
              <TrendingUp className="w-3.5 h-3.5 text-cyan-400" />
              <span>PNL REAL GLOBAL NET (PORTOFOLIU CU PIERDERI SCĂZUTE)</span>
            </span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">
              Informativ / Piață
            </span>
          </div>
          <p className="text-[10px] text-zinc-400">
            Cum ar fi arătat impozitul dacă legislația ar permite deducerea pierderilor din câștiguri (standard internațional):
          </p>
          <div className="space-y-1 text-xs">
            <div className="flex justify-between">
              <span className="text-zinc-400">Profit Realizat Total:</span>
              <strong className="text-emerald-400">+${report?.symmetric.totalProfitUSD.toFixed(2)}</strong>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-400">Pierderi Realizate Totale:</span>
              <strong className="text-rose-400">${report?.symmetric.totalLossUSD.toFixed(2)}</strong>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-400">PnL Net Portofoliu:</span>
              <strong className={report && report.symmetric.netRealizedPnLUSD >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                {report && report.symmetric.netRealizedPnLUSD >= 0 ? '+' : ''}${report?.symmetric.netRealizedPnLUSD.toFixed(2)} ({report?.symmetric.netRealizedPnLRON.toLocaleString()} RON)
              </strong>
            </div>
            <div className="flex justify-between border-t border-zinc-800 pt-1">
              <span className="text-zinc-400">Diferență Asimetrie Fiscală:</span>
              <strong className="text-amber-400 font-bold">
                +{report?.symmetric.asymmetryDifferenceRON.toLocaleString()} RON impozit adăugat
              </strong>
            </div>
          </div>
        </div>
      </div>

      {/* =================================================================== */}
      {/* 5. TABEL AUDIT TRANZACȚII & FILLS OKX (ANAF HISTORICAL LOG)        */}
      {/* =================================================================== */}
      <div className="bg-zinc-950 border border-zinc-800 rounded p-3 space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 pb-2">
          <div className="flex items-center space-x-2">
            <Layers className="w-4 h-4 text-emerald-400" />
            <h3 className="font-bold text-xs text-white">
              JURNAL TRANZACȚII &amp; FILLS DETALIAT PENTRU CONTABILITATE ({filteredTransactions.length} din {report?.totalTransactionsCount || 0} TRANZACȚII)
            </h3>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Căutare */}
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Caută monedă (ex: SOL, LINK)..."
              className="bg-black border border-zinc-700 rounded px-2 py-1 text-white text-xs w-48 placeholder:text-zinc-600"
            />

            {/* Filtru sursă */}
            <div className="flex items-center bg-black border border-zinc-800 rounded p-0.5 text-[10px]">
              <button
                type="button"
                onClick={() => setSourceFilter('ALL')}
                className={`px-2 py-0.5 rounded font-bold cursor-pointer ${
                  sourceFilter === 'ALL' ? 'bg-cyan-500 text-black' : 'text-zinc-400 hover:text-white'
                }`}
              >
                Toate Sursele
              </button>
              <button
                type="button"
                onClick={() => setSourceFilter('OKX_API')}
                className={`px-2 py-0.5 rounded font-bold cursor-pointer ${
                  sourceFilter === 'OKX_API' ? 'bg-cyan-500 text-black' : 'text-zinc-400 hover:text-white'
                }`}
              >
                OKX API &amp; Arhivă
              </button>
              <button
                type="button"
                onClick={() => setSourceFilter('GRID')}
                className={`px-2 py-0.5 rounded font-bold cursor-pointer ${
                  sourceFilter === 'GRID' ? 'bg-cyan-500 text-black' : 'text-zinc-400 hover:text-white'
                }`}
              >
                Grile Bot
              </button>
              <button
                type="button"
                onClick={() => setSourceFilter('CSV')}
                className={`px-2 py-0.5 rounded font-bold cursor-pointer ${
                  sourceFilter === 'CSV' ? 'bg-cyan-500 text-black' : 'text-zinc-400 hover:text-white'
                }`}
              >
                CSV Import
              </button>
            </div>

            {/* Filtru tranzacții */}
            <div className="flex items-center bg-black border border-zinc-800 rounded p-0.5 text-[10px]">
              <button
                type="button"
                onClick={() => setTxFilter('ALL')}
                className={`px-2 py-0.5 rounded font-bold cursor-pointer ${
                  txFilter === 'ALL' ? 'bg-amber-500 text-black' : 'text-zinc-400 hover:text-white'
                }`}
              >
                Toate ({report?.totalTransactionsCount || 0})
              </button>
              <button
                type="button"
                onClick={() => setTxFilter('PROFIT')}
                className={`px-2 py-0.5 rounded font-bold cursor-pointer ${
                  txFilter === 'PROFIT' ? 'bg-emerald-500 text-black' : 'text-zinc-400 hover:text-white'
                }`}
              >
                Pozitive ANAF ({report?.profitableTransactionsCount || 0})
              </button>
              <button
                type="button"
                onClick={() => setTxFilter('LOSS')}
                className={`px-2 py-0.5 rounded font-bold cursor-pointer ${
                  txFilter === 'LOSS' ? 'bg-rose-600 text-white' : 'text-zinc-400 hover:text-white'
                }`}
              >
                Pierderi ({report?.lossTransactionsCount || 0})
              </button>
            </div>
          </div>
        </div>

        {filteredTransactions.length === 0 ? (
          <div className="bg-black border border-zinc-800 rounded p-6 text-center text-zinc-400 text-xs space-y-1">
            <p className="font-bold text-amber-300">Nu există tranzacții pentru filtrul curent (An fiscal {selectedYear}).</p>
            <p className="text-[11px]">
              Apasă butonul <strong>„⚡ Sincronizează Complet cu OKX API (Archive &amp; Fills)”</strong> de sus pentru a interoga istoricul direct din arhivele OKX, sau folosește <strong>„Încarcă CSV OKX”</strong>.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto max-h-[50vh] overflow-y-auto pr-1">
            <table className="w-full text-left border-collapse text-[11px]">
              <thead>
                <tr className="border-b border-zinc-800 text-zinc-400 text-[10px] sticky top-0 bg-zinc-950">
                  <th className="py-1.5 px-2">Data (UTC)</th>
                  <th className="py-1.5 px-2">ID / Sursă</th>
                  <th className="py-1.5 px-2">Instrument</th>
                  <th className="py-1.5 px-2">Sens / Tip</th>
                  <th className="py-1.5 px-2">Preț Intrare / Ieșire</th>
                  <th className="py-1.5 px-2">Profit USD</th>
                  <th className="py-1.5 px-2">Comision USD</th>
                  <th className="py-1.5 px-2">Curs BNR</th>
                  <th className="py-1.5 px-2">Profit RON</th>
                  <th className="py-1.5 px-2">Comision RON</th>
                  <th className="py-1.5 px-2">Venit Net Impozabil RON</th>
                  <th className="py-1.5 px-2 text-right">Eligibil ANAF</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-900">
                {filteredTransactions.map((tx) => (
                  <tr key={tx.id} className="hover:bg-zinc-900/60">
                    <td className="py-1.5 px-2 text-zinc-300 font-mono text-[10px]">{tx.dateFormatted}</td>
                    <td className="py-1.5 px-2 font-mono text-[10px] text-zinc-400 truncate max-w-[130px]" title={tx.id}>
                      <span className="text-cyan-400">[{tx.source}]</span> {tx.id}
                    </td>
                    <td className="py-1.5 px-2 font-black text-white">{tx.symbol}</td>
                    <td className="py-1.5 px-2">
                      <span
                        className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${
                          tx.side === 'BUY'
                            ? 'bg-emerald-500/20 text-emerald-300'
                            : 'bg-rose-500/20 text-rose-300'
                        }`}
                      >
                        {tx.side}
                      </span>{' '}
                      <span className="text-[9px] text-zinc-400">{tx.closeType}</span>
                    </td>
                    <td className="py-1.5 px-2 font-mono text-[10px] tabular-nums text-zinc-300">
                      {tx.entryPx && tx.exitPx && tx.entryPx !== tx.exitPx ? (
                        <span>
                          ${tx.entryPx.toFixed(3)} → ${tx.exitPx.toFixed(3)}
                        </span>
                      ) : tx.exitPx || tx.entryPx ? (
                        <span>${(tx.exitPx || tx.entryPx)?.toFixed(3)}</span>
                      ) : (
                        <span className="text-zinc-600">—</span>
                      )}
                    </td>
                    <td className="py-1.5 px-2 tabular-nums">
                      <span className={tx.pnlUSD >= 0 ? 'text-emerald-400 font-bold' : 'text-rose-400 font-bold'}>
                        {tx.pnlUSD >= 0 ? '+' : ''}${tx.pnlUSD.toFixed(4)}
                      </span>
                    </td>
                    <td className="py-1.5 px-2 tabular-nums text-zinc-400">${tx.feeUSD.toFixed(4)}</td>
                    <td className="py-1.5 px-2 tabular-nums text-cyan-300 font-mono text-[10px]">{tx.bnrRate.toFixed(4)}</td>
                    <td className="py-1.5 px-2 tabular-nums font-bold">
                      <span className={tx.pnlRON >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                        {tx.pnlRON >= 0 ? '+' : ''}{tx.pnlRON.toFixed(2)} RON
                      </span>
                    </td>
                    <td className="py-1.5 px-2 tabular-nums text-zinc-400">{tx.feeRON.toFixed(2)} RON</td>
                    <td className="py-1.5 px-2 tabular-nums font-black text-amber-300">
                      {tx.netTaxableGainRON > 0 ? `+${tx.netTaxableGainRON.toFixed(2)} RON` : '0.00 RON'}
                    </td>
                    <td className="py-1.5 px-2 text-right">
                      {tx.isProfit ? (
                        <span className="px-1.5 py-0.5 rounded text-[9px] font-black bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">
                          ✓ BAZĂ IMPOZIT
                        </span>
                      ) : (
                        <span className="px-1.5 py-0.5 rounded text-[9px] text-zinc-500 border border-zinc-800">
                          NECOMPENSAT
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* =================================================================== */}
      {/* 6. MODAL ÎNCĂRCARE CSV EXPORTAT DIN OKX (ASSETS -> ORDER HISTORY)   */}
      {/* =================================================================== */}
      {showUploadModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div className="bg-zinc-950 border border-amber-500/50 rounded-lg max-w-xl w-full p-4 space-y-3 shadow-2xl">
            <div className="flex items-center justify-between border-b border-zinc-800 pb-2">
              <div className="flex items-center space-x-2">
                <Upload className="w-4 h-4 text-amber-400" />
                <h3 className="font-bold text-sm text-white">
                  ÎNCARCĂ CSV TRADING HISTORY DE LA OKX
                </h3>
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
              Dacă ai tranzacții manuale sau vrei să imporți arhiva completă exportată din site-ul OKX (<code className="text-amber-300">Assets -&gt; Order History / Trading History -&gt; Export</code>), încarcă fișierul CSV mai jos. Tranzacțiile vor fi combinate automat cu cele preluate prin API:
            </p>

            <div className="space-y-2">
              <input
                type="file"
                accept=".csv,text/csv,text/plain"
                ref={fileInputRef}
                onChange={handleFileInputChange}
                className="block w-full text-xs text-zinc-400 file:mr-3 file:py-1.5 file:px-3 file:rounded file:border file:border-amber-500/40 file:text-xs file:font-bold file:bg-zinc-900 file:text-amber-300 hover:file:bg-zinc-800 cursor-pointer"
              />

              <div className="text-[10px] text-zinc-500">Sau lipește direct conținutul text al fișierului CSV:</div>
              <textarea
                value={csvUploadText}
                onChange={(e) => setCsvUploadText(e.target.value)}
                placeholder="Time,Instrument,Side,Price,Amount,Fee,Realized PnL..."
                rows={6}
                className="w-full bg-black border border-zinc-800 rounded p-2 text-xs text-zinc-200 font-mono focus:border-amber-500 outline-none"
              />
            </div>

            <div className="flex items-center justify-end space-x-2 pt-2 border-t border-zinc-800">
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
                className="px-4 py-1.5 rounded bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-black font-black text-xs cursor-pointer flex items-center space-x-1"
              >
                {isUploadingCsv ? 'Se procesează...' : 'Importă Tranzacțiile'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
