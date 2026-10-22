import { jsPDF } from 'jspdf';

export function downloadUserManualPdf(): void {
  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
  });

  const pageWidth = 210;
  const pageHeight = 297;
  const marginX = 15;
  const marginY = 18;
  const contentWidth = pageWidth - marginX * 2;
  let cursorY = marginY;

  const checkPageBreak = (neededHeight: number) => {
    if (cursorY + neededHeight > pageHeight - marginY) {
      doc.addPage();
      cursorY = marginY;
      drawPageHeaderFooter();
    }
  };

  const drawPageHeaderFooter = () => {
    const pageNum = doc.getNumberOfPages();
    // Header
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(140, 140, 140);
    doc.text('TRADEBOT 5 PRO — BLOOMBERG TERMINAL | MANUAL DE INSTRUCȚIUNI', marginX, 10);
    doc.setDrawColor(210, 210, 210);
    doc.setLineWidth(0.2);
    doc.line(marginX, 12, pageWidth - marginX, 12);

    // Footer
    doc.setDrawColor(210, 210, 210);
    doc.setLineWidth(0.2);
    doc.line(marginX, pageHeight - 12, pageWidth - marginX, pageHeight - 12);
    doc.setFontSize(8);
    doc.setTextColor(140, 140, 140);
    doc.text('Confidențial & Proprietar — Trading Automatizat Algoritmic OKX', marginX, pageHeight - 8);
    doc.text(`Pagina ${pageNum}`, pageWidth - marginX - 15, pageHeight - 8);
  };

  // --- COVER / HEADER ---
  drawPageHeaderFooter();

  // Title Box
  doc.setFillColor(15, 23, 42); // Dark slate
  doc.rect(marginX, cursorY, contentWidth, 28, 'F');
  
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.setTextColor(245, 158, 11); // Amber
  doc.text('TRADEBOT 5 BLOOMBERG TERMINAL', marginX + 6, cursorY + 11);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.setTextColor(226, 232, 240);
  doc.text('MANUAL COMPLET DE UTILIZARE, FUNCȚIONALITATE BUTOANE & GESTIUNE RISC', marginX + 6, cursorY + 18);
  doc.setFontSize(8);
  doc.setTextColor(148, 163, 184);
  doc.text(`Versiunea 5.2 | Generat: ${new Date().toLocaleDateString('ro-RO')} | Moduri: PAPER / TESTNET / LIVE`, marginX + 6, cursorY + 24);

  cursorY += 34;

  const printSectionHeader = (title: string, badge?: string) => {
    checkPageBreak(14);
    doc.setFillColor(243, 244, 246);
    doc.rect(marginX, cursorY - 1, contentWidth, 8, 'F');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(180, 83, 9); // Amber-700
    doc.text(title, marginX + 3, cursorY + 5);

    if (badge) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8);
      doc.setTextColor(71, 85, 105);
      doc.text(`[${badge}]`, pageWidth - marginX - 3 - doc.getTextWidth(`[${badge}]`), cursorY + 5);
    }
    cursorY += 11;
  };

  const printSubSection = (title: string) => {
    checkPageBreak(8);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9.5);
    doc.setTextColor(15, 23, 42);
    doc.text(title, marginX, cursorY);
    cursorY += 5;
  };

  const printParagraph = (text: string, indent: number = 0) => {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(51, 65, 85);
    const lines = doc.splitTextToSize(text, contentWidth - indent);
    checkPageBreak(lines.length * 4.2 + 2);
    doc.text(lines, marginX + indent, cursorY);
    cursorY += lines.length * 4.2 + 2;
  };

  const printBullet = (label: string, desc: string) => {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    doc.setTextColor(30, 41, 59);
    const labelFormatted = `• ${label}: `;
    const labelWidth = doc.getTextWidth(labelFormatted);
    
    doc.setFont('helvetica', 'normal');
    const firstLineDescWidth = contentWidth - 4 - labelWidth;
    
    // Simple text wrapping
    const fullText = `${labelFormatted}${desc}`;
    const lines = doc.splitTextToSize(fullText, contentWidth - 4);
    checkPageBreak(lines.length * 4.2 + 2);
    
    // Draw first line bold label + normal desc
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(15, 23, 42);
    doc.text(`• ${label}:`, marginX + 2, cursorY);
    
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(51, 65, 85);
    // Draw full lines with slight indent
    const wrappedDescLines = doc.splitTextToSize(desc, contentWidth - labelWidth - 4);
    doc.text(wrappedDescLines[0], marginX + 2 + labelWidth, cursorY);
    cursorY += 4.2;
    for (let i = 1; i < wrappedDescLines.length; i++) {
      checkPageBreak(4.2);
      doc.text(wrappedDescLines[i], marginX + 6, cursorY);
      cursorY += 4.2;
    }
    cursorY += 1.5;
  };

  // --- CAPITOLUL 1 ---
  printSectionHeader('1. HEADER GLOBAL & COMENZI DE CONTROL', 'Zonă Permanentă');
  printParagraph('Bara superioară a terminalului conține comenzile rapide de securitate, selectoarele de profil și comutarea mediilor de tranzacționare:');
  
  printBullet(
    '[PAPER] / [TESTNET] / [LIVE]',
    'Mod de execuție. PAPER rulează simulare locală curată ($200.00 capital virtual, prețuri reale OKX, comisioane 0.05%). TESTNET se conectează via API la contul demo OKX. LIVE trimite ordine pe contul real cu bani reali.'
  );
  printBullet(
    '[SCALP] / [MOMENTUM] / [BREAKOUT]',
    'Profil de tranzacționare. Fiecare profil are reguli proprii de risc: SCALP (Stop -2.5%, TP +4.0%, 3 poziții), MOMENTUM (Stop -3.5%, TP +6.0%, 4 poziții), BREAKOUT (Stop -4.0%, TP +8.0%, 3 poziții).'
  );
  printBullet(
    'INVERT SIGNALS [OFF / ON]',
    'Când este activat (ON), inversează automat semnalele generate de scanner (cumpără când piața semnalează Short și invers). Util în regimuri bear agresive.'
  );
  printBullet(
    'PROFIT VAULT [OFF / ON]',
    'Seiful de securizare a profitului. Când trailing equity atinge un ciclu de protecție, profitul închis este depozitat în seif și scos din expunerea de risc.'
  );
  printBullet(
    'TG: [ACTIV / MUTE / STANDBY]',
    'Statusul notificărilor Telegram. TG: ACTIV (alerte pornite, click trimite raport de test). TG: MUTE (notificări oprite, click reactivează instant). TG: STANDBY (necesită introducerea Bot Token-ului).'
  );
  printBullet(
    '🛑 KILL SWITCH (URGENȚĂ)',
    'Protocol suprem de siguranță. Oprește scanarea și închide imediat toate pozițiile deschise la prețul pieței. NU șterge istoricul statistic sau setările salvate.'
  );
  printBullet(
    'FULLSCREEN & SELECTOR LIMBĂ',
    'Comută terminalul pe tot ecranul (100% no scroll) și limba între Română și Engleză.'
  );

  cursorY += 3;

  // --- CAPITOLUL 2 ---
  printSectionHeader('2. ECRANUL [1:PORT] — PORTOFOLIU & MANAGEMENTUL CAPITALULUI', 'F1: Portfolio');
  printParagraph('Acest ecran sintetizează sănătatea financiară a contului, expunerea și starea capitalului:');

  printSubSection('Carduri Financiare:');
  printBullet('SOLD DISPONIBIL (Free Balance)', 'USDT liber neblocat în poziții, gata pentru alocare.');
  printBullet('MARJĂ INVESTITĂ', 'Suma în USDT blocată drept colateral în pozițiile aflate în desfășurare.');
  printBullet('CAPITAL TOTAL (Equity)', 'Balanță liberă + Marjă investită + PnL Nerealizat. Culoarea devine verde peste $200 și roșie în drawdown.');
  printBullet('PnL NEREALIZAT', 'Profitul sau pierderea cumulată a tuturor pozițiilor deschise în timp real.');

  printSubSection('Carduri de Protecție & Risc:');
  printBullet('DRAWDOWN CURENT & MAX', 'Scăderea procentuală de la cel mai înalt nivel de capital atins (High-Water Mark).');
  printBullet('TRAILING EQUITY STEPPING', 'Pragul dinamic de securizare a capitalului la fiecare pas de profit.');
  printBullet('CIRCUIT BREAKER', 'Protecție automată: dacă pierderea zilnică atinge limita (ex: -5%), botul intră în pauză până a doua zi.');

  printSubSection('Acțiuni pe Ecranul [1:PORT]:');
  printBullet('RESET CONT $200 (Doar în PAPER)', 'Resetează soldul și capitalul la fix $200.00, golește marja, șterge pozițiile active Paper, resetează Profit Vault la $0.00 și curăță istoricul de comenzi de test. Statisticile de simbol (.data/symbol_stats.json) NU sunt șterse direct.');
  printBullet('CLOSE ALL POSITIONS', 'Trimite ordin de închidere la piață pentru toate pozițiile active simultan.');

  cursorY += 3;

  // --- CAPITOLUL 3 ---
  printSectionHeader('3. ECRANUL [2:POS] — POZIȚII DESCHISE & METRICE LIVE', 'F2: Positions');
  printParagraph('Monitorizează fiecare poziție individuală cu detalii de microstructură:');
  printBullet('Preț Intrare vs Curent', 'Actualizat la milisecundă din feed-ul WebSocket.');
  printBullet('MFE (Maximum Favorable Excursion)', 'Cel mai mare profit procentual atins de poziție pe durata vieții sale. Reper pentru activarea Trailing Stop.');
  printBullet('MAE (Maximum Adverse Excursion)', 'Cel mai adânc procent de drawdown temporar suferit de poziție.');
  printBullet('Prag Breakeven', 'Bifă verde care indică mutarea Stop Loss-ului la prețul de intrare (trade fără risc de pierdere).');
  printBullet('Time Stop', 'Cronometru în minute. Dacă o poziție nu se mișcă în timpul alocat profilului, este închisă automat.');
  printBullet('Buton CLOSE (✕) & CHART', 'Închide poziția individuală sau încarcă graficul tehnic TradingView în panoul lateral.');

  cursorY += 3;

  // --- CAPITOLUL 4 ---
  printSectionHeader('4. ECRANUL [SYM] — ANALIZĂ SIMBOL & FEEDBACK MULTIPLIER', 'Analiză Rolling');
  printParagraph('Modul analitic avansat care elimină activele lente și sporește alocarea pe simbolurile cu expansiune reală:');

  printSubSection('Formula Multiplicatorului Gradual Continuu:');
  printParagraph('Pentru eșantioane valide (n >= 8), alocarea este guvernată de funcția liniară continuă:\nmultiplier = 0.50 + (HitRate_MFE_1.5% / 100.0) * 1.00');
  printBullet('Simetrie Matematică Perfectă', 'Interval simetric [0.50x – 1.50x] în jurul baseline-ului 1.00x la 50% hit-rate. La 0% hit-rate = 0.50x (-50% reducere risc). La 100% hit-rate = 1.50x (+50% bonus). Sub n < 8 multiplicatorul rămâne fix 1.00x (zgomot statistic).');
  
  printSubSection('Monitorizare Acoperire Capital & Eșantion:');
  printBullet('Bara de Progres Duală', 'Afișează % din capitalul activ curent alocat sub simboluri VALIDE (n >= 8) vs sub simboluri NEUTRE (n < 8), permițând urmărirea maturizării eșantionului.');
  printBullet('Telemetrie Viteză Impuls (<=5m)', 'Măsoară câte tranzacții au atins pragul MFE în primele 3-5 minute de la intrare (logging pasiv, fără efect pe decizii).');
  printBullet('Buton RECALCULEAZĂ ISTORIC', 'Resincronizează fereastra rolling (ultimele 30 trade-uri) din tot istoricul blotter-ului.');

  cursorY += 3;

  // --- CAPITOLUL 5 ---
  printSectionHeader('5. ECRANUL [3:SCAN] — UNIVERSE SCANNER & REGIM PIAȚĂ', 'F3: Scanner');
  printParagraph('Analizează continuu universul de perechi USDT-SWAP:');
  printBullet('Regim Piață BTC', 'Detectează trendul macro: TREND BULLISH, TREND BEARISH sau RANGING.');
  printBullet('OKX Market Sentiment', 'Scor ponderat derivat din raportul Long/Short și volumul derivatelor OKX.');
  printBullet('ADX & Filtru Volatilitate', 'Blochează tranzacționarea dacă piața este adormită sau haotică.');
  printBullet('TRIGGER SCAN', 'Forțează o scanare instantă a pieței fără a aștepta următorul tact automat.');

  cursorY += 3;

  // --- CAPITOLUL 6 ---
  printSectionHeader('6. ECRANUL [4:BLOT] — ORDERS & AUDIT TRAIL', 'F4: Blotter');
  printParagraph('Înregistrează istoricul complet și auditabil al deciziilor:');
  printBullet('Trade Blotter', 'Tabel cu fiecare tranzacție finalizată: PnL, comisioane, durată, MFE, MAE și motivul închiderii: TAKE_PROFIT, TRAILING_STOP, STOP_LOSS, TIME_STOP sau KILL_SWITCH.');
  printBullet('Audit Log', 'Jurnal de securitate ce reține modificările de configurare, comenzile Telegram și alertele de sistem.');

  cursorY += 3;

  // --- CAPITOLUL 7 ---
  printSectionHeader('7. ECRANUL [5:SET] — CONFIGURARE STRATEGIE & INTEGRĂRI', 'F5: Settings');
  printParagraph('Parametrii tehnici ajustabili ai botului:');
  printBullet('Setări Profil', 'Ajustează procentele de Hard Stop Loss, Breakeven Trigger, Trailing Trigger/Offset și Time Stop.');
  printBullet('Integrare Telegram', 'Configurare Bot Token și Chat ID, buton testare conexiune și comutare Mod Noapte.');
  printBullet('Chei API OKX', 'Introducere securizată pentru OKX_API_KEY, OKX_SECRET_KEY și OKX_PASSPHRASE.');

  cursorY += 3;

  // --- GLOSAR FINAL ---
  printSectionHeader('8. GLOSAR DE TERMENI TEHNICI', 'Referință Rapidă');
  printBullet('MFE (Maximum Favorable Excursion)', 'Punctul de profit maxim atins de un trade. Dacă MFE nu atinge 1.5%, activul este considerat lent.');
  printBullet('MAE (Maximum Adverse Excursion)', 'Punctul de pierdere maximă temporară suferit de un trade înainte de ieșire.');
  printBullet('Breakeven', 'Mecanism prin care Stop Loss-ul se mută la prețul de deschidere odată ce poziția este în profit.');
  printBullet('Trailing Stop', 'Stop dinamic care urmărește prețul în urcare la o distanță fixă procentuală.');
  printBullet('Circuit Breaker', 'Frână de urgență automată când pierderile zilnice ating pragul critic stabilit.');

  // Save the PDF
  doc.save('Manual_Utilizare_TradeBot_Bloomberg.pdf');
}
