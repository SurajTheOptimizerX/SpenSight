const crypto = require('crypto');
const db = require('../config/db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../config/env');
const { sendVerificationEmail } = require('../services/mailService');

// Frontend page that shows the verification result is resolved by the mail
// service from effective settings (DB > env > default) at send time.
const VERIFY_TOKEN_HOURS = 24;

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

    const verification_token = crypto.randomBytes(32).toString('hex');

    const newUser = await db.query(
      `INSERT INTO users (name, email, password_hash, monthly_income, is_verified, verification_token, verification_expires_at)
       VALUES ($1, $2, $3, $4, FALSE, $5, NOW() + make_interval(hours => $6))
       RETURNING id, name, email`,
      [name || 'User', normalizedEmail, password_hash, parseFloat(monthly_income) || 0.0, verification_token, VERIFY_TOKEN_HOURS]
    );

    // Dispatch the verification email BEFORE confirming success. If delivery
    // fails (Resend test-domain restriction for non-owner addresses, revoked
    // API key, network error, ...), roll the user back so they can retry, and
    // return a clear error instead of a misleading "check your inbox" success.
    try {
      await sendVerificationEmail({ to: normalizedEmail, token: verification_token });
    } catch (mailError) {
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

    return res.status(201).json({
      message: 'User registered successfully. Please verify your email address before logging in.',
      requiresVerification: true,
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

    if (!user.is_verified) {
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
