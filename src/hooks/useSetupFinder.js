import { useQuery } from "@tanstack/react-query";
import { fetchCandles, fetchTopVolumeTickers, scanInBatches } from "../lib/analysis/krakenSpot.js";
import { fetchPerpetualSwapSymbols, isShortable } from "../lib/analysis/krakenFutures.js";
import { analyzeCandles, changeOverBars } from "../lib/analysis/ta.js";
import { find4hTrigger, hourlyTrend, MTF_HOURLY_WARMUP_BARS } from "../lib/analysis/mtfSetup.js";

// Scans the top-volume symbols on 4H structure (the swing-trade horizon this
// scan targets) and returns whichever analyses succeeded — one bad/missing
// pair (fetchCandles throwing) shouldn't sink the whole scan. The ticker's
// 24h change rides along as a neutral market stat, not part of the analysis
// model.
//
// Each row also reports fourHTrigger: whether *today's* 4H bar shows a pin
// bar / engulfing / inside-bar-breakout at a tested S/R level, checked in
// both directions independently of any higher-timeframe bias (this hook has
// no Weekly/Daily data — that lives in useMarketBias, refreshed on its own
// slower cadence). Whether that trigger amounts to a live 3-tier entry is
// decided by the caller, which joins this against useMarketBias by symbol.
//
// Also reports shortable: Kraken spot has no short mechanism at all —
// shorting only happens via a symbol's Kraken Futures perpetual (see
// krakenFutures.js's isShortable). attachEntry() uses this to veto a
// "short" entry on a spot-only symbol — a symbol can rank fine on
// trend/trigger but have no matching PF_ perpetual listing, so a live short
// signal on it would be a trade the user can't actually place.
export function useSetupFinder(limit = 100, enabled = true) {
  return useQuery({
    queryKey: ["setup-finder", limit],
    queryFn: async () => {
      const [tickers, perpSymbols] = await Promise.all([fetchTopVolumeTickers(limit), fetchPerpetualSwapSymbols()]);
      const results = await scanInBatches(tickers, async (ticker) => {
        const candles = await fetchCandles(ticker.symbol, "4h", 220);
        // Sequential (not Promise.all'd with the 4H fetch above) so each
        // scanned symbol still has only one request in flight at a time —
        // scanInBatches' own batching is what keeps total concurrency under
        // Kraken's rate limit, and firing these two in parallel per symbol
        // would triple that concurrent count.
        const hourlyCandles = await fetchCandles(ticker.symbol, "1h", MTF_HOURLY_WARMUP_BARS);
        const fifteenMinCandles = await fetchCandles(ticker.symbol, "15m", 2);
        const fourHTrigger = find4hTrigger(candles, "bullish") ?? find4hTrigger(candles, "bearish");
        return {
          ...analyzeCandles(candles, ticker.symbol),
          changePct24h: ticker.changePct24h,
          changePct4h: changeOverBars(candles.map((c) => c.close), 1),
          changePct1h: changeOverBars(hourlyCandles.map((c) => c.close), 1),
          changePct15m: changeOverBars(fifteenMinCandles.map((c) => c.close), 1),
          hourlyTrend: hourlyTrend(hourlyCandles),
          fourHTrigger,
          shortable: isShortable(ticker.symbol, perpSymbols),
        };
      });
      return results.filter((r) => r.status === "fulfilled").map((r) => r.value);
    },
    enabled,
    staleTime: 60_000,
    refetchInterval: 120_000,
    retry: 1,
  });
}
