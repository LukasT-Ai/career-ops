#!/usr/bin/env node

/**
 * jooble-api.mjs — Jooble Job Aggregator API Scanner
 *
 * Jooble aggregates 70+ job boards worldwide. Free API with registered key.
 * Searches for both paulina (psychiatry/mental health) and lamin (sales/telecom).
 *
 * Usage:
 *   node jooble-api.mjs [--profile=paulina|lamin] [--dry-run] [--limit=25]
 *
 * Without --profile, reads profiles/active.yml to determine which profile to scan.
 *
 * API docs: https://jooble.org/api/about
 * Env var: JOOBLE_API_KEY
 */

import { readFile, writeFile, appendFile, mkdir } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================
// API Configuration
// ============================================================

const JOOBLE_API_KEY = process.env.JOOBLE_API_KEY || 'e0bd1b81-522d-41cc-8386-1e47fa874c53';
const API_URL = `https://jooble.org/api/${JOOBLE_API_KEY}`;

// Rate limiting: be polite — 1 req/sec
const RATE_LIMIT_MS = 1000;

// ============================================================
// Search Profiles
// ============================================================

const SEARCH_CONFIGS = {
  paulina: {
    queries: [
      // US — Georgia
      { keywords: 'Psychiatrist', location: 'Georgia, USA', label: 'Psychiatrist GA' },
      { keywords: 'Mental Health Doctor', location: 'Georgia, USA', label: 'Mental Health Doctor GA' },
      { keywords: 'Behavioral Health Physician', location: 'Georgia, USA', label: 'Behavioral Health Physician GA' },
      // US — California
      { keywords: 'Psychiatrist', location: 'California, USA', label: 'Psychiatrist CA' },
      { keywords: 'Mental Health Doctor', location: 'California, USA', label: 'Mental Health Doctor CA' },
      { keywords: 'Behavioral Health Physician', location: 'California, USA', label: 'Behavioral Health Physician CA' },
      // Germany
      { keywords: 'Psychiatrist', location: 'Germany', label: 'Psychiatrist DE' },
      { keywords: 'Mental Health Doctor', location: 'Germany', label: 'Mental Health Doctor DE' },
      { keywords: 'Behavioral Health Physician', location: 'Germany', label: 'Behavioral Health Physician DE' },
      { keywords: 'Facharzt Psychiatrie', location: 'Germany', label: 'Facharzt Psychiatrie DE' },
      { keywords: 'Psychiater', location: 'Germany', label: 'Psychiater DE' },
    ],
    titlePositive: [
      'psychiatr', 'physician', 'medical officer', 'behavioral health', 'mental health',
      'medical director', 'attending', 'clinical director', 'facharzt', 'oberarzt',
      'chefarzt', 'arzt', 'doctor',
    ],
    titleNegative: [
      'nurse', 'nursing', 'social worker', 'psycholog', 'counselor', 'technician',
      'administrative', 'clerk', 'secretary', 'custodian', 'housekeep',
      'assistant', 'aide', 'intern', 'student', 'praktikum', 'werkstudent',
      'krankenpfleger', 'pflegekraft', 'therapeut', 'ergotherap',
    ],
  },

  lamin: {
    queries: [
      // US — Atlanta Georgia
      { keywords: 'Sales Manager', location: 'Atlanta, Georgia', label: 'Sales Manager ATL' },
      { keywords: 'Account Manager Telecom', location: 'Atlanta, Georgia', label: 'Account Manager Telecom ATL' },
      { keywords: 'B2B Sales', location: 'Atlanta, Georgia', label: 'B2B Sales ATL' },
      { keywords: 'Enterprise Sales', location: 'Atlanta, Georgia', label: 'Enterprise Sales ATL' },
      // Germany
      { keywords: 'Sales Manager', location: 'Germany', label: 'Sales Manager DE' },
      { keywords: 'Account Manager Telecom', location: 'Germany', label: 'Account Manager Telecom DE' },
      { keywords: 'B2B Sales', location: 'Germany', label: 'B2B Sales DE' },
      { keywords: 'Enterprise Sales', location: 'Germany', label: 'Enterprise Sales DE' },
      { keywords: 'Key Account Manager', location: 'Germany', label: 'Key Account Manager DE' },
      { keywords: 'Vertrieb Telekommunikation', location: 'Germany', label: 'Vertrieb Telekom DE' },
    ],
    titlePositive: [
      'sales', 'account', 'vertrieb', 'business development', 'enterprise',
      'telecom', 'telekommunikation', 'b2b', 'channel', 'partner',
      'key account', 'kundenberater', 'ucaas', 'sd-wan',
    ],
    titleNegative: [
      'intern', 'student', 'trainee', 'praktikum', 'werkstudent', 'azubi', 'ausbildung',
      'technician', 'techniker', 'monteur', 'callcenter', 'kundenservice',
      'nurse', 'physician', 'custodian', 'maintenance',
    ],
  },
};

// ============================================================
// API Client
// ============================================================

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function searchJobs(keywords, location, page = 1) {
  const body = { keywords, location, page };

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Jooble API ${res.status}: ${text.slice(0, 200)}`);
  }

  return res.json();
}

// ============================================================
// Result Parsing
// ============================================================

function formatSalary(salary) {
  if (!salary || salary.trim() === '') return 'Not disclosed';
  return salary.trim();
}

function normalizeUrl(link) {
  // Strip trailing whitespace / fragments that could cause false dedup misses
  return (link || '').trim().replace(/\/$/, '');
}

// ============================================================
// Title Filtering
// ============================================================

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
      // Format: - [ ] URL | Company | Title ...
      for (const line of content.split('\n')) {
        const parts = line.split('|').map(p => p.trim());
        if (parts.length >= 3) {
          // parts[1] = company, parts[2] = title (may contain " — Location")
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
    const salary = j.salary !== 'Not disclosed' ? ` | ${j.salary}` : '';
    return `- [ ] ${j.url} | ${j.company} | ${j.title} — ${j.location}${salary}`;
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
    ...jobs.map(j => `${j.url}\t${date}\tJooble: ${j.queryLabel}\t${j.title}\t${j.company}\tadded`),
    ...skipped.map(s => `${s.url}\t${date}\tJooble: ${s.queryLabel}\t${s.title}\t${s.company}\t${s.reason}`),
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
// Main Scanner
// ============================================================

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const limitArg = args.find(a => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1]) : 25;
  const profileArg = args.find(a => a.startsWith('--profile='));

  // Determine active profile
  let profileName;
  if (profileArg) {
    profileName = profileArg.split('=')[1];
  } else {
    const activeYml = await readFile(resolve(__dirname, 'profiles/active.yml'), 'utf8');
    const match = activeYml.match(/active:\s*(\w+)/);
    profileName = match ? match[1] : 'paulina';
  }

  const config = SEARCH_CONFIGS[profileName];
  if (!config) {
    console.error(`Unknown profile: ${profileName}. Available: ${Object.keys(SEARCH_CONFIGS).join(', ')}`);
    process.exit(1);
  }

  if (JOOBLE_API_KEY === 'PLACEHOLDER_SET_JOOBLE_API_KEY') {
    console.error('  ERROR: Set JOOBLE_API_KEY environment variable before running.');
    console.error('  Get a free key at https://jooble.org/api/about');
    process.exit(1);
  }

  console.log(`\n  Jooble API Scanner — Profile: ${profileName}`);
  console.log(`  ${'━'.repeat(50)}`);
  console.log(`  Queries: ${config.queries.length} | Dry run: ${dryRun}\n`);

  const { urls: existingUrls, companyTitles: existingCompanyTitles } = await loadExistingUrls(profileName);
  console.log(`  Existing URLs loaded: ${existingUrls.size}`);

  const allJobs = [];
  const allSkipped = [];
  const seenIds = new Set();
  let totalFound = 0;
  let totalFiltered = 0;
  let totalDuped = 0;

  for (const query of config.queries) {
    try {
      console.log(`\n  Searching: "${query.keywords}" in ${query.location}...`);

      // Jooble paginates; fetch first page (typically 20 results)
      const data = await searchJobs(query.keywords, query.location, 1);
      const jobs = data?.jobs || [];
      const totalCount = data?.totalCount || 0;

      console.log(`    Found: ${jobs.length} results (${totalCount} total available)`);
      totalFound += jobs.length;

      for (const job of jobs) {
        const id = job.id || job.link;
        if (!id || seenIds.has(id)) continue;
        seenIds.add(id);

        const title = (job.title || 'Unknown Title').trim();
        const company = (job.company || 'Unknown').trim();
        const location = (job.location || '').trim();
        const url = normalizeUrl(job.link);
        const salary = formatSalary(job.salary);

        if (!url) continue;

        // Dedup by URL
        if (existingUrls.has(url)) {
          totalDuped++;
          allSkipped.push({ url, title, company, queryLabel: query.label, reason: 'skipped_dup_url' });
          continue;
        }

        // Dedup by company+title
        const ctKey = companyTitleKey(company, title);
        if (existingCompanyTitles.has(ctKey)) {
          totalDuped++;
          allSkipped.push({ url, title, company, queryLabel: query.label, reason: 'skipped_dup_company_title' });
          continue;
        }

        // Title filter
        if (!matchesTitle(title, config)) {
          totalFiltered++;
          allSkipped.push({ url, title, company, queryLabel: query.label, reason: 'skipped_title' });
          continue;
        }

        allJobs.push({
          url,
          title,
          company,
          location,
          salary,
          queryLabel: query.label,
        });
        existingUrls.add(url);
        existingCompanyTitles.add(ctKey);
      }

      await sleep(RATE_LIMIT_MS);
    } catch (err) {
      console.error(`    ERROR: ${err.message}`);
    }
  }

  // Summary
  console.log(`\n  ${'━'.repeat(50)}`);
  console.log(`  Jooble Scan Complete — ${new Date().toISOString().split('T')[0]}`);
  console.log(`  ${'━'.repeat(50)}`);
  console.log(`  Queries executed: ${config.queries.length}`);
  console.log(`  Total results:    ${totalFound}`);
  console.log(`  Filtered (title): ${totalFiltered}`);
  console.log(`  Duplicates:       ${totalDuped}`);
  console.log(`  NEW to pipeline:  ${allJobs.length}`);

  if (allJobs.length > 0) {
    console.log(`\n  New jobs:`);
    for (const job of allJobs) {
      const salaryTag = job.salary !== 'Not disclosed' ? ` | ${job.salary}` : '';
      console.log(`    + ${job.company} | ${job.title} — ${job.location}${salaryTag}`);
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
