/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import React, { useEffect, useState } from 'react';
import {
  BotStatusResponse,
  AuditLog,
  OrderRecord,
  Position,
  ExecutionMode,
  ProfileType,
} from './shared/types';
import { BloombergTerminal } from './components/BloombergTerminal';

export default function App() {
  const [status, setStatus] = useState<BotStatusResponse | null>(null);
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [orders, setOrders] = useState<OrderRecord[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isReconciling, setIsReconciling] = useState<boolean>(false);
  const [isScanningNow, setIsScanningNow] = useState<boolean>(false);

  // Authentication token stored locally for control endpoints
  const [controlToken, setControlToken] = useState<string>(() => {
    return localStorage.getItem('tb5_control_token') || 'tradebot5_admin_token';
  });

  const handleUpdateControlToken = (token: string) => {
    const trimmed = token.trim();
    localStorage.setItem('tb5_control_token', trimmed);
    setControlToken(trimmed);
    setSuccessMessage('Bot Control Token a fost actualizat și salvat local.');
  };

  const getAuthHeaders = () => ({
    'Content-Type': 'application/json',
    'x-bot-token': controlToken,
  });

  const fetchStatus = async () => {
    try {
      const res = await fetch('/api/bot/status');
      const contentType = res.headers.get('content-type');
      if (res.ok && contentType && contentType.includes('application/json')) {
        const data: BotStatusResponse = await res.json();
        setStatus(data);
      }
    } catch (err) {
      console.warn('[Network] Transient error fetching status:', err);
    }
  };

  const fetchLogs = async () => {
    try {
      const res = await fetch('/api/bot/logs');
      const contentType = res.headers.get('content-type');
      if (res.ok && contentType && contentType.includes('application/json')) {
        const data = await res.json();
        setLogs(data);
      }
    } catch (err) {
      console.warn('[Network] Transient error fetching logs:', err);
    }
  };

  const fetchOrders = async () => {
    try {
      const res = await fetch('/api/bot/orders');
      const contentType = res.headers.get('content-type');
      if (res.ok && contentType && contentType.includes('application/json')) {
        const data = await res.json();
        setOrders(data);
      }
    } catch (err) {
      console.warn('[Network] Transient error fetching orders:', err);
    }
  };

  // Dedicated fetcher for OKX global market sentiment score
  const fetchSentiment = async () => {
    try {
      const res = await fetch('/api/bot/sentiment');
      const contentType = res.headers.get('content-type');
      if (res.ok && contentType && contentType.includes('application/json')) {
        const data = await res.json();
        if (data.sentiment) {
          setStatus((prev) =>
            prev
              ? {
                  ...prev,
                  marketSentiment: data.sentiment,
                  marketSentimentScore: data.score,
                }
              : null
          );
        }
      }
    } catch (err) {
      console.warn('[Network] Transient error fetching global sentiment:', err);
    }
  };

  useEffect(() => {
    fetchStatus();
    fetchLogs();
    fetchOrders();
    fetchSentiment();

    const interval = setInterval(() => {
      fetchStatus();
      fetchLogs();
      fetchOrders();
      fetchSentiment();
    }, 3000);

    // Dedicated polling interval for fetching global sentiment independently
    const sentimentInterval = setInterval(fetchSentiment, 10000);

    return () => {
      clearInterval(interval);
      clearInterval(sentimentInterval);
    };
  }, []);

  const switchExecutionMode = async (mode: ExecutionMode) => {
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const res = await fetch('/api/bot/mode', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ mode }),
      });
      const data = await res.json();

      if (!res.ok) {
        setErrorMessage(data.error || 'Eroare la schimbarea modului de execuție');
      } else {
        setSuccessMessage(`Modul de execuție a fost schimbat în ${mode}`);
        await fetchStatus();
        await fetchLogs();
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Eroare la schimbarea modului');
    }
  };

  const handleUpdateCredentials = async (
    apiKey: string,
    secretKey: string,
    passphrase: string,
    testnet: boolean
  ): Promise<{ success: boolean; error?: string }> => {
    setErrorMessage(null);
    setSuccessMessage(null);
    try {
      const res = await fetch('/api/bot/credentials', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ apiKey, secretKey, passphrase, testnet }),
      });
      const data = await res.json();
      if (!res.ok) {
        const err = data.error || 'Eroare la salvarea cheilor OKX';
        setErrorMessage(err);
        return { success: false, error: err };
      }
      setSuccessMessage(data.message || 'Cheile OKX au fost salvate și verificate.');
      await fetchStatus();
      await fetchLogs();
      return { success: true };
    } catch (err: any) {
      const errMsg = err.message || 'Eroare de rețea la salvarea cheilor';
      setErrorMessage(errMsg);
      return { success: false, error: errMsg };
    }
  };

  const handleTestOKXConnection = async (creds?: {
    apiKey?: string;
    secretKey?: string;
    passphrase?: string;
    isDemo?: boolean;
  }) => {
    try {
      const res = await fetch('/api/bot/okx/test-connection', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify(creds || {}),
      });
      return await res.json();
    } catch (err: any) {
      return { reachable: false, authenticated: false, error: err.message || 'Eroare la testarea conexiunii OKX' };
    }
  };

  const handleSaveTelegramConfig = async (token: string, chatId: string, botUsername?: string) => {
    try {
      const res = await fetch('/api/bot/telegram/config', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ token, chatId, botUsername }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        return { success: false, error: data.error || 'Eroare la salvarea configurației Telegram' };
      }
      setSuccessMessage(data.message || 'Configurația Telegram a fost salvată.');
      await fetchStatus();
      return { success: true, message: data.message, status: data.status };
    } catch (err: any) {
      return { success: false, error: err.message || 'Eroare de rețea la salvarea Telegram' };
    }
  };

  const handleTestTelegramConnection = async (token?: string, chatId?: string) => {
    try {
      const res = await fetch('/api/bot/telegram/test-connection', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ token, chatId }),
      });
      return await res.json();
    } catch (err: any) {
      return {
        success: false,
        reachable: false,
        validToken: false,
        error: err.message || 'Eroare de rețea la testarea Telegram',
      };
    }
  };

  const resetPaperAccount = async () => {
    setErrorMessage(null);
    setSuccessMessage(null);
    try {
      const res = await fetch('/api/bot/paper-reset', {
        method: 'POST',
        headers: getAuthHeaders(),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMessage(data.error || 'Failed to reset paper account');
      } else {
        setSuccessMessage('Paper account reset successfully to $200.00');
        await fetchStatus();
        await fetchLogs();
        await fetchOrders();
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to reset paper account');
    }
  };

  const toggleKillswitch = async () => {
    setErrorMessage(null);
    setSuccessMessage(null);
    try {
      const res = await fetch('/api/bot/killswitch', {
        method: 'POST',
        headers: getAuthHeaders(),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMessage(data.error || 'Failed to toggle kill switch');
      } else {
        setSuccessMessage(
          data.killSwitchEngaged
            ? 'EMERGENCY KILL SWITCH ENGAGED! All positions closed.'
            : 'Kill switch disengaged.'
        );
        await fetchStatus();
        await fetchLogs();
        await fetchOrders();
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to toggle kill switch');
    }
  };

  const switchProfile = async (profile: ProfileType) => {
    setErrorMessage(null);
    setSuccessMessage(null);
    try {
      const res = await fetch('/api/bot/profile', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ profile }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMessage(data.error || 'Failed to switch profile');
      } else {
        setSuccessMessage(`Active profile set to ${profile}`);
        await fetchStatus();
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to switch profile');
    }
  };

  const updateProfileSettings = async (profileType: ProfileType, settings: any) => {
    try {
      const res = await fetch('/api/bot/profile/settings', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ profileType, settings }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMessage(data.error || 'Failed to update settings');
      } else {
        if (data.status) setStatus(data.status);
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to update settings');
    }
  };

  const closePositionManually = async (symbol: string) => {
    setErrorMessage(null);
    setSuccessMessage(null);
    try {
      const res = await fetch(`/api/bot/position/${symbol}/close`, {
        method: 'POST',
        headers: getAuthHeaders(),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMessage(data.error || 'Failed to close position');
      } else {
        setSuccessMessage(`Closed position for ${symbol}`);
        await fetchStatus();
        await fetchOrders();
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to close position');
    }
  };

  const handleTriggerScan = async () => {
    setIsScanningNow(true);
    setErrorMessage(null);
    try {
      const res = await fetch('/api/bot/scanner/scan', {
        method: 'POST',
        headers: getAuthHeaders(),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMessage(data.error || 'Scan failed');
      } else {
        setSuccessMessage(`Universe scan completed. Found ${data.length || 0} candidates.`);
        await fetchStatus();
        await fetchLogs();
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Scan failed');
    } finally {
      setIsScanningNow(false);
    }
  };

  const handleClearLogs = async () => {
    try {
      const res = await fetch('/api/bot/logs/clear', {
        method: 'POST',
        headers: getAuthHeaders(),
      });
      if (res.ok) {
        setLogs([]);
        setSuccessMessage('Desk Audit Feed cleared.');
        await fetchLogs();
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to clear logs');
    }
  };

  const handleClearOrders = async () => {
    try {
      const res = await fetch('/api/bot/orders/clear', {
        method: 'POST',
        headers: getAuthHeaders(),
      });
      if (res.ok) {
        setOrders([]);
        setSuccessMessage('Order Blotter history cleared.');
        await fetchOrders();
        await fetchLogs();
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to clear orders');
    }
  };

  return (
    <BloombergTerminal
      status={status}
      logs={logs}
      orders={orders}
      onRefresh={() => {
        fetchStatus();
        fetchLogs();
        fetchOrders();
      }}
      onSwitchMode={switchExecutionMode}
      onSwitchProfile={switchProfile}
      onUpdateProfileSettings={updateProfileSettings}
      onClosePosition={closePositionManually}
      onResetPaper={resetPaperAccount}
      onToggleKillSwitch={toggleKillswitch}
      onTriggerScan={handleTriggerScan}
      onClearLogs={handleClearLogs}
      onClearOrders={handleClearOrders}
      onUpdateCredentials={handleUpdateCredentials}
      onTestOKXConnection={handleTestOKXConnection}
      onSaveTelegramConfig={handleSaveTelegramConfig}
      onTestTelegramConnection={handleTestTelegramConnection}
      controlToken={controlToken}
      onUpdateControlToken={handleUpdateControlToken}
      errorMessage={errorMessage}
      successMessage={successMessage}
    />
  );
}
