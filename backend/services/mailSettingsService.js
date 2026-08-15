const crypto = require('crypto');
const { Resend } = require('resend');
const db = require('../config/db');
const { JWT_SECRET } = require('../config/env');

// Mail settings stored in the DB (admin page) merged over environment
// defaults. The SMTP password is stored AES-256-GCM encrypted with a key
// derived from JWT_SECRET and is never returned by the API.

// Resend SDK transport — initialized lazily so the module loads even when
// RESEND_API_KEY is absent (the SDK throws if constructed with no key).
let resend = null;
function getResend() {
  if (!resend) {
    resend = new Resend(process.env.RESEND_API_KEY);
  }
  return resend;
}

const KEY = crypto.createHash('sha256').update(String(JWT_SECRET)).digest();

const ENV_DEFAULTS = {
  host: process.env.SMTP_HOST || '',
  port: parseInt(process.env.SMTP_PORT || '587', 10),
  user: process.env.SMTP_USER || '',
  pass: process.env.SMTP_PASS || '',
  from: process.env.MAIL_FROM || 'SpenSight <onboarding@resend.dev>',
  appName: process.env.APP_NAME || 'SpenSight',
  verifyPageUrl: (process.env.VERIFY_PAGE_URL || 'https://spensight.netlify.app').replace(/\/+$/, ''),
};

const DEFAULT_PORT = parseInt(process.env.SMTP_PORT || '587', 10);

function encryptPassword(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), enc.toString('base64'), tag.toString('base64')].join('.');
}

function decryptPassword(stored) {
  if (!stored) return '';
  try {
    const [ivB, dataB, tagB] = stored.split('.');
    if (!ivB || !dataB || !tagB) return '';
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivB, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB, 'base64')), decipher.final()]).toString('utf8');
  } catch (error) {
    console.error('[MailSettings] Could not decrypt stored SMTP password (JWT_SECRET changed?).', error.message);
    return '';
  }
}

function clean(value, fallback = '') {
  const v = String(value === undefined || value === null ? '' : value).trim();
  return v || fallback;
}

// In-memory cache so the (rare) settings read doesn't hit the DB on every send.
let cache = null;
const CACHE_TTL_MS = 5000;

async function getRow() {
  const result = await db.query('SELECT * FROM mail_settings WHERE id = 1');
  return result.rows[0] || null;
}

// Effective settings: env defaults overridden by non-empty DB values.
async function getEffectiveSettings() {
  if (cache && Date.now() - cache.ts < CACHE_TTL_MS) return cache.settings;

  const row = await getRow();
  const settings = {
    host: clean(row && row.smtp_host, ENV_DEFAULTS.host),
    port: row && row.smtp_port ? parseInt(row.smtp_port, 10) : ENV_DEFAULTS.port,
    user: clean(row && row.smtp_user, ENV_DEFAULTS.user),
    pass: row ? decryptPassword(row.smtp_pass_encrypted) || ENV_DEFAULTS.pass : ENV_DEFAULTS.pass,
    from: clean(row && row.mail_from, ENV_DEFAULTS.from),
    appName: clean(row && row.app_name, ENV_DEFAULTS.appName),
    verifyPageUrl: clean(row && row.verify_page_url, ENV_DEFAULTS.verifyPageUrl).replace(/\/+$/, ''),
    source: {
      host: row && row.smtp_host ? 'db' : 'env',
      user: row && row.smtp_user ? 'db' : 'env',
      from: row && row.mail_from ? 'db' : 'env',
      appName: row && row.app_name ? 'db' : 'env',
      verifyPageUrl: row && row.verify_page_url ? 'db' : 'env',
    },
  };

  if (!Number.isFinite(settings.port)) settings.port = DEFAULT_PORT;
  cache = { settings, ts: Date.now() };
  return settings;
}

function invalidateCache() {
  cache = null;
}

function smtpConfigured(settings) {
  const s = settings || ENV_DEFAULTS;
  return Boolean(s.host && s.user);
}

// Persist DB-backed values. Only fields present in the payload are updated
// (undefined = keep current); an explicit empty string clears a field.
// A blank password always keeps the currently stored one.
async function saveSettings(fields = {}) {
  const row = await getRow();
  const has = (value) => value !== undefined && value !== null;
  const keepValue = (rowValue, fallback = '') => {
    const v = rowValue === undefined || rowValue === null ? '' : String(rowValue).trim();
    return v || fallback;
  };

  let nextEncrypted = (row && row.smtp_pass_encrypted) || '';
  if (has(fields.password) && String(fields.password).trim() !== '') {
    nextEncrypted = encryptPassword(fields.password);
  }

  await db.query(
    `UPDATE mail_settings
     SET smtp_host = $1, smtp_port = $2, smtp_user = $3, smtp_pass_encrypted = $4,
         mail_from = $5, app_name = $6, verify_page_url = $7, updated_at = NOW()
     WHERE id = 1`,
    [
      has(fields.host) ? clean(fields.host) : keepValue(row && row.smtp_host),
      has(fields.port) ? parseInt(fields.port, 10) || DEFAULT_PORT : (row && row.smtp_port) || DEFAULT_PORT,
      has(fields.user) ? clean(fields.user) : keepValue(row && row.smtp_user),
      nextEncrypted,
      has(fields.from) ? clean(fields.from) : keepValue(row && row.mail_from),
      has(fields.appName) ? clean(fields.appName) : keepValue(row && row.app_name),
      has(fields.verifyPageUrl) ? clean(fields.verifyPageUrl) : keepValue(row && row.verify_page_url),
    ]
  );

  invalidateCache();
  return getEffectiveSettings();
}

// API-facing shape — never includes the password.
function toApiShape(settings) {
  return {
    host: settings.host,
    port: settings.port,
    user: settings.user,
    from: settings.from,
    appName: settings.appName,
    verifyPageUrl: settings.verifyPageUrl,
    hasPassword: Boolean(settings.pass),
    configured: smtpConfigured(settings),
    source: settings.source,
  };
}

// Resend SDK email dispatch. Throws on API/network failure so callers can
// decide how to surface it; returns `{ success: true, data }` on dispatch.
async function sendMail({ to, subject, html }) {
  const settings = await getEffectiveSettings();
  const sender = settings.from || 'SpenSight <onboarding@resend.dev>';
  const recipients = Array.isArray(to) ? to : [to];

  console.log(`[Mail:resend] Dispatching "${subject}" -> ${recipients.join(', ')} from "${sender}"`);

  let result;
  try {
    result = await getResend().emails.send({ from: sender, to: recipients, subject, html });
  } catch (err) {
    // SDK/transport-level throw (bad API key, network failure, ...).
    console.error('[Mail:resend] Throw while dispatching:', JSON.stringify({
      to: recipients,
      subject,
      from: sender,
      errorName: err && err.name,
      errorMessage: err && err.message,
      statusCode: err && err.statusCode,
    }));
    throw new Error((err && err.message) || 'Resend send failed.');
  }

  const { data, error } = result;
  if (error) {
    // Resend returns a structured error (e.g. a 403 validation_error for the
    // test-domain restriction). Log the full object so delivery failures are
    // diagnosable from the server logs.
    console.error('[Mail:resend] Dispatch rejected by Resend:', JSON.stringify({
      to: recipients,
      subject,
      from: sender,
      errorName: error && error.name,
      errorMessage: error && error.message,
      statusCode: error && error.statusCode,
      details: error && error.details,
    }));

    const err = new Error(error.message || 'Resend send failed.');
    if (error.statusCode) err.statusCode = error.statusCode;
    // Free/test domains only deliver to the account owner. Tag this specific
    // case so the registration flow can fall back to the dev-link path
    // instead of failing or leaking raw API messages to the user.
    err.isTestDomainRestriction =
      error.statusCode === 403 &&
      /testing emails to your own email|verify a domain|test recipients?/i.test(String(error.message || ''));
    throw err;
  }

  console.log(`[Mail:resend] ${data && data.id ? data.id : 'sent'} -> ${recipients.join(', ')}`);
  return { success: true, data };
}

module.exports = {
  getEffectiveSettings,
  saveSettings,
  smtpConfigured,
  toApiShape,
  invalidateCache,
  sendMail,
};