import { useEffect, useMemo, useState } from "react";
import PriceChart from "./PriceChart.jsx";
import WatchButton from "./WatchButton.jsx";
import { useCoinAnalysis } from "../hooks/useCoinAnalysis.js";
import { TIMEFRAMES } from "../lib/analysis/okx.js";
import { linearRegressionChannel } from "../lib/analysis/ta.js";

const TIMEFRAME_LABEL = { "15m": "15m", "1h": "1H", "4h": "4H", "1d": "1D", "1w": "1W" };

const TREND_STYLE = {
  bullish: "bg-position-long/15 text-position-long",
  bearish: "bg-position-short/15 text-position-short",
  sideways: "bg-panel-alt text-dim",
};
const TREND_LABEL = { bullish: "Bullish", bearish: "Bearish", sideways: "Neutral" };

export default function CoinAnalysis({ symbol: controlledSymbol, onSymbolChange, watchlist }) {
  const [symbol, setSymbol] = useState(controlledSymbol || "BTC");
  const [symbolInput, setSymbolInput] = useState(symbol);
  const [timeframe, setTimeframe] = useState("1h");
  const [showChannel, setShowChannel] = useState(true);

  // Setup Finder (or a future deep link) can hand us a symbol directly —
  // sync it in without fighting the user's own in-progress typing.
  useEffect(() => {
    if (controlledSymbol && controlledSymbol !== symbol) {
      setSymbol(controlledSymbol);
      setSymbolInput(controlledSymbol);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controlledSymbol]);

  const { data, isLoading, error } = useCoinAnalysis(symbol, timeframe);

  const chartProps = useMemo(() => {
    if (!data) return null;
    const { candles } = data;
    return {
      times: candles.map((c) => c.time),
      opens: candles.map((c) => c.open),
      highs: candles.map((c) => c.high),
      lows: candles.map((c) => c.low),
      closes: candles.map((c) => c.close),
      volumes: candles.map((c) => c.volume),
    };
  }, [data]);

  // Spans the whole loaded window (no fixed lookback) so it reads
  // consistently whichever timeframe is selected, rather than a fixed bar
  // count that would cover very different amounts of real time across
  // 15m vs 1D candles.
  const channel = useMemo(() => (data && showChannel ? linearRegressionChannel(data.candles) : null), [data, showChannel]);

  const submitSymbol = (e) => {
    e.preventDefault();
    const next = symbolInput.trim().toUpperCase();
    if (!next) return;
    setSymbol(next);
    onSymbolChange?.(next);
  };

  const analysis = data?.analysis;

  return (
    <div className="rounded-card border border-edge bg-panel shadow-card">
      <div className="flex flex-col gap-3 border-b border-edge px-5 py-3.5 sm:flex-row sm:items-center sm:justify-between">
        <form onSubmit={submitSymbol} className="flex items-center gap-2">
          <input
            type="text"
            value={symbolInput}
            onChange={(e) => setSymbolInput(e.target.value)}
            placeholder="Symbol e.g. IMX"
            className="w-32 rounded-lg border border-edge bg-bg px-3 py-1.5 text-[13px] uppercase text-ink outline-none focus:border-accent"
          />
          <button type="submit" className="rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white hover:opacity-90">
            Analyze
          </button>
          {watchlist && <WatchButton active={watchlist.has(symbol)} onToggle={() => watchlist.toggle(symbol)} />}
        </form>

        <div className="flex items-center gap-3">
          <div className="flex gap-1 rounded-lg bg-panel-alt p-1">
            {TIMEFRAMES.map((tf) => (
              <button
                key={tf}
                type="button"
                onClick={() => setTimeframe(tf)}
                className={`rounded-md px-3 py-1 text-[12px] font-medium transition-all duration-150 ${timeframe === tf ? "bg-panel-raised text-ink shadow-sm" : "text-dim hover:text-ink"}`}
              >
                {TIMEFRAME_LABEL[tf]}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setShowChannel((s) => !s)}
            title="Linear regression channel over the loaded window"
            className={`rounded-lg border-0 px-3 py-1.5 text-[12px] font-medium transition-all duration-150 ${showChannel ? "bg-accent text-white" : "bg-panel-alt text-dim hover:text-ink"}`}
          >
            Channel
          </button>
        </div>
      </div>

      <div className="p-5">
        {isLoading && <p className="text-[13px] text-dim">Loading {symbol}…</p>}
        {error && <p className="text-[13px] text-position-short">Couldn't load {symbol}: {error.message}</p>}

        {analysis && (
          <>
            {chartProps && <PriceChart {...chartProps} channel={channel} height={420} />}

            <div className="mt-3 flex justify-center">
              <span className={`rounded-full px-3 py-1 text-[12px] font-medium ${TREND_STYLE[analysis.trend]}`}>{TREND_LABEL[analysis.trend]}</span>
            </div>

            {analysis.evaluation && (
              <div className="mt-4 rounded-lg border border-edge bg-panel-alt p-4 text-[13px] leading-relaxed text-ink">
                <p className="font-medium">{analysis.evaluation.hook}</p>
                <p className="mt-3 text-dim">{analysis.evaluation.body}</p>
                {analysis.evaluation.quant && <p className="mt-3 text-dim">{analysis.evaluation.quant}</p>}
                <p className="mt-3 text-dim">{analysis.evaluation.watch}</p>
                <p className="mt-3 text-[12px] text-dim">⚠ Not financial advice.</p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
