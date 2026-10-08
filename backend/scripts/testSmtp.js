// Temporary standalone SMTP test: verifies IPv4 STARTTLS delivery via port 587.
// Run with: node backend/scripts/testSmtp.js
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const { transporter } = require('../utils/mailer');

async function main() {
  console.log('SMTP target configuration:');
  console.log('  host      : smtp.gmail.com');
  console.log('  port      : 587');
  console.log('  secure    : false (STARTTLS)');
  console.log('  family    : 4');
  console.log('  EMAIL_USER:', (process.env.EMAIL_USER || '').replace(/^(.{3}).*@/, '$1***@'));

  console.log('\nRunning transporter.verify() ...');
  const verified = await transporter.verify();
  console.log('VERIFY OK:', verified);

  console.log('\nSending test email ...');
  const info = await transporter.sendMail({
    from: `"SpenSight Test" <${process.env.EMAIL_USER}>`,
    to: process.env.EMAIL_USER,
    subject: 'SpenSight — SMTP Transport Verification',
    text: 'If you receive this, IPv4 SMTP delivery via port 587 is working properly.',
  });
  console.log('SUCCESS: Email sent! Message ID:', info.messageId);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('SMTP TEST FAILED');
    console.error('  error.code   :', error.code);
    console.error('  error.message:', error.message);
    console.error('  error.command:', error.command);
    console.error('  error.address:', error.address);
    if (error.stack) console.error(error.stack);
    process.exit(1);
  });
