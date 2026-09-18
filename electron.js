/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    backgroundColor: '#000000',
    title: 'Bloomberg // TradeBot v5.0 Pro',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Load the built app or local dev server
  mainWindow.loadURL('http://localhost:3000');
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});
