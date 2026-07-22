import { safeFetch } from '../utils/fetch.mjs';

const USGS_BASE = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary';

const FEEDS = [
  { key: 'significant_week', url: `${USGS_BASE}/significant_week.geojson`, minMag: 0, label: 'Significant (week)' },
  { key: '4.5_week',         url: `${USGS_BASE}/4.5_week.geojson`,         minMag: 4.5, label: 'M4.5+ (week)' },
  { key: '2.5_day',          url: `${USGS_BASE}/2.5_day.geojson`,          minMag: 2.5, label: 'M2.5+ (day)' },
];

function compactQuake(f) {
  return {
    id: f.id,
    mag: f.properties.mag,
    place: f.properties.place,
    time: new Date(f.properties.time).toISOString(),
    url: f.properties.url,
    lat: f.geometry.coordinates[1],
    lon: f.geometry.coordinates[0],
    depthKm: f.geometry.coordinates[2],
    type: f.properties.type,
    felt: f.properties.felt || null,
    tsunami: Boolean(f.properties.tsunami),
    alert: f.properties.alert || null,
  };
}

function regionKey(place = '') {
  const p = place.toLowerCase();
  if (p.includes('california') || p.includes('nevada') || p.includes('oregon') || p.includes('alaska') || p.includes('mexico') || p.includes('cascadia')) return 'Americas';
  if (p.includes('japan') || p.includes('indonesia') || p.includes('philippines') || p.includes('taiwan') || p.includes('tonga') || p.includes('fiji')) return 'Asia-Pacific';
  if (p.includes('iran') || p.includes('iraq') || p.includes('turkey') || p.includes('greece') || p.includes('italy') || p.includes('romania')) return 'Eurasia';
  if (p.includes('chile') || p.includes('peru') || p.includes('argentina')) return 'SouthAmerica';
  if (p.includes('atlantic') || p.includes('mid-atlantic') || p.includes('iceland') || p.includes('azores')) return 'Atlantic';
  if (p.includes('africa') || p.includes('ethiopia') || p.includes('kenya') || p.includes('tanzania')) return 'Africa';
  return 'Other';
}

export async function briefing() {
  const allEvents = [];
  const feedStats = [];

  for (const feed of FEEDS) {
    try {
      const data = await safeFetch(feed.url, { timeout: 12000 });
      const features = data?.features || [];
      feedStats.push({ feed: feed.key, count: features.length });
      for (const f of features) {
        if ((f.properties?.mag ?? 0) < feed.minMag) continue;
        const q = compactQuake(f);
        q.region = regionKey(q.place);
        q.sourceFeed = feed.key;
        allEvents.push(q);
      }
    } catch (e) {
      feedStats.push({ feed: feed.key, error: e.message });
    }
  }

  const dedup = new Map();
  for (const q of allEvents) {
    if (!dedup.has(q.id)) dedup.set(q.id, q);
  }
  const events = [...dedup.values()].sort((a, b) => b.time.localeCompare(a.time));

  const major = events.filter(e => e.mag >= 5.5);
  const byRegion = {};
  for (const e of events) {
    byRegion[e.region] = (byRegion[e.region] || 0) + 1;
  }

  const tsunamiRelevant = events.filter(e => e.tsunami || (e.mag >= 6.5 && e.depthKm < 100));
  const signals = major.slice(0, 8).map(e => ({
    kind: 'earthquake',
    label: `M${e.mag.toFixed(1)} ${e.place?.split(',').pop()?.trim() || 'event'}`,
    magnitude: e.mag,
    region: e.region,
    time: e.time,
    tsunami: e.tsunami,
    depthKm: e.depthKm,
    url: e.url,
  }));

  return {
    source: 'USGS',
    timestamp: new Date().toISOString(),
    status: 'ok',
    feeds: feedStats,
    totalEvents: events.length,
    majorCount: major.length,
    tsunamiFlagged: tsunamiRelevant.length,
    byRegion,
    events: events.slice(0, 40),
    majorEvents: major.slice(0, 10),
    signals,
  };
}

if (process.argv[1]?.endsWith('usgs.mjs')) {
  console.log(JSON.stringify(await briefing(), null, 2));
}