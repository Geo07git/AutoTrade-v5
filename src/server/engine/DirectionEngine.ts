import WebSocket from 'ws';
import {
  DirectionAssessment,
  Kline,
  OrderFlowMetrics,
  OrderFlowRegime,
  OrderSide,
} from '../../shared/types';

interface MicroTradeTick {
  ts: number;
  px: number;
  sz: number;
  notionalUsdt: number;
  side: 'buy' | 'sell'; // Taker (aggressor) side reported by OKX
}

interface OrderBookLevel {
  px: number;
  sz: number;
  numOrders: number;
}

interface OrderBookSnapshot {
  ts: number;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
}

interface OpenInterestPoint {
  ts: number;
  oiCcy: number; // Open interest in base currency / contracts
  oiUsd: number;
}

interface LiquidationEvent {
  ts: number;
  px: number;
  sz: number;
  usdValue: number;
  side: 'SHORT_LIQ' | 'LONG_LIQ'; // SHORT_LIQ = forced buy (short squeeze), LONG_LIQ = forced sell (long flush)
}

interface SymbolMicrostructureBuffer {
  instId: string;
  trades: MicroTradeTick[];
  orderBook?: OrderBookSnapshot;
  oiHistory: OpenInterestPoint[];
  liquidations: LiquidationEvent[];
  ctVal: number;
  lastWarmupTs: number;
  lastBookFetchTs: number;
  lastOiFetchTs: number;
}

/**
 * DirectionEngine.ts
 * ------------------
 * Real-Time Order Flow & Market Microstructure Engine for SCALP (5–15m horizon).
 *
 * Replaces lagging technical indicators with 6 real-time market behavior pillars from OKX v5:
 *  1. Aggressive Buy/Sell Volume (Taker Imbalance Ratio & Whale Prints)
 *  2. Cumulative Volume Delta (CVD Slope, Net Delta USDT & Price-CVD Divergence)
 *  3. Distance-Weighted & Anti-Spoof L2 Order Book Imbalance (OBI)
 *  4. Trade Flow Velocity & Acceleration (Tape Speed / Ticket Arrival Intensity)
 *  5. Passive Absorption Detector (Effort vs. Result at Key Levels)
 *  6. Open Interest Delta (ΔOI) & Forced Liquidations (Short Squeeze / Long Flush Matrix)
 */
export class DirectionEngine {
  private buffers: Map<string, SymbolMicrostructureBuffer> = new Map();
  private trackedSymbols: Set<string> = new Set();
  private wsPublic?: WebSocket;
  private pingInterval?: NodeJS.Timeout;
  private oiPollInterval?: NodeJS.Timeout;
  private isWsConnected: boolean = false;
  private restBaseUrl: string = 'https://eea.okx.com';
  private wsBaseUrl: string = 'wss://wseea.okx.com:8443/ws/v5/public';

  private readonly MAX_TRACKED_SYMBOLS = 30;
  private readonly TRADE_WINDOW_MS = 15 * 60 * 1000; // 15 minutes rolling ring-buffer retention
  private readonly EVAL_WINDOW_MS = 5 * 60 * 1000;   // Uniform 300s (5m) time window for all symbol metrics
  private readonly MAX_TRADES_PER_SYMBOL = 5000;     // Memory safety cap only (window is strictly time-based)
  private readonly WARMUP_TTL_MS = 12_000;           // Minimum 12s between REST trade/book refreshes per symbol
  private readonly OI_TTL_MS = 45_000;               // 45s TTL for Open Interest snapshots

  constructor(region: 'EEA' | 'GLOBAL' | 'AUTO' = 'AUTO') {
    // Default to OKX EEA endpoints (since X-Perp _UM_XPERP instruments live on eea.okx.com),
    // with automatic fallback to www.okx.com in fetchPublicJson.
    if (region === 'GLOBAL') {
      this.restBaseUrl = 'https://www.okx.com';
      this.wsBaseUrl = 'wss://ws.okx.com:8443/ws/v5/public';
    } else {
      this.restBaseUrl = 'https://eea.okx.com';
      this.wsBaseUrl = 'wss://wseea.okx.com:8443/ws/v5/public';
    }
    this.initWebSocket();
  }

  public normalizeSymbol(symbol: string): string {
    if (!symbol) return '';
    const clean = symbol.trim().toUpperCase();
    if (clean.endsWith('-SWAP') || clean.includes('_UM_XPERP')) return clean;
    if (clean.includes('-')) return `${clean}-SWAP`;
    if (clean.endsWith('USDT')) {
      return `${clean.replace(/USDT$/, '')}-USDT-SWAP`;
    }
    return `${clean}-USDT-SWAP`;
  }

  private getOrCreateBuffer(symbol: string, ctVal: number = 1): SymbolMicrostructureBuffer {
    const instId = this.normalizeSymbol(symbol);
    let buf = this.buffers.get(instId);
    if (!buf) {
      buf = {
        instId,
        trades: [],
        oiHistory: [],
        liquidations: [],
        ctVal: ctVal > 0 ? ctVal : 1,
        lastWarmupTs: 0,
        lastBookFetchTs: 0,
        lastOiFetchTs: 0,
      };
      this.buffers.set(instId, buf);
    } else if (ctVal > 0 && buf.ctVal === 1 && ctVal !== 1) {
      buf.ctVal = ctVal;
    }
    return buf;
  }

  /**
   * Initializes dedicated public WebSocket connection for real-time Order Flow (`trades`, `books5`, `liquidation-orders`).
   */
  public initWebSocket() {
    if (this.wsPublic) return;

    try {
      this.wsPublic = new WebSocket(this.wsBaseUrl);

      this.wsPublic.on('open', () => {
        this.isWsConnected = true;

        if (this.pingInterval) clearInterval(this.pingInterval);
        this.pingInterval = setInterval(() => {
          if (this.wsPublic && this.wsPublic.readyState === WebSocket.OPEN) {
            try {
              this.wsPublic.send('ping');
            } catch {}
          }
        }, 20_000);

        // Subscribe to global SWAP and FUTURES liquidation-orders streams
        try {
          this.wsPublic.send(
            JSON.stringify({
              op: 'subscribe',
              args: [
                { channel: 'liquidation-orders', instType: 'SWAP' },
                { channel: 'liquidation-orders', instType: 'FUTURES' },
              ],
            })
          );
        } catch {}

        // Subscribe to currently tracked symbols
        if (this.trackedSymbols.size > 0) {
          this.sendWsSubscriptions(Array.from(this.trackedSymbols), 'subscribe');
        }
      });

      this.wsPublic.on('message', (data: WebSocket.Data) => {
        const text = data.toString();
        if (text === 'pong') return;

        try {
          const parsed = JSON.parse(text);
          const channel = parsed?.arg?.channel;
          const instId = parsed?.arg?.instId;

          if (channel === 'trades' && instId && Array.isArray(parsed.data)) {
            this.handleWsTrades(instId, parsed.data);
          } else if (channel === 'books5' && instId && Array.isArray(parsed.data)) {
            this.handleWsBooks5(instId, parsed.data);
          } else if (channel === 'liquidation-orders' && Array.isArray(parsed.data)) {
            this.handleWsLiquidations(parsed.data);
          }
        } catch {}
      });

      this.wsPublic.on('close', () => {
        this.isWsConnected = false;
        setTimeout(() => {
          if (!this.wsPublic || this.wsPublic.readyState === WebSocket.CLOSED) {
            this.wsPublic = undefined;
            this.initWebSocket();
          }
        }, 4000);
      });

      this.wsPublic.on('error', () => {
        // Fallback between EEA and Global WS if one fails
        if (this.wsBaseUrl.includes('wseea')) {
          this.wsBaseUrl = 'wss://ws.okx.com:8443/ws/v5/public';
        }
      });

      // Background Open Interest delta poller for tracked top symbols every 45s
      if (this.oiPollInterval) clearInterval(this.oiPollInterval);
      this.oiPollInterval = setInterval(() => {
        this.pollTrackedOpenInterest().catch(() => {});
      }, 45_000);
    } catch {}
  }

  private sendWsSubscriptions(instIds: string[], op: 'subscribe' | 'unsubscribe') {
    if (!this.wsPublic || this.wsPublic.readyState !== WebSocket.OPEN || instIds.length === 0) return;

    const args: any[] = [];
    for (const instId of instIds) {
      args.push({ channel: 'trades', instId });
      args.push({ channel: 'books5', instId });
    }

    try {
      this.wsPublic.send(JSON.stringify({ op, args }));
    } catch {}
  }

  /**
   * Dynamically updates the Funnel Stage-2 tracked symbols (Top candidates + Open Positions).
   * Automatically subscribes new symbols and unsubscribes stale symbols to keep WS & memory lean.
   */
  public updateTrackedSymbols(symbols: string[], ctValResolver?: (sym: string) => number) {
    const normalized = Array.from(
      new Set(symbols.map((s) => this.normalizeSymbol(s)).filter(Boolean))
    ).slice(0, this.MAX_TRACKED_SYMBOLS);

    const nextSet = new Set(normalized);
    const toSubscribe: string[] = [];
    const toUnsubscribe: string[] = [];

    for (const instId of nextSet) {
      if (ctValResolver) {
        const ctVal = ctValResolver(instId);
        if (ctVal > 0) this.getOrCreateBuffer(instId, ctVal);
      } else {
        this.getOrCreateBuffer(instId);
      }
      if (!this.trackedSymbols.has(instId)) {
        toSubscribe.push(instId);
      }
    }

    for (const oldInstId of this.trackedSymbols) {
      if (!nextSet.has(oldInstId)) {
        toUnsubscribe.push(oldInstId);
      }
    }

    this.trackedSymbols = nextSet;

    if (toUnsubscribe.length > 0) {
      this.sendWsSubscriptions(toUnsubscribe, 'unsubscribe');
    }
    if (toSubscribe.length > 0) {
      this.sendWsSubscriptions(toSubscribe, 'subscribe');
    }
  }

  private handleWsTrades(instId: string, rawTrades: any[]) {
    const buf = this.getOrCreateBuffer(instId);
    const now = Date.now();

    for (const t of rawTrades) {
      const px = parseFloat(t.px || '0');
      const sz = parseFloat(t.sz || '0');
      const ts = parseInt(t.ts || now.toString(), 10);
      const side: 'buy' | 'sell' = String(t.side).toLowerCase() === 'sell' ? 'sell' : 'buy';
      if (px > 0 && sz > 0) {
        const notionalUsdt = px * sz * (buf.ctVal || 1);
        buf.trades.push({ ts, px, sz, notionalUsdt, side });
      }
    }

    this.pruneBuffer(buf, now);
  }

  private handleWsBooks5(instId: string, rawBooks: any[]) {
    if (!rawBooks || rawBooks.length === 0) return;
    const buf = this.getOrCreateBuffer(instId);
    const b = rawBooks[0];
    const ts = parseInt(b.ts || Date.now().toString(), 10);

    const parseLevels = (arr: any[]): OrderBookLevel[] =>
      (arr || [])
        .map((lvl: any[]) => ({
          px: parseFloat(lvl[0] || '0'),
          sz: parseFloat(lvl[1] || '0'),
          numOrders: parseInt(lvl[3] || '1', 10) || 1,
        }))
        .filter((l) => l.px > 0 && l.sz > 0);

    const top5Bids = parseLevels(b.bids);
    const top5Asks = parseLevels(b.asks);

    // If we already have a deeper 20-level book from recent REST warm-up, merge fresh top-5 with deeper levels 6..20
    if (buf.orderBook && buf.orderBook.bids.length > 5 && ts - buf.lastBookFetchTs < 30_000) {
      const minTop5BidPx = top5Bids.length > 0 ? top5Bids[top5Bids.length - 1].px : 0;
      const maxTop5AskPx = top5Asks.length > 0 ? top5Asks[top5Asks.length - 1].px : Infinity;
      const deeperBids = buf.orderBook.bids.filter((l) => l.px < minTop5BidPx).slice(0, 15);
      const deeperAsks = buf.orderBook.asks.filter((l) => l.px > maxTop5AskPx).slice(0, 15);
      buf.orderBook = {
        ts,
        bids: [...top5Bids, ...deeperBids],
        asks: [...top5Asks, ...deeperAsks],
      };
    } else {
      buf.orderBook = { ts, bids: top5Bids, asks: top5Asks };
    }
  }

  private handleWsLiquidations(rawData: any[]) {
    const now = Date.now();
    for (const item of rawData) {
      const instId = this.normalizeSymbol(item.instId || '');
      if (!instId) continue;
      const buf = this.buffers.get(instId);
      if (!buf) continue;

      const details = Array.isArray(item.details) ? item.details : [item];
      for (const d of details) {
        const px = parseFloat(d.bkPx || d.px || '0');
        const sz = parseFloat(d.sz || '0');
        const ts = parseInt(d.ts || now.toString(), 10);
        if (px <= 0 || sz <= 0) continue;

        // In OKX liquidation-orders:
        // posSide === 'short' or side === 'buy' means a Short position was forcibly bought back (Short Squeeze)
        const posSide = String(d.posSide || '').toLowerCase();
        const sideStr = String(d.side || '').toLowerCase();
        const isShortLiq = posSide === 'short' || sideStr === 'buy';
        const usdValue = px * sz * (buf.ctVal || 1);

        buf.liquidations.push({
          ts,
          px,
          sz,
          usdValue,
          side: isShortLiq ? 'SHORT_LIQ' : 'LONG_LIQ',
        });
      }
      this.pruneBuffer(buf, now);
    }
  }

  private pruneBuffer(buf: SymbolMicrostructureBuffer, now: number) {
    const cutoff = now - this.TRADE_WINDOW_MS;
    const firstValidIdx = buf.trades.findIndex((t) => t.ts >= cutoff);
    if (firstValidIdx > 0) {
      buf.trades = buf.trades.slice(firstValidIdx);
    } else if (firstValidIdx === -1 && buf.trades.length > 0) {
      buf.trades = [];
    }
    // Apply 5000-tick cap strictly as a memory safety ceiling after time-window pruning
    if (buf.trades.length > this.MAX_TRADES_PER_SYMBOL) {
      buf.trades = buf.trades.slice(-this.MAX_TRADES_PER_SYMBOL);
    }

    buf.liquidations = buf.liquidations.filter((l) => l.ts >= cutoff);
    buf.oiHistory = buf.oiHistory.filter((o) => o.ts >= now - 30 * 60 * 1000);
  }

  private async fetchPublicJson(path: string, timeoutMs: number = 3500): Promise<any> {
    const urls = [
      `${this.restBaseUrl}${path}`,
      `${this.restBaseUrl.includes('eea') ? 'https://www.okx.com' : 'https://eea.okx.com'}${path}`,
    ];
    for (const url of urls) {
      try {
        const res = await fetch(url, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.ok) {
          const json: any = await res.json();
          if (json && json.code === '0') return json;
        }
      } catch {}
    }
    return null;
  }

  /**
   * Instant REST Warm-up for a candidate symbol so DirectionEngine has immediate
   * 100-tick trade history, 20-level L2 Order Book (with numOrders), and Open Interest.
   */
  public async warmupSymbol(symbol: string, ctVal: number = 1): Promise<void> {
    const instId = this.normalizeSymbol(symbol);
    const buf = this.getOrCreateBuffer(instId, ctVal);
    const now = Date.now();

    const needsTrades = buf.trades.length < 40 || now - buf.lastWarmupTs > this.WARMUP_TTL_MS;
    const needsBook = !buf.orderBook || buf.orderBook.bids.length < 5 || now - buf.lastBookFetchTs > this.WARMUP_TTL_MS;
    const needsOi = buf.oiHistory.length === 0 || now - buf.lastOiFetchTs > this.OI_TTL_MS;

    const tasks: Promise<void>[] = [];

    if (needsTrades) {
      buf.lastWarmupTs = now;
      tasks.push(
        (async () => {
          const json = await this.fetchPublicJson(`/api/v5/market/trades?instId=${instId}&limit=500`, 3500);
          if (json && Array.isArray(json.data) && json.data.length > 0) {
            const existingMaxTs = buf.trades.length > 0 ? buf.trades[buf.trades.length - 1].ts : 0;
            // OKX returns newest first; reverse to chronological order
            const incoming = [...json.data].reverse();
            for (const t of incoming) {
              const ts = parseInt(t.ts || '0', 10);
              const px = parseFloat(t.px || '0');
              const sz = parseFloat(t.sz || '0');
              if (ts > existingMaxTs && px > 0 && sz > 0) {
                const side: 'buy' | 'sell' = String(t.side).toLowerCase() === 'sell' ? 'sell' : 'buy';
                buf.trades.push({
                  ts,
                  px,
                  sz,
                  notionalUsdt: px * sz * (buf.ctVal || 1),
                  side,
                });
              }
            }
            this.pruneBuffer(buf, now);
          }
        })()
      );
    }

    if (needsBook) {
      buf.lastBookFetchTs = now;
      tasks.push(
        (async () => {
          const json = await this.fetchPublicJson(`/api/v5/market/books?instId=${instId}&sz=20`, 3500);
          if (json && Array.isArray(json.data) && json.data.length > 0) {
            const b = json.data[0];
            const parseLevels = (arr: any[]): OrderBookLevel[] =>
              (arr || [])
                .map((lvl: any[]) => ({
                  px: parseFloat(lvl[0] || '0'),
                  sz: parseFloat(lvl[1] || '0'),
                  numOrders: parseInt(lvl[3] || '1', 10) || 1,
                }))
                .filter((l) => l.px > 0 && l.sz > 0);

            buf.orderBook = {
              ts: parseInt(b.ts || now.toString(), 10),
              bids: parseLevels(b.bids),
              asks: parseLevels(b.asks),
            };
          }
        })()
      );
    }

    if (needsOi) {
      buf.lastOiFetchTs = now;
      tasks.push(this.fetchOpenInterestForBuffer(buf));
    }

    if (tasks.length > 0) {
      await Promise.allSettled(tasks);
    }
  }

  private async fetchOpenInterestForBuffer(buf: SymbolMicrostructureBuffer): Promise<void> {
    const instType = buf.instId.includes('_UM_XPERP') ? 'FUTURES' : 'SWAP';
    const json = await this.fetchPublicJson(`/api/v5/public/open-interest?instType=${instType}&instId=${buf.instId}`, 3500);
    if (json && Array.isArray(json.data) && json.data.length > 0) {
      const item = json.data[0];
      const oiCcy = parseFloat(item.oiCcy || item.oi || '0');
      const oiUsd = parseFloat(item.oiUsd || '0');
      const ts = parseInt(item.ts || Date.now().toString(), 10);
      if (oiCcy > 0) {
        buf.oiHistory.push({ ts: Date.now(), oiCcy, oiUsd });
        if (buf.oiHistory.length > 40) {
          buf.oiHistory.shift();
        }
      }
    }
  }

  private async pollTrackedOpenInterest(): Promise<void> {
    const symbols = Array.from(this.trackedSymbols);
    for (const instId of symbols) {
      const buf = this.buffers.get(instId);
      if (!buf) continue;
      if (Date.now() - buf.lastOiFetchTs >= this.OI_TTL_MS) {
        buf.lastOiFetchTs = Date.now();
        await this.fetchOpenInterestForBuffer(buf);
        await new Promise((r) => setTimeout(r, 120));
      }
    }
  }

  /**
   * Core Evaluation: Computes the 6 Order Flow & Microstructure pillars and estimates
   * 5–15m directional probability for SCALP (Varianta B + Fade Climax option).
   */
  public evaluate(
    symbol: string,
    klines?: Kline[],
    options?: {
      invertSignals?: boolean;
      isClimax?: boolean;
      currentAtr?: number;
      lastPrice?: number;
    }
  ): DirectionAssessment {
    const instId = this.normalizeSymbol(symbol);
    const buf = this.getOrCreateBuffer(instId);
    const now = Date.now();
    this.pruneBuffer(buf, now);

    // Uniform time-based evaluation window across all symbols (last N = 300 seconds)
    const evalCutoff = now - this.EVAL_WINDOW_MS;
    const trades = buf.trades.filter((t) => t.ts >= evalCutoff);
    const windowLiquidations = buf.liquidations.filter((l) => l.ts >= evalCutoff);
    const sampleTradesCount = trades.length;

    const fallbackPrice =
      options?.lastPrice ||
      (trades.length > 0 ? trades[trades.length - 1].px : 0) ||
      (klines && klines.length > 0 ? klines[klines.length - 1].close : 0);

    const effAtr =
      options?.currentAtr && options.currentAtr > 0
        ? options.currentAtr
        : klines && klines.length >= 14
        ? klines.slice(-14).reduce((s, k) => s + Math.max(1e-9, k.high - k.low), 0) / 14
        : Math.max(1e-8, fallbackPrice * 0.006);

    // =========================================================================
    // 1. AGGRESSIVE BUY / SELL VOLUME (Taker Imbalance Ratio & Whale Prints)
    // =========================================================================
    let buyVolUsdt = 0;
    let sellVolUsdt = 0;
    for (const t of trades) {
      if (t.side === 'buy') buyVolUsdt += t.notionalUsdt;
      else sellVolUsdt += t.notionalUsdt;
    }
    const totalVolUsdt = buyVolUsdt + sellVolUsdt;
    const takerBuyRatio = totalVolUsdt > 0 ? buyVolUsdt / totalVolUsdt : 0.5;
    const takerImbalance = totalVolUsdt > 0 ? (buyVolUsdt - sellVolUsdt) / totalVolUsdt : 0; // [-1, +1]

    // Whale Prints (>= 2.8x average ticket notional)
    const avgTicketUsdt = sampleTradesCount > 0 ? totalVolUsdt / sampleTradesCount : 0;
    let whaleBuyUsdt = 0;
    let whaleSellUsdt = 0;
    if (avgTicketUsdt > 0) {
      const whaleThreshold = avgTicketUsdt * 2.8;
      for (const t of trades) {
        if (t.notionalUsdt >= whaleThreshold) {
          if (t.side === 'buy') whaleBuyUsdt += t.notionalUsdt;
          else whaleSellUsdt += t.notionalUsdt;
        }
      }
    }
    const totalWhaleUsdt = whaleBuyUsdt + whaleSellUsdt;
    const whaleNetRatio =
      totalWhaleUsdt > 0 ? (whaleBuyUsdt - whaleSellUsdt) / Math.max(totalWhaleUsdt, totalVolUsdt * 0.25) : 0;

    // =========================================================================
    // 2. CUMULATIVE VOLUME DELTA (CVD Slope & Price-CVD Divergence over N sec)
    // =========================================================================
    const cvdDeltaUsdt = buyVolUsdt - sellVolUsdt;
    let cvdSlope5m = 0;
    let priceSlopeNorm = 0;
    let cvdDivergence: 'BULLISH' | 'BEARISH' | 'NONE' = 'NONE';

    if (trades.length >= 10 && totalVolUsdt > 0) {
      // Split the uniform N-second time span [firstTs..lastTs] into 5 equal time buckets
      const firstTs = trades[0].ts;
      const lastTs = trades[trades.length - 1].ts;
      const spanMs = Math.max(1000, lastTs - firstTs);
      const midTs = firstTs + spanMs * 0.5;

      let runningCvd = 0;
      let secondHalfDelta = 0;
      for (const t of trades) {
        const delta = t.side === 'buy' ? t.notionalUsdt : -t.notionalUsdt;
        runningCvd += delta;
        if (t.ts >= midTs) {
          secondHalfDelta += delta;
        }
      }

      const rawSlope = (runningCvd * 0.45 + secondHalfDelta * 0.55) / (totalVolUsdt * 0.65 + 1e-8);
      cvdSlope5m = Math.max(-1, Math.min(1, rawSlope));

      const firstPx = trades[0].px;
      const lastPx = trades[trades.length - 1].px;
      priceSlopeNorm = Math.max(-2, Math.min(2, (lastPx - firstPx) / Math.max(1e-8, effAtr)));

      // Divergence detection:
      // Bearish Divergence: Price pushed up (> +0.30 ATR), but CVD slope is negative (sellers hitting bids into the rally)
      if (priceSlopeNorm >= 0.30 && cvdSlope5m <= -0.18) {
        cvdDivergence = 'BEARISH';
      }
      // Bullish Divergence: Price dropped (< -0.30 ATR), but CVD slope is positive (aggressive buying stepping in on the dip)
      else if (priceSlopeNorm <= -0.30 && cvdSlope5m >= 0.18) {
        cvdDivergence = 'BULLISH';
      }
    } else if (trades.length >= 3 && totalVolUsdt > 0) {
      // Small real tick sample (3..9 trades): use actual trade delta scaled conservatively by sample size
      cvdSlope5m = Math.max(-1, Math.min(1, takerImbalance * (trades.length / 10)));
    }

    // =========================================================================
    // 3. ORDER BOOK IMBALANCE (Distance-Weighted & Anti-Spoof Filtered L2 OBI)
    // =========================================================================
    let obiWeighted = 0;
    let bidAskRatio = 1.0;

    if (buf.orderBook && buf.orderBook.bids.length > 0 && buf.orderBook.asks.length > 0) {
      const bids = buf.orderBook.bids;
      const asks = buf.orderBook.asks;
      const bestBid = bids[0].px;
      const bestAsk = asks[0].px;
      const midPx = (bestBid + bestAsk) / 2;

      if (midPx > 0) {
        const rawBidTotal = bids.reduce((s, l) => s + l.sz, 0) + 1e-9;
        const rawAskTotal = asks.reduce((s, l) => s + l.sz, 0) + 1e-9;

        let weightedBids = 0;
        let weightedAsks = 0;

        // Exponential distance decay lambda = 800 (~8.7 bps / 0.087% half-life) so top levels matter most
        const decayScale = 800;

        for (let i = 0; i < bids.length; i++) {
          const lvl = bids[i];
          const distPct = Math.max(0, (midPx - lvl.px) / midPx);
          const distWeight = Math.exp(-decayScale * distPct);

          // Anti-Spoofing Filter:
          // A single large order (numOrders === 1) sitting away from touch (i >= 2) that accounts for >42% of book side
          // is discounted by 55%; multi-order institutional clusters (numOrders >= 4) get a +15% credibility boost.
          let spoofFactor = 1.0;
          if (i >= 2 && lvl.numOrders === 1 && lvl.sz / rawBidTotal > 0.42) {
            spoofFactor = 0.45;
          } else if (lvl.numOrders >= 4) {
            spoofFactor = 1.15;
          }

          weightedBids += lvl.sz * distWeight * spoofFactor;
        }

        for (let i = 0; i < asks.length; i++) {
          const lvl = asks[i];
          const distPct = Math.max(0, (lvl.px - midPx) / midPx);
          const distWeight = Math.exp(-decayScale * distPct);

          let spoofFactor = 1.0;
          if (i >= 2 && lvl.numOrders === 1 && lvl.sz / rawAskTotal > 0.42) {
            spoofFactor = 0.45;
          } else if (lvl.numOrders >= 4) {
            spoofFactor = 1.15;
          }

          weightedAsks += lvl.sz * distWeight * spoofFactor;
        }

        const totalWeightedBook = weightedBids + weightedAsks;
        if (totalWeightedBook > 0) {
          obiWeighted = (weightedBids - weightedAsks) / totalWeightedBook;
          bidAskRatio = weightedBids / Math.max(1e-9, weightedAsks);
        }
      }
    }

    // =========================================================================
    // 4. TRADE FLOW VELOCITY & ACCELERATION (Tape Speed)
    // =========================================================================
    let tradesPerSec = 0;
    let tradeFlowAccel = 1.0;

    if (trades.length >= 12) {
      const firstTs = trades[0].ts;
      const lastTs = trades[trades.length - 1].ts;
      const totalSpanSec = Math.max(5, (lastTs - firstTs) / 1000);
      const baselineRate = trades.length / totalSpanSec;

      // Measure speed over the most recent 25% of time window (or last 30s)
      const recentWindowSec = Math.max(3, Math.min(30, totalSpanSec * 0.25));
      const recentCutoffTs = lastTs - recentWindowSec * 1000;
      const recentTrades = trades.filter((t) => t.ts >= recentCutoffTs);
      tradesPerSec = recentTrades.length / recentWindowSec;

      if (baselineRate > 0) {
        tradeFlowAccel = Math.max(0.3, Math.min(5.0, tradesPerSec / baselineRate));
      }
    }

    // =========================================================================
    // 5. ABSORPTION DETECTOR (Effort vs. Result)
    // =========================================================================
    // Positive absorptionScore (+0.35 to +1.0) = Bullish Absorption (Aggressive Sellers absorbed by Passive Limit Bids)
    // Negative absorptionScore (-0.35 to -1.0) = Bearish Absorption (Aggressive Buyers absorbed by Passive Limit Asks)
    let absorptionScore = 0;

    if (trades.length >= 15 && effAtr > 0) {
      const firstPx = trades[0].px;
      const lastPx = trades[trades.length - 1].px;
      const netPriceChangeAtr = (lastPx - firstPx) / effAtr; // Signed price progress in ATR units
      const absPriceChangeAtr = Math.abs(netPriceChangeAtr);

      // Case A: Heavy aggressive selling (takerImbalance < -0.15), yet price refuses to drop (netPriceChangeAtr >= -0.12)
      // or passive bid liquidity remains stacked (obiWeighted > 0.10)
      if (takerImbalance < -0.15 && netPriceChangeAtr >= -0.12) {
        const effort = Math.min(1.0, Math.abs(takerImbalance) * 1.8);
        const bidSupportBonus = obiWeighted > 0 ? obiWeighted * 0.35 : 0;
        const stiffness = Math.max(0.2, 1.0 - absPriceChangeAtr * 2.5);
        absorptionScore = Math.min(1.0, effort * stiffness + bidSupportBonus);
      }
      // Case B: Heavy aggressive buying (takerImbalance > +0.15), yet price stalls/drops (netPriceChangeAtr <= +0.12)
      // or passive ask wall caps price (obiWeighted < -0.10)
      else if (takerImbalance > 0.15 && netPriceChangeAtr <= 0.12) {
        const effort = Math.min(1.0, Math.abs(takerImbalance) * 1.8);
        const askWallBonus = obiWeighted < 0 ? Math.abs(obiWeighted) * 0.35 : 0;
        const stiffness = Math.max(0.2, 1.0 - absPriceChangeAtr * 2.5);
        absorptionScore = -Math.min(1.0, effort * stiffness + askWallBonus);
      }
    }

    // Enhance absorption detection with current forming candle wick rejection if available
    if (klines && klines.length >= 2) {
      const cur = klines[klines.length - 1];
      const rng = Math.max(1e-9, cur.high - cur.low);
      const upperWickRatio = (cur.high - Math.max(cur.open, cur.close)) / rng;
      const lowerWickRatio = (Math.min(cur.open, cur.close) - cur.low) / rng;

      if (lowerWickRatio >= 0.42 && obiWeighted >= 0.08 && absorptionScore >= 0) {
        absorptionScore = Math.min(1.0, Math.max(absorptionScore, lowerWickRatio * 0.85 + obiWeighted * 0.25));
      } else if (upperWickRatio >= 0.42 && obiWeighted <= -0.08 && absorptionScore <= 0) {
        absorptionScore = -Math.min(1.0, Math.max(Math.abs(absorptionScore), upperWickRatio * 0.85 + Math.abs(obiWeighted) * 0.25));
      }
    }

    // =========================================================================
    // 6. LIQUIDATIONS & OPEN INTEREST SQUEEZE MATRIX (ΔOI + Liquidations)
    // =========================================================================
    let oiDeltaPct = 0;
    if (buf.oiHistory.length >= 2) {
      const oldest = buf.oiHistory[0].oiCcy;
      const newest = buf.oiHistory[buf.oiHistory.length - 1].oiCcy;
      if (oldest > 0) {
        oiDeltaPct = ((newest - oldest) / oldest) * 100;
      }
    }

    let shortLiqUsd = 0;
    let longLiqUsd = 0;
    for (const liq of windowLiquidations) {
      if (liq.side === 'SHORT_LIQ') shortLiqUsd += liq.usdValue;
      else longLiqUsd += liq.usdValue;
    }
    const recentLiquidationsUsd = shortLiqUsd - longLiqUsd; // >0 = Short Squeeze liquidations, <0 = Long Flush liquidations

    // =========================================================================
    // COMPOSITE DIRECTIONAL PROBABILITY P(UP in 5–15m) & REGIME CLASSIFICATION
    // =========================================================================
    // Strict Real-Data & Duration Gate (Item 4): Require at least 30 real tick trades AND
    // a minimum observed trade span of 60,000 ms (60s) within the uniform evaluation window.
    const firstTs = trades.length > 0 ? trades[0].ts : 0;
    const lastTs = trades.length > 0 ? trades[trades.length - 1].ts : 0;
    const tradeSpanMs = lastTs - firstTs;
    const hasSufficientRealFlow = sampleTradesCount >= 30 && tradeSpanMs >= 60_000;

    // Effective Taker & CVD signal (strictly from real trades)
    const effectiveTakerSignal = hasSufficientRealFlow ? takerImbalance : 0;

    // 1. Taker Aggressive Flow Contribution (-0.30 to +0.30)
    const takerContrib = hasSufficientRealFlow
      ? Math.max(-1, Math.min(1, effectiveTakerSignal * 1.5 + whaleNetRatio * 0.35)) * 0.28
      : 0;

    // 2. CVD Slope & Divergence Contribution (-0.25 to +0.25)
    let cvdContrib = hasSufficientRealFlow ? cvdSlope5m * 0.22 : 0;
    if (hasSufficientRealFlow && cvdDivergence === 'BULLISH') cvdContrib += 0.10;
    else if (hasSufficientRealFlow && cvdDivergence === 'BEARISH') cvdContrib -= 0.10;

    // 3. Distance-Weighted L2 Order Book Imbalance Contribution (-0.20 to +0.20)
    const obiContrib = hasSufficientRealFlow
      ? Math.max(-1, Math.min(1, obiWeighted * 1.35)) * 0.18
      : 0;

    // 4. Absorption Contribution (-0.20 to +0.20)
    const absorptionContrib = hasSufficientRealFlow ? absorptionScore * 0.18 : 0;

    // 5. Open Interest & Liquidation Squeeze Contribution (-0.14 to +0.14)
    let squeezeContrib = 0;
    if (hasSufficientRealFlow) {
      if (recentLiquidationsUsd > 1000) {
        squeezeContrib += Math.min(0.10, (recentLiquidationsUsd / 25_000) * 0.10);
      } else if (recentLiquidationsUsd < -1000) {
        squeezeContrib -= Math.min(0.10, (Math.abs(recentLiquidationsUsd) / 25_000) * 0.10);
      }
      if (Math.abs(oiDeltaPct) >= 0.05) {
        // Rising OI in direction of CVD = new money build-up
        const oiDir = effectiveTakerSignal >= 0 ? 1 : -1;
        if (oiDeltaPct > 0) {
          squeezeContrib += oiDir * Math.min(0.08, oiDeltaPct * 0.12);
        } else {
          // Falling OI + strong directional move = squeeze / covering
          squeezeContrib += oiDir * Math.min(0.05, Math.abs(oiDeltaPct) * 0.08);
        }
      }
    }

    // 6. Trade Flow Acceleration Amplifier (1.0x to 1.30x conviction boost when tape accelerates)
    const accelMultiplier =
      !hasSufficientRealFlow
        ? 1.0
        : tradeFlowAccel >= 1.35
        ? Math.min(1.28, 1.0 + (tradeFlowAccel - 1.0) * 0.16)
        : tradeFlowAccel < 0.75
        ? 0.88
        : 1.0;

    const rawDirectionalEdge =
      (takerContrib + cvdContrib + obiContrib + absorptionContrib + squeezeContrib) * accelMultiplier;

    // Map rawDirectionalEdge [-0.90, +0.90] to probabilityUp [0.05, 0.95]
    const clampedEdge = Math.max(-0.85, Math.min(0.85, rawDirectionalEdge));
    let probabilityUp = hasSufficientRealFlow
      ? parseFloat(Math.max(0.05, Math.min(0.95, 0.5 + clampedEdge * 0.52)).toFixed(3))
      : 0.5;

    // Classify Market Microstructure Regime
    let regime: OrderFlowRegime = 'CHOP_BALANCED';
    if (!hasSufficientRealFlow) {
      regime = 'CHOP_BALANCED';
    } else if (absorptionScore >= 0.38 && probabilityUp >= 0.54) {
      regime = 'BULLISH_ABSORPTION';
    } else if (absorptionScore <= -0.38 && probabilityUp <= 0.46) {
      regime = 'BEARISH_ABSORPTION';
    } else if (
      probabilityUp >= 0.56 &&
      (recentLiquidationsUsd > 500 || (oiDeltaPct <= -0.12 && effectiveTakerSignal > 0.15))
    ) {
      regime = 'SHORT_SQUEEZE';
    } else if (
      probabilityUp <= 0.44 &&
      (recentLiquidationsUsd < -500 || (oiDeltaPct <= -0.12 && effectiveTakerSignal < -0.15))
    ) {
      regime = 'LONG_FLUSH';
    } else if (probabilityUp >= 0.55) {
      regime = 'LONG_BUILDUP';
    } else if (probabilityUp <= 0.45) {
      regime = 'SHORT_BUILDUP';
    }

    // Determine primary direction before optional Fade Climax inversion (Item 6: strictly requires sampleTradesCount >= 30)
    let direction: 'LONG' | 'SHORT' | 'NEUTRAL' = 'NEUTRAL';
    let side: OrderSide = probabilityUp >= 0.5 ? 'BUY' : 'SELL';

    if (sampleTradesCount >= 30 && hasSufficientRealFlow) {
      if (probabilityUp >= 0.55) {
        direction = 'LONG';
        side = 'BUY';
      } else if (probabilityUp <= 0.45) {
        direction = 'SHORT';
        side = 'SELL';
      } else {
        direction = 'NEUTRAL';
        side = probabilityUp >= 0.5 ? 'BUY' : 'SELL';
      }
    } else {
      direction = 'NEUTRAL';
      side = probabilityUp >= 0.5 ? 'BUY' : 'SELL';
    }

    // Preserve Fade Climax / Signal Inversion option when requested
    let isFadeSignal = false;
    if (options?.invertSignals && direction !== 'NEUTRAL') {
      isFadeSignal = true;
      if (direction === 'LONG') {
        direction = 'SHORT';
        side = 'SELL';
      } else {
        direction = 'LONG';
        side = 'BUY';
      }
      probabilityUp = parseFloat((1 - probabilityUp).toFixed(3));
    }

    const directionalProbability = hasSufficientRealFlow
      ? parseFloat((side === 'BUY' ? probabilityUp : 1 - probabilityUp).toFixed(3))
      : 0.5;

    // Confidence (0..100): measures alignment across Taker Flow, CVD, OBI, and sample depth
    const signTarget = isFadeSignal ? (side === 'BUY' ? -1 : 1) : side === 'BUY' ? 1 : -1;
    let alignedPillars = 0;
    if (hasSufficientRealFlow) {
      if (effectiveTakerSignal * signTarget > 0.08) alignedPillars++;
      if (cvdSlope5m * signTarget > 0.08) alignedPillars++;
      if (obiWeighted * signTarget > 0.06) alignedPillars++;
      if (tradeFlowAccel >= 1.15) alignedPillars++;
      if (absorptionScore * (isFadeSignal ? -signTarget : signTarget) > 0.25) alignedPillars++;
    }

    const sampleFactor = sampleTradesCount >= 60 ? 1.0 : sampleTradesCount >= 30 ? 0.90 : 0.65;
    const edgeStrength = Math.min(1.0, Math.abs(directionalProbability - 0.5) / 0.35);
    const confidence = hasSufficientRealFlow
      ? Math.round(Math.max(15, Math.min(99, (edgeStrength * 65 + (alignedPillars / 5) * 35) * sampleFactor)))
      : 0;

    // Direction Score (0..100) rescaled for blended score comparison (Item 3: 50 = neutral, P=0.62 -> 65.0, P=0.70 -> 75.0)
    const directionScore = hasSufficientRealFlow
      ? parseFloat(Math.max(0, Math.min(100, 50 + (directionalProbability - 0.5) * 125)).toFixed(1))
      : 50;

    // Build human-readable explanations for Terminal & Audit Logs
    const reasoning: string[] = [];
    if (!hasSufficientRealFlow) {
      reasoning.push(
        `Eșantion insuficient de tranzacții în fereastra de ${Math.round(this.EVAL_WINDOW_MS / 1000)}s (${sampleTradesCount}/30 ticks, durată ${(tradeSpanMs / 1000).toFixed(0)}s/60s) — NEUTRAL`
      );
    } else {
      const buyPctStr = (takerBuyRatio * 100).toFixed(0);
      reasoning.push(
        `Regim: ${regime} | P(${side === 'BUY' ? 'UP' : 'DOWN'} 5-15m): ${(directionalProbability * 100).toFixed(1)}% (Conf: ${confidence}% | ${sampleTradesCount} ticks)`
      );
      reasoning.push(
        `Taker Buy: ${buyPctStr}% (Imb: ${(takerImbalance * 100).toFixed(0)}%) | CVD Slope: ${cvdSlope5m >= 0 ? '+' : ''}${cvdSlope5m.toFixed(2)}`
      );
      reasoning.push(
        `OrderBook OBI: ${obiWeighted >= 0 ? '+' : ''}${(obiWeighted * 100).toFixed(0)}% (Bid/Ask: ${bidAskRatio.toFixed(2)}x) | Tape: ${tradeFlowAccel.toFixed(2)}x`
      );
      if (Math.abs(absorptionScore) >= 0.30) {
        reasoning.push(
          `Absorbție Pasivă: ${absorptionScore > 0 ? 'BULLISH (Suport Limit absoarbe Sell-ul)' : 'BEARISH (Zid Ask absoarbe Buy-ul)'} (${absorptionScore.toFixed(2)})`
        );
      }
      if (Math.abs(oiDeltaPct) >= 0.05 || Math.abs(recentLiquidationsUsd) > 0) {
        reasoning.push(
          `Derivate: ΔOI ${oiDeltaPct >= 0 ? '+' : ''}${oiDeltaPct.toFixed(2)}% | Liq Net: $${recentLiquidationsUsd.toFixed(0)}`
        );
      }
      if (isFadeSignal) {
        reasoning.push(`FADE CLIMAX ACTIV: Direcția microstructurii a fost inversată în ${direction} (${side})`);
      }
    }

    const metrics: OrderFlowMetrics = {
      takerBuyRatio: parseFloat(takerBuyRatio.toFixed(3)),
      takerImbalance: parseFloat(takerImbalance.toFixed(3)),
      cvdSlope5m: parseFloat(cvdSlope5m.toFixed(3)),
      cvdDeltaUsdt: parseFloat(cvdDeltaUsdt.toFixed(2)),
      cvdDivergence,
      obiWeighted: parseFloat(obiWeighted.toFixed(3)),
      bidAskRatio: parseFloat(bidAskRatio.toFixed(2)),
      tradeFlowAccel: parseFloat(tradeFlowAccel.toFixed(2)),
      tradesPerSec: parseFloat(tradesPerSec.toFixed(2)),
      whaleNetRatio: parseFloat(whaleNetRatio.toFixed(3)),
      absorptionScore: parseFloat(absorptionScore.toFixed(3)),
      oiDeltaPct: parseFloat(oiDeltaPct.toFixed(3)),
      recentLiquidationsUsd: parseFloat(recentLiquidationsUsd.toFixed(2)),
      sampleTradesCount,
    };

    return {
      symbol: instId,
      direction,
      side,
      probabilityUp,
      directionalProbability,
      confidence,
      directionScore,
      regime,
      isFadeSignal,
      metrics,
      reasoning,
      timestamp: now,
    };
  }
}

export const directionEngine = new DirectionEngine('AUTO');
