// Runs a user-written strategy function bar-by-bar against historical
// candles, off the main thread — a bad strategy (infinite loop, heavy
// computation) can only hang this worker, which the caller can terminate(),
// not the UI itself. The user's code never gets a handle to anything but
// `ctx` below; it has no access to the app's own state, storage, or DOM.
import * as ta from "../lib/analysis/ta.js";
import { normalizeSignal } from "../lib/strategySignal.js";
import { buildDailyCandles, buildWeeklyCandles } from "../lib/analysis/timeframes.js";
import { findMtfSignal, buildTrade as buildMtfTrade } from "../lib/analysis/mtfSetup.js";

// Re-exposes the exact Weekly/Daily/4H swing setup already validated in
// backtest-mtf-swing.js (+0.19R/trade, 309 trades across 15 liquid pairs)
// and running live in the Market/Watchlist scan (mtfSetup.js's attachEntry)
// — so a strategy can run that same rule standalone against one symbol
// without hand-copying its resampling/bias/trigger logic into a preset,
// which would risk silently drifting from the validated version.
// buildDailyCandles/buildWeeklyCandles already drop a trailing incomplete
// bucket (see timeframes.js), so calling them fresh on ctx.bars each bar is
// equivalent to backtest-mtf-swing.js's "closed as of now" pointer-advancing
// -- just recomputed from the prefix instead of incrementally, which is
// fine at the data sizes a Strategies-tab backtest runs at.
const mtf = { buildDailyCandles, buildWeeklyCandles, findMtfSignal, buildTrade: buildMtfTrade };

// Same accounting as the flip-based node backtest scripts: closing a
// position (to flatten, or to flip the other way) pays one round-trip fee,
// deducted from the raw price-move return. `fillPrice` is the *next* bar's
// open (see the loop below for why), not the bar passed in here — that bar
// only supplies exitTime/exitIndex.
function closeTrade(position, fillPrice, exitBar, exitIndex, feeRoundtripPct) {
  const rawPct = ((fillPrice - position.entryClose) / position.entryClose) * (position.direction === "long" ? 1 : -1) * 100;
  const netPct = rawPct - feeRoundtripPct;
  return {
    direction: position.direction,
    entryTime: position.entryTime,
    exitTime: exitBar.time,
    entryClose: position.entryClose,
    exitClose: fillPrice,
    barsHeld: exitIndex - position.entryIndex,
    rawPct,
    netPct,
    outcome: netPct > 0 ? "win" : netPct < 0 ? "loss" : "breakeven",
  };
}

self.onmessage = (e) => {
  const { mode = "backtest", candles, code, warmupBars, feeRoundtripPct, position: livePosition, fearGreed } = e.data;

  let userFn;
  try {
    // `code` is a function *body* ("return ...;"), not a full function
    // declaration — matches how the UI documents the contract.
    userFn = new Function("ctx", code);
  } catch (err) {
    self.postMessage({ type: "error", message: `Couldn't parse strategy code: ${err.message}` });
    return;
  }

  // "signal" mode: one evaluation against the latest closed bar, using
  // whatever position the caller says they're actually holding (there's no
  // backtest-tracked position to fall back on for a live check) — reports
  // exactly what the strategy returns right now, nothing more.
  if (mode === "signal") {
    const bar = candles.at(-1);
    try {
      const signal = userFn({ bars: candles, position: livePosition ?? null, ta, mtf, fearGreed: fearGreed ?? null });
      self.postMessage({ type: "signal", signal, bar });
    } catch (err) {
      self.postMessage({ type: "error", message: `Strategy threw: ${err.message}` });
    }
    return;
  }

  const trades = [];
  let position = null;
  // A signal computed from bar i (including its close) can't fill at bar i's
  // own close — that assumes zero-latency execution at the exact instant the
  // bar that produced the signal finished, which no real order gets. It
  // queues here instead and fills at the *next* bar's open, one bar of lag
  // that models "the earliest you could actually act on this." A signal on
  // the very last bar has no following bar to fill on and is simply dropped,
  // same as leaving a final position open with no realized outcome.
  let pendingAction = null;
  // Carries a "long"/"short" signal's own `meta` (see strategySignal.js)
  // across that same one-bar lag, so it lands on the position that actually
  // opens next bar rather than being lost when the triggering bar's raw
  // signal goes out of scope.
  let pendingMeta = null;

  for (let i = warmupBars; i < candles.length; i++) {
    const bar = candles[i];

    if (pendingAction) {
      if (pendingAction === "close") {
        if (position) {
          trades.push(closeTrade(position, bar.open, bar, i, feeRoundtripPct));
          position = null;
        }
      } else {
        if (position && position.direction !== pendingAction) {
          trades.push(closeTrade(position, bar.open, bar, i, feeRoundtripPct));
          position = null;
        }
        if (!position) {
          position = { direction: pendingAction, entryIndex: i, entryTime: bar.time, entryClose: bar.open, meta: pendingMeta };
        }
      }
      pendingAction = null;
      pendingMeta = null;
    }

    let raw;
    try {
      raw = userFn({
        bars: candles.slice(0, i + 1),
        position: position ? { direction: position.direction, entryIndex: position.entryIndex, entryPrice: position.entryClose, meta: position.meta ?? null } : null,
        ta,
        mtf,
        fearGreed: fearGreed ? fearGreed.slice(0, i + 1) : null,
      });
    } catch (err) {
      self.postMessage({ type: "error", message: `Strategy threw at bar ${i} (${new Date(bar.time).toISOString()}): ${err.message}` });
      return;
    }

    // A suggested { stop, target } (see strategySignal.js) is informational
    // only here -- the backtest's own exit fires off the strategy's own
    // per-bar re-evaluation (the `if (pos)` branch next call), not off a
    // static level tagged onto the entry. `meta`, by contrast, IS carried
    // through to the position the engine tracks (see pendingMeta above) --
    // that's its whole purpose, letting the strategy read back its own
    // entry-time state instead of recomputing it live every bar.
    const { direction, meta } = normalizeSignal(raw);
    if (direction === "close" || direction === "long" || direction === "short") {
      pendingAction = direction;
      pendingMeta = meta;
    }
    // any other direction (null/undefined/anything else): hold, no action
  }

  self.postMessage({ type: "done", trades });
};
