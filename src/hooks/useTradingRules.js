import { useCallback, useEffect, useRef, useState } from "react";
import { getStore } from "../lib/tauriStore";

const RULES_KEY = "tradingRules";

const defaults = { accountSize: null, riskPercent: 1 };

// Account size + per-trade risk %, persisted the same way as
// useTrades/useWatchlist — feeds the position-sizing helper on the Add
// Trade form so "how big should this be" is answered from account risk,
// not from how badly the last trade needs to be made back.
export function useTradingRules() {
  const [rules, setRules] = useState(defaults);
  const loaded = useRef(false);

  useEffect(() => {
    let cancelled = false;
    getStore().then(async (store) => {
      const saved = await store.get(RULES_KEY);
      if (cancelled) return;
      if (saved) setRules({ ...defaults, ...saved });
      loaded.current = true;
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!loaded.current) return;
    getStore().then((store) => {
      store.set(RULES_KEY, rules);
      store.save();
    });
  }, [rules]);

  const update = useCallback((patch) => {
    setRules((r) => ({ ...r, ...patch }));
  }, []);

  return { ...rules, update };
}
