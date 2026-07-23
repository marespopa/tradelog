// Backtests the FXNX 4H swing strategy (https://fxnx.com/en/blog/mastering-the-4-hour-swing-trading-strategy-with-fxnx):
// D1 trend filter + 4H EMA50 filter, entry trigger is a pin bar / engulfing /
// inside-bar-breakout at a horizontal S/R level tested >=2 times, stop
// beyond the rejection wick, target a fixed R multiple (article states
// "minimum 1:2, preferably 1:3" — both tested). Same historical data,
// fetch/resolution methodology as backtest-all-setups.js for direct
// comparability.
import { fetchTopVolumeTickers } from "../src/lib/analysis/okx.js";
import { buildFxnxTrade, FXNX_WARMUP_BARS } from "../src/lib/analysis/fxnxSetup.js";
import { writeFileSync, mkdirSync } from "node:fs";

const BAR = "4H";
const SYMBOL_COUNT = 30;
const HISTORY_BARS = 1500;
const WARMUP = FXNX_WARMUP_BARS;
const MAX_HOLD_BARS = 90;

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
  "fxnx-2R": (sub) => buildFxnxTrade(sub, 2),
  "fxnx-3R": (sub) => buildFxnxTrade(sub, 3),
};

function simulateSymbol(symbol, candles, detect) {
  const trades = [];
  let openTrade = null;

  for (let i = WARMUP; i < candles.length; i++) {
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
    if (signal) {
      openTrade = { symbol, entryIndex: i, entryTime: bar.time, ...signal };
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
    console.log(`\n=== ${setupName} — 4H — ${Object.keys(histories).length} symbols ===`);
    results[setupName] = { overall: summarize("overall", allTrades), trades: allTrades };
    summarize("  by trigger: pinBar", allTrades.filter((t) => t.trigger === "pinBar"));
    summarize("  by trigger: engulfing", allTrades.filter((t) => t.trigger === "engulfing"));
    summarize("  by trigger: insideBar", allTrades.filter((t) => t.trigger === "insideBar"));
  }

  console.log("\n\n=== SUMMARY (FXNX swing strategy, 4H) ===");
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
  const outPath = `backtests/fxnx-swing-4h-${new Date().toISOString().slice(0, 10)}.json`;
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
