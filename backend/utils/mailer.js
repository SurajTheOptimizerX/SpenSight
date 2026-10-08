const nodemailer = require('nodemailer');
const dns = require('dns');

if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
  console.warn(
    '[mailer] EMAIL_USER / EMAIL_PASS are not set — forgot-password emails cannot be sent until they are configured in backend/.env.'
  );
}

const SMTP_HOST = 'smtp.gmail.com';

const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: 587,
  secure: false, // Must be false for 587 (uses STARTTLS upgrade)
  family: 4, // FORCE IPv4 ONLY (resolves ENETUNREACH on Render)
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

// Nodemailer 9 resolves A + AAAA records and picks one at random, so on hosts
// without an outbound IPv6 route (e.g. Render) it can hit ENETUNREACH before
// falling back. Its `family` option is not read by the SMTP connection layer,
// so we seed its DNS cache with IPv4-only addresses to guarantee an A record
// is used for every connection.
const SMTP_DNS_CACHE_TTL = 5 * 60 * 1000;
const SMTP_DNS_REFRESH = 4 * 60 * 1000;

function refreshIPv4Cache() {
  dns.resolve4(SMTP_HOST, (err, addresses) => {
    if (err || !addresses || !addresses.length) {
      console.error('[mailer] IPv4 lookup failed for ' + SMTP_HOST + ':', err && err.message);
      return;
    }
    try {
      const shared = require('nodemailer/lib/shared');
      shared.dnsCache.set(SMTP_HOST, {
        value: { addresses, servername: SMTP_HOST },
        expires: Date.now() + SMTP_DNS_CACHE_TTL,
      });
    } catch (cacheErr) {
      console.error('[mailer] Could not seed IPv4 DNS cache:', cacheErr && cacheErr.message);
    }
  });
}

refreshIPv4Cache();
const refreshTimer = setInterval(refreshIPv4Cache, SMTP_DNS_REFRESH);
if (refreshTimer.unref) refreshTimer.unref();

module.exports = { transporter };
