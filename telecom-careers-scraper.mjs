#!/usr/bin/env node

/**
 * telecom-careers-scraper.mjs — Niche Telecom Industry Job Board Scraper
 *
 * Aggregates job listings from telecom/UCaaS company career pages via
 * Greenhouse and Lever public APIs, plus Arbeitnow (Germany).
 * No API keys required — all endpoints are public.
 *
 * Sources:
 *   - Greenhouse boards API: Dialpad, Nextiva, Five9, Bandwidth, Vonage,
 *     Twilio, NICE, ConnectWise, Ooma, ZoomInfo
 *   - Lever postings API: Megaport
 *   - Arbeitnow API: German telecom/sales jobs
 *
 * Usage:
 *   node telecom-careers-scraper.mjs [--profile=lamin|paulina] [--dry-run] [--limit=20]
 *
 * Without --profile, reads profiles/active.yml to determine which profile to scan.
 */

import { readFile, writeFile, appendFile, mkdir } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================
// Rate Limiting
// ============================================================

const RATE_LIMIT_MS = 800; // polite delay between API calls

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ============================================================
// Telecom Company Sources
// ============================================================

// Greenhouse boards — telecom / UCaaS / connectivity companies
const GREENHOUSE_BOARDS = [
  { board: 'dialpad',     company: 'Dialpad',     sector: 'UCaaS' },
  { board: 'nextiva',     company: 'Nextiva',     sector: 'UCaaS' },
  { board: 'five9',       company: 'Five9',       sector: 'CCaaS' },
  { board: 'bandwidth',   company: 'Bandwidth',   sector: 'CPaaS' },
  { board: 'vonage',      company: 'Vonage',      sector: 'CPaaS/UCaaS' },
  { board: 'twilio',      company: 'Twilio',      sector: 'CPaaS' },
  { board: 'nice',        company: 'NICE',        sector: 'CCaaS' },
  { board: 'connectwise', company: 'ConnectWise', sector: 'MSP/IT' },
  { board: 'ooma',        company: 'Ooma',        sector: 'UCaaS/VoIP' },
  { board: 'zoominfo',    company: 'ZoomInfo',    sector: 'SalesTech' },
];

// Lever boards
const LEVER_BOARDS = [
  { board: 'megaport', company: 'Megaport', sector: 'Network/SDN' },
];

// ============================================================
// Search Profiles
// ============================================================

const SEARCH_CONFIGS = {
  lamin: {
    // Keywords to match in job titles (case-insensitive, any match = pass)
    titlePositive: [
      'sales', 'account', 'vertrieb', 'business development', 'telecom',
      'telekommunikation', 'b2b', 'enterprise', 'key account', 'channel',
      'partner', 'ucaas', 'sd-wan', 'managed services', 'commercial',
      'revenue', 'kundenberater',
    ],
    // Keywords that disqualify (case-insensitive, any match = reject)
    titleNegative: [
      'intern', 'student', 'trainee', 'praktikum', 'werkstudent', 'azubi',
      'ausbildung', 'custodian', 'maintenance', 'janitor', 'nurse',
      'physician', 'driver', 'warehouse', 'cashier', 'retail associate',
      'food service', 'barista', 'call center agent', 'callcenter',
      'software engineer', 'data scientist', 'devops', 'sre',
      'product manager', 'designer', 'ux ', 'ui ',
    ],
    // Location keywords (US jobs must match one; DE jobs always pass)
    locationFilter: [
      'atlanta', 'georgia', 'remote', 'work from home', 'telecommute',
      'anywhere', 'united states', 'us-remote', 'usa',
    ],
    // Arbeitnow queries for German market
    arbeitnowQueries: [
      'Account Manager Telekommunikation',
      'Vertrieb Telekommunikation',
      'Sales Manager Telecom',
      'B2B Sales',
      'Key Account Manager',
    ],
  },

  paulina: {
    // Not relevant for telecom scraper
    titlePositive: [],
    titleNegative: [],
    locationFilter: [],
    arbeitnowQueries: [],
  },
};

// ============================================================
// Portals.yml Title Filter (profile-specific)
// ============================================================

async function loadPortalsTitleFilter(profileName) {
  // Try profile-specific portals.yml first, then root
  const paths = [
    resolve(__dirname, 'profiles', profileName, 'portals.yml'),
    resolve(__dirname, 'portals.yml'),
  ];

  for (const p of paths) {
    try {
      const text = await readFile(p, 'utf8');
      const positive = [];
      const negative = [];

      // Simple YAML parsing for title_filter section
      let inTitleFilter = false;
      let inPositive = false;
      let inNegative = false;

      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed === 'title_filter:') { inTitleFilter = true; continue; }
        if (inTitleFilter && trimmed === 'positive:') { inPositive = true; inNegative = false; continue; }
        if (inTitleFilter && trimmed === 'negative:') { inNegative = true; inPositive = false; continue; }
        if (inTitleFilter && /^\w+:/.test(trimmed) && !trimmed.startsWith('-')) {
          // New top-level key under title_filter or new section entirely
          if (!trimmed.startsWith('positive') && !trimmed.startsWith('negative')) {
            inPositive = false;
            inNegative = false;
            if (!/^\s/.test(line)) inTitleFilter = false;
          }
          continue;
        }

        const match = trimmed.match(/^-\s+"(.+)"$/) || trimmed.match(/^-\s+'(.+)'$/);
        if (match) {
          if (inPositive) positive.push(match[1].toLowerCase());
          if (inNegative) negative.push(match[1].toLowerCase());
        }
      }

      if (positive.length > 0 || negative.length > 0) {
        return { positive, negative };
      }
    } catch { /* try next path */ }
  }

  return { positive: [], negative: [] };
}

// ============================================================
// Title Filtering
// ============================================================

function matchesTitle(title, config, portalFilter) {
  const lower = title.toLowerCase();

  // Combine config and portal filters
  const allPositive = [
    ...config.titlePositive,
    ...portalFilter.positive,
  ];
  const allNegative = [
    ...config.titleNegative,
    ...portalFilter.negative,
  ];

  // Must match at least one positive keyword
  if (allPositive.length > 0) {
    const hasPositive = allPositive.some(kw => lower.includes(kw));
    if (!hasPositive) return false;
  }

  // Must not match any negative keyword
  if (allNegative.length > 0) {
    const hasNegative = allNegative.some(kw => lower.includes(kw));
    if (hasNegative) return false;
  }

  return true;
}

// ============================================================
// Location Filtering
// ============================================================

function matchesLocation(location, config, source) {
  // German sources always pass (no location restriction for Lamin)
  if (source === 'arbeitnow') return true;

  // If location mentions Germany/DE, always pass
  const locLower = (location || '').toLowerCase();
  if (/germany|deutschland|berlin|munich|hamburg|frankfurt|köln|düsseldorf|stuttgart|dortmund|essen|leipzig|dresden|bremen|hannover|nürnberg/.test(locLower)) {
    return true;
  }

  if (!config.locationFilter || config.locationFilter.length === 0) return true;

  return config.locationFilter.some(kw => locLower.includes(kw));
}

// ============================================================
// Greenhouse API Client
// ============================================================

async function fetchGreenhouseJobs(board) {
  const url = `https://boards-api.greenhouse.io/v1/boards/${board}/jobs`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });

  if (!res.ok) {
    throw new Error(`Greenhouse ${board}: HTTP ${res.status}`);
  }

  const data = await res.json();
  return (data.jobs || []).map(j => ({
    title: j.title || 'Unknown Title',
    company: j.company_name || board,
    location: j.location?.name || '',
    url: j.absolute_url || '',
    created: j.first_published || j.updated_at || '',
    source: `Greenhouse:${board}`,
  }));
}

// ============================================================
// Lever API Client
// ============================================================

async function fetchLeverJobs(board) {
  const url = `https://api.lever.co/v0/postings/${board}?mode=json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });

  if (!res.ok) {
    throw new Error(`Lever ${board}: HTTP ${res.status}`);
  }

  const data = await res.json();
  return (Array.isArray(data) ? data : []).map(j => ({
    title: j.text || 'Unknown Title',
    company: j.categories?.team || board,
    location: j.categories?.location || '',
    url: j.hostedUrl || '',
    created: j.createdAt ? new Date(j.createdAt).toISOString() : '',
    source: `Lever:${board}`,
  }));
}

// ============================================================
// Arbeitnow API Client (Germany)
// ============================================================

async function fetchArbeitnowJobs(query, limit = 20) {
  const params = new URLSearchParams({
    search: query,
    per_page: String(limit),
  });
  const url = `https://www.arbeitnow.com/api/job-board-api?${params}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });

  if (!res.ok) {
    throw new Error(`Arbeitnow: HTTP ${res.status}`);
  }

  const data = await res.json();
  return (data.data || []).map(j => ({
    title: j.title || 'Unknown Title',
    company: j.company_name || 'Unknown',
    location: j.location || 'Germany',
    url: j.url || '',
    created: j.created_at ? new Date(j.created_at * 1000).toISOString() : '',
    source: `Arbeitnow`,
  }));
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

function formatSalary(salaryMin, salaryMax, country) {
  if (!salaryMin && !salaryMax) return 'Not disclosed';
  const symbol = country === 'de' ? '\u20AC' : '$';
  const fmt = (n) => Math.round(n).toLocaleString('en-US');
  if (salaryMin && salaryMax) return `${symbol}${fmt(salaryMin)}-${symbol}${fmt(salaryMax)}`;
  if (salaryMin) return `${symbol}${fmt(salaryMin)}+`;
  return `Up to ${symbol}${fmt(salaryMax)}`;
}

async function appendToPipeline(jobs, profileName) {
  if (jobs.length === 0) return;

  const lines = jobs.map(j => {
    const locationPart = j.location ? ` \u2014 ${j.location}` : '';
    return `- [ ] ${j.url} | ${j.company} | ${j.title}${locationPart} | Not disclosed`;
  }).join('\n');

  const pipelinePath = resolve(__dirname, 'profiles', profileName, 'data', 'pipeline.md');

  // Ensure data directory exists
  const dataDir = resolve(__dirname, 'profiles', profileName, 'data');
  if (!existsSync(dataDir)) {
    await mkdir(dataDir, { recursive: true });
  }

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

  // Ensure data directory exists
  const dataDir = resolve(__dirname, 'profiles', profileName, 'data');
  if (!existsSync(dataDir)) {
    await mkdir(dataDir, { recursive: true });
  }

  const lines = [
    ...jobs.map(j => `${j.url}\t${date}\tTelecom:${j.source}\t${j.title}\t${j.company}\tadded`),
    ...skipped.map(s => `${s.url}\t${date}\tTelecom:${s.source}\t${s.title}\t${s.company}\t${s.reason}`),
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
    profileName = match ? match[1] : 'lamin';
  }

  const config = SEARCH_CONFIGS[profileName];
  if (!config) {
    console.error(`Unknown profile: ${profileName}. Available: ${Object.keys(SEARCH_CONFIGS).join(', ')}`);
    process.exit(1);
  }

  if (config.titlePositive.length === 0) {
    console.log(`\n  Telecom Careers Scraper \u2014 Profile: ${profileName}`);
    console.log(`  Profile "${profileName}" has no telecom search config. Skipping.\n`);
    return;
  }

  // Load portals.yml title filter
  const portalFilter = await loadPortalsTitleFilter(profileName);

  console.log(`\n  Telecom Careers Scraper \u2014 Profile: ${profileName}`);
  console.log(`  ${'\u2501'.repeat(50)}`);
  console.log(`  Greenhouse boards: ${GREENHOUSE_BOARDS.length} | Lever boards: ${LEVER_BOARDS.length}`);
  console.log(`  Arbeitnow queries: ${config.arbeitnowQueries.length} | Dry run: ${dryRun}\n`);

  const existingUrls = await loadExistingUrls(profileName);
  console.log(`  Existing URLs loaded: ${existingUrls.size}`);

  const allJobs = [];
  const allSkipped = [];
  const seenCompanyTitle = new Set();
  let totalFound = 0;
  let totalFiltered = 0;
  let totalDuped = 0;
  let sourcesOk = 0;
  let sourcesFailed = 0;

  // --- Greenhouse boards ---
  for (const { board, company, sector } of GREENHOUSE_BOARDS) {
    try {
      console.log(`\n  Fetching Greenhouse: ${company} (${sector})...`);
      const jobs = await fetchGreenhouseJobs(board);
      console.log(`    Found: ${jobs.length} total listings`);
      totalFound += jobs.length;
      sourcesOk++;

      for (const job of jobs) {
        processJob(job, config, portalFilter, existingUrls, seenCompanyTitle, allJobs, allSkipped, { totalFiltered: 0, totalDuped: 0 });
      }

      await sleep(RATE_LIMIT_MS);
    } catch (err) {
      console.error(`    ERROR: ${err.message}`);
      sourcesFailed++;
    }
  }

  // --- Lever boards ---
  for (const { board, company, sector } of LEVER_BOARDS) {
    try {
      console.log(`\n  Fetching Lever: ${company} (${sector})...`);
      const jobs = await fetchLeverJobs(board);
      console.log(`    Found: ${jobs.length} total listings`);
      totalFound += jobs.length;
      sourcesOk++;

      for (const job of jobs) {
        processJob(job, config, portalFilter, existingUrls, seenCompanyTitle, allJobs, allSkipped, { totalFiltered: 0, totalDuped: 0 });
      }

      await sleep(RATE_LIMIT_MS);
    } catch (err) {
      console.error(`    ERROR: ${err.message}`);
      sourcesFailed++;
    }
  }

  // --- Arbeitnow (Germany) ---
  for (const query of config.arbeitnowQueries) {
    try {
      console.log(`\n  Fetching Arbeitnow [DE]: "${query}"...`);
      const jobs = await fetchArbeitnowJobs(query, limit);
      console.log(`    Found: ${jobs.length} results`);
      totalFound += jobs.length;
      sourcesOk++;

      for (const job of jobs) {
        processJob(job, config, portalFilter, existingUrls, seenCompanyTitle, allJobs, allSkipped, { totalFiltered: 0, totalDuped: 0 }, 'arbeitnow');
      }

      await sleep(RATE_LIMIT_MS);
    } catch (err) {
      console.error(`    ERROR: ${err.message}`);
      sourcesFailed++;
    }
  }

  // Recount from skipped arrays (processJob mutates counters via closure)
  totalFiltered = allSkipped.filter(s => s.reason === 'skipped_title' || s.reason === 'skipped_location').length;
  totalDuped = allSkipped.filter(s => s.reason === 'skipped_dup_url' || s.reason === 'skipped_dup_combo').length;

  // Summary
  console.log(`\n  ${'\u2501'.repeat(50)}`);
  console.log(`  Telecom Scan Complete \u2014 ${new Date().toISOString().split('T')[0]}`);
  console.log(`  ${'\u2501'.repeat(50)}`);
  console.log(`  Sources OK:       ${sourcesOk} | Failed: ${sourcesFailed}`);
  console.log(`  Total listings:   ${totalFound}`);
  console.log(`  Filtered:         ${totalFiltered}`);
  console.log(`  Duplicates:       ${totalDuped}`);
  console.log(`  NEW to pipeline:  ${allJobs.length}`);

  if (allJobs.length > 0) {
    console.log(`\n  New jobs:`);
    for (const job of allJobs) {
      const flag = job.source.includes('Arbeitnow') ? '[DE]' : '[US]';
      console.log(`    + ${flag} ${job.company} | ${job.title} | ${job.location}`);
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

function processJob(job, config, portalFilter, existingUrls, seenCompanyTitle, allJobs, allSkipped, _counters, source = '') {
  if (!job.url) return;

  // Dedup against existing pipeline URLs
  if (existingUrls.has(job.url)) {
    allSkipped.push({ url: job.url, title: job.title, company: job.company, source: job.source, reason: 'skipped_dup_url' });
    return;
  }

  // Dedup by company+title combo
  const companyTitleKey = `${job.company.toLowerCase().trim()}||${job.title.toLowerCase().trim()}`;
  if (seenCompanyTitle.has(companyTitleKey)) {
    allSkipped.push({ url: job.url, title: job.title, company: job.company, source: job.source, reason: 'skipped_dup_combo' });
    return;
  }
  seenCompanyTitle.add(companyTitleKey);

  // Title filter
  if (!matchesTitle(job.title, config, portalFilter)) {
    allSkipped.push({ url: job.url, title: job.title, company: job.company, source: job.source, reason: 'skipped_title' });
    return;
  }

  // Location filter
  if (!matchesLocation(job.location, config, source)) {
    allSkipped.push({ url: job.url, title: job.title, company: job.company, source: job.source, reason: 'skipped_location' });
    return;
  }

  allJobs.push({
    url: job.url,
    title: job.title,
    company: job.company,
    location: job.location,
    source: job.source,
  });
  existingUrls.add(job.url);
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
