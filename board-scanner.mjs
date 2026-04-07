#!/usr/bin/env node

/**
 * board-scanner.mjs — Web Search Board Scanner
 *
 * Executes all site: search queries from the active profile's portals.yml
 * using multi-engine web search (Playwright Bing → Brave API → DuckDuckGo).
 *
 * Also hits Greenhouse and Lever public JSON APIs for tracked companies.
 *
 * Usage:
 *   node board-scanner.mjs [--profile=name] [--dry-run] [--boards-only] [--apis-only]
 *                          [--engine=brave|playwright|ddg] [--limit=N]
 *
 * Designed to run AFTER arbeitsagentur-api.mjs and usajobs-api.mjs in scan-all.mjs.
 */

import { readFile, writeFile, appendFile } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ATS_RATE_LIMIT_MS = 500;       // 500ms between ATS API calls
const BRAVE_RATE_LIMIT_MS = 1100;    // 1.1s between Brave API calls (1/sec limit)
const PLAYWRIGHT_RATE_LIMIT_MS = 3000; // 3s between Playwright searches
const DDG_RATE_LIMIT_MS = 2000;      // 2s between DuckDuckGo searches

// Brave Search API ($5/1000 requests, 1 req/sec)
const BRAVE_API_KEY = 'BSAHO9OA7tbZnxEesEgayDPt0JUAT0E';
const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
const BRAVE_MONTHLY_BUDGET_TOTAL = 10000; // $50/month ÷ $5/1000 = 10,000 queries max
// Per-profile budget split (50/50 between active profiles)
const BRAVE_PROFILE_BUDGETS = {
  paulina: 5000,    // $25/month
  lamin: 5000,      // $25/month
  josephina: 0,     // paused — no resume yet
};

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
// Engine 1: Brave Search API
// ============================================================

let braveQueryCount = 0;

/**
 * Load/save Brave API monthly usage counter — PER PROFILE.
 * Stored in data/brave-usage.json:
 * { month: "2026-04", profiles: { paulina: 123, lamin: 456 }, total: 579 }
 * Resets automatically on new month.
 */
async function loadBraveUsage() {
  const usagePath = resolve(__dirname, 'data/brave-usage.json');
  const currentMonth = new Date().toISOString().slice(0, 7);
  try {
    const raw = await readFile(usagePath, 'utf8');
    const data = JSON.parse(raw);
    if (data.month === currentMonth) return data;
    return { month: currentMonth, profiles: {}, total: 0 };
  } catch { return { month: currentMonth, profiles: {}, total: 0 }; }
}

async function saveBraveUsage(data) {
  const usagePath = resolve(__dirname, 'data/brave-usage.json');
  await writeFile(usagePath, JSON.stringify(data, null, 2), 'utf8');
}

let _braveUsage = null; // loaded lazily
let _currentProfile = null; // set during main()

async function braveSearch(query, limit = 20) {
  // Lazy-load usage data
  if (!_braveUsage) _braveUsage = await loadBraveUsage();

  const profileCount = _braveUsage.profiles[_currentProfile] || 0;
  const profileBudget = BRAVE_PROFILE_BUDGETS[_currentProfile] ?? 0;

  // Per-profile budget cap
  if (profileBudget === 0) {
    return { results: [], error: `Profile "${_currentProfile}" has no Brave budget (paused)` };
  }
  if (profileCount >= profileBudget) {
    return { results: [], error: `Profile "${_currentProfile}" budget cap reached (${profileCount}/${profileBudget} queries, $${(profileCount * 0.005).toFixed(2)}/$${(profileBudget * 0.005).toFixed(2)})` };
  }
  // Total budget cap
  if (_braveUsage.total >= BRAVE_MONTHLY_BUDGET_TOTAL) {
    return { results: [], error: `Total monthly budget cap reached (${_braveUsage.total}/${BRAVE_MONTHLY_BUDGET_TOTAL} queries, $${(_braveUsage.total * 0.005).toFixed(2)}/$50)` };
  }

  const count = Math.min(limit, 20);
  const url = `${BRAVE_ENDPOINT}?q=${encodeURIComponent(query)}&count=${count}`;

  try {
    const res = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': BRAVE_API_KEY,
      },
    });

    if (!res.ok) {
      const status = res.status;
      const text = await res.text().catch(() => '');
      return { results: [], error: `HTTP ${status}: ${text.slice(0, 100)}` };
    }

    braveQueryCount++;
    _braveUsage.profiles[_currentProfile] = (profileCount + 1);
    _braveUsage.total++;
    await saveBraveUsage(_braveUsage);

    const data = await res.json();
    const webResults = data.web?.results || [];
    const results = webResults.map(r => r.url).filter(Boolean);
    return { results, error: null };
  } catch (err) {
    return { results: [], error: err.message };
  }
}

// ============================================================
// Engine 2: Playwright Bing Search (Google CAPTCHAs headless)
// ============================================================

let _browser = null;
let _page = null;

async function launchPlaywrightBrowser() {
  if (_browser) return;
  try {
    const { chromium } = await import('playwright');
    _browser = await chromium.launch({ headless: true });
    const context = await _browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      locale: 'en-US',
    });
    _page = await context.newPage();

    // Navigate to Bing and handle cookie consent
    await _page.goto('https://www.bing.com', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await sleep(1500);
    try {
      const acceptBtn = await _page.$('#bnp_btn_accept');
      if (acceptBtn) {
        await acceptBtn.click();
        await sleep(1000);
      }
    } catch { /* no consent banner — proceed */ }
  } catch (err) {
    _browser = null;
    _page = null;
    throw new Error(`Playwright launch failed: ${err.message}`);
  }
}

async function closePlaywrightBrowser() {
  if (_browser) {
    try { await _browser.close(); } catch { /* ignore */ }
    _browser = null;
    _page = null;
  }
}

/**
 * Decode Bing redirect URLs (bing.com/ck/a?...u=a1{base64}...)
 * Returns the real destination URL.
 */
function decodeBingUrl(bingUrl) {
  try {
    const u = new URL(bingUrl);
    const uParam = u.searchParams.get('u');
    if (uParam && uParam.startsWith('a1')) {
      return Buffer.from(uParam.slice(2), 'base64').toString('utf8');
    }
  } catch { /* not a Bing redirect URL */ }
  return bingUrl;
}

async function playwrightBingSearch(query, limit = 20) {
  try {
    if (!_page) await launchPlaywrightBrowser();

    // Use the search box (direct URL navigation triggers bot detection)
    const searchBox = await _page.$('#sb_form_q');
    if (searchBox) {
      // Clear existing text and type the new query
      await _page.fill('#sb_form_q', '');
      await _page.fill('#sb_form_q', query);
      await _page.press('#sb_form_q', 'Enter');
    } else {
      // Fallback: navigate to Bing home and try again
      await _page.goto('https://www.bing.com', { waitUntil: 'domcontentloaded', timeout: 10000 });
      await sleep(1000);
      await _page.fill('#sb_form_q', query);
      await _page.press('#sb_form_q', 'Enter');
    }

    // Wait for results to render
    await _page.waitForSelector('#b_results li.b_algo', { timeout: 8000 }).catch(() => {});

    // Extract organic search results from Bing
    const rawResults = await _page.evaluate(() => {
      const items = [];
      document.querySelectorAll('#b_results li.b_algo').forEach(li => {
        const a = li.querySelector('h2 a');
        if (a && a.href) {
          items.push({
            href: a.href,
            title: a.textContent || '',
          });
        }
      });
      return items;
    });

    // Decode Bing redirect URLs to real destinations
    const results = rawResults
      .map(r => decodeBingUrl(r.href))
      .filter(url =>
        url.startsWith('http') &&
        !url.includes('bing.com') &&
        !url.includes('microsoft.com') &&
        !url.includes('msn.com')
      );

    return { results: [...new Set(results)], error: null };
  } catch (err) {
    return { results: [], error: err.message };
  }
}

// ============================================================
// Engine 3: DuckDuckGo HTML Fallback
// ============================================================

async function duckDuckGoSearch(query) {
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

    const unique = [...new Set(results)];
    return { results: unique, error: null };
  } catch (err) {
    return { results: [], error: err.message };
  }
}

// ============================================================
// Multi-Engine Web Search (Brave → Playwright → DuckDuckGo)
// ============================================================

async function webSearch(query, forceEngine = null, limit = 20) {
  // If a specific engine is forced, use only that one
  if (forceEngine === 'playwright') {
    return await playwrightBingSearch(query, limit);
  }
  if (forceEngine === 'ddg') {
    return await duckDuckGoSearch(query);
  }
  if (forceEngine === 'brave') {
    return await braveSearch(query, limit);
  }

  // Default cascade: Brave API (fastest, paid) → Playwright Bing (free fallback) → DuckDuckGo
  const braveResult = await braveSearch(query, limit);
  if (braveResult.results.length > 0 && !braveResult.error) return braveResult;

  // Fallback to Playwright Bing
  if (braveResult.error) {
    console.log(`    Brave failed (${braveResult.error}), trying Bing...`);
  } else {
    console.log(`    Brave returned 0 results, trying Bing...`);
  }
  const bingResult = await playwrightBingSearch(query, limit);
  if (bingResult.results.length > 0 && !bingResult.error) return bingResult;

  // Last resort: DuckDuckGo
  if (bingResult.error) {
    console.log(`    Bing failed (${bingResult.error}), trying DuckDuckGo...`);
  } else {
    console.log(`    Bing returned 0 results, trying DuckDuckGo...`);
  }
  return await duckDuckGoSearch(query);
}

// Rate limit delay based on which engine was used or forced
function getRateLimitMs(forceEngine) {
  if (forceEngine === 'playwright') return PLAYWRIGHT_RATE_LIMIT_MS;
  if (forceEngine === 'ddg') return DDG_RATE_LIMIT_MS;
  // Default/brave — fastest since it's a paid API
  return BRAVE_RATE_LIMIT_MS;
}

// ============================================================
// Extract title and company from URL patterns
// ============================================================

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
    try {
      const pathParts = new URL(url).pathname.split('/').filter(Boolean);
      if (pathParts.length > 0) {
        title = pathParts[pathParts.length - 1].replace(/[-_]/g, ' ');
      }
      company = new URL(url).hostname.replace('www.', '').split('.')[0];
    } catch { /* malformed URL */ }
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
  const engineArg = args.find(a => a.startsWith('--engine='));
  const limitArg = args.find(a => a.startsWith('--limit='));

  const forceEngine = engineArg ? engineArg.split('=')[1] : null;
  const resultLimit = limitArg ? parseInt(limitArg.split('=')[1], 10) : 20;

  if (forceEngine && !['brave', 'playwright', 'ddg'].includes(forceEngine)) {
    console.error(`  Invalid engine: ${forceEngine}. Use brave, playwright, or ddg.`);
    process.exit(1);
  }

  let profileName;
  if (profileArg) {
    profileName = profileArg.split('=')[1];
  } else {
    try {
      const yml = await readFile(resolve(__dirname, 'profiles/active.yml'), 'utf8');
      profileName = yml.match(/active:\s*(\w+)/)?.[1] || 'paulina';
    } catch { profileName = 'paulina'; }
  }

  // Set current profile for Brave budget tracking
  _currentProfile = profileName;

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
  console.log(`  Search engine: ${forceEngine || 'auto (brave → bing → ddg)'}`);
  console.log(`  Results limit: ${resultLimit}`);
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

    // Pre-launch Playwright for Bing search (auto mode or playwright-forced)
    // In auto mode, Playwright is the fallback; pre-launching saves time if Brave fails
    if (!forceEngine || forceEngine === 'playwright') {
      try {
        console.log(`  Pre-launching Playwright browser (Bing fallback)...`);
        await launchPlaywrightBrowser();
      } catch (err) {
        console.error(`  Playwright unavailable: ${err.message}`);
        if (forceEngine === 'playwright') {
          console.error(`  Cannot continue with --engine=playwright.`);
          process.exit(1);
        }
        console.error(`  Will use Brave API only.`);
      }
    }

    for (let i = 0; i < queries.length; i++) {
      const q = queries[i];
      console.log(`  [${i + 1}/${queries.length}] ${q.name}...`);

      const { results, error } = await webSearch(q.query, forceEngine, resultLimit);

      if (error) {
        console.log(`    ERROR: ${error}`);
        await sleep(getRateLimitMs(forceEngine));
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

      await sleep(getRateLimitMs(forceEngine));
    }

    // Clean up Playwright browser if it was launched
    await closePlaywrightBrowser();
  }

  // ── Summary ──
  console.log(`\n  ${'━'.repeat(50)}`);
  console.log(`  Board Scan Complete — ${new Date().toISOString().split('T')[0]}`);
  console.log(`  ${'━'.repeat(50)}`);
  console.log(`  ATS API listings:   ${totalAtsJobs}`);
  console.log(`  Web searches run:   ${totalSearched}`);
  const usage = _braveUsage || await loadBraveUsage();
  const profileUsed = usage.profiles[profileName] || 0;
  const profileBudget = BRAVE_PROFILE_BUDGETS[profileName] ?? 0;
  console.log(`  Brave API calls:    ${braveQueryCount} this session | ${profileName}: ${profileUsed}/${profileBudget} ($${(profileUsed * 0.005).toFixed(2)}/$${(profileBudget * 0.005).toFixed(2)}) | total: ${usage.total}/${BRAVE_MONTHLY_BUDGET_TOTAL} ($${(usage.total * 0.005).toFixed(2)}/$50)`);
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
