#!/usr/bin/env node

/**
 * lever-apply.mjs — Submit applications via Lever (Playwright form-fill)
 *
 * Lever has h-captcha on their apply form, so pure API POST won't work.
 * Instead we use Playwright to fill the form and pause for human captcha solve.
 *
 * Usage:
 *   import { applyLever } from './lever-apply.mjs';
 *   const result = await applyLever({ postingUrl, candidate, resumePath, coverLetterPath });
 *
 * Or standalone:
 *   node lever-apply.mjs --job-url=https://jobs.lever.co/plaid/abc123 --profile=lamin --dry-run
 */

import { readFile } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Parse candidate from profile.yml ─────────────────────────

async function loadCandidate(profileName) {
  const ymlPath = resolve(__dirname, 'profiles', profileName, 'profile.yml');
  const yml = await readFile(ymlPath, 'utf8');

  const get = (key) => {
    const m = yml.match(new RegExp(`${key}:\\s*"?([^"\\n]+)"?`));
    return m ? m[1].trim() : '';
  };

  return {
    fullName: get('full_name').replace(/,?\s*(MD|PhD|DO|MBA|JD)$/i, '').trim(),
    email: get('email'),
    phone: get('phone'),
    linkedin: get('linkedin'),
    location: get('location'),
    org: '', // current company — optional
  };
}

// ── Parse Lever URL ──────────────────────────────────────────

function parseLeverUrl(url) {
  // https://jobs.lever.co/plaid/abc-123-def
  const m = url.match(/lever\.co\/([^/]+)\/([a-f0-9-]+)/);
  if (m) return { company: m[1], postingId: m[2] };
  return null;
}

// ── Playwright form-fill ─────────────────────────────────────

export async function applyLever({ postingUrl, candidate, resumePath, coverLetterPath, dryRun = false, headless = false }) {
  const applyUrl = postingUrl.includes('/apply') ? postingUrl : postingUrl + '/apply';

  if (dryRun) {
    console.log('    [DRY RUN] Would fill Lever application:');
    console.log(`    URL: ${applyUrl}`);
    console.log(`    Name: ${candidate.fullName}`);
    console.log(`    Email: ${candidate.email}`);
    console.log(`    Phone: ${candidate.phone}`);
    console.log(`    Resume: ${resumePath || 'NONE'}`);
    console.log(`    Cover Letter: ${coverLetterPath || 'NONE'}`);
    return { success: true, dryRun: true };
  }

  // Import Playwright dynamically
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    console.error('    Playwright not available. Install with: npx playwright install chromium');
    return { success: false, reason: 'playwright_not_installed' };
  }

  // Launch visible browser (user needs to solve captcha)
  const browser = await chromium.launch({
    headless,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });

  const page = await context.newPage();

  try {
    await page.goto(applyUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    // Fill basic fields
    const nameInput = page.locator('input[name="name"]');
    if (await nameInput.isVisible()) await nameInput.fill(candidate.fullName);

    const emailInput = page.locator('input[name="email"]');
    if (await emailInput.isVisible()) await emailInput.fill(candidate.email);

    const phoneInput = page.locator('input[name="phone"]');
    if (await phoneInput.isVisible()) await phoneInput.fill(candidate.phone);

    const locationInput = page.locator('input[name="location"]');
    if (await locationInput.isVisible()) await locationInput.fill(candidate.location);

    const orgInput = page.locator('input[name="org"]');
    if (await orgInput.isVisible() && candidate.org) await orgInput.fill(candidate.org);

    // LinkedIn URL
    const linkedinInput = page.locator('input[name="urls[LinkedIn]"]');
    if (await linkedinInput.isVisible() && candidate.linkedin) {
      const linkedinUrl = candidate.linkedin.startsWith('http') ? candidate.linkedin : `https://${candidate.linkedin}`;
      await linkedinInput.fill(linkedinUrl);
    }

    // Upload resume
    if (resumePath) {
      const resumeInput = page.locator('input[name="resume"]');
      if (await resumeInput.count() > 0) {
        await resumeInput.setInputFiles(resumePath);
        console.log('    Resume uploaded');
        await page.waitForTimeout(1500);
      }
    }

    // Upload cover letter via "Add file" if available
    // Lever often has a second file input or an "additional info" textarea
    // We'll use the comments field for cover letter text if no file upload
    if (coverLetterPath) {
      // Look for additional file upload
      const fileInputs = page.locator('input[type="file"]');
      const count = await fileInputs.count();
      if (count > 1) {
        await fileInputs.nth(1).setInputFiles(coverLetterPath);
        console.log('    Cover letter uploaded');
      }
    }

    console.log('    Form filled. Waiting for human to solve captcha and submit...');
    console.log('    >>> Solve the CAPTCHA in the browser window, then click Submit <<<');

    // Wait for navigation (submit) or timeout after 5 minutes
    try {
      await page.waitForURL('**/thanks**', { timeout: 300000 });
      console.log('    Application submitted successfully!');
      await browser.close();
      return { success: true };
    } catch {
      console.log('    Timeout — captcha not solved or form not submitted within 5 minutes');
      await browser.close();
      return { success: false, reason: 'captcha_timeout' };
    }
  } catch (err) {
    console.error(`    Error: ${err.message}`);
    await browser.close();
    return { success: false, reason: err.message };
  }
}

// ── CLI ──────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const headless = args.includes('--headless');
  const jobUrlArg = args.find(a => a.startsWith('--job-url='));
  const profileArg = args.find(a => a.startsWith('--profile='));

  if (!jobUrlArg) {
    console.log('Usage: node lever-apply.mjs --job-url=<lever-url> --profile=<name> [--dry-run]');
    process.exit(1);
  }

  const jobUrl = jobUrlArg.split('=').slice(1).join('=');

  let profileName;
  if (profileArg) {
    profileName = profileArg.split('=')[1];
  } else {
    const activeYml = await readFile(resolve(__dirname, 'profiles/active.yml'), 'utf8');
    profileName = activeYml.match(/active:\s*(\w+)/)?.[1] || 'paulina';
  }

  console.log(`\n  Lever Apply — Profile: ${profileName}`);
  console.log(`  ${'━'.repeat(50)}`);

  const candidate = await loadCandidate(profileName);

  // Find resume
  const { readdir } = await import('fs/promises');
  const outputDir = resolve(__dirname, 'profiles', profileName, 'output');
  let resumePath = null;
  try {
    const files = await readdir(outputDir);
    const pdf = files.find(f => f.toLowerCase().includes('cv') && f.endsWith('.pdf'));
    if (pdf) resumePath = resolve(outputDir, pdf);
  } catch { /* ok */ }

  // Find cover letter
  let coverLetterPath = null;
  try {
    const parsed = parseLeverUrl(jobUrl);
    if (parsed) {
      const clDir = resolve(__dirname, 'profiles', profileName, 'cover-letters');
      const files = await readdir(clDir);
      const cl = files.find(f => f.toLowerCase().includes(parsed.company) && f.endsWith('.pdf'));
      if (cl) coverLetterPath = resolve(clDir, cl);
    }
  } catch { /* ok */ }

  const result = await applyLever({
    postingUrl: jobUrl,
    candidate,
    resumePath,
    coverLetterPath,
    dryRun,
    headless,
  });

  console.log(`\n  Result: ${result.success ? 'SUCCESS' : 'FAILED'}`);
  if (result.reason) console.log(`  Reason: ${result.reason}`);
  console.log('');
}

if (process.argv[1] && process.argv[1].includes('lever-apply')) {
  main().catch(err => { console.error(`Fatal: ${err.message}`); process.exit(1); });
}
