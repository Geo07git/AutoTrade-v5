/**
 * Emergency Stop Script for AutoTrade-v5
 * Run via: npm run emergency-stop
 * 
 * Safely halts all bots, cancels all active orders, engages Kill Switch,
 * and prevents the bot engine from placing any new orders.
 */

import http from 'http';
import fs from 'fs';
import path from 'path';

async function callLocalKillSwitch(token: string): Promise<boolean> {
  return new Promise((resolve) => {
    const postData = JSON.stringify({ reason: 'Emergency Stop CLI' });
    const req = http.request(
      {
        hostname: 'localhost',
        port: 3000,
        path: '/api/bot/killswitch',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
          'x-bot-token': token,
        },
        timeout: 4000,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          if (res.statusCode === 200) {
            console.log('[EmergencyStop] Successfully engaged Kill Switch via local server (HTTP 200).');
            try {
              const parsed = JSON.parse(body);
              console.log('[EmergencyStop] Server status:', parsed.killSwitchEngaged ? 'KILL SWITCH ENGAGED' : 'Status OK');
            } catch {}
            resolve(true);
          } else {
            console.warn(`[EmergencyStop] Server responded with HTTP ${res.statusCode}: ${body}`);
            resolve(false);
          }
        });
      }
    );

    req.on('error', () => {
      // Server might not be running or unreachable
      resolve(false);
    });

    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });

    req.write(postData);
    req.end();
  });
}

function stopStoredBotsDirectly() {
  const dataDir = path.resolve(process.cwd(), '.data');
  if (!fs.existsSync(dataDir)) {
    console.log('[EmergencyStop] .data directory does not exist. Nothing to stop.');
    return;
  }

  // 1. Update config.json to engage killswitch
  const configPath = path.join(dataDir, 'config.json');
  if (fs.existsSync(configPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      cfg.killSwitchEngaged = true;
      cfg.liveKillSwitchEngaged = true;
      cfg.paperKillSwitchEngaged = true;
      if (cfg.autopilot) {
        cfg.autopilot.enabled = false;
      }
      fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8');
      console.log('[EmergencyStop] .data/config.json updated: killSwitchEngaged = true, autopilot.enabled = false');
    } catch (err: any) {
      console.error('[EmergencyStop] Error updating config.json:', err.message);
    }
  }

  // 2. Mark all bots in grid_bots.json as STOPPED
  const gridBotsPath = path.join(dataDir, 'grid_bots.json');
  if (fs.existsSync(gridBotsPath)) {
    try {
      const bots = JSON.parse(fs.readFileSync(gridBotsPath, 'utf8'));
      if (Array.isArray(bots)) {
        let count = 0;
        for (const b of bots) {
          if (b.status === 'RUNNING' || b.status === 'INITIALIZING') {
            b.status = 'STOPPED';
            b.stopReason = 'Emergency Stop CLI Executed';
            b.stoppedAt = Date.now();
            b.updatedAt = Date.now();
            count++;
          }
        }
        fs.writeFileSync(gridBotsPath, JSON.stringify(bots, null, 2), 'utf8');
        console.log(`[EmergencyStop] Marked ${count} bots in .data/grid_bots.json as STOPPED.`);
      }
    } catch (err: any) {
      console.error('[EmergencyStop] Error stopping grid_bots.json:', err.message);
    }
  }

  // 3. Mark all bots in native_grid_bots.json as stopped
  const nativeBotsPath = path.join(dataDir, 'native_grid_bots.json');
  if (fs.existsSync(nativeBotsPath)) {
    try {
      const bots = JSON.parse(fs.readFileSync(nativeBotsPath, 'utf8'));
      if (Array.isArray(bots)) {
        let count = 0;
        for (const b of bots) {
          if (b.state === 'running' || b.state === 'starting') {
            b.state = 'stopped';
            b.stopReason = 'Emergency Stop CLI Executed';
            b.uTime = Date.now();
            count++;
          }
        }
        fs.writeFileSync(nativeBotsPath, JSON.stringify(bots, null, 2), 'utf8');
        console.log(`[EmergencyStop] Marked ${count} native bots in .data/native_grid_bots.json as stopped.`);
      }
    } catch (err: any) {
      console.error('[EmergencyStop] Error stopping native_grid_bots.json:', err.message);
    }
  }
}

async function main() {
  console.log('====================================================');
  console.log('   AUTOTRADE-V5 EMERGENCY STOP PROCEDURE TRIGGERED   ');
  console.log('====================================================');

  const token = process.env.BOT_CONTROL_TOKEN || 'tradebot5_admin_token';
  const serverContacted = await callLocalKillSwitch(token);

  // Also enforce direct store stop to ensure persistence is immediately locked
  stopStoredBotsDirectly();

  console.log('\n====================================================');
  console.log('RESULT: Emergency halt applied.');
  if (serverContacted) {
    console.log('The active server running on localhost has engaged KILL SWITCH.');
  } else {
    console.log('Stored configuration and bot files in .data/ have been set to STOPPED.');
    console.log('When you restart server.ts, all bots will remain stopped.');
  }
  console.log('====================================================\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('[EmergencyStop] Fatal error:', err);
  process.exit(1);
});
