#!/usr/bin/env node

/**
 * xing-scraper.mjs — XING Jobs Scraper (Germany/DACH)
 *
 * Scrapes XING.com job listings — major DACH job platform (New Work SE).
 * Guest search works without login via plain HTTP fetch.
 *
 * ADDITIVE source — supplements StepStone and Bundesagentur for German jobs.
 *
 * Usage:
 *   node xing-scraper.mjs [--profile=paulina|lamin] [--dry-run] [--limit=20]
 *
 * Without --profile, reads profiles/active.yml to determine which profile to scan.
 *
 * Rate limiting: 4s between requests to be respectful.
 * Max 2 pages per query (20 jobs/page).
 */

import { readFile, writeFile, appendFile } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================
// Configuration
// ============================================================

const BASE_URL = 'https://www.xing.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const RATE_LIMIT_MS = 4000;
const MAX_PAGES = 2; // 20 jobs/page

// ============================================================
// Search Profiles (DACH-focused only — XING is a German platform)
// ============================================================

const SEARCH_CONFIGS = {
  paulina: {
    searches: [
      { keywords: 'Psychiater', location: 'Deutschland', label: 'Psychiater DE' },
      { keywords: 'Facharzt Psychiatrie', location: 'Deutschland', label: 'Facharzt Psychiatrie DE' },
      { keywords: 'Oberarzt Psychiatrie', location: 'Deutschland', label: 'Oberarzt Psychiatrie DE' },
      { keywords: 'Arzt Psychosomatik', location: 'Deutschland', label: 'Arzt Psychosomatik DE' },
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
      { keywords: 'Account Manager', location: 'Deutschland', label: 'Account Manager DE' },
      { keywords: 'Sales Manager Telekommunikation', location: 'Deutschland', label: 'Sales Manager Telekom DE' },
      { keywords: 'Key Account Manager', location: 'Deutschland', label: 'Key Account Manager DE' },
      { keywords: 'Vertrieb Telekommunikation', location: 'Deutschland', label: 'Vertrieb Telekom DE' },
      { keywords: 'Business Development Manager', location: 'Deutschland', label: 'BizDev Manager DE' },
      { keywords: 'B2B Sales', location: 'Deutschland', label: 'B2B Sales DE' },
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

function buildSearchUrl(keywords, location, page = 1) {
  const params = new URLSearchParams({ keywords });
  if (location) params.set('location', location);
  if (page > 1) params.set('page', String(page));
  return `${BASE_URL}/jobs/search?${params}`;
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
    throw new Error('XING rate limit hit (429)');
  }
  if (res.status === 403) {
    throw new Error('XING blocked request (403) — may need longer delays');
  }
  if (!res.ok) {
    throw new Error(`XING ${res.status}: ${url}`);
  }

  return res.text();
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
    .replace(/&szlig;/g, 'ß')
    .replace(/<!-- -->/g, '');
}

function parseJobsFromHtml(html) {
  const jobs = [];

  // Split by job-search-result cards
  const cards = html.split(/data-testid="job-search-result"/);

  for (let i = 1; i < cards.length; i++) {
    const card = cards[i];

    // URL: /jobs/{slug}-{id}
    const urlMatch = card.match(/href="(\/jobs\/[a-z0-9-]+-\d+)"/);
    if (!urlMatch) continue;
    const url = `${BASE_URL}${urlMatch[1]}`;

    // Title: from aria-label on the card or h2
    let title = '';
    const ariaMatch = cards[i - 1].slice(-500).match(/aria-label="([^"]+?)(?:\.?\s*Klicke|")/);
    if (ariaMatch) {
      title = ariaMatch[1];
    }
    if (!title) {
      const h2Match = card.match(/data-testid="job-teaser-list-title"[^>]*>([^<]+)/);
      if (h2Match) title = h2Match[1];
    }
    if (!title) {
      // Fallback from URL slug
      const slug = urlMatch[1].replace('/jobs/', '').replace(/-\d+$/, '').replace(/-/g, ' ');
      title = slug;
    }

    // Company: <p> right after the h2 title, or from img aria-label
    let company = '';
    const imgLabel = card.match(/aria-label="([^"]+)"[^>]*loading="lazy"/);
    if (imgLabel) {
      company = imgLabel[1];
    }
    if (!company) {
      const h2Idx = card.indexOf('job-teaser-list-title');
      if (h2Idx > -1) {
        const afterH2 = card.slice(h2Idx);
        const pMatch = afterH2.match(/<\/h2>\s*<p[^>]*>([^<]+)<\/p>/);
        if (pMatch) company = pMatch[1];
      }
    }

    // Location: <p> with city name after company
    let location = '';
    const h2Idx = card.indexOf('job-teaser-list-title');
    if (h2Idx > -1) {
      const afterTitle = card.slice(h2Idx, h2Idx + 2000);
      // Location is typically in a <p> with a city and optional "+ N weitere"
      const locMatch = afterTitle.match(/<\/p>\s*<div[^>]*>\s*<p[^>]*>([^<]+)/);
      if (locMatch) {
        location = locMatch[1].replace(/\s*\+\s*$/, '').trim();
      }
    }

    // Salary: look for € pattern
    let salary = '';
    const salaryMatch = card.match(/([\d.]+)\s*€[\s\S]*?–[\s\S]*?([\d.]+)\s*€/);
    if (salaryMatch) {
      salary = `€${salaryMatch[1]} – €${salaryMatch[2]}`;
    }

    jobs.push({
      url,
      title: decodeHtmlEntities(title.trim()),
      company: decodeHtmlEntities((company || 'Unknown').trim()),
      location: decodeHtmlEntities((location || '').trim()),
      salary: salary || 'Not disclosed',
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
// Pipeline Integration (profile-specific)
// ============================================================

async function loadExistingUrls(profileName) {
  const urls = new Set();
  const profileDir = resolve(__dirname, 'profiles', profileName, 'data');

  try {
    const pipeline = await readFile(resolve(profileDir, 'pipeline.md'), 'utf8');
    for (const match of pipeline.matchAll(/https?:\/\/[^\s|)]+/g)) urls.add(match[0]);
  } catch { /* no pipeline yet */ }

  try {
    const apps = await readFile(resolve(profileDir, 'applications.md'), 'utf8');
    for (const match of apps.matchAll(/https?:\/\/[^\s|)]+/g)) urls.add(match[0]);
  } catch { /* no tracker yet */ }

  try {
    const history = await readFile(resolve(profileDir, 'scan-history.tsv'), 'utf8');
    for (const match of history.matchAll(/https?:\/\/[^\s\t]+/g)) urls.add(match[0]);
  } catch { /* no history yet */ }

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
    ...jobs.map(j => `${j.url}\t${date}\tXING: ${j.queryLabel}\t${j.title}\t${j.company}\tadded`),
    ...skipped.map(s => `${s.url}\t${date}\tXING: ${s.queryLabel}\t${s.title}\t${s.company}\t${s.reason}`),
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

  console.log(`\n  XING Jobs Scraper \u2014 Profile: ${profileName}`);
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
      console.log(`\n  Searching: "${query.keywords}"${query.location ? ` in ${query.location}` : ''}...`);

      let queryJobs = 0;
      for (let page = 1; page <= MAX_PAGES; page++) {
        const url = buildSearchUrl(query.keywords, query.location, page);
        const html = await fetchPage(url);
        const jobs = parseJobsFromHtml(html);

        if (jobs.length === 0) {
          if (page === 1) console.log(`    No results found`);
          break;
        }

        if (page === 1) console.log(`    Found: ${jobs.length}+ results`);

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
        console.error(`    Blocked — stopping XING scan.`);
        break;
      }
    }
  }

  // Summary
  console.log(`\n  ${'━'.repeat(50)}`);
  console.log(`  XING Scan Complete \u2014 ${new Date().toISOString().split('T')[0]}`);
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
      const sal = job.salary !== 'Not disclosed' ? ` | ${job.salary}` : '';
      console.log(`    + [DE] ${job.company} | ${job.title} | ${loc}${sal}`);
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
