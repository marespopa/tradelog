// Wilson score interval — better-behaved than a normal approximation at the
// small sample sizes a single-strategy backtest realistically produces.
// Same formula the node backtest scripts (e.g. backtest-neckline.js) use.
function wilsonInterval(wins, n, z = 1.96) {
  if (n === 0) return [0, 0];
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(center - margin) / denom, (center + margin) / denom];
}

// Summary stats for a list of closed strategy trades ({ netPct, barsHeld,
// outcome }, as produced by strategyWorker.js). Trades are assumed
// sequential and non-overlapping (a flip-style engine is never in more than
// one position at once), so a compounded return is well-defined.
export function summarizeTrades(trades) {
  const n = trades.length;
  const wins = trades.filter((t) => t.outcome === "win");
  const losses = trades.filter((t) => t.outcome === "loss");
  const winRate = n ? wins.length / n : 0;
  const [ciLow, ciHigh] = wilsonInterval(wins.length, n);
  const avgWinPct = wins.length ? wins.reduce((s, t) => s + t.netPct, 0) / wins.length : 0;
  const avgLossPct = losses.length ? losses.reduce((s, t) => s + t.netPct, 0) / losses.length : 0;
  const expectancyPct = n ? trades.reduce((s, t) => s + t.netPct, 0) / n : 0;
  const avgBarsHeld = n ? trades.reduce((s, t) => s + t.barsHeld, 0) / n : 0;
  const compoundedPct = (trades.reduce((equity, t) => equity * (1 + t.netPct / 100), 1) - 1) * 100;

  return { n, wins: wins.length, losses: losses.length, winRate, ci: [ciLow, ciHigh], avgWinPct, avgLossPct, expectancyPct, avgBarsHeld, compoundedPct };
}

// Buy-and-hold return over the same candle window a strategy was tested on
// — the baseline every strategy backtest in this repo reports next to its
// own numbers, so "it made money" can be judged against "holding would have
// made more/less" instead of in isolation.
export function buyHoldPct(candles) {
  if (candles.length < 2) return null;
  const first = candles[0];
  const last = candles.at(-1);
  return ((last.close - first.close) / first.close) * 100;
}
