// Walk-forward backtest of the funding-rate-capture strategy (see
// src/lib/analysis/fundingCapture.js): every REBALANCE_DAYS, rank
// candidates by their trailing LOOKBACK_DAYS average funding rate, hold the
// top BASKET_COUNT (short perp / long spot, equal-weighted) for the next
// rebalance period, collect whatever funding actually settled during that
// window, repeat. Time-indexed (not period-indexed) since funding interval
// isn't guaranteed uniform across every perp. No parameter search happened
// to produce this — LOOKBACK, REBALANCE, and basket size were picked once
// as reasonable starting values before running, not tuned afterward to
// make the number green.
//
// Not modeled: basis risk (spot vs perp price divergence — assumed the two
// legs' price P&L cancels exactly, which isn't true during stressed/volatile
// periods), margin/collateral funding cost for the perp leg, and unequal
// capital available per leg. Cost is a flat per-rebalance assumption of
// full basket turnover every period, which is conservative (real turnover
// between adjacent weekly rankings is usually partial, not 100%).
import { fetchTopVolumeTickers, fetchFundingRateHistory } from "../src/lib/analysis/okx.js";
import { averageFundingRate, buildFundingBasket } from "../src/lib/analysis/fundingCapture.js";
import { writeFileSync, mkdirSync } from "node:fs";

const SYMBOL_COUNT = 30;
const HISTORY_DAYS = 365;
const PERIODS_ESTIMATE = Math.ceil((HISTORY_DAYS * 24) / 8) + 20; // 8h funding interval assumption, +headroom for perps that settle more often
const LOOKBACK_DAYS = 14;
const REBALANCE_DAYS = 7;
const BASKET_COUNT = 10;
const ROUND_TRIP_COST_PCT = 0.001; // 10bps/position/rebalance, assumed full turnover (conservative)
const DAY_MS = 86400000;

async function main() {
  console.log(`Fetching top ${SYMBOL_COUNT} symbols by volume...`);
  const tickers = await fetchTopVolumeTickers(SYMBOL_COUNT);
  const symbols = tickers.map((t) => t.symbol);

  const histories = {};
  for (const symbol of symbols) {
    process.stdout.write(`  ${symbol}... `);
    try {
      const rates = await fetchFundingRateHistory(symbol, PERIODS_ESTIMATE);
      if (rates.length < 30) {
        console.log(`skipped (only ${rates.length} periods — likely no perp listing, or too new)`);
        continue;
      }
      histories[symbol] = rates;
      console.log(`${rates.length} periods, ${new Date(rates[0].time).toISOString().slice(0, 10)} to ${new Date(rates.at(-1).time).toISOString().slice(0, 10)}`);
    } catch (err) {
      console.log(`failed: ${err.message}`);
    }
  }

  console.log(`\n${Object.keys(histories).length} symbols with usable funding history.`);
  if (Object.keys(histories).length < BASKET_COUNT) {
    console.log("Not enough symbols with funding history to run a meaningful backtest.");
    return;
  }

  const allTimes = Object.values(histories).flat().map((r) => r.time);
  const start = Math.min(...allTimes) + LOOKBACK_DAYS * DAY_MS;
  const end = Math.max(...allTimes);

  const periods = [];
  let equity = 1;
  const equityCurve = [{ time: start, equity }];

  for (let t = start; t + REBALANCE_DAYS * DAY_MS <= end; t += REBALANCE_DAYS * DAY_MS) {
    const rows = Object.entries(histories)
      .map(([symbol, rates]) => {
        const window = rates.filter((r) => r.time > t - LOOKBACK_DAYS * DAY_MS && r.time <= t);
        if (window.length < 5) return null;
        return { symbol, avgRate: averageFundingRate(window) };
      })
      .filter(Boolean);

    const basket = rows.length ? buildFundingBasket(rows, { count: BASKET_COUNT }) : [];

    if (!basket.length) {
      periods.push({ time: new Date(t).toISOString().slice(0, 10), held: [], periodReturn: 0 });
      equityCurve.push({ time: t + REBALANCE_DAYS * DAY_MS, equity });
      continue;
    }

    const realizedReturn = (symbol) =>
      histories[symbol]
        .filter((r) => r.time > t && r.time <= t + REBALANCE_DAYS * DAY_MS)
        .reduce((s, r) => s + r.rate, 0);

    const grossReturn = basket.reduce((s, r) => s + r.weight * realizedReturn(r.symbol), 0);
    const periodReturn = grossReturn - ROUND_TRIP_COST_PCT;

    equity *= 1 + periodReturn;
    equityCurve.push({ time: t + REBALANCE_DAYS * DAY_MS, equity });
    periods.push({
      time: new Date(t).toISOString().slice(0, 10),
      held: basket.map((r) => r.symbol),
      avgRateAtSelection: basket.reduce((s, r) => s + r.avgRate, 0) / basket.length,
      grossReturn,
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
  const years = (end - start) / (365 * DAY_MS);
  const cagr = Math.pow(equity, 1 / years) - 1;

  console.log(`\n\n=== Funding-rate capture — ${n} rebalance periods (${REBALANCE_DAYS}d each), basket size ${BASKET_COUNT} ===`);
  console.log(`Total return: ${(totalReturn * 100).toFixed(1)}%  over ${years.toFixed(2)} years`);
  console.log(`CAGR: ${(cagr * 100).toFixed(1)}%`);
  console.log(`Per-period mean: ${(meanReturn * 100).toFixed(3)}%  stdDev: ${(stdDev * 100).toFixed(3)}%`);
  console.log(`Annualized Sharpe: ${sharpe != null ? sharpe.toFixed(2) : "n/a"}`);
  console.log(`Max drawdown: ${(maxDrawdown * 100).toFixed(1)}%`);
  console.log(`Winning periods: ${returns.filter((r) => r > 0).length}/${n} (${((returns.filter((r) => r > 0).length / n) * 100).toFixed(1)}%)`);
  console.log(
    `\nNote: ${ROUND_TRIP_COST_PCT * 100}% flat cost/position/rebalance assumed (conservative: assumes full turnover every period). Basis risk (spot vs perp price divergence) and margin/collateral funding cost NOT modeled.`
  );

  mkdirSync("backtests", { recursive: true });
  const outPath = `backtests/funding-capture-${new Date().toISOString().slice(0, 10)}.json`;
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        params: { SYMBOL_COUNT, HISTORY_DAYS, LOOKBACK_DAYS, REBALANCE_DAYS, BASKET_COUNT, ROUND_TRIP_COST_PCT },
        summary: { totalReturn, cagr, meanReturn, stdDev, sharpe, maxDrawdown, winRate: returns.filter((r) => r > 0).length / n, n },
        equityCurve,
        periods,
      },
      null,
      2
    )
  );
  console.log(`\nRaw results written to ${outPath}`);
}

main();
