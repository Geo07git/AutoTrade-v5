import express from 'express';
import path from 'path';
import cors from 'cors';
import { createServer as createViteServer } from 'vite';
import { tradeBot } from './src/server/pipeline/TradeBot';
import { telegramService } from './src/server/telegram/TelegramService';

const CONTROL_TOKEN = process.env.BOT_CONTROL_TOKEN || 'tradebot5_admin_token';

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

  if (!providedToken || providedToken !== CONTROL_TOKEN) {
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
    res.json({ status: 'ok', bot: 'TradeBot 5' });
  });

  app.get('/api/bot/status', (req, res) => {
    res.json(tradeBot.getStatus());
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

  app.post('/api/bot/auth-verify', (req, res) => {
    const { token } = req.body;
    if (token === CONTROL_TOKEN) {
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

  // Switch execution mode: PAPER | TESTNET | LIVE
  app.post('/api/bot/mode', requireControlAuth, async (req, res) => {
    const { mode } = req.body;

    if (mode !== 'PAPER' && mode !== 'TESTNET' && mode !== 'LIVE') {
      return res.status(400).json({
        error: 'Mod de execuție invalid. Moduri permise: PAPER, TESTNET, LIVE.',
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

  // Switch profile: SCALP | MOMENTUM
  app.post('/api/bot/profile', requireControlAuth, async (req, res) => {
    const { profile } = req.body;
    if (profile === 'SCALP' || profile === 'MOMENTUM') {
      const result = await tradeBot.setProfile(profile);
      if (result.success) {
        res.json({ success: true, profile });
      } else {
        res.status(400).json({ error: result.error });
      }
    } else {
      res.status(400).json({ error: 'Invalid profile' });
    }
  });

  // Update profile settings
  app.post('/api/bot/profile/settings', requireControlAuth, async (req, res) => {
    const { profileType, settings } = req.body;
    if (!profileType || !settings) {
      return res.status(400).json({ error: 'Missing profileType or settings' });
    }
    tradeBot.updateProfileSettings(profileType, settings);
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

  // Emergency Kill Switch
  app.post('/api/bot/killswitch', requireControlAuth, async (req, res) => {
    const engaged = await tradeBot.toggleKillSwitch();
    res.json({ success: true, killSwitchEngaged: engaged });
  });

  // Update OKX API credentials
  app.post('/api/bot/credentials', requireControlAuth, async (req, res) => {
    const { apiKey, apiSecret, secretKey, passphrase, testnet } = req.body;
    const finalSecret = secretKey || apiSecret;
    const finalPassphrase = passphrase || '';
    if (!apiKey || !finalSecret) {
      return res.status(400).json({ error: 'apiKey și secretKey sunt obligatorii.' });
    }
    try {
      const isTestnet = testnet !== false;
      await tradeBot.updateCredentials(apiKey, finalSecret, finalPassphrase, isTestnet);
      res.json({
        success: true,
        message: `Cheile API OKX au fost salvate și conectate (Mod rețea: ${isTestnet ? 'OKX Demo / Simulated Trading' : 'OKX Live / Real Trading'}).`,
        status: tradeBot.getStatus(),
      });
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Eroare la actualizarea cheilor API OKX' });
    }
  });

  // Test OKX connection with current or provided credentials
  app.post('/api/bot/okx/test-connection', requireControlAuth, async (req, res) => {
    try {
      const { apiKey, secretKey, passphrase, isDemo } = req.body || {};
      const result = await tradeBot.testOKXConnection(
        apiKey && secretKey ? { apiKey, secretKey, passphrase, isDemo } : undefined
      );
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Eroare la testarea conexiunii OKX' });
    }
  });

  // OKX credentials status
  app.get('/api/bot/okx/status', (req, res) => {
    const status = tradeBot.getStatus();
    const config = status.config;
    const hasCreds = tradeBot.hasOKXCredentials();
    const maskedKey = config.okxApiKey
      ? `${config.okxApiKey.slice(0, 4)}...${config.okxApiKey.slice(-4)}`
      : (process.env.OKX_API_KEY ? 'CONFIGURAT_IN_ENV' : '');

    res.json({
      hasCredentials: hasCreds,
      apiKeyMasked: maskedKey,
      hasPassphrase: Boolean(config.okxPassphrase || process.env.OKX_PASSPHRASE),
      executionMode: status.executionMode,
      isTestnet: config.testnet,
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

  // Telegram test alert or report dispatch
  app.post('/api/bot/telegram/test', requireControlAuth, async (req, res) => {
    try {
      const type = req.body?.type || 'hourly';
      if (type === 'hourly') {
        const now = new Date();
        const prevHour = (now.getHours() - 1 + 24) % 24;
        const prevStr = `${prevHour.toString().padStart(2, '0')}:00`;
        const currStr = `${now.getHours().toString().padStart(2, '0')}:00`;
        await telegramService.sendHourlyReport(prevStr, currStr);
      } else if (type === 'daily') {
        await telegramService.sendDailySummary();
      } else if (type === 'guide') {
        await telegramService.sendMessage(telegramService.getCommandGuideText());
      } else {
        await telegramService.sendMessage('🔔 TEST NOTIFICARE — TradeBot 5 conectat cu succes la Telegram!');
      }
      res.json({ success: true, active: telegramService.isConfigured() });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Telegram test failed' });
    }
  });

  // Telegram credentials update
  app.post('/api/bot/telegram/config', requireControlAuth, (req, res) => {
    const { token, chatId } = req.body;
    telegramService.updateCredentials(token, chatId);
    res.json({ success: true, active: telegramService.isConfigured() });
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
    const { leverage, marginMode } = req.body;
    const lev = typeof leverage === 'number' ? leverage : parseInt(leverage, 10);
    if (isNaN(lev) || lev < 1 || lev > 100) {
      return res.status(400).json({ error: 'Leverage must be a number between 1 and 100' });
    }
    const mode = marginMode === 'isolated' ? 'isolated' : 'cross';
    tradeBot.updateLeverage(lev, mode);
    res.json({ success: true, leverage: lev, marginMode: mode });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer().catch(console.error);
