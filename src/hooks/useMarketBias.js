import { useQuery } from "@tanstack/react-query";
import { fetchCandles, fetchTopVolumeTickers, scanInBatches } from "../lib/analysis/krakenSpot.js";
import { weeklyBias, dailyTrend } from "../lib/analysis/mtfSetup.js";
import { changeOverBars } from "../lib/analysis/ta.js";

// Weekly bias + Daily trend for each top-volume symbol — the two slower
// tiers of the Weekly->Daily->4H setup (mtfSetup.js). Deliberately a
// separate hook/query from useSetupFinder's 4H trigger scan: higher-
// timeframe structure doesn't meaningfully change within a couple of
// minutes, so this refreshes on a much slower cadence, keeping steady-state
// Kraken request volume close to today's single-4H-fetch baseline instead of
// tripling it if all three timeframes were fetched on the fast cadence.
// Returns a Map keyed by symbol so callers (MarketPanel, WatchlistPanel) can
// do an O(1) join against useSetupFinder's per-symbol rows.
export function useMarketBias(limit = 100, enabled = true) {
  return useQuery({
    queryKey: ["market-bias", limit],
    queryFn: async () => {
      const tickers = await fetchTopVolumeTickers(limit);
      const results = await scanInBatches(tickers, async (ticker) => {
        const [weekly, daily] = await Promise.all([fetchCandles(ticker.symbol, "1w", 104), fetchCandles(ticker.symbol, "1d", 250)]);
        return {
          symbol: ticker.symbol,
          weeklyBias: weeklyBias(weekly),
          dailyTrend: dailyTrend(daily),
          // Free to compute — piggybacks on the weekly candles already
          // fetched for weeklyBias, no extra request.
          changePct1w: changeOverBars(weekly.map((c) => c.close), 1),
        };
      });
      const bySymbol = new Map();
      for (const r of results) {
        if (r.status === "fulfilled") bySymbol.set(r.value.symbol, r.value);
      }
      return bySymbol;
    },
    enabled,
    staleTime: 30 * 60_000,
    refetchInterval: 30 * 60_000,
    retry: 1,
  });
}
