import WatchButton from "../components/WatchButton.jsx";
import { fmt } from "./format.jsx";

function vs200Ema(row) {
  const ema200 = row.factors?.trend?.ema200;
  if (ema200 == null || !row.current) return null;
  return ((row.current - ema200) / ema200) * 100;
}

function PctBadge({ value }) {
  if (value == null) return "—";
  return (
    <span className={value >= 0 ? "text-position-long" : "text-position-short"}>
      {value >= 0 ? "+" : ""}
      {value.toFixed(1)}%
    </span>
  );
}

// Mean-reversion framing (matches the meanReversion factor in ta.js): a
// stretched-negative z-score means price has fallen well below its rolling
// mean — a reversion-upward ("buy zone") read, not a trend one. Stretched
// positive is the mirror ("sell zone"). |z| < 2 is unremarkable — most of
// the distribution — so it's left neutral rather than colored either way.
function ZScoreBadge({ value }) {
  if (value == null) return "—";
  const extreme = Math.abs(value) >= 2;
  const className = extreme ? (value < 0 ? "text-position-long" : "text-position-short") : "text-dim";
  return <span className={className}>{value.toFixed(2)}</span>;
}

// Shared by the scan table and the watchlist table (both show the same 4H
// swing-scan shape) so the two views can't drift out of sync. `watchlist`
// is the useWatchlist() instance so a star column can be prepended.
export function buildScanColumns(watchlist) {
  const columns = [
    { key: "symbol", title: "Symbol", filter: "text" },
    {
      key: "trend",
      title: "Trend",
      filter: "select",
      filterValue: (r) => r.trend,
      formatter: (r) => (
        <span className={r.trend === "bullish" ? "text-position-long" : r.trend === "bearish" ? "text-position-short" : "text-dim"}>{r.trend}</span>
      ),
    },
    { key: "current", title: "Price", align: "right", sortValue: (r) => r.current ?? 0, formatter: (r) => fmt(r.current) },
    {
      key: "trendPct",
      title: "Trend %",
      align: "right",
      sortValue: (r) => r.factors?.trend?.separationPct ?? 0,
      formatter: (r) => <PctBadge value={r.factors?.trend?.separationPct} />,
    },
    {
      key: "vs200Ema",
      title: "vs 200EMA",
      align: "right",
      sortValue: (r) => vs200Ema(r) ?? 0,
      formatter: (r) => <PctBadge value={vs200Ema(r)} />,
    },
    {
      key: "changePct24h",
      title: "24h",
      align: "right",
      sortValue: (r) => r.changePct24h ?? 0,
      formatter: (r) => <PctBadge value={r.changePct24h} />,
    },
    { key: "rsiValue", title: "RSI", align: "right", sortValue: (r) => r.rsiValue ?? 0, formatter: (r) => (r.rsiValue != null ? r.rsiValue.toFixed(0) : "—") },
    { key: "zScore", title: "Z-score", align: "right", sortValue: (r) => r.zScore ?? 0, formatter: (r) => <ZScoreBadge value={r.zScore} /> },
    { key: "relativeVolume", title: "Rel. Vol", align: "right", sortValue: (r) => r.relativeVolume ?? 0, formatter: (r) => (r.relativeVolume != null ? `${r.relativeVolume.toFixed(2)}×` : "—") },
    { key: "atrPct", title: "ATR%", align: "right", sortValue: (r) => r.atrPct ?? 0, formatter: (r) => (r.atrPct != null ? `${r.atrPct.toFixed(2)}%` : "—") },
  ];

  if (watchlist) {
    columns.unshift({
      key: "watch",
      title: "",
      width: 32,
      sortable: false,
      formatter: (r) => <WatchButton active={watchlist.has(r.symbol)} onToggle={() => watchlist.toggle(r.symbol)} />,
    });
  }

  return columns;
}
