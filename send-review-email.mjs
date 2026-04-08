#!/usr/bin/env node
// One-off: Send Lebenslauf + Story Bank summary to Paulina for review

import { readFile } from 'fs/promises';
import { createRequire } from 'module';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const nodemailer = require('C:/Users/Lukas/.openclaw/workspace/node_modules/nodemailer');

const transport = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: 'Lukas.T@withlukas.com', pass: 'qviq mipq qvjl ubpk' },
});

const cvDe = await readFile(resolve(__dirname, 'profiles/paulina/cv-de.md'), 'utf8');

function mdToHtml(md) {
  return md
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/\|[^\n]+/g, '')
    .replace(/\n\n/g, '<br><br>')
    .replace(/\n/g, '<br>');
}

const storyTopics = [
  'Crisis Leadership at Grady (Emergency Psychiatry)',
  'Building a Practice from Scratch (Entrepreneurship)',
  'Chief Resident — Psychotherapy Program (Teaching/Mentorship)',
  'Heidelberg Research Connection (Germany-Specific)',
  'Underserved Population Care (Community Health)',
  '200-Patient Chart Review (Research/Data)',
];

const storyListHtml = storyTopics.map(s => `<li>${s}</li>`).join('\n');

const html = `
<div style="font-family: Georgia, serif; max-width: 700px; margin: 0 auto; padding: 20px;">
<div style="background: linear-gradient(135deg, #0d9488 0%, #065f46 100%); color: white; padding: 24px; border-radius: 8px 8px 0 0;">
  <h1 style="margin: 0; color: white; font-size: 22px;">Zur Durchsicht: Lebenslauf + Interview-Vorbereitung</h1>
  <p style="margin: 8px 0 0; color: #d1fae5; font-size: 14px;">Career-Ops hat diese Dokumente f&uuml;r deine deutsche Stellensuche erstellt</p>
</div>
<div style="padding: 24px; background: #fff; border: 1px solid #ddd;">
<p>Hallo Paulina,</p>
<p>Zwei Dokumente sind fertig. Bitte pr&uuml;fe sie und gib Bescheid, wenn etwas ge&auml;ndert werden soll:</p>

<h2 style="color: #0d9488; border-bottom: 2px solid #0d9488; padding-bottom: 8px; margin-top: 32px;">1. Lebenslauf (German CV)</h2>
<div style="background: #f8f9fa; padding: 20px; border-radius: 8px; border: 1px solid #e0e0e0; margin: 16px 0; font-size: 14px;">
${mdToHtml(cvDe)}
</div>

<h2 style="color: #0d9488; border-bottom: 2px solid #0d9488; padding-bottom: 8px; margin-top: 32px;">2. Interview Story Bank (STAR+R)</h2>
<p>Ein separates Dokument mit 6 vorbereiteten Interview-Geschichten im STAR+R-Format:</p>
<ol style="line-height: 1.8;">
${storyListHtml}
</ol>
<p>Jede Geschichte enth&auml;lt deutsche &Uuml;bersetzungen f&uuml;r wichtige Antworten.</p>
<p><strong>Zus&auml;tzlich vorbereitet:</strong></p>
<ul>
<li>&quot;Warum Deutschland?&quot; — Antwort auf Deutsch und Englisch</li>
<li>&quot;Wie gehen Sie mit dem Approbationsprozess um?&quot;</li>
<li>&quot;Was ist Ihre klinische Philosophie?&quot;</li>
</ul>

<div style="background: #e8f5e9; border: 2px solid #2e7d32; padding: 16px; border-radius: 6px; margin: 24px 0;">
<strong style="color: #2e7d32;">N&auml;chste Schritte:</strong>
<ul style="margin: 8px 0 0;">
<li>Lebenslauf pr&uuml;fen — fehlen Angaben? Geburtsdatum erg&auml;nzen?</li>
<li>Soll ein professionelles Foto hinzugef&uuml;gt werden? (in DE &uuml;blich)</li>
<li>Interview-Geschichten anpassen? Andere Beispiele gew&uuml;nscht?</li>
</ul>
</div>

<p style="margin-top: 30px; color: #666;">Antworte einfach auf diese E-Mail mit &Auml;nderungsw&uuml;nschen.</p>
</div>
<div style="background: #f0f0f0; padding: 10px 20px; border-radius: 0 0 8px 8px; font-size: 12px; color: #999;">
Career-Ops AI Job Search Engine &bull; Automatisch erstellt
</div>
</div>
`;

await transport.sendMail({
  from: '"Career-Ops" <Lukas.T@withlukas.com>',
  to: 'paulinakaiser@gmail.com',
  subject: '📄 Zur Durchsicht: Lebenslauf + Interview-Vorbereitung — Career-Ops',
  html,
});

console.log('Sent to paulinakaiser@gmail.com');
transport.close();
