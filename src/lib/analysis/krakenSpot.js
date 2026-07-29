// Public Kraken Spot market data — no API key needed. Unlike OKX, Kraken's
// public REST API sends no Access-Control-Allow-Origin header, so a plain
// browser fetch() would fail CORS; @tauri-apps/plugin-http routes the
// request through the Rust backend instead (native reqwest, no browser CORS
// involved), so the rest of this module can otherwise mirror okx.js's shape.
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { scanInBatches as scanInBatchesGeneric, createFetchJson } from "./httpBatch.js";

const API_BASE = "https://api.kraken.com/0/public";

// Kraken takes interval in minutes, not a bar-string like OKX's "4H".
const INTERVAL_MAP = { "15m": 15, "1h": 60, "4h": 240, "1d": 1440, "1w": 10080 };
export const TIMEFRAMES = Object.keys(INTERVAL_MAP);

// Conservative batching for Kraken's public endpoints — no documented public
// rate limit as tight as OKX's ~20req/2s, but nothing observed yet either;
// tune these down if 429s show up in practice, same as OKX's were tuned
// empirically.
const RATE_LIMIT_BATCH_SIZE = 3;
const BATCH_GAP_MS = 1000;
// /0/public/Ticker accepts a comma-separated pair list in one call, but a
// huge query string risks hitting URL-length limits — chunk the full pair
// list instead of requesting hundreds of pairs in a single request.
const TICKER_CHUNK_SIZE = 20;

export function scanInBatches(items, fn) {
  return scanInBatchesGeneric(items, fn, { batchSize: RATE_LIMIT_BATCH_SIZE, gapMs: BATCH_GAP_MS });
}

const fetchJson = createFetchJson({ source: "Kraken", fetchImpl: tauriFetch });

const STABLECOIN_SYMBOLS = new Set(["USDC", "USDT", "DAI", "TUSD", "USDP", "FDUSD", "PYUSD", "USDE", "GUSD", "EURC", "RLUSD"]);

// Kraken's one well-known naming quirk: Bitcoin is asset code XBT, not BTC,
// everywhere in its API (wsname "XBT/USD" etc). Every other symbol used in
// this app matches its Kraken wsname base directly, so a single alias covers
// it rather than hand-rolling Kraken's inconsistent legacy X/Z-prefixed
// asset codes (see fetchAssetPairs below, which resolves off wsname instead
// of those prefixed codes for exactly this reason).
const KRAKEN_BASE_TO_SYMBOL = { XBT: "BTC" };

// Bare-symbol <-> Kraken pair-key resolution, built once from
// /0/public/AssetPairs and cached for the process lifetime (pair listings
// don't change during a session). Quoted in USD — Kraken's most liquid quote
// currency — rather than USDT to match OKX's convention.
let assetPairsPromise;
async function fetchAssetPairs() {
  if (!assetPairsPromise) {
    assetPairsPromise = fetchJson(`${API_BASE}/AssetPairs`).then((json) => {
      if (json.error?.length) throw new Error(json.error.join("; ") || "Kraken returned an error");
      const bySymbol = new Map();
      const symbols = [];
      for (const [pairKey, info] of Object.entries(json.result)) {
        // AssetPairs lists pairs that are delisted/cancel-only/etc alongside
        // live ones -- without this, a symbol Kraken no longer actually
        // trades (e.g. CAKE) still shows up everywhere this map feeds into
        // (Market scan, Coin Analysis, ...) even though placing a real order
        // on it isn't possible.
        if (info.status !== "online") continue;
        const [base, quote] = (info.wsname || "").split("/");
        if (quote !== "USD" || !base) continue;
        const symbol = KRAKEN_BASE_TO_SYMBOL[base] ?? base;
        if (bySymbol.has(symbol)) continue; // first/primary listing wins if duplicates exist
        bySymbol.set(symbol, pairKey);
        symbols.push(symbol);
      }
      return { bySymbol, symbols };
    });
  }
  return assetPairsPromise;
}

async function resolvePairKey(symbol) {
  const bare = symbol.toUpperCase();
  const { bySymbol } = await fetchAssetPairs();
  const pairKey = bySymbol.get(bare);
  if (!pairKey) throw new Error(`No Kraken USD pair found for ${bare}`);
  return pairKey;
}

export async function fetchCandles(symbol, timeframe, limit = 300) {
  const interval = INTERVAL_MAP[timeframe];
  if (!interval) throw new Error(`Unsupported timeframe: ${timeframe}`);
  const pairKey = await resolvePairKey(symbol);

  const url = new URL(`${API_BASE}/OHLC`);
  url.searchParams.set("pair", pairKey);
  url.searchParams.set("interval", String(interval));
  const json = await fetchJson(url);
  if (json.error?.length) throw new Error(json.error.join("; ") || "Kraken returned an error");
  const rows = json.result[pairKey];
  if (!rows?.length) throw new Error(`No candle data for ${symbol} — check the symbol`);

  // Kraken returns oldest-first: [time, open, high, low, close, vwap, volume, count].
  // Kraken's `time` is Unix seconds; the rest of this app (matching OKX's `ts`
  // field) treats candle.time as milliseconds -- e.g. PriceChart.jsx's
  // toChartTime divides by 1000 to get back to seconds for the chart
  // library. Passing Kraken's raw seconds through unconverted fed it
  // through that division a second time, which occasionally truncated two
  // distinct candles down to the same integer second (lightweight-charts'
  // "must be asc ordered by time" assertion).
  return rows
    .map(([time, open, high, low, close, , volume]) => ({
      time: Number(time) * 1000,
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: Number(close),
      volume: Number(volume),
    }))
    .sort((a, b) => a.time - b.time)
    .slice(-limit);
}

export async function fetchTickerPrice(symbol) {
  const pairKey = await resolvePairKey(symbol);
  const json = await fetchJson(`${API_BASE}/Ticker?pair=${pairKey}`);
  if (json.error?.length || !json.result?.[pairKey]) throw new Error(json.error?.join("; ") || `No price for ${symbol}`);
  return Number(json.result[pairKey].c[0]);
}

export async function fetchTicker24h(symbol) {
  const pairKey = await resolvePairKey(symbol);
  const json = await fetchJson(`${API_BASE}/Ticker?pair=${pairKey}`);
  if (json.error?.length || !json.result?.[pairKey]) throw new Error(json.error?.join("; ") || `No ticker for ${symbol}`);
  const t = json.result[pairKey];
  const last = Number(t.c[0]);
  const open = Number(t.o);
  // Kraken's ticker volume (v) is in base-asset units, unlike OKX's
  // volCcy24h which is already quote-currency — multiply by last price to
  // get a comparable USD figure.
  return {
    volUsd24h: Number(t.v[1]) * last,
    changePct24h: open > 0 ? ((last - open) / open) * 100 : null,
  };
}

export async function fetchTopVolumeTickers(limit = 20) {
  const { bySymbol, symbols } = await fetchAssetPairs();
  const pairKeys = symbols.map((s) => bySymbol.get(s));
  const symbolByPairKey = new Map(pairKeys.map((k, i) => [k, symbols[i]]));

  const chunks = [];
  for (let i = 0; i < pairKeys.length; i += TICKER_CHUNK_SIZE) chunks.push(pairKeys.slice(i, i + TICKER_CHUNK_SIZE));

  const chunkResults = await scanInBatches(chunks, async (chunk) => {
    const json = await fetchJson(`${API_BASE}/Ticker?pair=${chunk.join(",")}`);
    if (json.error?.length) throw new Error(json.error.join("; ") || "Kraken returned an error");
    return json.result;
  });

  const tickers = [];
  for (const r of chunkResults) {
    if (r.status !== "fulfilled") continue;
    for (const [pairKey, t] of Object.entries(r.value)) {
      const symbol = symbolByPairKey.get(pairKey);
      if (!symbol) continue;
      const last = Number(t.c[0]);
      const open = Number(t.o);
      tickers.push({
        symbol,
        volUsd24h: Number(t.v[1]) * last,
        changePct24h: open > 0 ? ((last - open) / open) * 100 : null,
      });
    }
  }

  return tickers
    .filter((t) => !STABLECOIN_SYMBOLS.has(t.symbol))
    .sort((a, b) => b.volUsd24h - a.volUsd24h)
    .slice(0, limit);
}
