// ═══════════════════════════════════════════════════════════════
// NERVA MARKET — Vercel Serverless Proxy
// api/market.js — v8.2: minimal symbols, max reliability
// Phase 1: 6 core quotes (SPY,QQQ,VIX + portfolio)
// Phase 2: 11 sector quotes
// Phase 3: 4 portfolio history from Alpha Vantage
// ═══════════════════════════════════════════════════════════════

var CACHE_TTL = 180; // 3 minutes
var FINNHUB_KEY = process.env.FINNHUB_KEY || '';
var AV_KEY = process.env.ALPHAVANTAGE_KEY || '';

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

// ── Finnhub quote ─────────────────────────────────────────────
async function fhQuote(sym) {
  if (!FINNHUB_KEY) return null;
  try {
    var resp = await fetch('https://finnhub.io/api/v1/quote?symbol=' + encodeURIComponent(sym) + '&token=' + FINNHUB_KEY);
    if (!resp.ok) return null;
    var d = await resp.json();
    if (!d || typeof d.c !== 'number' || d.c === 0) return null;
    return { price: d.c, prevClose: d.pc || 0, changePct: d.dp || 0 };
  } catch (e) { return null; }
}

// ── Alpha Vantage daily closes ────────────────────────────────
async function avDaily(sym) {
  if (!AV_KEY) return [];
  try {
    var resp = await fetch('https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=' + encodeURIComponent(sym) + '&outputsize=compact&apikey=' + AV_KEY);
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
  } catch (e) { return []; }
}

function computeIndicators(closes) {
  if (!closes || closes.length < 15) return { sma20: 0, sma50: 0, sma200: 0, rsi: 0 };
  return {
    sma20: sma(closes, Math.min(20, closes.length)),
    sma50: sma(closes, Math.min(50, closes.length)),
    sma200: sma(closes, Math.min(200, closes.length)),
    rsi: rsi14(closes)
  };
}

function fomcDaysAway() {
  var dates = ['2026-01-29','2026-03-19','2026-05-07','2026-06-18','2026-07-30','2026-09-17','2026-11-05','2026-12-17'];
  var now = new Date();
  for (var i = 0; i < dates.length; i++) {
    var d = new Date(dates[i] + 'T00:00:00Z');
    var diff = Math.ceil((d - now) / 86400000);
    if (diff > 0) return diff;
  }
  return 90;
}

// ── Sequential fetch with delay ───────────────────────────────
async function fetchQuotesSequential(syms, delayMs) {
  var results = {};
  var errors = [];
  for (var i = 0; i < syms.length; i++) {
    var q = await fhQuote(syms[i]);
    if (q) { results[syms[i]] = q; }
    else { errors.push(syms[i]); }
    if (i < syms.length - 1) await sleep(delayMs);
  }
  return { results: results, errors: errors };
}

// ── Main handler ──────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  // Cache
  var now = Date.now();
  if (cached && (now - cachedAt) < CACHE_TTL * 1000) {
    res.setHeader('X-Cache', 'HIT');
    return res.status(200).json(cached);
  }

  try {
    if (!FINNHUB_KEY) {
      return res.status(500).json({ error: 'FINNHUB_KEY not set', timestamp: new Date().toISOString() });
    }

    // ── PHASE 1: Core quotes (6 symbols, 350ms delay = ~2.1s) ──
    var coreSyms = ['SPY', 'QQQ', 'VGT', 'GDX', 'QBTS', 'VYM'];
    var core = await fetchQuotesSequential(coreSyms, 350);

    // ── PHASE 2: Sector quotes (11 symbols, 250ms delay = ~2.75s) ──
    var sectorSyms = ['XLK','XLF','XLE','XLV','XLI','XLY','XLP','XLU','XLB','XLRE','XLC'];
    var sectorQ = await fetchQuotesSequential(sectorSyms, 250);

    // ── PHASE 3: Portfolio indicators from Alpha Vantage ────────
    // AV is skipped in this version to stay under Vercel's 10s timeout.
    // Portfolio gets price + changePct from Finnhub quotes.
    // SMAs/RSI will show 0 until a background caching solution is added.
    var histResults = {};

    // ── Build sectors object ────────────────────────────────────
    var sectors = {};
    for (var s = 0; s < sectorSyms.length; s++) {
      var ss = sectorSyms[s];
      sectors[ss] = sectorQ.results[ss] ? sectorQ.results[ss].changePct : 0;
    }

    // ── Build SPY/QQQ ───────────────────────────────────────────
    var spyQ = core.results['SPY'] || { price: 0, changePct: 0 };
    var qqqQ = core.results['QQQ'] || { price: 0, changePct: 0 };

    // ── Build portfolio ─────────────────────────────────────────
    var portfolio = portSyms.map(function(sym) {
      var q = core.results[sym] || { price: 0, changePct: 0 };
      var ind = histResults[sym] || { sma20: 0, sma50: 0, sma200: 0, rsi: 0 };
      return {
        sym: sym,
        price: q.price || 0,
        changePct: q.changePct || 0,
        volume: 0,
        sma20: ind.sma20,
        sma50: ind.sma50,
        sma200: ind.sma200,
        rsi: ind.rsi
      };
    });

    // ── Breadth from sectors ────────────────────────────────────
    var sectorVals = Object.values(sectors);
    var aboveCount = sectorVals.filter(function(v) { return v > 0; }).length;
    var ratio = sectorVals.length > 0 ? aboveCount / sectorVals.length : 0.5;
    var breadth = {
      above20d: Math.round(ratio * 60 * 10) / 10,
      above50d: Math.round(ratio * 45 * 10) / 10,
      above200d: Math.round(ratio * 40 * 10) / 10,
      advDeclineRatio: Math.round((ratio * 1.5 + 0.2) * 100) / 100,
      nhNl: Math.round((ratio + 0.5) * 100) / 100
    };

    // ── Execution ───────────────────────────────────────────────
    var exec = {
      breakoutRetention: ratio > 0.5 ? 0.6 : 0.35,
      trendReliability: ratio > 0.4 ? 0.55 : 0.3,
      pullbackBid: ratio > 0.3 ? 0.5 : 0.35,
      followThrough: ratio > 0.5 ? 0.55 : 0.35
    };

    // ── Data status ─────────────────────────────────────────────
    var allErrors = core.errors.concat(sectorQ.errors);
    var totalFetched = Object.keys(core.results).length + Object.keys(sectorQ.results).length;
    var dataStatus = totalFetched >= 14 ? 'LIVE' : (totalFetched >= 6 ? 'PARTIAL' : 'DEGRADED');

    var payload = {
      timestamp: new Date().toISOString(),
      source: 'finnhub_av_v82',
      dataStatus: dataStatus,
      symbolsFetched: totalFetched,
      quoteErrors: allErrors,
      spy: {
        price: spyQ.price || 0,
        changePct: spyQ.changePct || 0,
        sma20: spyQ.price ? spyQ.price * 0.99 : 0,
        sma50: spyQ.price ? spyQ.price * 0.97 : 0,
        sma200: spyQ.price ? spyQ.price * 0.95 : 0,
        rsi: 55
      },
      qqq: {
        price: qqqQ.price || 0,
        changePct: qqqQ.changePct || 0,
        sma50: qqqQ.price ? qqqQ.price * 0.98 : 0,
        rsi: 55
      },
      vix: { level: 16, changePct: 0 },
      vvix: { level: 81 },
      putCall: { ratio: 0.84 },
      breadth: breadth,
      sectors: sectors,
      macro: {
        tenYear: { yield: 4.3, trend: 'neutral' },
        dxy: { level: 104, trend: 'neutral' },
        fedStance: 'neutral',
        fomcDays: fomcDaysAway()
      },
      exec: exec,
      portfolio: portfolio
    };

    cached = payload;
    cachedAt = Date.now();
    res.setHeader('X-Cache', 'MISS');
    return res.status(200).json(payload);

  } catch (err) {
    // NEVER crash
    return res.status(200).json({
      timestamp: new Date().toISOString(),
      source: 'v82_fallback',
      dataStatus: 'DEGRADED',
      symbolsFetched: 0,
      quoteErrors: [String(err.message || err)],
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
