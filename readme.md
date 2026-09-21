# TradeRadar Pro MAX

**نظام إشارات تداول آلية يعمل 24/7 مع تنبيهات تلغرام فورية**
**24/7 automated trading signal system with instant Telegram alerts**

📊 Instruments: **XAUUSD · NAS100 · EURUSD**
🧠 100% automatic technical analysis (EMA · RSI · MACD · Bollinger · ATR · Stochastic · Candles · Structure)
📱 Telegram alerts + live trade tracking (TP1/TP2/TP3/SL)
🌐 Web dashboard (Arabic RTL)
☁️ Free forever — Oracle Cloud Always Free tier
🔑 No API keys required

---

## ⚠️ إخلاء المسؤولية

**هذا النظام لأغراض تعليمية وتحليلية فقط. لا يُعد نصيحة استثمارية.**
**التداول ينطوي على مخاطر عالية وقد تخسر رأس مالك بالكامل. اختبره على حساب تجريبي لمدة 30 يوماً على الأقل قبل استخدام أي مال حقيقي.**

**This system is for educational and analytical purposes only. Not financial advice. Trading involves substantial risk of loss. Test on a demo account for at least 30 days before risking real money.**

---

## 🚀 Quick Start (5 Steps)

```bash
# 1) Clone / create the folder
mkdir traderadar && cd traderadar

# 2) Put the 4 files here: index.html, bot.js, package.json, README.md

# 3) Create .env
cat > .env << 'EOF'
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
TELEGRAM_CHAT_ID=987654321
ACCOUNT_BALANCE=10000
RISK_PER_TRADE=1
MIN_SCORE=55
DEFAULT_TIMEFRAME=15min
ALERT_SOUND=true
DAILY_SUMMARY_HOUR=22
PORT=3001
EOF

# 4) Install dependencies
npm install

# 5) Run
node bot.js
