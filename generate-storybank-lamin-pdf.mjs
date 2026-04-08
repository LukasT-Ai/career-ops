#!/usr/bin/env node
/**
 * generate-storybank-pdf.mjs — Build Paulina's Interview Story Bank as PDF
 * and optionally send via email.
 *
 * Usage:
 *   node generate-storybank-pdf.mjs                # generate PDF only
 *   node generate-storybank-pdf.mjs --send         # generate + email to Paulina
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { chromium } from 'playwright';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const md = await readFile(resolve(__dirname, 'interview-prep/story-bank-lamin.md'), 'utf8');

// ============================================================
// Markdown → HTML conversion (purpose-built for this doc)
// ============================================================

function mdToHtml(text) {
  let html = text
    // Escape HTML entities first
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // Headings
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    // Bold + italic
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    // Blockquotes (German translations)
    .replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>')
    // Horizontal rules
    .replace(/^---$/gm, '<hr>')
    // Line breaks
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br>');

  return `<p>${html}</p>`;
}

function buildHtml() {
  const content = mdToHtml(md);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  @page { size: A4; margin: 18mm 20mm; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body {
    font-family: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
    font-size: 10pt;
    line-height: 1.5;
    color: #1a1a2e;
    background: #fff;
    padding: 0;
    margin: 0;
  }

  h1 {
    font-size: 18pt;
    font-weight: 700;
    color: #0d7377;
    margin-bottom: 4px;
    padding-bottom: 6px;
    border-bottom: 2.5px solid #0d7377;
  }
  h2 {
    font-size: 12pt;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #0d7377;
    margin-top: 16px;
    margin-bottom: 6px;
    padding-bottom: 2px;
    border-bottom: 1px solid #d0d0d0;
  }
  h3 {
    font-size: 11pt;
    font-weight: 600;
    color: #2c2c4a;
    margin-top: 12px;
    margin-bottom: 4px;
    break-after: avoid;
  }

  p {
    margin-bottom: 6px;
    font-size: 10pt;
    color: #333;
  }

  strong { font-weight: 600; color: #1a1a2e; }
  em { font-style: italic; }

  blockquote {
    background: #f0f7f7;
    border-left: 3px solid #0d7377;
    padding: 8px 12px;
    margin: 8px 0;
    font-size: 9.5pt;
    color: #2c2c4a;
    font-style: italic;
    break-inside: avoid;
  }

  hr {
    border: none;
    border-top: 1px solid #e0e0e0;
    margin: 14px 0;
  }

  /* STAR labels */
  strong:first-child {
    color: #0d7377;
  }

  /* Keep stories together */
  h3 + p, h3 + blockquote {
    break-inside: avoid;
  }
</style>
</head>
<body>
${content}
</body>
</html>`;
}

// ============================================================
// Generate PDF
// ============================================================

const html = buildHtml();

const outputDir = resolve(__dirname, 'profiles/lamin/output');
if (!existsSync(outputDir)) await mkdir(outputDir, { recursive: true });

const htmlPath = resolve(outputDir, 'story-bank-lamin.html');
await writeFile(htmlPath, html, 'utf8');

console.log('Launching Playwright for PDF generation...');
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

await page.setContent(html, { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);

const pdfBuffer = await page.pdf({
  format: 'A4',
  printBackground: true,
  margin: { top: '18mm', right: '20mm', bottom: '18mm', left: '20mm' },
  preferCSSPageSize: false,
});

const pdfPath = resolve(outputDir, 'Interview-Story-Bank-Lamin-Traore.pdf');
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
  const lebenslaufPath = resolve(outputDir, 'Lebenslauf-Lamin-Traore.pdf');

  const attachments = [
    {
      filename: 'Interview-Story-Bank-Lamin-Traore.pdf',
      path: pdfPath,
      contentType: 'application/pdf',
    },
  ];

  // Also attach Lebenslauf if it exists
  if (existsSync(lebenslaufPath)) {
    attachments.push({
      filename: 'Lebenslauf-Lamin-Traore.pdf',
      path: lebenslaufPath,
      contentType: 'application/pdf',
    });
  }

  const transport = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: 'Lukas.T@withlukas.com', pass: 'qviq mipq qvjl ubpk' },
  });

  await transport.sendMail({
    from: '"Career-Ops" <Lukas.T@withlukas.com>',
    to: 'pt374t@gmail.com',
    subject: '📋 Interview-Vorbereitung + Lebenslauf — aktualisierte PDFs',
    html: `
    <div style="font-family: Georgia, serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="background: linear-gradient(135deg, #0d9488 0%, #065f46 100%); color: white; padding: 24px; border-radius: 8px 8px 0 0;">
        <h1 style="margin: 0; color: white; font-size: 20px;">Aktualisierte Unterlagen</h1>
        <p style="margin: 6px 0 0; color: #d1fae5; font-size: 13px;">Career-Ops &mdash; Interview-Vorbereitung + Lebenslauf</p>
      </div>
      <div style="padding: 24px; background: #fff; border: 1px solid #ddd;">
        <p>Hallo Lamin,</p>
        <p>Anbei findest du zwei aktualisierte PDFs:</p>

        <div style="background: #f0f7f7; border: 1.5px solid #0d7377; padding: 14px; border-radius: 6px; margin: 16px 0;">
          <strong style="color: #0d7377;">1. Interview Story Bank (STAR+R)</strong>
          <ul style="margin: 6px 0 0; font-size: 14px; color: #333;">
            <li>6 vorbereitete Interview-Geschichten im STAR+R-Format</li>
            <li>Deutsche &Uuml;bersetzungen f&uuml;r wichtige Antworten</li>
            <li>Aktualisiert: Board-certified, zertifizierte psychoanalytische Psychotherapeutin, Supervision an Grady</li>
            <li>&quot;Warum Deutschland?&quot;, Approbationsprozess, Klinische Philosophie</li>
          </ul>
        </div>

        <div style="background: #f0f7f7; border: 1.5px solid #0d7377; padding: 14px; border-radius: 6px; margin: 16px 0;">
          <strong style="color: #0d7377;">2. Lebenslauf (German CV)</strong>
          <ul style="margin: 6px 0 0; font-size: 14px; color: #333;">
            <li>A4-Format mit Bewerbungsfoto</li>
            <li>Aktualisiert: Board-certified, Erwachsenenpsychiatrie, Assistenzarzt-Supervision</li>
            <li>Psychoanalytische Psychotherapie 2020&ndash;2025 (zertifiziert)</li>
          </ul>
        </div>

        <p>Bitte pr&uuml;fe beide Dokumente und antworte mit &Auml;nderungsw&uuml;nschen.</p>
      </div>
      <div style="background: #f0f0f0; padding: 10px 20px; border-radius: 0 0 8px 8px; font-size: 12px; color: #999;">
        Career-Ops AI Job Search Engine
      </div>
    </div>`,
    attachments,
  });

  console.log('Email sent to pt374t@gmail.com with PDF attachments');
  transport.close();
} else {
  console.log('\nTo send via email: node generate-storybank-pdf.mjs --send');
}
