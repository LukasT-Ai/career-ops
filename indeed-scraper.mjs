#!/usr/bin/env node

/**
 * indeed-scraper.mjs — Indeed Jobs Scraper
 *
 * Uses Playwright to scrape Indeed job listings from indeed.com (US) and
 * de.indeed.com (Germany). Headless Chromium with realistic behavior.
 *
 * Usage:
 *   node indeed-scraper.mjs [--profile=paulina|lamin] [--dry-run] [--limit=25]
 *
 * Without --profile, reads profiles/active.yml to determine which profile to scan.
 *
 * Rate limiting: 5 second delays between pages, max 2-3 pages per query.
 */

import { readFile, writeFile, appendFile, mkdir } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================
// Configuration
// ============================================================

const DELAY_MIN_MS = 6000;
const DELAY_MAX_MS = 12000;
const MAX_RESULTS_PER_QUERY = 25;
const RESULTS_PER_PAGE = 15; // Indeed shows ~15 per page
const MAX_PAGES_PER_QUERY = 2; // Stay conservative to avoid blocks

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
      { keywords: 'Psychiatrist', location: '', country: 'de', label: 'Psychiatrist DE' },
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
      { keywords: 'Sales Manager', location: 'Atlanta, GA', country: 'us', label: 'Sales Manager Atlanta' },
      { keywords: 'Account Manager Telecom', location: 'Atlanta, GA', country: 'us', label: 'Account Manager Telecom Atlanta' },
      { keywords: 'B2B Sales', location: 'Atlanta, GA', country: 'us', label: 'B2B Sales Atlanta' },
      { keywords: 'Enterprise Sales', location: 'Atlanta, GA', country: 'us', label: 'Enterprise Sales Atlanta' },
      { keywords: 'Sales Manager', location: 'Germany', country: 'de', label: 'Sales Manager Germany' },
      { keywords: 'Account Manager Telekommunikation', location: '', country: 'de', label: 'Account Manager Telekom DE' },
      { keywords: 'Vertrieb Telekommunikation', location: '', country: 'de', label: 'Vertrieb Telekom DE' },
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

function buildIndeedUrl(keywords, location, country, offset) {
  const base = country === 'de' ? 'https://de.indeed.com/jobs' : 'https://www.indeed.com/jobs';
  const params = new URLSearchParams();
  params.set('q', keywords);
  if (location) params.set('l', location);
  params.set('sort', 'date');
  if (offset > 0) params.set('start', String(offset));
  return `${base}?${params}`;
}

// ============================================================
// Indeed Scraper
// ============================================================

async function scrapeIndeedQuery(page, keywords, location, country, maxResults) {
  const jobs = [];
  const maxPages = Math.min(MAX_PAGES_PER_QUERY, Math.ceil(maxResults / RESULTS_PER_PAGE));

  for (let p = 0; p < maxPages; p++) {
    const offset = p * 10; // Indeed uses start=0, 10, 20...
    const url = buildIndeedUrl(keywords, location, country, offset);

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

      // Dismiss cookie consent banners if present
      try {
        const cookieBtn = await page.$('#onetrust-accept-btn-handler, [id*="cookie"] button, [class*="cookie"] button');
        if (cookieBtn) await cookieBtn.click();
      } catch {}

      // Wait for job cards to render
      try {
        await page.waitForSelector('[class*="job_seen_beacon"], [class*="jobsearch-ResultsList"] li, .resultContent, .job_seen_beacon', { timeout: 10000 });
      } catch {
        // Page loaded but no results selector found — might be empty or blocked
        console.log(`    Page ${p + 1}: no job cards found (empty results or anti-bot)`);
        break;
      }

      // Simulate human scroll behavior before extracting data
      await page.evaluate(() => window.scrollTo(0, Math.random() * 1000));
      await sleep(1000 + Math.random() * 2000);

      // Indeed uses various card structures — try multiple selectors
      const cardData = await page.evaluate(() => {
        const results = [];

        // Modern Indeed layout: job cards inside result divs
        const cards = document.querySelectorAll('.job_seen_beacon, [class*="cardOutline"], .resultContent, [data-jk]');

        for (const card of cards) {
          try {
            // Title — look for the main job title link
            const titleEl = card.querySelector('h2 a, h2 span[title], .jobTitle a, .jobTitle span, a[data-jk]');
            const title = titleEl?.textContent?.trim() || titleEl?.getAttribute('title') || '';

            // Company
            const companyEl = card.querySelector('[data-testid="company-name"], .companyName, .company_location [data-testid="company-name"], span.css-92r8pb');
            const company = companyEl?.textContent?.trim() || '';

            // Location
            const locationEl = card.querySelector('[data-testid="text-location"], .companyLocation, .company_location [data-testid="text-location"]');
            const location = locationEl?.textContent?.trim() || '';

            // Salary (not always present)
            const salaryEl = card.querySelector('[class*="salary"], .salary-snippet, [data-testid="attribute_snippet_testid"], .metadata .attribute_snippet');
            const salary = salaryEl?.textContent?.trim() || null;

            // Job URL — extract the job key
            const linkEl = card.querySelector('h2 a[href], a[data-jk], .jobTitle a[href]');
            let href = linkEl?.getAttribute('href') || '';
            const jk = card.getAttribute('data-jk') || linkEl?.getAttribute('data-jk') || '';

            if (title) {
              results.push({ title, company, location, salary, href, jk });
            }
          } catch {
            // Skip card
          }
        }

        return results;
      });

      if (cardData.length === 0) {
        console.log(`    Page ${p + 1}: 0 cards parsed`);
        break;
      }

      for (const card of cardData) {
        let jobUrl = '';
        if (card.jk) {
          // Construct clean Indeed URL from job key
          const domain = country === 'de' ? 'https://de.indeed.com' : 'https://www.indeed.com';
          jobUrl = `${domain}/viewjob?jk=${card.jk}`;
        } else if (card.href) {
          if (card.href.startsWith('http')) {
            jobUrl = card.href.split('&')[0]; // Strip tracking params
          } else {
            const domain = country === 'de' ? 'https://de.indeed.com' : 'https://www.indeed.com';
            jobUrl = `${domain}${card.href}`.split('&')[0];
          }
        }

        if (!card.title || !jobUrl) continue;

        jobs.push({
          title: card.title,
          company: card.company || 'Unknown',
          location: card.location || '',
          salary: card.salary,
          url: jobUrl,
        });
      }

      console.log(`    Page ${p + 1}: ${cardData.length} cards`);

      // Stop if we have enough
      if (jobs.length >= maxResults) break;

      // Rate limiting between pages
      if (p < maxPages - 1) {
        await sleep(randomDelay());
      }
    } catch (err) {
      console.error(`    Page ${p + 1} failed: ${err.message}`);
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

  return urls;
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
    ...jobs.map(j => `${j.url}\t${date}\tIndeed: ${j.queryLabel}\t${j.title}\t${j.company}\tadded`),
    ...skipped.map(s => `${s.url}\t${date}\tIndeed: ${s.queryLabel}\t${s.title}\t${s.company}\t${s.reason}`),
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

  console.log(`\n  Indeed Scraper \u2014 Profile: ${profileName}`);
  console.log(`  ${'\u2501'.repeat(50)}`);
  console.log(`  Queries: ${config.queries.length} | Max results: ${limit}/query | Dry run: ${dryRun}\n`);

  const existingUrls = await loadExistingUrls(profileName);
  console.log(`  Existing URLs loaded: ${existingUrls.size}`);

  // Launch browser
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const allJobs = [];
  const allSkipped = [];
  const seenCompanyTitle = new Set();
  let totalFound = 0;
  let totalFiltered = 0;
  let totalDuped = 0;

  try {
    for (const query of config.queries) {
      // Create a fresh context per query with randomized fingerprint
      const vpWidth = 1366 + Math.floor(Math.random() * (1920 - 1366));
      const vpHeight = 768 + Math.floor(Math.random() * (1080 - 768));

      const context = await browser.newContext({
        userAgent: randomUA(),
        viewport: { width: vpWidth, height: vpHeight },
        locale: 'en-US',
        extraHTTPHeaders: {
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Referer': 'https://www.google.com/',
        },
      });

      // Stealth: mask automation indicators
      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        window.chrome = { runtime: {} };
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      });

      // Block unnecessary resources for speed
      await context.route('**/*.{png,jpg,jpeg,gif,svg,woff,woff2,ttf,eot}', route => route.abort());
      await context.route('**/analytics**', route => route.abort());
      await context.route('**/tracking**', route => route.abort());

      const page = await context.newPage();

      try {
        const locLabel = query.location ? `in ${query.location}` : '(national)';
        const countryLabel = query.country === 'de' ? '[DE]' : '[US]';
        console.log(`\n  Searching ${countryLabel}: "${query.keywords}" ${locLabel}...`);

        const jobs = await scrapeIndeedQuery(page, query.keywords, query.location, query.country, limit);
        console.log(`    Total: ${jobs.length} results`);
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
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }

  // Summary
  console.log(`\n  ${'\u2501'.repeat(50)}`);
  console.log(`  Indeed Scan Complete \u2014 ${new Date().toISOString().split('T')[0]}`);
  console.log(`  ${'\u2501'.repeat(50)}`);
  console.log(`  Queries executed: ${config.queries.length}`);
  console.log(`  Total results:    ${totalFound}`);
  console.log(`  Filtered (title): ${totalFiltered}`);
  console.log(`  Duplicates:       ${totalDuped}`);
  console.log(`  NEW to pipeline:  ${allJobs.length}`);

  if (allJobs.length > 0) {
    console.log(`\n  New jobs:`);
    for (const job of allJobs) {
      const salaryTag = job.salary ? ` | ${job.salary}` : '';
      console.log(`    + ${job.company} | ${job.title} | ${job.location}${salaryTag}`);
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
