import { load } from "@tauri-apps/plugin-store";

let storePromise = null;

// Single on-disk store shared by useWatchlist/useStrategies/usePortfolio/
// useGeminiChat, so each hook reads/writes the same app-data.json file
// instead of opening one each.
export function getStore() {
  if (!storePromise) storePromise = load("app-data.json", { autoSave: false });
  return storePromise;
}

let candleCacheStorePromise = null;

// Separate file from app-data.json: cached OHLC history (candleCache.js)
// is orders of magnitude larger than watchlist/strategies/portfolio, so it
// shouldn't slow down every read/write of the small stuff by sharing a file.
export function getCandleCacheStore() {
  if (!candleCacheStorePromise) candleCacheStorePromise = load("candle-cache.json", { autoSave: false });
  return candleCacheStorePromise;
}
