import axios from "axios";
import Table from "cli-table3";
import colors from "colors";
import readline from "readline";

const BINANCE_BASE = "https://api.binance.com/api/v3";

// --- PARAMETER PARSING ---
const paramTicker = process.argv[2]
  ? process.argv[2].toUpperCase().replace("USDT", "")
  : null;
const paramEntry = process.argv[3] ? parseFloat(process.argv[3]) : null;

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});
const question = (str) => new Promise((resolve) => rl.question(str, resolve));

// --- MATH ENGINE (V9 MERGED) ---
const getMean = (data) => data.reduce((a, b) => a + b, 0) / data.length;
const getStdDev = (data) => {
  const mu = getMean(data);
  const diffSq = data.map((x) => Math.pow(x - mu, 2));
  return Math.sqrt(getMean(diffSq));
};
const getRSI = (closes, periods = 14) => {
  if (closes.length < periods + 1) return 50;
  let gains = 0,
    losses = 0;
  for (let i = closes.length - periods; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    diff >= 0 ? (gains += diff) : (losses -= diff);
  }
  return losses === 0 ? 100 : 100 - 100 / (1 + gains / losses);
};
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

async function runAnalysis() {
  let symbol, entryPrice;

  if (paramTicker) {
    symbol = paramTicker;
    entryPrice = paramEntry;
  } else {
    console.clear();
    console.log(
      colors.bgCyan.black.bold(" TRADER.X | INDIVIDUAL COIN DEEP-DIVE "),
    );
    symbol = (await question("\nEnter Ticker (e.g., BTC, SOL): "))
      .toUpperCase()
      .replace("USDT", "");
    const entryInput = await question("Enter Entry Price (Optional): ");
    entryPrice = entryInput ? parseFloat(entryInput) : null;
  }

  const ticker = `${symbol}USDT`;

  try {
    // 250 limit for 4h SMA 200
    const { data: klines } = await axios.get(`${BINANCE_BASE}/klines`, {
      params: { symbol: ticker, interval: "4h", limit: 250 },
    });

    const closes = klines.map((c) => +c[4]);
    const volumes = klines.map((c) => +c[5]);
    const candles = klines.map((c) => ({ h: +c[2], l: +c[3], c: +c[4] }));
    const current = closes[closes.length - 1];

    // V9 QUANT METRICS
    const rsi = getRSI(closes);
    const sma200 = getMean(closes.slice(-200));
    const isBullish = current > sma200;
    const lookback = closes.slice(-20);
    const sma20 = getMean(lookback);
    const sd = getStdDev(lookback);
    const zScore = (current - sma20) / sd;
    const atr = calculateATR(candles, 20);
    const squeeze = calculateATR(candles, 5) / calculateATR(candles, 25);
    const volRelative =
      volumes[volumes.length - 1] / getMean(volumes.slice(-20));

    // SCORING & GRADING
    let finalScore = 0;
    if (squeeze < 0.7 && volRelative > 1.3 && isBullish && rsi < 65)
      finalScore += 80;
    else if (zScore < -2.2 && rsi < 30) finalScore += 70;
    else if (isBullish && zScore > 0.5) finalScore += 40;
    else finalScore += 10;

    if (volRelative > 2.0) finalScore += 15;
    if (squeeze < 0.6) finalScore += 10;
    if (rsi < 20 || rsi > 80) finalScore -= 20;

    let grade = "F";
    if (finalScore >= 90) grade = colors.bgGreen.bold.black(" A+ ");
    else if (finalScore >= 80) grade = colors.green.bold(" A ");
    else if (finalScore >= 70) grade = colors.yellow.bold(" B ");
    else if (finalScore >= 50) grade = colors.white(" C ");
    else grade = colors.dim(" D ");

    // TABLE OUTPUT
    const table = new Table({
      head: [colors.cyan("QUANT METRIC"), colors.cyan("VALUE / STATUS")],
    });

    table.push(
      ["Ticker / Grade", `${colors.bold(symbol)} | ${grade}`],
      ["Price (4H)", `$${current.toFixed(current < 1 ? 6 : 2)}`],
      [
        "Trend (SMA 200)",
        isBullish ? colors.green("BULLISH") : colors.red("BEARISH"),
      ],
      ["Z-Score / RSI", `${zScore.toFixed(1)}σ / ${rsi.toFixed(0)}`],
      ["Rel Volume (Fuel)", `${volRelative.toFixed(1)}x`],
      ["Squeeze (Coil)", `${squeeze.toFixed(2)}`],
      ["-----------------", "-----------------"],
    );

    if (entryPrice) {
      const profitPct = ((current - entryPrice) / entryPrice) * 100;
      table.push([
        "Entry / PNL",
        `$${entryPrice} / ${profitPct >= 0 ? colors.green(profitPct.toFixed(2) + "%") : colors.red(profitPct.toFixed(2) + "%")}`,
      ]);
    }

    table.push(
      [
        "Stop Loss (1.5 ATR)",
        colors.red(`$${(current - atr * 1.5).toFixed(current < 1 ? 6 : 2)}`),
      ],
      [
        "Take Profit (3 ATR)",
        colors.green(`$${(current + atr * 3).toFixed(current < 1 ? 6 : 2)}`),
      ],
    );

    console.clear();
    console.log(colors.bgBlack.white.bold(` DEEP-DIVE REPORT: ${symbol} `));
    console.log(table.toString());

    // ACTIONABLE NOTE
    if (finalScore >= 80) {
      console.log(
        colors.bgGreen.black(
          `\n HIGH CONVICTION: This asset meets V9 Alpha criteria for a ${finalScore >= 90 ? "Breakout" : "Solid Entry"}. `,
        ),
      );
    } else if (!isBullish) {
      console.log(
        colors.yellow(
          `\n ⚠️  CAUTION: Asset is below SMA 200. High risk for long positions. `,
        ),
      );
    }
  } catch (e) {
    console.log(colors.red(`\nError: Asset ${ticker} not found or API down.`));
  } finally {
    rl.close();
  }
}

runAnalysis();
