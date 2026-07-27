// Public OKX market data — no API key needed, fetched straight from the
// browser (same no-backend approach used elsewhere in this app; OKX's public
// REST endpoints allow CORS for market data).
const BAR_MAP = { "15m": "15m", "1h": "1H", "4h": "4H", "1d": "1D", "1w": "1W" };
export const TIMEFRAMES = Object.keys(BAR_MAP);

// OKX's public market-data endpoints rate-limit around 20 req/2s per IP —
// every caller that fans out one fetch per symbol (Setup Finder's ~100-pair
// scan, the watchlist re-check, the portfolio's per-holding grading) shares
// this instead of firing its own unbounded Promise.all, so concurrent scans
// don't stack past the limit and start failing with 429s.
const RATE_LIMIT_BATCH_SIZE = 10;
// Small gap between batches so a burst of RATE_LIMIT_BATCH_SIZE symbols
// (each firing multiple sequential requests, e.g. useSetupFinder's 4H/1H/15m
// per symbol) doesn't itself accumulate past OKX's ~20 req/2s window before
// the *next* batch even starts — observed empirically: without this, a
// ~100-symbol scan can trip 429s on a meaningful fraction of symbols even
// with fetchJson's per-request backoff below.
const BATCH_GAP_MS = 250;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function scanInBatches(items, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += RATE_LIMIT_BATCH_SIZE) {
    const batch = items.slice(i, i + RATE_LIMIT_BATCH_SIZE);
    results.push(...(await Promise.allSettled(batch.map(fn))));
    if (i + RATE_LIMIT_BATCH_SIZE < items.length) await sleep(BATCH_GAP_MS);
  }
  return results;
}

// Every OKX call in this module goes through here so 429 (rate limit) gets
// one shared retry policy instead of each caller either not handling it or
// reinventing backoff. Without this, a rate-limited symbol just fails
// silently inside scanInBatches' Promise.allSettled — dropped from the
// result set with no visible error, which is how a real burst of 429s turns
// into a scan tab quietly rendering "No pairs found" instead of a market
// with nothing setting up. Only retries 429 and a stalled connection (see
// REQUEST_TIMEOUT_MS below) specifically; other failures (bad symbol,
// malformed response) fail immediately same as before.
const REQUEST_TIMEOUT_MS = 15000;

async function fetchJson(url, retries = 3, backoffMs = 500) {
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (res.status === 429 && attempt < retries) {
        await sleep(backoffMs * 2 ** attempt);
        continue;
      }
      if (!res.ok) throw new Error(`OKX request failed: ${res.status}`);
      return await res.json();
    } catch (err) {
      // A connection that opens but never responds (dead wifi/VPN hop) would
      // otherwise hang this fetch forever — and since scanInBatches awaits a
      // whole Promise.allSettled batch before starting the next, one stuck
      // request freezes every batch after it too, which is what turned into
      // an indefinitely spinning "Scanning the market…".
      if (err.name === "AbortError" && attempt < retries) {
        await sleep(backoffMs * 2 ** attempt);
        continue;
      }
      throw err.name === "AbortError" ? new Error(`OKX request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`) : err;
    } finally {
      clearTimeout(timer);
    }
  }
}

export async function fetchCandles(symbol, timeframe, limit = 300) {
  const bar = BAR_MAP[timeframe];
  if (!bar) throw new Error(`Unsupported timeframe: ${timeframe}`);
  const instId = `${symbol.toUpperCase()}-USDT`;
  const url = `https://www.okx.com/api/v5/market/candles?instId=${instId}&bar=${bar}&limit=${limit}`;

  const json = await fetchJson(url);
  if (json.code !== "0") throw new Error(json.msg || "OKX returned an error");
  if (!json.data?.length) throw new Error(`No candle data for ${instId} — check the symbol`);

  // OKX returns newest-first: [ts, open, high, low, close, vol, volCcy, volCcyQuote, confirm]
  return json.data
    .slice()
    .reverse()
    .map(([ts, open, high, low, close, volume]) => ({
      time: Number(ts),
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: Number(close),
      volume: Number(volume),
    }));
}

// OKX's /market/candles endpoint caps at 300 bars per request regardless of
// the `limit` asked for — anything needing more history (e.g. fxnxSetup.js's
// 320-bar warmup for its D1 EMA50) has to page through /market/history-candles
// instead via its `after` cursor.
export async function fetchCandleHistory(symbol, timeframe, totalBars) {
  const bar = BAR_MAP[timeframe];
  if (!bar) throw new Error(`Unsupported timeframe: ${timeframe}`);
  const instId = `${symbol.toUpperCase()}-USDT`;
  const all = [];
  let after;
  while (all.length < totalBars) {
    const url = new URL("https://www.okx.com/api/v5/market/history-candles");
    url.searchParams.set("instId", instId);
    url.searchParams.set("bar", bar);
    url.searchParams.set("limit", "100");
    if (after) url.searchParams.set("after", after);
    const json = await fetchJson(url);
    if (json.code !== "0") throw new Error(json.msg || "OKX returned an error");
    if (!json.data?.length) break;
    all.push(...json.data);
    after = json.data.at(-1)[0];
    if (json.data.length < 100) break;
  }
  return all
    .map(([ts, open, high, low, close, volume]) => ({
      time: Number(ts),
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: Number(close),
      volume: Number(volume),
    }))
    .sort((a, b) => a.time - b.time);
}

// Perpetual swap funding-rate history — the premium longs pay shorts (or
// shorts pay longs, when negative) every funding interval (8h for most
// USDT-margined perps on OKX). Paginated the same way fetchCandleHistory
// pages /market/history-candles: `after` cursor set to the oldest
// fundingTime seen so far, walking backward until totalPeriods worth of
// history is collected or the venue runs out (a newer/thinner-history
// listing). `realizedRate` (not `fundingRate`) is used — for settled
// periods they're equal, but realizedRate is the one guaranteed to reflect
// what actually happened rather than a still-open period's live estimate.
export async function fetchFundingRateHistory(symbol, totalPeriods) {
  const instId = `${symbol.toUpperCase()}-USDT-SWAP`;
  const all = [];
  let after;
  while (all.length < totalPeriods) {
    const url = new URL("https://www.okx.com/api/v5/public/funding-rate-history");
    url.searchParams.set("instId", instId);
    url.searchParams.set("limit", "100");
    if (after) url.searchParams.set("after", after);
    const json = await fetchJson(url);
    if (json.code !== "0") throw new Error(json.msg || "OKX returned an error");
    if (!json.data?.length) break;
    all.push(...json.data);
    after = json.data.at(-1).fundingTime;
    if (json.data.length < 100) break;
  }
  return all
    .map((d) => ({ time: Number(d.fundingTime), rate: Number(d.realizedRate) }))
    .sort((a, b) => a.time - b.time);
}

// Current period's funding rate for a perp (settles at nextFundingTime) —
// used by the live hook to show what's about to be collected/paid, since
// fetchFundingRateHistory only has *settled* periods.
export async function fetchFundingRate(symbol) {
  const instId = `${symbol.toUpperCase()}-USDT-SWAP`;
  const url = `https://www.okx.com/api/v5/public/funding-rate?instId=${instId}`;
  const json = await fetchJson(url);
  if (json.code !== "0" || !json.data?.length) throw new Error(json.msg || `No funding rate for ${instId}`);
  const d = json.data[0];
  return { rate: Number(d.fundingRate), nextTime: Number(d.nextFundingTime) };
}

// Latest traded price for one symbol — used for Portfolio USD valuation.
export async function fetchTickerPrice(symbol) {
  const url = `https://www.okx.com/api/v5/market/ticker?instId=${symbol.toUpperCase()}-USDT`;
  const json = await fetchJson(url);
  if (json.code !== "0" || !json.data?.length) throw new Error(json.msg || `No price for ${symbol}`);
  return Number(json.data[0].last);
}

// 24h volume ($) and change (%) for one symbol — the liquidity/participation
// context Setup Finder's market scan shows per-row but the single-coin
// Analysis view otherwise lacks; relevant for sizing a position trade since
// thin liquidity makes a wide stop/target harder to fill without slippage.
export async function fetchTicker24h(symbol) {
  const url = `https://www.okx.com/api/v5/market/ticker?instId=${symbol.toUpperCase()}-USDT`;
  const json = await fetchJson(url);
  if (json.code !== "0" || !json.data?.length) throw new Error(json.msg || `No ticker for ${symbol}`);
  const t = json.data[0];
  return {
    volUsd24h: Number(t.volCcy24h),
    changePct24h: Number(t.open24h) > 0 ? ((Number(t.last) - Number(t.open24h)) / Number(t.open24h)) * 100 : null,
  };
}

// Stablecoins pegged near $1 produce meaningless trend/RSI/score noise —
// excluded from the scan rather than evaluated as if they were a directional
// setup.
const STABLECOIN_SYMBOLS = new Set(["USDC", "USDT", "DAI", "TUSD", "USDP", "FDUSD", "PYUSD", "USDE", "GUSD", "EURC"]);

// Top-volume USDT spot pairs, for the Setup Finder scan — avoids hardcoding a
// symbol list by asking OKX for whatever's actually liquid right now. Returns
// the raw 24h volume ($) and 24h change (%) alongside each symbol so the scan
// can offer neutral sort/filter by those, not just by the analysis stats.
export async function fetchTopVolumeTickers(limit = 20) {
  const url = "https://www.okx.com/api/v5/market/tickers?instType=SPOT";
  const json = await fetchJson(url);
  if (json.code !== "0") throw new Error(json.msg || "OKX returned an error");

  return json.data
    .filter((t) => t.instId.endsWith("-USDT"))
    .map((t) => ({
      symbol: t.instId.replace("-USDT", ""),
      volUsd24h: Number(t.volCcy24h),
      changePct24h: Number(t.open24h) > 0 ? ((Number(t.last) - Number(t.open24h)) / Number(t.open24h)) * 100 : null,
    }))
    .filter((t) => !STABLECOIN_SYMBOLS.has(t.symbol))
    .sort((a, b) => b.volUsd24h - a.volUsd24h)
    .slice(0, limit);
}

// Which symbols actually have a USDT-margined perpetual swap on OKX — a
// spot listing existing (fetchTopVolumeTickers) doesn't mean the matching
// `<symbol>-USDT-SWAP` instrument exists, and shorting on OKX only happens
// via /trade-futures (perpetual swap or expiry futures), never spot. A
// hedged-basket short leg picking a spot-only symbol would be a position
// the user literally cannot execute. Static-ish list (new listings aside),
// so callers can cache this more aggressively than the market-data
// endpoints above.
export async function fetchPerpetualSwapSymbols() {
  const url = "https://www.okx.com/api/v5/public/instruments?instType=SWAP";
  const json = await fetchJson(url);
  if (json.code !== "0") throw new Error(json.msg || "OKX returned an error");
  return new Set(
    json.data.filter((i) => i.instId.endsWith("-USDT-SWAP")).map((i) => i.instId.replace("-USDT-SWAP", ""))
  );
}

// Manual override on top of fetchPerpetualSwapSymbols(): OKX's public API
// lists some perpetuals as `state: "live"` that aren't actually reachable
// the normal way through /trade-futures (no reliable field distinguishes
// these from ordinary perps — "openType" looked promising but turns out to
// be shared by ~90% of all perps, including well-known ones, so it's not a
// real signal). Confirmed manually so far: RE. Add a symbol here if you hit
// the same thing — the automatic check can't catch what the API doesn't
// expose.
const MANUALLY_UNSHORTABLE = new Set(["RE"]);

// Whether a symbol can actually be shorted on OKX right now — a perpetual
// swap listing exists and it isn't one of the manually-confirmed exceptions
// above. Any "short"/"bearish" signal surfaced to the user (Scan's entry
// column, the former hedged basket) needs to gate on this: a spot-only
// symbol ranking as a great short candidate is still a trade the user
// cannot place.
export function isShortable(symbol, perpSymbols) {
  return perpSymbols.has(symbol) && !MANUALLY_UNSHORTABLE.has(symbol);
}
