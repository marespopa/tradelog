import { useEffect, useRef, useState } from "react";
import { ensureNotificationPermission } from "../hooks/useSignalPolling.js";
import { alarmExhausted } from "../hooks/useWatchlistAlarms.js";
import BellIcon from "./BellIcon.jsx";
import { fmtPrice } from "../lib/format.js";

const MODES = [
  { value: "above", label: "Rises above" },
  { value: "below", label: "Falls below" },
  { value: "exact", label: "Crosses (either way)" },
];

// Inline price-alarm control for one watchlist/analysis row: the bell opens
// a small popover to set/edit the target, direction, and repeat count.
// Firing happens in useWatchlistAlarms's background poller (owned by
// App.jsx) -- this component only edits the persisted alarm, the same way
// WatchButton only flips a stored boolean.
export default function AlarmCell({ symbol, alarm, currentPrice, onSet, onClear }) {
  const [open, setOpen] = useState(false);
  const [price, setPrice] = useState("");
  const [mode, setMode] = useState("above");
  const [repeat, setRepeat] = useState("1");
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  const startEdit = (e) => {
    e.stopPropagation();
    setPrice(alarm ? String(alarm.price) : currentPrice != null ? String(currentPrice) : "");
    setMode(alarm?.mode ?? "above");
    setRepeat(String(alarm?.repeat ?? 1));
    setOpen(true);
  };

  const commit = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const priceNum = parseFloat(price);
    if (!isNaN(priceNum) && priceNum > 0) {
      onSet(symbol, { price: priceNum, mode, repeat });
      // Fired from this submit's user gesture so the OS permission prompt
      // can actually surface (see ensureNotificationPermission's contract).
      ensureNotificationPermission();
    }
    setOpen(false);
  };

  const exhausted = alarm && alarmExhausted(alarm);
  const status = !alarm ? null : exhausted ? "Done" : alarm.firedCount > 0 ? `Fired ${alarm.firedCount}/${alarm.repeat}` : "Armed";

  return (
    <div ref={ref} className="relative flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={startEdit}
        aria-label={alarm ? "Edit price alarm" : "Set a price alarm"}
        title={alarm ? `Alarm — ${MODES.find((m) => m.value === alarm.mode)?.label.toLowerCase()} ${fmtPrice(alarm.price)} — click to edit` : "Set a price alarm"}
        className={`flex items-center transition-transform duration-150 hover:scale-110 ${
          exhausted ? "text-amber-400" : alarm ? "text-accent" : "text-dim/40 hover:text-dim"
        }`}
      >
        <BellIcon className="h-3.5 w-3.5" />
      </button>

      {alarm && (
        <>
          <span className="whitespace-nowrap text-[11px] text-dim">
            {fmtPrice(alarm.price)}
            {status && <span className="ml-1 text-dim/70">· {status}</span>}
          </span>
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

      {open && (
        <form
          onSubmit={commit}
          onClick={(e) => e.stopPropagation()}
          className="absolute left-0 top-full z-30 mt-1 flex w-52 flex-col gap-2 rounded-md border border-edge bg-panel p-3 shadow-card"
        >
          <label className="flex flex-col gap-1 text-[11px] text-dim">
            Target price
            <input
              type="number"
              step="any"
              autoFocus
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              className="rounded border border-edge bg-bg px-2 py-1 text-[12px] text-ink outline-none focus:border-accent"
            />
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-dim">
            Condition
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value)}
              className="rounded border border-edge bg-bg px-2 py-1 text-[12px] text-ink outline-none focus:border-accent"
            >
              {MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-dim">
            Repeat (times)
            <input
              type="number"
              min="1"
              step="1"
              value={repeat}
              onChange={(e) => setRepeat(e.target.value)}
              className="rounded border border-edge bg-bg px-2 py-1 text-[12px] text-ink outline-none focus:border-accent"
            />
          </label>
          <div className="flex items-center justify-between gap-2 pt-1">
            {alarm && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onClear(symbol);
                  setOpen(false);
                }}
                className="text-[11px] text-dim hover:text-position-short"
              >
                Remove
              </button>
            )}
            <button type="submit" className="ml-auto rounded bg-accent px-2.5 py-1 text-[11px] font-medium text-white hover:opacity-90">
              {alarm ? "Update" : "Set alarm"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
