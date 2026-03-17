// AbuseIPDB — IP reputation and abuse reporting
// Free API key from https://www.abuseipdb.com/
// Provides: most reported IPs, abuse trends, attack source countries
// Useful for detecting coordinated cyber campaigns and infrastructure targeting

import { safeFetch } from '../utils/fetch.mjs';

const BASE = 'https://api.abuseipdb.com/api/v2';

function headers(apiKey) {
  return {
    'Key': apiKey,
    'Accept': 'application/json',
  };
}

// Get the blacklist (most abusive IPs globally)
async function getBlacklist(apiKey, limit = 50) {
  return safeFetch(`${BASE}/blacklist?limit=${limit}&confidenceMinimum=90`, {
    headers: headers(apiKey),
    timeout: 15000,
  });
}

// Check a specific IP
async function checkIP(apiKey, ip) {
  return safeFetch(`${BASE}/check?ipAddress=${encodeURIComponent(ip)}&maxAgeInDays=30&verbose`, {
    headers: headers(apiKey),
    timeout: 10000,
  });
}

// Analyze blacklist for patterns
function analyzeBlacklist(entries) {
  if (!Array.isArray(entries)) return { signals: [] };

  const byCountry = {};
  const byAbuse = {};
  const signals = [];
  let totalReports = 0;

  for (const entry of entries) {
    const cc = entry.countryCode || 'Unknown';
    byCountry[cc] = (byCountry[cc] || 0) + 1;
    totalReports += entry.totalReports || 0;

    // Track abuse types from categories
    for (const cat of (entry.categories || [])) {
      byAbuse[cat] = (byAbuse[cat] || 0) + 1;
    }
  }

  // Top attack source countries
  const topCountries = Object.entries(byCountry)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([country, count]) => ({ country, count }));

  // Signal: concentration from specific countries
  for (const { country, count } of topCountries) {
    if (count >= entries.length * 0.2) {
      signals.push(`${country} accounts for ${((count / entries.length) * 100).toFixed(0)}% of top abusive IPs`);
    }
  }

  // AbuseIPDB categories: 18=brute force, 14=port scan, 15=hacking, 21=web attack, 22=SSH, 23=IoT
  const CATEGORY_NAMES = {
    3: 'Fraud', 4: 'DDoS', 5: 'FTP Brute Force', 10: 'Web Spam',
    14: 'Port Scan', 15: 'Hacking', 18: 'Brute Force', 21: 'Web Attack',
    22: 'SSH Abuse', 23: 'IoT Targeted',
  };

  const topAbuse = Object.entries(byAbuse)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([cat, count]) => ({ category: CATEGORY_NAMES[cat] || `Cat-${cat}`, count }));

  return {
    totalBlacklistedIPs: entries.length,
    totalReports,
    topAttackSources: topCountries,
    topAbuseTypes: topAbuse,
    highConfidenceIPs: entries.filter(e => (e.abuseConfidenceScore || 0) >= 100).length,
    signals,
  };
}

export async function briefing() {
  const apiKey = process.env.ABUSEIPDB_API_KEY;
  if (!apiKey) {
    return {
      source: 'AbuseIPDB',
      timestamp: new Date().toISOString(),
      error: 'ABUSEIPDB_API_KEY not set',
      hint: 'Get a free API key at https://www.abuseipdb.com/',
    };
  }

  const blacklist = await getBlacklist(apiKey, 100);
  const entries = blacklist?.data || [];

  if (blacklist?.error || blacklist?.errors) {
    return {
      source: 'AbuseIPDB',
      timestamp: new Date().toISOString(),
      error: blacklist.error || JSON.stringify(blacklist.errors),
    };
  }

  const analysis = analyzeBlacklist(entries);

  return {
    source: 'AbuseIPDB',
    timestamp: new Date().toISOString(),
    ...analysis,
  };
}

if (process.argv[1]?.endsWith('abuseipdb.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
