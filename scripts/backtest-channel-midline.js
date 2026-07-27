// Backtests the midline-cross channel rule: SELL (go short) when price
// crosses down through the linear-regression channel's mid line, BUY (go
// long) when it crosses back up through it. This is a *different* signal
// from scan-channel-setups.js, which trades touches of the outer bands
// (mean-reversion off the edges) — this one trades the mid line itself and
// is always in the market, flipping direction on each opposite cross.
//
// Walk-forward, no lookahead: the channel at bar i is recomputed from
// candles[0..i] only (same linearRegressionChannel the live Scan panel
// uses), so "crossed the mid" is judged against the channel as it actually
// read at that bar, not with hindsight from a channel fitted over the whole
// history.
import { fetchCandleHistory } from "../src/lib/analysis/okx.js";
import { linearRegressionChannel } from "../src/lib/analysis/ta.js";
import { writeFileSync, mkdirSync } from "node:fs";

const SYMBOL = "ETH";
const TIMEFRAME = "4h";
const LOOKBACK = 60; // regression window — same as scan-channel-setups.js's CHANNEL_LOOKBACK (~10 days of 4H bars)
const HISTORY_BARS = 1500; // ~250 days of 4H candles

// OKX spot, regular tier: 0.08% maker / 0.10% taker per side — a flip
// system pays a round-trip fee on every single trade (close old + open
// new), so it needs to be netted out rather than reported on gross moves.
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

function simulate(candles) {
  const trades = [];
  let prevBand = null;
  let position = null; // { direction, entryIndex, entryTime, entryClose }

  for (let i = LOOKBACK; i < candles.length; i++) {
    const channel = linearRegressionChannel(candles.slice(0, i + 1), { lookback: LOOKBACK });
    if (!channel) continue;
    const currBand = channel.at(-1);
    const bar = candles[i];

    if (prevBand) {
      const prevClose = candles[i - 1].close;
      const crossDown = prevClose >= prevBand.mid && bar.close < currBand.mid;
      const crossUp = prevClose <= prevBand.mid && bar.close > currBand.mid;

      if (crossDown || crossUp) {
        const newDirection = crossDown ? "short" : "long";
        if (position && position.direction !== newDirection) {
          trades.push(closeTrade(position, bar, i));
          position = null;
        }
        if (!position) {
          position = { direction: newDirection, entryIndex: i, entryTime: bar.time, entryClose: bar.close };
        }
      }
    }

    prevBand = currBand;
  }

  // A position still open at the end of the data has no realized outcome —
  // excluded from stats rather than scored, same reasoning as other
  // backtests excluding timeouts.
  return trades;
}

function closeTrade(position, bar, exitIndex) {
  const rawPct = ((bar.close - position.entryClose) / position.entryClose) * (position.direction === "long" ? 1 : -1) * 100;
  const netPct = rawPct - ROUNDTRIP_TAKER_PCT;
  return {
    direction: position.direction,
    entryTime: position.entryTime,
    exitTime: bar.time,
    entryClose: position.entryClose,
    exitClose: bar.close,
    barsHeld: exitIndex - position.entryIndex,
    rawPct,
    netPct,
    outcome: netPct > 0 ? "win" : netPct < 0 ? "loss" : "breakeven",
  };
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

  console.log(`\n--- ${label} ---`);
  console.log(`trades: ${n}`);
  if (n) {
    console.log(`win rate (net of fees): ${(winRate * 100).toFixed(1)}%  (95% CI: ${(lo * 100).toFixed(1)}%-${(hi * 100).toFixed(1)}%)`);
    console.log(`avg win: +${avgWinPct.toFixed(2)}%  avg loss: ${avgLossPct.toFixed(2)}%  expectancy: ${expectancyPct >= 0 ? "+" : ""}${expectancyPct.toFixed(2)}%/trade`);
    console.log(`avg bars held: ${avgBarsHeld.toFixed(1)} (${((avgBarsHeld * 4) / 24).toFixed(1)} days)`);
    console.log(`compounded return over backtest, net of fees: ${compoundedPct >= 0 ? "+" : ""}${compoundedPct.toFixed(1)}%`);
  }
  return { label, n, wins: wins.length, winRate, ci: [lo, hi], avgWinPct, avgLossPct, expectancyPct, avgBarsHeld, compoundedPct };
}

async function main() {
  console.log(`Fetching ${HISTORY_BARS} x ${TIMEFRAME} candles for ${SYMBOL}...`);
  const candles = await fetchCandleHistory(SYMBOL, TIMEFRAME, HISTORY_BARS);
  console.log(`Got ${candles.length} candles, ${new Date(candles[0].time).toISOString().slice(0, 10)} to ${new Date(candles.at(-1).time).toISOString().slice(0, 10)}`);

  const trades = simulate(candles);

  console.log(`\n=== Channel midline cross — ${SYMBOL} ${TIMEFRAME} — lookback ${LOOKBACK} bars ===`);
  const overall = summarize("overall", trades);
  summarize("long only", trades.filter((t) => t.direction === "long"));
  summarize("short only", trades.filter((t) => t.direction === "short"));

  const tradeable = candles.slice(LOOKBACK);
  const buyHoldPct = ((tradeable.at(-1).close - tradeable[0].close) / tradeable[0].close) * 100;
  console.log(`\nBuy-and-hold ${SYMBOL} over the same window: ${buyHoldPct >= 0 ? "+" : ""}${buyHoldPct.toFixed(1)}%`);

  mkdirSync("backtests", { recursive: true });
  const outPath = `backtests/channel-midline-${SYMBOL.toLowerCase()}-${TIMEFRAME}-${new Date().toISOString().slice(0, 10)}.json`;
  writeFileSync(
    outPath,
    JSON.stringify({ generatedAt: new Date().toISOString(), symbol: SYMBOL, timeframe: TIMEFRAME, lookback: LOOKBACK, summary: overall, buyHoldPct, trades }, null, 2)
  );
  console.log(`\nRaw trades written to ${outPath}`);
}

main();
