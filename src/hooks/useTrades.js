import { useCallback, useEffect, useMemo, useState } from "react";

const TRADES_KEY = "alpha-scout-trades";
// How many of the most recent trades count toward the "win streak" shown on
// the recent-result card — matches the "4/4 streak" framing, i.e. recent
// form rather than an all-time streak.
const STREAK_WINDOW = 4;

function readTrades() {
  try {
    const raw = localStorage.getItem(TRADES_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isWin(trade) {
  return (trade.resultR ?? 0) >= 0;
}

// Manually logged trades (entry/exit/R/outcome), persisted locally so the
// journal survives reloads without needing a backend — same pattern as
// useWatchlist. Trades can be logged while still open (no exit yet) and
// closed out later via `close()`.
export function useTrades() {
  const [trades, setTrades] = useState(readTrades);

  useEffect(() => {
    localStorage.setItem(TRADES_KEY, JSON.stringify(trades));
  }, [trades]);

  const add = useCallback((trade) => {
    const isOpen = trade.status === "open";
    const entry = {
      id: crypto.randomUUID(),
      symbol: trade.symbol.trim().toUpperCase(),
      side: trade.side === "short" ? "short" : "long",
      leverage: trade.leverage || 1,
      entryPrice: trade.entryPrice ?? null,
      entryTime: trade.entryTime || null,
      stopLoss: trade.stopLoss ?? null,
      targetPrice: trade.targetPrice ?? null,
      status: isOpen ? "open" : "closed",
      exitPrice: isOpen ? null : trade.exitPrice ?? null,
      exitTime: isOpen ? null : trade.exitTime || new Date().toISOString(),
      outcome: isOpen ? null : trade.outcome?.trim() || null,
      resultR: isOpen ? null : trade.resultR ?? null,
    };
    setTrades((t) => [entry, ...t]);
    return entry;
  }, []);

  // Fills in the exit details of a still-open trade and marks it closed.
  const close = useCallback((id, exit) => {
    setTrades((t) =>
      t.map((trade) =>
        trade.id === id
          ? {
              ...trade,
              status: "closed",
              exitPrice: exit.exitPrice ?? null,
              exitTime: exit.exitTime || new Date().toISOString(),
              outcome: exit.outcome?.trim() || null,
              resultR: exit.resultR ?? null,
            }
          : trade
      )
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

  const streak = useMemo(() => {
    const window = closedOnly.slice(0, STREAK_WINDOW);
    const wins = window.filter(isWin).length;
    return { wins, of: window.length };
  }, [closedOnly]);

  return { trades: sorted, add, close, remove, recent, streak };
}
