// Backtests the user's rule literally as stated: BUY (go long) when the
// 20-period z-score crosses above +1, SELL (close the long) when it falls
// back to <= 0. This is a momentum read on the statistic, not mean-reversion
// -- it's betting the "wave" (price pushing away from its rolling mean)
// keeps building once it clears +1, and steps aside once the wave recedes
// back through the mean itself. Long-only, not always-in-market (unlike
// backtest-channel-midline.js's flip system): the rule as given has no short
// side, so it sits flat between a sell and the next buy signal.
//
// Distinct from backtest-zscore-reversion.js, which trades the *opposite*
// read (|z| >= 2.5 is overbought/oversold -> fade it expecting reversion to
// the mean). Same statistic, opposite thesis.
import { fetchCandleHistory } from "../src/lib/analysis/okx.js";
import { zScore } from "../src/lib/analysis/ta.js";
import { writeFileSync, mkdirSync } from "node:fs";

const SYMBOL = "ETH";
const TIMEFRAME = "4h";
const Z_PERIOD = 20;
const WARMUP = 60; // >> Z_PERIOD so the rolling mean/stddev isn't seeded off a near-empty window
const HISTORY_BARS = 1500; // ~250 days of 4H candles, same window backtest-channel-midline.js uses

// OKX spot, regular tier: 0.10% taker per side -- same round-trip assumption
// every other script/the in-app engine uses.
const TAKER_FEE_PCT = 0.1;
const ROUNDTRIP_TAKER_PCT = TAKER_FEE_PCT * 2;

function wilsonInterval(wins, n, z = 1.96) {
  if (n === 0) return [0, 0];
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(center - margin) / denom, (center + margin) / denom];
}

// Same formula backtestStats.js's maxDrawdownPct/calmarRatio use (added to
// the in-app engine this session) -- kept local here rather than imported
// since these standalone scripts are meant to iterate independently of the
// browser bundle.
function maxDrawdownPct(trades) {
  let equity = 1;
  let peak = 1;
  let maxDd = 0;
  for (const t of trades) {
    equity *= 1 + t.netPct / 100;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, (peak - equity) / peak);
  }
  return maxDd * 100;
}

function calmarRatio(trades, compoundedPct, maxDd) {
  if (trades.length === 0 || maxDd === 0) return null;
  const spanMs = new Date(trades.at(-1).exitTime) - new Date(trades[0].entryTime);
  const years = spanMs / (365.25 * 24 * 60 * 60 * 1000);
  if (years < 1 / 365.25) return null;
  const cagr = (Math.pow(1 + compoundedPct / 100, 1 / years) - 1) * 100;
  return cagr / maxDd;
}

function closeTrade(position, bar, exitIndex) {
  const rawPct = ((bar.close - position.entryClose) / position.entryClose) * 100; // long-only
  const netPct = rawPct - ROUNDTRIP_TAKER_PCT;
  return {
    entryTime: position.entryTime,
    exitTime: bar.time,
    entryClose: position.entryClose,
    exitClose: bar.close,
    zAtEntry: position.zAtEntry,
    barsHeld: exitIndex - position.entryIndex,
    rawPct,
    netPct,
    outcome: netPct > 0 ? "win" : netPct < 0 ? "loss" : "breakeven",
  };
}

function simulate(candles) {
  const trades = [];
  let position = null;

  for (let i = WARMUP; i < candles.length; i++) {
    const bar = candles[i];
    const closes = candles.slice(0, i + 1).map((c) => c.close); // no lookahead
    const z = zScore(closes, Z_PERIOD);
    if (z == null) continue;

    if (position) {
      if (z <= 0) {
        trades.push(closeTrade(position, bar, i));
        position = null;
      }
      continue;
    }

    if (z > 1) {
      position = { entryIndex: i, entryTime: bar.time, entryClose: bar.close, zAtEntry: z };
    }
  }

  // A position still open at the end of the data has no realized outcome --
  // excluded rather than scored, same as backtest-channel-midline.js.
  return trades;
}

function summarize(label, trades) {
  const n = trades.length;
  const wins = trades.filter((t) => t.outcome === "win");
  const losses = trades.filter((t) => t.outcome === "loss");
  const winRate = n ? wins.length / n : 0;
  const [lo, hi] = wilsonInterval(wins.length, n);
  const avgWinPct = wins.length ? wins.reduce((s, t) => s + t.netPct, 0) / wins.length : 0;
  const avgLossPct = losses.length ? losses.reduce((s, t) => s + t.netPct, 0) / losses.length : 0;
  const expectancyPct = n ? trades.reduce((s, t) => s + t.netPct, 0) / n : 0;
  const avgBarsHeld = n ? trades.reduce((s, t) => s + t.barsHeld, 0) / n : 0;
  const compoundedPct = (trades.reduce((equity, t) => equity * (1 + t.netPct / 100), 1) - 1) * 100;
  const maxDd = maxDrawdownPct(trades);
  const calmar = calmarRatio(trades, compoundedPct, maxDd);

  console.log(`\n--- ${label} ---`);
  console.log(`trades: ${n}`);
  if (n) {
    console.log(`win rate (net of fees): ${(winRate * 100).toFixed(1)}%  (95% CI: ${(lo * 100).toFixed(1)}%-${(hi * 100).toFixed(1)}%)`);
    console.log(`avg win: +${avgWinPct.toFixed(2)}%  avg loss: ${avgLossPct.toFixed(2)}%  expectancy: ${expectancyPct >= 0 ? "+" : ""}${expectancyPct.toFixed(2)}%/trade`);
    console.log(`avg bars held: ${avgBarsHeld.toFixed(1)} (${((avgBarsHeld * 4) / 24).toFixed(1)} days)`);
    console.log(`compounded return, net of fees: ${compoundedPct >= 0 ? "+" : ""}${compoundedPct.toFixed(1)}%`);
    console.log(`max drawdown: -${maxDd.toFixed(1)}%  Calmar ratio: ${calmar != null ? calmar.toFixed(2) : "n/a"}`);
  }
  return { label, n, wins: wins.length, winRate, ci: [lo, hi], avgWinPct, avgLossPct, expectancyPct, avgBarsHeld, compoundedPct, maxDrawdownPct: maxDd, calmarRatio: calmar };
}

async function main() {
  console.log(`Fetching ${HISTORY_BARS} x ${TIMEFRAME} candles for ${SYMBOL}...`);
  const candles = await fetchCandleHistory(SYMBOL, TIMEFRAME, HISTORY_BARS);
  console.log(`Got ${candles.length} candles, ${new Date(candles[0].time).toISOString().slice(0, 10)} to ${new Date(candles.at(-1).time).toISOString().slice(0, 10)}`);

  const trades = simulate(candles);

  console.log(`\n=== Z-score momentum wave (buy z>${1}, sell z<=0) — ${SYMBOL} ${TIMEFRAME} — period ${Z_PERIOD} ===`);
  const overall = summarize("overall", trades);

  const tradeable = candles.slice(WARMUP);
  const buyHoldPct = ((tradeable.at(-1).close - tradeable[0].close) / tradeable[0].close) * 100;
  console.log(`\nBuy-and-hold ${SYMBOL} over the same window: ${buyHoldPct >= 0 ? "+" : ""}${buyHoldPct.toFixed(1)}%`);

  mkdirSync("backtests", { recursive: true });
  const outPath = `backtests/zscore-momentum-wave-${SYMBOL.toLowerCase()}-${TIMEFRAME}-${new Date().toISOString().slice(0, 10)}.json`;
  writeFileSync(
    outPath,
    JSON.stringify({ generatedAt: new Date().toISOString(), symbol: SYMBOL, timeframe: TIMEFRAME, zPeriod: Z_PERIOD, summary: overall, buyHoldPct, trades }, null, 2)
  );
  console.log(`\nRaw trades written to ${outPath}`);
}

main();
