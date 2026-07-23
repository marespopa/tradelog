// Single/two-candle price-action pattern detectors (pin bar, engulfing,
// inside bar) — a distinct category of entry trigger from the indicator
// crossovers in ta.js, added specifically to test the FXNX 4H swing
// strategy's rules (EMA50 + D1 trend filter + candlestick pattern at a
// tested S/R level). Kept as small pure functions in the same style as
// ta.js so they're reusable outside the backtest if useful later.
function bodySize(c) {
  return Math.abs(c.close - c.open);
}
function totalRange(c) {
  return c.high - c.low;
}
function upperWick(c) {
  return c.high - Math.max(c.open, c.close);
}
function lowerWick(c) {
  return Math.min(c.open, c.close) - c.low;
}

// A rejection candle: a wick at least 2x the body, taking up most of the
// bar's range, closing in the opposite third of the range from the wick.
export function isPinBar(c, direction) {
  const r = totalRange(c);
  if (r <= 0) return false;
  const body = bodySize(c);
  if (direction === "bullish") {
    const wick = lowerWick(c);
    return wick >= body * 2 && wick / r >= 0.6 && (c.close - c.low) / r >= 0.6;
  }
  const wick = upperWick(c);
  return wick >= body * 2 && wick / r >= 0.6 && (c.high - c.close) / r >= 0.6;
}

// Current candle's body fully contains the previous candle's body, in the
// opposite direction of the previous candle.
export function isEngulfing(prev, cur, direction) {
  if (direction === "bullish") {
    return cur.close > cur.open && prev.close < prev.open && cur.close >= prev.open && cur.open <= prev.close;
  }
  return cur.close < cur.open && prev.close > prev.open && cur.close <= prev.open && cur.open >= prev.close;
}

// A consolidation candle fully contained within the prior ("mother") bar's
// range — the setup, not the trigger; the trigger is a later close beyond
// the mother bar's range (see isInsideBarBreakout).
export function isInsideBar(mother, inside) {
  return inside.high <= mother.high && inside.low >= mother.low;
}

export function isInsideBarBreakout(mother, inside, breakout, direction) {
  if (!isInsideBar(mother, inside)) return false;
  return direction === "bullish" ? breakout.close > mother.high : breakout.close < mother.low;
}
