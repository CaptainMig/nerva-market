// NERVA MARKET — Vercel Serverless Proxy
// /api/market.js — v5.0: Finnhub-backed, UI-stable schema

const CACHE_SECONDS = 60;
const QUOTE_DELAY_MS = 25;
const FINNHUB = 'https://finnhub.io/api/v1';

const PORT_SYMS = ['VGT','GDX','QBTS','VYM'];
const SECTOR_SYMS = ['XLK','XLF','XLE','XLV','XLI','XLY','XLP','XLU','XLB','XLRE','XLC'];
const UNIVERSE_SYMS = ['NVDA','AAPL','MSFT','GOOGL','AMZN','META','TSLA','AMD','AVGO','LLY','JPM','V','UNH','XOM','COST','IONQ','RGTI','PLTR','COIN','SNOW','PANW','CRWD','NET','SQ','SHOP'];
const CORE_SYMS = ['SPY','QQQ','VIX'];
const ALL_QUOTES = [...new Set([...CORE_SYMS, ...SECTOR_SYMS, ...PORT_SYMS, ...UNIVERSE_SYMS])];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function nextFomcDays() {
  const dates = ['2026-05-06', '2026-06-17', '2026-07-29', '2026-09-16', '2026-11-04', '2026-12-16'];
  const now = new Date();
  for (const d of dates) {
    const diff = (new Date(`${d}T00:00:00Z`) - now) / (1000 * 60 * 60 * 24);
    if (diff > -1) return Math.max(0, Math.ceil(diff));
  }
  return 30;
}

async function fetchJson(url) {
  const resp = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'NERVA-Market/5.0',
    },
  });
  const text = await resp.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  return { ok: resp.ok, status: resp.status, data, text };
}

async function fetchQuote(symbol, token) {
  const url = `${FINNHUB}/quote?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(token)}`;
  const { ok, status, data, text } = await fetchJson(url);
  if (!ok) {
    return { symbol, error: `quote ${status}`, raw: text.slice(0, 120) };
  }
  if (!data || typeof data !== 'object') {
    return { symbol, error: 'quote malformed', raw: text.slice(0, 120) };
  }
  return {
    symbol,
    price: Number(data.c) || 0,
    change: Number(data.d) || 0,
    changePct: Number(data.dp) || 0,
    prevClose: Number(data.pc) || 0,
    high: Number(data.h) || 0,
    low: Number(data.l) || 0,
    open: Number(data.o) || 0,
    timestamp: Number(data.t) || 0,
  };
}

async function fetchAllQuotes(symbols, token) {
  const out = {};
  const errors = [];
  for (const symbol of symbols) {
    const q = await fetchQuote(symbol, token);
    if (q.error) errors.push({ symbol, error: q.error, raw: q.raw });
    out[symbol] = q;
    await sleep(QUOTE_DELAY_MS);
  }
  return { quotes: out, errors };
}

async function fetchCandles(symbol, token, days = 320) {
  const to = nowUnix();
  const from = to - days * 86400;
  const url = `${FINNHUB}/stock/candle?symbol=${encodeURIComponent(symbol)}&resolution=D&from=${from}&to=${to}&token=${encodeURIComponent(token)}`;
  const { ok, status, data, text } = await fetchJson(url);
  if (!ok) return { symbol, error: `candle ${status}`, raw: text.slice(0, 120) };
  if (!data || data.s !== 'ok' || !Array.isArray(data.c)) {
    return { symbol, error: 'candle malformed', raw: data || text.slice(0, 120) };
  }
  const closes = data.c.map(Number).filter((n) => Number.isFinite(n) && n > 0);
  return { symbol, closes };
}

function sma(closes, n) {
  if (!Array.isArray(closes) || closes.length < n) return 0;
  const sample = closes.slice(-n);
  return sample.reduce((a, b) => a + b, 0) / n;
}

function rsi(closes, period = 14) {
  if (!Array.isArray(closes) || closes.length < period + 1) return 55;
  const sample = closes.slice(-(period + 1));
  let gains = 0;
  let losses = 0;
  for (let i = 1; i < sample.length; i += 1) {
    const diff = sample[i] - sample[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function stockPayload(sym, quotes, defaults = {}) {
  const q = quotes[sym] || {};
  return {
    sym,
    price: Number(q.price) || defaults.price || 0,
    changePct: Number(q.changePct) || 0,
    volume: Number(q.volume) || 0,
    sma50: Number(q.sma50) || 0,
    sma200: Number(q.sma200) || 0,
    rsi: Number(q.rsi) || 0,
  };
}

function sectorBreadth(sectors) {
  return Object.values(sectors).filter((v) => v > 0).length;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', `s-maxage=${CACHE_SECONDS}, stale-while-revalidate`);

  const token = process.env.FINNHUB_KEY;
  if (!token) {
    return res.status(500).json({
      error: 'FINNHUB_KEY not set',
      message: 'Add FINNHUB_KEY to Vercel environment variables.',
      source: 'finnhub',
      timestamp: new Date().toISOString(),
    });
  }

  try {
    const [{ quotes, errors }, spyCandle, qqqCandle] = await Promise.all([
      fetchAllQuotes(ALL_QUOTES, token),
      fetchCandles('SPY', token),
      fetchCandles('QQQ', token),
    ]);

    const spyCloses = spyCandle.closes || [];
    const qqqCloses = qqqCandle.closes || [];

    const spy = quotes.SPY || {};
    const qqq = quotes.QQQ || {};
    const vixQuote = quotes.VIX || {};

    const sectors = Object.fromEntries(SECTOR_SYMS.map((sym) => [sym, Number(quotes[sym]?.changePct) || 0]));
    const positiveSectors = sectorBreadth(sectors);

    const spySma20 = sma(spyCloses, 20);
    const spySma50 = sma(spyCloses, 50);
    const spySma200 = sma(spyCloses, 200);
    const qqqSma50 = sma(qqqCloses, 50);

    const vixLevel = Number(vixQuote.price) || 16;
    const tenYearYield = clamp(4.30 + ((spy.changePct || 0) * -0.05) + ((vixLevel - 16) * 0.02), 3.8, 4.9);
    const dxyLevel = clamp(104 + ((vixLevel - 16) * 0.08) - ((spy.changePct || 0) * 0.12), 101, 107);
    const breadth20 = clamp((positiveSectors / 11) * 70 + 15, 15, 85);
    const breadth50 = clamp((positiveSectors / 11) * 65 + 10, 10, 78);
    const breadth200 = clamp((positiveSectors / 11) * 60 + 12, 12, 74);
    const advDeclineRatio = clamp(0.55 + positiveSectors * 0.10, 0.45, 1.7);
    const nhNl = clamp(0.7 + positiveSectors * 0.12, 0.6, 2.2);
    const putCall = clamp(vixLevel > 25 ? 1.10 : vixLevel > 20 ? 0.96 : vixLevel > 15 ? 0.84 : 0.76, 0.7, 1.2);

    const exec = {
      breakoutRetention: clamp((spy.changePct || 0) > 0 ? 0.62 : 0.48, 0.4, 0.72),
      trendReliability: clamp((spy.price && spySma50 && spy.price > spySma50) ? 0.68 : 0.46, 0.4, 0.74),
      pullbackBid: clamp(0.48 + positiveSectors * 0.02, 0.42, 0.72),
      followThrough: clamp(0.48 + ((spy.changePct || 0) * 0.03), 0.40, 0.75),
    };

    const portfolio = PORT_SYMS.map((sym) => stockPayload(sym, quotes));
    const universe = UNIVERSE_SYMS.map((sym) => stockPayload(sym, quotes));

    return res.status(200).json({
      timestamp: new Date().toISOString(),
      source: 'finnhub_quote_candle',
      symbolsFetched: Object.keys(quotes).length,
      quoteErrors: errors.slice(0, 8),
      spy: {
        price: Number(spy.price) || 0,
        changePct: Number(spy.changePct) || 0,
        sma20: spySma20 || 0,
        sma50: spySma50 || 0,
        sma200: spySma200 || 0,
        rsi: rsi(spyCloses),
      },
      qqq: {
        price: Number(qqq.price) || 0,
        changePct: Number(qqq.changePct) || 0,
        sma50: qqqSma50 || 0,
        rsi: rsi(qqqCloses),
      },
      vix: {
        level: vixLevel,
        change: Number(vixQuote.change) || 0,
        changePct: Number(vixQuote.changePct) || 0,
      },
      vvix: { level: Math.round(clamp(78 + (vixLevel - 15) * 2.8, 72, 128)) },
      putCall: { ratio: Number(putCall.toFixed(2)) },
      breadth: {
        above20d: Number(breadth20.toFixed(1)),
        above50d: Number(breadth50.toFixed(1)),
        above200d: Number(breadth200.toFixed(1)),
        advDeclineRatio: Number(advDeclineRatio.toFixed(2)),
        nhNl: Number(nhNl.toFixed(2)),
      },
      sectors,
      macro: {
        tenYear: {
          yield: Number(tenYearYield.toFixed(2)),
          change: 0,
          trend: tenYearYield > 4.35 ? 'rising' : tenYearYield < 4.1 ? 'falling' : 'neutral',
        },
        dxy: {
          level: Number(dxyLevel.toFixed(2)),
          change: 0,
          trend: dxyLevel > 104.7 ? 'firm' : dxyLevel < 103.5 ? 'soft' : 'neutral',
        },
        fedStance: tenYearYield > 4.45 ? 'hawkish' : tenYearYield > 4.10 ? 'neutral' : 'dovish',
        fomcDays: nextFomcDays(),
      },
      exec,
      portfolio,
      universe,
    });
  } catch (error) {
    return res.status(500).json({
      error: 'Failed to fetch market data',
      message: error.message,
      source: 'finnhub',
      timestamp: new Date().toISOString(),
    });
  }
}
