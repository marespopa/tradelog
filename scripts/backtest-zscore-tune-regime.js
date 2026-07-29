// Same sweep as backtest-zscore-tune.js (in-sample/out-of-sample split,
// momentum + reversion polarity, z-period/entry/exit grid) but with one
// structural change: entries are gated to bars where the 4H trend read is
// "sideways" (ta.js's trendFactor -- exported this session specifically for
// this reuse). Mean-reversion has no business firing mid-trend; the
// untethered sweep (backtest-zscore-tune.js) let reversion trades fire
// during ETH's Nov'25-Jul'26 downtrend too, which is exactly the regime a
// reversion bet should sit out. This tests whether z-score has a real edge
// once trending bars are excluded, not whether it "works" everywhere.
import { fetchCandleHistory } from "../src/lib/analysis/okx.js";
import { zScore, trendFactor } from "../src/lib/analysis/ta.js";
import { writeFileSync, mkdirSync } from "node:fs";

const SYMBOL = "ETH";
const TIMEFRAME = "4h";
const HISTORY_BARS = 1500;
const WARMUP = 200; // >= trendFactor's EMA200 requirement for its strongest read
const IN_SAMPLE_FRACTION = 0.7;
const MIN_IS_TRADES = 15;
const TAKER_FEE_PCT = 0.1;
const ROUNDTRIP_TAKER_PCT = TAKER_FEE_PCT * 2;

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

function stats(trades) {
  const n = trades.length;
  const wins = trades.filter((t) => t.netPct > 0);
  const winRate = n ? wins.length / n : 0;
  const [lo, hi] = wilsonInterval(wins.length, n);
  const expectancyPct = n ? trades.reduce((s, t) => s + t.netPct, 0) / n : 0;
  const compoundedPct = (trades.reduce((equity, t) => equity * (1 + t.netPct / 100), 1) - 1) * 100;
  const maxDd = maxDrawdownPct(trades);
  return { n, winRate, ci: [lo, hi], expectancyPct, compoundedPct, maxDrawdownPct: maxDd };
}

function simulate(candles, { zPeriod, entry, exit, direction }) {
  const trades = [];
  let position = null;

  for (let i = WARMUP; i < candles.length; i++) {
    const bar = candles[i];
    const closes = candles.slice(0, i + 1).map((c) => c.close); // no lookahead
    const z = zScore(closes, zPeriod);
    if (z == null) continue;

    if (position) {
      const shouldExit = direction === "momentum" ? z <= exit : z >= exit;
      if (shouldExit) {
        const rawPct = ((bar.close - position.entryClose) / position.entryClose) * 100;
        const netPct = rawPct - ROUNDTRIP_TAKER_PCT;
        trades.push({ entryIndex: position.entryIndex, entryTime: position.entryTime, exitTime: bar.time, barsHeld: i - position.entryIndex, netPct });
        position = null;
      }
      continue;
    }

    const shouldEnter = direction === "momentum" ? z > entry : z < -entry;
    if (!shouldEnter) continue;

    // The regime gate: skip the entry entirely if the 4H trend read (same
    // EMA20/50/200 logic analyzeCandles/the live scan use) isn't "sideways"
    // right now -- no lookahead, recomputed from candles[0..i] only.
    if (trendFactor(closes).label !== "sideways") continue;

    position = { entryIndex: i, entryTime: bar.time, entryClose: bar.close };
  }

  return trades;
}

async function main() {
  console.log(`Fetching ${HISTORY_BARS} x ${TIMEFRAME} candles for ${SYMBOL}...`);
  const candles = await fetchCandleHistory(SYMBOL, TIMEFRAME, HISTORY_BARS);
  console.log(`Got ${candles.length} candles, ${new Date(candles[0].time).toISOString().slice(0, 10)} to ${new Date(candles.at(-1).time).toISOString().slice(0, 10)}`);

  const splitIndex = Math.floor(candles.length * IN_SAMPLE_FRACTION);
  const splitTime = candles[splitIndex].time;
  console.log(`In-sample: bars 0-${splitIndex} (through ${new Date(splitTime).toISOString().slice(0, 10)})`);
  console.log(`Out-of-sample (held out, never used to pick a candidate): bars ${splitIndex}-${candles.length} (${new Date(splitTime).toISOString().slice(0, 10)} to ${new Date(candles.at(-1).time).toISOString().slice(0, 10)})`);

  const DIRECTIONS = ["momentum", "reversion"];
  const Z_PERIODS = [10, 20, 30, 50];
  const ENTRIES = [0.5, 1, 1.5, 2, 2.5, 3];
  const EXITS = [-1, -0.5, 0, 0.5, 1];

  const grid = [];
  for (const direction of DIRECTIONS)
    for (const zPeriod of Z_PERIODS)
      for (const entry of ENTRIES)
        for (const exit of EXITS)
          if (exit < entry) grid.push({ direction, zPeriod, entry, exit });

  console.log(`\nSweeping ${grid.length} parameter combinations (sideways-regime-gated entries), in-sample only...`);

  const scored = grid.map((params) => {
    const allTrades = simulate(candles, params);
    const inSample = stats(allTrades.filter((t) => t.entryIndex < splitIndex));
    return { params, inSample, allTrades };
  });

  const ranked = scored
    .filter((s) => s.inSample.n >= MIN_IS_TRADES && s.inSample.expectancyPct > 0)
    .sort((a, b) => b.inSample.expectancyPct - a.inSample.expectancyPct);
  console.log(`${ranked.length} / ${grid.length} combos had >= ${MIN_IS_TRADES} in-sample trades AND positive in-sample expectancy.`);

  const TOP_N = 12;
  console.log(`\nTop ${Math.min(TOP_N, ranked.length)} by in-sample expectancy, checked against the held-out out-of-sample window:\n`);
  console.log("direction  zPeriod entry exit | IS: n winRate expectancy compounded | OOS: n winRate expectancy compounded maxDD | survives?");

  const survivors = [];
  for (const s of ranked.slice(0, TOP_N)) {
    const oosTrades = s.allTrades.filter((t) => t.entryIndex >= splitIndex);
    const oos = stats(oosTrades);
    const survives = oos.n >= MIN_IS_TRADES / 2 && oos.expectancyPct > 0;
    if (survives) survivors.push({ ...s, oos });
    const { direction, zPeriod, entry, exit } = s.params;
    console.log(
      `${direction.padEnd(10)} ${String(zPeriod).padEnd(7)} ${String(entry).padEnd(5)} ${String(exit).padEnd(4)} | ` +
        `IS: ${String(s.inSample.n).padEnd(3)} ${(s.inSample.winRate * 100).toFixed(0).padStart(3)}%   ${s.inSample.expectancyPct >= 0 ? "+" : ""}${s.inSample.expectancyPct.toFixed(2)}%   ${s.inSample.compoundedPct >= 0 ? "+" : ""}${s.inSample.compoundedPct.toFixed(1)}% | ` +
        `OOS: ${String(oos.n).padEnd(3)} ${(oos.winRate * 100).toFixed(0).padStart(3)}%   ${oos.expectancyPct >= 0 ? "+" : ""}${oos.expectancyPct.toFixed(2)}%   ${oos.compoundedPct >= 0 ? "+" : ""}${oos.compoundedPct.toFixed(1)}%   -${oos.maxDrawdownPct.toFixed(1)}% | ` +
        `${survives ? "YES" : oos.n < MIN_IS_TRADES / 2 ? `no (only ${oos.n} OOS trades)` : "no (negative OOS)"}`,
    );
  }

  console.log(`\n${survivors.length || "No"} candidate(s) stayed positive on both the tuning window AND the held-out window:`);
  for (const s of survivors) {
    console.log(
      `  ${s.params.direction} zPeriod=${s.params.zPeriod} entry=${s.params.entry} exit=${s.params.exit} -- ` +
        `in-sample ${s.inSample.expectancyPct >= 0 ? "+" : ""}${s.inSample.expectancyPct.toFixed(2)}%/trade (n=${s.inSample.n}), ` +
        `out-of-sample ${s.oos.expectancyPct >= 0 ? "+" : ""}${s.oos.expectancyPct.toFixed(2)}%/trade (n=${s.oos.n})`,
    );
  }

  mkdirSync("backtests", { recursive: true });
  const outPath = `backtests/zscore-tune-regime-${SYMBOL.toLowerCase()}-${TIMEFRAME}-${new Date().toISOString().slice(0, 10)}.json`;
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        symbol: SYMBOL,
        timeframe: TIMEFRAME,
        splitTime,
        regimeGate: "sideways (ta.js trendFactor)",
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
