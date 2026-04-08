#!/usr/bin/env node

/**
 * remoteok-api.mjs — RemoteOK Remote Job Scanner
 *
 * Free API, no auth required. Returns all recent remote jobs; filtered client-side.
 * Lamin-only scanner (private-sector remote US sales/telecom roles).
 *
 * Usage:
 *   node remoteok-api.mjs [--dry-run]
 *
 * API: https://remoteok.com/api (JSON array, first element is metadata)
 */

import { readFile, writeFile, appendFile } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================
// Paths — Lamin profile only
// ============================================================

const PIPELINE_PATH = resolve(__dirname, 'profiles/lamin/data/pipeline.md');
const HISTORY_PATH = resolve(__dirname, 'profiles/lamin/data/scan-history.tsv');
const APPLICATIONS_PATH = resolve(__dirname, 'profiles/lamin/data/applications.md');

// ============================================================
// API Configuration
// ============================================================

const API_URL = 'https://remoteok.com/api';

// RemoteOK requires a User-Agent or returns 403
const HEADERS = {
  'User-Agent': 'career-ops/1.0 (job-search-pipeline)',
  'Accept': 'application/json',
};

// ============================================================
// Filter Configuration — Lamin (sales/telecom/biz dev)
// ============================================================

const POSITIVE_KEYWORDS = [
  'sales', 'account manager', 'telecom', 'business development', 'b2b',
  'enterprise sales', 'channel', 'partner manager', 'customer success',
];

const NEGATIVE_KEYWORDS = [
  'nurse', 'physician', 'medical', 'intern', 'student',
  'design', 'frontend', 'backend',
];

const LOCATION_ACCEPT = [
  'usa', 'us', 'worldwide', 'anywhere', 'atlanta', 'georgia',
];

// ============================================================
// Keyword Matching
// ============================================================

function matchesKeywords(text) {
  const lower = (text || '').toLowerCase();
  const hasPositive = POSITIVE_KEYWORDS.some(kw => lower.includes(kw));
  if (!hasPositive) return false;
  const hasNegative = NEGATIVE_KEYWORDS.some(kw => lower.includes(kw));
  if (hasNegative) return false;
  return true;
}

function matchesLocation(location) {
  // Empty/null location = remote anywhere = accepted
  if (!location || location.trim() === '') return true;
  const lower = location.toLowerCase();
  return LOCATION_ACCEPT.some(loc => lower.includes(loc));
}

// ============================================================
// Salary Parsing
// ============================================================

function formatSalary(job) {
  const min = job.salary_min;
  const max = job.salary_max;
  if (min && max) {
    return `$${Number(min).toLocaleString()}-$${Number(max).toLocaleString()}`;
  }
  if (min) return `$${Number(min).toLocaleString()}+`;
  if (max) return `Up to $${Number(max).toLocaleString()}`;
  return 'Not disclosed';
}

// ============================================================
// Dedup — load existing URLs + company+title combos
// ============================================================

async function loadExistingEntries() {
  const urls = new Set();
  const companyTitles = new Set();

  for (const filePath of [PIPELINE_PATH, APPLICATIONS_PATH, HISTORY_PATH]) {
    try {
      const content = await readFile(filePath, 'utf8');
      for (const match of content.matchAll(/https?:\/\/[^\s|)\t]+/g)) {
        urls.add(match[0]);
      }
    } catch { /* file may not exist yet */ }
  }

  // Extract company+title combos from pipeline for secondary dedup
  try {
    const pipeline = await readFile(PIPELINE_PATH, 'utf8');
    for (const line of pipeline.split('\n')) {
      // Format: - [ ] URL | Company | Title ...
      const parts = line.split('|').map(p => p.trim());
      if (parts.length >= 3) {
        const company = parts[1]?.toLowerCase();
        const title = parts[2]?.replace(/\s*—.*$/, '').toLowerCase();
        if (company && title) {
          companyTitles.add(`${company}:::${title}`);
        }
      }
    }
  } catch { /* no pipeline yet */ }

  return { urls, companyTitles };
}

// ============================================================
// Pipeline + History Writers
// ============================================================

async function appendToPipeline(jobs) {
  if (jobs.length === 0) return;

  const lines = jobs.map(j =>
    `- [ ] ${j.url} | ${j.company} | ${j.title} — ${j.location || 'Remote'} | ${j.salary}`
  ).join('\n');

  try {
    const existing = await readFile(PIPELINE_PATH, 'utf8');
    if (existing.includes('## Pendientes')) {
      const updated = existing.replace(
        '## Pendientes\n',
        `## Pendientes\n\n${lines}\n`
      );
      await writeFile(PIPELINE_PATH, updated, 'utf8');
    } else {
      await appendFile(PIPELINE_PATH, `\n${lines}\n`, 'utf8');
    }
  } catch {
    await writeFile(PIPELINE_PATH, `# Pipeline — Pending URLs\n\n## Pendientes\n\n${lines}\n`, 'utf8');
  }
}

async function appendToScanHistory(jobs, skipped) {
  const date = new Date().toISOString().split('T')[0];

  const lines = [
    ...jobs.map(j => `${j.url}\t${date}\tRemoteOK\t${j.title}\t${j.company}\tadded`),
    ...skipped.map(s => `${s.url}\t${date}\tRemoteOK\t${s.title}\t${s.company}\t${s.reason}`),
  ].join('\n');

  if (!lines) return;

  try {
    await appendFile(HISTORY_PATH, `\n${lines}`, 'utf8');
  } catch {
    const header = 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus';
    await writeFile(HISTORY_PATH, `${header}\n${lines}\n`, 'utf8');
  }
}

// ============================================================
// Main Scanner
// ============================================================

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  console.log(`\n  RemoteOK API Scanner — Profile: lamin`);
  console.log(`  ${'━'.repeat(50)}`);
  console.log(`  Dry run: ${dryRun}\n`);

  // Fetch all jobs
  console.log('  Fetching RemoteOK API...');
  const res = await fetch(API_URL, { headers: HEADERS });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`RemoteOK API ${res.status}: ${text.slice(0, 200)}`);
  }

  const raw = await res.json();

  // First element is metadata/legal notice — skip it
  const jobs = Array.isArray(raw) ? raw.slice(1) : [];
  console.log(`  Total jobs returned: ${jobs.length}`);

  // Load dedup
  const { urls: existingUrls, companyTitles: existingCombos } = await loadExistingEntries();
  console.log(`  Existing URLs loaded: ${existingUrls.size}`);
  console.log(`  Existing company+title combos: ${existingCombos.size}`);

  const allJobs = [];
  const allSkipped = [];
  let totalFiltered = 0;
  let totalDuped = 0;
  let totalLocation = 0;

  for (const job of jobs) {
    const id = job.id;
    const position = job.position || '';
    const company = job.company || 'Unknown';
    const location = job.location || '';
    const url = job.url || `https://remoteok.com/remote-jobs/${id}`;
    const tags = (job.tags || []).join(' ');

    // Combine position + tags for keyword matching
    const searchText = `${position} ${tags}`;

    // URL dedup
    if (existingUrls.has(url)) {
      totalDuped++;
      allSkipped.push({ url, title: position, company, reason: 'skipped_dup_url' });
      continue;
    }

    // Company+title dedup
    const combo = `${company.toLowerCase()}:::${position.toLowerCase()}`;
    if (existingCombos.has(combo)) {
      totalDuped++;
      allSkipped.push({ url, title: position, company, reason: 'skipped_dup_combo' });
      continue;
    }

    // Keyword filter (position + tags)
    if (!matchesKeywords(searchText)) {
      totalFiltered++;
      allSkipped.push({ url, title: position, company, reason: 'skipped_keywords' });
      continue;
    }

    // Negative keyword check on position alone
    const posLower = position.toLowerCase();
    if (NEGATIVE_KEYWORDS.some(kw => posLower.includes(kw))) {
      totalFiltered++;
      allSkipped.push({ url, title: position, company, reason: 'skipped_negative' });
      continue;
    }

    // Location filter
    if (!matchesLocation(location)) {
      totalLocation++;
      allSkipped.push({ url, title: position, company, reason: 'skipped_location' });
      continue;
    }

    const salary = formatSalary(job);

    allJobs.push({ url, title: position, company, location, salary });
    existingUrls.add(url);
    existingCombos.add(combo);
  }

  // Summary
  console.log(`\n  ${'━'.repeat(50)}`);
  console.log(`  RemoteOK Scan Complete — ${new Date().toISOString().split('T')[0]}`);
  console.log(`  ${'━'.repeat(50)}`);
  console.log(`  Total results:       ${jobs.length}`);
  console.log(`  Filtered (keywords): ${totalFiltered}`);
  console.log(`  Filtered (location): ${totalLocation}`);
  console.log(`  Duplicates:          ${totalDuped}`);
  console.log(`  NEW to pipeline:     ${allJobs.length}`);

  if (allJobs.length > 0) {
    console.log(`\n  New jobs:`);
    for (const job of allJobs) {
      console.log(`    + ${job.company} | ${job.title} — ${job.location || 'Remote'} | ${job.salary}`);
    }
  }

  // Write results
  if (!dryRun && allJobs.length > 0) {
    await appendToPipeline(allJobs);
    console.log(`\n  Written to profiles/lamin/data/pipeline.md`);
  }

  if (!dryRun) {
    await appendToScanHistory(allJobs, allSkipped);
    console.log(`  Written to profiles/lamin/data/scan-history.tsv`);
  }

  if (dryRun) {
    console.log(`\n  (Dry run — no files written)`);
  }

  console.log('');
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
