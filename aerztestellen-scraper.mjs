#!/usr/bin/env node

/**
 * aerztestellen-scraper.mjs — Deutsches Aerzteblatt Job Board Scraper
 *
 * Scrapes aerztestellen.aerzteblatt.de — the premier physician job board
 * in Germany, operated by the Deutsches Aerzteblatt (German Medical Journal).
 * Uses plain HTTP fetch with bot-challenge cookie bypass.
 *
 * ADDITIVE source — supplements StepStone/XING/Bundesagentur for
 * physician-specific listings in Germany/DACH.
 *
 * Usage:
 *   node aerztestellen-scraper.mjs [--profile=paulina|lamin] [--dry-run] [--limit=20]
 *
 * Without --profile, reads profiles/active.yml to determine which profile to scan.
 *
 * Rate limiting: 4s between requests to be respectful.
 * Max 3 pages per query (20 jobs/page).
 */

import { readFile, writeFile, appendFile } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================
// Configuration
// ============================================================

const BASE_URL = 'https://aerztestellen.aerzteblatt.de';
const SEARCH_PATH = '/de/stellen';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const RATE_LIMIT_MS = 4000;
const MAX_PAGES = 3; // 20 jobs/page

// ============================================================
// Search Profiles (Physician job board — only paulina is relevant)
// ============================================================

const SEARCH_CONFIGS = {
  paulina: {
    searches: [
      { search: 'Psychiatrie', label: 'Psychiatrie' },
      { search: 'Psychosomatik', label: 'Psychosomatik' },
      { search: 'Neurologie', label: 'Neurologie' },
      { search: 'Facharzt Psychiatrie', label: 'Facharzt Psychiatrie' },
      { search: 'Oberarzt Psychiatrie', label: 'Oberarzt Psychiatrie' },
      { search: 'Chefarzt Psychiatrie', label: 'Chefarzt Psychiatrie' },
    ],
    titlePositive: [
      'psychiatr', 'facharzt', 'fachärztin', 'oberarzt', 'oberärztin',
      'chefarzt', 'chefärztin', 'arzt', 'ärztin', 'physician',
      'medical director', 'psychosomatik', 'klinik', 'neurolog',
      'stationsarzt', 'leitend',
    ],
    titleNegative: [
      'pflege', 'krankenschwester', 'sozialarbeiter', 'psycholog',
      'verwaltung', 'sekretär', 'reinigung', 'hauswirtschaft',
      'nurse', 'nursing', 'social worker', 'technician', 'aide',
      'medizinische fachangestellte', 'mfa', 'ergotherap',
    ],
  },

  lamin: null, // Physician job board — not relevant for lamin
};

// ============================================================
// Bot Challenge Handler
// ============================================================

let botToken = null;

async function solveBotChallenge() {
  // Step 1: Hit the homepage to get redirected to bot challenge with a token
  const res = await fetch(`${BASE_URL}/`, {
    headers: { 'User-Agent': USER_AGENT },
    redirect: 'manual',
  });

  const location = res.headers.get('location') || '';
  const tokenMatch = location.match(/token=([a-f0-9]+)/);
  if (tokenMatch) {
    botToken = tokenMatch[1];
    return botToken;
  }

  // If no redirect (already bypassed or different flow), try without token
  return null;
}

// ============================================================
// Scraper
// ============================================================

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function buildSearchUrl(search, page = 0) {
  const params = new URLSearchParams({ search });
  if (page > 0) params.set('page', String(page));
  return `${BASE_URL}${SEARCH_PATH}?${params}`;
}

async function fetchPage(url) {
  const headers = {
    'User-Agent': USER_AGENT,
    'Accept': 'text/html,application/xhtml+xml',
    'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
  };

  if (botToken) {
    headers['Cookie'] = `bot_verified=${botToken}`;
  }

  const res = await fetch(url, { headers, redirect: 'manual' });

  // Handle bot challenge redirect
  if (res.status === 302) {
    const location = res.headers.get('location') || '';
    if (location.includes('botchallenge')) {
      const tokenMatch = location.match(/token=([a-f0-9]+)/);
      if (tokenMatch) {
        botToken = tokenMatch[1];
        // Retry with the new token
        headers['Cookie'] = `bot_verified=${botToken}`;
        const retry = await fetch(url, { headers, redirect: 'follow' });
        if (!retry.ok) throw new Error(`Aerztestellen ${retry.status} after bot challenge: ${url}`);
        return retry.text();
      }
    }
    // Follow other redirects (e.g., /stellenangebote -> /de/stellenangebote)
    const redirectUrl = location.startsWith('http') ? location : `${BASE_URL}${location}`;
    headers['Cookie'] = botToken ? `bot_verified=${botToken}` : '';
    const retry = await fetch(redirectUrl, { headers });
    if (!retry.ok) throw new Error(`Aerztestellen ${retry.status} after redirect: ${redirectUrl}`);
    return retry.text();
  }

  // Handle 301 redirect (Drupal path normalization)
  if (res.status === 301) {
    const location = res.headers.get('location') || '';
    const redirectUrl = location.startsWith('http') ? location : `${BASE_URL}${location}`;
    const retry = await fetch(redirectUrl, { headers });
    if (!retry.ok) throw new Error(`Aerztestellen ${retry.status} after 301: ${redirectUrl}`);
    return retry.text();
  }

  if (res.status === 429) {
    throw new Error('Aerztestellen rate limit hit (429)');
  }
  if (!res.ok) {
    throw new Error(`Aerztestellen ${res.status}: ${url}`);
  }

  return res.text();
}

function decodeUnicodeEscapes(str) {
  return str.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  );
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

function parseJobsFromHtml(html) {
  const jobs = [];
  const seenIds = new Set();

  // === Strategy 1: Parse inline JSON analytics blocks ===
  // Each job card has a JSON block with: jobTitel, jobId, jobCompany, jobRegion, jobFachgebiet, etc.
  const jsonPattern = /"jobTitel":"([^"]*?)","jobId":(\d+),[^}]*?"jobCompany":"([^"]*?)"[^}]*?"jobFachgebiet":"([^"]*?)"[^}]*?"jobRegion":"([^"]*?)"/g;
  let jsonMatch;
  while ((jsonMatch = jsonPattern.exec(html)) !== null) {
    const jobId = jsonMatch[2];
    if (seenIds.has(jobId)) continue;
    seenIds.add(jobId);

    const title = decodeUnicodeEscapes(jsonMatch[1]).replace(/\\\//g, '/');
    const company = decodeUnicodeEscapes(jsonMatch[3]).replace(/\\\//g, '/');
    const fachgebiet = decodeUnicodeEscapes(jsonMatch[4]);
    const region = decodeUnicodeEscapes(jsonMatch[5]);

    // We still need the URL — get it from the href links
    // Match will be done below after collecting all URLs
    jobs.push({ jobId, title, company, fachgebiet, location: region, url: '' });
  }

  // === Collect job URLs from recruiter-job-link anchors ===
  const urlMap = new Map(); // title -> url (first occurrence wins)
  const urlPattern = /href="(https:\/\/aerztestellen\.aerzteblatt\.de\/de\/stelle\/[^"]+)" class="recruiter-job-link" title="([^"]*)"/g;
  let urlMatch;
  while ((urlMatch = urlPattern.exec(html)) !== null) {
    const url = urlMatch[1];
    const title = decodeHtmlEntities(urlMatch[2]).replace(/&amp;/g, '&');
    if (!urlMap.has(title)) {
      urlMap.set(title, url);
    }
  }

  // === Strategy 2: If JSON parsing missed jobs, also extract from data-gtm attributes ===
  const gtmPattern = /data-gtm-jobId="(\d+)"[\s\S]*?data-gtm-company="([^"]*)"[\s\S]*?data-gtm-regions="([^"]*)"[\s\S]*?data-gtm-jobTitel="([^"]*)"/g;
  let gtmMatch;
  while ((gtmMatch = gtmPattern.exec(html)) !== null) {
    const jobId = gtmMatch[1];
    if (seenIds.has(jobId)) continue;
    seenIds.add(jobId);

    jobs.push({
      jobId,
      title: decodeHtmlEntities(gtmMatch[4]),
      company: decodeHtmlEntities(gtmMatch[2]),
      fachgebiet: '',
      location: gtmMatch[3].split('|')[0].trim(),
      url: '',
    });
  }

  // === Match URLs to jobs by title similarity ===
  for (const job of jobs) {
    if (job.url) continue;

    // Try exact title match first
    if (urlMap.has(job.title)) {
      job.url = urlMap.get(job.title);
      continue;
    }

    // Try normalized match (strip m/w/d, whitespace differences)
    const normalizedTitle = job.title.toLowerCase().replace(/\s+/g, ' ').trim();
    for (const [mapTitle, mapUrl] of urlMap.entries()) {
      const normalizedMapTitle = mapTitle.toLowerCase().replace(/\s+/g, ' ').trim();
      if (normalizedTitle === normalizedMapTitle) {
        job.url = mapUrl;
        break;
      }
    }

    // Fallback: construct URL from jobId (last resort)
    if (!job.url) {
      // Try to find any href containing the jobId
      const idPattern = new RegExp(`href="(https://aerztestellen\\.aerzteblatt\\.de/de/stelle/[^"]*${job.jobId}[^"]*)"`, 'g');
      const idMatch = idPattern.exec(html);
      if (idMatch) {
        job.url = idMatch[1];
      }
    }
  }

  // Also collect any remaining URLs not yet matched to JSON jobs
  // (fallback: parse recruiter-job-link pairs as standalone jobs)
  const existingUrls = new Set(jobs.map(j => j.url));
  for (const [title, url] of urlMap.entries()) {
    if (existingUrls.has(url)) continue;
    // This URL wasn't matched to a JSON job — add as standalone
    jobs.push({
      jobId: url.split('/').pop() || '',
      title: decodeHtmlEntities(title),
      company: '',
      fachgebiet: '',
      location: '',
      url,
    });
  }

  return jobs;
}

function parseTotalCount(html) {
  // Pattern: "Stellenangebote Psychiatrie (233)"
  const match = html.match(/search-result-header[^>]*>Stellenangebote[^(]*\((\d+)\)/);
  if (match) return parseInt(match[1]);

  // Fallback from meta description
  const metaMatch = html.match(/Stellenangebote[^(]*\((\d+)\)/);
  if (metaMatch) return parseInt(metaMatch[1]);

  return null;
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
    return `- [ ] ${j.url} | ${j.company} | ${j.title}${locationPart} | Not disclosed`;
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
    ...jobs.map(j => `${j.url}\t${date}\tAerztestellen: ${j.queryLabel}\t${j.title}\t${j.company}\tadded`),
    ...skipped.map(s => `${s.url}\t${date}\tAerztestellen: ${s.queryLabel}\t${s.title}\t${s.company}\t${s.reason}`),
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
  if (config === null) {
    console.log(`\n  Aerztestellen Scraper \u2014 Profile: ${profileName}`);
    console.log(`  Skipped: physician job board not relevant for this profile.\n`);
    process.exit(0);
  }
  if (!config) {
    console.error(`Unknown profile: ${profileName}. Available: ${Object.keys(SEARCH_CONFIGS).join(', ')}`);
    process.exit(1);
  }

  console.log(`\n  Aerztestellen.de Scraper \u2014 Profile: ${profileName}`);
  console.log(`  ${'━'.repeat(50)}`);
  console.log(`  Queries: ${config.searches.length} | Max pages: ${MAX_PAGES} | Dry run: ${dryRun}\n`);

  // Solve bot challenge before starting
  console.log(`  Solving bot challenge...`);
  await solveBotChallenge();
  if (botToken) {
    console.log(`  Bot challenge solved (token acquired)`);
  } else {
    console.log(`  No bot challenge encountered (proceeding without token)`);
  }

  const existingUrls = await loadExistingUrls(profileName);
  console.log(`  Existing URLs loaded: ${existingUrls.size}`);

  const allJobs = [];
  const allSkipped = [];
  const seenCompanyTitle = new Set();
  const seenJobIds = new Set();
  let totalFound = 0;
  let totalFiltered = 0;
  let totalDuped = 0;

  for (const query of config.searches) {
    try {
      console.log(`\n  Searching: "${query.search}"...`);

      let queryJobs = 0;
      for (let page = 0; page < MAX_PAGES; page++) {
        const url = buildSearchUrl(query.search, page);
        const html = await fetchPage(url);
        const jobs = parseJobsFromHtml(html);

        if (jobs.length === 0) {
          if (page === 0) console.log(`    No results found`);
          break;
        }

        if (page === 0) {
          const total = parseTotalCount(html);
          console.log(`    Found: ${total || jobs.length + '+'} total results`);
        }

        for (const job of jobs) {
          if (!job.url) continue;
          totalFound++;

          // Dedup by jobId across queries
          if (job.jobId && seenJobIds.has(job.jobId)) {
            totalDuped++;
            continue; // silent skip for cross-query dedup
          }
          if (job.jobId) seenJobIds.add(job.jobId);

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
        if (queryJobs >= maxPerQuery) break;
      }
    } catch (err) {
      console.error(`    ERROR: ${err.message}`);
      if (err.message.includes('429')) {
        console.error(`    Rate limited \u2014 stopping Aerztestellen scan.`);
        break;
      }
    }
  }

  // Summary
  console.log(`\n  ${'━'.repeat(50)}`);
  console.log(`  Aerztestellen Scan Complete \u2014 ${new Date().toISOString().split('T')[0]}`);
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
