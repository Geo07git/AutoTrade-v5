// Client-side mock backend for Capacitor APK execution where Node.js server cannot run
import { BotStatusResponse, AuditLog, OrderRecord, Position, AppConfig, ProfileConfig, ScannerStats } from '../shared/types';

const STORAGE_KEYS = {
  STATUS: 'tb5_mock_status',
  LOGS: 'tb5_mock_logs',
  ORDERS: 'tb5_mock_orders',
  CONFIG: 'tb5_mock_config',
  SCANNER: 'tb5_mock_scanner'
};

function getInitialConfig(): AppConfig {
  return {
    executionMode: 'PAPER',
    activeProfile: 'MOMENTUM',
    testnet: true,
    killSwitchEngaged: false,
    invertSignals: false,
    paperEquity: 10000,
    maxLeverage: '5x' as any,
    baseCapital: 1000,
    lockProfitVault: false,
    profitVault: 0,
    profiles: {
      MOMENTUM: {
        type: 'MOMENTUM',
        timeframes: ['60', '240'],
        riskPerTradePct: 2,
        maxOpenPositions: 5,
        trailingActivationPct: 1.5,
        trailingDistancePct: 0.8,
        breakEvenActivationPct: 1.0,
        takeProfitPct: 3.5,
        hardStopLossPct: 2.0,
        equityProtectionActivationPct: 5.0,
        equityTrailingDrawdownPct: 2.5
      },
      SCALP: {
        type: 'SCALP',
        timeframes: ['15', '60'],
        riskPerTradePct: 1.5,
        maxOpenPositions: 6,
        trailingActivationPct: 1.0,
        trailingDistancePct: 0.5,
        breakEvenActivationPct: 0.6,
        takeProfitPct: 2.0,
        hardStopLossPct: 1.2,
        equityProtectionActivationPct: 4.0,
        equityTrailingDrawdownPct: 2.0
      }
    }
  };
}

function getInitialStatus(): BotStatusResponse {
  const config = getInitialConfig();
  const sampleOpportunities = [
    {
      symbol: 'BTC-USDT-SWAP',
      price: 95400,
      volume24hUSDT: 1850000000,
      priceChange24hPct: 2.45,
      rvol: 2.1,
      atrExpansion: 1.4,
      score: 88.5,
      side: 'BUY' as const,
      isEligible: true,
      rank: 1,
      lastScannedTime: Date.now(),
    },
    {
      symbol: 'ETH-USDT-SWAP',
      price: 3520,
      volume24hUSDT: 920000000,
      priceChange24hPct: 1.85,
      rvol: 1.8,
      atrExpansion: 1.2,
      score: 82.0,
      side: 'BUY' as const,
      isEligible: true,
      rank: 2,
      lastScannedTime: Date.now(),
    },
    {
      symbol: 'SOL-USDT-SWAP',
      price: 198.5,
      volume24hUSDT: 540000000,
      priceChange24hPct: 4.12,
      rvol: 2.4,
      atrExpansion: 1.6,
      score: 79.2,
      side: 'BUY' as const,
      isEligible: true,
      rank: 3,
      lastScannedTime: Date.now(),
    },
    {
      symbol: 'SUI-USDT-SWAP',
      price: 1.22,
      volume24hUSDT: 210000000,
      priceChange24hPct: 6.35,
      rvol: 3.1,
      atrExpansion: 1.8,
      score: 75.8,
      side: 'BUY' as const,
      isEligible: true,
      rank: 4,
      lastScannedTime: Date.now(),
    }
  ];

  return {
    state: 'TRADING',
    executionMode: 'PAPER',
    config,
    profileConfig: config.profiles!.MOMENTUM,
    equity: 10160,
    initialEquity: 10000,
    walletBalance: 10000,
    freeBalance: 85375,
    marginInvested: 14625,
    unrealizedPnL: 160,
    totalProfit: 160,
    totalProfitPct: 1.6,
    profitVault: 0,
    operatingEquity: 10160,
    usableFreeBalance: 85375,
    baseCapital: 10000,
    lockProfitVault: false,
    equityHistory: [{ time: Date.now(), equity: 10160 }],
    sessionRealizedPnL: 0,
    performanceMetrics: {
      totalClosed: 0,
      winningTrades: 0,
      losingTrades: 0,
      winRate: 0,
      profitFactor: 0,
      expectancy: 0,
      avgWin: 0,
      avgLoss: 0,
      maxDrawdownPct: 0,
      totalFeesPaid: 7.31,
    },
    positions: [
      {
        id: 'pos_btc_1',
        symbol: 'BTC-USDT-SWAP',
        side: 'BUY',
        qty: 0.1,
        entryPrice: 94500,
        sizeUSDT: 9450,
        status: 'OPEN',
        entryTime: Date.now() - 3600000,
        currentPrice: 95200,
        pnl: 70,
        pnlPct: 0.74,
        profile: 'MOMENTUM',
        source: 'PAPER',
        executionMode: 'PAPER',
      },
      {
        id: 'pos_eth_1',
        symbol: 'ETH-USDT-SWAP',
        side: 'BUY',
        qty: 1.5,
        entryPrice: 3450,
        sizeUSDT: 5175,
        status: 'OPEN',
        entryTime: Date.now() - 1800000,
        currentPrice: 3510,
        pnl: 90,
        pnlPct: 1.74,
        profile: 'MOMENTUM',
        source: 'PAPER',
        executionMode: 'PAPER',
      }
    ],
    orders: [],
    connected: true,
    lastSyncTime: Date.now(),
    marketRegime: 'BTC: +2.45% (BULL)',
    marketSentiment: 'OKX BULLISH (+2.45%)',
    marketSentimentScore: 72,
    scannerStats: {
      universeCount: 479,
      filteredCount: 221,
      candidatesCount: 45,
      lastScanDurationMs: 1250,
      lastScanTimestamp: Date.now(),
      isScanning: false,
      topOpportunities: sampleOpportunities,
      filterConfig: {
        min24hVolumeUSDT: 1500000,
        max24hVolumeUSDT: 0,
        minPrice: 0.0001,
        maxSymbols: 500,
        settleCoin: 'USDT',
        refreshIntervalMs: 900000,
        maxSpreadPct: 0.15,
        excludedSymbols: ['CAP', 'ONDO', 'NIGHT', 'ARX', 'GPS', 'ZAMA'],
      }
    },
    telegramActive: false,
    telegramStatus: {
      configured: false,
      hasToken: false,
      hasChatId: false,
      maskedToken: '',
      chatId: '',
      notificationsEnabled: false
    }
  };
}

function getStoredStatus(): BotStatusResponse {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.STATUS);
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  const initial = getInitialStatus();
  localStorage.setItem(STORAGE_KEYS.STATUS, JSON.stringify(initial));
  return initial;
}

function saveStatus(status: BotStatusResponse) {
  localStorage.setItem(STORAGE_KEYS.STATUS, JSON.stringify(status));
}

function getStoredLogs(): AuditLog[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.LOGS);
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  const initial: AuditLog[] = [
    {
      id: 'log_1',
      timestamp: Date.now() - 3600000,
      type: 'EXCHANGE_CONNECTED',
      message: 'Connected to Bloomberg TradeBot Pro Mobile Paper Engine.'
    },
    {
      id: 'log_2',
      timestamp: Date.now() - 1800000,
      type: 'POSITION_OPENED',
      message: 'Opened LONG position on BTC-USDT-SWAP at $94,500.'
    }
  ];
  localStorage.setItem(STORAGE_KEYS.LOGS, JSON.stringify(initial));
  return initial;
}

function saveLogs(logs: AuditLog[]) {
  localStorage.setItem(STORAGE_KEYS.LOGS, JSON.stringify(logs));
}

function getStoredOrders(): OrderRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.ORDERS);
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return [];
}

function saveOrders(orders: OrderRecord[]) {
  localStorage.setItem(STORAGE_KEYS.ORDERS, JSON.stringify(orders));
}

export function initCapacitorMockBackend() {
  if (typeof window === 'undefined' || !Boolean((window as any).Capacitor?.isNativePlatform?.())) return;

  const originalFetch = window.fetch;

  const mockFetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    // Check if it's an API request
    if (urlStr.includes('/api/')) {
      const endpoint = urlStr.split('?')[0];
      const method = init?.method || 'GET';
      const body = init?.body ? JSON.parse(init.body.toString()) : null;

      const status = getStoredStatus();
      const logs = getStoredLogs();
      const orders = getStoredOrders();

      try {
        if (endpoint.endsWith('/api/health')) {
          return new Response(JSON.stringify({ status: 'ok', bot: 'TradeBot 5 Mobile' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        if (endpoint.endsWith('/api/bot/status')) {
          const rawExp = localStorage.getItem('tb5_mock_experiment');
          const expState = rawExp ? JSON.parse(rawExp) : null;
          if (expState?.isActive) {
            status.isExperimentActive = true;
            status.experimentState = expState;
            status.equity = 10000 + (status.unrealizedPnL || 0);
            status.walletBalance = 10000;
            status.freeBalance = 10000 - (status.marginInvested || 0);
            status.usableFreeBalance = status.freeBalance;
            status.baseCapital = 10000;
            status.initialEquity = 10000;
            status.operatingEquity = status.equity;
          } else {
            status.isExperimentActive = false;
          }
          return new Response(JSON.stringify(status), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        if (endpoint.endsWith('/api/bot/logs')) {
          return new Response(JSON.stringify(logs), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        if (endpoint.endsWith('/api/bot/logs/clear')) {
          saveLogs([]);
          return new Response(JSON.stringify({ success: true, logs: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        if (endpoint.endsWith('/api/bot/orders')) {
          return new Response(JSON.stringify(orders), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        if (endpoint.endsWith('/api/bot/orders/clear')) {
          saveOrders([]);
          return new Response(JSON.stringify({ success: true, orders: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        if (endpoint.endsWith('/api/bot/auth-verify')) {
          return new Response(JSON.stringify({ valid: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        if (endpoint.endsWith('/api/bot/mode')) {
          if (method === 'POST' && body) {
            status.executionMode = body.mode || 'PAPER';
            saveStatus(status);
          }
          return new Response(
            JSON.stringify({
              executionMode: status.executionMode,
              state: status.state,
              testnet: status.config.testnet,
              hasCredentials: true
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }

        if (endpoint.endsWith('/api/bot/sentiment')) {
          return new Response(
            JSON.stringify({
              sentiment: status.marketSentiment || 'BULLISH',
              score: status.marketSentimentScore || 72
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }

        if (endpoint.includes('/api/bot/position/') && endpoint.endsWith('/close')) {
          const parts = endpoint.split('/');
          const symbol = parts[parts.length - 2];
          status.positions = status.positions.filter((p) => p.symbol !== symbol);
          saveStatus(status);
          logs.unshift({
            id: 'log_' + Date.now(),
            timestamp: Date.now(),
            type: 'POSITION_CLOSED',
            message: `Closed position for ${symbol} via Mobile interface.`
          });
          saveLogs(logs);
          return new Response(JSON.stringify({ success: true, symbol }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        if (endpoint.endsWith('/api/bot/paper-reset')) {
          status.equity = 10000;
          status.walletBalance = 10000;
          status.freeBalance = 10000;
          status.positions = [];
          status.profitVault = 0;
          saveStatus(status);
          return new Response(JSON.stringify({ success: true, equity: 10000 }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        if (endpoint.endsWith('/api/bot/scanner/scan')) {
          return new Response(
            JSON.stringify({
              success: true,
              opportunitiesCount: status.scannerStats?.topOpportunities?.length || 4,
              topOpportunities: status.scannerStats?.topOpportunities || []
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }

        if (endpoint.endsWith('/api/bot/experiment/status')) {
          const rawExp = localStorage.getItem('tb5_mock_experiment');
          const expState = rawExp ? JSON.parse(rawExp) : {
            isActive: false,
            startTime: 0,
            elapsedMs: 0,
            remainingMs: 8 * 3600 * 1000,
            durationMs: 8 * 3600 * 1000,
            unlimitedCapital: 10_000,
            minMomentumScore: 50,
            profile: 'SCALP',
            totalEntries: 2,
            totalExits: 0,
            totalPnl: 160,
          };
          return new Response(JSON.stringify({ success: true, state: expState, logsCount: 2 }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        if (endpoint.endsWith('/api/bot/experiment/start')) {
          const customConfig: any = body || {};

          const durationHours = Math.min(12, Math.max(1, Number(customConfig?.durationHours) || 8));
          const minMomentumScore = Math.min(100, Math.max(50, Number(customConfig?.minMomentumScore) || 50));
          const maxHoldingTimeMinutes = Math.min(120, Math.max(15, Number(customConfig?.maxHoldingTimeMinutes) || 120));
          const durationMs = durationHours * 3600 * 1000;

          const expState = {
            isActive: true,
            startTime: Date.now(),
            elapsedMs: 0,
            remainingMs: durationMs,
            durationMs,
            durationHours,
            unlimitedCapital: 10_000,
            minMomentumScore,
            maxHoldingTimeMinutes,
            hardStopLossPct: Number(customConfig?.hardStopLossPct) || 20.0,
            breakEvenActivationPct: Number(customConfig?.breakEvenActivationPct) || 5.0,
            trailingActivationPct: Number(customConfig?.trailingActivationPct) || 2.5,
            trailingDistancePct: Number(customConfig?.trailingDistancePct) || 0.5,
            takeProfitPct: Number(customConfig?.takeProfitPct) || 20.0,
            profile: 'SCALP',
            totalEntries: 2,
            totalExits: 0,
            totalPnl: 160,
            config: {
              durationHours,
              minMomentumScore,
              maxHoldingTimeMinutes,
              hardStopLossPct: Number(customConfig?.hardStopLossPct) || 20.0,
              breakEvenActivationPct: Number(customConfig?.breakEvenActivationPct) || 5.0,
              trailingActivationPct: Number(customConfig?.trailingActivationPct) || 2.5,
              trailingDistancePct: Number(customConfig?.trailingDistancePct) || 0.5,
              takeProfitPct: Number(customConfig?.takeProfitPct) || 20.0,
            }
          };
          localStorage.setItem('tb5_mock_experiment', JSON.stringify(expState));
          return new Response(JSON.stringify({ success: true, state: expState, message: `Experimentul de ${durationHours} ore a fost pornit în modul APK!` }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        if (endpoint.endsWith('/api/bot/experiment/stop')) {
          const rawExp = localStorage.getItem('tb5_mock_experiment');
          const expState = rawExp ? JSON.parse(rawExp) : {};
          expState.isActive = false;
          localStorage.setItem('tb5_mock_experiment', JSON.stringify(expState));
          return new Response(JSON.stringify({ success: true, state: expState, message: 'Experiment oprit!' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        if (endpoint.includes('/api/bot/experiment/download')) {
          const isCsv = endpoint.includes('format=csv');
          const dateStr = new Date().toISOString().split('T')[0];
          const rawExp = localStorage.getItem('tb5_mock_experiment');
          const expState = rawExp ? JSON.parse(rawExp) : { durationHours: 8 };
          const hours = expState.durationHours || 8;
          if (isCsv) {
            const csvContent = 'Event ID,Timestamp,Date (ISO),Event Type,Symbol,Side,Score,Entry Price,Exit Price,Size (USDT),PnL (USDT),PnL (%),Holding Time (min),Exit Reason,Account Capital (USDT)\n' +
              `exp_mock_1,${Date.now()},${new Date().toISOString()},EXPERIMENT_STARTED,ALL,NONE,${expState.minMomentumScore || 50},0,0,0,0,0,0,INIT,10000`;
            const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8' });
            return new Response(blob, {
              status: 200,
              headers: {
                'Content-Type': 'text/csv; charset=utf-8',
                'Content-Disposition': `attachment; filename="experiment_${hours}h_${dateStr}.csv"`
              }
            });
          } else {
            const payload = {
              experimentMetadata: {
                title: `EXPERIMENT ${hours}H: SCALP (APK SIMULATION)`,
                durationHours: hours,
                status: expState.isActive ? 'RUNNING' : 'STOPPED',
              },
              effectiveConfiguration: expState.config || {},
              logs: []
            };
            const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
            return new Response(blob, {
              status: 200,
              headers: {
                'Content-Type': 'application/json',
                'Content-Disposition': `attachment; filename="experiment_${hours}h_${dateStr}.json"`
              }
            });
          }
        }

        // Generic fallback for any other API request
        return new Response(JSON.stringify({ success: true, message: 'Mock handled' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message || 'Mock error' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // Default to original fetch for non-API requests (like OKX public WS/REST market data)
    return originalFetch(input, init);
  };

  try {
    Object.defineProperty(window, 'fetch', {
      value: mockFetch,
      writable: true,
      configurable: true,
      enumerable: true
    });

    // Start background simulated price tick loop for APK
    setInterval(() => {
      try {
        const status = getStoredStatus();
        if (status.positions && status.positions.length > 0) {
          let totalUnrealized = 0;
          for (const pos of status.positions) {
            const jitter = (Math.random() - 0.48) * 0.002;
            const newPrice = parseFloat((pos.currentPrice * (1 + jitter)).toFixed(4));
            pos.currentPrice = newPrice;
            const isBuy = pos.side.toUpperCase() === 'BUY';
            const diff = isBuy ? (newPrice - pos.entryPrice) : (pos.entryPrice - newPrice);
            pos.pnl = parseFloat((diff * pos.qty).toFixed(2));
            pos.pnlPct = parseFloat(((diff / pos.entryPrice) * 100).toFixed(2));
            totalUnrealized += pos.pnl;
          }
          status.unrealizedPnL = parseFloat(totalUnrealized.toFixed(2));
          status.equity = parseFloat((status.walletBalance + status.unrealizedPnL).toFixed(2));
          status.totalProfit = parseFloat((status.equity - status.initialEquity).toFixed(2));
          status.totalProfitPct = parseFloat(((status.totalProfit / status.initialEquity) * 100).toFixed(2));
          saveStatus(status);
        }
      } catch (e) {}
    }, 3000);
  } catch (e) {
    console.warn('Could not define window.fetch property:', e);
  }
}
