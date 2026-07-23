# Market Scanner

A quant-style trend/setup scanner for the top-volume crypto pairs, with a per-symbol drill-down chart and analysis, plus a wallet tab to act on it directly.

## How it works

This is a pure client-side app — there is no backend. Market/price data comes from OKX's public API, with GeckoTerminal on-chain data as a fallback for symbols OKX doesn't list. Wallet connection goes through MetaMask's own "MetaMask Connect" SDK (via wagmi), which auto-detects the right method — a desktop browser extension, its own QR code, or a mobile deeplink — with no separate WalletConnect/Reown project ID needed. Swaps are quoted and executed through 0x's Swap API (AllowanceHolder flow). Because there's no backend to proxy it, the 0x API key ships in the client bundle — see `.env.example` for the tradeoff.

## Setup

```bash
npm install
cp .env.example .env   # add your 0x API key to use the Wallet tab's swap feature
npm run dev
```

## Features

- **Scan** — scans top-volume pairs across daily/weekly structure (trend, RSI, z-score, relative volume, ATR).
- **Analysis** — click a row to drill into a per-symbol trend/RSI/setup narrative with a live chart, timeframe switcher, and a position-sizing calculator. A "Buy" button jumps straight to the Wallet tab with that token pre-selected.
- **Wallet** — connect MetaMask (extension, QR, or mobile deeplink — auto-detected), view native + tracked-token balances across 5 chains (Ethereum, Arbitrum, Base, Optimism, Polygon), and swap via 0x. Approvals default to the exact amount needed, not infinite; the Swap button is hard-disabled if your wallet's connected network doesn't match the one selected in the app.
