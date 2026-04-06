#!/usr/bin/env node
/**
 * switch-profile.mjs -- Switch between career-ops profiles.
 *
 * Usage:
 *   node switch-profile.mjs            # Print current profile + available profiles
 *   node switch-profile.mjs paulina    # Switch to the paulina profile
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

function writeActive(name) {
  let text = fs.readFileSync(ACTIVE_YML, 'utf8');
  text = text.replace(/^active:\s*.+$/m, `active: ${name}`);
  fs.writeFileSync(ACTIVE_YML, text, 'utf8');
}

function listProfiles() {
  return fs.readdirSync(PROFILES_DIR).filter(entry => {
    if (entry === 'active.yml') return false;
    return fs.statSync(path.join(PROFILES_DIR, entry)).isDirectory();
  });
}

/** Copy src file to dest, creating parent dirs as needed. */
function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

/** Recursively copy all files from srcDir to destDir. */
function copyDirContents(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) return 0;
  let count = 0;
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      count += copyDirContents(srcPath, destPath);
    } else {
      copyFile(srcPath, destPath);
      count++;
    }
  }
  return count;
}

/**
 * Save-back: copy files from root data/, reports/, output/ back to the
 * profile directory, but only if the root copy is newer.
 */
function saveBack(profileName) {
  const profileDir = path.join(PROFILES_DIR, profileName);
  const dirs = ['data', 'reports', 'output', 'cover-letters'];
  let saved = 0;

  for (const dir of dirs) {
    const rootDir = path.join(ROOT, dir);
    if (!fs.existsSync(rootDir)) continue;
    saved += saveBackDir(rootDir, path.join(profileDir, dir));
  }
  return saved;
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

/**
 * Load a profile's files into the project root.
 */
function loadProfile(profileName) {
  const profileDir = path.join(PROFILES_DIR, profileName);
  let loaded = 0;

  // Individual file mappings: [source relative to profile, dest relative to root]
  const fileMappings = [
    ['cv.md',        'cv.md'],
    ['cv-de.md',     'cv-de.md'],
    ['profile.yml',  path.join('config', 'profile.yml')],
    ['_profile.md',  path.join('modes', '_profile.md')],
    ['portals.yml',  'portals.yml'],
  ];

  for (const [src, dest] of fileMappings) {
    const srcPath = path.join(profileDir, src);
    if (!fs.existsSync(srcPath)) continue;
    const destPath = path.join(ROOT, dest);
    copyFile(srcPath, destPath);
    loaded++;
  }

  // Directory mappings
  const dirMappings = ['data', 'reports', 'output', 'cover-letters'];
  for (const dir of dirMappings) {
    loaded += copyDirContents(
      path.join(profileDir, dir),
      path.join(ROOT, dir)
    );
  }

  return loaded;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const current = readActive();
const target = process.argv[2];

if (!target) {
  // Info mode: print current profile and list available
  console.log(`Active profile: ${current}`);
  console.log(`Available profiles: ${listProfiles().join(', ')}`);
  process.exit(0);
}

// Validate target profile
const profileDir = path.join(PROFILES_DIR, target);
if (!fs.existsSync(profileDir) || !fs.statSync(profileDir).isDirectory()) {
  console.error(`Error: Profile "${target}" not found in ${PROFILES_DIR}`);
  console.error(`Available profiles: ${listProfiles().join(', ')}`);
  process.exit(1);
}

if (target === current) {
  console.log(`Already on profile "${current}". Nothing to do.`);
  process.exit(0);
}

// Step 1: Save-back current profile
console.log(`Saving back root files to profile "${current}"...`);
const savedCount = saveBack(current);
console.log(`  ${savedCount} file(s) saved back.`);

// Step 2: Load target profile
console.log(`Loading profile "${target}"...`);
const loadedCount = loadProfile(target);
console.log(`  ${loadedCount} file(s) loaded.`);

// Step 3: Update active.yml
writeActive(target);
console.log(`Switched active profile: ${current} -> ${target}`);
