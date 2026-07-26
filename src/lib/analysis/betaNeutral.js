// Beta-neutral long/short basket: rank coins by their return in excess of
// what BTC's move alone would explain (a simple one-factor market-model
// "alpha"), long the strongest, short the weakest, optionally veto a leg
// candidate whose Weekly+Daily trend regime actively disagrees (see
// buildBetaNeutralBasket's regimeBySymbol param) or who's too extended in
// the position's own direction to be a safe entry (extensionBySymbol param)
// — "balanced" in the sense of not fighting the trend and not chasing an
// already-stretched move, not literally market-neutral (that's netBeta's
// job) — then size the short leg's total notional (not just its per-name
// weights) so the aggregate long-side beta and short-side beta cancel
// exactly, by construction. The basket's P&L is meant to come from
// convergence in relative strength, not from BTC/the broader market going
// up or down. This is a construction method, not a proven edge — see
// scripts/backtest-beta-neutral.js for the walk-forward validation before
// trusting it with real sizing.
import { rsi, linearRegressionChannel } from "./ta.js";

function logReturns(closes) {
  const out = [];
  for (let i = 1; i < closes.length; i++) out.push(Math.log(closes[i] / closes[i - 1]));
  return out;
}

function mean(xs) {
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

// Beta of coin vs market over the given close-price window (same length,
// same bar alignment), plus alpha: the coin's actual cumulative log return
// minus what its beta to the market would predict from the market's own
// cumulative log return. Positive alpha = outperformed what its market
// sensitivity alone would predict; negative = underperformed.
export function computeBetaAlpha(coinCloses, marketCloses) {
  const coinReturns = logReturns(coinCloses);
  const marketReturns = logReturns(marketCloses);
  const n = Math.min(coinReturns.length, marketReturns.length);
  if (n < 10) return null;
  const cr = coinReturns.slice(-n);
  const mr = marketReturns.slice(-n);
  const mrMean = mean(mr);
  const crMean = mean(cr);
  let cov = 0;
  let varMkt = 0;
  for (let i = 0; i < n; i++) {
    cov += (cr[i] - crMean) * (mr[i] - mrMean);
    varMkt += (mr[i] - mrMean) * (mr[i] - mrMean);
  }
  if (varMkt <= 0) return null;
  const beta = cov / varMkt;
  const coinCumReturn = Math.log(coinCloses.at(-1) / coinCloses[coinCloses.length - 1 - n]);
  const marketCumReturn = Math.log(marketCloses.at(-1) / marketCloses[marketCloses.length - 1 - n]);
  const alpha = coinCumReturn - beta * marketCumReturn;
  return { beta, alpha };
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// Whether a symbol is too extended, in either direction, to safely add to
// a leg right now — "don't buy tops, don't sell bottoms": overbought
// (RSI>=70) or sitting in the top of its own regression channel means a
// LONG entry here would be chasing an already-stretched move; oversold
// (RSI<=30) or sitting at the bottom of its channel is the mirror for a
// SHORT entry (shorting something that's already crashed risks a snap-back
// bounce). Uses the same rsi()/linearRegressionChannel() primitives the
// Scan panel and Analysis chart already use, not a new indicator. Direction-
// independent stats (rsi, channelPct) ride along so callers can display
// them, not just gate on them. Returns nulls/false when there isn't enough
// history yet rather than throwing.
export function computeExtension(candles, { rsiOverbought = 70, rsiOversold = 30, channelTopPct = 0.85, channelBottomPct = 0.15 } = {}) {
  const closes = candles.map((c) => c.close);
  const rsiValue = rsi(closes).at(-1) ?? null;
  const channel = linearRegressionChannel(candles);
  const last = channel?.at(-1);
  const channelPct = last && last.upper !== last.lower ? (closes.at(-1) - last.lower) / (last.upper - last.lower) : null;

  const longExtended = (rsiValue != null && rsiValue >= rsiOverbought) || (channelPct != null && channelPct >= channelTopPct);
  const shortExtended = (rsiValue != null && rsiValue <= rsiOversold) || (channelPct != null && channelPct <= channelBottomPct);

  return { longExtended, shortExtended, rsi: rsiValue, channelPct };
}

// rows: [{ symbol, beta, alpha, price? }] for every candidate (market symbol
// itself excluded by the caller). Longs are the highest-alpha names, shorts
// the lowest; each leg is weighted 1/|beta| (clamped so a near-zero beta
// doesn't blow up the weight), normalized to sum to 1 within the leg — so
// naming this "beta-neutral" is a claim the resulting netBeta number backs
// up or doesn't, not an assumption baked into the formula.
//
// regimeBySymbol (optional): { [symbol]: "bullish"|"bearish"|null }, the
// Weekly+Daily trend agreement from mtfSetup.js's mtfRegime(). A coin whose
// regime actively disagrees with a leg's direction is excluded from that
// leg's candidate pool entirely — alpha still decides ranking/selection
// *within* the eligible pool, this only vetoes fighting an established
// trend. Coins with no regime read (not enough history, or the two
// timeframes disagree) stay eligible for both legs, same as if the
// parameter were omitted.
//
// extensionBySymbol (optional): { [symbol]: { longExtended, shortExtended } },
// from computeExtension() above. Excludes a candidate from a leg when it's
// too extended in *that leg's own direction* (overbought/near channel top
// for longs, oversold/near channel bottom for shorts) — the "balanced,
// don't chase" filter, independent of and additive to the regime veto.
//
// minAlpha (optional, default 0): a quality floor, not just a rank cutoff.
// Without it, a leg always fills exactly longCount/shortCount slots with
// whoever ranks highest among the eligible pool — even a barely-positive
// alpha gets forced in just to hit the count on a thin week, diluting
// conviction with weak picks. With minAlpha set, longs need alpha >=
// minAlpha and shorts need alpha <= -minAlpha to be eligible at all, so a
// leg can come back with fewer than longCount/shortCount names (or none)
// rather than padding it out with mediocre candidates.
//
// shortableBySymbol (optional): { [symbol]: boolean }, from okx.js's
// fetchPerpetualSwapSymbols(). Shorting only happens via /trade-futures on
// OKX — a symbol with no perpetual swap listing can rank however high it
// wants on alpha, it still can't actually be shorted, so it's excluded from
// the short leg specifically (long is unaffected — going long is a plain
// spot buy, no futures access needed). Symbols not present in the map
// default to shortable (true), so omitting this parameter behaves exactly
// as before.
export function buildBetaNeutralBasket(rows, { longCount = 5, shortCount = 5, minAbsBeta = 0.25, minAlpha = 0, regimeBySymbol, extensionBySymbol, shortableBySymbol } = {}) {
  const usable = rows.filter((r) => Number.isFinite(r.beta) && Number.isFinite(r.alpha));
  const regimeOf = (symbol) => regimeBySymbol?.[symbol] ?? null;
  const extensionOf = (symbol) => extensionBySymbol?.[symbol] ?? {};
  const isShortable = (symbol) => shortableBySymbol?.[symbol] ?? true;
  const longEligible = usable.filter(
    (r) => r.alpha >= minAlpha && regimeOf(r.symbol) !== "bearish" && !extensionOf(r.symbol).longExtended
  );
  const shortEligible = usable.filter(
    (r) => r.alpha <= -minAlpha && regimeOf(r.symbol) !== "bullish" && !extensionOf(r.symbol).shortExtended && isShortable(r.symbol)
  );

  const longs = [...longEligible].sort((a, b) => b.alpha - a.alpha).slice(0, longCount);
  const shorts = [...shortEligible].sort((a, b) => a.alpha - b.alpha).slice(0, shortCount);

  const weightLeg = (leg) => {
    const rawWeights = leg.map((r) => 1 / Math.max(minAbsBeta, Math.abs(r.beta)));
    const total = rawWeights.reduce((s, w) => s + w, 0);
    return leg.map((r, i) => ({ ...r, weight: total > 0 ? rawWeights[i] / total : 0 }));
  };

  const weightedLongs = weightLeg(longs);
  const weightedShorts = weightLeg(shorts);

  const longBeta = weightedLongs.reduce((s, r) => s + r.weight * r.beta, 0);
  const shortBetaAtParWeight = weightedShorts.reduce((s, r) => s + r.weight * r.beta, 0);

  // Per-name inverse-beta weighting only balances exposure *within* each
  // leg — it doesn't make the short leg's aggregate beta match the long
  // leg's, so a $1-long/$1-short book still carries real net market
  // exposure whenever low-alpha names (shorted) skew higher- or lower-beta
  // than high-alpha names (longed), which is common in crypto alts. Scaling
  // the short leg's total notional to longBeta/shortBetaAtParWeight (long
  // leg held at 1x) solves for the short size that actually zeroes out net
  // beta by construction. This means the book is no longer dollar-neutral
  // (long and short notional can differ) — that's the correct trade-off for
  // a basket whose stated goal is neutral market *exposure*, not neutral
  // capital. Clamped to [0, 3]x: 0 when the short leg's beta is too close
  // to zero to size off of (degenerate, so the hedge is skipped rather than
  // producing a wild weight), 3x as a sanity ceiling against unrealistic
  // leverage when shortBetaAtParWeight happens to be small.
  const shortScale = Math.abs(shortBetaAtParWeight) > 1e-6 ? clamp(longBeta / shortBetaAtParWeight, 0, 3) : 0;
  const scaledShorts = weightedShorts.map((r) => ({ ...r, weight: r.weight * shortScale }));
  const shortBeta = scaledShorts.reduce((s, r) => s + r.weight * r.beta, 0);
  const shortNotional = scaledShorts.reduce((s, r) => s + r.weight, 0);

  return { longs: weightedLongs, shorts: scaledShorts, longNotional: 1, shortNotional, netBeta: longBeta - shortBeta };
}
