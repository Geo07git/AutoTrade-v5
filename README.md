# TradeBot v5 (TB5) — Neutral Grid Desk pe OKX EEA X-Perp

Terminal de trading algoritmic în stil Bloomberg pentru **grid neutru (market-neutral) pe contracte perpetue OKX EEA X-Perp** (`*_UM_XPERP`), cu motor de execuție dublu (grid TB5 + grid nativ OKX), scanner de univers, research istoric, modul fiscal ANAF și **agent autonom DeepSeek** care decide ce griduri se deschid sau se opresc.

> **Starea configurației de azi (citește înainte de orice):**
>
> | Element | Stare |
> |---|---|
> | Mod de execuție implicit | `PAPER` (bani virtuali, 500 USDT) |
> | Agent AI | `OFF` — nu rulează nimic până îl pornești explicit |
> | Deploy automat OCI | **În pauză** — trigger-ul `push` din `.github/workflows/deploy.yml` este comentat (serverul OCI a fost șters la 2026-11-01). Un push pe `main` **nu** mai deployează nimic. |
> | Rulare | local (`npm run dev`) sau manual pe un server provisionat de la zero |

---

## 1. Ce este și ce NU este

**Ce este**

- Un desk care câștigă din **round-trips în interiorul unui range**: cumpără jos / vinde sus, de N ori, pe un contract perpetuu, cu direcție `neutral` (fără bias long/short).
- Potrivit pentru piață **laterală / choppy**. Când piața tinde, gridul pierde — de aceea există filtre de regim, guardrails dure și oprire automată.
- Are un strat AI (`DeepSeekAgent`) care **nu execută niciodată orb**: fiecare propunere trece printr-un validator determinist, iar un set de guardrails rulează complet independent de model.

**Ce NU este**

- Nu este trend-following, nu deschide poziții direcționale, nu ține poziții „sperând”.
- Nu este martingale agresiv. `MartingaleEngine` există, dar este **opțional și implicit dezactivat**.
- Agentul AI **nu** schimbă modul de execuție, **nu** atinge kill switch-ul, credențialele, levierul global sau Autopilot-ul nativ OKX.

---

## 2. Arhitectură

```
┌──────────────────────────────────────────────────────────────────────────┐
│  UI: React + Tailwind (terminal 8 tab-uri)  ←→  /api/bot/*  (Express)   │
└───────────────┬──────────────────────────────────────────────────────────┘
                │
        ┌───────▼────────┐
        │   TradeBot     │  pipeline/TradeBot.ts — stare, config, mod execuție
        └───┬────┬────┬──┘
            │    │    └──────────────► TelegramService (comenzi + rapoarte)
            │    └───────────────────► AnafTaxEngine (raport fiscal RON)
            │
   ┌────────▼─────────┐   ┌──────────────────────┐   ┌─────────────────────┐
   │ NeutralGridEngine│   │ OKXNativeGridEngine  │   │ DeepSeekAgent       │
   │ (grid TB5,       │   │ (contract_grid nativ │   │ (decide CE griduri  │
   │  PAPER + LIVE)   │   │  OKX, doar LIVE)     │   │  se deschid/opresc) │
   └────────┬─────────┘   └──────────┬───────────┘   └──────────┬──────────┘
            │                        │                          │
            └────────┬───────────────┴──────────┬───────────────┘
                     │                          │
            ┌────────▼────────┐        ┌────────▼─────────┐
            │  OKXAdapter     │        │ Scanner/Universe │
            │ (REST + WS v5)  │        │ + Research       │
            └─────────────────┘        └──────────────────┘
```

| Componentă | Fișier | Rol |
|---|---|---|
| Pipeline central | `src/server/pipeline/TradeBot.ts` | stare, config, mod execuție, orchestrare |
| Grid TB5 (propriu) | `src/server/engine/grid/NeutralGridEngine.ts` | grid cu nivele proprii, risk manager, martingale opțional |
| Grid nativ OKX | `src/server/engine/grid/OKXNativeGridEngine.ts` | `contract_grid` pe OKX: scan, create/stop/amend/sync |
| Analiză eligibilitate | `NeutralGridAnalyzer.ts`, `GridBotAnalyzer.ts` | scor 0-100 (choppiness, range-bound, ATR bell, spread/lichiditate) + regim |
| Optimizer grid | `GridOptimizer.ts`, `GridRangeVariants.ts` | range optim, număr de grile, spacing aritmetic/geometric |
| Risk | `GridRiskManager.ts` | SL/TP, trailing, protecție equity, lichidare |
| Research istoric | `src/server/research/*` | profil orar/zi/sesiune, regim, S/R, volume profile, pattern mining + FDR, backtest, walk-forward, comparație 3-way |
| Fiscal | `src/server/fiscal/AnafTaxEngine.ts` | declarația unică: tranzacții → RON → impunere + CASS |
| Agent AI | `src/server/agent/DeepSeekAgent.ts`, `DeepSeekClient.ts` | cicluri de decizie, validare, guardrails, jurnal |
| Persistență | `src/server/store/*` (`JsonStore`) | fișiere JSON în `.data/` (gitignored) |

---

## 3. Tab-urile terminalului

Bara de navigare (desktop) și bara de jos (mobil) au exact aceste intrări:

| # | Tab | Ce faci acolo |
|---|---|---|
| 1 | **OKX NATIVE & AUTO-LIMIT GRID** (`n` = boți activi) | griduri native OKX: scan oportunități, deschide/amend/stop/close, Autopilot nativ, analiză per simbol |
| 2 | **UNIVERS SCANNER GRID** (`n` = candidați) | scan univers, candidați scorați, praguri, analiză simbol, aplicare parametri în tab 1 |
| 3 | **TREPTE GRILĂ & ORDINE** | nivelele gridului, ordinele plasate, risk per bot |
| 4 | **GRID JOURNAL & LOGURI** (`n` = intrări) | jurnal arbitraje + audit log (`AGENT_*`, `GRID_*`, `RISK_*`) |
| 5 | **CONEXIUNE OKX EEA & PLATFORME** | chei API OKX, **OKX Demo (simulated trading)**, regiune EEA/GLOBAL/AUTO, test conexiune, **mod PAPER/LIVE**, kill switch, reset cont paper, Telegram, **cheie API DeepSeek** (cardul agentului, cu buton către tab 8) |
| 6 | **ANAF FISCAL & DECLARAȚIA UNICĂ** | import CSV / sync OKX, curs BNR, impozit + CASS pe praguri, export |
| 7 | **HISTORICAL RESEARCH & BACKTEST** | research complet pe simbol: profiluri orare, regim, pattern mining (FDR), backtest, walk-forward, recomandare optimă |
| 8 | **DEEPSEEK AGENT** (arată modul curent) | mod OFF/ADVISOR/AUTONOMOUS, cheie API, limite + guardrails, ciclu manual, panic stop, jurnal decizii |

Ecrane suplimentare fără buton în bară: `DASHBOARD` (vedere mobilă BOTS/LAUNCH) și `CONFIG`.

---

## 4. Moduri de execuție și siguranță

### 4.1 Moduri

| Mod | Capital | Execuție | Cum se activează |
|---|---|---|---|
| `PAPER` | virtual, **500 USDT** (resetabil) | adapter local, feed real OKX, comisioane + slippage modelate | implicit la prima pornire |
| `LIVE` | real | `OKXAdapter` (REST + WS privat) | tab 5 → mod LIVE (cere confirmare) |

În `LIVE` ai în plus un **flag de mediu** în tab 5:

- **OKX Demo (simulated trading)** bifat → request-urile poartă `x-simulated-trading: 1` (bani demo OKX, zero risc real);
- debifat → **bani reali**.

Regiunea OKX: `EEA` (implicit, `eea.okx.com`), `GLOBAL`, `AUTO`.

### 4.2 Protecții

- **Kill switch** global + separat pe PAPER și LIVE (`killSwitchEngaged`, `paperKillSwitchEngaged`, `liveKillSwitchEngaged`) → blochează deschideri noi, permite închideri.
- **STOP URGENȚĂ** în header (devine `KILL ACTIV` când e cuplat).
- **Risk per bot**: hard SL, TP, trailing, break-even, protecție equity / trailing drawdown.
- **Levier global** limitat (`maxLeverage`, implicit 3, mod cross) — agentul nu îl modifică niciodată.
- Toate rutele de control cer token (`BOT_CONTROL_TOKEN`, vezi §15).

---

## 5. AGENTUL AI (DeepSeek) — ce face, exact

### 5.1 Pe scurt

Un strat de decizie LLM **peste** motorul de grid nativ OKX. La fiecare ciclu citește starea reală a contului, oportunitățile scanate și boții activi, apoi răspunde cu **un singur obiect JSON strict** care conține cel mult `maxActionsPerCycle` acțiuni dintre:

`OPEN_GRID` · `STOP_BOT` · `AMEND_BOT` · `HOLD`

`HOLD` este un răspuns valid și profesional — modelul este instruit explicit să nu facă nimic dacă nu există un setup bun.

**Model implicit**: `deepseek-chat` la `https://api.deepseek.com` (API compatibil OpenAI). Modelul și base URL-ul se pot schimba din config.

### 5.2 Ce primește la fiecare ciclu (contextul)

1. **Re-scan proaspăt** al oportunităților `_UM_XPERP` (dacă `scanBeforeDecision` e activ) — agentul nu decide niciodată pe un scan vechi.
2. **Cont**: mod execuție, kill switch, echity, fond liber, marjă angajată, PnL sesiune, comisioane maker/taker.
3. **Limite**: buget/bot, rezervă minimă, boți maximi simultan, sloturi libere, levier maxim, praguri de scor și profit net/grilă, cooldown-uri active, limită de pierdere pe sesiune.
4. **Boți activi**: algoId, instId, range, grile, levier, marjă, PnL, SL/TP, vârstă în minute, număr de arbitraje.
5. **Candidați** (top `maxOpportunitiesInPrompt`, implicit 12): scor de eligibilitate, profit net estimat/grilă, variantă de range, investiție minimă OKX, preț curent.

### 5.3 Ce răspunde (contract JSON)

```json
{
  "market_regime": "RANGE_LATERAL | TRENDING | HIGH_VOL | NECUNOSCUT",
  "summary_ro": "o frază in romana: ce a vazut si ce a decis",
  "confidence": 0.0,
  "actions": [
    {
      "type": "OPEN_GRID",
      "instId": "BTC-USD_UM_XPERP",
      "minPx": 0, "maxPx": 0, "gridNum": 6,
      "runType": "1", "lever": 3, "sz": 20,
      "stopLossPct": 8, "takeProfitPct": 15,
      "rationale_ro": "de ce exact acest range"
    },
    { "type": "STOP_BOT", "algoId": "...", "stopType": "1", "rationale_ro": "..." },
    { "type": "AMEND_BOT", "algoId": "...", "slTriggerPx": 0, "tpTriggerPx": 0, "rationale_ro": "..." },
    { "type": "HOLD", "rationale_ro": "..." }
  ]
}
```

Răspunsul este parsat tolerant (se extrage obiectul JSON), dar acțiunile sunt **normalizate și validate** — vezi mai jos.

### 5.4 Validatorul determinist (`validateActions()`)

Fiecare `OPEN_GRID` trece, în ordine, prin regulile de mai jos. Prima care pică respinge acțiunea, iar **motivul exact apare în jurnal**:

| Regulă | Motiv de respingere (cum îl vezi în UI) |
|---|---|
| `allowOpenBots` | „Deschiderea autonomă de boți este dezactivată…” |
| kill switch | „Kill Switch este activat.” |
| mod execuție | „Modul de execuție este PAPER. Agentul NU comută modul singur…” |
| credențiale OKX | „Cheile API OKX nu sunt configurate.” |
| conflict de autoritate | Autopilot-ul nativ OKX este activ → un singur trader automat o dată |
| limită pierdere sesiune | „Limita de pierdere pe sesiune a fost atinsă…” |
| acțiuni/ciclu | „Limita de acțiuni per ciclu (n) a fost atinsă.” |
| sloturi | „Toate sloturile sunt ocupate (n boți maxim).” |
| instrument | necunoscut / în afara listei / **nu este `_UM_XPERP`** / există deja bot pe simbol |
| eligibilitate | „Candidatul … nu este eligibil: motiv.” |
| cooldown | „Cooldown activ pe SYMBOL (încă n min).” |
| scor | „Scor n sub pragul minim m…” |
| profit net/grilă | „Profit net/grilă x% sub pragul y%.” |
| geometrie range | `minPx > 0`, `maxPx > minPx`, **prețul curent în interiorul `[minPx, maxPx]`**, deviație ≤ **25%** pe fiecare parte |
| sizing | `gridNum` 2-100, `lever` 1-`maxLeverage`, `sz` între minimul OKX și `budgetPerBotUSDT`, fond liber după rezervă |
| SL/TP | `stopLossPct` 1-`hardStopLossPct`, `takeProfitPct` 1-300 |

`STOP_BOT` / `AMEND_BOT` sunt mult mai permisive (reduc riscul): trebuie doar ca `algoId` să existe între boții gestionați de TB5, iar la `AMEND` SL să fie **sub** preț și TP **peste** preț.

### 5.5 Guardrails dure (nu depind de LLM)

Rulate la fiecare ciclu, indiferent ce a răspuns modelul. Dacă un bot încalcă oricare, se emite `STOP_BOT` (`stopType='1'`) marcat **`GUARDRAIL`** în jurnal:

| Condiție | Prag implicit |
|---|---|
| PnL ≤ −X% din marjă | `hardStopLossPct` = 12% |
| Distanță până la lichidare ≤ Y% | `hardMinLiqDistancePct` = 12% |
| Preț în afara `[minPx, maxPx]` | — |
| 0 arbitraje în ≥ Z min **și** PnL negativ | `hardMaxNoFillMinutes` = 180 min |

Acțiunile de guardrail se execută **înaintea** celor propuse de model și nu pot fi anulate de un `HOLD`.

### 5.6 Fallback determinist (`LOCAL_FALLBACK`)

Fără cheie API sau la eroare/timeout de la DeepSeek: agentul folosește ranking-ul determinist TB5 (eligibili, peste pragurile de scor și profit, fără bot deja activ, sortat după scor) și produce aceleași tipuri de acțiuni. Toate trec prin **același** validator. În jurnal, `engine` = `LOCAL_FALLBACK` — deci știi mereu dacă a gândit un model sau o regulă.

### 5.7 Ce NU face niciodată (invarianți)

- Nu schimbă modul de execuție (`PAPER`/`LIVE`) — nici măcar ca să „ajute”.
- Nu atinge kill switch-ul, credențialele OKX, levierul global sau contul paper.
- Nu cuplează/decuplează Autopilot-ul nativ și nu îl ocolește: dacă e activ → `authorityConflict`, zero deschideri.
- Nu deschide grid nativ dacă modul nu e deja `LIVE` (capital real, asumat de tine).
- Nu inventează instrumente: doar candidați din scanul `_UM_XPERP`.
- Nu își modifică singur limitele ca să „încapă” o acțiune — refuză și jurnalizează motivul.

### 5.8 Moduri și semnificația `dryRun`

| Mod | Bucla | Execută? | `dryRun` |
|---|---|---|---|
| `OFF` | oprită | nu (doar cicluri manuale) | `true` |
| `ADVISOR` | activă la `runIntervalSec` | **nu** — analizează, validează, jurnalizează | `true` |
| `AUTONOMOUS` | activă | **da** — execută acțiunile aprobate | `false` |

`dryRun = (mode !== 'AUTONOMOUS')`. Deci `OFF` și `ADVISOR` produc decizii complete, cu respingeri motivate, **fără nicio execuție**.

### 5.9 Unde vezi ce a gândit

- **Tab 8** → jurnal decizii: oră, `DRY-RUN`/`EXECUTAT`, mod, engine, trigger, latență, tokens, încredere, regim, sumar RO, acțiuni aprobate, acțiuni `GUARDRAIL`, respingeri cu motiv, rezultate per acțiune.
- **Tab 4** → audit log: `AGENT_DECISION`, `AGENT_ACTION`, `AGENT_GUARDRAIL`, `AGENT_ERROR`.
- **Telegram** (dacă `notifyTelegram` e activ) — sumarul fiecărui ciclu.
- **Fișier**: `.data/deepseek_agent_decisions.json` (ultimele 100).

---

## 6. Setup de la zero

### 6.1 Cerințe

- Node.js 20+ (testat pe Node 22), npm
- Cont OKX EEA (opțional pentru PAPER)
- Chei API OKX cu permisiuni de trading (**fără** withdraw)
- Opțional: bot Telegram (`@BotFather`), cheie DeepSeek (`platform.deepseek.com`)

### 6.2 Instalare

```bash
git clone <repository-url>
cd AutoTrade-v5
npm install
```

### 6.3 `.env` (pornește de la `.env.example`)

| Variabilă | Obligatoriu | Rol |
|---|---|---|
| `BOT_CONTROL_TOKEN` | **da, în producție** | token pentru rutele de control (`x-bot-token` / `Bearer` / `?token=`). Generabil cu `openssl rand -hex 24` |
| `OKX_API_KEY` / `OKX_SECRET_KEY` / `OKX_PASSPHRASE` | pentru LIVE | fallback dacă nu le salvezi din UI |
| `DEEPSEEK_API_KEY` | pentru AI complet | alternativă la cheia salvată din UI (tab 5 sau tab 8) |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | opțional | notificări + comenzi (chat ID se auto-împerechează la primul mesaj) |
| `NODE_ENV` | recomandat `production` pe server | în producție, fără `BOT_CONTROL_TOKEN` se generează un token aleator la fiecare pornire |

> Cheile pot fi introduse și din UI și se salvează în `.data/`, care este gitignored: **OKX** din tab 5, **DeepSeek** din tab 5 (cardul *Configurare API DeepSeek*) sau din tab 8. Ambele locuri scriu aceeași cheie, prin același endpoint — nu există două surse de adevăr.

### 6.4 Pornire

```bash
npm run dev      # dezvoltare (tsx server.ts) -> http://localhost:3000
npm run build    # vite build + esbuild -> dist/server.cjs
npm start        # productie (node dist/server.cjs)
```

Alte scripturi: `npm run lint` (tsc --noEmit), `npm test`, `npm run clean`, `npm run emergency-stop`, plus shell-uri alternative `electron:dev` / `electron:build` (Windows) și `cap:build:apk` (Android, folder `android/`).

### 6.5 Primul contact

1. Deschide `http://localhost:3000` → modul e `PAPER`, capital virtual 500 USDT.
2. Tab **5** → introdu cheile OKX → **Test conexiune** → lasă **OKX Demo** bifat la început.
3. Tab **1** → **Scan** → vezi oportunitățile `_UM_XPERP` (scor, profit net/grilă, range propus).
4. Rămâi pe `PAPER` până înțelegi cum se comportă un range.

---

## 7. Activarea AI — checklist operațional

> Regula de aur: **ADVISOR mai întâi, AUTONOMOUS doar după ce ai citit jurnalul câteva zile.**

| Pas | Unde | Ce faci | Ce trebuie să vezi |
|---|---|---|---|
| 1 | tab 5 sau 8 | Salvează cheia DeepSeek (sau pune `DEEPSEEK_API_KEY` în `.env`) | badge `CHEIE SETATA`, `ENGINE: DEEPSEEK` după primul ciclu |
| 2 | tab 8 | Setează limitele (§8) | `MODIFICARI NESALVATE` dispare după salvare |
| 3 | tab 8 | Apasă **CICLU MANUAL** (modul e încă `OFF`) | o decizie `DRY-RUN` în jurnal, cu respingeri motivate |
| 4 | tab 8 | Citește 5-10 decizii: „de ce nu a deschis?” | motivele sunt concrete (scor, profit/grilă, cooldown, sloturi, range) |
| 5 | tab 8 | Treci pe **ADVISOR** | `LOOP ACTIV`, decizii noi la fiecare `runIntervalSec` |
| 6 | tab 5 | Pentru execuție reală: `LIVE` + **OKX Demo debifat**, credențiale reale, Autopilot nativ **oprit** | fără banner `CONFLICT DE AUTORITATE` |
| 7 | tab 8 | Verifică: `budget/bot` ≤ 1-2% din echity, `maxConcurrentBots` mic, rezervă confortabilă | — |
| 8 | tab 8 | Treci pe **AUTONOMOUS** (cere confirmare) | prima execuție apare ca `EXECUTAT`, cu `algoId` |
| 9 | tab 1 / 4 | Urmărește boții deschiși + audit `AGENT_*` | boți `running`, arbitraje > 0 în jurnal |

**Valori recomandate pentru primul run real** (conservator):

| Setare | Recomandare |
|---|---|
| `budgetPerBotUSDT` | 10-20 USDT |
| `maxConcurrentBots` | 1-2 |
| `minReserveUSDT` | ≥ 30% din fondul liber |
| `maxLeverage` | 2-3 |
| `minSuitabilityScore` | 75-80 |
| `minNetProfitPerGridPct` | 0.10-0.15 |
| `dailyLossLimitUSDT` | ~2-3% din echity |
| `runIntervalSec` | 300 |
| `maxActionsPerCycle` | 1 |

**Rutina zilnică (5 minute)**: tab 8 → jurnal (ce a respins și de ce) → tab 1 (boți activi, PnL) → tab 4 (audit) → ajustezi cel mult un parametru o dată.

---

## 8. Referință configurație AI

Toate valorile sunt **clamp-ate** de server (`updateConfig`): ce pui în afara intervalului este tăiat la limită, nu respins.

| Câmp | Default | Interval | Ce face |
|---|---|---|---|
| `mode` | `OFF` | OFF/ADVISOR/AUTONOMOUS | modul de operare |
| `model` | `deepseek-chat` | — | modelul LLM |
| `baseUrl` | `https://api.deepseek.com` | — | endpoint compatibil OpenAI |
| `temperature` | 0.25 | 0-1.5 | creativitate (0 = determinist) |
| `maxTokens` | 1600 | 400-8000 | buget de răspuns |
| `runIntervalSec` | 300 | 60-3600 | perioada ciclului |
| `maxActionsPerCycle` | 2 | 1-5 | câte acțiuni poate propune |
| `maxConcurrentBots` | 2 | 1-10 | câți boți gestionează |
| `budgetPerBotUSDT` | 20 | 5-1000 | marjă maximă per grid |
| `minReserveUSDT` | 10 | 0-10000 | cash care nu se atinge |
| `maxLeverage` | 5 | 1-20 | plafon levier |
| `minSuitabilityScore` | 70 | 30-98 | prag eligibilitate |
| `minNetProfitPerGridPct` | 0.05 | 0.01-5 | profit net minim per grilă |
| `cooldownMinutesPerSymbol` | 30 | 0-1440 | pauză după deschidere pe simbol |
| `dailyLossLimitUSDT` | 25 | 0-100000 | blocaj la pierdere pe sesiune |
| `maxOpportunitiesInPrompt` | 12 | 3-30 | câți candidați intră în prompt |
| `allowedSymbols` / `blockedSymbols` | `[]` | — | white/blacklist |
| `allowOpenBots` / `allowStopBots` / `allowAmendBots` | `true` | bool | ce tipuri de acțiuni sunt permise |
| `scanBeforeDecision` | `true` | bool | re-scan înainte de decizie |
| `notifyTelegram` | `true` | bool | trimite deciziile pe Telegram |
| `fallbackEnabled` | `true` | bool | permite `LOCAL_FALLBACK` |
| `enforceHardGuardrails` | `true` | bool | activează §5.5 |
| `hardStopLossPct` | 12 | 2-60 | guardrail SL (% din marjă) |
| `hardMinLiqDistancePct` | 12 | 3-60 | guardrail distanță lichidare |
| `hardMaxNoFillMinutes` | 180 | 15-1440 | guardrail „0 arbitraje” |

Contoare read-only: `totalCycles`, `totalActionsExecuted`, `totalErrors`, `consecutiveErrors`, `symbolCooldowns`, `lastDecisionAt`, `lastError`.

---

## 9. API (Express, port 3000)

Autentificare rute de control: header `x-bot-token: <BOT_CONTROL_TOKEN>` (sau `Authorization: Bearer …`, sau `?token=`). Request-urile de pe loopback sunt permise în dev. Lista completă: `server.ts`.

| Grup | Endpoint |
|---|---|
| Sănătate / stare | `GET /api/health`, `GET /api/bot/status`, `GET /api/bot/logs`, `GET /api/bot/orders` |
| Mod & siguranță | `GET/POST /api/bot/mode`, `POST /api/bot/kill-switch`, `POST /api/bot/killswitch`, `POST /api/bot/paper-reset`, `POST /api/bot/credentials`, `POST /api/bot/okx/test-connection` |
| Grid TB5 | `GET /api/bot/grid/bots`, `POST /api/bot/grid/optimize`, `POST /api/bot/grid/create`, `POST /api/bot/grid/:botId/stop`, `POST /api/bot/grid/:botId/risk`, `DELETE /api/bot/grid/:botId`, `GET/POST /api/bot/grid/autopilot`, `POST /api/bot/grid/autopilot/run-now` |
| Grid nativ OKX | `GET /api/bot/native-grid/status`, `POST …/scan`, `GET …/universe`, `POST …/analyze-symbol`, `POST …/min-investment`, `POST …/create`, `POST …/:algoId/amend`, `POST …/:algoId/stop`, `POST …/:algoId/close-position`, `POST …/:algoId/delete`, `POST …/clear-stopped`, `POST …/sync`, `POST …/autopilot`, `GET …/analyzer`, `POST …/analyzer/thresholds`, `POST …/analyzer/evaluate` |
| **Agent AI** | `GET /api/bot/agent/status?limit=`, `POST /api/bot/agent/config`, `POST /api/bot/agent/api-key`, `POST /api/bot/agent/run`, `GET /api/bot/agent/decisions`, `POST /api/bot/agent/stop` |
| Scanner | `GET /api/bot/scanner`, `POST /api/bot/scanner/scan`, `POST /api/bot/scanner/config`, `GET /api/bot/symbols`, `GET /api/bot/sentiment` |
| Fiscal | `GET /api/bot/fiscal/report`, `POST /api/bot/fiscal/sync`, `POST /api/bot/fiscal/upload-csv`, `GET /api/bot/fiscal/export-csv` |
| Research | `GET /api/research/grid`, `GET /api/research/grid/status` |
| Telegram | `GET /api/bot/telegram/status`, `POST …/test`, `POST …/toggle`, `POST …/config` |

Exemplu ciclu manual (ruta nu are body — pornește mereu cu `trigger: MANUAL`):

```bash
curl -X POST http://localhost:3000/api/bot/agent/run \
  -H "x-bot-token: $BOT_CONTROL_TOKEN"
```

---

## 10. Telegram

Polling (`getUpdates`, ~3.5 s); chat ID se auto-împerechează la primul mesaj. Comenzile reale:

| Comandă | Efect |
|---|---|
| `/portofoliu`, `/portofolio` | capital, equity, PnL |
| `/stare`, `/status` | stare sistem, mod, circuit breaker |
| `/pozitii`, `/positions` | poziții deschise + PnL |
| `/jurnal`, `/tranzactii` | istoric recent |
| `/mute`, `/silence`, `/noapte`, `/oprire` | oprește alertele/rapoartele |
| `/unmute`, `/pornire`, `/activeaza`, `/sunet`, `/activ` | repornește alertele |
| `/mod`, `/mode` (`paper` / `testnet` / `live`) | vede/schimbă modul |
| `/pauza`, `/pause` | oprește tranzacționarea automată |
| `/porneste`, `/resume` | reia tranzacționarea automată |
| `/cumpara`, `/buy` `SIMBOL CANTITATE` | cumpărare manuală |
| `/vinde`, `/sell` `SIMBOL CANTITATE` | vânzare manuală |
| `/ajutor`, `/help`, `/comenzi`, `/ghid`, `/start` | ghidul de comenzi |

---

## 11. Date pe disc și secrete

Tot ce e runtime stă în **`.data/`** (gitignored, niciodată commit-at):

| Fișier | Conținut |
|---|---|
| `config.json` | config TradeBot (mod, kill switches, chei OKX, profil, scanner) |
| `okx_credentials.json` | chei OKX + `testnet` + regiune |
| `paper_account.json` | contul virtual PAPER |
| `orders.json`, `positions.json`, `audit.json` | execuții, poziții, audit |
| `grid_bots.json`, `native_grid_bots.json`, `native_grid_autopilot.json`, `native_grid_dismissed.json` | boți + autopilot |
| `grid_analyzer_thresholds.json`, `grid_arbitrages.json`, `grid_analyzer_events.json` | praguri + istoric analiză |
| `deepseek_agent_config.json` | config + contoare agent |
| `deepseek_credentials.json` | cheia DeepSeek (alternativă: `DEEPSEEK_API_KEY`) |
| `deepseek_agent_decisions.json` | ultimele 100 decizii |
| `imported_okx_transactions.json`, `okx_synced_transactions.json` | date fiscale |

`.gitignore` blochează: `.data/`, `data/`, `.env*` (cu excepția `.env.example`), `.telegram*.json`, `*.zip`, `*.patch`, `*.tar.gz`, `public/*.zip`, binare, `.vscode/`.

---

## 12. Teste, lint, build

```bash
npm run lint   # tsc --noEmit
npm test       # grid optimizer + research/backtest + DeepSeek agent (offline, fara retea)
npm run build
```

`npm test` acoperă: optimizer/risk grid (`gridOptimizer.test.ts`), backtest + pattern miner + walk-forward (`gridBacktest.test.ts`), respectiv modurile agentului, validatorul de execuție, guardrails și clamparea configului (`deepSeekAgent.test.ts`).

---

## 13. Deploy & operare

**Starea actuală: deploy automat OPRIT.** În `.github/workflows/deploy.yml` blocul `push:` este comentat (serverul OCI a fost șters la 2026-11-01), deci:

- un push pe `main` **nu** mai deployează și **nu** mai repornește nimic;
- `workflow_dispatch` (Actions → *Deploy to OCI* → Run workflow) rămâne disponibil, dar **eșuează la SSH** până când `OCI_HOST` nu e valid.

Workflow-ul (când e reactivat) face, pe server, în `/home/ubuntu/AutoTrade-v5`:

1. verifică arborele git curat (abort la modificări locale),
2. backup `git bundle` + arhivă `dist/` + `version.meta` (permisiuni 600),
3. `git fetch` + `git reset --hard origin/main`,
4. `npm ci` → `npm run lint` → `npm test` → `npm run build` (**orice eșec → rollback automat**),
5. `systemctl restart autotrade-v5.service`,
6. poll `http://localhost:3000/api/health` (10 × 3 s) — fără 200 → rollback.

Concurrency `deploy-oci-main` cu `cancel-in-progress: false` — deploy-urile nu se suprapun niciodată.

**Ca să reiei deploy-ul după ce provizionezi un server nou:**

1. decomentează blocul `push:` din `deploy.yml`,
2. actualizează secretele GitHub: `OCI_HOST`, `OCI_USER`, `OCI_SSH_KEY`,
3. creează `/home/ubuntu/AutoTrade-v5` + unitatea `autotrade-v5.service`,
4. pune `BOT_CONTROL_TOKEN` + `.env` pe server (**nu** în git).

---

## 14. Troubleshooting

| Simptom | Cauză | Fix |
|---|---|---|
| Agentul nu deschide nimic, doar `HOLD` | mod `OFF`/`ADVISOR` (dry-run), praguri prea sus, sau cont PAPER | citește respingerile din jurnal; treci pe `AUTONOMOUS` + `LIVE` |
| Banner `CONFLICT DE AUTORITATE` | Autopilot nativ OKX activ | oprește Autopilot-ul din tab 1/5 (un singur trader automat o dată) |
| `ENGINE: LOCAL_FALLBACK` | lipsă cheie DeepSeek sau eroare API | salvează cheia în tab 5 sau tab 8; verifică `Ultima eroare inregistrata` |
| „Cheile API OKX nu sunt configurate.” | credențiale lipsă | tab 5 → salvează + Test conexiune |
| „Modul de execuție este PAPER…” | gridul nativ cere LIVE | treci pe LIVE (asumat) sau rămâi pe grid TB5 în PAPER |
| `401` pe rute de control | token lipsă/greșit | trimite `x-bot-token` = `BOT_CONTROL_TOKEN` |
| `50124` / erori OKX la poziții | diferențe demo vs live | verifică flag-ul **OKX Demo** din tab 5 și modul de execuție |
| Health check roșu după deploy | build/service picat | workflow-ul face rollback automat; verifică `journalctl -u autotrade-v5` |

---

## 15. Securitate

- `BOT_CONTROL_TOKEN` obligatoriu în producție; altfel se generează un token aleator la fiecare pornire (și îl pierzi la restart).
- Cheile stau doar în `.data/` (gitignored) sau în variabile de environment. Sunt mascate în UI și nu apar niciodată complet în loguri.
- Comparație de token în timp constant (`crypto.timingSafeEqual`).
- Chei OKX recomandate: **fără permisiune de withdraw**, IP whitelist.
- Push-ul pe `main` este o acțiune de producție: nu se urcă build spart, nu se forțează istoricul.

---

## 16. Licență

Proprietary Algorithmic Trading Software. All rights reserved.
