#!/usr/bin/env node

/**
 * digest-sender.mjs -- Weekly Digest Email Sender
 *
 * Aggregates job matches into a single weekly digest email grouped by region.
 * Uses the same Gmail SMTP transport as job-dispatcher.mjs.
 *
 * Usage:
 *   node digest-sender.mjs --profile=paulina --dry-run     # Preview HTML only
 *   node digest-sender.mjs --profile=paulina --send         # Send the digest
 *   node digest-sender.mjs --profile=paulina --dry-run --from=2026-03-31 --to=2026-04-07
 *
 * When called programmatically:
 *   import { sendDigest } from './digest-sender.mjs';
 *   await sendDigest('paulina', jobs, { dryRun: true });
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================
// Email Configuration (matches job-dispatcher.mjs)
// ============================================================

const require = createRequire(import.meta.url);
const nodemailer = require('C:/Users/Lukas/.openclaw/workspace/node_modules/nodemailer');

const EMAIL_CONFIG = {
  service: 'gmail',
  auth: {
    user: 'Lukas.T@withlukas.com',
    pass: 'qviq mipq qvjl ubpk',
  },
  from: '"Career-Ops" <Lukas.T@withlukas.com>',
};

// ============================================================
// Region Classification
// ============================================================

const REGION_CONFIG = [
  {
    key: 'bayern',
    label: '\u2B50 Bayern',
    match: (loc) => /\b(bayern|bavaria|m[uü]nchen|munich|n[uü]rnberg|nuremberg|augsburg|regensburg|w[uü]rzburg|erlangen|bamberg|passau|rosenheim|ingolstadt|f[uü]rth)\b/i.test(loc),
  },
  {
    key: 'heidelberg',
    label: '\uD83D\uDC9C Heidelberg Area',
    match: (loc) => /\b(heidelberg|mannheim|ludwigshafen|karlsruhe|baden-w[uü]rttemberg|darmstadt|rhein-neckar)\b/i.test(loc),
  },
  {
    key: 'bamberg',
    label: '\uD83C\uDFF0 Bamberg',
    match: (loc) => /\bbamberg\b/i.test(loc),
  },
  {
    key: 'bayreuth',
    label: '\uD83C\uDFAD Bayreuth',
    match: (loc) => /\bbayreuth\b/i.test(loc),
  },
  {
    key: 'germany',
    label: '\uD83C\uDF10 Other Germany',
    match: (loc) => /\b(germany|deutschland|berlin|hamburg|frankfurt|k[oö]ln|cologne|d[uü]sseldorf|stuttgart|leipzig|dresden|hannover|bremen|essen|dortmund|bonn|freiburg|mainz|kiel|hessen|sachsen|niedersachsen|nordrhein|schleswig|th[uü]ringen|brandenburg|saarland|mecklenburg|rheinland|sachsen-anhalt)\b/i.test(loc),
  },
  {
    key: 'usa',
    label: '\uD83C\uDDFA\uD83C\uDDF8 USA',
    match: (loc) => /\b(usa|united states|remote|atlanta|ga|georgia|new york|california|texas|florida|illinois|ohio|virginia|maryland|massachusetts|pennsylvania|washington|colorado|arizona|north carolina|south carolina|tennessee|michigan|minnesota|wisconsin|oregon|connecticut|new jersey|missouri|indiana|alabama|louisiana|kentucky|oklahoma|iowa|arkansas|kansas|mississippi|nebraska|nevada|utah|maine|idaho|hawaii|delaware|montana|rhode island|south dakota|north dakota|wyoming|vermont|west virginia|new hampshire|new mexico|remote.*us)\b/i.test(loc),
  },
];

function classifyRegion(location) {
  if (!location) return 'other';
  for (const region of REGION_CONFIG) {
    if (region.match(location)) return region.key;
  }
  return 'other';
}

function getRegionLabel(key) {
  const region = REGION_CONFIG.find(r => r.key === key);
  if (region) return region.label;
  return '\uD83C\uDF0D Other';
}

function getRegionOrder(key) {
  const idx = REGION_CONFIG.findIndex(r => r.key === key);
  return idx >= 0 ? idx : REGION_CONFIG.length;
}

// ============================================================
// Score Color Helpers
// ============================================================

function scoreColor(fitScore) {
  if (fitScore >= 80) return '#2e7d32';  // green
  if (fitScore >= 60) return '#e65100';  // amber
  return '#78909c';                       // gray
}

function scoreBgColor(fitScore) {
  if (fitScore >= 80) return '#e8f5e9';
  if (fitScore >= 60) return '#fff3e0';
  return '#eceff1';
}

// ============================================================
// HTML Rendering
// ============================================================

function renderFlagBadge(flag) {
  const styles = {
    'APPR':   { bg: '#e8f5e9', color: '#2e7d32', icon: '\uD83D\uDFE2' },
    'Bayern': { bg: '#fff8e1', color: '#f57f17', icon: '\u2B50' },
    'HD':     { bg: '#f3e5f5', color: '#7b1fa2', icon: '\uD83D\uDC9C' },
    'EN':     { bg: '#e3f2fd', color: '#1565c0', icon: '\uD83C\uDF10' },
    'Bamberg':{ bg: '#fce4ec', color: '#c62828', icon: '\uD83C\uDFF0' },
    'Bayreuth':{ bg: '#f3e5f5', color: '#6a1b9a', icon: '\uD83C\uDFAD' },
    'USA':    { bg: '#e3f2fd', color: '#1565c0', icon: '\uD83C\uDDFA\uD83C\uDDF8' },
  };
  const s = styles[flag] || { bg: '#eceff1', color: '#546e7a', icon: '' };
  return `<span style="display:inline-block;background:${s.bg};color:${s.color};padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;margin-right:4px;white-space:nowrap;">${s.icon}${flag}</span>`;
}

function renderJobRow(job) {
  const sc = scoreColor(job.fitScore || 0);
  const scBg = scoreBgColor(job.fitScore || 0);
  const flags = (job.flags || []).map(renderFlagBadge).join('');
  const salary = job.salary ? `<span style="color:#546e7a;font-size:12px;">${job.salary}</span>` : '';
  const approbInfo = (job.bundesland && job.approbationDifficulty)
    ? `<span style="color:#78909c;font-size:11px;margin-left:4px;">${job.bundesland}: ${job.approbationDifficulty}</span>`
    : '';

  return `
  <tr>
    <td style="padding:14px 0;border-bottom:1px solid #f0f2f5;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td style="vertical-align:top;width:54px;padding-right:12px;">
            <div style="background:${scBg};color:${sc};font-weight:800;font-size:16px;text-align:center;padding:8px 4px;border-radius:8px;min-width:46px;">
              ${job.fitScore || '?'}
            </div>
          </td>
          <td style="vertical-align:top;">
            <div style="font-weight:700;font-size:14px;color:#1a1a2e;margin-bottom:2px;">${escHtml(job.company)}</div>
            <div style="font-size:13px;color:#4a5568;margin-bottom:4px;">${escHtml(job.title)}</div>
            <div style="font-size:12px;color:#718096;margin-bottom:6px;">
              ${escHtml(job.location || 'Location N/A')}${salary ? ' &middot; ' + salary : ''}${approbInfo ? ' &middot; ' + approbInfo : ''}
            </div>
            <div style="margin-bottom:0;">${flags}</div>
          </td>
          <td style="vertical-align:middle;text-align:right;white-space:nowrap;padding-left:8px;">
            ${job.url ? `<a href="${escHtml(job.url)}" style="display:inline-block;background:#0d7377;color:#ffffff;padding:6px 14px;border-radius:6px;text-decoration:none;font-size:12px;font-weight:600;">View &rarr;</a>` : ''}
          </td>
        </tr>
      </table>
    </td>
  </tr>`;
}

function renderRegionSection(regionKey, jobs) {
  const label = getRegionLabel(regionKey);
  const rows = jobs.map(renderJobRow).join('');
  return `
  <tr>
    <td style="padding:4px 28px 0;">
      <h2 style="font-size:16px;font-weight:700;color:#1a1a2e;margin:20px 0 8px;padding-bottom:6px;border-bottom:2px solid #e8ecf0;">${label} <span style="font-weight:400;color:#a0aec0;font-size:13px;">(${jobs.length})</span></h2>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        ${rows}
      </table>
    </td>
  </tr>`;
}

function escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ============================================================
// Template Assembly
// ============================================================

function buildDigestHtml(profileName, firstName, jobs, dateRange) {
  const totalJobs = jobs.length;
  const approbationCount = jobs.filter(j => j.approbation).length;
  const highFitCount = jobs.filter(j => (j.fitScore || 0) >= 80).length;

  // Group by region
  const groups = {};
  for (const job of jobs) {
    const region = classifyRegion(job.location);
    if (!groups[region]) groups[region] = [];
    groups[region].push(job);
  }

  // Sort within each group by fitScore desc
  for (const key of Object.keys(groups)) {
    groups[key].sort((a, b) => (b.fitScore || 0) - (a.fitScore || 0));
  }

  // Sort regions by defined order
  const sortedRegionKeys = Object.keys(groups).sort((a, b) => getRegionOrder(a) - getRegionOrder(b));

  // Render sections
  const sections = sortedRegionKeys.map(key => renderRegionSection(key, groups[key])).join('');

  const emptyState = totalJobs === 0
    ? `<tr><td style="padding:28px;text-align:center;color:#a0aec0;font-size:14px;">No matching jobs found this week. The search continues!</td></tr>`
    : '';

  // Load template and fill
  return loadAndFill({
    PROFILE_NAME: profileName,
    FIRST_NAME: firstName,
    DATE_RANGE: dateRange,
    TOTAL_JOBS: String(totalJobs),
    APPROBATION_COUNT: String(approbationCount),
    HIGH_FIT_COUNT: String(highFitCount),
    JOB_SECTIONS: sections,
    EMPTY_STATE: emptyState,
  });
}

async function loadAndFill(vars) {
  const templatePath = resolve(__dirname, 'templates', 'email-digest.html');
  let html = await readFile(templatePath, 'utf8');
  for (const [key, value] of Object.entries(vars)) {
    html = html.replaceAll(`{{${key}}}`, value != null ? value : '');
  }
  return html;
}

// ============================================================
// Profile Loader
// ============================================================

async function loadProfile(profileName) {
  // Try profiles/{name}/profile.yml first, then config/profile.yml
  const paths = [
    resolve(__dirname, 'profiles', profileName, 'profile.yml'),
    resolve(__dirname, 'config', 'profile.yml'),
  ];

  for (const p of paths) {
    if (existsSync(p)) {
      const raw = await readFile(p, 'utf8');
      // Simple regex YAML parser (same approach as job-dispatcher.mjs)
      const candidateBlock = raw.match(/candidate:\s*\n([\s\S]*?)(?=\n\w|\n$)/);
      const block = candidateBlock ? candidateBlock[1] : raw;
      return {
        candidate: {
          full_name: block.match(/full_name:\s*"(.+?)"/)?.[1] || null,
          email: block.match(/email:\s*"(.+?)"/)?.[1] || null,
          phone: block.match(/phone:\s*"(.+?)"/)?.[1] || null,
          location: block.match(/location:\s*"(.+?)"/)?.[1] || null,
        },
      };
    }
  }
  throw new Error(`Profile not found: ${profileName}. Looked in profiles/${profileName}/profile.yml and config/profile.yml`);
}

// ============================================================
// Main Export: sendDigest()
// ============================================================

/**
 * Send a weekly digest email.
 *
 * @param {string} profileName - Profile identifier (e.g. 'paulina', 'lamin')
 * @param {Array} jobs - Array of job objects:
 *   { title, company, url, location, fitScore, salary, flags: [], approbation: bool,
 *     bundesland: string, approbationDifficulty: string }
 * @param {object} options
 * @param {boolean} options.dryRun - Write HTML preview instead of sending
 * @param {string}  options.dateFrom - Start of date range (YYYY-MM-DD)
 * @param {string}  options.dateTo   - End of date range (YYYY-MM-DD)
 * @param {string}  options.recipientOverride - Override profile email
 * @param {string}  options.subjectOverride - Override subject line
 */
export async function sendDigest(profileName, jobs, options = {}) {
  const profile = await loadProfile(profileName);
  const candidate = profile.candidate || {};
  const email = options.recipientOverride || candidate.email;
  const fullName = candidate.full_name || profileName;
  const firstName = fullName.split(/[\s,]/)[0];

  // Date range
  const now = new Date();
  const dateTo = options.dateTo || now.toISOString().split('T')[0];
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const dateFrom = options.dateFrom || weekAgo.toISOString().split('T')[0];
  const dateRange = `${formatDate(dateFrom)} \u2014 ${formatDate(dateTo)}`;

  // Build HTML
  const html = await buildDigestHtml(fullName, firstName, jobs, dateRange);

  // Subject line
  const subject = options.subjectOverride || `\uD83D\uDCCB Job Digest (${jobs.length} opportunities) \u2014 ${dateRange}`;

  if (options.dryRun) {
    // Write preview
    const outputDir = resolve(__dirname, 'output');
    if (!existsSync(outputDir)) await mkdir(outputDir, { recursive: true });
    const previewPath = resolve(outputDir, 'digest-preview.html');
    await writeFile(previewPath, html, 'utf8');
    console.log(`[DRY-RUN] Digest preview written to: ${previewPath}`);
    console.log(`[DRY-RUN] Subject: ${subject}`);
    console.log(`[DRY-RUN] Recipient: ${email}`);
    console.log(`[DRY-RUN] Jobs: ${jobs.length} total, ${jobs.filter(j => j.approbation).length} approbation, ${jobs.filter(j => (j.fitScore || 0) >= 80).length} high fit`);
    return { sent: false, previewPath, subject, recipient: email };
  }

  // Send email
  if (!email) {
    throw new Error(`No email address found for profile "${profileName}". Set candidate.email in profile.yml`);
  }

  const transport = nodemailer.createTransport({
    service: EMAIL_CONFIG.service,
    auth: EMAIL_CONFIG.auth,
  });

  await transport.verify();

  // Attach profile-specific PDFs if they exist
  const attachments = [];
  const profileOutputDir = resolve(__dirname, 'profiles', profileName, 'output');

  if (profileName === 'paulina') {
    const lebenslaufPdf = resolve(profileOutputDir, 'Lebenslauf-Dr-Paulina-Kaiser.pdf');
    const storyBankPdf = resolve(profileOutputDir, 'Interview-Story-Bank-Paulina-Kaiser.pdf');
    if (existsSync(lebenslaufPdf)) {
      attachments.push({ filename: 'Lebenslauf-Dr-Paulina-Kaiser.pdf', path: lebenslaufPdf, contentType: 'application/pdf' });
    }
    if (existsSync(storyBankPdf)) {
      attachments.push({ filename: 'Interview-Story-Bank-Paulina-Kaiser.pdf', path: storyBankPdf, contentType: 'application/pdf' });
    }
  } else if (profileName === 'lamin') {
    const lebenslaufPdf = resolve(profileOutputDir, 'Lebenslauf-Lamin-Traore.pdf');
    const storyBankPdf = resolve(profileOutputDir, 'Interview-Story-Bank-Lamin-Traore.pdf');
    if (existsSync(lebenslaufPdf)) {
      attachments.push({ filename: 'Lebenslauf-Lamin-Traore.pdf', path: lebenslaufPdf, contentType: 'application/pdf' });
    }
    if (existsSync(storyBankPdf)) {
      attachments.push({ filename: 'Interview-Story-Bank-Lamin-Traore.pdf', path: storyBankPdf, contentType: 'application/pdf' });
    }
  }

  if (attachments.length > 0) {
    console.log(`[ATTACH] ${attachments.length} PDF(s): ${attachments.map(a => a.filename).join(', ')}`);
  }

  const info = await transport.sendMail({
    from: EMAIL_CONFIG.from,
    to: email,
    subject,
    html,
    attachments,
  });

  console.log(`[SENT] Digest email sent to ${email}`);
  console.log(`[SENT] Message ID: ${info.messageId}`);
  console.log(`[SENT] Subject: ${subject}`);
  console.log(`[SENT] Jobs: ${jobs.length} total`);

  return { sent: true, messageId: info.messageId, subject, recipient: email };
}

// ============================================================
// Helpers
// ============================================================

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    const m = arg.match(/^--(\w[\w-]*)(?:=(.*))?$/);
    if (m) {
      args[m[1]] = m[2] !== undefined ? m[2] : true;
    }
  }
  return args;
}

// ============================================================
// CLI Mode
// ============================================================

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.profile) {
    // Try reading active profile
    try {
      const activeYml = await readFile(resolve(__dirname, 'profiles', 'active.yml'), 'utf8');
      const m = activeYml.match(/active:\s*(\S+)/);
      if (m) args.profile = m[1];
    } catch { /* ignore */ }
  }

  if (!args.profile) {
    console.error('Usage: node digest-sender.mjs --profile=<name> [--dry-run|--send] [--from=YYYY-MM-DD] [--to=YYYY-MM-DD]');
    process.exit(1);
  }

  const dryRun = !!args['dry-run'];
  const send = !!args.send;

  if (!dryRun && !send) {
    console.error('Specify --dry-run or --send');
    process.exit(1);
  }

  // Load sample jobs from scan data or tracker for demo/testing
  let jobs = [];

  // Try to load from a digest-jobs.json if it exists (for programmatic use)
  const digestJobsPath = resolve(__dirname, 'data', 'digest-jobs.json');
  if (existsSync(digestJobsPath)) {
    try {
      jobs = JSON.parse(await readFile(digestJobsPath, 'utf8'));
      console.log(`Loaded ${jobs.length} jobs from data/digest-jobs.json`);
    } catch (e) {
      console.error(`Error reading digest-jobs.json: ${e.message}`);
    }
  }

  if (jobs.length === 0) {
    // Generate sample data for preview
    console.log('No jobs data found. Using sample data for preview...');
    jobs = getSampleJobs();
  }

  const result = await sendDigest(args.profile, jobs, {
    dryRun,
    dateFrom: args.from,
    dateTo: args.to,
  });

  if (result.previewPath) {
    console.log(`\nOpen in browser: file:///${result.previewPath.replace(/\\/g, '/')}`);
  }
}

function getSampleJobs() {
  return [
    {
      title: 'Oberarzt Psychiatrie',
      company: 'Klinikum rechts der Isar',
      url: 'https://example.com/job/1',
      location: 'Munich, Bayern, Germany',
      fitScore: 92,
      salary: '~\u20AC90K-130K (TV-\u00C4rzte Oberarzt)',
      flags: ['APPR', 'Bayern'],
      approbation: true,
      bundesland: 'Bayern',
      approbationDifficulty: 'strict',
    },
    {
      title: 'Fach\u00e4rztin f\u00fcr Psychiatrie',
      company: 'Universit\u00e4tsklinikum Heidelberg',
      url: 'https://example.com/job/2',
      location: 'Heidelberg, Baden-W\u00fcrttemberg, Germany',
      fitScore: 88,
      salary: '~\u20AC85K-120K (TV-\u00C4rzte)',
      flags: ['APPR', 'HD'],
      approbation: true,
      bundesland: 'Baden-W\u00fcrttemberg',
      approbationDifficulty: 'moderate',
    },
    {
      title: 'Staff Psychiatrist',
      company: 'Emory Healthcare',
      url: 'https://example.com/job/3',
      location: 'Atlanta, GA, USA',
      fitScore: 85,
      salary: '~$260K-320K',
      flags: ['EN'],
      approbation: false,
      bundesland: null,
      approbationDifficulty: null,
    },
    {
      title: 'Psychiatrist (Outpatient)',
      company: 'Charit\u00e9 Berlin',
      url: 'https://example.com/job/4',
      location: 'Berlin, Germany',
      fitScore: 76,
      salary: '~\u20AC80K-110K (TV-\u00C4rzte)',
      flags: ['APPR', 'EN'],
      approbation: true,
      bundesland: 'Berlin',
      approbationDifficulty: 'moderate',
    },
    {
      title: 'Attending Psychiatrist',
      company: 'Piedmont Healthcare',
      url: 'https://example.com/job/5',
      location: 'Atlanta, GA, USA',
      fitScore: 72,
      salary: '~$240K-290K',
      flags: ['EN'],
      approbation: false,
      bundesland: null,
      approbationDifficulty: null,
    },
    {
      title: 'Assistenzarzt Psychiatrie',
      company: 'Klinikum N\u00fcrnberg',
      url: 'https://example.com/job/6',
      location: 'N\u00fcrnberg, Bayern, Germany',
      fitScore: 65,
      salary: '~\u20AC65K-85K (TV-\u00C4rzte Assistenzarzt)',
      flags: ['APPR', 'Bayern'],
      approbation: true,
      bundesland: 'Bayern',
      approbationDifficulty: 'strict',
    },
    {
      title: 'Telepsychiatrist',
      company: 'Headway',
      url: 'https://example.com/job/7',
      location: 'Remote, USA',
      fitScore: 55,
      salary: '~$180K-220K',
      flags: ['EN'],
      approbation: false,
      bundesland: null,
      approbationDifficulty: null,
    },
  ];
}

// Run if executed directly
const isMainModule = process.argv[1] && (
  resolve(process.argv[1]) === resolve(__dirname, 'digest-sender.mjs') ||
  process.argv[1].endsWith('digest-sender.mjs')
);

if (isMainModule) {
  main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}
