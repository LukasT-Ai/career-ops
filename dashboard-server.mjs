#!/usr/bin/env node

/**
 * dashboard-server.mjs — Unified Career-Ops Dashboard
 *
 * Full pipeline dashboard with live approval controls + analytics.
 * Accessible via Tailscale from any device.
 *
 * Usage:
 *   node dashboard-server.mjs                Start on port 3737
 *   node dashboard-server.mjs --port=8080    Custom port
 *
 * Endpoints:
 *   GET  /                          Dashboard HTML
 *   GET  /api/queue/:profile        Queue data as JSON
 *   GET  /api/job-details/:profile/:id  Fetch full JD from ATS API
 *   POST /api/approve/:profile/:id  Approve one item
 *   POST /api/skip/:profile/:id     Skip one item
 *   POST /api/approve-all/:profile  Approve all pending
 *   POST /api/submit/:profile       Run apply engine (dry-run)
 *   POST /api/submit/:profile?live=1  Run apply engine (real)
 */

import { createServer } from 'http';
import { readFile, readdir, mkdir } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { listQueue, approveItem, approveAll, skipItem } from './approval-queue.mjs';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ALL_PROFILES = ['paulina', 'lamin'];

// ── Data Collection (full analytics from generate-dashboard) ──

function getDateNDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

function categorizeGeo(line, geo) {
  const lower = line.toLowerCase();
  const geos = {
    'Georgia/Atlanta': ['atlanta', 'georgia', 'decatur', 'dekalb', 'savannah', 'augusta', 'macon'],
    'California': ['california', 'los angeles', 'san francisco', 'san diego', 'sacramento'],
    'New York': ['new york', 'nyc', 'manhattan', 'brooklyn'],
    'Texas': ['texas', 'dallas', 'houston', 'austin', 'san antonio'],
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

async function collectProfileData(profileName) {
  const dataDir = resolve(__dirname, 'profiles', profileName, 'data');
  const data = {
    name: profileName,
    pipeline: { total: 0, pending: 0, checked: 0, byGeo: {}, byScanSource: {} },
    applications: { total: 0, byStatus: {}, byMonth: {} },
    scanHistory: { total: 0, lastScanDate: null, bySource: {}, recentDays: {} },
    queue: [],
  };

  // Parse pipeline.md
  try {
    const pipeline = await readFile(resolve(dataDir, 'pipeline.md'), 'utf8');
    for (const line of pipeline.split('\n')) {
      if (line.startsWith('- [ ]')) {
        data.pipeline.pending++;
        data.pipeline.total++;
        categorizeGeo(line, data.pipeline.byGeo);
      } else if (line.startsWith('- [x]') || line.startsWith('- [X]')) {
        data.pipeline.checked++;
        data.pipeline.total++;
      }
    }
  } catch {}

  // Parse applications.md
  try {
    const apps = await readFile(resolve(dataDir, 'applications.md'), 'utf8');
    for (const line of apps.split('\n')) {
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
  } catch {}

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

      if (!data.scanHistory.bySource[source]) {
        data.scanHistory.bySource[source] = { total: 0, added: 0, skipped: 0, lastDate: '' };
      }
      data.scanHistory.bySource[source].total++;
      if (status === 'added') data.scanHistory.bySource[source].added++;
      else data.scanHistory.bySource[source].skipped++;
      if (date > (data.scanHistory.bySource[source].lastDate || '')) {
        data.scanHistory.bySource[source].lastDate = date;
      }
      if (date > (data.scanHistory.lastScanDate || '')) {
        data.scanHistory.lastScanDate = date;
      }
      if (date >= getDateNDaysAgo(7)) {
        data.scanHistory.recentDays[date] = (data.scanHistory.recentDays[date] || 0) + 1;
      }
    }
  } catch {}

  data.queue = await listQueue(profileName);
  return data;
}

async function loadBraveUsage() {
  try {
    const raw = await readFile(resolve(__dirname, 'data/brave-usage.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return { month: '', profiles: {}, total: 0 };
  }
}

// ── Fetch Job Details from ATS APIs ─────────────────────────

async function fetchGreenhouseDetails(url) {
  const m = url.match(/greenhouse\.io\/([^/]+)\/jobs\/(\d+)/);
  if (!m) return null;
  const jobId = m[2];
  try {
    const resp = await fetch(`https://boards-api.greenhouse.io/v1/boards/${m[1]}/jobs/${jobId}`);
    if (!resp.ok) return null;
    const job = await resp.json();
    return {
      title: job.title || '',
      location: job.location?.name || '',
      description: job.content || '',
      salary: extractGreenhouseSalary(job),
      department: job.departments?.map(d => d.name).join(', ') || '',
      posted: job.updated_at?.split('T')[0] || '',
      url: job.absolute_url || url,
    };
  } catch { return null; }
}

function extractGreenhouseSalary(job) {
  // Check pay_input_ranges (newer Greenhouse API)
  if (job.pay_input_ranges?.length) {
    const r = job.pay_input_ranges[0];
    const min = r.min_cents ? `$${Math.round(r.min_cents / 100).toLocaleString()}` : '';
    const max = r.max_cents ? `$${Math.round(r.max_cents / 100).toLocaleString()}` : '';
    if (min && max) return `${min} - ${max}`;
    if (max) return `Up to ${max}`;
    return min;
  }
  // Try parsing from description
  const content = job.content || '';
  const salaryMatch = content.match(/\$[\d,]+(?:\s*[-–]\s*\$[\d,]+)?(?:\s*(?:per year|annually|\/yr|\/year|base))?/i);
  return salaryMatch ? salaryMatch[0] : '';
}

async function fetchLeverDetails(url) {
  const m = url.match(/lever\.co\/([^/]+)\/([a-f0-9-]+)/);
  if (!m) return null;
  try {
    const resp = await fetch(`https://api.lever.co/v0/postings/${m[1]}/${m[2]}`);
    if (!resp.ok) return null;
    const job = await resp.json();
    return {
      title: job.text || '',
      location: job.categories?.location || '',
      description: job.descriptionPlain || job.description || '',
      salary: extractLeverSalary(job),
      department: job.categories?.department || job.categories?.team || '',
      posted: job.createdAt ? new Date(job.createdAt).toISOString().split('T')[0] : '',
      url: job.hostedUrl || url,
    };
  } catch { return null; }
}

function extractLeverSalary(job) {
  const salaryRange = job.salaryRange;
  if (salaryRange) {
    const min = salaryRange.min ? `$${salaryRange.min.toLocaleString()}` : '';
    const max = salaryRange.max ? `$${salaryRange.max.toLocaleString()}` : '';
    if (min && max) return `${min} - ${max}`;
    if (max) return `Up to ${max}`;
    return min;
  }
  // Try parsing from description
  const content = job.descriptionPlain || job.description || '';
  const salaryMatch = content.match(/\$[\d,]+(?:\s*[-–]\s*\$[\d,]+)?(?:\s*(?:per year|annually|\/yr|\/year|base))?/i);
  return salaryMatch ? salaryMatch[0] : '';
}

// ── HTML Dashboard ──────────────────────────────────────────

function renderDashboard(profiles, braveUsage) {
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
    if (geo.includes('New York')) return '#ec4899';
    if (geo.includes('Texas')) return '#f97316';
    return '#6b7280';
  }

  function queueRows(profileName, items, status) {
    if (items.length === 0) return `<div class="empty">No ${status} items</div>`;
    return items.map(i => {
      const ats = i.ats === 'greenhouse' ? '<span class="ats gh">GH</span>' : i.ats === 'lever' ? '<span class="ats lv">LV</span>' : '<span class="ats">??</span>';
      const actions = status === 'pending' ? `
        <button class="btn btn-approve" onclick="event.stopPropagation();api('approve','${profileName}','${i.id}')">Approve</button>
        <button class="btn btn-skip" onclick="event.stopPropagation();api('skip','${profileName}','${i.id}')">Skip</button>
      ` : status === 'approved' ? `
        <button class="btn btn-skip" onclick="event.stopPropagation();api('skip','${profileName}','${i.id}')">Undo</button>
      ` : '';
      const score = i.score > 0 ? `<span class="score">${i.score}/5</span>` : '<span class="score unscored">Not scored</span>';
      const escapedUrl = (i.url || '').replace(/'/g, "\\'");
      return `
        <div class="queue-item ${status}" onclick="toggleDetails(this,'${profileName}','${i.id}','${i.ats}','${escapedUrl}')">
          <div class="queue-main">
            <div class="queue-info">
              ${ats} <strong>${i.company}</strong> — ${i.title}
              ${score}
              ${i.location ? `<span class="loc">${i.location}</span>` : ''}
              <a href="${i.url}" target="_blank" class="job-link" onclick="event.stopPropagation()">View posting &rarr;</a>
              ${i.error ? `<span class="error-msg">${i.error.slice(0, 60)}</span>` : ''}
            </div>
            <div class="queue-actions">${actions}</div>
          </div>
          <div class="queue-details" id="details-${i.id}" style="display:none;">
            <div class="details-loading">Tap to load job details...</div>
          </div>
        </div>`;
    }).join('');
  }

  let profileSections = '';
  for (const p of profiles) {
    const maxScanSource = Math.max(...Object.values(p.scanHistory.bySource).map(s => s.added), 1);
    const maxGeo = Math.max(...Object.values(p.pipeline.byGeo), 1);
    const maxStatus = Math.max(...Object.values(p.applications.byStatus), 1);

    const pending = p.queue.filter(i => i.status === 'pending');
    const approved = p.queue.filter(i => i.status === 'approved');
    const submitted = p.queue.filter(i => i.status === 'submitted');
    const failed = p.queue.filter(i => i.status === 'failed');
    const skipped = p.queue.filter(i => i.status === 'skipped');

    const daysAgo = p.scanHistory.lastScanDate
      ? Math.floor((Date.now() - new Date(p.scanHistory.lastScanDate).getTime()) / 86400000)
      : '?';
    const freshnessClass = daysAgo <= 2 ? 'fresh' : daysAgo <= 7 ? 'stale' : 'old';
    const freshness = daysAgo === 0 ? 'Today' : `${daysAgo}d ago`;

    profileSections += `
    <div class="profile-card">
      <div class="profile-header">
        <h2>${p.name.charAt(0).toUpperCase() + p.name.slice(1)}</h2>
        <span class="freshness ${freshnessClass}">Last scan: ${freshness}</span>
      </div>

      <div class="stats-row">
        <div class="stat"><div class="stat-value">${p.pipeline.pending}</div><div class="stat-label">Pipeline</div></div>
        <div class="stat"><div class="stat-value">${p.pipeline.checked}</div><div class="stat-label">Evaluated</div></div>
        <div class="stat"><div class="stat-value">${p.applications.total}</div><div class="stat-label">Applications</div></div>
        <div class="stat"><div class="stat-value">${p.scanHistory.total}</div><div class="stat-label">Total Scanned</div></div>
      </div>

      <!-- Analytics Sections -->
      <div class="section-grid">
        <div class="section">
          <h3>Scanner Sources</h3>
          <div class="chart">
            ${Object.entries(p.scanHistory.bySource)
              .sort((a, b) => b[1].added - a[1].added)
              .slice(0, 15)
              .map(([name, s]) => `
                <div class="chart-row">
                  <span class="chart-label">${name}</span>
                  <span class="chart-date">${s.lastDate || 'never'}</span>
                  ${bar(s.added, maxScanSource, '#10b981')}
                </div>
              `).join('')}
            ${Object.keys(p.scanHistory.bySource).length === 0 ? '<div class="empty">No scan data</div>' : ''}
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
                  <span class="chart-date"></span>
                  ${bar(count, maxGeo, geoColor(geo))}
                </div>
              `).join('')}
            ${Object.keys(p.pipeline.byGeo).length === 0 ? '<div class="empty">No pipeline data</div>' : ''}
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
                  <span class="chart-date"></span>
                  ${bar(count, maxStatus, statusColor(status))}
                </div>
              `).join('')}
            ${p.applications.total === 0 ? '<div class="empty">No applications yet</div>' : ''}
          </div>
        </div>
      </div>

      <!-- Approval Queue -->
      <div class="queue-section">
        <div class="queue-header">
          <h3>Pending Approval (${pending.length})</h3>
          ${pending.length > 0 ? `<button class="btn btn-approve-all" onclick="api('approve-all','${p.name}')">Approve All</button>` : ''}
        </div>
        ${queueRows(p.name, pending, 'pending')}
      </div>

      ${approved.length > 0 ? `
      <div class="queue-section">
        <div class="queue-header">
          <h3>Approved — Ready to Submit (${approved.length})</h3>
          <div>
            <button class="btn btn-submit" onclick="api('submit','${p.name}','','dry')">Dry Run</button>
            <button class="btn btn-submit-live" onclick="if(confirm('Submit ${approved.length} application(s) for real?')) api('submit','${p.name}','','live')">Submit</button>
          </div>
        </div>
        ${queueRows(p.name, approved, 'approved')}
      </div>` : ''}

      ${submitted.length > 0 ? `
      <div class="queue-section">
        <div class="queue-header"><h3>Submitted (${submitted.length})</h3></div>
        ${queueRows(p.name, submitted, 'submitted')}
      </div>` : ''}

      ${failed.length > 0 ? `
      <div class="queue-section">
        <div class="queue-header"><h3>Failed (${failed.length})</h3></div>
        ${queueRows(p.name, failed, 'failed')}
      </div>` : ''}

      ${skipped.length > 0 ? `
      <div class="queue-section collapsed">
        <div class="queue-header" onclick="this.parentElement.classList.toggle('collapsed')">
          <h3>Skipped (${skipped.length})</h3>
          <span class="toggle-arrow">&#9660;</span>
        </div>
        <div class="collapsible">${queueRows(p.name, skipped, 'skipped')}</div>
      </div>` : ''}
    </div>`;
  }

  const braveTotal = braveUsage.total || 0;
  const braveMax = 10000;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Career-Ops Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #e2e8f0; padding: 16px; min-height: 100vh; }
    h1 { font-size: 1.4rem; color: #f1f5f9; margin-bottom: 4px; }
    .subtitle { color: #64748b; font-size: 0.8rem; margin-bottom: 16px; }
    .subtitle a { color: #3b82f6; text-decoration: none; }

    /* Brave Budget Bar */
    .budget-bar { background: #1e293b; border-radius: 8px; padding: 10px 14px; margin-bottom: 16px; display: flex; align-items: center; gap: 12px; }
    .budget-bar .label { color: #94a3b8; font-size: 0.75rem; white-space: nowrap; }
    .budget-bar .bar-track { flex: 1; height: 6px; background: #334155; border-radius: 3px; overflow: hidden; }
    .budget-bar .bar-fill { height: 100%; border-radius: 3px; transition: width 0.3s; }

    /* Profile Cards */
    .profile-card { background: #1e293b; border-radius: 12px; padding: 16px; margin-bottom: 16px; }
    .profile-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
    .profile-header h2 { font-size: 1.2rem; color: #f1f5f9; }
    .freshness { font-size: 0.7rem; padding: 3px 8px; border-radius: 12px; font-weight: 600; }
    .freshness.fresh { background: #065f46; color: #6ee7b7; }
    .freshness.stale { background: #78350f; color: #fcd34d; }
    .freshness.old { background: #7f1d1d; color: #fca5a5; }

    /* Stats Row */
    .stats-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 16px; }
    .stat { background: #0f172a; border-radius: 8px; padding: 10px; text-align: center; }
    .stat-value { font-size: 1.3rem; font-weight: 700; color: #f1f5f9; }
    .stat-label { font-size: 0.65rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px; }

    /* Analytics Section Grid */
    .section-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; margin-bottom: 16px; }
    .section { background: #0f172a; border-radius: 8px; padding: 12px; }
    .section h3 { font-size: 0.8rem; color: #94a3b8; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px; }
    .chart { display: flex; flex-direction: column; gap: 5px; }
    .chart-row { display: grid; grid-template-columns: 110px 68px 1fr; align-items: center; gap: 6px; font-size: 0.75rem; }
    .chart-label { color: #cbd5e1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .chart-date { color: #475569; font-size: 0.65rem; text-align: right; }
    .bar-bg { height: 16px; background: #1e293b; border-radius: 4px; overflow: hidden; }
    .bar { height: 100%; border-radius: 4px; display: flex; align-items: center; justify-content: flex-end; padding-right: 5px; font-size: 0.65rem; color: #fff; font-weight: 600; min-width: 20px; }

    /* Queue */
    .queue-section { margin-bottom: 16px; }
    .queue-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; padding: 0 4px; }
    .queue-header h3 { font-size: 0.85rem; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.5px; }
    .queue-item { background: #0f172a; border-radius: 8px; margin-bottom: 6px; cursor: pointer; transition: background 0.15s; }
    .queue-item:hover { background: #162032; }
    .queue-item.pending { border-left: 3px solid #f59e0b; }
    .queue-item.approved { border-left: 3px solid #3b82f6; }
    .queue-item.submitted { border-left: 3px solid #10b981; }
    .queue-item.failed { border-left: 3px solid #ef4444; }
    .queue-item.skipped { border-left: 3px solid #475569; opacity: 0.6; }
    .queue-main { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 10px 12px; }
    .queue-info { flex: 1; font-size: 0.8rem; line-height: 1.4; min-width: 0; }
    .queue-info strong { color: #f1f5f9; }
    .queue-actions { display: flex; gap: 6px; flex-shrink: 0; }
    .ats { font-size: 0.65rem; font-weight: 700; padding: 1px 5px; border-radius: 3px; margin-right: 4px; }
    .ats.gh { background: #065f46; color: #6ee7b7; }
    .ats.lv { background: #1e3a5f; color: #93c5fd; }
    .score { color: #f59e0b; font-size: 0.75rem; margin-left: 6px; }
    .score.unscored { color: #475569; font-style: italic; }
    .loc { color: #64748b; font-size: 0.7rem; display: block; margin-top: 2px; }
    .job-link { color: #3b82f6; font-size: 0.7rem; text-decoration: none; display: inline-block; margin-top: 2px; }
    .job-link:hover { text-decoration: underline; }
    .error-msg { color: #f87171; font-size: 0.7rem; display: block; margin-top: 2px; }

    /* Job Details Panel */
    .queue-details { padding: 0 12px 12px 12px; border-top: 1px solid #1e293b; }
    .queue-details.loaded { border-top: 1px solid #334155; }
    .details-loading { color: #475569; font-size: 0.75rem; padding: 8px 0; }
    .details-content { font-size: 0.75rem; line-height: 1.5; }
    .details-content .detail-row { display: flex; gap: 8px; margin-bottom: 6px; }
    .details-content .detail-label { color: #64748b; min-width: 70px; font-weight: 600; }
    .details-content .detail-value { color: #e2e8f0; }
    .details-content .detail-value.salary { color: #10b981; font-weight: 600; }
    .details-content .detail-value.no-salary { color: #475569; font-style: italic; }
    .details-content .jd-text { color: #94a3b8; margin-top: 8px; padding-top: 8px; border-top: 1px solid #1e293b; max-height: 200px; overflow-y: auto; white-space: pre-wrap; word-break: break-word; }

    /* Buttons */
    .btn { border: none; padding: 6px 12px; border-radius: 6px; font-size: 0.75rem; font-weight: 600; cursor: pointer; transition: all 0.15s; }
    .btn:active { transform: scale(0.95); }
    .btn-approve { background: #065f46; color: #6ee7b7; }
    .btn-approve:hover { background: #047857; }
    .btn-approve-all { background: #065f46; color: #6ee7b7; }
    .btn-approve-all:hover { background: #047857; }
    .btn-skip { background: #334155; color: #94a3b8; }
    .btn-skip:hover { background: #475569; }
    .btn-submit { background: #1e3a5f; color: #93c5fd; }
    .btn-submit:hover { background: #1e40af; }
    .btn-submit-live { background: #3b82f6; color: #fff; }
    .btn-submit-live:hover { background: #2563eb; }

    .empty { color: #475569; font-size: 0.8rem; font-style: italic; padding: 8px 0; }

    /* Toast */
    .toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: #1e293b; color: #e2e8f0; padding: 12px 24px; border-radius: 8px; font-size: 0.85rem; z-index: 1000; display: none; border: 1px solid #334155; box-shadow: 0 4px 12px rgba(0,0,0,0.3); }
    .toast.show { display: block; animation: fadeInOut 2.5s ease; }
    .toast.error { border-color: #ef4444; color: #fca5a5; }
    @keyframes fadeInOut { 0% { opacity: 0; transform: translateX(-50%) translateY(10px); } 10% { opacity: 1; transform: translateX(-50%) translateY(0); } 80% { opacity: 1; } 100% { opacity: 0; } }

    /* Collapse */
    .collapsed .collapsible { display: none; }
    .collapsed .toggle-arrow { transform: rotate(-90deg); }
    .toggle-arrow { color: #64748b; font-size: 0.7rem; transition: transform 0.2s; display: inline-block; cursor: pointer; }

    .spinner { display: inline-block; width: 12px; height: 12px; border: 2px solid #64748b; border-top-color: #e2e8f0; border-radius: 50%; animation: spin 0.6s linear infinite; vertical-align: middle; }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* Auto-refresh indicator */
    .auto-refresh { position: fixed; top: 8px; right: 16px; font-size: 0.65rem; color: #334155; }

    @media (max-width: 640px) {
      .stats-row { grid-template-columns: repeat(2, 1fr); }
      .section-grid { grid-template-columns: 1fr; }
      .queue-main { flex-direction: column; align-items: flex-start; }
      .queue-actions { margin-top: 6px; }
      .chart-row { grid-template-columns: 90px 60px 1fr; }
    }
  </style>
</head>
<body>
  <h1>Career-Ops Dashboard</h1>
  <div class="subtitle">Live | Updated ${now} | ${profiles.reduce((s, p) => s + p.pipeline.pending, 0)} pending jobs | <a href="#" onclick="location.reload()">Refresh</a></div>

  <div class="budget-bar">
    <span class="label">Brave API: ${braveTotal}/${braveMax} ($${(braveTotal * 0.005).toFixed(2)}/$50) — ${braveUsage.month || 'N/A'}</span>
    <div class="bar-track">
      <div class="bar-fill" style="width:${Math.min(100, (braveTotal / braveMax) * 100)}%;background:${braveTotal > 8000 ? '#ef4444' : braveTotal > 5000 ? '#f59e0b' : '#10b981'}"></div>
    </div>
  </div>

  ${profileSections}

  <div class="toast" id="toast"></div>
  <div class="auto-refresh" id="autoRefresh"></div>

  <script>
    // Cache for fetched job details
    const detailsCache = {};

    async function api(action, profile, id, mode) {
      const toast = document.getElementById('toast');
      let url, method = 'POST';

      if (action === 'approve') url = '/api/approve/' + profile + '/' + id;
      else if (action === 'skip') url = '/api/skip/' + profile + '/' + id;
      else if (action === 'approve-all') url = '/api/approve-all/' + profile;
      else if (action === 'submit') url = '/api/submit/' + profile + (mode === 'live' ? '?live=1' : '');

      try {
        toast.className = 'toast show';
        toast.textContent = action === 'submit' ? 'Submitting... this may take a moment' : 'Processing...';
        const res = await fetch(url, { method });
        const data = await res.json();
        toast.className = data.success ? 'toast show' : 'toast show error';
        toast.textContent = data.message || (data.success ? 'Done!' : 'Failed');
        setTimeout(() => location.reload(), 1500);
      } catch (err) {
        toast.className = 'toast show error';
        toast.textContent = 'Error: ' + err.message;
      }
    }

    async function toggleDetails(el, profile, id, ats, url) {
      const panel = document.getElementById('details-' + id);
      if (!panel) return;

      if (panel.style.display === 'none') {
        panel.style.display = 'block';

        // Fetch details if not cached
        if (!detailsCache[id]) {
          panel.innerHTML = '<div class="details-loading"><span class="spinner"></span> Loading job details...</div>';
          try {
            const res = await fetch('/api/job-details/' + profile + '/' + id);
            const data = await res.json();
            if (data.success && data.details) {
              detailsCache[id] = data.details;
            } else {
              detailsCache[id] = { error: 'Could not fetch details' };
            }
          } catch (err) {
            detailsCache[id] = { error: err.message };
          }
        }

        const d = detailsCache[id];
        if (d.error) {
          panel.innerHTML = '<div class="details-content"><span style="color:#f87171">' + d.error + '</span></div>';
        } else {
          const salaryClass = d.salary ? 'salary' : 'no-salary';
          const salaryText = d.salary || 'Not listed';

          // Strip HTML tags from description, truncate
          const tempDiv = document.createElement('div');
          tempDiv.innerHTML = d.description || '';
          let plainText = tempDiv.textContent || tempDiv.innerText || '';
          if (plainText.length > 1500) plainText = plainText.slice(0, 1500) + '...';

          panel.innerHTML = '<div class="details-content">' +
            '<div class="detail-row"><span class="detail-label">Salary</span><span class="detail-value ' + salaryClass + '">' + salaryText + '</span></div>' +
            (d.location ? '<div class="detail-row"><span class="detail-label">Location</span><span class="detail-value">' + d.location + '</span></div>' : '') +
            (d.department ? '<div class="detail-row"><span class="detail-label">Dept</span><span class="detail-value">' + d.department + '</span></div>' : '') +
            (d.posted ? '<div class="detail-row"><span class="detail-label">Posted</span><span class="detail-value">' + d.posted + '</span></div>' : '') +
            (plainText ? '<div class="jd-text">' + plainText + '</div>' : '') +
          '</div>';
          panel.classList.add('loaded');
        }
      } else {
        panel.style.display = 'none';
      }
    }

    // Auto-refresh every 5 minutes
    let countdown = 300;
    setInterval(() => {
      countdown--;
      if (countdown <= 0) location.reload();
      if (countdown <= 30) {
        document.getElementById('autoRefresh').textContent = 'Refreshing in ' + countdown + 's';
      }
    }, 1000);
  </script>
</body>
</html>`;
}

// ── API Routes ──────────────────────────────────────────────

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Dashboard
  if (path === '/' && req.method === 'GET') {
    const profiles = [];
    for (const name of ALL_PROFILES) profiles.push(await collectProfileData(name));
    const braveUsage = await loadBraveUsage();
    const html = renderDashboard(profiles, braveUsage);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  // Job details (fetch from ATS API on demand)
  const detailsMatch = path.match(/^\/api\/job-details\/(\w+)\/(.+)$/);
  if (detailsMatch && req.method === 'GET') {
    const items = await listQueue(detailsMatch[1]);
    const item = items.find(i => i.id === detailsMatch[2]);
    if (!item) { json(res, { success: false, message: 'Not found' }); return; }

    let details = null;
    if (item.ats === 'greenhouse') {
      details = await fetchGreenhouseDetails(item.url);
    } else if (item.ats === 'lever') {
      details = await fetchLeverDetails(item.url);
    }

    if (details) {
      json(res, { success: true, details });
    } else {
      json(res, { success: false, message: 'Could not fetch from ATS API' });
    }
    return;
  }

  // Queue data
  const queueMatch = path.match(/^\/api\/queue\/(\w+)$/);
  if (queueMatch && req.method === 'GET') {
    const items = await listQueue(queueMatch[1]);
    json(res, { success: true, items });
    return;
  }

  // Approve one
  const approveMatch = path.match(/^\/api\/approve\/(\w+)\/(.+)$/);
  if (approveMatch && req.method === 'POST') {
    const result = await approveItem(approveMatch[1], approveMatch[2]);
    json(res, { success: result.success, message: result.success ? `Approved ${approveMatch[2]}` : `Not found: ${approveMatch[2]}` });
    return;
  }

  // Skip one
  const skipMatch = path.match(/^\/api\/skip\/(\w+)\/(.+)$/);
  if (skipMatch && req.method === 'POST') {
    const result = await skipItem(skipMatch[1], skipMatch[2]);
    json(res, { success: result.success, message: result.success ? `Skipped ${skipMatch[2]}` : `Not found: ${skipMatch[2]}` });
    return;
  }

  // Approve all
  const approveAllMatch = path.match(/^\/api\/approve-all\/(\w+)$/);
  if (approveAllMatch && req.method === 'POST') {
    const result = await approveAll(approveAllMatch[1]);
    json(res, { success: true, message: `Approved ${result.count} item(s)` });
    return;
  }

  // Submit (run apply engine)
  const submitMatch = path.match(/^\/api\/submit\/(\w+)$/);
  if (submitMatch && req.method === 'POST') {
    const profile = submitMatch[1];
    const live = url.searchParams.get('live') === '1';
    const dryFlag = live ? '' : '--dry-run';
    const nodeExe = process.execPath;

    try {
      const { stdout, stderr } = await execFileAsync(nodeExe, [
        resolve(__dirname, 'apply-engine.mjs'),
        `--profile=${profile}`,
        ...(dryFlag ? [dryFlag] : []),
      ], { timeout: 120000, cwd: __dirname });

      const output = (stdout + '\n' + stderr).trim();
      const resultMatch = output.match(/Results:\s*(\d+)\s*submitted.*?(\d+)\s*failed.*?(\d+)\s*need manual/);
      const message = resultMatch
        ? `${live ? '' : '[DRY RUN] '}${resultMatch[1]} submitted, ${resultMatch[2]} failed, ${resultMatch[3]} manual`
        : `${live ? '' : '[DRY RUN] '}Engine complete`;

      json(res, { success: true, message, output: output.slice(-500) });
    } catch (err) {
      json(res, { success: false, message: `Engine error: ${err.message.slice(0, 200)}` });
    }
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
}

function json(res, data) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// ── Server ──────────────────────────────────────────────────

const args = process.argv.slice(2);
const portArg = args.find(a => a.startsWith('--port='));
const PORT = portArg ? parseInt(portArg.split('=')[1]) : 3737;

const server = createServer(handleRequest);

server.listen(PORT, '0.0.0.0', async () => {
  const os = await import('os');
  const { networkInterfaces } = os;
  const nets = networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
    }
  }

  console.log(`\n  Career-Ops Dashboard Server`);
  console.log(`  ${'━'.repeat(50)}`);
  console.log(`  Local:     http://localhost:${PORT}`);
  for (const ip of ips) console.log(`  Network:   http://${ip}:${PORT}`);
  console.log(`  Tailscale: http://100.93.238.88:${PORT}`);
  console.log(`\n  Open from any Tailscale device.`);
  console.log(`  Press Ctrl+C to stop.\n`);
});
