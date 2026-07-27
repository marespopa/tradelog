// Sanity check: runs the new MTF Weekly/Daily/4H swing PRESET code (the
// exact string saved in StrategiesPanel.jsx's MTF_SWING_CODE, executed
// through the same ctx-contract loop strategyWorker.js uses) against real
// SOL 4H history, to confirm it actually fires signals and roughly tracks
// the validated backtest-mtf-swing.js numbers rather than silently
// producing zero trades or throwing.
import { fetchCandleHistory } from "../src/lib/analysis/okx.js";
import { buildDailyCandles, buildWeeklyCandles } from "../src/lib/analysis/timeframes.js";
import { findMtfSignal, buildTrade as buildMtfTrade } from "../src/lib/analysis/mtfSetup.js";
import * as ta from "../src/lib/analysis/ta.js";

const mtf = { buildDailyCandles, buildWeeklyCandles, findMtfSignal, buildTrade: buildMtfTrade };

const SYMBOL = "SOL";
const TIMEFRAME = "4h";
const HISTORY_BARS = 3600;
const WARMUP = 2520;
const ROUNDTRIP_FEE_PCT = 0.2;

const CODE = `
const bars = ctx.bars;
const pos = ctx.position;

if (pos) {
  const { stop, target } = pos.meta ?? {};
  if (stop == null || target == null) return;
  const bar = bars.at(-1);
  const barsHeld = bars.length - 1 - pos.entryIndex;
  const hitExit = pos.direction === "long" ? bar.close <= stop || bar.close >= target : bar.close >= stop || bar.close <= target;
  if (hitExit || barsHeld >= 90) return "close";
  return;
}

const daily = ctx.mtf.buildDailyCandles(bars);
const weekly = ctx.mtf.buildWeeklyCandles(daily);
const trade = ctx.mtf.buildTrade(ctx.mtf.findMtfSignal(weekly, daily, bars), 2);
if (!trade) return;

return { signal: trade.direction, stop: trade.stop, target: trade.target, meta: { stop: trade.stop, target: trade.target } };
`;

function closeTrade(position, fillPrice, exitBar, exitIndex) {
  const rawPct = ((fillPrice - position.entryClose) / position.entryClose) * (position.direction === "long" ? 1 : -1) * 100;
  const netPct = rawPct - ROUNDTRIP_FEE_PCT;
  return { direction: position.direction, entryTime: position.entryTime, exitTime: exitBar.time, barsHeld: exitIndex - position.entryIndex, netPct, outcome: netPct > 0 ? "win" : netPct < 0 ? "loss" : "breakeven" };
}

function simulate(userFn, candles) {
  const trades = [];
  let position = null;
  let pendingAction = null;
  let pendingMeta = null;

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
        if (!position) position = { direction: pendingAction, entryIndex: i, entryTime: bar.time, entryClose: bar.open, meta: pendingMeta };
      }
      pendingAction = null;
      pendingMeta = null;
    }

    const raw = userFn({
      bars: candles.slice(0, i + 1),
      position: position ? { direction: position.direction, entryIndex: position.entryIndex, entryPrice: position.entryClose, meta: position.meta ?? null } : null,
      ta,
      mtf,
      fearGreed: null,
    });

    const direction = raw && typeof raw === "object" ? raw.signal ?? null : raw ?? null;
    const meta = raw && typeof raw === "object" ? raw.meta ?? null : null;
    if (direction === "close" || direction === "long" || direction === "short") {
      pendingAction = direction;
      pendingMeta = meta;
    }
  }
  return trades;
}

async function main() {
  console.log(`Fetching ${HISTORY_BARS} x ${TIMEFRAME} candles for ${SYMBOL}...`);
  const candles = await fetchCandleHistory(SYMBOL, TIMEFRAME, HISTORY_BARS);
  console.log(`Got ${candles.length} candles`);

  const userFn = new Function("ctx", CODE);
  const trades = simulate(userFn, candles);

  const n = trades.length;
  const wins = trades.filter((t) => t.outcome === "win");
  const winRate = n ? wins.length / n : 0;
  const expectancyPct = n ? trades.reduce((s, t) => s + t.netPct, 0) / n : 0;
  const compoundedPct = (trades.reduce((eq, t) => eq * (1 + t.netPct / 100), 1) - 1) * 100;

  console.log(`\ntrades: ${n}`);
  console.log(`win rate: ${(winRate * 100).toFixed(1)}%`);
  console.log(`expectancy: ${expectancyPct >= 0 ? "+" : ""}${expectancyPct.toFixed(2)}%/trade`);
  console.log(`compounded: ${compoundedPct >= 0 ? "+" : ""}${compoundedPct.toFixed(1)}%`);
  console.log(`\nsample trades:`, trades.slice(0, 3));
}

main();
