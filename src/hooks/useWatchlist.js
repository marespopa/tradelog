import { useCallback, useEffect, useState } from "react";

const WATCHLIST_KEY = "alpha-scout-watchlist";

function readWatchlist() {
  try {
    const raw = localStorage.getItem(WATCHLIST_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Selected coins from the scan or analysis page, persisted locally so the
// list survives reloads without needing a backend.
export function useWatchlist() {
  const [symbols, setSymbols] = useState(readWatchlist);

  useEffect(() => {
    localStorage.setItem(WATCHLIST_KEY, JSON.stringify(symbols));
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
