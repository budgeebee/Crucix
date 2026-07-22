import { safeFetch } from '../utils/fetch.mjs';

const OPENMETEO_ARCHIVE = 'https://archive-api.open-meteo.com/v1/archive';

const HOTSPOTS = [
  { key: 'eastern_europe',  label: 'Eastern Europe (Ukraine front)',  lat: 48.5,  lon: 35.0  },
  { key: 'middle_east',     label: 'Middle East (Levant)',            lat: 33.5,  lon: 36.0  },
  { key: 'horn_of_africa',  label: 'Horn of Africa',                  lat: 9.0,   lon: 42.0  },
  { key: 'south_china_sea', label: 'South China Sea',                 lat: 14.0,  lon: 115.0 },
  { key: 'korean_peninsula',label: 'Korean Peninsula',                lat: 38.0,  lon: 127.0 },
  { key: 'sahel',           label: 'Sahel',                           lat: 15.0,  lon: 5.0   },
];

const BASELINE_DAYS = 30;

function daysBack(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().split('T')[0];
}

function classifyAnomaly(anomalyC) {
  if (anomalyC >= 5) return 'extreme';
  if (anomalyC >= 3) return 'severe';
  if (anomalyC >= 1.5) return 'moderate';
  return 'normal';
}

export async function briefing() {
  const endDate = daysBack(1);
  const baselineEnd = daysBack(BASELINE_DAYS);
  const baselineStart = daysBack(BASELINE_DAYS * 2);
  const recentStart = daysBack(7);

  const hotspots = [];

  for (const h of HOTSPOTS) {
    try {
      const url = `${OPENMETEO_ARCHIVE}?latitude=${h.lat}&longitude=${h.lon}&start_date=${baselineStart}&end_date=${endDate}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=UTC`;
      const data = await safeFetch(url, { timeout: 12000 });
      const daily = data?.daily;
      if (!daily?.time) continue;

      const recentTemps = [];
      const baselineTemps = [];
      const recentPrecip = [];
      const baselinePrecip = [];

      daily.time.forEach((t, i) => {
        const temp = daily.temperature_2m_max?.[i];
        const precip = daily.precipitation_sum?.[i];
        if (temp == null || Number.isNaN(temp)) return;
        if (t >= recentStart) {
          recentTemps.push(temp);
          if (precip != null && !Number.isNaN(precip)) recentPrecip.push(precip);
        } else if (t >= baselineStart && t < recentStart) {
          baselineTemps.push(temp);
          if (precip != null && !Number.isNaN(precip)) baselinePrecip.push(precip);
        }
      });

      if (baselineTemps.length < 5 || recentTemps.length < 1) continue;

      const baselineAvg = baselineTemps.reduce((s, v) => s + v, 0) / baselineTemps.length;
      const recentAvg   = recentTemps.reduce((s, v) => s + v, 0) / recentTemps.length;
      const tempAnomaly = recentAvg - baselineAvg;

      const baselinePrecipAvg = baselinePrecip.length ? baselinePrecip.reduce((s, v) => s + v, 0) / baselinePrecip.length : 0;
      const recentPrecipAvg   = recentPrecip.length ? recentPrecip.reduce((s, v) => s + v, 0) / recentPrecip.length : 0;
      const precipAnomaly = recentPrecipAvg - baselinePrecipAvg;

      hotspots.push({
        key: h.key,
        label: h.label,
        lat: h.lat,
        lon: h.lon,
        baselineTempC: Number(baselineAvg.toFixed(2)),
        recentTempC: Number(recentAvg.toFixed(2)),
        tempAnomalyC: Number(tempAnomaly.toFixed(2)),
        tempSeverity: classifyAnomaly(Math.abs(tempAnomaly)),
        baselinePrecipMm: Number(baselinePrecipAvg.toFixed(2)),
        recentPrecipMm: Number(recentPrecipAvg.toFixed(2)),
        precipAnomalyMm: Number(precipAnomaly.toFixed(2)),
      });
    } catch (e) {
      hotspots.push({ key: h.key, label: h.label, error: e.message });
    }
  }

  const anomalies = hotspots
    .filter(h => h.tempSeverity && h.tempSeverity !== 'normal')
    .sort((a, b) => Math.abs(b.tempAnomalyC) - Math.abs(a.tempAnomalyC));

  const signals = anomalies.slice(0, 6).map(h => ({
    kind: h.tempAnomalyC >= 0 ? 'heat_anomaly' : 'cold_anomaly',
    label: `${h.label}: ${h.tempAnomalyC >= 0 ? '+' : ''}${h.tempAnomalyC.toFixed(1)}°C vs baseline (${h.tempSeverity})`,
    region: h.label,
    lat: h.lat,
    lon: h.lon,
    anomalyC: h.tempAnomalyC,
    severity: h.tempSeverity,
  }));

  return {
    source: 'Open-Meteo',
    timestamp: new Date().toISOString(),
    status: 'ok',
    baselineDays: BASELINE_DAYS,
    hotspots,
    anomalies,
    signals,
  };
}

if (process.argv[1]?.endsWith('openmeteo.mjs')) {
  console.log(JSON.stringify(await briefing(), null, 2));
}