#!/bin/bash

# --- CONFIG ---
YEAR=$(date +%Y)
MONTH=$(date +%m-%B)
BASE_DIR="Trades/$YEAR/$MONTH"

# Colors for Termux
GREEN='\033[0;32m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

echo -e "${CYAN}--- SNIPER TRADE JOURNAL ---${NC}"
echo "1) Log a New Trade"
echo "2) View Current Month Summary"
echo "3) Search Historical Ledger"
read -p "> " OPTION

if [ "$OPTION" == "1" ]; then
    read -p "Coin (e.g., BTC): " COIN
    read -p "Result (Win/Loss): " RESULT
    read -p "PnL Amount (e.g., 5.50 or -2.00): " AMOUNT
    read -p "Reason (e.g., Z-Score/RSI Cross): " REASON

    # Deep File Structure for Organization
    DEEP_FOLDER="$BASE_DIR/${COIN^^}/${RESULT^}"
    mkdir -p "$DEEP_FOLDER"

    # CSV Summary for Fast Analysis
    CSV_FILE="$BASE_DIR/summary.csv"
    if [ ! -f "$CSV_FILE" ]; then
        echo "Date,Time,Coin,Result,PnL,Reason" > "$CSV_FILE"
    fi
    
    TIMESTAMP=$(date +%H:%M:%S)
    DATESTAMP=$(date +%Y-%m-%d)
    
    echo "$DATESTAMP,$TIMESTAMP,${COIN^^},${RESULT^},$AMOUNT,\"$REASON\"" >> "$CSV_FILE"

    echo -e "\n${GREEN}✅ Mission Logged.${NC}"
    echo "Reason Recorded: $REASON"

elif [ "$OPTION" == "2" ] || [ "$OPTION" == "3" ]; then
    if [ "$OPTION" == "2" ]; then
        TARGET_CSV="$BASE_DIR/summary.csv"
        HEADER="CURRENT MONTH: $MONTH"
    else
        read -p "Enter Year (2026): " S_YEAR
        read -p "Enter Month (e.g., 03-March): " S_MONTH
        TARGET_CSV="Trades/$S_YEAR/$S_MONTH/summary.csv"
        HEADER="HISTORICAL: $S_MONTH $S_YEAR"
    fi

    if [ ! -f "$TARGET_CSV" ]; then
        echo -e "${RED}❌ No ledger found.${NC}"
        exit 1
    fi
    
    echo -e "\n${CYAN}📊 --- $HEADER ---${NC}\n"
    column -s, -t "$TARGET_CSV"
    
    # Quant Math: Calculate Net PnL and Win Rate
    TOTAL=$(awk -F, 'NR>1 {sum+=$5} END {printf "%.2f", sum}' "$TARGET_CSV")
    WINS=$(grep -c "Win" "$TARGET_CSV" || true)
    LOSSES=$(grep -c "Loss" "$TARGET_CSV" || true)
    
    echo -e "\n-------------------------------------"
    echo -e "💰 NET PnL: ${GREEN}$TOTAL${NC}"
    echo -e "🏆 W/L Ratio: $WINS Wins / $LOSSES Losses"
    echo -e "-------------------------------------"

else
    echo "Invalid Option."
fi
