import { fmtDateTime, fmtPrice, fmtRiskReward, riskRewardRatio } from "./format.jsx";

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
// so sort/filter/export/pagination come for free.
export function buildTradeColumns(onRemove, onClose) {
  return [
    {
      key: "exitTime",
      title: "Closed",
      // Open trades have no exitTime yet — sort them as most-recent.
      sortValue: (r) => (r.exitTime ? new Date(r.exitTime).getTime() : Infinity),
      formatter: (r) =>
        r.status === "open" ? (
          <span className="font-medium text-accent">Open</span>
        ) : (
          fmtDateTime(r.exitTime)
        ),
    },
    {
      key: "symbol",
      title: "Asset",
      filter: "text",
      formatter: (r) => (
        <span className="flex flex-col leading-tight">
          <span className="font-medium">{r.symbol}</span>
          <span className={`text-[10px] font-semibold uppercase tracking-wide ${r.side === "short" ? "text-position-short" : "text-position-long"}`}>
            {r.side}
          </span>
        </span>
      ),
    },
    { key: "entryPrice", title: "Entry", align: "right", sortValue: (r) => r.entryPrice ?? 0, formatter: (r) => fmtPrice(r.entryPrice) },
    { key: "exitPrice", title: "Exit", align: "right", sortValue: (r) => r.exitPrice ?? 0, formatter: (r) => fmtPrice(r.exitPrice) },
    {
      key: "currentPrice",
      title: "Current",
      align: "right",
      sortValue: (r) => r.currentPrice ?? 0,
      formatter: (r) => (r.status === "open" ? fmtPrice(r.currentPrice) : <span className="text-dim">{fmtPrice(r.currentPrice)}</span>),
    },
    {
      key: "stopLoss",
      title: "SL / Target",
      align: "right",
      sortValue: (r) => r.stopLoss ?? 0,
      formatter: (r) => [r.stopLoss != null ? fmtPrice(r.stopLoss) : null, r.targetPrice != null ? fmtPrice(r.targetPrice) : null].filter(Boolean).join(" / ") || "—",
    },
    {
      key: "riskReward",
      title: "R/R",
      align: "right",
      sortValue: (r) => riskRewardRatio(r.entryPrice, r.stopLoss, r.targetPrice) ?? 0,
      formatter: (r) => fmtRiskReward(r.entryPrice, r.stopLoss, r.targetPrice),
    },
    {
      key: "outcome",
      title: "Outcome",
      filter: "text",
      formatter: (r) => (r.status === "open" ? "—" : r.outcome || "—"),
    },
    { key: "resultR", title: "Result", align: "right", sortValue: (r) => r.resultR ?? 0, formatter: (r) => <ResultBadge resultR={r.resultR} /> },
    { key: "pct", title: "%", align: "right", sortable: false, formatter: (r) => <PctBadge trade={r} /> },
    {
      key: "actions",
      title: "",
      width: 72,
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
