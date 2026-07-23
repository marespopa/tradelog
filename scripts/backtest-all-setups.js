// Backtests four candidate 4H setups against the same historical candle set
// (fetched once per symbol, shared across all four) so results are directly
// comparable rather than each being tested on a slightly different window.
// Three of the four (RSI reversion, MACD cross, EMA cross) share a common
// stop/target frame — entry at signal-bar close, stop = 1.5x ATR, target =
// nearest structural swing level in the trade's direction — so the only
// thing that differs between them is the entry trigger itself. The fourth
// (neckline) reuses the exact live analyzeCandles/meetsBar path already
// validated in backtest-neckline.js, for a sanity-check baseline.
import { fetchTopVolumeTickers } from "../src/lib/analysis/okx.js";
import { analyzeCandles, ema, rsi, atr, macd, findSwingLevels } from "../src/lib/analysis/ta.js";
import { writeFileSync, mkdirSync } from "node:fs";

const BAR = "4H";
const SYMBOL_COUNT = 30;
const HISTORY_BARS = 1500;
const WARMUP = 220;
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

// Shared stop/target for the three non-neckline setups: ATR stop, nearest
// structural swing level as target. Returns null if there's no ATR yet, no
// level in the right direction, or the level is behind price (degenerate).
function buildStopTarget(direction, current, atrVal, levels) {
  if (atrVal == null) return null;
  const stopDistance = atrVal * 1.5;
  const stop = direction === "long" ? current - stopDistance : current + stopDistance;
  const risk = Math.abs(current - stop);
  if (risk <= 0) return null;
  const candidates = levels
    .filter((l) => (direction === "long" ? l.price > current : l.price < current))
    .sort((a, b) => Math.abs(a.price - current) - Math.abs(b.price - current));
  if (!candidates.length) return null;
  const target = candidates[0].price;
  const reward = Math.abs(target - current);
  if (reward <= 0) return null;
  return { entry: current, stop, target, risk, reward, rr: reward / risk };
}

function detectNeckline(sub) {
  let result;
  try {
    result = analyzeCandles(sub, "X");
  } catch {
    return null;
  }
  const setup = result.setup;
  if (setup && !setup.skipped && setup.meetsBar) {
    return { direction: setup.direction, entry: setup.entry, stop: setup.stop, target: setup.target, rr: setup.rr };
  }
  return null;
}

function detectRsiReversion(sub) {
  const closes = sub.map((c) => c.close);
  if (closes.length < 30) return null;
  const rsiSeries = rsi(closes, 14);
  const cur = rsiSeries.at(-1);
  const prev = rsiSeries.at(-2);
  if (cur == null || prev == null) return null;
  let direction = null;
  if (prev < 30 && cur >= 30) direction = "long";
  else if (prev > 70 && cur <= 70) direction = "short";
  if (!direction) return null;
  const current = closes.at(-1);
  const atrVal = atr(sub);
  const levels = findSwingLevels(sub).filter((l) => l.touches >= 2);
  const st = buildStopTarget(direction, current, atrVal, levels);
  if (!st || st.rr < 1.5) return null;
  return { direction, ...st };
}

function detectMacdCross(sub) {
  const closes = sub.map((c) => c.close);
  if (closes.length < 210) return null; // needs EMA200 for the trend filter
  const m = macd(closes);
  if (!m) return null;
  const ema50 = ema(closes, 50).at(-1);
  const ema200 = ema(closes, 200).at(-1);
  let direction = null;
  if (m.bullishCross && ema50 > ema200) direction = "long";
  else if (m.bearishCross && ema50 < ema200) direction = "short";
  if (!direction) return null;
  const current = closes.at(-1);
  const atrVal = atr(sub);
  const levels = findSwingLevels(sub).filter((l) => l.touches >= 2);
  const st = buildStopTarget(direction, current, atrVal, levels);
  if (!st || st.rr < 2) return null;
  return { direction, ...st };
}

function detectEmaCross(sub) {
  const closes = sub.map((c) => c.close);
  if (closes.length < 210) return null;
  const ema20s = ema(closes, 20);
  const ema50s = ema(closes, 50);
  const ema200 = ema(closes, 200).at(-1);
  const cur20 = ema20s.at(-1);
  const prev20 = ema20s.at(-2);
  const cur50 = ema50s.at(-1);
  const prev50 = ema50s.at(-2);
  let direction = null;
  if (prev20 <= prev50 && cur20 > cur50 && cur50 > ema200) direction = "long";
  else if (prev20 >= prev50 && cur20 < cur50 && cur50 < ema200) direction = "short";
  if (!direction) return null;
  const current = closes.at(-1);
  const atrVal = atr(sub);
  const levels = findSwingLevels(sub).filter((l) => l.touches >= 2);
  const st = buildStopTarget(direction, current, atrVal, levels);
  if (!st || st.rr < 2) return null;
  return { direction, ...st };
}

const SETUPS = {
  neckline: detectNeckline,
  rsiReversion: detectRsiReversion,
  macdCross: detectMacdCross,
  emaCross: detectEmaCross,
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
  }

  console.log("\n\n=== SUMMARY (all setups, 4H) ===");
  console.log("setup            n    winRate      CI               avgWin   breakeven   expectancy");
  for (const [name, r] of Object.entries(results)) {
    const s = r.overall;
    console.log(
      `${name.padEnd(16)} ${String(s.n).padEnd(4)} ${(s.winRate * 100).toFixed(1).padStart(5)}%     ` +
        `${(s.ci[0] * 100).toFixed(1)}-${(s.ci[1] * 100).toFixed(1)}%      ` +
        `+${s.avgWinR.toFixed(2)}R   ${s.breakevenWinRate != null ? (s.breakevenWinRate * 100).toFixed(1) + "%" : "n/a"}       ` +
        `${s.expectancyR >= 0 ? "+" : ""}${s.expectancyR.toFixed(2)}R`,
    );
  }

  mkdirSync("backtests", { recursive: true });
  const outPath = `backtests/all-setups-4h-${new Date().toISOString().slice(0, 10)}.json`;
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
