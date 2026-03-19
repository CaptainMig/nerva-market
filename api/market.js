// ═══════════════════════════════════════════════════════════════
// NERVA MARKET — Vercel Serverless Proxy
// /api/market.js — v5.1: Finnhub "Smart Loop" Version
// ═══════════════════════════════════════════════════════════════

const FINNHUB_KEY = process.env.FINNHUB_KEY;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const SECTOR_SYMS = ['XLK','XLF','XLE','XLV','XLI','XLY','XLP','XLU','XLB','XLRE','XLC'];
const PORT_SYMS = ['VGT', 'GDX', 'QBTS', 'VYM'];
const ALL_SYMS = ['SPY', 'QQQ', '^VIX', ...SECTOR_SYMS, ...PORT_SYMS];

export default async function handler(req, res) {
  if (!FINNHUB_KEY) return res.status(500).json({ error: "FINNHUB_KEY missing in Vercel" });

  try {
    const results = {};
    
    // Smart Loop: Fetches symbols individually to avoid "Bulk Paywalls"
    for (const sym of ALL_SYMS) {
      const url = `https://finnhub.io/api/v1/quote?symbol=${sym}&token=${FINNHUB_KEY}`;
      const resp = await fetch(url);
      const data = await resp.json();
      
      // Finnhub maps: c = current price, dp = change percentage
      results[sym] = {
        price: data.c || 0,
        changePct: data.dp || 0
      };
      
      await sleep(50); // 50ms delay keeps us safe from rate limits
    }

    const sectors = {};
    SECTOR_SYMS.forEach(s => { sectors[s] = results[s].changePct; });

    const output = {
      timestamp: new Date().toISOString(),
      source: "finnhub_v5.1_stable",
      spy: results['SPY'],
      vix: { level: results['^VIX']?.price || 16 },
      sectors,
      portfolio: PORT_SYMS.map(s => ({
        sym: s,
        price: results[s].price,
        changePct: results[s].changePct
      }))
    };

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate');
    return res.status(200).json(output);

  } catch (err) {
    return res.status(500).json({ error: "Proxy Crash", message: err.message });
  }
}
