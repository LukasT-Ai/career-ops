#!/usr/bin/env node

/**
 * generate-dashboard.mjs — Pipeline Health Dashboard Generator
 *
 * Generates a self-contained HTML dashboard showing:
 * - Scan freshness (last run per source)
 * - Coverage by geography (GA, CA, Germany, remote)
 * - Evaluation backlog (pending vs evaluated)
 * - Application status distribution
 * - Per-profile stats
 *
 * Usage:
 *   node generate-dashboard.mjs              Generate and open in browser
 *   node generate-dashboard.mjs --no-open    Generate only, don't open
 *
 * Output: output/pipeline-dashboard.html
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ALL_PROFILES = ['paulina', 'lamin'];

// ── Data Collection ──────────────────────────────────────────

async function collectProfileData(profileName) {
  const dataDir = resolve(__dirname, 'profiles', profileName, 'data');
  const data = {
    name: profileName,
    pipeline: { total: 0, pending: 0, checked: 0, byGeo: {}, byScanSource: {} },
    applications: { total: 0, byStatus: {}, byMonth: {} },
    scanHistory: { total: 0, lastScanDate: null, bySource: {}, recentDays: {} },
  };

  // Parse pipeline.md
  try {
    const pipeline = await readFile(resolve(dataDir, 'pipeline.md'), 'utf8');
    const lines = pipeline.split('\n');
    for (const line of lines) {
      if (line.startsWith('- [ ]')) {
        data.pipeline.pending++;
        data.pipeline.total++;
        categorizeGeo(line, data.pipeline.byGeo);
        categorizeSource(line, data.pipeline.byScanSource);
      } else if (line.startsWith('- [x]') || line.startsWith('- [X]')) {
        data.pipeline.checked++;
        data.pipeline.total++;
      }
    }
  } catch { /* no pipeline */ }

  // Parse applications.md
  try {
    const apps = await readFile(resolve(dataDir, 'applications.md'), 'utf8');
    const lines = apps.split('\n');
    for (const line of lines) {
      if (!line.startsWith('|') || line.includes('---') || line.includes('Date')) continue;
      const cols = line.split('|').map(c => c.trim()).filter(Boolean);
      if (cols.length < 5) continue;
      data.applications.total++;
      const status = cols[5] || cols[4] || 'Unknown';
      data.applications.byStatus[status] = (data.applications.byStatus[status] || 0) + 1;
      const date = cols[1] || '';
      const month = date.slice(0, 7);
      if (month) data.applications.byMonth[month] = (data.applications.byMonth[month] || 0) + 1;
    }
  } catch { /* no applications */ }

  // Parse scan-history.tsv
  try {
    const history = await readFile(resolve(dataDir, 'scan-history.tsv'), 'utf8');
    const lines = history.split('\n').filter(l => l.trim() && !l.startsWith('url\t'));
    data.scanHistory.total = lines.length;

    for (const line of lines) {
      const cols = line.split('\t');
      const date = cols[1] || '';
      const source = (cols[2] || '').split(':')[0].trim() || 'Unknown';
      const status = cols[5] || 'unknown';

      // Track by source
      if (!data.scanHistory.bySource[source]) {
        data.scanHistory.bySource[source] = { total: 0, added: 0, skipped: 0, lastDate: '' };
      }
      data.scanHistory.bySource[source].total++;
      if (status === 'added') data.scanHistory.bySource[source].added++;
      else data.scanHistory.bySource[source].skipped++;
      if (date > (data.scanHistory.bySource[source].lastDate || '')) {
        data.scanHistory.bySource[source].lastDate = date;
      }

      // Track last scan date overall
      if (date > (data.scanHistory.lastScanDate || '')) {
        data.scanHistory.lastScanDate = date;
      }

      // Recent activity (last 7 days)
      if (date >= getDateNDaysAgo(7)) {
        data.scanHistory.recentDays[date] = (data.scanHistory.recentDays[date] || 0) + 1;
      }
    }
  } catch { /* no scan history */ }

  return data;
}

function categorizeGeo(line, geo) {
  const lower = line.toLowerCase();
  const geos = {
    'Georgia/Atlanta': ['atlanta', 'georgia', 'decatur', 'dekalb', 'savannah', 'augusta', 'macon'],
    'California': ['california', 'los angeles', 'san francisco', 'san diego', 'sacramento'],
    'Germany': ['germany', 'deutschland', 'berlin', 'munich', 'münchen', 'hamburg', 'frankfurt',
      'stuttgart', 'düsseldorf', 'cologne', 'köln', 'heidelberg', 'freiburg'],
    'Remote': ['remote', 'virtual', 'telehealth', 'telepsych', 'work from home', 'anywhere'],
  };
  let found = false;
  for (const [label, keywords] of Object.entries(geos)) {
    if (keywords.some(kw => lower.includes(kw))) {
      geo[label] = (geo[label] || 0) + 1;
      found = true;
      break;
    }
  }
  if (!found) geo['Other/Unknown'] = (geo['Other/Unknown'] || 0) + 1;
}

function categorizeSource(line, sources) {
  const lower = line.toLowerCase();
  if (lower.includes('greenhouse')) sources['Greenhouse'] = (sources['Greenhouse'] || 0) + 1;
  else if (lower.includes('lever')) sources['Lever'] = (sources['Lever'] || 0) + 1;
  else if (lower.includes('bundesagentur') || lower.includes('arbeitsagentur')) sources['Bundesagentur'] = (sources['Bundesagentur'] || 0) + 1;
  else if (lower.includes('usajobs')) sources['USAJobs'] = (sources['USAJobs'] || 0) + 1;
  else sources['Other'] = (sources['Other'] || 0) + 1;
}

function getDateNDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

// ── Brave Usage ──────────────────────────────────────────────

async function loadBraveUsage() {
  try {
    const raw = await readFile(resolve(__dirname, 'data/brave-usage.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return { month: '', profiles: {}, total: 0 };
  }
}

// ── HTML Generator ───────────────────────────────────────────

function generateHTML(profiles, braveUsage) {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  function bar(value, max, color) {
    const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
    return `<div class="bar-bg"><div class="bar" style="width:${pct}%;background:${color}">${value}</div></div>`;
  }

  function statusColor(status) {
    const s = status.toLowerCase();
    if (s.includes('applied')) return '#3b82f6';
    if (s.includes('interview')) return '#8b5cf6';
    if (s.includes('offer')) return '#10b981';
    if (s.includes('rejected') || s.includes('discard')) return '#ef4444';
    if (s.includes('skip')) return '#6b7280';
    if (s.includes('evaluated')) return '#f59e0b';
    return '#94a3b8';
  }

  function geoColor(geo) {
    if (geo.includes('Georgia')) return '#f59e0b';
    if (geo.includes('California')) return '#3b82f6';
    if (geo.includes('Germany')) return '#10b981';
    if (geo.includes('Remote')) return '#8b5cf6';
    return '#6b7280';
  }

  let profileSections = '';
  for (const p of profiles) {
    const maxScanSource = Math.max(...Object.values(p.scanHistory.bySource).map(s => s.total), 1);
    const maxGeo = Math.max(...Object.values(p.pipeline.byGeo), 1);
    const maxStatus = Math.max(...Object.values(p.applications.byStatus), 1);

    const daysAgo = p.scanHistory.lastScanDate
      ? Math.floor((Date.now() - new Date(p.scanHistory.lastScanDate).getTime()) / 86400000)
      : '?';
    const freshness = daysAgo === 0 ? 'Today' : daysAgo <= 2 ? `${daysAgo}d ago` : `${daysAgo}d ago`;
    const freshnessClass = daysAgo <= 2 ? 'fresh' : daysAgo <= 7 ? 'stale' : 'old';

    profileSections += `
    <div class="profile-card">
      <div class="profile-header">
        <h2>${p.name.charAt(0).toUpperCase() + p.name.slice(1)}</h2>
        <span class="freshness ${freshnessClass}">Last scan: ${freshness}</span>
      </div>

      <div class="stats-row">
        <div class="stat">
          <div class="stat-value">${p.pipeline.pending}</div>
          <div class="stat-label">Pending</div>
        </div>
        <div class="stat">
          <div class="stat-value">${p.pipeline.checked}</div>
          <div class="stat-label">Evaluated</div>
        </div>
        <div class="stat">
          <div class="stat-value">${p.applications.total}</div>
          <div class="stat-label">Applications</div>
        </div>
        <div class="stat">
          <div class="stat-value">${p.scanHistory.total}</div>
          <div class="stat-label">Total Scanned</div>
        </div>
      </div>

      <div class="section-grid">
        <div class="section">
          <h3>Scanner Sources</h3>
          <div class="chart">
            ${Object.entries(p.scanHistory.bySource)
              .sort((a, b) => b[1].total - a[1].total)
              .slice(0, 15)
              .map(([name, s]) => `
                <div class="chart-row">
                  <span class="chart-label">${name}</span>
                  <span class="chart-date">${s.lastDate || 'never'}</span>
                  ${bar(s.added, maxScanSource, '#10b981')}
                </div>
              `).join('')}
          </div>
        </div>

        <div class="section">
          <h3>Geography</h3>
          <div class="chart">
            ${Object.entries(p.pipeline.byGeo)
              .sort((a, b) => b[1] - a[1])
              .map(([geo, count]) => `
                <div class="chart-row">
                  <span class="chart-label">${geo}</span>
                  ${bar(count, maxGeo, geoColor(geo))}
                </div>
              `).join('')}
          </div>
        </div>

        <div class="section">
          <h3>Application Status</h3>
          <div class="chart">
            ${Object.entries(p.applications.byStatus)
              .sort((a, b) => b[1] - a[1])
              .map(([status, count]) => `
                <div class="chart-row">
                  <span class="chart-label">${status}</span>
                  ${bar(count, maxStatus, statusColor(status))}
                </div>
              `).join('')}
            ${p.applications.total === 0 ? '<div class="empty">No applications yet</div>' : ''}
          </div>
        </div>
      </div>
    </div>`;
  }

  const braveTotal = braveUsage.total || 0;
  const braveMax = 10000;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Career-Ops Pipeline Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #e2e8f0; padding: 24px; min-height: 100vh; }
    h1 { font-size: 1.5rem; color: #f1f5f9; margin-bottom: 4px; }
    .subtitle { color: #64748b; font-size: 0.85rem; margin-bottom: 24px; }
    .budget-bar { background: #1e293b; border-radius: 8px; padding: 12px 16px; margin-bottom: 24px; display: flex; align-items: center; gap: 16px; }
    .budget-bar .label { color: #94a3b8; font-size: 0.8rem; white-space: nowrap; }
    .budget-bar .bar-track { flex: 1; height: 8px; background: #334155; border-radius: 4px; overflow: hidden; }
    .budget-bar .bar-fill { height: 100%; border-radius: 4px; transition: width 0.3s; }
    .profile-card { background: #1e293b; border-radius: 12px; padding: 20px; margin-bottom: 20px; }
    .profile-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
    .profile-header h2 { font-size: 1.25rem; color: #f1f5f9; }
    .freshness { font-size: 0.75rem; padding: 4px 10px; border-radius: 12px; font-weight: 600; }
    .freshness.fresh { background: #065f46; color: #6ee7b7; }
    .freshness.stale { background: #78350f; color: #fcd34d; }
    .freshness.old { background: #7f1d1d; color: #fca5a5; }
    .stats-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 20px; }
    .stat { background: #0f172a; border-radius: 8px; padding: 12px; text-align: center; }
    .stat-value { font-size: 1.5rem; font-weight: 700; color: #f1f5f9; }
    .stat-label { font-size: 0.7rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 2px; }
    .section-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; }
    .section { background: #0f172a; border-radius: 8px; padding: 14px; }
    .section h3 { font-size: 0.85rem; color: #94a3b8; margin-bottom: 10px; text-transform: uppercase; letter-spacing: 0.5px; }
    .chart { display: flex; flex-direction: column; gap: 6px; }
    .chart-row { display: grid; grid-template-columns: 120px 70px 1fr; align-items: center; gap: 8px; font-size: 0.8rem; }
    .chart-label { color: #cbd5e1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .chart-date { color: #475569; font-size: 0.7rem; text-align: right; }
    .bar-bg { height: 18px; background: #1e293b; border-radius: 4px; overflow: hidden; }
    .bar { height: 100%; border-radius: 4px; display: flex; align-items: center; justify-content: flex-end; padding-right: 6px; font-size: 0.7rem; color: #fff; font-weight: 600; min-width: 24px; }
    .empty { color: #475569; font-size: 0.8rem; font-style: italic; padding: 8px 0; }
    @media (max-width: 768px) { .stats-row { grid-template-columns: repeat(2, 1fr); } .chart-row { grid-template-columns: 90px 60px 1fr; } }
  </style>
</head>
<body>
  <h1>Career-Ops Pipeline Dashboard</h1>
  <div class="subtitle">Generated ${now} | ${profiles.reduce((s, p) => s + p.pipeline.pending, 0)} pending jobs | ${profiles.reduce((s, p) => s + p.applications.total, 0)} applications</div>

  <div class="budget-bar">
    <span class="label">Brave API: ${braveTotal}/${braveMax} ($${(braveTotal * 0.005).toFixed(2)}/$50) — ${braveUsage.month || 'N/A'}</span>
    <div class="bar-track">
      <div class="bar-fill" style="width:${Math.min(100, (braveTotal / braveMax) * 100)}%;background:${braveTotal > 8000 ? '#ef4444' : braveTotal > 5000 ? '#f59e0b' : '#10b981'}"></div>
    </div>
  </div>

  ${profileSections}
</body>
</html>`;
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const noOpen = args.includes('--no-open');

  console.log('  Generating pipeline dashboard...');

  const profiles = [];
  for (const name of ALL_PROFILES) {
    profiles.push(await collectProfileData(name));
  }
  const braveUsage = await loadBraveUsage();

  const html = generateHTML(profiles, braveUsage);

  await mkdir(resolve(__dirname, 'output'), { recursive: true });
  const outPath = resolve(__dirname, 'output', 'pipeline-dashboard.html');
  await writeFile(outPath, html, 'utf8');

  // Also write to docs/ for GitHub Pages
  const docsPath = resolve(__dirname, 'docs', 'index.html');
  await writeFile(docsPath, html, 'utf8');

  console.log(`  Dashboard written to: ${outPath}`);
  console.log(`  GitHub Pages copy:    ${docsPath}`);

  if (!noOpen) {
    const cmd = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    exec(`${cmd} "${outPath}"`);
    console.log('  Opened in browser.');
  }
}

main().catch(err => { console.error(`Fatal: ${err.message}`); process.exit(1); });
