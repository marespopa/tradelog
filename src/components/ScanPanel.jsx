import { useMemo } from "react";
import DataTable from "./DataTable.jsx";
import { useSetupFinder } from "../hooks/useSetupFinder.js";
import { useMarketBias } from "../hooks/useMarketBias.js";
import { attachEntry } from "../lib/analysis/mtfSetup.js";
import { buildScanColumns } from "../lib/scanColumns.jsx";

// Weekly bias -> Daily trend -> 4H trigger swing scan. useSetupFinder does
// the fast-cadence 4H work (per-symbol trend/momentum/mean-reversion stats
// plus a direction-agnostic 4H trigger check); useMarketBias does the
// slow-cadence Weekly/Daily bias read. attachEntry() joins the two by symbol
// and only lights up "Entry" when all three tiers agree — everything else
// stays neutral context (see the backtest note in mtfSetup.js/ta.js for why
// this app doesn't paint every stat as if it were a signal). This tab shows
// only the rows that cleared that 3-tier bar ("good" setups) — the full
// unfiltered universe lives on the Market tab, sharing the same underlying
// query so there's no double scan. Click a row to open the full chart/
// analysis view.
export default function ScanPanel({ onSelectSymbol, watchlist }) {
  const { data, isLoading, isFetching, error } = useSetupFinder(100);
  const { data: bias } = useMarketBias(100);

  const rows = useMemo(
    () => (data ?? []).map((row) => attachEntry(row, bias?.get(row.symbol))).filter((row) => row.mtfTrade != null),
    [data, bias]
  );
  const columns = useMemo(() => buildScanColumns(watchlist), [watchlist]);

  return (
    <div className="rounded-card border border-edge bg-panel shadow-card">
      <div className="flex items-center justify-between border-b border-edge px-5 py-3.5">
        <div>
          <h2 className="text-[14px] font-semibold">Swing scan — Weekly bias, Daily trend, 4H entry</h2>
          <p className="text-[11px] text-dim">Only pairs where Weekly bias, Daily trend, and the 4H trigger all agree — see Market for everything else.</p>
        </div>
        {isFetching && <span className="text-[12px] text-dim">Scanning…</span>}
      </div>

      {error && <p className="p-5 text-[13px] text-position-short">Scan failed: {error.message}</p>}

      {!error && (
        <DataTable
          columns={columns}
          data={rows}
          emptyText={isLoading ? "Scanning the market…" : "No pairs currently have a 3-tier setup — check Market for the full list"}
          onRowClick={(row) => onSelectSymbol?.(row.symbol)}
          pageSize={20}
          initialSort={{ key: "entry", dir: -1 }}
          exportFilename={`mtf-swing-scan-${new Date().toISOString().slice(0, 10)}.csv`}
        />
      )}
    </div>
  );
}
