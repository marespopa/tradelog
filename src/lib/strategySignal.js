// A strategy's return value is either a plain string ("long"/"short"/"close",
// or nothing/null to hold -- the original contract, still fully supported)
// or an object { signal, stop, target, meta } when the rule wants to suggest
// SL/TP levels alongside the entry signal. Normalizing here means every
// caller (the backtest loop, the live signal check, the notifier) branches
// on one shape instead of each re-deriving "is this a string or an object".
//
// `meta` is a free-form object a strategy can attach on the bar it opens a
// position -- the engine persists it onto that position and hands it back
// as ctx.position.meta on every later bar, until the position closes. It's
// the only way a strategy can remember anything about its own entry beyond
// direction/entryIndex/entryPrice (which the engine already tracks itself),
// since the function body re-runs from scratch each bar with no closure
// state of its own. Typical use: pin a stop/target to the volatility at
// entry (`meta: { entryAtr: atr }`) instead of recomputing atr live each
// bar, which silently lets the stop/target drift with current volatility.
export function normalizeSignal(raw) {
  if (raw && typeof raw === "object") {
    return { direction: raw.signal ?? null, stop: raw.stop ?? null, target: raw.target ?? null, meta: raw.meta ?? null };
  }
  return { direction: raw ?? null, stop: null, target: null, meta: null };
}
