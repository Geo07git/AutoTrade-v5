import React, { useState } from 'react';
import {
  FileText,
  Download,
  Printer,
  X,
  Search,
  BookOpen,
  Shield,
  Layers,
  BarChart2,
  Sliders,
  Terminal,
  Zap,
  CheckCircle,
} from 'lucide-react';
import { downloadUserManualPdf } from '../utils/generateManualPdf';

interface UserManualModalProps {
  isOpen: boolean;
  onClose: () => void;
  lang?: string;
}

export const UserManualModal: React.FC<UserManualModalProps> = ({
  isOpen,
  onClose,
  lang = 'ro',
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<string>('all');
  const [downloadSuccess, setDownloadSuccess] = useState(false);

  if (!isOpen) return null;

  const handleDownloadPdf = () => {
    try {
      downloadUserManualPdf();
      setDownloadSuccess(true);
      setTimeout(() => setDownloadSuccess(false), 3500);
    } catch (err) {
      console.error('Failed to generate PDF:', err);
    }
  };

  const handlePrint = () => {
    window.print();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm flex items-center justify-center p-2 sm:p-4 overflow-y-auto">
      <div className="bg-zinc-950 border border-amber-500/40 rounded-lg max-w-4xl w-full max-h-[90vh] flex flex-col shadow-2xl font-mono text-zinc-300 overflow-hidden">
        {/* Header Modal */}
        <div className="bg-zinc-900/90 border-b border-amber-500/30 p-3 sm:p-4 flex items-center justify-between shrink-0">
          <div className="flex items-center space-x-2.5">
            <BookOpen className="w-5 h-5 text-amber-500" />
            <div>
              <h2 className="text-sm sm:text-base font-bold text-amber-400 tracking-wider">
                MANUAL COMPLET DE UTILIZARE — TRADEBOT 5 BLOOMBERG TERMINAL
              </h2>
              <p className="text-[10px] text-zinc-400 font-sans">
                Ghid de operare, comportament butoane, carduri, formule de risc și descărcare PDF oficial
              </p>
            </div>
          </div>

          <div className="flex items-center space-x-2">
            <button
              type="button"
              onClick={handleDownloadPdf}
              className="px-3 py-1.5 bg-amber-500 hover:bg-amber-400 text-black font-bold rounded text-xs transition-all flex items-center space-x-1.5 shadow-md cursor-pointer"
              title="Descarcă manualul formatat ca document PDF pe calculator"
            >
              <Download className="w-4 h-4" />
              <span>DESCARCĂ PDF</span>
            </button>

            <button
              type="button"
              onClick={handlePrint}
              className="px-2.5 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 font-bold rounded text-xs transition-all flex items-center space-x-1 cursor-pointer hidden sm:flex"
              title="Tipărește sau salvează ca PDF din browser"
            >
              <Printer className="w-4 h-4" />
              <span>PRINT</span>
            </button>

            <button
              type="button"
              onClick={onClose}
              className="p-1.5 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {downloadSuccess && (
          <div className="bg-emerald-950 border-b border-emerald-500/50 p-2 text-center text-xs text-emerald-300 font-bold flex items-center justify-center space-x-2 animate-fadeIn">
            <CheckCircle className="w-4 h-4 text-emerald-400" />
            <span>Fișierul „Manual_Utilizare_TradeBot_Bloomberg.pdf” a fost descărcat cu succes!</span>
          </div>
        )}

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-6 terminal-scrollbar text-xs leading-relaxed">
          {/* Quick Notice */}
          <div className="bg-amber-950/20 border border-amber-500/30 rounded p-3 text-[11px] text-amber-200/90 flex items-start space-x-2.5">
            <Shield className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <div>
              <strong>Documentație Oficială de Desk:</strong> Acest manual acoperă toate paginile terminalului Bloomberg, butoanele de control, regulile de execuție, managementul riscului și funcționarea resetării contului. Poți descărca oricând fișierul PDF apăsând butonul galben <strong>„DESCARCĂ PDF”</strong> din colțul de sus.
            </div>
          </div>

          {/* Section 1 */}
          <section className="space-y-2">
            <h3 className="text-amber-400 font-bold text-sm border-b border-zinc-800 pb-1 flex items-center space-x-2">
              <Terminal className="w-4 h-4" />
              <span>1. HEADER GLOBAL &amp; COMENZI DE SECURITATE</span>
            </h3>
            <ul className="space-y-2 text-zinc-300 pl-2">
              <li>
                <strong className="text-emerald-400">[PAPER] / [TESTNET] / [LIVE]</strong>: Comută modul de execuție. <em>PAPER</em> rulează simulare locală fără riscuri ($200.00 capital virtual, prețuri reale OKX, comisioane 0.05%). <em>TESTNET</em> trimite comenzi către API-ul demo OKX. <em>LIVE</em> tranzacționează fonduri reale pe contul de bursă.
              </li>
              <li>
                <strong className="text-amber-400">[SCALP] / [MOMENTUM] / [BREAKOUT]</strong>: Profilul activ al strategiei. Ajustează automat parametrii de risc (Stop Loss, Take Profit, Time Stop, număr de poziții).
              </li>
              <li>
                <strong className="text-cyan-400">INVERT SIGNALS [OFF / ON]</strong>: Inversează deciziile scannerului (Long devine Short și invers) pentru piețe puternic descendente.
              </li>
              <li>
                <strong className="text-teal-400">PROFIT VAULT [OFF / ON]</strong>: Când este activat, profitul protejat la ciclurile de trailing este transferat automat în seif și retras din riscul activ de tranzacționare.
              </li>
              <li>
                <strong className="text-sky-400">TG: [ACTIV / MUTE / STANDBY]</strong>: Monitorizează alertele Telegram. Când este pe <em>MUTE</em>, un simplu click reactivează alertele. Pe <em>ACTIV</em>, trimite un raport orar de test. Pe <em>STANDBY</em>, te conduce la configurarea cheilor.
              </li>
              <li>
                <strong className="text-rose-400">🛑 KILL SWITCH (URGENȚĂ)</strong>: Oprește scanarea și închide imediat toate pozițiile deschise la prețul pieței. <em>NU șterge</em> statisticile pe simbol, istoricul de comenzi sau configurarea salvată.
              </li>
            </ul>
          </section>

          {/* Section 2 */}
          <section className="space-y-2">
            <h3 className="text-amber-400 font-bold text-sm border-b border-zinc-800 pb-1 flex items-center space-x-2">
              <Layers className="w-4 h-4" />
              <span>2. ECRANUL [1:PORT] — PORTOFOLIU &amp; GESTIUNE CAPITAL</span>
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="bg-black/60 p-3 rounded border border-zinc-800 space-y-1">
                <span className="font-bold text-zinc-200 block text-xs">Carduri Financiare:</span>
                <p>• <strong>Sold Disponibil (Free Balance):</strong> USDT liber, neblocat în poziții.</p>
                <p>• <strong>Marjă Investită:</strong> Valoarea USDT blocată drept garanție în tranzacțiile curente.</p>
                <p>• <strong>Capital Total (Equity):</strong> Sold + Marjă + PnL Nerealizat (valoarea netă a contului).</p>
                <p>• <strong>PnL Nerealizat:</strong> Profitul sau pierderea cumulată a tuturor pozițiilor deschise.</p>
              </div>
              <div className="bg-black/60 p-3 rounded border border-zinc-800 space-y-1">
                <span className="font-bold text-zinc-200 block text-xs">Protecție &amp; Risc:</span>
                <p>• <strong>Drawdown Curent &amp; Max:</strong> Scăderea de la cel mai înalt nivel de capital atins.</p>
                <p>• <strong>Trailing Equity:</strong> Protecție dinamică a profitului pe portofoliu.</p>
                <p>• <strong>Circuit Breaker:</strong> Oprește automat tranzacționarea dacă pierderea zilnică atinge pragul critic (ex: -5%).</p>
                <p>• <strong>RESET CONT $200:</strong> Resetează soldul la fix $200.00, golește marja și pozițiile Paper, curăță seiful și istoricul de comenzi de test. Statisticile pe simbol rămân salvate pe disc.</p>
              </div>
            </div>
          </section>

          {/* Section 3 */}
          <section className="space-y-2">
            <h3 className="text-amber-400 font-bold text-sm border-b border-zinc-800 pb-1 flex items-center space-x-2">
              <BarChart2 className="w-4 h-4" />
              <span>3. ECRANUL [SYM] — ANALIZĂ SIMBOL &amp; MULTIPLICATOR GRADUAL CONTINUU</span>
            </h3>
            <p className="text-zinc-300">
              Modulul analitic rolling (ultimele 30 de tranzacții per simbol) calculează rata de succes a impulsului (Hit-rate MFE ≥ 1.5%) și ajustează mărimea poziției prin interpolare liniară continuă:
            </p>
            <div className="bg-black/70 p-3 rounded border border-zinc-800 font-mono text-[11px] space-y-1.5">
              <div className="text-amber-300 font-bold">
                Formula Liniară Continuă: multiplier = 0.50 + (HitRate_MFE_1.5% / 100.0) * 1.00
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-[10px] text-zinc-400 pt-1">
                <div>• La 0% hit-rate ➔ <strong>0.50x</strong> (-50% reducere risc pe active plate)</div>
                <div>• La 50% hit-rate ➔ <strong>1.00x</strong> (baseline neutru)</div>
                <div>• La 100% hit-rate ➔ <strong>1.50x</strong> (+50% bonus pe runneri constanți)</div>
              </div>
              <div className="text-[10px] text-zinc-500 pt-1">
                * Simbolurile cu sub 8 tranzacții (n &lt; 8) rămân strict la multiplicator neutru 1.00x (zgomot statistic).
              </div>
            </div>
            <div className="space-y-1 text-zinc-400 pt-1">
              <p>• <strong>Acoperire Capital Activ:</strong> Arată procentul din banii activi aflați sub simboluri cu eșantion VALID (n ≥ 8) vs sub simboluri NEUTRE (n &lt; 8).</p>
              <p>• <strong>Telemetrie Viteză Impuls (≤5m):</strong> Înregistrează pasiv numărul de trade-uri care ating MFE ≥ 1.5% în primele 3-5 minute, fără a afecta mărimea poziției până la confirmarea eșantionului.</p>
            </div>
          </section>

          {/* Section 4 */}
          <section className="space-y-2">
            <h3 className="text-amber-400 font-bold text-sm border-b border-zinc-800 pb-1 flex items-center space-x-2">
              <Zap className="w-4 h-4" />
              <span>4. ECRANELE DE EXECUȚIE, BLOTTER &amp; SETĂRI</span>
            </h3>
            <div className="space-y-2 text-zinc-300">
              <p>• <strong>[2:POS] (Poziții Active):</strong> Monitorizare la milisecundă a MFE (vârful de profit atins), MAE (drawdown maxim temporar), mutarea Stop Loss-ului la Breakeven și ieșirea automată la Time Stop.</p>
              <p>• <strong>[3:SCAN] (Universe Scanner):</strong> Filtru automat de regim BTC (Trend Bullish/Bearish/Ranging), scor sentiment piață OKX și butonul <em>TRIGGER SCAN</em> pentru forțarea unei interogări imediate.</p>
              <p>• <strong>[4:BLOT] (Orders &amp; Audit):</strong> Jurnal detaliat al fiecărei comenzi închise (Take Profit, Trailing Stop, Stop Loss, Time Stop, Kill Switch) și audit log pentru securitate.</p>
              <p>• <strong>[5:SET] (Parametri &amp; API):</strong> Ajustarea pragurilor strategiei, introducerea cheilor OKX API și configurarea notificărilor Telegram.</p>
            </div>
          </section>

          {/* Section 5 */}
          <section className="space-y-2">
            <h3 className="text-amber-400 font-bold text-sm border-b border-zinc-800 pb-1 flex items-center space-x-2">
              <Sliders className="w-4 h-4" />
              <span>5. GLOSAR DE TERMENI TEHNICI</span>
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px]">
              <div className="p-2 bg-black/50 rounded border border-zinc-900">
                <strong className="text-emerald-400">MFE (Max Favorable Excursion):</strong> Vârful maxim de profit atins de poziție înainte de închidere.
              </div>
              <div className="p-2 bg-black/50 rounded border border-zinc-900">
                <strong className="text-rose-400">MAE (Max Adverse Excursion):</strong> Cel mai adânc nivel de pierdere temporară suferit de poziție.
              </div>
              <div className="p-2 bg-black/50 rounded border border-zinc-900">
                <strong className="text-cyan-400">Breakeven:</strong> Mutarea Stop Loss-ului la prețul de intrare când poziția e în profit.
              </div>
              <div className="p-2 bg-black/50 rounded border border-zinc-900">
                <strong className="text-amber-400">Time Stop:</strong> Închiderea poziției care stagnează prea mult timp fără să genereze impuls.
              </div>
            </div>
          </section>
        </div>

        {/* Footer */}
        <div className="bg-zinc-900/90 border-t border-amber-500/30 p-3 sm:p-4 flex items-center justify-between shrink-0">
          <div className="text-[10px] text-zinc-500 font-mono">
            Document oficial generat pentru utilizatorul sistemului Bloomberg TradeBot.
          </div>

          <div className="flex items-center space-x-2">
            <button
              type="button"
              onClick={handleDownloadPdf}
              className="px-3 py-1.5 bg-amber-500 hover:bg-amber-400 text-black font-bold rounded text-xs transition-all flex items-center space-x-1.5 cursor-pointer shadow-md"
            >
              <Download className="w-4 h-4" />
              <span>DESCARCĂ MANUAL PDF</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 font-bold rounded text-xs transition-all"
            >
              ÎNCHIDE
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
