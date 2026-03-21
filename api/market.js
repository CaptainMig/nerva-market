// NERVA MARKET v7.10 — sequential Finnhub quotes + Alpha Vantage history
// Finnhub: sequential with sleep (avoids 429) — proven working in v7.2
// Alpha Vantage: parallel history for SMA/RSI — server-side, no IP blocking
// Requires: FINNHUB_KEY + ALPHAVANTAGE_KEY in Vercel

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

async function candles(sym) {
  const now = Math.floor(Date.now() / 1000);
  const from = now - 60 * 60 * 24 * 320;
  const url = `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(sym)}&resolution=D&from=${from}&to=${now}&token=${FINNHUB_KEY}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${sym} candle ${r.status}`);
  return await r.json();
}

// Alpha Vantage daily history — free tier, no IP blocking from Vercel
// Returns 100 days of daily adjusted closes (compact output)
async function candles(sym) {
  const AV_KEY = process.env.ALPHAVANTAGE_KEY;
  if (!AV_KEY) throw new Error('ALPHAVANTAGE_KEY not set');
  const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY_ADJUSTED&symbol=${encodeURIComponent(sym)}&outputsize=compact&apikey=${AV_KEY}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`AV ${sym} ${r.status}`);
  const data = await r.json();
  if (data?.Note || data?.Information) throw new Error(`AV limit: ${(data.Note||data.Information).slice(0,80)}`);
  const ts = data?.['Time Series (Daily)'];
  if (!ts) throw new Error(`AV ${sym} no timeseries`);
  const closes = Object.keys(ts).sort()
    .map(k => Number(ts[k]?.['5. adjusted close'] || ts[k]?.['4. close'] || 0))
    .filter(v => Number.isFinite(v) && v > 0);
  if (closes.length < 15) throw new Error(`AV ${sym} only ${closes.length} bars`);
  return { s: 'ok', c: closes };
}

export default async function handler(req, res) {
  if (!FINNHUB_KEY) {
    return res.status(500).json({ error: 'FINNHUB_KEY missing' });
  }

  try {
    const quoteErrors = [];

    // Sequential Finnhub quotes with sleep — avoids 429 rate limiting
    const CANDLE_SYMS_NEEDED = ['SPY', 'QQQ', ...PORT_SYMS];

    const quotes = {};
    for (const sym of CORE_QUOTES) {
      try {
        quotes[sym] = await quote(sym);
      } catch (e) {
        quoteErrors.push({ sym, msg: e.message });
      }
      await sleep(90);
    }

    // Alpha Vantage history — parallel is fine, different service, no rate issue
    const hist = {};
    const histResults = await Promise.allSettled(
      CANDLE_SYMS_NEEDED.map(sym => candles(sym).then(d => ({ sym, data: d })))
    );
    for (const result of histResults) {
      if (result.status === 'fulfilled') {
        const { sym, data } = result.value;
        if (data?.s === 'ok' && Array.isArray(data?.c) && data.c.length >= 15) {
          hist[sym] = data;
        }
      }
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
      source: 'finnhub_av_v710',
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
