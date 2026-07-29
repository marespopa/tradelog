// Fine-tunes the user's hand-written MORPHO 4H swing strategy (EMA21/55
// trend, RSI/Bollinger pullback trigger, ATR stop/target with two early
// "protect gains" exits) against real MORPHO history.
//
// Baseline as pasted into the app (1500-bar window): 18 trades, 27.8% win
// rate, +1.37%/trade, +21.0% compounded, -21.0% max DD, Calmar 1.82. That
// win rate is uncomfortably low for a nominal 2:1 stop/target (2.2x/4.4x
// ATR — breakeven win rate ~33% before fees), and n=18 is thin, so before
// trusting it this re-runs the exact same code against MORPHO's FULL OKX
// history (3692 4H candles, 2024-11-21 to now -- 2.46x more bars than the
// in-app run saw) as a sanity check, then sweeps the numeric exit/trend
// knobs (ATR stop multiple, R-multiple, EMA fast/slow period, and whether
// the two early "protect gains" exits help or hurt vs a pure ATR stop/target)
// on the first 70% (in-sample) and only trusts a combo that ALSO stays
// positive on the held-out last 30% (out-of-sample, never used to pick
// anything) -- same discipline as backtest-zscore-tune.js. RSI pullback/
// bounce bands, RSI/BB periods, and the Fear & Greed filter are left exactly
// as written (not swept), to keep the grid honest-sized and because the
// trend/exit shape is the more likely lever for a strategy already in the
// right ballpark.
import { fetchCandleHistory } from "../src/lib/analysis/okx.js";
import { fetchFearGreedHistory, alignFearGreedToBars } from "../src/lib/analysis/fearGreed.js";
import * as ta from "../src/lib/analysis/ta.js";
import { writeFileSync, mkdirSync } from "node:fs";

const SYMBOL = "MORPHO";
const TIMEFRAME = "4h";
const HISTORY_BARS = 3692; // full OKX history for MORPHO as of 2026-07-29
const WARMUP = 100; // matches the strategy's own `if (bars.length < 100) return;`
const ROUNDTRIP_FEE_PCT = 0.2; // matches strategyEngine.js's ROUNDTRIP_FEE_PCT
const IN_SAMPLE_FRACTION = 0.7;
const MIN_IS_TRADES = 12; // below this, in-sample expectancy is too noisy to rank on
const RSI_OVEREXTENDED_LONG = 78;
const RSI_OVEREXTENDED_SHORT = 22;

// --- Exact strategy code as pasted, for a baseline sanity-check run only ---
const BASELINE_CODE = `
const bars = ctx.bars;
if (bars.length < 100) return;
const closes = bars.map(b => b.close);
const ema21 = ctx.ta.ema(closes, 21);
const ema55 = ctx.ta.ema(closes, 55);
const rsi = ctx.ta.rsi(closes, 14);
const bb = ctx.ta.bollingerBands(closes, 20, 2);
const atrSeries = ctx.ta.atr(bars, 14);
const currentClose = closes.at(-1);
const pastClose = closes.at(-2);
const currentEma21 = ema21.at(-1);
const pastEma21 = ema21.at(-2);
const currentEma55 = ema55.at(-1);
const pastEma55 = ema55.at(-2);
const currentRsi = rsi.at(-1);
const pastRsi = rsi.at(-2);
const currentAtr = Array.isArray(atrSeries) ? atrSeries.at(-1) : atrSeries;
if (currentEma21 === null || currentEma55 === null || currentRsi === null || !bb || !currentAtr) return;
const fg = ctx.fearGreed ? ctx.fearGreed.at(-1) : null;
const fgVal = fg ? fg.value : 50;
const pos = ctx.position;
if (pos) {
  const entry = pos.entryPrice;
  if (pos.direction === "long") {
    const stop = entry - (2.2 * currentAtr);
    const tp = entry + (4.4 * currentAtr);
    const targetOrStopHit = currentClose <= stop || currentClose >= tp;
    const trendReversed = currentEma21 < currentEma55 && pastEma21 >= pastEma55;
    const rsiOverextended = currentRsi > 78 && pastRsi <= 78;
    if (targetOrStopHit || trendReversed || rsiOverextended) return "close";
  } else if (pos.direction === "short") {
    const stop = entry + (2.2 * currentAtr);
    const tp = entry - (4.4 * currentAtr);
    const targetOrStopHit = currentClose >= stop || currentClose <= tp;
    const trendReversed = currentEma21 > currentEma55 && pastEma21 <= pastEma55;
    const rsiOverextended = currentRsi < 22 && pastRsi >= 22;
    if (targetOrStopHit || trendReversed || rsiOverextended) return "close";
  }
  return;
}
const isUptrend = currentEma21 > currentEma55;
const isDowntrend = currentEma21 < currentEma55;
const sentimentNotEuphoric = fgVal < 80;
const sentimentNotPanicked = fgVal > 20;
const isLongPullback = (currentRsi >= 35 && currentRsi <= 48) || currentClose <= bb.lower;
const isShortBounce = (currentRsi >= 52 && currentRsi <= 65) || currentClose >= bb.upper;
const turnsUp = currentClose > pastClose && currentRsi > pastRsi;
const turnsDown = currentClose < pastClose && currentRsi < pastRsi;
if (isUptrend && isLongPullback && turnsUp && sentimentNotEuphoric) {
  return { signal: "long", stop: currentClose - (2.2 * currentAtr), target: currentClose + (4.4 * currentAtr) };
}
if (isDowntrend && isShortBounce && turnsDown && sentimentNotPanicked) {
  return { signal: "short", stop: currentClose + (2.2 * currentAtr), target: currentClose - (4.4 * currentAtr) };
}
`;

function normalizeSignal(raw) {
  if (raw && typeof raw === "object") return { direction: raw.signal ?? null };
  return { direction: raw ?? null };
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

// Same one-bar-lag-fill shape as strategyWorker.js, running the pasted code
// string verbatim via new Function -- used once, for the baseline sanity
// check against the app's own reported numbers.
function simulateCode(candles, fearGreed, code) {
  const userFn = new Function("ctx", code);
  const trades = [];
  let position = null;
  let pendingAction = null;

  for (let i = WARMUP; i < candles.length; i++) {
    const bar = candles[i];
    if (pendingAction) {
      if (pendingAction === "close") {
        if (position) {
          trades.push(closeTrade(position, bar.open, bar, i));
          position = null;
        }
      } else {
        if (position && position.direction !== pendingAction) {
          trades.push(closeTrade(position, bar.open, bar, i));
          position = null;
        }
        if (!position) position = { direction: pendingAction, entryIndex: i, entryTime: bar.time, entryClose: bar.open };
      }
      pendingAction = null;
    }

    const raw = userFn({
      bars: candles.slice(0, i + 1),
      position: position ? { direction: position.direction, entryIndex: position.entryIndex, entryPrice: position.entryClose } : null,
      ta,
      fearGreed: fearGreed.slice(0, i + 1),
    });
    const { direction } = normalizeSignal(raw);
    if (direction === "close" || direction === "long" || direction === "short") pendingAction = direction;
  }
  return trades;
}

// --- Parameterized native re-implementation, for the sweep (fast: reads
// precomputed indicator arrays instead of re-slicing+recomputing per bar) ---
function simulateParams(candles, fearGreed, precomputed, params) {
  const { emaFast, emaSlow, stopMult, targetMult, useEarlyExits } = params;
  const { closes, rsiArr, bbArr, atrArr, emaCache } = precomputed;
  const emaFastArr = emaCache.get(emaFast);
  const emaSlowArr = emaCache.get(emaSlow);

  const trades = [];
  let position = null;
  let pendingAction = null;

  for (let i = WARMUP; i < candles.length; i++) {
    const bar = candles[i];
    if (pendingAction) {
      if (pendingAction === "close") {
        if (position) {
          trades.push(closeTrade(position, bar.open, bar, i));
          position = null;
        }
      } else {
        if (position && position.direction !== pendingAction) {
          trades.push(closeTrade(position, bar.open, bar, i));
          position = null;
        }
        if (!position) position = { direction: pendingAction, entryIndex: i, entryTime: bar.time, entryClose: bar.open };
      }
      pendingAction = null;
    }

    const bb = bbArr[i];
    const atr = atrArr[i];
    const currentRsi = rsiArr[i];
    const pastRsi = rsiArr[i - 1];
    const currentEmaFast = emaFastArr[i];
    const pastEmaFast = emaFastArr[i - 1];
    const currentEmaSlow = emaSlowArr[i];
    const pastEmaSlow = emaSlowArr[i - 1];
    if (currentEmaFast == null || currentEmaSlow == null || currentRsi == null || !bb || !atr) continue;

    const currentClose = closes[i];
    const pastClose = closes[i - 1];
    const fg = fearGreed[i];
    const fgVal = fg ? fg.value : 50;

    if (position) {
      const entry = position.entryClose;
      let exit;
      if (position.direction === "long") {
        const stop = entry - stopMult * atr;
        const tp = entry + targetMult * atr;
        const targetOrStopHit = currentClose <= stop || currentClose >= tp;
        const trendReversed = currentEmaFast < currentEmaSlow && pastEmaFast >= pastEmaSlow;
        const rsiOverextended = currentRsi > RSI_OVEREXTENDED_LONG && pastRsi <= RSI_OVEREXTENDED_LONG;
        exit = targetOrStopHit || (useEarlyExits && (trendReversed || rsiOverextended));
      } else {
        const stop = entry + stopMult * atr;
        const tp = entry - targetMult * atr;
        const targetOrStopHit = currentClose >= stop || currentClose <= tp;
        const trendReversed = currentEmaFast > currentEmaSlow && pastEmaFast <= pastEmaSlow;
        const rsiOverextended = currentRsi < RSI_OVEREXTENDED_SHORT && pastRsi >= RSI_OVEREXTENDED_SHORT;
        exit = targetOrStopHit || (useEarlyExits && (trendReversed || rsiOverextended));
      }
      if (exit) pendingAction = "close";
      continue;
    }

    const isUptrend = currentEmaFast > currentEmaSlow;
    const isDowntrend = currentEmaFast < currentEmaSlow;
    const sentimentNotEuphoric = fgVal < 80;
    const sentimentNotPanicked = fgVal > 20;
    const isLongPullback = (currentRsi >= 35 && currentRsi <= 48) || currentClose <= bb.lower;
    const isShortBounce = (currentRsi >= 52 && currentRsi <= 65) || currentClose >= bb.upper;
    const turnsUp = currentClose > pastClose && currentRsi > pastRsi;
    const turnsDown = currentClose < pastClose && currentRsi < pastRsi;

    if (isUptrend && isLongPullback && turnsUp && sentimentNotEuphoric) pendingAction = "long";
    else if (isDowntrend && isShortBounce && turnsDown && sentimentNotPanicked) pendingAction = "short";
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
  let equity = 1;
  let peak = 1;
  let maxDd = 0;
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
  const calmar = calmarRatio(trades, compoundedPct, maxDd);
  return { n, winRate, ci: [lo, hi], expectancyPct, compoundedPct, maxDrawdownPct: maxDd, calmarRatio: calmar };
}

function fmtStats(s) {
  if (!s.n) return "n=0";
  return `n=${s.n} winRate=${(s.winRate * 100).toFixed(0)}% expectancy=${s.expectancyPct >= 0 ? "+" : ""}${s.expectancyPct.toFixed(2)}%/trade compounded=${s.compoundedPct >= 0 ? "+" : ""}${s.compoundedPct.toFixed(1)}% maxDD=-${s.maxDrawdownPct.toFixed(1)}% Calmar=${s.calmarRatio != null ? s.calmarRatio.toFixed(2) : "n/a"}`;
}

async function main() {
  console.log(`Fetching ${HISTORY_BARS} x ${TIMEFRAME} candles for ${SYMBOL}...`);
  const candles = await fetchCandleHistory(SYMBOL, TIMEFRAME, HISTORY_BARS);
  console.log(`Got ${candles.length} candles, ${new Date(candles[0].time).toISOString().slice(0, 10)} to ${new Date(candles.at(-1).time).toISOString().slice(0, 10)}`);
  const fgHistory = await fetchFearGreedHistory();
  const fearGreed = alignFearGreedToBars(fgHistory, candles);

  const buyHoldPct = ((candles.at(-1).close - candles[WARMUP].close) / candles[WARMUP].close) * 100;

  // --- Baseline: exact pasted code, full history ---
  const baselineTrades = simulateCode(candles, fearGreed, BASELINE_CODE);
  const baselineStats = stats(baselineTrades);
  console.log(`\n=== Baseline (as pasted, full ${candles.length}-bar history) ===`);
  console.log(fmtStats(baselineStats));
  console.log(`Buy & hold over the same window: ${buyHoldPct >= 0 ? "+" : ""}${buyHoldPct.toFixed(1)}%`);

  // --- Precompute indicators once (shared across every grid combo) ---
  const closes = candles.map((c) => c.close);
  const rsiArr = ta.rsi(closes, 14);
  const bbArr = closes.map((_, i) => (i + 1 >= 20 ? ta.bollingerBands(closes.slice(0, i + 1), 20, 2) : null));
  const atrArr = candles.map((_, i) => (i + 1 >= 15 ? ta.atr(candles.slice(0, i + 1), 14) : null));

  const EMA_PAIRS = [
    [13, 34],
    [21, 55],
    [34, 89],
  ];
  const emaCache = new Map();
  for (const [fast, slow] of EMA_PAIRS) {
    if (!emaCache.has(fast)) emaCache.set(fast, ta.ema(closes, fast));
    if (!emaCache.has(slow)) emaCache.set(slow, ta.ema(closes, slow));
  }
  const precomputed = { closes, rsiArr, bbArr, atrArr, emaCache };

  const STOP_MULTS = [1.5, 2.0, 2.2, 2.5, 3.0];
  const R_MULTIPLES = [1.5, 2.0, 2.5, 3.0]; // target = stop * R
  const EARLY_EXIT_OPTIONS = [true, false];

  const grid = [];
  for (const [emaFast, emaSlow] of EMA_PAIRS)
    for (const stopMult of STOP_MULTS)
      for (const rMult of R_MULTIPLES)
        for (const useEarlyExits of EARLY_EXIT_OPTIONS)
          grid.push({ emaFast, emaSlow, stopMult, targetMult: stopMult * rMult, rMult, useEarlyExits });

  console.log(`\nSweeping ${grid.length} parameter combinations, in-sample only...`);
  const splitIndex = Math.floor(candles.length * IN_SAMPLE_FRACTION);
  console.log(`In-sample: bars 0-${splitIndex} (through ${new Date(candles[splitIndex].time).toISOString().slice(0, 10)})`);
  console.log(`Out-of-sample (held out, never used to pick a candidate): ${new Date(candles[splitIndex].time).toISOString().slice(0, 10)} to ${new Date(candles.at(-1).time).toISOString().slice(0, 10)}`);

  const scored = grid.map((params) => {
    const allTrades = simulateParams(candles, fearGreed, precomputed, params);
    const inSample = stats(allTrades.filter((t) => t.entryIndex < splitIndex));
    return { params, inSample, allTrades };
  });

  const ranked = scored.filter((s) => s.inSample.n >= MIN_IS_TRADES).sort((a, b) => b.inSample.expectancyPct - a.inSample.expectancyPct);
  console.log(`${ranked.length} / ${grid.length} combos had >= ${MIN_IS_TRADES} in-sample trades.`);

  const TOP_N = 15;
  console.log(`\nTop ${TOP_N} by in-sample expectancy, checked against the held-out out-of-sample window:\n`);

  const survivors = [];
  for (const s of ranked.slice(0, TOP_N)) {
    const oosTrades = s.allTrades.filter((t) => t.entryIndex >= splitIndex);
    const oos = stats(oosTrades);
    const survives = oos.n >= Math.ceil(MIN_IS_TRADES / 2) && oos.expectancyPct > 0;
    if (survives) survivors.push({ ...s, oos });
    const { emaFast, emaSlow, stopMult, rMult, useEarlyExits } = s.params;
    console.log(
      `ema${emaFast}/${emaSlow} stop=${stopMult}x R=${rMult} earlyExits=${useEarlyExits ? "on " : "off"} | IS: ${fmtStats(s.inSample)} | OOS: ${fmtStats(oos)} | ${survives ? "SURVIVES" : oos.n < Math.ceil(MIN_IS_TRADES / 2) ? `no (only ${oos.n} OOS trades)` : "no (negative OOS)"}`,
    );
  }

  console.log(`\n${survivors.length || "No"} candidate(s) stayed positive on both the tuning window AND the held-out window:`);
  for (const s of survivors) {
    const { emaFast, emaSlow, stopMult, rMult, useEarlyExits } = s.params;
    console.log(
      `  ema${emaFast}/${emaSlow} stop=${stopMult}x ATR, target=${(stopMult * rMult).toFixed(2)}x ATR (R=${rMult}), earlyExits=${useEarlyExits} -- ` +
        `in-sample ${fmtStats(s.inSample)}, out-of-sample ${fmtStats(s.oos)}`,
    );
  }

  mkdirSync("backtests", { recursive: true });
  const outPath = `backtests/morpho-4h-tune-${new Date().toISOString().slice(0, 10)}.json`;
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        symbol: SYMBOL,
        timeframe: TIMEFRAME,
        candleCount: candles.length,
        buyHoldPct,
        baseline: baselineStats,
        splitTime: candles[splitIndex].time,
        top: ranked.slice(0, TOP_N).map((s) => ({ params: s.params, inSample: s.inSample, oos: stats(s.allTrades.filter((t) => t.entryIndex >= splitIndex)) })),
        survivors: survivors.map((s) => ({ params: s.params, inSample: s.inSample, oos: s.oos })),
      },
      null,
      2,
    ),
  );
  console.log(`\nFull sweep results written to ${outPath}`);
}

main();
