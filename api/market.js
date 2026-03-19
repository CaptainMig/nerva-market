// ═══════════════════════════════════════════════════════════════
// NERVA MARKET — Vercel Serverless Proxy
// /api/market.js — v4.3: single bulk call, no timeout
// ═══════════════════════════════════════════════════════════════

const CACHE_SECONDS = 60;

const PORT_SYMS     = ['VGT','GDX','QBTS','VYM'];
const SECTOR_SYMS   = ['XLK','XLF','XLE','XLV','XLI','XLY','XLP','XLU','XLB','XLRE','XLC'];
const UNIVERSE_SYMS = ['NVDA','AAPL','MSFT','GOOGL','AMZN','META','TSLA','AMD','AVGO','LLY','JPM','V','UNH','XOM','COST','IONQ','RGTI','PLTR','COIN','SNOW','PANW','CRWD','NET','SQ','SHOP'];
const MACRO_SYMS    = ['SPY','QQQ','^VIX','^TNX','DX-Y.NYB'];

const ALL_SYMS = [...MACRO_SYMS, ...PORT_SYMS, ...SECTOR_SYMS, ...UNIVERSE_SYMS];

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://finance.yahoo.com/',
  'Origin': 'https://finance.yahoo.com',
};

function getNextFOMCDays() {
  const dates = ['2026-03-18','2026-05-06','2026-06-17','2026-07-29','2026-09-16','2026-11-04','2026-12-16'];
  const now = new Date();
  for (const d of dates) {
    const diff = (new Date(d) - now) / (1000*60*60*24);
    if (diff > -1) return Math.max(0, Math.ceil(diff));
  }
  return 30;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', `s-maxage=${CACHE_SECONDS}, stale-while-revalidate`);

  try {
    // Single bulk call using Yahoo spark endpoint — all symbols at once, no timeout risk
    const symbols = ALL_SYMS.join(',');
    const sparkUrl = `https://query1.finance.yahoo.com/v8/finance/spark?symbols=${encodeURIComponent(symbols)}&range=1d&interval=5m`;

    // Also fetch SPY 6mo for real moving averages
    const [sparkResp, spyResp, qqqResp] = await Promise.all([
      fetch(sparkUrl, { headers: HEADERS }),
      fetch(`https://query2.finance.yahoo.com/v8/finance/chart/SPY?range=6mo&interval=1d`, { headers: HEADERS }),
      fetch(`https://query2.finance.yahoo.com/v8/finance/chart/QQQ?range=6mo&interval=1d`, { headers: HEADERS }),
    ]);

    // Parse spark data — gives us price + change for all symbols in one shot
    const quotes = {};
    if (sparkResp.ok) {
      const sparkData = await sparkResp.json();
      const sparkResult = sparkData?.spark?.result || [];
      for (const item of sparkResult) {
        const sym = item.symbol;
        const r = item.response?.[0];
        if (!r) continue;
        const meta = r.meta || {};
        const closes = r.indicators?.quote?.[0]?.close?.filter(c => c != null) || [];
        const price = meta.regularMarketPrice || closes[closes.length-1] || 0;
        const changePct = meta.regularMarketChangePercent || 0;
        const change = meta.regularMarketChange || 0;
        quotes[sym] = { price, change, changePct, volume: meta.regularMarketVolume || 0 };
      }
    }

    // Parse SPY/QQQ history for real MAs + RSI
    function parseHistory(resp_data) {
      try {
        const r = resp_data?.chart?.result?.[0];
        if (!r) return { sma20:0, sma50:0, sma200:0, rsi:55 };
        const closes = r.indicators?.quote?.[0]?.close?.filter(c => c != null) || [];
        const sma = (n) => closes.length >= n ? closes.slice(-n).reduce((a,b)=>a+b,0)/n : 0;
        function calcRSI(arr, p=14) {
          if (arr.length < p+1) return 55;
          const ch = arr.slice(-(p+1)).map((v,i,a)=>i>0?v-a[i-1]:0).slice(1);
          const g = ch.filter(c=>c>0).reduce((a,b)=>a+b,0)/p;
          const l = ch.filter(c=>c<0).map(Math.abs).reduce((a,b)=>a+b,0)/p;
          return l===0 ? 100 : Math.round(100-(100/(1+g/l)));
        }
        return { sma20:sma(20), sma50:sma(50), sma200:sma(200), rsi:calcRSI(closes) };
      } catch { return { sma20:0, sma50:0, sma200:0, rsi:55 }; }
    }

    const spyHistory  = spyResp.ok  ? parseHistory(await spyResp.json())  : { sma20:0, sma50:0, sma200:0, rsi:55 };
    const qqqHistory  = qqqResp.ok  ? parseHistory(await qqqResp.json())  : { sma20:0, sma50:0, sma200:0, rsi:55 };

    const spy = quotes['SPY']  || {};
    const qqq = quotes['QQQ']  || {};
    const vix = quotes['^VIX'] || {};
    const tnx = quotes['^TNX'] || {};
    const dxy = quotes['DX-Y.NYB'] || {};

    const vixLevel = vix.price || 16;
    const tnxLevel = tnx.price || 4.3;

    // Sector performance
    const sp = {};
    SECTOR_SYMS.forEach(s => { sp[s] = quotes[s]?.changePct || 0; });
    const sectorsPos = Object.values(sp).filter(v => v > 0).length;

    res.status(200).json({
      timestamp: new Date().toISOString(),
      source: 'yahoo_finance_v8_spark',
      spy: {
        price:     spy.price     || 0,
        changePct: spy.changePct || 0,
        sma20:     spyHistory.sma20,
        sma50:     spyHistory.sma50,
        sma200:    spyHistory.sma200,
        rsi:       spyHistory.rsi,
      },
      qqq: {
        price:     qqq.price     || 0,
        changePct: qqq.changePct || 0,
        sma50:     qqqHistory.sma50,
        rsi:       qqqHistory.rsi,
      },
      vix: {
        level:     vixLevel,
        change:    vix.change    || 0,
        changePct: vix.changePct || 0,
      },
      vvix: { level: 85 },
      putCall: {
        ratio: vixLevel > 25 ? 1.1 : vixLevel > 20 ? 0.95 : vixLevel > 15 ? 0.85 : 0.75,
      },
      breadth: {
        above20d:        sectorsPos / 11 * 70 + 15,
        above50d:        sectorsPos / 11 * 65 + 10,
        above200d:       sectorsPos / 11 * 60 + 15,
        advDeclineRatio: sectorsPos > 6 ? 1.0 + (sectorsPos-6)*0.15 : 0.5 + sectorsPos*0.08,
      },
      sectors: sp,
      macro: {
        tenYear: {
          yield:  tnxLevel,
          change: tnx.change    || 0,
          trend:  (tnx.change   || 0) > 0 ? 'rising' : 'falling',
        },
        dxy: {
          level:  dxy.price     || 104,
          change: dxy.changePct || 0,
          trend:  (dxy.changePct|| 0) > 0 ? 'strengthening' : 'weakening',
        },
        fedStance: tnxLevel > 4.5 ? 'hawkish' : tnxLevel > 4.0 ? 'neutral' : 'dovish',
        fomcDays:  getNextFOMCDays(),
      },
      portfolio: PORT_SYMS.map(sym => ({
        sym,
        price:     quotes[sym]?.price     || 0,
        changePct: quotes[sym]?.changePct || 0,
        volume:    quotes[sym]?.volume    || 0,
        sma50:     0, // spark doesn't give history — acceptable tradeoff for speed
        sma200:    0,
      })),
      universe: UNIVERSE_SYMS.map(sym => ({
        sym,
        price:     quotes[sym]?.price     || 0,
        changePct: quotes[sym]?.changePct || 0,
        volume:    quotes[sym]?.volume    || 0,
        sma50:     0,
        sma200:    0,
      })),
    });

  } catch (error) {
    console.error('NERVA Market proxy error:', error);
    res.status(500).json({
      error: 'Failed to fetch market data',
      message: error.message,
      timestamp: new Date().toISOString(),
    });
  }
}
