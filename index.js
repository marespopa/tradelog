import axios from "axios";
import colors from "colors";

const SYSTEM_CONFIG = {
  API_BASE_URL: "https://api.binance.com/api/v3",
  APPLICATION_TITLE: "SCANNER",
  MAX_DISPLAY_RESULTS: 10,
  MINIMUM_DAILY_VOLUME: 5_000_000,
  MARKET_SCAN_DEPTH: 100,
  STABLECOIN_EXCLUSION_LIST: new Set([
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
    "U",
    "USD1",
    "RLUSD",
    "USTC",
    "LUSD",
  ]),
};

colors.setTheme({
  title: ["white", "bold"],
  ticker: ["white", "bold"],
  score: ["blue"],
  signal: ["white"],
  value: ["white"],
  tp: ["white"],
  sl: ["gray"],
  dim: ["gray"],
});

// --- TECHNICAL UTILITIES ---

function calculateEMA(series, period) {
  const k = 2 / (period + 1);
  return series.reduce((acc, val, idx) =>
    idx === 0 ? val : val * k + acc * (1 - k),
  );
}

function calculateRSI(closes, period = 9) {
  let gains = 0,
    losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    diff >= 0 ? (gains += diff) : (losses -= diff);
  }
  let avgG = gains / period,
    avgL = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgG = (avgG * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgL = (avgL * (period - 1) + (diff < 0 ? -diff : 0)) / period;
  }
  return 100 - 100 / (1 + avgG / avgL);
}

function calculateADX(highs, lows, closes, period = 14) {
  let plusDM = [],
    minusDM = [],
    tr = [];
  for (let i = 1; i < highs.length; i++) {
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    tr.push(
      Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1]),
      ),
    );
  }
  const sTR = calculateEMA(tr, period);
  const sPlus = calculateEMA(plusDM, period);
  const sMinus = calculateEMA(minusDM, period);
  const diP = (sPlus / sTR) * 100;
  const diM = (sMinus / sTR) * 100;
  return Math.abs((diP - diM) / (diP + diM)) * 100;
}

function calculateATR(highs, lows, closes, period = 14) {
  let trs = highs.map((h, i) =>
    i === 0
      ? h - lows[i]
      : Math.max(
          h - lows[i],
          Math.abs(h - closes[i - 1]),
          Math.abs(lows[i] - closes[i - 1]),
        ),
  );
  return trs.slice(-period).reduce((a, b) => a + b) / period;
}

function formatCurrency(v) {
  return v < 1 ? v.toFixed(6) : v.toFixed(2);
}

// --- ANALYTICS ENGINE ---

async function performMarketAnalysis(symbol) {
  try {
    const { data } = await axios.get(`${SYSTEM_CONFIG.API_BASE_URL}/klines`, {
      params: { symbol, interval: "1d", limit: 150 },
    });

    const highs = data.map((d) => parseFloat(d[2]));
    const lows = data.map((d) => parseFloat(d[3]));
    const closes = data.map((d) => parseFloat(d[4]));
    const volumes = data.map((d) => parseFloat(d[7]));

    // QUANT FILTER: Ignore assets with < 1% daily price variance (Filters USD1/Stables)
    const recentCloses = closes.slice(-10);
    const volatility =
      (Math.max(...recentCloses) - Math.min(...recentCloses)) /
      Math.min(...recentCloses);
    if (volatility < 0.01) return null;

    const price = closes[closes.length - 1];
    const ema50 = calculateEMA(closes, 50);
    const ema200 = calculateEMA(closes, 200);
    const rsi = calculateRSI(closes);
    const adx = calculateADX(highs, lows, closes);
    const atr = calculateATR(highs, lows, closes);

    const vSlice = volumes.slice(-20);
    const vAvg = vSlice.reduce((a, b) => a + b) / 20;
    const vStd = Math.sqrt(
      vSlice.map((x) => Math.pow(x - vAvg, 2)).reduce((a, b) => a + b) / 20,
    );
    const volZ = (volumes[volumes.length - 1] - vAvg) / vStd;

    let score = 0;
    const tags = [];

    if (price > ema200 && adx > 25) {
      score += 40;
      tags.push("Strong Trend");
    } else if (price > ema200) {
      score += 20;
      tags.push("Weak Trend");
    }

    const distToEMA = (price - ema50) / ema50;
    if (distToEMA > 0 && distToEMA < 0.02) {
      score += 30;
      tags.push("EMA50 Bounce");
    }

    if (rsi < 40) {
      score += 15;
      tags.push("Oversold");
    }
    if (volZ > 2.0) {
      score += 15;
      tags.push("Vol Spike");
    }

    return {
      symbol: symbol.replace("USDT", ""),
      price,
      score,
      rsi: rsi.toFixed(0),
      adx: adx.toFixed(0),
      tags: tags.join(", "),
      stopLoss: price - atr * 1.5,
      takeProfit: price + atr * 3.0,
    };
  } catch (e) {
    return null;
  }
}

// --- SCANNER EXECUTION ---

async function runScanner() {
  console.log(colors.dim("Scanning..."));
  const { data: tickers } = await axios.get(
    `${SYSTEM_CONFIG.API_BASE_URL}/ticker/24hr`,
  );

  const pool = tickers
    .filter((t) => {
      const baseAsset = t.symbol.replace("USDT", "");
      return (
        t.symbol.endsWith("USDT") &&
        !SYSTEM_CONFIG.STABLECOIN_EXCLUSION_LIST.has(baseAsset) && // ACTIVE FILTER
        parseFloat(t.quoteVolume) > SYSTEM_CONFIG.MINIMUM_DAILY_VOLUME
      );
    })
    .sort((a, b) => b.quoteVolume - a.quoteVolume)
    .slice(0, SYSTEM_CONFIG.MARKET_SCAN_DEPTH);

  const results = [];
  for (let i = 0; i < pool.length; i += 10) {
    const chunk = pool.slice(i, i + 10);
    const processed = await Promise.all(
      chunk.map((t) => performMarketAnalysis(t.symbol)),
    );
    results.push(...processed.filter((r) => r && r.score >= 40));
  }

  render(
    results
      .sort((a, b) => b.score - a.score)
      .slice(0, SYSTEM_CONFIG.MAX_DISPLAY_RESULTS),
  );
}

function render(data) {
  console.clear();
  console.log(`\n ${colors.title(SYSTEM_CONFIG.APPLICATION_TITLE)}`);
  console.log(` ${colors.dim(new Date().toISOString().substring(0, 10))}\n`);

  data.forEach((s) => {
    console.log(
      ` ${colors.ticker(s.symbol.padEnd(8))} ${colors.score(`Score ${s.score}`)} ${colors.dim(`RSI ${s.rsi} | ADX ${s.adx}`)}`,
    );
    console.log(` ${colors.signal(s.tags)}`);
    console.log(
      ` ${colors.value(`Price ${formatCurrency(s.price)}`)}  ${colors.tp(`Target ${formatCurrency(s.takeProfit)}`)}  ${colors.sl(`Stop ${formatCurrency(s.stopLoss)}`)}\n`,
    );
  });
}

runScanner();
