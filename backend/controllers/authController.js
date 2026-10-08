const crypto = require('crypto');
const db = require('../config/db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../config/env');
const { sendVerificationEmail } = require('../services/mailService');
const { transporter } = require('../utils/mailer');

const VERIFY_TOKEN_HOURS = 24;
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

    const verification_token = EMAIL_VERIFICATION_ENABLED ? crypto.randomBytes(32).toString('hex') : null;
    const verification_expires_at = EMAIL_VERIFICATION_ENABLED
      ? new Date(Date.now() + VERIFY_TOKEN_HOURS * 60 * 60 * 1000).toISOString()
      : null;

    const newUser = await db.query(
      `INSERT INTO users (name, email, password_hash, monthly_income, is_verified, verification_token, verification_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, name, email`,
      [
        name || 'User',
        normalizedEmail,
        password_hash,
        parseFloat(monthly_income) || 0.0,
        !EMAIL_VERIFICATION_ENABLED,
        verification_token,
        verification_expires_at,
      ]
    );

    if (EMAIL_VERIFICATION_ENABLED) {
      try {
        await sendVerificationEmail({ to: normalizedEmail, token: verification_token });
      } catch (mailError) {
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

        console.error(
          '[Register:mail] Verification email dispatch FAILED:',
          JSON.stringify({
            to: normalizedEmail,
            errorName: mailError && mailError.name,
            errorMessage: mailError && mailError.message,
          })
        );

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
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    if (EMAIL_VERIFICATION_ENABLED && !user.is_verified) {
      return res.status(403).json({
        error: 'Your email is not verified. Please check your inbox for the activation link.',
      });
    }
    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });

    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    return res.status(200).json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        monthly_income: user.monthly_income,
        is_verified: user.is_verified,
      },
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

const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body || {};
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const successMessage = 'If an account exists, a reset link has been sent.';

    if (!normalizedEmail) {
      return res.status(400).json({ success: false, error: 'Email is required.' });
    }

    console.log('[ForgotPassword] Request received for email:', normalizedEmail);
    const result = await db.query('SELECT id, email FROM users WHERE LOWER(email) = LOWER($1)', [normalizedEmail]);
    console.log('[ForgotPassword] User found:', result.rows.length > 0);

    if (result.rows.length > 0) {
      const userId = result.rows[0].id;
      const plainToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(plainToken).digest('hex');

      await db.query(
        `UPDATE users
         SET reset_password_token = $1,
             reset_password_expires = NOW() + INTERVAL '15 minutes'
         WHERE id = $2`,
        [tokenHash, userId]
      );

      try {
        const baseUrl = 'https://spensight.netlify.app';
        const resetUrl = `${baseUrl}/reset-password.html?token=${encodeURIComponent(plainToken)}`;
        const subject = 'SpenSight — Password Reset Request';
        const text = [
          'Hi,',
          '',
          'We received a request to reset your SpenSight password.',
          'Please use the link below to set a new password (valid for 15 minutes):',
          '',
          resetUrl,
          '',
          'If you did not request this, you can safely ignore this email.',
        ].join('\n');
        const html = `
        <div style="font-family: Arial, Helvetica, sans-serif; background:#0b1220; padding:24px; color:#e2e8f0;">
          <div style="max-width:480px; margin:0 auto; background:#111827; border:1px solid rgba(255,255,255,0.08); border-radius:14px; padding:28px;">
            <h1 style="margin:0 0 6px; font-size:20px; color:#ffffff;">SpenSight</h1>
            <p style="margin:0 0 18px; font-size:14px; color:#94a3b8;">Reset your password in just a few clicks.</p>
            <a href="${resetUrl}"
               style="display:inline-block; background:#3b82f6; color:#ffffff; text-decoration:none; font-weight:700; font-size:14px; padding:12px 22px; border-radius:10px;">
              Reset Password
            </a>
            <p style="margin:20px 0 0; font-size:13px; color:#94a3b8; word-break:break-all;">
              Or copy this link into your browser:<br/><a href="${resetUrl}" style="color:#60a5fa;">${resetUrl}</a>
            </p>
            <p style="margin:20px 0 0; font-size:12px; color:#64748b;">The link expires in 15 minutes. If you did not request this, you can safely ignore this email.</p>
          </div>
        </div>`;
        const info = await transporter.sendMail({
          from: `"SpenSight Support" <${process.env.EMAIL_USER}>`,
          to: normalizedEmail,
          subject,
          text,
          html,
        });
        console.log(
          `[ForgotPassword:mail] SUCCESS: Reset email sent to ${normalizedEmail} (MessageID: ${info.messageId})`
        );
        return res.status(200).json({
          success: true,
          message:
            'A password reset link has been sent to your email. Please check your inbox and spam folder.',
        });
      } catch (mailError) {
        console.error('[ForgotPassword:mail] FAILED to deliver to ' + normalizedEmail + ':', mailError);
        return res.status(500).json({
          success: false,
          error: 'Failed to deliver reset email. Please try again later.',
        });
      }
    }

    return res.status(200).json({ success: false, message: successMessage });
  } catch (error) {
    console.error('Forgot Password Error:', error);
    return res.status(500).json({ success: false, error: 'Something went wrong. Please try again later.' });
  }
};

const resetPassword = async (req, res) => {
  try {
    const { token, newPassword } = req.body || {};
    if (!token || !newPassword) {
      return res.status(400).json({ error: 'Token and newPassword are required.' });
    }

    if (String(newPassword).length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters.' });
    }

    const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');
    const result = await db.query(
      'SELECT id FROM users WHERE reset_password_token = $1 AND reset_password_expires > NOW()',
      [tokenHash]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Reset link is invalid or has expired.' });
    }

    const salt = await bcrypt.genSalt(12);
    const password_hash = await bcrypt.hash(String(newPassword), salt);

    await db.query(
      `UPDATE users
       SET password_hash = $1,
           reset_password_token = NULL,
           reset_password_expires = NULL
       WHERE id = $2`,
      [password_hash, result.rows[0].id]
    );

    return res.json({ success: true, message: 'Password has been reset successfully.' });
  } catch (error) {
    console.error('Reset Password Error:', error);
    return res.status(500).json({ error: 'Failed to reset password.' });
  }
};

module.exports = {
  register,
  login,
  verifyEmail,
  forgotPassword,
  resetPassword,
};
