// Beta-neutral long/short basket: rank coins by their return in excess of
// what BTC's move alone would explain (a simple one-factor market-model
// "alpha"), long the strongest, short the weakest, optionally veto a leg
// candidate whose Weekly+Daily trend regime actively disagrees (see
// buildBetaNeutralBasket's regimeBySymbol param), then size the short leg's
// total notional (not just its per-name weights) so the aggregate long-side
// beta and short-side beta cancel exactly, by construction — the basket's
// P&L is meant to come from convergence in relative strength, not from
// BTC/the broader market going up or down. This is a construction method,
// not a proven edge — see scripts/backtest-beta-neutral.js for the
// walk-forward validation before trusting it with real sizing.

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
export function buildBetaNeutralBasket(rows, { longCount = 5, shortCount = 5, minAbsBeta = 0.25, regimeBySymbol } = {}) {
  const usable = rows.filter((r) => Number.isFinite(r.beta) && Number.isFinite(r.alpha));
  const regimeOf = (symbol) => regimeBySymbol?.[symbol] ?? null;
  const longEligible = usable.filter((r) => regimeOf(r.symbol) !== "bearish");
  const shortEligible = usable.filter((r) => regimeOf(r.symbol) !== "bullish");

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
