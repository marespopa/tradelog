// Round 2 on MORPHO 4H: the original pullback-entry / fixed-ATR-band-exit
// shape (backtest-morpho-4h-tune.js) was net-negative over MORPHO's full
// 615-day OKX history (-32.6% compounded, -70.6% max DD) and a 120-combo
// tune of its stop/target/EMA/early-exit knobs didn't rescue it -- every
// combo lost money in-sample on a compounded basis despite some having a
// nominally positive per-trade average, which points at the exit *shape*
// (a fixed ATR band, checked once per 4H close) rather than just its
// numbers being wrong.
//
// This tries three structurally different archetypes against the same data,
// each swapping in a trailing ATR stop (ratchets toward price, never
// loosens, no fixed take-profit) instead of a fixed stop/target band, since
// that's the one thing common to every losing combo in round 1:
//   1. Same pullback/turn entry as round 1, just the exit changed.
//   2. Pure EMA-cross trend-following entry (no pullback timing) -- tests
//      whether MORPHO's volatility suits "ride the trend" better than
//      "wait for a dip within the trend."
//   3. Donchian breakout entry (close clears the prior N-bar range) --
//      classic trend-breakout system, sometimes suits a young/volatile
//      alt better than either of the above.
// Same discipline as round 1: 70/30 in-sample/out-of-sample split, rank on
// in-sample expectancy, only trust what ALSO stays positive out-of-sample.
import { fetchCandleHistory } from "../src/lib/analysis/okx.js";
import { fetchFearGreedHistory, alignFearGreedToBars } from "../src/lib/analysis/fearGreed.js";
import * as ta from "../src/lib/analysis/ta.js";
import { writeFileSync, mkdirSync } from "node:fs";

const SYMBOL = "MORPHO";
const TIMEFRAME = "4h";
const HISTORY_BARS = 3692;
const WARMUP = 100;
const ROUNDTRIP_FEE_PCT = 0.2;
const IN_SAMPLE_FRACTION = 0.7;
const MIN_IS_TRADES = 12;

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
  return `n=${s.n} winRate=${(s.winRate * 100).toFixed(0)}% expectancy=${s.expectancyPct >= 0 ? "+" : ""}${s.expectancyPct.toFixed(2)}%/trade compounded=${s.compoundedPct >= 0 ? "+" : ""}${s.compoundedPct.toFixed(1)}% maxDD=-${s.maxDrawdownPct.toFixed(1)}% Calmar=${s.calmarRatio != null ? s.calmarRatio.toFixed(2) : "n/a"}`;
}

// Rolling N-bar high/low, EXCLUDING the current bar (bars i-period..i-1) --
// a breakout is "cleared the range set before this bar", not a tautological
// "today's high is >= today's high".
function rollingHighLow(candles, period) {
  const highs = new Array(candles.length).fill(null);
  const lows = new Array(candles.length).fill(null);
  for (let i = period; i < candles.length; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - period; j < i; j++) {
      if (candles[j].high > hi) hi = candles[j].high;
      if (candles[j].low < lo) lo = candles[j].low;
    }
    highs[i] = hi;
    lows[i] = lo;
  }
  return { highs, lows };
}

function runSweep(label, candles, fearGreed, splitIndex, grid, simulateOne) {
  console.log(`\n=== ${label}: sweeping ${grid.length} combos ===`);
  const scored = grid.map((params) => {
    const allTrades = simulateOne(params);
    const inSample = stats(allTrades.filter((t) => t.entryIndex < splitIndex));
    return { params, inSample, allTrades };
  });
  const ranked = scored.filter((s) => s.inSample.n >= MIN_IS_TRADES).sort((a, b) => b.inSample.expectancyPct - a.inSample.expectancyPct);
  console.log(`${ranked.length} / ${grid.length} combos had >= ${MIN_IS_TRADES} in-sample trades.`);

  const TOP_N = 8;
  const survivors = [];
  for (const s of ranked.slice(0, TOP_N)) {
    const oosTrades = s.allTrades.filter((t) => t.entryIndex >= splitIndex);
    const oos = stats(oosTrades);
    const survives = oos.n >= Math.ceil(MIN_IS_TRADES / 2) && oos.expectancyPct > 0 && s.inSample.compoundedPct > 0;
    if (survives) survivors.push({ ...s, oos });
    console.log(`${JSON.stringify(s.params)} | IS: ${fmtStats(s.inSample)} | OOS: ${fmtStats(oos)} | ${survives ? "SURVIVES" : "no"}`);
  }
  console.log(`${survivors.length || "No"} survivor(s) in ${label}.`);
  return { label, ranked, survivors };
}

async function main() {
  console.log(`Fetching ${HISTORY_BARS} x ${TIMEFRAME} candles for ${SYMBOL}...`);
  const candles = await fetchCandleHistory(SYMBOL, TIMEFRAME, HISTORY_BARS);
  console.log(`Got ${candles.length} candles, ${new Date(candles[0].time).toISOString().slice(0, 10)} to ${new Date(candles.at(-1).time).toISOString().slice(0, 10)}`);
  const fgHistory = await fetchFearGreedHistory();
  const fearGreed = alignFearGreedToBars(fgHistory, candles);
  const splitIndex = Math.floor(candles.length * IN_SAMPLE_FRACTION);
  console.log(`In-sample through ${new Date(candles[splitIndex].time).toISOString().slice(0, 10)}, OOS after.`);

  const closes = candles.map((c) => c.close);
  const rsiArr = ta.rsi(closes, 14);
  const bbArr = closes.map((_, i) => (i + 1 >= 20 ? ta.bollingerBands(closes.slice(0, i + 1), 20, 2) : null));
  const atrArr = candles.map((_, i) => (i + 1 >= 15 ? ta.atr(candles.slice(0, i + 1), 14) : null));
  const emaCache = new Map();
  const getEma = (p) => {
    if (!emaCache.has(p)) emaCache.set(p, ta.ema(closes, p));
    return emaCache.get(p);
  };

  const results = [];

  // --- Archetype 1: original pullback/turn entry, trailing ATR stop exit ---
  {
    const EMA_PAIRS = [[13, 34], [21, 55], [34, 89]];
    const INITIAL_STOP_MULTS = [1.5, 2.0, 2.5];
    const TRAIL_MULTS = [1.5, 2.0, 2.5, 3.0];
    const grid = [];
    for (const [emaFast, emaSlow] of EMA_PAIRS)
      for (const initialStopMult of INITIAL_STOP_MULTS)
        for (const trailMult of TRAIL_MULTS)
          grid.push({ emaFast, emaSlow, initialStopMult, trailMult });

    const simulateOne = (params) => {
      const { emaFast, emaSlow, initialStopMult, trailMult } = params;
      const fastArr = getEma(emaFast), slowArr = getEma(emaSlow);
      const trades = [];
      let position = null, pendingAction = null;

      for (let i = WARMUP; i < candles.length; i++) {
        const bar = candles[i];
        const atr = atrArr[i];
        if (pendingAction) {
          if (pendingAction === "close") {
            if (position) { trades.push(closeTrade(position, bar.open, bar, i)); position = null; }
          } else {
            if (position && position.direction !== pendingAction) { trades.push(closeTrade(position, bar.open, bar, i)); position = null; }
            if (!position) {
              const entryAtr = atr ?? 0;
              const trailStop = pendingAction === "long" ? bar.open - initialStopMult * entryAtr : bar.open + initialStopMult * entryAtr;
              position = { direction: pendingAction, entryIndex: i, entryTime: bar.time, entryClose: bar.open, trailStop };
            }
          }
          pendingAction = null;
        }

        const bb = bbArr[i], currentRsi = rsiArr[i], pastRsi = rsiArr[i - 1];
        const currentFast = fastArr[i];
        const currentSlow = slowArr[i];
        if (currentFast == null || currentSlow == null || currentRsi == null || !bb || !atr) continue;
        const currentClose = closes[i], pastClose = closes[i - 1];
        const fg = fearGreed[i];
        const fgVal = fg ? fg.value : 50;

        if (position) {
          if (position.direction === "long") {
            position.trailStop = Math.max(position.trailStop, currentClose - trailMult * atr);
            if (currentClose <= position.trailStop) pendingAction = "close";
          } else {
            position.trailStop = Math.min(position.trailStop, currentClose + trailMult * atr);
            if (currentClose >= position.trailStop) pendingAction = "close";
          }
          continue;
        }

        const isUptrend = currentFast > currentSlow, isDowntrend = currentFast < currentSlow;
        const isLongPullback = (currentRsi >= 35 && currentRsi <= 48) || currentClose <= bb.lower;
        const isShortBounce = (currentRsi >= 52 && currentRsi <= 65) || currentClose >= bb.upper;
        const turnsUp = currentClose > pastClose && currentRsi > pastRsi;
        const turnsDown = currentClose < pastClose && currentRsi < pastRsi;
        if (isUptrend && isLongPullback && turnsUp && fgVal < 80) pendingAction = "long";
        else if (isDowntrend && isShortBounce && turnsDown && fgVal > 20) pendingAction = "short";
      }
      return trades;
    };

    results.push(runSweep("1: pullback entry + trailing stop", candles, fearGreed, splitIndex, grid, simulateOne));
  }

  // --- Archetype 2: pure EMA-cross trend-following entry, trailing ATR stop ---
  {
    const EMA_PAIRS = [[8, 21], [13, 34], [21, 55], [34, 89]];
    const INITIAL_STOP_MULTS = [1.5, 2.0, 2.5];
    const TRAIL_MULTS = [1.5, 2.0, 2.5, 3.0];
    const grid = [];
    for (const [emaFast, emaSlow] of EMA_PAIRS)
      for (const initialStopMult of INITIAL_STOP_MULTS)
        for (const trailMult of TRAIL_MULTS)
          grid.push({ emaFast, emaSlow, initialStopMult, trailMult });

    const simulateOne = (params) => {
      const { emaFast, emaSlow, initialStopMult, trailMult } = params;
      const fastArr = getEma(emaFast), slowArr = getEma(emaSlow);
      const trades = [];
      let position = null, pendingAction = null;

      for (let i = WARMUP; i < candles.length; i++) {
        const bar = candles[i];
        const atr = atrArr[i];
        if (pendingAction) {
          if (pendingAction === "close") {
            if (position) { trades.push(closeTrade(position, bar.open, bar, i)); position = null; }
          } else {
            if (position && position.direction !== pendingAction) { trades.push(closeTrade(position, bar.open, bar, i)); position = null; }
            if (!position) {
              const entryAtr = atr ?? 0;
              const trailStop = pendingAction === "long" ? bar.open - initialStopMult * entryAtr : bar.open + initialStopMult * entryAtr;
              position = { direction: pendingAction, entryIndex: i, entryTime: bar.time, entryClose: bar.open, trailStop };
            }
          }
          pendingAction = null;
        }

        const currentFast = fastArr[i], pastFast = fastArr[i - 1];
        const currentSlow = slowArr[i], pastSlow = slowArr[i - 1];
        if (currentFast == null || currentSlow == null || pastFast == null || pastSlow == null || !atr) continue;
        const currentClose = closes[i];

        if (position) {
          if (position.direction === "long") {
            position.trailStop = Math.max(position.trailStop, currentClose - trailMult * atr);
            if (currentClose <= position.trailStop) pendingAction = "close";
          } else {
            position.trailStop = Math.min(position.trailStop, currentClose + trailMult * atr);
            if (currentClose >= position.trailStop) pendingAction = "close";
          }
          continue;
        }

        const freshCrossUp = currentFast > currentSlow && pastFast <= pastSlow;
        const freshCrossDown = currentFast < currentSlow && pastFast >= pastSlow;
        if (freshCrossUp) pendingAction = "long";
        else if (freshCrossDown) pendingAction = "short";
      }
      return trades;
    };

    results.push(runSweep("2: EMA-cross trend-following + trailing stop", candles, fearGreed, splitIndex, grid, simulateOne));
  }

  // --- Archetype 3: Donchian breakout entry (+ optional EMA trend filter), trailing ATR stop ---
  {
    const BREAKOUT_PERIODS = [20, 40, 60];
    const TREND_FILTERS = [true, false];
    const INITIAL_STOP_MULTS = [1.5, 2.0, 2.5];
    const TRAIL_MULTS = [1.5, 2.0, 2.5, 3.0];
    const hlCache = new Map();
    const getHL = (p) => {
      if (!hlCache.has(p)) hlCache.set(p, rollingHighLow(candles, p));
      return hlCache.get(p);
    };
    const ema55 = getEma(55);

    const grid = [];
    for (const breakoutPeriod of BREAKOUT_PERIODS)
      for (const trendFilter of TREND_FILTERS)
        for (const initialStopMult of INITIAL_STOP_MULTS)
          for (const trailMult of TRAIL_MULTS)
            grid.push({ breakoutPeriod, trendFilter, initialStopMult, trailMult });

    const simulateOne = (params) => {
      const { breakoutPeriod, trendFilter, initialStopMult, trailMult } = params;
      const { highs, lows } = getHL(breakoutPeriod);
      const trades = [];
      let position = null, pendingAction = null;

      for (let i = WARMUP; i < candles.length; i++) {
        const bar = candles[i];
        const atr = atrArr[i];
        if (pendingAction) {
          if (pendingAction === "close") {
            if (position) { trades.push(closeTrade(position, bar.open, bar, i)); position = null; }
          } else {
            if (position && position.direction !== pendingAction) { trades.push(closeTrade(position, bar.open, bar, i)); position = null; }
            if (!position) {
              const entryAtr = atr ?? 0;
              const trailStop = pendingAction === "long" ? bar.open - initialStopMult * entryAtr : bar.open + initialStopMult * entryAtr;
              position = { direction: pendingAction, entryIndex: i, entryTime: bar.time, entryClose: bar.open, trailStop };
            }
          }
          pendingAction = null;
        }

        const hi = highs[i], lo = lows[i];
        if (hi == null || lo == null || !atr) continue;
        const currentClose = closes[i];

        if (position) {
          if (position.direction === "long") {
            position.trailStop = Math.max(position.trailStop, currentClose - trailMult * atr);
            if (currentClose <= position.trailStop) pendingAction = "close";
          } else {
            position.trailStop = Math.min(position.trailStop, currentClose + trailMult * atr);
            if (currentClose >= position.trailStop) pendingAction = "close";
          }
          continue;
        }

        const trendOk = trendFilter ? ema55[i] != null : true;
        const breaksUp = currentClose > hi && (!trendFilter || currentClose > ema55[i]);
        const breaksDown = currentClose < lo && (!trendFilter || currentClose < ema55[i]);
        if (trendOk && breaksUp) pendingAction = "long";
        else if (trendOk && breaksDown) pendingAction = "short";
      }
      return trades;
    };

    results.push(runSweep("3: Donchian breakout + trailing stop", candles, fearGreed, splitIndex, grid, simulateOne));
  }

  console.log("\n\n=== SUMMARY ===");
  for (const r of results) {
    console.log(`${r.label}: ${r.survivors.length} survivor(s)`);
    for (const s of r.survivors) {
      console.log(`  ${JSON.stringify(s.params)} -- IS ${fmtStats(s.inSample)} | OOS ${fmtStats(s.oos)}`);
    }
  }

  mkdirSync("backtests", { recursive: true });
  const outPath = `backtests/morpho-4h-explore-${new Date().toISOString().slice(0, 10)}.json`;
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        symbol: SYMBOL,
        timeframe: TIMEFRAME,
        candleCount: candles.length,
        splitTime: candles[splitIndex].time,
        results: results.map((r) => ({ label: r.label, top: r.ranked.slice(0, 8), survivors: r.survivors })),
      },
      null,
      2,
    ),
  );
  console.log(`\nFull results written to ${outPath}`);
}

main();
