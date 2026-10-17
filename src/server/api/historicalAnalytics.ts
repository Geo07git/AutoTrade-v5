import express from 'express';
import { tradeBot } from '../pipeline/TradeBot';

export function registerHistoricalAnalyticsRoutes(app: express.Application) {
  // Endpoint to fetch and aggregate historical X-Perps analytics from OKX public candles
  app.get('/api/bot/historical/analytics', async (req, res) => {
    try {
      const symbolsParam = (req.query.symbols as string) || 'TRUMP-USD_UM_XPERP-310704,LINK-USD_UM_XPERP-310523';
      const days = parseInt((req.query.days as string) || '30', 10);
      const symbols = symbolsParam.split(',').map(s => s.trim()).filter(Boolean);

      const adapter = (tradeBot as any).activeAdapter || (tradeBot as any).okxAdapter;
      if (!adapter || typeof adapter.request !== 'function') {
        return res.status(500).json({ error: 'OKX adapter not available' });
      }

      // OKX candles limit per request is 300. For 30 days (720 hours), we need 3 requests of 300 bars (bar=1H).
      // For 90 days, we need ~8 requests. Let's fetch up to max available (e.g. 300 * 3 = 900 bars = ~37 days, or up to 2400 for 90 days).
      const hoursNeeded = days * 24;
      const limitPerReq = 300;
      const requestsNeeded = Math.min(8, Math.ceil(hoursNeeded / limitPerReq));

      const results: Record<string, any> = {};

      for (const symbol of symbols) {
        let allCandles: any[] = [];
        let afterTimestamp: string | undefined = undefined;

        for (let r = 0; r < requestsNeeded; r++) {
          let url = `/api/v5/market/candles?instId=${encodeURIComponent(symbol)}&bar=1H&limit=${limitPerReq}`;
          if (afterTimestamp) {
            url += `&after=${afterTimestamp}`;
          }
          try {
            const resp = await adapter.request('GET', url, undefined, false);
            if (resp.code === '0' && Array.isArray(resp.data) && resp.data.length > 0) {
              const fetched = resp.data;
              allCandles.push(...fetched);
              // OKX returns candles sorted from newest to oldest. The oldest in this batch is the last element.
              const oldestCandle = fetched[fetched.length - 1];
              afterTimestamp = oldestCandle[0];
              if (fetched.length < limitPerReq) {
                break; // No more history
              }
            } else {
              break;
            }
          } catch (err) {
            console.warn(`[HistoricalAnalytics] Error fetching candles for ${symbol}:`, err);
            break;
          }
        }

        if (allCandles.length === 0) {
          results[symbol] = {
            symbol,
            observationsCount: 0,
            error: 'Insufficient or no historical data available',
          };
          continue;
        }

        // Parse candles: [ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm]
        // OKX candles are [timestamp, open, high, low, close, vol, volCcy, ...]
        const parsed = allCandles.map((c: any[]) => {
          const ts = parseInt(c[0], 10);
          const open = parseFloat(c[1]);
          const high = parseFloat(c[2]);
          const low = parseFloat(c[3]);
          const close = parseFloat(c[4]);
          const volume = parseFloat(c[5]);
          const volumeQuote = parseFloat(c[7] || c[6] || '0');
          const returnPct = open > 0 ? ((close - open) / open) * 100 : 0;
          const tr = Math.max(high - low, Math.abs(high - close), Math.abs(low - close));
          const date = new Date(ts);
          const utcHour = date.getUTCHours();
          const utcDay = date.getUTCDay(); // 0 = Sun, 1 = Mon ... 6 = Sat
          const isWeekend = utcDay === 0 || utcDay === 6;

          // Sessions (UTC based standard categorization):
          // Asian: 00:00 - 08:00 UTC
          // European: 08:00 - 16:00 UTC
          // American: 16:00 - 24:00 UTC
          let session = 'American';
          if (utcHour >= 0 && utcHour < 8) session = 'Asian';
          else if (utcHour >= 8 && utcHour < 16) session = 'European';

          return {
            ts,
            dateStr: date.toISOString(),
            utcHour,
            utcDay,
            isWeekend,
            session,
            open,
            high,
            low,
            close,
            volume,
            volumeQuote,
            returnPct,
            tr,
            rvol: 1,
          };
        });

        // Sort ascending by timestamp
        parsed.sort((a, b) => a.ts - b.ts);

        // Calculate RVOL (Relative Volume vs 20-period moving average of volume)
        for (let i = 0; i < parsed.length; i++) {
          const startIdx = Math.max(0, i - 19);
          const slice = parsed.slice(startIdx, i + 1);
          const avgVol = slice.reduce((acc, x) => acc + x.volume, 0) / slice.length;
          (parsed[i] as any).rvol = avgVol > 0 ? parsed[i].volume / avgVol : 1;
        }

        const observationsCount = parsed.length;

        // Group by UTC Hour (0-23)
        const hourlyMap: Record<number, { returns: number[]; volumes: number[]; rvols: number[]; trs: number[] }> = {};
        for (let h = 0; h < 24; h++) {
          hourlyMap[h] = { returns: [], volumes: [], rvols: [], trs: [] };
        }

        // Group by Day of Week (0-6)
        const dayMap: Record<number, { returns: number[]; volumes: number[]; rvols: number[]; trs: number[] }> = {};
        for (let d = 0; d < 7; d++) {
          dayMap[d] = { returns: [], volumes: [], rvols: [], trs: [] };
        }

        // Group by Session
        const sessionMap: Record<string, { returns: number[]; volumes: number[]; rvols: number[]; trs: number[] }> = {
          Asian: { returns: [], volumes: [], rvols: [], trs: [] },
          European: { returns: [], volumes: [], rvols: [], trs: [] },
          American: { returns: [], volumes: [], rvols: [], trs: [] },
        };

        // Group by Day x Hour
        const dayHourMap: Record<string, { returns: number[]; volumes: number[]; rvols: number[]; trs: number[] }> = {};

        for (const p of parsed) {
          hourlyMap[p.utcHour].returns.push(p.returnPct);
          hourlyMap[p.utcHour].volumes.push(p.volumeQuote > 0 ? p.volumeQuote : p.volume);
          hourlyMap[p.utcHour].rvols.push(p.rvol);
          hourlyMap[p.utcHour].trs.push(p.tr);

          dayMap[p.utcDay].returns.push(p.returnPct);
          dayMap[p.utcDay].volumes.push(p.volumeQuote > 0 ? p.volumeQuote : p.volume);
          dayMap[p.utcDay].rvols.push(p.rvol);
          dayMap[p.utcDay].trs.push(p.tr);

          sessionMap[p.session].returns.push(p.returnPct);
          sessionMap[p.session].volumes.push(p.volumeQuote > 0 ? p.volumeQuote : p.volume);
          sessionMap[p.session].rvols.push(p.rvol);
          sessionMap[p.session].trs.push(p.tr);

          const dhKey = `${p.utcDay}_${p.utcHour}`;
          if (!dayHourMap[dhKey]) {
            dayHourMap[dhKey] = { returns: [], volumes: [], rvols: [], trs: [] };
          }
          dayHourMap[dhKey].returns.push(p.returnPct);
          dayHourMap[dhKey].volumes.push(p.volumeQuote > 0 ? p.volumeQuote : p.volume);
          dayHourMap[dhKey].rvols.push(p.rvol);
          dayHourMap[dhKey].trs.push(p.tr);
        }

        const hourlyRank = Object.keys(hourlyMap).map(hStr => {
          const h = parseInt(hStr, 10);
          const data = hourlyMap[h];
          const count = data.returns.length;
          const avgReturn = count > 0 ? data.returns.reduce((a, b) => a + b, 0) / count : 0;
          const avgVolume = count > 0 ? data.volumes.reduce((a, b) => a + b, 0) / count : 0;
          const avgRvol = count > 0 ? data.rvols.reduce((a, b) => a + b, 0) / count : 1;
          const avgTr = count > 0 ? data.trs.reduce((a, b) => a + b, 0) / count : 0;
          const positiveCount = data.returns.filter(r => r > 0).length;
          const winRate = count > 0 ? (positiveCount / count) * 100 : 0;
          return {
            hourUTC: h,
            hourRO: (h + 2) % 24, // EET / EEST offset approx
            hourNY: (h + 19) % 24, // EST offset approx
            observations: count,
            avgReturn: parseFloat(avgReturn.toFixed(4)),
            avgVolume: parseFloat(avgVolume.toFixed(2)),
            avgRvol: parseFloat(avgRvol.toFixed(2)),
            avgAtr: parseFloat(avgTr.toFixed(4)),
            winRate: parseFloat(winRate.toFixed(2)),
          };
        });

        const dayRank = Object.keys(dayMap).map(dStr => {
          const d = parseInt(dStr, 10);
          const data = dayMap[d];
          const count = data.returns.length;
          const avgReturn = count > 0 ? data.returns.reduce((a, b) => a + b, 0) / count : 0;
          const avgVolume = count > 0 ? data.volumes.reduce((a, b) => a + b, 0) / count : 0;
          const avgRvol = count > 0 ? data.rvols.reduce((a, b) => a + b, 0) / count : 1;
          const avgTr = count > 0 ? data.trs.reduce((a, b) => a + b, 0) / count : 0;
          const positiveCount = data.returns.filter(r => r > 0).length;
          const winRate = count > 0 ? (positiveCount / count) * 100 : 0;
          const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
          return {
            dayIndex: d,
            dayName: dayNames[d],
            isWeekend: d === 0 || d === 6,
            observations: count,
            avgReturn: parseFloat(avgReturn.toFixed(4)),
            avgVolume: parseFloat(avgVolume.toFixed(2)),
            avgRvol: parseFloat(avgRvol.toFixed(2)),
            avgAtr: parseFloat(avgTr.toFixed(4)),
            winRate: parseFloat(winRate.toFixed(2)),
          };
        });

        const sessionRank = Object.keys(sessionMap).map(sess => {
          const data = sessionMap[sess];
          const count = data.returns.length;
          const avgReturn = count > 0 ? data.returns.reduce((a, b) => a + b, 0) / count : 0;
          const avgVolume = count > 0 ? data.volumes.reduce((a, b) => a + b, 0) / count : 0;
          const avgRvol = count > 0 ? data.rvols.reduce((a, b) => a + b, 0) / count : 1;
          const avgTr = count > 0 ? data.trs.reduce((a, b) => a + b, 0) / count : 0;
          const positiveCount = data.returns.filter(r => r > 0).length;
          const winRate = count > 0 ? (positiveCount / count) * 100 : 0;
          return {
            session: sess,
            observations: count,
            avgReturn: parseFloat(avgReturn.toFixed(4)),
            avgVolume: parseFloat(avgVolume.toFixed(2)),
            avgRvol: parseFloat(avgRvol.toFixed(2)),
            avgAtr: parseFloat(avgTr.toFixed(4)),
            winRate: parseFloat(winRate.toFixed(2)),
          };
        });

        results[symbol] = {
          symbol,
          observationsCount,
          isInsufficient: observationsCount < 24 * 7, // less than 7 days of hourly bars
          hourlyRank,
          dayRank,
          sessionRank,
          sampleCandles: parsed.slice(-50), // last 50 candles for charting
        };
      }

      res.json({
        success: true,
        dataSource: 'OKX EEA Public Market Candles (API v5)',
        daysAnalyzed: days,
        symbolsRequested: symbols,
        results,
      });
    } catch (err: any) {
      console.error('[HistoricalAnalytics] Error:', err);
      res.status(500).json({ success: false, error: err?.message || String(err) });
    }
  });
}
