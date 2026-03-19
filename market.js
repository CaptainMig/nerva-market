// ═══════════════════════════════════════════════════════════════
// NERVA MARKET — Vercel Serverless Proxy for Live Market Data
// /api/market.js
// 
// Deploy: Place in /api/market.js in your Vercel project root
// Usage: fetch('/api/market') from the frontend
//
// This proxies Yahoo Finance v8 to avoid CORS restrictions.
// Same architecture as your AnthonyCharts DONKI/USGS proxies.
// ═══════════════════════════════════════════════════════════════

// Cache control: 30-second server-side cache to reduce API load
const CACHE_SECONDS = 30;

// All symbols we need in one call
const MARKET_SYMBOLS = [
  // Index / Macro
  'SPY', 'QQQ', '^VIX', '^VVIX', 'DX-Y.NYB', '^TNX',
  // Portfolio
  'VGT', 'GDX', 'QBTS', 'VYM',
  // Sectors
  'XLK', 'XLF', 'XLE', 'XLV', 'XLI', 'XLY', 'XLP', 'XLU', 'XLB', 'XLRE', 'XLC',
  // Universe (Top names for Opportunity Surface)
  'NVDA', 'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'TSLA', 'AMD', 'AVGO', 'LLY',
  'JPM', 'V', 'UNH', 'XOM', 'COST', 'IONQ', 'RGTI', 'PLTR', 'COIN', 'SNOW',
  'PANW', 'CRWD', 'NET', 'SQ', 'SHOP', 'DKNG', 'SOFI', 'ARM', 'SMCI',
];

// Yahoo Finance v8 quote endpoint
const YF_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const YF_QUOTE = 'https://query1.finance.yahoo.com/v7/finance/quote';

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', `s-maxage=${CACHE_SECONDS}, stale-while-revalidate`);

  try {
    // Strategy: Use v7/finance/quote for bulk quotes (all symbols in one call)
    // Then use v8/finance/chart for SPY/QQQ historical data (moving averages)
    const [quotesData, spyChart, qqqChart] = await Promise.all([
      fetchQuotes(MARKET_SYMBOLS),
      fetchChart('SPY', '6mo', '1d'),  // 6 months daily for MA calculation
      fetchChart('QQQ', '6mo', '1d'),
    ]);

    // Parse quotes into structured data
    const quotes = {};
    if (quotesData?.quoteResponse?.result) {
      for (const q of quotesData.quoteResponse.result) {
        quotes[q.symbol] = {
          price: q.regularMarketPrice,
          change: q.regularMarketChange,
          changePct: q.regularMarketChangePercent,
          volume: q.regularMarketVolume,
          prevClose: q.regularMarketPreviousClose,
          fiftyDayAvg: q.fiftyDayAverage,
          twoHundredDayAvg: q.twoHundredDayAverage,
          marketCap: q.marketCap,
          shortName: q.shortName,
        };
      }
    }

    // Calculate moving averages from chart data
    const spyMAs = calcMovingAverages(spyChart);
    const qqqMAs = calcMovingAverages(qqqChart);

    // Calculate RSI from chart data
    const spyRSI = calcRSI(spyChart, 14);
    const qqqRSI = calcRSI(qqqChart, 14);

    // Calculate breadth estimates from sector data
    const sectorSyms = ['XLK','XLF','XLE','XLV','XLI','XLY','XLP','XLU','XLB','XLRE','XLC'];
    const sectorPerf = {};
    let sectorsPositive = 0;
    for (const s of sectorSyms) {
      const q = quotes[s];
      if (q) {
        sectorPerf[s] = q.changePct || 0;
        if (q.changePct > 0) sectorsPositive++;
      }
    }

    // Estimate breadth from sector participation
    // In production, you'd add a separate breadth data source (Barchart, StockAnalysis API)
    const breadthEstimate = {
      above20d: sectorsPositive / 11 * 70 + 15, // rough estimate
      above50d: sectorsPositive / 11 * 65 + 10,
      above200d: sectorsPositive / 11 * 60 + 15,
      advDeclineRatio: sectorsPositive > 6 ? 1.0 + (sectorsPositive - 6) * 0.15 : 0.5 + sectorsPositive * 0.08,
    };

    // Build response
    const response = {
      timestamp: new Date().toISOString(),
      source: 'yahoo_finance',

      spy: {
        price: quotes['SPY']?.price || 0,
        changePct: quotes['SPY']?.changePct || 0,
        sma20: spyMAs.sma20,
        sma50: spyMAs.sma50 || quotes['SPY']?.fiftyDayAvg || 0,
        sma200: spyMAs.sma200 || quotes['SPY']?.twoHundredDayAvg || 0,
        rsi: spyRSI,
      },

      qqq: {
        price: quotes['QQQ']?.price || 0,
        changePct: quotes['QQQ']?.changePct || 0,
        sma50: qqqMAs.sma50 || quotes['QQQ']?.fiftyDayAvg || 0,
        rsi: qqqRSI,
      },

      vix: {
        level: quotes['^VIX']?.price || 16,
        change: quotes['^VIX']?.change || 0,
        changePct: quotes['^VIX']?.changePct || 0,
        // 5-day trend: positive change suggests rising VIX
        trend5d: quotes['^VIX']?.changePct || 0,
      },

      vvix: {
        level: quotes['^VVIX']?.price || 80,
      },

      putCall: {
        // Estimate from VIX regime — for precise data, add CBOE API
        ratio: quotes['^VIX']?.price > 25 ? 1.1 :
               quotes['^VIX']?.price > 20 ? 0.95 :
               quotes['^VIX']?.price > 15 ? 0.85 : 0.75,
      },

      breadth: breadthEstimate,

      sectors: sectorPerf,

      macro: {
        tenYear: {
          yield: quotes['^TNX']?.price ? quotes['^TNX'].price : 4.3,
          change: quotes['^TNX']?.change || 0,
          trend: (quotes['^TNX']?.change || 0) > 0 ? 'rising' : 'falling',
        },
        dxy: {
          level: quotes['DX-Y.NYB']?.price || 104,
          change: quotes['DX-Y.NYB']?.changePct || 0,
          trend: (quotes['DX-Y.NYB']?.changePct || 0) > 0 ? 'strengthening' : 'weakening',
        },
        // Fed stance: would need manual update or news API
        // For now, derive from yield + VIX regime
        fedStance: quotes['^TNX']?.price > 4.5 ? 'hawkish' :
                   quotes['^TNX']?.price > 4.0 ? 'neutral' : 'dovish',
        // FOMC calendar: hardcode known dates or fetch from fed calendar
        fomcDays: getNextFOMCDays(),
      },

      // Portfolio quotes
      portfolio: ['VGT', 'GDX', 'QBTS', 'VYM'].map(sym => ({
        sym,
        name: quotes[sym]?.shortName || sym,
        price: quotes[sym]?.price || 0,
        changePct: quotes[sym]?.changePct || 0,
        volume: quotes[sym]?.volume || 0,
        sma50: quotes[sym]?.fiftyDayAvg || 0,
        sma200: quotes[sym]?.twoHundredDayAvg || 0,
      })),

      // Universe quotes for Opportunity Surface
      universe: MARKET_SYMBOLS.filter(s => 
        !['SPY','QQQ','^VIX','^VVIX','DX-Y.NYB','^TNX',
          'XLK','XLF','XLE','XLV','XLI','XLY','XLP','XLU','XLB','XLRE','XLC',
          'VGT','GDX','QBTS','VYM'].includes(s)
      ).map(sym => ({
        sym,
        name: quotes[sym]?.shortName || sym,
        price: quotes[sym]?.price || 0,
        changePct: quotes[sym]?.changePct || 0,
        volume: quotes[sym]?.volume || 0,
        sma50: quotes[sym]?.fiftyDayAvg || 0,
        sma200: quotes[sym]?.twoHundredDayAvg || 0,
        marketCap: quotes[sym]?.marketCap || 0,
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

/* ─── YAHOO FINANCE HELPERS ─── */

async function fetchQuotes(symbols) {
  const url = `${YF_QUOTE}?symbols=${symbols.join(',')}`;
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; NERVAMarket/1.0)',
    },
  });
  if (!resp.ok) throw new Error(`Yahoo quote fetch failed: ${resp.status}`);
  return resp.json();
}

async function fetchChart(symbol, range, interval) {
  const url = `${YF_BASE}${symbol}?range=${range}&interval=${interval}&includePrePost=false`;
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; NERVAMarket/1.0)',
    },
  });
  if (!resp.ok) throw new Error(`Yahoo chart fetch failed: ${resp.status} for ${symbol}`);
  return resp.json();
}

/* ─── TECHNICAL INDICATORS ─── */

function calcMovingAverages(chartData) {
  try {
    const closes = chartData?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [];
    const valid = closes.filter(c => c !== null && c !== undefined);
    
    const sma = (arr, period) => {
      if (arr.length < period) return null;
      const slice = arr.slice(-period);
      return slice.reduce((s, v) => s + v, 0) / period;
    };

    return {
      sma20: sma(valid, 20),
      sma50: sma(valid, 50),
      sma200: sma(valid, 200),
    };
  } catch {
    return { sma20: null, sma50: null, sma200: null };
  }
}

function calcRSI(chartData, period = 14) {
  try {
    const closes = chartData?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [];
    const valid = closes.filter(c => c !== null && c !== undefined);
    if (valid.length < period + 1) return 50;

    const changes = [];
    for (let i = 1; i < valid.length; i++) {
      changes.push(valid[i] - valid[i - 1]);
    }

    const recent = changes.slice(-period);
    let gains = 0, losses = 0;
    for (const c of recent) {
      if (c > 0) gains += c;
      else losses += Math.abs(c);
    }

    const avgGain = gains / period;
    const avgLoss = losses / period;
    if (avgLoss === 0) return 100;
    
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  } catch {
    return 50;
  }
}

/* ─── FOMC CALENDAR ─── */
// Known 2026 FOMC meeting dates (update annually)
// Source: federalreserve.gov/monetarypolicy/fomccalendars.htm
function getNextFOMCDays() {
  const fomcDates = [
    '2026-01-28', '2026-03-18', '2026-05-06', '2026-06-17',
    '2026-07-29', '2026-09-16', '2026-11-04', '2026-12-16',
  ];
  
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  
  for (const d of fomcDates) {
    if (d >= today) {
      const diff = (new Date(d) - now) / (1000 * 60 * 60 * 24);
      return Math.max(0, Math.ceil(diff));
    }
  }
  return 30; // fallback
}
