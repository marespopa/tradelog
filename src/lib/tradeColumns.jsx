import { fmtDateTime, fmtPrice, fmtRiskReward, riskRewardRatio } from "./format.js";

function ResultBadge({ resultR }) {
  if (resultR == null) return "—";
  const positive = resultR >= 0;
  return (
    <span className={positive ? "text-position-long" : "text-position-short"}>
      {positive ? "+" : ""}
      {resultR.toFixed(2)}R
    </span>
  );
}

// Open trades have no exitPrice yet — fall back to the live current price so
// an open position still shows an (unrealized) % instead of just "—".
function PctBadge({ trade }) {
  const { entryPrice, exitPrice, currentPrice, side, status } = trade;
  const referencePrice = status === "open" ? currentPrice : exitPrice;
  if (entryPrice == null || referencePrice == null) return "—";
  let pct = ((referencePrice - entryPrice) / entryPrice) * 100;
  if (side === "short") pct = -pct;
  return (
    <span className={pct >= 0 ? "text-position-long" : "text-position-short"}>
      {pct >= 0 ? "+" : ""}
      {pct.toFixed(2)}%
      {status === "open" && <span className="ml-1 text-[10px] text-dim">unrl.</span>}
    </span>
  );
}

// Trade journal history table — mirrors the scan/watchlist DataTable usage
// so sort/filter/export/pagination come for free. Only the essentials are
// shown as columns; everything else lives behind the row's expand toggle
// (see renderTradeDetails below) so the table stays scannable.
export function buildTradeColumns(onRemove, onClose, onEdit) {
  return [
    {
      key: "exitTime",
      title: "Status",
      filter: "select",
      filterValue: (r) => r.status,
      // Open trades have no exitTime yet — sort them as most-recent.
      sortValue: (r) => (r.exitTime ? new Date(r.exitTime).getTime() : Infinity),
      formatter: (r) =>
        r.status === "open" ? (
          <span className="font-medium text-accent">Open</span>
        ) : (
          fmtDateTime(r.exitTime)
        ),
    },
    { key: "symbol", title: "Asset", filter: "text", formatter: (r) => <span className="font-medium">{r.symbol}</span> },
    {
      key: "side",
      title: "Side",
      filter: "select",
      filterValue: (r) => r.side,
      formatter: (r) => (
        <span className={`text-[11px] font-semibold uppercase tracking-wide ${r.side === "short" ? "text-position-short" : "text-position-long"}`}>
          {r.side}
        </span>
      ),
    },
    { key: "entryPrice", title: "Entry", align: "right", sortValue: (r) => r.entryPrice ?? 0, formatter: (r) => fmtPrice(r.entryPrice) },
    {
      key: "currentPrice",
      title: "Current",
      align: "right",
      sortValue: (r) => r.currentPrice ?? 0,
      formatter: (r) => (r.status === "open" ? fmtPrice(r.currentPrice) : <span className="text-dim">{fmtPrice(r.currentPrice)}</span>),
    },
    { key: "resultR", title: "Result", align: "right", sortValue: (r) => r.resultR ?? 0, formatter: (r) => <ResultBadge resultR={r.resultR} /> },
    { key: "pct", title: "%", align: "right", sortable: false, formatter: (r) => <PctBadge trade={r} /> },
    // Hidden from the table itself (shown in the expanded row instead) but
    // kept here so CSV export still includes every field.
    { key: "leverage", title: "Lev", hidden: true, csvValue: (r) => `${r.leverage ?? 1}x` },
    { key: "exitPrice", title: "Exit", hidden: true, csvValue: (r) => fmtPrice(r.exitPrice) },
    { key: "stopLoss", title: "Stop Loss", hidden: true, csvValue: (r) => (r.stopLoss != null ? fmtPrice(r.stopLoss) : "") },
    { key: "targetPrice", title: "Target", hidden: true, csvValue: (r) => (r.targetPrice != null ? fmtPrice(r.targetPrice) : "") },
    {
      key: "riskReward",
      title: "R/R",
      hidden: true,
      csvValue: (r) => (riskRewardRatio(r.entryPrice, r.stopLoss, r.targetPrice) ?? "").toString(),
    },
    { key: "outcome", title: "Outcome", hidden: true, csvValue: (r) => (r.status === "open" ? "—" : r.outcome || "—") },
    {
      key: "actions",
      title: "",
      width: 96,
      sortable: false,
      formatter: (r) => (
        <span className="flex items-center justify-end gap-2.5">
          {r.status === "open" && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onClose(r.id);
              }}
              aria-label="Close trade"
              title="Close trade"
              className="text-[11px] font-medium text-accent transition-colors duration-150 hover:opacity-80"
            >
              Close
            </button>
          )}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onEdit(r.id);
            }}
            aria-label="Edit trade"
            title="Edit trade"
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
            aria-label="Delete trade"
            title="Delete trade"
            className="text-dim/50 transition-colors duration-150 hover:text-position-short"
          >
            ✕
          </button>
        </span>
      ),
    },
  ];
}

// Everything that doesn't fit in the collapsed row: full timestamps,
// leverage, exit price, stop/target, and computed R/R + outcome.
export function renderTradeDetails(trade) {
  const items = [
    { label: "Entry Time", value: fmtDateTime(trade.entryTime) },
    { label: "Leverage", value: `${trade.leverage ?? 1}x` },
    { label: "Exit Price", value: trade.exitPrice != null ? fmtPrice(trade.exitPrice) : "—" },
    { label: "Stop Loss", value: trade.stopLoss != null ? fmtPrice(trade.stopLoss) : "—" },
    { label: "Target", value: trade.targetPrice != null ? fmtPrice(trade.targetPrice) : "—" },
    { label: "Risk / Reward", value: fmtRiskReward(trade.entryPrice, trade.stopLoss, trade.targetPrice) },
    { label: "Outcome", value: trade.status === "open" ? "—" : trade.outcome || "—" },
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
