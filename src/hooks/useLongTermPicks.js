import { useQuery } from "@tanstack/react-query";
import { fetchCandles, fetchTopVolumeTickers, scanInBatches } from "../lib/analysis/okx.js";
import { computeBetaAlpha, computeExtension } from "../lib/analysis/betaNeutral.js";
import { weeklyBias, dailyTrend } from "../lib/analysis/mtfSetup.js";
import { buildWeeklyCandles } from "../lib/analysis/timeframes.js";

const CANDIDATE_COUNT = 80;
// Same daily-bar count useHedgedBasket used for mtfRegime — long enough for
// the weekly EMA10/20 resample to have settled. Also the window
// computeExtension checks "already extended" against here, so a position-
// trade candidate is judged against ~8 months of range, not 4H noise —
// appropriate for a hold measured in months rather than hours.
const DAILY_LOOKBACK_BARS = 250;
// Quality floor on alpha vs BTC over that same window: a coin that's merely
// tracking BTC isn't worth tying up capital in for a month-plus over just
// holding BTC itself. Not tuned/backtested standalone — same caveat as
// betaNeutral.js's construction (this reuses its computeBetaAlpha/
// computeExtension primitives, just against daily bars and a long-only
// filter instead of a long/short basket).
const MIN_ALPHA = 0.05;
const RESULT_COUNT = 15;

// Long-only, position-trade (think 1-month-minimum hold, not a swing entry)
// candidates: Weekly bias and Daily trend must agree bullish — a slow,
// persistent read appropriate for a hold this long, unlike the Scan tab's
// 4H entry timing — the coin must be beating BTC on a risk-adjusted basis
// (alpha, not just raw price change) rather than just riding the market up,
// and it can't already be extended (overbought / near the top of its own
// regression channel) — chasing a stretched coin into a month-long hold is
// a worse entry than waiting for a pullback.
export function useLongTermPicks(candidateCount = CANDIDATE_COUNT, enabled = true) {
  return useQuery({
    queryKey: ["long-term-picks", candidateCount],
    queryFn: async () => {
      const tickers = await fetchTopVolumeTickers(candidateCount);
      const candidates = tickers.filter((t) => t.symbol !== "BTC");

      const btcDaily = await fetchCandles("BTC", "1d", DAILY_LOOKBACK_BARS + 1);
      const btcCloses = btcDaily.map((c) => c.close);

      const scanned = await scanInBatches(candidates, async (ticker) => {
        const daily = await fetchCandles(ticker.symbol, "1d", DAILY_LOOKBACK_BARS);
        const coinCloses = daily.map((c) => c.close).slice(-btcCloses.length);
        const ba = computeBetaAlpha(coinCloses, btcCloses);
        if (!ba) return null;

        const weekly = weeklyBias(buildWeeklyCandles(daily));
        const daily4 = dailyTrend(daily);
        const extension = computeExtension(daily);

        return {
          symbol: ticker.symbol,
          ...ba,
          weeklyBias: weekly,
          dailyTrend: daily4,
          price: daily.at(-1)?.close,
          changePct24h: ticker.changePct24h,
          ...extension,
        };
      });

      return scanned
        .filter((r) => r.status === "fulfilled" && r.value != null)
        .map((r) => r.value)
        .filter((r) => r.weeklyBias === "bullish" && r.dailyTrend === "bullish" && !r.longExtended && r.alpha >= MIN_ALPHA)
        .sort((a, b) => b.alpha - a.alpha)
        .slice(0, RESULT_COUNT);
    },
    enabled,
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
    retry: 1,
  });
}
