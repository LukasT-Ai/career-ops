#!/usr/bin/env node

/**
 * jobsearch15-api.mjs — Job Search API (jaypat87/RapidAPI) Scanner
 *
 * Searches LinkedIn job listings via the job-search15 RapidAPI endpoint.
 * Returns LinkedIn job URLs with company, location, and posting date.
 *
 * ADDITIVE source — does NOT replace existing scrapers. Free tier = 50 req/month,
 * so budget is tracked and capped. When exhausted, other scanners carry the load.
 *
 * Usage:
 *   node jobsearch15-api.mjs [--profile=paulina|lamin] [--dry-run] [--limit=10]
 *
 * Without --profile, reads profiles/active.yml to determine which profile to scan.
 *
 * API: https://rapidapi.com/jaypat87/api/job-search15
 * Free tier: 50 requests/month (shared across all profiles)
 */

import { readFile, writeFile, appendFile } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================
// API Configuration
// ============================================================

const RAPIDAPI_KEY = process.env.JOBSEARCH15_API_KEY || 'e92ec230b9msh9791b32267b9fc8p110efejsn91a99550913a';
const RAPIDAPI_HOST = 'job-search15.p.rapidapi.com';
const API_URL = `https://${RAPIDAPI_HOST}/`;

// Budget: 50 req/month free tier — shared across all profiles
const MONTHLY_BUDGET = 50;
const PROFILE_BUDGETS = {
  paulina: 25,
  lamin: 25,
  josephina: 0, // paused
};

// Rate limiting: be conservative with free tier
const RATE_LIMIT_MS = 2500;

// ============================================================
// Budget Tracking
// ============================================================

const USAGE_FILE = resolve(__dirname, 'data/jobsearch15-usage.json');

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
      { terms: 'Psychiatrist', location: 'Georgia', label: 'Psychiatrist GA' },
      { terms: 'Telepsychiatrist', location: 'Georgia', label: 'Telepsychiatrist GA' },
      { terms: 'Medical Director Behavioral Health', location: 'Georgia', label: 'Medical Director BH GA' },
      { terms: 'Mental Health Physician', location: 'Georgia', label: 'Mental Health Physician GA' },
      // California — licensed, remote/tele only
      { terms: 'Psychiatrist', location: 'California', label: 'Psychiatrist CA' },
      { terms: 'Telepsychiatrist', location: 'California', label: 'Telepsychiatrist CA' },
      // Germany
      { terms: 'Psychiater', location: 'Germany', label: 'Psychiater DE' },
      { terms: 'Facharzt Psychiatrie', location: 'Germany', label: 'Facharzt Psychiatrie DE' },
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
      { terms: 'Sales Manager', location: 'Atlanta, GA', label: 'Sales Manager Atlanta' },
      { terms: 'Account Manager', location: 'Atlanta, GA', label: 'Account Manager Atlanta' },
      { terms: 'Telecom Sales', location: 'Atlanta, GA', label: 'Telecom Sales Atlanta' },
      { terms: 'B2B Sales Manager', location: 'Atlanta, GA', label: 'B2B Sales Manager Atlanta' },
      { terms: 'Account Executive', location: 'Atlanta, GA', label: 'AE Atlanta' },
      // Germany — national
      { terms: 'Account Manager', location: 'Germany', label: 'Account Manager DE' },
      { terms: 'Sales Manager Telekommunikation', location: 'Germany', label: 'Sales Manager Telekom DE' },
      { terms: 'Key Account Manager', location: 'Germany', label: 'Key Account Manager DE' },
      { terms: 'Business Development Manager', location: 'Germany', label: 'BizDev Manager DE' },
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

async function searchJobs({ searchTerms, location, page = '1' }) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'x-rapidapi-key': RAPIDAPI_KEY,
      'x-rapidapi-host': RAPIDAPI_HOST,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      api_type: 'fetch_jobs',
      search_terms: searchTerms,
      location,
      page,
    }),
  });

  if (res.status === 429) {
    throw new Error('JobSearch15 rate limit hit (429) — budget may be exhausted');
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`JobSearch15 API ${res.status}: ${text.slice(0, 200)}`);
  }

  return res.json();
}

// ============================================================
// Result Parsing
// ============================================================

function parseResults(data) {
  // API returns a plain array of job objects
  const results = Array.isArray(data) ? data : [];

  return {
    count: results.length,
    jobs: results.map(r => ({
      title: r.job_title || 'Unknown Title',
      company: r.company_name || 'Unknown Employer',
      location: r.location || '',
      url: r.job_url || '',
      postedDate: r.posted_date || '',
      linkedinCompanyUrl: r.linkedin_company_profile_url || '',
    })),
  };
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
    ...jobs.map(j => `${j.url}\t${date}\tJobSearch15: ${j.queryLabel}\t${j.title}\t${j.company}\tadded`),
    ...skipped.map(s => `${s.url}\t${date}\tJobSearch15: ${s.queryLabel}\t${s.title}\t${s.company}\t${s.reason}`),
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

  console.log(`\n  JobSearch15 API Scanner \u2014 Profile: ${profileName}`);
  console.log(`  ${'━'.repeat(50)}`);
  console.log(`  Queries: ${config.searches.length} | Dry run: ${dryRun}`);
  console.log(`  Budget:  ${profileUsed}/${profileBudget} used this month (${monthKey})`);
  console.log(`  Global:  ${monthTotal}/${MONTHLY_BUDGET} total requests this month\n`);

  if (profileBudget === 0) {
    console.log(`  Profile ${profileName} has no JobSearch15 budget — skipping.`);
    return;
  }

  if (monthTotal >= MONTHLY_BUDGET) {
    console.log(`  BUDGET EXHAUSTED: ${monthTotal}/${MONTHLY_BUDGET} requests used this month.`);
    console.log(`  Other scanners will cover. Resets next month.\n`);
    return;
  }

  if (profileUsed >= profileBudget) {
    console.log(`  Profile budget exhausted: ${profileUsed}/${profileBudget} for ${profileName}.`);
    console.log(`  Other scanners will cover. Resets next month.\n`);
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
      console.log(`\n  Searching: "${query.terms}" in ${query.location}...`);

      const data = await searchJobs({
        searchTerms: query.terms,
        location: query.location,
        page: '1',
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

        allJobs.push({
          url: job.url,
          title: job.title,
          company: job.company,
          location: job.location,
          postedDate: job.postedDate,
          queryLabel: query.label,
        });
        existingUrls.add(job.url);
      }

      await sleep(RATE_LIMIT_MS);
    } catch (err) {
      console.error(`    ERROR: ${err.message}`);
      if (err.message.includes('429')) {
        console.error(`    Rate limited — stopping scan. Other scanners will cover.`);
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
  console.log(`  JobSearch15 Scan Complete \u2014 ${new Date().toISOString().split('T')[0]}`);
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
      const isDE = (job.location || '').toLowerCase().match(/germany|deutschland|berlin|munich|münchen|hamburg|frankfurt/);
      const flag = isDE ? '[DE]' : '[US]';
      console.log(`    + ${flag} ${job.company} | ${job.title} | ${job.location}`);
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
