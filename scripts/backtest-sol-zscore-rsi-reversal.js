// Backtests a user-authored ctx-contract strategy (z-score + RSI extreme
// reversal, ATR stop/target, Bollinger-basis profit lock, Fear & Greed
// entry filter) against real SOL 4H history, run through the exact same
// bar-by-bar loop src/workers/strategyWorker.js uses in the app (next-bar
// open fill — one bar of lag — 0.2% roundtrip fee), so this node run is a
// faithful stand-in for clicking "Run backtest" in the Strategies tab.
import { fetchCandleHistory } from "../src/lib/analysis/okx.js";
import { fetchFearGreedHistory, alignFearGreedToBars } from "../src/lib/analysis/fearGreed.js";
import * as ta from "../src/lib/analysis/ta.js";
import { writeFileSync, mkdirSync } from "node:fs";

const SYMBOL = "SOL";
const TIMEFRAME = "4h";
const HISTORY_BARS = 3600; // ~600 days -- matches backtest-sol-4h-search.js's window for a comparable sample size
const WARMUP = 60; // matches the strategy's own `bars.length < 60` gate
const ROUNDTRIP_FEE_PCT = 0.2;

const CODE = `
const bars = ctx.bars;
  if (bars.length < 60) return;

  const closes = bars.map(b => b.close);

  // 1. Indicators
  const rsi = ctx.ta.rsi(closes, 14);
  const currentZ = ctx.ta.zScore(closes, 20); // Statistical distance from mean -- already the latest reading, not an array
  const atr = ctx.ta.atr(bars, 14);
  const bb = ctx.ta.bollingerBands(closes, 20, 2);

  const currentClose = closes.at(-1);
  const currentRsi = rsi.at(-1);

  if (currentRsi === null || currentZ === null || !atr || !bb) {
    return;
  }

  // 2. Sentiment Reading
  const fg = ctx.fearGreed.at(-1);
  const fgVal = fg ? fg.value : 50;

  const pos = ctx.position;

  // 3. Position Exits
  if (pos) {
    const entry = pos.entryPrice;

    if (pos.direction === "long") {
      const initialStop = entry - (1.8 * atr);
      const profitTarget = entry + (3.5 * atr);

      // Trailing Exit: Close if price drops back to mean (bb.basis) after profit,
      // or if initial stop / TP hit
      if (currentClose <= initialStop || currentClose >= profitTarget) {
        return "close";
      }
      // Reached middle band -> lock in profits
      if (currentClose >= bb.basis && currentRsi > 60) {
        return "close";
      }
    } else if (pos.direction === "short") {
      const initialStop = entry + (1.8 * atr);
      const profitTarget = entry - (3.5 * atr);

      if (currentClose >= initialStop || currentClose <= profitTarget) {
        return "close";
      }
      // Reached middle band -> lock in profits
      if (currentClose <= bb.basis && currentRsi < 40) {
        return "close";
      }
    }
    return;
  }

  // 4. Entry Signals (Extreme Reversals)

  // Long Condition: Price is severely stretched downward (Z-Score <= -1.8) + RSI < 38
  // + Market isn't in absolute panic breakdown (Fear > 15)
  if (currentZ <= -1.8 && currentRsi < 38 && fgVal > 15) {
    return "long";
  }

  // Short Condition: Price is severely stretched upward (Z-Score >= 1.8) + RSI > 62
  // + Market isn't in mania extreme (Greed < 85)
  if (currentZ >= 1.8 && currentRsi > 62 && fgVal < 85) {
    return "short";
  }
`;

function wilsonInterval(wins, n, z = 1.96) {
  if (n === 0) return [0, 0];
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(center - margin) / denom, (center + margin) / denom];
}

function closeTrade(position, fillPrice, exitBar, exitIndex) {
  const rawPct = ((fillPrice - position.entryClose) / position.entryClose) * (position.direction === "long" ? 1 : -1) * 100;
  const netPct = rawPct - ROUNDTRIP_FEE_PCT;
  return {
    direction: position.direction,
    entryTime: position.entryTime,
    exitTime: exitBar.time,
    entryClose: position.entryClose,
    exitClose: fillPrice,
    barsHeld: exitIndex - position.entryIndex,
    rawPct,
    netPct,
    outcome: netPct > 0 ? "win" : netPct < 0 ? "loss" : "breakeven",
  };
}

// Mirrors strategyWorker.js's backtest loop exactly: a signal computed from
// bar i fills at bar i+1's open (one bar of lag), a signal on the last bar
// is dropped (no next bar to fill on), and a final open position is left
// unrealized rather than force-closed.
function simulate(userFn, candles, fearGreed) {
  const trades = [];
  let position = null;
  let pendingAction = null;

  for (let i = WARMUP; i < candles.length; i++) {
    const bar = candles[i];

    if (pendingAction) {
      if (pendingAction === "close") {
        if (position) {
          trades.push(closeTrade(position, bar.open, bar, i));
          position = null;
        }
      } else {
        if (position && position.direction !== pendingAction) {
          trades.push(closeTrade(position, bar.open, bar, i));
          position = null;
        }
        if (!position) position = { direction: pendingAction, entryIndex: i, entryTime: bar.time, entryClose: bar.open };
      }
      pendingAction = null;
    }

    const raw = userFn({
      bars: candles.slice(0, i + 1),
      position: position ? { direction: position.direction, entryIndex: position.entryIndex, entryPrice: position.entryClose } : null,
      ta,
      fearGreed: fearGreed.slice(0, i + 1),
    });

    const direction = raw && typeof raw === "object" ? raw.signal ?? null : raw ?? null;
    if (direction === "close" || direction === "long" || direction === "short") pendingAction = direction;
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

  console.log("Fetching Fear & Greed history...");
  const fgHistory = await fetchFearGreedHistory();
  const fearGreed = alignFearGreedToBars(fgHistory, candles);

  const userFn = new Function("ctx", CODE);
  const trades = simulate(userFn, candles, fearGreed);

  console.log(`\n=== Z-score/RSI extreme reversal (user strategy) — ${SYMBOL} ${TIMEFRAME} ===`);
  const overall = summarize("overall", trades);
  summarize("long only", trades.filter((t) => t.direction === "long"));
  summarize("short only", trades.filter((t) => t.direction === "short"));

  const tradeable = candles.slice(WARMUP);
  const buyHoldPct = ((tradeable.at(-1).close - tradeable[0].close) / tradeable[0].close) * 100;
  console.log(`\nBuy-and-hold ${SYMBOL} over the same window: ${buyHoldPct >= 0 ? "+" : ""}${buyHoldPct.toFixed(1)}%`);

  mkdirSync("backtests", { recursive: true });
  const outPath = `backtests/zscore-rsi-reversal-${SYMBOL.toLowerCase()}-${TIMEFRAME}-${new Date().toISOString().slice(0, 10)}.json`;
  writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), symbol: SYMBOL, timeframe: TIMEFRAME, summary: overall, buyHoldPct, trades }, null, 2));
  console.log(`\nRaw trades written to ${outPath}`);
}

main();
