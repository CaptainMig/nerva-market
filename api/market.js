// ═══════════════════════════════════════════════════════════════
// NERVA MARKET — Vercel Serverless Proxy
// /api/market.js — v4.2: batched requests, retry on 429
// ═══════════════════════════════════════════════════════════════

const CACHE_SECONDS = 60;

const HISTORY_SYMS  = ['SPY', 'QQQ'];
const CORE_SYMS     = ['^VIX', '^TNX', 'DX-Y.NYB'];
const PORT_SYMS     = ['VGT', 'GDX', 'QBTS', 'VYM'];
const SECTOR_SYMS   = ['XLK','XLF','XLE','XLV','XLI','XLY','XLP','XLU','XLB','XLRE','XLC'];
const UNIVERSE_SYMS = ['NVDA','AAPL','MSFT','GOOGL','AMZN','META','TSLA','AMD','AVGO','LLY','JPM','V','UNH','XOM','COST','IONQ','RGTI','PLTR','COIN','SNOW','PANW','CRWD','NET','SQ','SHOP'];

const YF_BASE = 'https://query2.finance.yahoo.com/v8/finance/chart/';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchChart(symbol, range, interval, retries = 2) {
  const url = `${YF_BASE}${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false`;
  for (let i = 0; i <= retries; i++) {
    try {
      const resp = await fetch(url, { headers: HEADERS });
      if (resp.status === 429) { await sleep(600 * (i + 1)); continue; }
      if (!resp.ok) return null;
      return await resp.json();
    } catch { return null; }
  }
  return null;
}

async function fetchBatch(syms, range, interval, delayMs = 80) {
  const results = {};
  for (const sym of syms) {
    results[sym] = await fetchChart(sym, range, interval);
    await sleep(delayMs);
  }
  return results;
}

function parseChart(data) {
  try {
    const r = data?.chart?.result?.[0];
    if (!r) return null;
    const meta = r.meta || {};
    const closes = r.indicators?.quote?.[0]?.close?.filter(c => c != null) || [];

    // Price: prefer meta field, fall back to last close
    const price = meta.regularMarketPrice || closes[closes.length-1] || 0;

    // changePct: try meta direct fields first (most reliable for sectors)
    let changePct = 0;
    if (meta.regularMarketChangePercent != null && meta.regularMarketChangePercent !== 0) {
      changePct = meta.regularMarketChangePercent;
    } else if (meta.chartPreviousClose && meta.chartPreviousClose !== price) {
      changePct = ((price - meta.chartPreviousClose) / meta.chartPreviousClose) * 100;
    } else if (closes.length >= 2) {
      // Last two closes from the chart data
      const prev = closes[closes.length-2];
      if (prev && prev !== price) changePct = ((price - prev) / prev) * 100;
    }

    const change = meta.regularMarketChange || (price * changePct / 100);
    const sma = (n) => closes.length >= n ? closes.slice(-n).reduce((a,b)=>a+b,0)/n : null;
    return { price, change, changePct, volume: meta.regularMarketVolume||0, sma20:sma(20), sma50:sma(50), sma200:sma(200), closes };
  } catch { return null; }
}

function calcRSI(closes, p=14) {
  if (!closes || closes.length < p+1) return 55;
  const ch = closes.slice(-(p+1)).map((v,i,a)=>i>0?v-a[i-1]:0).slice(1);
  const g = ch.filter(c=>c>0).reduce((a,b)=>a+b,0)/p;
  const l = ch.filter(c=>c<0).map(Math.abs).reduce((a,b)=>a+b,0)/p;
  return l===0 ? 100 : Math.round(100-(100/(1+g/l)));
}

function getNextFOMCDays() {
  const dates = ['2026-03-18','2026-05-06','2026-06-17','2026-07-29','2026-09-16','2026-11-04','2026-12-16'];
  const now = new Date();
  for (const d of dates) {
    const diff = (new Date(d)-now)/(1000*60*60*24);
    if (diff > -1) return Math.max(0, Math.ceil(diff));
  }
  return 30;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', `s-maxage=${CACHE_SECONDS}, stale-while-revalidate`);

  try {
    // Sequential batches with pacing — prevents Yahoo 429
    const h = await fetchBatch(HISTORY_SYMS,  '6mo', '1d', 120);
    const c = await fetchBatch(CORE_SYMS,      '5d',  '1d', 100);
    const p = await fetchBatch(PORT_SYMS,      '5d',  '1d', 80);
    const s = await fetchBatch(SECTOR_SYMS,    '5d',  '1d', 60);
    const u = await fetchBatch(UNIVERSE_SYMS,  '5d',  '1d', 50);

    const raw = { ...h, ...c, ...p, ...s, ...u };
    const q = {};
    for (const [sym, data] of Object.entries(raw)) {
      const parsed = parseChart(data);
      if (parsed) q[sym] = parsed;
    }

    const spy = q['SPY'], qqq = q['QQQ'], vix = q['^VIX'], tnx = q['^TNX'], dxy = q['DX-Y.NYB'];
    const vixLevel = vix?.price || 16;
    const tnxLevel = tnx?.price || 4.3;

    const sp = {};
    SECTOR_SYMS.forEach(sym => { sp[sym] = q[sym]?.changePct || 0; });
    const sectorsPos = Object.values(sp).filter(v=>v>0).length;

    res.status(200).json({
      timestamp: new Date().toISOString(),
      source: 'yahoo_finance_v8',
      spy: {
        price: spy?.price||0, changePct: spy?.changePct||0,
        sma20: spy?.sma20||0, sma50: spy?.sma50||0, sma200: spy?.sma200||0,
        rsi: calcRSI(spy?.closes),
      },
      qqq: { price: qqq?.price||0, changePct: qqq?.changePct||0, sma50: qqq?.sma50||0, rsi: calcRSI(qqq?.closes) },
      vix: { level: vixLevel, change: vix?.change||0, changePct: vix?.changePct||0 },
      vvix: { level: 85 },
      putCall: { ratio: vixLevel>25?1.1:vixLevel>20?0.95:vixLevel>15?0.85:0.75 },
      breadth: {
        above20d:        sectorsPos/11*70+15,
        above50d:        sectorsPos/11*65+10,
        above200d:       sectorsPos/11*60+15,
        advDeclineRatio: sectorsPos>6 ? 1.0+(sectorsPos-6)*0.15 : 0.5+sectorsPos*0.08,
      },
      sectors: sp,
      macro: {
        tenYear: { yield: tnxLevel, change: tnx?.change||0, trend: (tnx?.change||0)>0?'rising':'falling' },
        dxy:     { level: dxy?.price||104, change: dxy?.changePct||0, trend: (dxy?.changePct||0)>0?'strengthening':'weakening' },
        fedStance: tnxLevel>4.5?'hawkish':tnxLevel>4.0?'neutral':'dovish',
        fomcDays: getNextFOMCDays(),
      },
      portfolio: PORT_SYMS.map(sym => ({
        sym, price: q[sym]?.price||0, changePct: q[sym]?.changePct||0,
        volume: q[sym]?.volume||0, sma50: q[sym]?.sma50||0, sma200: q[sym]?.sma200||0,
      })),
      universe: UNIVERSE_SYMS.map(sym => ({
        sym, price: q[sym]?.price||0, changePct: q[sym]?.changePct||0,
        volume: q[sym]?.volume||0, sma50: q[sym]?.sma50||0, sma200: q[sym]?.sma200||0,
      })),
    });

  } catch (error) {
    res.status(500).json({ error:'Failed to fetch market data', message:error.message, timestamp:new Date().toISOString() });
  }
}
