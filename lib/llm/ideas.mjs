// LLM-Powered Trade Ideas — generates actionable ideas from sweep data + delta context

/**
 * Generate LLM-enhanced trade ideas from sweep data.
 * @param {LLMProvider} provider - configured LLM provider
 * @param {object} sweepData - synthesized dashboard data
 * @param {object|null} delta - delta from last sweep
 * @param {Array} previousIdeas - ideas from previous runs (for dedup)
 * @returns {Promise<Array>} - array of idea objects
 */
export async function generateLLMIdeas(provider, sweepData, delta, previousIdeas = []) {
  if (!provider?.isConfigured) return null;

  let context;
  try {
    context = compactSweepForLLM(sweepData, delta, previousIdeas);
  } catch (err) {
    console.error('[LLM Ideas] Failed to compact sweep data:', err.message);
    return null;
  }

  const systemPrompt = `You are a quantitative analyst at a macro intelligence firm. You receive structured OSINT + economic + prediction-market data from 35+ sources and produce 5-8 actionable trade ideas calibrated for both traditional equities AND prediction markets (Kalshi/Polymarket).

Rules:
- Each idea must cite specific data points from the input
- Include entry rationale, risk factors, and time horizon
- Blend geopolitical, economic, prediction-market, and disaster signals — cross-correlate across domains
- Be specific: name instruments (tickers, futures, ETFs, Kalshi contract category, Polymarket URL)
- For prediction-market ideas: identify the underlying event, the mispriced probability vs your base case, and the closest tradeable instrument
- If delta shows significant changes, lead with those
- Do NOT repeat ideas from the "previous ideas" list unless conditions have materially changed
- Rate confidence: HIGH (multiple confirming signals), MEDIUM (thesis supported), LOW (speculative)

Output ONLY valid JSON array. Each object:
{
  "title": "Short title (max 10 words)",
  "type": "LONG|SHORT|HEDGE|WATCH|AVOID|PREDICTION",
  "ticker": "Primary instrument OR prediction market reference",
  "market_type": "equity|fx|commodity|bond|crypto|prediction|weather|geopolitics (for prediction-market ideas)",
  "confidence": "HIGH|MEDIUM|LOW",
  "rationale": "2-3 sentence explanation citing specific data",
  "risk": "Key risk factor",
  "horizon": "Intraday|Days|Weeks|Months",
  "signals": ["signal1", "signal2"]
}`;

  try {
    const result = await provider.complete(systemPrompt, context, { maxTokens: 8192, timeout: 90000 });
    const ideas = parseIdeasResponse(result.text);
    if (ideas && ideas.length > 0) {
      return ideas;
    }
    console.warn('[LLM Ideas] No valid ideas parsed from response. Raw length:', result.text?.length, 'First 1000 chars:', JSON.stringify(result.text?.slice(0, 1000)));
    return null;
  } catch (err) {
    console.error('[LLM Ideas] Generation failed:', err.message);
    return null;
  }
}

/**
 * Compact sweep data to ~8KB for token efficiency.
 */
function compactSweepForLLM(data, delta, previousIdeas) {
  const sections = [];

  // Economic indicators
  if (data.fred?.length) {
    const key = data.fred.filter(f => ['VIXCLS', 'DFF', 'DGS10', 'DGS2', 'T10Y2Y', 'BAMLH0A0HYM2', 'DTWEXBGS', 'MORTGAGE30US'].includes(f.id));
    sections.push(`ECONOMIC: ${key.map(f => `${f.id}=${f.value}${f.momChange ? ` (${f.momChange > 0 ? '+' : ''}${f.momChange})` : ''}`).join(', ')}`);
  }

  // Energy
  if (data.energy) {
    sections.push(`ENERGY: WTI=$${data.energy.wti}, Brent=$${data.energy.brent}, NatGas=$${data.energy.natgas}, CrudeStocks=${data.energy.crudeStocks}bbl`);
  }

  // Metals
  if (data.metals?.gold != null || data.metals?.silver != null) {
    const gold = data.metals?.gold != null ? `$${data.metals.gold}` : 'n/a';
    const silver = data.metals?.silver != null ? `$${data.metals.silver}` : 'n/a';
    const goldChg = data.metals?.goldChangePct != null ? ` (${data.metals.goldChangePct >= 0 ? '+' : ''}${data.metals.goldChangePct}%)` : '';
    const silverChg = data.metals?.silverChangePct != null ? ` (${data.metals.silverChangePct >= 0 ? '+' : ''}${data.metals.silverChangePct}%)` : '';
    sections.push(`METALS: Gold=${gold}${goldChg}, Silver=${silver}${silverChg}`);
  }

  // BLS
  if (data.bls?.length) {
    sections.push(`LABOR: ${data.bls.map(b => `${b.id}=${b.value}`).join(', ')}`);
  }

  // Treasury
  if (data.treasury) {
    sections.push(`TREASURY: totalDebt=$${data.treasury}T`);
  }

  // Supply chain
  if (data.gscpi) {
    sections.push(`SUPPLY_CHAIN: GSCPI=${data.gscpi.value} (${data.gscpi.interpretation})`);
  }

  // Geopolitical signals (cap total OSINT text to ~1500 chars to keep prompt compact)
  const urgentPosts = (data.tg?.urgent || []).slice(0, 5);
  if (urgentPosts.length) {
    const MAX_OSINT_CHARS = 1500;
    let remaining = MAX_OSINT_CHARS;
    const lines = [];
    for (const p of urgentPosts) {
      const text = p.text || '';
      if (remaining <= 0) break;
      const trimmed = text.length > remaining ? text.substring(0, remaining) + '…' : text;
      lines.push(`- ${trimmed}`);
      remaining -= trimmed.length;
    }
    sections.push(`URGENT_OSINT:\n${lines.join('\n')}`);
  }

  // Thermal / fire detections
  if (data.thermal?.length) {
    const hotRegions = data.thermal.filter(t => t.det > 10).map(t => `${t.region}: ${t.det} detections (${t.hc} high-conf)`);
    if (hotRegions.length) sections.push(`THERMAL: ${hotRegions.join(', ')}`);
  }

  // Air activity
  if (data.air?.length) {
    const airSum = data.air.map(a => `${a.region}: ${a.total} aircraft`);
    sections.push(`AIR_ACTIVITY: ${airSum.join(', ')}`);
  }

  // Nuclear
  if (data.nuke?.length) {
    const anomalies = data.nuke.filter(n => n.anom);
    if (anomalies.length) sections.push(`NUCLEAR_ANOMALY: ${anomalies.map(n => `${n.site}: ${n.cpm}cpm`).join(', ')}`);
  }

  // WHO alerts
  if (data.who?.length) {
    sections.push(`WHO_ALERTS: ${data.who.slice(0, 3).map(w => w.title).join('; ')}`);
  }

  // Defense spending
  if (data.defense?.length) {
    const topContracts = data.defense.slice(0, 3).map(d => `$${((d.amount || 0) / 1e6).toFixed(0)}M to ${d.recipient}`);
    sections.push(`DEFENSE_CONTRACTS: ${topContracts.join(', ')}`);
  }

  // Earthquakes (USGS) — major quakes move insurance, commodities, regional risk
  if (data.majorQuakes?.length) {
    const majors = data.majorQuakes.slice(0, 5).map(q =>
      `M${q.mag?.toFixed(1)} ${q.place?.split(',').pop()?.trim() || ''}${q.tsunami ? ' [TSUNAMI]' : ''}${q.alert === 'red' || q.alert === 'orange' ? ' [' + q.alert.toUpperCase() + ']' : ''}`
    );
    sections.push(`EARTHQUAKES: ${majors.join('; ')}`);
  }

  // Disasters (GDACS) — global humanitarian/insurance signal
  if (data.disasters?.total > 0) {
    const sev = [];
    if (data.disasters.red) sev.push(`${data.disasters.red} RED`);
    if (data.disasters.orange) sev.push(`${data.disasters.orange} ORANGE`);
    const types = Object.entries(data.disasters.byType || {}).map(([k, v]) => `${k}=${v}`).join(',');
    const headlines = (data.disasters.events || []).slice(0, 3).map(e =>
      `[${e.severity?.toUpperCase() || 'GREEN'}] ${e.type}: ${e.title?.slice(0, 80)}`
    );
    sections.push(`DISASTERS: ${sev.join(' ') || 'green only'} types=${types}${headlines.length ? ' | ' + headlines.join(' | ') : ''}`);
  }

  // NASA EONET — natural events
  if (data.eonetEvents?.length) {
    const catCounts = {};
    for (const e of data.eonetEvents) {
      if (e.category) catCounts[e.category] = (catCounts[e.category] || 0) + 1;
    }
    const cats = Object.entries(catCounts).map(([k, v]) => `${k}=${v}`).join(',');
    const notable = data.eonetEvents.filter(e => /volcano|cyclone|hurricane|typhoon/i.test(e.category || '')).slice(0, 3).map(e => e.title?.slice(0, 60));
    sections.push(`EONET_OPEN_EVENTS: ${data.eonetEvents.length} (${cats})${notable.length ? ' | notable: ' + notable.join('; ') : ''}`);
  }

  // Climate anomalies (Open-Meteo) — climate stress at conflict hotspots
  if (data.climateAnomalies?.length) {
    const anom = data.climateAnomalies.slice(0, 4).map(c =>
      `${c.region}: ${c.anomalyC >= 0 ? '+' : ''}${c.anomalyC}°C (${c.severity})`
    );
    sections.push(`CLIMATE_ANOMALIES: ${anom.join('; ')}`);
  }

  // ECB rates + FX — EU macro signal
  if (data.ecbRates?.length) {
    const parts = [];
    const deposit = data.ecbRates.find(r => r.key === 'ecb_deposit');
    const mrr = data.ecbRates.find(r => r.key === 'ecb_mrr');
    if (deposit) parts.push(`ECB_Deposit=${deposit.value?.toFixed(2)}%`);
    if (mrr) parts.push(`ECB_MRR=${mrr.value?.toFixed(2)}%`);
    const eurUsd = data.ecbRates.find(r => r.key === 'eurusd');
    const eurJpy = data.ecbRates.find(r => r.key === 'eurjpy');
    if (eurUsd) parts.push(`EUR/USD=${eurUsd.value?.toFixed(4)} (${eurUsd.changePct >= 0 ? '+' : ''}${eurUsd.changePct?.toFixed(2)}%)`);
    if (eurJpy) parts.push(`EUR/JPY=${eurJpy.value?.toFixed(2)} (${eurJpy.changePct >= 0 ? '+' : ''}${eurJpy.changePct?.toFixed(2)}%)`);
    if (parts.length) sections.push(`ECB_RATES: ${parts.join(', ')}`);
  }

  // Polymarket — prediction market signal as leading indicator
  if (data.polymarkets?.length) {
    const byCat = {};
    for (const m of data.polymarkets) byCat[m.category] = (byCat[m.category] || 0) + 1;
    const highVol = data.polymarkets
      .filter(m => (m.volume24hr || 0) > 100000)
      .sort((a, b) => (b.volume24hr || 0) - (a.volume24hr || 0))
      .slice(0, 4)
      .map(m => `${(m.yesPrice * 100)?.toFixed(0)}% "${m.question?.slice(0, 50)}" (vol=$${((m.volume24hr || 0) / 1000).toFixed(0)}k)`);
    sections.push(`POLYMARKET_TOP: ${highVol.join('; ') || 'low volume'}`);
    if (data.highProbShifts?.length) {
      const tails = data.highProbShifts.slice(0, 3).map(m => `"${m.question?.slice(0, 50)}"=${(m.yesPrice * 100)?.toFixed(0)}%`);
      sections.push(`POLYMARKET_EXTREMES: ${tails.join('; ')}`);
    }
  }

  // Travel advisories — government risk-assessment signal
  if (data.travelAdvisories?.total > 0) {
    const dnt = data.travelAdvisories.doNotTravel || [];
    const rec = data.travelAdvisories.reconsider || [];
    if (dnt.length || rec.length) {
      const parts = [];
      if (dnt.length) parts.push(`DoNotTravel: ${dnt.slice(0, 3).map(a => a.country).join(', ')}`);
      if (rec.length) parts.push(`Reconsider: ${rec.slice(0, 3).map(a => a.country).join(', ')}`);
      sections.push(`TRAVEL_ADVISORIES: ${parts.join(' | ')}`);
    }
  }

  // Cyber IOCs (abuse.ch) — active infrastructure threats
  if (data.cyberIOCs?.c2Count > 0 || data.cyberIOCs?.malwareHostCount > 0) {
    const parts = [];
    parts.push(`${data.cyberIOCs.c2Count} C2 servers`);
    parts.push(`${data.cyberIOCs.malwareHostCount} malware hosts`);
    const topCountries = Object.entries(data.cyberIOCs.byCountry || {}).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}=${v}`);
    if (topCountries.length) parts.push(`top: ${topCountries.join(',')}`);
    sections.push(`CYBER_IOCS: ${parts.join('; ')}`);
  }

  // Delta context
  if (delta?.summary) {
    sections.push(`\nDELTA_SINCE_LAST_SWEEP: direction=${delta.summary.direction}, changes=${delta.summary.totalChanges}, critical=${delta.summary.criticalChanges}`);
    if (delta.signals?.escalated?.length) {
      sections.push(`ESCALATED: ${delta.signals.escalated.map(s => `${s.label}: ${s.previous}→${s.current} (${(s.changePct||0) > 0 ? '+' : ''}${(s.changePct||0).toFixed(1)}%)`).join(', ')}`);
    }
    if (delta.signals?.new?.length) {
      sections.push(`NEW_SIGNALS: ${delta.signals.new.map(s => s.label || s.text?.substring(0, 60)).join('; ')}`);
    }
  }

  // Previous ideas (for dedup)
  if (previousIdeas.length) {
    sections.push(`\nPREVIOUS_IDEAS (avoid repeating):\n${previousIdeas.map(i => `- ${i.title} [${i.type}]`).join('\n')}`);
  }

  return sections.join('\n');
}

/**
 * Parse LLM response into ideas array. Handles markdown code blocks.
 */
function parseIdeasResponse(text) {
  if (!text) return null;

  // Strip markdown code block wrappers (handles trailing whitespace, thinking tags, etc.)
  let cleaned = text.trim();
  // Extract content from code blocks anywhere in the response
  const codeBlockMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    cleaned = codeBlockMatch[1].trim();
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```\s*$/, '');
  }
  // Strip any leading/trailing non-JSON text (find the array)
  const arrayMatch = cleaned.match(/(\[[\s\S]*\])/);
  if (arrayMatch) {
    cleaned = arrayMatch[1];
  }

  try {
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return null;

    // Validate each idea has required fields
    return parsed.filter(idea =>
      idea.title && idea.type && idea.confidence
    ).map(idea => ({
      title: idea.title,
      type: idea.type,
      ticker: idea.ticker || '',
      market_type: idea.market_type || '',
      confidence: idea.confidence,
      rationale: idea.rationale || '',
      risk: idea.risk || '',
      horizon: idea.horizon || '',
      signals: idea.signals || [],
      source: 'llm',
    }));
  } catch {
    // Try to extract JSON array from mixed text
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (match) {
      try {
        const arr = JSON.parse(match[0]);
        return arr.filter(i => i.title && i.type).map(idea => ({
          ...idea,
          source: 'llm',
        }));
      } catch { /* give up */ }
    }
    return null;
  }
}
