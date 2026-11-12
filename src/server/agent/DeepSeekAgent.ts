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
  DeepSeekTokenUsage,
  DeepSeekUsageStats,
  NativeGridOpportunity,
  OKXNativeGridBot,
} from '../../shared/types';
import { JsonStore } from '../store';
// The leverage ceiling is shared with the plan builder: two copies of "safe up to Nx" is how a
// decision gets approved at a leverage the execution path then clamps differently. The two risk
// helpers keep the %-of-margin stop and the %-of-price grid in the same unit.
import {
  gridStopLossPct,
  maxLeverageForBand,
  GRID_PLAN_MAX_LEVERAGE,
} from '../engine/grid/gridPlan';
import { AGENT_SCAN_POOL_REFRESH_MINUTES, AGENT_SCAN_POOL_SIZE } from './AgentUniverseScan';
import { inspectBandLegality } from './gridBand';
import {
  SCAN_CONFIRMATION_DEFAULT_MAX_AGE_MINUTES,
  SCAN_CONFIRMATION_DEFAULT_MIN_SPACING_MINUTES,
  SCAN_CONFIRMATION_DEFAULT_TOP_N,
  applyScanToLedger,
  resolveConfirmationConfig,
  type ScanConfirmationLedger,
  type ScanConfirmationResult,
} from './agentScanConfirmation';
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
  /**
   * AGENT-OWNED universe scan (public OKX data only, ranked by crossings/hour).
   * When implemented AND `ownUniverseScan` is on, the agent ignores the app's
   * opportunity list completely — no NeutralGridAnalyzer, no app scores.
   */
  scanAgentUniverse?(opts: {
    deepScanCount: number;
    budgetPerBotUSDT: number;
    maxLeverage: number;
    hardStopLossPct?: number;
    universeScanMode?: 'pool' | 'rotation' | 'turnover';
    poolSize?: number;
    poolRefreshMinutes?: number;
  }): Promise<NativeGridOpportunity[]>;
  /** Live price activity for one instrument, in % of price (feeds the stagnation stop). */
  getMarketActivity?(instId: string): Promise<{ pathPerHourPct: number; atrPct: number } | null>;
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
  // 1 slot at launch; the owner may raise it later.
  maxConcurrentBots: 1,
  budgetPerBotUSDT: 12,
  // 0 reserve: the live account holds ~15 USDC, and a 10 USDC reserve on top of a 12 USDC
  // budget meant the agent could never open anything (12 + 10 > 15).
  minReserveUSDT: 0,
  // Shipped default stays conservative; the ceiling itself is GRID_PLAN_MAX_LEVERAGE (10x),
  // which the owner raises from the DeepSeek tab. Leverage is the only dial that lowers the
  // margin a geometry needs, so a 2x ceiling was itself a hard cap on what could be opened.
  maxLeverage: 2,
  minSuitabilityScore: 70,
  minNetProfitPerGridPct: 0.05,
  cooldownMinutesPerSymbol: 45,
  // Desk ceiling sized for the real account: one 12 USDC grid. Raise it only with equity.
  maxTotalMarginUSDT: 12,
  // DeepSeek list prices, USD per 1M tokens. Editable in the DeepSeek tab — the cost shown
  // is an ESTIMATE computed from these numbers, never a billed amount.
  pricePer1MInputUSD: 0.27,
  pricePer1MInputCachedUSD: 0.07,
  pricePer1MOutputUSD: 1.1,
  usage: {
    apiCalls: 0,
    promptTokens: 0,
    cachedPromptTokens: 0,
    completionTokens: 0,
    costUSD: 0,
  },
  ownUniverseScan: true,
  universeScanSize: 25,
  // Pool: the tickers snapshot ranks the WHOLE universe every cycle (no candles, 1 request), and
  // only the best 50 get candles — 25 per cycle, rotating inside the pool, so the pool is fully
  // re-measured every 2 cycles (40 min) instead of once per 3.7 h rotation turn. The pool itself is
  // re-picked from the whole universe every 3 h; 'rotation' and 'turnover' remain as rollback.
  universeScanMode: 'pool',
  poolSize: AGENT_SCAN_POOL_SIZE,
  poolRefreshMinutes: AGENT_SCAN_POOL_REFRESH_MINUTES,
  minCrossingsPerHour: 0.35,
  // A grid is opened only after the scanner qualified the contract on its last TWO looks
  // (see agentScanConfirmation.ts). One snapshot ranks a contract on the last 12 h of candles;
  // that is a hypothesis, and the second look is what turns it into a decision.
  requireScanConfirmation: true,
  confirmationTopN: SCAN_CONFIRMATION_DEFAULT_TOP_N,
  confirmationMaxAgeMinutes: SCAN_CONFIRMATION_DEFAULT_MAX_AGE_MINUTES,
  confirmationMinSpacingMinutes: SCAN_CONFIRMATION_DEFAULT_MIN_SPACING_MINUTES,
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

// ---------------------------------------------------------------------------
// Token / cost helpers (exported for the regression suite)
// ---------------------------------------------------------------------------

/** Empty consumption counters. */
export function emptyUsageStats(): DeepSeekUsageStats {
  return {
    apiCalls: 0,
    promptTokens: 0,
    cachedPromptTokens: 0,
    completionTokens: 0,
    costUSD: 0,
  };
}

/**
 * Rough prompt size in tokens. DeepSeek/OpenAI tokenizers average ~4 characters per token
 * for JSON-heavy English/Romanian text, which is enough to plan a budget before the call.
 */
export function estimateTokensFromText(text: string): number {
  const length = String(text || '').length;
  return length === 0 ? 0 : Math.ceil(length / 4);
}

/**
 * USD -> cents with the binary-float noise removed BEFORE any rounding decision.
 * `5.11 * 100 === 510.99999999999994`, so a raw `Math.ceil()` charged a whole extra cent
 * (5.11 became 5.12, i.e. sz > budget). Rounding to 6 decimals first keeps the value on the
 * cent grid, and the caller then ceiling/floors an integer.
 */
function usdToCents(usd: number): number {
  const n = Number(usd);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 1e6) / 1e4;
}

/**
 * Deterministic margin for one grid. The LLM never gets to invent this number: an `sz` chosen
 * by the model was consistently below the OKX minimum on cheap contracts (PUMP: 7.31 requested
 * vs 11.9108 required), which turned a valid candidate into a rejection.
 *
 * Rules (all arithmetic in integer cents, never in floats):
 *   - required = OKX minimum + 1 cent of headroom (OKX answers with 4 decimals, we send 2);
 *   - a model value above the floor is honoured, but capped at the budget;
 *   - everything rounds UP to cents — never down, otherwise `sz < minInv` by a rounding hair;
 *   - `sz` can never exceed the budget, otherwise the guard's own budget check fires.
 */
export function resolveOpenSize(
  requestedUSDT: number,
  minInvestmentUSDT: number,
  budgetUSDT: number
): { sz: number; required: number; raised: boolean } {
  const budgetCents = Math.max(500, Math.floor(usdToCents(budgetUSDT)) || 1200);
  const minCents = Math.ceil(usdToCents(minInvestmentUSDT));
  // 1 cent of headroom over the OKX floor, but never past the budget.
  const requiredCents = minCents > 0 ? Math.min(budgetCents, minCents + 1) : 0;
  const askedCents = Math.round(usdToCents(requestedUSDT));
  // No usable value from the model -> aim just under the budget, but clear the floor.
  const targetCents =
    askedCents > 0
      ? askedCents
      : Math.min(budgetCents, Math.max(Math.round(budgetCents * 0.95), requiredCents));
  const szCents = Math.min(budgetCents, Math.max(targetCents, requiredCents, 500));
  return {
    sz: szCents / 100,
    required: requiredCents / 100,
    raised: askedCents > 0 && szCents > askedCents,
  };
}

/** USD cost of ONE call, from the (editable) per-1M-token prices. */
export function computeDeepSeekCostUSD(
  usage: { promptTokens: number; cachedPromptTokens?: number; completionTokens: number },
  prices: {
    pricePer1MInputUSD: number;
    pricePer1MInputCachedUSD: number;
    pricePer1MOutputUSD: number;
  }
): number {
  const prompt = Math.max(0, Number(usage.promptTokens) || 0);
  const cached = Math.min(prompt, Math.max(0, Number(usage.cachedPromptTokens) || 0));
  const uncached = prompt - cached;
  const completion = Math.max(0, Number(usage.completionTokens) || 0);
  const cost =
    (uncached / 1_000_000) * (Number(prices.pricePer1MInputUSD) || 0) +
    (cached / 1_000_000) * (Number(prices.pricePer1MInputCachedUSD) || 0) +
    (completion / 1_000_000) * (Number(prices.pricePer1MOutputUSD) || 0);
  return Math.round(cost * 1e6) / 1e6;
}

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
- Never OPEN_GRID on a candidate with confirmed=false. A confirmed candidate qualified on the last TWO scans; confirmed=false means it has qualified only once (or not at all), and confirm_hint says why. Wait for the next cycle instead of opening early. confirmed=null means the gate is off this cycle.
- sz: copy the candidate field sz_usdt verbatim. It is already sized from the lot estimate and capped by budget_per_bot_usdt. Do NOT invent your own margin; if you must change it, stay between 5 and sz_usdt (min_inv_usdt is a LOCAL estimate, not an OKX limit). lever <= max_leverage.
- running_bots + new opens must stay <= max_concurrent_bots, and free_usdt minus the new margin must stay >= min_reserve_usdt.
- The current price MUST lie strictly inside [minPx, maxPx], and the range must stay within +/-25% of the current price.
- The candidate list comes from YOUR OWN scan (scan_source = "AGENT"): it is ranked by crossings_per_h = (price path travelled per hour) / (grid step). That number - not suitabilityScore, which your scan deliberately leaves at 0 - is what actually produces money.
- Rank by crossings_per_h DESC. Among them prefer the smallest expected_first_fill_min, the largest net_per_grid_pct, and spread_of_step <= 0.25.
- Never open a candidate with crossings_per_h < min_crossings_per_h, eligible=false, or net_per_grid_pct <= 0. A grid that needs hours for its first fill locks capital for nothing.
- Keep both range bounds inside the agent band and off the 24h extremes: a lower bound sitting on the 24h low (or an upper bound on the 24h high) means one breakout fills every level at once. This is ENFORCED by the execution guard, not a suggestion: a bound within the proximity margin of the 24h low/high is rejected outright.
- Avoid symbols with high absolute funding when a better candidate exists.
- STOP_BOT only on clear deterioration: price outside the range, net PnL <= -6% of margin, distance to liquidation < 15%, or a dead tape re-confirmed by current data.
- Silence alone is NOT a reason to stop. Before stopping a silent bot, re-check current price activity, current ATR, elapsed minutes vs expected_first_fill_min, and the net expected edge: stop only when the tape can no longer reach the next level AND the expected net edge is gone. Never stop a profitable bot merely because it has not filled yet - ask for AMEND_BOT or HOLD instead.
- Recovery of a loss is analytical only: never average down, never martingale, never raise order size or leverage to win a loss back. If a grid is wrong, close it.
- AMEND_BOT only to tighten risk (raise SL, lower TP) or to widen TP when the range is clearly holding; never widen SL beyond hard_stop_loss_pct.
- Never propose: changing execution mode, toggling the kill switch, changing account leverage, creating/modifying/deleting any bot that is not in running_bots, or anything about API keys, balances transfers, or deposits.
- Never output markdown, prose or code fences. Output ONE JSON object and nothing else.

OUTPUT JSON SCHEMA
{
  "market_regime": "string (max 12 words): the regime that drives your decision",
  "summary_ro": "string: 1-3 sentences in ROMANIAN explaining the decision to the operator",
  "confidence": 0.0,
  "actions": [
    { "type": "OPEN_GRID", "instId": "SOL-USD_UM_XPERP-310523", "minPx": 0, "maxPx": 0, "gridNum": 6, "runType": "1", "lever": 2, "sz": 12, "stopLossPct": 8, "takeProfitPct": 15, "rangeVariant": "BALANCED", "rationale_ro": "..." },
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

/**
 * Effective liquidation-distance threshold for one bot.
 *
 * A flat 12% guardrail cannot coexist with 10x: an isolated position at 10x sits ~9% from
 * liquidation the moment it fills, so every 10x grid would be stopped on its first cycle —
 * stop, 45 min cooldown, reopen, stop. The guardrail must stay meaningful (it exists to close a
 * bot whose margin is nearly wiped) without being physically impossible at high leverage, so it
 * is capped at the distance the leverage itself implies — ~88 / lever %, i.e. 1/lever minus a
 * little for maintenance margin and fees. At 2x that is 44% (no effect: the configured 12%
 * stands); it only bites above ~7x.
 */
export function effectiveMinLiqDistancePct(configuredPct: number, lever: number): number {
  const configured = clamp(Number(configuredPct) || 12, 3, 60);
  const physical = 88 / Math.max(1, Number(lever) || 1);
  return clamp(Math.min(configured, physical), 3, 60);
}

/**
 * Distance between two grid levels of a running bot, in % of price.
 * The stagnation rule compares elapsed time against the geometry the bot was opened with.
 */
function botGridStepPct(bot: { minPx: number; maxPx: number; gridNum: number; currentPx: number }): number {
  const minPx = Number(bot.minPx) || 0;
  const maxPx = Number(bot.maxPx) || 0;
  const gridNum = Number(bot.gridNum) || 0;
  const mid = Number(bot.currentPx) > 0 ? Number(bot.currentPx) : (minPx + maxPx) / 2;
  if (!(maxPx > minPx) || gridNum < 2 || !(mid > 0)) return 0;
  return ((maxPx - minPx) / gridNum / mid) * 100;
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
  /**
   * Result of the agent's OWN universe scan for the cycle currently being decided.
   * `undefined` = no own scan performed (use the app list); `[]` = own scan ran but
   * produced nothing, which must NOT silently fall back to app-scored candidates.
   */
  private lastOwnScan?: NativeGridOpportunity[];
  /** Per-contract memory of the last two looks, for the confirmation gate. */
  private scanConfirmation: ScanConfirmationLedger = {};
  /**
   * Result of folding the CURRENT scan into the ledger. `null` means the gate is off for
   * this cycle (own scan disabled or `requireScanConfirmation: false`), in which case
   * nothing is filtered and the reason strings report the exclusion instead.
   */
  private lastConfirmation: ScanConfirmationResult | null = null;

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
    // Clamp on READ as well: a legacy stored file (leverage 10x, cooldown 0, no-fill 20 min)
    // must never reach the decision pipeline unchecked.
    return this.normaliseConfig(merged);
  }

  /** Single source of truth for the numeric/enum envelopes. Idempotent. */
  private normaliseConfig(input: DeepSeekAgentConfig): DeepSeekAgentConfig {
    const next: DeepSeekAgentConfig = { ...input };

    if (next.mode !== 'ADVISOR' && next.mode !== 'AUTONOMOUS') next.mode = 'OFF';
    next.model = String(next.model || DEEPSEEK_CHAT_MODEL).trim() || DEEPSEEK_CHAT_MODEL;
    next.baseUrl = String(next.baseUrl || DEEPSEEK_DEFAULT_BASE_URL).trim() || DEEPSEEK_DEFAULT_BASE_URL;
    next.temperature = clamp(Number(next.temperature), 0, 1.5);
    next.maxTokens = clamp(Math.round(Number(next.maxTokens) || 1600), 400, 8000);
    next.runIntervalSec = clamp(Math.round(Number(next.runIntervalSec) || 300), 60, 3600);
    next.maxActionsPerCycle = clamp(Math.round(Number(next.maxActionsPerCycle) || 2), 1, 5);
    next.maxConcurrentBots = clamp(Math.round(Number(next.maxConcurrentBots) || 1), 1, 5);
    // Budget is the owner's decision (12 USDC on the current account); we only refuse the
    // absurd. The old 10..50 window was a hard stop for a 15 USDC account.
    next.budgetPerBotUSDT = clamp(Number(next.budgetPerBotUSDT) || 12, 5, 500);
    next.minReserveUSDT = clamp(
      Number.isFinite(Number(next.minReserveUSDT)) ? Number(next.minReserveUSDT) : 0,
      0,
      10_000
    );
    // 1..10x. The old hard ceiling of 2x was the reason every grid looked identical: at 2x,
    // `1 lot x gridNum / lever` exceeded the per-bot budget on most contracts, the venue
    // minimum then pushed the margin to the cap, and the open was refused when it still did
    // not fit. 10x is the owner-approved ceiling (same constant the plan builder enforces).
    next.maxLeverage = clamp(
      Math.round(Number(next.maxLeverage) || 2),
      1,
      GRID_PLAN_MAX_LEVERAGE
    );
    next.maxTotalMarginUSDT = clamp(Number(next.maxTotalMarginUSDT) || 12, 5, 500);
    next.pricePer1MInputUSD = clamp(Number(next.pricePer1MInputUSD) || 0.27, 0, 1000);
    next.pricePer1MInputCachedUSD = clamp(Number(next.pricePer1MInputCachedUSD) || 0.07, 0, 1000);
    next.pricePer1MOutputUSD = clamp(Number(next.pricePer1MOutputUSD) || 1.1, 0, 1000);
    next.ownUniverseScan = next.ownUniverseScan !== false;
    next.universeScanSize = clamp(Math.round(Number(next.universeScanSize) || 25), 5, 60);
    next.poolSize = clamp(
      Math.round(Number(next.poolSize) || AGENT_SCAN_POOL_SIZE),
      5,
      60
    );
    next.poolRefreshMinutes = clamp(
      Math.round(Number(next.poolRefreshMinutes) || AGENT_SCAN_POOL_REFRESH_MINUTES),
      15,
      1440
    );
    // One-time migration: a config saved before the pool existed carries 'rotation' and would keep
    // the old 3.7 h turn forever, because the sanitiser preserves whatever it finds. Stamp a policy
    // version once, then respect the stored mode (including a deliberate rollback to 'rotation').
    if (!(Number(next.scanPolicyVersion) >= 2)) {
      next.universeScanMode = 'pool';
      next.scanPolicyVersion = 2;
    } else {
      next.universeScanMode =
        next.universeScanMode === 'rotation' || next.universeScanMode === 'turnover'
          ? next.universeScanMode
          : 'pool';
    }
    next.minCrossingsPerHour = clamp(Number(next.minCrossingsPerHour) || 0.35, 0.05, 5);
    next.requireScanConfirmation = next.requireScanConfirmation !== false;
    next.confirmationTopN = clamp(
      Math.round(Number(next.confirmationTopN) || SCAN_CONFIRMATION_DEFAULT_TOP_N),
      1,
      60
    );
    next.confirmationMaxAgeMinutes = clamp(
      Math.round(
        Number(next.confirmationMaxAgeMinutes) || SCAN_CONFIRMATION_DEFAULT_MAX_AGE_MINUTES
      ),
      30,
      1440
    );
    next.confirmationMinSpacingMinutes = clamp(
      Math.round(
        Number(next.confirmationMinSpacingMinutes) || SCAN_CONFIRMATION_DEFAULT_MIN_SPACING_MINUTES
      ),
      0,
      240
    );
    next.minSuitabilityScore = clamp(Math.round(Number(next.minSuitabilityScore) || 70), 30, 98);
    next.minNetProfitPerGridPct = clamp(Number(next.minNetProfitPerGridPct) || 0.05, 0.01, 5);
    // 45 min floor: reopening the same contract right after a stop was half of the
    // night-time churn (PUMP was opened 8 times in a row with cooldown=0).
    next.cooldownMinutesPerSymbol = clamp(
      Math.round(
        Number.isFinite(Number(next.cooldownMinutesPerSymbol))
          ? Number(next.cooldownMinutesPerSymbol)
          : 45
      ),
      45,
      1440
    );
    next.dailyLossLimitUSDT = clamp(Number(next.dailyLossLimitUSDT) || 0, 0, 100_000);
    next.maxOpportunitiesInPrompt = clamp(Math.round(Number(next.maxOpportunitiesInPrompt) || 12), 3, 30);
    next.hardStopLossPct = clamp(Number(next.hardStopLossPct) || 12, 2, 60);
    next.hardMinLiqDistancePct = clamp(Number(next.hardMinLiqDistancePct) || 12, 3, 60);
    // Lower bound 60 min: a neutral grid only earns when price crosses its levels, and a sane
    // grid needs ~2-4 crossings/hour in a choppy tape. 15-20 min guarantees a false "passive"
    // verdict on EVERY bot (28 pointless open->stop cycles in one night).
    next.hardMaxNoFillMinutes = clamp(Math.round(Number(next.hardMaxNoFillMinutes) || 180), 60, 1440);
    next.preferNativeAlgo = next.preferNativeAlgo !== false;
    next.stopIfPassive = next.stopIfPassive !== false;
    next.allowedSymbols = Array.isArray(next.allowedSymbols)
      ? next.allowedSymbols.map((s) => String(s).trim()).filter(Boolean)
      : [];
    next.blockedSymbols = Array.isArray(next.blockedSymbols)
      ? next.blockedSymbols.map((s) => String(s).trim()).filter(Boolean)
      : [];

    return next;
  }

  public updateConfig(updates: Partial<DeepSeekAgentConfig>): DeepSeekAgentConfig {
    const current = this.getConfig();
    const next: DeepSeekAgentConfig = this.normaliseConfig({ ...current, ...updates });

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
      tokenUsage: this.buildTokenUsage(cfg, decisions[0]),
      config: cfg,
    };
  }

  /** Compact view injected into /api/bot/status (no decision payload bloat). */
  public getStatusSummary(): Omit<DeepSeekAgentStatus, 'decisions'> {
    const { decisions, ...rest } = this.getStatus();
    return { ...rest, lastDecision: decisions[0] };
  }

  // ------------------------------------------------------------- token usage ---

  /**
   * Persist the consumption of one (or several) API calls. Written straight to the config
   * store so it survives restarts and is visible in the DeepSeek tab.
   */
  private recordTokenUsage(part: {
    promptTokens: number;
    cachedPromptTokens: number;
    completionTokens: number;
    latencyMs: number;
  }): DeepSeekUsageStats {
    const cfg = this.getConfig();
    const prev = cfg.usage || emptyUsageStats();
    const costUSD = computeDeepSeekCostUSD(part, cfg);
    const next: DeepSeekUsageStats = {
      apiCalls: prev.apiCalls + 1,
      promptTokens: prev.promptTokens + Math.max(0, part.promptTokens || 0),
      cachedPromptTokens: prev.cachedPromptTokens + Math.max(0, part.cachedPromptTokens || 0),
      completionTokens: prev.completionTokens + Math.max(0, part.completionTokens || 0),
      costUSD: Math.round((prev.costUSD + costUSD) * 1e6) / 1e6,
      lastCallAt: Date.now(),
      lastPromptTokens: Math.max(0, part.promptTokens || 0),
      lastCompletionTokens: Math.max(0, part.completionTokens || 0),
      lastLatencyMs: Math.max(0, part.latencyMs || 0),
      lastCostUSD: costUSD,
    };
    this.configStore.save({ ...cfg, usage: next });
    this.configStore.flushSync();
    return next;
  }

  /** Actual counters + a forward estimate at the configured cadence. */
  private buildTokenUsage(
    cfg: DeepSeekAgentConfig,
    last?: DeepSeekAgentDecision
  ): DeepSeekTokenUsage {
    const stats = cfg.usage || emptyUsageStats();
    // Prefer the size measured on the last cycle; fall back to the system prompt plus a
    // typical context so the tab shows something before the first real call.
    const estimatedPromptTokensPerCycle =
      Number(last?.estimatedPromptTokens) ||
      Number(last?.promptTokens) ||
      estimateTokensFromText(SYSTEM_PROMPT) + 1200;
    const estimatedCompletionTokensPerCycle =
      Number(last?.completionTokens) || Math.min(Math.max(200, cfg.maxTokens), 900);
    const estimatedCostPerCycleUSD = computeDeepSeekCostUSD(
      {
        promptTokens: estimatedPromptTokensPerCycle,
        cachedPromptTokens: Number(last?.cachedPromptTokens) || 0,
        completionTokens: estimatedCompletionTokensPerCycle,
      },
      cfg
    );
    const cyclesPerDay = Math.round((86_400 / clamp(cfg.runIntervalSec, 60, 3600)) * 10) / 10;

    return {
      apiCalls: stats.apiCalls,
      promptTokens: stats.promptTokens,
      cachedPromptTokens: stats.cachedPromptTokens,
      completionTokens: stats.completionTokens,
      totalTokens: stats.promptTokens + stats.completionTokens,
      costUSD: stats.costUSD,
      lastCallAt: stats.lastCallAt,
      lastPromptTokens: stats.lastPromptTokens || 0,
      lastCompletionTokens: stats.lastCompletionTokens || 0,
      lastLatencyMs: stats.lastLatencyMs || 0,
      lastCostUSD: stats.lastCostUSD || 0,
      estimatedPromptTokensPerCycle,
      estimatedCompletionTokensPerCycle,
      estimatedCostPerCycleUSD,
      cyclesPerDay,
      estimatedCostPerDayUSD: Math.round(estimatedCostPerCycleUSD * cyclesPerDay * 1e4) / 1e4,
      estimatedCostPerMonthUSD: Math.round(estimatedCostPerCycleUSD * cyclesPerDay * 30 * 1e4) / 1e4,
      pricePer1MInputUSD: cfg.pricePer1MInputUSD,
      pricePer1MInputCachedUSD: cfg.pricePer1MInputCachedUSD,
      pricePer1MOutputUSD: cfg.pricePer1MOutputUSD,
    };
  }

  // --------------------------------------------------------------- context ---

  private buildContext(cfg: DeepSeekAgentConfig): BuiltContext {
    const snapshot = this.deps.getAccountSnapshot();
    const agentRows = this.lastOwnScan;
    const useOwnScan = Boolean(cfg.ownUniverseScan && agentRows);
    const allOpportunities = useOwnScan
      ? agentRows!
      : this.deps.getNativeGridOpportunities() || [];
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

    // Eligible + budget-fitting first; AGENT rows are ranked by crossings/hour.
    const sorted = [...allOpportunities].sort((a, b) => {
      if (a.isEligible !== b.isEligible) return a.isEligible ? -1 : 1;
      if (useOwnScan) return (b.crossingsPerHour || 0) - (a.crossingsPerHour || 0);
      return (b.suitabilityScore || 0) - (a.suitabilityScore || 0);
    });
    const shortlist = sorted
      .filter((o) => isSymbolAllowed(o.instId))
      .slice(0, cfg.maxOpportunitiesInPrompt);

    // Confirmation state for this cycle. `null` on a candidate means the gate does not apply
    // (own scan off), never "not confirmed".
    const confirmState = this.lastConfirmation;
    const confirmedIds = new Set(confirmState?.confirmed || []);
    const notConfirmedReasons = new Map(
      (confirmState?.pending || []).map((p) => [p.instId, p.reason])
    );

    const candidates = shortlist.map((o) => ({
      instId: o.instId,
      base: o.instId.split('-')[0],
      price: rnd(o.price, 6),
      score: o.suitabilityScore,
      scan: o.agentScan ? 'AGENT' : 'APP',
      crossings_per_h: o.crossingsPerHour ?? null,
      round_trips_per_h: o.roundTripsPerHour ?? null,
      expected_first_fill_min: o.expectedFirstFillMin ?? null,
      step_pct: o.stepPct ?? null,
      spread_of_step: o.stepPct ? rnd((o.spreadBps || 0) / 100 / o.stepPct, 3) : null,
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
      // Margin we will actually send: deterministic, sized from the lot estimate,
      // capped by the budget.
      sz_usdt: resolveOpenSize(0, o.minInvestmentUSDT, cfg.budgetPerBotUSDT).sz,
      margin_usage_pct: rnd(
        (resolveOpenSize(0, o.minInvestmentUSDT, cfg.budgetPerBotUSDT).sz /
          Math.max(1, cfg.budgetPerBotUSDT)) *
          100,
        1
      ),
      net_per_grid_pct: rnd(o.estimatedNetProfitPerGridPct, 3),
      daily_yield_pct: rnd(o.estimatedDailyNetYieldPct, 3),
      eligible: o.isEligible,
      reason_if_not: o.isEligible ? undefined : o.rejectionReason,
      // The two-look gate. `null` = not applicable this cycle.
      confirmed: confirmState ? confirmedIds.has(o.instId) : null,
      confirm_hint:
        confirmState && !confirmedIds.has(o.instId)
          ? notConfirmedReasons.get(o.instId) || 'neconfirmat'
          : undefined,
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
      scan_source: useOwnScan ? 'AGENT' : 'APP',
      scan_note: useOwnScan
        ? 'Candidates come from the agent own scan: rank by crossings_per_h, ignore score.'
        : 'Legacy mode: candidates come from the app scanner (suitability score).',
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
        min_crossings_per_h: cfg.minCrossingsPerHour,
        min_net_profit_per_grid_pct: cfg.minNetProfitPerGridPct,
        daily_loss_limit_usdt: cfg.dailyLossLimitUSDT,
        max_total_margin_usdt: cfg.maxTotalMarginUSDT,
        sizing_note:
          'Use each candidate sz_usdt verbatim: it is the deterministic margin (sized for one lot per level, capped by budget_per_bot_usdt). min_inv_usdt is a local estimate, not an OKX limit.',
        sl_unit_note:
          'stopLossPct is in % of INVESTED MARGIN, not % of price: at leverage L a 1% adverse price move costs L% of margin. It is floored at L x half_band_pct (one full walk to the band edge) and capped at hard_stop_loss_pct; lever itself is capped at hard_stop_loss_pct / half_band_pct. Do not fight those clamps.',
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
    // 1. Fresh candidates. With ownUniverseScan the agent scans the OKX universe itself
    //    (crossings/hour); the app scanner is not consulted at all (no scoring, no ranking).
    const useOwnScan = Boolean(cfg.ownUniverseScan && this.deps.scanAgentUniverse);
    this.lastOwnScan = undefined;
    if (useOwnScan) {
      try {
        const rows = await this.deps.scanAgentUniverse!({
          deepScanCount: cfg.universeScanSize,
          budgetPerBotUSDT: cfg.budgetPerBotUSDT,
          maxLeverage: cfg.maxLeverage,
          hardStopLossPct: cfg.hardStopLossPct,
          universeScanMode: cfg.universeScanMode,
          poolSize: cfg.poolSize,
          poolRefreshMinutes: cfg.poolRefreshMinutes,
        });
        this.lastOwnScan = rows;
        const top = rows
          .filter((r) => r.isEligible)
          .slice(0, 3)
          .map((r) => `${r.instId}=${r.crossingsPerHour}/h`)
          .join(', ');
        this.deps.logAudit(
          'UNIVERSE_REFRESH',
          `[DEEPSEEK AGENT] Scan propriu: ${rows.length} contracte analizate, ${rows.filter((r) => r.isEligible).length} eligibile. Top: ${top || 'niciunul'}`,
          { deepScanCount: rows.length, eligible: rows.filter((r) => r.isEligible).length }
        );
      } catch (err: any) {
        // Fail closed: an empty own scan means HOLD, never a silent fall back to app scores.
        this.lastOwnScan = [];
        this.deps.logAudit(
          'AGENT_ERROR',
          `[DEEPSEEK AGENT] Scanul propriu a eșuat: ${err?.message || err}. Ciclul lucrează fără candidați.`
        );
      }
    }

    // 1b. Two-look confirmation. A candidate may only be opened if the scanner qualified it on
    //     its last TWO looks at that contract (see agentScanConfirmation.ts for why "two looks"
    //     and not "two consecutive cycles": the scan window rotates, so most contracts are not
    //     measured every cycle and a cycle-id rule could never confirm anything).
    if (useOwnScan && cfg.requireScanConfirmation) {
      const confCfg = resolveConfirmationConfig({
        topN: cfg.confirmationTopN,
        minNetPerGridPct: cfg.minNetProfitPerGridPct,
        minCrossingsPerHour: cfg.minCrossingsPerHour,
        maxAgeMinutes: cfg.confirmationMaxAgeMinutes,
        minSpacingMinutes: cfg.confirmationMinSpacingMinutes,
        // The memory only has to outlive the pairing window.
        ttlMinutes: Math.max(60, cfg.confirmationMaxAgeMinutes * 2),
      });
      const applied = applyScanToLedger(
        this.scanConfirmation,
        this.lastOwnScan || [],
        confCfg,
        Date.now()
      );
      this.scanConfirmation = applied.ledger;
      this.lastConfirmation = applied;
      const firstPending = applied.pending[0];
      this.deps.logAudit(
        'UNIVERSE_REFRESH',
        `[DEEPSEEK AGENT] Confirmare două scanuri: ${applied.confirmed.length} confirmate, ` +
          `${applied.pending.length} în așteptare` +
          (applied.confirmed.length
            ? ` (${applied.confirmed.slice(0, 3).join(', ')})`
            : firstPending
              ? ` — ex. ${firstPending.instId}: ${firstPending.reason}`
              : '') +
          (applied.forgotten > 0 ? `, ${applied.forgotten} ieșite din memorie` : ''),
        {
          confirmed: applied.confirmed,
          pending: applied.pending.slice(0, 10),
          forgotten: applied.forgotten,
          topN: confCfg.topN,
          maxAgeMinutes: confCfg.maxAgeMinutes,
        }
      );
    } else {
      // Gate off this cycle (no own scan, or the operator disabled it): filter nothing. The
      // ledger is KEPT, so re-enabling does not have to rebuild from zero. A stale entry can
      // never fake a confirmation: `confirmed` is recomputed from scratch on every look.
      this.lastConfirmation = null;
    }

    if (cfg.scanBeforeDecision && !useOwnScan) {
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
    let cachedPromptTokens = 0;
    let completionTokens = 0;
    let estimatedPromptTokens = 0;
    let cycleCostUSD = 0;
    let rawDecision: any = null;
    let decisionError: string | undefined;

    const client = this.buildClient(cfg);
    if (client.isConfigured()) {
      try {
        const systemPrompt = SYSTEM_PROMPT;
        const userPrompt = buildUserPrompt(ctx.promptContext);
        const messages: DeepSeekChatMessage[] = [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ];
        // Measured BEFORE the call, so the estimate never depends on a successful response.
        estimatedPromptTokens = estimateTokensFromText(systemPrompt + userPrompt);
        let res = await client.chat(messages, { jsonMode: true });
        latencyMs = res.latencyMs;
        promptTokens = res.promptTokens;
        cachedPromptTokens = res.cachedPromptTokens;
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
          cachedPromptTokens += repair.cachedPromptTokens;
          completionTokens += repair.completionTokens;
          rawDecision = this.parseModelAnswer(repair.content);
        }

        // Consumption is recorded even when parsing fails afterwards: the tokens were spent.
        cycleCostUSD = this.recordTokenUsage({
          promptTokens,
          cachedPromptTokens,
          completionTokens,
          latencyMs,
        }).lastCostUSD || 0;
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
    const guardrailActions = await this.buildGuardrailStops(cfg, ctx);
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
      cachedPromptTokens: cachedPromptTokens || undefined,
      completionTokens: completionTokens || undefined,
      estimatedPromptTokens: estimatedPromptTokens || undefined,
      costUSD: cycleCostUSD || undefined,
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
    // Owner hard cap on the margin this desk may engage (sum of the agent's own bots).
    let marginUsed = ctx.runningBots.reduce((sum, b) => sum + (Number(b.sz) || 0), 0);
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
        if (candidate.agentScan && this.lastConfirmation) {
          if (!this.lastConfirmation.confirmed.includes(candidate.instId)) {
            const why =
              this.lastConfirmation.pending.find((p) => p.instId === candidate.instId)?.reason ||
              'neconfirmat';
            reject(
              `Candidatul ${candidate.instId} nu are confirmarea pe două scanuri — ${why}. ` +
                'Se poate deschide doar după ce scanul îl califică din nou.'
            );
            continue;
          }
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
        if (candidate.agentScan) {
          const crossings = Number(candidate.crossingsPerHour) || 0;
          if (crossings < cfg.minCrossingsPerHour) {
            reject(
              `Crossings/h ${crossings} sub pragul minim ${cfg.minCrossingsPerHour} pentru ${candidate.instId} (grilă prea deasă sau piață moartă).`
            );
            continue;
          }
        }
        if (!candidate.agentScan && (candidate.suitabilityScore || 0) < cfg.minSuitabilityScore) {
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

        // --- band legality (independent of whatever produced this band) -----
        // The scan places its own band, but the numbers that actually reach the venue are the
        // ones the MODEL wrote into the decision. This re-checks them against the 24 h extremes
        // with `inspectBandLegality`, which deliberately shares no assumptions with the builder
        // in `gridBand.ts` — a shared helper could only prove the builder agrees with itself.
        const bandRefusal = inspectBandLegality({
          price,
          minPx,
          maxPx,
          low24h: candidate.low24h,
          high24h: candidate.high24h,
        });
        if (bandRefusal) {
          reject(`Bandă ilegală: ${bandRefusal}.`);
          continue;
        }

        // --- sizing -------------------------------------------------------
        const gridNum = clamp(Math.round(Number(action.gridNum) || candidate.gridNum || 6), 2, 100);
        // The wider side of the band (they are symmetric, the snap can skew them by a tick).
        const halfRangePct = (Math.max(price - minPx, maxPx - price) / price) * 100;
        const requestedLever = clamp(
          Math.round(Number(action.lever) || candidate.lever || 3),
          1,
          cfg.maxLeverage
        );
        // Leverage cannot exceed what the band+guardrail can survive (see maxLeverageForBand):
        // `stopLossPct` is in % of margin, so at L x a 1% price move costs L% of margin, and a walk
        // to the band edge must stay under `hardStopLossPct`. Without this a 8.85% band opened at
        // 10x is stopped by a single level (11.1% of margin per step vs a 2% stop) - live proof:
        // SOXL/MSTR/LTC/XRP all stopped at a loss 29-40 min after open on 2026-11-10.
        const bandLever = maxLeverageForBand(halfRangePct, cfg.hardStopLossPct, cfg.maxLeverage);
        const lever = Math.min(requestedLever, bandLever);
        if (lever < requestedLever) {
          this.deps.logAudit(
            'CANDIDATE_SELECTED',
            `[DEEPSEEK AGENT] ${candidate.instId}: levier ${requestedLever}x → ${lever}x — banda ±${halfRangePct.toFixed(
              2
            )}% × ${requestedLever}x ar însemna ${(halfRangePct * requestedLever).toFixed(
              1
            )}% din marjă până la marginea benzii, peste stop-ul dur de ${cfg.hardStopLossPct}%.`
          );
        }
        // `minInvestmentUSDT` is the scan's LOCAL estimate of "one lot on every level"
        // (`minLot x gridNum / lever`) — it is NOT an OKX answer, and for an X-Perp grid it is
        // not even applicable: those ids never reach OKX's grid algo gateway (51000/51001), so
        // the grid runs as OUR OWN limit orders. It is therefore a SIZING TARGET, never a floor
        // that can refuse an open: when the budget cannot cover one lot per level, the bot is
        // opened with the budget (levels below a full lot get the minimum lot and the rest of
        // the grid stays virtual).
        const lotEstimate = Math.max(5, Number(candidate.minInvestmentUSDT) || 5);
        // Never trust the model with this number: sz is resolved in cents from the lot estimate
        // and the budget — RAISED to the estimate when that fits, capped at the budget otherwise.
        const sizePlan = resolveOpenSize(Number(action.sz), lotEstimate, cfg.budgetPerBotUSDT);
        const sz = sizePlan.sz;
        if (lotEstimate > sz + 0.001) {
          // Advisory only. Rejecting on this number is what deleted exactly the contracts that
          // fit (the estimate is a local guess: ETH at 8 grids / 10x estimated $14.55 while OKX
          // ran that geometry on $5.00).
          this.deps.logAudit(
            'CANDIDATE_SELECTED',
            `[DEEPSEEK AGENT] ${candidate.instId}: estimare locală "1 lot pe fiecare nivel" ` +
              `$${lotEstimate.toFixed(2)} > marja $${sz.toFixed(2)} @ ${lever}x — se deschide cu marja ` +
              `bugetului (${cfg.budgetPerBotUSDT}$), nu se refuză: nivelurile care nu încap pe un lot ` +
              `se plasează cu lotul minim, restul grilei rămâne virtual.`
          );
        }
        if (sizePlan.raised) {
          this.deps.logAudit(
            'CANDIDATE_SELECTED',
            `[DEEPSEEK AGENT] sz rezolvat determinist pe ${candidate.instId}: model $${Number(action.sz).toFixed(
              2
            )} → $${sz.toFixed(2)} (estimare 1 lot/nivel $${lotEstimate.toFixed(2)}, buget $${cfg.budgetPerBotUSDT}).`
          );
        }
        if (marginUsed + sz > cfg.maxTotalMarginUSDT) {
          reject(
            `Marja totală ar depăși limita de ${cfg.maxTotalMarginUSDT}$ (folosită ${rnd(marginUsed)}$, necesar ${rnd(sz)}$).`
          );
          continue;
        }
        if (spendable < sz) {
          reject(
            `Fond liber insuficient după rezerva de ${cfg.minReserveUSDT}$ (disponibil ${rnd(spendable)}$, necesar ${rnd(sz)}$).`
          );
          continue;
        }

        const stopLossPct = gridStopLossPct(
          halfRangePct,
          lever,
          Number(action.stopLossPct) || 0,
          cfg.hardStopLossPct
        );
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
          szRequested: sizePlan.raised ? rnd(Number(action.sz)) : undefined,
          stopLossPct,
          takeProfitPct,
          rangeVariant: action.rangeVariant || candidate.selectedVariant,
          rationale_ro: action.rationale_ro,
        });
        slotsLeft--;
        spendable -= sz;
        marginUsed += sz;
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
  private async buildGuardrailStops(
    cfg: DeepSeekAgentConfig,
    ctx: BuiltContext
  ): Promise<DeepSeekAgentAction[]> {
    if (!cfg.enforceHardGuardrails || !cfg.allowStopBots) return [];
    const out: DeepSeekAgentAction[] = [];

    for (const bot of ctx.runningBots) {
      const reasons: string[] = [];
      const pnlPct = bot.sz > 0 ? (bot.totalPnl / bot.sz) * 100 : 0;
      if (pnlPct <= -Math.abs(cfg.hardStopLossPct)) {
        reasons.push(`PnL ${rnd(pnlPct)}% ≤ -${cfg.hardStopLossPct}% din marjă`);
      }
      const distLiq = bot.liqPx > 0 ? pctDistance(bot.currentPx, bot.liqPx) : null;
      const minLiqDistancePct = effectiveMinLiqDistancePct(cfg.hardMinLiqDistancePct, bot.lever);
      if (distLiq !== null && distLiq <= minLiqDistancePct) {
        reasons.push(`distanță lichidare ${rnd(distLiq, 1)}% ≤ ${rnd(minLiqDistancePct, 1)}%`);
      }
      const outsideRange =
        bot.currentPx > 0 &&
        ((bot.minPx > 0 && bot.currentPx < bot.minPx) || (bot.maxPx > 0 && bot.currentPx > bot.maxPx));
      if (outsideRange) {
        reasons.push(`preț ${rnd(bot.currentPx, 6)} în afara range-ului [${rnd(bot.minPx, 6)}, ${rnd(bot.maxPx, 6)}]`);
      }
      const ageMin = Math.max(0, Math.round((Date.now() - (bot.cTime || Date.now())) / 60000));
      // --- stagnation rule -------------------------------------------------
      // Silence alone never stops a bot. We re-read the CURRENT tape, compare the elapsed
      // time with the expected time to reach the next level, and require that the grid can
      // no longer be reached. A bot that is not losing money is left alone: killing a
      // profitable grid because it has not filled yet is pure churn (28 such stops in one
      // night, all with real arbitrages already booked).
      const pnlGate = cfg.stopIfPassive ? bot.totalPnl <= 0 : bot.totalPnl < 0;
      if (bot.arbitrageNum === 0 && pnlGate) {
        const stepPct = botGridStepPct(bot);
        const activity = this.deps.getMarketActivity
          ? await this.deps.getMarketActivity(bot.instId).catch(() => null)
          : null;

        if (!activity) {
          // No live data => very conservative: only a clearly stale bot is stopped.
          const fallbackDeadline = Math.max(cfg.hardMaxNoFillMinutes, 180);
          if (ageMin >= fallbackDeadline) {
            reasons.push(
              `0 arbitraje in ${ageMin} min (prag ${fallbackDeadline} min, fara date live de piata), PnL ${rnd(bot.totalPnl)} USDT`
            );
          }
        } else if (stepPct > 0) {
          const speedPctPerHour = Math.max(
            activity.pathPerHourPct * 0.5,
            activity.atrPct * 0.35,
            0.0001
          );
          const expectedFirstFillMin = (60 * (stepPct / 2)) / speedPctPerHour;
          const crossingsPerHour = activity.pathPerHourPct / stepPct;
          const deadlineMin = Math.max(
            cfg.hardMaxNoFillMinutes,
            Math.round(expectedFirstFillMin * 2.5)
          );
          const tapeDead = crossingsPerHour < 0.5; // < 1 touch per 2 hours
          if (ageMin >= deadlineMin && tapeDead) {
            reasons.push(
              `0 arbitraje in ${ageMin} min; crossings/h=${rnd(crossingsPerHour, 2)} pe un pas de ${rnd(stepPct, 3)}% ` +
                `(prima umplere estimata ~${rnd(expectedFirstFillMin, 0)} min, termen ${deadlineMin} min) - banda nu mai poate fi atinsa, PnL ${rnd(bot.totalPnl)} USDT`
            );
          }
        }
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
    // Same two-look gate the validator enforces, applied here too so the fallback engine does
    // not spend its limited actions on candidates that would only be rejected.
    const confirmedIds = new Set(this.lastConfirmation?.confirmed || []);
    const confirmationApplies = (c: { instId: string; agentScan?: boolean }) =>
      !this.lastConfirmation || !c.agentScan || confirmedIds.has(c.instId);

    if (cfg.allowOpenBots) {
      const agentRanked = ctx.candidates.some((c) => c.agentScan);
      const pool = ctx.candidates
        .filter(
          (c) =>
            c.isEligible &&
            confirmationApplies(c) &&
            !runningIds.has(c.instId) &&
            (c.agentScan
              ? (Number(c.crossingsPerHour) || 0) >= cfg.minCrossingsPerHour
              : c.suitabilityScore >= cfg.minSuitabilityScore) &&
            c.estimatedNetProfitPerGridPct >= cfg.minNetProfitPerGridPct
        )
        .sort((a, b) =>
          agentRanked
            ? (b.crossingsPerHour || 0) - (a.crossingsPerHour || 0)
            : b.suitabilityScore - a.suitabilityScore
        )
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
          sz: resolveOpenSize(cfg.budgetPerBotUSDT, cand.minInvestmentUSDT, cfg.budgetPerBotUSDT).sz,
          stopLossPct: 8,
          takeProfitPct: 15,
          rangeVariant: cand.selectedVariant,
          rationale_ro: `Fallback determinist TB5: ${cand.instId} ${cand.agentScan ? `crossings/h ${cand.crossingsPerHour}, prima umplere ~${cand.expectedFirstFillMin} min` : `scor ${cand.suitabilityScore}/100`}, regim ${cand.regimeLabel}, profit net ${rnd(cand.estimatedNetProfitPerGridPct, 3)}%/grilă.`,
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
   * Every open the agent performs goes out as OUR OWN limit orders. Native `contract_grid`
   * creation is not attempted anywhere any more: OKX EEA answers 51000/51001 for every
   * `_UM_XPERP` id, which is the only instrument family this desk trades. The variant is
   * therefore a constant, not a decision - and `preferNativeAlgo` can no longer change it.
   */

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
          executionVariant: 'AUTO_LIMIT',
          environment: 'LIVE',
          explicitLiveConfirm: true,
        });
        const algoId = res?.bot?.algoId;
        // The engine may raise sz to OKX's LIVE minimum for this exact geometry (a tighter
        // range with 4 grids needs more margin than the scan's estimate). Report what was
        // ACTUALLY sent, never the approved request: the old message printed "$7.31" while
        // OKX received $11.92, which is what made the rejection look inexplicable.
        const sentSz = Number(res?.bot?.sz) > 0 ? Number(res.bot.sz) : Number(action.sz);
        const raiseNotes: string[] = [];
        if (action.szRequested && Math.abs(action.szRequested - action.sz) > 0.001) {
          raiseNotes.push(`model $${rnd(action.szRequested)} → $${rnd(action.sz)}`);
        }
        if (sentSz > action.sz + 0.001) {
          raiseNotes.push(
            `$${rnd(action.sz)} → $${rnd(sentSz)} (minim OKX pentru ${action.gridNum} grile la ${action.lever}x)`
          );
        }
        const adjusted = raiseNotes.length > 0 ? ` — marjă ridicată: ${raiseNotes.join(', ')}` : '';
        const message = res?.success
          ? `Bot deschis pe ${action.instId} ($${rnd(sentSz)} @ ${action.lever}x, ${action.gridNum} grile)${adjusted}${algoId ? ` — algoId ${algoId}` : ''}.`
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
      tokens: {
        prompt: decision.promptTokens,
        cached: decision.cachedPromptTokens,
        completion: decision.completionTokens,
        estimatedPrompt: decision.estimatedPromptTokens,
        costUSD: decision.costUSD,
      },
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
