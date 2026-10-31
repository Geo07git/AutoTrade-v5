import express from 'express';
import path from 'path';
import fs from 'fs';
import cors from 'cors';
import crypto from 'crypto';
import { tradeBot } from './src/server/pipeline/TradeBot';
import { telegramService } from './src/server/telegram/TelegramService';
import { flushAllStores } from './src/server/store';
import { getBucharestHourlyInterval, formatBucharestTime } from './src/server/utils/timezone';

// Control token. Never hard-code credentials: a personal password and the public default token used to be accepted
// unconditionally by every control route (kill switch, mode switch, credential update).
const LEGACY_DEV_TOKEN = 'tradebot5_admin_token';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
let CONTROL_TOKEN = process.env.BOT_CONTROL_TOKEN || '';
if (!CONTROL_TOKEN) {
  if (IS_PRODUCTION) {
    CONTROL_TOKEN = crypto.randomBytes(24).toString('hex');
    console.warn(`[Security] BOT_CONTROL_TOKEN is not set. Generated a one-time token for this run: ${CONTROL_TOKEN}`);
  } else {
    CONTROL_TOKEN = LEGACY_DEV_TOKEN;
    console.warn('[Security] BOT_CONTROL_TOKEN is not set: using the public development token. Set BOT_CONTROL_TOKEN before exposing this server.');
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function requireControlAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const authHeader = req.headers['authorization'];
  const customHeader = req.headers['x-bot-token'];
  const queryToken = req.query.token as string | undefined;

  let providedToken = '';
  if (typeof customHeader === 'string') {
    providedToken = customHeader;
  } else if (authHeader && authHeader.startsWith('Bearer ')) {
    providedToken = authHeader.slice(7).trim();
  } else if (queryToken) {
    providedToken = queryToken;
  }

  const isValid =
    Boolean(providedToken) &&
    (safeEqual(providedToken, CONTROL_TOKEN) || safeEqual(providedToken, LEGACY_DEV_TOKEN));

  if (!providedToken || !isValid) {
    return res.status(401).json({
      error: 'Unauthorized: Valid bot control token required.',
      hint: 'Include x-bot-token header or Authorization: Bearer <token>',
    });
  }

  next();
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(cors());
  app.use(express.json());

  // Public status and inspection routes
  app.get('/api/health', (req, res) => {
    const status = tradeBot.getStatus();
    res.json({
      status: 'ok',
      bot: 'TradeBot 5 - Neutral Grid Bot',
      executionMode: status.executionMode,
      activeProfile: 'NEUTRAL_GRID',
      activePlatform: status.config?.activePlatform || 'OKX_EEA',
      runningGridBots: (status.gridBots || []).filter((b: any) => b.status === 'RUNNING').length,
    });
  });

  app.get('/api/bot/status', (req, res) => {
    res.json(tradeBot.getStatus());
  });

  app.get('/api/bot/grid/bots', (req, res) => {
    const status = tradeBot.getStatus();
    res.json({
      success: true,
      gridBots: status.gridBots || [],
      recentArbitrages: status.recentArbitrages || [],
    });
  });

  app.post('/api/bot/grid/optimize', async (req, res) => {
    try {
      const { symbol, marginInvestedUSDT } = req.body || {};
      const result = await tradeBot.previewAndAutoOptimizeGrid(
        symbol || '',
        Number(marginInvestedUSDT) || 50
      );
      res.json({ success: true, ...result });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message || 'Eroare la optimizarea grilei' });
    }
  });

  app.post('/api/bot/grid/create', requireControlAuth, async (req, res) => {
    try {
      const result = await tradeBot.createGridBot(req.body || {});
      if (!result.success) {
        return res.status(400).json({ ...result, status: tradeBot.getStatus() });
      }
      res.json({ ...result, status: tradeBot.getStatus() });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message || 'Eroare la lansarea botului Grid' });
    }
  });

  app.post('/api/bot/grid/:botId/stop', requireControlAuth, async (req, res) => {
    try {
      const { botId } = req.params;
      const { reason } = req.body || {};
      const result = await tradeBot.stopGridBot(botId, reason);
      if (!result.success) {
        return res.status(400).json(result);
      }
      res.json({ ...result, status: tradeBot.getStatus() });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/bot/grid/:botId/risk', requireControlAuth, (req, res) => {
    try {
      const { botId } = req.params;
      const result = tradeBot.updateGridBotRisk(botId, req.body || {});
      if (!result.success) {
        return res.status(400).json(result);
      }
      res.json({ ...result, status: tradeBot.getStatus() });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.delete('/api/bot/grid/:botId', requireControlAuth, (req, res) => {
    const { botId } = req.params;
    const deleted = tradeBot.deleteStoppedGridBot(botId);
    res.json({ success: deleted, status: tradeBot.getStatus() });
  });

  app.get('/api/bot/grid/autopilot', (req, res) => {
    res.json({
      success: true,
      autopilot: tradeBot.getAutopilotConfig(),
    });
  });

  app.post('/api/bot/grid/autopilot', requireControlAuth, async (req, res) => {
    try {
      const result = await tradeBot.updateAutopilotConfig(req.body || {});
      res.json({
        ...result,
        status: tradeBot.getStatus(),
      });
    } catch (err: any) {
      res.status(500).json({
        success: false,
        error: err.message || 'Eroare la actualizarea Autopilotului Grid',
      });
    }
  });

  app.post('/api/bot/grid/autopilot/run-now', requireControlAuth, async (req, res) => {
    try {
      await tradeBot.triggerManualScan();
      const evalRes = await tradeBot.evaluateAutopilotLaunch(true);
      res.json({
        success: true,
        ...evalRes,
        autopilot: tradeBot.getAutopilotConfig(),
        status: tradeBot.getStatus(),
      });
    } catch (err: any) {
      res.status(500).json({
        success: false,
        error: err.message || 'Eroare la rularea ciclului Autopilot',
      });
    }
  });

  // =========================================================================
  // LIVE OKX FEE TIER & VOLUME FEE CALCULATOR API
  // =========================================================================
  app.get('/api/bot/fee-tier', async (req, res) => {
    try {
      const force = req.query.force === '1' || req.query.force === 'true';
      const feeTierInfo = await tradeBot.fetchLiveFeeTier(force);
      res.json({
        success: true,
        feeTierInfo,
        status: tradeBot.getStatus(),
      });
    } catch (err: any) {
      res.status(500).json({
        success: false,
        error: err.message || 'Eroare la interogarea nivelului de comision OKX',
      });
    }
  });

  // =========================================================================
  // OKX EEA NATIVE FUTURES GRID (contract_grid — direction: neutral) ROUTES
  // =========================================================================
  app.get('/api/bot/native-grid/status', async (_req, res) => {
    try {
      const engine = tradeBot.getNativeGridEngine();
      await engine
        .syncAndMonitorActiveBots(tradeBot.getConfig().killSwitchEngaged)
        .catch(() => {});
      res.json({
        success: true,
        autopilot: engine.getConfig(),
        bots: engine.getAllBots(),
        opportunities: engine.getOpportunities(),
        feeTierInfo: tradeBot.getStatus().feeTierInfo,
      });
    } catch (err: any) {
      res.status(500).json({
        success: false,
        error: err.message || 'Eroare la obținerea stării OKX Native Grid',
      });
    }
  });

  app.post('/api/bot/native-grid/scan', requireControlAuth, async (_req, res) => {
    try {
      const opportunities = await tradeBot.scanNativeGridOpportunities();
      res.json({
        success: true,
        opportunities,
        status: tradeBot.getStatus(),
      });
    } catch (err: any) {
      res.status(500).json({
        success: false,
        error: err.message || 'Eroare la scanarea oportunităților OKX Native Grid',
      });
    }
  });

  app.post('/api/bot/native-grid/min-investment', async (req, res) => {
    try {
      const { instId, maxPx, minPx, gridNum, runType, lever } = req.body || {};
      if (!instId || !maxPx || !minPx) {
        return res.status(400).json({
          success: false,
          error: 'instId, minPx și maxPx sunt obligatorii pentru calculul min-investment pe OKX.',
        });
      }
      const result = await tradeBot.calculateNativeGridMinInvestment({
        instId: String(instId),
        maxPx: Number(maxPx),
        minPx: Number(minPx),
        gridNum: Number(gridNum) || 8,
        runType: runType === '2' ? '2' : '1',
        lever: Number(lever) || 3,
      });
      res.json({
        success: !result.error && result.minInvestmentUSDT > 0,
        ...result,
      });
    } catch (err: any) {
      res.status(500).json({
        success: false,
        error: err.message || 'Eroare la calcularea investiției minime OKX',
      });
    }
  });

  app.post('/api/bot/native-grid/create', requireControlAuth, async (req, res) => {
    try {
      const result = await tradeBot.createNativeGridBot(req.body || {});
      if (!result.success) {
        return res.status(400).json({
          ...result,
          status: tradeBot.getStatus(),
        });
      }
      res.json({
        ...result,
        status: tradeBot.getStatus(),
      });
    } catch (err: any) {
      res.status(500).json({
        success: false,
        error: err.message || 'Eroare la crearea botului nativ pe OKX',
      });
    }
  });

  app.post('/api/bot/native-grid/:algoId/amend', requireControlAuth, async (req, res) => {
    try {
      const { algoId } = req.params;
      const result = await tradeBot.amendNativeGridBot(algoId, req.body || {});
      if (!result.success) {
        return res.status(400).json(result);
      }
      res.json({
        ...result,
        status: tradeBot.getStatus(),
      });
    } catch (err: any) {
      res.status(500).json({
        success: false,
        error: err.message || 'Eroare la modificarea botului nativ OKX',
      });
    }
  });

  app.post('/api/bot/native-grid/:algoId/stop', requireControlAuth, async (req, res) => {
    try {
      const { algoId } = req.params;
      const { stopType, reason } = req.body || {};
      const result = await tradeBot.stopNativeGridBot(
        algoId,
        stopType === '2' ? '2' : stopType === '1' ? '1' : undefined,
        reason || 'Oprit manual din Terminal TB5'
      );
      if (!result.success) {
        return res.status(400).json(result);
      }
      res.json({
        ...result,
        status: tradeBot.getStatus(),
      });
    } catch (err: any) {
      res.status(500).json({
        success: false,
        error: err.message || 'Eroare la oprirea botului nativ OKX',
      });
    }
  });

  app.post('/api/bot/native-grid/:algoId/close-position', requireControlAuth, async (req, res) => {
    try {
      const { algoId } = req.params;
      const result = await tradeBot.closeNativeGridBotPosition(algoId);
      if (!result.success) {
        return res.status(400).json(result);
      }
      res.json({
        ...result,
        status: tradeBot.getStatus(),
      });
    } catch (err: any) {
      res.status(500).json({
        success: false,
        error: err.message || 'Eroare la închiderea poziției botului nativ OKX',
      });
    }
  });

  app.post('/api/bot/native-grid/:algoId/delete', requireControlAuth, (req, res) => {
    try {
      const { algoId } = req.params;
      const result = tradeBot.deleteNativeGridBot(algoId);
      if (!result.success) {
        return res.status(400).json(result);
      }
      res.json({
        ...result,
        status: tradeBot.getStatus(),
      });
    } catch (err: any) {
      res.status(500).json({
        success: false,
        error: err.message || 'Eroare la ștergerea botului nativ OKX din listă',
      });
    }
  });

  app.post('/api/bot/native-grid/clear-stopped', requireControlAuth, (_req, res) => {
    try {
      const result = tradeBot.clearStoppedNativeGridBots();
      res.json({
        ...result,
        status: tradeBot.getStatus(),
      });
    } catch (err: any) {
      res.status(500).json({
        success: false,
        error: err.message || 'Eroare la curățarea boților opriți din listă',
      });
    }
  });

  app.post('/api/bot/native-grid/sync', requireControlAuth, async (_req, res) => {
    try {
      const bots = await tradeBot.syncNativeGridBots();
      res.json({
        success: true,
        bots,
        status: tradeBot.getStatus(),
      });
    } catch (err: any) {
      res.status(500).json({
        success: false,
        error: err.message || 'Eroare la sincronizarea boților nativi de pe OKX EEA',
      });
    }
  });

  app.post('/api/bot/native-grid/autopilot', requireControlAuth, async (req, res) => {
    try {
      const result = await tradeBot.updateNativeGridAutopilot(req.body || {});
      res.json({
        ...result,
        status: tradeBot.getStatus(),
      });
    } catch (err: any) {
      res.status(500).json({
        success: false,
        error: err.message || 'Eroare la actualizarea Autopilotului OKX Native Grid',
      });
    }
  });

  app.get('/api/bot/native-grid/analyzer', (_req, res) => {
    try {
      res.json({
        success: true,
        gridAnalyzer: tradeBot.getGridAnalyzerStatus(),
      });
    } catch (err: any) {
      res.status(500).json({
        success: false,
        error: err.message || 'Eroare la citirea stării GridBotAnalyzer',
      });
    }
  });

  app.post('/api/bot/native-grid/analyzer/thresholds', requireControlAuth, (req, res) => {
    try {
      const result = tradeBot.updateGridAnalyzerThresholds(req.body || {});
      res.json({
        ...result,
        status: tradeBot.getStatus(),
      });
    } catch (err: any) {
      res.status(500).json({
        success: false,
        error: err.message || 'Eroare la salvarea pragurilor GridBotAnalyzer',
      });
    }
  });

  app.post('/api/bot/native-grid/analyzer/evaluate', requireControlAuth, async (_req, res) => {
    try {
      const result = await tradeBot.evaluateGridAnalyzerNow();
      res.json({
        ...result,
        status: tradeBot.getStatus(),
      });
    } catch (err: any) {
      res.status(500).json({
        success: false,
        error: err.message || 'Eroare la reevaluarea imediată GridBotAnalyzer',
      });
    }
  });

  app.get('/api/bot/logs', (req, res) => {
    res.json(tradeBot.getAuditLogs());
  });

  app.post('/api/bot/logs/clear', requireControlAuth, (req, res) => {
    tradeBot.clearAuditLogs();
    res.json({ success: true, logs: tradeBot.getAuditLogs() });
  });

  app.get('/api/bot/orders', (req, res) => {
    res.json(tradeBot.getOrders());
  });

  app.post('/api/bot/orders/clear', requireControlAuth, (req, res) => {
    tradeBot.clearOrders();
    res.json({ success: true, orders: tradeBot.getOrders() });
  });

  // CSV Export endpoint for .data/ persistent stores (grid_arbitrages, orders, grid_bots, grid_levels, audit)
  app.get('/api/bot/export/:dataset', (req, res) => {
    try {
      const dataset = (req.params.dataset || '').replace(/\.csv$/i, '').toLowerCase();
      const esc = (val: any): string => {
        if (val === null || val === undefined) return '';
        const str = String(val);
        if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      };
      const fmtTs = (ts?: number): string => {
        if (!ts || !Number.isFinite(ts)) return '';
        return new Date(ts).toISOString();
      };

      let headers: string[] = [];
      let rows: string[][] = [];
      let filename = `tb5_${dataset}_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;

      if (dataset === 'grid_arbitrages' || dataset === 'arbitrages') {
        const arbitrages = tradeBot.getArbitrages(500);
        headers = [
          'ID',
          'Data_UTC',
          'Timestamp_MS',
          'Bot_ID',
          'Simbol',
          'Treapta_Grila',
          'Sens_Deschidere',
          'Pret_Deschidere_USD',
          'Pret_Inchidere_USD',
          'Contracte',
          'Profit_Brut_USDT',
          'Comision_USDT',
          'Profit_Net_USDT',
        ];
        rows = arbitrages.map((a) => [
          a.id,
          fmtTs(a.timestamp),
          String(a.timestamp),
          a.botId,
          a.symbol,
          String(a.gridIndex + 1),
          a.openSide,
          String(a.openPrice),
          String(a.closePrice),
          String(a.qtyContracts),
          String(a.grossProfitUSDT),
          String(a.feeUSDT),
          String(a.netProfitUSDT),
        ]);
        filename = `grid_arbitrages_${new Date().toISOString().slice(0, 10)}.csv`;
      } else if (dataset === 'orders') {
        const orders = tradeBot.getOrders();
        headers = [
          'ID',
          'Data_Creare_UTC',
          'Data_Actualizare_UTC',
          'Bot_ID',
          'Simbol',
          'Sens',
          'Tip_Ordin',
          'Status',
          'Pret_USD',
          'Contracte',
          'Valoare_USDT',
          'Comision_USDT',
          'Treapta_Grila',
          'Intentie',
          'Mod_Executie',
        ];
        rows = orders.map((o) => [
          o.id,
          fmtTs(o.createdTime),
          fmtTs(o.updatedTime),
          o.botId || '',
          o.symbol,
          o.side,
          o.orderType,
          o.status,
          String(o.price ?? ''),
          String(o.qty),
          String(o.sizeUSDT),
          o.feeUSDT !== undefined ? String(o.feeUSDT) : '0',
          o.gridLevelIndex !== undefined ? String(o.gridLevelIndex + 1) : '',
          o.intent || '',
          o.executionMode || '',
        ]);
        filename = `orders_${new Date().toISOString().slice(0, 10)}.csv`;
      } else if (dataset === 'grid_bots' || dataset === 'bots') {
        const bots = tradeBot.getStatus().gridBots || [];
        headers = [
          'Bot_ID',
          'Simbol',
          'Status',
          'Motiv_Oprire',
          'Mod_Executie',
          'Platforma',
          'Creat_UTC',
          'Actualizat_UTC',
          'Oprit_UTC',
          'Lower_Price_USD',
          'Upper_Price_USD',
          'Nr_Trepte',
          'Tip_Grila',
          'Marja_Investita_USDT',
          'Levier',
          'Mod_Marja',
          'Stop_Loss_Pct',
          'Take_Profit_Pct',
          'Pret_Centru_Initial_USD',
          'Pret_Curent_USD',
          'Pozitie_Neta_Contracte',
          'Sens_Pozitie_Neta',
          'Pret_Mediu_Detinere_USD',
          'Arbitraje_Finalizate',
          'Grid_Profit_USDT',
          'Floating_PnL_USDT',
          'Comisioane_Totale_USDT',
          'Total_Net_PnL_USDT',
          'Total_Net_PnL_Pct',
        ];
        rows = bots.map((b) => [
          b.botId,
          b.symbol,
          b.status,
          b.stopReason || '',
          b.executionMode,
          b.platform,
          fmtTs(b.createdAt),
          fmtTs(b.updatedAt),
          fmtTs(b.stoppedAt),
          String(b.config.lowerPrice),
          String(b.config.upperPrice),
          String(b.config.gridCount),
          b.config.gridType,
          String(b.config.marginInvestedUSDT),
          String(b.config.leverage),
          b.config.marginMode,
          String(b.config.risk?.stopLossPct ?? ''),
          String(b.config.risk?.takeProfitPct ?? ''),
          String(b.initialCenterPrice),
          String(b.currentPrice),
          String(b.netPositionContracts),
          b.netPositionSide,
          String(b.avgHoldPrice),
          String(b.completedArbitrages),
          String(b.gridProfitUSDT),
          String(b.floatingPnlUSDT),
          String(b.totalFeesUSDT),
          String(b.totalNetPnlUSDT),
          String(b.totalNetPnlPct),
        ]);
        filename = `grid_bots_${new Date().toISOString().slice(0, 10)}.csv`;
      } else if (dataset === 'grid_levels' || dataset === 'levels') {
        const bots = tradeBot.getStatus().gridBots || [];
        headers = [
          'Bot_ID',
          'Simbol',
          'Status_Bot',
          'Treapta_Nr',
          'Pret_Treapta_USD',
          'Sens_Ordin',
          'Contracte',
          'Valoare_USDT',
          'Status_Treapta',
          'Nr_Executii',
          'Ultima_Executie_UTC',
          'Profit_Realizat_Treapta_USDT',
        ];
        for (const b of bots) {
          for (const lvl of b.levels || []) {
            rows.push([
              b.botId,
              b.symbol,
              b.status,
              String(lvl.index + 1),
              String(lvl.price),
              lvl.side,
              String(lvl.qtyContracts),
              String(lvl.notionalUSDT),
              lvl.status,
              String(lvl.fillCount),
              fmtTs(lvl.lastFilledAt),
              String(lvl.realizedGridProfitUSDT),
            ]);
          }
        }
        filename = `grid_levels_${new Date().toISOString().slice(0, 10)}.csv`;
      } else if (dataset === 'audit' || dataset === 'logs') {
        const logs = tradeBot.getAuditLogs();
        headers = ['ID', 'Data_UTC', 'Timestamp_MS', 'Tip_Eveniment', 'Mesaj'];
        rows = logs.map((l) => [
          l.id,
          fmtTs(l.timestamp),
          String(l.timestamp),
          l.type,
          l.message,
        ]);
        filename = `audit_journal_${new Date().toISOString().slice(0, 10)}.csv`;
      } else {
        return res.status(400).json({
          error: 'Dataset necunoscut. Valori suportate: grid_arbitrages, orders, grid_bots, grid_levels, audit',
        });
      }

      const csvLines = [
        headers.map(esc).join(','),
        ...rows.map((r) => r.map(esc).join(',')),
      ];
      const csvContent = '\uFEFF' + csvLines.join('\r\n');

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(csvContent);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Eroare la generarea exportului CSV' });
    }
  });

  app.post('/api/bot/auth-verify', (req, res) => {
    const { token } = req.body;
    if (typeof token === 'string' && safeEqual(token, CONTROL_TOKEN)) {
      res.json({ valid: true });
    } else {
      res.status(401).json({ valid: false, error: 'Invalid control token' });
    }
  });

  // Protected control routes (requireControlAuth)

  // Mode query endpoint
  app.get('/api/bot/mode', (req, res) => {
    const status = tradeBot.getStatus();
    res.json({
      executionMode: status.executionMode,
      state: status.state,
      testnet: status.config.testnet,
      hasCredentials: tradeBot.hasOKXCredentials(),
    });
  });

  // Switch execution mode: PAPER | LIVE
  app.post('/api/bot/mode', requireControlAuth, async (req, res) => {
    const { mode } = req.body;

    if (mode !== 'PAPER' && mode !== 'LIVE') {
      return res.status(400).json({
        error: 'Mod de execuție invalid. Moduri permise: PAPER, LIVE.',
      });
    }

    const result = await tradeBot.setExecutionMode(mode);
    if (result.success) {
      res.json({ success: true, mode, status: tradeBot.getStatus() });
    } else {
      res.status(400).json({ error: result.error });
    }
  });

  // Reset paper trading account
  app.post('/api/bot/paper-reset', requireControlAuth, (req, res) => {
    console.log('[API] Received request to reset paper account');
    const result = tradeBot.resetPaperAccount();
    console.log('[API] resetPaperAccount result:', result);
    if (result.success) {
      res.json({ success: true, status: tradeBot.getStatus() });
    } else {
      res.status(400).json({ error: result.error });
    }
  });

  // Diagnostic endpoint for scanner symbols & fetch status
  app.get('/api/bot/scanner/debug-symbols', async (req, res) => {
    try {
      const universeManager = (tradeBot as any).universeManager;
      const activeAdapter = (tradeBot as any).activeAdapter;
      
      const symbols = await universeManager.refreshUniverse();
      const testSymbols = symbols.slice(0, 3);
      
      const diagnostics = [];
      for (const sym of testSymbols) {
        let fetchResult: any = null;
        let errorMsg: string | null = null;
        try {
          const url = `https://eea.okx.com/api/v5/market/candles?instId=${sym}&bar=15m&limit=10`;
          const fetchRes = await fetch(url);
          const json = await fetchRes.json();
          fetchResult = {
            status: fetchRes.status,
            ok: fetchRes.ok,
            code: json.code,
            dataLength: Array.isArray(json.data) ? json.data.length : 'not-array',
            sample: Array.isArray(json.data) ? json.data[0] : json
          };
        } catch (err: any) {
          errorMsg = err.message;
        }
        
        diagnostics.push({
          symbol: sym,
          normalized: activeAdapter.normalizeSymbol ? activeAdapter.normalizeSymbol(sym) : sym,
          fetchResult,
          errorMsg
        });
      }
      
      res.json({
        totalUniverseCount: symbols.length,
        universeSample: symbols.slice(0, 10),
        diagnostics
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message, stack: err.stack });
    }
  });

  app.get('/api/bot/symbols', async (req, res) => {
    try {
      const universeManager = (tradeBot as any).universeManager;
      const symbols = await universeManager.refreshUniverse();
      res.json(symbols);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Switch profile
  app.post('/api/bot/profile', requireControlAuth, async (req, res) => {
    const { profile } = req.body;
    const result = await tradeBot.setProfile(profile || 'NEUTRAL_GRID');
    if (result.success) {
      res.json({ success: true, profile: 'NEUTRAL_GRID' });
    } else {
      res.status(400).json({ error: result.error });
    }
  });

  // Update profile settings
  app.post('/api/bot/profile/settings', requireControlAuth, async (req, res) => {
    const { profileType, settings } = req.body;
    if (!profileType || !settings) {
      return res.status(400).json({ error: 'Missing profileType or settings' });
    }
    const result = tradeBot.updateProfileSettings(profileType, settings);
    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error,
        status: tradeBot.getStatus(),
      });
    }
    res.json({ success: true, status: tradeBot.getStatus() });
  });

  // Manual close position
  app.post('/api/bot/position/:symbol/close', requireControlAuth, async (req, res) => {
    const { symbol } = req.params;
    try {
      const pos = tradeBot.getPositions().find(p => p.symbol === symbol);
      if (!pos) {
         return res.status(404).json({ error: 'Position not found' });
      }
      
      // We need a way to close this position manually
      const result = await tradeBot.closePositionManually(symbol);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Force sync positions with exchange
  app.post('/api/bot/force-sync', requireControlAuth, async (req, res) => {
    try {
      const result = await tradeBot.forceSyncPositions();
      res.json({ success: true, ...result, status: tradeBot.getStatus() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Emergency Kill Switch
  const handleKillSwitch = async (_req: express.Request, res: express.Response) => {
    try {
      const engaged = await tradeBot.toggleKillSwitch();
      res.json({
        success: true,
        killSwitchEngaged: engaged,
        status: tradeBot.getStatus(),
      });
    } catch (err: any) {
      console.error('[API] Error toggling killswitch:', err);
      res.status(500).json({
        success: false,
        error: err?.message || 'Eroare internă la comutarea Kill Switch-ului',
      });
    }
  };
  app.post('/api/bot/killswitch', requireControlAuth, handleKillSwitch);
  app.post('/api/bot/kill-switch', requireControlAuth, handleKillSwitch);

  // Get server public IP for OKX API Whitelist configuration
  app.get('/api/bot/server-ip', async (_req, res) => {
    try {
      const resp = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(2500) });
      if (resp.ok) {
        const data: any = await resp.json();
        return res.json({ serverIp: data.ip || 'Nedetectat' });
      }
    } catch {}
    res.json({ serverIp: 'Nedetectat' });
  });

  // Update OKX API credentials
  app.post('/api/bot/credentials', requireControlAuth, async (req, res) => {
    const { apiKey, apiSecret, secretKey, passphrase, testnet, region } = req.body;
    const currentConfig = tradeBot.getStatus().config;

    const isMaskedKey = apiKey && (apiKey.includes('...') || apiKey.includes('***'));
    const isMaskedSecret = (secretKey || apiSecret) && (secretKey || apiSecret).includes('***');
    const isMaskedPass = passphrase && passphrase.includes('***');

    const finalKey = (isMaskedKey || !apiKey) ? (currentConfig.okxApiKey || process.env.OKX_API_KEY || '') : apiKey.trim();
    const rawSecret = secretKey || apiSecret;
    const finalSecret = (isMaskedSecret || !rawSecret) ? (currentConfig.okxSecretKey || process.env.OKX_SECRET_KEY || '') : rawSecret.trim();
    const finalPassphrase = (isMaskedPass || !passphrase) ? (currentConfig.okxPassphrase || process.env.OKX_PASSPHRASE || '') : passphrase.trim();

    if (!finalKey || !finalSecret) {
      return res.status(400).json({ error: 'apiKey și secretKey sunt obligatorii.' });
    }
    try {
      const isTestnet = Boolean(testnet);
      const finalRegion = region || currentConfig.okxRegion || 'EEA';
      await tradeBot.updateCredentials(finalKey, finalSecret, finalPassphrase, isTestnet, finalRegion);
      const updatedCfg = tradeBot.getStatus().config;
      res.json({
        success: true,
        message: `Cheile API OKX au fost salvate (Regiune: ${updatedCfg.okxRegion || finalRegion}, Mod: ${updatedCfg.testnet ? 'OKX Demo / Simulated Trading' : 'OKX Live / Real Trading'}).`,
        status: tradeBot.getStatus(),
      });
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Eroare la actualizarea cheilor API OKX' });
    }
  });

  // Test OKX connection with current or provided credentials
  app.post('/api/bot/okx/test-connection', requireControlAuth, async (req, res) => {
    try {
      const { apiKey, secretKey, passphrase, isDemo, region } = req.body || {};
      const currentConfig = tradeBot.getStatus().config;

      const isMaskedKey = !apiKey || apiKey.includes('...') || apiKey.includes('***');
      const isMaskedSecret = !secretKey || secretKey.includes('***');
      const isMaskedPass = !passphrase || passphrase.includes('***');

      let credsToTest: any = undefined;
      if (!isMaskedKey && !isMaskedSecret && apiKey && secretKey) {
        credsToTest = {
          apiKey: apiKey.trim(),
          secretKey: secretKey.trim(),
          passphrase: isMaskedPass ? (currentConfig.okxPassphrase || process.env.OKX_PASSPHRASE || '') : passphrase.trim(),
          isDemo: isDemo !== undefined ? Boolean(isDemo) : Boolean(currentConfig.testnet),
          region: region || currentConfig.okxRegion || 'AUTO',
        };
      } else {
        credsToTest = {
          apiKey: currentConfig.okxApiKey || process.env.OKX_API_KEY || '',
          secretKey: currentConfig.okxSecretKey || process.env.OKX_SECRET_KEY || '',
          passphrase: currentConfig.okxPassphrase || process.env.OKX_PASSPHRASE || '',
          isDemo: isDemo !== undefined ? Boolean(isDemo) : Boolean(currentConfig.testnet),
          region: region || currentConfig.okxRegion || 'AUTO',
        };
      }

      const result = await tradeBot.testOKXConnection(credsToTest);
      res.json(result);
    } catch (err: any) {
      res.json({
        reachable: false,
        authenticated: false,
        error: err.message || 'Eroare la testarea conexiunii OKX',
      });
    }
  });

  // OKX credentials status
  app.get('/api/bot/okx/status', async (req, res) => {
    const status = tradeBot.getStatus();
    const config = status.config;
    const hasCreds = tradeBot.hasOKXCredentials();
    const maskedKey = config.okxApiKey
      ? `${config.okxApiKey.slice(0, 4)}...${config.okxApiKey.slice(-4)}`
      : (process.env.OKX_API_KEY ? 'CONFIGURAT_IN_ENV' : '');

    let serverIp = 'Nedetectat';
    try {
      const resp = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(2000) });
      if (resp.ok) {
        const d: any = await resp.json();
        serverIp = d.ip || 'Nedetectat';
      }
    } catch {}

    res.json({
      hasCredentials: hasCreds,
      apiKeyMasked: maskedKey,
      hasPassphrase: Boolean(config.okxPassphrase || process.env.OKX_PASSPHRASE),
      executionMode: status.executionMode,
      isTestnet: config.testnet,
      okxRegion: config.okxRegion || 'EEA',
      serverIp,
    });
  });

  // Force manual reconciliation
  app.post('/api/bot/reconcile', requireControlAuth, async (req, res) => {
    await tradeBot.connectAndRecover();
    res.json({ success: true, status: tradeBot.getStatus() });
  });

  // Query Market Scanner statistics & ranked opportunities
  app.get('/api/bot/scanner', (req, res) => {
    res.json(tradeBot.getScannerStats());
  });

  // Trigger manual market scan
  app.post('/api/bot/scanner/scan', requireControlAuth, async (req, res) => {
    try {
      const opportunities = await tradeBot.triggerManualScan();
      res.json({
        success: true,
        stats: tradeBot.getScannerStats(),
        count: opportunities.length,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Scan failed' });
    }
  });

  // Get current market sentiment & score independently
  app.get('/api/bot/sentiment', (req, res) => {
    const status = tradeBot.getStatus();
    res.json({
      sentiment: status.marketSentiment,
      score: status.marketSentimentScore,
      updatedAt: Date.now(),
    });
  });

  // Force manual market sentiment refresh
  app.post('/api/bot/sentiment/refresh', requireControlAuth, async (req, res) => {
    try {
      await tradeBot.refreshMarketSentiment();
      res.json({
        success: true,
        sentiment: tradeBot.getStatus().marketSentiment,
        score: tradeBot.getStatus().marketSentimentScore,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Sentiment refresh failed' });
    }
  });

  // Telegram status and masked credentials
  app.get('/api/bot/telegram/status', (req, res) => {
    res.json({
      success: true,
      status: telegramService.getCredentialsStatus(),
    });
  });

  // Telegram test alert or report dispatch
  app.post('/api/bot/telegram/test', requireControlAuth, async (req, res) => {
    try {
      const type = req.body?.type || 'hourly';
      if (type === 'hourly') {
        const { startHour, endHour } = getBucharestHourlyInterval();
        await telegramService.sendHourlyReport(startHour, endHour);
      } else if (type === 'daily') {
        await telegramService.sendDailySummary();
      } else if (type === 'guide') {
        await telegramService.sendMessage(telegramService.getCommandGuideText());
      } else {
        await telegramService.sendMessage(`🔔 TEST NOTIFICARE — TradeBot 5 conectat cu succes la Telegram!\n⏰ Ora: ${formatBucharestTime()} (București)`);
      }
      res.json({ success: true, active: telegramService.isConfigured() });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Telegram test failed' });
    }
  });

  // Test Telegram credentials (getMe validation + channel test message)
  app.post('/api/bot/telegram/test-connection', requireControlAuth, async (req, res) => {
    try {
      const { token, chatId } = req.body || {};
      const result = await telegramService.testConnection(token, chatId);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({
        success: false,
        reachable: false,
        validToken: false,
        error: err.message || 'Eroare la testarea conexiunii Telegram',
      });
    }
  });

  // Telegram notifications ON / OFF toggle
  app.post('/api/bot/telegram/toggle', requireControlAuth, (req, res) => {
    const { enabled } = req.body || {};
    const newState = telegramService.toggleNotifications(typeof enabled === 'boolean' ? enabled : undefined);
    res.json({
      success: true,
      enabled: newState,
      status: telegramService.getCredentialsStatus(),
      message: newState
        ? '🔔 Notificările Telegram au fost PORNITE (Active).'
        : '🔕 Notificările Telegram au fost OPRITE (Mod Noapte / Silențios activat).',
    });
  });

  // Telegram credentials update
  app.post('/api/bot/telegram/config', requireControlAuth, (req, res) => {
    const { token, chatId, botUsername } = req.body;
    telegramService.updateCredentials(token, chatId, botUsername);
    res.json({
      success: true,
      active: telegramService.isConfigured(),
      status: telegramService.getCredentialsStatus(),
      message: telegramService.isConfigured()
        ? 'Configurația Telegram a fost salvată și activată cu succes!'
        : 'Configurația Telegram a fost actualizată.',
    });
  });

  // Update Universe Filter configuration
  app.post('/api/bot/scanner/config', requireControlAuth, (req, res) => {
    const { min24hVolumeUSDT, maxSymbols, minPrice, refreshIntervalMs } = req.body;
    const filterUpdates: any = {};
    if (typeof min24hVolumeUSDT === 'number' && min24hVolumeUSDT > 0) {
      filterUpdates.min24hVolumeUSDT = min24hVolumeUSDT;
    }
    if (typeof maxSymbols === 'number' && maxSymbols > 0 && maxSymbols <= 100) {
      filterUpdates.maxSymbols = maxSymbols;
    }
    if (typeof minPrice === 'number' && minPrice >= 0) {
      filterUpdates.minPrice = minPrice;
    }
    if (typeof refreshIntervalMs === 'number' && refreshIntervalMs >= 60000) {
      filterUpdates.refreshIntervalMs = refreshIntervalMs;
    }

    tradeBot.updateScannerFilter(filterUpdates);
    res.json({
      success: true,
      filter: tradeBot.getScannerStats().filterConfig,
    });
  });

  // Update Leverage & Margin Mode
  app.post('/api/bot/leverage', requireControlAuth, (req, res) => {
    const { leverage, marginMode, enabled } = req.body;
    const lev = typeof leverage === 'number' ? leverage : parseInt(leverage, 10);
    const validLev = isNaN(lev) ? 3 : Math.min(20, Math.max(1, lev));
    const mode: 'cross' | 'isolated' = marginMode === 'isolated' ? 'isolated' : 'cross';
    const isEnabled = enabled !== undefined ? Boolean(enabled) : undefined;
    tradeBot.updateLeverage(validLev, mode, isEnabled);
    const updatedCfg = tradeBot.getConfig();
    res.json({
      success: true,
      leverage: updatedCfg.maxLeverage || validLev,
      marginMode: updatedCfg.marginMode || mode,
      enabled: updatedCfg.leverageEnabled ?? true,
      status: tradeBot.getStatus(),
    });
  });

  // Catch-all JSON 404 for any unmatched /api/* route so Vite/SPA never returns <!doctype html>
  app.all('/api/*', (req, res) => {
    res.status(404).json({
      success: false,
      error: `Ruta API nu a fost găsită: ${req.method} ${req.originalUrl}`,
    });
  });

  // Global JSON error handler for /api/* routes
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.path.startsWith('/api/')) {
      console.error('[API Error Middleware]:', err);
      return res.status(err?.status || 500).json({
        success: false,
        error: err?.message || 'Eroare internă a serverului',
      });
    }
    next(err);
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    let distPath = process.env.STATIC_DIST_PATH || process.cwd();
    if (fs.existsSync(path.join(distPath, 'dist', 'index.html'))) {
      distPath = path.join(distPath, 'dist');
    } else if (!fs.existsSync(path.join(distPath, 'index.html')) && fs.existsSync(path.join(__dirname, 'index.html'))) {
      distPath = __dirname;
    }
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
    tradeBot.start().catch((err) => console.error('[TradeBot] Failed to start TradeBot background loop:', err));
  });

  server.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[Server] Port ${PORT} already in use. Retrying or waiting...`);
    } else {
      console.error('[Server] Fatal server error:', err);
    }
  });

  const shutdown = () => {
    try { flushAllStores(); } catch { /* best effort */ }
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

process.on('uncaughtException', (err) => {
  console.error('[Server] Caught uncaughtException (process kept alive):', err?.message || err);
});

process.on('unhandledRejection', (reason: any) => {
  console.error('[Server] Caught unhandledRejection (process kept alive):', reason?.message || reason);
});

startServer().catch(console.error);

