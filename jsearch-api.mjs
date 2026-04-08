#!/usr/bin/env node

/**
 * jsearch-api.mjs — JSearch (RapidAPI) Job Search Scanner
 *
 * Searches JSearch's Google-for-Jobs aggregator across US and DE markets.
 * Pulls from LinkedIn, Indeed, Glassdoor, ZipRecruiter, and thousands more.
 *
 * ADDITIVE source — does NOT replace existing scrapers. Free tier = 200 req/month,
 * so budget is tracked and capped. When exhausted, other scanners carry the load.
 *
 * Usage:
 *   node jsearch-api.mjs [--profile=paulina|lamin] [--dry-run] [--limit=10]
 *
 * Without --profile, reads profiles/active.yml to determine which profile to scan.
 *
 * API docs: https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch
 * Free tier: 200 requests/month (shared across all profiles)
 */

import { readFile, writeFile, appendFile, mkdir } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================
// API Configuration
// ============================================================

const RAPIDAPI_KEY = process.env.JSEARCH_API_KEY || 'e92ec230b9msh9791b32267b9fc8p110efejsn91a99550913a';
const RAPIDAPI_HOST = 'jsearch.p.rapidapi.com';
const API_BASE = `https://${RAPIDAPI_HOST}`;

// Budget: 200 req/month free tier — shared across all profiles
const MONTHLY_BUDGET = 200;
// Per-profile budget split (50/50 between active profiles)
const PROFILE_BUDGETS = {
  paulina: 100,
  lamin: 100,
  josephina: 0, // paused
};

// Rate limiting: 1000 req/hour on free tier, but be conservative
const RATE_LIMIT_MS = 2000;

// ============================================================
// Budget Tracking
// ============================================================

const USAGE_FILE = resolve(__dirname, 'data/jsearch-usage.json');

async function loadUsage() {
  try {
    const raw = await readFile(USAGE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveUsage(usage) {
  await writeFile(USAGE_FILE, JSON.stringify(usage, null, 2), 'utf8');
}

function getMonthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function getProfileUsage(usage, profileName) {
  const month = getMonthKey();
  if (!usage[month]) usage[month] = {};
  if (!usage[month][profileName]) usage[month][profileName] = 0;
  return usage[month][profileName];
}

function getMonthTotal(usage) {
  const month = getMonthKey();
  if (!usage[month]) return 0;
  return Object.values(usage[month]).reduce((sum, n) => sum + n, 0);
}

function incrementUsage(usage, profileName) {
  const month = getMonthKey();
  if (!usage[month]) usage[month] = {};
  if (!usage[month][profileName]) usage[month][profileName] = 0;
  usage[month][profileName]++;
}

// ============================================================
// Search Profiles
// ============================================================

const SEARCH_CONFIGS = {
  paulina: {
    searches: [
      // Georgia — licensed, home base
      { query: 'Psychiatrist in Georgia, USA', label: 'Psychiatrist GA', country: 'us' },
      { query: 'Telepsychiatrist in Georgia, USA', label: 'Telepsychiatrist GA', country: 'us' },
      { query: 'Medical Director Behavioral Health in Georgia, USA', label: 'Medical Director BH GA', country: 'us' },
      { query: 'Psychiatrist remote', label: 'Psychiatrist Remote', country: 'us', remote: true },
      // California — licensed, remote/tele only
      { query: 'Psychiatrist in California, USA', label: 'Psychiatrist CA', country: 'us' },
      { query: 'Telepsychiatrist in California, USA', label: 'Telepsychiatrist CA', country: 'us' },
      // Germany
      { query: 'Psychiater in Germany', label: 'Psychiater DE', country: 'de' },
      { query: 'Facharzt Psychiatrie in Germany', label: 'Facharzt Psychiatrie DE', country: 'de' },
    ],
    locationFilter: [
      'georgia', 'atlanta', 'augusta', 'savannah', 'macon', 'athens',
      'california', 'los angeles', 'san francisco', 'san diego', 'sacramento',
      'remote', 'telehealth', 'telepsych',
    ],
    titlePositive: [
      'psychiatr', 'physician', 'medical director', 'behavioral health', 'mental health',
      'attending', 'clinical director', 'medical officer', 'facharzt', 'oberarzt', 'chefarzt',
    ],
    titleNegative: [
      'nurse', 'nursing', 'social worker', 'psycholog', 'counselor', 'technician',
      'administrative', 'clerk', 'secretary', 'custodian', 'housekeep', 'aide',
      'receptionist', 'billing', 'coder', 'cna', 'lpn', 'rn',
    ],
  },

  lamin: {
    searches: [
      // USA — Atlanta GA + remote
      { query: 'Sales Manager in Atlanta, GA', label: 'Sales Manager Atlanta', country: 'us' },
      { query: 'Account Manager in Atlanta, GA', label: 'Account Manager Atlanta', country: 'us' },
      { query: 'Telecom Sales Manager in Atlanta, GA', label: 'Telecom Sales Atlanta', country: 'us' },
      { query: 'B2B Sales Manager in Atlanta, GA', label: 'B2B Sales Manager Atlanta', country: 'us' },
      { query: 'Account Executive Telecom remote', label: 'AE Telecom Remote', country: 'us', remote: true },
      // Germany — national
      { query: 'Account Manager in Germany', label: 'Account Manager DE', country: 'de' },
      { query: 'Sales Manager Telekommunikation in Germany', label: 'Sales Manager Telekom DE', country: 'de' },
      { query: 'Key Account Manager in Germany', label: 'Key Account Manager DE', country: 'de' },
      { query: 'Business Development Manager in Germany', label: 'BizDev Manager DE', country: 'de' },
    ],
    locationFilter: [
      'atlanta', 'georgia', 'remote', 'work from home', 'telecommute', 'anywhere',
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
// API Client
// ============================================================

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function searchJSearch({ query, page = 1, numPages = 1, datePosted = 'week', remote = false, country }) {
  const params = new URLSearchParams({
    query,
    page: String(page),
    num_pages: String(numPages),
    date_posted: datePosted,
  });
  if (remote) params.set('remote_jobs_only', 'true');
  if (country) params.set('country', country);

  const url = `${API_BASE}/search?${params}`;

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'x-rapidapi-key': RAPIDAPI_KEY,
      'x-rapidapi-host': RAPIDAPI_HOST,
      'Content-Type': 'application/json',
    },
  });

  if (res.status === 429) {
    throw new Error('JSearch rate limit hit (429) — budget may be exhausted');
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`JSearch API ${res.status}: ${text.slice(0, 200)}`);
  }

  return res.json();
}

// ============================================================
// Result Parsing
// ============================================================

function parseResults(data) {
  const results = data?.data || [];

  return {
    count: results.length,
    jobs: results.map(r => {
      const locationParts = [r.job_city, r.job_state, r.job_country].filter(Boolean);
      const locationDisplay = locationParts.join(', ') || '';

      return {
        title: r.job_title || 'Unknown Title',
        company: r.employer_name || 'Unknown Employer',
        location: locationDisplay,
        url: r.job_apply_link || '',
        salaryMin: r.job_min_salary || null,
        salaryMax: r.job_max_salary || null,
        salaryCurrency: r.job_salary_currency || '',
        salaryPeriod: r.job_salary_period || '',
        description: (r.job_description || '').slice(0, 500),
        isRemote: r.job_is_remote || false,
        employmentType: r.job_employment_type || '',
        postedAt: r.job_posted_at_datetime_utc || '',
        publisher: r.job_publisher || '',
        country: r.job_country || '',
      };
    }),
  };
}

function formatSalary(salaryMin, salaryMax, currency, period) {
  if (!salaryMin && !salaryMax) return 'Not disclosed';
  const symbol = (currency === 'EUR' || currency === '\u20AC') ? '\u20AC' : '$';
  const fmt = (n) => Math.round(n).toLocaleString('en-US');
  const periodSuffix = period === 'HOUR' ? '/hr' : period === 'MONTH' ? '/mo' : '/yr';
  if (salaryMin && salaryMax) {
    return `${symbol}${fmt(salaryMin)}-${symbol}${fmt(salaryMax)}${periodSuffix}`;
  }
  if (salaryMin) return `${symbol}${fmt(salaryMin)}+${periodSuffix}`;
  return `Up to ${symbol}${fmt(salaryMax)}${periodSuffix}`;
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
// Location Filtering
// ============================================================

function matchesLocation(job, config, profileName) {
  // DE jobs always pass for profiles that allow Germany
  const countryLower = (job.country || '').toLowerCase();
  if (countryLower === 'de' || countryLower === 'germany' || countryLower === 'deutschland') return true;

  // Remote jobs pass for lamin (remoteUSAllowed)
  if (job.isRemote && profileName === 'lamin') return true;

  if (!config.locationFilter || config.locationFilter.length === 0) return true;

  const locLower = (job.location || '').toLowerCase();
  const titleLower = (job.title || '').toLowerCase();
  const descLower = (job.description || '').toLowerCase();

  const combined = `${locLower} ${titleLower} ${descLower}`;
  return config.locationFilter.some(kw => combined.includes(kw));
}

// ============================================================
// Pipeline Integration (profile-specific)
// ============================================================

async function loadExistingUrls(profileName) {
  const urls = new Set();
  const profileDir = resolve(__dirname, 'profiles', profileName, 'data');

  // Load profile-specific pipeline.md
  try {
    const pipeline = await readFile(resolve(profileDir, 'pipeline.md'), 'utf8');
    for (const match of pipeline.matchAll(/https?:\/\/[^\s|)]+/g)) {
      urls.add(match[0]);
    }
  } catch { /* no pipeline yet */ }

  // Load profile-specific applications.md
  try {
    const apps = await readFile(resolve(profileDir, 'applications.md'), 'utf8');
    for (const match of apps.matchAll(/https?:\/\/[^\s|)]+/g)) {
      urls.add(match[0]);
    }
  } catch { /* no tracker yet */ }

  // Load profile-specific scan-history.tsv
  try {
    const history = await readFile(resolve(profileDir, 'scan-history.tsv'), 'utf8');
    for (const match of history.matchAll(/https?:\/\/[^\s\t]+/g)) {
      urls.add(match[0]);
    }
  } catch { /* no history yet */ }

  // Also load root data/ for cross-dedup
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
    const salary = formatSalary(j.salaryMin, j.salaryMax, j.salaryCurrency, j.salaryPeriod);
    const locationPart = j.location ? ` \u2014 ${j.location}` : '';
    const remoteBadge = j.isRemote ? ' [Remote]' : '';
    return `- [ ] ${j.url} | ${j.company} | ${j.title}${locationPart}${remoteBadge} | ${salary}`;
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
    ...jobs.map(j => `${j.url}\t${date}\tJSearch: ${j.queryLabel}\t${j.title}\t${j.company}\tadded`),
    ...skipped.map(s => `${s.url}\t${date}\tJSearch: ${s.queryLabel}\t${s.title}\t${s.company}\t${s.reason}`),
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
  const limit = limitArg ? parseInt(limitArg.split('=')[1]) : 10;
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

  // Load and check budget
  const usage = await loadUsage();
  const profileUsed = getProfileUsage(usage, profileName);
  const monthTotal = getMonthTotal(usage);
  const profileBudget = PROFILE_BUDGETS[profileName] || 0;
  const monthKey = getMonthKey();

  console.log(`\n  JSearch API Scanner \u2014 Profile: ${profileName}`);
  console.log(`  ${'━'.repeat(50)}`);
  console.log(`  Queries: ${config.searches.length} | Dry run: ${dryRun}`);
  console.log(`  Budget:  ${profileUsed}/${profileBudget} used this month (${monthKey})`);
  console.log(`  Global:  ${monthTotal}/${MONTHLY_BUDGET} total requests this month\n`);

  if (profileBudget === 0) {
    console.log(`  Profile ${profileName} has no JSearch budget — skipping.`);
    return;
  }

  if (monthTotal >= MONTHLY_BUDGET) {
    console.log(`  BUDGET EXHAUSTED: ${monthTotal}/${MONTHLY_BUDGET} requests used this month.`);
    console.log(`  Other scanners will cover. JSearch resets next month.\n`);
    return;
  }

  if (profileUsed >= profileBudget) {
    console.log(`  Profile budget exhausted: ${profileUsed}/${profileBudget} for ${profileName}.`);
    console.log(`  Other scanners will cover. JSearch resets next month.\n`);
    return;
  }

  const remainingBudget = Math.min(profileBudget - profileUsed, MONTHLY_BUDGET - monthTotal);
  console.log(`  Remaining budget: ${remainingBudget} requests\n`);

  const existingUrls = await loadExistingUrls(profileName);
  console.log(`  Existing URLs loaded: ${existingUrls.size}`);

  const allJobs = [];
  const allSkipped = [];
  const seenCompanyTitle = new Set();
  let totalFound = 0;
  let totalFiltered = 0;
  let totalDuped = 0;
  let requestsMade = 0;

  for (const query of config.searches) {
    // Check budget before each request
    if (requestsMade >= remainingBudget) {
      console.log(`\n  Budget cap reached (${requestsMade} requests). Stopping early.`);
      break;
    }

    try {
      console.log(`\n  Searching: "${query.query}"...`);

      const data = await searchJSearch({
        query: query.query,
        page: 1,
        numPages: 1,
        datePosted: 'week',
        remote: query.remote || false,
        country: query.country,
      });

      requestsMade++;
      incrementUsage(usage, profileName);

      const { count, jobs } = parseResults(data);
      console.log(`    Found: ${count} results`);
      totalFound += count;

      for (const job of jobs) {
        if (!job.url) continue;

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

        // Location filter
        if (!matchesLocation(job, config, profileName)) {
          totalFiltered++;
          allSkipped.push({ url: job.url, title: job.title, company: job.company, queryLabel: query.label, reason: 'skipped_location' });
          continue;
        }

        allJobs.push({
          url: job.url,
          title: job.title,
          company: job.company,
          location: job.location,
          salaryMin: job.salaryMin,
          salaryMax: job.salaryMax,
          salaryCurrency: job.salaryCurrency,
          salaryPeriod: job.salaryPeriod,
          isRemote: job.isRemote,
          country: job.country,
          queryLabel: query.label,
        });
        existingUrls.add(job.url);
      }

      await sleep(RATE_LIMIT_MS);
    } catch (err) {
      console.error(`    ERROR: ${err.message}`);
      if (err.message.includes('429')) {
        console.error(`    Rate limited — stopping JSearch scan. Other scanners will cover.`);
        break;
      }
    }
  }

  // Save budget usage
  await saveUsage(usage);

  // Summary
  const updatedProfileUsed = getProfileUsage(usage, profileName);
  const updatedMonthTotal = getMonthTotal(usage);

  console.log(`\n  ${'━'.repeat(50)}`);
  console.log(`  JSearch Scan Complete \u2014 ${new Date().toISOString().split('T')[0]}`);
  console.log(`  ${'━'.repeat(50)}`);
  console.log(`  Queries executed: ${requestsMade}/${config.searches.length}`);
  console.log(`  Total results:    ${totalFound}`);
  console.log(`  Filtered:         ${totalFiltered}`);
  console.log(`  Duplicates:       ${totalDuped}`);
  console.log(`  NEW to pipeline:  ${allJobs.length}`);
  console.log(`  Budget used:      ${updatedProfileUsed}/${profileBudget} (profile) | ${updatedMonthTotal}/${MONTHLY_BUDGET} (global)`);

  if (allJobs.length > 0) {
    console.log(`\n  New jobs:`);
    for (const job of allJobs) {
      const salary = formatSalary(job.salaryMin, job.salaryMax, job.salaryCurrency, job.salaryPeriod);
      const flag = (job.country || '').toLowerCase().includes('us') ? '[US]' :
                   (job.country || '').toLowerCase().includes('de') ? '[DE]' : `[${job.country}]`;
      const remoteBadge = job.isRemote ? ' [R]' : '';
      console.log(`    + ${flag}${remoteBadge} ${job.company} | ${job.title} | ${job.location} | ${salary}`);
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
