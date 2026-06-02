// World Bank — GDP growth and inflation for major economies
// No API key required. Annual data, typically lagged 6-12 months.

import { safeFetch } from '../utils/fetch.mjs';

const BASE = 'https://api.worldbank.org/v2';

// 2-letter country codes for World Bank API
const COUNTRIES = 'US;CN;DE;JP;GB;IN;BR';
const COUNTRY_NAMES = {
  US: 'United States', CN: 'China', DE: 'Germany',
  JP: 'Japan', GB: 'United Kingdom', IN: 'India', BR: 'Brazil',
};

async function fetchIndicator(indicator) {
  const params = new URLSearchParams({ format: 'json', mrv: '2' });
  const data = await safeFetch(
    `${BASE}/country/${COUNTRIES}/indicator/${indicator}?${params}`,
    { timeout: 15000 }
  );
  if (!Array.isArray(data) || data.length < 2 || !data[1]) return [];
  return data[1];
}

export async function briefing() {
  const [gdpRows, cpiRows] = await Promise.all([
    fetchIndicator('NY.GDP.MKTP.KD.ZG'),  // GDP growth (annual %)
    fetchIndicator('FP.CPI.TOTL.ZG'),     // CPI inflation (annual %)
  ]);

  const gdp = {}, cpi = {};
  for (const row of gdpRows) {
    const code = row.country?.id;
    if (!code || row.value === null) continue;
    if (!gdp[code] || row.date > gdp[code].date) {
      gdp[code] = { country: COUNTRY_NAMES[code] || code, value: Math.round(row.value * 10) / 10, year: row.date };
    }
  }
  for (const row of cpiRows) {
    const code = row.country?.id;
    if (!code || row.value === null) continue;
    if (!cpi[code] || row.date > cpi[code].date) {
      cpi[code] = { country: COUNTRY_NAMES[code] || code, value: Math.round(row.value * 10) / 10, year: row.date };
    }
  }

  const signals = [];
  for (const [code, d] of Object.entries(gdp)) {
    if (d.value < 0) signals.push(`${d.country}: GDP growth ${d.value}% (${d.year}) — recession`);
    if (d.value > 6) signals.push(`${d.country}: GDP growth ${d.value}% (${d.year}) — elevated growth`);
  }
  for (const [code, d] of Object.entries(cpi)) {
    if (d.value > 5) signals.push(`${d.country}: CPI inflation ${d.value}% (${d.year}) — elevated`);
  }

  return {
    source: 'WorldBank',
    timestamp: new Date().toISOString(),
    note: 'Annual data — context only, not real-time',
    gdp_growth: gdp,
    cpi_inflation: cpi,
    signals,
  };
}

if (process.argv[1]?.endsWith('worldbank.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
