import { getCachedFearGreedHistory } from "./fearGreedCache.js";
import { alignFearGreedToBars } from "./analysis/fearGreed.js";

// OKX spot, regular tier: 0.10% taker per side — closing a position (flat
// or flip) pays this round-trip, same assumption scan-channel-setups.js and
// the flip-based backtest scripts use.
export const ROUNDTRIP_FEE_PCT = 0.2;

const TIMEOUT_MS = 15000;

// Best-effort: ctx.fearGreed is an optional extra signal, not load-bearing
// infrastructure like candles — if the index can't be fetched (offline, API
// hiccup) the strategy still runs, just with every reading null instead of
// failing the whole backtest over a feed most strategies won't even touch.
async function getFearGreedAligned(candles) {
  try {
    const history = await getCachedFearGreedHistory();
    return alignFearGreedToBars(history, candles);
  } catch {
    return candles.map(() => null);
  }
}

// Shared by runStrategyBacktest/runStrategySignal: spins up a fresh worker
// (see workers/strategyWorker.js) for one message exchange, then always
// tears it down — on success, on a thrown error, or on timeout (most likely
// an infinite loop in the user's own function, which can only hang the
// worker, never the UI, and gets terminate()'d either way).
function runInWorker(payload) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("../workers/strategyWorker.js", import.meta.url), { type: "module" });

    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error("Timed out after 15s — check for an infinite loop or heavy computation in your strategy code."));
    }, TIMEOUT_MS);

    worker.onmessage = (e) => {
      clearTimeout(timer);
      worker.terminate();
      if (e.data.type === "error") reject(new Error(e.data.message));
      else resolve(e.data);
    };
    worker.onerror = (err) => {
      clearTimeout(timer);
      worker.terminate();
      reject(new Error(err.message || "Worker error running strategy"));
    };

    worker.postMessage(payload);
  });
}

// Runs a user-written strategy against `candles` bar-by-bar and resolves
// with the closed trades it produced. Rejects on a syntax/runtime error in
// the strategy code, or on timeout.
export async function runStrategyBacktest({ candles, code, warmupBars, feeRoundtripPct = ROUNDTRIP_FEE_PCT }) {
  const fearGreed = await getFearGreedAligned(candles);
  const data = await runInWorker({ mode: "backtest", candles, code, warmupBars, feeRoundtripPct, fearGreed });
  return data.trades;
}

// Evaluates the strategy once against the latest closed bar — "what does
// this rule say right now" — using whatever position the caller says
// they're actually holding (there's no backtest-tracked state for a live
// check to fall back on). Returns the raw signal the code returned
// ("long"/"short"/"close"/null-ish) plus the bar it was judged against, so
// the caller can show exactly how fresh that read is.
export async function runStrategySignal({ candles, code, position = null }) {
  const fearGreed = await getFearGreedAligned(candles);
  const data = await runInWorker({ mode: "signal", candles, code, position, fearGreed });
  return { signal: data.signal, bar: data.bar };
}
