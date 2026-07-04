// Adanos — Polymarket / Reddit / X social sentiment aggregator (https://api.adanos.org)
// Optional — requires at least one ADANOS_API_KEY[_N]. Gracefully degrades otherwise.
//
// Key rotation + caching:
//   - Reads key pool from env: ADANOS_API_KEY and ADANOS_API_KEY_1..ADANOS_API_KEY_9
//   - One key per cache window (default 2h, override with ADANOS_CACHE_TTL_MS)
//   - Round-robin among healthy keys
//   - Burn detection: HTTP 429 OR response body matching /(quota|limit|exceeded|rate)/i
//   - Persists key health + last good payload to runs/memory/adanos_cache.json (atomic write)
//   - Falls back to last good cache when current call fails

import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { safeFetch } from '../utils/fetch.mjs';
import '../utils/env.mjs';

const BASE = 'https://api.adanos.org';
const TIMEOUT_MS = 8000;
const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours — math-optimal for 5-key/33-day budget
// Burn status auto-expires after this many days, so a key whose quota refreshes
// (e.g., monthly) rejoins the rotation automatically without env-var coordination.
const DEFAULT_BURN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CACHE_PATH = join(process.cwd(), 'runs', 'memory', 'adanos_cache.json');

const ENDPOINTS = [
  { path: '/polymarket/stocks/v1/trending', key: 'polymarket' },
  { path: '/reddit/stocks/v1/trending',    key: 'reddit' },
  { path: '/x/stocks/v1/trending',         key: 'x' },
];

const BURN_RE = /(quota|limit|exceeded|rate.threshold|too.many)/i;

function extractItems(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    return data.trending ?? data.data ?? [];
  }
  return [];
}

function loadKeyPool() {
  // Unsuffixed ADANOS_API_KEY first, then _1.._9. De-duped, non-empty only.
  const pool = [];
  const seen = new Set();
  const primary = (process.env.ADANOS_API_KEY || '').trim();
  if (primary) { pool.push('ADANOS_API_KEY'); seen.add(primary); }
  for (let i = 1; i <= 9; i++) {
    const name = `ADANOS_API_KEY_${i}`;
    const v = (process.env[name] || '').trim();
    if (v && !seen.has(v)) { pool.push(name); seen.add(v); }
  }
  return pool;
}

function reapExpiredBurns(health) {
  // A burn is treated as terminal only for BURN_TTL_MS. After that, the key
  // gets a fresh attempt — handles monthly quota resets without env coordination.
  // Override with ADANOS_BURN_TTL_MS.
  const ttl = parseInt(process.env.ADANOS_BURN_TTL_MS) || DEFAULT_BURN_TTL_MS;
  const cutoff = Date.now() - ttl;
  for (const [name, h] of Object.entries(health)) {
    if (name.startsWith('_')) continue; // skip metadata keys like _current_key
    if (h?.status !== 'burned' || !h.burned_at) continue;
    const burnedAt = Date.parse(h.burned_at);
    if (Number.isNaN(burnedAt)) continue;
    if (burnedAt < cutoff) {
      delete health[name].status;
      delete health[name].burned_at;
      delete health[name].last_error;
    }
  }
}

function loadCache() {
  try {
    if (existsSync(CACHE_PATH)) {
      return JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
    }
  } catch (e) {
    console.warn('[Adanos] Cache read failed, starting fresh:', e.message);
  }
  return { adanos: null, key_health: {}, last_window_id: -1 };
}

function saveCache(cache) {
  try {
    mkdirSync(dirname(CACHE_PATH), { recursive: true });
    const tmp = CACHE_PATH + '.tmp';
    const bak = CACHE_PATH + '.bak';
    writeFileSync(tmp, JSON.stringify(cache, null, 2));
    if (existsSync(CACHE_PATH)) {
      try { renameSync(CACHE_PATH, bak); } catch {}
    }
    renameSync(tmp, CACHE_PATH);
  } catch (e) {
    console.warn('[Adanos] Cache write failed:', e.message);
  }
}

function pickKey(pool, health, lastWindowId, windowId) {
  // New window → round-robin advance.
  // Same window as last call → keep using the same key (idempotent re-runs).
  const cached = health._current_key;
  if (cached && windowId === lastWindowId && health[cached]?.status !== 'burned') {
    return cached;
  }
  const healthy = pool.filter(name => health[name]?.status !== 'burned');
  if (healthy.length === 0) return null;
  // Rotate based on window id so calls distribute evenly across keys.
  const idx = windowId % healthy.length;
  return healthy[idx];
}

async function fetchTrending(endpoint, apiKey, health) {
  const url = `${BASE}${endpoint.path}`;
  let res, raw;
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'X-API-Key': apiKey,
        'Accept': 'application/json',
        'User-Agent': 'Crucix/1.0',
      },
    });
    const text = await res.text();
    try { raw = JSON.parse(text); } catch { raw = { rawText: text.slice(0, 500) }; }
  } catch (e) {
    return { key: endpoint.key, status: 'error', error: e.message, items: [] };
  }

  if (!res.ok) {
    const bodyText = typeof raw === 'object' ? JSON.stringify(raw) : String(raw);
    if (res.status === 429 || BURN_RE.test(bodyText)) {
      // Mark this API key value as burned, not the env var name (same key under multiple names → burn all).
      return { key: endpoint.key, status: 'burned', error: `HTTP ${res.status}: ${bodyText.slice(0, 150)}`, items: [], burnSignal: true };
    }
    return { key: endpoint.key, status: 'error', error: `HTTP ${res.status}: ${bodyText.slice(0, 150)}`, items: [] };
  }

  if (raw && typeof raw === 'object' && BURN_RE.test(JSON.stringify(raw))) {
    return { key: endpoint.key, status: 'burned', error: 'quota signal in body', items: [], burnSignal: true };
  }

  return { key: endpoint.key, status: 'ok', items: extractItems(raw) };
}

export async function briefing({ force = false } = {}) {
  const pool = loadKeyPool();
  if (pool.length === 0) {
    return {
      source: 'Adanos',
      timestamp: new Date().toISOString(),
      status: 'no_key',
      message: 'Adanos requires at least one API key. Set ADANOS_API_KEY or ADANOS_API_KEY_1..9 in .env',
    };
  }

  const ttl = parseInt(process.env.ADANOS_CACHE_TTL_MS) || DEFAULT_TTL_MS;
  const now = Date.now();
  const windowId = Math.floor(now / ttl);
  const cache = loadCache();
  reapExpiredBurns(cache.key_health);

  // Cache hit: same window, payload present, key still healthy.
  // `force` bypasses cache — used by /api/adanos/refresh so MiroFish always gets fresh data.
  if (!force && cache.adanos && cache.last_window_id === windowId) {
    return { ...cache.adanos, cached: true, cache_age_seconds: Math.floor((now - new Date(cache.adanos.timestamp).getTime()) / 1000) };
  }

  // Pick a key for this window.
  let chosen = pickKey(pool, cache.key_health, cache.last_window_id, windowId);
  if (!chosen) {
    // All keys burned. Serve stale cache if present, else error.
    if (cache.adanos) {
      return {
        ...cache.adanos,
        status: 'all_keys_burned',
        cached: true,
        stale: true,
        cache_age_seconds: Math.floor((now - new Date(cache.adanos.timestamp).getTime()) / 1000),
      };
    }
    return {
      source: 'Adanos',
      timestamp: new Date().toISOString(),
      status: 'all_keys_burned',
      message: 'All Adanos keys are burned and no cache exists.',
      key_health: cache.key_health,
    };
  }

  const apiKey = (process.env[chosen] || '').trim();
  // Sequential, not parallel — Adanos rate-limits per key (100/min) and parallel
  // burst of 3 requests in the same ms can trip the limiter even on a fresh key.
  // Also keeps the key-rotation retry path safe (no double-burst on burn).
  const results = [];
  for (const ep of ENDPOINTS) {
    results.push(await fetchTrending(ep, apiKey, cache.key_health));
  }

  // Did this key burn during this window? Mark + persist + retry once with next key.
  const burnedThisCall = results.some(r => r.burnSignal);
  if (burnedThisCall) {
    cache.key_health[chosen] = {
      ...(cache.key_health[chosen] || {}),
      status: 'burned',
      burned_at: new Date().toISOString(),
      last_error: results.find(r => r.burnSignal)?.error,
    };
    saveCache(cache);
    // Re-pick (excluding the just-burned key) and retry once for this same window.
    const retryKey = pickKey(
      pool.filter(n => n !== chosen),
      cache.key_health,
      -1, // force re-pick
      windowId,
    );
    if (retryKey) {
      const retryApiKey = (process.env[retryKey] || '').trim();
      // Sequential retry — same rate-limit safety as the primary call.
      const retryResults = [];
      for (const ep of ENDPOINTS) {
        retryResults.push(await fetchTrending(ep, retryApiKey, cache.key_health));
      }
      return finalize(pool, retryKey, retryResults, cache, windowId, now, ttl);
    }
    // No retry key available — fall through to finalize with what we have + cache fallback.
  }

  return finalize(pool, chosen, results, cache, windowId, now, ttl);
}

function finalize(pool, chosen, results, cache, windowId, now, ttl) {
  const out = { polymarket: [], reddit: [], x: [] };
  let ok = 0;
  let failed = 0;
  for (const r of results) {
    out[r.key] = r.items;
    if (r.status === 'ok') ok++;
    else failed++;
  }

  let status = 'ok';
  if (ok === 0 && !cache.adanos) status = 'error';
  else if (ok === 0) status = 'cached_fallback';
  else if (failed > 0) status = 'partial';

  // Update key health counters
  const prev = cache.key_health[chosen] || {};
  cache.key_health[chosen] = {
    ...prev,
    status: 'ok',
    calls_this_key: (prev.calls_this_key || 0) + 1,
    last_used: new Date(now).toISOString(),
    last_status: status,
  };
  cache.key_health._current_key = chosen;

  const payload = {
    source: 'Adanos',
    timestamp: new Date(now).toISOString(),
    status,
    window_id: windowId,
    key_used: chosen,
    key_pool_size: pool.length,
    ...out,
    summary: {
      polymarket: out.polymarket.length,
      reddit: out.reddit.length,
      x: out.x.length,
      ok,
      failed,
    },
  };

  cache.adanos = payload;
  cache.last_window_id = windowId;
  saveCache(cache);

  return { ...payload, cache_age_seconds: 0 };
}

if (process.argv[1]?.endsWith('adanos.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}