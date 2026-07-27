import { useMemo } from "react";
import DataTable from "./DataTable.jsx";
import { useLongTermPicks } from "../hooks/useLongTermPicks.js";
import { buildLongTermColumns, renderLongTermDetails } from "../lib/longTermColumns.jsx";

// Position-trade candidates for holds of a month or longer — Weekly+Daily
// trend agreement (not 4H timing), beating BTC on alpha, not already
// extended. See useLongTermPicks.js for the exact filter/caveats. Long-only:
// OKX spot has no short mechanism worth building a hold recommendation
// around (this replaced the old beta-neutral Hedged tab, which relied on
// perp shorts to hedge — see betaNeutral.js/scripts/backtest-beta-neutral.js
// for that prior approach, kept for reference but no longer surfaced in the UI).
//
// NOT WIRED INTO App.jsx — retired from the UI the same way, for the same
// reason: scripts/backtest-long-term-holds.js walked this exact filter
// forward (30-day hold, 3.42 years, 25 symbols) and found it net-negative —
// 32.6% pick-level hit rate vs BTC (real edge would clear ~50%) and -4.45%
// mean alpha achieved per pick. The trailing alpha this screens on doesn't
// persist forward; it looks mean-reverting, not momentum-persistent. Kept
// for reference, not deleted.
export default function LongTermPanel({ onSelectSymbol, watchlist }) {
  const { data, isLoading, isFetching, error } = useLongTermPicks();
  const rows = data ?? [];
  const columns = useMemo(() => buildLongTermColumns(watchlist), [watchlist]);

  return (
    <div className="rounded-card border border-edge bg-panel shadow-card">
      <div className="flex items-center justify-between border-b border-edge px-5 py-3.5">
        <div>
          <h2 className="text-[14px] font-semibold">Long-term holds — 1 month+ horizon</h2>
          <p className="text-[11px] text-dim">
            Weekly bias + Daily trend both bullish, beating BTC on alpha, not already extended. Long-only, rules-based screen — not a backtested edge.
          </p>
        </div>
        {isFetching && <span className="text-[12px] text-dim">Scanning…</span>}
      </div>

      {error && <p className="p-5 text-[13px] text-position-short">Scan failed: {error.message}</p>}

      {!error && (
        <DataTable
          columns={columns}
          data={rows}
          emptyText={isLoading ? "Scanning the market…" : "No candidates clear the bar right now"}
          onRowClick={(row) => onSelectSymbol?.(row.symbol)}
          pageSize={20}
          initialSort={{ key: "alpha", dir: -1 }}
          exportFilename={`long-term-picks-${new Date().toISOString().slice(0, 10)}.csv`}
          renderExpanded={renderLongTermDetails}
        />
      )}
    </div>
  );
}
