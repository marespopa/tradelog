// Backtests the 4H SOL swing setups that survived a wider search: the
// original version of this script ran ten strategy shapes already proven
// out elsewhere in this repo against SOL specifically, since SOL was
// excluded from StrategiesPanel.jsx's TREND_DIP_ATR_EXIT_CODE preset after
// coming back negative there. Seven of the ten failed outright on SOL (RSI
// 30/70 reversion -0.17R, MACD-cross+trend-filter -0.17R, EMA20/50 cross
// -1.00R on 1 signal, neckline 0 signals, channel-midline flip
// -0.18%/trade, pure momentum flip -0.11%/trade, Bollinger/RSI/EMA200
// reversion only 7 signals — too few to call) and were dropped. Three
// cleared breakeven with a non-trivial sample and are kept here:
//   - EMA200 touch/bounce: n=51, 39.2% win rate vs. 33.3% breakeven,
//     +0.18R/trade — the strongest of the three, comparable margin to the
//     MTF setup's own validated +0.19R/trade (see mtfSetup.js).
//   - Z-score |z|>=2.5 mean reversion: n=90, 38.9% vs. 37.8% breakeven,
//     +0.03R/trade — thin edge, CI straddles breakeven.
//   - MTF Weekly/Daily/4H swing (2R): n=26, 34.6% vs. 33.3% breakeven,
//     +0.04R/trade — thin edge on a small sample; the 3R variant came back
//     flat (~0.00R) and isn't included.
import { fetchCandleHistory } from "../src/lib/analysis/okx.js";
import { buildDailyCandles, buildWeeklyCandles } from "../src/lib/analysis/timeframes.js";
import { findMtfSignal, buildTrade as buildMtfSignalTrade, MTF_WEEKLY_WARMUP_BARS } from "../src/lib/analysis/mtfSetup.js";
import { ema, atr, zScore, rollingMean } from "../src/lib/analysis/ta.js";
import { writeFileSync, mkdirSync } from "node:fs";

const SYMBOL = "SOL";
const TIMEFRAME = "4h";
const HISTORY_BARS = 3600; // ~600 days -> ~85 weeks, enough for weekly EMA20 (MTF setup) to settle
const MAX_HOLD_BARS = 90;
const DAY_MS = 86400000;
const WEEK_MS = DAY_MS * 7;

function wilsonInterval(wins, n, z = 1.96) {
  if (n === 0) return [0, 0];
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(center - margin) / denom, (center + margin) / denom];
}

const Z_THRESHOLD = 2.5;
function detectZscoreReversion(sub) {
  const closes = sub.map((c) => c.close);
  if (closes.length < 60) return null;
  const z = zScore(closes);
  if (z == null) return null;
  let direction = null;
  if (z >= Z_THRESHOLD) direction = "short";
  else if (z <= -Z_THRESHOLD) direction = "long";
  if (!direction) return null;
  const current = closes.at(-1);
  const atrVal = atr(sub);
  if (atrVal == null) return null;
  const target = rollingMean(closes);
  if (target == null) return null;
  const stopDistance = atrVal * 1.5;
  const stop = direction === "long" ? current - stopDistance : current + stopDistance;
  const risk = Math.abs(current - stop);
  if (risk <= 0) return null;
  const reward = Math.abs(target - current);
  if (reward <= 0) return null;
  return { direction, entry: current, stop, target, rr: reward / risk };
}

const MA200_TOUCH_PCT = 0.003;
const MA200_STOP_ATR_MULT = 1;
const MA200_TARGET_RR = 2;
function detectMa200Bounce(sub) {
  const bar = sub.at(-1);
  const prevBar = sub.at(-2);
  if (!prevBar) return null;
  const closes = sub.map((b) => b.close);
  const ema200 = ema(closes, 200).at(-1);
  const atrValue = atr(sub, 14);
  if (ema200 == null || atrValue == null) return null;

  const longTouch = bar.low <= ema200 * (1 + MA200_TOUCH_PCT) && bar.close > ema200 && prevBar.close > ema200;
  const shortTouch = bar.high >= ema200 * (1 - MA200_TOUCH_PCT) && bar.close < ema200 && prevBar.close < ema200;

  if (longTouch) {
    const stop = bar.low - MA200_STOP_ATR_MULT * atrValue;
    const risk = bar.close - stop;
    if (risk > 0) return { direction: "long", entry: bar.close, stop, target: bar.close + MA200_TARGET_RR * risk, rr: MA200_TARGET_RR };
  } else if (shortTouch) {
    const stop = bar.high + MA200_STOP_ATR_MULT * atrValue;
    const risk = stop - bar.close;
    if (risk > 0) return { direction: "short", entry: bar.close, stop, target: bar.close - MA200_TARGET_RR * risk, rr: MA200_TARGET_RR };
  }
  return null;
}

function simulateRR(candles, detect, warmup) {
  const trades = [];
  let openTrade = null;

  for (let i = warmup; i < candles.length; i++) {
    const bar = candles[i];

    if (openTrade) {
      const { direction, stop, target } = openTrade;
      const hitStop = direction === "long" ? bar.low <= stop : bar.high >= stop;
      const hitTarget = direction === "long" ? bar.high >= target : bar.low <= target;
      const barsHeld = i - openTrade.entryIndex;

      if (hitStop) {
        trades.push({ ...openTrade, outcome: "loss", exitTime: bar.time, barsHeld, realizedR: -1 });
        openTrade = null;
      } else if (hitTarget) {
        trades.push({ ...openTrade, outcome: "win", exitTime: bar.time, barsHeld, realizedR: openTrade.rr });
        openTrade = null;
      } else if (barsHeld >= MAX_HOLD_BARS) {
        trades.push({ ...openTrade, outcome: "timeout", exitTime: bar.time, barsHeld, realizedR: null });
        openTrade = null;
      }
      continue;
    }

    const signal = detect(candles.slice(0, i + 1));
    if (signal) openTrade = { entryIndex: i, entryTime: bar.time, ...signal };
  }

  return trades;
}

function summarizeRR(label, trades) {
  const resolved = trades.filter((t) => t.outcome !== "timeout");
  const wins = resolved.filter((t) => t.outcome === "win");
  const n = resolved.length;
  const winRate = n ? wins.length / n : 0;
  const [lo, hi] = wilsonInterval(wins.length, n);
  const avgWinR = wins.length ? wins.reduce((s, t) => s + t.realizedR, 0) / wins.length : 0;
  const breakevenWinRate = avgWinR > 0 ? 1 / (1 + avgWinR) : null;
  const expectancyR = n ? winRate * avgWinR - (1 - winRate) * 1 : 0;
  const timeouts = trades.length - n;

  console.log(`\n--- ${label} ---`);
  console.log(`signals: ${trades.length}  resolved: ${n}  timeouts(excluded): ${timeouts}`);
  console.log(`win rate: ${(winRate * 100).toFixed(1)}%  (95% CI: ${(lo * 100).toFixed(1)}%-${(hi * 100).toFixed(1)}%)`);
  console.log(`avg win: +${avgWinR.toFixed(2)}R  loss: -1R  breakeven needs: ${breakevenWinRate != null ? (breakevenWinRate * 100).toFixed(1) + "%" : "n/a"}`);
  console.log(`expectancy: ${expectancyR >= 0 ? "+" : ""}${expectancyR.toFixed(2)}R/trade`);
  return { label, n, wins: wins.length, winRate, ci: [lo, hi], avgWinR, breakevenWinRate, expectancyR, timeouts, totalSignals: trades.length };
}

// MTF weekly/daily/4H swing, resampled from the same 4H feed so there's no
// lookahead — see backtest-mtf-swing.js for the multi-symbol version this
// mirrors.
function simulateMtfSwing(candles4h, rMultiple, warmup) {
  const dailyFull = buildDailyCandles(candles4h);
  const weeklyFull = buildWeeklyCandles(dailyFull);
  const FOURH_TRIGGER_WINDOW = 300;

  const trades = [];
  let openTrade = null;
  let dailyIdx = 0;
  let weeklyIdx = 0;

  for (let i = warmup; i < candles4h.length; i++) {
    const bar = candles4h[i];
    while (dailyIdx < dailyFull.length && dailyFull[dailyIdx].time + DAY_MS <= bar.time) dailyIdx++;
    while (weeklyIdx < weeklyFull.length && weeklyFull[weeklyIdx].time + WEEK_MS <= bar.time) weeklyIdx++;

    if (openTrade) {
      const { direction, stop, target } = openTrade;
      const hitStop = direction === "long" ? bar.low <= stop : bar.high >= stop;
      const hitTarget = direction === "long" ? bar.high >= target : bar.low <= target;
      const barsHeld = i - openTrade.entryIndex;
      if (hitStop) {
        trades.push({ ...openTrade, outcome: "loss", exitTime: bar.time, barsHeld, realizedR: -1 });
        openTrade = null;
      } else if (hitTarget) {
        trades.push({ ...openTrade, outcome: "win", exitTime: bar.time, barsHeld, realizedR: openTrade.rr });
        openTrade = null;
      } else if (barsHeld >= MAX_HOLD_BARS) {
        trades.push({ ...openTrade, outcome: "timeout", exitTime: bar.time, barsHeld, realizedR: null });
        openTrade = null;
      }
      continue;
    }

    const closedDaily = dailyFull.slice(0, dailyIdx);
    const closedWeekly = weeklyFull.slice(0, weeklyIdx);
    const fourHWindow = candles4h.slice(Math.max(0, i - FOURH_TRIGGER_WINDOW + 1), i + 1);
    const trade = buildMtfSignalTrade(findMtfSignal(closedWeekly, closedDaily, fourHWindow), rMultiple);
    if (trade) openTrade = { entryIndex: i, entryTime: bar.time, ...trade };
  }

  return trades;
}

async function main() {
  console.log(`Fetching ${HISTORY_BARS} x ${TIMEFRAME} candles for ${SYMBOL}...`);
  const candles = await fetchCandleHistory(SYMBOL, TIMEFRAME, HISTORY_BARS);
  console.log(`Got ${candles.length} candles, ${new Date(candles[0].time).toISOString().slice(0, 10)} to ${new Date(candles.at(-1).time).toISOString().slice(0, 10)}`);

  const buyHoldPct = ((candles.at(-1).close - candles[0].close) / candles[0].close) * 100;
  console.log(`Buy-and-hold ${SYMBOL} over the full window: ${buyHoldPct >= 0 ? "+" : ""}${buyHoldPct.toFixed(1)}%`);

  const results = [];
  results.push(summarizeRR("EMA200 touch/bounce (fixed 2R)", simulateRR(candles, detectMa200Bounce, 200)));
  results.push(summarizeRR("Z-score |z|>=2.5 mean reversion", simulateRR(candles, detectZscoreReversion, 60)));

  const mtfWarmup = MTF_WEEKLY_WARMUP_BARS * 7 * 6;
  results.push(summarizeRR("MTF Weekly/Daily/4H swing (2R)", simulateMtfSwing(candles, 2, mtfWarmup)));

  console.log(`\n\n=== SUMMARY — ${SYMBOL} 4H, buy-and-hold ${buyHoldPct >= 0 ? "+" : ""}${buyHoldPct.toFixed(1)}% ===`);
  for (const r of results) {
    console.log(
      `${r.label.padEnd(35)} n=${String(r.n).padEnd(4)} winRate=${(r.winRate * 100).toFixed(1)}%  expectancy=${r.expectancyR >= 0 ? "+" : ""}${r.expectancyR.toFixed(2)}R/trade`,
    );
  }

  mkdirSync("backtests", { recursive: true });
  const outPath = `backtests/sol-4h-search-${new Date().toISOString().slice(0, 10)}.json`;
  writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), symbol: SYMBOL, timeframe: TIMEFRAME, buyHoldPct, results }, null, 2));
  console.log(`\nSummary written to ${outPath}`);
}

main();
