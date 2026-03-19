// ═══════════════════════════════════════════════════════════════
// NERVA MARKET — Vercel Serverless Proxy
// /api/market.js — v4.7: FMP STABLE API MIGRATION
// ═══════════════════════════════════════════════════════════════

const CACHE_SECONDS = 60;
const FMP_KEY = process.env.FMP_KEY;

// Using the new FMP Stable Base URL
const FMP_STABLE = 'https://financialmodelingprep.com/stable';

const SECTOR_SYMS = ['XLK','XLF','XLE','XLV','XLI','XLY','XLP','XLU','XLB','XLRE','XLC'];
const PORT_SYMS = ['VGT', 'GDX', 'QBTS', 'VYM'];
const UNIVERSE_SYMS = ['NVDA','AAPL','MSFT','GOOGL','AMZN','META','TSLA','AMD','AVGO','LLY','JPM','V','UNH','XOM','COST','IONQ','RGTI','PLTR','COIN','SNOW','PANW','CRWD','NET','SQ','SHOP'];
const ALL_SYMS = ['SPY', 'QQQ', '^VIX', '^TNX', ...SECTOR_SYMS, ...PORT_SYMS, ...UNIVERSE_SYMS];

export default async function handler(req, res) {
  if (!FMP_KEY) {
    return res.status(500).json({ 
      error: "FMP_KEY not set", 
      message: "Add FMP_KEY environment variable in Vercel dashboard." 
    });
  }

  try {
    // 1. Fetch Bulk Quotes using /stable/quote
    const quoteUrl = `${FMP_STABLE}/quote?symbols=${ALL_SYMS.join(',')}&apikey=${FMP_KEY}`;
    const quoteResp = await fetch(quoteUrl);
    const quotes = await quoteResp.json();

    if (!Array.isArray(quotes)) {
      return res.status(quoteResp.status).json({
        error: "FMP returned non-array response",
        fmp_status: quoteResp.status,
        fmp_response: quotes,
        timestamp: new Date().toISOString()
      });
    }

    const qMap = Object.fromEntries(quotes.map(q => [q.symbol, q]));

    // 2. Map Sectors
    const sectors = {};
    SECTOR_SYMS.forEach(s => {
      sectors[s] = qMap[s]?.changesPercentage || 0;
    });

    // 3. Build Final Response
    const data = {
      timestamp: new Date().toISOString(),
      source: "financial_modeling_prep_stable",
      symbols_fetched: quotes.length,
      spy: {
        price: qMap['SPY']?.price || 0,
        changePct: qMap['SPY']?.changesPercentage || 0,
        rsi: 55 // Placeholder for now
      },
      vix: {
        level: qMap['^VIX']?.price || 16,
        changePct: qMap['^VIX']?.changesPercentage || 0
      },
      sectors,
      portfolio: PORT_SYMS.map(s => ({
        sym: s,
        price: qMap[s]?.price || 0,
        changePct: qMap[s]?.changesPercentage || 0,
        sma50: qMap[s]?.priceAvg50 || 0,
        sma200: qMap[s]?.priceAvg200 || 0
      })),
      universe: UNIVERSE_SYMS.map(s => ({
        sym: s,
        price: qMap[s]?.price || 0,
        changePct: qMap[s]?.changesPercentage || 0
      }))
    };

    res.setHeader('Cache-Control', `s-maxage=${CACHE_SECONDS}, stale-while-revalidate`);
    return res.status(200).json(data);

  } catch (err) {
    return res.status(500).json({ error: "Proxy Crash", message: err.message });
  }
}
