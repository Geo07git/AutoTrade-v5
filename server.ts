import express from 'express';
import path from 'path';
import cors from 'cors';
import { createServer as createViteServer } from 'vite';
import { tradeBot } from './src/server/pipeline/TradeBot';

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(cors());
  app.use(express.json());

  // API Routes
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

  app.post('/api/bot/profile', async (req, res) => {
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

  app.post('/api/bot/killswitch', async (req, res) => {
    const engaged = await tradeBot.toggleKillSwitch();
    res.json({ success: true, killSwitchEngaged: engaged });
  });

  app.post('/api/bot/credentials', async (req, res) => {
    const { apiKey, apiSecret, testnet } = req.body;
    if (!apiKey || !apiSecret) {
      return res.status(400).json({ error: 'Both apiKey and apiSecret are required' });
    }
    await tradeBot.updateCredentials(apiKey, apiSecret, testnet !== false);
    res.json({ success: true, message: 'Credentials updated and reconnected' });
  });

  app.post('/api/bot/reconcile', async (req, res) => {
    await tradeBot.connectAndRecover();
    res.json({ success: true, status: tradeBot.getStatus() });
  });

  // Start Vite middleware for development
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
