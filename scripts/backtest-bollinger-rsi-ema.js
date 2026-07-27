// Backtests the exact bollinger/RSI/EMA200 mean-reversion rule the user
// wrote for the in-app Strategies tab, run here as a standalone node script
// so it can be checked against real history without the browser sandbox.
// No parameter tuning performed to chase a good result — this reports
// whatever the rule as-written actually produced.
//
// Rule: in a bullish regime (close > EMA200), buy when the prior bar
// pierced the lower Bollinger Band and RSI < 32. In a bearish regime,
// mirror on the short side. Exit at the Bollinger basis (mean reversion
// target) or a 2x-ATR stop against the entry, whichever comes first.
import { fetchCandleHistory } from "../src/lib/analysis/okx.js";
import { ema, rsi, bollingerBands, atr } from "../src/lib/analysis/ta.js";
import { writeFileSync, mkdirSync } from "node:fs";

const SYMBOL = "ETH";
const TIMEFRAME = "4h";
const HISTORY_BARS = 1500; // ~250 days of 4H candles
const WARMUP = 200; // matches the strategy's own `ctx.bars.length < 200` gate

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
  let position = null; // { direction, entryIndex, entryTime, entryPrice }

  for (let i = WARMUP; i < candles.length; i++) {
    const bars = candles.slice(0, i + 1);
    const bar = bars.at(-1);
    const prevBar = bars.at(-2);
    if (!prevBar) continue;

    const closes = bars.map((b) => b.close);
    const ema200 = ema(closes, 200).at(-1);
    const rsiValue = rsi(closes, 14).at(-1);
    const bb = bollingerBands(closes, 20, 2);
    const atrValue = atr(bars, 14);
    if (ema200 == null || rsiValue == null || !bb || atrValue == null) continue;

    if (position) {
      const { direction, entryPrice } = position;
      const hitExit =
        direction === "long"
          ? bar.close >= bb.basis || bar.close <= entryPrice - 2 * atrValue
          : bar.close <= bb.basis || bar.close >= entryPrice + 2 * atrValue;
      if (hitExit) {
        const rawPct = ((bar.close - entryPrice) / entryPrice) * (direction === "long" ? 1 : -1) * 100;
        const netPct = rawPct - ROUNDTRIP_TAKER_PCT;
        trades.push({
          direction,
          entryTime: position.entryTime,
          exitTime: bar.time,
          entryPrice,
          exitPrice: bar.close,
          barsHeld: i - position.entryIndex,
          netPct,
          outcome: netPct > 0 ? "win" : netPct < 0 ? "loss" : "breakeven",
        });
        position = null;
      }
      continue;
    }

    const isBullishRegime = bar.close > ema200;
    const isBearishRegime = bar.close < ema200;

    if (isBullishRegime && prevBar.close <= bb.lower && rsiValue < 32) {
      position = { direction: "long", entryIndex: i, entryTime: bar.time, entryPrice: bar.close };
    } else if (isBearishRegime && prevBar.close >= bb.upper && rsiValue > 68) {
      position = { direction: "short", entryIndex: i, entryTime: bar.time, entryPrice: bar.close };
    }
  }

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
  const compoundedPct = (trades.reduce((eq, t) => eq * (1 + t.netPct / 100), 1) - 1) * 100;

  console.log(`\n--- ${label} ---`);
  console.log(`trades: ${n}`);
  if (n) {
    console.log(`win rate: ${(winRate * 100).toFixed(1)}%  (95% CI: ${(lo * 100).toFixed(1)}%-${(hi * 100).toFixed(1)}%)`);
    console.log(`avg win: +${avgWinPct.toFixed(2)}%  avg loss: ${avgLossPct.toFixed(2)}%  expectancy: ${expectancyPct >= 0 ? "+" : ""}${expectancyPct.toFixed(2)}%/trade`);
    console.log(`avg bars held: ${avgBarsHeld.toFixed(1)} (${((avgBarsHeld * 4) / 24).toFixed(1)} days)`);
    console.log(`compounded return, net of fees: ${compoundedPct >= 0 ? "+" : ""}${compoundedPct.toFixed(1)}%`);
  }
  return { label, n, wins: wins.length, winRate, ci: [lo, hi], avgWinPct, avgLossPct, expectancyPct, avgBarsHeld, compoundedPct };
}

async function main() {
  console.log(`Fetching ${HISTORY_BARS} x ${TIMEFRAME} candles for ${SYMBOL}...`);
  const candles = await fetchCandleHistory(SYMBOL, TIMEFRAME, HISTORY_BARS);
  console.log(`Got ${candles.length} candles, ${new Date(candles[0].time).toISOString().slice(0, 10)} to ${new Date(candles.at(-1).time).toISOString().slice(0, 10)}`);

  const trades = simulate(candles);

  console.log(`\n=== Bollinger/RSI/EMA200 mean reversion — ${SYMBOL} ${TIMEFRAME} ===`);
  const overall = summarize("overall", trades);
  summarize("long only", trades.filter((t) => t.direction === "long"));
  summarize("short only", trades.filter((t) => t.direction === "short"));

  const tradeable = candles.slice(WARMUP);
  const buyHoldPct = ((tradeable.at(-1).close - tradeable[0].close) / tradeable[0].close) * 100;
  console.log(`\nBuy-and-hold ${SYMBOL} over the same window: ${buyHoldPct >= 0 ? "+" : ""}${buyHoldPct.toFixed(1)}%`);

  mkdirSync("backtests", { recursive: true });
  const outPath = `backtests/bollinger-rsi-ema-${SYMBOL.toLowerCase()}-${TIMEFRAME}-${new Date().toISOString().slice(0, 10)}.json`;
  writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), symbol: SYMBOL, timeframe: TIMEFRAME, summary: overall, buyHoldPct, trades }, null, 2));
  console.log(`\nRaw trades written to ${outPath}`);
}

main();
