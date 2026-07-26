// Backtests the 3-tier MTF swing setup (Weekly bias -> Daily trend -> 4H
// trigger, src/lib/analysis/mtfSetup.js) against the same methodology as
// backtest-fxnx-swing.js (paginated 4H history fetch, walk-forward
// simulation, Wilson-interval win rate, R-expectancy) so results are
// directly comparable to the existing FXNX numbers. Single data source per
// symbol: one deep 4H fetch, resampled into daily and weekly via
// timeframes.js, so backtest and live scan can't drift out of alignment and
// there's no lookahead (daily/weekly candles are only "revealed" once their
// calendar bucket has fully closed as of the current 4H bar).
import { fetchTopVolumeTickers } from "../src/lib/analysis/okx.js";
import { buildDailyCandles, buildWeeklyCandles } from "../src/lib/analysis/timeframes.js";
import { findMtfSignal, buildTrade, MTF_WEEKLY_WARMUP_BARS } from "../src/lib/analysis/mtfSetup.js";
import { writeFileSync, mkdirSync } from "node:fs";

const BAR = "4H";
const SYMBOL_COUNT = 30;
const HISTORY_BARS = 3600; // ~600 days of 4H bars -> ~85 weeks, enough for weekly EMA20 to settle
const WARMUP = MTF_WEEKLY_WARMUP_BARS * 7 * 6; // weeks -> days -> 4H bars
const MAX_HOLD_BARS = 90;
const FOURH_TRIGGER_WINDOW = 300; // bounded window fed to the trigger check so cost stays O(1) per bar, not O(n)
const DAY_MS = 86400000;
const WEEK_MS = DAY_MS * 7;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchHistory(symbol, totalBars) {
  const instId = `${symbol}-USDT`;
  const all = [];
  let after;
  while (all.length < totalBars) {
    const url = new URL("https://www.okx.com/api/v5/market/history-candles");
    url.searchParams.set("instId", instId);
    url.searchParams.set("bar", BAR);
    url.searchParams.set("limit", "100");
    if (after) url.searchParams.set("after", after);
    const res = await fetch(url);
    if (!res.ok) break;
    const json = await res.json();
    if (json.code !== "0" || !json.data?.length) break;
    all.push(...json.data);
    after = json.data.at(-1)[0];
    if (json.data.length < 100) break;
    await sleep(150);
  }
  const seen = new Set();
  return all
    .filter((d) => (seen.has(d[0]) ? false : (seen.add(d[0]), true)))
    .map(([ts, open, high, low, close, volume]) => ({
      time: Number(ts),
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: Number(close),
      volume: Number(volume),
    }))
    .sort((a, b) => a.time - b.time);
}

const SETUPS = {
  "mtf-2R": (weekly, daily, fourHWindow) => buildTrade(findMtfSignal(weekly, daily, fourHWindow), 2),
  "mtf-3R": (weekly, daily, fourHWindow) => buildTrade(findMtfSignal(weekly, daily, fourHWindow), 3),
};

function simulateSymbol(symbol, candles4h, detect) {
  const dailyFull = buildDailyCandles(candles4h);
  const weeklyFull = buildWeeklyCandles(dailyFull);

  const trades = [];
  let openTrade = null;
  let dailyIdx = 0;
  let weeklyIdx = 0;

  for (let i = WARMUP; i < candles4h.length; i++) {
    const bar = candles4h[i];

    // Advance the "closed as of now" pointers instead of re-resampling the
    // whole prefix every bar — each daily/weekly candle's own OHLC is
    // already fixed by buildDailyCandles/buildWeeklyCandles, independent of
    // later buckets, so revealing it once its bucket has fully elapsed is
    // equivalent to recomputing from the prefix, without the O(n^2) cost.
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

    const trade = detect(closedWeekly, closedDaily, fourHWindow);
    if (trade) {
      openTrade = { symbol, entryIndex: i, entryTime: bar.time, ...trade };
    }
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

function summarize(label, trades) {
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

async function main() {
  console.log(`Fetching top ${SYMBOL_COUNT} symbols by volume...`);
  const symbols = (await fetchTopVolumeTickers(SYMBOL_COUNT)).map((t) => t.symbol);
  console.log(symbols.join(", "));

  const histories = {};
  for (const symbol of symbols) {
    process.stdout.write(`  ${symbol}... `);
    try {
      const candles = await fetchHistory(symbol, HISTORY_BARS);
      if (candles.length < WARMUP + 10) {
        console.log(`skipped (only ${candles.length} candles)`);
        continue;
      }
      histories[symbol] = candles;
      console.log(`${candles.length} candles`);
    } catch (err) {
      console.log(`failed: ${err.message}`);
    }
  }

  const results = {};
  for (const [setupName, detect] of Object.entries(SETUPS)) {
    const allTrades = [];
    for (const [symbol, candles] of Object.entries(histories)) {
      allTrades.push(...simulateSymbol(symbol, candles, detect));
    }
    console.log(`\n=== ${setupName} — Weekly/Daily/4H — ${Object.keys(histories).length} symbols ===`);
    results[setupName] = { overall: summarize("overall", allTrades), trades: allTrades };
    summarize("  by trigger: pinBar", allTrades.filter((t) => t.trigger === "pinBar"));
    summarize("  by trigger: engulfing", allTrades.filter((t) => t.trigger === "engulfing"));
    summarize("  by trigger: insideBar", allTrades.filter((t) => t.trigger === "insideBar"));
  }

  console.log("\n\n=== SUMMARY (MTF swing strategy, Weekly/Daily/4H) ===");
  console.log("setup       n    winRate      CI               avgWin   breakeven   expectancy");
  for (const [name, r] of Object.entries(results)) {
    const s = r.overall;
    console.log(
      `${name.padEnd(11)} ${String(s.n).padEnd(4)} ${(s.winRate * 100).toFixed(1).padStart(5)}%     ` +
        `${(s.ci[0] * 100).toFixed(1)}-${(s.ci[1] * 100).toFixed(1)}%      ` +
        `+${s.avgWinR.toFixed(2)}R   ${s.breakevenWinRate != null ? (s.breakevenWinRate * 100).toFixed(1) + "%" : "n/a"}       ` +
        `${s.expectancyR >= 0 ? "+" : ""}${s.expectancyR.toFixed(2)}R`,
    );
  }

  mkdirSync("backtests", { recursive: true });
  const outPath = `backtests/mtf-swing-${new Date().toISOString().slice(0, 10)}.json`;
  writeFileSync(
    outPath,
    JSON.stringify(
      { generatedAt: new Date().toISOString(), symbols: Object.keys(histories), results: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, { overall: v.overall, trades: v.trades }])) },
      null,
      2,
    ),
  );
  console.log(`\nRaw trades written to ${outPath}`);
}

main();
