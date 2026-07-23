// FXNX 4H swing strategy (https://fxnx.com/en/blog/mastering-the-4-hour-swing-trading-strategy-with-fxnx):
// D1 trend filter + 4H EMA50 filter, entry trigger is a pin bar / engulfing /
// inside-bar-breakout at a horizontal S/R level tested >=2 times, stop
// beyond the rejection wick. Backtested (scripts/backtest-fxnx-swing.js,
// scripts/backtest-fxnx-oos.js) at the 2R target: +0.07R/trade in-sample,
// +0.10R/trade out-of-sample on unseen later data, win rate ~35-37% against
// a 33.3% breakeven — a thin edge that survived a naive out-of-sample check,
// not a confirmed system (the win rate's lower confidence bound sits right
// at breakeven). Every other setup tested in this app lost money; this is
// the one exception, hence "the edge" — shared here so the live scanner and
// the backtest scripts run the identical rule instead of drifting apart.
import { ema, atr, findSwingLevels } from "./ta.js";
import { isPinBar, isEngulfing, isInsideBarBreakout } from "./patterns.js";

export const FXNX_R_MULTIPLE = 2;
export const FXNX_WARMUP_BARS = 320; // ~50 complete daily candles (300 4H bars) for D1 EMA50, plus buffer
const DAY_MS = 86400000;

// Groups 4H candles into daily OHLC, dropping a trailing incomplete day (< 6
// bars) so the "current" daily candle is never treated as closed early.
export function buildDailyCandles(candles) {
  const byDay = new Map();
  for (const c of candles) {
    const dayKey = Math.floor(c.time / DAY_MS);
    if (!byDay.has(dayKey)) byDay.set(dayKey, []);
    byDay.get(dayKey).push(c);
  }
  const days = [...byDay.entries()].sort((a, b) => a[0] - b[0]);
  if (days.length && days.at(-1)[1].length < 6) days.pop();
  return days.map(([, bars]) => ({
    time: bars[0].time,
    open: bars[0].open,
    high: Math.max(...bars.map((b) => b.high)),
    low: Math.min(...bars.map((b) => b.low)),
    close: bars.at(-1).close,
  }));
}

// Finds the trigger + stop for the FXNX rule set at the tail of `candles`
// (candles up to and including the last one only — no lookahead). Returns
// null if no trend-aligned, level-confirmed pattern is present at the last
// candle.
export function findFxnxSignal(candles) {
  const closes = candles.map((c) => c.close);
  if (closes.length < FXNX_WARMUP_BARS) return null;

  const daily = buildDailyCandles(candles);
  if (daily.length < 50) return null;
  const dailyEma50 = ema(daily.map((d) => d.close), 50).at(-1);
  const d1Close = daily.at(-1).close;
  const d1Direction = d1Close > dailyEma50 ? "bullish" : d1Close < dailyEma50 ? "bearish" : null;
  if (!d1Direction) return null;

  const ema50_4h = ema(closes, 50).at(-1);
  const cur = candles.at(-1);
  const h4Direction = cur.close > ema50_4h ? "bullish" : cur.close < ema50_4h ? "bearish" : null;
  if (h4Direction !== d1Direction) return null;

  const direction = h4Direction;
  const atrVal = atr(candles);
  if (atrVal == null) return null;
  const levels = findSwingLevels(candles).filter((l) => l.touches >= 2);
  const levelType = direction === "bullish" ? "support" : "resistance";
  const nearLevel = (price) => levels.some((l) => l.type === levelType && Math.abs(l.price - price) <= atrVal);

  const prev = candles.at(-2);
  const mother = candles.at(-3);
  const buffer = atrVal * 0.1;

  if (isPinBar(cur, direction) && nearLevel(direction === "bullish" ? cur.low : cur.high)) {
    const stop = direction === "bullish" ? cur.low - buffer : cur.high + buffer;
    return { direction, entry: cur.close, stop, trigger: "pinBar" };
  }
  if (prev && isEngulfing(prev, cur, direction) && nearLevel(direction === "bullish" ? Math.min(prev.low, cur.low) : Math.max(prev.high, cur.high))) {
    const stop = direction === "bullish" ? Math.min(prev.low, cur.low) - buffer : Math.max(prev.high, cur.high) + buffer;
    return { direction, entry: cur.close, stop, trigger: "engulfing" };
  }
  if (mother && prev && isInsideBarBreakout(mother, prev, cur, direction) && nearLevel(direction === "bullish" ? mother.low : mother.high)) {
    const stop = direction === "bullish" ? mother.low - buffer : mother.high + buffer;
    return { direction, entry: cur.close, stop, trigger: "insideBar" };
  }
  return null;
}

// Turns a raw signal into a tradeable setup at the given R multiple (fixed
// target = rMultiple * risk beyond entry). Returns null if there's no signal
// or the stop is degenerate (zero risk).
export function buildFxnxTrade(candles, rMultiple = FXNX_R_MULTIPLE) {
  const signal = findFxnxSignal(candles);
  if (!signal) return null;
  const { direction, entry, stop, trigger } = signal;
  const risk = Math.abs(entry - stop);
  if (risk <= 0) return null;
  const target = direction === "bullish" ? entry + rMultiple * risk : entry - rMultiple * risk;
  return { direction: direction === "bullish" ? "long" : "short", entry, stop, target, rr: rMultiple, trigger };
}
