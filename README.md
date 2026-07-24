# Market Scanner

A quant-style trend/setup scanner for the top-volume crypto pairs, with a per-symbol drill-down chart/analysis, a watchlist, and a manual trade journal.

## How it works

This is a pure client-side app — there is no backend. Market/price data comes from OKX's public API (spot tickers/candles), with GeckoTerminal on-chain data as a fallback in the Analysis view for symbols OKX doesn't list. Watchlist and trade-journal entries are persisted in `localStorage`, so they survive reloads without needing a backend.

## Setup

```bash
npm install
npm run dev
```

## Features

- **Scan** — scans top-volume pairs on 4H structure (trend, RSI, z-score, relative volume, ATR%, 24h change). Click a row to drill into Analysis.
- **Watchlist** — star coins from the scan or analysis page to track them here. Watched pairs inside the top-volume scan show the full scan stats; pairs outside it (low-volume/illiquid) still get their live OKX price fetched directly, in their own table below.
- **Analysis** — a per-symbol trend/RSI/setup narrative with a live chart and timeframe switcher (15m–1W). Falls back to GeckoTerminal on-chain data for symbols OKX doesn't list.
- **Trades** — a manual trade journal (entry/exit, side, leverage, stop/target, R multiple, notes). Trades can be logged while still open and closed out later; shows a recent-result card and win-streak over the last 4 closed trades.

## Scripts

- `scripts/log-trade.js SYMBOL [long|short] [notes...]` — appends a row to `journal.csv` with the symbol's current 4H stats (price, z-score, RSI, ATR%, trend) at the time it's run. Direction is inferred from the z-score if omitted.
- `scripts/backtest-*.js` — standalone backtests (run with `node scripts/<name>.js`) for the setups the app's live analysis is based on: the four candidate 4H setups (`backtest-all-setups.js`), the FXNX 4H swing strategy in-sample and out-of-sample (`backtest-fxnx-swing.js` / `backtest-fxnx-oos.js`), z-score mean-reversion (`backtest-zscore-reversion.js`), the neckline breakout/reclaim setup (`backtest-neckline.js`), and a beta-neutral long/short basket (`backtest-beta-neutral.js`).
