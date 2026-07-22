import { safeFetch } from '../utils/fetch.mjs';

const ADVISORY_SOURCES = [
  { key: 'uk_fcdo', label: 'UK FCDO', country: 'United Kingdom', url: 'https://www.gov.uk/foreign-travel-advice.atom', kind: 'atom' },
];

const LEVEL_RANK = { 'Do Not Travel': 4, 'Reconsider Travel': 3, 'Exercise Increased Caution': 2, 'Exercise Normal Precautions': 1, 'Unknown': 0 };

function stripCdata(s) {
  return (s || '').replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '').trim();
}

function stripHtml(s) {
  return stripCdata(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function rawFetchText(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Crucix/1.0', 'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml' } })
      .then(r => {
        clearTimeout(t);
        if (!r.ok) return reject(new Error(`HTTP ${r.status}`));
        return r.text();
      })
      .then(resolve)
      .catch(e => { clearTimeout(t); reject(e); });
  });
}

function parseAtom(xml) {
  const items = [];
  const re = /<entry>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const titleMatch = block.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const summaryMatch = block.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i);
    let link = '';
    const linkMatch = block.match(/<link[^>]*rel="alternate"[^>]*href="([^"]+)"/i) || block.match(/<link[^>]*href="([^"]+)"[^>]*\/>/i);
    if (linkMatch) link = linkMatch[1];
    const updatedMatch = block.match(/<updated[^>]*>([\s\S]*?)<\/updated>/i);
    const publishedMatch = block.match(/<published[^>]*>([\s\S]*?)<\/published>/i);
    const idMatch = block.match(/<id[^>]*>([\s\S]*?)<\/id>/i);
    items.push({
      title: stripCdata(titleMatch?.[1] || '').trim(),
      description: stripCdata(summaryMatch?.[1] || '').trim(),
      link,
      pubDate: stripCdata(updatedMatch?.[1] || publishedMatch?.[1] || ''),
      guid: stripCdata(idMatch?.[1] || ''),
    });
  }
  return items;
}

function detectLevel(description) {
  if (!description) return 'Unknown';
  const t = stripHtml(description).toLowerCase();
  if (/\b(advise|advises|advised) against all (travel|but essential travel)\b/.test(t)) {
    if (/\bagainst all travel\b/.test(t) && !/\bexcept\b/.test(t)) return 'Do Not Travel';
    return 'Do Not Travel';
  }
  if (/\b(advise|advises|advised) against all but essential travel\b/.test(t)) return 'Reconsider Travel';
  if (/\bavoid all but essential travel\b/.test(t)) return 'Reconsider Travel';
  if (/\b(advise|advises|advised) against (non-essential|all but essential) travel\b/.test(t)) return 'Reconsider Travel';
  if (/\b(reconsider travel|level 3)\b/.test(t)) return 'Reconsider Travel';
  if (/\b(do not travel|level 4)\b/.test(t)) return 'Do Not Travel';
  if (/\b(exercise increased caution|level 2)\b/.test(t)) return 'Exercise Increased Caution';
  if (/\b(normal precautions|level 1)\b/.test(t)) return 'Exercise Normal Precautions';
  if (/\b(updated|review|review of)\b/.test(t) && /\b(security|warning|safety|protest|terrorism|conflict)\b/.test(t)) return 'Exercise Increased Caution';
  return 'Unknown';
}

function extractCountryFromTitle(title) {
  if (!title) return null;
  const t = title.replace(/^(travel\s*advis(ory|ies?)\s*[:\-–]?\s*)/i, '').trim();
  return t.split(/[,\-–]/)[0].trim() || t;
}

export async function briefing() {
  const out = [];
  const errors = [];
  const seen = new Set();

  for (const src of ADVISORY_SOURCES) {
    let xml;
    try {
      xml = await rawFetchText(src.url);
    } catch (e) {
      errors.push({ source: src.key, error: e.message });
      continue;
    }
    if (!xml || !xml.includes('<entry>')) {
      errors.push({ source: src.key, error: 'No recognizable feed content' });
      continue;
    }
    const items = parseAtom(xml);
    for (const it of items) {
      if (!it.title) continue;
      const country = extractCountryFromTitle(it.title);
      if (!country) continue;
      const key = `${country}::${src.key}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const descText = stripHtml(it.description);
      const level = detectLevel(`${it.title} ${descText}`);
      out.push({
        id: `${src.key}:${it.guid || it.title}`,
        source: src.label,
        sourceKey: src.key,
        country,
        title: it.title,
        description: descText.slice(0, 400),
        link: it.link,
        pubDate: it.pubDate,
        level,
        levelRank: LEVEL_RANK[level] ?? 0,
      });
    }
  }

  const byLevel = { 'Do Not Travel': 0, 'Reconsider Travel': 0, 'Exercise Increased Caution': 0, 'Exercise Normal Precautions': 0, 'Unknown': 0 };
  for (const a of out) byLevel[a.level] = (byLevel[a.level] || 0) + 1;

  const doNotTravel = out.filter(a => a.level === 'Do Not Travel').sort((a, b) => (b.pubDate || '').localeCompare(a.pubDate || ''));
  const reconsider  = out.filter(a => a.level === 'Reconsider Travel').sort((a, b) => (b.pubDate || '').localeCompare(a.pubDate || ''));
  const elevated = [...doNotTravel, ...reconsider];

  const signals = elevated.slice(0, 10).map(a => ({
    kind: a.level === 'Do Not Travel' ? 'advisory_dnt' : 'advisory_reconsider',
    label: `${a.level}: ${a.country}`,
    country: a.country,
    source: a.source,
    level: a.level,
    description: a.description?.slice(0, 120),
    link: a.link,
  }));

  return {
    source: 'Travel Advisories',
    timestamp: new Date().toISOString(),
    status: 'ok',
    total: out.length,
    byLevel,
    doNotTravel,
    reconsider,
    advisories: out.slice(0, 50),
    errors,
    signals,
  };
}

if (process.argv[1]?.endsWith('advisories.mjs')) {
  console.log(JSON.stringify(await briefing(), null, 2));
}