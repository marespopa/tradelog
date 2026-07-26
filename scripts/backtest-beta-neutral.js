// Walk-forward backtest of the beta-neutral long/short basket (see
// src/lib/analysis/betaNeutral.js): every REBALANCE_BARS (4H bars), rank the
// top-volume coins by alpha vs BTC over the trailing LOOKBACK_BARS of 4H
// candles, veto any candidate whose Weekly+Daily trend regime (mtfSetup.js's
// mtfRegime) actively disagrees with the leg direction, veto any candidate
// too extended in the leg's own direction (betaNeutral.js's computeExtension
// — "don't buy tops, don't sell bottoms"), long the strongest of what's
// left, short the weakest, size the short leg's notional to zero out net
// beta, hold for one rebalance period, repeat. No parameter search happened
// to produce this — LOOKBACK, REBALANCE, and basket size were picked once
// as reasonable starting values before running, not tuned afterward to make
// the number green.
//
// History log (see git blame for exact dates/sample sizes each was run):
//   1. Original construction, daily bars, no regime veto, dollar-neutral
//      $1/$1 legs: avg |net beta| 0.742 — NOT actually hedged despite the
//      name, a bug in the per-name inverse-beta weighting (it balances
//      exposure within a leg, not across legs).
//   2. Beta-fix only (short leg notional scaled to zero net beta), daily
//      bars, no regime veto: avg |net beta| 0.000 (fixed) but Sharpe 0.03 —
//      worse absolute performance than #1, because #1's better-looking
//      number was largely luck (an accidental net-short-BTC tilt that paid
//      off while crypto broadly declined over that window, not skill).
//   3. Beta-fix + regime veto, daily bars: avg |net beta| 0.010, Sharpe
//      0.22 — a real, substantial improvement over #2 (7x the Sharpe),
//      meaning the regime filter does genuine work. Still net-negative
//      overall.
//   4. Reshaped onto 4H bars (30-day alpha lookback instead of 60 *days*)
//      plus the extension veto, weekly rebalance kept matched to #3 for a
//      fair same-window/same-sample-size comparison (104 vs 105 periods,
//      both ~2 years): avg |net beta| 0.042 (looser than #3's 0.010, still
//      tight), Sharpe 0.13 (vs #3's 0.22 — worse), but total return -6.1%
//      (vs -9.8%), CAGR -3.1% (vs -5.0%), max drawdown 43.3% (vs 55.0%),
//      and win rate 58.7% (vs 55.2%) — all better. Mixed result, not a
//      clean win either way; kept live because the drawdown/return
//      improvement was judged more decision-relevant than the Sharpe/beta-
//      precision regression. Still net-negative overall — this reshape
//      changed the risk/reward shape of an unproven strategy, it did not
//      turn it into a validated edge.
//   5. MIN_ALPHA quality floor (below) added after #4's run — not yet
//      separately backtested on a matched window. If you're revisiting
//      this, that's the next thing to validate before trusting it further.
//
// Not modeled: funding/borrow cost for the short leg (crypto shorting is a
// perp/margin position in practice, not spot — this backtests the spread
// P&L, not a specific venue's mechanics), slippage beyond a flat cost
// assumption, and unequal capital available per leg.
import { fetchTopVolumeTickers, fetchCandleHistory } from "../src/lib/analysis/okx.js";
import { computeBetaAlpha, computeExtension, buildBetaNeutralBasket } from "../src/lib/analysis/betaNeutral.js";
import { mtfRegime } from "../src/lib/analysis/mtfSetup.js";
import { writeFileSync, mkdirSync } from "node:fs";

const SYMBOL_COUNT = 40;
const HISTORY_BARS = 6900; // ~85 weeks warmup + ~2 years of trading window in 4H bars — matched to the original daily-bar backtest's 2-year sample for a fair comparison
const WARMUP_BARS = 2520; // ~85 weeks in 4H bars, so resampled weekly regime has settled (see mtfSetup.js's MTF_WEEKLY_WARMUP_BARS)
const LOOKBACK_BARS = 180; // ~30 days of 4H bars for alpha/beta and the extension (RSI/channel) read
const REBALANCE_BARS = 42; // ~1 week in 4H bars — kept weekly (matching the prior daily-bar backtest's cadence) so this run isolates the effect of the 4H alpha lookback + extension filter, not a turnover/cost confound from also rebalancing more often
const LONG_COUNT = 5;
const SHORT_COUNT = 5;
const MIN_ALPHA = 0.1; // quality floor — see useHedgedBasket.js's matching constant; a leg gets fewer than LONG_COUNT/SHORT_COUNT names on a thin period rather than padding with marginal alpha
const ROUND_TRIP_COST_PCT = 0.002; // 20bps assumed cost per leg per rebalance (spread + fees), applied flat regardless of actual turnover
const DAY_MS = 86400000;

async function main() {
  console.log(`Fetching top ${SYMBOL_COUNT} symbols by volume...`);
  const tickers = await fetchTopVolumeTickers(SYMBOL_COUNT);
  const symbols = tickers.map((t) => t.symbol).filter((s) => s !== "BTC");

  console.log("Fetching BTC (market factor) 4H history...");
  const btcCandles = await fetchCandleHistory("BTC", "4h", HISTORY_BARS);
  console.log(`BTC: ${btcCandles.length} candles, ${new Date(btcCandles[0].time).toISOString().slice(0, 10)} to ${new Date(btcCandles.at(-1).time).toISOString().slice(0, 10)}`);

  const histories = { BTC: btcCandles };
  for (const symbol of symbols) {
    process.stdout.write(`  ${symbol}... `);
    try {
      const candles = await fetchCandleHistory(symbol, "4h", HISTORY_BARS);
      if (candles.length < WARMUP_BARS + REBALANCE_BARS + 10) {
        console.log(`skipped (only ${candles.length} candles)`);
        continue;
      }
      histories[symbol] = candles;
      console.log(`${candles.length} candles`);
    } catch (err) {
      console.log(`failed: ${err.message}`);
    }
  }

  // Align everyone to BTC's timestamps so window slicing by index is valid
  // across symbols — drop any symbol whose 4H candles don't line up with
  // BTC's (gaps from exchange listing history) rather than risk misaligned
  // return windows.
  const btcTimes = btcCandles.map((c) => c.time);
  const alignedCandles = {};
  for (const [symbol, candles] of Object.entries(histories)) {
    const bySymbolTime = new Map(candles.map((c) => [c.time, c]));
    if (!btcTimes.every((t) => bySymbolTime.has(t))) continue;
    alignedCandles[symbol] = btcTimes.map((t) => bySymbolTime.get(t));
  }
  const aligned = Object.fromEntries(Object.entries(alignedCandles).map(([symbol, candles]) => [symbol, candles.map((c) => c.close)]));
  console.log(`\n${Object.keys(aligned).length - 1} symbols aligned with BTC's ${btcTimes.length}-bar history (excluding BTC itself).`);

  const marketCloses = aligned.BTC;
  const candidateSymbols = Object.keys(aligned).filter((s) => s !== "BTC");

  const periods = [];
  let equity = 1;
  const equityCurve = [{ time: btcTimes[WARMUP_BARS], equity }];
  let netBetaSum = 0;

  for (let t = WARMUP_BARS; t + REBALANCE_BARS < btcTimes.length; t += REBALANCE_BARS) {
    const rows = candidateSymbols
      .map((symbol) => {
        const coinWindow = aligned[symbol].slice(t - LOOKBACK_BARS, t + 1);
        const marketWindow = marketCloses.slice(t - LOOKBACK_BARS, t + 1);
        const ba = computeBetaAlpha(coinWindow, marketWindow);
        if (!ba) return null;
        const fourHWindow = alignedCandles[symbol].slice(t - LOOKBACK_BARS, t + 1);
        const extension = computeExtension(fourHWindow);
        return { symbol, ...ba, ...extension };
      })
      .filter(Boolean);

    if (rows.length < LONG_COUNT + SHORT_COUNT) continue;

    // mtfRegime resamples weekly internally from the daily series it's
    // given, so only a "closed as of t" daily slice is needed here, not a
    // separately-tracked weekly pointer. Sliced off alignedCandles rather
    // than resampled-from-scratch each time would be O(n^2); since regime
    // only needs to be roughly current (not bar-exact) and this backtest
    // already re-slices per rebalance (not per 4H bar), the cost stays
    // bounded to one slice+resample per rebalance, not per bar.
    const regimeBySymbol = {};
    for (const { symbol } of rows) regimeBySymbol[symbol] = mtfRegime(alignedCandles[symbol].slice(0, t + 1));

    const basket = buildBetaNeutralBasket(rows, {
      longCount: LONG_COUNT,
      shortCount: SHORT_COUNT,
      minAlpha: MIN_ALPHA,
      regimeBySymbol,
      extensionBySymbol: Object.fromEntries(rows.map((r) => [r.symbol, r])),
    });
    // Sum of |netBeta| — the label below is "avg |net beta|"; summing the
    // signed value would let a positive-net-beta period cancel a
    // negative-net-beta one and hide exactly the problem this backtest is
    // meant to catch.
    netBetaSum += Math.abs(basket.netBeta);

    const forwardReturn = (symbol) => aligned[symbol][t + REBALANCE_BARS] / aligned[symbol][t] - 1;
    const longReturn = basket.longs.reduce((s, r) => s + r.weight * forwardReturn(r.symbol), 0);
    const shortReturn = basket.shorts.reduce((s, r) => s + r.weight * forwardReturn(r.symbol), 0);
    // Cost scales with actual notional traded (long + short legs), not a
    // flat assumption — the short leg's total size varies with
    // longBeta/shortBeta instead of always matching the long leg's $1.
    const cost = ROUND_TRIP_COST_PCT * (basket.longNotional + basket.shortNotional);
    const periodReturn = longReturn - shortReturn - cost;

    equity *= 1 + periodReturn;
    equityCurve.push({ time: btcTimes[t + REBALANCE_BARS], equity });
    periods.push({
      time: new Date(btcTimes[t]).toISOString().slice(0, 10),
      netBeta: basket.netBeta,
      shortNotional: basket.shortNotional,
      longs: basket.longs.map((r) => r.symbol),
      shorts: basket.shorts.map((r) => r.symbol),
      longReturn,
      shortReturn,
      periodReturn,
    });
  }

  const returns = periods.map((p) => p.periodReturn);
  const n = returns.length;
  const meanReturn = returns.reduce((s, r) => s + r, 0) / n;
  const variance = returns.reduce((s, r) => s + (r - meanReturn) ** 2, 0) / (n - 1);
  const stdDev = Math.sqrt(variance);
  const periodsPerYear = (365 * DAY_MS) / (REBALANCE_BARS * 4 * 3600000);
  const sharpe = stdDev > 0 ? (meanReturn / stdDev) * Math.sqrt(periodsPerYear) : null;

  let peak = 1;
  let maxDrawdown = 0;
  for (const { equity: e } of equityCurve) {
    peak = Math.max(peak, e);
    maxDrawdown = Math.max(maxDrawdown, (peak - e) / peak);
  }

  const totalReturn = equity - 1;
  const years = (btcTimes.at(-1) - btcTimes[WARMUP_BARS]) / (365 * DAY_MS);
  const cagr = Math.pow(equity, 1 / years) - 1;

  console.log(`\n\n=== Beta-neutral basket (4H) — ${n} rebalance periods (${REBALANCE_BARS} bars / ~${(REBALANCE_BARS / 6).toFixed(1)}d each), long ${LONG_COUNT} / short ${SHORT_COUNT} ===`);
  console.log(`Total return: ${(totalReturn * 100).toFixed(1)}%  over ${years.toFixed(2)} years`);
  console.log(`CAGR: ${(cagr * 100).toFixed(1)}%`);
  console.log(`Per-period mean: ${(meanReturn * 100).toFixed(3)}%  stdDev: ${(stdDev * 100).toFixed(3)}%`);
  console.log(`Annualized Sharpe: ${sharpe != null ? sharpe.toFixed(2) : "n/a"}`);
  console.log(`Max drawdown: ${(maxDrawdown * 100).toFixed(1)}%`);
  console.log(`Avg |net beta| achieved: ${(netBetaSum / n).toFixed(3)} (0 = perfectly hedged)`);
  console.log(`Winning periods: ${returns.filter((r) => r > 0).length}/${n} (${((returns.filter((r) => r > 0).length / n) * 100).toFixed(1)}%)`);
  console.log(`\nNote: ${ROUND_TRIP_COST_PCT * 100}% flat cost/rebalance assumed; short-leg funding/borrow cost NOT modeled.`);

  mkdirSync("backtests", { recursive: true });
  const outPath = `backtests/beta-neutral-basket-4h-${new Date().toISOString().slice(0, 10)}.json`;
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        params: { SYMBOL_COUNT, HISTORY_BARS, WARMUP_BARS, LOOKBACK_BARS, REBALANCE_BARS, LONG_COUNT, SHORT_COUNT, ROUND_TRIP_COST_PCT },
        summary: { totalReturn, cagr, meanReturn, stdDev, sharpe, maxDrawdown, avgNetBeta: netBetaSum / n, winRate: returns.filter((r) => r > 0).length / n, n },
        equityCurve,
        periods,
      },
      null,
      2,
    ),
  );
  console.log(`\nRaw results written to ${outPath}`);
}

main();
