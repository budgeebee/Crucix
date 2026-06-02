// CFTC Commitments of Traders (COT)
// Weekly futures positioning for key markets — no API key required.
// Shows net speculator (non-commercial) and commercial positions.

import { safeFetch, daysAgo } from '../utils/fetch.mjs';

const BASE = 'https://publicreporting.cftc.gov/resource/6dca-aqww.json';

const MARKETS = {
  '067651': 'WTI Crude Oil',
  '088691': 'Gold',
  '13874A': 'E-Mini S&P 500',
  '209742': 'Nasdaq Mini',
  '043602': 'UST 10Y Note',
  '099741': 'Euro FX (EUR/USD)',
  '133741': 'Bitcoin',
};

const CODES = Object.keys(MARKETS).map(c => `'${c}'`).join(',');

export async function briefing() {
  const params = new URLSearchParams({
    '$limit': '30',
    '$order': 'report_date_as_yyyy_mm_dd DESC',
    '$where': `cftc_contract_market_code IN(${CODES})`,
    '$select': [
      'cftc_contract_market_code', 'contract_market_name',
      'report_date_as_yyyy_mm_dd',
      'noncomm_positions_long_all', 'noncomm_positions_short_all',
      'comm_positions_long_all', 'comm_positions_short_all',
      'open_interest_all',
      'change_in_noncomm_long_all', 'change_in_noncomm_short_all',
    ].join(','),
  });

  const rows = await safeFetch(`${BASE}?${params}`, { timeout: 20000 });
  if (!Array.isArray(rows)) {
    return { source: 'CFTC', error: rows?.error || 'unexpected response' };
  }

  // Group by contract code, keep 2 most recent per market
  const byCode = {};
  for (const row of rows) {
    const code = row.cftc_contract_market_code;
    if (!byCode[code]) byCode[code] = [];
    if (byCode[code].length < 2) byCode[code].push(row);
  }

  const positions = [];
  const signals = [];

  for (const [code, label] of Object.entries(MARKETS)) {
    const recs = byCode[code];
    if (!recs?.length) continue;

    const cur = recs[0];
    const prev = recs[1];

    const specLong  = parseInt(cur.noncomm_positions_long_all  || 0);
    const specShort = parseInt(cur.noncomm_positions_short_all || 0);
    const specNet   = specLong - specShort;
    const oi        = parseInt(cur.open_interest_all || 0);
    const netPct    = oi > 0 ? Math.round(specNet / oi * 100) : null;

    const prevLong  = prev ? parseInt(prev.noncomm_positions_long_all  || 0) : null;
    const prevShort = prev ? parseInt(prev.noncomm_positions_short_all || 0) : null;
    const prevNet   = prev ? prevLong - prevShort : null;
    const netChange = prevNet !== null ? specNet - prevNet : null;

    const entry = {
      market: label,
      week_ending: cur.report_date_as_yyyy_mm_dd?.split('T')[0],
      spec_net: specNet,
      spec_net_pct_oi: netPct,
      spec_long: specLong,
      spec_short: specShort,
      open_interest: oi,
      wow_net_change: netChange,
    };
    positions.push(entry);

    // Signals: extreme positioning (>25% net) or large weekly shift (>5% OI swing)
    if (netPct !== null && Math.abs(netPct) > 25) {
      const dir = specNet > 0 ? 'NET LONG' : 'NET SHORT';
      signals.push(`${label}: Speculators ${dir} (${netPct}% of OI) — extreme positioning`);
    }
    if (netChange !== null && oi > 0 && Math.abs(netChange / oi) > 0.05) {
      const dir = netChange > 0 ? 'adding longs' : 'adding shorts';
      signals.push(`${label}: Speculators ${dir} rapidly (${netChange > 0 ? '+' : ''}${netChange} WoW)`);
    }
  }

  return {
    source: 'CFTC',
    timestamp: new Date().toISOString(),
    note: 'COT weekly report — speculator (non-commercial) positioning',
    positions,
    signals,
  };
}

if (process.argv[1]?.endsWith('cftc.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
