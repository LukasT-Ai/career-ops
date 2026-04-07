#!/usr/bin/env node

/**
 * usajobs-api.mjs — USAJobs.gov API Scanner
 *
 * Free government API with registered key. Searches federal job listings
 * for all 3 profiles across USA locations.
 *
 * Usage:
 *   node usajobs-api.mjs [--profile=paulina|lamin|josephina] [--dry-run] [--limit=25]
 *
 * Without --profile, reads profiles/active.yml to determine which profile to scan.
 *
 * API docs: https://developer.usajobs.gov/API-Reference
 * Rate limit: 100 req/min
 */

import { readFile, writeFile, appendFile } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================
// API Configuration
// ============================================================

const API_BASE = 'https://data.usajobs.gov/api/Search';
const API_KEY = 's566gHhBZJI9IUee+2xEBIVL05vBsVp9q8db9TyxHDE=';
const USER_AGENT = 'Lukas.T@withlukas.com'; // Required by USAJobs API
const HEADERS = {
  'Authorization-Key': API_KEY,
  'User-Agent': USER_AGENT,
  'Host': 'data.usajobs.gov',
  'Accept': 'application/json',
};

// Rate limiting: 100 req/min → ~600ms between requests for safety
const RATE_LIMIT_MS = 600;

// ============================================================
// Search Profiles
// ============================================================

const SEARCH_CONFIGS = {
  paulina: {
    queries: [
      { keyword: 'Psychiatrist', location: 'Georgia', label: 'Psychiatrist GA' },
      { keyword: 'Psychiatrist', location: '', label: 'Psychiatrist (national)' },
      { keyword: 'Staff Psychiatrist', location: '', label: 'Staff Psychiatrist' },
      { keyword: 'Attending Psychiatrist', location: '', label: 'Attending Psychiatrist' },
      { keyword: 'Medical Officer Psychiatry', location: '', label: 'Medical Officer Psychiatry' },
      { keyword: 'Physician Psychiatry', location: '', label: 'Physician Psychiatry' },
      { keyword: 'Behavioral Health Physician', location: '', label: 'Behavioral Health Physician' },
      { keyword: 'Telepsychiatrist', location: '', label: 'Telepsychiatrist' },
      { keyword: 'Psychiatrist VA', location: '', label: 'VA Psychiatrist' },
      { keyword: 'Medical Director Behavioral Health', location: '', label: 'Medical Director BH' },
    ],
    titlePositive: [
      'psychiatr', 'physician', 'medical officer', 'behavioral health', 'mental health',
      'medical director', 'attending', 'clinical director',
    ],
    titleNegative: [
      'nurse', 'nursing', 'social worker', 'psycholog', 'counselor', 'technician',
      'administrative', 'clerk', 'secretary', 'custodian', 'housekeep',
    ],
  },

  lamin: {
    queries: [
      // All US queries restricted to Georgia or remote — Lamin will NOT relocate within the US
      { keyword: 'Telecommunications Specialist', location: 'Georgia', label: 'Telecom Specialist GA' },
      { keyword: 'Telecommunications Manager', location: 'Georgia', label: 'Telecom Manager GA' },
      { keyword: 'IT Sales', location: 'Georgia', label: 'IT Sales GA' },
      { keyword: 'Account Manager IT', location: 'Georgia', label: 'Account Manager IT GA' },
      { keyword: 'Contracting Officer Telecommunications', location: 'Georgia', label: 'Contracting Telecom GA' },
      { keyword: 'Business Development Specialist', location: 'Georgia', label: 'BizDev GA' },
      { keyword: 'Program Manager Telecommunications', location: 'Georgia', label: 'Program Manager Telecom GA' },
      { keyword: 'Network Manager', location: 'Georgia', label: 'Network Manager GA' },
      { keyword: 'Sales Manager Federal', location: 'Georgia', label: 'Sales Manager Federal GA' },
      { keyword: 'IT Specialist Customer Support', location: 'Georgia', label: 'IT Specialist GA' },
    ],
    // Post-fetch location filter: only keep jobs in GA or remote/negotiable
    locationFilter: ['georgia', 'atlanta', 'remote', 'location negotiable', 'telework', 'anywhere'],
    titlePositive: [
      'telecom', 'sales', 'account', 'business development', 'program manager',
      'contract', 'network', 'it specialist', 'customer', 'acquisition',
      'management analyst', 'procurement',
    ],
    titleNegative: [
      'intern', 'student', 'trainee', 'custodian', 'maintenance', 'janitor',
      'food service', 'laundry', 'housekeep', 'nurse', 'physician',
    ],
  },

  josephina: {
    queries: [
      { keyword: 'UX Designer', location: '', label: 'UX Designer' },
      { keyword: 'UI Designer', location: '', label: 'UI Designer' },
      { keyword: 'Visual Designer', location: '', label: 'Visual Designer' },
      { keyword: 'User Experience', location: 'Georgia', label: 'User Experience GA' },
      { keyword: 'Digital Designer', location: '', label: 'Digital Designer' },
      { keyword: 'Interaction Designer', location: '', label: 'Interaction Designer' },
      { keyword: 'Product Designer', location: '', label: 'Product Designer' },
      { keyword: 'Web Designer', location: 'Georgia', label: 'Web Designer GA' },
      { keyword: 'Graphic Designer GS-12', location: '', label: 'Graphic Designer GS-12+' },
      { keyword: 'Design Lead Federal', location: '', label: 'Design Lead Federal' },
    ],
    titlePositive: [
      'design', 'ux', 'ui', 'user experience', 'visual', 'interaction', 'digital',
      'creative', 'product design', 'web design', 'graphic',
    ],
    titleNegative: [
      'intern', 'student', 'trainee', 'mechanical', 'electrical', 'structural',
      'civil engineer', 'architect', 'construction', 'interior', 'fashion',
      'industrial design', 'landscape',
    ],
  },
};

// ============================================================
// API Client
// ============================================================

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function searchJobs(keyword, location = '', limit = 25, page = 1) {
  const params = new URLSearchParams({
    Keyword: keyword,
    ResultsPerPage: String(limit),
    Page: String(page),
  });
  if (location) params.set('LocationName', location);

  const url = `${API_BASE}?${params}`;

  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`USAJobs API ${res.status}: ${text.slice(0, 200)}`);
  }

  return res.json();
}

// ============================================================
// Result Parsing
// ============================================================

function parseResults(data) {
  const items = data?.SearchResult?.SearchResultItems || [];
  const total = parseInt(data?.SearchResult?.SearchResultCount || '0');

  return {
    total,
    jobs: items.map(item => {
      const match = item.MatchedObjectDescriptor;
      return {
        id: match.PositionID,
        title: match.PositionTitle,
        company: match.OrganizationName || match.DepartmentName,
        department: match.DepartmentName,
        location: match.PositionLocationDisplay,
        url: match.PositionURI,
        applyUrl: match.ApplyURI?.[0],
        salary: formatSalary(match.PositionRemuneration?.[0]),
        grade: `${match.JobGrade?.[0]?.Code || ''}-${match.UserArea?.Details?.LowGrade || '?'}/${match.UserArea?.Details?.HighGrade || '?'}`,
        openDate: match.PositionStartDate,
        closeDate: match.PositionEndDate,
        remote: match.UserArea?.Details?.TeleworkEligible === 'True',
      };
    }),
  };
}

function formatSalary(remuneration) {
  if (!remuneration) return 'Not disclosed';
  const min = remuneration.MinimumRange;
  const max = remuneration.MaximumRange;
  const interval = remuneration.Description;
  if (min && max) return `$${Number(min).toLocaleString()}-$${Number(max).toLocaleString()} ${interval || ''}`.trim();
  return 'Not disclosed';
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
// Pipeline Integration (same pattern as arbeitsagentur-api.mjs)
// ============================================================

async function loadExistingUrls() {
  const urls = new Set();

  try {
    const pipeline = await readFile(resolve(__dirname, 'data/pipeline.md'), 'utf8');
    for (const match of pipeline.matchAll(/https?:\/\/[^\s|)]+/g)) {
      urls.add(match[0]);
    }
  } catch { /* no pipeline yet */ }

  try {
    const apps = await readFile(resolve(__dirname, 'data/applications.md'), 'utf8');
    for (const match of apps.matchAll(/https?:\/\/[^\s|)]+/g)) {
      urls.add(match[0]);
    }
  } catch { /* no tracker yet */ }

  try {
    const history = await readFile(resolve(__dirname, 'data/scan-history.tsv'), 'utf8');
    for (const match of history.matchAll(/https?:\/\/[^\s\t]+/g)) {
      urls.add(match[0]);
    }
  } catch { /* no history yet */ }

  return urls;
}

async function appendToPipeline(jobs) {
  if (jobs.length === 0) return;

  const lines = jobs.map(j =>
    `- [ ] ${j.url} | ${j.company} | ${j.title} | ${j.salary} | ${j.grade}`
  ).join('\n');

  const pipelinePath = resolve(__dirname, 'data/pipeline.md');

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

async function appendToScanHistory(jobs, skipped) {
  const historyPath = resolve(__dirname, 'data/scan-history.tsv');
  const date = new Date().toISOString().split('T')[0];

  const lines = [
    ...jobs.map(j => `${j.url}\t${date}\tUSAJobs: ${j.queryLabel}\t${j.title}\t${j.company}\tadded`),
    ...skipped.map(s => `${s.url}\t${date}\tUSAJobs: ${s.queryLabel}\t${s.title}\t${s.company}\t${s.reason}`),
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

  console.log(`\n  USAJobs API Scanner — Profile: ${profileName}`);
  console.log(`  ${'━'.repeat(50)}`);
  console.log(`  Queries: ${config.queries.length} | Limit: ${limit}/query | Dry run: ${dryRun}\n`);

  const existingUrls = await loadExistingUrls();
  console.log(`  Existing URLs loaded: ${existingUrls.size}`);

  const allJobs = [];
  const allSkipped = [];
  const seenIds = new Set();
  let totalFound = 0;
  let totalFiltered = 0;
  let totalDuped = 0;

  for (const query of config.queries) {
    try {
      console.log(`\n  Searching: "${query.keyword}" ${query.location ? `in ${query.location}` : '(national)'}...`);
      const data = await searchJobs(query.keyword, query.location, limit);
      const { total, jobs } = parseResults(data);

      console.log(`    Found: ${jobs.length} results (${total} total available)`);
      totalFound += jobs.length;

      for (const job of jobs) {
        if (!job.id || seenIds.has(job.id)) continue;
        seenIds.add(job.id);

        // Dedup against existing pipeline
        if (existingUrls.has(job.url)) {
          totalDuped++;
          allSkipped.push({ url: job.url, title: job.title, company: job.company, queryLabel: query.label, reason: 'skipped_dup' });
          continue;
        }

        // Title filter
        if (!matchesTitle(job.title, config)) {
          totalFiltered++;
          allSkipped.push({ url: job.url, title: job.title, company: job.company, queryLabel: query.label, reason: 'skipped_title' });
          continue;
        }

        // Location filter: if profile has locationFilter, only keep matching locations
        if (config.locationFilter && config.locationFilter.length > 0) {
          const jobLoc = (job.location || '').toLowerCase();
          const matchesLocation = config.locationFilter.some(loc => jobLoc.includes(loc)) || job.remote;
          if (!matchesLocation) {
            totalFiltered++;
            allSkipped.push({ url: job.url, title: job.title, company: job.company, queryLabel: query.label, reason: 'skipped_location' });
            continue;
          }
        }

        const displayTitle = job.location ? `${job.title} — ${job.location}` : job.title;
        allJobs.push({
          url: job.url,
          title: displayTitle,
          company: job.company,
          salary: job.salary,
          grade: job.grade,
          remote: job.remote,
          queryLabel: query.label,
        });
        existingUrls.add(job.url);
      }

      await sleep(RATE_LIMIT_MS);
    } catch (err) {
      console.error(`    ERROR: ${err.message}`);
    }
  }

  // Summary
  console.log(`\n  ${'━'.repeat(50)}`);
  console.log(`  USAJobs Scan Complete — ${new Date().toISOString().split('T')[0]}`);
  console.log(`  ${'━'.repeat(50)}`);
  console.log(`  Queries executed: ${config.queries.length}`);
  console.log(`  Total results:    ${totalFound}`);
  console.log(`  Filtered (title): ${totalFiltered}`);
  console.log(`  Duplicates:       ${totalDuped}`);
  console.log(`  NEW to pipeline:  ${allJobs.length}`);

  if (allJobs.length > 0) {
    console.log(`\n  New jobs:`);
    for (const job of allJobs) {
      const tags = [job.salary, job.grade, job.remote ? 'REMOTE' : ''].filter(Boolean).join(' | ');
      console.log(`    + ${job.company} | ${job.title} | ${tags}`);
    }
  }

  // Write results
  if (!dryRun && allJobs.length > 0) {
    await appendToPipeline(allJobs);
    console.log(`\n  Written to data/pipeline.md`);
  }

  if (!dryRun) {
    await appendToScanHistory(allJobs, allSkipped);
    console.log(`  Written to data/scan-history.tsv`);
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
