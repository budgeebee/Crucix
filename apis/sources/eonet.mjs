import { safeFetch } from '../utils/fetch.mjs';

const EONET_BASE = 'https://eonet.gsfc.nasa.gov/api/v3';

const SEVERITY_RANK = { 'Extreme': 5, 'Severe': 4, 'Moderate': 3, 'Minor': 2, 'Unknown': 1 };

function compactEvent(e) {
  const geo = e.geometry?.[0];
  return {
    id: e.id,
    title: e.title,
    category: e.categories?.[0]?.title || 'Other',
    categoryId: e.categories?.[0]?.id || null,
    status: e.status,
    lat: geo?.coordinates?.[1] ?? null,
    lon: geo?.coordinates?.[0] ?? null,
    date: geo?.date || e.geometry?.[0]?.date,
    source: e.sources?.[0]?.id || null,
    link: e.sources?.[0]?.url || null,
  };
}

export async function briefing() {
  const url = `${EONET_BASE}/events?status=open&limit=100&days=30`;
  const data = await safeFetch(url, { timeout: 15000 });
  const raw = data?.events || [];
  const events = raw.map(compactEvent);

  const byCategory = {};
  for (const e of events) {
    byCategory[e.category] = (byCategory[e.category] || 0) + 1;
  }

  const volcanoEvents = events.filter(e => e.categoryId === 'volcanoes');
  const wildfireEvents = events.filter(e => e.categoryId === 'wildfires');
  const stormEvents = events.filter(e => e.categoryId === 'severeStorms' || e.categoryId === 'tropicalCyclones');

  const signals = [];
  for (const v of volcanoEvents.slice(0, 5)) {
    signals.push({ kind: 'volcano', label: `Volcano: ${v.title}`, lat: v.lat, lon: v.lon, date: v.date, link: v.link });
  }
  for (const w of wildfireEvents.slice(0, 5)) {
    if (signals.length >= 8) break;
    signals.push({ kind: 'wildfire', label: `Wildfire: ${w.title}`, lat: w.lat, lon: w.lon, date: w.date });
  }
  for (const s of stormEvents.slice(0, 5)) {
    if (signals.length >= 8) break;
    signals.push({ kind: 'storm', label: `Storm: ${s.title}`, lat: s.lat, lon: s.lon, date: s.date });
  }

  return {
    source: 'NASA EONET',
    timestamp: new Date().toISOString(),
    status: 'ok',
    totalOpen: events.length,
    byCategory,
    volcanoes: volcanoEvents.length,
    wildfires: wildfireEvents.length,
    severeStorms: stormEvents.length,
    events: events.slice(0, 30),
    signals,
  };
}

if (process.argv[1]?.endsWith('eonet.mjs')) {
  console.log(JSON.stringify(await briefing(), null, 2));
}