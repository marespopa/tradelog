import { useQuery } from "@tanstack/react-query";
import { fetchCandles, fetchTopVolumeTickers, scanInBatches } from "../lib/analysis/okx.js";
import { computeBetaAlpha, buildBetaNeutralBasket } from "../lib/analysis/betaNeutral.js";
import { mtfRegime } from "../lib/analysis/mtfSetup.js";

const CANDIDATE_COUNT = 40;
const LOOKBACK_DAYS = 60;
const LONG_COUNT = 5;
const SHORT_COUNT = 5;

// Live beta-neutral long/short basket (see betaNeutral.js): ranks the
// top-volume market by alpha vs BTC over a 60-day lookback, vetoes any
// candidate whose Weekly+Daily trend regime (mtfSetup.js's mtfRegime)
// actively disagrees with the leg direction, then sizes the short leg's
// notional so aggregate long/short beta cancel by construction — see
// scripts/backtest-beta-neutral.js for the walk-forward validation this is
// based on. Refreshed on the same slow cadence as useMarketBias (15 min)
// since alpha/beta/regime are all daily-or-slower signals, unlike the 4H
// entry scan's 2-minute cadence.
export function useHedgedBasket(candidateCount = CANDIDATE_COUNT, enabled = true) {
  return useQuery({
    queryKey: ["hedged-basket", candidateCount],
    queryFn: async () => {
      const tickers = await fetchTopVolumeTickers(candidateCount);
      const candidates = tickers.map((t) => t.symbol).filter((s) => s !== "BTC");

      const btcDaily = await fetchCandles("BTC", "1d", LOOKBACK_DAYS + 1);
      const btcCloses = btcDaily.map((c) => c.close);

      const scanned = await scanInBatches(candidates, async (symbol) => {
        const daily = await fetchCandles(symbol, "1d", 250);
        const coinCloses = daily.map((c) => c.close).slice(-btcCloses.length);
        const ba = computeBetaAlpha(coinCloses, btcCloses);
        if (!ba) return null;
        return { symbol, ...ba, regime: mtfRegime(daily), price: daily.at(-1)?.close };
      });

      const rows = scanned.filter((r) => r.status === "fulfilled" && r.value != null).map((r) => r.value);
      const regimeBySymbol = Object.fromEntries(rows.map((r) => [r.symbol, r.regime]));
      return buildBetaNeutralBasket(rows, { longCount: LONG_COUNT, shortCount: SHORT_COUNT, regimeBySymbol });
    },
    enabled,
    staleTime: 15 * 60_000,
    refetchInterval: 15 * 60_000,
    retry: 1,
  });
}
