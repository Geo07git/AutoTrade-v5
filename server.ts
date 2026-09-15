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
    res.json({
      config: tradeBot.getConfig(),
      profileConfig: tradeBot.getActiveProfile(),
      equity: tradeBot.getEquity(),
      positions: tradeBot.getPositions(),
    });
  });

  app.get('/api/bot/logs', (req, res) => {
    res.json(tradeBot.getAuditLogs());
  });

  app.post('/api/bot/profile', async (req, res) => {
    const { profile } = req.body;
    if (profile === 'SCALP' || profile === 'MOMENTUM') {
      await tradeBot.setProfile(profile);
      res.json({ success: true, profile });
    } else {
      res.status(400).json({ error: 'Invalid profile' });
    }
  });

  app.post('/api/bot/killswitch', async (req, res) => {
    await tradeBot.toggleKillSwitch();
    res.json({ success: true, killSwitchEngaged: tradeBot.getConfig().killSwitchEngaged });
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
