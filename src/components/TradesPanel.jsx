import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import DataTable from "./DataTable.jsx";
import { buildTradeColumns } from "../lib/tradeColumns.jsx";
import { useLivePrices } from "../hooks/useLivePrices.js";
import { fmtDurationExact, fmtPrice, fmtRiskReward } from "../lib/format.js";
import { parseOkxOrder } from "../lib/okxOrder.js";

function leveragedPct(trade) {
  const { entryPrice, exitPrice, side, leverage } = trade;
  if (entryPrice == null || exitPrice == null) return null;
  let pct = ((exitPrice - entryPrice) / entryPrice) * 100;
  if (side === "short") pct = -pct;
  return pct * (leverage || 1);
}

function formatR(r) {
  if (r == null) return "—";
  return `${r >= 0 ? "+" : ""}${r.toFixed(r % 1 === 0 ? 0 : 2)}R`;
}

function RecentTradeCard({ trade }) {
  if (!trade) {
    return (
      <div className="rounded-card border border-edge bg-panel p-5 shadow-card">
        <h2 className="text-[14px] font-semibold">Recent Trade Result</h2>
        <p className="mt-2 text-[13px] text-dim">
          No trades logged yet — add one below.
        </p>
      </div>
    );
  }

  const pct = leveragedPct(trade);
  const positive = pct != null ? pct >= 0 : (trade.resultR ?? 0) >= 0;
  const duration =
    trade.entryTime && trade.exitTime
      ? fmtDurationExact(new Date(trade.exitTime) - new Date(trade.entryTime))
      : null;

  return (
    <div className="rounded-card border border-edge bg-panel p-5 shadow-card">
      <div className="flex items-center justify-between">
        <h2 className="text-[14px] font-semibold">Recent Trade Result</h2>
        <span className="text-[12px] text-dim">
          {trade.symbol} · {trade.side.toUpperCase()}
        </span>
      </div>

      <div
        className={`mt-2 text-[34px] font-bold leading-none ${positive ? "text-position-long" : "text-position-short"}`}
      >
        {pct != null ? `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%` : "—"}
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
        <span
          className={positive ? "text-position-long" : "text-position-short"}
        >
          {formatR(trade.resultR)}
        </span>
        <span className="text-dim">
          Return · {trade.leverage || 1}x leverage
        </span>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 text-[13px] sm:grid-cols-4">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-dim">
            Entry
          </div>
          <div className="mt-0.5 text-ink">{fmtPrice(trade.entryPrice)}</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-dim">
            Exit
          </div>
          <div className="mt-0.5 text-ink">{fmtPrice(trade.exitPrice)}</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-dim">
            Duration
          </div>
          <div className="mt-0.5 text-ink">{duration ?? "—"}</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-dim">
            Outcome
          </div>
          <div className={`mt-0.5 ${positive ? "text-position-long" : "text-position-short"}`}>
            {trade.outcome ?? "—"}
          </div>
        </div>
      </div>
    </div>
  );
}

const emptyForm = {
  symbol: "",
  side: "long",
  entryPrice: "",
  exitPrice: "",
  leverage: "1",
  entryTime: "",
  exitTime: "",
  stopLoss: "",
  targetPrice: "",
  stillOpen: false,
};

function AddTradeForm({ onAdd }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [pasteText, setPasteText] = useState("");
  const [pasteNotice, setPasteNotice] = useState("");

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const fillFromPaste = () => {
    const parsed = parseOkxOrder(pasteText);
    if (!parsed) {
      setPasteNotice("Couldn't find order details in that text.");
      return;
    }
    setForm((f) => ({
      ...f,
      symbol: parsed.symbol ?? f.symbol,
      side: parsed.side ?? f.side,
      entryPrice: parsed.entryPrice != null ? String(parsed.entryPrice) : f.entryPrice,
      stopLoss: parsed.stopLoss != null ? String(parsed.stopLoss) : f.stopLoss,
      targetPrice: parsed.targetPrice != null ? String(parsed.targetPrice) : f.targetPrice,
    }));
    setPasteNotice("Filled from OKX order — check the fields below.");
  };

  const submit = (e) => {
    e.preventDefault();
    if (!form.symbol.trim()) return;
    onAdd({
      symbol: form.symbol,
      side: form.side,
      status: form.stillOpen ? "open" : "closed",
      entryPrice: form.entryPrice === "" ? null : parseFloat(form.entryPrice),
      exitPrice: form.exitPrice === "" ? null : parseFloat(form.exitPrice),
      leverage: form.leverage === "" ? 1 : parseFloat(form.leverage),
      entryTime: form.entryTime ? new Date(form.entryTime).toISOString() : null,
      exitTime: form.exitTime
        ? new Date(form.exitTime).toISOString()
        : new Date().toISOString(),
      stopLoss: form.stopLoss === "" ? null : parseFloat(form.stopLoss),
      targetPrice:
        form.targetPrice === "" ? null : parseFloat(form.targetPrice),
    });
    setForm(emptyForm);
    setPasteText("");
    setPasteNotice("");
    setOpen(false);
  };

  const trigger = (
    <button
      type="button"
      onClick={() => setOpen(true)}
      className="self-start rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white hover:opacity-90"
    >
      + Add trade
    </button>
  );

  if (!open) return trigger;

  const inputClass =
    "rounded-lg border border-edge bg-bg px-3 py-1.5 text-[13px] text-ink outline-none focus:border-accent";

  return (
    <>
      {trigger}
      {createPortal(
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-4">
          <form
            onSubmit={submit}
            className="flex max-h-[90vh] w-full max-w-2xl flex-col gap-3 overflow-y-auto rounded-card border border-edge bg-panel p-5 shadow-card"
          >
            <h2 className="text-[14px] font-semibold">Add trade</h2>

            <label className="flex flex-col gap-1 text-[11px] text-dim">
              Paste an OKX order ticket (optional)
              <textarea
                value={pasteText}
                onChange={(e) => {
                  setPasteText(e.target.value);
                  setPasteNotice("");
                }}
                placeholder={"e.g. Price\n1,855.11 USD\nAmount\n0.053905 ETH\nTP trigger price\n1,921.76 USD\nSL trigger price\n1,821.61 USD"}
                rows={2}
                className={`resize-none ${inputClass}`}
              />
            </label>
            <div className="-mt-1 flex items-center gap-2">
              <button
                type="button"
                onClick={fillFromPaste}
                disabled={!pasteText.trim()}
                className="rounded-lg border border-edge px-2.5 py-1 text-[12px] font-medium text-ink hover:bg-panel-alt disabled:opacity-40"
              >
                Fill from OKX order
              </button>
              {pasteNotice && <span className="text-[12px] text-dim">{pasteNotice}</span>}
            </div>

            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1 text-[11px] text-dim">
                Symbol
                <input
                  type="text"
                  required
                  value={form.symbol}
                  onChange={set("symbol")}
                  placeholder="e.g. LTC"
                  className={`w-24 uppercase ${inputClass}`}
                />
              </label>

              <label className="flex flex-col gap-1 text-[11px] text-dim">
                Side
                <div className="flex gap-1 rounded-lg bg-panel-alt p-1">
                  {["long", "short"].map((side) => (
                    <button
                      key={side}
                      type="button"
                      onClick={() => setForm((f) => ({ ...f, side }))}
                      className={`rounded-md px-2.5 py-1 text-[12px] font-medium capitalize transition-all duration-150 ${
                        form.side === side
                          ? "bg-panel-raised text-ink shadow-sm"
                          : "text-dim hover:text-ink"
                      }`}
                    >
                      {side}
                    </button>
                  ))}
                </div>
              </label>

              <label className="flex flex-col gap-1 text-[11px] text-dim">
                Entry price
                <input
                  type="number"
                  step="any"
                  value={form.entryPrice}
                  onChange={set("entryPrice")}
                  className={`w-28 ${inputClass}`}
                />
              </label>

              {!form.stillOpen && (
                <label className="flex flex-col gap-1 text-[11px] text-dim">
                  Exit price
                  <input
                    type="number"
                    step="any"
                    value={form.exitPrice}
                    onChange={set("exitPrice")}
                    className={`w-28 ${inputClass}`}
                  />
                </label>
              )}

              <label className="flex flex-col gap-1 text-[11px] text-dim">
                Leverage
                <input
                  type="number"
                  step="any"
                  min="1"
                  value={form.leverage}
                  onChange={set("leverage")}
                  className={`w-20 ${inputClass}`}
                />
              </label>

              <label className="flex flex-col gap-1 text-[11px] text-dim">
                Stop loss
                <input
                  type="number"
                  step="any"
                  value={form.stopLoss}
                  onChange={set("stopLoss")}
                  className={`w-28 ${inputClass}`}
                />
              </label>

              <label className="flex flex-col gap-1 text-[11px] text-dim">
                Target price
                <input
                  type="number"
                  step="any"
                  value={form.targetPrice}
                  onChange={set("targetPrice")}
                  className={`w-28 ${inputClass}`}
                />
              </label>

              <div className="flex flex-col gap-1 text-[11px] text-dim">
                R/R
                <div className="flex h-[34px] items-center px-1 text-[13px] font-medium text-ink">
                  {fmtRiskReward(
                    form.entryPrice === "" ? null : parseFloat(form.entryPrice),
                    form.stopLoss === "" ? null : parseFloat(form.stopLoss),
                    form.targetPrice === ""
                      ? null
                      : parseFloat(form.targetPrice),
                  )}
                </div>
              </div>
            </div>

            <label className="flex w-fit items-center gap-2 text-[13px] text-ink">
              <input
                type="checkbox"
                checked={form.stillOpen}
                onChange={(e) =>
                  setForm((f) => ({ ...f, stillOpen: e.target.checked }))
                }
              />
              Position still open (no exit yet)
            </label>

            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1 text-[11px] text-dim">
                Entry time
                <input
                  type="datetime-local"
                  value={form.entryTime}
                  onChange={set("entryTime")}
                  className={inputClass}
                />
              </label>

              {!form.stillOpen && (
                <label className="flex flex-col gap-1 text-[11px] text-dim">
                  Exit time
                  <input
                    type="datetime-local"
                    value={form.exitTime}
                    onChange={set("exitTime")}
                    className={inputClass}
                  />
                </label>
              )}
            </div>

            <div className="flex items-center gap-2">
              <button
                type="submit"
                className="rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white hover:opacity-90"
              >
                Save trade
              </button>
              <button
                type="button"
                onClick={() => {
                  setForm(emptyForm);
                  setPasteText("");
                  setPasteNotice("");
                  setOpen(false);
                }}
                className="rounded-lg px-3 py-1.5 text-[13px] text-dim hover:text-ink"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>,
        document.body,
      )}
    </>
  );
}

const emptyCloseForm = {
  exitPrice: "",
  exitTime: "",
};

function CloseTradeDialog({ trade, onClose, onCancel }) {
  const [form, setForm] = useState(emptyCloseForm);
  const [pasteText, setPasteText] = useState("");
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const fillFromPaste = () => {
    const parsed = parseOkxOrder(pasteText);
    if (parsed?.entryPrice != null) {
      setForm((f) => ({ ...f, exitPrice: String(parsed.entryPrice) }));
    }
  };

  const submit = (e) => {
    e.preventDefault();
    onClose(trade.id, {
      exitPrice: form.exitPrice === "" ? null : parseFloat(form.exitPrice),
      exitTime: form.exitTime
        ? new Date(form.exitTime).toISOString()
        : new Date().toISOString(),
    });
  };

  const inputClass =
    "rounded-lg border border-edge bg-bg px-3 py-1.5 text-[13px] text-ink outline-none focus:border-accent";

  return createPortal(
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-4">
      <form
        onSubmit={submit}
        className="flex w-full max-w-md flex-col gap-3 rounded-card border border-edge bg-panel p-5 shadow-card"
      >
        <h2 className="text-[14px] font-semibold">
          Close {trade.symbol} <span className="text-dim">({trade.side})</span>
        </h2>

        <label className="flex flex-col gap-1 text-[11px] text-dim">
          Paste an OKX order ticket (optional)
          <textarea
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            placeholder="e.g. Price&#10;1,921.76 USD"
            rows={2}
            className={`resize-none ${inputClass}`}
          />
        </label>
        <button
          type="button"
          onClick={fillFromPaste}
          disabled={!pasteText.trim()}
          className="-mt-1 self-start rounded-lg border border-edge px-2.5 py-1 text-[12px] font-medium text-ink hover:bg-panel-alt disabled:opacity-40"
        >
          Fill from OKX order
        </button>

        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-[11px] text-dim">
            Exit price
            <input
              type="number"
              step="any"
              autoFocus
              value={form.exitPrice}
              onChange={set("exitPrice")}
              className={`w-28 ${inputClass}`}
            />
          </label>

          <label className="flex flex-col gap-1 text-[11px] text-dim">
            Exit time
            <input
              type="datetime-local"
              value={form.exitTime}
              onChange={set("exitTime")}
              className={inputClass}
            />
          </label>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="submit"
            className="rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white hover:opacity-90"
          >
            Close trade
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg px-3 py-1.5 text-[13px] text-dim hover:text-ink"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

export default function TradesPanel({ trades }) {
  const [closingId, setClosingId] = useState(null);
  const closingTrade = trades.trades.find((t) => t.id === closingId) ?? null;
  const columns = buildTradeColumns(trades.remove, setClosingId);

  const symbols = useMemo(() => [...new Set(trades.trades.map((t) => t.symbol))], [trades.trades]);
  const { data: livePrices } = useLivePrices(symbols);

  const rows = useMemo(
    () => trades.trades.map((t) => ({ ...t, currentPrice: livePrices?.get(t.symbol) ?? null })),
    [trades.trades, livePrices]
  );

  return (
    <div className="flex flex-col gap-5">
      <RecentTradeCard trade={trades.recent} />

      <AddTradeForm onAdd={trades.add} />

      {closingTrade && (
        <CloseTradeDialog
          trade={closingTrade}
          onClose={(id, exit) => {
            trades.close(id, exit);
            setClosingId(null);
          }}
          onCancel={() => setClosingId(null)}
        />
      )}

      <div className="rounded-card border border-edge bg-panel shadow-card">
        <div className="border-b border-edge px-5 py-3.5">
          <h2 className="text-[14px] font-semibold">Trade History</h2>
          <p className="text-[11px] text-dim">Every trade, tracked live.</p>
        </div>

        <DataTable
          columns={columns}
          data={rows}
          emptyText="No trades logged yet"
          pageSize={20}
          initialSort={{ key: "exitTime", dir: -1 }}
          exportFilename={`trades-${new Date().toISOString().slice(0, 10)}.csv`}
        />
      </div>
    </div>
  );
}
