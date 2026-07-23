// Out-of-sample validation of the one setup that showed a positive (if
// statistically weak) edge in backtest-fxnx-swing.js: fxnx-2R. Same
// detection rule, same historical source — but instead of one blended
// sample, history is split into an earlier and a later period so the fixed
// rule (no re-fitting) can be checked against data it wasn't eyeballed
// against. If the edge only shows up in one half, it's overfitting/noise,
// not a real effect.
import { fetchTopVolumeTickers } from "../src/lib/analysis/okx.js";
import { buildFxnxTrade, FXNX_WARMUP_BARS, FXNX_R_MULTIPLE } from "../src/lib/analysis/fxnxSetup.js";
import { writeFileSync, mkdirSync } from "node:fs";

const BAR = "4H";
const SYMBOL_COUNT = 30;
const HISTORY_BARS = 3000; // ~500 days of 4H bars, twice the original study's window
const WARMUP = FXNX_WARMUP_BARS;
const MAX_HOLD_BARS = 90;
const R_MULTIPLE = FXNX_R_MULTIPLE; // fxnx-2R, the one setup that came back positive

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

function detect(sub) {
  return buildFxnxTrade(sub, R_MULTIPLE);
}

function simulateSymbol(symbol, candles) {
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
      if (candles.length < WARMUP + 50) {
        console.log(`skipped (only ${candles.length} candles)`);
        continue;
      }
      histories[symbol] = candles;
      console.log(`${candles.length} candles, ${new Date(candles[0].time).toISOString().slice(0, 10)} to ${new Date(candles.at(-1).time).toISOString().slice(0, 10)}`);
    } catch (err) {
      console.log(`failed: ${err.message}`);
    }
  }

  // Split by calendar time, not index, so the cutoff is the same real date
  // across every symbol regardless of how much history each one has.
  const allStart = Math.min(...Object.values(histories).map((c) => c[0].time));
  const allEnd = Math.max(...Object.values(histories).map((c) => c.at(-1).time));
  const cutoff = allStart + (allEnd - allStart) * 0.5;
  console.log(`\nSplit at ${new Date(cutoff).toISOString().slice(0, 10)} (in-sample before, out-of-sample after)`);

  const inSampleTrades = [];
  const outOfSampleTrades = [];
  for (const [symbol, candles] of Object.entries(histories)) {
    const trades = simulateSymbol(symbol, candles);
    for (const t of trades) {
      (t.entryTime < cutoff ? inSampleTrades : outOfSampleTrades).push(t);
    }
  }

  console.log(`\n=== fxnx-2R — 4H — ${Object.keys(histories).length} symbols — split validation ===`);
  const inSample = summarize("in-sample (earlier period)", inSampleTrades);
  const outOfSample = summarize("out-of-sample (later period)", outOfSampleTrades);

  console.log("\n\n=== VERDICT ===");
  if (outOfSample.expectancyR > 0 && outOfSample.ci[0] > (outOfSample.breakevenWinRate ?? 1)) {
    console.log("Edge holds on unseen data with the win rate's lower CI bound clearing breakeven. Still thin — treat as a hypothesis, not a system.");
  } else if (outOfSample.expectancyR > 0) {
    console.log("Out-of-sample expectancy is positive but the confidence interval overlaps breakeven — not distinguishable from noise at this sample size.");
  } else {
    console.log("Out-of-sample expectancy is negative or flat — the in-sample result does not replicate. Treat fxnx-2R as not having a demonstrated edge.");
  }

  mkdirSync("backtests", { recursive: true });
  const outPath = `backtests/fxnx-2r-oos-4h-${new Date().toISOString().slice(0, 10)}.json`;
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        symbols: Object.keys(histories),
        cutoff: new Date(cutoff).toISOString(),
        inSample: { summary: inSample, trades: inSampleTrades },
        outOfSample: { summary: outOfSample, trades: outOfSampleTrades },
      },
      null,
      2,
    ),
  );
  console.log(`\nRaw trades written to ${outPath}`);
}

main();
