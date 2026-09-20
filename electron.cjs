/**
 * Bloomberg // TradeBot v5.0 Pro - Electron Main Process
 * Supports Windows, Linux, and macOS standalone desktop execution.
 */
const { app, BrowserWindow, shell, Menu } = require('electron');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

let mainWindow = null;
let serverProcess = null;
const SERVER_PORT = 3000;
const SERVER_URL = `http://localhost:${SERVER_PORT}`;

// Function to check if the background API server is already listening
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

// Function to start the backend server if not running
function startBackendServer() {
  return new Promise((resolve, reject) => {
    const isPackaged = app.isPackaged;
    let scriptPath;
    let runner = 'node';
    let args = [];

    const distServer = path.join(__dirname, 'dist', 'server.cjs');
    const devServer = path.join(__dirname, 'server.ts');

    if (require('fs').existsSync(distServer)) {
      scriptPath = distServer;
      args = [distServer];
    } else if (require('fs').existsSync(devServer)) {
      runner = 'npx';
      args = ['tsx', devServer];
    } else {
      console.warn('[Electron] Neither dist/server.cjs nor server.ts found.');
      return resolve();
    }

    console.log(`[Electron] Launching backend server with ${runner} ${args.join(' ')}...`);
    serverProcess = spawn(runner, args, {
      cwd: __dirname,
      env: { ...process.env, PORT: `${SERVER_PORT}`, NODE_ENV: isPackaged ? 'production' : 'development' },
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });

    serverProcess.on('error', (err) => {
      console.error('[Electron] Failed to start backend server:', err);
    });

    serverProcess.on('exit', (code, signal) => {
      console.log(`[Electron] Backend server exited with code ${code}, signal ${signal}`);
      serverProcess = null;
    });

    // Poll until the server is ready (up to 20 seconds)
    let attempts = 0;
    const interval = setInterval(async () => {
      attempts++;
      const healthy = await checkServerHealth();
      if (healthy) {
        clearInterval(interval);
        console.log('[Electron] Backend server is healthy and ready.');
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

  // Remove default menu for high-performance trader immersion
  Menu.setApplicationMenu(null);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Open external links in user's default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Ensure server is accessible before loading
  const alreadyRunning = await checkServerHealth();
  if (!alreadyRunning) {
    await startBackendServer();
  }

  mainWindow.loadURL(SERVER_URL);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Single instance lock
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
    } catch (e) {
      // Ignore cleanup error
    }
    serverProcess = null;
  }
}

app.on('before-quit', cleanupServer);

app.on('window-all-closed', function () {
  cleanupServer();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
