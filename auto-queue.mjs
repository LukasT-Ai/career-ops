#!/usr/bin/env node

/**
 * auto-queue.mjs — Auto-Queue Greenhouse/Lever Jobs for Apply Engine
 *
 * Reads pipeline.md for unchecked entries with Greenhouse or Lever URLs,
 * adds them to the approval queue so the user can approve → auto-submit.
 *
 * Designed to run after scan-all.mjs in the cron pipeline:
 *   scan-all.mjs → auto-queue.mjs → [user approves] → apply-engine.mjs
 *
 * Only queues jobs from ATS platforms we can auto-apply to:
 *   - Greenhouse (public API, fully automatic)
 *   - Lever (Playwright form-fill, semi-automatic with captcha)
 *
 * Usage:
 *   node auto-queue.mjs                       Queue for all profiles
 *   node auto-queue.mjs --profile=lamin       Single profile
 *   node auto-queue.mjs --dry-run             Preview without writing
 *   node auto-queue.mjs --include-checked     Also queue already-checked items
 */

import { readFile } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { addToQueue, listQueue } from './approval-queue.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ALL_PROFILES = ['paulina', 'lamin'];

// ── Parse pipeline.md entries ───────────────────────────────

function parsePipelineEntry(line) {
  // Format: - [ ] URL | Company | Title — Location
  // or:     - [x] URL | ...
  const checked = line.includes('[x]');
  const content = line.replace(/^-\s*\[[ x]\]\s*/, '').trim();
  const parts = content.split('|').map(s => s.trim());

  if (parts.length < 3) return null;

  const url = parts[0];
  const company = parts[1];
  const rest = parts.slice(2).join('|');

  // Split title from location (separated by " — ")
  const titleLoc = rest.split(' — ');
  const title = titleLoc[0].trim();
  const location = titleLoc.slice(1).join(' — ').trim();

  return { url, company, title, location, checked };
}

function detectATS(url) {
  if (/greenhouse\.io/i.test(url)) return 'greenhouse';
  if (/lever\.co/i.test(url)) return 'lever';
  return null;
}

// ── Find resume for profile ─────────────────────────────────

async function findResumePath(profileName) {
  const { readdir } = await import('fs/promises');
  const outputDir = resolve(__dirname, 'profiles', profileName, 'output');
  try {
    const files = await readdir(outputDir);
    const pdf = files.find(f => f.toLowerCase().includes('cv') && f.endsWith('.pdf'));
    if (pdf) return resolve(outputDir, pdf);
  } catch { /* no output dir */ }
  return null;
}

// ── Process one profile ─────────────────────────────────────

async function queueProfile(profileName, { dryRun = false, includeChecked = false } = {}) {
  const pipePath = resolve(__dirname, 'profiles', profileName, 'data', 'pipeline.md');
  let pipeContent;
  try {
    pipeContent = await readFile(pipePath, 'utf8');
  } catch {
    console.log(`  ${profileName}: No pipeline.md found`);
    return { queued: 0, skipped: 0, dupes: 0 };
  }

  const lines = pipeContent.split('\n').filter(l => l.startsWith('- ['));
  const entries = lines.map(parsePipelineEntry).filter(Boolean);

  // Filter to auto-apply-able ATS only
  const atsEntries = entries.filter(e => {
    if (!includeChecked && e.checked) return false;
    return detectATS(e.url) !== null;
  });

  if (atsEntries.length === 0) {
    console.log(`  ${profileName}: No Greenhouse/Lever jobs in pipeline`);
    return { queued: 0, skipped: 0, dupes: 0 };
  }

  // Get existing queue URLs for fast dedup check
  const existing = await listQueue(profileName);
  const existingUrls = new Set(existing.map(i => i.url));

  const resumePath = await findResumePath(profileName);
  let queued = 0, skipped = 0, dupes = 0;

  for (const entry of atsEntries) {
    // Skip if already in queue
    if (existingUrls.has(entry.url)) {
      dupes++;
      continue;
    }

    if (dryRun) {
      const ats = detectATS(entry.url);
      console.log(`    [DRY] ${ats === 'greenhouse' ? '[GH]' : '[LV]'} ${entry.company} — ${entry.title}`);
      queued++;
      continue;
    }

    const result = await addToQueue(profileName, {
      url: entry.url,
      company: entry.company,
      title: entry.title,
      location: entry.location,
      score: 0, // Not evaluated yet — user reviews in queue
      resumePath,
      coverLetterPath: null,
    });

    if (result.added) {
      queued++;
    } else {
      dupes++;
    }
  }

  skipped = entries.filter(e => !includeChecked && e.checked).length;
  const ats = detectATS;

  console.log(`  ${profileName}: ${queued} queued, ${dupes} already in queue, ${skipped} checked/skipped`);
  return { queued, skipped, dupes };
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const includeChecked = args.includes('--include-checked');
  const profileArg = args.find(a => a.startsWith('--profile='));

  const profiles = profileArg ? [profileArg.split('=')[1]] : ALL_PROFILES;

  console.log(`\n  Auto-Queue — ${dryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log(`  ${'━'.repeat(50)}`);

  let totalQueued = 0;

  for (const profile of profiles) {
    const result = await queueProfile(profile, { dryRun, includeChecked });
    totalQueued += result.queued;
  }

  console.log(`\n  Total: ${totalQueued} jobs queued for approval`);
  if (totalQueued > 0 && !dryRun) {
    console.log('  Next: node approval-queue.mjs list');
    console.log('        node approval-queue.mjs approve-all --profile=<name>');
    console.log('        node apply-engine.mjs --profile=<name>');
  }
  console.log('');
}

main().catch(err => { console.error(`Fatal: ${err.message}`); process.exit(1); });
