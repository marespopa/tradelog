// Classical chart-pattern recognition (wedges, triangles, channels,
// rectangles) — fits trendlines through recent swing highs/lows, classifies
// the shape by each line's slope and whether they converge or run parallel,
// then reads off a bullish/bearish bias, a continuation/reversal role
// (relative to whatever trend led into the pattern), and a measured-move
// target. Deliberately limited to these 8 shapes: they're the ones a pair of
// trendlines can classify unambiguously from slope + convergence alone.
// Broadening formations, head-and-shoulders, and double tops/bottoms need a
// different detection approach (peak/trough counting rather than trendline
// fitting) and aren't attempted here. Distinct from patterns.js, which
// detects single/two-candle price-action triggers (pin bar, engulfing),
// not multi-week structural shapes.

function mean(values) {
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function linreg(points) {
  const n = points.length;
  const xMean = mean(points.map((p) => p.idx));
  const yMean = mean(points.map((p) => p.price));
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.idx - xMean) * (p.price - yMean);
    den += (p.idx - xMean) ** 2;
  }
  const slope = den !== 0 ? num / den : 0;
  const intercept = yMean - slope * xMean;
  return { slope, intercept, evalAt: (x) => slope * x + intercept };
}

// Swing highs/lows: a high/low that's the most extreme point among
// `strength` candles on each side — the touches a trendline is drawn through.
function findPivots(candles, strength = 2) {
  const highs = [];
  const lows = [];
  for (let i = strength; i < candles.length - strength; i++) {
    const slice = candles.slice(i - strength, i + strength + 1);
    if (candles[i].high === Math.max(...slice.map((c) => c.high))) highs.push({ idx: i, price: candles[i].high });
    if (candles[i].low === Math.min(...slice.map((c) => c.low))) lows.push({ idx: i, price: candles[i].low });
  }
  return { highs, lows };
}

// A line's total move across the pattern window as a % of price, not its
// per-bar slope — keeps "flat" vs "sloped" classification comparable across
// timeframes whose bar count over the same window varies wildly (120 bars of
// 15m is ~30 hours; 120 bars of 1W is ~2.3 years).
function classifySlope(totalPct) {
  if (totalPct > 2) return "up";
  if (totalPct < -2) return "down";
  return "flat";
}

// The trend that led into the pattern: the local close extreme within the
// lookback before the pattern started, and whether the other extreme (peak
// or trough) came before or after it. Used to decide reversal vs continuation
// and to break ties for patterns (symmetrical triangle, rectangle) whose
// bias isn't implied by their own shape.
function findInboundTrend(candles, patternStartIdx) {
  const lookbackStart = Math.max(0, patternStartIdx - 150);
  if (patternStartIdx - lookbackStart < 5) return { direction: "sideways", startIdx: patternStartIdx };

  const slice = candles.slice(lookbackStart, patternStartIdx + 1);
  let minIdx = 0;
  let maxIdx = 0;
  slice.forEach((c, i) => {
    if (c.close < slice[minIdx].close) minIdx = i;
    if (c.close > slice[maxIdx].close) maxIdx = i;
  });
  if (minIdx === maxIdx) return { direction: "sideways", startIdx: patternStartIdx };

  if (minIdx < maxIdx) {
    const movePct = ((slice[maxIdx].close - slice[minIdx].close) / slice[minIdx].close) * 100;
    if (movePct < 3) return { direction: "sideways", startIdx: patternStartIdx };
    return { direction: "bullish", startIdx: lookbackStart + minIdx };
  }
  const movePct = ((slice[maxIdx].close - slice[minIdx].close) / slice[maxIdx].close) * 100;
  if (movePct > -3) return { direction: "sideways", startIdx: patternStartIdx };
  return { direction: "bearish", startIdx: lookbackStart + maxIdx };
}

function medianBarIntervalMs(candles) {
  const gaps = [];
  for (let i = 1; i < candles.length; i++) gaps.push(candles[i].time - candles[i - 1].time);
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

function fmtSpan(ms) {
  const hours = ms / 3.6e6;
  if (hours < 36) {
    const h = Math.max(1, Math.round(hours));
    return `${h} hour${h === 1 ? "" : "s"}`;
  }
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

const TIMEFRAME_FULL_LABEL = { "15m": "15-Minute", "1h": "Hourly", "4h": "4-Hour", "1d": "Daily", "1w": "Weekly" };

const DISPLAY_NAME = {
  risingWedge: "Wedge",
  fallingWedge: "Wedge",
  ascendingTriangle: "Ascending Triangle",
  descendingTriangle: "Descending Triangle",
  symmetricalTriangle: "Symmetrical Triangle",
  channelUp: "Channel",
  channelDown: "Channel",
  rectangle: "Rectangle",
};

const PATTERN_BIAS = {
  risingWedge: "Bearish",
  fallingWedge: "Bullish",
  ascendingTriangle: "Bullish",
  descendingTriangle: "Bearish",
  channelUp: "Bullish",
  channelDown: "Bearish",
  symmetricalTriangle: null,
  rectangle: null,
};

const TELLS_ME = {
  Continuation: {
    Bullish: "After a temporary interruption, the prior uptrend is set to continue.",
    Bearish: "After a temporary interruption, the prior downtrend is set to continue.",
  },
  Reversal: {
    Bullish: "The prior downtrend is showing signs of exhaustion and giving way to a new uptrend.",
    Bearish: "The prior uptrend is showing signs of exhaustion and giving way to a new downtrend.",
  },
};

// Detects one of the 8 classical trendline patterns in the most recent
// ~120-bar window, or returns null if nothing clean is forming (too few
// swing touches, or the two trendlines diverging rather than converging or
// running parallel — a broadening formation this detector doesn't classify).
export function detectChartPattern(candles, timeframe) {
  if (!candles || candles.length < 40) return null;

  const windowBars = Math.min(candles.length - 1, 120);
  const windowStart = candles.length - 1 - windowBars;
  const { highs, lows } = findPivots(candles, 2);
  const highsInWindow = highs.filter((p) => p.idx >= windowStart);
  const lowsInWindow = lows.filter((p) => p.idx >= windowStart);
  if (highsInWindow.length < 2 || lowsInWindow.length < 2) return null;

  const xEnd = candles.length - 1;
  const patternStartIdx = Math.min(highsInWindow[0].idx, lowsInWindow[0].idx);
  if (xEnd - patternStartIdx < 10) return null;

  const upperLine = linreg(highsInWindow);
  const lowerLine = linreg(lowsInWindow);

  const widthStart = upperLine.evalAt(patternStartIdx) - lowerLine.evalAt(patternStartIdx);
  const widthEndRaw = upperLine.evalAt(xEnd) - lowerLine.evalAt(xEnd);
  if (widthStart <= 0) return null;
  const ratio = Math.max(0, widthEndRaw) / widthStart;

  const avgPrice = mean(candles.slice(windowStart).map((c) => c.close));
  const upperTotalPct = ((upperLine.evalAt(xEnd) - upperLine.evalAt(patternStartIdx)) / avgPrice) * 100;
  const lowerTotalPct = ((lowerLine.evalAt(xEnd) - lowerLine.evalAt(patternStartIdx)) / avgPrice) * 100;
  const upSlope = classifySlope(upperTotalPct);
  const lowSlope = classifySlope(lowerTotalPct);

  const isConverging = ratio < 0.65;
  const isParallel = ratio >= 0.65 && ratio <= 1.35;

  let patternKey = null;
  if (isConverging) {
    if (upSlope === "up" && lowSlope === "up") patternKey = "risingWedge";
    else if (upSlope === "down" && lowSlope === "down") patternKey = "fallingWedge";
    else if (upSlope === "flat" && lowSlope === "up") patternKey = "ascendingTriangle";
    else if (upSlope === "down" && lowSlope === "flat") patternKey = "descendingTriangle";
    else if (upSlope === "down" && lowSlope === "up") patternKey = "symmetricalTriangle";
  } else if (isParallel) {
    if (upSlope === "up" && lowSlope === "up") patternKey = "channelUp";
    else if (upSlope === "down" && lowSlope === "down") patternKey = "channelDown";
    else if (upSlope === "flat" && lowSlope === "flat") patternKey = "rectangle";
  }
  if (!patternKey) return null;

  const inbound = findInboundTrend(candles, patternStartIdx);
  const inboundBiasLabel = inbound.direction === "bullish" ? "Bullish" : inbound.direction === "bearish" ? "Bearish" : "Sideways";

  let bias = PATTERN_BIAS[patternKey];
  if (bias == null) {
    if (inboundBiasLabel !== "Sideways") bias = inboundBiasLabel;
    else bias = candles.at(-1).close >= (upperLine.evalAt(xEnd) + lowerLine.evalAt(xEnd)) / 2 ? "Bullish" : "Bearish";
  }

  const isWedge = patternKey === "risingWedge" || patternKey === "fallingWedge";
  const role =
    inboundBiasLabel === "Sideways" ? (isWedge ? "Reversal" : "Continuation") : bias === inboundBiasLabel ? "Continuation" : "Reversal";

  const height = Math.max(widthStart, Math.max(0, widthEndRaw));
  const breakoutLevel = bias === "Bullish" ? upperLine.evalAt(xEnd) : lowerLine.evalAt(xEnd);
  const targetLow = bias === "Bullish" ? breakoutLevel + height * 0.75 : breakoutLevel - height * 1.25;
  const targetHigh = bias === "Bullish" ? breakoutLevel + height * 1.25 : breakoutLevel - height * 0.75;

  const barIntervalMs = medianBarIntervalMs(candles);
  const patternDurationMs = (xEnd - patternStartIdx) * barIntervalMs;
  const inboundDurationMs = (patternStartIdx - inbound.startIdx) * barIntervalMs;
  const termTotalDays = (patternDurationMs + inboundDurationMs) / 86_400_000;
  const term = termTotalDays < 20 ? "Short-Term" : termTotalDays < 90 ? "Intermediate-Term" : "Long-Term";

  const last = candles.at(-1);
  const d = new Date(last.time);
  const dateLabel = `${d.getFullYear()} ${d.toLocaleString("en-US", { month: "short" })} ${d.getDate()}`;

  return {
    title: `${role} ${DISPLAY_NAME[patternKey]} (${bias})`,
    trendClassLabel: `${term} ${bias}`,
    dateLabel,
    timeframeLabel: TIMEFRAME_FULL_LABEL[timeframe] ?? timeframe,
    volumeLabel: Math.round(last.volume).toLocaleString(),
    closePrice: last.close,
    targetLow,
    targetHigh,
    patternDurationLabel: fmtSpan(patternDurationMs),
    inboundTrendDurationLabel: fmtSpan(inboundDurationMs),
    tellsMe: TELLS_ME[role][bias],
    bias,
  };
}
