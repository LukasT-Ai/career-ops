#!/usr/bin/env node

/**
 * localize-detect.mjs — Document Localization & Sponsorship Detection
 *
 * 5-step analysis of job postings:
 *   1. Location detection (USA / Germany / Other)
 *   2. Document format routing (Resume / Lebenslauf / Both)
 *   3. Cover letter language routing (English / German)
 *   4. Sponsorship detection (for US jobs — visa signals)
 *   5. Military base civilian position flagging
 *
 * Usage:
 *   import { analyzeJob } from './localize-detect.mjs';
 *   const result = analyzeJob(jobTitle, jobDescription, company, postingUrl);
 *
 * CLI:
 *   node localize-detect.mjs --title="Oberarzt Psychiatrie" --company="Charité" --url="charité.de/karriere"
 *   node localize-detect.mjs --file=jds/sample-jd.md
 */

import { readFile } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================
// Step 1: Location Detection
// ============================================================

const GERMAN_SIGNALS = {
  // Domain patterns
  domains: ['.de/', 'stepstone.de', 'xing.com', 'arbeitsagentur.de', 'kimeta.de',
            'stellenanzeigen.de', 'jobware.de', 'yourfirm.de', 'monster.de',
            'praktischarzt.de', 'aerzteblatt.de', 'medi-jobs.de', 'berlinstartupjobs.com'],
  // Language keywords (uniquely German, not English)
  language: ['stelle', 'stellenangebot', 'bewerbung', 'berufserfahrung', 'ausbildung',
             'arbeitgeber', 'arbeitszeit', 'vollzeit', 'teilzeit', 'unbefristet', 'befristet',
             'tarifvertrag', 'vergütung', 'gehaltsvorstellung', 'eintrittsdatum',
             'probezeit', 'kündigungsfrist', '(m/w/d)', '(w/m/d)', '(m/f/d)',
             'sehr geehrte', 'wir bieten', 'wir suchen', 'ihre aufgaben',
             'ihr profil', 'unser angebot', 'was wir bieten'],
  // Currency
  currency: ['eur', '€'],
  // German cities
  cities: ['berlin', 'münchen', 'munich', 'hamburg', 'frankfurt', 'köln', 'cologne',
           'düsseldorf', 'stuttgart', 'dortmund', 'essen', 'leipzig', 'bremen',
           'dresden', 'hannover', 'nürnberg', 'nuremberg', 'heidelberg', 'freiburg',
           'bonn', 'münster', 'karlsruhe', 'mannheim', 'augsburg', 'wiesbaden',
           'aachen', 'kiel', 'lübeck', 'rostock', 'potsdam', 'chemnitz'],
};

const US_SIGNALS = {
  domains: ['.com/jobs', '.com/careers', 'indeed.com', 'linkedin.com', 'ziprecruiter.com',
            'glassdoor.com', 'monster.com', 'careerbuilder.com', 'usajobs.gov',
            'jobs.ca.gov', 'careers.georgia.gov'],
  language: ['equal opportunity employer', 'eoe', 'at-will employment', '401k', '401(k)',
             'pto', 'health insurance', 'dental', 'vision', 'work authorization',
             'background check', 'drug test', 'i-9', 'e-verify'],
  currency: ['usd', '$', 'per year', '/yr', '/year', 'annually'],
  states: ['ga', 'georgia', 'ca', 'california', 'ny', 'new york', 'tx', 'texas',
           'fl', 'florida', 'il', 'illinois', 'wa', 'washington', 'ma', 'massachusetts',
           'co', 'colorado', 'or', 'oregon', 'nc', 'north carolina', 'va', 'virginia',
           'atlanta', 'san francisco', 'los angeles', 'new york city', 'chicago',
           'seattle', 'boston', 'denver', 'austin', 'remote us', 'usa'],
};

function detectLocation(title, description, company, url) {
  const text = `${title} ${description} ${company} ${url}`.toLowerCase();

  let deScore = 0;
  let usScore = 0;

  // URL signals (strongest)
  for (const d of GERMAN_SIGNALS.domains) { if (url.toLowerCase().includes(d)) deScore += 3; }
  for (const d of US_SIGNALS.domains) { if (url.toLowerCase().includes(d)) usScore += 3; }

  // Language signals
  for (const kw of GERMAN_SIGNALS.language) { if (text.includes(kw)) deScore += 2; }
  for (const kw of US_SIGNALS.language) { if (text.includes(kw)) usScore += 2; }

  // Currency
  for (const c of GERMAN_SIGNALS.currency) { if (text.includes(c)) deScore += 2; }
  for (const c of US_SIGNALS.currency) { if (text.includes(c)) usScore += 2; }

  // Cities/States
  for (const city of GERMAN_SIGNALS.cities) { if (text.includes(city)) deScore += 1; }
  for (const state of US_SIGNALS.states) { if (text.includes(state)) usScore += 1; }

  // Arbeitsagentur URLs are always German
  if (url.includes('arbeitsagentur.de')) deScore += 10;

  if (deScore > usScore + 2) return { location: 'germany', confidence: Math.min(100, deScore * 10) };
  if (usScore > deScore + 2) return { location: 'usa', confidence: Math.min(100, usScore * 10) };
  return { location: 'unclear', confidence: 50 };
}

// ============================================================
// Step 2: Document Format Selection
// ============================================================

/**
 * Resolve CV files for a profile, checking existence.
 *
 * Rules:
 *   - Use existing cv-de.md for Lebenslauf if the profile has one
 *   - If cv-de.md is missing, flag it for auto-generation from cv.md
 *   - ALWAYS include the English cv.md as secondary attachment where allowed
 *
 * @param {string} profileName - Active profile name (e.g. 'lamin', 'paulina')
 * @returns {{ cvPath, cvDePath, cvDeExists, cvExists, needsLebenslaufGeneration }}
 */
function resolveProfileCVs(profileName) {
  const cvPath = resolve(__dirname, `profiles/${profileName}/cv.md`);
  const cvDePath = resolve(__dirname, `profiles/${profileName}/cv-de.md`);
  return {
    cvPath,
    cvDePath,
    cvExists: existsSync(cvPath),
    cvDeExists: existsSync(cvDePath),
    needsLebenslaufGeneration: !existsSync(cvDePath),
  };
}

function selectDocumentFormat(locationResult, languageDetected, profileCVs) {
  if (locationResult.location === 'germany' && languageDetected === 'german') {
    return {
      resume_format: 'lebenslauf',
      cv_file: 'cv-de.md',
      cv_file_en: 'cv.md',     // always attach English version too
      cv_de_exists: profileCVs?.cvDeExists ?? true,
      needs_lebenslauf_generation: profileCVs?.needsLebenslaufGeneration ?? false,
      attach_english_cv: true,  // "always attach the English version where it allows"
      date_format: 'DD.MM.YYYY',
      length: '1-2 pages',
      sections: ['Persönliche Daten', 'Berufserfahrung', 'Ausbildung', 'Sprachkenntnisse', 'Zusätzliche Qualifikationen'],
    };
  }
  if (locationResult.location === 'germany' && languageDetected === 'english') {
    // English-language job at German company — use both
    return {
      resume_format: 'both',
      cv_file: 'cv.md',
      cv_file_de: 'cv-de.md',
      cv_de_exists: profileCVs?.cvDeExists ?? true,
      needs_lebenslauf_generation: profileCVs?.needsLebenslaufGeneration ?? false,
      attach_english_cv: true,
      date_format: 'YYYY-MM-DD',
      length: '1 page (EN) + 2 pages (DE)',
      sections: ['Standard US Resume + German Lebenslauf backup'],
    };
  }
  // Default: US Resume
  return {
    resume_format: 'resume',
    cv_file: 'cv.md',
    cv_de_exists: profileCVs?.cvDeExists ?? false,
    needs_lebenslauf_generation: false,
    attach_english_cv: false,  // US job — English CV is primary, no secondary needed
    date_format: 'Month YYYY',
    length: '1 page',
    sections: ['Contact', 'Professional Summary', 'Experience', 'Education', 'Skills', 'Certifications'],
  };
}

// ============================================================
// Step 3: Cover Letter Language Routing
// ============================================================

function detectLanguage(title, description) {
  const text = `${title} ${description}`.toLowerCase();
  let deCount = 0;
  let enCount = 0;

  for (const kw of GERMAN_SIGNALS.language) { if (text.includes(kw)) deCount++; }
  for (const kw of US_SIGNALS.language) { if (text.includes(kw)) enCount++; }

  // Check for (m/w/d) pattern — strong German signal
  if (/\(m\/w\/d\)|\(w\/m\/d\)|\(m\/f\/d\)/.test(text)) deCount += 5;

  // Check for common German words in title
  const germanTitleWords = ['facharzt', 'fachärztin', 'oberarzt', 'oberärztin', 'chefarzt',
    'assistenzarzt', 'vertrieb', 'leitung', 'stellvertretend', 'abteilung'];
  for (const w of germanTitleWords) { if (text.includes(w)) deCount += 3; }

  if (deCount > enCount + 2) return 'german';
  if (enCount > deCount + 2) return 'english';
  if (deCount > 0) return 'german'; // tie-break: if any German signals, go German
  return 'english';
}

function selectCoverLetterFormat(language) {
  if (language === 'german') {
    return {
      cover_letter_language: 'german',
      format: 'bewerbungsschreiben',
      salutation: 'Sehr geehrte Damen und Herren,',
      closing: 'Mit freundlichen Grüßen',
      tone: 'formal, structured, respectful of hierarchy',
      length: '250 words',
      rules: [
        'Use Sie (formal), never du',
        'No exclamation marks',
        'Dates: DD. Monat YYYY',
        'No contractions',
        'Avoid "Liebe/r" (too casual)',
      ],
      page_format: 'a4',
    };
  }
  return {
    cover_letter_language: 'english',
    format: 'business_letter',
    salutation: 'Dear Hiring Manager,',
    closing: 'Best regards',
    tone: 'warm, confident, conversational but professional',
    length: '200-300 words',
    rules: [
      'First names OK if known',
      'Contractions OK',
      'Short paragraphs (2-3 sentences)',
      'Show personality',
      'Avoid clichés',
    ],
    page_format: 'letter',
  };
}

// ============================================================
// Step 4: Sponsorship Detection
// ============================================================

// Tier 0 (highest): German medical credential recognition / Approbation support
// Employers who help with Approbation or Berufserlaubnis for foreign-trained doctors
const APPROBATION_TIER0 = [
  'approbation', 'berufserlaubnis', 'anerkennung der approbation',
  'approbationsverfahren', 'berufsanerkennung', 'anerkennung ausländischer abschlüsse',
  'anerkennung ärztlicher qualifikationen', 'kenntnisprüfung',
  'gleichwertigkeitsprüfung', 'fachsprachprüfung',
  'we support approbation', 'approbation support', 'credential recognition',
  'medical license recognition', 'license transfer', 'medical credential',
  'unterstützung bei der approbation', 'hilfe bei berufserlaubnis',
  'ärztliche anerkennung', 'unterstützung im anerkennungsverfahren',
  'internationale ärzte willkommen', 'international medical graduates',
  'img welcome', 'img friendly', 'international physicians',
  'ausländische ärzte', 'ärzte aus dem ausland',
  'relocation support for physicians', 'onboarding international doctors',
];

// Known German hospitals/networks that actively recruit internationally and support Approbation
const APPROBATION_EMPLOYERS = [
  // Major university hospitals (Unikliniken) — have international recruitment offices
  'charité', 'vivantes', 'universitätsklinikum', 'uniklinik', 'uniklinikum',
  'universitätsmedizin', 'uni-klinik', 'max-planck',
  // Large private hospital chains — known international recruitment programs
  'helios', 'asklepios', 'sana kliniken', 'rhön-klinikum', 'schön klinik',
  'ameos', 'median', 'oberberg', 'mediclin', 'paracelsus-kliniken',
  // Public psychiatric networks
  'vitos', 'lwl-klinik', 'bezirksklinikum', 'bezirkskrankenhaus',
  'landeskrankenhaus', 'psychiatrische klinik', 'zfp ', 'pfalzklinikum',
];

// Medical staffing agencies that specialize in placing international doctors
// These agencies typically assist with Approbation/Berufserlaubnis paperwork
const APPROBATION_AGENCIES = [
  'sanovetis', 'ema vermittlung', 'ema - vermittlung', 'akut doc', 'akut...doc',
  'tw.con', 'bs menzel', 'hb-pro', 'locumwork', 'healthbridge',
  'siiri schuetz', 'approbatio', 'facharztagentur', 'advias',
  'rocket match', 'notificai', 'premiumjob',
];

const SPONSORSHIP_TIER1 = [
  'visa sponsorship', 'h1b sponsorship', 'h-1b sponsorship',
  'we sponsor visa', 'willing to sponsor visa', 'immigration sponsorship',
  'sponsorship available', 'we provide visa sponsorship',
  'visa sponsorship for qualified', 'us work visa sponsorship',
  'sponsorship for international',
];

const SPONSORSHIP_TIER2_COMPANIES = [
  // Telepsych known sponsors
  'talkspace', 'betterhelp', 'ro', 'spring health', 'mindful care', 'amwell', 'mdlive',
  // Major healthcare networks
  'emory', 'kaiser permanente', 'ucsf', 'johns hopkins', 'mayo clinic',
  'cleveland clinic', 'mass general', 'stanford health', 'mount sinai',
  'nyu langone', 'columbia', 'upenn', 'duke health',
];

const SPONSORSHIP_TIER3 = [
  'relocation package', 'relocation assistance',
  'international candidates', 'global team', 'worldwide',
  'equal opportunity', 'diverse workforce',
];

const SPONSORSHIP_NEGATIVE = [
  'us citizens only', 'must have us work authorization',
  'green card holders only', 'no sponsorship available',
  'no visa sponsorship', 'local candidates preferred',
  'permanent resident required', 'no relocation assistance',
  'must be authorized to work in the united states',
  'will not sponsor', 'unable to sponsor',
];

function normalizeAccents(str) {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function detectSponsorship(title, description, company) {
  const text = normalizeAccents(`${title} ${description} ${company}`.toLowerCase());

  // Check negative signals first (highest priority)
  for (const neg of SPONSORSHIP_NEGATIVE) {
    if (text.includes(neg)) {
      return {
        sponsorship_status: 'NO',
        sponsorship_confidence: 95,
        sponsorship_reason: `Explicit restriction: "${neg}"`,
        sponsorship_flag: 'NO_SPONSORSHIP',
        contact_recommendation: false,
      };
    }
  }

  // Tier 0: Approbation / medical credential recognition (German jobs)
  for (const kw of APPROBATION_TIER0) {
    if (text.includes(normalizeAccents(kw))) {
      return {
        sponsorship_status: 'APPROBATION',
        sponsorship_confidence: 100,
        sponsorship_reason: `Approbation/credential support: "${kw}"`,
        sponsorship_flag: 'APPROBATION_SUPPORT',
        approbation: true,
        contact_recommendation: false,
      };
    }
  }

  // Tier 0b: Known Approbation-supporting employers (German hospital networks)
  const companyLower = normalizeAccents(company.toLowerCase());
  for (const emp of APPROBATION_EMPLOYERS) {
    if (companyLower.includes(normalizeAccents(emp))) {
      return {
        sponsorship_status: 'APPROBATION_LIKELY',
        sponsorship_confidence: 85,
        sponsorship_reason: `${company} is a major German hospital network that typically supports Approbation for international physicians`,
        sponsorship_flag: 'APPROBATION_LIKELY',
        approbation: true,
        contact_recommendation: false,
      };
    }
  }

  // Tier 0c: Medical staffing agencies specializing in international doctor placement
  for (const agency of APPROBATION_AGENCIES) {
    if (companyLower.includes(normalizeAccents(agency))) {
      return {
        sponsorship_status: 'APPROBATION_LIKELY',
        sponsorship_confidence: 75,
        sponsorship_reason: `${company} is a medical staffing agency that typically assists with Approbation/Berufserlaubnis for international physicians`,
        sponsorship_flag: 'APPROBATION_LIKELY',
        approbation: true,
        contact_recommendation: false,
      };
    }
  }

  // Tier 1: Explicit visa sponsorship statements (US jobs)
  for (const kw of SPONSORSHIP_TIER1) {
    if (text.includes(kw)) {
      return {
        sponsorship_status: 'CONFIRMED',
        sponsorship_confidence: 100,
        sponsorship_reason: `Explicit statement: "${kw}"`,
        sponsorship_flag: 'SPONSORSHIP_YES',
        approbation: false,
        contact_recommendation: false,
      };
    }
  }

  // Tier 2: Known US sponsor companies
  for (const comp of SPONSORSHIP_TIER2_COMPANIES) {
    if (companyLower.includes(comp)) {
      return {
        sponsorship_status: 'LIKELY',
        sponsorship_confidence: 78,
        sponsorship_reason: `${company} is a known visa sponsor for medical roles`,
        sponsorship_flag: 'SPONSORSHIP_LIKELY',
        approbation: false,
        contact_recommendation: false,
      };
    }
  }

  // Tier 3: Contextual indicators
  for (const kw of SPONSORSHIP_TIER3) {
    if (text.includes(kw)) {
      return {
        sponsorship_status: 'POSSIBLE',
        sponsorship_confidence: 50,
        sponsorship_reason: `Contextual signal: "${kw}"`,
        sponsorship_flag: 'SPONSORSHIP_MAYBE',
        contact_recommendation: true,
      };
    }
  }

  // No signals
  return {
    sponsorship_status: 'UNKNOWN',
    sponsorship_confidence: 0,
    sponsorship_reason: 'No sponsorship information found in posting',
    sponsorship_flag: 'SPONSORSHIP_UNKNOWN',
    contact_recommendation: true,
  };
}

// ============================================================
// Step 5: Military Base Civilian Detection
// ============================================================

const MILITARY_KEYWORDS = {
  bundeswehr: ['bundeswehr', 'bundesministerium der verteidigung', 'bmvg',
               'verteidigungsministerium', 'streitkräfte', 'streitkräftebasis',
               'zentraler sanitätsdienst'],
  branches: ['luftwaffe', 'heer', 'marine'],
  nato: ['nato base', 'nato airbase', 'nato air base', 'nato training',
         'nato civilian', 'nato international'],
  bases: ['ramstein', 'grafenwoehr', 'grafenwöhr', 'geilenkirchen', 'büchel',
          'wiesbaden kaserne', 'garlstedt', 'strausberg', 'wallerstein',
          'altenstadt air base', 'spangdahlem', 'landstuhl', 'baumholder',
          'vilseck', 'hohenfels', 'ansbach', 'kaiserslautern military'],
  us_military_de: ['usareur', 'usafe', 'us army europe', 'us air force europe',
                   'afcent', 'eucom', 'sofa agreement'],
};

function detectMilitary(title, description, company, url) {
  const text = `${title} ${description} ${company} ${url}`.toLowerCase();

  // Check base names (most specific)
  for (const base of MILITARY_KEYWORDS.bases) {
    if (text.includes(base)) {
      const isUSBase = ['ramstein', 'grafenwoehr', 'grafenwöhr', 'spangdahlem',
                        'landstuhl', 'baumholder', 'vilseck', 'hohenfels', 'ansbach']
                        .some(b => text.includes(b));
      return {
        military_detected: true,
        military_type: isUSBase ? 'US_MILITARY_BASE' : 'NATO_CIVILIAN',
        military_base: base,
        language_requirement: isUSBase ? 'English required, German helpful' : 'English + German',
        visa_note: isUSBase ? 'SOFA agreement may cover US citizens' : 'NATO civilian status',
      };
    }
  }

  // Check US military in Germany
  for (const kw of MILITARY_KEYWORDS.us_military_de) {
    if (text.includes(kw)) {
      return {
        military_detected: true,
        military_type: 'US_MILITARY_BASE',
        military_base: 'US military installation (Germany)',
        language_requirement: 'English required',
        visa_note: 'SOFA agreement — US citizenship often required',
      };
    }
  }

  // Check Bundeswehr
  for (const kw of MILITARY_KEYWORDS.bundeswehr) {
    if (text.includes(kw)) {
      return {
        military_detected: true,
        military_type: 'BUNDESWEHR_CIVILIAN',
        military_base: 'Bundeswehr installation',
        language_requirement: 'German B1+ required',
        visa_note: 'German/EU citizenship preferred, work permit required for others',
      };
    }
  }

  // Check NATO
  for (const kw of MILITARY_KEYWORDS.nato) {
    if (text.includes(kw)) {
      return {
        military_detected: true,
        military_type: 'NATO_CIVILIAN',
        military_base: 'NATO installation',
        language_requirement: 'English required, German preferred',
        visa_note: 'NATO civilian status — special visa arrangements',
      };
    }
  }

  return { military_detected: false };
}

// ============================================================
// Main Analysis — Combines All 5 Steps
// ============================================================

/**
 * Analyze a job posting for localization, sponsorship, and military signals.
 *
 * @param {string} title - Job title
 * @param {string} description - Full job description text
 * @param {string} company - Company name
 * @param {string} url - Job posting URL
 * @param {string} [profileName] - Active profile name (for CV existence checks)
 * @returns {object} Complete localization analysis
 */
export { resolveProfileCVs };

export function analyzeJob(title, description = '', company = '', url = '', profileName = '') {
  // Step 1: Location
  const locationResult = detectLocation(title, description, company, url);

  // Step 3 (before 2, because 2 needs language): Language detection
  const language = detectLanguage(title, description);

  // Resolve profile CVs if profile name provided
  const profileCVs = profileName ? resolveProfileCVs(profileName) : null;

  // Step 2: Document format (profile-aware)
  const documentFormat = selectDocumentFormat(locationResult, language, profileCVs);

  // Step 3: Cover letter format
  const coverLetterFormat = selectCoverLetterFormat(language);

  // Step 4: Sponsorship / Approbation detection
  let sponsorship = null;
  if (locationResult.location === 'germany') {
    // For German jobs, check for Approbation/Berufserlaubnis support signals
    sponsorship = detectSponsorship(title, description, company);
    // If no US-style sponsorship detected, keep as N/A — but preserve Approbation hits
    if (!sponsorship.approbation && sponsorship.sponsorship_status !== 'APPROBATION' && sponsorship.sponsorship_status !== 'APPROBATION_LIKELY') {
      sponsorship = null; // will fall through to N/A default below
    }
  } else if (locationResult.location === 'usa' || locationResult.location === 'unclear') {
    sponsorship = detectSponsorship(title, description, company);
  }

  // Step 5: Military base (only for German locations or known base names)
  const military = detectMilitary(title, description, company, url);

  // All candidates are dual US/German citizens — note this
  const citizenshipNote = locationResult.location === 'germany'
    ? 'German citizen — no work permit needed'
    : locationResult.location === 'usa'
      ? 'US citizen — no sponsorship needed (but detected for info)'
      : 'Dual US/German citizen — eligible for both markets';

  return {
    // Step 1
    location_detected: locationResult.location,
    location_confidence: locationResult.confidence,

    // Step 2
    ...documentFormat,

    // Step 3
    ...coverLetterFormat,
    language_detected: language,

    // Step 4
    sponsorship: sponsorship || {
      sponsorship_status: 'N/A',
      sponsorship_reason: locationResult.location === 'germany'
        ? 'German job — no Approbation/credential support signals detected'
        : 'German job — no US sponsorship needed',
    },

    // Step 5
    military: military,

    // Meta
    citizenship_note: citizenshipNote,

    // Instructions for downstream systems
    special_instructions: buildInstructions(locationResult, language, sponsorship, military, documentFormat),
  };
}

function buildInstructions(location, language, sponsorship, military, documentFormat) {
  const instructions = [];

  if (location.location === 'germany' && language === 'german') {
    if (documentFormat?.needs_lebenslauf_generation) {
      instructions.push('GENERATE Lebenslauf from cv.md (cv-de.md does not exist for this profile)');
    } else {
      instructions.push('Use existing Lebenslauf (cv-de.md)');
    }
    instructions.push('Generate Bewerbungsschreiben (German cover letter)');
    instructions.push('Use A4 page format');
    instructions.push('Dates in DD.MM.YYYY format');
    instructions.push('ATTACH English CV (cv.md) as secondary document where application allows');
  } else if (location.location === 'germany' && language === 'english') {
    instructions.push('Generate US Resume using cv.md as primary');
    if (documentFormat?.needs_lebenslauf_generation) {
      instructions.push('GENERATE German Lebenslauf from cv.md (cv-de.md does not exist)');
    } else {
      instructions.push('Attach existing German Lebenslauf (cv-de.md) as secondary');
    }
    instructions.push('Cover letter in English');
    instructions.push('Mention German citizenship / no visa needed');
  } else {
    instructions.push('Generate US Resume using cv.md');
    instructions.push('Cover letter in English (US business letter format)');
    instructions.push('Use Letter page format');
  }

  // Attachment reminder for auto-generated docs
  if (documentFormat?.needs_lebenslauf_generation || location.location === 'germany') {
    instructions.push('ATTACH all generated documents (Resume/Lebenslauf + cover letter) to notification email');
  }

  if (sponsorship?.sponsorship_status === 'NO') {
    instructions.push('NOTE: No visa sponsorship — but candidate is US citizen, apply anyway');
  }

  if (military.military_detected) {
    instructions.push(`MILITARY: ${military.military_type} — ${military.language_requirement}`);
    instructions.push(`VISA: ${military.visa_note}`);
  }

  return instructions;
}

// ============================================================
// CLI
// ============================================================

async function main() {
  const args = process.argv.slice(2);

  const titleArg = args.find(a => a.startsWith('--title='));
  const companyArg = args.find(a => a.startsWith('--company='));
  const urlArg = args.find(a => a.startsWith('--url='));
  const descArg = args.find(a => a.startsWith('--desc='));
  const fileArg = args.find(a => a.startsWith('--file='));
  const profileArg = args.find(a => a.startsWith('--profile='));

  let title = titleArg?.split('=').slice(1).join('=') || '';
  let company = companyArg?.split('=').slice(1).join('=') || '';
  let url = urlArg?.split('=').slice(1).join('=') || '';
  let description = descArg?.split('=').slice(1).join('=') || '';
  let profileName = profileArg?.split('=').slice(1).join('=') || '';

  if (fileArg) {
    const filePath = resolve(__dirname, fileArg.split('=').slice(1).join('='));
    description = await readFile(filePath, 'utf8');
  }

  // Auto-detect profile from active.yml if not specified
  if (!profileName) {
    try {
      const activeYml = await readFile(resolve(__dirname, 'profiles/active.yml'), 'utf8');
      profileName = activeYml.match(/active:\s*(\w+)/)?.[1] || '';
    } catch { /* no active profile */ }
  }

  if (!title && !description) {
    console.log(`
  Usage:
    node localize-detect.mjs --title="Oberarzt Psychiatrie (m/w/d)" --company="Charité" --url="charite.de/karriere"
    node localize-detect.mjs --file=jds/sample-jd.md --title="Staff Psychiatrist" --company="Emory" --profile=paulina

  Analyzes job postings for:
    1. Location (USA / Germany)
    2. Document format (Resume / Lebenslauf)
    3. Cover letter language (English / German)
    4. Sponsorship signals (for US jobs)
    5. Military base civilian positions
`);
    return;
  }

  const result = analyzeJob(title, description, company, url, profileName);

  console.log(`\n  Localization Analysis`);
  console.log(`  ${'━'.repeat(50)}`);
  console.log(`  Profile:    ${profileName || '(none)'}`);
  console.log(`  Job:        ${title || '(from file)'}`);
  console.log(`  Company:    ${company || 'Unknown'}`);
  console.log(`  Location:   ${result.location_detected.toUpperCase()} (confidence: ${result.location_confidence}%)`);
  console.log(`  Language:   ${result.language_detected}`);
  console.log(`  CV Format:  ${result.resume_format}`);
  console.log(`  CL Format:  ${result.cover_letter_language} (${result.format})`);
  console.log(`  Page Size:  ${result.page_format}`);

  if (result.sponsorship.sponsorship_status !== 'N/A') {
    const emoji = { CONFIRMED: '🟢', LIKELY: '🟡', POSSIBLE: '🔵', UNKNOWN: '⚪', NO: '🔴' };
    console.log(`  Sponsor:    ${emoji[result.sponsorship.sponsorship_status] || ''} ${result.sponsorship.sponsorship_status} (${result.sponsorship.sponsorship_confidence}%)`);
    console.log(`              ${result.sponsorship.sponsorship_reason}`);
  }

  if (result.military.military_detected) {
    console.log(`  Military:   ${result.military.military_type} — ${result.military.military_base}`);
    console.log(`              ${result.military.language_requirement}`);
  }

  console.log(`  Citizen:    ${result.citizenship_note}`);
  if (result.needs_lebenslauf_generation) {
    console.log(`  CV-DE:      MISSING — will auto-generate from cv.md`);
  } else if (result.cv_de_exists) {
    console.log(`  CV-DE:      EXISTS (cv-de.md)`);
  }
  if (result.attach_english_cv) {
    console.log(`  EN Attach:  YES — English CV will be attached as secondary`);
  }
  console.log(`\n  Instructions:`);
  for (const instr of result.special_instructions) {
    console.log(`    → ${instr}`);
  }
  console.log('');
}

// Only run CLI when executed directly, not when imported
const isDirectRun = process.argv[1]?.replace(/\\/g, '/').endsWith('localize-detect.mjs');
if (isDirectRun) {
  main().catch(err => {
    console.error(`Fatal: ${err.message}`);
    process.exit(1);
  });
}
