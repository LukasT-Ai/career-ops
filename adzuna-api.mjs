#!/usr/bin/env node

/**
 * adzuna-api.mjs — Adzuna Job Search API Scanner
 *
 * Searches Adzuna's aggregated job listings across US and DE markets.
 * Private-sector jobs — ideal for non-federal candidates.
 *
 * Usage:
 *   node adzuna-api.mjs [--profile=paulina|lamin] [--dry-run] [--limit=10]
 *
 * Without --profile, reads profiles/active.yml to determine which profile to scan.
 *
 * API docs: https://developer.adzuna.com/docs
 * Rate limit: ~250 req/day (free tier)
 */

import { readFile, writeFile, appendFile } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================
// API Configuration
// ============================================================

const ADZUNA_APP_ID = process.env.ADZUNA_APP_ID || '328e55da';
const ADZUNA_APP_KEY = process.env.ADZUNA_APP_KEY || '0344f6412a3fff1cc40d7d4ac816a588';
const API_BASE = 'https://api.adzuna.com/v1/api/jobs';

// Rate limiting: ~250/day → be conservative, 1.5s between requests
const RATE_LIMIT_MS = 1500;

// ============================================================
// Search Profiles
// ============================================================

const SEARCH_CONFIGS = {
  paulina: {
    searches: [
      // Georgia — licensed, home base
      { country: 'us', what: 'Psychiatrist', where: 'Georgia', label: 'Psychiatrist GA' },
      { country: 'us', what: 'Mental Health Physician', where: 'Georgia', label: 'Mental Health Physician GA' },
      { country: 'us', what: 'Behavioral Health Psychiatrist', where: 'Georgia', label: 'Behavioral Health Psychiatrist GA' },
      { country: 'us', what: 'Medical Director Behavioral Health', where: 'Georgia', label: 'Medical Director BH GA' },
      { country: 'us', what: 'Telepsychiatrist', where: 'Georgia', label: 'Telepsychiatrist GA' },
      // California — licensed, remote/tele only
      { country: 'us', what: 'Psychiatrist', where: 'California', label: 'Psychiatrist CA' },
      { country: 'us', what: 'Telepsychiatrist', where: 'California', label: 'Telepsychiatrist CA' },
      { country: 'us', what: 'Mental Health Physician', where: 'California', label: 'Mental Health Physician CA' },
      { country: 'us', what: 'Behavioral Health Psychiatrist', where: 'California', label: 'Behavioral Health Psychiatrist CA' },
    ],
    locationFilter: [
      'georgia', 'atlanta', 'augusta', 'savannah', 'macon', 'athens',
      'california', 'los angeles', 'san francisco', 'san diego', 'sacramento',
      'remote', 'telehealth', 'telepsych',
    ],
    titlePositive: [
      'psychiatr', 'physician', 'medical director', 'behavioral health', 'mental health',
      'attending', 'clinical director', 'medical officer',
    ],
    titleNegative: [
      'nurse', 'nursing', 'social worker', 'psycholog', 'counselor', 'technician',
      'administrative', 'clerk', 'secretary', 'custodian', 'housekeep', 'aide',
      'receptionist', 'billing', 'coder', 'cna', 'lpn', 'rn',
    ],
  },

  lamin: {
    searches: [
      // USA — Atlanta GA + remote (private sector, NOT federal)
      { country: 'us', what: 'Sales Manager', where: 'Atlanta, GA', label: 'Sales Manager Atlanta' },
      { country: 'us', what: 'Account Manager', where: 'Atlanta, GA', label: 'Account Manager Atlanta' },
      { country: 'us', what: 'Telecom Sales', where: 'Atlanta, GA', label: 'Telecom Sales Atlanta' },
      { country: 'us', what: 'B2B Sales Manager', where: 'Atlanta, GA', label: 'B2B Sales Manager Atlanta' },
      { country: 'us', what: 'Account Executive Telecom', where: 'Atlanta, GA', label: 'AE Telecom Atlanta' },
      { country: 'us', what: 'Sales Manager Telecommunications', where: 'Georgia', label: 'Sales Manager Telecom GA' },
      { country: 'us', what: 'Account Manager', what_or: 'remote telecom', where: '', label: 'Account Manager Remote Telecom' },
      { country: 'us', what: 'B2B Sales', what_or: 'remote telecommunications', where: '', label: 'B2B Sales Remote Telecom' },
      // Germany — national (no location restriction)
      { country: 'de', what: 'Account Manager', where: '', label: 'Account Manager DE' },
      { country: 'de', what: 'Vertrieb Telekommunikation', where: '', label: 'Vertrieb Telekom DE' },
      { country: 'de', what: 'Sales Manager', where: '', label: 'Sales Manager DE' },
      { country: 'de', what: 'Key Account Manager', where: '', label: 'Key Account Manager DE' },
      { country: 'de', what: 'B2B Sales', where: '', label: 'B2B Sales DE' },
      { country: 'de', what: 'Business Development Manager', where: '', label: 'BizDev Manager DE' },
    ],
    locationFilter: [
      // US: Atlanta/GA + remote
      'atlanta', 'georgia', 'remote', 'work from home', 'telecommute', 'anywhere',
      // DE: all of Germany is fine — no location restriction
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

async function searchAdzuna({ country, what, where, what_or, category, limit = 10, page = 1 }) {
  const params = new URLSearchParams({
    app_id: ADZUNA_APP_ID,
    app_key: ADZUNA_APP_KEY,
    results_per_page: String(limit),
  });
  if (what) params.set('what', what);
  if (where) params.set('where', where);
  if (what_or) params.set('what_or', what_or);
  if (category) params.set('category', category);

  const url = `${API_BASE}/${country}/search/${page}?${params}`;

  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Adzuna API ${res.status}: ${text.slice(0, 200)}`);
  }

  return res.json();
}

// ============================================================
// Result Parsing
// ============================================================

function parseResults(data, country) {
  const results = data?.results || [];
  const count = data?.count || 0;

  return {
    count,
    jobs: results.map(r => {
      const locationParts = r.location?.area || [];
      const locationDisplay = r.location?.display_name || locationParts.join(', ') || '';

      return {
        title: r.title || 'Unknown Title',
        company: r.company?.display_name || 'Unknown Employer',
        location: locationDisplay,
        url: r.redirect_url || '',
        salaryMin: r.salary_min || null,
        salaryMax: r.salary_max || null,
        description: r.description || '',
        created: r.created || '',
        category: r.category?.label || '',
        country,
      };
    }),
  };
}

function formatSalary(salaryMin, salaryMax, country) {
  if (!salaryMin && !salaryMax) return 'Not disclosed';
  const symbol = country === 'de' ? '\u20AC' : '$';
  const fmt = (n) => Math.round(n).toLocaleString('en-US');
  if (salaryMin && salaryMax) {
    return `${symbol}${fmt(salaryMin)}-${symbol}${fmt(salaryMax)}`;
  }
  if (salaryMin) return `${symbol}${fmt(salaryMin)}+`;
  return `Up to ${symbol}${fmt(salaryMax)}`;
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

function matchesLocation(job, config) {
  // DE jobs from Adzuna always pass — Lamin has no DE location restriction
  if (job.country === 'de') return true;

  if (!config.locationFilter || config.locationFilter.length === 0) return true;

  const locLower = (job.location || '').toLowerCase();
  const titleLower = (job.title || '').toLowerCase();
  const descLower = (job.description || '').toLowerCase().slice(0, 500);

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
    const salary = formatSalary(j.salaryMin, j.salaryMax, j.country);
    const locationPart = j.location ? ` \u2014 ${j.location}` : '';
    return `- [ ] ${j.url} | ${j.company} | ${j.title}${locationPart} | ${salary}`;
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
    ...jobs.map(j => `${j.url}\t${date}\tAdzuna: ${j.queryLabel}\t${j.title}\t${j.company}\tadded`),
    ...skipped.map(s => `${s.url}\t${date}\tAdzuna: ${s.queryLabel}\t${s.title}\t${s.company}\t${s.reason}`),
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

  // Validate API credentials
  if (ADZUNA_APP_ID === 'ADZUNA_APP_ID' || ADZUNA_APP_KEY === 'ADZUNA_APP_KEY') {
    console.warn('\n  WARNING: ADZUNA_APP_ID and/or ADZUNA_APP_KEY env vars not set.');
    console.warn('  Sign up at https://developer.adzuna.com/ to get credentials.');
    console.warn('  Set them: export ADZUNA_APP_ID=xxx && export ADZUNA_APP_KEY=yyy\n');
  }

  console.log(`\n  Adzuna API Scanner \u2014 Profile: ${profileName}`);
  console.log(`  ${'\u2501'.repeat(50)}`);
  console.log(`  Queries: ${config.searches.length} | Limit: ${limit}/query | Dry run: ${dryRun}\n`);

  const existingUrls = await loadExistingUrls(profileName);
  console.log(`  Existing URLs loaded: ${existingUrls.size}`);

  const allJobs = [];
  const allSkipped = [];
  const seenCompanyTitle = new Set(); // dedup by company+title combo
  let totalFound = 0;
  let totalFiltered = 0;
  let totalDuped = 0;

  for (const query of config.searches) {
    try {
      const locLabel = query.where ? `in ${query.where}` : '(national)';
      console.log(`\n  Searching [${query.country.toUpperCase()}]: "${query.what}" ${locLabel}...`);

      const data = await searchAdzuna({
        country: query.country,
        what: query.what,
        where: query.where,
        what_or: query.what_or,
        category: query.category,
        limit,
      });

      const { count, jobs } = parseResults(data, query.country);
      console.log(`    Found: ${jobs.length} results (${count} total available)`);
      totalFound += jobs.length;

      for (const job of jobs) {
        if (!job.url) continue;

        // Dedup against existing pipeline URLs
        if (existingUrls.has(job.url)) {
          totalDuped++;
          allSkipped.push({ url: job.url, title: job.title, company: job.company, queryLabel: query.label, reason: 'skipped_dup_url' });
          continue;
        }

        // Dedup by company+title combo (catches same job posted via different URLs)
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
        if (!matchesLocation(job, config)) {
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
          country: job.country,
          queryLabel: query.label,
        });
        existingUrls.add(job.url);
      }

      await sleep(RATE_LIMIT_MS);
    } catch (err) {
      console.error(`    ERROR: ${err.message}`);
    }
  }

  // Summary
  console.log(`\n  ${'\u2501'.repeat(50)}`);
  console.log(`  Adzuna Scan Complete \u2014 ${new Date().toISOString().split('T')[0]}`);
  console.log(`  ${'\u2501'.repeat(50)}`);
  console.log(`  Queries executed: ${config.searches.length}`);
  console.log(`  Total results:    ${totalFound}`);
  console.log(`  Filtered:         ${totalFiltered}`);
  console.log(`  Duplicates:       ${totalDuped}`);
  console.log(`  NEW to pipeline:  ${allJobs.length}`);

  if (allJobs.length > 0) {
    console.log(`\n  New jobs:`);
    for (const job of allJobs) {
      const salary = formatSalary(job.salaryMin, job.salaryMax, job.country);
      const flag = job.country === 'de' ? '[DE]' : '[US]';
      console.log(`    + ${flag} ${job.company} | ${job.title} | ${job.location} | ${salary}`);
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
