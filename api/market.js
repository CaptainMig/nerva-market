// ═══════════════════════════════════════════════════════════════
// NERVA MARKET — Vercel Serverless Proxy
// /api/market.js — v5.0: Standard Free-Tier Recovery
// ═══════════════════════════════════════════════════════════════

const CACHE_SECONDS = 60;
const FMP_KEY = process.env.FMP_KEY;
// Switching back to the standard v3 base URL for free tier
const FMP_BASE = 'https://financialmodelingprep.com/api/v3';

const SECTOR_SYMS = ['XLK','XLF','XLE','XLV','XLI','XLY','XLP','XLU','XLB','XLRE','XLC'];
const PORT_SYMS = ['VGT', 'GDX', 'QBTS', 'VYM'];
const UNIVERSE_SYMS = ['NVDA','AAPL','MSFT','GOOGL','AMZN','META','TSLA','AMD','AVGO','LLY','JPM','V','UNH','XOM','COST','IONQ','RGTI','PLTR','COIN','SNOW','PANW','CRWD','NET','SQ','SHOP'];
// Trimming the list slightly to ensure we don't hit "URL too long" limits on free tier
const ALL_SYMS = ['SPY', 'QQQ', ...SECTOR_SYMS, ...PORT_SYMS, ...UNIVERSE_SYMS];

export default async function handler(req, res) {
  if (!FMP_KEY) return res.status(500).json({ error: "FMP_KEY missing in Vercel" });

  try {
    // Standard v3 bulk quote format: /quote/TICKER1,TICKER2?apikey=...
    const url = `${FMP_BASE}/quote/${ALL_SYMS.join(',')}?apikey=${FMP_KEY}`;
    
    const resp = await fetch(url);
    const data = await resp.json();

    // If FMP returns an error object instead of an array
    if (!Array.isArray(data)) {
      return res.status(400).json({ 
        error: "FMP API Error", 
        message: data["Error Message"] || "Invalid response format" 
      });
    }

    const qMap = Object.fromEntries(data.map(q => [q.symbol, q]));
    const sectors = {};
    SECTOR_SYMS.forEach(s => { 
        sectors[s] = qMap[s]?.changesPercentage || 0; 
    });

    const output = {
      timestamp: new Date().toISOString(),
      source: "fmp_free_v5.0",
      symbols_fetched: data.length,
      spy: { 
        price: qMap['SPY']?.price || 0, 
        changePct: qMap['SPY']?.changesPercentage || 0 
      },
      sectors,
      portfolio: PORT_SYMS.map(s => ({
        sym: s,
        price: qMap[s]?.price || 0,
        changePct: qMap[s]?.changesPercentage || 0
      }))
    };

    res.setHeader('Cache-Control', `s-maxage=${CACHE_SECONDS}, stale-while-revalidate`);
    return res.status(200).json(output);

  } catch (err) {
    return res.status(500).json({ error: "Proxy Crash", message: err.message });
  }
}
