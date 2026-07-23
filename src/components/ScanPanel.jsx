import { useMemo } from "react";
import DataTable from "./DataTable.jsx";
import { useSetupFinder } from "../hooks/useSetupFinder.js";
import { buildScanColumns } from "../lib/scanColumns.jsx";

// 4H swing scan: every top-volume pair's current 4H structure, neutrally —
// no ranking or shortlist by score (see the backtest note on analyzeCandles'
// `score` in ta.js for why). Every column here is chosen for that horizon
// specifically — trend/EMA context to size up structure, RSI/z-score for
// momentum vs. mean-reversion entries, one volume indicator (relative
// volume — participation vs. this symbol's own baseline, not a second cut of
// the same thing), and ATR% to size a stop. Click a row to open the full
// chart/analysis view.
export default function ScanPanel({ onSelectSymbol, watchlist }) {
  const { data, isLoading, isFetching, error } = useSetupFinder(100);

  const rows = useMemo(() => data ?? [], [data]);
  const columns = useMemo(() => buildScanColumns(watchlist), [watchlist]);

  return (
    <div className="rounded-card border border-edge bg-panel shadow-card">
      <div className="flex items-center justify-between border-b border-edge px-5 py-3.5">
        <div>
          <h2 className="text-[14px] font-semibold">4H swing scan</h2>
          <p className="text-[11px] text-dim">Top-volume pairs — 4H structure, size your own risk.</p>
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
          initialSort={{ key: "trendPct", dir: -1 }}
          exportFilename={`4h-swing-scan-${new Date().toISOString().slice(0, 10)}.csv`}
        />
      )}
    </div>
  );
}
