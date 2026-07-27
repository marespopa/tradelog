// Crypto Fear & Greed Index (alternative.me) — a daily 0-100 market-wide
// sentiment gauge (0 = extreme fear, 100 = extreme greed) blending
// volatility, momentum/volume, social media, dominance, and trends. One
// reading applies to the whole market, not per-symbol — a strategy testing
// ETH and one testing PEPE see the same value for the same day. Public, no
// key, CORS-open (access-control-allow-origin: *) — same no-backend
// approach as okx.js.
const FNG_URL = "https://api.alternative.me/fng/?limit=0&format=json";

export async function fetchFearGreedHistory() {
  const res = await fetch(FNG_URL);
  if (!res.ok) throw new Error(`Fear & Greed request failed: ${res.status}`);
  const json = await res.json();
  if (!json.data?.length) throw new Error("Fear & Greed returned no data");
  return json.data
    .map((d) => ({ time: Number(d.timestamp) * 1000, value: Number(d.value), classification: d.value_classification }))
    .sort((a, b) => a.time - b.time);
}

// Aligns a (ascending, daily) Fear & Greed history to a `bars` array of any
// timeframe: bar i gets the most recent reading published at or before that
// bar's own time — never a same-day-or-later value a strategy running live
// at that bar couldn't actually have seen yet. Null for any bar older than
// the index's first reading (2018-02-01). Single forward pass, same
// "advance the closed-as-of-now pointer" shape backtest-mtf-swing.js uses
// for its daily/weekly pointers, so cost stays O(bars + history) not
// O(bars * history).
export function alignFearGreedToBars(fgHistory, bars) {
  const out = new Array(bars.length).fill(null);
  let fgIdx = 0;
  for (let i = 0; i < bars.length; i++) {
    while (fgIdx < fgHistory.length - 1 && fgHistory[fgIdx + 1].time <= bars[i].time) fgIdx++;
    out[i] = fgHistory[fgIdx] && fgHistory[fgIdx].time <= bars[i].time ? fgHistory[fgIdx] : null;
  }
  return out;
}
