import React, { useMemo } from 'react';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
} from 'recharts';
import { TrendingUp, Activity, ShieldCheck, Clock, DollarSign, Info } from 'lucide-react';
import { EquityDataPoint, EquityTrailingState } from '../shared/types';

interface EquityCurve24hChartProps {
  equityHistory?: EquityDataPoint[];
  currentEquity: number;
  peakEquity?: number;
  baseEquity?: number;
  equityTrailingState?: EquityTrailingState;
  lang?: 'RO' | 'EN';
}

export const EquityCurve24hChart: React.FC<EquityCurve24hChartProps> = ({
  equityHistory = [],
  currentEquity,
  peakEquity: explicitPeak,
  baseEquity = 200.0,
  equityTrailingState,
  lang = 'RO',
}) => {
  // Generate a continuous 24-hour timeline in 30-minute intervals (49 discrete points covering exactly 24h)
  const { chartData, yDomain, yTicks, stats } = useMemo(() => {
    const now = Date.now();
    const intervalMs = 30 * 60 * 1000; // 30 minutes
    const startTime = now - 24 * 60 * 60 * 1000; // 24 hours ago

    // Sort historical snapshots ascending
    const sortedHistory = [...equityHistory]
      .filter((pt) => pt && typeof pt.equity === 'number' && !isNaN(pt.equity))
      .sort((a, b) => a.time - b.time);

    // Build 49 half-hour slots
    const points: Array<{
      time: number;
      timeLabel: string;
      fullDate: string;
      equity: number;
      baseEquity: number;
      peakEquity: number;
      changeVsBase: number;
      changeVsBasePct: number;
    }> = [];

    // Helper to find equity for a given timestamp
    const getEquityAtTime = (t: number, index: number, totalSlots: number): number => {
      // If this is the latest slot (now), use currentEquity directly
      if (index === totalSlots - 1) {
        return currentEquity;
      }

      if (sortedHistory.length === 0) {
        return baseEquity;
      }

      // Find the last snapshot <= t
      let foundEquity: number | null = null;
      for (let i = sortedHistory.length - 1; i >= 0; i--) {
        if (sortedHistory[i].time <= t) {
          foundEquity = sortedHistory[i].equity;
          break;
        }
      }

      if (foundEquity !== null) {
        return foundEquity;
      }

      // If timestamp is earlier than all history, use the earliest known or baseEquity
      return sortedHistory[0].equity ?? baseEquity;
    };

    let runningPeak = Math.max(
      baseEquity,
      currentEquity,
      equityTrailingState?.peakEquity || 0,
      explicitPeak || 0
    );

    // Pre-calculate running peak across snapshots
    for (const h of sortedHistory) {
      if (h.equity > runningPeak) runningPeak = h.equity;
    }

    const totalSlots = 49;
    for (let i = 0; i < totalSlots; i++) {
      const slotTime = startTime + i * intervalMs;
      const rawEq = getEquityAtTime(slotTime, i, totalSlots);
      const eq = Number(rawEq.toFixed(2));
      const changeVsBase = Number((eq - baseEquity).toFixed(2));
      const changeVsBasePct = Number(((changeVsBase / baseEquity) * 100).toFixed(2));

      const dateObj = new Date(slotTime);
      const hours = String(dateObj.getHours()).padStart(2, '0');
      const minutes = String(dateObj.getMinutes()).padStart(2, '0');
      const timeLabel = `${hours}:${minutes}`;
      const fullDate = dateObj.toLocaleString(lang === 'EN' ? 'en-US' : 'ro-RO', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });

      points.push({
        time: slotTime,
        timeLabel,
        fullDate,
        equity: eq,
        baseEquity,
        peakEquity: Number(runningPeak.toFixed(2)),
        changeVsBase,
        changeVsBasePct,
      });
    }

    // Y-AXIS CALCULATION: strictly "din 1 in 1" (integer steps of $1)
    const allEqValues = points.map((p) => p.equity);
    allEqValues.push(baseEquity, currentEquity, runningPeak);

    const minEq = Math.min(...allEqValues);
    const maxEq = Math.max(...allEqValues);

    let floorVal = Math.floor(minEq) - 1;
    let ceilVal = Math.ceil(maxEq) + 1;

    // Ensure a visible vertical breadth of at least 4-5 integer units for aesthetic clarity
    if (ceilVal - floorVal < 4) {
      floorVal -= 1;
      ceilVal += 2;
    }

    // Build the exact integer ticks array ($1 by $1)
    const ticks: number[] = [];
    for (let val = floorVal; val <= ceilVal; val += 1) {
      ticks.push(val);
    }

    // KPIs & performance metrics for the 24h window
    const startEquity = points[0]?.equity ?? baseEquity;
    const netChange24h = Number((currentEquity - startEquity).toFixed(2));
    const netChange24hPct = Number(((netChange24h / (startEquity || 1)) * 100).toFixed(2));
    const lowest24h = Number(Math.min(...allEqValues).toFixed(2));
    const highest24h = Number(Math.max(...allEqValues).toFixed(2));
    const maxDrawdownPct = Number(
      (((runningPeak - lowest24h) / (runningPeak || 1)) * 100).toFixed(2)
    );

    return {
      chartData: points,
      yDomain: [floorVal, ceilVal],
      yTicks: ticks,
      stats: {
        currentEquity,
        startEquity,
        netChange24h,
        netChange24hPct,
        lowest24h,
        highest24h,
        runningPeak,
        maxDrawdownPct,
      },
    };
  }, [equityHistory, currentEquity, explicitPeak, baseEquity, equityTrailingState, lang]);

  const isNetPositive = stats.netChange24h >= 0;

  return (
    <div className="bg-zinc-950 border border-amber-500/30 rounded p-3 sm:p-4 flex flex-col font-mono shadow-2xl relative">
      {/* 1. TOP HEADER & PERFORMANCE METRICS BAR */}
      <div className="flex flex-col xl:flex-row xl:items-center justify-between border-b border-amber-500/30 pb-3 mb-3 gap-3">
        {/* Title & Live Cadence Badge */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center space-x-2">
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
            </span>
            <span className="font-bold text-sm tracking-wider text-amber-400 uppercase">
              {lang === 'EN' ? '24H Equity Curve & Trajectory' : 'Grafic 24H Equity Curve & Traiectorie Capital'}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
            <span className="px-2 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-amber-300">
              {lang === 'EN' ? 'AXIS Y: $1 STEPS' : 'AXA Y: DIN $1 ÎN $1'}
            </span>
            <span className="px-2 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-emerald-400">
              {lang === 'EN' ? 'AXIS X: 30M INTERVALS (48 SLOTS)' : 'AXA X: INTERVALE 30 MIN (48 INTERVALE / 24H)'}
            </span>
            <span className="px-2 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-400">
              {lang === 'EN' ? 'FULL 24H COVERAGE' : 'ACOPERIRE COMPLETĂ 24H'}
            </span>
          </div>
        </div>

        {/* Real-time KPI Pills */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 text-[11px]">
          {/* Current Equity */}
          <div className="bg-black border border-amber-500/40 px-2 py-1 rounded flex flex-col">
            <span className="text-[9px] text-zinc-400 uppercase tracking-wider">
              {lang === 'EN' ? 'CURRENT EQUITY' : 'EQUITY CURENT'}
            </span>
            <span className="font-bold text-emerald-400 text-sm">
              ${stats.currentEquity.toFixed(2)}
            </span>
          </div>

          {/* 24H Net PnL */}
          <div className="bg-black border border-zinc-800 px-2 py-1 rounded flex flex-col">
            <span className="text-[9px] text-zinc-400 uppercase tracking-wider">
              {lang === 'EN' ? '24H NET PNL' : 'PNL NET 24H'}
            </span>
            <span className={`font-bold text-xs ${isNetPositive ? 'text-emerald-400' : 'text-rose-400'}`}>
              {isNetPositive ? '+' : ''}${stats.netChange24h.toFixed(2)}{' '}
              <span className="text-[10px]">({isNetPositive ? '+' : ''}{stats.netChange24hPct.toFixed(2)}%)</span>
            </span>
          </div>

          {/* 24h Peak */}
          <div className="bg-black border border-zinc-800 px-2 py-1 rounded flex flex-col">
            <span className="text-[9px] text-zinc-400 uppercase tracking-wider">
              {lang === 'EN' ? '24H PEAK (HIGH)' : 'VÂRF 24H (MAX)'}
            </span>
            <span className="font-bold text-cyan-400 text-xs">
              ${stats.highest24h.toFixed(2)}
            </span>
          </div>

          {/* 24h Low */}
          <div className="bg-black border border-zinc-800 px-2 py-1 rounded flex flex-col">
            <span className="text-[9px] text-zinc-400 uppercase tracking-wider">
              {lang === 'EN' ? '24H LOW (MIN)' : 'MINIM 24H'}
            </span>
            <span className="font-bold text-rose-400 text-xs">
              ${stats.lowest24h.toFixed(2)}
            </span>
          </div>

          {/* Max Drawdown */}
          <div className="bg-black border border-zinc-800 px-2 py-1 rounded flex flex-col">
            <span className="text-[9px] text-zinc-400 uppercase tracking-wider">
              {lang === 'EN' ? 'MAX DRAWDOWN' : 'MAX RETRAGERE'}
            </span>
            <span className="font-bold text-amber-300 text-xs">
              -{stats.maxDrawdownPct.toFixed(2)}%
            </span>
          </div>

          {/* Baseline Capital */}
          <div className="bg-black border border-zinc-800 px-2 py-1 rounded flex flex-col">
            <span className="text-[9px] text-zinc-400 uppercase tracking-wider">
              {lang === 'EN' ? 'INITIAL BASE' : 'BAZĂ CONT'}
            </span>
            <span className="font-bold text-amber-400 text-xs">
              ${baseEquity.toFixed(2)}
            </span>
          </div>
        </div>
      </div>

      {/* 2. RECHARTS HIGH-RESOLUTION 24H CANVAS */}
      <div className="w-full h-[320px] sm:h-[350px] relative">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData} margin={{ top: 15, right: 25, left: 0, bottom: 25 }}>
            <defs>
              <linearGradient id="equityGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#10b981" stopOpacity={0.35} />
                <stop offset="50%" stopColor="#10b981" stopOpacity={0.12} />
                <stop offset="100%" stopColor="#10b981" stopOpacity={0.0} />
              </linearGradient>
            </defs>

            <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={true} />

            {/* X-AXIS: 30-minute steps covering 24h */}
            <XAxis
              dataKey="timeLabel"
              stroke="#71717a"
              fontSize={10}
              tickLine={{ stroke: '#3f3f46' }}
              interval={1} // Shows hourly marks for clean readability, each slot is 30m
              dy={8}
            />

            {/* Y-AXIS: Strictly integer $1 increments */}
            <YAxis
              domain={yDomain}
              ticks={yTicks}
              stroke="#71717a"
              fontSize={10}
              tickLine={{ stroke: '#3f3f46' }}
              tickFormatter={(val) => `$${Number(val).toFixed(0)}`}
              dx={-4}
            />

            {/* Interactive Tooltip */}
            <Tooltip
              content={({ active, payload }) => {
                if (!active || !payload || !payload.length) return null;
                const data = payload[0].payload;
                const eq = data.equity;
                const delta = data.changeVsBase;
                const deltaPct = data.changeVsBasePct;
                const isPos = delta >= 0;

                return (
                  <div className="bg-black/95 border border-amber-500/80 rounded p-2.5 shadow-2xl font-mono text-[11px] min-w-[200px] z-50">
                    <div className="text-zinc-400 border-b border-zinc-800 pb-1 mb-1.5 flex items-center justify-between">
                      <span className="font-bold text-amber-400 flex items-center gap-1">
                        <Clock className="w-3 h-3 text-amber-500" />
                        {data.timeLabel}
                      </span>
                      <span className="text-[10px] text-zinc-500">{data.fullDate}</span>
                    </div>

                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="text-zinc-400">Equity Total:</span>
                        <span className="font-bold text-emerald-400 text-xs">${eq.toFixed(2)}</span>
                      </div>

                      <div className="flex items-center justify-between">
                        <span className="text-zinc-400">Delta vs Bază ($200):</span>
                        <span className={`font-bold ${isPos ? 'text-emerald-400' : 'text-rose-400'}`}>
                          {isPos ? '+' : ''}${delta.toFixed(2)} ({isPos ? '+' : ''}{deltaPct.toFixed(2)}%)
                        </span>
                      </div>

                      <div className="flex items-center justify-between">
                        <span className="text-zinc-400">Vârf Atins (Peak):</span>
                        <span className="text-cyan-400 font-bold">${data.peakEquity.toFixed(2)}</span>
                      </div>

                      <div className="flex items-center justify-between text-[10px] pt-1 border-t border-zinc-900 text-zinc-500">
                        <span>Interval:</span>
                        <span>Pas 30 min</span>
                      </div>
                    </div>
                  </div>
                );
              }}
            />

            {/* Reference Line: Initial Baseline Capital ($200) */}
            <ReferenceLine
              y={baseEquity}
              stroke="#f59e0b"
              strokeDasharray="4 4"
              strokeWidth={1.5}
              label={{
                value: `BAZĂ $${baseEquity.toFixed(0)}`,
                fill: '#f59e0b',
                fontSize: 10,
                position: 'insideBottomRight',
              }}
            />

            {/* Reference Line: Peak Equity (High-Water Mark) */}
            <ReferenceLine
              y={stats.runningPeak}
              stroke="#06b6d4"
              strokeDasharray="3 3"
              strokeWidth={1.2}
              label={{
                value: `PEAK $${stats.runningPeak.toFixed(2)}`,
                fill: '#06b6d4',
                fontSize: 10,
                position: 'insideTopRight',
              }}
            />

            {/* Glowing Smooth Area Curve */}
            <Area
              type="monotone"
              dataKey="equity"
              stroke="#10b981"
              strokeWidth={2.5}
              fill="url(#equityGradient)"
              activeDot={{ r: 5, fill: '#10b981', stroke: '#ffffff', strokeWidth: 1.5 }}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* 3. PROFESSIONAL COMPREHENSIVE LEGEND & AUDIT NOTES */}
      <div className="mt-3 pt-2.5 border-t border-zinc-900 flex flex-wrap items-center justify-between gap-3 text-[11px] text-zinc-400">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center space-x-1.5">
            <span className="w-3 h-1 bg-emerald-500 rounded-full inline-block"></span>
            <span className="text-emerald-400 font-bold">
              {lang === 'EN' ? 'Total Equity Curve (MTM + Realized)' : 'Curba Equity (MTM + Realizat)'}
            </span>
          </div>

          <div className="flex items-center space-x-1.5">
            <span className="w-3 h-0.5 border-t border-dashed border-amber-500 inline-block"></span>
            <span className="text-amber-400">
              {lang === 'EN' ? `Capital Base ($${baseEquity.toFixed(0)})` : `Nivel Bază ($${baseEquity.toFixed(0)})`}
            </span>
          </div>

          <div className="flex items-center space-x-1.5">
            <span className="w-3 h-0.5 border-t border-dashed border-cyan-400 inline-block"></span>
            <span className="text-cyan-400">
              {lang === 'EN' ? 'High-Water Mark Peak' : 'Vârf Maxim Istoric (Peak)'}
            </span>
          </div>
        </div>

        <div className="flex items-center space-x-2 text-[10px] text-zinc-500">
          <Info className="w-3.5 h-3.5 text-amber-500 shrink-0" />
          <span>
            {lang === 'EN'
              ? 'Y-axis steps strictly by $1.00. X-axis dynamically maps 48 half-hour slots across 24h.'
              : 'Axă Y cu pas strict din $1 în $1. Axa X eșantionează 48 intervale la fiecare 30 minute acoperind 24 ore.'}
          </span>
        </div>
      </div>
    </div>
  );
};
