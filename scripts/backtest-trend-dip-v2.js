// Backtests the user's hand-edited variant of the "Trend dip-buy, ATR
// stop/target exit" preset (TREND_DIP_ATR_EXIT_CODE in StrategiesPanel.jsx),
// which itself is validated positive on ETH/BTC 4H (+28.2%/+2.3% compounded).
// This variant changes three things at once vs. the validated version:
//   1. Stop/target widened from 1.5x/2.5x ATR to 2.0x/3.5x ATR.
//   2. Entry loosened: RSI<45 OR touch of the *lower* Bollinger band (was:
//      RSI<52 AND close at the *basis*/mid band) -- different trigger shape
//      entirely, not just a threshold tweak.
//   3. Re-adds an EMA20/50 dead-cross "trend reversal" exit on top of the
//      ATR stop/target.
//
// (3) is the one worth flagging before even running this: the preset's own
// comment says an earlier version WITH a trend-breakdown exit clause (a
// different but related idea -- "close crosses below EMA50" rather than an
// EMA20/50 cross) was tested and dropped because it was net negative: 60-70%
// of trades closed a single bar after entry (entries land near the EMA/basis
// already, so the very next bar often re-triggers a "reversal" read) versus
// ATR-only exits holding ~12 bars and working. Running this to find out
// honestly whether this specific dead-cross variant has the same problem,
// not assuming it does.
//
// Runs the pasted code exactly as given (new Function("ctx", code), same as
// the in-app worker) against real ETH candles on both 4H (the validated
// timeframe) and 1D (what the user actually tried and saw fail), with the
// same one-bar-lag fill + 0.2% roundtrip fee the real engine uses
// (src/workers/strategyWorker.js), so results are directly comparable to
// what "Run backtest" in the app would show.
import { fetchCandleHistory } from "../src/lib/analysis/okx.js";
import { fetchFearGreedHistory } from "../src/lib/analysis/fearGreed.js";
import { alignFearGreedToBars } from "../src/lib/analysis/fearGreed.js";
import * as ta from "../src/lib/analysis/ta.js";
import { writeFileSync, mkdirSync } from "node:fs";

const HISTORY_BARS = 1500;
const WARMUP_BARS = 60;
const ROUNDTRIP_FEE_PCT = 0.2; // matches strategyEngine.js's ROUNDTRIP_FEE_PCT

const STRATEGY_CODE = `
const bars = ctx.bars;
if (bars.length < 60) return;

const closes = bars.map(b => b.close);

const ema20 = ctx.ta.ema(closes, 20);
const ema50 = ctx.ta.ema(closes, 50);
const rsi = ctx.ta.rsi(closes, 14);
const bb = ctx.ta.bollingerBands(closes, 20, 2);
const atr = ctx.ta.atr(bars, 14);

const currentClose = closes.at(-1);
const currentEma20 = ema20.at(-1);
const pastEma20 = ema20.at(-2);
const currentEma50 = ema50.at(-1);
const pastEma50 = ema50.at(-2);
const currentRsi = rsi.at(-1);

if (currentEma20 === null || currentEma50 === null || currentRsi === null || !bb || !atr) {
  return;
}

const fg = ctx.fearGreed.at(-1);
const fgVal = fg ? fg.value : 50;

const pos = ctx.position;

if (pos) {
  const entry = pos.entryPrice;

  if (pos.direction === "long") {
    const stop = entry - (2.0 * atr);
    const tp = entry + (3.5 * atr);
    const trendReversal = currentEma20 < currentEma50 && pastEma20 >= pastEma50;
    const targetOrStopHit = currentClose <= stop || currentClose >= tp;
    if (trendReversal || targetOrStopHit) {
      return "close";
    }
  } else if (pos.direction === "short") {
    const stop = entry + (2.0 * atr);
    const tp = entry - (3.5 * atr);
    const trendReversal = currentEma20 > currentEma50 && pastEma20 <= pastEma50;
    const targetOrStopHit = currentClose >= stop || currentClose <= tp;
    if (trendReversal || targetOrStopHit) {
      return "close";
    }
  }
  return;
}

const isUptrend = currentEma20 > currentEma50;
const isDowntrend = currentEma20 < currentEma50;

const isNotExtremeGreed = fgVal < 75;
const isNotExtremeFear = fgVal > 25;

const isLongPullback = currentRsi < 45 || currentClose <= bb.lower;
const isShortBounce = currentRsi > 55 || currentClose >= bb.upper;

if (isUptrend && isLongPullback && isNotExtremeGreed) {
  return { signal: "long", stop: currentClose - (2.0 * atr), target: currentClose + (3.5 * atr) };
}

if (isDowntrend && isShortBounce && isNotExtremeFear) {
  return { signal: "short", stop: currentClose + (2.0 * atr), target: currentClose - (3.5 * atr) };
}
`;

function normalizeSignal(raw) {
  if (raw && typeof raw === "object") return { direction: raw.signal ?? null, meta: raw.meta ?? null };
  return { direction: raw ?? null, meta: null };
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
    netPct,
    outcome: netPct > 0 ? "win" : netPct < 0 ? "loss" : "breakeven",
  };
}

// Same shape as strategyWorker.js's backtest loop: one bar of fill lag (a
// signal computed off bar i fills at bar i+1's open), single open position.
function simulate(candles, fearGreed, code) {
  const userFn = new Function("ctx", code);
  const trades = [];
  let position = null;
  let pendingAction = null;

  for (let i = WARMUP_BARS; i < candles.length; i++) {
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
        if (!position) {
          position = { direction: pendingAction, entryIndex: i, entryTime: bar.time, entryClose: bar.open };
        }
      }
      pendingAction = null;
    }

    let raw;
    try {
      raw = userFn({
        bars: candles.slice(0, i + 1),
        position: position ? { direction: position.direction, entryIndex: position.entryIndex, entryPrice: position.entryClose } : null,
        ta,
        mtf: {},
        fearGreed: fearGreed.slice(0, i + 1),
      });
    } catch (err) {
      throw new Error(`Strategy threw at bar ${i} (${new Date(bar.time).toISOString()}): ${err.message}`);
    }

    const { direction } = normalizeSignal(raw);
    if (direction === "close" || direction === "long" || direction === "short") pendingAction = direction;
  }

  return trades;
}

function wilsonInterval(wins, n, z = 1.96) {
  if (n === 0) return [0, 0];
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(center - margin) / denom, (center + margin) / denom];
}

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
    console.log(`win rate: ${(winRate * 100).toFixed(1)}%  (95% CI: ${(lo * 100).toFixed(1)}%-${(hi * 100).toFixed(1)}%)`);
    console.log(`avg win: +${avgWinPct.toFixed(2)}%  avg loss: ${avgLossPct.toFixed(2)}%  expectancy: ${expectancyPct >= 0 ? "+" : ""}${expectancyPct.toFixed(2)}%/trade`);
    console.log(`avg bars held: ${avgBarsHeld.toFixed(1)}`);
    console.log(`compounded: ${compoundedPct >= 0 ? "+" : ""}${compoundedPct.toFixed(1)}%   max drawdown: -${maxDd.toFixed(1)}%   Calmar: ${calmar != null ? calmar.toFixed(2) : "n/a"}`);
    const closeExits = trades.filter((t) => t.barsHeld <= 1).length;
    console.log(`trades closed within 1 bar of entry: ${closeExits}/${n} (${((closeExits / n) * 100).toFixed(0)}%) -- the failure mode the dropped trend-breakdown exit had`);
  }
  return { label, n, winRate, ci: [lo, hi], avgWinPct, avgLossPct, expectancyPct, avgBarsHeld, compoundedPct, maxDrawdownPct: maxDd, calmarRatio: calmar };
}

async function runFor(symbol, timeframe) {
  console.log(`\n=== ${symbol} ${timeframe} ===`);
  const candles = await fetchCandleHistory(symbol, timeframe, HISTORY_BARS);
  console.log(`Got ${candles.length} candles, ${new Date(candles[0].time).toISOString().slice(0, 10)} to ${new Date(candles.at(-1).time).toISOString().slice(0, 10)}`);
  const fgHistory = await fetchFearGreedHistory();
  const fearGreed = alignFearGreedToBars(fgHistory, candles);

  const trades = simulate(candles, fearGreed, STRATEGY_CODE);
  const summary = summarize(`${symbol} ${timeframe}`, trades);
  return { symbol, timeframe, summary, trades };
}

// ETH 4H already ran positive (+20.9%, Calmar 2.35, n=23) and ETH 1D already
// confirmed negative (matches the user's own numbers exactly) -- this pass
// checks whether the 4H result generalizes to BTC/SOL too, same discipline
// the original preset was validated with (BTC/ETH/SOL, not ETH alone), or
// whether n=23 on ETH alone was a thin, symbol-specific result.
async function main() {
  const results = [];
  for (const symbol of ["BTC", "ETH", "SOL"]) {
    results.push(await runFor(symbol, "4h"));
  }

  mkdirSync("backtests", { recursive: true });
  const outPath = `backtests/trend-dip-v2-4h-multisymbol-${new Date().toISOString().slice(0, 10)}.json`;
  writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
  console.log(`\nRaw trades written to ${outPath}`);
}

main();
