import { useCallback, useEffect, useRef, useState } from "react";
import { getStore } from "../lib/tauriStore";

const PORTFOLIO_KEY = "portfolioHoldings";

function deriveHoldingFields(input) {
  return {
    symbol: input.symbol.trim().toUpperCase(),
    quantity: input.quantity,
    avgCost: input.avgCost,
  };
}

// Manually tracked buy-and-hold lots (symbol/quantity/avg cost), persisted
// the same way as useWatchlist. Deliberately not merged on a repeated
// symbol -- avoids weighted-average-cost merge math and its edge cases, and
// keeps each lot's own true cost basis for DCA buys at different prices.
export function usePortfolio() {
  const [holdings, setHoldings] = useState([]);
  const loaded = useRef(false);

  useEffect(() => {
    let cancelled = false;
    getStore().then(async (store) => {
      const saved = await store.get(PORTFOLIO_KEY);
      if (cancelled) return;
      if (Array.isArray(saved)) setHoldings(saved);
      loaded.current = true;
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!loaded.current) return;
    getStore().then((store) => {
      store.set(PORTFOLIO_KEY, holdings);
      store.save();
    });
  }, [holdings]);

  const add = useCallback((holding) => {
    const entry = { id: crypto.randomUUID(), ...deriveHoldingFields(holding), addedAt: new Date().toISOString() };
    setHoldings((h) => [entry, ...h]);
    return entry;
  }, []);

  const update = useCallback((id, patch) => {
    setHoldings((h) => h.map((x) => (x.id === id ? { ...x, ...deriveHoldingFields(patch) } : x)));
  }, []);

  const remove = useCallback((id) => {
    setHoldings((h) => h.filter((x) => x.id !== id));
  }, []);

  return { holdings, add, update, remove };
}
