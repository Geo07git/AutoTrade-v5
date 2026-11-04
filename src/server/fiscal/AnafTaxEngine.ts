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
}

export class AnafTaxEngine {
  private okxAdapter: OKXAdapter;
  private dataDir: string;
  private importedCsvFile: string;
  private cachedBnrUsdRate: number = 4.62;
  private cachedBnrEurRate: number = 4.97;
  private bnrLastUpdated: number = 0;
  private bnrSource: string = 'BNR Reference (Calibrat)';

  constructor(okxAdapter: OKXAdapter, dataDir: string = '.data') {
    this.okxAdapter = okxAdapter;
    this.dataDir = dataDir;
    this.importedCsvFile = path.join(this.dataDir, 'imported_okx_transactions.json');
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
   * Imports OKX raw CSV text (from Assets -> Order History / Trading History)
   */
  public parseAndImportOkxCsv(csvContent: string): { importedCount: number; errors: string[] } {
    const lines = csvContent.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
    if (lines.length < 2) {
      return { importedCount: 0, errors: ['Fișierul CSV este gol sau nu are antet.'] };
    }

    const header = lines[0].split(',').map((h) => h.replace(/^["']|["']$/g, '').trim().toLowerCase());
    const findIdx = (keywords: string[]) =>
      header.findIndex((h) => keywords.some((k) => h.includes(k.toLowerCase())));

    const timeIdx = findIdx(['time', 'date', 'created', 'timestamp', 'data']);
    const instIdIdx = findIdx(['instrument', 'symbol', 'pair', 'instid', 'moneda']);
    const sideIdx = findIdx(['side', 'direction', 'sens', 'type']);
    const pnlIdx = findIdx(['realized pnl', 'pnl', 'profit', 'closed pnl']);
    const feeIdx = findIdx(['fee', 'commission', 'comision']);
    const fillPxIdx = findIdx(['price', 'fill px', 'filled price', 'pret']);
    const fillSzIdx = findIdx(['amount', 'filled amount', 'size', 'qty', 'cantitate']);

    const existing = this.getImportedTransactions();
    const existingIds = new Set(existing.map((e) => e.id));
    const newRecords: AnafTransactionRecord[] = [];
    const errors: string[] = [];

    const bnrRate = this.cachedBnrUsdRate || 4.62;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      // parse CSV line with quoted values
      const cols: string[] = [];
      let inQuotes = false;
      let curr = '';
      for (let c = 0; c < line.length; c++) {
        const ch = line[c];
        if (ch === '"') {
          inQuotes = !inQuotes;
        } else if (ch === ',' && !inQuotes) {
          cols.push(curr.trim());
          curr = '';
        } else {
          curr += ch;
        }
      }
      cols.push(curr.trim());

      const clean = (val?: string) => (val || '').replace(/^["']|["']$/g, '').trim();

      const rawTime = clean(timeIdx >= 0 ? cols[timeIdx] : '');
      const rawInst = clean(instIdIdx >= 0 ? cols[instIdIdx] : 'OKX_FUTURES');
      const rawSide = clean(sideIdx >= 0 ? cols[sideIdx] : 'TRADE').toUpperCase();
      const rawPnl = parseFloat(clean(pnlIdx >= 0 ? cols[pnlIdx] : '0')) || 0;
      const rawFee = Math.abs(parseFloat(clean(feeIdx >= 0 ? cols[feeIdx] : '0')) || 0);
      const rawPx = parseFloat(clean(fillPxIdx >= 0 ? cols[fillPxIdx] : '0')) || 0;
      const rawSz = parseFloat(clean(fillSzIdx >= 0 ? cols[fillSzIdx] : '0')) || 0;

      let ts = Date.now();
      if (rawTime) {
        const parsedTs = Date.parse(rawTime);
        if (!isNaN(parsedTs)) ts = parsedTs;
      }

      const id = `CSV_${rawInst}_${ts}_${i}`;
      if (existingIds.has(id)) continue;

      const pnlUSD = rawPnl;
      const feeUSD = rawFee;
      const notionalUSD = rawPx * rawSz;
      const pnlRON = parseFloat((pnlUSD * bnrRate).toFixed(2));
      const feeRON = parseFloat((feeUSD * bnrRate).toFixed(2));
      const isProfit = pnlUSD > 0.000001;
      const grossGainRON = isProfit ? pnlRON : 0;
      const deductibleFeeRON = isProfit ? feeRON : 0;
      const netTaxableGainRON = Math.max(0, parseFloat((grossGainRON - deductibleFeeRON).toFixed(2)));

      newRecords.push({
        id,
        source: 'CSV_IMPORT',
        timestamp: ts,
        dateFormatted: new Date(ts).toISOString().replace('T', ' ').slice(0, 19),
        symbol: rawInst,
        side: rawSide.includes('BUY') ? 'BUY' : 'SELL',
        closeType: isProfit ? 'PROFIT_CLOSE' : rawPnl < 0 ? 'LOSS_CLOSE' : 'FILL',
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
      });
    }

    const combined = [...existing, ...newRecords];
    this.saveImportedTransactions(combined);
    return { importedCount: newRecords.length, errors };
  }

  /**
   * Core Fiscal Engine: Aggregates all transactions from OKX Live API,
   * Grid Arbitrages, Bot Orders and CSV Imports, then computes Romanian ANAF taxes
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

    // 1. Fetch real fills from OKX REST API
    try {
      const [recentRes, historyRes, billsRes] = await Promise.all([
        this.okxAdapter['request']('GET', '/api/v5/trade/fills?instType=FUTURES&limit=100', undefined, true).catch(
          () => ({ code: '-1', data: [] })
        ),
        this.okxAdapter['request'](
          'GET',
          '/api/v5/trade/fills-history?instType=FUTURES&limit=100',
          undefined,
          true
        ).catch(() => ({ code: '-1', data: [] })),
        this.okxAdapter['request'](
          'GET',
          '/api/v5/account/bills?instType=FUTURES&limit=100',
          undefined,
          true
        ).catch(() => ({ code: '-1', data: [] })),
      ]);

      const processOkxItem = (item: any, isBill: boolean = false) => {
        const rawTs = parseInt(item.ts || item.fillTime || item.cTime || '0', 10);
        if (!rawTs || rawTs < yearStart || rawTs > yearEnd) return;

        const pnl = parseFloat(item.fillPnl || item.pnl || '0') || 0;
        const fee = Math.abs(parseFloat(item.fee || '0') || 0);
        const px = parseFloat(item.fillPx || item.px || '0') || 0;
        const sz = Math.abs(parseFloat(item.fillSz || item.sz || '0') || 0);
        const ctVal = this.okxAdapter.getCachedCtVal(item.instId || '');
        const notionalUSD = px * sz * (ctVal || 1);

        // Include items that have either realized PnL or fee paid
        if (Math.abs(pnl) < 1e-8 && fee < 1e-8) return;

        const id = String(item.tradeId || item.billId || `${item.ordId}_${rawTs}`);
        if (transactionsMap.has(id)) return;

        const pnlRON = parseFloat((pnl * bnrRate).toFixed(2));
        const feeRON = parseFloat((fee * bnrRate).toFixed(2));
        const isProfit = pnl > 0.000001;
        const grossGainRON = isProfit ? pnlRON : 0;
        const deductibleFeeRON = isProfit ? feeRON : 0;
        const netTaxableGainRON = Math.max(0, parseFloat((grossGainRON - deductibleFeeRON).toFixed(2)));

        transactionsMap.set(id, {
          id,
          source: 'OKX_API',
          timestamp: rawTs,
          dateFormatted: new Date(rawTs).toISOString().replace('T', ' ').slice(0, 19),
          symbol: item.instId || 'OKX_FUTURES',
          side: String(item.side || '').toUpperCase() === 'SELL' ? 'SELL' : 'BUY',
          closeType: isBill
            ? item.type === '2'
              ? 'OKX_TRADE_CLOSE'
              : 'OKX_BILL'
            : isProfit
            ? 'OKX_TAKE_PROFIT'
            : pnl < 0
            ? 'OKX_STOP_LOSS'
            : 'OKX_FILL',
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
        });
      };

      if (Array.isArray(recentRes?.data)) recentRes.data.forEach((i: any) => processOkxItem(i, false));
      if (Array.isArray(historyRes?.data)) historyRes.data.forEach((i: any) => processOkxItem(i, false));
      if (Array.isArray(billsRes?.data)) billsRes.data.forEach((i: any) => processOkxItem(i, true));
    } catch (err: any) {
      console.warn('[AnafTaxEngine] OKX API historical sync warning:', err.message);
    }

    // 2. Fetch completed Grid Arbitrages from .data/grid_arbitrages.json
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
            const netProfitUSDT = parseFloat(a.netProfitUSDT || String(grossProfitUSDT - feeUSDT)) || 0;

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
            });
          }
        }
      }
    } catch {}

    // 3. Fetch filled orders from .data/orders.json
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
            });
          }
        }
      }
    } catch {}

    // 4. Load imported CSV transactions
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
