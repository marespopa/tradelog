import { useQuery } from "@tanstack/react-query";
import { fetchCandles, fetchTicker24h } from "../lib/analysis/okx.js";
import { analyzeCandles } from "../lib/analysis/ta.js";

export function useCoinAnalysis(symbol, timeframe) {
  return useQuery({
    queryKey: ["coin-analysis", symbol, timeframe],
    queryFn: async () => {
      const candles = await fetchCandles(symbol, timeframe);
      const ticker = await fetchTicker24h(symbol).catch(() => null);
      return { candles, ticker, analysis: analyzeCandles(candles, symbol) };
    },
    enabled: !!symbol,
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: 1,
  });
}
