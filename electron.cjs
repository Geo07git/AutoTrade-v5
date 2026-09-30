/**
 * Bloomberg // TradeBot v5.0 Pro - Electron Main Process
 * Standalone architecture using Electron's embedded Node.js runtime for the backend server.
 */
const { app, BrowserWindow, shell, Menu } = require('electron');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const SERVER_PORT = 3000;
const SERVER_URL = `http://localhost:${SERVER_PORT}`;

// ==========================================
// BACKEND SERVER PROCESS MODE
// ==========================================
if (process.argv.includes('--server-process')) {
  process.env.PORT = `${SERVER_PORT}`;
  process.env.NODE_ENV = 'production';
  try {
    const serverScript = path.join(__dirname, 'dist', 'server.cjs');
    require(serverScript);
  } catch (err) {
    console.error('[Backend Process] Failed to load server.cjs:', err);
    process.exit(1);
  }
  // Keep process alive
  process.on('uncaughtException', (err) => {
    console.error('[Backend Process Uncaught Exception]:', err);
  });
  return;
}

// ==========================================
// ELECTRON GUI MAIN PROCESS MODE
// ==========================================
let mainWindow = null;
let serverProcess = null;

function checkServerHealth() {
  return new Promise((resolve) => {
    const req = http.get(`${SERVER_URL}/api/health`, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function startBackendServer() {
  return new Promise(async (resolve) => {
    const alreadyRunning = await checkServerHealth();
    if (alreadyRunning) {
      console.log('[Electron] Backend server already running.');
      return resolve();
    }

    const distServer = path.join(__dirname, 'dist', 'server.cjs');
    if (!require('fs').existsSync(distServer)) {
      console.warn('[Electron] Warning: dist/server.cjs not found on disk.');
    }

    console.log('[Electron] Launching self-contained backend server using process.execPath...');

    // Spawn backend server using Electron's own embedded Node runtime (process.execPath) with --server-process flag
    serverProcess = spawn(process.execPath, [__filename, '--server-process'], {
      cwd: __dirname,
      stdio: 'inherit',
      env: {
        ...process.env,
        PORT: `${SERVER_PORT}`,
        NODE_ENV: 'production',
      },
    });

    serverProcess.on('error', (err) => {
      console.error('[Electron] Failed to start backend server process:', err);
    });

    serverProcess.on('exit', (code, signal) => {
      console.log(`[Electron] Backend server exited with code ${code}, signal ${signal}`);
      serverProcess = null;
    });

    // Poll until server is healthy
    let attempts = 0;
    const interval = setInterval(async () => {
      attempts++;
      const healthy = await checkServerHealth();
      if (healthy) {
        clearInterval(interval);
        console.log('[Electron] Self-contained backend server is healthy and ready.');
        resolve();
      } else if (attempts > 40) {
        clearInterval(interval);
        console.warn('[Electron] Timed out waiting for backend server. Loading UI anyway...');
        resolve();
      }
    }, 500);
  });
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1520,
    height: 940,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: '#000000',
    title: 'Bloomberg // TradeBot v5.0 Pro - Quant Trading Desk',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  Menu.setApplicationMenu(null);

  mainWindow.on('page-title-updated', (event, title) => {
    event.preventDefault();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setTitle(title);
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  await startBackendServer();

  mainWindow.loadURL(SERVER_URL);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function cleanupServer() {
  if (serverProcess) {
    console.log('[Electron] Terminating backend server child process...');
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', serverProcess.pid, '/f', '/t']);
      } else {
        serverProcess.kill('SIGTERM');
      }
    } catch (e) {}
    serverProcess = null;
  }
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(createWindow);

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  app.on('will-quit', () => {
    cleanupServer();
  });

  app.on('quit', () => {
    cleanupServer();
  });
}
