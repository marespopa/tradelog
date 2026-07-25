# Market Scanner

A quant-style trend/setup scanner for the top-volume crypto pairs, with a per-symbol drill-down chart/analysis, a watchlist, and a manual trade journal.

## How it works

This is a pure client-side app — there is no backend. Market/price data comes from OKX's public API (spot tickers/candles); only symbols listed on OKX are shown. It ships as a Tauri desktop app; trades and the watchlist are persisted to a JSON file in the OS app-data directory (via the Tauri store plugin), so they survive restarts without needing a backend.

## Setup

```bash
npm install
npm run dev
```

## Desktop app (Tauri)

Prerequisites: [Rust](https://rustup.rs) and, on Windows, the MSVC C++ Build Tools ("Desktop development with C++" workload in Visual Studio Build Tools).

```bash
npm run tauri:dev    # launch the desktop app in development
npm run tauri:build  # produce an installer under src-tauri/target/release/bundle/
```

## Features

- **Scan** — scans top-volume pairs on 4H structure (trend, RSI, z-score, relative volume, ATR%, 24h change). Click a row to drill into Analysis.
- **Watchlist** — star coins from the scan or analysis page to track them here. Watched pairs inside the top-volume scan show the full scan stats; pairs outside it (low-volume/illiquid) still get their live OKX price fetched directly, in their own table below.
- **Analysis** — a per-symbol trend/RSI/setup narrative with a live chart and timeframe switcher (15m–1W), for any symbol listed on OKX.
- **Trades** — a manual trade journal (entry/exit, side, leverage, stop/target). Trades can be logged while still open and closed out later; the result (win/loss and R multiple, when a stop loss is set) is calculated automatically from entry/exit rather than entered by hand.

## Scripts

- `scripts/log-trade.js SYMBOL [long|short] [notes...]` — appends a row to `journal.csv` with the symbol's current 4H stats (price, z-score, RSI, ATR%, trend) at the time it's run. Direction is inferred from the z-score if omitted.
- `scripts/backtest-*.js` — standalone backtests (run with `node scripts/<name>.js`) for the setups the app's live analysis is based on: the four candidate 4H setups (`backtest-all-setups.js`), the FXNX 4H swing strategy in-sample and out-of-sample (`backtest-fxnx-swing.js` / `backtest-fxnx-oos.js`), z-score mean-reversion (`backtest-zscore-reversion.js`), the neckline breakout/reclaim setup (`backtest-neckline.js`), and a beta-neutral long/short basket (`backtest-beta-neutral.js`).
