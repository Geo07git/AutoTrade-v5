import React, { useEffect, useMemo, useState } from 'react';
import { Clock, Moon, Grid3x3 } from 'lucide-react';

/**
 * "Biroul agentului" — o fereastra mica, vie, care arata ce face desk-ul intre doua scanuri.
 *
 * Nu este o animatie decorativa: fiecare stare a personajelor este derivata din starea reala a
 * agentului (loopActive / lastRunAt / nextRunAt / runningBots), iar countdown-ul este cel pe care
 * bucla il foloseste efectiv. Cand cronometrul ajunge la 0, agentul chiar scaneaza — de aceea
 * personajele se trezesc atunci, nu la intervale aleatorii.
 */

type DeskPhase = 'OFF' | 'IDLE' | 'WARMUP' | 'WORKING' | 'STALLED';

interface AgentDeskProps {
  lastRunAt?: number;
  nextRunAt?: number;
  runIntervalSec?: number;
  loopActive?: boolean;
  mode?: string;
  runningBots?: number;
  totalCycles?: number;
  lastSummary?: string;
  /** Varianta mica pentru ecranul principal: fara linia de sumar, birou mai scund. */
  compact?: boolean;
}

const mmss = (ms: number): string => {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};

/** Un "om" de 24x30 px: corp, antena, ochi care clipesc, picioare. */
const DeskBot: React.FC<{
  tone: string;
  animClass: string;
  delay?: string;
  accessory?: 'zzz' | 'spark' | 'coffee' | null;
  dim?: boolean;
}> = ({ tone, animClass, delay = '0s', accessory = null, dim = false }) => (
  <div className={`relative ${tone} ${dim ? 'opacity-40' : ''}`}>
    <svg viewBox="0 0 24 30" className="w-6 h-8 tb5desk-bot" aria-hidden="true">
      <g className={animClass} style={{ animationDelay: delay }}>
        <line x1="12" y1="3" x2="12" y2="7" stroke="currentColor" strokeWidth="1" opacity="0.7" />
        <circle cx="12" cy="2.4" r="1.5" fill="currentColor" className="tb5desk-glow" />
        <rect
          x="4.5"
          y="7.5"
          width="15"
          height="13"
          rx="4"
          fill="currentColor"
          fillOpacity="0.12"
          stroke="currentColor"
          strokeWidth="1.4"
        />
        <g className="tb5desk-eyes">
          <circle cx="9.5" cy="13.5" r="1.35" fill="currentColor" />
          <circle cx="14.5" cy="13.5" r="1.35" fill="currentColor" />
        </g>
        <line x1="9" y1="20.5" x2="9" y2="23" stroke="currentColor" strokeWidth="1.2" opacity="0.8" />
        <line x1="15" y1="20.5" x2="15" y2="23" stroke="currentColor" strokeWidth="1.2" opacity="0.8" />
      </g>
    </svg>
    {accessory === 'zzz' && (
      <div className="absolute -top-1 left-3 text-[8px] font-black select-none">
        <span className="tb5desk-zzz inline-block" style={{ animationDelay: '0s' }}>
          z
        </span>
        <span className="tb5desk-zzz inline-block" style={{ animationDelay: '.6s' }}>
          z
        </span>
      </div>
    )}
    {accessory === 'spark' && (
      <span className="absolute -top-1 left-4 text-[9px] tb5desk-zzz">✦</span>
    )}
    {accessory === 'coffee' && (
      <span className="absolute bottom-0 left-4 text-[8px]">☕</span>
    )}
  </div>
);

export const AgentDesk: React.FC<AgentDeskProps> = ({
  lastRunAt,
  nextRunAt,
  runIntervalSec,
  loopActive,
  mode,
  runningBots = 0,
  totalCycles,
  lastSummary,
  compact = false,
}) => {
  const [now, setNow] = useState(() => Date.now());

  // Ora locala a paginii, nu a serverului: countdown-ul trebuie sa se miste chiar daca poll-ul
  // de status vine la 15 s.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const intervalMs = Math.max(30, runIntervalSec || 900) * 1000;
  const target = nextRunAt || (lastRunAt ? lastRunAt + intervalMs : undefined);
  const msLeft = target ? target - now : 0;
  const elapsedPct = target
    ? Math.min(100, Math.max(0, ((intervalMs - Math.max(0, msLeft)) / intervalMs) * 100))
    : 0;

  /**
   * Serverul impinge `nextRunAt` inainte la INTRAREA in ciclu, dar scrie `lastRunAt` doar la
   * IESIRE. Deci "ciclu in zbor" se vede din lastRunAt: daca a trecut un interval de la ultimul
   * ciclu terminat si nu a aparut inca unul nou, scanul chiar ruleaza acum.
   */
  const dueAt = lastRunAt
    ? lastRunAt + intervalMs
    : nextRunAt
      ? nextRunAt - intervalMs
      : undefined;

  const phase: DeskPhase = useMemo(() => {
    if (!loopActive) return 'OFF';
    if (!dueAt) return 'IDLE';
    if (now >= dueAt + 120_000) return 'STALLED';
    if (now >= dueAt) return 'WORKING';
    if (msLeft <= 25_000) return 'WARMUP';
    return 'IDLE';
  }, [loopActive, dueAt, now, msLeft]);

  const BOTS = [
    { tone: 'text-cyan-300', delay: '0s' },
    { tone: 'text-violet-300', delay: '.35s' },
    { tone: 'text-emerald-300', delay: '.7s' },
  ];

  return (
    <div className="bg-zinc-950 border border-zinc-800 rounded p-2.5 space-y-2 overflow-hidden">
      <style>{`
        @keyframes tb5desk-bob { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-2.5px) } }
        @keyframes tb5desk-work { 0%,100% { transform: translateY(0) rotate(-3deg) } 50% { transform: translateY(-3.5px) rotate(3deg) } }
        @keyframes tb5desk-zzz { 0% { opacity: 0; transform: translate(0,2px) scale(.7) } 35% { opacity: 1 } 100% { opacity: 0; transform: translate(5px,-9px) scale(1.15) } }
        @keyframes tb5desk-blink { 0%,90%,100% { transform: scaleY(1) } 94% { transform: scaleY(.15) } }
        @keyframes tb5desk-beam { 0% { transform: translateX(-8px); opacity: 0 } 20% { opacity: .9 } 80% { opacity: .9 } 100% { transform: translateX(96px); opacity: 0 } }
        @keyframes tb5desk-glow { 0%,100% { opacity: .45 } 50% { opacity: 1 } }
        .tb5desk-bot { overflow: visible }
        .tb5desk-eyes { animation: tb5desk-blink 5.2s infinite; transform-origin: 12px 13.5px }
        .tb5desk-zzz { animation: tb5desk-zzz 2.1s ease-in-out infinite }
        .tb5desk-glow { animation: tb5desk-glow 2.6s ease-in-out infinite }
        .tb5desk-idle .tb5desk-bot g { animation: tb5desk-bob 3.4s ease-in-out infinite }
        .tb5desk-work .tb5desk-bot g { animation: tb5desk-work .82s ease-in-out infinite }
        .tb5desk-beam { animation: tb5desk-beam 2.4s linear infinite }
        @media (prefers-reduced-motion: reduce) {
          .tb5desk-bot g, .tb5desk-eyes, .tb5desk-zzz, .tb5desk-glow, .tb5desk-beam { animation: none !important }
        }
      `}</style>

      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-1.5">
          <span
            className={`text-[10px] font-mono px-1.5 py-0.5 rounded border font-bold ${
              phase === 'WORKING'
                ? 'text-emerald-300 border-emerald-500/50 bg-emerald-950/30'
                : phase === 'STALLED'
                  ? 'text-rose-300 border-rose-500/50 bg-rose-950/30'
                  : phase === 'WARMUP'
                  ? 'text-amber-300 border-amber-500/40 bg-amber-950/20'
                  : phase === 'OFF'
                    ? 'text-zinc-500 border-zinc-700'
                    : 'text-cyan-300 border-cyan-500/40 bg-cyan-950/20'
            }`}
          >
            {phase === 'WORKING'
              ? 'SCANEAZA + GANDESTE'
              : phase === 'STALLED'
                ? 'CICLU INTARZIAT'
                : phase === 'WARMUP'
                  ? 'SE PREGATESTE'
                  : phase === 'OFF'
                    ? 'BUCLA OPRITA'
                    : 'ASTEAPTA REGIM'}
          </span>
          {runningBots > 0 && (
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded border text-emerald-300 border-emerald-500/40 bg-emerald-950/20 flex items-center gap-1">
              <Grid3x3 className="w-3 h-3" /> {runningBots} bot{runningBots > 1 ? 'i' : ''} la munca
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 text-[10px] font-mono text-zinc-400">
          <span className="flex items-center gap-1">
            <Clock className="w-3 h-3" /> urmatorul scan in{' '}
            <b className={msLeft <= 25_000 ? 'text-amber-300' : 'text-zinc-200'}>{mmss(msLeft)}</b>
          </span>
          <span className="text-zinc-600">|</span>
          <span className="text-zinc-500">
            {mode || '--'} · {totalCycles ?? 0} cicluri
          </span>
        </div>
      </div>

      {/* Bara de progres a ciclului — umple exact cat timp a trecut din interval. */}
      <div className="h-1 w-full bg-zinc-900 rounded overflow-hidden">
        <div
          className={`h-full transition-[width] duration-1000 ease-linear ${
            phase === 'WORKING'
              ? 'bg-emerald-400'
              : phase === 'WARMUP'
                ? 'bg-amber-400'
                : phase === 'OFF'
                  ? 'bg-zinc-700'
                  : 'bg-cyan-500/70'
          }`}
          style={{ width: `${phase === 'WORKING' ? 100 : elapsedPct}%` }}
        />
      </div>

      {/* Biroul: personajele reactioneaza la faza reala. */}
      <div className={`relative ${compact ? 'h-10' : 'h-12'} flex items-end gap-3 px-2`}>
        <div
          className={`flex items-end gap-3 ${phase === 'WORKING' ? 'tb5desk-work' : 'tb5desk-idle'}`}
        >
          <DeskBot
            tone={BOTS[0].tone}
            animClass=""
            delay={BOTS[0].delay}
            dim={phase === 'OFF'}
            accessory={phase === 'IDLE' ? 'coffee' : phase === 'WORKING' ? 'spark' : null}
          />
          <DeskBot
            tone={BOTS[1].tone}
            animClass=""
            delay={BOTS[1].delay}
            dim={phase === 'OFF'}
            accessory={phase === 'OFF' || phase === 'IDLE' ? 'zzz' : null}
          />
          <DeskBot
            tone={BOTS[2].tone}
            animClass=""
            delay={BOTS[2].delay}
            dim={phase === 'OFF'}
            accessory={phase === 'WORKING' ? 'spark' : null}
          />
        </div>

        {/* Fasciculul de scanare trece doar cat timp ciclul chiar ruleaza. */}
        {phase === 'WORKING' && (
          <div className="absolute bottom-0 left-2 right-2 h-3 pointer-events-none">
            <div className="tb5desk-beam h-full w-2 bg-gradient-to-t from-emerald-400/70 to-transparent rounded" />
          </div>
        )}

        <div className="ml-auto text-[9px] text-zinc-600 font-mono text-right max-w-[45%] truncate">
          {phase === 'IDLE' && 'niciun candidat nu trece de regim — sta pe maini, corect'}
          {phase === 'WARMUP' && 'trage 25 de contracte, 15m + 1h + order book'}
          {phase === 'WORKING' && 'DeepSeek citeste scanul si decide'}
          {phase === 'STALLED' && 'ciclul a intarziat peste 2 min — verifica terminalul'}
          {phase === 'OFF' && 'porneste bucla ca sa vezi desk-ul viu'}
        </div>
      </div>

      {!compact && lastSummary && (
        <div className="text-[10px] text-zinc-500 truncate border-t border-zinc-800/70 pt-1" title={lastSummary}>
          <Moon className="w-3 h-3 inline mr-1 text-zinc-600" />
          {lastSummary}
        </div>
      )}
    </div>
  );
};

export default AgentDesk;
