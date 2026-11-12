import { useEffect, useRef } from 'react';
import { BotStatusResponse } from '../shared/types';

interface UseDynamicTaskbarProps {
  status: BotStatusResponse | null;
}

/**
 * useDynamicTaskbar Hook
 * 
 * Provides dynamic taskbar presence for both web browser and desktop (.exe / Electron):
 * 1. Dynamic Window Title: Live updates with Total Equity (EQ Tot), trade indicator (🟢 / 🔴 / ⚪),
 *    and PnL. When minimized/hidden, it toggles a clean dynamic pulse.
 * 2. Dynamic Favicon: Renders a real-time glowing canvas badge with active trade pulse.
 * 3. Windows Taskbar Badging API: Calls navigator.setAppBadge to show active trade counts directly
 *    on the Windows taskbar icon.
 */
export function useDynamicTaskbar({ status }: UseDynamicTaskbarProps) {
  const lastTitleRef = useRef<string>('');
  const lastFaviconKeyRef = useRef<string>('');

  useEffect(() => {
    const currentEquity = status?.equity !== undefined ? status.equity : 200.0;
    const positions = status?.positions || [];
    const activePositions = positions.filter((p) => p.status === 'OPEN');
    const runningGridBots = (status?.gridBots || []).filter((b) => b.status === 'RUNNING');
    const activeCount = runningGridBots.length > 0 ? runningGridBots.length : activePositions.length;
    const hasActiveTrade = activeCount > 0 || Boolean(status?.autopilot?.enabled);

    const unrealizedPnL =
      status?.totalProfit !== undefined
        ? status.totalProfit
        : status?.unrealizedPnL !== undefined
        ? status.unrealizedPnL
        : activePositions.reduce((acc, p) => acc + (p.pnl || 0), 0);

    const isProfit = unrealizedPnL >= 0;
    const formattedEq = `$${currentEquity.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
    const pnlSign = unrealizedPnL > 0 ? '+' : '';
    const formattedPnl = `${pnlSign}$${unrealizedPnL.toFixed(2)}`;

    // 1. Windows Taskbar Badging API
    if ('setAppBadge' in navigator && typeof (navigator as any).setAppBadge === 'function') {
      try {
        if (hasActiveTrade) {
          (navigator as any).setAppBadge(activeCount).catch(() => {});
        } else {
          (navigator as any).clearAppBadge?.().catch(() => {});
        }
      } catch {}
    }

    // 2. Update Window Title only when changed
    const dot = hasActiveTrade ? (isProfit ? '🟢' : '🔴') : '⚪';
    const tradeLabel = activeCount === 1 ? '1 GRID' : `${activeCount} GRIDS`;
    const titleStr = hasActiveTrade
      ? `${dot} ${formattedEq} [${formattedPnl}] | TB5 (${tradeLabel})`
      : `${dot} ${formattedEq} | TB5 (STANDBY)`;

    if (titleStr !== lastTitleRef.current) {
      lastTitleRef.current = titleStr;
      document.title = titleStr;
    }

    // 3. Update Favicon only when state state (hasActiveTrade + isProfit) changes, skipping inside mobile/iframe if unchanged
    const faviconKey = `${hasActiveTrade}_${isProfit}`;
    if (faviconKey !== lastFaviconKeyRef.current) {
      lastFaviconKeyRef.current = faviconKey;
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 32;
        canvas.height = 32;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.clearRect(0, 0, 32, 32);
          ctx.beginPath();
          ctx.roundRect(1, 1, 30, 30, 7);
          ctx.fillStyle = '#09090b';
          ctx.fill();
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = hasActiveTrade ? (isProfit ? '#10b981' : '#f43f5e') : '#3f3f46';
          ctx.stroke();

          ctx.beginPath();
          ctx.arc(16, 16, hasActiveTrade ? 6 : 4.5, 0, Math.PI * 2);
          ctx.fillStyle = hasActiveTrade ? (isProfit ? '#10b981' : '#f43f5e') : '#71717a';
          ctx.fill();

          let link: HTMLLinkElement | null = document.querySelector("link[rel*='icon']");
          if (!link) {
            link = document.createElement('link');
            link.rel = 'shortcut icon';
            link.type = 'image/png';
            document.head.appendChild(link);
          }
          link.href = canvas.toDataURL('image/png');
        }
      } catch {}
    }
  }, [status?.equity, status?.totalProfit, status?.unrealizedPnL, status?.gridBots?.length, status?.autopilot?.enabled]);
}

