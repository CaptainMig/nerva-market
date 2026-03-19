// ═══════════════════════════════════════════════════════════════
// NERVA MARKET — Vercel Serverless Proxy
// /api/market.js — v4.7: FMP new stable API (post-Aug 2025)
// ═══════════════════════════════════════════════════════════════

const CACHE_SECONDS = 60;

const PORT_SYMS     = ['VGT','GDX','QBTS','VYM'];
const SECTOR_SYMS   = ['XLK','XLF','XLE','XLV','XLI','XLY','XLP','XLU','XLB','XLRE','XLC'];
const UNIVERSE_SYMS = ['NVDA','AAPL','MSFT','GOOGL','AMZN','META','TSLA','AMD','AVGO','LLY','JPM','V','UNH','XOM','COST','IONQ','RGTI','PLTR','COIN','SNOW','PANW','CRWD','NET','SQ','SHOP'];
const MACRO_SYMS    = ['SPY','QQQ','^VIX','^TNX'];
const ALL_SYMS      = [...MACRO_SYMS,...PORT_SYMS,...SECTOR_SYMS,...UNIVERSE_SYMS];

// FMP new stable base (post-Aug 2025)
const FMP = 'https://financialmodelingprep.com/stable';

function getNextFOMCDays() {
  const dates = ['2026-05-06','2026-06-17','2026-07-29','2026-09-16','2026-11-04','2026-12-16'];
  const now = new Date();
  for (const d of dates) {
    const diff = (new Date(d)-now)/(1000*60*60*24);
    if (diff > -1) return Math.max(0,Math.ceil(diff));
  }
  return 30;
}

function parseHistory(data) {
  try {
    // New stable API returns { symbol, historical: [...] }
    const hist = Array.isArray(data) ? data : (data?.historical || []);
    const closes = hist.map(d=>d.close||d.adjClose).reverse().filter(c=>c!=null);
    const sma = (n) => closes.length>=n ? closes.slice(-n).reduce((a,b)=>a+b,0)/n : 0;
    function rsi(arr,p=14){
      if(arr.length<p+1)return 55;
      const ch=arr.slice(-(p+1)).map((v,i,a)=>i>0?v-a[i-1]:0).slice(1);
      const g=ch.filter(c=>c>0).reduce((a,b)=>a+b,0)/p;
      const l=ch.filter(c=>c<0).map(Math.abs).reduce((a,b)=>a+b,0)/p;
      return l===0?100:Math.round(100-(100/(1+g/l)));
    }
    return {sma20:sma(20),sma50:sma(50),sma200:sma(200),rsi:rsi(closes)};
  } catch { return {sma20:0,sma50:0,sma200:0,rsi:55}; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET');
  res.setHeader('Cache-Control',`s-maxage=${CACHE_SECONDS}, stale-while-revalidate`);

  const KEY = process.env.FMP_KEY;
  if (!KEY) {
    return res.status(200).json({error:'FMP_KEY not set',timestamp:new Date().toISOString()});
  }

  try {
    // New stable endpoint: /stable/quote?symbol=SPY,QQQ,...&apikey=KEY
    const symbolList = ALL_SYMS.join(',');

    const [quoteResp, spyResp, qqqResp] = await Promise.all([
      fetch(`${FMP}/quote?symbol=${encodeURIComponent(symbolList)}&apikey=${KEY}`),
      fetch(`${FMP}/historical-price-eod/full?symbol=SPY&limit=200&apikey=${KEY}`),
      fetch(`${FMP}/historical-price-eod/full?symbol=QQQ&limit=200&apikey=${KEY}`),
    ]);

    // Parse and expose raw response for debugging
    const quoteText = await quoteResp.text();
    let quoteData;
    try { quoteData = JSON.parse(quoteText); } catch { quoteData = null; }

    // Expose error if not usable
    if (!Array.isArray(quoteData) || quoteData.length === 0) {
      return res.status(200).json({
        error: 'FMP stable quote failed',
        fmp_status: quoteResp.status,
        fmp_response: typeof quoteData === 'object' ? quoteData : quoteText.slice(0,400),
        tried_url: `${FMP}/quote?symbol=${symbolList.slice(0,50)}...`,
        timestamp: new Date().toISOString(),
      });
    }

    // Parse quotes
    const q = {};
    quoteData.forEach(item => {
      if (item?.symbol) {
        q[item.symbol] = {
          price:     item.price             || item.previousClose || 0,
          change:    item.change            || 0,
          changePct: item.changesPercentage || item.changePercent || 0,
          volume:    item.volume            || 0,
        };
      }
    });

    // Parse SPY/QQQ history for MAs + RSI
    const spyData  = spyResp.ok  ? await spyResp.json()  : null;
    const qqqData  = qqqResp.ok  ? await qqqResp.json()  : null;
    const spyHist  = parseHistory(spyData);
    const qqqHist  = parseHistory(qqqData);

    const spy = q['SPY']  || {};
    const qqq = q['QQQ']  || {};
    const vix = q['^VIX'] || {};
    const tnx = q['^TNX'] || {};

    const vixLevel = vix.price || 16;
    const tnxLevel = tnx.price || 4.3;

    const sp = {};
    SECTOR_SYMS.forEach(s => { sp[s] = q[s]?.changePct || 0; });
    const sectorsPos = Object.values(sp).filter(v=>v>0).length;

    res.status(200).json({
      timestamp: new Date().toISOString(),
      source: 'financial_modeling_prep_stable',
      symbols_fetched: quoteData.length,
      spy:  {price:spy.price||0, changePct:spy.changePct||0, sma20:spyHist.sma20, sma50:spyHist.sma50, sma200:spyHist.sma200, rsi:spyHist.rsi},
      qqq:  {price:qqq.price||0, changePct:qqq.changePct||0, sma50:qqqHist.sma50, rsi:qqqHist.rsi},
      vix:  {level:vixLevel, change:vix.change||0, changePct:vix.changePct||0},
      vvix: {level:85},
      putCall: {ratio: vixLevel>25?1.1:vixLevel>20?0.95:vixLevel>15?0.85:0.75},
      breadth: {
        above20d:        sectorsPos/11*70+15,
        above50d:        sectorsPos/11*65+10,
        above200d:       sectorsPos/11*60+15,
        advDeclineRatio: sectorsPos>6?1.0+(sectorsPos-6)*0.15:0.5+sectorsPos*0.08,
      },
      sectors: sp,
      macro: {
        tenYear: {yield:tnxLevel, change:tnx.change||0, trend:(tnx.change||0)>0?'rising':'falling'},
        dxy:     {level:104, change:0, trend:'neutral'},
        fedStance: tnxLevel>4.5?'hawkish':tnxLevel>4.0?'neutral':'dovish',
        fomcDays: getNextFOMCDays(),
      },
      portfolio: PORT_SYMS.map(sym => ({sym, price:q[sym]?.price||0, changePct:q[sym]?.changePct||0, volume:q[sym]?.volume||0, sma50:0, sma200:0})),
      universe:  UNIVERSE_SYMS.map(sym => ({sym, price:q[sym]?.price||0, changePct:q[sym]?.changePct||0, volume:q[sym]?.volume||0, sma50:0, sma200:0})),
    });

  } catch(error) {
    res.status(500).json({error:'Failed to fetch', message:error.message, timestamp:new Date().toISOString()});
  }
}
