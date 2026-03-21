// ═══════════════════════════════════════════════════════════════
// NERVA MARKET — Vercel Serverless Proxy
// api/market.js — v8.0: CommonJS, bulletproof, no ES modules
// Finnhub quotes (sequential) + Alpha Vantage history (parallel)
// ═══════════════════════════════════════════════════════════════

const CACHE_TTL = 90; // seconds
const FINNHUB_KEY = process.env.FINNHUB_KEY || '';
const AV_KEY = process.env.ALPHAVANTAGE_KEY || '';

// ── Symbol lists ──────────────────────────────────────────────
const QUOTE_SYMS = [
  'SPY','QQQ',
  'XLK','XLF','XLE','XLV','XLI','XLY','XLP','XLU','XLB','XLRE','XLC',
  'VGT','GDX','QBTS','VYM'
];
const HISTORY_SYMS = ['SPY','QQQ','VGT','GDX','QBTS','VYM'];

// ── In-memory cache ───────────────────────────────────────────
var cached = null;
var cachedAt = 0;

// ── Helpers ───────────────────────────────────────────────────
function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

function sma(closes, period) {
  if (!closes || closes.length < period) return 0;
  var slice = closes.slice(closes.length - period);
  var sum = 0;
  for (var i = 0; i < slice.length; i++) sum += slice[i];
  return Math.round((sum / period) * 100) / 100;
}

function rsi14(closes) {
  if (!closes || closes.length < 15) return 0;
  var gains = 0, losses = 0;
  for (var i = closes.length - 14; i < closes.length; i++) {
    var diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  var avgGain = gains / 14;
  var avgLoss = losses / 14;
  if (avgLoss === 0) return 100;
  var rs = avgGain / avgLoss;
  return Math.round((100 - 100 / (1 + rs)) * 10) / 10;
}

// ── Finnhub quote (one symbol at a time) ──────────────────────
async function finnhubQuote(sym) {
  if (!FINNHUB_KEY) return null;
  var url = 'https://finnhub.io/api/v1/quote?symbol=' + encodeURIComponent(sym) + '&token=' + FINNHUB_KEY;
  try {
    var resp = await fetch(url);
    if (!resp.ok) return null;
    var d = await resp.json();
    if (!d || !d.c) return null;
    return {
      price: d.c || 0,
      prevClose: d.pc || 0,
      high: d.h || 0,
      low: d.l || 0,
      open: d.o || 0,
      changePct: d.dp || 0,
      volume: 0
    };
  } catch (e) {
    return null;
  }
}

// ── Finnhub candle (weekly, free tier) ────────────────────────
async function finnhubCandle(sym) {
  if (!FINNHUB_KEY) return [];
  var now = Math.floor(Date.now() / 1000);
  var from = now - 86400 * 400; // ~13 months of weekly data
  var url = 'https://finnhub.io/api/v1/stock/candle?symbol=' + encodeURIComponent(sym)
    + '&resolution=W&from=' + from + '&to=' + now + '&token=' + FINNHUB_KEY;
  try {
    var resp = await fetch(url);
    if (!resp.ok) return [];
    var d = await resp.json();
    if (!d || d.s !== 'ok' || !d.c || !Array.isArray(d.c)) return [];
    return d.c;
  } catch (e) {
    return [];
  }
}

// ── Alpha Vantage daily history ───────────────────────────────
async function avDaily(sym) {
  if (!AV_KEY) return [];
  var url = 'https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol='
    + encodeURIComponent(sym) + '&outputsize=compact&apikey=' + AV_KEY;
  try {
    var resp = await fetch(url);
    if (!resp.ok) return [];
    var d = await resp.json();
    var ts = d['Time Series (Daily)'];
    if (!ts) return [];
    var dates = Object.keys(ts).sort();
    var closes = [];
    for (var i = 0; i < dates.length; i++) {
      closes.push(parseFloat(ts[dates[i]]['4. close']));
    }
    return closes;
  } catch (e) {
    return [];
  }
}

// ── Fetch history: try Alpha Vantage first, fallback to Finnhub weekly
async function getHistory(sym) {
  // Try Alpha Vantage (daily closes, best quality)
  var closes = await avDaily(sym);
  if (closes.length >= 20) return { closes: closes, source: 'av' };
  // Fallback: Finnhub weekly
  var weekly = await finnhubCandle(sym);
  if (weekly.length >= 10) return { closes: weekly, source: 'finnhub_weekly' };
  return { closes: [], source: 'none' };
}

// ── Compute indicators from closes ────────────────────────────
function computeIndicators(closes, source) {
  if (!closes || closes.length < 5) {
    return { sma20: 0, sma50: 0, sma200: 0, rsi: 0 };
  }
  if (source === 'finnhub_weekly') {
    // Weekly closes: SMA4w≈20d, SMA10w≈50d, SMA40w≈200d
    return {
      sma20: sma(closes, Math.min(4, closes.length)),
      sma50: sma(closes, Math.min(10, closes.length)),
      sma200: sma(closes, Math.min(40, closes.length)),
      rsi: rsi14(closes)
    };
  }
  // Daily closes
  return {
    sma20: sma(closes, Math.min(20, closes.length)),
    sma50: sma(closes, Math.min(50, closes.length)),
    sma200: sma(closes, Math.min(200, closes.length)),
    rsi: rsi14(closes)
  };
}

// ── Breadth approximation from sector data ────────────────────
function computeBreadth(sectors) {
  var vals = Object.values(sectors);
  var above = 0;
  for (var i = 0; i < vals.length; i++) {
    if (vals[i] > 0) above++;
  }
  var ratio = vals.length > 0 ? above / vals.length : 0.5;
  return {
    above20d: Math.round(ratio * 60 * 10) / 10,
    above50d: Math.round(ratio * 45 * 10) / 10,
    above200d: Math.round(ratio * 40 * 10) / 10,
    advDeclineRatio: Math.round((ratio * 1.5 + 0.2) * 100) / 100,
    nhNl: Math.round((ratio + 0.5) * 100) / 100
  };
}

// ── FOMC days calculation ─────────────────────────────────────
function fomcDaysAway() {
  var dates = [
    '2026-01-29','2026-03-19','2026-05-07','2026-06-18',
    '2026-07-30','2026-09-17','2026-11-05','2026-12-17'
  ];
  var now = new Date();
  for (var i = 0; i < dates.length; i++) {
    var d = new Date(dates[i] + 'T00:00:00Z');
    var diff = Math.ceil((d - now) / 86400000);
    if (diff > 0) return diff;
  }
  return 90;
}

// ── Main handler ──────────────────────────────────────────────
module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  // Cache check
  var now = Date.now();
  if (cached && (now - cachedAt) < CACHE_TTL * 1000) {
    res.setHeader('X-Cache', 'HIT');
    return res.status(200).json(cached);
  }

  try {
    if (!FINNHUB_KEY) {
      return res.status(500).json({
        error: 'FINNHUB_KEY not set',
        message: 'Add FINNHUB_KEY environment variable in Vercel dashboard',
        timestamp: new Date().toISOString()
      });
    }

    // ── Step 1: Sequential Finnhub quotes ───────────────────
    var quotes = {};
    var quoteErrors = [];
    for (var i = 0; i < QUOTE_SYMS.length; i++) {
      var sym = QUOTE_SYMS[i];
      var q = await finnhubQuote(sym);
      if (q) {
        quotes[sym] = q;
      } else {
        quoteErrors.push(sym);
      }
      if (i < QUOTE_SYMS.length - 1) await sleep(100);
    }

    // Also fetch VIX
    var vixQ = await finnhubQuote('^VIX');
    // VIX might need CBOE:VIX on Finnhub
    if (!vixQ) {
      await sleep(100);
      vixQ = await finnhubQuote('CBOE:VIX');
    }

    // ── Step 2: Parallel history fetches ────────────────────
    var histPromises = {};
    for (var h = 0; h < HISTORY_SYMS.length; h++) {
      histPromises[HISTORY_SYMS[h]] = getHistory(HISTORY_SYMS[h]);
    }
    var histResults = {};
    var histKeys = Object.keys(histPromises);
    var histVals = await Promise.all(histKeys.map(function(k) { return histPromises[k]; }));
    for (var j = 0; j < histKeys.length; j++) {
      histResults[histKeys[j]] = histVals[j];
    }

    // ── Step 3: Build sectors ───────────────────────────────
    var sectorSyms = ['XLK','XLF','XLE','XLV','XLI','XLY','XLP','XLU','XLB','XLRE','XLC'];
    var sectors = {};
    for (var s = 0; s < sectorSyms.length; s++) {
      var ss = sectorSyms[s];
      sectors[ss] = quotes[ss] ? (quotes[ss].changePct || 0) : 0;
    }

    // ── Step 4: Build SPY/QQQ ───────────────────────────────
    var spyQ = quotes['SPY'] || { price: 0, changePct: 0 };
    var spyHist = histResults['SPY'] || { closes: [], source: 'none' };
    var spyInd = computeIndicators(spyHist.closes, spyHist.source);

    var qqqQ = quotes['QQQ'] || { price: 0, changePct: 0 };
    var qqqHist = histResults['QQQ'] || { closes: [], source: 'none' };
    var qqqInd = computeIndicators(qqqHist.closes, qqqHist.source);

    // ── Step 5: Build portfolio ─────────────────────────────
    var portSyms = ['VGT','GDX','QBTS','VYM'];
    var portfolio = [];
    for (var p = 0; p < portSyms.length; p++) {
      var ps = portSyms[p];
      var pq = quotes[ps] || { price: 0, changePct: 0, volume: 0 };
      var ph = histResults[ps] || { closes: [], source: 'none' };
      var pi = computeIndicators(ph.closes, ph.source);
      portfolio.push({
        sym: ps,
        price: pq.price || 0,
        changePct: pq.changePct || 0,
        volume: pq.volume || 0,
        sma20: pi.sma20,
        sma50: pi.sma50,
        sma200: pi.sma200,
        rsi: pi.rsi
      });
    }

    // ── Step 6: VIX / macro ─────────────────────────────────
    var vixLevel = 16;
    var vixChgPct = 0;
    if (vixQ) {
      vixLevel = vixQ.price || 16;
      vixChgPct = vixQ.changePct || 0;
    }

    var tnxQ = quotes['^TNX'] || null;
    // TNX might not be in QUOTE_SYMS, that's fine
    var tenYield = 4.3;
    var tenTrend = 'neutral';

    // ── Step 7: Execution window ────────────────────────────
    var breadth = computeBreadth(sectors);
    var exec = {
      breakoutRetention: Math.round((breadth.advDeclineRatio > 1 ? 0.6 : 0.35) * 100) / 100,
      trendReliability: Math.round((breadth.above50d > 30 ? 0.55 : 0.3) * 100) / 100,
      pullbackBid: Math.round((breadth.above200d > 25 ? 0.5 : 0.35) * 100) / 100,
      followThrough: Math.round((breadth.advDeclineRatio > 1.2 ? 0.55 : 0.35) * 100) / 100
    };

    // ── Step 8: Assemble payload ────────────────────────────
    var symbolsFetched = Object.keys(quotes).length;
    var dataStatus = symbolsFetched >= 10 ? 'LIVE' : (symbolsFetched > 0 ? 'PARTIAL' : 'DEGRADED');

    var payload = {
      timestamp: new Date().toISOString(),
      source: 'finnhub_av_v80',
      dataStatus: dataStatus,
      symbolsFetched: symbolsFetched,
      quoteErrors: quoteErrors,
      historySource: histResults['SPY'] ? histResults['SPY'].source : 'none',
      spy: {
        price: spyQ.price || 0,
        changePct: spyQ.changePct || 0,
        sma20: spyInd.sma20,
        sma50: spyInd.sma50,
        sma200: spyInd.sma200,
        rsi: spyInd.rsi
      },
      qqq: {
        price: qqqQ.price || 0,
        changePct: qqqQ.changePct || 0,
        sma50: qqqInd.sma50,
        rsi: qqqInd.rsi
      },
      vix: { level: vixLevel, changePct: vixChgPct },
      vvix: { level: 81 },
      putCall: { ratio: 0.84 },
      breadth: breadth,
      sectors: sectors,
      macro: {
        tenYear: { yield: tenYield, trend: tenTrend },
        dxy: { level: 104, trend: 'neutral' },
        fedStance: 'neutral',
        fomcDays: fomcDaysAway()
      },
      exec: exec,
      portfolio: portfolio
    };

    // Cache it
    cached = payload;
    cachedAt = Date.now();

    res.setHeader('X-Cache', 'MISS');
    return res.status(200).json(payload);

  } catch (err) {
    // NEVER crash — always return valid JSON
    return res.status(200).json({
      timestamp: new Date().toISOString(),
      source: 'finnhub_av_v80_fallback',
      dataStatus: 'DEGRADED',
      symbolsFetched: 0,
      quoteErrors: [String(err.message || err)],
      historySource: 'none',
      spy: { price: 0, changePct: 0, sma20: 0, sma50: 0, sma200: 0, rsi: 0 },
      qqq: { price: 0, changePct: 0, sma50: 0, rsi: 0 },
      vix: { level: 16, changePct: 0 },
      vvix: { level: 81 },
      putCall: { ratio: 0.84 },
      breadth: { above20d: 15, above50d: 10, above200d: 12, advDeclineRatio: 0.55, nhNl: 0.99 },
      sectors: { XLK:0, XLF:0, XLE:0, XLV:0, XLI:0, XLY:0, XLP:0, XLU:0, XLB:0, XLRE:0, XLC:0 },
      macro: { tenYear: { yield: 4.3, trend: 'neutral' }, dxy: { level: 104, trend: 'neutral' }, fedStance: 'neutral', fomcDays: 46 },
      exec: { breakoutRetention: 0.4, trendReliability: 0.32, pullbackBid: 0.48, followThrough: 0.44 },
      portfolio: [
        { sym:'VGT', price:0, changePct:0, volume:0, sma20:0, sma50:0, sma200:0, rsi:0 },
        { sym:'GDX', price:0, changePct:0, volume:0, sma20:0, sma50:0, sma200:0, rsi:0 },
        { sym:'QBTS', price:0, changePct:0, volume:0, sma20:0, sma50:0, sma200:0, rsi:0 },
        { sym:'VYM', price:0, changePct:0, volume:0, sma20:0, sma50:0, sma200:0, rsi:0 }
      ]
    });
  }
};
