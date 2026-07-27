import { useMemo } from "react";
import DataTable from "./DataTable.jsx";
import { useSetupFinder } from "../hooks/useSetupFinder.js";
import { useMarketBias } from "../hooks/useMarketBias.js";
import { attachEntry } from "../lib/analysis/mtfSetup.js";
import { buildScanColumns, renderScanDetails } from "../lib/scanColumns.jsx";

// The full top-volume universe, unfiltered. Shares useSetupFinder/
// useMarketBias's queryKey with WatchlistPanel (same limit), so opening
// this tab doesn't trigger a second scan — it just renders the same cached
// rows.
export default function MarketPanel({ onSelectSymbol, watchlist }) {
  const { data, isLoading, isFetching, error } = useSetupFinder(100);
  const { data: bias } = useMarketBias(100);

  const rows = useMemo(() => (data ?? []).map((row) => attachEntry(row, bias?.get(row.symbol))), [data, bias]);
  // Entry/R:R (the 3-tier swing-setup signal) are excluded — almost nothing
  // in the full unfiltered universe has an mtfTrade set, so the columns are
  // just noise here. Rel. Vol is surfaced back into the main row (hidden by
  // default otherwise) since spotting volume spikes across the whole
  // universe is exactly what this tab is for.
  const columns = useMemo(
    () => buildScanColumns(watchlist, { excludeKeys: ["entry", "rr"], showKeys: ["relativeVolume"] }),
    [watchlist]
  );

  return (
    <div className="rounded-card border border-edge bg-panel shadow-card">
      <div className="flex items-center justify-between border-b border-edge px-5 py-3.5">
        <div>
          <h2 className="text-[14px] font-semibold">Market — all top-volume pairs</h2>
          <p className="text-[11px] text-dim">Every scanned coin, unfiltered.</p>
        </div>
        {isFetching && <span className="text-[12px] text-dim">Scanning…</span>}
      </div>

      {error && <p className="p-5 text-[13px] text-position-short">Scan failed: {error.message}</p>}

      {!error && (
        <DataTable
          columns={columns}
          data={rows}
          emptyText={isLoading ? "Scanning the market…" : "No pairs found"}
          onRowClick={(row) => onSelectSymbol?.(row.symbol)}
          pageSize={20}
          initialSort={{ key: "changePct24h", dir: -1 }}
          exportFilename={`market-${new Date().toISOString().slice(0, 10)}.csv`}
          renderExpanded={renderScanDetails}
        />
      )}
    </div>
  );
}
