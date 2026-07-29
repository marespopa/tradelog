// Kraken Futures — a separate product/API from Kraken Spot (different
// domain, different symbol scheme) used here only for the one thing spot
// listings can't answer: which symbols actually have a USDT-margined... err,
// USD-margined perpetual, for the live shortability gate. No API key needed,
// this is Kraken Futures' public instrument list. Same CORS situation as
// Kraken Spot assumed here (verify empirically — plugin-http is used
// regardless so it's harmless either way).
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { createFetchJson } from "./httpBatch.js";

const API_BASE = "https://futures.kraken.com/derivatives/api/v3";
const fetchJson = createFetchJson({ source: "Kraken Futures", fetchImpl: tauriFetch });

// Same XBT/BTC quirk as krakenSpot.js — duplicated rather than shared since
// it's a single entry and this module otherwise has no dependency on the
// spot client.
const KRAKEN_BASE_TO_SYMBOL = { XBT: "BTC" };

// Manual override on top of the instruments list, same pattern as okx.js's
// MANUALLY_UNSHORTABLE — add a symbol here if Kraken Futures lists it as
// tradeable but it isn't actually reachable the normal way.
const MANUALLY_UNSHORTABLE = new Set();

// Which symbols have a live USD-margined perpetual (symbol prefix "PF_") on
// Kraken Futures — a spot listing (krakenSpot.js's fetchTopVolumeTickers)
// existing doesn't mean the matching perpetual does, and shorting only
// happens via a perpetual, never spot.
export async function fetchPerpetualSwapSymbols() {
  const json = await fetchJson(`${API_BASE}/instruments`);
  if (json.result !== "success") throw new Error("Kraken Futures returned an error");
  return new Set(
    json.instruments
      .filter((i) => i.symbol.startsWith("PF_") && i.symbol.endsWith("USD") && i.tradeable)
      .map((i) => {
        const base = i.symbol.slice("PF_".length, -"USD".length);
        return KRAKEN_BASE_TO_SYMBOL[base] ?? base;
      })
  );
}

// Whether a symbol can actually be shorted on Kraken right now — a
// perpetual listing exists and it isn't one of the manually-confirmed
// exceptions above. Any "short"/"bearish" signal surfaced to the user
// (Scan's entry column) needs to gate on this: a spot-only symbol ranking as
// a great short candidate is still a trade the user cannot place.
export function isShortable(symbol, perpSymbols) {
  return perpSymbols.has(symbol) && !MANUALLY_UNSHORTABLE.has(symbol);
}
