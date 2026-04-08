#!/usr/bin/env node

/**
 * arbeitnow-api.mjs — Arbeitnow Germany Job Board API Scanner
 *
 * Free public API, no auth required. Returns all German job listings;
 * filtering is done client-side by keyword matching.
 *
 * Usage:
 *   node arbeitnow-api.mjs [--profile=lamin] [--dry-run] [--pages=3]
 *
 * Without --profile, reads profiles/active.yml to determine which profile to scan.
 * --pages controls how many pages to fetch (default 3, each page ~100 jobs)
 *
 * API docs: https://www.arbeitnow.com/api/job-board-api
 */

import { readFile, writeFile, appendFile, mkdir } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================
// API Configuration
// ============================================================

const API_BASE = 'https://www.arbeitnow.com/api/job-board-api';

// Rate limiting: be polite — 1 req/sec
const RATE_LIMIT_MS = 1000;

// ============================================================
// Search Profiles — client-side keyword filters (API has no search params)
// ============================================================

const SEARCH_CONFIGS = {
  lamin: {
    // Keywords to match against title, description, tags, company
    searchPositive: [
      'sales', 'account', 'vertrieb', 'telecom', 'telekommunikation',
      'b2b', 'enterprise', 'key account', 'business development',
      'channel', 'partner manager', 'kundenberater',
      'ucaas', 'sd-wan', 'managed services',
    ],
    titlePositive: [
      'sales', 'account', 'vertrieb', 'business development', 'enterprise',
      'telecom', 'telekommunikation', 'b2b', 'channel', 'partner',
      'key account', 'kundenberater', 'ucaas', 'sd-wan',
    ],
    titleNegative: [
      'intern', 'student', 'trainee', 'praktikum', 'werkstudent', 'azubi', 'ausbildung',
      'techniker', 'monteur', 'callcenter', 'kundenservice',
      'nurse', 'physician', 'custodian', 'maintenance',
      'junior developer', 'software engineer', 'data scientist',
    ],
  },

  paulina: {
    // Psychiatrist / physician roles — remote, telehealth, and German medical positions
    searchPositive: [
      'psychiatrist', 'psychiatry', 'behavioral health', 'mental health',
      'physician', 'medical director', 'attending', 'telepsychiatry',
      'telehealth', 'telemedicine', 'clinical director',
      'facharzt', 'psychiatrie', 'oberarzt', 'arzt', 'ärztin', 'klinik',
      'chefarzt', 'assistenzarzt', 'psychosomatik', 'neurologie',
    ],
    titlePositive: [
      'psychiatrist', 'psychiatry', 'behavioral health', 'mental health',
      'physician', 'medical director', 'attending', 'telepsychiatry',
      'telehealth', 'telemedicine', 'clinical director',
      'facharzt', 'psychiatrie', 'oberarzt', 'arzt', 'ärztin', 'klinik',
      'chefarzt', 'assistenzarzt',
    ],
    titleNegative: [
      'nurse', 'social worker', 'psychologist', 'counselor', 'technician',
      'aide', 'cna', 'lpn', 'rn', 'therapist', 'pharmacy', 'pharmacist',
      'intern', 'student', 'trainee', 'praktikum', 'werkstudent',
      'medical assistant', 'medical coder', 'billing',
      'software engineer', 'data scientist', 'developer',
    ],
  },
};

// ============================================================
// API Client
// ============================================================

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchPage(page = 1) {
  const url = page > 1 ? `${API_BASE}?page=${page}` : API_BASE;

  const res = await fetch(url, {
    headers: { 'Accept': 'application/json' },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Arbeitnow API ${res.status}: ${text.slice(0, 200)}`);
  }

  return res.json();
}

// ============================================================
// Matching Logic
// ============================================================

function matchesSearch(job, config) {
  // Build a searchable blob from title + tags + description + company
  const blob = [
    job.title || '',
    job.company_name || '',
    job.location || '',
    ...(job.tags || []),
    ...(job.job_types || []),
    (job.description || '').slice(0, 500), // first 500 chars of description for speed
  ].join(' ').toLowerCase();

  return config.searchPositive.some(kw => blob.includes(kw));
}

function matchesTitle(title, config) {
  const lower = title.toLowerCase();
  const hasPositive = config.titlePositive.some(kw => lower.includes(kw));
  if (!hasPositive) return false;
  const hasNegative = config.titleNegative.some(kw => lower.includes(kw));
  if (hasNegative) return false;
  return true;
}

// ============================================================
// Dedup: URL + company+title combo
// ============================================================

function normalizeUrl(link) {
  return (link || '').trim().replace(/\/$/, '');
}

function companyTitleKey(company, title) {
  return `${(company || '').toLowerCase().trim()}|||${(title || '').toLowerCase().trim()}`;
}

// ============================================================
// Pipeline Integration (profile-specific paths)
// ============================================================

function profileDataDir(profileName) {
  return resolve(__dirname, 'profiles', profileName, 'data');
}

async function loadExistingUrls(profileName) {
  const urls = new Set();
  const companyTitles = new Set();
  const dataDir = profileDataDir(profileName);

  const files = ['pipeline.md', 'applications.md', 'scan-history.tsv'];
  for (const file of files) {
    try {
      const content = await readFile(resolve(dataDir, file), 'utf8');
      for (const match of content.matchAll(/https?:\/\/[^\s|)\t]+/g)) {
        urls.add(normalizeUrl(match[0]));
      }
      // Extract company+title combos from pipeline lines
      for (const line of content.split('\n')) {
        const parts = line.split('|').map(p => p.trim());
        if (parts.length >= 3) {
          const co = parts[1];
          const ti = (parts[2] || '').split('—')[0].trim();
          if (co && ti) companyTitles.add(companyTitleKey(co, ti));
        }
      }
    } catch { /* file doesn't exist yet */ }
  }

  return { urls, companyTitles };
}

async function appendToPipeline(jobs, profileName) {
  if (jobs.length === 0) return;

  const lines = jobs.map(j => {
    const loc = j.location || (j.remote ? 'Remote' : 'Germany');
    const salary = j.salary ? ` | ${j.salary}` : '';
    return `- [ ] ${j.url} | ${j.company} | ${j.title} — ${loc}${salary}`;
  }).join('\n');

  const pipelinePath = resolve(profileDataDir(profileName), 'pipeline.md');

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
    await mkdir(profileDataDir(profileName), { recursive: true });
    await writeFile(pipelinePath, `# Pipeline — Pending URLs\n\n## Pendientes\n\n${lines}\n`, 'utf8');
  }
}

async function appendToScanHistory(jobs, skipped, profileName) {
  const historyPath = resolve(profileDataDir(profileName), 'scan-history.tsv');
  const date = new Date().toISOString().split('T')[0];

  const lines = [
    ...jobs.map(j => `${j.url}\t${date}\tArbeitnow: search\t${j.title}\t${j.company}\tadded`),
    ...skipped.map(s => `${s.url}\t${date}\tArbeitnow: search\t${s.title}\t${s.company}\t${s.reason}`),
  ].join('\n');

  if (!lines) return;

  try {
    await appendFile(historyPath, `\n${lines}`, 'utf8');
  } catch {
    await mkdir(profileDataDir(profileName), { recursive: true });
    const header = 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus';
    await writeFile(historyPath, `${header}\n${lines}\n`, 'utf8');
  }
}

// ============================================================
// Salary Extraction
// ============================================================

function extractSalary(job) {
  // Arbeitnow doesn't have a dedicated salary field, but it may appear in tags or description
  const tags = (job.tags || []).join(' ').toLowerCase();
  const desc = (job.description || '').slice(0, 1000).toLowerCase();

  // Look for salary patterns in tags or early description
  const patterns = [
    /(\d{2,3}[.,]\d{3}\s*[-–]\s*\d{2,3}[.,]\d{3}\s*(?:eur|€|euro))/i,
    /(€\s*\d{2,3}[.,]?\d{0,3}\s*[-–]\s*€?\s*\d{2,3}[.,]?\d{0,3})/i,
    /(\$\s*\d{2,3},?\d{0,3}\s*[-–]\s*\$?\s*\d{2,3},?\d{0,3})/i,
  ];

  for (const text of [tags, desc]) {
    for (const pat of patterns) {
      const m = text.match(pat);
      if (m) return m[1].trim();
    }
  }

  return null;
}

// ============================================================
// Main Scanner
// ============================================================

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const pagesArg = args.find(a => a.startsWith('--pages='));
  const maxPages = pagesArg ? parseInt(pagesArg.split('=')[1]) : 3;
  const profileArg = args.find(a => a.startsWith('--profile='));

  // Determine active profile
  let profileName;
  if (profileArg) {
    profileName = profileArg.split('=')[1];
  } else {
    const activeYml = await readFile(resolve(__dirname, 'profiles/active.yml'), 'utf8');
    const match = activeYml.match(/active:\s*(\w+)/);
    profileName = match ? match[1] : 'lamin';
  }

  const config = SEARCH_CONFIGS[profileName];
  if (!config) {
    console.error(`Unknown profile: ${profileName}. Available: ${Object.keys(SEARCH_CONFIGS).join(', ')}`);
    console.error('Note: Arbeitnow is a Germany-focused board. Currently configured for: lamin');
    process.exit(1);
  }

  console.log(`\n  Arbeitnow API Scanner — Profile: ${profileName}`);
  console.log(`  ${'━'.repeat(50)}`);
  console.log(`  Pages to fetch: ${maxPages} | Dry run: ${dryRun}\n`);

  const { urls: existingUrls, companyTitles: existingCompanyTitles } = await loadExistingUrls(profileName);
  console.log(`  Existing URLs loaded: ${existingUrls.size}`);

  const allJobs = [];
  const allSkipped = [];
  const seenSlugs = new Set();
  let totalFetched = 0;
  let totalSearchMatch = 0;
  let totalFiltered = 0;
  let totalDuped = 0;

  for (let page = 1; page <= maxPages; page++) {
    try {
      console.log(`\n  Fetching page ${page}/${maxPages}...`);
      const data = await fetchPage(page);
      const jobs = data?.data || [];

      if (jobs.length === 0) {
        console.log(`    No more results. Stopping.`);
        break;
      }

      console.log(`    Fetched: ${jobs.length} listings`);
      totalFetched += jobs.length;

      for (const job of jobs) {
        const slug = job.slug;
        if (!slug || seenSlugs.has(slug)) continue;
        seenSlugs.add(slug);

        const title = (job.title || 'Unknown Title').trim();
        const company = (job.company_name || 'Unknown').trim();
        const location = (job.location || '').trim();
        const url = normalizeUrl(job.url || `https://www.arbeitnow.com/view/${slug}`);
        const remote = !!job.remote;

        // Step 1: broad keyword match (title + tags + description)
        if (!matchesSearch(job, config)) continue;
        totalSearchMatch++;

        // Step 2: strict title filter
        if (!matchesTitle(title, config)) {
          totalFiltered++;
          allSkipped.push({ url, title, company, reason: 'skipped_title' });
          continue;
        }

        // Dedup by URL
        if (existingUrls.has(url)) {
          totalDuped++;
          allSkipped.push({ url, title, company, reason: 'skipped_dup_url' });
          continue;
        }

        // Dedup by company+title
        const ctKey = companyTitleKey(company, title);
        if (existingCompanyTitles.has(ctKey)) {
          totalDuped++;
          allSkipped.push({ url, title, company, reason: 'skipped_dup_company_title' });
          continue;
        }

        const salary = extractSalary(job);

        allJobs.push({
          url,
          title,
          company,
          location,
          remote,
          salary,
        });
        existingUrls.add(url);
        existingCompanyTitles.add(ctKey);
      }

      await sleep(RATE_LIMIT_MS);
    } catch (err) {
      console.error(`    ERROR on page ${page}: ${err.message}`);
    }
  }

  // Summary
  console.log(`\n  ${'━'.repeat(50)}`);
  console.log(`  Arbeitnow Scan Complete — ${new Date().toISOString().split('T')[0]}`);
  console.log(`  ${'━'.repeat(50)}`);
  console.log(`  Pages fetched:       ${maxPages}`);
  console.log(`  Total listings:      ${totalFetched}`);
  console.log(`  Search matches:      ${totalSearchMatch}`);
  console.log(`  Filtered (title):    ${totalFiltered}`);
  console.log(`  Duplicates:          ${totalDuped}`);
  console.log(`  NEW to pipeline:     ${allJobs.length}`);

  if (allJobs.length > 0) {
    console.log(`\n  New jobs:`);
    for (const job of allJobs) {
      const loc = job.location || (job.remote ? 'Remote' : 'Germany');
      const salaryTag = job.salary ? ` | ${job.salary}` : '';
      console.log(`    + ${job.company} | ${job.title} — ${loc}${salaryTag}`);
    }
  }

  // Write results to PROFILE-SPECIFIC paths
  if (!dryRun && allJobs.length > 0) {
    await appendToPipeline(allJobs, profileName);
    console.log(`\n  Written to profiles/${profileName}/data/pipeline.md`);
  }

  if (!dryRun) {
    await appendToScanHistory(allJobs, allSkipped, profileName);
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
