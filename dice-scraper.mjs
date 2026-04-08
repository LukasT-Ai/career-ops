#!/usr/bin/env node

/**
 * dice-scraper.mjs — Dice.com Job Board Scraper
 *
 * Scrapes Dice.com — major US job board, strong in tech/telecom/enterprise.
 * Works via plain HTTP fetch — no Playwright needed.
 *
 * ADDITIVE source — supplements existing scrapers.
 *
 * Usage:
 *   node dice-scraper.mjs [--profile=paulina|lamin] [--dry-run] [--limit=20]
 *
 * Without --profile, reads profiles/active.yml to determine which profile to scan.
 *
 * Rate limiting: 3s between requests.
 * Max 2 pages per query (20 jobs/page).
 */

import { readFile, writeFile, appendFile } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================
// Configuration
// ============================================================

const BASE_URL = 'https://www.dice.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const RATE_LIMIT_MS = 3000;
const MAX_PAGES = 2; // 20 jobs/page

// ============================================================
// Search Profiles
// ============================================================

const SEARCH_CONFIGS = {
  paulina: {
    searches: [
      { query: 'psychiatrist', location: 'Atlanta, GA', label: 'Psychiatrist Atlanta' },
      { query: 'telepsychiatrist', location: '', label: 'Telepsychiatrist Remote' },
      { query: 'medical director behavioral health', location: 'Georgia', label: 'Medical Director BH GA' },
      { query: 'psychiatrist', location: 'California', label: 'Psychiatrist CA' },
    ],
    titlePositive: [
      'psychiatr', 'physician', 'medical director', 'behavioral health', 'mental health',
      'attending', 'clinical director', 'medical officer',
    ],
    titleNegative: [
      'nurse', 'nursing', 'social worker', 'psycholog', 'counselor', 'technician',
      'administrative', 'clerk', 'secretary', 'custodian', 'aide',
      'receptionist', 'billing', 'cna', 'lpn', 'rn', 'pharmacy',
    ],
  },

  lamin: {
    searches: [
      { query: 'sales manager telecom', location: 'Atlanta, GA', label: 'Sales Manager Telecom Atlanta' },
      { query: 'account manager', location: 'Atlanta, GA', label: 'Account Manager Atlanta' },
      { query: 'B2B sales manager', location: 'Atlanta, GA', label: 'B2B Sales Manager Atlanta' },
      { query: 'account executive telecom', location: 'Atlanta, GA', label: 'AE Telecom Atlanta' },
      { query: 'sales manager telecommunications', location: '', label: 'Sales Manager Telecom Remote' },
      { query: 'enterprise sales telecom', location: '', label: 'Enterprise Sales Telecom Remote' },
    ],
    titlePositive: [
      'sales', 'account', 'business development', 'telecom', 'telecommunication',
      'b2b', 'enterprise', 'key account', 'channel', 'partner', 'ucaas', 'sd-wan',
      'managed services', 'commercial', 'revenue',
    ],
    titleNegative: [
      'intern', 'student', 'trainee',
      'custodian', 'maintenance', 'janitor', 'nurse', 'physician', 'driver',
      'warehouse', 'cashier', 'retail associate', 'food service', 'barista',
      'call center agent',
    ],
  },
};

// ============================================================
// Scraper
// ============================================================

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function buildSearchUrl(query, location, page = 1) {
  const params = new URLSearchParams({ q: query });
  if (location) params.set('location', location);
  if (page > 1) params.set('page', String(page));
  params.set('countryCode', 'US');
  return `${BASE_URL}/jobs?${params}`;
}

async function fetchPage(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  if (res.status === 429) {
    throw new Error('Dice rate limit hit (429)');
  }
  if (res.status === 403) {
    throw new Error('Dice blocked request (403)');
  }
  if (!res.ok) {
    throw new Error(`Dice ${res.status}: ${url}`);
  }

  return res.text();
}

function parseJobsFromHtml(html) {
  const jobs = [];

  // Split by job-card
  const cards = html.split(/data-testid="job-card"/);

  for (let i = 1; i < cards.length; i++) {
    const card = cards[i];

    // URL: full dice.com URL from the detail link
    const urlMatch = card.match(/href="(https:\/\/www\.dice\.com\/job-detail\/[^"]+)"/);
    if (!urlMatch) continue;
    const url = urlMatch[1];

    // Title: from aria-label on the detail link
    const titleMatch = card.match(/data-testid="job-search-job-detail-link"[^>]*aria-label="([^"]+)"/);
    let title = titleMatch ? titleMatch[1] : '';
    if (!title) {
      // Try the card-level aria-label
      const cardTitle = card.match(/aria-label="View Details for ([^"]+?)(?:\s*\([a-f0-9]+\))?"/);
      title = cardTitle ? cardTitle[1] : '';
    }
    if (!title) {
      // Try text content of the detail link
      const linkText = card.match(/data-testid="job-search-job-detail-link"[^>]*>([^<]+)</);
      title = linkText ? linkText[1] : 'Unknown Title';
    }

    // Company: from img alt or <p> near company logo
    let company = '';
    const imgAlt = card.match(/alt="([^"]+)"\s*\/>\s*<\/div>/);
    if (imgAlt) company = imgAlt[1];
    if (!company) {
      // Company name in <p> after company profile link
      const compP = card.match(/companyname=[^"]*"[^>]*><p[^>]*>([^<]+)<\/p>/);
      if (compP) company = compP[1];
    }
    if (!company) company = 'Unknown';

    // Location: <p> with location text (Remote, city, etc.)
    let location = '';
    const locMatch = card.match(/aria-label="Details for[^"]*"[\s\S]*?<p[^>]*>([^<]+)<\/p>/);
    if (locMatch && !locMatch[1].includes('ago') && !locMatch[1].includes('Apply')) {
      location = locMatch[1];
    }

    // Salary: from id="salary-label"
    let salary = 'Not disclosed';
    const salaryMatch = card.match(/id="salary-label"[^>]*>([^<]+)/);
    if (salaryMatch) salary = salaryMatch[1].trim();

    jobs.push({
      url,
      title: title.trim(),
      company: company.trim(),
      location: location.trim(),
      salary,
    });
  }

  return jobs;
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
// Pipeline Integration
// ============================================================

async function loadExistingUrls(profileName) {
  const urls = new Set();
  const profileDir = resolve(__dirname, 'profiles', profileName, 'data');

  try {
    const pipeline = await readFile(resolve(profileDir, 'pipeline.md'), 'utf8');
    for (const match of pipeline.matchAll(/https?:\/\/[^\s|)]+/g)) urls.add(match[0]);
  } catch { /* ok */ }

  try {
    const apps = await readFile(resolve(profileDir, 'applications.md'), 'utf8');
    for (const match of apps.matchAll(/https?:\/\/[^\s|)]+/g)) urls.add(match[0]);
  } catch { /* ok */ }

  try {
    const history = await readFile(resolve(profileDir, 'scan-history.tsv'), 'utf8');
    for (const match of history.matchAll(/https?:\/\/[^\s\t]+/g)) urls.add(match[0]);
  } catch { /* ok */ }

  try {
    const rootPipeline = await readFile(resolve(__dirname, 'data/pipeline.md'), 'utf8');
    for (const match of rootPipeline.matchAll(/https?:\/\/[^\s|)]+/g)) urls.add(match[0]);
  } catch { /* ok */ }

  return urls;
}

async function appendToPipeline(jobs, profileName) {
  if (jobs.length === 0) return;

  const lines = jobs.map(j => {
    const locationPart = j.location ? ` \u2014 ${j.location}` : '';
    return `- [ ] ${j.url} | ${j.company} | ${j.title}${locationPart} | ${j.salary}`;
  }).join('\n');

  const pipelinePath = resolve(__dirname, 'profiles', profileName, 'data', 'pipeline.md');

  try {
    const existing = await readFile(pipelinePath, 'utf8');
    if (existing.includes('## Pendientes')) {
      const updated = existing.replace('## Pendientes\n', `## Pendientes\n\n${lines}\n`);
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
    ...jobs.map(j => `${j.url}\t${date}\tDice: ${j.queryLabel}\t${j.title}\t${j.company}\tadded`),
    ...skipped.map(s => `${s.url}\t${date}\tDice: ${s.queryLabel}\t${s.title}\t${s.company}\t${s.reason}`),
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
  const maxPerQuery = limitArg ? parseInt(limitArg.split('=')[1]) : 20;
  const profileArg = args.find(a => a.startsWith('--profile='));

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

  console.log(`\n  Dice.com Scraper \u2014 Profile: ${profileName}`);
  console.log(`  ${'━'.repeat(50)}`);
  console.log(`  Queries: ${config.searches.length} | Max pages: ${MAX_PAGES} | Dry run: ${dryRun}\n`);

  const existingUrls = await loadExistingUrls(profileName);
  console.log(`  Existing URLs loaded: ${existingUrls.size}`);

  const allJobs = [];
  const allSkipped = [];
  const seenCompanyTitle = new Set();
  let totalFound = 0;
  let totalFiltered = 0;
  let totalDuped = 0;

  for (const query of config.searches) {
    try {
      console.log(`\n  Searching: "${query.query}"${query.location ? ` in ${query.location}` : ' (remote/national)'}...`);

      let queryJobs = 0;
      for (let page = 1; page <= MAX_PAGES; page++) {
        const url = buildSearchUrl(query.query, query.location, page);
        const html = await fetchPage(url);

        // Get total count on first page
        if (page === 1) {
          const countMatch = html.match(/(\d[\d,]*)\s*results/);
          const total = countMatch ? countMatch[1] : '?';
          console.log(`    Found: ${total} total results`);
        }

        const jobs = parseJobsFromHtml(html);
        if (jobs.length === 0) break;

        for (const job of jobs) {
          if (!job.url) continue;
          totalFound++;

          if (existingUrls.has(job.url)) {
            totalDuped++;
            allSkipped.push({ url: job.url, title: job.title, company: job.company, queryLabel: query.label, reason: 'skipped_dup_url' });
            continue;
          }

          const companyTitleKey = `${job.company.toLowerCase().trim()}||${job.title.toLowerCase().trim()}`;
          if (seenCompanyTitle.has(companyTitleKey)) {
            totalDuped++;
            allSkipped.push({ url: job.url, title: job.title, company: job.company, queryLabel: query.label, reason: 'skipped_dup_combo' });
            continue;
          }
          seenCompanyTitle.add(companyTitleKey);

          if (!matchesTitle(job.title, config)) {
            totalFiltered++;
            allSkipped.push({ url: job.url, title: job.title, company: job.company, queryLabel: query.label, reason: 'skipped_title' });
            continue;
          }

          allJobs.push({
            url: job.url,
            title: job.title,
            company: job.company,
            location: job.location,
            salary: job.salary,
            queryLabel: query.label,
          });
          existingUrls.add(job.url);
          queryJobs++;
        }

        await sleep(RATE_LIMIT_MS);
        if (queryJobs >= maxPerQuery) break;
      }
    } catch (err) {
      console.error(`    ERROR: ${err.message}`);
      if (err.message.includes('429') || err.message.includes('403')) {
        console.error(`    Blocked — stopping Dice scan.`);
        break;
      }
    }
  }

  // Summary
  console.log(`\n  ${'━'.repeat(50)}`);
  console.log(`  Dice Scan Complete \u2014 ${new Date().toISOString().split('T')[0]}`);
  console.log(`  ${'━'.repeat(50)}`);
  console.log(`  Queries executed: ${config.searches.length}`);
  console.log(`  Total results:    ${totalFound}`);
  console.log(`  Filtered:         ${totalFiltered}`);
  console.log(`  Duplicates:       ${totalDuped}`);
  console.log(`  NEW to pipeline:  ${allJobs.length}`);

  if (allJobs.length > 0) {
    console.log(`\n  New jobs:`);
    for (const job of allJobs) {
      const loc = job.location || 'US';
      const sal = job.salary !== 'Not disclosed' ? ` | ${job.salary}` : '';
      console.log(`    + [US] ${job.company} | ${job.title} | ${loc}${sal}`);
    }
  }

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
