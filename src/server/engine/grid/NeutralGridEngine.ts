import {
  ExecutionMode,
  GridArbitrageEvent,
  GridBotInstance,
  GridLevelState,
  NeutralGridBotConfig,
} from '../../../shared/types';
import { calculateExecutionFee } from '../../../shared/fees';
import { IExecutionAdapter } from '../../exchange/IExecutionAdapter';
import { GridJournal } from './GridJournal';
import { GridOptimizer } from './GridOptimizer';
import { GridRiskManager } from './GridRiskManager';

export class NeutralGridEngine {
  private adapter: IExecutionAdapter;
  private journal: GridJournal;
  private bots: Map<string, GridBotInstance> = new Map();
  private lastKnownPrices: Map<string, number> = new Map();
  private lastWarnedDiscrepancyByBot: Map<string, number> = new Map();
  private processingSymbols: Set<string> = new Set();
  private isReconciling: boolean = false;

  constructor(adapter: IExecutionAdapter, journal: GridJournal) {
    this.adapter = adapter;
    this.journal = journal;

    // Restore persisted bots
    const saved = this.journal.getBots();
    for (const b of saved) {
      this.bots.set(b.botId, b);
      if (b.currentPrice > 0) {
        this.lastKnownPrices.set(b.symbol, b.currentPrice);
      }
    }
  }

  public setAdapter(adapter: IExecutionAdapter) {
    this.adapter = adapter;
  }

  public getAllBots(): GridBotInstance[] {
    return Array.from(this.bots.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  public getRunningBots(): GridBotInstance[] {
    return this.getAllBots().filter((b) => b.status === 'RUNNING');
  }

  public getBot(botId: string): GridBotInstance | undefined {
    return this.bots.get(botId);
  }

  /**
   * Creates, validates, optimizes, and deploys a new Neutral Grid Bot.
   */
  public async createAndStartBot(
    rawConfig: Partial<NeutralGridBotConfig>,
    executionMode: ExecutionMode,
    freeBalanceUSDT: number,
    killSwitchEngaged: boolean
  ): Promise<{ success: boolean; bot?: GridBotInstance; error?: string; warnings?: string[] }> {
    try {
      const rawSym = rawConfig.symbol;
      if (!rawSym) {
        throw new Error('Simbolul monedei este obligatoriu pentru lansarea botului Grid.');
      }
      const symbol = this.adapter.normalizeSymbol ? this.adapter.normalizeSymbol(rawSym) : rawSym;
      const livePrice =
        (await this.adapter.getTickerPrice(symbol)) ||
        this.lastKnownPrices.get(symbol);
      if (!livePrice) throw new Error(`Nu s-a putut obține prețul curent pentru ${symbol}`);

      this.lastKnownPrices.set(symbol, livePrice);

      const lotFilter = await this.adapter.getInstrumentFilter(symbol);
      const marginInvestedUSDT = Number(rawConfig.marginInvestedUSDT) || 50;

      // Auto-optimize if mode === 'AUTO' or bounds not specified
      let lowerPrice = Number(rawConfig.lowerPrice) || 0;
      let upperPrice = Number(rawConfig.upperPrice) || 0;
      let gridCount = Number(rawConfig.gridCount) || 12;
      let gridType = rawConfig.gridType || 'ARITHMETIC';
      let leverage = Number(rawConfig.leverage) || 3;

      if (rawConfig.mode === 'AUTO' || lowerPrice <= 0 || upperPrice <= 0 || lowerPrice >= upperPrice) {
        const klines = await this.adapter.getKlines(symbol, '15', 60);
        const auto = GridOptimizer.autoOptimizeParameters(
          symbol,
          livePrice,
          klines,
          marginInvestedUSDT,
          lotFilter?.tickSize || 0.01
        );
        if (lowerPrice <= 0 || upperPrice <= 0 || lowerPrice >= upperPrice) {
          lowerPrice = auto.lowerPrice;
          upperPrice = auto.upperPrice;
        }
        if (!rawConfig.gridCount) gridCount = auto.gridCount;
        if (!rawConfig.leverage) leverage = auto.recommendedLeverage;
        if (!rawConfig.gridType) gridType = auto.gridType;
      }

      const fullConfig: NeutralGridBotConfig = {
        symbol,
        platform: rawConfig.platform || 'OKX_EEA',
        mode: rawConfig.mode || 'MANUAL',
        lowerPrice,
        upperPrice,
        gridCount,
        gridType,
        marginInvestedUSDT,
        leverage,
        marginMode: rawConfig.marginMode === 'isolated' ? 'isolated' : 'cross',
        martingale: {
          enabled: Boolean(rawConfig.martingale?.enabled),
          sizeMultiplier: Number(rawConfig.martingale?.sizeMultiplier) || 1.0,
          maxMultiplierSteps: Number(rawConfig.martingale?.maxMultiplierSteps) || 5,
          maxExposureUSDT:
            Number(rawConfig.martingale?.maxExposureUSDT) || marginInvestedUSDT * leverage,
        },
        risk: {
          stopLossPct: Number(rawConfig.risk?.stopLossPct ?? 8.0),
          takeProfitPct: Number(rawConfig.risk?.takeProfitPct ?? 15.0),
          lowerStopPrice: Number(rawConfig.risk?.lowerStopPrice) || undefined,
          upperStopPrice: Number(rawConfig.risk?.upperStopPrice) || undefined,
          stopOnRangeBreakout:
            rawConfig.risk?.stopOnRangeBreakout !== undefined
              ? Boolean(rawConfig.risk.stopOnRangeBreakout)
              : true,
          maxMarginUsagePct: Number(rawConfig.risk?.maxMarginUsagePct) || 90,
          maxActiveGridBots: Number(rawConfig.risk?.maxActiveGridBots) || 100,
        },
        autoManageRange: Boolean(rawConfig.autoManageRange),
      };

      // Validate Risk Gate
      const activeCount = this.getRunningBots().length;
      const riskCheck = GridRiskManager.validateNewGridBot(
        fullConfig,
        freeBalanceUSDT,
        activeCount,
        killSwitchEngaged
      );
      if (!riskCheck.approved) {
        this.journal.logAudit('RISK_REJECTED', `[GRID RESPINS] ${symbol}: ${riskCheck.reason}`);
        return { success: false, error: riskCheck.reason };
      }

      // Calculate Grid Levels
      const opt = GridOptimizer.calculateGrid(fullConfig, livePrice, lotFilter);
      const botId = `grid_${symbol.split('-')[0].toLowerCase()}_${Date.now().toString(36)}`;

      const activeBuyOrders = opt.levels.filter((l) => l.side === 'Buy' && l.status === 'OPEN_ORDER').length;
      const activeSellOrders = opt.levels.filter((l) => l.side === 'Sell' && l.status === 'OPEN_ORDER').length;

      const bot: GridBotInstance = {
        botId,
        symbol,
        platform: fullConfig.platform,
        executionMode,
        status: 'RUNNING',
        config: fullConfig,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        initialCenterPrice: livePrice,
        currentPrice: livePrice,
        gridSpacingUSDT: opt.gridSpacingUSDT,
        gridSpacingPct: opt.gridSpacingPct,
        estimatedProfitPerGridPct: opt.estimatedProfitPerGridPct,
        estimatedLiquidationPriceLong: opt.estimatedLiquidationPriceLong,
        estimatedLiquidationPriceShort: opt.estimatedLiquidationPriceShort,
        lowerStopPrice: opt.lowerStopPrice,
        upperStopPrice: opt.upperStopPrice,
        levels: opt.levels,
        totalNotionalUSDT: opt.totalPlannedNotionalUSDT,
        netPositionContracts: 0,
        netPositionSide: 'FLAT',
        avgHoldPrice: livePrice,
        gridProfitUSDT: 0,
        floatingPnlUSDT: 0,
        totalFeesUSDT: 0,
        fundingEstimateUSDT: 0,
        totalNetPnlUSDT: 0,
        totalNetPnlPct: 0,
        completedArbitrages: 0,
        activeBuyOrders,
        activeSellOrders,
      };

      // Deploy initial orders
      await this.deployInitialGridOrders(bot);
      this.recalculateBotAccounting(bot, livePrice, lotFilter?.ctVal && lotFilter.ctVal > 0 ? lotFilter.ctVal : 1);

      this.bots.set(botId, bot);
      this.persist();

      this.journal.logAudit(
        'GRID_CREATED',
        `[BOT GRID ACTIVAT] ${symbol} (${executionMode}) | Interval: $${fullConfig.lowerPrice} – $${fullConfig.upperPrice} | ${fullConfig.gridCount} trepte (${fullConfig.gridType}) | Marjă: $${fullConfig.marginInvestedUSDT} × ${fullConfig.leverage}x (${fullConfig.marginMode.toUpperCase()}) | SL: -${fullConfig.risk.stopLossPct}% / TP: +${fullConfig.risk.takeProfitPct}%`,
        { botId, config: fullConfig, warnings: opt.warnings }
      );

      return { success: true, bot, warnings: opt.warnings };
    } catch (err: any) {
      return {
        success: false,
        error: err.message || 'Eroare la crearea botului Neutral Grid',
      };
    }
  }

  /**
   * Computes the balanced (Buy/Sell interleaved) window of closest grid levels that fit within
   * the bot's allocated margin budget (marginInvestedUSDT * leverage * 0.92), up to 8 live orders max.
   */
  private computeTargetLiveWindow(bot: GridBotInstance): GridLevelState[] {
    const maxLiveWindow = 8;
    const leverage = Math.max(1, Number(bot.config.leverage) || 1);
    const marginBudget = Math.max(2, Number(bot.config.marginInvestedUSDT) || 5);
    const maxBotLiveNotional = marginBudget * leverage * 0.92;

    const openBuys = bot.levels
      .filter((l) => l.status === 'OPEN_ORDER' && l.side === 'Buy')
      .sort((a, b) => Math.abs(a.price - bot.currentPrice) - Math.abs(b.price - bot.currentPrice));
    const openSells = bot.levels
      .filter((l) => l.status === 'OPEN_ORDER' && l.side === 'Sell')
      .sort((a, b) => Math.abs(a.price - bot.currentPrice) - Math.abs(b.price - bot.currentPrice));

    const interleaved: GridLevelState[] = [];
    const maxLen = Math.max(openBuys.length, openSells.length);
    for (let i = 0; i < maxLen; i++) {
      if (i < openBuys.length) interleaved.push(openBuys[i]);
      if (i < openSells.length) interleaved.push(openSells[i]);
    }

    const selected: GridLevelState[] = [];
    let cumulativeNotional = 0;

    for (const lvl of interleaved) {
      if (selected.length >= maxLiveWindow) break;
      const lvlNotional = Math.max(0, Number(lvl.notionalUSDT) || 0);
      // Always allow at least the closest 2 levels (1 Buy + 1 Sell) if within 1.35x budget, otherwise enforce strict cap
      if (selected.length >= 2 && cumulativeNotional + lvlNotional > maxBotLiveNotional) {
        break;
      }
      selected.push(lvl);
      cumulativeNotional += lvlNotional;
    }

    return selected;
  }

  /**
   * Deploys limit orders for levels.
   * In LIVE mode, submits limit orders to OKX for the nearest active levels that fit within
   * both the bot's allocated margin budget and the account's real available margin.
   */
  private async deployInitialGridOrders(bot: GridBotInstance) {
    const now = Date.now();
    const targetWindow = this.computeTargetLiveWindow(bot);
    const targetIndices = new Set(targetWindow.map((l) => l.index));

    // Order placement sequence: targetWindow first (closest balanced Buy/Sell pairs), then remaining levels as virtual standby
    const remainingLevels = bot.levels.filter(
      (l) => l.status === 'OPEN_ORDER' && (l.side === 'Buy' || l.side === 'Sell') && !targetIndices.has(l.index)
    );
    const orderedLevels = [...targetWindow, ...remainingLevels];

    const leverage = Math.max(1, Number(bot.config.leverage) || 1);
    let marginExhausted = false;

    for (const lvl of orderedLevels) {
      const orderLinkId = `${bot.botId}_L${lvl.index}_${now.toString(36)}`;
      lvl.activeOrderLinkId = orderLinkId;

      const shouldPlaceLive =
        bot.executionMode === 'LIVE' && targetIndices.has(lvl.index) && !marginExhausted;

      if (shouldPlaceLive) {
        const reqMargin = ((Number(lvl.notionalUSDT) || 0) / leverage) * 1.06;
        const availMargin = this.adapter.getAvailableMarginUSDT
          ? this.adapter.getAvailableMarginUSDT()
          : Infinity;

        if (availMargin > 0 && availMargin < reqMargin) {
          marginExhausted = true;
          lvl.activeOrderId = `sim_${orderLinkId}`;
        } else {
          try {
            const res = await this.adapter.submitOrder({
              symbol: bot.symbol,
              side: lvl.side as 'Buy' | 'Sell',
              orderType: 'Limit',
              qty: lvl.qtyContracts,
              price: lvl.price,
              orderLinkId,
              leverage: bot.config.leverage,
              marginMode: bot.config.marginMode,
            });
            lvl.activeOrderId = res.orderId;
          } catch (err: any) {
            lvl.activeOrderId = `sim_${orderLinkId}`;
            const errMsg = String(err?.message || err);
            if (errMsg.includes('51008') || errMsg.toLowerCase().includes('insufficient')) {
              marginExhausted = true;
            } else {
              this.journal.logAudit(
                'ORDER_REJECTED',
                `[GRID LIVE ORDIN RESPINS] ${bot.symbol} Nivel #${lvl.index + 1} (${lvl.side} @ $${lvl.price}): ${errMsg}`
              );
            }
          }
        }
      } else {
        lvl.activeOrderId = `sim_${orderLinkId}`;
      }

      this.journal.recordOrder({
        id: orderLinkId,
        symbol: bot.symbol,
        side: lvl.side === 'Buy' ? 'BUY' : 'SELL',
        orderType: 'Limit',
        qty: lvl.qtyContracts,
        sizeUSDT: lvl.notionalUSDT,
        price: lvl.price,
        status: 'ACCEPTED',
        createdTime: now,
        updatedTime: now,
        intent: `GRID_LEVEL_${lvl.index + 1}`,
        profile: 'NEUTRAL_GRID',
        executionMode: bot.executionMode,
        botId: bot.botId,
        gridLevelIndex: lvl.index,
      });
    }
  }

  /**
   * Ensures the closest active grid levels around currentPrice that fit within the bot's allocated
   * margin budget have real Limit orders placed on OKX in LIVE mode, and trims any excess outer orders.
   */
  private async syncLiveGridWindow(bot: GridBotInstance): Promise<boolean> {
    if (bot.executionMode !== 'LIVE' || bot.status !== 'RUNNING') return false;

    let changed = false;
    const leverage = Math.max(1, Number(bot.config.leverage) || 1);
    const targetWindow = this.computeTargetLiveWindow(bot);
    const targetIndices = new Set(targetWindow.map((l) => l.index));

    // 1. Cancel any currently live orders that sit outside the bot's margin-capped target window
    const excessLiveLevels = bot.levels
      .filter(
        (l) =>
          l.status === 'OPEN_ORDER' &&
          l.activeOrderId &&
          !l.activeOrderId.startsWith('sim_') &&
          !targetIndices.has(l.index)
      )
      .sort((a, b) => Math.abs(b.price - bot.currentPrice) - Math.abs(a.price - bot.currentPrice));

    for (const excessLvl of excessLiveLevels) {
      const ordIdToCancel = excessLvl.activeOrderId;
      const linkIdToCancel = excessLvl.activeOrderLinkId;
      // Optimistically mark as virtual before await so no concurrent caller tries to cancel it again
      excessLvl.activeOrderId = `sim_${excessLvl.index}_${Date.now().toString(36)}`;
      excessLvl.activeOrderLinkId = undefined;
      const cancelled = await this.adapter
        .cancelOrder(bot.symbol, ordIdToCancel, linkIdToCancel)
        .catch(() => false);
      if (cancelled) {
        const estReleasedMargin = ((Number(excessLvl.notionalUSDT) || 0) / leverage) * 1.05;
        this.adapter.releaseAvailableMarginOptimistic?.(estReleasedMargin);
        changed = true;
      }
    }

    // 2. Place missing orders inside the target window if account available margin permits
    for (const lvl of targetWindow) {
      if (bot.status !== 'RUNNING') break;
      if (lvl.activeOrderId && !lvl.activeOrderId.startsWith('sim_')) continue;

      const isReducingOrder =
        (lvl.side === 'Sell' && bot.netPositionContracts > 0) ||
        (lvl.side === 'Buy' && bot.netPositionContracts < 0);

      const reqMargin = isReducingOrder
        ? 0
        : ((Number(lvl.notionalUSDT) || 0) / leverage) * 1.06;
      const availMargin = this.adapter.getAvailableMarginUSDT
        ? this.adapter.getAvailableMarginUSDT()
        : Infinity;

      if (!isReducingOrder && availMargin < reqMargin) {
        break;
      }

      // Always generate a fresh unique orderLinkId when submitting a virtual level to OKX to avoid sCode 51016
      const uniqueSuffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
      const orderLinkId = `${bot.botId}_L${lvl.index}_${uniqueSuffix}`;
      // Optimistically reserve activeOrderId before await so no concurrent caller can submit a duplicate order
      lvl.activeOrderId = `pending_${orderLinkId}`;
      lvl.activeOrderLinkId = orderLinkId;
      try {
        const res = await this.adapter.submitOrder({
          symbol: bot.symbol,
          side: lvl.side as 'Buy' | 'Sell',
          orderType: 'Limit',
          qty: lvl.qtyContracts,
          price: lvl.price,
          orderLinkId,
          leverage: bot.config.leverage,
          marginMode: bot.config.marginMode,
          posSide: isReducingOrder ? (lvl.side === 'Sell' ? 'long' : 'short') : undefined,
        });
        lvl.activeOrderId = res.orderId;
        lvl.activeOrderLinkId = res.orderLinkId || orderLinkId;
        changed = true;
      } catch (err: any) {
        lvl.activeOrderId = `sim_${orderLinkId}`;
        const errMsg = String(err?.message || err);
        if (
          errMsg.includes('51008') ||
          errMsg.toLowerCase().includes('insufficient') ||
          errMsg.includes('51016')
        ) {
          break;
        }
        this.journal.logAudit(
          'ORDER_REJECTED',
          `[GRID LIVE REPLENISH RESPINS] ${bot.symbol} Nivel #${lvl.index + 1} (${lvl.side} @ $${lvl.price}): ${errMsg}`
        );
      }
    }

    return changed;
  }

  /**
   * Handles real-time order updates from OKX Private WebSocket in LIVE mode.
   */
  public async onLiveOrderUpdate(rawOrder: any): Promise<void> {
    if (!rawOrder || rawOrder.state !== 'filled') return;
    const ordId = String(rawOrder.ordId || '');
    const clOrdId = String(rawOrder.clOrdId || '');
    if (!ordId && !clOrdId) return;

    for (const bot of this.getRunningBots()) {
      if (bot.executionMode !== 'LIVE') continue;
      for (let i = 0; i < bot.levels.length; i++) {
        const lvl = bot.levels[i];
        if (lvl.status !== 'OPEN_ORDER') continue;
        const cleanLinkId = (lvl.activeOrderLinkId || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 32);
        const isMatch =
          (ordId && lvl.activeOrderId === ordId) ||
          (clOrdId && cleanLinkId && clOrdId.startsWith(cleanLinkId.slice(0, 28)));
        if (isMatch) {
          // Wait up to 2.5s if onPriceTick is currently processing this symbol
          let waitedMs = 0;
          while (this.processingSymbols.has(bot.symbol) && waitedMs < 2500) {
            await new Promise((r) => setTimeout(r, 50));
            waitedMs += 50;
          }
          if (bot.status !== 'RUNNING' || lvl.status !== 'OPEN_ORDER') return;
          if (this.processingSymbols.has(bot.symbol)) return;

          this.processingSymbols.add(bot.symbol);
          try {
            const fillPx =
              parseFloat(rawOrder.avgPx || rawOrder.fillPx || rawOrder.px || String(lvl.price)) ||
              lvl.price;
            const lotFilter = await this.adapter.getInstrumentFilter(bot.symbol);
            const ctVal = lotFilter?.ctVal && lotFilter.ctVal > 0 ? lotFilter.ctVal : 1;
            await this.handleGridLevelFilled(bot, i, fillPx, ctVal, true);
            const currentPx = bot.currentPrice || fillPx;
            this.recalculateBotAccounting(bot, currentPx, ctVal);

            const riskAction = GridRiskManager.evaluateLiveBotRisk(bot, currentPx);
            if (riskAction.action !== 'NONE') {
              const statusMap: Record<string, GridBotInstance['status']> = {
                STOP_LOSS: 'STOP_LOSS_HIT',
                TAKE_PROFIT: 'TAKE_PROFIT_HIT',
                RANGE_BREAKOUT_STOP: 'STOP_LOSS_HIT',
              };
              await this.stopBot(
                bot.botId,
                riskAction.reason || 'Oprit automat de GridRiskManager',
                statusMap[riskAction.action] || 'STOPPED'
              );
            }
            this.persist();
          } finally {
            this.processingSymbols.delete(bot.symbol);
          }
          return;
        }
      }
    }
  }

  /**
   * Processes a live price tick for a symbol, matching resting grid levels, flipping orders,
   * updating PnL, and enforcing Stop Loss / Take Profit.
   */
  public async onPriceTick(symbol: string, price: number): Promise<void> {
    if (!price || price <= 0) return;
    const normSymbol = this.adapter.normalizeSymbol ? this.adapter.normalizeSymbol(symbol) : symbol;
    this.lastKnownPrices.set(normSymbol, price);

    const runningBots = this.getRunningBots().filter((b) => b.symbol === normSymbol);
    if (runningBots.length === 0) return;

    // Prevent concurrent tick executions on the same symbol from racing on cancel/submit
    if (this.processingSymbols.has(normSymbol)) return;
    this.processingSymbols.add(normSymbol);

    try {
      let stateChanged = false;
      const lotFilter = await this.adapter.getInstrumentFilter(normSymbol);
      const ctVal = lotFilter?.ctVal && lotFilter.ctVal > 0 ? lotFilter.ctVal : 1;
      const tickSize = lotFilter?.tickSize && lotFilter.tickSize > 0 ? lotFilter.tickSize : 0;

      for (const bot of runningBots) {
        bot.currentPrice = price;
        bot.updatedAt = Date.now();

        // Check if any resting Buy or Sell level was crossed
        for (let i = 0; i < bot.levels.length; i++) {
          const lvl = bot.levels[i];
          if (lvl.status !== 'OPEN_ORDER') continue;

          if (bot.executionMode === 'LIVE') {
            // In LIVE mode, only levels with an actual order placed on OKX can fill
            if (!lvl.activeOrderId || lvl.activeOrderId.startsWith('sim_') || !lvl.activeOrderLinkId) {
              continue;
            }
            // Check OKX order status when price touches/crosses the level (or within 0.08% proximity)
            const nearBuy = lvl.side === 'Buy' && price <= lvl.price * 1.0008;
            const nearSell = lvl.side === 'Sell' && price >= lvl.price * 0.9992;
            if (!nearBuy && !nearSell) continue;

            const ordStatus = await this.adapter
              .queryOrderStatus(bot.symbol, lvl.activeOrderLinkId, lvl.activeOrderId)
              .catch(() => null);

            if (ordStatus?.status === 'FILLED') {
              const confirmedFillPrice = ordStatus.avgPrice > 0 ? ordStatus.avgPrice : lvl.price;
              stateChanged = true;
              await this.handleGridLevelFilled(bot, i, confirmedFillPrice, ctVal, true);
            } else if (ordStatus?.status === 'CANCELLED') {
              lvl.status = 'CANCELLED';
              stateChanged = true;
            }
            continue;
          }

          // PAPER mode: simulated fill when crossed by at least 1 tickSize
          const buyTriggered = lvl.side === 'Buy' && price <= lvl.price - tickSize;
          const sellTriggered = lvl.side === 'Sell' && price >= lvl.price + tickSize;

          if (buyTriggered || sellTriggered) {
            stateChanged = true;
            await this.handleGridLevelFilled(bot, i, lvl.price, ctVal, false);
          }
        }

        // In LIVE mode, keep the sliding window of real OKX orders centered around currentPrice
        if (bot.executionMode === 'LIVE') {
          const windowChanged = await this.syncLiveGridWindow(bot).catch(() => false);
          if (windowChanged) stateChanged = true;
        }

        // Recompute Floating PnL & Net Totals
        this.recalculateBotAccounting(bot, price, ctVal);

        // Evaluate Risk Manager (SL / TP / Range Breakout)
        const riskAction = GridRiskManager.evaluateLiveBotRisk(bot, price);
        if (riskAction.action !== 'NONE') {
          stateChanged = true;
          const statusMap: Record<string, GridBotInstance['status']> = {
            STOP_LOSS: 'STOP_LOSS_HIT',
            TAKE_PROFIT: 'TAKE_PROFIT_HIT',
            RANGE_BREAKOUT_STOP: 'STOP_LOSS_HIT',
          };
          await this.stopBot(
            bot.botId,
            riskAction.reason || 'Oprit automat de GridRiskManager',
            statusMap[riskAction.action] || 'STOPPED'
          );
        }
      }

      if (stateChanged) {
        this.persist();
      }
    } finally {
      this.processingSymbols.delete(normSymbol);
    }
  }

  private async handleGridLevelFilled(
    bot: GridBotInstance,
    levelIdx: number,
    fillPrice: number,
    ctVal: number,
    _alreadyFilledOnExchange: boolean = false
  ) {
    const lvl = bot.levels[levelIdx];
    if (lvl.status !== 'OPEN_ORDER') return;

    const filledSide = lvl.side as 'Buy' | 'Sell';
    const qty = lvl.qtyContracts;
    const notional = fillPrice * qty * ctVal;
    const fee = calculateExecutionFee(notional, 'maker'); // 0.02% maker fee from shared/fees.ts

    lvl.fillCount += 1;
    lvl.lastFilledAt = Date.now();
    lvl.status = 'IDLE'; // Filled, now becomes the pivot level
    bot.totalFeesUSDT = parseFloat((bot.totalFeesUSDT + fee).toFixed(4));

    // Mark order as FILLED in journal with real fee paid
    if (lvl.activeOrderLinkId) {
      this.journal.recordOrder({
        id: lvl.activeOrderLinkId,
        symbol: bot.symbol,
        side: filledSide === 'Buy' ? 'BUY' : 'SELL',
        orderType: 'Limit',
        qty,
        sizeUSDT: parseFloat(notional.toFixed(2)),
        feeUSDT: fee,
        price: fillPrice,
        status: 'FILLED',
        createdTime: lvl.lastFilledAt,
        updatedTime: Date.now(),
        intent: `GRID_FILL_L${levelIdx + 1}`,
        profile: 'NEUTRAL_GRID',
        executionMode: bot.executionMode,
        botId: bot.botId,
        gridLevelIndex: levelIdx,
      });
    }

    // Update net inventory & check if this closes an opposing inventory leg (Grid Arbitrage Match!)
    const signedDelta = filledSide === 'Buy' ? qty : -qty;
    const prevNet = bot.netPositionContracts;
    const prevAvgHoldPrice = bot.avgHoldPrice;
    const nextNet = parseFloat((prevNet + signedDelta).toFixed(6));

    if (Math.abs(nextNet) < 1e-6) {
      bot.netPositionContracts = 0;
      bot.netPositionSide = 'FLAT';
      bot.avgHoldPrice = fillPrice;
    } else {
      if (Math.sign(nextNet) === Math.sign(prevNet) && Math.abs(nextNet) > Math.abs(prevNet)) {
        // Increasing inventory size: weighted average hold price
        bot.avgHoldPrice =
          (Math.abs(prevNet) * bot.avgHoldPrice + Math.abs(signedDelta) * fillPrice) /
          Math.abs(nextNet);
      } else if (Math.sign(nextNet) !== Math.sign(prevNet)) {
        bot.avgHoldPrice = fillPrice;
      }
      bot.netPositionContracts = nextNet;
      bot.netPositionSide = nextNet > 0 ? 'LONG' : 'SHORT';
    }

    // Credit realized Grid PnL ONLY when reducing existing inventory (from prevAvgHoldPrice, not grid spacing)
    const isReducingInventory =
      (filledSide === 'Sell' && prevNet > 0) ||
      (filledSide === 'Buy' && prevNet < 0);

    if (isReducingInventory) {
      const closedQty = Math.min(qty, Math.abs(prevNet));
      const realized = parseFloat(
        ((fillPrice - prevAvgHoldPrice) * closedQty * ctVal * (prevNet > 0 ? 1 : -1)).toFixed(4)
      );
      const grossProfit = realized;
      const netProfit = grossProfit; // Fees are tracked exclusively in bot.totalFeesUSDT
      const openLegFee = calculateExecutionFee(prevAvgHoldPrice * closedQty * ctVal, 'maker');
      const closeLegFee = calculateExecutionFee(fillPrice * closedQty * ctVal, 'maker');
      const pairFeeUSDT = parseFloat((openLegFee + closeLegFee).toFixed(4));

      bot.completedArbitrages += 1;
      bot.gridProfitUSDT = parseFloat((bot.gridProfitUSDT + netProfit).toFixed(4));
      lvl.realizedGridProfitUSDT = parseFloat((lvl.realizedGridProfitUSDT + netProfit).toFixed(4));

      const arbEvent: GridArbitrageEvent = {
        id: `arb_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        botId: bot.botId,
        symbol: bot.symbol,
        timestamp: Date.now(),
        openSide: filledSide === 'Sell' ? 'Buy' : 'Sell',
        openPrice: parseFloat(prevAvgHoldPrice.toFixed(6)),
        closePrice: fillPrice,
        qtyContracts: closedQty,
        grossProfitUSDT: grossProfit,
        feeUSDT: pairFeeUSDT,
        netProfitUSDT: netProfit,
        gridIndex: levelIdx,
      };
      this.journal.recordArbitrage(arbEvent);

      this.journal.logAudit(
        'GRID_ARBITRAGE_PROFIT',
        `[ARBITRAJ GRID #${bot.completedArbitrages}] ${bot.symbol} Nivel #${levelIdx + 1}: ${arbEvent.openSide} @ $${arbEvent.openPrice} ➔ ${filledSide} @ $${fillPrice} | Profit Realizat: ${arbEvent.netProfitUSDT >= 0 ? '+' : ''}$${arbEvent.netProfitUSDT.toFixed(4)} USDT (Fee 2-fill: $${pairFeeUSDT.toFixed(4)})`,
        arbEvent
      );
    }

    const neighborIdx = filledSide === 'Sell' ? levelIdx - 1 : levelIdx + 1;
    const neighbor = bot.levels[neighborIdx];

    if (neighbor) {
      // Place opposing flip order on the neighbor level!
      const flipSide: 'Buy' | 'Sell' = filledSide === 'Buy' ? 'Sell' : 'Buy';
      const now = Date.now();
      const flipOrderLinkId = `${bot.botId}_F${neighbor.index}_${now.toString(36)}`;

      // If neighbor had a prior live order on OKX, cancel it before placing the flipped order
      if (
        bot.executionMode === 'LIVE' &&
        neighbor.status === 'OPEN_ORDER' &&
        neighbor.activeOrderId &&
        !neighbor.activeOrderId.startsWith('sim_')
      ) {
        const cancelled = await this.adapter
          .cancelOrder(bot.symbol, neighbor.activeOrderId, neighbor.activeOrderLinkId)
          .catch(() => false);
        if (cancelled) {
          const leverage = Math.max(1, Number(bot.config.leverage) || 1);
          this.adapter.releaseAvailableMarginOptimistic?.(((Number(neighbor.notionalUSDT) || 0) / leverage) * 1.05);
        }
      }

      neighbor.side = flipSide;
      neighbor.status = 'OPEN_ORDER';
      neighbor.activeOrderLinkId = flipOrderLinkId;
      neighbor.activeOrderId = `sim_${flipOrderLinkId}`;

      this.journal.recordOrder({
        id: flipOrderLinkId,
        symbol: bot.symbol,
        side: flipSide === 'Buy' ? 'BUY' : 'SELL',
        orderType: 'Limit',
        qty: neighbor.qtyContracts,
        sizeUSDT: neighbor.notionalUSDT,
        price: neighbor.price,
        status: 'ACCEPTED',
        createdTime: now,
        updatedTime: now,
        intent: `GRID_FLIP_L${neighbor.index + 1}`,
        profile: 'NEUTRAL_GRID',
        executionMode: bot.executionMode,
        botId: bot.botId,
        gridLevelIndex: neighbor.index,
      });
    }

    // Ensure sliding window of active LIVE orders on OKX stays populated around currentPrice
    if (bot.executionMode === 'LIVE') {
      await this.syncLiveGridWindow(bot);
    }
  }

  private recalculateBotAccounting(bot: GridBotInstance, currentPrice: number, ctVal: number) {
    let buyCount = 0;
    let sellCount = 0;
    let liveBuyCount = 0;
    let liveSellCount = 0;
    for (const l of bot.levels) {
      if (l.status === 'OPEN_ORDER') {
        const isRealExchangeOrder = Boolean(l.activeOrderId && !l.activeOrderId.startsWith('sim_'));
        if (l.side === 'Buy') {
          buyCount++;
          if (isRealExchangeOrder) liveBuyCount++;
        } else if (l.side === 'Sell') {
          sellCount++;
          if (isRealExchangeOrder) liveSellCount++;
        }
      }
    }
    if (bot.executionMode === 'LIVE' && (liveBuyCount > 0 || liveSellCount > 0)) {
      bot.activeBuyOrders = liveBuyCount;
      bot.activeSellOrders = liveSellCount;
    } else {
      bot.activeBuyOrders = buyCount;
      bot.activeSellOrders = sellCount;
    }

    if (Math.abs(bot.netPositionContracts) > 1e-6) {
      const dir = bot.netPositionContracts > 0 ? 1 : -1;
      const uPnl =
        (currentPrice - bot.avgHoldPrice) * Math.abs(bot.netPositionContracts) * ctVal * dir;
      bot.floatingPnlUSDT = parseFloat(uPnl.toFixed(4));
    } else {
      bot.floatingPnlUSDT = 0;
    }

    bot.totalNetPnlUSDT = parseFloat(
      (bot.gridProfitUSDT + bot.floatingPnlUSDT - bot.totalFeesUSDT + bot.fundingEstimateUSDT).toFixed(4)
    );
    const margin = Math.max(1, bot.config.marginInvestedUSDT);
    bot.totalNetPnlPct = parseFloat(((bot.totalNetPnlUSDT / margin) * 100).toFixed(2));

    this.verifyBotAccountingInvariant(bot, currentPrice, ctVal);
  }

  /**
   * Verifies that bot.totalNetPnlUSDT matches:
   * (sum of cash flows of FILLED orders) + (net inventory at currentPrice) - (sum of fees of FILLED orders) + fundingEstimateUSDT
   * within $0.01 tolerance.
   */
  private verifyBotAccountingInvariant(bot: GridBotInstance, currentPrice: number, ctVal: number) {
    const filledOrders = this.journal.getFilledOrdersByBot(bot.botId);
    if (filledOrders.length === 0) return;

    let cashFlowUSDT = 0;
    let sumOrderFeesUSDT = 0;
    let netJournalContracts = 0;
    for (const ord of filledOrders) {
      const ordPrice = Number(ord.price) || 0;
      const ordQty = Number(ord.qty) || 0;
      const ordNotional = ordPrice * ordQty * ctVal;
      if (ord.side === 'BUY') {
        cashFlowUSDT -= ordNotional;
        netJournalContracts += ordQty;
      } else if (ord.side === 'SELL') {
        cashFlowUSDT += ordNotional;
        netJournalContracts -= ordQty;
      }
      sumOrderFeesUSDT += Number(ord.feeUSDT) || 0;
    }

    const reconciledDeltaContracts = bot.netPositionContracts - netJournalContracts;
    if (Math.abs(reconciledDeltaContracts) > 1e-6 && bot.avgHoldPrice > 0) {
      cashFlowUSDT -= reconciledDeltaContracts * bot.avgHoldPrice * ctVal;
    }

    const inventoryValueUSDT = bot.netPositionContracts * currentPrice * ctVal;
    const expectedNetPnlUSDT = parseFloat(
      (cashFlowUSDT + inventoryValueUSDT - sumOrderFeesUSDT + bot.fundingEstimateUSDT).toFixed(4)
    );
    const diff = Math.abs(bot.totalNetPnlUSDT - expectedNetPnlUSDT);

    if (diff > 0.01) {
      const prevWarnedDiff = this.lastWarnedDiscrepancyByBot.get(bot.botId) || 0;
      if (Math.abs(diff - prevWarnedDiff) > 0.005) {
        this.lastWarnedDiscrepancyByBot.set(bot.botId, diff);
        const msg = `[AVERTISMENT RECONCILIERE PNL] ${bot.symbol} (${bot.botId}): totalNetPnlUSDT ($${bot.totalNetPnlUSDT.toFixed(4)}) != CashFlow + Inventar - Fees ($${expectedNetPnlUSDT.toFixed(4)}), diferență $${diff.toFixed(4)} > $0.01`;
        console.warn(msg);
        this.journal.logAudit('RECONCILIATION_DISCREPANCY', msg, {
          botId: bot.botId,
          totalNetPnlUSDT: bot.totalNetPnlUSDT,
          expectedNetPnlUSDT,
          cashFlowUSDT: parseFloat(cashFlowUSDT.toFixed(4)),
          inventoryValueUSDT: parseFloat(inventoryValueUSDT.toFixed(4)),
          sumOrderFeesUSDT: parseFloat(sumOrderFeesUSDT.toFixed(4)),
          diff: parseFloat(diff.toFixed(4)),
        });
      }
    } else {
      this.lastWarnedDiscrepancyByBot.delete(bot.botId);
    }
  }

  /**
   * Updates Stop Loss / Take Profit parameters for a running or stopped bot.
   */
  public updateBotRiskSettings(
    botId: string,
    updates: {
      stopLossPct?: number;
      takeProfitPct?: number;
      lowerStopPrice?: number;
      upperStopPrice?: number;
      stopOnRangeBreakout?: boolean;
    }
  ): { success: boolean; bot?: GridBotInstance; error?: string } {
    const bot = this.bots.get(botId);
    if (!bot) return { success: false, error: 'Botul Grid nu a fost găsit.' };

    if (updates.stopLossPct !== undefined) bot.config.risk.stopLossPct = Number(updates.stopLossPct);
    if (updates.takeProfitPct !== undefined) bot.config.risk.takeProfitPct = Number(updates.takeProfitPct);
    if (updates.lowerStopPrice !== undefined) {
      bot.config.risk.lowerStopPrice = Number(updates.lowerStopPrice);
      bot.lowerStopPrice = Number(updates.lowerStopPrice);
    }
    if (updates.upperStopPrice !== undefined) {
      bot.config.risk.upperStopPrice = Number(updates.upperStopPrice);
      bot.upperStopPrice = Number(updates.upperStopPrice);
    }
    if (updates.stopOnRangeBreakout !== undefined) {
      bot.config.risk.stopOnRangeBreakout = Boolean(updates.stopOnRangeBreakout);
    }

    bot.updatedAt = Date.now();
    this.persist();

    this.journal.logAudit(
      'GRID_MODIFIED',
      `[SETĂRI RISC ACTUALIZATE] Bot ${bot.symbol} (${bot.botId}): SL -${bot.config.risk.stopLossPct}% ($${bot.lowerStopPrice} / $${bot.upperStopPrice}) | TP +${bot.config.risk.takeProfitPct}%`
    );

    return { success: true, bot };
  }

  /**
   * Stops a Grid Bot, cancels all open grid orders, and closes any remaining net inventory.
   */
  public async stopBot(
    botId: string,
    reason: string = 'Oprit manual de utilizator',
    finalStatus: GridBotInstance['status'] = 'STOPPED',
    awaitExchangeCleanup: boolean = true
  ): Promise<{ success: boolean; bot?: GridBotInstance; error?: string }> {
    const bot = this.bots.get(botId);
    if (!bot) return { success: false, error: 'Botul Grid nu a fost găsit.' };

    // Immediately mark bot as stopped so the 4s monitor loop cannot place new orders while stopping
    bot.status = finalStatus;
    bot.stopReason = reason;
    bot.stoppedAt = Date.now();
    bot.updatedAt = Date.now();

    const ordersToCancel: Array<{ orderId: string; orderLinkId?: string }> = [];
    for (const lvl of bot.levels) {
      if (
        bot.executionMode === 'LIVE' &&
        lvl.activeOrderId &&
        !lvl.activeOrderId.startsWith('sim_') &&
        !lvl.activeOrderId.startsWith('pending_')
      ) {
        ordersToCancel.push({
          orderId: lvl.activeOrderId,
          orderLinkId: lvl.activeOrderLinkId,
        });
      }
      if (lvl.status === 'OPEN_ORDER') {
        lvl.status = 'CANCELLED';
      }
    }

    const prevNet = bot.netPositionContracts;
    const hasNetInventory = Math.abs(prevNet) > 1e-6;
    const closeSide: 'Buy' | 'Sell' = prevNet > 0 ? 'Sell' : 'Buy';
    const closeQty = Math.abs(prevNet);
    const closePrice = bot.currentPrice;
    const closeAvgHold = bot.avgHoldPrice;
    const closeLinkId = `${bot.botId}_CLOSE_${Date.now().toString(36)}`;

    // Use cached or fast instrument filter for immediate accounting
    let ctVal = 1;
    try {
      const lotFilter = await Promise.race([
        this.adapter.getInstrumentFilter(bot.symbol),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 800)),
      ]);
      if (lotFilter?.ctVal && lotFilter.ctVal > 0) ctVal = lotFilter.ctVal;
    } catch {}

    if (hasNetInventory) {
      const closeNotional = closePrice * closeQty * ctVal;
      const closeFee = calculateExecutionFee(closeNotional, 'taker'); // 0.05% taker fee on market close
      const closeRealized = parseFloat(
        ((closePrice - closeAvgHold) * closeQty * ctVal * (prevNet > 0 ? 1 : -1)).toFixed(4)
      );

      bot.totalFeesUSDT = parseFloat((bot.totalFeesUSDT + closeFee).toFixed(4));
      bot.gridProfitUSDT = parseFloat((bot.gridProfitUSDT + closeRealized).toFixed(4));

      this.journal.recordOrder({
        id: closeLinkId,
        symbol: bot.symbol,
        side: closeSide === 'Buy' ? 'BUY' : 'SELL',
        orderType: 'Market',
        qty: closeQty,
        sizeUSDT: parseFloat(closeNotional.toFixed(2)),
        feeUSDT: closeFee,
        price: closePrice,
        status: 'FILLED',
        createdTime: Date.now(),
        updatedTime: Date.now(),
        intent: 'GRID_STOP_CLOSE_INVENTORY',
        profile: 'NEUTRAL_GRID',
        executionMode: bot.executionMode,
        botId: bot.botId,
      });
    }

    bot.activeBuyOrders = 0;
    bot.activeSellOrders = 0;
    bot.netPositionContracts = 0;
    bot.netPositionSide = 'FLAT';
    bot.floatingPnlUSDT = 0;
    this.recalculateBotAccounting(bot, bot.currentPrice, ctVal);

    this.persist();

    this.journal.logAudit(
      finalStatus === 'STOPPED' ? 'GRID_STOPPED' : 'GRID_RISK_TRIGGERED',
      `[BOT GRID OPRIT] ${bot.symbol} (${bot.botId}) | Status: ${finalStatus} | Motiv: ${reason} | Profit Grilă: $${bot.gridProfitUSDT.toFixed(2)} | PnL Total Net: $${bot.totalNetPnlUSDT.toFixed(2)} (${bot.totalNetPnlPct >= 0 ? '+' : ''}${bot.totalNetPnlPct}%)`
    );

    const runExchangeCleanup = async () => {
      if (bot.executionMode !== 'LIVE') return;

      // 1. Cancel all orders tracked in bot.levels
      const cancelledIds = new Set<string>();
      for (const ord of ordersToCancel) {
        cancelledIds.add(ord.orderId);
        await this.adapter
          .cancelOrder(bot.symbol, ord.orderId, ord.orderLinkId)
          .catch(() => {});
      }

      const hasOtherRunningBotOnSymbol = this.getRunningBots().some(
        (b) => b.symbol === bot.symbol && b.botId !== bot.botId
      );

      // 2. Sweep OKX directly for any remaining pending orders on this symbol (e.g. from retries or race)
      if (!hasOtherRunningBotOnSymbol && this.adapter.getOpenOrders) {
        try {
          const openOnExchange = await this.adapter.getOpenOrders(bot.symbol);
          for (const rawOrd of openOnExchange) {
            const instId = this.adapter.normalizeSymbol
              ? this.adapter.normalizeSymbol(rawOrd.instId || '')
              : String(rawOrd.instId || '');
            const ordId = String(rawOrd.ordId || '');
            const clOrdId = String(rawOrd.clOrdId || '');
            if (instId === bot.symbol && ordId && !cancelledIds.has(ordId)) {
              cancelledIds.add(ordId);
              await this.adapter.cancelOrder(bot.symbol, ordId, clOrdId).catch(() => {});
            }
          }
        } catch {}
      }

      // 3. Close the entire real position on OKX for this symbol
      let closedViaExchangePositions = false;
      if (!hasOtherRunningBotOnSymbol) {
        try {
          const livePositions = await this.adapter.getOpenPositions();
          const symbolPositions = livePositions.filter((p) => {
            const normP = this.adapter.normalizeSymbol
              ? this.adapter.normalizeSymbol(p.symbol)
              : p.symbol;
            return normP === bot.symbol && Math.abs(Number(p.size) || 0) > 0;
          });

          if (symbolPositions.length > 0) {
            closedViaExchangePositions = true;
            for (const pos of symbolPositions) {
              const posQty = Math.abs(Number(pos.size) || 0);
              const isShortPos = pos.posSide === 'short' || pos.side === 'Sell';
              const posCloseSide: 'Buy' | 'Sell' = isShortPos ? 'Buy' : 'Sell';
              const posSideTarget: 'long' | 'short' = isShortPos ? 'short' : 'long';
              try {
                await this.adapter.submitOrder({
                  symbol: bot.symbol,
                  side: posCloseSide,
                  orderType: 'Market',
                  qty: posQty,
                  orderLinkId: `${closeLinkId}_${posSideTarget}`,
                  reduceOnly: true,
                  posSide: posSideTarget,
                  leverage: bot.config.leverage,
                  marginMode: pos.mgnMode || bot.config.marginMode,
                });
              } catch (err: any) {
                this.journal.logAudit(
                  'ORDER_REJECTED',
                  `[GRID LIVE ÎNCHIDERE POZIȚIE] Eroare la închiderea poziției reale OKX (${posQty} contracte ${posSideTarget} ${bot.symbol}): ${err.message}`
                );
              }
            }
          }
        } catch {}
      }

      // Fallback if getOpenPositions failed but local state had inventory
      if (!closedViaExchangePositions && hasNetInventory) {
        try {
          await this.adapter.submitOrder({
            symbol: bot.symbol,
            side: closeSide,
            orderType: 'Market',
            qty: closeQty,
            orderLinkId: closeLinkId,
            reduceOnly: true,
            posSide: prevNet > 0 ? 'long' : 'short',
            leverage: bot.config.leverage,
            marginMode: bot.config.marginMode,
          });
        } catch (err: any) {
          this.journal.logAudit(
            'ORDER_REJECTED',
            `[GRID LIVE ÎNCHIDERE POZIȚIE] Eroare la închiderea inventarului net (${closeQty} contracte ${bot.symbol}): ${err.message}`
          );
        }
      }
    };

    if (awaitExchangeCleanup) {
      await runExchangeCleanup();
    } else {
      runExchangeCleanup().catch((err) =>
        console.error(`[NeutralGridEngine] Background cleanup error for ${bot.botId}:`, err)
      );
    }

    return { success: true, bot };
  }

  /**
   * Reconciles local Grid Bots with real OKX pending orders and open positions:
   * 1. Cancels any lingering open orders on OKX for symbols whose bots are stopped (STOP_LOSS_HIT, TAKE_PROFIT_HIT, STOPPED).
   * 2. Cancels duplicate/orphan open orders on OKX for running bots that are not tracked in bot.levels.
   * 3. Closes any lingering open positions on OKX for symbols whose bots are stopped.
   * 4. Syncs running bots' netPositionContracts and avgHoldPrice with real OKX positions.
   */
  public async reconcileWithExchange(): Promise<void> {
    if (this.isReconciling || !this.adapter.hasCredentials()) return;
    this.isReconciling = true;

    try {
      const [openOrders, openPositions] = await Promise.all([
        this.adapter.getOpenOrders ? this.adapter.getOpenOrders().catch(() => []) : Promise.resolve([]),
        this.adapter.getOpenPositions().catch(() => []),
      ]);

      const allBots = this.getAllBots();
      const runningBotsBySymbol = new Map<string, GridBotInstance>();
      const stoppedBotsBySymbol = new Map<string, GridBotInstance>();

      for (const b of allBots) {
        if (b.status === 'RUNNING' && b.executionMode === 'LIVE') {
          runningBotsBySymbol.set(b.symbol, b);
        } else if (b.status !== 'RUNNING') {
          if (!stoppedBotsBySymbol.has(b.symbol)) {
            stoppedBotsBySymbol.set(b.symbol, b);
          }
        }
      }

      let stateChanged = false;

      // 1. Reconcile Open Orders on OKX
      for (const rawOrd of openOrders) {
        const instId = this.adapter.normalizeSymbol
          ? this.adapter.normalizeSymbol(rawOrd.instId || '')
          : String(rawOrd.instId || '');
        const ordId = String(rawOrd.ordId || '');
        const clOrdId = String(rawOrd.clOrdId || '');
        if (!instId || !ordId) continue;

        const runningBot = runningBotsBySymbol.get(instId);
        if (!runningBot) {
          // No running bot on this symbol! If it belongs to a stopped bot or is a grid order, cancel it immediately
          if (stoppedBotsBySymbol.has(instId) || clOrdId.toLowerCase().startsWith('grid')) {
            const cancelled = await this.adapter.cancelOrder(instId, ordId, clOrdId).catch(() => false);
            if (cancelled) {
              this.journal.logAudit(
                'FORCE_SYNC',
                `[RECONCILIERE OKX] Ordin deschis rezidual anulat pe ${instId} (${rawOrd.side} @ $${rawOrd.px}, ordId: ${ordId}) deoarece botul este oprit.`
              );
            }
          }
          continue;
        }

        // Running bot exists on this symbol: skip if symbol is currently mid-tick or has pending order submissions
        if (
          this.processingSymbols.has(instId) ||
          runningBot.levels.some((l) => l.activeOrderId?.startsWith('pending_'))
        ) {
          continue;
        }

        const trackedIds = new Set(
          runningBot.levels
            .filter(
              (l) =>
                l.status === 'OPEN_ORDER' &&
                l.activeOrderId &&
                !l.activeOrderId.startsWith('sim_')
            )
            .map((l) => l.activeOrderId as string)
        );

        if (!trackedIds.has(ordId)) {
          const ordPx = parseFloat(rawOrd.px || '0') || 0;
          const matchingSimLevel = runningBot.levels.find(
            (l) =>
              l.status === 'OPEN_ORDER' &&
              (!l.activeOrderId || l.activeOrderId.startsWith('sim_')) &&
              Math.abs(l.price - ordPx) <= Math.max(1e-6, l.price * 0.0005)
          );

          if (matchingSimLevel) {
            matchingSimLevel.activeOrderId = ordId;
            matchingSimLevel.activeOrderLinkId = clOrdId || matchingSimLevel.activeOrderLinkId;
            trackedIds.add(ordId);
            stateChanged = true;
          } else {
            // Duplicate or orphan order on a running bot -> cancel it on OKX to free margin
            const cancelled = await this.adapter.cancelOrder(instId, ordId, clOrdId).catch(() => false);
            if (cancelled) {
              const leverage = Math.max(1, Number(runningBot.config.leverage) || 1);
              const estNotional = ordPx * (parseFloat(rawOrd.sz || '1') || 1);
              this.adapter.releaseAvailableMarginOptimistic?.((estNotional / leverage) * 1.05);
              this.journal.logAudit(
                'FORCE_SYNC',
                `[RECONCILIERE OKX] Ordin duplicat/orfan anulat pe ${instId} (${rawOrd.side} @ $${rawOrd.px}, ordId: ${ordId}).`
              );
            }
          }
        }
      }

      // 2. Reconcile Open Positions on OKX
      for (const pos of openPositions) {
        const instId = this.adapter.normalizeSymbol
          ? this.adapter.normalizeSymbol(pos.symbol || '')
          : String(pos.symbol || '');
        const contracts = Math.abs(Number(pos.size) || 0);
        if (!instId || contracts <= 0) continue;

        const isShortPos = pos.posSide === 'short' || pos.side === 'Sell';
        const posSideTarget: 'long' | 'short' = isShortPos ? 'short' : 'long';

        const runningBot = runningBotsBySymbol.get(instId);
        if (!runningBot) {
          const stoppedBot = stoppedBotsBySymbol.get(instId);
          if (stoppedBot) {
            const closeSide: 'Buy' | 'Sell' = isShortPos ? 'Buy' : 'Sell';
            const closeLinkId = `${stoppedBot.botId}_RECON_${Date.now().toString(36)}`;
            try {
              await this.adapter.submitOrder({
                symbol: instId,
                side: closeSide,
                orderType: 'Market',
                qty: contracts,
                orderLinkId: closeLinkId,
                reduceOnly: true,
                posSide: posSideTarget,
                leverage: stoppedBot.config.leverage,
                marginMode: pos.mgnMode || stoppedBot.config.marginMode,
              });
              this.journal.logAudit(
                'FORCE_SYNC',
                `[RECONCILIERE OKX] Poziție reziduală închisă la piață pe ${instId} (${contracts} contracte ${posSideTarget.toUpperCase()}) rămasă după oprirea botului (${stoppedBot.status}).`
              );
            } catch (err: any) {
              console.warn(`[NeutralGridEngine] Failed to close residual position on ${instId}:`, err?.message || err);
            }
          }
          continue;
        }

        // Running bot exists: sync its netPositionContracts and avgHoldPrice with real OKX position
        if (!this.processingSymbols.has(instId)) {
          const signedExchangeContracts = isShortPos ? -contracts : contracts;
          const posDiff = Math.abs(runningBot.netPositionContracts - signedExchangeContracts);
          const pxDiff =
            pos.avgPrice > 0 ? Math.abs(runningBot.avgHoldPrice - pos.avgPrice) : 0;

          if (posDiff > 1e-6 || pxDiff > 1e-4) {
            runningBot.netPositionContracts = signedExchangeContracts;
            runningBot.netPositionSide = isShortPos ? 'SHORT' : 'LONG';
            if (pos.avgPrice > 0) {
              runningBot.avgHoldPrice = pos.avgPrice;
            }
            const lotFilter = await this.adapter.getInstrumentFilter(instId).catch(() => null);
            const ctVal = lotFilter?.ctVal && lotFilter.ctVal > 0 ? lotFilter.ctVal : 1;
            const currentPx = runningBot.currentPrice || pos.markPrice || pos.avgPrice;
            this.recalculateBotAccounting(runningBot, currentPx, ctVal);
            stateChanged = true;
          }
        }
      }

      if (stateChanged) {
        this.persist();
      }
    } catch (err: any) {
      console.warn('[NeutralGridEngine] reconcileWithExchange warning:', err?.message || err);
    } finally {
      this.isReconciling = false;
    }
  }

  public deleteStoppedBot(botId: string): boolean {
    const bot = this.bots.get(botId);
    if (!bot) return false;
    if (bot.status === 'RUNNING') return false;
    this.bots.delete(botId);
    this.persist();
    return true;
  }

  public clearAllBots() {
    this.bots.clear();
    this.persist();
  }

  private persist() {
    this.journal.saveBots(this.getAllBots());
  }
}
