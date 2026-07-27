import WatchButton from "../components/WatchButton.jsx";
import { tfClass, tfArrow } from "./scanColumns.jsx";
import { fmt } from "./format.js";

// Combined Weekly+Daily trend badge — same shape as scanColumns.jsx's
// multi-timeframe badge, just without the 4H tier this table doesn't have.
function TrendBadge({ weekly, daily }) {
  return (
    <span className="flex items-center gap-2.5 text-[12px] font-medium">
      <span className={tfClass(weekly)}>W {tfArrow(weekly)}</span>
      <span className={tfClass(daily)}>D {tfArrow(daily)}</span>
    </span>
  );
}

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
// scanColumns.jsx (tfClass/tfArrow, watch-star unshift) so this reads as the
// same family of table rather than a one-off. Alpha (vs BTC, daily-bar window)
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
      key: "trend",
      title: "Trend (W/D)",
      sortable: false,
      csvValue: (r) => `W:${r.weeklyBias ?? "–"} D:${r.dailyTrend ?? "–"}`,
      formatter: (r) => <TrendBadge weekly={r.weeklyBias} daily={r.dailyTrend} />,
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
    // Hidden from the table itself (shown in the expanded row instead) —
    // see renderLongTermDetails below.
    { key: "rsi", title: "RSI", hidden: true, sortValue: (r) => r.rsi ?? 0, formatter: (r) => (r.rsi != null ? r.rsi.toFixed(0) : "—") },
    {
      key: "channelPct",
      title: "Channel pos.",
      hidden: true,
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

// Secondary stats hidden from the collapsed row: momentum (RSI) and where
// price sits in its recent range (channel position).
export function renderLongTermDetails(row) {
  const items = [
    { label: "RSI", value: row.rsi != null ? row.rsi.toFixed(0) : "—" },
    { label: "Channel pos.", value: row.channelPct != null ? `${(row.channelPct * 100).toFixed(0)}%` : "—" },
  ];
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-2.5 sm:grid-cols-4">
      {items.map((it) => (
        <div key={it.label}>
          <dt className="text-[10px] font-medium uppercase tracking-wide text-dim">{it.label}</dt>
          <dd className="mt-0.5 text-[13px] text-ink">{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}
