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

    const normalizedEmail = String(email).trim().toLowerCase();

    const userCheck = await db.query('SELECT id FROM users WHERE email = $1', [normalizedEmail]);
    if (userCheck.rows.length > 0) {
      return res.status(400).json({ error: 'User with this email already exists.' });
    }

    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(password, salt);

    const verification_token = crypto.randomBytes(32).toString('hex');

    const newUser = await db.query(
      `INSERT INTO users (name, email, password_hash, monthly_income, is_verified, verification_token, verification_expires_at)
       VALUES ($1, $2, $3, $4, FALSE, $5, NOW() + make_interval(hours => $6))
       RETURNING id, name, email`,
      [name || 'User', normalizedEmail, password_hash, parseFloat(monthly_income) || 0.0, verification_token, VERIFY_TOKEN_HOURS]
    );

    // Never fail registration because mail could not be delivered — the token
    // is stored regardless and can be re-issued / surfaced in server logs.
    try {
      await sendVerificationEmail({ to: normalizedEmail, token: verification_token });
    } catch (mailError) {
      console.error('Verification email send failed (token still stored):', mailError.message);
    }

    return res.status(201).json({
      message: 'User registered successfully. Please verify your email address before logging in.',
      requiresVerification: true,
      user: newUser.rows[0],
    });
  } catch (error) {
    console.error('Registration Error Details:', error);
    return res.status(500).json({ error: error.message || 'Registration failed.' });
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
      return res.status(403).json({ error: 'Please verify your email address before logging in.' });
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

    return res.json({ message: 'Email verified successfully. You can now log in.' });
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
