#!/usr/bin/env node

/**
 * linkedin-scraper.mjs — LinkedIn Jobs Scraper (Guest API)
 *
 * Uses LinkedIn's public guest job search API (no login required).
 * Playwright renders the HTML fragments and extracts job cards.
 *
 * Usage:
 *   node linkedin-scraper.mjs [--profile=paulina|lamin] [--dry-run] [--limit=25]
 *
 * Without --profile, reads profiles/active.yml to determine which profile to scan.
 *
 * Rate limiting: 3-5 second delays between requests, max 25 results per query.
 */

import { readFile, writeFile, appendFile, mkdir } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================
// Configuration
// ============================================================

const DELAY_MIN_MS = 3000;
const DELAY_MAX_MS = 5000;
const MAX_RESULTS_PER_QUERY = 25;
const RESULTS_PER_PAGE = 25; // LinkedIn returns 25 per page

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
];

// ============================================================
// Search Profiles
// ============================================================

const SEARCH_CONFIGS = {
  paulina: {
    queries: [
      // US — Georgia
      { keywords: 'Psychiatrist', location: 'Georgia', label: 'Psychiatrist GA' },
      { keywords: 'Mental Health Physician', location: 'Georgia', label: 'Mental Health Physician GA' },
      { keywords: 'Behavioral Health Physician', location: 'Georgia', label: 'Behavioral Health Physician GA' },
      // US — California
      { keywords: 'Psychiatrist', location: 'California', label: 'Psychiatrist CA' },
      { keywords: 'Mental Health Physician', location: 'California', label: 'Mental Health Physician CA' },
      // Germany
      { keywords: 'Psychiatrist', location: 'Germany', label: 'Psychiatrist DE' },
      { keywords: 'Facharzt Psychiatrie', location: 'Germany', label: 'Facharzt Psychiatrie DE' },
      { keywords: 'Oberarzt Psychiatrie', location: 'Germany', label: 'Oberarzt Psychiatrie DE' },
    ],
    titlePositive: [
      'psychiatr', 'physician', 'medical director', 'behavioral health', 'mental health',
      'attending', 'clinical director', 'medical officer', 'facharzt', 'oberarzt',
      'chefarzt', 'arzt', 'doctor',
    ],
    titleNegative: [
      'nurse', 'nursing', 'social worker', 'psycholog', 'counselor', 'technician',
      'administrative', 'clerk', 'secretary', 'custodian', 'housekeep', 'aide',
      'receptionist', 'billing', 'coder', 'cna', 'lpn', 'rn',
      'praktikum', 'werkstudent', 'krankenpfleger', 'pflegekraft', 'therapeut',
    ],
  },

  lamin: {
    queries: [
      { keywords: 'Sales Manager', location: 'Atlanta', label: 'Sales Manager Atlanta' },
      { keywords: 'Account Manager Telecom', location: 'Atlanta', label: 'Account Manager Telecom Atlanta' },
      { keywords: 'B2B Sales', location: 'Atlanta', label: 'B2B Sales Atlanta' },
      { keywords: 'Enterprise Sales', location: 'Atlanta', label: 'Enterprise Sales Atlanta' },
      { keywords: 'Sales Manager', location: 'Germany', label: 'Sales Manager Germany' },
      { keywords: 'Account Manager Telekommunikation', location: 'Germany', label: 'Account Manager Telekom DE' },
      { keywords: 'Vertrieb Telekommunikation', location: 'Germany', label: 'Vertrieb Telekom DE' },
    ],
    titlePositive: [
      'sales', 'account', 'vertrieb', 'business development', 'telecom', 'telekommunikation',
      'b2b', 'enterprise', 'key account', 'channel', 'partner', 'ucaas', 'sd-wan',
      'managed services', 'commercial', 'revenue', 'kundenberater',
    ],
    titleNegative: [
      'intern', 'student', 'trainee', 'praktikum', 'werkstudent', 'azubi', 'ausbildung',
      'custodian', 'maintenance', 'janitor', 'nurse', 'physician', 'driver',
      'warehouse', 'cashier', 'retail associate', 'food service', 'barista',
      'call center agent', 'callcenter',
    ],
  },
};

// ============================================================
// Helpers
// ============================================================

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function randomDelay() {
  return DELAY_MIN_MS + Math.random() * (DELAY_MAX_MS - DELAY_MIN_MS);
}

function randomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
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
// LinkedIn Guest API Scraper
// ============================================================

async function scrapeLinkedInQuery(page, keywords, location, maxResults) {
  const jobs = [];
  const encoded_kw = encodeURIComponent(keywords);
  const encoded_loc = encodeURIComponent(location);

  // LinkedIn guest API paginates by start offset (0, 25, 50, ...)
  const pagesToFetch = Math.ceil(maxResults / RESULTS_PER_PAGE);

  for (let p = 0; p < pagesToFetch; p++) {
    const offset = p * RESULTS_PER_PAGE;
    const url = `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=${encoded_kw}&location=${encoded_loc}&start=${offset}`;

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

      // The response is HTML fragments with <li> job cards
      const cards = await page.$$('li');

      if (cards.length === 0) break; // No more results

      for (const card of cards) {
        try {
          // Extract job data from each card
          const titleEl = await card.$('.base-search-card__title');
          const companyEl = await card.$('.base-search-card__subtitle a, .base-search-card__subtitle');
          const locationEl = await card.$('.job-search-card__location');
          const linkEl = await card.$('a.base-card__full-link, a[href*="/jobs/view/"]');

          const title = titleEl ? (await titleEl.textContent()).trim() : null;
          const company = companyEl ? (await companyEl.textContent()).trim() : null;
          const location = locationEl ? (await locationEl.textContent()).trim() : null;
          const href = linkEl ? await linkEl.getAttribute('href') : null;

          if (!title || !href) continue;

          // Normalize LinkedIn URL — strip tracking params
          let jobUrl = href.split('?')[0].trim();
          if (!jobUrl.startsWith('http')) {
            jobUrl = `https://www.linkedin.com${jobUrl}`;
          }

          jobs.push({
            title,
            company: company || 'Unknown',
            location: location || '',
            url: jobUrl,
            salary: null,
          });
        } catch {
          // Skip individual card parsing errors
          continue;
        }
      }

      // Stop if we got fewer than a full page (no more results)
      if (cards.length < RESULTS_PER_PAGE) break;

      // Rate limiting between pages
      if (p < pagesToFetch - 1) {
        await sleep(randomDelay());
      }
    } catch (err) {
      console.error(`    Page ${p + 1} failed: ${err.message}`);
      break; // Skip remaining pages for this query
    }
  }

  return jobs.slice(0, maxResults);
}

// ============================================================
// Pipeline Integration
// ============================================================

async function loadExistingUrls(profileName) {
  const urls = new Set();
  const companyTitleKeys = new Set();
  const profileDir = resolve(__dirname, 'profiles', profileName, 'data');

  // Profile-specific pipeline
  try {
    const pipeline = await readFile(resolve(profileDir, 'pipeline.md'), 'utf8');
    for (const match of pipeline.matchAll(/https?:\/\/[^\s|)]+/g)) {
      urls.add(match[0]);
    }
  } catch { /* no pipeline yet */ }

  // Profile-specific applications
  try {
    const apps = await readFile(resolve(profileDir, 'applications.md'), 'utf8');
    for (const match of apps.matchAll(/https?:\/\/[^\s|)]+/g)) {
      urls.add(match[0]);
    }
  } catch { /* no tracker yet */ }

  // Profile-specific scan history
  try {
    const history = await readFile(resolve(profileDir, 'scan-history.tsv'), 'utf8');
    for (const match of history.matchAll(/https?:\/\/[^\s\t]+/g)) {
      urls.add(match[0]);
    }
  } catch { /* no history yet */ }

  // Root pipeline for cross-dedup
  try {
    const rootPipeline = await readFile(resolve(__dirname, 'data/pipeline.md'), 'utf8');
    for (const match of rootPipeline.matchAll(/https?:\/\/[^\s|)]+/g)) {
      urls.add(match[0]);
    }
  } catch { /* ok */ }

  return { urls, companyTitleKeys };
}

async function appendToPipeline(jobs, profileName) {
  if (jobs.length === 0) return;

  const lines = jobs.map(j => {
    const locationPart = j.location ? ` \u2014 ${j.location}` : '';
    const salaryPart = j.salary || 'Not disclosed';
    return `- [ ] ${j.url} | ${j.company} | ${j.title}${locationPart} | ${salaryPart}`;
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
    await mkdir(resolve(__dirname, 'profiles', profileName, 'data'), { recursive: true });
    await writeFile(pipelinePath, `# Pipeline \u2014 Pending URLs\n\n## Pendientes\n\n${lines}\n`, 'utf8');
  }
}

async function appendToScanHistory(jobs, skipped, profileName) {
  const historyPath = resolve(__dirname, 'profiles', profileName, 'data', 'scan-history.tsv');
  const date = new Date().toISOString().split('T')[0];

  const lines = [
    ...jobs.map(j => `${j.url}\t${date}\tLinkedIn: ${j.queryLabel}\t${j.title}\t${j.company}\tadded`),
    ...skipped.map(s => `${s.url}\t${date}\tLinkedIn: ${s.queryLabel}\t${s.title}\t${s.company}\t${s.reason}`),
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
// Main
// ============================================================

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const limitArg = args.find(a => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1]) : MAX_RESULTS_PER_QUERY;
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

  console.log(`\n  LinkedIn Scraper \u2014 Profile: ${profileName}`);
  console.log(`  ${'\u2501'.repeat(50)}`);
  console.log(`  Queries: ${config.queries.length} | Max results: ${limit}/query | Dry run: ${dryRun}\n`);

  const { urls: existingUrls } = await loadExistingUrls(profileName);
  console.log(`  Existing URLs loaded: ${existingUrls.size}`);

  // Launch browser
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext({
    userAgent: randomUA(),
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
  });

  const page = await context.newPage();

  const allJobs = [];
  const allSkipped = [];
  const seenCompanyTitle = new Set();
  let totalFound = 0;
  let totalFiltered = 0;
  let totalDuped = 0;

  try {
    for (const query of config.queries) {
      try {
        console.log(`\n  Searching: "${query.keywords}" in ${query.location}...`);

        const jobs = await scrapeLinkedInQuery(page, query.keywords, query.location, limit);
        console.log(`    Found: ${jobs.length} results`);
        totalFound += jobs.length;

        for (const job of jobs) {
          // Dedup by URL
          if (existingUrls.has(job.url)) {
            totalDuped++;
            allSkipped.push({ url: job.url, title: job.title, company: job.company, queryLabel: query.label, reason: 'skipped_dup_url' });
            continue;
          }

          // Dedup by company+title combo
          const companyTitleKey = `${job.company.toLowerCase().trim()}||${job.title.toLowerCase().trim()}`;
          if (seenCompanyTitle.has(companyTitleKey)) {
            totalDuped++;
            allSkipped.push({ url: job.url, title: job.title, company: job.company, queryLabel: query.label, reason: 'skipped_dup_combo' });
            continue;
          }
          seenCompanyTitle.add(companyTitleKey);

          // Title filter
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
        }

        // Rate limiting between queries
        await sleep(randomDelay());
      } catch (err) {
        console.error(`    ERROR: ${err.message}`);
      }
    }
  } finally {
    await browser.close();
  }

  // Summary
  console.log(`\n  ${'\u2501'.repeat(50)}`);
  console.log(`  LinkedIn Scan Complete \u2014 ${new Date().toISOString().split('T')[0]}`);
  console.log(`  ${'\u2501'.repeat(50)}`);
  console.log(`  Queries executed: ${config.queries.length}`);
  console.log(`  Total results:    ${totalFound}`);
  console.log(`  Filtered (title): ${totalFiltered}`);
  console.log(`  Duplicates:       ${totalDuped}`);
  console.log(`  NEW to pipeline:  ${allJobs.length}`);

  if (allJobs.length > 0) {
    console.log(`\n  New jobs:`);
    for (const job of allJobs) {
      console.log(`    + ${job.company} | ${job.title} | ${job.location}`);
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
