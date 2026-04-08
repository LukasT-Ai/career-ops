#!/usr/bin/env node

/**
 * doximity-scraper.mjs — Doximity Job Board Scraper
 *
 * Scrapes Doximity's public physician job board (doximity.com/careers).
 * Doximity is the #1 physician job board in the US.
 *
 * The site embeds job data in a `data-page` attribute (Vue/Inertia SSR).
 * Each job card has JSON-LD structured data with full descriptions.
 *
 * Usage:
 *   node doximity-scraper.mjs [--profile=paulina|lamin] [--dry-run] [--limit=20]
 *
 * Without --profile, reads profiles/active.yml to determine which profile to scan.
 */

import { readFile, writeFile, appendFile } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================
// Configuration
// ============================================================

const BASE_URL = 'https://www.doximity.com/careers';
const JOB_CARD_BASE = 'https://www.doximity.com/careers/job_cards';
const RATE_LIMIT_MS = 1200; // be polite — ~1.2s between requests
const JOBS_PER_PAGE = 20;   // Doximity returns 20 per page

// ============================================================
// Search Profiles
// ============================================================

const SEARCH_CONFIGS = {
  paulina: {
    searches: [
      // Georgia — primary (licensed)
      { specialty: 'Psychiatry', location: 'Georgia', keywords: '', label: 'Psychiatry GA' },
      { specialty: 'Psychiatry', location: 'Georgia', keywords: 'psychiatrist', label: 'Psychiatrist GA' },
      { specialty: 'Psychiatry', location: 'Georgia', keywords: 'medical director', label: 'Medical Director Psych GA' },
      { specialty: 'Psychiatry', location: 'Georgia', keywords: 'telepsychiatry', label: 'Telepsychiatry GA' },
      // California — licensed, remote/tele preferred
      { specialty: 'Psychiatry', location: 'California', keywords: '', label: 'Psychiatry CA' },
      { specialty: 'Psychiatry', location: 'California', keywords: 'psychiatrist', label: 'Psychiatrist CA' },
      { specialty: 'Psychiatry', location: 'California', keywords: 'telepsychiatry', label: 'Telepsychiatry CA' },
      // Telemedicine employment type searches
      { specialty: 'Psychiatry', location: '', keywords: 'telepsychiatry', employmentType: 'Telemedicine', label: 'Telepsychiatry Remote' },
      // Broader behavioral health
      { specialty: 'All Specialties', location: 'Georgia', keywords: 'behavioral health physician', label: 'Behavioral Health Physician GA' },
      { specialty: 'All Specialties', location: 'Georgia', keywords: 'mental health physician', label: 'Mental Health Physician GA' },
    ],
    locationFilter: [
      'georgia', 'atlanta', 'augusta', 'savannah', 'macon', 'athens',
      'columbus', 'stockbridge', 'marietta', 'decatur', 'lawrenceville',
      'california', 'los angeles', 'san francisco', 'san diego', 'sacramento',
      'remote', 'telehealth', 'telepsych', 'telemedicine', 'nationwide',
    ],
    titlePositive: [
      'psychiatr', 'physician', 'medical director', 'behavioral health', 'mental health',
      'attending', 'clinical director', 'medical officer', 'telepsych',
    ],
    titleNegative: [
      'nurse', 'nursing', 'social worker', 'psycholog', 'counselor', 'technician',
      'administrative', 'clerk', 'secretary', 'custodian', 'housekeep', 'aide',
      'receptionist', 'billing', 'coder', 'cna', 'lpn', 'rn ',
      'physician assistant', ' pa ', ' pa-c',
    ],
  },

  lamin: {
    // Doximity is physician-focused — skip for Lamin (sales profile)
    searches: [],
    locationFilter: [],
    titlePositive: [],
    titleNegative: [],
  },
};

// ============================================================
// HTTP Client
// ============================================================

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

/**
 * Fetch a Doximity careers search page and extract embedded job data.
 * Returns { jobs, totalJobs, currentPage }.
 */
async function fetchSearchPage({ specialty, location, keywords, employmentType, page = 1 }) {
  const params = new URLSearchParams();
  if (specialty && specialty !== 'All Specialties') params.set('specialty', specialty);
  if (location) params.set('location', location);
  if (keywords) params.set('keywords', keywords);
  if (employmentType) params.set('employment_type', employmentType);
  if (page > 1) params.set('page', String(page));

  const url = `${BASE_URL}?${params}`;
  const res = await fetch(url, { headers: HEADERS });

  if (!res.ok) {
    throw new Error(`Doximity HTTP ${res.status} for ${url}`);
  }

  const html = await res.text();

  // Extract the data-page attribute (Vue/Inertia SSR pattern)
  const match = html.match(/data-page="(\{[\s\S]*?)"\s*(?:data-|>)/);
  if (!match) {
    throw new Error('Could not find data-page attribute in HTML');
  }

  const decoded = match[1]
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'");

  const data = JSON.parse(decoded);
  const props = data.props || {};

  return {
    jobs: (props.searchJobs || []).map(j => ({
      uuid: j.uuid,
      title: j.title || 'Unknown Title',
      location: j.location || '',
      posted: j.posted || '',
      compensationAvailable: j.compensationAvailable || false,
      jobCardPath: j.jobCardPath || '',
    })),
    totalJobs: props.totalSearchJobs || 0,
    currentPage: props.currentSearchPage || 1,
    jobsPerPage: props.jobsPerPage || JOBS_PER_PAGE,
  };
}

/**
 * Fetch individual job card to get company name and salary from JSON-LD.
 * Returns { company, salary, employmentType } or defaults on failure.
 */
async function fetchJobDetail(uuid) {
  const url = `${JOB_CARD_BASE}/${uuid}`;
  try {
    const res = await fetch(url, {
      headers: { ...HEADERS, 'Accept': 'text/html' },
    });
    if (!res.ok) return { company: 'Unknown Employer', salary: null, employmentType: '' };

    const html = await res.text();

    // Extract JSON-LD structured data
    const ldMatch = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/);
    if (!ldMatch) return { company: 'Unknown Employer', salary: null, employmentType: '' };

    const ld = JSON.parse(ldMatch[1]);
    return {
      company: ld.hiringOrganization?.name || 'Unknown Employer',
      salary: ld.baseSalary || null,
      employmentType: ld.employmentType || '',
    };
  } catch {
    return { company: 'Unknown Employer', salary: null, employmentType: '' };
  }
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
// Location Filtering
// ============================================================

function matchesLocation(job, config) {
  if (!config.locationFilter || config.locationFilter.length === 0) return true;

  const locLower = (job.location || '').toLowerCase();
  const titleLower = (job.title || '').toLowerCase();
  const combined = `${locLower} ${titleLower}`;
  return config.locationFilter.some(kw => combined.includes(kw));
}

// ============================================================
// Salary Formatting
// ============================================================

function formatSalary(salary) {
  if (!salary) return 'Not disclosed';
  const value = salary.value;
  if (!value) return 'Not disclosed';
  const fmt = (n) => Math.round(n).toLocaleString('en-US');
  if (value.minValue && value.maxValue) {
    return `$${fmt(value.minValue)}-$${fmt(value.maxValue)}`;
  }
  if (value.minValue) return `$${fmt(value.minValue)}+`;
  if (value.maxValue) return `Up to $${fmt(value.maxValue)}`;
  if (value.value) return `$${fmt(value.value)}`;
  return 'Not disclosed';
}

// ============================================================
// Pipeline Integration (profile-specific)
// ============================================================

async function loadExistingUrls(profileName) {
  const urls = new Set();
  const profileDir = resolve(__dirname, 'profiles', profileName, 'data');

  // Load profile-specific pipeline.md
  try {
    const pipeline = await readFile(resolve(profileDir, 'pipeline.md'), 'utf8');
    for (const match of pipeline.matchAll(/https?:\/\/[^\s|)]+/g)) {
      urls.add(match[0]);
    }
  } catch { /* no pipeline yet */ }

  // Load profile-specific applications.md
  try {
    const apps = await readFile(resolve(profileDir, 'applications.md'), 'utf8');
    for (const match of apps.matchAll(/https?:\/\/[^\s|)]+/g)) {
      urls.add(match[0]);
    }
  } catch { /* no tracker yet */ }

  // Load profile-specific scan-history.tsv
  try {
    const history = await readFile(resolve(profileDir, 'scan-history.tsv'), 'utf8');
    for (const match of history.matchAll(/https?:\/\/[^\s\t]+/g)) {
      urls.add(match[0]);
    }
  } catch { /* no history yet */ }

  // Also load root data/ for cross-dedup
  try {
    const rootPipeline = await readFile(resolve(__dirname, 'data/pipeline.md'), 'utf8');
    for (const match of rootPipeline.matchAll(/https?:\/\/[^\s|)]+/g)) {
      urls.add(match[0]);
    }
  } catch { /* ok */ }

  return urls;
}

async function appendToPipeline(jobs, profileName) {
  if (jobs.length === 0) return;

  const lines = jobs.map(j => {
    const salary = formatSalary(j.salary);
    const locationPart = j.location ? ` \u2014 ${j.location}` : '';
    return `- [ ] ${j.url} | ${j.company} | ${j.title}${locationPart} | ${salary}`;
  }).join('\n');

  const pipelinePath = resolve(__dirname, 'profiles', profileName, 'data', 'pipeline.md');

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
    await writeFile(pipelinePath, `# Pipeline \u2014 Pending URLs\n\n## Pendientes\n\n${lines}\n`, 'utf8');
  }
}

async function appendToScanHistory(jobs, skipped, profileName) {
  const historyPath = resolve(__dirname, 'profiles', profileName, 'data', 'scan-history.tsv');
  const date = new Date().toISOString().split('T')[0];

  const lines = [
    ...jobs.map(j => `${j.url}\t${date}\tDoximity: ${j.queryLabel}\t${j.title}\t${j.company}\tadded`),
    ...skipped.map(s => `${s.url}\t${date}\tDoximity: ${s.queryLabel}\t${s.title}\t${s.company || ''}\t${s.reason}`),
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
  const limit = limitArg ? parseInt(limitArg.split('=')[1]) : 20;
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

  if (config.searches.length === 0) {
    console.log(`\n  Doximity Scraper \u2014 Profile: ${profileName}`);
    console.log(`  ${'━'.repeat(50)}`);
    console.log(`  Doximity is a physician job board \u2014 skipping for ${profileName} profile.\n`);
    return;
  }

  console.log(`\n  Doximity Scraper \u2014 Profile: ${profileName}`);
  console.log(`  ${'━'.repeat(50)}`);
  console.log(`  Queries: ${config.searches.length} | Limit: ${limit}/query | Dry run: ${dryRun}\n`);

  const existingUrls = await loadExistingUrls(profileName);
  console.log(`  Existing URLs loaded: ${existingUrls.size}`);

  const allJobs = [];
  const allSkipped = [];
  const seenUuids = new Set();       // dedup by uuid across queries
  const seenCompanyTitle = new Set(); // dedup by company+title combo
  let totalFound = 0;
  let totalFiltered = 0;
  let totalDuped = 0;

  for (const query of config.searches) {
    try {
      const locLabel = query.location ? `in ${query.location}` : '(nationwide)';
      const kwLabel = query.keywords ? ` kw="${query.keywords}"` : '';
      console.log(`\n  Searching: [${query.specialty}] ${locLabel}${kwLabel}...`);

      // Fetch pages up to limit
      let pagesFetched = 0;
      let totalForQuery = 0;
      let page = 1;

      while (true) {
        const result = await fetchSearchPage({
          specialty: query.specialty,
          location: query.location,
          keywords: query.keywords,
          employmentType: query.employmentType,
          page,
        });

        if (page === 1) {
          totalForQuery = result.totalJobs;
          console.log(`    Found: ${result.totalJobs} total results`);
        }

        const jobs = result.jobs;
        if (jobs.length === 0) break;

        totalFound += jobs.length;

        for (const job of jobs) {
          if (!job.uuid) continue;

          const jobUrl = `${JOB_CARD_BASE}/${job.uuid}`;

          // Dedup by uuid (same job in multiple queries)
          if (seenUuids.has(job.uuid)) {
            totalDuped++;
            allSkipped.push({ url: jobUrl, title: job.title, company: '', queryLabel: query.label, reason: 'skipped_dup_uuid' });
            continue;
          }
          seenUuids.add(job.uuid);

          // Dedup against existing pipeline URLs
          if (existingUrls.has(jobUrl)) {
            totalDuped++;
            allSkipped.push({ url: jobUrl, title: job.title, company: '', queryLabel: query.label, reason: 'skipped_dup_url' });
            continue;
          }

          // Title filter
          if (!matchesTitle(job.title, config)) {
            totalFiltered++;
            allSkipped.push({ url: jobUrl, title: job.title, company: '', queryLabel: query.label, reason: 'skipped_title' });
            continue;
          }

          // Location filter
          if (!matchesLocation(job, config)) {
            totalFiltered++;
            allSkipped.push({ url: jobUrl, title: job.title, company: '', queryLabel: query.label, reason: 'skipped_location' });
            continue;
          }

          // Passed all filters — fetch detail for company/salary
          await sleep(RATE_LIMIT_MS);
          const detail = await fetchJobDetail(job.uuid);

          // Dedup by company+title combo
          const companyTitleKey = `${detail.company.toLowerCase().trim()}||${job.title.toLowerCase().trim()}`;
          if (seenCompanyTitle.has(companyTitleKey)) {
            totalDuped++;
            allSkipped.push({ url: jobUrl, title: job.title, company: detail.company, queryLabel: query.label, reason: 'skipped_dup_combo' });
            continue;
          }
          seenCompanyTitle.add(companyTitleKey);

          allJobs.push({
            url: jobUrl,
            title: job.title,
            company: detail.company,
            location: job.location,
            salary: detail.salary,
            employmentType: detail.employmentType,
            posted: job.posted,
            queryLabel: query.label,
          });
          existingUrls.add(jobUrl);
        }

        pagesFetched++;
        const fetchedSoFar = pagesFetched * result.jobsPerPage;
        if (fetchedSoFar >= limit || fetchedSoFar >= totalForQuery) break;

        page++;
        await sleep(RATE_LIMIT_MS);
      }

      await sleep(RATE_LIMIT_MS);
    } catch (err) {
      console.error(`    ERROR: ${err.message}`);
    }
  }

  // Summary
  console.log(`\n  ${'━'.repeat(50)}`);
  console.log(`  Doximity Scan Complete \u2014 ${new Date().toISOString().split('T')[0]}`);
  console.log(`  ${'━'.repeat(50)}`);
  console.log(`  Queries executed: ${config.searches.length}`);
  console.log(`  Total results:    ${totalFound}`);
  console.log(`  Filtered:         ${totalFiltered}`);
  console.log(`  Duplicates:       ${totalDuped}`);
  console.log(`  NEW to pipeline:  ${allJobs.length}`);

  if (allJobs.length > 0) {
    console.log(`\n  New jobs:`);
    for (const job of allJobs) {
      const salary = formatSalary(job.salary);
      console.log(`    + ${job.company} | ${job.title} | ${job.location} | ${salary}`);
    }
  }

  // Write results
  if (!dryRun && allJobs.length > 0) {
    await appendToPipeline(allJobs, profileName);
    console.log(`\n  Written to profiles/${profileName}/data/pipeline.md`);
  }

  if (!dryRun) {
    await appendToScanHistory(allJobs, allSkipped, profileName);
    console.log(`  Written to profiles/${profileName}/data/scan-history.tsv`);
  }

  if (dryRun) {
    console.log(`\n  (Dry run \u2014 no files written)`);
  }

  console.log('');
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
