#!/usr/bin/env node
/**
 * save-profile.mjs -- Save root data/reports/output back to the active profile.
 *
 * Run this after a session to persist work back to the profile directory.
 *
 * Usage:
 *   node save-profile.mjs
 */

import fs from 'fs';
import path from 'path';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
const PROFILES_DIR = path.join(ROOT, 'profiles');
const ACTIVE_YML = path.join(PROFILES_DIR, 'active.yml');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readActive() {
  const text = fs.readFileSync(ACTIVE_YML, 'utf8');
  const match = text.match(/^active:\s*(.+)$/m);
  return match ? match[1].trim() : null;
}

/** Copy src file to dest, creating parent dirs as needed. */
function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

/** Recursively save-back newer files from rootDir to profileDir. */
function saveBackDir(rootDir, profileDir) {
  if (!fs.existsSync(rootDir)) return 0;
  let count = 0;
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const rootPath = path.join(rootDir, entry.name);
    const profPath = path.join(profileDir, entry.name);
    if (entry.isDirectory()) {
      count += saveBackDir(rootPath, profPath);
    } else {
      const rootStat = fs.statSync(rootPath);
      let profStat = null;
      try { profStat = fs.statSync(profPath); } catch { /* doesn't exist yet */ }
      if (!profStat || rootStat.mtimeMs > profStat.mtimeMs) {
        copyFile(rootPath, profPath);
        count++;
      }
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const current = readActive();
if (!current) {
  console.error('Error: Could not read active profile from profiles/active.yml');
  process.exit(1);
}

const profileDir = path.join(PROFILES_DIR, current);
if (!fs.existsSync(profileDir)) {
  console.error(`Error: Profile directory not found: ${profileDir}`);
  process.exit(1);
}

console.log(`Saving root files back to profile "${current}"...`);

const dirs = ['data', 'reports', 'output'];
let total = 0;
for (const dir of dirs) {
  const rootDir = path.join(ROOT, dir);
  if (!fs.existsSync(rootDir)) {
    console.log(`  ${dir}/ -- skipped (not found)`);
    continue;
  }
  const count = saveBackDir(rootDir, path.join(profileDir, dir));
  console.log(`  ${dir}/ -- ${count} file(s) saved`);
  total += count;
}

console.log(`Done. ${total} file(s) saved back to profiles/${current}/`);
