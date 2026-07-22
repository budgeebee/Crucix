import { safeFetch } from '../utils/fetch.mjs';

const ECB_BASE = 'https://data-api.ecb.europa.eu/service/data';

const SERIES = [
  { key: 'ecb_mrr',     label: 'ECB Main Refinancing Rate', flow: 'FM',  key2: 'B.U2.EUR.4F.KR.MRR_FR.LEV' },
  { key: 'ecb_deposit', label: 'ECB Deposit Facility Rate', flow: 'FM',  key2: 'B.U2.EUR.4F.KR.DFR.LEV' },
  { key: 'ecb_mlfr',    label: 'ECB Marginal Lending Rate', flow: 'FM',  key2: 'B.U2.EUR.4F.KR.MLFR.LEV' },
  { key: 'eurusd',      label: 'EUR/USD Reference Rate',    flow: 'EXR', key2: 'D.USD.EUR.SP00.A' },
  { key: 'eurgbp',      label: 'EUR/GBP Reference Rate',    flow: 'EXR', key2: 'D.GBP.EUR.SP00.A' },
  { key: 'eurjpy',      label: 'EUR/JPY Reference Rate',    flow: 'EXR', key2: 'D.JPY.EUR.SP00.A' },
  { key: 'eurchf',      label: 'EUR/CHF Reference Rate',    flow: 'EXR', key2: 'D.CHF.EUR.SP00.A' },
];

function rawFetchText(url, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Crucix/1.0', 'Accept': 'text/csv' } })
      .then(r => {
        clearTimeout(t);
        if (!r.ok) return reject(new Error(`HTTP ${r.status}`));
        return r.text();
      })
      .then(resolve)
      .catch(e => { clearTimeout(t); reject(e); });
  });
}

function parseCsv(csv) {
  const lines = csv.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const header = lines[0].split(',');
  const dateIdx = header.indexOf('TIME_PERIOD');
  const valIdx  = header.indexOf('OBS_VALUE');
  if (dateIdx === -1 || valIdx === -1) return [];
  const obs = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const date = cols[dateIdx];
    const v = cols[valIdx];
    if (!date || !v || v === 'NaN') continue;
    const n = parseFloat(v);
    if (!Number.isFinite(n)) continue;
    obs.push({ date, value: n });
  }
  return obs;
}

async function fetchSeries(spec, n = 30) {
  const url = `${ECB_BASE}/${spec.flow}/${spec.key2}?lastNObservations=${n}&format=csvdata`;
  try {
    const csv = await rawFetchText(url);
    if (!csv || csv.startsWith('{')) {
      try { const j = JSON.parse(csv); return { key: spec.key, label: spec.label, error: j.detail || j.title || `HTTP ${j.status}` }; } catch { return { key: spec.key, label: spec.label, error: 'Empty response' }; }
    }
    const obs = parseCsv(csv);
    if (obs.length === 0) return { key: spec.key, label: spec.label, error: 'No observations parsed' };
    obs.sort((a, b) => b.date.localeCompare(a.date));
    const latest = obs[0];
    const prev = obs[1] || obs[0];
    const change = latest.value - prev.value;
    const changePct = prev.value !== 0 ? (change / prev.value) * 100 : 0;
    return {
      key: spec.key,
      label: spec.label,
      id: spec.key,
      date: latest.date,
      value: latest.value,
      previousValue: prev.value,
      change: Number(change.toFixed(6)),
      changePct: Number(changePct.toFixed(4)),
      recent: obs.slice(0, 10).reverse(),
    };
  } catch (e) {
    return { key: spec.key, label: spec.label, error: e.message };
  }
}

export async function briefing() {
  const results = await Promise.allSettled(SERIES.map(s => fetchSeries(s)));
  const rates = results.map(r => r.status === 'fulfilled' ? r.value : null).filter(Boolean);

  const policyRates = rates.filter(r => r.key?.startsWith('ecb_'));
  const fxRates = rates.filter(r => r.key && !r.key.startsWith('ecb_'));

  const signals = [];
  const dep = policyRates.find(r => r.key === 'ecb_deposit');
  if (dep && dep.value != null) {
    signals.push({ kind: 'ecb_policy', label: `ECB Deposit=${dep.value.toFixed(2)}% (${dep.change >= 0 ? '+' : ''}${dep.change.toFixed(2)})`, value: dep.value, change: dep.change, changePct: dep.changePct, series: 'deposit' });
  }
  const mrr = policyRates.find(r => r.key === 'ecb_mrr');
  if (mrr && mrr.value != null) {
    signals.push({ kind: 'ecb_policy', label: `ECB MRR=${mrr.value.toFixed(2)}% (${mrr.change >= 0 ? '+' : ''}${mrr.change.toFixed(2)})`, value: mrr.value, change: mrr.change, changePct: mrr.changePct, series: 'mrr' });
  }
  const eur = fxRates.find(r => r.key === 'eurusd');
  if (eur && eur.value != null) {
    signals.push({ kind: 'fx', label: `EUR/USD=${eur.value.toFixed(4)} (${eur.changePct >= 0 ? '+' : ''}${eur.changePct.toFixed(2)}%)`, value: eur.value, changePct: eur.changePct, pair: 'EUR/USD' });
  }
  const eurJpy = fxRates.find(r => r.key === 'eurjpy');
  if (eurJpy && eurJpy.value != null) {
    signals.push({ kind: 'fx', label: `EUR/JPY=${eurJpy.value.toFixed(2)} (${eurJpy.changePct >= 0 ? '+' : ''}${eurJpy.changePct.toFixed(2)}%)`, value: eurJpy.value, changePct: eurJpy.changePct, pair: 'EUR/JPY' });
  }

  return {
    source: 'ECB',
    timestamp: new Date().toISOString(),
    status: 'ok',
    policyRates,
    fxRates,
    rates,
    signals,
  };
}

if (process.argv[1]?.endsWith('ecb.mjs')) {
  console.log(JSON.stringify(await briefing(), null, 2));
}