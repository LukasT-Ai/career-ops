#!/usr/bin/env node

/**
 * dashboard-server.mjs — Interactive Dashboard with Approval Controls
 *
 * Serves the pipeline dashboard with live approve/skip/submit buttons.
 * Works on local network — access from phone, tablet, or any device.
 *
 * Usage:
 *   node dashboard-server.mjs                Start on port 3737
 *   node dashboard-server.mjs --port=8080    Custom port
 *
 * Endpoints:
 *   GET  /                          Dashboard HTML
 *   GET  /api/queue/:profile        Queue data as JSON
 *   POST /api/approve/:profile/:id  Approve one item
 *   POST /api/skip/:profile/:id     Skip one item
 *   POST /api/approve-all/:profile  Approve all pending
 *   POST /api/submit/:profile       Run apply engine (dry-run)
 *   POST /api/submit/:profile?live=1  Run apply engine (real)
 */

import { createServer } from 'http';
import { readFile, readdir } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { listQueue, approveItem, approveAll, skipItem } from './approval-queue.mjs';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ALL_PROFILES = ['paulina', 'lamin'];

// ── Data Collection (same as generate-dashboard) ────────────

async function collectProfileData(profileName) {
  const dataDir = resolve(__dirname, 'profiles', profileName, 'data');
  const data = {
    name: profileName,
    pipeline: { total: 0, pending: 0, checked: 0 },
    applications: { total: 0, byStatus: {} },
    scanHistory: { total: 0, lastScanDate: null },
    queue: [],
  };

  try {
    const pipeline = await readFile(resolve(dataDir, 'pipeline.md'), 'utf8');
    for (const line of pipeline.split('\n')) {
      if (line.startsWith('- [ ]')) { data.pipeline.pending++; data.pipeline.total++; }
      else if (line.startsWith('- [x]') || line.startsWith('- [X]')) { data.pipeline.checked++; data.pipeline.total++; }
    }
  } catch {}

  try {
    const apps = await readFile(resolve(dataDir, 'applications.md'), 'utf8');
    for (const line of apps.split('\n')) {
      if (!line.startsWith('|') || line.includes('---') || line.includes('Date')) continue;
      const cols = line.split('|').map(c => c.trim()).filter(Boolean);
      if (cols.length < 5) continue;
      data.applications.total++;
      const status = cols[5] || cols[4] || 'Unknown';
      data.applications.byStatus[status] = (data.applications.byStatus[status] || 0) + 1;
    }
  } catch {}

  try {
    const history = await readFile(resolve(dataDir, 'scan-history.tsv'), 'utf8');
    const lines = history.split('\n').filter(l => l.trim() && !l.startsWith('url\t'));
    data.scanHistory.total = lines.length;
    for (const line of lines) {
      const date = line.split('\t')[1] || '';
      if (date > (data.scanHistory.lastScanDate || '')) data.scanHistory.lastScanDate = date;
    }
  } catch {}

  data.queue = await listQueue(profileName);
  return data;
}

// ── HTML Dashboard ──────────────────────────────────────────

function renderDashboard(profiles) {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  function queueRows(profileName, items, status) {
    if (items.length === 0) return `<div class="empty">No ${status} items</div>`;
    return items.map(i => {
      const ats = i.ats === 'greenhouse' ? '<span class="ats gh">GH</span>' : i.ats === 'lever' ? '<span class="ats lv">LV</span>' : '<span class="ats">??</span>';
      const actions = status === 'pending' ? `
        <button class="btn btn-approve" onclick="api('approve','${profileName}','${i.id}')">Approve</button>
        <button class="btn btn-skip" onclick="api('skip','${profileName}','${i.id}')">Skip</button>
      ` : status === 'approved' ? `
        <button class="btn btn-skip" onclick="api('skip','${profileName}','${i.id}')">Undo</button>
      ` : '';
      const score = i.score > 0 ? `<span class="score">${i.score}/5</span>` : '';
      return `
        <div class="queue-item ${status}">
          <div class="queue-info">
            ${ats} <strong>${i.company}</strong> — ${i.title}
            ${score}
            ${i.location ? `<span class="loc">${i.location}</span>` : ''}
            ${i.error ? `<span class="error-msg">${i.error.slice(0, 60)}</span>` : ''}
          </div>
          <div class="queue-actions">${actions}</div>
        </div>`;
    }).join('');
  }

  let profileSections = '';
  for (const p of profiles) {
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
        <div class="stat"><div class="stat-value">${p.scanHistory.total}</div><div class="stat-label">Scanned</div></div>
        <div class="stat"><div class="stat-value">${p.applications.total}</div><div class="stat-label">Applied</div></div>
        <div class="stat"><div class="stat-value">${submitted.length}</div><div class="stat-label">Auto-Submitted</div></div>
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
    .subtitle { color: #64748b; font-size: 0.8rem; margin-bottom: 20px; }
    .profile-card { background: #1e293b; border-radius: 12px; padding: 16px; margin-bottom: 16px; }
    .profile-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
    .profile-header h2 { font-size: 1.2rem; color: #f1f5f9; }
    .freshness { font-size: 0.7rem; padding: 3px 8px; border-radius: 12px; font-weight: 600; }
    .freshness.fresh { background: #065f46; color: #6ee7b7; }
    .freshness.stale { background: #78350f; color: #fcd34d; }
    .freshness.old { background: #7f1d1d; color: #fca5a5; }
    .stats-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 16px; }
    .stat { background: #0f172a; border-radius: 8px; padding: 10px; text-align: center; }
    .stat-value { font-size: 1.3rem; font-weight: 700; color: #f1f5f9; }
    .stat-label { font-size: 0.65rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px; }

    .queue-section { margin-bottom: 16px; }
    .queue-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; padding: 0 4px; }
    .queue-header h3 { font-size: 0.85rem; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.5px; }
    .queue-item { background: #0f172a; border-radius: 8px; padding: 10px 12px; margin-bottom: 6px; display: flex; justify-content: space-between; align-items: center; gap: 8px; }
    .queue-item.pending { border-left: 3px solid #f59e0b; }
    .queue-item.approved { border-left: 3px solid #3b82f6; }
    .queue-item.submitted { border-left: 3px solid #10b981; }
    .queue-item.failed { border-left: 3px solid #ef4444; }
    .queue-item.skipped { border-left: 3px solid #475569; opacity: 0.6; }
    .queue-info { flex: 1; font-size: 0.8rem; line-height: 1.4; min-width: 0; }
    .queue-info strong { color: #f1f5f9; }
    .queue-actions { display: flex; gap: 6px; flex-shrink: 0; }
    .ats { font-size: 0.65rem; font-weight: 700; padding: 1px 5px; border-radius: 3px; margin-right: 4px; }
    .ats.gh { background: #065f46; color: #6ee7b7; }
    .ats.lv { background: #1e3a5f; color: #93c5fd; }
    .score { color: #f59e0b; font-size: 0.75rem; margin-left: 6px; }
    .loc { color: #64748b; font-size: 0.7rem; display: block; margin-top: 2px; }
    .error-msg { color: #f87171; font-size: 0.7rem; display: block; margin-top: 2px; }

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

    .empty { color: #475569; font-size: 0.8rem; font-style: italic; padding: 12px; }
    .toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: #1e293b; color: #e2e8f0; padding: 12px 24px; border-radius: 8px; font-size: 0.85rem; z-index: 1000; display: none; border: 1px solid #334155; box-shadow: 0 4px 12px rgba(0,0,0,0.3); }
    .toast.show { display: block; animation: fadeInOut 2.5s ease; }
    .toast.error { border-color: #ef4444; color: #fca5a5; }
    @keyframes fadeInOut { 0% { opacity: 0; transform: translateX(-50%) translateY(10px); } 10% { opacity: 1; transform: translateX(-50%) translateY(0); } 80% { opacity: 1; } 100% { opacity: 0; } }

    .collapsed .collapsible { display: none; }
    .collapsed .toggle-arrow { transform: rotate(-90deg); }
    .toggle-arrow { color: #64748b; font-size: 0.7rem; transition: transform 0.2s; display: inline-block; cursor: pointer; }

    .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid #64748b; border-top-color: #e2e8f0; border-radius: 50%; animation: spin 0.6s linear infinite; margin-left: 6px; vertical-align: middle; }
    @keyframes spin { to { transform: rotate(360deg); } }

    @media (max-width: 640px) {
      .stats-row { grid-template-columns: repeat(2, 1fr); }
      .queue-item { flex-direction: column; align-items: flex-start; }
      .queue-actions { margin-top: 6px; }
    }
  </style>
</head>
<body>
  <h1>Career-Ops Dashboard</h1>
  <div class="subtitle">Live | Updated ${now} | <a href="#" onclick="location.reload()" style="color:#3b82f6;">Refresh</a></div>

  ${profileSections}

  <div class="toast" id="toast"></div>

  <script>
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

        // Reload after brief delay
        setTimeout(() => location.reload(), 1500);
      } catch (err) {
        toast.className = 'toast show error';
        toast.textContent = 'Error: ' + err.message;
      }
    }
  </script>
</body>
</html>`;
}

// ── API Routes ──────────────────────────────────────────────

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  // CORS headers for local dev
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Dashboard
  if (path === '/' && req.method === 'GET') {
    const profiles = [];
    for (const name of ALL_PROFILES) profiles.push(await collectProfileData(name));
    const html = renderDashboard(profiles);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
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
      // Parse results from output
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
  console.log(`  Local:   http://localhost:${PORT}`);
  for (const ip of ips) console.log(`  Network: http://${ip}:${PORT}`);
  console.log(`\n  Open on your phone or any device on the same network.`);
  console.log(`  Press Ctrl+C to stop.\n`);
});
