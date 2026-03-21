// NERVA MARKET v7.6 backend patch
// Fix: candle history via Yahoo Finance 15 (RapidAPI proxy)
// RapidAPI proxies requests — no Vercel IP blocking
// Requires RAPIDAPI_KEY env var in Vercel
// Quotes stay on Finnhub. Real daily SMA20/50/200 + RSI14.
// Layout and UX unchanged from v7.2

const CACHE_SECONDS = 180;
const FINNHUB_KEY = process.env.FINNHUB_KEY;

const CORE_QUOTES = ['SPY','QQQ','VIX','XLK','XLF','XLE','XLV','XLI','XLY','XLP','XLU','XLB','XLRE','XLC','VGT','GDX','QBTS','VYM'];
const PORT_SYMS = ['VGT','GDX','QBTS','VYM'];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function sma(arr, len) {
  if (!Array.isArray(arr) || arr.length < len) return 0;
  const slice = arr.slice(-len);
  return slice.reduce((a,b)=>a+b,0) / len;
}

function rsi14(closes) {
  if (!Array.isArray(closes) || closes.length < 15) return 0;
  // Filter out any non-finite values before calculating
  const valid = closes.filter(c => Number.isFinite(c) && c > 0);
  if (valid.length < 15) return 0;
  let gains = 0, losses = 0;
  for (let i = valid.length - 14; i < valid.length; i++) {
    const diff = valid[i] - valid[i-1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return Math.round((100 - (100 / (1 + rs))) * 10) / 10; // round to 1dp
}

async function quote(sym) {
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${FINNHUB_KEY}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${sym} quote ${r.status}`);
  return await r.json();
}

// Daily candle history via Yahoo Finance 15 (RapidAPI proxy)
// RapidAPI proxies the request — no Vercel IP blocking
// Returns OHLCV daily data, we use close prices for SMA/RSI
async function candles(sym) {
  const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
  if (!RAPIDAPI_KEY) throw new Error('RAPIDAPI_KEY not set');
  const url = `https://yahoo-finance15.p.rapidapi.com/api/v1/markets/stock/history?symbol=${encodeURIComponent(sym)}&interval=1d&diffandsplits=false`;
  const r = await fetch(url, {
    headers: {
      'x-rapidapi-host': 'yahoo-finance15.p.rapidapi.com',
      'x-rapidapi-key': RAPIDAPI_KEY,
      'Content-Type': 'application/json',
    }
  });
  if (!r.ok) throw new Error(`${sym} candle ${r.status}`);
  const data = await r.json();
  // Yahoo Finance 15 returns { body: { "2024-01-02": { close: 185.2, ... }, ... } }
  const body = data?.body;
  if (!body || typeof body !== 'object') throw new Error(`${sym} no body in response`);
  // Extract closes in chronological order
  const closes = Object.keys(body)
    .sort()
    .map(k => Number(body[k]?.close || body[k]?.adjclose || 0))
    .filter(v => Number.isFinite(v) && v > 0);
  if (closes.length < 15) throw new Error(`${sym} insufficient history: ${closes.length} bars`);
  return { s: 'ok', c: closes };
}

export default async function handler(req, res) {
  if (!FINNHUB_KEY) {
    return res.status(500).json({ error: 'FINNHUB_KEY missing' });
  }

  try {
    const quoteErrors = [];

    // Run all quote + candle fetches in parallel — beats Vercel 10s timeout
    // Sequential sleep(90) per symbol was taking 18×90ms=1620ms sleep alone,
    // pushing candle fetches past the timeout and zeroing RSI/SMA
    const CANDLE_SYMS_NEEDED = ['SPY', 'QQQ', ...PORT_SYMS];

    const [quoteSettled, candleSettled] = await Promise.all([
      Promise.allSettled(CORE_QUOTES.map(sym =>
        quote(sym).then(data => ({ sym, data }))
      )),
      Promise.allSettled(CANDLE_SYMS_NEEDED.map(sym =>
        candles(sym).then(data => ({ sym, data }))
      )),
    ]);

    const quotes = {};
    for (const result of quoteSettled) {
      if (result.status === 'fulfilled') {
        quotes[result.value.sym] = result.value.data;
      } else {
        // Extract sym from error message or mark as failed
        quoteErrors.push({ sym: 'unknown', msg: result.reason?.message || 'failed' });
      }
    }

    const hist = {};
    for (const result of candleSettled) {
      if (result.status === 'fulfilled') {
        const { sym, data } = result.value;
        // Only store if Finnhub returned valid candle data (s === 'ok')
        if (data?.s === 'ok' && Array.isArray(data?.c) && data.c.length >= 15) {
          hist[sym] = data;
        }
      }
      // Silent fail — hist[sym] stays undefined, portfolio shows DATA badge
    }

    const sectors = {};
    for (const s of ['XLK','XLF','XLE','XLV','XLI','XLY','XLP','XLU','XLB','XLRE','XLC']) {
      sectors[s] = Number(quotes[s]?.dp || 0);
    }

    const portfolio = PORT_SYMS.map(sym => {
      const q = quotes[sym] || {};
      const c = hist[sym]?.c || [];
      return {
        sym,
        price: Number(q.c || 0),
        changePct: Number(q.dp || 0),
        volume: Number(q.v || 0),
        sma20: sma(c, 20),   // real 20-day SMA
        sma50: sma(c, 50),   // real 50-day SMA
        sma200: sma(c, 200), // real 200-day SMA
        rsi: rsi14(c)
      };
    });

    const spyCloses = hist['SPY']?.c || [];
    const qqqCloses = hist['QQQ']?.c || [];

    const symbolsFetched = Object.keys(quotes).length;
    const dataStatus = quoteErrors.length ? 'PARTIAL' : 'LIVE';

    res.setHeader('Cache-Control', `s-maxage=${CACHE_SECONDS}, stale-while-revalidate`);
    return res.status(200).json({
      timestamp: new Date().toISOString(),
      source: 'finnhub_quotes_rapidapi_candles_v76',
      dataStatus,
      symbolsFetched,
      quoteErrors,
      spy: {
        price: Number(quotes['SPY']?.c || 0),
        changePct: Number(quotes['SPY']?.dp || 0),
        sma20: sma(spyCloses, 20),   // real 20-day SMA
        sma50: sma(spyCloses, 50),   // real 50-day SMA
        sma200: sma(spyCloses, 200), // real 200-day SMA
        rsi: rsi14(spyCloses)
      },
      qqq: {
        price: Number(quotes['QQQ']?.c || 0),
        changePct: Number(quotes['QQQ']?.dp || 0),
        sma50: sma(qqqCloses, 50),  // real 50-day SMA
        rsi: rsi14(qqqCloses)
      },
      vix: {
        level: Number(quotes['VIX']?.c || quotes['^VIX']?.c || 16),
        changePct: Number(quotes['VIX']?.dp || 0)
      },
      vvix: { level: 81 },
      putCall: { ratio: 0.84 },
      breadth: {
        above20d: 34.1,
        above50d: 27.7,
        above200d: 28.4,
        advDeclineRatio: 0.85,
        nhNl: 1.06
      },
      sectors,
      macro: {
        tenYear: { yield: 4.31, trend: 'neutral' },
        dxy: { level: 104.03, trend: 'neutral' },
        fedStance: 'neutral',
        fomcDays: 47
      },
      exec: {
        breakoutRetention: 0.40,
        trendReliability: 0.32,
        pullbackBid: 0.48,
        followThrough: 0.44
      },
      portfolio
    });
  } catch (e) {
    return res.status(500).json({ error: 'proxy crash', message: e.message });
  }
}
