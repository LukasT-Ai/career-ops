#!/usr/bin/env node

/**
 * scan-all.mjs — Master Scanner for All Profiles
 *
 * Runs all job scanners (10 sources) across all profiles in sequence.
 * Designed to be called by cron or manually before batch evaluation.
 *
 * Usage:
 *   node scan-all.mjs                  Run all scanners, all profiles
 *   node scan-all.mjs --dry-run        Preview without writing
 *   node scan-all.mjs --profile=lamin  Single profile only
 *   node scan-all.mjs --limit=50       Max results per query (default 25)
 *
 * After scanning, new jobs land in each profile's data/pipeline.md.
 * Claude then evaluates, generates docs, and dispatches emails.
 */

import { execFile } from 'child_process';
import { readFile, writeFile, copyFile } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

// Active scanning profiles — Josephina paused until resume is ready
const ALL_PROFILES = ['paulina', 'lamin'];
const PAUSED_PROFILES = ['josephina'];

// Scanners ordered: FREE APIs first, then scrapers (slower), then PAID
const SCANNERS = [
  // Free APIs — no auth or free keys
  { name: 'Bundesagentur für Arbeit', script: 'arbeitsagentur-api.mjs', cost: 'FREE' },
  { name: 'USAJobs.gov', script: 'usajobs-api.mjs', cost: 'FREE' },
  { name: 'Adzuna', script: 'adzuna-api.mjs', cost: 'FREE' },
  { name: 'Jooble', script: 'jooble-api.mjs', cost: 'FREE' },
  { name: 'RemoteOK', script: 'remoteok-api.mjs', cost: 'FREE' },
  { name: 'Remotive', script: 'remotive-api.mjs', cost: 'FREE' },
  { name: 'Arbeitnow', script: 'arbeitnow-api.mjs', cost: 'FREE' },
  { name: 'The Muse', script: 'themuse-api.mjs', cost: 'FREE' },
  // Free public ATS APIs — no auth needed
  { name: 'Greenhouse (ATS)', script: 'greenhouse-api.mjs', cost: 'FREE' },
  { name: 'Lever (ATS)', script: 'lever-api.mjs', cost: 'FREE' },
  // Free API with budget cap (200 req/month)
  { name: 'JSearch (Google Jobs)', script: 'jsearch-api.mjs', cost: 'FREE (200 req/mo budget-capped)' },
  { name: 'JobSearch15 (LinkedIn)', script: 'jobsearch15-api.mjs', cost: 'FREE (50 req/mo budget-capped)' },
  // HTTP scrapers — no Playwright needed
  { name: 'StepStone.de', script: 'stepstone-scraper.mjs', cost: 'FREE' },
  { name: 'XING Jobs', script: 'xing-scraper.mjs', cost: 'FREE' },
  { name: 'Dice.com', script: 'dice-scraper.mjs', cost: 'FREE', skipProfiles: ['paulina'] },
  // Profile-specific niche scrapers
  { name: 'Doximity', script: 'doximity-scraper.mjs', cost: 'FREE', skipProfiles: ['lamin'] },
  { name: 'PraktischArzt.de', script: 'praktischarzt-scraper.mjs', cost: 'FREE', skipProfiles: ['lamin'] },
  { name: 'Ärztestellen (Ärzteblatt)', script: 'aerztestellen-scraper.mjs', cost: 'FREE', skipProfiles: ['lamin'] },
  { name: 'Telecom Careers', script: 'telecom-careers-scraper.mjs', cost: 'FREE', skipProfiles: ['paulina'] },
  // Playwright scrapers — headless browser, slower
  { name: 'LinkedIn', script: 'linkedin-scraper.mjs', cost: 'FREE' },
  { name: 'Indeed', script: 'indeed-scraper.mjs', cost: 'FREE' },
  // Monster disabled — returns 403 on fetch, blocks Playwright. Anti-scraping.
  // { name: 'Monster', script: 'monster-scraper.mjs', cost: 'FREE' },
  // Paid — budget-capped
  { name: 'Board Scanner (Brave API + Bing + ATS APIs)', script: 'board-scanner.mjs', cost: 'PAID ($5/1000 Brave queries, budget-capped)' },
];

async function setActiveProfile(profileName) {
  const activePath = resolve(__dirname, 'profiles/active.yml');
  const content = `# Active Profile Selector\nactive: ${profileName}\n`;
  const { writeFile } = await import('fs/promises');
  await writeFile(activePath, content, 'utf8');
}

async function syncProfileToRoot(profileName) {
  const pairs = [
    [`profiles/${profileName}/cv.md`, 'cv.md'],
    [`profiles/${profileName}/profile.yml`, 'config/profile.yml'],
    [`profiles/${profileName}/_profile.md`, 'modes/_profile.md'],
    [`profiles/${profileName}/portals.yml`, 'portals.yml'],
    [`profiles/${profileName}/data/applications.md`, 'data/applications.md'],
    [`profiles/${profileName}/data/pipeline.md`, 'data/pipeline.md'],
    [`profiles/${profileName}/data/scan-history.tsv`, 'data/scan-history.tsv'],
  ];

  for (const [src, dst] of pairs) {
    try {
      await copyFile(resolve(__dirname, src), resolve(__dirname, dst));
    } catch { /* file may not exist yet — that's OK */ }
  }
}

async function syncRootToProfile(profileName) {
  const pairs = [
    ['data/pipeline.md', `profiles/${profileName}/data/pipeline.md`],
    ['data/scan-history.tsv', `profiles/${profileName}/data/scan-history.tsv`],
    ['data/applications.md', `profiles/${profileName}/data/applications.md`],
  ];

  for (const [src, dst] of pairs) {
    try {
      await copyFile(resolve(__dirname, src), resolve(__dirname, dst));
    } catch { /* OK */ }
  }
}

async function runScanner(script, profileName, args) {
  const scriptPath = resolve(__dirname, script);
  const cmdArgs = [scriptPath, `--profile=${profileName}`, ...args];

  try {
    const { stdout, stderr } = await execFileAsync('node', cmdArgs, {
      cwd: __dirname,
      timeout: 900000, // 15 min per scanner (Playwright scrapers need more time)
    });
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    return true;
  } catch (err) {
    console.error(`    ERROR running ${script}: ${err.message}`);
    if (err.stdout) process.stdout.write(err.stdout);
    return false;
  }
}

// ── Post-Scan Location Filter ──────────────────────────────
// Same rules as job-dispatcher.mjs LOCATION_RULES.
// Removes pipeline entries that don't match the profile's allowed locations.

const LOCATION_RULES = {
  paulina: {
    officeLocations: ['atlanta', 'georgia', 'decatur', 'dekalb'],
    remoteLocations: ['georgia', 'atlanta', 'california', 'los angeles', 'san francisco',
                      'san diego', 'bay area', 'sacramento', 'menlo park', 'palo alto'],
    germanyAllowed: true,
    remoteUSAllowed: false,
  },
  lamin: {
    officeLocations: ['atlanta', 'georgia'],
    remoteLocations: [],
    germanyAllowed: true,
    remoteUSAllowed: true,
  },
  josephina: {
    officeLocations: ['atlanta', 'georgia'],
    remoteLocations: [],
    germanyAllowed: true,
    remoteUSAllowed: true,
  },
};

const GERMAN_KW = ['germany','deutschland','berlin','munich','münchen','hamburg','frankfurt',
  'heidelberg','freiburg','cologne','köln','stuttgart','düsseldorf','klinik','krankenhaus',
  'arzt','ärztin','facharzt','oberarzt','chefarzt','gmbh','ggmbh','psychiatrie','psychosomatik'];
const REMOTE_KW = ['remote','telehealth','telework','telepsych','virtual','work from home','anywhere','location negotiable'];
const US_STATES = ['alabama','alaska','arizona','arkansas','colorado','connecticut','delaware',
  'florida','hawaii','idaho','illinois','indiana','iowa','kansas','kentucky','louisiana','maine',
  'maryland','massachusetts','michigan','minnesota','mississippi','missouri','montana','nebraska',
  'nevada','new hampshire','new jersey','new mexico','new york','north carolina','north dakota',
  'ohio','oklahoma','oregon','pennsylvania','rhode island','south carolina','south dakota',
  'tennessee','texas','utah','vermont','virginia','washington','west virginia','wisconsin',
  'wyoming','district of columbia','puerto rico'];

function isLocationEligible(line, profileName) {
  const rules = LOCATION_RULES[profileName];
  if (!rules) return true;
  const lower = line.toLowerCase();

  if (GERMAN_KW.some(k => lower.includes(k))) return rules.germanyAllowed;
  if (REMOTE_KW.some(k => lower.includes(k))) {
    if (rules.remoteUSAllowed) return true;
    return rules.remoteLocations.some(k => lower.includes(k));
  }
  if (rules.officeLocations.some(k => lower.includes(k))) return true;

  // Check for out-of-area US states
  const allowedStates = profileName === 'paulina' ? ['georgia','california'] : ['georgia'];
  const mentioned = US_STATES.find(s => lower.includes(s));
  if (mentioned && !allowedStates.includes(mentioned)) return false;

  return true; // unclear location = pass through
}

async function filterPipelineByLocation(profileName) {
  const pipePath = resolve(__dirname, 'data/pipeline.md');
  let content;
  try { content = await readFile(pipePath, 'utf8'); } catch { return 0; }

  const lines = content.split('\n');
  const kept = [];
  let removed = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || (trimmed.startsWith('|') && (trimmed.includes('URL') || trimmed.includes('---')))) {
      kept.push(line);
      continue;
    }
    if (isLocationEligible(trimmed, profileName)) {
      kept.push(line);
    } else {
      removed++;
    }
  }

  if (removed > 0) {
    await writeFile(pipePath, kept.join('\n'), 'utf8');
  }
  return removed;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const limitArg = args.find(a => a.startsWith('--limit='));
  const profileArg = args.find(a => a.startsWith('--profile='));
  const extraArgs = [];
  if (dryRun) extraArgs.push('--dry-run');
  if (limitArg) extraArgs.push(limitArg);

  const profiles = profileArg
    ? [profileArg.split('=')[1]]
    : ALL_PROFILES;

  // Save current active profile to restore later
  let originalActive = 'paulina';
  try {
    const yml = await readFile(resolve(__dirname, 'profiles/active.yml'), 'utf8');
    originalActive = yml.match(/active:\s*(\w+)/)?.[1] || 'paulina';
  } catch { /* use default */ }

  const startTime = Date.now();
  const results = {};

  console.log(`\n  ${'═'.repeat(60)}`);
  console.log(`  CAREER-OPS MASTER SCAN — ${new Date().toISOString().split('T')[0]}`);
  console.log(`  ${'═'.repeat(60)}`);
  console.log(`  Profiles: ${profiles.join(', ')}${PAUSED_PROFILES.length ? ` (paused: ${PAUSED_PROFILES.join(', ')})` : ''}`);
  console.log(`  Scanners:`);
  for (const s of SCANNERS) console.log(`    ${s.cost.padEnd(8)} ${s.name}`);
  console.log(`  Dry run:  ${dryRun}`);
  console.log(`  ${'═'.repeat(60)}\n`);

  for (const profile of profiles) {
    console.log(`\n  ${'─'.repeat(60)}`);
    console.log(`  PROFILE: ${profile.toUpperCase()}`);
    console.log(`  ${'─'.repeat(60)}`);

    // Switch to this profile
    await setActiveProfile(profile);
    await syncProfileToRoot(profile);

    results[profile] = { scanners: {}, newJobs: 0 };

    // Count pipeline before (read from PROFILE dir, where scanners write)
    const profilePipeline = resolve(__dirname, 'profiles', profile, 'data', 'pipeline.md');
    let beforeCount = 0;
    try {
      const pipeline = await readFile(profilePipeline, 'utf8');
      beforeCount = (pipeline.match(/- \[ \]/g) || []).length;
    } catch { /* no pipeline */ }

    // Run each scanner
    for (const scanner of SCANNERS) {
      if (scanner.skipProfiles && scanner.skipProfiles.includes(profile)) {
        console.log(`\n  Skipping: ${scanner.name} (not relevant for ${profile})`);
        results[profile].scanners[scanner.name] = 'SKIPPED';
        continue;
      }
      console.log(`\n  Running: ${scanner.name}...`);
      const ok = await runScanner(scanner.script, profile, extraArgs);
      results[profile].scanners[scanner.name] = ok ? 'OK' : 'FAILED';
    }

    // Count pipeline after (read from PROFILE dir)
    let afterCount = 0;
    try {
      const pipeline = await readFile(profilePipeline, 'utf8');
      afterCount = (pipeline.match(/- \[ \]/g) || []).length;
    } catch { /* no pipeline */ }

    // Post-scan location filter: remove out-of-area entries from pipeline
    let removedCount = 0;
    if (!dryRun) {
      removedCount = await filterPipelineByLocation(profile);
      if (removedCount > 0) {
        console.log(`  [LOCATION FILTER] Removed ${removedCount} out-of-area entries from ${profile}'s pipeline`);
      }
    }

    results[profile].newJobs = Math.max(0, afterCount - beforeCount - removedCount);

    // Sync results back to profile directory
    if (!dryRun) {
      await syncRootToProfile(profile);
    }
  }

  // Restore original active profile
  await setActiveProfile(originalActive);
  await syncProfileToRoot(originalActive);

  // Final summary
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(`\n\n  ${'═'.repeat(60)}`);
  console.log(`  SCAN COMPLETE — ${elapsed}s`);
  console.log(`  ${'═'.repeat(60)}`);

  let totalNew = 0;
  for (const [profile, data] of Object.entries(results)) {
    const scannerStatus = Object.entries(data.scanners)
      .map(([name, status]) => `${name}: ${status}`)
      .join(', ');
    console.log(`  ${profile.padEnd(12)} | +${data.newJobs} new jobs | ${scannerStatus}`);
    totalNew += data.newJobs;
  }

  console.log(`  ${'─'.repeat(60)}`);
  console.log(`  TOTAL NEW: ${totalNew} jobs across ${profiles.length} profiles`);
  console.log(`  ${'═'.repeat(60)}\n`);

  return totalNew;
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
