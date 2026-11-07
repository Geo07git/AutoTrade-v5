/**
 * DeepSeekAgent — autonomous decision layer for the TB5 Neutral Grid desk.
 *
 * Pipeline per cycle:
 *   1. Refresh the OKX X-Perp opportunity scan (optional).
 *   2. Build a compact, token-bounded market/account context.
 *   3. Ask DeepSeek for ONE strict-JSON decision (OPEN_GRID / STOP_BOT / AMEND_BOT / HOLD).
 *   4. Sanitise every proposed action against hard account + risk limits (never trust the model).
 *   5. Merge deterministic guardrail stops (hard SL / liquidation proximity / range breakout).
 *   6. Execute only in AUTONOMOUS mode, then journal and optionally notify Telegram.
 *
 * Safety rules baked into this module (non-negotiable):
 *   - Never switches execution mode. Native grid opens require the account to ALREADY be LIVE.
 *   - Never touches the kill switch, credentials, leverage of the whole account or the Autopilot.
 *   - Refuses OPEN_GRID while the native OKX Autopilot is enabled (single trading authority).
 *   - Every model action is clamped/rejected by validateAction() before execution.
 */

import {
  AuditLogType,
  DeepSeekAgentAction,
  DeepSeekAgentConfig,
  DeepSeekAgentDecision,
  DeepSeekAgentEngine,
  DeepSeekAgentMode,
  DeepSeekAgentStatus,
  DeepSeekActionResult,
  DeepSeekRejectedAction,
  NativeGridOpportunity,
  OKXNativeGridBot,
} from '../../shared/types';
import { JsonStore } from '../store';
import {
  DeepSeekChatMessage,
  DeepSeekClient,
  DEEPSEEK_CHAT_MODEL,
  DEEPSEEK_DEFAULT_BASE_URL,
  extractJsonObject,
  maskApiKey,
} from './DeepSeekClient';

// =============================================================================
// DEPENDENCY CONTRACT (implemented by TradeBot — keeps this module cycle-free)
// =============================================================================

export interface DeepSeekAccountSnapshot {
  executionMode: 'PAPER' | 'LIVE';
  killSwitchEngaged: boolean;
  equity: number;
  freeBalance: number;
  marginInvested: number;
  sessionPnl: number;
  makerFeePct: number;
  takerFeePct: number;
}

export interface DeepSeekAgentDeps {
  getAccountSnapshot(): DeepSeekAccountSnapshot;
  hasOKXCredentials(): boolean;
  getNativeGridAutopilotConfig(): { enabled: boolean; lastDecision?: string };
  getNativeGridBots(): OKXNativeGridBot[];
  getNativeGridOpportunities(): NativeGridOpportunity[];
  scanNativeGridOpportunities(): Promise<NativeGridOpportunity[]>;
  createNativeGridBot(params: any): Promise<{ success: boolean; bot?: any; error?: string }>;
  stopNativeGridBot(
    algoId: string,
    stopType?: '1' | '2',
    reason?: string
  ): Promise<{ success: boolean; error?: string }>;
  amendNativeGridBot(
    algoId: string,
    params: any
  ): Promise<{ success: boolean; error?: string }>;
  logAudit(type: AuditLogType, message: string, details?: any): void;
  notifyTelegram?(text: string): Promise<any>;
}

// =============================================================================
// DEFAULTS
// =============================================================================

export const DEFAULT_DEEPSEEK_AGENT_CONFIG: DeepSeekAgentConfig = {
  // OFF by default: nothing runs autonomously until the owner explicitly opts in.
  mode: 'OFF',
  model: DEEPSEEK_CHAT_MODEL,
  baseUrl: DEEPSEEK_DEFAULT_BASE_URL,
  temperature: 0.25,
  maxTokens: 1600,
  runIntervalSec: 300,
  maxActionsPerCycle: 2,
  maxConcurrentBots: 2,
  budgetPerBotUSDT: 20,
  minReserveUSDT: 10,
  maxLeverage: 5,
  minSuitabilityScore: 70,
  minNetProfitPerGridPct: 0.05,
  cooldownMinutesPerSymbol: 30,
  allowedSymbols: [],
  blockedSymbols: [],
  allowOpenBots: true,
  allowStopBots: true,
  allowAmendBots: true,
  scanBeforeDecision: true,
  notifyTelegram: true,
  dailyLossLimitUSDT: 25,
  maxOpportunitiesInPrompt: 12,
  fallbackEnabled: true,
  enforceHardGuardrails: true,
  hardStopLossPct: 12,
  hardMinLiqDistancePct: 12,
  hardMaxNoFillMinutes: 180,
  preferNativeAlgo: true,
  stopIfPassive: true,
  totalCycles: 0,
  totalActionsExecuted: 0,
  totalErrors: 0,
  consecutiveErrors: 0,
  symbolCooldowns: {},
};

const MAX_DECISION_HISTORY = 100;
const MAX_SYMBOL_COOLDOWNS = 200;

// =============================================================================
// PROMPTS
// =============================================================================

const SYSTEM_PROMPT = `You are "DeepSeek Grid Agent", the autonomous decision engine of TB5 (TradeBot v5).

DESK
- Strategy: NEUTRAL GRID (market-neutral contract grid, direction=neutral) on OKX EEA perpetual FUTURES.
- Instrument universe: ONLY OKX X-Perp contracts whose id contains "_UM_XPERP".
- Profit source: buy low / sell high round-trips inside a price range. It requires sideways, choppy price action.
- Costs per grid include the OKX maker fee round-trip, funding and spread. A grid whose net profit per grid is below the configured minimum is NOT worth opening.

YOUR JOB, per cycle
1. Read the account + limits + running bots + candidates JSON.
2. Decide AT MOST max_actions actions.
3. Prefer doing nothing over a mediocre trade. HOLD is a valid, professional answer.

HARD RULES (violating any of them gets your action rejected by the execution guard)
- Only reference instIds that appear in "candidates". Never invent symbols.
- Never OPEN_GRID on a candidate with eligible=false.
- sz must be <= budget_per_bot_usdt and >= the candidate min_inv_usdt; lever <= max_leverage.
- running_bots + new opens must stay <= max_concurrent_bots, and free_usdt minus the new margin must stay >= min_reserve_usdt.
- The current price MUST lie strictly inside [minPx, maxPx], and the range must stay within +/-25% of the current price.
- Prefer IDEAL_RANGE / HIGH_VOL_RANGE with chop >= 55, adx <= 25, order-book imbalance within +/-0.35, spread <= 6bps, net_per_grid_pct > 0 and positive daily_yield_pct.
- Optimise, do not copy: rank candidates by suitabilityScore x daily_yield_pct, then adjust gridNum so that net_per_grid_pct stays above the minimum while the range still covers the recent 24h range. Reject a range whose lower bound sits on the 24h low (or upper bound on the 24h high): one breakout fills every level at once.
- Avoid TRENDING_RISK and LOW_VOLATILITY regimes, and avoid symbols with high absolute funding when a better candidate exists.
- STOP_BOT only on clear deterioration: price outside the range, net PnL <= -6% of margin, distance to liquidation < 15%, regime flip to TRENDING_RISK, or zero arbitrages with negative float after 90+ minutes.
- A bot with zero arbitrages after the passive threshold is DEAD CAPITAL: stop it even when the PnL is slightly positive. An idle grid must not hold a slot.
- AMEND_BOT only to tighten risk (raise SL, lower TP) or to widen TP when the range is clearly holding; never widen SL beyond hard_stop_loss_pct.
- Never propose: changing execution mode, toggling the kill switch, changing account leverage, creating/modifying/deleting any bot that is not in running_bots, or anything about API keys, balances transfers, or deposits.
- Never output markdown, prose or code fences. Output ONE JSON object and nothing else.

OUTPUT JSON SCHEMA
{
  "market_regime": "string (max 12 words): the regime that drives your decision",
  "summary_ro": "string: 1-3 sentences in ROMANIAN explaining the decision to the operator",
  "confidence": 0.0,
  "actions": [
    { "type": "OPEN_GRID", "instId": "SOL-USD_UM_XPERP-310523", "minPx": 0, "maxPx": 0, "gridNum": 6, "runType": "1", "lever": 3, "sz": 20, "stopLossPct": 8, "takeProfitPct": 15, "rangeVariant": "BALANCED", "rationale_ro": "..." },
    { "type": "STOP_BOT", "algoId": "1234567890", "stopType": "1", "rationale_ro": "..." },
    { "type": "AMEND_BOT", "algoId": "1234567890", "slTriggerPx": 0, "tpTriggerPx": 0, "rationale_ro": "..." },
    { "type": "HOLD", "rationale_ro": "..." }
  ]
}

runType: "1" = arithmetic, "2" = geometric. stopType: "1" = close position at market, "2" = keep position open.
If there is nothing worth doing, return exactly one HOLD action.`;

function buildUserPrompt(context: any): string {
  return [
    'Context for the current cycle (JSON). Analyse it and answer with the single JSON decision object.',
    '',
    JSON.stringify(context),
  ].join('\n');
}

// =============================================================================
// HELPERS
// =============================================================================

function rnd(value: any, decimals: number = 2): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const f = Math.pow(10, decimals);
  return Math.round(n * f) / f;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function pctDistance(from: number, to: number): number | null {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0 || to <= 0) return null;
  return Math.abs(from - to) / from * 100;
}

function makeId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

interface BuiltContext {
  promptContext: any;
  candidates: NativeGridOpportunity[];
  runningBots: OKXNativeGridBot[];
  snapshot: DeepSeekAccountSnapshot;
  freeSlots: number;
  authorityConflict: boolean;
  authorityConflictReason?: string;
}

// =============================================================================
// AGENT
// =============================================================================

export interface DeepSeekAgentStoreOptions {
  /** Override store filenames (used by the regression suite so tests never touch live state). */
  configFile?: string;
  credentialsFile?: string;
  decisionsFile?: string;
}

export class DeepSeekAgent {
  private deps: DeepSeekAgentDeps;
  private configStore: JsonStore<DeepSeekAgentConfig>;
  private credentialStore: JsonStore<{ apiKey: string }>;
  private decisionStore: JsonStore<DeepSeekAgentDecision[]>;

  private loopTimer?: NodeJS.Timeout;
  private loopActive: boolean = false;
  private nextRunAt?: number;
  private inFlightCycle: Promise<DeepSeekAgentDecision> | null = null;

  constructor(deps: DeepSeekAgentDeps, options?: DeepSeekAgentStoreOptions) {
    this.deps = deps;
    this.configStore = new JsonStore<DeepSeekAgentConfig>(
      options?.configFile || 'deepseek_agent_config.json',
      DEFAULT_DEEPSEEK_AGENT_CONFIG
    );
    this.credentialStore = new JsonStore<{ apiKey: string }>(
      options?.credentialsFile || 'deepseek_credentials.json',
      { apiKey: process.env.DEEPSEEK_API_KEY || '' }
    );
    this.decisionStore = new JsonStore<DeepSeekAgentDecision[]>(
      options?.decisionsFile || 'deepseek_agent_decisions.json',
      []
    );
  }

  // ---------------------------------------------------------------- config ---

  public getConfig(): DeepSeekAgentConfig {
    const stored = this.configStore.get() || ({} as Partial<DeepSeekAgentConfig>);
    const merged: DeepSeekAgentConfig = {
      ...DEFAULT_DEEPSEEK_AGENT_CONFIG,
      ...stored,
      mode: (stored.mode === 'ADVISOR' || stored.mode === 'AUTONOMOUS' ? stored.mode : 'OFF') as DeepSeekAgentMode,
      symbolCooldowns: stored.symbolCooldowns || {},
      // Boolean switches default to ON: an absent key must never disable a safety net.
      preferNativeAlgo: stored.preferNativeAlgo !== false,
      stopIfPassive: stored.stopIfPassive !== false,
    };
    return merged;
  }

  public updateConfig(updates: Partial<DeepSeekAgentConfig>): DeepSeekAgentConfig {
    const current = this.getConfig();
    const next: DeepSeekAgentConfig = { ...current, ...updates };

    if (next.mode !== 'ADVISOR' && next.mode !== 'AUTONOMOUS') next.mode = 'OFF';
    next.model = String(next.model || DEEPSEEK_CHAT_MODEL).trim() || DEEPSEEK_CHAT_MODEL;
    next.baseUrl = String(next.baseUrl || DEEPSEEK_DEFAULT_BASE_URL).trim() || DEEPSEEK_DEFAULT_BASE_URL;
    next.temperature = clamp(Number(next.temperature), 0, 1.5);
    next.maxTokens = clamp(Math.round(Number(next.maxTokens) || 1600), 400, 8000);
    next.runIntervalSec = clamp(Math.round(Number(next.runIntervalSec) || 300), 60, 3600);
    next.maxActionsPerCycle = clamp(Math.round(Number(next.maxActionsPerCycle) || 2), 1, 5);
    next.maxConcurrentBots = clamp(Math.round(Number(next.maxConcurrentBots) || 2), 1, 10);
    next.budgetPerBotUSDT = clamp(Number(next.budgetPerBotUSDT) || 20, 5, 1000);
    next.minReserveUSDT = clamp(
      Number.isFinite(Number(next.minReserveUSDT)) ? Number(next.minReserveUSDT) : 10,
      0,
      10_000
    );
    next.maxLeverage = clamp(Math.round(Number(next.maxLeverage) || 5), 1, 20);
    next.minSuitabilityScore = clamp(Math.round(Number(next.minSuitabilityScore) || 70), 30, 98);
    next.minNetProfitPerGridPct = clamp(Number(next.minNetProfitPerGridPct) || 0.05, 0.01, 5);
    next.cooldownMinutesPerSymbol = clamp(
      Math.round(
        Number.isFinite(Number(next.cooldownMinutesPerSymbol))
          ? Number(next.cooldownMinutesPerSymbol)
          : 30
      ),
      0,
      1440
    );
    next.dailyLossLimitUSDT = clamp(Number(next.dailyLossLimitUSDT) || 0, 0, 100_000);
    next.maxOpportunitiesInPrompt = clamp(Math.round(Number(next.maxOpportunitiesInPrompt) || 12), 3, 30);
    next.hardStopLossPct = clamp(Number(next.hardStopLossPct) || 12, 2, 60);
    next.hardMinLiqDistancePct = clamp(Number(next.hardMinLiqDistancePct) || 12, 3, 60);
    next.hardMaxNoFillMinutes = clamp(Math.round(Number(next.hardMaxNoFillMinutes) || 180), 15, 1440);
    next.preferNativeAlgo = next.preferNativeAlgo !== false;
    next.stopIfPassive = next.stopIfPassive !== false;
    next.allowedSymbols = Array.isArray(next.allowedSymbols)
      ? next.allowedSymbols.map((s) => String(s).trim()).filter(Boolean)
      : [];
    next.blockedSymbols = Array.isArray(next.blockedSymbols)
      ? next.blockedSymbols.map((s) => String(s).trim()).filter(Boolean)
      : [];

    this.configStore.save(next);
    this.configStore.flushSync();

    // Restart the loop when the cadence changed or the agent was toggled.
    if (this.loopActive && next.mode !== 'OFF') {
      this.startLoop();
    }

    const enabledLabel =
      next.mode === 'AUTONOMOUS' ? 'AUTONOM' : next.mode === 'ADVISOR' ? 'CONSULTANT' : 'OPRIT';
    this.deps.logAudit(
      'CONFIG_UPDATED',
      `[DEEPSEEK AGENT] Configurație actualizată: mod ${enabledLabel} | Model ${next.model} | Interval ${next.runIntervalSec}s | Buget/bot $${next.budgetPerBotUSDT} | Max ${next.maxConcurrentBots} boți | Levier max ${next.maxLeverage}x | Rezervă min $${next.minReserveUSDT}.`,
      { mode: next.mode, interval: next.runIntervalSec, budget: next.budgetPerBotUSDT }
    );

    if (next.mode === 'OFF' && this.loopActive) {
      this.stopLoop();
    } else if (next.mode !== 'OFF' && !this.loopActive) {
      this.startLoop();
    }

    return next;
  }

  // ------------------------------------------------------------ credentials ---

  public getApiKey(): string {
    const stored = (this.credentialStore.get()?.apiKey || '').trim();
    return stored || (process.env.DEEPSEEK_API_KEY || '').trim();
  }

  public setApiKey(apiKey: string): { success: boolean; apiKeyMasked: string; message: string } {
    const clean = (apiKey || '').trim();
    this.credentialStore.save({ apiKey: clean });
    this.credentialStore.flushSync();
    this.deps.logAudit(
      'CONFIG_UPDATED',
      clean
        ? `[DEEPSEEK AGENT] Cheie API DeepSeek salvată persistent (${maskApiKey(clean)}).`
        : '[DEEPSEEK AGENT] Cheia API DeepSeek a fost ștearsă. Agentul va folosi fallback-ul local determinist.'
    );
    return {
      success: true,
      apiKeyMasked: maskApiKey(clean),
      message: clean
        ? 'Cheia API DeepSeek a fost salvată.'
        : 'Cheia API DeepSeek a fost ștearsă.',
    };
  }

  public isConfigured(): boolean {
    return Boolean(this.getApiKey());
  }

  private buildClient(cfg: DeepSeekAgentConfig): DeepSeekClient {
    return new DeepSeekClient({
      apiKey: this.getApiKey(),
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      temperature: cfg.temperature,
      maxTokens: cfg.maxTokens,
      // deepseek-reasoner can spend minutes on a long chain of thought.
      timeoutMs: /reasoner/i.test(cfg.model) ? 180_000 : 75_000,
      maxRetries: 2,
    });
  }

  // ------------------------------------------------------------------ loop ---

  public startLoop(): void {
    const cfg = this.getConfig();
    if (cfg.mode === 'OFF') {
      this.deps.logAudit(
        'AGENT_DECISION',
        '[DEEPSEEK AGENT] Mod OFF — bucla autonomă nu pornește. Setează modul ADVISOR sau AUTONOMOUS.'
      );
      return;
    }
    this.stopLoop();
    this.loopActive = true;
    const intervalMs = Math.max(60, cfg.runIntervalSec) * 1000;
    this.nextRunAt = Date.now() + intervalMs;
    this.loopTimer = setInterval(() => {
      this.nextRunAt = Date.now() + intervalMs;
      this.runCycle('SCHEDULE').catch((err) =>
        console.warn('[DeepSeekAgent] Ciclu eșuat:', err?.message || err)
      );
    }, intervalMs);
    this.loopTimer.unref?.();
    this.deps.logAudit(
      'AGENT_DECISION',
      `[DEEPSEEK AGENT] Buclă autonomă ACTIVĂ (mod ${cfg.mode}, la fiecare ${cfg.runIntervalSec}s). Motor: ${
        this.isConfigured() ? cfg.model : 'fallback local (fără cheie API)'
      }.`
    );
  }

  public stopLoop(): void {
    if (this.loopTimer) clearInterval(this.loopTimer);
    this.loopTimer = undefined;
    this.loopActive = false;
    this.nextRunAt = undefined;
  }

  /** Emergency stop requested by the operator: forces OFF, keeps history intact. */
  public panic(reason: string): DeepSeekAgentConfig {
    this.stopLoop();
    const next = this.getConfig();
    next.mode = 'OFF';
    this.configStore.save(next);
    this.configStore.flushSync();
    this.deps.logAudit(
      'AGENT_GUARDRAIL',
      `[DEEPSEEK AGENT] PANIC STOP — agentul a fost oprit (${reason}). Nicio acțiune autonomă nu mai este executată.`
    );
    return next;
  }

  // --------------------------------------------------------------- status ----

  public getDecisions(limit: number = 20): DeepSeekAgentDecision[] {
    const all = this.decisionStore.get();
    if (!Array.isArray(all)) return [];
    return all.slice(0, clamp(Math.round(limit) || 20, 1, MAX_DECISION_HISTORY));
  }

  public getStatus(): DeepSeekAgentStatus {
    const cfg = this.getConfig();
    const decisions = this.getDecisions(5);
    const snapshot = this.deps.getAccountSnapshot();
    const running = this.deps.getNativeGridBots().filter((b) => b.state === 'running');
    const nativeAp = this.deps.getNativeGridAutopilotConfig();
    const conflict = Boolean(nativeAp.enabled) && cfg.mode === 'AUTONOMOUS';

    return {
      mode: cfg.mode,
      engine: this.isConfigured() ? 'DEEPSEEK' : 'LOCAL_FALLBACK',
      isConfigured: this.isConfigured(),
      apiKeyMasked: maskApiKey(this.getApiKey()),
      model: cfg.model,
      loopActive: this.loopActive,
      nextRunAt: this.nextRunAt,
      authorityConflict: conflict,
      authorityConflictReason: conflict
        ? 'Autopilotul OKX Native este activ — agentul nu va deschide boți noi până nu este oprit (o singură autoritate de execuție).'
        : undefined,
      accountSnapshot: {
        executionMode: snapshot.executionMode,
        killSwitchEngaged: snapshot.killSwitchEngaged,
        equityUSDT: snapshot.equity,
        freeBalanceUSDT: snapshot.freeBalance,
        marginInvestedUSDT: snapshot.marginInvested,
        sessionPnlUSDT: snapshot.sessionPnl,
        runningBots: running.length,
        freeSlots: Math.max(0, cfg.maxConcurrentBots - running.length),
      },
      lastDecision: decisions[0],
      decisions,
      config: cfg,
    };
  }

  /** Compact view injected into /api/bot/status (no decision payload bloat). */
  public getStatusSummary(): Omit<DeepSeekAgentStatus, 'decisions'> {
    const { decisions, ...rest } = this.getStatus();
    return { ...rest, lastDecision: decisions[0] };
  }

  // --------------------------------------------------------------- context ---

  private buildContext(cfg: DeepSeekAgentConfig): BuiltContext {
    const snapshot = this.deps.getAccountSnapshot();
    const allOpportunities = this.deps.getNativeGridOpportunities() || [];
    const runningBots = (this.deps.getNativeGridBots() || []).filter(
      (b) => b.state === 'running' || b.state === 'pending_signal'
    );
    const nativeAp = this.deps.getNativeGridAutopilotConfig();

    const blocked = new Set(cfg.blockedSymbols.map((s) => s.toUpperCase()));
    const allowed = new Set(cfg.allowedSymbols.map((s) => s.toUpperCase()));
    const isSymbolAllowed = (instId: string) => {
      const upper = instId.toUpperCase();
      const base = upper.split('-')[0];
      if (blocked.has(upper) || blocked.has(base)) return false;
      if (allowed.size > 0 && !allowed.has(upper) && !allowed.has(base)) return false;
      return true;
    };

    // Eligible + budget-fitting first; still include a few ineligible ones as negative examples.
    const sorted = [...allOpportunities].sort((a, b) => {
      if (a.isEligible !== b.isEligible) return a.isEligible ? -1 : 1;
      return (b.suitabilityScore || 0) - (a.suitabilityScore || 0);
    });
    const shortlist = sorted
      .filter((o) => isSymbolAllowed(o.instId))
      .slice(0, cfg.maxOpportunitiesInPrompt);

    const candidates = shortlist.map((o) => ({
      instId: o.instId,
      base: o.instId.split('-')[0],
      price: rnd(o.price, 6),
      score: o.suitabilityScore,
      regime: o.regimeLabel,
      atr_pct: rnd(o.atrPct, 2),
      chop: rnd(o.choppinessIndex, 1),
      adx: rnd(o.adxTrendStrength, 1),
      spread_bps: rnd(o.spreadBps, 2),
      oi_musd: rnd((o.openInterestUSD || 0) / 1e6, 2),
      funding_pct: rnd(o.fundingRatePct, 4),
      ob_imbalance: rnd(o.orderBookImbalance, 2),
      variant: o.selectedVariant || 'BALANCED',
      range: { minPx: rnd(o.minPx, 6), maxPx: rnd(o.maxPx, 6), gridNum: o.gridNum, spacing_pct: rnd(o.gridSpacingPct, 3) },
      lever: o.lever,
      min_inv_usdt: rnd(o.minInvestmentUSDT, 2),
      net_per_grid_pct: rnd(o.estimatedNetProfitPerGridPct, 3),
      daily_yield_pct: rnd(o.estimatedDailyNetYieldPct, 3),
      eligible: o.isEligible,
      reason_if_not: o.isEligible ? undefined : o.rejectionReason,
      already_running: runningBots.some((b) => b.instId === o.instId),
    }));

    const bots = runningBots.map((b) => {
      const pnlPct = b.sz > 0 ? (b.totalPnl / b.sz) * 100 : 0;
      return {
        algoId: b.algoId,
        instId: b.instId,
        range: { minPx: rnd(b.minPx, 6), maxPx: rnd(b.maxPx, 6), gridNum: b.gridNum, runType: b.runType },
        lever: b.lever,
        sz_usdt: rnd(b.sz, 2),
        currentPx: rnd(b.currentPx, 6),
        total_pnl_usdt: rnd(b.totalPnl, 4),
        total_pnl_pct: rnd(pnlPct, 2),
        grid_profit_usdt: rnd(b.gridProfit, 4),
        float_profit_usdt: rnd(b.floatProfit, 4),
        arbitrages: b.arbitrageNum,
        dist_to_lower_pct: rnd(pctDistance(b.currentPx, b.minPx) ?? 0, 2),
        dist_to_upper_pct: rnd(pctDistance(b.currentPx, b.maxPx) ?? 0, 2),
        liqPx: rnd(b.liqPx, 6),
        dist_to_liq_pct: b.liqPx > 0 ? rnd(pctDistance(b.currentPx, b.liqPx) ?? 0, 2) : null,
        age_min: Math.max(0, Math.round((Date.now() - (b.cTime || Date.now())) / 60000)),
        sl_pct: b.stopLossPct,
        tp_pct: b.takeProfitPct,
      };
    });

    const freeSlots = Math.max(0, cfg.maxConcurrentBots - runningBots.length);
    const authorityConflict = Boolean(nativeAp.enabled);

    const promptContext = {
      now_utc: new Date().toISOString(),
      desk: 'NEUTRAL_GRID_FUTURES_OKX_EEA',
      account: {
        execution_mode: snapshot.executionMode,
        kill_switch_engaged: snapshot.killSwitchEngaged,
        equity_usdt: rnd(snapshot.equity, 2),
        free_usdt: rnd(snapshot.freeBalance, 2),
        margin_used_usdt: rnd(snapshot.marginInvested, 2),
        session_pnl_usdt: rnd(snapshot.sessionPnl, 2),
        maker_fee_pct: rnd(snapshot.makerFeePct, 4),
        taker_fee_pct: rnd(snapshot.takerFeePct, 4),
      },
      limits: {
        max_actions: cfg.maxActionsPerCycle,
        max_concurrent_bots: cfg.maxConcurrentBots,
        running_bots: runningBots.length,
        free_slots: freeSlots,
        budget_per_bot_usdt: cfg.budgetPerBotUSDT,
        min_reserve_usdt: cfg.minReserveUSDT,
        max_leverage: cfg.maxLeverage,
        min_suitability_score: cfg.minSuitabilityScore,
        min_net_profit_per_grid_pct: cfg.minNetProfitPerGridPct,
        daily_loss_limit_usdt: cfg.dailyLossLimitUSDT,
        hard_stop_loss_pct: cfg.hardStopLossPct,
        hard_min_liq_distance_pct: cfg.hardMinLiqDistancePct,
        allow_open: cfg.allowOpenBots && snapshot.executionMode === 'LIVE' && !authorityConflict,
        blocked_symbols: cfg.blockedSymbols,
      },
      running_bots: bots,
      candidates,
    };

    return {
      promptContext,
      candidates: shortlist,
      runningBots,
      snapshot,
      freeSlots,
      authorityConflict,
      authorityConflictReason: authorityConflict
        ? `Autopilotul nativ OKX este activ (${nativeAp.lastDecision || 'fără decizie'}) — OPEN_GRID blocat.`
        : undefined,
    };
  }

  // ----------------------------------------------------------- cycle entry ---

  public async runCycle(
    trigger: 'SCHEDULE' | 'MANUAL' | 'EVENT' = 'MANUAL'
  ): Promise<DeepSeekAgentDecision> {
    // Single-flight: a scheduled tick never overlaps a manual run.
    if (this.inFlightCycle) return this.inFlightCycle;
    const promise = this.doRunCycle(trigger).finally(() => {
      this.inFlightCycle = null;
    });
    this.inFlightCycle = promise;
    return promise;
  }

  private async doRunCycle(
    trigger: 'SCHEDULE' | 'MANUAL' | 'EVENT'
  ): Promise<DeepSeekAgentDecision> {
    const cfg = this.getConfig();
    const startedAt = Date.now();
    const dryRun = cfg.mode !== 'AUTONOMOUS';

    // 1. Fresh opportunities (the agent must never decide on a stale scan).
    if (cfg.scanBeforeDecision) {
      try {
        await this.deps.scanNativeGridOpportunities();
      } catch (err: any) {
        this.deps.logAudit(
          'AGENT_ERROR',
          `[DEEPSEEK AGENT] Scanarea oportunităților a eșuat: ${err?.message || err}. Se continuă cu ultimul set disponibil.`
        );
      }
    }

    // 2. Context
    let ctx: BuiltContext;
    try {
      ctx = this.buildContext(cfg);
    } catch (err: any) {
      return this.finishWithError(cfg, trigger, dryRun, `Construcția contextului a eșuat: ${err?.message || err}`, startedAt);
    }

    // 3. Decide (DeepSeek, or deterministic fallback)
    let engine: DeepSeekAgentEngine = 'DEEPSEEK';
    let model = cfg.model;
    let latencyMs = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let rawDecision: any = null;
    let decisionError: string | undefined;

    const client = this.buildClient(cfg);
    if (client.isConfigured()) {
      try {
        const messages: DeepSeekChatMessage[] = [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(ctx.promptContext) },
        ];
        let res = await client.chat(messages, { jsonMode: true });
        latencyMs = res.latencyMs;
        promptTokens = res.promptTokens;
        completionTokens = res.completionTokens;
        model = res.model;

        try {
          rawDecision = this.parseModelAnswer(res.content);
        } catch (parseErr: any) {
          // One repair round-trip: models occasionally wrap JSON in prose.
          const repair = await client.chat(
            [
              ...messages,
              { role: 'assistant', content: res.content.slice(0, 4000) },
              {
                role: 'user',
                content:
                  'Your previous answer was not valid JSON. Reply again with ONLY the JSON object, no markdown, no prose.',
              },
            ],
            { jsonMode: true, temperature: 0 }
          );
          latencyMs += repair.latencyMs;
          promptTokens += repair.promptTokens;
          completionTokens += repair.completionTokens;
          rawDecision = this.parseModelAnswer(repair.content);
        }
      } catch (err: any) {
        decisionError = err?.message || String(err);
        if (!cfg.fallbackEnabled) {
          return this.finishWithError(cfg, trigger, dryRun, `DeepSeek API: ${decisionError}`, startedAt);
        }
        engine = 'LOCAL_FALLBACK';
        model = 'tb5-local-fallback';
      }
    } else {
      engine = 'LOCAL_FALLBACK';
      model = 'tb5-local-fallback';
      decisionError = 'Cheia API DeepSeek nu este configurată.';
    }

    if (!rawDecision) {
      if (!cfg.fallbackEnabled) {
        return this.finishWithError(
          cfg,
          trigger,
          dryRun,
          decisionError || 'DeepSeek nu a returnat o decizie utilizabilă.',
          startedAt
        );
      }
      engine = 'LOCAL_FALLBACK';
      model = 'tb5-local-fallback';
      rawDecision = this.buildFallbackDecision(cfg, ctx);
    }

    // 4. Normalise + sanitise every proposed action
    const proposed = this.normaliseActions(rawDecision?.actions);
    const { approved, rejected } = this.validateActions(proposed, cfg, ctx);

    // 5. Deterministic guardrail stops, merged on top of the model output
    const guardrailActions = this.buildGuardrailStops(cfg, ctx);
    const guardrailApproved: DeepSeekAgentAction[] = [];
    for (const ga of guardrailActions) {
      const algoId = (ga as any).algoId as string;
      const already = [...approved, ...guardrailApproved].some(
        (a) => (a.type === 'STOP_BOT' || a.type === 'AMEND_BOT') && (a as any).algoId === algoId
      );
      if (!already) guardrailApproved.push(ga);
    }

    const executable = [...guardrailApproved, ...approved].slice(
      0,
      Math.max(cfg.maxActionsPerCycle, guardrailApproved.length)
    );

    // 6. Execute
    const results: DeepSeekActionResult[] = [];
    if (!dryRun) {
      for (const action of executable) {
        const source: 'MODEL' | 'GUARDRAIL' = guardrailApproved.includes(action)
          ? 'GUARDRAIL'
          : 'MODEL';
        results.push(await this.executeAction(action, source));
      }
    }

    const decision: DeepSeekAgentDecision = {
      id: makeId('dsk'),
      createdAt: Date.now(),
      trigger,
      mode: cfg.mode,
      engine,
      model,
      dryRun,
      latencyMs,
      promptTokens: promptTokens || undefined,
      completionTokens: completionTokens || undefined,
      marketRegime: String(rawDecision?.market_regime || 'NECUNOSCUT').slice(0, 160),
      summaryRo: String(rawDecision?.summary_ro || '').slice(0, 1200),
      confidence: clamp(Number(rawDecision?.confidence), 0, 1),
      actions: proposed,
      guardrailActions,
      approvedActions: executable,
      rejectedActions: rejected,
      results,
      error: decisionError,
    };

    this.persistDecision(decision);
    this.logDecision(decision);
    await this.notify(decision, cfg);

    // Cooldowns for successfully opened symbols. A guardrail stop releases the symbol at
    // once, so the next cycle may re-draw a fresh grid around the current price.
    const cooldowns = { ...(cfg.symbolCooldowns || {}) };
    let cooldownsChanged = false;
    for (const r of results) {
      if (!r.success) continue;
      if (r.action.type === 'OPEN_GRID') {
        cooldowns[(r.action as any).instId] = Date.now();
        cooldownsChanged = true;
      }
      if (r.action.type === 'STOP_BOT' && r.source === 'GUARDRAIL') {
        const stopped = ctx.runningBots.find(
          (b) => b.algoId === (r.action as any).algoId
        );
        if (stopped?.instId && cooldowns[stopped.instId] !== undefined) {
          delete cooldowns[stopped.instId];
          cooldownsChanged = true;
        }
      }
    }
    if (cooldownsChanged) this.pruneCooldowns(cooldowns);
    this.saveRuntime({
      ...(cooldownsChanged ? { symbolCooldowns: cooldowns } : {}),
      lastRunAt: Date.now(),
      lastDecisionAt: Date.now(),
    });

    return decision;
  }

  private parseModelAnswer(content: string): any {
    const parsed = extractJsonObject(content);
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Decizia DeepSeek nu este un obiect JSON.');
    }
    return parsed;
  }

  private finishWithError(
    cfg: DeepSeekAgentConfig,
    trigger: 'SCHEDULE' | 'MANUAL' | 'EVENT',
    dryRun: boolean,
    error: string,
    startedAt: number
  ): DeepSeekAgentDecision {
    const decision: DeepSeekAgentDecision = {
      id: makeId('dsk'),
      createdAt: Date.now(),
      trigger,
      mode: cfg.mode,
      engine: 'DEEPSEEK',
      model: cfg.model,
      dryRun,
      latencyMs: Date.now() - startedAt,
      marketRegime: 'EROARE',
      summaryRo: `Ciclul agentului a eșuat: ${error}`,
      confidence: 0,
      actions: [],
      guardrailActions: [],
      approvedActions: [],
      rejectedActions: [],
      results: [],
      error,
    };
    this.persistDecision(decision);
    this.deps.logAudit('AGENT_ERROR', `[DEEPSEEK AGENT] ${error}`, { trigger });
    const next = this.getConfig();
    next.totalErrors = (next.totalErrors || 0) + 1;
    next.consecutiveErrors = (next.consecutiveErrors || 0) + 1;
    next.lastError = error;
    this.configStore.save(next);
    return decision;
  }

  // ---------------------------------------------------------- normalisation --

  private normaliseActions(raw: any): DeepSeekAgentAction[] {
    if (!Array.isArray(raw)) return [];
    const out: DeepSeekAgentAction[] = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const type = String(item.type || '').toUpperCase();
      if (type === 'OPEN_GRID') {
        out.push({
          type: 'OPEN_GRID',
          instId: String(item.instId || item.inst_id || '').trim(),
          minPx: Number(item.minPx ?? item.min_px),
          maxPx: Number(item.maxPx ?? item.max_px),
          gridNum: Number(item.gridNum ?? item.grid_num),
          runType: String(item.runType ?? item.run_type) === '2' ? '2' : '1',
          lever: Number(item.lever),
          sz: Number(item.sz ?? item.size ?? item.investment),
          stopLossPct: item.stopLossPct ?? item.stop_loss_pct,
          takeProfitPct: item.takeProfitPct ?? item.take_profit_pct,
          rangeVariant: item.rangeVariant || item.range_variant,
          rationale_ro: String(item.rationale_ro || item.rationale || ''),
        });
      } else if (type === 'STOP_BOT' || type === 'CLOSE_BOT' || type === 'STOP') {
        out.push({
          type: 'STOP_BOT',
          algoId: String(item.algoId || item.algo_id || '').trim(),
          stopType: String(item.stopType ?? item.stop_type) === '2' ? '2' : '1',
          rationale_ro: String(item.rationale_ro || item.rationale || ''),
        });
      } else if (type === 'AMEND_BOT' || type === 'AMEND') {
        out.push({
          type: 'AMEND_BOT',
          algoId: String(item.algoId || item.algo_id || '').trim(),
          tpTriggerPx: item.tpTriggerPx ?? item.tp_trigger_px,
          slTriggerPx: item.slTriggerPx ?? item.sl_trigger_px,
          stopLossPct: item.stopLossPct ?? item.stop_loss_pct,
          takeProfitPct: item.takeProfitPct ?? item.take_profit_pct,
          rationale_ro: String(item.rationale_ro || item.rationale || ''),
        });
      } else if (type === 'HOLD') {
        out.push({ type: 'HOLD', rationale_ro: String(item.rationale_ro || item.rationale || '') });
      }
    }
    return out;
  }

  // -------------------------------------------------------------- validation --

  private validateActions(
    actions: DeepSeekAgentAction[],
    cfg: DeepSeekAgentConfig,
    ctx: BuiltContext
  ): { approved: DeepSeekAgentAction[]; rejected: DeepSeekRejectedAction[] } {
    const approved: DeepSeekAgentAction[] = [];
    const rejected: DeepSeekRejectedAction[] = [];
    const candidateMap = new Map(ctx.candidates.map((c) => [c.instId, c]));
    const botMap = new Map(ctx.runningBots.map((b) => [b.algoId, b]));
    const cooldowns = cfg.symbolCooldowns || {};

    let slotsLeft = ctx.freeSlots;
    let spendable = Math.max(0, ctx.snapshot.freeBalance - cfg.minReserveUSDT);
    let opensApproved = 0;

    const dailyLossBreached =
      cfg.dailyLossLimitUSDT > 0 && ctx.snapshot.sessionPnl <= -Math.abs(cfg.dailyLossLimitUSDT);

    for (const action of actions) {
      if (action.type === 'HOLD') continue;

      if (action.type === 'OPEN_GRID') {
        const reject = (reason: string) => rejected.push({ action, reason });
        if (!cfg.allowOpenBots) {
          reject('Deschiderea autonomă de boți este dezactivată în config (allowOpenBots=false).');
          continue;
        }
        if (ctx.snapshot.killSwitchEngaged) {
          reject('Kill Switch este activat.');
          continue;
        }
        if (ctx.snapshot.executionMode !== 'LIVE') {
          reject(
            `Modul de execuție este ${ctx.snapshot.executionMode}. Agentul NU comută modul singur — gridul nativ cere contul deja pe LIVE.`
          );
          continue;
        }
        if (!this.deps.hasOKXCredentials()) {
          reject('Cheile API OKX nu sunt configurate.');
          continue;
        }
        if (ctx.authorityConflict) {
          reject(ctx.authorityConflictReason || 'Conflict de autoritate cu Autopilotul nativ OKX.');
          continue;
        }
        if (dailyLossBreached) {
          reject(
            `Limita de pierdere pe sesiune a fost atinsă (PnL ${rnd(ctx.snapshot.sessionPnl)}$ ≤ -${cfg.dailyLossLimitUSDT}$). Nu se deschid boți noi.`
          );
          continue;
        }
        if (opensApproved >= cfg.maxActionsPerCycle) {
          reject(`Limita de acțiuni per ciclu (${cfg.maxActionsPerCycle}) a fost atinsă.`);
          continue;
        }
        if (slotsLeft <= 0) {
          reject(`Toate sloturile sunt ocupate (${cfg.maxConcurrentBots} boți maxim).`);
          continue;
        }

        const candidate = candidateMap.get(action.instId);
        if (!candidate) {
          reject(`Instrument necunoscut sau în afara listei analizate (${action.instId || 'gol'}).`);
          continue;
        }
        if (!candidate.instId.includes('_UM_XPERP')) {
          reject(`Instrumentul ${candidate.instId} nu este contract X-Perp (_UM_XPERP).`);
          continue;
        }
        if (!candidate.isEligible) {
          reject(`Candidatul ${candidate.instId} nu este eligibil: ${candidate.rejectionReason || 'motiv necunoscut'}.`);
          continue;
        }
        if (ctx.runningBots.some((b) => b.instId === candidate.instId)) {
          reject(`Există deja un bot activ pe ${candidate.instId}.`);
          continue;
        }
        const cooldownMs = cfg.cooldownMinutesPerSymbol * 60_000;
        const lastOpen = Number(cooldowns[candidate.instId]) || 0;
        if (cooldownMs > 0 && lastOpen > 0 && Date.now() - lastOpen < cooldownMs) {
          const leftMin = Math.ceil((cooldownMs - (Date.now() - lastOpen)) / 60_000);
          reject(`Cooldown activ pe ${candidate.instId} (încă ${leftMin} min).`);
          continue;
        }
        if ((candidate.suitabilityScore || 0) < cfg.minSuitabilityScore) {
          reject(
            `Scor ${candidate.suitabilityScore} sub pragul minim ${cfg.minSuitabilityScore} pentru ${candidate.instId}.`
          );
          continue;
        }
        if ((candidate.estimatedNetProfitPerGridPct || 0) < cfg.minNetProfitPerGridPct) {
          reject(
            `Profit net/grilă ${rnd(candidate.estimatedNetProfitPerGridPct, 3)}% sub pragul ${cfg.minNetProfitPerGridPct}%.`
          );
          continue;
        }

        // --- geometry -----------------------------------------------------
        const price = Number(candidate.price) || 0;
        const minPx = Number(action.minPx);
        const maxPx = Number(action.maxPx);
        if (!Number.isFinite(minPx) || !Number.isFinite(maxPx) || minPx <= 0 || maxPx <= minPx) {
          reject('Range invalid: minPx trebuie > 0 și maxPx > minPx.');
          continue;
        }
        if (price <= 0) {
          reject('Prețul curent nu este disponibil pentru validarea range-ului.');
          continue;
        }
        if (price <= minPx || price >= maxPx) {
          reject(
            `Prețul curent (${price}) nu se află în interiorul range-ului [${minPx}, ${maxPx}].`
          );
          continue;
        }
        const lowerDev = Math.abs(price - minPx) / price * 100;
        const upperDev = Math.abs(maxPx - price) / price * 100;
        if (lowerDev > 25 || upperDev > 25) {
          reject(
            `Range prea larg față de prețul curent (${rnd(lowerDev, 1)}% / ${rnd(upperDev, 1)}% > 25%).`
          );
          continue;
        }

        // --- sizing -------------------------------------------------------
        const gridNum = clamp(Math.round(Number(action.gridNum) || candidate.gridNum || 6), 2, 100);
        const lever = clamp(Math.round(Number(action.lever) || candidate.lever || 3), 1, cfg.maxLeverage);
        const minInv = Math.max(5, Number(candidate.minInvestmentUSDT) || 5);
        let sz = Number(action.sz);
        if (!Number.isFinite(sz) || sz <= 0) sz = cfg.budgetPerBotUSDT;
        sz = clamp(sz, minInv, cfg.budgetPerBotUSDT);
        if (sz < minInv) {
          reject(
            `Investiția ${rnd(sz)}$ este sub minimul OKX de ${rnd(minInv)}$ pentru ${candidate.instId} (buget/bot ${cfg.budgetPerBotUSDT}$).`
          );
          continue;
        }
        if (spendable < sz) {
          reject(
            `Fond liber insuficient după rezerva de ${cfg.minReserveUSDT}$ (disponibil ${rnd(spendable)}$, necesar ${rnd(sz)}$).`
          );
          continue;
        }

        const stopLossPct = clamp(Number(action.stopLossPct) || 8, 1, cfg.hardStopLossPct);
        const takeProfitPct = clamp(Number(action.takeProfitPct) || 15, 1, 300);

        approved.push({
          type: 'OPEN_GRID',
          instId: candidate.instId,
          minPx: rnd(minPx, 8),
          maxPx: rnd(maxPx, 8),
          gridNum,
          runType: action.runType === '2' ? '2' : candidate.runType || '1',
          lever,
          sz: rnd(sz),
          stopLossPct,
          takeProfitPct,
          rangeVariant: action.rangeVariant || candidate.selectedVariant,
          rationale_ro: action.rationale_ro,
        });
        slotsLeft--;
        spendable -= sz;
        opensApproved++;
        continue;
      }

      if (action.type === 'STOP_BOT') {
        if (!cfg.allowStopBots) {
          rejected.push({ action, reason: 'Oprirea autonomă de boți este dezactivată (allowStopBots=false).' });
          continue;
        }
        const bot = botMap.get(action.algoId);
        if (!bot) {
          rejected.push({
            action,
            reason: `algoId ${action.algoId || 'gol'} nu corespunde niciunui bot activ gestionat de TB5.`,
          });
          continue;
        }
        approved.push({
          type: 'STOP_BOT',
          algoId: bot.algoId,
          stopType: action.stopType === '2' ? '2' : '1',
          rationale_ro: action.rationale_ro,
        });
        continue;
      }

      if (action.type === 'AMEND_BOT') {
        if (!cfg.allowAmendBots) {
          rejected.push({ action, reason: 'Modificarea autonomă a boților este dezactivată (allowAmendBots=false).' });
          continue;
        }
        const bot = botMap.get(action.algoId);
        if (!bot) {
          rejected.push({
            action,
            reason: `algoId ${action.algoId || 'gol'} nu corespunde niciunui bot activ gestionat de TB5.`,
          });
          continue;
        }
        const slTriggerPx =
          Number(action.slTriggerPx) > 0 ? rnd(Number(action.slTriggerPx), 8) : undefined;
        const tpTriggerPx =
          Number(action.tpTriggerPx) > 0 ? rnd(Number(action.tpTriggerPx), 8) : undefined;
        if (slTriggerPx === undefined && tpTriggerPx === undefined) {
          rejected.push({ action, reason: 'AMEND_BOT fără niciun preț SL/TP valid.' });
          continue;
        }
        const px = Number(bot.currentPx) || 0;
        if (slTriggerPx !== undefined && px > 0 && slTriggerPx >= px) {
          rejected.push({ action, reason: `SL (${slTriggerPx}) trebuie să fie sub prețul curent (${px}).` });
          continue;
        }
        if (tpTriggerPx !== undefined && px > 0 && tpTriggerPx <= px) {
          rejected.push({ action, reason: `TP (${tpTriggerPx}) trebuie să fie peste prețul curent (${px}).` });
          continue;
        }
        approved.push({
          type: 'AMEND_BOT',
          algoId: bot.algoId,
          slTriggerPx,
          tpTriggerPx,
          stopLossPct: Number(action.stopLossPct) > 0 ? clamp(Number(action.stopLossPct), 1, cfg.hardStopLossPct) : undefined,
          takeProfitPct: Number(action.takeProfitPct) > 0 ? clamp(Number(action.takeProfitPct), 1, 300) : undefined,
          rationale_ro: action.rationale_ro,
        });
      }
    }

    return { approved, rejected };
  }

  // ------------------------------------------------------- hard guardrails ---

  /**
   * Deterministic risk layer. These stops do not depend on the model and are never
   * suppressed by a HOLD — that is what makes the agent safe to leave running.
   */
  private buildGuardrailStops(cfg: DeepSeekAgentConfig, ctx: BuiltContext): DeepSeekAgentAction[] {
    if (!cfg.enforceHardGuardrails || !cfg.allowStopBots) return [];
    const out: DeepSeekAgentAction[] = [];

    for (const bot of ctx.runningBots) {
      const reasons: string[] = [];
      const pnlPct = bot.sz > 0 ? (bot.totalPnl / bot.sz) * 100 : 0;
      if (pnlPct <= -Math.abs(cfg.hardStopLossPct)) {
        reasons.push(`PnL ${rnd(pnlPct)}% ≤ -${cfg.hardStopLossPct}% din marjă`);
      }
      const distLiq = bot.liqPx > 0 ? pctDistance(bot.currentPx, bot.liqPx) : null;
      if (distLiq !== null && distLiq <= cfg.hardMinLiqDistancePct) {
        reasons.push(`distanță lichidare ${rnd(distLiq, 1)}% ≤ ${cfg.hardMinLiqDistancePct}%`);
      }
      const outsideRange =
        bot.currentPx > 0 &&
        ((bot.minPx > 0 && bot.currentPx < bot.minPx) || (bot.maxPx > 0 && bot.currentPx > bot.maxPx));
      if (outsideRange) {
        reasons.push(`preț ${rnd(bot.currentPx, 6)} în afara range-ului [${rnd(bot.minPx, 6)}, ${rnd(bot.maxPx, 6)}]`);
      }
      const ageMin = Math.max(0, Math.round((Date.now() - (bot.cTime || Date.now())) / 60000));
      const passive = bot.arbitrageNum === 0 && ageMin >= cfg.hardMaxNoFillMinutes;
      if (passive && (cfg.stopIfPassive || bot.totalPnl < 0)) {
        reasons.push(
          cfg.stopIfPassive
            ? `0 arbitraje în ${ageMin} min (prag ${cfg.hardMaxNoFillMinutes} min) — bot pasiv, capital imobilizat (PnL ${rnd(bot.totalPnl)} USDT ignorat intenționat)`
            : `0 arbitraje în ${ageMin} min (prag ${cfg.hardMaxNoFillMinutes} min) cu PnL negativ`
        );
      }

      if (reasons.length > 0) {
        out.push({
          type: 'STOP_BOT',
          algoId: bot.algoId,
          stopType: '1',
          rationale_ro: `GUARDRAIL TB5: ${reasons.join(' | ')}.`,
        });
      }
    }

    return out;
  }

  // ------------------------------------------------------------ fallback -----

  /**
   * Deterministic replacement for the LLM when the API is unavailable. It applies the
   * same *ranking* rules the prompt asks for, on the TB5 ranking — but no hard safety
   * decision: every proposal still goes through validateActions(), exactly like a model
   * answer. That keeps a single source of truth for mode/kill-switch/authority/budget/
   * slot/cooldown/range guards, and it means a dry-run cycle still explains WHY an
   * opportunity was not taken.
   */
  private buildFallbackDecision(cfg: DeepSeekAgentConfig, ctx: BuiltContext): any {
    const actions: any[] = [];
    const runningIds = new Set(ctx.runningBots.map((b) => b.instId));

    if (cfg.allowOpenBots) {
      const pool = ctx.candidates
        .filter(
          (c) =>
            c.isEligible &&
            !runningIds.has(c.instId) &&
            c.suitabilityScore >= cfg.minSuitabilityScore &&
            c.estimatedNetProfitPerGridPct >= cfg.minNetProfitPerGridPct
        )
        .sort((a, b) => b.suitabilityScore - a.suitabilityScore)
        .slice(0, cfg.maxActionsPerCycle);

      for (const cand of pool) {
        actions.push({
          type: 'OPEN_GRID',
          instId: cand.instId,
          minPx: cand.minPx,
          maxPx: cand.maxPx,
          gridNum: cand.gridNum,
          runType: cand.runType,
          lever: Math.min(cand.lever, cfg.maxLeverage),
          sz: Math.min(cfg.budgetPerBotUSDT, Math.max(5, cand.minInvestmentUSDT)),
          stopLossPct: 8,
          takeProfitPct: 15,
          rangeVariant: cand.selectedVariant,
          rationale_ro: `Fallback determinist TB5: ${cand.instId} are scor ${cand.suitabilityScore}/100, regim ${cand.regimeLabel}, profit net ${rnd(cand.estimatedNetProfitPerGridPct, 3)}%/grilă.`,
        });
      }
    }

    if (actions.length === 0) {
      actions.push({
        type: 'HOLD',
        rationale_ro:
          'Fallback determinist TB5: nicio oportunitate eligibilă nu îndeplinește simultan pragurile de scor, profit net, buget și sloturi libere.',
      });
    }

    return {
      market_regime: 'FALLBACK DETERMINIST (API DeepSeek indisponibil)',
      summary_ro:
        'Decizie generată de motorul determinist TB5, nu de DeepSeek. Regulile de risc și pragurile de configurare au fost aplicate identic.',
      confidence: 0.4,
      actions,
    };
  }

  // ------------------------------------------------------------ execution ----

  /**
   * OKX EEA does not expose X-Perp (`_UM_XPERP`) instruments on the grid algo gateway:
   * `GET /api/v5/tradingBot/grid/orders-algo-pending` answers 51001 ("Instrument ID doesn't
   * exist") for `BTC-USD_UM_XPERP-310404`, while the identical call with `BTC-USDT-SWAP`
   * returns an empty list — and `POST /tradingBot/grid/order-algo` then fails with
   * 51000 "Parameter instId error". The native contract_grid route only knows
   * SPOT / SWAP / MARGIN ids. Verified read-only, nothing was placed.
   *
   * Consequence: an X-Perp open always goes straight to the direct-order fallback, so we
   * no longer burn a guaranteed-failing API call per open or journal a misleading
   * [OKX EEA GATEWAY 51000] line. `preferNativeAlgo` keeps its meaning for SWAP ids, so
   * the native route resumes automatically if the universe ever trades `-SWAP`.
   */
  private resolveExecutionVariant(instId: string): 'NATIVE_ASSISTANT' | 'AUTO_LIMIT' {
    if (!this.getConfig().preferNativeAlgo) return 'AUTO_LIMIT';
    if (String(instId || '').toUpperCase().includes('_UM_XPERP')) return 'AUTO_LIMIT';
    return 'NATIVE_ASSISTANT';
  }

  private async executeAction(
    action: DeepSeekAgentAction,
    source: 'MODEL' | 'GUARDRAIL'
  ): Promise<DeepSeekActionResult> {
    const timestamp = Date.now();
    try {
      if (action.type === 'OPEN_GRID') {
        const res = await this.deps.createNativeGridBot({
          instId: action.instId,
          minPx: action.minPx,
          maxPx: action.maxPx,
          gridNum: action.gridNum,
          runType: action.runType,
          lever: action.lever,
          sz: action.sz,
          stopLossPct: action.stopLossPct,
          takeProfitPct: action.takeProfitPct,
          stopTypeOnRisk: '1',
          stopOnRangeBreakout: true,
          stopOnTrendInvalidation: true,
          executionVariant: this.resolveExecutionVariant(action.instId),
          environment: 'LIVE',
          explicitLiveConfirm: true,
        });
        const algoId = res?.bot?.algoId;
        const message = res?.success
          ? `Bot deschis pe ${action.instId} ($${rnd(action.sz)} @ ${action.lever}x, ${action.gridNum} grile)${algoId ? ` — algoId ${algoId}` : ''}.`
          : `Deschidere respinsă pe ${action.instId}: ${res?.error || 'eroare necunoscută'}`;
        this.deps.logAudit(
          res?.success ? 'GRID_CREATED' : 'ORDER_REJECTED',
          `[DEEPSEEK AGENT → ${source}] ${message}`,
          { action, result: res }
        );
        return { action, success: Boolean(res?.success), message, algoId, timestamp, source };
      }

      if (action.type === 'STOP_BOT') {
        const res = await this.deps.stopNativeGridBot(
          action.algoId,
          action.stopType || '1',
          action.rationale_ro || 'Decizie DeepSeek Agent'
        );
        const message = res?.success
          ? `Bot ${action.algoId} oprit (stopType ${action.stopType || '1'}).`
          : `Oprire eșuată pentru ${action.algoId}: ${res?.error || 'eroare necunoscută'}`;
        this.deps.logAudit(
          res?.success ? 'GRID_STOPPED' : 'AGENT_ERROR',
          `[DEEPSEEK AGENT → ${source}] ${message}`,
          { action }
        );
        return {
          action,
          success: Boolean(res?.success),
          message,
          algoId: action.algoId,
          timestamp,
          source,
        };
      }

      if (action.type === 'AMEND_BOT') {
        const res = await this.deps.amendNativeGridBot(action.algoId, {
          slTriggerPx: action.slTriggerPx,
          tpTriggerPx: action.tpTriggerPx,
          stopLossPct: action.stopLossPct,
          takeProfitPct: action.takeProfitPct,
        });
        const message = res?.success
          ? `Parametri actualizați pentru ${action.algoId} (SL ${action.slTriggerPx ?? '-'} / TP ${action.tpTriggerPx ?? '-'}).`
          : `Modificare eșuată pentru ${action.algoId}: ${res?.error || 'eroare necunoscută'}`;
        this.deps.logAudit(
          res?.success ? 'GRID_MODIFIED' : 'AGENT_ERROR',
          `[DEEPSEEK AGENT → ${source}] ${message}`,
          { action }
        );
        return {
          action,
          success: Boolean(res?.success),
          message,
          algoId: action.algoId,
          timestamp,
          source,
        };
      }

      return { action, success: true, message: 'HOLD — nicio acțiune executată.', timestamp, source };
    } catch (err: any) {
      const message = `Excepție la execuția ${action.type}: ${err?.message || err}`;
      this.deps.logAudit('AGENT_ERROR', `[DEEPSEEK AGENT] ${message}`, { action });
      return { action, success: false, message, timestamp, source };
    }
  }

  // ------------------------------------------------------------ persistence --

  private persistDecision(decision: DeepSeekAgentDecision): void {
    const history = this.getDecisions(MAX_DECISION_HISTORY);
    const next = [decision, ...history].slice(0, MAX_DECISION_HISTORY);
    this.decisionStore.save(next);
  }

  private saveRuntime(updates: Partial<DeepSeekAgentConfig>): void {
    const latest = this.getConfig();
    const next: DeepSeekAgentConfig = { ...latest, ...updates };
    // totalCycles is owned by logDecision() so a single cycle is counted exactly once.
    this.configStore.save(next);
  }

  private pruneCooldowns(cooldowns: Record<string, number>): void {
    const entries = Object.entries(cooldowns).sort((a, b) => b[1] - a[1]);
    if (entries.length <= MAX_SYMBOL_COOLDOWNS) return;
    for (const [key] of entries.slice(MAX_SYMBOL_COOLDOWNS)) {
      delete cooldowns[key];
    }
  }

  private logDecision(decision: DeepSeekAgentDecision): void {
    const executed = decision.results.filter((r) => r.success).length;
    const parts: string[] = [];
    parts.push(`motor ${decision.engine}${decision.engine === 'DEEPSEEK' ? ` (${decision.model})` : ''}`);
    parts.push(`${decision.dryRun ? 'DRY-RUN' : 'EXECUȚIE'}`);
    parts.push(`${decision.approvedActions.length} acțiuni aprobate`);
    if (decision.rejectedActions.length > 0) parts.push(`${decision.rejectedActions.length} respinse`);
    if (!decision.dryRun) parts.push(`${executed} executate`);

    const header = `[DEEPSEEK AGENT] ${decision.marketRegime} — ${parts.join(' | ')}`;
    const detail = decision.summaryRo ? ` Decizie: ${decision.summaryRo}` : '';
    const type: AuditLogType = decision.error ? 'AGENT_ERROR' : 'AGENT_DECISION';

    this.deps.logAudit(type, `${header}.${detail}`, {
      id: decision.id,
      trigger: decision.trigger,
      actions: decision.actions,
      approved: decision.approvedActions,
      rejected: decision.rejectedActions,
      results: decision.results,
      confidence: decision.confidence,
      tokens: { prompt: decision.promptTokens, completion: decision.completionTokens },
      error: decision.error,
    });
    const next = this.getConfig();
    next.totalCycles = (next.totalCycles || 0) + 1;
    next.lastRunAt = decision.createdAt;
    next.lastDecisionAt = decision.createdAt;
    next.lastDecisionSummary = `${decision.marketRegime}: ${decision.summaryRo}`.slice(0, 600);
    next.totalActionsExecuted =
      (next.totalActionsExecuted || 0) + decision.results.filter((r) => r.success).length;
    if (decision.error) {
      next.totalErrors = (next.totalErrors || 0) + 1;
      next.consecutiveErrors = (next.consecutiveErrors || 0) + 1;
      next.lastError = decision.error;
    } else {
      next.consecutiveErrors = 0;
      next.lastError = undefined;
    }
    this.configStore.save(next);
  }

  private async notify(
    decision: DeepSeekAgentDecision,
    cfg: DeepSeekAgentConfig
  ): Promise<void> {
    if (!cfg.notifyTelegram || !this.deps.notifyTelegram) return;
    const successResults = decision.results.filter((r) => r.success);
    const hasOpen = successResults.some((r) => r.action.type === 'OPEN_GRID');
    const hasGuardrail = decision.guardrailActions.length > 0;
    // Stay quiet unless something happened (or the operator triggered it manually).
    if (!hasOpen && !hasGuardrail && decision.trigger === 'SCHEDULE' && !decision.error) return;

    const lines: string[] = [];
    lines.push(`🤖 *DeepSeek Grid Agent* — ${decision.dryRun ? 'DRY-RUN' : 'AUTONOM'}`);
    lines.push(`Regim: ${decision.marketRegime}`);
    if (decision.summaryRo) lines.push(decision.summaryRo);
    for (const r of decision.results) {
      lines.push(`${r.success ? '✅' : '❌'} ${r.message}`);
    }
    for (const rej of decision.rejectedActions.slice(0, 4)) {
      lines.push(`⛔ Respins: ${rej.reason}`);
    }
    if (decision.error) lines.push(`⚠️ Eroare: ${decision.error}`);

    try {
      await this.deps.notifyTelegram(lines.join('\n'));
    } catch {
      // Telegram is best-effort; never let it break the cycle.
    }
  }
}
