import axios from "axios";
import { search, confirm } from "@inquirer/prompts";
import Table from "cli-table3";
import colors from "colors";

const BINANCE_BASE = "https://api.binance.com/api/v3";
const STABLECOINS = new Set([
  "USDT",
  "USDC",
  "BUSD",
  "TUSD",
  "PAX",
  "DAI",
  "EUR",
  "GBP",
  "UST",
  "FDUSD",
  "USDE",
  "PYUSD",
  "USD1",
  "U",
  "RLUSD",
  "XUSD",
  "AEUR",
  "ZUSD",
]);

const getStats = (values) => {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sd = Math.sqrt(
    values.map((v) => Math.pow(v - mean, 2)).reduce((a, b) => a + b, 0) /
      values.length,
  );
  return { mean, sd };
};

const getCorrelation = (x, y) => {
  const { mean: mx } = getStats(x);
  const { mean: my } = getStats(y);
  const num = x.reduce((acc, val, i) => acc + (val - mx) * (y[i] - my), 0);
  const den = Math.sqrt(
    x.reduce((acc, val) => acc + Math.pow(val - mx, 2), 0) *
      y.reduce((acc, val) => acc + Math.pow(val - my, 2), 0),
  );
  return den === 0 ? 0 : num / den;
};

function calculateATR(candles, period = 14) {
  const ranges = candles.slice(-period).map((c) => c.high - c.low);
  return ranges.reduce((a, b) => a + b, 0) / period;
}

async function fetchSwingAnalysis(symbol) {
  try {
    const { data } = await axios.get(`${BINANCE_BASE}/klines`, {
      params: { symbol, interval: "1d", limit: 60 },
      timeout: 5000,
    });
    const candles = data.map((c) => ({
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
      volume: parseFloat(c[5]),
    }));

    const closes = candles.map((c) => c.close);
    const last14 = candles.slice(-14);

    const { mean: avgVol, sd: sdVol } = getStats(last14.map((c) => c.volume));
    const current = candles[candles.length - 1];
    const volZ = (current.volume - avgVol) / (sdVol || 1);

    const ma10 = closes.slice(-10).reduce((a, b) => a + b, 0) / 10;
    const ma50 = closes.slice(-50).reduce((a, b) => a + b, 0) / 50;
    const atr = calculateATR(candles);

    const expectedMovePct = (atr / current.close) * 100;

    const isBullish = current.close > ma10 && ma10 > ma50;
    const isBearish = current.close < ma10 && ma10 < ma50;

    const status =
      isBullish && volZ > 1.0
        ? "BUY"
        : isBearish && volZ > 1.0
          ? "SELL"
          : "WAIT";

    let strength = 1.0;
    if (volZ > 2.0) strength += 2.0;
    if (volZ > 3.5) strength += 1.0;
    if (Math.abs((current.close - ma10) / ma10) > 0.02) strength += 1.0;

    return {
      symbol,
      price: current.close,
      history: closes.slice(-15),
      atr,
      expectedMovePct,
      volZ,
      status,
      strength: Math.min(5, strength),
    };
  } catch {
    return null;
  }
}

async function runSwingEngine() {
  console.clear();
  console.log(colors.cyan.bold("Market Analysis \n"));

  const { data: tickers } = await axios.get(`${BINANCE_BASE}/ticker/24hr`);
  const topSymbols = tickers
    .filter(
      (t) =>
        t.symbol.endsWith("USDT") &&
        !STABLECOINS.has(t.symbol.replace("USDT", "")),
    )
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, 80)
    .map((t) => t.symbol);

  const action = await search({
    message: "Single Mode:",
    source: async (input) => {
      const base = [
        { name: "🔍 SCAN", value: "SCAN" },
        { name: "❌ EXIT", value: "EXIT" },
      ];
      if (!input)
        return [...base, ...topSymbols.map((s) => ({ name: s, value: s }))];
      return topSymbols
        .filter((s) => s.includes(input.toUpperCase()))
        .map((s) => ({ name: s, value: s }));
    },
  });

  if (action === "EXIT") process.exit(0);

  // --- OPTION 1: SCAN ALL ---
  if (action === "SCAN") {
    const results = [];
    for (let i = 0; i < topSymbols.length; i += 10) {
      process.stdout.write(
        `\r${colors.gray(`Getting Data: ${Math.round((i / topSymbols.length) * 100)}%`)}`,
      );
      const batch = await Promise.all(
        topSymbols.slice(i, i + 10).map((s) => fetchSwingAnalysis(s)),
      );
      results.push(...batch.filter((r) => r && r.status !== "WAIT"));
    }

    console.clear();
    const table = new Table({
      head: [
        "Symbol",
        "Price",
        "Vol Z",
        "Exp. Move",
        "Strength",
        "Correlation",
      ],
      style: { head: ["cyan"] },
    });

    results
      .sort((a, b) => b.strength - a.strength)
      .forEach((r, idx) => {
        const theme = r.status === "BUY" ? colors.green : colors.red;
        let correlationWarning = "";
        results.forEach((other, oIdx) => {
          if (idx !== oIdx) {
            const corr = getCorrelation(r.history, other.history);
            if (corr > 0.8) {
              const label = colors.yellow(
                `~${other.symbol}(${Math.round(corr * 100)}%)`,
              );
              correlationWarning += correlationWarning ? `, ${label}` : label;
            }
          }
        });

        table.push([
          theme.bold(r.symbol),
          r.price.toFixed(4),
          `${r.volZ.toFixed(1)}σ`,
          `${r.expectedMovePct.toFixed(2)}%`,
          `${r.strength.toFixed(1)}/5 ${theme(r.status)}`,
          correlationWarning || colors.gray("Low"),
        ]);
      });

    console.log(table.toString() || "No anomalies detected.");
  }

  // --- OPTION 2: INDIVIDUAL TICKER ---
  else {
    console.log(colors.yellow(`\nPulling depth for ${action}...`));
    const r = await fetchSwingAnalysis(action);

    if (!r) {
      console.log(colors.red("Error: Could not retrieve ticker data."));
    } else {
      const theme =
        r.status === "BUY"
          ? colors.green
          : r.status === "SELL"
            ? colors.red
            : colors.white;

      console.clear();
      console.log(colors.cyan.bold(`\nQuant Analytics: ${r.symbol}`));
      console.log(colors.gray("==========================================="));
      console.log(`Spot Price:       ${colors.white(r.price.toFixed(4))}`);
      console.log(`Vol Z-Score:      ${theme(r.volZ.toFixed(2) + "σ")}`);
      console.log(
        `Expected Move:    ${colors.yellow(r.expectedMovePct.toFixed(2) + "%/day")}`,
      );
      console.log(`ATR (14):         ${r.atr.toFixed(4)}`);
      console.log(
        `Signal:           ${theme.bold(r.strength.toFixed(1) + "/5 " + r.status)}`,
      );
      console.log(colors.gray("==========================================="));

      // Senior Quant Rule: Set stop loss 1 ATR away from price
      const stopLevel = r.status === "BUY" ? r.price - r.atr : r.price + r.atr;
      console.log(colors.blue(`Suggested Stop:   ${stopLevel.toFixed(4)}`));
    }
  }

  if (await confirm({ message: "\nRestart Engine?", default: true }))
    runSwingEngine();
}

runSwingEngine();
