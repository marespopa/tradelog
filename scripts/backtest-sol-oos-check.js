// Same in-sample/out-of-sample split as backtest-sol-ema200-bounce-tune.js,
// applied to the other two survivors from backtest-sol-4h-search.js
// (z-score reversion, MTF swing) at their untuned defaults -- checking
// whether their full-window positive expectancy holds up on the held-out
// second half, or was also just a first-half regime.
import { fetchCandleHistory } from "../src/lib/analysis/okx.js";
import { buildDailyCandles, buildWeeklyCandles } from "../src/lib/analysis/timeframes.js";
import { findMtfSignal, buildTrade as buildMtfSignalTrade, MTF_WEEKLY_WARMUP_BARS } from "../src/lib/analysis/mtfSetup.js";
import { atr, zScore, rollingMean } from "../src/lib/analysis/ta.js";

const SYMBOL = "SOL";
const TIMEFRAME = "4h";
const HISTORY_BARS = 3600;
const MAX_HOLD_BARS = 90;
const DAY_MS = 86400000;
const WEEK_MS = DAY_MS * 7;
const IN_SAMPLE_FRACTION = 0.7;

function wilsonInterval(wins, n, z = 1.96) {
  if (n === 0) return [0, 0];
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(center - margin) / denom, (center + margin) / denom];
}

function stats(trades) {
  const resolved = trades.filter((t) => t.outcome !== "timeout");
  const wins = resolved.filter((t) => t.outcome === "win");
  const n = resolved.length;
  const winRate = n ? wins.length / n : 0;
  const [lo, hi] = wilsonInterval(wins.length, n);
  const avgWinR = wins.length ? wins.reduce((s, t) => s + t.realizedR, 0) / wins.length : 0;
  const expectancyR = n ? winRate * avgWinR - (1 - winRate) * 1 : 0;
  return { n, winRate, ci: [lo, hi], avgWinR, expectancyR };
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
  const candles = await fetchCandleHistory(SYMBOL, TIMEFRAME, HISTORY_BARS);
  const splitIndex = Math.floor(candles.length * IN_SAMPLE_FRACTION);
  console.log(`Split at bar ${splitIndex} / ${candles.length} (${new Date(candles[splitIndex].time).toISOString().slice(0, 10)})`);

  const zTrades = simulateRR(candles, detectZscoreReversion, 60);
  const zIn = stats(zTrades.filter((t) => t.entryIndex < splitIndex));
  const zOut = stats(zTrades.filter((t) => t.entryIndex >= splitIndex));
  console.log(`\nZ-score reversion: IS n=${zIn.n} ${(zIn.winRate * 100).toFixed(1)}% ${zIn.expectancyR >= 0 ? "+" : ""}${zIn.expectancyR.toFixed(2)}R | OOS n=${zOut.n} ${(zOut.winRate * 100).toFixed(1)}% ${zOut.expectancyR >= 0 ? "+" : ""}${zOut.expectancyR.toFixed(2)}R`);

  const mtfWarmup = MTF_WEEKLY_WARMUP_BARS * 7 * 6;
  const mtfTrades = simulateMtfSwing(candles, 2, mtfWarmup);
  const mIn = stats(mtfTrades.filter((t) => t.entryIndex < splitIndex));
  const mOut = stats(mtfTrades.filter((t) => t.entryIndex >= splitIndex));
  console.log(`MTF swing 2R:      IS n=${mIn.n} ${(mIn.winRate * 100).toFixed(1)}% ${mIn.expectancyR >= 0 ? "+" : ""}${mIn.expectancyR.toFixed(2)}R | OOS n=${mOut.n} ${(mOut.winRate * 100).toFixed(1)}% ${mOut.expectancyR >= 0 ? "+" : ""}${mOut.expectancyR.toFixed(2)}R`);
}

main();
