const crypto = require('crypto');
const db = require('../config/db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../config/env');
const { sendVerificationEmail } = require('../services/mailService');

// Frontend page that shows the verification result is resolved by the mail
// service from effective settings (DB > env > default) at send time.
const VERIFY_TOKEN_HOURS = 24;

// Email verification is TEMPORARILY disabled. While EMAIL_VERIFICATION_ENABLED
// is not 'true', accounts are auto-verified on signup and no verification
// email is dispatched, so users can log in immediately.
//
// Re-enable when a production sender domain is configured: set
// `EMAIL_VERIFICATION_ENABLED=true` (backend/.env or Render env). The token
// generation, dispatch path (incl. the test-domain fallback), and the login
// gate below all re-activate automatically.
const EMAIL_VERIFICATION_ENABLED = process.env.EMAIL_VERIFICATION_ENABLED === 'true';

const register = async (req, res) => {
  try {
    const { name, email, password, monthly_income } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    if (String(password).length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }

    const normalizedEmail = String(email).trim().toLowerCase();

    const userCheck = await db.query('SELECT id FROM users WHERE email = $1', [normalizedEmail]);
    if (userCheck.rows.length > 0) {
      return res.status(400).json({ error: 'User with this email already exists.' });
    }

    const salt = await bcrypt.genSalt(12);
    const password_hash = await bcrypt.hash(password, salt);

    // Verification fields are only populated when verification is enabled;
    // otherwise the account is created pre-verified and active immediately.
    const verification_token = EMAIL_VERIFICATION_ENABLED ? crypto.randomBytes(32).toString('hex') : null;
    const verification_expires_at = EMAIL_VERIFICATION_ENABLED
      ? new Date(Date.now() + VERIFY_TOKEN_HOURS * 60 * 60 * 1000).toISOString()
      : null;

    const newUser = await db.query(
      `INSERT INTO users (name, email, password_hash, monthly_income, is_verified, verification_token, verification_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, name, email`,
      [name || 'User', normalizedEmail, password_hash, parseFloat(monthly_income) || 0.0, !EMAIL_VERIFICATION_ENABLED, verification_token, verification_expires_at]
    );

    // Verification email dispatch is bypassed while verification is disabled.
    // The send path is guarded (not removed) so it is restored automatically
    // by flipping EMAIL_VERIFICATION_ENABLED to true once a production sender
    // domain is configured.
    if (EMAIL_VERIFICATION_ENABLED) {
      try {
        await sendVerificationEmail({ to: normalizedEmail, token: verification_token });
      } catch (mailError) {
        // Test-mode fallback: the Resend free/test domain only delivers to the
        // account owner. Keep the account, print the verification link to the
        // server console so testing can proceed, and tell the user clearly
        // instead of leaking the raw API error or showing a fake "emailed you".
        if (mailError && mailError.isTestDomainRestriction) {
          const devLink = mailError.verificationUrl || 'unknown';
          console.log(`[DEV VERIFICATION LINK]: ${devLink}`);
          console.log('[Register:mail] Resend test-domain restriction hit; account kept for dev verification link.');

          return res.status(201).json({
            success: true,
            requiresVerification: true,
            testMode: true,
            message: 'Account created! (Test Mode: Check backend console for verification link, or use the account owner email).',
            user: newUser.rows[0],
          });
        }

        // Real delivery failure (revoked key, network error, etc.): log, roll
        // back the user so they can retry, and return a clear error.
        console.error('[Register:mail] Verification email dispatch FAILED:', JSON.stringify({
          to: normalizedEmail,
          errorName: mailError && mailError.name,
          errorMessage: mailError && mailError.message,
        }));

        const userId = newUser.rows[0] && newUser.rows[0].id;
        try {
          if (userId) {
            await db.query('DELETE FROM users WHERE id = $1 AND is_verified = FALSE', [userId]);
            console.log(`[Register:mail] Rolled back unverified user ${userId} (${normalizedEmail})`);
          }
        } catch (rollbackError) {
          console.error('[Register:mail] Rollback delete failed:', rollbackError.message);
        }

        return res.status(500).json({
          success: false,
          error: 'Failed to dispatch verification email. Please try again or contact support.',
          detail: (mailError && mailError.message) || undefined,
        });
      }
    }

    return res.status(201).json({
      success: true,
      message: 'Registration successful. You can now log in.',
      user: newUser.rows[0],
    });
  } catch (error) {
    console.error('Registration Error Details:', error);
    return res.status(500).json({ error: 'Registration failed.' });
  }
};

const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    const userResult = await db.query('SELECT * FROM users WHERE LOWER(email) = $1', [
      String(email || '').trim().toLowerCase(),
    ]);
    if (userResult.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid email or password.' });
    }

    const user = userResult.rows[0];
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(400).json({ error: 'Invalid email or password.' });
    }

    // Verification gate is temporarily bypassed — accounts are auto-verified
    // at signup. It re-activates automatically when EMAIL_VERIFICATION_ENABLED
    // is set to true, so all accounts need a verified email before login.
    if (EMAIL_VERIFICATION_ENABLED && !user.is_verified) {
      return res.status(403).json({ error: 'Your email is not verified. Please check your inbox for the activation link.' });
    }

    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '24h' });

    return res.json({
      token,
      user: { id: user.id, name: user.name, email: user.email },
    });
  } catch (error) {
    console.error('Login Error Details:', error);
    return res.status(500).json({ error: 'Login failed.' });
  }
};

const verifyEmail = async (req, res) => {
  try {
    const { token } = req.query;

    if (!token) {
      return res.status(400).json({ error: 'Verification token is required.' });
    }

    const result = await db.query(
      'SELECT id FROM users WHERE verification_token = $1 AND verification_expires_at > NOW()',
      [token]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired verification link.' });
    }

    await db.query(
      `UPDATE users
       SET is_verified = TRUE,
           verification_token = NULL,
           verification_expires_at = NULL,
           verified_at = NOW()
       WHERE id = $1`,
      [result.rows[0].id]
    );

    return res.json({ success: true, message: 'Email verified successfully!' });
  } catch (error) {
    console.error('Verify Email Error:', error);
    return res.status(500).json({ error: 'Failed to verify email.' });
  }
};

module.exports = {
  register,
  login,
  verifyEmail,
};
