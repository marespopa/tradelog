// Beta-neutral long/short basket: rank coins by their return in excess of
// what BTC's move alone would explain (a simple one-factor market-model
// "alpha"), long the strongest, short the weakest, and size each leg
// inversely to beta so the aggregate long-side beta and short-side beta
// roughly cancel — the basket's P&L is meant to come from convergence in
// relative strength, not from BTC/the broader market going up or down.
// This is a construction method, not a proven edge — see
// scripts/backtest-beta-neutral.js for the walk-forward validation before
// trusting it with real sizing.

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

// rows: [{ symbol, beta, alpha, price? }] for every candidate (market symbol
// itself excluded by the caller). Longs are the highest-alpha names, shorts
// the lowest; each leg is weighted 1/|beta| (clamped so a near-zero beta
// doesn't blow up the weight), normalized to sum to 1 within the leg — so
// naming this "beta-neutral" is a claim the resulting netBeta number backs
// up or doesn't, not an assumption baked into the formula.
export function buildBetaNeutralBasket(rows, { longCount = 5, shortCount = 5, minAbsBeta = 0.25 } = {}) {
  const usable = rows.filter((r) => Number.isFinite(r.beta) && Number.isFinite(r.alpha));
  const sorted = [...usable].sort((a, b) => b.alpha - a.alpha);
  const longs = sorted.slice(0, longCount);
  const shorts = sorted.slice(-shortCount).reverse();

  const weightLeg = (leg) => {
    const rawWeights = leg.map((r) => 1 / Math.max(minAbsBeta, Math.abs(r.beta)));
    const total = rawWeights.reduce((s, w) => s + w, 0);
    return leg.map((r, i) => ({ ...r, weight: total > 0 ? rawWeights[i] / total : 0 }));
  };

  const weightedLongs = weightLeg(longs);
  const weightedShorts = weightLeg(shorts);

  const longBeta = weightedLongs.reduce((s, r) => s + r.weight * r.beta, 0);
  const shortBeta = weightedShorts.reduce((s, r) => s + r.weight * r.beta, 0);

  return { longs: weightedLongs, shorts: weightedShorts, netBeta: longBeta - shortBeta };
}
