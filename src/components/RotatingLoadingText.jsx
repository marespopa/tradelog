import { useEffect, useState } from "react";

const DEFAULT_MESSAGES = ["Scanning the market…", "Getting real data…", "Crunching the numbers…", "Almost there…"];

// Cycles through `messages` on an interval while mounted. Swapped in for a
// single static loading string in the Market/Watchlist scans -- a 100-symbol
// scan runs for tens of seconds (Kraken's public API has no single
// all-tickers-at-once endpoint the way OKX's did, so it's batched/paced
// across many requests), and a screen that looks identical the whole time
// reads as stuck even when it's actively working.
export default function RotatingLoadingText({ messages = DEFAULT_MESSAGES, intervalMs = 1800 }) {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    setIndex(0);
    const id = setInterval(() => setIndex((i) => (i + 1) % messages.length), intervalMs);
    return () => clearInterval(id);
  }, [messages, intervalMs]);

  return messages[index];
}
