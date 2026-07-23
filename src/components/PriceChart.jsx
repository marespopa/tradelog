// Candlestick + volume chart (via lightweight-charts).
import { useEffect, useRef } from "react";
import { createChart, CandlestickSeries, HistogramSeries, CrosshairMode } from "lightweight-charts";

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function readTheme() {
  return {
    text: cssVar("--c-text"),
    dim: cssVar("--c-dim"),
    border: cssVar("--c-border"),
    green: cssVar("--c-long"),
    red: cssVar("--c-short"),
    accent: cssVar("--c-accent"),
  };
}

// Sub-cent coins (PEPE, SHIB-scale) need far more than 2-8 decimals to show
// any significant digits at all — e.g. 0.000002713 needs 9+ just to render
// the "2713" instead of rounding away to near-zero. Scale decimals to the
// price's own magnitude instead of a fixed cap.
function priceDecimals(v) {
  const abs = Math.abs(v);
  if (abs >= 100) return 2;
  if (abs >= 1) return 4;
  if (abs >= 0.01) return 6;
  if (abs >= 0.0001) return 8;
  if (abs >= 0.000001) return 10;
  return 12;
}

// lightweight-charts always renders its time axis/crosshair using UTC date
// getters, ignoring the viewer's local timezone — the standard workaround is
// to feed it timestamps pre-shifted by the browser's own UTC offset, so what
// the library thinks is "UTC" displays as the viewer's actual local time.
const TZ_OFFSET_SEC = new Date().getTimezoneOffset() * 60;
function toChartTime(ms) {
  return Math.floor(ms / 1000) - TZ_OFFSET_SEC;
}

export default function PriceChart({ times, opens, highs, lows, closes, volumes, live, height = 320 }) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef(null);
  const volumeSeriesRef = useRef(null);

  const hasData = times?.length >= 2 && closes?.length === times.length;

  // Create the chart once per mount; theme/color changes are applied via
  // applyOptions below rather than tearing the chart down.
  useEffect(() => {
    if (!containerRef.current) return;
    const theme = readTheme();

    const chart = createChart(containerRef.current, {
      height,
      layout: { background: { color: "transparent" }, textColor: theme.dim, fontSize: 11 },
      grid: {
        vertLines: { color: theme.border },
        horzLines: { color: theme.border },
      },
      rightPriceScale: { borderColor: theme.border },
      timeScale: { borderColor: theme.border, timeVisible: true, secondsVisible: false },
      crosshair: { mode: CrosshairMode.Normal },
      autoSize: true,
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: theme.green,
      downColor: theme.red,
      borderVisible: false,
      wickUpColor: theme.green,
      wickDownColor: theme.red,
      priceScaleId: "right",
      priceLineVisible: false,
    });
    candleSeries.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.28 } });

    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
    });
    volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.78, bottom: 0 } });

    chartRef.current = chart;
    seriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;

    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      volumeSeriesRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [height]);

  // Re-theme in place (no remount) when the user toggles dark/light mode.
  useEffect(() => {
    const target = document.documentElement;
    const applyTheme = () => {
      if (!chartRef.current) return;
      const theme = readTheme();
      chartRef.current.applyOptions({
        layout: { textColor: theme.dim },
        grid: { vertLines: { color: theme.border }, horzLines: { color: theme.border } },
        rightPriceScale: { borderColor: theme.border },
        timeScale: { borderColor: theme.border },
      });
      seriesRef.current?.applyOptions({
        upColor: theme.green, downColor: theme.red, wickUpColor: theme.green, wickDownColor: theme.red,
      });
    };
    const observer = new MutationObserver(applyTheme);
    observer.observe(target, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!hasData || !seriesRef.current) return;
    const theme = readTheme();
    const candles = times.map((t, i) => ({
      time: toChartTime(t),
      open: opens[i], high: highs[i], low: lows[i], close: closes[i],
    }));
    // Lightweight-charts defaults every series to 2-decimal price formatting
    // regardless of magnitude — fine for BTC, useless for a coin priced at
    // 0.000002713 (the axis would just show "0.00").
    const precision = priceDecimals(closes.at(-1));
    seriesRef.current.applyOptions({ priceFormat: { type: "price", precision, minMove: 1 / 10 ** precision } });
    seriesRef.current.setData(candles);
    if (volumeSeriesRef.current && volumes?.length === times.length) {
      volumeSeriesRef.current.setData(
        times.map((t, i) => ({
          time: toChartTime(t),
          value: volumes[i],
          color: closes[i] >= opens[i] ? `${theme.green}66` : `${theme.red}66`,
        })),
      );
    }

    chartRef.current?.timeScale().fitContent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [times, opens, highs, lows, closes, volumes, hasData]);

  // Push live (in-progress candle) ticks straight into the series via
  // update() rather than setData(), so the chart doesn't redraw/refit on
  // every websocket message.
  useEffect(() => {
    if (!live || !hasData || !seriesRef.current) return;
    const lastTime = toChartTime(times.at(-1));
    const liveTime = live.time - TZ_OFFSET_SEC; // live.time is already in (unshifted) unix seconds
    if (liveTime < lastTime) return;
    seriesRef.current.update({ time: liveTime, open: live.open, high: live.high, low: live.low, close: live.close });
    if (volumeSeriesRef.current && live.volume != null) {
      const theme = readTheme();
      volumeSeriesRef.current.update({
        time: liveTime,
        value: live.volume,
        color: live.close >= live.open ? `${theme.green}66` : `${theme.red}66`,
      });
    }
  }, [live]);

  if (!hasData) return null;

  return <div ref={containerRef} className="h-full w-full" style={{ height }} />;
}
