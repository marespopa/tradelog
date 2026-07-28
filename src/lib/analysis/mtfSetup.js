// 3-tier multi-timeframe swing setup: Weekly bias (long-horizon direction) ->
// Daily trend (must agree with the weekly read) -> 4H engulfing trigger at a
// tested S/R level (entry timing). Extends fxnxSetup.js's proven 2-tier
// (Daily + 4H) shape one level up — see find4hTrigger below for why the
// trigger set was trimmed to engulfing-only rather than reusing
// fxnxSetup/patterns.js's full pin-bar/engulfing/inside-bar set as-is.
//
// Exports are split so the same trigger/bias logic can be driven two ways:
// - findMtfSignal(weekly, daily, fourH): single call, all three timeframes
//   from one aligned data source (used by the backtest, which resamples one
//   deep 4H fetch into daily/weekly so there's no lookahead risk).
// - weeklyBias/dailyTrend/find4hTrigger individually: used by the live scan,
//   which fetches weekly/daily bias on a slow cadence (useMarketBias) and 4H
//   triggers on a fast cadence (useSetupFinder) as two separate hooks.
import { ema, atr, findSwingLevels } from "./ta.js";
import { isEngulfing } from "./patterns.js";
import { buildWeeklyCandles } from "./timeframes.js";

export const MTF_R_MULTIPLE = 2;
// ~85 weeks of history so weekly EMA20 has settled (EMA needs roughly 3x its
// period to stop reflecting its seed value) — see buildWeeklyCandles' input
// requirements in the backtest script for how this maps to 4H bar count.
export const MTF_WEEKLY_WARMUP_BARS = 60;
const WEEKLY_EMA_FAST = 10;
const WEEKLY_EMA_SLOW = 20;
const DAILY_EMA_FAST = 20;
const DAILY_EMA_SLOW = 50;
// Same EMA20/50 cross as the daily tier, just at 1H granularity — a genuine
// trend read (not a hand-me-down from the 4H/Daily tiers) for the Market
// table's "1h" column. 150 bars (~6.25 days) so EMA50 has roughly 3x its
// period to settle, matching the settling ratio used for weekly/daily above.
const HOURLY_EMA_FAST = 20;
const HOURLY_EMA_SLOW = 50;
export const MTF_HOURLY_WARMUP_BARS = 150;

function emaCross(closes, fastPeriod, slowPeriod) {
  if (closes.length < slowPeriod) return null;
  const fast = ema(closes, fastPeriod).at(-1);
  const slow = ema(closes, slowPeriod).at(-1);
  if (fast === slow) return null;
  return fast > slow ? "bullish" : "bearish";
}

// Long-horizon direction filter: weekly EMA10 vs EMA20.
export function weeklyBias(weeklyCandles) {
  return emaCross(weeklyCandles.map((c) => c.close), WEEKLY_EMA_FAST, WEEKLY_EMA_SLOW);
}

// Intermediate trend filter: daily EMA20 vs EMA50. Only meaningful compared
// against weeklyBias by the caller — this returns its own read regardless of
// direction so the live hook can display it even when it disagrees.
export function dailyTrend(dailyCandles) {
  return emaCross(dailyCandles.map((c) => c.close), DAILY_EMA_FAST, DAILY_EMA_SLOW);
}

// Short-horizon trend read for the Market table's "1h" column — independent
// of the 3-tier Weekly/Daily/4H setup itself (not used in attachEntry's
// agreement check), purely a display annotation.
export function hourlyTrend(hourlyCandles) {
  return emaCross(hourlyCandles.map((c) => c.close), HOURLY_EMA_FAST, HOURLY_EMA_SLOW);
}

// Weekly+Daily regime from a single daily candle series (resamples weekly
// internally via timeframes.js) — the persistent trend-agreement read used
// by slower-cadence consumers (betaNeutral.js's basket construction, which
// rebalances weekly) that don't need the 4H entry-timing tier at all.
// Returns "bullish"/"bearish" only when both tiers agree, null otherwise
// (including not-enough-history, which is common until ~85 weeks of daily
// candles have accumulated — see MTF_WEEKLY_WARMUP_BARS).
export function mtfRegime(dailyCandles) {
  const wBias = weeklyBias(buildWeeklyCandles(dailyCandles));
  if (!wBias) return null;
  return dailyTrend(dailyCandles) === wBias ? wBias : null;
}

// Entry-timing trigger at the 4H level, gated to a single required
// direction (the direction weekly+daily already agreed on). Engulfing-only:
// backtest-mtf-swing.js originally also tried pin bar and inside-bar-breakout
// (fxnxSetup.findFxnxSignal's full 4H trigger set) alongside engulfing, but
// on the 3-tier Weekly+Daily+4H rule those two came back flat-to-negative
// (pinBar -0.09R/trade, insideBar -0.06R/trade at 2R) and dragged the
// blended result's confidence interval below breakeven. Re-run with only
// this trigger confirmed a real standalone edge — 15 liquid pairs, ~600
// days of 4H history each: 39.8% win rate at 2R (33.3% breakeven, 95% CI
// 34.5-45.4%, 309 resolved trades, +0.19R/trade expectancy) and 30.4% at 3R
// (25% breakeven, 95% CI 25.2-36.1%, +0.21R/trade) — see backtests/. Both
// clear breakeven with real margin, comfortably ahead of the 2-tier FXNX
// setup's +0.07R. Trimmed to just the trigger that actually showed an edge
// rather than diluting it with the other two.
export function find4hTrigger(fourHCandles, direction) {
  if (!direction) return null;
  const atrVal = atr(fourHCandles);
  if (atrVal == null) return null;
  const levels = findSwingLevels(fourHCandles).filter((l) => l.touches >= 2);
  const levelType = direction === "bullish" ? "support" : "resistance";
  const nearLevel = (price) => levels.some((l) => l.type === levelType && Math.abs(l.price - price) <= atrVal);

  const cur = fourHCandles.at(-1);
  const prev = fourHCandles.at(-2);
  const buffer = atrVal * 0.1;

  if (prev && isEngulfing(prev, cur, direction) && nearLevel(direction === "bullish" ? Math.min(prev.low, cur.low) : Math.max(prev.high, cur.high))) {
    const stop = direction === "bullish" ? Math.min(prev.low, cur.low) - buffer : Math.max(prev.high, cur.high) + buffer;
    return { direction, entry: cur.close, stop, trigger: "engulfing" };
  }
  return null;
}

// All three tiers from one aligned data source — weekly bias, daily trend
// must agree with it, then a 4H trigger in that direction. Returns null if
// any tier disagrees or no trigger fires.
export function findMtfSignal(weeklyCandles, dailyCandles, fourHCandles) {
  const wBias = weeklyBias(weeklyCandles);
  if (!wBias) return null;
  const dTrend = dailyTrend(dailyCandles);
  if (dTrend !== wBias) return null;
  return find4hTrigger(fourHCandles, wBias);
}

// Turns a signal (however it was found) into a tradeable setup at the given
// R multiple (fixed target = rMultiple * risk beyond entry). Same shape as
// fxnxSetup.buildFxnxTrade so both feed the same downstream consumers
// (position sizing, the scan table) without reshaping.
export function buildTrade(signal, rMultiple = MTF_R_MULTIPLE) {
  if (!signal) return null;
  const { direction, entry, stop, trigger } = signal;
  const risk = Math.abs(entry - stop);
  if (risk <= 0) return null;
  const reward = rMultiple * risk;
  const target = direction === "bullish" ? entry + reward : entry - reward;
  return { direction: direction === "bullish" ? "long" : "short", entry, stop, target, risk, reward, rr: rMultiple, trigger };
}

export function buildMtfTrade(weeklyCandles, dailyCandles, fourHCandles, rMultiple = MTF_R_MULTIPLE) {
  return buildTrade(findMtfSignal(weeklyCandles, dailyCandles, fourHCandles), rMultiple);
}

// Joins one useSetupFinder row (which carries `fourHTrigger` and
// `shortable`, both direction-agnostic/symbol-level facts) against its
// matching useMarketBias entry (`{ weeklyBias, dailyTrend }` or undefined if
// the bias hook hasn't resolved that symbol yet) into the shape
// scanColumns.jsx renders. Shared by MarketPanel and WatchlistPanel so both
// tables apply the exact same 3-tier-agreement rule rather than each
// re-deriving it. A bearish (short) signal is vetoed
// when the symbol isn't shortable on OKX (spot has no short mechanism at
// all — see okx.js's isShortable) since that's not a trade the user can
// actually place, no matter how well the setup otherwise lines up.
export function attachEntry(row, bias) {
  const weekly = bias?.weeklyBias ?? null;
  const daily = bias?.dailyTrend ?? null;
  const aligned = weekly != null && weekly === daily;
  const trigger = row.fourHTrigger;
  const triggered = aligned && trigger && trigger.direction === weekly;
  const shortBlocked = triggered && weekly === "bearish" && !row.shortable;
  const mtfTrade = triggered && !shortBlocked ? buildTrade(trigger, MTF_R_MULTIPLE) : null;
  return {
    ...row,
    weeklyBias: weekly,
    dailyTrend: daily,
    changePct1w: bias?.changePct1w ?? null,
    mtfTrade,
    trendRead: overallTrend(weekly, daily, row.trend),
  };
}

// One-glance read across all three swing-relevant timeframes (4H/Daily/
// Weekly — the same tiers attachEntry checks for a live entry, minus the
// trigger timing), for the Market/Watchlist tables' "Trend" column. Distinct
// from mtfRegime (which is Weekly+Daily only, for the slower-cadence
// betaNeutral basket build): this folds in the 4H read too since that's the
// scan's actual trading horizon. "sideways" covers both a genuine flat 4H
// read (trendFactor's near-zero-separation case — the only one of the three
// that can produce it) and the three tiers disagreeing with each other:
// either way there's no single clean direction to hang a read on. Returns
// null only while a tier hasn't resolved yet (weekly/dailyTrend arrive on
// useMarketBias's slower cadence and can lag the 4H scan).
export function overallTrend(weeklyBias, dailyTrend, fourHTrend) {
  if (weeklyBias == null || dailyTrend == null || fourHTrend == null) return null;
  if (weeklyBias === dailyTrend && dailyTrend === fourHTrend) return weeklyBias;
  return "sideways";
}
