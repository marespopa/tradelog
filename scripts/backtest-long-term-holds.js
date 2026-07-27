// Walk-forward backtest of useLongTermPicks.js's "Long-term holds — 1 month+
// horizon" screen (LongTermPanel.jsx), whose caption currently reads "not a
// backtested edge". This replays the exact live filter at each rebalance
// point instead of a redesigned approximation: a trailing 250-daily-bar
// window (useLongTermPicks.js's DAILY_LOOKBACK_BARS) feeds weeklyBias/
// dailyTrend (mtfSetup.js) and computeBetaAlpha/computeExtension
// (betaNeutral.js) exactly as the live query does, requiring both trend
// tiers bullish, alpha vs BTC >= MIN_ALPHA, and not longExtended. Top
// RESULT_COUNT by alpha are bought equal-weight and held for one rebalance
// period (~1 month, matching the panel's stated horizon), then rescreened.
// A period with zero qualifying names sits in cash rather than forcing a
// trade — same as the live screen returning an empty table.
//
// This tests the screen's actual claim: "picks beat BTC over the next
// month", not just over the trailing window they were selected on. Reports
// both portfolio-level equity (vs a BTC buy-and-hold over the identical
// calendar span) and pick-level hit rate (fraction of individual picks whose
// forward return actually exceeded BTC's over the same window).
//
// No parameter search — SYMBOL_COUNT/RESULT_COUNT/MIN_ALPHA/
// DAILY_LOOKBACK_BARS are useLongTermPicks.js's live constants;
// REBALANCE_DAYS mirrors the panel's stated "1 month+" horizon. None of
// these were tuned after seeing results.
//
// Result (2026-07-26 run): net-negative, and not just underperforming — the
// screen's central claim doesn't survive forward-testing. 41 monthly
// rebalances over 3.42 years, 25 symbols with full BTC-length history, 89
// total picks: pick-level hit rate vs BTC was 32.6% (29/89, 95% CI
// 23.7-42.9%) — a real edge would clear ~50%, this is well below it. Mean
// alpha achieved per pick was -4.45% (median -5.66%), i.e. picks selected for
// *already beating* BTC over the trailing 250 days went on to underperform
// it over the next 30 — the opposite of momentum persistence, more
// consistent with mean reversion. Strategy total return +7.1% vs BTC
// buy-and-hold +167.0% over the same span (CAGR 2.0% vs 33.2%), Sharpe 0.24,
// max drawdown 32.0%. Caveat: the BTC-timestamp alignment (same approach as
// backtest-beta-neutral.js) drops any symbol shorter-lived than BTC's full
// history, so the tested universe skews toward long-lived large/mid-caps
// (BTC/ETH-era survivors) and excludes newer higher-momentum names (SOL,
// PEPE, etc.) the live screen would readily surface — the live screen's
// candidate pool is broader than what got backtested here. Do not read this
// as "tune MIN_ALPHA/DAILY_LOOKBACK_BARS and rerun until green" — the
// direction of the effect (negative alpha persistence) is the finding, not a
// threshold miscalibration.
import { fetchTopVolumeTickers, fetchCandleHistory } from "../src/lib/analysis/okx.js";
import { computeBetaAlpha, computeExtension } from "../src/lib/analysis/betaNeutral.js";
import { weeklyBias, dailyTrend } from "../src/lib/analysis/mtfSetup.js";
import { buildWeeklyCandles } from "../src/lib/analysis/timeframes.js";
import { writeFileSync, mkdirSync } from "node:fs";

const SYMBOL_COUNT = 80; // matches useLongTermPicks.js's CANDIDATE_COUNT
const DAILY_LOOKBACK_BARS = 250; // matches useLongTermPicks.js's DAILY_LOOKBACK_BARS
const REBALANCE_DAYS = 30; // ~1 month hold, matching the panel's stated horizon
const RESULT_COUNT = 15; // matches useLongTermPicks.js's RESULT_COUNT
const MIN_ALPHA = 0.05; // matches useLongTermPicks.js's MIN_ALPHA
const HISTORY_BARS = 1500; // ~4.1 years of daily bars — as much OOS runway as the venue reasonably offers
const ROUND_TRIP_COST_PCT = 0.002; // 20bps assumed entry+exit cost per pick per hold (spread+fees) — spot only, no funding/borrow (long-only)
const DAY_MS = 86400000;

function mean(xs) {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
}

function median(xs) {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Wilson score interval — same 95% CI convention mtfSetup.js's find4hTrigger
// comment cites for its own win-rate validation, so this result reads on the
// same scale as that one.
function wilsonInterval(successes, n, z = 1.96) {
  if (n === 0) return [null, null];
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(center - margin) / denom, (center + margin) / denom];
}

async function main() {
  console.log(`Fetching top ${SYMBOL_COUNT} symbols by volume...`);
  const tickers = await fetchTopVolumeTickers(SYMBOL_COUNT);
  const symbols = tickers.map((t) => t.symbol).filter((s) => s !== "BTC");

  console.log("Fetching BTC (market factor) daily history...");
  const btcCandles = await fetchCandleHistory("BTC", "1d", HISTORY_BARS);
  console.log(`BTC: ${btcCandles.length} candles, ${new Date(btcCandles[0].time).toISOString().slice(0, 10)} to ${new Date(btcCandles.at(-1).time).toISOString().slice(0, 10)}`);

  const histories = { BTC: btcCandles };
  const minUsableBars = DAILY_LOOKBACK_BARS + REBALANCE_DAYS + 10;
  for (const symbol of symbols) {
    process.stdout.write(`  ${symbol}... `);
    try {
      const candles = await fetchCandleHistory(symbol, "1d", HISTORY_BARS);
      if (candles.length < minUsableBars) {
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
  // across symbols — same approach as backtest-beta-neutral.js.
  const btcTimes = btcCandles.map((c) => c.time);
  const alignedCandles = {};
  for (const [symbol, candles] of Object.entries(histories)) {
    const bySymbolTime = new Map(candles.map((c) => [c.time, c]));
    if (!btcTimes.every((t) => bySymbolTime.has(t))) continue;
    alignedCandles[symbol] = btcTimes.map((t) => bySymbolTime.get(t));
  }
  const alignedCloses = Object.fromEntries(Object.entries(alignedCandles).map(([symbol, candles]) => [symbol, candles.map((c) => c.close)]));
  const candidateSymbols = Object.keys(alignedCandles).filter((s) => s !== "BTC");
  console.log(`\n${candidateSymbols.length} symbols aligned with BTC's ${btcTimes.length}-bar history (excluding BTC itself).`);

  const btcCloses = alignedCloses.BTC;
  const periods = [];
  const allPicks = [];
  let strategyEquity = 1;
  let btcHoldEquity = 1;
  const equityCurve = [{ time: btcTimes[DAILY_LOOKBACK_BARS - 1], strategyEquity, btcHoldEquity }];
  let peakStrategy = 1;
  let maxDrawdown = 0;

  for (let t = DAILY_LOOKBACK_BARS - 1; t + REBALANCE_DAYS < btcTimes.length; t += REBALANCE_DAYS) {
    const windowStart = t - DAILY_LOOKBACK_BARS + 1;
    const btcWindowCloses = btcCloses.slice(windowStart, t + 1);

    const rows = candidateSymbols
      .map((symbol) => {
        const coinWindowCloses = alignedCloses[symbol].slice(windowStart, t + 1);
        const ba = computeBetaAlpha(coinWindowCloses, btcWindowCloses);
        if (!ba) return null;
        const candleWindow = alignedCandles[symbol].slice(windowStart, t + 1);
        const wBias = weeklyBias(buildWeeklyCandles(candleWindow));
        const dTrend = dailyTrend(candleWindow);
        const extension = computeExtension(candleWindow);
        return { symbol, ...ba, weeklyBias: wBias, dailyTrend: dTrend, ...extension };
      })
      .filter(Boolean)
      .filter((r) => r.weeklyBias === "bullish" && r.dailyTrend === "bullish" && !r.longExtended && r.alpha >= MIN_ALPHA);

    const picks = rows.sort((a, b) => b.alpha - a.alpha).slice(0, RESULT_COUNT);

    const forwardReturn = (symbol) => alignedCloses[symbol][t + REBALANCE_DAYS] / alignedCloses[symbol][t] - 1;
    const btcForwardReturn = btcCloses[t + REBALANCE_DAYS] / btcCloses[t] - 1;

    let portfolioReturn = 0;
    if (picks.length) {
      const netReturns = picks.map((p) => forwardReturn(p.symbol) - ROUND_TRIP_COST_PCT);
      portfolioReturn = mean(netReturns);
      for (const p of picks) {
        const fwd = forwardReturn(p.symbol);
        allPicks.push({
          time: new Date(btcTimes[t]).toISOString().slice(0, 10),
          symbol: p.symbol,
          alphaAtSelection: p.alpha,
          forwardReturn: fwd,
          btcForwardReturn,
          beatBtc: fwd > btcForwardReturn,
          positive: fwd > 0,
        });
      }
    }

    strategyEquity *= 1 + portfolioReturn;
    btcHoldEquity *= 1 + btcForwardReturn;
    peakStrategy = Math.max(peakStrategy, strategyEquity);
    maxDrawdown = Math.max(maxDrawdown, (peakStrategy - strategyEquity) / peakStrategy);
    equityCurve.push({ time: btcTimes[t + REBALANCE_DAYS], strategyEquity, btcHoldEquity });

    periods.push({
      time: new Date(btcTimes[t]).toISOString().slice(0, 10),
      pickCount: picks.length,
      picks: picks.map((p) => p.symbol),
      portfolioReturn,
      btcForwardReturn,
    });
  }

  const periodReturns = periods.map((p) => p.portfolioReturn);
  const n = periodReturns.length;
  const activePeriods = periods.filter((p) => p.pickCount > 0);
  const meanPeriodReturn = mean(periodReturns);
  const variance = periodReturns.reduce((s, r) => s + (r - meanPeriodReturn) ** 2, 0) / (n - 1);
  const stdDev = Math.sqrt(variance);
  const periodsPerYear = 365 / REBALANCE_DAYS;
  const sharpe = stdDev > 0 ? (meanPeriodReturn / stdDev) * Math.sqrt(periodsPerYear) : null;

  const totalReturn = strategyEquity - 1;
  const btcTotalReturn = btcHoldEquity - 1;
  const years = (btcTimes.at(-1) - btcTimes[DAILY_LOOKBACK_BARS - 1]) / (365 * DAY_MS);
  const cagr = Math.pow(strategyEquity, 1 / years) - 1;
  const btcCagr = Math.pow(btcHoldEquity, 1 / years) - 1;

  const beats = allPicks.filter((p) => p.beatBtc).length;
  const positives = allPicks.filter((p) => p.positive).length;
  const [beatLo, beatHi] = wilsonInterval(beats, allPicks.length);
  const alphaAchieved = allPicks.map((p) => p.forwardReturn - p.btcForwardReturn);

  console.log(`\n\n=== Long-term holds screen — ${n} rebalance periods (${REBALANCE_DAYS}d each), top ${RESULT_COUNT} by alpha, min alpha ${MIN_ALPHA} ===`);
  console.log(`Periods with >=1 qualifying pick: ${activePeriods.length}/${n} (${((activePeriods.length / n) * 100).toFixed(1)}%)`);
  console.log(`Avg picks per active period: ${mean(activePeriods.map((p) => p.pickCount)).toFixed(1)}`);
  console.log(`Total picks made: ${allPicks.length}`);
  console.log(`\nStrategy total return: ${(totalReturn * 100).toFixed(1)}%  CAGR: ${(cagr * 100).toFixed(1)}%  over ${years.toFixed(2)} years`);
  console.log(`BTC buy-hold total return: ${(btcTotalReturn * 100).toFixed(1)}%  CAGR: ${(btcCagr * 100).toFixed(1)}%  (same span)`);
  console.log(`Per-period mean: ${(meanPeriodReturn * 100).toFixed(2)}%  stdDev: ${(stdDev * 100).toFixed(2)}%`);
  console.log(`Annualized Sharpe: ${sharpe != null ? sharpe.toFixed(2) : "n/a"}`);
  console.log(`Max drawdown: ${(maxDrawdown * 100).toFixed(1)}%`);
  console.log(`\nPick-level hit rate — beat BTC's forward return over the same ${REBALANCE_DAYS}d window: ${beats}/${allPicks.length} (${((beats / allPicks.length) * 100).toFixed(1)}%, 95% CI ${(beatLo * 100).toFixed(1)}-${(beatHi * 100).toFixed(1)}%)`);
  console.log(`Pick-level raw win rate (positive forward return): ${positives}/${allPicks.length} (${((positives / allPicks.length) * 100).toFixed(1)}%)`);
  console.log(`Mean forward return per pick: ${(mean(allPicks.map((p) => p.forwardReturn)) * 100).toFixed(2)}%  median: ${(median(allPicks.map((p) => p.forwardReturn)) * 100).toFixed(2)}%`);
  console.log(`Mean alpha achieved per pick (forward - BTC forward, same window): ${(mean(alphaAchieved) * 100).toFixed(2)}%  median: ${(median(alphaAchieved) * 100).toFixed(2)}%`);
  console.log(`\nNote: ${ROUND_TRIP_COST_PCT * 100}% flat entry+exit cost assumed per pick per hold; no funding/borrow (long-only spot).`);

  mkdirSync("backtests", { recursive: true });
  const outPath = `backtests/long-term-holds-${new Date().toISOString().slice(0, 10)}.json`;
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        params: { SYMBOL_COUNT, DAILY_LOOKBACK_BARS, REBALANCE_DAYS, RESULT_COUNT, MIN_ALPHA, ROUND_TRIP_COST_PCT },
        summary: {
          n,
          activePeriods: activePeriods.length,
          totalPicks: allPicks.length,
          totalReturn,
          cagr,
          btcTotalReturn,
          btcCagr,
          meanPeriodReturn,
          stdDev,
          sharpe,
          maxDrawdown,
          pickHitRateVsBtc: allPicks.length ? beats / allPicks.length : null,
          pickHitRateCI: [beatLo, beatHi],
          pickRawWinRate: allPicks.length ? positives / allPicks.length : null,
          meanForwardReturn: mean(allPicks.map((p) => p.forwardReturn)),
          meanAlphaAchieved: mean(alphaAchieved),
        },
        equityCurve,
        periods,
        picks: allPicks,
      },
      null,
      2,
    ),
  );
  console.log(`\nRaw results written to ${outPath}`);
}

main();
