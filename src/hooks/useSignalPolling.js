import { useEffect, useRef } from "react";
import { notifyOS, ensureNotificationPermission } from "../lib/notify.js";
import { normalizeSignal } from "../lib/strategySignal.js";
import { fmtPrice } from "../lib/format.js";

// A single shared tick (not one setInterval per strategy) that, per
// strategy, checks whether its own pollMinutes cadence has elapsed since it
// was last polled. lastPolledRef/lastNotifiedRef are refs (not state) so
// their bookkeeping survives this effect being torn down and recreated on
// every render (runCheck is a fresh closure each render since it reads
// current positionInputs) without resetting the actual poll cadence.
const TICK_MS = 60_000;

// A strategy's signal only changes when a new bar closes (e.g. once per 4h
// for a 4H strategy) -- without this, every tick between closes would
// re-notify the same still-valid reading. Keyed on bar time + signal so a
// genuinely new bar with the same signal direction still notifies.
function signalKey(signal, bar) {
  return `${bar?.time ?? ""}:${signal}`;
}

export function useSignalPolling(strategies, runCheck) {
  const lastPolledRef = useRef({});
  const lastNotifiedRef = useRef({});
  // runCheck is a fresh closure every render (it reads current
  // positionInputs), and it's owned by App.jsx -- so it changes identity on
  // *any* App-level re-render, not just ones relevant to polling (e.g. the
  // watchlist-alarms poller ticking every 30s). Keeping it out of the effect
  // deps below and reading it via a ref instead means the setInterval isn't
  // torn down and restarted on every unrelated re-render, which would
  // otherwise starve it before it ever survives a full TICK_MS cycle.
  const runCheckRef = useRef(runCheck);
  useEffect(() => {
    runCheckRef.current = runCheck;
  });

  useEffect(() => {
    const tick = async () => {
      const now = Date.now();
      for (const strategy of strategies) {
        if (!strategy.autoCheck) continue;
        const intervalMs = (strategy.pollMinutes ?? 15) * 60_000;
        const last = lastPolledRef.current[strategy.id] ?? 0;
        if (now - last < intervalMs) continue;
        lastPolledRef.current[strategy.id] = now;

        let outcome;
        try {
          outcome = await runCheckRef.current(strategy);
        } catch {
          continue; // already surfaced as an error in the signals state by runCheck
        }
        if (!outcome) continue;

        const { bar } = outcome;
        const { direction, stop, target } = normalizeSignal(outcome.signal);
        if (direction !== "long" && direction !== "short" && direction !== "close") continue;

        const key = signalKey(direction, bar);
        if (lastNotifiedRef.current[strategy.id] === key) continue;
        lastNotifiedRef.current[strategy.id] = key;

        notify(strategy, direction, bar, { stop, target });
      }
    };

    const id = setInterval(tick, TICK_MS);
    return () => clearInterval(id);
  }, [strategies]);
}

const SIGNAL_TEXT = { long: "LONG", short: "SHORT", close: "CLOSE" };

async function notify(strategy, signal, bar, { stop, target } = {}) {
  const levels = stop != null && target != null ? ` — suggested stop ${fmtPrice(stop)}, target ${fmtPrice(target)}` : "";
  await notifyOS(
    `${strategy.name || strategy.symbol} — ${SIGNAL_TEXT[signal]}`,
    `${strategy.symbol} (${strategy.timeframe}) just signaled ${SIGNAL_TEXT[signal]} on the ${new Date(bar.time).toLocaleString()} bar${levels}.`
  );
}

// Fires the exact same OS toast a real signal would -- using the real
// bar/stop/target from an actual signal check (the caller runs
// runSignalCheck and passes its outcome), not fabricated numbers, so what's
// previewed is genuinely what the user would receive. Only the signal
// direction is stood in for (as "long") when the real read is flat/hold,
// since notify() only renders long/short/close. Requests permission first
// (called from a button click, so the OS prompt can surface) rather than
// just bailing like notify() does on a cold "denied".
export async function sendTestNotification(strategy, outcome) {
  const status = await ensureNotificationPermission();
  if (status !== "granted") return status;
  const { direction, stop, target } = normalizeSignal(outcome?.signal);
  const signal = direction === "long" || direction === "short" || direction === "close" ? direction : "long";
  const bar = outcome?.bar ?? { time: Date.now() };
  await notify(strategy, signal, bar, { stop, target });
  return status;
}
