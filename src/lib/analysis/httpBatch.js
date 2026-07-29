// Rate-limit-aware batching + retry-on-429/timeout HTTP helper, shared by
// every exchange client in this app (okx.js, krakenSpot.js, krakenFutures.js)
// so each doesn't reinvent backoff/backpressure handling. Extracted from
// okx.js, which had zero OKX-specific logic in here beyond an error-message
// string -- that's now the `source` label passed in by each caller.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs `fn` over `items` in fixed-size batches with a gap between batches,
// so a caller that fans out one fetch per item (e.g. a ~100-pair market
// scan) doesn't itself fire an unbounded Promise.all and trip the venue's
// rate limit. `batchSize`/`gapMs` are tuned per venue by the caller.
export async function scanInBatches(items, fn, { batchSize, gapMs }) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    results.push(...(await Promise.allSettled(batch.map(fn))));
    if (i + batchSize < items.length) await sleep(gapMs);
  }
  return results;
}

// Returns a fetchJson bound to one venue: retries 429 (rate limit) and a
// stalled connection (aborted after `timeoutMs`) with exponential backoff;
// any other failure (bad symbol, malformed response) fails immediately.
// `fetchImpl` is injectable so callers that need Tauri's CORS-bypassing
// plugin-http fetch (Kraken) can pass it in instead of the browser global.
export function createFetchJson({ source, fetchImpl = fetch, timeoutMs = 15000 }) {
  return async function fetchJson(url, retries = 3, backoffMs = 500) {
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl(url, { signal: controller.signal });
        if (res.status === 429 && attempt < retries) {
          await sleep(backoffMs * 2 ** attempt);
          continue;
        }
        if (!res.ok) throw new Error(`${source} request failed: ${res.status}`);
        return await res.json();
      } catch (err) {
        if (err.name === "AbortError" && attempt < retries) {
          await sleep(backoffMs * 2 ** attempt);
          continue;
        }
        throw err.name === "AbortError" ? new Error(`${source} request timed out after ${timeoutMs / 1000}s`) : err;
      } finally {
        clearTimeout(timer);
      }
    }
  };
}
