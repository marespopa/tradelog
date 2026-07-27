// Parameter sweep for the EMA200 touch/bounce rule (the one candidate from
// backtest-sol-4h-search.js that cleared breakeven on SOL 4H), with an
// in-sample/out-of-sample split so a "positive" result can't just be
// curve-fit to this specific price history. First ~70% of the fetched
// history is the tuning set (grid search picks candidates here); the last
// ~30% is held out and only ever used to check the survivors — a parameter
// set that isn't tried against it can't be selected because of it. Only
// report a parameter set as real if it stays positive on BOTH halves.
import { fetchCandleHistory } from "../src/lib/analysis/okx.js";
import { ema, atr } from "../src/lib/analysis/ta.js";
import { writeFileSync, mkdirSync } from "node:fs";

const SYMBOL = "SOL";
const TIMEFRAME = "4h";
const HISTORY_BARS = 3600; // ~600 days, same window backtest-sol-4h-search.js used
const MAX_HOLD_BARS = 90;
const WARMUP = 250; // covers the largest EMA_PERIOD tried (250) plus ATR settle
const IN_SAMPLE_FRACTION = 0.7;
const MIN_TRADES_PER_SIDE = 12; // below this, a side's win rate is too noisy to act on

function wilsonInterval(wins, n, z = 1.96) {
  if (n === 0) return [0, 0];
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(center - margin) / denom, (center + margin) / denom];
}

function detectMa200Bounce(sub, { emaPeriod, touchPct, stopAtrMult, targetRR }) {
  const bar = sub.at(-1);
  const prevBar = sub.at(-2);
  if (!prevBar) return null;
  const closes = sub.map((b) => b.close);
  const emaVal = ema(closes, emaPeriod).at(-1);
  const atrValue = atr(sub, 14);
  if (emaVal == null || atrValue == null) return null;

  const longTouch = bar.low <= emaVal * (1 + touchPct) && bar.close > emaVal && prevBar.close > emaVal;
  const shortTouch = bar.high >= emaVal * (1 - touchPct) && bar.close < emaVal && prevBar.close < emaVal;

  if (longTouch) {
    const stop = bar.low - stopAtrMult * atrValue;
    const risk = bar.close - stop;
    if (risk > 0) return { direction: "long", entry: bar.close, stop, target: bar.close + targetRR * risk, rr: targetRR };
  } else if (shortTouch) {
    const stop = bar.high + stopAtrMult * atrValue;
    const risk = stop - bar.close;
    if (risk > 0) return { direction: "short", entry: bar.close, stop, target: bar.close - targetRR * risk, rr: targetRR };
  }
  return null;
}

// Single pass over the whole series; each closed trade is tagged with the
// bar index it entered on, so the caller can bucket it into in-sample/
// out-of-sample after the fact without re-running the simulation per split.
function simulateRR(candles, detect, params) {
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

    const signal = detect(candles.slice(0, i + 1), params);
    if (signal) openTrade = { entryIndex: i, entryTime: bar.time, ...signal };
  }

  return trades;
}

function stats(trades) {
  const resolved = trades.filter((t) => t.outcome !== "timeout");
  const wins = resolved.filter((t) => t.outcome === "win");
  const n = resolved.length;
  const winRate = n ? wins.length / n : 0;
  const [lo, hi] = wilsonInterval(wins.length, n);
  const avgWinR = wins.length ? wins.reduce((s, t) => s + t.realizedR, 0) / wins.length : 0;
  const breakevenWinRate = avgWinR > 0 ? 1 / (1 + avgWinR) : null;
  const expectancyR = n ? winRate * avgWinR - (1 - winRate) * 1 : 0;
  return { n, wins: wins.length, winRate, ci: [lo, hi], avgWinR, breakevenWinRate, expectancyR };
}

async function main() {
  console.log(`Fetching ${HISTORY_BARS} x ${TIMEFRAME} candles for ${SYMBOL}...`);
  const candles = await fetchCandleHistory(SYMBOL, TIMEFRAME, HISTORY_BARS);
  console.log(`Got ${candles.length} candles, ${new Date(candles[0].time).toISOString().slice(0, 10)} to ${new Date(candles.at(-1).time).toISOString().slice(0, 10)}`);

  const splitIndex = Math.floor(candles.length * IN_SAMPLE_FRACTION);
  const splitTime = candles[splitIndex].time;
  console.log(`In-sample: bars 0-${splitIndex} (${new Date(candles[0].time).toISOString().slice(0, 10)} to ${new Date(splitTime).toISOString().slice(0, 10)})`);
  console.log(`Out-of-sample (held out, never used to pick a candidate): bars ${splitIndex}-${candles.length} (${new Date(splitTime).toISOString().slice(0, 10)} to ${new Date(candles.at(-1).time).toISOString().slice(0, 10)})`);

  const EMA_PERIODS = [150, 200, 250];
  const TOUCH_PCTS = [0.002, 0.003, 0.005];
  const STOP_ATR_MULTS = [0.75, 1, 1.5];
  const TARGET_RRS = [1.5, 2, 2.5, 3];

  const grid = [];
  for (const emaPeriod of EMA_PERIODS)
    for (const touchPct of TOUCH_PCTS)
      for (const stopAtrMult of STOP_ATR_MULTS)
        for (const targetRR of TARGET_RRS)
          grid.push({ emaPeriod, touchPct, stopAtrMult, targetRR });

  console.log(`\nSweeping ${grid.length} parameter combinations, in-sample only...`);

  const scored = grid.map((params) => {
    const allTrades = simulateRR(candles, detectMa200Bounce, params);
    const inSample = stats(allTrades.filter((t) => t.entryIndex < splitIndex));
    return { params, inSample, allTrades };
  });

  // Rank by in-sample expectancy, but only among combos with enough
  // in-sample trades to mean anything -- a 3-trade "100% win rate" combo
  // would otherwise dominate the top of the list for pure noise reasons.
  const ranked = scored
    .filter((s) => s.inSample.n >= MIN_TRADES_PER_SIDE)
    .sort((a, b) => b.inSample.expectancyR - a.inSample.expectancyR);

  console.log(`${ranked.length} combos had >= ${MIN_TRADES_PER_SIDE} in-sample trades.`);

  const TOP_N = 8;
  console.log(`\nTop ${TOP_N} by in-sample expectancy, now checked against the held-out out-of-sample window:\n`);
  console.log("emaPeriod touchPct stopATR targetRR | IS: n winRate expectancy | OOS: n winRate expectancy | survives?");

  const survivors = [];
  for (const s of ranked.slice(0, TOP_N)) {
    const oos = stats(s.allTrades.filter((t) => t.entryIndex >= splitIndex));
    const survives = oos.n >= MIN_TRADES_PER_SIDE && oos.expectancyR > 0;
    if (survives) survivors.push({ ...s, oos });
    const { emaPeriod, touchPct, stopAtrMult, targetRR } = s.params;
    console.log(
      `${String(emaPeriod).padEnd(9)} ${String(touchPct).padEnd(8)} ${String(stopAtrMult).padEnd(7)} ${String(targetRR).padEnd(8)} | ` +
        `IS: ${String(s.inSample.n).padEnd(3)} ${(s.inSample.winRate * 100).toFixed(0).padStart(3)}%   ${s.inSample.expectancyR >= 0 ? "+" : ""}${s.inSample.expectancyR.toFixed(2)}R | ` +
        `OOS: ${String(oos.n).padEnd(3)} ${(oos.winRate * 100).toFixed(0).padStart(3)}%   ${oos.expectancyR >= 0 ? "+" : ""}${oos.expectancyR.toFixed(2)}R | ` +
        `${survives ? "YES" : oos.n < MIN_TRADES_PER_SIDE ? `no (only ${oos.n} OOS trades)` : "no (negative OOS)"}`,
    );
  }

  console.log(`\n${survivors.length ? survivors.length : "No"} candidate(s) stayed positive on both the tuning window AND the held-out window:`);
  for (const s of survivors) {
    console.log(
      `  emaPeriod=${s.params.emaPeriod} touchPct=${s.params.touchPct} stopAtrMult=${s.params.stopAtrMult} targetRR=${s.params.targetRR} ` +
        `-- in-sample +${s.inSample.expectancyR.toFixed(2)}R (n=${s.inSample.n}), out-of-sample +${s.oos.expectancyR.toFixed(2)}R (n=${s.oos.n})`,
    );
  }

  // Also report the untuned default (200/0.003/1/2, from backtest-sol-4h-search.js)
  // on the same split, as the baseline every tuned candidate has to beat.
  const baseline = scored.find((s) => s.params.emaPeriod === 200 && s.params.touchPct === 0.003 && s.params.stopAtrMult === 1 && s.params.targetRR === 2);
  const baselineOos = stats(baseline.allTrades.filter((t) => t.entryIndex >= splitIndex));
  console.log(
    `\nBaseline (untuned defaults, ema=200 touch=0.003 stopATR=1 targetRR=2): in-sample ${baseline.inSample.expectancyR >= 0 ? "+" : ""}${baseline.inSample.expectancyR.toFixed(2)}R (n=${baseline.inSample.n}), out-of-sample ${baselineOos.expectancyR >= 0 ? "+" : ""}${baselineOos.expectancyR.toFixed(2)}R (n=${baselineOos.n})`,
  );

  mkdirSync("backtests", { recursive: true });
  const outPath = `backtests/sol-ema200-bounce-tune-${new Date().toISOString().slice(0, 10)}.json`;
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        symbol: SYMBOL,
        timeframe: TIMEFRAME,
        splitTime,
        top: ranked.slice(0, TOP_N).map((s) => ({ params: s.params, inSample: s.inSample, oos: stats(s.allTrades.filter((t) => t.entryIndex >= splitIndex)) })),
        survivors: survivors.map((s) => ({ params: s.params, inSample: s.inSample, oos: s.oos })),
        baseline: { inSample: baseline.inSample, oos: baselineOos },
      },
      null,
      2,
    ),
  );
  console.log(`\nFull sweep results written to ${outPath}`);
}

main();
