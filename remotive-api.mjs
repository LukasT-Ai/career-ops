#!/usr/bin/env node

/**
 * remotive-api.mjs — Remotive Remote Job Scanner
 *
 * Free API, no auth required. Supports category and search params.
 * Multi-profile scanner (sales/telecom for Lamin, psychiatry/telehealth for Paulina).
 *
 * Usage:
 *   node remotive-api.mjs [--profile=paulina|lamin] [--dry-run]
 *
 * Without --profile, reads profiles/active.yml to determine which profile to scan.
 *
 * API: https://remotive.com/api/remote-jobs
 * Params: category, search, limit
 */

import { readFile, writeFile, appendFile } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================
// API Configuration
// ============================================================

const API_BASE = 'https://remotive.com/api/remote-jobs';

const RESULTS_PER_QUERY = 50;

// Rate limiting: be polite, 1 req/sec
const RATE_LIMIT_MS = 1000;

// ============================================================
// Profile Configurations
// ============================================================

const PROFILE_CONFIGS = {
  lamin: {
    searchQueries: [
      { category: 'sales', search: '', label: 'Sales (all)' },
      { category: 'customer-support', search: '', label: 'Customer Support (all)' },
      { category: 'sales', search: 'account manager', label: 'Sales: Account Manager' },
      { category: 'sales', search: 'business development', label: 'Sales: BizDev' },
      { category: 'sales', search: 'enterprise', label: 'Sales: Enterprise' },
      { category: 'sales', search: 'telecom', label: 'Sales: Telecom' },
      { category: 'sales', search: 'channel partner', label: 'Sales: Channel/Partner' },
      { category: 'customer-support', search: 'customer success', label: 'Customer Success' },
      { category: 'marketing', search: 'B2B', label: 'Marketing: B2B' },
      // Broad keyword searches without category restriction
      { category: '', search: 'account manager', label: 'All: Account Manager' },
      { category: '', search: 'business development', label: 'All: BizDev' },
      { category: '', search: 'partner manager', label: 'All: Partner Manager' },
    ],
    positiveKeywords: [
      'sales', 'account manager', 'telecom', 'business development', 'b2b',
      'enterprise sales', 'channel', 'partner manager', 'customer success',
    ],
    negativeKeywords: [
      'nurse', 'physician', 'medical', 'intern', 'student',
      'design', 'frontend', 'backend',
    ],
    locationAccept: [
      'usa', 'us', 'worldwide', 'anywhere', 'atlanta', 'georgia',
    ],
  },
  paulina: {
    searchQueries: [
      // Remotive's categories are tech-focused; use broad search for medical roles
      { category: '', search: 'psychiatrist', label: 'All: Psychiatrist' },
      { category: '', search: 'behavioral health', label: 'All: Behavioral Health' },
      { category: '', search: 'mental health', label: 'All: Mental Health' },
      { category: '', search: 'physician', label: 'All: Physician' },
      { category: '', search: 'medical director', label: 'All: Medical Director' },
      { category: '', search: 'telepsychiatry', label: 'All: Telepsychiatry' },
      { category: '', search: 'telehealth', label: 'All: Telehealth' },
    ],
    positiveKeywords: [
      'psychiatrist', 'behavioral health', 'mental health', 'physician',
      'medical director', 'telepsychiatry', 'telehealth', 'psychiatric',
      'attending physician', 'clinical director',
    ],
    negativeKeywords: [
      'nurse', 'nursing', 'social worker', 'psycholog', 'counselor',
      'technician', 'aide', 'clerk', 'receptionist', 'billing',
      'cna', 'lpn', 'rn', 'intern', 'student',
    ],
    locationAccept: [
      'usa', 'us', 'worldwide', 'anywhere', 'georgia', 'atlanta',
      'california', 'remote', 'telehealth',
    ],
  },
};

// ============================================================
// Profile Resolution
// ============================================================

async function resolveProfile() {
  const args = process.argv.slice(2);
  const match = args.join(' ').match(/--profile=(\w+)/);
  if (match) return match[1];

  // Fall back to profiles/active.yml
  try {
    const yml = await readFile(resolve(__dirname, 'profiles/active.yml'), 'utf8');
    return yml.match(/active:\s*(\w+)/)?.[1] || 'lamin';
  } catch {
    return 'lamin';
  }
}

// ============================================================
// Keyword Matching
// ============================================================

function matchesKeywords(text, config) {
  const lower = (text || '').toLowerCase();
  const hasPositive = config.positiveKeywords.some(kw => lower.includes(kw));
  if (!hasPositive) return false;
  const hasNegative = config.negativeKeywords.some(kw => lower.includes(kw));
  if (hasNegative) return false;
  return true;
}

function matchesLocation(location, config) {
  // Empty/null location = remote anywhere = accepted
  if (!location || location.trim() === '') return true;
  const lower = location.toLowerCase();
  return config.locationAccept.some(loc => lower.includes(loc));
}

// ============================================================
// Salary Parsing
// ============================================================

function formatSalary(job) {
  // Remotive provides salary as a string field
  const salary = job.salary;
  if (salary && salary.trim() !== '') return salary.trim();
  return 'Not disclosed';
}

// ============================================================
// Dedup — load existing URLs + company+title combos
// ============================================================

async function loadExistingEntries(pipelinePath, historyPath, applicationsPath) {
  const urls = new Set();
  const companyTitles = new Set();

  for (const filePath of [pipelinePath, applicationsPath, historyPath]) {
    try {
      const content = await readFile(filePath, 'utf8');
      for (const match of content.matchAll(/https?:\/\/[^\s|)\t]+/g)) {
        urls.add(match[0]);
      }
    } catch { /* file may not exist yet */ }
  }

  // Extract company+title combos from pipeline for secondary dedup
  try {
    const pipeline = await readFile(pipelinePath, 'utf8');
    for (const line of pipeline.split('\n')) {
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
// API Client
// ============================================================

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchJobs(category, search, limit) {
  const params = new URLSearchParams();
  if (category) params.set('category', category);
  if (search) params.set('search', search);
  params.set('limit', String(limit));

  const url = `${API_BASE}?${params}`;

  const res = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'career-ops/1.0 (job-search-pipeline)',
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Remotive API ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  return data?.jobs || [];
}

// ============================================================
// Pipeline + History Writers
// ============================================================

async function appendToPipeline(jobs, pipelinePath) {
  if (jobs.length === 0) return;

  const lines = jobs.map(j =>
    `- [ ] ${j.url} | ${j.company} | ${j.title} — ${j.location || 'Remote'} | ${j.salary}`
  ).join('\n');

  try {
    const existing = await readFile(pipelinePath, 'utf8');
    if (existing.includes('## Pendientes')) {
      const updated = existing.replace(
        '## Pendientes\n',
        `## Pendientes\n\n${lines}\n`
      );
      await writeFile(pipelinePath, updated, 'utf8');
    } else {
      await appendFile(pipelinePath, `\n${lines}\n`, 'utf8');
    }
  } catch {
    await writeFile(pipelinePath, `# Pipeline — Pending URLs\n\n## Pendientes\n\n${lines}\n`, 'utf8');
  }
}

async function appendToScanHistory(jobs, skipped, historyPath) {
  const date = new Date().toISOString().split('T')[0];

  const lines = [
    ...jobs.map(j => `${j.url}\t${date}\tRemotive: ${j.queryLabel}\t${j.title}\t${j.company}\tadded`),
    ...skipped.map(s => `${s.url}\t${date}\tRemotive: ${s.queryLabel}\t${s.title}\t${s.company}\t${s.reason}`),
  ].join('\n');

  if (!lines) return;

  try {
    await appendFile(historyPath, `\n${lines}`, 'utf8');
  } catch {
    const header = 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus';
    await writeFile(historyPath, `${header}\n${lines}\n`, 'utf8');
  }
}

// ============================================================
// Main Scanner
// ============================================================

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const profileName = await resolveProfile();

  const config = PROFILE_CONFIGS[profileName];
  if (!config) {
    throw new Error(`Unknown profile: ${profileName}. Available: ${Object.keys(PROFILE_CONFIGS).join(', ')}`);
  }

  const SEARCH_QUERIES = config.searchQueries;

  // Dynamic paths based on profile
  const PIPELINE_PATH = resolve(__dirname, `profiles/${profileName}/data/pipeline.md`);
  const HISTORY_PATH = resolve(__dirname, `profiles/${profileName}/data/scan-history.tsv`);
  const APPLICATIONS_PATH = resolve(__dirname, `profiles/${profileName}/data/applications.md`);

  console.log(`\n  Remotive API Scanner — Profile: ${profileName}`);
  console.log(`  ${'━'.repeat(50)}`);
  console.log(`  Queries: ${SEARCH_QUERIES.length} | Limit: ${RESULTS_PER_QUERY}/query | Dry run: ${dryRun}\n`);

  // Load dedup
  const { urls: existingUrls, companyTitles: existingCombos } = await loadExistingEntries(PIPELINE_PATH, HISTORY_PATH, APPLICATIONS_PATH);
  console.log(`  Existing URLs loaded: ${existingUrls.size}`);
  console.log(`  Existing company+title combos: ${existingCombos.size}`);

  const allJobs = [];
  const allSkipped = [];
  const seenIds = new Set();
  let totalFound = 0;
  let totalFiltered = 0;
  let totalDuped = 0;
  let totalLocation = 0;

  for (const query of SEARCH_QUERIES) {
    try {
      const label = query.label;
      console.log(`\n  Searching: ${label}...`);

      const jobs = await fetchJobs(query.category, query.search, RESULTS_PER_QUERY);
      console.log(`    Found: ${jobs.length} results`);
      totalFound += jobs.length;

      for (const job of jobs) {
        const id = job.id;
        if (!id || seenIds.has(id)) continue;
        seenIds.add(id);

        const title = job.title || '';
        const company = job.company_name || 'Unknown';
        const location = job.candidate_required_location || '';
        const url = job.url || '';
        const tags = (job.tags || []).join(' ');
        const category = job.category || '';
        const jobType = job.job_type || '';

        // Combine title + tags + category for keyword matching
        const searchText = `${title} ${tags} ${category} ${jobType}`;

        // URL dedup
        if (url && existingUrls.has(url)) {
          totalDuped++;
          allSkipped.push({ url, title, company, queryLabel: label, reason: 'skipped_dup_url' });
          continue;
        }

        // Company+title dedup
        const combo = `${company.toLowerCase()}:::${title.toLowerCase()}`;
        if (existingCombos.has(combo)) {
          totalDuped++;
          allSkipped.push({ url, title, company, queryLabel: label, reason: 'skipped_dup_combo' });
          continue;
        }

        // Keyword filter
        if (!matchesKeywords(searchText, config)) {
          totalFiltered++;
          allSkipped.push({ url, title, company, queryLabel: label, reason: 'skipped_keywords' });
          continue;
        }

        // Negative keyword check on title
        const titleLower = title.toLowerCase();
        if (config.negativeKeywords.some(kw => titleLower.includes(kw))) {
          totalFiltered++;
          allSkipped.push({ url, title, company, queryLabel: label, reason: 'skipped_negative' });
          continue;
        }

        // Location filter
        if (!matchesLocation(location, config)) {
          totalLocation++;
          allSkipped.push({ url, title, company, queryLabel: label, reason: 'skipped_location' });
          continue;
        }

        const salary = formatSalary(job);

        allJobs.push({ url, title, company, location, salary, queryLabel: label });
        if (url) existingUrls.add(url);
        existingCombos.add(combo);
      }

      await sleep(RATE_LIMIT_MS);
    } catch (err) {
      console.error(`    ERROR: ${err.message}`);
    }
  }

  // Summary
  console.log(`\n  ${'━'.repeat(50)}`);
  console.log(`  Remotive Scan Complete — ${new Date().toISOString().split('T')[0]}`);
  console.log(`  ${'━'.repeat(50)}`);
  console.log(`  Queries executed:    ${SEARCH_QUERIES.length}`);
  console.log(`  Total results:       ${totalFound}`);
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
    await appendToPipeline(allJobs, PIPELINE_PATH);
    console.log(`\n  Written to profiles/${profileName}/data/pipeline.md`);
  }

  if (!dryRun) {
    await appendToScanHistory(allJobs, allSkipped, HISTORY_PATH);
    console.log(`  Written to profiles/${profileName}/data/scan-history.tsv`);
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
