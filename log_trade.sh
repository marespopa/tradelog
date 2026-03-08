#!/bin/bash

YEAR=$(date +%Y)
MONTH=$(date +%m-%B)
MONTH_DIR="Trades/$YEAR/$MONTH"

echo "TRADE JOURNAL"
echo "1) Log a Trade (Current Month)"
echo "2) View PnL (Current Month)"
echo "3) Filter by Specific Month"
read -p "> " OPTION

if [ "$OPTION" == "1" ]; then
    read -p "Coin (e.g., BTC): " COIN
    read -p "Session (Asia/London/NY): " SESSION
    read -p "Result (Win/Loss): " RESULT
    read -p "Profit/Loss Amount (e.g., 150 or -50): " AMOUNT

    DEEP_FOLDER="$MONTH_DIR/${COIN^^}/${SESSION^}/${RESULT^}"
    mkdir -p "$DEEP_FOLDER"

    FILE_NAME="$DEEP_FOLDER/trade_$(date +%H%M%S).txt"
    echo -e "Date: $(date +%Y-%m-%d)\nTime: $(date +%H:%M:%S)\nCoin: ${COIN^^}\nSession: ${SESSION^}\nResult: ${RESULT^}\nPnL: $AMOUNT" > "$FILE_NAME"

    CSV_FILE="$MONTH_DIR/summary.csv"
    if [ ! -f "$CSV_FILE" ]; then
        echo "Date,Time,Coin,Session,Result,PnL" > "$CSV_FILE"
    fi
    echo "$(date +%Y-%m-%d),$(date +%H:%M:%S),${COIN^^},${SESSION^},${RESULT^},$AMOUNT" >> "$CSV_FILE"

    echo -e "\n✅ Trade logged."
    echo "📂 CSV Updated: $CSV_FILE"

elif [ "$OPTION" == "2" ]; then
    CSV_FILE="$MONTH_DIR/summary.csv"
    if [ ! -f "$CSV_FILE" ]; then
        echo "❌ No trades found for $MONTH."
        exit 1
    fi
    
    echo -e "\n📊 --- $MONTH TRADING REPORT ---\n"
    column -s, -t "$CSV_FILE"
    TOTAL=$(awk -F, 'NR>1 {sum+=$6} END {printf "%.2f", sum}' "$CSV_FILE")
    echo -e "\n-------------------------------------"
    echo "💰 NET PnL FOR $MONTH: $TOTAL"

elif [ "$OPTION" == "3" ]; then
    echo -e "\n🔍 SEARCH HISTORICAL DATA"
    read -p "Enter Year (e.g., 2026): " SEARCH_YEAR
    read -p "Enter Month (e.g., 03-March): " SEARCH_MONTH
    
    SEARCH_CSV="Trades/$SEARCH_YEAR/$SEARCH_MONTH/summary.csv"
    
    if [ ! -f "$SEARCH_CSV" ]; then
        echo "❌ No ledger found at $SEARCH_CSV."
        exit 1
    fi
    
    echo -e "\n📊 --- $SEARCH_MONTH $SEARCH_YEAR TRADING REPORT ---\n"
    column -s, -t "$SEARCH_CSV"
    TOTAL=$(awk -F, 'NR>1 {sum+=$6} END {printf "%.2f", sum}' "$SEARCH_CSV")
    echo -e "\n-------------------------------------"
    echo "💰 NET PnL FOR $SEARCH_MONTH: $TOTAL"

else
    echo "Invalid option."
fi
