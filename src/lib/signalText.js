// Parses the on-screen text of a strategy's "Check current signal" result
// (see StrategiesPanel's SignalResult, which renders
// "{SIDE} @ {price} · {date}, {time} · stop {stop} · target {target}") into
// the fields the trade form needs. The rendered line has no symbol — users
// copying it typically prefix one by hand (e.g. "BTC SHORT @ ..."), so the
// symbol is optional here. The date has no year either, since the signal is
// always a recent bar; the year is inferred from today's date.
const SIGNAL_LINE_RE =
  /(?:([A-Za-z][A-Za-z0-9]{1,9})\s+)?(LONG|SHORT|CLOSE)\s*@\s*\$?([\d,]+\.?\d*)\s*·\s*([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{1,2}):(\d{2})(?:\s*·\s*stop\s*\$?([\d,]+\.?\d*)\s*·\s*target\s*\$?([\d,]+\.?\d*))?/i;

// Kraken's own order-fill wording, e.g. "Buy 0.23694451 ETH @ Limit 1,861.99
// USDC" (also matches "Sell ... @ Market ..."). No stop/target/time in this
// shape -- Kraken tickets don't carry them -- so those fields are left null
// and the form keeps whatever it already had for them.
const KRAKEN_TICKET_RE = /^\s*(Buy|Sell)\s+[\d,]+\.?\d*\s+([A-Za-z][A-Za-z0-9]{1,9})\s+@\s+(?:Limit|Market)\s+\$?([\d,]+\.?\d*)/i;

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

function num(s) {
  return s == null ? null : parseFloat(s.replace(/,/g, ""));
}

// Builds the entry time from month/day/hour/minute using the current year,
// rolling back a year if that would land in the future (e.g. pasting a
// December signal in January).
function inferEntryTime(monthName, day, hour, minute) {
  const monthIndex = MONTHS[monthName.slice(0, 3).toLowerCase()];
  if (monthIndex == null) return null;
  const now = new Date();
  let d = new Date(now.getFullYear(), monthIndex, Number(day), Number(hour), Number(minute));
  if (d.getTime() - now.getTime() > 24 * 3600 * 1000) {
    d = new Date(now.getFullYear() - 1, monthIndex, Number(day), Number(hour), Number(minute));
  }
  return d;
}

export function parseSignalText(text) {
  if (!text?.trim()) return null;

  const match = SIGNAL_LINE_RE.exec(text);
  if (match) {
    const [, symbol, sideLabel, price, month, day, hour, minute, stop, target] = match;
    const sideLower = sideLabel.toLowerCase();
    const side = sideLower === "long" || sideLower === "short" ? sideLower : null;
    const entryTime = inferEntryTime(month, day, hour, minute);

    return {
      symbol: symbol ? symbol.toUpperCase() : null,
      side,
      entryPrice: num(price),
      stopLoss: num(stop),
      targetPrice: num(target),
      entryTime: entryTime && !isNaN(entryTime.getTime()) ? entryTime.toISOString() : null,
    };
  }

  const krakenMatch = KRAKEN_TICKET_RE.exec(text);
  if (krakenMatch) {
    const [, action, symbol, price] = krakenMatch;
    return {
      symbol: symbol.toUpperCase(),
      side: action.toLowerCase() === "buy" ? "long" : "short",
      entryPrice: num(price),
      stopLoss: null,
      targetPrice: null,
      entryTime: null,
    };
  }

  return null;
}
