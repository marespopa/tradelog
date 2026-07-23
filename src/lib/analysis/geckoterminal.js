// Fallback market data for tokens OKX's spot market doesn't list (most small
// Arbitrum tokens aren't on a centralized exchange at all). GeckoTerminal
// indexes on-chain DEX pools directly — free, no API key, CORS-open — so it
// covers anything actually swappable on Arbitrum via MetaMask.
const TIMEFRAME_PARAMS = {
  "15m": { unit: "minute", aggregate: 15 },
  "1h": { unit: "hour", aggregate: 1 },
  "4h": { unit: "hour", aggregate: 4 },
  "1d": { unit: "day", aggregate: 1 },
  "1w": { unit: "day", aggregate: 7 },
};

const NETWORK = "arbitrum";

async function findBestPool(symbol) {
  const url = `https://api.geckoterminal.com/api/v2/search/pools?query=${encodeURIComponent(symbol)}&network=${NETWORK}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GeckoTerminal search failed: ${res.status}`);
  const json = await res.json();

  const pools = (json.data || []).filter((p) => {
    const [base] = p.attributes.name.split(" / ");
    return base?.toUpperCase() === symbol.toUpperCase();
  });
  if (!pools.length) throw new Error(`No Arbitrum pool found for ${symbol}`);

  // Most liquid pool is the least noisy price source for a given token.
  pools.sort((a, b) => Number(b.attributes.reserve_in_usd) - Number(a.attributes.reserve_in_usd));
  return pools[0].attributes.address;
}

export async function fetchCandlesGeckoTerminal(symbol, timeframe, limit = 300) {
  const params = TIMEFRAME_PARAMS[timeframe];
  if (!params) throw new Error(`Unsupported timeframe: ${timeframe}`);

  const poolAddress = await findBestPool(symbol);
  const url =
    `https://api.geckoterminal.com/api/v2/networks/${NETWORK}/pools/${poolAddress}/ohlcv/${params.unit}` +
    `?aggregate=${params.aggregate}&limit=${limit}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`GeckoTerminal candles failed: ${res.status}`);
  const json = await res.json();
  const list = json.data?.attributes?.ohlcv_list;
  if (!list?.length) throw new Error(`No candle data for ${symbol} on GeckoTerminal`);

  // GeckoTerminal returns newest-first: [ts (seconds), open, high, low, close, volume]
  return list
    .slice()
    .reverse()
    .map(([ts, open, high, low, close, volume]) => ({
      time: Number(ts) * 1000,
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: Number(close),
      volume: Number(volume),
    }));
}
