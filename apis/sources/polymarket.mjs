import { safeFetch } from '../utils/fetch.mjs';

const GAMMA_BASE = 'https://gamma-api.polymarket.com';

const EXCLUDE_KEYWORDS = [
  'nba', 'nfl', 'mlb', 'nhl', 'fifa', 'ufc', 'olympics', 'super bowl',
  'grammy', 'oscar', 'emmy', 'movie', 'tv show', 'series finale',
  'kardashian', 'celebrity', 'met gala',
  'bitcoin price', 'eth price', 'btc price',
];

const GEO_TAGS = [
  'ukraine', 'russia', 'china', 'taiwan', 'iran', 'israel', 'gaza',
  'north korea', 'south korea', 'putin', 'zelensky', 'xi jinping',
  'trump', 'biden', 'harris', 'election', 'fed', 'fomc', 'powell',
  'oil', 'opec', 'recession', 'tariff', 'sanctions', 'nato', 'eu',
];

function isRelevant(q) {
  const t = `${q.question} ${q.description || ''} ${(q.tags || []).map(t => t.label || t).join(' ')}`.toLowerCase();
  if (EXCLUDE_KEYWORDS.some(k => t.includes(k))) return false;
  return GEO_TAGS.some(k => t.includes(k));
}

function categorize(q) {
  const t = q.question.toLowerCase();
  if (t.includes('bitcoin') || t.includes('btc') || t.includes('ethereum') || t.includes('crypto')) return 'crypto';
  if (t.includes('fed') || t.includes('rate') || t.includes('fomc') || t.includes('powell') || t.includes('inflation') || t.includes('cpi') || t.includes('gdp')) return 'macro';
  if (t.includes('oil') || t.includes('opec') || t.includes('wti') || t.includes('brent')) return 'energy';
  if (t.includes('election') || t.includes('president') || t.includes('senate') || t.includes('congress')) return 'politics';
  if (t.includes('ukraine') || t.includes('russia') || t.includes('china') || t.includes('taiwan') || t.includes('iran') || t.includes('israel') || t.includes('gaza') || t.includes('nato')) return 'geopolitics';
  return 'other';
}

function compactMarket(m) {
  const yesPrice = parseFloat(m.bestAsk ?? m.lastTradePrice ?? m.outcomePrices?.[0] ?? '0');
  const noPrice  = parseFloat(m.bestBid  ?? (m.outcomePrices?.[1] ?? '0'));
  return {
    id: m.id || m.conditionId || m.slug,
    slug: m.slug,
    question: m.question,
    description: m.description?.slice(0, 300) || '',
    category: categorize(m),
    yesPrice: Number.isFinite(yesPrice) ? yesPrice : null,
    noPrice: Number.isFinite(noPrice) ? noPrice : null,
    volume24hr: parseFloat(m.volume24hr || m.volumeNum || m.volume || 0),
    totalVolume: parseFloat(m.volume || m.volumeNum || 0),
    liquidity: parseFloat(m.liquidity || m.liquidityNum || 0),
    endDate: m.endDate || m.end_date_iso || null,
    active: m.active !== false && m.closed !== true,
    closed: Boolean(m.closed),
    tags: (m.tags || []).map(t => t.label || t.slug || t).filter(Boolean).slice(0, 5),
    url: m.slug ? `https://polymarket.com/event/${m.slug}` : null,
  };
}

export async function briefing() {
  let markets = [];
  try {
    const data = await safeFetch(
      `${GAMMA_BASE}/markets?closed=false&limit=200&order=volume24hr&ascending=false`,
      { timeout: 15000, headers: { 'Accept': 'application/json' } }
    );
    const raw = Array.isArray(data) ? data : (data?.data || data?.markets || []);
    markets = raw.map(compactMarket).filter(isRelevant);
  } catch (e) {
    return {
      source: 'Polymarket',
      timestamp: new Date().toISOString(),
      status: 'error',
      error: e.message,
      markets: [],
      signals: [],
    };
  }

  markets.sort((a, b) => (b.volume24hr || 0) - (a.volume24hr || 0));
  const top = markets.slice(0, 30);

  const byCategory = {};
  for (const m of markets) byCategory[m.category] = (byCategory[m.category] || 0) + 1;

  const highProbShifts = markets
    .filter(m => m.yesPrice != null && (m.yesPrice < 0.15 || m.yesPrice > 0.85))
    .sort((a, b) => (b.volume24hr || 0) - (a.volume24hr || 0))
    .slice(0, 10);

  const signals = top.slice(0, 8).map(m => ({
    kind: 'polymarket',
    label: `PM: ${m.question}`,
    category: m.category,
    yesPrice: m.yesPrice,
    noPrice: m.noPrice,
    volume24hr: m.volume24hr,
    endDate: m.endDate,
    url: m.url,
  }));

  return {
    source: 'Polymarket',
    timestamp: new Date().toISOString(),
    status: 'ok',
    totalRelevant: markets.length,
    byCategory,
    highProbShifts,
    top,
    signals,
  };
}

if (process.argv[1]?.endsWith('polymarket.mjs')) {
  console.log(JSON.stringify(await briefing(), null, 2));
}