import express from 'express';
import path from 'path';
import cors from 'cors';
import { createServer as createViteServer } from 'vite';
import { tradeBot } from './src/server/pipeline/TradeBot';

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

  app.get('/api/bot/orders', (req, res) => {
    res.json(tradeBot.getOrders());
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
      isLiveBlocked: true,
    });
  });

  // Switch execution mode: PAPER | TESTNET | LIVE (LIVE is strictly blocked!)
  app.post('/api/bot/mode', requireControlAuth, async (req, res) => {
    const { mode } = req.body;

    // STRICT SECURITY: LIVE mode is completely blocked
    if (mode === 'LIVE' || mode === 'MAINNET') {
      return res.status(403).json({
        error: 'LIVE trading is strictly blocked and disabled for safety reasons.',
      });
    }

    if (mode !== 'PAPER' && mode !== 'TESTNET') {
      return res.status(400).json({
        error: 'Invalid execution mode. Allowed modes: PAPER, TESTNET.',
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
    const result = tradeBot.resetPaperAccount();
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

  // Emergency Kill Switch
  app.post('/api/bot/killswitch', requireControlAuth, async (req, res) => {
    const engaged = await tradeBot.toggleKillSwitch();
    res.json({ success: true, killSwitchEngaged: engaged });
  });

  // Update Bybit API credentials (STRICT TESTNET ONLY)
  app.post('/api/bot/credentials', requireControlAuth, async (req, res) => {
    const { apiKey, apiSecret, testnet } = req.body;
    if (testnet === false) {
      return res.status(403).json({
        error: 'Mainnet is permanently blocked and disabled in this version. Only Testnet is permitted.',
      });
    }
    if (!apiKey || !apiSecret) {
      return res.status(400).json({ error: 'Both apiKey and apiSecret are required' });
    }
    try {
      await tradeBot.updateCredentials(apiKey, apiSecret, true);
      res.json({ success: true, message: 'Credentials updated and reconnected on Bybit Testnet' });
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Failed to update credentials' });
    }
  });

  // Force manual reconciliation
  app.post('/api/bot/reconcile', requireControlAuth, async (req, res) => {
    await tradeBot.connectAndRecover();
    res.json({ success: true, status: tradeBot.getStatus() });
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
