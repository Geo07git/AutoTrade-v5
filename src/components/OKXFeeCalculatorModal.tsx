import React, { useState } from 'react';
import { OKXFeeTierInfo } from '../shared/types';
import { calculateVolumeFeeBreakdown } from '../shared/fees';
import { RefreshCw, ShieldCheck, Activity, DollarSign } from 'lucide-react';

interface OKXFeeCalculatorModalProps {
  isOpen: boolean;
  onClose: () => void;
  feeTierInfo?: OKXFeeTierInfo;
  totalFeesPaidUSDT: number;
  fillsCount: number;
  onRefreshFeeTier: () => Promise<void>;
}

export const OKXFeeCalculatorModal: React.FC<OKXFeeCalculatorModalProps> = ({
  isOpen,
  onClose,
  feeTierInfo,
  totalFeesPaidUSDT,
  fillsCount,
  onRefreshFeeTier,
}) => {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [simVolumeUSDT, setSimVolumeUSDT] = useState<number>(
    feeTierInfo?.totalVolumeUSDT && feeTierInfo.totalVolumeUSDT > 0
      ? feeTierInfo.totalVolumeUSDT
      : 1000
  );
  const [simMakerSharePct, setSimMakerSharePct] = useState<number>(80);

  if (!isOpen) return null;

  const level = feeTierInfo?.level || 'Lv1';
  const makerRate = feeTierInfo?.makerFeeRate ?? 0.0002;
  const takerRate = feeTierInfo?.takerFeeRate ?? 0.0005;
  const makerPct = feeTierInfo?.makerFeePct ?? 0.02;
  const takerPct = feeTierInfo?.takerFeePct ?? 0.05;
  const roundTripMakerPct = feeTierInfo?.roundTripMakerFeePct ?? 0.04;
  const totalVol = feeTierInfo?.totalVolumeUSDT ?? 0;
  const makerVol = feeTierInfo?.makerVolumeUSDT ?? 0;
  const takerVol = feeTierInfo?.takerVolumeUSDT ?? 0;
  const calcVolFee = feeTierInfo?.calculatedFeeOnVolumeUSDT ?? 0;
  const actualExchFee = feeTierInfo?.actualExchangeFeesUSDT ?? totalFeesPaidUSDT;

  const simMakerVol = (simVolumeUSDT * simMakerSharePct) / 100;
  const simTakerVol = simVolumeUSDT - simMakerVol;
  const simBreakdown = calculateVolumeFeeBreakdown({
    makerVolumeUSDT: simMakerVol,
    takerVolumeUSDT: simTakerVol,
    makerFeeRate: makerRate,
    takerFeeRate: takerRate,
  });

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await onRefreshFeeTier();
    } finally {
      setIsRefreshing(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/85 backdrop-blur-xs flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-zinc-950 border-2 border-amber-500/70 rounded-lg p-4 sm:p-5 w-full max-w-2xl space-y-4 shadow-2xl text-xs font-mono"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-amber-500/30 pb-2.5">
          <div className="flex items-center space-x-2">
            <DollarSign className="w-4 h-4 text-amber-400" />
            <div>
              <h3 className="font-black text-sm text-amber-400">
                CALCULATOR LIVE COMISIOANE &amp; VOLUM OKX EEA (FUTURES X-PERP)
              </h3>
              <p className="text-[10px] text-zinc-400">
                Date preluate live din <code className="text-cyan-300">GET /api/v5/account/trade-fee?instType=FUTURES</code> &amp; <code className="text-cyan-300">/api/v5/trade/fills</code>
              </p>
            </div>
          </div>
          <div className="flex items-center space-x-2">
            <button
              type="button"
              onClick={handleRefresh}
              disabled={isRefreshing}
              className="px-2.5 py-1 rounded bg-cyan-500 hover:bg-cyan-400 text-black font-black text-[11px] flex items-center space-x-1 cursor-pointer"
            >
              <RefreshCw className={`w-3 h-3 ${isRefreshing ? 'animate-spin' : ''}`} />
              <span>{isRefreshing ? 'Sincronizare...' : 'Sync Tier OKX'}</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              className="text-zinc-400 hover:text-white font-bold px-2 py-0.5 rounded hover:bg-zinc-900 cursor-pointer"
            >
              ✕
            </button>
          </div>
        </div>

        {/* 1. LIVE OKX FEE TIER */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <div className="bg-black border border-zinc-800 rounded p-2.5">
            <span className="text-[10px] text-zinc-500 block">NIVEL CONT OKX</span>
            <span className="text-sm font-black text-amber-400">{level} (FUTURES)</span>
            <span className="text-[9px] text-emerald-400 block">
              Sursă: {feeTierInfo?.source === 'OKX_API_LIVE' ? 'OKX API LIVE' : 'Standard Tier'}
            </span>
          </div>
          <div className="bg-black border border-zinc-800 rounded p-2.5">
            <span className="text-[10px] text-zinc-500 block">MAKER FEE (LIMIT)</span>
            <span className="text-sm font-black text-emerald-400">{makerPct.toFixed(3)}%</span>
            <span className="text-[9px] text-zinc-400 block">
              ${(1000 * makerRate).toFixed(2)} / $1,000 volum
            </span>
          </div>
          <div className="bg-black border border-zinc-800 rounded p-2.5">
            <span className="text-[10px] text-zinc-500 block">TAKER FEE (MARKET)</span>
            <span className="text-sm font-black text-rose-400">{takerPct.toFixed(3)}%</span>
            <span className="text-[9px] text-zinc-400 block">
              ${(1000 * takerRate).toFixed(2)} / $1,000 volum
            </span>
          </div>
          <div className="bg-black border border-zinc-800 rounded p-2.5">
            <span className="text-[10px] text-zinc-500 block">ROUND-TRIP GRID (2×M)</span>
            <span className="text-sm font-black text-cyan-300">{roundTripMakerPct.toFixed(3)}%</span>
            <span className="text-[9px] text-zinc-400 block">Buy Limit + Sell Limit</span>
          </div>
        </div>

        {/* 2. CURRENT ACCOUNT EXECUTED VOLUME & LIVE FEE ACCOUNTING */}
        <div className="bg-black border border-zinc-800 rounded p-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="font-bold text-amber-300 flex items-center space-x-1.5">
              <Activity className="w-3.5 h-3.5 text-emerald-400" />
              <span>CONTABILITATE LIVE VOLUM &amp; COMISIOANE DIN EXECUȚII ({fillsCount} FILLS)</span>
            </span>
            <span className="text-[10px] text-zinc-400">Calculat în timp real (fără valori hardcodate)</span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 pt-1">
            <div className="bg-zinc-950 border border-zinc-800 rounded p-2">
              <span className="text-[9px] text-zinc-500 block">VOLUM TOTAL RULAT</span>
              <span className="font-black text-white tabular-nums">${totalVol.toFixed(2)}</span>
            </div>
            <div className="bg-zinc-950 border border-zinc-800 rounded p-2">
              <span className="text-[9px] text-zinc-500 block">VOLUM MAKER (LIMIT)</span>
              <span className="font-bold text-emerald-300 tabular-nums">${makerVol.toFixed(2)}</span>
            </div>
            <div className="bg-zinc-950 border border-zinc-800 rounded p-2">
              <span className="text-[9px] text-zinc-500 block">VOLUM TAKER (MKT)</span>
              <span className="font-bold text-amber-300 tabular-nums">${takerVol.toFixed(2)}</span>
            </div>
            <div className="bg-zinc-950 border border-zinc-800 rounded p-2">
              <span className="text-[9px] text-zinc-500 block">FEE CALCULAT PE VOLUM</span>
              <span className="font-bold text-cyan-300 tabular-nums">-${calcVolFee.toFixed(4)}</span>
            </div>
            <div className="bg-zinc-950 border border-emerald-500/40 rounded p-2">
              <span className="text-[9px] text-emerald-400 block">FEE EFECTIV ÎNREGISTRAT</span>
              <span className="font-black text-rose-400 tabular-nums">-${actualExchFee.toFixed(4)}</span>
            </div>
          </div>
        </div>

        {/* 3. INTERACTIVE TRADE VOLUME FEE CALCULATOR */}
        <div className="bg-black border border-amber-500/30 rounded p-3 space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="font-bold text-amber-400 flex items-center space-x-1.5">
              <ShieldCheck className="w-3.5 h-3.5 text-amber-400" />
              <span>SIMULATOR COMISION PE VOLUM (APLICĂ TIER-UL {level} LIVE)</span>
            </span>
            {totalVol > 0 && (
              <button
                type="button"
                onClick={() => setSimVolumeUSDT(totalVol)}
                className="px-2 py-0.5 rounded bg-zinc-900 hover:bg-zinc-800 text-cyan-300 border border-cyan-500/40 text-[10px] font-bold cursor-pointer"
              >
                Folosește Volumul Curent (${totalVol.toFixed(2)})
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] text-zinc-400 block mb-1">
                Volum de Tranzacționare Estimat / Rulat (USD)
              </label>
              <input
                type="number"
                min={1}
                step="10"
                value={simVolumeUSDT}
                onChange={(e) => setSimVolumeUSDT(Math.max(0, parseFloat(e.target.value) || 0))}
                className="w-full bg-zinc-900 border border-amber-500/50 rounded px-2.5 py-1.5 text-white font-bold"
              />
            </div>
            <div>
              <label className="text-[10px] text-zinc-400 block mb-1">
                Proporție Ordine Limită Maker ({simMakerSharePct}% Maker / {100 - simMakerSharePct}% Taker)
              </label>
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={simMakerSharePct}
                onChange={(e) => setSimMakerSharePct(parseInt(e.target.value, 10) || 0)}
                className="w-full accent-amber-500 mt-1.5"
              />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2 bg-zinc-950 border border-zinc-800 rounded p-2.5 text-center">
            <div>
              <span className="text-[10px] text-zinc-500 block">COMISION MAKER</span>
              <span className="font-bold text-emerald-400 tabular-nums">
                -${simBreakdown.makerFeeUSDT.toFixed(4)}
              </span>
            </div>
            <div>
              <span className="text-[10px] text-zinc-500 block">COMISION TAKER</span>
              <span className="font-bold text-amber-400 tabular-nums">
                -${simBreakdown.takerFeeUSDT.toFixed(4)}
              </span>
            </div>
            <div>
              <span className="text-[10px] text-zinc-500 block">
                TOTAL FEE ({simBreakdown.effectiveBlendedRatePct.toFixed(3)}%)
              </span>
              <span className="font-black text-rose-400 text-sm tabular-nums">
                -${simBreakdown.totalCalculatedFeeUSDT.toFixed(4)}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
