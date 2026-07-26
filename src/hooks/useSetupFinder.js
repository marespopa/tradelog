import { useQuery } from "@tanstack/react-query";
import { fetchCandles, fetchTopVolumeTickers, fetchPerpetualSwapSymbols, isShortable, scanInBatches } from "../lib/analysis/okx.js";
import { analyzeCandles } from "../lib/analysis/ta.js";
import { find4hTrigger } from "../lib/analysis/mtfSetup.js";

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
// Also reports shortable: OKX spot has no short mechanism at all — shorting
// only happens via a symbol's perpetual swap (see okx.js's isShortable).
// attachEntry() uses this to veto a "short" entry on a spot-only symbol
// (SATS, for example, ranks fine on trend/trigger but has no -USDT-SWAP
// listing, so a live short signal on it would be a trade the user can't
// actually place).
export function useSetupFinder(limit = 100, enabled = true) {
  return useQuery({
    queryKey: ["setup-finder", limit],
    queryFn: async () => {
      const [tickers, perpSymbols] = await Promise.all([fetchTopVolumeTickers(limit), fetchPerpetualSwapSymbols()]);
      const results = await scanInBatches(tickers, async (ticker) => {
        const candles = await fetchCandles(ticker.symbol, "4h", 220);
        const fourHTrigger = find4hTrigger(candles, "bullish") ?? find4hTrigger(candles, "bearish");
        return {
          ...analyzeCandles(candles, ticker.symbol),
          changePct24h: ticker.changePct24h,
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
