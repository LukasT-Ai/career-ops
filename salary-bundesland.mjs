#!/usr/bin/env node

/**
 * salary-bundesland.mjs — German Physician Salary Estimation & Bundesland Info
 *
 * Provides TV-Aerzte pay scale estimation and Approbation pathway data
 * for German medical job postings.
 *
 * Usage:
 *   import { estimateSalary, getBundeslandInfo } from './salary-bundesland.mjs';
 *   const salary = estimateSalary('Oberarzt Psychiatrie', 'Charite', 'Berlin');
 *   const info = getBundeslandInfo('Berlin', 'Charite');
 *
 * CLI:
 *   node salary-bundesland.mjs
 */

// ============================================================
// TV-Aerzte Pay Scales (VKA 2024-2025, annual gross EUR)
// ============================================================

const PAY_SCALES = {
  'Ä1': { label: 'Assistenzarzt (Ä1)', min: 63000, max: 82000, stufen: '1-5 (5 years)' },
  'Ä2': { label: 'Facharzt (Ä2)',      min: 84000, max: 97000, stufen: '1-3' },
  'Ä3': { label: 'Oberarzt (Ä3)',      min: 97000, max: 112000, stufen: '1-3' },
  'Ä4': { label: 'Leitender Oberarzt (Ä4)', min: 112000, max: 120000, stufen: '1-2' },
  'AT': { label: 'Chefarzt (AT/außertariflich)', min: 130000, max: 250000, stufen: 'negotiated' },
};

// Sales / Telecom / B2B Pay Scales (Germany, annual gross EUR)
const SALES_PAY_SCALES = {
  'junior_sales':  { label: 'Junior Sales/Account Manager', min: 36000, max: 48000 },
  'sales':         { label: 'Account Manager / Sales Rep', min: 45000, max: 65000 },
  'senior_sales':  { label: 'Senior Account Manager / Key Account', min: 55000, max: 80000 },
  'sales_manager': { label: 'Sales Manager / Team Lead', min: 65000, max: 95000 },
  'head_sales':    { label: 'Head of Sales / VP Sales', min: 85000, max: 130000 },
  'inside_sales':  { label: 'Inside Sales', min: 35000, max: 55000 },
  'it_sales':      { label: 'IT/Telecom Sales (Enterprise)', min: 50000, max: 80000 },
  'vertrieb':      { label: 'Vertriebsmitarbeiter', min: 38000, max: 55000 },
};

// ============================================================
// Title-to-Level Detection
// ============================================================

/**
 * Detect TV-Aerzte level from job title.
 * Returns { level, scale } or a range for ambiguous titles.
 */
function detectLevel(title) {
  const t = title.toLowerCase();

  if (/chefarzt|chefärztin|ärztliche[rnms]?\s+direktor/i.test(title)) {
    return { level: 'AT', scale: 'TV-Ärzte/VKA AT' };
  }
  if (/leitende[rnms]?\s+oberarzt|leitende[rnms]?\s+oberärztin|ltd\.?\s+oberarzt|ltd\.?\s+oberärztin/i.test(title)) {
    return { level: 'Ä4', scale: 'TV-Ärzte/VKA Ä4' };
  }
  if (/oberarzt|oberärztin/i.test(title)) {
    return { level: 'Ä3', scale: 'TV-Ärzte/VKA Ä3' };
  }
  if (/facharzt|fachärztin/i.test(title)) {
    return { level: 'Ä2', scale: 'TV-Ärzte/VKA Ä2' };
  }
  if (/assistenzarzt|assistenzärztin/i.test(title)) {
    return { level: 'Ä1', scale: 'TV-Ärzte/VKA Ä1' };
  }
  // Generic "Psychiater" or "Arzt" without specificity → Ä2-Ä3 range
  if (/psychiater|psychiaterin|arzt|ärztin/i.test(title)) {
    return { level: 'Ä2-Ä3', scale: 'TV-Ärzte/VKA Ä2-Ä3' };
  }
  return { level: null, scale: null };
}

/**
 * Detect sales/telecom level from job title.
 */
function detectSalesLevel(title) {
  const t = title.toLowerCase();

  if (/head of sales|vp sales|vertriebsleiter|vertriebsdirektor|director.*(sales|vertrieb)/i.test(title)) {
    return { level: 'head_sales', scale: 'Sales/Executive' };
  }
  if (/sales manager|vertriebsmanager|team\s*lead.*(?:sales|vertrieb)|sales\s*lead/i.test(title)) {
    return { level: 'sales_manager', scale: 'Sales/Management' };
  }
  if (/key account|senior account|enterprise.*(account|sales)|strategic account|major account/i.test(title)) {
    return { level: 'senior_sales', scale: 'Sales/Senior' };
  }
  if (/inside sales/i.test(title)) {
    return { level: 'inside_sales', scale: 'Sales/Inside' };
  }
  if (/junior.*(account|sales|vertrieb)|trainee.*(sales|vertrieb)/i.test(title)) {
    return { level: 'junior_sales', scale: 'Sales/Junior' };
  }
  if (/(?:it|telecom|telko|telekommunikation|netzwerk|network).*(sales|account|vertrieb)|(?:sales|account|vertrieb).*(it|telecom|telko|telekommunikation)/i.test(title)) {
    return { level: 'it_sales', scale: 'IT/Telecom Sales' };
  }
  if (/account\s*(manager|executive)|business\s*develop/i.test(title)) {
    return { level: 'sales', scale: 'Sales/B2B' };
  }
  if (/vertriebsmitarbeiter|sales\s*rep|vertriebsbeauftragter/i.test(title)) {
    return { level: 'vertrieb', scale: 'Vertrieb' };
  }
  if (/sales|vertrieb|account|channel|partner\s*manager/i.test(title)) {
    return { level: 'sales', scale: 'Sales/General' };
  }
  return { level: null, scale: null };
}

// ============================================================
// Employer Adjustments
// ============================================================

const UNIVERSITY_HOSPITALS = [
  'charité', 'charite', 'uniklinik', 'universitätsklinik', 'universitatsklinik',
  'universitätsmedizin', 'universitatsmedizin', 'uni klinik', 'ukb', 'ukd', 'uke',
  'ukl', 'ukm', 'uks', 'ukt', 'ukw', 'ukg', 'ukj', 'ukgm', 'uksh', 'ukr',
  'mhh', 'lmu klinikum', 'rechts der isar', 'virchow', 'benjamin franklin',
  'universitätsklinikum', 'universitatsklinikum', 'campus', 'heidelberg',
];

const PRIVATE_CHAINS = [
  'helios', 'asklepios', 'sana', 'rhön', 'rhon', 'ameos', 'schön klinik',
  'schon klinik', 'median', 'vitos', 'vivantes', 'paracelsus',
];

const STAFFING_AGENCIES = [
  'doctari', 'facharztagentur', 'pluss', 'time4', 'medwing', 'hire a doctor',
  'docwise', 'gessmann', 'triamed', 'persona service', 'i.k. hofmann',
  'pacura', 'manpower', 'randstad', 'adecco', 'hays',
];

const HIGH_COL_BUNDESLAENDER = ['bayern', 'baden-württemberg', 'baden-wurttemberg'];

function getEmployerType(company) {
  if (!company) return 'unknown';
  const c = company.toLowerCase();
  if (UNIVERSITY_HOSPITALS.some(u => c.includes(u))) return 'university';
  if (PRIVATE_CHAINS.some(p => c.includes(p))) return 'private_chain';
  if (STAFFING_AGENCIES.some(s => c.includes(s))) return 'staffing';
  return 'standard';
}

// ============================================================
// estimateSalary
// ============================================================

export function estimateSalary(title, company, location) {
  const { level, scale } = detectLevel(title || '');

  // Try sales/telecom detection if physician detection failed
  if (!level) {
    const salesResult = detectSalesLevel(title || '');
    if (salesResult.level) {
      const salesScale = SALES_PAY_SCALES[salesResult.level];
      let min = salesScale.min;
      let max = salesScale.max;
      const notes = [`${salesScale.label}: base salary (OTE with commission typically +20-40%)`];

      // Regional adjustment for sales
      if (location) {
        const bl = resolveBundesland(location);
        if (bl && HIGH_COL_BUNDESLAENDER.includes(bl.toLowerCase())) {
          min = Math.round(min * 1.05);
          max = Math.round(max * 1.10);
          notes.push(`${bl}: +5-10% cost-of-living adjustment`);
        }
      }

      // Staffing agency premium for sales too
      const empType = getEmployerType(company);
      if (empType === 'staffing') {
        min = Math.round(min * 1.05);
        max = Math.round(max * 1.15);
        notes.push('Staffing agency: +5-15% premium (often temporary)');
      }

      return { min, max, currency: 'EUR', scale: salesResult.scale, notes: notes.join('. ') };
    }

    return {
      min: null, max: null, currency: 'EUR', scale: null,
      notes: 'Could not determine salary level from title.',
    };
  }

  // Handle Ä2-Ä3 range (generic psychiater/arzt)
  let baseMin, baseMax, displayScale;
  if (level === 'Ä2-Ä3') {
    baseMin = PAY_SCALES['Ä2'].min;
    baseMax = PAY_SCALES['Ä3'].max;
    displayScale = scale;
  } else {
    baseMin = PAY_SCALES[level].min;
    baseMax = PAY_SCALES[level].max;
    displayScale = scale;
  }

  let min = baseMin;
  let max = baseMax;
  const notes = [];

  // Employer type adjustments
  const empType = getEmployerType(company);
  if (empType === 'university') {
    min = Math.round(min * 1.03);
    max = Math.round(max * 1.05);
    notes.push('University hospital (TV-Ärzte/TdL): +3-5% over VKA');
    displayScale = displayScale.replace('VKA', 'TdL');
  } else if (empType === 'private_chain') {
    min = Math.round(min * 1.00);
    max = Math.round(max * 1.03);
    notes.push(`Private chain (${company}): typically matches or slightly exceeds tariff`);
  } else if (empType === 'staffing') {
    min = Math.round(min * 1.10);
    max = Math.round(max * 1.20);
    notes.push('Staffing agency: +10-20% premium (less job security, often temporary contracts)');
  }

  // Regional adjustment
  if (location) {
    const bl = resolveBundesland(location);
    if (bl && HIGH_COL_BUNDESLAENDER.includes(bl.toLowerCase())) {
      min = Math.round(min * 1.02);
      max = Math.round(max * 1.05);
      notes.push(`${bl}: high cost of living, possible +5% local supplements`);
    }
    const eastern = ['sachsen', 'thüringen', 'thuringen', 'brandenburg', 'mecklenburg-vorpommern',
                     'sachsen-anhalt'];
    if (bl && eastern.includes(bl.toLowerCase())) {
      notes.push(`${bl}: lower cost of living, signing bonuses common due to physician shortage`);
    }
  }

  return { min, max, currency: 'EUR', scale: displayScale, notes: notes.join('. ') || 'Standard VKA tariff, no adjustments.' };
}

// ============================================================
// City-to-Bundesland Mapping
// ============================================================

const CITY_TO_BUNDESLAND = {
  // Baden-Württemberg
  'stuttgart': 'Baden-Württemberg',
  'karlsruhe': 'Baden-Württemberg',
  'mannheim': 'Baden-Württemberg',
  'heidelberg': 'Baden-Württemberg',
  'freiburg': 'Baden-Württemberg',
  'freiburg im breisgau': 'Baden-Württemberg',
  'ulm': 'Baden-Württemberg',
  'heilbronn': 'Baden-Württemberg',
  'pforzheim': 'Baden-Württemberg',
  'reutlingen': 'Baden-Württemberg',
  'tübingen': 'Baden-Württemberg',
  'tubingen': 'Baden-Württemberg',
  'konstanz': 'Baden-Württemberg',
  'esslingen': 'Baden-Württemberg',
  'ludwigsburg': 'Baden-Württemberg',
  'offenburg': 'Baden-Württemberg',
  'villingen-schwenningen': 'Baden-Württemberg',
  'sindelfingen': 'Baden-Württemberg',
  'böblingen': 'Baden-Württemberg',
  'boblingen': 'Baden-Württemberg',
  'ravensburg': 'Baden-Württemberg',
  'lörrach': 'Baden-Württemberg',
  'lorrach': 'Baden-Württemberg',
  'mosbach': 'Baden-Württemberg',
  'freudenstadt': 'Baden-Württemberg',
  'frankenthal': 'Rheinland-Pfalz',
  'bad krozingen': 'Baden-Württemberg',

  // Bayern
  'münchen': 'Bayern',
  'munchen': 'Bayern',
  'munich': 'Bayern',
  'nürnberg': 'Bayern',
  'nurnberg': 'Bayern',
  'nuremberg': 'Bayern',
  'augsburg': 'Bayern',
  'regensburg': 'Bayern',
  'würzburg': 'Bayern',
  'wurzburg': 'Bayern',
  'ingolstadt': 'Bayern',
  'fürth': 'Bayern',
  'furth': 'Bayern',
  'erlangen': 'Bayern',
  'bayreuth': 'Bayern',
  'bamberg': 'Bayern',
  'passau': 'Bayern',
  'landshut': 'Bayern',
  'rosenheim': 'Bayern',
  'aschaffenburg': 'Bayern',
  'kempten': 'Bayern',
  'schweinfurt': 'Bayern',
  'pfaffenhofen': 'Bayern',
  'werneck': 'Bayern',
  'cham': 'Bayern',
  'bad staffelstein': 'Bayern',
  'prien': 'Bayern',
  'bernried': 'Bayern',

  // Berlin
  'berlin': 'Berlin',

  // Brandenburg
  'potsdam': 'Brandenburg',
  'cottbus': 'Brandenburg',
  'brandenburg an der havel': 'Brandenburg',
  'frankfurt (oder)': 'Brandenburg',
  'frankfurt oder': 'Brandenburg',
  'oranienburg': 'Brandenburg',
  'falkensee': 'Brandenburg',
  'bernau': 'Brandenburg',
  'eberswalde': 'Brandenburg',
  'beelitz': 'Brandenburg',
  'bad freienwalde': 'Brandenburg',
  'fürstenwalde': 'Brandenburg',
  'furstenwalde': 'Brandenburg',
  'luckenwalde': 'Brandenburg',
  'templin': 'Brandenburg',
  'neuruppin': 'Brandenburg',
  'senftenberg': 'Brandenburg',
  'rüdersdorf': 'Brandenburg',
  'rudersdorf': 'Brandenburg',

  // Bremen
  'bremen': 'Bremen',
  'bremerhaven': 'Bremen',

  // Hamburg
  'hamburg': 'Hamburg',

  // Hessen
  'frankfurt': 'Hessen',
  'frankfurt am main': 'Hessen',
  'wiesbaden': 'Hessen',
  'kassel': 'Hessen',
  'darmstadt': 'Hessen',
  'offenbach': 'Hessen',
  'gießen': 'Hessen',
  'giessen': 'Hessen',
  'marburg': 'Hessen',
  'fulda': 'Hessen',
  'bad homburg': 'Hessen',
  'hanau': 'Hessen',
  'rüsselsheim': 'Hessen',
  'russelsheim': 'Hessen',
  'bad nauheim': 'Hessen',

  // Mecklenburg-Vorpommern
  'rostock': 'Mecklenburg-Vorpommern',
  'schwerin': 'Mecklenburg-Vorpommern',
  'neubrandenburg': 'Mecklenburg-Vorpommern',
  'stralsund': 'Mecklenburg-Vorpommern',
  'greifswald': 'Mecklenburg-Vorpommern',
  'wismar': 'Mecklenburg-Vorpommern',
  'güstrow': 'Mecklenburg-Vorpommern',
  'gustrow': 'Mecklenburg-Vorpommern',

  // Niedersachsen
  'hannover': 'Niedersachsen',
  'hanover': 'Niedersachsen',
  'braunschweig': 'Niedersachsen',
  'oldenburg': 'Niedersachsen',
  'osnabrück': 'Niedersachsen',
  'osnabruck': 'Niedersachsen',
  'wolfsburg': 'Niedersachsen',
  'göttingen': 'Niedersachsen',
  'gottingen': 'Niedersachsen',
  'hildesheim': 'Niedersachsen',
  'salzgitter': 'Niedersachsen',
  'wilhelmshaven': 'Niedersachsen',
  'lüneburg': 'Niedersachsen',
  'luneburg': 'Niedersachsen',
  'celle': 'Niedersachsen',
  'emden': 'Niedersachsen',
  'soltau': 'Niedersachsen',
  'bad zwischenahn': 'Niedersachsen',
  'hameln': 'Niedersachsen',
  'wallenhorst': 'Niedersachsen',

  // Nordrhein-Westfalen
  'köln': 'Nordrhein-Westfalen',
  'koln': 'Nordrhein-Westfalen',
  'cologne': 'Nordrhein-Westfalen',
  'düsseldorf': 'Nordrhein-Westfalen',
  'dusseldorf': 'Nordrhein-Westfalen',
  'dortmund': 'Nordrhein-Westfalen',
  'essen': 'Nordrhein-Westfalen',
  'duisburg': 'Nordrhein-Westfalen',
  'bochum': 'Nordrhein-Westfalen',
  'wuppertal': 'Nordrhein-Westfalen',
  'bielefeld': 'Nordrhein-Westfalen',
  'bonn': 'Nordrhein-Westfalen',
  'münster': 'Nordrhein-Westfalen',
  'munster': 'Nordrhein-Westfalen',
  'mönchengladbach': 'Nordrhein-Westfalen',
  'monchengladbach': 'Nordrhein-Westfalen',
  'gelsenkirchen': 'Nordrhein-Westfalen',
  'aachen': 'Nordrhein-Westfalen',
  'krefeld': 'Nordrhein-Westfalen',
  'oberhausen': 'Nordrhein-Westfalen',
  'hagen': 'Nordrhein-Westfalen',
  'hamm': 'Nordrhein-Westfalen',
  'mülheim': 'Nordrhein-Westfalen',
  'mulheim': 'Nordrhein-Westfalen',
  'solingen': 'Nordrhein-Westfalen',
  'leverkusen': 'Nordrhein-Westfalen',
  'paderborn': 'Nordrhein-Westfalen',
  'siegen': 'Nordrhein-Westfalen',
  'gummersbach': 'Nordrhein-Westfalen',
  'olpe': 'Nordrhein-Westfalen',
  'plettenberg': 'Nordrhein-Westfalen',
  'lüdenscheid': 'Nordrhein-Westfalen',
  'ludenscheid': 'Nordrhein-Westfalen',
  'herford': 'Nordrhein-Westfalen',
  'steinfurt': 'Nordrhein-Westfalen',
  'arnsberg': 'Nordrhein-Westfalen',
  'bedburg-hau': 'Nordrhein-Westfalen',

  // Rheinland-Pfalz
  'mainz': 'Rheinland-Pfalz',
  'ludwigshafen': 'Rheinland-Pfalz',
  'koblenz': 'Rheinland-Pfalz',
  'trier': 'Rheinland-Pfalz',
  'kaiserslautern': 'Rheinland-Pfalz',
  'worms': 'Rheinland-Pfalz',
  'speyer': 'Rheinland-Pfalz',
  'neuwied': 'Rheinland-Pfalz',

  // Saarland
  'saarbrücken': 'Saarland',
  'saarbrucken': 'Saarland',
  'saarlouis': 'Saarland',
  'homburg': 'Saarland',
  'püttlingen': 'Saarland',
  'puttlingen': 'Saarland',

  // Sachsen
  'dresden': 'Sachsen',
  'leipzig': 'Sachsen',
  'chemnitz': 'Sachsen',
  'zwickau': 'Sachsen',
  'plauen': 'Sachsen',
  'görlitz': 'Sachsen',
  'gorlitz': 'Sachsen',
  'bautzen': 'Sachsen',
  'freiberg': 'Sachsen',
  'auerbach/vogtland': 'Sachsen',
  'auerbach': 'Sachsen',

  // Sachsen-Anhalt
  'magdeburg': 'Sachsen-Anhalt',
  'halle': 'Sachsen-Anhalt',
  'halle (saale)': 'Sachsen-Anhalt',
  'dessau': 'Sachsen-Anhalt',
  'wittenberg': 'Sachsen-Anhalt',
  'stendal': 'Sachsen-Anhalt',
  'zeitz': 'Sachsen-Anhalt',
  'staßfurt': 'Sachsen-Anhalt',
  'stassfurt': 'Sachsen-Anhalt',

  // Schleswig-Holstein
  'kiel': 'Schleswig-Holstein',
  'lübeck': 'Schleswig-Holstein',
  'lubeck': 'Schleswig-Holstein',
  'flensburg': 'Schleswig-Holstein',
  'neumünster': 'Schleswig-Holstein',
  'neumunster': 'Schleswig-Holstein',
  'norderstedt': 'Schleswig-Holstein',
  'itzehoe': 'Schleswig-Holstein',
  'jever': 'Niedersachsen',

  // Thüringen
  'erfurt': 'Thüringen',
  'jena': 'Thüringen',
  'gera': 'Thüringen',
  'weimar': 'Thüringen',
  'gotha': 'Thüringen',
  'eisenach': 'Thüringen',
  'suhl': 'Thüringen',
  'nordhausen': 'Thüringen',
  'idstein': 'Hessen',
  'fulda': 'Hessen',
  'schlangenbad': 'Hessen',
};

// Also accept Bundesland names directly
const BUNDESLAND_NAMES = [
  'Baden-Württemberg', 'Bayern', 'Berlin', 'Brandenburg', 'Bremen', 'Hamburg',
  'Hessen', 'Mecklenburg-Vorpommern', 'Niedersachsen', 'Nordrhein-Westfalen',
  'Rheinland-Pfalz', 'Saarland', 'Sachsen', 'Sachsen-Anhalt',
  'Schleswig-Holstein', 'Thüringen',
];

/**
 * Resolve a location string to a Bundesland name.
 * Handles city names, Bundesland names, and compound location strings.
 */
function resolveBundesland(location) {
  if (!location) return null;
  const loc = location.trim().toLowerCase();

  // Direct city match
  if (CITY_TO_BUNDESLAND[loc]) return CITY_TO_BUNDESLAND[loc];

  // Check if the location string IS a Bundesland name
  for (const bl of BUNDESLAND_NAMES) {
    if (loc === bl.toLowerCase()) return bl;
  }

  // Check if any known city appears in the string (e.g. "10117 Berlin" or "Klinikum Stuttgart gKAöR")
  for (const [city, bl] of Object.entries(CITY_TO_BUNDESLAND)) {
    if (city.length >= 4 && loc.includes(city)) return bl;
  }

  // Check if any Bundesland name appears in the string
  for (const bl of BUNDESLAND_NAMES) {
    if (loc.includes(bl.toLowerCase())) return bl;
  }

  return null;
}

// ============================================================
// Bundesland Data
// ============================================================

const BUNDESLAND_INFO = {
  'Baden-Württemberg': {
    capital: 'Stuttgart',
    difficulty: 'moderate-strict',
    aerztekammer: 'Landesärztekammer Baden-Württemberg',
    aerztekammerUrl: 'https://www.aerztekammer-bw.de',
    processingTime: '4-8 months',
    notes: 'Second-largest state economy. Strong university hospitals (Heidelberg, Freiburg, Tübingen, Ulm). Thorough document review process. Kenntnisprüfung sometimes required for non-EU degrees. Good psychiatry demand in rural areas.',
  },
  'Bayern': {
    capital: 'München',
    difficulty: 'strict',
    aerztekammer: 'Bayerische Landesärztekammer',
    aerztekammerUrl: 'https://www.blaek.de',
    processingTime: '6-12 months',
    notes: 'Longest processing times in Germany. Kenntnisprüfung often required. Separate Fachsprachprüfung (FSP) administered by Ärztekammer. Highest cost of living (especially Munich). Excellent university hospitals (LMU, TU München, Erlangen, Würzburg, Regensburg). Top salaries but strict bureaucracy.',
  },
  'Berlin': {
    capital: 'Berlin',
    difficulty: 'accessible',
    aerztekammer: 'Ärztekammer Berlin',
    aerztekammerUrl: 'https://www.aerztekammer-berlin.de',
    processingTime: '3-6 months',
    notes: 'Most international-friendly Bundesland. Charité (one of Europe\'s largest university hospitals) has established pipeline for international doctors. Large international community. Relatively affordable for a capital. High psychiatry demand. English widely spoken in clinical settings.',
  },
  'Brandenburg': {
    capital: 'Potsdam',
    difficulty: 'accessible',
    aerztekammer: 'Landesärztekammer Brandenburg',
    aerztekammerUrl: 'https://www.laekb.de',
    processingTime: '3-5 months',
    notes: 'Surrounds Berlin — many commute to Berlin hospitals. Severe doctor shortage in rural areas, very open to international physicians. Fast processing. Berufserlaubnis relatively easy to obtain. Lower cost of living than Berlin.',
  },
  'Bremen': {
    capital: 'Bremen',
    difficulty: 'moderate',
    aerztekammer: 'Ärztekammer Bremen',
    aerztekammerUrl: 'https://www.aekhb.de',
    processingTime: '3-6 months',
    notes: 'Smallest Bundesland. Limited hospital positions but less competition. Moderate processing times. Good work-life balance reputation.',
  },
  'Hamburg': {
    capital: 'Hamburg',
    difficulty: 'moderate',
    aerztekammer: 'Ärztekammer Hamburg',
    aerztekammerUrl: 'https://www.aerztekammer-hamburg.org',
    processingTime: '4-7 months',
    notes: 'Major port city with excellent quality of life. UKE (Universitätsklinikum Hamburg-Eppendorf) is a top employer. High cost of living but slightly less than Munich. Good international community.',
  },
  'Hessen': {
    capital: 'Wiesbaden',
    difficulty: 'moderate',
    aerztekammer: 'Landesärztekammer Hessen',
    aerztekammerUrl: 'https://www.laekh.de',
    processingTime: '4-6 months',
    notes: 'Frankfurt area has many international doctors — established recognition pathways. Good university hospitals (Frankfurt, Gießen/Marburg). Moderate processing. Higher salaries in Rhine-Main metro area.',
  },
  'Mecklenburg-Vorpommern': {
    capital: 'Schwerin',
    difficulty: 'accessible',
    aerztekammer: 'Ärztekammer Mecklenburg-Vorpommern',
    aerztekammerUrl: 'https://www.aek-mv.de',
    processingTime: '2-4 months',
    notes: 'Severe physician shortage — one of the most accessible states for international doctors. Very fast processing. Rural and coastal settings. University of Greifswald and Rostock have medical faculties. Low cost of living. Signing bonuses and relocation support common.',
  },
  'Niedersachsen': {
    capital: 'Hannover',
    difficulty: 'moderate-accessible',
    aerztekammer: 'Ärztekammer Niedersachsen',
    aerztekammerUrl: 'https://www.aekn.de',
    processingTime: '3-6 months',
    notes: 'Large state with mix of urban and rural. MHH (Medizinische Hochschule Hannover) and University of Göttingen are strong employers. Generally welcoming to international doctors. Reasonable processing times.',
  },
  'Nordrhein-Westfalen': {
    capital: 'Düsseldorf',
    difficulty: 'moderate',
    aerztekammer: 'Ärztekammer Nordrhein / Ärztekammer Westfalen-Lippe',
    aerztekammerUrl: 'https://www.aekno.de',
    processingTime: '4-7 months',
    notes: 'Most populous Bundesland — two separate Ärztekammern (Nordrhein and Westfalen-Lippe). Many large hospitals and university clinics (Cologne, Bonn, Düsseldorf, Münster, Aachen, Essen). High demand for psychiatrists. Moderate processing. Nordrhein (Cologne/Düsseldorf) tends slightly faster than Westfalen-Lippe.',
  },
  'Rheinland-Pfalz': {
    capital: 'Mainz',
    difficulty: 'moderate',
    aerztekammer: 'Landesärztekammer Rheinland-Pfalz',
    aerztekammerUrl: 'https://www.laek-rlp.de',
    processingTime: '4-6 months',
    notes: 'University Medicine Mainz is a strong employer. Moderate processing. Good quality of life along the Rhine. Many US military hospitals (Landstuhl, Ramstein area) employ civilian physicians.',
  },
  'Saarland': {
    capital: 'Saarbrücken',
    difficulty: 'moderate',
    aerztekammer: 'Ärztekammer des Saarlandes',
    aerztekammerUrl: 'https://www.aerztekammer-saarland.de',
    processingTime: '3-5 months',
    notes: 'Smallest area Bundesland after city-states. Universitätsklinikum des Saarlandes (Homburg) is the main employer. French border region. Relatively fast processing due to smaller volume.',
  },
  'Sachsen': {
    capital: 'Dresden',
    difficulty: 'accessible',
    aerztekammer: 'Sächsische Landesärztekammer',
    aerztekammerUrl: 'https://www.slaek.de',
    processingTime: '2-5 months',
    notes: 'Desperate for doctors — very accessible for international physicians. Fast processing. University hospitals in Dresden and Leipzig. Low cost of living. Cultural cities (Dresden, Leipzig). Active recruitment of international doctors with support programs.',
  },
  'Sachsen-Anhalt': {
    capital: 'Magdeburg',
    difficulty: 'accessible',
    aerztekammer: 'Ärztekammer Sachsen-Anhalt',
    aerztekammerUrl: 'https://www.aeksa.de',
    processingTime: '2-5 months',
    notes: 'Significant physician shortage. Very open to international doctors. University hospitals in Magdeburg and Halle. Fast processing. Low cost of living. Employers often provide integration support.',
  },
  'Schleswig-Holstein': {
    capital: 'Kiel',
    difficulty: 'moderate',
    aerztekammer: 'Ärztekammer Schleswig-Holstein',
    aerztekammerUrl: 'https://www.aeksh.de',
    processingTime: '4-6 months',
    notes: 'Northernmost Bundesland. UKSH (Universitätsklinikum Schleswig-Holstein) in Kiel and Lübeck. Coastal lifestyle. Moderate processing. Some shortage in rural areas.',
  },
  'Thüringen': {
    capital: 'Erfurt',
    difficulty: 'accessible',
    aerztekammer: 'Landesärztekammer Thüringen',
    aerztekammerUrl: 'https://www.laek-thueringen.de',
    processingTime: '2-5 months',
    notes: 'Accessible for international doctors. University hospital in Jena (renowned). Fast processing. Low cost of living. Cultural heritage (Weimar, Erfurt). Active international recruitment programs.',
  },
};

// ============================================================
// getBundeslandInfo
// ============================================================

export function getBundeslandInfo(location, company) {
  let bundesland = resolveBundesland(location);

  // Try to infer from company name if location didn't resolve
  if (!bundesland && company) {
    bundesland = resolveBundesland(company);
  }

  if (!bundesland) {
    return {
      bundesland: null, capital: null, difficulty: null,
      aerztekammer: null, aerztekammerUrl: null, processingTime: null,
      notes: `Could not determine Bundesland from location "${location}" or company "${company}". Provide a German city name or Bundesland.`,
    };
  }

  const info = BUNDESLAND_INFO[bundesland];
  if (!info) {
    return {
      bundesland, capital: null, difficulty: null,
      aerztekammer: null, aerztekammerUrl: null, processingTime: null,
      notes: `Bundesland "${bundesland}" recognized but no detailed data available.`,
    };
  }

  return {
    bundesland,
    capital: info.capital,
    difficulty: info.difficulty,
    aerztekammer: info.aerztekammer,
    aerztekammerUrl: info.aerztekammerUrl,
    processingTime: info.processingTime,
    notes: info.notes,
  };
}

// ============================================================
// US Sales/Telecom Pay Scales (annual base USD, excludes commission)
// ============================================================

const US_PAY_SCALES = {
  'entry_sdr':          { label: 'Entry Level SDR/BDR',            min: 45000,  max: 60000,  ote: '$65K-$90K' },
  'inside_sales':       { label: 'Inside Sales',                   min: 40000,  max: 55000,  ote: '$60K-$80K' },
  'account_manager':    { label: 'Account Manager',                min: 60000,  max: 85000,  ote: '$80K-$120K' },
  'sr_account_manager': { label: 'Senior Account Manager',         min: 75000,  max: 100000, ote: '$110K-$150K' },
  'account_executive':  { label: 'Account Executive',              min: 70000,  max: 95000,  ote: '$120K-$160K' },
  'sr_account_exec':    { label: 'Senior Account Executive',       min: 90000,  max: 130000, ote: '$150K-$200K' },
  'enterprise_ae':      { label: 'Enterprise Account Executive',   min: 110000, max: 160000, ote: '$180K-$280K' },
  'sales_manager':      { label: 'Sales Manager',                  min: 100000, max: 140000, ote: '$150K-$220K' },
  'sales_director':     { label: 'Sales Director',                 min: 130000, max: 180000, ote: '$200K-$300K' },
  'vp_sales':           { label: 'VP Sales',                       min: 160000, max: 220000, ote: '$250K-$400K' },
  'channel_partner':    { label: 'Channel/Partner Manager',        min: 80000,  max: 120000, ote: '$120K-$180K' },
  'solutions_engineer': { label: 'Solutions Engineer/Technical Sales', min: 90000, max: 135000, ote: '$130K-$180K' },
  'customer_success':   { label: 'Customer Success Manager',       min: 65000,  max: 95000,  ote: '$80K-$115K' },
};

// ============================================================
// US Title-to-Level Detection
// ============================================================

function detectUSLevel(title) {
  const t = (title || '').toLowerCase();

  // VP / Head level
  if (/\b(vp|vice president|head)\b.*\b(sales|revenue|commercial)\b/i.test(title) ||
      /\b(sales|revenue|commercial)\b.*\b(vp|vice president|head)\b/i.test(title)) {
    return { level: 'vp_sales', scale: 'US Sales/Executive' };
  }

  // Director level
  if (/\bdirector\b.*\b(sales|revenue|commercial|business develop)\b/i.test(title) ||
      /\b(sales|revenue|commercial)\b.*\bdirector\b/i.test(title)) {
    return { level: 'sales_director', scale: 'US Sales/Director' };
  }

  // Sales Manager
  if (/\b(sales|revenue)\s*(manager|lead|team lead)\b/i.test(title) ||
      /\bmanager\b.*\bsales\b/i.test(title)) {
    return { level: 'sales_manager', scale: 'US Sales/Management' };
  }

  // Solutions Engineer / Technical Sales / Sales Engineer
  if (/\b(solutions?\s*engineer|technical\s*sales|sales\s*engineer|pre-?sales)\b/i.test(title)) {
    return { level: 'solutions_engineer', scale: 'US Technical Sales' };
  }

  // Channel / Partner Manager
  if (/\b(channel|partner)\s*(manager|director|lead)\b/i.test(title)) {
    return { level: 'channel_partner', scale: 'US Channel/Partner' };
  }

  // Customer Success
  if (/\bcustomer\s*success/i.test(title)) {
    return { level: 'customer_success', scale: 'US Customer Success' };
  }

  // Enterprise Account Executive
  if (/\benterprise\b.*\b(account|sales)\b/i.test(title) ||
      /\b(account|sales)\b.*\benterprise\b/i.test(title)) {
    return { level: 'enterprise_ae', scale: 'US Enterprise Sales' };
  }

  // Senior Account Executive
  if (/\b(senior|sr\.?|lead|principal)\b.*\baccount\s*executive\b/i.test(title)) {
    return { level: 'sr_account_exec', scale: 'US Sales/Senior AE' };
  }

  // Senior Account Manager / Key Account
  if (/\b(senior|sr\.?|lead|principal|key)\b.*\baccount\s*manager\b/i.test(title) ||
      /\bstrategic\s*account/i.test(title) || /\bmajor\s*account/i.test(title)) {
    return { level: 'sr_account_manager', scale: 'US Sales/Senior AM' };
  }

  // Account Executive (before Account Manager — AE typically higher comp)
  if (/\baccount\s*executive\b/i.test(title)) {
    return { level: 'account_executive', scale: 'US Sales/AE' };
  }

  // Account Manager / Business Development
  if (/\baccount\s*manager\b/i.test(title) || /\bbusiness\s*develop/i.test(title)) {
    return { level: 'account_manager', scale: 'US Sales/AM' };
  }

  // Inside Sales
  if (/\binside\s*sales\b/i.test(title)) {
    return { level: 'inside_sales', scale: 'US Inside Sales' };
  }

  // SDR/BDR / Entry level
  if (/\b(sdr|bdr|sales\s*develop|business\s*develop.*rep)\b/i.test(title) ||
      /\b(junior|entry|associate)\b.*\b(sales|account)\b/i.test(title) ||
      /\b(sales|account)\b.*\b(junior|entry|associate)\b/i.test(title)) {
    return { level: 'entry_sdr', scale: 'US Sales/Entry' };
  }

  // Mid-market indicator bumps generic to AE level
  if (/\bmid[\s-]?market\b/i.test(title) && /\b(account|sales)\b/i.test(title)) {
    return { level: 'account_executive', scale: 'US Sales/Mid-Market' };
  }

  // Generic sales / telecom fallback
  if (/\b(sales|telecom|account|revenue|commercial)\b/i.test(title)) {
    return { level: 'account_manager', scale: 'US Sales/General' };
  }

  return { level: null, scale: null };
}

// ============================================================
// US Company/Industry Adjustments
// ============================================================

const US_MAJOR_TELECOM = [
  't-mobile', 'verizon', 'at&t', 'att', 'comcast', 'spectrum', 'charter',
  'lumen', 'centurylink', 'cox', 'frontier', 'windstream',
];

const US_FAANG_BIGTECH = [
  'google', 'alphabet', 'amazon', 'aws', 'meta', 'facebook', 'microsoft',
  'salesforce', 'oracle', 'cisco', 'sap', 'apple', 'ibm', 'dell',
  'vmware', 'broadcom', 'intel', 'nvidia', 'adobe', 'servicenow',
  'workday', 'snowflake', 'crowdstrike', 'palo alto', 'datadog',
];

const US_STAFFING = [
  'robert half', 'randstad', 'adecco', 'manpower', 'kelly services',
  'hays', 'insight global', 'teksystems', 'tek systems', 'kforce',
  'staffing', 'recruiting', 'talent', 'aerotek', 'aston carter',
];

function getUSCompanyAdjustment(company) {
  if (!company) return { factor: 1.0, type: 'unknown', note: null };
  const c = company.toLowerCase();

  if (US_FAANG_BIGTECH.some(n => c.includes(n))) {
    return { factor: 1.20, type: 'bigtech', note: 'Big Tech/FAANG: +15-25% above market' };
  }
  if (US_MAJOR_TELECOM.some(n => c.includes(n))) {
    return { factor: 1.125, type: 'telecom', note: 'Major telecom: +10-15% above market' };
  }
  if (US_STAFFING.some(n => c.includes(n))) {
    return { factor: 0.90, type: 'staffing', note: 'Staffing agency: -10% (contract/temp risk)' };
  }
  return { factor: 1.0, type: 'standard', note: null };
}

// ============================================================
// US Location (Cost of Living) Adjustments
// ============================================================

const US_HIGH_COL = {
  'new york':   1.20, 'nyc': 1.20, 'manhattan': 1.25, 'brooklyn': 1.20,
  'san francisco': 1.25, 'sf': 1.20, 'bay area': 1.20,
  'seattle': 1.18, 'boston': 1.18,
};

const US_MID_COL = {
  'los angeles': 1.12, 'la': 1.10,
  'washington': 1.12, 'dc': 1.12, 'd.c.': 1.12,
  'chicago': 1.10, 'denver': 1.08, 'austin': 1.08,
  'san diego': 1.10, 'portland': 1.08, 'miami': 1.08,
};

function getUSLocationAdjustment(location) {
  if (!location) return { factor: 1.0, note: null };
  const loc = location.toLowerCase();

  // Atlanta/Georgia = baseline
  if (/\b(atlanta|georgia|\bga\b)\b/i.test(location)) {
    return { factor: 1.0, note: 'Atlanta/GA: baseline (no adjustment)' };
  }

  // Remote
  if (/\bremote\b/i.test(location)) {
    return { factor: 1.05, note: 'Remote: +5% (national average premium)' };
  }

  // High COL
  for (const [city, factor] of Object.entries(US_HIGH_COL)) {
    if (loc.includes(city)) {
      const pct = Math.round((factor - 1) * 100);
      return { factor, note: `${city}: +${pct}% cost-of-living adjustment` };
    }
  }

  // Mid COL
  for (const [city, factor] of Object.entries(US_MID_COL)) {
    if (loc.includes(city)) {
      const pct = Math.round((factor - 1) * 100);
      return { factor, note: `${city}: +${pct}% cost-of-living adjustment` };
    }
  }

  return { factor: 1.0, note: null };
}

// ============================================================
// estimateUSSalary
// ============================================================

/**
 * Estimate US sales/telecom salary from job title, company, and location.
 * Returns { min, max, currency: 'USD', scale, notes }
 */
export function estimateUSSalary(title, company, location) {
  const { level, scale } = detectUSLevel(title || '');

  if (!level) {
    return {
      min: null, max: null, currency: 'USD', scale: null,
      notes: 'Could not determine US salary level from title.',
    };
  }

  const payBand = US_PAY_SCALES[level];
  let min = payBand.min;
  let max = payBand.max;
  const notes = [`${payBand.label}: base salary (OTE ${payBand.ote})`];

  // Company/industry adjustment
  const compAdj = getUSCompanyAdjustment(company);
  if (compAdj.factor !== 1.0) {
    min = Math.round(min * compAdj.factor);
    max = Math.round(max * compAdj.factor);
    notes.push(compAdj.note);
  }

  // Location adjustment
  const locAdj = getUSLocationAdjustment(location);
  if (locAdj.factor !== 1.0) {
    min = Math.round(min * locAdj.factor);
    max = Math.round(max * locAdj.factor);
  }
  if (locAdj.note) {
    notes.push(locAdj.note);
  }

  return { min, max, currency: 'USD', scale, notes: notes.join('. ') };
}

// ============================================================
// CLI Test Mode
// ============================================================

if (process.argv[1]?.endsWith('salary-bundesland.mjs')) {
  console.log('=== salary-bundesland.mjs — Test Output ===\n');

  const testCases = [
    { title: 'Oberarzt Psychiatrie und Psychotherapie (m/w/d)', company: 'Charité Berlin', location: 'Berlin' },
    { title: 'Assistenzarzt Psychiatrie', company: 'Klinikum Heidelberg', location: 'Heidelberg' },
    { title: 'Oberarzt/Oberärztin (m/w/d) für Psychiatrie und Psychotherapie', company: 'Klinikum Stuttgart gKAöR', location: 'Stuttgart' },
    { title: 'Facharzt Psychiatrie & Psychotherapie (m/w/d)', company: 'Augsburger Lehmbaugruppe GmbH', location: 'Augsburg' },
    { title: 'Chefarzt Psychiatrie', company: 'Helios Klinikum', location: 'Leipzig' },
    { title: 'Leitender Oberarzt Psychiatrie', company: 'Sana Kliniken', location: 'München' },
    { title: 'Psychiater (m/w/d)', company: 'MVZ Frankfurt', location: 'Frankfurt am Main' },
    { title: 'Assistenzarzt Psychiatrie', company: 'Doctari Group', location: 'Dresden' },
    { title: 'Oberärztin Psychiatrie', company: 'Vivantes', location: 'Berlin' },
    { title: 'Facharzt Neurologie und Psychiatrie', company: 'Universitätsklinikum Freiburg', location: 'Freiburg' },
  ];

  for (const tc of testCases) {
    console.log(`--- ${tc.title} @ ${tc.company} (${tc.location}) ---`);

    const salary = estimateSalary(tc.title, tc.company, tc.location);
    console.log('Salary:', JSON.stringify(salary, null, 2));

    const blInfo = getBundeslandInfo(tc.location, tc.company);
    console.log('Bundesland:', JSON.stringify(blInfo, null, 2));
    console.log();
  }

  console.log('\n=== US Sales/Telecom Salary Estimation ===\n');

  const usTestCases = [
    { title: 'Account Executive - Enterprise', company: 'T-Mobile', location: 'Atlanta, GA' },
    { title: 'Senior Account Manager', company: 'Comcast Business', location: 'Atlanta, GA' },
    { title: 'Sales Manager', company: 'Spectrum Business', location: 'Remote' },
    { title: 'Inside Sales Representative', company: 'Lumen Technologies', location: 'Atlanta, GA' },
    { title: 'Solutions Engineer', company: 'Salesforce', location: 'San Francisco, CA' },
    { title: 'VP Sales', company: 'TechStartup Inc', location: 'NYC' },
    { title: 'Business Development Representative', company: 'Robert Half', location: 'Chicago, IL' },
    { title: 'Channel Partner Manager', company: 'Cisco', location: 'Atlanta, GA' },
  ];

  for (const tc of usTestCases) {
    console.log(`--- ${tc.title} @ ${tc.company} (${tc.location}) ---`);
    const salary = estimateUSSalary(tc.title, tc.company, tc.location);
    console.log('Salary:', JSON.stringify(salary, null, 2));
    console.log();
  }
}
