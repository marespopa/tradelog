import { useMemo } from "react";
import DataTable from "./DataTable.jsx";
import WatchButton from "./WatchButton.jsx";
import { useSetupFinder } from "../hooks/useSetupFinder.js";
import { buildScanColumns } from "../lib/scanColumns.jsx";

// Shares the setup-finder query (same queryKey/limit) with ScanPanel, so
// opening the watchlist doesn't trigger a second scan — it just re-filters
// whatever the scan already fetched.
export default function WatchlistPanel({ watchlist, onSelectSymbol }) {
  const { data, isLoading, isFetching, error } = useSetupFinder(100);

  const scanBySymbol = useMemo(() => {
    const map = new Map();
    for (const row of data ?? []) map.set(row.symbol, row);
    return map;
  }, [data]);

  const rows = useMemo(
    () => watchlist.symbols.map((symbol) => scanBySymbol.get(symbol)).filter(Boolean),
    [watchlist.symbols, scanBySymbol]
  );

  const unscanned = useMemo(
    () => watchlist.symbols.filter((symbol) => !scanBySymbol.has(symbol)),
    [watchlist.symbols, scanBySymbol]
  );

  const columns = useMemo(() => buildScanColumns(watchlist), [watchlist]);

  return (
    <div className="rounded-card border border-edge bg-panel shadow-card">
      <div className="flex items-center justify-between border-b border-edge px-5 py-3.5">
        <div>
          <h2 className="text-[14px] font-semibold">Watchlist</h2>
          <p className="text-[11px] text-dim">Coins you've starred from the scan or analysis page.</p>
        </div>
        {isFetching && <span className="text-[12px] text-dim">Refreshing…</span>}
      </div>

      {error && <p className="p-5 text-[13px] text-position-short">Scan failed: {error.message}</p>}

      {!error && watchlist.symbols.length === 0 && (
        <p className="p-5 text-[13px] text-dim">
          Nothing watched yet — star a coin from the scan table or the analysis page to add it here.
        </p>
      )}

      {!error && watchlist.symbols.length > 0 && (
        <>
          <DataTable
            columns={columns}
            data={rows}
            emptyText={isLoading ? "Loading watched pairs…" : "None of your watched pairs are in the current scan"}
            onRowClick={(row) => onSelectSymbol?.(row.symbol)}
            pageSize={20}
            initialSort={{ key: "trendPct", dir: -1 }}
            exportFilename={`watchlist-${new Date().toISOString().slice(0, 10)}.csv`}
          />

          {unscanned.length > 0 && (
            <div className="border-t border-edge/70 px-5 py-3 text-[12px] text-dim">
              <p className="mb-2">Watched but outside the top-volume scan:</p>
              <div className="flex flex-wrap gap-2">
                {unscanned.map((symbol) => (
                  <button
                    key={symbol}
                    type="button"
                    onClick={() => onSelectSymbol?.(symbol)}
                    className="flex items-center gap-1.5 rounded-full border border-edge bg-panel-alt px-2.5 py-1 text-ink transition-colors duration-150 hover:bg-panel-raised"
                  >
                    <WatchButton active onToggle={() => watchlist.toggle(symbol)} />
                    {symbol}
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
