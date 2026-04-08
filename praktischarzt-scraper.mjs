#!/usr/bin/env node

/**
 * praktischarzt-scraper.mjs — PraktischArzt.de Job Board Scraper
 *
 * Scrapes PraktischArzt.de — Germany's leading physician job aggregator — via
 * plain HTTP fetch. No Playwright needed; PraktischArzt serves full server-rendered
 * HTML with job cards containing title, company, location, date, and category.
 *
 * ADDITIVE source — supplements StepStone/XING for German physician roles.
 * This board is medical-only, so it's paulina-exclusive (lamin = skip).
 *
 * Usage:
 *   node praktischarzt-scraper.mjs [--profile=paulina|lamin] [--dry-run] [--limit=20]
 *
 * Without --profile, reads profiles/active.yml to determine which profile to scan.
 *
 * Rate limiting: 4s between requests to be respectful.
 * Max 3 pages per category URL (10 jobs/page).
 */

import { readFile, writeFile, appendFile } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================
// Configuration
// ============================================================

const BASE_URL = 'https://www.praktischarzt.de';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Rate limiting: be respectful, 4s between page fetches
const RATE_LIMIT_MS = 4000;
const MAX_PAGES = 3; // Max pages per category (10 jobs/page)

// ============================================================
// Search Profiles
// ============================================================

const SEARCH_CONFIGS = {
  paulina: {
    // PraktischArzt uses category slug URLs, not keyword search.
    // Each entry is a category page that lists jobs in that specialty.
    searches: [
      { path: '/psychiatrie-psychotherapie/', label: 'Psychiatrie & Psychotherapie' },
      { path: '/psychosomatik/', label: 'Psychosomatik' },
      { path: '/neurologie/', label: 'Neurologie' },
      { path: '/kinder-und-jugendpsychiatrie-psychotherapie/', label: 'Kinder-/Jugendpsychiatrie' },
    ],
    titlePositive: [
      'psychiatr', 'facharzt', 'fachärztin', 'oberarzt', 'oberärztin',
      'chefarzt', 'chefärztin', 'arzt', 'ärztin', 'physician',
      'medical director', 'behavioral health', 'mental health',
      'psychosomatik', 'psychotherapie', 'klinik', 'neurolog',
      'leitender arzt', 'leitende ärztin', 'stationsarzt',
    ],
    titleNegative: [
      'pflege', 'krankenschwester', 'krankenpfleger', 'sozialarbeiter',
      'psycholog', 'therapeut', 'verwaltung', 'sekretär', 'reinigung',
      'hauswirtschaft', 'nurse', 'nursing', 'social worker', 'technician',
      'aide', 'pflegekraft', 'medizinische fachangestellte',
    ],
  },

  // PraktischArzt is physician-only — not relevant for lamin (B2B sales)
  lamin: null,
};

// ============================================================
// Scraper
// ============================================================

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function buildPageUrl(path, page = 1) {
  // PraktischArzt pagination: /category-slug/2/, /category-slug/3/, etc.
  if (page <= 1) return `${BASE_URL}${path}`;
  return `${BASE_URL}${path}${page}/`;
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
    throw new Error('PraktischArzt rate limit hit (429)');
  }
  if (!res.ok) {
    throw new Error(`PraktischArzt ${res.status}: ${url}`);
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
    .replace(/&#x27;/g, "'")
    .replace(/&auml;/g, 'ä')
    .replace(/&ouml;/g, 'ö')
    .replace(/&uuml;/g, 'ü')
    .replace(/&Auml;/g, 'Ä')
    .replace(/&Ouml;/g, 'Ö')
    .replace(/&Uuml;/g, 'Ü')
    .replace(/&szlig;/g, 'ß')
    .replace(/&ndash;/g, '\u2013')
    .replace(/&mdash;/g, '\u2014')
    .replace(/&#8211;/g, '\u2013')
    .replace(/&#8212;/g, '\u2014')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function stripTags(html) {
  return html
    .replace(/<svg[\s\S]*?<\/svg>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseJobsFromHtml(html) {
  const jobs = [];

  // Split by job card containers: <div id="job-{id}" class="row job box-job ...">
  const cardPattern = /<div\s+id="job-(\d+)"\s+class="row job box-job[^"]*"/g;
  const cardStarts = [];
  let m;
  while ((m = cardPattern.exec(html)) !== null) {
    cardStarts.push({ id: m[1], index: m.index });
  }

  for (let i = 0; i < cardStarts.length; i++) {
    const start = cardStarts[i].index;
    const end = i + 1 < cardStarts.length ? cardStarts[i + 1].index : start + 5000;
    const card = html.slice(start, end);

    // URL: first href to /job/... in the card
    const urlMatch = card.match(/href="(https:\/\/www\.praktischarzt\.de\/job\/[^"]+)"/);
    if (!urlMatch) continue;
    const url = urlMatch[1].replace(/\/$/, ''); // normalize trailing slash

    // Title: from title attribute "Mehr Details für {TITLE} anzeigen" on the desktop link
    let title = '';
    const titleAttrMatch = card.match(/title="Mehr Details f(?:ü|&uuml;)r\s+(.*?)\s+anzeigen"/);
    if (titleAttrMatch) {
      title = decodeHtmlEntities(titleAttrMatch[1].trim());
    }
    if (!title) {
      // Fallback: text inside <a class="title-link title desktop_show" ...>
      const titleTextMatch = card.match(/class="title-link title desktop_show"[^>]*>([\s\S]*?)<\/a>/);
      if (titleTextMatch) {
        title = decodeHtmlEntities(stripTags(titleTextMatch[1]));
      }
    }
    if (!title) {
      // Last resort: extract from URL slug
      const slug = urlMatch[1].replace(/.*\/job\//, '').replace(/\/$/, '');
      title = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    }

    // Company: from <div class="employer-name"> <a ...><i ...></i> COMPANY</a>
    let company = '';
    const companyMatch = card.match(/class="employer-name">\s*<a[^>]*>([\s\S]*?)<\/a>/);
    if (companyMatch) {
      company = decodeHtmlEntities(stripTags(companyMatch[1]));
    }
    if (!company) {
      // Fallback: from img alt on the logo
      const imgAltMatch = card.match(/id="company_logo_thumb"[^>]*alt="([^"]+)"/);
      if (imgAltMatch) {
        company = decodeHtmlEntities(imgAltMatch[1]);
      }
    }
    if (!company) {
      // Try alt before id
      const imgAltMatch2 = card.match(/alt="([^"]+)"[^>]*id="company_logo_thumb"/);
      if (imgAltMatch2) {
        company = decodeHtmlEntities(imgAltMatch2[1]);
      }
    }

    // Location: text after svg-location span in employer-address div
    let location = '';
    const addrMatch = card.match(/class="employer-address">([\s\S]*?)<\/div>/);
    if (addrMatch) {
      const addrHtml = addrMatch[1];
      // Location follows the svg-location span
      const locSvgIdx = addrHtml.indexOf('svg-location');
      if (locSvgIdx > -1) {
        const afterLocSvg = addrHtml.slice(locSvgIdx);
        // After closing </span> of the svg-location wrapper
        const afterSpan = afterLocSvg.replace(/^[\s\S]*?<\/span>/, '');
        location = decodeHtmlEntities(stripTags(afterSpan));
      }
    }

    // Date: text after svg-calendar span
    let date = '';
    if (addrMatch) {
      const addrHtml = addrMatch[1];
      const calIdx = addrHtml.indexOf('svg-calendar');
      if (calIdx > -1) {
        const afterCal = addrHtml.slice(calIdx);
        const afterSvgSpan = afterCal.replace(/^[\s\S]*?<\/svg><\/span>/, '');
        const dateMatch = afterSvgSpan.match(/^([\d.]+)/);
        if (dateMatch) date = dateMatch[1];
      }
    }

    // Job category: from employer-job-cat div
    let category = '';
    const catMatch = card.match(/class="employer-job-cat">([\s\S]*?)<\/div>/);
    if (catMatch) {
      category = decodeHtmlEntities(stripTags(catMatch[1])).replace(/,\s*$/, '');
    }

    jobs.push({
      url,
      title,
      company: company || 'Unknown',
      location,
      date,
      category,
    });
  }

  return jobs;
}

// ============================================================
// Title Filtering (reads portals.yml positive/negative keywords)
// ============================================================

async function loadTitleFilter() {
  try {
    const yml = await readFile(resolve(__dirname, 'portals.yml'), 'utf8');
    const positive = [];
    const negative = [];

    // Parse positive keywords
    const posBlock = yml.match(/title_filter:\s*\n\s+positive:\s*\n((?:\s+- "[^"]*"\n?)*)/);
    if (posBlock) {
      for (const m of posBlock[1].matchAll(/- "([^"]+)"/g)) {
        positive.push(m[1].toLowerCase());
      }
    }

    // Parse negative keywords
    const negBlock = yml.match(/negative:\s*\n((?:\s+- "[^"]*"\n?)*)/);
    if (negBlock) {
      for (const m of negBlock[1].matchAll(/- "([^"]+)"/g)) {
        negative.push(m[1].toLowerCase());
      }
    }

    if (positive.length > 0) return { positive, negative };
  } catch { /* fallback to inline */ }

  return null;
}

function matchesTitle(title, config, portalFilter) {
  const lower = title.toLowerCase();

  // Use portals.yml filter if available, otherwise fallback to inline config
  const positive = portalFilter ? portalFilter.positive : config.titlePositive;
  const negative = portalFilter ? portalFilter.negative : config.titleNegative;

  const hasPositive = positive.some(kw => lower.includes(kw.toLowerCase()));
  if (!hasPositive) return false;
  const hasNegative = negative.some(kw => lower.includes(kw.toLowerCase()));
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
    ...jobs.map(j => `${j.url}\t${date}\tPraktischArzt: ${j.queryLabel}\t${j.title}\t${j.company}\tadded`),
    ...skipped.map(s => `${s.url}\t${date}\tPraktischArzt: ${s.queryLabel}\t${s.title}\t${s.company}\t${s.reason}`),
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
    if (profileName === 'lamin') {
      console.log(`\n  PraktischArzt.de is a physician job board \u2014 not relevant for profile: ${profileName}`);
      console.log(`  Skipping.\n`);
      return;
    }
    console.error(`Unknown profile: ${profileName}. Available: ${Object.keys(SEARCH_CONFIGS).join(', ')}`);
    process.exit(1);
  }

  console.log(`\n  PraktischArzt.de Scraper \u2014 Profile: ${profileName}`);
  console.log(`  ${'━'.repeat(50)}`);
  console.log(`  Categories: ${config.searches.length} | Max pages: ${MAX_PAGES} | Dry run: ${dryRun}\n`);

  const existingUrls = await loadExistingUrls(profileName);
  console.log(`  Existing URLs loaded: ${existingUrls.size}`);

  // Load portals.yml title filter
  const portalFilter = await loadTitleFilter();
  if (portalFilter) {
    console.log(`  Title filter from portals.yml: ${portalFilter.positive.length} positive, ${portalFilter.negative.length} negative`);
  }

  const allJobs = [];
  const allSkipped = [];
  const seenCompanyTitle = new Set();
  let totalFound = 0;
  let totalFiltered = 0;
  let totalDuped = 0;

  for (const query of config.searches) {
    try {
      console.log(`\n  Scanning: ${query.label} (${query.path})...`);

      let queryJobs = 0;
      for (let page = 1; page <= MAX_PAGES; page++) {
        const url = buildPageUrl(query.path, page);
        const html = await fetchPage(url);
        const jobs = parseJobsFromHtml(html);

        if (jobs.length === 0) {
          if (page === 1) console.log(`    No results found`);
          break;
        }

        if (page === 1) {
          // Try to extract total count from pagination
          const lastPageMatch = html.match(/class="pagination[^"]*"[\s\S]*?href="[^"]*\/(\d+)\/"[^>]*>\s*\d+\s*<\/a>\s*<\/li>\s*<li>\s*<a[^>]*class="next"/);
          const totalPages = lastPageMatch ? lastPageMatch[1] : '?';
          const totalEst = totalPages !== '?' ? parseInt(totalPages) * 10 : '?';
          console.log(`    Found: ~${totalEst} total results (${totalPages} pages)`);
        }

        for (const job of jobs) {
          if (!job.url) continue;
          totalFound++;

          // Normalize URL for dedup (strip trailing slash)
          const normUrl = job.url.replace(/\/$/, '');

          // Dedup against existing pipeline URLs
          if (existingUrls.has(normUrl) || existingUrls.has(normUrl + '/')) {
            totalDuped++;
            allSkipped.push({ url: normUrl, title: job.title, company: job.company, queryLabel: query.label, reason: 'skipped_dup_url' });
            continue;
          }

          // Dedup by company+title combo
          const companyTitleKey = `${job.company.toLowerCase().trim()}||${job.title.toLowerCase().trim()}`;
          if (seenCompanyTitle.has(companyTitleKey)) {
            totalDuped++;
            allSkipped.push({ url: normUrl, title: job.title, company: job.company, queryLabel: query.label, reason: 'skipped_dup_combo' });
            continue;
          }
          seenCompanyTitle.add(companyTitleKey);

          // Title filter
          if (!matchesTitle(job.title, config, portalFilter)) {
            totalFiltered++;
            allSkipped.push({ url: normUrl, title: job.title, company: job.company, queryLabel: query.label, reason: 'skipped_title' });
            continue;
          }

          allJobs.push({
            url: normUrl,
            title: job.title,
            company: job.company,
            location: job.location,
            date: job.date,
            category: job.category,
            queryLabel: query.label,
          });
          existingUrls.add(normUrl);
          queryJobs++;
        }

        await sleep(RATE_LIMIT_MS);

        // Stop paging if we've got enough
        if (queryJobs >= maxPerQuery) break;
      }
    } catch (err) {
      console.error(`    ERROR: ${err.message}`);
      if (err.message.includes('429')) {
        console.error(`    Rate limited \u2014 stopping PraktischArzt scan.`);
        break;
      }
    }
  }

  // Summary
  console.log(`\n  ${'━'.repeat(50)}`);
  console.log(`  PraktischArzt Scan Complete \u2014 ${new Date().toISOString().split('T')[0]}`);
  console.log(`  ${'━'.repeat(50)}`);
  console.log(`  Categories scanned: ${config.searches.length}`);
  console.log(`  Total results:      ${totalFound}`);
  console.log(`  Filtered:           ${totalFiltered}`);
  console.log(`  Duplicates:         ${totalDuped}`);
  console.log(`  NEW to pipeline:    ${allJobs.length}`);

  if (allJobs.length > 0) {
    console.log(`\n  New jobs:`);
    for (const job of allJobs) {
      const loc = job.location || 'Germany';
      const cat = job.category ? ` [${job.category}]` : '';
      console.log(`    + [DE] ${job.company} | ${job.title} | ${loc}${cat}`);
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
