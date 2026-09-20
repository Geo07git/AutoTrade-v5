import React, { useMemo, useState } from 'react';
import { Search, RefreshCw, ExternalLink, TrendingUp, AlertCircle } from 'lucide-react';

interface TradingViewChartProps {
  currentSymbol: string;
  onSymbolChange: (symbol: string) => void;
  availableSymbols?: string[];
  lang?: 'RO' | 'EN';
}

export const TradingViewChart: React.FC<TradingViewChartProps> = ({
  currentSymbol,
  onSymbolChange,
  availableSymbols = [],
  lang = 'RO',
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [showDropdown, setShowDropdown] = useState(false);
  const [interval, setInterval] = useState<'1' | '5' | '15' | '60' | '240' | 'D'>('15');
  const [chartKey, setChartKey] = useState(0);
  const [hasError, setHasError] = useState(false);

  // Normalize symbol for TradingView
  const cleanBase = currentSymbol
    .replace(/-SWAP$/i, '')
    .replace(/-/g, '')
    .toUpperCase();

  // Popular quick-switch symbols
  const quickSymbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'SUIUSDT', 'RENDERUSDT', 'DOGEUSDT'];

  const filteredSymbols = availableSymbols.filter((s) =>
    s.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleSelectSymbol = (sym: string) => {
    onSymbolChange(sym);
    setSearchQuery('');
    setShowDropdown(false);
    setHasError(false);
  };

  const handleResetToDefault = () => {
    onSymbolChange('BTCUSDT');
    setSearchQuery('');
    setShowDropdown(false);
    setHasError(false);
    setChartKey((k) => k + 1);
  };

  // Generate isolated HTML for the TradingView widget inside an iframe to prevent cross-origin script collisions
  const iframeSrcDoc = useMemo(() => {
    let tvSymbol = `OKX:${cleanBase}.P`;
    if (!cleanBase.endsWith('USDT') && !cleanBase.endsWith('USD')) {
      tvSymbol = `OKX:${cleanBase}USDT.P`;
    }

    const config = {
      autosize: true,
      symbol: tvSymbol,
      interval: interval,
      timezone: 'Etc/UTC',
      theme: 'dark',
      style: '1',
      locale: 'en',
      enable_publishing: false,
      allow_symbol_change: true,
      calendar: false,
      hide_side_toolbar: false,
      hide_legend: false,
      save_image: true,
      studies: ['STD;RSI', 'STD;MACD'],
      support_host: 'https://www.tradingview.com',
    };

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
      background-color: #000000;
    }
    .tradingview-widget-container {
      width: 100%;
      height: 100%;
      position: relative;
    }
    .tradingview-widget-container__widget {
      width: 100%;
      height: 100%;
    }
  </style>
  <script>
    // Suppress any cross-origin or script evaluation warnings inside the isolated iframe
    window.onerror = function() { return true; };
    window.addEventListener('error', function(e) { if (e && e.preventDefault) e.preventDefault(); return true; }, true);
    window.addEventListener('unhandledrejection', function(e) { if (e && e.preventDefault) e.preventDefault(); return true; }, true);
  </script>
</head>
<body>
  <div class="tradingview-widget-container">
    <div class="tradingview-widget-container__widget"></div>
    <script type="text/javascript" src="https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js" async>
      ${JSON.stringify(config)}
    </script>
  </div>
</body>
</html>`;
  }, [cleanBase, interval]);

  return (
    <div className="bg-zinc-950 border border-amber-500/30 rounded p-2.5 flex flex-col h-full min-h-0 font-mono shadow-2xl relative">
      {/* 1. CHART CONTROLS & HEADER */}
      <div className="flex flex-wrap items-center justify-between border-b border-amber-500/30 pb-2.5 mb-2.5 gap-2">
        {/* Left: Active symbol & provider badge */}
        <div className="flex items-center space-x-2">
          <TrendingUp className="w-4 h-4 text-amber-500" />
          <span className="font-bold text-xs tracking-wider text-amber-400">
            OKX LIVE CHART: <span className="text-white text-sm">{cleanBase}</span>
          </span>
          <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-amber-950/60 border border-amber-500/40 text-amber-300">
            OKX PERPETUAL
          </span>
        </div>

        {/* Center: Timeframe Pills */}
        <div className="flex items-center space-x-1 bg-black p-0.5 rounded border border-zinc-800 text-[10px]">
          {(['1', '5', '15', '60', '240', 'D'] as const).map((tf) => {
            const label = tf === '60' ? '1H' : tf === '240' ? '4H' : tf === 'D' ? '1D' : `${tf}m`;
            return (
              <button
                key={tf}
                type="button"
                onClick={() => setInterval(tf)}
                className={`px-1.5 py-0.5 rounded transition-colors ${
                  interval === tf
                    ? 'bg-amber-500 text-black font-bold'
                    : 'text-zinc-400 hover:text-white hover:bg-zinc-800'
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>

        {/* Right: Search + Reset Controls */}
        <div className="flex items-center space-x-2">
          {/* Symbol Search Bar */}
          <div className="relative">
            <div className="flex items-center bg-black border border-amber-500/40 rounded px-2 py-1">
              <Search className="w-3 h-3 text-amber-500 mr-1.5" />
              <input
                type="text"
                placeholder={lang === 'EN' ? 'Search pair...' : 'Caută simbol OKX...'}
                value={searchQuery}
                onFocus={() => setShowDropdown(true)}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setShowDropdown(true);
                }}
                className="bg-transparent text-amber-300 placeholder:text-zinc-600 text-[11px] outline-none w-[120px] sm:w-[140px]"
              />
            </div>

            {/* Dropdown Results */}
            {showDropdown && (
              <div className="absolute right-0 top-full mt-1.5 w-52 bg-zinc-950 border border-amber-500/60 rounded shadow-2xl max-h-64 overflow-y-auto z-50">
                <div className="p-1.5 text-[9px] text-zinc-500 border-b border-zinc-800 flex justify-between items-center">
                  <span>UNIVERSE TRADING ({filteredSymbols.length})</span>
                  <button
                    onClick={() => setShowDropdown(false)}
                    className="text-zinc-400 hover:text-white text-[10px]"
                  >
                    ✕
                  </button>
                </div>
                {filteredSymbols.length > 0 ? (
                  filteredSymbols.map((sym) => (
                    <div
                      key={sym}
                      onClick={() => handleSelectSymbol(sym)}
                      className={`px-2.5 py-1.5 text-[11px] cursor-pointer hover:bg-amber-500/20 text-amber-300 font-mono flex items-center justify-between border-b border-zinc-900/50 ${
                        currentSymbol === sym ? 'bg-amber-500/30 font-bold' : ''
                      }`}
                    >
                      <span>{sym}</span>
                      <span className="text-[9px] text-zinc-500">OKX SWAP</span>
                    </div>
                  ))
                ) : (
                  <div className="p-3 text-[11px] text-zinc-500 text-center">
                    {lang === 'EN' ? 'No symbol found' : 'Niciun simbol găsit'}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Reload / Reset Button */}
          <button
            type="button"
            onClick={handleResetToDefault}
            title={lang === 'EN' ? 'Reset chart to BTCUSDT' : 'Resetează graficul la BTCUSDT'}
            className="flex items-center space-x-1 px-2 py-1 rounded bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-zinc-300 text-[10px] transition-colors"
          >
            <RefreshCw className="w-3 h-3 text-amber-400" />
            <span className="hidden sm:inline">RESET</span>
          </button>
        </div>
      </div>

      {/* 2. QUICK PAIRS BAR */}
      <div className="flex flex-wrap items-center gap-1.5 pb-2 text-[10px]">
        <span className="text-zinc-500 text-[9px] mr-1 uppercase tracking-wider">
          {lang === 'EN' ? 'QUICK SELECT:' : 'RAPID:'}
        </span>
        {quickSymbols.map((qs) => {
          const isActive = cleanBase === qs;
          return (
            <button
              key={qs}
              type="button"
              onClick={() => handleSelectSymbol(qs)}
              className={`px-2 py-0.5 rounded border transition-colors ${
                isActive
                  ? 'bg-amber-500/20 border-amber-500 text-amber-300 font-bold'
                  : 'bg-black border-zinc-800 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200'
              }`}
            >
              {qs.replace('USDT', '')}
            </button>
          );
        })}
      </div>

      {/* 3. TRADINGVIEW WIDGET CONTAINER */}
      <div className="flex-1 w-full h-full min-h-0 relative rounded overflow-hidden bg-black border border-zinc-900">
        {hasError ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center space-y-3 bg-zinc-950">
            <AlertCircle className="w-8 h-8 text-rose-500" />
            <div className="text-sm font-bold text-rose-400">
              {lang === 'EN' ? 'Failed to load TradingView chart' : 'Nu s-a putut încărca graficul TradingView'}
            </div>
            <p className="text-xs text-zinc-400 max-w-sm">
              Simbolul selectat (<span className="text-amber-400">{cleanBase}</span>) s-ar putea să nu aibă feed direct pe OKX în TradingView.
            </p>
            <button
              type="button"
              onClick={handleResetToDefault}
              className="px-3 py-1.5 bg-amber-500 hover:bg-amber-400 text-black font-bold text-xs rounded transition-colors"
            >
              RESETEAZĂ LA BTCUSDT
            </button>
          </div>
        ) : (
          <iframe
            key={`${cleanBase}-${interval}-${chartKey}`}
            id="tradingview-widget-iframe"
            title={`TradingView Chart ${cleanBase}`}
            srcDoc={iframeSrcDoc}
            className="w-full h-full border-0 bg-black block"
            style={{ width: '100%', height: '100%', border: 'none' }}
            loading="eager"
            onError={() => setHasError(true)}
          />
        )}
      </div>

      {/* 4. FOOTER STATUS BAR */}
      <div className="mt-2 pt-1.5 border-t border-zinc-900 flex items-center justify-between text-[10px] text-zinc-500">
        <div className="flex items-center space-x-2">
          <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
          <span>Feed TradingView WebSocket OKX (Interval: {interval})</span>
        </div>
        <div className="flex items-center space-x-3">
          <button
            onClick={() => setChartKey((k) => k + 1)}
            className="text-amber-400 hover:underline flex items-center space-x-1"
          >
            <RefreshCw className="w-2.5 h-2.5" />
            <span>Reîncarcă feed</span>
          </button>
          <a
            href={`https://www.okx.com/trade-swap/${cleanBase.toLowerCase()}-swap`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-zinc-400 hover:text-amber-400 flex items-center space-x-0.5"
          >
            <span>Deschide OKX</span>
            <ExternalLink className="w-2.5 h-2.5 ml-0.5" />
          </a>
        </div>
      </div>
    </div>
  );
};
