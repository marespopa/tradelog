import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import DataTable from "./DataTable.jsx";
import { buildPortfolioColumns, renderPortfolioDetails } from "../lib/portfolioColumns.jsx";
import { useLivePrices } from "../hooks/useLivePrices.js";
import { fmtUsd, pnlClass } from "../lib/format.js";

function PortfolioSummaryCard({ totalValue, totalCostBasis, totalPnlUsd, totalPnlPct, empty }) {
  if (empty) {
    return (
      <div className="rounded-card border border-edge bg-panel p-5 shadow-card">
        <h2 className="text-[14px] font-semibold">Portfolio</h2>
        <p className="mt-2 text-[13px] text-dim">No holdings yet — add one below.</p>
      </div>
    );
  }
  return (
    <div className="rounded-card border border-edge bg-panel p-5 shadow-card">
      <h2 className="text-[14px] font-semibold">Portfolio</h2>
      <div className={`mt-2 text-[34px] font-bold leading-none ${pnlClass(totalPnlUsd)}`}>{fmtUsd(totalValue)}</div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 text-[13px]">
        <span className={pnlClass(totalPnlUsd)}>
          {totalPnlUsd >= 0 ? "+" : ""}
          {fmtUsd(totalPnlUsd)}
        </span>
        <span className={pnlClass(totalPnlPct)}>
          ({totalPnlPct != null ? `${totalPnlPct >= 0 ? "+" : ""}${totalPnlPct.toFixed(2)}%` : "—"})
        </span>
        <span className="text-dim">Cost basis {fmtUsd(totalCostBasis)}</span>
      </div>
    </div>
  );
}

const inputClass = "rounded-lg border border-edge bg-bg px-3 py-1.5 text-[13px] text-ink outline-none focus:border-accent";
const invalidInputClass = "rounded-lg border border-position-short bg-bg px-3 py-1.5 text-[13px] text-ink outline-none focus:border-accent";

function holdingToForm(h) {
  return {
    symbol: h?.symbol ?? "",
    quantity: h?.quantity != null ? String(h.quantity) : "",
    avgCost: h?.avgCost != null ? String(h.avgCost) : "",
  };
}

// Form -> payload for usePortfolio's add()/update(). Returns null (instead
// of a payload with NaN fields) when quantity/avgCost don't parse to a
// usable positive number, so the caller can reject the submission with
// visible feedback -- mirrors the AlarmCell fix earlier this session, where
// closing the form unconditionally on invalid input silently dropped it.
function formToHoldingPayload(form) {
  const symbol = form.symbol.trim();
  const quantity = parseFloat(form.quantity);
  const avgCost = parseFloat(form.avgCost);
  if (!symbol || isNaN(quantity) || quantity <= 0 || isNaN(avgCost) || avgCost <= 0) return null;
  return { symbol, quantity, avgCost };
}

function HoldingFormDialog({ title, submitLabel, initialForm, onSubmit, onCancel }) {
  const [form, setForm] = useState(initialForm);
  const [invalid, setInvalid] = useState(false);

  const set = (key) => (e) => {
    setForm((f) => ({ ...f, [key]: e.target.value }));
    setInvalid(false);
  };

  const submit = (e) => {
    e.preventDefault();
    const payload = formToHoldingPayload(form);
    if (!payload) {
      setInvalid(true);
      return;
    }
    onSubmit(payload);
  };

  return createPortal(
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-4">
      <form onSubmit={submit} className="flex w-full max-w-md flex-col gap-3 rounded-card border border-edge bg-panel p-5 shadow-card">
        <h2 className="text-[14px] font-semibold">{title}</h2>

        <label className="flex flex-col gap-1 text-[11px] text-dim">
          Symbol
          <input type="text" value={form.symbol} onChange={set("symbol")} className={inputClass} placeholder="e.g. BTC" />
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-dim">
          Quantity
          <input type="number" step="any" value={form.quantity} onChange={set("quantity")} className={invalid ? invalidInputClass : inputClass} />
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-dim">
          Average cost (per unit)
          <input type="number" step="any" value={form.avgCost} onChange={set("avgCost")} className={invalid ? invalidInputClass : inputClass} />
        </label>
        {invalid && <p className="text-[11px] text-position-short">Enter a symbol and a quantity/avg cost above 0.</p>}

        <div className="flex items-center gap-2">
          <button type="submit" className="rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white hover:opacity-90">
            {submitLabel}
          </button>
          <button type="button" onClick={onCancel} className="rounded-lg px-3 py-1.5 text-[13px] text-dim hover:text-ink">
            Cancel
          </button>
        </div>
      </form>
    </div>,
    document.body
  );
}

function AddHoldingForm({ onAdd }) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="self-start rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white hover:opacity-90">
        + Add holding
      </button>
    );
  }

  return (
    <HoldingFormDialog
      title="Add holding"
      submitLabel="Save holding"
      initialForm={holdingToForm(null)}
      onSubmit={(payload) => {
        onAdd(payload);
        setOpen(false);
      }}
      onCancel={() => setOpen(false)}
    />
  );
}

export default function PortfolioPanel({ portfolio, onSelectSymbol }) {
  const [editingId, setEditingId] = useState(null);
  const editingHolding = portfolio.holdings.find((h) => h.id === editingId) ?? null;
  const columns = useMemo(() => buildPortfolioColumns(portfolio.remove, setEditingId), [portfolio.remove]);

  const symbols = useMemo(() => [...new Set(portfolio.holdings.map((h) => h.symbol))], [portfolio.holdings]);
  const { data: livePrices } = useLivePrices(symbols);

  const rows = useMemo(() => {
    const priced = portfolio.holdings.map((h) => ({ ...h, currentPrice: livePrices?.get(h.symbol) ?? null }));
    const totalValue = priced.reduce((sum, h) => sum + (h.currentPrice != null ? h.quantity * h.currentPrice : 0), 0);
    return priced.map((h) => {
      const costBasis = h.quantity * h.avgCost;
      const currentValue = h.currentPrice != null ? h.quantity * h.currentPrice : null;
      const pnlUsd = currentValue != null ? currentValue - costBasis : null;
      const pnlPct = currentValue != null && costBasis > 0 ? (pnlUsd / costBasis) * 100 : null;
      const allocationPct = currentValue != null && totalValue > 0 ? (currentValue / totalValue) * 100 : null;
      return { ...h, costBasis, currentValue, pnlUsd, pnlPct, allocationPct };
    });
  }, [portfolio.holdings, livePrices]);

  const totals = useMemo(
    () =>
      rows.reduce(
        (acc, r) => ({ costBasis: acc.costBasis + r.costBasis, currentValue: acc.currentValue + (r.currentValue ?? 0) }),
        { costBasis: 0, currentValue: 0 }
      ),
    [rows]
  );
  const totalPnlUsd = totals.currentValue - totals.costBasis;
  const totalPnlPct = totals.costBasis > 0 ? (totalPnlUsd / totals.costBasis) * 100 : null;

  return (
    <div className="flex flex-col gap-5">
      <PortfolioSummaryCard
        totalValue={totals.currentValue}
        totalCostBasis={totals.costBasis}
        totalPnlUsd={totalPnlUsd}
        totalPnlPct={totalPnlPct}
        empty={rows.length === 0}
      />

      <AddHoldingForm onAdd={portfolio.add} />

      {editingHolding && (
        <HoldingFormDialog
          title={`Edit ${editingHolding.symbol}`}
          submitLabel="Save changes"
          initialForm={holdingToForm(editingHolding)}
          onSubmit={(payload) => {
            portfolio.update(editingHolding.id, payload);
            setEditingId(null);
          }}
          onCancel={() => setEditingId(null)}
        />
      )}

      <div className="rounded-card border border-edge bg-panel shadow-card">
        <div className="border-b border-edge px-5 py-3.5">
          <h2 className="text-[14px] font-semibold">Holdings</h2>
          <p className="text-[11px] text-dim">Manually tracked, live-priced. Repeated symbols are kept as separate lots.</p>
        </div>
        <DataTable
          columns={columns}
          data={rows}
          emptyText="No holdings yet — add one below"
          onRowClick={(row) => onSelectSymbol?.(row.symbol)}
          pageSize={20}
          initialSort={{ key: "currentValue", dir: -1 }}
          exportFilename={`portfolio-${new Date().toISOString().slice(0, 10)}.csv`}
          renderExpanded={renderPortfolioDetails}
          stateKey="portfolio"
        />
      </div>
    </div>
  );
}
