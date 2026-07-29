import { useQuery } from "@tanstack/react-query";
import { fetchTickerPrice, scanInBatches } from "../lib/analysis/krakenSpot.js";

// Live Kraken price per symbol, for places that need a real market value for
// symbols that don't ride along with another fetch — watched pairs outside
// the top-volume scan (e.g. low-volume pairs like BARD) and open positions in
// the trade journal both need this same direct per-symbol lookup.
export function useLivePrices(symbols) {
  return useQuery({
    queryKey: ["live-prices", symbols],
    queryFn: async () => {
      const results = await scanInBatches(symbols, async (symbol) => ({
        symbol,
        price: await fetchTickerPrice(symbol),
      }));
      const map = new Map();
      for (const r of results) {
        if (r.status === "fulfilled") map.set(r.value.symbol, r.value.price);
      }
      return map;
    },
    enabled: symbols.length > 0,
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: 1,
  });
}
