// Walk-forward backtest of the beta-neutral long/short basket (see
// src/lib/analysis/betaNeutral.js): every REBALANCE_DAYS, rank the top-volume
// coins by alpha vs BTC over the trailing LOOKBACK_DAYS, long the strongest,
// short the weakest, weight each leg inverse-beta, hold for one rebalance
// period, repeat. No parameter search happened to produce this — LOOKBACK,
// REBALANCE, and basket size were picked once as reasonable starting values
// before running, not tuned afterward to make the number green.
//
// Not modeled: funding/borrow cost for the short leg (crypto shorting is a
// perp/margin position in practice, not spot — this backtests the spread
// P&L, not a specific venue's mechanics), slippage beyond a flat cost
// assumption, and unequal capital available per leg.
import { fetchTopVolumeTickers, fetchCandleHistory } from "../src/lib/analysis/okx.js";
import { computeBetaAlpha, buildBetaNeutralBasket } from "../src/lib/analysis/betaNeutral.js";
import { writeFileSync, mkdirSync } from "node:fs";

const SYMBOL_COUNT = 40;
const HISTORY_DAYS = 730; // ~2 years of daily candles
const LOOKBACK_DAYS = 60;
const REBALANCE_DAYS = 7;
const LONG_COUNT = 5;
const SHORT_COUNT = 5;
const ROUND_TRIP_COST_PCT = 0.002; // 20bps assumed cost per leg per rebalance (spread + fees), applied flat regardless of actual turnover

async function main() {
  console.log(`Fetching top ${SYMBOL_COUNT} symbols by volume...`);
  const tickers = await fetchTopVolumeTickers(SYMBOL_COUNT);
  const symbols = tickers.map((t) => t.symbol).filter((s) => s !== "BTC");

  console.log("Fetching BTC (market factor) daily history...");
  const btcCandles = await fetchCandleHistory("BTC", "1d", HISTORY_DAYS);
  console.log(`BTC: ${btcCandles.length} candles, ${new Date(btcCandles[0].time).toISOString().slice(0, 10)} to ${new Date(btcCandles.at(-1).time).toISOString().slice(0, 10)}`);

  const histories = { BTC: btcCandles };
  for (const symbol of symbols) {
    process.stdout.write(`  ${symbol}... `);
    try {
      const candles = await fetchCandleHistory(symbol, "1d", HISTORY_DAYS);
      if (candles.length < LOOKBACK_DAYS + REBALANCE_DAYS + 10) {
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
  // across symbols — drop any symbol whose daily candles don't line up with
  // BTC's (gaps from exchange listing history) rather than risk misaligned
  // return windows.
  const btcTimes = btcCandles.map((c) => c.time);
  const aligned = {};
  for (const [symbol, candles] of Object.entries(histories)) {
    const bySymbolTime = new Map(candles.map((c) => [c.time, c]));
    if (!btcTimes.every((t) => bySymbolTime.has(t))) continue;
    aligned[symbol] = btcTimes.map((t) => bySymbolTime.get(t).close);
  }
  console.log(`\n${Object.keys(aligned).length - 1} symbols aligned with BTC's ${btcTimes.length}-day history (excluding BTC itself).`);

  const marketCloses = aligned.BTC;
  const candidateSymbols = Object.keys(aligned).filter((s) => s !== "BTC");

  const periods = [];
  let equity = 1;
  const equityCurve = [{ time: btcTimes[LOOKBACK_DAYS], equity }];
  let netBetaSum = 0;

  for (let t = LOOKBACK_DAYS; t + REBALANCE_DAYS < btcTimes.length; t += REBALANCE_DAYS) {
    const rows = candidateSymbols
      .map((symbol) => {
        const coinWindow = aligned[symbol].slice(t - LOOKBACK_DAYS, t + 1);
        const marketWindow = marketCloses.slice(t - LOOKBACK_DAYS, t + 1);
        const ba = computeBetaAlpha(coinWindow, marketWindow);
        return ba ? { symbol, ...ba } : null;
      })
      .filter(Boolean);

    if (rows.length < LONG_COUNT + SHORT_COUNT) continue;

    const basket = buildBetaNeutralBasket(rows, { longCount: LONG_COUNT, shortCount: SHORT_COUNT });
    netBetaSum += basket.netBeta;

    const forwardReturn = (symbol) => aligned[symbol][t + REBALANCE_DAYS] / aligned[symbol][t] - 1;
    const longReturn = basket.longs.reduce((s, r) => s + r.weight * forwardReturn(r.symbol), 0);
    const shortReturn = basket.shorts.reduce((s, r) => s + r.weight * forwardReturn(r.symbol), 0);
    const periodReturn = longReturn - shortReturn - ROUND_TRIP_COST_PCT;

    equity *= 1 + periodReturn;
    equityCurve.push({ time: btcTimes[t + REBALANCE_DAYS], equity });
    periods.push({
      time: new Date(btcTimes[t]).toISOString().slice(0, 10),
      netBeta: basket.netBeta,
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
  const periodsPerYear = 365 / REBALANCE_DAYS;
  const sharpe = stdDev > 0 ? (meanReturn / stdDev) * Math.sqrt(periodsPerYear) : null;

  let peak = 1;
  let maxDrawdown = 0;
  for (const { equity: e } of equityCurve) {
    peak = Math.max(peak, e);
    maxDrawdown = Math.max(maxDrawdown, (peak - e) / peak);
  }

  const totalReturn = equity - 1;
  const years = (btcTimes.at(-1) - btcTimes[LOOKBACK_DAYS]) / (365 * 86400000);
  const cagr = Math.pow(equity, 1 / years) - 1;

  console.log(`\n\n=== Beta-neutral basket — ${n} rebalance periods (${REBALANCE_DAYS}d each), long ${LONG_COUNT} / short ${SHORT_COUNT} ===`);
  console.log(`Total return: ${(totalReturn * 100).toFixed(1)}%  over ${years.toFixed(2)} years`);
  console.log(`CAGR: ${(cagr * 100).toFixed(1)}%`);
  console.log(`Per-period mean: ${(meanReturn * 100).toFixed(2)}%  stdDev: ${(stdDev * 100).toFixed(2)}%`);
  console.log(`Annualized Sharpe: ${sharpe != null ? sharpe.toFixed(2) : "n/a"}`);
  console.log(`Max drawdown: ${(maxDrawdown * 100).toFixed(1)}%`);
  console.log(`Avg |net beta| achieved: ${(netBetaSum / n).toFixed(3)} (0 = perfectly hedged)`);
  console.log(`Winning periods: ${returns.filter((r) => r > 0).length}/${n} (${((returns.filter((r) => r > 0).length / n) * 100).toFixed(1)}%)`);
  console.log(`\nNote: ${ROUND_TRIP_COST_PCT * 100}% flat cost/period assumed; short-leg funding/borrow cost NOT modeled.`);

  mkdirSync("backtests", { recursive: true });
  const outPath = `backtests/beta-neutral-basket-${new Date().toISOString().slice(0, 10)}.json`;
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        params: { SYMBOL_COUNT, HISTORY_DAYS, LOOKBACK_DAYS, REBALANCE_DAYS, LONG_COUNT, SHORT_COUNT, ROUND_TRIP_COST_PCT },
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
