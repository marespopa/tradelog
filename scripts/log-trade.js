// Trade journal logger for the 4H swing style this app scans for. Fields are
// limited to what's objectively computable from market data at entry time —
// no emotional-state/discipline prompts, since those aren't data this script
// can produce; fill those in by hand in the CSV if you want them.
//
// Usage: node scripts/log-trade.js SYMBOL [long|short] [notes...]
// Direction is optional — if omitted it's inferred from the z-score
// threshold (long if z <= -2, short if z >= +2), same convention as the
// scanner's Z-score column.
import { fetchCandles } from "../src/lib/analysis/okx.js";
import { analyzeCandles, zScore, rollingMean, rollingStd, rsi, atr } from "../src/lib/analysis/ta.js";
import { existsSync, appendFileSync, writeFileSync } from "node:fs";

const JOURNAL_PATH = "journal.csv";
const HEADER = "timestamp,symbol,timeframe,price,zScore,rollingMean20,rollingStd20,rsi14,trend,atrPct,direction,notes";

function csvField(value) {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main() {
  const [, , symbolArg, directionArg, ...notesParts] = process.argv;
  if (!symbolArg) {
    console.error("Usage: node scripts/log-trade.js SYMBOL [long|short] [notes...]");
    process.exit(1);
  }
  const symbol = symbolArg.toUpperCase();

  const candles = await fetchCandles(symbol, "4h", 220);
  const closes = candles.map((c) => c.close);
  const price = closes.at(-1);

  const z = zScore(closes, 20);
  const mean20 = rollingMean(closes, 20);
  const std20 = rollingStd(closes, 20);
  const rsi14 = rsi(closes, 14).at(-1);
  const atrVal = atr(candles, 14);
  const atrPct = atrVal != null ? (atrVal / price) * 100 : null;
  const trend = analyzeCandles(candles, symbol).trend;

  let direction = directionArg && ["long", "short"].includes(directionArg.toLowerCase()) ? directionArg.toLowerCase() : null;
  const notes = direction ? notesParts.join(" ") : [directionArg, ...notesParts].filter(Boolean).join(" ");
  if (!direction) {
    direction = z != null && z <= -2 ? "long" : z != null && z >= 2 ? "short" : "none";
  }

  const row = {
    timestamp: new Date().toISOString(),
    symbol,
    timeframe: "4h",
    price,
    zScore: z,
    rollingMean20: mean20,
    rollingStd20: std20,
    rsi14,
    trend,
    atrPct,
    direction,
    notes,
  };

  if (!existsSync(JOURNAL_PATH)) writeFileSync(JOURNAL_PATH, HEADER + "\n");
  appendFileSync(JOURNAL_PATH, Object.values(row).map(csvField).join(",") + "\n");

  console.log(`Logged to ${JOURNAL_PATH}:`);
  for (const [k, v] of Object.entries(row)) console.log(`  ${k}: ${v}`);
  if (direction === "none") console.log("\nNote: |z| < 2 right now — no entry signal by the threshold in your framework.");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
