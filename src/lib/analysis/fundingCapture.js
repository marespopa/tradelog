// Funding-rate capture: long spot + short perp collects the funding
// premium longs pay shorts every settlement (8h on OKX's USDT-margined
// perps), market-neutral by construction — the spot leg's price P&L offsets
// the perp leg's (basis risk aside; the two prices track closely for liquid
// pairs but aren't identical, and that drift isn't modeled here). Unlike
// the alpha basket (betaNeutral.js), this doesn't rank or predict which
// coin will outperform — the edge is a market-structure effect (perp
// markets have a persistent bias toward more leveraged longs than shorts,
// so longs typically pay a premium to hold that leverage), not a forecast.
// See scripts/backtest-funding-capture.js for the walk-forward validation
// before trusting it with real sizing.

// Average per-period funding rate over a rate series (as returned by
// okx.js's fetchFundingRateHistory: [{ time, rate }], oldest-first).
// Positive means longs paid shorts on average over the window — the
// direction this strategy is built to collect (short perp/long spot).
export function averageFundingRate(rateHistory) {
  if (!rateHistory.length) return null;
  return rateHistory.reduce((s, r) => s + r.rate, 0) / rateHistory.length;
}

// rows: [{ symbol, avgRate }] for every candidate. Ranks by trailing average
// funding rate and keeps the top `count`, equal-weighted — unlike
// betaNeutral.js's inverse-beta leg weighting, this strategy carries no
// directional market exposure to balance in the first place (each position
// is independently spot/perp-hedged), so there's nothing for a beta-style
// weighting to solve; equal weight is just diversification across
// independent funding streams to reduce any one pair's basis/idiosyncratic
// risk. minAvgRate excludes anything not worth collecting (near-zero or
// negative average carry) even if it would otherwise rank in the top
// `count`.
export function buildFundingBasket(rows, { count = 10, minAvgRate = 0 } = {}) {
  const usable = rows.filter((r) => Number.isFinite(r.avgRate) && r.avgRate > minAvgRate);
  const picked = [...usable].sort((a, b) => b.avgRate - a.avgRate).slice(0, count);
  const weight = picked.length ? 1 / picked.length : 0;
  return picked.map((r) => ({ ...r, weight }));
}
