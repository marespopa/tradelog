import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import DataTable from "./DataTable.jsx";
import { useStrategies } from "../hooks/useStrategies.js";
import { useSignalPolling, ensureNotificationPermission, sendTestNotification } from "../hooks/useSignalPolling.js";
import { normalizeSignal } from "../lib/strategySignal.js";
import { TIMEFRAMES } from "../lib/analysis/okx.js";
import { getCachedCandles } from "../lib/candleCache.js";
import { runStrategyBacktest, runStrategySignal } from "../lib/strategyEngine.js";
import { summarizeTrades, buyHoldPct } from "../lib/backtestStats.js";
import { fmtDateTime, fmtPrice } from "../lib/format.js";

const TIMEFRAME_LABEL = { "15m": "15m", "1h": "1H", "4h": "4H", "1d": "1D", "1w": "1W" };
const POLL_MINUTES_OPTIONS = [5, 15, 30, 60];

// Working examples so a new strategy starts from something runnable instead
// of a blank box. Both are self-contained per bar (no engine-tracked state
// besides `position`), always-in-market flip systems: every directional
// signal both opens the new side and closes the old one (see
// strategyWorker.js), so there's no separate flat state to manage.

// Same channel-midline-flip rule scripts/backtest-channel-midline.js tests
// standalone, ported to the ctx-based contract (the script's carried
// "prevBand" variable is instead just re-derived from ctx.bars each call).
const CHANNEL_MIDLINE_CODE = `// ctx.bars: candles [{time, open, high, low, close, volume}] up to and
// including "now" -- no lookahead. ctx.position: { direction: "long"|"short",
// entryIndex, entryPrice } or null if flat. ctx.ta: indicator helpers
// (linearRegressionChannel, ema, rsi, macd, atr, zScore, findSwingLevels, ...).
// Return "long", "short", "close", or nothing/null to hold.

const channel = ctx.ta.linearRegressionChannel(ctx.bars, { lookback: 60 });
if (!channel) return null;

const bar = ctx.bars.at(-1);
const prevBar = ctx.bars.at(-2);
if (!prevBar) return null;

const currMid = channel.at(-1).mid;
const prevMid = channel.at(-2)?.mid ?? currMid;

if (prevBar.close >= prevMid && bar.close < currMid) return "short";
if (prevBar.close <= prevMid && bar.close > currMid) return "long";
return null;
`;

// Pure momentum via MACD's own histogram sign flip (12/26/9 EMA separation)
// rather than a price-structure rule like the channel above — long on a
// fresh bullish cross, short on a fresh bearish cross. ctx.ta.macd already
// exposes bullishCross/bearishCross directly (see ta.js) so this is a
// straight pass-through of that read, recomputed fresh each bar from
// ctx.bars (no lookahead — same as the channel preset).
const PURE_MOMENTUM_CODE = `// ctx.bars: candles [{time, open, high, low, close, volume}] up to and
// including "now" -- no lookahead. ctx.position: { direction: "long"|"short",
// entryIndex, entryPrice } or null if flat. ctx.ta: indicator helpers
// (linearRegressionChannel, ema, rsi, macd, atr, zScore, findSwingLevels, ...).
// Return "long", "short", "close", or nothing/null to hold.

const closes = ctx.bars.map((b) => b.close);
const macd = ctx.ta.macd(closes);
if (!macd) return null;

if (macd.bullishCross) return "long";
if (macd.bearishCross) return "short";
return null;
`;

// Trend-aligned dip/rip entry (EMA20/50 for direction, Bollinger basis +
// RSI + Fear & Greed for the pullback trigger) with a pure ATR stop/target
// exit. Backtested against BTC/ETH/SOL 4H: dropping a `close vs EMA50`
// trend-breakdown exit clause (an earlier version of this rule) turned out
// to matter a lot -- with it, 60-70% of trades closed a single bar after
// entry (entries land at bb.basis, which sits close to EMA50 in a choppy
// trend, so the very next bar often re-triggers it) for a negative
// expectancy overall. Exiting on the ATR stop/target alone let trades hold
// ~12 bars on average and turned BTC/ETH solidly positive (+2.3%/+28.2%
// compounded) -- SOL stayed negative in every variant tried, so this is
// scoped to majors (BTC/ETH), not run on higher-volatility alts like SOL.
const TREND_DIP_ATR_EXIT_CODE = `// ctx.bars: candles [{time, open, high, low, close, volume}] up to and
// including "now" -- no lookahead. ctx.position: { direction: "long"|"short",
// entryIndex, entryPrice } or null if flat. ctx.ta: indicator helpers
// (ema, rsi, bollingerBands, atr, ...). ctx.fearGreed: aligned Fear & Greed
// history, ctx.fearGreed.at(-1) is { value, classification, time } or null.
// Return "long", "short", "close", or nothing/null to hold -- or, on entry,
// { signal: "long"|"short", stop, target } to also surface a suggested
// SL/TP in the signal check and its notification (informational only; the
// backtest still exits via this same code's own ATR check next bar, not off
// a level tagged onto the entry).
// Scoped to majors (BTC/ETH) -- backtested negative on SOL, see chat notes.

const bars = ctx.bars;
if (bars.length < 60) return;

const closes = bars.map(b => b.close);

const ema20 = ctx.ta.ema(closes, 20);
const ema50 = ctx.ta.ema(closes, 50);
const rsi = ctx.ta.rsi(closes, 14);
const bb = ctx.ta.bollingerBands(closes, 20, 2);
const atr = ctx.ta.atr(bars, 14);

const currentClose = closes.at(-1);
const currentEma20 = ema20.at(-1);
const currentEma50 = ema50.at(-1);
const currentRsi = rsi.at(-1);

if (currentEma20 === null || currentEma50 === null || currentRsi === null || !bb || !atr) {
  return;
}

const fg = ctx.fearGreed.at(-1);
const fgVal = fg ? fg.value : 50;

const pos = ctx.position;

// Exit on ATR stop/target only -- no trend-breakdown clause (see note above
// on why that clause was dropped).
if (pos) {
  const entry = pos.entryPrice;

  if (pos.direction === "long") {
    const stop = entry - (1.5 * atr);
    const tp = entry + (2.5 * atr);
    if (currentClose <= stop || currentClose >= tp) {
      return "close";
    }
  } else if (pos.direction === "short") {
    const stop = entry + (1.5 * atr);
    const tp = entry - (2.5 * atr);
    if (currentClose >= stop || currentClose <= tp) {
      return "close";
    }
  }
  return;
}

const isUptrend = currentEma20 > currentEma50;
const isDowntrend = currentEma20 < currentEma50;

// Suggested SL/TP mirror the same 1.5x/2.5x ATR distances the exit logic
// above uses, computed off the last closed bar's price as a stand-in for
// the actual fill (the next bar's open) -- a close approximation, not the
// exact level the real fill will produce.
if (isUptrend && currentClose <= bb.basis && currentRsi < 52 && fgVal < 85) {
  return { signal: "long", stop: currentClose - (1.5 * atr), target: currentClose + (2.5 * atr) };
}

if (isDowntrend && currentClose >= bb.basis && currentRsi > 48 && fgVal > 15) {
  return { signal: "short", stop: currentClose + (1.5 * atr), target: currentClose - (2.5 * atr) };
}
`;

// The Weekly/Daily/4H swing setup already validated in
// scripts/backtest-mtf-swing.js (+0.19R/trade, 309 trades across 15 liquid
// pairs at 2R) and running live in the Market/Watchlist scan
// (mtfSetup.js's attachEntry). Re-exposed here via ctx.mtf (the actual
// validated functions, not a hand-copied reimplementation that could
// silently drift) so the same rule can be backtested standalone against
// one symbol. On SOL specifically it's much thinner (+0.04R/trade, n=26,
// 95% CI overlapping breakeven) than the blended 15-pair result -- every
// SOL-only alternative tried (EMA200 touch/bounce, z-score reversion, a
// tuned parameter sweep of the former) failed an in-sample/out-of-sample
// split, so this is the best-supported SOL 4H candidate found, not a
// SOL-specific proven edge. Needs deep history for the weekly EMA20 to
// settle (~85 weeks) -- pair with History bars 3600 / warmup 2520, same
// window the backtest used (set automatically when this preset is picked).
const MTF_SWING_CODE = `// ctx.bars: 4H candles [{time, open, high, low, close, volume}] up to and
// including "now" -- no lookahead. ctx.position: { direction, entryIndex,
// entryPrice, meta } or null if flat. ctx.mtf: { buildDailyCandles,
// buildWeeklyCandles, findMtfSignal, buildTrade } -- the exact
// Weekly/Daily/4H swing setup functions the backtest and live scan use.
// Return "long", "short", "close", or nothing to hold.

const bars = ctx.bars;
const pos = ctx.position;

if (pos) {
  const { stop, target } = pos.meta ?? {};
  if (stop == null || target == null) return; // no persisted stop/target (e.g. a live signal check against a manually-set position) -- nothing to act on
  const bar = bars.at(-1);
  const barsHeld = bars.length - 1 - pos.entryIndex;
  const hitExit = pos.direction === "long" ? bar.close <= stop || bar.close >= target : bar.close >= stop || bar.close <= target;
  if (hitExit || barsHeld >= 90) return "close";
  return;
}

const daily = ctx.mtf.buildDailyCandles(bars);
const weekly = ctx.mtf.buildWeeklyCandles(daily);
const trade = ctx.mtf.buildTrade(ctx.mtf.findMtfSignal(weekly, daily, bars), 2);
if (!trade) return;

return { signal: trade.direction, stop: trade.stop, target: trade.target, meta: { stop: trade.stop, target: trade.target } };
`;

const PRESETS = [
  { key: "trendDipAtrExit", label: "Trend dip-buy, ATR stop/target exit (BTC/ETH 4H)", name: "Trend dip-buy, ATR exit", code: TREND_DIP_ATR_EXIT_CODE },
  { key: "channelMidline", label: "Channel midline flip", name: "Channel midline flip", code: CHANNEL_MIDLINE_CODE },
  { key: "pureMomentum", label: "Pure momentum (MACD cross)", name: "Pure momentum", code: PURE_MOMENTUM_CODE },
  { key: "mtfSwing", label: "MTF Weekly/Daily/4H swing (validated, thin on SOL)", name: "MTF Weekly/Daily/4H swing", code: MTF_SWING_CODE, historyBars: "3600", warmupBars: "2520" },
];

const emptyForm = {
  name: "",
  symbol: "",
  timeframe: "4h",
  historyBars: "1500",
  warmupBars: "60",
  code: PRESETS[0].code,
};

function strategyToForm(s) {
  return {
    name: s.name ?? "",
    symbol: s.symbol ?? "",
    timeframe: s.timeframe ?? "4h",
    historyBars: String(s.historyBars ?? 1500),
    warmupBars: String(s.warmupBars ?? 60),
    code: s.code ?? PRESETS[0].code,
  };
}

function formToPayload(form) {
  return {
    name: form.name.trim(),
    symbol: form.symbol.trim().toUpperCase(),
    timeframe: form.timeframe,
    historyBars: parseInt(form.historyBars, 10) || 1500,
    warmupBars: parseInt(form.warmupBars, 10) || 60,
    code: form.code,
  };
}

const inputClass =
  "rounded-lg border border-edge bg-bg px-3 py-1.5 text-[13px] text-ink outline-none focus:border-accent";

const RESULT_COLUMNS = [
  { key: "entryTime", title: "Entry time", sortValue: (r) => r.entryTime, formatter: (r) => fmtDateTime(r.entryTime) },
  {
    key: "direction",
    title: "Side",
    filter: "select",
    filterValue: (r) => r.direction,
    formatter: (r) => (
      <span className={`text-[11px] font-semibold uppercase tracking-wide ${r.direction === "short" ? "text-position-short" : "text-position-long"}`}>
        {r.direction}
      </span>
    ),
  },
  { key: "entryClose", title: "Entry", align: "right", formatter: (r) => fmtPrice(r.entryClose) },
  { key: "exitClose", title: "Exit", align: "right", formatter: (r) => fmtPrice(r.exitClose) },
  { key: "barsHeld", title: "Bars held", align: "right" },
  {
    key: "netPct",
    title: "Net %",
    align: "right",
    sortValue: (r) => r.netPct,
    formatter: (r) => (
      <span className={r.netPct >= 0 ? "text-position-long" : "text-position-short"}>
        {r.netPct >= 0 ? "+" : ""}
        {r.netPct.toFixed(2)}%
      </span>
    ),
  },
];

function StrategyFormDialog({ title, initialForm, isNew, onSubmit, onCancel }) {
  const [form, setForm] = useState(initialForm);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = (e) => {
    e.preventDefault();
    if (!form.symbol.trim() || !form.code.trim()) return;
    onSubmit(formToPayload(form));
  };

  return createPortal(
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-4">
      <form
        onSubmit={submit}
        className="flex max-h-[90vh] w-full max-w-3xl flex-col gap-3 overflow-y-auto rounded-card border border-edge bg-panel p-5 shadow-card"
      >
        <h2 className="text-[14px] font-semibold">{title}</h2>

        {isNew && (
          <label className="flex flex-col gap-1 text-[11px] text-dim">
            Start from template
            <select
              defaultValue=""
              onChange={(e) => {
                const preset = PRESETS.find((p) => p.key === e.target.value);
                if (preset)
                  setForm((f) => ({
                    ...f,
                    name: f.name || preset.name,
                    code: preset.code,
                    historyBars: preset.historyBars ?? f.historyBars,
                    warmupBars: preset.warmupBars ?? f.warmupBars,
                  }));
              }}
              className={`w-56 ${inputClass}`}
            >
              <option value="" disabled>
                Choose a starting point…
              </option>
              {PRESETS.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
        )}

        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-[11px] text-dim">
            Name
            <input
              type="text"
              value={form.name}
              onChange={set("name")}
              placeholder="e.g. Channel midline flip"
              className={`w-56 ${inputClass}`}
            />
          </label>

          <label className="flex flex-col gap-1 text-[11px] text-dim">
            Symbol
            <input
              type="text"
              required
              value={form.symbol}
              onChange={set("symbol")}
              placeholder="e.g. ETH"
              className={`w-24 uppercase ${inputClass}`}
            />
          </label>

          <label className="flex flex-col gap-1 text-[11px] text-dim">
            Timeframe
            <div className="flex gap-1 rounded-lg bg-panel-alt p-1">
              {TIMEFRAMES.map((tf) => (
                <button
                  key={tf}
                  type="button"
                  onClick={() => setForm((f) => ({ ...f, timeframe: tf }))}
                  className={`rounded-md px-2.5 py-1 text-[12px] font-medium transition-all duration-150 ${
                    form.timeframe === tf ? "bg-panel-raised text-ink shadow-sm" : "text-dim hover:text-ink"
                  }`}
                >
                  {TIMEFRAME_LABEL[tf]}
                </button>
              ))}
            </div>
          </label>

          <label className="flex flex-col gap-1 text-[11px] text-dim">
            History bars
            <input type="number" min="50" step="1" value={form.historyBars} onChange={set("historyBars")} className={`w-24 ${inputClass}`} />
          </label>

          <label className="flex flex-col gap-1 text-[11px] text-dim">
            Warmup bars
            <input type="number" min="0" step="1" value={form.warmupBars} onChange={set("warmupBars")} className={`w-24 ${inputClass}`} />
          </label>
        </div>

        <label className="flex flex-col gap-1 text-[11px] text-dim">
          Strategy code
          <textarea
            value={form.code}
            onChange={set("code")}
            rows={16}
            spellCheck={false}
            className={`resize-y font-mono text-[12px] leading-relaxed ${inputClass}`}
          />
        </label>
        <p className="text-[11px] text-dim">
          Runs once per bar as the body of a function. <code>ctx.bars</code> is candle history up to "now" (no lookahead),{" "}
          <code>ctx.position</code> is the currently open position or null. Return <code>"long"</code>, <code>"short"</code>,{" "}
          <code>"close"</code>, or nothing to hold — or, on entry, <code>{"{ signal: \"long\"|\"short\", stop, target, meta }"}</code> to
          also surface a suggested SL/TP in the signal check and its notification (informational only — the backtest still exits via your
          own code's next-bar re-evaluation, not off a level tagged onto the entry). A signal fills at the <em>next</em> bar's open, not the
          signal bar's own close — one bar of lag so the backtest can't act on a price before it could actually be traded. Runs in a
          sandboxed worker with a 15s timeout.
        </p>
        <p className="text-[11px] text-dim">
          <code>meta</code> — an optional free-form object your code can attach when opening a position; the engine persists it and hands
          it back as <code>ctx.position.meta</code> on every later bar until the position closes. It's the only way to remember something
          about your own entry beyond <code>direction</code>/<code>entryIndex</code>/<code>entryPrice</code> (which the engine already
          tracks) — e.g. <code>meta: {"{ entryAtr: atr }"}</code> to pin a stop/target to the volatility at entry instead of recomputing{" "}
          <code>atr</code> live each bar, which otherwise lets the stop/target silently drift with current volatility. Only populated in
          the backtest; the live "Check current signal" button has no persisted position to draw it from.
        </p>
        <p className="text-[11px] text-dim">
          <code>ctx.fearGreed</code> — Crypto Fear &amp; Greed Index (alternative.me), aligned 1:1 with <code>ctx.bars</code> (same length, no
          lookahead): <code>ctx.fearGreed.at(-1)</code> is <code>{"{ value, classification, time }"}</code> for the bar at{" "}
          <code>ctx.bars.at(-1)</code>, or <code>null</code> before 2018-02-01 / if the feed couldn't be fetched. <code>value</code> is 0-100 (0 =
          extreme fear, 100 = extreme greed); market-wide, not per-symbol.
        </p>
        <p className="text-[11px] text-dim">
          <code>ctx.ta</code> — note the argument shapes differ per function: <code>ema(closes, period)</code> and{" "}
          <code>rsi(closes, period)</code> take an array of closes (e.g. <code>ctx.bars.map(b =&gt; b.close)</code>), not candles, and return
          one value per bar. <code>atr(candles, period)</code> and <code>bollingerBands(closes, period, mult)</code> return a single latest
          reading, not an array — no <code>.at(-1)</code> needed; <code>bollingerBands</code> returns{" "}
          <code>{"{ upper, lower, basis, percentB, bandwidthPct }"}</code>. <code>linearRegressionChannel(candles, {"{ lookback }"})</code> returns
          one <code>{"{ mid, upper, lower }"}</code> per bar in the window. Also available: <code>macd</code>, <code>zScore</code>,{" "}
          <code>rollingMean</code>, <code>rollingStd</code>, <code>findSwingLevels</code>, <code>analyzeCandles</code>.
        </p>
        <p className="text-[11px] text-dim">
          <code>ctx.mtf</code> — <code>{"{ buildDailyCandles, buildWeeklyCandles, findMtfSignal, buildTrade }"}</code>, the exact
          Weekly/Daily/4H swing setup functions the Market/Watchlist scan and its backtest use, re-exposed so a strategy can run that same
          validated rule standalone. <code>buildDailyCandles(bars)</code> and <code>buildWeeklyCandles(daily)</code> resample up from{" "}
          <code>ctx.bars</code> (dropping any still-forming trailing bucket); <code>findMtfSignal(weekly, daily, bars)</code> returns a
          signal or null; <code>buildTrade(signal, rMultiple)</code> turns it into <code>{"{ direction, entry, stop, target, rr }"}</code>.
          See the MTF preset above for the intended shape.
        </p>

        <div className="flex items-center gap-2">
          <button type="submit" className="rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white hover:opacity-90">
            Save strategy
          </button>
          <button type="button" onClick={onCancel} className="rounded-lg px-3 py-1.5 text-[13px] text-dim hover:text-ink">
            Cancel
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

function StatTile({ label, value, tone }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-dim">{label}</div>
      <div className={`mt-0.5 text-[15px] font-semibold ${tone === "up" ? "text-position-long" : tone === "down" ? "text-position-short" : "text-ink"}`}>
        {value}
      </div>
    </div>
  );
}

function StrategyResult({ result }) {
  if (!result) return null;

  if (result.status === "running") {
    return <p className="mt-3 border-t border-edge pt-3 text-[12px] text-dim">Fetching history and running backtest…</p>;
  }

  if (result.status === "error") {
    return <p className="mt-3 border-t border-edge pt-3 text-[12px] text-position-short">{result.message}</p>;
  }

  const { summary, holdPct, ranAt } = result;

  if (summary.n === 0) {
    return (
      <p className="mt-3 border-t border-edge pt-3 text-[12px] text-dim">
        No trades over this window — the strategy never returned "long" or "short".
      </p>
    );
  }

  return (
    <div className="mt-3 flex flex-col gap-3 border-t border-edge pt-3">
      <div className="grid grid-cols-2 gap-3 text-[13px] sm:grid-cols-4">
        <StatTile label="Trades" value={summary.n} />
        <StatTile label="Win rate" value={`${(summary.winRate * 100).toFixed(1)}%`} />
        <StatTile
          label="Expectancy / trade"
          value={`${summary.expectancyPct >= 0 ? "+" : ""}${summary.expectancyPct.toFixed(2)}%`}
          tone={summary.expectancyPct >= 0 ? "up" : "down"}
        />
        <StatTile
          label="Compounded return"
          value={`${summary.compoundedPct >= 0 ? "+" : ""}${summary.compoundedPct.toFixed(1)}%`}
          tone={summary.compoundedPct >= 0 ? "up" : "down"}
        />
      </div>
      <p className="text-[12px] text-dim">
        Avg win +{summary.avgWinPct.toFixed(2)}% · avg loss {summary.avgLossPct.toFixed(2)}% · avg hold {summary.avgBarsHeld.toFixed(1)} bars · 95% CI
        on win rate {(summary.ci[0] * 100).toFixed(1)}%–{(summary.ci[1] * 100).toFixed(1)}%
        {holdPct != null && (
          <>
            {" "}
            · buy-and-hold over same window: {holdPct >= 0 ? "+" : ""}
            {holdPct.toFixed(1)}%
          </>
        )}
        {" "}(fees included, 0.2% round trip per trade)
        {ranAt && <> · last run {fmtDateTime(ranAt)}</>}
      </p>
      {result.trades ? (
        <DataTable columns={RESULT_COLUMNS} data={result.trades} emptyText="No trades" pageSize={10} initialSort={{ key: "entryTime", dir: -1 }} />
      ) : (
        <p className="text-[12px] text-dim">Trade-by-trade list isn't kept between sessions — click "Run backtest" to see it again.</p>
      )}
    </div>
  );
}

const SIGNAL_LABEL = {
  long: { text: "LONG", detail: "your code says go long", tone: "up" },
  short: { text: "SHORT", detail: "your code says go short", tone: "down" },
  close: { text: "CLOSE", detail: "your code says exit the open position", tone: "neutral" },
};

// Literal output of the user's own function on the latest closed bar — not
// a recommendation. Framed as "your rule says X", and explicitly reminds
// that a signal reading says nothing about whether the rule is any good;
// only the backtest above answers that.
function SignalResult({ result }) {
  if (!result) return null;

  if (result.status === "running") {
    return <p className="mt-2 text-[12px] text-dim">Fetching the latest candle and evaluating…</p>;
  }
  if (result.status === "error") {
    return <p className="mt-2 text-[12px] text-position-short">{result.message}</p>;
  }

  const { bar } = result;
  const { direction, stop, target } = normalizeSignal(result.signal);
  const label = SIGNAL_LABEL[direction];

  return (
    <div className="mt-2 text-[12px]">
      <span
        className={`font-semibold ${label ? (label.tone === "up" ? "text-position-long" : label.tone === "down" ? "text-position-short" : "text-accent") : "text-dim"}`}
      >
        {label ? label.text : "NO SIGNAL"}
      </span>
      <span className="text-dim">
        {" "}
        — {label ? label.detail : "your code returned nothing on this bar (hold / stay flat)"}. As of the last closed bar,{" "}
        {fmtDateTime(bar.time)} @ {fmtPrice(bar.close)}. This is your rule's raw output, not a recommendation — and it doesn't mean the rule has
        an edge; check the backtest above for that.
      </span>
      {stop != null && target != null && (
        <div className="mt-1 text-dim">
          Suggested stop <span className="text-ink">{fmtPrice(stop)}</span> · target <span className="text-ink">{fmtPrice(target)}</span> —
          based on the last closed bar's price, not your actual fill.
        </div>
      )}
    </div>
  );
}

function PositionInput({ value, onChange }) {
  const direction = value?.direction ?? "flat";
  return (
    <div className="flex flex-wrap items-center gap-2 text-[12px]">
      <span className="text-dim">Currently:</span>
      <div className="flex gap-1 rounded-lg bg-panel-alt p-1">
        {["flat", "long", "short"].map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => onChange({ ...value, direction: d })}
            className={`rounded-md px-2.5 py-1 text-[12px] font-medium capitalize transition-all duration-150 ${
              direction === d ? "bg-panel-raised text-ink shadow-sm" : "text-dim hover:text-ink"
            }`}
          >
            {d}
          </button>
        ))}
      </div>
      {direction !== "flat" && (
        <input
          type="number"
          step="any"
          placeholder="entry price"
          value={value?.entryPrice ?? ""}
          onChange={(e) => onChange({ ...value, entryPrice: e.target.value })}
          className={`w-28 ${inputClass}`}
        />
      )}
    </div>
  );
}

function AutoCheckToggle({ strategy, blocked, onToggle, onPollMinutesChange }) {
  const enabled = !!strategy.autoCheck;
  return (
    <div className="flex flex-wrap items-center gap-2 text-[12px]">
      <label className="flex items-center gap-1.5 text-dim">
        <input type="checkbox" checked={enabled} onChange={(e) => onToggle(e.target.checked)} />
        Auto-check every
      </label>
      <select
        value={strategy.pollMinutes ?? 15}
        onChange={(e) => onPollMinutesChange(Number(e.target.value))}
        disabled={!enabled}
        className={`${inputClass} py-1`}
      >
        {POLL_MINUTES_OPTIONS.map((m) => (
          <option key={m} value={m}>
            {m} min
          </option>
        ))}
      </select>
      {enabled && !blocked && <span className="text-dim">— notifies on a new signal, using the position set below</span>}
      {enabled && blocked && (
        <span className="text-position-short">Notifications are blocked for this app — enable them in your OS settings to get alerts.</span>
      )}
    </div>
  );
}

function StrategyCard({ strategy, result, signalResult, positionInput, onPositionChange, onRun, onCheckSignal, onToggleAutoCheck, onPollMinutesChange, notifBlocked, onEdit, onDelete }) {
  const running = result?.status === "running";
  const checkingSignal = signalResult?.status === "running";
  return (
    <div className="rounded-card border border-edge bg-panel p-5 shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-[14px] font-semibold">{strategy.name || strategy.symbol}</h3>
          <p className="text-[11px] text-dim">
            {strategy.symbol} · {TIMEFRAME_LABEL[strategy.timeframe]} · {strategy.historyBars} bars history · {strategy.warmupBars} bar warmup
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onRun}
            disabled={running}
            className="rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {running ? "Running…" : "Run backtest"}
          </button>
          <button type="button" onClick={onEdit} className="rounded-lg border border-edge px-2.5 py-1 text-[12px] font-medium text-ink hover:bg-panel-alt">
            Edit
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="rounded-lg border border-edge px-2.5 py-1 text-[12px] font-medium text-position-short hover:bg-panel-alt"
          >
            Delete
          </button>
        </div>
      </div>
      <StrategyResult result={result} />

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-edge pt-3">
        <PositionInput value={positionInput} onChange={onPositionChange} />
        <button
          type="button"
          onClick={onCheckSignal}
          disabled={checkingSignal}
          className="rounded-lg border border-edge px-2.5 py-1 text-[12px] font-medium text-ink hover:bg-panel-alt disabled:cursor-not-allowed disabled:opacity-40"
        >
          {checkingSignal ? "Checking…" : "Check current signal"}
        </button>
      </div>
      <SignalResult result={signalResult} />

      <div className="mt-3 border-t border-edge pt-3">
        <AutoCheckToggle
          strategy={strategy}
          blocked={notifBlocked}
          onToggle={(checked) => onToggleAutoCheck(checked)}
          onPollMinutesChange={onPollMinutesChange}
        />
      </div>
    </div>
  );
}

export default function StrategiesPanel() {
  const strategies = useStrategies();
  const [editingId, setEditingId] = useState(null); // "new" | existing strategy id | null
  const [results, setResults] = useState({});
  const [signals, setSignals] = useState({});
  const [positionInputs, setPositionInputs] = useState({});
  const [notifBlocked, setNotifBlocked] = useState(false);
  const [testStatus, setTestStatus] = useState(null);

  // Checked once up front (not gated on a strategy having autoCheck on yet)
  // so a strategy saved with autoCheck from a previous session shows the
  // "blocked" warning immediately instead of only after the checkbox is
  // re-toggled.
  useEffect(() => {
    ensureNotificationPermission().then((status) => setNotifBlocked(status === "denied"));
  }, []);

  // Backfills each strategy's persisted lastBacktest (see runStrategy below)
  // into the in-memory results state once on load, so a backtest result
  // survives an app restart instead of vanishing until "Run backtest" is
  // clicked again. Guarded by `!(s.id in next)` so this never clobbers a
  // fresher in-memory result with a stale persisted one -- it only fills in
  // ids that haven't been run yet this session.
  useEffect(() => {
    setResults((r) => {
      let changed = false;
      const next = { ...r };
      for (const s of strategies.strategies) {
        if (s.lastBacktest && !(s.id in next)) {
          next[s.id] = s.lastBacktest;
          changed = true;
        }
      }
      return changed ? next : r;
    });
  }, [strategies.strategies]);

  const editingStrategy = editingId && editingId !== "new" ? strategies.strategies.find((s) => s.id === editingId) : null;

  const runStrategy = async (strategy) => {
    setResults((r) => ({ ...r, [strategy.id]: { status: "running" } }));
    try {
      const candles = await getCachedCandles(strategy.symbol, strategy.timeframe, strategy.historyBars);
      if (candles.length < strategy.warmupBars + 10) {
        throw new Error(`Only got ${candles.length} candles for ${strategy.symbol} — not enough history for a ${strategy.warmupBars}-bar warmup.`);
      }
      const trades = await runStrategyBacktest({ candles, code: strategy.code, warmupBars: strategy.warmupBars });
      const summary = summarizeTrades(trades);
      const holdPct = buyHoldPct(candles.slice(strategy.warmupBars));
      const ranAt = new Date().toISOString();
      // The per-trade list is only kept in memory for this session's table
      // view -- persisted state is just the summary, so a strategy with a
      // few hundred trades doesn't bloat the strategies store file on every
      // run.
      setResults((r) => ({ ...r, [strategy.id]: { status: "done", trades, summary, holdPct, ranAt } }));
      strategies.update(strategy.id, { lastBacktest: { status: "done", summary, holdPct, ranAt } });
    } catch (err) {
      setResults((r) => ({ ...r, [strategy.id]: { status: "error", message: err.message } }));
    }
  };

  // Shared by the manual "Check current signal" button and the background
  // poller below -- both need the exact same read (same position input,
  // same signals-state update) so a poll tick and a manual click can't show
  // conflicting results. Returns the { signal, bar } outcome (or undefined on
  // error, already surfaced via the signals state) so the poller can decide
  // whether it's new enough to notify on.
  const runSignalCheck = async (strategy) => {
    const input = positionInputs[strategy.id] ?? { direction: "flat", entryPrice: "" };
    const position =
      input.direction === "flat"
        ? null
        : { direction: input.direction, entryPrice: input.entryPrice === "" ? null : parseFloat(input.entryPrice), entryIndex: null };

    setSignals((s) => ({ ...s, [strategy.id]: { status: "running" } }));
    try {
      // Only needs enough trailing history for the strategy's own
      // indicators to warm up — reuses the strategy's saved historyBars so
      // the live read sees the same amount of context the backtest did, and
      // shares the same cache entry as "Run backtest" for this strategy.
      const candles = await getCachedCandles(strategy.symbol, strategy.timeframe, strategy.historyBars);
      if (candles.length < strategy.warmupBars + 1) {
        throw new Error(`Only got ${candles.length} candles for ${strategy.symbol} — not enough history for a ${strategy.warmupBars}-bar warmup.`);
      }
      const { signal, bar } = await runStrategySignal({ candles, code: strategy.code, position });
      setSignals((s) => ({ ...s, [strategy.id]: { status: "done", signal, bar } }));
      return { signal, bar };
    } catch (err) {
      setSignals((s) => ({ ...s, [strategy.id]: { status: "error", message: err.message } }));
    }
  };

  useSignalPolling(strategies.strategies, runSignalCheck);

  // Page-level preview, not tied to any one card. Uses the first saved
  // strategy's real signal check (same as "Check current signal") so the
  // toast's bar/stop/target are genuine when possible; falls back to a
  // placeholder name when there are no strategies yet.
  const testNotify = async () => {
    const strategy = strategies.strategies[0];
    const outcome = strategy ? await runSignalCheck(strategy) : undefined;
    const status = await sendTestNotification(strategy ?? { name: "Test strategy", symbol: "TEST", timeframe: "4h" }, outcome);
    setTestStatus(status);
    if (status === "denied") setNotifBlocked(true);
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-[14px] font-semibold">Strategies</h2>
          <p className="text-[11px] text-dim">Write a bar-by-bar rule and backtest it against real OKX history, right here.</p>
        </div>
        <div className="flex items-center gap-2">
          {testStatus === "denied" && (
            <span className="text-[11px] text-position-short">Denied — enable notifications for this app in your OS settings.</span>
          )}
          <button
            type="button"
            onClick={testNotify}
            className="rounded-lg border border-edge px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-panel-alt"
          >
            Send test notification
          </button>
          <button
            type="button"
            onClick={() => setEditingId("new")}
            className="rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white hover:opacity-90"
          >
            + New strategy
          </button>
        </div>
      </div>

      {strategies.strategies.length === 0 && (
        <div className="rounded-card border border-edge bg-panel p-8 text-center text-[13px] text-dim shadow-card">
          No strategies yet — write one to backtest a rule against real history instead of a one-off script.
        </div>
      )}

      <div className="flex flex-col gap-4">
        {strategies.strategies.map((s) => (
          <StrategyCard
            key={s.id}
            strategy={s}
            result={results[s.id]}
            signalResult={signals[s.id]}
            positionInput={positionInputs[s.id]}
            onPositionChange={(next) => setPositionInputs((p) => ({ ...p, [s.id]: next }))}
            onRun={() => runStrategy(s)}
            onCheckSignal={() => runSignalCheck(s)}
            onToggleAutoCheck={async (checked) => {
              if (checked) {
                const status = await ensureNotificationPermission();
                setNotifBlocked(status === "denied");
              }
              strategies.update(s.id, { autoCheck: checked });
            }}
            onPollMinutesChange={(minutes) => strategies.update(s.id, { pollMinutes: minutes })}
            notifBlocked={notifBlocked}
            onEdit={() => setEditingId(s.id)}
            onDelete={() => {
              strategies.remove(s.id);
              setResults((r) => {
                const { [s.id]: _, ...rest } = r;
                return rest;
              });
              setSignals((sg) => {
                const { [s.id]: _, ...rest } = sg;
                return rest;
              });
              setPositionInputs((p) => {
                const { [s.id]: _, ...rest } = p;
                return rest;
              });
            }}
          />
        ))}
      </div>

      {editingId && (
        <StrategyFormDialog
          title={editingId === "new" ? "New strategy" : `Edit ${editingStrategy?.name || editingStrategy?.symbol}`}
          isNew={editingId === "new"}
          initialForm={editingStrategy ? strategyToForm(editingStrategy) : emptyForm}
          onSubmit={(payload) => {
            if (editingId === "new") {
              strategies.add(payload);
            } else {
              // Editing the code/symbol/params invalidates any persisted
              // backtest result -- it no longer reflects what's saved, so
              // it's cleared rather than left showing a stale result.
              strategies.update(editingId, { ...payload, lastBacktest: null });
              setResults((r) => {
                const { [editingId]: _, ...rest } = r;
                return rest;
              });
            }
            setEditingId(null);
          }}
          onCancel={() => setEditingId(null)}
        />
      )}
    </div>
  );
}
