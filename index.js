import axios from "axios";
import http from "http";
import https from "https";

const CONFIG = {
  TITLE: "QUANT ALPHA PROD",
  BASE: "https://api.binance.com/api/v3",
  BASE_ASSET: "USDT",
  EXCLUSIONS: new Set([
    "USDT",
    "USDC",
    "FDUSD",
    "DAI",
    "WBTC",
    "WETH",
    "USDE",
    "BUSD",
    "EUR",
    "UST",
  ]),
  MIN_VOLUME: 10_000_000,
  TIMEFRAME: "1d",
  INVESTMENT_HORIZON: 50,
  Z_THRESHOLD: 1.5,
  CONCURRENCY: 10,
  TIMEOUT: 5000,
  MIN_REBOUND_PCT: 1.5,
};

const UI = {
  CLEAR: "\x1b[2J\x1b[H",
  RESET: "\x1b[0m",
  BOLD: "\x1b[1m",
  DIM: "\x1b[2m",
  CLEAR_LINE: "\x1b[K",
  SF_WHITE: "\x1b[38;5;255m",
  SF_GREY: "\x1b[38;5;244m",
  SF_DARK: "\x1b[38;5;237m",
  APPLE_GREEN: "\x1b[38;5;76m",
  APPLE_RED: "\x1b[38;5;168m",
  APPLE_BLUE: "\x1b[38;5;33m",
  LINE_WIDTH: 65,
};

const client = axios.create({
  baseURL: CONFIG.BASE,
  timeout: CONFIG.TIMEOUT,
  httpAgent: new http.Agent({
    keepAlive: true,
    maxSockets: 100,
    freeSocketTimeout: 30000,
  }),
  httpsAgent: new https.Agent({
    keepAlive: true,
    maxSockets: 100,
    freeSocketTimeout: 30000,
  }),
});

const getSMA = (v) =>
  v.length === 0 ? 0 : v.reduce((a, b) => a + b, 0) / v.length;

const getStdDev = (v, mean) => {
  if (v.length <= 1) return 0.001;
  const variance =
    v.reduce((acc, x) => acc + Math.pow(x - mean, 2), 0) / (v.length - 1);
  return variance <= 1e-8 ? 0.001 : Math.sqrt(variance);
};

const getSignalScore = (z, deltaZ, volRatio) => {
  if (isNaN(z) || !isFinite(z)) return 0.0;

  // Exponential scaling instead of linear clamping ensures extreme moves score higher
  const intensity = (1 - Math.exp(-Math.abs(z) / 2.0)) * 0.4;

  let reversion = 0.1;
  if ((z < 0 && deltaZ > 0) || (z > 0 && deltaZ < 0)) {
    reversion = 0.4;
  } else if (Math.abs(z) > 2.0 && volRatio > 1.2) {
    reversion = 0.25;
  }

  const volume = Math.min(volRatio / 2.0, 1.0) * 0.2;
  return Math.min(Math.max(intensity + reversion + volume, 0.0), 1.0);
};

async function apiGet(url, params = {}, retries = 3) {
  try {
    return await client.get(url, { params });
  } catch (err) {
    const status = err.response?.status;
    if ((status === 429 || status === 418) && retries > 0) {
      const wait = parseInt(err.response.headers["retry-after"], 10) || 2;
      await new Promise((r) => setTimeout(r, wait * 1000));
      return apiGet(url, params, retries);
    }
    if (retries > 0 && (err.code === "ECONNRESET" || status >= 500)) {
      await new Promise((r) => setTimeout(r, 500));
      return apiGet(url, params, retries - 1);
    }
    throw err;
  }
}

async function getMarketsContext() {
  try {
    const { data } = await apiGet("/ticker/24hr");
    const contextMap = new Map();

    for (let i = 0; i < data.length; i++) {
      const ticker = data[i];
      if (!ticker.symbol.endsWith(CONFIG.BASE_ASSET)) continue;

      const sym = ticker.symbol.slice(0, -CONFIG.BASE_ASSET.length);
      if (
        !CONFIG.EXCLUSIONS.has(sym) &&
        !sym.includes("USD") &&
        !sym.includes("EUR") &&
        parseFloat(ticker.quoteVolume) > CONFIG.MIN_VOLUME
      ) {
        contextMap.set(ticker.symbol, {
          lowPrice: parseFloat(ticker.lowPrice),
          highPrice: parseFloat(ticker.highPrice),
        });
      }
    }
    return contextMap;
  } catch {
    return new Map();
  }
}

async function getMetrics(symbol, marketContext) {
  try {
    const context = marketContext.get(symbol);
    if (!context) return null;

    const { data } = await apiGet("/klines", {
      symbol,
      interval: CONFIG.TIMEFRAME,
      limit: CONFIG.INVESTMENT_HORIZON + 5,
    });
    if (!Array.isArray(data) || data.length < CONFIG.INVESTMENT_HORIZON + 2)
      return null;

    const closes = data.map((d) => parseFloat(d[4]));
    const volumes = data.map((d) => parseFloat(d[5]));
    const price = closes[closes.length - 1];

    // Synchronize intraday metrics directly to 24-hour ticker context
    const distanceFromLowPct =
      context.lowPrice > 0
        ? ((price - context.lowPrice) / context.lowPrice) * 100
        : 0;
    const distanceFromHighPct =
      context.highPrice > 0
        ? ((context.highPrice - price) / context.highPrice) * 100
        : 0;

    // Use stabilized historical slices for baseline metrics
    const h1 = closes.slice(-CONFIG.INVESTMENT_HORIZON - 1, -1);
    const sma1 = getSMA(h1);
    const stdDev1 = getStdDev(h1, sma1);
    const z1 = (price - sma1) / stdDev1;

    const prevPrice = closes[closes.length - 2];
    const h2 = closes.slice(-CONFIG.INVESTMENT_HORIZON - 2, -2);
    const sma2 = getSMA(h2);
    const z2 = (prevPrice - sma2) / getStdDev(h2, sma2);
    const deltaZ = z1 - z2;

    const volSMA = getSMA(volumes.slice(-CONFIG.INVESTMENT_HORIZON - 1, -1));
    const volRatio = volSMA === 0 ? 1 : volumes[volumes.length - 1] / volSMA;

    const cleanSymbol = symbol.slice(0, -CONFIG.BASE_ASSET.length);
    const rawScore = getSignalScore(z1, deltaZ, volRatio);

    return {
      symbol: cleanSymbol,
      price: price < 1 ? price.toFixed(5) : price.toFixed(2),
      z: z1.toFixed(2),
      dz: deltaZ >= 0 ? `+${deltaZ.toFixed(2)}` : deltaZ.toFixed(2),
      vol: `${volRatio.toFixed(1)}x`,
      score: `${Math.round(rawScore * 100)}%`,
      rawZ: z1,
      rawDz: deltaZ,
      rawScore,
      volRatio,
      distanceFromLowPct,
      distanceFromHighPct,
    };
  } catch {
    return null;
  }
}

function renderProgressBar(percentage) {
  const width = 15;
  const completed = Math.round((percentage / 100) * width);
  const remaining = Math.max(0, width - completed);
  return `${UI.SF_WHITE}[${UI.APPLE_BLUE}${"■".repeat(completed)}${UI.SF_DARK}${".".repeat(remaining)}${UI.SF_WHITE}]${UI.RESET}`;
}

function display(state) {
  const formatLine = (color) => (item) => {
    if (!item || !item.symbol) return "";
    const sym = `${UI.BOLD}${UI.SF_WHITE}${item.symbol.padEnd(8)}${UI.RESET}`;
    const prc = `${UI.SF_GREY}${item.price.padStart(11)}${UI.RESET}`;
    const zVal = `z: ${color}${item.z.padStart(5)}${UI.RESET}`;
    const dzVal = `dz: ${parseFloat(item.dz) >= 0 ? UI.APPLE_GREEN : UI.APPLE_RED}${item.dz.padStart(5)}${UI.RESET}`;
    const vVal = `${UI.DIM}vol: ${item.vol.padStart(5)}${UI.RESET}`;
    const scr = `${UI.BOLD}${color}${item.score.padStart(5)}${UI.RESET}`;
    return `  ${sym} ${prc}   ${zVal}  ${dzVal}  ${vVal}  💰 ${scr}${UI.CLEAR_LINE}`;
  };

  const numericProgress = parseInt(state.progress, 10) || 0;
  let out = "\x1b[H";

  out += `${UI.BOLD}${UI.SF_WHITE}${CONFIG.TITLE.padEnd(18)}${UI.RESET}`;
  out += `${UI.SF_GREY}${state.status.padStart(20)}${UI.RESET}  `;
  out += `${renderProgressBar(numericProgress)} ${UI.SF_GREY}${state.progress.padStart(4)}${UI.RESET}${UI.CLEAR_LINE}\n`;
  out += `${UI.SF_DARK}${"─".repeat(UI.LINE_WIDTH)}${UI.RESET}${UI.CLEAR_LINE}\n\n`;

  out += `  ${UI.BOLD}${UI.APPLE_GREEN}▲  OVERSOLD / BUY TARGETS (CONFIRMED BOTTOMS)${UI.RESET}${UI.CLEAR_LINE}\n`;
  const buyItems = state.buys.slice(0, 8);
  out += buyItems.length
    ? buyItems.map(formatLine(UI.APPLE_GREEN)).join("\n") + "\n"
    : `    ${UI.DIM}No high-probability reversal targets triggered.${UI.RESET}${UI.CLEAR_LINE}\n`;
  out += `${UI.CLEAR_LINE}\n`;

  out += `  ${UI.BOLD}${UI.APPLE_RED}▼  OVERBOUGHT / SELL TARGETS (FADING MOMENTUM)${UI.RESET}${UI.CLEAR_LINE}\n`;
  const sellItems = state.sells.slice(0, 8);
  out += sellItems.length
    ? sellItems.map(formatLine(UI.APPLE_RED)).join("\n") + "\n"
    : `    ${UI.DIM}No exhausted distribution targets triggered.${UI.RESET}${UI.CLEAR_LINE}\n`;
  out += `${UI.CLEAR_LINE}\n`;

  process.stdout.write(out);
}

async function run() {
  const state = { status: "Initializing", progress: "0%", buys: [], sells: [] };
  process.stdout.write(UI.CLEAR);

  const marketContext = await getMarketsContext();
  const assets = Array.from(marketContext.keys());

  if (!assets.length) {
    console.log(
      `${UI.APPLE_RED}Error: Operational liquidity maps empty.${UI.RESET}`,
    );
    process.exit(1);
  }

  const uiInterval = setInterval(() => display(state), 100);
  let currentCursor = 0;

  const executeWorker = async () => {
    while (true) {
      const idx = currentCursor++;
      if (idx >= assets.length) break;

      const targetSymbol = assets[idx];
      const cleanLabel = targetSymbol.slice(0, -CONFIG.BASE_ASSET.length);

      state.status = `Scouting ${cleanLabel}`;
      state.progress = `${Math.round((idx / assets.length) * 100)}%`;

      const metric = await getMetrics(targetSymbol, marketContext);
      if (metric) {
        if (metric.rawZ < -CONFIG.Z_THRESHOLD) {
          const hasStructuralRebound =
            metric.distanceFromLowPct >= CONFIG.MIN_REBOUND_PCT;
          const isFallingKnife = metric.rawDz <= 0;
          const isUnabsorbedCapitulation =
            metric.volRatio > 3.0 && metric.rawDz < 0.2;

          if (
            hasStructuralRebound &&
            !isFallingKnife &&
            !isUnabsorbedCapitulation &&
            (metric.volRatio > 1.2 || metric.rawDz > 0)
          ) {
            state.buys.push(metric);
          }
        } else if (metric.rawZ > CONFIG.Z_THRESHOLD) {
          const isRunawayTrain = metric.rawDz > 0.8 && metric.volRatio > 2.0;
          const hasRejectedHigh = metric.distanceFromHighPct >= 1.0;

          if (
            !isRunawayTrain &&
            hasRejectedHigh &&
            (metric.rawDz < 0 || metric.volRatio >= 2.5)
          ) {
            state.sells.push(metric);
          }
        }
      }
    }
  };

  const poolingQueue = Array.from(
    { length: CONFIG.CONCURRENCY },
    executeWorker,
  );
  await Promise.all(poolingQueue);

  // High Performance Optimization: Sort precisely once upon full sequence resolution
  state.buys.sort((a, b) => b.rawScore - a.rawScore);
  state.sells.sort((a, b) => b.rawScore - a.rawScore);

  clearInterval(uiInterval);

  state.status = "Complete";
  state.progress = "100%";
  display(state);

  process.stdout.write("\n\n");
  process.exit(0);
}

run();
