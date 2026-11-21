import fs from 'fs';
import path from 'path';
import { OKXAdapter } from '../exchange/OKXAdapter';
import {
  AnafCoverageStatus,
  AnafEfficiencyStatus,
  AnafFiscalSettings,
  AnafMonthlySummary,
  AnafTaxEfficiencyMetrics,
  AnafTaxSummary,
  AnafTransactionPageResponse,
  AnafTransactionRecord,
  CassCeilingLevel,
} from '../../shared/types';

export interface AnafTaxEngineOptions {
  fiscalYear?: number;
  startDate?: string; // YYYY-MM-DD (default '2026-10-01' for 2026)
  taxRatePct?: number; // 10% (standard transfer monedă virtuală) or 16%
  minWageGrossRON?: number; // 4050 RON în 2026
  customUsdRonRate?: number | null;
  forceSyncOkxApi?: boolean;
  includeTransactions?: boolean; // false for lightweight summary UI, true for CSV export
  nowMs?: number;
}

export interface AnafTransactionQueryOptions {
  fiscalYear?: number;
  startDate?: string;
  yearMonth?: string; // YYYY-MM or 'ALL'
  customUsdRonRate?: number | null;
  filter?: 'ALL' | 'PROFIT' | 'LOSS';
  search?: string;
  page?: number;
  pageSize?: number;
  nowMs?: number;
}

interface SyncedCacheV2 {
  schemaVersion: 2;
  canonicalSource: 'OKX_BILLS';
  migratedAt?: number;
  lastIncrementalSyncAt: number;
  lastFullSyncAt: number;
  records: AnafTransactionRecord[];
}

interface PersistedSettingsStore {
  fiscalYear: number;
  startDateByYear: Record<string, string>;
  taxRatePct: number;
  minWageGrossRON: number;
  customUsdRonRate: number | null;
  updatedAt: number;
}

const MONTH_NAMES_RO = [
  'Ianuarie',
  'Februarie',
  'Martie',
  'Aprilie',
  'Mai',
  'Iunie',
  'Iulie',
  'August',
  'Septembrie',
  'Octombrie',
  'Noiembrie',
  'Decembrie',
];

const NINETY_DAYS_MS = 90 * 24 * 3600_000;
const MAX_CURSOR_PAGES = 250; // Up to 25,000 bills per endpoint/instType

export class AnafTaxEngine {
  private okxAdapter: OKXAdapter;
  private dataDir: string;
  private importedCsvFile: string;
  private syncedTransactionsFile: string;
  private settingsFile: string;
  private nowFn: () => number;
  private rateLimitDelayMs: number;

  private cachedBnrUsdRate: number = 4.62;
  private cachedBnrEurRate: number = 4.97;
  private bnrLastUpdated: number = 0;
  private bnrSource: string = 'BNR Reference (Calibrat)';
  private migratedFromLegacyCache: boolean = false;

  private lastOkxSyncStatus = {
    lastSyncedAt: 0,
    totalOrdersFromArchive: 0,
    totalOrdersFromHistory: 0,
    totalBillsFromArchive: 0,
    totalFills: 0,
    billsRecentCount: 0,
    billsArchiveCount: 0,
    csvFallbackCount: 0,
    migratedFromLegacyCache: false,
    endpointsQueried: [] as string[],
    hasOkxCredentials: false,
    errorMessage: undefined as string | undefined,
  };

  constructor(
    okxAdapter: OKXAdapter,
    dataDir: string = '.data',
    deps?: { nowFn?: () => number; rateLimitDelayMs?: number }
  ) {
    this.okxAdapter = okxAdapter;
    this.dataDir = dataDir;
    this.nowFn = deps?.nowFn || (() => Date.now());
    this.rateLimitDelayMs = deps?.rateLimitDelayMs ?? 320;
    this.importedCsvFile = path.join(this.dataDir, 'imported_okx_transactions.json');
    this.syncedTransactionsFile = path.join(this.dataDir, 'okx_synced_transactions.json');
    this.settingsFile = path.join(this.dataDir, 'anaf_fiscal_settings.json');
    this.ensureDataDir();
    // Eagerly migrate any legacy v1 mixed cache cleanly on startup
    this.loadCanonicalCacheStore();
  }

  private ensureDataDir(): void {
    try {
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true });
      }
    } catch {}
  }

  private sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ===========================================================================
  // 1. PERSISTENT FISCAL SETTINGS & DEFAULT START DATE (2026-10-01)
  // ===========================================================================

  public static getDefaultStartDate(fiscalYear: number): string {
    if (fiscalYear === 2026) return '2026-10-01';
    return `${fiscalYear}-01-01`;
  }

  private isValidIsoDate(val?: string): val is string {
    if (!val || typeof val !== 'string') return false;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(val.trim())) return false;
    const ms = Date.parse(`${val.trim()}T00:00:00.000Z`);
    return Number.isFinite(ms);
  }

  private loadSettingsStore(): PersistedSettingsStore {
    const defaultYear = new Date(this.nowFn()).getUTCFullYear();
    const fallback: PersistedSettingsStore = {
      fiscalYear: defaultYear,
      startDateByYear: {
        '2026': '2026-10-01',
      },
      taxRatePct: 10,
      minWageGrossRON: 4050,
      customUsdRonRate: null,
      updatedAt: 0,
    };

    try {
      if (fs.existsSync(this.settingsFile)) {
        const raw = fs.readFileSync(this.settingsFile, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          const fy =
            Number.isFinite(Number(parsed.fiscalYear)) && Number(parsed.fiscalYear) >= 2020
              ? Number(parsed.fiscalYear)
              : defaultYear;
          const taxRatePct = Number(parsed.taxRatePct) === 16 ? 16 : 10;
          const minWageGrossRON =
            Number.isFinite(Number(parsed.minWageGrossRON)) && Number(parsed.minWageGrossRON) > 0
              ? Number(parsed.minWageGrossRON)
              : 4050;
          const customRateRaw = Number(parsed.customUsdRonRate);
          const customUsdRonRate =
            parsed.customUsdRonRate !== null &&
            parsed.customUsdRonRate !== undefined &&
            Number.isFinite(customRateRaw) &&
            customRateRaw > 0 &&
            customRateRaw < 20
              ? parseFloat(customRateRaw.toFixed(4))
              : null;

          const startDateByYear: Record<string, string> = { '2026': '2026-10-01' };
          if (parsed.startDateByYear && typeof parsed.startDateByYear === 'object') {
            for (const [y, d] of Object.entries(parsed.startDateByYear)) {
              if (this.isValidIsoDate(String(d))) {
                startDateByYear[y] = String(d).trim();
              }
            }
          }
          return {
            fiscalYear: fy,
            startDateByYear,
            taxRatePct,
            minWageGrossRON,
            customUsdRonRate,
            updatedAt: Number(parsed.updatedAt) || 0,
          };
        }
      }
    } catch {}
    return fallback;
  }

  private saveSettingsStore(store: PersistedSettingsStore): void {
    this.ensureDataDir();
    try {
      fs.writeFileSync(this.settingsFile, JSON.stringify(store, null, 2), 'utf8');
    } catch (err: any) {
      console.warn('[AnafTaxEngine] Failed to save fiscal settings:', err.message);
    }
  }

  public getFiscalSettings(fiscalYear?: number): AnafFiscalSettings {
    const store = this.loadSettingsStore();
    const year =
      fiscalYear && Number.isFinite(fiscalYear) && fiscalYear >= 2020 ? fiscalYear : store.fiscalYear;
    const savedStart = store.startDateByYear[String(year)];
    const startDate =
      savedStart && savedStart.startsWith(`${year}-`)
        ? savedStart
        : AnafTaxEngine.getDefaultStartDate(year);

    return {
      fiscalYear: year,
      startDate,
      taxRatePct: store.taxRatePct,
      minWageGrossRON: store.minWageGrossRON,
      customUsdRonRate: store.customUsdRonRate,
      updatedAt: store.updatedAt,
    };
  }

  public saveFiscalSettings(patch: {
    fiscalYear?: number;
    startDate?: string;
    taxRatePct?: number;
    minWageGrossRON?: number;
    customUsdRonRate?: number | null;
    clearCustomUsdRonRate?: boolean;
  }): AnafFiscalSettings {
    const store = this.loadSettingsStore();
    const nextYear =
      patch.fiscalYear && Number.isFinite(patch.fiscalYear) && patch.fiscalYear >= 2020
        ? Math.floor(patch.fiscalYear)
        : store.fiscalYear;

    if (patch.fiscalYear && Number.isFinite(patch.fiscalYear)) {
      store.fiscalYear = nextYear;
    }

    if (patch.startDate && this.isValidIsoDate(patch.startDate)) {
      const cleanDate = patch.startDate.trim();
      const targetYear = cleanDate.slice(0, 4);
      store.startDateByYear[targetYear] = cleanDate;
    }

    if (patch.taxRatePct !== undefined) {
      store.taxRatePct = Number(patch.taxRatePct) === 16 ? 16 : 10;
    }

    if (patch.minWageGrossRON !== undefined) {
      const mw = Number(patch.minWageGrossRON);
      if (Number.isFinite(mw) && mw >= 1000 && mw <= 50000) {
        store.minWageGrossRON = mw;
      }
    }

    if (patch.clearCustomUsdRonRate || patch.customUsdRonRate === null) {
      store.customUsdRonRate = null;
    } else if (patch.customUsdRonRate !== undefined) {
      const rate = Number(patch.customUsdRonRate);
      if (Number.isFinite(rate) && rate > 0 && rate < 20) {
        store.customUsdRonRate = parseFloat(rate.toFixed(4));
      }
    }

    store.updatedAt = this.nowFn();
    this.saveSettingsStore(store);
    return this.getFiscalSettings(nextYear);
  }

  private resolveDateWindow(
    fiscalYear: number,
    requestedStartDate?: string,
    nowOverride?: number
  ): { startDate: string; endDate: string; startMs: number; endMs: number; effectiveNowMs: number } {
    const effectiveNowMs = nowOverride ?? this.nowFn();
    const saved = this.getFiscalSettings(fiscalYear);

    let startDate = AnafTaxEngine.getDefaultStartDate(fiscalYear);
    if (this.isValidIsoDate(requestedStartDate) && requestedStartDate.startsWith(`${fiscalYear}-`)) {
      startDate = requestedStartDate.trim();
    } else if (saved.startDate && saved.startDate.startsWith(`${fiscalYear}-`)) {
      startDate = saved.startDate;
    }

    const yearStartMs = Date.UTC(fiscalYear, 0, 1, 0, 0, 0, 0);
    const yearEndMs = Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999);
    const parsedStartMs = Date.parse(`${startDate}T00:00:00.000Z`);
    const startMs = Math.max(yearStartMs, Math.min(yearEndMs, Number.isFinite(parsedStartMs) ? parsedStartMs : yearStartMs));

    const nowDate = new Date(effectiveNowMs);
    const endOfTodayUtcMs = Date.UTC(
      nowDate.getUTCFullYear(),
      nowDate.getUTCMonth(),
      nowDate.getUTCDate(),
      23,
      59,
      59,
      999
    );

    let endMs: number;
    if (effectiveNowMs > yearEndMs) {
      endMs = yearEndMs;
    } else if (effectiveNowMs < yearStartMs) {
      endMs = yearStartMs - 1;
    } else {
      endMs = Math.min(yearEndMs, endOfTodayUtcMs);
    }

    const endDate =
      endMs >= startMs
        ? new Date(endMs).toISOString().slice(0, 10)
        : new Date(effectiveNowMs).toISOString().slice(0, 10);

    return { startDate, endDate, startMs, endMs, effectiveNowMs };
  }

  // ===========================================================================
  // 2. BNR EXCHANGE RATES & DYNAMIC RON RECALCULATION
  // ===========================================================================

  public async fetchBnrRates(force: boolean = false): Promise<{ usdRon: number; eurRon: number; source: string }> {
    const now = this.nowFn();
    if (!force && this.bnrLastUpdated > 0 && now - this.bnrLastUpdated < 3600_000) {
      return {
        usdRon: this.cachedBnrUsdRate,
        eurRon: this.cachedBnrEurRate,
        source: this.bnrSource,
      };
    }

    try {
      const res = await fetch('https://open.er-api.com/v6/latest/USD', {
        signal: AbortSignal.timeout(4000),
      });
      if (res.ok) {
        const json: any = await res.json();
        const ronRate = parseFloat(json?.rates?.RON);
        const eurRate = parseFloat(json?.rates?.EUR);
        if (Number.isFinite(ronRate) && ronRate > 3 && ronRate < 7) {
          this.cachedBnrUsdRate = parseFloat(ronRate.toFixed(4));
          if (Number.isFinite(eurRate) && eurRate > 0) {
            this.cachedBnrEurRate = parseFloat((ronRate / eurRate).toFixed(4));
          }
          this.bnrLastUpdated = now;
          this.bnrSource = 'BNR Live Feed (OpenExchange)';
          return {
            usdRon: this.cachedBnrUsdRate,
            eurRon: this.cachedBnrEurRate,
            source: this.bnrSource,
          };
        }
      }
    } catch {
      try {
        const res2 = await fetch('https://api.exchangerate-api.com/v4/latest/USD', {
          signal: AbortSignal.timeout(3000),
        });
        if (res2.ok) {
          const json2: any = await res2.json();
          const ronRate2 = parseFloat(json2?.rates?.RON);
          if (Number.isFinite(ronRate2) && ronRate2 > 3 && ronRate2 < 7) {
            this.cachedBnrUsdRate = parseFloat(ronRate2.toFixed(4));
            this.bnrLastUpdated = now;
            this.bnrSource = 'BNR Secondary Feed (ExchangeRate-API)';
            return {
              usdRon: this.cachedBnrUsdRate,
              eurRon: this.cachedBnrEurRate,
              source: this.bnrSource,
            };
          }
        }
      } catch {}
    }

    this.bnrLastUpdated = now;
    return {
      usdRon: this.cachedBnrUsdRate,
      eurRon: this.cachedBnrEurRate,
      source: this.bnrSource,
    };
  }

  /**
   * CRITICAL: Recomputes all RON figures dynamically from raw `pnlUSD` and `feeUSD`
   * using the currently active BNR USD/RON rate (live or manually overridden).
   */
  public static recalculateRecordForRate(
    tx: AnafTransactionRecord,
    bnrRate: number
  ): AnafTransactionRecord {
    const safeRate = Number.isFinite(bnrRate) && bnrRate > 0 ? bnrRate : 4.62;
    const pnlUSD = parseFloat((Number(tx.pnlUSD) || 0).toFixed(4));
    const feeUSD = Math.abs(parseFloat((Number(tx.feeUSD) || 0).toFixed(4)));
    const pnlRON = parseFloat((pnlUSD * safeRate).toFixed(2));
    const feeRON = parseFloat((feeUSD * safeRate).toFixed(2));
    const isProfit = pnlUSD > 0.000001;
    const grossGainRON = isProfit ? pnlRON : 0;
    const deductibleFeeRON = isProfit ? feeRON : 0;
    const netTaxableGainRON = Math.max(0, parseFloat((grossGainRON - deductibleFeeRON).toFixed(2)));

    return {
      ...tx,
      pnlUSD,
      feeUSD,
      bnrRate: parseFloat(safeRate.toFixed(4)),
      pnlRON,
      feeRON,
      isProfit,
      grossGainRON,
      deductibleFeeRON,
      netTaxableGainRON,
    };
  }

  // ===========================================================================
  // 3. CANONICAL PERSISTENT CACHE (OKX_BILLS v2 + MIGRATION) & CSV STORAGE
  // ===========================================================================

  private isCanonicalBillRecord(tx: Partial<AnafTransactionRecord>): boolean {
    if (!tx || typeof tx.id !== 'string') return false;
    return tx.id.startsWith('OKX_BILL_') || Boolean(tx.rawBillId && tx.source === 'OKX_API');
  }

  private normalizeCanonicalBillRecord(tx: AnafTransactionRecord): AnafTransactionRecord {
    const billId = String(tx.rawBillId || tx.id.replace(/^OKX_BILL_/, '')).trim();
    return {
      ...tx,
      id: `OKX_BILL_${billId}`,
      rawBillId: billId,
      source: 'OKX_API',
    };
  }

  private loadCanonicalCacheStore(): SyncedCacheV2 {
    const empty: SyncedCacheV2 = {
      schemaVersion: 2,
      canonicalSource: 'OKX_BILLS',
      lastIncrementalSyncAt: 0,
      lastFullSyncAt: 0,
      records: [],
    };

    try {
      if (!fs.existsSync(this.syncedTransactionsFile)) return empty;
      const raw = fs.readFileSync(this.syncedTransactionsFile, 'utf8');
      const parsed = JSON.parse(raw);

      // Legacy v1 array or unversioned store -> migrate cleanly by keeping ONLY canonical OKX_BILL records
      if (Array.isArray(parsed) || !parsed || parsed.schemaVersion !== 2) {
        const legacyList: AnafTransactionRecord[] = Array.isArray(parsed)
          ? parsed
          : Array.isArray(parsed?.records)
          ? parsed.records
          : [];
        const dedupMap = new Map<string, AnafTransactionRecord>();
        for (const item of legacyList) {
          if (!this.isCanonicalBillRecord(item)) continue;
          const clean = this.normalizeCanonicalBillRecord(item);
          dedupMap.set(clean.id, clean);
        }

        const migrated: SyncedCacheV2 = {
          schemaVersion: 2,
          canonicalSource: 'OKX_BILLS',
          migratedAt: this.nowFn(),
          lastIncrementalSyncAt: 0,
          lastFullSyncAt: 0, // Forces a clean canonical API sync on next sync
          records: Array.from(dedupMap.values()),
        };
        this.migratedFromLegacyCache = legacyList.length > migrated.records.length || legacyList.length > 0;
        this.lastOkxSyncStatus.migratedFromLegacyCache = this.migratedFromLegacyCache;
        this.saveCanonicalCacheStore(migrated);
        return migrated;
      }

      const rawRecords = Array.isArray(parsed.records) ? parsed.records : [];
      const dedupMap = new Map<string, AnafTransactionRecord>();
      for (const item of rawRecords) {
        if (!this.isCanonicalBillRecord(item)) continue;
        const clean = this.normalizeCanonicalBillRecord(item);
        dedupMap.set(clean.id, clean);
      }

      return {
        schemaVersion: 2,
        canonicalSource: 'OKX_BILLS',
        migratedAt: Number(parsed.migratedAt) || undefined,
        lastIncrementalSyncAt: Number(parsed.lastIncrementalSyncAt) || 0,
        lastFullSyncAt: Number(parsed.lastFullSyncAt) || 0,
        records: Array.from(dedupMap.values()),
      };
    } catch {
      return empty;
    }
  }

  private saveCanonicalCacheStore(store: SyncedCacheV2): void {
    this.ensureDataDir();
    try {
      fs.writeFileSync(this.syncedTransactionsFile, JSON.stringify(store, null, 2), 'utf8');
    } catch (err: any) {
      console.warn('[AnafTaxEngine] Failed to save canonical bills cache:', err.message);
    }
  }

  public getPersistentSyncedTransactions(): AnafTransactionRecord[] {
    return this.loadCanonicalCacheStore().records;
  }

  public savePersistentSyncedTransactions(
    records: AnafTransactionRecord[],
    meta?: { lastIncrementalSyncAt?: number; lastFullSyncAt?: number }
  ): void {
    const existing = this.loadCanonicalCacheStore();
    const dedupMap = new Map<string, AnafTransactionRecord>();
    for (const r of records) {
      if (!this.isCanonicalBillRecord(r)) continue;
      const clean = this.normalizeCanonicalBillRecord(r);
      dedupMap.set(clean.id, clean);
    }
    this.saveCanonicalCacheStore({
      schemaVersion: 2,
      canonicalSource: 'OKX_BILLS',
      migratedAt: existing.migratedAt,
      lastIncrementalSyncAt: meta?.lastIncrementalSyncAt ?? existing.lastIncrementalSyncAt,
      lastFullSyncAt: meta?.lastFullSyncAt ?? existing.lastFullSyncAt,
      records: Array.from(dedupMap.values()),
    });
  }

  public getImportedTransactions(): AnafTransactionRecord[] {
    try {
      if (fs.existsSync(this.importedCsvFile)) {
        const raw = fs.readFileSync(this.importedCsvFile, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch {}
    return [];
  }

  public saveImportedTransactions(records: AnafTransactionRecord[]): void {
    this.ensureDataDir();
    try {
      fs.writeFileSync(this.importedCsvFile, JSON.stringify(records, null, 2), 'utf8');
    } catch (err: any) {
      console.warn('[AnafTaxEngine] Failed to save imported transactions:', err.message);
    }
  }

  public clearImportedTransactions(): void {
    try {
      if (fs.existsSync(this.importedCsvFile)) {
        fs.unlinkSync(this.importedCsvFile);
      }
    } catch {}
  }

  // ===========================================================================
  // 4. OFFICIAL OKX CSV PARSER (NON-OVERLAPPING HISTORICAL FALLBACK)
  // ===========================================================================

  public parseAndImportOkxCsv(csvContent: string): {
    importedCount: number;
    errors: string[];
    yearsFound: number[];
    profitableCycles: number;
    lossCycles: number;
    totalProfitRON: number;
    totalFeesRON: number;
    message: string;
  } {
    const rawContent = (csvContent || '').replace(/^\uFEFF/, '').trim();
    if (!rawContent || rawContent.length < 10) {
      return {
        importedCount: 0,
        errors: ['Fișierul CSV este gol sau conține date insuficiente.'],
        yearsFound: [],
        profitableCycles: 0,
        lossCycles: 0,
        totalProfitRON: 0,
        totalFeesRON: 0,
        message: 'Fișier gol.',
      };
    }

    try {
      this.ensureDataDir();
      fs.writeFileSync(path.join(this.dataDir, 'last_uploaded_okx.csv'), rawContent, 'utf8');
    } catch {}

    const lines = rawContent
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (lines.length < 2) {
      return {
        importedCount: 0,
        errors: ['Fișierul CSV nu are suficiente rânduri (lipsesc datele după antet).'],
        yearsFound: [],
        profitableCycles: 0,
        lossCycles: 0,
        totalProfitRON: 0,
        totalFeesRON: 0,
        message: 'Fără date.',
      };
    }

    const sampleLines = lines.slice(0, Math.min(5, lines.length));
    const commaCount = sampleLines.reduce((acc, l) => acc + (l.match(/,/g) || []).length, 0);
    const semiCount = sampleLines.reduce((acc, l) => acc + (l.match(/;/g) || []).length, 0);
    const tabCount = sampleLines.reduce((acc, l) => acc + (l.match(/\t/g) || []).length, 0);

    let delimiter = ',';
    if (semiCount > commaCount && semiCount > tabCount) delimiter = ';';
    else if (tabCount > commaCount && tabCount > semiCount) delimiter = '\t';

    const parseCsvRow = (line: string): string[] => {
      const res: string[] = [];
      let inQuotes = false;
      let curr = '';
      for (let c = 0; c < line.length; c++) {
        const ch = line[c];
        if (ch === '"') {
          if (inQuotes && line[c + 1] === '"') {
            curr += '"';
            c++;
          } else {
            inQuotes = !inQuotes;
          }
        } else if (ch === delimiter && !inQuotes) {
          res.push(curr.trim());
          curr = '';
        } else {
          curr += ch;
        }
      }
      res.push(curr.trim());
      return res.map((v) => v.replace(/^["']|["']$/g, '').trim());
    };

    const norm = (s: string) =>
      (s || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();

    const parseNumeric = (val?: string): number => {
      if (!val) return 0;
      let str = String(val).replace(/^["']|["']$/g, '').trim();
      str = str.replace(/(usdt|usdc|usd|eur|ron|btc|eth|%|\s)+$/i, '').trim();
      if (!str || str === '--' || str === '-') return 0;

      if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(str)) {
        str = str.replace(/\./g, '').replace(',', '.');
      } else if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(str)) {
        str = str.replace(/,/g, '');
      } else if (str.includes(',') && !str.includes('.')) {
        str = str.replace(',', '.');
      }

      const num = parseFloat(str);
      return Number.isFinite(num) ? num : 0;
    };

    const parseTimestamp = (rawTimeStr: string): number => {
      if (!rawTimeStr) return this.nowFn();
      if (/^\d{10,13}$/.test(rawTimeStr)) {
        const numTs = parseInt(rawTimeStr, 10);
        return rawTimeStr.length === 10 ? numTs * 1000 : numTs;
      }
      // Handle DD/MM/YYYY HH:mm:ss or DD.MM.YYYY HH:mm:ss
      const euMatch = rawTimeStr.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
      if (euMatch) {
        const day = parseInt(euMatch[1], 10);
        const month = parseInt(euMatch[2], 10) - 1;
        const year = parseInt(euMatch[3], 10);
        const hour = parseInt(euMatch[4] || '0', 10);
        const min = parseInt(euMatch[5] || '0', 10);
        const sec = parseInt(euMatch[6] || '0', 10);
        return Date.UTC(year, month, day, hour, min, sec);
      }
      const parsed = Date.parse(rawTimeStr);
      return Number.isFinite(parsed) ? parsed : this.nowFn();
    };

    const headerCols = parseCsvRow(lines[0]).map(norm);
    const findIdx = (keywords: string[]) =>
      headerCols.findIndex((h) => keywords.some((k) => h.includes(norm(k))));

    const timeIdx = findIdx([
      'bill time',
      'order time',
      'fill time',
      'creation time',
      'create time',
      'update time',
      'trade time',
      'closing time',
      'closed time',
      'open time',
      'time',
      'date',
      'timestamp',
      'data',
      'timp',
      'ctime',
      'utime',
      'ts',
    ]);

    const instIdIdx = findIdx([
      'contract name',
      'contract',
      'instrument id',
      'instrument',
      'trading pair',
      'symbol',
      'pair',
      'instid',
      'underlying',
      'moneda',
      'pereche',
      'asset',
    ]);

    const sideIdx = findIdx([
      'side',
      'direction',
      'sens',
      'directie',
      'subtype',
      'order type',
      'type',
      'tip',
      'action',
      'posside',
    ]);

    const openPxIdx = findIdx(['opening price', 'open price', 'pret deschidere', 'entry price', 'pret intrare']);
    const closePxIdx = findIdx(['closing price', 'close price', 'pret inchidere', 'exit price', 'pret iesire']);

    const fillPxIdx = findIdx([
      'average filled price',
      'average price',
      'avg price',
      'fill price',
      'filled price',
      'order price',
      'execution price',
      'price',
      'pret mediu',
      'pret',
      'avgpx',
      'fillpx',
      'px',
    ]);

    const fillSzIdx = findIdx([
      'filled amount',
      'executed amount',
      'filled quantity',
      'executed quantity',
      'amount',
      'quantity',
      'size',
      'qty',
      'cantitate',
      'volum',
      'accfillsz',
      'fillsz',
      'sz',
    ]);

    const feeIdx = findIdx([
      'trading fee',
      'transaction fee',
      'commission',
      'fee (usdt)',
      'fee(usdt)',
      'fee (usd)',
      'fee(usd)',
      'fee',
      'comision',
      'taxa',
    ]);

    const pnlIdx = findIdx([
      'realized p&l',
      'realized pnl',
      'closed pnl',
      'close pnl',
      'settled pnl',
      'profit and loss',
      'total pnl',
      'net pnl',
      'pnl',
      'profit',
      'venit realizat',
      'castig',
      'fillpnl',
    ]);

    const billIdIdx = findIdx(['bill id', 'billid']);
    const ordIdIdx = findIdx(['order id', 'ordid', 'trade id', 'fillid', 'id ordin', 'id tranzactie', 'id']);

    const settings = this.getFiscalSettings();
    const bnrRate = settings.customUsdRonRate || this.cachedBnrUsdRate || 4.62;

    interface RawCsvItem {
      rowIdx: number;
      ts: number;
      dateFormatted: string;
      inst: string;
      side: 'BUY' | 'SELL';
      px: number;
      openPx?: number;
      closePx?: number;
      sz: number;
      fee: number;
      pnl: number;
      billId?: string;
      ordId?: string;
    }

    const rawItems: RawCsvItem[] = [];
    const yearsSet = new Set<number>();

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const cols = parseCsvRow(line);

      const rawTimeStr = timeIdx >= 0 ? cols[timeIdx] : '';
      const ts = parseTimestamp(rawTimeStr);
      const itemDate = new Date(ts);
      const itemYear = itemDate.getUTCFullYear();
      if (itemYear >= 2020 && itemYear <= 2035) {
        yearsSet.add(itemYear);
      }

      let rawInst = instIdIdx >= 0 && cols[instIdIdx] ? cols[instIdIdx] : 'OKX_CONTRACT';
      rawInst = rawInst.replace(/^["']|["']$/g, '').trim();

      const rawSideStr = (sideIdx >= 0 && cols[sideIdx] ? cols[sideIdx] : '').toUpperCase();
      const isBuy =
        rawSideStr.includes('BUY') ||
        rawSideStr.includes('CUMPAR') ||
        rawSideStr.includes('LONG') ||
        rawSideStr.includes('BID');
      const side: 'BUY' | 'SELL' = isBuy ? 'BUY' : 'SELL';

      const px = fillPxIdx >= 0 ? parseNumeric(cols[fillPxIdx]) : 0;
      const openPx = openPxIdx >= 0 ? parseNumeric(cols[openPxIdx]) : undefined;
      const closePx = closePxIdx >= 0 ? parseNumeric(cols[closePxIdx]) : undefined;
      const sz = fillSzIdx >= 0 ? Math.abs(parseNumeric(cols[fillSzIdx])) : 1;
      const fee = feeIdx >= 0 ? Math.abs(parseNumeric(cols[feeIdx])) : 0;
      const pnl = pnlIdx >= 0 ? parseNumeric(cols[pnlIdx]) : 0;
      const billId = billIdIdx >= 0 && cols[billIdIdx] ? cols[billIdIdx].trim() : undefined;
      const ordId = ordIdIdx >= 0 && cols[ordIdIdx] ? cols[ordIdIdx].trim() : undefined;

      rawItems.push({
        rowIdx: i,
        ts,
        dateFormatted: itemDate.toISOString().replace('T', ' ').slice(0, 19),
        inst: rawInst,
        side,
        px: px > 0 ? px : closePx || openPx || 0,
        openPx: openPx && openPx > 0 ? openPx : undefined,
        closePx: closePx && closePx > 0 ? closePx : undefined,
        sz,
        fee,
        pnl,
        billId,
        ordId,
      });
    }

    const hasExplicitPnL = pnlIdx >= 0 || rawItems.some((r) => Math.abs(r.pnl) > 1e-6);
    const dedupRecordsMap = new Map<string, AnafTransactionRecord>();
    let profitableCycles = 0;
    let lossCycles = 0;
    let totalProfitRON = 0;
    let totalFeesRON = 0;

    if (hasExplicitPnL) {
      for (const item of rawItems) {
        if (Math.abs(item.pnl) < 1e-8 && item.fee < 1e-8) continue;

        const base = AnafTaxEngine.recalculateRecordForRate(
          {
            id: item.billId
              ? `CSV_BILL_${item.billId}`
              : `CSV_${item.inst}_${item.ts}_${item.ordId || item.rowIdx}`,
            source: 'CSV_IMPORT',
            timestamp: item.ts,
            dateFormatted: item.dateFormatted,
            symbol: item.inst,
            side: item.side,
            closeType:
              item.pnl > 0.000001
                ? 'OKX_CSV_PROFIT'
                : item.pnl < -0.000001
                ? 'OKX_CSV_LOSS'
                : 'OKX_CSV_FEE',
            pnlUSD: parseFloat(item.pnl.toFixed(4)),
            feeUSD: parseFloat(item.fee.toFixed(4)),
            notionalUSD: parseFloat((item.px * item.sz).toFixed(2)),
            bnrRate,
            pnlRON: 0,
            feeRON: 0,
            isProfit: false,
            grossGainRON: 0,
            deductibleFeeRON: 0,
            netTaxableGainRON: 0,
            entryPx: item.openPx || item.px || undefined,
            exitPx: item.closePx || item.px || undefined,
            rawOrderId: item.ordId,
            rawBillId: item.billId,
          },
          bnrRate
        );

        if (dedupRecordsMap.has(base.id)) continue;
        dedupRecordsMap.set(base.id, base);

        if (base.isProfit) {
          profitableCycles++;
          totalProfitRON += base.grossGainRON;
        } else if (base.pnlUSD < -0.000001) {
          lossCycles++;
        }
        totalFeesRON += base.feeRON;
      }
    } else {
      // Only when CSV genuinely lacks a PnL column (legacy raw OKX Orders export without PnL)
      rawItems.sort((a, b) => a.ts - b.ts);
      const itemsBySymbol = new Map<string, RawCsvItem[]>();
      for (const item of rawItems) {
        if (!itemsBySymbol.has(item.inst)) itemsBySymbol.set(item.inst, []);
        itemsBySymbol.get(item.inst)!.push(item);
      }

      for (const [sym, items] of itemsBySymbol.entries()) {
        const buyQueue: RawCsvItem[] = [];
        const ctVal = this.okxAdapter.getCachedCtVal(sym) || 1;

        for (const item of items) {
          if (item.side === 'BUY') {
            buyQueue.push({ ...item });
          } else if (item.side === 'SELL') {
            if (buyQueue.length > 0) {
              const buy = buyQueue.shift()!;
              const entryPx = buy.px > 0 ? buy.px : item.px;
              const exitPx = item.px > 0 ? item.px : entryPx;
              const matchedSz = Math.min(buy.sz, item.sz);
              const calculatedPnlUSD = (exitPx - entryPx) * matchedSz * ctVal;
              const combinedFeeUSD = buy.fee + item.fee;

              const rec = AnafTaxEngine.recalculateRecordForRate(
                {
                  id: `CSV_CYCLE_${sym}_${item.ts}_${item.ordId || item.rowIdx}`,
                  source: 'CSV_IMPORT',
                  timestamp: item.ts,
                  dateFormatted: item.dateFormatted,
                  symbol: sym,
                  side: 'SELL',
                  closeType: calculatedPnlUSD > 0.000001 ? 'OKX_CSV_FIFO_PROFIT' : 'OKX_CSV_FIFO_LOSS',
                  pnlUSD: parseFloat(calculatedPnlUSD.toFixed(4)),
                  feeUSD: parseFloat(combinedFeeUSD.toFixed(4)),
                  notionalUSD: parseFloat((exitPx * matchedSz * ctVal).toFixed(2)),
                  bnrRate,
                  pnlRON: 0,
                  feeRON: 0,
                  isProfit: false,
                  grossGainRON: 0,
                  deductibleFeeRON: 0,
                  netTaxableGainRON: 0,
                  entryPx,
                  exitPx,
                  rawOrderId: item.ordId,
                  rawBillId: item.billId,
                },
                bnrRate
              );

              if (!dedupRecordsMap.has(rec.id)) {
                dedupRecordsMap.set(rec.id, rec);
                if (rec.isProfit) {
                  profitableCycles++;
                  totalProfitRON += rec.grossGainRON;
                } else if (rec.pnlUSD < -0.000001) {
                  lossCycles++;
                }
                totalFeesRON += rec.feeRON;
              }
            } else if (item.fee > 0) {
              const rec = AnafTaxEngine.recalculateRecordForRate(
                {
                  id: `CSV_FILL_${sym}_${item.ts}_${item.ordId || item.rowIdx}`,
                  source: 'CSV_IMPORT',
                  timestamp: item.ts,
                  dateFormatted: item.dateFormatted,
                  symbol: sym,
                  side: 'SELL',
                  closeType: 'OKX_CSV_EXECUTION',
                  pnlUSD: 0,
                  feeUSD: parseFloat(item.fee.toFixed(4)),
                  notionalUSD: parseFloat((item.px * item.sz * ctVal).toFixed(2)),
                  bnrRate,
                  pnlRON: 0,
                  feeRON: 0,
                  isProfit: false,
                  grossGainRON: 0,
                  deductibleFeeRON: 0,
                  netTaxableGainRON: 0,
                  entryPx: item.px,
                  exitPx: item.px,
                  rawOrderId: item.ordId,
                  rawBillId: item.billId,
                },
                bnrRate
              );
              if (!dedupRecordsMap.has(rec.id)) {
                dedupRecordsMap.set(rec.id, rec);
                totalFeesRON += rec.feeRON;
              }
            }
          }
        }

        for (const buy of buyQueue) {
          if (buy.fee > 0) {
            const rec = AnafTaxEngine.recalculateRecordForRate(
              {
                id: `CSV_BUY_${sym}_${buy.ts}_${buy.ordId || buy.rowIdx}`,
                source: 'CSV_IMPORT',
                timestamp: buy.ts,
                dateFormatted: buy.dateFormatted,
                symbol: sym,
                side: 'BUY',
                closeType: 'OKX_CSV_ENTRY',
                pnlUSD: 0,
                feeUSD: parseFloat(buy.fee.toFixed(4)),
                notionalUSD: parseFloat((buy.px * buy.sz * ctVal).toFixed(2)),
                bnrRate,
                pnlRON: 0,
                feeRON: 0,
                isProfit: false,
                grossGainRON: 0,
                deductibleFeeRON: 0,
                netTaxableGainRON: 0,
                entryPx: buy.px,
                exitPx: buy.px,
                rawOrderId: buy.ordId,
                rawBillId: buy.billId,
              },
              bnrRate
            );
            if (!dedupRecordsMap.has(rec.id)) {
              dedupRecordsMap.set(rec.id, rec);
              totalFeesRON += rec.feeRON;
            }
          }
        }
      }
    }

    const generatedRecords = Array.from(dedupRecordsMap.values());
    this.saveImportedTransactions(generatedRecords);

    const yearsFound = Array.from(yearsSet).sort();
    const message = `Au fost procesate ${generatedRecords.length} înregistrări CSV OKX (${profitableCycles} pe plus, ${lossCycles} pe minus). Profit Brut: ${totalProfitRON.toFixed(2)} RON, Comisioane: ${totalFeesRON.toFixed(2)} RON. Ani detectați: ${yearsFound.join(', ') || '—'}.`;

    return {
      importedCount: generatedRecords.length,
      errors: [],
      yearsFound,
      profitableCycles,
      lossCycles,
      totalProfitRON: parseFloat(totalProfitRON.toFixed(2)),
      totalFeesRON: parseFloat(totalFeesRON.toFixed(2)),
      message,
    };
  }

  // ===========================================================================
  // 5. CANONICAL OKX LEDGER SYNC (BILLS + BILLS-ARCHIVE WITH FULL CURSOR PAGINATION)
  // ===========================================================================

  private async fetchOkxRawWithRetry(pathWithQuery: string): Promise<{ ok: boolean; data: any[]; error?: string }> {
    let lastError: string | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await this.okxAdapter.requestPrivate('GET', pathWithQuery);
        if (res && res.code === '0' && Array.isArray(res.data)) {
          return { ok: true, data: res.data };
        }
        const msg = String(res?.msg || '');
        const code = String(res?.code || '');
        const isRateLimit =
          code === '50011' || msg.toLowerCase().includes('rate limit') || msg.toLowerCase().includes('too many');
        if (isRateLimit && attempt < 2) {
          await this.sleep(Math.max(this.rateLimitDelayMs, 600) * (attempt + 1));
          continue;
        }
        lastError = msg || (code ? `OKX API code ${code}` : 'Răspuns invalid OKX');
        return { ok: false, data: [], error: lastError };
      } catch (err: any) {
        lastError = err?.message || 'OKX API request failed';
        const isRateLimit =
          lastError.includes('429') ||
          lastError.includes('50011') ||
          lastError.toLowerCase().includes('rate limit');
        if (isRateLimit && attempt < 2) {
          await this.sleep(Math.max(this.rateLimitDelayMs, 600) * (attempt + 1));
          continue;
        }
        if (process.env.OKX_DEBUG === '1') {
          console.warn(`[AnafTaxEngine] OKX API warning for ${pathWithQuery}:`, lastError);
        }
        return { ok: false, data: [], error: lastError };
      }
    }
    return { ok: false, data: [], error: lastError };
  }

  /**
   * Walks the entire OKX endpoint backward in time via the `after=<billId>` cursor
   * with rate-limit spacing, deduplication by `billId`, and optional incremental stop.
   */
  private async paginateBillsEndpoint(params: {
    endpoint: '/api/v5/account/bills' | '/api/v5/account/bills-archive';
    instType: 'FUTURES' | 'SWAP';
    transactionsMap: Map<string, AnafTransactionRecord>;
    bnrRate: number;
    rangeStartMs: number;
    rangeEndMs: number;
    forceFullArchive: boolean;
    delayMs: number;
  }): Promise<{ fetchedCount: number; error?: string }> {
    const { endpoint, instType, transactionsMap, bnrRate, rangeStartMs, rangeEndMs, forceFullArchive, delayMs } =
      params;

    let afterCursor = '';
    const seenCursors = new Set<string>();
    let fetchedCount = 0;

    for (let page = 0; page < MAX_CURSOR_PAGES; page++) {
      if (page > 0 && delayMs > 0) {
        await this.sleep(delayMs);
      }

      const query = `${endpoint}?instType=${instType}&type=2&limit=100${
        afterCursor ? `&after=${encodeURIComponent(afterCursor)}` : ''
      }`;
      const res = await this.fetchOkxRawWithRetry(query);
      if (!res.ok) {
        return { fetchedCount, error: res.error };
      }

      const items = res.data;
      if (!items || items.length === 0) break;

      fetchedCount += items.length;
      const batchResult = this.processOkxBillList(items, transactionsMap, bnrRate, rangeStartMs, rangeEndMs);

      const lastItem = items[items.length - 1];
      const nextCursor = String(lastItem?.billId || '').trim();
      if (!nextCursor || seenCursors.has(nextCursor) || items.length < 100) {
        break;
      }
      seenCursors.add(nextCursor);
      afterCursor = nextCursor;

      // Stop paging backward once OKX ledger timestamps cross strictly before startDate
      if (batchResult.oldestTsInPage > 0 && batchResult.oldestTsInPage < rangeStartMs) {
        break;
      }

      // Incremental optimization when not doing a full forced walk:
      // once an entire page of 100 bills is already stored in our canonical cache, we've bridged to history
      if (!forceFullArchive && batchResult.newlyAddedInPage === 0 && batchResult.eligibleInPage > 0) {
        break;
      }
    }

    return { fetchedCount };
  }

  /**
   * Canonical OKX API synchronization using ONLY `/api/v5/account/bills` (7d) and
   * `/api/v5/account/bills-archive` (3m) with complete `after` cursor pagination.
   * Zero mixing with `orders-history`, `fills`, `grid_arbitrages.json`, or `orders.json`.
   */
  public async syncFromOkxApi(options: {
    fiscalYear: number;
    startDate?: string;
    bnrRate: number;
    forceFullArchive?: boolean;
    nowMs?: number;
  }): Promise<{ syncedCount: number; newCount: number; status: AnafTaxSummary['okxApiSyncStatus'] }> {
    const { fiscalYear, startDate, bnrRate, nowMs } = options;
    const window = this.resolveDateWindow(fiscalYear, startDate, nowMs);

    const hasCreds = this.okxAdapter.hasCredentials();
    this.lastOkxSyncStatus.hasOkxCredentials = hasCreds;
    this.lastOkxSyncStatus.endpointsQueried = [];

    if (!hasCreds) {
      this.lastOkxSyncStatus.errorMessage =
        'Cheile API OKX nu sunt configurate (Mergi în Tab 5 pentru conectare cu API Key, Secret și Passphrase).';
      return { syncedCount: 0, newCount: 0, status: { ...this.lastOkxSyncStatus } };
    }

    const cacheStore = this.loadCanonicalCacheStore();
    const transactionsMap = new Map<string, AnafTransactionRecord>();
    for (const tx of cacheStore.records) {
      transactionsMap.set(tx.id, tx);
    }
    const countBefore = transactionsMap.size;

    // Force full walk if never synced cleanly under schema v2 or user explicitly requested full sync
    const forceFullArchive = Boolean(options.forceFullArchive || cacheStore.lastFullSyncAt === 0);

    let billsRecentCount = 0;
    let billsArchiveCount = 0;
    const endpointsUsed: string[] = ['/api/v5/account/bills', '/api/v5/account/bills-archive'];
    const instTypes: Array<'FUTURES' | 'SWAP'> = ['FUTURES', 'SWAP'];
    let firstWarningError: string | undefined;

    try {
      for (const instType of instTypes) {
        // 1. Recent Bills (last 7 days) — full cursor pagination
        const recentRes = await this.paginateBillsEndpoint({
          endpoint: '/api/v5/account/bills',
          instType,
          transactionsMap,
          bnrRate,
          rangeStartMs: window.startMs,
          rangeEndMs: window.endMs,
          forceFullArchive,
          delayMs: Math.min(this.rateLimitDelayMs, 150),
        });
        billsRecentCount += recentRes.fetchedCount;
        if (recentRes.error && !firstWarningError) firstWarningError = recentRes.error;

        // 2. Archive Bills (last 3 months) — full cursor pagination with OKX rate-limit spacing
        const archiveRes = await this.paginateBillsEndpoint({
          endpoint: '/api/v5/account/bills-archive',
          instType,
          transactionsMap,
          bnrRate,
          rangeStartMs: window.startMs,
          rangeEndMs: window.endMs,
          forceFullArchive,
          delayMs: this.rateLimitDelayMs,
        });
        billsArchiveCount += archiveRes.fetchedCount;
        if (archiveRes.error && !firstWarningError) firstWarningError = archiveRes.error;
      }

      const combined = Array.from(transactionsMap.values());
      const syncNow = this.nowFn();
      this.savePersistentSyncedTransactions(combined, {
        lastIncrementalSyncAt: syncNow,
        lastFullSyncAt: forceFullArchive ? syncNow : cacheStore.lastFullSyncAt,
      });

      const countAfter = transactionsMap.size;
      const newCount = Math.max(0, countAfter - countBefore);

      this.lastOkxSyncStatus = {
        ...this.lastOkxSyncStatus,
        lastSyncedAt: syncNow,
        totalOrdersFromArchive: 0,
        totalOrdersFromHistory: 0,
        totalBillsFromArchive: billsRecentCount + billsArchiveCount,
        totalFills: billsRecentCount + billsArchiveCount,
        billsRecentCount,
        billsArchiveCount,
        migratedFromLegacyCache: this.migratedFromLegacyCache,
        endpointsQueried: endpointsUsed,
        hasOkxCredentials: true,
        errorMessage: billsRecentCount + billsArchiveCount === 0 ? firstWarningError : undefined,
      };

      return {
        syncedCount: countAfter,
        newCount,
        status: { ...this.lastOkxSyncStatus },
      };
    } catch (err: any) {
      console.warn('[AnafTaxEngine] OKX API sync error:', err.message);
      this.lastOkxSyncStatus.errorMessage = `Eroare sincronizare OKX API: ${err.message}`;
      return {
        syncedCount: transactionsMap.size,
        newCount: 0,
        status: { ...this.lastOkxSyncStatus },
      };
    }
  }

  /**
   * Canonical processor for OKX Ledger Bills (`account/bills` & `account/bills-archive`),
   * strictly deduplicated by `billId` (`OKX_BILL_${billId}`).
   */
  private processOkxBillList(
    items: any[],
    map: Map<string, AnafTransactionRecord>,
    bnrRate: number,
    rangeStartMs: number,
    rangeEndMs: number
  ): { oldestTsInPage: number; eligibleInPage: number; newlyAddedInPage: number } {
    let oldestTsInPage = 0;
    let eligibleInPage = 0;
    let newlyAddedInPage = 0;

    for (const item of items) {
      const rawTs = parseInt(item.ts || '0', 10);
      if (!rawTs || !Number.isFinite(rawTs)) continue;
      if (oldestTsInPage === 0 || rawTs < oldestTsInPage) {
        oldestTsInPage = rawTs;
      }

      if (rawTs < rangeStartMs || rawTs > rangeEndMs) continue;

      const pnl = parseFloat(item.pnl || '0') || 0;
      const fee = Math.abs(parseFloat(item.fee || '0') || 0);

      // Ignore ledger entries that carry neither realized PnL nor trading fee
      if (Math.abs(pnl) < 1e-8 && fee < 1e-8) continue;

      const billId = String(item.billId || '').trim();
      if (!billId) continue;

      const id = `OKX_BILL_${billId}`;
      eligibleInPage++;
      if (map.has(id)) continue;

      const px = parseFloat(item.px || '0') || 0;
      const sz = Math.abs(parseFloat(item.sz || '0') || 0);
      const ctVal = this.okxAdapter.getCachedCtVal(item.instId || '');
      const notionalUSD = px * sz * (ctVal || 1);

      const subTypeStr = String(item.subType || item.side || '').toUpperCase();
      const side: 'BUY' | 'SELL' =
        subTypeStr.includes('SELL') || subTypeStr === '2' || subTypeStr === '4' ? 'SELL' : 'BUY';

      const record = AnafTaxEngine.recalculateRecordForRate(
        {
          id,
          source: 'OKX_API',
          timestamp: rawTs,
          dateFormatted: new Date(rawTs).toISOString().replace('T', ' ').slice(0, 19),
          symbol: item.instId || 'OKX_BILL',
          side,
          closeType:
            pnl > 0.000001
              ? 'OKX_BILL_PROFIT'
              : pnl < -0.000001
              ? 'OKX_BILL_LOSS'
              : 'OKX_LEDGER_FEE',
          pnlUSD: parseFloat(pnl.toFixed(4)),
          feeUSD: parseFloat(fee.toFixed(4)),
          notionalUSD: parseFloat(notionalUSD.toFixed(2)),
          bnrRate,
          pnlRON: 0,
          feeRON: 0,
          isProfit: false,
          grossGainRON: 0,
          deductibleFeeRON: 0,
          netTaxableGainRON: 0,
          entryPx: px > 0 ? px : undefined,
          exitPx: px > 0 ? px : undefined,
          rawOrderId: item.ordId ? String(item.ordId) : undefined,
          rawBillId: billId,
        },
        bnrRate
      );

      map.set(id, record);
      newlyAddedInPage++;
    }

    return { oldestTsInPage, eligibleInPage, newlyAddedInPage };
  }

  // ===========================================================================
  // 6. CANONICAL MERGE + DYNAMIC RECALCULATION + EFFICIENCY + MONTHLY ENGINE
  // ===========================================================================

  private collectCanonicalTransactions(params: {
    startMs: number;
    endMs: number;
    bnrRate: number;
  }): {
    transactions: AnafTransactionRecord[];
    persistentCount: number;
    apiCount: number;
    csvFallbackCount: number;
  } {
    const { startMs, endMs, bnrRate } = params;
    const persistent = this.getPersistentSyncedTransactions();

    const transactionsMap = new Map<string, AnafTransactionRecord>();
    const apiBillIds = new Set<string>();
    let earliestApiBillTs = 0;
    let apiCount = 0;

    // 1. Canonical OKX Bills first
    for (const tx of persistent) {
      if (!this.isCanonicalBillRecord(tx)) continue;
      const clean = this.normalizeCanonicalBillRecord(tx);
      if (clean.rawBillId) apiBillIds.add(clean.rawBillId);
      if (clean.timestamp > 0 && (earliestApiBillTs === 0 || clean.timestamp < earliestApiBillTs)) {
        earliestApiBillTs = clean.timestamp;
      }
      if (clean.timestamp >= startMs && clean.timestamp <= endMs) {
        transactionsMap.set(clean.id, AnafTaxEngine.recalculateRecordForRate(clean, bnrRate));
        apiCount++;
      }
    }

    // 2. Non-overlapping CSV fallback/complement (strictly for gaps/history older than API coverage or by unique billId)
    const imported = this.getImportedTransactions();
    let csvFallbackCount = 0;
    for (const item of imported) {
      if (item.timestamp < startMs || item.timestamp > endMs) continue;
      if (item.rawBillId && apiBillIds.has(String(item.rawBillId))) continue;
      if (item.rawBillId && transactionsMap.has(`OKX_BILL_${item.rawBillId}`)) continue;

      // If canonical API bills exist, skip CSV rows from the API-covered timeline (>= earliestApiBillTs)
      // to guarantee 0% overlapping double-counting between CSV exports and live API bills.
      if (earliestApiBillTs > 0 && item.timestamp >= earliestApiBillTs) {
        continue;
      }

      if (!transactionsMap.has(item.id)) {
        transactionsMap.set(item.id, AnafTaxEngine.recalculateRecordForRate(item, bnrRate));
        csvFallbackCount++;
      }
    }

    const transactions = Array.from(transactionsMap.values()).sort((a, b) => b.timestamp - a.timestamp);
    return {
      transactions,
      persistentCount: persistent.length,
      apiCount,
      csvFallbackCount,
    };
  }

  public static computeEfficiencyMetrics(params: {
    realNetPnLUSD: number;
    realNetPnLRON: number;
    taxesDueRON: number;
    incomeTaxOnlyRON: number;
    cassDueRON?: number;
    bnrRate: number;
  }): AnafTaxEfficiencyMetrics {
    const { realNetPnLUSD, realNetPnLRON, taxesDueRON, incomeTaxOnlyRON, cassDueRON, bnrRate } = params;
    const netAfterTaxRON = parseFloat((realNetPnLRON - taxesDueRON).toFixed(2));
    const netAfterTaxUSD = bnrRate > 0 ? parseFloat((netAfterTaxRON / bnrRate).toFixed(2)) : 0;

    const effectiveTaxRatePct =
      realNetPnLRON > 0.01 ? parseFloat(((taxesDueRON / realNetPnLRON) * 100).toFixed(1)) : null;

    const lossWithTaxDue = realNetPnLRON <= 0.01 && taxesDueRON > 0;
    const taxExceedsGain = taxesDueRON > 0 && realNetPnLRON < taxesDueRON;

    let status: AnafEfficiencyStatus = 'EFFICIENT';
    let statusLabel = 'Profitabil net';

    if (lossWithTaxDue) {
      status = 'LOSS_WITH_TAX';
      statusLabel = 'Pierdere reală + Taxă';
    } else if (taxExceedsGain) {
      status = 'TAX_EXCEEDS_GAIN';
      statusLabel = 'Taxă > Câștig';
    } else if (taxesDueRON === 0 && Math.abs(realNetPnLRON) <= 0.01) {
      status = 'BREAKEVEN';
      statusLabel = 'Fără taxă';
    } else if (effectiveTaxRatePct !== null && effectiveTaxRatePct >= 25) {
      status = 'HIGH_TAX';
      statusLabel = 'Presiune fiscală ridicată';
    }

    return {
      realNetPnLUSD: parseFloat(realNetPnLUSD.toFixed(4)),
      realNetPnLRON: parseFloat(realNetPnLRON.toFixed(2)),
      taxesDueRON,
      incomeTaxOnlyRON,
      cassDueRON,
      effectiveTaxRatePct,
      netAfterTaxRON,
      netAfterTaxUSD,
      status,
      taxExceedsGain,
      lossWithTaxDue,
      statusLabel,
    };
  }

  private buildMonthlySummaries(params: {
    transactions: AnafTransactionRecord[];
    startMs: number;
    endMs: number;
    effectiveNowMs: number;
    bnrRate: number;
    taxRatePct: number;
  }): AnafMonthlySummary[] {
    const { transactions, startMs, endMs, effectiveNowMs, bnrRate, taxRatePct } = params;
    if (endMs < startMs) return [];

    // Build contiguous list of calendar months from startMs -> endMs
    const startDate = new Date(startMs);
    const endDate = new Date(endMs);
    const monthsList: Array<{ year: number; month: number; yearMonth: string }> = [];

    let curY = startDate.getUTCFullYear();
    let curM = startDate.getUTCMonth() + 1;
    const endY = endDate.getUTCFullYear();
    const endM = endDate.getUTCMonth() + 1;

    while (curY < endY || (curY === endY && curM <= endM)) {
      monthsList.push({
        year: curY,
        month: curM,
        yearMonth: `${curY}-${String(curM).padStart(2, '0')}`,
      });
      curM++;
      if (curM > 12) {
        curM = 1;
        curY++;
      }
    }

    // Group transactions by YYYY-MM (UTC)
    const txByMonth = new Map<string, AnafTransactionRecord[]>();
    for (const tx of transactions) {
      const d = new Date(tx.timestamp);
      const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      if (!txByMonth.has(ym)) txByMonth.set(ym, []);
      txByMonth.get(ym)!.push(tx);
    }

    const apiWindowCutoffMs = effectiveNowMs - NINETY_DAYS_MS;
    const hasCreds = this.okxAdapter.hasCredentials();

    return monthsList.map(({ year, month, yearMonth }) => {
      const monthTxs = txByMonth.get(yearMonth) || [];
      let totalProfitUSD = 0;
      let totalLossUSD = 0;
      let totalFeesUSD = 0;
      let profitableCount = 0;
      let lossCount = 0;
      let grossRevenueRON = 0;
      let deductibleExpensesRON = 0;
      let okxApiBills = 0;
      let csvImport = 0;

      for (const tx of monthTxs) {
        totalFeesUSD += tx.feeUSD;
        if (tx.source === 'CSV_IMPORT') csvImport++;
        else okxApiBills++;

        if (tx.pnlUSD > 0.000001) {
          profitableCount++;
          totalProfitUSD += tx.pnlUSD;
          grossRevenueRON += tx.grossGainRON;
          deductibleExpensesRON += tx.deductibleFeeRON;
        } else if (tx.pnlUSD < -0.000001) {
          lossCount++;
          totalLossUSD += tx.pnlUSD;
        }
      }

      grossRevenueRON = parseFloat(grossRevenueRON.toFixed(2));
      deductibleExpensesRON = parseFloat(deductibleExpensesRON.toFixed(2));
      const netTaxableBaseRON = Math.max(0, parseFloat((grossRevenueRON - deductibleExpensesRON).toFixed(2)));
      const incomeTaxRON = Math.round(netTaxableBaseRON * (taxRatePct / 100));

      const netRealizedPnLUSD = parseFloat((totalProfitUSD + totalLossUSD).toFixed(4));
      const realNetPnLUSD = parseFloat((totalProfitUSD + totalLossUSD - totalFeesUSD).toFixed(4));
      const realNetPnLRON = parseFloat((realNetPnLUSD * bnrRate).toFixed(2));

      const efficiency = AnafTaxEngine.computeEfficiencyMetrics({
        realNetPnLUSD,
        realNetPnLRON,
        taxesDueRON: incomeTaxRON,
        incomeTaxOnlyRON: incomeTaxRON,
        bnrRate,
      });

      const monthStartMs = Date.UTC(year, month - 1, 1, 0, 0, 0, 0);
      let coverageStatus: AnafCoverageStatus = 'NO_DATA';
      let coverageLabel = 'Fără date (Conectează OKX sau CSV)';

      if (okxApiBills > 0 && csvImport > 0) {
        coverageStatus = 'API_PLUS_CSV';
        coverageLabel = 'API + CSV';
      } else if (okxApiBills > 0) {
        if (monthStartMs < apiWindowCutoffMs) {
          coverageStatus = 'PARTIAL_OLD_API';
          coverageLabel = 'Parțial / >3 luni — recomandat CSV';
        } else {
          coverageStatus = 'API_COMPLETE';
          coverageLabel = 'API Complet';
        }
      } else if (csvImport > 0) {
        coverageStatus = 'CSV_ONLY';
        coverageLabel = 'CSV Oficial OKX';
      } else if (monthStartMs < apiWindowCutoffMs) {
        coverageStatus = 'PARTIAL_OLD_API';
        coverageLabel = 'Peste 3 luni — recomandat CSV';
      } else if (hasCreds) {
        coverageStatus = 'API_COMPLETE';
        coverageLabel = 'API Complet (0 tranzacții)';
      }

      return {
        yearMonth,
        year,
        month,
        monthLabel: `${yearMonth} ${MONTH_NAMES_RO[month - 1]}`,
        transactionsCount: monthTxs.length,
        profitableCount,
        lossCount,
        winRatePct:
          monthTxs.length > 0 ? parseFloat(((profitableCount / monthTxs.length) * 100).toFixed(1)) : 0,
        totalProfitUSD: parseFloat(totalProfitUSD.toFixed(4)),
        totalLossUSD: parseFloat(totalLossUSD.toFixed(4)),
        totalFeesUSD: parseFloat(totalFeesUSD.toFixed(4)),
        netRealizedPnLUSD,
        grossRevenueRON,
        deductibleExpensesRON,
        netTaxableBaseRON,
        incomeTaxRON,
        efficiency,
        coverageStatus,
        coverageLabel,
        sourcesBreakdown: {
          okxApiBills,
          csvImport,
        },
      };
    });
  }

  /**
   * Core Fiscal Engine: computes Romanian ANAF Declarația Unică report aggregated monthly
   * from `startDate` (default `2026-10-01`) up to `today` using canonical OKX Bills +
   * non-overlapping CSV history, with live or manually overridden BNR USD/RON rate.
   */
  public async computeTaxReport(options: AnafTaxEngineOptions = {}): Promise<AnafTaxSummary> {
    const saved = this.getFiscalSettings(options.fiscalYear);
    const fiscalYear = options.fiscalYear || saved.fiscalYear || new Date(this.nowFn()).getUTCFullYear();
    const taxRatePct = Number.isFinite(options.taxRatePct) ? options.taxRatePct! : saved.taxRatePct;
    const minWageGrossRON = Number.isFinite(options.minWageGrossRON)
      ? options.minWageGrossRON!
      : saved.minWageGrossRON;

    const rates = await this.fetchBnrRates();
    const liveBnrUsdRonRate = rates.usdRon;

    let effectiveCustomRate: number | null = saved.customUsdRonRate;
    if (options.customUsdRonRate === null) {
      effectiveCustomRate = null;
    } else if (typeof options.customUsdRonRate === 'number' && options.customUsdRonRate > 0) {
      effectiveCustomRate = parseFloat(options.customUsdRonRate.toFixed(4));
    }

    const isCustomUsdRonRate = effectiveCustomRate !== null && effectiveCustomRate > 0;
    const bnrRate = isCustomUsdRonRate ? effectiveCustomRate! : liveBnrUsdRonRate;
    const ratesSource = isCustomUsdRonRate
      ? `Suprascris Manual (${bnrRate.toFixed(4)} vs BNR Live ${liveBnrUsdRonRate.toFixed(4)})`
      : rates.source;

    const window = this.resolveDateWindow(fiscalYear, options.startDate, options.nowMs);

    // Trigger canonical OKX API sync if requested or stale
    const shouldSyncOkx =
      options.forceSyncOkxApi ||
      (this.okxAdapter.hasCredentials() && this.nowFn() - this.lastOkxSyncStatus.lastSyncedAt > 120_000);

    if (shouldSyncOkx) {
      await this.syncFromOkxApi({
        fiscalYear,
        startDate: window.startDate,
        bnrRate,
        forceFullArchive: options.forceSyncOkxApi,
        nowMs: options.nowMs,
      });
    }

    const merged = this.collectCanonicalTransactions({
      startMs: window.startMs,
      endMs: window.endMs,
      bnrRate,
    });
    const allTransactions = merged.transactions;

    let grossRevenueRON = 0;
    let deductibleExpensesRON = 0;
    let totalProfitUSD = 0;
    let totalLossUSD = 0;
    let totalFeesUSD = 0;
    let profitableCount = 0;
    let lossCount = 0;

    for (const tx of allTransactions) {
      totalFeesUSD += tx.feeUSD;
      if (tx.pnlUSD > 0.000001) {
        profitableCount++;
        totalProfitUSD += tx.pnlUSD;
        grossRevenueRON += tx.grossGainRON;
        deductibleExpensesRON += tx.deductibleFeeRON;
      } else if (tx.pnlUSD < -0.000001) {
        lossCount++;
        totalLossUSD += tx.pnlUSD;
      }
    }

    grossRevenueRON = parseFloat(grossRevenueRON.toFixed(2));
    deductibleExpensesRON = parseFloat(deductibleExpensesRON.toFixed(2));
    const netTaxableBaseRON = Math.max(0, parseFloat((grossRevenueRON - deductibleExpensesRON).toFixed(2)));
    const incomeTaxRON = Math.round(netTaxableBaseRON * (taxRatePct / 100));

    // Real / Symmetric Portfolio Totals
    const netRealizedPnLUSD = parseFloat((totalProfitUSD + totalLossUSD).toFixed(4));
    const netRealizedPnLRON = parseFloat((netRealizedPnLUSD * bnrRate).toFixed(2));
    const totalFeesRON = parseFloat((totalFeesUSD * bnrRate).toFixed(2));
    const symmetricTaxableBaseRON = Math.max(0, parseFloat((netRealizedPnLRON - totalFeesRON).toFixed(2)));
    const symmetricTaxRON = Math.round(symmetricTaxableBaseRON * (taxRatePct / 100));
    const asymmetryDifferenceRON = Math.max(0, incomeTaxRON - symmetricTaxRON);

    // CASS (Sănătate) Ceilings
    const thresh6 = minWageGrossRON * 6;
    const thresh12 = minWageGrossRON * 12;
    const thresh24 = minWageGrossRON * 24;

    let ceilingLevel: CassCeilingLevel = 'SUB_6_SALARII';
    let ceilingLabel = `Sub 6 salarii (< ${thresh6.toLocaleString()} RON) • CASS = 0 RON`;
    let cassDueRON = 0;
    let progressToNextCeilingPct = 0;
    let remainingUntilNextCeilingRON = 0;

    if (netTaxableBaseRON < thresh6) {
      ceilingLevel = 'SUB_6_SALARII';
      ceilingLabel = `Sub 6 salarii (< ${thresh6.toLocaleString()} RON) • CASS = 0 RON`;
      cassDueRON = 0;
      remainingUntilNextCeilingRON = thresh6 - netTaxableBaseRON;
      progressToNextCeilingPct = parseFloat(((netTaxableBaseRON / thresh6) * 100).toFixed(1));
    } else if (netTaxableBaseRON < thresh12) {
      ceilingLevel = 'INTRE_6_SI_12_SALARII';
      ceilingLabel = `Plafon 6–12 salarii (${thresh6.toLocaleString()} – ${thresh12.toLocaleString()} RON)`;
      cassDueRON = Math.round(thresh6 * 0.1);
      remainingUntilNextCeilingRON = thresh12 - netTaxableBaseRON;
      progressToNextCeilingPct = parseFloat((((netTaxableBaseRON - thresh6) / (thresh12 - thresh6)) * 100).toFixed(1));
    } else if (netTaxableBaseRON < thresh24) {
      ceilingLevel = 'INTRE_12_SI_24_SALARII';
      ceilingLabel = `Plafon 12–24 salarii (${thresh12.toLocaleString()} – ${thresh24.toLocaleString()} RON)`;
      cassDueRON = Math.round(thresh12 * 0.1);
      remainingUntilNextCeilingRON = thresh24 - netTaxableBaseRON;
      progressToNextCeilingPct = parseFloat((((netTaxableBaseRON - thresh12) / (thresh24 - thresh12)) * 100).toFixed(1));
    } else {
      ceilingLevel = 'PESTE_24_SALARII';
      ceilingLabel = `Plafon Maxim peste 24 salarii (≥ ${thresh24.toLocaleString()} RON)`;
      cassDueRON = Math.round(thresh24 * 0.1);
      remainingUntilNextCeilingRON = 0;
      progressToNextCeilingPct = 100;
    }

    const totalOwedToStateRON = incomeTaxRON + cassDueRON;
    const realNetAfterFeesUSD = parseFloat((totalProfitUSD + totalLossUSD - totalFeesUSD).toFixed(4));
    const realNetAfterFeesRON = parseFloat((realNetAfterFeesUSD * bnrRate).toFixed(2));

    const ytdEfficiency = AnafTaxEngine.computeEfficiencyMetrics({
      realNetPnLUSD: realNetAfterFeesUSD,
      realNetPnLRON: realNetAfterFeesRON,
      taxesDueRON: totalOwedToStateRON,
      incomeTaxOnlyRON: incomeTaxRON,
      cassDueRON,
      bnrRate,
    });

    const monthlySummaries = this.buildMonthlySummaries({
      transactions: allTransactions,
      startMs: window.startMs,
      endMs: window.endMs,
      effectiveNowMs: window.effectiveNowMs,
      bnrRate,
      taxRatePct,
    });

    const partialMonths = monthlySummaries.filter((m) => m.coverageStatus === 'PARTIAL_OLD_API').length;
    const coverageSummary =
      partialMonths > 0
        ? `${partialMonths} ${partialMonths === 1 ? 'lună necesită' : 'luni necesită'} CSV oficial OKX (depășesc fereastra API de 3 luni)`
        : merged.csvFallbackCount > 0
        ? `Acoperire completă: ${merged.apiCount} bills OKX API + ${merged.csvFallbackCount} înregistrări CSV fără suprapunere`
        : `Acoperire canonică OKX Bills (${merged.apiCount} bills deduplicate după billId)`;

    const filingDeadline = `25 Mai ${fiscalYear + 1}`;
    const includeTransactions = options.includeTransactions === true;

    return {
      fiscalYear,
      startDate: window.startDate,
      endDate: window.endDate,
      taxRatePct,
      minWageGrossRON,
      usdRonRate: bnrRate,
      liveBnrUsdRonRate,
      isCustomUsdRonRate,
      eurRonRate: rates.eurRon,
      ratesUpdatedAt: this.bnrLastUpdated || this.nowFn(),
      ratesSource,
      totalTransactionsCount: allTransactions.length,
      profitableTransactionsCount: profitableCount,
      lossTransactionsCount: lossCount,
      winRatePct:
        allTransactions.length > 0
          ? parseFloat(((profitableCount / allTransactions.length) * 100).toFixed(1))
          : 0,
      asymmetric: {
        grossRevenueRON,
        deductibleExpensesRON,
        netTaxableBaseRON,
        incomeTaxRON,
      },
      symmetric: {
        totalProfitUSD: parseFloat(totalProfitUSD.toFixed(4)),
        totalLossUSD: parseFloat(totalLossUSD.toFixed(4)),
        netRealizedPnLUSD,
        totalFeesUSD: parseFloat(totalFeesUSD.toFixed(4)),
        netRealizedPnLRON,
        totalFeesRON,
        symmetricTaxRON,
        asymmetryDifferenceRON,
      },
      cass: {
        minWageThreshold6RON: thresh6,
        minWageThreshold12RON: thresh12,
        minWageThreshold24RON: thresh24,
        ceilingLevel,
        ceilingLabel,
        cassDueRON,
        progressToNextCeilingPct,
        remainingUntilNextCeilingRON: parseFloat(remainingUntilNextCeilingRON.toFixed(2)),
      },
      ytdEfficiency,
      monthlySummaries,
      coverageSummary,
      totalOwedToStateRON,
      filingDeadline,
      spvDeclarationGuide: {
        formName: 'Declarația Unică (Formular 212)',
        taxYear: fiscalYear,
        section: 'Secțiunea 1: Date privind veniturile realizate din Străinătate',
        subSection: 'Subsecțiunea 1.1: Venituri din transferul de monedă virtuală',
        category: 'Transferul de monedă virtuală (Art. 116 Cod Fiscal)',
        boxGrossRevenueRON: grossRevenueRON,
        boxDeductibleExpensesRON: deductibleExpensesRON,
        boxNetTaxableBaseRON: netTaxableBaseRON,
        boxIncomeTaxDueRON: incomeTaxRON,
        boxCassDueRON: cassDueRON,
        boxTotalDueRON: totalOwedToStateRON,
      },
      okxApiSyncStatus: {
        ...this.lastOkxSyncStatus,
        csvFallbackCount: merged.csvFallbackCount,
        migratedFromLegacyCache: this.migratedFromLegacyCache,
        hasOkxCredentials: this.okxAdapter.hasCredentials(),
      },
      persistentCacheCount: merged.persistentCount,
      transactions: includeTransactions ? allTransactions : [],
    };
  }

  /**
   * On-demand paginated transaction audit query filtered by month, profit/loss, and search term.
   * Dynamically recalculates RON amounts using the active BNR rate.
   */
  public async queryTransactions(options: AnafTransactionQueryOptions = {}): Promise<AnafTransactionPageResponse> {
    const saved = this.getFiscalSettings(options.fiscalYear);
    const fiscalYear = options.fiscalYear || saved.fiscalYear || new Date(this.nowFn()).getUTCFullYear();
    const rates = await this.fetchBnrRates();

    let effectiveCustomRate = saved.customUsdRonRate;
    if (options.customUsdRonRate === null) {
      effectiveCustomRate = null;
    } else if (typeof options.customUsdRonRate === 'number' && options.customUsdRonRate > 0) {
      effectiveCustomRate = parseFloat(options.customUsdRonRate.toFixed(4));
    }
    const bnrRate = effectiveCustomRate && effectiveCustomRate > 0 ? effectiveCustomRate : rates.usdRon;

    const window = this.resolveDateWindow(fiscalYear, options.startDate, options.nowMs);
    const merged = this.collectCanonicalTransactions({
      startMs: window.startMs,
      endMs: window.endMs,
      bnrRate,
    });

    let list = merged.transactions;
    const cleanMonth = options.yearMonth && options.yearMonth !== 'ALL' ? options.yearMonth.trim() : undefined;
    if (cleanMonth && /^\d{4}-\d{2}$/.test(cleanMonth)) {
      list = list.filter((tx) => tx.dateFormatted.startsWith(cleanMonth));
    }

    const profitableCount = list.filter((t) => t.isProfit).length;
    const lossCount = list.filter((t) => !t.isProfit).length;

    if (options.filter === 'PROFIT') {
      list = list.filter((t) => t.isProfit);
    } else if (options.filter === 'LOSS') {
      list = list.filter((t) => !t.isProfit);
    }

    if (options.search && options.search.trim()) {
      const q = options.search.trim().toUpperCase();
      list = list.filter(
        (t) =>
          t.symbol.toUpperCase().includes(q) ||
          t.id.toUpperCase().includes(q) ||
          (t.rawBillId && t.rawBillId.toUpperCase().includes(q)) ||
          t.closeType.toUpperCase().includes(q)
      );
    }

    const pageSize = Math.min(500, Math.max(10, Math.floor(Number(options.pageSize) || 100)));
    const totalCount = list.length;
    const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
    const page = Math.min(totalPages, Math.max(1, Math.floor(Number(options.page) || 1)));
    const startIdx = (page - 1) * pageSize;

    return {
      transactions: list.slice(startIdx, startIdx + pageSize),
      totalCount,
      profitableCount,
      lossCount,
      page,
      pageSize,
      totalPages,
      yearMonth: cleanMonth,
      usdRonRate: bnrRate,
    };
  }

  /**
   * Generates a complete audit CSV report for accountant / ANAF SPV filing
   * containing YTD summary, monthly breakdown with efficiency metrics, and all transactions.
   */
  public generateAuditCsv(summary: AnafTaxSummary): string {
    const esc = (v: any) => {
      const s = String(v ?? '');
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const lines: string[] = [];
    lines.push(`RAPORT FISCAL ANAF — DECLARATIA UNICA ${summary.fiscalYear} (AutoTrade-v5)`);
    lines.push(`Perioada Calcul: ${summary.startDate} -> ${summary.endDate}`);
    lines.push(`Data Generarii: ${new Date(this.nowFn()).toISOString()}`);
    lines.push(`Curs BNR Activ USD/RON: ${summary.usdRonRate} (${esc(summary.ratesSource)})`);
    lines.push(`Cota Impozit: ${summary.taxRatePct}%`);
    lines.push(`Salariu Minim Brut Utilizat: ${summary.minWageGrossRON} RON`);
    lines.push(`Total Tranzactii: ${summary.totalTransactionsCount}`);
    lines.push(`Venit Brut RON (Pozitive ANAF): ${summary.asymmetric.grossRevenueRON}`);
    lines.push(`Comisioane Deductibile RON: ${summary.asymmetric.deductibleExpensesRON}`);
    lines.push(`Venit Net Baza Impozabila RON: ${summary.asymmetric.netTaxableBaseRON}`);
    lines.push(`Impozit Datorat RON (${summary.taxRatePct}%): ${summary.asymmetric.incomeTaxRON}`);
    lines.push(`CASS Datorat RON: ${summary.cass.cassDueRON}`);
    lines.push(`TOTAL DATORAT BUGET STAT RON: ${summary.totalOwedToStateRON}`);
    lines.push(`PnL Real Net (Profit - Pierderi - Toate Comisioanele): ${summary.ytdEfficiency.realNetPnLUSD} USD / ${summary.ytdEfficiency.realNetPnLRON} RON`);
    lines.push(`Ramas Net Dupa Taxe: ${summary.ytdEfficiency.netAfterTaxRON} RON (${summary.ytdEfficiency.statusLabel})`);
    lines.push(`Termen Legal Plata: ${summary.filingDeadline}`);
    lines.push('');

    lines.push('SUMAR LUNAR ANAF & EFICIENTA FISCALA');
    lines.push(
      [
        'Luna',
        'Acoperire_Date',
        'Tranzactii',
        'Profit_USD',
        'Pierderi_USD',
        'Comisioane_USD',
        'PnL_Real_Net_USD',
        'PnL_Real_Net_RON',
        'Venit_Brut_ANAF_RON',
        'Comisioane_Deductibile_RON',
        'Baza_Impozabila_RON',
        'Impozit_ANAF_RON',
        'Rata_Efectiva_Pct',
        'Ramas_Net_Dupa_Taxe_RON',
        'Status_Eficienta',
      ].join(',')
    );

    for (const m of summary.monthlySummaries) {
      lines.push(
        [
          esc(m.monthLabel),
          esc(m.coverageLabel),
          m.transactionsCount,
          m.totalProfitUSD,
          m.totalLossUSD,
          m.totalFeesUSD,
          m.efficiency.realNetPnLUSD,
          m.efficiency.realNetPnLRON,
          m.grossRevenueRON,
          m.deductibleExpensesRON,
          m.netTaxableBaseRON,
          m.incomeTaxRON,
          m.efficiency.effectiveTaxRatePct ?? 'N/A',
          m.efficiency.netAfterTaxRON,
          esc(m.efficiency.statusLabel),
        ].join(',')
      );
    }

    lines.push(
      [
        esc('TOTAL PANA LA AZI (YTD incl. CASS)'),
        esc(summary.coverageSummary),
        summary.totalTransactionsCount,
        summary.symmetric.totalProfitUSD,
        summary.symmetric.totalLossUSD,
        summary.symmetric.totalFeesUSD,
        summary.ytdEfficiency.realNetPnLUSD,
        summary.ytdEfficiency.realNetPnLRON,
        summary.asymmetric.grossRevenueRON,
        summary.asymmetric.deductibleExpensesRON,
        summary.asymmetric.netTaxableBaseRON,
        summary.totalOwedToStateRON,
        summary.ytdEfficiency.effectiveTaxRatePct ?? 'N/A',
        summary.ytdEfficiency.netAfterTaxRON,
        esc(summary.ytdEfficiency.statusLabel),
      ].join(',')
    );

    lines.push('');
    lines.push('JURNAL COMPLET TRANZACTII');
    lines.push(
      [
        'ID_Tranzactie',
        'Data_UTC',
        'Sursa',
        'Instrument',
        'Sens',
        'Pret_Executie',
        'Tip_Inchidere',
        'Profit_USD',
        'Comision_USD',
        'Curs_BNR_RON',
        'Profit_RON',
        'Comision_Deductibil_RON',
        'Venit_Net_Impozabil_RON',
        'Eligibil_Profit_ANAF',
      ].join(',')
    );

    for (const t of summary.transactions) {
      lines.push(
        [
          esc(t.id),
          esc(t.dateFormatted),
          esc(t.source),
          esc(t.symbol),
          esc(t.side),
          esc(t.exitPx ?? t.entryPx ?? ''),
          esc(t.closeType),
          t.pnlUSD,
          t.feeUSD,
          t.bnrRate,
          t.pnlRON,
          t.deductibleFeeRON,
          t.netTaxableGainRON,
          t.isProfit ? 'DA (Pozitiv)' : 'NU (Pierdere)',
        ].join(',')
      );
    }

    return lines.join('\n');
  }
}
