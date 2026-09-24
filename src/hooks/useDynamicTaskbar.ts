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
  const frameRef = useRef<number>(0);
  const pulseRef = useRef<number>(0);

  useEffect(() => {
    // 1. Calculate metrics
    const currentEquity = status?.equity !== undefined ? status.equity : 200.0;
    const positions = status?.positions || [];
    const activePositions = positions.filter((p) => p.status === 'OPEN');
    const hasActiveTrade = activePositions.length > 0;
    const activeCount = activePositions.length;

    const unrealizedPnL = status?.unrealizedPnL !== undefined
      ? status.unrealizedPnL
      : activePositions.reduce((acc, p) => acc + (p.pnl || 0), 0);

    const isProfit = unrealizedPnL >= 0;
    const formattedEq = `$${currentEquity.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
    const pnlSign = unrealizedPnL > 0 ? '+' : '';
    const formattedPnl = `${pnlSign}$${unrealizedPnL.toFixed(2)}`;

    // 2. Windows Taskbar Badging API (Works natively on Windows PWA and Chrome/Edge desktop)
    if ('setAppBadge' in navigator && typeof (navigator as any).setAppBadge === 'function') {
      try {
        if (hasActiveTrade) {
          (navigator as any).setAppBadge(activeCount).catch(() => {});
        } else {
          (navigator as any).clearAppBadge?.().catch(() => {});
        }
      } catch {
        // Safe fallback if permission is restricted
      }
    }

    // 3. Dynamic Favicon Generator using Canvas
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext('2d');

    const updateFavicon = (glowPhase: number) => {
      if (!ctx) return;
      ctx.clearRect(0, 0, 32, 32);

      // Background rounded square / badge
      ctx.beginPath();
      ctx.roundRect(1, 1, 30, 30, 7);
      ctx.fillStyle = '#09090b';
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = hasActiveTrade ? (isProfit ? '#10b981' : '#f43f5e') : '#3f3f46';
      ctx.stroke();

      if (hasActiveTrade) {
        const dotColor = isProfit ? '#10b981' : '#f43f5e';
        const haloColor = isProfit ? 'rgba(16, 185, 129, ' : 'rgba(244, 63, 94, ';

        // Outer glowing pulse ring
        const pulseRadius = 9 + glowPhase * 3;
        const pulseAlpha = Math.max(0, 0.6 - glowPhase * 0.4);
        ctx.beginPath();
        ctx.arc(16, 16, pulseRadius, 0, Math.PI * 2);
        ctx.fillStyle = `${haloColor}${pulseAlpha})`;
        ctx.fill();

        // Inner solid core
        ctx.beginPath();
        ctx.arc(16, 16, 6, 0, Math.PI * 2);
        ctx.fillStyle = dotColor;
        ctx.fill();

        // High-contrast center highlight
        ctx.beginPath();
        ctx.arc(14.5, 14.5, 2, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
      } else {
        // Neutral standby dot
        ctx.beginPath();
        ctx.arc(16, 16, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = '#71717a';
        ctx.fill();
      }

      // Find or create favicon link tag
      let link: HTMLLinkElement | null = document.querySelector("link[rel*='icon']");
      if (!link) {
        link = document.createElement('link');
        link.rel = 'shortcut icon';
        link.type = 'image/png';
        document.head.appendChild(link);
      }
      link.href = canvas.toDataURL('image/png');
    };

    // 4. Dynamic Window Title update
    const updateTitle = (tick: number) => {
      const isMinimizedOrHidden = document.hidden || document.visibilityState === 'hidden';
      let titleStr = '';

      if (hasActiveTrade) {
        const dot = isProfit ? '🟢' : '🔴';
        const tradeLabel = activeCount === 1 ? '1 TRADE' : `${activeCount} TRADES`;

        if (isMinimizedOrHidden) {
          // When minimized, alternate every 2 seconds between EQ Tot and PnL
          if (tick % 2 === 0) {
            titleStr = `${dot} ${formattedEq} | EQ Tot (${tradeLabel})`;
          } else {
            titleStr = `${dot} [${formattedPnl}] | EQ Tot: ${formattedEq}`;
          }
        } else {
          titleStr = `${dot} ${formattedEq} [${formattedPnl}] | TradeBot (${tradeLabel})`;
        }
      } else {
        const dot = '⚪';
        if (isMinimizedOrHidden) {
          titleStr = `${dot} ${formattedEq} | EQ Tot (STANDBY)`;
        } else {
          titleStr = `${dot} ${formattedEq} | TradeBot Pro (STANDBY)`;
        }
      }

      document.title = titleStr;

      // Also propagate to parent/top window if accessible (e.g. popout or same-origin)
      try {
        if (window.parent && window.parent !== window) {
          window.parent.document.title = titleStr;
        }
      } catch {}
      try {
        if (window.top && window.top !== window) {
          window.top.document.title = titleStr;
        }
      } catch {}
    };

    // Initial render
    updateTitle(0);
    updateFavicon(0);

    // Pulse timer for background taskbar animation (every 1 second)
    const interval = setInterval(() => {
      frameRef.current = (frameRef.current + 1) % 10;
      pulseRef.current = (pulseRef.current + 1) % 4; // 0, 1, 2, 3 pulse phase
      updateTitle(frameRef.current);
      updateFavicon(pulseRef.current / 3);
    }, 1200);

    const handleVisibilityChange = () => {
      updateTitle(frameRef.current);
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if ('clearAppBadge' in navigator && typeof (navigator as any).clearAppBadge === 'function') {
        try {
          (navigator as any).clearAppBadge?.().catch(() => {});
        } catch {}
      }
    };
  }, [status]);
}
