// Follow-up to backtest-mtf-swing.js: that backtest established mtf-2R (the
// live default — see mtfSetup.js's MTF_R_MULTIPLE) as a real edge (+0.19R/
// trade, 309 resolved trades, 95% CI clear of breakeven) but never checked
// whether the signal's quality varies with volatility or liquidity at entry.
// Same fetch/simulate methodology as backtest-mtf-swing.js (one deep 4H
// fetch per symbol, resampled into daily/weekly, walk-forward with no
// lookahead) — restricted to mtf-2R only since that's what's actually live,
// not both R multiples.
//
// At each entry this also records:
//   - atrPct: 4H ATR(14) / entry price at the time of entry — volatility,
//     normalized so it's comparable across coins of very different price.
//   - avgDollarVol: trailing 42-bar (~1 week of 4H) mean of volume*close —
//     a liquidity proxy at entry, not the live 24h-volume ranking (that's
//     just today's snapshot; this is "how liquid was this name over the
//     week leading into this specific trade").
// Trades are then split into terciles on each dimension (low/mid/high,
// equal-count buckets) and reported against the overall baseline, plus one
// combined "calmer + more liquid" filter (both above/below their own
// medians) to see whether combining the two dimensions does better than
// either alone.
//
// Caveat, stated up front rather than after seeing results: this is a
// single-pass exploratory bucketing on one sample (terciles/medians fixed
// before looking at per-bucket numbers, not searched), and finding one
// green bucket among six candidate splits (3 volatility + 3 liquidity, plus
// the combined filter) has real multiple-comparisons risk. Do not wire a
// promising-looking bucket into find4hTrigger off this run alone — rerun on
// a fresh window (same approach as backtest-fxnx-oos.js) before trusting it.
//
// Result (2026-07-26 run): 22 symbols, 481 signals. Baseline mtf-2R here came
// in at +0.10R/trade (36.8% win rate, CI 32.6-41.2%) — thinner than
// backtest-mtf-swing.js's original +0.19R because fetchTopVolumeTickers
// returns whatever's top-30-by-volume *today*, so the exact symbol set (and
// therefore the sample) drifts between runs; this is a pre-existing
// survivorship quirk of the methodology, not introduced here.
//   Volatility terciles: low +0.06R, mid +0.08R, high +0.17R — expectancy
//   rises with volatility, the opposite of what a "filter out choppy/risky
//   entries" instinct would predict. No case for a low-volatility filter.
//   Liquidity terciles: low +0.15R, mid -0.06R, high +0.22R — non-monotonic
//   (mid is worse than both neighbors), which reads more like bucket noise
//   than a real liquidity relationship despite high liquidity's standalone
//   number looking good.
//   Combined "calmer + more liquid" filter: +0.11R (n=146) — essentially the
//   same as the +0.10R unfiltered baseline, i.e. no material improvement,
//   and worse than the high-liquidity-only tercile taken alone.
// Conclusion: no filter tested here cleanly beats the baseline once you
// account for the non-monotonic liquidity buckets and the multiple-
// comparisons risk of picking the best of 6+ splits. The high-liquidity-only
// tercile (+0.22R, n=160) is the single most interesting number but needs an
// out-of-sample rerun before it's more than a lead worth re-checking.
import { fetchTopVolumeTickers } from "../src/lib/analysis/okx.js";
import { buildDailyCandles, buildWeeklyCandles } from "../src/lib/analysis/timeframes.js";
import { findMtfSignal, buildTrade, MTF_WEEKLY_WARMUP_BARS, MTF_R_MULTIPLE } from "../src/lib/analysis/mtfSetup.js";
import { atr } from "../src/lib/analysis/ta.js";
import { writeFileSync, mkdirSync } from "node:fs";

const BAR = "4H";
const SYMBOL_COUNT = 30; // matches backtest-mtf-swing.js
const HISTORY_BARS = 3600; // matches backtest-mtf-swing.js
const WARMUP = MTF_WEEKLY_WARMUP_BARS * 7 * 6; // weeks -> days -> 4H bars
const MAX_HOLD_BARS = 90;
const FOURH_TRIGGER_WINDOW = 300;
const LIQUIDITY_WINDOW_BARS = 42; // ~1 week of 4H bars
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

function simulateSymbol(symbol, candles4h) {
  const dailyFull = buildDailyCandles(candles4h);
  const weeklyFull = buildWeeklyCandles(dailyFull);

  const trades = [];
  let openTrade = null;
  let dailyIdx = 0;
  let weeklyIdx = 0;

  for (let i = WARMUP; i < candles4h.length; i++) {
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

    const trade = buildTrade(findMtfSignal(closedWeekly, closedDaily, fourHWindow), MTF_R_MULTIPLE);
    if (trade) {
      const atrVal = atr(fourHWindow);
      const atrPct = atrVal != null ? (atrVal / trade.entry) * 100 : null;
      const liqWindow = candles4h.slice(Math.max(0, i - LIQUIDITY_WINDOW_BARS + 1), i + 1);
      const avgDollarVol = liqWindow.reduce((s, c) => s + c.volume * c.close, 0) / liqWindow.length;
      openTrade = { symbol, entryIndex: i, entryTime: bar.time, ...trade, atrPct, avgDollarVol };
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

  console.log(`--- ${label} ---`);
  console.log(
    `  n=${n} (${timeouts} timeouts excluded)  winRate=${(winRate * 100).toFixed(1)}% (CI ${(lo * 100).toFixed(1)}-${(hi * 100).toFixed(1)}%)  ` +
      `avgWin=+${avgWinR.toFixed(2)}R  breakeven=${breakevenWinRate != null ? (breakevenWinRate * 100).toFixed(1) + "%" : "n/a"}  ` +
      `expectancy=${expectancyR >= 0 ? "+" : ""}${expectancyR.toFixed(2)}R`,
  );
  return { label, n, wins: wins.length, winRate, ci: [lo, hi], avgWinR, breakevenWinRate, expectancyR, timeouts, totalSignals: trades.length };
}

function tercileBuckets(trades, keyFn) {
  const sorted = [...trades].sort((a, b) => keyFn(a) - keyFn(b));
  const third = Math.ceil(sorted.length / 3);
  return { low: sorted.slice(0, third), mid: sorted.slice(third, third * 2), high: sorted.slice(third * 2) };
}

function median(xs) {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
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

  const allTrades = [];
  for (const [symbol, candles] of Object.entries(histories)) {
    allTrades.push(...simulateSymbol(symbol, candles));
  }
  const withStats = allTrades.filter((t) => t.atrPct != null);

  console.log(`\n=== mtf-2R baseline — ${Object.keys(histories).length} symbols ===`);
  const overall = summarize("overall (unfiltered)", allTrades);

  console.log("\n=== Volatility terciles (4H ATR% of entry price) ===");
  const volBuckets = tercileBuckets(withStats, (t) => t.atrPct);
  const volResults = {
    low: summarize(`low volatility (n=${volBuckets.low.length}, atrPct<=${volBuckets.low.at(-1)?.atrPct.toFixed(2)}%)`, volBuckets.low),
    mid: summarize(`mid volatility (n=${volBuckets.mid.length})`, volBuckets.mid),
    high: summarize(`high volatility (n=${volBuckets.high.length}, atrPct>=${volBuckets.high[0]?.atrPct.toFixed(2)}%)`, volBuckets.high),
  };

  console.log("\n=== Liquidity terciles (trailing 1-week avg dollar volume at entry) ===");
  const liqBuckets = tercileBuckets(withStats, (t) => t.avgDollarVol);
  const liqResults = {
    low: summarize(`low liquidity (n=${liqBuckets.low.length}, avgDollarVol<=$${liqBuckets.low.at(-1)?.avgDollarVol.toLocaleString()})`, liqBuckets.low),
    mid: summarize(`mid liquidity (n=${liqBuckets.mid.length})`, liqBuckets.mid),
    high: summarize(`high liquidity (n=${liqBuckets.high.length}, avgDollarVol>=$${liqBuckets.high[0]?.avgDollarVol.toLocaleString()})`, liqBuckets.high),
  };

  const atrMedian = median(withStats.map((t) => t.atrPct));
  const liqMedian = median(withStats.map((t) => t.avgDollarVol));
  console.log(`\n=== Combined filter: below-median volatility (atrPct<=${atrMedian.toFixed(2)}%) AND above-median liquidity (avgDollarVol>=$${liqMedian.toLocaleString()}) ===`);
  const combinedPass = withStats.filter((t) => t.atrPct <= atrMedian && t.avgDollarVol >= liqMedian);
  const combinedFail = withStats.filter((t) => !(t.atrPct <= atrMedian && t.avgDollarVol >= liqMedian));
  const combinedResults = {
    pass: summarize(`calmer + more liquid (n=${combinedPass.length})`, combinedPass),
    fail: summarize(`everything else (n=${combinedFail.length})`, combinedFail),
  };

  mkdirSync("backtests", { recursive: true });
  const outPath = `backtests/mtf-volatility-liquidity-${new Date().toISOString().slice(0, 10)}.json`;
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        params: { SYMBOL_COUNT, HISTORY_BARS, LIQUIDITY_WINDOW_BARS },
        overall,
        volatilityTerciles: volResults,
        liquidityTerciles: liqResults,
        combinedFilter: { atrMedian, liqMedian, ...combinedResults },
        trades: withStats,
      },
      null,
      2,
    ),
  );
  console.log(`\nRaw results written to ${outPath}`);
}

main();
