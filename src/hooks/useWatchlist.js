import { useCallback, useEffect, useRef, useState } from "react";
import { getStore } from "../lib/tauriStore";

const WATCHLIST_KEY = "watchlist";

// Selected coins from the scan or analysis page, persisted to a JSON file
// on disk via the Tauri store plugin so the list survives reloads without
// needing a backend.
export function useWatchlist() {
  const [symbols, setSymbols] = useState([]);
  const loaded = useRef(false);

  useEffect(() => {
    let cancelled = false;
    getStore().then(async (store) => {
      const saved = await store.get(WATCHLIST_KEY);
      if (cancelled) return;
      if (Array.isArray(saved)) setSymbols(saved);
      loaded.current = true;
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!loaded.current) return;
    getStore().then((store) => {
      store.set(WATCHLIST_KEY, symbols);
      store.save();
    });
  }, [symbols]);

  const has = useCallback((symbol) => symbols.includes(symbol), [symbols]);

  const remove = useCallback((symbol) => {
    setSymbols((s) => s.filter((sym) => sym !== symbol));
  }, []);

  const toggle = useCallback((symbol) => {
    setSymbols((s) => (s.includes(symbol) ? s.filter((sym) => sym !== symbol) : [...s, symbol]));
  }, []);

  return { symbols, has, remove, toggle };
}
