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

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

// Peak-to-trough decline of the compounded equity curve, as a positive
// percentage (0 if equity never dipped below a prior peak). Trades are
// assumed sequential/non-overlapping, same assumption compoundedPct above
// relies on, so walking them in order is a valid equity curve.
function maxDrawdownPct(trades) {
  let equity = 1;
  let peak = 1;
  let maxDd = 0;
  for (const t of trades) {
    equity *= 1 + t.netPct / 100;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, (peak - equity) / peak);
  }
  return maxDd * 100;
}

// CAGR / max drawdown -- the standard risk-adjusted-return read: how much
// compounded growth per unit of the worst peak-to-trough pain along the way.
// Undefined (null) rather than +Infinity when there's no drawdown to divide
// by (a strategy with zero losing stretches, or too few trades to have one),
// since "infinitely good" isn't a meaningful number to sort or display.
// Also null when the trade span is too short to annualize sensibly (under a
// day) -- CAGR blows up on a tiny time base the same way it would on a real
// short-lived track record.
function calmarRatio(trades, compoundedPct, maxDd) {
  if (trades.length === 0 || maxDd === 0) return null;
  const spanMs = new Date(trades.at(-1).exitTime) - new Date(trades[0].entryTime);
  const years = spanMs / MS_PER_YEAR;
  if (years < 1 / 365.25) return null;
  const cagr = (Math.pow(1 + compoundedPct / 100, 1 / years) - 1) * 100;
  return cagr / maxDd;
}

// Summary stats for a list of closed strategy trades ({ netPct, barsHeld,
// outcome, entryTime, exitTime }, as produced by strategyWorker.js). Trades
// are assumed sequential and non-overlapping (a flip-style engine is never
// in more than one position at once), so a compounded return/equity curve
// is well-defined.
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
  const maxDd = maxDrawdownPct(trades);
  const calmar = calmarRatio(trades, compoundedPct, maxDd);

  return {
    n,
    wins: wins.length,
    losses: losses.length,
    winRate,
    ci: [ciLow, ciHigh],
    avgWinPct,
    avgLossPct,
    expectancyPct,
    avgBarsHeld,
    compoundedPct,
    maxDrawdownPct: maxDd,
    calmarRatio: calmar,
  };
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
