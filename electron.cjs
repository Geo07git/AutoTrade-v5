/**
 * Bloomberg // TradeBot v5.0 Pro - Electron Main Process
 * Professional standalone desktop architecture using ELECTRON_RUN_AS_NODE.
 */
const { app, BrowserWindow, shell, Menu } = require('electron');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

let mainWindow = null;
let serverProcess = null;
const SERVER_PORT = 3000;
const SERVER_URL = `http://localhost:${SERVER_PORT}`;

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

function getServerScriptPath() {
  if (app.isPackaged) {
    // In packaged app, look in app.asar.unpacked/dist/server.cjs
    const unpackedPath = path.join(process.resourcesPath, 'app.asar.unpacked', 'dist', 'server.cjs');
    if (require('fs').existsSync(unpackedPath)) {
      return unpackedPath;
    }
  }
  return path.join(__dirname, 'dist', 'server.cjs');
}

function startBackendServer() {
  return new Promise(async (resolve) => {
    const alreadyRunning = await checkServerHealth();
    if (alreadyRunning) {
      console.log('[Electron] Backend server already running.');
      return resolve();
    }

    const serverScript = getServerScriptPath();
    const fs = require('fs');
    if (!fs.existsSync(serverScript)) {
      console.error('[Electron] CRITICAL: server.cjs not found at:', serverScript);
      return resolve();
    }

    // In packaged mode, use OS userData directory (%APPDATA%) so .data/ is always writable and persists across updates.
    // In local electron:dev mode, use project root (__dirname) so existing .data/ config and positions are preserved.
    const workingDir = app.isPackaged ? app.getPath('userData') : __dirname;
    try {
      if (!fs.existsSync(workingDir)) {
        fs.mkdirSync(workingDir, { recursive: true });
      }
    } catch (e) {
      console.warn('[Electron] Could not create workingDir:', e);
    }

    const staticDistDir = path.dirname(serverScript);
    console.log('[Electron] Launching backend server using ELECTRON_RUN_AS_NODE:', {
      serverScript,
      workingDir,
      staticDistDir,
    });

    // Spawn Electron binary as a pure Node.js process using ELECTRON_RUN_AS_NODE=1
    // Always set NODE_ENV='production' when running the compiled dist/server.cjs bundle
    serverProcess = spawn(process.execPath, [serverScript], {
      cwd: workingDir,
      stdio: 'inherit',
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        PORT: `${SERVER_PORT}`,
        NODE_ENV: 'production',
        STATIC_DIST_PATH: staticDistDir,
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
        console.log('[Electron] Backend server is healthy and ready.');
        resolve();
      } else if (attempts > 50) {
        clearInterval(interval);
        console.warn('[Electron] Timed out waiting for backend server. Loading UI anyway...');
        resolve();
      }
    }, 400);
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
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    console.warn(`[Electron] Page load failed (${errorCode}: ${errorDescription}). Retrying in 1.5s...`);
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.loadURL(SERVER_URL);
      }
    }, 1500);
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
