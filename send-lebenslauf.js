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
    subject: 'Lebenslauf & CV - Dr. med. Paulina Kaiser',
    html: `<p>Hi,</p>
<p>Attached are the career documents for Dr. med. Paulina Kaiser:</p>
<ul>
  <li><strong>Lebenslauf-Dr-Paulina-Kaiser.pdf</strong> &mdash; German Lebenslauf (3 pages)</li>
  <li><strong>cv-paulina.pdf</strong> &mdash; English CV</li>
</ul>
<p>Best,<br>Lukas</p>`,
    attachments: [
      { filename: 'Lebenslauf-Dr-Paulina-Kaiser.pdf', path: path.join(outputDir, 'Lebenslauf-Dr-Paulina-Kaiser.pdf') },
      { filename: 'cv-paulina.pdf', path: path.join(outputDir, 'cv-paulina.pdf') },
    ]
  });

  console.log('Email sent! Message ID:', info.messageId);
}

sendEmail().catch(err => console.error('Error:', err.message));
