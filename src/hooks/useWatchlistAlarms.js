import { useCallback, useEffect, useRef, useState } from "react";
import { isPermissionGranted, sendNotification } from "@tauri-apps/plugin-notification";
import { getStore } from "../lib/tauriStore";
import { scanInBatches, fetchTickerPrice } from "../lib/analysis/krakenSpot.js";
import { fmtPrice } from "../lib/format.js";

const ALARMS_KEY = "watchlistAlarms";
const TICK_MS = 30_000;

export function alarmExhausted(alarm) {
  return alarm.firedCount >= alarm.repeat;
}

// Upgrades a pre-mode/repeat alarm (bare `{ price, direction, triggered }`)
// to the current shape so an alarm set before this feature existed keeps
// working instead of silently breaking on load. No-ops on an already-current
// alarm (just backfills any field a partial/old save might be missing).
function normalizeAlarm(a) {
  if (a.mode) return { repeat: 1, firedCount: 0, armed: true, lastPrice: null, ...a };
  return {
    price: a.price,
    mode: a.direction === "below" ? "below" : "above",
    repeat: 1,
    firedCount: a.triggered ? 1 : 0,
    armed: !a.triggered,
    lastPrice: null,
  };
}

// "above"/"below" are plain threshold checks; "exact" needs the previous
// sampled price to detect a genuine crossing (price landing exactly on the
// target is vanishingly rare in a live market, so "exact" means "crossed
// this level from either direction" instead).
function evaluateHit(alarm, lastPrice, price) {
  if (alarm.mode === "exact") {
    if (lastPrice == null) return false;
    return (lastPrice < alarm.price && price >= alarm.price) || (lastPrice > alarm.price && price <= alarm.price);
  }
  if (alarm.mode === "below") return price <= alarm.price;
  return price >= alarm.price;
}

// Whether price has moved back to the side an "above"/"below" alarm needs
// to be on before it's allowed to fire again -- without this a repeating
// alarm would re-notify on every single tick for as long as price just sits
// past the target, instead of only on each fresh approach. "exact" has no
// cooldown of its own: evaluateHit's crossing check already requires fresh
// movement each time, so it always reports reset.
function resetSide(alarm, price) {
  if (alarm.mode === "below") return price > alarm.price;
  if (alarm.mode === "above") return price < alarm.price;
  return true;
}

async function notifyAlarm(symbol, price, alarm) {
  // Same native-OS-toast rationale as useSignalPolling's notify(): the
  // Tauri plugin respects OS notification settings and can be re-requested
  // after a denial, unlike the webview's Web Notification API.
  if (!(await isPermissionGranted())) return;
  const verb = alarm.mode === "exact" ? "crossed" : alarm.mode === "below" ? "dropped to" : "rose to";
  const remaining = alarm.repeat - alarm.firedCount;
  const repeatNote =
    alarm.repeat > 1 ? ` (${alarm.firedCount}/${alarm.repeat}${remaining > 0 ? " — will notify again once it resets" : ", done"})` : "";
  sendNotification({
    title: `${symbol} price alarm`,
    body: `${symbol} ${verb} ${fmtPrice(price)} (target ${fmtPrice(alarm.price)})${repeatNote}.`,
  });
}

// Price alarms for watchlist/analysis coins: set a target price, a
// direction (rises above / falls below / crosses either way), and how many
// times it should re-fire, and get a native OS toast once it hits.
// Persisted the same way as useWatchlist/useStrategies. Owned by App.jsx
// (not WatchlistPanel/CoinAnalysis) so the background poller -- and thus
// notifications -- keeps running while any other tab is open, matching how
// useStrategySignals/useSignalPolling stay alive app-wide.
export function useWatchlistAlarms() {
  const [alarms, setAlarms] = useState({});
  const loaded = useRef(false);

  useEffect(() => {
    let cancelled = false;
    getStore().then(async (store) => {
      const saved = await store.get(ALARMS_KEY);
      if (cancelled) return;
      if (saved && typeof saved === "object") {
        const normalized = {};
        for (const [symbol, a] of Object.entries(saved)) normalized[symbol] = normalizeAlarm(a);
        setAlarms(normalized);
      }
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

  // Editing an existing alarm re-arms it fresh (firedCount/armed/lastPrice
  // reset) rather than trying to carry over progress from the old target.
  const set = useCallback((symbol, { price, mode, repeat }) => {
    setAlarms((a) => ({
      ...a,
      [symbol]: { price, mode, repeat: Math.max(1, parseInt(repeat, 10) || 1), firedCount: 0, armed: true, lastPrice: null },
    }));
  }, []);

  const remove = useCallback((symbol) => {
    setAlarms((a) => {
      const { [symbol]: _, ...rest } = a;
      return rest;
    });
  }, []);

  useEffect(() => {
    const tick = async () => {
      const pending = Object.entries(alarms).filter(([, a]) => !alarmExhausted(a));
      if (pending.length === 0) return;

      const results = await scanInBatches(
        pending.map(([symbol]) => symbol),
        async (symbol) => ({ symbol, price: await fetchTickerPrice(symbol) })
      );

      const updates = {};
      for (const r of results) {
        if (r.status !== "fulfilled" || r.value.price == null) continue;
        const { symbol, price } = r.value;
        const alarm = alarms[symbol];
        if (!alarm || alarmExhausted(alarm)) continue;

        let next = alarm;
        if (!next.armed) {
          if (!resetSide(next, price)) {
            updates[symbol] = { ...next, lastPrice: price };
            continue;
          }
          next = { ...next, armed: true };
        }

        if (evaluateHit(next, next.lastPrice, price)) {
          next = { ...next, lastPrice: price, firedCount: next.firedCount + 1, armed: false };
          updates[symbol] = next;
          notifyAlarm(symbol, price, next);
        } else {
          updates[symbol] = { ...next, lastPrice: price };
        }
      }

      if (Object.keys(updates).length > 0) setAlarms((current) => ({ ...current, ...updates }));
    };

    const id = setInterval(tick, TICK_MS);
    return () => clearInterval(id);
  }, [alarms]);

  return { alarms, set, remove };
}
