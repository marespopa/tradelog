// Parses the text of a pasted OKX order ticket ("Price / Amount / Type /
// TP trigger price / SL trigger price" plus their values) into the fields
// the Add Trade form needs. Deliberately doesn't rely on line breaks between
// a label and its value — copying from OKX's rendered order ticket (as
// opposed to plain text) often collapses everything onto one line or joins
// them with a plain space instead of a newline. Best-effort: any field it
// can't find is left null so the caller can fall back to whatever the user
// already typed.

// "Price" alone means entry price, but the same word also shows up inside
// "TP trigger price" / "TP order price" / "SL trigger price" / "SL order
// price" — excluded here so the bare label match doesn't grab one of those.
const ENTRY_PRICE_LABEL = /(?<!trigger )(?<!order )\bprice\b/i;
const SL_TRIGGER_LABEL = /\bSL trigger price\b/i;
const TP_TRIGGER_LABEL = /\bTP trigger price\b/i;
const AMOUNT_LABEL = /\bAmount\b/i;

function numberAfter(text, labelRegex) {
  const match = labelRegex.exec(text);
  if (!match) return null;
  const rest = text.slice(match.index + match[0].length);
  const numberMatch = rest.match(/-?[\d,]+\.?\d*/);
  return numberMatch ? parseFloat(numberMatch[0].replace(/,/g, "")) : null;
}

function amountAndSymbol(text) {
  const match = AMOUNT_LABEL.exec(text);
  if (!match) return { amount: null, symbol: null };
  const rest = text.slice(match.index + match[0].length);
  const valueMatch = rest.match(/([\d,]+\.?\d*)\s*([A-Za-z]{2,6})(?![A-Za-z])/);
  if (!valueMatch) return { amount: null, symbol: null };
  return { amount: parseFloat(valueMatch[1].replace(/,/g, "")), symbol: valueMatch[2].toUpperCase() };
}

// TP above entry + SL below it (or vice versa) tells us the direction —
// OKX's ticket itself doesn't label long/short explicitly.
function inferSide(entryPrice, stopLoss, targetPrice) {
  if (entryPrice == null) return null;
  if (targetPrice != null) return targetPrice > entryPrice ? "long" : targetPrice < entryPrice ? "short" : null;
  if (stopLoss != null) return stopLoss < entryPrice ? "long" : stopLoss > entryPrice ? "short" : null;
  return null;
}

export function parseOkxOrder(text) {
  if (!text?.trim()) return null;

  const entryPrice = numberAfter(text, ENTRY_PRICE_LABEL);
  const stopLoss = numberAfter(text, SL_TRIGGER_LABEL);
  const targetPrice = numberAfter(text, TP_TRIGGER_LABEL);
  const { symbol } = amountAndSymbol(text);
  const side = inferSide(entryPrice, stopLoss, targetPrice);

  if (entryPrice == null && stopLoss == null && targetPrice == null && !symbol) return null;

  return { symbol, side, entryPrice, stopLoss, targetPrice };
}
