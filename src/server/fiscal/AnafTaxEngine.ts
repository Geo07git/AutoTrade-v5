import fs from 'fs';
import path from 'path';
import { OKXAdapter } from '../exchange/OKXAdapter';
import { AnafTaxSummary, AnafTransactionRecord, CassCeilingLevel } from '../../shared/types';

interface AnafTaxEngineOptions {
  fiscalYear?: number;
  taxRatePct?: number; // 10% (standard transfer monedă virtuală) or 16%
  minWageGrossRON?: number; // 4050 RON în 2026
  customUsdRonRate?: number;
  dataDir?: string;
  forceSyncOkxApi?: boolean;
}

export class AnafTaxEngine {
  private okxAdapter: OKXAdapter;
  private dataDir: string;
  private importedCsvFile: string;
  private syncedTransactionsFile: string;
  private cachedBnrUsdRate: number = 4.62;
  private cachedBnrEurRate: number = 4.97;
  private bnrLastUpdated: number = 0;
  private bnrSource: string = 'BNR Reference (Calibrat)';

  private lastOkxSyncStatus = {
    lastSyncedAt: 0,
    totalOrdersFromArchive: 0,
    totalOrdersFromHistory: 0,
    totalBillsFromArchive: 0,
    totalFills: 0,
    endpointsQueried: [] as string[],
    hasOkxCredentials: false,
    errorMessage: undefined as string | undefined,
  };

  constructor(okxAdapter: OKXAdapter, dataDir: string = '.data') {
    this.okxAdapter = okxAdapter;
    this.dataDir = dataDir;
    this.importedCsvFile = path.join(this.dataDir, 'imported_okx_transactions.json');
    this.syncedTransactionsFile = path.join(this.dataDir, 'okx_synced_transactions.json');
    this.ensureDataDir();
  }

  private ensureDataDir(): void {
    try {
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true });
      }
    } catch {}
  }

  /**
   * Fetches live official exchange rates (USD/RON, EUR/RON) with multiple fallbacks
   */
  public async fetchBnrRates(force: boolean = false): Promise<{ usdRon: number; eurRon: number; source: string }> {
    const now = Date.now();
    if (!force && this.bnrLastUpdated > 0 && now - this.bnrLastUpdated < 3600_000) {
      return {
        usdRon: this.cachedBnrUsdRate,
        eurRon: this.cachedBnrEurRate,
        source: this.bnrSource,
      };
    }

    try {
      // Free public BNR rates feed
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
          this.bnrSource = 'BNR Live Feed (OpenExchange / BNR)';
          return {
            usdRon: this.cachedBnrUsdRate,
            eurRon: this.cachedBnrEurRate,
            source: this.bnrSource,
          };
        }
      }
    } catch {
      // Fallback 2: secondary exchange rate feed
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

    // Default calibrated reference rate for Romania
    this.bnrLastUpdated = now;
    return {
      usdRon: this.cachedBnrUsdRate,
      eurRon: this.cachedBnrEurRate,
      source: this.bnrSource,
    };
  }

  /**
   * Loads any manually imported OKX CSV transactions from .data/
   */
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

  /**
   * Saves imported transactions to persistent disk (.data/)
   */
  public saveImportedTransactions(records: AnafTransactionRecord[]): void {
    this.ensureDataDir();
    try {
      fs.writeFileSync(this.importedCsvFile, JSON.stringify(records, null, 2), 'utf8');
    } catch (err: any) {
      console.warn('[AnafTaxEngine] Failed to save imported transactions:', err.message);
    }
  }

  /**
   * Clears imported CSV transactions
   */
  public clearImportedTransactions(): void {
    try {
      if (fs.existsSync(this.importedCsvFile)) {
        fs.unlinkSync(this.importedCsvFile);
      }
    } catch {}
  }

  /**
   * Persistent cache of OKX synced transactions across preview container restarts
   */
  public getPersistentSyncedTransactions(): AnafTransactionRecord[] {
    try {
      if (fs.existsSync(this.syncedTransactionsFile)) {
        const raw = fs.readFileSync(this.syncedTransactionsFile, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch {}
    return [];
  }

  public savePersistentSyncedTransactions(records: AnafTransactionRecord[]): void {
    this.ensureDataDir();
    try {
      fs.writeFileSync(this.syncedTransactionsFile, JSON.stringify(records, null, 2), 'utf8');
    } catch (err: any) {
      console.warn('[AnafTaxEngine] Failed to save persistent synced transactions:', err.message);
    }
  }

  /**
   * Imports OKX raw CSV text (Order History, Trading History / Fills, Position History, or Bills)
   * Supporting auto-delimiter detection (comma, semicolon, tab), European decimal commas,
   * Romanian/English diacritics normalization, and FIFO round-trip matching when PnL column is missing.
   */
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

    // Save a backup of the raw uploaded file for audit / reprocessing
    try {
      this.ensureDataDir();
      fs.writeFileSync(path.join(this.dataDir, 'last_uploaded_okx.csv'), rawContent, 'utf8');
    } catch {}

    const lines = rawContent.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
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

    // 1. Auto-detect delimiter: count ',', ';', '\t', '|' in the first 5 non-empty lines
    const sampleLines = lines.slice(0, Math.min(5, lines.length));
    const commaCount = sampleLines.reduce((acc, l) => acc + (l.match(/,/g) || []).length, 0);
    const semiCount = sampleLines.reduce((acc, l) => acc + (l.match(/;/g) || []).length, 0);
    const tabCount = sampleLines.reduce((acc, l) => acc + (l.match(/\t/g) || []).length, 0);

    let delimiter = ',';
    if (semiCount > commaCount && semiCount > tabCount) delimiter = ';';
    else if (tabCount > commaCount && tabCount > semiCount) delimiter = '\t';

    // 2. Parse a single line respecting quotes
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

    // 3. Normalization helper: removes Romanian/European diacritics and converts to lower case
    const norm = (s: string) =>
      (s || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();

    // 4. Number parsing helper: handles European decimal commas ('13,66'), dot thousands, and currency suffixes
    const parseNumeric = (val?: string): number => {
      if (!val) return 0;
      let str = String(val).replace(/^["']|["']$/g, '').trim();
      // Remove trailing currency tokens like USDT, USD, EUR, RON, BTC, %, spaces
      str = str.replace(/(usdt|usd|eur|ron|btc|eth|%|\s)+$/i, '').trim();
      if (!str) return 0;

      // European format with dot thousands and comma decimal: 1.234,56
      if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(str)) {
        str = str.replace(/\./g, '').replace(',', '.');
      }
      // US format with comma thousands and dot decimal: 1,234.56
      else if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(str)) {
        str = str.replace(/,/g, '');
      }
      // Plain comma decimal: 13,66 or -0,05
      else if (str.includes(',') && !str.includes('.')) {
        str = str.replace(',', '.');
      }

      const num = parseFloat(str);
      return Number.isFinite(num) ? num : 0;
    };

    // 5. Header identification
    const headerCols = parseCsvRow(lines[0]).map(norm);
    const findIdx = (keywords: string[]) =>
      headerCols.findIndex((h) => keywords.some((k) => h.includes(norm(k))));

    const timeIdx = findIdx([
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
      'moneda',
      'pereche',
      'asset',
    ]);

    const sideIdx = findIdx([
      'side',
      'direction',
      'sens',
      'directie',
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
      'profit and loss',
      'total pnl',
      'net pnl',
      'pnl',
      'profit',
      'venit realizat',
      'castig',
      'fillpnl',
    ]);

    const ordIdIdx = findIdx(['order id', 'ordid', 'trade id', 'fillid', 'bill id', 'id ordin', 'id tranzactie', 'id']);

    const bnrRate = this.cachedBnrUsdRate || 4.62;

    // 6. First pass: extract all raw rows
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
      ordId?: string;
    }

    const rawItems: RawCsvItem[] = [];
    const yearsSet = new Set<number>();

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const cols = parseCsvRow(line);

      const rawTimeStr = timeIdx >= 0 ? cols[timeIdx] : '';
      let ts = Date.now();
      if (rawTimeStr) {
        // Handle Unix timestamp (milliseconds or seconds)
        if (/^\d{10,13}$/.test(rawTimeStr)) {
          const numTs = parseInt(rawTimeStr, 10);
          ts = rawTimeStr.length === 10 ? numTs * 1000 : numTs;
        } else {
          // Standard date parse
          const parsed = Date.parse(rawTimeStr);
          if (!isNaN(parsed)) ts = parsed;
        }
      }

      const itemDate = new Date(ts);
      const itemYear = itemDate.getFullYear();
      if (itemYear >= 2020 && itemYear <= 2030) {
        yearsSet.add(itemYear);
      }

      // Symbol
      let rawInst = instIdIdx >= 0 && cols[instIdIdx] ? cols[instIdIdx] : 'OKX_CONTRACT';
      rawInst = rawInst.replace(/^["']|["']$/g, '').trim();

      // Side
      const rawSideStr = (sideIdx >= 0 && cols[sideIdx] ? cols[sideIdx] : '').toUpperCase();
      const isBuy =
        rawSideStr.includes('BUY') ||
        rawSideStr.includes('CUMPAR') ||
        rawSideStr.includes('LONG') ||
        rawSideStr.includes('BID');
      const side: 'BUY' | 'SELL' = isBuy ? 'BUY' : 'SELL';

      // Prices & Quantities
      const px = fillPxIdx >= 0 ? parseNumeric(cols[fillPxIdx]) : 0;
      const openPx = openPxIdx >= 0 ? parseNumeric(cols[openPxIdx]) : undefined;
      const closePx = closePxIdx >= 0 ? parseNumeric(cols[closePxIdx]) : undefined;
      const sz = fillSzIdx >= 0 ? Math.abs(parseNumeric(cols[fillSzIdx])) : 1;
      const fee = feeIdx >= 0 ? Math.abs(parseNumeric(cols[feeIdx])) : 0;
      const pnl = pnlIdx >= 0 ? parseNumeric(cols[pnlIdx]) : 0;
      const ordId = ordIdIdx >= 0 ? cols[ordIdIdx] : undefined;

      rawItems.push({
        rowIdx: i,
        ts,
        dateFormatted: itemDate.toISOString().replace('T', ' ').slice(0, 19),
        inst: rawInst,
        side,
        px: px > 0 ? px : (closePx || openPx || 0),
        openPx: openPx && openPx > 0 ? openPx : undefined,
        closePx: closePx && closePx > 0 ? closePx : undefined,
        sz,
        fee,
        pnl,
        ordId,
      });
    }

    const hasExplicitPnL = rawItems.some((r) => Math.abs(r.pnl) > 1e-6);

    const generatedRecords: AnafTransactionRecord[] = [];
    let profitableCycles = 0;
    let lossCycles = 0;
    let totalProfitRON = 0;
    let totalFeesRON = 0;

    // Case A: CSV has explicit Realized PnL column (e.g. Position History or Trading History)
    if (hasExplicitPnL) {
      for (const item of rawItems) {
        const pnlUSD = item.pnl;
        const feeUSD = item.fee;
        const pnlRON = parseFloat((pnlUSD * bnrRate).toFixed(2));
        const feeRON = parseFloat((feeUSD * bnrRate).toFixed(2));
        const isProfit = pnlUSD > 0.000001;
        const grossGainRON = isProfit ? pnlRON : 0;
        const deductibleFeeRON = isProfit ? feeRON : 0;
        const netTaxableGainRON = Math.max(0, parseFloat((grossGainRON - deductibleFeeRON).toFixed(2)));

        if (isProfit) {
          profitableCycles++;
          totalProfitRON += grossGainRON;
        } else if (pnlUSD < -0.000001) {
          lossCycles++;
        }
        totalFeesRON += feeRON;

        const notionalUSD = item.px * item.sz;
        const id = `CSV_${item.inst}_${item.ts}_${item.rowIdx}`;

        generatedRecords.push({
          id,
          source: 'CSV_IMPORT',
          timestamp: item.ts,
          dateFormatted: item.dateFormatted,
          symbol: item.inst,
          side: item.side,
          closeType: isProfit ? 'OKX_CSV_PROFIT' : pnlUSD < 0 ? 'OKX_CSV_LOSS' : 'OKX_CSV_FILL',
          pnlUSD: parseFloat(pnlUSD.toFixed(4)),
          feeUSD: parseFloat(feeUSD.toFixed(4)),
          notionalUSD: parseFloat(notionalUSD.toFixed(2)),
          bnrRate,
          pnlRON,
          feeRON,
          isProfit,
          grossGainRON,
          deductibleFeeRON,
          netTaxableGainRON,
          entryPx: item.openPx || item.px,
          exitPx: item.closePx || item.px,
          rawOrderId: item.ordId,
        });
      }
    } else {
      // Case B: CSV is Order History or Fills WITHOUT explicit PnL column (standard OKX orders export)
      // We run a FIFO matching engine on Buy and Sell orders by contract to reconstruct round-trip cycles!
      rawItems.sort((a, b) => a.ts - b.ts);

      const itemsBySymbol = new Map<string, RawCsvItem[]>();
      for (const item of rawItems) {
        if (!itemsBySymbol.has(item.inst)) {
          itemsBySymbol.set(item.inst, []);
        }
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

              const pnlRON = parseFloat((calculatedPnlUSD * bnrRate).toFixed(2));
              const feeRON = parseFloat((combinedFeeUSD * bnrRate).toFixed(2));
              const isProfit = calculatedPnlUSD > 0.000001;
              const grossGainRON = isProfit ? pnlRON : 0;
              const deductibleFeeRON = isProfit ? feeRON : 0;
              const netTaxableGainRON = Math.max(0, parseFloat((grossGainRON - deductibleFeeRON).toFixed(2)));

              if (isProfit) {
                profitableCycles++;
                totalProfitRON += grossGainRON;
              } else if (calculatedPnlUSD < -0.000001) {
                lossCycles++;
              }
              totalFeesRON += feeRON;

              const notionalUSD = exitPx * matchedSz * ctVal;
              const id = `CSV_CYCLE_${sym}_${item.ts}_${item.rowIdx}`;

              generatedRecords.push({
                id,
                source: 'CSV_IMPORT',
                timestamp: item.ts,
                dateFormatted: item.dateFormatted,
                symbol: sym,
                side: 'SELL',
                closeType: isProfit ? 'OKX_CSV_FIFO_PROFIT' : 'OKX_CSV_FIFO_LOSS',
                pnlUSD: parseFloat(calculatedPnlUSD.toFixed(4)),
                feeUSD: parseFloat(combinedFeeUSD.toFixed(4)),
                notionalUSD: parseFloat(notionalUSD.toFixed(2)),
                bnrRate,
                pnlRON,
                feeRON,
                isProfit,
                grossGainRON,
                deductibleFeeRON,
                netTaxableGainRON,
                entryPx,
                exitPx,
                rawOrderId: item.ordId,
              });
            } else {
              // Unmatched Sell fill with fee
              const feeUSD = item.fee;
              const feeRON = parseFloat((feeUSD * bnrRate).toFixed(2));
              totalFeesRON += feeRON;

              generatedRecords.push({
                id: `CSV_FILL_${sym}_${item.ts}_${item.rowIdx}`,
                source: 'CSV_IMPORT',
                timestamp: item.ts,
                dateFormatted: item.dateFormatted,
                symbol: sym,
                side: 'SELL',
                closeType: 'OKX_CSV_EXECUTION',
                pnlUSD: 0,
                feeUSD: parseFloat(feeUSD.toFixed(4)),
                notionalUSD: parseFloat((item.px * item.sz * ctVal).toFixed(2)),
                bnrRate,
                pnlRON: 0,
                feeRON,
                isProfit: false,
                grossGainRON: 0,
                deductibleFeeRON: 0,
                netTaxableGainRON: 0,
                entryPx: item.px,
                exitPx: item.px,
                rawOrderId: item.ordId,
              });
            }
          }
        }

        // Any remaining unmatched Buys with fees
        for (const buy of buyQueue) {
          if (buy.fee > 0) {
            const feeRON = parseFloat((buy.fee * bnrRate).toFixed(2));
            totalFeesRON += feeRON;

            generatedRecords.push({
              id: `CSV_BUY_${sym}_${buy.ts}_${buy.rowIdx}`,
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
              feeRON,
              isProfit: false,
              grossGainRON: 0,
              deductibleFeeRON: 0,
              netTaxableGainRON: 0,
              entryPx: buy.px,
              exitPx: buy.px,
              rawOrderId: buy.ordId,
            });
          }
        }
      }
    }

    // Replace the saved imported CSV transactions with newly computed records
    this.saveImportedTransactions(generatedRecords);

    const yearsFound = Array.from(yearsSet).sort();
    const message = `Au fost procesate cu succes ${generatedRecords.length} tranzacții OKX (${profitableCycles} pe plus, ${lossCycles} pe minus). Profit Brut: ${totalProfitRON.toFixed(2)} RON, Comisioane: ${totalFeesRON.toFixed(2)} RON. Ani detectați: ${yearsFound.join(', ')}.`;

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

  /**
   * Queries OKX API endpoint with error catching and optional pagination
   */
  private async fetchOkxPaged(pathWithQuery: string): Promise<any[]> {
    try {
      const res = await this.okxAdapter.requestPrivate('GET', pathWithQuery);
      if (res && res.code === '0' && Array.isArray(res.data)) {
        return res.data;
      }
    } catch (err: any) {
      if (process.env.OKX_DEBUG === '1') {
        console.warn(`[AnafTaxEngine] OKX API fetch warning for ${pathWithQuery}:`, err.message);
      }
    }
    return [];
  }

  /**
   * Deep Historical Synchronization with OKX REST API v5:
   * 1. /api/v5/trade/orders-history-archive (orders older than 3 months, up to 3 years)
   * 2. /api/v5/trade/orders-history (orders in last 3 months)
   * 3. /api/v5/account/bills-archive & /api/v5/account/bills (ledger items, trading fees & PnLs)
   * 4. /api/v5/trade/fills-history & /api/v5/trade/fills (individual fills)
   *
   * Matches Entry/Exit FIFO prices and stores all deduplicated records into
   * .data/okx_synced_transactions.json to guarantee persistent tax audit history.
   */
  public async syncFromOkxApi(options: {
    fiscalYear: number;
    bnrRate: number;
    forceFullArchive?: boolean;
  }): Promise<{ syncedCount: number; newCount: number; status: any }> {
    const { fiscalYear, bnrRate } = options;
    const yearStart = new Date(Date.UTC(fiscalYear, 0, 1, 0, 0, 0)).getTime();
    const yearEnd = new Date(Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999)).getTime();

    const hasCreds = this.okxAdapter.hasCredentials();
    this.lastOkxSyncStatus.hasOkxCredentials = hasCreds;
    this.lastOkxSyncStatus.endpointsQueried = [];

    if (!hasCreds) {
      this.lastOkxSyncStatus.errorMessage =
        'Cheile API OKX nu sunt configurate (Mergi în Tab 5 pentru conectare cu API Key, Secret și Passphrase).';
      return { syncedCount: 0, newCount: 0, status: this.lastOkxSyncStatus };
    }

    // Load existing persistent cache
    const existing = this.getPersistentSyncedTransactions();
    const transactionsMap = new Map<string, AnafTransactionRecord>();
    for (const tx of existing) {
      transactionsMap.set(tx.id, tx);
    }
    const countBefore = transactionsMap.size;

    let ordersArchiveCount = 0;
    let ordersHistoryCount = 0;
    let billsArchiveCount = 0;
    let fillsCount = 0;

    const endpointsUsed: string[] = [];

    try {
      // -----------------------------------------------------------------------
      // A. /api/v5/trade/orders-history-archive (Up to 3 months to 3 years old)
      // -----------------------------------------------------------------------
      // We query FUTURES (EEA contracts like _UM_XPERP) and SWAP (standard perp)
      endpointsUsed.push('/api/v5/trade/orders-history-archive');
      const instTypes = ['FUTURES', 'SWAP'];

      for (const instType of instTypes) {
        // Query by quarter for the fiscal year if needed
        for (const q of [1, 2, 3, 4]) {
          const archiveQuarterItems = await this.fetchOkxPaged(
            `/api/v5/trade/orders-history-archive?instType=${instType}&state=filled&year=${fiscalYear}&quarter=${q}&limit=100`
          );
          if (archiveQuarterItems.length > 0) {
            ordersArchiveCount += archiveQuarterItems.length;
            this.processOkxOrderList(archiveQuarterItems, transactionsMap, bnrRate, yearStart, yearEnd, 'OKX_ARCHIVE');
          }
        }

        // Generic archive query with pagination
        let afterCursor = '';
        for (let page = 0; page < 3; page++) {
          const query = `/api/v5/trade/orders-history-archive?instType=${instType}&state=filled&limit=100${
            afterCursor ? `&after=${afterCursor}` : ''
          }`;
          const items = await this.fetchOkxPaged(query);
          if (!items || items.length === 0) break;
          ordersArchiveCount += items.length;
          this.processOkxOrderList(items, transactionsMap, bnrRate, yearStart, yearEnd, 'OKX_ARCHIVE');
          afterCursor = items[items.length - 1]?.ordId || '';
          if (!afterCursor || items.length < 100) break;
        }
      }

      // -----------------------------------------------------------------------
      // B. /api/v5/trade/orders-history (Completed orders in the last 3 months)
      // -----------------------------------------------------------------------
      endpointsUsed.push('/api/v5/trade/orders-history');
      for (const instType of instTypes) {
        let afterCursor = '';
        for (let page = 0; page < 4; page++) {
          const query = `/api/v5/trade/orders-history?instType=${instType}&state=filled&limit=100${
            afterCursor ? `&after=${afterCursor}` : ''
          }`;
          const items = await this.fetchOkxPaged(query);
          if (!items || items.length === 0) break;
          ordersHistoryCount += items.length;
          this.processOkxOrderList(items, transactionsMap, bnrRate, yearStart, yearEnd, 'OKX_ORDERS_HISTORY');
          afterCursor = items[items.length - 1]?.ordId || '';
          if (!afterCursor || items.length < 100) break;
        }
      }

      // -----------------------------------------------------------------------
      // C. /api/v5/account/bills-archive & /api/v5/account/bills (Ledger Entries)
      // -----------------------------------------------------------------------
      endpointsUsed.push('/api/v5/account/bills-archive', '/api/v5/account/bills');
      for (const instType of instTypes) {
        // Bills Archive (trades, liquidations, deliveries)
        for (const q of [1, 2, 3, 4]) {
          const archiveBills = await this.fetchOkxPaged(
            `/api/v5/account/bills-archive?instType=${instType}&type=2&year=${fiscalYear}&quarter=${q}&limit=100`
          );
          if (archiveBills.length > 0) {
            billsArchiveCount += archiveBills.length;
            this.processOkxBillList(archiveBills, transactionsMap, bnrRate, yearStart, yearEnd);
          }
        }

        // Recent Bills (last 7 days)
        const recentBills = await this.fetchOkxPaged(`/api/v5/account/bills?instType=${instType}&limit=100`);
        if (recentBills.length > 0) {
          billsArchiveCount += recentBills.length;
          this.processOkxBillList(recentBills, transactionsMap, bnrRate, yearStart, yearEnd);
        }
      }

      // -----------------------------------------------------------------------
      // D. /api/v5/trade/fills-history & /api/v5/trade/fills (Individual executions)
      // -----------------------------------------------------------------------
      endpointsUsed.push('/api/v5/trade/fills-history', '/api/v5/trade/fills');
      for (const instType of instTypes) {
        const [recentFills, historyFills] = await Promise.all([
          this.fetchOkxPaged(`/api/v5/trade/fills?instType=${instType}&limit=100`),
          this.fetchOkxPaged(`/api/v5/trade/fills-history?instType=${instType}&limit=100`),
        ]);
        const allFills = [...recentFills, ...historyFills];
        fillsCount += allFills.length;
        this.processOkxFillsList(allFills, transactionsMap, bnrRate, yearStart, yearEnd);
      }

      // -----------------------------------------------------------------------
      // E. FIFO Entry/Exit Matching for Grid orders without direct PnL
      // -----------------------------------------------------------------------
      this.reconcileEntryExitPairs(transactionsMap, bnrRate);

      // Save merged deduplicated records to persistent disk (.data/okx_synced_transactions.json)
      const combined = Array.from(transactionsMap.values());
      this.savePersistentSyncedTransactions(combined);

      const countAfter = transactionsMap.size;
      const newCount = Math.max(0, countAfter - countBefore);

      this.lastOkxSyncStatus = {
        lastSyncedAt: Date.now(),
        totalOrdersFromArchive: ordersArchiveCount,
        totalOrdersFromHistory: ordersHistoryCount,
        totalBillsFromArchive: billsArchiveCount,
        totalFills: fillsCount,
        endpointsQueried: endpointsUsed,
        hasOkxCredentials: true,
        errorMessage: undefined,
      };

      return {
        syncedCount: countAfter,
        newCount,
        status: this.lastOkxSyncStatus,
      };
    } catch (err: any) {
      console.warn('[AnafTaxEngine] OKX API sync error:', err.message);
      this.lastOkxSyncStatus.errorMessage = `Eroare sincronizare OKX API: ${err.message}`;
      return {
        syncedCount: transactionsMap.size,
        newCount: 0,
        status: this.lastOkxSyncStatus,
      };
    }
  }

  /**
   * Processes OKX Orders (from orders-history and orders-history-archive)
   */
  private processOkxOrderList(
    items: any[],
    map: Map<string, AnafTransactionRecord>,
    bnrRate: number,
    yearStart: number,
    yearEnd: number,
    sourceTag: string
  ): void {
    for (const item of items) {
      const rawTs = parseInt(item.uTime || item.fillTime || item.cTime || '0', 10);
      if (!rawTs || rawTs < yearStart || rawTs > yearEnd) continue;

      const pnl = parseFloat(item.pnl || '0') || 0;
      const fee = Math.abs(parseFloat(item.fee || '0') || 0);
      const avgPx = parseFloat(item.avgPx || item.fillPx || item.px || '0') || 0;
      const fillSz = Math.abs(parseFloat(item.accFillSz || item.fillSz || item.sz || '0') || 0);
      const ctVal = this.okxAdapter.getCachedCtVal(item.instId || '');
      const notionalUSD = avgPx * fillSz * (ctVal || 1);

      // Unique record ID
      const ordId = item.ordId || `${item.clOrdId}_${rawTs}`;
      const id = `OKX_ORD_${ordId}`;

      const pnlRON = parseFloat((pnl * bnrRate).toFixed(2));
      const feeRON = parseFloat((fee * bnrRate).toFixed(2));
      const isProfit = pnl > 0.000001;
      const grossGainRON = isProfit ? pnlRON : 0;
      const deductibleFeeRON = isProfit ? feeRON : 0;
      const netTaxableGainRON = Math.max(0, parseFloat((grossGainRON - deductibleFeeRON).toFixed(2)));

      const side = String(item.side || '').toUpperCase() === 'SELL' ? 'SELL' : 'BUY';

      map.set(id, {
        id,
        source: 'OKX_API',
        timestamp: rawTs,
        dateFormatted: new Date(rawTs).toISOString().replace('T', ' ').slice(0, 19),
        symbol: item.instId || 'OKX_CONTRACT',
        side,
        closeType: isProfit
          ? 'OKX_ORDER_PROFIT'
          : pnl < -0.000001
          ? 'OKX_ORDER_LOSS'
          : `${sourceTag}_${side}`,
        pnlUSD: parseFloat(pnl.toFixed(4)),
        feeUSD: parseFloat(fee.toFixed(4)),
        notionalUSD: parseFloat(notionalUSD.toFixed(2)),
        bnrRate,
        pnlRON,
        feeRON,
        isProfit,
        grossGainRON,
        deductibleFeeRON,
        netTaxableGainRON,
        entryPx: avgPx > 0 ? avgPx : undefined,
        exitPx: avgPx > 0 ? avgPx : undefined,
        rawOrderId: ordId,
      });
    }
  }

  /**
   * Processes OKX Ledger Bills (from bills and bills-archive)
   */
  private processOkxBillList(
    items: any[],
    map: Map<string, AnafTransactionRecord>,
    bnrRate: number,
    yearStart: number,
    yearEnd: number
  ): void {
    for (const item of items) {
      const rawTs = parseInt(item.ts || '0', 10);
      if (!rawTs || rawTs < yearStart || rawTs > yearEnd) continue;

      const pnl = parseFloat(item.pnl || '0') || 0;
      const fee = Math.abs(parseFloat(item.fee || '0') || 0);

      // Only interested in trading bills with realized PnL or fee
      if (Math.abs(pnl) < 1e-8 && fee < 1e-8) continue;

      const billId = String(item.billId || `${item.instId}_${rawTs}`);
      const id = `OKX_BILL_${billId}`;
      if (map.has(id)) continue;

      const px = parseFloat(item.px || '0') || 0;
      const sz = Math.abs(parseFloat(item.sz || '0') || 0);
      const ctVal = this.okxAdapter.getCachedCtVal(item.instId || '');
      const notionalUSD = px * sz * (ctVal || 1);

      const pnlRON = parseFloat((pnl * bnrRate).toFixed(2));
      const feeRON = parseFloat((fee * bnrRate).toFixed(2));
      const isProfit = pnl > 0.000001;
      const grossGainRON = isProfit ? pnlRON : 0;
      const deductibleFeeRON = isProfit ? feeRON : 0;
      const netTaxableGainRON = Math.max(0, parseFloat((grossGainRON - deductibleFeeRON).toFixed(2)));

      const side = String(item.subType || item.side || '').toUpperCase().includes('SELL') ? 'SELL' : 'BUY';

      map.set(id, {
        id,
        source: 'OKX_API',
        timestamp: rawTs,
        dateFormatted: new Date(rawTs).toISOString().replace('T', ' ').slice(0, 19),
        symbol: item.instId || 'OKX_BILL',
        side,
        closeType: isProfit
          ? 'OKX_BILL_PROFIT'
          : pnl < -0.000001
          ? 'OKX_BILL_LOSS'
          : 'OKX_LEDGER_FEE',
        pnlUSD: parseFloat(pnl.toFixed(4)),
        feeUSD: parseFloat(fee.toFixed(4)),
        notionalUSD: parseFloat(notionalUSD.toFixed(2)),
        bnrRate,
        pnlRON,
        feeRON,
        isProfit,
        grossGainRON,
        deductibleFeeRON,
        netTaxableGainRON,
        entryPx: px > 0 ? px : undefined,
        exitPx: px > 0 ? px : undefined,
        rawBillId: billId,
      });
    }
  }

  /**
   * Processes OKX Fills (from fills and fills-history)
   */
  private processOkxFillsList(
    items: any[],
    map: Map<string, AnafTransactionRecord>,
    bnrRate: number,
    yearStart: number,
    yearEnd: number
  ): void {
    for (const item of items) {
      const rawTs = parseInt(item.fillTime || item.ts || '0', 10);
      if (!rawTs || rawTs < yearStart || rawTs > yearEnd) continue;

      const pnl = parseFloat(item.fillPnl || item.pnl || '0') || 0;
      const fee = Math.abs(parseFloat(item.fee || '0') || 0);

      if (Math.abs(pnl) < 1e-8 && fee < 1e-8) continue;

      const tradeId = String(item.tradeId || `${item.ordId}_${rawTs}`);
      const id = `OKX_FILL_${tradeId}`;
      if (map.has(id)) continue;

      const px = parseFloat(item.fillPx || item.px || '0') || 0;
      const sz = Math.abs(parseFloat(item.fillSz || item.sz || '0') || 0);
      const ctVal = this.okxAdapter.getCachedCtVal(item.instId || '');
      const notionalUSD = px * sz * (ctVal || 1);

      const pnlRON = parseFloat((pnl * bnrRate).toFixed(2));
      const feeRON = parseFloat((fee * bnrRate).toFixed(2));
      const isProfit = pnl > 0.000001;
      const grossGainRON = isProfit ? pnlRON : 0;
      const deductibleFeeRON = isProfit ? feeRON : 0;
      const netTaxableGainRON = Math.max(0, parseFloat((grossGainRON - deductibleFeeRON).toFixed(2)));

      const side = String(item.side || '').toUpperCase() === 'SELL' ? 'SELL' : 'BUY';

      map.set(id, {
        id,
        source: 'OKX_API',
        timestamp: rawTs,
        dateFormatted: new Date(rawTs).toISOString().replace('T', ' ').slice(0, 19),
        symbol: item.instId || 'OKX_FILL',
        side,
        closeType: isProfit
          ? 'OKX_FILL_TAKE_PROFIT'
          : pnl < -0.000001
          ? 'OKX_FILL_STOP_LOSS'
          : 'OKX_EXECUTION',
        pnlUSD: parseFloat(pnl.toFixed(4)),
        feeUSD: parseFloat(fee.toFixed(4)),
        notionalUSD: parseFloat(notionalUSD.toFixed(2)),
        bnrRate,
        pnlRON,
        feeRON,
        isProfit,
        grossGainRON,
        deductibleFeeRON,
        netTaxableGainRON,
        entryPx: px > 0 ? px : undefined,
        exitPx: px > 0 ? px : undefined,
        rawTradeId: tradeId,
      });
    }
  }

  /**
   * FIFO Reconciler: Matches open (Buy) and close (Sell) orders for identical symbols
   * when OKX orders do not have an explicit pnl tag (e.g. grid limit round-trips).
   */
  private reconcileEntryExitPairs(map: Map<string, AnafTransactionRecord>, bnrRate: number): void {
    const list = Array.from(map.values()).sort((a, b) => a.timestamp - b.timestamp);
    const openBuysBySymbol = new Map<string, AnafTransactionRecord[]>();

    for (const tx of list) {
      if (Math.abs(tx.pnlUSD) > 1e-6) continue; // Already has realized PnL

      const sym = tx.symbol;
      if (!openBuysBySymbol.has(sym)) {
        openBuysBySymbol.set(sym, []);
      }
      const buyQueue = openBuysBySymbol.get(sym)!;

      if (tx.side === 'BUY' && (tx.entryPx || tx.exitPx)) {
        buyQueue.push(tx);
      } else if (tx.side === 'SELL' && buyQueue.length > 0 && (tx.exitPx || tx.entryPx)) {
        const matchingBuy = buyQueue.shift()!;
        const entryPx = matchingBuy.entryPx || matchingBuy.exitPx || 0;
        const exitPx = tx.exitPx || tx.entryPx || 0;

        if (entryPx > 0 && exitPx > 0) {
          const ctVal = this.okxAdapter.getCachedCtVal(sym) || 1;
          const sz = matchingBuy.notionalUSD > 0 && entryPx > 0 ? matchingBuy.notionalUSD / entryPx : 1;
          const calculatedPnlUSD = (exitPx - entryPx) * (sz / ctVal);
          const combinedFeeUSD = matchingBuy.feeUSD + tx.feeUSD;

          const pnlRON = parseFloat((calculatedPnlUSD * bnrRate).toFixed(2));
          const feeRON = parseFloat((combinedFeeUSD * bnrRate).toFixed(2));
          const isProfit = calculatedPnlUSD > 0.000001;
          const grossGainRON = isProfit ? pnlRON : 0;
          const deductibleFeeRON = isProfit ? feeRON : 0;
          const netTaxableGainRON = Math.max(0, parseFloat((grossGainRON - deductibleFeeRON).toFixed(2)));

          // Update the sell closing order with matched entry price and realized PnL
          tx.entryPx = entryPx;
          tx.exitPx = exitPx;
          tx.pnlUSD = parseFloat(calculatedPnlUSD.toFixed(4));
          tx.feeUSD = parseFloat(combinedFeeUSD.toFixed(4));
          tx.pnlRON = pnlRON;
          tx.feeRON = feeRON;
          tx.isProfit = isProfit;
          tx.grossGainRON = grossGainRON;
          tx.deductibleFeeRON = deductibleFeeRON;
          tx.netTaxableGainRON = netTaxableGainRON;
          tx.closeType = isProfit ? 'OKX_GRID_FIFO_PROFIT' : 'OKX_GRID_FIFO_LOSS';

          map.set(tx.id, tx);
        }
      }
    }
  }

  /**
   * Core Fiscal Engine: Aggregates all transactions from OKX Live API & Archive,
   * Persistent Cache, Grid Arbitrages, Bot Orders and CSV Imports, then computes Romanian ANAF taxes.
   */
  public async computeTaxReport(options: AnafTaxEngineOptions = {}): Promise<AnafTaxSummary> {
    const fiscalYear = options.fiscalYear || new Date().getFullYear();
    const taxRatePct = Number.isFinite(options.taxRatePct) ? options.taxRatePct! : 10;
    const minWageGrossRON = Number.isFinite(options.minWageGrossRON) ? options.minWageGrossRON! : 4050;

    const rates = await this.fetchBnrRates();
    const bnrRate = options.customUsdRonRate || rates.usdRon;

    const yearStart = new Date(Date.UTC(fiscalYear, 0, 1, 0, 0, 0)).getTime();
    const yearEnd = new Date(Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999)).getTime();

    const transactionsMap = new Map<string, AnafTransactionRecord>();

    // 1. Load persistently saved OKX transactions (preserved across container restarts)
    const persistent = this.getPersistentSyncedTransactions();
    for (const tx of persistent) {
      if (tx.timestamp >= yearStart && tx.timestamp <= yearEnd) {
        transactionsMap.set(tx.id, tx);
      }
    }

    // 2. Perform deep OKX API sync if credentials exist and forced or not synced recently
    const shouldSyncOkx =
      options.forceSyncOkxApi ||
      (this.okxAdapter.hasCredentials() && Date.now() - this.lastOkxSyncStatus.lastSyncedAt > 120_000);

    if (shouldSyncOkx) {
      await this.syncFromOkxApi({
        fiscalYear,
        bnrRate,
        forceFullArchive: options.forceSyncOkxApi,
      });

      // Reload updated persistent cache
      const updatedPersistent = this.getPersistentSyncedTransactions();
      for (const tx of updatedPersistent) {
        if (tx.timestamp >= yearStart && tx.timestamp <= yearEnd) {
          transactionsMap.set(tx.id, tx);
        }
      }
    }

    // 3. Fetch completed Grid Arbitrages from .data/grid_arbitrages.json
    try {
      const arbFile = path.join(this.dataDir, 'grid_arbitrages.json');
      if (fs.existsSync(arbFile)) {
        const arbs = JSON.parse(fs.readFileSync(arbFile, 'utf8'));
        if (Array.isArray(arbs)) {
          for (const a of arbs) {
            const rawTs = parseInt(a.timestamp || '0', 10);
            if (!rawTs || rawTs < yearStart || rawTs > yearEnd) continue;

            const id = `ARB_${a.id || rawTs}`;
            if (transactionsMap.has(id)) continue;

            const grossProfitUSDT = parseFloat(a.grossProfitUSDT || a.profit || '0') || 0;
            const feeUSDT = parseFloat(a.feeUSDT || a.fee || '0') || 0;

            const pnlRON = parseFloat((grossProfitUSDT * bnrRate).toFixed(2));
            const feeRON = parseFloat((feeUSDT * bnrRate).toFixed(2));
            const isProfit = grossProfitUSDT > 0.000001;
            const grossGainRON = isProfit ? pnlRON : 0;
            const deductibleFeeRON = isProfit ? feeRON : 0;
            const netTaxableGainRON = Math.max(0, parseFloat((grossGainRON - deductibleFeeRON).toFixed(2)));

            transactionsMap.set(id, {
              id,
              source: 'GRID_ARBITRAGE',
              timestamp: rawTs,
              dateFormatted: new Date(rawTs).toISOString().replace('T', ' ').slice(0, 19),
              symbol: a.symbol || 'GRID_ARB',
              side: a.closeSide === 'Sell' ? 'SELL' : 'BUY',
              closeType: 'GRID_CYCLE_CLOSE',
              pnlUSD: parseFloat(grossProfitUSDT.toFixed(4)),
              feeUSD: parseFloat(feeUSDT.toFixed(4)),
              notionalUSD: parseFloat((grossProfitUSDT * 5).toFixed(2)),
              bnrRate,
              pnlRON,
              feeRON,
              isProfit,
              grossGainRON,
              deductibleFeeRON,
              netTaxableGainRON,
              entryPx: a.entryPrice ? parseFloat(a.entryPrice) : undefined,
              exitPx: a.exitPrice ? parseFloat(a.exitPrice) : undefined,
            });
          }
        }
      }
    } catch {}

    // 4. Fetch filled orders from .data/orders.json
    try {
      const ordersFile = path.join(this.dataDir, 'orders.json');
      if (fs.existsSync(ordersFile)) {
        const ords = JSON.parse(fs.readFileSync(ordersFile, 'utf8'));
        if (Array.isArray(ords)) {
          for (const o of ords) {
            if (o.status !== 'Filled') continue;
            const rawTs = parseInt(o.updateTime || o.createTime || '0', 10);
            if (!rawTs || rawTs < yearStart || rawTs > yearEnd) continue;

            const id = `ORD_${o.id || rawTs}`;
            if (transactionsMap.has(id)) continue;

            const pnlUSD = parseFloat(o.realizedPnl || o.pnl || '0') || 0;
            const feeUSD = Math.abs(parseFloat(o.feeUSDT || o.fee || '0') || 0);
            if (Math.abs(pnlUSD) < 1e-8 && feeUSD < 1e-8) continue;

            const notionalUSD = parseFloat(o.sizeUSDT || '0') || 0;
            const pnlRON = parseFloat((pnlUSD * bnrRate).toFixed(2));
            const feeRON = parseFloat((feeUSD * bnrRate).toFixed(2));
            const isProfit = pnlUSD > 0.000001;
            const grossGainRON = isProfit ? pnlRON : 0;
            const deductibleFeeRON = isProfit ? feeRON : 0;
            const netTaxableGainRON = Math.max(0, parseFloat((grossGainRON - deductibleFeeRON).toFixed(2)));

            transactionsMap.set(id, {
              id,
              source: 'BOT_ORDER',
              timestamp: rawTs,
              dateFormatted: new Date(rawTs).toISOString().replace('T', ' ').slice(0, 19),
              symbol: o.symbol || 'BOT_ORDER',
              side: o.side === 'Sell' ? 'SELL' : 'BUY',
              closeType: isProfit ? 'BOT_TP' : pnlUSD < 0 ? 'BOT_SL' : 'BOT_FILL',
              pnlUSD: parseFloat(pnlUSD.toFixed(4)),
              feeUSD: parseFloat(feeUSD.toFixed(4)),
              notionalUSD: parseFloat(notionalUSD.toFixed(2)),
              bnrRate,
              pnlRON,
              feeRON,
              isProfit,
              grossGainRON,
              deductibleFeeRON,
              netTaxableGainRON,
              entryPx: o.price ? parseFloat(o.price) : undefined,
              exitPx: o.fillPrice ? parseFloat(o.fillPrice) : undefined,
            });
          }
        }
      }
    } catch {}

    // 5. Load imported CSV transactions
    const imported = this.getImportedTransactions();
    for (const item of imported) {
      if (item.timestamp >= yearStart && item.timestamp <= yearEnd) {
        if (!transactionsMap.has(item.id)) {
          transactionsMap.set(item.id, item);
        }
      }
    }

    const allTransactions = Array.from(transactionsMap.values()).sort(
      (a, b) => b.timestamp - a.timestamp
    );

    // =========================================================================
    // MATHEMATICAL TAX CALCULATION (ROMANIA ANAF)
    // =========================================================================
    let grossRevenueRON = 0;
    let deductibleExpensesRON = 0;
    let totalProfitUSD = 0;
    let totalLossUSD = 0;
    let totalFeesUSD = 0;
    let profitableCount = 0;
    let lossCount = 0;

    for (const tx of allTransactions) {
      totalFeesUSD += tx.feeUSD;
      if (tx.pnlUSD > 0) {
        profitableCount++;
        totalProfitUSD += tx.pnlUSD;
        grossRevenueRON += tx.grossGainRON;
        deductibleExpensesRON += tx.deductibleFeeRON;
      } else if (tx.pnlUSD < 0) {
        lossCount++;
        totalLossUSD += tx.pnlUSD;
      }
    }

    // Romanian Asymmetric Rule (No loss deduction)
    grossRevenueRON = parseFloat(grossRevenueRON.toFixed(2));
    deductibleExpensesRON = parseFloat(deductibleExpensesRON.toFixed(2));
    const netTaxableBaseRON = Math.max(0, parseFloat((grossRevenueRON - deductibleExpensesRON).toFixed(2)));
    const incomeTaxRON = Math.round(netTaxableBaseRON * (taxRatePct / 100));

    // Symmetric / Real Net Portfolio Rule (for comparison & awareness)
    const netRealizedPnLUSD = parseFloat((totalProfitUSD + totalLossUSD).toFixed(4));
    const netRealizedPnLRON = parseFloat((netRealizedPnLUSD * bnrRate).toFixed(2));
    const totalFeesRON = parseFloat((totalFeesUSD * bnrRate).toFixed(2));
    const symmetricTaxableBaseRON = Math.max(0, parseFloat((netRealizedPnLRON - totalFeesRON).toFixed(2)));
    const symmetricTaxRON = Math.round(symmetricTaxableBaseRON * (taxRatePct / 100));
    const asymmetryDifferenceRON = Math.max(0, incomeTaxRON - symmetricTaxRON);

    // CASS (Sănătate) Ceilings (6, 12, 24 salarii minime)
    const thresh6 = minWageGrossRON * 6; // 24.300 RON
    const thresh12 = minWageGrossRON * 12; // 48.600 RON
    const thresh24 = minWageGrossRON * 24; // 97.200 RON

    let ceilingLevel: CassCeilingLevel = 'SUB_6_SALARII';
    let ceilingLabel = 'Sub 6 salarii minime (Fără CASS)';
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
      cassDueRON = Math.round(thresh6 * 0.1); // 2.430 RON
      remainingUntilNextCeilingRON = thresh12 - netTaxableBaseRON;
      progressToNextCeilingPct = parseFloat((((netTaxableBaseRON - thresh6) / (thresh12 - thresh6)) * 100).toFixed(1));
    } else if (netTaxableBaseRON < thresh24) {
      ceilingLevel = 'INTRE_12_SI_24_SALARII';
      ceilingLabel = `Plafon 12–24 salarii (${thresh12.toLocaleString()} – ${thresh24.toLocaleString()} RON)`;
      cassDueRON = Math.round(thresh12 * 0.1); // 4.860 RON
      remainingUntilNextCeilingRON = thresh24 - netTaxableBaseRON;
      progressToNextCeilingPct = parseFloat((((netTaxableBaseRON - thresh12) / (thresh24 - thresh12)) * 100).toFixed(1));
    } else {
      ceilingLevel = 'PESTE_24_SALARII';
      ceilingLabel = `Plafon Maxim peste 24 salarii (≥ ${thresh24.toLocaleString()} RON)`;
      cassDueRON = Math.round(thresh24 * 0.1); // 9.720 RON
      remainingUntilNextCeilingRON = 0;
      progressToNextCeilingPct = 100;
    }

    const totalOwedToStateRON = incomeTaxRON + cassDueRON;
    const filingDeadline = `25 Mai ${fiscalYear + 1}`;

    return {
      fiscalYear,
      taxRatePct,
      minWageGrossRON,
      usdRonRate: bnrRate,
      eurRonRate: rates.eurRon,
      ratesUpdatedAt: rates.usdRon ? Date.now() : 0,
      ratesSource: rates.source,
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
        hasOkxCredentials: this.okxAdapter.hasCredentials(),
      },
      persistentCacheCount: persistent.length,
      transactions: allTransactions,
    };
  }

  /**
   * Generates a fully audit-compliant CSV report for accountant or tax authority
   */
  public generateAuditCsv(summary: AnafTaxSummary): string {
    const esc = (v: any) => {
      const s = String(v ?? '');
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const lines: string[] = [];
    lines.push(`RAPORT FISCAL ANAF — DECLARATIA UNICA ${summary.fiscalYear} (AutoTrade-v5)`);
    lines.push(`Data Generarii: ${new Date().toISOString()}`);
    lines.push(`Curs BNR Referinta USD/RON: ${summary.usdRonRate}`);
    lines.push(`Cota Impozit: ${summary.taxRatePct}%`);
    lines.push(`Salariu Minim Brut Utilizat: ${summary.minWageGrossRON} RON`);
    lines.push(`Total Tranzactii: ${summary.totalTransactionsCount}`);
    lines.push(`Venit Brut RON (Pozitive): ${summary.asymmetric.grossRevenueRON}`);
    lines.push(`Comisioane Deductibile RON: ${summary.asymmetric.deductibleExpensesRON}`);
    lines.push(`Venit Net Baza Impozabila RON: ${summary.asymmetric.netTaxableBaseRON}`);
    lines.push(`Impozit Datorat RON (${summary.taxRatePct}%): ${summary.asymmetric.incomeTaxRON}`);
    lines.push(`CASS Datorat RON: ${summary.cass.cassDueRON}`);
    lines.push(`TOTAL DATORAT BUGET STAT RON: ${summary.totalOwedToStateRON}`);
    lines.push(`Termen Legal Plata: ${summary.filingDeadline}`);
    lines.push('');
    lines.push(
      [
        'ID_Tranzactie',
        'Data_UTC',
        'Sursa',
        'Instrument',
        'Sens',
        'Pret_Intrare',
        'Pret_Iesire',
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
          esc(t.entryPx ?? ''),
          esc(t.exitPx ?? ''),
          esc(t.closeType),
          esc(t.pnlUSD),
          esc(t.feeUSD),
          esc(t.bnrRate),
          esc(t.pnlRON),
          esc(t.deductibleFeeRON),
          esc(t.netTaxableGainRON),
          t.isProfit ? 'DA (Pozitiv)' : 'NU (Pierdere)',
        ].join(',')
      );
    }

    return lines.join('\n');
  }
}
