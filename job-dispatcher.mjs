#!/usr/bin/env node

/**
 * job-dispatcher.mjs — Job Notification & Auto-Apply Dispatcher
 *
 * 3-mode intelligent job routing based on fit score:
 *   Mode 1 (80-100): Auto-Apply  → submit + send confirmation email
 *   Mode 2 (60-79):  Manual      → send email with cover letter PDF attached
 *   Mode 3 (40-59):  Approval    → send email asking YES/NO with draft CL inline
 *   Below 40:        Skip        → log only, no notification
 *
 * Scoring: Maps existing career-ops 0-5 scale → 0-100 fit score,
 * then applies the 8-dimension rubric for fine-grained routing.
 *
 * Email: Uses nodemailer via Gmail SMTP (Lukas.T@withlukas.com)
 *
 * Usage:
 *   node job-dispatcher.mjs --job='{"title":"..","company":"..","score":4.2,...}'
 *   node job-dispatcher.mjs --test          (send test email to active profile)
 *   node job-dispatcher.mjs --dry-run       (compute score + mode, no email)
 *
 * Typically called by Claude after evaluation, not manually.
 */

import { readFile, writeFile, appendFile, mkdir, stat } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { existsSync } from 'fs';
import { execFile } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================
// Retry Queue — persists failed emails for later resend
// ============================================================

const RETRY_QUEUE_PATH = resolve(__dirname, 'data/retry-queue.json');

async function loadRetryQueue() {
  try {
    return JSON.parse(await readFile(RETRY_QUEUE_PATH, 'utf8'));
  } catch {
    return [];
  }
}

async function saveRetryQueue(queue) {
  await writeFile(RETRY_QUEUE_PATH, JSON.stringify(queue, null, 2), 'utf8');
}

async function enqueueFailedEmail(job, careerOpsScore, fitScore, mode, profileName, errorMsg) {
  const queue = await loadRetryQueue();
  // Deduplicate by company+title+profile
  const key = `${job.company}|${job.title}|${profileName}`;
  if (queue.some(e => `${e.job.company}|${e.job.title}|${e.profileName}` === key)) return;
  queue.push({
    job: { title: job.title, company: job.company, url: job.url, location: job.location,
           salary: job.salary, platform: job.platform, source: job.source,
           matchReasons: job.matchReasons, draftCoverLetter: job.draftCoverLetter,
           coverLetterPath: job.coverLetterPath, cvPdfPath: job.cvPdfPath,
           cvDePdfPath: job.cvDePdfPath, cvEnPdfPath: job.cvEnPdfPath,
           postedDate: job.postedDate, sponsorship: job.sponsorship },
    careerOpsScore,
    fitScore,
    modeLabel: mode.label,
    profileName,
    error: errorMsg,
    failedAt: new Date().toISOString(),
    retries: 0,
  });
  await saveRetryQueue(queue);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Use nodemailer from Spectrum workspace
const require = createRequire(import.meta.url);
const nodemailer = require('C:/Users/Lukas/.openclaw/workspace/node_modules/nodemailer');

// ============================================================
// Email Configuration
// ============================================================

const EMAIL_CONFIG = {
  service: 'gmail',
  auth: {
    user: 'Lukas.T@withlukas.com',
    pass: 'qviq mipq qvjl ubpk',  // Gmail app password
  },
  from: '"Career-Ops" <Lukas.T@withlukas.com>',
};

// ============================================================
// Score Mapping: career-ops 0-5 → fit score 0-100
// ============================================================

/**
 * Maps the existing career-ops evaluation score (0-5) to the
 * 0-100 fit score system. The mapping is non-linear to match
 * the thresholds both systems expect:
 *
 *   career-ops 4.5-5.0 → fit 85-100  (auto-apply)
 *   career-ops 4.0-4.4 → fit 80-84   (auto-apply, lower confidence)
 *   career-ops 3.5-3.9 → fit 65-79   (manual review)
 *   career-ops 3.0-3.4 → fit 55-64   (manual review / approval border)
 *   career-ops 2.0-2.9 → fit 40-54   (approval needed)
 *   career-ops <2.0     → fit <40     (skip)
 */
function mapScoreToFit(careerOpsScore) {
  if (careerOpsScore >= 4.5) return Math.round(85 + (careerOpsScore - 4.5) * 30); // 85-100
  if (careerOpsScore >= 4.0) return Math.round(80 + (careerOpsScore - 4.0) * 10); // 80-84
  if (careerOpsScore >= 3.5) return Math.round(65 + (careerOpsScore - 3.5) * 28); // 65-79
  if (careerOpsScore >= 3.0) return Math.round(55 + (careerOpsScore - 3.0) * 20); // 55-64
  if (careerOpsScore >= 2.0) return Math.round(40 + (careerOpsScore - 2.0) * 15); // 40-54
  return Math.round(careerOpsScore * 20); // 0-39
}

/**
 * 8-dimension fit score rubric (0-100).
 * Used when full job data is available for fine-grained scoring.
 * Each dimension is scored independently, then summed.
 */
function computeFitScore(job, profile) {
  let score = 0;

  // Industry Match (0-20)
  if (job.industryMatch === 'exact') score += 20;
  else if (job.industryMatch === 'related') score += 15;
  else if (job.industryMatch === 'adjacent') score += 10;
  else score += 5; // unknown/neutral

  // Role Match (0-20)
  if (job.roleMatch === 'exact') score += 20;
  else if (job.roleMatch === 'similar') score += 15;
  else if (job.roleMatch === 'growth') score += 10;
  else score += 5;

  // Location Match (0-15)
  const prefLocations = profile.search_locations?.preferred || [];
  const accLocations = profile.search_locations?.acceptable || [];
  if (job.remote === 'full' || prefLocations.some(l => job.location?.includes(l))) score += 15;
  else if (accLocations.some(l => job.location?.includes(l))) score += 10;
  else if (job.location) score += 5;

  // Company Reputation (0-15)
  if (job.companyTier === 'top') score += 15;
  else if (job.companyTier === 'solid') score += 12;
  else if (job.companyTier === 'funded') score += 10;
  else score += 7; // unknown/neutral

  // Compensation (0-15)
  const minComp = parseInt(profile.compensation?.minimum?.replace(/[^0-9]/g, '') || '0');
  if (job.salaryMax && job.salaryMax > minComp * 1.2) score += 15;
  else if (job.salaryMax && job.salaryMax >= minComp) score += 13;
  else if (job.salaryMax && job.salaryMax >= minComp * 0.9) score += 8;
  else if (!job.salaryMax) score += 7; // not disclosed = neutral
  else score += 3;

  // Benefits (0-5)
  score += job.benefitsScore || 3; // default neutral

  // Remote Options (0-5)
  if (job.remote === 'full') score += 5;
  else if (job.remote === 'hybrid_3') score += 4;
  else if (job.remote === 'hybrid') score += 2;
  else score += 0;

  // Visa/Sponsorship (0-5) — all candidates are dual US/German citizens
  score += 5; // always max since no sponsorship needed

  return Math.min(100, score);
}

// ============================================================
// Mode Routing
// ============================================================

const MODES = {
  // Full-auto: only Top Match and Good Match get emailed.
  // Worth a Look (40-59) is logged but NOT emailed — too much noise for out-of-area jobs.
  TOP_MATCH:   { min: 80, max: 100, label: 'Top Match',     status: 'NOTIFIED',       template: 'email-manual-review.html' },
  GOOD_MATCH:  { min: 60, max: 79,  label: 'Good Match',    status: 'NOTIFIED',       template: 'email-manual-review.html' },
  WORTH_A_LOOK:{ min: 40, max: 59,  label: 'Worth a Look',  status: 'LOGGED_NO_EMAIL', template: null },
  SKIP:        { min: 0,  max: 39,  label: 'Skip',          status: 'SKIPPED_LOW_FIT', template: null },
};

function determineMode(fitScore) {
  if (fitScore >= 80) return MODES.TOP_MATCH;
  if (fitScore >= 60) return MODES.GOOD_MATCH;
  if (fitScore >= 40) return MODES.WORTH_A_LOOK;
  return MODES.SKIP;
}

// ============================================================
// Email Sending
// ============================================================

let transporter = null;

async function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: EMAIL_CONFIG.service,
      auth: EMAIL_CONFIG.auth,
    });
    // Verify connection
    await transporter.verify();
  }
  return transporter;
}

async function loadTemplate(templateName) {
  const path = resolve(__dirname, 'templates', templateName);
  return readFile(path, 'utf8');
}

function fillTemplate(html, vars) {
  let result = html;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value != null ? value : 'N/A');
  }
  return result;
}

function buildMatchReasons(job) {
  const reasons = job.matchReasons || [];
  if (reasons.length === 0) return '<p style="margin:0;color:#666;">Match details not available.</p>';
  return '<ul style="margin:0;padding-left:20px;color:#444;">' +
    reasons.map(r => `<li>${r}</li>`).join('') +
    '</ul>';
}

function subjectForMode(mode, job) {
  switch (mode) {
    case MODES.TOP_MATCH:
      return `⭐ Top Match: ${job.title} at ${job.company}`;
    case MODES.GOOD_MATCH:
      return `Job Found: ${job.title} at ${job.company}`;
    case MODES.WORTH_A_LOOK:
      return `Worth a Look: ${job.title} at ${job.company}`;
    default:
      return `Job Found: ${job.title} at ${job.company}`;
  }
}

async function sendNotification(mode, job, profile, fitScore, options = {}) {
  if (!mode.template) return { sent: false, reason: 'skip_mode' };
  if (options.dryRun) return { sent: false, reason: 'dry_run', mode: mode.label, fitScore };

  const templateHtml = await loadTemplate(mode.template);
  const firstName = profile.candidate?.full_name?.split(' ')[0] || 'there';
  const candidateEmail = profile.candidate?.email;

  if (!candidateEmail) {
    return { sent: false, reason: 'no_candidate_email' };
  }

  const vars = {
    FIRST_NAME: firstName,
    JOB_TITLE: job.title || 'Unknown',
    COMPANY_NAME: job.company || 'Unknown',
    LOCATION: job.location || 'Not specified',
    SALARY_RANGE: job.salary || 'Not disclosed',
    FIT_SCORE: String(fitScore),
    APPLICATION_URL: job.url || '#',
    PORTAL_NAME: job.platform || job.source || 'Job Board',
    TIMESTAMP: new Date().toISOString().replace('T', ' ').slice(0, 19),
    POSTED_DATE: job.postedDate || 'Recent',
    MATCH_REASONS: buildMatchReasons(job),
    DRAFT_COVER_LETTER: job.draftCoverLetter || '<p><em>Cover letter will be generated upon approval.</em></p>',
    ATTACHMENTS_SECTION: buildAttachmentsSection(job),
    TALKING_POINTS: buildTalkingPoints(job),
    SPONSORSHIP_BANNER: buildSponsorshipBanner(job, profile),
  };

  const html = fillTemplate(templateHtml, vars);
  const subject = subjectForMode(mode, job);

  // Build email options
  const mailOptions = {
    from: EMAIL_CONFIG.from,
    to: candidateEmail,
    subject,
    html,
    headers: {
      'X-Career-Ops-Mode': mode.label,
      'X-Career-Ops-Score': String(fitScore),
      'X-Career-Ops-Company': job.company || '',
      'X-Career-Ops-Profile': profile.candidate?.full_name || '',
    },
  };

  // Attach generated documents to ALL notification emails (not just Manual Review).
  // If Resume/Lebenslauf/Cover Letter were auto-generated, the candidate needs them
  // for confirmation (Auto-Apply) or to apply manually (Manual/Approval).
  const attachments = [];
  const safeName = profile.candidate?.full_name?.replace(/[^a-zA-Z]/g, '-') || 'Candidate';

  // Cover letter PDF
  if (job.coverLetterPath && existsSync(job.coverLetterPath)) {
    attachments.push({
      filename: `${safeName}-${job.company}-CoverLetter.pdf`,
      path: job.coverLetterPath,
    });
  }

  // Primary CV/Resume PDF
  if (job.cvPdfPath && existsSync(job.cvPdfPath)) {
    attachments.push({
      filename: `${safeName}-CV.pdf`,
      path: job.cvPdfPath,
    });
  }

  // German Lebenslauf PDF (if auto-generated or exists for German jobs)
  if (job.cvDePdfPath && existsSync(job.cvDePdfPath)) {
    attachments.push({
      filename: `${safeName}-Lebenslauf.pdf`,
      path: job.cvDePdfPath,
    });
  }

  // English CV as secondary attachment for German jobs
  if (job.cvEnPdfPath && existsSync(job.cvEnPdfPath) && job.cvEnPdfPath !== job.cvPdfPath) {
    attachments.push({
      filename: `${safeName}-CV-English.pdf`,
      path: job.cvEnPdfPath,
    });
  }

  if (attachments.length > 0) {
    mailOptions.attachments = attachments;
  }

  try {
    const transport = await getTransporter();
    const info = await transport.sendMail(mailOptions);
    return {
      sent: true,
      messageId: info.messageId,
      mode: mode.label,
      fitScore,
      to: candidateEmail,
      subject,
    };
  } catch (err) {
    return { sent: false, reason: err.message, mode: mode.label, fitScore, rateLimited: /too many login|454.*4\.7\.0/i.test(err.message) };
  }
}

// ============================================================
// Apply Log
// ============================================================

async function logDispatch(job, mode, fitScore, emailResult, profileName) {
  const logPath = resolve(__dirname, 'data/apply-log.md');
  const date = new Date().toISOString().split('T')[0];
  const time = new Date().toISOString().split('T')[1].slice(0, 8);

  const line = `| ${date} | ${time} | ${profileName} | ${job.company} | ${job.title} | ${job.platform || 'N/A'} | ${mode.label} | ${fitScore}/100 | ${emailResult.sent ? 'Sent' : 'N/A'} | ${mode.status} | ${emailResult.reason || ''} |`;

  try {
    const existing = await readFile(logPath, 'utf8');
    await writeFile(logPath, existing.trimEnd() + '\n' + line + '\n', 'utf8');
  } catch {
    const header = `# Job Dispatch Log\n\n| Date | Time | Profile | Company | Role | Platform | Mode | Score | Email | Status | Notes |\n|------|------|---------|---------|------|----------|------|-------|-------|--------|-------|\n${line}\n`;
    await writeFile(logPath, header, 'utf8');
  }
}

// ============================================================
// Profile Loading
// ============================================================

async function loadActiveProfile() {
  const activeYml = await readFile(resolve(__dirname, 'profiles/active.yml'), 'utf8');
  const match = activeYml.match(/active:\s*(\w+)/);
  const name = match ? match[1] : 'paulina';

  const profileYml = await readFile(resolve(__dirname, `profiles/${name}/profile.yml`), 'utf8');

  // Simple YAML parser for the fields we need
  const profile = {};
  const candidateMatch = profileYml.match(/candidate:\s*\n([\s\S]*?)(?=\n\w|\n$)/);
  if (candidateMatch) {
    const block = candidateMatch[1];
    profile.candidate = {
      full_name: block.match(/full_name:\s*"(.+?)"/)?.[1],
      email: block.match(/email:\s*"(.+?)"/)?.[1],
      phone: block.match(/phone:\s*"(.+?)"/)?.[1],
      location: block.match(/location:\s*"(.+?)"/)?.[1],
    };
  }

  const compMatch = profileYml.match(/compensation:\s*\n([\s\S]*?)(?=\n\w|\n$)/);
  if (compMatch) {
    const block = compMatch[1];
    profile.compensation = {
      minimum: block.match(/minimum:\s*"(.+?)"/)?.[1],
      target_range: block.match(/target_range:\s*"(.+?)"/)?.[1],
    };
  }

  // Sponsorship priority settings
  profile.sponsorship_priority = /sponsorship_priority:\s*true/i.test(profileYml);
  const boostMatch = profileYml.match(/sponsorship_boost:\s*(\d+)/);
  profile.sponsorship_boost = boostMatch ? parseInt(boostMatch[1]) : 0;

  return { name, profile };
}

// ============================================================
// CV PDF Generation
// ============================================================

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Convert markdown CV to simple, clean HTML suitable for PDF generation.
 * Does not use the fancy cv-template.html (which requires per-section
 * template variables filled by Claude). Instead produces a clean,
 * professional HTML doc with the same fonts and color scheme.
 */
function markdownCvToHtml(md, profileName) {
  // Basic markdown → HTML conversion for CV structure
  let html = md;

  // Escape HTML entities first (but preserve markdown syntax)
  html = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Bold: **text**
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // H1: # Title (name)
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  // H2: ## Section
  html = html.replace(/^## (.+)$/gm, '<div class="section-title">$1</div>');
  // H3: ### Job Title | Company | Location | Date
  html = html.replace(/^### (.+)$/gm, '<div class="job-header-line">$1</div>');

  // List items: - text
  // Group consecutive list items into <ul> blocks
  const lines = html.split('\n');
  const processed = [];
  let inList = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('- ')) {
      if (!inList) { processed.push('<ul>'); inList = true; }
      processed.push(`<li>${trimmed.slice(2)}</li>`);
    } else {
      if (inList) { processed.push('</ul>'); inList = false; }
      if (trimmed === '') {
        processed.push('');
      } else {
        processed.push(line);
      }
    }
  }
  if (inList) processed.push('</ul>');
  html = processed.join('\n');

  // Wrap plain text paragraphs (lines not already wrapped in HTML)
  html = html.replace(/^(?!<[a-z/])(.+)$/gm, (_, text) => {
    const t = text.trim();
    if (!t || t.startsWith('<')) return text;
    return `<p>${t}</p>`;
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${profileName} CV</title>
<style>
  @font-face {
    font-family: 'Space Grotesk';
    src: url('./fonts/space-grotesk-latin.woff2') format('woff2');
    font-weight: 300 700; font-style: normal; font-display: swap;
  }
  @font-face {
    font-family: 'DM Sans';
    src: url('./fonts/dm-sans-latin.woff2') format('woff2');
    font-weight: 100 1000; font-style: normal; font-display: swap;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body {
    font-family: 'DM Sans', sans-serif;
    font-size: 11px; line-height: 1.55; color: #1a1a2e;
    background: #fff; padding: 0; margin: 0;
  }
  h1 {
    font-family: 'Space Grotesk', sans-serif;
    font-size: 24px; font-weight: 700; color: #1a1a2e;
    letter-spacing: -0.02em; margin-bottom: 4px;
    border-bottom: 2px solid; border-image: linear-gradient(to right, hsl(187,74%,32%), hsl(270,70%,45%)) 1;
    padding-bottom: 8px;
  }
  .section-title {
    font-family: 'Space Grotesk', sans-serif;
    font-size: 13px; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.05em; color: hsl(187,74%,32%);
    border-bottom: 1px solid #e5e5e5; padding-bottom: 3px;
    margin: 14px 0 8px;
  }
  .job-header-line {
    font-family: 'Space Grotesk', sans-serif;
    font-size: 11.5px; font-weight: 600; color: hsl(270,70%,45%);
    margin: 10px 0 4px;
  }
  p { margin: 4px 0; font-size: 11px; color: #333; }
  ul { padding-left: 16px; margin: 4px 0; }
  li { font-size: 10.5px; line-height: 1.5; color: #333; margin-bottom: 2px; }
  li strong { font-weight: 600; }
  strong { font-weight: 600; }
</style>
</head>
<body>
${html}
</body>
</html>`;
}

/**
 * Run a command and return a promise.
 */
function runCommand(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 60000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${err.message}\n${stderr}`));
      else resolve(stdout);
    });
  });
}

/**
 * Ensure a CV/Lebenslauf markdown has a contact section.
 * If not present, inject one from profile.yml data after the H1 title.
 */
function ensureContactSection(md, profileData, lang = 'en') {
  // Check if contact info already exists in the markdown
  const hasContact = /## Contact|## Kontakt|## Persönliche Daten|## Personliche Daten/i.test(md);
  if (hasContact) return md;

  // Build contact section from profile data
  const lines = [];
  if (lang === 'de') {
    lines.push('\n## Persönliche Daten\n');
    if (profileData.full_name) lines.push(`- **Name:** ${profileData.full_name}`);
    if (profileData.location) lines.push(`- **Anschrift:** ${profileData.location}`);
    if (profileData.phone) lines.push(`- **Telefon:** ${profileData.phone}`);
    if (profileData.email) lines.push(`- **E-Mail:** ${profileData.email}`);
    if (profileData.linkedin) lines.push(`- **LinkedIn:** ${profileData.linkedin}`);
    if (profileData.portfolio_url) lines.push(`- **Portfolio:** ${profileData.portfolio_url}`);
  } else {
    lines.push('\n## Contact\n');
    if (profileData.phone) lines.push(`- Phone: ${profileData.phone}`);
    if (profileData.email) lines.push(`- Email: ${profileData.email}`);
    if (profileData.location) lines.push(`- Location: ${profileData.location}`);
    if (profileData.linkedin) lines.push(`- LinkedIn: ${profileData.linkedin}`);
    if (profileData.portfolio_url) lines.push(`- Website: ${profileData.portfolio_url}`);
  }

  if (lines.length <= 1) return md; // no profile data to inject

  const contactBlock = lines.join('\n') + '\n';

  // Insert after the first H1 line
  const h1Match = md.match(/^# .+$/m);
  if (h1Match) {
    const insertPos = md.indexOf(h1Match[0]) + h1Match[0].length;
    return md.slice(0, insertPos) + '\n' + contactBlock + md.slice(insertPos);
  }

  // No H1 — prepend
  return contactBlock + '\n' + md;
}

/**
 * Ensure a CV PDF exists for the given profile. Idempotent:
 * if the PDF exists and is less than 7 days old, skip regeneration.
 *
 * @param {string} profileName - e.g. 'lamin', 'paulina'
 * @returns {{ cvPdfPath: string|null, cvDePdfPath: string|null }}
 */
async function ensureProfilePdfs(profileName) {
  const profileDir = resolve(__dirname, 'profiles', profileName);
  const outputDir = resolve(profileDir, 'output');
  const result = { cvPdfPath: null, cvDePdfPath: null };

  // Ensure output directory exists
  await mkdir(outputDir, { recursive: true });

  // Load profile.yml for contact info injection
  const profileYmlPath = resolve(profileDir, 'profile.yml');
  let profileData = {};
  try {
    const yml = await readFile(profileYmlPath, 'utf8');
    const candidateBlock = yml.match(/candidate:\s*\n([\s\S]*?)(?=\n\w|\n$)/)?.[1] || '';
    profileData = {
      full_name: candidateBlock.match(/full_name:\s*"(.+?)"/)?.[1] || '',
      email: candidateBlock.match(/email:\s*"(.+?)"/)?.[1] || '',
      phone: candidateBlock.match(/phone:\s*"(.+?)"/)?.[1] || '',
      location: candidateBlock.match(/location:\s*"(.+?)"/)?.[1] || '',
      linkedin: candidateBlock.match(/linkedin:\s*"(.+?)"/)?.[1] || '',
      portfolio_url: candidateBlock.match(/portfolio_url:\s*"(.+?)"/)?.[1] || '',
    };
  } catch { /* proceed without — cv.md may have it */ }

  // --- English CV ---
  const cvMdPath = resolve(profileDir, 'cv.md');
  const cvPdfPath = resolve(outputDir, `cv-${profileName}.pdf`);

  if (existsSync(cvMdPath)) {
    const needsRegen = await needsRegeneration(cvPdfPath);
    if (needsRegen) {
      console.log(`  [PDF] Generating CV PDF for ${profileName}...`);
      try {
        let md = await readFile(cvMdPath, 'utf8');
        // Ensure contact info exists — inject from profile.yml if missing
        md = ensureContactSection(md, profileData, 'en');
        const html = markdownCvToHtml(md, profileName);
        const htmlPath = resolve(outputDir, `cv-${profileName}.html`);
        await writeFile(htmlPath, html, 'utf8');

        await runCommand(process.execPath, [
          resolve(__dirname, 'generate-pdf.mjs'),
          htmlPath,
          cvPdfPath,
          '--format=letter',
        ]);
        console.log(`  [PDF] CV PDF ready: ${cvPdfPath}`);
        result.cvPdfPath = cvPdfPath;
      } catch (err) {
        console.error(`  [PDF] CV PDF generation failed: ${err.message}`);
      }
    } else {
      console.log(`  [PDF] CV PDF exists and is recent: ${cvPdfPath}`);
      result.cvPdfPath = cvPdfPath;
    }
  }

  // --- German CV (Lebenslauf) ---
  const cvDeMdPath = resolve(profileDir, 'cv-de.md');
  const cvDePdfPath = resolve(outputDir, `cv-de-${profileName}.pdf`);

  if (existsSync(cvDeMdPath)) {
    const needsRegen = await needsRegeneration(cvDePdfPath);
    if (needsRegen) {
      console.log(`  [PDF] Generating Lebenslauf PDF for ${profileName}...`);
      try {
        let md = await readFile(cvDeMdPath, 'utf8');
        md = ensureContactSection(md, profileData, 'de');
        const html = markdownCvToHtml(md, profileName);
        const htmlPath = resolve(outputDir, `cv-de-${profileName}.html`);
        await writeFile(htmlPath, html, 'utf8');

        await runCommand(process.execPath, [
          resolve(__dirname, 'generate-pdf.mjs'),
          htmlPath,
          cvDePdfPath,
          '--format=a4',
        ]);
        console.log(`  [PDF] Lebenslauf PDF ready: ${cvDePdfPath}`);
        result.cvDePdfPath = cvDePdfPath;
      } catch (err) {
        console.error(`  [PDF] Lebenslauf PDF generation failed: ${err.message}`);
      }
    } else {
      console.log(`  [PDF] Lebenslauf PDF exists and is recent: ${cvDePdfPath}`);
      result.cvDePdfPath = cvDePdfPath;
    }
  }

  return result;
}

/**
 * Check if a PDF file needs regeneration (doesn't exist or older than 7 days).
 */
async function needsRegeneration(pdfPath) {
  if (!existsSync(pdfPath)) return true;
  try {
    const stats = await stat(pdfPath);
    return (Date.now() - stats.mtimeMs) > SEVEN_DAYS_MS;
  } catch {
    return true;
  }
}

/**
 * Build the dynamic attachments section HTML for email templates.
 * Returns HTML <ul> contents based on which PDFs are actually attached.
 */
function buildAttachmentsSection(job) {
  const items = [];

  if (job.coverLetterPath && existsSync(job.coverLetterPath)) {
    items.push('<li>Personalized cover letter (attached as PDF)</li>');
  }

  if (job.cvPdfPath && existsSync(job.cvPdfPath)) {
    items.push('<li>Your up-to-date CV/resume (attached as PDF)</li>');
  }
  if (job.cvDePdfPath && existsSync(job.cvDePdfPath)) {
    items.push('<li>Your Lebenslauf (attached as PDF)</li>');
  }

  if (job.talkingPoints && job.talkingPoints.length > 0) {
    items.push('<li>Key talking points for phone screen (see below)</li>');
  }

  if (items.length === 0) {
    items.push('<li>Cover letter and CV will be prepared when you\'re ready to apply</li>');
  }

  return items.join('\n      ');
}

/**
 * Build talking points HTML for the email body.
 * Returns a styled section with bullet points, or empty string if none.
 */
function buildTalkingPoints(job) {
  const points = job.talkingPoints || [];
  if (points.length === 0) return '';

  return `
  <div style="background: #f0f4ff; border: 1px solid #c5cae9; padding: 16px; border-radius: 6px; margin: 16px 0;">
    <p style="margin: 0 0 8px; font-weight: 600; color: #283593;">Phone Screen Talking Points</p>
    <ol style="margin: 0; padding-left: 20px; color: #444;">
      ${points.map(p => `<li style="margin-bottom: 6px;">${p}</li>`).join('\n      ')}
    </ol>
  </div>`;
}

// ============================================================
// Sponsorship Banner (Approbation / Credential Transfer)
// ============================================================

function buildSponsorshipBanner(job, profile) {
  if (!profile.sponsorship_priority) return '';

  const sp = job.sponsorship;
  if (!sp) return '';

  const isApprobation = sp.approbation ||
    ['APPROBATION', 'APPROBATION_LIKELY'].includes(sp.sponsorship_status);
  const isGeneral = !isApprobation &&
    ['CONFIRMED', 'LIKELY'].includes(sp.sponsorship_status);

  if (!isApprobation && !isGeneral) return '';

  const title = isApprobation
    ? 'Approbation / Credential Transfer Support'
    : 'Sponsorship Opportunity';
  const detail = isApprobation
    ? 'This employer signals support for international medical credential recognition (Approbation / Berufserlaubnis). This could fast-track your path to practicing in Germany.'
    : 'This employer indicates sponsorship support for international candidates.';
  const reason = sp.sponsorship_reason || '';

  return `
  <div style="background: #e8f5e9; border: 2px solid #2e7d32; padding: 16px; border-radius: 6px; margin: 16px 0;">
    <p style="margin: 0 0 8px; font-weight: 700; color: #1b5e20; font-size: 15px;">&#9989; ${title}</p>
    <p style="margin: 0 0 6px; color: #2e7d32; font-size: 13px;">${detail}</p>
    ${reason ? `<p style="margin: 0; color: #555; font-size: 12px; font-style: italic;">Signal: ${reason}</p>` : ''}
  </div>`;
}

// ============================================================
// Auto-Apply Consent Gate
// ============================================================

async function loadApprovalConfig(profileName) {
  const configPath = resolve(__dirname, `profiles/${profileName}/approval-config.yml`);
  try {
    const yml = await readFile(configPath, 'utf8');
    return {
      autoApplyConsent: /auto_apply_consent:\s*true/i.test(yml),
      mode: yml.match(/^\s*mode:\s*(\w+)/m)?.[1] || 'manual',
      threshold: parseFloat(yml.match(/threshold:\s*([\d.]+)/)?.[1] || '4.5'),
      minimumScore: parseFloat(yml.match(/minimum_score:\s*([\d.]+)/)?.[1] || '3.5'),
    };
  } catch {
    // No config file = defaults (consent OFF, manual mode)
    return { autoApplyConsent: false, mode: 'manual', threshold: 4.5, minimumScore: 3.5 };
  }
}

// ============================================================
// Main — Dispatch a Job
// ============================================================

/**
 * Primary API for Claude to call after evaluating a job.
 * Accepts a job object with evaluation data and dispatches
 * to the appropriate notification mode.
 *
 * Auto-apply consent gate: If auto_apply_consent is false in the
 * profile's approval-config.yml, Mode 1 (Auto-Apply) is downgraded
 * to Mode 2 (Manual Review). No applications are ever submitted
 * without explicit opt-in.
 *
 * @param {object} job - Job data with at least: title, company, url
 * @param {number} careerOpsScore - The 0-5 evaluation score from oferta mode
 * @param {object} options - { dryRun, coverLetterPath, cvPdfPath, matchReasons, draftCoverLetter }
 */
export async function dispatch(job, careerOpsScore, options = {}) {
  const { name: profileName, profile } = await loadActiveProfile();
  const approvalConfig = await loadApprovalConfig(profileName);

  // Compute fit score
  let fitScore = job.fitScore || mapScoreToFit(careerOpsScore);

  // Sponsorship priority boost: if profile has sponsorship_priority and job has sponsorship data
  const hasSponsorshipSignal = job.sponsorship?.approbation ||
    ['APPROBATION', 'APPROBATION_LIKELY', 'CONFIRMED', 'LIKELY'].includes(job.sponsorship?.sponsorship_status);
  if (profile.sponsorship_priority && hasSponsorshipSignal) {
    const boost = profile.sponsorship_boost || 10;
    fitScore = Math.min(100, fitScore + boost);
    console.log(`  [SPONSORSHIP] +${boost} fit score boost (${job.sponsorship.sponsorship_status}: ${job.sponsorship.sponsorship_reason})`);
  }

  // Determine mode — full-auto: all tiers send the same notification email
  let mode = determineMode(fitScore);

  // Merge paths into job
  job.coverLetterPath = options.coverLetterPath || job.coverLetterPath;
  job.cvPdfPath = options.cvPdfPath || job.cvPdfPath;
  job.cvDePdfPath = options.cvDePdfPath || job.cvDePdfPath;
  job.cvEnPdfPath = options.cvEnPdfPath || job.cvEnPdfPath;
  job.matchReasons = options.matchReasons || job.matchReasons;
  job.draftCoverLetter = options.draftCoverLetter || job.draftCoverLetter;

  // Ensure CV PDFs exist (idempotent — skips if recent PDF exists)
  if (!options.dryRun && mode !== MODES.SKIP) {
    try {
      const pdfs = await ensureProfilePdfs(profileName);
      // Merge generated PDF paths into job if not already set
      if (!job.cvPdfPath && pdfs.cvPdfPath) {
        job.cvPdfPath = pdfs.cvPdfPath;
      }
      if (!job.cvDePdfPath && pdfs.cvDePdfPath) {
        job.cvDePdfPath = pdfs.cvDePdfPath;
      }
    } catch (err) {
      console.error(`  [PDF] Failed to ensure profile PDFs: ${err.message}`);
    }
  }

  console.log(`\n  Job Dispatcher — ${profileName}`);
  console.log(`  ${'━'.repeat(50)}`);
  console.log(`  Job:       ${job.title} at ${job.company}`);
  console.log(`  Score:     ${careerOpsScore}/5 → Fit: ${fitScore}/100`);
  console.log(`  Mode:      ${mode.label} (${mode.status})`);
  console.log(`  Candidate: ${profile.candidate?.full_name} <${profile.candidate?.email}>`);

  // Send notification
  const emailResult = await sendNotification(mode, job, profile, fitScore, options);

  if (emailResult.sent) {
    console.log(`  Email:     SENT → ${emailResult.to}`);
    console.log(`  Subject:   ${emailResult.subject}`);
  } else {
    console.log(`  Email:     ${emailResult.reason}`);
    // Queue for retry if it was a rate limit or transient error
    if (!options.dryRun && emailResult.rateLimited) {
      await enqueueFailedEmail(job, careerOpsScore, fitScore, mode, profileName, emailResult.reason);
      console.log(`  Queued:    data/retry-queue.json (will retry later)`);
    }
  }

  // Log
  if (!options.dryRun) {
    await logDispatch(job, mode, fitScore, emailResult, profileName);
    console.log(`  Logged:    data/apply-log.md`);
  }

  return { mode: mode.label, fitScore, status: mode.status, email: emailResult };
}

// ============================================================
// CLI Entry Point
// ============================================================

async function main() {
  const args = process.argv.slice(2);

  // --enable-auto-apply: Interactive consent flow
  if (args.includes('--enable-auto-apply')) {
    const profileArg = args.find(a => a.startsWith('--profile='));
    let profileName;
    if (profileArg) {
      profileName = profileArg.split('=')[1];
    } else {
      const activeYml = await readFile(resolve(__dirname, 'profiles/active.yml'), 'utf8');
      profileName = activeYml.match(/active:\s*(\w+)/)?.[1] || 'paulina';
    }

    const configPath = resolve(__dirname, `profiles/${profileName}/approval-config.yml`);
    const existing = await loadApprovalConfig(profileName);

    if (existing.autoApplyConsent) {
      console.log(`\n  Auto-apply is already enabled for ${profileName}.\n`);
      return;
    }

    // Display consent notice
    console.log(`
  ╔══════════════════════════════════════════════════════════╗
  ║           AUTO-APPLY CONSENT — ${profileName.toUpperCase().padEnd(20)}       ║
  ╠══════════════════════════════════════════════════════════╣
  ║                                                          ║
  ║  By enabling auto-apply, you consent to the following:   ║
  ║                                                          ║
  ║  1. Jobs scoring 80+/100 (4.0+/5) will trigger           ║
  ║     automatic application submission on supported         ║
  ║     ATS platforms (Greenhouse, Lever, Ashby).            ║
  ║                                                          ║
  ║  2. A confirmation email will be sent to your inbox      ║
  ║     AFTER the application is submitted.                  ║
  ║                                                          ║
  ║  3. Your resume and cover letter will be uploaded        ║
  ║     to employer systems automatically.                   ║
  ║                                                          ║
  ║  4. You can revoke consent at any time by setting        ║
  ║     auto_apply_consent: false in your config file        ║
  ║     or running: node job-dispatcher.mjs --disable-auto-apply ║
  ║                                                          ║
  ║  Without consent (current state):                        ║
  ║  - High-scoring jobs send "Action Needed" emails         ║
  ║  - You manually apply via the link in the email          ║
  ║  - No applications are ever auto-submitted               ║
  ║                                                          ║
  ╚══════════════════════════════════════════════════════════╝
`);

    // Check for --confirm flag
    if (!args.includes('--confirm')) {
      console.log(`  To confirm, re-run with --confirm:`);
      console.log(`    node job-dispatcher.mjs --enable-auto-apply --profile=${profileName} --confirm\n`);
      return;
    }

    // Write consent
    const configContent = `# Auto-Apply Approval Configuration — ${profileName}
# Generated: ${new Date().toISOString().split('T')[0]}
# To revoke: set auto_apply_consent to false

approval:
  auto_apply_consent: true
  mode: manual
  threshold: 4.5
  minimum_score: 3.5
  require_cover_letter: true
  require_cv_pdf: true
  notify_before_submit: true
  max_per_session: 10
  salary_strategy: range
  platforms:
    greenhouse: manual
    lever: manual
    ashby: manual
    workday: manual
    icims: manual
`;
    await writeFile(configPath, configContent, 'utf8');
    console.log(`  Auto-apply ENABLED for ${profileName}.`);
    console.log(`  Config written to: profiles/${profileName}/approval-config.yml`);
    console.log(`  To revoke: node job-dispatcher.mjs --disable-auto-apply --profile=${profileName}\n`);
    return;
  }

  // --disable-auto-apply: Revoke consent
  if (args.includes('--disable-auto-apply')) {
    const profileArg = args.find(a => a.startsWith('--profile='));
    let profileName;
    if (profileArg) {
      profileName = profileArg.split('=')[1];
    } else {
      const activeYml = await readFile(resolve(__dirname, 'profiles/active.yml'), 'utf8');
      profileName = activeYml.match(/active:\s*(\w+)/)?.[1] || 'paulina';
    }

    const configPath = resolve(__dirname, `profiles/${profileName}/approval-config.yml`);
    try {
      let content = await readFile(configPath, 'utf8');
      content = content.replace(/auto_apply_consent:\s*true/i, 'auto_apply_consent: false');
      await writeFile(configPath, content, 'utf8');
      console.log(`\n  Auto-apply DISABLED for ${profileName}. All jobs will route to Manual Review.\n`);
    } catch {
      console.log(`\n  No approval config found for ${profileName}. Auto-apply was never enabled.\n`);
    }
    return;
  }

  // --retry: Process the retry queue with pacing
  if (args.includes('--retry')) {
    const queue = await loadRetryQueue();
    if (queue.length === 0) {
      console.log('\n  Retry queue is empty. Nothing to send.\n');
      return;
    }

    const dryRun = args.includes('--dry-run');
    const delayMs = 3000; // 3 seconds between emails to avoid rate limits
    const succeeded = [];
    const stillFailed = [];

    console.log(`\n  Retry Queue — ${queue.length} emails to process`);
    console.log(`  Pacing: ${delayMs / 1000}s between sends${dryRun ? ' (DRY RUN)' : ''}`);
    console.log(`  ${'━'.repeat(50)}\n`);

    // Create one transporter for the entire retry run
    let transport;
    try {
      transport = nodemailer.createTransport({
        service: EMAIL_CONFIG.service,
        auth: EMAIL_CONFIG.auth,
        pool: true,
        maxConnections: 1,
        rateDelta: delayMs,
        rateLimit: 1,
      });
      await transport.verify();
    } catch (err) {
      console.error(`  Failed to connect to Gmail: ${err.message}`);
      console.log('  Tip: Wait a few minutes and try again if rate-limited.\n');
      return;
    }

    for (let i = 0; i < queue.length; i++) {
      const entry = queue[i];
      console.log(`  [${i + 1}/${queue.length}] ${entry.job.title} at ${entry.job.company} (fit ${entry.fitScore})`);

      if (dryRun) {
        console.log(`    → DRY RUN — would send to ${entry.profileName}`);
        succeeded.push(entry);
        continue;
      }

      // Reload profile for email address
      const profileYml = await readFile(resolve(__dirname, `profiles/${entry.profileName}/profile.yml`), 'utf8');
      const candidateEmail = profileYml.match(/email:\s*"(.+?)"/)?.[1];
      if (!candidateEmail) {
        console.log(`    → SKIP — no email for profile ${entry.profileName}`);
        stillFailed.push({ ...entry, error: 'no_candidate_email' });
        continue;
      }

      // Determine mode from fitScore
      const mode = determineMode(entry.fitScore);
      if (!mode.template) {
        console.log(`    → SKIP — mode ${mode.label} has no template`);
        succeeded.push(entry); // remove from queue, shouldn't have been queued
        continue;
      }

      // Build and send
      try {
        const templateHtml = await loadTemplate(mode.template);
        const firstName = candidateEmail.split('@')[0]; // fallback
        const job = entry.job;
        const vars = {
          FIRST_NAME: firstName,
          JOB_TITLE: job.title || 'Unknown',
          COMPANY_NAME: job.company || 'Unknown',
          LOCATION: job.location || 'Not specified',
          SALARY_RANGE: job.salary || 'Not disclosed',
          FIT_SCORE: String(entry.fitScore),
          APPLICATION_URL: job.url || '#',
          PORTAL_NAME: job.platform || job.source || 'Job Board',
          TIMESTAMP: new Date().toISOString().replace('T', ' ').slice(0, 19),
          POSTED_DATE: job.postedDate || 'Recent',
          MATCH_REASONS: buildMatchReasons(job),
          DRAFT_COVER_LETTER: job.draftCoverLetter || '<p><em>Cover letter will be generated upon approval.</em></p>',
          ATTACHMENTS_SECTION: buildAttachmentsSection(job),
          TALKING_POINTS: buildTalkingPoints(job),
          SPONSORSHIP_BANNER: buildSponsorshipBanner(job, { sponsorship_priority: false }),
        };

        const html = fillTemplate(templateHtml, vars);
        const subject = subjectForMode(mode, job);

        const mailOptions = {
          from: EMAIL_CONFIG.from,
          to: candidateEmail,
          subject,
          html,
          headers: {
            'X-Career-Ops-Mode': mode.label,
            'X-Career-Ops-Score': String(entry.fitScore),
            'X-Career-Ops-Company': job.company || '',
            'X-Career-Ops-Profile': entry.profileName,
            'X-Career-Ops-Retry': String(entry.retries + 1),
          },
        };

        // Attach PDFs if they still exist
        const attachments = [];
        if (job.coverLetterPath && existsSync(job.coverLetterPath)) {
          attachments.push({ filename: `CoverLetter.pdf`, path: job.coverLetterPath });
        }
        if (job.cvPdfPath && existsSync(job.cvPdfPath)) {
          attachments.push({ filename: `CV.pdf`, path: job.cvPdfPath });
        }
        if (job.cvDePdfPath && existsSync(job.cvDePdfPath)) {
          attachments.push({ filename: `Lebenslauf.pdf`, path: job.cvDePdfPath });
        }
        if (attachments.length > 0) mailOptions.attachments = attachments;

        const info = await transport.sendMail(mailOptions);
        console.log(`    → SENT (${info.messageId})`);
        succeeded.push(entry);

        // Log the retry success
        await logDispatch(job, mode, entry.fitScore, { sent: true, messageId: info.messageId }, entry.profileName);

      } catch (err) {
        entry.retries++;
        entry.error = err.message;
        entry.lastRetryAt = new Date().toISOString();
        stillFailed.push(entry);
        console.log(`    → FAILED: ${err.message.split('\n')[0]}`);

        // If rate-limited again, stop processing — no point hammering
        if (/too many login|454.*4\.7\.0/i.test(err.message)) {
          console.log(`\n  Rate-limited again. Stopping. Remaining ${queue.length - i - 1} emails stay in queue.`);
          stillFailed.push(...queue.slice(i + 1));
          break;
        }
      }

      // Pace between sends
      if (i < queue.length - 1) await sleep(delayMs);
    }

    // Save remaining failures back to queue (dry-run preserves the full queue)
    if (dryRun) {
      console.log(`\n  (Dry run — queue unchanged)`);
    } else {
      await saveRetryQueue(stillFailed);
    }
    transport.close();

    console.log(`\n  Results: ${succeeded.length} sent, ${stillFailed.length} still queued`);
    if (stillFailed.length > 0) {
      console.log(`  Run again later: node job-dispatcher.mjs --retry\n`);
    } else {
      console.log(`  Queue cleared!\n`);
    }
    return;
  }

  // --backfill-retry: Parse apply-log for rate-limited entries and add to retry queue
  if (args.includes('--backfill-retry')) {
    const logPath = resolve(__dirname, 'data/apply-log.md');
    const logContent = await readFile(logPath, 'utf8');
    const lines = logContent.split('\n').filter(l => l.startsWith('|') && /454.*4\.7\.0|Too many login/i.test(l));

    if (lines.length === 0) {
      console.log('\n  No rate-limited entries found in apply-log.\n');
      return;
    }

    const queue = await loadRetryQueue();
    let added = 0;

    for (const line of lines) {
      const cols = line.split('|').map(c => c.trim()).filter(Boolean);
      if (cols.length < 8) continue;

      const [date, time, profileName, company, title, platform, modeLabel, scoreStr] = cols;
      const fitScore = parseInt(scoreStr) || 60;

      const key = `${company}|${title}|${profileName}`;
      if (queue.some(e => `${e.job.company}|${e.job.title}|${e.profileName}` === key)) continue;

      queue.push({
        job: { title, company, url: null, location: null, salary: null, platform, source: platform },
        careerOpsScore: fitScore >= 80 ? 4.2 : fitScore >= 60 ? 3.5 : 2.5,
        fitScore,
        modeLabel,
        profileName,
        error: 'backfilled from apply-log',
        failedAt: `${date}T${time}`,
        retries: 0,
      });
      added++;
    }

    await saveRetryQueue(queue);
    console.log(`\n  Backfilled ${added} entries (${queue.length} total in retry queue)`);
    console.log(`  Run: node job-dispatcher.mjs --retry\n`);
    return;
  }

  if (args.includes('--test')) {
    // Generate CV PDF for the active profile before sending test email
    const activeYml = await readFile(resolve(__dirname, 'profiles/active.yml'), 'utf8');
    const testProfileName = activeYml.match(/active:\s*(\w+)/)?.[1] || 'paulina';
    console.log(`\n  [TEST] Ensuring CV PDFs for profile: ${testProfileName}`);

    let cvPdfPath = null;
    let cvDePdfPath = null;
    const isDryRun = args.includes('--dry-run');
    if (!isDryRun) {
      try {
        const pdfs = await ensureProfilePdfs(testProfileName);
        cvPdfPath = pdfs.cvPdfPath;
        cvDePdfPath = pdfs.cvDePdfPath;
      } catch (err) {
        console.error(`  [TEST] PDF generation failed: ${err.message}`);
      }
    }

    // Send a test email to the active profile's candidate (CV only, no cover letter in test mode)
    const result = await dispatch(
      {
        title: 'Test Position — Dispatcher Verification',
        company: 'Career-Ops Test',
        url: 'https://career-ops.test/job/123',
        location: 'Remote',
        salary: '$100K-150K',
        platform: 'Test',
        source: 'BA-API',
        matchReasons: [
          'This is a test notification from Career-Ops job dispatcher',
          'All 3 email modes are operational',
          'Email sent via Lukas.T@withlukas.com',
        ],
      },
      4.2, // Maps to fit 82 → auto-apply mode
      {
        dryRun: isDryRun,
        cvPdfPath,
        cvDePdfPath,
      }
    );
    console.log(`\n  Result: ${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  const jobArg = args.find(a => a.startsWith('--job='));
  const scoreArg = args.find(a => a.startsWith('--score='));
  const dryRun = args.includes('--dry-run');

  if (!jobArg) {
    console.log(`
  Usage:
    node job-dispatcher.mjs --test [--dry-run]
    node job-dispatcher.mjs --job='{"title":"...","company":"..."}' --score=4.2 [--dry-run]
    node job-dispatcher.mjs --retry [--dry-run]          Resend rate-limited emails from queue
    node job-dispatcher.mjs --backfill-retry             Parse apply-log for failed sends → queue

  Modes:
    Fit 80-100 (score 4.0+):  Auto-Apply → confirmation email
    Fit 60-79  (score 3.0-3.9): Manual → email + cover letter PDF
    Fit 40-59  (score 2.0-2.9): Approval → email asking YES/NO
    Fit <40    (score <2.0):    Skip → log only
`);
    return;
  }

  const job = JSON.parse(jobArg.replace('--job=', ''));
  const score = parseFloat(scoreArg?.replace('--score=', '') || '3.0');

  const result = await dispatch(job, score, { dryRun });
  console.log(`\n  Result: ${JSON.stringify(result, null, 2)}\n`);
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
