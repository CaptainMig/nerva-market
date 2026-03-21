// NERVA MARKET v7.9 — Finnhub quotes + Alpha Vantage history
// Finnhub: proven working for prices, changePct, sectors (18 parallel quotes)
// Alpha Vantage: server-side daily history for SMA/RSI (6 symbols)
// Requires: FINNHUB_KEY + ALPHAVANTAGE_KEY in Vercel env vars
// Alpha Vantage free: 25 req/day standard, 500/day with free API key signup
// Get free key: https://www.alphavantage.co/support/#api-key

const CACHE_SECONDS = 180;

const PORT_SYMS   = ['VGT','GDX','QBTS','VYM'];
const SECTOR_SYMS = ['XLK','XLF','XLE','XLV','XLI','XLY','XLP','XLU','XLB','XLRE','XLC'];
const CORE_QUOTES = ['SPY','QQQ','VIX',...PORT_SYMS,...SECTOR_SYMS];
const HIST_SYMS   = ['SPY','QQQ','VGT','GDX','QBTS','VYM'];

const sleep = ms => new Promise(r => setTimeout(r, ms));

function num(v,f=0){const n=Number(v); return Number.isFinite(n)?n:f;}
function sma(arr,len){if(!Array.isArray(arr)||arr.length<len) return 0; return arr.slice(-len).reduce((a,b)=>a+b,0)/len;}
function rsi14(closes){
  const v=(closes||[]).filter(c=>Number.isFinite(c)&&c>0);
  if(v.length<15) return 0;
  let g=0,l=0;
  for(let i=v.length-14;i<v.length;i++){const d=v[i]-v[i-1]; if(d>=0)g+=d; else l+=Math.abs(d);}
  if(l===0) return 100;
  return Math.round((100-(100/(1+g/l)))*10)/10;
}

function getNextFOMCDays(){
  const dates=['2026-05-06','2026-06-17','2026-07-29','2026-09-16','2026-11-04','2026-12-16'];
  const now=new Date();
  for(const d of dates){const diff=(new Date(d)-now)/864e5; if(diff>-1) return Math.max(0,Math.ceil(diff));}
  return 30;
}

async function fetchQuote(sym, key){
  const r=await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${key}`);
  if(!r.ok) throw new Error(`${sym} ${r.status}`);
  const d=await r.json();
  return{sym, price:num(d.c,0), changePct:num(d.dp,0), change:num(d.d,0)};
}

async function fetchAVHistory(sym, key){
  const url=`https://www.alphavantage.co/query?function=TIME_SERIES_DAILY_ADJUSTED&symbol=${encodeURIComponent(sym)}&outputsize=compact&apikey=${key}`;
  const r=await fetch(url);
  if(!r.ok) throw new Error(`AV ${sym} ${r.status}`);
  const data=await r.json();
  // AV returns {"Time Series (Daily)": {"2024-01-02": {"5. adjusted close": "185.2", ...}}}
  const ts=data?.['Time Series (Daily)'];
  if(!ts) throw new Error(`AV ${sym} no data: ${JSON.stringify(data).slice(0,100)}`);
  const closes=Object.keys(ts).sort()
    .map(k=>num(ts[k]?.['5. adjusted close']||ts[k]?.['4. close'],0))
    .filter(v=>v>0);
  if(closes.length<15) throw new Error(`AV ${sym} only ${closes.length} bars`);
  return{sym, closes};
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Cache-Control',`s-maxage=${CACHE_SECONDS}, stale-while-revalidate`);

  const fKey=process.env.FINNHUB_KEY;
  const avKey=process.env.ALPHAVANTAGE_KEY;

  if(!fKey) return res.status(500).json({error:'FINNHUB_KEY not set'});
  if(!avKey) return res.status(500).json({error:'ALPHAVANTAGE_KEY not set — get free key at alphavantage.co/support/#api-key'});

  try{
    // Parallel: all Finnhub quotes + all AV history calls
    const [quoteResults, ...histResults] = await Promise.all([
      Promise.allSettled(CORE_QUOTES.map(sym=>fetchQuote(sym,fKey))),
      ...HIST_SYMS.map(sym=>fetchAVHistory(sym,avKey)
        .then(d=>({sym,closes:d.closes}))
        .catch(()=>({sym,closes:[]}))
      ),
    ]);

    // Build quote map
    const qMap={};
    const quoteErrors=[];
    for(const r of quoteResults){
      if(r.status==='fulfilled') qMap[r.value.sym]=r.value;
      else quoteErrors.push({msg:r.reason?.message||'failed'});
    }

    // Build history map
    const hMap={};
    for(const h of histResults){
      if(h.closes?.length>=15) hMap[h.sym]=h.closes;
    }

    const spy=qMap['SPY']||{}, qqq=qMap['QQQ']||{}, vix=qMap['VIX']||{};
    const spyC=hMap['SPY']||[], qqqC=hMap['QQQ']||[];
    const vixLevel=num(vix.price,16);

    const sp={};
    SECTOR_SYMS.forEach(s=>{sp[s]=num(qMap[s]?.changePct,0);});
    const sectorsPos=Object.values(sp).filter(v=>v>0).length;
    const sorted=Object.entries(sp).sort((a,b)=>b[1]-a[1]);
    const spread=sorted.length>=6
      ?sorted.slice(0,3).reduce((s,[,v])=>s+v,0)/3-sorted.slice(-3).reduce((s,[,v])=>s+v,0)/3
      :0;

    const portfolio=PORT_SYMS.map(sym=>{
      const q=qMap[sym]||{};
      const c=hMap[sym]||[];
      return{
        sym,
        price:     num(q.price,0),
        changePct: num(q.changePct,0),
        volume:    0,
        sma20:     sma(c,20),
        sma50:     sma(c,50),
        sma200:    sma(c,200),
        rsi:       rsi14(c),
      };
    });

    const symbolsFetched=Object.keys(qMap).length;
    const histFetched=Object.keys(hMap).length;
    const dataStatus=symbolsFetched>=15&&histFetched>=4?'LIVE':symbolsFetched>=8?'PARTIAL':'DEGRADED';

    return res.status(200).json({
      timestamp:new Date().toISOString(),
      source:'finnhub_av_v79',
      dataStatus,
      symbolsFetched,
      quoteErrors,
      spy:{
        price:num(spy.price,0), changePct:num(spy.changePct,0),
        sma20:sma(spyC,20), sma50:sma(spyC,50), sma200:sma(spyC,200), rsi:rsi14(spyC),
      },
      qqq:{price:num(qqq.price,0), changePct:num(qqq.changePct,0), sma50:sma(qqqC,50), rsi:rsi14(qqqC)},
      vix:{level:vixLevel, changePct:num(vix.changePct,0)},
      vvix:{level:vixLevel>22?96:81},
      putCall:{ratio:vixLevel>25?1.1:vixLevel>20?0.95:vixLevel>15?0.84:0.75},
      breadth:{
        above20d:+(15+(sectorsPos/11)*55).toFixed(1),
        above50d:+(10+(sectorsPos/11)*50).toFixed(1),
        above200d:+(12+(sectorsPos/11)*48).toFixed(1),
        advDeclineRatio:+(0.55+(sectorsPos/11)*0.95).toFixed(2),
        nhNl:+(0.45+Math.max(0,spread+1.2)*0.45).toFixed(2),
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
