const nodemailer = require('C:/Users/Lukas/.openclaw/workspace/node_modules/nodemailer');
const path = require('path');

async function sendEmail() {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: 'lukas.t@withlukas.com',
      pass: 'qviq mipq qvjl ubpk'
    }
  });

  const outputDir = 'C:/Users/Lukas/career-ops/profiles/paulina/output';

  const info = await transporter.sendMail({
    from: 'lukas.t@withlukas.com',
    to: 'Paulinakaiser@gmail.com, pt374t@gmail.com',
    subject: 'Lebenslauf v2 - Dr. med. Paulina Kaiser (Updated)',
    html: `<p>Hi,</p>
<p>Attached is the updated Lebenslauf for Dr. med. Paulina Kaiser, rebuilt with the content from the latest version.</p>
<p>Changes from v1:</p>
<ul>
  <li>Content matched exactly to the updated docx (personal details, dates, job titles)</li>
  <li>Added Geburtsdatum, Geburtsort, Familienstand, and full address</li>
  <li>Streamlined to core sections: Beruflicher Werdegang, Ausbildung, Sprachkenntnisse</li>
  <li>DeKalb end date updated to 04/2026</li>
  <li>Signature line added at bottom</li>
  <li>Same professional design template as v1</li>
</ul>
<p>Best,<br>Lukas</p>`,
    attachments: [
      { filename: 'Lebenslauf-Dr-Paulina-Kaiser-v2.pdf', path: path.join(outputDir, 'Lebenslauf-Dr-Paulina-Kaiser-v2.pdf') },
    ]
  });

  console.log('Email sent! Message ID:', info.messageId);
}

sendEmail().catch(err => console.error('Error:', err.message));
