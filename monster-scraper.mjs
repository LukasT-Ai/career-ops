#!/usr/bin/env node

/**
 * monster-scraper.mjs — Monster.com / Monster.de Job Scraper
 *
 * Uses Playwright to scrape server-rendered job listings from Monster.
 * Supports both US (monster.com) and DE (monster.de) sites.
 *
 * Usage:
 *   node monster-scraper.mjs [--profile=paulina|lamin] [--dry-run] [--limit=25]
 *
 * Without --profile, reads profiles/active.yml to determine which profile to scan.
 *
 * Rate limiting: 4-7 second delays between pages, max 3 pages per query.
 */

import { readFile, writeFile, appendFile, mkdir } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================
// Configuration
// ============================================================

const DELAY_MIN_MS = 4000;
const DELAY_MAX_MS = 7000;
const MAX_RESULTS_PER_QUERY = 25;
const MAX_PAGES_PER_QUERY = 3;

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
      { keywords: 'Psychiatrist', location: 'Georgia', country: 'us', label: 'Psychiatrist GA' },
      { keywords: 'Mental Health Physician', location: 'Georgia', country: 'us', label: 'Mental Health Physician GA' },
      { keywords: 'Behavioral Health Physician', location: 'Georgia', country: 'us', label: 'Behavioral Health Physician GA' },
      // US — California
      { keywords: 'Psychiatrist', location: 'California', country: 'us', label: 'Psychiatrist CA' },
      { keywords: 'Mental Health Physician', location: 'California', country: 'us', label: 'Mental Health Physician CA' },
      // Germany
      { keywords: 'Psychiatrist', location: 'Germany', country: 'de', label: 'Psychiatrist DE' },
      { keywords: 'Facharzt Psychiatrie', location: '', country: 'de', label: 'Facharzt Psychiatrie DE' },
      { keywords: 'Oberarzt Psychiatrie', location: '', country: 'de', label: 'Oberarzt Psychiatrie DE' },
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
      { keywords: 'Sales Manager', location: 'Atlanta', country: 'us', label: 'Sales Manager Atlanta' },
      { keywords: 'Account Manager Telecom', location: 'Atlanta', country: 'us', label: 'Account Manager Telecom Atlanta' },
      { keywords: 'B2B Sales', location: 'Atlanta', country: 'us', label: 'B2B Sales Atlanta' },
      { keywords: 'Enterprise Sales', location: 'Atlanta', country: 'us', label: 'Enterprise Sales Atlanta' },
      { keywords: 'Sales Manager', location: 'Germany', country: 'de', label: 'Sales Manager DE' },
      { keywords: 'Account Manager Telekommunikation', location: 'Germany', country: 'de', label: 'Account Manager Telekom DE' },
      { keywords: 'Vertrieb Telekommunikation', location: 'Germany', country: 'de', label: 'Vertrieb Telekom DE' },
      { keywords: 'Key Account Manager', location: 'Germany', country: 'de', label: 'Key Account Manager DE' },
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

function buildMonsterUrl(keywords, location, page, country) {
  const encodedKw = encodeURIComponent(keywords);
  const encodedLoc = encodeURIComponent(location);
  if (country === 'de') {
    // Monster.de uses /jobs/suche/ path with stellen query
    return `https://www.monster.de/jobs/suche/?q=${encodedKw}&where=${encodedLoc}&page=${page}&so=m.h.s`;
  }
  return `https://www.monster.com/jobs/search?q=${encodedKw}&where=${encodedLoc}&page=${page}`;
}

// ============================================================
// Monster Scraper
// ============================================================

async function scrapeMonsterQuery(page, keywords, location, country, maxResults) {
  const jobs = [];
  const pagesToFetch = Math.min(MAX_PAGES_PER_QUERY, Math.ceil(maxResults / 25));

  for (let p = 1; p <= pagesToFetch; p++) {
    const url = buildMonsterUrl(keywords, location, p, country);

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

      // Wait briefly for any client-side hydration
      await sleep(1500);

      // Extract job cards using multiple selectors (Monster redesigns frequently)
      const pageJobs = await page.evaluate((ctry) => {
        const results = [];
        const cards = document.querySelectorAll(
          '[data-testid="svx-job-card"], .job-cardstyle__JobCardComponent, [class*="JobCard"], article[data-testid], .results-card, [class*="job-card"], [class*="job_card"], [class*="jobCard"], [data-testid*="job"], .card-content'
        );

        for (const card of cards) {
          try {
            // Title: look for h2/a link inside the card
            const titleLink = card.querySelector('h2 a, h3 a, [data-testid="jobTitle"] a, a[data-testid="jobTitle"], a[href*="/job-openings/"], a[href*="/stellenangebot/"]');
            const titleEl = card.querySelector('h2, h3, [data-testid="jobTitle"]');

            const title = titleLink ? titleLink.textContent.trim()
              : titleEl ? titleEl.textContent.trim()
              : null;

            let href = titleLink ? titleLink.getAttribute('href') : null;
            if (!href) {
              // Fallback: any link in the card that looks like a job URL
              const fallbackLink = card.querySelector('a[href*="/job-openings/"], a[href*="/stellenangebot/"], a[href*="/job/"]');
              href = fallbackLink ? fallbackLink.getAttribute('href') : null;
            }

            if (!title || !href) continue;

            // Normalize URL
            if (href.startsWith('/')) {
              const base = ctry === 'de' ? 'https://www.monster.de' : 'https://www.monster.com';
              href = base + href;
            }

            // Company
            const companyEl = card.querySelector('[data-testid="company"], .company-name, [class*="company"], [class*="Company"]');
            const company = companyEl ? companyEl.textContent.trim() : 'Unknown';

            // Location
            const locationEl = card.querySelector('[data-testid="jobLocation"], .job-location, [class*="location"], [class*="Location"]');
            const loc = locationEl ? locationEl.textContent.trim() : '';

            // Salary (often not present)
            const salaryEl = card.querySelector('[data-testid="jobSalary"], .salary, [class*="salary"], [class*="Salary"]');
            const salary = salaryEl ? salaryEl.textContent.trim() : null;

            results.push({ title, company, location: loc, url: href, salary });
          } catch {
            continue;
          }
        }
        return results;
      }, country);

      if (pageJobs.length === 0) {
        console.log(`    Page ${p}: no cards found, stopping pagination`);
        break;
      }

      console.log(`    Page ${p}: ${pageJobs.length} cards`);
      jobs.push(...pageJobs);

      // Stop if we have enough
      if (jobs.length >= maxResults) break;

      // Rate limiting between pages
      if (p < pagesToFetch) {
        await sleep(randomDelay());
      }
    } catch (err) {
      console.error(`    Page ${p} failed: ${err.message}`);
      break;
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
    ...jobs.map(j => `${j.url}\t${date}\tMonster: ${j.queryLabel}\t${j.title}\t${j.company}\tadded`),
    ...skipped.map(s => `${s.url}\t${date}\tMonster: ${s.queryLabel}\t${s.title}\t${s.company}\t${s.reason}`),
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

  console.log(`\n  Monster Scraper \u2014 Profile: ${profileName}`);
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

  // Block images, fonts, and analytics for speed
  await context.route('**/*', (route) => {
    const resourceType = route.request().resourceType();
    if (['image', 'font', 'media'].includes(resourceType)) {
      return route.abort();
    }
    const url = route.request().url();
    if (url.includes('google-analytics') || url.includes('googletagmanager') || url.includes('doubleclick') || url.includes('facebook.net') || url.includes('hotjar')) {
      return route.abort();
    }
    return route.continue();
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
        console.log(`\n  Searching: "${query.keywords}" in ${query.location} (${query.country.toUpperCase()})...`);

        const jobs = await scrapeMonsterQuery(page, query.keywords, query.location, query.country, limit);
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
  console.log(`  Monster Scan Complete \u2014 ${new Date().toISOString().split('T')[0]}`);
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
