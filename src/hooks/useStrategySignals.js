import { useState } from "react";
import { getCachedCandles } from "../lib/candleCache.js";
import { runStrategySignal, notEnoughHistoryError } from "../lib/strategyEngine.js";
import { normalizeSignal } from "../lib/strategySignal.js";
import { atr } from "../lib/analysis/ta.js";
import { useSignalPolling } from "./useSignalPolling.js";

// Same 1.5x/2.5x ATR stop/target convention as the Trend dip-buy preset
// (TREND_DIP_ATR_EXIT_CODE in StrategiesPanel.jsx) and the zscore backtest
// scripts -- the repo's one established "generic ATR stop" shape, reused
// here rather than invented fresh.
const FALLBACK_STOP_ATR_MULT = 1.5;
const FALLBACK_TARGET_ATR_MULT = 2.5;

// A long/short signal with no stop/target of its own (e.g. a bare `return
// "long"` rule, as opposed to the Trend dip-buy/MTF Swing presets which
// compute their own) still deserves a risk level in its notification --
// "you got a signal, good luck" isn't actionable. Falls back to a generic
// ATR band off the signal bar's close when the strategy didn't supply one;
// leaves it untouched (including "close"/no-signal, and the null case where
// ATR can't be computed) so this never overrides levels a strategy actually
// reasoned about.
function withFallbackLevels(rawSignal, bar, candles) {
  const normalized = normalizeSignal(rawSignal);
  const { direction, stop, target, meta } = normalized;
  if ((direction !== "long" && direction !== "short") || (stop != null && target != null)) return rawSignal;
  const atrVal = atr(candles);
  if (atrVal == null) return rawSignal;
  const fallbackStop = direction === "long" ? bar.close - FALLBACK_STOP_ATR_MULT * atrVal : bar.close + FALLBACK_STOP_ATR_MULT * atrVal;
  const fallbackTarget = direction === "long" ? bar.close + FALLBACK_TARGET_ATR_MULT * atrVal : bar.close - FALLBACK_TARGET_ATR_MULT * atrVal;
  return { signal: direction, stop: stop ?? fallbackStop, target: target ?? fallbackTarget, meta };
}

// Runs each strategy's own code against the latest closed bar. Shared by the
// manual "Check current signal" button and the background poller so both go
// through the exact same read (same position input, same signals-state
// update). Owned by App.jsx (not StrategiesPanel) so useSignalPolling's
// interval -- and thus notifications -- keeps running while any other tab is
// open, not just while the Strategies tab itself is mounted.
export function useStrategySignals(strategiesList) {
  const [signals, setSignals] = useState({});
  const [positionInputs, setPositionInputs] = useState({});

  const runSignalCheck = async (strategy) => {
    const input = positionInputs[strategy.id] ?? { direction: "flat", entryPrice: "" };
    const position =
      input.direction === "flat"
        ? null
        : { direction: input.direction, entryPrice: input.entryPrice === "" ? null : parseFloat(input.entryPrice), entryIndex: null };

    setSignals((s) => ({ ...s, [strategy.id]: { status: "running" } }));
    try {
      // Only needs enough trailing history for the strategy's own indicators
      // to warm up -- reuses the strategy's saved historyBars so the live
      // read sees the same amount of context the backtest did, and shares
      // the same cache entry as "Run backtest" for this strategy.
      const candles = await getCachedCandles(strategy.symbol, strategy.timeframe, strategy.historyBars);
      if (candles.length < strategy.warmupBars + 1) {
        throw notEnoughHistoryError(strategy.symbol, strategy.warmupBars, candles.length);
      }
      const { signal: rawSignal, bar } = await runStrategySignal({ candles, code: strategy.code, position });
      const signal = withFallbackLevels(rawSignal, bar, candles);
      setSignals((s) => ({ ...s, [strategy.id]: { status: "done", signal, bar } }));
      return { signal, bar };
    } catch (err) {
      setSignals((s) => ({ ...s, [strategy.id]: { status: "error", message: err.message } }));
    }
  };

  useSignalPolling(strategiesList, runSignalCheck);

  const setPositionInput = (id, next) => setPositionInputs((p) => ({ ...p, [id]: next }));
  const clearStrategy = (id) => {
    setSignals((s) => {
      const { [id]: _, ...rest } = s;
      return rest;
    });
    setPositionInputs((p) => {
      const { [id]: _, ...rest } = p;
      return rest;
    });
  };

  return { signals, positionInputs, setPositionInput, runSignalCheck, clearStrategy };
}
