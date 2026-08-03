import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLivePrices } from "../hooks/useLivePrices.js";
import { fmtPrice, fmtUsd, fmtDateTime } from "../lib/format.js";
import RotatingLoadingText from "./RotatingLoadingText.jsx";

const inputClass = "rounded-lg border border-edge bg-bg px-3 py-1.5 text-[13px] text-ink outline-none focus:border-accent";

// Plain-text portfolio+price snapshot handed to Gemini as context. Local to
// this panel (single consumer) rather than a lib module -- same as
// TradesPanel's local form-only helpers.
function buildContextText(holdings, livePrices) {
  if (!holdings.length) return "The user's portfolio is currently empty.";
  const lines = holdings.map((h) => {
    const price = livePrices?.get(h.symbol);
    const value = price != null ? h.quantity * price : null;
    const costBasis = h.quantity * h.avgCost;
    const pnlPct = value != null && costBasis > 0 ? ((value - costBasis) / costBasis) * 100 : null;
    return `- ${h.symbol}: qty ${h.quantity}, avg cost ${fmtPrice(h.avgCost)}, current price ${fmtPrice(price)}, value ${
      value != null ? fmtUsd(value) : "unknown"
    }, P&L ${pnlPct != null ? `${pnlPct.toFixed(2)}%` : "unknown"}`;
  });
  return `Portfolio as of ${fmtDateTime(new Date().toISOString())}:\n${lines.join("\n")}`;
}

function SettingsDialog({ apiKey, model, onSave, onCancel }) {
  const [form, setForm] = useState({ apiKey, model });
  return createPortal(
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSave(form);
        }}
        className="flex w-full max-w-md flex-col gap-3 rounded-card border border-edge bg-panel p-5 shadow-card"
      >
        <h2 className="text-[14px] font-semibold">Gemini settings</h2>
        <label className="flex flex-col gap-1 text-[11px] text-dim">
          API key
          <input
            type="password"
            value={form.apiKey}
            onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
            className={inputClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-dim">
          Model
          <input type="text" value={form.model} onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))} className={inputClass} />
        </label>
        <p className="text-[11px] text-dim">Stored in plain text in this app's local data file — same as everything else it stores.</p>
        <div className="flex items-center gap-2">
          <button type="submit" className="rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white hover:opacity-90">
            Save
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

// Gemini BYOK chat, scoped to the user's own portfolio -- see
// useGeminiChat.js for why the conversation state lives in App.jsx rather
// than here. This panel just renders it and feeds it a live context
// snapshot on every render (setContextProvider only mutates a ref, so this
// never triggers extra re-renders on its own).
export default function ChatPanel({ chat, portfolio }) {
  const [input, setInput] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const bottomRef = useRef(null);

  const symbols = useMemo(() => [...new Set(portfolio.holdings.map((h) => h.symbol))], [portfolio.holdings]);
  const { data: livePrices } = useLivePrices(symbols);

  useEffect(() => {
    chat.setContextProvider(() => buildContextText(portfolio.holdings, livePrices));
  });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chat.messages, chat.status]);

  const handleSend = () => {
    if (!input.trim() || chat.status === "sending") return;
    chat.sendMessage(input);
    setInput("");
  };

  return (
    <div className="flex h-[calc(100vh-160px)] flex-col rounded-card border border-edge bg-panel shadow-card">
      <div className="flex items-center justify-between border-b border-edge px-5 py-3.5">
        <div>
          <h2 className="text-[14px] font-semibold">Portfolio Assistant</h2>
          <p className="text-[11px] text-dim">Not financial advice — answers are generated from your data by Gemini.</p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={chat.clearConversation} className="text-[12px] text-dim hover:text-ink">
            Clear
          </button>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            aria-label="Chat settings"
            title="Chat settings"
            className="flex h-7 w-7 items-center justify-center rounded-full bg-panel-alt text-[13px] transition-colors duration-150 hover:bg-panel-raised"
          >
            ⚙
          </button>
        </div>
      </div>

      {!chat.apiKey ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="text-[13px] text-dim">Set a Gemini API key to start chatting about your portfolio.</p>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white hover:opacity-90"
          >
            Set API key
          </button>
        </div>
      ) : (
        <>
          <div className="flex flex-1 flex-col gap-2 overflow-y-auto px-5 py-4">
            {chat.messages.length === 0 && (
              <p className="text-[13px] text-dim">Ask about your holdings, e.g. "how is my portfolio doing?"</p>
            )}
            {chat.messages.map((m) => (
              <div key={m.id} className={`flex flex-col ${m.role === "user" ? "items-end" : "items-start"}`}>
                <div
                  className={`max-w-[75%] whitespace-pre-wrap rounded-lg px-3 py-2 text-[13px] ${
                    m.role === "user" ? "bg-accent/15 text-ink" : "bg-panel-alt text-ink"
                  }`}
                >
                  {m.text}
                </div>
              </div>
            ))}
            {chat.status === "sending" && (
              <div className="self-start rounded-lg bg-panel-alt px-3 py-2 text-[13px] text-dim">
                <RotatingLoadingText messages={["Thinking…", "Asking Gemini…"]} intervalMs={1200} />
              </div>
            )}
            {chat.error && <p className="text-[12px] text-position-short">{chat.error}</p>}
            <div ref={bottomRef} />
          </div>

          <div className="flex items-end gap-2 border-t border-edge p-3">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              placeholder="Ask about your portfolio…"
              rows={1}
              className="flex-1 resize-none rounded-lg border border-edge bg-bg px-3 py-1.5 text-[13px] text-ink outline-none focus:border-accent"
            />
            <button
              type="button"
              onClick={handleSend}
              disabled={chat.status === "sending"}
              className="rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Send
            </button>
          </div>
        </>
      )}

      {settingsOpen && (
        <SettingsDialog
          apiKey={chat.apiKey}
          model={chat.model}
          onSave={(form) => {
            chat.setApiKey(form.apiKey);
            chat.setModel(form.model);
            setSettingsOpen(false);
          }}
          onCancel={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}
