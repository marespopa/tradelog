import { useEffect, useRef, useState } from "react";

// Custom select replacement for DataTable's column filters and page-size
// picker. Native <select> popups are rendered by the OS/browser and can't
// be restyled by any CSS — a hard platform limitation, not a bug — so
// anywhere the dropdown needs to follow the app's theme (e.g. the
// Bloomberg-style dark theme) it has to be a plain div-based listbox
// instead. Same open/click-outside pattern as DataTable's own TableMenu.
export default function Dropdown({ value, onChange, options, placeholder = "All", clearable = true, className = "" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  const selected = options.find((o) => String(o.value) === String(value));

  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-1 rounded border-0 bg-transparent px-1 py-1 text-left text-xs text-ink shadow-none outline-none transition-colors duration-150 hover:bg-panel-alt"
      >
        <span className={`truncate ${selected ? "text-ink" : "text-dim"}`}>{selected ? selected.label : placeholder}</span>
        <span className="shrink-0 text-[9px] text-dim">▾</span>
      </button>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 max-h-60 min-w-full overflow-y-auto rounded-md border border-edge bg-panel py-1 shadow-card">
          {clearable && (
            <button
              type="button"
              onClick={() => {
                onChange("");
                setOpen(false);
              }}
              className={`block w-full whitespace-nowrap border-0 px-3 py-1.5 text-left text-xs transition-colors duration-150 hover:bg-panel-alt ${!value ? "text-ink" : "text-dim"}`}
            >
              {placeholder}
            </button>
          )}
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
              className={`block w-full whitespace-nowrap border-0 px-3 py-1.5 text-left text-xs transition-colors duration-150 hover:bg-panel-alt ${String(value) === String(o.value) ? "text-ink" : "text-dim"}`}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
