#!/usr/bin/env node

/**
 * audit-locations.mjs — Audit all logged/pipeline jobs against location rules
 *
 * Checks: data/apply-log.md, profiles/{name}/data/pipeline.md
 * Flags or removes entries that don't meet per-profile location criteria.
 *
 * Usage:
 *   node audit-locations.mjs                  (report only)
 *   node audit-locations.mjs --apply          (remove ineligible entries)
 */

import { readFile, writeFile } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Location Rules (mirrors job-dispatcher.mjs LOCATION_RULES) ──

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

const GERMAN_KEYWORDS = [
  'germany', 'deutschland', 'berlin', 'munich', 'münchen', 'hamburg', 'frankfurt',
  'heidelberg', 'freiburg', 'cologne', 'köln', 'stuttgart', 'düsseldorf', 'dusseldorf',
  'arbeitsagentur', 'ba-api', 'klinik', 'krankenhaus', 'arzt', 'ärztin', 'facharzt',
  'oberarzt', 'chefarzt', 'assistenzarzt', 'psychosomatik', 'psychiatrie',
  'gmbh', 'e.v.', 'ggmbh',
];

const REMOTE_KEYWORDS = ['remote', 'telehealth', 'telework', 'telepsych', 'virtual',
  'work from home', 'anywhere', 'location negotiable'];

function isGerman(text) {
  const lower = text.toLowerCase();
  return GERMAN_KEYWORDS.some(k => lower.includes(k));
}

function isRemote(text) {
  const lower = text.toLowerCase();
  return REMOTE_KEYWORDS.some(k => lower.includes(k));
}

function checkEligibility(profileName, company, role, platform, notes) {
  const rules = LOCATION_RULES[profileName];
  if (!rules) return { eligible: true, reason: 'unknown profile' };

  // Combine all text fields for location detection
  const allText = `${company} ${role} ${platform} ${notes}`.toLowerCase();

  // German job?
  if (isGerman(allText)) {
    return rules.germanyAllowed
      ? { eligible: true, reason: 'Germany' }
      : { eligible: false, reason: 'Germany not allowed' };
  }

  // Remote?
  if (isRemote(allText)) {
    if (rules.remoteUSAllowed) return { eligible: true, reason: 'Remote US' };
    // Check if remote in allowed state
    const matchesState = rules.remoteLocations.some(k => allText.includes(k));
    if (matchesState) return { eligible: true, reason: 'Remote in allowed state' };
    return { eligible: false, reason: `Remote not in allowed states for ${profileName}` };
  }

  // Check office location from company/role/notes
  const matchesOffice = rules.officeLocations.some(k => allText.includes(k));
  if (matchesOffice) return { eligible: true, reason: 'Office in allowed location' };

  // USAJobs / federal — check for US state names that aren't in allowed list
  const usStates = [
    'alabama', 'alaska', 'arizona', 'arkansas', 'colorado', 'connecticut',
    'delaware', 'florida', 'hawaii', 'idaho', 'illinois', 'indiana', 'iowa',
    'kansas', 'kentucky', 'louisiana', 'maine', 'maryland', 'massachusetts',
    'michigan', 'minnesota', 'mississippi', 'missouri', 'montana', 'nebraska',
    'nevada', 'new hampshire', 'new jersey', 'new mexico', 'new york',
    'north carolina', 'north dakota', 'ohio', 'oklahoma', 'oregon',
    'pennsylvania', 'rhode island', 'south carolina', 'south dakota',
    'tennessee', 'texas', 'utah', 'vermont', 'virginia', 'washington',
    'west virginia', 'wisconsin', 'wyoming', 'district of columbia', 'puerto rico',
  ];

  // For Paulina, also check California
  const allowedStates = profileName === 'paulina'
    ? ['georgia', 'california'] : ['georgia'];
  // Actually for lamin/josephina all US remote is OK but on-site only in GA
  // So if there's a US state that isn't GA, it's on-site in another state = blocked

  const mentionedState = usStates.find(s => allText.includes(s));
  if (mentionedState && !allowedStates.includes(mentionedState)) {
    // If it's lamin or josephina with remoteUSAllowed, it might be remote
    // But if we got here, we already checked for remote keywords above
    return { eligible: false, reason: `On-site in ${mentionedState}` };
  }

  // If California mentioned for paulina, that's ok (on-site or remote)
  if (profileName === 'paulina' && allText.includes('california')) {
    return { eligible: true, reason: 'California (licensed)' };
  }

  // No clear location — pass through (benefit of the doubt)
  return { eligible: true, reason: 'location unclear — passed' };
}

// ── Apply-Log Audit ──

async function auditApplyLog(apply) {
  const logPath = resolve(__dirname, 'data/apply-log.md');
  const content = await readFile(logPath, 'utf8');
  const lines = content.split('\n');

  const headerLines = [];
  const dataLines = [];
  const ineligible = [];
  const eligible = [];

  for (const line of lines) {
    if (!line.startsWith('|') || line.startsWith('| Date') || line.startsWith('|---')) {
      headerLines.push(line);
      continue;
    }

    const cols = line.split('|').map(c => c.trim()).filter(Boolean);
    if (cols.length < 6) { headerLines.push(line); continue; }

    const [date, time, profile, company, role, platform, action, score, ...rest] = cols;
    const notes = rest.join(' ');
    const result = checkEligibility(profile.trim(), company, role, platform, notes);

    if (!result.eligible) {
      ineligible.push({ line, profile: profile.trim(), company, role, reason: result.reason });
    } else {
      eligible.push(line);
    }
  }

  console.log(`\n  Apply-Log Audit`);
  console.log(`  ${'━'.repeat(50)}`);
  console.log(`  Total entries:     ${eligible.length + ineligible.length}`);
  console.log(`  Eligible:          ${eligible.length}`);
  console.log(`  Ineligible:        ${ineligible.length}`);

  if (ineligible.length > 0) {
    console.log(`\n  Ineligible entries:`);
    for (const e of ineligible) {
      console.log(`    [${e.profile}] ${e.role} at ${e.company} — ${e.reason}`);
    }
  }

  if (apply && ineligible.length > 0) {
    // Rebuild file without ineligible lines
    const ineligibleSet = new Set(ineligible.map(e => e.line));
    const kept = lines.filter(l => !ineligibleSet.has(l));
    await writeFile(logPath, kept.join('\n'), 'utf8');
    console.log(`\n  ✓ Removed ${ineligible.length} ineligible entries from apply-log.md`);
  }

  return ineligible;
}

// ── Pipeline Audit ──

async function auditPipeline(profileName, apply) {
  const pipePath = resolve(__dirname, 'profiles', profileName, 'data/pipeline.md');
  let content;
  try { content = await readFile(pipePath, 'utf8'); } catch { return []; }

  const lines = content.split('\n');
  const kept = [];
  const removed = [];

  for (const line of lines) {
    // Pipeline lines are typically URLs or "- URL | notes" format
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('|') && (trimmed.includes('URL') || trimmed.includes('---'))) {
      kept.push(line);
      continue;
    }

    // Extract any text from the line for location checking
    const result = checkEligibility(profileName, trimmed, trimmed, '', trimmed);
    if (!result.eligible) {
      removed.push({ line: trimmed, reason: result.reason });
    } else {
      kept.push(line);
    }
  }

  if (removed.length > 0) {
    console.log(`\n  Pipeline [${profileName}]: ${removed.length} ineligible of ${removed.length + kept.length - kept.filter(l => !l.trim() || l.trim().startsWith('#') || l.trim().startsWith('|')).length} entries`);
    for (const r of removed.slice(0, 10)) {
      console.log(`    ${r.line.slice(0, 80)}... — ${r.reason}`);
    }
    if (removed.length > 10) console.log(`    ... and ${removed.length - 10} more`);

    if (apply) {
      await writeFile(pipePath, kept.join('\n'), 'utf8');
      console.log(`  ✓ Removed ${removed.length} entries from ${profileName}/data/pipeline.md`);
    }
  } else {
    console.log(`\n  Pipeline [${profileName}]: all entries eligible`);
  }

  return removed;
}

// ── Main ──

async function main() {
  const apply = process.argv.includes('--apply');
  console.log(`\n  Location Audit ${apply ? '(APPLYING CHANGES)' : '(REPORT ONLY — use --apply to remove)'}`);

  await auditApplyLog(apply);
  await auditPipeline('paulina', apply);
  await auditPipeline('lamin', apply);
  await auditPipeline('josephina', apply);

  if (!apply) {
    console.log(`\n  To remove ineligible entries: node audit-locations.mjs --apply\n`);
  } else {
    console.log(`\n  Audit complete. Ineligible entries removed.\n`);
  }
}

main().catch(err => { console.error(`Fatal: ${err.message}`); process.exit(1); });
