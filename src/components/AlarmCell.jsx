import { useState } from "react";
import { ensureNotificationPermission } from "../hooks/useSignalPolling.js";
import { fmtPrice } from "../lib/format.js";

// Inline price-alarm control for one watchlist row: a bell toggles a small
// target-price input. Firing happens in useWatchlistAlarms's background
// poller (owned by App.jsx), not here -- this component only edits the
// persisted target, the same way WatchButton only flips a stored boolean.
export default function AlarmCell({ symbol, alarm, currentPrice, onSet, onClear }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");

  const startEdit = (e) => {
    e.stopPropagation();
    setValue(alarm ? String(alarm.price) : currentPrice != null ? String(currentPrice) : "");
    setEditing(true);
  };

  const commit = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const price = parseFloat(value);
    if (!isNaN(price) && price > 0) {
      onSet(symbol, price, currentPrice);
      // Fired from this submit's user gesture so the OS permission prompt
      // can actually surface (see ensureNotificationPermission's contract).
      ensureNotificationPermission();
    }
    setEditing(false);
  };

  if (editing) {
    return (
      <form onSubmit={commit} onClick={(e) => e.stopPropagation()}>
        <input
          type="number"
          step="any"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Escape" && setEditing(false)}
          placeholder="target price"
          className="w-24 rounded border border-edge bg-bg px-1.5 py-0.5 text-[11px] text-ink outline-none focus:border-accent"
        />
      </form>
    );
  }

  return (
    <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={startEdit}
        aria-label={alarm ? "Edit price alarm" : "Set a price alarm"}
        title={alarm ? `Alarm at ${fmtPrice(alarm.price)}${alarm.triggered ? " (triggered)" : ""} — click to edit` : "Set a price alarm"}
        className={`text-[14px] leading-none transition-transform duration-150 hover:scale-110 ${
          alarm?.triggered ? "text-amber-400" : alarm ? "text-accent" : "text-dim/40 hover:text-dim"
        }`}
      >
        🔔
      </button>
      {alarm && (
        <>
          <span className="text-[11px] text-dim">{fmtPrice(alarm.price)}</span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onClear(symbol);
            }}
            aria-label="Clear alarm"
            title="Clear alarm"
            className="text-[11px] leading-none text-dim/50 hover:text-position-short"
          >
            ×
          </button>
        </>
      )}
    </div>
  );
}
