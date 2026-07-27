// Position size implied by "risk a fixed % of account on the distance to
// the stop" — the standard fixed-fractional sizing formula. Purely a
// suggestion computed from numbers the user supplies; nulls out rather than
// guessing when any input is missing or the stop equals entry (no defined
// risk to size against).
export function computeSuggestedSize({ accountSize, riskPercent, entryPrice, stopLoss, leverage }) {
  if (!accountSize || !riskPercent || entryPrice == null || stopLoss == null) return null;
  const stopDistancePct = Math.abs(entryPrice - stopLoss) / entryPrice;
  if (!stopDistancePct) return null;

  const riskAmount = accountSize * (riskPercent / 100);
  const notional = riskAmount / stopDistancePct;
  return {
    riskAmount,
    notional,
    qty: notional / entryPrice,
    margin: notional / (leverage || 1),
    stopDistancePct,
  };
}
