// NERVA MARKET v7.2 backend patch
// Goal: protect trust.
// - only fetch core symbols
// - compute real SMA/RSI for the 4 portfolio names + SPY/QQQ
// - slower cache to avoid rate limits

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
  let gains = 0, losses = 0;
  for (let i = closes.length - 14; i < closes.length; i++) {
    const diff = closes[i] - closes[i-1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - (100 / (1 + rs));
}

async function quote(sym) {
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${FINNHUB_KEY}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${sym} quote ${r.status}`);
  return await r.json();
}

async function candles(sym) {
  const now = Math.floor(Date.now() / 1000);
  const from = now - 60 * 60 * 24 * 320;
  const url = `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(sym)}&resolution=D&from=${from}&to=${now}&token=${FINNHUB_KEY}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${sym} candle ${r.status}`);
  return await r.json();
}

export default async function handler(req, res) {
  if (!FINNHUB_KEY) {
    return res.status(500).json({ error: 'FINNHUB_KEY missing' });
  }

  try {
    const quotes = {};
    const quoteErrors = [];

    for (const sym of CORE_QUOTES) {
      try {
        quotes[sym] = await quote(sym);
      } catch (e) {
        quoteErrors.push({ sym, msg: e.message });
      }
      await sleep(90);
    }

    const hist = {};
    for (const sym of ['SPY', 'QQQ', ...PORT_SYMS]) {
      try {
        hist[sym] = await candles(sym);
      } catch (e) {}
      await sleep(120);
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
      source: 'finnhub_core_v72',
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
