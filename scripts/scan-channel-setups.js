// One-off live scan: which top-volume symbols are currently sitting at the
// edge of (or breaking) their 4H linear-regression channel (ta.js's
// linearRegressionChannel — an OLS trendline with ±stdMult residual-stdev
// bands, not a Donchian/rolling-extreme channel). Classification on the
// latest closed 4H bar:
//   - touches lower band without closing below it  -> buy setup
//   - touches upper band without closing above it  -> sell setup
//   - closes beyond either band                     -> breakout (up/down)
// "Touch" uses a tolerance band (TOUCH_PCT of price) since candles rarely
// land exactly on the line.
import { fetchTopVolumeTickers, fetchCandles, scanInBatches } from "../src/lib/analysis/okx.js";
import { linearRegressionChannel } from "../src/lib/analysis/ta.js";

const SYMBOL_COUNT = 80;
const CHANNEL_LOOKBACK = 60; // ~10 days of 4H bars
const TOUCH_PCT = 0.003; // 0.3% of price counts as "touching" the band

// OKX spot, regular (non-VIP, non-OKB-discounted) tier: 0.08% maker / 0.10%
// taker per side. A touch setup is a mean-reversion trade (entry near one
// band, target the other/mid band) so its round-trip cost is what has to be
// cleared before the trade is profitable net of fees.
const TAKER_FEE_PCT = 0.10;
const MAKER_FEE_PCT = 0.08;
const ROUNDTRIP_TAKER_PCT = TAKER_FEE_PCT * 2;
const ROUNDTRIP_MAKER_PCT = MAKER_FEE_PCT * 2;

async function classify(symbol) {
  const candles = await fetchCandles(symbol, "4h", CHANNEL_LOOKBACK + 5);
  const channel = linearRegressionChannel(candles, { lookback: CHANNEL_LOOKBACK });
  if (!channel) return null;

  const last = candles.at(-1);
  const band = channel.at(-1);
  const tol = last.close * TOUCH_PCT;

  const belowLower = last.close < band.lower;
  const aboveUpper = last.close > band.upper;
  const touchedLower = last.low <= band.lower + tol;
  const touchedUpper = last.high >= band.upper - tol;

  let setup = null;
  if (belowLower) setup = "BREAKOUT DOWN";
  else if (aboveUpper) setup = "BREAKOUT UP";
  else if (touchedLower) setup = "BUY (bottom touch)";
  else if (touchedUpper) setup = "SELL (top touch)";
  if (!setup) return null;

  const posPct = ((last.close - band.lower) / (band.upper - band.lower)) * 100;

  // Mean-reversion target for touch setups only: the opposite band. Breakouts
  // aren't mean-reversion trades (the channel just failed to contain price),
  // so there's no in-channel target to size against fees here.
  let grossMovePct = null;
  if (setup.startsWith("BUY")) grossMovePct = ((band.upper - last.close) / last.close) * 100;
  else if (setup.startsWith("SELL")) grossMovePct = ((last.close - band.lower) / last.close) * 100;

  const netVsTakerPct = grossMovePct != null ? grossMovePct - ROUNDTRIP_TAKER_PCT : null;
  const netVsMakerPct = grossMovePct != null ? grossMovePct - ROUNDTRIP_MAKER_PCT : null;

  return {
    symbol,
    setup,
    close: last.close,
    lower: band.lower,
    upper: band.upper,
    posPct,
    grossMovePct,
    netVsTakerPct,
    netVsMakerPct,
  };
}

const tickers = await fetchTopVolumeTickers(SYMBOL_COUNT);
const results = await scanInBatches(tickers.map((t) => t.symbol), async (symbol) => {
  try {
    return await classify(symbol);
  } catch {
    return null;
  }
});

const hits = results
  .filter((r) => r.status === "fulfilled" && r.value)
  .map((r) => r.value)
  .sort((a, b) => a.setup.localeCompare(b.setup));

function fmt(n) {
  const digits = n < 0.01 ? 8 : n < 1 ? 6 : n < 100 ? 4 : 2;
  return n.toFixed(digits);
}

if (!hits.length) {
  console.log("No 4H channel setups found in the current top-volume scan.");
} else {
  console.log(`${hits.length} 4H channel setup(s)  (fees: taker round-trip ${ROUNDTRIP_TAKER_PCT.toFixed(2)}%, maker round-trip ${ROUNDTRIP_MAKER_PCT.toFixed(2)}%):\n`);
  for (const h of hits) {
    const moveInfo =
      h.grossMovePct != null
        ? `  target-move=${h.grossMovePct.toFixed(2)}%  net(taker)=${h.netVsTakerPct.toFixed(2)}%  net(maker)=${h.netVsMakerPct.toFixed(2)}%${h.netVsTakerPct <= 0 ? "  [FEES EAT IT]" : ""}`
        : "  (breakout — no in-channel target)";
    console.log(
      `${h.symbol.padEnd(8)} ${h.setup.padEnd(20)} close=${fmt(h.close)}  channel=[${fmt(h.lower)}, ${fmt(h.upper)}]  pos=${h.posPct.toFixed(0)}%${moveInfo}`
    );
  }
}
