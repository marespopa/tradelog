import { getCandleCacheStore } from "./tauriStore.js";
import { fetchFearGreedHistory } from "./analysis/fearGreed.js";

// Fear & Greed publishes at most once/day, so a cache good for a few hours
// is plenty — refetching on every backtest run would be pure waste. Shares
// candle-cache.json's store file (this history is a few thousand small
// entries, orders of magnitude smaller than cached OHLC, so it doesn't
// warrant its own store file) under its own top-level key.
const REFRESH_MS = 6 * 3600_000;

export async function getCachedFearGreedHistory() {
  try {
    const store = await getCandleCacheStore();
    const cached = await store.get("fearGreed");
    if (cached && Date.now() - cached.fetchedAt < REFRESH_MS) return cached.history;

    const history = await fetchFearGreedHistory();
    store.set("fearGreed", { history, fetchedAt: Date.now() });
    store.save();
    return history;
  } catch {
    return fetchFearGreedHistory();
  }
}
