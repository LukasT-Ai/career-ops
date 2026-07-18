#!/usr/bin/env node

/**
 * apply-engine.mjs — Auto-Apply Orchestrator
 *
 * Reads approved items from the approval queue and submits them
 * via the appropriate ATS adapter (Greenhouse API or Lever Playwright).
 *
 * Flow:
 *   1. Scan evaluates jobs → score ≥ 4.0 → added to approval queue
 *   2. User reviews pending items (dashboard/email/CLI)
 *   3. User approves → this engine submits
 *
 * Usage:
 *   node apply-engine.mjs [--profile=name] [--dry-run]
 *   node apply-engine.mjs --process-all [--profile=name] [--dry-run]
 *
 * Supported ATS:
 *   - Greenhouse: Full auto-submit via public API (no captcha)
 *   - Lever: Form-fill via Playwright, pauses for captcha
 */

import { readFile, writeFile } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { listQueue, markSubmitted } from './approval-queue.mjs';
import { applyGreenhouse } from './greenhouse-apply.mjs';
import { applyLever } from './lever-apply.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Load candidate ───────────────────────────────────────────

async function loadCandidate(profileName) {
  const ymlPath = resolve(__dirname, 'profiles', profileName, 'profile.yml');
  const yml = await readFile(ymlPath, 'utf8');

  const get = (key) => {
    const m = yml.match(new RegExp(`${key}:\\s*"?([^"\\n]+)"?`));
    return m ? m[1].trim() : '';
  };

  const fullName = get('full_name').replace(/,?\s*(MD|PhD|DO|MBA|JD)$/i, '').trim();
  const nameParts = fullName.split(/\s+/);

  return {
    fullName,
    firstName: nameParts[0] || '',
    lastName: nameParts.slice(1).join(' ') || '',
    email: get('email'),
    phone: get('phone'),
    linkedin: get('linkedin'),
    location: get('location'),
  };
}

// ── Parse ATS URLs ───────────────────────────────────────────

function parseGreenhouseUrl(url) {
  const m = url.match(/greenhouse\.io\/([^/]+)\/jobs\/(\d+)/);
  if (m) return { boardSlug: m[1], jobId: m[2] };
  return null;
}

// ── Update tracker ───────────────────────────────────────────

async function updateApplicationStatus(profileName, company, title, status) {
  const appsPath = resolve(__dirname, 'profiles', profileName, 'data', 'applications.md');
  try {
    let content = await readFile(appsPath, 'utf8');
    const companyLower = company.toLowerCase();
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(companyLower) && lines[i].includes(title.slice(0, 30))) {
        // Update status column
        lines[i] = lines[i].replace(/Evaluated/i, status);
        break;
      }
    }
    await writeFile(appsPath, lines.join('\n'), 'utf8');
  } catch { /* no applications file */ }
}

// ── Process queue ────────────────────────────────────────────

async function processQueue(profileName, dryRun = false) {
  const items = await listQueue(profileName, 'approved');

  if (items.length === 0) {
    console.log('  No approved applications to submit.');
    return { submitted: 0, failed: 0, skipped: 0 };
  }

  console.log(`  Processing ${items.length} approved application(s)...\n`);

  const candidate = await loadCandidate(profileName);
  let submitted = 0;
  let failed = 0;
  let skippedCount = 0;

  // Resolve resume — prefer English CV, fall back to what's in queue item
  const resolveResume = async (item) => {
    if (item.resumePath) {
      try { await readFile(item.resumePath); return item.resumePath; } catch {}
    }
    // Try English CV first, then German, then any PDF with "cv" in name
    const outputDir = resolve(__dirname, 'profiles', profileName, 'output');
    const candidates = [
      resolve(outputDir, `cv-${profileName}.pdf`),
      resolve(outputDir, `CV-${candidate.firstName}-${candidate.lastName.replace(/\s/g, '-')}.pdf`),
      resolve(outputDir, `cv-de-${profileName}.pdf`),
    ];
    for (const p of candidates) {
      try { await readFile(p); return p; } catch {}
    }
    // Last resort: any cv*.pdf in output
    try {
      const { readdir } = await import('fs/promises');
      const files = await readdir(outputDir);
      const pdf = files.find(f => f.toLowerCase().includes('cv') && f.endsWith('.pdf'));
      if (pdf) return resolve(outputDir, pdf);
    } catch {}
    return null;
  };

  for (const item of items) {
    console.log(`  [${item.id}] ${item.company} — ${item.title}`);
    console.log(`    ATS: ${item.ats} | Score: ${item.score}/5`);

    try {
      const resumePath = await resolveResume(item);
      if (!resumePath) {
        console.log('    No resume PDF found — skipping');
        if (!dryRun) await markSubmitted(profileName, item.id, false, 'no_resume');
        failed++;
        continue;
      }

      if (item.ats === 'greenhouse') {
        const parsed = parseGreenhouseUrl(item.url);
        if (!parsed) {
          console.log('    Cannot parse Greenhouse URL — skipping');
          if (!dryRun) await markSubmitted(profileName, item.id, false, 'invalid_url');
          failed++;
          continue;
        }

        // Verify job is still active before submitting
        try {
          const checkRes = await fetch(`https://boards-api.greenhouse.io/v1/boards/${parsed.boardSlug}/jobs/${parsed.jobId}`);
          if (!checkRes.ok) {
            console.log(`    Job no longer active (HTTP ${checkRes.status}) — skipping`);
            if (!dryRun) await markSubmitted(profileName, item.id, false, `job_closed_${checkRes.status}`);
            failed++;
            continue;
          }
        } catch (err) {
          console.log(`    Cannot reach Greenhouse API: ${err.message} — skipping`);
          if (!dryRun) await markSubmitted(profileName, item.id, false, 'api_unreachable');
          failed++;
          continue;
        }

        const result = await applyGreenhouse({
          boardSlug: parsed.boardSlug,
          jobId: parsed.jobId,
          candidate,
          resumePath,
          coverLetterPath: item.coverLetterPath,
          dryRun,
        });

        if (result.success) {
          if (!dryRun) {
            await markSubmitted(profileName, item.id, true);
            await updateApplicationStatus(profileName, item.company, item.title, 'Applied');
          }
          submitted++;
        } else if (result.reason === 'unanswerable_required_questions') {
          console.log('    Moved to manual — has custom required questions');
          if (!dryRun) await markSubmitted(profileName, item.id, false, 'needs_manual: ' + result.questions.join(', '));
          skippedCount++;
        } else {
          if (!dryRun) await markSubmitted(profileName, item.id, false, result.error || result.reason);
          failed++;
        }

      } else if (item.ats === 'lever') {
        // Verify Lever posting is still active
        const parsed = item.url.match(/lever\.co\/([^/]+)\/([a-f0-9-]+)/);
        if (parsed) {
          try {
            const checkRes = await fetch(`https://api.lever.co/v0/postings/${parsed[1]}/${parsed[2]}`);
            if (!checkRes.ok) {
              console.log(`    Lever posting no longer active (HTTP ${checkRes.status}) — skipping`);
              if (!dryRun) await markSubmitted(profileName, item.id, false, `job_closed_${checkRes.status}`);
              failed++;
              continue;
            }
          } catch (err) {
            console.log(`    Cannot reach Lever API: ${err.message} — continuing anyway`);
          }
        }

        const result = await applyLever({
          postingUrl: item.url,
          candidate,
          resumePath,
          coverLetterPath: item.coverLetterPath,
          dryRun,
          headless: false, // Need visible browser for captcha
        });

        if (result.success) {
          if (!dryRun) {
            await markSubmitted(profileName, item.id, true);
            await updateApplicationStatus(profileName, item.company, item.title, 'Applied');
          }
          submitted++;
        } else {
          if (!dryRun) await markSubmitted(profileName, item.id, false, result.reason);
          failed++;
        }

      } else {
        console.log(`    Unknown ATS "${item.ats}" — skipping (manual apply needed)`);
        skippedCount++;
      }
    } catch (err) {
      console.error(`    UNEXPECTED ERROR: ${err.message}`);
      if (!dryRun) await markSubmitted(profileName, item.id, false, `crash: ${err.message.slice(0, 100)}`);
      failed++;
    }

    console.log('');
  }

  return { submitted, failed, skipped: skippedCount };
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const profileArg = args.find(a => a.startsWith('--profile='));

  let profileName;
  if (profileArg) {
    profileName = profileArg.split('=')[1];
  } else {
    const activeYml = await readFile(resolve(__dirname, 'profiles/active.yml'), 'utf8');
    profileName = activeYml.match(/active:\s*(\w+)/)?.[1] || 'paulina';
  }

  console.log(`\n  Apply Engine — Profile: ${profileName}`);
  console.log(`  ${'━'.repeat(50)}`);
  console.log(`  Dry run: ${dryRun}\n`);

  // Show queue status
  const allItems = await listQueue(profileName);
  const pending = allItems.filter(i => i.status === 'pending').length;
  const approved = allItems.filter(i => i.status === 'approved').length;
  const submittedTotal = allItems.filter(i => i.status === 'submitted').length;

  console.log(`  Queue: ${pending} pending | ${approved} approved | ${submittedTotal} submitted\n`);

  if (approved === 0) {
    console.log('  No approved applications. Approve items first:');
    console.log('    node approval-queue.mjs list --profile=' + profileName);
    console.log('    node approval-queue.mjs approve <id> --profile=' + profileName);
    console.log('    node approval-queue.mjs approve-all --profile=' + profileName);
    console.log('');
    return;
  }

  const results = await processQueue(profileName, dryRun);

  console.log(`  ${'━'.repeat(50)}`);
  console.log(`  Results: ${results.submitted} submitted | ${results.failed} failed | ${results.skipped} need manual`);
  if (dryRun) console.log('  (Dry run — nothing actually submitted)');
  console.log('');
}

main().catch(err => { console.error(`Fatal: ${err.message}`); process.exit(1); });
