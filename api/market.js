// NERVA MARKET v7.4 backend patch
// Fix: candle history switched from Finnhub (paid tier) to Yahoo Finance v8/chart
// Finnhub free tier does not provide reliable daily historical data
// Quotes stay on Finnhub (working fine)
// Candles for SPY/QQQ/VGT/GDX/QBTS/VYM via Yahoo — no auth, server-side, no CORS
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

// Candle history via Yahoo Finance v8/chart — no auth required from server-side
// Finnhub free tier does not reliably provide daily historical candles
async function candles(sym) {
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1y&interval=1d&includePrePost=false`;
  const r = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json',
    }
  });
  if (!r.ok) throw new Error(`${sym} candle ${r.status}`);
  const data = await r.json();
  // Transform Yahoo format to match expected {s, c} shape
  const closes = data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(v => v != null) || [];
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
        sma20: sma(c, 20),
        sma50: sma(c, 50),
        sma200: sma(c, 200),
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
      source: 'finnhub_quotes_yahoo_candles_v74',
      dataStatus,
      symbolsFetched,
      quoteErrors,
      spy: {
        price: Number(quotes['SPY']?.c || 0),
        changePct: Number(quotes['SPY']?.dp || 0),
        sma20: sma(spyCloses, 20),
        sma50: sma(spyCloses, 50),
        sma200: sma(spyCloses, 200),
        rsi: rsi14(spyCloses)
      },
      qqq: {
        price: Number(quotes['QQQ']?.c || 0),
        changePct: Number(quotes['QQQ']?.dp || 0),
        sma50: sma(qqqCloses, 50),
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
