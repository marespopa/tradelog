// Generic OHLC bucket rollup shared by every timeframe resampling step (4H->
// daily, daily->weekly) — one implementation so the live scan and the
// backtests that resample the same way can't drift apart. Drops a trailing
// incomplete bucket so the "current" bucket is never treated as closed early.
export function aggregateCandles(candles, bucketKeyFn, minBarsPerBucket = 1) {
  const byBucket = new Map();
  for (const c of candles) {
    const key = bucketKeyFn(c.time);
    if (!byBucket.has(key)) byBucket.set(key, []);
    byBucket.get(key).push(c);
  }
  const buckets = [...byBucket.entries()].sort((a, b) => a[0] - b[0]);
  if (buckets.length && buckets.at(-1)[1].length < minBarsPerBucket) buckets.pop();
  return buckets.map(([, bars]) => ({
    time: bars[0].time,
    open: bars[0].open,
    high: Math.max(...bars.map((b) => b.high)),
    low: Math.min(...bars.map((b) => b.low)),
    close: bars.at(-1).close,
  }));
}

const DAY_MS = 86400000;
const WEEK_MS = DAY_MS * 7;
// 1970-01-01 was a Thursday (index 3 if Monday=0) — shifting by 3 days
// aligns week buckets to a Monday start instead of an arbitrary epoch offset.
const WEEK_ANCHOR_MS = DAY_MS * 3;

// Groups 4H candles into daily OHLC, dropping a trailing incomplete day
// (< 6 of the 6 bars a full 4H day has).
export function buildDailyCandles(candles) {
  return aggregateCandles(candles, (t) => Math.floor(t / DAY_MS), 6);
}

// Groups daily candles into weekly (Monday-anchored) OHLC, dropping a
// trailing incomplete week (< 5 daily bars).
export function buildWeeklyCandles(dailyCandles) {
  return aggregateCandles(dailyCandles, (t) => Math.floor((t - WEEK_ANCHOR_MS) / WEEK_MS), 5);
}
