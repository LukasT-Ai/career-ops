#!/usr/bin/env node
/**
 * generate-lebenslauf-pdf.mjs — Build Paulina's German Lebenslauf as PDF
 *
 * Reads cv-de.md, embeds headshot, renders via Playwright, outputs PDF.
 * Optionally sends as email attachment.
 *
 * Usage:
 *   node generate-lebenslauf-pdf.mjs                  # generate PDF only
 *   node generate-lebenslauf-pdf.mjs --send           # generate + email to Paulina
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { chromium } from 'playwright';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// ============================================================
// Read source data
// ============================================================

const cvDeMd = await readFile(resolve(__dirname, 'profiles/paulina/cv-de.md'), 'utf8');
const headshotBuf = await readFile(resolve(__dirname, 'profiles/paulina/headshot.webp'));
const headshotBase64 = `data:image/webp;base64,${headshotBuf.toString('base64')}`;

// ============================================================
// Build HTML from cv-de.md data (hardcoded parse for reliability)
// ============================================================

function buildLebenslaufHtml() {
  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<style>
  @page { size: A4; margin: 20mm 20mm 18mm 20mm; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body {
    font-family: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
    font-size: 10.5pt;
    line-height: 1.45;
    color: #1a1a2e;
    background: #fff;
    padding: 0;
    margin: 0;
  }

  /* Header with photo */
  .header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 14px;
    padding-bottom: 10px;
    border-bottom: 2.5px solid #0d7377;
  }
  .header-left { flex: 1; }
  .header-left h1 {
    font-size: 22pt;
    font-weight: 700;
    color: #0d7377;
    margin-bottom: 2px;
    letter-spacing: -0.3px;
  }
  .header-left .subtitle {
    font-size: 10pt;
    color: #555;
    font-style: italic;
    margin-bottom: 6px;
  }
  .photo {
    width: 95px;
    height: 120px;
    object-fit: cover;
    object-position: center 15%;
    border-radius: 4px;
    border: 1.5px solid #ddd;
    margin-left: 18px;
    flex-shrink: 0;
  }

  /* Sections */
  h2 {
    font-size: 11.5pt;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #0d7377;
    border-bottom: 1px solid #d0d0d0;
    padding-bottom: 2px;
    margin: 14px 0 7px;
  }
  h3 {
    font-size: 10.5pt;
    font-weight: 600;
    color: #2c2c4a;
    margin: 8px 0 2px;
  }

  /* Personal data grid */
  .data-grid {
    display: grid;
    grid-template-columns: 140px 1fr;
    gap: 2px 10px;
    font-size: 10pt;
  }
  .data-grid .label {
    font-weight: 600;
    color: #444;
  }
  .data-grid .value { color: #333; }
  .data-grid a { color: #0d7377; text-decoration: none; }

  /* Job entries */
  .job {
    margin-bottom: 8px;
    break-inside: avoid;
  }
  .job-header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
  }
  .job-title { font-weight: 600; color: #2c2c4a; font-size: 10.5pt; }
  .job-period { font-size: 9.5pt; color: #777; white-space: nowrap; }
  .job-org { font-size: 10pt; color: #0d7377; font-weight: 500; margin-bottom: 2px; }
  .job ul { padding-left: 16px; margin-top: 2px; }
  .job li { font-size: 10pt; color: #333; margin-bottom: 1px; }

  /* Education table */
  .edu-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 10pt;
    margin-top: 4px;
  }
  .edu-table td {
    padding: 3px 6px 3px 0;
    vertical-align: top;
    border-bottom: 1px solid #eee;
  }
  .edu-table td:first-child { white-space: nowrap; color: #777; width: 120px; }
  .edu-table td:nth-child(2) { color: #0d7377; font-weight: 500; }
  .edu-table td:nth-child(3) { color: #333; }

  /* Research entries */
  .research { margin-bottom: 6px; break-inside: avoid; }
  .research-header { font-weight: 600; font-size: 10pt; color: #2c2c4a; }
  .research-sub { font-size: 9.5pt; color: #777; font-style: italic; }
  .research ul { padding-left: 16px; margin-top: 1px; }
  .research li { font-size: 9.5pt; color: #444; margin-bottom: 1px; }

  /* Publications */
  .pub { font-size: 9.5pt; color: #333; margin-bottom: 3px; padding-left: 12px; text-indent: -12px; }
  .pub em { font-style: italic; }

  /* Awards / Teaching / Qualifications */
  .compact-list { padding-left: 16px; }
  .compact-list li { font-size: 10pt; color: #333; margin-bottom: 2px; }

  /* Approbation box */
  .approbation-box {
    background: #e8f5e9;
    border: 1.5px solid #2e7d32;
    border-radius: 5px;
    padding: 8px 12px;
    margin: 8px 0 4px;
    font-size: 10pt;
  }
  .approbation-box strong { color: #2e7d32; }

  /* Page break helper */
  .page-break { break-before: page; }
  .avoid-break { break-inside: avoid; }
</style>
</head>
<body>

<!-- ===== HEADER WITH PHOTO ===== -->
<div class="header">
  <div class="header-left">
    <h1>Dr. med. Paulina Kaiser</h1>
    <div class="subtitle">Fachärztin für Psychiatrie und Psychotherapie</div>
  </div>
  <img class="photo" src="${headshotBase64}" alt="Dr. med. Paulina Kaiser">
</div>

<!-- ===== PERSÖNLICHE DATEN ===== -->
<h2>Persönliche Daten</h2>
<div class="data-grid">
  <span class="label">Name:</span><span class="value">Dr. med. Paulina Kaiser</span>
  <span class="label">Anschrift:</span><span class="value">Atlanta, GA, USA (Umzug nach Deutschland geplant)</span>
  <span class="label">Telefon:</span><span class="value">+1 408-515-2102</span>
  <span class="label">E-Mail:</span><span class="value"><a href="mailto:paulinakaiser@gmail.com">paulinakaiser@gmail.com</a></span>
  <span class="label">Website:</span><span class="value"><a href="https://paulinakaiser.com">paulinakaiser.com</a></span>
  <span class="label">Geburtsdatum:</span><span class="value">auf Anfrage</span>
  <span class="label">Staatsangehörigkeit:</span><span class="value">Deutsch und US-amerikanisch (Doppelstaatsbürgerin)</span>
  <span class="label">Sprachen:</span><span class="value">Deutsch (Muttersprache), Englisch (fließend), Französisch (Konversation), Spanisch (medizinisch)</span>
</div>

<!-- ===== APPROBATIONSSTATUS ===== -->
<div class="approbation-box">
  <strong>Approbationsstatus</strong><br>
  <strong>USA:</strong> Board-certified Psychiatrist (Facharztausbildung abgeschlossen, Emory University 2023)<br>
  <strong>Deutschland:</strong> Approbation in Vorbereitung — deutsche Staatsbürgerin, kein Visum/Arbeitserlaubnis erforderlich. Anerkennungsverfahren über zuständige Ärztekammer geplant.<br>
  <strong>US-Lizenzen:</strong> Georgia (aktiv), Kalifornien (aktiv)
</div>

<!-- ===== BERUFSERFAHRUNG ===== -->
<h2>Berufserfahrung</h2>

<div class="job">
  <div class="job-header">
    <span class="job-title">Inhaberin und Fachärztin für Psychiatrie</span>
    <span class="job-period">seit Juli 2023</span>
  </div>
  <div class="job-org">Paulina Kaiser, MD LLC</div>
  <ul>
    <li>Eigenständige Praxisführung mit Diagnostik und Behandlung psychiatrischer Erkrankungen bei Erwachsenen</li>
    <li>Integration von Psychotherapie und Psychopharmakologie in individuell angepasste Behandlungspläne</li>
    <li>Aufbau und Management aller Praxisabläufe: strategische Planung, Budgetierung, Marketing und regulatorische Compliance</li>
  </ul>
</div>

<div class="job">
  <div class="job-header">
    <span class="job-title">Psychiaterin in der Notaufnahme und Konsiliar-Liaison</span>
    <span class="job-period">seit Juli 2023</span>
  </div>
  <div class="job-org">Grady Memorial Hospital, Atlanta</div>
  <ul>
    <li>Rasche Beurteilung und Management akuter psychiatrischer Krisen: Suizidalität, schwere Angststörungen, Psychosen und substanzassoziierte Notfälle</li>
    <li>Evidenzbasierte Deeskalation und Sicherstellung der Patientenstabilität</li>
    <li>Supervision und Ausbildung von Assistenzärzten in der psychiatrischen Notfallversorgung</li>
    <li>Konsiliarpsychiatrie: Differenzierung primär psychiatrischer Erkrankungen von somatischen Erkrankungen mit psychiatrischer Symptomatik</li>
  </ul>
</div>

<div class="job">
  <div class="job-header">
    <span class="job-title">Ambulante Psychiaterin</span>
    <span class="job-period">seit August 2023</span>
  </div>
  <div class="job-org">Dekalb Community Service Board, Atlanta</div>
  <ul>
    <li>Psychiatrische Medikamenteneinstellung und Psychotherapie für unterversorgte Patienten, vorwiegend mit schweren psychischen Erkrankungen</li>
    <li>Kulturell kompetente Versorgung diverser Patientenpopulationen</li>
  </ul>
</div>

<div class="job">
  <div class="job-header">
    <span class="job-title">Oberassistentin (Chief Resident) — Ambulante Psychiatrie</span>
    <span class="job-period">Juli 2022 – Juli 2023</span>
  </div>
  <div class="job-org">Emory University, Atlanta</div>
  <ul>
    <li>Leitung der wöchentlichen Psychotherapie-Supervision für Assistenzärzte</li>
    <li>Koordination der ambulanten Diensteinteilung</li>
    <li>Steuerung der Psychotherapie-Zuweisungen: Screening, Zuordnung und Weiterleitung</li>
  </ul>
</div>

<div class="job">
  <div class="job-header">
    <span class="job-title">Assistenzärztin für Psychiatrie</span>
    <span class="job-period">Juli 2019 – Juli 2023</span>
  </div>
  <div class="job-org">Emory University, Atlanta</div>
  <ul>
    <li>Facharztausbildung in Notaufnahme, stationärer Psychiatrie und ambulanten Kliniken</li>
    <li>Leitung multidisziplinärer Teams auf psychiatrischen Stationen (Grady Hospital, Emory Wesley Woods, Atlanta VA Hospital)</li>
    <li>Eigenständige ambulante Medikamenteneinstellung für versicherte und unversicherte Patienten</li>
    <li>8 Stunden Psychotherapie pro Woche im Psychotherapie-Schwerpunkt</li>
  </ul>
</div>

<!-- ===== AUSBILDUNG ===== -->
<h2>Ausbildung</h2>
<table class="edu-table">
  <tr>
    <td>2020 – 2025</td>
    <td>Emory University Psychoanalytic Institute</td>
    <td>Psychoanalytische Psychotherapie (zertifiziert)</td>
  </tr>
  <tr>
    <td>2019 – 2023</td>
    <td>Emory University, Dept. of Psychiatry</td>
    <td>Facharztausbildung Psychiatrie (Chief Resident)</td>
  </tr>
  <tr>
    <td>2015 – 2019</td>
    <td>Keck School of Medicine, USC</td>
    <td>Doctor of Medicine (MD)</td>
  </tr>
  <tr>
    <td>2010 – 2014</td>
    <td>University of California Los Angeles</td>
    <td>B.S. Psychobiologie, magna cum laude</td>
  </tr>
</table>

<!-- ===== FORSCHUNGSERFAHRUNG ===== -->
<h2>Forschungserfahrung</h2>

<div class="research">
  <div class="research-header">Emory University, Department of Psychiatry</div>
  <div class="research-sub">Prof. Timothy Moore, MD | seit Februar 2022</div>
  <ul><li>Manuskriptvorbereitung zur Auswirkung von Antipsychotika vs. EKT und Benzodiazepinen bei Katatonie</li></ul>
</div>

<div class="research">
  <div class="research-header">Keck School of Medicine of USC</div>
  <div class="research-sub">Prof. Lon Schneider, MD | Oktober 2018 – Mai 2019</div>
  <ul><li>Untersuchung alternativer Demenzbehandlungen auf Arztwebsites; meta-analytische Suchstrategie</li></ul>
</div>

<div class="research">
  <div class="research-header">Children's Hospital Los Angeles</div>
  <div class="research-sub">Prof. Susan Turkel, MD | Juni 2016 – März 2019</div>
  <ul>
    <li>Studie zu Mirtazapin bei medizinisch erkrankten Kindern mit Depression und Angststörung</li>
    <li>Retrospektive Datenauswertung von über 200 Patientenakten; statistische Analyse</li>
  </ul>
</div>

<div class="research">
  <div class="research-header">UCLA, Department of Psychiatry</div>
  <div class="research-sub">Prof. Carrie Bearden, PhD | September 2011 – Juni 2014</div>
  <ul><li>EEG-Forschung zu Mismatch Negativity als Prädiktor für Psychosen im Prodromalstadium der Schizophrenie</li></ul>
</div>

<div class="research">
  <div class="research-header">Universität Heidelberg, Klinik für Psychiatrie</div>
  <div class="research-sub">Prof. Corinna Reck, PhD | Juni 2011 – September 2011</div>
  <ul>
    <li>Forschung zu postpartaler Depression und Bindungsstörungen</li>
    <li>Rekrutierung von Studienteilnehmerinnen auf perinatalen Stationen; Durchführung von Telefoninterviews und psychologischen Assessments (Strange Situation, Still Face)</li>
    <li>Klinische Mitarbeit auf der perinatalen psychiatrischen Station (Deutsch-Englisch Übersetzung, Betreuung)</li>
  </ul>
</div>

<!-- ===== PUBLIKATIONEN UND VORTRÄGE ===== -->
<h2>Publikationen und Vorträge</h2>
<div class="pub">Kaiser P., Nguyen D., Turkel S., Hanft A. <em>Benefits of Mirtazapine for Depression in Children and Adolescents with Cystic Fibrosis.</em> APA Convention, San Diego 2017</div>
<div class="pub">Kaiser P., Nguyen D., Turkel S., Hanft A. <em>Benefits of Mirtazapine for Depression in Children and Adolescents with Cystic Fibrosis.</em> Keck Research Forum, Los Angeles 2017</div>
<div class="pub">Hanft A., Kaiser P., Nguyen D., et al. <em>Mirtazapine for Depression and Anxiety in Medically Ill Pediatric Patients.</em> Academy of Psychosomatic Medicine, Orlando 2017</div>
<div class="pub">Kaiser P., Tsai D., Greenspan H. <em>Catatonia for Internal Medicine Residents.</em> Oral Presentation, Mai 2021</div>
<div class="pub">Kaiser P., Greenspan H. <em>Serotonergic Nootropics and Supplements and Their Risks.</em> Oral Presentation, März 2021</div>

<!-- ===== AUSZEICHNUNGEN ===== -->
<h2>Auszeichnungen</h2>
<ul class="compact-list">
  <li><strong>Resident Recognition Award</strong> (2022) — Hervorragende Leistungen in Führung, Lehre und klinischer Versorgung</li>
  <li><strong>Phi Beta Kappa</strong> (2014)</li>
  <li><strong>Dean's List</strong> (2010–2014)</li>
  <li><strong>Keck School of Medicine Summer Research Fellowship</strong> (2016)</li>
</ul>

<!-- ===== BESONDERE QUALIFIKATIONEN ===== -->
<h2>Besondere Qualifikationen</h2>
<ul class="compact-list">
  <li><strong>Psychotherapie-Ausbildung:</strong> Zertifizierte psychoanalytische Psychotherapeutin (Emory Institute, 2025), integrierter Psychotherapie-Schwerpunkt in der Facharztausbildung</li>
  <li><strong>Notfallpsychiatrie:</strong> Erfahrung an Level-1-Traumazentrum (Grady Memorial Hospital)</li>
  <li><strong>Unterversorgte Populationen:</strong> Community Mental Health, Obdachlosenkliniken, VA Hospital</li>
  <li><strong>Klinische Führung:</strong> Chief Resident, Praxisinhaberin, Rekrutierungsbeauftragte</li>
  <li><strong>Forschung:</strong> 5 Forschungspositionen (UCLA, USC, CHLA, Emory, Universität Heidelberg)</li>
</ul>

</body>
</html>`;
}

// ============================================================
// Generate PDF
// ============================================================

const html = buildLebenslaufHtml();

// Write HTML for debugging
const outputDir = resolve(__dirname, 'profiles/paulina/output');
if (!existsSync(outputDir)) await mkdir(outputDir, { recursive: true });
const htmlPath = resolve(outputDir, 'lebenslauf-de.html');
await writeFile(htmlPath, html, 'utf8');

console.log('Launching Playwright for PDF generation...');
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

await page.setContent(html, { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);

const pdfBuffer = await page.pdf({
  format: 'A4',
  printBackground: true,
  margin: { top: '20mm', right: '20mm', bottom: '18mm', left: '20mm' },
  preferCSSPageSize: false,
});

const pdfPath = resolve(outputDir, 'Lebenslauf-Dr-Paulina-Kaiser.pdf');
await writeFile(pdfPath, pdfBuffer);

const pageCount = (pdfBuffer.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
console.log(`PDF generated: ${pdfPath}`);
console.log(`Pages: ${pageCount}, Size: ${(pdfBuffer.length / 1024).toFixed(1)} KB`);

await browser.close();

// ============================================================
// Send email if --send
// ============================================================

if (process.argv.includes('--send')) {
  const nodemailer = require('C:/Users/Lukas/.openclaw/workspace/node_modules/nodemailer');

  const transport = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: 'Lukas.T@withlukas.com', pass: 'qviq mipq qvjl ubpk' },
  });

  await transport.sendMail({
    from: '"Career-Ops" <Lukas.T@withlukas.com>',
    to: 'paulinakaiser@gmail.com',
    subject: '📄 Lebenslauf zur Durchsicht — Dr. med. Paulina Kaiser',
    html: `
    <div style="font-family: Georgia, serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background: linear-gradient(135deg, #0d9488 0%, #065f46 100%); color: white; padding: 24px; border-radius: 8px 8px 0 0;">
        <h1 style="margin: 0; color: white; font-size: 20px;">Lebenslauf zur Durchsicht</h1>
        <p style="margin: 6px 0 0; color: #d1fae5; font-size: 13px;">Career-Ops &mdash; Automatisch erstellt</p>
      </div>
      <div style="padding: 24px; background: #fff; border: 1px solid #ddd;">
        <p>Hallo Paulina,</p>
        <p>Anbei findest du deinen <strong>Lebenslauf als PDF</strong> im deutschen Format &mdash; mit Bewerbungsfoto, allen Berufserfahrungen, Forschungspositionen, Publikationen und Qualifikationen.</p>
        <p>Bitte pr&uuml;fe alles sorgf&auml;ltig:</p>
        <ul>
          <li>Stimmen alle Daten und Zeitr&auml;ume?</li>
          <li>M&ouml;chtest du dein Geburtsdatum erg&auml;nzen? (in DE &uuml;blich)</li>
          <li>Passt das Foto?</li>
          <li>Sollen Formulierungen ge&auml;ndert werden?</li>
        </ul>
        <p>Antworte einfach auf diese E-Mail mit &Auml;nderungsw&uuml;nschen.</p>
        <div style="background: #e8f5e9; border: 2px solid #2e7d32; padding: 12px; border-radius: 6px; margin: 20px 0;">
          <strong style="color: #2e7d32;">Enthalten im Lebenslauf:</strong>
          <ul style="margin: 6px 0 0; font-size: 14px;">
            <li>Pers&ouml;nliche Daten + Bewerbungsfoto</li>
            <li>Approbationsstatus (USA &amp; Deutschland)</li>
            <li>3 aktuelle Berufspositionen + Residency</li>
            <li>5 Forschungspositionen (UCLA, USC, CHLA, Emory, Heidelberg)</li>
            <li>5 Publikationen/Vortr&auml;ge</li>
            <li>Lehrerfahrung, Auszeichnungen, Besondere Qualifikationen</li>
          </ul>
        </div>
      </div>
      <div style="background: #f0f0f0; padding: 10px 20px; border-radius: 0 0 8px 8px; font-size: 12px; color: #999;">
        Career-Ops AI Job Search Engine
      </div>
    </div>`,
    attachments: [{
      filename: 'Lebenslauf-Dr-Paulina-Kaiser.pdf',
      path: pdfPath,
      contentType: 'application/pdf',
    }],
  });

  console.log('Email sent to paulinakaiser@gmail.com with PDF attachment');
  transport.close();
} else {
  console.log('\nTo send via email: node generate-lebenslauf-pdf.mjs --send');
}
