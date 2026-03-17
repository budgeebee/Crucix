// AlienVault OTX (Open Threat Exchange) — Cyber threat intelligence
// Free API key from https://otx.alienvault.com/
// Provides: threat pulses, indicators of compromise, targeted malware, infrastructure-related threats

import { safeFetch } from '../utils/fetch.mjs';

const BASE = 'https://otx.alienvault.com/api/v1';

function headers(apiKey) {
  return apiKey ? { 'X-OTX-API-KEY': apiKey } : {};
}

// Get recent threat pulses (subscribed feed)
async function getSubscribedPulses(apiKey, limit = 20) {
  return safeFetch(`${BASE}/pulses/subscribed?limit=${limit}&modified_since=${daysAgoISO(1)}`, {
    headers: headers(apiKey),
    timeout: 45000,
  });
}

// Get recent pulses from the global feed
async function getActivityFeed(apiKey, limit = 20) {
  return safeFetch(`${BASE}/pulses/activity?limit=${limit}`, {
    headers: headers(apiKey),
    timeout: 45000,
  });
}

function daysAgoISO(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

// Categorize pulses by threat type and extract signals
function analyzePulses(pulses) {
  if (!Array.isArray(pulses)) return { threats: [], signals: [] };

  const byTag = {};
  const byTargeted = {};
  const signals = [];

  for (const p of pulses) {
    // Count by tag
    for (const tag of (p.tags || [])) {
      byTag[tag] = (byTag[tag] || 0) + 1;
    }
    // Count by targeted country/industry
    for (const ind of (p.targeted_countries || [])) {
      byTargeted[ind] = (byTargeted[ind] || 0) + 1;
    }
  }

  // Signal: high volume of pulses targeting specific countries
  for (const [country, count] of Object.entries(byTargeted)) {
    if (count >= 3) {
      signals.push(`${count} threat pulses targeting ${country} in last 24h`);
    }
  }

  // Signal: trending threat tags
  const topTags = Object.entries(byTag)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([tag, count]) => ({ tag, count }));

  // Signal: critical infrastructure threats
  const infraKeywords = ['scada', 'ics', 'power grid', 'energy', 'pipeline', 'financial', 'banking', 'defense'];
  const infraThreats = pulses.filter(p =>
    (p.tags || []).some(t => infraKeywords.some(k => t.toLowerCase().includes(k))) ||
    (p.name || '').toLowerCase().match(/scada|ics|energy|pipeline|financial|banking|defense/)
  );
  if (infraThreats.length > 0) {
    signals.push(`${infraThreats.length} critical infrastructure threat pulses detected`);
  }

  return {
    totalPulses: pulses.length,
    topTags,
    targetedCountries: byTargeted,
    recentThreats: pulses.slice(0, 10).map(p => ({
      name: p.name,
      description: (p.description || '').slice(0, 200),
      created: p.created,
      modified: p.modified,
      tags: (p.tags || []).slice(0, 5),
      targetedCountries: p.targeted_countries || [],
      adversary: p.adversary || null,
      indicatorCount: (p.indicators || []).length,
      tlp: p.tlp || 'white',
    })),
    infraThreats: infraThreats.length,
    signals,
  };
}

export async function briefing() {
  const apiKey = process.env.OTX_API_KEY;
  if (!apiKey) {
    return {
      source: 'OTX',
      timestamp: new Date().toISOString(),
      error: 'OTX_API_KEY not set',
      hint: 'Get a free API key at https://otx.alienvault.com/',
    };
  }

  const feed = await getActivityFeed(apiKey, 10);
  const pulses = feed?.results || feed?.pulses || [];

  if (feed?.error) {
    return {
      source: 'OTX',
      timestamp: new Date().toISOString(),
      error: feed.error,
    };
  }

  const analysis = analyzePulses(pulses);

  return {
    source: 'OTX',
    timestamp: new Date().toISOString(),
    ...analysis,
  };
}

if (process.argv[1]?.endsWith('otx.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
