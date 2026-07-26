import { useCallback, useEffect, useState } from "react";
import { useTheme } from "./hooks/useTheme.js";
import { useWatchlist } from "./hooks/useWatchlist.js";
import { useTrades } from "./hooks/useTrades.js";
import CoinAnalysis from "./components/CoinAnalysis.jsx";
import ScanPanel from "./components/ScanPanel.jsx";
import MarketPanel from "./components/MarketPanel.jsx";
import WatchlistPanel from "./components/WatchlistPanel.jsx";
import TradesPanel from "./components/TradesPanel.jsx";
import LongTermPanel from "./components/LongTermPanel.jsx";

// Scan the top-volume market for position-trading candidates, then act on
// what you find. Analysis (chart/stats/sizing) isn't a nav tab — it's a
// drill-down reached by clicking a row from any of the scan-like tabs.
const TABS = new Set(["scan", "market", "watchlist", "trades", "longterm", "analysis"]);
const NAV_TABS = [
  { key: "scan", label: "Scan" },
  { key: "market", label: "Market" },
  { key: "watchlist", label: "Watchlist" },
  { key: "trades", label: "Trades" },
  { key: "longterm", label: "Long-term" },
];

function readUrlState() {
  const params = new URLSearchParams(window.location.search);
  const tab = params.get("tab");
  return { tab: TABS.has(tab) ? tab : "scan", coin: params.get("coin") || null };
}

export default function App() {
  const { preference, cycle } = useTheme();
  const watchlist = useWatchlist();
  const trades = useTrades();
  const [{ tab, coin }, setUrlState] = useState(readUrlState);
  // Which nav tab to return to from analysis — set whenever a row is
  // clicked from scan or watchlist, so "Back" lands wherever you came from.
  const [returnTab, setReturnTab] = useState("scan");

  useEffect(() => {
    const onPopState = () => setUrlState(readUrlState());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = useCallback((next) => {
    setUrlState((s) => {
      const merged = { ...s, ...next };
      const params = new URLSearchParams();
      params.set("tab", merged.tab);
      if (merged.coin) params.set("coin", merged.coin);
      window.history.pushState(null, "", `${window.location.pathname}?${params}`);
      return merged;
    });
  }, []);

  const goToTab = useCallback((next) => navigate({ tab: next, coin: null }), [navigate]);

  const selectCoin = useCallback(
    (symbol, from) => {
      setReturnTab(from);
      navigate({ tab: "analysis", coin: symbol });
    },
    [navigate]
  );

  const goBack = useCallback(() => navigate({ tab: returnTab, coin: null }), [navigate, returnTab]);

  return (
    <div className="min-h-full bg-bg text-ink transition-colors duration-200">
      <header className="sticky top-0 z-10 flex items-center gap-4 border-b border-edge bg-bg/80 px-7 py-[18px] backdrop-blur-xl backdrop-saturate-150">
        <h1 className="m-0 text-[17px] font-semibold tracking-tight">Market Scanner</h1>

        <nav className="flex gap-1 rounded-lg bg-panel-alt p-1">
          {NAV_TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => goToTab(t.key)}
              className={`relative rounded-md px-3 py-1 text-[12px] font-medium transition-all duration-150 ${
                (tab === t.key || (tab === "analysis" && returnTab === t.key)) ? "bg-panel-raised text-ink shadow-sm" : "text-dim hover:text-ink"
              }`}
            >
              {t.label}
              {t.key === "watchlist" && watchlist.symbols.length > 0 && (
                <span className="absolute -right-1 -top-1 flex h-3.5 min-w-[14px] items-center justify-center rounded-full bg-blue-500 px-0.5 text-[9px] font-semibold leading-none text-white">
                  {watchlist.symbols.length}
                </span>
              )}
            </button>
          ))}
        </nav>

        <div className="flex flex-1 items-center justify-end">
          <button
            type="button"
            onClick={cycle}
            aria-label={`Theme: ${preference} (click to switch)`}
            title={`Theme: ${preference} — click to switch`}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-panel-alt text-[14px] transition-all duration-200 hover:rotate-12 hover:bg-panel-raised active:scale-90"
          >
            {preference === "system" ? "🖥️" : preference === "dark" ? "🌙" : "☀️"}
          </button>
        </div>
      </header>

      <main key={tab} className="animate-fade-in mx-auto flex max-w-[1400px] flex-col gap-5 px-7 py-6">
        {tab === "scan" && <ScanPanel onSelectSymbol={(symbol) => selectCoin(symbol, "scan")} watchlist={watchlist} />}

        {tab === "market" && <MarketPanel onSelectSymbol={(symbol) => selectCoin(symbol, "market")} watchlist={watchlist} />}

        {tab === "watchlist" && (
          <WatchlistPanel watchlist={watchlist} onSelectSymbol={(symbol) => selectCoin(symbol, "watchlist")} />
        )}

        {tab === "trades" && <TradesPanel trades={trades} />}

        {tab === "longterm" && (
          <LongTermPanel onSelectSymbol={(symbol) => selectCoin(symbol, "longterm")} watchlist={watchlist} />
        )}

        {tab === "analysis" && (
          <>
            <button type="button" onClick={goBack} className="self-start text-[13px] text-dim hover:text-ink">
              ← Back to {NAV_TABS.find((t) => t.key === returnTab)?.label.toLowerCase() ?? "scan"}
            </button>
            <CoinAnalysis symbol={coin} onSymbolChange={(symbol) => navigate({ coin: symbol })} watchlist={watchlist} />
          </>
        )}
      </main>
    </div>
  );
}
