#!/usr/bin/env node
/**
 * build-digest-data.mjs — Extract dispatched jobs from pipeline,
 * enrich with salary & Bundesland data, write digest-jobs.json, and
 * optionally send the digest.
 *
 * Usage:
 *   node build-digest-data.mjs --dry-run                        # preview paulina (default)
 *   node build-digest-data.mjs --profile=paulina --dry-run      # preview paulina
 *   node build-digest-data.mjs --profile=lamin --dry-run        # preview lamin
 *   node build-digest-data.mjs --profile=paulina --send         # send to Paulina
 *   node build-digest-data.mjs --profile=lamin --send           # send to Lamin
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { estimateSalary, getBundeslandInfo, estimateUSSalary } from './salary-bundesland.mjs';
import { sendDigest } from './digest-sender.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================
// Pipeline Parser
// ============================================================

/** Shared helper: parse "Title — Location" from a combined string */
function parseTitleLocation(titleLoc) {
  const dashSplit = titleLoc.split(/\s*[—–]\s*/);
  let title, location;
  if (dashSplit.length >= 2) {
    title = dashSplit[0].trim();
    location = dashSplit.slice(1).join(' — ').trim();
  } else {
    title = titleLoc.trim();
    location = null;
  }
  if (location) {
    location = location.replace(/[⭐💜🌐🟢]/g, '').trim();
  }
  return { title, location };
}

/** URL pattern that matches any http(s) URL in pipeline entries */
const URL_PATTERN = '(https?:\\/\\/[^\\s|]+)';

function detectSource(url) {
  if (url.includes('usajobs.gov')) return 'usajobs';
  if (url.includes('arbeitsagentur')) return 'arbeitsagentur';
  if (url.includes('adzuna.com')) return 'adzuna';
  if (url.includes('remoteok.com')) return 'remoteok';
  if (url.includes('remotive.com')) return 'remotive';
  if (url.includes('arbeitnow.com')) return 'arbeitnow';
  if (url.includes('jooble.org')) return 'jooble';
  if (url.includes('linkedin.com')) return 'linkedin';
  if (url.includes('indeed.com')) return 'indeed';
  if (url.includes('monster.com') || url.includes('monster.de')) return 'monster';
  return 'other';
}

/** Determine if a source is a USA job source */
function isUSASource(source) {
  return ['usajobs', 'remoteok', 'remotive'].includes(source);
}

/** Determine country from source + location context */
function detectCountry(source, location) {
  if (isUSASource(source)) return 'us';
  if (source === 'arbeitsagentur' || source === 'arbeitnow') return 'de';
  // Adzuna and Jooble can be either — check location or URL
  const loc = (location || '').toLowerCase();
  if (/atlanta|georgia|county|texas|california|remote|us\b|usa/i.test(loc)) return 'us';
  return 'de'; // Default to Germany
}

function parsePipelineJobs(pipelineText) {
  const lines = pipelineText.split('\n');
  const jobs = [];

  for (const line of lines) {
    // Match DISPATCHED lines (BA or USAJobs)
    // Format: - [x] DISPATCHED | URL | Company | Title — Location | Score | PDF
    const dispatchedMatch = line.match(
      new RegExp(`^\\s*-\\s*\\[x\\]\\s*DISPATCHED\\s*\\|\\s*${URL_PATTERN}\\s*\\|\\s*([^|]+?)\\s*\\|\\s*([^|]+?)\\s*\\|\\s*([\\d.]+)\\/5`)
    );
    if (dispatchedMatch) {
      const [, url, company, titleLoc, score] = dispatchedMatch;
      const { title, location } = parseTitleLocation(titleLoc);
      jobs.push({
        url: url.trim(),
        company: company.trim(),
        title,
        location,
        rawScore: parseFloat(score),
        fitScore: Math.round(parseFloat(score) * 20),
        source: detectSource(url),
      });
      continue;
    }

    // Match evaluated lines with report numbers: - [x] #NNN | URL | Company | Title | Score | PDF/SKIP
    // Lamin format: - [x] #001 | URL | Company | Title | Score | PDF
    const evalMatch = line.match(
      new RegExp(`^\\s*-\\s*\\[x\\]\\s*#\\d+\\s*\\|\\s*${URL_PATTERN}\\s*\\|\\s*([^|]+?)\\s*\\|\\s*([^|]+?)\\s*\\|\\s*([\\d.]+)\\/5`)
    );
    if (evalMatch && !line.includes('SKIP')) {
      const [, url, company, titleLoc, score] = evalMatch;
      const { title, location } = parseTitleLocation(titleLoc);
      jobs.push({
        url: url.trim(),
        company: company.trim(),
        title,
        location,
        rawScore: parseFloat(score),
        fitScore: Math.round(parseFloat(score) * 20),
        source: detectSource(url),
      });
      continue;
    }

    // Match older non-DISPATCHED checked lines (BA or USAJobs, no #NNN prefix)
    const olderMatch = line.match(
      new RegExp(`^\\s*-\\s*\\[x\\]\\s*${URL_PATTERN}\\s*\\|\\s*([^|]+?)\\s*\\|\\s*([^|]+?)\\s*\\|\\s*([\\d.]+)\\/5`)
    );
    if (olderMatch && !line.includes('DISPATCHED') && !line.includes('SKIP') && !line.match(/^\s*-\s*\[x\]\s*#\d+/)) {
      const [, url, company, titleLoc, score] = olderMatch;
      const { title, location } = parseTitleLocation(titleLoc);
      jobs.push({
        url: url.trim(),
        company: company.trim(),
        title,
        location,
        rawScore: parseFloat(score),
        fitScore: Math.round(parseFloat(score) * 20),
        source: detectSource(url),
      });
      continue;
    }

    // Match NEW unchecked BA lines: - [ ] URL | Company | Title — Location
    const newBAMatch = line.match(
      /^\s*-\s*\[ \]\s*(https?:\/\/www\.arbeitsagentur[^\s|]+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)(?:\s*\|\s*🟢\s*APPROBATION)?$/
    );
    if (newBAMatch) {
      const [, url, company, titleLocRaw] = newBAMatch;
      const titleLoc = titleLocRaw.replace(/\s*\|\s*🟢\s*APPROBATION\s*$/, '').trim();
      const { title, location } = parseTitleLocation(titleLoc);
      jobs.push({
        url: url.trim(),
        company: company.trim(),
        title,
        location,
        rawScore: 3.5,
        fitScore: 70,
        source: 'arbeitsagentur',
        isNew: true,
      });
      continue;
    }

    // Match NEW unchecked USAJobs lines: - [ ] URL | Company | Title — Location | Salary | Grade
    const newUSAMatch = line.match(
      /^\s*-\s*\[ \]\s*(https?:\/\/www\.usajobs\.gov[^\s|]+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)(?:\s*\|\s*(\$[^|]+?))?(?:\s*\|\s*([A-Z]{2,3}-\d+[^|]*))?$/
    );
    if (newUSAMatch) {
      const [, url, company, titleLocRaw, salaryRaw, gradeRaw] = newUSAMatch;
      const { title, location } = parseTitleLocation(titleLocRaw.trim());
      const job = {
        url: url.trim(),
        company: company.trim(),
        title,
        location,
        rawScore: 3.5,
        fitScore: 70,
        source: 'usajobs',
        isNew: true,
      };
      if (salaryRaw) job.usaSalary = salaryRaw.trim();
      if (gradeRaw) job.usaGrade = gradeRaw.trim();
      jobs.push(job);
      continue;
    }

    // Generic parser for NEW unchecked lines from any source (Adzuna, RemoteOK, Remotive, Arbeitnow, Jooble, etc.)
    // Format: - [ ] URL | Company | Title — Location | Salary (optional)
    const genericMatch = line.match(
      /^\s*-\s*\[ \]\s*(https?:\/\/[^\s|]+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)(?:\s*\|\s*([^|]+?))?$/
    );
    if (genericMatch && !line.includes('arbeitsagentur') && !line.includes('usajobs.gov')) {
      const [, url, company, titleLocRaw, salaryRaw] = genericMatch;
      const { title, location } = parseTitleLocation(titleLocRaw.trim());
      const source = detectSource(url);
      const job = {
        url: url.trim(),
        company: company.trim(),
        title,
        location,
        rawScore: 3.5,
        fitScore: 70,
        source,
        isNew: true,
      };
      if (salaryRaw && salaryRaw.trim() !== 'Not disclosed') {
        job.usaSalary = salaryRaw.trim();
      }
      jobs.push(job);
      continue;
    }
  }

  return jobs;
}

// ============================================================
// Enrichment
// ============================================================

const BAVARIA_CITIES = [
  'münchen', 'munich', 'nürnberg', 'nuremberg', 'augsburg', 'regensburg',
  'würzburg', 'erlangen', 'bamberg', 'passau', 'rosenheim', 'ingolstadt',
  'fürth', 'bayreuth', 'landshut', 'kempten', 'schweinfurt', 'aschaffenburg',
  'pfaffenhofen', 'werneck', 'cham', 'bad staffelstein', 'prien',
];

const HEIDELBERG_AREA = [
  'heidelberg', 'mannheim', 'ludwigshafen', 'mosbach', 'frankenthal',
  'weinheim', 'schwetzingen', 'wiesloch', 'sinsheim', 'neckargemünd',
];

const JUNIOR_PATTERNS = [
  'assistenzarzt', 'assistenzärztin', 'assistenzaerzt',
  'arzt in weiterbildung', 'ärztin in weiterbildung', 'arzt/ärztin in weiterbildung',
  'weiterbildungsassistent', 'arzt wb', 'arzt i.w.',
];

const PSYCHIATRY_KEYWORDS = [
  'psychiatr', 'psychosom', 'psychother', 'neurolog', 'mental',
  'behavioral', 'seelisch', 'forensi',
];

const LAMIN_KEYWORDS = [
  'sales', 'vertrieb', 'account manager', 'account executive',
  'business develop', 'key account', 'inside sales', 'outside sales',
  'telecom', 'telko', 'telekommunikation', 'b2b', 'enterprise',
  'channel manager', 'partner manager', 'revenue', 'commercial',
  'netzwerk', 'network', 'it specialist', 'it spec', 'information technology',
];

// USA location filters per profile
const PAULINA_USA_STATES = ['georgia', 'ga', 'california', 'ca', 'atlanta', 'san francisco',
  'los angeles', 'san diego', 'sacramento', 'oakland', 'san jose', 'savannah',
  'augusta', 'macon', 'athens'];
const LAMIN_USA_STATES = ['georgia', 'ga', 'atlanta', 'remote', 'negotiable',
  'location negotiable', 'multiple locations', 'anywhere'];

function isPsychiatryRelated(title) {
  const lower = (title || '').toLowerCase();
  return PSYCHIATRY_KEYWORDS.some(kw => lower.includes(kw));
}

function isLaminRelevant(title) {
  const lower = (title || '').toLowerCase();
  return LAMIN_KEYWORDS.some(kw => lower.includes(kw));
}

function isUSALocationAllowed(location, profile) {
  const loc = (location || '').toLowerCase();
  // If no location specified, include it (can't filter what we don't know)
  if (!loc || loc === 'n/a') return true;
  const allowed = profile === 'paulina' ? PAULINA_USA_STATES : LAMIN_USA_STATES;
  return allowed.some(s => loc.includes(s));
}

function isJunior(title) {
  const lower = (title || '').toLowerCase();
  return JUNIOR_PATTERNS.some(p => lower.includes(p));
}

// ============================================================
// Lamin Scoring Engine — 7 dimensions, 100 pts total
// ============================================================

/** Parse salary string into annual USD or EUR amount (midpoint). Returns { amount, currency } or null. */
function parseSalaryAmount(salaryStr) {
  if (!salaryStr) return null;
  const s = salaryStr.replace(/,/g, '');

  // Detect currency
  const isEur = /€|eur/i.test(s);
  const currency = isEur ? 'eur' : 'usd';

  // Hourly: "$30.19 - $48.32 per hour" or "$25/hr"
  const hourlyMatch = s.match(/[\$€]?\s*([\d.]+)\s*[-–to]+\s*[\$€]?\s*([\d.]+)\s*(?:per\s*hour|\/\s*h)/i)
    || s.match(/[\$€]?\s*([\d.]+)\s*(?:per\s*hour|\/\s*h)/i);
  if (hourlyMatch) {
    const vals = hourlyMatch.length >= 3
      ? [(parseFloat(hourlyMatch[1]) + parseFloat(hourlyMatch[2])) / 2]
      : [parseFloat(hourlyMatch[1])];
    return { amount: vals[0] * 2080, currency };
  }

  // Range with K: "$80k-$120k" or "€45K-€65K"
  const kRangeMatch = s.match(/[\$€]?\s*([\d.]+)\s*k\s*[-–to]+\s*[\$€]?\s*([\d.]+)\s*k/i);
  if (kRangeMatch) {
    const mid = (parseFloat(kRangeMatch[1]) + parseFloat(kRangeMatch[2])) / 2;
    return { amount: mid * 1000, currency };
  }

  // Single K: "$100k" or "€65K"
  const kSingleMatch = s.match(/[\$€]?\s*([\d.]+)\s*k/i);
  if (kSingleMatch) {
    return { amount: parseFloat(kSingleMatch[1]) * 1000, currency };
  }

  // Range full numbers: "$80000-$120000" or "$80,000 - $120,000"
  const fullRangeMatch = s.match(/[\$€]?\s*([\d]+(?:\.[\d]+)?)\s*[-–to]+\s*[\$€]?\s*([\d]+(?:\.[\d]+)?)/i);
  if (fullRangeMatch) {
    const a = parseFloat(fullRangeMatch[1]);
    const b = parseFloat(fullRangeMatch[2]);
    if (a > 1000 || b > 1000) {
      return { amount: (a + b) / 2, currency };
    }
  }

  // Single full number: "$100000"
  const singleMatch = s.match(/[\$€]?\s*([\d]+(?:\.[\d]+)?)/);
  if (singleMatch) {
    const val = parseFloat(singleMatch[1]);
    if (val > 1000) return { amount: val, currency };
  }

  return null;
}

function scoreLaminTitle(title) {
  const t = (title || '').toLowerCase();

  // Exact match (25 pts)
  const exact = ['sales manager', 'sales director', 'vp sales', 'vp of sales',
    'vice president sales', 'vertriebsleiter', 'vertriebsleitung',
    'head of sales', 'director of sales', 'regional sales manager',
    'director sales', 'sales lead'];
  if (exact.some(k => t.includes(k))) return 25;

  // Strong match (20 pts)
  const strong = ['account executive', 'key account manager', 'business development manager',
    'account manager enterprise', 'enterprise account', 'major account',
    'strategic account', 'national account manager', 'global account manager',
    'vertriebsmanager', 'sales engineering manager'];
  if (strong.some(k => t.includes(k))) return 20;

  // Good match (15 pts)
  const good = ['account manager', 'inside sales manager', 'channel manager',
    'partner manager', 'channel sales', 'partner sales', 'alliance manager',
    'sales engineer', 'sales consultant', 'vertriebsberater',
    'pre-sales', 'presales', 'solution consultant'];
  if (good.some(k => t.includes(k))) return 15;

  // Adjacent (10 pts)
  const adjacent = ['sales rep', 'vertriebsmitarbeiter', 'sales consultant',
    'bdr', 'sdr', 'business development rep', 'sales specialist',
    'vertriebsinnendienst', 'vertriebsaußendienst', 'außendienst',
    'innendienst', 'commercial manager', 'revenue manager'];
  if (adjacent.some(k => t.includes(k))) return 10;

  // Weak (5 pts) — generic sales keyword
  if (/junior|entry.level|trainee|quereinsteiger|werkstudent|praktik/i.test(t)) return 3;
  if (/sales|vertrieb|verkauf/i.test(t)) return 5;

  return 0;
}

function scoreLaminIndustry(title, company) {
  const combined = `${title || ''} ${company || ''}`.toLowerCase();

  // Telecom/UCaaS/SD-WAN/MPLS/managed services (20 pts)
  const telecom = ['telecom', 'telekommunikation', 'telko', 'ucaas', 'ccaas',
    'sd-wan', 'sdwan', 'mpls', 'managed services', 'connectivity',
    'unified communications', 'voip', 'sip', 'fiber', 'broadband',
    'glasfaser', 'breitband', 'netzwerk', 'carrier', 'isp'];
  if (telecom.some(k => combined.includes(k))) return 20;

  // IT/tech/SaaS/cloud/networking (15 pts)
  const tech = ['saas', 'cloud', 'software', 'it ', 'it-', 'tech', 'cyber',
    'network', 'infrastructure', 'hosting', 'datacenter', 'data center',
    'security', 'digital', 'platform'];
  if (tech.some(k => combined.includes(k))) return 15;

  // B2B/enterprise (10 pts)
  const b2b = ['b2b', 'enterprise', 'business-to-business', 'corporate'];
  if (b2b.some(k => combined.includes(k))) return 10;

  // Wrong industry (0 pts)
  const wrong = ['medical', 'pharma', 'food', 'construction', 'bau',
    'restaurant', 'retail', 'einzelhandel', 'pflege', 'klinik',
    'krankenhaus', 'hospital', 'arzt', 'ärztin'];
  if (wrong.some(k => combined.includes(k))) return 0;

  // General sales, no industry signal (5 pts)
  return 5;
}

function scoreLaminSeniority(title) {
  const t = (title || '').toLowerCase();

  // Manager/Director/VP/Head (15 pts)
  if (/\b(manager|director|vp|vice president|head of|leiter|leiterin|lead|teamlead|teamleiter)\b/i.test(t)) return 15;

  // Senior (12 pts)
  if (/\b(senior|sr\.|principal)\b/i.test(t)) return 12;

  // Junior/Entry (3 pts)
  if (/\b(junior|jr\.|entry.level|trainee|quereinsteiger|werkstudent|praktik|ausbildung)\b/i.test(t)) return 3;

  // Mid-level (8 pts)
  return 8;
}

function scoreLaminLocation(location) {
  const loc = (location || '').toLowerCase();
  if (!loc || loc === 'n/a') return 0;

  // Priority: Atlanta GA or priority German cities
  const priorityCities = ['atlanta', 'münchen', 'munich', 'nürnberg', 'nuremberg',
    'heidelberg', 'bamberg', 'bayreuth'];
  if (priorityCities.some(c => loc.includes(c))) return 15;

  // Remote US
  if (/remote|anywhere|location.negotiable|negotiable|home.office|hybrid.*remote/i.test(loc) &&
      !/germany|deutschland|de\b/i.test(loc)) return 12;
  // Remote Germany also good
  if (/remote|home.office/i.test(loc) && /germany|deutschland|de\b/i.test(loc)) return 12;

  // Other major German cities
  const majorDE = ['berlin', 'hamburg', 'frankfurt', 'köln', 'cologne', 'düsseldorf',
    'stuttgart', 'hannover', 'leipzig', 'dresden', 'dortmund', 'essen', 'bremen'];
  if (majorDE.some(c => loc.includes(c))) return 10;

  // Other Germany (incl. Bayern flag)
  if (/bayern|bavaria|deutschland|germany/i.test(loc) ||
      BAVARIA_CITIES.some(c => loc.includes(c)) ||
      HEIDELBERG_AREA.some(c => loc.includes(c))) return 10;

  // Georgia state
  if (/\bga\b|georgia/i.test(loc)) return 12;

  // Other US
  if (/usa|united states|texas|california|new york|chicago|dallas|houston|seattle|denver|boston|charlotte|nashville|phoenix|portland|austin|san\s/i.test(loc)) return 5;

  return 0;
}

/** Known companies for scoring */
const MAJOR_TELECOM = ['t-mobile', 'vodafone', 'deutsche telekom', 'telekom', 'spectrum',
  'charter', 'at&t', 'att', 'comcast', 'verizon', 'lumen', 'lumen technologies',
  'cisco', 'juniper', 'nokia', 'ericsson', 'ringcentral', 'zoom', 'twilio',
  'vonage', 'mitel', 'avaya', 'genesys', 'five9', '8x8', 'bandwidth',
  'windstream', 'frontier', 'cox', 'centurylink', 'zayo', 'cogent',
  'colt', 'telia', 'orange', 'bt ', 'bt group', 'swisscom',
  'telefonica', 'o2', 'freenet', '1&1', 'united internet', 'drillisch',
  'ewe tel', 'm-net', 'netcologne', 'plusnet'];

const KNOWN_TECH = ['google', 'microsoft', 'amazon', 'aws', 'oracle', 'ibm',
  'siemens', 'sap', 'salesforce', 'hubspot', 'dell', 'hp', 'hpe',
  'hewlett packard', 'lenovo', 'vmware', 'broadcom', 'palo alto',
  'fortinet', 'crowdstrike', 'cloudflare', 'datadog', 'splunk',
  'servicenow', 'workday', 'snowflake', 'databricks', 'confluent',
  'hashicorp', 'elastic', 'mongodb', 'redis', 'nutanix', 'rubrik',
  'zscaler', 'okta', 'proofpoint', 'mimecast', 'sophos', 'trend micro',
  'check point', 'f5', 'arista', 'extreme networks', 'ruckus', 'aruba',
  'commscope', 'calix', 'adtran', 'ciena', 'infinera', 'ribbon',
  'accenture', 'capgemini', 'deloitte', 'kpmg', 'pwc', 'ey', 'mckinsey',
  'bain', 'bcg', 'gartner', 'idc', 'forrester'];

const STAFFING_AGENCIES = ['robert half', 'hays', 'randstad', 'adecco', 'manpower',
  'kforce', 'insight global', 'modis', 'michael page', 'page group',
  'brunel', 'gulp', 'etengo', 'solcom', 'ferchau', 'progressive',
  'top itservices', 'amadeus fire'];

function scoreLaminCompany(company) {
  const c = (company || '').toLowerCase();
  if (!c || c === 'confidential' || c === 'unknown' || c === 'n/a') return 1;

  if (MAJOR_TELECOM.some(k => c.includes(k))) return 10;
  if (KNOWN_TECH.some(k => c.includes(k))) return 8;
  if (STAFFING_AGENCIES.some(k => c.includes(k))) return 4;

  // Has a real company name (more than 2 chars, not generic)
  if (c.length > 2) return 3;

  return 1;
}

function scoreLaminSalary(salaryStr) {
  const parsed = parseSalaryAmount(salaryStr);
  if (!parsed) return 5; // No salary data — neutral

  const { amount, currency } = parsed;
  if (currency === 'eur') {
    if (amount >= 65000) return 10;
    if (amount >= 50000) return 7;
    if (amount >= 40000) return 4;
    return 2;
  }
  // USD
  if (amount >= 135000) return 10;
  if (amount >= 100000) return 7;
  if (amount >= 70000) return 4;
  return 2;
}

function scoreLaminBilingual(title, company, location) {
  const combined = `${title || ''} ${company || ''} ${location || ''}`.toLowerCase();

  if (/bilingual|zweisprachig|german.speaking|english.*german|german.*english|dach/i.test(combined)) return 5;
  if (/international/i.test(combined)) return 3;

  // German company posting in English (heuristic: company has German name patterns but title is English)
  const germanCoSigns = ['gmbh', 'ag ', ' ag', 'e.v.', 'deutsche', 'telekom'];
  const titleIsEnglish = /manager|director|executive|engineer|consultant|specialist/i.test(title || '');
  if (germanCoSigns.some(k => (company || '').toLowerCase().includes(k)) && titleIsEnglish) return 3;

  return 0;
}

/** Compute Lamin's fitScore across 7 dimensions (0-100) */
function computeLaminFitScore(job) {
  const titleScore = scoreLaminTitle(job.title);
  const industryScore = scoreLaminIndustry(job.title, job.company);
  const seniorityScore = scoreLaminSeniority(job.title);
  const locationScore = scoreLaminLocation(job.location);
  const companyScore = scoreLaminCompany(job.company);
  const salaryScore = scoreLaminSalary(job.usaSalary || job.salary);
  const bilingualScore = scoreLaminBilingual(job.title, job.company, job.location);

  const total = titleScore + industryScore + seniorityScore + locationScore
    + companyScore + salaryScore + bilingualScore;

  return {
    fitScore: Math.min(100, Math.max(0, total)),
    scoreBreakdown: {
      title: titleScore,
      industry: industryScore,
      seniority: seniorityScore,
      location: locationScore,
      company: companyScore,
      salary: salaryScore,
      bilingual: bilingualScore,
    },
  };
}

function enrichJob(job, profile) {
  const loc = (job.location || '').toLowerCase();
  const flags = [];
  const country = detectCountry(job.source, job.location);
  const isUSA = country === 'us';

  // Approbation flag — only for German medical jobs (Paulina)
  if (!isUSA && profile === 'paulina') {
    job.approbation = true;
    flags.push('APPR');
  } else {
    job.approbation = false;
  }

  // Bayern flag
  if (BAVARIA_CITIES.some(c => loc.includes(c)) || loc.includes('bayern') || loc.includes('bavaria')) {
    flags.push('Bayern');
  }

  // Heidelberg flag
  if (HEIDELBERG_AREA.some(c => loc.includes(c))) {
    flags.push('HD');
  }

  // Bamberg flag
  if (loc.includes('bamberg')) {
    flags.push('Bamberg');
  }

  // Bayreuth flag
  if (loc.includes('bayreuth')) {
    flags.push('Bayreuth');
  }

  // USA flag
  if (isUSA) {
    flags.push('USA');
  }

  // Salary estimation
  if (!isUSA) {
    const salary = estimateSalary(job.title, job.company, job.location);
    if (salary.min && salary.max) {
      job.salary = `€${Math.round(salary.min / 1000)}K–${Math.round(salary.max / 1000)}K (${salary.scale})`;
    } else {
      job.salary = null;
    }
  } else {
    // USA salary: use pipeline data if available, otherwise estimate
    if (job.usaSalary) {
      job.salary = job.usaSalary;
    } else {
      const usSalary = estimateUSSalary(job.title, job.company, job.location);
      if (usSalary.min && usSalary.max) {
        job.salary = `$${Math.round(usSalary.min / 1000)}K–$${Math.round(usSalary.max / 1000)}K base (${usSalary.scale})`;
        job.salaryNotes = usSalary.notes;
      } else {
        job.salary = null;
      }
    }
  }

  // Bundesland info (only for German jobs)
  if (!isUSA) {
    const blInfo = getBundeslandInfo(job.location, job.company);
    job.bundesland = blInfo.bundesland || null;
    job.approbationDifficulty = blInfo.difficulty || null;
  } else {
    job.bundesland = null;
    job.approbationDifficulty = null;
  }

  // Profile-specific fitScore computation
  if (profile === 'lamin') {
    const { fitScore, scoreBreakdown } = computeLaminFitScore(job);
    job.fitScore = fitScore;
    job.scoreBreakdown = scoreBreakdown;
  } else {
    // Paulina: keep existing simple scoring (base + priority city bonus)
    // fitScore was set during parsing; add location bonuses
    if (flags.includes('Bayern')) job.fitScore = Math.min(100, job.fitScore + 5);
    if (flags.includes('HD')) job.fitScore = Math.min(100, job.fitScore + 5);
    if (flags.includes('Bamberg')) job.fitScore = Math.min(100, job.fitScore + 5);
    if (flags.includes('Bayreuth')) job.fitScore = Math.min(100, job.fitScore + 5);
  }

  job.flags = flags;
  return job;
}

// ============================================================
// CLI Arg Parser
// ============================================================

function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    const m = arg.match(/^--(\w[\w-]*)(?:=(.*))?$/);
    if (m) {
      args[m[1]] = m[2] !== undefined ? m[2] : true;
    }
  }
  return args;
}

// ============================================================
// Main
// ============================================================

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = !!args['dry-run'];
  const send = !!args['send'];
  const profile = args.profile || 'paulina';

  if (!dryRun && !send) {
    console.log('Usage: node build-digest-data.mjs --profile=<paulina|lamin> [--dry-run | --send]');
    process.exit(1);
  }

  console.log(`\n=== Building digest for profile: ${profile} ===\n`);

  // Load ONLY this profile's pipeline — never mix pipelines across profiles
  const profilePipelinePath = resolve(__dirname, 'profiles', profile, 'data', 'pipeline.md');
  let pipelineText = '';
  try { pipelineText = await readFile(profilePipelinePath, 'utf8'); } catch {
    console.error(`No pipeline found at ${profilePipelinePath}`);
    process.exit(1);
  }

  // Parse all jobs (both German + USA)
  let jobs = parsePipelineJobs(pipelineText);
  console.log(`Parsed ${jobs.length} total jobs from pipeline`);

  // Filter out junior positions (for all profiles)
  const beforeFilter = jobs.length;
  jobs = jobs.filter(j => !isJunior(j.title));
  console.log(`Filtered out ${beforeFilter - jobs.length} junior positions, ${jobs.length} remaining`);

  // Profile-specific specialty filters
  if (profile === 'paulina') {
    const beforeSpecialty = jobs.length;
    jobs = jobs.filter(j => isPsychiatryRelated(j.title));
    console.log(`Filtered to psychiatry-related: ${beforeSpecialty - jobs.length} non-psych removed, ${jobs.length} remaining`);
  } else if (profile === 'lamin') {
    const beforeSpecialty = jobs.length;
    jobs = jobs.filter(j => isLaminRelevant(j.title));
    console.log(`Filtered to sales/telecom/IT: ${beforeSpecialty - jobs.length} non-relevant removed, ${jobs.length} remaining`);
  }

  // USA jobs filter
  if (profile === 'lamin') {
    // Lamin is NOT a US citizen — federal jobs (usajobs.gov) require citizenship
    const beforeFedFilter = jobs.length;
    jobs = jobs.filter(j => j.source !== 'usajobs');
    if (beforeFedFilter - jobs.length > 0) {
      console.log(`Federal jobs filter: ${beforeFedFilter - jobs.length} USAJobs removed (requires US citizenship), ${jobs.length} remaining`);
    }
    // Location filter for USA private-sector jobs (Atlanta GA + remote only)
    const beforeUSALocFilter = jobs.length;
    jobs = jobs.filter(j => {
      const country = detectCountry(j.source, j.location);
      if (country !== 'us') return true;
      return isUSALocationAllowed(j.location, profile);
    });
    if (beforeUSALocFilter - jobs.length > 0) {
      console.log(`USA location filter: ${beforeUSALocFilter - jobs.length} out-of-area USA jobs removed, ${jobs.length} remaining`);
    }
  } else {
    // Paulina: GA+CA only for USA jobs (all sources)
    const beforeUSAFilter = jobs.length;
    jobs = jobs.filter(j => {
      const country = detectCountry(j.source, j.location);
      if (country !== 'us') return true;
      return isUSALocationAllowed(j.location, profile);
    });
    if (beforeUSAFilter - jobs.length > 0) {
      console.log(`USA location filter: ${beforeUSAFilter - jobs.length} out-of-area USA jobs removed, ${jobs.length} remaining`);
    }
  }

  // Filter out Swiss positions (German jobs only)
  jobs = jobs.filter(j => {
    const country = detectCountry(j.source, j.location);
    if (country === 'us') return true; // Don't filter USA jobs
    const loc = (j.location || '').toLowerCase();
    return !loc.includes('(ch)') && !loc.includes('schweiz') && !loc.includes('switzerland') && !loc.includes('luzern') && !loc.includes('bollingen') && !loc.includes('zürich') && !loc.includes('bern');
  });
  console.log(`After Swiss filter: ${jobs.length} jobs`);

  // Deduplicate by URL and by company+title+location
  const seenUrls = new Set();
  const seenKeys = new Set();
  jobs = jobs.filter(j => {
    if (seenUrls.has(j.url)) return false;
    seenUrls.add(j.url);
    const key = `${j.company}|${j.title}|${j.location}`.toLowerCase();
    if (seenKeys.has(key)) return false;
    seenKeys.add(key);
    return true;
  });
  console.log(`After dedup: ${jobs.length} unique jobs`);

  // Enrich all jobs (pass profile for scoring engine selection)
  jobs = jobs.map(j => enrichJob(j, profile));

  // Sort all jobs by fitScore descending
  jobs.sort((a, b) => (b.fitScore || 0) - (a.fitScore || 0));

  // Split into regional buckets (same ranking for both profiles):
  // Bayern > Heidelberg > Bamberg > Bayreuth > Other Germany > USA
  const regions = {
    'bayern':    { label: '⭐ Bayern', jobs: [], test: j => j.flags.includes('Bayern') && !j.flags.includes('Bamberg') && !j.flags.includes('Bayreuth') },
    'heidelberg':{ label: '💜 Heidelberg / Rhein-Neckar', jobs: [], test: j => j.flags.includes('HD') && !j.flags.includes('Bayern') },
    'bamberg':   { label: '🏰 Bamberg', jobs: [], test: j => j.flags.includes('Bamberg') },
    'bayreuth':  { label: '🎭 Bayreuth', jobs: [], test: j => j.flags.includes('Bayreuth') && !j.flags.includes('Bamberg') },
    'other-de':  { label: '🌐 Other Germany', jobs: [], test: j => !j.flags.includes('USA') },
    'usa':       { label: '🇺🇸 USA', jobs: [], test: j => j.flags.includes('USA') },
  };

  for (const job of jobs) {
    // Try regions in priority order; first match wins
    if (regions.bamberg.test(job)) {
      regions.bamberg.jobs.push(job);
    } else if (regions.bayreuth.test(job)) {
      regions.bayreuth.jobs.push(job);
    } else if (regions.bayern.test(job)) {
      regions.bayern.jobs.push(job);
    } else if (regions.heidelberg.test(job)) {
      regions.heidelberg.jobs.push(job);
    } else if (regions.usa.test(job)) {
      regions.usa.jobs.push(job);
    } else {
      regions['other-de'].jobs.push(job);
    }
  }

  // Print summary
  const jobTypeLabel = profile === 'paulina' ? 'psychiatry' : 'all';
  console.log(`\n=== Regional Digest Summary (${profile}) ===`);
  console.log(`Total: ${jobs.length} ${jobTypeLabel} jobs (no cap)`);
  for (const [key, region] of Object.entries(regions)) {
    if (region.jobs.length > 0) {
      console.log(`  ${region.label}: ${region.jobs.length}`);
    }
  }

  // Write full JSON
  const dataDir = resolve(__dirname, 'data');
  if (!existsSync(dataDir)) await mkdir(dataDir, { recursive: true });
  await writeFile(resolve(dataDir, `digest-jobs-${profile}.json`), JSON.stringify(jobs, null, 2), 'utf8');

  // Send one digest per region (skip empty regions)
  for (const [key, region] of Object.entries(regions)) {
    if (region.jobs.length === 0) {
      console.log(`\nSkipping ${region.label} — no jobs`);
      continue;
    }

    console.log(`\n--- Sending: ${region.label} (${region.jobs.length} jobs) ---`);
    const top5 = region.jobs.slice(0, 5);
    for (const j of top5) {
      console.log(`  ${j.fitScore} | ${j.company} | ${j.title} | ${j.location || 'N/A'}`);
    }
    if (region.jobs.length > 5) console.log(`  ... and ${region.jobs.length - 5} more`);

    // Subject line varies by profile and region
    const subjectLabel = key === 'usa'
      ? `${region.label} — ${region.jobs.length} Jobs`
      : profile === 'paulina'
        ? `${region.label} — ${region.jobs.length} Psychiatrie-Stellen`
        : `${region.label} — ${region.jobs.length} Stellen`;

    const result = await sendDigest(profile, region.jobs, {
      dryRun,
      subjectOverride: `📋 ${subjectLabel}`,
    });

    if (result.previewPath) {
      console.log(`  Preview: file:///${result.previewPath.replace(/\\/g, '/')}`);
    }
    if (result.sent) {
      console.log(`  Sent to ${result.recipient}`);
    }
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
