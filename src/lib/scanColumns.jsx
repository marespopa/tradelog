import WatchButton from "../components/WatchButton.jsx";
import AlarmCell from "../components/AlarmCell.jsx";
import { fmt } from "./format.js";

function vs200Ema(row) {
  const ema200 = row.factors?.trend?.ema200;
  if (ema200 == null || !row.current) return null;
  return ((row.current - ema200) / ema200) * 100;
}

function vsFairValue(row) {
  if (row.fairValue == null || !row.current) return null;
  return ((row.current - row.fairValue) / row.fairValue) * 100;
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

// Exported for reuse by longTermColumns.jsx's combined Weekly/Daily badge.
export function tfClass(bias) {
  return bias === "bullish" ? "text-position-long" : bias === "bearish" ? "text-position-short" : "text-dim";
}

const TREND_LABELS = { bullish: "Bullish", bearish: "Bearish", sideways: "Sideways" };

// Combined 4H+Daily+Weekly read (see mtfSetup.js's overallTrend) as one
// plain-English label instead of making the reader cross-reference the
// three separate per-timeframe badges below to figure out whether they
// actually agree.
function OverallTrendBadge({ trend }) {
  if (trend == null) return "—";
  return <span className={`font-medium ${tfClass(trend)}`}>{TREND_LABELS[trend]}</span>;
}

// The live 3-tier entry: only set when Weekly bias, Daily trend, and the 4H
// trigger all agree (see attachEntry's merge of useSetupFinder + useMarketBias).
// Distinct from the raw per-timeframe badges above — this is the actual
// "good entry" highlight, not just another stat.
function EntryBadge({ trade }) {
  if (!trade) return <span className="text-dim">—</span>;
  const dirClass = trade.direction === "long" ? "text-position-long" : "text-position-short";
  return (
    <span className={`font-medium ${dirClass}`}>
      {trade.direction} · {trade.trigger}
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

// % distance between current price and fairValue (the same 20-period
// rolling mean the z-score column measures against) — same contrarian
// color convention as ZScoreBadge, deliberately the opposite of PctBadge's
// trend-following green-up/red-down: price sitting *above* fair value is a
// reversion-risk read (colored like a short bias), not a bullish one.
function FairValueBadge({ value }) {
  if (value == null) return "—";
  return (
    <span className={value >= 0 ? "text-position-short" : "text-position-long"}>
      {value >= 0 ? "+" : ""}
      {value.toFixed(1)}%
    </span>
  );
}

// Shared by the scan table and the watchlist table (both show the same
// Weekly->Daily->4H swing-scan shape) so the two views can't drift out of
// sync. `watchlist` is the useWatchlist() instance so a star column can be
// prepended. Rows are expected to carry weeklyBias/dailyTrend/mtfTrade
// (attached by attachEntry's merge of useSetupFinder + useMarketBias) in
// addition to the raw per-4H-candle stats from analyzeCandles().
export function buildScanColumns(watchlist, { excludeKeys = [], showKeys = [], alarms } = {}) {
  const columns = [
    { key: "symbol", title: "Symbol", filter: "text" },
    {
      key: "entry",
      title: "Entry",
      sortValue: (r) => (r.mtfTrade ? 1 : 0),
      formatter: (r) => <EntryBadge trade={r.mtfTrade} />,
    },
    {
      key: "rr",
      title: "R:R",
      align: "right",
      sortValue: (r) => r.mtfTrade?.rr ?? 0,
      formatter: (r) => (r.mtfTrade ? `1:${r.mtfTrade.rr}` : "—"),
    },
    {
      key: "trendRead",
      title: "Trend",
      filter: "select",
      filterValue: (r) => TREND_LABELS[r.trendRead] ?? "—",
      sortValue: (r) => (r.trendRead === "bullish" ? 1 : r.trendRead === "bearish" ? -1 : 0),
      csvValue: (r) => TREND_LABELS[r.trendRead] ?? "—",
      formatter: (r) => <OverallTrendBadge trend={r.trendRead} />,
    },
    { key: "current", title: "Price", align: "right", sortValue: (r) => r.current ?? 0, formatter: (r) => fmt(r.current) },
    // Growth split per timeframe (each independently sortable) instead of a
    // single 24h figure. Each cell is colored only by its own sign (green
    // up / red down, via PctBadge) — a per-cell trend arrow/tint used to
    // ride along too, but that colored a coin up 15% in a "bearish" EMA
    // trend as red, which read as a bug. See the combined Trend column
    // above for the actual multi-timeframe direction read.
    {
      key: "changePct15m",
      title: "15m",
      align: "right",
      sortValue: (r) => r.changePct15m ?? 0,
      formatter: (r) => <PctBadge value={r.changePct15m} />,
    },
    {
      key: "changePct1h",
      title: "1h",
      align: "right",
      sortValue: (r) => r.changePct1h ?? 0,
      formatter: (r) => <PctBadge value={r.changePct1h} />,
    },
    {
      key: "changePct4h",
      title: "4h",
      align: "right",
      sortValue: (r) => r.changePct4h ?? 0,
      formatter: (r) => <PctBadge value={r.changePct4h} />,
    },
    {
      key: "changePct24h",
      title: "1d",
      align: "right",
      sortValue: (r) => r.changePct24h ?? 0,
      formatter: (r) => <PctBadge value={r.changePct24h} />,
    },
    {
      key: "changePct1w",
      title: "1w",
      align: "right",
      sortValue: (r) => r.changePct1w ?? 0,
      formatter: (r) => <PctBadge value={r.changePct1w} />,
    },
    // 4H fair-value gap — kept visible (not folded into the expanded row
    // with the other secondary stats below) since it's the most-watched
    // number on the Market tab.
    {
      key: "fairValue",
      title: "vs Fair Value",
      align: "right",
      sortValue: (r) => vsFairValue(r) ?? 0,
      formatter: (r) => <FairValueBadge value={vsFairValue(r)} />,
    },
    // Hidden from the table itself (shown in the expanded row instead) so
    // the collapsed table stays scannable — see renderScanDetails below.
    {
      key: "vs200Ema",
      title: "vs 200EMA",
      hidden: true,
      sortValue: (r) => vs200Ema(r) ?? 0,
      formatter: (r) => <PctBadge value={vs200Ema(r)} />,
    },
    { key: "rsiValue", title: "RSI", hidden: true, sortValue: (r) => r.rsiValue ?? 0, formatter: (r) => (r.rsiValue != null ? r.rsiValue.toFixed(0) : "—") },
    { key: "zScore", title: "Z-score", hidden: true, sortValue: (r) => r.zScore ?? 0, formatter: (r) => <ZScoreBadge value={r.zScore} /> },
    { key: "relativeVolume", title: "Rel. Vol", hidden: true, sortValue: (r) => r.relativeVolume ?? 0, formatter: (r) => (r.relativeVolume != null ? `${r.relativeVolume.toFixed(2)}×` : "—") },
    { key: "atrPct", title: "ATR%", hidden: true, sortValue: (r) => r.atrPct ?? 0, formatter: (r) => (r.atrPct != null ? `${r.atrPct.toFixed(2)}%` : "—") },
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

  // Only passed by the Watchlist tab (see WatchlistPanel.jsx) -- alarms are
  // a watchlist-only concept, so MarketPanel's call (no `alarms` option)
  // never gets this column.
  if (alarms) {
    columns.push({
      key: "alarm",
      title: "Alarm",
      sortable: false,
      formatter: (r) => (
        <AlarmCell
          symbol={r.symbol}
          alarm={alarms.alarms[r.symbol]}
          currentPrice={r.current}
          onSet={alarms.set}
          onClear={alarms.remove}
        />
      ),
    });
  }

  return columns
    .map((c) => (showKeys.includes(c.key) ? { ...c, hidden: false } : c))
    .filter((c) => !excludeKeys.includes(c.key));
}

// Secondary stats hidden from the collapsed row: EMA deviation, momentum
// (RSI, Z-score), and volatility (rel. volume, ATR%). vs Fair Value stays
// in the main row (see buildScanColumns) since it's the most-watched number.
export function renderScanDetails(row) {
  const items = [
    { label: "vs 200 EMA", value: <PctBadge value={vs200Ema(row)} /> },
    { label: "RSI", value: row.rsiValue != null ? row.rsiValue.toFixed(0) : "—" },
    { label: "Z-score", value: <ZScoreBadge value={row.zScore} /> },
    { label: "Rel. Volume", value: row.relativeVolume != null ? `${row.relativeVolume.toFixed(2)}×` : "—" },
    { label: "ATR %", value: row.atrPct != null ? `${row.atrPct.toFixed(2)}%` : "—" },
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
