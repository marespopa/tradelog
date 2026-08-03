import { useEffect, useRef, useState } from "react";
import { ensureNotificationPermission } from "../lib/notify.js";
import { alarmExhausted } from "../hooks/useWatchlistAlarms.js";
import BellIcon from "./BellIcon.jsx";
import { fmtPrice } from "../lib/format.js";

const MODE_SYMBOL = { above: "≥", below: "≤", exact: "=" };

// Header-level view of every price alarm across the app -- including ones
// set from Coin Analysis for a symbol that was never added to the
// watchlist, which otherwise have no other place to be seen again. Same
// open/click-outside popover pattern as Dropdown.jsx.
export default function AlarmsMenu({ watchlistAlarms, onSelectSymbol }) {
  const [open, setOpen] = useState(false);
  const [notifBlocked, setNotifBlocked] = useState(false);
  const ref = useRef(null);

  // Checked once up front, same as StrategiesPanel's own notifBlocked check
  // -- an alarm can fire (its stored state updates fine) with no toast ever
  // appearing if the OS permission is denied, which otherwise looks
  // indistinguishable from the alarm just not working.
  useEffect(() => {
    ensureNotificationPermission().then((status) => setNotifBlocked(status === "denied"));
  }, []);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  const entries = Object.entries(watchlistAlarms.alarms).sort(([a], [b]) => a.localeCompare(b));
  const armedCount = entries.filter(([, a]) => !alarmExhausted(a)).length;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Price alarms"
        title={notifBlocked ? "Price alarms — OS notifications are blocked" : "Price alarms"}
        className={`relative flex h-8 w-8 items-center justify-center rounded-full bg-panel-alt transition-all duration-200 hover:bg-panel-raised ${
          notifBlocked ? "text-position-short" : "text-ink"
        }`}
      >
        <BellIcon className="h-4 w-4" />
        {armedCount > 0 && (
          <span className="absolute -right-1 -top-1 flex h-3.5 min-w-[14px] items-center justify-center rounded-full bg-blue-500 px-0.5 text-[9px] font-semibold leading-none text-white">
            {armedCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-30 mt-2 w-72 overflow-hidden rounded-md border border-edge bg-panel shadow-card">
          <div className="border-b border-edge px-3 py-2 text-[11px] font-semibold text-dim">Price alarms</div>

          {notifBlocked && (
            <p className="border-b border-edge bg-position-short/10 px-3 py-2 text-[11px] text-position-short">
              OS notifications are blocked — alarms still track price but won't show a toast. Check your system notification settings.
            </p>
          )}

          {entries.length === 0 && <p className="px-3 py-3 text-[12px] text-dim">No alarms set.</p>}

          {entries.length > 0 && (
            <ul className="max-h-80 overflow-y-auto">
              {entries.map(([symbol, alarm]) => {
                const exhausted = alarmExhausted(alarm);
                return (
                  <li key={symbol} className="flex items-center justify-between gap-2 px-3 py-2 hover:bg-panel-alt">
                    <button
                      type="button"
                      onClick={() => {
                        setOpen(false);
                        onSelectSymbol?.(symbol);
                      }}
                      className="min-w-0 flex-1 text-left"
                    >
                      <div className="truncate text-[12px] font-medium text-ink">{symbol}</div>
                      <div className="text-[11px] text-dim">
                        {MODE_SYMBOL[alarm.mode]} {fmtPrice(alarm.price)}
                        {alarm.repeat > 1 && (
                          <span className="ml-1 text-dim/70">
                            · {alarm.firedCount}/{alarm.repeat}
                          </span>
                        )}
                      </div>
                    </button>
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                        exhausted ? "bg-amber-400/15 text-amber-400" : "bg-accent/15 text-accent"
                      }`}
                    >
                      {exhausted ? "Done" : alarm.firedCount > 0 ? "Fired" : "Armed"}
                    </span>
                    <button
                      type="button"
                      onClick={() => watchlistAlarms.remove(symbol)}
                      aria-label={`Clear alarm for ${symbol}`}
                      title="Clear alarm"
                      className="shrink-0 text-[13px] leading-none text-dim/50 hover:text-position-short"
                    >
                      ×
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
