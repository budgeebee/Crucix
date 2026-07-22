import { safeFetch } from '../utils/fetch.mjs';

const GDACS_RSS = 'https://www.gdacs.org/xml/rss.xml';

function stripCdata(s) {
  return (s || '').replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '').trim();
}

function rawFetchText(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Crucix/1.0', 'Accept': 'application/rss+xml, application/xml, text/xml' } })
      .then(r => {
        clearTimeout(t);
        if (!r.ok) return reject(new Error(`HTTP ${r.status}`));
        return r.text();
      })
      .then(resolve)
      .catch(e => { clearTimeout(t); reject(e); });
  });
}

function parseRss(xml) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const get = (tag) => {
      const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
      const r = block.match(re);
      return r ? stripCdata(r[1]) : '';
    };
    items.push({
      title: get('title'),
      description: get('description'),
      link: get('link'),
      pubDate: get('pubDate'),
      guid: get('guid'),
      category: get('category'),
    });
  }
  return items;
}

function detectSeverity(text) {
  if (!text) return 'Green';
  const t = text.toLowerCase();
  if (t.includes('red alert') || /\bred\b/.test(t)) return 'Red';
  if (t.includes('orange')) return 'Orange';
  return 'Green';
}

function detectType(text) {
  if (!text) return 'unknown';
  const t = text.toLowerCase();
  if (t.includes('earthquake')) return 'earthquake';
  if (t.includes('flood')) return 'flood';
  if (t.includes('cyclone') || t.includes('hurricane') || t.includes('typhoon')) return 'cyclone';
  if (t.includes('wildfire') || /\bfire\b/.test(t)) return 'wildfire';
  if (t.includes('volcano')) return 'volcano';
  if (t.includes('drought')) return 'drought';
  if (t.includes('tsunami')) return 'tsunami';
  return 'other';
}

export async function briefing() {
  let xml;
  try {
    xml = await rawFetchText(GDACS_RSS);
  } catch (e) {
    return {
      source: 'GDACS',
      timestamp: new Date().toISOString(),
      status: 'error',
      error: e.message,
      events: [],
      signals: [],
    };
  }

  if (!xml || !xml.includes('<item>')) {
    return {
      source: 'GDACS',
      timestamp: new Date().toISOString(),
      status: 'ok',
      totalEvents: 0,
      note: 'Feed returned no items',
      events: [],
      signals: [],
    };
  }

  const items = parseRss(xml);
  const events = items
    .filter(it => it.title)
    .map((it, idx) => {
      const sev = detectSeverity(`${it.title} ${it.category} ${it.description}`);
      const type = detectType(`${it.title} ${it.description}`);
      return {
        id: it.guid || `gdacs-rss-${idx}`,
        title: it.title,
        description: it.description?.slice(0, 500),
        link: it.link,
        pubDate: it.pubDate,
        category: it.category,
        type,
        severity: sev,
      };
    });

  const red = events.filter(e => e.severity === 'Red');
  const orange = events.filter(e => e.severity === 'Orange');
  const byType = {};
  for (const e of events) byType[e.type] = (byType[e.type] || 0) + 1;

  const signals = [
    ...red.slice(0, 5).map(e => ({ kind: 'gdacs_red', label: `RED: ${e.title}`, type: e.type, date: e.pubDate, link: e.link, severity: e.severity })),
    ...orange.slice(0, 5).map(e => ({ kind: 'gdacs_orange', label: `ORANGE: ${e.title}`, type: e.type, date: e.pubDate, link: e.link, severity: e.severity })),
  ];

  return {
    source: 'GDACS',
    timestamp: new Date().toISOString(),
    status: 'ok',
    totalEvents: events.length,
    redCount: red.length,
    orangeCount: orange.length,
    byType,
    events: events.slice(0, 30),
    signals,
  };
}

if (process.argv[1]?.endsWith('gdacs.mjs')) {
  console.log(JSON.stringify(await briefing(), null, 2));
}