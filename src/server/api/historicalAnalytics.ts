import express from 'express';
import { tradeBot } from '../pipeline/TradeBot';

function median(values: number[]): number {
  if (!values || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function registerHistoricalAnalyticsRoutes(app: express.Application) {
  // Endpoint to fetch and aggregate historical X-Perps analytics
  app.post('/api/bot/historical/analytics', async (req, res) => {
    try {
      const { symbols, days } = req.body;
      const daysVal = parseInt(days || '30', 10);
      const symbolList = Array.isArray(symbols) ? symbols : [];

      const adapter = (tradeBot as any).activeAdapter || (tradeBot as any).okxAdapter;
      
      const results: Record<string, any> = {};

      for (const symbol of symbolList) {
        let allCandles: any[] = [];
        let afterTimestamp: string | undefined = undefined;
        const limitPerReq = 300;
        const hoursNeeded = daysVal * 24;
        const requestsNeeded = Math.min(8, Math.ceil(hoursNeeded / limitPerReq));

        for (let r = 0; r < requestsNeeded; r++) {
          let url = `/api/v5/market/candles?instId=${encodeURIComponent(symbol)}&bar=1H&limit=${limitPerReq}`;
          if (afterTimestamp) url += `&after=${afterTimestamp}`;
          
          try {
            const resp = await adapter.request('GET', url, undefined, false);
            await new Promise(r => setTimeout(r, 250));
            if (resp.code === '0' && Array.isArray(resp.data) && resp.data.length > 0) {
              allCandles.push(...resp.data);
              const oldestCandle = resp.data[resp.data.length - 1];
              afterTimestamp = oldestCandle[0];
              if (resp.data.length < limitPerReq) break;
            } else break;
          } catch (err) {
            console.warn(`[HistoricalAnalytics] Error for ${symbol}:`, err);
            break;
          }
        }
        
        if (allCandles.length === 0) {
          results[symbol] = { symbol, observations: 0, isInsufficient: true };
          continue;
        }

        const parsed = allCandles.map((c: any[]) => {
          const open = parseFloat(c[1]);
          const high = parseFloat(c[2]);
          const low = parseFloat(c[3]);
          const close = parseFloat(c[4]);
          const vol = parseFloat(c[5]);
          const date = new Date(parseInt(c[0], 10));
          return {
            hour: date.getUTCHours(),
            rangePct: (high - low) / close,
            rvol: 1.0, // Simplified for now
            atrPct: (high - low) / close,
            vol,
            close
          };
        });

        const hourlyAgg = Array.from({ length: 24 }, (_, h) => {
          const hourData = parsed.filter(p => p.hour === h);
          if (hourData.length === 0) return { hourUTC: h, rangePct: 0, rvol: 0, atrPct: 0, vol: 0 };
          return {
            hourUTC: h,
            rangePct: median(hourData.map(d => d.rangePct)),
            rvol: median(hourData.map(d => d.rvol)),
            atrPct: median(hourData.map(d => d.atrPct)),
            vol: median(hourData.map(d => d.vol))
          };
        });

        results[symbol] = { symbol, observations: allCandles.length, hourlyAgg };
      }

      res.json({ success: true, results });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message });
    }
  });
}
