#!/usr/bin/env node

/**
 * greenhouse-apply.mjs — Submit applications via Greenhouse public API
 *
 * Greenhouse boards accept applications via POST multipart/form-data.
 * No auth needed — the same endpoint the browser uses.
 *
 * Endpoint: POST https://boards-api.greenhouse.io/v1/boards/{board}/jobs/{job_id}
 *
 * Usage:
 *   import { applyGreenhouse } from './greenhouse-apply.mjs';
 *   const result = await applyGreenhouse({ boardSlug, jobId, candidate, resumePath, coverLetterPath });
 *
 * Or standalone:
 *   node greenhouse-apply.mjs --job-url=https://boards.greenhouse.io/twilio/jobs/12345 --profile=lamin --dry-run
 */

import { readFile } from 'fs/promises';
import { resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Parse candidate from profile.yml ─────────────────────────

async function loadCandidate(profileName) {
  const ymlPath = resolve(__dirname, 'profiles', profileName, 'profile.yml');
  const yml = await readFile(ymlPath, 'utf8');

  const get = (key) => {
    const m = yml.match(new RegExp(`${key}:\\s*"?([^"\\n]+)"?`));
    return m ? m[1].trim() : '';
  };

  const fullName = get('full_name');
  const nameParts = fullName.replace(/,?\s*(MD|PhD|DO|MBA|JD)$/i, '').trim().split(/\s+/);

  return {
    firstName: nameParts[0] || '',
    lastName: nameParts.slice(1).join(' ') || '',
    email: get('email'),
    phone: get('phone'),
    linkedin: get('linkedin'),
    location: get('location'),
  };
}

// ── Parse Greenhouse URL ─────────────────────────────────────

function parseGreenhouseUrl(url) {
  // https://boards.greenhouse.io/twilio/jobs/12345
  // https://job-boards.greenhouse.io/twilio/jobs/12345
  const m = url.match(/greenhouse\.io\/([^/]+)\/jobs\/(\d+)/);
  if (m) return { boardSlug: m[1], jobId: m[2] };
  return null;
}

// ── Fetch job questions ──────────────────────────────────────

async function fetchJobQuestions(boardSlug, jobId) {
  const url = `https://boards-api.greenhouse.io/v1/boards/${boardSlug}/jobs/${jobId}?questions=true`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { error: true, status: res.status, message: `Greenhouse API ${res.status}: ${text.slice(0, 200)}` };
  }
  const data = await res.json();
  return {
    title: data.title,
    location: data.location?.name || '',
    questions: data.questions || [],
    compliance: data.data_compliance || [],
  };
}

// ── Build multipart form data ────────────────────────────────

async function buildFormData(candidate, resumePath, coverLetterPath, questions) {
  const form = new FormData();

  // Standard fields
  form.append('first_name', candidate.firstName);
  form.append('last_name', candidate.lastName);
  form.append('email', candidate.email);
  form.append('phone', candidate.phone);

  // Resume (required)
  if (resumePath) {
    const resumeBuffer = await readFile(resumePath);
    const resumeBlob = new Blob([resumeBuffer], { type: 'application/pdf' });
    form.append('resume', resumeBlob, basename(resumePath));
  }

  // Cover letter (optional)
  if (coverLetterPath) {
    try {
      const clBuffer = await readFile(coverLetterPath);
      const clBlob = new Blob([clBuffer], { type: 'application/pdf' });
      form.append('cover_letter', clBlob, basename(coverLetterPath));
    } catch { /* no cover letter — that's OK */ }
  }

  // Auto-answer known custom question types
  for (const q of questions) {
    for (const field of q.fields || []) {
      const label = (q.label || '').toLowerCase();
      const name = field.name;

      // LinkedIn
      if (label.includes('linkedin') && field.type === 'input_text' && candidate.linkedin) {
        form.append(name, candidate.linkedin.startsWith('http') ? candidate.linkedin : `https://${candidate.linkedin}`);
        continue;
      }

      // Location / current location
      if ((label.includes('location') || label.includes('where')) && field.type === 'input_text' && candidate.location) {
        form.append(name, candidate.location);
        continue;
      }

      // Work authorization (US citizens)
      if (label.includes('authorized') || label.includes('authorization') || label.includes('legally')) {
        if (field.type === 'multi_value_single_select' || field.type === 'input_text') {
          const yesOption = (field.values || []).find(v =>
            v.label?.toLowerCase().includes('yes') || v.value?.toString() === '1'
          );
          if (yesOption) form.append(name, yesOption.value ?? yesOption.label);
          else form.append(name, 'Yes');
        }
        continue;
      }

      // Sponsorship (not needed — dual citizens)
      if (label.includes('sponsor') || label.includes('visa')) {
        if (field.type === 'multi_value_single_select' || field.type === 'input_text') {
          const noOption = (field.values || []).find(v =>
            v.label?.toLowerCase().includes('no') || v.label?.toLowerCase().includes('do not')
          );
          if (noOption) form.append(name, noOption.value ?? noOption.label);
          else form.append(name, 'No');
        }
        continue;
      }

      // How did you hear? → Job board / Online search
      if (label.includes('hear about') || label.includes('how did you') || label.includes('source')) {
        if (field.type === 'multi_value_single_select') {
          const option = (field.values || []).find(v =>
            /job board|online|search|website|other/i.test(v.label || '')
          );
          if (option) form.append(name, option.value ?? option.label);
        } else if (field.type === 'input_text') {
          form.append(name, 'Job board');
        }
        continue;
      }

      // Sanctions / country restriction acknowledgments
      if (label.includes('citizen') && (label.includes('cuba') || label.includes('iran') || label.includes('sanctions'))) {
        if (field.type === 'multi_value_single_select') {
          const noOption = (field.values || []).find(v => /no|none|not/i.test(v.label || ''));
          if (noOption) form.append(name, noOption.value ?? noOption.label);
        } else {
          form.append(name, 'No');
        }
        continue;
      }

      // Privacy policy / acknowledgment checkboxes
      if (label.includes('acknowledge') || label.includes('privacy') || label.includes('confirm') ||
          label.includes('i agree') || label.includes('consent') || label.includes('policy')) {
        if (field.type === 'multi_value_single_select') {
          const yesOption = (field.values || []).find(v => /yes|acknowledge|agree|confirm|i have/i.test(v.label || ''));
          if (yesOption) { form.append(name, yesOption.value ?? yesOption.label); continue; }
        }
        // Checkbox-style: just set to true/1
        form.append(name, '1');
        continue;
      }

      // Preferred name
      if (label.includes('preferred') && label.includes('name')) {
        form.append(name, candidate.firstName);
        continue;
      }

      // Salary expectations
      if (label.includes('salary') || label.includes('compensation') || label.includes('pay')) {
        if (field.type === 'input_text') {
          form.append(name, 'Open to discussion');
        }
        continue;
      }

      // Start date
      if (label.includes('start date') || label.includes('available') || label.includes('earliest')) {
        if (field.type === 'input_text') {
          form.append(name, 'Flexible / 2 weeks notice');
        }
        continue;
      }

      // Skip non-required fields we can't answer
      // Required unknown fields will be flagged
    }
  }

  return form;
}

// ── Submit application ───────────────────────────────────────

export async function applyGreenhouse({ boardSlug, jobId, candidate, resumePath, coverLetterPath, dryRun = false }) {
  const jobData = await fetchJobQuestions(boardSlug, jobId);

  if (jobData.error) {
    console.log(`    ${jobData.message}`);
    return { success: false, reason: `api_error_${jobData.status}`, error: jobData.message };
  }

  console.log(`    Job: ${jobData.title} — ${jobData.location}`);
  console.log(`    Questions: ${jobData.questions.length}`);

  // Check for required questions we can't auto-answer
  const unanswerable = [];
  const answerable = ['first name', 'last name', 'email', 'phone', 'resume', 'cover letter',
    'linkedin', 'location', 'authorized', 'authorization', 'sponsor', 'visa',
    'hear about', 'how did you', 'source', 'where', 'legally', 'preferred',
    'acknowledge', 'privacy', 'confirm', 'agree', 'consent', 'policy',
    'citizen', 'salary', 'compensation', 'pay', 'start date', 'available', 'earliest'];

  for (const q of jobData.questions) {
    if (!q.required) continue;
    const label = (q.label || '').toLowerCase();
    if (!answerable.some(a => label.includes(a))) {
      unanswerable.push(q.label);
    }
  }

  if (unanswerable.length > 0) {
    console.log(`    WARNING: ${unanswerable.length} required question(s) we can't auto-answer:`);
    for (const u of unanswerable) console.log(`      - ${u}`);
    return { success: false, reason: 'unanswerable_required_questions', questions: unanswerable, jobData };
  }

  const form = await buildFormData(candidate, resumePath, coverLetterPath, jobData.questions);

  if (dryRun) {
    console.log('    [DRY RUN] Would submit application to:');
    console.log(`    POST https://boards-api.greenhouse.io/v1/boards/${boardSlug}/jobs/${jobId}`);
    console.log(`    Candidate: ${candidate.firstName} ${candidate.lastName} <${candidate.email}>`);
    console.log(`    Resume: ${resumePath ? basename(resumePath) : 'NONE'}`);
    console.log(`    Cover Letter: ${coverLetterPath ? basename(coverLetterPath) : 'NONE'}`);
    return { success: true, dryRun: true, jobData };
  }

  const url = `https://boards-api.greenhouse.io/v1/boards/${boardSlug}/jobs/${jobId}`;
  const res = await fetch(url, { method: 'POST', body: form });

  if (res.ok) {
    console.log('    Application submitted successfully!');
    return { success: true, status: res.status, jobData };
  }

  const errorText = await res.text();
  console.error(`    Submission failed: HTTP ${res.status} — ${errorText.slice(0, 200)}`);
  return { success: false, status: res.status, error: errorText, jobData };
}

// ── CLI ──────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const jobUrlArg = args.find(a => a.startsWith('--job-url='));
  const profileArg = args.find(a => a.startsWith('--profile='));

  if (!jobUrlArg) {
    console.log('Usage: node greenhouse-apply.mjs --job-url=<greenhouse-url> --profile=<name> [--dry-run]');
    process.exit(1);
  }

  const jobUrl = jobUrlArg.split('=').slice(1).join('=');
  const parsed = parseGreenhouseUrl(jobUrl);
  if (!parsed) {
    console.error(`Cannot parse Greenhouse URL: ${jobUrl}`);
    process.exit(1);
  }

  let profileName;
  if (profileArg) {
    profileName = profileArg.split('=')[1];
  } else {
    const activeYml = await readFile(resolve(__dirname, 'profiles/active.yml'), 'utf8');
    profileName = activeYml.match(/active:\s*(\w+)/)?.[1] || 'paulina';
  }

  console.log(`\n  Greenhouse Apply — Profile: ${profileName}`);
  console.log(`  ${'━'.repeat(50)}`);
  console.log(`  Board: ${parsed.boardSlug} | Job: ${parsed.jobId}`);

  const candidate = await loadCandidate(profileName);

  // Find resume PDF
  const resumePath = resolve(__dirname, 'profiles', profileName, 'output',
    `CV-${candidate.firstName}-${candidate.lastName.replace(/\s/g, '-')}.pdf`);
  let actualResumePath = resumePath;
  try { await readFile(resumePath); } catch {
    // Try alternate names
    const { readdir } = await import('fs/promises');
    const outputDir = resolve(__dirname, 'profiles', profileName, 'output');
    try {
      const files = await readdir(outputDir);
      const pdf = files.find(f => f.toLowerCase().includes('cv') && f.endsWith('.pdf'));
      if (pdf) actualResumePath = resolve(outputDir, pdf);
      else { console.error('  No CV PDF found'); process.exit(1); }
    } catch { console.error('  No output directory'); process.exit(1); }
  }

  // Find cover letter (optional)
  let coverLetterPath = null;
  try {
    const { readdir } = await import('fs/promises');
    const clDir = resolve(__dirname, 'profiles', profileName, 'cover-letters');
    const files = await readdir(clDir);
    // Match cover letter for this company
    const cl = files.find(f => f.toLowerCase().includes(parsed.boardSlug) && f.endsWith('.pdf'));
    if (cl) coverLetterPath = resolve(clDir, cl);
  } catch { /* no cover letters dir */ }

  const result = await applyGreenhouse({
    boardSlug: parsed.boardSlug,
    jobId: parsed.jobId,
    candidate,
    resumePath: actualResumePath,
    coverLetterPath,
    dryRun,
  });

  console.log(`\n  Result: ${result.success ? 'SUCCESS' : 'FAILED'}`);
  if (result.reason) console.log(`  Reason: ${result.reason}`);
  console.log('');
}

if (process.argv[1] && process.argv[1].includes('greenhouse-apply')) {
  main().catch(err => { console.error(`Fatal: ${err.message}`); process.exit(1); });
}
