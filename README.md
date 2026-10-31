# TradeBot v5.0 Pro // Bloomberg-Style Algorithmic Trading Terminal

**TradeBot v5.0 Pro** is a high-performance, professional algorithmic trading platform and Bloomberg Terminal-styled web application built for **OKX USDT SWAP Perpetuals**. It features real-time WebSocket market data ingestion, a multi-factor Dynamic Universe & Market Scanner, a robust Momentum Engine supporting dual-profile execution (**SCALP** and **MOMENTUM**), comprehensive risk management with equity protection and trailing drawdowns, and seamless **Telegram Bot integration** for remote monitoring and command execution.

---

## 🌟 Key Architecture & Capabilities

### 1. Bloomberg Terminal Interface (`F1` to `F6`)
* **`F1: DASHBOARD`**: Live portfolio overview, PnL metrics, active positions, equity curves, and quick trade controls.
* **`F2: POSITIONS & EXPOSURE`**: Detailed open positions with real-time unrealized PnL, leverage, entry prices, and trailing stop statuses.
* **`F3: BLOTTER & ORDERS`**: Comprehensive order execution log (up to 1,000 recent records) with sticky table headers, expandable execution logs, and filterable history.
* **`F4: MARKET SCANNER`**: Dynamic OKX Universe discovery, 24h volume filters, relative volume (`RVOL`) calculation, and multi-factor momentum scoring (0-100).
* **`F5: SETTINGS & RISK`**: Interactive sliders for risk per trade, max open positions, hard stop-loss, trailing activation/distance, break-even, take-profit, max holding time, equity protection, and global sentiment alert thresholds. Includes the **OKX Connection & Execution Mode Desk**.
* **`F6: TELEGRAM & BOT HUB`**: Live bot operational status, Telegram integration overview, webhook status, and alert logs.

### 2. Multi-Mode Execution Engine
* **🟢 PAPER (Simulation)**: Zero financial risk. Runs locally with $200.00 virtual USDT capital, real-time OKX orderbook feeds, simulated 0.05% fees, and dynamic slippage modeling.
* **🟡 OKX TESTNET (Demo)**: Direct API connection to OKX Simulated Trading environment (using `x-simulated-trading: 1` headers) for risk-free testing with simulated exchange funds.
* **🔴 OKX LIVE (Real Capital)**: Full live trading execution on OKX USDT SWAP Perpetuals with real capital. Includes mandatory safety disclaimers and position safeguards.

### 3. Risk Management & Guardrails
* **Hard Stop-Loss & Trailing Stops**: Automated position protection with configurable trailing activation and distance.
* **Break-Even & Take-Profit**: Automatic stop adjustments upon reaching profit targets.
* **Equity Protection & Trailing Drawdown**: Global portfolio protection that halts trading and triggers emergency liquidations if portfolio drawdown limits are breached.
* **Kill Switch**: Instant manual or automated shutdown button that neutralizes all active positions and pauses trading.

### 4. Telegram Bot Integration
* **Remote Commands**: Control and monitor the bot directly via Telegram (`/status`, `/report`, `/scan`, `/mod`, `/kill`, `/resume`).
* **Clean Event Notifications**: Hourly/daily performance summaries, critical safety alerts, and manual command replies (trade execution alerts are suppressed to keep the channel clean and focused on reports).

---

## 🛠️ Technology Stack

* **Frontend**: React 18, TypeScript, Tailwind CSS, Lucide React Icons, Vite.
* **Backend**: Node.js, Express, TypeScript, native WebSocket client for OKX v5 Public/Private channels.
* **Build System**: Vite + Esbuild production bundling (`dist/server.cjs`).

---

## 🚀 Getting Started & Installation

1. **Clone and Install Dependencies**:
   ```bash
   git clone <repository-url>
   cd tradebot-pro
   npm install
   ```

2. **Configure Environment Variables**:
   Create a `.env` file in the root directory based on `.env.example`:
   ```env
   OKX_API_KEY=your_okx_api_key
   OKX_SECRET_KEY=your_okx_secret_key
   OKX_PASSPHRASE=your_okx_passphrase
   TELEGRAM_BOT_TOKEN=your_telegram_bot_token
   TELEGRAM_CHAT_ID=your_telegram_chat_id
   ```

3. **Run Development Server**:
   ```bash
   npm run dev
   ```
   The application will be accessible at `http://localhost:3000`.

4. **Build for Production**:
   ```bash
   npm run build
   npm start
   ```

---

## 📄 License

Proprietary Algorithmic Trading Software. All rights reserved.
