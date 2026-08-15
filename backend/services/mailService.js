const nodemailer = require('nodemailer');
const mailSettingsService = require('./mailSettingsService');

// Outbound mail wrapper for email verification. When RESEND_API_KEY is set,
// sends via the Resend SDK (mailSettingsService.sendMail). Otherwise falls
// back to SMTP (credentials from the DB-backed admin mail settings merged
// over env defaults) and, when no SMTP is configured either, logs the
// verification link to the server console so local / preview flows stay
// testable without a real mail server.

let transporterCache = null;
function getTransporter(settings) {
  if (!transporterCache) {
    transporterCache = nodemailer.createTransport({
      host: settings.host,
      port: settings.port,
      secure: settings.port === 465,
      auth: { user: settings.user, pass: settings.pass },
    });
  }
  return transporterCache;
}

function resetTransporter() {
  transporterCache = null;
}

async function sendMail({ to, subject, text, html, fromOverride }) {
  const settings = await mailSettingsService.getEffectiveSettings();

  if (process.env.RESEND_API_KEY) {
    try {
      return await mailSettingsService.sendMail({ to, subject, html });
    } catch (error) {
      console.error('[Mail:error] Failed to send email:', error.message);
      throw error;
    }
  }

  if (!mailSettingsService.smtpConfigured(settings)) {
    console.log(`\n[Mail:dev-fallback] To: ${to}\n[Mail:dev-fallback] Subject: ${subject}\n[Mail:dev-fallback] Body:\n${text}\n`);
    return { dev: true };
  }

  try {
    const info = await getTransporter(settings).sendMail({
      from: fromOverride || settings.from,
      to,
      subject,
      text,
      html,
    });
    console.log(`[Mail:sent] ${info.messageId} -> ${to}`);
    return info;
  } catch (error) {
    console.error('[Mail:error] Failed to send email:', error.message);
    throw error;
  }
}

async function sendVerificationEmail({ to, token }) {
  const settings = await mailSettingsService.getEffectiveSettings();
  const appName = settings.appName || 'SpenSight';
  const verificationUrl = `${settings.verifyPageUrl}/verify.html?token=${encodeURIComponent(token)}`;

  const subject = `${appName} — Verify your email address`;
  console.log(`[Mail:verify] Attempting verification email for ${to} (subject: "${subject}", link: ${verificationUrl})`);
  const text = [
    `Welcome to ${appName}!`,
    '',
    'Please confirm your email address by opening the link below (valid for 24 hours):',
    '',
    verificationUrl,
    '',
    'If you did not create an account, you can safely ignore this email.',
  ].join('\n');
  const html = `
  <div style="font-family: Arial, Helvetica, sans-serif; background:#0b1220; padding:24px; color:#e2e8f0;">
    <div style="max-width:480px; margin:0 auto; background:#111827; border:1px solid rgba(255,255,255,0.08); border-radius:14px; padding:28px;">
      <h1 style="margin:0 0 6px; font-size:20px; color:#ffffff;">${appName}</h1>
      <p style="margin:0 0 18px; font-size:14px; color:#94a3b8;">Confirm your email to activate your account.</p>
      <a href="${verificationUrl}"
         style="display:inline-block; background:#3b82f6; color:#ffffff; text-decoration:none; font-weight:700; font-size:14px; padding:12px 22px; border-radius:10px;">
        Verify My Email
      </a>
      <p style="margin:20px 0 0; font-size:13px; color:#94a3b8; word-break:break-all;">
        Or copy this link into your browser:<br/><a href="${verificationUrl}" style="color:#60a5fa;">${verificationUrl}</a>
      </p>
      <p style="margin:20px 0 0; font-size:12px; color:#64748b;">The link expires in 24 hours. If you did not create an account, you can safely ignore this email.</p>
    </div>
  </div>`;

  // Reuse the plain-send path but build HTML from the effective settings.
  // Attach the URL to any thrown error so callers (register) can surface the
  // dev verification link even when real delivery is blocked (test domain).
  try {
    const result = await sendMail({ to, subject, text, html });
    if (result && result.dev) {
      console.log(`[DEV VERIFICATION LINK]: ${verificationUrl}`);
    }
    return { ...result, verificationUrl };
  } catch (error) {
    if (error && !error.verificationUrl) error.verificationUrl = verificationUrl;
    throw error;
  }
}

// Keep the exported name working for consumers: accepts { to, token } now
// (URL is derived from effective settings).
module.exports = {
  sendVerificationEmail,
  sendMail,
  smtpConfigured: (settings) => mailSettingsService.smtpConfigured(settings),
  resetTransporter,
};
