import { useCallback, useEffect, useRef, useState } from "react";
import { isPermissionGranted, sendNotification } from "@tauri-apps/plugin-notification";
import { getStore } from "../lib/tauriStore";
import { scanInBatches, fetchTickerPrice } from "../lib/analysis/krakenSpot.js";
import { fmtPrice } from "../lib/format.js";

const ALARMS_KEY = "watchlistAlarms";
const TICK_MS = 60_000;

// Price alarms for watchlist coins: set a target price and get a native OS
// toast (the same Tauri notification plugin useSignalPolling uses for
// strategy signals) once price crosses it. Persisted the same way as
// useWatchlist/useStrategies. Owned by App.jsx (not WatchlistPanel) so the
// background poller -- and thus notifications -- keeps running while any
// other tab is open, not just while Watchlist itself is mounted, matching
// how useStrategySignals/useSignalPolling stay alive app-wide.
export function useWatchlistAlarms() {
  const [alarms, setAlarms] = useState({});
  const loaded = useRef(false);

  useEffect(() => {
    let cancelled = false;
    getStore().then(async (store) => {
      const saved = await store.get(ALARMS_KEY);
      if (cancelled) return;
      if (saved && typeof saved === "object") setAlarms(saved);
      loaded.current = true;
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!loaded.current) return;
    getStore().then((store) => {
      store.set(ALARMS_KEY, alarms);
      store.save();
    });
  }, [alarms]);

  // Direction is fixed at creation time from where price sits relative to
  // the target, not re-derived later -- a "notify when price reaches X"
  // request is inherently one-directional (crossing up into it vs down into
  // it), so it shouldn't flip if price wanders back and forth before ever
  // reaching the target.
  const set = useCallback((symbol, price, currentPrice) => {
    setAlarms((a) => ({
      ...a,
      [symbol]: { price, direction: currentPrice != null && price < currentPrice ? "below" : "above", triggered: false },
    }));
  }, []);

  const remove = useCallback((symbol) => {
    setAlarms((a) => {
      const { [symbol]: _, ...rest } = a;
      return rest;
    });
  }, []);

  const markTriggered = useCallback((symbol) => {
    setAlarms((a) => (a[symbol] && !a[symbol].triggered ? { ...a, [symbol]: { ...a[symbol], triggered: true } } : a));
  }, []);

  // Single shared tick, same TICK_MS cadence as useSignalPolling. A
  // triggered alarm is skipped on every subsequent tick (not deleted) so it
  // stays visible in the watchlist until the user clears or resets it,
  // instead of re-notifying every minute once price sits past the target.
  useEffect(() => {
    const tick = async () => {
      const armed = Object.entries(alarms).filter(([, a]) => !a.triggered);
      if (armed.length === 0) return;

      const results = await scanInBatches(
        armed.map(([symbol]) => symbol),
        async (symbol) => ({ symbol, price: await fetchTickerPrice(symbol) })
      );

      for (const r of results) {
        if (r.status !== "fulfilled" || r.value.price == null) continue;
        const { symbol, price } = r.value;
        const alarm = alarms[symbol];
        if (!alarm || alarm.triggered) continue;
        const hit = alarm.direction === "below" ? price <= alarm.price : price >= alarm.price;
        if (!hit) continue;

        markTriggered(symbol);
        // Same native-OS-toast rationale as useSignalPolling's notify(): the
        // Tauri plugin respects OS notification settings and can be
        // re-requested after a denial, unlike the webview's Web Notification
        // API.
        if (!(await isPermissionGranted())) continue;
        sendNotification({
          title: `${symbol} price alarm`,
          body: `${symbol} reached ${fmtPrice(price)} (target ${fmtPrice(alarm.price)}).`,
        });
      }
    };

    const id = setInterval(tick, TICK_MS);
    return () => clearInterval(id);
  }, [alarms, markTriggered]);

  return { alarms, set, remove, markTriggered };
}
