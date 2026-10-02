import fs from 'fs';
import path from 'path';

export interface ExperimentConfig {
  durationHours: number; // 1 to 12 hours (default 8)
  minMomentumScore: number; // 50 to 100 (default 50)
  maxHoldingTimeMinutes: number; // 15 to 120 minutes (default 120)
  hardStopLossPct: number; // default 20%
  breakEvenActivationPct: number; // default 5%
  trailingActivationPct: number; // default 2.5%
  trailingDistancePct: number; // default 0.5%
  takeProfitPct: number; // default 20%
}

export const DEFAULT_EXPERIMENT_CONFIG: ExperimentConfig = {
  durationHours: 8,
  minMomentumScore: 50,
  maxHoldingTimeMinutes: 120,
  hardStopLossPct: 20.0,
  breakEvenActivationPct: 5.0,
  trailingActivationPct: 2.5,
  trailingDistancePct: 0.5,
  takeProfitPct: 20.0,
};

export interface ExperimentLogEntry {
  id: string;
  timestamp: number;
  dateStr: string;
  eventType: 'EXPERIMENT_STARTED' | 'TRADE_ENTRY' | 'TRADE_EXIT' | 'EXPERIMENT_STOPPED' | 'METRICS_UPDATE';
  symbol: string;
  side: string;
  score: number;
  entryPrice?: number;
  exitPrice?: number;
  sizeUSDT?: number;
  pnl?: number;
  pnlPct?: number;
  holdingTimeMinutes?: number;
  exitReason?: string;
  capital: number;
  details: any;
}

export interface ExperimentState {
  isActive: boolean;
  startTime: number;
  elapsedMs: number;
  remainingMs: number;
  durationMs: number;
  durationHours: number;
  unlimitedCapital: number; // 1,000,000,000 USDT
  minMomentumScore: number;
  maxHoldingTimeMinutes: number;
  hardStopLossPct: number;
  breakEvenActivationPct: number;
  trailingActivationPct: number;
  trailingDistancePct: number;
  takeProfitPct: number;
  profile: 'SCALP';
  totalEntries: number;
  totalExits: number;
  totalPnl: number;
  config: ExperimentConfig;
}

const EXPERIMENT_FILE = path.join(process.cwd(), '.data', 'experiment_log.json');
const EXPERIMENT_STATE_FILE = path.join(process.cwd(), '.data', 'experiment_state.json');
const EXPERIMENT_8H_FILE = path.join(process.cwd(), '.data', 'experiment_8h_log.json');
const EXPERIMENT_8H_STATE_FILE = path.join(process.cwd(), '.data', 'experiment_8h_state.json');

class ExperimentManager {
  private state: ExperimentState = {
    isActive: false,
    startTime: 0,
    elapsedMs: 0,
    remainingMs: 8 * 3600 * 1000,
    durationMs: 8 * 3600 * 1000,
    durationHours: 8,
    unlimitedCapital: 1_000_000_000,
    minMomentumScore: 50,
    maxHoldingTimeMinutes: 120,
    hardStopLossPct: 20.0,
    breakEvenActivationPct: 5.0,
    trailingActivationPct: 2.5,
    trailingDistancePct: 0.5,
    takeProfitPct: 20.0,
    profile: 'SCALP',
    totalEntries: 0,
    totalExits: 0,
    totalPnl: 0,
    config: { ...DEFAULT_EXPERIMENT_CONFIG },
  };

  private logs: ExperimentLogEntry[] = [];

  constructor() {
    this.loadState();
    this.loadLogs();
  }

  private loadState() {
    try {
      const targetPath = fs.existsSync(EXPERIMENT_STATE_FILE)
        ? EXPERIMENT_STATE_FILE
        : (fs.existsSync(EXPERIMENT_8H_STATE_FILE) ? EXPERIMENT_8H_STATE_FILE : null);

      if (targetPath) {
        const raw = fs.readFileSync(targetPath, 'utf-8');
        const saved = JSON.parse(raw);
        if (saved && typeof saved.isActive === 'boolean') {
          this.state = {
            ...this.state,
            ...saved,
            config: { ...DEFAULT_EXPERIMENT_CONFIG, ...(saved.config || {}) },
          };
          if (this.state.isActive) {
            const now = Date.now();
            this.state.elapsedMs = now - this.state.startTime;
            this.state.remainingMs = Math.max(0, this.state.durationMs - this.state.elapsedMs);
            if (this.state.remainingMs <= 0) {
              this.state.isActive = false;
              this.saveState();
            }
          }
        }
      }
    } catch (e) {
      console.warn('[ExperimentManager] Failed to load saved experiment state:', e);
    }
  }

  private writeStateNow() {
    try {
      const dir = path.dirname(EXPERIMENT_STATE_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data = JSON.stringify(this.state, null, 2);
      fs.writeFileSync(EXPERIMENT_STATE_FILE, data, 'utf-8');
      try {
        fs.writeFileSync(EXPERIMENT_8H_STATE_FILE, data, 'utf-8');
      } catch (_) {}
    } catch (e) {
      console.error('[ExperimentManager] Failed to save experiment state:', e);
    }
  }


  // ---- Debounced persistence -------------------------------------------------------------------------------
  // Every trade event used to rewrite ~6 files synchronously (state x2, log x2, named JSON, named CSV), each
  // containing the whole history: O(n^2) blocking I/O on the hot path. At experiment end ~100 closes ran back to
  // back, freezing the event loop that also runs the stop-loss monitor. Writes are now coalesced.
  private stateTimer?: NodeJS.Timeout;
  private logsTimer?: NodeJS.Timeout;

  private saveState() {
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = undefined;
      this.writeStateNow();
    }, 500);
    this.stateTimer.unref?.();
  }

  private saveLogs() {
    if (this.logsTimer) return;
    this.logsTimer = setTimeout(() => {
      this.logsTimer = undefined;
      this.writeLogsNow();
    }, 2000);
    this.logsTimer.unref?.();
  }

  /** Write everything to disk immediately (experiment stop, shutdown, explicit export). */
  public flush() {
    if (this.stateTimer) { clearTimeout(this.stateTimer); this.stateTimer = undefined; }
    if (this.logsTimer) { clearTimeout(this.logsTimer); this.logsTimer = undefined; }
    this.writeStateNow();
    this.writeLogsNow();
  }

  private loadLogs() {
    try {
      const targetPath = fs.existsSync(EXPERIMENT_FILE)
        ? EXPERIMENT_FILE
        : (fs.existsSync(EXPERIMENT_8H_FILE) ? EXPERIMENT_8H_FILE : null);

      if (targetPath) {
        const raw = fs.readFileSync(targetPath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          this.logs = parsed;
        } else if (parsed && Array.isArray(parsed.logs)) {
          this.logs = parsed.logs;
        }
      }
    } catch (e) {
      this.logs = [];
    }
  }

  private writeLogsNow() {
    try {
      const dir = path.dirname(EXPERIMENT_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const payload = {
        config: this.state.config,
        state: {
          isActive: this.state.isActive,
          startTime: this.state.startTime,
          durationHours: this.state.durationHours,
          durationMs: this.state.durationMs,
          unlimitedCapital: this.state.unlimitedCapital,
          totalEntries: this.state.totalEntries,
          totalExits: this.state.totalExits,
          totalPnl: parseFloat(this.state.totalPnl.toFixed(4)),
        },
        logsCount: this.logs.length,
        logs: this.logs,
      };
      const data = JSON.stringify(payload, null, 2);
      fs.writeFileSync(EXPERIMENT_FILE, data, 'utf-8');
      try {
        fs.writeFileSync(EXPERIMENT_8H_FILE, data, 'utf-8');
      } catch (_) {}

      // Automatically persist named files as requested: experiment_xh_YYYY-MM-DD.json & .csv
      try {
        const namedJsonFile = path.join(dir, this.getExportFileName('json'));
        const namedCsvFile = path.join(dir, this.getExportFileName('csv'));
        fs.writeFileSync(namedJsonFile, this.generateJSON(), 'utf-8');
        fs.writeFileSync(namedCsvFile, this.generateCSV(), 'utf-8');
      } catch (errNamed) {
        console.warn('[ExperimentManager] Failed to write named export files:', errNamed);
      }
    } catch (e) {
      console.error('[ExperimentManager] Failed to save experiment logs:', e);
    }
  }

  public startExperiment(customConfig?: Partial<ExperimentConfig>): ExperimentState {
    const durationHours = Math.min(12, Math.max(1, Number(customConfig?.durationHours) || 8));
    const minMomentumScore = Math.min(100, Math.max(50, Number(customConfig?.minMomentumScore) || 50));
    const maxHoldingTimeMinutes = Math.min(120, Math.max(15, Number(customConfig?.maxHoldingTimeMinutes) || 120));
    const hardStopLossPct = Math.max(0.1, Number(customConfig?.hardStopLossPct) || 20.0);
    const breakEvenActivationPct = Math.max(0.1, Number(customConfig?.breakEvenActivationPct) || 5.0);
    const trailingActivationPct = Math.max(0.1, Number(customConfig?.trailingActivationPct) || 2.5);
    const trailingDistancePct = Math.max(0.1, Number(customConfig?.trailingDistancePct) || 0.5);
    const takeProfitPct = Math.max(0.5, Number(customConfig?.takeProfitPct) || 20.0);

    const config: ExperimentConfig = {
      durationHours,
      minMomentumScore,
      maxHoldingTimeMinutes,
      hardStopLossPct,
      breakEvenActivationPct,
      trailingActivationPct,
      trailingDistancePct,
      takeProfitPct,
    };

    const durationMs = durationHours * 3600 * 1000;

    this.state = {
      isActive: true,
      startTime: Date.now(),
      elapsedMs: 0,
      remainingMs: durationMs,
      durationMs,
      durationHours,
      unlimitedCapital: 1_000_000_000,
      minMomentumScore,
      maxHoldingTimeMinutes,
      hardStopLossPct,
      breakEvenActivationPct,
      trailingActivationPct,
      trailingDistancePct,
      takeProfitPct,
      profile: 'SCALP',
      totalEntries: 0,
      totalExits: 0,
      totalPnl: 0,
      config,
    };

    this.logs = []; // Fresh run log
    this.saveState();

    this.logEvent({
      eventType: 'EXPERIMENT_STARTED',
      symbol: 'ALL',
      side: 'NONE',
      score: minMomentumScore,
      capital: this.state.unlimitedCapital,
      details: {
        profile: 'SCALP',
        durationHours,
        minMomentumScore,
        maxHoldingTimeMinutes,
        hardStopLossPct,
        breakEvenActivationPct,
        trailingActivationPct,
        trailingDistancePct,
        takeProfitPct,
        unlimitedCapital: true,
      },
    });
    this.flush();

    return this.getState();
  }

  public stopExperiment(): ExperimentState {
    if (this.state.isActive) {
      this.state.isActive = false;
      this.saveState();
      this.logEvent({
        eventType: 'EXPERIMENT_STOPPED',
        symbol: 'ALL',
        side: 'NONE',
        score: 0,
        capital: this.state.unlimitedCapital + this.state.totalPnl,
        details: {
          totalEntries: this.state.totalEntries,
          totalExits: this.state.totalExits,
          totalPnl: parseFloat(this.state.totalPnl.toFixed(4)),
        },
      });
      this.flush();
    }
    return this.getState();
  }

  public logTradeEntry(
    symbol: string,
    side: string,
    score: number,
    entryPrice: number,
    sizeUSDT: number,
    extra?: Record<string, any>
  ) {
    if (!this.state.isActive) return;
    this.state.totalEntries++;
    this.saveState();
    this.logEvent({
      eventType: 'TRADE_ENTRY',
      symbol,
      side,
      score,
      entryPrice,
      sizeUSDT,
      capital: this.state.unlimitedCapital,
      details: {
        profile: 'SCALP',
        entryTimestamp: Date.now(),
        configuredMaxHoldMin: this.state.maxHoldingTimeMinutes,
        ...(extra || {}),
      },
    });
  }

  public logTradeExit(
    symbol: string,
    side: string,
    score: number,
    entryPrice: number,
    exitPrice: number,
    sizeUSDT: number,
    pnl: number,
    pnlPct: number,
    holdingTimeMinutes: number,
    exitReason: string,
    extra?: Record<string, any>
  ) {
    if (!this.state.isActive) return;
    this.state.totalExits++;
    this.state.totalPnl += pnl;
    this.saveState();
    this.logEvent({
      eventType: 'TRADE_EXIT',
      symbol,
      side,
      score,
      entryPrice,
      exitPrice,
      sizeUSDT,
      pnl: parseFloat(pnl.toFixed(4)),
      pnlPct: parseFloat(pnlPct.toFixed(2)),
      holdingTimeMinutes: parseFloat(holdingTimeMinutes.toFixed(1)),
      exitReason,
      capital: parseFloat((this.state.unlimitedCapital + this.state.totalPnl).toFixed(2)),
      details: { totalPnl: parseFloat(this.state.totalPnl.toFixed(4)), ...(extra || {}) },
    });
  }

  private logEvent(data: Omit<ExperimentLogEntry, 'id' | 'timestamp' | 'dateStr'>) {
    const entry: ExperimentLogEntry = {
      id: 'exp_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
      timestamp: Date.now(),
      dateStr: new Date().toISOString(),
      ...data,
    };
    // No 1000 limit - unlimited logs recorded for backtesting & analysis
    this.logs.unshift(entry);
    this.saveLogs();
  }

  public getState(): ExperimentState {
    if (this.state.isActive) {
      const now = Date.now();
      this.state.elapsedMs = now - this.state.startTime;
      this.state.remainingMs = Math.max(0, this.state.durationMs - this.state.elapsedMs);
    }
    return { ...this.state };
  }

  public getLogFilePath(): string {
    return EXPERIMENT_FILE;
  }

  public getLogs(): ExperimentLogEntry[] {
    return this.logs;
  }

  public getExportFileName(format: 'json' | 'csv'): string {
    const hours = this.state.durationHours || 8;
    const dateStr = new Date(this.state.startTime || Date.now()).toISOString().split('T')[0];
    return `experiment_${hours}h_${dateStr}.${format}`;
  }

  public generateJSON(): string {
    const payload = {
      experimentMetadata: {
        title: `EXPERIMENT ${this.state.durationHours}H: SCALP & MOMENTUM >= ${this.state.minMomentumScore} (FOND NELIMITAT)`,
        startDate: new Date(this.state.startTime || Date.now()).toISOString(),
        durationHours: this.state.durationHours,
        unlimitedCapitalUSDT: this.state.unlimitedCapital,
        totalEntries: this.state.totalEntries,
        totalExits: this.state.totalExits,
        totalRealizedPnlUSDT: parseFloat(this.state.totalPnl.toFixed(4)),
        status: this.state.isActive ? 'RUNNING' : 'STOPPED',
      },
      effectiveConfiguration: {
        ...this.state.config,
        profile: 'SCALP',
        virtualCapitalUSDT: this.state.unlimitedCapital,
        unlimitedPositions: true,
        allSwapPairs: true,
        executionLogic: 'Real-time momentum tick scanner + fast risk evaluator',
        exitLogic: `Hard SL (-${this.state.config.hardStopLossPct}%) | BE (+${this.state.config.breakEvenActivationPct}%) | Trailing Act (+${this.state.config.trailingActivationPct}%) | Trailing Dist (-${this.state.config.trailingDistancePct}%) | TP (+${this.state.config.takeProfitPct}%) | Max Hold (${this.state.config.maxHoldingTimeMinutes}m)`,
        noLogLimit: true,
      },
      totalEventsRecorded: this.logs.length,
      logs: this.logs,
    };
    return JSON.stringify(payload, null, 2);
  }

  public generateCSV(): string {
    const configComment = [
      `# EXPERIMENT ${this.state.durationHours}H (SCALP, MOMENTUM >= ${this.state.minMomentumScore}, FOND NELIMITAT $1B)`,
      `# Start Date: ${new Date(this.state.startTime || Date.now()).toISOString()}`,
      `# Effective Config: Duration=${this.state.durationHours}h | MinMomentum=${this.state.minMomentumScore} | MaxHold=${this.state.maxHoldingTimeMinutes}m | SL=-${this.state.config.hardStopLossPct}% | BE=+${this.state.config.breakEvenActivationPct}% | TrailingAct=+${this.state.config.trailingActivationPct}% | TrailingDist=-${this.state.config.trailingDistancePct}% | TP=+${this.state.config.takeProfitPct}%`,
      `# Total Entries: ${this.state.totalEntries} | Total Exits: ${this.state.totalExits} | Total PnL: $${this.state.totalPnl.toFixed(4)} USDT`,
    ];

    const headers = [
      'Event ID',
      'Timestamp',
      'Date (ISO)',
      'Event Type',
      'Symbol',
      'Side',
      'Score',
      'Entry Price',
      'Exit Price',
      'Size (USDT)',
      'PnL (USDT)',
      'PnL (%)',
      'Holding Time (min)',
      'Exit Reason',
      'Account Capital (USDT)',
      'Details',
    ];

    const escapeCsv = (val: any): string => {
      if (val === null || val === undefined) return '';
      const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    const rows: string[] = [...configComment, headers.join(',')];

    for (const log of this.logs) {
      const row = [
        escapeCsv(log.id),
        escapeCsv(log.timestamp),
        escapeCsv(log.dateStr),
        escapeCsv(log.eventType),
        escapeCsv(log.symbol),
        escapeCsv(log.side),
        escapeCsv(log.score),
        escapeCsv(log.entryPrice ?? ''),
        escapeCsv(log.exitPrice ?? ''),
        escapeCsv(log.sizeUSDT ?? ''),
        escapeCsv(log.pnl ?? ''),
        escapeCsv(log.pnlPct ?? ''),
        escapeCsv(log.holdingTimeMinutes ?? ''),
        escapeCsv(log.exitReason ?? ''),
        escapeCsv(log.capital),
        escapeCsv(log.details ?? ''),
      ];
      rows.push(row.join(','));
    }

    return rows.join('\n');
  }
}

export const experimentManager = new ExperimentManager();
