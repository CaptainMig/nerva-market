// ═══════════════════════════════════════════════════════════════
// NERVA MARKET — Vercel Serverless Proxy
// /api/market.js — v4.9: The "Symbol" Singular Fix
// ═══════════════════════════════════════════════════════════════

const CACHE_SECONDS = 60;
const FMP_KEY = process.env.FMP_KEY;
const FMP_STABLE = 'https://financialmodelingprep.com/stable';

// Clean list for Stable API compatibility
const SECTOR_SYMS = ['XLK','XLF','XLE','XLV','XLI','XLY','XLP','XLU','XLB','XLRE','XLC'];
const PORT_SYMS = ['VGT', 'GDX', 'QBTS', 'VYM'];
const UNIVERSE_SYMS = ['NVDA','AAPL','MSFT','GOOGL','AMZN','META','TSLA','AMD','AVGO','LLY','JPM','V','UNH','XOM','COST','IONQ','RGTI','PLTR','COIN','SNOW','PANW','CRWD','NET','SQ','SHOP'];
const ALL_SYMS = ['SPY', 'QQQ', 'VIX', ...SECTOR_SYMS, ...PORT_SYMS, ...UNIVERSE_SYMS];

export default async function handler(req, res) {
  if (!FMP_KEY) return res.status(500).json({ error: "FMP_KEY missing in Vercel" });

  try {
    // FIX: Changed 'symbols=' to 'symbol=' per FMP Stable requirements
    const url = `${FMP_STABLE}/quote?symbol=${ALL_SYMS.join(',')}&apikey=${FMP_KEY}`;
    
    const resp = await fetch(url);
    const text = await resp.text(); 

    let quotes;
    try {
      quotes = JSON.parse(text);
    } catch (e) {
      return res.status(500).json({ 
        error: "FMP Response is not JSON", 
        raw_response: text.substring(0, 100) 
      });
    }

    if (!Array.isArray(quotes)) {
      return res.status(400).json({ error: "FMP Error", message: quotes });
    }

    // Map results to a dictionary for easy lookup
    const qMap = Object.fromEntries(quotes.map(q => [q.symbol, q]));
    
    const sectors = {};
    SECTOR_SYMS.forEach(s => { 
        sectors[s] = qMap[s]?.changesPercentage || 0; 
    });

    const data = {
      timestamp: new Date().toISOString(),
      source: "fmp_stable_v4.9",
      symbols_fetched: quotes.length,
      spy: { 
        price: qMap['SPY']?.price || 0, 
        changePct: qMap['SPY']?.changesPercentage || 0 
      },
      vix: { level: qMap['VIX']?.price || 16 },
      sectors,
      portfolio: PORT_SYMS.map(s => ({
        sym: s,
        price: qMap[s]?.price || 0,
        changePct: qMap[s]?.changesPercentage || 0,
        sma50: qMap[s]?.priceAvg50 || 0,
        sma200: qMap[s]?.priceAvg200 || 0
      }))
    };

    res.setHeader('Cache-Control', `s-maxage=${CACHE_SECONDS}, stale-while-revalidate`);
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: "Proxy Crash", message: err.message });
  }
}
