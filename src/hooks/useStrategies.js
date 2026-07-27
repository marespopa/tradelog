import { useCallback, useEffect, useRef, useState } from "react";
import { getStore } from "../lib/tauriStore";

const STRATEGIES_KEY = "strategies";

// User-authored backtest strategies (name/symbol/timeframe/code), persisted
// the same way as useTrades/useWatchlist — the code itself is just a string
// until it's run, so storing it is no different from storing any other
// journal text.
export function useStrategies() {
  const [strategies, setStrategies] = useState([]);
  const loaded = useRef(false);

  useEffect(() => {
    let cancelled = false;
    getStore().then(async (store) => {
      const saved = await store.get(STRATEGIES_KEY);
      if (cancelled) return;
      if (Array.isArray(saved)) setStrategies(saved);
      loaded.current = true;
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!loaded.current) return;
    getStore().then((store) => {
      store.set(STRATEGIES_KEY, strategies);
      store.save();
    });
  }, [strategies]);

  const add = useCallback((strategy) => {
    const now = new Date().toISOString();
    const entry = { id: crypto.randomUUID(), createdAt: now, updatedAt: now, ...strategy };
    setStrategies((s) => [entry, ...s]);
    return entry;
  }, []);

  const update = useCallback((id, patch) => {
    setStrategies((s) => s.map((strat) => (strat.id === id ? { ...strat, ...patch, updatedAt: new Date().toISOString() } : strat)));
  }, []);

  const remove = useCallback((id) => {
    setStrategies((s) => s.filter((strat) => strat.id !== id));
  }, []);

  return { strategies, add, update, remove };
}
