import { fmt, fmtPrice, fmtUsd, fmtDateTime, pnlClass } from "./format.js";

// Holdings table -- mirrors tradeColumns.jsx's buildTradeColumns. Computed
// fields (costBasis/currentValue/pnlUsd/pnlPct/allocationPct) are expected
// to already be merged onto each row by PortfolioPanel before this is
// called, since allocationPct needs the portfolio total, which no single
// row has access to on its own.
export function buildPortfolioColumns(onRemove, onEdit) {
  return [
    { key: "symbol", title: "Asset", filter: "text", formatter: (r) => <span className="font-medium">{r.symbol}</span> },
    { key: "quantity", title: "Qty", align: "right", sortValue: (r) => r.quantity, formatter: (r) => fmt(r.quantity) },
    { key: "avgCost", title: "Avg Cost", align: "right", sortValue: (r) => r.avgCost, formatter: (r) => fmtPrice(r.avgCost) },
    { key: "currentPrice", title: "Price", align: "right", sortValue: (r) => r.currentPrice ?? 0, formatter: (r) => fmtPrice(r.currentPrice) },
    {
      key: "currentValue",
      title: "Value",
      align: "right",
      sortValue: (r) => r.currentValue ?? 0,
      formatter: (r) => (r.currentValue != null ? fmtUsd(r.currentValue) : "—"),
    },
    {
      key: "pnlUsd",
      title: "P&L $",
      align: "right",
      sortValue: (r) => r.pnlUsd ?? 0,
      formatter: (r) =>
        r.pnlUsd != null ? (
          <span className={pnlClass(r.pnlUsd)}>
            {r.pnlUsd >= 0 ? "+" : ""}
            {fmtUsd(r.pnlUsd)}
          </span>
        ) : (
          "—"
        ),
    },
    {
      key: "pnlPct",
      title: "P&L %",
      align: "right",
      sortValue: (r) => r.pnlPct ?? 0,
      formatter: (r) =>
        r.pnlPct != null ? (
          <span className={pnlClass(r.pnlPct)}>
            {r.pnlPct >= 0 ? "+" : ""}
            {r.pnlPct.toFixed(2)}%
          </span>
        ) : (
          "—"
        ),
    },
    {
      key: "allocationPct",
      title: "Alloc.",
      align: "right",
      sortValue: (r) => r.allocationPct ?? 0,
      formatter: (r) => (r.allocationPct != null ? `${r.allocationPct.toFixed(1)}%` : "—"),
    },
    // Hidden from the table itself (shown in the expanded row / CSV export
    // instead) -- same convention as tradeColumns.jsx's leverage/stopLoss/etc.
    { key: "costBasis", title: "Cost Basis", hidden: true, csvValue: (r) => fmtUsd(r.costBasis) },
    { key: "addedAt", title: "Added", hidden: true, csvValue: (r) => fmtDateTime(r.addedAt) },
    {
      key: "actions",
      title: "",
      width: 72,
      sortable: false,
      formatter: (r) => (
        <span className="flex items-center justify-end gap-2.5">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onEdit(r.id);
            }}
            aria-label="Edit holding"
            title="Edit holding"
            className="text-dim/50 transition-colors duration-150 hover:text-accent"
          >
            ✎
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRemove(r.id);
            }}
            aria-label="Delete holding"
            title="Delete holding"
            className="text-dim/50 transition-colors duration-150 hover:text-position-short"
          >
            ✕
          </button>
        </span>
      ),
    },
  ];
}

export function renderPortfolioDetails(holding) {
  const items = [
    { label: "Cost Basis", value: fmtUsd(holding.costBasis) },
    { label: "Added", value: fmtDateTime(holding.addedAt) },
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
