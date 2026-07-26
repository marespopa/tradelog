import { useEffect, useState } from "react";
import { fetchCandles } from "../lib/analysis/okx.js";
import { analyzeCandles, buildSetup } from "../lib/analysis/ta.js";
import { computeBetaAlpha } from "../lib/analysis/betaNeutral.js";

const DEBOUNCE_MS = 500;

// Live risk context for whatever symbol is being typed into the Add Trade
// form — ATR%, beta vs BTC, and a suggested stop/target for *either* side
// (not just whichever direction the 4H trend happens to be in), reusing
// ta.js's buildSetup (the same 1.5x-ATR stop / structural-target formula
// the Scan panel already trusts) rather than inventing a second stop/target
// model. Lets the form warn if a typed stop is tighter than this specific
// symbol's own ATR-based noise band, or leverage is high for how high-beta
// it actually is, and offer one-click "use suggested" values instead of
// applying one fixed rule (e.g. "keep stops at least 1%") across every coin
// regardless of how much it actually moves. Debounced since it would
// otherwise fire on every keystroke in the symbol field.
export function useEntryRiskCheck(symbol) {
  const [data, setData] = useState(null);

  useEffect(() => {
    const trimmed = symbol?.trim().toUpperCase();
    if (!trimmed) {
      setData(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const [candles, btcCandles] = await Promise.all([
          fetchCandles(trimmed, "4h", 220),
          trimmed === "BTC" ? Promise.resolve(null) : fetchCandles("BTC", "4h", 220),
        ]);
        if (cancelled) return;

        const analysis = analyzeCandles(candles, trimmed);
        const { current, atr: atrVal, atrPct, swingLow, neckline, swingHigh, floor, trend } = analysis;

        const setupFor = (direction) => buildSetup({ direction, current, atr: atrVal, swingLow, neckline, swingHigh, floor });

        let beta = 1; // BTC vs itself
        if (btcCandles) {
          const coinCloses = candles.map((c) => c.close).slice(-btcCandles.length);
          const btcCloses = btcCandles.map((c) => c.close);
          beta = computeBetaAlpha(coinCloses, btcCloses)?.beta ?? null;
        }

        setData({
          symbol: trimmed,
          current,
          atrPct,
          beta,
          trend, // "bullish" | "bearish" | "sideways" — context only, doesn't gate which setupFor() is usable
          setupLong: setupFor("long"),
          setupShort: setupFor("short"),
        });
      } catch {
        if (!cancelled) setData(null);
      }
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [symbol]);

  return data;
}
