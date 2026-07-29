import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import DataTable from "./DataTable.jsx";
import { ensureNotificationPermission, sendTestNotification } from "../hooks/useSignalPolling.js";
import { normalizeSignal } from "../lib/strategySignal.js";
import { TIMEFRAMES } from "../lib/analysis/okx.js";
import { getCachedCandles } from "../lib/candleCache.js";
import { runStrategyBacktest, notEnoughHistoryError } from "../lib/strategyEngine.js";
import { summarizeTrades, buyHoldPct } from "../lib/backtestStats.js";
import { fmtDateTime, fmtPrice } from "../lib/format.js";

const TIMEFRAME_LABEL = { "15m": "15m", "1h": "1H", "4h": "4H", "1d": "1D", "1w": "1W" };
const POLL_MINUTES_OPTIONS = [5, 15, 30, 60];

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

// User-drafted variant of the preset above: wider ATR stop/target (2.0x/3.5x
// vs 1.5x/2.5x), a looser pullback trigger (RSI<45 OR touch of the lower/
// upper Bollinger band, vs RSI<52 AND touch of the basis), and -- the part
// worth being wary of, since an earlier "trend breakdown" exit clause was
// exactly what got dropped from the preset above for causing 60-70% same-bar
// exits -- an EMA20/50 dead-cross exit layered on top of the ATR stop/target.
// Backtested honestly before trusting it (scripts/backtest-trend-dip-v2.js):
// this dead-cross variant does NOT reproduce that failure mode (only 9-14%
// of trades closed within 1 bar, vs the ~60-70% the earlier clause had), and
// trades better risk-adjusted than the original -- lower drawdown/higher
// Calmar for somewhat less raw return:
//   BTC 4H: n=24, +17.4% compounded, -6.3% max drawdown, Calmar 4.40
//   ETH 4H: n=23, +20.9% compounded, -14.4% max drawdown, Calmar 2.35
//   SOL 4H: n=22, -0.6% compounded, Calmar -0.06 (flat/negative)
// Same "majors only" pattern as the original -- SOL doesn't work here either.
// n=22-24 per symbol is a modest sample (wide win-rate CIs), consistent
// direction across BTC/ETH is what makes this worth keeping, not proof.
const TREND_DIP_ATR_EXIT_V2_CODE = `// ctx.bars: candles [{time, open, high, low, close, volume}] up to and
// including "now" -- no lookahead. ctx.position: { direction: "long"|"short",
// entryIndex, entryPrice } or null if flat. ctx.ta: indicator helpers
// (ema, rsi, bollingerBands, atr, ...). ctx.fearGreed: aligned Fear & Greed
// history, ctx.fearGreed.at(-1) is { value, classification, time } or null.
// Return "long", "short", "close", or nothing/null to hold -- or, on entry,
// { signal: "long"|"short", stop, target } to also surface a suggested
// SL/TP in the signal check and its notification.
// Scoped to majors (BTC/ETH) -- flat/negative on SOL, see chat notes.

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
const pastEma20 = ema20.at(-2);
const currentEma50 = ema50.at(-1);
const pastEma50 = ema50.at(-2);
const currentRsi = rsi.at(-1);

if (currentEma20 === null || currentEma50 === null || currentRsi === null || !bb || !atr) {
  return;
}

const fg = ctx.fearGreed.at(-1);
const fgVal = fg ? fg.value : 50;

const pos = ctx.position;

// Exit on ATR stop/target OR an EMA20/50 dead-cross trend reversal --
// backtested to confirm this doesn't reproduce the same-bar-exit problem an
// earlier trend-breakdown clause had (see note above).
if (pos) {
  const entry = pos.entryPrice;

  if (pos.direction === "long") {
    const stop = entry - (2.0 * atr);
    const tp = entry + (3.5 * atr);
    const trendReversal = currentEma20 < currentEma50 && pastEma20 >= pastEma50;
    if (trendReversal || currentClose <= stop || currentClose >= tp) {
      return "close";
    }
  } else if (pos.direction === "short") {
    const stop = entry + (2.0 * atr);
    const tp = entry - (3.5 * atr);
    const trendReversal = currentEma20 > currentEma50 && pastEma20 <= pastEma50;
    if (trendReversal || currentClose >= stop || currentClose <= tp) {
      return "close";
    }
  }
  return;
}

const isUptrend = currentEma20 > currentEma50;
const isDowntrend = currentEma20 < currentEma50;

const isNotExtremeGreed = fgVal < 75;
const isNotExtremeFear = fgVal > 25;

const isLongPullback = currentRsi < 45 || currentClose <= bb.lower;
const isShortBounce = currentRsi > 55 || currentClose >= bb.upper;

if (isUptrend && isLongPullback && isNotExtremeGreed) {
  return { signal: "long", stop: currentClose - (2.0 * atr), target: currentClose + (3.5 * atr) };
}

if (isDowntrend && isShortBounce && isNotExtremeFear) {
  return { signal: "short", stop: currentClose + (2.0 * atr), target: currentClose - (3.5 * atr) };
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
  {
    key: "trendDipAtrExitV2",
    label: "Trend dip-buy v2, wider ATR + dead-cross exit (BTC/ETH 4H, better Calmar)",
    name: "Trend dip-buy v2, wider ATR + dead-cross exit",
    code: TREND_DIP_ATR_EXIT_V2_CODE,
  },
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
        <details className="text-[11px] text-dim">
          <summary className="cursor-pointer select-none hover:text-ink">Reference: ctx API</summary>
          <div className="mt-2 flex flex-col gap-2">
            <p>
              Runs once per bar as the body of a function. <code>ctx.bars</code> is candle history up to "now" (no lookahead),{" "}
              <code>ctx.position</code> is the currently open position or null. Return <code>"long"</code>, <code>"short"</code>,{" "}
              <code>"close"</code>, or nothing to hold — or, on entry, <code>{"{ signal: \"long\"|\"short\", stop, target, meta }"}</code> to
              also surface a suggested SL/TP in the signal check and its notification (informational only — the backtest still exits via your
              own code's next-bar re-evaluation, not off a level tagged onto the entry). A signal fills at the <em>next</em> bar's open, not the
              signal bar's own close — one bar of lag so the backtest can't act on a price before it could actually be traded. Runs in a
              sandboxed worker with a 15s timeout.
            </p>
            <p>
              <code>meta</code> — an optional free-form object your code can attach when opening a position; the engine persists it and hands
              it back as <code>ctx.position.meta</code> on every later bar until the position closes. It's the only way to remember something
              about your own entry beyond <code>direction</code>/<code>entryIndex</code>/<code>entryPrice</code> (which the engine already
              tracks) — e.g. <code>meta: {"{ entryAtr: atr }"}</code> to pin a stop/target to the volatility at entry instead of recomputing{" "}
              <code>atr</code> live each bar, which otherwise lets the stop/target silently drift with current volatility. Only populated in
              the backtest; the live "Check current signal" button has no persisted position to draw it from.
            </p>
            <p>
              <code>ctx.fearGreed</code> — Crypto Fear &amp; Greed Index (alternative.me), aligned 1:1 with <code>ctx.bars</code> (same length, no
              lookahead): <code>ctx.fearGreed.at(-1)</code> is <code>{"{ value, classification, time }"}</code> for the bar at{" "}
              <code>ctx.bars.at(-1)</code>, or <code>null</code> before 2018-02-01 / if the feed couldn't be fetched. <code>value</code> is 0-100 (0 =
              extreme fear, 100 = extreme greed); market-wide, not per-symbol.
            </p>
            <p>
              <code>ctx.ta</code> — note the argument shapes differ per function: <code>ema(closes, period)</code> and{" "}
              <code>rsi(closes, period)</code> take an array of closes (e.g. <code>ctx.bars.map(b =&gt; b.close)</code>), not candles, and return
              one value per bar. <code>atr(candles, period)</code> and <code>bollingerBands(closes, period, mult)</code> return a single latest
              reading, not an array — no <code>.at(-1)</code> needed; <code>bollingerBands</code> returns{" "}
              <code>{"{ upper, lower, basis, percentB, bandwidthPct }"}</code>. <code>linearRegressionChannel(candles, {"{ lookback }"})</code> returns
              one <code>{"{ mid, upper, lower }"}</code> per bar in the window. Also available: <code>macd</code>, <code>zScore</code>,{" "}
              <code>rollingMean</code>, <code>rollingStd</code>, <code>findSwingLevels</code>, <code>analyzeCandles</code>.
            </p>
            <p>
              <code>ctx.mtf</code> — <code>{"{ buildDailyCandles, buildWeeklyCandles, findMtfSignal, buildTrade }"}</code>, the exact
              Weekly/Daily/4H swing setup functions the Market/Watchlist scan and its backtest use, re-exposed so a strategy can run that same
              validated rule standalone. <code>buildDailyCandles(bars)</code> and <code>buildWeeklyCandles(daily)</code> resample up from{" "}
              <code>ctx.bars</code> (dropping any still-forming trailing bucket); <code>findMtfSignal(weekly, daily, bars)</code> returns a
              signal or null; <code>buildTrade(signal, rMultiple)</code> turns it into <code>{"{ direction, entry, stop, target, rr }"}</code>.
              See the MTF preset above for the intended shape.
            </p>
          </div>
        </details>

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

// Colored value span for a stat -- the label now lives in the summary
// table's column header (see StrategiesPanel's columns), not repeated here.
function StatCell({ value, tone }) {
  return <span className={tone === "up" ? "text-position-long" : tone === "down" ? "text-position-short" : "text-ink"}>{value}</span>;
}

// Supporting detail for a strategy's backtest -- the headline numbers
// (trades, win rate, expectancy, compounded return, max drawdown, Calmar)
// live in the summary table row directly above this (see StrategiesPanel's
// columns), so this only carries what didn't fit there: the underlying
// avg win/loss/CI/buy-hold context and the full trade-by-trade list.
function StrategyResult({ result }) {
  if (!result) return null;

  if (result.status === "running") {
    return <p className="text-[12px] text-dim">Fetching history and running backtest…</p>;
  }

  if (result.status === "error") {
    return <p className="text-[12px] text-position-short">{result.message}</p>;
  }

  const { summary, holdPct, ranAt } = result;

  if (summary.n === 0) {
    return <p className="text-[12px] text-dim">No trades over this window — the strategy never returned "long" or "short".</p>;
  }

  // Trades are pushed in chronological order as the backtest loop runs, so
  // the last element is the most recent one to have CLOSED -- if a position
  // was still open on the final bar of the window, it never got pushed to
  // `trades` at all (see strategyWorker.js), so this can lag the truth by
  // one open trade rather than always being "the very last thing the
  // strategy did."
  const lastTrade = result.trades?.at(-1);

  return (
    <div className="flex flex-col gap-3">
      {lastTrade && (
        <p className="text-[12px]">
          <span className="text-dim">Last signal: </span>
          <span className={`font-semibold uppercase tracking-wide ${lastTrade.direction === "short" ? "text-position-short" : "text-position-long"}`}>
            {lastTrade.direction}
          </span>
          <span className="text-dim">
            {" "}
            entered {fmtDateTime(lastTrade.entryTime)} @ {fmtPrice(lastTrade.entryClose)}, closed {fmtDateTime(lastTrade.exitTime)} @{" "}
            {fmtPrice(lastTrade.exitClose)} ({lastTrade.netPct >= 0 ? "+" : ""}
            {lastTrade.netPct.toFixed(2)}%)
          </span>
        </p>
      )}
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
  long: { text: "LONG", tone: "up" },
  short: { text: "SHORT", tone: "down" },
  close: { text: "CLOSE", tone: "neutral" },
};

// Literal output of the user's own function on the latest closed bar.
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
        @ {fmtPrice(bar.close)} · {fmtDateTime(bar.time)}
        {stop != null && target != null && (
          <>
            {" "}
            · stop <span className="text-ink">{fmtPrice(stop)}</span> · target <span className="text-ink">{fmtPrice(target)}</span>
          </>
        )}
      </span>
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

// Expanded-row detail for one strategy (see StrategiesPanel's renderExpanded)
// -- Run/Edit/Delete live in the summary table's Actions column, and
// auto-check is a live checkbox+interval in its own column (see
// StrategiesPanel's columns), both so those controls work without opening
// this panel at all.
function StrategyDetail({ result, signalResult, positionInput, onPositionChange, onCheckSignal }) {
  const checkingSignal = signalResult?.status === "running";
  return (
    <div className="flex flex-col gap-3">
      <StrategyResult result={result} />

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-edge pt-3">
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
    </div>
  );
}

export default function StrategiesPanel({ strategies, strategySignals }) {
  const [editingId, setEditingId] = useState(null); // "new" | existing strategy id | null
  const [results, setResults] = useState({});
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

  // Every strategy gets a live signal check as soon as the tab loads, not
  // just autoCheck ones (that flag only governs background polling/
  // notifications) -- otherwise the Signal column sits on "—" until the
  // user clicks "Check current signal" per row. `main`'s key={tab} in
  // App.jsx remounts this component each time the tab is opened, so `[]`
  // means "once per visit to this tab", same intent as the notifBlocked
  // effect above.
  useEffect(() => {
    strategies.strategies.forEach((s) => strategySignals.runSignalCheck(s));
  }, []);

  const editingStrategy = editingId && editingId !== "new" ? strategies.strategies.find((s) => s.id === editingId) : null;

  const runStrategy = async (strategy) => {
    setResults((r) => ({ ...r, [strategy.id]: { status: "running" } }));
    try {
      const candles = await getCachedCandles(strategy.symbol, strategy.timeframe, strategy.historyBars);
      if (candles.length < strategy.warmupBars + 10) {
        throw notEnoughHistoryError(strategy.symbol, strategy.warmupBars, candles.length);
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

  // Page-level preview, not tied to any one row. Uses the first saved
  // strategy's real signal check (same as "Check current signal") so the
  // toast's bar/stop/target are genuine when possible; falls back to a
  // placeholder name when there are no strategies yet.
  const testNotify = async () => {
    const strategy = strategies.strategies[0];
    const outcome = strategy ? await strategySignals.runSignalCheck(strategy) : undefined;
    const status = await sendTestNotification(strategy ?? { name: "Test strategy", symbol: "TEST", timeframe: "4h" }, outcome);
    setTestStatus(status);
    if (status === "denied") setNotifBlocked(true);
  };

  const deleteStrategy = (id) => {
    strategies.remove(id);
    setResults((r) => {
      const { [id]: _, ...rest } = r;
      return rest;
    });
    strategySignals.clearStrategy(id);
  };

  const toggleAutoCheck = async (id, checked) => {
    if (checked) {
      const status = await ensureNotificationPermission();
      setNotifBlocked(status === "denied");
    }
    strategies.update(id, { autoCheck: checked });
  };

  // Defined inline (not lifted to a separate module like scanColumns.jsx's
  // buildScanColumns) since formatters need to close over `results` and
  // `strategySignals` -- unlike the Market/Watchlist columns, which only
  // render static row data.
  const columns = [
    {
      key: "name",
      title: "Strategy",
      filter: "text",
      filterValue: (r) => `${r.name} ${r.symbol}`,
      sortValue: (r) => r.name || r.symbol,
      formatter: (r) => (
        <div>
          <div className="font-medium text-ink">{r.name || r.symbol}</div>
          <div className="text-[11px] text-dim">
            {r.symbol} · {TIMEFRAME_LABEL[r.timeframe]} · {r.historyBars} bars
          </div>
        </div>
      ),
    },
    {
      key: "trades",
      title: "Trades",
      align: "right",
      sortValue: (r) => results[r.id]?.summary?.n ?? -1,
      formatter: (r) => (results[r.id]?.status === "done" ? results[r.id].summary.n : "—"),
    },
    {
      key: "winRate",
      title: "Win rate",
      align: "right",
      sortValue: (r) => results[r.id]?.summary?.winRate ?? -1,
      formatter: (r) => {
        const s = results[r.id];
        return s?.status === "done" ? `${(s.summary.winRate * 100).toFixed(1)}%` : "—";
      },
    },
    {
      key: "expectancy",
      title: "Expectancy",
      align: "right",
      sortValue: (r) => results[r.id]?.summary?.expectancyPct ?? -Infinity,
      formatter: (r) => {
        const s = results[r.id];
        if (s?.status !== "done") return "—";
        const v = s.summary.expectancyPct;
        return <StatCell value={`${v >= 0 ? "+" : ""}${v.toFixed(2)}%`} tone={v >= 0 ? "up" : "down"} />;
      },
    },
    {
      key: "compounded",
      title: "Compounded",
      align: "right",
      sortValue: (r) => results[r.id]?.summary?.compoundedPct ?? -Infinity,
      formatter: (r) => {
        const s = results[r.id];
        if (s?.status !== "done") return "—";
        const v = s.summary.compoundedPct;
        return <StatCell value={`${v >= 0 ? "+" : ""}${v.toFixed(1)}%`} tone={v >= 0 ? "up" : "down"} />;
      },
    },
    {
      key: "maxDrawdown",
      title: "Max DD",
      align: "right",
      sortValue: (r) => results[r.id]?.summary?.maxDrawdownPct ?? -1,
      formatter: (r) => {
        const s = results[r.id];
        if (s?.status !== "done" || s.summary.maxDrawdownPct == null) return "—";
        const v = s.summary.maxDrawdownPct;
        return <StatCell value={`-${v.toFixed(1)}%`} tone={v > 0 ? "down" : undefined} />;
      },
    },
    {
      key: "calmar",
      title: "Calmar",
      align: "right",
      sortValue: (r) => results[r.id]?.summary?.calmarRatio ?? -Infinity,
      formatter: (r) => {
        const s = results[r.id];
        if (s?.status !== "done" || s.summary.calmarRatio == null) return "—";
        const v = s.summary.calmarRatio;
        return <StatCell value={v.toFixed(2)} tone={v >= 1 ? "up" : "down"} />;
      },
    },
    {
      key: "signal",
      title: "Signal",
      sortValue: (r) => strategySignals.signals[r.id]?.signal ?? "",
      formatter: (r) => {
        const sig = strategySignals.signals[r.id];
        if (!sig || sig.status !== "done") return <span className="text-dim">—</span>;
        const { direction } = normalizeSignal(sig.signal);
        const label = SIGNAL_LABEL[direction];
        return (
          <span
            className={`text-[11px] font-semibold ${label ? (label.tone === "up" ? "text-position-long" : label.tone === "down" ? "text-position-short" : "text-accent") : "text-dim"}`}
          >
            {label ? label.text : "NO SIGNAL"}
          </span>
        );
      },
    },
    {
      key: "autoCheck",
      title: "Auto-check",
      sortValue: (r) => (r.autoCheck ? (r.pollMinutes ?? 15) : -1),
      // A live control, not just a status badge -- this is the actual
      // enable/disable switch for notifications, kept at row level (not
      // behind the expand toggle) since flipping it on/off is the single
      // most common thing to want to do to a strategy without digging in.
      formatter: (r) => (
        <div className="flex items-center gap-1.5">
          <label className="flex items-center gap-1 text-[12px] text-dim" title={r.autoCheck ? "Disable notifications" : "Enable notifications"}>
            <input type="checkbox" checked={!!r.autoCheck} onChange={(e) => toggleAutoCheck(r.id, e.target.checked)} />
          </label>
          <select
            value={r.pollMinutes ?? 15}
            onChange={(e) => strategies.update(r.id, { pollMinutes: Number(e.target.value) })}
            disabled={!r.autoCheck}
            className="rounded border border-edge bg-bg px-1 py-0.5 text-[11px] text-ink outline-none disabled:opacity-40"
          >
            {POLL_MINUTES_OPTIONS.map((m) => (
              <option key={m} value={m}>
                {m}m
              </option>
            ))}
          </select>
          {r.autoCheck && notifBlocked && (
            <span className="text-position-short" title="Notifications are blocked for this app — enable them in your OS settings to get alerts.">
              ⚠
            </span>
          )}
        </div>
      ),
    },
    {
      key: "actions",
      title: "",
      sortable: false,
      formatter: (r) => (
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => runStrategy(r)}
            disabled={results[r.id]?.status === "running"}
            className="rounded border border-edge px-1.5 py-0.5 text-[11px] font-medium text-ink hover:bg-panel-alt disabled:cursor-not-allowed disabled:opacity-40"
          >
            {results[r.id]?.status === "running" ? "…" : "Run"}
          </button>
          <button
            type="button"
            onClick={() => setEditingId(r.id)}
            className="rounded border border-edge px-1.5 py-0.5 text-[11px] font-medium text-ink hover:bg-panel-alt"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={() => deleteStrategy(r.id)}
            className="rounded border border-edge px-1.5 py-0.5 text-[11px] font-medium text-position-short hover:bg-panel-alt"
          >
            Delete
          </button>
        </div>
      ),
    },
  ];

  const renderExpanded = (r) => (
    <StrategyDetail
      result={results[r.id]}
      signalResult={strategySignals.signals[r.id]}
      positionInput={strategySignals.positionInputs[r.id]}
      onPositionChange={(next) => strategySignals.setPositionInput(r.id, next)}
      onCheckSignal={() => strategySignals.runSignalCheck(r)}
    />
  );

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

      <div className="rounded-card border border-edge bg-panel shadow-card">
        <DataTable
          columns={columns}
          data={strategies.strategies}
          emptyText="No strategies yet — write one to backtest a rule against real history instead of a one-off script."
          renderExpanded={renderExpanded}
          stateKey="strategies"
        />
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
