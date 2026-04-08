#!/usr/bin/env node
/**
 * generate-lebenslauf-lamin-pdf.mjs — Build Lamin's German Lebenslauf as PDF
 *
 * Reads cv-de.md, renders via Playwright, outputs PDF.
 * Optionally sends as email attachment.
 *
 * Usage:
 *   node generate-lebenslauf-lamin-pdf.mjs                  # generate PDF only
 *   node generate-lebenslauf-lamin-pdf.mjs --send           # generate + email to Lamin
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
// Color scheme — Lamin's navy palette (from cover letters + resume)
// ============================================================
const NAVY       = '#1B3A5C';  // primary accent (headings, links, org names)
const NAVY_LIGHT = '#2B4D6E';  // secondary accent

// Load headshot
const headshotBuf = await readFile(resolve(__dirname, 'profiles/lamin/headshot.jpg'));
const headshotBase64 = `data:image/jpeg;base64,${headshotBuf.toString('base64')}`;

// ============================================================
// Build HTML from cv-de.md data (hardcoded parse for reliability)
// ============================================================

function buildLebenslaufHtml() {
  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<style>
  @page { size: A4; margin: 18mm 18mm 16mm 18mm; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body {
    font-family: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
    font-size: 9.5pt;
    line-height: 1.38;
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
    margin-bottom: 10px;
    padding-bottom: 8px;
    border-bottom: 2.5px solid ${NAVY};
  }
  .header-left { flex: 1; }
  .header-left h1 {
    font-size: 20pt;
    font-weight: 700;
    color: ${NAVY};
    margin-bottom: 1px;
    letter-spacing: -0.3px;
  }
  .header-left .subtitle {
    font-size: 9.5pt;
    color: #555;
    font-style: italic;
    margin-bottom: 4px;
  }
  .photo {
    width: 95px;
    height: 120px;
    object-fit: cover;
    object-position: center 20%;
    border-radius: 4px;
    border: 1.5px solid #ddd;
    margin-left: 18px;
    flex-shrink: 0;
  }

  /* Sections */
  h2 {
    font-size: 10.5pt;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: ${NAVY};
    border-bottom: 1px solid #d0d0d0;
    padding-bottom: 2px;
    margin: 10px 0 5px;
  }
  h3 {
    font-size: 9.5pt;
    font-weight: 600;
    color: #2c2c4a;
    margin: 6px 0 2px;
  }

  /* Personal data grid */
  .data-grid {
    display: grid;
    grid-template-columns: 130px 1fr;
    gap: 1px 8px;
    font-size: 9pt;
  }
  .data-grid .label {
    font-weight: 600;
    color: #444;
  }
  .data-grid .value { color: #333; }
  .data-grid a { color: ${NAVY}; text-decoration: none; }

  /* Job entries */
  .job {
    margin-bottom: 6px;
    break-inside: avoid;
  }
  .job-header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
  }
  .job-title { font-weight: 600; color: #2c2c4a; font-size: 9.5pt; }
  .job-period { font-size: 8.5pt; color: #777; white-space: nowrap; }
  .job-org { font-size: 9pt; color: ${NAVY}; font-weight: 500; margin-bottom: 1px; }
  .job ul { padding-left: 14px; margin-top: 1px; }
  .job li { font-size: 9pt; color: #333; margin-bottom: 0.5px; }

  /* Education table */
  .edu-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 9pt;
    margin-top: 3px;
  }
  .edu-table td {
    padding: 2px 5px 2px 0;
    vertical-align: top;
    border-bottom: 1px solid #eee;
  }
  .edu-table td:first-child { white-space: nowrap; color: #777; width: 110px; }
  .edu-table td:nth-child(2) { color: ${NAVY}; font-weight: 500; }
  .edu-table td:nth-child(3) { color: #333; }

  /* Skills section */
  .skills-block { margin-bottom: 3px; font-size: 9pt; color: #333; }
  .skills-block strong { color: #2c2c4a; }

  /* Awards / Compact lists */
  .compact-list { padding-left: 14px; }
  .compact-list li { font-size: 9pt; color: #333; margin-bottom: 1px; }

  /* Profile box */
  .profile-box {
    background: #eef2f7;
    border: 1.5px solid ${NAVY};
    border-radius: 5px;
    padding: 6px 10px;
    margin: 6px 0 3px;
    font-size: 9pt;
    color: #333;
    line-height: 1.42;
  }

  /* Page break helper */
  .page-break { break-before: page; }
  .avoid-break { break-inside: avoid; }

  /* Signature block */
  .signature-block {
    margin-top: 18px;
    font-size: 9pt;
    color: #333;
  }
  .signature-block .sig-name {
    font-weight: 600;
    margin-top: 20px;
  }
</style>
</head>
<body>

<!-- ===== HEADER WITH PHOTO PLACEHOLDER ===== -->
<div class="header">
  <div class="header-left">
    <h1>Lamin Traor\u00e9</h1>
    <div class="subtitle">Vertriebsleiter &amp; Technischer Vertriebskonsultant</div>
  </div>
  <img class="photo" src="${headshotBase64}" alt="Lamin Traor\u00e9">
</div>

<!-- ===== PERS\u00d6NLICHE DATEN ===== -->
<h2>Pers\u00f6nliche Daten</h2>
<div class="data-grid">
  <span class="label">Name:</span><span class="value">Lamin Traor\u00e9</span>
  <span class="label">Anschrift:</span><span class="value">Atlanta, GA 30317, USA</span>
  <span class="label">Telefon:</span><span class="value">404-234-0448</span>
  <span class="label">E-Mail:</span><span class="value"><a href="mailto:pt374t@gmail.com">pt374t@gmail.com</a></span>
  <span class="label">LinkedIn:</span><span class="value"><a href="https://linkedin.com/in/lamintraore">linkedin.com/in/lamintraore</a></span>
  <span class="label">Staatsangeh\u00f6rigkeit:</span><span class="value">Deutsch und US-amerikanisch (Doppelstaatsb\u00fcrger)</span>
  <span class="label">Sprachen:</span><span class="value">Englisch (flie\u00dfend), Deutsch (flie\u00dfend), Franz\u00f6sisch (Grundkenntnisse), Spanisch (Grundkenntnisse)</span>
</div>

<!-- ===== BERUFLICHES PROFIL ===== -->
<div class="profile-box">
  <strong style="color: ${NAVY};">Berufliches Profil</strong><br>
  Erfahrener Vertriebsleiter und technischer Vertriebskonsultant mit \u00fcber 15 Jahren nachgewiesener Expertise im Enterprise-Vertrieb f\u00fcr Konnektivit\u00e4ts-, Unified-Communications- und Managed-Network-L\u00f6sungen. Fundierte Kompetenzen im strategischen Aufbau und in der F\u00fchrung leistungsstarker Vertriebsteams sowie in der nachhaltigen \u00dcberschreitung anspruchsvoller Umsatzziele im Millionenbereich. Ausgewiesene St\u00e4rken in der Entwicklung beratungsorientierter, l\u00f6sungsbasierter Vertriebsstrategien f\u00fcr komplexe technische Produkte. Mehrsprachig mit verhandlungssicheren Deutsch- und Englischkenntnissen.
</div>

<!-- ===== BERUFSERFAHRUNG ===== -->
<h2>Berufserfahrung</h2>

<div class="job">
  <div class="job-header">
    <span class="job-title">Sales Manager</span>
    <span class="job-period">seit 12/2025</span>
  </div>
  <div class="job-org">Spectrum Business Services, Atlanta, GA, USA</div>
  <ul>
    <li>Disziplinarische und fachliche F\u00fchrung, Coaching sowie gezielte Weiterentwicklung eines leistungsstarken Teams aus Enterprise Account Executives und Account Managern mit Schwerpunkt auf mittelst\u00e4ndische und standort\u00fcbergreifende Gesch\u00e4ftskunden</li>
    <li>Implementierung und Steuerung eines strukturierten, beratungsorientierten Vertriebsansatzes \u00fcber die gesamte L\u00f6sungspalette \u2013 Konnektivit\u00e4t, Managed Network, Security, Cloud und Voice</li>
    <li>Etablierung verbindlicher Akquise-Rhythmen, klar definierter Aktivit\u00e4tserwartungen sowie transparenter Leistungskennzahlen zur nachhaltigen Steigerung der Pipeline-Generierung und Quotenerreichung</li>
    <li>Enge Verzahnung mit Sales Engineering und technischen Vertriebskonsultanten zur Sicherstellung pr\u00e4ziser L\u00f6sungsdesigns, vollst\u00e4ndiger Bedarfsanalysen sowie qualitativ hochwertiger Kundenangebote</li>
    <li>Kontinuierliche Markt- und Wettbewerbsanalyse zur strategischen Positionierung des Spectrum-Portfolios gegen\u00fcber Mitbewerbern</li>
    <li>Regelm\u00e4\u00dfige Berichterstattung an die Gesch\u00e4ftsleitung zu Vertriebsleistung, Forecast-Entwicklung und Teamentwicklungsma\u00dfnahmen</li>
  </ul>
</div>

<div class="job">
  <div class="job-header">
    <span class="job-title">Technical Sales Consultant \u2013 Unified Communications</span>
    <span class="job-period">01/2023 \u2013 12/2025</span>
  </div>
  <div class="job-org">Spectrum Enterprise, Atlanta, GA, USA</div>
  <ul>
    <li>Funktion als zentraler Fachexperte f\u00fcr Unified-Communications-L\u00f6sungen mit unternehmerischer Verantwortung f\u00fcr die Identifikation, Qualifizierung und Sicherung strategisch relevanter Enterprise-Gesch\u00e4ftsm\u00f6glichkeiten</li>
    <li>Konzeption und Durchf\u00fchrung \u00fcberzeugender technischer Pr\u00e4sentationen zu IP-basierten UC-Services auf C-Level-Ebene sowie f\u00fcr weitere Entscheidungstr\u00e4ger komplexer Kundenorganisationen</li>
    <li>Beratung anspruchsvoller Unternehmenskunden bei der Erf\u00fcllung vielschichtiger technischer Anforderungen in den Bereichen Voice, Collaboration und Cloud-Kommunikation</li>
    <li>Strukturierte Kommunikation von Pipeline-Fortschritt, Wettbewerbsinformationen und strategischen Markterkenntnissen an die F\u00fchrungsebene</li>
  </ul>
</div>

<div class="job">
  <div class="job-header">
    <span class="job-title">Technical Sales Consultant III</span>
    <span class="job-period">2016 \u2013 2022</span>
  </div>
  <div class="job-org">AT&amp;T, Atlanta, GA, USA</div>
  <ul>
    <li>Positionierung als ausgewiesener Fachexperte f\u00fcr MPLS, VoIP, konvergente Sprach- und Datenl\u00f6sungen, Managed Data Center sowie Netzwerksicherheit innerhalb des gesamten AT&amp;T Enterprise-Portfolios</li>
    <li>Enge partnerschaftliche Zusammenarbeit mit Account Managern zur systematischen Identifikation und zum erfolgreichen Abschluss strategisch bedeutsamer Gesch\u00e4ftsm\u00f6glichkeiten \u2013 kontinuierliche Erreichung und \u00dcberschreitung der vereinbarten Jahresziele</li>
    <li>Eigenverantwortliche Durchf\u00fchrung technischer Pr\u00e4sentationen sowie beratungsorientierter Vertriebsgespr\u00e4che f\u00fcr IP-basierte AT&amp;T-Services bei Enterprise- und Beh\u00f6rdenkunden</li>
  </ul>
</div>

<div class="job">
  <div class="job-header">
    <span class="job-title">Client Solutions Executive</span>
    <span class="job-period">2011 \u2013 2016</span>
  </div>
  <div class="job-org">AT&amp;T, Atlanta, GA, USA</div>
  <ul>
    <li>Strategische Betreuung und Entwicklung eines Kundenstamms aus Gro\u00df- und mittelst\u00e4ndischen Unternehmen der Bereiche \u00f6ffentliche Verwaltung, Bildung und Gesundheitswesen mit einem Gesamtbillingvolumen von 9,5 Millionen US-Dollar</li>
    <li>Auszeichnung mit dem AT&amp;T Diamond Club Award (2013) \u2013 W\u00fcrdigung als Top-1-%-Performer der nationalen Vertriebsorganisation</li>
    <li>Erfolgreiche Akquise und Abschluss neuer Gesch\u00e4ftsm\u00f6glichkeiten \u00fcber die L\u00f6sungspalette IPFlex, IPTF, VPN, Ethernet und Mobility</li>
  </ul>
</div>

<!-- ===== AUSBILDUNG ===== -->
<h2>Ausbildung</h2>
<table class="edu-table">
  <tr>
    <td>2009</td>
    <td>Reinhardt University, Waleska, GA, USA</td>
    <td>Bachelor of Science in Business Administration</td>
  </tr>
</table>

<!-- ===== FACHLICHE KOMPETENZEN ===== -->
<h2>Fachliche Kompetenzen</h2>
<div class="skills-block">
  <strong>Vertrieb &amp; Beratung:</strong> Technical Sales, Unified Communications, Solutions Architecture, Strategische Beratung, Account Management, Vertriebsleitung, Pipeline Management
</div>
<div class="skills-block">
  <strong>Technisch:</strong> MPLS, VoIP, Ethernet, Netzwerksicherheit, Data/Voice Networking, Cloud-L\u00f6sungen, Managed Network Services
</div>
<div class="skills-block">
  <strong>Software:</strong> Microsoft Office Suite, CRM-Systeme (Salesforce), AI Tools, Windows &amp; iOS
</div>

<!-- ===== AUSZEICHNUNGEN ===== -->
<h2>Auszeichnungen</h2>
<ul class="compact-list">
  <li><strong>AT&amp;T Diamond Club Member</strong> (2013) \u2013 Top 1% der nationalen Vertriebsleistung</li>
</ul>

<!-- ===== ENGAGEMENT UND MITGLIEDSCHAFTEN ===== -->
<h2>Engagement und Mitgliedschaften</h2>
<ul class="compact-list">
  <li><strong>International Toastmasters Club</strong> \u2013 Mitglied</li>
  <li><strong>American Red Cross</strong> \u2013 Ehrenamtliche T\u00e4tigkeit</li>
</ul>

<!-- ===== SIGNATURE / DATE BLOCK ===== -->
<div class="signature-block">
  <div>Atlanta, April 2026</div>
  <div class="sig-name">Lamin Traor\u00e9</div>
</div>

</body>
</html>`;
}

// ============================================================
// Generate PDF
// ============================================================

const html = buildLebenslaufHtml();

// Write HTML for debugging
const outputDir = resolve(__dirname, 'profiles/lamin/output');
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
  margin: { top: '18mm', right: '18mm', bottom: '16mm', left: '18mm' },
  preferCSSPageSize: false,
});

const pdfPath = resolve(outputDir, 'Lebenslauf-Lamin-Traore.pdf');
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
    to: 'pt374t@gmail.com',
    subject: 'Lebenslauf zur Durchsicht -- Lamin Traore',
    html: `
    <div style="font-family: Georgia, serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background: linear-gradient(135deg, #1B3A5C 0%, #2B4D6E 100%); color: white; padding: 24px; border-radius: 8px 8px 0 0;">
        <h1 style="margin: 0; color: white; font-size: 20px;">Lebenslauf zur Durchsicht</h1>
        <p style="margin: 6px 0 0; color: #b8c4cc; font-size: 13px;">Career-Ops &mdash; Automatisch erstellt</p>
      </div>
      <div style="padding: 24px; background: #fff; border: 1px solid #ddd;">
        <p>Hi Lamin,</p>
        <p>Anbei findest du deinen <strong>Lebenslauf als PDF</strong> im deutschen Format &mdash; mit allen Berufserfahrungen, Kompetenzen und Auszeichnungen.</p>
        <p>Bitte pr&uuml;fe alles sorgf&auml;ltig:</p>
        <ul>
          <li>Stimmen alle Daten und Zeitr&auml;ume?</li>
          <li>Passt das Bewerbungsfoto?</li>
          <li>Sollen Formulierungen ge&auml;ndert werden?</li>
        </ul>
        <p>Antworte einfach auf diese E-Mail mit &Auml;nderungsw&uuml;nschen.</p>
        <div style="background: #eef2f7; border: 2px solid #1B3A5C; padding: 12px; border-radius: 6px; margin: 20px 0;">
          <strong style="color: #1B3A5C;">Enthalten im Lebenslauf:</strong>
          <ul style="margin: 6px 0 0; font-size: 14px;">
            <li>Pers&ouml;nliche Daten + Bewerbungsfoto</li>
            <li>Berufliches Profil</li>
            <li>4 Berufspositionen (Spectrum + AT&amp;T)</li>
            <li>Fachliche Kompetenzen (Vertrieb, Technik, Software)</li>
            <li>Auszeichnungen, Engagement</li>
          </ul>
        </div>
      </div>
      <div style="background: #f0f0f0; padding: 10px 20px; border-radius: 0 0 8px 8px; font-size: 12px; color: #999;">
        Career-Ops AI Job Search Engine
      </div>
    </div>`,
    attachments: [{
      filename: 'Lebenslauf-Lamin-Traore.pdf',
      path: pdfPath,
      contentType: 'application/pdf',
    }],
  });

  console.log('Email sent to pt374t@gmail.com with PDF attachment');
  transport.close();
} else {
  console.log('\nTo send via email: node generate-lebenslauf-lamin-pdf.mjs --send');
}
