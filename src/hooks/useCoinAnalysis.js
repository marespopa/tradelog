import { useQuery } from "@tanstack/react-query";
import { fetchCandles, fetchTicker24h } from "../lib/analysis/okx.js";
import { fetchCandlesGeckoTerminal } from "../lib/analysis/geckoterminal.js";
import { analyzeCandles } from "../lib/analysis/ta.js";

export function useCoinAnalysis(symbol, timeframe) {
  return useQuery({
    queryKey: ["coin-analysis", symbol, timeframe],
    queryFn: async () => {
      // OKX only covers tokens listed on a centralized exchange — most small
      // Arbitrum tokens aren't, so fall back to on-chain DEX pool data.
      const candles = await fetchCandles(symbol, timeframe).catch(() =>
        fetchCandlesGeckoTerminal(symbol, timeframe)
      );
      // Liquidity context only exists for OKX-listed symbols — null (not a
      // thrown error) for GeckoTerminal-sourced tokens so the UI can just
      // omit the stat instead of treating it as a failed fetch.
      const ticker = await fetchTicker24h(symbol).catch(() => null);
      return { candles, ticker, analysis: analyzeCandles(candles, symbol) };
    },
    enabled: !!symbol,
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: 1,
  });
}
