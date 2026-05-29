import axios from "axios";
import colors from "colors";

const CONFIG = {
  BASE: "https://api.binance.com/api/v3",
  BASE_ASSET: "USDT",
  TIMEFRAME: "1d",
  INVESTMENT_HORIZON: 50,
};

const args = process.argv.slice(2);
let globalDir = "long";
const trades = [];

for (const arg of args) {
  if (arg === "-s" || arg === "--short") globalDir = "short";
  else if (arg === "-l" || arg === "--long") globalDir = "long";
  else if (arg.includes("@")) {
    const [ticker, price] = arg.split("@");
    trades.push({
      symbol: ticker.toUpperCase(),
      entry: parseFloat(price),
      dir: globalDir,
    });
  }
}

const getSMA = (v) => v.reduce((a, b) => a + b, 0) / v.length;
const getStdDev = (v, mean) =>
  Math.sqrt(
    v.reduce((acc, x) => acc + Math.pow(x - mean, 2), 0) / (v.length - 1),
  );

const calculateATR = (candles, p = 14) => {
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

async function analyzeTrade(trade) {
  try {
    const { data } = await axios.get(`${CONFIG.BASE}/klines`, {
      params: {
        symbol: `${trade.symbol}${CONFIG.BASE_ASSET}`,
        interval: CONFIG.TIMEFRAME,
        limit: CONFIG.INVESTMENT_HORIZON + 20,
      },
    });

    const closes = data.map((c) => parseFloat(c[4]));
    const candles = data.map((c) => ({
      h: parseFloat(c[2]),
      l: parseFloat(c[3]),
      c: parseFloat(c[4]),
    }));

    const current = closes[closes.length - 1];
    const atr = calculateATR(candles, 14);

    // Calculate PnL
    const pnl =
      trade.dir === "short"
        ? ((trade.entry - current) / trade.entry) * 100
        : ((current - trade.entry) / trade.entry) * 100;

    // Calculate dynamic levels
    const sl =
      trade.dir === "short" ? trade.entry + atr * 1.5 : trade.entry - atr * 1.5;
    const tp =
      trade.dir === "short" ? trade.entry - atr * 3 : trade.entry + atr * 3;

    // --- DECISION LOGIC ---
    let action = "HOLD";
    if (trade.dir === "short") {
      if (current >= sl) action = "DROP (STOP LOSS)";
      else if (current <= tp) action = "DROP (TAKE PROFIT)";
    } else {
      if (current <= sl) action = "DROP (STOP LOSS)";
      else if (current >= tp) action = "DROP (TAKE PROFIT)";
    }

    // --- UI ---
    const dirCol = trade.dir === "short" ? colors.magenta : colors.cyan;
    const actionCol = action === "HOLD" ? colors.green : colors.red;
    const pnlCol = pnl >= 0 ? colors.green : colors.red;

    console.log(
      `${dirCol.bold(trade.symbol.padEnd(5))} ${colors.bold(trade.dir.toUpperCase())}`,
    );
    console.log(
      `  Mkt: $${current.toFixed(2)} | PnL: ${pnlCol(pnl.toFixed(2) + "%")}`,
    );
    console.log(`  Action: ${actionCol.bold(action)}`);
    console.log(`  SL: $${sl.toFixed(2)} | TP: $${tp.toFixed(2)}\n`);
  } catch (e) {
    console.log(colors.red(`  ${trade.symbol} not found.`));
  }
}

async function run() {
  console.clear();
  if (trades.length === 0)
    return console.log(
      "Usage: node coin.js -s NEAR@2.685 BTC@76000 -l ETH@2070",
    );
  for (const trade of trades) await analyzeTrade(trade);
}

run();
