import { useMemo } from "react";
import DataTable from "./DataTable.jsx";
import { useSetupFinder } from "../hooks/useSetupFinder.js";
import { useMarketBias } from "../hooks/useMarketBias.js";
import { useLivePrices } from "../hooks/useLivePrices.js";
import { attachEntry } from "../lib/analysis/mtfSetup.js";
import { buildScanColumns, renderScanDetails } from "../lib/scanColumns.jsx";

// Shares the setup-finder query (same queryKey/limit) with MarketPanel, so
// opening the watchlist doesn't trigger a second scan — it just re-filters
// whatever the scan already fetched. Also shares the market-bias query the
// same way, and applies the identical attachEntry() join so a watched
// symbol's Entry/Weekly/Daily columns match what the Market tab would show.
export default function WatchlistPanel({ watchlist, onSelectSymbol }) {
  const { data, isLoading, isFetching, error } = useSetupFinder(100);
  const { data: bias } = useMarketBias(100);

  const scanBySymbol = useMemo(() => {
    const map = new Map();
    for (const row of data ?? []) map.set(row.symbol, attachEntry(row, bias?.get(row.symbol)));
    return map;
  }, [data, bias]);

  // Watched symbols outside the top-volume scan (too low-volume to make the
  // cut) still belong here — a star means "I'm tracking this", not "this is
  // in the scan". They just don't have scan-derived stats (entry/trend/R:R/
  // etc.), so those columns fall back to "—" and only price is live for them.
  const unscanned = useMemo(
    () => watchlist.symbols.filter((symbol) => !scanBySymbol.has(symbol)),
    [watchlist.symbols, scanBySymbol]
  );

  const { data: unscannedPrices, isLoading: pricesLoading } = useLivePrices(unscanned);

  // Follows watchlist.symbols order directly (rather than grouping scanned
  // symbols before unscanned ones) so the manual reorder buttons below can
  // freely move any row, including across the scanned/unscanned boundary,
  // without the render recombining rows back into two blocks.
  const rows = useMemo(() => {
    return watchlist.symbols.map(
      (symbol) => scanBySymbol.get(symbol) ?? { symbol, current: unscannedPrices?.get(symbol) ?? null }
    );
  }, [watchlist.symbols, scanBySymbol, unscannedPrices]);

  const columns = useMemo(() => buildScanColumns(watchlist), [watchlist]);

  const handleReorder = (newRows) => watchlist.setOrder(newRows.map((r) => r.symbol));

  return (
    <div className="rounded-card border border-edge bg-panel shadow-card">
      <div className="flex items-center justify-between border-b border-edge px-5 py-3.5">
        <div>
          <h2 className="text-[14px] font-semibold">Watchlist</h2>
          <p className="text-[11px] text-dim">Coins you've starred from the Market or analysis page.</p>
        </div>
        {isFetching && !isLoading && <span className="text-[12px] text-dim">Refreshing…</span>}
      </div>

      {error && <p className="p-5 text-[13px] text-position-short">Scan failed: {error.message}</p>}

      {!error && watchlist.symbols.length === 0 && (
        <p className="p-5 text-[13px] text-dim">
          Nothing watched yet — star a coin from the Market table or the analysis page to add it here.
        </p>
      )}

      {/* Rows fall back to a bare (price-only, dashes-for-stats) shape for any
          watched symbol the scan hasn't matched yet (see the `rows` comment
          above), so without this gate the table would render immediately
          with every row looking dataless during the first scan instead of
          showing that a scan is actually in progress. */}
      {!error && watchlist.symbols.length > 0 && isLoading && (
        <p className="p-5 text-[13px] text-dim">Scanning the market…</p>
      )}

      {!error && watchlist.symbols.length > 0 && !isLoading && (
        <DataTable
          columns={columns}
          data={rows}
          emptyText={pricesLoading ? "Loading watched pairs…" : "No watched pairs"}
          onRowClick={(row) => onSelectSymbol?.(row.symbol)}
          pageSize={20}
          exportFilename={`watchlist-${new Date().toISOString().slice(0, 10)}.csv`}
          renderExpanded={renderScanDetails}
          onReorder={handleReorder}
          stateKey="watchlist"
        />
      )}
    </div>
  );
}
