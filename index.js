import axios from "axios";
import Table from "cli-table3";
import colors from "colors";

const BINANCE_BASE = "https://api.binance.com/api/v3";
const FEAR_API = "https://api.alternative.me/fng/";
const APP_NAME = "MARKET TRACKER";
const VERSION = "v1.1";
const COIN_LIMIT = 12;
const EXCLUDE = new Set([
  "USDT",
  "USDC",
  "BUSD",
  "FDUSD",
  "DAI",
  "WBTC",
  "WETH",
  "USDS",
  "PYUSD",
  "EUR",
  "EURI",
  "USD1",
  "U",
]);

// --- ANALYTICS ---
const getMean = (d) => (d.length ? d.reduce((a, b) => a + b, 0) / d.length : 0);
const getStdDev = (d) => {
  const mu = getMean(d);
  return Math.sqrt(getMean(d.map((x) => Math.pow(x - mu, 2))));
};

const getRSI = (closes, p = 14) => {
  if (closes.length < p + 1) return 50;
  let g = 0,
    l = 0;
  for (let i = closes.length - p; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    d >= 0 ? (g += d) : (l -= d);
  }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
};

const getATR = (candles, p = 14) => {
  const trs = candles.map((c, i) =>
    i === 0
      ? c.h - c.l
      : Math.max(
          c.h - c.l,
          Math.abs(c.h - candles[i - 1].c),
          Math.abs(c.l - candles[i - 1].c),
        ),
  );
  return getMean(trs.slice(-p));
};

// --- CORE ENGINE ---
async function analyzeAsset(symbol, fear, regime, btcTrend) {
  try {
    const { data } = await axios.get(`${BINANCE_BASE}/klines`, {
      params: { symbol, interval: "4h", limit: 200 },
    });

    const closes = data.map((c) => +c[4]);
    const volumes = data.map((c) => +c[5]);
    const candles = data.map((c) => ({ h: +c[2], l: +c[3], c: +c[4] }));

    const curr = closes[closes.length - 1];
    const rsi = getRSI(closes);
    const sma20 = getMean(closes.slice(-20));
    const sma200 = getMean(closes.slice(-200));
    const z = (curr - sma20) / (getStdDev(closes.slice(-20)) || 0.000001);

    // Improved Volume: Current candle vs rolling average of last 20
    const avgVol = getMean(volumes.slice(-20)) || 1;
    const volR = volumes[volumes.length - 1] / avgVol;
    const atr = getATR(candles, 14);

    // --- DYNAMIC SCORING SYSTEM ---
    let score = 50;
    let sig = colors.dim("WAIT");

    // 1. Trend Factor
    if (curr > sma20) score += 10;
    if (curr > sma200) score += 15;

    // 2. Momentum / Reversion Logic
    if (regime === "REVERSION") {
      if (z < -1.5 || rsi < 35) {
        score += 20;
        if (z < -2.1 && rsi < 30) {
          score = 95;
          sig = colors.green("SNIPE");
        }
      }
    } else if (regime === "MOMENTUM") {
      if (curr > sma200 && rsi > 50) {
        score += 15;
        if (volR > 1.3 && rsi < 70) {
          score = 90;
          sig = colors.cyan("BREAK");
        }
      }
    }

    // 3. Volatility Boost
    if (volR > 2.0) score += 10;

    // 4. Safety Overrides
    if (rsi > 80 || z > 2.8) {
      score = 20;
      sig = colors.red("BLOWOUT");
    }

    // Risk Management
    const sl = Math.min(...data.slice(-6).map((c) => +c[3])) - atr * 0.1;
    const tp = curr + (curr - sl) * 2.5;

    let grade = "C";
    if (score >= 85) grade = "S";
    else if (score >= 70) grade = "A";
    else if (score >= 60) grade = "B";

    return {
      sym: symbol.replace("USDT", ""),
      px:
        curr < 1
          ? curr.toFixed(5)
          : curr.toLocaleString(undefined, { minimumFractionDigits: 2 }),
      stat: `${z > 0 ? "+" : ""}${z.toFixed(1)}σ ${rsi.toFixed(0)}%`,
      vol: volR.toFixed(1) + "x",
      sig,
      targets: `${sl.toFixed(2)} - ${tp.toFixed(2)}`,
      score,
      grade,
      isBull: curr > sma200,
    };
  } catch {
    return null;
  }
}

async function start() {
  console.clear();
  process.stdout.write(colors.yellow("⚡ Initiating Scan..."));

  let fear = 50;
  try {
    const { data } = await axios.get(FEAR_API);
    fear = parseInt(data.data[0].value);
  } catch (e) {}

  let btcTrend = "NEUTRAL";
  try {
    const { data: btcK } = await axios.get(`${BINANCE_BASE}/klines`, {
      params: { symbol: "BTCUSDT", interval: "4h", limit: 50 },
    });
    const btcCloses = btcK.map((c) => +c[4]);
    btcTrend =
      btcCloses[btcCloses.length - 1] > getMean(btcCloses) ? "BULL" : "BEAR";
  } catch (e) {}

  const { data: tickers } = await axios.get(`${BINANCE_BASE}/ticker/24hr`);
  const pool = tickers
    .filter(
      (x) =>
        x.symbol.endsWith("USDT") &&
        !EXCLUDE.has(x.symbol.replace("USDT", "")) &&
        +x.quoteVolume > 15000000,
    )
    .sort((a, b) => b.quoteVolume - a.quoteVolume)
    .slice(0, 60)
    .map((x) => x.symbol);

  // Breadth Check
  const sample = await Promise.all(
    pool.slice(0, 20).map((s) => analyzeAsset(s, fear, "NEUTRAL", btcTrend)),
  );
  const validSample = sample.filter((r) => r);
  const bullPct =
    (validSample.filter((r) => r.isBull).length / validSample.length) * 100;

  // Adaptive Regime
  let regime = fear < 30 ? "REVERSION" : bullPct > 55 ? "MOMENTUM" : "NEUTRAL";

  const results = (
    await Promise.all(pool.map((s) => analyzeAsset(s, fear, regime, btcTrend)))
  ).filter((r) => r);

  console.clear();
  console.log(
    `\n  ${colors.bold.bgWhite.black(` ${APP_NAME} `)} ${colors.dim(VERSION)}`,
  );
  console.log(`  ${colors.dim("─".repeat(36))}`);

  const m = (k, v) => console.log(`  ${colors.dim(k.padEnd(14))} ${v}`);
  m("Market Phase", colors.bold(regime));
  m("Fear & Greed", fear < 30 ? colors.red(fear) : colors.green(fear));
  m(
    "BTC Anchor",
    btcTrend === "BULL" ? colors.green("BULLISH") : colors.red("BEARISH"),
  );
  m("Breadth", bullPct.toFixed(0) + "% > SMA200");
  console.log("");

  const table = new Table({
    head: [
      "RK",
      "ASSET",
      "PRICE",
      "Z / RSI",
      "VOL",
      "SIGNAL",
      "TARGET RANGE (1:2.5)",
    ].map((h) => colors.dim(h)),
    colWidths: [6, 12, 14, 15, 8, 12, 28],
    chars: { mid: "", "left-mid": "", "mid-mid": "", "right-mid": "" },
    style: { "padding-left": 1, "padding-right": 1, head: [] },
  });

  results
    .sort((a, b) => b.score - a.score)
    .slice(0, COIN_LIMIT)
    .forEach((r) => {
      const gColor =
        r.grade === "S"
          ? colors.green
          : r.grade === "A"
            ? colors.cyan
            : r.grade === "B"
              ? colors.white
              : colors.dim;
      table.push([
        gColor(r.grade),
        colors.bold(r.sym),
        r.px,
        colors.dim(r.stat),
        r.vol,
        r.sig,
        colors.dim(r.targets),
      ]);
    });

  console.log(table.toString());
  console.log(
    `\n  ${colors.dim(`Scan complete. Strategy adapted to ${regime} conditions.`)}\n`,
  );
}

start();
