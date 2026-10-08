const nodemailer = require('nodemailer');

if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
  console.warn(
    '[mailer] EMAIL_USER / EMAIL_PASS are not set — forgot-password emails cannot be sent until they are configured in backend/.env.'
  );
}

const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 587,
  secure: false, // Must be false for 587 (uses STARTTLS upgrade)
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
  tls: {
    rejectUnauthorized: false, // Prevents cloud container handshake aborts
  },
  connectionTimeout: 20000,
  greetingTimeout: 20000,
  socketTimeout: 20000,
});

module.exports = { transporter };
