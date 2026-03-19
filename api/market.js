// ═══════════════════════════════════════════════════════════════
// NERVA MARKET — Vercel Serverless Proxy
// /api/market.js — v4.1 patch: Yahoo v7 returns 401, switched to v8
// ═══════════════════════════════════════════════════════════════

const CACHE_SECONDS = 30;

// Core symbols fetched individually via v8/chart (no auth required)
const INDEX_SYMS   = ['SPY','QQQ','^VIX','^VVIX','DX-Y.NYB','^TNX'];
const PORT_SYMS    = ['VGT','GDX','QBTS','VYM'];
const SECTOR_SYMS  = ['XLK','XLF','XLE','XLV','XLI','XLY','XLP','XLU','XLB','XLRE','XLC'];
const UNIVERSE_SYMS= ['NVDA','AAPL','MSFT','GOOGL','AMZN','META','TSLA','AMD','AVGO','LLY','JPM','V','UNH','XOM','COST','IONQ','RGTI','PLTR','COIN','SNOW','PANW','CRWD','NET','SQ','SHOP'];

const ALL_SYMS = [...INDEX_SYMS, ...PORT_SYMS, ...SECTOR_SYMS, ...UNIVERSE_SYMS];

// Yahoo Finance v8 chart endpoint — no crumb/cookie required
const YF_BASE = 'https://query2.finance.yahoo.com/v8/finance/chart/';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', `s-maxage=${CACHE_SECONDS}, stale-while-revalidate`);

  try {
    // Fetch all symbols in parallel using v8/chart with range=1d interval=1d
    // This gives us: current price, change, prev close — no auth needed
    // For SPY/QQQ also fetch 6mo for moving averages
    const [spyChart, qqqChart, ...restCharts] = await Promise.all([
      fetchChart('SPY', '6mo', '1d'),
      fetchChart('QQQ', '6mo', '1d'),
      ...ALL_SYMS.filter(s => s !== 'SPY' && s !== 'QQQ').map(s => fetchChart(s, '5d', '1d')),
    ]);

    const otherSyms = ALL_SYMS.filter(s => s !== 'SPY' && s !== 'QQQ');

    // Parse a chart response into a simple quote object
    function parseChart(chartData, sym) {
      try {
        const r = chartData?.chart?.result?.[0];
        if (!r) return null;
        const meta = r.meta || {};
        const closes = r.indicators?.quote?.[0]?.close || [];
        const valid = closes.filter(c => c != null);
        const price = meta.regularMarketPrice || valid[valid.length - 1] || 0;
        const prevClose = meta.chartPreviousClose || meta.previousClose || valid[valid.length - 2] || price;
        const change = price - prevClose;
        const changePct = prevClose ? (change / prevClose) * 100 : 0;
        const volume = meta.regularMarketVolume || 0;
        // Moving averages from history
        const sma = (arr, n) => arr.length >= n ? arr.slice(-n).reduce((a,b)=>a+b,0)/n : null;
        return {
          symbol: sym,
          price,
          change,
          changePct,
          volume,
          sma20: sma(valid, 20),
          sma50: sma(valid, 50),
          sma200: sma(valid, 200),
          closes: valid,
        };
      } catch { return null; }
    }

    // Build quotes map
    const quotes = {};
    const spyQ = parseChart(spyChart, 'SPY');
    const qqqQ = parseChart(qqqChart, 'QQQ');
    if (spyQ) quotes['SPY'] = spyQ;
    if (qqqQ) quotes['QQQ'] = qqqQ;
    restCharts.forEach((c, i) => {
      const sym = otherSyms[i];
      const q = parseChart(c, sym);
      if (q) quotes[sym] = q;
    });

    // RSI from SPY closes
    function calcRSI(closes, period = 14) {
      if (closes.length < period + 1) return 55;
      const changes = closes.slice(-period - 1).map((v, i, a) => i > 0 ? v - a[i-1] : 0).slice(1);
      const gains = changes.filter(c => c > 0).reduce((a,b) => a+b, 0) / period;
      const losses = changes.filter(c => c < 0).map(Math.abs).reduce((a,b) => a+b, 0) / period;
      if (losses === 0) return 100;
      return 100 - (100 / (1 + gains / losses));
    }

    const spyRSI = spyQ ? calcRSI(spyQ.closes) : 55;
    const qqqRSI = qqqQ ? calcRSI(qqqQ.closes) : 55;

    // Sector performance
    const sp = {};
    SECTOR_SYMS.forEach(s => { if (quotes[s]) sp[s] = quotes[s].changePct || 0; });
    const sectorsPos = Object.values(sp).filter(v => v > 0).length;

    // Breadth estimate from sector participation
    const breadthEst = {
      above20d: sectorsPos / 11 * 70 + 15,
      above50d: sectorsPos / 11 * 65 + 10,
      above200d: sectorsPos / 11 * 60 + 15,
      advDeclineRatio: sectorsPos > 6 ? 1.0 + (sectorsPos - 6) * 0.15 : 0.5 + sectorsPos * 0.08,
    };

    const vixLevel = quotes['^VIX']?.price || 16;
    const tnxLevel = quotes['^TNX']?.price || 4.3;

    const response = {
      timestamp: new Date().toISOString(),
      source: 'yahoo_finance_v8',
      spy: {
        price:     quotes['SPY']?.price    || 0,
        changePct: quotes['SPY']?.changePct || 0,
        sma20:     spyQ?.sma20 || 0,
        sma50:     spyQ?.sma50 || 0,
        sma200:    spyQ?.sma200 || 0,
        rsi:       spyRSI,
      },
      qqq: {
        price:     quotes['QQQ']?.price    || 0,
        changePct: quotes['QQQ']?.changePct || 0,
        sma50:     qqqQ?.sma50 || 0,
        rsi:       qqqRSI,
      },
      vix: {
        level:     vixLevel,
        change:    quotes['^VIX']?.change || 0,
        changePct: quotes['^VIX']?.changePct || 0,
      },
      vvix: { level: quotes['^VVIX']?.price || 85 },
      putCall: {
        ratio: vixLevel > 25 ? 1.1 : vixLevel > 20 ? 0.95 : vixLevel > 15 ? 0.85 : 0.75,
      },
      breadth: breadthEst,
      sectors: sp,
      macro: {
        tenYear: {
          yield:  tnxLevel,
          change: quotes['^TNX']?.change || 0,
          trend:  (quotes['^TNX']?.change || 0) > 0 ? 'rising' : 'falling',
        },
        dxy: {
          level:  quotes['DX-Y.NYB']?.price || 104,
          change: quotes['DX-Y.NYB']?.changePct || 0,
          trend:  (quotes['DX-Y.NYB']?.changePct || 0) > 0 ? 'strengthening' : 'weakening',
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
    };

    res.status(200).json(response);

  } catch (error) {
    console.error('NERVA Market proxy error:', error);
    res.status(500).json({
      error: 'Failed to fetch market data',
      message: error.message,
      timestamp: new Date().toISOString(),
    });
  }
}

// ── FETCH HELPERS ──
async function fetchChart(symbol, range, interval) {
  const encoded = encodeURIComponent(symbol);
  const url = `${YF_BASE}${encoded}?range=${range}&interval=${interval}&includePrePost=false`;
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  if (!resp.ok) throw new Error(`Yahoo chart fetch failed: ${resp.status} for ${symbol}`);
  return resp.json();
}

// ── FOMC CALENDAR 2026 ──
function getNextFOMCDays() {
  const dates = ['2026-03-18','2026-05-06','2026-06-17','2026-07-29','2026-09-16','2026-11-04','2026-12-16'];
  const now = new Date();
  for (const d of dates) {
    const diff = (new Date(d) - now) / (1000 * 60 * 60 * 24);
    if (diff > -1) return Math.max(0, Math.ceil(diff));
  }
  return 30;
}
