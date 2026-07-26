import WatchButton from "../components/WatchButton.jsx";
import { BiasBadge } from "./scanColumns.jsx";
import { fmt } from "./format.js";

function AlphaBadge({ value }) {
  if (value == null) return "—";
  return (
    <span className={value >= 0 ? "text-position-long" : "text-position-short"}>
      {value >= 0 ? "+" : ""}
      {(value * 100).toFixed(1)}%
    </span>
  );
}

// Long-term hold candidate table — same badge/column conventions as
// scanColumns.jsx (BiasBadge, watch-star unshift) so this reads as the same
// family of table rather than a one-off. Alpha (vs BTC, daily-bar window)
// is the primary sort key since it's the "why this instead of just holding
// BTC" number; Weekly/Daily are shown for trust even though every row here
// already has both bullish (that's the filter in useLongTermPicks).
export function buildLongTermColumns(watchlist) {
  const columns = [
    { key: "symbol", title: "Symbol", filter: "text" },
    {
      key: "alpha",
      title: "Alpha vs BTC",
      align: "right",
      sortValue: (r) => r.alpha ?? 0,
      formatter: (r) => <AlphaBadge value={r.alpha} />,
    },
    {
      key: "weeklyBias",
      title: "Weekly",
      filter: "select",
      filterValue: (r) => r.weeklyBias ?? "—",
      sortValue: (r) => r.weeklyBias ?? "",
      formatter: (r) => <BiasBadge value={r.weeklyBias} />,
    },
    {
      key: "dailyTrend",
      title: "Daily",
      filter: "select",
      filterValue: (r) => r.dailyTrend ?? "—",
      sortValue: (r) => r.dailyTrend ?? "",
      formatter: (r) => <BiasBadge value={r.dailyTrend} />,
    },
    { key: "price", title: "Price", align: "right", sortValue: (r) => r.price ?? 0, formatter: (r) => fmt(r.price) },
    {
      key: "changePct24h",
      title: "24h",
      align: "right",
      sortValue: (r) => r.changePct24h ?? 0,
      formatter: (r) =>
        r.changePct24h == null ? "—" : (
          <span className={r.changePct24h >= 0 ? "text-position-long" : "text-position-short"}>
            {r.changePct24h >= 0 ? "+" : ""}
            {r.changePct24h.toFixed(1)}%
          </span>
        ),
    },
    { key: "rsi", title: "RSI", align: "right", sortValue: (r) => r.rsi ?? 0, formatter: (r) => (r.rsi != null ? r.rsi.toFixed(0) : "—") },
    {
      key: "channelPct",
      title: "Channel pos.",
      align: "right",
      sortValue: (r) => r.channelPct ?? 0,
      formatter: (r) => (r.channelPct != null ? `${(r.channelPct * 100).toFixed(0)}%` : "—"),
    },
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
