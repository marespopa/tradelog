import { useHedgedBasket } from "../hooks/useHedgedBasket.js";
import { BiasBadge } from "../lib/scanColumns.jsx";
import { fmt } from "../lib/format.js";

function LegTable({ title, rows, onSelectSymbol }) {
  return (
    <div className="flex-1">
      <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-dim">{title}</h3>
      <table className="w-full border-separate border-spacing-0 text-[13px]">
        <thead>
          <tr>
            <th className="border-b border-edge px-2 py-1.5 text-left text-[11px] font-medium uppercase tracking-wide text-dim">Symbol</th>
            <th className="border-b border-edge px-2 py-1.5 text-right text-[11px] font-medium uppercase tracking-wide text-dim">Alpha</th>
            <th className="border-b border-edge px-2 py-1.5 text-right text-[11px] font-medium uppercase tracking-wide text-dim">Beta</th>
            <th className="border-b border-edge px-2 py-1.5 text-right text-[11px] font-medium uppercase tracking-wide text-dim">Weight</th>
            <th className="border-b border-edge px-2 py-1.5 text-left text-[11px] font-medium uppercase tracking-wide text-dim">Regime</th>
          </tr>
        </thead>
        <tbody>
          {rows.length ? (
            rows.map((r) => (
              <tr
                key={r.symbol}
                onClick={() => onSelectSymbol?.(r.symbol)}
                className="cursor-pointer border-b border-edge-soft last:border-0 hover:bg-panel-alt"
              >
                <td className="px-2 py-1.5 text-ink">{r.symbol}</td>
                <td className="px-2 py-1.5 text-right tabular-nums text-ink">
                  <span className={r.alpha >= 0 ? "text-position-long" : "text-position-short"}>
                    {r.alpha >= 0 ? "+" : ""}
                    {(r.alpha * 100).toFixed(1)}%
                  </span>
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums text-ink">{fmt(r.beta, 2)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums text-ink">{(r.weight * 100).toFixed(1)}%</td>
                <td className="px-2 py-1.5">
                  <BiasBadge value={r.regime} />
                </td>
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={5} className="px-2 py-6 text-center text-dim">
                No eligible names for this leg right now.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// Beta-neutral long/short basket (see betaNeutral.js): top-volume market
// ranked by alpha vs BTC, names whose Weekly+Daily trend regime actively
// disagrees with a leg's direction vetoed, short leg sized so aggregate
// long/short beta cancel by construction (netBeta should sit near 0 here —
// if it doesn't, that's the same bug scripts/backtest-beta-neutral.js
// caught before this was fixed). No 4H-trigger column here (unlike the
// Scan panel) — with only ~10 names in the basket, the odds of any of them
// having a live 4H trigger at a given moment are too low for the column to
// carry its own weight.
export default function HedgedPortfolioPanel({ onSelectSymbol }) {
  const { data, isLoading, isFetching, error } = useHedgedBasket();

  return (
    <div className="rounded-card border border-edge bg-panel shadow-card">
      <div className="flex items-center justify-between border-b border-edge px-5 py-3.5">
        <div>
          <h2 className="text-[14px] font-semibold">Hedged portfolio — beta-neutral long/short</h2>
          <p className="text-[11px] text-dim">Ranked by alpha vs BTC · trend-conflicting names vetoed · short leg sized to net out beta.</p>
        </div>
        {isFetching && <span className="text-[12px] text-dim">Rebuilding…</span>}
      </div>

      {error && <p className="p-5 text-[13px] text-position-short">Basket build failed: {error.message}</p>}

      {!error && isLoading && <p className="p-5 text-[13px] text-dim">Building basket…</p>}

      {!error && !isLoading && data && (
        <div className="flex flex-col gap-5 p-5">
          <div className="flex flex-wrap gap-6 text-[13px]">
            <div>
              <span className="text-dim">Net beta </span>
              <span className={Math.abs(data.netBeta) < 0.05 ? "text-position-long" : "text-position-short"}>{fmt(data.netBeta, 3)}</span>
            </div>
            <div>
              <span className="text-dim">Long notional </span>
              <span className="text-ink">{fmt(data.longNotional, 2)}×</span>
            </div>
            <div>
              <span className="text-dim">Short notional </span>
              <span className="text-ink">{fmt(data.shortNotional, 2)}×</span>
            </div>
          </div>

          <div className="flex flex-col gap-6 sm:flex-row">
            <LegTable title="Long" rows={data.longs} onSelectSymbol={onSelectSymbol} />
            <LegTable title="Short" rows={data.shorts} onSelectSymbol={onSelectSymbol} />
          </div>
        </div>
      )}
    </div>
  );
}
