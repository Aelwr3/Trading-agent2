/* ============================================================================
   TradeRadar Pro MAX — bot.js
   24/7 Node.js backend. SignalR ticks + REST candles + Telegram alerts +
   JSON journal persistence + health server for the dashboard + scheduler.
   Modules: Config · Logger · Indicators · Strategy · DataFeed · Journal ·
            TelegramBot · Scheduler · HealthServer · App
   ========================================================================= */
'use strict';

require('dotenv').config();

const fs   = require('fs');
const path = require('path');
const http = require('http');

let signalR = null;
try { signalR = require('@microsoft/signalr'); }
catch (e) { console.error('🔴 @microsoft/signalr not installed. Run: npm install'); process.exit(1); }

let TelegramBotLib = null;
try { TelegramBotLib = require('node-telegram-bot-api'); }
catch (e) { console.warn('🟠 node-telegram-bot-api not installed — Telegram disabled.'); }

/* ---------------------------------------------------------------------------
   1) Config
   --------------------------------------------------------------------------- */
const Config = {
  BOT_TOKEN : (process.env.TELEGRAM_BOT_TOKEN || '').trim(),
  CHAT_ID   : (process.env.TELEGRAM_CHAT_ID || '').trim(),
  BALANCE   : parseFloat(process.env.ACCOUNT_BALANCE || '10000') || 10000,
  RISK_PCT  : parseFloat(process.env.RISK_PER_TRADE || '1') || 1,
  MIN_SCORE : parseInt(process.env.MIN_SCORE || '55', 10) || 55,
  TIMEFRAME : (process.env.DEFAULT_TIMEFRAME || '15min').trim(),
  ALERT_SOUND: String(process.env.ALERT_SOUND || 'true').toLowerCase() === 'true',
  SUMMARY_HOUR: parseInt(process.env.DAILY_SUMMARY_HOUR || '22', 10),
  PORT      : parseInt(process.env.PORT || '3001', 10),
  JOURNAL_FILE: path.join(__dirname, 'journal.json'),
  CACHE_FILE  : path.join(__dirname, 'candles-cache.json')
};

const TIMEFRAMES = {
  '1min': 60000, '5min': 300000, '15min': 900000,
  '30min': 1800000, '1h': 3600000, '4h': 14400000, '1d': 86400000
};

const INSTRUMENTS = [
  { id:'XAUUSD', ar:'الذهب',    candidates:['XAUUSD'],                 digits:2, pipSize:0.1,    valuePerUnit:100 },
  { id:'NAS100', ar:'ناسداك',   candidates:['NAS100','US100','NDX'],   digits:2, pipSize:1,      valuePerUnit:1 },
  { id:'EURUSD', ar:'يورو/دولار',candidates:['EURUSD'],                digits:5, pipSize:0.0001, valuePerUnit:100000 }
];

/* ---------------------------------------------------------------------------
   2) Logger
   --------------------------------------------------------------------------- */
const Log = {
  info : (...a) => console.log ('🔵', new Date().toISOString(), ...a),
  ok   : (...a) => console.log ('🟢', new Date().toISOString(), ...a),
  warn : (...a) => console.warn('🟠', new Date().toISOString(), ...a),
  err  : (...a) => console.error('🔴', new Date().toISOString(), ...a),
  tg   : (...a) => console.log ('📱', new Date().toISOString(), ...a)
};

/* ---------------------------------------------------------------------------
   3) UTIL
   --------------------------------------------------------------------------- */
const U = {
  isNum: v => typeof v === 'number' && Number.isFinite(v),
  num(v){ if(v===null||v===undefined||v==='') return null; const n=typeof v==='number'?v:parseFloat(v); return Number.isFinite(n)?n:null; },
  fmt(v,d){ const n=U.num(v); if(n===null) return '—'; return n.toLocaleString('en-US',{minimumFractionDigits:typeof d==='number'?d:2,maximumFractionDigits:typeof d==='number'?d:2}); },
  fmtSigned(v,d){ const n=U.num(v); if(n===null) return '—'; const s=U.fmt(Math.abs(n),d); return (n>0?'+':n<0?'−':'')+s; },
  last(a,b){ if(!Array.isArray(a)||!a.length) return null; const i=a.length-1-(b||0); if(i<0) return null; const v=a[i]; return (v!==null&&v!==undefined&&Number.isFinite(v))?v:null; },
  utcStr(){ const d=new Date(),p=n=>String(n).padStart(2,'0'); return d.getUTCFullYear()+'-'+p(d.getUTCMonth()+1)+'-'+p(d.getUTCDate())+' '+p(d.getUTCHours())+':'+p(d.getUTCMinutes())+' UTC'; },
  uid(){ return Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,8); },
  sleep: ms => new Promise(r=>setTimeout(r,ms))
};

/* ---------------------------------------------------------------------------
   4) Indicators  (identical math to index.html)
   --------------------------------------------------------------------------- */
const Indicators = {
  sma(v,p){ const n=v.length,o=new Array(n).fill(null); if(!n||p<=0) return o;
    const q=[]; let s=0,c=0;
    for(let i=0;i<n;i++){ const x=v[i]; q.push(x);
      if(x!==null&&x!==undefined&&Number.isFinite(x)){s+=x;c++;}
      if(q.length>p){ const y=q.shift(); if(y!==null&&y!==undefined&&Number.isFinite(y)){s-=y;c--;} }
      if(q.length===p&&c===p) o[i]=s/p; }
    return o; },

  ema(v,p){ const n=v.length,o=new Array(n).fill(null); if(!n||p<=0||n<p) return o;
    const k=2/(p+1); let s=0;
    for(let i=0;i<p;i++) s+=v[i];
    let prev=s/p; o[p-1]=prev;
    for(let i=p;i<n;i++){ prev=v[i]*k+prev*(1-k); o[i]=prev; }
    return o; },

  rsi(v,p){ p=p||14; const n=v.length,o=new Array(n).fill(null); if(n<=p) return o;
    let g=0,l=0;
    for(let i=1;i<=p;i++){ const d=v[i]-v[i-1]; if(d>=0) g+=d; else l-=d; }
    let ag=g/p, al=l/p;
    o[p]=al===0?100:100-100/(1+ag/al);
    for(let i=p+1;i<n;i++){ const d=v[i]-v[i-1], gg=d>0?d:0, ll=d<0?-d:0;
      ag=(ag*(p-1)+gg)/p; al=(al*(p-1)+ll)/p;
      o[i]=al===0?100:100-100/(1+ag/al); }
    return o; },

  macd(v,f,s,sg){ f=f||12;s=s||26;sg=sg||9;
    const n=v.length, ef=Indicators.ema(v,f), es=Indicators.ema(v,s);
    const ml=new Array(n).fill(null);
    for(let i=0;i<n;i++) if(ef[i]!==null&&es[i]!==null) ml[i]=ef[i]-es[i];
    let fi=-1; for(let i=0;i<n;i++) if(ml[i]!==null){fi=i;break;}
    const sl=new Array(n).fill(null), h=new Array(n).fill(null);
    if(fi>=0){ const valid=ml.slice(fi); const sv=Indicators.ema(valid,sg);
      for(let i=0;i<sv.length;i++) sl[fi+i]=sv[i];
      for(let i=0;i<n;i++) if(ml[i]!==null&&sl[i]!==null) h[i]=ml[i]-sl[i]; }
    return {macd:ml,signal:sl,hist:h};
  },

  bollinger(v,p,m){ p=p||20;m=m||2; const n=v.length;
    const up=new Array(n).fill(null), mid=new Array(n).fill(null), lo=new Array(n).fill(null), bw=new Array(n).fill(null);
    if(n<p) return {upper:up,middle:mid,lower:lo,bw:bw};
    let s=0,sq=0;
    for(let i=0;i<n;i++){ s+=v[i]; sq+=v[i]*v[i];
      if(i>=p){ s-=v[i-p]; sq-=v[i-p]*v[i-p]; }
      if(i>=p-1){ const mn=s/p, vv=Math.max(0,sq/p-mn*mn), sd=Math.sqrt(vv);
        mid[i]=mn; up[i]=mn+m*sd; lo[i]=mn-m*sd;
        bw[i]=mn!==0?(up[i]-lo[i])/Math.abs(mn):null; } }
    return {upper:up,middle:mid,lower:lo,bw:bw};
  },

  atr(bars,p){ p=p||14; const n=bars.length, o=new Array(n).fill(null); if(n<p+1) return o;
    const tr=new Array(n).fill(null);
    for(let i=0;i<n;i++){ const b=bars[i];
      if(i===0){ tr[i]=b.h-b.l; continue; }
      const pc=bars[i-1].c; tr[i]=Math.max(b.h-b.l,Math.abs(b.h-pc),Math.abs(b.l-pc)); }
    let s=0; for(let i=1;i<=p;i++) s+=tr[i];
    let prev=s/p; o[p]=prev;
    for(let i=p+1;i<n;i++){ prev=(prev*(p-1)+tr[i])/p; o[i]=prev; }
    return o; },

  stochastic(bars,kp,ks,dp){ kp=kp||14;ks=ks||3;dp=dp||3; const n=bars.length;
    const rk=new Array(n).fill(null);
    for(let i=kp-1;i<n;i++){ let hh=-Infinity,ll=Infinity;
      for(let j=i-kp+1;j<=i;j++){ if(bars[j].h>hh) hh=bars[j].h; if(bars[j].l<ll) ll=bars[j].l; }
      rk[i]=hh===ll?50:100*(bars[i].c-ll)/(hh-ll); }
    const k=Indicators.sma(rk,ks), d=Indicators.sma(k,dp);
    return {k:k,d:d}; },

  findPivots(bars,lb){ lb=lb||20; const hi=[],lo=[], n=bars.length;
    for(let i=lb;i<n-lb;i++){ let isH=true,isL=true;
      for(let j=i-lb;j<=i+lb;j++){ if(j===i) continue;
        if(bars[j].h>=bars[i].h) isH=false;
        if(bars[j].l<=bars[i].l) isL=false;
        if(!isH&&!isL) break; }
      if(isH) hi.push({i:i,price:bars[i].h,t:bars[i].t});
      if(isL) lo.push({i:i,price:bars[i].l,t:bars[i].t}); }
    return {highs:hi,lows:lo}; },

  keyLevels(pivots,price){ let sup=null,res=null;
    if(!U.isNum(price)) return {support:null,resistance:null};
    for(let i=pivots.lows.length-1;i>=0;i--){ if(pivots.lows[i].price<price){ sup=pivots.lows[i].price; break; } }
    for(let i=pivots.highs.length-1;i>=0;i--){ if(pivots.highs[i].price>price){ res=pivots.highs[i].price; break; } }
    if(sup===null&&pivots.lows.length) sup=pivots.lows[pivots.lows.length-1].price;
    if(res===null&&pivots.highs.length) res=pivots.highs[pivots.highs.length-1].price;
    return {support:sup,resistance:res}; },

  candlePatterns(bars){ const out=[], n=bars.length; if(n<3) return out;
    const c=bars[n-1], p=bars[n-2];
    const body=Math.abs(c.c-c.o), range=Math.max(c.h-c.l,1e-9);
    const uw=c.h-Math.max(c.o,c.c), lw=Math.min(c.o,c.c)-c.l;
    const pb=Math.abs(p.c-p.o);
    const bull=c.c>c.o, bear=c.c<c.o;
    if(bull&&p.c<p.o&&c.c>=p.o&&c.o<=p.c&&body>pb&&body>0) out.push({name:'Bullish Engulfing',dir:'BUY',strength:1});
    if(bear&&p.c>p.o&&c.o>=p.c&&c.c<=p.o&&body>pb&&body>0) out.push({name:'Bearish Engulfing',dir:'SELL',strength:1});
    if(lw>body*2&&uw<=body*0.9&&body/range<0.42&&lw/range>0.5) out.push({name:'Hammer',dir:'BUY',strength:.9});
    if(uw>body*2&&lw<=body*0.9&&body/range<0.42&&uw/range>0.5) out.push({name:'Shooting Star',dir:'SELL',strength:.9});
    if(lw/range>0.62&&c.c>c.o*0.999) out.push({name:'Bullish Pin Bar',dir:'BUY',strength:.8});
    if(uw/range>0.62&&c.c<c.o*1.001) out.push({name:'Bearish Pin Bar',dir:'SELL',strength:.8});
    if(body/range<0.1) out.push({name:'Doji',dir:'NEUTRAL',strength:.4});
    return out; },

  marketStructure(bars,pivots){ const res={structure:'range',bos:null,choch:null};
    const H=pivots.highs, L=pivots.lows; if(bars.length<5) return res;
    let st='range';
    if(H.length>=2&&L.length>=2){ const h1=H[H.length-1].price,h0=H[H.length-2].price;
      const l1=L[L.length-1].price,l0=L[L.length-2].price;
      const hh=h1>h0, hl=l1>l0, lh=h1<h0, ll=l1<l0;
      if(hh&&hl) st='uptrend'; else if(lh&&ll) st='downtrend'; }
    res.structure=st;
    const close=bars[bars.length-1].c;
    const lh=H.length?H[H.length-1].price:null, ll=L.length?L[L.length-1].price:null;
    if(lh!==null&&close>lh){ res.bos='BULLISH'; if(st==='downtrend') res.choch='BULLISH'; }
    if(ll!==null&&close<ll){ res.bos='BEARISH'; if(st==='uptrend') res.choch='BEARISH'; }
    return res; }
};

/* ---------------------------------------------------------------------------
   5) Strategy
   --------------------------------------------------------------------------- */
const Strategy = {
  evaluate(id, bars){
    if(!Array.isArray(bars)||bars.length<200) return null;
    const closes=bars.map(b=>b.c), n=bars.length, iL=n-1;
    const e9=Indicators.ema(closes,9), e21=Indicators.ema(closes,21),
          e50=Indicators.ema(closes,50), e200=Indicators.ema(closes,200);
    const rsiA=Indicators.rsi(closes,14);
    const macd=Indicators.macd(closes,12,26,9);
    const bb=Indicators.bollinger(closes,20,2);
    const atrA=Indicators.atr(bars,14);
    const stoch=Indicators.stochastic(bars,14,3,3);
    const pivots=Indicators.findPivots(bars,20);
    const patterns=Indicators.candlePatterns(bars);

    const ev9=U.last(e9), ev21=U.last(e21), ev50=U.last(e50), ev200=U.last(e200);
    const rsi=U.last(rsiA), rsiP=U.last(rsiA,1);
    const ml=U.last(macd.macd), mlP=U.last(macd.macd,1);
    const sl=U.last(macd.signal), slP=U.last(macd.signal,1);
    const hist=U.last(macd.hist), histP=U.last(macd.hist,1);
    const bbU=U.last(bb.upper), bbL=U.last(bb.lower), bwNow=U.last(bb.bw);
    const atr=U.last(atrA);
    const stK=U.last(stoch.k), stD=U.last(stoch.d), stKP=U.last(stoch.k,1), stDP=U.last(stoch.d,1);
    const lastBar=bars[iL];
    const close=U.num(lastBar.c);

    if(!U.isNum(close)||!U.isNum(atr)||atr<=0) return null;
    if(!U.isNum(ev9)||!U.isNum(ev21)||!U.isNum(ev50)||!U.isNum(ev200)) return null;

    const structure=Indicators.marketStructure(bars,pivots);
    const levels=Indicators.keyLevels(pivots,close);

    let squeeze=false;
    const bwWin=[];
    for(let i=Math.max(0,iL-99);i<=iL;i++) if(U.isNum(bb.bw[i])) bwWin.push(bb.bw[i]);
    if(bwWin.length>=30&&U.isNum(bwNow)){ const srt=bwWin.slice().sort((a,b)=>a-b); squeeze=bwNow<=srt[Math.floor(srt.length*0.25)]; }

    const ctx={e9:ev9,e21:ev21,e50:ev50,e200:ev200,rsi:rsi,rsiPrev:rsiP,
      mLine:ml,mLinePrev:mlP,sLine:sl,sLinePrev:slP,hist:hist,histPrev:histP,
      bbU:bbU,bbL:bbL,squeeze:squeeze,atr:atr,
      stK:stK,stD:stD,stKPrev:stKP,stDPrev:stDP,patterns:patterns,
      structure:structure.structure,bos:structure.bos,choch:structure.choch,
      support:levels.support,resistance:levels.resistance,close:close,lastBar:lastBar};

    const buy=Strategy.score('BUY',ctx), sell=Strategy.score('SELL',ctx);
    let dir,score,reasons;
    if(buy.score>=sell.score){ dir='BUY'; score=buy.score; reasons=buy.reasons; }
    else { dir='SELL'; score=sell.score; reasons=sell.reasons; }
    if(score<=0||!reasons.length) return null;

    const lv=Strategy.levels(dir,close,atr);
    return {
      symbol:id,direction:dir,score:score,
      grade:score>=70?'STRONG':(score>=55?'MEDIUM':'WEAK'),
      entry:lv.entry,sl:lv.sl,tp1:lv.tp1,tp2:lv.tp2,tp3:lv.tp3,rr:lv.rr,
      atr:atr,reasons:reasons,
      indicators:{ema9:ev9,ema21:ev21,ema50:ev50,ema200:ev200,rsi:rsi,
        macd:ml,macdSignal:sl,macdHist:hist,bbUpper:bbU,bbLower:bbL,
        stochK:stK,stochD:stD,atr:atr,
        structure:structure.structure,bos:structure.bos,choch:structure.choch,
        support:levels.support,resistance:levels.resistance},
      ts:Date.now()
    };
  },

  score(dir,c){ let s=0; const r=[]; const buy=dir==='BUY';
    if(U.isNum(c.e9)&&U.isNum(c.e21)&&U.isNum(c.e50)&&U.isNum(c.e200)){
      const st=buy?(c.e9>c.e21&&c.e21>c.e50&&c.e50>c.e200):(c.e9<c.e21&&c.e21<c.e50&&c.e50<c.e200);
      const pa=buy?(c.e9>c.e21&&c.e21>c.e50):(c.e9<c.e21&&c.e21<c.e50);
      const sh=buy?(c.e9>c.e21):(c.e9<c.e21);
      if(st){ s+=25; r.push('Trend alignment (9>21>50>200)'); }
      else if(pa){ s+=15; r.push('Partial EMA stack (9>21>50)'); }
      else if(sh){ s+=8; r.push('EMA9/21 cross '+(buy?'up':'down')); }
    }
    if(U.isNum(c.rsi)&&U.isNum(c.rsiPrev)){
      if(buy){ if(c.rsi<30&&c.rsi>c.rsiPrev){ s+=15; r.push('RSI oversold rising ('+c.rsi.toFixed(1)+')'); }
        else if(c.rsi>50&&c.rsi>c.rsiPrev){ s+=7; r.push('RSI above 50 rising'); } }
      else { if(c.rsi>70&&c.rsi<c.rsiPrev){ s+=15; r.push('RSI overbought falling ('+c.rsi.toFixed(1)+')'); }
        else if(c.rsi<50&&c.rsi<c.rsiPrev){ s+=7; r.push('RSI below 50 falling'); } }
    }
    if(U.isNum(c.mLine)&&U.isNum(c.sLine)&&U.isNum(c.hist)){
      const cU=U.isNum(c.mLinePrev)&&U.isNum(c.sLinePrev)&&c.mLine>c.sLine&&c.mLinePrev<=c.sLinePrev;
      const cD=U.isNum(c.mLinePrev)&&U.isNum(c.sLinePrev)&&c.mLine<c.sLine&&c.mLinePrev>=c.sLinePrev;
      if(buy){ if(cU&&c.hist>0){ s+=20; r.push('MACD bullish cross + hist'); }
        else if(c.hist>0&&U.isNum(c.histPrev)&&c.hist>c.histPrev){ s+=10; r.push('MACD hist rising'); }
        else if(c.hist>0){ s+=6; r.push('MACD hist positive'); } }
      else { if(cD&&c.hist<0){ s+=20; r.push('MACD bearish cross + hist'); }
        else if(c.hist<0&&U.isNum(c.histPrev)&&c.hist<c.histPrev){ s+=10; r.push('MACD hist falling'); }
        else if(c.hist<0){ s+=6; r.push('MACD hist negative'); } }
    }
    if(U.isNum(c.bbU)&&U.isNum(c.bbL)&&U.isNum(c.close)){
      const bc=c.lastBar&&c.lastBar.c>c.lastBar.o, br=c.lastBar&&c.lastBar.c<c.lastBar.o;
      if(buy){ if(c.close<=c.bbL&&bc){ s+=10; r.push('Bollinger lower tag + reversal'); }
        else if(c.squeeze&&c.close>c.bbU){ s+=10; r.push('Bollinger squeeze breakout UP'); } }
      else { if(c.close>=c.bbU&&br){ s+=10; r.push('Bollinger upper tag + reversal'); }
        else if(c.squeeze&&c.close<c.bbL){ s+=10; r.push('Bollinger squeeze breakout DOWN'); } }
    }
    if(U.isNum(c.stK)&&U.isNum(c.stD)&&U.isNum(c.stKPrev)&&U.isNum(c.stDPrev)){
      const cU=c.stKPrev<=c.stDPrev&&c.stK>c.stD;
      const cD=c.stKPrev>=c.stDPrev&&c.stK<c.stD;
      if(buy){ if(cU&&c.stK<25){ s+=10; r.push('Stoch cross up in OS'); }
        else if(c.stK>c.stD&&c.stK<50){ s+=5; r.push('Stoch rising below 50'); } }
      else { if(cD&&c.stK>75){ s+=10; r.push('Stoch cross down in OB'); }
        else if(c.stK<c.stD&&c.stK>50){ s+=5; r.push('Stoch falling above 50'); } }
    }
    if(c.patterns&&c.patterns.length){
      const m=c.patterns.filter(p=>p.dir===dir);
      if(m.length){ const pat=m[0];
        if(buy){ const nS=U.isNum(c.support)&&Math.abs(c.close-c.support)<=c.atr*1.5;
          if(nS){ s+=15; r.push(pat.name+' at support'); }
          else { s+=8; r.push(pat.name); } }
        else { const nR=U.isNum(c.resistance)&&Math.abs(c.resistance-c.close)<=c.atr*1.5;
          if(nR){ s+=15; r.push(pat.name+' at resistance'); }
          else { s+=8; r.push(pat.name); } } }
    }
    if(buy){ if(c.choch==='BULLISH'){ s+=5; r.push('CHoCH bullish'); }
      else if(c.bos==='BULLISH'){ s+=5; r.push('BOS bullish'); } }
    else { if(c.choch==='BEARISH'){ s+=5; r.push('CHoCH bearish'); }
      else if(c.bos==='BEARISH'){ s+=5; r.push('BOS bearish'); } }
    return {score:Math.min(100,s),reasons:r};
  },

  levels(dir,entry,atr){ const s=dir==='BUY'?1:-1;
    return { entry:entry, sl:entry-s*1.5*atr, tp1:entry+s*1.5*atr,
      tp2:entry+s*2.5*atr, tp3:entry+s*4.0*atr,
      rr:{tp1:1.0,tp2:1.67,tp3:2.67} }; },

  positionSize(inst,entry,sl){
    const out={lots:null,riskAmount:null,slPips:null,pipValuePerLot:null};
    if(!inst) return out;
    const dist=Math.abs(entry-sl); if(!U.isNum(dist)||dist<=0) return out;
    const ra=Config.BALANCE*(Config.RISK_PCT/100), per=dist*inst.valuePerUnit;
    if(!U.isNum(per)||per<=0) return out;
    out.slPips=dist/inst.pipSize;
    out.riskAmount=ra;
    out.lots=ra/per;
    out.pipValuePerLot=inst.pipSize*inst.valuePerUnit;
    return out;
  },

  confidence(score){ return score>=80?'HIGH':score>=65?'MEDIUM':'LOW'; }
};

/* ---------------------------------------------------------------------------
   6) Journal — JSON file persistence
   --------------------------------------------------------------------------- */
const Journal = {
  entries: [],
  botMessages: {}, // tradeId -> telegram message_id (for editing)

  load(){
    try{
      if(fs.existsSync(Config.JOURNAL_FILE)){
        const raw=fs.readFileSync(Config.JOURNAL_FILE,'utf8');
        const parsed=JSON.parse(raw);
        Journal.entries=Array.isArray(parsed)?parsed:(parsed.entries||[]);
        Journal.botMessages=(parsed&&parsed.botMessages)||{};
        Log.info('journal loaded:', Journal.entries.length, 'trades');
      } else {
        Journal.entries=[];
      }
    }catch(e){ Log.warn('journal load failed:',e.message); Journal.entries=[]; }
  },

  save(){
    try{
      const out={updatedAt:Date.now(),entries:Journal.entries,botMessages:Journal.botMessages};
      fs.writeFileSync(Config.JOURNAL_FILE, JSON.stringify(out,null,2),'utf8');
    }catch(e){ Log.err('journal save failed:',e.message); }
  },

  addFromSignal(sig){
    if(!sig||sig.score<Config.MIN_SCORE) return null;
    const inst=INSTRUMENTS.find(i=>i.id===sig.symbol); if(!inst) return null;

    /* Dedup: skip if an open trade on same symbol+direction+entry exists */
    for(const e of Journal.entries){
      if(e.symbol===sig.symbol&&e.status!=='sl'&&e.status!=='tp3'){
        if(e.direction===sig.direction&&U.isNum(e.entry)&&Math.abs(e.entry-sig.entry)<sig.atr*0.35) return null;
      }
    }

    const sz=Strategy.positionSize(inst,sig.entry,sig.sl);
    const entry={
      id:U.uid(), timestamp:Date.now(), symbol:sig.symbol, direction:sig.direction,
      entry:sig.entry, sl:sig.sl, tp1:sig.tp1, tp2:sig.tp2, tp3:sig.tp3,
      score:sig.score, grade:sig.grade, confidence:Strategy.confidence(sig.score),
      atr:sig.atr, reasons:sig.reasons.slice(), patterns:sig.patterns||[],
      lots:sz.lots, riskAmount:sz.riskAmount, pipSize:inst.pipSize, pipValuePerLot:sz.pipValuePerLot,
      status:'open', hits:{tp1:false,tp2:false,tp3:false}, weakening:false,
      exitPrice:null, closedAt:null, pnl:null, pnlPips:null, r:null,
      notified:{tp1:false,tp2:false,tp3:false,sl:false}
    };
    Journal.entries.unshift(entry);
    Journal.save();
    Log.ok('trade opened:',entry.direction,entry.symbol,'@',entry.entry,'score',entry.score);
    return entry;
  },

  onTick(symbolId, mid){
    if(!U.isNum(mid)) return [];
    const inst=INSTRUMENTS.find(i=>i.id===symbolId); if(!inst) return [];
    const events=[];
    for(const e of Journal.entries){
      if(e.symbol!==symbolId) continue;
      if(e.status==='sl'||e.status==='tp3') continue;
      const buy=e.direction==='BUY';
      const hit=l=>buy?mid>=l:mid<=l;
      const stopped=buy?mid<=e.sl:mid>=e.sl;

      if(stopped&&!e.notified.sl){
        e.status='sl'; e.exitPrice=e.sl; e.closedAt=Date.now();
        const dist=buy?(e.sl-e.entry):(e.entry-e.sl);
        e.pnlPips=dist/e.pipSize;
        const pv=U.isNum(e.pipValuePerLot)?e.pipValuePerLot:(inst.pipSize*inst.valuePerUnit);
        const lots=U.isNum(e.lots)?e.lots:0;
        e.pnl=e.pnlPips*pv*lots;
        e.r=(U.isNum(e.riskAmount)&&e.riskAmount>0)?(e.pnl/e.riskAmount):null;
        e.notified.sl=true;
        events.push({type:'sl',entry:e});
        continue;
      }
      if(!e.hits.tp1&&hit(e.tp1)){ e.hits.tp1=true; e.status='tp1'; e.notified.tp1=true; events.push({type:'tp1',entry:e}); }
      if(!e.hits.tp2&&hit(e.tp2)){ e.hits.tp2=true; e.status='tp2'; e.notified.tp2=true; events.push({type:'tp2',entry:e}); }
      if(!e.hits.tp3&&hit(e.tp3)){ e.hits.tp3=true; e.status='tp3'; e.exitPrice=e.tp3; e.closedAt=Date.now();
        const dist=buy?(e.tp3-e.entry):(e.entry-e.tp3);
        e.pnlPips=dist/e.pipSize;
        const pv=U.isNum(e.pipValuePerLot)?e.pipValuePerLot:(inst.pipSize*inst.valuePerUnit);
        const lots=U.isNum(e.lots)?e.lots:0;
        e.pnl=e.pnlPips*pv*lots;
        e.r=(U.isNum(e.riskAmount)&&e.riskAmount>0)?(e.pnl/e.riskAmount):null;
        e.notified.tp3=true;
        events.push({type:'tp3',entry:e});
        continue;
      }
      /* Still open: update mark-to-market P/L */
      if(e.status!=='tp3'){
        const dist=buy?(mid-e.entry):(e.entry-mid);
        e.pnlPips=dist/e.pipSize;
        const pv=U.isNum(e.pipValuePerLot)?e.pipValuePerLot:(inst.pipSize*inst.valuePerUnit);
        const lots=U.isNum(e.lots)?e.lots:0;
        e.pnl=e.pnlPips*pv*lots;
        e.r=(U.isNum(e.riskAmount)&&e.riskAmount>0)?(e.pnl/e.riskAmount):null;
      }
    }
    if(events.length) Journal.save();
    return events;
  },

  markWeakening(symbolId, score){
    let changed=false;
    for(const e of Journal.entries){
      if(e.symbol!==symbolId) continue;
      if(e.status==='sl'||e.status==='tp3') continue;
      const w=U.isNum(score)&&score<50;
      if(e.weakening!==w){ e.weakening=w; changed=true; }
    }
    if(changed) Journal.save();
  },

  stats(){
    const resolved=Journal.entries.filter(e=>e.status==='sl'||e.status==='tp3');
    let w=0,l=0,gp=0,gl=0,best=null,worst=null,tR=0,rC=0;
    for(const e of resolved){
      const p=U.num(e.pnl)||0;
      if(p>0){ w++; gp+=p; } else if(p<0){ l++; gl+=Math.abs(p); }
      if(best===null||p>best) best=p;
      if(worst===null||p<worst) worst=p;
      if(U.isNum(e.r)){ tR+=e.r; rC++; }
    }
    const tr=w+l;
    return {
      total:Journal.entries.length, closed:resolved.length,
      open:Journal.entries.filter(e=>e.status!=='sl'&&e.status!=='tp3').length,
      wins:w, losses:l,
      winRate:tr>0?(w/tr)*100:null,
      totalR:rC>0?tR:null, avgR:rC>0?tR/rC:null,
      best:best, worst:worst,
      profitFactor:gl>0?(gp/gl):(gp>0?Infinity:null),
      netPnl:gp-gl
    };
  }
};

/* ---------------------------------------------------------------------------
   7) Telegram Bot
   --------------------------------------------------------------------------- */
const Telegram = {
  bot:null, enabled:false, paused:false, _chatId:Config.CHAT_ID,

  init(){
    if(!TelegramBotLib){ Log.warn('Telegram lib missing — disabled'); return; }
    if(!Config.BOT_TOKEN){ Log.warn('TELEGRAM_BOT_TOKEN missing — disabled'); return; }
    try{
      Telegram.bot=new TelegramBotLib(Config.BOT_TOKEN,{polling:true});
      Telegram.enabled=true;
      Telegram.wire();
      Log.tg('bot started');
      /* Announce startup if we have a chat id */
      if(Config.CHAT_ID) Telegram.send('🟢 <b>TradeRadar Pro MAX</b> بدأ التشغيل\n📊 الرموز: '+INSTRUMENTS.map(i=>i.id).join(' · ')+'\n⏱ الإطار: '+Config.TIMEFRAME+'\n🎯 الحد الأدنى: '+Config.MIN_SCORE);
    }catch(e){ Log.err('Telegram init:',e.message); Telegram.enabled=false; }
  },

  wire(){
    if(!Telegram.bot) return;

    Telegram.bot.onText(/\/start/,msg=>{
      Telegram._chatId=String(msg.chat.id);
      Log.tg('/start from chat', Telegram._chatId);
      Telegram.bot.sendMessage(msg.chat.id,
        '👋 أهلاً بك في <b>TradeRadar Pro MAX</b>\n\n' +
        '🆔 <b>Chat ID:</b> <code>'+msg.chat.id+'</code>\n' +
        '📋 انسخ هذا الرقم وضعه في <code>.env</code> باسم <code>TELEGRAM_CHAT_ID</code>\n\n' +
        '<b>الأوامر المتاحة:</b>\n' +
        '/status — الأسعار والصفقات المفتوحة\n' +
        '/signals — آخر 5 إشارات\n' +
        '/stats — إحصائيات الأداء\n' +
        '/pause — إيقاف التنبيهات\n' +
        '/resume — استئناف التنبيهات\n' +
        '/settings — عرض الإعدادات\n' +
        '/help — قائمة الأوامر',
        {parse_mode:'HTML'});
    });

    Telegram.bot.onText(/\/help/,msg=>Telegram.bot.sendMessage(msg.chat.id,
      '<b>الأوامر:</b>\n/status\n/signals\n/stats\n/pause\n/resume\n/settings\n/help',{parse_mode:'HTML'}));

    Telegram.bot.onText(/\/status/,msg=>{
      const lines=['<b>📊 حالة النظام</b>','', '⏱ الوقت: '+U.utcStr(), ''];
      for(const inst of INSTRUMENTS){
        const p=DataFeed.prices[inst.id];
        if(p&&U.isNum(p.mid)) lines.push('<b>'+inst.id+'</b>: <code>'+U.fmt(p.mid,inst.digits)+'</code>');
        else lines.push('<b>'+inst.id+'</b>: —');
      }
      const open=Journal.entries.filter(e=>e.status!=='sl'&&e.status!=='tp3');
      lines.push('','<b>الصفقات المفتوحة:</b> '+open.length);
      for(const e of open.slice(0,5)){
        lines.push('• '+e.symbol+' '+e.direction+' @ '+U.fmt(e.entry,2)+
          ' — P/L: '+U.fmtSigned(e.pnl,2)+'$ ('+U.fmtSigned(e.pnlPips,1)+' pips)');
      }
      Telegram.bot.sendMessage(msg.chat.id,lines.join('\n'),{parse_mode:'HTML'});
    });

    Telegram.bot.onText(/\/signals/,msg=>{
      const list=Journal.entries.slice(0,5);
      if(!list.length){ Telegram.bot.sendMessage(msg.chat.id,'لا توجد إشارات بعد.'); return; }
      const out=['<b>📈 آخر 5 إشارات</b>',''];
      for(const e of list){
        const arrow=e.direction==='BUY'?'🟢':'🔴';
        out.push(arrow+' <b>'+e.symbol+'</b> '+e.direction+' · Score '+e.score);
        out.push('   '+U.tsLabel(e.timestamp)+' · Entry '+U.fmt(e.entry,2)+' · '+e.status);
        out.push('');
      }
      Telegram.bot.sendMessage(msg.chat.id,out.join('\n'),{parse_mode:'HTML'});
    });

    Telegram.bot.onText(/\/stats/,msg=>{
      const s=Journal.stats();
      const pf=s.profitFactor===null?'—':(s.profitFactor===Infinity?'∞':U.fmt(s.profitFactor,2));
      const out=[
        '<b>📊 إحصائيات الأداء</b>','',
        'إجمالي الصفقات: <b>'+s.total+'</b>',
        'مغلقة: <b>'+s.closed+'</b> · مفتوحة: <b>'+s.open+'</b>',
        'نسبة الربح: <b>'+(s.winRate===null?'—':U.fmt(s.winRate,1)+'%')+'</b>',
        'إجمالي R: <b>'+(s.totalR===null?'—':U.fmtSigned(s.totalR,2)+'R')+'</b>',
        'متوسط R: <b>'+(s.avgR===null?'—':U.fmtSigned(s.avgR,2)+'R')+'</b>',
        'Profit Factor: <b>'+pf+'</b>',
        'أفضل صفقة: <b>'+(s.best===null?'—':'$'+U.fmtSigned(s.best,2))+'</b>',
        'أسوأ صفقة: <b>'+(s.worst===null?'—':'$'+U.fmtSigned(s.worst,2))+'</b>',
        'صافي الربح: <b>$'+U.fmtSigned(s.netPnl,2)+'</b>'
      ];
      Telegram.bot.sendMessage(msg.chat.id,out.join('\n'),{parse_mode:'HTML'});
    });

    Telegram.bot.onText(/\/pause/,msg=>{ Telegram.paused=true; Telegram.bot.sendMessage(msg.chat.id,'⏸ تم إيقاف التنبيهات. أرسل /resume للاستئناف.'); });
    Telegram.bot.onText(/\/resume/,msg=>{ Telegram.paused=false; Telegram.bot.sendMessage(msg.chat.id,'▶️ تم استئناف التنبيهات.'); });

    Telegram.bot.onText(/\/settings/,msg=>{
      const out=[
        '<b>⚙️ الإعدادات الحالية</b>','',
        'الرصيد: <b>$'+U.fmt(Config.BALANCE,2)+'</b>',
        'المخاطرة: <b>'+Config.RISK_PCT+'%</b>',
        'الحد الأدنى للنتيجة: <b>'+Config.MIN_SCORE+'</b>',
        'الإطار الزمني: <b>'+Config.TIMEFRAME+'</b>',
        'التنبيهات: <b>'+(Telegram.paused?'موقوفة':'مفعّلة')+'</b>'
      ];
      Telegram.bot.sendMessage(msg.chat.id,out.join('\n'),{parse_mode:'HTML'});
    });

    Telegram.bot.on('polling_error',err=>{ if(!/ETIMEDOUT|EFATAL/.test(err.message)) Log.warn('tg polling:',err.message); });
  },

  send(html,opts){
    if(!Telegram.enabled||Telegram.paused||!Telegram._chatId) return Promise.resolve(null);
    return Telegram.bot.sendMessage(Telegram._chatId,html,Object.assign({parse_mode:'HTML',disable_web_page_preview:true},opts||{}))
      .catch(e=>{ Log.warn('tg send:',e.message); return null; });
  },

  edit(messageId,html){
    if(!Telegram.enabled||!Telegram._chatId||!messageId) return Promise.resolve(null);
    return Telegram.bot.editMessageText(html,{chat_id:Telegram._chatId,message_id:messageId,parse_mode:'HTML',disable_web_page_preview:true})
      .catch(e=>{ Log.warn('tg edit:',e.message); return null; });
  },

  formatSignal(sig){
    const inst=INSTRUMENTS.find(i=>i.id===sig.symbol);
    const d=inst?inst.digits:2;
    const arrow=sig.direction==='BUY'?'🟢':'🔴';
    const conf=Strategy.confidence(sig.score);
    const lines=[
      arrow+' <b>NEW SIGNAL — '+sig.symbol+'</b>',
      '─────────────────────',
      '<b>Direction:</b> '+sig.direction,
      '<b>Score:</b> '+sig.score+'/100 ('+conf+')',
      '<b>Entry:</b> <code>'+U.fmt(sig.entry,d)+'</code>',
      '<b>SL:</b>    <code>'+U.fmt(sig.sl,d)+'</code>',
      '<b>TP1:</b>   <code>'+U.fmt(sig.tp1,d)+'</code> (50%)',
      '<b>TP2:</b>   <code>'+U.fmt(sig.tp2,d)+'</code> (30%)',
      '<b>TP3:</b>   <code>'+U.fmt(sig.tp3,d)+'</code> (20%)',
      '─────────────────────',
      '<b>Reasons:</b>'
    ];
    for(const r of sig.reasons.slice(0,8)) lines.push('✅ '+r);
    lines.push('─────────────────────');
    lines.push('<b>Time:</b> '+U.utcStr());
    lines.push('⚠️ <i>Not financial advice</i>');
    return lines.join('\n');
  },

  formatUpdate(trade,type){
    const inst=INSTRUMENTS.find(i=>i.id===trade.symbol);
    const d=inst?inst.digits:2;
    const head={tp1:'✅ <b>TP1 HIT</b>',tp2:'✅ <b>TP2 HIT</b>',tp3:'🎯 <b>FULL TP — Closed</b>',sl:'❌ <b>SL HIT</b>'}[type];
    const lines=[
      head+' — '+trade.symbol,
      '─────────────────────',
      '<b>Direction:</b> '+trade.direction,
      '<b>Entry:</b> <code>'+U.fmt(trade.entry,d)+'</code>',
      '<b>Score:</b> '+trade.score+'/100'
    ];
    if(type==='sl'){
      lines.push('<b>Exit:</b> <code>'+U.fmt(trade.sl,d)+'</code>');
      lines.push('<b>P/L:</b> '+U.fmtSigned(trade.pnl,2)+'$ ('+U.fmtSigned(trade.pnlPips,1)+' pips)');
      if(U.isNum(trade.r)) lines.push('<b>R:</b> '+U.fmtSigned(trade.r,2)+'R');
    } else if(type==='tp3'){
      lines.push('<b>Exit:</b> <code>'+U.fmt(trade.tp3,d)+'</code>');
      lines.push('<b>P/L:</b> '+U.fmtSigned(trade.pnl,2)+'$ ('+U.fmtSigned(trade.pnlPips,1)+' pips)');
      if(U.isNum(trade.r)) lines.push('<b>R:</b> '+U.fmtSigned(trade.r,2)+'R');
    } else {
      const tp=type==='tp1'?trade.tp1:trade.tp2;
      lines.push('<b>Hit:</b> <code>'+U.fmt(tp,d)+'</code>');
    }
    lines.push('─────────────────────');
    lines.push('<b>Time:</b> '+U.utcStr());
    return lines.join('\n');
  },

  async sendSignal(trade){
    const sig={
      symbol:trade.symbol, direction:trade.direction, score:trade.score,
      entry:trade.entry, sl:trade.sl, tp1:trade.tp1, tp2:trade.tp2, tp3:trade.tp3,
      reasons:trade.reasons
    };
    const html=Telegram.formatSignal(sig);
    const msg=await Telegram.send(html);
    if(msg&&msg.message_id){
      Journal.botMessages[trade.id]=msg.message_id;
      Journal.save();
    }
  },

  async updateTrade(trade,type){
    const id=Journal.botMessages[trade.id];
    if(!id){ /* send new message if edit target unknown */
      return Telegram.send(Telegram.formatUpdate(trade,type));
    }
    return Telegram.edit(id,Telegram.formatUpdate(trade,type));
  }
};

/* ---------------------------------------------------------------------------
   8) DataFeed — SignalR + REST + resolve + retry
   --------------------------------------------------------------------------- */
const DataFeed = {
  connection:null,
  prices:{},
  candles:{},
  resolved:{},
  _retryTimer:null,
  _retryDelay:5000,
  _starting:false,
  _lastLatestPoll:0,

  async resolveSymbols(){
    for(const inst of INSTRUMENTS){
      if(DataFeed.resolved[inst.id]) continue;
      for(const cand of inst.candidates){
        try{
          const bars=await DataFeed.fetchCandles(cand,Config.TIMEFRAME,300);
          if(bars&&bars.length>=50){
            DataFeed.resolved[inst.id]=cand;
            DataFeed.candles[inst.id]={bars:bars,ts:Date.now(),tf:Config.TIMEFRAME};
            Log.ok('resolved',inst.id,'→',cand,'('+bars.length+' bars)');
            break;
          }
        }catch(e){ Log.warn(inst.id,'candidate',cand,'failed:',e.message); }
      }
    }
  },

  async fetchCandles(symbol, interval, limit){
    const url='https://biquote.io/api/'+encodeURIComponent(symbol)+'/candles?interval='+encodeURIComponent(interval)+'&limit='+limit;
    const ctl=(typeof AbortController!=='undefined')?new AbortController():null;
    const to=setTimeout(()=>{ if(ctl) ctl.abort(); },12000);
    let res;
    try{
      res=await fetch(url,{signal:ctl?ctl.signal:undefined});
    } finally { clearTimeout(to); }
    if(!res.ok) throw new Error('HTTP '+res.status);
    const data=await res.json();
    const raw=Array.isArray(data)?data:(data.bars||data.data||data.candles||[]);
    const bars=DataFeed.normalizeBars(raw);
    if(!bars.length) throw new Error('empty candle payload');
    return bars;
  },

  normalizeBars(raw){
    const out=[]; if(!Array.isArray(raw)) return out;
    for(const b of raw){
      if(!b||typeof b!=='object') continue;
      let t=b.t!==undefined?b.t:(b.time!==undefined?b.time:b.timestamp);
      let o=b.o!==undefined?b.o:b.open;
      let h=b.h!==undefined?b.h:b.high;
      let l=b.l!==undefined?b.l:b.low;
      let c=b.c!==undefined?b.c:b.close;
      let v=b.v!==undefined?b.v:b.volume;
      t=U.num(t);o=U.num(o);h=U.num(h);l=U.num(l);c=U.num(c);v=U.num(v);
      if(t===null||o===null||h===null||l===null||c===null) continue;
      if(t<1e12) t*=1000;
      out.push({t:t,o:o,h:h,l:l,c:c,v:v===null?0:v});
    }
    out.sort((a,b)=>a.t-b.t);
    const d=[]; for(const b of out){ if(d.length&&d[d.length-1].t===b.t) d[d.length-1]=b; else d.push(b); }
    return d;
  },

  async fetchLatest(){
    const syms=INSTRUMENTS.map(i=>DataFeed.resolved[i.id]||i.id);
    const q=syms.map(s=>'symbols='+encodeURIComponent(s)).join('&');
    const res=await fetch('https://biquote.io/api/latest?'+q);
    if(!res.ok) throw new Error('HTTP '+res.status);
    return await res.json();
  },

  ingestLatest(data){
    if(!data) return;
    let arr=[];
    if(Array.isArray(data)) arr=data;
    else if(data.quotes&&Array.isArray(data.quotes)) arr=data.quotes;
    else if(data.data&&Array.isArray(data.data)) arr=data.data;
    else if(typeof data==='object'){
      for(const k of Object.keys(data)){ const v=data[k]; if(v&&typeof v==='object') arr.push(Object.assign({symbol:k},v)); }
    }
    for(const q of arr){
      if(!q||typeof q!=='object') continue;
      const sym=q.symbol||q.s||q.Symbol||q.ticker; if(!sym) continue;
      const id=DataFeed.mapToInstrument(String(sym).toUpperCase()); if(!id) continue;
      const bid=U.num(q.bid!==undefined?q.bid:q.b), ask=U.num(q.ask!==undefined?q.ask:q.a);
      let mid=U.num(q.mid!==undefined?q.mid:(q.m!==undefined?q.m:q.price));
      if(mid===null){ if(bid!==null&&ask!==null) mid=(bid+ask)/2; else if(bid!==null) mid=bid; else if(ask!==null) mid=ask; }
      if(mid===null) continue;
      DataFeed.applyPrice(id,bid,ask,mid,q.time);
    }
  },

  mapToInstrument(sym){
    const up=String(sym).toUpperCase();
    for(const inst of INSTRUMENTS){
      if(inst.id===up) return inst.id;
      const r=DataFeed.resolved[inst.id]; if(r&&String(r).toUpperCase()===up) return inst.id;
      for(const c of inst.candidates) if(String(c).toUpperCase()===up) return inst.id;
    }
    return null;
  },

  async init(){
    try{
      DataFeed.connection=new signalR.HubConnectionBuilder()
        .withUrl('https://biquote.io/hubs/tick')
        .withAutomaticReconnect([0,2000,5000,10000,30000])
        .configureLogging(signalR.LogLevel.Warning)
        .build();

      DataFeed.connection.on('ReceiveTick',tick=>{
        try{
          const rs=tick.symbol||tick.s||tick.Symbol; if(!rs) return;
          const id=DataFeed.mapToInstrument(String(rs).toUpperCase()); if(!id) return;
          const bid=U.num(tick.bid!==undefined?tick.bid:tick.b);
          const ask=U.num(tick.ask!==undefined?tick.ask:tick.a);
          let mid=U.num(tick.mid!==undefined?tick.mid:tick.m);
          if(mid===null){ if(bid!==null&&ask!==null) mid=(bid+ask)/2; else if(bid!==null) mid=bid; else if(ask!==null) mid=ask; }
          if(mid===null) return;
          DataFeed.applyPrice(id,bid,ask,mid,tick.time);
        }catch(e){ Log.warn('tick handler:',e.message); }
      });

      DataFeed.connection.onreconnecting(()=>Log.warn('SignalR reconnecting'));
      DataFeed.connection.onreconnected(async()=>{ Log.ok('SignalR reconnected'); await DataFeed.subscribe(); });
      DataFeed.connection.onclose(()=>{ Log.err('SignalR closed'); DataFeed.scheduleRetry(); });

      await DataFeed.start();
    }catch(e){ Log.err('SignalR init:',e.message); DataFeed.scheduleRetry(); }
  },

  async start(){
    if(DataFeed._starting||!DataFeed.connection) return;
    if(DataFeed.connection.state===signalR.HubConnectionState.Connected) return;
    DataFeed._starting=true;
    try{
      await DataFeed.connection.start();
      Log.ok('SignalR connected');
      DataFeed._retryDelay=5000;
      await DataFeed.subscribe();
    }catch(e){ Log.warn('SignalR start:',e.message); DataFeed.scheduleRetry(); }
    finally{ DataFeed._starting=false; }
  },

  async subscribe(){
    try{
      if(!DataFeed.connection||DataFeed.connection.state!==signalR.HubConnectionState.Connected) return;
      const syms=INSTRUMENTS.map(i=>DataFeed.resolved[i.id]||i.id);
      await DataFeed.connection.invoke('Subscribe',syms);
      Log.ok('subscribed:',syms.join(', '));
    }catch(e){ Log.warn('subscribe:',e.message); }
  },

  scheduleRetry(){
    if(DataFeed._retryTimer) return;
    const d=DataFeed._retryDelay;
    DataFeed._retryTimer=setTimeout(()=>{
      DataFeed._retryTimer=null;
      DataFeed._retryDelay=Math.min(30000,DataFeed._retryDelay*2);
      DataFeed.start();
    },d);
  },

  applyPrice(id,bid,ask,mid,time){
    const prev=DataFeed.prices[id];
    const prevMid=prev&&U.isNum(prev.mid)?prev.mid:null;
    DataFeed.prices[id]={bid:bid!==null&&bid!==undefined?bid:(prev?prev.bid:null),
      ask:ask!==null&&ask!==undefined?ask:(prev?prev.ask:null),
      mid:mid,prevMid:prevMid,time:time||Date.now()};

    const c=DataFeed.candles[id];
    if(c&&c.bars&&c.bars.length){
      const l=c.bars[c.bars.length-1];
      if(l){ l.c=mid; if(mid>l.h) l.h=mid; if(mid<l.l) l.l=mid; }
    }

    /* Feed the journal (open trade tracking) */
    const events=Journal.onTick(id,mid);
    for(const ev of events){
      Telegram.updateTrade(ev.entry,ev.type);
      Log.ok('trade '+ev.type+':',ev.entry.symbol,ev.entry.direction);
    }
  },

  async refreshCandles(){
    for(const inst of INSTRUMENTS){
      const sym=DataFeed.resolved[inst.id]; if(!sym) continue;
      try{
        const bars=await DataFeed.fetchCandles(sym,Config.TIMEFRAME,300);
        if(bars&&bars.length>=50) DataFeed.candles[inst.id]={bars:bars,ts:Date.now(),tf:Config.TIMEFRAME};
      }catch(e){ Log.warn('refresh',inst.id,e.message); }
    }
  },

  async pollLatest(){
    try{
      const data=await DataFeed.fetchLatest();
      DataFeed.ingestLatest(data);
    }catch(e){ /* silent — websocket is primary */ }
  },

  saveCache(){
    try{
      const cache={updatedAt:Date.now(),candles:{}};
      for(const id of Object.keys(DataFeed.candles)) cache.candles[id]=DataFeed.candles[id];
      fs.writeFileSync(Config.CACHE_FILE,JSON.stringify(cache),'utf8');
    }catch(e){ /* silent */ }
  },

  loadCache(){
    try{
      if(!fs.existsSync(Config.CACHE_FILE)) return;
      const raw=fs.readFileSync(Config.CACHE_FILE,'utf8');
      const data=JSON.parse(raw);
      if(data&&data.candles){
        for(const id of Object.keys(data.candles)){
          const c=data.candles[id];
          if(c&&Array.isArray(c.bars)&&c.bars.length>=50){
            DataFeed.candles[id]=c;
            Log.info('cache restored:',id,c.bars.length,'bars');
          }
        }
      }
    }catch(e){ Log.warn('cache load:',e.message); }
  }
};

/* ---------------------------------------------------------------------------
   9) Scheduler — candle refresh, summary, session alerts
   --------------------------------------------------------------------------- */
const Scheduler = {
  _lastSummaryDay:null,
  _lastSessionState:null,

  start(){
    /* Candles every 30s */
    setInterval(()=>DataFeed.refreshCandles().then(()=>DataFeed.saveCache()),30000);

    /* Latest prices via REST as backup every 5s */
    setInterval(()=>DataFeed.pollLatest(),5000);

    /* Evaluate every 15s (light) — heavy scoring happens on candle refresh too */
    setInterval(Scheduler.evaluateAll,15000);

    /* Daily summary + session alerts check every minute */
    setInterval(Scheduler.checkSchedule,60000);
  },

  evaluateAll(){
    for(const inst of INSTRUMENTS){
      const c=DataFeed.candles[inst.id]; if(!c||!c.bars||c.bars.length<200) continue;
      try{
        const sig=Strategy.evaluate(inst.id,c.bars);
        if(!sig) continue;

        /* Use live price if available as entry */
        const live=DataFeed.prices[inst.id]&&U.isNum(DataFeed.prices[inst.id].mid)?DataFeed.prices[inst.id].mid:null;
        if(U.isNum(live)){
          const lv=Strategy.levels(sig.direction,live,sig.atr);
          sig.entry=lv.entry; sig.sl=lv.sl; sig.tp1=lv.tp1; sig.tp2=lv.tp2; sig.tp3=lv.tp3; sig.rr=lv.rr;
        }

        Journal.markWeakening(inst.id,sig.score);

        if(sig.score>=Config.MIN_SCORE){
          const trade=Journal.addFromSignal(sig);
          if(trade){
            Log.ok('SIGNAL',trade.direction,trade.symbol,'score',trade.score);
            Telegram.sendSignal(trade);
          }
        }
      }catch(e){ Log.err('evaluate',inst.id,e.message); }
    }
  },

  checkSchedule(){
    const now=new Date();
    const dayKey=now.getUTCFullYear()+'-'+(now.getUTCMonth()+1)+'-'+now.getUTCDate();

    /* Daily summary at SUMMARY_HOUR UTC */
    if(now.getUTCHours()===Config.SUMMARY_HOUR && Scheduler._lastSummaryDay!==dayKey){
      Scheduler._lastSummaryDay=dayKey;
      Scheduler.sendDailySummary();
    }

    /* Session boundary alerts */
    const isOpen=Market.isOpen();
    if(Scheduler._lastSessionState!==null&&Scheduler._lastSessionState!==isOpen){
      if(isOpen) Telegram.send('🟢 <b>Market OPEN</b> — '+U.utcStr());
      else Telegram.send('🔴 <b>Market CLOSED</b> — '+U.utcStr());
      Log.info('session change →',isOpen?'open':'closed');
    }
    Scheduler._lastSessionState=isOpen;
  },

  sendDailySummary(){
    const s=Journal.stats();
    const html=[
      '📊 <b>Daily Summary</b> — '+U.utcStr().slice(0,10),
      '─────────────────────',
      'Total trades: <b>'+s.total+'</b>',
      'Closed: <b>'+s.closed+'</b> · Open: <b>'+s.open+'</b>',
      'Wins/Losses: <b>'+s.wins+'/'+s.losses+'</b>',
      'Win rate: <b>'+(s.winRate===null?'—':U.fmt(s.winRate,1)+'%')+'</b>',
      'Net P/L: <b>$'+U.fmtSigned(s.netPnl,2)+'</b>',
      'Total R: <b>'+(s.totalR===null?'—':U.fmtSigned(s.totalR,2)+'R')+'</b>',
      'Profit Factor: <b>'+(s.profitFactor===null?'—':(s.profitFactor===Infinity?'∞':U.fmt(s.profitFactor,2)))+'</b>',
      '─────────────────────',
      '⚠️ <i>Not financial advice</i>'
    ].join('\n');
    Telegram.send(html);
    Log.tg('daily summary sent');
  }
};

/* ---------------------------------------------------------------------------
   10) Market hours (shared logic — mirrored in index.html)
   --------------------------------------------------------------------------- */
const Market = {
  isOpen(){
    const d=new Date(), day=d.getUTCDay(), h=d.getUTCHours();
    if(day===6) return false;
    if(day===0) return h>=22;
    if(day===5) return h<22;
    return true;
  }
};

/* ---------------------------------------------------------------------------
   11) Health server (for dashboard ping + journal read)
   --------------------------------------------------------------------------- */
const HealthServer = {
  server:null,
  start(){
    if(HealthServer.server) return;
    HealthServer.server=http.createServer((req,res)=>{
      try{
        const url=req.url.split('?')[0];
        const cors={
          'Access-Control-Allow-Origin':'*',
          'Access-Control-Allow-Methods':'GET,OPTIONS',
          'Access-Control-Allow-Headers':'Content-Type'
        };
        if(req.method==='OPTIONS'){ res.writeHead(204,cors); res.end(); return; }

        if(url==='/health'){
          const body=JSON.stringify({
            status:'ok',
            uptime:Math.floor(process.uptime()),
            now:Date.now(),
            symbols:INSTRUMENTS.map(i=>({id:i.id,resolved:DataFeed.resolved[i.id]||null,price:DataFeed.prices[i.id]?DataFeed.prices[i.id].mid:null})),
            openTrades:Journal.entries.filter(e=>e.status!=='sl'&&e.status!=='tp3').length,
            totalTrades:Journal.entries.length
          });
          res.writeHead(200,Object.assign({'Content-Type':'application/json'},cors));
          res.end(body);
          return;
        }

        if(url==='/journal'){
          const body=JSON.stringify({updatedAt:Date.now(),trades:Journal.entries});
          res.writeHead(200,Object.assign({'Content-Type':'application/json'},cors));
          res.end(body);
          return;
        }

        res.writeHead(404,Object.assign({'Content-Type':'text/plain'},cors));
        res.end('Not Found');
      }catch(e){
        Log.err('http handler:',e.message);
        try{ res.writeHead(500); res.end('err'); }catch(_){}
      }
    });
    HealthServer.server.listen(Config.PORT,'0.0.0.0',()=>{
      Log.ok('health server listening on port',Config.PORT);
      Log.info('dashboard ping URL: http://<YOUR_VM_IP>:'+Config.PORT+'/health');
    });
    HealthServer.server.on('error',e=>Log.err('http server:',e.message));
  },
  stop(){
    if(HealthServer.server) HealthServer.server.close(()=>Log.info('health server closed'));
  }
};

/* ---------------------------------------------------------------------------
   12) App — bootstrap + graceful shutdown
   --------------------------------------------------------------------------- */
const App = {
  starting:false,

  async boot(){
    if(App.starting) return; App.starting=true;

    Log.info('===============================================');
    Log.info('  TradeRadar Pro MAX — bot.js starting');
    Log.info('===============================================');
    Log.info('symbols:',INSTRUMENTS.map(i=>i.id).join(', '));
    Log.info('timeframe:',Config.TIMEFRAME,'| min score:',Config.MIN_SCORE);
    Log.info('balance:',Config.BALANCE,'| risk:',Config.RISK_PCT+'%');
    Log.info('telegram:',Config.BOT_TOKEN?'ENABLED':'DISABLED (set TELEGRAM_BOT_TOKEN)');

    /* 1) Load persisted data */
    Journal.load();
    DataFeed.loadCache();

    /* 2) Resolve symbols (fallback chain) */
    await DataFeed.resolveSymbols();

    /* 3) Initial candle fetch */
    await DataFeed.refreshCandles();

    /* 4) Seed prices from candles if needed */
    for(const inst of INSTRUMENTS){
      if(DataFeed.prices[inst.id]&&U.isNum(DataFeed.prices[inst.id].mid)) continue;
      const c=DataFeed.candles[inst.id];
      if(c&&c.bars&&c.bars.length){
        const p=c.bars[c.bars.length-1].c;
        if(U.isNum(p)) DataFeed.prices[inst.id]={bid:p,ask:p,mid:p,prevMid:p,time:Date.now()};
      }
    }

    /* 5) Initial evaluation */
    Scheduler.evaluateAll();

    /* 6) Telegram */
    Telegram.init();

    /* 7) SignalR stream */
    await DataFeed.init();

    /* 8) HTTP health server for dashboard */
    HealthServer.start();

    /* 9) Scheduler timers */
    Scheduler.start();

    /* 10) Periodic journal save (belt & braces) */
    setInterval(()=>Journal.save(),60000);

    Log.ok('all systems operational');
  },

  shutdown(signal){
    Log.warn('received '+signal+' — shutting down gracefully…');
    try{ if(DataFeed.connection) DataFeed.connection.stop(); }catch(e){}
    Journal.save();
    DataFeed.saveCache();
    HealthServer.stop();
    setTimeout(()=>{ Log.info('bye.'); process.exit(0); },1500);
  }
};

process.on('SIGTERM',()=>App.shutdown('SIGTERM'));
process.on('SIGINT', ()=>App.shutdown('SIGINT'));
process.on('uncaughtException',e=>Log.err('uncaughtException:',e&&e.message?e.message:e));
process.on('unhandledRejection',e=>Log.warn('unhandledRejection:',e&&e.message?e.message:e));

App.boot().catch(e=>{ Log.err('boot failed:',e.message); process.exit(1); });
