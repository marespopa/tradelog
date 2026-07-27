import { getCandleCacheStore } from "./tauriStore.js";
import { fetchCandleHistory } from "./analysis/okx.js";

// Bar duration in ms per timeframe — a cached read is only as stale as the
// newest bar it's missing, so the cache is valid until a new bar of that
// timeframe would exist, not for some arbitrary fixed window.
const BAR_MS = { "15m": 9e5, "1h": 3.6e6, "4h": 1.44e7, "1d": 8.64e7, "1w": 6.048e8 };

function cacheKey(symbol, timeframe, totalBars) {
  return `${symbol.toUpperCase()}-${timeframe}-${totalBars}`;
}

// Strategy backtests/signal checks re-request the same symbol/timeframe/bar
// count repeatedly (re-running a backtest, checking a live signal right
// after) — each one previously re-paginated the full OKX history-candles
// fetch from scratch. Persisted to its own disk file (see
// tauriStore.js's getCandleCacheStore) so it survives reloads, not just an
// in-memory cache for the session.
export async function getCachedCandles(symbol, timeframe, totalBars) {
  const key = cacheKey(symbol, timeframe, totalBars);
  const barMs = BAR_MS[timeframe];

  // The disk cache is a best-effort speedup, not the source of truth — if
  // it's unavailable for any reason (store backend missing, disk error),
  // fall back to a direct fetch rather than failing the whole backtest.
  try {
    const store = await getCandleCacheStore();
    const cache = (await store.get("entries")) ?? {};
    const entry = cache[key];
    if (entry && barMs && Date.now() - entry.fetchedAt < barMs) {
      return entry.candles;
    }

    const candles = await fetchCandleHistory(symbol, timeframe, totalBars);
    cache[key] = { candles, fetchedAt: Date.now() };
    store.set("entries", cache);
    store.save();
    return candles;
  } catch {
    return fetchCandleHistory(symbol, timeframe, totalBars);
  }
}
