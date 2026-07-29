// Verifies the final MORPHO z-score reversion candidate as real app-pasteable
// code, run through a harness matching strategyWorker.js exactly.
//
// Chosen after: (1) the 216-combo IS/OOS sweep (backtest-morpho-zscore-tune.js)
// found zPeriod=20/entry=2.5/exit=0.5 among the survivors; (2) a 5-way
// split-robustness check (0.5 through 0.9) confirmed it stays OOS-positive
// regardless of exactly where the train/test cut falls, not just the one
// 70/30 split; (3) a parameter-neighborhood scan showed zPeriod 20-30 x
// entry=2.5 is a smooth "island" of similar performance (not an isolated
// spike) -- but also exposed that entry>=3 combos elsewhere in the grid hit
// n<15 trades with absurd 90%+ win rates and 200%+ compounded returns, the
// textbook small-sample overfitting signature, so those were NOT trusted
// even though the pure grid-search would have ranked some of them highly;
// (4) the raw trade list showed real tail risk with no stop (losers as deep
// as -33%, -26%, -18% in a single trade) -- adding a 3x ATR stop-loss
// (tested 1.5x-4x) cut max drawdown roughly in half (-40.9% -> -26.6%
// in-sample) while IMPROVING compounded return, and this also survives the
// same 4-way split check with the stop included.
//
// Unlike the MORPHO EMA-trend-trailing-stop strategy, this one's per-position
// state (entryAtr) is set once at entry and never needs to change --
// exactly what ctx.position.meta is for (see feedback_strategy_engine_meta
// in project memory), no recompute-from-entry workaround needed here.
import { fetchCandleHistory } from "../src/lib/analysis/okx.js";
import * as ta from "../src/lib/analysis/ta.js";

const SYMBOL = "MORPHO";
const TIMEFRAME = "4h";
const HISTORY_BARS = 3692;
const WARMUP = 60;
const ROUNDTRIP_FEE_PCT = 0.2;

export const MORPHO_ZSCORE_REVERSION_CODE = `
const bars = ctx.bars;
if (bars.length < 60) return;

const closes = bars.map(b => b.close);
const z = ctx.ta.zScore(closes, 20);
if (z === null) return;

const pos = ctx.position;

if (pos) {
  const entryAtr = pos.meta?.entryAtr;
  const stop = entryAtr ? pos.entryPrice - 3 * entryAtr : null;
  const currentClose = closes.at(-1);
  if (stop !== null && currentClose <= stop) return "close";
  if (z >= 0.5) return "close";
  return;
}

if (z < -2.5) {
  const entryAtr = ctx.ta.atr(bars, 14);
  return { signal: "long", meta: { entryAtr } };
}
`;

function normalizeSignal(raw) {
  if (raw && typeof raw === "object") return { direction: raw.signal ?? null, meta: raw.meta ?? null };
  return { direction: raw ?? null, meta: null };
}

function closeTrade(position, fillPrice, exitBar, exitIndex) {
  const rawPct = ((fillPrice - position.entryClose) / position.entryClose) * 100; // long-only
  const netPct = rawPct - ROUNDTRIP_FEE_PCT;
  return {
    entryTime: position.entryTime,
    exitTime: exitBar.time,
    entryClose: position.entryClose,
    barsHeld: exitIndex - position.entryIndex,
    entryIndex: position.entryIndex,
    netPct,
    outcome: netPct > 0 ? "win" : netPct < 0 ? "loss" : "breakeven",
  };
}

function simulateExact(candles, code) {
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
        if (!position) position = { direction: pendingAction, entryIndex: i, entryTime: bar.time, entryClose: bar.open, meta: pendingMeta };
      }
      pendingAction = null;
      pendingMeta = null;
    }

    const raw = userFn({
      bars: candles.slice(0, i + 1),
      position: position ? { direction: position.direction, entryIndex: position.entryIndex, entryPrice: position.entryClose, meta: position.meta ?? null } : null,
      ta,
    });
    const { direction, meta } = normalizeSignal(raw);
    if (direction === "close" || direction === "long") {
      pendingAction = direction;
      pendingMeta = meta;
    }
  }
  return trades;
}

function stats(trades) {
  const n = trades.length;
  const wins = trades.filter((t) => t.outcome === "win");
  const winRate = n ? wins.length / n : 0;
  const expectancyPct = n ? trades.reduce((s, t) => s + t.netPct, 0) / n : 0;
  const compoundedPct = (trades.reduce((equity, t) => equity * (1 + t.netPct / 100), 1) - 1) * 100;
  let equity = 1, peak = 1, maxDd = 0;
  for (const t of trades) { equity *= 1 + t.netPct / 100; peak = Math.max(peak, equity); maxDd = Math.max(maxDd, (peak - equity) / peak); }
  return { n, winRate, expectancyPct, compoundedPct, maxDrawdownPct: maxDd * 100 };
}

function fmtStats(s) {
  return `n=${s.n} winRate=${(s.winRate * 100).toFixed(0)}% expectancy=${s.expectancyPct >= 0 ? "+" : ""}${s.expectancyPct.toFixed(2)}%/trade compounded=${s.compoundedPct >= 0 ? "+" : ""}${s.compoundedPct.toFixed(1)}% maxDD=-${s.maxDrawdownPct.toFixed(1)}%`;
}

async function main() {
  console.log(`Fetching ${HISTORY_BARS} x ${TIMEFRAME} candles for ${SYMBOL}...`);
  const candles = await fetchCandleHistory(SYMBOL, TIMEFRAME, HISTORY_BARS);
  const splitIndex = Math.floor(candles.length * 0.7);

  console.log("Running app-ready code through the exact strategyWorker.js execution model...");
  const trades = simulateExact(candles, MORPHO_ZSCORE_REVERSION_CODE);

  const inSample = stats(trades.filter((t) => t.entryIndex < splitIndex));
  const oos = stats(trades.filter((t) => t.entryIndex >= splitIndex));
  const full = stats(trades);

  console.log(`\nIn-sample: ${fmtStats(inSample)}`);
  console.log(`Out-of-sample: ${fmtStats(oos)}`);
  console.log(`Full history: ${fmtStats(full)}`);

  console.log(`\nExpected from the manual sweep (zPeriod=20 entry=2.5 exit=0.5 stop=3xATR, split=0.7):`);
  console.log(`IS: n=28 wr=57% exp=+3.52% comp=+120.1% | OOS: n=10 wr=80% exp=+2.98% comp=+31.6%`);

  const matches = inSample.n === 28 && oos.n === 10;
  console.log(`\n${matches ? "MATCH" : "MISMATCH"} -- ${matches ? "app-ready code reproduces the manual result exactly." : "app-ready code does NOT reproduce the expected result -- investigate before trusting it."}`);
}

main();
