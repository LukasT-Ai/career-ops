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

import { readFile, writeFile, appendFile } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

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
  AUTO_APPLY:  { min: 80, max: 100, label: 'Auto-Apply',  status: 'APPLIED',              template: 'email-auto-applied.html' },
  MANUAL:      { min: 60, max: 79,  label: 'Manual Review', status: 'PENDING_MANUAL',       template: 'email-manual-review.html' },
  APPROVAL:    { min: 40, max: 59,  label: 'Approval',     status: 'PENDING_APPROVAL',      template: 'email-approval-request.html' },
  SKIP:        { min: 0,  max: 39,  label: 'Skip',         status: 'SKIPPED_LOW_FIT',       template: null },
};

function determineMode(fitScore) {
  if (fitScore >= 80) return MODES.AUTO_APPLY;
  if (fitScore >= 60) return MODES.MANUAL;
  if (fitScore >= 40) return MODES.APPROVAL;
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
    result = result.replaceAll(`{{${key}}}`, value || 'N/A');
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
    case MODES.AUTO_APPLY:
      return `Application Submitted: ${job.title} at ${job.company}`;
    case MODES.MANUAL:
      return `Action Needed: ${job.title} at ${job.company}`;
    case MODES.APPROVAL:
      return `Should I Apply? ${job.title} at ${job.company}`;
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
    return { sent: false, reason: err.message, mode: mode.label, fitScore };
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

  return { name, profile };
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
  const fitScore = job.fitScore || mapScoreToFit(careerOpsScore);

  // Determine mode
  let mode = determineMode(fitScore);

  // CONSENT GATE: Downgrade auto-apply to manual if consent not given
  if (mode === MODES.AUTO_APPLY && !approvalConfig.autoApplyConsent) {
    mode = MODES.MANUAL;
    console.log(`  [CONSENT] Auto-apply not enabled for ${profileName} — downgraded to Manual Review`);
    console.log(`           To enable: create profiles/${profileName}/approval-config.yml with auto_apply_consent: true`);
    console.log(`           Or run: node job-dispatcher.mjs --enable-auto-apply --profile=${profileName}`);
  }

  // Merge paths into job
  job.coverLetterPath = options.coverLetterPath || job.coverLetterPath;
  job.cvPdfPath = options.cvPdfPath || job.cvPdfPath;
  job.matchReasons = options.matchReasons || job.matchReasons;
  job.draftCoverLetter = options.draftCoverLetter || job.draftCoverLetter;

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

  if (args.includes('--test')) {
    // Send a test email to the active profile's candidate
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
      { dryRun: args.includes('--dry-run') }
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
