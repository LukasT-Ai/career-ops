#!/usr/bin/env node

/**
 * lever-api.mjs — Lever Public Postings API Scanner
 *
 * Lever's public postings API is FREE, no auth needed.
 * Endpoint: https://api.lever.co/v0/postings/{company}?mode=json
 *
 * Usage:
 *   node lever-api.mjs [--profile=paulina|lamin] [--dry-run]
 */

import { readFile, writeFile, appendFile } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_BASE = 'https://api.lever.co/v0/postings';
const RATE_LIMIT_MS = 800;

// ── Curated company slugs per profile niche ──────────────────

const CURATED_COMPANIES = {
  lamin: [
    // Telecom / UCaaS / SaaS sales
    'twilio', 'vonage', 'ringcentral', 'dialpad', 'bandwidth', 'telnyx',
    'nextiva', 'zoom', '8x8', 'five9', 'genesys', 'nice-incontact',
    // Tech / Enterprise sales
    'netflix', 'cloudflare', 'datadog', 'snowflake', 'confluent', 'hashicorp',
    'elastic', 'mongodb', 'cockroachlabs', 'figma', 'notion', 'airtable',
    'webflow', 'zapier', 'stripe', 'plaid', 'rippling', 'gusto',
    'brex', 'ramp', 'toast', 'squarespace',
  ],
  paulina: [
    // Healthcare / Behavioral health / Telepsych
    'teladochealth', 'cerebral', 'lyrahealth', 'springhealth', 'headway',
    'alma', 'talkspace', 'ginger', 'brightside', 'mindbloom', 'noomii',
    'quartet', 'path', 'elemy', 'included-health', 'brightlinecare',
    // Health tech / Biotech
    'tempus', 'flatiron', 'color', 'invitae', 'grail', 'illumina',
    'modernhealth', 'hims', 'ro', 'omadahealth', 'noom',
  ],
};

// ── Helpers ──────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getActiveProfile() {
  const yml = await readFile(resolve(__dirname, 'profiles/active.yml'), 'utf8');
  return yml.match(/active:\s*(\w+)/)?.[1] || 'paulina';
}

async function loadTitleFilter(profileName) {
  try {
    const yml = await readFile(resolve(__dirname, 'profiles', profileName, 'portals.yml'), 'utf8');
    const pos = [];
    const neg = [];
    let inPositive = false;
    let inNegative = false;
    for (const line of yml.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === 'positive:') { inPositive = true; inNegative = false; continue; }
      if (trimmed === 'negative:') { inNegative = true; inPositive = false; continue; }
      if (trimmed.startsWith('- "') || trimmed.startsWith("- '")) {
        const val = trimmed.replace(/^- ["']|["']$/g, '').toLowerCase();
        if (inPositive) pos.push(val);
        if (inNegative) neg.push(val);
      } else if (!trimmed.startsWith('-') && !trimmed.startsWith('#') && trimmed !== '') {
        inPositive = false;
        inNegative = false;
      }
    }
    return { positive: pos, negative: neg };
  } catch {
    return { positive: [], negative: [] };
  }
}

function matchesTitle(title, filter) {
  if (filter.positive.length === 0) return true;
  const lower = title.toLowerCase();
  const hasPos = filter.positive.some(kw => lower.includes(kw));
  if (!hasPos) return false;
  const hasNeg = filter.negative.some(kw => lower.includes(kw));
  return !hasNeg;
}

async function loadExistingUrls(profileName) {
  const urls = new Set();
  const sources = [
    resolve(__dirname, 'profiles', profileName, 'data', 'pipeline.md'),
    resolve(__dirname, 'profiles', profileName, 'data', 'applications.md'),
    resolve(__dirname, 'profiles', profileName, 'data', 'scan-history.tsv'),
    resolve(__dirname, 'data', 'pipeline.md'),
  ];
  for (const path of sources) {
    try {
      const content = await readFile(path, 'utf8');
      for (const m of content.matchAll(/https?:\/\/[^\s|)\t]+/g)) urls.add(m[0]);
    } catch { /* ok */ }
  }
  return urls;
}

function extractLeverSlugs(portalsYml) {
  const slugs = new Set();
  for (const m of portalsYml.matchAll(/lever\.co\/([a-zA-Z0-9_-]+)/g)) {
    slugs.add(m[1]);
  }
  return [...slugs];
}

// ── Lever API Client ─────────────────────────────────────────

async function fetchLeverPostings(slug) {
  const allJobs = [];
  let skip = 0;
  const limit = 100;

  while (true) {
    const url = `${API_BASE}/${slug}?mode=json&limit=${limit}&skip=${skip}`;
    const res = await fetch(url);

    if (res.status === 404) return []; // company not found or no public board
    if (!res.ok) throw new Error(`Lever API ${res.status} for ${slug}`);

    const jobs = await res.json();
    if (!Array.isArray(jobs) || jobs.length === 0) break;

    allJobs.push(...jobs);
    if (jobs.length < limit) break;
    skip += limit;
    await sleep(300);
  }

  return allJobs;
}

function parseLeverJob(job, slug) {
  return {
    title: job.text || 'Unknown Title',
    company: slug,
    location: job.categories?.location || '',
    team: job.categories?.team || '',
    url: job.hostedUrl || `https://jobs.lever.co/${slug}/${job.id}`,
    created: job.createdAt ? new Date(job.createdAt).toISOString().split('T')[0] : '',
  };
}

// ── Pipeline Writer ──────────────────────────────────────────

async function appendToPipeline(jobs, profileName) {
  if (jobs.length === 0) return;
  const lines = jobs.map(j => {
    const loc = j.location ? ` — ${j.location}` : '';
    return `- [ ] ${j.url} | ${j.company} | ${j.title}${loc}`;
  }).join('\n');

  const pipePath = resolve(__dirname, 'profiles', profileName, 'data', 'pipeline.md');
  try {
    const existing = await readFile(pipePath, 'utf8');
    if (existing.includes('## Pendientes')) {
      await writeFile(pipePath, existing.replace('## Pendientes\n', `## Pendientes\n\n${lines}\n`), 'utf8');
    } else {
      await appendFile(pipePath, `\n${lines}\n`, 'utf8');
    }
  } catch {
    await writeFile(pipePath, `# Pipeline — Pending URLs\n\n## Pendientes\n\n${lines}\n`, 'utf8');
  }
}

async function appendToScanHistory(jobs, skipped, profileName) {
  const histPath = resolve(__dirname, 'profiles', profileName, 'data', 'scan-history.tsv');
  const date = new Date().toISOString().split('T')[0];
  const lines = [
    ...jobs.map(j => `${j.url}\t${date}\tLever: ${j.company}\t${j.title}\t${j.company}\tadded`),
    ...skipped.map(s => `${s.url}\t${date}\tLever: ${s.company}\t${s.title}\t${s.company}\t${s.reason}`),
  ].join('\n');
  if (!lines) return;
  try {
    await appendFile(histPath, `\n${lines}`, 'utf8');
  } catch {
    await writeFile(histPath, `url\tfirst_seen\tportal\ttitle\tcompany\tstatus\n${lines}\n`, 'utf8');
  }
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const profileArg = args.find(a => a.startsWith('--profile='));
  const profileName = profileArg ? profileArg.split('=')[1] : await getActiveProfile();

  console.log(`\n  Lever API Scanner — Profile: ${profileName}`);
  console.log(`  ${'━'.repeat(50)}`);

  // Build company slug list
  const slugSet = new Set();

  // From portals.yml
  try {
    const portals = await readFile(resolve(__dirname, 'profiles', profileName, 'portals.yml'), 'utf8');
    for (const s of extractLeverSlugs(portals)) slugSet.add(s);
  } catch { /* no portals */ }

  // Add curated companies
  const curated = CURATED_COMPANIES[profileName] || [];
  for (const s of curated) slugSet.add(s);

  const slugs = [...slugSet];
  console.log(`  Companies: ${slugs.length} (${slugs.length - curated.length} from portals + ${curated.length} curated)`);
  console.log(`  Dry run: ${dryRun}\n`);

  const filter = await loadTitleFilter(profileName);
  const existingUrls = await loadExistingUrls(profileName);
  console.log(`  Existing URLs loaded: ${existingUrls.size}\n`);

  const allNew = [];
  const allSkipped = [];
  const seenCombo = new Set();
  let totalFound = 0;
  let totalFiltered = 0;
  let totalDuped = 0;
  let companiesWithJobs = 0;

  for (const slug of slugs) {
    try {
      const postings = await fetchLeverPostings(slug);
      if (postings.length === 0) {
        process.stdout.write(`  ${slug}: no public board\n`);
        await sleep(RATE_LIMIT_MS);
        continue;
      }

      totalFound += postings.length;
      let newForCompany = 0;

      for (const posting of postings) {
        const job = parseLeverJob(posting, slug);
        if (!job.url) continue;

        // Dedup by URL
        if (existingUrls.has(job.url)) {
          totalDuped++;
          allSkipped.push({ ...job, reason: 'skipped_dup_url' });
          continue;
        }

        // Dedup by company+title combo
        const combo = `${job.company.toLowerCase()}||${job.title.toLowerCase()}`;
        if (seenCombo.has(combo)) {
          totalDuped++;
          allSkipped.push({ ...job, reason: 'skipped_dup_combo' });
          continue;
        }
        seenCombo.add(combo);

        // Title filter
        if (!matchesTitle(job.title, filter)) {
          totalFiltered++;
          allSkipped.push({ ...job, reason: 'skipped_title' });
          continue;
        }

        allNew.push(job);
        existingUrls.add(job.url);
        newForCompany++;
      }

      if (newForCompany > 0) companiesWithJobs++;
      console.log(`  ${slug}: ${postings.length} postings → ${newForCompany} new`);
      await sleep(RATE_LIMIT_MS);
    } catch (err) {
      console.error(`  ${slug}: ERROR — ${err.message}`);
      await sleep(RATE_LIMIT_MS);
    }
  }

  // Summary
  console.log(`\n  ${'━'.repeat(50)}`);
  console.log(`  Lever Scan Complete — ${new Date().toISOString().split('T')[0]}`);
  console.log(`  ${'━'.repeat(50)}`);
  console.log(`  Companies scanned: ${slugs.length}`);
  console.log(`  Companies with jobs: ${companiesWithJobs}`);
  console.log(`  Total postings:    ${totalFound}`);
  console.log(`  Filtered:          ${totalFiltered}`);
  console.log(`  Duplicates:        ${totalDuped}`);
  console.log(`  NEW to pipeline:   ${allNew.length}`);

  if (allNew.length > 0) {
    console.log(`\n  New jobs:`);
    for (const j of allNew) {
      const loc = j.location ? ` | ${j.location}` : '';
      console.log(`    + ${j.company} | ${j.title}${loc}`);
    }
  }

  if (!dryRun && allNew.length > 0) {
    await appendToPipeline(allNew, profileName);
    console.log(`\n  Written to profiles/${profileName}/data/pipeline.md`);
  }
  if (!dryRun) {
    await appendToScanHistory(allNew, allSkipped, profileName);
    console.log(`  Written to profiles/${profileName}/data/scan-history.tsv`);
  }
  if (dryRun) console.log(`\n  (Dry run — no files written)`);
  console.log('');
}

main().catch(err => { console.error(`Fatal: ${err.message}`); process.exit(1); });
