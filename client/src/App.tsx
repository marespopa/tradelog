import React, { useState, useEffect, useMemo } from 'react';
import {
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar, Cell, LineChart, Line, ReferenceArea
} from 'recharts';

// --- Interfaces ---
interface BinanceKline {
  time: string;
  price: number;
  open: number;
  high: number;
  low: number;
  volume: number;
  isUp: boolean;
  rsi?: number;
}

interface SRZone {
  y1: number;
  y2: number;
  timestamp: string;
  type: 'SUPPORT' | 'RESISTANCE';
}

// --- Utilities ---
const formatPrice = (val: number | string | undefined): string => {
  if (val === undefined) return "0.00";
  const num = typeof val === 'string' ? parseFloat(val) : val;
  if (isNaN(num)) return "0.00";
  return num < 1
    ? num.toFixed(8)
    : num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const calculateRSI = (data: BinanceKline[], periods: number = 14) => {
  if (data.length < periods) return data;
  let res = [...data];
  for (let i = periods; i < data.length; i++) {
    let gains = 0, losses = 0;
    for (let j = i - periods + 1; j <= i; j++) {
      const diff = data[j].price - data[j - 1].price;
      if (diff >= 0) gains += diff;
      else losses -= diff;
    }
    const rs = (gains / periods) / (losses / periods || 1);
    res[i].rsi = 100 - (100 / (1 + rs));
  }
  return res;
};

const App: React.FC = () => {
  const [input, setInput] = useState("");
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [chartData, setChartData] = useState<BinanceKline[]>([]);
  const [loading, setLoading] = useState(false);
  const [isDark, setIsDark] = useState(true);

  // Constants for alignment
  const CHART_MARGIN = { top: 10, right: 0, left: 0, bottom: 0 };

  const theme = {
    bg: isDark ? 'bg-[#1a1a1a]' : 'bg-[#f4f4f4]',
    panel: isDark ? 'bg-[#222]' : 'bg-white',
    text: isDark ? 'text-[#e0e0e0]' : 'text-[#1a1a1a]',
    subtext: isDark ? 'text-[#666]' : 'text-[#999]',
    border: isDark ? 'border-[#333]' : 'border-[#e2e2e2]',
    grid: isDark ? '#2a2a2a' : '#ececec',
    support: '#00ffaa',
    resistance: '#ff4444',
    accent: '#007aff',
  };

  const srZones = useMemo<SRZone[]>(() => {
    if (chartData.length < 30) return [];
    const zones: SRZone[] = [];
    for (let i = 5; i < chartData.length - 10; i++) {
      const d = chartData[i];
      const body = Math.abs(d.price - d.open);
      const avgBody = chartData.slice(i - 5, i).reduce((a, b) => a + Math.abs(b.price - b.open), 0) / 5;
      const move = (chartData[i + 3].price - d.price) / d.price;
      if (body < avgBody) {
        if (move > 0.015) {
          zones.push({ y1: d.low * 0.998, y2: d.high * 1.001, timestamp: d.time, type: 'SUPPORT' });
        } else if (move < -0.015) {
          zones.push({ y1: d.low * 0.999, y2: d.high * 1.002, timestamp: d.time, type: 'RESISTANCE' });
        }
      }
    }
    return zones.slice(-6);
  }, [chartData]);

  const fetchData = async (target: string) => {
    const cmd = target.toUpperCase().trim();
    if (cmd === 'THEME') { setIsDark(!isDark); return; }
    setLoading(true);
    try {
      const formattedSymbol = cmd.endsWith('USDT') ? cmd : `${cmd}USDT`;
      const res = await fetch(`https://api.binance.com/api/v3/klines?symbol=${formattedSymbol}&interval=1h&limit=150`);
      const raw = await res.json();
      if (!Array.isArray(raw)) throw new Error("Invalid Ticker");
      const formatted: BinanceKline[] = raw.map((d: any[]) => ({
        time: new Date(d[0]).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }),
        open: parseFloat(d[1]),
        high: parseFloat(d[2]),
        low: parseFloat(d[3]),
        price: parseFloat(d[4]),
        volume: parseFloat(d[5]),
        isUp: parseFloat(d[4]) >= parseFloat(d[1]),
      }));
      setChartData(calculateRSI(formatted));
      setSymbol(formattedSymbol);
    } catch (e) { console.error("FETCH_ERROR", e); }
    finally { setLoading(false); }
  };

  useEffect(() => { fetchData(symbol); }, []);

  const latestData = chartData[chartData.length - 1];

  return (
    <div className={`h-screen ${theme.bg} ${theme.text} font-mono text-[11px] flex flex-col uppercase overflow-hidden transition-all duration-300`}>
      <div className={`p-4 border-b ${theme.border} ${theme.panel} flex items-center`}>
        <span className={`${theme.subtext} mr-4 font-bold tracking-widest`}>TRADE_ASSISTANT:</span>
        <input
          autoFocus
          className={`bg-transparent border-none outline-none ${theme.text} w-full placeholder:${theme.subtext} caret-[#007aff]`}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && (fetchData(input), setInput(""))}
          placeholder="TICKER OR 'THEME'..."
        />
        <div className={`ml-auto ${theme.subtext} text-[9px]`}>{loading ? "SEARCHING..." : "INDEXED"}</div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        <main className={`flex-[3] flex flex-col p-6 gap-6 border-r ${theme.border}`}>
          <div className="flex justify-between items-baseline border-b pb-4 border-transparent">
            <span className="font-bold text-sm tracking-[0.3em]">{symbol}</span>
            <span className="text-2xl font-light tracking-tighter">{formatPrice(latestData?.price)}</span>
          </div>

          <div className="flex-1 flex flex-col">
            {/* Price Chart */}
            <div className="flex-[4] relative">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={CHART_MARGIN} syncId="tradeSync">
                  <CartesianGrid stroke={theme.grid} vertical={false} strokeDasharray="1 5" />
                  <XAxis dataKey="time" hide />
                  <YAxis domain={['auto', 'auto']} orientation="right" width={50} tick={false} axisLine={false} />

                  {srZones.map((z, i) => (
                    <ReferenceArea
                      key={i}
                      y1={z.y1}
                      y2={z.y2}
                      fill={z.type === 'SUPPORT' ? theme.support : theme.resistance}
                      fillOpacity={0.1}
                      stroke="none"
                    />
                  ))}

                  <Tooltip
                    contentStyle={{ backgroundColor: isDark ? '#1a1a1a' : '#fff', border: `1px solid ${theme.grid}`, borderRadius: '2px' }}
                    itemStyle={{ color: theme.accent }}
                    formatter={(value) => [formatPrice(value as number | string), ""]}
                    cursor={{ stroke: theme.accent, strokeWidth: 0.5 }}
                  />
                  <Line type="monotone" dataKey="price" stroke={theme.accent} strokeWidth={1.2} dot={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* Volume Chart - Now Aligned */}
            <div className="flex-1 opacity-40 mt-2">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={CHART_MARGIN} syncId="tradeSync">
                  <XAxis dataKey="time" hide />
                  {/* Invisible YAxis with same width as Price Chart's YAxis ensures alignment */}
                  <YAxis orientation="right" width={50} hide />
                  <Bar dataKey="volume">
                    {chartData.map((entry, i) => (
                      <Cell key={`cell-${i}`} fill={entry.isUp ? theme.support : theme.resistance} opacity={0.5} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </main>

        <aside className={`w-72 flex flex-col p-6 ${theme.panel}`}>
          <div className={`border-b ${theme.border} mb-6 pb-2 font-bold tracking-[0.2em] ${theme.subtext}`}>SYSTEM_REPORT</div>
          <section className="mb-8 overflow-y-auto">
            <h3 className={`mb-4 text-[9px] font-bold ${theme.subtext}`}>S/R_ZONES</h3>
            {srZones.length > 0 ? srZones.map((z, i) => (
              <div key={i} className={`mb-3 p-3 border-l-2 ${z.type === 'SUPPORT' ? 'border-[#00ffaa]' : 'border-[#ff4444]'} ${isDark ? 'bg-[#1d1d1d]' : 'bg-[#fafafa]'}`}>
                <div className={`${theme.subtext} text-[8px] mb-1 flex justify-between`}>
                  <span>{z.timestamp} UTC</span>
                  <span className={z.type === 'SUPPORT' ? 'text-[#00ffaa]' : 'text-[#ff4444]'}>{z.type}</span>
                </div>
                <div className="font-bold">{formatPrice(z.y1)} — {formatPrice(z.y2)}</div>
              </div>
            )) : <div className={theme.subtext}>ANALYZING_LEVELS...</div>}
          </section>
          <section className="mt-auto">
            <div className="flex justify-between mb-2 text-[9px] tracking-widest">
              <span className={theme.subtext}>RSI_MOMENTUM</span>
              <span className="font-bold">{latestData?.rsi?.toFixed(2) || '0.00'}</span>
            </div>
            <div className={`w-full h-[2px] ${isDark ? 'bg-[#333]' : 'bg-[#e0e0e0]'} overflow-hidden`}>
              <div className="h-full bg-[#007aff] transition-all duration-700" style={{ width: `${latestData?.rsi || 0}%` }} />
            </div>
          </section>
        </aside>
      </div>
      <footer className={`p-4 border-t ${theme.border} ${theme.panel} flex justify-between text-[8px] ${theme.subtext} tracking-widest`}>
        <span>TRADE_ASSISTANT v0.0.3</span>
        <span className="opacity-50">SYNC: {new Date().toLocaleTimeString()}</span>
      </footer>
    </div>
  );
};

export default App;
