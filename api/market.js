// NERVA MARKET v6.5 — Finnhub proxy
// Env: FINNHUB_KEY

const CACHE_MS = 55000;
const QUOTE_TIMEOUT_MS = 4500;

const PORT_SYMS = ['VGT', 'GDX', 'QBTS', 'VYM'];
const CANDLE_SYMS = [...new Set(['SPY','QQQ', ...PORT_SYMS, 'RGTI', 'IONQ', 'PLTR', 'AMD', 'AVGO', 'NVDA'])];
const SECTOR_SYMS = ['XLK','XLF','XLE','XLV','XLI','XLY','XLP','XLU','XLB','XLRE','XLC'];
const UNIVERSE_SYMS = ['NVDA','AAPL','MSFT','GOOGL','AMZN','META','TSLA','AMD','AVGO','LLY','JPM','V','UNH','XOM','COST','IONQ','RGTI','PLTR','COIN','SNOW','PANW','CRWD','NET','XYZ','SHOP'];
const MACRO_SYMS = ['SPY','QQQ','VIX'];
const ALL_SYMS = [...new Set([...MACRO_SYMS, ...PORT_SYMS, ...SECTOR_SYMS, ...UNIVERSE_SYMS])];

let CACHE = { ts: 0, payload: null };

function timeoutSignal(ms) {
  return AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined;
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function pctFromQuote(q) {
  const current = num(q?.c, 0);
  const prev = num(q?.pc, 0);
  if (prev > 0 && current > 0) return ((current - prev) / prev) * 100;
  return num(q?.dp, 0);
}

async function fetchJson(url) {
  const resp = await fetch(url, { signal: timeoutSignal(QUOTE_TIMEOUT_MS) });
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { ok: resp.ok, status: resp.status, data };
}

async function fetchQuote(sym, key) {
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${key}`;
  const { ok, status, data } = await fetchJson(url);
  if (!ok || data?.error) {
    return { sym, ok: false, status, error: data?.error || `HTTP ${status}` };
  }
  return {
    sym,
    ok: true,
    price: num(data.c, 0),
    change: num(data.d, 0),
    changePct: pctFromQuote(data),
    prevClose: num(data.pc, 0),
    high: num(data.h, 0),
    low: num(data.l, 0),
    open: num(data.o, 0),
    ts: num(data.t, 0),
  };
}

async function fetchCandleMetrics(sym, key) {
  const now = Math.floor(Date.now() / 1000);
  const from = now - 3600 * 24 * 320;
  const url = `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(sym)}&resolution=D&from=${from}&to=${now}&token=${key}`;
  const { ok, status, data } = await fetchJson(url);
  if (!ok || data?.s !== 'ok' || !Array.isArray(data?.c)) {
    return { sym, ok: false, status, error: data?.error || `HTTP ${status}` };
  }
  const closes = data.c.map(Number).filter(Number.isFinite);
  const sma = (n) => closes.length >= n ? closes.slice(-n).reduce((a, b) => a + b, 0) / n : 0;
  const changePctNDays = (n) => {
    if (closes.length <= n) return 0;
    const prev = closes[closes.length - 1 - n];
    const cur = closes[closes.length - 1];
    return prev ? ((cur - prev) / prev) * 100 : 0;
  };
  const rsi = (() => {
    const p = 14;
    if (closes.length < p + 1) return 55;
    const slice = closes.slice(-(p + 1));
    let gains = 0;
    let losses = 0;
    for (let i = 1; i < slice.length; i++) {
      const d = slice[i] - slice[i - 1];
      if (d > 0) gains += d;
      else losses += Math.abs(d);
    }
    const avgGain = gains / p;
    const avgLoss = losses / p;
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  })();
  return {
    sym,
    ok: true,
    sma20: sma(20),
    sma50: sma(50),
    sma200: sma(200),
    rsi,
    chg5d: changePctNDays(5),
    chg20d: changePctNDays(20),
  };
}

function getNextFOMCDays() {
  const dates = ['2026-05-06','2026-06-17','2026-07-29','2026-09-16','2026-11-04','2026-12-16'];
  const now = new Date();
  for (const d of dates) {
    const diff = (new Date(d) - now) / (1000 * 60 * 60 * 24);
    if (diff > -1) return Math.max(0, Math.ceil(diff));
  }
  return 30;
}

function regimeFrom(spy, breadth, spread, vix) {
  const above50 = spy.price > spy.sma50;
  const above200 = spy.price > spy.sma200;
  const breadthStrong = breadth.above20d > 55 && breadth.advDeclineRatio > 1;
  const breadthWeak = breadth.above20d < 40 || breadth.advDeclineRatio < 0.9;
  if (above50 && above200 && breadthStrong && vix.level < 22) return 'Strong Uptrend';
  if (above50 && above200 && spread > 0) return 'Orderly Uptrend';
  if (!above50 && !above200 && breadthWeak) return 'Confirmed Downtrend';
  if (vix.level > 25 || spread < -0.7) return 'Stress / Distribution';
  return 'Chop / Transition';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=45, stale-while-revalidate');

  const key = process.env.FINNHUB_KEY;
  if (!key) {
    return res.status(500).json({ error: 'FINNHUB_KEY missing' });
  }

  const age = Date.now() - CACHE.ts;
  if (CACHE.payload && age < CACHE_MS) {
    return res.status(200).json({ ...CACHE.payload, cached: true, cacheAgeMs: age });
  }

  try {
    const quoteResults = await Promise.all(ALL_SYMS.map((sym) => fetchQuote(sym, key)));
    const candleResults = await Promise.all(CANDLE_SYMS.map((sym) => fetchCandleMetrics(sym, key)));

    const qMap = Object.fromEntries(quoteResults.filter((x) => x.ok).map((x) => [x.sym, x]));
    const cMap = Object.fromEntries(candleResults.filter((x) => x.ok).map((x) => [x.sym, x]));
    const quoteErrors = quoteResults.filter((x) => !x.ok).map(({ sym, status, error }) => ({ sym, status, error }));

    const spy = {
      price: num(qMap.SPY?.price, 0),
      changePct: num(qMap.SPY?.changePct, 0),
      sma20: num(cMap.SPY?.sma20, 0),
      sma50: num(cMap.SPY?.sma50, 0),
      sma200: num(cMap.SPY?.sma200, 0),
      rsi: num(cMap.SPY?.rsi, 55),
      chg5d: num(cMap.SPY?.chg5d, 0),
      chg20d: num(cMap.SPY?.chg20d, 0),
    };
    const qqq = {
      price: num(qMap.QQQ?.price, 0),
      changePct: num(qMap.QQQ?.changePct, 0),
      sma50: num(cMap.QQQ?.sma50, 0),
      rsi: num(cMap.QQQ?.rsi, 55),
      chg5d: num(cMap.QQQ?.chg5d, 0),
      chg20d: num(cMap.QQQ?.chg20d, 0),
    };

    const sectors = Object.fromEntries(SECTOR_SYMS.map((sym) => [sym, num(qMap[sym]?.changePct, 0)]));
    const sectorValues = Object.values(sectors);
    const positiveSectors = sectorValues.filter((v) => v > 0).length;
    const sorted = Object.entries(sectors).sort((a, b) => b[1] - a[1]);
    const spread = sorted.length >= 6
      ? sorted.slice(0, 3).reduce((s, [, v]) => s + v, 0) / 3 - sorted.slice(-3).reduce((s, [, v]) => s + v, 0) / 3
      : 0;

    const breadth = {
      above20d: +(15 + (positiveSectors / 11) * 55).toFixed(1),
      above50d: +(10 + (positiveSectors / 11) * 50).toFixed(1),
      above200d: +(12 + (positiveSectors / 11) * 48).toFixed(1),
      advDeclineRatio: +(0.55 + (positiveSectors / 11) * 0.95).toFixed(2),
      nhNl: +(0.45 + Math.max(0, spread + 1.2) * 0.45).toFixed(2),
    };

    const vixLevel = num(qMap.VIX?.price, 16);
    const vixPct = num(qMap.VIX?.changePct, 0);
    const putCall = { ratio: +(vixLevel > 25 ? 1.1 : vixLevel > 20 ? 0.95 : vixLevel > 15 ? 0.84 : 0.75).toFixed(2) };

    const regime = regimeFrom(spy, breadth, spread, { level: vixLevel });
    const macro = {
      tenYear: { yield: 4.31, change: 0, trend: 'neutral' },
      dxy: { level: 104.03, change: 0, trend: 'neutral' },
      fedStance: 'neutral',
      fomcDays: getNextFOMCDays(),
      regime,
    };

    const exec = {
      breakoutRetention: +(Math.max(0, Math.min(1, 0.42 + spread * 0.06 + (spy.changePct > 0 ? 0.04 : -0.02)))).toFixed(4),
      trendReliability: +(Math.max(0, Math.min(1, (spy.price > spy.sma50 ? 0.52 : 0.34) + (spy.price > spy.sma200 ? 0.12 : -0.02)))).toFixed(4),
      pullbackBid: +(Math.max(0, Math.min(1, 0.48 + positiveSectors / 11 * 0.2))).toFixed(4),
      followThrough: +(Math.max(0, Math.min(1, 0.44 + spread * 0.05))).toFixed(4),
    };

    const portfolio = PORT_SYMS.map((sym) => ({
      sym,
      price: num(qMap[sym]?.price, 0),
      changePct: num(qMap[sym]?.changePct, 0),
      volume: 1,
      sma20: num(cMap[sym]?.sma20, 0),
      sma50: num(cMap[sym]?.sma50, 0),
      sma200: num(cMap[sym]?.sma200, 0),
      rsi: num(cMap[sym]?.rsi, 0),
      chg5d: num(cMap[sym]?.chg5d, 0),
      chg20d: num(cMap[sym]?.chg20d, 0),
    }));

    const universe = UNIVERSE_SYMS.map((sym) => ({
      sym,
      price: num(qMap[sym]?.price, 0),
      changePct: num(qMap[sym]?.changePct, 0),
      volume: cMap[sym] ? 1 : 0,
      sma20: num(cMap[sym]?.sma20, 0),
      sma50: num(cMap[sym]?.sma50, 0),
      sma200: num(cMap[sym]?.sma200, 0),
      rsi: num(cMap[sym]?.rsi, 0),
      chg5d: num(cMap[sym]?.chg5d, 0),
      chg20d: num(cMap[sym]?.chg20d, 0),
    }));

    const payload = {
      timestamp: new Date().toISOString(),
      source: 'finnhub_quote_candle_v6_5',
      symbolsFetched: Object.keys(qMap).length,
      quoteErrors,
      spy,
      qqq,
      vix: { level: vixLevel, change: num(qMap.VIX?.change, 0), changePct: vixPct },
      vvix: { level: vixLevel > 22 ? 96 : 81 },
      putCall,
      breadth,
      sectors,
      macro,
      exec,
      portfolio,
      universe,
    };

    CACHE = { ts: Date.now(), payload };
    return res.status(200).json(payload);
  } catch (error) {
    return res.status(500).json({ error: 'Failed to fetch market data', message: error.message, timestamp: new Date().toISOString() });
  }
}
