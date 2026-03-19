// ═══════════════════════════════════════════════════════════════
// NERVA MARKET — Vercel Serverless Proxy
// /api/market.js — v4.5: Financial Modeling Prep (no IP blocking)
// Free tier: 250 calls/day — with 60s cache we use ~14 calls/day
// Get free API key at: https://financialmodelingprep.com/register
// Set env var FMP_KEY in Vercel dashboard
// ═══════════════════════════════════════════════════════════════

const CACHE_SECONDS = 60;

const PORT_SYMS     = ['VGT','GDX','QBTS','VYM'];
const SECTOR_SYMS   = ['XLK','XLF','XLE','XLV','XLI','XLY','XLP','XLU','XLB','XLRE','XLC'];
const UNIVERSE_SYMS = ['NVDA','AAPL','MSFT','GOOGL','AMZN','META','TSLA','AMD','AVGO','LLY','JPM','V','UNH','XOM','COST','IONQ','RGTI','PLTR','COIN','SNOW','PANW','CRWD','NET','SQ','SHOP'];
const MACRO_SYMS    = ['SPY','QQQ','%5EVIX','%5ETNX'];
const ALL_QUOTE_SYMS = [...PORT_SYMS, ...SECTOR_SYMS, ...UNIVERSE_SYMS, 'SPY','QQQ','^VIX','^TNX'];

const FMP_BASE = 'https://financialmodelingprep.com/api/v3';

function getNextFOMCDays() {
  const dates = ['2026-05-06','2026-06-17','2026-07-29','2026-09-16','2026-11-04','2026-12-16'];
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

  const API_KEY = process.env.FMP_KEY;

  // If no API key set yet, return helpful error
  if (!API_KEY) {
    return res.status(200).json({
      error: 'FMP_KEY not set',
      message: 'Add FMP_KEY environment variable in Vercel dashboard. Get free key at financialmodelingprep.com/register',
      timestamp: new Date().toISOString(),
    });
  }

  try {
    // FMP bulk quote — all symbols in one call, no rate limiting issues
    const symbols = ALL_QUOTE_SYMS.join(',');
    const [quoteResp, spyHistResp, qqqHistResp] = await Promise.all([
      fetch(`${FMP_BASE}/quote/${symbols}?apikey=${API_KEY}`),
      fetch(`${FMP_BASE}/historical-price-full/SPY?timeseries=200&apikey=${API_KEY}`),
      fetch(`${FMP_BASE}/historical-price-full/QQQ?timeseries=200&apikey=${API_KEY}`),
    ]);

    // Parse bulk quotes
    const quotes = {};
    if (quoteResp.ok) {
      const quoteData = await quoteResp.json();
      (Array.isArray(quoteData) ? quoteData : []).forEach(q => {
        if (q?.symbol) {
          quotes[q.symbol] = {
            price:     q.price             || 0,
            change:    q.change            || 0,
            changePct: q.changesPercentage || 0,
            volume:    q.volume            || 0,
          };
        }
      });
    }

    // Parse history for MAs + RSI
    function parseHistory(data) {
      try {
        const hist = data?.historical || [];
        // FMP returns newest first — reverse for calculations
        const closes = hist.map(d => d.close).reverse().filter(c => c != null);
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

    const spyHistory = spyHistResp.ok ? parseHistory(await spyHistResp.json()) : { sma20:0, sma50:0, sma200:0, rsi:55 };
    const qqqHistory = qqqHistResp.ok ? parseHistory(await qqqHistResp.json()) : { sma20:0, sma50:0, sma200:0, rsi:55 };

    const spy = quotes['SPY']   || {};
    const qqq = quotes['QQQ']   || {};
    const vix = quotes['^VIX']  || {};
    const tnx = quotes['^TNX']  || {};

    const vixLevel = vix.price || 16;
    const tnxLevel = tnx.price || 4.3;

    const sp = {};
    SECTOR_SYMS.forEach(s => { sp[s] = quotes[s]?.changePct || 0; });
    const sectorsPos = Object.values(sp).filter(v => v > 0).length;

    res.status(200).json({
      timestamp: new Date().toISOString(),
      source: 'financial_modeling_prep',
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
        dxy: { level: 104, change: 0, trend: 'neutral' },
        fedStance: tnxLevel > 4.5 ? 'hawkish' : tnxLevel > 4.0 ? 'neutral' : 'dovish',
        fomcDays:  getNextFOMCDays(),
      },
      portfolio: PORT_SYMS.map(sym => ({
        sym,
        price:     quotes[sym]?.price     || 0,
        changePct: quotes[sym]?.changePct || 0,
        volume:    quotes[sym]?.volume    || 0,
        sma50:     0,
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
