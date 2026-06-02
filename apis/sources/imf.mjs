// IMF World Economic Outlook forecasts via DataMapper API
// No API key required. GDP growth and CPI forecasts for major economies.

import { safeFetch } from '../utils/fetch.mjs';

const BASE = 'https://www.imf.org/external/datamapper/api/v1';
const COUNTRIES = 'USA/CHN/DEU/JPN/GBR/IND/BRA/EUQ';
const COUNTRY_NAMES = {
  USA: 'United States', CHN: 'China', DEU: 'Germany', JPN: 'Japan',
  GBR: 'United Kingdom', IND: 'India', BRA: 'Brazil', EUQ: 'Euro Area',
};

const CURRENT_YEAR = new Date().getFullYear();
const PERIODS = `${CURRENT_YEAR - 1},${CURRENT_YEAR},${CURRENT_YEAR + 1}`;

async function fetchIndicator(indicator) {
  const data = await safeFetch(
    `${BASE}/${indicator}/${COUNTRIES}?periods=${PERIODS}`,
    { timeout: 20000 }
  );
  return data?.values?.[indicator] || {};
}

function extractValues(raw) {
  const out = {};
  for (const [code, years] of Object.entries(raw)) {
    const name = COUNTRY_NAMES[code];
    if (!name) continue;
    const vals = {};
    for (const yr of PERIODS.split(',')) {
      if (years[yr] !== undefined && years[yr] !== null) {
        vals[yr] = Math.round(years[yr] * 10) / 10;
      }
    }
    if (Object.keys(vals).length > 0) out[code] = { country: name, ...vals };
  }
  return out;
}

export async function briefing() {
  const [gdpRaw, cpiRaw] = await Promise.all([
    fetchIndicator('NGDP_RPCH'),  // Real GDP growth (%)
    fetchIndicator('PCPIPCH'),    // CPI inflation (%)
  ]);

  const gdp = extractValues(gdpRaw);
  const cpi = extractValues(cpiRaw);

  const signals = [];
  const thisYear = String(CURRENT_YEAR);
  const nextYear = String(CURRENT_YEAR + 1);

  for (const [code, d] of Object.entries(gdp)) {
    const cur = d[thisYear], nxt = d[nextYear];
    if (cur !== undefined && cur < 0) signals.push(`${d.country}: IMF forecasts ${cur}% GDP growth ${thisYear} — contraction`);
    if (cur !== undefined && nxt !== undefined && nxt - cur < -1.5) {
      signals.push(`${d.country}: IMF sees sharp growth slowdown ${thisYear}→${nextYear} (${cur}%→${nxt}%)`);
    }
  }
  for (const [code, d] of Object.entries(cpi)) {
    const cur = d[thisYear];
    if (cur !== undefined && cur > 5) signals.push(`${d.country}: IMF forecasts ${cur}% CPI ${thisYear} — elevated inflation`);
  }

  return {
    source: 'IMF',
    timestamp: new Date().toISOString(),
    note: 'WEO forecasts — forward-looking, updated twice yearly',
    gdp_growth_forecast: gdp,
    cpi_forecast: cpi,
    signals,
  };
}

if (process.argv[1]?.endsWith('imf.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
