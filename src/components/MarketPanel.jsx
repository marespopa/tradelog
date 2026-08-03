import { useMemo } from "react";
import DataTable from "./DataTable.jsx";
import RotatingLoadingText from "./RotatingLoadingText.jsx";
import { useSetupFinder } from "../hooks/useSetupFinder.js";
import { useMarketBias } from "../hooks/useMarketBias.js";
import { attachEntry } from "../lib/analysis/mtfSetup.js";
import { buildScanColumns } from "../lib/scanColumns.jsx";

// The full top-volume universe, unfiltered, trimmed to what a buy-and-hold
// investor cares about rather than a trader's setup signals. Shares
// useSetupFinder/useMarketBias's queryKey with WatchlistPanel (same limit),
// so opening this tab doesn't trigger a second scan — it just renders the
// same cached rows.
export default function MarketPanel({ onSelectSymbol, watchlist }) {
  const { data, isLoading, isFetching, error } = useSetupFinder(100);
  const { data: bias } = useMarketBias(100);

  const rows = useMemo(() => (data ?? []).map((row) => attachEntry(row, bias?.get(row.symbol))), [data, bias]);
  // Trimmed to Symbol/Price/24h%/1w% — the two horizons that matter for a
  // long-term view. Entry/R:R/Trend/short-horizon-%/fair-value are all
  // active-trading-signal columns, and relativeVolume/zScore (previously
  // force-shown here) are momentum/mean-reversion stats, not buy-and-hold
  // relevant, so they're left hidden rather than shown.
  const columns = useMemo(
    () =>
      buildScanColumns(watchlist, {
        excludeKeys: ["entry", "rr", "trendRead", "changePct15m", "changePct1h", "changePct4h", "fairValue"],
      }),
    [watchlist]
  );

  return (
    <div className="rounded-card border border-edge bg-panel shadow-card">
      <div className="flex items-center justify-between border-b border-edge px-5 py-3.5">
        <div>
          <h2 className="text-[14px] font-semibold">Market</h2>
          <p className="text-[11px] text-dim">Price and recent performance across every scanned coin.</p>
        </div>
        {isFetching && <span className="text-[12px] text-dim">Scanning…</span>}
      </div>

      {error && <p className="p-5 text-[13px] text-position-short">Scan failed: {error.message}</p>}

      {!error && (
        <DataTable
          columns={columns}
          data={rows}
          emptyText={isLoading ? <RotatingLoadingText /> : "No pairs found"}
          onRowClick={(row) => onSelectSymbol?.(row.symbol)}
          pageSize={20}
          initialSort={{ key: "changePct24h", dir: -1 }}
          exportFilename={`market-${new Date().toISOString().slice(0, 10)}.csv`}
          stateKey="market"
        />
      )}
    </div>
  );
}
