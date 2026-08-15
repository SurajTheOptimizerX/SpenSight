const mailSettingsService = require('../services/mailSettingsService');
const { sendMail } = require('../services/mailService');

const getMailSettings = async (req, res) => {
  try {
    const settings = await mailSettingsService.getEffectiveSettings();
    return res.json({ settings: mailSettingsService.toApiShape(settings) });
  } catch (error) {
    console.error('Get Mail Settings Error:', error);
    return res.status(500).json({ error: 'Failed to load mail settings.' });
  }
};

const updateMailSettings = async (req, res) => {
  try {
    const { host, port, user, password, from, appName, verifyPageUrl } = req.body || {};

    if (port !== undefined && port !== '' && !Number.isFinite(parseInt(port, 10))) {
      return res.status(400).json({ error: 'SMTP port must be a number.' });
    }

    const settings = await mailSettingsService.saveSettings({
      host,
      port,
      user,
      password,
      from,
      appName,
      verifyPageUrl,
    });

    return res.json({
      message: 'Mail settings saved.',
      settings: mailSettingsService.toApiShape(settings),
    });
  } catch (error) {
    console.error('Update Mail Settings Error:', error);
    return res.status(500).json({ error: 'Failed to save mail settings.' });
  }
};

const testMailSettings = async (req, res) => {
  try {
    const settings = await mailSettingsService.getEffectiveSettings();
    const to = String((req.body && req.body.to) || '').trim() || req.user.email;

    if (!to) {
      return res.status(400).json({ error: 'A recipient email address is required.' });
    }

    if (!mailSettingsService.smtpConfigured(settings)) {
      return res.status(400).json({
        error: 'SMTP is not configured. Provide an SMTP host and username (and password) and save first.',
      });
    }

    const result = await sendMail({
      to,
      subject: `Test email from ${settings.appName}`,
      text: 'This is a test email from SpenSight. Your SMTP configuration is working.',
      html: `<div style="font-family:Arial,sans-serif;background:#0b1220;padding:24px;color:#e2e8f0;">
        <div style="max-width:480px;margin:0 auto;background:#111827;border:1px solid rgba(255,255,255,0.08);border-radius:14px;padding:28px;">
          <h1 style="margin:0 0 6px;font-size:20px;color:#fff;">${settings.appName}</h1>
          <p style="margin:0;font-size:14px;color:#94a3b8;">This is a test email. Your SMTP configuration is working.</p>
        </div>
      </div>`,
      fromOverride: settings.from,
    });

    return res.json({
      message: result && result.dev ? 'Sent (dev console).' : 'Test email sent successfully.',
      dev: Boolean(result && result.dev),
    });
  } catch (error) {
    console.error('Test Mail Settings Error:', error);
    return res.status(500).json({
      error: `Test email failed: ${error.message || 'unknown SMTP error'}. Check host, port, credentials and mailbox settings.`,
    });
  }
};

module.exports = { getMailSettings, updateMailSettings, testMailSettings };
