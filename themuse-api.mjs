#!/usr/bin/env node

/**
 * themuse-api.mjs — The Muse Job Search API Scanner
 *
 * Searches The Muse's curated job listings — US corporate/startup focus + Germany.
 * Free API, no auth required (500 req/hr without key, 3600 with key).
 *
 * ADDITIVE source — supplements existing scrapers with curated corporate/startup jobs.
 *
 * Usage:
 *   node themuse-api.mjs [--profile=paulina|lamin] [--dry-run] [--limit=20]
 *
 * Without --profile, reads profiles/active.yml to determine which profile to scan.
 *
 * API docs: https://www.themuse.com/developers/api/v2
 * Rate limit: 500 req/hr (no key), 3600 req/hr (with key)
 */

import { readFile, writeFile, appendFile } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================
// API Configuration
// ============================================================

const API_BASE = 'https://www.themuse.com/api/public/jobs';

// No API key needed for free tier (500 req/hr is plenty for a scanner)
const RATE_LIMIT_MS = 1500;
const MAX_PAGES = 3; // 20 results/page, 3 pages = 60 results per search

// ============================================================
// Search Profiles
// ============================================================

const SEARCH_CONFIGS = {
  paulina: {
    searches: [
      // Georgia — healthcare
      { category: 'Healthcare', location: 'Atlanta, GA', label: 'Healthcare Atlanta' },
      { category: 'Healthcare', location: 'Georgia', label: 'Healthcare GA' },
      // California — healthcare
      { category: 'Healthcare', location: 'California', label: 'Healthcare CA' },
      { category: 'Healthcare', location: 'Los Angeles, CA', label: 'Healthcare LA' },
      { category: 'Healthcare', location: 'San Francisco, CA', label: 'Healthcare SF' },
      // Germany
      { category: 'Healthcare', location: 'Germany', label: 'Healthcare DE' },
      // Science/medical adjacent
      { category: 'Science and Engineering', location: 'Atlanta, GA', label: 'Science Atlanta' },
    ],
    titlePositive: [
      'psychiatr', 'physician', 'medical director', 'behavioral health', 'mental health',
      'attending', 'clinical director', 'medical officer', 'facharzt', 'oberarzt', 'chefarzt',
      'doctor', 'md', 'health', 'clinical', 'medical',
    ],
    titleNegative: [
      'nurse', 'nursing', 'social worker', 'psycholog', 'counselor', 'technician',
      'administrative', 'clerk', 'secretary', 'custodian', 'housekeep', 'aide',
      'receptionist', 'billing', 'coder', 'cna', 'lpn', 'rn', 'pharmacy',
      'veterinar', 'dental', 'optom',
    ],
  },

  lamin: {
    searches: [
      // USA — Atlanta GA
      { category: 'Sales', location: 'Atlanta, GA', label: 'Sales Atlanta' },
      { category: 'Business Development', location: 'Atlanta, GA', label: 'BizDev Atlanta' },
      { category: 'Account Management', location: 'Atlanta, GA', label: 'Account Mgmt Atlanta' },
      // Georgia wider
      { category: 'Sales', location: 'Georgia', label: 'Sales GA' },
      // Germany
      { category: 'Sales', location: 'Germany', label: 'Sales DE' },
      { category: 'Business Development', location: 'Germany', label: 'BizDev DE' },
      { category: 'Account Management', location: 'Germany', label: 'Account Mgmt DE' },
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

async function searchMuse({ category, location, page = 0 }) {
  const params = new URLSearchParams({ page: String(page) });
  if (category) params.set('category', category);
  if (location) params.set('location', location);

  const url = `${API_BASE}?${params}`;

  const res = await fetch(url);

  if (res.status === 403) {
    throw new Error('The Muse rate limit hit (403)');
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`The Muse API ${res.status}: ${text.slice(0, 200)}`);
  }

  return res.json();
}

// ============================================================
// Result Parsing
// ============================================================

function parseResults(data) {
  const results = data?.results || [];

  return {
    total: data?.total || 0,
    pageCount: data?.page_count || 0,
    jobs: results.map(r => {
      const locationNames = (r.locations || []).map(l => l.name).join(', ');
      const levels = (r.levels || []).map(l => l.name).join(', ');
      const categories = (r.categories || []).map(c => c.name).join(', ');

      return {
        title: r.name || 'Unknown Title',
        company: r.company?.name || 'Unknown Employer',
        location: locationNames,
        url: r.refs?.landing_page || '',
        publishedAt: r.publication_date || '',
        level: levels,
        category: categories,
      };
    }),
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
    const levelPart = j.level ? ` [${j.level}]` : '';
    return `- [ ] ${j.url} | ${j.company} | ${j.title}${locationPart}${levelPart} | Not disclosed`;
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
    ...jobs.map(j => `${j.url}\t${date}\tTheMuse: ${j.queryLabel}\t${j.title}\t${j.company}\tadded`),
    ...skipped.map(s => `${s.url}\t${date}\tTheMuse: ${s.queryLabel}\t${s.title}\t${s.company}\t${s.reason}`),
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

  console.log(`\n  The Muse API Scanner \u2014 Profile: ${profileName}`);
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
      console.log(`\n  Searching: ${query.category} in ${query.location}...`);

      let queryJobs = 0;
      for (let page = 0; page < MAX_PAGES; page++) {
        const data = await searchMuse({
          category: query.category,
          location: query.location,
          page,
        });

        const { total, jobs } = parseResults(data);

        if (page === 0) {
          console.log(`    Found: ${total} total results`);
        }

        if (jobs.length === 0) break;

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
            level: job.level,
            queryLabel: query.label,
          });
          existingUrls.add(job.url);
          queryJobs++;
        }

        await sleep(RATE_LIMIT_MS);

        // Stop paging if we've got enough or no more pages
        if (queryJobs >= maxPerQuery) break;
        if (page + 1 >= data.page_count) break;
      }
    } catch (err) {
      console.error(`    ERROR: ${err.message}`);
      if (err.message.includes('403')) {
        console.error(`    Rate limited — stopping The Muse scan.`);
        break;
      }
    }
  }

  // Summary
  console.log(`\n  ${'━'.repeat(50)}`);
  console.log(`  The Muse Scan Complete \u2014 ${new Date().toISOString().split('T')[0]}`);
  console.log(`  ${'━'.repeat(50)}`);
  console.log(`  Queries executed: ${config.searches.length}`);
  console.log(`  Total results:    ${totalFound}`);
  console.log(`  Filtered:         ${totalFiltered}`);
  console.log(`  Duplicates:       ${totalDuped}`);
  console.log(`  NEW to pipeline:  ${allJobs.length}`);

  if (allJobs.length > 0) {
    console.log(`\n  New jobs:`);
    for (const job of allJobs) {
      const isDE = (job.location || '').toLowerCase().match(/germany|deutschland|berlin|munich|münchen|hamburg|frankfurt/);
      const flag = isDE ? '[DE]' : '[US]';
      const lvl = job.level ? ` (${job.level})` : '';
      console.log(`    + ${flag} ${job.company} | ${job.title} | ${job.location}${lvl}`);
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
