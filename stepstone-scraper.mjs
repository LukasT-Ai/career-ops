#!/usr/bin/env node

/**
 * stepstone-scraper.mjs — StepStone.de Job Board Scraper
 *
 * Scrapes StepStone.de — Germany's #1 paid job board — via plain HTTP fetch.
 * No Playwright needed; StepStone serves full HTML with job data in data-at attributes.
 *
 * ADDITIVE source — supplements existing scrapers. StepStone is the largest
 * German job board and catches listings not found on Bundesagentur/Arbeitnow.
 *
 * Usage:
 *   node stepstone-scraper.mjs [--profile=paulina|lamin] [--dry-run] [--limit=25]
 *
 * Without --profile, reads profiles/active.yml to determine which profile to scan.
 *
 * Rate limiting: 4s between requests to be respectful.
 * Max 2 pages per query to avoid excessive scraping.
 */

import { readFile, writeFile, appendFile } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================
// Configuration
// ============================================================

const BASE_URL = 'https://www.stepstone.de';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Rate limiting: be respectful, 4s between page fetches
const RATE_LIMIT_MS = 4000;
const MAX_PAGES = 2; // Max pages per query (25 jobs/page)

// ============================================================
// Search Profiles
// ============================================================

const SEARCH_CONFIGS = {
  paulina: {
    searches: [
      // StepStone is Germany-focused — Paulina's DE searches
      { what: 'Psychiater', where: '', label: 'Psychiater DE' },
      { what: 'Facharzt Psychiatrie', where: '', label: 'Facharzt Psychiatrie DE' },
      { what: 'Oberarzt Psychiatrie', where: '', label: 'Oberarzt Psychiatrie DE' },
      { what: 'Arzt Psychosomatik', where: '', label: 'Arzt Psychosomatik DE' },
      { what: 'Medical Director Behavioral Health', where: '', label: 'Medical Director BH DE' },
    ],
    titlePositive: [
      'psychiatr', 'facharzt', 'oberarzt', 'chefarzt', 'arzt', 'ärztin',
      'physician', 'medical director', 'behavioral health', 'mental health',
      'psychosomatik', 'klinik',
    ],
    titleNegative: [
      'pflege', 'krankenschwester', 'sozialarbeiter', 'psycholog', 'therapeut',
      'verwaltung', 'sekretär', 'reinigung', 'hauswirtschaft',
      'nurse', 'nursing', 'social worker', 'technician', 'aide',
    ],
  },

  lamin: {
    searches: [
      // Germany — national (StepStone's strength)
      { what: 'Account Manager', where: '', label: 'Account Manager DE' },
      { what: 'Sales Manager Telekommunikation', where: '', label: 'Sales Manager Telekom DE' },
      { what: 'Key Account Manager', where: '', label: 'Key Account Manager DE' },
      { what: 'Vertrieb Telekommunikation', where: '', label: 'Vertrieb Telekom DE' },
      { what: 'Business Development Manager', where: '', label: 'BizDev Manager DE' },
      { what: 'B2B Sales Manager', where: '', label: 'B2B Sales Manager DE' },
      { what: 'Enterprise Sales', where: '', label: 'Enterprise Sales DE' },
    ],
    titlePositive: [
      'sales', 'account', 'vertrieb', 'business development', 'telecom', 'telekommunikation',
      'b2b', 'enterprise', 'key account', 'channel', 'partner', 'ucaas', 'sd-wan',
      'managed services', 'commercial', 'revenue', 'kundenberater', 'außendienst',
    ],
    titleNegative: [
      'intern', 'student', 'trainee', 'praktikum', 'werkstudent', 'azubi', 'ausbildung',
      'pflege', 'reinigung', 'hauswirtschaft', 'fahrer', 'lager',
      'kassier', 'einzelhandel', 'gastronomie', 'barista',
      'callcenter', 'call center',
    ],
  },
};

// ============================================================
// Scraper
// ============================================================

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function buildSearchUrl(what, where, page = 1) {
  // StepStone URL pattern: /jobs/{search-term}/in-{location}?page=N
  const slug = encodeURIComponent(what).replace(/%20/g, '-');
  let url = `${BASE_URL}/jobs/${slug}`;
  if (where) {
    const locSlug = encodeURIComponent(where).replace(/%20/g, '-');
    url += `/in-${locSlug}`;
  }
  if (page > 1) url += `?page=${page}`;
  return url;
}

async function fetchPage(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
    },
  });

  if (res.status === 429) {
    throw new Error('StepStone rate limit hit (429)');
  }
  if (!res.ok) {
    throw new Error(`StepStone ${res.status}: ${url}`);
  }

  return res.text();
}

function parseJobsFromHtml(html) {
  const jobs = [];

  // Split by data-at="job-item-title" — each occurrence is one job card.
  // The href appears just before this attribute in the same <a> tag.
  const chunks = html.split(/data-at="job-item-title"/);

  for (let i = 1; i < chunks.length; i++) {
    const chunk = chunks[i];
    const prev = chunks[i - 1].slice(-600);

    // URL: href in the anchor tag that contains data-at="job-item-title"
    const hrefMatch = prev.match(/href="(\/stellenangebote--([^"]+)\.html)"/);
    if (!hrefMatch) continue;
    const url = `${BASE_URL}${hrefMatch[1]}`;

    // Title: text content after CSS, before </a>
    let title = chunk
      .split('</a>')[0]
      .replace(/<style[^>]*>[\s\S]*?<\/style>/g, '')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    // Clean up leading attributes leak (e.g. 'tabindex="-1">')
    title = title.replace(/^[^>]*>/, '').trim();
    if (!title) title = parseTitleFromSlug(hrefMatch[2]);

    // Company: data-at="job-item-company-name" within this card's chunk
    const compMatch = chunk.match(/data-at="job-item-company-name">([\s\S]*?)<\/div>/);
    const company = compMatch
      ? compMatch[1]
          .replace(/<style[^>]*>[\s\S]*?<\/style>/g, '')
          .replace(/<svg[\s\S]*?<\/svg>/g, '')
          .replace(/<[^>]+>/g, '')
          .replace(/\s+/g, ' ')
          .trim()
      : parseCompanyFromSlug(hrefMatch[2]);

    // Location: data-at="job-item-location" within this card's chunk
    const locMatch = chunk.match(/data-at="job-item-location">([\s\S]*?)<\/span><\/span>/);
    const location = locMatch
      ? locMatch[1]
          .replace(/<style[^>]*>[\s\S]*?<\/style>/g, '')
          .replace(/<svg[\s\S]*?<\/svg>/g, '')
          .replace(/<[^>]+>/g, '')
          .replace(/\s+/g, ' ')
          .trim()
      : '';

    jobs.push({
      url,
      title: decodeHtmlEntities(title),
      company: decodeHtmlEntities(company),
      location: decodeHtmlEntities(location),
    });
  }

  return jobs;
}

function parseTitleFromSlug(slug) {
  // Fallback: extract title from URL slug
  // Pattern: Title-Parts-Location-Company--ID-inline
  const mainPart = slug.split('--')[0] || '';
  return mainPart.replace(/-/g, ' ').trim();
}

function parseCompanyFromSlug(slug) {
  // Fallback: company is usually the last part before --ID
  const mainPart = slug.split('--')[0] || '';
  const parts = mainPart.split('-');
  // Last few words tend to be company name — best effort
  return 'Unknown';
}

function decodeHtmlEntities(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&auml;/g, 'ä')
    .replace(/&ouml;/g, 'ö')
    .replace(/&uuml;/g, 'ü')
    .replace(/&Auml;/g, 'Ä')
    .replace(/&Ouml;/g, 'Ö')
    .replace(/&Uuml;/g, 'Ü')
    .replace(/&szlig;/g, 'ß');
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
// Pipeline Integration (profile-specific)
// ============================================================

async function loadExistingUrls(profileName) {
  const urls = new Set();
  const profileDir = resolve(__dirname, 'profiles', profileName, 'data');

  try {
    const pipeline = await readFile(resolve(profileDir, 'pipeline.md'), 'utf8');
    for (const match of pipeline.matchAll(/https?:\/\/[^\s|)]+/g)) {
      urls.add(match[0]);
    }
  } catch { /* no pipeline yet */ }

  try {
    const apps = await readFile(resolve(profileDir, 'applications.md'), 'utf8');
    for (const match of apps.matchAll(/https?:\/\/[^\s|)]+/g)) {
      urls.add(match[0]);
    }
  } catch { /* no tracker yet */ }

  try {
    const history = await readFile(resolve(profileDir, 'scan-history.tsv'), 'utf8');
    for (const match of history.matchAll(/https?:\/\/[^\s\t]+/g)) {
      urls.add(match[0]);
    }
  } catch { /* no history yet */ }

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
    return `- [ ] ${j.url} | ${j.company} | ${j.title}${locationPart} | Not disclosed`;
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
    ...jobs.map(j => `${j.url}\t${date}\tStepStone: ${j.queryLabel}\t${j.title}\t${j.company}\tadded`),
    ...skipped.map(s => `${s.url}\t${date}\tStepStone: ${s.queryLabel}\t${s.title}\t${s.company}\t${s.reason}`),
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
  const maxPerQuery = limitArg ? parseInt(limitArg.split('=')[1]) : 25;
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

  console.log(`\n  StepStone.de Scraper \u2014 Profile: ${profileName}`);
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
      console.log(`\n  Searching: "${query.what}"${query.where ? ` in ${query.where}` : ' (national)'}...`);

      let queryJobs = 0;
      for (let page = 1; page <= MAX_PAGES; page++) {
        const url = buildSearchUrl(query.what, query.where, page);
        const html = await fetchPage(url);
        const jobs = parseJobsFromHtml(html);

        if (jobs.length === 0) {
          if (page === 1) console.log(`    No results found`);
          break;
        }

        if (page === 1) {
          // Try to get total count
          const totalMatch = html.match(/"totalCount":\s*(\d+)/) || html.match(/(\d[\d.]*)\s*(?:Jobs|Stellenangebote)/);
          const total = totalMatch ? totalMatch[1] : '?';
          console.log(`    Found: ${total} total results`);
        }

        for (const job of jobs) {
          if (!job.url) continue;
          totalFound++;

          // Dedup against existing pipeline URLs
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
            queryLabel: query.label,
          });
          existingUrls.add(job.url);
          queryJobs++;
        }

        await sleep(RATE_LIMIT_MS);

        // Stop paging if we've got enough
        if (queryJobs >= maxPerQuery) break;
      }
    } catch (err) {
      console.error(`    ERROR: ${err.message}`);
      if (err.message.includes('429')) {
        console.error(`    Rate limited — stopping StepStone scan.`);
        break;
      }
    }
  }

  // Summary
  console.log(`\n  ${'━'.repeat(50)}`);
  console.log(`  StepStone Scan Complete \u2014 ${new Date().toISOString().split('T')[0]}`);
  console.log(`  ${'━'.repeat(50)}`);
  console.log(`  Queries executed: ${config.searches.length}`);
  console.log(`  Total results:    ${totalFound}`);
  console.log(`  Filtered:         ${totalFiltered}`);
  console.log(`  Duplicates:       ${totalDuped}`);
  console.log(`  NEW to pipeline:  ${allJobs.length}`);

  if (allJobs.length > 0) {
    console.log(`\n  New jobs:`);
    for (const job of allJobs) {
      const loc = job.location || 'Germany';
      console.log(`    + [DE] ${job.company} | ${job.title} | ${loc}`);
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
