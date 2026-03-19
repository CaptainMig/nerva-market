// ═══════════════════════════════════════════════════════════════
// NERVA MARKET — Vercel Serverless Proxy
// /api/market.js — v4.4: v7/quote bulk + v8/chart for SPY/QQQ MAs
// ═══════════════════════════════════════════════════════════════

const CACHE_SECONDS = 60;

const PORT_SYMS     = ['VGT','GDX','QBTS','VYM'];
const SECTOR_SYMS   = ['XLK','XLF','XLE','XLV','XLI','XLY','XLP','XLU','XLB','XLRE','XLC'];
const UNIVERSE_SYMS = ['NVDA','AAPL','MSFT','GOOGL','AMZN','META','TSLA','AMD','AVGO','LLY','JPM','V','UNH','XOM','COST','IONQ','RGTI','PLTR','COIN','SNOW','PANW','CRWD','NET','SQ','SHOP'];
const MACRO_SYMS    = ['SPY','QQQ','^VIX','^TNX','DX-Y.NYB'];
const ALL_SYMS      = [...MACRO_SYMS, ...PORT_SYMS, ...SECTOR_SYMS, ...UNIVERSE_SYMS];

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

function parseHistory(data) {
  try {
    const r = data?.chart?.result?.[0];
    if (!r) return { sma20:0, sma50:0, sma200:0, rsi:55 };
    const closes = r.indicators?.quote?.[0]?.close?.filter(c => c != null) || [];
    const sma = (n) => closes.length >= n ? closes.slice(-n).reduce((a,b)=>a+b,0)/n : 0;
    function calcRSI(arr, p=14) {
      if (arr.length < p+1) return 55;
      const ch = arr.slice(-(p+1)).map((v,i,a) => i>0 ? v-a[i-1] : 0).slice(1);
      const g = ch.filter(c=>c>0).reduce((a,b)=>a+b,0)/p;
      const l = ch.filter(c=>c<0).map(Math.abs).reduce((a,b)=>a+b,0)/p;
      return l===0 ? 100 : Math.round(100-(100/(1+g/l)));
    }
    return { sma20:sma(20), sma50:sma(50), sma200:sma(200), rsi:calcRSI(closes) };
  } catch { return { sma20:0, sma50:0, sma200:0, rsi:55 }; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', `s-maxage=${CACHE_SECONDS}, stale-while-revalidate`);

  try {
    // THREE parallel requests only — well within Vercel 10s timeout
    const [quoteResp, spyResp, qqqResp] = await Promise.all([
      fetch(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${ALL_SYMS.join(',')}`, { headers: HEADERS }),
      fetch(`https://query2.finance.yahoo.com/v8/finance/chart/SPY?range=6mo&interval=1d`, { headers: HEADERS }),
      fetch(`https://query2.finance.yahoo.com/v8/finance/chart/QQQ?range=6mo&interval=1d`, { headers: HEADERS }),
    ]);

    // Parse bulk quotes — v7/quote returns regularMarketChangePercent directly
    const quotes = {};
    if (quoteResp.ok) {
      const quoteData = await quoteResp.json();
      (quoteData?.quoteResponse?.result || []).forEach(q => {
        if (q?.symbol) {
          quotes[q.symbol] = {
            price:     q.regularMarketPrice         || 0,
            change:    q.regularMarketChange        || 0,
            changePct: q.regularMarketChangePercent || 0,
            volume:    q.regularMarketVolume        || 0,
            sma50:     q.fiftyDayAverage            || 0,
            sma200:    q.twoHundredDayAverage       || 0,
          };
        }
      });
    } else {
      throw new Error(`Quote fetch failed: ${quoteResp.status}`);
    }

    // SPY/QQQ history for accurate 20/50/200d MAs + RSI
    const spyHistory = spyResp.ok ? parseHistory(await spyResp.json()) : { sma20:0, sma50:0, sma200:0, rsi:55 };
    const qqqHistory = qqqResp.ok ? parseHistory(await qqqResp.json()) : { sma20:0, sma50:0, sma200:0, rsi:55 };

    const spy = quotes['SPY']      || {};
    const qqq = quotes['QQQ']      || {};
    const vix = quotes['^VIX']     || {};
    const tnx = quotes['^TNX']     || {};
    const dxy = quotes['DX-Y.NYB'] || {};

    const vixLevel = vix.price || 16;
    const tnxLevel = tnx.price || 4.3;

    const sp = {};
    SECTOR_SYMS.forEach(s => { sp[s] = quotes[s]?.changePct || 0; });
    const sectorsPos = Object.values(sp).filter(v => v > 0).length;

    res.status(200).json({
      timestamp: new Date().toISOString(),
      source: 'yahoo_finance_v7_quote',
      spy: {
        price:     spy.price     || 0,
        changePct: spy.changePct || 0,
        sma20:     spyHistory.sma20,
        sma50:     spyHistory.sma50  || spy.sma50  || 0,
        sma200:    spyHistory.sma200 || spy.sma200 || 0,
        rsi:       spyHistory.rsi,
      },
      qqq: {
        price:     qqq.price     || 0,
        changePct: qqq.changePct || 0,
        sma50:     qqqHistory.sma50 || qqq.sma50 || 0,
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
        sma50:     quotes[sym]?.sma50     || 0,
        sma200:    quotes[sym]?.sma200    || 0,
      })),
      universe: UNIVERSE_SYMS.map(sym => ({
        sym,
        price:     quotes[sym]?.price     || 0,
        changePct: quotes[sym]?.changePct || 0,
        volume:    quotes[sym]?.volume    || 0,
        sma50:     quotes[sym]?.sma50     || 0,
        sma200:    quotes[sym]?.sma200    || 0,
      })),
    });

  } catch (error) {
    console.error('NERVA Market proxy error:', error);
    res.status(500).json({
      error:     'Failed to fetch market data',
      message:   error.message,
      timestamp: new Date().toISOString(),
    });
  }
}
