// Verifies the winning archetype-2 candidate from backtest-morpho-4h-explore.js
// (EMA8/21 fresh-cross entry, trailing ATR stop: 2x ATR initial, 3x ATR
// trail, no fixed take-profit) as REAL app-pasteable strategy code, run
// through a harness that exactly matches strategyWorker.js's execution
// model -- not the free-mutation native JS used to find it in the sweep.
//
// This distinction matters: strategyWorker.js only lets a strategy attach
// `meta` to a position ONCE, at the bar it opens (see strategySignal.js --
// "the engine persists it onto that position ... UNTIL the position
// closes"). A real strategy CANNOT mutate ctx.position.meta bar-by-bar the
// way the exploration sweep's native `position.trailStop = ...` did. So the
// app-ready code below can't store a ratcheting stop in meta -- instead it
// recomputes the entire trailing-stop ratchet from ctx.position.entryIndex
// forward on every single bar it runs, using only what the real ctx
// contract actually provides (ctx.bars, ctx.position.entryIndex/entryPrice).
// This script checks that recompute-from-scratch approach reproduces the
// same trades/stats the sweep found, so the numbers reported to the user
// are actually achievable by pasting this code into the Strategies tab --
// not an artifact of a simulation shortcut the real engine doesn't support.
import { fetchCandleHistory } from "../src/lib/analysis/okx.js";
import { fetchFearGreedHistory, alignFearGreedToBars } from "../src/lib/analysis/fearGreed.js";
import * as ta from "../src/lib/analysis/ta.js";

const SYMBOL = "MORPHO";
const TIMEFRAME = "4h";
const HISTORY_BARS = 3692;
const WARMUP = 100;
const ROUNDTRIP_FEE_PCT = 0.2;

export const MORPHO_EMA_TREND_TRAIL_CODE = `
const bars = ctx.bars;
if (bars.length < 100) return;

const closes = bars.map(b => b.close);
const emaFast = ctx.ta.ema(closes, 8);
const emaSlow = ctx.ta.ema(closes, 21);

const currentFast = emaFast.at(-1);
const pastFast = emaFast.at(-2);
const currentSlow = emaSlow.at(-1);
const pastSlow = emaSlow.at(-2);

if (currentFast === null || currentSlow === null || pastFast === null || pastSlow === null) return;

const currentClose = closes.at(-1);
const pos = ctx.position;

if (pos) {
  // Trailing ATR stop: 2x ATR (at entry) initial distance, then ratchets to
  // 3x ATR off each bar's close as price moves favorably, never loosening.
  // ctx.position.meta is pinned at entry and can't be updated mid-trade, so
  // this replays the ratchet from entryIndex using ctx.bars instead of
  // relying on persisted state -- the only state the real engine actually
  // hands back every bar is entryIndex/entryPrice/direction.
  const INITIAL_STOP_ATR = 2;
  const TRAIL_ATR = 3;
  const entryAtr = ctx.ta.atr(bars.slice(0, pos.entryIndex + 1), 14);
  if (!entryAtr) return;
  let stop = pos.direction === "long" ? pos.entryPrice - INITIAL_STOP_ATR * entryAtr : pos.entryPrice + INITIAL_STOP_ATR * entryAtr;
  for (let i = pos.entryIndex; i < bars.length; i++) {
    const atrHere = ctx.ta.atr(bars.slice(0, i + 1), 14);
    if (!atrHere) continue;
    const closeHere = bars[i].close;
    if (pos.direction === "long") stop = Math.max(stop, closeHere - TRAIL_ATR * atrHere);
    else stop = Math.min(stop, closeHere + TRAIL_ATR * atrHere);
  }
  const stopHit = pos.direction === "long" ? currentClose <= stop : currentClose >= stop;
  if (stopHit) return "close";
  return;
}

const freshCrossUp = currentFast > currentSlow && pastFast <= pastSlow;
const freshCrossDown = currentFast < currentSlow && pastFast >= pastSlow;

if (freshCrossUp) return "long";
if (freshCrossDown) return "short";
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
    barsHeld: exitIndex - position.entryIndex,
    entryIndex: position.entryIndex,
    netPct,
    outcome: netPct > 0 ? "win" : netPct < 0 ? "loss" : "breakeven",
  };
}

// Exact structural match of strategyWorker.js's backtest loop (pendingAction/
// pendingMeta resolution, meta pinned once at entry, one-bar fill lag).
function simulateExact(candles, fearGreed, code) {
  const userFn = new Function("ctx", code);
  const trades = [];
  let position = null;
  let pendingAction = null;
  let pendingMeta = null;

  for (let i = WARMUP; i < candles.length; i++) {
    const bar = candles[i];
    if (pendingAction) {
      if (pendingAction === "close") {
        if (position) { trades.push(closeTrade(position, bar.open, bar, i)); position = null; }
      } else {
        if (position && position.direction !== pendingAction) { trades.push(closeTrade(position, bar.open, bar, i)); position = null; }
        if (!position) position = { direction: pendingAction, entryIndex: i, entryTime: bar.time, entryClose: bar.open, meta: pendingMeta };
      }
      pendingAction = null;
      pendingMeta = null;
    }

    const raw = userFn({
      bars: candles.slice(0, i + 1),
      position: position ? { direction: position.direction, entryIndex: position.entryIndex, entryPrice: position.entryClose, meta: position.meta ?? null } : null,
      ta,
      fearGreed: fearGreed.slice(0, i + 1),
    });
    const { direction, meta } = normalizeSignal(raw);
    if (direction === "close" || direction === "long" || direction === "short") {
      pendingAction = direction;
      pendingMeta = meta;
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

function maxDrawdownPct(trades) {
  let equity = 1, peak = 1, maxDd = 0;
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

function stats(trades) {
  const n = trades.length;
  const wins = trades.filter((t) => t.outcome === "win");
  const winRate = n ? wins.length / n : 0;
  const [lo, hi] = wilsonInterval(wins.length, n);
  const expectancyPct = n ? trades.reduce((s, t) => s + t.netPct, 0) / n : 0;
  const compoundedPct = (trades.reduce((equity, t) => equity * (1 + t.netPct / 100), 1) - 1) * 100;
  const maxDd = maxDrawdownPct(trades);
  return { n, winRate, ci: [lo, hi], expectancyPct, compoundedPct, maxDrawdownPct: maxDd, calmarRatio: calmarRatio(trades, compoundedPct, maxDd) };
}

function fmtStats(s) {
  if (!s.n) return "n=0";
  return `n=${s.n} winRate=${(s.winRate * 100).toFixed(0)}% (CI ${(s.ci[0] * 100).toFixed(0)}-${(s.ci[1] * 100).toFixed(0)}%) expectancy=${s.expectancyPct >= 0 ? "+" : ""}${s.expectancyPct.toFixed(2)}%/trade compounded=${s.compoundedPct >= 0 ? "+" : ""}${s.compoundedPct.toFixed(1)}% maxDD=-${s.maxDrawdownPct.toFixed(1)}% Calmar=${s.calmarRatio != null ? s.calmarRatio.toFixed(2) : "n/a"}`;
}

async function main() {
  console.log(`Fetching ${HISTORY_BARS} x ${TIMEFRAME} candles for ${SYMBOL}...`);
  const candles = await fetchCandleHistory(SYMBOL, TIMEFRAME, HISTORY_BARS);
  console.log(`Got ${candles.length} candles, ${new Date(candles[0].time).toISOString().slice(0, 10)} to ${new Date(candles.at(-1).time).toISOString().slice(0, 10)}`);
  const fgHistory = await fetchFearGreedHistory();
  const fearGreed = alignFearGreedToBars(fgHistory, candles);
  const splitIndex = Math.floor(candles.length * 0.7);

  console.log("\nRunning app-ready code through the exact strategyWorker.js execution model...");
  const t0 = Date.now();
  const trades = simulateExact(candles, fearGreed, MORPHO_EMA_TREND_TRAIL_CODE);
  console.log(`(${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  const inSample = stats(trades.filter((t) => t.entryIndex < splitIndex));
  const oos = stats(trades.filter((t) => t.entryIndex >= splitIndex));
  const full = stats(trades);

  console.log(`\nIn-sample (through ${new Date(candles[splitIndex].time).toISOString().slice(0, 10)}): ${fmtStats(inSample)}`);
  console.log(`Out-of-sample (after): ${fmtStats(oos)}`);
  console.log(`Full history: ${fmtStats(full)}`);

  console.log(`\nExpected from the exploration sweep's native simulation (ema8/21, stop=2x, trail=3x):`);
  console.log(`IS: n=44 winRate=43% expectancy=+1.94%/trade compounded=+72.1% maxDD=-48.8% Calmar=1.29`);
  console.log(`OOS: n=20 winRate=40% expectancy=+1.87%/trade compounded=+20.6% maxDD=-25.8% Calmar=1.82`);

  const matches = inSample.n === 44 && oos.n === 20;
  console.log(`\n${matches ? "MATCH" : "MISMATCH"} -- ${matches ? "app-ready code reproduces the sweep result exactly." : "app-ready code does NOT reproduce the sweep result -- do not trust the earlier numbers for this code."}`);
}

main();
