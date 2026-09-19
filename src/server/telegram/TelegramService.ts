import {
  BotStatusResponse,
  Position,
  OrderRecord,
  AuditLog,
  OrderSide,
  AuditLogType,
} from '../../shared/types';

export interface ITelegramTradeBot {
  getStatus(): BotStatusResponse;
  getClosedPositions(): Position[];
  getActivePositions(): Position[];
  getOrders(): OrderRecord[];
  getAuditLogs(): AuditLog[];
  toggleKillSwitch(): Promise<{ success: boolean; killSwitchEngaged: boolean }> | { success: boolean; killSwitchEngaged: boolean };
  executeManualOrder?(symbol: string, side: OrderSide, qty?: number): Promise<{ success: boolean; error?: string }>;
  closePositionManually(symbol: string): Promise<{ success: boolean; error?: string }>;
  setExecutionMode?(mode: string): Promise<{ success: boolean; error?: string }>;
}

export class TelegramService {
  private botToken: string;
  private chatId: string;
  private isPolling: boolean = false;
  private lastUpdateId: number = 0;
  private pollInterval?: NodeJS.Timeout;
  private hourlyInterval?: NodeJS.Timeout;
  private lastHourlyCheckTime: number = Date.now();
  private botDelegate?: ITelegramTradeBot;
  private lastSentSentimentAlert: string = '';
  private lastHourlyHour: number = new Date().getHours();

  constructor() {
    this.botToken = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
    this.chatId = (process.env.TELEGRAM_CHAT_ID || '').trim();
  }

  public setBotDelegate(delegate: ITelegramTradeBot) {
    this.botDelegate = delegate;
  }

  public updateCredentials(token?: string, chatId?: string) {
    if (token) this.botToken = token.trim();
    if (chatId) this.chatId = chatId.trim();
    if (this.botToken && !this.pollInterval) {
      this.startPolling();
    }
  }

  public isConfigured(): boolean {
    return Boolean(this.botToken && this.chatId);
  }

  public isTokenAvailable(): boolean {
    return Boolean(this.botToken);
  }

  public start() {
    if (this.botToken) {
      this.startPolling();
    } else {
      console.log('[TelegramService] TELEGRAM_BOT_TOKEN not configured. Alerts on standby.');
    }

    // Schedule hourly report check every 60 seconds (checks for hour boundary change)
    if (this.hourlyInterval) clearInterval(this.hourlyInterval);
    this.hourlyInterval = setInterval(() => {
      this.checkHourlySchedule().catch((err) => {
        console.warn('[TelegramService] Hourly check background warning:', err.message || err);
      });
    }, 60000);
  }

  public stop() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = undefined;
    }
    if (this.hourlyInterval) {
      clearInterval(this.hourlyInterval);
      this.hourlyInterval = undefined;
    }
  }

  /**
   * Safe asynchronous send message.
   * Completely isolated: will NEVER throw or interrupt calling trade loops.
   */
  public async sendMessage(text: string, targetChatId?: string): Promise<boolean> {
    const toChat = targetChatId || this.chatId;
    if (!this.botToken || !toChat) {
      return false;
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 7000);

      const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: toChat,
          text,
          disable_web_page_preview: true,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        console.warn('[TelegramService] Send error:', errorData);
        return false;
      }
      return true;
    } catch (err: any) {
      console.warn('[TelegramService] Network error sending message (safely ignored):', err.message || err);
      return false;
    }
  }

  /**
   * Handle important events (reset, killswitch, position open/close, sentiment alerts)
   */
  public notifyEvent(type: AuditLogType, message: string, details?: any) {
    if (!this.isConfigured()) return;

    // Run completely in background
    setTimeout(async () => {
      try {
        if (type === 'PAPER_RESET') {
          await this.sendMessage(
            `🔄 REZETARE CONT PAPER\n\n` +
            `Capitalul de simulare a fost resetat la $200.00 USDT.\n` +
            `Pozițiile și istoricul local au fost curățate.`
          );
        } else if (type === 'KILL_SWITCH_ENGAGED') {
          await this.sendMessage(
            `🚨 EMERGENCY KILL SWITCH ACTIVAT!\n\n` +
            `Toate pozițiile active au fost lichidate de urgență.\n` +
            `Intrările automate sunt blocate până la dezactivare.`
          );
        } else if (type === 'KILL_SWITCH_DISENGAGED') {
          await this.sendMessage(
            `✅ KILL SWITCH DEZACTIVAT\n\n` +
            `Tranzacționarea automată a fost reluată conform profilului activ.`
          );
        }
      } catch (err: any) {
        console.warn('[TelegramService] notifyEvent suppressed error:', err.message || err);
      }
    }, 10);
  }

  /**
   * Check and trigger hourly report
   */
  private async checkHourlySchedule() {
    const now = new Date();
    const currentHour = now.getHours();

    if (currentHour !== this.lastHourlyHour) {
      const prevHour = this.lastHourlyHour;
      this.lastHourlyHour = currentHour;
      
      const prevHourStr = `${prevHour.toString().padStart(2, '0')}:00`;
      const currHourStr = `${currentHour.toString().padStart(2, '0')}:00`;

      await this.sendHourlyReport(prevHourStr, currHourStr);

      // Daily summary at 21:00 or end of day
      if (currentHour === 21) {
        await this.sendDailySummary();
      }
    }
  }

  /**
   * Generates and dispatches the comprehensive hourly report:
   * 📊 RAPORT ORAR — HH:00–HH:00
   */
  public async sendHourlyReport(startHour: string = '12:00', endHour: string = '13:00') {
    if (!this.botDelegate) return;
    const status = this.botDelegate.getStatus();
    const closed = this.botDelegate.getClosedPositions();
    const active = this.botDelegate.getActivePositions();
    const scanner = status.scannerStats;
    const profile = status.profileConfig;

    // Filter trades in the last hour
    const oneHourAgo = Date.now() - 3600000;
    const hourTrades = closed.filter((p) => (p.exitTime || 0) >= oneHourAgo);

    let grossPnl = 0;
    let fees = 0;
    let winCount = 0;
    let sumWinPct = 0;
    let sumLossPct = 0;
    let lossCount = 0;

    for (const t of hourTrades) {
      const p = t.pnl || 0;
      const g = t.grossPnl !== undefined ? t.grossPnl : p;
      grossPnl += g;
      fees += (t.entryFee || 0) + (t.exitFee || 0);
      const pct = t.pnlPct || 0;
      if (p > 0) {
        winCount++;
        sumWinPct += pct;
      } else if (p < 0) {
        lossCount++;
        sumLossPct += Math.abs(pct);
      }
    }

    const netPnl = grossPnl - fees;
    const tradesCount = hourTrades.length;
    const winRate = tradesCount > 0 ? ((winCount / tradesCount) * 100).toFixed(1) : '0.0';
    const avgWin = winCount > 0 ? (sumWinPct / winCount).toFixed(2) : '0.00';
    const avgLoss = lossCount > 0 ? (sumLossPct / lossCount).toFixed(2) : '0.00';
    const netPnlSign = netPnl >= 0 ? '+' : '';
    const grossPnlSign = grossPnl >= 0 ? '+' : '';

    // Active positions breakdown
    const maxPositions = profile?.maxOpenPositions ?? 3;
    let positionsText = '';
    if (active.length > 0) {
      positionsText = active
        .map((p) => {
          const symClean = p.symbol.replace('-SWAP', '').replace('-', '/');
          const pnlSign = (p.pnl || 0) >= 0 ? '+' : '';
          const pnlPctSign = (p.pnlPct || 0) >= 0 ? '+' : '';
          const dur = p.holdingTimeMinutes ? `${Math.round(p.holdingTimeMinutes)}m` : 'nou';
          const pnlVal = (p.pnl || 0).toFixed(2);
          const pnlPctVal = (p.pnlPct || 0).toFixed(2);
          const currP = p.currentPrice ? `$${p.currentPrice.toFixed(2)}` : `$${p.entryPrice.toFixed(2)}`;
          return `• ${symClean} [${p.side}] | Preț: ${currP} | PnL: ${pnlPctSign}${pnlPctVal}% (${pnlSign}${pnlVal} USDT) | Durată: ${dur}`;
        })
        .join('\n');
    } else {
      positionsText = '• Nicio poziție deschisă în acest moment (100% lichiditate liberă)';
    }

    // Executions summary
    let executionsText = '';
    if (tradesCount > 0) {
      executionsText =
        `• Tranzacții finalizate: ${tradesCount} (Win Rate: ${winRate}%)\n` +
        `• PnL Brut: ${grossPnlSign}${grossPnl.toFixed(2)} USDT | Comisioane: -${fees.toFixed(2)} USDT | PnL Net: ${netPnlSign}${netPnl.toFixed(2)} USDT\n` +
        `• Profit mediu: +${avgWin}% | Pierdere medie: -${avgLoss}%`;

      const topTrades = [...hourTrades]
        .sort((a, b) => (b.pnlPct || 0) - (a.pnlPct || 0))
        .slice(0, 3);
      const medals = ['🥇', '🥈', '🥉'];
      const tradeList = topTrades
        .map((p, idx) => {
          const sign = (p.pnlPct || 0) >= 0 ? '+' : '';
          return `  ${medals[idx] || '•'} ${p.symbol.replace('-SWAP', '').replace('-', '/')} ${sign}${(p.pnlPct || 0).toFixed(2)}% (${(p.pnl || 0).toFixed(2)} USDT)`;
        })
        .join('\n');
      executionsText += `\n${tradeList}`;
    } else {
      executionsText = '• 0 tranzacții finalizate în acest interval\n• Motiv: piețele scanate nu au atins pragul tehnic de momentum';
    }

    // Scanner & market radar (NO AI, purely exchange metrics)
    const universeCount = scanner?.universeCount || 467;
    const candidatesCount = scanner?.candidatesCount || 0;
    const topOpportunities = scanner?.topOpportunities || [];
    const radarCandidates = topOpportunities.slice(0, 3);
    let radarText = '';
    if (radarCandidates.length > 0) {
      radarText = radarCandidates
        .map((o, idx) => {
          const symClean = o.symbol.replace('-SWAP', '').replace('-', '/');
          const changeSign = (o.priceChange24hPct || 0) >= 0 ? '+' : '';
          return `  ${idx + 1}. ${symClean} — Var 24h: ${changeSign}${(o.priceChange24hPct || 0).toFixed(2)}% | Scor: ${Math.round(o.score)}/100`;
        })
        .join('\n');
    } else {
      radarText = '  (Scanerul evaluează continuu piețele la fiecare 3 secunde)';
    }

    // Macro context
    const regime = status.marketRegime || 'BTC: Neutru';
    const sentimentStr = status.marketSentiment || 'OKX NEUTRU';
    const sentimentThreshold = profile?.sentimentThreshold ?? 1.5;
    const modeStr = status.executionMode === 'LIVE' ? '🔴 LIVE OKX' : '🟢 PAPER SIMULATION (Prețuri Reale OKX)';
    const profileName = profile?.type || 'SCALP';
    const totalProfit = status.totalProfit || 0;
    const totalProfitPct = status.totalProfitPct || 0;
    const totalProfitSign = totalProfit >= 0 ? '+' : '';
    const freeBal = status.freeBalance !== undefined ? status.freeBalance : status.equity;
    const marginInv = status.marginInvested || 0;
    const unPnl = status.unrealizedPnL || 0;
    const unPnlSign = unPnl >= 0 ? '+' : '';

    const text =
      `📊 RAPORT ORAR — ${startHour}–${endHour}\n\n` +
      `💰 CAPITAL & PORTOFOLIU\n` +
      `• Capital Total (Equity): ${status.equity.toFixed(2)} USDT\n` +
      `• Sold Disponibil: ${freeBal.toFixed(2)} USDT\n` +
      `• Marjă Utilizată: ${marginInv.toFixed(2)} USDT\n` +
      `• PnL Nerealizat: ${unPnlSign}${unPnl.toFixed(2)} USDT\n` +
      `• PnL Total Sesiune: ${totalProfitSign}${totalProfit.toFixed(2)} USDT (${totalProfitSign}${totalProfitPct.toFixed(2)}%)\n\n` +
      `📈 POZIȚII ACTIVE (${active.length}/${maxPositions} max)\n` +
      `${positionsText}\n\n` +
      `📋 TRANZACȚII ÎN ULTIMA ORĂ\n` +
      `${executionsText}\n\n` +
      `⚡ SCANER OKX & RADAR PIAȚĂ\n` +
      `• Univers scanat: ${universeCount} perechi OKX\n` +
      `• Candidați calificați: ${candidatesCount} perechi\n` +
      `• Top monede pe radar:\n` +
      `${radarText}\n\n` +
      `🌐 CONTEXT & PARAMETRI\n` +
      `• Regim BTC: ${regime}\n` +
      `• Sentiment Global OKX: ${sentimentStr} (Prag: ±${sentimentThreshold.toFixed(1)}%)\n` +
      `• Profil: ${profileName} [TP: +${profile?.takeProfitPct || 2}% | SL: -${profile?.hardStopLossPct || 1}%]\n` +
      `• Mod Execuție: ${modeStr}\n` +
      `• Stare Bot: ${status.config.killSwitchEngaged ? '⏸️ PAUZĂ (Kill Switch activ)' : '✅ ACTIVĂ (Tranzacționare în curs)'}`;

    await this.sendMessage(text);
  }

  /**
   * Generates and dispatches daily summary:
   * 🌙 REZUMAT ZILNIC
   */
  public async sendDailySummary() {
    if (!this.botDelegate) return;
    const status = this.botDelegate.getStatus();
    const closed = this.botDelegate.getClosedPositions();
    const active = this.botDelegate.getActivePositions();
    const profile = status.profileConfig;

    const last24h = Date.now() - 86400000;
    const dayTrades = closed.filter((p) => (p.exitTime || 0) >= last24h);

    let grossPnl = 0;
    let fees = 0;
    let winCount = 0;
    let sumWinPct = 0;
    let sumLossPct = 0;
    let lossCount = 0;

    for (const t of dayTrades) {
      const p = t.pnl || 0;
      const g = t.grossPnl !== undefined ? t.grossPnl : p;
      grossPnl += g;
      fees += (t.entryFee || 0) + (t.exitFee || 0);
      const pct = t.pnlPct || 0;
      if (p > 0) {
        winCount++;
        sumWinPct += pct;
      } else if (p < 0) {
        lossCount++;
        sumLossPct += Math.abs(pct);
      }
    }

    const netPnl = grossPnl - fees;
    const tradesCount = dayTrades.length;
    const winRate = tradesCount > 0 ? ((winCount / tradesCount) * 100).toFixed(1) : '0.0';
    const avgWin = winCount > 0 ? (sumWinPct / winCount).toFixed(2) : '0.00';
    const avgLoss = lossCount > 0 ? (sumLossPct / lossCount).toFixed(2) : '0.00';
    const netPnlSign = netPnl >= 0 ? '+' : '';
    const grossPnlSign = grossPnl >= 0 ? '+' : '';

    const text =
      `🌙 REZUMAT ZILNIC (24H)\n\n` +
      `💰 BILANȚ CAPITAL\n` +
      `• Capital Actual (Equity): ${status.equity.toFixed(2)} USDT\n` +
      `• Sold Disponibil: ${(status.freeBalance || 0).toFixed(2)} USDT\n` +
      `• PnL Total Realizat: ${(status.totalProfit || 0) >= 0 ? '+' : ''}${(status.totalProfit || 0).toFixed(2)} USDT\n\n` +
      `📊 PERFORMANȚĂ 24H\n` +
      `• Tranzacții Închise: ${tradesCount}\n` +
      `• Rata de Succes (Win Rate): ${winRate}%\n` +
      `• PnL Brut: ${grossPnlSign}${grossPnl.toFixed(2)} USDT\n` +
      `• Comisioane / Taxe: -${fees.toFixed(2)} USDT\n` +
      `• PnL NET: ${netPnlSign}${netPnl.toFixed(2)} USDT\n` +
      (tradesCount > 0 ? `• Câștig mediu: +${avgWin}% | Pierdere medie: -${avgLoss}%\n\n` : `\n`) +
      `🌐 OPERAȚIONAL\n` +
      `• Poziții Active Deschise: ${active.length}\n` +
      `• Profil: ${profile?.type || 'SCALP'}\n` +
      `• Sentiment Global OKX: ${status.marketSentiment || 'NEUTRU'}\n` +
      `• Mod: ${status.executionMode === 'LIVE' ? '🔴 LIVE OKX' : '🟢 PAPER SIMULATION'}`;

    await this.sendMessage(text);
  }

  /**
   * Sends the exact pinned command guide
   */
  public getCommandGuideText(): string {
    return (
      `📌 GHID & LISTĂ COMENZI BOT TradeBot 5\n\n` +
      `Păstrează sau fixează (Pin) acest mesaj în chat pentru acces rapid!\n\n` +
      `📊 Interogare & Stare:\n` +
      `• /portofoliu sau /portofolio - Capital, equity & performanță PnL\n` +
      `• /stare sau /status - Stare sistem, modul active & circuit breaker\n` +
      `• /pozitii sau /positions - Poziții deschise curente & PnL\n` +
      `• /jurnal sau /tranzactii - Ultima istorie de tranzacționare\n\n` +
      `⚙️ Control Execuție & Moduri:\n` +
      `• /mod sau /mode - Vizualizează sau schimbă modul de execuție (/mod paper, /mod testnet, /mod live)\n` +
      `• /pauza sau /pause - Oprește temporar tranzacționarea automată\n` +
      `• /porneste sau /resume - Repornește tranzacționarea automată\n\n` +
      `🛒 Tranzacționare Manuală Directă:\n` +
      `• /cumpara [SIMBOL] [CANTITATE]\n` +
      `  Exemplu: /cumpara BTCUSDT 0.005\n` +
      `• /vinde [SIMBOL] [CANTITATE]\n` +
      `  Exemplu: /vinde BTCUSDT 0.005\n\n` +
      `ℹ️ Ajutor:\n` +
      `• /ajutor, /help, /comenzi sau /ghid - Trimite din nou această listă.\n\n` +
      `💡 Sfat: Apasă lung pe acest mesaj și selectează Pin / Fixează pentru a-l avea permanent la începutul conversației!`
    );
  }

  /**
   * Background polling for Telegram commands via getUpdates
   */
  private startPolling() {
    if (this.pollInterval) clearInterval(this.pollInterval);
    this.pollInterval = setInterval(async () => {
      if (this.isPolling || !this.botToken) return;
      this.isPolling = true;

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 6000);

        const url = `https://api.telegram.org/bot${this.botToken}/getUpdates?offset=${this.lastUpdateId}&timeout=3`;
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);

        if (res.ok) {
          const data = await res.json();
          if (data && data.ok && Array.isArray(data.result)) {
            for (const update of data.result) {
              this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id + 1);
              if (update.message && update.message.text) {
                await this.handleIncomingMessage(update.message);
              }
            }
          }
        }
      } catch (err: any) {
        // Polling network error gracefully ignored
      } finally {
        this.isPolling = false;
      }
    }, 3500);
  }

  /**
   * Process incoming Telegram commands
   */
  private async handleIncomingMessage(message: any) {
    const rawText = (message.text || '').trim();
    const chatId = String(message.chat?.id);
    if (!chatId) return;

    // Auto-pair chat ID if not configured
    if (!this.chatId) {
      this.chatId = chatId;
      console.log(`[TelegramService] Paired with Chat ID: ${chatId}`);
    }

    const text = rawText.toLowerCase();
    const parts = rawText.split(/\s+/);
    const cmd = parts[0]?.toLowerCase() || '';

    if (
      cmd === '/start' ||
      cmd === '/help' ||
      cmd === '/ajutor' ||
      cmd === '/comenzi' ||
      cmd === '/ghid'
    ) {
      await this.sendMessage(this.getCommandGuideText(), chatId);
      return;
    }

    if (!this.botDelegate) {
      await this.sendMessage('⚠️ TradeBot nu este complet inițializat. Reîncearcă în câteva secunde.', chatId);
      return;
    }

    const status = this.botDelegate.getStatus();

    // /portofoliu or /portofolio
    if (cmd === '/portofoliu' || cmd === '/portofolio') {
      const eq = status.equity.toFixed(2);
      const free = (status.freeBalance || 0).toFixed(2);
      const margin = (status.marginInvested || 0).toFixed(2);
      const unrealized = (status.unrealizedPnL || 0).toFixed(2);
      const profit = (status.totalProfit || 0).toFixed(2);
      const profitPct = (status.totalProfitPct || 0).toFixed(2);
      const profitSign = (status.totalProfit || 0) >= 0 ? '+' : '';
      const perf = status.performanceMetrics;
      const winRate = perf ? perf.winRate : 0;

      const reply =
        `📊 PORTOFOLIU & CAPITAL\n\n` +
        `• Capital Total (Equity): ${eq} USDT\n` +
        `• Sold Disponibil (Free): ${free} USDT\n` +
        `• Marjă Utilizată: ${margin} USDT\n` +
        `• PnL Nerealizat: ${unrealized} USDT\n` +
        `• PnL Total Realizat: ${profitSign}${profit} USDT (${profitSign}${profitPct}%)\n` +
        `• Win Rate Total: ${winRate}%\n` +
        `• Mod Curent: [${status.executionMode}] | Profil: ${status.profileConfig?.type}`;

      await this.sendMessage(reply, chatId);
      return;
    }

    // /stare or /status
    if (cmd === '/stare' || cmd === '/status') {
      const ks = status.config.killSwitchEngaged;
      const state = status.state;
      const regime = status.marketRegime || 'BTC: N/A';
      const sentiment = status.marketSentiment || 'NEUTRU';
      const openCount = status.positions.length;
      const maxPos = status.profileConfig.maxOpenPositions;

      const reply =
        `⚙️ STARE SISTEM TradeBot 5\n\n` +
        `• Stare Motor: ${state}\n` +
        `• Circuit Breaker (Kill Switch): ${ks ? '🚨 ACTIVAT (STOP)' : '✅ INACTIV (NORMAL)'}\n` +
        `• Mod Execuție: [${status.executionMode}]\n` +
        `• Profil Activ: ${status.profileConfig?.type}\n` +
        `• Poziții Deschise: ${openCount} / ${maxPos} max\n` +
        `• Sentiment Global: ${sentiment}\n` +
        `• Regim Piață: ${regime}\n` +
        `• Conexiune Exchange: ${status.connected ? '🟢 Conectat' : '🔴 Deconectat'}`;

      await this.sendMessage(reply, chatId);
      return;
    }

    // /pozitii or /positions
    if (cmd === '/pozitii' || cmd === '/positions') {
      const positions = this.botDelegate.getActivePositions();
      if (positions.length === 0) {
        await this.sendMessage('📌 Nu există poziții deschise în acest moment.', chatId);
        return;
      }

      let reply = `📋 POZIȚII ACTIVE (${positions.length}):\n\n`;
      positions.forEach((p, idx) => {
        const pnl = (p.pnl || 0).toFixed(2);
        const pnlPct = (p.pnlPct || 0).toFixed(2);
        const sign = (p.pnl || 0) >= 0 ? '+' : '';
        const icon = (p.pnl || 0) >= 0 ? '🟢' : '🔴';
        reply += `${idx + 1}. ${icon} ${p.symbol} (${p.side})\n`;
        reply += `   • Preț Intrare: $${p.entryPrice}\n`;
        reply += `   • Preț Curent: $${p.currentPrice || p.entryPrice}\n`;
        reply += `   • Mărime: ${p.qty} ct ($${(p.sizeUSDT || 0).toFixed(2)})\n`;
        reply += `   • PnL: ${sign}${pnl} USDT (${sign}${pnlPct}%)\n\n`;
      });

      await this.sendMessage(reply.trim(), chatId);
      return;
    }

    // /jurnal or /tranzactii
    if (cmd === '/jurnal' || cmd === '/tranzactii') {
      const closed = this.botDelegate.getClosedPositions().slice(0, 5);
      if (closed.length === 0) {
        await this.sendMessage('📖 Jurnalul de tranzacții este gol momentan.', chatId);
        return;
      }

      let reply = `📖 ULTIMELE TRANZACȚII FINALIZATE:\n\n`;
      closed.forEach((p, idx) => {
        const pnl = (p.pnl || 0).toFixed(2);
        const pnlPct = (p.pnlPct || 0).toFixed(2);
        const sign = (p.pnl || 0) >= 0 ? '+' : '';
        const icon = (p.pnl || 0) >= 0 ? '🟢' : '🔴';
        reply += `${idx + 1}. ${icon} ${p.symbol} (${p.side})\n`;
        reply += `   • Intrare: $${p.entryPrice} | Ieșire: $${p.exitPrice || '-'}\n`;
        reply += `   • PnL: ${sign}${pnl} USDT (${sign}${pnlPct}%)\n`;
        reply += `   • Motiv: ${p.exitReasonDetail || 'Stop/TP'}\n\n`;
      });

      await this.sendMessage(reply.trim(), chatId);
      return;
    }

    // /pauza or /pause
    if (cmd === '/pauza' || cmd === '/pause') {
      if (!status.config.killSwitchEngaged) {
        await this.botDelegate.toggleKillSwitch();
        await this.sendMessage('⏸️ Tranzacționarea automată a fost OPRITĂ (Kill switch angajat). Pentru reluare: /porneste', chatId);
      } else {
        await this.sendMessage('ℹ️ Tranzacționarea automată este deja oprită.', chatId);
      }
      return;
    }

    // /porneste or /resume
    if (cmd === '/porneste' || cmd === '/resume') {
      if (status.config.killSwitchEngaged) {
        await this.botDelegate.toggleKillSwitch();
        await this.sendMessage('▶️ Tranzacționarea automată a fost RELUATĂ cu succes.', chatId);
      } else {
        await this.sendMessage('ℹ️ Tranzacționarea automată este deja activă.', chatId);
      }
      return;
    }

    // /mod or /mode [paper | testnet | live]
    if (cmd === '/mod' || cmd === '/mode') {
      const targetMode = parts[1]?.toUpperCase();
      if (!targetMode) {
        const reply =
          `🔄 MODURI DE EXECUȚIE DISPONIBILE:\n\n` +
          `• Mod Activ Curent: [${status.executionMode}]\n` +
          `• Rețea: ${status.config?.testnet ? 'Sandbox / Testnet Demo' : 'Live Real Account'}\n\n` +
          `Comenzi de comutare:\n` +
          `• /mod paper — Simulare locală fără risc ($200 USDT virtual)\n` +
          `• /mod testnet — OKX Demo (Simulated Trading via API)\n` +
          `• /mod live — OKX Cont Real (bani reali)\n\n` +
          `⚠️ Notă: Închide toate pozițiile active înainte de a schimba modul de execuție.`;
        await this.sendMessage(reply, chatId);
        return;
      }

      if (targetMode !== 'PAPER' && targetMode !== 'TESTNET' && targetMode !== 'LIVE') {
        await this.sendMessage('⚠️ Mod invalid. Folosește: /mod paper , /mod testnet sau /mod live', chatId);
        return;
      }

      if (this.botDelegate.setExecutionMode) {
        const res = await this.botDelegate.setExecutionMode(targetMode);
        if (res.success) {
          await this.sendMessage(`✅ Modul de execuție a fost comutat la [${targetMode}].`, chatId);
        } else {
          await this.sendMessage(`❌ Comutare eșuată: ${res.error}`, chatId);
        }
      } else {
        await this.sendMessage('⚠️ Comutarea modului prin Telegram nu este disponibilă.', chatId);
      }
      return;
    }

    // /cumpara [SIMBOL] [CANTITATE]
    if (cmd === '/cumpara' || cmd === '/buy') {
      const symbolInput = parts[1];
      const qtyInput = parts[2] ? parseFloat(parts[2]) : undefined;

      if (!symbolInput) {
        await this.sendMessage('⚠️ Format incorect. Folosește:\n/cumpara [SIMBOL] [CANTITATE]\nExemplu: /cumpara BTCUSDT 0.005', chatId);
        return;
      }

      const normalizedSymbol = symbolInput.toUpperCase().includes('-SWAP')
        ? symbolInput.toUpperCase()
        : symbolInput.toUpperCase().replace('USDT', '-USDT-SWAP');

      if (this.botDelegate.executeManualOrder) {
        const res = await this.botDelegate.executeManualOrder(normalizedSymbol, 'BUY', qtyInput);
        if (res.success) {
          await this.sendMessage(`✅ Ordin BUY transmis pentru ${normalizedSymbol}${qtyInput ? ` (cantitate: ${qtyInput})` : ''}.`, chatId);
        } else {
          await this.sendMessage(`❌ Ordin respins: ${res.error || 'Necunoscut'}`, chatId);
        }
      } else {
        await this.sendMessage('⚠️ Execuția manuală nu este disponibilă pe acest profil.', chatId);
      }
      return;
    }

    // /vinde [SIMBOL] [CANTITATE]
    if (cmd === '/vinde' || cmd === '/sell') {
      const symbolInput = parts[1];
      if (!symbolInput) {
        await this.sendMessage('⚠️ Format incorect. Folosește:\n/vinde [SIMBOL] [CANTITATE]\nExemplu: /vinde BTCUSDT 0.005', chatId);
        return;
      }

      const normalizedSymbol = symbolInput.toUpperCase().includes('-SWAP')
        ? symbolInput.toUpperCase()
        : symbolInput.toUpperCase().replace('USDT', '-USDT-SWAP');

      // Check if open position exists to close it
      const openPositions = this.botDelegate.getActivePositions();
      const pos = openPositions.find((p) => p.symbol === normalizedSymbol || p.symbol.replace(/[-_]/g, '') === symbolInput.toUpperCase());

      if (pos) {
        const closeRes = await this.botDelegate.closePositionManually(pos.symbol);
        if (closeRes.success) {
          await this.sendMessage(`✅ Poziția deschisă pe ${pos.symbol} a fost ÎNCHISĂ cu succes.`, chatId);
        } else {
          await this.sendMessage(`❌ Eroare la închidere: ${closeRes.error}`, chatId);
        }
      } else if (this.botDelegate.executeManualOrder) {
        const qtyInput = parts[2] ? parseFloat(parts[2]) : undefined;
        const res = await this.botDelegate.executeManualOrder(normalizedSymbol, 'SELL', qtyInput);
        if (res.success) {
          await this.sendMessage(`✅ Ordin SELL transmis pentru ${normalizedSymbol}.`, chatId);
        } else {
          await this.sendMessage(`❌ Ordin respins: ${res.error || 'Necunoscut'}`, chatId);
        }
      }
      return;
    }

    // Unknown command
    await this.sendMessage(
      `Comandă nerecunoscută: "${rawText}".\nTastează /ghid sau /ajutor pentru lista completă a comenzilor suportate.`,
      chatId
    );
  }
}

export const telegramService = new TelegramService();
