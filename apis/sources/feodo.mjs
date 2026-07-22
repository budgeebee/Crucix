import { safeFetch } from '../utils/fetch.mjs';

const FEODO_URL = 'https://feodotracker.abuse.ch/downloads/ipblocklist.json';
const URLHAUS_URL = 'https://urlhaus.abuse.ch/downloads/text/';
const RANSOMWARE_URL = 'https://ransomwhat.telemetry.ltd/';

async function fetchFeodo() {
  try {
    const data = await safeFetch(FEODO_URL, { timeout: 12000, headers: { 'Accept': 'application/json' } });
    if (data?.error) return [];
    return (data || []).slice(0, 50).map(e => ({
      ip: e.ip_address,
      firstSeen: e.first_seen,
      lastSeen: e.last_seen,
      country: e.country || null,
      asn: e.asn || null,
      asName: e.as_name || null,
      malware: e.malware || null,
    }));
  } catch (e) {
    return [];
  }
}

async function fetchUrlhaus() {
  try {
    const data = await safeFetch(URLHAUS_URL, { timeout: 12000, headers: { 'Accept': 'text/plain' } });
    const text = typeof data === 'string' ? data : (data?.rawText || '');
    const lines = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    return lines.slice(0, 50).map(url => ({ url, status: 'online' }));
  } catch (e) {
    return [];
  }
}

function geoGuessFromIp(ip) {
  return null;
}

export async function briefing() {
  const [c2, malwareUrls] = await Promise.all([fetchFeodo(), fetchUrlhaus()]);

  const c2ByCountry = {};
  for (const e of c2) {
    if (e.country) c2ByCountry[e.country] = (c2ByCountry[e.country] || 0) + 1;
  }

  const topC2 = c2.slice(0, 10).map(e => ({
    kind: 'c2_server',
    label: `C2: ${e.ip} (${e.malware || 'unknown malware'})`,
    ip: e.ip,
    country: e.country,
    asName: e.asName,
    malware: e.malware,
  }));

  const topUrls = malwareUrls.slice(0, 5).map(u => ({
    kind: 'malware_host',
    label: `Malware host: ${u.url?.slice(0, 60)}`,
    url: u.url,
  }));

  return {
    source: 'abuse.ch',
    timestamp: new Date().toISOString(),
    status: 'ok',
    c2ServerCount: c2.length,
    malwareHostCount: malwareUrls.length,
    c2ByCountry,
    c2Servers: c2,
    malwareHosts: malwareUrls,
    signals: [...topC2, ...topUrls],
  };
}

if (process.argv[1]?.endsWith('feodo.mjs')) {
  console.log(JSON.stringify(await briefing(), null, 2));
}