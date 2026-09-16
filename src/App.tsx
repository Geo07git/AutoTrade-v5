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
      console.error('Error fetching status:', err);
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
      console.error('Error fetching logs:', err);
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
      console.error('Error fetching orders:', err);
    }
  };

  useEffect(() => {
    fetchStatus();
    fetchLogs();
    fetchOrders();

    const interval = setInterval(() => {
      fetchStatus();
      fetchLogs();
      fetchOrders();
    }, 3000);

    return () => clearInterval(interval);
  }, []);

  const switchExecutionMode = async (mode: ExecutionMode) => {
    setErrorMessage(null);
    setSuccessMessage(null);

    if (mode === 'LIVE') {
      setErrorMessage('LIVE trading is strictly blocked and disabled for safety reasons.');
      return;
    }

    try {
      const res = await fetch('/api/bot/mode', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ mode }),
      });
      const data = await res.json();

      if (!res.ok) {
        setErrorMessage(data.error || 'Failed to switch execution mode');
      } else {
        setSuccessMessage(`Switched execution mode to ${mode}`);
        await fetchStatus();
        await fetchLogs();
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to switch execution mode');
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
        setSuccessMessage('Paper account reset successfully to $10,000.00');
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
      errorMessage={errorMessage}
      successMessage={successMessage}
    />
  );
}
