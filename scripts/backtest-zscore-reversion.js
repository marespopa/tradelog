// Backtests the "trade the z-score" rule the user quoted: z > +2.5 is
// overbought -> short expecting reversion, z < -2.5 is oversold -> long
// expecting reversion. Target is the rolling mean itself (the literal
// "reverts to the mean" claim), stop is 1.5x ATR beyond entry (same stop
// convention as the other backtests here). Distinct from the RSI
// mean-reversion setup already tested (different trigger, different
// target definition — swing level vs. the mean itself).
import { fetchTopVolumeTickers } from "../src/lib/analysis/okx.js";
import { zScore, rollingMean, atr } from "../src/lib/analysis/ta.js";
import { writeFileSync, mkdirSync } from "node:fs";

const BAR = "4H";
const SYMBOL_COUNT = 30;
const HISTORY_BARS = 1500;
const WARMUP = 60;
const MAX_HOLD_BARS = 90;
const Z_THRESHOLD = 2.5;

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

function detectZscoreReversion(sub) {
  const closes = sub.map((c) => c.close);
  if (closes.length < WARMUP) return null;
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
  if (reward <= 0) return null; // already past the mean, no fresh reversion left to trade

  return { direction, entry: current, stop, target, rr: reward / risk, zAtEntry: z };
}

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

  const allTrades = [];
  for (const symbol of symbols) {
    process.stdout.write(`  ${symbol}... `);
    try {
      const candles = await fetchHistory(symbol, HISTORY_BARS);
      if (candles.length < WARMUP + 10) {
        console.log(`skipped (only ${candles.length} candles)`);
        continue;
      }
      const trades = simulateSymbol(symbol, candles, detectZscoreReversion);
      allTrades.push(...trades);
      console.log(`${candles.length} candles, ${trades.length} signals`);
    } catch (err) {
      console.log(`failed: ${err.message}`);
    }
  }

  console.log(`\n=== Z-score mean-reversion (|z| >= ${Z_THRESHOLD}) — 4H — ${symbols.length} symbols ===`);
  const overall = summarize("overall", allTrades);
  summarize("long (z <= -2.5)", allTrades.filter((t) => t.direction === "long"));
  summarize("short (z >= +2.5)", allTrades.filter((t) => t.direction === "short"));

  mkdirSync("backtests", { recursive: true });
  const outPath = `backtests/zscore-reversion-4h-${new Date().toISOString().slice(0, 10)}.json`;
  writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), symbols, summary: overall, trades: allTrades }, null, 2));
  console.log(`\nRaw trades written to ${outPath}`);
}

main();
