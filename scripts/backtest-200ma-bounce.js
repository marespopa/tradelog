// Backtests a "touch the 200-period MA and bounce" rule: in an established
// uptrend (price already above EMA200), a bar wicks down to touch EMA200 but
// closes back above it -> long, entering at that close. Mirror for a
// downtrend touch from below -> short. Stop is placed just beyond the touch
// bar's own wick (the level that invalidates the bounce), target is a fixed
// 2R off that risk — a completely different rule shape from the Bollinger/
// RSI mean-reversion script (no shared parameters), reported the same
// honest way: whatever the rule as-written produces, no tuning to force a
// win.
import { fetchCandleHistory } from "../src/lib/analysis/okx.js";
import { ema, atr } from "../src/lib/analysis/ta.js";
import { writeFileSync, mkdirSync } from "node:fs";

const SYMBOL = "ETH";
const TIMEFRAME = "4h";
const HISTORY_BARS = 1500; // ~250 days of 4H candles
const EMA_PERIOD = 200;
const WARMUP = EMA_PERIOD;
const TOUCH_PCT = 0.003; // 0.3% of price counts as "touching" the MA — same tolerance scan-channel-setups.js uses for band touches
const STOP_ATR_MULT = 1; // stop placed 1x ATR beyond the touch bar's own wick, not right on it
const TARGET_RR = 2; // fixed 2R target off that risk
const MAX_HOLD_BARS = 60; // ~10 days; still-open trades past this are excluded as inconclusive, not scored

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
  let position = null; // { direction, entryIndex, entryTime, entryPrice, stop, target }

  for (let i = WARMUP; i < candles.length; i++) {
    const bars = candles.slice(0, i + 1);
    const bar = bars.at(-1);
    const prevBar = bars.at(-2);
    if (!prevBar) continue;

    if (position) {
      const { direction, stop, target, entryPrice } = position;
      const hitStop = direction === "long" ? bar.low <= stop : bar.high >= stop;
      const hitTarget = direction === "long" ? bar.high >= target : bar.low <= target;
      const barsHeld = i - position.entryIndex;

      // Both hit in the same bar: assume stop first (can't tell from OHLC
      // alone which came first) rather than let ambiguous bars flatter the
      // win rate.
      if (hitStop || hitTarget) {
        const exitPrice = hitStop ? stop : target;
        const rawPct = ((exitPrice - entryPrice) / entryPrice) * (direction === "long" ? 1 : -1) * 100;
        const netPct = rawPct - ROUNDTRIP_TAKER_PCT;
        trades.push({
          direction,
          entryTime: position.entryTime,
          exitTime: bar.time,
          entryPrice,
          exitPrice,
          barsHeld,
          netPct,
          outcome: netPct > 0 ? "win" : netPct < 0 ? "loss" : "breakeven",
        });
        position = null;
      } else if (barsHeld >= MAX_HOLD_BARS) {
        position = null; // timeout — excluded from stats, not scored
      }
      continue;
    }

    const closes = bars.map((b) => b.close);
    const ema200 = ema(closes, EMA_PERIOD).at(-1);
    const atrValue = atr(bars, 14);
    if (ema200 == null || atrValue == null) continue;

    const longTouch = bar.low <= ema200 * (1 + TOUCH_PCT) && bar.close > ema200 && prevBar.close > ema200;
    const shortTouch = bar.high >= ema200 * (1 - TOUCH_PCT) && bar.close < ema200 && prevBar.close < ema200;

    if (longTouch) {
      const stop = bar.low - STOP_ATR_MULT * atrValue;
      const risk = bar.close - stop;
      if (risk > 0) {
        position = { direction: "long", entryIndex: i, entryTime: bar.time, entryPrice: bar.close, stop, target: bar.close + TARGET_RR * risk };
      }
    } else if (shortTouch) {
      const stop = bar.high + STOP_ATR_MULT * atrValue;
      const risk = stop - bar.close;
      if (risk > 0) {
        position = { direction: "short", entryIndex: i, entryTime: bar.time, entryPrice: bar.close, stop, target: bar.close - TARGET_RR * risk };
      }
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

  console.log(`\n=== 200MA touch/bounce — ${SYMBOL} ${TIMEFRAME} ===`);
  const overall = summarize("overall", trades);
  summarize("long only", trades.filter((t) => t.direction === "long"));
  summarize("short only", trades.filter((t) => t.direction === "short"));

  const tradeable = candles.slice(WARMUP);
  const buyHoldPct = ((tradeable.at(-1).close - tradeable[0].close) / tradeable[0].close) * 100;
  console.log(`\nBuy-and-hold ${SYMBOL} over the same window: ${buyHoldPct >= 0 ? "+" : ""}${buyHoldPct.toFixed(1)}%`);

  mkdirSync("backtests", { recursive: true });
  const outPath = `backtests/200ma-bounce-${SYMBOL.toLowerCase()}-${TIMEFRAME}-${new Date().toISOString().slice(0, 10)}.json`;
  writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), symbol: SYMBOL, timeframe: TIMEFRAME, summary: overall, buyHoldPct, trades }, null, 2));
  console.log(`\nRaw trades written to ${outPath}`);
}

main();
