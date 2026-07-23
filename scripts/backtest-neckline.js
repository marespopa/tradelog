// Backtests the neckline breakout/reclaim setup exactly as it fires live in
// the app (same analyzeCandles / meetsBar gate — no separate "backtest
// version" of the logic to avoid drifting from what's actually shown on
// screen). Walks historical 4H candles bar-by-bar, only ever looking at data
// up to the current bar (no lookahead), and resolves each signal by which
// level — stop or target — price touches first.
import { fetchTopVolumeTickers } from "../src/lib/analysis/okx.js";
import { analyzeCandles } from "../src/lib/analysis/ta.js";
import { writeFileSync, mkdirSync } from "node:fs";

const BAR = "4H";
const SYMBOL_COUNT = 30;
const HISTORY_BARS = 1500; // ~250 days of 4H candles per symbol
const WARMUP = 220; // bars needed before EMA200/swing lookbacks are fully warmed up
const MAX_HOLD_BARS = 90; // ~15 days; trades still open past this are excluded as inconclusive, not scored as losses

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
    if (json.data.length < 100) break; // exhausted available history
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

      // Both levels touched inside the same bar: can't know which came first
      // from OHLC alone, so assume the worse outcome (stop first) rather than
      // let ambiguous bars flatter the win rate.
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

    let result;
    try {
      result = analyzeCandles(candles.slice(0, i + 1), symbol);
    } catch {
      continue;
    }
    const setup = result.setup;
    if (setup && !setup.skipped && setup.meetsBar) {
      openTrade = {
        symbol,
        direction: setup.direction,
        entryIndex: i,
        entryTime: bar.time,
        entry: setup.entry,
        stop: setup.stop,
        target: setup.target,
        rr: setup.rr,
        scoreAtEntry: result.score,
      };
    }
  }

  return trades;
}

// Wilson score interval — better-behaved than a normal approximation at the
// small sample sizes a single-setup backtest realistically produces.
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
  const expectancyR = n ? winRate * avgWinR - (1 - winRate) * 1 : 0;
  const avgBarsHeld = n ? resolved.reduce((s, t) => s + t.barsHeld, 0) / n : 0;
  const timeouts = trades.length - n;

  console.log(`\n--- ${label} ---`);
  console.log(`signals: ${trades.length}  resolved: ${n}  timeouts(excluded): ${timeouts}`);
  console.log(`win rate: ${(winRate * 100).toFixed(1)}%  (95% CI: ${(lo * 100).toFixed(1)}%-${(hi * 100).toFixed(1)}%)`);
  console.log(`avg win: +${avgWinR.toFixed(2)}R  loss: -1R  expectancy: ${expectancyR >= 0 ? "+" : ""}${expectancyR.toFixed(2)}R/trade`);
  console.log(`avg bars held: ${avgBarsHeld.toFixed(1)} (${((avgBarsHeld * 4) / 24).toFixed(1)} days)`);
  return { label, n, wins: wins.length, winRate, ci: [lo, hi], avgWinR, expectancyR, timeouts };
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
      const trades = simulateSymbol(symbol, candles);
      allTrades.push(...trades);
      console.log(`${candles.length} candles, ${trades.length} signals`);
    } catch (err) {
      console.log(`failed: ${err.message}`);
    }
  }

  console.log(`\n=== Neckline breakout/reclaim — 4H — ${symbols.length} symbols ===`);
  const overall = summarize("overall", allTrades);
  summarize("long only", allTrades.filter((t) => t.direction === "long"));
  summarize("short only", allTrades.filter((t) => t.direction === "short"));

  mkdirSync("backtests", { recursive: true });
  const outPath = `backtests/neckline-4h-${new Date().toISOString().slice(0, 10)}.json`;
  writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), symbols, summary: overall, trades: allTrades }, null, 2));
  console.log(`\nRaw trades written to ${outPath}`);
}

main();
