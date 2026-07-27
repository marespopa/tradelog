import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getStore } from "../lib/tauriStore";

const TRADES_KEY = "trades";

// Realized result from entry/exit/stop/side, so nobody has to type in a
// win/loss judgment call by hand. resultR needs a stop loss to define the
// risk unit; without one it's left null (shown as "—") rather than guessed.
function computeResult({ entryPrice, exitPrice, stopLoss, side }) {
  if (entryPrice == null || exitPrice == null) return { resultR: null, outcome: null };
  const move = (exitPrice - entryPrice) * (side === "short" ? -1 : 1);
  const outcome = move > 0 ? "Win" : move < 0 ? "Loss" : "Breakeven";
  const risk = stopLoss != null ? Math.abs(entryPrice - stopLoss) : null;
  const resultR = risk ? move / risk : null;
  return { resultR, outcome };
}

// Shared by add() and update(): turns a form-shaped input (symbol/side/
// entryPrice/etc, status "open"|"closed") into the stored trade fields,
// nulling out exit-related fields for open trades and recomputing
// resultR/outcome from scratch rather than trusting stale values.
function deriveTradeFields(input) {
  const isOpen = input.status === "open";
  const entryPrice = input.entryPrice ?? null;
  const exitPrice = isOpen ? null : input.exitPrice ?? null;
  const stopLoss = input.stopLoss ?? null;
  const side = input.side === "short" ? "short" : "long";
  const { resultR, outcome } = isOpen
    ? { resultR: null, outcome: null }
    : computeResult({ entryPrice, exitPrice, stopLoss, side });
  return {
    symbol: input.symbol.trim().toUpperCase(),
    side,
    leverage: input.leverage || 1,
    entryPrice,
    entryTime: input.entryTime || null,
    stopLoss,
    targetPrice: input.targetPrice ?? null,
    status: isOpen ? "open" : "closed",
    exitPrice,
    exitTime: isOpen ? null : input.exitTime || new Date().toISOString(),
    outcome,
    resultR,
  };
}

// Manually logged trades (entry/exit/R/outcome), persisted to a JSON file
// on disk via the Tauri store plugin so the journal survives reloads
// without needing a backend — same pattern as useWatchlist. Trades can be
// logged while still open (no exit yet) and closed out later via `close()`.
export function useTrades() {
  const [trades, setTrades] = useState([]);
  const loaded = useRef(false);

  useEffect(() => {
    let cancelled = false;
    getStore().then(async (store) => {
      const saved = await store.get(TRADES_KEY);
      if (cancelled) return;
      if (Array.isArray(saved)) setTrades(saved);
      loaded.current = true;
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!loaded.current) return;
    getStore().then((store) => {
      store.set(TRADES_KEY, trades);
      store.save();
    });
  }, [trades]);

  const add = useCallback((trade) => {
    const entry = { id: crypto.randomUUID(), ...deriveTradeFields(trade) };
    setTrades((t) => [entry, ...t]);
    return entry;
  }, []);

  // Re-derives every stored field (including resultR/outcome) from a full
  // edit-form payload, same as add() — so fixing a typo'd entry price also
  // recomputes R and win/loss instead of leaving them stale.
  const update = useCallback((id, patch) => {
    setTrades((t) => t.map((trade) => (trade.id === id ? { ...trade, ...deriveTradeFields(patch) } : trade)));
  }, []);

  // Fills in the exit price of a still-open trade, marks it closed, and
  // derives the result from it — no manual win/loss judgment call.
  const close = useCallback((id, exit) => {
    setTrades((t) =>
      t.map((trade) => {
        if (trade.id !== id) return trade;
        const exitPrice = exit.exitPrice ?? null;
        const { resultR, outcome } = computeResult({
          entryPrice: trade.entryPrice,
          exitPrice,
          stopLoss: trade.stopLoss,
          side: trade.side,
        });
        return {
          ...trade,
          status: "closed",
          exitPrice,
          exitTime: exit.exitTime || new Date().toISOString(),
          outcome,
          resultR,
        };
      })
    );
  }, []);

  const remove = useCallback((id) => {
    setTrades((t) => t.filter((trade) => trade.id !== id));
  }, []);

  const sorted = useMemo(
    () =>
      trades.slice().sort((a, b) => {
        const bt = b.exitTime ? new Date(b.exitTime).getTime() : Date.now();
        const at = a.exitTime ? new Date(a.exitTime).getTime() : Date.now();
        return bt - at;
      }),
    [trades]
  );

  const closedOnly = useMemo(() => sorted.filter((t) => t.status !== "open"), [sorted]);

  const recent = closedOnly[0] ?? null;

  return { trades: sorted, add, update, close, remove, recent };
}
