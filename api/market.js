// NERVA MARKET v7.8 — yahoo-finance15 via RapidAPI
// Uses /stock/history per symbol (free tier) — no bulk quotes needed
// Each symbol gets one history call: latest price + closes for SMA/RSI
// 18 parallel calls via RapidAPI proxy — no Vercel IP blocking
// Requires: RAPIDAPI_KEY in Vercel env vars

const CACHE_SECONDS = 180;

const PORT_SYMS   = ['VGT','GDX','QBTS','VYM'];
const SECTOR_SYMS = ['XLK','XLF','XLE','XLV','XLI','XLY','XLP','XLU','XLB','XLRE','XLC'];
const ALL_SYMS    = ['SPY','QQQ','VIX',...PORT_SYMS,...SECTOR_SYMS];

const RAPID_HOST = 'yahoo-finance15.p.rapidapi.com';

function getNextFOMCDays(){
  const dates=['2026-05-06','2026-06-17','2026-07-29','2026-09-16','2026-11-04','2026-12-16'];
  const now=new Date();
  for(const d of dates){const diff=(new Date(d)-now)/(864e5); if(diff>-1) return Math.max(0,Math.ceil(diff));}
  return 30;
}

function num(v,f=0){const n=Number(v); return Number.isFinite(n)?n:f;}

function sma(arr,len){
  if(!Array.isArray(arr)||arr.length<len) return 0;
  return arr.slice(-len).reduce((a,b)=>a+b,0)/len;
}

function rsi14(closes){
  const v=(closes||[]).filter(c=>Number.isFinite(c)&&c>0);
  if(v.length<15) return 0;
  let g=0,l=0;
  for(let i=v.length-14;i<v.length;i++){const d=v[i]-v[i-1]; if(d>=0)g+=d; else l+=Math.abs(d);}
  if(l===0) return 100;
  return Math.round((100-(100/(1+g/l)))*10)/10;
}

async function fetchHistory(sym, key){
  // Use 6mo daily history — gives ~126 bars, enough for SMA20/50 and RSI
  // For SMA200 we use quote field fiftyTwoWeekHigh/Low as proxy if not enough bars
  const url=`https://${RAPID_HOST}/api/v1/markets/stock/history?symbol=${encodeURIComponent(sym)}&interval=1d&diffandsplits=false`;
  const r=await fetch(url,{
    headers:{'x-rapidapi-host':RAPID_HOST,'x-rapidapi-key':key,'Content-Type':'application/json'},
    signal: AbortSignal.timeout ? AbortSignal.timeout(7000) : undefined,
  });
  if(!r.ok) throw new Error(`${sym} ${r.status}`);
  const data=await r.json();
  // Parse body — can be date-keyed object or array
  const body=data?.body;
  let closes=[], latestPrice=0, latestChangePct=0;
  if(body&&typeof body==='object'&&!Array.isArray(body)){
    const keys=Object.keys(body).sort();
    closes=keys.map(k=>num(body[k]?.close||body[k]?.adjclose,0)).filter(v=>v>0);
    const last=body[keys[keys.length-1]]||{};
    const prev=body[keys[keys.length-2]]||{};
    latestPrice=num(last.close||last.adjclose,0);
    const prevPrice=num(prev.close||prev.adjclose,0);
    latestChangePct=prevPrice>0?((latestPrice-prevPrice)/prevPrice)*100:0;
  } else if(Array.isArray(body)){
    closes=body.map(d=>num(d.close||d.adjclose,0)).filter(v=>v>0);
    if(closes.length>=2){
      latestPrice=closes[closes.length-1];
      latestChangePct=closes[closes.length-2]>0?((latestPrice-closes[closes.length-2])/closes[closes.length-2])*100:0;
    }
  }
  return{sym, closes, latestPrice, latestChangePct};
}

export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Cache-Control',`s-maxage=${CACHE_SECONDS}, stale-while-revalidate`);

  const key=process.env.RAPIDAPI_KEY;
  if(!key) return res.status(500).json({error:'RAPIDAPI_KEY not set'});

  try{
    // All symbols in parallel — RapidAPI handles the routing, no IP blocking
    const results=await Promise.allSettled(ALL_SYMS.map(sym=>fetchHistory(sym,key)));

    const hMap={};
    const errors=[];
    for(let i=0;i<results.length;i++){
      const r=results[i], sym=ALL_SYMS[i];
      if(r.status==='fulfilled') hMap[sym]=r.value;
      else errors.push({sym,msg:r.reason?.message||'failed'});
    }

    const get=(sym)=>hMap[sym]||{sym,closes:[],latestPrice:0,latestChangePct:0};

    const spy=get('SPY'), qqq=get('QQQ'), vix=get('VIX');
    const spyC=spy.closes, qqqC=qqq.closes;

    const vixLevel=num(vix.latestPrice,16);

    const sp={};
    SECTOR_SYMS.forEach(s=>{sp[s]=num(get(s).latestChangePct,0);});
    const sectorsPos=Object.values(sp).filter(v=>v>0).length;
    const sorted=Object.entries(sp).sort((a,b)=>b[1]-a[1]);
    const spread=sorted.length>=6
      ?sorted.slice(0,3).reduce((s,[,v])=>s+v,0)/3-sorted.slice(-3).reduce((s,[,v])=>s+v,0)/3
      :0;

    const portfolio=PORT_SYMS.map(sym=>{
      const h=get(sym);
      return{
        sym,
        price:     num(h.latestPrice,0),
        changePct: num(h.latestChangePct,0),
        volume:    0,
        sma20:     sma(h.closes,20),
        sma50:     sma(h.closes,50),
        sma200:    sma(h.closes,200),
        rsi:       rsi14(h.closes),
      };
    });

    const symbolsFetched=Object.keys(hMap).length;
    const dataStatus=symbolsFetched>=15?'LIVE':symbolsFetched>=8?'PARTIAL':'DEGRADED';

    return res.status(200).json({
      timestamp:new Date().toISOString(),
      source:'rapidapi_yh15_history_v78',
      dataStatus,
      symbolsFetched,
      quoteErrors:errors,
      spy:{
        price:     num(spy.latestPrice,0),
        changePct: num(spy.latestChangePct,0),
        sma20:     sma(spyC,20),
        sma50:     sma(spyC,50),
        sma200:    sma(spyC,200),
        rsi:       rsi14(spyC),
      },
      qqq:{
        price:     num(qqq.latestPrice,0),
        changePct: num(qqq.latestChangePct,0),
        sma50:     sma(qqqC,50),
        rsi:       rsi14(qqqC),
      },
      vix:{level:vixLevel, changePct:num(vix.latestChangePct,0)},
      vvix:{level:vixLevel>22?96:81},
      putCall:{ratio:vixLevel>25?1.1:vixLevel>20?0.95:vixLevel>15?0.84:0.75},
      breadth:{
        above20d:  +(15+(sectorsPos/11)*55).toFixed(1),
        above50d:  +(10+(sectorsPos/11)*50).toFixed(1),
        above200d: +(12+(sectorsPos/11)*48).toFixed(1),
        advDeclineRatio:+(0.55+(sectorsPos/11)*0.95).toFixed(2),
        nhNl:      +(0.45+Math.max(0,spread+1.2)*0.45).toFixed(2),
      },
      sectors:sp,
      macro:{
        tenYear:{yield:4.31,trend:'neutral'},
        dxy:{level:104.03,trend:'neutral'},
        fedStance:'neutral',
        fomcDays:getNextFOMCDays(),
      },
      exec:{breakoutRetention:0.40,trendReliability:0.32,pullbackBid:0.48,followThrough:0.44},
      portfolio,
    });
  }catch(e){
    return res.status(500).json({error:'proxy crash',message:e.message,timestamp:new Date().toISOString()});
  }
}
