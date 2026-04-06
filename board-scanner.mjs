#!/usr/bin/env node

/**
 * board-scanner.mjs — Web Search Board Scanner
 *
 * Executes all site: search queries from the active profile's portals.yml
 * using Google search (via fetch). Covers LinkedIn, Monster, StepStone,
 * Indeed, all German boards, specialty boards, and everything else
 * that has a site: query configured.
 *
 * Also hits Greenhouse and Lever public JSON APIs for tracked companies.
 *
 * Usage:
 *   node board-scanner.mjs [--profile=name] [--dry-run] [--boards-only] [--apis-only]
 *
 * Designed to run AFTER arbeitsagentur-api.mjs and usajobs-api.mjs in scan-all.mjs.
 */

import { readFile, writeFile, appendFile } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const RATE_LIMIT_MS = 2000; // 2s between web searches to avoid rate limits
const ATS_RATE_LIMIT_MS = 500; // 500ms between ATS API calls

// ============================================================
// Portals.yml Parser
// ============================================================

function parsePortalsYml(content) {
  const queries = [];
  const companies = [];

  // Extract search queries (Board — entries)
  const queryRegex = /- name:\s*(.+)\n\s*query:\s*'([^']+)'\n\s*enabled:\s*(true|false)/g;
  let match;
  while ((match = queryRegex.exec(content)) !== null) {
    if (match[3] === 'true') {
      queries.push({ name: match[1].trim(), query: match[2].trim() });
    }
  }

  // Extract tracked companies with careers_url
  const companyRegex = /- name:\s*(.+)\n\s*careers_url:\s*"([^"]+)"\n\s*enabled:\s*(true|false)/g;
  while ((match = companyRegex.exec(content)) !== null) {
    if (match[3] === 'true') {
      const url = match[2].trim();
      let atsType = 'unknown';
      if (url.includes('greenhouse.io')) atsType = 'greenhouse';
      else if (url.includes('lever.co')) atsType = 'lever';
      else if (url.includes('ashbyhq.com')) atsType = 'ashby';
      companies.push({ name: match[1].trim(), careersUrl: url, ats: atsType });
    }
  }

  return { queries, companies };
}

// ============================================================
// Greenhouse Public API
// ============================================================

async function fetchGreenhouseJobs(slug) {
  const url = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.jobs || []).map(j => ({
      title: j.title,
      url: j.absolute_url,
      company: slug,
      location: j.location?.name || '',
      source: 'Greenhouse API',
    }));
  } catch { return []; }
}

function extractGreenhouseSlug(url) {
  // https://boards.greenhouse.io/company or https://job-boards.greenhouse.io/company
  const match = url.match(/greenhouse\.io\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

// ============================================================
// Lever Public API
// ============================================================

async function fetchLeverJobs(slug) {
  const url = `https://api.lever.co/v0/postings/${slug}?mode=json`;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return [];
    const data = await res.json();
    return (data || []).map(j => ({
      title: j.text,
      url: j.hostedUrl,
      company: slug,
      location: j.categories?.location || '',
      source: 'Lever API',
    }));
  } catch { return []; }
}

function extractLeverSlug(url) {
  const match = url.match(/lever\.co\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

// ============================================================
// Web Search via DuckDuckGo HTML (no API key, no CAPTCHA)
// ============================================================

async function webSearch(query) {
  // DuckDuckGo HTML search — no JS, no CAPTCHA, no consent wall.
  // More reliable than Google for automated scraping.
  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

  try {
    const res = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    if (!res.ok) {
      return { results: [], error: `HTTP ${res.status}` };
    }

    const html = await res.text();

    // DuckDuckGo HTML results use class="result__url" or href in result__a
    const results = [];

    // Pattern 1: uddg= parameter in result links
    const uddgRegex = /uddg=(https?%3A%2F%2F[^&"']+)/g;
    let urlMatch;
    while ((urlMatch = uddgRegex.exec(html)) !== null) {
      const url = decodeURIComponent(urlMatch[1]);
      if (!url.includes('duckduckgo.com')) results.push(url);
    }

    // Pattern 2: Direct href in result__a links
    const hrefRegex = /class="result__a"[^>]*href="(https?:\/\/[^"]+)"/g;
    while ((urlMatch = hrefRegex.exec(html)) !== null) {
      results.push(decodeURIComponent(urlMatch[1]));
    }

    // Pattern 3: result__url span text
    const urlTextRegex = /class="result__url"[^>]*>([^<]+)</g;
    while ((urlMatch = urlTextRegex.exec(html)) !== null) {
      const url = urlMatch[1].trim();
      if (url.startsWith('http')) results.push(url);
      else results.push('https://' + url);
    }

    // Extract titles from result__a text
    const titleRegex = /class="result__a"[^>]*>([^<]+)</g;
    const titles = [];
    while ((urlMatch = titleRegex.exec(html)) !== null) {
      titles.push(urlMatch[1].trim());
    }

    const unique = [...new Set(results)];
    return { results: unique, titles, error: null };
  } catch (err) {
    return { results: [], titles: [], error: err.message };
  }
}

// Extract title and company from URL patterns
function parseJobUrl(url) {
  let title = '';
  let company = '';

  // Greenhouse: boards.greenhouse.io/company/jobs/12345
  if (url.includes('greenhouse.io')) {
    const parts = url.match(/greenhouse\.io\/([^/]+)\/jobs\/(\d+)/);
    if (parts) { company = parts[1]; }
  }
  // Lever: jobs.lever.co/company/uuid
  else if (url.includes('lever.co')) {
    const parts = url.match(/lever\.co\/([^/]+)/);
    if (parts) { company = parts[1]; }
  }
  // LinkedIn: linkedin.com/jobs/view/title-at-company-12345
  else if (url.includes('linkedin.com/jobs')) {
    const parts = url.match(/\/jobs\/view\/(.+?)(?:\?|$)/);
    if (parts) {
      const slug = parts[1].replace(/-\d+$/, '').replace(/-/g, ' ');
      const atIdx = slug.lastIndexOf(' at ');
      if (atIdx > 0) {
        title = slug.substring(0, atIdx);
        company = slug.substring(atIdx + 4);
      } else {
        title = slug;
      }
    }
  }
  // Generic: try to get something useful from the URL path
  else {
    const pathParts = new URL(url).pathname.split('/').filter(Boolean);
    if (pathParts.length > 0) {
      title = pathParts[pathParts.length - 1].replace(/[-_]/g, ' ');
    }
    company = new URL(url).hostname.replace('www.', '').split('.')[0];
  }

  return { title, company };
}

// ============================================================
// Title Filtering
// ============================================================

function loadTitleFilter(portalsContent) {
  const positive = [];
  const negative = [];

  // Extract positive keywords
  const posSection = portalsContent.match(/positive:\s*\n((?:\s+- .+\n)+)/);
  if (posSection) {
    const matches = posSection[1].matchAll(/- "(.+?)"/g);
    for (const m of matches) positive.push(m[1].toLowerCase());
  }

  // Extract negative keywords
  const negSection = portalsContent.match(/negative:\s*\n((?:\s+- .+\n)+)/);
  if (negSection) {
    const matches = negSection[1].matchAll(/- "(.+?)"/g);
    for (const m of matches) negative.push(m[1].toLowerCase());
  }

  return { positive, negative };
}

function matchesTitleFilter(title, filter) {
  if (!title || filter.positive.length === 0) return true; // no filter = accept all
  const lower = title.toLowerCase();
  const hasPositive = filter.positive.some(kw => lower.includes(kw));
  if (!hasPositive) return false;
  const hasNegative = filter.negative.some(kw => lower.includes(kw));
  return !hasNegative;
}

// ============================================================
// Pipeline Integration
// ============================================================

async function loadExistingUrls() {
  const urls = new Set();
  for (const file of ['data/pipeline.md', 'data/applications.md', 'data/scan-history.tsv']) {
    try {
      const content = await readFile(resolve(__dirname, file), 'utf8');
      for (const match of content.matchAll(/https?:\/\/[^\s|)\t]+/g)) {
        urls.add(match[0]);
      }
    } catch { /* OK */ }
  }
  return urls;
}

async function appendToPipeline(jobs) {
  if (jobs.length === 0) return;
  const lines = jobs.map(j =>
    `- [ ] ${j.url} | ${j.company} | ${j.title}`
  ).join('\n');

  const pipelinePath = resolve(__dirname, 'data/pipeline.md');
  try {
    const existing = await readFile(pipelinePath, 'utf8');
    if (existing.includes('## Pendientes')) {
      const updated = existing.replace('## Pendientes\n', `## Pendientes\n\n${lines}\n`);
      await writeFile(pipelinePath, updated, 'utf8');
    } else {
      await appendFile(pipelinePath, `\n${lines}\n`, 'utf8');
    }
  } catch {
    await writeFile(pipelinePath, `# Pipeline — Pending URLs\n\n## Pendientes\n\n${lines}\n`, 'utf8');
  }
}

async function appendToScanHistory(jobs, skipped) {
  const historyPath = resolve(__dirname, 'data/scan-history.tsv');
  const date = new Date().toISOString().split('T')[0];
  const lines = [
    ...jobs.map(j => `${j.url}\t${date}\t${j.source}\t${j.title}\t${j.company}\tadded`),
    ...skipped.map(s => `${s.url}\t${date}\t${s.source}\t${s.title}\t${s.company}\t${s.reason}`),
  ].join('\n');

  if (!lines) return;
  try {
    await appendFile(historyPath, `\n${lines}`, 'utf8');
  } catch {
    await writeFile(historyPath, `url\tfirst_seen\tportal\ttitle\tcompany\tstatus\n${lines}\n`, 'utf8');
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============================================================
// Main
// ============================================================

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const boardsOnly = args.includes('--boards-only');
  const apisOnly = args.includes('--apis-only');
  const profileArg = args.find(a => a.startsWith('--profile='));

  let profileName;
  if (profileArg) {
    profileName = profileArg.split('=')[1];
  } else {
    try {
      const yml = await readFile(resolve(__dirname, 'profiles/active.yml'), 'utf8');
      profileName = yml.match(/active:\s*(\w+)/)?.[1] || 'paulina';
    } catch { profileName = 'paulina'; }
  }

  // Load portals.yml
  const portalsPath = resolve(__dirname, `profiles/${profileName}/portals.yml`);
  const portalsContent = await readFile(portalsPath, 'utf8');
  const { queries, companies } = parsePortalsYml(portalsContent);
  const titleFilter = loadTitleFilter(portalsContent);

  console.log(`\n  Board Scanner — Profile: ${profileName}`);
  console.log(`  ${'━'.repeat(50)}`);
  console.log(`  Search queries: ${queries.length}`);
  console.log(`  Tracked companies: ${companies.length}`);
  console.log(`  Title filter: ${titleFilter.positive.length} positive, ${titleFilter.negative.length} negative`);
  console.log(`  Dry run: ${dryRun}\n`);

  const existingUrls = await loadExistingUrls();
  console.log(`  Existing URLs: ${existingUrls.size}`);

  const allJobs = [];
  const allSkipped = [];
  let totalSearched = 0;
  let totalAtsJobs = 0;

  // ── Part 1: ATS APIs (Greenhouse + Lever) ──
  if (!boardsOnly) {
    const ghCompanies = companies.filter(c => c.ats === 'greenhouse');
    const leverCompanies = companies.filter(c => c.ats === 'lever');

    if (ghCompanies.length > 0) {
      console.log(`\n  ── Greenhouse API (${ghCompanies.length} companies) ──`);
      for (const company of ghCompanies) {
        const slug = extractGreenhouseSlug(company.careersUrl);
        if (!slug) continue;
        try {
          const jobs = await fetchGreenhouseJobs(slug);
          let added = 0;
          for (const job of jobs) {
            if (existingUrls.has(job.url)) continue;
            if (!matchesTitleFilter(job.title, titleFilter)) {
              allSkipped.push({ ...job, source: `GH:${slug}`, reason: 'skipped_title' });
              continue;
            }
            job.company = company.name;
            job.source = `GH:${slug}`;
            allJobs.push(job);
            existingUrls.add(job.url);
            added++;
          }
          totalAtsJobs += jobs.length;
          console.log(`    ${company.name}: ${jobs.length} listings, ${added} new`);
          await sleep(ATS_RATE_LIMIT_MS);
        } catch (err) {
          console.error(`    ${company.name}: ERROR — ${err.message}`);
        }
      }
    }

    if (leverCompanies.length > 0) {
      console.log(`\n  ── Lever API (${leverCompanies.length} companies) ──`);
      for (const company of leverCompanies) {
        const slug = extractLeverSlug(company.careersUrl);
        if (!slug) continue;
        try {
          const jobs = await fetchLeverJobs(slug);
          let added = 0;
          for (const job of jobs) {
            if (existingUrls.has(job.url)) continue;
            if (!matchesTitleFilter(job.title, titleFilter)) {
              allSkipped.push({ ...job, source: `LV:${slug}`, reason: 'skipped_title' });
              continue;
            }
            job.company = company.name;
            job.source = `LV:${slug}`;
            allJobs.push(job);
            existingUrls.add(job.url);
            added++;
          }
          totalAtsJobs += jobs.length;
          console.log(`    ${company.name}: ${jobs.length} listings, ${added} new`);
          await sleep(ATS_RATE_LIMIT_MS);
        } catch (err) {
          console.error(`    ${company.name}: ERROR — ${err.message}`);
        }
      }
    }
  }

  // ── Part 2: Web Search Queries (site: filters) ──
  if (!apisOnly) {
    console.log(`\n  ── Web Search Queries (${queries.length} queries) ──`);

    for (let i = 0; i < queries.length; i++) {
      const q = queries[i];
      console.log(`  [${i + 1}/${queries.length}] ${q.name}...`);

      const { results, error } = await webSearch(q.query);

      if (error) {
        console.log(`    ERROR: ${error}`);
        await sleep(RATE_LIMIT_MS);
        continue;
      }

      let added = 0;
      for (const url of results) {
        if (existingUrls.has(url)) continue;

        const parsed = parseJobUrl(url);
        const title = parsed.title || q.name.replace(/^Board (?:DE )?— /, '');
        const company = parsed.company || 'Unknown';

        if (!matchesTitleFilter(title, titleFilter)) {
          allSkipped.push({ url, title, company, source: q.name, reason: 'skipped_title' });
          continue;
        }

        allJobs.push({ url, title, company, source: q.name, location: '' });
        existingUrls.add(url);
        added++;
      }

      totalSearched++;
      if (added > 0) console.log(`    +${added} new results`);

      await sleep(RATE_LIMIT_MS);
    }
  }

  // ── Summary ──
  console.log(`\n  ${'━'.repeat(50)}`);
  console.log(`  Board Scan Complete — ${new Date().toISOString().split('T')[0]}`);
  console.log(`  ${'━'.repeat(50)}`);
  console.log(`  ATS API listings:   ${totalAtsJobs}`);
  console.log(`  Web searches run:   ${totalSearched}`);
  console.log(`  Title-filtered:     ${allSkipped.filter(s => s.reason === 'skipped_title').length}`);
  console.log(`  NEW to pipeline:    ${allJobs.length}`);

  if (allJobs.length > 0) {
    console.log(`\n  New jobs:`);
    for (const job of allJobs.slice(0, 50)) {
      console.log(`    + ${job.company} | ${job.title} | ${job.source}`);
    }
    if (allJobs.length > 50) console.log(`    ... and ${allJobs.length - 50} more`);
  }

  if (!dryRun && allJobs.length > 0) {
    await appendToPipeline(allJobs);
    console.log(`\n  Written to data/pipeline.md`);
  }
  if (!dryRun) {
    await appendToScanHistory(allJobs, allSkipped);
    console.log(`  Written to data/scan-history.tsv`);
  }
  if (dryRun) console.log(`\n  (Dry run — no files written)`);
  console.log('');
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
