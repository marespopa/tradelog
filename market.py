import pandas as pd
import numpy as np
import requests
from typing import Optional, Dict
from rich.console import Console
from rich.table import Table
from rich.panel import Panel

class Config:
    # Liquidity is safety. Only scan the "blue chips" of crypto.
    TICKERS = ["BTC", "ETH", "SOL", "BNB", "AVAX", "LINK", "ADA", "DOT", "NEAR"]
    WINDOW = 20
    RSI_PERIOD = 14
    # Increased Thresholds: We only care about the 2.5 Sigma events (the true outliers)
    Z_THRESHOLD = 2.0
    RSI_LOW = 30  # Tightened from 35 to reduce "fake" signals
    RSI_HIGH = 70 # Tightened from 65 to reduce "fake" signals
    BASE_URL = "https://api.binance.com/api/v3/klines"

console = Console()

class QuantEngine:
    @staticmethod
    def calculate_rsi(series: pd.Series, period: int = 14) -> pd.Series:
        delta = series.diff()
        gain = (delta.where(delta > 0, 0)).rolling(window=period).mean()
        loss = (-delta.where(delta < 0, 0)).rolling(window=period).mean()
        rs = gain / loss.replace(0, np.nan)
        return 100 - (100 / (1 + rs))

    def analyze(self, symbol: str) -> Optional[Dict]:
        try:
            res = requests.get(f"{Config.BASE_URL}?symbol={symbol}USDT&interval=4h&limit=100", timeout=5)
            res.raise_for_status()
            df = pd.DataFrame(res.json(), columns=['ts','o','h','l','c','v','ct','q','n','tb','tq','i'])
            df['c'] = pd.to_numeric(df['c'])
            
            # Math: Measuring the "Stretch" from the Mean
            df['ma'] = df['c'].rolling(Config.WINDOW).mean()
            df['std'] = df['c'].rolling(Config.WINDOW).std()
            df['z'] = (df['c'] - df['ma']) / df['std']
            df['rsi'] = self.calculate_rsi(df['c'], Config.RSI_PERIOD)
            
            last = df.iloc[-1]
            z, rsi = last['z'], last['rsi']
            
            # THE HARD FILTER: If both conditions aren't met, the trade doesn't exist.
            if z < -Config.Z_THRESHOLD and rsi < Config.RSI_LOW:
                return {"symbol": symbol, "price": last['c'], "z": z, "rsi": rsi, "sig": "STRONG BUY", "col": "bold green"}
            elif z > Config.Z_THRESHOLD and rsi > Config.RSI_HIGH:
                return {"symbol": symbol, "price": last['c'], "z": z, "rsi": rsi, "sig": "STRONG SELL", "col": "bold red"}
            
            return None 
        except Exception:
            return None

def run_scanner():
    engine = QuantEngine()
    results_table = Table(title="The Responsible Trader's Scanner (4H)", header_style="bold magenta", border_style="blue")
    results_table.add_column("Ticker", style="cyan")
    results_table.add_column("Price", justify="right")
    results_table.add_column("Z-Score", justify="right")
    results_table.add_column("RSI", justify="right")
    results_table.add_column("Action", justify="center")

    found_signals = 0
    with console.status("[bold yellow]Filtering for high-probability setups...") as status:
        for ticker in Config.TICKERS:
            data = engine.analyze(ticker)
            if data:
                found_signals += 1
                results_table.add_row(
                    data['symbol'], f"${data['price']:,.2f}", f"{data['z']:.2f}σ", 
                    f"{data['rsi']:.1f}", f"[{data['col']}]{data['sig']}[/]"
                )
    
    # 1. THE DATA OUTPUT
    if found_signals > 0:
        console.print(results_table)
    else:
        console.print(Panel("[bold yellow]THE MARKET IS QUIET.[/]\nNo statistical outliers detected. Trading now is just gambling.\n[dim]Close the terminal and wait for a 4H candle close.[/]", border_style="white"))
    
    # 2. THE TEN COMMANDMENTS OF RESPONSIBLE TRADING
    commandments = (
        "[bold gold1]I. Thou Shalt Not Trade Out of Boredom.[/bold gold1] (Patience pays, action costs.)\n"
        "[bold gold1]II. Thou Shalt Honor the 4-Hour Timeframe.[/bold gold1] (Ignore the noise of the minutes.)\n"
        "[bold gold1]III. Thou Shalt Not Chasten a Falling Knife.[/bold gold1] (Wait for Z-Score AND RSI to align.)\n"
        "[bold gold1]IV. Thou Shalt Accept Small Losses Gladly.[/bold gold1] (A 5% stop protects the whole.)\n"
        "[bold gold1]V. Thou Shalt Not Covet Thy Neighbor's '100x' Gains.[/bold gold1] (Follow the math, not the hype.)\n"
        "[bold gold1]VI. Thou Shalt Exit at the Mean.[/bold gold1] (Sell when Z=0. Don't get greedy.)\n"
        "[bold gold1]VII. Thou Shalt Keep Thy Capital in Slots.[/bold gold1] (Never risk the whole on one coin.)\n"
        "[bold gold1]VIII. Thou Shalt Not Stare at the Ticker.[/bold gold1] (Over-monitoring leads to over-trading.)\n"
        "[bold gold1]IX. Thou Shalt Trade the System, Not the Feeling.[/bold gold1] (If the script is empty, thou art empty.)\n"
        "[bold gold1]X. Thou Shalt Be a Sniper, Not a Machine Gunner.[/bold gold1] (Wait for the perfect shot.)"
    )
    
    console.print(Panel(commandments, title="[bold white]THE TEN COMMANDMENTS OF TRADING[/bold white]", border_style="yellow", padding=(1, 2)))

if __name__ == "__main__":
    run_scanner()
