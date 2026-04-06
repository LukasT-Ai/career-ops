#!/usr/bin/env node

/**
 * arbeitsagentur-api.mjs — Bundesagentur für Arbeit Job Search API Scanner
 *
 * Free public API, no registration required.
 * Searches Germany's largest job database (1M+ listings) for all profiles.
 *
 * Usage:
 *   node arbeitsagentur-api.mjs [--profile=paulina|lamin|josephina] [--dry-run] [--limit=25]
 *
 * Without --profile, reads profiles/active.yml to determine which profile to scan.
 * --dry-run prints results without writing to pipeline.md
 * --limit sets max results per query (default 25, max 100)
 *
 * API docs: https://github.com/bundesAPI/jobsuche-api
 */

import { readFile, writeFile, appendFile } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================
// API Configuration
// ============================================================

const API_BASE = 'https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v4';
const API_KEY = 'jobboerse-jobsuche';
const HEADERS = {
  'X-API-Key': API_KEY,
  'Accept': 'application/json',
};

// Rate limiting: ~60 req/min safe → 1 req/sec
const RATE_LIMIT_MS = 1000;

// ============================================================
// Search Profiles — keywords and locations per career type
// ============================================================

const SEARCH_CONFIGS = {
  paulina: {
    queries: [
      { was: 'Psychiater', wo: '', label: 'Psychiater (national)' },
      { was: 'Facharzt Psychiatrie', wo: '', label: 'Facharzt Psychiatrie' },
      { was: 'Fachärztin Psychiatrie', wo: '', label: 'Fachärztin Psychiatrie' },
      { was: 'Oberarzt Psychiatrie', wo: '', label: 'Oberarzt Psychiatrie' },
      { was: 'Oberärztin Psychiatrie', wo: '', label: 'Oberärztin Psychiatrie' },
      { was: 'Assistenzarzt Psychiatrie', wo: '', label: 'Assistenzarzt Psychiatrie' },
      { was: 'Chefarzt Psychiatrie', wo: '', label: 'Chefarzt Psychiatrie' },
      { was: 'Psychiatrie Psychotherapie', wo: '', label: 'Psychiatrie und Psychotherapie' },
      { was: 'Arzt Psychosomatik', wo: '', label: 'Arzt Psychosomatik' },
      { was: 'Arzt Neurologie Psychiatrie', wo: '', label: 'Neurologie/Psychiatrie' },
    ],
    titlePositive: [
      'psychiater', 'psychiatrie', 'facharzt', 'fachärztin', 'oberarzt', 'oberärztin',
      'chefarzt', 'chefärztin', 'assistenzarzt', 'assistenzärztin', 'arzt', 'ärztin',
      'psychosomatik', 'neurologie', 'klinik', 'physician', 'psychiatrist',
    ],
    titleNegative: [
      'krankenpfleger', 'pflegekraft', 'pflege', 'therapeut', 'psycholog',
      'sozialarbeiter', 'ergotherap', 'heilerziehung',
    ],
  },

  lamin: {
    queries: [
      { was: 'Account Manager Telekommunikation', wo: '', label: 'Account Manager Telekom' },
      { was: 'Vertrieb Telekommunikation', wo: '', label: 'Vertrieb Telekom' },
      { was: 'Key Account Manager IT', wo: '', label: 'Key Account IT' },
      { was: 'Account Executive IT', wo: '', label: 'Account Executive IT' },
      { was: 'Sales Manager Telekommunikation', wo: '', label: 'Sales Manager Telekom' },
      { was: 'Business Development Telekommunikation', wo: '', label: 'BizDev Telekom' },
      { was: 'Vertrieb UCaaS', wo: '', label: 'Vertrieb UCaaS' },
      { was: 'Vertrieb Managed Services', wo: '', label: 'Vertrieb Managed Services' },
      { was: 'Enterprise Sales Germany', wo: '', label: 'Enterprise Sales DE' },
      { was: 'Account Manager SD-WAN', wo: '', label: 'Account Manager SD-WAN' },
    ],
    titlePositive: [
      'account', 'vertrieb', 'sales', 'key account', 'business development',
      'telecom', 'telekommunikation', 'ucaas', 'sd-wan', 'managed services',
      'enterprise', 'b2b', 'partner', 'channel', 'kundenberater',
    ],
    titleNegative: [
      'intern', 'praktikum', 'werkstudent', 'azubi', 'ausbildung',
      'techniker', 'monteur', 'callcenter', 'kundenservice',
    ],
  },

  josephina: {
    queries: [
      { was: 'UX Designer', wo: '', label: 'UX Designer' },
      { was: 'UI Designer', wo: '', label: 'UI Designer' },
      { was: 'Product Designer', wo: '', label: 'Product Designer' },
      { was: 'Design Lead', wo: '', label: 'Design Lead' },
      { was: 'Head of Design', wo: '', label: 'Head of Design' },
      { was: 'Design Director', wo: '', label: 'Design Director' },
      { was: 'Design Systems', wo: '', label: 'Design Systems' },
      { was: 'Senior Designer UX UI', wo: '', label: 'Senior Designer UX/UI' },
      { was: 'Interaction Designer', wo: '', label: 'Interaction Designer' },
      { was: 'Visual Designer', wo: '', label: 'Visual Designer' },
    ],
    titlePositive: [
      'design', 'ux', 'ui', 'product designer', 'interaction', 'visual',
      'gestaltung', 'designleitung', 'creative director',
    ],
    titleNegative: [
      'intern', 'praktikum', 'werkstudent', 'azubi', 'ausbildung',
      'graphic designer', 'interior', 'fashion', 'industrial', 'sound',
      'game designer', 'instructional', 'mechanical design', 'electrical design',
      'konstruktion', 'maschinenbau', 'engineering design', 'turbine', 'marine',
      'rf design', 'pcb design', 'hardware design', 'spielwaren', 'produktentwickler',
    ],
  },
};

// ============================================================
// API Client
// ============================================================

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function searchJobs(was, wo = '', size = 25) {
  const params = new URLSearchParams({
    was,
    angebotsart: '1', // Employment only
    size: String(size),
    page: '1',
  });
  if (wo) params.set('wo', wo);

  const url = `${API_BASE}/jobs?${params}`;

  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  return data;
}

async function getJobDetails(refnr) {
  const encoded = Buffer.from(refnr).toString('base64');
  const url = `${API_BASE}/jobdetails/${encoded}`;

  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) return null;

  return res.json();
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
// Pipeline Integration
// ============================================================

async function loadExistingUrls() {
  const urls = new Set();

  // Load pipeline.md
  try {
    const pipeline = await readFile(resolve(__dirname, 'data/pipeline.md'), 'utf8');
    for (const match of pipeline.matchAll(/https?:\/\/[^\s|)]+/g)) {
      urls.add(match[0]);
    }
  } catch { /* no pipeline yet */ }

  // Load applications.md
  try {
    const apps = await readFile(resolve(__dirname, 'data/applications.md'), 'utf8');
    for (const match of apps.matchAll(/https?:\/\/[^\s|)]+/g)) {
      urls.add(match[0]);
    }
  } catch { /* no tracker yet */ }

  // Load scan-history.tsv
  try {
    const history = await readFile(resolve(__dirname, 'data/scan-history.tsv'), 'utf8');
    for (const match of history.matchAll(/https?:\/\/[^\s\t]+/g)) {
      urls.add(match[0]);
    }
  } catch { /* no history yet */ }

  return urls;
}

function buildJobUrl(refnr) {
  return `https://www.arbeitsagentur.de/jobsuche/suche?id=${refnr}&angebotsart=1`;
}

async function appendToPipeline(jobs) {
  if (jobs.length === 0) return;

  const lines = jobs.map(j =>
    `- [ ] ${j.url} | ${j.company} | ${j.title}`
  ).join('\n');

  const pipelinePath = resolve(__dirname, 'data/pipeline.md');

  try {
    const existing = await readFile(pipelinePath, 'utf8');
    // Append under Pendientes section
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
    // Create pipeline.md if it doesn't exist
    await writeFile(pipelinePath, `# Pipeline — Pending URLs\n\n## Pendientes\n\n${lines}\n`, 'utf8');
  }
}

async function appendToScanHistory(jobs, skipped) {
  const historyPath = resolve(__dirname, 'data/scan-history.tsv');
  const date = new Date().toISOString().split('T')[0];

  const lines = [
    ...jobs.map(j => `${j.url}\t${date}\tBA-API: ${j.queryLabel}\t${j.title}\t${j.company}\tadded`),
    ...skipped.map(s => `${s.url}\t${date}\tBA-API: ${s.queryLabel}\t${s.title}\t${s.company}\t${s.reason}`),
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
  const limit = limitArg ? parseInt(limitArg.split('=')[1]) : 25;
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

  console.log(`\n  BA Jobsuche API Scanner — Profile: ${profileName}`);
  console.log(`  ${'━'.repeat(50)}`);
  console.log(`  Queries: ${config.queries.length} | Limit: ${limit}/query | Dry run: ${dryRun}\n`);

  // Load dedup set
  const existingUrls = await loadExistingUrls();
  console.log(`  Existing URLs loaded: ${existingUrls.size}`);

  const allJobs = [];
  const allSkipped = [];
  const seenRefnrs = new Set();
  let totalFound = 0;
  let totalFiltered = 0;
  let totalDuped = 0;

  for (const query of config.queries) {
    try {
      console.log(`\n  Searching: "${query.was}" ${query.wo ? `in ${query.wo}` : '(national)'}...`);
      const data = await searchJobs(query.was, query.wo, limit);

      const stellenangebote = data?.stellenangebote || [];
      const maxErgebnisse = data?.maxErgebnisse || 0;
      console.log(`    Found: ${stellenangebote.length} results (${maxErgebnisse} total available)`);
      totalFound += stellenangebote.length;

      for (const job of stellenangebote) {
        const refnr = job.refnr;
        if (!refnr || seenRefnrs.has(refnr)) continue;
        seenRefnrs.add(refnr);

        const title = job.titel || 'Unknown Title';
        const company = job.arbeitgeber || 'Unknown Employer';
        const location = job.arbeitsort?.ort || '';
        const url = buildJobUrl(refnr);

        // Dedup against existing
        if (existingUrls.has(url)) {
          totalDuped++;
          allSkipped.push({ url, title, company, queryLabel: query.label, reason: 'skipped_dup' });
          continue;
        }

        // Title filter
        if (!matchesTitle(title, config)) {
          totalFiltered++;
          allSkipped.push({ url, title, company, queryLabel: query.label, reason: 'skipped_title' });
          continue;
        }

        const displayTitle = location ? `${title} — ${location}` : title;
        allJobs.push({ url, title: displayTitle, company, queryLabel: query.label, refnr });
        existingUrls.add(url); // prevent cross-query dupes
      }

      await sleep(RATE_LIMIT_MS);
    } catch (err) {
      console.error(`    ERROR: ${err.message}`);
    }
  }

  // Summary
  console.log(`\n  ${'━'.repeat(50)}`);
  console.log(`  BA API Scan Complete — ${new Date().toISOString().split('T')[0]}`);
  console.log(`  ${'━'.repeat(50)}`);
  console.log(`  Queries executed: ${config.queries.length}`);
  console.log(`  Total results:    ${totalFound}`);
  console.log(`  Filtered (title): ${totalFiltered}`);
  console.log(`  Duplicates:       ${totalDuped}`);
  console.log(`  NEW to pipeline:  ${allJobs.length}`);

  if (allJobs.length > 0) {
    console.log(`\n  New jobs:`);
    for (const job of allJobs) {
      console.log(`    + ${job.company} | ${job.title}`);
    }
  }

  // Write results
  if (!dryRun && allJobs.length > 0) {
    await appendToPipeline(allJobs);
    console.log(`\n  Written to data/pipeline.md`);
  }

  if (!dryRun) {
    await appendToScanHistory(allJobs, allSkipped);
    console.log(`  Written to data/scan-history.tsv`);
  }

  if (dryRun) {
    console.log(`\n  (Dry run — no files written)`);
  }

  console.log('');
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
