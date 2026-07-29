import { fmt } from "../format.js";

export function ema(values, period) {
  const k = 2 / (period + 1);
  const out = new Array(values.length);
  let prev = values[0];
  for (let i = 0; i < values.length; i++) {
    prev = i === 0 ? values[0] : values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function rsi(values, period = 14) {
  const out = new Array(values.length).fill(null);
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    if (i <= period) {
      avgGain += gain / period;
      avgLoss += loss / period;
      if (i === period) out[i] = 100 - 100 / (1 + (avgLoss === 0 ? Infinity : avgGain / avgLoss));
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      out[i] = 100 - 100 / (1 + (avgLoss === 0 ? Infinity : avgGain / avgLoss));
    }
  }
  return out;
}

function mean(values) {
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function stddev(values, avg) {
  const m = avg ?? mean(values);
  return Math.sqrt(mean(values.map((v) => (v - m) ** 2)));
}

// Standard 12/26/9 MACD: fast EMA minus slow EMA (the MACD line), its own
// 9-period EMA (the signal line), and the difference between them
// (histogram) — a second, independent read on momentum/trend shifts
// alongside RSI, since a MACD crossover often leads a pure price-EMA
// crossover by a few bars.
export function macd(closes, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  if (closes.length < slowPeriod + signalPeriod) return null;
  const fast = ema(closes, fastPeriod);
  const slow = ema(closes, slowPeriod);
  const macdLine = closes.map((_, i) => fast[i] - slow[i]);
  const signalLine = ema(macdLine, signalPeriod);
  const histogram = macdLine.map((v, i) => v - signalLine[i]);
  const prevHistogram = histogram.at(-2);
  const curHistogram = histogram.at(-1);
  return {
    macd: macdLine.at(-1),
    signal: signalLine.at(-1),
    histogram: curHistogram,
    // A sign flip in the histogram is the MACD/signal crossover itself —
    // surfaced directly so the UI doesn't need to re-derive it from two floats.
    bullishCross: prevHistogram != null && prevHistogram <= 0 && curHistogram > 0,
    bearishCross: prevHistogram != null && prevHistogram >= 0 && curHistogram < 0,
  };
}

// Bollinger Bands: a 20-period mean +/- 2 standard deviations. %B (0-1,
// can exceed) locates price within the bands; bandwidth (band width as a %
// of the basis) flags a volatility squeeze when unusually tight — squeezes
// often precede an expansion move, which is useful context a single ATR
// number doesn't convey.
export function bollingerBands(closes, period = 20, mult = 2) {
  if (closes.length < period) return null;
  const window = closes.slice(-period);
  const basis = mean(window);
  const sd = stddev(window, basis);
  const upper = basis + mult * sd;
  const lower = basis - mult * sd;
  const current = closes.at(-1);
  return {
    upper,
    lower,
    basis,
    percentB: upper === lower ? 0.5 : (current - lower) / (upper - lower),
    bandwidthPct: basis !== 0 ? ((upper - lower) / basis) * 100 : null,
  };
}

// Linear regression price channel: least-squares trendline through closes
// over the window, plus parallel upper/lower bands at `stdMult` standard
// deviations of the residuals — a channel in the classic technical-analysis
// sense (two parallel bounding lines whose slope reflects the prevailing
// trend), distinct from Bollinger Bands (which band a flat rolling mean,
// not a sloped trendline) and from findSwingLevels (which maps discrete
// pivot levels, not a continuous band). `lookback` omitted uses the whole
// candle series passed in, so the channel spans whatever window the chart
// itself is showing rather than a fixed bar count that would read
// differently across timeframes. Returns null if there isn't enough
// history yet (fewer than 10 bars).
export function linearRegressionChannel(candles, { lookback, stdMult = 2 } = {}) {
  const window = lookback ? candles.slice(-lookback) : candles;
  const n = window.length;
  if (n < 10) return null;

  const xs = window.map((_, i) => i);
  const ys = window.map((c) => c.close);
  const xMean = mean(xs);
  const yMean = mean(ys);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - xMean) * (ys[i] - yMean);
    den += (xs[i] - xMean) ** 2;
  }
  const slope = den !== 0 ? num / den : 0;
  const intercept = yMean - slope * xMean;

  // OLS residuals have zero mean by construction, so stddev can skip
  // re-deriving it from the residuals themselves.
  const residuals = window.map((c, i) => c.close - (slope * i + intercept));
  const residualStd = stddev(residuals, 0);

  return window.map((c, i) => {
    const mid = slope * i + intercept;
    return { time: c.time, mid, upper: mid + stdMult * residualStd, lower: mid - stdMult * residualStd };
  });
}

// Mean-reversion z-score: how many standard deviations the current close sits
// from its own rolling mean. This is a *contrarian* signal — deliberately
// separate from RSI's momentum reading, not a duplicate of it: a market can
// have strong upward momentum (high RSI) while not yet being statistically
// stretched (low z), or vice versa. Combining both, not conflating them, is
// the point of a multi-factor model.
export function zScore(closes, period = 20) {
  if (closes.length < period) return null;
  const window = closes.slice(-period);
  const m = mean(window);
  const sd = stddev(window, m);
  if (sd === 0) return 0;
  return (closes.at(-1) - m) / sd;
}

// Rolling mean itself (the value z-score measures distance from) — exposed
// separately since a pure mean-reversion trade's natural target is "back to
// the mean," not a structural swing level.
export function rollingMean(closes, period = 20) {
  if (closes.length < period) return null;
  return mean(closes.slice(-period));
}

// Rolling standard deviation itself (the unit z-score is measured in) —
// exposed for anything that needs to show its work (e.g. a trade journal
// recording the exact mean/std a z-score was computed from) rather than
// just the resulting z.
export function rollingStd(closes, period = 20) {
  if (closes.length < period) return null;
  const window = closes.slice(-period);
  return stddev(window, mean(window));
}

// % price change over the last `bars` candles — a timeframe-relative "how
// much did this move over period X" reading (e.g. bars = however many
// candles span 4h at the current timeframe), independent of the ticker's
// fixed 24h change.
export function changeOverBars(closes, bars) {
  if (closes.length < bars + 1) return null;
  const prior = closes.at(-1 - bars);
  if (prior === 0) return null;
  return ((closes.at(-1) - prior) / prior) * 100;
}

// % change in summed volume between the last `bars` candles and the `bars`
// before that — whether trading interest is picking up or drying out,
// independent of the coin's raw (size-driven) volume level.
export function volumeDeltaPct(volumes, bars) {
  if (volumes.length < bars * 2) return null;
  const recent = volumes.slice(-bars).reduce((s, v) => s + v, 0);
  const prior = volumes.slice(-bars * 2, -bars).reduce((s, v) => s + v, 0);
  if (prior === 0) return null;
  return ((recent - prior) / prior) * 100;
}

// Current volume vs its own rolling average — used to confirm (or question)
// whether a price move has real participation behind it.
function relativeVolume(volumes, period = 20) {
  if (volumes.length < period) return null;
  const window = volumes.slice(-period - 1, -1); // average of the period *before* the latest bar
  if (!window.length) return null;
  const avg = mean(window);
  if (avg === 0) return null;
  return volumes.at(-1) / avg;
}

// Exchanges return the still-forming current bar alongside closed history
// (OKX flags it explicitly via `confirm`, but that flag isn't universal
// across data sources — this infers it generically from timing instead).
// Its volume-so-far is only a fraction of a full bar's, so comparing it
// straight against an average of *completed* bars systematically understates
// participation — a coin can show "low conviction" on every single scan just
// because the bar hasn't finished yet. Detected as: newer than one full
// (median) bar interval old.
function isPartialLastCandle(candles) {
  if (candles.length < 3) return false;
  const gaps = [];
  for (let i = 1; i < candles.length; i++) gaps.push(candles[i].time - candles[i - 1].time);
  gaps.sort((a, b) => a - b);
  const barDuration = gaps[Math.floor(gaps.length / 2)];
  return Date.now() - candles.at(-1).time < barDuration;
}

// Average True Range — volatility context, not a directional signal. Shown
// as a stat so the score isn't the only number on screen.
export function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trueRanges = [];
  for (let i = 1; i < candles.length; i++) {
    const { high, low } = candles[i];
    const prevClose = candles[i - 1].close;
    trueRanges.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  return mean(trueRanges.slice(-period));
}

// Finds the most recent significant swing low within `lookback` candles, and
// the swing high that preceded the drop into it — used as the "neckline" /
// breakout level in the narrative (the resistance level a recovery needs to
// reclaim to stay bullish).
function findSwingStructure(candles, lookback = 60) {
  const window = candles.slice(-lookback);
  let swingLowIdx = 0;
  for (let i = 1; i < window.length; i++) {
    if (window[i].low < window[swingLowIdx].low) swingLowIdx = i;
  }
  let priorHighIdx = 0;
  for (let i = 0; i <= swingLowIdx; i++) {
    if (window[i].high > window[priorHighIdx].high) priorHighIdx = i;
  }
  const offsetFromEnd = window.length - 1 - swingLowIdx;
  return {
    swingLow: window[swingLowIdx].low,
    swingLowCandlesAgo: offsetFromEnd,
    neckline: window[priorHighIdx].high,
    neverDropped: priorHighIdx === swingLowIdx,
  };
}

// Mirror of findSwingStructure for short setups: most recent significant
// swing high within `lookback` candles, and the swing low ("floor") that
// preceded the rally into it — the support level a breakdown needs to lose
// to stay bearish.
function findBearishSwingStructure(candles, lookback = 60) {
  const window = candles.slice(-lookback);
  let swingHighIdx = 0;
  for (let i = 1; i < window.length; i++) {
    if (window[i].high > window[swingHighIdx].high) swingHighIdx = i;
  }
  let priorLowIdx = 0;
  for (let i = 0; i <= swingHighIdx; i++) {
    if (window[i].low < window[priorLowIdx].low) priorLowIdx = i;
  }
  return {
    swingHigh: window[swingHighIdx].high,
    floor: window[priorLowIdx].low,
  };
}

// General-purpose support/resistance: every local pivot (a high/low that's
// the most extreme point among `strength` candles on each side) within
// `lookback`, clustered by proximity (within 0.5% of price) since the same
// real-world level is usually touched by several nearby pivots rather than
// exactly once. Distinct from findSwingStructure/findBearishSwingStructure
// above, which each locate the *one* specific level a directional setup's
// stop/target measures from — this instead surfaces the broader map of
// levels for context (chart markers, a level list), ranked by how many
// pivots reinforce each one.
export function findSwingLevels(candles, { lookback = 150, strength = 3, clusterPct = 0.005 } = {}) {
  const window = candles.slice(-lookback);
  const pivots = [];
  for (let i = strength; i < window.length - strength; i++) {
    const slice = window.slice(i - strength, i + strength + 1);
    if (window[i].high === Math.max(...slice.map((c) => c.high))) {
      pivots.push({ price: window[i].high, type: "resistance", candlesAgo: window.length - 1 - i });
    }
    if (window[i].low === Math.min(...slice.map((c) => c.low))) {
      pivots.push({ price: window[i].low, type: "support", candlesAgo: window.length - 1 - i });
    }
  }

  const clusters = [];
  for (const pivot of pivots.sort((a, b) => a.price - b.price)) {
    const last = clusters.at(-1);
    if (last && last.type === pivot.type && Math.abs(pivot.price - last.price) / last.price <= clusterPct) {
      last.touches += 1;
      last.price = (last.price * (last.touches - 1) + pivot.price) / last.touches;
      last.candlesAgo = Math.min(last.candlesAgo, pivot.candlesAgo);
    } else {
      clusters.push({ ...pivot, touches: 1 });
    }
  }

  return clusters.sort((a, b) => b.touches - a.touches || a.candlesAgo - b.candlesAgo);
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// Continuous trend factor (not just a three-way label): EMA20-vs-EMA50
// separation as a % of price, scaled to a -30..+30 contribution, halved if
// EMA50 disagrees with EMA200 (i.e. short and long-term trend conflict).
// Exported (not just an analyzeCandles internal) so standalone backtest
// scripts can reuse its "sideways" read as a regime filter -- e.g.
// scripts/backtest-zscore-tune-regime.js gating mean-reversion entries to
// only fire outside a trending regime -- without hand-copying the EMA
// separation logic and risking it drifting from the live version.
export function trendFactor(closes) {
  const ema20 = ema(closes, 20).at(-1);
  const ema50 = ema(closes, 50).at(-1);
  const ema200 = closes.length >= 200 ? ema(closes, 200).at(-1) : null;

  const separationPct = ((ema20 - ema50) / ema50) * 100;
  let contribution = clamp(separationPct, -3, 3) * 10; // +/-3% separation -> +/-30

  let label = "sideways";
  if (Math.abs(separationPct) > 0.2) label = separationPct > 0 ? "bullish" : "bearish";

  if (ema200 != null) {
    const longTermAgrees = (ema50 > ema200 && separationPct > 0) || (ema50 < ema200 && separationPct < 0);
    if (!longTermAgrees) contribution *= 0.5;
    if (ema20 > ema50 && ema50 > ema200) label = "bullish";
    else if (ema20 < ema50 && ema50 < ema200) label = "bearish";
  }

  return { label, contribution, separationPct, ema20, ema50, ema200 };
}

// RSI confirms momentum up to conventional overbought/oversold thresholds
// (80/20), but past that point further extremes are more often exhaustion
// than fuel for continuation — so the contribution caps there instead of
// scaling linearly all the way to RSI 0/100.
function momentumFactor(rsiValue) {
  if (rsiValue == null) return { contribution: 0 };
  const capped = clamp(rsiValue, 20, 80);
  return { contribution: ((capped - 50) / 30) * 20, rsiValue };
}

function meanReversionFactor(z) {
  if (z == null) return { contribution: 0 };
  // Contrarian: statistically stretched up -> negative (reversion risk down);
  // stretched down -> positive (reversion/bounce potential).
  return { contribution: -clamp(z, -3, 3) * (25 / 3), z };
}

function volumeFactor(relVol, priceUp) {
  if (relVol == null) return { contribution: 0 };
  if (relVol >= 1.2) {
    const magnitude = clamp(relVol, 1, 3) - 1; // 0..2
    return { contribution: (priceUp ? 1 : -1) * magnitude * 10, relVol }; // up to +/-20
  }
  // 0.6 used to trip constantly for a while after any real volume spike —
  // the spike itself stays in the 20-period average and drags it up, so
  // completely normal follow-through volume kept reading as "low conviction"
  // until the spike rolled out of the window. 0.4 only flags genuinely quiet
  // moves, not the ordinary cooldown after a burst.
  if (relVol <= 0.4) return { contribution: 0, relVol, lowConviction: true };
  return { contribution: 0, relVol };
}

// Returns structured narrative data ({ headline, warnings }) rather than a
// single joined string, so the UI can render the headline and each warning
// as their own visually distinct element instead of one wall-of-text
// paragraph. Stats (trend %, RSI, z, rel. volume) and the setup levels are
// deliberately left out here — they're already surfaced as their own UI
// elements (the stats grid and the setup panel), so repeating them in prose
// would just be redundant text.
function buildNarrative({ symbol, trendLabel, factors, neckline, current, swingLowCandlesAgo, recoveredFraction }) {
  const tag = `$${symbol.toUpperCase()}`;
  const holdingNeckline = current >= neckline;
  const isVShape = swingLowCandlesAgo <= 20 && recoveredFraction >= 0.5;

  let headline;
  if (isVShape && holdingNeckline && trendLabel !== "bearish") {
    headline = `V-shaped recovery. ${tag} has reclaimed the neckline and is holding above the breakout level, keeping the short-term trend ${trendLabel === "bullish" ? "bullish" : "constructive"}.`;
  } else if (holdingNeckline && trendLabel === "bullish") {
    headline = `${tag} is holding above its recent breakout level, with the short-term trend still bullish.`;
  } else if (!holdingNeckline && trendLabel !== "bearish") {
    headline = `${tag} is retesting the neckline from below after a bounce, but hasn't reclaimed it yet.`;
  } else if (trendLabel === "bearish") {
    headline = `${tag} remains under its recent breakdown level, with the short-term trend still bearish.`;
  } else {
    headline = `${tag} is consolidating near its recent range with no clear directional edge yet.`;
  }

  const warnings = [];
  if (factors.meanReversion.z != null && factors.meanReversion.z >= 2) warnings.push("Price is statistically stretched above its 20-period mean — reversion/pullback risk is elevated even though the trend itself is intact.");
  else if (factors.meanReversion.z != null && factors.meanReversion.z <= -2) warnings.push("Price is statistically stretched below its 20-period mean — conditions favor a reflex bounce.");

  if (factors.volume.lowConviction) warnings.push("Volume is well below its 20-period average — this move lacks strong participation.");

  return { headline, warnings };
}

// Plain-English reads of each quant factor's *current value*, not just its
// direction — the point of "real analysis" is showing the actual number and
// what that number means, not just which of 3 buckets a coin fell into.

// RSI: momentum oscillator 0-100. Conventional overbought/oversold lines
// (70/30) mark where momentum is stretched enough that continuation gets
// less likely than a cool-off, even mid-trend.
function describeRsi(rsiValue) {
  if (rsiValue == null) return null;
  if (rsiValue >= 70) return `RSI is ${fmt(rsiValue, 1)} — overbought. Momentum has run hot enough that a cool-off or sideways digestion is more likely from here than a clean continuation, even if the trend itself stays intact.`;
  if (rsiValue <= 30) return `RSI is ${fmt(rsiValue, 1)} — oversold. Selling pressure is stretched to a level that often produces at least a relief bounce, independent of whether the broader trend has actually turned.`;
  if (rsiValue >= 55) return `RSI is ${fmt(rsiValue, 1)}, above the neutral 50 line — momentum leans with buyers without being stretched.`;
  if (rsiValue <= 45) return `RSI is ${fmt(rsiValue, 1)}, below the neutral 50 line — momentum leans with sellers without being stretched.`;
  return `RSI is ${fmt(rsiValue, 1)}, essentially at the neutral midpoint — momentum isn't offering a lean either way right now.`;
}

// Z-score: how many standard deviations price sits from its own 20-period
// mean. This is the mean-reversion read — deliberately the *contrarian*
// counterpart to RSI's momentum read, so the two can and often do disagree
// (e.g. strong momentum, not yet statistically stretched).
function describeZScore(z) {
  if (z == null) return null;
  const dir = z > 0 ? "above" : "below";
  const abs = Math.abs(z);
  if (abs >= 2) return `Z-score is ${fmt(z, 2)} — price is running ${fmt(abs, 1)} standard deviations ${dir} its own 20-period mean, a statistically stretched extreme that historically favors reverting back toward that average over the move extending further.`;
  if (abs >= 1) return `Z-score is ${fmt(z, 2)} — price is ${fmt(abs, 1)} standard deviations ${dir} its 20-period mean, a moderate stretch that isn't extreme enough yet to lean on mean-reversion alone.`;
  return `Z-score is ${fmt(z, 2)} — price is sitting close to its own 20-period mean, with no real statistical stretch in either direction.`;
}

// MACD: a second, independent momentum read via EMA12/26 separation — cross
// events (histogram sign flip) often lead a pure price-EMA crossover by a
// few bars, so a fresh cross here is called out distinctly from a
// already-established histogram sign.
function describeMacd(macdData) {
  if (!macdData) return null;
  if (macdData.bullishCross) return `MACD just crossed bullish (histogram flipped from negative to positive) — an independent momentum signal turning up in the same direction as price, not merely a lagging confirmation of it.`;
  if (macdData.bearishCross) return `MACD just crossed bearish (histogram flipped from positive to negative) — an independent momentum signal turning down, worth weighing against the price action on its own terms.`;
  if (macdData.histogram > 0) return `MACD histogram is positive (${fmt(macdData.histogram, 4)}) — momentum has been running with buyers, though this cross isn't fresh.`;
  return `MACD histogram is negative (${fmt(macdData.histogram, 4)}) — momentum has been running with sellers, though this cross isn't fresh.`;
}

// Bollinger Bands: a tight bandwidth (squeeze) flags compressed volatility
// that often precedes an expansion move in either direction; %B outside
// [0,1] flags price trading beyond the bands entirely.
function describeBollinger(bb) {
  if (!bb) return null;
  if (bb.percentB >= 1) return `Price is trading at or above its upper Bollinger Band (%B ${fmt(bb.percentB, 2)}) — a volatility extreme, not automatically a reversal signal, but a stretched one.`;
  if (bb.percentB <= 0) return `Price is trading at or below its lower Bollinger Band (%B ${fmt(bb.percentB, 2)}) — a volatility extreme on the downside.`;
  if (bb.bandwidthPct != null && bb.bandwidthPct < 4) return `Bollinger bandwidth has compressed to ${fmt(bb.bandwidthPct, 1)}% of price — a volatility squeeze, which historically precedes an expansion move without indicating which direction it breaks.`;
  return null;
}

// Compact quant-explainer read on the current structure — distinct from
// buildNarrative's headline/warnings pair. One short paragraph on the
// structural event (what broke, whether volume confirmed it, what would
// invalidate it) plus each independent factor's actual value, so two coins
// in the same structural bucket don't read identically when their
// underlying numbers differ. Built entirely from already-computed
// structure/momentum/volatility inputs, not a separate signal.
function buildEvaluation({ symbol, trendLabel, current, neckline, floor, holdingNeckline, relVol, rsiValue, z, macdData, bollingerData }) {
  const tag = `$${symbol.toUpperCase()}`;
  const strongVolume = relVol != null && relVol >= 1.2;
  const brokeUp = holdingNeckline && trendLabel !== "bearish";
  const brokeDown = current < floor && trendLabel === "bearish";

  const quantReads = [describeRsi(rsiValue), describeZScore(z), describeMacd(macdData), describeBollinger(bollingerData)].filter(Boolean);
  const quantParagraph = quantReads.length ? quantReads.join(" ") : null;

  let body;
  if (brokeUp) {
    body = `${tag} broke above the level that had capped sellers, near ${fmt(neckline)}, ${strongVolume ? "on strong volume" : "on light volume so far"}. Losing that level again would undo the breakout.`;
  } else if (brokeDown) {
    body = `${tag} broke below the level that had held buyers, near ${fmt(floor)}, ${strongVolume ? "on strong volume" : "on light volume so far"}. Reclaiming that level would undo the breakdown.`;
  } else {
    body = `${tag} is still range-bound, between resistance near ${fmt(neckline)} and support near ${fmt(floor)} — no decisive break yet.`;
  }

  return { body, quant: quantParagraph };
}

// Turns swing structure + ATR into an actual trade: entry (current price), a
// *tight* volatility-scaled stop (1.5x ATR), and a *far* measured-move target
// projected off the breakout/breakdown level's base height. Deliberately
// asymmetric — anchoring the stop at the far side of the whole base (like the
// target) would make risk and reward roughly the same size by construction,
// capping R:R near 1:1 no matter how good the setup. A tight ATR stop near
// entry is what lets a large base / small pullback actually clear a 3:1 bar;
// it also naturally rejects late/extended entries (reward <= 0) without
// needing a separate "don't chase" rule. Returns null when ATR isn't
// available yet or the structure is degenerate (stop/target on the wrong
// side of entry).
// estimatedBars: a rough "how long might this take" heuristic — distance to
// target divided by ATR (the average per-bar range) gives approximately how
// many bars of typical movement it'd take to cover that distance if similar
// volatility continues. Multiply by the scanned timeframe's bar duration for
// a wall-clock ETA. This is not a prediction of *when* — price rarely moves
// in a straight line — just a scale check: a target that's 2 bars away reads
// very differently than one that's 40 bars away, even at the same R:R.
// Returns either a full setup, or `{ skipped: true, reason }` explaining why
// there isn't one — silently returning null when e.g. price has already run
// past the structural target reads as "broken" in the UI rather than as the
// deliberate "don't chase an extended move" call that it actually is.
export function buildSetup({ direction, current, atr, swingLow, neckline, swingHigh, floor }) {
  if (atr == null) return { skipped: true, reason: "not-enough-history" };
  const stopDistance = atr * 1.5;

  if (direction === "long") {
    const stop = current - stopDistance;
    const risk = current - stop;
    if (risk <= 0) return { skipped: true, reason: "degenerate-structure" };
    const target = neckline + (neckline - swingLow);
    const reward = target - current;
    if (reward <= 0) return { skipped: true, reason: "already-extended" };
    return { direction, entry: current, stop, target, risk, reward, rr: reward / risk, estimatedBars: reward / atr };
  }

  if (direction === "short") {
    const stop = current + stopDistance;
    const risk = stop - current;
    if (risk <= 0) return { skipped: true, reason: "degenerate-structure" };
    const target = floor - (swingHigh - floor);
    const reward = current - target;
    if (reward <= 0) return { skipped: true, reason: "already-extended" };
    return { direction, entry: current, stop, target, risk, reward, rr: reward / risk, estimatedBars: reward / atr };
  }

  return null;
}

// Multi-factor quant analysis for one symbol/timeframe — a weighted composite
// of trend (EMA separation), momentum (RSI), mean-reversion (z-score vs the
// 20-period mean), and relative volume, each scored independently and shown
// in `factors` rather than folded into a single opaque number. This mirrors
// standard quant-scanner design (trend-following + contrarian mean-reversion
// as separate, non-redundant signals) rather than a single heuristic path.
export function analyzeCandles(candles, symbol) {
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const current = closes.at(-1);
  const priceUp = current >= closes.at(-2);

  const trend = trendFactor(closes);
  const rsiValue = rsi(closes).at(-1);
  const momentum = momentumFactor(rsiValue);
  const z = zScore(closes);
  const meanReversion = meanReversionFactor(z);
  const volumesForRelVol = isPartialLastCandle(candles) ? volumes.slice(0, -1) : volumes;
  const relVol = relativeVolume(volumesForRelVol);
  const volume = volumeFactor(relVol, priceUp);
  const volatility = atr(candles);
  const macdData = macd(closes);
  const bollingerData = bollingerBands(closes);

  const { neckline, swingLow, swingLowCandlesAgo } = findSwingStructure(candles);
  const { swingHigh, floor } = findBearishSwingStructure(candles);
  const holdingNeckline = current >= neckline;
  const drop = Math.max(neckline - swingLow, 1e-9);
  const recoveredFraction = Math.max(0, (current - swingLow) / drop);

  // Broader support/resistance map (distinct from the single neckline/floor
  // levels above) — the closest handful of clustered pivots each side of
  // price, for the level list + chart markers.
  const levels = findSwingLevels(candles)
    .filter((l) => l.touches >= 2)
    .slice(0, 6)
    .sort((a, b) => Math.abs(a.price - current) - Math.abs(b.price - current));

  // Backtesting this exact setup (entry/stop/target formula below) on 4H
  // across 25 liquid pairs over ~250 days showed negative expectancy overall
  // — see backtests/all-setups-4h-2026-07-08.json. The 0-100 composite score
  // and any "meets bar"/favorable framing were what made that setup look
  // actionable; neither is exposed here anymore. entry/stop/target/rr are
  // kept purely as neutral structural reference numbers (e.g. for sizing a
  // position on a trade the user decides to take on their own judgment), not
  // as a signal that the setup is expected to work.
  const factors = { trend, momentum, meanReversion, volume };

  const setupDirection = trend.label === "bullish" ? "long" : trend.label === "bearish" ? "short" : null;
  const setup = setupDirection
    ? buildSetup({ direction: setupDirection, current, atr: volatility, swingLow, neckline, swingHigh, floor })
    : null; // either null (sideways trend) or { skipped: true, reason }

  return {
    symbol,
    trend: trend.label,
    current,
    neckline,
    swingLow,
    swingLowCandlesAgo,
    swingHigh,
    floor,
    holdingNeckline,
    rsiValue,
    zScore: z,
    // The same 20-period rolling mean z-score measures distance from — the
    // "fair value" anchor a mean-reversion read implies price should sit
    // near, shown as its own price level rather than only as the
    // standardized distance the z-score column already reports.
    fairValue: rollingMean(closes),
    relativeVolume: relVol,
    atr: volatility,
    atrPct: volatility != null ? (volatility / current) * 100 : null,
    factors,
    setup,
    narrative: buildNarrative({ symbol, trendLabel: trend.label, factors, neckline, current, swingLowCandlesAgo, recoveredFraction }),
    evaluation: buildEvaluation({ symbol, trendLabel: trend.label, current, neckline, floor, holdingNeckline, relVol, rsiValue, z, macdData, bollingerData }),
    ema20: ema(closes, 20),
    ema50: ema(closes, 50),
    ema200: closes.length >= 200 ? ema(closes, 200) : null,
    macd: macdData,
    bollinger: bollingerData,
    levels,
  };
}
