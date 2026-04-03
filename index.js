import axios from "axios";
import Table from "cli-table3";
import colors from "colors";

const BINANCE_BASE = "https://api.binance.com/api/v3";
const FEAR_API = "https://api.alternative.me/fng/";
const APP_NAME = "MARKET TRACKER";
const VERSION = "v1.0";
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
]);

// --- ANALYTICS ---
const getMean = (d) => d.reduce((a, b) => a + b, 0) / d.length;
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
  return trs.slice(-p).reduce((a, b) => a + b, 0) / p;
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
    const volR = volumes[volumes.length - 1] / getMean(volumes.slice(-20));
    const atr = getATR(candles, 14);

    let score = 50;
    let sig = colors.dim("WAIT");

    if (regime === "REVERSION") {
      if (z < -2.2 && rsi < 30) {
        score = 85 + Math.abs(z) * 2;
        sig = colors.green("SNIPE");
      }
    } else if (regime === "MOMENTUM") {
      if (curr > sma200 && volR > 2.0 && rsi > 55 && rsi < 75) {
        score = 90;
        sig = colors.cyan("BREAK");
      }
      if (btcTrend === "BEAR") score -= 20;
    }

    if (rsi > 80 || z > 2.5) {
      score -= 50;
      sig = colors.red("BLOWOUT");
    }

    const sl = Math.min(...data.map((c) => +c[3]).slice(-5)) - atr * 0.2;
    const tp = curr + (curr - sl) * 2.5;

    let grade = "C";
    if (score >= 90) grade = "S";
    else if (score >= 80) grade = "A";
    else if (score >= 70) grade = "B";

    return {
      sym: symbol.replace("USDT", ""),
      px:
        curr < 1
          ? curr.toFixed(5)
          : curr.toLocaleString(undefined, { minimumFractionDigits: 2 }),
      stat: `${z > 0 ? "+" : ""}${z.toFixed(1)}σ  ${rsi.toFixed(0)}%`,
      vol: volR.toFixed(1) + "x",
      sig,
      targets: `${sl.toFixed(2)} — ${tp.toFixed(2)}`,
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
  process.stdout.write(colors.dim("\n  Gathering market intelligence...\n"));

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
        +x.quoteVolume > 40000000,
    )
    .sort((a, b) => b.quoteVolume - a.quoteVolume)
    .slice(0, 50)
    .map((x) => x.symbol);

  const rawResults = (
    await Promise.all(
      pool.slice(0, 15).map((s) => analyzeAsset(s, fear, "NEUTRAL", btcTrend)),
    )
  ).filter((r) => r);
  const bullPct =
    (rawResults.filter((r) => r.isBull).length / rawResults.length) * 100;

  let regime = fear < 35 ? "REVERSION" : bullPct > 60 ? "MOMENTUM" : "NEUTRAL";
  const results = (
    await Promise.all(pool.map((s) => analyzeAsset(s, fear, regime, btcTrend)))
  ).filter((r) => r);

  console.clear();

  // TYPORA STYLE HEADER
  console.log(`\n  ${colors.bold(APP_NAME)} ${colors.dim(VERSION)}`);
  console.log(`  ${colors.dim("─".repeat(24))}`);

  const m = (k, v) => console.log(`  ${colors.dim(k.padEnd(12))} ${v}`);
  m("Status", regime);
  m("Sentiment", fear + "/100");
  m(
    "Trend",
    btcTrend === "BULL" ? colors.white("BULLISH") : colors.dim("BEARISH"),
  );
  m("Breadth", bullPct.toFixed(0) + "% > SMA200");
  console.log("");

  const table = new Table({
    head: [
      "RANK",
      "ASSET",
      "PRICE",
      "Z/RSI",
      "VOL",
      "SIGNAL",
      "TARGET RANGE (1:2.5)",
    ].map((h) => colors.dim(h)),
    chars: {
      top: "",
      "top-mid": "",
      "top-left": "",
      "top-right": "",
      bottom: "",
      "bottom-mid": "",
      "bottom-left": "",
      "bottom-right": "",
      left: "  ",
      "left-mid": "",
      mid: "",
      "mid-mid": "",
      right: "",
      "right-mid": "",
      middle: "    ",
    },
    style: { "padding-left": 0, "padding-right": 0 },
  });

  results
    .sort((a, b) => b.score - a.score)
    .slice(0, COIN_LIMIT)
    .forEach((r) => {
      const gColor =
        r.grade === "S"
          ? colors.green
          : r.grade === "A"
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
  console.log(`\n  ${colors.dim(`System ready. Mode: ${regime} strategy.`)}\n`);
}

start();
