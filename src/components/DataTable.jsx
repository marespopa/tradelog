import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Dropdown from "./Dropdown.jsx";

// Single row, memoized so that clicking sort/filter/page controls only
// re-renders the rows that actually changed position/content instead of the
// whole (now potentially hundreds-of-rows) table body.
const TableRow = memo(function TableRow({
  row,
  columns,
  onRowClick,
  renderExpanded,
  expanded,
  onToggleExpand,
  reorder,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
}) {
  return (
    <>
      <tr
        onClick={onRowClick ? () => onRowClick(row) : undefined}
        className={`border-b border-edge-soft transition-colors duration-100 last:border-0 hover:bg-panel-alt ${onRowClick ? "cursor-pointer" : ""} ${expanded ? "!border-transparent" : ""}`}
      >
        {reorder && (
          <td className="whitespace-nowrap px-1 py-2.5 text-center">
            <div className="flex flex-col items-center gap-0.5">
              <button
                type="button"
                disabled={!canMoveUp}
                onClick={(e) => {
                  e.stopPropagation();
                  onMoveUp();
                }}
                title={reorder.disabledReason || "Move up"}
                aria-label="Move up"
                className="flex h-4 w-4 items-center justify-center rounded border-0 text-[9px] text-dim transition-colors duration-150 enabled:hover:bg-panel-alt enabled:hover:text-ink disabled:opacity-20"
              >
                ▲
              </button>
              <button
                type="button"
                disabled={!canMoveDown}
                onClick={(e) => {
                  e.stopPropagation();
                  onMoveDown();
                }}
                title={reorder.disabledReason || "Move down"}
                aria-label="Move down"
                className="flex h-4 w-4 items-center justify-center rounded border-0 text-[9px] text-dim transition-colors duration-150 enabled:hover:bg-panel-alt enabled:hover:text-ink disabled:opacity-20"
              >
                ▼
              </button>
            </div>
          </td>
        )}
        {renderExpanded && (
          <td className="whitespace-nowrap px-2 py-2.5 text-center">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onToggleExpand(row);
              }}
              aria-label={expanded ? "Collapse row" : "Expand row"}
              aria-expanded={expanded}
              className="flex h-5 w-5 items-center justify-center rounded border-0 text-dim transition-colors duration-150 hover:bg-panel-alt hover:text-ink"
            >
              <span
                className="inline-block text-[9px] transition-transform duration-150"
                style={{ transform: expanded ? "rotate(180deg)" : "rotate(0deg)" }}
              >
                ▾
              </span>
            </button>
          </td>
        )}
        {columns.map((c) => (
          <td
            key={c.key}
            className={`whitespace-nowrap px-3 py-2.5 text-ink ${c.align === "right" ? "text-right" : ""}`}
          >
            {c.formatter ? c.formatter(row) : (row[c.key] ?? "—")}
          </td>
        ))}
      </tr>
      {renderExpanded && expanded && (
        <tr className="border-b border-edge-soft last:border-0">
          <td colSpan={columns.length + 1 + (reorder ? 1 : 0)} className="animate-fade-in bg-panel-alt/60 px-5 py-3.5">
            {renderExpanded(row)}
          </td>
        </tr>
      )}
    </>
  );
});

function toCsvCell(value) {
  const s = value == null ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadCsv(filename, columns, rows) {
  const csvColumns = columns.filter((c) => c.sortable !== false);
  const header = csvColumns.map((c) => toCsvCell(c.title || c.key));
  const lines = rows.map((row) =>
    csvColumns.map((c) => toCsvCell(c.csvValue ? c.csvValue(row) : (c.filterValue ? c.filterValue(row) : row[c.key]))).join(",")
  );
  const csv = [header.join(","), ...lines].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function TableMenu({ onExport }) {
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

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Table options"
        className="flex h-6 w-6 items-center justify-center rounded border-0 text-dim transition-colors duration-150 hover:bg-panel-alt hover:text-ink"
      >
        ⋯
      </button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-1 min-w-[140px] rounded-md border border-edge bg-panel py-1 shadow-card">
          <button
            type="button"
            onClick={() => {
              onExport();
              setOpen(false);
            }}
            className="block w-full border-0 px-3 py-1.5 text-left text-xs text-ink transition-colors duration-150 hover:bg-panel-alt"
          >
            Export CSV
          </button>
        </div>
      )}
    </div>
  );
}

// Sortable + per-column-filterable table. `columns` entries: { key, title, width,
// align, filter: "text"|"select", filterValue(row), sortValue(row), csvValue(row), formatter(row),
// hidden: true to keep a field out of the rendered table (e.g. shown only in an expanded row)
// while still including it in CSV export. }.
// `onRowClick(row)`, if given, makes every row clickable (e.g. jump to a coin's detail view).
// `onReorder(newRowsInFullOrder)`, if given, adds up/down move buttons that let the user
// drag the row's position; only enabled while unsorted and unfiltered, since that's the
// only state where on-screen order matches the underlying data order being reordered.
export default function DataTable({ columns, data, initialSort, emptyText = "No results", pageSize: initialPageSize = 20, onRowClick, exportFilename, renderExpanded, onReorder }) {
  const [filters, setFilters] = useState({});
  const [sort, setSort] = useState(initialSort ?? { key: null, dir: 1 });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(initialPageSize);
  const [expandedIds, setExpandedIds] = useState(() => new Set());

  const visibleColumns = useMemo(() => columns.filter((c) => !c.hidden), [columns]);

  const toggleExpand = useCallback((row) => {
    const id = row.id ?? row.symbol;
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectOptions = useMemo(() => {
    const opts = {};
    for (const c of visibleColumns) {
      if (c.filter === "select") {
        opts[c.key] = [...new Set(data.map((r) => c.filterValue(r)))].sort();
      }
    }
    return opts;
  }, [visibleColumns, data]);

  const filtered = useMemo(() => {
    return data.filter((row) =>
      visibleColumns.every((c) => {
        const fv = filters[c.key];
        if (!fv) return true;
        const val = c.filterValue ? c.filterValue(row) : row[c.key];
        return c.filter === "select" ? String(val) === fv : String(val).toLowerCase().includes(fv.toLowerCase());
      })
    );
  }, [data, visibleColumns, filters]);

  const sorted = useMemo(() => {
    if (!sort.key) return filtered;
    const col = columns.find((c) => c.key === sort.key);
    const sv = col.sortValue || ((r) => r[col.key]);
    return filtered.slice().sort((a, b) => {
      const av = sv(a), bv = sv(b);
      return av < bv ? -sort.dir : av > bv ? sort.dir : 0;
    });
  }, [filtered, sort, columns]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const clampedPage = Math.min(Math.max(1, page), totalPages);
  const start = (clampedPage - 1) * pageSize;
  const pageRows = sorted.slice(start, start + pageSize);

  // Manual reordering only means something against the natural (unsorted,
  // unfiltered) list — otherwise "move up" would silently reorder data the
  // user can't currently see reflected on screen. Surfaced as a disabled
  // hint rather than hiding the buttons, so the reorder column doesn't jump
  // in and out as the user sorts/filters.
  const hasActiveFilter = Object.values(filters).some(Boolean);
  const customOrderActive = !sort.key && !hasActiveFilter;
  const reorder = onReorder
    ? { disabledReason: customOrderActive ? null : "Clear sort/filters to reorder" }
    : null;

  const moveRow = useCallback(
    (absIndex, direction) => {
      const to = absIndex + direction;
      if (to < 0 || to >= sorted.length) return;
      const next = sorted.slice();
      [next[absIndex], next[to]] = [next[to], next[absIndex]];
      onReorder(next);
    },
    [sorted, onReorder]
  );

  const toggleSort = useCallback((key) => {
    setSort((s) => (s.key === key ? { key, dir: -s.dir } : { key, dir: 1 }));
    setPage(1);
  }, []);

  const setFilter = useCallback((key, value) => {
    setFilters((f) => ({ ...f, [key]: value }));
    setPage(1);
  }, []);

  return (
    <div className="flex flex-col">
      {exportFilename && sorted.length > 0 && (
        <div className="flex items-center justify-end border-b border-edge px-2 py-1">
          <TableMenu onExport={() => downloadCsv(exportFilename, columns, sorted)} />
        </div>
      )}
      <div className="table-scroll overflow-x-auto">
        <table className="w-full border-separate border-spacing-0 text-[13px]">
          <thead className="sticky top-0 z-10 bg-panel">
            <tr>
              {reorder && <th className="border-b border-edge p-0" style={{ width: 28 }} />}
              {renderExpanded && <th className="border-b border-edge p-0" style={{ width: 32 }} />}
              {visibleColumns.map((c) => {
                const active = sort.key === c.key;
                return (
                  <th
                    key={c.key}
                    style={c.width ? { width: c.width } : undefined}
                    className={`border-b border-edge p-0 whitespace-nowrap ${c.align === "right" ? "text-right" : "text-left"}`}
                  >
                    {c.sortable === false ? (
                      <span className="block px-3 py-2.5 text-[11px] font-medium uppercase tracking-wide text-dim">{c.title}</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => toggleSort(c.key)}
                        className={`group flex w-full items-center gap-1 border-0 px-3 py-2.5 text-[11px] font-medium uppercase tracking-wide transition-colors duration-150 hover:text-ink ${c.align === "right" ? "justify-end" : ""} ${active ? "text-ink" : "text-dim"}`}
                      >
                        <span>{c.title}</span>
                        <span
                          className={`inline-block text-[9px] transition-opacity duration-150 ${active ? "opacity-100" : "opacity-0 group-hover:opacity-30"}`}
                          style={{ transform: active && sort.dir === -1 ? "rotate(180deg)" : "rotate(0deg)" }}
                        >
                          ▲
                        </span>
                      </button>
                    )}
                  </th>
                );
              })}
            </tr>
            <tr>
              {reorder && <th className="border-b border-edge px-2 pb-2" />}
              {renderExpanded && <th className="border-b border-edge px-2 pb-2" />}
              {visibleColumns.map((c) => (
                <th key={c.key} className="border-b border-edge px-2 pb-2">
                  {c.filter === "text" && (
                    <input
                      type="text"
                      placeholder="Filter…"
                      value={filters[c.key] ?? ""}
                      onChange={(e) => setFilter(c.key, e.target.value)}
                      className="w-full appearance-none rounded border-0 border-b border-transparent bg-transparent px-1 py-1 text-xs text-ink shadow-none outline-none placeholder:text-dim/70 transition-colors duration-150 hover:bg-panel-alt focus:border-b-ink/30 focus:bg-panel-alt focus:outline-none"
                    />
                  )}
                  {c.filter === "select" && (
                    <Dropdown
                      value={filters[c.key] ?? ""}
                      onChange={(v) => setFilter(c.key, v)}
                      options={(selectOptions[c.key] ?? []).map((v) => ({ value: v, label: v }))}
                      className="w-full"
                    />
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageRows.length ? (
              pageRows.map((row, i) => {
                const absIndex = start + i;
                return (
                  <TableRow
                    key={row.id ?? row.symbol ?? i}
                    row={row}
                    columns={visibleColumns}
                    onRowClick={onRowClick}
                    renderExpanded={renderExpanded}
                    expanded={expandedIds.has(row.id ?? row.symbol)}
                    onToggleExpand={toggleExpand}
                    reorder={reorder}
                    canMoveUp={customOrderActive && absIndex > 0}
                    canMoveDown={customOrderActive && absIndex < sorted.length - 1}
                    onMoveUp={() => moveRow(absIndex, -1)}
                    onMoveDown={() => moveRow(absIndex, 1)}
                  />
                );
              })
            ) : (
              <tr>
                <td colSpan={visibleColumns.length + (renderExpanded ? 1 : 0) + (reorder ? 1 : 0)} className="px-5 py-14 text-center text-dim">
                  <div className="flex flex-col items-center gap-2">
                    <span className="text-2xl opacity-40">∅</span>
                    <span>{emptyText}</span>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between border-t border-edge px-3.5 py-2.5 text-xs text-dim">
        <div className="flex items-center gap-3">
          <span>{data.length ? `${sorted.length} of ${data.length}` : ""}</span>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={clampedPage <= 1}
            onClick={() => setPage((p) => p - 1)}
            className="h-6 w-6 rounded border-0 text-ink transition-colors duration-150 disabled:opacity-30 enabled:hover:bg-panel-alt"
          >
            ‹
          </button>
          <span className="tabular-nums">{clampedPage} / {totalPages}</span>
          <button
            type="button"
            disabled={clampedPage >= totalPages}
            onClick={() => setPage((p) => p + 1)}
            className="h-6 w-6 rounded border-0 text-ink transition-colors duration-150 disabled:opacity-30 enabled:hover:bg-panel-alt"
          >
            ›
          </button>
          <Dropdown
            value={pageSize}
            onChange={(v) => {
              setPageSize(Number(v));
              setPage(1);
            }}
            options={[10, 20, 50, 100].map((n) => ({ value: n, label: `${n} / page` }))}
            clearable={false}
            className="w-24"
          />
        </div>
      </div>
    </div>
  );
}
