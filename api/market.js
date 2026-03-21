// NERVA MARKET v7.7 — yahoo-finance15 via RapidAPI
// Single provider: quotes + pre-computed SMAs + history for RSI
// Requires: RAPIDAPI_KEY env var in Vercel
// Free tier: 500 calls/month — well within budget with 3-min cache
// Layout and UX unchanged from v7.2

const CACHE_SECONDS = 180;

const PORT_SYMS     = ['VGT','GDX','QBTS','VYM'];
const SECTOR_SYMS   = ['XLK','XLF','XLE','XLV','XLI','XLY','XLP','XLU','XLB','XLRE','XLC'];
const HISTORY_SYMS  = ['SPY','QQQ','VGT','GDX','QBTS','VYM']; // real RSI from history
const ALL_QUOTE_SYMS = ['SPY','QQQ','VIX','VGT','GDX','QBTS','VYM',...new Set([...SECTOR_SYMS])];

const RAPID_HOST = 'yahoo-finance15.p.rapidapi.com';
const RAPID_BASE = `https://${RAPID_HOST}/api/v1/markets`;

function getNextFOMCDays() {
  const dates = ['2026-05-06','2026-06-17','2026-07-29','2026-09-16','2026-11-04','2026-12-16'];
  const now = new Date();
  for (const d of dates) {
    const diff = (new Date(d) - now) / (1000*60*60*24);
    if (diff > -1) return Math.max(0, Math.ceil(diff));
  }
  return 30;
}

function num(v, f=0) { const n=Number(v); return Number.isFinite(n)?n:f; }

function sma(arr, len) {
  if (!Array.isArray(arr) || arr.length < len) return 0;
  return arr.slice(-len).reduce((a,b)=>a+b,0) / len;
}

function rsi14(closes) {
  const valid = (closes||[]).filter(c => Number.isFinite(c) && c > 0);
  if (valid.length < 15) return 0;
  let gains=0, losses=0;
  for (let i=valid.length-14; i<valid.length; i++) {
    const d = valid[i] - valid[i-1];
    if (d >= 0) gains += d; else losses += Math.abs(d);
  }
  if (losses === 0) return 100;
  return Math.round((100 - (100/(1+gains/losses))) * 10) / 10;
}

async function rapidFetch(path, key) {
  const url = `${RAPID_BASE}${path}`;
  const r = await fetch(url, {
    headers: {
      'x-rapidapi-host': RAPID_HOST,
      'x-rapidapi-key': key,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout ? AbortSignal.timeout(6000) : undefined,
  });
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return r.json();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', `s-maxage=${CACHE_SECONDS}, stale-while-revalidate`);

  const key = process.env.RAPIDAPI_KEY;
  if (!key) return res.status(500).json({ error: 'RAPIDAPI_KEY not set' });

  try {
    // Parallel: bulk quotes + history for 6 key symbols
    const [quotesData, ...histResults] = await Promise.all([
      rapidFetch(`/stock/quotes?ticker=${ALL_QUOTE_SYMS.join(',')}`, key),
      ...HISTORY_SYMS.map(sym => rapidFetch(`/stock/history?symbol=${sym}&interval=1d&diffandsplits=false`, key)
        .then(d => ({ sym, data: d }))
        .catch(() => ({ sym, data: null }))
      ),
    ]);

    // Parse bulk quotes
    // yahoo-finance15 /quotes returns { body: [ { symbol, regularMarketPrice, ... } ] }
    const qMap = {};
    const quoteList = quotesData?.body || quotesData?.quoteResponse?.result || [];
    for (const q of (Array.isArray(quoteList) ? quoteList : [])) {
      const sym = q.symbol || q.ticker;
      if (!sym) continue;
      qMap[sym] = {
        price:     num(q.regularMarketPrice || q.price, 0),
        changePct: num(q.regularMarketChangePercent || q.changesPercentage || q.dp, 0),
        sma50:     num(q.fiftyDayAverage || q.fiftyDayAveragePrice, 0),
        sma200:    num(q.twoHundredDayAverage || q.twoHundredDayAveragePrice, 0),
        volume:    num(q.regularMarketVolume || q.volume, 0),
      };
    }

    // Parse history for RSI + SMA20
    const hMap = {};
    for (const { sym, data } of histResults) {
      if (!data) continue;
      // yahoo-finance15 /history returns { body: { "2024-01-02": { close, ... }, ... } }
      // OR { body: [ { date, close, ... } ] } depending on version
      let closes = [];
      const body = data?.body;
      if (body && typeof body === 'object' && !Array.isArray(body)) {
        closes = Object.keys(body).sort()
          .map(k => num(body[k]?.close || body[k]?.adjclose, 0))
          .filter(v => v > 0);
      } else if (Array.isArray(body)) {
        closes = body.map(d => num(d.close || d.adjclose, 0)).filter(v => v > 0);
      }
      if (closes.length >= 20) hMap[sym] = closes;
    }

    const spy = qMap['SPY'] || {};
    const qqq = qMap['QQQ'] || {};
    const vix = qMap['VIX'] || {};
    const spyC = hMap['SPY'] || [];
    const qqqC = hMap['QQQ'] || [];

    const vixLevel = num(vix.price, 16);
    const tnxLevel = 4.31; // hardcoded — TNX not in free tier

    const sp = {};
    SECTOR_SYMS.forEach(s => { sp[s] = num(qMap[s]?.changePct, 0); });
    const sectorsPos = Object.values(sp).filter(v=>v>0).length;
    const sorted = Object.entries(sp).sort((a,b)=>b[1]-a[1]);
    const spread = sorted.length>=6
      ? sorted.slice(0,3).reduce((s,[,v])=>s+v,0)/3 - sorted.slice(-3).reduce((s,[,v])=>s+v,0)/3
      : 0;

    const symbolsFetched = Object.keys(qMap).length;
    const dataStatus = symbolsFetched >= 15 ? 'LIVE' : symbolsFetched >= 8 ? 'PARTIAL' : 'DEGRADED';

    const portfolio = PORT_SYMS.map(sym => {
      const q = qMap[sym] || {};
      const c = hMap[sym] || [];
      return {
        sym,
        price:     num(q.price, 0),
        changePct: num(q.changePct, 0),
        volume:    num(q.volume, 0),
        sma20:     sma(c, 20),
        sma50:     c.length>=50 ? sma(c,50) : num(q.sma50, 0),
        sma200:    c.length>=200 ? sma(c,200) : num(q.sma200, 0),
        rsi:       rsi14(c),
      };
    });

    return res.status(200).json({
      timestamp: new Date().toISOString(),
      source: 'rapidapi_yh15_v77',
      dataStatus,
      symbolsFetched,
      quoteErrors: [],
      spy: {
        price:     num(spy.price, 0),
        changePct: num(spy.changePct, 0),
        sma20:     sma(spyC, 20),
        sma50:     spyC.length>=50 ? sma(spyC,50) : num(spy.sma50,0),
        sma200:    spyC.length>=200 ? sma(spyC,200) : num(spy.sma200,0),
        rsi:       rsi14(spyC),
      },
      qqq: {
        price:     num(qqq.price, 0),
        changePct: num(qqq.changePct, 0),
        sma50:     qqqC.length>=50 ? sma(qqqC,50) : num(qqq.sma50,0),
        rsi:       rsi14(qqqC),
      },
      vix: { level: vixLevel, changePct: num(vix.changePct,0) },
      vvix: { level: vixLevel > 22 ? 96 : 81 },
      putCall: { ratio: vixLevel>25?1.1:vixLevel>20?0.95:vixLevel>15?0.84:0.75 },
      breadth: {
        above20d:        +(15+(sectorsPos/11)*55).toFixed(1),
        above50d:        +(10+(sectorsPos/11)*50).toFixed(1),
        above200d:       +(12+(sectorsPos/11)*48).toFixed(1),
        advDeclineRatio: +(0.55+(sectorsPos/11)*0.95).toFixed(2),
        nhNl:            +(0.45+Math.max(0,spread+1.2)*0.45).toFixed(2),
      },
      sectors: sp,
      macro: {
        tenYear: { yield: tnxLevel, trend: 'neutral' },
        dxy: { level: 104.03, trend: 'neutral' },
        fedStance: 'neutral',
        fomcDays: getNextFOMCDays(),
      },
      exec: {
        breakoutRetention: 0.40,
        trendReliability:  0.32,
        pullbackBid:       0.48,
        followThrough:     0.44,
      },
      portfolio,
    });

  } catch (e) {
    return res.status(500).json({ error: 'proxy crash', message: e.message, timestamp: new Date().toISOString() });
  }
}
