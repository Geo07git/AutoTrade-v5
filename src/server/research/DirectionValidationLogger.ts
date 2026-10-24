import fs from 'fs';
import path from 'path';
import { OrderFlowMetrics, OrderFlowRegime, ScannedOpportunity } from '../../shared/types';

export interface DirectionValidationRecord {
  id: string;
  symbol: string;
  timestamp: number;
  price: number;
  probabilityUp: number;
  directionalProbability: number;
  direction: 'LONG' | 'SHORT' | 'NEUTRAL';
  regime: OrderFlowRegime;
  confidence: number;
  metrics: OrderFlowMetrics;
  entryQuality: 'OPTIMAL' | 'OVEREXTENDED' | 'EXHAUSTION_WICK' | 'TREND_FATIGUE';
  distFromEmaAtr?: number;
  htfAligned?: boolean;
  isEligible: boolean;
  price_t_plus_5m: number | null;
  price_t_plus_15m: number | null;
  return_5m_pct?: number | null;
  return_15m_pct?: number | null;
}

const DATA_DIR = path.join(process.cwd(), '.data');
const VALIDATION_LOG_PATH = path.join(DATA_DIR, 'direction_validation_log.json');

export class DirectionValidationLogger {
  private records: DirectionValidationRecord[] = [];
  private latestPrices: Map<string, { price: number; ts: number }> = new Map();
  private readonly MAX_RECORDS = 15_000;
  private readonly FIVE_MIN_MS = 5 * 60 * 1000;
  private readonly FIFTEEN_MIN_MS = 15 * 60 * 1000;
  private jobInterval?: NodeJS.Timeout;
  private isJobRunning = false;
  private lastDiskWriteTs = 0;

  constructor() {
    this.loadFromDisk();
    this.startBackgroundResolutionJob();
  }

  private loadFromDisk() {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      if (fs.existsSync(VALIDATION_LOG_PATH)) {
        const raw = fs.readFileSync(VALIDATION_LOG_PATH, 'utf-8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          this.records = parsed.slice(-this.MAX_RECORDS);
        }
      }
    } catch {
      this.records = [];
    }
  }

  private persistToDisk(force: boolean = false) {
    const now = Date.now();
    if (!force && now - this.lastDiskWriteTs < 10_000) return;
    this.lastDiskWriteTs = now;

    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      const tempPath = `${VALIDATION_LOG_PATH}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(this.records), 'utf-8');
      fs.renameSync(tempPath, VALIDATION_LOG_PATH);
    } catch {
      // Best-effort persistence
    }
  }

  public updatePrices(pricesMap: Record<string, number>) {
    const now = Date.now();
    for (const [symbol, price] of Object.entries(pricesMap)) {
      if (typeof price === 'number' && price > 0) {
        this.latestPrices.set(symbol, { price, ts: now });
      }
    }
  }

  /**
   * Logs every symbol in scannedList after directionEngine.evaluate(...) so both
   * DirectionEngine (probabilityUp, metrics) and entryQuality filters can be validated at t+5m and t+15m.
   */
  public logScanBatch(scannedList: ScannedOpportunity[], tickersMap?: Record<string, any>) {
    const now = Date.now();

    if (tickersMap) {
      for (const [sym, t] of Object.entries(tickersMap)) {
        const px = Number(t?.lastPrice || t?.last || 0);
        if (px > 0) {
          this.latestPrices.set(sym, { price: px, ts: now });
        }
      }
    }

    for (const opp of scannedList) {
      if (opp.price > 0) {
        this.latestPrices.set(opp.symbol, { price: opp.price, ts: now });
      }
      const da = opp.directionAssessment;
      if (!da) continue;

      const ts = da.timestamp || now;
      const record: DirectionValidationRecord = {
        id: `${opp.symbol}_${ts}`,
        symbol: opp.symbol,
        timestamp: ts,
        price: opp.price,
        probabilityUp: da.probabilityUp,
        directionalProbability: da.directionalProbability,
        direction: da.direction,
        regime: da.regime,
        confidence: da.confidence,
        metrics: da.metrics,
        entryQuality: opp.entryQuality || 'OPTIMAL',
        distFromEmaAtr: opp.distFromEmaAtr,
        htfAligned: opp.htfAligned,
        isEligible: Boolean(opp.isEligible),
        price_t_plus_5m: null,
        price_t_plus_15m: null,
        return_5m_pct: null,
        return_15m_pct: null,
      };

      this.records.push(record);
    }

    if (this.records.length > this.MAX_RECORDS) {
      this.records = this.records.slice(-this.MAX_RECORDS);
    }

    // Trigger immediate check for any matured t+5m / t+15m records using freshly updated scan prices
    this.resolvePendingPricesSync(now);
    this.persistToDisk(false);
  }

  private resolvePendingPricesSync(now: number): string[] {
    const symbolsNeedingFetch = new Set<string>();

    for (const rec of this.records) {
      const ageMs = now - rec.timestamp;

      if (rec.price_t_plus_5m === null && ageMs >= this.FIVE_MIN_MS) {
        const cached = this.latestPrices.get(rec.symbol);
        if (cached && now - cached.ts <= 45_000 && cached.price > 0) {
          rec.price_t_plus_5m = cached.price;
          rec.return_5m_pct =
            rec.price > 0 ? parseFloat((((cached.price - rec.price) / rec.price) * 100).toFixed(4)) : 0;
        } else if (ageMs <= this.FIVE_MIN_MS + 10 * 60_000) {
          symbolsNeedingFetch.add(rec.symbol);
        }
      }

      if (rec.price_t_plus_15m === null && ageMs >= this.FIFTEEN_MIN_MS) {
        const cached = this.latestPrices.get(rec.symbol);
        if (cached && now - cached.ts <= 45_000 && cached.price > 0) {
          rec.price_t_plus_15m = cached.price;
          rec.return_15m_pct =
            rec.price > 0 ? parseFloat((((cached.price - rec.price) / rec.price) * 100).toFixed(4)) : 0;
        } else if (ageMs <= this.FIFTEEN_MIN_MS + 15 * 60_000) {
          symbolsNeedingFetch.add(rec.symbol);
        }
      }
    }

    return Array.from(symbolsNeedingFetch);
  }

  private async fetchTickerPriceFromOkx(symbol: string): Promise<number | null> {
    const urls = [
      `https://eea.okx.com/api/v5/market/ticker?instId=${encodeURIComponent(symbol)}`,
      `https://www.okx.com/api/v5/market/ticker?instId=${encodeURIComponent(symbol)}`,
    ];
    for (const url of urls) {
      try {
        const res = await fetch(url, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(3500),
        });
        if (res.ok) {
          const json: any = await res.json();
          if (json && json.code === '0' && Array.isArray(json.data) && json.data.length > 0) {
            const px = parseFloat(json.data[0].last || json.data[0].markPx || '0');
            if (px > 0) return px;
          }
        }
      } catch {}
    }
    return null;
  }

  private startBackgroundResolutionJob() {
    if (this.jobInterval) clearInterval(this.jobInterval);
    this.jobInterval = setInterval(async () => {
      if (this.isJobRunning) return;
      this.isJobRunning = true;
      try {
        const now = Date.now();
        const missingSymbols = this.resolvePendingPricesSync(now);

        if (missingSymbols.length > 0) {
          // Fetch up to 10 missing symbols per 15s tick to respect rate limits
          for (const sym of missingSymbols.slice(0, 10)) {
            const px = await this.fetchTickerPriceFromOkx(sym);
            if (px && px > 0) {
              this.latestPrices.set(sym, { price: px, ts: Date.now() });
            }
            await new Promise((r) => setTimeout(r, 80));
          }
          this.resolvePendingPricesSync(Date.now());
        }

        this.persistToDisk(false);
      } catch {
        // Non-blocking background resolution job
      } finally {
        this.isJobRunning = false;
      }
    }, 15_000);
  }

  public getRecords(limit: number = 1000): DirectionValidationRecord[] {
    return this.records.slice(-limit);
  }

  public getSummaryStats() {
    const resolved5m = this.records.filter(
      (r) => r.price_t_plus_5m !== null && r.direction !== 'NEUTRAL' && r.price > 0
    );
    const resolved15m = this.records.filter(
      (r) => r.price_t_plus_15m !== null && r.direction !== 'NEUTRAL' && r.price > 0
    );

    const calcAccuracy = (list: DirectionValidationRecord[], horizon: '5m' | '15m') => {
      if (list.length === 0) return { count: 0, hitRatePct: 0, avgSignedEdgePct: 0 };
      let hits = 0;
      let totalSignedPct = 0;
      for (const r of list) {
        const ret = horizon === '5m' ? r.return_5m_pct || 0 : r.return_15m_pct || 0;
        const signed = r.direction === 'LONG' ? ret : -ret;
        if (signed > 0) hits++;
        totalSignedPct += signed;
      }
      return {
        count: list.length,
        hitRatePct: parseFloat(((hits / list.length) * 100).toFixed(2)),
        avgSignedEdgePct: parseFloat((totalSignedPct / list.length).toFixed(4)),
      };
    };

    return {
      totalLogged: this.records.length,
      horizon5m: calcAccuracy(resolved5m, '5m'),
      horizon15m: calcAccuracy(resolved15m, '15m'),
      byEntryQuality5m: {
        OPTIMAL: calcAccuracy(
          resolved5m.filter((r) => r.entryQuality === 'OPTIMAL'),
          '5m'
        ),
        OVEREXTENDED: calcAccuracy(
          resolved5m.filter((r) => r.entryQuality === 'OVEREXTENDED'),
          '5m'
        ),
        EXHAUSTION_WICK: calcAccuracy(
          resolved5m.filter((r) => r.entryQuality === 'EXHAUSTION_WICK'),
          '5m'
        ),
      },
    };
  }
}

export const directionValidationLogger = new DirectionValidationLogger();
